import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { SenzingMemoryRepository } from './senzingMemoryRepository.js';
import { buildSqliteDatabase } from './sqliteBuilder.js';
import { SqliteSenzingRepository, SqliteTargetDetailsRepository } from './sqliteRepositories.js';
import { TargetsNestedMemoryRepository } from './targetsNestedMemoryRepository.js';
import type { ActiveDebarmentRepositories } from '../domain/debarmentService.js';
import type { SenzingLookupRepository, TargetDetailsRepository } from '../domain/types.js';

export const OPENSANCTIONS_DEBARMENT_METADATA_URL = 'https://data.opensanctions.org/datasets/latest/debarment/index.json';
export const OPENSANCTIONS_SECURITIES_METADATA_URL = 'https://data.opensanctions.org/datasets/latest/securities/index.json';
export const TARGET_RESOURCE_NAMES = ['senzing.json', 'targets.nested.json', 'securities.csv'] as const;

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

export const DEFAULT_METADATA_TIMEOUT_MS = 60_000;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

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
  securitiesPath: string;
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
      if (metadataChecksumsMatch(localMetadata, remoteMetadata) && await localRefreshOutputsExist({
        senzingPath: this.options.senzingPath,
        targetsNestedPath: this.options.targetsNestedPath,
        securitiesPath: this.options.securitiesPath,
        sqlitePath: this.options.sqlitePath,
      })) {
        return { status: 'current', version: remoteMetadata.version, message: `OpenSanctions debarment data is already current (${remoteMetadata.version}).` };
      }

      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opensanctions-refresh-'));
      const stagedSenzingPath = path.join(tempDir, 'senzing.json');
      const stagedTargetsPath = path.join(tempDir, 'targets.nested.json');
      const stagedSecuritiesPath = path.join(tempDir, 'securities.csv');
      const stagedSqlitePath = this.options.sqlitePath ? path.join(tempDir, 'sanction.sqlite') : undefined;

      await this.downloader(remoteMetadata.resources['senzing.json'].url, stagedSenzingPath);
      await this.downloader(remoteMetadata.resources['targets.nested.json'].url, stagedTargetsPath);
      await this.downloader(remoteMetadata.resources['securities.csv'].url, stagedSecuritiesPath);
      await validateDownloadedResource(stagedSenzingPath, remoteMetadata.resources['senzing.json']);
      await validateDownloadedResource(stagedTargetsPath, remoteMetadata.resources['targets.nested.json']);
      await validateDownloadedResource(stagedSecuritiesPath, remoteMetadata.resources['securities.csv']);

      let nextSenzingRepository: SenzingLookupRepository | undefined;
      let nextTargetsRepository: TargetDetailsRepository | undefined;
      if (stagedSqlitePath && this.options.sqlitePath) {
        await buildSqliteDatabase({
          senzingPath: stagedSenzingPath,
          targetsNestedPath: stagedTargetsPath,
          securitiesPath: stagedSecuritiesPath,
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
        stagedSecuritiesPath,
        stagedSqlitePath,
        senzingPath: this.options.senzingPath,
        targetsNestedPath: this.options.targetsNestedPath,
        securitiesPath: this.options.securitiesPath,
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

export function parseDatasetMetadata(
  raw: unknown,
  resourceNames: readonly TargetResourceName[] = TARGET_RESOURCE_NAMES,
): DatasetMetadata {
  if (!raw || typeof raw !== 'object') throw new Error('OpenSanctions metadata response is not an object.');
  const object = raw as Record<string, unknown>;
  const version = stringValue(object.version);
  if (!version) throw new Error('OpenSanctions metadata is missing dataset version.');
  const rawResources = Array.isArray(object.resources) ? object.resources : [];
  const resources = Object.fromEntries(
    resourceNames.map((name) => {
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
  stagedSecuritiesPath: string;
  stagedSqlitePath?: string;
  senzingPath: string;
  targetsNestedPath: string;
  securitiesPath: string;
  sqlitePath?: string;
  refreshMetadataPath: string;
  metadata: DatasetMetadata;
  logger?: Pick<Console, 'warn'>;
  afterPublish?: () => Promise<void>;
}


async function localRefreshOutputsExist(options: { senzingPath: string; targetsNestedPath: string; securitiesPath: string; sqlitePath?: string }): Promise<boolean> {
  for (const filePath of [options.senzingPath, options.targetsNestedPath, options.securitiesPath, options.sqlitePath].filter(isDefinedString)) {
    try {
      const stats = await fs.stat(filePath);
      if (stats.size === 0) return false;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

async function replaceLocalFilesAndMetadata(options: ReplaceLocalFilesOptions): Promise<void> {
  await fs.mkdir(path.dirname(options.senzingPath), { recursive: true });
  await fs.mkdir(path.dirname(options.targetsNestedPath), { recursive: true });
  await fs.mkdir(path.dirname(options.securitiesPath), { recursive: true });
  if (options.sqlitePath) await fs.mkdir(path.dirname(options.sqlitePath), { recursive: true });
  await fs.mkdir(path.dirname(options.refreshMetadataPath), { recursive: true });

  const backupSuffix = `.refresh-backup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const senzingBackupPath = `${options.senzingPath}${backupSuffix}`;
  const targetsBackupPath = `${options.targetsNestedPath}${backupSuffix}`;
  const securitiesBackupPath = `${options.securitiesPath}${backupSuffix}`;
  const sqliteBackupPath = options.sqlitePath ? `${options.sqlitePath}${backupSuffix}` : undefined;
  const metadataBackupPath = `${options.refreshMetadataPath}${backupSuffix}`;
  const metadataTempPath = `${options.refreshMetadataPath}.tmp-${process.pid}-${Date.now()}`;
  let movedSenzing = false;
  let movedTargets = false;
  let movedSecurities = false;
  let copiedSqlite = false;
  let movedMetadata = false;
  let publishedSenzing = false;
  let publishedTargets = false;
  let publishedSecurities = false;
  let publishedSqlite = false;
  let publishedMetadata = false;

  try {
    movedSenzing = await moveIfExists(options.senzingPath, senzingBackupPath);
    movedTargets = await moveIfExists(options.targetsNestedPath, targetsBackupPath);
    movedSecurities = await moveIfExists(options.securitiesPath, securitiesBackupPath);
    copiedSqlite = options.sqlitePath && sqliteBackupPath ? await copyIfExists(options.sqlitePath, sqliteBackupPath) : false;
    movedMetadata = await moveIfExists(options.refreshMetadataPath, metadataBackupPath);
    await fs.copyFile(options.stagedSenzingPath, options.senzingPath);
    publishedSenzing = true;
    await fs.copyFile(options.stagedTargetsPath, options.targetsNestedPath);
    publishedTargets = true;
    await fs.copyFile(options.stagedSecuritiesPath, options.securitiesPath);
    publishedSecurities = true;
    if (options.stagedSqlitePath && options.sqlitePath) {
      await fs.copyFile(options.stagedSqlitePath, options.sqlitePath);
      publishedSqlite = true;
    }
    await writePersistedMetadata(metadataTempPath, options.metadata);
    await fs.rename(metadataTempPath, options.refreshMetadataPath);
    publishedMetadata = true;
    await options.afterPublish?.();
  } catch (error) {
    await removeIfExists(metadataTempPath);
    if (movedSenzing || publishedSenzing) await removeIfExists(options.senzingPath);
    if (movedTargets || publishedTargets) await removeIfExists(options.targetsNestedPath);
    if (movedSecurities || publishedSecurities) await removeIfExists(options.securitiesPath);
    if (options.sqlitePath && copiedSqlite && sqliteBackupPath) {
      await fs.copyFile(sqliteBackupPath, options.sqlitePath);
    } else if (options.sqlitePath && publishedSqlite) {
      await removeIfExists(options.sqlitePath);
    }
    if (movedMetadata || publishedMetadata) await removeIfExists(options.refreshMetadataPath);
    if (movedSenzing) await fs.rename(senzingBackupPath, options.senzingPath);
    if (movedTargets) await fs.rename(targetsBackupPath, options.targetsNestedPath);
    if (movedSecurities) await fs.rename(securitiesBackupPath, options.securitiesPath);
    if (movedMetadata) await fs.rename(metadataBackupPath, options.refreshMetadataPath);
    throw error;
  }

  await removeBackupFiles([senzingBackupPath, targetsBackupPath, securitiesBackupPath, metadataBackupPath, sqliteBackupPath].filter(isDefinedString), options.logger);
}

function isDefinedString(value: string | undefined): value is string {
  return typeof value === 'string';
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

async function moveIfExists(sourcePath: string, destinationPath: string): Promise<boolean> {
  try {
    await fs.rename(sourcePath, destinationPath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function copyIfExists(sourcePath: string, destinationPath: string): Promise<boolean> {
  try {
    await fs.copyFile(sourcePath, destinationPath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function removeIfExists(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}

async function removeBackupFiles(filePaths: string[], logger: Pick<Console, 'warn'> = console): Promise<void> {
  const failures: string[] = [];
  for (const filePath of filePaths) {
    try {
      await removeIfExists(filePath);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${filePath}: ${reason}`);
    }
  }
  if (failures.length > 0) logger.warn('OpenSanctions refresh backup cleanup failed:', failures);
}

async function readPersistedMetadata(filePath: string): Promise<DatasetMetadata | undefined> {
  try {
    return parsePersistedMetadata(JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writePersistedMetadata(filePath: string, metadata: DatasetMetadata): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
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

async function validateDownloadedResource(filePath: string, metadata: DatasetResourceMetadata): Promise<void> {
  const stats = await fs.stat(filePath);
  if (stats.size === 0) throw new Error(`${metadata.name} download is empty.`);
  if (metadata.size !== undefined && metadata.size > 0 && stats.size !== metadata.size) {
    throw new Error(`${metadata.name} size mismatch.`);
  }
  await verifyChecksum(filePath, metadata);
}

async function verifyChecksum(filePath: string, metadata: DatasetResourceMetadata): Promise<void> {
  const parsed = parseChecksum(metadata.checksum);
  if (!parsed) throw new Error(`${metadata.name} checksum format is not supported.`);
  const actual = await hashFile(filePath, parsed.algorithm);
  if (actual !== parsed.hex) throw new Error(`${metadata.name} checksum mismatch.`);
}

function parseChecksum(checksum: string): { algorithm: 'sha256' | 'sha1' | 'md5'; hex: string } | undefined {
  const normalized = checksum.trim().toLocaleLowerCase('en-US');
  const prefixed = normalized.match(/^(sha256|sha1|md5)[:=]([a-f0-9]+)$/u);
  if (prefixed) return { algorithm: prefixed[1] as 'sha256' | 'sha1' | 'md5', hex: prefixed[2] };
  if (/^[a-f0-9]{64}$/u.test(normalized)) return { algorithm: 'sha256', hex: normalized };
  if (/^[a-f0-9]{40}$/u.test(normalized)) return { algorithm: 'sha1', hex: normalized };
  if (/^[a-f0-9]{32}$/u.test(normalized)) return { algorithm: 'md5', hex: normalized };
  return undefined;
}

async function hashFile(filePath: string, algorithm: 'sha256' | 'sha1' | 'md5'): Promise<string> {
  const hash = createHash(algorithm);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function downloadWithFetch(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DEFAULT_DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Download failed for ${url} with HTTP ${response.status}`);
  if (!response.body) throw new Error(`Download failed for ${url}: empty response body.`);

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destinationPath));
}

function resourceName(resource: unknown): string {
  if (!resource || typeof resource !== 'object') return '';
  const object = resource as Record<string, unknown>;
  const candidates = [object.name, object.title, object.path, object.url].map(stringValue).filter(Boolean);
  for (const candidate of candidates) {
    const basename = path.basename(candidate);
    if (basename === 'senzing.json' || basename === 'targets.nested.json' || basename === 'securities.csv') return basename;
  }
  return '';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
