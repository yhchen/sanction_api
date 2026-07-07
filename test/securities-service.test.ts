import { describe, expect, test } from 'vitest';
import { SenzingMemoryRepository } from '../src/data/senzingMemoryRepository.js';
import { ActiveSecuritiesRepositories, SecuritiesService } from '../src/domain/securitiesService.js';
import type { SenzingRecord } from '../src/domain/types.js';

const nonDebarmentRecord: SenzingRecord = {
  DATA_SOURCE: 'US_OFAC_SDN',
  RECORD_ID: 'us-ofac-sdn-1',
  NAMES: [{ NAME_TYPE: 'PRIMARY', NAME_FULL: 'ACME SECURITIES LTD' }],
  RISKS: [{ TOPIC: 'sanction.linked' }],
};

const orgNameRecord: SenzingRecord = {
  DATA_SOURCE: 'OS_US_DHS_UFLPA',
  RECORD_ID: 'NK-Vq8tbLjL9hai2V7Jx8PYe4',
  NAMES: [
    { NAME_TYPE: 'PRIMARY', NAME_ORG: 'Dongguan Oasis Shoes Co. Ltd.' },
    { NAME_TYPE: 'ALIAS', NAME_ORG: 'Dongguan Lvzhou Shoes Co. Ltd.' },
  ],
  RISKS: [{ TOPIC: 'sanction' }],
};

function service(records: SenzingRecord[], options: { minFuzzyScore?: number } = {}): SecuritiesService {
  const repository = SenzingMemoryRepository.fromRecords(records, options);
  const activeRepositories = new ActiveSecuritiesRepositories(repository);
  return new SecuritiesService(activeRepositories);
}

describe('SecuritiesService', () => {
  test('returns matches without requiring a debarment topic', async () => {
    await expect(service([nonDebarmentRecord]).check('ACME SECURITIES LTD')).resolves.toMatchObject({
      found: true,
      matches: [{ basic: { recordId: 'us-ofac-sdn-1', risks: ['sanction.linked'] } }],
    });
  });

  test('returns not found for unrelated names', async () => {
    await expect(service([nonDebarmentRecord]).check('UNRELATED ENTITY')).resolves.toMatchObject({ found: false });
  });

  test('reports empty dataStatus when the repository has no records', async () => {
    await expect(service([]).check('ACME SECURITIES LTD')).resolves.toMatchObject({ found: false, dataStatus: 'empty' });
  });

  test('fullByRecordId resolves record id lookups', async () => {
    await expect(service([nonDebarmentRecord]).fullByRecordId('us-ofac-sdn-1')).resolves.toMatchObject({
      found: true,
      matches: [{ basic: { recordId: 'us-ofac-sdn-1' } }],
    });
  });

  test('searchCandidates finds fuzzy matches', async () => {
    await expect(service([nonDebarmentRecord]).searchCandidates('Acme Securities')).resolves.toMatchObject({
      found: true,
      candidates: [{ basic: { recordId: 'us-ofac-sdn-1' } }],
    });
  });

  test('returns exact matches for NAME_ORG aliases', async () => {
    await expect(service([orgNameRecord]).check('Dongguan Lvzhou Shoes Co. Ltd.')).resolves.toMatchObject({
      found: true,
      matches: [{
        basic: {
          recordId: 'NK-Vq8tbLjL9hai2V7Jx8PYe4',
          primaryName: 'Dongguan Oasis Shoes Co. Ltd.',
          matchedName: 'Dongguan Lvzhou Shoes Co. Ltd.',
          aliases: ['Dongguan Lvzhou Shoes Co. Ltd.'],
        },
      }],
    });
  });

  test('returns fuzzy candidates for NAME_ORG aliases', async () => {
    await expect(service([orgNameRecord]).searchCandidates('Dongguan Lvzhou')).resolves.toMatchObject({
      found: true,
      candidates: [{
        basic: {
          recordId: 'NK-Vq8tbLjL9hai2V7Jx8PYe4',
          primaryName: 'Dongguan Oasis Shoes Co. Ltd.',
        },
        matchedName: 'Dongguan Lvzhou Shoes Co. Ltd.',
      }],
    });
  });

  test('returns high-threshold fuzzy candidates when one organization descriptor token is added', async () => {
    await expect(service([orgNameRecord], { minFuzzyScore: 0.8 }).searchCandidates('Dongguan Lvzhou Shoes Industry Co. Ltd')).resolves.toMatchObject({
      found: true,
      candidates: [{
        basic: {
          recordId: 'NK-Vq8tbLjL9hai2V7Jx8PYe4',
          primaryName: 'Dongguan Oasis Shoes Co. Ltd.',
        },
        matchedName: 'Dongguan Lvzhou Shoes Co. Ltd.',
      }],
    });
  });

  test('returns high-threshold fuzzy candidates when one organization descriptor token replaces suffix tokens', async () => {
    await expect(service([orgNameRecord], { minFuzzyScore: 0.8 }).searchCandidates('Dongguan Lvzhou Shoes Industry')).resolves.toMatchObject({
      found: true,
      candidates: [{
        basic: {
          recordId: 'NK-Vq8tbLjL9hai2V7Jx8PYe4',
          primaryName: 'Dongguan Oasis Shoes Co. Ltd.',
        },
        matchedName: 'Dongguan Lvzhou Shoes Co. Ltd.',
      }],
    });
  });

  test('fullByRecordId displays NAME_ORG primary names', async () => {
    await expect(service([orgNameRecord]).fullByRecordId('NK-Vq8tbLjL9hai2V7Jx8PYe4')).resolves.toMatchObject({
      found: true,
      matches: [{
        basic: {
          recordId: 'NK-Vq8tbLjL9hai2V7Jx8PYe4',
          primaryName: 'Dongguan Oasis Shoes Co. Ltd.',
          matchedName: 'Dongguan Oasis Shoes Co. Ltd.',
        },
      }],
    });
  });
});
