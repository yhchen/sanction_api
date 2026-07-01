import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { readSecuritiesCsvFile, splitOpenSanctionsCsvList, type SecuritiesCsvRecord } from '../src/data/securitiesCsv.js';

const fixturePath = path.join(process.cwd(), 'test/fixtures/securities.fixture.csv');

describe('securities CSV parser', () => {
  test('streams securities CSV rows by header name', async () => {
    const rows: SecuritiesCsvRecord[] = [];
    await readSecuritiesCsvFile(fixturePath, (row) => {
      rows.push(row);
    });

    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      id: 'NK-223CQDBzp8MRkdJMDiqXn3',
      caption: 'YATAI SMART INDUSTRIAL NEW CITY',
      countries: ['mm'],
      sanctioned: true,
      eo14071: false,
      isins: [],
      aliases: ['Myanmar Yatai International Holding Group Co., LTD.', 'Yatai New City'],
      referents: expect.arrayContaining(['ofac-54742', 'usgsa-s4mrwvjp8']),
    });
    expect(rows[1]).toMatchObject({
      id: 'NK-SECURITIESONLY',
      lei: ['213800SS45WKYIT4EP89'],
      permId: ['5063730210'],
      isins: ['RU000A0JX0J2', 'RU000A0JX0J3'],
      ric: ['ONLY.MM'],
      public: true,
    });
  });

  test('parses semicolon lists and trims empty values', () => {
    expect(splitOpenSanctionsCsvList(' A ; ;B; C ')).toEqual(['A', 'B', 'C']);
  });
});
