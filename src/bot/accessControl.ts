export interface AccessControl {
  readonly isPublic: boolean;
  readonly allowedUserIds: ReadonlySet<string>;
  isAllowed(userId: string | number | undefined | null): boolean;
}

export function createAccessControl(whitelist: string | undefined | null): AccessControl {
  const entries = (whitelist ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const isPublic = entries.includes('*');
  const allowedUserIds = new Set(entries.filter((entry) => entry !== '*'));

  return {
    isPublic,
    allowedUserIds,
    isAllowed(userId) {
      if (isPublic) return true;
      if (userId === undefined || userId === null) return false;
      return allowedUserIds.has(String(userId));
    },
  };
}
