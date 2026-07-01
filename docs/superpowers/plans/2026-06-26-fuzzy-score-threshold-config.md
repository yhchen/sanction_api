# Fuzzy Score Threshold Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure the fuzzy candidate score threshold from `.env`, defaulting to `0.8`, so fuzzy matches below the threshold do not display.

**Architecture:** Keep environment parsing in `src/config.ts`, pass the parsed `minFuzzyScore` into repository construction, and keep score filtering inside `SenzingMemoryRepository` where fuzzy scores are computed. Startup and data refresh must both build repositories with the same threshold so behavior does not drift after refresh.

**Tech Stack:** TypeScript, Node.js 20, Vitest, file-backed Senzing/OpenSanctions repositories, Telegram bot command handlers.

---

## File Structure

- Modify `src/config.ts`: add `AppConfig.minFuzzyScore` and a decimal range parser for `MIN_FUZZY_SCORE`.
- Modify `src/data/senzingMemoryRepository.ts`: add repository options and replace the hard-coded `MIN_FUZZY_SCORE` constant with an instance threshold.
- Modify `src/index.ts`: pass `config.minFuzzyScore` into the initial Senzing repository and into `DataRefreshService`.
- Modify `src/data/dataRefreshService.ts`: add `minFuzzyScore` to refresh options and pass it into refreshed Senzing repository construction.
- Modify `test/debarment-bot.test.ts`: add config validation coverage and repository threshold behavior coverage.
- Modify `test/data-refresh.test.ts`: add refresh coverage proving the rebuilt repository uses the configured fuzzy threshold.
- Modify `.env.example`, `README.md`, `docs/telegram-operation-guide.md`, and `docs/admin-telegram-users.md`: document `MIN_FUZZY_SCORE=0.8`.

---

### Task 1: Config Parsing

**Files:**
- Modify: `test/debarment-bot.test.ts`
- Modify: `src/config.ts`

- [ ] **Step 1: Add failing config tests**

In `test/debarment-bot.test.ts`, inside `describe('config', () => { ... })`, after the existing `loads env config without hard-coded token and validates required token` test, add:

```ts
  test('loads fuzzy score threshold config with default and validation', () => {
    expect(loadConfig({ TELEGRAM_BOT_TOKEN: 'token' }, { requireToken: true })).toMatchObject({
      minFuzzyScore: 0.8,
    });

    expect(
      loadConfig(
        {
          TELEGRAM_BOT_TOKEN: 'token',
          MIN_FUZZY_SCORE: '0.75',
        },
        { requireToken: true },
      ),
    ).toMatchObject({
      minFuzzyScore: 0.75,
    });

    expect(
      loadConfig(
        {
          TELEGRAM_BOT_TOKEN: 'token',
          MIN_FUZZY_SCORE: ' 1 ',
        },
        { requireToken: true },
      ),
    ).toMatchObject({
      minFuzzyScore: 1,
    });

    expect(
      loadConfig(
        {
          TELEGRAM_BOT_TOKEN: 'token',
          MIN_FUZZY_SCORE: ' ',
        },
        { requireToken: true },
      ),
    ).toMatchObject({
      minFuzzyScore: 0.8,
    });

    expect(() =>
      loadConfig(
        {
          TELEGRAM_BOT_TOKEN: 'token',
          MIN_FUZZY_SCORE: '1.1',
        },
        { requireToken: true },
      ),
    ).toThrow(/MIN_FUZZY_SCORE/);

    expect(() =>
      loadConfig(
        {
          TELEGRAM_BOT_TOKEN: 'token',
          MIN_FUZZY_SCORE: '-0.1',
        },
        { requireToken: true },
      ),
    ).toThrow(/MIN_FUZZY_SCORE/);

    expect(() =>
      loadConfig(
        {
          TELEGRAM_BOT_TOKEN: 'token',
          MIN_FUZZY_SCORE: 'high',
        },
        { requireToken: true },
      ),
    ).toThrow(/MIN_FUZZY_SCORE/);
  });
```

- [ ] **Step 2: Run the config test and verify it fails**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "fuzzy score threshold config"
```

Expected: FAIL because `loadConfig()` does not return `minFuzzyScore`.

- [ ] **Step 3: Add `minFuzzyScore` to config**

In `src/config.ts`, add `minFuzzyScore` to `AppConfig`:

```ts
  minFuzzyScore: number;
```

In the object returned by `loadConfig()`, add:

```ts
    minFuzzyScore: boundedNumber(env.MIN_FUZZY_SCORE, 0.8, 'MIN_FUZZY_SCORE', 0, 1),
```

At the end of `src/config.ts`, after `boundedPositiveInteger`, add:

```ts
function boundedNumber(rawValue: string | undefined, defaultValue: number, envName: string, minValue: number, maxValue: number): number {
  if (rawValue === undefined || rawValue.trim() === '') return defaultValue;
  const parsed = Number(rawValue.trim());
  if (!Number.isFinite(parsed) || parsed < minValue || parsed > maxValue) {
    throw new Error(`${envName} must be a number between ${minValue} and ${maxValue}.`);
  }
  return parsed;
}
```

- [ ] **Step 4: Run the config test and verify it passes**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "fuzzy score threshold config"
```

Expected: PASS.

- [ ] **Step 5: Commit config parsing**

Run:

```bash
git add src/config.ts test/debarment-bot.test.ts
git commit -m "feat: parse fuzzy score threshold config"
```

---

### Task 2: Repository Threshold Filtering

**Files:**
- Modify: `test/debarment-bot.test.ts`
- Modify: `src/data/senzingMemoryRepository.ts`

- [ ] **Step 1: Add failing repository threshold tests**

In `test/debarment-bot.test.ts`, inside `describe('repositories and debarment service', () => { ... })`, after `test('finds fuzzy candidates by partial names only', ...)`, add:

```ts
  test('filters fuzzy candidates below the configured score threshold', async () => {
    const strictRepo = await SenzingMemoryRepository.fromFile(senzingFixture, { minFuzzyScore: 0.96 });
    const relaxedRepo = await SenzingMemoryRepository.fromFile(senzingFixture, { minFuzzyScore: 0.55 });

    expect(strictRepo.findCandidateNames('Yatai Smart')).toEqual([]);
    expect(relaxedRepo.findCandidateNames('Yatai Smart')[0]).toMatchObject({
      matchedName: 'YATAI SMART INDUSTRIAL NEW CITY',
      score: expect.any(Number),
    });
  });
```

- [ ] **Step 2: Run the repository test and verify it fails**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "filters fuzzy candidates below"
```

Expected: FAIL because `SenzingMemoryRepository.fromFile` does not accept options yet.

- [ ] **Step 3: Add repository options and instance threshold**

In `src/data/senzingMemoryRepository.ts`, after `interface SearchableNameMatch`, add:

```ts
export interface SenzingMemoryRepositoryOptions {
  minFuzzyScore?: number;
}
```

Add a constructor inside `SenzingMemoryRepository`:

```ts
  private readonly minFuzzyScore: number;

  constructor(options: SenzingMemoryRepositoryOptions = {}) {
    this.minFuzzyScore = options.minFuzzyScore ?? 0.8;
  }
```

Change `fromFile` from:

```ts
  static async fromFile(filePath: string): Promise<SenzingMemoryRepository> {
    const repository = new SenzingMemoryRepository();
```

to:

```ts
  static async fromFile(filePath: string, options: SenzingMemoryRepositoryOptions = {}): Promise<SenzingMemoryRepository> {
    const repository = new SenzingMemoryRepository(options);
```

Change `fromRecords` from:

```ts
  static fromRecords(records: SenzingRecord[]): SenzingMemoryRepository {
    const repository = new SenzingMemoryRepository();
```

to:

```ts
  static fromRecords(records: SenzingRecord[], options: SenzingMemoryRepositoryOptions = {}): SenzingMemoryRepository {
    const repository = new SenzingMemoryRepository(options);
```

- [ ] **Step 4: Replace the hard-coded score threshold**

In `findCandidateNames`, change:

```ts
        const score = scoreCandidate(normalizedQuery, queryTokens, match);
```

to:

```ts
        const score = scoreCandidate(normalizedQuery, queryTokens, match, this.minFuzzyScore);
```

Remove:

```ts
const MIN_FUZZY_SCORE = 0.55;
```

Change `scoreCandidate` signature from:

```ts
function scoreCandidate(
  normalizedQuery: string,
  queryTokens: string[],
  candidate: SearchableNameMatch,
): { score: number; matchReason: string } | undefined {
```

to:

```ts
function scoreCandidate(
  normalizedQuery: string,
  queryTokens: string[],
  candidate: SearchableNameMatch,
  minFuzzyScore: number,
): { score: number; matchReason: string } | undefined {
```

Change:

```ts
  if (score < MIN_FUZZY_SCORE) return undefined;
```

to:

```ts
  if (score < minFuzzyScore) return undefined;
```

- [ ] **Step 5: Update existing fuzzy tests that need lower fixture scores**

Some existing fixture queries such as `Yatai Smart` may score below the new default `0.8`. Keep the existing behavior-focused tests explicit by lowering the test repository threshold.

In `test/debarment-bot.test.ts`, change `buildService` to:

```ts
async function buildService(options: DebarmentServiceOptions & { minFuzzyScore?: number } = {}) {
  const { minFuzzyScore = 0.55, ...serviceOptions } = options;
  const senzing = await SenzingMemoryRepository.fromFile(senzingFixture, { minFuzzyScore });
  const targets = await TargetsNestedMemoryRepository.fromFile(targetsFixture);
  return new DebarmentService(senzing, targets, serviceOptions);
}
```

This preserves existing tests that assert historical fuzzy fixture behavior while allowing new tests to cover the stricter default separately.

- [ ] **Step 6: Run repository and fuzzy service tests**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "fuzzy|filters fuzzy candidates below"
```

Expected: PASS.

- [ ] **Step 7: Commit repository threshold filtering**

Run:

```bash
git add src/data/senzingMemoryRepository.ts test/debarment-bot.test.ts
git commit -m "feat: apply configurable fuzzy score threshold"
```

---

### Task 3: Startup and Refresh Wiring

**Files:**
- Modify: `src/index.ts`
- Modify: `src/data/dataRefreshService.ts`
- Modify: `test/data-refresh.test.ts`

- [ ] **Step 1: Add failing refresh threshold test**

In `test/data-refresh.test.ts`, change `createHarness` options type from:

```ts
async function createHarness(options: {
  localMetadata?: DatasetMetadata;
  remoteMetadata?: DatasetMetadata;
  downloader?: RefreshDownloader;
} = {}) {
```

to:

```ts
async function createHarness(options: {
  localMetadata?: DatasetMetadata;
  remoteMetadata?: DatasetMetadata;
  downloader?: RefreshDownloader;
  minFuzzyScore?: number;
} = {}) {
```

Change the initial active repository construction from:

```ts
    await SenzingMemoryRepository.fromFile(senzingPath),
```

to:

```ts
    await SenzingMemoryRepository.fromFile(senzingPath, { minFuzzyScore: options.minFuzzyScore }),
```

When constructing `DataRefreshService`, add:

```ts
    minFuzzyScore: options.minFuzzyScore,
```

Inside `describe('data refresh service', () => { ... })`, after `downloads both changed resources to temp files, rebuilds indexes, swaps active data, and persists metadata`, add:

```ts
  test('uses the configured fuzzy threshold after rebuilding indexes during refresh', async () => {
    const local = metadata('v1', { senzing: 'old-senzing', targets: 'old-targets' });
    const remote = metadata('v2', { senzing: 'new-senzing', targets: 'new-targets' });
    const harness = await createHarness({ localMetadata: local, remoteMetadata: remote, minFuzzyScore: 1 });

    await expect(harness.refresher.refreshNow()).resolves.toMatchObject({ status: 'updated', version: 'v2' });

    await expect(harness.service.searchCandidates('NEW')).resolves.toMatchObject({
      found: false,
      candidates: [],
      totalCandidates: 0,
      truncated: false,
    });
    await expect(harness.service.searchCandidates('NEW PLAYER')).resolves.toMatchObject({
      found: true,
      candidates: [{ basic: { recordId: 'new-record' }, score: 1 }],
    });
  });
```

- [ ] **Step 2: Run the refresh threshold test and verify it fails**

Run:

```bash
npm test -- test/data-refresh.test.ts -t "configured fuzzy threshold"
```

Expected: FAIL because `DataRefreshServiceOptions` does not accept or use `minFuzzyScore`.

- [ ] **Step 3: Wire threshold through refresh service**

In `src/data/dataRefreshService.ts`, change `DataRefreshServiceOptions` to include:

```ts
  minFuzzyScore?: number;
```

Change refreshed repository construction from:

```ts
      const nextSenzingRepository = await SenzingMemoryRepository.fromFile(stagedSenzingPath);
```

to:

```ts
      const nextSenzingRepository = await SenzingMemoryRepository.fromFile(stagedSenzingPath, {
        minFuzzyScore: this.options.minFuzzyScore,
      });
```

- [ ] **Step 4: Wire threshold through startup**

In `src/index.ts`, change initial Senzing repository loading from:

```ts
  const senzingRepository = await SenzingMemoryRepository.fromFile(config.senzingPath);
```

to:

```ts
  const senzingRepository = await SenzingMemoryRepository.fromFile(config.senzingPath, {
    minFuzzyScore: config.minFuzzyScore,
  });
```

Change `DataRefreshService` construction by adding:

```ts
    minFuzzyScore: config.minFuzzyScore,
```

- [ ] **Step 5: Run refresh and type checks**

Run:

```bash
npm test -- test/data-refresh.test.ts -t "configured fuzzy threshold"
npm run typecheck
```

Expected: both commands PASS.

- [ ] **Step 6: Commit startup and refresh wiring**

Run:

```bash
git add src/index.ts src/data/dataRefreshService.ts test/data-refresh.test.ts
git commit -m "feat: reuse fuzzy score threshold after refresh"
```

---

### Task 4: Documentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/telegram-operation-guide.md`
- Modify: `docs/admin-telegram-users.md`

- [ ] **Step 1: Update `.env.example`**

Add `MIN_FUZZY_SCORE=0.8` between `REFRESH_SCHEDULE_TIME=05:00` and `MAX_RESULTS=5`:

```dotenv
REFRESH_SCHEDULE_TIME=05:00
MIN_FUZZY_SCORE=0.8
MAX_RESULTS=5
MAX_MESSAGE_CHARS=3800
```

- [ ] **Step 2: Update README environment examples**

In `README.md`, add this line to each environment variable example block that currently includes `REFRESH_SCHEDULE_TIME`, `MAX_RESULTS`, and `MAX_MESSAGE_CHARS`:

```bash
export MIN_FUZZY_SCORE="0.8"
```

Place it between `export REFRESH_SCHEDULE_TIME="05:00"` and `export MAX_RESULTS="5"`.

In the environment variable table, add a row between `REFRESH_SCHEDULE_TIME` and `MAX_RESULTS`:

```markdown
| `MIN_FUZZY_SCORE` | `0.8` | 模糊候选搜索的最低分数阈值；低于该分数的候选不会显示。取值范围为 `0` 到 `1`。 |
```

- [ ] **Step 3: Update Telegram operation guide examples**

In `docs/telegram-operation-guide.md`, add this line to `.env` examples that list `REFRESH_SCHEDULE_TIME`, `MAX_RESULTS`, and `MAX_MESSAGE_CHARS`:

```dotenv
MIN_FUZZY_SCORE=0.8
```

Place it between `REFRESH_SCHEDULE_TIME=05:00` and `MAX_RESULTS=5`.

After the existing `.env` variable explanations near the setup section, add:

```markdown
- `MIN_FUZZY_SCORE`：模糊候选搜索最低分数阈值，默认 `0.8`；低于该分数的候选不会显示。
```

- [ ] **Step 4: Update admin user guide template**

In `docs/admin-telegram-users.md`, add this line to the recommended config template between `TARGETS_NESTED_PATH=./targets.nested.json` and `MAX_RESULTS=5`:

```dotenv
MIN_FUZZY_SCORE=0.8
```

- [ ] **Step 5: Review docs diff**

Run:

```bash
git diff -- .env.example README.md docs/telegram-operation-guide.md docs/admin-telegram-users.md
```

Expected: Diff only documents `MIN_FUZZY_SCORE`.

- [ ] **Step 6: Commit documentation**

Run:

```bash
git add .env.example README.md docs/telegram-operation-guide.md docs/admin-telegram-users.md
git commit -m "docs: document fuzzy score threshold config"
```

---

### Task 5: Final Verification

**Files:**
- Review all changed files

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

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

Expected: PASS.

- [ ] **Step 4: Check final diff**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected:

- `git diff --check` prints no whitespace errors.
- Only intended files are modified if commits were not created yet.
- No unrelated `.swp` or local runtime files are staged.

- [ ] **Step 5: Commit any remaining plan checkbox updates**

If the implementation updated this plan's checkboxes, commit only this plan file:

```bash
git add docs/superpowers/plans/2026-06-26-fuzzy-score-threshold-config.md
git commit -m "docs: track fuzzy threshold implementation plan"
```

Skip this commit if the plan file has no remaining uncommitted changes.

---

## Self-Review

- Spec coverage: The plan covers `.env` config parsing, default `0.8`, invalid config handling, repository score filtering, startup propagation, refresh propagation, docs, and final verification. Exact lookup behavior, score formula, sort order, candidate caps, access control, and formatter wording are left unchanged.
- Red-flag scan: No deferred implementation notes remain.
- Type consistency: The plan consistently uses `minFuzzyScore`, `MIN_FUZZY_SCORE`, `SenzingMemoryRepositoryOptions`, `DataRefreshServiceOptions.minFuzzyScore`, and the existing `DebarmentServiceOptions` type.
