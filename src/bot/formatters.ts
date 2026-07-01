import type { BotReply, DebarmentCandidateSearchResult, DebarmentMatch, DebarmentQueryResult, ReplyButton, SanctionDetail } from '../domain/types.js';

export interface FormatterOptions {
  maxMessageChars?: number;
  telegramBotUsername?: string;
}

const DEFAULT_MAX_MESSAGE_CHARS = 3800;
const NO_DATA_FOUND = 'No Data Found!';
const EMPTY_DATA_EXACT = 'Local debarment data is not loaded yet. Data refresh may still be running; try again after the update completes.';
const EMPTY_DATA_SEARCH = 'Local debarment data is not loaded yet, so candidate search is unavailable. Try again after the update completes.';

export function formatCheckResult(result: DebarmentQueryResult, options: FormatterOptions = {}): BotReply {
  if (!result.found) return reply(result.dataStatus === 'empty' ? EMPTY_DATA_EXACT : NO_DATA_FOUND);

  const lines = ['Debarred'];
  appendCapNotice(lines, result);
  if (result.matches.length > 1) {
    lines.push('', 'Matches:');
    result.matches.forEach((match, index) => {
      lines.push(`${index + 1}. ${match.basic.primaryName} (${match.basic.recordId})`);
      if (match.basic.matchedName !== match.basic.primaryName) lines.push(`   Matched Name: ${match.basic.matchedName}`);
    });
  } else if (result.matches[0]) {
    const match = result.matches[0];
    lines.push('', `Name: ${match.basic.primaryName}`);
    if (match.basic.matchedName !== match.basic.primaryName) lines.push(`Matched Name: ${match.basic.matchedName}`);
  }

  return {
    text: truncateText(lines.join('\n'), options.maxMessageChars),
    buttons: actionButtons(result.matches),
  };
}

export function formatBasicResults(result: DebarmentQueryResult, options: FormatterOptions = {}): BotReply {
  if (!result.found) return reply(result.dataStatus === 'empty' ? EMPTY_DATA_EXACT : NO_DATA_FOUND);
  const lines: string[] = [];
  appendCapNotice(lines, result);
  result.matches.forEach((match, index) => {
    if (index > 0) lines.push('');
    lines.push(...basicSection(match, result.matches.length > 1 ? index + 1 : undefined));
  });
  return reply(truncateText(lines.join('\n'), options.maxMessageChars));
}

export function formatFullResults(result: DebarmentQueryResult, options: FormatterOptions = {}): BotReply {
  if (!result.found) return reply(result.dataStatus === 'empty' ? EMPTY_DATA_EXACT : NO_DATA_FOUND);
  const lines: string[] = [];
  appendCapNotice(lines, result);
  result.matches.forEach((match, index) => {
    if (index > 0) lines.push('');
    lines.push(...basicSection(match, result.matches.length > 1 ? index + 1 : undefined));
    lines.push('', 'Sanctions Details');

    const sanctions = match.sanctions;
    if (sanctions.length === 0) {
      lines.push('- No nested sanctions details found in targets.nested.json.');
    } else {
      sanctions.forEach((sanction, sanctionIndex) => {
        lines.push(...sanctionSection(sanction, sanctionIndex + 1));
      });
    }
  });
  return reply(truncateText(lines.join('\n'), options.maxMessageChars));
}

export function formatFuzzySearchResult(result: DebarmentCandidateSearchResult, options: FormatterOptions = {}): BotReply {
  if (!result.found) return reply(result.dataStatus === 'empty' ? EMPTY_DATA_SEARCH : 'No close name candidates found. Try a more complete name.');

  const lines = ['Possible matches'];
  if (result.truncated) lines.push(`Showing ${result.candidates.length} of ${result.totalCandidates} candidates. Refine your search if needed.`);
  const hasFullLinks = Boolean(options.telegramBotUsername?.trim());
  const fullLinkInstruction = hasFullLinks
    ? 'These are fuzzy name candidates, not a Debarred verdict. Tap Full to view sanctions details for a candidate.'
    : 'These are fuzzy name candidates, not a Debarred verdict. Use /full with the complete name for exact lookup.';
  lines.push('', fullLinkInstruction);

  result.candidates.forEach((candidate, index) => {
    const fullLink = fullDeepLink(candidate.basic.recordId, options.telegramBotUsername);
    const primaryName = hasFullLinks ? escapeHtml(candidate.basic.primaryName) : candidate.basic.primaryName;
    lines.push('', `${index + 1}. ${primaryName}${fullLink ? `  ${fullLink}` : ''}`);
    if (candidate.basic.matchedName !== candidate.basic.primaryName) {
      const matchedName = hasFullLinks ? escapeHtml(candidate.basic.matchedName) : candidate.basic.matchedName;
      lines.push(`   Matched Name: ${matchedName}`);
    }
    const recordId = hasFullLinks ? escapeHtml(candidate.basic.recordId) : candidate.basic.recordId;
    const matchReason = hasFullLinks ? escapeHtml(candidate.matchReason) : candidate.matchReason;
    lines.push(`   Record ID: ${recordId}`);
    lines.push(`   Score: ${candidate.score.toFixed(2)} (${matchReason})`);
  });

  return {
    text: truncateText(lines.join('\n'), options.maxMessageChars),
    buttons: [],
    parseMode: hasFullLinks ? 'HTML' : undefined,
  };
}

export function truncateText(text: string, maxMessageChars = DEFAULT_MAX_MESSAGE_CHARS): string {
  if (text.length <= maxMessageChars) return text;
  const notice = '\n\n[Output truncated to fit Telegram message limit.]';
  if (maxMessageChars <= notice.length + 1) return notice.slice(0, maxMessageChars);
  const bodyLimit = maxMessageChars - notice.length - 1;
  return `${text.slice(0, bodyLimit).trimEnd()}…${notice}`;
}

function basicSection(match: DebarmentMatch, index?: number): string[] {
  const lines = [index ? `Basic Information #${index}` : 'Basic Information'];
  lines.push(`Record ID: ${match.basic.recordId}`);
  lines.push(`Name: ${match.basic.primaryName}`);
  lines.push(`Matched Name: ${match.basic.matchedName}`);
  appendList(lines, 'Aliases', match.basic.aliases);
  appendInline(lines, 'Topics/Risks', match.basic.risks);
  appendInline(lines, 'Countries', match.basic.countries);
  appendList(lines, 'Addresses', match.basic.addresses);
  if (match.basic.identifiers.length > 0) {
    lines.push('Identifiers:');
    for (const identifier of match.basic.identifiers) lines.push(`- ${identifier.type}: ${identifier.value}`);
  }
  if (match.basic.url) lines.push(`OpenSanctions URL: ${match.basic.url}`);
  return lines;
}

function sanctionSection(sanction: SanctionDetail, index: number): string[] {
  const lines = [`- Sanction #${index}: ${sanction.caption ?? sanction.id ?? 'Unnamed sanction'}`];
  appendSanctionField(lines, 'Authority', sanction, 'authority');
  appendSanctionField(lines, 'Status', sanction, 'status');
  appendSanctionField(lines, 'Listing Date', sanction, 'listingDate');
  appendSanctionField(lines, 'Start Date', sanction, 'startDate');
  appendSanctionField(lines, 'Program', sanction, 'program');
  appendSanctionField(lines, 'Provisions', sanction, 'provisions');
  appendSanctionField(lines, 'Source URL', sanction, 'sourceUrl');
  appendSanctionField(lines, 'Summary', sanction, 'summary');
  return lines;
}

function appendSanctionField(lines: string[], label: string, sanction: SanctionDetail, key: keyof SanctionDetail): void {
  const values = sanction[key];
  if (Array.isArray(values) && values.length > 0) lines.push(`  ${label}: ${values.join(', ')}`);
}

function appendCapNotice(lines: string[], result: DebarmentQueryResult): void {
  if (result.truncated) lines.push(`Showing ${result.matches.length} of ${result.totalMatches} matches. Refine your query if needed.`, '');
}

function appendInline(lines: string[], label: string, values: string[]): void {
  if (values.length > 0) lines.push(`${label}: ${values.join(', ')}`);
}

function appendList(lines: string[], label: string, values: string[]): void {
  if (values.length === 0) return;
  lines.push(`${label}:`);
  for (const value of values) lines.push(`- ${value}`);
}

function actionButtons(matches: DebarmentMatch[]): ReplyButton[][] {
  return matches.map((match, index) => {
    const suffix = matches.length > 1 ? ` ${index + 1}` : '';
    return [
      { text: `/basic${suffix}`, callbackData: `basic:${match.basic.recordId}` },
      { text: `/full${suffix}`, callbackData: `full:${match.basic.recordId}` },
    ];
  });
}

function reply(text: string): BotReply {
  return { text, buttons: [] };
}

function fullDeepLink(recordId: string, botUsername: string | undefined): string {
  const username = botUsername?.trim();
  const payload = `full_${recordId}`;
  if (!username || !isDeepLinkPayloadSafe(payload)) return '';
  const url = `https://t.me/${encodeURIComponent(username)}?start=${encodeURIComponent(payload)}`;
  return `<a href="${url}">Full</a>`;
}

function isDeepLinkPayloadSafe(payload: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/u.test(payload);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
