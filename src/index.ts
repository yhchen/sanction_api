import { createAccessControl } from './bot/accessControl.js';
import { createBot, startBot } from './bot/createBot.js';
import { BotCommandHandler } from './bot/handlers.js';
import { loadConfig } from './config.js';
import { ApprovedUsersRepository } from './data/approvedUsersRepository.js';
import { createCombinedRefreshRunner } from './data/combinedRefreshRunner.js';
import { DataRefreshService, scheduleDailyRefresh } from './data/dataRefreshService.js';
import { SecuritiesRefreshService } from './data/securitiesRefreshService.js';
import { bootstrapSqliteRepositories } from './data/sqliteBootstrap.js';
import type { BootstrapSqliteResult } from './data/sqliteBootstrap.js';
import { ActiveDebarmentRepositories, DebarmentService } from './domain/debarmentService.js';
import { ActiveSecuritiesRepositories, SecuritiesService } from './domain/securitiesService.js';
import { SanctionedLookupService } from './domain/sanctionedLookupService.js';

async function main(): Promise<void> {
  const config = loadConfig();
  let bootstrap: BootstrapSqliteResult | undefined;
  let securitiesBootstrap: BootstrapSqliteResult | undefined;
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
      minFuzzyScore: config.minFuzzyScore,
    });
    console.info('Loaded SQLite senzing index:', bootstrap.senzingRepository.stats());
    console.info('Loaded SQLite targets.nested details:', bootstrap.targetDetailsRepository.stats());

    console.info('Bootstrapping securities SQLite data:', {
      sqlitePath: config.securitiesSqlitePath,
      senzingPath: config.securitiesSenzingPath,
      targetsNestedPath: config.securitiesTargetsNestedPath,
    });
    securitiesBootstrap = await bootstrapSqliteRepositories({
      senzingPath: config.securitiesSenzingPath,
      targetsNestedPath: config.securitiesTargetsNestedPath,
      sqlitePath: config.securitiesSqlitePath,
      minFuzzyScore: config.minFuzzyScore,
      isIncludedRecord: () => true,
    });
    console.info('Loaded securities SQLite senzing index:', securitiesBootstrap.senzingRepository.stats());
    console.info('Loaded securities SQLite targets.nested details:', securitiesBootstrap.targetDetailsRepository.stats());

    console.info('Loading approved Telegram users:', config.approvedTelegramUsersPath);
    const approvedUsersRepository = await ApprovedUsersRepository.fromFile(config.approvedTelegramUsersPath);
    console.info('Loaded approved Telegram users:', { users: approvedUsersRepository.all().length });

    const activeRepositories = new ActiveDebarmentRepositories(bootstrap.senzingRepository, bootstrap.targetDetailsRepository);
    const debarmentService = new DebarmentService(activeRepositories, { maxResults: config.maxResults });

    const activeSecuritiesRepositories = new ActiveSecuritiesRepositories(
      securitiesBootstrap.senzingRepository,
      securitiesBootstrap.targetDetailsRepository,
    );
    const securitiesService = new SecuritiesService(activeSecuritiesRepositories, { maxResults: config.maxResults });

    const sanctionedLookupService = new SanctionedLookupService(debarmentService, securitiesService, { maxResults: config.maxResults });

    const accessControl = createAccessControl(config.allowedTelegramUsers, {
      adminTelegramUsers: config.adminTelegramUsers,
      approvedUsers: approvedUsersRepository,
    });
    const dataRefreshService = new DataRefreshService({
      senzingPath: config.senzingPath,
      targetsNestedPath: config.targetsNestedPath,
      sqlitePath: config.sqlitePath,
      refreshMetadataPath: config.refreshMetadataPath,
      activeRepositories,
      minFuzzyScore: config.minFuzzyScore,
    });
    const securitiesRefreshService = new SecuritiesRefreshService({
      senzingPath: config.securitiesSenzingPath,
      targetsNestedPath: config.securitiesTargetsNestedPath,
      sqlitePath: config.securitiesSqlitePath,
      refreshMetadataPath: config.securitiesRefreshMetadataPath,
      activeRepositories: activeSecuritiesRepositories,
      minFuzzyScore: config.minFuzzyScore,
    });
    const combinedRefreshRunner = createCombinedRefreshRunner([dataRefreshService, securitiesRefreshService]);

    const handler = new BotCommandHandler(sanctionedLookupService, accessControl, approvedUsersRepository, {
      maxMessageChars: config.maxMessageChars,
      telegramBotUsername: config.telegramBotUsername,
    }, combinedRefreshRunner);
    const bot = createBot(config.telegramBotToken, handler);

    await startBot(bot);
    const refreshSchedule = scheduleDailyRefresh(dataRefreshService, { timeOfDay: config.refreshScheduleTime });
    const securitiesRefreshSchedule = scheduleDailyRefresh(securitiesRefreshService, { timeOfDay: config.refreshScheduleTime });
    console.info('Telegram bot started.');
    if (bootstrap.shouldAutoRefresh) {
      console.info('Startup data files were empty; starting initial OpenSanctions debarment refresh.');
      void dataRefreshService.refreshNow().then((result) => {
        if (result.status === 'failed') {
          console.error('Startup debarment data refresh failed:', result.message);
          return;
        }
        console.info('Startup debarment data refresh completed:', result);
      }).catch((error: unknown) => {
        console.error('Startup debarment data refresh failed:', error);
      });
    }
    if (securitiesBootstrap.shouldAutoRefresh) {
      console.info('Startup data files were empty; starting initial OpenSanctions securities refresh.');
      void securitiesRefreshService.refreshNow().then((result) => {
        if (result.status === 'failed') {
          console.error('Startup securities data refresh failed:', result.message);
          return;
        }
        console.info('Startup securities data refresh completed:', result);
      }).catch((error: unknown) => {
        console.error('Startup securities data refresh failed:', error);
      });
    }

    let shuttingDown = false;
    const shutdown = (signal: 'SIGINT' | 'SIGTERM') => {
      if (shuttingDown) return;
      shuttingDown = true;
      refreshSchedule.cancel();
      securitiesRefreshSchedule.cancel();
      bot.stop(signal);
      closeBootstrap(bootstrap);
      closeBootstrap(securitiesBootstrap);
    };

    process.once('SIGINT', () => {
      shutdown('SIGINT');
    });
    process.once('SIGTERM', () => {
      shutdown('SIGTERM');
    });
  } catch (error) {
    closeBootstrap(bootstrap);
    closeBootstrap(securitiesBootstrap);
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
