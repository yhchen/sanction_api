# Sanctioned Securities CSV Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend every existing Telegram query path to return merged company-level Debarred and Sanctioned Securities results using OpenSanctions `securities.csv`.

**Architecture:** Keep SQLite as the runtime query store. Import debarment JSONL and securities CSV into one company-level SQLite index, using conservative merge rules and existing exact/fuzzy lookup semantics. Preserve current command names while expanding domain DTOs and formatters to show one merged result when a company is both Debarred and Sanctioned Securities.

**Tech Stack:** TypeScript, Node.js 20, `better-sqlite3`, Telegraf, Vitest, streaming file I/O, OpenSanctions JSONL and CSV metadata.

---

## File Structure

- Create: `src/data/securitiesCsv.ts`
  - Stream and parse `securities.csv`.
  - Normalize OpenSanctions CSV rows into typed `SecuritiesCsvRecord` objects.
  - Parse semicolon multi-value cells and `t` / `f` booleans.

- Create: `test/fixtures/securities.fixture.csv`
  - Small fixture with securities-only, debarment-overlap, LEI-overlap, and ambiguous-name rows.

- Create: `test/securities-csv.test.ts`
  - Unit tests for CSV parsing and normalization.

- Modify: `src/domain/types.ts`
  - Add `ScreeningStatus`, `SecuritiesDetail`, and status-aware result fields.
  - Extend `TargetDetailsRepository` to expose securities details.

- Modify: `src/domain/debarmentService.ts`
  - Replace Debarred-only filtering with screening-status filtering.
  - Materialize merged status and optional securities details.
  - Keep public method names to avoid changing Telegram handlers.

- Modify: `src/data/targetsNestedMemoryRepository.ts`
  - Implement the new `TargetDetailsRepository.findSecuritiesByRecordId()` method as `undefined`.

- Modify: `src/data/sqliteSchema.ts`
  - Bump schema version to `2`.
  - Add `is_sanctioned_securities` and `securities_json` support.
  - Add `securities_details` table and indexes.

- Modify: `src/data/sqliteBuilder.ts`
  - Accept `securitiesPath`.
  - Import securities CSV after debarment JSONL.
  - Merge by exact OpenSanctions id first, then unique LEI/PermID, then unique normalized name plus overlapping country.
  - Index securities caption and aliases in the existing `names` / `name_fts` tables.

- Modify: `src/data/sqliteRepositories.ts`
  - Query records where `is_debarment = 1 OR is_sanctioned_securities = 1`.
  - Return securities details from `securities_details`.

- Modify: `src/config.ts`
  - Add `securitiesPath`, default `./securities.csv`.

- Modify: `src/data/sqliteBootstrap.ts`
  - Treat `securities.csv` as a required source when rebuilding SQLite.
  - Preserve existing populated SQLite startup behavior.
  - Create empty securities seed file on first-run bootstrap.

- Modify: `src/scripts/buildSqlite.ts`
  - Pass `securitiesPath` to the builder.

- Modify: `src/index.ts`
  - Log and pass `securitiesPath`.

- Modify: `src/data/dataRefreshService.ts`
  - Fetch both debarment and securities metadata.
  - Track three resources: `senzing.json`, `targets.nested.json`, `securities.csv`.
  - Download, validate, stage, publish, and rebuild atomically.

- Modify: `src/bot/formatters.ts`
  - Show status line and securities details.
  - Keep fuzzy search candidate-only wording.

- Modify: `.env.example`, `README.md`, `docs/telegram-operation-guide.md`
  - Document `SECURITIES_PATH`, merged status behavior, and data refresh inputs.

- Modify tests:
  - `test/sqlite-builder.test.ts`
  - `test/sqlite-repositories.test.ts`
  - `test/sqlite-bootstrap.test.ts`
  - `test/data-refresh.test.ts`
  - `test/debarment-bot.test.ts`
  - `test/package-scripts.test.ts` if script/env expectations mention source paths.

## Task 1: Securities CSV Parser

**Files:**
- Create: `src/data/securitiesCsv.ts`
- Create: `test/fixtures/securities.fixture.csv`
- Create: `test/securities-csv.test.ts`

- [ ] **Step 1: Add the fixture**

Create `test/fixtures/securities.fixture.csv`:

```csv
"caption","lei","perm_id","isins","ric","countries","sanctioned","eo_14071","public","id","url","datasets","risk_datasets","aliases","referents"
"YATAI SMART INDUSTRIAL NEW CITY","","","","","mm","t","f","f","NK-223CQDBzp8MRkdJMDiqXn3","https://www.opensanctions.org/entities/NK-223CQDBzp8MRkdJMDiqXn3","us_ofac_sdn","us_ofac_sdn","Myanmar Yatai International Holding Group Co., LTD.;Yatai New City","ofac-54742;usgsa-s4mrwvjp8"
"SECURITIES ONLY LTD","213800SS45WKYIT4EP89","5063730210","RU000A0JX0J2;RU000A0JX0J3","ONLY.MM","ru","f","t","t","NK-SECURITIESONLY","https://www.opensanctions.org/entities/NK-SECURITIESONLY","ru_nsd_isin","ru_nsd_isin","Securities Only Limited;Only Securities","lei-213800SS45WKYIT4EP89;permid-5063730210"
"LEI MERGED COMPANY","529900T8BM49AURSDO55","","","","gb","t","f","f","NK-SEC-LEI","https://www.opensanctions.org/entities/NK-SEC-LEI","gb_hmt_invbans","gb_hmt_invbans","LEI Merge Alias","lei-529900T8BM49AURSDO55"
"AMBIGUOUS SHARED NAME","","","","","us","t","f","f","NK-SEC-AMBIGUOUS","https://www.opensanctions.org/entities/NK-SEC-AMBIGUOUS","us_ofac_sdn","us_ofac_sdn","Shared Alias","ofac-ambiguous"
```

- [ ] **Step 2: Write parser tests first**

Create `test/securities-csv.test.ts`:

```ts
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { readSecuritiesCsvFile, splitOpenSanctionsCsvList } from '../src/data/securitiesCsv.js';

const fixturePath = path.join(process.cwd(), 'test/fixtures/securities.fixture.csv');

describe('securities CSV parser', () => {
  test('streams securities CSV rows by header name', async () => {
    const rows = [];
    await readSecuritiesCsvFile(fixturePath, (row) => {
      rows.push(row);
    });

    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      id: 'NK-223CQDBzp8MRkdJMDiqXn3',
      caption: 'YATAI SMART INDUSTRIAL NEW CITY',
      countries: ['mm'],
      sanctioned: true,
      eo14071: false,
      isins: [],
      aliases: ['Myanmar Yatai International Holding Group Co., LTD.', 'Yatai New City'],
      referents: expect.arrayContaining(['ofac-54742', 'usgsa-s4mrwvjp8']),
    });
    expect(rows[1]).toMatchObject({
      id: 'NK-SECURITIESONLY',
      lei: ['213800SS45WKYIT4EP89'],
      permId: ['5063730210'],
      isins: ['RU000A0JX0J2', 'RU000A0JX0J3'],
      ric: ['ONLY.MM'],
      public: true,
    });
  });

  test('parses semicolon lists and trims empty values', () => {
    expect(splitOpenSanctionsCsvList(' A ; ;B; C ')).toEqual(['A', 'B', 'C']);
  });
});
```

- [ ] **Step 3: Run the focused test and confirm it fails**

Run:

```bash
npm test -- test/securities-csv.test.ts
```

Expected: FAIL because `src/data/securitiesCsv.ts` does not exist.

- [ ] **Step 4: Implement the parser**

Create `src/data/securitiesCsv.ts`:

```ts
import fs from 'node:fs';
import readline from 'node:readline';

export interface SecuritiesCsvRecord {
  caption: string;
  lei: string[];
  permId: string[];
  isins: string[];
  ric: string[];
  countries: string[];
  sanctioned: boolean;
  eo14071: boolean;
  public: boolean;
  id: string;
  url: string;
  datasets: string[];
  riskDatasets: string[];
  aliases: string[];
  referents: string[];
}

export async function readSecuritiesCsvFile(
  filePath: string,
  onRecord: (record: SecuritiesCsvRecord, lineNumber: number) => void | Promise<void>,
): Promise<void> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header: string[] | undefined;
  let lineNumber = 0;

  for await (const line of lines) {
    lineNumber += 1;
    if (lineNumber === 1) {
      header = parseCsvLine(line).map((value) => value.trim());
      continue;
    }
    if (!line.trim()) continue;
    if (!header) throw new Error('securities.csv missing header row.');
    await onRecord(toSecuritiesRecord(header, parseCsvLine(line), lineNumber), lineNumber);
  }
}

export function splitOpenSanctionsCsvList(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(';').map((item) => item.trim()).filter(Boolean))];
}

function toSecuritiesRecord(header: string[], values: string[], lineNumber: number): SecuritiesCsvRecord {
  const row = Object.fromEntries(header.map((name, index) => [name, values[index] ?? '']));
  const id = clean(row.id);
  const caption = clean(row.caption);
  if (!id) throw new Error(`securities.csv row missing id at line ${lineNumber}`);
  if (!caption) throw new Error(`securities.csv row missing caption at line ${lineNumber}`);

  return {
    caption,
    lei: splitOpenSanctionsCsvList(row.lei),
    permId: splitOpenSanctionsCsvList(row.perm_id),
    isins: splitOpenSanctionsCsvList(row.isins),
    ric: splitOpenSanctionsCsvList(row.ric),
    countries: splitOpenSanctionsCsvList(row.countries),
    sanctioned: parseBoolean(row.sanctioned, 'sanctioned', lineNumber),
    eo14071: parseBoolean(row.eo_14071, 'eo_14071', lineNumber),
    public: parseBoolean(row.public, 'public', lineNumber),
    id,
    url: clean(row.url),
    datasets: splitOpenSanctionsCsvList(row.datasets),
    riskDatasets: splitOpenSanctionsCsvList(row.risk_datasets),
    aliases: splitOpenSanctionsCsvList(row.aliases),
    referents: splitOpenSanctionsCsvList(row.referents),
  };
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += char;
    }
  }

  values.push(value);
  return values;
}

function parseBoolean(value: string | undefined, field: string, lineNumber: number): boolean {
  const normalized = clean(value).toLocaleLowerCase('en-US');
  if (normalized === 't') return true;
  if (normalized === 'f') return false;
  throw new Error(`securities.csv ${field} must be t or f at line ${lineNumber}`);
}

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}
```

- [ ] **Step 5: Verify parser tests pass**

Run:

```bash
npm test -- test/securities-csv.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add src/data/securitiesCsv.ts test/securities-csv.test.ts test/fixtures/securities.fixture.csv
git commit -m "Parse OpenSanctions securities CSV rows" -m "Constraint: production CSV files are large, so parsing is streaming and header-based." -m "Confidence: high" -m "Scope-risk: narrow" -m "Directive: Do not replace this with full-file CSV loading." -m "Tested: npm test -- test/securities-csv.test.ts" -m "Not-tested: Full production securities.csv import."
```

## Task 2: Domain Types And Screening Status Semantics

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/debarmentService.ts`
- Modify: `src/data/targetsNestedMemoryRepository.ts`
- Test: `test/debarment-bot.test.ts`

- [ ] **Step 1: Write service tests for status semantics**

Append these tests near existing service-level tests in `test/debarment-bot.test.ts`:

```ts
test('reports securities-only exact matches as Sanctioned Securities', async () => {
  const service = new DebarmentService(
    SenzingMemoryRepository.fromRecords([{
      DATA_SOURCE: 'SECURITIES',
      RECORD_ID: 'SEC-1',
      NAMES: [{ NAME_TYPE: 'PRIMARY', NAME_FULL: 'SECURITIES ONLY LTD' }],
      RISKS: [{ TOPIC: 'sanctioned_securities' }],
      URL: 'https://www.opensanctions.org/entities/SEC-1',
    }]),
    TargetsNestedMemoryRepository.fromRecords([]),
  );

  await expect(service.check('SECURITIES ONLY LTD')).resolves.toMatchObject({
    found: true,
    matches: [{
      basic: {
        recordId: 'SEC-1',
        statuses: ['sanctioned_securities'],
        risks: ['sanctioned_securities'],
      },
    }],
  });
});

test('reports merged debarred and securities statuses once', async () => {
  const service = new DebarmentService(
    SenzingMemoryRepository.fromRecords([{
      DATA_SOURCE: 'MERGED',
      RECORD_ID: 'MERGED-1',
      NAMES: [{ NAME_TYPE: 'PRIMARY', NAME_FULL: 'MERGED COMPANY LTD' }],
      RISKS: [{ TOPIC: 'debarment' }, { TOPIC: 'sanctioned_securities' }],
    }]),
    TargetsNestedMemoryRepository.fromRecords([]),
  );

  await expect(service.check('MERGED COMPANY LTD')).resolves.toMatchObject({
    found: true,
    matches: [{
      basic: {
        recordId: 'MERGED-1',
        statuses: ['debarred', 'sanctioned_securities'],
      },
    }],
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "securities-only|merged debarred"
```

Expected: FAIL because the service still filters to `debarment` only and `BasicInfo.statuses` does not exist.

- [ ] **Step 3: Extend domain types**

Modify `src/domain/types.ts` with these additions:

```ts
export type ScreeningStatus = 'debarred' | 'sanctioned_securities';

export interface SecuritiesDetail {
  caption: string;
  lei: string[];
  permId: string[];
  isins: string[];
  ric: string[];
  countries: string[];
  sanctioned: boolean;
  eo14071: boolean;
  public: boolean;
  datasets: string[];
  riskDatasets: string[];
  referents: string[];
  url?: string;
}
```

Update `TargetDetailsRepository`:

```ts
export interface TargetDetailsRepository {
  findSanctionsByRecordId(recordId: string): SanctionDetail[];
  findSecuritiesByRecordId(recordId: string): SecuritiesDetail | undefined;
  stats(): RepositoryStats;
}
```

Update `BasicInfo`:

```ts
export interface BasicInfo {
  recordId: string;
  primaryName: string;
  matchedName: string;
  matchedNameType?: string | null;
  statuses: ScreeningStatus[];
  aliases: string[];
  risks: string[];
  countries: string[];
  addresses: string[];
  identifiers: Array<{ type: string; value: string }>;
  url?: string;
}
```

Update `DebarmentMatch`:

```ts
export interface DebarmentMatch {
  record: SenzingRecord;
  matchedName: string;
  matchedNameType?: string | null;
  basic: BasicInfo;
  sanctions: SanctionDetail[];
  securities?: SecuritiesDetail;
}
```

- [ ] **Step 4: Update memory details repository**

Modify `src/data/targetsNestedMemoryRepository.ts` inside `TargetsNestedMemoryRepository`:

```ts
findSecuritiesByRecordId(_recordId: string): undefined {
  return undefined;
}
```

- [ ] **Step 5: Update service filtering and materialization**

In `src/domain/debarmentService.ts`, replace `isDebarmentRecord` usage with a screening-aware helper.

Change exact filtering:

```ts
const allMatches = repositories.senzingRepository.findByName(name).filter((match) => isScreeningRecord(match.record));
```

Change candidate filtering:

```ts
.filter((candidate) => isScreeningRecord(candidate.record)),
```

Change record-id filtering:

```ts
if (!record || !isScreeningRecord(record)) {
  return emptyResult(recordId, dataStatus);
}
```

In `materialize`, fetch securities details:

```ts
const securities = includeTargetDetails
  ? targetDetailsRepository?.findSecuritiesByRecordId(match.record.RECORD_ID)
  : undefined;
return {
  ...match,
  basic: toBasicInfo(match),
  sanctions,
  securities,
};
```

Replace `isDebarmentRecord` with:

```ts
function screeningStatuses(record: SenzingRecord): ScreeningStatus[] {
  const topics = new Set((record.RISKS ?? []).map((risk) => risk.TOPIC?.trim().toLocaleLowerCase('en-US')).filter(Boolean));
  const statuses: ScreeningStatus[] = [];
  if (topics.has('debarment')) statuses.push('debarred');
  if (topics.has('sanctioned_securities')) statuses.push('sanctioned_securities');
  return statuses;
}

function isScreeningRecord(record: SenzingRecord): boolean {
  return screeningStatuses(record).length > 0;
}
```

Add statuses to `toBasicInfo`:

```ts
statuses: screeningStatuses(record),
```

- [ ] **Step 6: Verify domain tests pass**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "securities-only|merged debarred"
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

Run:

```bash
git add src/domain/types.ts src/domain/debarmentService.ts src/data/targetsNestedMemoryRepository.ts test/debarment-bot.test.ts
git commit -m "Represent merged screening statuses" -m "Constraint: Telegram command names remain unchanged while results expand beyond Debarred-only records." -m "Confidence: high" -m "Scope-risk: moderate" -m "Directive: Keep fuzzy search candidate-only; do not turn partial matches into verdicts." -m "Tested: npm test -- test/debarment-bot.test.ts -t \"securities-only|merged debarred\"" -m "Not-tested: SQLite-backed securities records."
```

## Task 3: SQLite Schema, Builder, And Repository Support

**Files:**
- Modify: `src/data/sqliteSchema.ts`
- Modify: `src/data/sqliteBuilder.ts`
- Modify: `src/data/sqliteRepositories.ts`
- Test: `test/sqlite-builder.test.ts`
- Test: `test/sqlite-repositories.test.ts`

- [ ] **Step 1: Add builder and repository tests**

In `test/sqlite-builder.test.ts`, pass `securitiesPath` to existing `buildSqliteDatabase` calls:

```ts
const securitiesFixture = path.join(process.cwd(), 'test/fixtures/securities.fixture.csv');
```

Then update each call:

```ts
await buildSqliteDatabase({
  senzingPath: senzingFixture,
  targetsNestedPath: targetsNestedFixture,
  securitiesPath: securitiesFixture,
  sqlitePath,
});
```

Add assertions in `builds a searchable SQLite database from JSONL fixtures`:

```ts
expect(scalarCount(db, 'SELECT COUNT(*) AS count FROM securities_details')).toBe(4);
expect(scalarCount(db, 'SELECT COUNT(*) AS count FROM records WHERE is_sanctioned_securities = 1')).toBe(4);
expect(
  db.prepare('SELECT record_id, name_full, normalized_name FROM names WHERE normalized_name = ?').get('securities only ltd') as NameRow | undefined,
).toMatchObject({
  record_id: 'NK-SECURITIESONLY',
  name_full: 'SECURITIES ONLY LTD',
});
```

In `test/sqlite-repositories.test.ts`, pass `securitiesPath` to helper builders and add:

```ts
test('exact securities-only hit returns sanctioned securities status', async () => {
  await withSqliteService(async (service) => {
    await expect(service.check('SECURITIES ONLY LTD')).resolves.toMatchObject({
      found: true,
      matches: [{ basic: { recordId: 'NK-SECURITIESONLY', statuses: ['sanctioned_securities'] } }],
    });
  });
});

test('same OpenSanctions id merges debarment and securities into one exact result', async () => {
  await withSqliteService(async (service) => {
    await expect(service.check('YATAI SMART INDUSTRIAL NEW CITY')).resolves.toMatchObject({
      found: true,
      matches: [{
        basic: {
          recordId: 'NK-223CQDBzp8MRkdJMDiqXn3',
          statuses: ['debarred', 'sanctioned_securities'],
        },
      }],
      totalMatches: 1,
    });
  });
});

test('fullByRecordId returns securities details', async () => {
  await withSqliteService(async (service) => {
    await expect(service.fullByRecordId('NK-SECURITIESONLY')).resolves.toMatchObject({
      found: true,
      matches: [{
        securities: {
          caption: 'SECURITIES ONLY LTD',
          isins: ['RU000A0JX0J2', 'RU000A0JX0J3'],
          eo14071: true,
        },
      }],
    });
  });
});
```

- [ ] **Step 2: Run SQLite tests and confirm they fail**

Run:

```bash
npm test -- test/sqlite-builder.test.ts test/sqlite-repositories.test.ts
```

Expected: FAIL because schema and builder do not know `securitiesPath` or `securities_details`.

- [ ] **Step 3: Upgrade SQLite schema**

Modify `src/data/sqliteSchema.ts`:

```ts
export const SQLITE_SCHEMA_VERSION = '2';
```

Change `records`:

```sql
CREATE TABLE IF NOT EXISTS records (
  record_id TEXT PRIMARY KEY,
  record_json TEXT NOT NULL,
  is_debarment INTEGER NOT NULL,
  is_sanctioned_securities INTEGER NOT NULL DEFAULT 0
);
```

Add table:

```sql
CREATE TABLE IF NOT EXISTS securities_details (
  record_id TEXT PRIMARY KEY,
  securities_json TEXT NOT NULL
);
```

Add index:

```sql
CREATE INDEX IF NOT EXISTS idx_records_sanctioned_securities ON records(is_sanctioned_securities);
```

Update required tables:

```ts
const requiredTables = ['schema_metadata', 'records', 'names', 'target_sanctions', 'securities_details', 'name_fts'];
```

Update required indexes:

```ts
const requiredIndexes = ['idx_names_normalized_name', 'idx_names_record_id', 'idx_records_debarment', 'idx_records_sanctioned_securities'];
```

- [ ] **Step 4: Extend builder options and import securities**

Modify `src/data/sqliteBuilder.ts` imports:

```ts
import { readSecuritiesCsvFile, type SecuritiesCsvRecord } from './securitiesCsv.js';
```

Update options:

```ts
export interface BuildSqliteDatabaseOptions {
  senzingPath: string;
  targetsNestedPath: string;
  securitiesPath: string;
  sqlitePath: string;
}
```

In `runBuildTransaction`, call after `insertTargetSanctions`:

```ts
await insertSecuritiesRecords(db, options.securitiesPath);
```

Change record insert SQL:

```ts
const insertRecord = db.prepare('INSERT INTO records (record_id, record_json, is_debarment, is_sanctioned_securities) VALUES (?, ?, ?, ?)');
```

Change insert run:

```ts
insertRecord.run(record.RECORD_ID, JSON.stringify(record), isDebarment(record) ? 1 : 0, isSanctionedSecurities(record) ? 1 : 0);
```

Add helpers:

```ts
function isSanctionedSecurities(record: SenzingRecord): boolean {
  return (record.RISKS ?? []).some((risk) => risk.TOPIC?.trim().toLocaleLowerCase('en-US') === 'sanctioned_securities');
}
```

Add securities import functions:

```ts
async function insertSecuritiesRecords(db: Database.Database, securitiesPath: string): Promise<void> {
  const findRecord = db.prepare('SELECT record_json, is_debarment FROM records WHERE record_id = ?');
  const upsertRecord = db.prepare(`
    INSERT INTO records (record_id, record_json, is_debarment, is_sanctioned_securities)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(record_id) DO UPDATE SET
      record_json = excluded.record_json,
      is_sanctioned_securities = 1
  `);
  const insertSecurities = db.prepare(`
    INSERT INTO securities_details (record_id, securities_json)
    VALUES (?, ?)
    ON CONFLICT(record_id) DO UPDATE SET securities_json = excluded.securities_json
  `);
  const insertName = db.prepare(
    'INSERT INTO names (record_id, name_full, normalized_name, name_type, normalized_tokens_json) VALUES (?, ?, ?, ?, ?)',
  );
  const insertNameFts = db.prepare('INSERT INTO name_fts (normalized_name, name_full, record_id, name_id) VALUES (?, ?, ?, ?)');

  await readSecuritiesCsvFile(securitiesPath, (security) => {
    const existing = findRecord.get(security.id) as { record_json: string; is_debarment: number } | undefined;
    const record = existing
      ? mergeSecurityIntoRecord(JSON.parse(existing.record_json) as SenzingRecord, security)
      : securityToSenzingRecord(security);
    upsertRecord.run(record.RECORD_ID, JSON.stringify(record), existing?.is_debarment ?? 0);
    insertSecurities.run(security.id, JSON.stringify(toSecuritiesDetail(security)));
    insertNamesForRecord(insertName, insertNameFts, record.RECORD_ID, record.NAMES ?? []);
  });
}
```

Refactor the existing name insert loop into:

```ts
function insertNamesForRecord(
  insertName: Database.Statement,
  insertNameFts: Database.Statement,
  recordId: string,
  names: SenzingName[],
): void {
  const seenNormalizedNamesForRecord = new Set<string>();
  for (const name of names) {
    const fullName = name.NAME_FULL?.trim();
    if (!fullName) continue;
    const normalized = normalizeName(fullName);
    if (!normalized || seenNormalizedNamesForRecord.has(normalized)) continue;
    seenNormalizedNamesForRecord.add(normalized);
    const tokensJson = JSON.stringify(normalizedTokens(normalized));
    const result = insertName.run(recordId, fullName, normalized, name.NAME_TYPE ?? null, tokensJson) as InsertNameResult;
    insertNameFts.run(normalized, fullName, recordId, Number(result.lastInsertRowid));
  }
}
```

Add conversion helpers:

```ts
function securityToSenzingRecord(security: SecuritiesCsvRecord): SenzingRecord {
  return {
    DATA_SOURCE: 'OPEN_SANCTIONS_SECURITIES',
    RECORD_ID: security.id,
    NAMES: toSenzingNames(security),
    RISKS: [{ TOPIC: 'sanctioned_securities' }],
    COUNTRIES: security.countries.map((country) => ({ COUNTRY: country })),
    IDENTIFIERS: [
      ...security.lei.map((value) => ({ OTHER_ID_TYPE: 'LEI', OTHER_ID_NUMBER: value })),
      ...security.permId.map((value) => ({ OTHER_ID_TYPE: 'PermID', OTHER_ID_NUMBER: value })),
      ...security.isins.map((value) => ({ OTHER_ID_TYPE: 'ISIN', OTHER_ID_NUMBER: value })),
      ...security.ric.map((value) => ({ OTHER_ID_TYPE: 'RIC', OTHER_ID_NUMBER: value })),
    ],
    URL: security.url || undefined,
  };
}

function mergeSecurityIntoRecord(record: SenzingRecord, security: SecuritiesCsvRecord): SenzingRecord {
  return {
    ...record,
    NAMES: mergeNames(record.NAMES ?? [], toSenzingNames(security)),
    RISKS: mergeRisks(record.RISKS ?? [], [{ TOPIC: 'sanctioned_securities' }]),
    COUNTRIES: [...(record.COUNTRIES ?? []), ...security.countries.map((country) => ({ COUNTRY: country }))],
    IDENTIFIERS: [...(record.IDENTIFIERS ?? []), ...securityToSenzingRecord(security).IDENTIFIERS!],
    URL: record.URL ?? security.url,
  };
}

function toSenzingNames(security: SecuritiesCsvRecord): SenzingName[] {
  return [
    { NAME_TYPE: 'PRIMARY', NAME_FULL: security.caption },
    ...security.aliases
      .filter((alias) => alias !== security.caption)
      .map((alias) => ({ NAME_TYPE: 'ALIAS', NAME_FULL: alias })),
  ];
}

function mergeNames(left: SenzingName[], right: SenzingName[]): SenzingName[] {
  const seen = new Set<string>();
  return [...left, ...right].filter((name) => {
    const key = normalizeName(name.NAME_FULL ?? '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeRisks(left: SenzingRisk[], right: SenzingRisk[]): SenzingRisk[] {
  const seen = new Set<string>();
  return [...left, ...right].filter((risk) => {
    const key = risk.TOPIC?.trim().toLocaleLowerCase('en-US') ?? '';
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toSecuritiesDetail(security: SecuritiesCsvRecord): SecuritiesDetail {
  return {
    caption: security.caption,
    lei: security.lei,
    permId: security.permId,
    isins: security.isins,
    ric: security.ric,
    countries: security.countries,
    sanctioned: security.sanctioned,
    eo14071: security.eo14071,
    public: security.public,
    datasets: security.datasets,
    riskDatasets: security.riskDatasets,
    referents: security.referents,
    url: security.url || undefined,
  };
}
```

Add missing type imports from `src/domain/types.ts`:

```ts
import type { SanctionDetail, SecuritiesDetail, SenzingName, SenzingRecord, SenzingRisk, TargetNestedRecord, TargetNestedSanction } from '../domain/types.js';
```

- [ ] **Step 5: Update SQLite repositories**

Modify query filters in `src/data/sqliteRepositories.ts`:

```sql
WHERE (r.is_debarment = 1 OR r.is_sanctioned_securities = 1)
```

Apply this to `findByName`, `findCandidateNames`, and `findByRecordId`.

Add row type:

```ts
interface SecuritiesRow {
  securities_json: string;
}
```

Add method to `SqliteTargetDetailsRepository`:

```ts
findSecuritiesByRecordId(recordId: string): SecuritiesDetail | undefined {
  const row = this.db.prepare(`
    SELECT securities_json
    FROM securities_details
    WHERE record_id = ?
  `).get(recordId) as SecuritiesRow | undefined;

  return row ? parseJson<SecuritiesDetail>(row.securities_json) : undefined;
}
```

Update import:

```ts
SecuritiesDetail,
```

- [ ] **Step 6: Verify SQLite tests pass**

Run:

```bash
npm test -- test/sqlite-builder.test.ts test/sqlite-repositories.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

Run:

```bash
git add src/data/sqliteSchema.ts src/data/sqliteBuilder.ts src/data/sqliteRepositories.ts test/sqlite-builder.test.ts test/sqlite-repositories.test.ts
git commit -m "Build merged screening SQLite records" -m "Constraint: Sanctioned Securities uses the official company-level securities.csv export rather than full graph reconstruction." -m "Confidence: medium" -m "Scope-risk: moderate" -m "Directive: Keep securities CSV parsing streaming and header-based." -m "Tested: npm test -- test/sqlite-builder.test.ts test/sqlite-repositories.test.ts" -m "Not-tested: Production OpenSanctions download."
```

## Task 4: Config, Bootstrap, And Offline Build Path

**Files:**
- Modify: `src/config.ts`
- Modify: `src/data/sqliteBootstrap.ts`
- Modify: `src/scripts/buildSqlite.ts`
- Modify: `src/index.ts`
- Modify: `test/sqlite-bootstrap.test.ts`
- Modify: `test/debarment-bot.test.ts`

- [ ] **Step 1: Add config and bootstrap tests**

In config tests inside `test/debarment-bot.test.ts`, add `securitiesPath` expectations where default config is asserted:

```ts
expect(config.securitiesPath).toBe('./securities.csv');
```

Add override test:

```ts
const config = loadConfig({ SECURITIES_PATH: './data/securities.csv' }, { requireToken: false });
expect(config.securitiesPath).toBe('./data/securities.csv');
```

In `test/sqlite-bootstrap.test.ts`, extend helper paths:

```ts
securitiesPath: path.join(dir, 'nested', 'securities.csv'),
```

Copy the securities fixture whenever populated data is required:

```ts
await fs.copyFile(path.join(process.cwd(), 'test/fixtures/securities.fixture.csv'), paths.securitiesPath);
```

Add first-run assertion:

```ts
expect(await fs.readFile(paths.securitiesPath, 'utf8')).toBe('');
```

Add missing-source test:

```ts
test('throws when securities CSV is missing but JSONL sources are populated', async () => {
  const paths = await tempPaths();
  await fs.mkdir(path.dirname(paths.senzingPath), { recursive: true });
  await fs.copyFile(senzingFixture, paths.senzingPath);
  await fs.copyFile(targetsNestedFixture, paths.targetsNestedPath);

  await expect(bootstrapSqliteRepositories(paths)).rejects.toThrow(`Missing startup data file: ${paths.securitiesPath}`);
});
```

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

```bash
npm test -- test/sqlite-bootstrap.test.ts test/debarment-bot.test.ts -t "config|bootstrap|securities CSV"
```

Expected: FAIL because config/bootstrap do not know `securitiesPath`.

- [ ] **Step 3: Add config field**

Modify `src/config.ts`:

```ts
securitiesPath: string;
```

In `loadConfig` return object:

```ts
securitiesPath: env.SECURITIES_PATH?.trim() || './securities.csv',
```

- [ ] **Step 4: Update bootstrap options and first-run seed files**

Modify `src/data/sqliteBootstrap.ts`:

```ts
export interface BootstrapSqliteOptions {
  senzingPath: string;
  targetsNestedPath: string;
  securitiesPath: string;
  sqlitePath: string;
  minFuzzyScore?: number;
}
```

Read securities file state:

```ts
const securitiesState = await fileState(options.securitiesPath);
```

Pass complete options to `assertCompleteStartupData`:

```ts
assertCompleteStartupData(options, senzingState, targetsNestedState, securitiesState);
```

Use populated check:

```ts
if (senzingState.populated && targetsNestedState.populated && securitiesState.populated) {
  await buildSqliteDatabase(options);
  return openBootstrapResult(options.sqlitePath, false, options.minFuzzyScore);
}
```

Create empty seed file:

```ts
if (!senzingState.exists && !targetsNestedState.exists && !securitiesState.exists) {
  const createdSenzing = await createEmptyFile(options.senzingPath);
  const createdTargetsNested = await createEmptyFile(options.targetsNestedPath);
  const createdSecurities = await createEmptyFile(options.securitiesPath);
  if (!createdSenzing || !createdTargetsNested || !createdSecurities) {
    if (createRaceRetries >= 1) throw new Error('Startup data files changed during bootstrap.');
    return bootstrapSqliteRepositoriesAttempt(options, createRaceRetries + 1);
  }
}
```

Rename `createEmptyJsonl` to `createEmptyFile`:

```ts
async function createEmptyFile(filePath: string): Promise<boolean> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(filePath, '', { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'EEXIST') return false;
    throw error;
  }
}
```

Update `assertCompleteStartupData`:

```ts
function assertCompleteStartupData(
  options: BootstrapSqliteOptions,
  senzingState: FileState,
  targetsNestedState: FileState,
  securitiesState: FileState,
): void {
  const states = [
    [options.senzingPath, senzingState],
    [options.targetsNestedPath, targetsNestedState],
    [options.securitiesPath, securitiesState],
  ] as const;
  const anyPopulated = states.some(([, state]) => state.populated);
  const anyExisting = states.some(([, state]) => state.exists);
  if (!anyExisting) return;
  for (const [filePath, state] of states) {
    if (anyPopulated && !state.populated) throw new Error(`Missing startup data file: ${filePath}`);
    if (!anyPopulated && state.exists && !state.populated) continue;
  }
}
```

- [ ] **Step 5: Update script and index wiring**

In `src/scripts/buildSqlite.ts`:

```ts
await buildSqliteDatabase({
  senzingPath: config.senzingPath,
  targetsNestedPath: config.targetsNestedPath,
  securitiesPath: config.securitiesPath,
  sqlitePath: config.sqlitePath,
});
```

In `src/index.ts`, include logging:

```ts
securitiesPath: config.securitiesPath,
```

Pass to bootstrap:

```ts
securitiesPath: config.securitiesPath,
```

Pass to `DataRefreshService`:

```ts
securitiesPath: config.securitiesPath,
```

- [ ] **Step 6: Verify bootstrap/config tests pass**

Run:

```bash
npm test -- test/sqlite-bootstrap.test.ts test/debarment-bot.test.ts -t "config|bootstrap|securities CSV"
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

Run:

```bash
git add src/config.ts src/data/sqliteBootstrap.ts src/scripts/buildSqlite.ts src/index.ts test/sqlite-bootstrap.test.ts test/debarment-bot.test.ts
git commit -m "Wire securities CSV into startup paths" -m "Constraint: Startup should still prefer an existing populated SQLite database over rebuilding from source files." -m "Confidence: medium" -m "Scope-risk: moderate" -m "Directive: Treat missing populated source files as rebuild blockers, not as empty real data." -m "Tested: npm test -- test/sqlite-bootstrap.test.ts test/debarment-bot.test.ts -t \"config|bootstrap|securities CSV\"" -m "Not-tested: Real service startup."
```

## Task 5: Data Refresh For Debarment Plus Securities

**Files:**
- Modify: `src/data/dataRefreshService.ts`
- Modify: `test/data-refresh.test.ts`

- [ ] **Step 1: Add refresh tests**

In `test/data-refresh.test.ts`, add fixtures:

```ts
const oldSecuritiesCsv = [
  '"caption","lei","perm_id","isins","ric","countries","sanctioned","eo_14071","public","id","url","datasets","risk_datasets","aliases","referents"',
  '"OLD SECURITY CO","","","","","us","t","f","f","old-security","https://www.opensanctions.org/entities/old-security","us_ofac_sdn","us_ofac_sdn","OLD SECURITY CO","old-ref"',
].join('\n') + '\n';

const newSecuritiesCsv = [
  '"caption","lei","perm_id","isins","ric","countries","sanctioned","eo_14071","public","id","url","datasets","risk_datasets","aliases","referents"',
  '"NEW SECURITY CO","","","RU000A0JX0J2","","ru","f","t","f","new-security","https://www.opensanctions.org/entities/new-security","ru_nsd_isin","ru_nsd_isin","NEW SECURITY CO","new-ref"',
].join('\n') + '\n';
```

Extend `metadata` helper to include securities:

```ts
function metadata(version: string, checksums: { senzing: string; targets: string; securities: string }): DatasetMetadata {
  return {
    version,
    resources: {
      'senzing.json': { name: 'senzing.json', url: `https://example.test/${version}/senzing.json`, checksum: checksumAlias(checksums.senzing) },
      'targets.nested.json': { name: 'targets.nested.json', url: `https://example.test/${version}/targets.nested.json`, checksum: checksumAlias(checksums.targets) },
      'securities.csv': { name: 'securities.csv', url: `https://example.test/${version}/securities.csv`, checksum: checksumAlias(checksums.securities) },
    },
  };
}
```

Extend checksum aliases:

```ts
'same-securities': sha1(oldSecuritiesCsv),
'old-securities': sha1(oldSecuritiesCsv),
'new-securities': sha1(newSecuritiesCsv),
```

Extend harness paths:

```ts
const securitiesPath = path.join(dir, 'securities.csv');
await fs.writeFile(securitiesPath, oldSecuritiesCsv, 'utf8');
```

Extend downloader:

```ts
if (url.includes('senzing')) await writeJsonl(destination, [newSenzingRecord]);
else if (url.includes('targets')) await writeJsonl(destination, [newTargetRecord]);
else await fs.writeFile(destination, newSecuritiesCsv, 'utf8');
```

Pass to service:

```ts
securitiesPath,
```

Add test:

```ts
test('downloads changed securities CSV and rebuilds SQLite results', async () => {
  const harness = await createHarness({
    localMetadata: metadata('v1', { senzing: 'old-senzing', targets: 'old-targets', securities: 'old-securities' }),
    remoteMetadata: metadata('v2', { senzing: 'old-senzing', targets: 'old-targets', securities: 'new-securities' }),
  });
  const sqlitePath = path.join(harness.dir, 'sanction.sqlite');
  const refresher = new DataRefreshService({
    senzingPath: harness.senzingPath,
    targetsNestedPath: harness.targetsNestedPath,
    securitiesPath: harness.securitiesPath,
    refreshMetadataPath: harness.refreshMetadataPath,
    sqlitePath,
    activeRepositories: harness.activeRepositories,
    fetchMetadata: harness.fetchMetadata,
    downloader: harness.downloader,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });

  await expect(refresher.refreshNow()).resolves.toMatchObject({ status: 'updated', version: 'v2' });
  await expect(harness.service.check('NEW SECURITY CO')).resolves.toMatchObject({ found: true });
  await expect(fs.readFile(harness.securitiesPath, 'utf8')).resolves.toContain('NEW SECURITY CO');
});
```

- [ ] **Step 2: Run refresh tests and confirm failure**

Run:

```bash
npm test -- test/data-refresh.test.ts
```

Expected: FAIL because `DataRefreshServiceOptions` does not include `securitiesPath`, and metadata parsing does not track `securities.csv`.

- [ ] **Step 3: Extend refresh metadata resource names**

Modify `src/data/dataRefreshService.ts`:

```ts
export const OPENSANCTIONS_SECURITIES_METADATA_URL = 'https://data.opensanctions.org/datasets/latest/securities/index.json';
export const TARGET_RESOURCE_NAMES = ['senzing.json', 'targets.nested.json', 'securities.csv'] as const;
```

Update `DataRefreshServiceOptions`:

```ts
securitiesPath: string;
```

Update staged paths:

```ts
const stagedSecuritiesPath = path.join(tempDir, 'securities.csv');
```

Download and validate:

```ts
await this.downloader(remoteMetadata.resources['securities.csv'].url, stagedSecuritiesPath);
await validateDownloadedResource(stagedSecuritiesPath, remoteMetadata.resources['securities.csv']);
```

Pass into builder:

```ts
securitiesPath: stagedSecuritiesPath,
```

Pass into replace:

```ts
stagedSecuritiesPath,
securitiesPath: this.options.securitiesPath,
```

- [ ] **Step 4: Fetch combined metadata**

Replace `fetchOpenSanctionsDebarmentMetadata` body:

```ts
export async function fetchOpenSanctionsDebarmentMetadata(): Promise<DatasetMetadata> {
  const [debarmentResponse, securitiesResponse] = await Promise.all([
    fetch(OPENSANCTIONS_DEBARMENT_METADATA_URL, { signal: AbortSignal.timeout(DEFAULT_METADATA_TIMEOUT_MS) }),
    fetch(OPENSANCTIONS_SECURITIES_METADATA_URL, { signal: AbortSignal.timeout(DEFAULT_METADATA_TIMEOUT_MS) }),
  ]);
  if (!debarmentResponse.ok) throw new Error(`Debarment metadata fetch failed with HTTP ${debarmentResponse.status}`);
  if (!securitiesResponse.ok) throw new Error(`Securities metadata fetch failed with HTTP ${securitiesResponse.status}`);
  const debarment = parseDatasetMetadata(await debarmentResponse.json(), ['senzing.json', 'targets.nested.json']);
  const securities = parseDatasetMetadata(await securitiesResponse.json(), ['securities.csv']);
  return {
    version: `${debarment.version}+${securities.version}`,
    resources: {
      ...debarment.resources,
      ...securities.resources,
    },
  };
}
```

Change parser signature:

```ts
export function parseDatasetMetadata(
  raw: unknown,
  resourceNames: readonly TargetResourceName[] = TARGET_RESOURCE_NAMES,
): DatasetMetadata {
```

Use `resourceNames.map` instead of `TARGET_RESOURCE_NAMES.map` inside that function.

Update `resourceName`:

```ts
if (basename === 'senzing.json' || basename === 'targets.nested.json' || basename === 'securities.csv') return basename;
```

- [ ] **Step 5: Publish securities file atomically**

Extend `ReplaceLocalFilesOptions`:

```ts
stagedSecuritiesPath: string;
securitiesPath: string;
```

In `localRefreshOutputsExist`, include:

```ts
securitiesPath: string;
```

Loop over:

```ts
for (const filePath of [options.senzingPath, options.targetsNestedPath, options.securitiesPath, options.sqlitePath].filter(isDefinedString)) {
```

In `replaceLocalFilesAndMetadata`, add backup/publish booleans and copy logic for securities using the same pattern as senzing and targets:

```ts
const securitiesBackupPath = `${options.securitiesPath}${backupSuffix}`;
let movedSecurities = false;
let publishedSecurities = false;

movedSecurities = await moveIfExists(options.securitiesPath, securitiesBackupPath);
await fs.copyFile(options.stagedSecuritiesPath, options.securitiesPath);
publishedSecurities = true;
```

Rollback:

```ts
if (movedSecurities || publishedSecurities) await removeIfExists(options.securitiesPath);
if (movedSecurities) await fs.rename(securitiesBackupPath, options.securitiesPath);
```

Cleanup list:

```ts
await removeBackupFiles([senzingBackupPath, targetsBackupPath, securitiesBackupPath, metadataBackupPath, sqliteBackupPath].filter(isDefinedString), options.logger);
```

- [ ] **Step 6: Verify refresh tests pass**

Run:

```bash
npm test -- test/data-refresh.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

Run:

```bash
git add src/data/dataRefreshService.ts test/data-refresh.test.ts
git commit -m "Refresh debarment and securities inputs together" -m "Constraint: Active query data must only swap after all staged resources and SQLite rebuild validate." -m "Confidence: medium" -m "Scope-risk: moderate" -m "Directive: Do not publish partial debarment/securities refresh outputs." -m "Tested: npm test -- test/data-refresh.test.ts" -m "Not-tested: Live OpenSanctions refresh."
```

## Task 6: Telegram Formatting For Merged Results

**Files:**
- Modify: `src/bot/formatters.ts`
- Modify: `test/debarment-bot.test.ts`

- [ ] **Step 1: Add formatter tests**

In `test/debarment-bot.test.ts`, add formatter tests near existing formatter tests:

```ts
test('formats securities-only check hit with Sanctioned Securities status', async () => {
  const service = new DebarmentService(
    SenzingMemoryRepository.fromRecords([{
      RECORD_ID: 'SEC-1',
      NAMES: [{ NAME_TYPE: 'PRIMARY', NAME_FULL: 'SECURITIES ONLY LTD' }],
      RISKS: [{ TOPIC: 'sanctioned_securities' }],
    }]),
    TargetsNestedMemoryRepository.fromRecords([]),
  );

  const formatted = formatCheckResult(await service.check('SECURITIES ONLY LTD'));

  expect(formatted.text.startsWith('Sanctioned Securities')).toBe(true);
});

test('formats full merged result with debarment and securities sections', () => {
  const formatted = formatFullResults({
    query: 'MERGED',
    found: true,
    totalMatches: 1,
    truncated: false,
    matches: [{
      record: { RECORD_ID: 'MERGED', RISKS: [{ TOPIC: 'debarment' }, { TOPIC: 'sanctioned_securities' }] },
      matchedName: 'MERGED CO',
      matchedNameType: 'PRIMARY',
      basic: {
        recordId: 'MERGED',
        primaryName: 'MERGED CO',
        matchedName: 'MERGED CO',
        matchedNameType: 'PRIMARY',
        statuses: ['debarred', 'sanctioned_securities'],
        aliases: [],
        risks: ['debarment', 'sanctioned_securities'],
        countries: ['ru'],
        addresses: [],
        identifiers: [{ type: 'ISIN', value: 'RU000A0JX0J2' }],
        url: 'https://www.opensanctions.org/entities/MERGED',
      },
      sanctions: [{ authority: ['OFAC'], status: [], listingDate: [], startDate: [], program: [], provisions: [], sourceUrl: [], summary: [] }],
      securities: {
        caption: 'MERGED CO',
        lei: [],
        permId: [],
        isins: ['RU000A0JX0J2'],
        ric: [],
        countries: ['ru'],
        sanctioned: true,
        eo14071: true,
        public: false,
        datasets: ['ru_nsd_isin'],
        riskDatasets: ['ru_nsd_isin'],
        referents: ['ref-1'],
        url: 'https://www.opensanctions.org/entities/MERGED',
      },
    }],
  });

  expect(formatted.text).toContain('Statuses: Debarred, Sanctioned Securities');
  expect(formatted.text).toContain('Sanctions Details');
  expect(formatted.text).toContain('Securities Details');
  expect(formatted.text).toContain('ISINs: RU000A0JX0J2');
  expect(formatted.text).toContain('Investment Ban: yes');
});
```

- [ ] **Step 2: Run formatter tests and confirm failure**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "Sanctioned Securities|Securities Details"
```

Expected: FAIL because formatter still has Debarred-only status text and no securities section.

- [ ] **Step 3: Add status label helpers**

In `src/bot/formatters.ts`, import `ScreeningStatus` and `SecuritiesDetail`:

```ts
import type { BotReply, DebarmentCandidateSearchResult, DebarmentMatch, DebarmentQueryResult, ReplyButton, SanctionDetail, ScreeningStatus, SecuritiesDetail } from '../domain/types.js';
```

Add helpers:

```ts
function statusLine(match: DebarmentMatch): string {
  return statusLabels(match.basic.statuses).join(' + ') || 'No Data Found!';
}

function statusLabels(statuses: ScreeningStatus[]): string[] {
  return statuses.map((status) => status === 'debarred' ? 'Debarred' : 'Sanctioned Securities');
}
```

In `formatCheckResult`, replace:

```ts
const lines = ['Debarred'];
```

with:

```ts
const firstStatus = result.matches[0] ? statusLine(result.matches[0]) : 'No Data Found!';
const lines = [firstStatus];
```

- [ ] **Step 4: Add statuses and securities to full/basic output**

In `basicSection`, after matched name:

```ts
appendInline(lines, 'Statuses', statusLabels(match.basic.statuses));
```

Add securities section helper:

```ts
function securitiesSection(securities: SecuritiesDetail): string[] {
  const lines = ['Securities Details'];
  lines.push(`Designated: ${securities.sanctioned ? 'yes' : 'no'}`);
  lines.push(`Investment Ban: ${securities.eo14071 ? 'yes' : 'no'}`);
  lines.push(`Public: ${securities.public ? 'yes' : 'no'}`);
  appendInline(lines, 'LEI', securities.lei);
  appendInline(lines, 'PermID', securities.permId);
  appendInline(lines, 'ISINs', securities.isins);
  appendInline(lines, 'RIC', securities.ric);
  appendInline(lines, 'Countries', securities.countries);
  appendInline(lines, 'Datasets', securities.datasets);
  appendInline(lines, 'Risk Datasets', securities.riskDatasets);
  appendList(lines, 'Referents', securities.referents);
  if (securities.url) lines.push(`OpenSanctions URL: ${securities.url}`);
  return lines;
}
```

In `formatFullResults`, after sanctions block:

```ts
if (match.securities) {
  lines.push('', ...securitiesSection(match.securities));
}
```

- [ ] **Step 5: Verify formatter tests pass**

Run:

```bash
npm test -- test/debarment-bot.test.ts -t "Sanctioned Securities|Securities Details"
```

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

Run:

```bash
git add src/bot/formatters.ts test/debarment-bot.test.ts
git commit -m "Show merged screening statuses in Telegram replies" -m "Constraint: Existing commands remain stable while result text expands to include securities status." -m "Confidence: high" -m "Scope-risk: narrow" -m "Directive: Keep /search wording candidate-only and not a verdict." -m "Tested: npm test -- test/debarment-bot.test.ts -t \"Sanctioned Securities|Securities Details\"" -m "Not-tested: Live Telegram rendering."
```

## Task 7: Documentation And Full Verification

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/telegram-operation-guide.md`
- Modify: any tests affected by documentation/script assertions

- [ ] **Step 1: Update environment examples**

In `.env.example`, add:

```env
SECURITIES_PATH=./securities.csv
```

Place it next to `SENZING_PATH` and `TARGETS_NESTED_PATH`.

- [ ] **Step 2: Update README data file table**

In `README.md`, update the data file table to include:

```markdown
| `securities.csv` | Sanctioned Securities 公司级 CSV 输入，提供 company id、名称、别名、LEI、PermID、ISIN、RIC、source datasets 和 risk datasets。 |
```

Update matching rules with:

```markdown
- 查询会同时返回 Debarred 和 Sanctioned Securities 公司级结果。同一 OpenSanctions id 的公司会合并成一条结果，状态显示为 `Debarred + Sanctioned Securities`。
- Sanctioned Securities 当前使用 OpenSanctions 官方 `securities.csv` 公司级导出；它不是完整 securities 图谱，不包含所有底层 Security 实体。
```

Update refresh section with:

```markdown
机器人会同时读取 OpenSanctions debarment metadata 和 securities metadata。刷新时只有 `senzing.json`、`targets.nested.json`、`securities.csv` 和 SQLite 构建都成功后，才替换本地文件并热切换查询服务。
```

- [ ] **Step 3: Update operation guide**

In `docs/telegram-operation-guide.md`, update data refresh and usage descriptions with:

```markdown
查询结果现在可能显示 `Debarred`、`Sanctioned Securities` 或 `Debarred + Sanctioned Securities`。`/search` 仍然只返回候选，不直接给命中结论。
```

Add `SECURITIES_PATH=./securities.csv` to deployment examples.

- [ ] **Step 4: Run full verification**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected:

- `npm run typecheck`: exits 0
- `npm test`: exits 0
- `npm run build`: exits 0

- [ ] **Step 5: Commit Task 7**

Run:

```bash
git add .env.example README.md docs/telegram-operation-guide.md test/package-scripts.test.ts
git commit -m "Document merged securities screening data" -m "Constraint: User documentation must distinguish company-level securities.csv from the full securities entity graph." -m "Confidence: high" -m "Scope-risk: narrow" -m "Directive: Do not describe securities.csv as complete graph data." -m "Tested: npm run typecheck; npm test; npm run build" -m "Not-tested: Production deployment with real Telegram bot."
```

## Task 8: Final Integration Review

**Files:**
- Inspect all modified files from Tasks 1-7.

- [ ] **Step 1: Inspect final diff**

Run:

```bash
git status --short
git diff --stat HEAD~7..HEAD
git log --oneline -7
```

Expected:

- No unintended tracked changes remain unstaged.
- The seven implementation commits correspond to Tasks 1-7.
- Existing unrelated untracked files may remain and should not be included.

- [ ] **Step 2: Run final verification again if any code changed after Task 7**

Run if Task 7 was not the last code/doc edit:

```bash
npm run typecheck
npm test
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 3: Prepare final implementation report**

Report:

```markdown
Implemented merged Debarred + Sanctioned Securities company-level screening using OpenSanctions securities.csv.

Changed:
- Added streaming securities CSV parser.
- Upgraded SQLite schema and builder for merged screening records.
- Expanded service/domain DTOs for statuses and securities details.
- Updated refresh/bootstrap/build paths for securities.csv.
- Updated Telegram output and documentation.

Verified:
- npm run typecheck
- npm test
- npm run build

Known limitation:
- securities.csv is a company-level official export, not the complete securities entity graph. Full graph rebuild remains documented separately.
```
