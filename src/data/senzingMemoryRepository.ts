import { normalizeName } from '../domain/normalize.js';
import { DEFAULT_MIN_FUZZY_SCORE, normalizedTokens, scoreSearchableName } from '../domain/nameScoring.js';
import type { RepositoryStats, SenzingLookupRepository, SenzingNameCandidate, SenzingNameMatch, SenzingRecord } from '../domain/types.js';
import { readJsonlFile } from './jsonl.js';

interface SearchableNameMatch extends SenzingNameMatch {
  normalizedName: string;
  normalizedTokens: string[];
}

export interface SenzingMemoryRepositoryOptions {
  minFuzzyScore?: number;
}

export class SenzingMemoryRepository implements SenzingLookupRepository {
  private readonly recordsById = new Map<string, SenzingRecord>();
  private readonly nameIndex = new Map<string, SenzingNameMatch[]>();
  private readonly searchableNames: SearchableNameMatch[] = [];
  private readonly minFuzzyScore: number;
  private indexedNames = 0;

  constructor(options: SenzingMemoryRepositoryOptions = {}) {
    this.minFuzzyScore = options.minFuzzyScore ?? DEFAULT_MIN_FUZZY_SCORE;
  }

  static async fromFile(filePath: string, options: SenzingMemoryRepositoryOptions = {}): Promise<SenzingMemoryRepository> {
    const repository = new SenzingMemoryRepository(options);
    await readJsonlFile<SenzingRecord>(filePath, (record, lineNumber) => {
      if (!record.RECORD_ID) {
        throw new Error(`Senzing record missing RECORD_ID at line ${lineNumber}`);
      }
      repository.addRecord(record);
    });
    return repository;
  }

  static fromRecords(records: SenzingRecord[], options: SenzingMemoryRepositoryOptions = {}): SenzingMemoryRepository {
    const repository = new SenzingMemoryRepository(options);
    for (const record of records) repository.addRecord(record);
    return repository;
  }

  findByName(name: string): SenzingNameMatch[] {
    const normalized = normalizeName(name);
    if (!normalized) return [];
    return [...(this.nameIndex.get(normalized) ?? [])];
  }

  findCandidateNames(name: string): SenzingNameCandidate[] {
    const normalizedQuery = normalizeName(name);
    if (!normalizedQuery) return [];
    const queryTokens = normalizedTokens(normalizedQuery);

    const candidates: SenzingNameCandidate[] = this.searchableNames
      .flatMap((match) => {
        const score = scoreSearchableName(normalizedQuery, queryTokens, match, this.minFuzzyScore);
        return score === undefined
          ? []
          : [{
            record: match.record,
            matchedName: match.matchedName,
            matchedNameType: match.matchedNameType,
            ...score,
          }];
      })
      .sort((left, right) =>
        right.score - left.score ||
        left.matchedName.localeCompare(right.matchedName, 'en-US') ||
        left.record.RECORD_ID.localeCompare(right.record.RECORD_ID, 'en-US'),
      );

    const seen = new Set<string>();
    return candidates.filter((candidate) => {
      const key = `${candidate.record.RECORD_ID}\0${candidate.matchedName}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  findByRecordId(recordId: string): SenzingRecord | undefined {
    return this.recordsById.get(recordId);
  }

  stats(): RepositoryStats {
    return {
      records: this.recordsById.size,
      indexedNames: this.indexedNames,
    };
  }

  private addRecord(record: SenzingRecord): void {
    this.recordsById.set(record.RECORD_ID, record);
    const seenNormalizedNamesForRecord = new Set<string>();

    for (const name of record.NAMES ?? []) {
      const fullName = name.NAME_FULL?.trim();
      if (!fullName) continue;
      const normalized = normalizeName(fullName);
      if (!normalized || seenNormalizedNamesForRecord.has(normalized)) continue;
      seenNormalizedNamesForRecord.add(normalized);

      const matches = this.nameIndex.get(normalized) ?? [];
      const match = { record, matchedName: fullName, matchedNameType: name.NAME_TYPE };
      matches.push(match);
      this.nameIndex.set(normalized, matches);
      this.searchableNames.push({ ...match, normalizedName: normalized, normalizedTokens: normalizedTokens(normalized) });
      this.indexedNames += 1;
    }
  }
}
