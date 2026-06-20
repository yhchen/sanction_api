# Telegram Admin Approval Access Design

## Goal

Add a semi-public access mode for the Telegram debarment lookup bot. Users can request access from inside Telegram, and configured administrators can approve them with Telegram commands. Approved users are persisted locally so access survives bot restarts.

## Existing Context

The project currently uses:

- `TELEGRAM_BOT_TOKEN` to start the Telegraf bot.
- `ALLOWED_TELEGRAM_USERS` for access control:
  - `*` makes the bot public.
  - A comma-separated list allows static Telegram numeric user IDs.
  - An empty value denies users.
- File-backed local data sources and in-memory repositories.
- Pure handler logic covered by Vitest tests.

The design keeps this style: environment variables for configuration, a local JSON file for mutable state, and testable bot handler behavior.

## Chosen Approach

Implement admin-approved access with local JSON persistence.

Rejected alternatives:

- Environment-only approval, because every approval would require editing env vars and restarting the bot.
- Memory-only approval, because approvals would be lost on restart.
- Database-backed approval, because it is heavier than the current single-instance local-file deployment model.

## Configuration

Add:

```bash
ADMIN_TELEGRAM_USERS="123,456"
APPROVED_TELEGRAM_USERS_PATH="./approved-users.json"
```

Keep `ALLOWED_TELEGRAM_USERS`:

- `*` still means public mode.
- Static IDs in `ALLOWED_TELEGRAM_USERS` still allow those users without dynamic approval.
- Dynamic approvals are read from `APPROVED_TELEGRAM_USERS_PATH`.

Administrator authority comes only from `ADMIN_TELEGRAM_USERS`, not from `ALLOWED_TELEGRAM_USERS`. Admin IDs are also allowed to use lookup commands without needing separate approval.

## Components

### Approved Users Repository

Add an `ApprovedUsersRepository` responsible for reading and writing the approved user JSON file.

File format:

```json
{
  "approvedUserIds": ["123456789"]
}
```

Behavior:

- Missing file means no dynamic approvals yet.
- First approval creates the file.
- Duplicate approvals are idempotent.
- Invalid JSON causes startup failure with a clear error.

### Access Control

Extend access control so a user is allowed when any of these are true:

1. `ALLOWED_TELEGRAM_USERS=*`.
2. The user appears in static `ALLOWED_TELEGRAM_USERS`.
3. The user appears in the dynamic approved users repository.
4. The user appears in `ADMIN_TELEGRAM_USERS`.

Admin checks are separate:

- Only IDs in `ADMIN_TELEGRAM_USERS` can approve users.
- Admins can use ordinary lookup commands without separate approval.

### Bot Handler

Keep sanctions lookup behavior unchanged for authorized users.

Allow unauthenticated users to use:

- `/start`
- `/request`

Block unauthenticated users from:

- Plain text lookups
- `/check`
- `/basic`
- `/full`
- Inline callback actions

Add admin commands:

- `/approve <telegram_user_id>`
- Reply to a request notification with `/approve`

On successful approval:

1. Persist the approved user ID.
2. Reply to the admin with success.
3. Notify the approved user that access is ready.

## User Flow

### Requester

1. User opens the bot and sends `/start`.
2. If unauthorized, bot replies that access is not approved yet, shows the user's Telegram numeric ID, and suggests `/request`.
3. User sends `/request`.
4. Bot sends request notifications to all configured admins who can receive messages from the bot.
5. User receives a request status message.
6. After approval, user receives: "Access approved. You can now send a complete name or use /check <name>."

### Admin

Admins can approve in either of two ways:

1. Send `/approve 123456789`.
2. Reply `/approve` to the bot's request notification message.

The request notification includes:

- Requester Telegram ID
- Username, first name, and last name when available from Telegram
- Approval instructions

## Error Handling

- Empty `ADMIN_TELEGRAM_USERS`:
  - Bot can start.
  - `/request` tells users no admins are configured.
- Missing approved users file:
  - Treated as an empty list.
  - Created on first approval.
- Corrupt approved users file:
  - Startup fails clearly rather than silently overwriting or allowing users.
- Invalid `/approve` input:
  - Admin gets usage/error text.
  - No file write occurs.
- Duplicate approval:
  - No duplicate is written.
  - Admin is told the user is already approved.
- Admin notification failure:
  - Request command still completes.
  - Failure is logged.
  - User receives a conservative status message that some admins could not be notified.

## Security Boundaries

- Only `ADMIN_TELEGRAM_USERS` grants approval authority.
- Admin IDs are allowed to use the bot by definition.
- Unauthorized users cannot run lookup commands or callbacks.
- `ALLOWED_TELEGRAM_USERS=*` remains an explicit public mode.
- Reply-based `/approve` only parses requester identity from bot-generated request notification messages.
- The local JSON file is trusted deployment state and should not be committed with real user IDs.

## Testing Plan

Add or update Vitest coverage for:

- Parsing admin ID lists.
- Static allow list, admin list, and dynamic approved user access.
- `/request` responses for configured and unconfigured admins.
- Admin notification payload contents.
- `/approve <id>` success.
- `/approve <id>` duplicate approval.
- `/approve <id>` invalid input.
- Non-admin approval rejection.
- Reply `/approve` success from a request notification.
- Unauthorized users blocked from lookup commands and callbacks.
- Approved users file missing, created on first write, read on startup, and corrupt JSON failure.

## Out of Scope

Keep the first implementation focused by not adding:

- `/pending`
- `/deny`
- `/revoke`
- Approval expiration
- Group chat approval flows
- Webhook deployment
- Database-backed persistence

These can be added later without changing the main access-control boundary.
