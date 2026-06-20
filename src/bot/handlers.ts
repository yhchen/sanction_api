import type { DebarmentService } from '../domain/debarmentService.js';
import type { BotReply } from '../domain/types.js';
import type { AccessControl } from './accessControl.js';
import { formatBasicResults, formatCheckResult, formatFullResults, type FormatterOptions } from './formatters.js';

export interface TelegramUserProfile {
  id: string | number;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export interface BotMessageMetadata {
  from?: TelegramUserProfile;
  replyToText?: string;
}

export interface ApprovedUsersApprover {
  approve(userId: string | number): Promise<{ userId: string; alreadyApproved: boolean }>;
}

export class BotCommandHandler {
  private readonly approvedUsers?: ApprovedUsersApprover;
  private readonly formatterOptions: FormatterOptions;

  constructor(
    private readonly service: DebarmentService,
    private readonly accessControl: AccessControl,
    approvedUsersOrFormatterOptions: ApprovedUsersApprover | FormatterOptions = {},
    formatterOptions: FormatterOptions = {},
  ) {
    if (isApprovedUsersApprover(approvedUsersOrFormatterOptions)) {
      this.approvedUsers = approvedUsersOrFormatterOptions;
      this.formatterOptions = formatterOptions;
    } else {
      this.formatterOptions = approvedUsersOrFormatterOptions;
    }
  }

  async handleStart(userId: string | number | undefined): Promise<BotReply> {
    if (!this.accessControl.isAllowed(userId)) {
      if (!this.approvedUsers) return textOnly('Unauthorized.');
      const suffix = userId === undefined
        ? 'Send /request to ask an admin for access.'
        : `Your Telegram user id is ${userId}. Send /request to ask an admin for access.`;
      return textOnly(`Unauthorized. ${suffix}`);
    }

    const adminSuffix = this.accessControl.isAdmin(userId) ? ' Admin commands: /approve <telegram_user_id>.' : '';
    return textOnly(`Send a complete name to check Debarred status, or use /check, /basic, /full.${adminSuffix}`);
  }

  async handleMessage(
    rawMessage: string,
    userId: string | number | undefined,
    metadata: BotMessageMetadata = {},
  ): Promise<BotReply> {
    const message = rawMessage.trim();
    if (!message) return textOnly('Send a full name or use /check <name>.');

    const parsed = message.startsWith('/') ? parseCommand(message) : undefined;
    if (parsed?.command === 'request') return this.handleRequest(userId, metadata);
    if (parsed?.command === 'approve') return this.handleApprove(userId, parsed.argument, metadata.replyToText);

    if (!this.accessControl.isAllowed(userId)) {
      return textOnly(this.approvedUsers ? 'Unauthorized. Send /request to ask an admin for access.' : 'Unauthorized.');
    }

    if (!message.startsWith('/')) {
      return formatCheckResult(await this.service.check(message), this.formatterOptions);
    }

    if (!parsed) return textOnly(this.approvedUsers ? 'Supported commands: /check <name>, /basic <name>, /full <name>, /request' : 'Supported commands: /check <name>, /basic <name>, /full <name>');
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

  private handleRequest(userId: string | number | undefined, metadata: BotMessageMetadata): BotReply {
    if (this.accessControl.isAllowed(userId)) return textOnly('You already have access. Send a complete name or use /check <name>.');
    if (userId === undefined) return textOnly('Cannot request access because Telegram did not provide your user id.');

    const adminUserIds = [...this.accessControl.adminUserIds];
    if (adminUserIds.length === 0) return textOnly('No admins are configured. Ask the bot operator to set ADMIN_TELEGRAM_USERS.');

    const requester = metadata.from ?? { id: userId };
    const notificationText = formatAccessRequestNotification(requester, userId);
    return {
      text: 'Access request received. Admins have been notified if reachable.',
      buttons: [],
      notifications: adminUserIds.map((adminUserId) => ({ chatId: adminUserId, text: notificationText })),
    };
  }

  private async handleApprove(
    userId: string | number | undefined,
    argument: string,
    replyToText: string | undefined,
  ): Promise<BotReply> {
    if (!this.accessControl.isAdmin(userId)) return textOnly('Unauthorized.');
    if (!this.approvedUsers) return textOnly('Approval storage is not configured.');

    const targetUserId = argument || extractRequesterId(replyToText);
    if (!targetUserId) return textOnly('Usage: /approve <telegram_user_id> or reply /approve to an access request.');
    if (!/^\d+$/u.test(targetUserId)) return textOnly('Invalid Telegram user id.');

    const result = await this.approvedUsers.approve(targetUserId);
    if (result.alreadyApproved) return textOnly(`User ${result.userId} is already approved.`);

    return {
      text: `Approved user ${result.userId}.`,
      buttons: [],
      notifications: [{ chatId: result.userId, text: 'Access approved. You can now send a complete name or use /check <name>.' }],
    };
  }
}

type SupportedCommand = 'check' | 'basic' | 'full' | 'request' | 'approve';

function parseCommand(message: string): { command: SupportedCommand; argument: string } | undefined {
  const match = message.match(/^\/(check|basic|full|request|approve)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return undefined;
  return {
    command: match[1].toLocaleLowerCase('en-US') as SupportedCommand,
    argument: (match[2] ?? '').trim(),
  };
}

function formatAccessRequestNotification(requester: TelegramUserProfile, fallbackUserId: string | number): string {
  const userId = requester.id ?? fallbackUserId;
  const usernameLine = requester.username ? `\nUsername: @${requester.username}` : '';
  const fullName = [requester.firstName, requester.lastName].filter(Boolean).join(' ');
  const nameLine = fullName ? `\nName: ${fullName}` : '';
  return `Access request\nUser ID: ${userId}${usernameLine}${nameLine}\n\nReply to this message with /approve or send /approve ${userId}.`;
}

function extractRequesterId(replyToText: string | undefined): string {
  const match = replyToText?.match(/^User ID:\s*(\d+)$/im);
  return match?.[1] ?? '';
}

function isApprovedUsersApprover(value: ApprovedUsersApprover | FormatterOptions): value is ApprovedUsersApprover {
  return typeof (value as ApprovedUsersApprover).approve === 'function';
}

function textOnly(text: string): BotReply {
  return { text, buttons: [] };
}
