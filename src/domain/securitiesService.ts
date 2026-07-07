import { emptyResult, materializeMatches, repositoryDataStatus, toCandidate, uniqueCandidatesByRecord } from './entityLookup.js';
import type {
  EntityCandidateSearchResult,
  EntityQueryResult,
  SenzingRecord,
  SenzingLookupRepository,
  TargetDetailsRepository,
} from './types.js';

export interface SecuritiesServiceOptions {
  maxResults?: number;
  maxCandidateResults?: number;
}

export interface ActiveSecuritiesRepositorySnapshot {
  senzingRepository: SenzingLookupRepository;
  targetDetailsRepository?: TargetDetailsRepository;
}

export class ActiveSecuritiesRepositories {
  private snapshotValue: ActiveSecuritiesRepositorySnapshot;

  constructor(
    senzingRepository: SenzingLookupRepository,
    targetDetailsRepository?: TargetDetailsRepository,
  ) {
    this.snapshotValue = { senzingRepository, targetDetailsRepository };
  }

  snapshot(): ActiveSecuritiesRepositorySnapshot {
    return this.snapshotValue;
  }

  replace(
    senzingRepository: SenzingLookupRepository,
    targetDetailsRepository?: TargetDetailsRepository,
  ): void {
    this.snapshotValue = { senzingRepository, targetDetailsRepository };
  }
}

/**
 * Looks up names against the merged OpenSanctions "Sanctioned Securities" dataset. Unlike
 * `DebarmentService`, no topic filter is applied here: the dedicated repository backing this
 * service only ever contains records merged in from the securities collection's eligible source
 * datasets, so every record it returns already qualifies as sanctioned.
 */
export class SecuritiesService {
  private readonly maxResults: number;
  private readonly maxCandidateResults: number;
  private readonly activeRepositories: ActiveSecuritiesRepositories;

  constructor(activeRepositories: ActiveSecuritiesRepositories, options: SecuritiesServiceOptions = {}) {
    this.activeRepositories = activeRepositories;
    this.maxResults = Math.max(1, options.maxResults ?? 5);
    this.maxCandidateResults = Math.max(1, options.maxCandidateResults ?? 10);
  }

  async check(name: string): Promise<EntityQueryResult> {
    return this.queryByName(name, false);
  }

  async basic(name: string): Promise<EntityQueryResult> {
    return this.queryByName(name, false);
  }

  async full(name: string): Promise<EntityQueryResult> {
    return this.queryByName(name, true);
  }

  async searchCandidates(name: string): Promise<EntityCandidateSearchResult> {
    return this.searchCandidateNames(name);
  }

  async basicByRecordId(recordId: string): Promise<EntityQueryResult> {
    return this.queryByRecordId(recordId, false);
  }

  async fullByRecordId(recordId: string): Promise<EntityQueryResult> {
    return this.queryByRecordId(recordId, true);
  }

  private queryByName(name: string, includeTargetDetails: boolean): EntityQueryResult {
    const repositories = this.activeRepositories.snapshot();
    const dataStatus = repositoryDataStatus(repositories.senzingRepository);
    const allMatches = repositories.senzingRepository.findByName(name);
    return materializeMatches(name, allMatches, includeTargetDetails, repositories.targetDetailsRepository, dataStatus, this.maxResults);
  }

  private searchCandidateNames(name: string): EntityCandidateSearchResult {
    const repositories = this.activeRepositories.snapshot();
    const dataStatus = repositoryDataStatus(repositories.senzingRepository);
    const allCandidates = uniqueCandidatesByRecord(repositories.senzingRepository.findCandidateNames(name));
    const cappedCandidates = allCandidates.slice(0, this.maxCandidateResults);
    return {
      query: name,
      found: allCandidates.length > 0,
      candidates: cappedCandidates.map(toCandidate),
      totalCandidates: allCandidates.length,
      truncated: allCandidates.length > cappedCandidates.length,
      dataStatus,
    };
  }

  private queryByRecordId(recordId: string, includeTargetDetails: boolean): EntityQueryResult {
    const repositories = this.activeRepositories.snapshot();
    const dataStatus = repositoryDataStatus(repositories.senzingRepository);
    const record = repositories.senzingRepository.findByRecordId(recordId);
    if (!record) return emptyResult(recordId, dataStatus);

    const primaryName = getPrimaryName(record) ?? record.RECORD_ID;
    return materializeMatches(
      recordId,
      [{ record, matchedName: primaryName, matchedNameType: 'RECORD_ID' }],
      includeTargetDetails,
      repositories.targetDetailsRepository,
      dataStatus,
      this.maxResults,
    );
  }
}

function getPrimaryName(record: SenzingRecord): string | undefined {
  return (
    (record.NAMES ?? []).find((name) => name.NAME_TYPE?.toLocaleUpperCase('en-US') === 'PRIMARY')?.NAME_FULL?.trim() ??
    (record.NAMES ?? [])[0]?.NAME_FULL?.trim()
  );
}
