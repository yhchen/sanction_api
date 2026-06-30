export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

export interface AppConfig {
  telegramBotToken: string;
  allowedTelegramUsers: string;
  adminTelegramUsers: string;
  approvedTelegramUsersPath: string;
  senzingPath: string;
  targetsNestedPath: string;
  sqlitePath: string;
  refreshMetadataPath: string;
  refreshScheduleTime: string;
  maxResults: number;
  maxMessageChars: number;
}

export interface LoadConfigOptions {
  requireToken?: boolean;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: LoadConfigOptions = { requireToken: true },
): AppConfig {
  const requireToken = options.requireToken ?? true;
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  if (requireToken && !telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required.');
  }

  return {
    telegramBotToken,
    allowedTelegramUsers: env.ALLOWED_TELEGRAM_USERS?.trim() ?? '',
    adminTelegramUsers: env.ADMIN_TELEGRAM_USERS?.trim() ?? '',
    approvedTelegramUsersPath: env.APPROVED_TELEGRAM_USERS_PATH?.trim() || './approved-users.json',
    senzingPath: env.SENZING_PATH?.trim() || './senzing.json',
    targetsNestedPath: env.TARGETS_NESTED_PATH?.trim() || './targets.nested.json',
    sqlitePath: env.SQLITE_PATH?.trim() || './sanction.sqlite',
    refreshMetadataPath: env.REFRESH_METADATA_PATH?.trim() || './refresh-metadata.json',
    refreshScheduleTime: scheduleTime(env.REFRESH_SCHEDULE_TIME, '05:00', 'REFRESH_SCHEDULE_TIME'),
    maxResults: positiveInteger(env.MAX_RESULTS, 5, 'MAX_RESULTS'),
    maxMessageChars: boundedPositiveInteger(env.MAX_MESSAGE_CHARS, 3800, 'MAX_MESSAGE_CHARS', TELEGRAM_MAX_MESSAGE_CHARS),
  };
}

function scheduleTime(rawValue: string | undefined, defaultValue: string, envName: string): string {
  const value = rawValue?.trim() || defaultValue;
  if (!/^\d{2}:\d{2}$/u.test(value)) throw new Error(`${envName} must use HH:MM format.`);
  const [hours, minutes] = value.split(':').map(Number);
  if (hours > 23 || minutes > 59) throw new Error(`${envName} must use HH:MM format.`);
  return value;
}

function positiveInteger(rawValue: string | undefined, defaultValue: number, envName: string): number {
  if (rawValue === undefined || rawValue.trim() === '') return defaultValue;
  const trimmed = rawValue.trim();
  if (!/^\d+$/u.test(trimmed)) throw new Error(`${envName} must be a positive integer.`);
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${envName} must be a positive integer.`);
  return parsed;
}

function boundedPositiveInteger(rawValue: string | undefined, defaultValue: number, envName: string, maxValue: number): number {
  const parsed = positiveInteger(rawValue, defaultValue, envName);
  if (parsed > maxValue) throw new Error(`${envName} must be <= ${maxValue}.`);
  return parsed;
}
