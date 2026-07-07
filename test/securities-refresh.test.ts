import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SecuritiesRefreshService } from '../src/data/securitiesRefreshService.js';
import { SenzingMemoryRepository } from '../src/data/senzingMemoryRepository.js';
import { SqliteSenzingRepository } from '../src/data/sqliteRepositories.js';
import { TargetsNestedMemoryRepository } from '../src/data/targetsNestedMemoryRepository.js';
import { ActiveSecuritiesRepositories, SecuritiesService } from '../src/domain/securitiesService.js';
import type { RefreshDownloader } from '../src/data/dataRefreshService.js';
import type { SecuritiesSourceMetadata } from '../src/data/openSanctionsCatalog.js';

const sourceARecord = {
  RECORD_ID: 'source-a-1',
  NAMES: [{ NAME_TYPE: 'PRIMARY', NAME_FULL: 'ALPHA SECURITIES LTD' }],
  RISKS: [{ TOPIC: 'sanction.linked' }],
};
const sourceBRecord = {
  RECORD_ID: 'source-b-1',
  NAMES: [{ NAME_TYPE: 'PRIMARY', NAME_FULL: 'BETA HOLDINGS SA' }],
  RISKS: [{ TOPIC: 'export.control' }],
};
const sourceATarget = { id: 'source-a-1', properties: { sanctions: [{ properties: { authority: ['OFAC'] } }] } };
const sourceBTarget = { id: 'source-b-1', properties: { sanctions: [{ properties: { authority: ['EU'] } }] } };

function jsonl(records: unknown[]): string {
  return records.length === 0 ? '' : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function sourceMetadata(overrides: {
  aVersion?: string;
  bVersion?: string;
  aSenzing?: string;
  aTargets?: string;
  bSenzing?: string;
  bTargets?: string;
} = {}): SecuritiesSourceMetadata[] {
  return [
    {
      slug: 'source_a',
      version: overrides.aVersion ?? 'a-v1',
      senzing: { name: 'senzing.json', url: 'https://example.test/source_a/senzing.json', checksum: sha1(overrides.aSenzing ?? jsonl([sourceARecord])) },
      targetsNested: { name: 'targets.nested.json', url: 'https://example.test/source_a/targets.nested.json', checksum: sha1(overrides.aTargets ?? jsonl([sourceATarget])) },
    },
    {
      slug: 'source_b',
      version: overrides.bVersion ?? 'b-v1',
      senzing: { name: 'senzing.json', url: 'https://example.test/source_b/senzing.json', checksum: sha1(overrides.bSenzing ?? jsonl([sourceBRecord])) },
      targetsNested: { name: 'targets.nested.json', url: 'https://example.test/source_b/targets.nested.json', checksum: sha1(overrides.bTargets ?? jsonl([sourceBTarget])) },
    },
  ];
}

async function createHarness(options: {
  seedLocalMetadata?: boolean;
  remoteDatasets?: SecuritiesSourceMetadata[];
  downloader?: RefreshDownloader;
  sqlitePath?: string;
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'securities-refresh-'));
  const senzingPath = path.join(dir, 'securities.senzing.json');
  const targetsNestedPath = path.join(dir, 'securities.targets.nested.json');
  const refreshMetadataPath = path.join(dir, 'securities-refresh-metadata.json');
  const remoteDatasets = options.remoteDatasets ?? sourceMetadata();

  await fs.writeFile(senzingPath, jsonl([sourceARecord]), 'utf8');
  await fs.writeFile(targetsNestedPath, jsonl([sourceATarget]), 'utf8');
  if (options.seedLocalMetadata) {
    const seedDatasets = sourceMetadata();
    await fs.writeFile(refreshMetadataPath, JSON.stringify({
      datasets: Object.fromEntries(seedDatasets.map((dataset) => [dataset.slug, {
        version: dataset.version,
        senzingChecksum: dataset.senzing.checksum,
        targetsNestedChecksum: dataset.targetsNested.checksum,
      }])),
    }, null, 2), 'utf8');
  }

  const activeRepositories = new ActiveSecuritiesRepositories(
    await SenzingMemoryRepository.fromFile(senzingPath),
    await TargetsNestedMemoryRepository.fromFile(targetsNestedPath),
  );
  const service = new SecuritiesService(activeRepositories);

  const downloader: RefreshDownloader = options.downloader ?? vi.fn(async (url, destination) => {
    if (url.includes('source_a/senzing')) await fs.writeFile(destination, jsonl([sourceARecord]), 'utf8');
    else if (url.includes('source_a/targets')) await fs.writeFile(destination, jsonl([sourceATarget]), 'utf8');
    else if (url.includes('source_b/senzing')) await fs.writeFile(destination, jsonl([sourceBRecord]), 'utf8');
    else await fs.writeFile(destination, jsonl([sourceBTarget]), 'utf8');
  });

  const refresher = new SecuritiesRefreshService({
    senzingPath,
    targetsNestedPath,
    refreshMetadataPath,
    sqlitePath: options.sqlitePath,
    activeRepositories,
    fetchSourceMetadata: async () => remoteDatasets,
    downloader,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });

  return { dir, senzingPath, targetsNestedPath, refreshMetadataPath, service, activeRepositories, downloader, refresher };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('securities refresh service', () => {
  test('skips downloads when remote checksums match persisted metadata for every dataset', async () => {
    const harness = await createHarness({ seedLocalMetadata: true });

    await expect(harness.refresher.refreshNow()).resolves.toMatchObject({ status: 'current' });

    expect(harness.downloader).not.toHaveBeenCalled();
  });

  test('downloads and merges all eligible source datasets into one senzing.json/targets.nested.json pair', async () => {
    const harness = await createHarness();

    await expect(harness.refresher.refreshNow()).resolves.toMatchObject({ status: 'updated' });

    expect(harness.downloader).toHaveBeenCalledTimes(4);
    await expect(harness.service.check('ALPHA SECURITIES LTD')).resolves.toMatchObject({ found: true });
    await expect(harness.service.check('BETA HOLDINGS SA')).resolves.toMatchObject({ found: true });

    const mergedSenzing = await fs.readFile(harness.senzingPath, 'utf8');
    expect(mergedSenzing.trim().split('\n')).toHaveLength(2);
    const mergedTargets = await fs.readFile(harness.targetsNestedPath, 'utf8');
    expect(mergedTargets.trim().split('\n')).toHaveLength(2);
  });

  test('dedupes records sharing the same canonical id across source datasets (no PRIMARY KEY crash)', async () => {
    // OpenSanctions assigns stable canonical ids, so the same real-world entity can appear under
    // the identical RECORD_ID/id in more than one source dataset (observed live for e.g. Sberbank
    // appearing under the same id in both an EU and a US sanctions source).
    const sharedRecord = { ...sourceARecord, RECORD_ID: 'shared-1' };
    const sharedTarget = { ...sourceATarget, id: 'shared-1' };
    const datasets = sourceMetadata({ aSenzing: jsonl([sharedRecord]), aTargets: jsonl([sharedTarget]), bSenzing: jsonl([sharedRecord]), bTargets: jsonl([sharedTarget]) });
    const harness = await createHarness({
      remoteDatasets: datasets,
      sqlitePath: path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'securities-refresh-sqlite-')), 'securities.sqlite'),
      downloader: vi.fn(async (url, destination) => {
        if (url.includes('senzing')) await fs.writeFile(destination, jsonl([sharedRecord]), 'utf8');
        else await fs.writeFile(destination, jsonl([sharedTarget]), 'utf8');
      }),
    });

    await expect(harness.refresher.refreshNow()).resolves.toMatchObject({ status: 'updated' });

    const mergedSenzing = await fs.readFile(harness.senzingPath, 'utf8');
    expect(mergedSenzing.trim().split('\n')).toHaveLength(1);
    const mergedTargets = await fs.readFile(harness.targetsNestedPath, 'utf8');
    expect(mergedTargets.trim().split('\n')).toHaveLength(1);
  });

  test('rebuilds when a new dataset is added even if previously-known datasets are unchanged', async () => {
    const updatedBSenzing = jsonl([sourceBRecord, { ...sourceBRecord, RECORD_ID: 'source-b-2' }]);
    const harness = await createHarness({
      seedLocalMetadata: true,
      remoteDatasets: sourceMetadata({ bVersion: 'b-v2', bSenzing: updatedBSenzing }),
      downloader: vi.fn(async (url, destination) => {
        if (url.includes('source_a/senzing')) await fs.writeFile(destination, jsonl([sourceARecord]), 'utf8');
        else if (url.includes('source_a/targets')) await fs.writeFile(destination, jsonl([sourceATarget]), 'utf8');
        else if (url.includes('source_b/senzing')) await fs.writeFile(destination, updatedBSenzing, 'utf8');
        else await fs.writeFile(destination, jsonl([sourceBTarget]), 'utf8');
      }),
    });

    await expect(harness.refresher.refreshNow()).resolves.toMatchObject({ status: 'updated' });
    expect(harness.downloader).toHaveBeenCalled();
    await expect(harness.service.check('BETA HOLDINGS SA')).resolves.toMatchObject({ found: true, totalMatches: 2 });
  });

  test('builds and swaps SQLite repositories with an include-all predicate (no debarment topic required)', async () => {
    const harness = await createHarness();
    const sqlitePath = path.join(harness.dir, 'securities.sqlite');
    const refresher = new SecuritiesRefreshService({
      senzingPath: harness.senzingPath,
      targetsNestedPath: harness.targetsNestedPath,
      refreshMetadataPath: harness.refreshMetadataPath,
      sqlitePath,
      activeRepositories: harness.activeRepositories,
      fetchSourceMetadata: async () => sourceMetadata(),
      downloader: harness.downloader,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(refresher.refreshNow()).resolves.toMatchObject({ status: 'updated' });

    const reopened = SqliteSenzingRepository.open(sqlitePath);
    try {
      expect(reopened.findByName('BETA HOLDINGS SA')).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  test('fails without touching local files when no eligible source datasets are found', async () => {
    const harness = await createHarness({ remoteDatasets: [] });

    await expect(harness.refresher.refreshNow()).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('No eligible') });

    await expect(fs.readFile(harness.senzingPath, 'utf8')).resolves.toBe(jsonl([sourceARecord]));
  });

  test('leaves local files unchanged when a download fails partway through', async () => {
    const harness = await createHarness({
      downloader: vi.fn(async (url, destination) => {
        if (url.includes('source_b')) throw new Error('download unavailable');
        if (url.includes('senzing')) await fs.writeFile(destination, jsonl([sourceARecord]), 'utf8');
        else await fs.writeFile(destination, jsonl([sourceATarget]), 'utf8');
      }),
    });

    await expect(harness.refresher.refreshNow()).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('download unavailable') });

    await expect(fs.readFile(harness.senzingPath, 'utf8')).resolves.toBe(jsonl([sourceARecord]));
    await expect(harness.service.check('BETA HOLDINGS SA')).resolves.toMatchObject({ found: false });
  });

  test('prevents concurrent refresh runs', async () => {
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let paused = false;
    const downloader: RefreshDownloader = vi.fn(async (url, destination) => {
      if (!paused) {
        paused = true;
        markStarted();
        await new Promise<void>((release) => {
          releaseFirst = release;
        });
      }
      if (url.includes('source_a/senzing')) await fs.writeFile(destination, jsonl([sourceARecord]), 'utf8');
      else if (url.includes('source_a/targets')) await fs.writeFile(destination, jsonl([sourceATarget]), 'utf8');
      else if (url.includes('source_b/senzing')) await fs.writeFile(destination, jsonl([sourceBRecord]), 'utf8');
      else await fs.writeFile(destination, jsonl([sourceBTarget]), 'utf8');
    });
    const harness = await createHarness({ downloader });

    const first = harness.refresher.refreshNow();
    await started;
    await expect(harness.refresher.refreshNow()).resolves.toMatchObject({ status: 'in_progress' });
    releaseFirst();
    await expect(first).resolves.toMatchObject({ status: 'updated' });
  });
});
