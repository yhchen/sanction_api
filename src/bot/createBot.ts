import { Telegraf } from 'telegraf';
import type { Context, NarrowedContext } from 'telegraf';
import type { Update } from 'telegraf/types';
import type { BotCommandHandler } from './handlers.js';
import type { BotReply } from '../domain/types.js';

export function createBot(token: string, handler: BotCommandHandler): Telegraf<Context> {
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    await replyToContext(ctx, await handler.handleStart(ctx.from?.id));
  });

  bot.command(['check', 'basic', 'full'], async (ctx) => {
    await replyToContext(ctx, await handler.handleMessage(ctx.message.text, ctx.from?.id));
  });

  bot.on('text', async (ctx) => {
    await replyToContext(ctx, await handler.handleMessage(ctx.message.text, ctx.from?.id));
  });

  bot.action(/^(basic|full):(.+)$/u, async (ctx) => {
    const callbackData = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
    await ctx.answerCbQuery();
    await replyToContext(ctx, await handler.handleCallback(callbackData, ctx.from?.id));
  });

  return bot;
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
}
