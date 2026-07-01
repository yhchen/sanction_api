import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { normalizedTokens } from '../domain/nameScoring.js';
import { normalizeName } from '../domain/normalize.js';
import type { SanctionDetail, SecuritiesDetail, SenzingIdentifier, SenzingName, SenzingRecord, TargetNestedRecord, TargetNestedSanction } from '../domain/types.js';
import { readJsonlFile } from './jsonl.js';
import { readSecuritiesCsvFile, type SecuritiesCsvRecord } from './securitiesCsv.js';
import { initializeSqliteSchema, validateSqliteSchema } from './sqliteSchema.js';

export interface BuildSqliteDatabaseOptions {
  senzingPath: string;
  targetsNestedPath: string;
  securitiesPath: string;
  sqlitePath: string;
}

interface InsertNameResult {
  lastInsertRowid: number | bigint;
}

interface ExistingRecordRow {
  record_json: string;
  is_debarment: number;
}

interface NameStatements {
  insertName: Database.Statement;
  insertNameFts: Database.Statement;
  selectExistingNames: Database.Statement;
}

interface MergeIndex {
  lei: Map<string, string | undefined>;
  permId: Map<string, string | undefined>;
  nameCountry: Map<string, string | undefined>;
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

  try {
    const db = new Database(tempSqlitePath);
    try {
      initializeSqliteSchema(db);
      await runBuildTransaction(db, options);

      if (!validateSqliteSchema(db)) throw new Error('SQLite schema validation failed.');
    } finally {
      db.close();
    }

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
    const mergeIndex = await insertSenzingRecords(db, options.senzingPath);
    await insertSecuritiesRecords(db, options.securitiesPath, mergeIndex);
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

async function insertSenzingRecords(db: Database.Database, senzingPath: string): Promise<MergeIndex> {
  const mergeIndex = emptyMergeIndex();
  const insertRecord = db.prepare('INSERT INTO records (record_id, record_json, is_debarment, is_sanctioned_securities) VALUES (?, ?, ?, ?)');
  const nameStatements = nameStatementsFor(db);

  await readJsonlFile<SenzingRecord>(senzingPath, (record, lineNumber) => {
    if (!record.RECORD_ID) throw new Error(`Senzing record missing RECORD_ID at line ${lineNumber}`);

    insertRecord.run(record.RECORD_ID, JSON.stringify(record), isDebarment(record) ? 1 : 0, isSanctionedSecurities(record) ? 1 : 0);
    insertNamesForRecord(record, nameStatements);
    addRecordToMergeIndex(mergeIndex, record);
  });

  return mergeIndex;
}

function isDebarment(record: SenzingRecord): boolean {
  return (record.RISKS ?? []).some((risk) => risk.TOPIC?.trim().toLocaleLowerCase('en-US') === 'debarment');
}

function isSanctionedSecurities(record: SenzingRecord): boolean {
  return (record.RISKS ?? []).some((risk) => risk.TOPIC?.trim().toLocaleLowerCase('en-US') === 'sanctioned_securities');
}

async function insertSecuritiesRecords(db: Database.Database, securitiesPath: string, mergeIndex: MergeIndex): Promise<void> {
  const selectExistingRecord = db.prepare('SELECT record_json, is_debarment FROM records WHERE record_id = ?');
  const insertRecord = db.prepare('INSERT INTO records (record_id, record_json, is_debarment, is_sanctioned_securities) VALUES (?, ?, ?, ?)');
  const updateRecord = db.prepare('UPDATE records SET record_json = ?, is_debarment = ?, is_sanctioned_securities = ? WHERE record_id = ?');
  const insertSecurities = db.prepare('INSERT OR REPLACE INTO securities_details (record_id, securities_json) VALUES (?, ?)');
  const nameStatements = nameStatementsFor(db);

  await readSecuritiesCsvFile(securitiesPath, (security) => {
    const recordId = findSecuritiesMergeRecordId(security, mergeIndex) ?? security.id;
    const existingRow = selectExistingRecord.get(recordId) as ExistingRecordRow | undefined;
    const existingRecord = existingRow ? JSON.parse(existingRow.record_json) as SenzingRecord : undefined;
    const mergedRecord = mergeSecuritiesRecord(existingRecord, security, recordId);
    const debarred = isDebarment(mergedRecord) ? 1 : 0;

    if (existingRow) {
      updateRecord.run(JSON.stringify(mergedRecord), debarred, 1, recordId);
    } else {
      insertRecord.run(recordId, JSON.stringify(mergedRecord), debarred, 1);
    }

    insertNamesForRecord(mergedRecord, nameStatements);
    insertSecurities.run(recordId, JSON.stringify(toSecuritiesDetail(security)));
    addRecordToMergeIndex(mergeIndex, mergedRecord);
  });
}

function nameStatementsFor(db: Database.Database): NameStatements {
  return {
    insertName: db.prepare('INSERT INTO names (record_id, name_full, normalized_name, name_type, normalized_tokens_json) VALUES (?, ?, ?, ?, ?)'),
    insertNameFts: db.prepare('INSERT INTO name_fts (normalized_name, name_full, record_id, name_id) VALUES (?, ?, ?, ?)'),
    selectExistingNames: db.prepare('SELECT normalized_name FROM names WHERE record_id = ?'),
  };
}

function insertNamesForRecord(record: SenzingRecord, statements: NameStatements): void {
  const seenNormalizedNamesForRecord = new Set(
    (statements.selectExistingNames.all(record.RECORD_ID) as Array<{ normalized_name: string }>).map((row) => row.normalized_name),
  );

  for (const name of record.NAMES ?? []) {
    const fullName = name.NAME_FULL?.trim();
    if (!fullName) continue;

    const normalized = normalizeName(fullName);
    if (!normalized || seenNormalizedNamesForRecord.has(normalized)) continue;
    seenNormalizedNamesForRecord.add(normalized);

    const tokensJson = JSON.stringify(normalizedTokens(normalized));
    const result = statements.insertName.run(record.RECORD_ID, fullName, normalized, name.NAME_TYPE ?? null, tokensJson) as InsertNameResult;
    statements.insertNameFts.run(normalized, fullName, record.RECORD_ID, Number(result.lastInsertRowid));
  }
}

function emptyMergeIndex(): MergeIndex {
  return {
    lei: new Map(),
    permId: new Map(),
    nameCountry: new Map(),
  };
}

function addRecordToMergeIndex(index: MergeIndex, record: SenzingRecord): void {
  const recordId = record.RECORD_ID;
  for (const identifier of record.IDENTIFIERS ?? []) {
    const type = identifier.OTHER_ID_TYPE?.trim().toLocaleLowerCase('en-US');
    const value = identifier.OTHER_ID_NUMBER?.trim();
    if (!type || !value) continue;
    if (type === 'lei') addUniqueIndexValue(index.lei, value.toLocaleUpperCase('en-US'), recordId);
    if (type === 'permid' || type === 'perm_id' || type === 'perm id') addUniqueIndexValue(index.permId, value, recordId);
  }

  const countries = countriesForRecord(record);
  for (const name of record.NAMES ?? []) {
    const normalized = normalizeName(name.NAME_FULL ?? '');
    if (!normalized) continue;
    for (const country of countries) addUniqueIndexValue(index.nameCountry, nameCountryKey(normalized, country), recordId);
  }
}

function addUniqueIndexValue(index: Map<string, string | undefined>, key: string, recordId: string): void {
  if (!index.has(key)) {
    index.set(key, recordId);
    return;
  }
  if (index.get(key) !== recordId) index.set(key, undefined);
}

function findSecuritiesMergeRecordId(security: SecuritiesCsvRecord, index: MergeIndex): string | undefined {
  if (uniqueIndexedRecord(index.lei, security.lei.map((lei) => lei.toLocaleUpperCase('en-US')))) {
    return uniqueIndexedRecord(index.lei, security.lei.map((lei) => lei.toLocaleUpperCase('en-US')));
  }
  if (uniqueIndexedRecord(index.permId, security.permId)) return uniqueIndexedRecord(index.permId, security.permId);

  const names = [security.caption, ...security.aliases].map(normalizeName).filter(Boolean);
  const nameCountryMatches = uniqueIndexedRecord(
    index.nameCountry,
    names.flatMap((name) => security.countries.map((country) => nameCountryKey(name, country))),
  );
  return nameCountryMatches;
}

function uniqueIndexedRecord(index: Map<string, string | undefined>, keys: string[]): string | undefined {
  const matches = new Set<string>();
  for (const key of keys) {
    const recordId = index.get(key);
    if (recordId) matches.add(recordId);
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

function nameCountryKey(normalizedName: string, country: string): string {
  return `${normalizedName}\0${country.toLocaleLowerCase('en-US')}`;
}

function countriesForRecord(record: SenzingRecord): string[] {
  return cleanValues(
    (record.COUNTRIES ?? []).flatMap((country) => [country.NATIONALITY, country.COUNTRY, country.CITIZENSHIP]),
  ).map((country) => country.toLocaleLowerCase('en-US'));
}

function mergeSecuritiesRecord(existingRecord: SenzingRecord | undefined, security: SecuritiesCsvRecord, recordId: string): SenzingRecord {
  const record = existingRecord ?? securitiesOnlyRecord(security, recordId);
  record.RISKS = appendRisk(record.RISKS, 'sanctioned_securities');
  record.NAMES = appendNames(record.NAMES, [
    { NAME_TYPE: existingRecord ? 'ALIAS' : 'PRIMARY', NAME_FULL: security.caption },
    ...security.aliases.map((alias): SenzingName => ({ NAME_TYPE: 'ALIAS', NAME_FULL: alias })),
  ]);
  record.COUNTRIES = appendCountries(record, security.countries);
  record.IDENTIFIERS = appendIdentifiers(record.IDENTIFIERS, securityIdentifiers(security));
  record.URL = record.URL?.trim() || security.url || undefined;
  return record;
}

function securitiesOnlyRecord(security: SecuritiesCsvRecord, recordId: string): SenzingRecord {
  return {
    DATA_SOURCE: 'OPEN_SANCTIONS_SECURITIES',
    RECORD_ID: recordId,
    RECORD_TYPE: 'LegalEntity',
    NAMES: [],
    RISKS: [],
    COUNTRIES: [],
    IDENTIFIERS: [],
    URL: security.url,
  };
}

function appendRisk(risks: SenzingRecord['RISKS'], topic: string): SenzingRecord['RISKS'] {
  const existing = risks ?? [];
  if (existing.some((risk) => risk.TOPIC?.trim().toLocaleLowerCase('en-US') === topic)) return existing;
  return [...existing, { TOPIC: topic }];
}

function appendNames(existingNames: SenzingName[] | undefined, newNames: SenzingName[]): SenzingName[] {
  const names = [...(existingNames ?? [])];
  const seen = new Set(names.map((name) => normalizeName(name.NAME_FULL ?? '')).filter(Boolean));
  for (const name of newNames) {
    const normalized = normalizeName(name.NAME_FULL ?? '');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    names.push(name);
  }
  return names;
}

function appendCountries(record: SenzingRecord, countries: string[]): SenzingRecord['COUNTRIES'] {
  const merged = [...(record.COUNTRIES ?? [])];
  const seen = new Set(countriesForRecord(record));
  for (const country of countries) {
    const normalized = country.trim().toLocaleLowerCase('en-US');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push({ COUNTRY: country.trim() });
  }
  return merged;
}

function appendIdentifiers(existingIdentifiers: SenzingIdentifier[] | undefined, newIdentifiers: SenzingIdentifier[]): SenzingIdentifier[] {
  const identifiers = [...(existingIdentifiers ?? [])];
  const seen = new Set(identifiers.map((identifier) => identifierKey(identifier)));
  for (const identifier of newIdentifiers) {
    const key = identifierKey(identifier);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    identifiers.push(identifier);
  }
  return identifiers;
}

function identifierKey(identifier: SenzingIdentifier): string {
  const type = identifier.OTHER_ID_TYPE?.trim();
  const value = identifier.OTHER_ID_NUMBER?.trim();
  return type && value ? `${type.toLocaleLowerCase('en-US')}\0${value}` : '';
}

function securityIdentifiers(security: SecuritiesCsvRecord): SenzingIdentifier[] {
  return [
    ...security.lei.map((value) => ({ OTHER_ID_TYPE: 'LEI', OTHER_ID_NUMBER: value })),
    ...security.permId.map((value) => ({ OTHER_ID_TYPE: 'PermID', OTHER_ID_NUMBER: value })),
    ...security.isins.map((value) => ({ OTHER_ID_TYPE: 'ISIN', OTHER_ID_NUMBER: value })),
    ...security.ric.map((value) => ({ OTHER_ID_TYPE: 'RIC', OTHER_ID_NUMBER: value })),
    { OTHER_ID_TYPE: 'OPEN_SANCTIONS', OTHER_ID_NUMBER: security.id },
  ];
}

function toSecuritiesDetail(security: SecuritiesCsvRecord): SecuritiesDetail {
  return {
    caption: security.caption,
    lei: security.lei,
    permId: security.permId,
    isins: security.isins,
    ric: security.ric,
    countries: security.countries,
    sanctioned: security.sanctioned,
    eo14071: security.eo14071,
    public: security.public,
    datasets: security.datasets,
    riskDatasets: security.riskDatasets,
    referents: security.referents,
    url: security.url || undefined,
  };
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

function cleanValues(values: Array<string | null | undefined> | undefined): string[] {
  return (values ?? []).map((value) => value?.trim() ?? '').filter(Boolean);
}
