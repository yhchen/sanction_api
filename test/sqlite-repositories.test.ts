import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildSqliteDatabase } from '../src/data/sqliteBuilder.js';
import { SqliteSenzingRepository, SqliteTargetDetailsRepository } from '../src/data/sqliteRepositories.js';
import { DebarmentService } from '../src/domain/debarmentService.js';

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
});
