import { loadConfig } from '../config.js';
import { buildSqliteDatabase } from '../data/sqliteBuilder.js';

const config = loadConfig(process.env, { requireToken: false });

await buildSqliteDatabase({
  senzingPath: config.senzingPath,
  targetsNestedPath: config.targetsNestedPath,
  securitiesPath: config.securitiesPath,
  sqlitePath: config.sqlitePath,
});

console.log(`SQLite database built at ${config.sqlitePath}.`);
