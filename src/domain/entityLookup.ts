import type {
  BasicInfo,
  EntityCandidate,
  EntityQueryResult,
  RepositoryDataStatus,
  SenzingLookupRepository,
  SenzingNameCandidate,
  SenzingNameMatch,
  TargetDetailsRepository,
} from './types.js';

/**
 * Generic name-match formatting/materialization helpers shared by `DebarmentService` and
 * `SecuritiesService` — the two domain services differ only in which repository they query and
 * whether they apply an extra topic filter on top of it; everything below is dataset-agnostic.
 */

export function repositoryDataStatus(repository: SenzingLookupRepository): RepositoryDataStatus {
  return repository.stats().records === 0 ? 'empty' : 'ready';
}

export function emptyResult(query: string, dataStatus: RepositoryDataStatus = 'ready'): EntityQueryResult {
  return { query, found: false, matches: [], totalMatches: 0, truncated: false, dataStatus };
}

export function uniqueCandidatesByRecord(candidates: SenzingNameCandidate[]): SenzingNameCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.record.RECORD_ID)) return false;
    seen.add(candidate.record.RECORD_ID);
    return true;
  });
}

export function toCandidate(candidate: SenzingNameCandidate): EntityCandidate {
  return {
    ...candidate,
    basic: toBasicInfo(candidate),
  };
}

export function materializeMatches(
  query: string,
  allMatches: SenzingNameMatch[],
  includeTargetDetails: boolean,
  targetDetailsRepository: TargetDetailsRepository | undefined,
  dataStatus: RepositoryDataStatus,
  maxResults: number,
): EntityQueryResult {
  const cappedMatches = allMatches.slice(0, maxResults);
  const matches = cappedMatches.map((match) => {
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
    dataStatus,
  };
}

export function toBasicInfo(match: SenzingNameMatch): BasicInfo {
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

function getPrimaryName(record: SenzingNameMatch['record']): string | undefined {
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
