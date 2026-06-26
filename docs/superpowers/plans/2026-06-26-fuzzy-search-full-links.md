# Fuzzy Search Full Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace fuzzy search candidate `/basic N` and `/full N` inline buttons with per-row `Full` links that deep-link back into the bot and return full sanctions details.

**Architecture:** Add `TELEGRAM_BOT_USERNAME` configuration and pass it through formatter options. Fuzzy result formatting emits HTML links and no buttons; `/start full_<recordId>` reuses the existing authorized `fullByRecordId` lookup. The Telegram adapter sends `parse_mode: 'HTML'` only when a reply asks for it.

**Tech Stack:** TypeScript, Telegraf, Vitest, Telegram Bot deep links, existing `BotCommandHandler` and formatter pipeline.

---

## File Structure

- Modify `src/config.ts`: add `telegramBotUsername` to config and load `TELEGRAM_BOT_USERNAME`.
- Modify `src/index.ts`: pass bot username into `BotCommandHandler` formatter options.
- Modify `src/domain/types.ts`: add optional `parseMode` to `BotReply`.
- Modify `src/bot/formatters.ts`: add HTML escaping, deep-link building, and fuzzy row `Full` links; remove fuzzy candidate buttons.
- Modify `src/bot/handlers.ts`: parse `/start full_<recordId>` payloads and route to `fullByRecordId` after access control.
- Modify `src/bot/createBot.ts`: pass `/start` message text into `handleStart`; send optional parse mode in `ctx.reply`.
- Modify `test/debarment-bot.test.ts`: update formatter and handler behavior tests.
- Modify `test/package-scripts.test.ts`: cover config loading.
- Modify `.env.example` and `README.md`: document `TELEGRAM_BOT_USERNAME`.

## Task 1: Config, Reply Type, and Adapter Support

**Files:**
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/bot/createBot.ts`
- Test: `test/package-scripts.test.ts`

- [x] **Step 1: Write the failing config test**

Add to `test/package-scripts.test.ts`:

```ts
test('loads optional Telegram bot username for deep links', () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_BOT_USERNAME: 'ExampleDebarmentBot',
  }, { requireToken: true });

  expect(config.telegramBotUsername).toBe('ExampleDebarmentBot');
});
```

- [x] **Step 2: Run config test to verify it fails**

Run:

```bash
npm test -- test/package-scripts.test.ts -t "loads optional Telegram bot username for deep links"
```

Expected: FAIL because `telegramBotUsername` does not exist on `AppConfig`.

- [x] **Step 3: Write minimal config implementation**

In `src/config.ts`, add `telegramBotUsername: string;` to `AppConfig`.

Add this return field after `telegramBotToken`:

```ts
telegramBotUsername: env.TELEGRAM_BOT_USERNAME?.trim() ?? '',
```

In `src/index.ts`, pass it to formatter options:

```ts
const handler = new BotCommandHandler(service, accessControl, approvedUsersRepository, {
  maxMessageChars: config.maxMessageChars,
  telegramBotUsername: config.telegramBotUsername,
}, dataRefreshService);
```

- [x] **Step 4: Run config test to verify it passes**

Run:

```bash
npm test -- test/package-scripts.test.ts -t "loads optional Telegram bot username for deep links"
```

Expected: PASS.

- [x] **Step 5: Add reply parse mode type and adapter support**

In `src/domain/types.ts`, extend `BotReply`:

```ts
export interface BotReply {
  text: string;
  buttons: ReplyButton[][];
  notifications?: BotNotification[];
  parseMode?: 'HTML';
}
```

In `src/bot/createBot.ts`, update `replyToContext` so `parse_mode` is sent even when there are no buttons:

```ts
const extra = reply.buttons.length > 0 || reply.parseMode
  ? {
      parse_mode: reply.parseMode,
      reply_markup: reply.buttons.length > 0
        ? {
            inline_keyboard: reply.buttons.map((row) =>
              row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
            ),
          }
        : undefined,
    }
  : undefined;
```

- [x] **Step 6: Run focused checks**

Run:

```bash
npm test -- test/package-scripts.test.ts test/bot-menu.test.ts
npm run typecheck
```

Expected: PASS.

## Task 2: Fuzzy Formatter Full Links

**Files:**
- Modify: `src/bot/formatters.ts`
- Test: `test/debarment-bot.test.ts`

- [x] **Step 1: Write failing formatter tests**

Replace the fuzzy button assertions in `test/debarment-bot.test.ts` with:

```ts
test('formats fuzzy candidates with row-level full links and no candidate buttons', async () => {
  const formatted = formatFuzzySearchResult(await service.searchCandidates('Yatai Smart'), {
    telegramBotUsername: 'ExampleDebarmentBot',
  });

  expect(formatted.text).toMatch(/^Possible matches/);
  expect(formatted.text).toContain('YATAI SMART INDUSTRIAL NEW CITY');
  expect(formatted.text).toContain('<a href="https://t.me/ExampleDebarmentBot?start=full_NK-223CQDBzp8MRkdJMDiqXn3">Full</a>');
  expect(formatted.text).not.toMatch(/^Debarred/);
  expect(formatted.buttons).toEqual([]);
  expect(formatted.parseMode).toBe('HTML');
});

test('formats fuzzy candidates without invalid full links when bot username is missing', async () => {
  const formatted = formatFuzzySearchResult(await service.searchCandidates('Yatai Smart'));

  expect(formatted.text).toContain('YATAI SMART INDUSTRIAL NEW CITY');
  expect(formatted.text).not.toContain('https://t.me/');
  expect(formatted.buttons).toEqual([]);
  expect(formatted.parseMode).toBeUndefined();
});
```

Update the plain-text fuzzy handler assertion:

```ts
await expect(handler.handleMessage('Yatai Smart', 123)).resolves.toMatchObject({
  text: expect.stringMatching(/^Possible matches/),
  buttons: [],
});
```

- [x] **Step 2: Run formatter tests to verify they fail**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "formats fuzzy candidates"
```

Expected: FAIL because current fuzzy formatting still returns candidate buttons and no HTML full link.

- [x] **Step 3: Write minimal formatter implementation**

In `src/bot/formatters.ts`, extend options:

```ts
export interface FormatterOptions {
  maxMessageChars?: number;
  telegramBotUsername?: string;
}
```

Change fuzzy instruction text:

```ts
const hasFullLinks = Boolean(options.telegramBotUsername?.trim());
const fullLinkInstruction = hasFullLinks
  ? 'These are fuzzy name candidates, not a Debarred verdict. Tap Full to view sanctions details for a candidate.'
  : 'These are fuzzy name candidates, not a Debarred verdict. Use /full with the complete name for exact lookup.';
lines.push('', fullLinkInstruction);
```

Change each candidate line:

```ts
const fullLink = fullDeepLink(candidate.basic.recordId, options.telegramBotUsername);
const primaryName = hasFullLinks ? escapeHtml(candidate.basic.primaryName) : candidate.basic.primaryName;
lines.push('', `${index + 1}. ${primaryName}${fullLink ? `  ${fullLink}` : ''}`);
if (candidate.basic.matchedName !== candidate.basic.primaryName) {
  const matchedName = hasFullLinks ? escapeHtml(candidate.basic.matchedName) : candidate.basic.matchedName;
  lines.push(`   Matched Name: ${matchedName}`);
}
const recordId = hasFullLinks ? escapeHtml(candidate.basic.recordId) : candidate.basic.recordId;
const matchReason = hasFullLinks ? escapeHtml(candidate.matchReason) : candidate.matchReason;
lines.push(`   Record ID: ${recordId}`);
lines.push(`   Score: ${candidate.score.toFixed(2)} (${matchReason})`);
```

Return no fuzzy buttons:

```ts
return {
  text: truncateText(lines.join('\n'), options.maxMessageChars),
  buttons: [],
  parseMode: hasFullLinks ? 'HTML' : undefined,
};
```

Add helpers near the bottom:

```ts
function fullDeepLink(recordId: string, botUsername: string | undefined): string {
  const username = botUsername?.trim();
  const payload = `full_${recordId}`;
  if (!username || !isDeepLinkPayloadSafe(payload)) return '';
  const url = `https://t.me/${encodeURIComponent(username)}?start=${encodeURIComponent(payload)}`;
  return `<a href="${url}">Full</a>`;
}

function isDeepLinkPayloadSafe(payload: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/u.test(payload);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
```

Remove `candidateActionButtons` if unused.

- [x] **Step 4: Run formatter tests to verify they pass**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "formats fuzzy candidates"
```

Expected: PASS.

## Task 3: Start Payload Full Lookup

**Files:**
- Modify: `src/bot/handlers.ts`
- Modify: `src/bot/createBot.ts`
- Test: `test/debarment-bot.test.ts`

- [x] **Step 1: Write failing start payload tests**

Add to `test/debarment-bot.test.ts` near callback tests:

```ts
test('start full deep link returns full details by record id', async () => {
  const handler = new BotCommandHandler(await buildService(), createAccessControl('*'));

  await expect(handler.handleStart(123, 'full_NK-223CQDBzp8MRkdJMDiqXn3')).resolves.toMatchObject({
    text: expect.stringContaining('Sanctions Details'),
  });
});

test('start full deep link enforces access control', async () => {
  const handler = new BotCommandHandler(await buildService(), createAccessControl('456'));

  await expect(handler.handleStart(123, 'full_NK-223CQDBzp8MRkdJMDiqXn3')).resolves.toMatchObject({
    text: 'Unauthorized.',
  });
});

test('start ignores malformed full deep link payloads without crashing', async () => {
  const handler = new BotCommandHandler(await buildService(), createAccessControl('*'));

  await expect(handler.handleStart(123, 'full_')).resolves.toMatchObject({
    text: expect.stringContaining('Send a name to search candidates'),
  });
});
```

- [x] **Step 2: Run start payload tests to verify they fail**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "start full deep link"
```

Expected: FAIL because `handleStart` currently accepts only `userId`.

- [x] **Step 3: Implement handler start payload**

In `src/bot/handlers.ts`, change `handleStart` signature:

```ts
async handleStart(userId: string | number | undefined, payload = ''): Promise<BotReply> {
```

After access control succeeds, route full payloads:

```ts
const fullRecordId = parseFullStartPayload(payload);
if (fullRecordId) return formatFullResults(await this.service.fullByRecordId(fullRecordId), this.formatterOptions);
```

Add helper:

```ts
function parseFullStartPayload(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed.startsWith('full_')) return '';
  const recordId = trimmed.slice('full_'.length).trim();
  return /^[A-Za-z0-9_-]{1,59}$/u.test(recordId) ? recordId : '';
}
```

- [x] **Step 4: Forward start payload from Telegraf**

In `src/bot/createBot.ts`, update start handling:

```ts
bot.start(async (ctx) => {
  const payload = 'text' in ctx.message ? ctx.message.text.replace(/^\/start(?:@\w+)?\s*/iu, '').trim() : '';
  await replyToContext(ctx, await handler.handleStart(ctx.from?.id, payload));
});
```

- [x] **Step 5: Run start payload tests to verify they pass**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "start full deep link"
```

Expected: PASS.

## Task 4: Integration Cleanup, Docs, and Full Verification

**Files:**
- Modify: `test/debarment-bot.test.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-06-26-fuzzy-search-full-links.md`

- [x] **Step 1: Update remaining fuzzy button tests**

Search:

```bash
rg -n "candidate buttons|/basic 1|/full 1|buttons\\.flat\\(\\)|fuzzy candidate callbacks" test/debarment-bot.test.ts
```

Replace fuzzy-specific expectations with:

```ts
expect(reply.buttons).toEqual([]);
```

Keep exact-result callback tests unchanged.

- [x] **Step 2: Run all bot tests**

Run:

```bash
npm test -- test/debarment-bot.test.ts test/bot-menu.test.ts
```

Expected: PASS.

- [x] **Step 3: Document configuration**

Add to `.env.example`:

```text
TELEGRAM_BOT_USERNAME=
```

Add to the README environment table:

```markdown
| `TELEGRAM_BOT_USERNAME` | empty | Bot username used to render clickable `Full` links in fuzzy search results. Example: `ExampleDebarmentBot`. |
```

Add to the search behavior section:

```markdown
When `TELEGRAM_BOT_USERNAME` is configured, `/search` and plain-text fuzzy results include a per-candidate `Full` link. Tapping it opens the bot deep link and returns the full sanctions details for that record.
```

- [x] **Step 4: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git status --short
```

Expected:

- `npm test`: 6 files pass.
- `npm run typecheck`: exits 0.
- `npm run build`: exits 0.
- `git status --short`: only intended source, test, docs, and plan files are modified.

- [x] **Step 5: Commit implementation**

Run:

```bash
git add src/config.ts src/index.ts src/domain/types.ts src/bot/formatters.ts src/bot/handlers.ts src/bot/createBot.ts test/debarment-bot.test.ts test/package-scripts.test.ts .env.example README.md docs/superpowers/plans/2026-06-26-fuzzy-search-full-links.md
git commit -m "feat: add fuzzy search full links"
```

Expected: commit succeeds on branch `feature/fuzzy-search-full-links`.

## Self-Review

- Spec coverage: tasks cover bot username config, fuzzy row-level full links, no fuzzy candidate buttons, `/start full_<recordId>` lookup, access control, malformed payloads, docs, and verification.
- Placeholder scan: no TBD/TODO/fill-in instructions remain.
- Type consistency: plan consistently uses `FormatterOptions.telegramBotUsername`, `BotReply.parseMode`, `handleStart(userId, payload)`, and `fullByRecordId(recordId)`.
