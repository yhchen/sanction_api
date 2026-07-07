import { describe, expect, test } from 'vitest';
import { SenzingMemoryRepository } from '../src/data/senzingMemoryRepository.js';
import { DebarmentService } from '../src/domain/debarmentService.js';
import { SanctionedLookupService } from '../src/domain/sanctionedLookupService.js';
import { ActiveSecuritiesRepositories, SecuritiesService } from '../src/domain/securitiesService.js';
import type { SenzingRecord } from '../src/domain/types.js';

function debarmentRecord(recordId: string, name: string): SenzingRecord {
  return {
    DATA_SOURCE: 'DEBARMENT',
    RECORD_ID: recordId,
    NAMES: [{ NAME_TYPE: 'PRIMARY', NAME_FULL: name }],
    RISKS: [{ TOPIC: 'debarment' }],
  };
}

function securitiesRecord(recordId: string, name: string): SenzingRecord {
  return {
    DATA_SOURCE: 'US_OFAC_SDN',
    RECORD_ID: recordId,
    NAMES: [{ NAME_TYPE: 'PRIMARY', NAME_FULL: name }],
    RISKS: [{ TOPIC: 'sanction.linked' }],
  };
}

function buildService(options: {
  debarmentRecords?: SenzingRecord[];
  securitiesRecords?: SenzingRecord[];
  maxResults?: number;
  maxCandidateResults?: number;
} = {}): SanctionedLookupService {
  const debarmentService = new DebarmentService(SenzingMemoryRepository.fromRecords(options.debarmentRecords ?? []));
  const securitiesService = new SecuritiesService(
    new ActiveSecuritiesRepositories(SenzingMemoryRepository.fromRecords(options.securitiesRecords ?? [])),
  );
  return new SanctionedLookupService(debarmentService, securitiesService, {
    maxResults: options.maxResults,
    maxCandidateResults: options.maxCandidateResults,
  });
}

describe('SanctionedLookupService', () => {
  test('tags a debarment-only match with source "debarment"', async () => {
    const service = buildService({ debarmentRecords: [debarmentRecord('D1', 'ONLY DEBARRED CO')] });

    await expect(service.check('ONLY DEBARRED CO')).resolves.toMatchObject({
      found: true,
      totalMatches: 1,
      matches: [{ source: 'debarment', basic: { recordId: 'D1' } }],
    });
  });

  test('tags a securities-only match with source "securities"', async () => {
    const service = buildService({ securitiesRecords: [securitiesRecord('S1', 'ONLY SECURITIES CO')] });

    await expect(service.check('ONLY SECURITIES CO')).resolves.toMatchObject({
      found: true,
      totalMatches: 1,
      matches: [{ source: 'securities', basic: { recordId: 'S1' } }],
    });
  });

  test('merges matches from both sources when the same name appears in both lists', async () => {
    const service = buildService({
      debarmentRecords: [debarmentRecord('D1', 'SHARED CO')],
      securitiesRecords: [securitiesRecord('S1', 'SHARED CO')],
    });

    await expect(service.check('SHARED CO')).resolves.toMatchObject({
      found: true,
      totalMatches: 2,
      truncated: false,
      matches: [
        { source: 'debarment', basic: { recordId: 'D1' } },
        { source: 'securities', basic: { recordId: 'S1' } },
      ],
    });
  });

  test('reports not found when neither source has a match', async () => {
    const service = buildService({
      debarmentRecords: [debarmentRecord('D1', 'SHARED CO')],
      securitiesRecords: [securitiesRecord('S1', 'SHARED CO')],
    });

    await expect(service.check('NOBODY HERE')).resolves.toMatchObject({ found: false, totalMatches: 0, matches: [] });
  });

  test('caps combined matches at maxResults and marks truncated across sources', async () => {
    const service = buildService({
      debarmentRecords: [debarmentRecord('D1', 'SHARED CO')],
      securitiesRecords: [securitiesRecord('S1', 'SHARED CO')],
      maxResults: 1,
    });

    await expect(service.check('SHARED CO')).resolves.toMatchObject({
      found: true,
      totalMatches: 2,
      truncated: true,
      matches: [{ source: 'debarment', basic: { recordId: 'D1' } }],
    });
  });

  test('reports dataStatus empty only when both underlying repositories are empty', async () => {
    const bothEmpty = buildService({});
    await expect(bothEmpty.check('ANYTHING')).resolves.toMatchObject({ dataStatus: 'empty' });

    const onlyDebarmentPopulated = buildService({ debarmentRecords: [debarmentRecord('D1', 'SOME CO')] });
    await expect(onlyDebarmentPopulated.check('ANYTHING')).resolves.toMatchObject({ dataStatus: 'ready' });
  });

  test('searchCandidates merges and tags fuzzy candidates from both sources', async () => {
    const service = buildService({
      debarmentRecords: [debarmentRecord('D1', 'ACME DEBARRED CO')],
      securitiesRecords: [securitiesRecord('S1', 'ACME SECURITIES CO')],
    });

    const result = await service.searchCandidates('Acme');

    expect(result.found).toBe(true);
    expect(result.candidates.map((candidate) => candidate.source).sort()).toEqual(['debarment', 'securities']);
  });

  test('basicByRecordId resolves a record id that only exists in the securities repository', async () => {
    const service = buildService({
      debarmentRecords: [debarmentRecord('D1', 'ACME DEBARRED CO')],
      securitiesRecords: [securitiesRecord('S1', 'ACME SECURITIES CO')],
    });

    await expect(service.basicByRecordId('S1')).resolves.toMatchObject({
      found: true,
      matches: [{ source: 'securities', basic: { recordId: 'S1' } }],
    });
  });
});
