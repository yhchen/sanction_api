import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { SenzingMemoryRepository } from './senzingMemoryRepository.js';
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
  refreshMetadataPath: string;
  activeRepositories: ActiveDebarmentRepositories;
  fetchMetadata?: RefreshMetadataFetcher;
  downloader?: RefreshDownloader;
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
      if (metadataChecksumsMatch(localMetadata, remoteMetadata) && await localDataFilesExist({
        senzingPath: this.options.senzingPath,
        targetsNestedPath: this.options.targetsNestedPath,
      })) {
        return { status: 'current', version: remoteMetadata.version, message: `OpenSanctions debarment data is already current (${remoteMetadata.version}).` };
      }

      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opensanctions-refresh-'));
      const stagedSenzingPath = path.join(tempDir, 'senzing.json');
      const stagedTargetsPath = path.join(tempDir, 'targets.nested.json');

      await this.downloader(remoteMetadata.resources['senzing.json'].url, stagedSenzingPath);
      await this.downloader(remoteMetadata.resources['targets.nested.json'].url, stagedTargetsPath);
      await validateDownloadedResource(stagedSenzingPath, remoteMetadata.resources['senzing.json']);
      await validateDownloadedResource(stagedTargetsPath, remoteMetadata.resources['targets.nested.json']);

      const nextSenzingRepository = await SenzingMemoryRepository.fromFile(stagedSenzingPath);
      const nextTargetsRepository = await TargetsNestedMemoryRepository.fromFile(stagedTargetsPath);

      await replaceLocalFilesAndMetadata({
        stagedSenzingPath,
        stagedTargetsPath,
        senzingPath: this.options.senzingPath,
        targetsNestedPath: this.options.targetsNestedPath,
        refreshMetadataPath: this.options.refreshMetadataPath,
        metadata: remoteMetadata,
        logger: this.logger,
      });
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
  senzingPath: string;
  targetsNestedPath: string;
  refreshMetadataPath: string;
  metadata: DatasetMetadata;
  logger?: Pick<Console, 'warn'>;
}


async function localDataFilesExist(options: { senzingPath: string; targetsNestedPath: string }): Promise<boolean> {
  for (const filePath of [options.senzingPath, options.targetsNestedPath]) {
    try {
      await fs.access(filePath);
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
  await fs.mkdir(path.dirname(options.refreshMetadataPath), { recursive: true });

  const backupSuffix = `.refresh-backup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const senzingBackupPath = `${options.senzingPath}${backupSuffix}`;
  const targetsBackupPath = `${options.targetsNestedPath}${backupSuffix}`;
  const metadataBackupPath = `${options.refreshMetadataPath}${backupSuffix}`;
  const metadataTempPath = `${options.refreshMetadataPath}.tmp-${process.pid}-${Date.now()}`;
  const movedSenzing = await moveIfExists(options.senzingPath, senzingBackupPath);
  const movedTargets = await moveIfExists(options.targetsNestedPath, targetsBackupPath);
  const movedMetadata = await moveIfExists(options.refreshMetadataPath, metadataBackupPath);

  try {
    await fs.copyFile(options.stagedSenzingPath, options.senzingPath);
    await fs.copyFile(options.stagedTargetsPath, options.targetsNestedPath);
    await writePersistedMetadata(metadataTempPath, options.metadata);
    await fs.rename(metadataTempPath, options.refreshMetadataPath);
  } catch (error) {
    await removeIfExists(metadataTempPath);
    await removeIfExists(options.senzingPath);
    await removeIfExists(options.targetsNestedPath);
    await removeIfExists(options.refreshMetadataPath);
    if (movedSenzing) await fs.rename(senzingBackupPath, options.senzingPath);
    if (movedTargets) await fs.rename(targetsBackupPath, options.targetsNestedPath);
    if (movedMetadata) await fs.rename(metadataBackupPath, options.refreshMetadataPath);
    throw error;
  }

  await removeBackupFiles([senzingBackupPath, targetsBackupPath, metadataBackupPath], options.logger);
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
