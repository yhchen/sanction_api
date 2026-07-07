import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SenzingMemoryRepository } from './senzingMemoryRepository.js';
import {
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_METADATA_TIMEOUT_MS,
  downloadWithFetch,
  isNodeError,
  localFilesPopulated,
  replaceFilesAndMetadata,
  validateDownloadedResource,
} from './refreshShared.js';
import { buildSqliteDatabase } from './sqliteBuilder.js';
import { SqliteSenzingRepository, SqliteTargetDetailsRepository } from './sqliteRepositories.js';
import { TargetsNestedMemoryRepository } from './targetsNestedMemoryRepository.js';
import type { ActiveDebarmentRepositories } from '../domain/debarmentService.js';
import type { SenzingLookupRepository, TargetDetailsRepository } from '../domain/types.js';

export const OPENSANCTIONS_DEBARMENT_METADATA_URL = 'https://data.opensanctions.org/datasets/latest/debarment/index.json';
export const TARGET_RESOURCE_NAMES = ['senzing.json', 'targets.nested.json'] as const;

export type TargetResourceName = (typeof TARGET_RESOURCE_NAMES)[number];

export interface DatasetResourceMetadata {
  name: TargetResourceName;
  url: string;
  checksum: string;
  size?: number;
}

export interface DatasetMetadata {
  version: string;
  resources: Record<TargetResourceName, DatasetResourceMetadata>;
}

export type RefreshMetadataFetcher = () => Promise<DatasetMetadata>;
export type RefreshDownloader = (url: string, destinationPath: string) => Promise<void>;

export { DEFAULT_DOWNLOAD_TIMEOUT_MS, DEFAULT_METADATA_TIMEOUT_MS } from './refreshShared.js';

export type RefreshStatus = 'current' | 'updated' | 'failed' | 'in_progress';

export interface RefreshResult {
  status: RefreshStatus;
  version?: string;
  message: string;
  error?: string;
}

export interface DataRefreshServiceOptions {
  senzingPath: string;
  targetsNestedPath: string;
  sqlitePath?: string;
  refreshMetadataPath: string;
  activeRepositories: ActiveDebarmentRepositories;
  fetchMetadata?: RefreshMetadataFetcher;
  downloader?: RefreshDownloader;
  minFuzzyScore?: number;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export class DataRefreshService {
  private readonly fetchMetadata: RefreshMetadataFetcher;
  private readonly downloader: RefreshDownloader;
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  private activeRun?: Promise<RefreshResult>;

  constructor(private readonly options: DataRefreshServiceOptions) {
    this.fetchMetadata = options.fetchMetadata ?? fetchOpenSanctionsDebarmentMetadata;
    this.downloader = options.downloader ?? downloadWithFetch;
    this.logger = options.logger ?? console;
  }

  refreshNow(): Promise<RefreshResult> {
    if (this.activeRun) {
      return Promise.resolve({ status: 'in_progress', message: 'Data refresh is already running.' });
    }

    this.activeRun = this.runRefresh().finally(() => {
      this.activeRun = undefined;
    });
    return this.activeRun;
  }

  private async runRefresh(): Promise<RefreshResult> {
    let tempDir: string | undefined;
    try {
      const remoteMetadata = await this.fetchMetadata();
      const localMetadata = await readPersistedMetadata(this.options.refreshMetadataPath);
      if (metadataChecksumsMatch(localMetadata, remoteMetadata) && await localFilesPopulated([
        this.options.senzingPath,
        this.options.targetsNestedPath,
        this.options.sqlitePath,
      ])) {
        return { status: 'current', version: remoteMetadata.version, message: `OpenSanctions debarment data is already current (${remoteMetadata.version}).` };
      }

      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opensanctions-refresh-'));
      const stagedSenzingPath = path.join(tempDir, 'senzing.json');
      const stagedTargetsPath = path.join(tempDir, 'targets.nested.json');
      const stagedSqlitePath = this.options.sqlitePath ? path.join(tempDir, 'sanction.sqlite') : undefined;

      await this.downloader(remoteMetadata.resources['senzing.json'].url, stagedSenzingPath);
      await this.downloader(remoteMetadata.resources['targets.nested.json'].url, stagedTargetsPath);
      await validateDownloadedResource(stagedSenzingPath, remoteMetadata.resources['senzing.json']);
      await validateDownloadedResource(stagedTargetsPath, remoteMetadata.resources['targets.nested.json']);

      let nextSenzingRepository: SenzingLookupRepository | undefined;
      let nextTargetsRepository: TargetDetailsRepository | undefined;
      if (stagedSqlitePath && this.options.sqlitePath) {
        await buildSqliteDatabase({
          senzingPath: stagedSenzingPath,
          targetsNestedPath: stagedTargetsPath,
          sqlitePath: stagedSqlitePath,
        });
        validateSqliteRepositories(stagedSqlitePath);
      } else {
        nextSenzingRepository = await SenzingMemoryRepository.fromFile(stagedSenzingPath, {
          minFuzzyScore: this.options.minFuzzyScore,
        });
        nextTargetsRepository = await TargetsNestedMemoryRepository.fromFile(stagedTargetsPath);
      }

      await replaceLocalFilesAndMetadata({
        stagedSenzingPath,
        stagedTargetsPath,
        stagedSqlitePath,
        senzingPath: this.options.senzingPath,
        targetsNestedPath: this.options.targetsNestedPath,
        sqlitePath: this.options.sqlitePath,
        refreshMetadataPath: this.options.refreshMetadataPath,
        metadata: remoteMetadata,
        logger: this.logger,
        afterPublish: this.options.sqlitePath
          ? async () => {
              let openedSenzingRepository: SqliteSenzingRepository | undefined;
              let openedTargetsRepository: SqliteTargetDetailsRepository | undefined;
              try {
                openedSenzingRepository = SqliteSenzingRepository.open(this.options.sqlitePath!, {
                  minFuzzyScore: this.options.minFuzzyScore,
                });
                openedTargetsRepository = SqliteTargetDetailsRepository.open(this.options.sqlitePath!);
                nextSenzingRepository = openedSenzingRepository;
                nextTargetsRepository = openedTargetsRepository;
              } catch (error) {
                openedTargetsRepository?.close();
                openedSenzingRepository?.close();
                throw error;
              }
            }
          : undefined,
      });
      if (!nextSenzingRepository || !nextTargetsRepository) throw new Error('Data refresh did not create replacement repositories.');
      this.options.activeRepositories.replace(nextSenzingRepository, nextTargetsRepository);

      this.logger.info('OpenSanctions debarment data refreshed.', { version: remoteMetadata.version });
      return { status: 'updated', version: remoteMetadata.version, message: `OpenSanctions debarment data updated to ${remoteMetadata.version}.` };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error('OpenSanctions debarment data refresh failed:', reason);
      return { status: 'failed', message: `Data refresh failed: ${reason}`, error: reason };
    } finally {
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

export interface RefreshSchedulerOptions {
  timeOfDay?: string;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  logger?: Pick<Console, 'warn' | 'info' | 'error'>;
}

export interface RefreshRunner {
  refreshNow(): Promise<RefreshResult>;
}

export interface ScheduledRefreshHandle {
  cancel(): void;
}

export function scheduleDailyRefresh(refreshRunner: RefreshRunner, options: RefreshSchedulerOptions = {}): ScheduledRefreshHandle {
  const timeOfDay = options.timeOfDay ?? '05:00';
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const logger = options.logger ?? console;
  let cancelled = false;
  let currentTimer: unknown;

  const scheduleFrom = (base: Date) => {
    if (cancelled) return;
    const nextRun = nextLocalRunAt(base, timeOfDay);
    const delay = Math.max(0, nextRun.getTime() - base.getTime());
    currentTimer = setTimer(() => {
      void refreshRunner.refreshNow().catch((error: unknown) => {
        logger.error('Scheduled data refresh failed:', error);
      }).finally(() => {
        scheduleFrom(now());
      });
    }, delay);
  };

  scheduleFrom(now());
  return {
    cancel() {
      cancelled = true;
      if (typeof currentTimer === 'object' && currentTimer && 'hasRef' in currentTimer) clearTimeout(currentTimer as NodeJS.Timeout);
    },
  };
}

export function nextLocalRunAt(base: Date, timeOfDay: string): Date {
  const match = timeOfDay.match(/^(\d{2}):(\d{2})$/u);
  if (!match) throw new Error('Refresh schedule time must use HH:MM format.');
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error('Refresh schedule time must use HH:MM format.');
  const next = new Date(base);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= base.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

export async function fetchOpenSanctionsDebarmentMetadata(): Promise<DatasetMetadata> {
  const response = await fetch(OPENSANCTIONS_DEBARMENT_METADATA_URL, { signal: AbortSignal.timeout(DEFAULT_METADATA_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Metadata fetch failed with HTTP ${response.status}`);
  return parseDatasetMetadata(await response.json());
}

export function parseDatasetMetadata(raw: unknown): DatasetMetadata {
  if (!raw || typeof raw !== 'object') throw new Error('OpenSanctions metadata response is not an object.');
  const object = raw as Record<string, unknown>;
  const version = stringValue(object.version);
  if (!version) throw new Error('OpenSanctions metadata is missing dataset version.');
  const rawResources = Array.isArray(object.resources) ? object.resources : [];
  const resources = Object.fromEntries(
    TARGET_RESOURCE_NAMES.map((name) => {
      const resource = rawResources.find((candidate) => resourceName(candidate) === name);
      if (!resource || typeof resource !== 'object') throw new Error(`OpenSanctions metadata missing ${name}.`);
      const resourceObject = resource as Record<string, unknown>;
      const url = stringValue(resourceObject.url) || stringValue(resourceObject.path);
      const checksum = stringValue(resourceObject.checksum) || stringValue(resourceObject.hash);
      if (!url) throw new Error(`OpenSanctions metadata ${name} is missing url/path.`);
      if (!checksum) throw new Error(`OpenSanctions metadata ${name} is missing checksum.`);
      const size = numberValue(resourceObject.size);
      return [name, { name, url, checksum, size }] as const;
    }),
  ) as Record<TargetResourceName, DatasetResourceMetadata>;

  return { version, resources };
}

interface ReplaceLocalFilesOptions {
  stagedSenzingPath: string;
  stagedTargetsPath: string;
  stagedSqlitePath?: string;
  senzingPath: string;
  targetsNestedPath: string;
  sqlitePath?: string;
  refreshMetadataPath: string;
  metadata: DatasetMetadata;
  logger?: Pick<Console, 'warn'>;
  afterPublish?: () => Promise<void>;
}


async function replaceLocalFilesAndMetadata(options: ReplaceLocalFilesOptions): Promise<void> {
  const metadataTempPath = `${options.refreshMetadataPath}.tmp-${process.pid}-${Date.now()}`;
  await replaceFilesAndMetadata({
    files: [
      { stagedPath: options.stagedSenzingPath, finalPath: options.senzingPath },
      { stagedPath: options.stagedTargetsPath, finalPath: options.targetsNestedPath },
    ],
    sqlite: options.stagedSqlitePath && options.sqlitePath
      ? { stagedPath: options.stagedSqlitePath, finalPath: options.sqlitePath }
      : undefined,
    metadataPath: options.refreshMetadataPath,
    metadataTempPath,
    metadataContents: `${JSON.stringify(options.metadata, null, 2)}\n`,
    logger: options.logger,
    afterPublish: options.afterPublish,
  });
}

function validateSqliteRepositories(sqlitePath: string): void {
  const senzingRepository = SqliteSenzingRepository.open(sqlitePath);
  let targetDetailsRepository: SqliteTargetDetailsRepository | undefined;
  try {
    targetDetailsRepository = SqliteTargetDetailsRepository.open(sqlitePath);
  } finally {
    targetDetailsRepository?.close();
    senzingRepository.close();
  }
}

async function readPersistedMetadata(filePath: string): Promise<DatasetMetadata | undefined> {
  try {
    return parsePersistedMetadata(JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function parsePersistedMetadata(raw: unknown): DatasetMetadata {
  if (!raw || typeof raw !== 'object') throw new Error('Refresh metadata JSON is not an object.');
  const object = raw as Record<string, unknown>;
  if (typeof object.version !== 'string' || !object.resources || typeof object.resources !== 'object') {
    throw new Error('Refresh metadata JSON has invalid shape.');
  }
  const resources = object.resources as Record<string, unknown>;
  for (const name of TARGET_RESOURCE_NAMES) {
    const resource = resources[name];
    if (!resource || typeof resource !== 'object') throw new Error(`Refresh metadata missing ${name}.`);
    const checksum = (resource as Record<string, unknown>).checksum;
    if (typeof checksum !== 'string' || !checksum.trim()) throw new Error(`Refresh metadata ${name} missing checksum.`);
  }
  return raw as DatasetMetadata;
}

function metadataChecksumsMatch(local: DatasetMetadata | undefined, remote: DatasetMetadata): boolean {
  if (!local) return false;
  return TARGET_RESOURCE_NAMES.every((name) => local.resources[name]?.checksum === remote.resources[name].checksum);
}

function resourceName(resource: unknown): string {
  if (!resource || typeof resource !== 'object') return '';
  const object = resource as Record<string, unknown>;
  const candidates = [object.name, object.title, object.path, object.url].map(stringValue).filter(Boolean);
  for (const candidate of candidates) {
    const basename = path.basename(candidate);
    if (basename === 'senzing.json' || basename === 'targets.nested.json') return basename;
  }
  return '';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
