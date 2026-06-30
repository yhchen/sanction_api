# SQLite Query Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace long-lived JSONL memory indexes with a SQLite-backed query store that supports exact lookup, full details, fuzzy candidate search with limited typo tolerance, safe refresh, and first-run empty bootstrap.

**Architecture:** Keep `DebarmentService` and bot command behavior centered on the existing repository interfaces. Add a SQLite builder, SQLite repositories, and startup/refresh orchestration that builds new database files off to the side and swaps active repositories only after validation. Extract shared name scoring so memory and SQLite repositories rank candidates consistently.

**Tech Stack:** Node.js 20, TypeScript, Vitest, `better-sqlite3`, SQLite FTS5, existing Telegraf bot stack.

---

## Scope Check

This plan implements one cohesive subsystem: the local SQLite query backend. It includes dependency/config changes, database build, repository implementation, startup bootstrap, refresh integration, and documentation. It does not add Postgres, Redis, external services, or new Telegram user workflows.

Before implementation, create an isolated worktree using `superpowers:using-git-worktrees` because the user explicitly requested worktree-based development.

## File Structure

- Modify `package.json`: add SQLite dependency and `db:build` script.
- Modify `package-lock.json`: produced by `npm install better-sqlite3 @types/better-sqlite3 --save` / `--save-dev`.
- Modify `.env.example`: document `SQLITE_PATH`.
- Modify `src/config.ts`: add `sqlitePath`.
- Modify `src/domain/types.ts`: add optional data status fields so empty bootstrap can be shown distinctly.
- Create `src/domain/nameScoring.ts`: shared tokenization, current fuzzy scoring, typo-tolerant candidate scoring, and deterministic best-match helpers.
- Modify `src/data/senzingMemoryRepository.ts`: delegate fuzzy scoring to `nameScoring.ts`.
- Create `src/data/sqliteSchema.ts`: schema constants and schema validation helpers.
- Create `src/data/sqliteBuilder.ts`: JSONL-to-SQLite builder and safe publish helper.
- Create `src/data/sqliteRepositories.ts`: `SqliteSenzingRepository` and `SqliteTargetDetailsRepository`.
- Create `src/data/sqliteBootstrap.ts`: startup bootstrap that opens existing DB, builds from JSONL, or creates empty DB and requests update.
- Create `src/scripts/buildSqlite.ts`: CLI entry for offline `npm run db:build`.
- Modify `src/data/dataRefreshService.ts`: build and publish SQLite during refresh when `sqlitePath` is configured.
- Modify `src/bot/formatters.ts`: display bootstrap-empty responses instead of confident misses.
- Modify `src/index.ts`: use SQLite bootstrap and trigger auto-update when requested.
- Modify `test/package-scripts.test.ts`: lock `db:build` script.
- Create `test/sqlite-builder.test.ts`: builder/schema/publish coverage.
- Create `test/sqlite-repositories.test.ts`: exact, full, search, typo, and dedup behavior.
- Create `test/sqlite-bootstrap.test.ts`: startup bootstrap coverage.
- Modify `test/data-refresh.test.ts`: SQLite refresh swap coverage.
- Modify `test/debarment-bot.test.ts`: empty bootstrap formatter and service behavior coverage.
- Modify `README.md` and `docs/telegram-operation-guide.md`: document database build, bootstrap, and update behavior.

### Task 1: Worktree And Dependency Foundation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`
- Modify: `src/config.ts`
- Modify: `test/package-scripts.test.ts`

- [ ] **Step 1: Create an isolated worktree**

Run this before code changes:

```bash
git status --short
git worktree add ..\sanction_api_sqlite -b feature/sqlite-query-backend
```

Expected: a new worktree at `D:\github\sanction_api_sqlite`. Continue implementation there.

- [ ] **Step 2: Install SQLite dependencies**

Run:

```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

Expected: `package.json` and `package-lock.json` update with `better-sqlite3` and `@types/better-sqlite3`.

- [ ] **Step 3: Write failing package/config tests**

Add assertions to `test/package-scripts.test.ts`:

```ts
test('provides an offline SQLite build script', async () => {
  const packageJson = await readPackageJson();

  expect(packageJson.scripts?.['db:build']).toBe('tsx src/scripts/buildSqlite.ts');
});
```

Add config assertions in `test/debarment-bot.test.ts` near existing config tests:

```ts
test('loads SQLite path with a local default', () => {
  expect(loadConfig({ TELEGRAM_BOT_TOKEN: 'token' })).toMatchObject({
    sqlitePath: './sanction.sqlite',
  });

  expect(loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    SQLITE_PATH: './data/custom.sqlite',
  })).toMatchObject({
    sqlitePath: './data/custom.sqlite',
  });
});
```

- [ ] **Step 4: Run tests and verify failure**

Run:

```bash
npm test -- test/package-scripts.test.ts test/debarment-bot.test.ts
```

Expected: FAIL because `db:build` and `sqlitePath` do not exist.

- [ ] **Step 5: Add config and script**

Update `package.json` scripts:

```json
"db:build": "tsx src/scripts/buildSqlite.ts"
```

Update `src/config.ts`:

```ts
export interface AppConfig {
  telegramBotToken: string;
  allowedTelegramUsers: string;
  adminTelegramUsers: string;
  approvedTelegramUsersPath: string;
  senzingPath: string;
  targetsNestedPath: string;
  sqlitePath: string;
  refreshMetadataPath: string;
  refreshScheduleTime: string;
  maxResults: number;
  maxMessageChars: number;
}
```

Add the returned value:

```ts
sqlitePath: env.SQLITE_PATH?.trim() || './sanction.sqlite',
```

Update `.env.example`:

```text
SQLITE_PATH="./sanction.sqlite"
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
npm test -- test/package-scripts.test.ts test/debarment-bot.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add package.json package-lock.json .env.example src/config.ts test/package-scripts.test.ts test/debarment-bot.test.ts
git commit -m "Add SQLite configuration and build script"
```

### Task 2: Data Status For Empty Bootstrap

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/debarmentService.ts`
- Modify: `src/bot/formatters.ts`
- Modify: `test/debarment-bot.test.ts`

- [ ] **Step 1: Write failing empty-state tests**

Add tests to `test/debarment-bot.test.ts`:

```ts
test('formats empty bootstrap exact lookup distinctly from a real miss', () => {
  expect(formatCheckResult({
    query: 'ANY NAME',
    found: false,
    matches: [],
    totalMatches: 0,
    truncated: false,
    dataStatus: 'empty',
  }).text).toBe('Local debarment data is not loaded yet. Data refresh may still be running; try again after the update completes.');
});

test('formats empty bootstrap fuzzy search distinctly from a real miss', () => {
  expect(formatFuzzySearchResult({
    query: 'ANY NAME',
    found: false,
    candidates: [],
    totalCandidates: 0,
    truncated: false,
    dataStatus: 'empty',
  }).text).toBe('Local debarment data is not loaded yet, so candidate search is unavailable. Try again after the update completes.');
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- test/debarment-bot.test.ts
```

Expected: FAIL because `dataStatus` is not typed and formatters do not branch on it.

- [ ] **Step 3: Add data status types**

Update `src/domain/types.ts`:

```ts
export type RepositoryDataStatus = 'ready' | 'empty';
```

Add optional fields:

```ts
export interface DebarmentQueryResult {
  query: string;
  found: boolean;
  matches: DebarmentMatch[];
  totalMatches: number;
  truncated: boolean;
  dataStatus?: RepositoryDataStatus;
}

export interface DebarmentCandidateSearchResult {
  query: string;
  found: boolean;
  candidates: DebarmentCandidate[];
  totalCandidates: number;
  truncated: boolean;
  dataStatus?: RepositoryDataStatus;
}
```

- [ ] **Step 4: Mark empty repository results in service**

In `src/domain/debarmentService.ts`, add:

```ts
function repositoryDataStatus(repository: SenzingLookupRepository): 'ready' | 'empty' {
  return repository.stats().records === 0 ? 'empty' : 'ready';
}
```

Set `dataStatus` in `queryByName`, `searchCandidateNames`, and `queryByRecordId` results. The empty helper becomes:

```ts
function emptyResult(query: string, dataStatus: 'ready' | 'empty' = 'ready'): DebarmentQueryResult {
  return { query, found: false, matches: [], totalMatches: 0, truncated: false, dataStatus };
}
```

- [ ] **Step 5: Update formatters**

In `src/bot/formatters.ts`, add constants:

```ts
const EMPTY_DATA_EXACT = 'Local debarment data is not loaded yet. Data refresh may still be running; try again after the update completes.';
const EMPTY_DATA_SEARCH = 'Local debarment data is not loaded yet, so candidate search is unavailable. Try again after the update completes.';
```

Update no-result branches:

```ts
if (!result.found) return reply(result.dataStatus === 'empty' ? EMPTY_DATA_EXACT : NO_DATA_FOUND);
```

For fuzzy search:

```ts
if (!result.found) return reply(result.dataStatus === 'empty' ? EMPTY_DATA_SEARCH : 'No close name candidates found. Try a more complete name.');
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
npm test -- test/debarment-bot.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add src/domain/types.ts src/domain/debarmentService.ts src/bot/formatters.ts test/debarment-bot.test.ts
git commit -m "Represent empty data bootstrap state"
```

### Task 3: Shared Name Scoring With Typo Tolerance

**Files:**
- Create: `src/domain/nameScoring.ts`
- Modify: `src/data/senzingMemoryRepository.ts`
- Modify: `test/debarment-bot.test.ts`

- [ ] **Step 1: Write failing typo and identifier tests**

Add to the fuzzy search describe block in `test/debarment-bot.test.ts`:

```ts
test('search tolerates small Latin token typos after candidate recall', async () => {
  const service = await buildService();

  await expect(service.searchCandidates('Yatai Smrat')).resolves.toMatchObject({
    found: true,
    candidates: [
      { basic: { primaryName: 'YATAI SMART INDUSTRIAL NEW CITY' } },
    ],
  });
});

test('search does not fuzzy-match identifier-like input through edit distance', async () => {
  const service = await buildService();

  await expect(service.searchCandidates('PW2XZT68KVW8')).resolves.toMatchObject({
    found: false,
    candidates: [],
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- test/debarment-bot.test.ts
```

Expected: FAIL for typo search, PASS or existing behavior for identifier guard.

- [ ] **Step 3: Create shared scoring module**

Create `src/domain/nameScoring.ts`:

```ts
export interface SearchableNameForScoring {
  normalizedName: string;
  normalizedTokens: string[];
}

export interface NameScore {
  score: number;
  matchReason: string;
}

export const MIN_FUZZY_SCORE = 0.55;

export function normalizedTokens(normalizedName: string): string[] {
  return normalizedName.split(' ').filter(Boolean);
}

export function scoreSearchableName(
  normalizedQuery: string,
  queryTokens: string[],
  candidate: SearchableNameForScoring,
): NameScore | undefined {
  if (!candidate.normalizedName) return undefined;
  if (candidate.normalizedName === normalizedQuery) return { score: 1, matchReason: 'exact-name-candidate' };
  if (candidate.normalizedName.includes(normalizedQuery)) return { score: 0.95, matchReason: 'contains-query' };

  const candidateTokens = candidate.normalizedTokens;
  if (queryTokens.length === 0 || candidateTokens.length === 0) return undefined;

  const exactTokenMatches = queryTokens.filter((queryToken) => candidateTokens.includes(queryToken)).length;
  const prefixTokenMatches = queryTokens.filter((queryToken) =>
    candidateTokens.some((candidateToken) => candidateToken.startsWith(queryToken) || queryToken.startsWith(candidateToken)),
  ).length;
  const substringTokenMatches = queryTokens.filter((queryToken) =>
    candidateTokens.some((candidateToken) => candidateToken.includes(queryToken) || queryToken.includes(candidateToken)),
  ).length;
  const typoTokenMatches = queryTokens.filter((queryToken) =>
    isLatinWordToken(queryToken) &&
    candidateTokens.some((candidateToken) => isLatinWordToken(candidateToken) && isSmallTypo(queryToken, candidateToken)),
  ).length;

  const tokenCoverage = exactTokenMatches / queryTokens.length;
  const prefixCoverage = prefixTokenMatches / queryTokens.length;
  const substringCoverage = substringTokenMatches / queryTokens.length;
  const typoCoverage = typoTokenMatches / queryTokens.length;
  const orderBonus = appearsInOrder(queryTokens, candidateTokens) ? 0.08 : 0;
  const score = Math.min(0.94, tokenCoverage * 0.65 + prefixCoverage * 0.20 + substringCoverage * 0.10 + typoCoverage * 0.45 + orderBonus);
  if (score < MIN_FUZZY_SCORE) return undefined;

  return {
    score,
    matchReason: exactTokenMatches === queryTokens.length
      ? 'token-match'
      : typoTokenMatches > 0
        ? 'similar-name-typo'
        : 'similar-name',
  };
}

function appearsInOrder(queryTokens: string[], candidateTokens: string[]): boolean {
  let candidateIndex = 0;
  for (const queryToken of queryTokens) {
    const nextIndex = candidateTokens.findIndex((candidateToken, index) => index >= candidateIndex && candidateToken.includes(queryToken));
    if (nextIndex < 0) return false;
    candidateIndex = nextIndex + 1;
  }
  return true;
}

function isLatinWordToken(token: string): boolean {
  return token.length >= 5 && /^[a-z]+$/u.test(token);
}

function isSmallTypo(left: string, right: string): boolean {
  if (left === right) return true;
  const lengthDelta = Math.abs(left.length - right.length);
  if (lengthDelta > 2) return false;
  const allowed = Math.max(left.length, right.length) >= 8 ? 2 : 1;
  return levenshteinDistance(left, right, allowed) <= allowed;
}

function levenshteinDistance(left: string, right: string, maxDistance: number): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const value = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + cost,
      );
      current[rightIndex] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[right.length] ?? maxDistance + 1;
}
```

- [ ] **Step 4: Delegate memory repository scoring**

In `src/data/senzingMemoryRepository.ts`, import:

```ts
import { normalizedTokens, scoreSearchableName } from '../domain/nameScoring.js';
```

Replace local `tokens(normalized)` calls with `normalizedTokens(normalized)`.

Replace `scoreCandidate(...)` calls with:

```ts
const score = scoreSearchableName(normalizedQuery, queryTokens, match);
```

Delete local `MIN_FUZZY_SCORE`, `scoreCandidate`, `tokens`, and `appearsInOrder`.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- test/debarment-bot.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add src/domain/nameScoring.ts src/data/senzingMemoryRepository.ts test/debarment-bot.test.ts
git commit -m "Extract typo-aware name scoring"
```

### Task 4: SQLite Schema And Builder

**Files:**
- Create: `src/data/sqliteSchema.ts`
- Create: `src/data/sqliteBuilder.ts`
- Create: `src/scripts/buildSqlite.ts`
- Create: `test/sqlite-builder.test.ts`

- [ ] **Step 1: Write failing builder tests**

Create `test/sqlite-builder.test.ts`:

```ts
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildSqliteDatabase, createEmptySqliteDatabase } from '../src/data/sqliteBuilder.js';
import { SQLITE_SCHEMA_VERSION, validateSqliteSchema } from '../src/data/sqliteSchema.js';

const fixturesDir = path.join(process.cwd(), 'test/fixtures');

async function tempPath(fileName: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-builder-'));
  return path.join(dir, fileName);
}

describe('SQLite builder', () => {
  test('builds schema, indexes, records, names, fts rows, and sanctions from fixtures', async () => {
    const sqlitePath = await tempPath('sanction.sqlite');

    await buildSqliteDatabase({
      senzingPath: path.join(fixturesDir, 'senzing.fixture.jsonl'),
      targetsNestedPath: path.join(fixturesDir, 'targets.nested.fixture.jsonl'),
      sqlitePath,
    });

    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    try {
      expect(validateSqliteSchema(db)).toBe(true);
      expect(db.prepare('SELECT value FROM schema_metadata WHERE key = ?').get('schema_version')).toEqual({ value: SQLITE_SCHEMA_VERSION });
      expect(db.prepare('SELECT COUNT(*) AS count FROM records').get()).toEqual({ count: 5 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM names').get()).toEqual({ count: 8 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM target_sanctions').get()).toEqual({ count: 3 });
      expect(db.prepare("SELECT record_id FROM names WHERE normalized_name = 'yatai smart industrial new city'").get()).toEqual({ record_id: 'NK-223CQDBzp8MRkdJMDiqXn3' });
      expect(db.prepare("SELECT COUNT(*) AS count FROM name_fts WHERE name_fts MATCH 'yatai'").get()).toEqual({ count: 4 });
    } finally {
      db.close();
    }
  });

  test('creates a valid empty database', async () => {
    const sqlitePath = await tempPath('empty.sqlite');

    await createEmptySqliteDatabase(sqlitePath);

    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    try {
      expect(validateSqliteSchema(db)).toBe(true);
      expect(db.prepare('SELECT COUNT(*) AS count FROM records').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- test/sqlite-builder.test.ts
```

Expected: FAIL because builder modules do not exist.

- [ ] **Step 3: Implement schema module**

Create `src/data/sqliteSchema.ts`:

```ts
import type Database from 'better-sqlite3';

export const SQLITE_SCHEMA_VERSION = '1';

export function initializeSqliteSchema(db: Database.Database): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS schema_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS records (
      record_id TEXT PRIMARY KEY,
      record_json TEXT NOT NULL,
      is_debarment INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS names (
      id INTEGER PRIMARY KEY,
      record_id TEXT NOT NULL,
      name_full TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      name_type TEXT,
      normalized_tokens_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS target_sanctions (
      record_id TEXT PRIMARY KEY,
      sanctions_json TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS name_fts USING fts5(
      normalized_name,
      name_full,
      record_id UNINDEXED,
      name_id UNINDEXED
    );

    CREATE INDEX IF NOT EXISTS idx_names_normalized_name ON names(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_names_record_id ON names(record_id);
    CREATE INDEX IF NOT EXISTS idx_records_debarment ON records(is_debarment);
  `);

  db.prepare(`
    INSERT INTO schema_metadata (key, value)
    VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(SQLITE_SCHEMA_VERSION);
}

export function validateSqliteSchema(db: Database.Database): boolean {
  const row = db.prepare('SELECT value FROM schema_metadata WHERE key = ?').get('schema_version') as { value?: string } | undefined;
  return row?.value === SQLITE_SCHEMA_VERSION;
}
```

- [ ] **Step 4: Implement builder**

Create `src/data/sqliteBuilder.ts` with these exported functions and helpers:

```ts
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeName } from '../domain/normalize.js';
import { normalizedTokens } from '../domain/nameScoring.js';
import type { SenzingRecord, TargetNestedRecord, TargetNestedSanction, SanctionDetail } from '../domain/types.js';
import { readJsonlFile } from './jsonl.js';
import { initializeSqliteSchema, validateSqliteSchema } from './sqliteSchema.js';

export interface BuildSqliteDatabaseOptions {
  senzingPath: string;
  targetsNestedPath: string;
  sqlitePath: string;
}

export async function createEmptySqliteDatabase(sqlitePath: string): Promise<void> {
  await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
  await fs.rm(sqlitePath, { force: true });
  const db = new Database(sqlitePath);
  try {
    initializeSqliteSchema(db);
  } finally {
    db.close();
  }
}

export async function buildSqliteDatabase(options: BuildSqliteDatabaseOptions): Promise<void> {
  await fs.mkdir(path.dirname(options.sqlitePath), { recursive: true });
  await fs.rm(options.sqlitePath, { force: true });
  const db = new Database(options.sqlitePath);
  try {
    initializeSqliteSchema(db);
    const insertRecord = db.prepare('INSERT INTO records (record_id, record_json, is_debarment) VALUES (?, ?, ?)');
    const insertName = db.prepare('INSERT INTO names (record_id, name_full, normalized_name, name_type, normalized_tokens_json) VALUES (?, ?, ?, ?, ?)');
    const insertFts = db.prepare('INSERT INTO name_fts (normalized_name, name_full, record_id, name_id) VALUES (?, ?, ?, ?)');
    const insertSanctions = db.prepare('INSERT INTO target_sanctions (record_id, sanctions_json) VALUES (?, ?)');

    const insertSenzingRecord = db.transaction((record: SenzingRecord) => {
      insertRecord.run(record.RECORD_ID, JSON.stringify(record), isDebarmentRecord(record) ? 1 : 0);
      const seenNormalizedNamesForRecord = new Set<string>();
      for (const name of record.NAMES ?? []) {
        const fullName = name.NAME_FULL?.trim();
        if (!fullName) continue;
        const normalized = normalizeName(fullName);
        if (!normalized || seenNormalizedNamesForRecord.has(normalized)) continue;
        seenNormalizedNamesForRecord.add(normalized);
        const result = insertName.run(record.RECORD_ID, fullName, normalized, name.NAME_TYPE ?? null, JSON.stringify(normalizedTokens(normalized)));
        insertFts.run(normalized, fullName, record.RECORD_ID, result.lastInsertRowid);
      }
    });

    const insertTargetRecord = db.transaction((record: TargetNestedRecord) => {
      if (!record.id) throw new Error('targets.nested record missing id');
      insertSanctions.run(record.id, JSON.stringify((record.properties?.sanctions ?? []).map(toSanctionDetail)));
    });

    await readJsonlFile<SenzingRecord>(options.senzingPath, (record, lineNumber) => {
      if (!record.RECORD_ID) throw new Error(`Senzing record missing RECORD_ID at line ${lineNumber}`);
      insertSenzingRecord(record);
    });
    await readJsonlFile<TargetNestedRecord>(options.targetsNestedPath, (record) => insertTargetRecord(record));
    db.exec('ANALYZE;');
    if (!validateSqliteSchema(db)) throw new Error('SQLite schema validation failed after build.');
  } finally {
    db.close();
  }
}

function isDebarmentRecord(record: SenzingRecord): boolean {
  return (record.RISKS ?? []).some((risk) => risk.TOPIC?.trim().toLocaleLowerCase('en-US') === 'debarment');
}

function toSanctionDetail(sanction: TargetNestedSanction): SanctionDetail {
  const properties = sanction.properties ?? {};
  return {
    id: sanction.id,
    caption: sanction.caption,
    authority: cleanValues(properties.authority),
    status: cleanValues(properties.status),
    listingDate: cleanValues(properties.listingDate),
    startDate: cleanValues(properties.startDate),
    program: cleanValues(properties.program),
    provisions: cleanValues(properties.provisions),
    sourceUrl: cleanValues(properties.sourceUrl),
    summary: cleanValues(properties.summary),
  };
}

function cleanValues(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}
```

- [ ] **Step 5: Implement CLI script**

Create `src/scripts/buildSqlite.ts`:

```ts
import { loadConfig } from '../config.js';
import { buildSqliteDatabase } from '../data/sqliteBuilder.js';

const config = loadConfig(process.env, { requireToken: false });

await buildSqliteDatabase({
  senzingPath: config.senzingPath,
  targetsNestedPath: config.targetsNestedPath,
  sqlitePath: config.sqlitePath,
});

console.info(`SQLite database built at ${config.sqlitePath}.`);
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
npm test -- test/sqlite-builder.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add src/data/sqliteSchema.ts src/data/sqliteBuilder.ts src/scripts/buildSqlite.ts test/sqlite-builder.test.ts
git commit -m "Build SQLite database from JSONL sources"
```

### Task 5: SQLite Repositories

**Files:**
- Create: `src/data/sqliteRepositories.ts`
- Create: `test/sqlite-repositories.test.ts`

- [ ] **Step 1: Write failing repository tests**

Create `test/sqlite-repositories.test.ts` with fixture setup and assertions:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { DebarmentService } from '../src/domain/debarmentService.js';
import { buildSqliteDatabase } from '../src/data/sqliteBuilder.js';
import { SqliteSenzingRepository, SqliteTargetDetailsRepository } from '../src/data/sqliteRepositories.js';

const fixturesDir = path.join(process.cwd(), 'test/fixtures');

async function buildSqliteService() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-repositories-'));
  const sqlitePath = path.join(dir, 'sanction.sqlite');
  await buildSqliteDatabase({
    senzingPath: path.join(fixturesDir, 'senzing.fixture.jsonl'),
    targetsNestedPath: path.join(fixturesDir, 'targets.nested.fixture.jsonl'),
    sqlitePath,
  });
  const senzing = SqliteSenzingRepository.open(sqlitePath);
  const targets = SqliteTargetDetailsRepository.open(sqlitePath);
  const service = new DebarmentService(senzing, targets);
  return { service, senzing, targets };
}

describe('SQLite repositories', () => {
  test('matches exact primary names and aliases', async () => {
    const { service, senzing, targets } = await buildSqliteService();
    try {
      await expect(service.check('YATAI SMART INDUSTRIAL NEW CITY')).resolves.toMatchObject({ found: true });
      await expect(service.check('MYANMAR YATAI INTERNATIONAL HOLDING GROUP CO LTD')).resolves.toMatchObject({ found: true });
    } finally {
      senzing.close();
      targets.close();
    }
  });

  test('filters non-debarment records and returns full details by record id', async () => {
    const { service, senzing, targets } = await buildSqliteService();
    try {
      await expect(service.check('HARMLESS SHIPPING LTD')).resolves.toMatchObject({ found: false });
      await expect(service.fullByRecordId('NK-223CQDBzp8MRkdJMDiqXn3')).resolves.toMatchObject({
        found: true,
        matches: [{ sanctions: [{ authority: ['OFAC'] }] }],
      });
    } finally {
      senzing.close();
      targets.close();
    }
  });

  test('deduplicates multiple name hits for the same target', async () => {
    const { service, senzing, targets } = await buildSqliteService();
    try {
      const result = await service.searchCandidates('Yatai');
      expect(result.candidates.filter((candidate) => candidate.basic.recordId === 'NK-223CQDBzp8MRkdJMDiqXn3')).toHaveLength(1);
    } finally {
      senzing.close();
      targets.close();
    }
  });

  test('supports typo-tolerant candidate search and guards identifiers', async () => {
    const { service, senzing, targets } = await buildSqliteService();
    try {
      await expect(service.searchCandidates('Yatai Smrat')).resolves.toMatchObject({
        found: true,
        candidates: [{ basic: { recordId: 'NK-223CQDBzp8MRkdJMDiqXn3' } }],
      });
      await expect(service.searchCandidates('PW2XZT68KVW8')).resolves.toMatchObject({ found: false, candidates: [] });
    } finally {
      senzing.close();
      targets.close();
    }
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- test/sqlite-repositories.test.ts
```

Expected: FAIL because repository classes do not exist.

- [ ] **Step 3: Implement SQLite repositories**

Create `src/data/sqliteRepositories.ts` with:

```ts
import Database from 'better-sqlite3';
import { normalizeName } from '../domain/normalize.js';
import { normalizedTokens, scoreSearchableName } from '../domain/nameScoring.js';
import type { RepositoryStats, SanctionDetail, SenzingLookupRepository, SenzingNameCandidate, SenzingNameMatch, SenzingRecord, TargetDetailsRepository } from '../domain/types.js';
import { validateSqliteSchema } from './sqliteSchema.js';

interface NameRow {
  id: number;
  record_id: string;
  name_full: string;
  normalized_name: string;
  name_type: string | null;
  normalized_tokens_json: string;
  record_json: string;
}

export class SqliteSenzingRepository implements SenzingLookupRepository {
  private constructor(private readonly db: Database.Database) {}

  static open(sqlitePath: string): SqliteSenzingRepository {
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    if (!validateSqliteSchema(db)) {
      db.close();
      throw new Error('SQLite schema version is not compatible.');
    }
    return new SqliteSenzingRepository(db);
  }

  findByName(name: string): SenzingNameMatch[] {
    const normalized = normalizeName(name);
    if (!normalized) return [];
    const rows = this.db.prepare(`
      SELECT n.id, n.record_id, n.name_full, n.normalized_name, n.name_type, n.normalized_tokens_json, r.record_json
      FROM names n
      JOIN records r ON r.record_id = n.record_id
      WHERE n.normalized_name = ? AND r.is_debarment = 1
      ORDER BY n.name_type = 'PRIMARY' DESC, n.name_full ASC, n.record_id ASC
    `).all(normalized) as NameRow[];
    return dedupeMatches(rows.map(rowToNameMatch));
  }

  findCandidateNames(name: string): SenzingNameCandidate[] {
    const normalizedQuery = normalizeName(name);
    if (!normalizedQuery) return [];
    const queryTokens = normalizedTokens(normalizedQuery);
    const ftsQuery = toSafeFtsQuery(queryTokens);
    if (!ftsQuery) return [];
    const rows = this.db.prepare(`
      SELECT n.id, n.record_id, n.name_full, n.normalized_name, n.name_type, n.normalized_tokens_json, r.record_json
      FROM name_fts f
      JOIN names n ON n.id = f.name_id
      JOIN records r ON r.record_id = n.record_id
      WHERE name_fts MATCH ? AND r.is_debarment = 1
      LIMIT 1000
    `).all(ftsQuery) as NameRow[];
    const scored = rows.flatMap((row) => {
      const score = scoreSearchableName(normalizedQuery, queryTokens, {
        normalizedName: row.normalized_name,
        normalizedTokens: parseTokens(row.normalized_tokens_json),
      });
      return score ? [{ ...rowToNameMatch(row), ...score }] : [];
    });
    return dedupeCandidates(scored).sort((left, right) =>
      right.score - left.score ||
      primarySort(left) - primarySort(right) ||
      left.matchedName.localeCompare(right.matchedName, 'en-US') ||
      left.record.RECORD_ID.localeCompare(right.record.RECORD_ID, 'en-US'),
    );
  }

  findByRecordId(recordId: string): SenzingRecord | undefined {
    const row = this.db.prepare('SELECT record_json FROM records WHERE record_id = ? AND is_debarment = 1').get(recordId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as SenzingRecord : undefined;
  }

  stats(): RepositoryStats {
    const row = this.db.prepare('SELECT COUNT(*) AS records FROM records').get() as { records: number };
    const names = this.db.prepare('SELECT COUNT(*) AS indexedNames FROM names').get() as { indexedNames: number };
    return { records: row.records, indexedNames: names.indexedNames };
  }

  close(): void {
    this.db.close();
  }
}

export class SqliteTargetDetailsRepository implements TargetDetailsRepository {
  private constructor(private readonly db: Database.Database) {}

  static open(sqlitePath: string): SqliteTargetDetailsRepository {
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    if (!validateSqliteSchema(db)) {
      db.close();
      throw new Error('SQLite schema version is not compatible.');
    }
    return new SqliteTargetDetailsRepository(db);
  }

  findSanctionsByRecordId(recordId: string): SanctionDetail[] {
    const row = this.db.prepare('SELECT sanctions_json FROM target_sanctions WHERE record_id = ?').get(recordId) as { sanctions_json: string } | undefined;
    return row ? JSON.parse(row.sanctions_json) as SanctionDetail[] : [];
  }

  stats(): RepositoryStats {
    const row = this.db.prepare('SELECT COUNT(*) AS records FROM target_sanctions').get() as { records: number };
    return { records: row.records };
  }

  close(): void {
    this.db.close();
  }
}

function rowToNameMatch(row: NameRow): SenzingNameMatch {
  return {
    record: JSON.parse(row.record_json) as SenzingRecord,
    matchedName: row.name_full,
    matchedNameType: row.name_type,
  };
}

function parseTokens(raw: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
}

function dedupeMatches(matches: SenzingNameMatch[]): SenzingNameMatch[] {
  const bestByRecord = new Map<string, SenzingNameMatch>();
  for (const match of matches) {
    const existing = bestByRecord.get(match.record.RECORD_ID);
    if (!existing || primarySort(match) < primarySort(existing) || match.matchedName.localeCompare(existing.matchedName, 'en-US') < 0) {
      bestByRecord.set(match.record.RECORD_ID, match);
    }
  }
  return [...bestByRecord.values()];
}

function dedupeCandidates(candidates: SenzingNameCandidate[]): SenzingNameCandidate[] {
  const bestByRecord = new Map<string, SenzingNameCandidate>();
  for (const candidate of candidates) {
    const existing = bestByRecord.get(candidate.record.RECORD_ID);
    if (!existing || compareCandidate(candidate, existing) < 0) bestByRecord.set(candidate.record.RECORD_ID, candidate);
  }
  return [...bestByRecord.values()];
}

function compareCandidate(left: SenzingNameCandidate, right: SenzingNameCandidate): number {
  return right.score - left.score ||
    primarySort(left) - primarySort(right) ||
    left.matchedName.localeCompare(right.matchedName, 'en-US') ||
    left.record.RECORD_ID.localeCompare(right.record.RECORD_ID, 'en-US');
}

function primarySort(match: { matchedNameType?: string | null }): number {
  return match.matchedNameType?.toLocaleUpperCase('en-US') === 'PRIMARY' ? 0 : 1;
}

function toSafeFtsQuery(tokens: string[]): string {
  const safeTokens = tokens
    .map((token) => token.replace(/[^a-z0-9]/giu, ''))
    .filter((token) => token.length > 0)
    .map((token) => `${token}*`);
  return safeTokens.join(' ');
}
```

- [ ] **Step 4: Run tests and commit**

Run:

```bash
npm test -- test/sqlite-repositories.test.ts test/debarment-bot.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add src/data/sqliteRepositories.ts test/sqlite-repositories.test.ts
git commit -m "Query debarment data from SQLite"
```

### Task 6: Startup Bootstrap

**Files:**
- Create: `src/data/sqliteBootstrap.ts`
- Modify: `src/index.ts`
- Create: `test/sqlite-bootstrap.test.ts`

- [ ] **Step 1: Write failing bootstrap tests**

Create `test/sqlite-bootstrap.test.ts`:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { bootstrapSqliteRepositories } from '../src/data/sqliteBootstrap.js';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-bootstrap-'));
}

describe('SQLite bootstrap', () => {
  test('creates empty JSONL and empty SQLite when no local data exists', async () => {
    const dir = await tempDir();
    const result = await bootstrapSqliteRepositories({
      senzingPath: path.join(dir, 'senzing.json'),
      targetsNestedPath: path.join(dir, 'targets.nested.json'),
      sqlitePath: path.join(dir, 'sanction.sqlite'),
    });

    expect(result.shouldAutoRefresh).toBe(true);
    expect(result.senzingRepository.stats()).toEqual({ records: 0, indexedNames: 0 });
    await expect(fs.readFile(path.join(dir, 'senzing.json'), 'utf8')).resolves.toBe('');
    await expect(fs.readFile(path.join(dir, 'targets.nested.json'), 'utf8')).resolves.toBe('');
    result.close();
  });

  test('builds SQLite from JSONL when database is missing', async () => {
    const dir = await tempDir();
    await fs.copyFile(path.join(process.cwd(), 'test/fixtures/senzing.fixture.jsonl'), path.join(dir, 'senzing.json'));
    await fs.copyFile(path.join(process.cwd(), 'test/fixtures/targets.nested.fixture.jsonl'), path.join(dir, 'targets.nested.json'));

    const result = await bootstrapSqliteRepositories({
      senzingPath: path.join(dir, 'senzing.json'),
      targetsNestedPath: path.join(dir, 'targets.nested.json'),
      sqlitePath: path.join(dir, 'sanction.sqlite'),
    });

    expect(result.shouldAutoRefresh).toBe(false);
    expect(result.senzingRepository.stats().records).toBe(5);
    result.close();
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- test/sqlite-bootstrap.test.ts
```

Expected: FAIL because bootstrap module does not exist.

- [ ] **Step 3: Implement bootstrap module**

Create `src/data/sqliteBootstrap.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { SenzingMemoryRepository } from './senzingMemoryRepository.js';
import { TargetsNestedMemoryRepository } from './targetsNestedMemoryRepository.js';
import { createEmptySqliteDatabase, buildSqliteDatabase } from './sqliteBuilder.js';
import { SqliteSenzingRepository, SqliteTargetDetailsRepository } from './sqliteRepositories.js';

export interface BootstrapSqliteOptions {
  senzingPath: string;
  targetsNestedPath: string;
  sqlitePath: string;
}

export interface BootstrapSqliteResult {
  senzingRepository: SqliteSenzingRepository;
  targetDetailsRepository: SqliteTargetDetailsRepository;
  shouldAutoRefresh: boolean;
  close(): void;
}

export async function bootstrapSqliteRepositories(options: BootstrapSqliteOptions): Promise<BootstrapSqliteResult> {
  if (await exists(options.sqlitePath)) return openResult(options.sqlitePath, false);

  const hasSenzing = await exists(options.senzingPath);
  const hasTargets = await exists(options.targetsNestedPath);
  if (hasSenzing && hasTargets) {
    await buildSqliteDatabase(options);
    return openResult(options.sqlitePath, false);
  }

  await createEmptyJsonl(options.senzingPath);
  await createEmptyJsonl(options.targetsNestedPath);
  await createEmptySqliteDatabase(options.sqlitePath);
  return openResult(options.sqlitePath, true);
}

export async function loadMemoryRepositories(senzingPath: string, targetsNestedPath: string): Promise<{
  senzingRepository: SenzingMemoryRepository;
  targetDetailsRepository: TargetsNestedMemoryRepository;
}> {
  return {
    senzingRepository: await SenzingMemoryRepository.fromFile(senzingPath),
    targetDetailsRepository: await TargetsNestedMemoryRepository.fromFile(targetsNestedPath),
  };
}

function openResult(sqlitePath: string, shouldAutoRefresh: boolean): BootstrapSqliteResult {
  const senzingRepository = SqliteSenzingRepository.open(sqlitePath);
  const targetDetailsRepository = SqliteTargetDetailsRepository.open(sqlitePath);
  return {
    senzingRepository,
    targetDetailsRepository,
    shouldAutoRefresh,
    close() {
      senzingRepository.close();
      targetDetailsRepository.close();
    },
  };
}

async function createEmptyJsonl(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, '', { flag: 'wx' }).catch(async (error: unknown) => {
    if (isNodeError(error) && error.code === 'EEXIST') return;
    throw error;
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
```

- [ ] **Step 4: Wire startup**

Update `src/index.ts` repository loading block:

```ts
console.info('Bootstrapping SQLite data:', config.sqlitePath);
const bootstrap = await bootstrapSqliteRepositories({
  senzingPath: config.senzingPath,
  targetsNestedPath: config.targetsNestedPath,
  sqlitePath: config.sqlitePath,
});
console.info('Loaded SQLite senzing index:', bootstrap.senzingRepository.stats());
console.info('Loaded SQLite targets details:', bootstrap.targetDetailsRepository.stats());
```

Use `bootstrap.senzingRepository` and `bootstrap.targetDetailsRepository` in `ActiveDebarmentRepositories`.

After `Telegram bot started.` add:

```ts
if (bootstrap.shouldAutoRefresh) {
  void dataRefreshService.refreshNow().then((result) => {
    console.info('Initial data refresh completed:', result);
  }).catch((error: unknown) => {
    console.error('Initial data refresh failed:', error);
  });
}
```

Ensure imports use `bootstrapSqliteRepositories` and remove direct memory repository imports from `src/index.ts`.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- test/sqlite-bootstrap.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add src/data/sqliteBootstrap.ts src/index.ts test/sqlite-bootstrap.test.ts
git commit -m "Bootstrap SQLite data on startup"
```

### Task 7: SQLite-Aware Refresh

**Files:**
- Modify: `src/data/dataRefreshService.ts`
- Modify: `src/index.ts`
- Modify: `test/data-refresh.test.ts`

- [ ] **Step 1: Write failing refresh test**

Add to `test/data-refresh.test.ts`:

```ts
test('builds and swaps SQLite repositories when sqlitePath is configured', async () => {
  const harness = await createHarness({
    localMetadata: metadata('v1', { senzing: 'old-senzing', targets: 'old-targets' }),
    remoteMetadata: metadata('v2', { senzing: 'new-senzing', targets: 'new-targets' }),
  });
  const sqlitePath = path.join(harness.dir, 'sanction.sqlite');

  const sqliteRefresher = new DataRefreshService({
    senzingPath: harness.senzingPath,
    targetsNestedPath: harness.targetsNestedPath,
    sqlitePath,
    refreshMetadataPath: harness.refreshMetadataPath,
    activeRepositories: harness.activeRepositories,
    fetchMetadata: harness.fetchMetadata,
    downloader: harness.downloader,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });

  await expect(sqliteRefresher.refreshNow()).resolves.toMatchObject({ status: 'updated', version: 'v2' });
  await expect(harness.service.check('NEW PLAYER')).resolves.toMatchObject({ found: true });
  await expect(fs.stat(sqlitePath)).resolves.toMatchObject({ isFile: expect.any(Function) });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- test/data-refresh.test.ts
```

Expected: FAIL because `sqlitePath` is not supported by refresh options.

- [ ] **Step 3: Extend refresh options**

In `src/data/dataRefreshService.ts`, update options:

```ts
sqlitePath?: string;
```

After downloading and validating staged JSONL, build a staged SQLite path when configured:

```ts
const stagedSqlitePath = this.options.sqlitePath ? path.join(tempDir, 'sanction.sqlite') : undefined;
if (stagedSqlitePath) {
  await buildSqliteDatabase({
    senzingPath: stagedSenzingPath,
    targetsNestedPath: stagedTargetsPath,
    sqlitePath: stagedSqlitePath,
  });
}
```

Open replacement repositories from SQLite when `stagedSqlitePath` exists:

```ts
const nextSenzingRepository = stagedSqlitePath
  ? SqliteSenzingRepository.open(stagedSqlitePath)
  : await SenzingMemoryRepository.fromFile(stagedSenzingPath);
const nextTargetsRepository = stagedSqlitePath
  ? SqliteTargetDetailsRepository.open(stagedSqlitePath)
  : await TargetsNestedMemoryRepository.fromFile(stagedTargetsPath);
```

Extend publish options to include SQLite:

```ts
stagedSqlitePath,
sqlitePath: this.options.sqlitePath,
```

In `replaceLocalFilesAndMetadata`, backup and copy SQLite if both paths are present:

```ts
const sqliteBackupPath = options.sqlitePath ? `${options.sqlitePath}${backupSuffix}` : undefined;
const movedSqlite = options.sqlitePath && sqliteBackupPath ? await moveIfExists(options.sqlitePath, sqliteBackupPath) : false;
...
if (options.stagedSqlitePath && options.sqlitePath) await fs.copyFile(options.stagedSqlitePath, options.sqlitePath);
...
if (movedSqlite && sqliteBackupPath && options.sqlitePath) await fs.rename(sqliteBackupPath, options.sqlitePath);
```

- [ ] **Step 4: Pass sqlitePath from startup**

In `src/index.ts`, pass:

```ts
sqlitePath: config.sqlitePath,
```

to `DataRefreshService`.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- test/data-refresh.test.ts test/sqlite-repositories.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add src/data/dataRefreshService.ts src/index.ts test/data-refresh.test.ts
git commit -m "Refresh SQLite data atomically"
```

### Task 8: Documentation And Operator Workflow

**Files:**
- Modify: `README.md`
- Modify: `docs/telegram-operation-guide.md`

- [ ] **Step 1: Update README database sections**

Add `SQLITE_PATH` to the environment variable table:

```markdown
| `SQLITE_PATH` | `./sanction.sqlite` | 本地 SQLite 查询库路径。首次启动缺少 DB 时会从 JSONL 构建；如果 DB 和 JSONL 都不存在，会创建空库并在启动后自动执行数据刷新。 |
```

Add an offline build section:

Add this Markdown text:

    ### 构建 SQLite 查询库

    可以在部署前离线构建数据库：

    ```bash
    npm run db:build
    ```

    该命令读取 `SENZING_PATH` 和 `TARGETS_NESTED_PATH`，输出到 `SQLITE_PATH`。构建失败不会覆盖已有数据库。

Add startup behavior:

```markdown
启动时优先读取 `SQLITE_PATH`。如果数据库不存在但 JSONL 文件存在，程序会先构建 SQLite 再启动。若数据库和 JSONL 都不存在，程序会创建空 JSONL 与空 SQLite，让机器人先启动，然后自动触发一次 OpenSanctions 数据刷新。
```

- [ ] **Step 2: Update operation guide**

In `docs/telegram-operation-guide.md`, add:

```markdown
## SQLite 数据库

生产环境建议保留 `SQLITE_PATH` 指向的数据库文件。管理员仍然使用 `/update` 刷新数据；刷新会先构建新 SQLite 文件，校验通过后再切换，失败时旧数据库继续服务。

首次部署可以只配置 Telegram token 和管理员 ID。若本地没有数据库和 JSONL 数据文件，机器人会以空库启动，并自动开始一次数据刷新。刷新期间查询会提示本地数据尚未加载。
```

- [ ] **Step 3: Run docs-adjacent checks and commit**

Run:

```bash
npm test -- test/package-scripts.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add README.md docs/telegram-operation-guide.md
git commit -m "Document SQLite database operations"
```

### Task 9: Full Verification And Cleanup

**Files:**
- Review: all modified files

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

Expected: PASS and `dist/` output generated.

- [ ] **Step 4: Smoke-test offline SQLite build**

Run:

```bash
$env:SENZING_PATH='test/fixtures/senzing.fixture.jsonl'
$env:TARGETS_NESTED_PATH='test/fixtures/targets.nested.fixture.jsonl'
$env:SQLITE_PATH="$env:TEMP\sanction-fixture.sqlite"
npm run db:build
```

Expected: command prints `SQLite database built at ...`.

- [ ] **Step 5: Check git status**

Run:

```bash
git status --short
```

Expected: only intended implementation files are modified. Do not stage unrelated files from the original dirty workspace.

- [ ] **Step 6: Final commit if any verification-only fixes were needed**

If verification required code changes, commit them:

```bash
git add <only task-owned files>
git commit -m "Verify SQLite query backend"
```

If no changes were needed after Task 8, skip this commit.

## Self-Review

Spec coverage:

- SQLite database selection and native dependency: Task 1.
- Schema, FTS5, records, names, target sanctions: Task 4.
- Exact lookup, `/full`, candidate search, typo tolerance, identifier guard, dedup: Tasks 3 and 5.
- Empty bootstrap with auto-update: Tasks 2 and 6.
- Runtime `/update` build and atomic swap: Task 7.
- Offline database build: Tasks 1, 4, and 9.
- Documentation: Task 8.
- Verification: Task 9.

Unfinished-marker scan:

- No banned unfinished-marker or copy-forward steps are present.
- Each code-changing task includes concrete file paths, code blocks, commands, expected outcomes, and commit commands.

Type consistency:

- `sqlitePath` is introduced in `AppConfig`, passed to bootstrap and refresh, and documented as `SQLITE_PATH`.
- `RepositoryDataStatus` is optional on both query result types and consumed only by formatters.
- `SqliteSenzingRepository` and `SqliteTargetDetailsRepository` implement the existing repository interfaces and expose `close()` for lifecycle management.
- `buildSqliteDatabase()` is shared by offline build, startup bootstrap, and refresh.
