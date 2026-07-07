# Sanctioned NAME_ORG Query Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sanctioned securities records searchable and displayable when OpenSanctions/Senzing stores names in `NAMES[].NAME_ORG` instead of `NAMES[].NAME_FULL`.

**Architecture:** Add one shared domain helper that extracts display/search names from Senzing name entries, preferring `NAME_FULL` and falling back to `NAME_ORG`. Reuse it in SQLite indexing, in-memory indexing, and result materialization so exact lookup, fuzzy search, record-id lookup, and output formatting stay consistent without changing the SQLite schema.

**Tech Stack:** TypeScript, Node.js 20, Vitest, better-sqlite3, OpenSanctions Senzing JSONL.

---

## File Structure

- Modify: `src/domain/types.ts` - add optional `NAME_ORG?: string | null` to `SenzingName`.
- Create: `src/domain/senzingNames.ts` - shared helpers for extracting names from `SenzingName` / `SenzingRecord`.
- Modify: `src/data/sqliteBuilder.ts` - use shared extracted names when populating `names` and `name_fts`.
- Modify: `src/data/senzingMemoryRepository.ts` - use shared extracted names for exact and fuzzy indexes.
- Modify: `src/domain/entityLookup.ts` - use shared extracted names for `primaryName` and aliases.
- Modify: `src/domain/securitiesService.ts` - use shared primary-name helper for record-id lookup.
- Modify: `test/sqlite-builder.test.ts` - add regression coverage for SQLite indexing of `NAME_ORG`.
- Modify: `test/securities-service.test.ts` - add exact, fuzzy, and record-id/display coverage for `NAME_ORG`.

## Task 1: Add Shared Senzing Name Extraction Tests And Helper

**Files:**
- Modify: `src/domain/types.ts`
- Create: `src/domain/senzingNames.ts`
- Test: no separate test file required; downstream tests in later tasks exercise this helper through public behavior.

- [ ] **Step 1: Extend the Senzing name type**

Edit `src/domain/types.ts` so `SenzingName` includes `NAME_ORG`:

```ts
export interface SenzingName {
  NAME_TYPE?: string | null;
  NAME_FULL?: string | null;
  NAME_ORG?: string | null;
}
```

- [ ] **Step 2: Add the shared helper**

Create `src/domain/senzingNames.ts`:

```ts
import type { SenzingName, SenzingRecord } from './types.js';

export interface ExtractedSenzingName {
  value: string;
  type?: string | null;
}

export function extractSenzingNameValue(name: SenzingName): string | undefined {
  const fullName = name.NAME_FULL?.trim();
  if (fullName) return fullName;

  const orgName = name.NAME_ORG?.trim();
  if (orgName) return orgName;

  return undefined;
}

export function extractedSenzingNames(record: SenzingRecord): ExtractedSenzingName[] {
  return (record.NAMES ?? []).flatMap((name) => {
    const value = extractSenzingNameValue(name);
    return value ? [{ value, type: name.NAME_TYPE }] : [];
  });
}

export function primarySenzingName(record: SenzingRecord): string | undefined {
  const names = extractedSenzingNames(record);
  return names.find((name) => name.type?.toLocaleUpperCase('en-US') === 'PRIMARY')?.value ?? names[0]?.value;
}
```

- [ ] **Step 3: Run typecheck to expose unused or type errors**

Run:

```bash
npm run typecheck
```

Expected: PASS.

## Task 2: Write Failing SQLite Regression Test For NAME_ORG

**Files:**
- Modify: `test/sqlite-builder.test.ts`

- [ ] **Step 1: Add a helper to write temporary JSONL fixtures**

Add this helper near `tempSqlitePath()` in `test/sqlite-builder.test.ts`:

```ts
async function writeJsonlFixture(filePath: string, records: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}
```

- [ ] **Step 2: Add a failing test for NAME_ORG indexing**

Add this test inside `describe('SQLite builder', () => { ... })`:

```ts
  test('indexes Senzing NAME_ORG primary and alias names', async () => {
    const sqlitePath = await tempSqlitePath();
    const fixtureDir = path.dirname(sqlitePath);
    const senzingPath = path.join(fixtureDir, 'org-names.senzing.json');
    const targetsNestedPath = path.join(fixtureDir, 'org-names.targets.nested.json');

    await writeJsonlFixture(senzingPath, [{
      DATA_SOURCE: 'OS_US_DHS_UFLPA',
      RECORD_ID: 'NK-Vq8tbLjL9hai2V7Jx8PYe4',
      RECORD_TYPE: 'ORGANIZATION',
      NAMES: [
        { NAME_TYPE: 'PRIMARY', NAME_ORG: 'Dongguan Oasis Shoes Co. Ltd.' },
        { NAME_TYPE: 'ALIAS', NAME_ORG: 'Dongguan Lvzhou Shoes Co. Ltd.' },
      ],
      RISKS: [{ TOPIC: 'sanction' }],
    }]);
    await writeJsonlFixture(targetsNestedPath, [{
      id: 'NK-Vq8tbLjL9hai2V7Jx8PYe4',
      properties: { sanctions: [] },
    }]);

    await buildSqliteDatabase({ senzingPath, targetsNestedPath, sqlitePath, isIncludedRecord: () => true });

    const db = new Database(sqlitePath, { readonly: true });
    try {
      expect(scalarCount(db, 'SELECT COUNT(*) AS count FROM names')).toBe(2);
      expect(
        db.prepare('SELECT record_id, name_full, normalized_name FROM names WHERE normalized_name = ?').get('dongguan lvzhou shoes co ltd') as NameRow | undefined,
      ).toMatchObject({
        record_id: 'NK-Vq8tbLjL9hai2V7Jx8PYe4',
        name_full: 'Dongguan Lvzhou Shoes Co. Ltd.',
        normalized_name: 'dongguan lvzhou shoes co ltd',
      });
      expect(scalarCount(db, "SELECT COUNT(*) AS count FROM name_fts WHERE name_fts MATCH 'lvzhou'")).toBe(1);
    } finally {
      db.close();
    }
  });
```

- [ ] **Step 3: Run the targeted failing test**

Run:

```bash
npm test -- test/sqlite-builder.test.ts -t "indexes Senzing NAME_ORG"
```

Expected: FAIL because `names` has `0` rows for the `NAME_ORG`-only record.

## Task 3: Implement NAME_ORG Indexing In SQLite Builder

**Files:**
- Modify: `src/data/sqliteBuilder.ts`
- Test: `test/sqlite-builder.test.ts`

- [ ] **Step 1: Import the helper**

In `src/data/sqliteBuilder.ts`, add:

```ts
import { extractedSenzingNames } from '../domain/senzingNames.js';
```

- [ ] **Step 2: Replace direct `NAME_FULL` indexing**

In `insertSenzingRecords`, replace:

```ts
    for (const name of record.NAMES ?? []) {
      const fullName = name.NAME_FULL?.trim();
      if (!fullName) continue;

      const normalized = normalizeName(fullName);
      if (!normalized || seenNormalizedNamesForRecord.has(normalized)) continue;
      seenNormalizedNamesForRecord.add(normalized);

      const tokensJson = JSON.stringify(normalizedTokens(normalized));
      const result = insertName.run(record.RECORD_ID, fullName, normalized, name.NAME_TYPE ?? null, tokensJson) as InsertNameResult;
      insertNameFts.run(normalized, fullName, record.RECORD_ID, Number(result.lastInsertRowid));
    }
```

with:

```ts
    for (const name of extractedSenzingNames(record)) {
      const normalized = normalizeName(name.value);
      if (!normalized || seenNormalizedNamesForRecord.has(normalized)) continue;
      seenNormalizedNamesForRecord.add(normalized);

      const tokensJson = JSON.stringify(normalizedTokens(normalized));
      const result = insertName.run(record.RECORD_ID, name.value, normalized, name.type ?? null, tokensJson) as InsertNameResult;
      insertNameFts.run(normalized, name.value, record.RECORD_ID, Number(result.lastInsertRowid));
    }
```

- [ ] **Step 3: Run the SQLite regression test**

Run:

```bash
npm test -- test/sqlite-builder.test.ts -t "indexes Senzing NAME_ORG"
```

Expected: PASS.

- [ ] **Step 4: Run all SQLite builder tests**

Run:

```bash
npm test -- test/sqlite-builder.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit SQLite indexing change**

Run:

```bash
git add src/domain/types.ts src/domain/senzingNames.ts src/data/sqliteBuilder.ts test/sqlite-builder.test.ts
git commit -m "Index Senzing NAME_ORG names in SQLite"
```

Expected: commit succeeds.

## Task 4: Write Failing Service Regression Tests For NAME_ORG

**Files:**
- Modify: `test/securities-service.test.ts`

- [ ] **Step 1: Add a NAME_ORG record fixture**

Add this fixture near `nonDebarmentRecord`:

```ts
const orgNameRecord: SenzingRecord = {
  DATA_SOURCE: 'OS_US_DHS_UFLPA',
  RECORD_ID: 'NK-Vq8tbLjL9hai2V7Jx8PYe4',
  NAMES: [
    { NAME_TYPE: 'PRIMARY', NAME_ORG: 'Dongguan Oasis Shoes Co. Ltd.' },
    { NAME_TYPE: 'ALIAS', NAME_ORG: 'Dongguan Lvzhou Shoes Co. Ltd.' },
  ],
  RISKS: [{ TOPIC: 'sanction' }],
};
```

- [ ] **Step 2: Add exact, fuzzy, and display tests**

Add these tests inside `describe('SecuritiesService', () => { ... })`:

```ts
  test('returns exact matches for NAME_ORG aliases', async () => {
    await expect(service([orgNameRecord]).check('Dongguan Lvzhou Shoes Co. Ltd.')).resolves.toMatchObject({
      found: true,
      matches: [{
        basic: {
          recordId: 'NK-Vq8tbLjL9hai2V7Jx8PYe4',
          primaryName: 'Dongguan Oasis Shoes Co. Ltd.',
          matchedName: 'Dongguan Lvzhou Shoes Co. Ltd.',
          aliases: ['Dongguan Lvzhou Shoes Co. Ltd.'],
        },
      }],
    });
  });

  test('returns fuzzy candidates for NAME_ORG aliases', async () => {
    await expect(service([orgNameRecord]).searchCandidates('Dongguan Lvzhou')).resolves.toMatchObject({
      found: true,
      candidates: [{
        basic: {
          recordId: 'NK-Vq8tbLjL9hai2V7Jx8PYe4',
          primaryName: 'Dongguan Oasis Shoes Co. Ltd.',
        },
        matchedName: 'Dongguan Lvzhou Shoes Co. Ltd.',
      }],
    });
  });

  test('fullByRecordId displays NAME_ORG primary names', async () => {
    await expect(service([orgNameRecord]).fullByRecordId('NK-Vq8tbLjL9hai2V7Jx8PYe4')).resolves.toMatchObject({
      found: true,
      matches: [{
        basic: {
          recordId: 'NK-Vq8tbLjL9hai2V7Jx8PYe4',
          primaryName: 'Dongguan Oasis Shoes Co. Ltd.',
          matchedName: 'Dongguan Oasis Shoes Co. Ltd.',
        },
      }],
    });
  });
```

- [ ] **Step 3: Run the targeted failing tests**

Run:

```bash
npm test -- test/securities-service.test.ts -t "NAME_ORG"
```

Expected: FAIL because the memory repository and materialization path still ignore `NAME_ORG`.

## Task 5: Implement NAME_ORG Support In Memory Repository And Result Materialization

**Files:**
- Modify: `src/data/senzingMemoryRepository.ts`
- Modify: `src/domain/entityLookup.ts`
- Modify: `src/domain/securitiesService.ts`
- Test: `test/securities-service.test.ts`

- [ ] **Step 1: Update memory repository imports**

In `src/data/senzingMemoryRepository.ts`, add:

```ts
import { extractedSenzingNames } from '../domain/senzingNames.js';
```

- [ ] **Step 2: Replace direct `NAME_FULL` indexing in memory repository**

In `addRecord`, replace:

```ts
    for (const name of record.NAMES ?? []) {
      const fullName = name.NAME_FULL?.trim();
      if (!fullName) continue;
      const normalized = normalizeName(fullName);
      if (!normalized || seenNormalizedNamesForRecord.has(normalized)) continue;
      seenNormalizedNamesForRecord.add(normalized);

      const matches = this.nameIndex.get(normalized) ?? [];
      const match = { record, matchedName: fullName, matchedNameType: name.NAME_TYPE };
      matches.push(match);
      this.nameIndex.set(normalized, matches);
      this.searchableNames.push({ ...match, normalizedName: normalized, normalizedTokens: normalizedTokens(normalized) });
      this.indexedNames += 1;
    }
```

with:

```ts
    for (const name of extractedSenzingNames(record)) {
      const normalized = normalizeName(name.value);
      if (!normalized || seenNormalizedNamesForRecord.has(normalized)) continue;
      seenNormalizedNamesForRecord.add(normalized);

      const matches = this.nameIndex.get(normalized) ?? [];
      const match = { record, matchedName: name.value, matchedNameType: name.type };
      matches.push(match);
      this.nameIndex.set(normalized, matches);
      this.searchableNames.push({ ...match, normalizedName: normalized, normalizedTokens: normalizedTokens(normalized) });
      this.indexedNames += 1;
    }
```

- [ ] **Step 3: Update entity materialization imports**

In `src/domain/entityLookup.ts`, add:

```ts
import { extractedSenzingNames, primarySenzingName } from './senzingNames.js';
```

- [ ] **Step 4: Replace `toBasicInfo` name extraction**

In `toBasicInfo`, replace:

```ts
  const primaryName = getPrimaryName(record) ?? match.matchedName;
```

with:

```ts
  const primaryName = primarySenzingName(record) ?? match.matchedName;
```

Then replace the `aliases` expression:

```ts
    aliases: unique(
      (record.NAMES ?? [])
        .filter((name) => name.NAME_FULL && name.NAME_FULL !== primaryName)
        .map((name) => name.NAME_FULL?.trim())
        .filter(isNonEmptyString),
    ),
```

with:

```ts
    aliases: unique(
      extractedSenzingNames(record)
        .map((name) => name.value)
        .filter((name) => name !== primaryName),
    ),
```

Remove the private `getPrimaryName` function from `src/domain/entityLookup.ts`.

- [ ] **Step 5: Update securities record-id lookup**

In `src/domain/securitiesService.ts`, add:

```ts
import { primarySenzingName } from './senzingNames.js';
```

Then replace:

```ts
    const primaryName = getPrimaryName(record) ?? record.RECORD_ID;
```

with:

```ts
    const primaryName = primarySenzingName(record) ?? record.RECORD_ID;
```

Remove the private `getPrimaryName` function from `src/domain/securitiesService.ts`.

- [ ] **Step 6: Run service regression tests**

Run:

```bash
npm test -- test/securities-service.test.ts -t "NAME_ORG"
```

Expected: PASS.

- [ ] **Step 7: Run full service tests**

Run:

```bash
npm test -- test/securities-service.test.ts test/sanctioned-lookup-service.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit memory and display support**

Run:

```bash
git add src/data/senzingMemoryRepository.ts src/domain/entityLookup.ts src/domain/securitiesService.ts test/securities-service.test.ts
git commit -m "Use Senzing NAME_ORG in service lookups"
```

Expected: commit succeeds.

## Task 6: Final Verification And Runtime Data Rebuild Check

**Files:**
- Read-only verification unless a previous task failed and was fixed before reaching this task.

- [ ] **Step 1: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run targeted test suite**

Run:

```bash
npm test -- test/sqlite-builder.test.ts test/securities-service.test.ts test/sanctioned-lookup-service.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 4: Rebuild local securities SQLite for manual evidence**

Run:

```bash
npx tsx -e "import { buildSqliteDatabase } from './src/data/sqliteBuilder.ts'; await buildSqliteDatabase({ senzingPath: './securities.senzing.json', targetsNestedPath: './securities.targets.nested.json', sqlitePath: './securities.sqlite', isIncludedRecord: () => true });"
```

Expected: command exits `0` and rewrites `securities.sqlite`.

- [ ] **Step 5: Verify the Dongguan record is now indexed**

Run:

```bash
sqlite3 securities.sqlite "select r.record_id, n.name_full from records r join names n on n.record_id = r.record_id where r.record_id = 'NK-Vq8tbLjL9hai2V7Jx8PYe4' order by n.name_full;"
```

Expected output includes:

```text
NK-Vq8tbLjL9hai2V7Jx8PYe4|Dongguan Lvzhou Shoes Co. Ltd.
NK-Vq8tbLjL9hai2V7Jx8PYe4|Dongguan Oasis Shoes Co. Ltd.
```

- [ ] **Step 6: Verify Chinese query remains outside scope**

Run:

```bash
sqlite3 securities.sqlite "select count(*) from records where record_json like '%东莞绿洲鞋业有限公司%';"
```

Expected output:

```text
0
```

- [ ] **Step 7: Commit final verification notes if files changed**

Run:

```bash
git status --short
```

Expected: no modified tracked source/test files. Runtime data files such as `securities.sqlite` may be ignored or untracked depending on local config and should not be committed unless explicitly requested.
