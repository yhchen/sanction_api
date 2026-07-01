import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { RepositoryStats } from '../domain/types.js';
import { buildSqliteDatabase, createEmptySqliteDatabase } from './sqliteBuilder.js';
import { SqliteSenzingRepository, SqliteTargetDetailsRepository } from './sqliteRepositories.js';

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

export async function bootstrapSqliteRepositories(options: BootstrapSqliteOptions): Promise<BootstrapSqliteResult> {
  if (await exists(options.sqlitePath)) {
    return openBootstrapResult(options.sqlitePath, false);
  }

  if (await exists(options.senzingPath) && await exists(options.targetsNestedPath)) {
    await buildSqliteDatabase(options);
    return openBootstrapResult(options.sqlitePath, false);
  }

  await createEmptyJsonl(options.senzingPath);
  await createEmptyJsonl(options.targetsNestedPath);
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

async function createEmptyJsonl(filePath: string): Promise<void> {
  if (await exists(filePath)) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, '', 'utf8');
}

function openBootstrapResult(sqlitePath: string, shouldAutoRefresh: boolean): BootstrapSqliteResult {
  const senzingRepository = SqliteSenzingRepository.open(sqlitePath);
  try {
    const senzingStats = readSqliteSenzingStats(sqlitePath);
    senzingRepository.stats = () => senzingStats;
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

function readSqliteSenzingStats(sqlitePath: string): RepositoryStats {
  const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
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
