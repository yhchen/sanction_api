import { createAccessControl } from './bot/accessControl.js';
import { createBot } from './bot/createBot.js';
import { BotCommandHandler } from './bot/handlers.js';
import { loadConfig } from './config.js';
import { SenzingMemoryRepository } from './data/senzingMemoryRepository.js';
import { TargetsNestedMemoryRepository } from './data/targetsNestedMemoryRepository.js';
import { DebarmentService } from './domain/debarmentService.js';

async function main(): Promise<void> {
  const config = loadConfig();
  console.info('Loading senzing index:', config.senzingPath);
  const senzingRepository = await SenzingMemoryRepository.fromFile(config.senzingPath);
  console.info('Loaded senzing index:', senzingRepository.stats());

  console.info('Loading targets.nested details:', config.targetsNestedPath);
  const targetDetailsRepository = await TargetsNestedMemoryRepository.fromFile(config.targetsNestedPath);
  console.info('Loaded targets.nested details:', targetDetailsRepository.stats());

  const service = new DebarmentService(senzingRepository, targetDetailsRepository, { maxResults: config.maxResults });
  const handler = new BotCommandHandler(service, createAccessControl(config.allowedTelegramUsers), {
    maxMessageChars: config.maxMessageChars,
  });
  const bot = createBot(config.telegramBotToken, handler);

  await bot.launch();
  console.info('Telegram bot started.');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
