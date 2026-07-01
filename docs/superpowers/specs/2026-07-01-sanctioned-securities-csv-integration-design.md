# Sanctioned Securities CSV Integration Design

## Goal

Extend the Telegram bot so every existing query path returns both Debarred and Sanctioned Securities results. If a company appears in both sources, show one merged company-level result with both statuses.

This is the low-risk implementation path: use the official OpenSanctions `securities.csv` export as a company-level Sanctioned Securities source. Do not attempt to rebuild the full securities entity graph in this implementation.

## Source Evidence

- `https://data.opensanctions.org/datasets/latest/securities/index.json` currently exposes only one public resource for the `securities` collection: `securities.csv`.
- The securities dataset page describes this as a specialised export of sanctioned organizations and their securities identifiers.
- The CSV header is:
  `caption, lei, perm_id, isins, ric, countries, sanctioned, eo_14071, public, id, url, datasets, risk_datasets, aliases, referents`
- The dataset statistics are larger than the CSV's company-level shape: the collection includes hundreds of thousands of entities and many `Security` objects, but the public collection artifact does not expose `entities.ftm.json` or `targets.nested.json`.
- Common full-graph artifact paths under the securities artifact directory, such as `entities.ftm.json`, `targets.nested.json`, and `statements.csv`, returned 404 during design research.

## Current Context

The project already uses SQLite as the runtime query path:

- `senzing.json` supplies debarment records, names, aliases, risks, and basic info.
- `targets.nested.json` supplies nested sanctions details by OpenSanctions record id.
- `sqliteBuilder` builds the SQLite database.
- `SqliteSenzingRepository` and `SqliteTargetDetailsRepository` serve exact, fuzzy, and full-detail queries.
- `DebarmentService` and Telegram formatters currently assume a Debarred-only result.

The existing exact and fuzzy semantics should remain:

- `/check`, `/basic`, and `/full` are exact-name or exact-alias lookups.
- `/search` and plain text are fuzzy candidate searches and must not become verdicts.
- User-visible results are deduplicated at the target/company level.

## Chosen Approach

Use build-time merge and query-time read-only access:

1. Add `SECURITIES_PATH`, defaulting to `./securities.csv`.
2. Extend refresh metadata handling to fetch and validate both:
   - debarment resources: `senzing.json`, `targets.nested.json`
   - securities resource: `securities.csv`
3. Upgrade SQLite schema to store company-level merged screening records.
4. Import debarment records and securities CSV rows into one merged company index.
5. Keep existing Telegram commands and expand their result text to show the status set:
   - `Debarred`
   - `Sanctioned Securities`
   - `Debarred + Sanctioned Securities`

This keeps the operational profile close to the current bot and avoids downloading multi-GB bulk files.

## Data Model

Introduce a company-level screening result concept while keeping names searchable:

- `screening_records`
  - `record_id` as the canonical company id, usually the OpenSanctions id
  - `primary_name`
  - `statuses_json`, containing values such as `debarred` and `sanctioned_securities`
  - `basic_json`, containing merged display fields
  - `debarment_record_json`, nullable
  - `securities_json`, nullable
- `names`
  - continue to store searchable names and aliases
  - include both debarment `NAMES[].NAME_FULL` and securities `caption` / `aliases`
- `target_sanctions`
  - continue to store debarment nested sanctions by record id
- `securities_details`
  - store the parsed securities CSV row by company id

The exact schema can be shaped during implementation, but query repositories should return one company-level result per canonical company id.

## Merge Rules

Use conservative merging:

1. Same OpenSanctions `id` or `RECORD_ID`: must merge.
2. Same strong company identifier: may merge when unique.
   - LEI
   - PermID
3. Normalized name plus overlapping country: may merge only when it resolves to exactly one existing company.
4. ISIN is not a company merge key by itself. Store it as a securities identifier and optional search/display field because one company can issue multiple securities.
5. If confidence is ambiguous, do not merge. Return separate company-level results.

The design prefers false non-merges over false merges.

## Data Flow

### Build

1. Stream `senzing.json` JSONL.
2. Insert debarment records and names.
3. Stream `targets.nested.json` JSONL.
4. Insert debarment sanctions details.
5. Stream `securities.csv` using the header row, not column position assumptions.
6. For each CSV row:
   - parse semicolon-separated multi-value fields
   - parse booleans `t` / `f`
   - determine canonical company id through merge rules
   - attach `sanctioned_securities` status when `sanctioned=t` or `eo_14071=t`
   - index `caption` and `aliases`
   - store LEI, PermID, ISINs, RIC, datasets, risk_datasets, referents, URL, and countries

### Query

All existing query commands query the merged company repository:

- exact lookup: normalized full name or alias equals input
- fuzzy lookup: FTS candidate recall across merged names, then existing application scoring
- record-id lookup: canonical company id resolves to the merged company

`/full` returns both:

- debarment sanctions details from `targets.nested.json`, when present
- securities details from `securities.csv`, when present

## Large File Constraints

This project must not inspect source data by reading full production JSONL or CSV files into memory.

Allowed:

- metadata requests
- HTTP HEAD requests
- byte-range or first-line/header sampling
- `Get-Content -TotalCount` for local samples
- streaming JSONL and CSV parsers
- small fixtures in tests

Disallowed:

- opening full production `senzing.json`, `targets.nested.json`, or securities bulk files for manual inspection
- loading full production files into arrays or strings
- depending on CSV column order instead of headers

## Error Handling

- If `securities.csv` is missing while existing SQLite data is populated, startup can continue with the existing SQLite database.
- If SQLite must be rebuilt and required source files are incomplete, fail rebuild and preserve the old active database.
- If first-run bootstrap has no local files, create empty placeholders for all required local sources and start with empty data, then trigger refresh.
- If securities metadata or download fails during refresh, return `failed` and keep the old active repositories.
- If debarment is current but securities changed, rebuild the SQLite database with all staged current resources.
- Refresh metadata should track checksums for all required resources, not just debarment files.

## User-Facing Output

`/check` should start with a status line:

- `Debarred`
- `Sanctioned Securities`
- `Debarred + Sanctioned Securities`

`/basic` should include:

- record id
- name and matched name
- status list
- aliases
- topics/risks
- countries
- addresses where available
- identifiers including LEI, PermID, ISINs, RIC, and debarment identifiers
- OpenSanctions URL

`/full` should include:

- the basic section
- debarment sanctions details, if any
- securities details, including sanction/investment-ban flags, source datasets, risk datasets, referents, and securities identifiers

Fuzzy search should remain candidate-only and explicitly avoid presenting a verdict.

## Testing Plan

Add or update tests for:

- SQLite builder imports securities CSV fixtures.
- Debarred-only company returns `Debarred`.
- Securities-only company returns `Sanctioned Securities`.
- Same OpenSanctions id in debarment and securities merges into one result.
- Same unique LEI or PermID merges into one result.
- Shared name without country or identifier evidence does not merge.
- `/check`, `/basic`, `/full`, `/search`, callback, and deep-link paths handle merged records.
- Refresh metadata compares and persists all three resources.
- Refresh failure preserves active data.
- Empty bootstrap responses still distinguish empty local data from real misses.

Verification commands:

```bash
npm run typecheck
npm test
npm run build
```

## Out Of Scope

- Rebuilding the full securities entity graph from all child datasets.
- Downloading `default/entities.ftm.json` or `default/targets.nested.json`.
- Adding new Telegram commands.
- Using the OpenSanctions paid API.
- Changing access control behavior.
- Replacing SQLite.

The full graph rebuild option is documented separately in `docs/superpowers/specs/2026-07-01-complete-securities-graph-build-notes.md` for future use.
