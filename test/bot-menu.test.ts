import { describe, expect, test, vi } from 'vitest';
import { registerBotCommands, replyOptions, startBot, VISIBLE_BOT_COMMANDS } from '../src/bot/createBot.js';

describe('Telegram command menu registration', () => {
  test('registers only the visible player command menu entries', async () => {
    const bot = {
      telegram: {
        setMyCommands: vi.fn(async () => true),
      },
    };

    await registerBotCommands(bot);

    expect(bot.telegram.setMyCommands).toHaveBeenCalledWith(VISIBLE_BOT_COMMANDS);
    expect(VISIBLE_BOT_COMMANDS.map((command) => command.command)).toEqual(['start', 'check', 'search', 'basic', 'full']);
    expect(VISIBLE_BOT_COMMANDS.map((command) => command.command)).not.toContain('request');
    expect(VISIBLE_BOT_COMMANDS.map((command) => command.command)).not.toContain('approve');
  });

  test('propagates command menu registration failures', async () => {
    const bot = {
      telegram: {
        setMyCommands: vi.fn(async () => {
          throw new Error('registration failed');
        }),
      },
    };

    await expect(registerBotCommands(bot)).rejects.toThrow('registration failed');
  });

  test('does not launch when command menu registration fails', async () => {
    const events: string[] = [];
    const bot = {
      telegram: {
        setMyCommands: vi.fn(async () => {
          events.push('setMyCommands');
          throw new Error('registration failed');
        }),
      },
      launch: vi.fn(async () => {
        events.push('launch');
      }),
    };

    await expect(startBot(bot)).rejects.toThrow('registration failed');

    expect(events).toEqual(['setMyCommands']);
    expect(bot.launch).not.toHaveBeenCalled();
  });

  test('builds Telegram reply options for parse mode without buttons', () => {
    expect(replyOptions({ text: 'hello', buttons: [], parseMode: 'HTML' })).toEqual({
      parse_mode: 'HTML',
    });
  });
});
