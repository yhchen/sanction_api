import { normalizeName } from '../domain/normalize.js';
import type { RepositoryStats, SenzingLookupRepository, SenzingNameMatch, SenzingRecord } from '../domain/types.js';
import { readJsonlFile } from './jsonl.js';

export class SenzingMemoryRepository implements SenzingLookupRepository {
  private readonly recordsById = new Map<string, SenzingRecord>();
  private readonly nameIndex = new Map<string, SenzingNameMatch[]>();
  private indexedNames = 0;

  static async fromFile(filePath: string): Promise<SenzingMemoryRepository> {
    const repository = new SenzingMemoryRepository();
    await readJsonlFile<SenzingRecord>(filePath, (record, lineNumber) => {
      if (!record.RECORD_ID) {
        throw new Error(`Senzing record missing RECORD_ID at line ${lineNumber}`);
      }
      repository.addRecord(record);
    });
    return repository;
  }

  static fromRecords(records: SenzingRecord[]): SenzingMemoryRepository {
    const repository = new SenzingMemoryRepository();
    for (const record of records) repository.addRecord(record);
    return repository;
  }

  findByName(name: string): SenzingNameMatch[] {
    const normalized = normalizeName(name);
    if (!normalized) return [];
    return [...(this.nameIndex.get(normalized) ?? [])];
  }

  findByRecordId(recordId: string): SenzingRecord | undefined {
    return this.recordsById.get(recordId);
  }

  stats(): RepositoryStats {
    return {
      records: this.recordsById.size,
      indexedNames: this.indexedNames,
    };
  }

  private addRecord(record: SenzingRecord): void {
    this.recordsById.set(record.RECORD_ID, record);
    const seenNormalizedNamesForRecord = new Set<string>();

    for (const name of record.NAMES ?? []) {
      const fullName = name.NAME_FULL?.trim();
      if (!fullName) continue;
      const normalized = normalizeName(fullName);
      if (!normalized || seenNormalizedNamesForRecord.has(normalized)) continue;
      seenNormalizedNamesForRecord.add(normalized);

      const matches = this.nameIndex.get(normalized) ?? [];
      matches.push({ record, matchedName: fullName, matchedNameType: name.NAME_TYPE });
      this.nameIndex.set(normalized, matches);
      this.indexedNames += 1;
    }
  }
}
