import { createAccessControl } from './bot/accessControl.js';
import { createBot, startBot } from './bot/createBot.js';
import { BotCommandHandler } from './bot/handlers.js';
import { loadConfig } from './config.js';
import { ApprovedUsersRepository } from './data/approvedUsersRepository.js';
import { DataRefreshService, scheduleDailyRefresh } from './data/dataRefreshService.js';
import { bootstrapSqliteRepositories } from './data/sqliteBootstrap.js';
import type { BootstrapSqliteResult } from './data/sqliteBootstrap.js';
import { ActiveDebarmentRepositories, DebarmentService } from './domain/debarmentService.js';

async function main(): Promise<void> {
  const config = loadConfig();
  let bootstrap: BootstrapSqliteResult | undefined;
  try {
    console.info('Bootstrapping SQLite data:', {
      sqlitePath: config.sqlitePath,
      senzingPath: config.senzingPath,
      targetsNestedPath: config.targetsNestedPath,
    });
    bootstrap = await bootstrapSqliteRepositories({
      senzingPath: config.senzingPath,
      targetsNestedPath: config.targetsNestedPath,
      sqlitePath: config.sqlitePath,
    });
    console.info('Loaded SQLite senzing index:', bootstrap.senzingRepository.stats());
    console.info('Loaded SQLite targets.nested details:', bootstrap.targetDetailsRepository.stats());

    console.info('Loading approved Telegram users:', config.approvedTelegramUsersPath);
    const approvedUsersRepository = await ApprovedUsersRepository.fromFile(config.approvedTelegramUsersPath);
    console.info('Loaded approved Telegram users:', { users: approvedUsersRepository.all().length });

    const activeRepositories = new ActiveDebarmentRepositories(bootstrap.senzingRepository, bootstrap.targetDetailsRepository);
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
    }, dataRefreshService);
    const bot = createBot(config.telegramBotToken, handler);

    await startBot(bot);
    const refreshSchedule = scheduleDailyRefresh(dataRefreshService, { timeOfDay: config.refreshScheduleTime });
    console.info('Telegram bot started.');
    if (bootstrap.shouldAutoRefresh) {
      console.info('Startup data files were empty; starting initial OpenSanctions refresh.');
      void dataRefreshService.refreshNow().then((result) => {
        if (result.status === 'failed') {
          console.error('Startup data refresh failed:', result.message);
          return;
        }
        console.info('Startup data refresh completed:', result);
      }).catch((error: unknown) => {
        console.error('Startup data refresh failed:', error);
      });
    }

    let shuttingDown = false;
    const shutdown = (signal: 'SIGINT' | 'SIGTERM') => {
      if (shuttingDown) return;
      shuttingDown = true;
      refreshSchedule.cancel();
      bot.stop(signal);
      closeBootstrap(bootstrap);
    };

    process.once('SIGINT', () => {
      shutdown('SIGINT');
    });
    process.once('SIGTERM', () => {
      shutdown('SIGTERM');
    });
  } catch (error) {
    closeBootstrap(bootstrap);
    throw error;
  }
}

function closeBootstrap(bootstrap: BootstrapSqliteResult | undefined): void {
  if (!bootstrap) return;
  try {
    bootstrap.close();
  } catch (error: unknown) {
    console.error('Failed to close SQLite repositories:', error);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
