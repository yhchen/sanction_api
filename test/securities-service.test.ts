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

function service(records: SenzingRecord[]): SecuritiesService {
  const repository = SenzingMemoryRepository.fromRecords(records);
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
});
