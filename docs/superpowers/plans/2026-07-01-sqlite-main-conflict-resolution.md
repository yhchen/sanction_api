# SQLite-Main Conflict Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `origin/main` into `feature/sqlite` while preserving SQLite as the primary runtime data path and retaining compatible remote features.

**Architecture:** Resolve conflicts by keeping SQLite bootstrap, SQLite query repositories, SQLite refresh build/publish/hot-swap, and empty-bootstrap behavior as the owner of runtime data. Fold in remote configuration, fuzzy threshold, Telegram deep-link formatting, PM2 scripts, documentation, and tests only where they compose with the SQLite path.

**Tech Stack:** TypeScript, Node.js 20, Telegraf, Vitest, better-sqlite3, Git merge conflict resolution.

---

## File Structure

- Modify: `.env.example` - include SQLite path, bot username, fuzzy score threshold, and existing deployment paths.
- Modify: `.gitignore` - keep SQLite database ignores plus `.omx` and local worktree ignores.
- Modify: `package.json` - keep `db:build` and add PM2 scripts from `origin/main`.
- Modify: `package-lock.json` - regenerate or preserve merged dependency/script metadata through `npm install` if needed.
- Create: `ecosystem.config.cjs` - retain PM2 config from `origin/main`.
- Modify: `src/config.ts` - merge `sqlitePath`, `telegramBotUsername`, and `minFuzzyScore`.
- Modify: `src/domain/nameScoring.ts` - keep shared scoring helper and make the minimum fuzzy threshold caller-configurable.
- Modify: `src/domain/types.ts` - keep repository data status and add `parseMode?: 'HTML'` to `BotReply`.
- Modify: `src/data/senzingMemoryRepository.ts` - keep memory repository compatibility with configurable fuzzy threshold for tests and non-SQLite callers.
- Modify: `src/data/sqliteRepositories.ts` - make SQLite fuzzy candidate scoring respect the configured threshold.
- Modify: `src/data/sqliteBootstrap.ts` - keep current branch startup behavior; only adjust if tests reveal missing current-data rebuild behavior belongs here.
- Modify: `src/data/dataRefreshService.ts` - preserve SQLite staged build and safe publish, while adding remote current-metadata/local-file completeness behavior.
- Modify: `src/data/startupDataService.ts` - include only if merge creates it from remote and it is still useful for tests; do not wire it as the production startup owner.
- Modify: `src/index.ts` - keep SQLite bootstrap runtime path and pass `minFuzzyScore` plus `telegramBotUsername` into repositories, refresh, and handler.
- Modify: `src/bot/formatters.ts` - combine empty-data messages with remote HTML deep-link fuzzy output.
- Modify: `src/bot/handlers.ts` - add `/start full_<recordId>` handling with access control.
- Modify: `src/bot/createBot.ts` - forward `/start` payloads and reply with optional HTML parse mode.
- Modify: `README.md`, `docs/admin-telegram-users.md`, `docs/telegram-operation-guide.md` - document merged behavior.
- Modify: `test/debarment-bot.test.ts` - merge tests for empty data, threshold, alias, deep links, and handler behavior.
- Modify: `test/data-refresh.test.ts` - merge tests for SQLite refresh safety and current-metadata missing local data behavior.
- Modify: `test/package-scripts.test.ts` - keep both `db:build` and PM2 script assertions.
- Create: `test/pm2-config.test.ts` - retain remote PM2 config test.
- Modify: `test/sqlite-bootstrap.test.ts`, `test/sqlite-builder.test.ts`, `test/sqlite-repositories.test.ts` - update only if constructor/config signatures change.

## Task 1: Start The Merge And Inventory Conflicts

**Files:**
- Modify: Git index and files reported by `git status`

- [ ] **Step 1: Confirm clean working tree before merge**

Run:

```powershell
git status --short --branch
```

Expected output starts with:

```text
## feature/sqlite
```

Expected: no uncommitted file lines. If the plan file is still uncommitted, commit it before starting the merge.

- [ ] **Step 2: Start merge from remote main**

Run:

```powershell
git merge origin/main
```

Expected: Git reports conflicts in a subset of the files listed above. Do not use `--ours` or `--theirs` globally.

- [ ] **Step 3: Capture conflict list**

Run:

```powershell
git diff --name-only --diff-filter=U
```

Expected conflict files include shared config/code/test files such as:

```text
.env.example
.gitignore
package.json
src/config.ts
src/data/dataRefreshService.ts
src/data/senzingMemoryRepository.ts
src/index.ts
test/data-refresh.test.ts
test/debarment-bot.test.ts
test/package-scripts.test.ts
```

If additional files appear, resolve them using the same current-branch-first rule.

## Task 2: Resolve Config, Package, Ignore, And PM2 Files

**Files:**
- Modify: `.env.example`
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `ecosystem.config.cjs`
- Test: `test/package-scripts.test.ts`
- Test: `test/pm2-config.test.ts`

- [ ] **Step 1: Resolve `.env.example`**

Keep a single env block with these entries:

```dotenv
TELEGRAM_BOT_TOKEN=replace-me
TELEGRAM_BOT_USERNAME=
ALLOWED_TELEGRAM_USERS=
ADMIN_TELEGRAM_USERS=replace-with-your-telegram-user-id

APPROVED_TELEGRAM_USERS_PATH=./approved-users.json
SENZING_PATH=./db/data/senzing.json
TARGETS_NESTED_PATH=./db/data/targets.nested.json
SQLITE_PATH=./db/sanction.sqlite
REFRESH_METADATA_PATH=./db/data/refresh-metadata.json

REFRESH_SCHEDULE_TIME=05:00
MIN_FUZZY_SCORE=0.8
MAX_RESULTS=5
MAX_MESSAGE_CHARS=3800
```

- [ ] **Step 2: Resolve `.gitignore`**

Keep ignore rules for runtime state, SQLite output, OMX, and local worktrees:

```gitignore
node_modules/
dist/
coverage/

.env
.env.local
.env.*.local

approved-users.json
refresh-metadata.json

# Database
db
*.sqlite
*.sqlite-shm
*.sqlite-wal

# oh-my-codex
.omx

# Local git worktrees
.worktrees/
```

- [ ] **Step 3: Resolve `package.json` scripts**

The scripts object must contain all of these keys:

```json
{
  "dev": "tsx --env-file=.env.develop src/index.ts",
  "db:build": "tsx src/scripts/buildSqlite.ts",
  "build": "tsc -p tsconfig.build.json",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "test": "vitest run",
  "test:watch": "vitest",
  "pm2:start": "npm run build && pm2 startOrReload ecosystem.config.cjs --update-env",
  "pm2:restart": "npm run build && pm2 restart ecosystem.config.cjs --update-env",
  "pm2:stop": "pm2 stop sanction-api-telegram-bot",
  "pm2:status": "pm2 status sanction-api-telegram-bot",
  "pm2:logs": "pm2 logs sanction-api-telegram-bot"
}
```

Keep dependencies from current branch:

```json
{
  "better-sqlite3": "^12.11.1",
  "telegraf": "^4.16.3"
}
```

- [ ] **Step 4: Accept or create PM2 config**

Ensure `ecosystem.config.cjs` contains:

```js
module.exports = {
  apps: [
    {
      name: 'sanction-api-telegram-bot',
      script: './dist/index.js',
      interpreter: 'node',
      node_args: '--env-file=.env',
      cwd: process.cwd(),
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
    },
  ],
};
```

- [ ] **Step 5: Run package-focused tests**

Run:

```powershell
npm test -- test/package-scripts.test.ts test/pm2-config.test.ts
```

Expected: PASS. If `package-lock.json` is stale, run:

```powershell
npm install
```

Then rerun the package-focused tests.

## Task 3: Resolve Config And Repository Threshold Wiring

**Files:**
- Modify: `src/config.ts`
- Modify: `src/domain/nameScoring.ts`
- Modify: `src/data/senzingMemoryRepository.ts`
- Modify: `src/data/sqliteRepositories.ts`
- Modify: `src/domain/types.ts`
- Test: `test/debarment-bot.test.ts`
- Test: `test/sqlite-repositories.test.ts`

- [ ] **Step 1: Merge `AppConfig` fields**

`AppConfig` must include:

```ts
export interface AppConfig {
  telegramBotToken: string;
  telegramBotUsername: string;
  allowedTelegramUsers: string;
  adminTelegramUsers: string;
  approvedTelegramUsersPath: string;
  senzingPath: string;
  targetsNestedPath: string;
  sqlitePath: string;
  refreshMetadataPath: string;
  refreshScheduleTime: string;
  maxResults: number;
  maxMessageChars: number;
  minFuzzyScore: number;
}
```

In `loadConfig`, populate:

```ts
telegramBotUsername: env.TELEGRAM_BOT_USERNAME?.trim() ?? '',
sqlitePath: env.SQLITE_PATH?.trim() || './sanction.sqlite',
minFuzzyScore: boundedNumber(env.MIN_FUZZY_SCORE, 0.8, 'MIN_FUZZY_SCORE', 0, 1),
```

Keep the `boundedNumber` helper from `origin/main`.

- [ ] **Step 2: Make scoring threshold configurable**

In `src/domain/nameScoring.ts`, keep typo-tolerant scoring from current branch and change the exported function signature to:

```ts
export const DEFAULT_MIN_FUZZY_SCORE = 0.55;

export function scoreSearchableName(
  normalizedQuery: string,
  queryTokens: string[],
  candidate: SearchableNameForScoring,
  minFuzzyScore = DEFAULT_MIN_FUZZY_SCORE,
): NameScore | undefined {
```

Inside the function, replace every comparison to the old constant with `minFuzzyScore`:

```ts
if (score < minFuzzyScore) return undefined;
```

and:

```ts
matchReason: typoTokenMatches > 0 && scoreWithoutTypos < minFuzzyScore
  ? 'similar-name-typo'
  : exactTokenMatches === queryTokens.length ? 'token-match' : 'similar-name',
```

- [ ] **Step 3: Wire memory repository options**

In `src/data/senzingMemoryRepository.ts`, add:

```ts
import { DEFAULT_MIN_FUZZY_SCORE, normalizedTokens, scoreSearchableName } from '../domain/nameScoring.js';

export interface SenzingMemoryRepositoryOptions {
  minFuzzyScore?: number;
}
```

The class should store:

```ts
private readonly minFuzzyScore: number;

constructor(options: SenzingMemoryRepositoryOptions = {}) {
  this.minFuzzyScore = options.minFuzzyScore ?? DEFAULT_MIN_FUZZY_SCORE;
}
```

Update factories:

```ts
static async fromFile(filePath: string, options: SenzingMemoryRepositoryOptions = {}): Promise<SenzingMemoryRepository> {
  const repository = new SenzingMemoryRepository(options);
```

```ts
static fromRecords(records: SenzingRecord[], options: SenzingMemoryRepositoryOptions = {}): SenzingMemoryRepository {
  const repository = new SenzingMemoryRepository(options);
```

Update scoring call:

```ts
const score = scoreSearchableName(normalizedQuery, queryTokens, match, this.minFuzzyScore);
```

- [ ] **Step 4: Wire SQLite repository options**

In `src/data/sqliteRepositories.ts`, add:

```ts
import { DEFAULT_MIN_FUZZY_SCORE, normalizedTokens, scoreSearchableName } from '../domain/nameScoring.js';

export interface SqliteRepositoryOptions {
  minFuzzyScore?: number;
}
```

Update class constructor and open:

```ts
export class SqliteSenzingRepository implements SenzingLookupRepository {
  private readonly minFuzzyScore: number;

  private constructor(private readonly db: Database.Database, options: SqliteRepositoryOptions = {}) {
    this.minFuzzyScore = options.minFuzzyScore ?? DEFAULT_MIN_FUZZY_SCORE;
  }

  static open(sqlitePath: string, options: SqliteRepositoryOptions = {}): SqliteSenzingRepository {
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    if (!validateSqliteSchema(db)) {
      db.close();
      throw new Error('SQLite schema is incompatible.');
    }
    return new SqliteSenzingRepository(db, options);
  }
```

Update scoring call:

```ts
const score = scoreSearchableName(normalizedQuery, queryTokens, match, this.minFuzzyScore);
```

- [ ] **Step 5: Merge `BotReply` type**

In `src/domain/types.ts`, preserve `RepositoryDataStatus` and add parse mode:

```ts
export interface BotReply {
  text: string;
  buttons: ReplyButton[][];
  notifications?: BotNotification[];
  parseMode?: 'HTML';
}
```

- [ ] **Step 6: Run focused type and repository tests**

Run:

```powershell
npm test -- test/debarment-bot.test.ts -t "loads fuzzy score threshold config"
npm test -- test/sqlite-repositories.test.ts
```

Expected: PASS.

## Task 4: Resolve Startup And Refresh Runtime

**Files:**
- Modify: `src/index.ts`
- Modify: `src/data/sqliteBootstrap.ts`
- Modify: `src/data/dataRefreshService.ts`
- Modify: `src/data/startupDataService.ts`
- Test: `test/sqlite-bootstrap.test.ts`
- Test: `test/data-refresh.test.ts`

- [ ] **Step 1: Keep SQLite startup in `src/index.ts`**

`main()` must call `bootstrapSqliteRepositories`, not memory repository loading:

```ts
bootstrap = await bootstrapSqliteRepositories({
  senzingPath: config.senzingPath,
  targetsNestedPath: config.targetsNestedPath,
  sqlitePath: config.sqlitePath,
  minFuzzyScore: config.minFuzzyScore,
});
```

If `BootstrapSqliteOptions` does not yet accept `minFuzzyScore`, add it and pass it into `SqliteSenzingRepository.open`.

- [ ] **Step 2: Pass merged config into refresh and handler**

In `src/index.ts`, create refresh service with:

```ts
const dataRefreshService = new DataRefreshService({
  senzingPath: config.senzingPath,
  targetsNestedPath: config.targetsNestedPath,
  sqlitePath: config.sqlitePath,
  refreshMetadataPath: config.refreshMetadataPath,
  activeRepositories,
  minFuzzyScore: config.minFuzzyScore,
});
```

Create handler with:

```ts
const handler = new BotCommandHandler(service, accessControl, approvedUsersRepository, {
  maxMessageChars: config.maxMessageChars,
  telegramBotUsername: config.telegramBotUsername,
}, dataRefreshService);
```

- [ ] **Step 3: Extend bootstrap options**

In `src/data/sqliteBootstrap.ts`, add:

```ts
export interface BootstrapSqliteOptions {
  senzingPath: string;
  targetsNestedPath: string;
  sqlitePath: string;
  minFuzzyScore?: number;
}
```

Update `openBootstrapResult` signature and calls:

```ts
return openBootstrapResult(options.sqlitePath, false, options.minFuzzyScore);
```

```ts
function openBootstrapResult(sqlitePath: string, shouldAutoRefresh: boolean, minFuzzyScore?: number): BootstrapSqliteResult {
  const senzingRepository = SqliteSenzingRepository.open(sqlitePath, { minFuzzyScore });
```

- [ ] **Step 4: Merge refresh service options**

In `src/data/dataRefreshService.ts`, keep SQLite options and add threshold:

```ts
export interface DataRefreshServiceOptions {
  senzingPath: string;
  targetsNestedPath: string;
  sqlitePath?: string;
  refreshMetadataPath: string;
  activeRepositories: ActiveDebarmentRepositories;
  fetchMetadata?: RefreshMetadataFetcher;
  downloader?: RefreshDownloader;
  minFuzzyScore?: number;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}
```

- [ ] **Step 5: Preserve current-metadata missing-file behavior**

In `runRefresh`, replace the current metadata check with:

```ts
if (metadataChecksumsMatch(localMetadata, remoteMetadata) && await localRefreshOutputsExist({
  senzingPath: this.options.senzingPath,
  targetsNestedPath: this.options.targetsNestedPath,
  sqlitePath: this.options.sqlitePath,
})) {
  return { status: 'current', version: remoteMetadata.version, message: `OpenSanctions debarment data is already current (${remoteMetadata.version}).` };
}
```

Add helper:

```ts
async function localRefreshOutputsExist(options: { senzingPath: string; targetsNestedPath: string; sqlitePath?: string }): Promise<boolean> {
  for (const filePath of [options.senzingPath, options.targetsNestedPath, options.sqlitePath].filter(isDefinedString)) {
    try {
      const stats = await fs.stat(filePath);
      if (stats.size === 0) return false;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}
```

- [ ] **Step 6: Open refreshed SQLite with threshold**

Inside `afterPublish`, open:

```ts
openedSenzingRepository = SqliteSenzingRepository.open(this.options.sqlitePath!, {
  minFuzzyScore: this.options.minFuzzyScore,
});
```

In non-SQLite fallback, keep:

```ts
nextSenzingRepository = await SenzingMemoryRepository.fromFile(stagedSenzingPath, {
  minFuzzyScore: this.options.minFuzzyScore,
});
```

- [ ] **Step 7: Run refresh/bootstrap tests**

Run:

```powershell
npm test -- test/sqlite-bootstrap.test.ts test/data-refresh.test.ts
```

Expected: PASS.

## Task 5: Resolve Bot Deep Links, Empty Data Messages, And Parse Mode

**Files:**
- Modify: `src/bot/formatters.ts`
- Modify: `src/bot/handlers.ts`
- Modify: `src/bot/createBot.ts`
- Test: `test/debarment-bot.test.ts`
- Test: `test/bot-menu.test.ts`

- [ ] **Step 1: Merge formatter options**

`FormatterOptions` must include:

```ts
export interface FormatterOptions {
  maxMessageChars?: number;
  telegramBotUsername?: string;
}
```

Keep current branch constants:

```ts
const EMPTY_DATA_EXACT = 'Local debarment data is not loaded yet. Data refresh may still be running; try again after the update completes.';
const EMPTY_DATA_SEARCH = 'Local debarment data is not loaded yet, so candidate search is unavailable. Try again after the update completes.';
```

- [ ] **Step 2: Preserve empty-data exact and search responses**

Exact miss formatters must use:

```ts
if (!result.found) return reply(result.dataStatus === 'empty' ? EMPTY_DATA_EXACT : NO_DATA_FOUND);
```

Fuzzy miss formatter must use:

```ts
if (!result.found) return reply(result.dataStatus === 'empty' ? EMPTY_DATA_SEARCH : 'No close name candidates found. Try a more complete name.');
```

- [ ] **Step 3: Apply remote fuzzy deep-link output**

`formatFuzzySearchResult` must return no candidate callback buttons and optional HTML parse mode:

```ts
return {
  text: truncateText(lines.join('\n'), options.maxMessageChars),
  buttons: [],
  parseMode: hasFullLinks ? 'HTML' : undefined,
};
```

Keep helpers from remote:

```ts
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
```

- [ ] **Step 4: Merge `/start` payload handling**

In `src/bot/handlers.ts`, use:

```ts
async handleStart(userId: string | number | undefined, payload = ''): Promise<BotReply> {
  this.clearPendingQuery(userId);

  if (!this.accessControl.isAllowed(userId)) {
    if (!this.approvedUsers) return textOnly('Unauthorized.');
    const suffix = userId === undefined
      ? 'Send /request to ask an admin for access.'
      : `Your Telegram user id is ${userId}. Send /request to ask an admin for access.`;
    return textOnly(`Unauthorized. ${suffix}`);
  }

  const fullRecordId = parseFullStartPayload(payload);
  if (fullRecordId) return formatFullResults(await this.service.fullByRecordId(fullRecordId), this.formatterOptions);

  const adminSuffix = this.accessControl.isAdmin(userId) ? ' Admin commands: /approve <telegram_user_id>.' : '';
  return textOnly(`Send a name to search candidates, or use /check, /search, /basic, /full.${adminSuffix}`);
}
```

Add:

```ts
function parseFullStartPayload(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed.startsWith('full_')) return '';
  const recordId = trimmed.slice('full_'.length).trim();
  return /^[A-Za-z0-9_-]{1,59}$/u.test(recordId) ? recordId : '';
}
```

- [ ] **Step 5: Merge Telegraf reply options**

In `src/bot/createBot.ts`, forward start payload:

```ts
bot.start(async (ctx) => {
  const payload = 'text' in ctx.message ? ctx.message.text.replace(/^\/start(?:@\w+)?\s*/iu, '').trim() : '';
  await replyToContext(ctx, await handler.handleStart(ctx.from?.id, payload));
});
```

Use:

```ts
await ctx.reply(reply.text, replyOptions(reply));
```

and export:

```ts
export function replyOptions(reply: BotReply): { parse_mode?: 'HTML'; reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } } | undefined {
  if (reply.buttons.length === 0 && !reply.parseMode) return undefined;

  return {
    parse_mode: reply.parseMode,
    reply_markup: reply.buttons.length > 0
      ? {
          inline_keyboard: reply.buttons.map((row) =>
            row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
          ),
        }
      : undefined,
  };
}
```

- [ ] **Step 6: Run bot-focused tests**

Run:

```powershell
npm test -- test/debarment-bot.test.ts test/bot-menu.test.ts
```

Expected: PASS.

## Task 6: Resolve Documentation And Final Test Expectations

**Files:**
- Modify: `README.md`
- Modify: `docs/admin-telegram-users.md`
- Modify: `docs/telegram-operation-guide.md`
- Modify: all conflicted test files

- [ ] **Step 1: Remove all conflict markers**

Run:

```powershell
rg -n "<<<<<<<|=======|>>>>>>>" .
```

Expected: no output.

- [ ] **Step 2: Verify docs mention merged runtime behavior**

Run:

```powershell
rg -n "SQLITE_PATH|MIN_FUZZY_SCORE|TELEGRAM_BOT_USERNAME|PM2|完整别名|startup|启动" README.md docs/admin-telegram-users.md docs/telegram-operation-guide.md
```

Expected: output includes all three env vars, PM2 deployment text, alias behavior, and startup data behavior.

- [ ] **Step 3: Check TypeScript formatting by typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS with `tsc -p tsconfig.json --noEmit`.

## Task 7: Full Verification And Merge Commit

**Files:**
- Modify: Git index

- [ ] **Step 1: Run full tests**

Run:

```powershell
npm test
```

Expected: all Vitest suites pass.

- [ ] **Step 2: Run production build**

Run:

```powershell
npm run build
```

Expected: TypeScript emits `dist/` without errors.

- [ ] **Step 3: Inspect final merge diff**

Run:

```powershell
git status --short
git diff --check
git diff --stat HEAD
```

Expected: no conflict markers, no whitespace errors, and diff limited to merge resolution plus planned docs/tests/config updates.

- [ ] **Step 4: Stage and commit merge**

Run:

```powershell
git add .
git diff --cached --check
git status --short
git commit
```

Use this Lore commit message if Git opens an editor or requires `-m`:

```text
保留 SQLite 主线吸收远程功能

Constraint: 当前分支 SQLite bootstrap、refresh build/hot-swap 和查询路径必须保持为运行主线。
Rejected: 全局 --ours 或 --theirs 解决冲突 | 会丢失另一侧功能并掩盖逻辑回归。
Confidence: high
Scope-risk: broad
Directive: 后续 fuzzy、refresh 或启动改动必须同时验证 SQLite 路径和 Telegram handler 行为。
Tested: npm run typecheck; npm test; npm run build
Not-tested: 未连接真实 Telegram Bot 或下载真实 OpenSanctions 远端数据。
```

- [ ] **Step 5: Confirm branch state**

Run:

```powershell
git status --short --branch
git log --oneline --decorate --max-count=5
```

Expected: working tree clean and latest commit is the merge commit.
