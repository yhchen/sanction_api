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
export ALLOWED_TELEGRAM_USERS="" # "*" makes the bot public; comma-separated IDs are statically allowed
export ADMIN_TELEGRAM_USERS="123456789" # comma-separated Telegram numeric user ids that can approve access
export APPROVED_TELEGRAM_USERS_PATH="./approved-users.json"
export SENZING_PATH="./senzing.json"
export TARGETS_NESTED_PATH="./targets.nested.json"
export MAX_RESULTS="5"
export MAX_MESSAGE_CHARS="3800"
```

Access control supports three modes:

- Public: set `ALLOWED_TELEGRAM_USERS=*`.
- Static private: set `ALLOWED_TELEGRAM_USERS="123,456"`.
- Admin-approved: set `ADMIN_TELEGRAM_USERS="123"` and keep `APPROVED_TELEGRAM_USERS_PATH` pointed at a writable local JSON file. Unauthorized users can send `/request`; admins can approve with `/approve <telegram_user_id>` or by replying `/approve` to the bot's request notification.

The runtime `approved-users.json` file contains real Telegram user IDs and is ignored by git.


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
