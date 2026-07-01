import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { normalizedTokens } from '../domain/nameScoring.js';
import { normalizeName } from '../domain/normalize.js';
import type { SanctionDetail, SenzingRecord, TargetNestedRecord, TargetNestedSanction } from '../domain/types.js';
import { readJsonlFile } from './jsonl.js';
import { initializeSqliteSchema, validateSqliteSchema } from './sqliteSchema.js';

export interface BuildSqliteDatabaseOptions {
  senzingPath: string;
  targetsNestedPath: string;
  sqlitePath: string;
}

interface InsertNameResult {
  lastInsertRowid: number | bigint;
}

export async function createEmptySqliteDatabase(sqlitePath: string): Promise<void> {
  await prepareSqlitePath(sqlitePath);
  const db = new Database(sqlitePath);
  try {
    initializeSqliteSchema(db);
    if (!validateSqliteSchema(db)) throw new Error('SQLite schema validation failed.');
  } finally {
    db.close();
  }
}

export async function buildSqliteDatabase(options: BuildSqliteDatabaseOptions): Promise<void> {
  const tempSqlitePath = tempPathFor(options.sqlitePath);
  await fs.mkdir(path.dirname(options.sqlitePath), { recursive: true });
  await fs.rm(tempSqlitePath, { force: true });

  const db = new Database(tempSqlitePath);
  try {
    initializeSqliteSchema(db);
    await runBuildTransaction(db, options);

    if (!validateSqliteSchema(db)) throw new Error('SQLite schema validation failed.');
  } finally {
    db.close();
  }

  try {
    await publishSqliteFile(tempSqlitePath, options.sqlitePath);
  } finally {
    await fs.rm(tempSqlitePath, { force: true });
  }
}

async function prepareSqlitePath(sqlitePath: string): Promise<void> {
  await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
  await fs.rm(sqlitePath, { force: true });
}

function tempPathFor(sqlitePath: string): string {
  return `${sqlitePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
}

async function runBuildTransaction(db: Database.Database, options: BuildSqliteDatabaseOptions): Promise<void> {
  db.exec('BEGIN IMMEDIATE;');
  try {
    await insertSenzingRecords(db, options.senzingPath);
    await insertTargetSanctions(db, options.targetsNestedPath);
    db.exec('ANALYZE;');
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

async function publishSqliteFile(tempSqlitePath: string, sqlitePath: string): Promise<void> {
  await fs.rename(tempSqlitePath, sqlitePath);
}

async function insertSenzingRecords(db: Database.Database, senzingPath: string): Promise<void> {
  const insertRecord = db.prepare('INSERT INTO records (record_id, record_json, is_debarment) VALUES (?, ?, ?)');
  const insertName = db.prepare(
    'INSERT INTO names (record_id, name_full, normalized_name, name_type, normalized_tokens_json) VALUES (?, ?, ?, ?, ?)',
  );
  const insertNameFts = db.prepare('INSERT INTO name_fts (normalized_name, name_full, record_id, name_id) VALUES (?, ?, ?, ?)');

  await readJsonlFile<SenzingRecord>(senzingPath, (record, lineNumber) => {
    if (!record.RECORD_ID) throw new Error(`Senzing record missing RECORD_ID at line ${lineNumber}`);

    insertRecord.run(record.RECORD_ID, JSON.stringify(record), isDebarment(record) ? 1 : 0);
    const seenNormalizedNamesForRecord = new Set<string>();

    for (const name of record.NAMES ?? []) {
      const fullName = name.NAME_FULL?.trim();
      if (!fullName) continue;

      const normalized = normalizeName(fullName);
      if (!normalized || seenNormalizedNamesForRecord.has(normalized)) continue;
      seenNormalizedNamesForRecord.add(normalized);

      const tokensJson = JSON.stringify(normalizedTokens(normalized));
      const result = insertName.run(record.RECORD_ID, fullName, normalized, name.NAME_TYPE ?? null, tokensJson) as InsertNameResult;
      insertNameFts.run(normalized, fullName, record.RECORD_ID, Number(result.lastInsertRowid));
    }
  });
}

function isDebarment(record: SenzingRecord): boolean {
  return (record.RISKS ?? []).some((risk) => risk.TOPIC?.trim().toLocaleLowerCase('en-US') === 'debarment');
}

async function insertTargetSanctions(db: Database.Database, targetsNestedPath: string): Promise<void> {
  const insertTarget = db.prepare('INSERT INTO target_sanctions (record_id, sanctions_json) VALUES (?, ?)');

  await readJsonlFile<TargetNestedRecord>(targetsNestedPath, (record, lineNumber) => {
    if (!record.id) throw new Error(`targets.nested record missing id at line ${lineNumber}`);
    insertTarget.run(record.id, JSON.stringify((record.properties?.sanctions ?? []).map(toSanctionDetail)));
  });
}

function toSanctionDetail(sanction: TargetNestedSanction): SanctionDetail {
  const properties = sanction.properties ?? {};
  return {
    id: sanction.id,
    caption: sanction.caption,
    authority: cleanValues(properties.authority),
    status: cleanValues(properties.status),
    listingDate: cleanValues(properties.listingDate),
    startDate: cleanValues(properties.startDate),
    program: cleanValues(properties.program),
    provisions: cleanValues(properties.provisions),
    sourceUrl: cleanValues(properties.sourceUrl),
    summary: cleanValues(properties.summary),
  };
}

function cleanValues(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}
