export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

export interface AppConfig {
  telegramBotToken: string;
  allowedTelegramUsers: string;
  adminTelegramUsers: string;
  approvedTelegramUsersPath: string;
  senzingPath: string;
  targetsNestedPath: string;
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
    maxResults: positiveInteger(env.MAX_RESULTS, 5, 'MAX_RESULTS'),
    maxMessageChars: boundedPositiveInteger(env.MAX_MESSAGE_CHARS, 3800, 'MAX_MESSAGE_CHARS', TELEGRAM_MAX_MESSAGE_CHARS),
  };
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
