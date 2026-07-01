import fs from 'node:fs/promises';
import { DataRefreshService, type RefreshResult } from './dataRefreshService.js';
import { SenzingMemoryRepository } from './senzingMemoryRepository.js';
import { TargetsNestedMemoryRepository } from './targetsNestedMemoryRepository.js';
import { ActiveDebarmentRepositories } from '../domain/debarmentService.js';

export interface StartupDataFilesOptions {
  senzingPath: string;
  targetsNestedPath: string;
  securitiesPath: string;
  refreshMetadataPath: string;
  refreshNow?: () => Promise<RefreshResult>;
  logger?: Pick<Console, 'info' | 'warn'>;
}

export async function ensureDataFilesForStartup(options: StartupDataFilesOptions): Promise<RefreshResult | undefined> {
  const requiredFiles = [options.senzingPath, options.targetsNestedPath, options.securitiesPath];
  const missingFiles = await missingLocalFiles(requiredFiles);
  if (missingFiles.length === 0) return undefined;

  const logger = options.logger ?? console;
  logger.warn('OpenSanctions data files are missing; running startup data update before service start.', { missingFiles });

  const result = await (options.refreshNow ?? createStartupRefreshRunner(options))();
  if (result.status === 'failed') {
    throw new Error(`Startup data update failed: ${result.error ?? result.message}`);
  }
  if (result.status === 'in_progress') {
    throw new Error(`Startup data update did not run: ${result.message}`);
  }

  const stillMissingFiles = await missingLocalFiles(requiredFiles);
  if (stillMissingFiles.length > 0) {
    throw new Error(`Startup data update completed but required data files are still missing: ${stillMissingFiles.join(', ')}`);
  }

  logger.info('Startup data update completed before service start.', { status: result.status, version: result.version });
  return result;
}

function createStartupRefreshRunner(options: StartupDataFilesOptions): () => Promise<RefreshResult> {
  const activeRepositories = new ActiveDebarmentRepositories(
    SenzingMemoryRepository.fromRecords([]),
    TargetsNestedMemoryRepository.fromRecords([]),
  );
  const refreshService = new DataRefreshService({
    senzingPath: options.senzingPath,
    targetsNestedPath: options.targetsNestedPath,
    securitiesPath: options.securitiesPath,
    refreshMetadataPath: options.refreshMetadataPath,
    activeRepositories,
    logger: options.logger ? { ...console, ...options.logger } : console,
  });
  return () => refreshService.refreshNow();
}

async function missingLocalFiles(filePaths: string[]): Promise<string[]> {
  const missingFiles: string[] = [];
  for (const filePath of filePaths) {
    try {
      await fs.access(filePath);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        missingFiles.push(filePath);
        continue;
      }
      throw error;
    }
  }
  return missingFiles;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
