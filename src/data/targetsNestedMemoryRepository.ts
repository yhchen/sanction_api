import type { RepositoryStats, SanctionDetail, TargetDetailsRepository, TargetNestedRecord, TargetNestedSanction } from '../domain/types.js';
import { readJsonlFile } from './jsonl.js';

export class TargetsNestedMemoryRepository implements TargetDetailsRepository {
  private readonly sanctionsById = new Map<string, SanctionDetail[]>();

  static async fromFile(filePath: string): Promise<TargetsNestedMemoryRepository> {
    const repository = new TargetsNestedMemoryRepository();
    await readJsonlFile<TargetNestedRecord>(filePath, (record, lineNumber) => {
      if (!record.id) {
        throw new Error(`targets.nested record missing id at line ${lineNumber}`);
      }
      repository.addRecord(record);
    });
    return repository;
  }

  static fromRecords(records: TargetNestedRecord[]): TargetsNestedMemoryRepository {
    const repository = new TargetsNestedMemoryRepository();
    for (const record of records) repository.addRecord(record);
    return repository;
  }

  findSanctionsByRecordId(recordId: string): SanctionDetail[] {
    return [...(this.sanctionsById.get(recordId) ?? [])];
  }

  findSecuritiesByRecordId(_recordId: string): undefined {
    return undefined;
  }

  stats(): RepositoryStats {
    return { records: this.sanctionsById.size };
  }

  private addRecord(record: TargetNestedRecord): void {
    this.sanctionsById.set(record.id, (record.properties?.sanctions ?? []).map(toSanctionDetail));
  }
}

function toSanctionDetail(sanction: TargetNestedSanction): SanctionDetail {
  const properties = sanction.properties ?? {};
  return {
    id: sanction.id,
    caption: sanction.caption,
    authority: cleanValues(properties.authority),
    status: cleanValues(properties.status),
    listingDate: cleanValues(properties.listingDate),
    startDate: cleanValues(properties.startDate),
    program: cleanValues(properties.program),
    provisions: cleanValues(properties.provisions),
    sourceUrl: cleanValues(properties.sourceUrl),
    summary: cleanValues(properties.summary),
  };
}

function cleanValues(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}
