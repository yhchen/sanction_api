import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildSqliteDatabase } from '../src/data/sqliteBuilder.js';
import { SqliteSenzingRepository, SqliteTargetDetailsRepository } from '../src/data/sqliteRepositories.js';
import { DebarmentService } from '../src/domain/debarmentService.js';
import type { SenzingRecord } from '../src/domain/types.js';

const fixturesDir = path.join(process.cwd(), 'test/fixtures');
const senzingFixture = path.join(fixturesDir, 'senzing.fixture.jsonl');
const targetsFixture = path.join(fixturesDir, 'targets.nested.fixture.jsonl');

async function buildTempSqlitePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-repositories-'));
  const sqlitePath = path.join(dir, 'sanction.sqlite');
  await buildSqliteDatabase({
    senzingPath: senzingFixture,
    targetsNestedPath: targetsFixture,
    sqlitePath,
  });
  return sqlitePath;
}

async function withSqliteService<T>(callback: (service: DebarmentService) => Promise<T>): Promise<T> {
  const sqlitePath = await buildTempSqlitePath();
  const senzingRepository = SqliteSenzingRepository.open(sqlitePath);
  const targetDetailsRepository = SqliteTargetDetailsRepository.open(sqlitePath);
  try {
    return await callback(new DebarmentService(senzingRepository, targetDetailsRepository));
  } finally {
    targetDetailsRepository.close();
    senzingRepository.close();
  }
}

async function buildPurposeBuiltSqlite(records: SenzingRecord[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-repositories-recall-'));
  const senzingPath = path.join(dir, 'senzing.jsonl');
  const targetsPath = path.join(dir, 'targets.nested.jsonl');
  const sqlitePath = path.join(dir, 'sanction.sqlite');

  await fs.writeFile(senzingPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  await fs.writeFile(targetsPath, '', 'utf8');
  await buildSqliteDatabase({
    senzingPath,
    targetsNestedPath: targetsPath,
    sqlitePath,
  });
  return sqlitePath;
}

function debarmentRecord(recordId: string, name: string): SenzingRecord {
  return {
    DATA_SOURCE: 'TEST',
    RECORD_ID: recordId,
    NAMES: [{ NAME_TYPE: 'PRIMARY', NAME_FULL: name }],
    RISKS: [{ TOPIC: 'debarment' }],
  };
}

describe('SQLite repositories', () => {
  test('exact primary name hit returns found true', async () => {
    await withSqliteService(async (service) => {
      await expect(service.check('YATAI SMART INDUSTRIAL NEW CITY')).resolves.toMatchObject({
        found: true,
        matches: [{ basic: { recordId: 'NK-223CQDBzp8MRkdJMDiqXn3' } }],
      });
    });
  });

  test('exact alias hit returns found true', async () => {
    await withSqliteService(async (service) => {
      await expect(service.check('YATAI NEW CITY')).resolves.toMatchObject({
        found: true,
        matches: [{ basic: { matchedName: 'YATAI NEW CITY' } }],
      });
    });
  });

  test('non-debarment exact hit returns false', async () => {
    await withSqliteService(async (service) => {
      await expect(service.check('HARMLESS SHIPPING LTD')).resolves.toMatchObject({
        found: false,
        matches: [],
      });
    });
  });

  test('fullByRecordId returns sanctions details', async () => {
    await withSqliteService(async (service) => {
      await expect(service.fullByRecordId('NK-223CQDBzp8MRkdJMDiqXn3')).resolves.toMatchObject({
        found: true,
        matches: [{ sanctions: [{ authority: ['OFAC'] }] }],
      });
    });
  });

  test('search deduplicates multiple name hits for the same target', async () => {
    await withSqliteService(async (service) => {
      const result = await service.searchCandidates('Yatai');

      expect(result.candidates.filter((candidate) => candidate.basic.recordId === 'NK-223CQDBzp8MRkdJMDiqXn3')).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({
        basic: { recordId: 'NK-223CQDBzp8MRkdJMDiqXn3' },
      });
    });
  });

  test('typo search returns the Yatai record', async () => {
    await withSqliteService(async (service) => {
      await expect(service.searchCandidates('Yatai Smrat')).resolves.toMatchObject({
        found: true,
        candidates: [{ basic: { recordId: 'NK-223CQDBzp8MRkdJMDiqXn3' } }],
      });
    });
  });

  test('identifier-like input returns no candidates', async () => {
    await withSqliteService(async (service) => {
      await expect(service.searchCandidates('PW2XZT68KVW8')).resolves.toMatchObject({
        found: false,
        candidates: [],
      });
    });
  });

  test('search scores all FTS recall rows before selecting the best candidates', async () => {
    const fillerRecords = Array.from({ length: 1001 }, (_, index) =>
      debarmentRecord(`AAA-FILLER-${String(index).padStart(4, '0')}`, `COMMON FILLER ${index}`),
    );
    const sqlitePath = await buildPurposeBuiltSqlite([
      ...fillerRecords,
      debarmentRecord('ZZZ-BEST', 'COMMON UNIQUE'),
    ]);
    const senzingRepository = SqliteSenzingRepository.open(sqlitePath);
    const targetDetailsRepository = SqliteTargetDetailsRepository.open(sqlitePath);
    try {
      const service = new DebarmentService(senzingRepository, targetDetailsRepository);

      await expect(service.searchCandidates('common unique')).resolves.toMatchObject({
        found: true,
        candidates: [{ basic: { recordId: 'ZZZ-BEST', primaryName: 'COMMON UNIQUE' } }],
      });
    } finally {
      targetDetailsRepository.close();
      senzingRepository.close();
    }
  });
});
