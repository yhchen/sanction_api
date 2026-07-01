# SQLite-Main Conflict Resolution Design

## Goal

Resolve the merge conflict between `feature/sqlite` and `origin/main` while preserving the SQLite backend as the primary runtime path. Remote changes should be kept when they do not undermine the SQLite flow or create ambiguous behavior.

## Current Branch Priority

`feature/sqlite` owns the main data path:

- Startup opens or builds a SQLite database from `senzing.json` and `targets.nested.json`.
- Runtime queries use `SqliteSenzingRepository` and `SqliteTargetDetailsRepository`.
- Refresh downloads both JSONL resources, builds a staged SQLite database, validates it, publishes it, opens replacement SQLite repositories, then hot-swaps the active repositories.
- Empty bootstrap data may start the bot with an empty SQLite database and kick off an initial refresh.

These behaviors must not be replaced by the older memory-only startup or refresh path.

## Remote Changes To Retain

Retain `origin/main` changes where they compose cleanly with SQLite:

- `MIN_FUZZY_SCORE` config and validation.
- `TELEGRAM_BOT_USERNAME` config for Telegram deep links.
- Fuzzy search result `Full` links and `/start full_<recordId>` handling.
- Telegram HTML parse mode support.
- PM2 scripts and `ecosystem.config.cjs`.
- Documentation updates for alias coverage, fuzzy threshold, PM2, and startup refresh behavior.
- Tests that prove alias exact lookup, fuzzy alias search, fuzzy threshold filtering, deep links, PM2 config, and startup refresh behavior.

## Conflict Resolution Design

### Configuration

`AppConfig` should include both feature sets:

- Existing SQLite fields: `sqlitePath`.
- Remote fields: `telegramBotUsername`, `minFuzzyScore`.
- Existing common fields: Telegram token, access control, approved users path, JSONL paths, refresh metadata path, refresh schedule, result/message limits.

`.env.example` should document `SQLITE_PATH`, `TELEGRAM_BOT_USERNAME`, and `MIN_FUZZY_SCORE`. `package.json` should retain both `db:build` and PM2 scripts.

### Fuzzy Scoring

Keep the current branch's extracted `src/domain/nameScoring.ts` as the scoring boundary. Change it so the minimum score threshold is configurable instead of hard-coded for every caller.

Both repositories must use the same scoring behavior:

- `SenzingMemoryRepository` accepts `minFuzzyScore` for compatibility and focused tests.
- `SqliteSenzingRepository` accepts `minFuzzyScore` and applies it when scoring FTS recall rows.
- SQLite remains the production query path after startup and refresh.

### Startup And Refresh

Keep SQLite bootstrap as the startup owner. Do not replace it with memory repository loading.

Remote startup refresh semantics should be folded into SQLite behavior:

- If both JSONL files and SQLite data are usable, open SQLite normally.
- If JSONL files are missing or empty and SQLite is empty, create empty placeholders and an empty SQLite DB, then start an initial refresh.
- If only one required JSONL file exists or only one is populated, fail startup rather than guessing.
- If refresh metadata says data is current but required local files or SQLite output are missing or unusable, refresh/rebuild instead of returning `current`.

Refresh publish should preserve the current branch's safety model:

- Stage downloads and SQLite build in a temp directory.
- Validate downloaded resources and staged SQLite repositories before publishing.
- Publish JSONL, SQLite, and metadata together.
- On publish/open failure, restore previous files and keep current active repositories.
- After successful publish, open replacement SQLite repositories and hot-swap active repositories.

### Bot Behavior

Keep the current branch's empty-data user messages so an empty bootstrap does not look like a real miss.

Retain remote deep-link behavior:

- `formatFuzzySearchResult` emits no inline callback buttons for fuzzy candidates.
- If `TELEGRAM_BOT_USERNAME` is configured, each fuzzy candidate may include an HTML `Full` link.
- `BotReply` supports `parseMode: 'HTML'`.
- `createBot` forwards `/start` payloads to `BotCommandHandler.handleStart`.
- `handleStart` enforces access control before resolving `full_<recordId>`.
- Malformed deep-link payloads fall back to the normal start/help response.

### Documentation

Documentation should describe the merged behavior:

- SQLite DB path and build script.
- Optional fuzzy threshold.
- Optional bot username for full-result deep links.
- PM2 deployment commands.
- Startup behavior when data files are missing.
- Alias exact lookup and fuzzy alias search behavior.

## Testing And Verification

Run these checks after conflict resolution:

- `npm run typecheck`
- `npm test`
- `npm run build`

The tests should cover:

- SQLite bootstrap from populated JSONL.
- Empty SQLite bootstrap and initial refresh behavior.
- Refresh rebuild when metadata is current but local required data is missing.
- Refresh rollback when SQLite publish/open fails.
- SQLite fuzzy search respects `MIN_FUZZY_SCORE`.
- Exact lookup accepts complete primary names and complete aliases.
- Fuzzy search finds alias candidates but does not turn partial names into exact hits.
- Fuzzy search deep links render with HTML when bot username is configured.
- `/start full_<recordId>` returns full details for allowed users and rejects unauthorized users.
- PM2 scripts and ecosystem config remain present.

## Non-Goals

- Do not redesign the repository interfaces.
- Do not reintroduce memory repositories as the production runtime path.
- Do not remove SQLite fallback/empty-bootstrap behavior from the current branch.
- Do not change Telegram command semantics beyond the remote deep-link and documentation updates already present on `origin/main`.
