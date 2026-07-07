import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SqliteRebuildService } from '../src/data/sqliteRebuildService.js';
import { SenzingMemoryRepository } from '../src/data/senzingMemoryRepository.js';
import { TargetsNestedMemoryRepository } from '../src/data/targetsNestedMemoryRepository.js';
import { ActiveDebarmentRepositories, DebarmentService } from '../src/domain/debarmentService.js';
import { ActiveSecuritiesRepositories, SecuritiesService } from '../src/domain/securitiesService.js';
import type { SenzingRecord, TargetNestedRecord } from '../src/domain/types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SQLite rebuild service', () => {
  test('rebuilds debarment and securities databases from local JSONL and swaps active repositories', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-rebuild-'));
    const debarmentPaths = datasetPaths(dir, 'debarment');
    const securitiesPaths = datasetPaths(dir, 'securities');
    await writeJsonl(debarmentPaths.senzingPath, [
      debarmentRecord('NEW-DEBARMENT', 'NEW DEBARMENT PLAYER'),
    ]);
    await writeJsonl(debarmentPaths.targetsNestedPath, [
      targetRecord('NEW-DEBARMENT', 'US GSA'),
    ]);
    await writeJsonl(securitiesPaths.senzingPath, [
      securitiesRecord('SECURITY-1'),
    ]);
    await writeJsonl(securitiesPaths.targetsNestedPath, [
      targetRecord('SECURITY-1', 'DHS UFLPA'),
    ]);

    const debarmentActiveRepositories = new ActiveDebarmentRepositories(
      SenzingMemoryRepository.fromRecords([debarmentRecord('OLD-DEBARMENT', 'OLD DEBARMENT PLAYER')]),
      TargetsNestedMemoryRepository.fromRecords([]),
    );
    const securitiesActiveRepositories = new ActiveSecuritiesRepositories(
      SenzingMemoryRepository.fromRecords([{
        DATA_SOURCE: 'TEST',
        RECORD_ID: 'OLD-SECURITY',
        NAMES: [{ NAME_TYPE: 'PRIMARY', NAME_ORG: 'OLD SECURITY CO LTD' }],
        RISKS: [{ TOPIC: 'sanction' }],
      }]),
      TargetsNestedMemoryRepository.fromRecords([]),
    );
    const debarmentService = new DebarmentService(debarmentActiveRepositories);
    const securitiesService = new SecuritiesService(securitiesActiveRepositories);
    const rebuildService = new SqliteRebuildService({
      targets: [
        {
          label: 'debarment',
          ...debarmentPaths,
          activeRepositories: debarmentActiveRepositories,
        },
        {
          label: 'securities',
          ...securitiesPaths,
          activeRepositories: securitiesActiveRepositories,
          isIncludedRecord: () => true,
        },
      ],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    try {
      await expect(rebuildService.rebuildNow()).resolves.toMatchObject({
        status: 'updated',
        message: expect.stringContaining('SQLite databases rebuilt'),
      });

      await expect(debarmentService.check('OLD DEBARMENT PLAYER')).resolves.toMatchObject({ found: false });
      await expect(debarmentService.full('NEW DEBARMENT PLAYER')).resolves.toMatchObject({
        found: true,
        matches: [{ basic: { recordId: 'NEW-DEBARMENT' }, sanctions: [{ authority: ['US GSA'] }] }],
      });
      await expect(securitiesService.full('Dongguan Lvzhou Shoes Co. Ltd.')).resolves.toMatchObject({
        found: true,
        matches: [{ basic: { recordId: 'SECURITY-1' }, sanctions: [{ authority: ['DHS UFLPA'] }] }],
      });
      await expect(fs.stat(debarmentPaths.sqlitePath)).resolves.toMatchObject({ size: expect.any(Number) });
      await expect(fs.stat(securitiesPaths.sqlitePath)).resolves.toMatchObject({ size: expect.any(Number) });
    } finally {
      closeActiveRepositories(debarmentActiveRepositories.snapshot());
      closeActiveRepositories(securitiesActiveRepositories.snapshot());
    }
  });

  test('keeps active repositories unchanged when rebuild input is invalid', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-rebuild-invalid-'));
    const paths = datasetPaths(dir, 'debarment');
    await fs.writeFile(paths.senzingPath, '{"NAMES":[{"NAME_FULL":"BROKEN"}]}\n', 'utf8');
    await writeJsonl(paths.targetsNestedPath, []);
    const activeRepositories = new ActiveDebarmentRepositories(
      SenzingMemoryRepository.fromRecords([debarmentRecord('OLD-DEBARMENT', 'OLD DEBARMENT PLAYER')]),
      TargetsNestedMemoryRepository.fromRecords([]),
    );
    const debarmentService = new DebarmentService(activeRepositories);
    const rebuildService = new SqliteRebuildService({
      targets: [{
        label: 'debarment',
        ...paths,
        activeRepositories,
      }],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(rebuildService.rebuildNow()).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Senzing record missing RECORD_ID'),
    });
    await expect(debarmentService.check('OLD DEBARMENT PLAYER')).resolves.toMatchObject({ found: true });
  });
});

function datasetPaths(dir: string, prefix: string): {
  senzingPath: string;
  targetsNestedPath: string;
  sqlitePath: string;
} {
  return {
    senzingPath: path.join(dir, `${prefix}.senzing.json`),
    targetsNestedPath: path.join(dir, `${prefix}.targets.nested.json`),
    sqlitePath: path.join(dir, `${prefix}.sqlite`),
  };
}

function debarmentRecord(recordId: string, name: string): SenzingRecord {
  return {
    DATA_SOURCE: 'TEST',
    RECORD_ID: recordId,
    NAMES: [{ NAME_TYPE: 'PRIMARY', NAME_FULL: name }],
    RISKS: [{ TOPIC: 'debarment' }],
  };
}

function securitiesRecord(recordId: string): SenzingRecord {
  return {
    DATA_SOURCE: 'TEST',
    RECORD_ID: recordId,
    RECORD_TYPE: 'ORGANIZATION',
    NAMES: [
      { NAME_TYPE: 'PRIMARY', NAME_ORG: 'Dongguan Oasis Shoes Co. Ltd.' },
      { NAME_TYPE: 'ALIAS', NAME_ORG: 'Dongguan Lvzhou Shoes Co. Ltd.' },
    ],
    RISKS: [{ TOPIC: 'sanction' }],
  };
}

function targetRecord(recordId: string, authority: string): TargetNestedRecord {
  return {
    id: recordId,
    properties: {
      sanctions: [{ properties: { authority: [authority] } }],
    },
  };
}

async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

function closeActiveRepositories(snapshot: {
  senzingRepository: unknown;
  targetDetailsRepository?: unknown;
}): void {
  closeRepository(snapshot.targetDetailsRepository);
  closeRepository(snapshot.senzingRepository);
}

function closeRepository(repository: unknown): void {
  if (repository && typeof (repository as { close?: unknown }).close === 'function') {
    (repository as { close(): void }).close();
  }
}
