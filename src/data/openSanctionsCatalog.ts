export const OPENSANCTIONS_CATALOG_URL = 'https://api.opensanctions.org/catalog';
export const DEFAULT_CATALOG_TIMEOUT_MS = 60_000;

export const SECURITIES_COLLECTION_NAME = 'securities';
const REQUIRED_RESOURCE_NAMES = ['senzing.json', 'targets.nested.json'] as const;

export interface CatalogResource {
  name: string;
  url: string;
  checksum: string;
  size?: number;
}

export interface CatalogDatasetEntry {
  name: string;
  version?: string;
  children: string[];
  resources: CatalogResource[];
}

export interface SecuritiesSourceMetadata {
  slug: string;
  version: string;
  senzing: CatalogResource;
  targetsNested: CatalogResource;
}

export type CatalogFetcher = () => Promise<CatalogDatasetEntry[]>;

export async function fetchOpenSanctionsCatalog(): Promise<CatalogDatasetEntry[]> {
  const response = await fetch(OPENSANCTIONS_CATALOG_URL, { signal: AbortSignal.timeout(DEFAULT_CATALOG_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`OpenSanctions catalog fetch failed with HTTP ${response.status}`);
  return parseCatalog(await response.json());
}

export function parseCatalog(raw: unknown): CatalogDatasetEntry[] {
  if (!raw || typeof raw !== 'object') throw new Error('OpenSanctions catalog response is not an object.');
  const datasets = (raw as Record<string, unknown>).datasets;
  if (!Array.isArray(datasets)) throw new Error('OpenSanctions catalog response is missing a datasets array.');
  return datasets.map(parseCatalogEntry);
}

function parseCatalogEntry(raw: unknown): CatalogDatasetEntry {
  if (!raw || typeof raw !== 'object') throw new Error('OpenSanctions catalog entry is not an object.');
  const object = raw as Record<string, unknown>;
  const name = stringValue(object.name);
  if (!name) throw new Error('OpenSanctions catalog entry is missing a name.');
  const children = Array.isArray(object.children) ? object.children.filter((child): child is string => typeof child === 'string') : [];
  const resources = Array.isArray(object.resources) ? object.resources.map(parseCatalogResource).filter(isDefinedResource) : [];
  return { name, version: stringValue(object.version) || undefined, children, resources };
}

function parseCatalogResource(raw: unknown): CatalogResource | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const object = raw as Record<string, unknown>;
  const name = stringValue(object.name) || stringValue(object.path);
  const url = stringValue(object.url);
  const checksum = stringValue(object.checksum) || stringValue(object.hash);
  if (!name || !url || !checksum) return undefined;
  return { name, url, checksum, size: numberValue(object.size) };
}

function isDefinedResource(resource: CatalogResource | undefined): resource is CatalogResource {
  return resource !== undefined;
}

/** Finds the named collection's child dataset slugs (e.g. the `securities` collection's ~26 sources). */
export function resolveCollectionChildren(catalog: CatalogDatasetEntry[], collectionName: string): string[] {
  const collection = catalog.find((entry) => entry.name === collectionName);
  if (!collection) throw new Error(`OpenSanctions catalog is missing the "${collectionName}" collection.`);
  return collection.children;
}

/**
 * Resolves the `securities` collection's eligible child datasets: those whose own catalog entry
 * exposes both `senzing.json` and `targets.nested.json` resources. Most of the ~26 children are
 * reference/external datasets (e.g. `openfigi`, `ext_gleif`) that only ship CSV/entity exports
 * and are excluded here rather than hardcoded, so this self-adjusts as OpenSanctions changes the
 * collection's membership.
 */
export async function fetchSecuritiesSourceMetadata(fetchCatalog: CatalogFetcher = fetchOpenSanctionsCatalog): Promise<SecuritiesSourceMetadata[]> {
  const catalog = await fetchCatalog();
  const childSlugs = new Set(resolveCollectionChildren(catalog, SECURITIES_COLLECTION_NAME));
  const bySlug = new Map(catalog.map((entry) => [entry.name, entry]));

  const eligible: SecuritiesSourceMetadata[] = [];
  for (const slug of childSlugs) {
    const entry = bySlug.get(slug);
    if (!entry || !entry.version) continue;
    const senzing = findResource(entry, 'senzing.json');
    const targetsNested = findResource(entry, 'targets.nested.json');
    if (!senzing || !targetsNested) continue;
    eligible.push({ slug, version: entry.version, senzing, targetsNested });
  }
  return eligible.sort((left, right) => left.slug.localeCompare(right.slug, 'en-US'));
}

function findResource(entry: CatalogDatasetEntry, resourceName: (typeof REQUIRED_RESOURCE_NAMES)[number]): CatalogResource | undefined {
  return entry.resources.find((resource) => resource.name === resourceName);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
