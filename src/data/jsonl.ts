import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline/promises';

export async function readJsonlFile<T>(
  filePath: string,
  onRecord: (record: T, lineNumber: number) => void | Promise<void>,
): Promise<number> {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const reader = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  let recordCount = 0;

  try {
    for await (const line of reader) {
      lineNumber += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: T;
      try {
        parsed = JSON.parse(trimmed) as T;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSONL in ${filePath} at line ${lineNumber}: ${reason}`);
      }

      await onRecord(parsed, lineNumber);
      recordCount += 1;
    }
  } finally {
    reader.close();
  }

  return recordCount;
}
