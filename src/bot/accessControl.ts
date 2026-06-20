export interface ApprovedUsersLookup {
  has(userId: string | number | undefined | null): boolean;
}

export interface AccessControlOptions {
  adminTelegramUsers?: string | undefined | null;
  approvedUsers?: ApprovedUsersLookup;
}

export interface AccessControl {
  readonly isPublic: boolean;
  readonly allowedUserIds: ReadonlySet<string>;
  readonly adminUserIds: ReadonlySet<string>;
  isAllowed(userId: string | number | undefined | null): boolean;
  isAdmin(userId: string | number | undefined | null): boolean;
}

export function createAccessControl(
  whitelist: string | undefined | null,
  options: AccessControlOptions = {},
): AccessControl {
  const entries = parseTelegramUserList(whitelist);
  const isPublic = entries.includes('*');
  const allowedUserIds = new Set(entries.filter((entry) => entry !== '*'));
  const adminUserIds = new Set(parseTelegramUserList(options.adminTelegramUsers).filter((entry) => entry !== '*'));
  const approvedUsers = options.approvedUsers;

  return {
    isPublic,
    allowedUserIds,
    adminUserIds,
    isAllowed(userId) {
      if (isPublic) return true;
      const normalizedUserId = normalizeUserId(userId);
      if (!normalizedUserId) return false;
      return allowedUserIds.has(normalizedUserId) || adminUserIds.has(normalizedUserId) || approvedUsers?.has(normalizedUserId) === true;
    },
    isAdmin(userId) {
      const normalizedUserId = normalizeUserId(userId);
      if (!normalizedUserId) return false;
      return adminUserIds.has(normalizedUserId);
    },
  };
}

function parseTelegramUserList(rawList: string | undefined | null): string[] {
  return (rawList ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeUserId(userId: string | number | undefined | null): string | undefined {
  if (userId === undefined || userId === null) return undefined;
  return String(userId);
}
