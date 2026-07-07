export interface SenzingName {
  NAME_TYPE?: string | null;
  NAME_FULL?: string | null;
  NAME_ORG?: string | null;
}

export interface SenzingRisk {
  TOPIC?: string | null;
}

export interface SenzingAddress {
  ADDR_FULL?: string | null;
  [key: string]: unknown;
}

export interface SenzingCountry {
  NATIONALITY?: string | null;
  COUNTRY?: string | null;
  CITIZENSHIP?: string | null;
  [key: string]: unknown;
}

export interface SenzingIdentifier {
  OTHER_ID_TYPE?: string | null;
  OTHER_ID_NUMBER?: string | null;
  [key: string]: unknown;
}

export interface SenzingRecord {
  DATA_SOURCE?: string | null;
  RECORD_ID: string;
  RECORD_TYPE?: string | null;
  LAST_CHANGE?: string | null;
  NAMES?: SenzingName[];
  RISKS?: SenzingRisk[];
  ADDRESSES?: SenzingAddress[];
  COUNTRIES?: SenzingCountry[];
  IDENTIFIERS?: SenzingIdentifier[];
  URL?: string | null;
  [key: string]: unknown;
}

export interface TargetNestedSanction {
  id?: string;
  caption?: string;
  schema?: string;
  properties?: Record<string, string[] | undefined>;
  target?: boolean;
  [key: string]: unknown;
}

export interface TargetNestedRecord {
  id: string;
  caption?: string;
  schema?: string;
  properties?: {
    notes?: string[];
    country?: string[];
    name?: string[];
    topics?: string[];
    createdAt?: string[];
    address?: string[];
    uniqueEntityId?: string[];
    sanctions?: TargetNestedSanction[];
    [key: string]: unknown;
  };
  target?: boolean;
  [key: string]: unknown;
}

export interface SanctionDetail {
  id?: string;
  caption?: string;
  authority: string[];
  status: string[];
  listingDate: string[];
  startDate: string[];
  program: string[];
  provisions: string[];
  sourceUrl: string[];
  summary: string[];
}

export interface SenzingNameMatch {
  record: SenzingRecord;
  matchedName: string;
  matchedNameType?: string | null;
}

export interface SenzingNameCandidate extends SenzingNameMatch {
  score: number;
  matchReason: string;
}

export interface RepositoryStats {
  records: number;
  indexedNames?: number;
}

export interface SenzingLookupRepository {
  findByName(name: string): SenzingNameMatch[];
  findCandidateNames(name: string): SenzingNameCandidate[];
  findByRecordId(recordId: string): SenzingRecord | undefined;
  stats(): RepositoryStats;
}

export interface TargetDetailsRepository {
  findSanctionsByRecordId(recordId: string): SanctionDetail[];
  stats(): RepositoryStats;
}

export type RepositoryDataStatus = 'ready' | 'empty';

export interface BasicInfo {
  recordId: string;
  primaryName: string;
  matchedName: string;
  matchedNameType?: string | null;
  aliases: string[];
  risks: string[];
  countries: string[];
  addresses: string[];
  identifiers: Array<{ type: string; value: string }>;
  url?: string;
}

/**
 * Generic shape for a single-list name-match result. Shared by both the debarment and
 * sanctioned-securities domain services (the shape was never actually debarment-specific — only
 * the name was); the orchestration layer (`sanctionedLookupService.ts`) tags these with which
 * list they came from when merging results from both services.
 */
export interface EntityMatch {
  record: SenzingRecord;
  matchedName: string;
  matchedNameType?: string | null;
  basic: BasicInfo;
  sanctions: SanctionDetail[];
}

export interface EntityQueryResult {
  query: string;
  found: boolean;
  matches: EntityMatch[];
  totalMatches: number;
  truncated: boolean;
  dataStatus?: RepositoryDataStatus;
}

export interface EntityCandidate {
  record: SenzingRecord;
  matchedName: string;
  matchedNameType?: string | null;
  score: number;
  matchReason: string;
  basic: BasicInfo;
}

export interface EntityCandidateSearchResult {
  query: string;
  found: boolean;
  candidates: EntityCandidate[];
  totalCandidates: number;
  truncated: boolean;
  dataStatus?: RepositoryDataStatus;
}

export interface ReplyButton {
  text: string;
  callbackData: string;
}

export interface BotNotification {
  chatId: string;
  text: string;
}

export interface BotReply {
  text: string;
  buttons: ReplyButton[][];
  notifications?: BotNotification[];
  parseMode?: 'HTML';
}
