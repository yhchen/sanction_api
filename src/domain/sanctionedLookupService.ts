import type { DebarmentService } from './debarmentService.js';
import type { SecuritiesService } from './securitiesService.js';
import type {
  EntityCandidate,
  EntityCandidateSearchResult,
  EntityMatch,
  EntityQueryResult,
  RepositoryDataStatus,
} from './types.js';

export type SanctionSource = 'debarment' | 'securities';

export type SanctionedMatch = EntityMatch & { source: SanctionSource };
export type SanctionedCandidate = EntityCandidate & { source: SanctionSource };

export interface SanctionedQueryResult {
  query: string;
  found: boolean;
  matches: SanctionedMatch[];
  totalMatches: number;
  truncated: boolean;
  dataStatus?: RepositoryDataStatus;
}

export interface SanctionedCandidateSearchResult {
  query: string;
  found: boolean;
  candidates: SanctionedCandidate[];
  totalCandidates: number;
  truncated: boolean;
  dataStatus?: RepositoryDataStatus;
}

export interface SanctionedLookupServiceOptions {
  maxResults?: number;
  maxCandidateResults?: number;
}

/**
 * Queries the debarment and sanctioned-securities services together and merges their results
 * into one reply, tagging each match/candidate with which list it came from so the bot layer can
 * label them ("Debarred" vs "Sanctioned (Securities)"). The two underlying services keep their
 * own filtering rules (debarment's topic filter vs. securities' no-filter); this layer only
 * merges, labels, and re-caps their already-capped outputs.
 */
export class SanctionedLookupService {
  private readonly maxResults: number;
  private readonly maxCandidateResults: number;

  constructor(
    private readonly debarmentService: DebarmentService,
    private readonly securitiesService: SecuritiesService,
    options: SanctionedLookupServiceOptions = {},
  ) {
    this.maxResults = Math.max(1, options.maxResults ?? 5);
    this.maxCandidateResults = Math.max(1, options.maxCandidateResults ?? 10);
  }

  async check(name: string): Promise<SanctionedQueryResult> {
    return this.mergeQueryResults(name, this.debarmentService.check(name), this.securitiesService.check(name));
  }

  async basic(name: string): Promise<SanctionedQueryResult> {
    return this.mergeQueryResults(name, this.debarmentService.basic(name), this.securitiesService.basic(name));
  }

  async full(name: string): Promise<SanctionedQueryResult> {
    return this.mergeQueryResults(name, this.debarmentService.full(name), this.securitiesService.full(name));
  }

  async basicByRecordId(recordId: string): Promise<SanctionedQueryResult> {
    return this.mergeQueryResults(recordId, this.debarmentService.basicByRecordId(recordId), this.securitiesService.basicByRecordId(recordId));
  }

  async fullByRecordId(recordId: string): Promise<SanctionedQueryResult> {
    return this.mergeQueryResults(recordId, this.debarmentService.fullByRecordId(recordId), this.securitiesService.fullByRecordId(recordId));
  }

  async searchCandidates(name: string): Promise<SanctionedCandidateSearchResult> {
    const [debarmentResult, securitiesResult] = await Promise.all([
      this.debarmentService.searchCandidates(name),
      this.securitiesService.searchCandidates(name),
    ]);

    const combinedCandidates = [
      ...tagCandidates(debarmentResult.candidates, 'debarment'),
      ...tagCandidates(securitiesResult.candidates, 'securities'),
    ];
    const cappedCandidates = combinedCandidates.slice(0, this.maxCandidateResults);
    const totalCandidates = debarmentResult.totalCandidates + securitiesResult.totalCandidates;

    return {
      query: name,
      found: debarmentResult.found || securitiesResult.found,
      candidates: cappedCandidates,
      totalCandidates,
      truncated: debarmentResult.truncated || securitiesResult.truncated || combinedCandidates.length > cappedCandidates.length,
      dataStatus: combinedDataStatus(debarmentResult.dataStatus, securitiesResult.dataStatus),
    };
  }

  private async mergeQueryResults(
    query: string,
    debarmentResultPromise: Promise<EntityQueryResult>,
    securitiesResultPromise: Promise<EntityQueryResult>,
  ): Promise<SanctionedQueryResult> {
    const [debarmentResult, securitiesResult] = await Promise.all([debarmentResultPromise, securitiesResultPromise]);

    const combinedMatches = [
      ...tagMatches(debarmentResult.matches, 'debarment'),
      ...tagMatches(securitiesResult.matches, 'securities'),
    ];
    const cappedMatches = combinedMatches.slice(0, this.maxResults);
    const totalMatches = debarmentResult.totalMatches + securitiesResult.totalMatches;

    return {
      query,
      found: debarmentResult.found || securitiesResult.found,
      matches: cappedMatches,
      totalMatches,
      truncated: debarmentResult.truncated || securitiesResult.truncated || combinedMatches.length > cappedMatches.length,
      dataStatus: combinedDataStatus(debarmentResult.dataStatus, securitiesResult.dataStatus),
    };
  }
}

function tagMatches(matches: EntityMatch[], source: SanctionSource): SanctionedMatch[] {
  return matches.map((match) => ({ ...match, source }));
}

function tagCandidates(candidates: EntityCandidate[], source: SanctionSource): SanctionedCandidate[] {
  return candidates.map((candidate) => ({ ...candidate, source }));
}

function combinedDataStatus(
  left: RepositoryDataStatus | undefined,
  right: RepositoryDataStatus | undefined,
): RepositoryDataStatus {
  return left === 'empty' && right === 'empty' ? 'empty' : 'ready';
}
