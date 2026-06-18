import type { DebarmentService } from '../domain/debarmentService.js';
import type { BotReply } from '../domain/types.js';
import type { AccessControl } from './accessControl.js';
import { formatBasicResults, formatCheckResult, formatFullResults, type FormatterOptions } from './formatters.js';

export class BotCommandHandler {
  constructor(
    private readonly service: DebarmentService,
    private readonly accessControl: AccessControl,
    private readonly formatterOptions: FormatterOptions = {},
  ) {}

  async handleStart(userId: string | number | undefined): Promise<BotReply> {
    if (!this.accessControl.isAllowed(userId)) return textOnly('Unauthorized.');
    return textOnly('Send a complete name to check Debarred status, or use /check, /basic, /full.');
  }

  async handleMessage(rawMessage: string, userId: string | number | undefined): Promise<BotReply> {
    if (!this.accessControl.isAllowed(userId)) return textOnly('Unauthorized.');

    const message = rawMessage.trim();
    if (!message) return textOnly('Send a full name or use /check <name>.');

    if (!message.startsWith('/')) {
      return formatCheckResult(await this.service.check(message), this.formatterOptions);
    }

    const parsed = parseCommand(message);
    if (!parsed) return textOnly('Supported commands: /check <name>, /basic <name>, /full <name>');
    if (!parsed.argument) return textOnly(`Usage: /${parsed.command} <name>`);

    switch (parsed.command) {
      case 'check':
        return formatCheckResult(await this.service.check(parsed.argument), this.formatterOptions);
      case 'basic':
        return formatBasicResults(await this.service.basic(parsed.argument), this.formatterOptions);
      case 'full':
        return formatFullResults(await this.service.full(parsed.argument), this.formatterOptions);
    }
  }

  async handleCallback(callbackData: string, userId: string | number | undefined): Promise<BotReply> {
    if (!this.accessControl.isAllowed(userId)) return textOnly('Unauthorized.');

    const separatorIndex = callbackData.indexOf(':');
    if (separatorIndex < 1) return textOnly('Invalid action.');
    const action = callbackData.slice(0, separatorIndex);
    const recordId = callbackData.slice(separatorIndex + 1).trim();
    if (!recordId) return textOnly('Invalid action.');

    if (action === 'basic') return formatBasicResults(await this.service.basicByRecordId(recordId), this.formatterOptions);
    if (action === 'full') return formatFullResults(await this.service.fullByRecordId(recordId), this.formatterOptions);
    return textOnly('Invalid action.');
  }
}

function parseCommand(message: string): { command: 'check' | 'basic' | 'full'; argument: string } | undefined {
  const match = message.match(/^\/(check|basic|full)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return undefined;
  return {
    command: match[1].toLocaleLowerCase('en-US') as 'check' | 'basic' | 'full',
    argument: (match[2] ?? '').trim(),
  };
}

function textOnly(text: string): BotReply {
  return { text, buttons: [] };
}
