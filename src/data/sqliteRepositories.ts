import Database from 'better-sqlite3';
import { normalizedTokens, scoreSearchableName } from '../domain/nameScoring.js';
import { normalizeName } from '../domain/normalize.js';
import type {
  RepositoryStats,
  SanctionDetail,
  SenzingLookupRepository,
  SenzingNameCandidate,
  SenzingNameMatch,
  SenzingRecord,
  TargetDetailsRepository,
} from '../domain/types.js';
import { validateSqliteSchema } from './sqliteSchema.js';

interface RecordRow {
  record_id: string;
  record_json: string;
}

interface NameMatchRow extends RecordRow {
  name_full: string;
  name_type: string | null;
  normalized_name: string;
  normalized_tokens_json: string;
}

interface SanctionsRow {
  sanctions_json: string;
}

interface CountRow {
  count: number;
}

interface SearchableNameMatch extends SenzingNameMatch {
  normalizedName: string;
  normalizedTokens: string[];
}

export class SqliteSenzingRepository implements SenzingLookupRepository {
  private constructor(private readonly db: Database.Database) {}

  static open(sqlitePath: string): SqliteSenzingRepository {
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    if (!validateSqliteSchema(db)) {
      db.close();
      throw new Error('SQLite schema is incompatible.');
    }
    return new SqliteSenzingRepository(db);
  }

  findByName(name: string): SenzingNameMatch[] {
    const normalized = normalizeName(name);
    if (!normalized) return [];

    const rows = this.db.prepare(`
      SELECT
        r.record_id,
        r.record_json,
        n.name_full,
        n.name_type,
        n.normalized_name,
        n.normalized_tokens_json
      FROM names n
      INNER JOIN records r ON r.record_id = n.record_id
      WHERE r.is_debarment = 1
        AND n.normalized_name = ?
      ORDER BY r.record_id, n.name_full
    `).all(normalized) as NameMatchRow[];

    const bestByRecordId = new Map<string, SenzingNameMatch>();
    for (const row of rows) {
      if (bestByRecordId.has(row.record_id)) continue;
      bestByRecordId.set(row.record_id, toNameMatch(row));
    }
    return [...bestByRecordId.values()];
  }

  findCandidateNames(name: string): SenzingNameCandidate[] {
    const normalizedQuery = normalizeName(name);
    if (!normalizedQuery) return [];

    const queryTokens = normalizedTokens(normalizedQuery);
    const ftsQuery = buildSafePrefixFtsQuery(queryTokens);
    if (!ftsQuery) return [];

    const rows = this.db.prepare(`
      SELECT
        r.record_id,
        r.record_json,
        n.name_full,
        n.name_type,
        n.normalized_name,
        n.normalized_tokens_json
      FROM name_fts f
      INNER JOIN names n ON n.id = f.name_id
      INNER JOIN records r ON r.record_id = n.record_id
      WHERE name_fts MATCH ?
        AND r.is_debarment = 1
      ORDER BY r.record_id, n.name_full
    `).all(ftsQuery) as NameMatchRow[];

    const bestByRecordId = new Map<string, SenzingNameCandidate>();
    for (const row of rows) {
      const match = toSearchableNameMatch(row);
      const score = scoreSearchableName(normalizedQuery, queryTokens, match);
      if (score === undefined) continue;

      const candidate = {
        record: match.record,
        matchedName: match.matchedName,
        matchedNameType: match.matchedNameType,
        ...score,
      };
      const previous = bestByRecordId.get(candidate.record.RECORD_ID);
      if (!previous || compareCandidateQuality(candidate, previous) < 0) {
        bestByRecordId.set(candidate.record.RECORD_ID, candidate);
      }
    }

    return [...bestByRecordId.values()].sort(compareCandidatesForDisplay);
  }

  findByRecordId(recordId: string): SenzingRecord | undefined {
    const row = this.db.prepare(`
      SELECT record_id, record_json
      FROM records
      WHERE record_id = ?
        AND is_debarment = 1
    `).get(recordId) as RecordRow | undefined;

    return row ? parseJson<SenzingRecord>(row.record_json) : undefined;
  }

  stats(): RepositoryStats {
    const records = count(this.db, 'SELECT COUNT(*) AS count FROM records');
    const indexedNames = count(this.db, 'SELECT COUNT(*) AS count FROM names');
    return { records, indexedNames };
  }

  close(): void {
    this.db.close();
  }
}

export class SqliteTargetDetailsRepository implements TargetDetailsRepository {
  private constructor(private readonly db: Database.Database) {}

  static open(sqlitePath: string): SqliteTargetDetailsRepository {
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    if (!validateSqliteSchema(db)) {
      db.close();
      throw new Error('SQLite schema is incompatible.');
    }
    return new SqliteTargetDetailsRepository(db);
  }

  findSanctionsByRecordId(recordId: string): SanctionDetail[] {
    const row = this.db.prepare(`
      SELECT sanctions_json
      FROM target_sanctions
      WHERE record_id = ?
    `).get(recordId) as SanctionsRow | undefined;

    return row ? parseJson<SanctionDetail[]>(row.sanctions_json) : [];
  }

  stats(): RepositoryStats {
    return { records: count(this.db, 'SELECT COUNT(*) AS count FROM target_sanctions') };
  }

  close(): void {
    this.db.close();
  }
}

function toNameMatch(row: NameMatchRow): SenzingNameMatch {
  return {
    record: parseJson<SenzingRecord>(row.record_json),
    matchedName: row.name_full,
    matchedNameType: row.name_type,
  };
}

function toSearchableNameMatch(row: NameMatchRow): SearchableNameMatch {
  return {
    ...toNameMatch(row),
    normalizedName: row.normalized_name,
    normalizedTokens: parseJson<string[]>(row.normalized_tokens_json),
  };
}

function compareCandidateQuality(left: SenzingNameCandidate, right: SenzingNameCandidate): number {
  return compareCandidatesForDisplay(left, right);
}

function compareCandidatesForDisplay(left: SenzingNameCandidate, right: SenzingNameCandidate): number {
  return (
    right.score - left.score ||
    nameTypeRank(left.matchedNameType) - nameTypeRank(right.matchedNameType) ||
    left.matchedName.localeCompare(right.matchedName, 'en-US') ||
    left.record.RECORD_ID.localeCompare(right.record.RECORD_ID, 'en-US')
  );
}

function nameTypeRank(nameType: string | null | undefined): number {
  return nameType?.toLocaleUpperCase('en-US') === 'PRIMARY' ? 0 : 1;
}

function buildSafePrefixFtsQuery(tokens: string[]): string {
  const terms = tokens
    .map((token) => token.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
    .map((token) => `${token}*`);
  return terms.join(' OR ');
}

function count(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as CountRow | undefined)?.count ?? 0;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
