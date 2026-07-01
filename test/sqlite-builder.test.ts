import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { SQLITE_SCHEMA_VERSION, validateSqliteSchema } from '../src/data/sqliteSchema.js';
import { buildSqliteDatabase, createEmptySqliteDatabase } from '../src/data/sqliteBuilder.js';

const senzingFixture = path.join(process.cwd(), 'test/fixtures/senzing.fixture.jsonl');
const targetsNestedFixture = path.join(process.cwd(), 'test/fixtures/targets.nested.fixture.jsonl');

interface CountRow {
  count: number;
}

interface MetadataRow {
  value: string;
}

interface NameRow {
  record_id: string;
  name_full: string;
  normalized_name: string;
}

async function tempSqlitePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-builder-'));
  return path.join(dir, 'nested', 'sanction.sqlite');
}

async function builderTempFiles(sqlitePath: string): Promise<string[]> {
  const directory = path.dirname(sqlitePath);
  const basename = path.basename(sqlitePath);
  const entries = await fs.readdir(directory);
  return entries.filter((entry) => entry.startsWith(`${basename}.tmp-`) || entry.startsWith(`${basename}.backup.tmp-`));
}

function scalarCount(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as CountRow | undefined)?.count ?? 0;
}

describe('SQLite builder', () => {
  test('builds a searchable SQLite database from JSONL fixtures', async () => {
    const sqlitePath = await tempSqlitePath();
    await createEmptySqliteDatabase(sqlitePath);

    await buildSqliteDatabase({
      senzingPath: senzingFixture,
      targetsNestedPath: targetsNestedFixture,
      sqlitePath,
    });

    const db = new Database(sqlitePath, { readonly: true });
    try {
      expect(validateSqliteSchema(db)).toBe(true);
      expect(db.prepare('SELECT value FROM schema_metadata WHERE key = ?').get('schema_version') as MetadataRow).toEqual({
        value: SQLITE_SCHEMA_VERSION,
      });
      expect(scalarCount(db, 'SELECT COUNT(*) AS count FROM records')).toBe(5);
      expect(scalarCount(db, 'SELECT COUNT(*) AS count FROM names')).toBe(8);
      expect(scalarCount(db, 'SELECT COUNT(*) AS count FROM target_sanctions')).toBe(3);
      expect(
        db.prepare('SELECT record_id, name_full, normalized_name FROM names WHERE normalized_name = ?').get('yatai new city') as NameRow | undefined,
      ).toMatchObject({
        record_id: 'NK-223CQDBzp8MRkdJMDiqXn3',
        name_full: 'YATAI NEW CITY',
        normalized_name: 'yatai new city',
      });
      expect(scalarCount(db, "SELECT COUNT(*) AS count FROM name_fts WHERE name_fts MATCH 'yatai'")).toBe(3);
    } finally {
      db.close();
    }
  });

  test('creates an empty SQLite database with a valid schema', async () => {
    const sqlitePath = await tempSqlitePath();

    await createEmptySqliteDatabase(sqlitePath);

    const db = new Database(sqlitePath, { readonly: true });
    try {
      expect(validateSqliteSchema(db)).toBe(true);
      expect(scalarCount(db, 'SELECT COUNT(*) AS count FROM records')).toBe(0);
    } finally {
      db.close();
    }
  });

  test('leaves the existing SQLite database unchanged when rebuild input is invalid', async () => {
    const sqlitePath = await tempSqlitePath();
    const badSenzingPath = path.join(path.dirname(sqlitePath), 'bad-senzing.jsonl');
    await buildSqliteDatabase({
      senzingPath: senzingFixture,
      targetsNestedPath: targetsNestedFixture,
      sqlitePath,
    });
    await fs.writeFile(badSenzingPath, '{"NAMES":[{"NAME_FULL":"BROKEN"}]}\n', 'utf8');

    await expect(buildSqliteDatabase({
      senzingPath: badSenzingPath,
      targetsNestedPath: targetsNestedFixture,
      sqlitePath,
    })).rejects.toThrow('Senzing record missing RECORD_ID at line 1');

    const db = new Database(sqlitePath, { readonly: true });
    try {
      expect(validateSqliteSchema(db)).toBe(true);
      expect(scalarCount(db, 'SELECT COUNT(*) AS count FROM records')).toBe(5);
      expect(scalarCount(db, 'SELECT COUNT(*) AS count FROM names')).toBe(8);
    } finally {
      db.close();
    }
  });

  test('leaves the existing SQLite database unchanged when publish cannot replace an open destination', async () => {
    const sqlitePath = await tempSqlitePath();
    await buildSqliteDatabase({
      senzingPath: senzingFixture,
      targetsNestedPath: targetsNestedFixture,
      sqlitePath,
    });

    const openDb = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    try {
      await expect(buildSqliteDatabase({
        senzingPath: senzingFixture,
        targetsNestedPath: targetsNestedFixture,
        sqlitePath,
      })).rejects.toThrow();

      expect(validateSqliteSchema(openDb)).toBe(true);
      expect(scalarCount(openDb, 'SELECT COUNT(*) AS count FROM records')).toBe(5);
    } finally {
      openDb.close();
    }

    expect(await builderTempFiles(sqlitePath)).toEqual([]);
  });
});
