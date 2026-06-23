# Fuzzy Search Detail Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add `/basic N` and `/full N` inline buttons to fuzzy search candidates and show up to 10 fuzzy candidates without changing exact lookup result caps.

**Architecture:** Keep Telegram callback handling unchanged by reusing existing `basic:<recordId>` and `full:<recordId>` callback data. Split service limits into exact-match `maxResults` and fuzzy candidate `maxCandidateResults`, with fuzzy search defaulting to 10. Add focused Vitest coverage first, then implement minimal formatter and service changes.

**Tech Stack:** TypeScript, Telegraf reply model, Vitest, Node.js ESM.

---

## File Structure

- Modify `src/domain/debarmentService.ts`: add `maxCandidateResults` option/default and use it only in `searchCandidateNames`.
- Modify `src/bot/formatters.ts`: add fuzzy candidate action buttons to `formatFuzzySearchResult`.
- Modify `test/debarment-bot.test.ts`: add failing coverage for fuzzy buttons, callback behavior, and fuzzy cap 10.
- No change to `src/bot/handlers.ts` or `src/bot/createBot.ts`: existing callback paths already support `basic:<recordId>` and `full:<recordId>`.

## Task 1: Add Failing Tests For Fuzzy Detail Buttons

**Files:**
- Modify: `test/debarment-bot.test.ts`

- [x] **Step 1: Update formatter test for fuzzy candidate buttons**

In `test/debarment-bot.test.ts`, update the existing `formats fuzzy candidates without Debarred verdict language` test to assert button rows:

```ts
  test('formats fuzzy candidates without Debarred verdict language', async () => {
    const formatted = formatFuzzySearchResult(await service.searchCandidates('Yatai Smart'));

    expect(formatted.text).toMatch(/^Possible matches/);
    expect(formatted.text).toContain('YATAI SMART INDUSTRIAL NEW CITY');
    expect(formatted.text).not.toMatch(/^Debarred/);
    expect(formatted.buttons).toEqual([
      [
        { text: '/basic 1', callbackData: 'basic:NK-223CQDBzp8MRkdJMDiqXn3' },
        { text: '/full 1', callbackData: 'full:NK-223CQDBzp8MRkdJMDiqXn3' },
      ],
    ]);
  });
```

- [x] **Step 2: Update fuzzy miss test for no buttons**

In `test/debarment-bot.test.ts`, replace the existing fuzzy miss assertion with:

```ts
  test('formats fuzzy misses distinctly from exact No Data Found', async () => {
    expect(formatFuzzySearchResult(await service.searchCandidates('missing'))).toEqual({
      text: 'No close name candidates found. Try a more complete name.',
      buttons: [],
    });
  });
```

- [x] **Step 3: Update plain-text fuzzy handler test for buttons**

In `test/debarment-bot.test.ts`, update the `plain text runs fuzzy search, even for exact full names` test to assert that both fuzzy replies include buttons:

```ts
  test('plain text runs fuzzy search, even for exact full names', async () => {
    const handler = new BotCommandHandler(await buildService(), createAccessControl('*'));

    await expect(handler.handleMessage('Yatai Smart', 123)).resolves.toMatchObject({
      text: expect.stringMatching(/^Possible matches/),
      buttons: [[
        { text: '/basic 1', callbackData: 'basic:NK-223CQDBzp8MRkdJMDiqXn3' },
        { text: '/full 1', callbackData: 'full:NK-223CQDBzp8MRkdJMDiqXn3' },
      ]],
    });
    const exactNameReply = await handler.handleMessage('YATAI SMART INDUSTRIAL NEW CITY', 123);
    expect(exactNameReply.text).toMatch(/^Possible matches/);
    expect(exactNameReply.text).not.toMatch(/^Debarred/);
    expect(exactNameReply.buttons.flat()).toHaveLength(2);
  });
```

- [x] **Step 4: Add callback detail tests**

In `test/debarment-bot.test.ts`, after `search command and no-argument search run fuzzy candidates`, add:

```ts
  test('fuzzy candidate callbacks return basic and full details by record id', async () => {
    const handler = new BotCommandHandler(await buildService(), createAccessControl('*'));
    const searchReply = await handler.handleMessage('/search Yatai Smart', 123);
    const [basicButton, fullButton] = searchReply.buttons[0] ?? [];

    expect(basicButton).toEqual({ text: '/basic 1', callbackData: 'basic:NK-223CQDBzp8MRkdJMDiqXn3' });
    expect(fullButton).toEqual({ text: '/full 1', callbackData: 'full:NK-223CQDBzp8MRkdJMDiqXn3' });

    await expect(handler.handleCallback(basicButton.callbackData, 123)).resolves.toMatchObject({
      text: expect.stringContaining('Basic Information'),
    });
    await expect(handler.handleCallback(fullButton.callbackData, 123)).resolves.toMatchObject({
      text: expect.stringContaining('Sanctions Details'),
    });
  });
```

- [x] **Step 5: Run targeted tests and verify failure**

Run:

```bash
npm test -- test/debarment-bot.test.ts
```

Expected: FAIL before implementation because fuzzy search replies currently have no buttons and fuzzy cap still defaults to 5.

## Task 2: Add Failing Tests For Fuzzy Candidate Cap 10

**Files:**
- Modify: `test/debarment-bot.test.ts`

- [x] **Step 1: Update test fixture helper to allow default and explicit service options**

Change the helper signature near the top of `test/debarment-bot.test.ts` from:

```ts
async function buildService(maxResults = 5) {
  const senzing = await SenzingMemoryRepository.fromFile(fixturePath('senzing.fixture.jsonl'));
  const targets = await TargetsNestedMemoryRepository.fromFile(fixturePath('targets.nested.fixture.jsonl'));
  return new DebarmentService(senzing, targets, { maxResults });
}
```

to:

```ts
async function buildService(options: DebarmentServiceOptions = {}) {
  const senzing = await SenzingMemoryRepository.fromFile(fixturePath('senzing.fixture.jsonl'));
  const targets = await TargetsNestedMemoryRepository.fromFile(fixturePath('targets.nested.fixture.jsonl'));
  return new DebarmentService(senzing, targets, options);
}
```

- [x] **Step 2: Import the service options type**

Change the `DebarmentService` import at the top of `test/debarment-bot.test.ts` from:

```ts
import { DebarmentService } from '../src/domain/debarmentService.js';
```

to:

```ts
import { DebarmentService, type DebarmentServiceOptions } from '../src/domain/debarmentService.js';
```

- [x] **Step 3: Update existing helper call sites**

Replace existing calls that pass a numeric max result for exact-result tests:

```ts
await buildService(2)
```

with:

```ts
await buildService({ maxResults: 2 })
```

Replace existing calls that pass a numeric max result for fuzzy candidate truncation:

```ts
await buildService(1)
```

with an explicit fuzzy cap when the test is about fuzzy candidate truncation:

```ts
await buildService({ maxCandidateResults: 1 })
```

Do not change plain `await buildService()` call sites.

- [x] **Step 4: Add a repository stub test for default fuzzy cap 10**

In the `normalized exact matching` describe block, after `caps fuzzy candidate results and marks truncation`, add:

```ts
  test('defaults fuzzy candidate cap to 10 without changing exact match cap', async () => {
    const baseService = await buildService();
    const duplicateRecord = (await baseService.searchCandidates('DUPLICATE EXACT LIMITED')).candidates[0]?.record;
    if (!duplicateRecord) throw new Error('Fixture missing duplicate debarment record.');

    const repeatedMatch = { record: duplicateRecord, matchedName: 'DUPLICATE EXACT LIMITED', matchedNameType: 'PRIMARY' };
    const repository = {
      findByName: () => Array.from({ length: 12 }, () => repeatedMatch),
      findCandidateNames: () => Array.from({ length: 12 }, (_, index) => ({
        record: { ...duplicateRecord, RECORD_ID: `NK-CAP-${index + 1}` },
        matchedName: `CAP CANDIDATE ${index + 1}`,
        matchedNameType: 'PRIMARY',
        score: 0.9,
        matchReason: 'similar-name',
      })),
      findByRecordId: () => undefined,
      stats: () => ({ records: 12 }),
    };

    const cappedService = new DebarmentService(repository);

    await expect(cappedService.check('anything')).resolves.toMatchObject({
      matches: expect.arrayContaining([
        expect.objectContaining({ basic: expect.objectContaining({ recordId: duplicateRecord.RECORD_ID }) }),
      ]),
      totalMatches: 12,
      truncated: true,
    });
    expect((await cappedService.check('anything')).matches).toHaveLength(5);

    const search = await cappedService.searchCandidates('anything');
    expect(search.candidates).toHaveLength(10);
    expect(search.totalCandidates).toBe(12);
    expect(search.truncated).toBe(true);
  });
```

- [x] **Step 5: Run targeted tests and verify failure**

Run:

```bash
npm test -- test/debarment-bot.test.ts
```

Expected: FAIL before implementation because `DebarmentService` uses `maxResults` for fuzzy candidates and defaults it to 5.

## Task 3: Implement Fuzzy Candidate Cap 10

**Files:**
- Modify: `src/domain/debarmentService.ts`

- [x] **Step 1: Add `maxCandidateResults` option and property**

In `src/domain/debarmentService.ts`, change the options interface and class properties to:

```ts
export interface DebarmentServiceOptions {
  maxResults?: number;
  maxCandidateResults?: number;
}
```

and:

```ts
export class DebarmentService {
  private readonly maxResults: number;
  private readonly maxCandidateResults: number;
  private readonly activeRepositories: ActiveDebarmentRepositories;
```

- [x] **Step 2: Resolve limits in the constructor**

In both constructor branches, set `maxCandidateResults` independently:

```ts
    if (senzingRepositoryOrActiveRepositories instanceof ActiveDebarmentRepositories) {
      this.activeRepositories = senzingRepositoryOrActiveRepositories;
      const resolvedOptions = targetDetailsRepositoryOrOptions as DebarmentServiceOptions | undefined;
      this.maxResults = Math.max(1, resolvedOptions?.maxResults ?? 5);
      this.maxCandidateResults = Math.max(1, resolvedOptions?.maxCandidateResults ?? 10);
      return;
    }
```

and after `resolvedOptions` is calculated in the non-active-repositories branch:

```ts
    this.maxResults = Math.max(1, resolvedOptions.maxResults ?? 5);
    this.maxCandidateResults = Math.max(1, resolvedOptions.maxCandidateResults ?? 10);
```

- [x] **Step 3: Use the fuzzy-specific cap for candidate search**

In `searchCandidateNames`, change:

```ts
    const cappedCandidates = allCandidates.slice(0, this.maxResults);
```

to:

```ts
    const cappedCandidates = allCandidates.slice(0, this.maxCandidateResults);
```

- [x] **Step 4: Run targeted tests**

Run:

```bash
npm test -- test/debarment-bot.test.ts
```

Expected: fuzzy cap tests pass after implementation; fuzzy button tests still fail until Task 4.

## Task 4: Implement Fuzzy Search Detail Buttons

**Files:**
- Modify: `src/bot/formatters.ts`

- [x] **Step 1: Return fuzzy action buttons**

In `src/bot/formatters.ts`, change the end of `formatFuzzySearchResult` from:

```ts
  return reply(truncateText(lines.join('\n'), options.maxMessageChars));
```

to:

```ts
  return {
    text: truncateText(lines.join('\n'), options.maxMessageChars),
    buttons: candidateActionButtons(result.candidates),
  };
```

- [x] **Step 2: Add `candidateActionButtons` helper**

In `src/bot/formatters.ts`, below `actionButtons`, add:

```ts
function candidateActionButtons(candidates: DebarmentCandidateSearchResult['candidates']): ReplyButton[][] {
  return candidates.map((candidate, index) => {
    const suffix = ` ${index + 1}`;
    return [
      { text: `/basic${suffix}`, callbackData: `basic:${candidate.basic.recordId}` },
      { text: `/full${suffix}`, callbackData: `full:${candidate.basic.recordId}` },
    ];
  });
}
```

- [x] **Step 3: Run targeted tests**

Run:

```bash
npm test -- test/debarment-bot.test.ts
```

Expected: PASS.

## Task 5: Final Verification And Commit

**Files:**
- Modify: `src/domain/debarmentService.ts`
- Modify: `src/bot/formatters.ts`
- Modify: `test/debarment-bot.test.ts`

- [x] **Step 1: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS with no TypeScript errors.

- [x] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [x] **Step 3: Review diff**

Run:

```bash
git diff -- src/domain/debarmentService.ts src/bot/formatters.ts test/debarment-bot.test.ts
```

Expected: diff only covers fuzzy cap, fuzzy buttons, and tests.

- [x] **Step 4: Commit implementation**

Run:

```bash
git add src/domain/debarmentService.ts src/bot/formatters.ts test/debarment-bot.test.ts docs/superpowers/plans/2026-06-23-fuzzy-search-detail-buttons.md
git commit -m "Add fuzzy search detail buttons"
```

Expected: one implementation commit containing the plan and code.

## Self-Review

- Spec coverage: the plan covers per-candidate `/basic N` and `/full N` buttons, callback reuse, no buttons for misses, fuzzy cap 10, truncation behavior, callback details, and exact-cap preservation.
- Placeholder scan: no incomplete implementation markers or repeated-by-reference instructions.
- Type consistency: uses existing `BotReply.buttons`, `ReplyButton`, `DebarmentCandidateSearchResult['candidates']`, `DebarmentServiceOptions`, and existing callback data strings.
