import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { buildSqliteDatabase, createEmptySqliteDatabase } from './sqliteBuilder.js';
import { SqliteSenzingRepository, SqliteTargetDetailsRepository } from './sqliteRepositories.js';
import { validateSqliteSchema } from './sqliteSchema.js';

export interface BootstrapSqliteOptions {
  senzingPath: string;
  targetsNestedPath: string;
  sqlitePath: string;
}

export interface BootstrapSqliteResult {
  senzingRepository: SqliteSenzingRepository;
  targetDetailsRepository: SqliteTargetDetailsRepository;
  shouldAutoRefresh: boolean;
  close(): void;
}

interface FileState {
  exists: boolean;
  populated: boolean;
}

export async function bootstrapSqliteRepositories(options: BootstrapSqliteOptions): Promise<BootstrapSqliteResult> {
  return bootstrapSqliteRepositoriesAttempt(options, 0);
}

async function bootstrapSqliteRepositoriesAttempt(options: BootstrapSqliteOptions, createRaceRetries: number): Promise<BootstrapSqliteResult> {
  const sqliteExists = await exists(options.sqlitePath);
  const senzingState = await fileState(options.senzingPath);
  const targetsNestedState = await fileState(options.targetsNestedPath);
  const sqliteStats = sqliteExists ? readCompatibleSqliteSenzingStats(options.sqlitePath) : undefined;
  const sqliteIsEmpty = sqliteStats === undefined || sqliteStats.records === 0;

  if (!sqliteIsEmpty) return openBootstrapResult(options.sqlitePath, false);

  assertCompleteStartupData(options, senzingState, targetsNestedState);

  if (senzingState.populated && targetsNestedState.populated) {
    await buildSqliteDatabase(options);
    return openBootstrapResult(options.sqlitePath, false);
  }

  if (sqliteExists && sqliteStats) {
    return openBootstrapResult(options.sqlitePath, true);
  }

  const createdSenzing = await createEmptyJsonl(options.senzingPath);
  const createdTargetsNested = await createEmptyJsonl(options.targetsNestedPath);
  if (!createdSenzing || !createdTargetsNested) {
    if (createRaceRetries >= 1) throw new Error('Startup data files changed during bootstrap.');
    return bootstrapSqliteRepositoriesAttempt(options, createRaceRetries + 1);
  }
  await createEmptySqliteDatabase(options.sqlitePath);
  return openBootstrapResult(options.sqlitePath, true);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function fileState(filePath: string): Promise<FileState> {
  try {
    const stats = await fs.stat(filePath);
    return { exists: true, populated: stats.size > 0 };
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return { exists: false, populated: false };
    throw error;
  }
}

async function createEmptyJsonl(filePath: string): Promise<boolean> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(filePath, '', { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'EEXIST') return false;
    throw error;
  }
}

function assertCompleteStartupData(options: BootstrapSqliteOptions, senzingState: FileState, targetsNestedState: FileState): void {
  if (!senzingState.exists && targetsNestedState.exists) throw new Error(`Missing startup data file: ${options.senzingPath}`);
  if (senzingState.exists && !targetsNestedState.exists) throw new Error(`Missing startup data file: ${options.targetsNestedPath}`);
  if (senzingState.populated && !targetsNestedState.populated) throw new Error(`Missing startup data file: ${options.targetsNestedPath}`);
  if (!senzingState.populated && targetsNestedState.populated) throw new Error(`Missing startup data file: ${options.senzingPath}`);
}

function openBootstrapResult(sqlitePath: string, shouldAutoRefresh: boolean): BootstrapSqliteResult {
  const senzingRepository = SqliteSenzingRepository.open(sqlitePath);
  try {
    const targetDetailsRepository = SqliteTargetDetailsRepository.open(sqlitePath);
    return {
      senzingRepository,
      targetDetailsRepository,
      shouldAutoRefresh,
      close() {
        targetDetailsRepository.close();
        senzingRepository.close();
      },
    };
  } catch (error) {
    senzingRepository.close();
    throw error;
  }
}

function readCompatibleSqliteSenzingStats(sqlitePath: string): { records: number; indexedNames: number } | undefined {
  const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    if (!validateSqliteSchema(db)) return undefined;
    return {
      records: count(db, 'SELECT COUNT(*) AS count FROM records'),
      indexedNames: count(db, 'SELECT COUNT(*) AS count FROM names'),
    };
  } finally {
    db.close();
  }
}

function count(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { count: number } | undefined)?.count ?? 0;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
