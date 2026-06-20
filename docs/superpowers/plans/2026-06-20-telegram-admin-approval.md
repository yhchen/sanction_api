# Telegram Admin Approval Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Telegram admin-approved access so unauthorized users can request access and configured admins can approve them from Telegram.

**Architecture:** Keep sanctions lookup unchanged. Add local JSON persistence for dynamic approved users, extend access control with separate admin authority, and carry bot-generated notification side effects through `BotReply.notifications` so handler behavior remains testable.

**Tech Stack:** Node.js 20, TypeScript ES2022, Telegraf 4, Vitest, local JSON file persistence.

---

## File Structure

- Create `src/data/approvedUsersRepository.ts`: owns reading, validating, writing, and querying `approved-users.json`.
- Modify `src/domain/types.ts`: add notification payloads to `BotReply` without changing existing text/button behavior.
- Modify `src/config.ts`: load `ADMIN_TELEGRAM_USERS` and `APPROVED_TELEGRAM_USERS_PATH`.
- Modify `src/bot/accessControl.ts`: parse admin IDs and allow static, admin, public, or dynamic-approved users.
- Modify `src/bot/handlers.ts`: add `/request`, `/approve <id>`, reply `/approve`, request notification text, and approval notification text.
- Modify `src/bot/createBot.ts`: route new commands, pass sender/reply metadata into the handler, and deliver `BotReply.notifications` through `ctx.telegram.sendMessage`.
- Modify `src/index.ts`: load the approved users repository and wire it into access control and handlers.
- Modify `test/debarment-bot.test.ts`: add focused tests for config, repository, access control, request, approval, and notification payloads.
- Modify `.env.example`: document the new env vars.
- Modify `.gitignore`: ignore the runtime `approved-users.json` file.
- Modify `README.md`: document admin-approved access setup and Telegram commands.

---

### Task 1: Config and Reply Notification Types

**Files:**
- Modify: `src/config.ts`
- Modify: `src/domain/types.ts`
- Test: `test/debarment-bot.test.ts`

- [ ] **Step 1: Write the failing config test**

Add this case inside the existing `describe('config', ...)` block in `test/debarment-bot.test.ts`:

```ts
test('loads admin approval config', () => {
  expect(
    loadConfig(
      {
        TELEGRAM_BOT_TOKEN: 'token',
        ADMIN_TELEGRAM_USERS: '111, 222',
        APPROVED_TELEGRAM_USERS_PATH: './runtime-approved.json',
      },
      { requireToken: true },
    ),
  ).toMatchObject({
    adminTelegramUsers: '111, 222',
    approvedTelegramUsersPath: './runtime-approved.json',
  });

  expect(loadConfig({ TELEGRAM_BOT_TOKEN: 'token' }, { requireToken: true })).toMatchObject({
    adminTelegramUsers: '',
    approvedTelegramUsersPath: './approved-users.json',
  });
});
```

- [ ] **Step 2: Run the focused config test and verify failure**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "loads admin approval config"
```

Expected: FAIL because `adminTelegramUsers` and `approvedTelegramUsersPath` do not exist yet.

- [ ] **Step 3: Extend `AppConfig` and `loadConfig`**

In `src/config.ts`, add the two fields to `AppConfig`:

```ts
  adminTelegramUsers: string;
  approvedTelegramUsersPath: string;
```

In the object returned by `loadConfig`, add:

```ts
    adminTelegramUsers: env.ADMIN_TELEGRAM_USERS?.trim() ?? '',
    approvedTelegramUsersPath: env.APPROVED_TELEGRAM_USERS_PATH?.trim() || './approved-users.json',
```

The resulting return object should keep the existing fields and include the new fields:

```ts
  return {
    telegramBotToken,
    allowedTelegramUsers: env.ALLOWED_TELEGRAM_USERS?.trim() ?? '',
    adminTelegramUsers: env.ADMIN_TELEGRAM_USERS?.trim() ?? '',
    approvedTelegramUsersPath: env.APPROVED_TELEGRAM_USERS_PATH?.trim() || './approved-users.json',
    senzingPath: env.SENZING_PATH?.trim() || './senzing.json',
    targetsNestedPath: env.TARGETS_NESTED_PATH?.trim() || './targets.nested.json',
    maxResults: positiveInteger(env.MAX_RESULTS, 5, 'MAX_RESULTS'),
    maxMessageChars: boundedPositiveInteger(env.MAX_MESSAGE_CHARS, 3800, 'MAX_MESSAGE_CHARS', TELEGRAM_MAX_MESSAGE_CHARS),
  };
```

- [ ] **Step 4: Add notification types to `BotReply`**

In `src/domain/types.ts`, insert before `BotReply`:

```ts
export interface BotNotification {
  chatId: string;
  text: string;
}
```

Then change `BotReply` to:

```ts
export interface BotReply {
  text: string;
  buttons: ReplyButton[][];
  notifications?: BotNotification[];
}
```

- [ ] **Step 5: Run the focused config test and verify pass**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "loads admin approval config"
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add src/config.ts src/domain/types.ts test/debarment-bot.test.ts
git commit -m "feat: add admin approval config"
```

---

### Task 2: Approved Users JSON Repository

**Files:**
- Create: `src/data/approvedUsersRepository.ts`
- Test: `test/debarment-bot.test.ts`

- [ ] **Step 1: Add test imports**

At the top of `test/debarment-bot.test.ts`, add:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
```

Add this import with the other project imports:

```ts
import { ApprovedUsersRepository } from '../src/data/approvedUsersRepository.js';
```

- [ ] **Step 2: Write failing repository tests**

Add this block before `describe('config', ...)`:

```ts
describe('approved users repository', () => {
  async function tempApprovedUsersPath(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'approved-users-'));
    return path.join(dir, 'approved-users.json');
  }

  test('treats a missing approved users file as empty and creates it on approval', async () => {
    const filePath = await tempApprovedUsersPath();
    const repo = await ApprovedUsersRepository.fromFile(filePath);

    expect(repo.has('123')).toBe(false);
    await expect(repo.approve('123')).resolves.toEqual({ userId: '123', alreadyApproved: false });
    expect(repo.has('123')).toBe(true);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('{
  "approvedUserIds": [
    "123"
  ]
}\n');
  });

  test('loads existing approved users and keeps approvals idempotent', async () => {
    const filePath = await tempApprovedUsersPath();
    await fs.writeFile(filePath, '{"approvedUserIds":["456"]}\n', 'utf8');
    const repo = await ApprovedUsersRepository.fromFile(filePath);

    expect(repo.has('456')).toBe(true);
    await expect(repo.approve('456')).resolves.toEqual({ userId: '456', alreadyApproved: true });
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('{
  "approvedUserIds": [
    "456"
  ]
}\n');
  });

  test('rejects corrupt or invalid approved users files', async () => {
    const corruptPath = await tempApprovedUsersPath();
    await fs.writeFile(corruptPath, '{broken', 'utf8');
    await expect(ApprovedUsersRepository.fromFile(corruptPath)).rejects.toThrow(/Invalid approved users JSON/);

    const invalidShapePath = await tempApprovedUsersPath();
    await fs.writeFile(invalidShapePath, '{"approvedUserIds":[123]}\n', 'utf8');
    await expect(ApprovedUsersRepository.fromFile(invalidShapePath)).rejects.toThrow(/approvedUserIds/);
  });
});
```

- [ ] **Step 3: Run repository tests and verify failure**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "approved users repository"
```

Expected: FAIL because `src/data/approvedUsersRepository.ts` does not exist.

- [ ] **Step 4: Create `ApprovedUsersRepository`**

Create `src/data/approvedUsersRepository.ts` with:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';

export interface ApprovalResult {
  userId: string;
  alreadyApproved: boolean;
}

interface ApprovedUsersFile {
  approvedUserIds: string[];
}

export class ApprovedUsersRepository {
  private constructor(
    private readonly filePath: string,
    private readonly approvedUserIds: Set<string>,
  ) {}

  static async fromFile(filePath: string): Promise<ApprovedUsersRepository> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return new ApprovedUsersRepository(filePath, new Set());
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: unknown) {
      throw new Error(`Invalid approved users JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const approvedUserIds = parseApprovedUsersFile(parsed, filePath);
    return new ApprovedUsersRepository(filePath, new Set(approvedUserIds));
  }

  has(userId: string | number | undefined | null): boolean {
    if (userId === undefined || userId === null) return false;
    return this.approvedUserIds.has(String(userId));
  }

  all(): string[] {
    return [...this.approvedUserIds].sort(compareNumericStrings);
  }

  async approve(userId: string | number): Promise<ApprovalResult> {
    const normalizedUserId = String(userId).trim();
    if (!/^\d+$/u.test(normalizedUserId)) {
      throw new Error('Telegram user id must contain only digits.');
    }

    if (this.approvedUserIds.has(normalizedUserId)) {
      await this.write();
      return { userId: normalizedUserId, alreadyApproved: true };
    }

    this.approvedUserIds.add(normalizedUserId);
    await this.write();
    return { userId: normalizedUserId, alreadyApproved: false };
  }

  private async write(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true });
    const snapshot: ApprovedUsersFile = { approvedUserIds: this.all() };
    await fs.writeFile(this.filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  }
}

function parseApprovedUsersFile(parsed: unknown, filePath: string): string[] {
  if (!isObject(parsed) || !Array.isArray(parsed.approvedUserIds)) {
    throw new Error(`Invalid approved users file at ${filePath}: approvedUserIds must be an array of strings.`);
  }

  for (const userId of parsed.approvedUserIds) {
    if (typeof userId !== 'string' || !/^\d+$/u.test(userId)) {
      throw new Error(`Invalid approved users file at ${filePath}: approvedUserIds must contain only numeric strings.`);
    }
  }

  return [...new Set(parsed.approvedUserIds)];
}

function isObject(value: unknown): value is { approvedUserIds?: unknown } {
  return typeof value === 'object' && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function compareNumericStrings(left: string, right: string): number {
  const lengthDelta = left.length - right.length;
  if (lengthDelta !== 0) return lengthDelta;
  return left.localeCompare(right, 'en-US');
}
```

- [ ] **Step 5: Run repository tests and verify pass**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "approved users repository"
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add src/data/approvedUsersRepository.ts test/debarment-bot.test.ts
git commit -m "feat: persist approved telegram users"
```

---

### Task 3: Access Control with Admins and Dynamic Approvals

**Files:**
- Modify: `src/bot/accessControl.ts`
- Test: `test/debarment-bot.test.ts`

- [ ] **Step 1: Write failing access-control tests**

In `describe('access control and pure handlers', ...)`, replace the existing `supports whitelist and public wildcard` test with:

```ts
test('supports public wildcard, static whitelist, admins, and dynamic approvals', () => {
  const approvedUsers = { has: (userId: string | number | undefined | null) => String(userId) === '789' };

  expect(createAccessControl('*').isAllowed(undefined)).toBe(true);
  expect(createAccessControl('123, 456').isAllowed(123)).toBe(true);
  expect(createAccessControl('123, 456').isAllowed('789')).toBe(false);
  expect(createAccessControl('').isAllowed(123)).toBe(false);

  const accessControl = createAccessControl('123', {
    adminTelegramUsers: '456',
    approvedUsers,
  });

  expect(accessControl.isAllowed(123)).toBe(true);
  expect(accessControl.isAllowed(456)).toBe(true);
  expect(accessControl.isAllowed(789)).toBe(true);
  expect(accessControl.isAllowed(999)).toBe(false);
  expect(accessControl.isAdmin(456)).toBe(true);
  expect(accessControl.isAdmin(123)).toBe(false);
  expect([...accessControl.adminUserIds]).toEqual(['456']);
});
```

- [ ] **Step 2: Run the access-control test and verify failure**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "supports public wildcard"
```

Expected: FAIL because `createAccessControl` does not accept admin or dynamic-approved options yet.

- [ ] **Step 3: Replace access-control implementation**

Replace `src/bot/accessControl.ts` with:

```ts
export interface ApprovedUsersLookup {
  has(userId: string | number | undefined | null): boolean;
}

export interface AccessControlOptions {
  adminTelegramUsers?: string | undefined | null;
  approvedUsers?: ApprovedUsersLookup;
}

export interface AccessControl {
  readonly isPublic: boolean;
  readonly allowedUserIds: ReadonlySet<string>;
  readonly adminUserIds: ReadonlySet<string>;
  isAllowed(userId: string | number | undefined | null): boolean;
  isAdmin(userId: string | number | undefined | null): boolean;
}

export function createAccessControl(
  whitelist: string | undefined | null,
  options: AccessControlOptions = {},
): AccessControl {
  const entries = parseTelegramUserList(whitelist);
  const isPublic = entries.includes('*');
  const allowedUserIds = new Set(entries.filter((entry) => entry !== '*'));
  const adminUserIds = new Set(parseTelegramUserList(options.adminTelegramUsers).filter((entry) => entry !== '*'));
  const approvedUsers = options.approvedUsers;

  return {
    isPublic,
    allowedUserIds,
    adminUserIds,
    isAllowed(userId) {
      if (isPublic) return true;
      const normalizedUserId = normalizeUserId(userId);
      if (!normalizedUserId) return false;
      return allowedUserIds.has(normalizedUserId) || adminUserIds.has(normalizedUserId) || approvedUsers?.has(normalizedUserId) === true;
    },
    isAdmin(userId) {
      const normalizedUserId = normalizeUserId(userId);
      if (!normalizedUserId) return false;
      return adminUserIds.has(normalizedUserId);
    },
  };
}

function parseTelegramUserList(rawList: string | undefined | null): string[] {
  return (rawList ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeUserId(userId: string | number | undefined | null): string | undefined {
  if (userId === undefined || userId === null) return undefined;
  return String(userId);
}
```

- [ ] **Step 4: Run the access-control tests and verify pass**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "supports public wildcard"
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

Run:

```bash
git add src/bot/accessControl.ts test/debarment-bot.test.ts
git commit -m "feat: support admin and approved user access"
```

---

### Task 4: Request and Approve Handler Behavior

**Files:**
- Modify: `src/bot/handlers.ts`
- Test: `test/debarment-bot.test.ts`

- [ ] **Step 1: Write failing handler tests**

Add this helper near `buildService` in `test/debarment-bot.test.ts`:

```ts
class InMemoryApprovedUsers {
  private readonly userIds = new Set<string>();

  constructor(initialUserIds: string[] = []) {
    for (const userId of initialUserIds) this.userIds.add(userId);
  }

  has(userId: string | number | undefined | null): boolean {
    if (userId === undefined || userId === null) return false;
    return this.userIds.has(String(userId));
  }

  async approve(userId: string | number): Promise<{ userId: string; alreadyApproved: boolean }> {
    const normalizedUserId = String(userId).trim();
    const alreadyApproved = this.userIds.has(normalizedUserId);
    this.userIds.add(normalizedUserId);
    return { userId: normalizedUserId, alreadyApproved };
  }
}
```

Add these tests inside `describe('access control and pure handlers', ...)`:

```ts
test('unauthorized start shows request instructions and user id', async () => {
  const approvedUsers = new InMemoryApprovedUsers();
  const handler = new BotCommandHandler(
    await buildService(),
    createAccessControl('', { adminTelegramUsers: '456', approvedUsers }),
    approvedUsers,
  );

  await expect(handler.handleStart(123)).resolves.toMatchObject({
    text: 'Unauthorized. Your Telegram user id is 123. Send /request to ask an admin for access.',
  });
});

test('request notifies configured admins with requester details', async () => {
  const approvedUsers = new InMemoryApprovedUsers();
  const handler = new BotCommandHandler(
    await buildService(),
    createAccessControl('', { adminTelegramUsers: '456, 789', approvedUsers }),
    approvedUsers,
  );

  const reply = await handler.handleMessage('/request', 123, {
    from: { id: 123, username: 'alice', firstName: 'Alice', lastName: 'Example' },
  });

  expect(reply.text).toBe('Access request received. Admins have been notified if reachable.');
  expect(reply.notifications).toEqual([
    {
      chatId: '456',
      text: 'Access request\nUser ID: 123\nUsername: @alice\nName: Alice Example\n\nReply to this message with /approve or send /approve 123.',
    },
    {
      chatId: '789',
      text: 'Access request\nUser ID: 123\nUsername: @alice\nName: Alice Example\n\nReply to this message with /approve or send /approve 123.',
    },
  ]);
});

test('request reports when no admins are configured', async () => {
  const approvedUsers = new InMemoryApprovedUsers();
  const handler = new BotCommandHandler(
    await buildService(),
    createAccessControl('', { approvedUsers }),
    approvedUsers,
  );

  await expect(handler.handleMessage('/request', 123)).resolves.toMatchObject({
    text: 'No admins are configured. Ask the bot operator to set ADMIN_TELEGRAM_USERS.',
  });
});

test('admin can approve by id and approved user is notified', async () => {
  const approvedUsers = new InMemoryApprovedUsers();
  const accessControl = createAccessControl('', { adminTelegramUsers: '456', approvedUsers });
  const handler = new BotCommandHandler(await buildService(), accessControl, approvedUsers);

  const reply = await handler.handleMessage('/approve 123', 456);

  expect(reply).toMatchObject({
    text: 'Approved user 123.',
    notifications: [{ chatId: '123', text: 'Access approved. You can now send a complete name or use /check <name>.' }],
  });
  expect(accessControl.isAllowed(123)).toBe(true);
});

test('admin approve is idempotent and rejects invalid input', async () => {
  const approvedUsers = new InMemoryApprovedUsers(['123']);
  const handler = new BotCommandHandler(
    await buildService(),
    createAccessControl('', { adminTelegramUsers: '456', approvedUsers }),
    approvedUsers,
  );

  await expect(handler.handleMessage('/approve 123', 456)).resolves.toMatchObject({ text: 'User 123 is already approved.' });
  await expect(handler.handleMessage('/approve abc', 456)).resolves.toMatchObject({ text: 'Invalid Telegram user id.' });
  await expect(handler.handleMessage('/approve', 456)).resolves.toMatchObject({
    text: 'Usage: /approve <telegram_user_id> or reply /approve to an access request.',
  });
});

test('non-admin cannot approve users', async () => {
  const approvedUsers = new InMemoryApprovedUsers();
  const handler = new BotCommandHandler(
    await buildService(),
    createAccessControl('', { adminTelegramUsers: '456', approvedUsers }),
    approvedUsers,
  );

  await expect(handler.handleMessage('/approve 123', 999)).resolves.toMatchObject({ text: 'Unauthorized.' });
  expect(approvedUsers.has('123')).toBe(false);
});

test('admin can approve by replying to a request notification', async () => {
  const approvedUsers = new InMemoryApprovedUsers();
  const handler = new BotCommandHandler(
    await buildService(),
    createAccessControl('', { adminTelegramUsers: '456', approvedUsers }),
    approvedUsers,
  );

  await expect(
    handler.handleMessage('/approve', 456, {
      replyToText: 'Access request\nUser ID: 123\nUsername: @alice\nName: Alice Example\n\nReply to this message with /approve or send /approve 123.',
    }),
  ).resolves.toMatchObject({ text: 'Approved user 123.' });
  expect(approvedUsers.has('123')).toBe(true);
});
```

- [ ] **Step 2: Run handler tests and verify failure**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "request|approve|unauthorized start"
```

Expected: FAIL because the handler constructor and commands do not support approvals yet.

- [ ] **Step 3: Replace handler implementation with approval-aware logic**

Replace `src/bot/handlers.ts` with:

```ts
import type { DebarmentService } from '../domain/debarmentService.js';
import type { BotReply } from '../domain/types.js';
import type { AccessControl } from './accessControl.js';
import { formatBasicResults, formatCheckResult, formatFullResults, type FormatterOptions } from './formatters.js';

export interface TelegramUserProfile {
  id?: string | number;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export interface BotMessageMetadata {
  from?: TelegramUserProfile;
  replyToText?: string;
}

export interface ApprovedUsersWriter {
  approve(userId: string | number): Promise<{ userId: string; alreadyApproved: boolean }>;
}

export class BotCommandHandler {
  constructor(
    private readonly service: DebarmentService,
    private readonly accessControl: AccessControl,
    private readonly approvedUsers: ApprovedUsersWriter,
    private readonly formatterOptions: FormatterOptions = {},
  ) {}

  async handleStart(userId: string | number | undefined): Promise<BotReply> {
    if (!this.accessControl.isAllowed(userId)) {
      const suffix = userId === undefined ? 'Send /request to ask an admin for access.' : `Your Telegram user id is ${userId}. Send /request to ask an admin for access.`;
      return textOnly(`Unauthorized. ${suffix}`);
    }
    const adminSuffix = this.accessControl.isAdmin(userId) ? ' Admin commands: /approve <telegram_user_id>.' : '';
    return textOnly(`Send a complete name to check Debarred status, or use /check, /basic, /full.${adminSuffix}`);
  }

  async handleMessage(rawMessage: string, userId: string | number | undefined, metadata: BotMessageMetadata = {}): Promise<BotReply> {
    const message = rawMessage.trim();
    if (!message) return textOnly('Send a full name or use /check <name>.');

    const parsed = message.startsWith('/') ? parseCommand(message) : undefined;
    if (parsed?.command === 'request') return this.handleRequest(userId, metadata);
    if (parsed?.command === 'approve') return this.handleApprove(userId, parsed.argument, metadata.replyToText);

    if (!this.accessControl.isAllowed(userId)) return textOnly('Unauthorized. Send /request to ask an admin for access.');

    if (!message.startsWith('/')) {
      return formatCheckResult(await this.service.check(message), this.formatterOptions);
    }

    if (!parsed) return textOnly('Supported commands: /check <name>, /basic <name>, /full <name>, /request');
    if (!parsed.argument) return textOnly(`Usage: /${parsed.command} <name>`);

    switch (parsed.command) {
      case 'check':
        return formatCheckResult(await this.service.check(parsed.argument), this.formatterOptions);
      case 'basic':
        return formatBasicResults(await this.service.basic(parsed.argument), this.formatterOptions);
      case 'full':
        return formatFullResults(await this.service.full(parsed.argument), this.formatterOptions);
    }
  }

  async handleCallback(callbackData: string, userId: string | number | undefined): Promise<BotReply> {
    if (!this.accessControl.isAllowed(userId)) return textOnly('Unauthorized.');

    const separatorIndex = callbackData.indexOf(':');
    if (separatorIndex < 1) return textOnly('Invalid action.');
    const action = callbackData.slice(0, separatorIndex);
    const recordId = callbackData.slice(separatorIndex + 1).trim();
    if (!recordId) return textOnly('Invalid action.');

    if (action === 'basic') return formatBasicResults(await this.service.basicByRecordId(recordId), this.formatterOptions);
    if (action === 'full') return formatFullResults(await this.service.fullByRecordId(recordId), this.formatterOptions);
    return textOnly('Invalid action.');
  }

  private handleRequest(userId: string | number | undefined, metadata: BotMessageMetadata): BotReply {
    if (this.accessControl.isAllowed(userId)) return textOnly('You already have access. Send a complete name or use /check <name>.');
    if (userId === undefined) return textOnly('Cannot request access because Telegram did not provide your user id.');

    const adminUserIds = [...this.accessControl.adminUserIds];
    if (adminUserIds.length === 0) return textOnly('No admins are configured. Ask the bot operator to set ADMIN_TELEGRAM_USERS.');

    const requester = metadata.from ?? { id: userId };
    const notificationText = formatAccessRequestNotification(requester, userId);
    return {
      text: 'Access request received. Admins have been notified if reachable.',
      buttons: [],
      notifications: adminUserIds.map((adminUserId) => ({ chatId: adminUserId, text: notificationText })),
    };
  }

  private async handleApprove(userId: string | number | undefined, argument: string, replyToText: string | undefined): Promise<BotReply> {
    if (!this.accessControl.isAdmin(userId)) return textOnly('Unauthorized.');

    const targetUserId = argument || extractRequesterId(replyToText);
    if (!targetUserId) return textOnly('Usage: /approve <telegram_user_id> or reply /approve to an access request.');
    if (!/^\d+$/u.test(targetUserId)) return textOnly('Invalid Telegram user id.');

    const result = await this.approvedUsers.approve(targetUserId);
    if (result.alreadyApproved) return textOnly(`User ${result.userId} is already approved.`);

    return {
      text: `Approved user ${result.userId}.`,
      buttons: [],
      notifications: [{ chatId: result.userId, text: 'Access approved. You can now send a complete name or use /check <name>.' }],
    };
  }
}

function parseCommand(message: string): { command: 'check' | 'basic' | 'full' | 'request' | 'approve'; argument: string } | undefined {
  const match = message.match(/^\/(check|basic|full|request|approve)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return undefined;
  return {
    command: match[1].toLocaleLowerCase('en-US') as 'check' | 'basic' | 'full' | 'request' | 'approve',
    argument: (match[2] ?? '').trim(),
  };
}

function formatAccessRequestNotification(requester: TelegramUserProfile, fallbackUserId: string | number): string {
  const userId = requester.id ?? fallbackUserId;
  const usernameLine = requester.username ? `\nUsername: @${requester.username}` : '';
  const fullName = [requester.firstName, requester.lastName].filter(Boolean).join(' ');
  const nameLine = fullName ? `\nName: ${fullName}` : '';
  return `Access request\nUser ID: ${userId}${usernameLine}${nameLine}\n\nReply to this message with /approve or send /approve ${userId}.`;
}

function extractRequesterId(replyToText: string | undefined): string {
  const match = replyToText?.match(/^User ID:\s*(\d+)$/im);
  return match?.[1] ?? '';
}

function textOnly(text: string): BotReply {
  return { text, buttons: [] };
}
```

- [ ] **Step 4: Run handler tests and verify pass**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "request|approve|unauthorized start"
```

Expected: PASS.

- [ ] **Step 5: Run existing handler tests to catch regressions**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "access control and pure handlers"
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

Run:

```bash
git add src/bot/handlers.ts test/debarment-bot.test.ts
git commit -m "feat: add telegram access request approvals"
```

---

### Task 5: Telegraf Routing and Notification Delivery

**Files:**
- Modify: `src/bot/createBot.ts`
- Test: covered by typecheck and handler tests from Task 4

- [ ] **Step 1: Update command routing in `createBot`**

In `src/bot/createBot.ts`, change the command list from:

```ts
  bot.command(['check', 'basic', 'full'], async (ctx) => {
    await replyToContext(ctx, await handler.handleMessage(ctx.message.text, ctx.from?.id));
  });
```

to:

```ts
  bot.command(['check', 'basic', 'full', 'request', 'approve'], async (ctx) => {
    await replyToContext(ctx, await handler.handleMessage(ctx.message.text, ctx.from?.id, metadataFromContext(ctx)));
  });
```

Also change the text handler from:

```ts
  bot.on('text', async (ctx) => {
    await replyToContext(ctx, await handler.handleMessage(ctx.message.text, ctx.from?.id));
  });
```

to:

```ts
  bot.on('text', async (ctx) => {
    await replyToContext(ctx, await handler.handleMessage(ctx.message.text, ctx.from?.id, metadataFromContext(ctx)));
  });
```

- [ ] **Step 2: Import metadata type**

Change the handler import line to:

```ts
import type { BotCommandHandler, BotMessageMetadata } from './handlers.js';
```

- [ ] **Step 3: Add metadata extraction helper**

Add this function above `replyToContext`:

```ts
function metadataFromContext(ctx: Context | NarrowedContext<Context, Update>): BotMessageMetadata {
  const from = ctx.from
    ? {
        id: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
      }
    : undefined;

  const message = 'message' in ctx && ctx.message && 'reply_to_message' in ctx.message ? ctx.message : undefined;
  const replyToMessage = message?.reply_to_message;
  const replyToText = replyToMessage && 'text' in replyToMessage ? replyToMessage.text : undefined;

  return { from, replyToText };
}
```

- [ ] **Step 4: Deliver notifications after replies**

At the end of `replyToContext`, after `await ctx.reply(reply.text, extra);`, add:

```ts
  for (const notification of reply.notifications ?? []) {
    try {
      await ctx.telegram.sendMessage(notification.chatId, notification.text);
    } catch (error: unknown) {
      console.warn(`Failed to send Telegram notification to ${notification.chatId}:`, error);
    }
  }
```

The final `replyToContext` should still reply with inline buttons exactly as before.

- [ ] **Step 5: Run typecheck for Telegraf typings**

Run:

```bash
npm run typecheck
```

Expected: PASS. If TypeScript narrows `reply_to_message` differently, keep the same returned metadata shape and adjust only the type guard in `metadataFromContext`.

- [ ] **Step 6: Commit Task 5**

Run:

```bash
git add src/bot/createBot.ts
git commit -m "feat: deliver telegram access notifications"
```

---

### Task 6: Runtime Wiring, Docs, and Git Ignore

**Files:**
- Modify: `src/index.ts`
- Modify: `.env.example`
- Modify: `.gitignore`
- Modify: `README.md`

- [ ] **Step 1: Wire repository and access control in `src/index.ts`**

Add this import:

```ts
import { ApprovedUsersRepository } from './data/approvedUsersRepository.js';
```

After loading `targetDetailsRepository`, add:

```ts
  console.info('Loading approved Telegram users:', config.approvedTelegramUsersPath);
  const approvedUsersRepository = await ApprovedUsersRepository.fromFile(config.approvedTelegramUsersPath);
  console.info('Loaded approved Telegram users:', { users: approvedUsersRepository.all().length });
```

Change handler construction from:

```ts
  const handler = new BotCommandHandler(service, createAccessControl(config.allowedTelegramUsers), {
    maxMessageChars: config.maxMessageChars,
  });
```

to:

```ts
  const accessControl = createAccessControl(config.allowedTelegramUsers, {
    adminTelegramUsers: config.adminTelegramUsers,
    approvedUsers: approvedUsersRepository,
  });
  const handler = new BotCommandHandler(service, accessControl, approvedUsersRepository, {
    maxMessageChars: config.maxMessageChars,
  });
```

- [ ] **Step 2: Update `.env.example`**

Change `.env.example` to include:

```dotenv
TELEGRAM_BOT_TOKEN=replace-me
ALLOWED_TELEGRAM_USERS=
ADMIN_TELEGRAM_USERS=replace-with-your-telegram-user-id
APPROVED_TELEGRAM_USERS_PATH=./approved-users.json
SENZING_PATH=./senzing.json
TARGETS_NESTED_PATH=./targets.nested.json
MAX_RESULTS=5
MAX_MESSAGE_CHARS=3800
```

- [ ] **Step 3: Ignore runtime approvals file**

Add this section to `.gitignore`:

```gitignore
# Runtime Telegram access state
approved-users.json
```

- [ ] **Step 4: Update README configuration docs**

In `README.md`, replace the current configuration environment block with:

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

Replace the access-control paragraph with:

```md
Access control supports three modes:

- Public: set `ALLOWED_TELEGRAM_USERS=*`.
- Static private: set `ALLOWED_TELEGRAM_USERS="123,456"`.
- Admin-approved: set `ADMIN_TELEGRAM_USERS="123"` and keep `APPROVED_TELEGRAM_USERS_PATH` pointed at a writable local JSON file. Unauthorized users can send `/request`; admins can approve with `/approve <telegram_user_id>` or by replying `/approve` to the bot's request notification.

The runtime `approved-users.json` file contains real Telegram user IDs and is ignored by git.
```

- [ ] **Step 5: Run build-focused validation**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both PASS.

- [ ] **Step 6: Commit Task 6**

Run:

```bash
git add src/index.ts .env.example .gitignore README.md
git commit -m "docs: document telegram admin approvals"
```

---

### Task 7: Full Regression and Final Verification

**Files:**
- No planned source edits
- Verification: whole repository

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS for all Vitest tests.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run production build**

Run:

```bash
npm run build
```

Expected: PASS and `dist/` is regenerated.

- [ ] **Step 4: Inspect git status**

Run:

```bash
git status --short
```

Expected: no uncommitted tracked changes. If `dist/` changes are untracked or ignored, do not commit generated output unless the repository already expects generated files to be committed for this change.

- [ ] **Step 5: Manual smoke test with fake token disabled by config test mode**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "admin can approve by id"
```

Expected: PASS, proving the core approval path updates the dynamic access lookup.

- [ ] **Step 6: Final implementation summary**

Report these items:

```md
Implemented Telegram admin approval access.

Changed files:
- src/data/approvedUsersRepository.ts
- src/domain/types.ts
- src/config.ts
- src/bot/accessControl.ts
- src/bot/handlers.ts
- src/bot/createBot.ts
- src/index.ts
- test/debarment-bot.test.ts
- .env.example
- .gitignore
- README.md

Validation:
- npm test: PASS
- npm run typecheck: PASS
- npm run build: PASS

Operational notes:
- Set ADMIN_TELEGRAM_USERS to Telegram numeric user IDs for admins.
- Keep approved-users.json writable by the bot process.
- Admins must start the bot once before Telegram allows bot-initiated direct messages to them.
```
