# SQLite Query Backend Design

## Goal

Move debarment lookup away from long-lived in-memory JSONL indexes and into a local SQLite database. The bot should keep its existing Telegram behavior while reducing startup memory pressure, improving search performance on million-scale data, and preserving safe data refresh semantics.

The target server is a 2C4G single-host deployment. The database choice is SQLite with a native Node binding, preferably `better-sqlite3`.

## Existing Context

The bot currently reads two large local JSONL files:

- `senzing.json` builds `SenzingMemoryRepository`, including exact name lookup and fuzzy candidate search.
- `targets.nested.json` builds `TargetsNestedMemoryRepository`, including sanctions details by OpenSanctions record id.

`DebarmentService` already depends on repository interfaces:

- `SenzingLookupRepository`
- `TargetDetailsRepository`

This gives the migration a narrow boundary. Bot handlers, access control, formatters, and most service behavior can remain unchanged while new SQLite-backed repositories replace the memory implementations.

The current refresh flow downloads new JSONL resources, validates them, builds replacement repositories, publishes local files, and swaps `ActiveDebarmentRepositories`. The SQLite design must preserve the same safety property: a failed refresh must not affect active queries.

## Chosen Approach

Use a local SQLite file as the primary query store:

- Exact lookup uses normal SQLite indexes over normalized names.
- Full details use `record_id` lookups.
- Candidate search uses SQLite FTS5 for fast candidate recall, then application code performs final scoring.
- Spelling tolerance is implemented in application scoring over the recalled candidate set, not as a full-database edit-distance scan.
- User-visible results are deduplicated by `record_id`.

Support two build paths:

- Offline build command for deployment workflows.
- Runtime build during `/update`, producing a new SQLite file and atomically switching active repositories only after validation passes.

If no database and no JSONL files exist at startup, the service should bootstrap itself with empty data, start normally, and trigger an automatic update after launch.

## Rejected Alternatives

Postgres with `pg_trgm` or full text search was rejected for the first implementation because it adds an external service and operational overhead that is not needed for a single-host 2C4G Telegram bot.

Redis or another memory database was rejected because it moves the existing memory pressure into a separate process and does not solve the core 2C4G constraint.

SQLite `:memory:` was rejected because it requires importing all data on every restart, loses data on process exit, and complicates safe refresh rollback.

A custom trigram table inside SQLite was deferred. It can improve typo recall, but it increases database size and import complexity. The first implementation should use FTS5 recall plus application scoring and leave room to add trigram recall later if search quality is insufficient.

## Database Schema

The SQLite database should include a schema metadata table so startup can validate compatibility:

```sql
schema_metadata(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
```

Core records:

```sql
records(
  record_id TEXT PRIMARY KEY,
  record_json TEXT NOT NULL,
  is_debarment INTEGER NOT NULL
)
```

Searchable names:

```sql
names(
  id INTEGER PRIMARY KEY,
  record_id TEXT NOT NULL,
  name_full TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  name_type TEXT,
  normalized_tokens_json TEXT NOT NULL
)
```

Sanctions details:

```sql
target_sanctions(
  record_id TEXT PRIMARY KEY,
  sanctions_json TEXT NOT NULL
)
```

Recommended indexes:

```sql
CREATE INDEX idx_names_normalized_name ON names(normalized_name);
CREATE INDEX idx_names_record_id ON names(record_id);
CREATE INDEX idx_records_debarment ON records(is_debarment);
```

FTS5 candidate recall:

```sql
CREATE VIRTUAL TABLE name_fts USING fts5(
  normalized_name,
  name_full,
  record_id UNINDEXED,
  name_id UNINDEXED
);
```

Storage choices:

- Store complete Senzing records as `record_json` to avoid changing response shape.
- Store converted `SanctionDetail[]` as `sanctions_json` to avoid parsing `targets.nested.json` at query time.
- Store every non-empty `NAMES[].NAME_FULL` in `names`, regardless of `NAME_TYPE`.
- Store normalized tokens for stable scoring without depending on FTS tokenizer internals.
- Compute `is_debarment` during import from `RISKS[].TOPIC`.

## Startup Bootstrap

Startup should prefer service availability over requiring a prebuilt database:

1. If `SQLITE_PATH` exists and schema metadata is compatible, open it and start with SQLite repositories.
2. If the database does not exist but `SENZING_PATH` and `TARGETS_NESTED_PATH` exist, build SQLite from those files before starting the bot.
3. If the database and JSONL files are all missing:
   - Create empty `senzing.json` and `targets.nested.json` JSONL files.
   - Create an empty SQLite database with the full schema and current schema version.
   - Start the bot with empty repositories.
   - Trigger an automatic update after launch using the same refresh path as `/update`.
4. If schema metadata is incompatible:
   - Rebuild from JSONL when JSONL is available.
   - Otherwise rebuild an empty database and trigger automatic update.

During bootstrap with empty data, query commands should not present empty data as a confident real miss. User-facing text should indicate that local data is empty or updating. Administrators should be able to retry with `/update`.

## Offline Build

Add a build command that reads existing JSONL files and writes a SQLite database:

```text
SENZING_PATH=./senzing.json
TARGETS_NESTED_PATH=./targets.nested.json
SQLITE_PATH=./sanction.sqlite
```

Expected command shape:

```bash
npm run db:build
```

The command should:

- Build into a temporary SQLite file.
- Validate schema, indexes, row counts, exact lookup, candidate lookup, and details lookup.
- Publish to `SQLITE_PATH` only after validation succeeds.
- Leave any existing database untouched if build fails.

## Refresh Flow

`/update` should reuse the same builder as offline builds:

1. Fetch OpenSanctions metadata.
2. Compare checksums with `refresh-metadata.json`.
3. Download changed JSONL resources into a temporary directory.
4. Validate downloaded resource sizes and checksums.
5. Build a new SQLite file from staged JSONL files.
6. Validate the new database.
7. Publish JSONL files, metadata, and SQLite file.
8. Open new SQLite repositories.
9. Replace `ActiveDebarmentRepositories`.
10. Close old SQLite handles at a safe point.

Failure behavior:

- A download, validation, build, publish, or open failure returns refresh `failed`.
- Old SQLite repositories continue serving queries.
- In first-run bootstrap mode, the empty database remains active and the administrator can retry `/update`.
- Temporary files are cleaned up on failure where possible.

The implementation should avoid writing into the active SQLite file. Building a new file and switching handles is safer than updating rows in place.

## Query Behavior

### Exact Lookup

`/check`, `/basic`, and exact-name `/full` should:

1. Normalize the input with the existing `normalizeName()`.
2. Query `names.normalized_name = ?`.
3. Load matching `records`.
4. Filter to `is_debarment = 1`.
5. Deduplicate by `record_id`.
6. Return at most `maxResults`.

`totalMatches` must count deduplicated target records, not raw name rows.

### Full Details

`/full` and `fullByRecordId` should read `target_sanctions.sanctions_json` by `record_id`.

Missing sanctions details should return an empty sanctions array, preserving current behavior.

### Candidate Search

`/search` and plain-text candidate search should:

1. Normalize the input.
2. Build a safe FTS5 query from normalized tokens.
3. Recall a bounded candidate set, such as 300 to 1000 name rows.
4. Load associated records and filter `is_debarment = 1`.
5. Score candidates in application code.
6. Deduplicate by `record_id`, keeping the best candidate per target.
7. Sort by score descending, then stable tie breakers.
8. Return at most `maxCandidateResults`.

`totalCandidates` must count deduplicated target records.

## Deduplication Contract

All user-visible query results are target-level results, not name-level rows.

If multiple primary names, aliases, or nicknames point to the same `record_id`, only one result should be returned for that target. The returned `matchedName` and `matchedNameType` should describe the best matching name for that target.

Best-match selection should be deterministic:

- Higher score wins for candidate search.
- Exact normalized match wins over weaker match reasons.
- A primary name can be preferred for display when scores are otherwise equal.
- `matchedName` and `record_id` provide final stable tie breakers.

This applies to both `matches` and `candidates`.

## Spelling Tolerance

Spelling tolerance should be limited and predictable:

- FTS5 performs fast recall only.
- Application scoring adds typo tolerance for Latin alphabet tokens.
- Long Latin tokens may allow one or two edit-distance differences.
- Short tokens do not receive edit-distance tolerance.
- Numeric tokens, mixed identifier tokens, document numbers, and IDs do not receive edit-distance tolerance.
- Final score thresholds decide whether a typo candidate is shown.

Examples:

- `Yatai Smrat` can recall and rank `YATAI SMART`.
- Identifier-like input should not match unrelated identifiers because of fuzzy edit distance.

This preserves performance on 2C4G and avoids turning exact debarment commands into fuzzy verdicts.

## Runtime Repository Lifecycle

SQLite repositories should own their database handles and expose a close mechanism internally.

The active repository swap should open the new database before replacing active repositories. Old handles should be closed only after they are no longer needed by in-flight queries. Since the bot handles short synchronous queries in Node, a simple delayed close or safe repository manager is acceptable.

Read repositories should open the active database read-only when practical. Build code writes only to temporary database files.

## User-Facing Empty Data State

When the active database contains zero records because the service is bootstrapping, lookup responses should distinguish this from a real negative match.

Suggested behavior:

- Exact lookup: say local data is not loaded yet or is being updated.
- Candidate search: say candidate search is unavailable until data refresh completes.
- `/update`: remains available to administrators.

This prevents a first-run empty database from being mistaken for real OpenSanctions data.

## Error Handling

- Missing DB and missing JSONL enter bootstrap mode, not startup failure.
- Missing DB with JSONL present triggers an automatic build before normal service start.
- Incompatible schema triggers rebuild when possible; otherwise empty bootstrap plus automatic update.
- FTS query syntax errors are handled by safe query construction and fallback to no candidates.
- SQLite busy or locked errors should be rare because active DB reads and temp DB builds are separate.
- Refresh failures preserve the old active repository.
- Old handle close failures are logged as warnings and do not block new queries.

## Testing Plan

Repository tests:

- Exact primary-name lookup returns a debarment record.
- Exact alias lookup returns the same record.
- Non-debarment exact matches are filtered.
- Multiple names for one `record_id` return one user-visible result.
- `totalMatches` uses deduplicated target count.
- `fullByRecordId` returns sanctions details from SQLite.
- Missing sanctions details return an empty array.

Search tests:

- Existing candidate cases such as `Yatai Smart` and `Myanmar Yatai` still work.
- Typo input such as `Yatai Smrat` can return `YATAI SMART`.
- Identifier-like input does not get edit-distance false positives.
- Multiple matched names for the same `record_id` produce one candidate.
- `totalCandidates` uses deduplicated target count.
- Candidate order is deterministic.

Builder tests:

- Fixture JSONL files build a valid SQLite database.
- Schema metadata is written.
- Normal indexes and FTS table exist.
- Empty JSONL files build a valid empty database.
- Build failure leaves existing target DB untouched.

Startup tests:

- Existing compatible DB starts with SQLite repositories.
- Missing DB with JSONL builds SQLite.
- Missing DB and missing JSONL creates empty JSONL, empty SQLite, starts service, and schedules update.
- Incompatible schema rebuilds when JSONL exists.

Refresh tests:

- Changed remote resources build a new SQLite file and swap active repositories.
- Build failure leaves active data unchanged.
- Queries continue against old data while refresh is building.
- First-run empty database can be replaced by downloaded data.

Integration verification:

- `npm run typecheck`
- `npm test`
- `npm run build`

## Out of Scope

Do not add:

- Postgres, Redis, or external database services.
- Full custom trigram search in the first implementation.
- Fuzzy debarment verdicts for `/check`, `/basic`, or `/full`.
- New Telegram commands beyond a database build script and existing `/update`.
- Changes to access control or administrator approval behavior.
