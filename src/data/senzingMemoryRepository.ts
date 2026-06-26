import { normalizeName } from '../domain/normalize.js';
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
    this.minFuzzyScore = options.minFuzzyScore ?? 0.8;
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
    const queryTokens = tokens(normalizedQuery);

    const candidates: SenzingNameCandidate[] = this.searchableNames
      .flatMap((match) => {
        const score = scoreCandidate(normalizedQuery, queryTokens, match, this.minFuzzyScore);
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
      this.searchableNames.push({ ...match, normalizedName: normalized, normalizedTokens: tokens(normalized) });
      this.indexedNames += 1;
    }
  }
}

function scoreCandidate(
  normalizedQuery: string,
  queryTokens: string[],
  candidate: SearchableNameMatch,
  minFuzzyScore: number,
): { score: number; matchReason: string } | undefined {
  if (!candidate.normalizedName) return undefined;
  if (candidate.normalizedName === normalizedQuery) return { score: 1, matchReason: 'exact-name-candidate' };
  if (candidate.normalizedName.includes(normalizedQuery)) {
    const score = 0.95;
    return score < minFuzzyScore ? undefined : { score, matchReason: 'contains-query' };
  }

  const candidateTokens = candidate.normalizedTokens;
  if (queryTokens.length === 0 || candidateTokens.length === 0) return undefined;

  const exactTokenMatches = queryTokens.filter((queryToken) => candidateTokens.includes(queryToken)).length;
  const prefixTokenMatches = queryTokens.filter((queryToken) =>
    candidateTokens.some((candidateToken) => candidateToken.startsWith(queryToken) || queryToken.startsWith(candidateToken)),
  ).length;
  const substringTokenMatches = queryTokens.filter((queryToken) =>
    candidateTokens.some((candidateToken) => candidateToken.includes(queryToken) || queryToken.includes(candidateToken)),
  ).length;

  const tokenCoverage = exactTokenMatches / queryTokens.length;
  const prefixCoverage = prefixTokenMatches / queryTokens.length;
  const substringCoverage = substringTokenMatches / queryTokens.length;
  const orderBonus = appearsInOrder(queryTokens, candidateTokens) ? 0.08 : 0;
  const score = Math.min(0.94, tokenCoverage * 0.65 + prefixCoverage * 0.20 + substringCoverage * 0.10 + orderBonus);
  if (score < minFuzzyScore) return undefined;

  return {
    score,
    matchReason: exactTokenMatches === queryTokens.length ? 'token-match' : 'similar-name',
  };
}

function tokens(normalizedName: string): string[] {
  return normalizedName.split(' ').filter(Boolean);
}

function appearsInOrder(queryTokens: string[], candidateTokens: string[]): boolean {
  let candidateIndex = 0;
  for (const queryToken of queryTokens) {
    const nextIndex = candidateTokens.findIndex((candidateToken, index) => index >= candidateIndex && candidateToken.includes(queryToken));
    if (nextIndex < 0) return false;
    candidateIndex = nextIndex + 1;
  }
  return true;
}
