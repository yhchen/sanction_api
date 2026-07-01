import fs from 'node:fs';
import readline from 'node:readline';

export interface SecuritiesCsvRecord {
  caption: string;
  lei: string[];
  permId: string[];
  isins: string[];
  ric: string[];
  countries: string[];
  sanctioned: boolean;
  eo14071: boolean;
  public: boolean;
  id: string;
  url: string;
  datasets: string[];
  riskDatasets: string[];
  aliases: string[];
  referents: string[];
}

export async function readSecuritiesCsvFile(
  filePath: string,
  onRecord: (record: SecuritiesCsvRecord, lineNumber: number) => void | Promise<void>,
): Promise<void> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header: string[] | undefined;
  let lineNumber = 0;

  for await (const line of lines) {
    lineNumber += 1;
    if (lineNumber === 1) {
      header = parseCsvLine(line).map((value) => value.trim());
      continue;
    }
    if (!line.trim()) continue;
    if (!header) throw new Error('securities.csv missing header row.');
    await onRecord(toSecuritiesRecord(header, parseCsvLine(line), lineNumber), lineNumber);
  }
}

export function splitOpenSanctionsCsvList(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(';').map((item) => item.trim()).filter(Boolean))];
}

function toSecuritiesRecord(header: string[], values: string[], lineNumber: number): SecuritiesCsvRecord {
  const row = Object.fromEntries(header.map((name, index) => [name, values[index] ?? '']));
  const id = clean(row.id);
  const caption = clean(row.caption);
  if (!id) throw new Error(`securities.csv row missing id at line ${lineNumber}`);
  if (!caption) throw new Error(`securities.csv row missing caption at line ${lineNumber}`);

  return {
    caption,
    lei: splitOpenSanctionsCsvList(row.lei),
    permId: splitOpenSanctionsCsvList(row.perm_id),
    isins: splitOpenSanctionsCsvList(row.isins),
    ric: splitOpenSanctionsCsvList(row.ric),
    countries: splitOpenSanctionsCsvList(row.countries),
    sanctioned: parseBoolean(row.sanctioned, 'sanctioned', lineNumber),
    eo14071: parseBoolean(row.eo_14071, 'eo_14071', lineNumber),
    public: parseBoolean(row.public, 'public', lineNumber),
    id,
    url: clean(row.url),
    datasets: splitOpenSanctionsCsvList(row.datasets),
    riskDatasets: splitOpenSanctionsCsvList(row.risk_datasets),
    aliases: splitOpenSanctionsCsvList(row.aliases),
    referents: splitOpenSanctionsCsvList(row.referents),
  };
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += char;
    }
  }

  values.push(value);
  return values;
}

function parseBoolean(value: string | undefined, field: string, lineNumber: number): boolean {
  const normalized = clean(value).toLocaleLowerCase('en-US');
  if (normalized === 't') return true;
  if (normalized === 'f') return false;
  throw new Error(`securities.csv ${field} must be t or f at line ${lineNumber}`);
}

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}
