import { Telegraf } from 'telegraf';
import type { Context, NarrowedContext } from 'telegraf';
import type { BotCommand, Update } from 'telegraf/types';
import type { BotCommandHandler, BotMessageMetadata } from './handlers.js';
import type { BotReply } from '../domain/types.js';

export const VISIBLE_BOT_COMMANDS: BotCommand[] = [
  { command: 'start', description: '显示帮助和访问状态' },
  { command: 'check', description: '查询完整名称的 Debarred 状态' },
  { command: 'basic', description: '显示基础记录信息' },
  { command: 'full', description: '显示完整制裁详情' },
];

export interface BotCommandRegistrar {
  telegram: {
    setMyCommands(commands: BotCommand[]): Promise<unknown>;
  };
}

export interface LaunchableBot extends BotCommandRegistrar {
  launch(): Promise<unknown>;
}

export function createBot(token: string, handler: BotCommandHandler): Telegraf<Context> {
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    await replyToContext(ctx, await handler.handleStart(ctx.from?.id));
  });

  bot.command(['check', 'basic', 'full', 'request', 'approve', 'cancel'], async (ctx) => {
    await replyToContext(ctx, await handler.handleMessage(ctx.message.text, ctx.from?.id, metadataFromContext(ctx)));
  });

  bot.on('text', async (ctx) => {
    await replyToContext(ctx, await handler.handleMessage(ctx.message.text, ctx.from?.id, metadataFromContext(ctx)));
  });

  bot.action(/^(basic|full):(.+)$/u, async (ctx) => {
    const callbackData = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
    await ctx.answerCbQuery();
    await replyToContext(ctx, await handler.handleCallback(callbackData, ctx.from?.id));
  });

  return bot;
}

export async function registerBotCommands(bot: BotCommandRegistrar): Promise<void> {
  await bot.telegram.setMyCommands(VISIBLE_BOT_COMMANDS);
}

export async function startBot(bot: LaunchableBot): Promise<void> {
  await registerBotCommands(bot);
  await bot.launch();
}

function metadataFromContext(ctx: Context | NarrowedContext<Context, Update>): BotMessageMetadata {
  const from = ctx.from
    ? {
        id: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
      }
    : undefined;

  const message = 'message' in ctx && ctx.message && 'reply_to_message' in ctx.message ? ctx.message : undefined;
  const replyToMessage = message?.reply_to_message;
  const replyToText = replyToMessage && 'text' in replyToMessage ? replyToMessage.text : undefined;

  return { from, replyToText };
}

async function replyToContext(ctx: Context | NarrowedContext<Context, Update>, reply: BotReply): Promise<void> {
  const extra = reply.buttons.length > 0
    ? {
        reply_markup: {
          inline_keyboard: reply.buttons.map((row) =>
            row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
          ),
        },
      }
    : undefined;

  await ctx.reply(reply.text, extra);

  for (const notification of reply.notifications ?? []) {
    try {
      await ctx.telegram.sendMessage(notification.chatId, notification.text);
    } catch (error: unknown) {
      console.warn(`Failed to send Telegram notification to ${notification.chatId}:`, error);
    }
  }
}
