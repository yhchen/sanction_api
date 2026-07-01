# Telegram 机器人上线操作指引

本文档记录 `Debarred_bot` 的 Telegram 配置、管理员批准模式和日常使用流程。

> 安全提醒：不要把真实 `TELEGRAM_BOT_TOKEN` 写入文档、聊天记录、Git 提交或截图。本文所有 token 都使用占位符。

## 0. 如果 Token 已经暴露，先重新生成

如果你曾把 BotFather 返回的 token 发到聊天、日志、截图或任何不受控位置，请立即重新生成 token。

在 Telegram 打开官方 `@BotFather`：

1. 发送 `/mybots`。
2. 选择 `Debarred_bot`。
3. 进入 **API Token**。
4. 选择 **Revoke current token** 或重新生成 token。
5. 保存新 token，只放到本机或服务器的环境变量中。
6. 如果 `.env` 中保存了旧 token，立即替换为新 token。

旧 token 被撤销后，旧 token 将不能再控制机器人。

## 1. 前置条件

项目目录：

```bash
cd /Users/ethanchan/dev/finance/sanction_api
```

需要准备：

- Node.js 20 或更高版本。
- BotFather 生成的新 `TELEGRAM_BOT_TOKEN`。
- 本地数据文件：
  - `senzing.json`
  - `targets.nested.json`
  - `securities.csv`
- 可写的批准用户存储文件路径，例如 `./approved-users.json`。

安装依赖：

```bash
npm install
```

## 2. 配置本地环境变量

可以复制示例文件：

```bash
cp .env.example .env
chmod 600 .env
```

编辑 `.env`：

```dotenv
TELEGRAM_BOT_TOKEN=replace-with-new-token-from-BotFather
TELEGRAM_BOT_USERNAME=
ALLOWED_TELEGRAM_USERS=
ADMIN_TELEGRAM_USERS=
APPROVED_TELEGRAM_USERS_PATH=./approved-users.json
SENZING_PATH=./senzing.json
TARGETS_NESTED_PATH=./targets.nested.json
SECURITIES_PATH=./securities.csv
SQLITE_PATH=./sanction.sqlite
REFRESH_METADATA_PATH=./refresh-metadata.json
REFRESH_SCHEDULE_TIME=05:00
MIN_FUZZY_SCORE=0.8
MAX_RESULTS=5
MAX_MESSAGE_CHARS=3800
```

说明：

- `TELEGRAM_BOT_TOKEN`：真实 token 只写在本机或服务器 `.env` 中，不要提交。
- `TELEGRAM_BOT_USERNAME`：Bot 用户名；配置后模糊搜索候选会显示可点击的 `Full` deep link。
- `ALLOWED_TELEGRAM_USERS`：留空，表示使用管理员批准模式。
- `ADMIN_TELEGRAM_USERS`：第一次启动时可以先留空，用来获取管理员自己的 Telegram 数字 ID。
- `APPROVED_TELEGRAM_USERS_PATH`：机器人批准用户后会写入这个 JSON 文件。
- `MIN_FUZZY_SCORE`：模糊候选搜索最低分数阈值，默认 `0.8`；低于该分数的候选不会显示。
- `SQLITE_PATH`：SQLite 查询库路径；启动和刷新时会从 JSONL/CSV 数据构建或替换该文件。

当前项目不会自动加载 `.env`，启动前需要把 `.env` 导入 shell 环境：

```bash
set -a
source .env
set +a
```

## 3. 第一次启动，获取管理员数字 ID

先构建并启动机器人：

```bash
npm run build
node dist/index.js
```

然后在 Telegram 打开：

```text
@Debarred_bot
```

发送：

```text
/start
```

如果当前账号尚未授权，机器人会回复你的 Telegram 数字用户 ID。记录这个数字 ID。

之后按 `Ctrl+C` 停止机器人。

## 4. 配置管理员名单

把上一步得到的数字 ID 写入 `.env`：

```dotenv
ADMIN_TELEGRAM_USERS=123456789
```

多个管理员用英文逗号分隔：

```dotenv
ADMIN_TELEGRAM_USERS=123456789,987654321
```

重新导入环境变量并启动：

```bash
set -a
source .env
set +a

node dist/index.js
```

注意：每个管理员都应该先在 Telegram 中打开机器人并发送一次 `/start`。Telegram 只允许机器人主动私信已经启动过该机器人的用户，否则管理员可能收不到访问申请通知。

## 5. 查看与配置管理员名单

`ADMIN_TELEGRAM_USERS` 的查看、获取数字 ID、配置多个管理员和排错步骤见 [`admin-telegram-users.md`](admin-telegram-users.md)。

## 6. 命令菜单自动注册

机器人启动时会自动向 Telegram 注册命令菜单，不需要在 `@BotFather` 中手工配置。菜单中只显示以下快速指令：

- `/start` - 显示帮助和访问状态
- `/check` - 查询完整主名称或完整别名的 Debarred / Sanctioned Securities 状态
- `/search` - 按主名称或别名的部分输入搜索候选
- `/basic` - 显示基础记录信息
- `/full` - 显示完整制裁详情

`/request`、`/approve` 和管理员专用 `/update` 不显示在命令菜单中，但命令仍然可用。未授权用户通过 `/start` 的提示知道可以发送 `/request` 申请访问；管理员收到申请后仍然可以手动发送 `/approve <telegram_user_id>`，或回复申请消息 `/approve`。

从菜单选择 `/check`、`/basic` 或 `/full` 时，Telegram 只会发送命令本身；机器人会提示用户继续发送完整主名称或完整别名。选择 `/search` 时，机器人会提示用户发送主名称或别名的部分输入。下一条普通文本会按所选模式查询并清除等待状态。如果用户在输入名称前又选择另一个查询命令，新命令会覆盖旧等待模式。发送 `/cancel` 可以取消当前等待输入模式。`/cancel` 不显示在命令菜单中。

如果启动时命令菜单注册失败，机器人会启动失败并退出。此时优先检查 `TELEGRAM_BOT_TOKEN`、网络连接和 Telegram API 可用性。

## 7. 用户申请访问流程

用户在 Telegram 中打开 `@Debarred_bot` 后：

1. 发送 `/start`。
2. 如果未获批，机器人会显示该用户的 Telegram 数字 ID。
3. 用户发送 `/request`。
4. 机器人会把申请信息私信给所有配置在 `ADMIN_TELEGRAM_USERS` 中的管理员。

## 8. 管理员批准流程

管理员收到申请通知后，可以二选一批准。

方式一：直接回复申请通知：

```text
/approve
```

方式二：主动发送用户 ID：

```text
/approve 123456789
```

批准成功后：

- 用户 ID 会写入 `approved-users.json`。
- 用户会收到访问已开通的通知。
- 用户可以开始查询 Debarred 和 Sanctioned Securities 公司级信息。

## 9. 用户查询方式

用户获批后，可以使用以下方式查询。

| 操作 | Telegram 输入示例 |
| --- | --- |
| 查看帮助和访问状态 | `/start` |
| 查询完整主名称 | `/check YATAI SMART INDUSTRIAL NEW CITY` |
| 查询完整别名 | `/check YATAI NEW CITY` |
| 搜索候选名称 | `/search Yatai Smart` |
| 搜索别名候选 | `/search Myanmar Yatai` |
| 纯文本候选搜索 | `Yatai Smart` |
| 查询基础信息 | `/basic YATAI SMART INDUSTRIAL NEW CITY` |
| 查询完整制裁详情 | `/full YATAI SMART INDUSTRIAL NEW CITY` |
| 菜单查询 | 选择 `/check`、`/basic` 或 `/full` 后，再发送完整主名称或完整别名；选择 `/search` 后发送主名称或别名的部分输入 |
| 取消等待输入 | `/cancel` |
| 精确完整主名称状态查询 | `/check YATAI SMART INDUSTRIAL NEW CITY` |
| 精确完整别名状态查询 | `/check YATAI NEW CITY` |
| 管理员刷新数据 | `/update` |

查询规则：

- `/check`、`/basic`、`/full` 必须输入完整主名称或完整别名并保持精确匹配。
- `/search` 和无等待模式下的普通文本支持主名称或别名的部分输入做模糊候选搜索。
- 模糊候选搜索只搜索 `NAMES[].NAME_FULL`，不搜索地址、编号或制裁详情全文。
- 模糊候选搜索只返回可能匹配的名称候选，不直接显示为命中结论。
- 精确查询结果现在可能显示 `Debarred`、`Sanctioned Securities` 或 `Debarred + Sanctioned Securities`。Sanctioned Securities 当前使用 OpenSanctions 官方 `securities.csv` 公司级导出，不是完整 securities 图谱。

## 10. 管理员数据刷新

管理员可以在 Telegram 中发送：

```text
/update
```

该命令不会出现在公开命令菜单中，也不会开放给普通用户。机器人会使用 OpenSanctions debarment metadata 和 securities metadata endpoint 检查目标资源：

```text
https://data.opensanctions.org/datasets/latest/debarment/index.json
https://data.opensanctions.org/datasets/latest/securities/index.json
```

安全刷新规则：

- 先比较远端 `senzing.json`、`targets.nested.json` 和 `securities.csv` checksum 与本地 `REFRESH_METADATA_PATH`。
- checksum 未变化时，不下载完整文件，直接回复数据已是最新。
- 任一目标文件变化时，下载三份文件到临时路径。
- 下载后先验证，并在临时目录构建 SQLite 查询库；成功后才替换本地文件、写入 metadata，并热切换查询数据。
- metadata 获取、下载、验证或重建失败时，旧本地文件和旧查询索引继续使用。
- 如果定时任务正在刷新，管理员手动 `/update` 会收到已有刷新正在运行的回复，不会启动第二条流水线。

机器人启动后会每天自动检查一次，默认服务器本地时区 05:00。可通过 `.env` 调整：

```dotenv
REFRESH_METADATA_PATH=./refresh-metadata.json
REFRESH_SCHEDULE_TIME=05:00
```

确认运行进程对 `SENZING_PATH`、`TARGETS_NESTED_PATH`、`SECURITIES_PATH` 和 `REFRESH_METADATA_PATH` 所在目录有写权限。

## 11. 其他访问模式

管理员批准模式是推荐的私有部署方式。如果需要其他模式，可以改环境变量。

### 公开模式

任何 Telegram 用户都可以查询：

```dotenv
ALLOWED_TELEGRAM_USERS=*
ADMIN_TELEGRAM_USERS=
```

### 静态白名单模式

只有指定数字 ID 用户可以查询：

```dotenv
ALLOWED_TELEGRAM_USERS=123456789,987654321
ADMIN_TELEGRAM_USERS=
```

### 管理员批准模式

用户通过 `/request` 申请，管理员通过 `/approve` 批准：

```dotenv
ALLOWED_TELEGRAM_USERS=
ADMIN_TELEGRAM_USERS=123456789
APPROVED_TELEGRAM_USERS_PATH=./approved-users.json
```

## 12. 常见问题排查

### Bot 启动时报 `TELEGRAM_BOT_TOKEN is required`

说明环境变量没有导入。重新执行：

```bash
set -a
source .env
set +a
```

然后再次启动：

```bash
node dist/index.js
```

### 管理员收不到用户申请通知

检查：

- `ADMIN_TELEGRAM_USERS` 是否填写了管理员的数字 ID。
- 是否误用了 `@username`。这里必须是数字 ID。
- 管理员是否已经打开机器人并发送过 `/start`。
- 机器人是否正在运行。
- 当前运行进程是否加载了最新 `.env`。

### 用户仍然提示 Unauthorized

检查：

- 用户是否已经发送 `/request`。
- 管理员是否已经批准正确的用户数字 ID。
- `approved-users.json` 是否已经写入该用户 ID。
- 机器人进程是否有权限写入 `approved-users.json`。

### 批准后文件没有生成

检查：

- `APPROVED_TELEGRAM_USERS_PATH` 是否指向可写目录。
- 运行机器人进程的系统用户是否有写权限。
- 管理员执行的是 `/approve <telegram_user_id>`，或回复申请消息 `/approve`。

## 13. 安全检查清单

上线前确认：

- [ ] 已重新生成并安全保存 token。
- [ ] `.env` 没有被提交到 Git。
- [ ] `approved-users.json` 没有被提交到 Git。
- [ ] `ADMIN_TELEGRAM_USERS` 使用数字 ID，不是用户名。
- [ ] 私有部署没有设置 `ALLOWED_TELEGRAM_USERS=*`。
- [ ] 服务器上的 `.env` 权限尽量限制为 `600`。
- [ ] 数据文件路径正确，机器人进程可读、可在刷新成功时写入。
- [ ] `REFRESH_METADATA_PATH` 所在目录可写，且运行时 metadata 文件没有提交到 Git。
- [ ] `APPROVED_TELEGRAM_USERS_PATH` 所在目录可写。

## 14. 官方参考

- Telegram BotFather 教程：<https://core.telegram.org/bots/tutorial>
- Telegram Bot API：<https://core.telegram.org/bots/api>
- Telegram Bot 功能和命令菜单说明：<https://core.telegram.org/bots/features>
