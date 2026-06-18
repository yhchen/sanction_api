import { beforeEach, describe, expect, test } from 'vitest';
import path from 'node:path';
import { normalizeName } from '../src/domain/normalize.js';
import { SenzingMemoryRepository } from '../src/data/senzingMemoryRepository.js';
import { TargetsNestedMemoryRepository } from '../src/data/targetsNestedMemoryRepository.js';
import { DebarmentService } from '../src/domain/debarmentService.js';
import { formatBasicResults, formatCheckResult, formatFullResults } from '../src/bot/formatters.js';
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
});

describe('repositories and debarment service', () => {
  test('loads senzing index by name and record id', async () => {
    const repo = await SenzingMemoryRepository.fromFile(senzingFixture);

    expect(repo.stats()).toMatchObject({ records: 5 });
    expect(repo.findByName('YATAI NEW CITY')[0]?.record.RECORD_ID).toBe('NK-223CQDBzp8MRkdJMDiqXn3');
    expect(repo.findByRecordId('NK-223CQDBzp8MRkdJMDiqXn3')?.URL).toContain('opensanctions.org');
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

  test('truncates long messages with a notice', async () => {
    const full = formatFullResults(await service.full('YATAI NEW CITY'), { maxMessageChars: 220 });

    expect(full.text.length).toBeLessThanOrEqual(220);
    expect(full.text).toContain('Output truncated');
  });
});

describe('access control and pure handlers', () => {
  test('supports whitelist and public wildcard', () => {
    expect(createAccessControl('*').isAllowed(undefined)).toBe(true);
    expect(createAccessControl('123, 456').isAllowed(123)).toBe(true);
    expect(createAccessControl('123, 456').isAllowed('789')).toBe(false);
    expect(createAccessControl('').isAllowed(123)).toBe(false);
  });

  test('plain text behaves as check and positive check includes action buttons', async () => {
    const handler = new BotCommandHandler(await buildService(), createAccessControl('*'));
    const reply = await handler.handleMessage('YATAI NEW CITY', 123);

    expect(reply.text.startsWith('Debarred')).toBe(true);
    expect(reply.buttons.flat()).toHaveLength(2);
  });

  test('start command is also protected by whitelist', async () => {
    const publicHandler = new BotCommandHandler(await buildService(), createAccessControl('*'));
    const privateHandler = new BotCommandHandler(await buildService(), createAccessControl('456'));

    await expect(publicHandler.handleStart(123)).resolves.toMatchObject({ text: expect.stringContaining('Send a complete name') });
    await expect(privateHandler.handleStart(123)).resolves.toMatchObject({ text: 'Unauthorized.' });
  });

  test('direct commands support check/basic/full and missing args', async () => {
    const handler = new BotCommandHandler(await buildService(), createAccessControl('*'));

    await expect(handler.handleMessage('/check YATAI NEW CITY', 123)).resolves.toMatchObject({ text: expect.stringMatching(/^Debarred/) });
    await expect(handler.handleMessage('/basic YATAI NEW CITY', 123)).resolves.toMatchObject({ text: expect.stringContaining('Basic Information') });
    await expect(handler.handleMessage('/full YATAI NEW CITY', 123)).resolves.toMatchObject({ text: expect.stringContaining('Sanctions Details') });
    await expect(handler.handleMessage('/check', 123)).resolves.toMatchObject({ text: 'Usage: /check <name>' });
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
});
