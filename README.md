# Sanction API Telegram Bot

Node/TypeScript Telegram bot for Debarred lookups over OpenSanctions-derived local files.

## V1 data sources

- `senzing.json`: primary startup in-memory name index and `/basic` data source.
- `targets.nested.json`: `/full` nested sanctions details keyed by OpenSanctions record id.
- `entities.ftm.json`: inspected but not used as the V1 query source.

## Matching and behavior

- Matching is normalized exact match over complete `NAMES[].NAME_FULL` primary/alias values.
- Partial names do not match. Example: `Yatai Smart` is not the same as `YATAI SMART INDUSTRIAL NEW CITY`.
- Only records with risk topic `debarment` are reported as `Debarred`.
- Plain text names behave like `/check <name>`.
- Positive `/check` replies include `/basic` and `/full` inline buttons.
- `/basic <name>` and `/full <name>` are available as direct commands.

## Configuration

Set environment variables before running:

```bash
export TELEGRAM_BOT_TOKEN="<bot-token>"
export ALLOWED_TELEGRAM_USERS="*" # or comma-separated Telegram numeric user ids, e.g. "123,456"
export SENZING_PATH="./senzing.json"
export TARGETS_NESTED_PATH="./targets.nested.json"
export MAX_RESULTS="5"
export MAX_MESSAGE_CHARS="3800"
```

`ALLOWED_TELEGRAM_USERS=*` makes the bot public. An empty whitelist denies users.


## Architecture notes

The V1 code keeps file parsing inside repository adapters and exposes lookup behavior through repository interfaces. `TargetsNestedMemoryRepository` maps raw `targets.nested.json` sanctions into a small domain `SanctionDetail` DTO before formatting, so future MongoDB/lightweight-database adapters do not need to expose raw OpenSanctions nested records to the bot UI.

V1 intentionally loads local JSONL inputs at startup for simple, fast exact-name lookups. If startup time or RSS becomes a problem as data grows, replace the memory repositories with a persistent adapter while preserving the service and bot handler contracts.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

The bot currently uses in-memory DAO adapters. The service depends on repository interfaces so MongoDB or another adapter can be added later without changing bot handlers.
