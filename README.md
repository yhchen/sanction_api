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

## Telegram setup guide

### 1. Create the bot in Telegram

1. Open Telegram and search for the official `@BotFather`.
2. Send `/newbot`.
3. Follow BotFather's prompts to choose a bot display name and a unique bot username ending in `bot`.
4. Copy the token that BotFather returns. Use it as `TELEGRAM_BOT_TOKEN`.

Keep the token secret. Anyone with the token can control the bot.

### 2. Configure the Telegram command menu

In `@BotFather`, use `/mybots`, choose this bot, then use **Edit Bot > Edit Commands**. Send this command list:

```text
start - Show help and access status
request - Request access from an admin
check - Check a complete name for Debarred status
basic - Show basic record information
full - Show full sanctions details
approve - Admin: approve a Telegram user id
```

Telegram shows these commands in the bot chat menu when users type `/` or tap the menu button.

### 3. Get the admin Telegram user ID

`ADMIN_TELEGRAM_USERS` must contain numeric Telegram user IDs, not usernames.

Recommended bootstrap flow:

1. Set `TELEGRAM_BOT_TOKEN` and run the bot once.
2. Open the bot in Telegram with the admin account.
3. Send `/start`.
4. The bot replies with the Telegram numeric user ID.
5. Stop the bot.
6. Set `ADMIN_TELEGRAM_USERS` to that ID, for example:

```bash
export ADMIN_TELEGRAM_USERS="123456789"
```

For multiple admins, use comma-separated IDs:

```bash
export ADMIN_TELEGRAM_USERS="123456789,987654321"
```

Each admin should open the bot and send `/start` once. Telegram only allows the bot to proactively DM users who have started the bot.

### 4. Run in admin-approved mode

Use this configuration for a private bot where admins approve users from Telegram:

```bash
export TELEGRAM_BOT_TOKEN="<bot-token-from-BotFather>"
export ALLOWED_TELEGRAM_USERS=""
export ADMIN_TELEGRAM_USERS="<admin-telegram-numeric-id>"
export APPROVED_TELEGRAM_USERS_PATH="./approved-users.json"
export SENZING_PATH="./senzing.json"
export TARGETS_NESTED_PATH="./targets.nested.json"
export MAX_RESULTS="5"
export MAX_MESSAGE_CHARS="3800"
```

Then start the bot:

```bash
npm install
npm run build
node dist/index.js
```

For development, use:

```bash
npm run dev
```

Make sure `APPROVED_TELEGRAM_USERS_PATH` points to a writable location. The bot creates this file on the first approval.

### 5. User request and admin approval flow

User flow:

1. User opens the bot in Telegram.
2. User sends `/start`.
3. If not approved, the bot shows the user's numeric Telegram ID.
4. User sends `/request`.
5. The bot DMs all configured admins with the request details.

Admin flow:

1. Admin receives an access request message from the bot.
2. Admin approves in either way:
   - reply to that request message with `/approve`
   - send `/approve <telegram_user_id>`, for example `/approve 123456789`
3. The bot writes the approved ID to `approved-users.json`.
4. The approved user receives an access-approved message and can use `/check`, `/basic`, `/full`, or plain text name lookups.

If admins do not receive request notifications, verify:

- the admin ID is listed in `ADMIN_TELEGRAM_USERS`;
- `ADMIN_TELEGRAM_USERS` contains numeric IDs, not `@username` values;
- the admin has opened the bot and sent `/start`;
- the bot process can write `approved-users.json`.

### 6. Access mode reference

Use exactly one of these modes for normal deployments:

| Mode | Configuration | Behavior |
| --- | --- | --- |
| Public | `ALLOWED_TELEGRAM_USERS="*"` | Any Telegram user can query the bot. |
| Static private | `ALLOWED_TELEGRAM_USERS="123,456"` | Only listed users can query the bot. |
| Admin-approved | `ALLOWED_TELEGRAM_USERS=""`, `ADMIN_TELEGRAM_USERS="123"` | Users request access with `/request`; admins approve with `/approve`. |

Admin IDs are always allowed to use lookup commands. Runtime-approved IDs are stored in `approved-users.json`; do not commit that file.

Reference: Telegram's official BotFather tutorial and bot command-menu documentation are available at <https://core.telegram.org/bots/tutorial> and <https://core.telegram.org/bots/features>.


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
