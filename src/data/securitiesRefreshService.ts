import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RefreshDownloader, RefreshResult } from './dataRefreshService.js';
import { fetchSecuritiesSourceMetadata, type SecuritiesSourceMetadata } from './openSanctionsCatalog.js';
import {
  downloadWithFetch,
  isNodeError,
  localFilesPopulated,
  replaceFilesAndMetadata,
  validateDownloadedResource,
} from './refreshShared.js';
import { SenzingMemoryRepository } from './senzingMemoryRepository.js';
import { buildSqliteDatabase } from './sqliteBuilder.js';
import { SqliteSenzingRepository, SqliteTargetDetailsRepository } from './sqliteRepositories.js';
import { TargetsNestedMemoryRepository } from './targetsNestedMemoryRepository.js';
import type { ActiveSecuritiesRepositories } from '../domain/securitiesService.js';
import type { SenzingLookupRepository, TargetDetailsRepository } from '../domain/types.js';

export type SecuritiesSourceMetadataFetcher = () => Promise<SecuritiesSourceMetadata[]>;

export interface SecuritiesRefreshServiceOptions {
  senzingPath: string;
  targetsNestedPath: string;
  sqlitePath?: string;
  refreshMetadataPath: string;
  activeRepositories: ActiveSecuritiesRepositories;
  fetchSourceMetadata?: SecuritiesSourceMetadataFetcher;
  downloader?: RefreshDownloader;
  minFuzzyScore?: number;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

interface PersistedSecuritiesDatasetMetadata {
  version: string;
  senzingChecksum: string;
  targetsNestedChecksum: string;
}

interface PersistedSecuritiesMetadata {
  datasets: Record<string, PersistedSecuritiesDatasetMetadata>;
}

/**
 * Refreshes the merged "Sanctioned Securities" dataset: discovers the OpenSanctions `securities`
 * collection's eligible source datasets (those exposing `senzing.json`/`targets.nested.json`),
 * downloads each one, concatenates them into a single merged senzing.json/targets.nested.json
 * pair, and builds/replaces the securities repositories from that merge — independently of the
 * debarment pipeline in `DataRefreshService`.
 */
export class SecuritiesRefreshService {
  private readonly fetchSourceMetadata: SecuritiesSourceMetadataFetcher;
  private readonly downloader: RefreshDownloader;
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  private activeRun?: Promise<RefreshResult>;

  constructor(private readonly options: SecuritiesRefreshServiceOptions) {
    this.fetchSourceMetadata = options.fetchSourceMetadata ?? fetchSecuritiesSourceMetadata;
    this.downloader = options.downloader ?? downloadWithFetch;
    this.logger = options.logger ?? console;
  }

  refreshNow(): Promise<RefreshResult> {
    if (this.activeRun) {
      return Promise.resolve({ status: 'in_progress', message: 'Securities data refresh is already running.' });
    }

    this.activeRun = this.runRefresh().finally(() => {
      this.activeRun = undefined;
    });
    return this.activeRun;
  }

  private async runRefresh(): Promise<RefreshResult> {
    let tempDir: string | undefined;
    try {
      const remoteDatasets = await this.fetchSourceMetadata();
      if (remoteDatasets.length === 0) {
        throw new Error('No eligible OpenSanctions securities source datasets were found.');
      }
      const remoteMetadata = toPersistedMetadata(remoteDatasets);
      const localMetadata = await readPersistedMetadata(this.options.refreshMetadataPath);
      const version = versionLabel(remoteDatasets);

      if (metadataMatches(localMetadata, remoteMetadata) && await localFilesPopulated([
        this.options.senzingPath,
        this.options.targetsNestedPath,
        this.options.sqlitePath,
      ])) {
        return { status: 'current', version, message: `Securities data is already current across ${remoteDatasets.length} source datasets (${version}).` };
      }

      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'securities-refresh-'));
      await this.downloadAndValidate(remoteDatasets, tempDir);

      const stagedSenzingPath = path.join(tempDir, 'senzing.json');
      const stagedTargetsPath = path.join(tempDir, 'targets.nested.json');
      // OpenSanctions assigns stable canonical entity ids, so the same real-world entity can
      // appear under the identical RECORD_ID/id in more than one of the merged source datasets
      // (e.g. a bank sanctioned by both the EU and US lists) — dedupe by id when merging so the
      // combined file has unique primary keys for the SQLite build and memory-repository index.
      await mergeJsonlFiles(remoteDatasets.map((dataset) => senzingDownloadPath(tempDir!, dataset)), stagedSenzingPath, (record) => idField(record, 'RECORD_ID'));
      await mergeJsonlFiles(remoteDatasets.map((dataset) => targetsNestedDownloadPath(tempDir!, dataset)), stagedTargetsPath, (record) => idField(record, 'id'));

      const stagedSqlitePath = this.options.sqlitePath ? path.join(tempDir, 'securities.sqlite') : undefined;
      let nextSenzingRepository: SenzingLookupRepository | undefined;
      let nextTargetsRepository: TargetDetailsRepository | undefined;
      if (stagedSqlitePath && this.options.sqlitePath) {
        await buildSqliteDatabase({
          senzingPath: stagedSenzingPath,
          targetsNestedPath: stagedTargetsPath,
          sqlitePath: stagedSqlitePath,
          isIncludedRecord: () => true,
        });
        validateSqliteRepositories(stagedSqlitePath);
      } else {
        nextSenzingRepository = await SenzingMemoryRepository.fromFile(stagedSenzingPath, {
          minFuzzyScore: this.options.minFuzzyScore,
        });
        nextTargetsRepository = await TargetsNestedMemoryRepository.fromFile(stagedTargetsPath);
      }

      await replaceFilesAndMetadata({
        files: [
          { stagedPath: stagedSenzingPath, finalPath: this.options.senzingPath },
          { stagedPath: stagedTargetsPath, finalPath: this.options.targetsNestedPath },
        ],
        sqlite: stagedSqlitePath && this.options.sqlitePath
          ? { stagedPath: stagedSqlitePath, finalPath: this.options.sqlitePath }
          : undefined,
        metadataPath: this.options.refreshMetadataPath,
        metadataTempPath: `${this.options.refreshMetadataPath}.tmp-${process.pid}-${Date.now()}`,
        metadataContents: `${JSON.stringify(remoteMetadata, null, 2)}\n`,
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
      if (!nextSenzingRepository || !nextTargetsRepository) throw new Error('Securities data refresh did not create replacement repositories.');
      this.options.activeRepositories.replace(nextSenzingRepository, nextTargetsRepository);

      this.logger.info('Securities data refreshed.', { version, datasets: remoteDatasets.length });
      return { status: 'updated', version, message: `Securities data updated across ${remoteDatasets.length} source datasets (${version}).` };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error('Securities data refresh failed:', reason);
      return { status: 'failed', message: `Securities data refresh failed: ${reason}`, error: reason };
    } finally {
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  private async downloadAndValidate(datasets: SecuritiesSourceMetadata[], tempDir: string): Promise<void> {
    for (const dataset of datasets) {
      const senzingDest = senzingDownloadPath(tempDir, dataset);
      const targetsDest = targetsNestedDownloadPath(tempDir, dataset);
      await this.downloader(dataset.senzing.url, senzingDest);
      await this.downloader(dataset.targetsNested.url, targetsDest);
      await validateDownloadedResource(senzingDest, { name: `${dataset.slug}/senzing.json`, checksum: dataset.senzing.checksum, size: dataset.senzing.size });
      await validateDownloadedResource(targetsDest, { name: `${dataset.slug}/targets.nested.json`, checksum: dataset.targetsNested.checksum, size: dataset.targetsNested.size });
    }
  }
}

function senzingDownloadPath(tempDir: string, dataset: SecuritiesSourceMetadata): string {
  return path.join(tempDir, `${dataset.slug}.senzing.json`);
}

function targetsNestedDownloadPath(tempDir: string, dataset: SecuritiesSourceMetadata): string {
  return path.join(tempDir, `${dataset.slug}.targets.nested.json`);
}

/**
 * Concatenates JSONL files into one, dropping any line whose id (per `keyOf`) was already seen
 * in an earlier source file — see the caller for why duplicates are expected across datasets.
 */
async function mergeJsonlFiles(sourcePaths: string[], destinationPath: string, keyOf: (record: Record<string, unknown>) => string | undefined): Promise<void> {
  const seenKeys = new Set<string>();
  const handle = await fs.open(destinationPath, 'w');
  try {
    for (const sourcePath of sourcePaths) {
      const contents = await fs.readFile(sourcePath, 'utf8');
      if (!contents) continue;

      const outputLines: string[] = [];
      for (const line of contents.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const key = keyOf(JSON.parse(trimmed) as Record<string, unknown>);
        if (key !== undefined) {
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
        }
        outputLines.push(trimmed);
      }
      if (outputLines.length > 0) await handle.appendFile(`${outputLines.join('\n')}\n`, 'utf8');
    }
  } finally {
    await handle.close();
  }
}

function idField(record: Record<string, unknown>, field: 'RECORD_ID' | 'id'): string | undefined {
  const value = record[field];
  return typeof value === 'string' ? value : undefined;
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

function toPersistedMetadata(datasets: SecuritiesSourceMetadata[]): PersistedSecuritiesMetadata {
  return {
    datasets: Object.fromEntries(
      datasets.map((dataset) => [
        dataset.slug,
        { version: dataset.version, senzingChecksum: dataset.senzing.checksum, targetsNestedChecksum: dataset.targetsNested.checksum },
      ]),
    ),
  };
}

function versionLabel(datasets: SecuritiesSourceMetadata[]): string {
  return `${datasets.length} datasets, latest ${datasets.map((dataset) => dataset.version).sort().at(-1)}`;
}

function metadataMatches(local: PersistedSecuritiesMetadata | undefined, remote: PersistedSecuritiesMetadata): boolean {
  if (!local) return false;
  const localSlugs = Object.keys(local.datasets);
  const remoteSlugs = Object.keys(remote.datasets);
  if (localSlugs.length !== remoteSlugs.length) return false;
  return remoteSlugs.every((slug) => {
    const localEntry = local.datasets[slug];
    const remoteEntry = remote.datasets[slug];
    return (
      localEntry !== undefined &&
      localEntry.senzingChecksum === remoteEntry.senzingChecksum &&
      localEntry.targetsNestedChecksum === remoteEntry.targetsNestedChecksum
    );
  });
}

async function readPersistedMetadata(filePath: string): Promise<PersistedSecuritiesMetadata | undefined> {
  try {
    return parsePersistedMetadata(JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function parsePersistedMetadata(raw: unknown): PersistedSecuritiesMetadata {
  if (!raw || typeof raw !== 'object' || !('datasets' in raw) || typeof (raw as Record<string, unknown>).datasets !== 'object') {
    throw new Error('Securities refresh metadata JSON has invalid shape.');
  }
  return raw as PersistedSecuritiesMetadata;
}
