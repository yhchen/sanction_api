# Alias Search Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Prove and document that exact and fuzzy name lookup cover Senzing primary names and aliases.

**Architecture:** Keep `SenzingMemoryRepository` as the single name-indexing boundary. Exact commands use `findByName`; fuzzy search uses `findCandidateNames`; both indexes already come from `NAMES[].NAME_FULL`, so implementation should mostly add regression tests and user-facing docs.

**Tech Stack:** TypeScript, Vitest, Telegraf bot command handler, Markdown docs.

---

## File Structure

- Modify `test/debarment-bot.test.ts`: add explicit service and handler assertions for exact alias lookup and partial-alias fuzzy lookup.
- Modify `README.md`: update command behavior docs to say exact lookup accepts complete primary names or complete aliases, and fuzzy lookup searches primary names and aliases.
- Modify `docs/telegram-operation-guide.md`: mirror the user-facing command behavior updates from README.
- Do not modify `src/data/senzingMemoryRepository.ts` unless the new tests fail, because current indexing already uses every `NAMES[].NAME_FULL`.

### Task 1: Service Alias Coverage Tests

**Files:**
- Modify: `test/debarment-bot.test.ts`

- [x] **Step 1: Update exact matching test to name alias behavior explicitly**

Replace the existing test name:

```ts
test('matches complete primary or alias names, not partial names', async () => {
```

with:

```ts
test('exact lookup matches complete primary names and complete aliases, not partial names', async () => {
```

Inside the same test, keep the existing alias assertions and add `basic` and `full` assertions for the alias:

```ts
await expect(service.basic('MYANMAR YATAI INTERNATIONAL HOLDING GROUP CO LTD')).resolves.toMatchObject({
  found: true,
  matches: [{ basic: { matchedName: 'MYANMAR YATAI INTERNATIONAL HOLDING GROUP CO., LTD.' } }],
});
await expect(service.full('SHWE KOKKO SPECIAL ECONOMIC ZONE')).resolves.toMatchObject({
  found: true,
  matches: [{ basic: { matchedName: 'SHWE KOKKO SPECIAL ECONOMIC ZONE' } }],
});
```

- [x] **Step 2: Run the focused exact matching test**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "exact lookup matches complete primary names and complete aliases"
```

Expected: PASS. If it fails because alias names are not indexed, update `SenzingMemoryRepository.addRecord` so every non-empty `record.NAMES[].NAME_FULL` is added to both `nameIndex` and `searchableNames`.

- [x] **Step 3: Update fuzzy service test to cover partial alias input**

In `test('searches fuzzy debarment candidates without changing exact matching', ...)`, after the existing `Yatai Smart` fuzzy assertion, add:

```ts
await expect(service.searchCandidates('Myanmar Yatai')).resolves.toMatchObject({
  found: true,
  candidates: [
    {
      basic: {
        primaryName: 'YATAI SMART INDUSTRIAL NEW CITY',
        matchedName: 'MYANMAR YATAI INTERNATIONAL HOLDING GROUP CO., LTD.',
      },
    },
  ],
});
```

Keep the existing exact partial-name miss:

```ts
await expect(service.check('Yatai Smart')).resolves.toMatchObject({ found: false, matches: [] });
```

and add a partial-alias miss:

```ts
await expect(service.check('Myanmar Yatai')).resolves.toMatchObject({ found: false, matches: [] });
```

- [x] **Step 4: Run the focused fuzzy service test**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "searches fuzzy debarment candidates"
```

Expected: PASS. If it fails because aliases are not in the fuzzy candidate pool, update `SenzingMemoryRepository.addRecord` so `searchableNames` receives the same match objects as `nameIndex`.

### Task 2: Bot Handler Alias Coverage Tests

**Files:**
- Modify: `test/debarment-bot.test.ts`

- [x] **Step 1: Add direct command alias assertions**

In `test('direct commands support check/basic/full with arguments', ...)`, after the existing exact alias service-level checks, add handler assertions:

```ts
await expect(handler.handleMessage('/check MYANMAR YATAI INTERNATIONAL HOLDING GROUP CO LTD', 123)).resolves.toMatchObject({
  text: expect.stringMatching(/^Debarred/),
});
await expect(handler.handleMessage('/basic MYANMAR YATAI INTERNATIONAL HOLDING GROUP CO LTD', 123)).resolves.toMatchObject({
  text: expect.stringContaining('Matched Name: MYANMAR YATAI INTERNATIONAL HOLDING GROUP CO., LTD.'),
});
await expect(handler.handleMessage('/full SHWE KOKKO SPECIAL ECONOMIC ZONE', 123)).resolves.toMatchObject({
  text: expect.stringContaining('Sanctions Details'),
});
```

Keep the existing partial-name miss assertions:

```ts
await expect(handler.handleMessage('/check Yatai Smart', 123)).resolves.toMatchObject({ text: 'No Data Found!' });
await expect(handler.handleMessage('/basic Yatai Smart', 123)).resolves.toMatchObject({ text: 'No Data Found!' });
await expect(handler.handleMessage('/full Yatai Smart', 123)).resolves.toMatchObject({ text: 'No Data Found!' });
```

and add:

```ts
await expect(handler.handleMessage('/check Myanmar Yatai', 123)).resolves.toMatchObject({ text: 'No Data Found!' });
```

- [x] **Step 2: Run the direct command handler test**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "direct commands support check/basic/full with arguments"
```

Expected: PASS.

- [x] **Step 3: Add fuzzy command and plain text partial-alias assertions**

In `test('search command and no-argument search run fuzzy candidates', ...)`, add:

```ts
await expect(handler.handleMessage('/search Myanmar Yatai', 123)).resolves.toMatchObject({
  text: expect.stringMatching(/^Possible matches/),
});
await expect(handler.handleMessage('/search Myanmar Yatai', 123)).resolves.toMatchObject({
  text: expect.stringContaining('Matched Name: MYANMAR YATAI INTERNATIONAL HOLDING GROUP CO., LTD.'),
});
await expect(handler.handleMessage('Myanmar Yatai', 123)).resolves.toMatchObject({
  text: expect.stringMatching(/^Possible matches/),
});
```

- [x] **Step 4: Run the fuzzy handler test**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "search command and no-argument search run fuzzy candidates"
```

Expected: PASS.

### Task 3: User Documentation Updates

**Files:**
- Modify: `README.md`
- Modify: `docs/telegram-operation-guide.md`

- [x] **Step 1: Update README command behavior**

In `README.md`, replace statements that say `/check`, `/basic`, and `/full` only support complete names with wording that says they support complete primary names or complete aliases.

Use this wording for the behavior section:

```markdown
- `/check`、`/basic`、`/full` 使用完整主名称或完整别名精确匹配。例如：`/check YATAI SMART INDUSTRIAL NEW CITY` 和 `/check YATAI NEW CITY` 都可以命中同一条记录，但 `/check Yatai Smart` 不会按部分名称判断为 Debarred。
- `/search <name>` 和无等待模式下的纯文本会执行模糊候选搜索，会在主名称和别名中查找可能匹配的名称候选，不直接判定 `Debarred`。例如：`Yatai Smart` 或 `Myanmar Yatai` 可返回 `YATAI SMART INDUSTRIAL NEW CITY` 候选。
```

- [x] **Step 2: Update operation guide command behavior**

In `docs/telegram-operation-guide.md`, replace exact lookup wording with:

```markdown
- `/check`、`/basic`、`/full` 必须输入完整主名称或完整别名并保持精确匹配。
- `/search` 和普通文本可以使用主名称或别名的部分输入来查找候选。
```

- [x] **Step 3: Search docs for stale exact-only wording**

Run:

```bash
rg -n "完整名称精确|必须输入完整名称|部分名称" README.md docs/telegram-operation-guide.md
```

Expected: Remaining lines should either mention complete primary name or complete alias, or describe partial names only for fuzzy search.

### Task 4: Verification

**Files:**
- Read: `test/debarment-bot.test.ts`
- Read: `README.md`
- Read: `docs/telegram-operation-guide.md`

- [x] **Step 1: Run focused alias-related tests**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "alias|fuzzy|direct commands"
```

Expected: PASS.

- [x] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [x] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [x] **Step 4: Review final diff**

Run:

```bash
git diff -- test/debarment-bot.test.ts README.md docs/telegram-operation-guide.md
```

Expected: Diff only contains alias search coverage tests and wording updates. No unrelated behavior or formatting churn.
