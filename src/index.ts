import { createAccessControl } from './bot/accessControl.js';
import { createBot, startBot } from './bot/createBot.js';
import { BotCommandHandler } from './bot/handlers.js';
import { loadConfig } from './config.js';
import { ApprovedUsersRepository } from './data/approvedUsersRepository.js';
import { DataRefreshService, scheduleDailyRefresh } from './data/dataRefreshService.js';
import { SenzingMemoryRepository } from './data/senzingMemoryRepository.js';
import { ensureDataFilesForStartup } from './data/startupDataService.js';
import { TargetsNestedMemoryRepository } from './data/targetsNestedMemoryRepository.js';
import { ActiveDebarmentRepositories, DebarmentService } from './domain/debarmentService.js';

async function main(): Promise<void> {
  const config = loadConfig();
  await ensureDataFilesForStartup({
    senzingPath: config.senzingPath,
    targetsNestedPath: config.targetsNestedPath,
    refreshMetadataPath: config.refreshMetadataPath,
  });

  console.info('Loading senzing index:', config.senzingPath);
  const senzingRepository = await SenzingMemoryRepository.fromFile(config.senzingPath);
  console.info('Loaded senzing index:', senzingRepository.stats());

  console.info('Loading targets.nested details:', config.targetsNestedPath);
  const targetDetailsRepository = await TargetsNestedMemoryRepository.fromFile(config.targetsNestedPath);
  console.info('Loaded targets.nested details:', targetDetailsRepository.stats());

  console.info('Loading approved Telegram users:', config.approvedTelegramUsersPath);
  const approvedUsersRepository = await ApprovedUsersRepository.fromFile(config.approvedTelegramUsersPath);
  console.info('Loaded approved Telegram users:', { users: approvedUsersRepository.all().length });

  const activeRepositories = new ActiveDebarmentRepositories(senzingRepository, targetDetailsRepository);
  const service = new DebarmentService(activeRepositories, { maxResults: config.maxResults });
  const accessControl = createAccessControl(config.allowedTelegramUsers, {
    adminTelegramUsers: config.adminTelegramUsers,
    approvedUsers: approvedUsersRepository,
  });
  const dataRefreshService = new DataRefreshService({
    senzingPath: config.senzingPath,
    targetsNestedPath: config.targetsNestedPath,
    refreshMetadataPath: config.refreshMetadataPath,
    activeRepositories,
  });
  const handler = new BotCommandHandler(service, accessControl, approvedUsersRepository, {
    maxMessageChars: config.maxMessageChars,
    telegramBotUsername: config.telegramBotUsername,
  }, dataRefreshService);
  const bot = createBot(config.telegramBotToken, handler);

  await startBot(bot);
  const refreshSchedule = scheduleDailyRefresh(dataRefreshService, { timeOfDay: config.refreshScheduleTime });
  console.info('Telegram bot started.');

  process.once('SIGINT', () => {
    refreshSchedule.cancel();
    bot.stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    refreshSchedule.cancel();
    bot.stop('SIGTERM');
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
