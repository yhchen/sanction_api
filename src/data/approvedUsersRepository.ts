import fs from 'node:fs/promises';
import path from 'node:path';

export interface ApprovalResult {
  userId: string;
  alreadyApproved: boolean;
}

interface ApprovedUsersFile {
  approvedUserIds: string[];
}

export class ApprovedUsersRepository {
  private constructor(
    private readonly filePath: string,
    private readonly approvedUserIds: Set<string>,
  ) {}

  static async fromFile(filePath: string): Promise<ApprovedUsersRepository> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return new ApprovedUsersRepository(filePath, new Set());
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: unknown) {
      throw new Error(`Invalid approved users JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const approvedUserIds = parseApprovedUsersFile(parsed, filePath);
    return new ApprovedUsersRepository(filePath, new Set(approvedUserIds));
  }

  has(userId: string | number | undefined | null): boolean {
    if (userId === undefined || userId === null) return false;
    return this.approvedUserIds.has(String(userId));
  }

  all(): string[] {
    return [...this.approvedUserIds].sort(compareNumericStrings);
  }

  async approve(userId: string | number): Promise<ApprovalResult> {
    const normalizedUserId = String(userId).trim();
    if (!/^\d+$/u.test(normalizedUserId)) {
      throw new Error('Telegram user id must contain only digits.');
    }

    if (this.approvedUserIds.has(normalizedUserId)) {
      await this.write();
      return { userId: normalizedUserId, alreadyApproved: true };
    }

    this.approvedUserIds.add(normalizedUserId);
    await this.write();
    return { userId: normalizedUserId, alreadyApproved: false };
  }

  private async write(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true });
    const snapshot: ApprovedUsersFile = { approvedUserIds: this.all() };
    await fs.writeFile(this.filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  }
}

function parseApprovedUsersFile(parsed: unknown, filePath: string): string[] {
  if (!isObject(parsed) || !Array.isArray(parsed.approvedUserIds)) {
    throw new Error(`Invalid approved users file at ${filePath}: approvedUserIds must be an array of strings.`);
  }

  for (const userId of parsed.approvedUserIds) {
    if (typeof userId !== 'string' || !/^\d+$/u.test(userId)) {
      throw new Error(`Invalid approved users file at ${filePath}: approvedUserIds must contain only numeric strings.`);
    }
  }

  return [...new Set(parsed.approvedUserIds)];
}

function isObject(value: unknown): value is { approvedUserIds?: unknown } {
  return typeof value === 'object' && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function compareNumericStrings(left: string, right: string): number {
  const lengthDelta = left.length - right.length;
  if (lengthDelta !== 0) return lengthDelta;
  return left.localeCompare(right, 'en-US');
}
