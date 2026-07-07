import { describe, expect, test } from 'vitest';
import { formatBasicResults, formatCheckResult } from '../src/bot/formatters.js';
import { SenzingMemoryRepository } from '../src/data/senzingMemoryRepository.js';
import { DebarmentService } from '../src/domain/debarmentService.js';
import { SanctionedLookupService } from '../src/domain/sanctionedLookupService.js';
import { ActiveSecuritiesRepositories, SecuritiesService } from '../src/domain/securitiesService.js';
import type { SenzingRecord } from '../src/domain/types.js';

const debarredRecord: SenzingRecord = {
  DATA_SOURCE: 'DEBARMENT',
  RECORD_ID: 'D1',
  NAMES: [{ NAME_TYPE: 'PRIMARY', NAME_FULL: 'ONLY DEBARRED CO' }],
  RISKS: [{ TOPIC: 'debarment' }],
};
const securitiesOnlyRecord: SenzingRecord = {
  DATA_SOURCE: 'US_OFAC_SDN',
  RECORD_ID: 'S1',
  NAMES: [{ NAME_TYPE: 'PRIMARY', NAME_FULL: 'ONLY SECURITIES CO' }],
  RISKS: [{ TOPIC: 'sanction.linked' }],
};
const sharedNameDebarred: SenzingRecord = {
  DATA_SOURCE: 'DEBARMENT',
  RECORD_ID: 'D2',
  NAMES: [{ NAME_TYPE: 'PRIMARY', NAME_FULL: 'SHARED CO' }],
  RISKS: [{ TOPIC: 'debarment' }],
};
const sharedNameSecurities: SenzingRecord = {
  DATA_SOURCE: 'US_OFAC_SDN',
  RECORD_ID: 'S2',
  NAMES: [{ NAME_TYPE: 'PRIMARY', NAME_FULL: 'SHARED CO' }],
  RISKS: [{ TOPIC: 'sanction.linked' }],
};

function buildService(): SanctionedLookupService {
  const debarmentService = new DebarmentService(
    SenzingMemoryRepository.fromRecords([debarredRecord, sharedNameDebarred]),
  );
  const securitiesService = new SecuritiesService(
    new ActiveSecuritiesRepositories(SenzingMemoryRepository.fromRecords([securitiesOnlyRecord, sharedNameSecurities])),
  );
  return new SanctionedLookupService(debarmentService, securitiesService);
}

describe('bot formatting for the merged sanctioned lookup', () => {
  test('labels a securities-only match as "Sanctioned (Securities)" and surfaces its topic', async () => {
    const service = buildService();
    const result = await service.check('ONLY SECURITIES CO');

    const checkReply = formatCheckResult(result);
    expect(checkReply.text.startsWith('Sanctioned (Securities)')).toBe(true);

    const basicReply = formatBasicResults(await service.basic('ONLY SECURITIES CO'));
    expect(basicReply.text).toContain('Source: Sanctioned (Securities)');
    expect(basicReply.text).toContain('Topics/Risks: sanction.linked');
  });

  test('labels a debarment-only match as "Debarred"', async () => {
    const service = buildService();
    const result = await service.check('ONLY DEBARRED CO');

    expect(formatCheckResult(result).text.startsWith('Debarred')).toBe(true);
    const basicReply = formatBasicResults(await service.basic('ONLY DEBARRED CO'));
    expect(basicReply.text).toContain('Source: Debarred');
  });

  test('uses a generic "Sanctioned" header and labels each match when both sources match', async () => {
    const service = buildService();
    const result = await service.check('SHARED CO');

    expect(result.matches.map((match) => match.source).sort()).toEqual(['debarment', 'securities']);
    const checkReply = formatCheckResult(result);
    expect(checkReply.text.startsWith('Sanctioned')).toBe(true);
    expect(checkReply.text).toContain('— Debarred');
    expect(checkReply.text).toContain('— Sanctioned (Securities)');
  });
});
