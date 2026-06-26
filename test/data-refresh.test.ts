import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAccessControl } from '../src/bot/accessControl.js';
import { BotCommandHandler } from '../src/bot/handlers.js';
import { VISIBLE_BOT_COMMANDS } from '../src/bot/createBot.js';
import { ActiveDebarmentRepositories, DebarmentService } from '../src/domain/debarmentService.js';
import { SenzingMemoryRepository } from '../src/data/senzingMemoryRepository.js';
import { TargetsNestedMemoryRepository } from '../src/data/targetsNestedMemoryRepository.js';
import {
  DataRefreshService,
  scheduleDailyRefresh,
  type DatasetMetadata,
  type RefreshDownloader,
  type RefreshMetadataFetcher,
} from '../src/data/dataRefreshService.js';

const oldSenzingRecord = {
  RECORD_ID: 'old-record',
  NAMES: [{ NAME_TYPE: 'PRIMARY', NAME_FULL: 'OLD PLAYER' }],
  RISKS: [{ TOPIC: 'debarment' }],
};
const newSenzingRecord = {
  RECORD_ID: 'new-record',
  NAMES: [{ NAME_TYPE: 'PRIMARY', NAME_FULL: 'NEW PLAYER' }],
  RISKS: [{ TOPIC: 'debarment' }],
};
const oldTargetRecord = { id: 'old-record', properties: { sanctions: [{ properties: { authority: ['OLD'] } }] } };
const newTargetRecord = { id: 'new-record', properties: { sanctions: [{ properties: { authority: ['NEW'] } }] } };

const oldSenzingJsonl = jsonl([oldSenzingRecord]);
const newSenzingJsonl = jsonl([newSenzingRecord]);
const oldTargetsJsonl = jsonl([oldTargetRecord]);
const newTargetsJsonl = jsonl([newTargetRecord]);

function metadata(version: string, checksums: { senzing: string; targets: string }): DatasetMetadata {
  return {
    version,
    resources: {
      'senzing.json': { name: 'senzing.json', url: `https://example.test/${version}/senzing.json`, checksum: checksumAlias(checksums.senzing) },
      'targets.nested.json': { name: 'targets.nested.json', url: `https://example.test/${version}/targets.nested.json`, checksum: checksumAlias(checksums.targets) },
    },
  };
}

function checksumAlias(value: string): string {
  const aliases: Record<string, string> = {
    'same-senzing': sha1(oldSenzingJsonl),
    'same-targets': sha1(oldTargetsJsonl),
    'old-senzing': sha1(oldSenzingJsonl),
    'old-targets': sha1(oldTargetsJsonl),
    'new-senzing': sha1(newSenzingJsonl),
    'new-targets': sha1(newTargetsJsonl),
  };
  return aliases[value] ?? value;
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  await fs.writeFile(filePath, jsonl(records), 'utf8');
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function createHarness(options: {
  localMetadata?: DatasetMetadata;
  remoteMetadata?: DatasetMetadata;
  downloader?: RefreshDownloader;
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-refresh-'));
  const senzingPath = path.join(dir, 'senzing.json');
  const targetsNestedPath = path.join(dir, 'targets.nested.json');
  const refreshMetadataPath = path.join(dir, 'refresh-metadata.json');
  await writeJsonl(senzingPath, [oldSenzingRecord]);
  await writeJsonl(targetsNestedPath, [oldTargetRecord]);
  if (options.localMetadata) {
    await fs.writeFile(refreshMetadataPath, JSON.stringify(options.localMetadata, null, 2), 'utf8');
  }
  const activeRepositories = new ActiveDebarmentRepositories(
    await SenzingMemoryRepository.fromFile(senzingPath),
    await TargetsNestedMemoryRepository.fromFile(targetsNestedPath),
  );
  const service = new DebarmentService(activeRepositories);
  const fetchMetadata: RefreshMetadataFetcher = vi.fn(async () => options.remoteMetadata ?? metadata('v1', { senzing: 'same-senzing', targets: 'same-targets' }));
  const downloader: RefreshDownloader = options.downloader ?? vi.fn(async (url, destination) => {
    if (url.includes('senzing')) await writeJsonl(destination, [newSenzingRecord]);
    else await writeJsonl(destination, [newTargetRecord]);
  });
  const refresher = new DataRefreshService({
    senzingPath,
    targetsNestedPath,
    refreshMetadataPath,
    activeRepositories,
    fetchMetadata,
    downloader,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { dir, senzingPath, targetsNestedPath, refreshMetadataPath, service, activeRepositories, fetchMetadata, downloader, refresher };
}

describe('data refresh service', () => {
  test('skips downloads and keeps active indexes when remote checksums match local metadata', async () => {
    const current = metadata('v1', { senzing: 'same-senzing', targets: 'same-targets' });
    const harness = await createHarness({ localMetadata: current, remoteMetadata: current });

    await expect(harness.refresher.refreshNow()).resolves.toMatchObject({ status: 'current', version: 'v1' });

    expect(harness.downloader).not.toHaveBeenCalled();
    await expect(harness.service.check('OLD PLAYER')).resolves.toMatchObject({ found: true });
    await expect(harness.service.check('NEW PLAYER')).resolves.toMatchObject({ found: false });
  });

  test('downloads both changed resources to temp files, rebuilds indexes, swaps active data, and persists metadata', async () => {
    const local = metadata('v1', { senzing: 'old-senzing', targets: 'old-targets' });
    const remote = metadata('v2', { senzing: 'new-senzing', targets: 'new-targets' });
    const harness = await createHarness({ localMetadata: local, remoteMetadata: remote });

    await expect(harness.refresher.refreshNow()).resolves.toMatchObject({ status: 'updated', version: 'v2' });

    expect(harness.downloader).toHaveBeenCalledTimes(2);
    expect((harness.downloader as ReturnType<typeof vi.fn>).mock.calls.map((call) => path.basename(call[1]))).toEqual(
      expect.arrayContaining([expect.stringContaining('senzing.json'), expect.stringContaining('targets.nested.json')]),
    );
    await expect(harness.service.check('OLD PLAYER')).resolves.toMatchObject({ found: false });
    await expect(harness.service.check('NEW PLAYER')).resolves.toMatchObject({ found: true });
    await expect(fs.readFile(harness.senzingPath, 'utf8')).resolves.toContain('NEW PLAYER');
    await expect(fs.readFile(harness.targetsNestedPath, 'utf8')).resolves.toContain('NEW');
    await expect(fs.readFile(harness.refreshMetadataPath, 'utf8')).resolves.toContain('v2');
  });

  test('leaves active indexes and local files unchanged when validation or rebuild fails', async () => {
    const harness = await createHarness({
      localMetadata: metadata('v1', { senzing: 'old-senzing', targets: 'old-targets' }),
      remoteMetadata: metadata('v2', { senzing: 'new-senzing', targets: 'new-targets' }),
      downloader: vi.fn(async (url, destination) => {
        if (url.includes('senzing')) await fs.writeFile(destination, '{not-jsonl}\n', 'utf8');
        else await writeJsonl(destination, [newTargetRecord]);
      }),
    });

    await expect(harness.refresher.refreshNow()).resolves.toMatchObject({ status: 'failed' });

    await expect(harness.service.check('OLD PLAYER')).resolves.toMatchObject({ found: true });
    await expect(harness.service.check('NEW PLAYER')).resolves.toMatchObject({ found: false });
    await expect(fs.readFile(harness.senzingPath, 'utf8')).resolves.toContain('OLD PLAYER');
    await expect(fs.readFile(harness.refreshMetadataPath, 'utf8')).resolves.toContain('v1');
  });

  test('unsupported remote checksum format fails without swapping data', async () => {
    const harness = await createHarness({
      localMetadata: metadata('v1', { senzing: 'old-senzing', targets: 'old-targets' }),
      remoteMetadata: metadata('v2', { senzing: 'unsupported-format', targets: 'new-targets' }),
    });

    await expect(harness.refresher.refreshNow()).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('checksum format') });

    await expect(harness.service.check('OLD PLAYER')).resolves.toMatchObject({ found: true });
    await expect(harness.service.check('NEW PLAYER')).resolves.toMatchObject({ found: false });
    await expect(fs.readFile(harness.senzingPath, 'utf8')).resolves.toContain('OLD PLAYER');
  });

  test('metadata fetch failure leaves active indexes and local files unchanged', async () => {
    const harness = await createHarness({
      localMetadata: metadata('v1', { senzing: 'old-senzing', targets: 'old-targets' }),
    });
    (harness.fetchMetadata as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('metadata unavailable'));

    await expect(harness.refresher.refreshNow()).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('metadata unavailable') });

    await expect(harness.service.check('OLD PLAYER')).resolves.toMatchObject({ found: true });
    await expect(harness.service.check('NEW PLAYER')).resolves.toMatchObject({ found: false });
    await expect(fs.readFile(harness.senzingPath, 'utf8')).resolves.toContain('OLD PLAYER');
  });

  test('backup cleanup failure after publish does not leave active data behind persisted metadata', async () => {
    const originalRm = fs.rm;
    const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(async (filePath, options) => {
      if (String(filePath).includes('.refresh-backup-')) throw new Error('backup cleanup unavailable');
      return originalRm(filePath, options);
    });
    const harness = await createHarness({
      localMetadata: metadata('v1', { senzing: 'old-senzing', targets: 'old-targets' }),
      remoteMetadata: metadata('v2', { senzing: 'new-senzing', targets: 'new-targets' }),
    });

    await expect(harness.refresher.refreshNow()).resolves.toMatchObject({ status: 'updated', version: 'v2' });

    await expect(harness.service.check('OLD PLAYER')).resolves.toMatchObject({ found: false });
    await expect(harness.service.check('NEW PLAYER')).resolves.toMatchObject({ found: true });
    await expect(fs.readFile(harness.senzingPath, 'utf8')).resolves.toContain('NEW PLAYER');
    await expect(fs.readFile(harness.targetsNestedPath, 'utf8')).resolves.toContain('NEW');
    await expect(fs.readFile(harness.refreshMetadataPath, 'utf8')).resolves.toContain('v2');
    rmSpy.mockRestore();
  });

  test('download failure leaves active indexes and local files unchanged', async () => {
    const harness = await createHarness({
      localMetadata: metadata('v1', { senzing: 'old-senzing', targets: 'old-targets' }),
      remoteMetadata: metadata('v2', { senzing: 'new-senzing', targets: 'new-targets' }),
      downloader: vi.fn(async () => {
        throw new Error('download unavailable');
      }),
    });

    await expect(harness.refresher.refreshNow()).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('download unavailable') });

    await expect(harness.service.check('OLD PLAYER')).resolves.toMatchObject({ found: true });
    await expect(harness.service.check('NEW PLAYER')).resolves.toMatchObject({ found: false });
    await expect(fs.readFile(harness.senzingPath, 'utf8')).resolves.toContain('OLD PLAYER');
  });

  test('queries continue against the old active index while refresh is downloading', async () => {
    let releaseFirstDownload!: () => void;
    let markFirstDownloadStarted!: () => void;
    const firstDownloadStarted = new Promise<void>((resolve) => {
      markFirstDownloadStarted = resolve;
    });
    let paused = false;
    const downloader: RefreshDownloader = vi.fn(async (_url, destination) => {
      if (!paused) {
        paused = true;
        markFirstDownloadStarted();
        await new Promise<void>((release) => {
          releaseFirstDownload = release;
        });
      }
      await writeJsonl(destination, destination.includes('senzing') ? [newSenzingRecord] : [newTargetRecord]);
    });
    const harness = await createHarness({
      localMetadata: metadata('v1', { senzing: 'old-senzing', targets: 'old-targets' }),
      remoteMetadata: metadata('v2', { senzing: 'new-senzing', targets: 'new-targets' }),
      downloader,
    });

    const refresh = harness.refresher.refreshNow();
    await firstDownloadStarted;
    await expect(harness.service.check('OLD PLAYER')).resolves.toMatchObject({ found: true });
    await expect(harness.service.check('NEW PLAYER')).resolves.toMatchObject({ found: false });
    releaseFirstDownload();
    await expect(refresh).resolves.toMatchObject({ status: 'updated' });
  });

  test('prevents concurrent refresh runs', async () => {
    let releaseFirstDownload!: () => void;
    let pausedFirstDownload = false;
    let markFirstDownloadStarted!: () => void;
    const firstDownloadStarted = new Promise<void>((resolve) => {
      markFirstDownloadStarted = resolve;
    });
    const downloader: RefreshDownloader = vi.fn(async (_url, destination) => {
      if (!pausedFirstDownload) {
        pausedFirstDownload = true;
        markFirstDownloadStarted();
        await new Promise<void>((release) => {
          releaseFirstDownload = release;
        });
      }
      await writeJsonl(destination, destination.includes('senzing') ? [newSenzingRecord] : [newTargetRecord]);
    });
    const { refresher } = await createHarness({
      localMetadata: metadata('v1', { senzing: 'old-senzing', targets: 'old-targets' }),
      remoteMetadata: metadata('v2', { senzing: 'new-senzing', targets: 'new-targets' }),
      downloader,
    });

    const first = refresher.refreshNow();
    await firstDownloadStarted;
    await expect(refresher.refreshNow()).resolves.toMatchObject({ status: 'in_progress' });
    releaseFirstDownload();
    await expect(first).resolves.toMatchObject({ status: 'updated' });
  });
});

describe('admin /update handler and scheduler', () => {
  test('allows only admins to run /update and keeps update out of visible player menu', async () => {
    const refreshNow = vi.fn(async () => ({ status: 'current' as const, version: 'v1', message: 'Data already current.' }));
    const handler = new BotCommandHandler(
      new DebarmentService(SenzingMemoryRepository.fromRecords([]), TargetsNestedMemoryRepository.fromRecords([])),
      createAccessControl('*', { adminTelegramUsers: '456' }),
      { refreshNow },
    );

    await expect(handler.handleMessage('/update', 123)).resolves.toMatchObject({ text: 'Unauthorized.' });
    await expect(handler.handleMessage('/update', 456)).resolves.toMatchObject({ text: expect.stringContaining('already current') });
    expect(refreshNow).toHaveBeenCalledTimes(1);
    expect(VISIBLE_BOT_COMMANDS.map((command) => command.command)).not.toContain('update');
  });

  test('schedules daily refresh at the next configured local 05:00 and repeats after each run', async () => {
    const scheduled: Array<{ delay: number; callback: () => void }> = [];
    const setTimer = vi.fn((callback: () => void, delay: number) => {
      scheduled.push({ callback, delay });
      return delay;
    });
    let currentTime = new Date('2026-06-20T04:30:00');
    const refreshNow = vi.fn(async () => {
      currentTime = new Date('2026-06-20T05:10:00');
      return { status: 'current' as const, version: 'v1', message: 'current' };
    });

    scheduleDailyRefresh({ refreshNow }, { timeOfDay: '05:00', now: () => currentTime, setTimer });

    expect(scheduled[0]?.delay).toBe(30 * 60 * 1000);
    scheduled[0]?.callback();
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshNow).toHaveBeenCalledTimes(1);
    expect(scheduled[1]?.delay).toBe((23 * 60 + 50) * 60 * 1000);
  });
});

describe('startup data file bootstrap', () => {
  test('runs a startup update when a required data file is missing', async () => {
    const { ensureDataFilesForStartup } = await import('../src/data/startupDataService.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'startup-data-'));
    const senzingPath = path.join(dir, 'senzing.json');
    const targetsNestedPath = path.join(dir, 'targets.nested.json');
    const refreshMetadataPath = path.join(dir, 'refresh-metadata.json');
    await writeJsonl(senzingPath, [oldSenzingRecord]);
    const refreshNow = vi.fn(async () => {
      await writeJsonl(targetsNestedPath, [oldTargetRecord]);
      return { status: 'updated' as const, version: 'v1', message: 'updated' };
    });
    const logger = { info: vi.fn(), warn: vi.fn() };

    await expect(ensureDataFilesForStartup({ senzingPath, targetsNestedPath, refreshMetadataPath, refreshNow, logger })).resolves.toMatchObject({ status: 'updated' });

    expect(refreshNow).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing'), { missingFiles: [targetsNestedPath] });
  });

  test('does not run a startup update when required data files already exist', async () => {
    const { ensureDataFilesForStartup } = await import('../src/data/startupDataService.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'startup-data-'));
    const senzingPath = path.join(dir, 'senzing.json');
    const targetsNestedPath = path.join(dir, 'targets.nested.json');
    const refreshMetadataPath = path.join(dir, 'refresh-metadata.json');
    await writeJsonl(senzingPath, [oldSenzingRecord]);
    await writeJsonl(targetsNestedPath, [oldTargetRecord]);
    const refreshNow = vi.fn(async () => ({ status: 'updated' as const, version: 'v1', message: 'updated' }));

    await expect(ensureDataFilesForStartup({ senzingPath, targetsNestedPath, refreshMetadataPath, refreshNow })).resolves.toBeUndefined();

    expect(refreshNow).not.toHaveBeenCalled();
  });

  test('fails startup when the required update fails', async () => {
    const { ensureDataFilesForStartup } = await import('../src/data/startupDataService.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'startup-data-'));
    const senzingPath = path.join(dir, 'senzing.json');
    const targetsNestedPath = path.join(dir, 'targets.nested.json');
    const refreshMetadataPath = path.join(dir, 'refresh-metadata.json');
    const refreshNow = vi.fn(async () => ({ status: 'failed' as const, message: 'Data refresh failed: offline', error: 'offline' }));

    await expect(ensureDataFilesForStartup({ senzingPath, targetsNestedPath, refreshMetadataPath, refreshNow })).rejects.toThrow(/Startup data update failed: offline/u);
  });

  test('downloads data when metadata is current but a required local data file is missing', async () => {
    const current = metadata('v1', { senzing: 'old-senzing', targets: 'old-targets' });
    const harness = await createHarness({
      localMetadata: current,
      remoteMetadata: current,
      downloader: vi.fn(async (url, destination) => {
        if (url.includes('senzing')) await writeJsonl(destination, [oldSenzingRecord]);
        else await writeJsonl(destination, [oldTargetRecord]);
      }),
    });
    await fs.rm(harness.targetsNestedPath);

    await expect(harness.refresher.refreshNow()).resolves.toMatchObject({ status: 'updated', version: 'v1' });

    expect(harness.downloader).toHaveBeenCalledTimes(2);
    await expect(fs.access(harness.targetsNestedPath)).resolves.toBeUndefined();
  });
});
