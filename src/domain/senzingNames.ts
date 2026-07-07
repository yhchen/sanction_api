import type { SenzingName, SenzingRecord } from './types.js';

export interface ExtractedSenzingName {
  value: string;
  type?: string | null;
}

export function extractSenzingNameValue(name: SenzingName): string | undefined {
  const fullName = name.NAME_FULL?.trim();
  if (fullName) return fullName;

  const orgName = name.NAME_ORG?.trim();
  if (orgName) return orgName;

  return undefined;
}

export function extractedSenzingNames(record: SenzingRecord): ExtractedSenzingName[] {
  return (record.NAMES ?? []).flatMap((name) => {
    const value = extractSenzingNameValue(name);
    return value ? [{ value, type: name.NAME_TYPE }] : [];
  });
}

export function primarySenzingName(record: SenzingRecord): string | undefined {
  const names = extractedSenzingNames(record);
  return names.find((name) => name.type?.toLocaleUpperCase('en-US') === 'PRIMARY')?.value ?? names[0]?.value;
}
