import type Database from 'better-sqlite3';

export const SQLITE_SCHEMA_VERSION = '2';

export function initializeSqliteSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS records (
      record_id TEXT PRIMARY KEY,
      record_json TEXT NOT NULL,
      is_debarment INTEGER NOT NULL,
      is_sanctioned_securities INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS names (
      id INTEGER PRIMARY KEY,
      record_id TEXT NOT NULL,
      name_full TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      name_type TEXT,
      normalized_tokens_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS target_sanctions (
      record_id TEXT PRIMARY KEY,
      sanctions_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS securities_details (
      record_id TEXT PRIMARY KEY,
      securities_json TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS name_fts USING fts5(
      normalized_name,
      name_full,
      record_id UNINDEXED,
      name_id UNINDEXED
    );

    CREATE INDEX IF NOT EXISTS idx_names_normalized_name ON names(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_names_record_id ON names(record_id);
    CREATE INDEX IF NOT EXISTS idx_records_debarment ON records(is_debarment);
    CREATE INDEX IF NOT EXISTS idx_records_sanctioned_securities ON records(is_sanctioned_securities);
  `);

  db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', SQLITE_SCHEMA_VERSION);
}

export function validateSqliteSchema(db: Database.Database): boolean {
  try {
    const version = db.prepare('SELECT value FROM schema_metadata WHERE key = ?').pluck().get('schema_version');
    if (version !== SQLITE_SCHEMA_VERSION) return false;

    const requiredTables = ['schema_metadata', 'records', 'names', 'target_sanctions', 'securities_details', 'name_fts'];
    for (const table of requiredTables) {
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
        .pluck()
        .get(table);
      if (exists !== 1) return false;
    }

    const requiredIndexes = ['idx_names_normalized_name', 'idx_names_record_id', 'idx_records_debarment', 'idx_records_sanctioned_securities'];
    for (const index of requiredIndexes) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").pluck().get(index);
      if (exists !== 1) return false;
    }

    db.prepare("SELECT record_id, name_id FROM name_fts WHERE name_fts MATCH 'schema' LIMIT 1").all();
    return true;
  } catch {
    return false;
  }
}
