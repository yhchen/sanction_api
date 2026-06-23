import { beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeName } from '../src/domain/normalize.js';
import { ApprovedUsersRepository } from '../src/data/approvedUsersRepository.js';
import { SenzingMemoryRepository } from '../src/data/senzingMemoryRepository.js';
import { TargetsNestedMemoryRepository } from '../src/data/targetsNestedMemoryRepository.js';
import { DebarmentService } from '../src/domain/debarmentService.js';
import { formatBasicResults, formatCheckResult, formatFullResults, formatFuzzySearchResult } from '../src/bot/formatters.js';
import { createAccessControl } from '../src/bot/accessControl.js';
import { BotCommandHandler } from '../src/bot/handlers.js';
import { loadConfig } from '../src/config.js';

const fixturesDir = path.join(process.cwd(), 'test/fixtures');
const senzingFixture = path.join(fixturesDir, 'senzing.fixture.jsonl');
const targetsFixture = path.join(fixturesDir, 'targets.nested.fixture.jsonl');

async function buildService(maxResults = 5) {
  const senzing = await SenzingMemoryRepository.fromFile(senzingFixture);
  const targets = await TargetsNestedMemoryRepository.fromFile(targetsFixture);
  return new DebarmentService(senzing, targets, { maxResults });
}

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

interface ApprovalAccessControlOptions {
  adminTelegramUsers?: string;
  approvedUsers?: InMemoryApprovedUsers;
}

function createApprovalAccessControl(whitelist: string, options: ApprovalAccessControlOptions) {
  return (createAccessControl as unknown as (whitelist: string, options: ApprovalAccessControlOptions) => ReturnType<typeof createAccessControl>)(
    whitelist,
    options,
  );
}

interface ApprovalHandler {
  handleStart(userId: string | number | undefined): Promise<BotReplyWithNotifications>;
  handleMessage(rawMessage: string, userId: string | number | undefined, metadata?: unknown): Promise<BotReplyWithNotifications>;
}

interface BotReplyWithNotifications {
  text: string;
  buttons: Array<Array<{ text: string; callbackData: string }>>;
  notifications?: Array<{ chatId: string; text: string }>;
}

function createApprovalHandler(
  service: DebarmentService,
  accessControl: ReturnType<typeof createAccessControl>,
  approvedUsers: InMemoryApprovedUsers,
): ApprovalHandler {
  const Handler = BotCommandHandler as unknown as new (
    service: DebarmentService,
    accessControl: ReturnType<typeof createAccessControl>,
    approvedUsers: InMemoryApprovedUsers,
  ) => ApprovalHandler;
  return new Handler(service, accessControl, approvedUsers);
}

describe('normalized exact matching', () => {
  test('normalizes case, punctuation, unicode width and whitespace', () => {
    expect(normalizeName('  MYANMAR YATAI INTERNATIONAL HOLDING GROUP CO., LTD.  ')).toBe(
      normalizeName('myanmar  yatai international holding group co ltd'),
    );
    expect(normalizeName('ＹＡＴＡＩ　ＮＥＷ　ＣＩＴＹ')).toBe(normalizeName('yatai new city'));
  });

  test('matches complete primary or alias names, not partial names', async () => {
    const service = await buildService();

    await expect(service.check('YATAI SMART INDUSTRIAL NEW CITY')).resolves.toMatchObject({ found: true });
    await expect(service.check('YATAI NEW CITY')).resolves.toMatchObject({ found: true });
    await expect(service.check('MYANMAR YATAI INTERNATIONAL HOLDING GROUP CO LTD')).resolves.toMatchObject({ found: true });
    await expect(service.check('Yatai Smart')).resolves.toMatchObject({ found: false, matches: [] });
  });

  test('does not report non-debarment exact matches as Debarred', async () => {
    const service = await buildService();

    await expect(service.check('HARMLESS SHIPPING LTD')).resolves.toMatchObject({ found: false, matches: [] });
  });

  test('searches fuzzy debarment candidates without changing exact matching', async () => {
    const service = await buildService();

    await expect(service.searchCandidates('Yatai Smart')).resolves.toMatchObject({
      found: true,
      candidates: [
        { basic: { primaryName: 'YATAI SMART INDUSTRIAL NEW CITY' } },
      ],
    });
    await expect(service.check('Yatai Smart')).resolves.toMatchObject({ found: false, matches: [] });
    await expect(service.searchCandidates('HARMLESS SHIPPING LTD')).resolves.toMatchObject({ found: false, candidates: [] });
    await expect(service.searchCandidates('HPA-AN CITY')).resolves.toMatchObject({ found: false, candidates: [] });
    await expect(service.searchCandidates('PW2XZT68KVW9')).resolves.toMatchObject({ found: false, candidates: [] });
  });

  test('caps fuzzy candidate results and marks truncation', async () => {
    const service = await buildService(1);

    await expect(service.searchCandidates('DUPLICATE EXACT LIMITED')).resolves.toMatchObject({
      found: true,
      candidates: [{ basic: { recordId: 'NK-DUP-1' } }],
      totalCandidates: 3,
      truncated: true,
    });
  });
});


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
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(`{
  "approvedUserIds": [
    "123"
  ]
}\n`);
  });

  test('loads existing approved users and keeps approvals idempotent', async () => {
    const filePath = await tempApprovedUsersPath();
    await fs.writeFile(filePath, '{"approvedUserIds":["456"]}\n', 'utf8');
    const repo = await ApprovedUsersRepository.fromFile(filePath);

    expect(repo.has('456')).toBe(true);
    await expect(repo.approve('456')).resolves.toEqual({ userId: '456', alreadyApproved: true });
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(`{
  "approvedUserIds": [
    "456"
  ]
}\n`);
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

describe('repositories and debarment service', () => {
  test('loads senzing index by name and record id', async () => {
    const repo = await SenzingMemoryRepository.fromFile(senzingFixture);

    expect(repo.stats()).toMatchObject({ records: 5 });
    expect(repo.findByName('YATAI NEW CITY')[0]?.record.RECORD_ID).toBe('NK-223CQDBzp8MRkdJMDiqXn3');
    expect(repo.findByRecordId('NK-223CQDBzp8MRkdJMDiqXn3')?.URL).toContain('opensanctions.org');
  });

  test('finds fuzzy candidates by partial names only', async () => {
    const repo = await SenzingMemoryRepository.fromFile(senzingFixture);

    expect(repo.findCandidateNames('Yatai Smart')[0]).toMatchObject({
      matchedName: 'YATAI SMART INDUSTRIAL NEW CITY',
      record: { RECORD_ID: 'NK-223CQDBzp8MRkdJMDiqXn3' },
    });
    expect(repo.findCandidateNames('HPA-AN CITY')).toEqual([]);
    expect(repo.findCandidateNames('PW2XZT68KVW9')).toEqual([]);
  });

  test('joins targets.nested details for full output', async () => {
    const service = await buildService();
    const result = await service.full('YATAI NEW CITY');

    expect(result.found).toBe(true);
    expect(result.matches[0]?.sanctions[0]?.authority).toEqual(['OFAC']);
  });

  test('caps duplicate exact-name results and marks truncation', async () => {
    const service = await buildService(2);
    const result = await service.check('DUPLICATE EXACT LIMITED');

    expect(result.totalMatches).toBe(3);
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

describe('formatters', () => {
  let service: DebarmentService;

  beforeEach(async () => {
    service = await buildService(2);
  });

  test('formats check miss exactly as No Data Found', async () => {
    expect(formatCheckResult(await service.check('missing')).text).toBe('No Data Found!');
  });

  test('formats check hit with Debarred first and basic/full buttons', async () => {
    const formatted = formatCheckResult(await service.check('YATAI NEW CITY'));

    expect(formatted.text.startsWith('Debarred')).toBe(true);
    expect(formatted.buttons.flat().map((button) => button.callbackData)).toEqual([
      'basic:NK-223CQDBzp8MRkdJMDiqXn3',
      'full:NK-223CQDBzp8MRkdJMDiqXn3',
    ]);
  });

  test('formats basic and full human-readable sections', async () => {
    const basic = formatBasicResults(await service.basic('YATAI NEW CITY'));
    const full = formatFullResults(await service.full('YATAI NEW CITY'));

    expect(basic.text).toContain('Basic Information');
    expect(basic.text).toContain('Matched Name: YATAI NEW CITY');
    expect(basic.text).toContain('OpenSanctions URL: https://www.opensanctions.org/entities/NK-223CQDBzp8MRkdJMDiqXn3');
    expect(full.text).toContain('Sanctions Details');
    expect(full.text).toContain('Authority: OFAC');
    expect(full.text).toContain('Program: Reciprocal');
  });

  test('formats duplicate cap notice', async () => {
    const formatted = formatBasicResults(await service.basic('DUPLICATE EXACT LIMITED'));

    expect(formatted.text).toContain('Showing 2 of 3 matches');
  });

  test('formats fuzzy candidates without Debarred verdict language', async () => {
    const formatted = formatFuzzySearchResult(await service.searchCandidates('Yatai Smart'));

    expect(formatted.text).toMatch(/^Possible matches/);
    expect(formatted.text).toContain('YATAI SMART INDUSTRIAL NEW CITY');
    expect(formatted.text).not.toMatch(/^Debarred/);
  });

  test('formats fuzzy misses distinctly from exact No Data Found', async () => {
    expect(formatFuzzySearchResult(await service.searchCandidates('missing')).text).toBe('No close name candidates found. Try a more complete name.');
  });

  test('formats capped fuzzy candidate results', async () => {
    const limitedService = await buildService(1);
    const formatted = formatFuzzySearchResult(await limitedService.searchCandidates('DUPLICATE EXACT LIMITED'));

    expect(formatted.text).toContain('Showing 1 of 3 candidates');
  });

  test('truncates long messages with a notice', async () => {
    const full = formatFullResults(await service.full('YATAI NEW CITY'), { maxMessageChars: 220 });

    expect(full.text.length).toBeLessThanOrEqual(220);
    expect(full.text).toContain('Output truncated');
  });
});

describe('access control and pure handlers', () => {
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

  test('plain text runs fuzzy search, even for exact full names', async () => {
    const handler = new BotCommandHandler(await buildService(), createAccessControl('*'));

    await expect(handler.handleMessage('Yatai Smart', 123)).resolves.toMatchObject({
      text: expect.stringMatching(/^Possible matches/),
    });
    const exactNameReply = await handler.handleMessage('YATAI SMART INDUSTRIAL NEW CITY', 123);
    expect(exactNameReply.text).toMatch(/^Possible matches/);
    expect(exactNameReply.text).not.toMatch(/^Debarred/);
    expect(exactNameReply.buttons.flat()).toHaveLength(0);
  });

  test('unauthorized start shows request instructions and user id', async () => {
    const approvedUsers = new InMemoryApprovedUsers();
    const handler = createApprovalHandler(
      await buildService(),
      createApprovalAccessControl('', { adminTelegramUsers: '456', approvedUsers }),
      approvedUsers,
    );

    await expect(handler.handleStart(123)).resolves.toMatchObject({
      text: 'Unauthorized. Your Telegram user id is 123. Send /request to ask an admin for access.',
    });
  });

  test('request notifies configured admins with requester details', async () => {
    const approvedUsers = new InMemoryApprovedUsers();
    const handler = createApprovalHandler(
      await buildService(),
      createApprovalAccessControl('', { adminTelegramUsers: '456, 789', approvedUsers }),
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
    const handler = createApprovalHandler(
      await buildService(),
      createApprovalAccessControl('', { approvedUsers }),
      approvedUsers,
    );

    const reply = await handler.handleMessage('/request', 123);

    expect(reply).toMatchObject({
      text: 'No admins are configured. Ask the bot operator to set ADMIN_TELEGRAM_USERS.',
    });
    expect(reply.notifications).toBeUndefined();
  });

  test('admin can approve by id and approved user is notified', async () => {
    const approvedUsers = new InMemoryApprovedUsers();
    const accessControl = createApprovalAccessControl('', { adminTelegramUsers: '456', approvedUsers });
    const handler = createApprovalHandler(await buildService(), accessControl, approvedUsers);

    const reply = await handler.handleMessage('/approve 123', 456);

    expect(reply).toMatchObject({
      text: 'Approved user 123.',
      notifications: [{ chatId: '123', text: 'Access approved. You can now send a name to search candidates or use /check <name>.' }],
    });
    expect(accessControl.isAllowed(123)).toBe(true);
  });

  test('admin approve is idempotent and rejects invalid input', async () => {
    const approvedUsers = new InMemoryApprovedUsers(['123']);
    const handler = createApprovalHandler(
      await buildService(),
      createApprovalAccessControl('', { adminTelegramUsers: '456', approvedUsers }),
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
    const handler = createApprovalHandler(
      await buildService(),
      createApprovalAccessControl('', { adminTelegramUsers: '456', approvedUsers }),
      approvedUsers,
    );

    await expect(handler.handleMessage('/approve 123', 999)).resolves.toMatchObject({ text: 'Unauthorized.' });
    expect(approvedUsers.has('123')).toBe(false);
  });

  test('admin can approve by replying to a request notification', async () => {
    const approvedUsers = new InMemoryApprovedUsers();
    const handler = createApprovalHandler(
      await buildService(),
      createApprovalAccessControl('', { adminTelegramUsers: '456', approvedUsers }),
      approvedUsers,
    );

    await expect(
      handler.handleMessage('/approve', 456, {
        replyToText: 'Access request\nUser ID: 123\nUsername: @alice\nName: Alice Example\n\nReply to this message with /approve or send /approve 123.',
      }),
    ).resolves.toMatchObject({ text: 'Approved user 123.' });
    expect(approvedUsers.has('123')).toBe(true);
  });

  test('start command is also protected by whitelist', async () => {
    const publicHandler = new BotCommandHandler(await buildService(), createAccessControl('*'));
    const privateHandler = new BotCommandHandler(await buildService(), createAccessControl('456'));

    await expect(publicHandler.handleStart(123)).resolves.toMatchObject({ text: expect.stringContaining('Send a name to search candidates') });
    await expect(privateHandler.handleStart(123)).resolves.toMatchObject({ text: 'Unauthorized.' });
  });

  test('direct commands support check/basic/full with arguments', async () => {
    const handler = new BotCommandHandler(await buildService(), createAccessControl('*'));

    await expect(handler.handleMessage('/check YATAI NEW CITY', 123)).resolves.toMatchObject({ text: expect.stringMatching(/^Debarred/) });
    await expect(handler.handleMessage('/basic YATAI NEW CITY', 123)).resolves.toMatchObject({ text: expect.stringContaining('Basic Information') });
    await expect(handler.handleMessage('/full YATAI NEW CITY', 123)).resolves.toMatchObject({ text: expect.stringContaining('Sanctions Details') });
    await expect(handler.handleMessage('/check YATAI SMART INDUSTRIAL NEW CITY', 123)).resolves.toMatchObject({ text: expect.stringMatching(/^Debarred/) });
    await expect(handler.handleMessage('/check Yatai Smart', 123)).resolves.toMatchObject({ text: 'No Data Found!' });
    await expect(handler.handleMessage('/basic Yatai Smart', 123)).resolves.toMatchObject({ text: 'No Data Found!' });
    await expect(handler.handleMessage('/full Yatai Smart', 123)).resolves.toMatchObject({ text: 'No Data Found!' });
  });

  test('search command and no-argument search run fuzzy candidates', async () => {
    const handler = new BotCommandHandler(await buildService(), createAccessControl('*'));

    await expect(handler.handleMessage('/search Yatai Smart', 123)).resolves.toMatchObject({ text: expect.stringMatching(/^Possible matches/) });
    await expect(handler.handleMessage('/search HPA-AN CITY', 123)).resolves.toMatchObject({ text: 'No close name candidates found. Try a more complete name.' });
    await expect(handler.handleMessage('/search', 123)).resolves.toMatchObject({ text: 'Send a name or partial name to search candidates, or /cancel.' });
    await expect(handler.handleMessage('Yatai Smart', 123)).resolves.toMatchObject({ text: expect.stringMatching(/^Possible matches/) });
  });

  test('no-argument check waits for the next text and then clears', async () => {
    const handler = new BotCommandHandler(await buildService(), createAccessControl('*'));

    await expect(handler.handleMessage('/check', 123)).resolves.toMatchObject({
      text: 'Send the complete name to run /check, or /cancel.',
    });
    await expect(handler.handleMessage('YATAI NEW CITY', 123)).resolves.toMatchObject({ text: expect.stringMatching(/^Debarred/) });

    await expect(handler.handleMessage('/check', 123)).resolves.toMatchObject({
      text: 'Send the complete name to run /check, or /cancel.',
    });
    await expect(handler.handleMessage('Yatai Smart', 123)).resolves.toMatchObject({ text: 'No Data Found!' });
    await expect(handler.handleMessage('YATAI NEW CITY', 123)).resolves.toMatchObject({ text: expect.stringMatching(/^Possible matches/) });
  });

  test('no-argument basic and full wait for their own next text', async () => {
    const handler = new BotCommandHandler(await buildService(), createAccessControl('*'));

    await expect(handler.handleMessage('/basic', 123)).resolves.toMatchObject({
      text: 'Send the complete name to run /basic, or /cancel.',
    });
    await expect(handler.handleMessage('YATAI NEW CITY', 123)).resolves.toMatchObject({ text: expect.stringContaining('Basic Information') });

    await expect(handler.handleMessage('/full', 123)).resolves.toMatchObject({
      text: 'Send the complete name to run /full, or /cancel.',
    });
    await expect(handler.handleMessage('YATAI NEW CITY', 123)).resolves.toMatchObject({ text: expect.stringContaining('Sanctions Details') });
  });

  test('new no-argument query commands replace the pending mode', async () => {
    const handler = new BotCommandHandler(await buildService(), createAccessControl('*'));

    await expect(handler.handleMessage('/basic', 123)).resolves.toMatchObject({
      text: 'Send the complete name to run /basic, or /cancel.',
    });
    await expect(handler.handleMessage('/full', 123)).resolves.toMatchObject({
      text: 'Send the complete name to run /full, or /cancel.',
    });
    await expect(handler.handleMessage('YATAI NEW CITY', 123)).resolves.toMatchObject({ text: expect.stringContaining('Sanctions Details') });
  });

  test('cancel clears a pending query mode', async () => {
    const handler = new BotCommandHandler(await buildService(), createAccessControl('*'));

    await expect(handler.handleMessage('/full', 123)).resolves.toMatchObject({
      text: 'Send the complete name to run /full, or /cancel.',
    });
    await expect(handler.handleMessage('/cancel', 123)).resolves.toMatchObject({ text: 'Cancelled.' });
    await expect(handler.handleMessage('YATAI NEW CITY', 123)).resolves.toMatchObject({ text: expect.stringMatching(/^Possible matches/) });
  });

  test('start clears a pending query mode', async () => {
    const handler = new BotCommandHandler(await buildService(), createAccessControl('*'));

    await expect(handler.handleMessage('/full', 123)).resolves.toMatchObject({
      text: 'Send the complete name to run /full, or /cancel.',
    });
    await expect(handler.handleStart(123)).resolves.toMatchObject({ text: expect.stringContaining('Send a name to search candidates') });
    await expect(handler.handleMessage('YATAI NEW CITY', 123)).resolves.toMatchObject({ text: expect.stringMatching(/^Possible matches/) });
  });

  test('callbacks fetch basic/full by record id', async () => {
    const handler = new BotCommandHandler(await buildService(), createAccessControl('*'));

    await expect(handler.handleCallback('basic:NK-223CQDBzp8MRkdJMDiqXn3', 123)).resolves.toMatchObject({ text: expect.stringContaining('Basic Information') });
    await expect(handler.handleCallback('full:NK-223CQDBzp8MRkdJMDiqXn3', 123)).resolves.toMatchObject({ text: expect.stringContaining('Sanctions Details') });
  });

  test('callbacks reject unauthorized and malformed actions', async () => {
    const privateHandler = new BotCommandHandler(await buildService(), createAccessControl('456'));
    const publicHandler = new BotCommandHandler(await buildService(), createAccessControl('*'));

    await expect(privateHandler.handleCallback('full:NK-223CQDBzp8MRkdJMDiqXn3', 123)).resolves.toMatchObject({ text: 'Unauthorized.' });
    await expect(publicHandler.handleCallback('broken', 123)).resolves.toMatchObject({ text: 'Invalid action.' });
    await expect(publicHandler.handleCallback('delete:NK-223CQDBzp8MRkdJMDiqXn3', 123)).resolves.toMatchObject({ text: 'Invalid action.' });
  });

  test('blocks unauthorized users before queries', async () => {
    const handler = new BotCommandHandler(await buildService(), createAccessControl('456'));

    await expect(handler.handleMessage('/full YATAI NEW CITY', 123)).resolves.toMatchObject({ text: 'Unauthorized.' });
  });
});

describe('config', () => {
  test('loads env config without hard-coded token and validates required token', () => {
    expect(() => loadConfig({}, { requireToken: true })).toThrow(/TELEGRAM_BOT_TOKEN/);

    expect(
      loadConfig(
        {
          TELEGRAM_BOT_TOKEN: 'token',
          SENZING_PATH: 'senzing.json',
          TARGETS_NESTED_PATH: 'targets.nested.json',
          ALLOWED_TELEGRAM_USERS: '123',
          MAX_RESULTS: '7',
          MAX_MESSAGE_CHARS: '1234',
        },
        { requireToken: true },
      ),
    ).toMatchObject({
      telegramBotToken: 'token',
      allowedTelegramUsers: '123',
      maxResults: 7,
      maxMessageChars: 1234,
    });

    expect(() =>
      loadConfig(
        {
          TELEGRAM_BOT_TOKEN: 'token',
          MAX_MESSAGE_CHARS: '4097',
        },
        { requireToken: true },
      ),
    ).toThrow(/MAX_MESSAGE_CHARS/);

    expect(() =>
      loadConfig(
        {
          TELEGRAM_BOT_TOKEN: 'token',
          MAX_RESULTS: '5abc',
        },
        { requireToken: true },
      ),
    ).toThrow(/MAX_RESULTS/);

    expect(() =>
      loadConfig(
        {
          TELEGRAM_BOT_TOKEN: 'token',
          MAX_MESSAGE_CHARS: '10.5',
        },
        { requireToken: true },
      ),
    ).toThrow(/MAX_MESSAGE_CHARS/);
  });


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
});
