import { describe, expect, test } from 'vitest';
import {
  fetchSecuritiesSourceMetadata,
  parseCatalog,
  resolveCollectionChildren,
  type CatalogDatasetEntry,
} from '../src/data/openSanctionsCatalog.js';

function resource(name: string, checksum = `sha1:${name}-checksum`, size = 100): { name: string; url: string; checksum: string; size: number } {
  return { name, url: `https://example.test/${name}`, checksum, size };
}

function entry(overrides: Partial<CatalogDatasetEntry> & { name: string }): CatalogDatasetEntry {
  return { version: '1', children: [], resources: [], ...overrides };
}

describe('parseCatalog', () => {
  test('parses dataset entries with resources and children', () => {
    const raw = {
      datasets: [
        {
          name: 'securities',
          version: 'v1',
          children: ['us_ofac_sdn', 'openfigi'],
          resources: [],
        },
        {
          name: 'us_ofac_sdn',
          version: 'v2',
          resources: [
            { name: 'senzing.json', url: 'https://example.test/senzing.json', checksum: 'sha1:abc', size: 10 },
          ],
        },
      ],
    };

    const catalog = parseCatalog(raw);

    expect(catalog).toHaveLength(2);
    expect(catalog[0]).toMatchObject({ name: 'securities', children: ['us_ofac_sdn', 'openfigi'] });
    expect(catalog[1]).toMatchObject({
      name: 'us_ofac_sdn',
      resources: [{ name: 'senzing.json', checksum: 'sha1:abc', size: 10 }],
    });
  });

  test('drops resources missing required fields and defaults missing children/resources to empty arrays', () => {
    const raw = {
      datasets: [
        { name: 'openfigi', resources: [{ name: 'entities.ftm.json' }, { name: 'ok', url: 'https://x', checksum: 'sha1:x' }] },
      ],
    };

    const catalog = parseCatalog(raw);

    expect(catalog[0]).toMatchObject({ name: 'openfigi', children: [], resources: [{ name: 'ok' }] });
  });

  test('throws when the response has no datasets array', () => {
    expect(() => parseCatalog({})).toThrow(/datasets array/u);
  });
});

describe('resolveCollectionChildren', () => {
  test('returns the named collection children', () => {
    const catalog = [entry({ name: 'securities', children: ['a', 'b'] })];
    expect(resolveCollectionChildren(catalog, 'securities')).toEqual(['a', 'b']);
  });

  test('throws when the collection is missing', () => {
    expect(() => resolveCollectionChildren([], 'securities')).toThrow(/missing the "securities" collection/u);
  });
});

describe('fetchSecuritiesSourceMetadata', () => {
  test('keeps only children exposing both senzing.json and targets.nested.json', async () => {
    const catalog: CatalogDatasetEntry[] = [
      entry({ name: 'securities', children: ['us_ofac_sdn', 'openfigi', 'no_version'] }),
      entry({ name: 'us_ofac_sdn', version: '2026-v1', resources: [resource('senzing.json'), resource('targets.nested.json'), resource('names.txt')] }),
      entry({ name: 'openfigi', version: '2026-v1', resources: [resource('entities.ftm.json'), resource('targets.simple.csv')] }),
      entry({ name: 'no_version', version: undefined, resources: [resource('senzing.json'), resource('targets.nested.json')] }),
    ];

    const result = await fetchSecuritiesSourceMetadata(async () => catalog);

    expect(result).toEqual([
      {
        slug: 'us_ofac_sdn',
        version: '2026-v1',
        senzing: resource('senzing.json'),
        targetsNested: resource('targets.nested.json'),
      },
    ]);
  });

  test('returns an empty list when the securities collection has no eligible children', async () => {
    const catalog: CatalogDatasetEntry[] = [
      entry({ name: 'securities', children: ['openfigi'] }),
      entry({ name: 'openfigi', resources: [resource('entities.ftm.json')] }),
    ];

    await expect(fetchSecuritiesSourceMetadata(async () => catalog)).resolves.toEqual([]);
  });
});
