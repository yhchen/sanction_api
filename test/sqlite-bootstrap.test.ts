import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { bootstrapSqliteRepositories } from '../src/data/sqliteBootstrap.js';

const senzingFixture = path.join(process.cwd(), 'test/fixtures/senzing.fixture.jsonl');
const targetsNestedFixture = path.join(process.cwd(), 'test/fixtures/targets.nested.fixture.jsonl');

interface BootstrapPaths {
  senzingPath: string;
  targetsNestedPath: string;
  sqlitePath: string;
}

async function tempBootstrapPaths(): Promise<BootstrapPaths> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-bootstrap-'));
  return {
    senzingPath: path.join(dir, 'nested', 'senzing.json'),
    targetsNestedPath: path.join(dir, 'nested', 'targets.nested.json'),
    sqlitePath: path.join(dir, 'nested', 'sanction.sqlite'),
  };
}

describe('SQLite bootstrap', () => {
  test('creates empty JSONL and SQLite files when no startup data exists', async () => {
    const paths = await tempBootstrapPaths();

    const result = await bootstrapSqliteRepositories(paths);
    try {
      expect(result.shouldAutoRefresh).toBe(true);
      expect(result.senzingRepository.stats()).toEqual({ records: 0, indexedNames: 0 });
      expect(await fs.readFile(paths.senzingPath, 'utf8')).toBe('');
      expect(await fs.readFile(paths.targetsNestedPath, 'utf8')).toBe('');
    } finally {
      result.close();
    }
  });

  test('builds SQLite from existing JSONL startup data', async () => {
    const paths = await tempBootstrapPaths();
    await fs.mkdir(path.dirname(paths.senzingPath), { recursive: true });
    await fs.copyFile(senzingFixture, paths.senzingPath);
    await fs.copyFile(targetsNestedFixture, paths.targetsNestedPath);

    const result = await bootstrapSqliteRepositories(paths);
    try {
      expect(result.shouldAutoRefresh).toBe(false);
      expect(result.senzingRepository.stats().records).toBe(5);
    } finally {
      result.close();
    }
  });

  test('rebuilds an existing empty SQLite database after JSONL startup data is populated', async () => {
    const paths = await tempBootstrapPaths();

    const emptyResult = await bootstrapSqliteRepositories(paths);
    try {
      expect(emptyResult.shouldAutoRefresh).toBe(true);
      expect(emptyResult.senzingRepository.stats()).toEqual({ records: 0, indexedNames: 0 });
    } finally {
      emptyResult.close();
    }

    await fs.copyFile(senzingFixture, paths.senzingPath);
    await fs.copyFile(targetsNestedFixture, paths.targetsNestedPath);

    const populatedResult = await bootstrapSqliteRepositories(paths);
    try {
      expect(populatedResult.shouldAutoRefresh).toBe(false);
      expect(populatedResult.senzingRepository.stats().records).toBe(5);
    } finally {
      populatedResult.close();
    }
  });

  test('throws when senzing JSONL exists but targets.nested JSONL is missing', async () => {
    const paths = await tempBootstrapPaths();
    await fs.mkdir(path.dirname(paths.senzingPath), { recursive: true });
    await fs.copyFile(senzingFixture, paths.senzingPath);

    await expect(bootstrapSqliteRepositories(paths)).rejects.toThrow(`Missing startup data file: ${paths.targetsNestedPath}`);
  });

  test('throws when targets.nested JSONL exists but senzing JSONL is missing with an empty SQLite database', async () => {
    const paths = await tempBootstrapPaths();
    const emptyResult = await bootstrapSqliteRepositories(paths);
    emptyResult.close();
    await fs.rm(paths.senzingPath);
    await fs.copyFile(targetsNestedFixture, paths.targetsNestedPath);

    await expect(bootstrapSqliteRepositories(paths)).rejects.toThrow(`Missing startup data file: ${paths.senzingPath}`);
  });
});
