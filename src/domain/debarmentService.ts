import type {
  BasicInfo,
  DebarmentCandidate,
  DebarmentCandidateSearchResult,
  DebarmentMatch,
  DebarmentQueryResult,
  SenzingNameCandidate,
  SenzingNameMatch,
  SenzingRecord,
  SenzingLookupRepository,
  TargetDetailsRepository,
} from './types.js';

export interface DebarmentServiceOptions {
  maxResults?: number;
}

export interface ActiveDebarmentRepositorySnapshot {
  senzingRepository: SenzingLookupRepository;
  targetDetailsRepository?: TargetDetailsRepository;
}

export class ActiveDebarmentRepositories {
  private snapshotValue: ActiveDebarmentRepositorySnapshot;

  constructor(
    senzingRepository: SenzingLookupRepository,
    targetDetailsRepository?: TargetDetailsRepository,
  ) {
    this.snapshotValue = { senzingRepository, targetDetailsRepository };
  }

  snapshot(): ActiveDebarmentRepositorySnapshot {
    return this.snapshotValue;
  }

  replace(
    senzingRepository: SenzingLookupRepository,
    targetDetailsRepository?: TargetDetailsRepository,
  ): void {
    this.snapshotValue = { senzingRepository, targetDetailsRepository };
  }
}

export class DebarmentService {
  private readonly maxResults: number;
  private readonly activeRepositories: ActiveDebarmentRepositories;

  constructor(
    senzingRepositoryOrActiveRepositories: SenzingLookupRepository | ActiveDebarmentRepositories,
    targetDetailsRepositoryOrOptions?: TargetDetailsRepository | DebarmentServiceOptions,
    options: DebarmentServiceOptions = {},
  ) {
    if (senzingRepositoryOrActiveRepositories instanceof ActiveDebarmentRepositories) {
      this.activeRepositories = senzingRepositoryOrActiveRepositories;
      this.maxResults = Math.max(1, (targetDetailsRepositoryOrOptions as DebarmentServiceOptions | undefined)?.maxResults ?? 5);
      return;
    }

    const targetDetailsRepository = isDebarmentServiceOptions(targetDetailsRepositoryOrOptions)
      ? undefined
      : targetDetailsRepositoryOrOptions;
    const resolvedOptions = isDebarmentServiceOptions(targetDetailsRepositoryOrOptions)
      ? targetDetailsRepositoryOrOptions
      : options;
    this.activeRepositories = new ActiveDebarmentRepositories(
      senzingRepositoryOrActiveRepositories,
      targetDetailsRepository,
    );
    this.maxResults = Math.max(1, resolvedOptions.maxResults ?? 5);
  }

  async check(name: string): Promise<DebarmentQueryResult> {
    return this.queryByName(name, false);
  }

  async basic(name: string): Promise<DebarmentQueryResult> {
    return this.queryByName(name, false);
  }

  async full(name: string): Promise<DebarmentQueryResult> {
    return this.queryByName(name, true);
  }

  async searchCandidates(name: string): Promise<DebarmentCandidateSearchResult> {
    return this.searchCandidateNames(name);
  }

  async basicByRecordId(recordId: string): Promise<DebarmentQueryResult> {
    return this.queryByRecordId(recordId, false);
  }

  async fullByRecordId(recordId: string): Promise<DebarmentQueryResult> {
    return this.queryByRecordId(recordId, true);
  }

  private queryByName(name: string, includeTargetDetails: boolean): DebarmentQueryResult {
    const repositories = this.activeRepositories.snapshot();
    const allMatches = repositories.senzingRepository.findByName(name).filter((match) => isDebarmentRecord(match.record));
    return this.materialize(name, allMatches, includeTargetDetails, repositories.targetDetailsRepository);
  }

  private searchCandidateNames(name: string): DebarmentCandidateSearchResult {
    const repositories = this.activeRepositories.snapshot();
    const allCandidates = uniqueCandidatesByRecord(
      repositories.senzingRepository
        .findCandidateNames(name)
        .filter((candidate) => isDebarmentRecord(candidate.record)),
    );
    const cappedCandidates = allCandidates.slice(0, this.maxResults);
    return {
      query: name,
      found: allCandidates.length > 0,
      candidates: cappedCandidates.map(toCandidate),
      totalCandidates: allCandidates.length,
      truncated: allCandidates.length > cappedCandidates.length,
    };
  }

  private queryByRecordId(recordId: string, includeTargetDetails: boolean): DebarmentQueryResult {
    const repositories = this.activeRepositories.snapshot();
    const record = repositories.senzingRepository.findByRecordId(recordId);
    if (!record || !isDebarmentRecord(record)) {
      return emptyResult(recordId);
    }

    const primaryName = getPrimaryName(record) ?? record.RECORD_ID;
    return this.materialize(recordId, [{ record, matchedName: primaryName, matchedNameType: 'RECORD_ID' }], includeTargetDetails, repositories.targetDetailsRepository);
  }

  private materialize(
    query: string,
    allMatches: SenzingNameMatch[],
    includeTargetDetails: boolean,
    targetDetailsRepository: TargetDetailsRepository | undefined,
  ): DebarmentQueryResult {
    const cappedMatches = allMatches.slice(0, this.maxResults);
    const matches = cappedMatches.map((match): DebarmentMatch => {
      const sanctions = includeTargetDetails
        ? (targetDetailsRepository?.findSanctionsByRecordId(match.record.RECORD_ID) ?? [])
        : [];
      return {
        ...match,
        basic: toBasicInfo(match),
        sanctions,
      };
    });

    return {
      query,
      found: allMatches.length > 0,
      matches,
      totalMatches: allMatches.length,
      truncated: allMatches.length > cappedMatches.length,
    };
  }
}

function uniqueCandidatesByRecord(candidates: SenzingNameCandidate[]): SenzingNameCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.record.RECORD_ID)) return false;
    seen.add(candidate.record.RECORD_ID);
    return true;
  });
}

function toCandidate(candidate: SenzingNameCandidate): DebarmentCandidate {
  return {
    ...candidate,
    basic: toBasicInfo(candidate),
  };
}

function emptyResult(query: string): DebarmentQueryResult {
  return { query, found: false, matches: [], totalMatches: 0, truncated: false };
}

function isDebarmentRecord(record: SenzingRecord): boolean {
  return (record.RISKS ?? []).some((risk) => risk.TOPIC?.trim().toLocaleLowerCase('en-US') === 'debarment');
}

function toBasicInfo(match: SenzingNameMatch): BasicInfo {
  const record = match.record;
  const primaryName = getPrimaryName(record) ?? match.matchedName;

  return {
    recordId: record.RECORD_ID,
    primaryName,
    matchedName: match.matchedName,
    matchedNameType: match.matchedNameType,
    aliases: unique(
      (record.NAMES ?? [])
        .filter((name) => name.NAME_FULL && name.NAME_FULL !== primaryName)
        .map((name) => name.NAME_FULL?.trim())
        .filter(isNonEmptyString),
    ),
    risks: unique((record.RISKS ?? []).map((risk) => risk.TOPIC?.trim()).filter(isNonEmptyString)),
    countries: unique(
      (record.COUNTRIES ?? [])
        .flatMap((country) => [country.NATIONALITY, country.COUNTRY, country.CITIZENSHIP])
        .map((value) => value?.trim())
        .filter(isNonEmptyString),
    ),
    addresses: unique(
      (record.ADDRESSES ?? [])
        .map((address) => address.ADDR_FULL?.trim() ?? compactObjectValues(address))
        .filter(isNonEmptyString),
    ),
    identifiers: uniqueIdentifiers(
      (record.IDENTIFIERS ?? [])
        .map((identifier) => ({
          type: identifier.OTHER_ID_TYPE?.trim() || 'identifier',
          value: identifier.OTHER_ID_NUMBER?.trim() ?? '',
        }))
        .filter((identifier) => identifier.value),
    ),
    url: record.URL?.trim() || undefined,
  };
}

function getPrimaryName(record: SenzingRecord): string | undefined {
  return (
    (record.NAMES ?? []).find((name) => name.NAME_TYPE?.toLocaleUpperCase('en-US') === 'PRIMARY')?.NAME_FULL?.trim() ??
    (record.NAMES ?? [])[0]?.NAME_FULL?.trim()
  );
}

function compactObjectValues(object: Record<string, unknown>): string {
  return Object.values(object)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(', ');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueIdentifiers(identifiers: Array<{ type: string; value: string }>): Array<{ type: string; value: string }> {
  const seen = new Set<string>();
  return identifiers.filter((identifier) => {
    const key = `${identifier.type}\0${identifier.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isDebarmentServiceOptions(
  value: TargetDetailsRepository | DebarmentServiceOptions | undefined,
): value is DebarmentServiceOptions {
  return value !== undefined && typeof (value as TargetDetailsRepository).findSanctionsByRecordId !== 'function';
}
