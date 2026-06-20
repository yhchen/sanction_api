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
TELEGRAM_BOT_TOKEN=<replace-with-new-token-from-BotFather>
ALLOWED_TELEGRAM_USERS=
ADMIN_TELEGRAM_USERS=
APPROVED_TELEGRAM_USERS_PATH=./approved-users.json
SENZING_PATH=./senzing.json
TARGETS_NESTED_PATH=./targets.nested.json
MAX_RESULTS=5
MAX_MESSAGE_CHARS=3800
```

说明：

- `TELEGRAM_BOT_TOKEN`：真实 token 只写在本机或服务器 `.env` 中，不要提交。
- `ALLOWED_TELEGRAM_USERS`：留空，表示使用管理员批准模式。
- `ADMIN_TELEGRAM_USERS`：第一次启动时可以先留空，用来获取管理员自己的 Telegram 数字 ID。
- `APPROVED_TELEGRAM_USERS_PATH`：机器人批准用户后会写入这个 JSON 文件。

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

## 5. 在 BotFather 配置命令菜单

在 Telegram 打开官方 `@BotFather`：

1. 发送 `/mybots`。
2. 选择 `Debarred_bot`。
3. 进入 **Edit Bot > Edit Commands**。
4. 粘贴以下命令列表：

```text
start - 显示帮助和访问状态
request - 向管理员申请访问权限
check - 查询完整名称的 Debarred 状态
basic - 显示基础记录信息
full - 显示完整制裁详情
approve - 管理员批准 Telegram 用户 ID
```

配置完成后，用户在机器人聊天窗口输入 `/` 或点击菜单按钮时，会看到这些命令。

## 6. 用户申请访问流程

用户在 Telegram 中打开 `@Debarred_bot` 后：

1. 发送 `/start`。
2. 如果未获批，机器人会显示该用户的 Telegram 数字 ID。
3. 用户发送 `/request`。
4. 机器人会把申请信息私信给所有配置在 `ADMIN_TELEGRAM_USERS` 中的管理员。

## 7. 管理员批准流程

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
- 用户可以开始查询 Debarred 信息。

## 8. 用户查询方式

用户获批后，可以使用以下方式查询。

| 操作 | Telegram 输入示例 |
| --- | --- |
| 查看帮助和访问状态 | `/start` |
| 查询完整名称 | `/check YATAI SMART INDUSTRIAL NEW CITY` |
| 查询基础信息 | `/basic YATAI SMART INDUSTRIAL NEW CITY` |
| 查询完整制裁详情 | `/full YATAI SMART INDUSTRIAL NEW CITY` |
| 纯文本查询 | `YATAI SMART INDUSTRIAL NEW CITY` |

查询规则：

- 必须输入完整名称。
- 不支持部分名称匹配。
- 只有风险主题包含 `debarment` 的记录会显示为 `Debarred`。

## 9. 其他访问模式

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

## 10. 常见问题排查

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

## 11. 安全检查清单

上线前确认：

- [ ] 已重新生成并安全保存 token。
- [ ] `.env` 没有被提交到 Git。
- [ ] `approved-users.json` 没有被提交到 Git。
- [ ] `ADMIN_TELEGRAM_USERS` 使用数字 ID，不是用户名。
- [ ] 私有部署没有设置 `ALLOWED_TELEGRAM_USERS=*`。
- [ ] 服务器上的 `.env` 权限尽量限制为 `600`。
- [ ] 数据文件路径正确，机器人进程可读。
- [ ] `APPROVED_TELEGRAM_USERS_PATH` 所在目录可写。

## 12. 官方参考

- Telegram BotFather 教程：<https://core.telegram.org/bots/tutorial>
- Telegram Bot API：<https://core.telegram.org/bots/api>
- Telegram Bot 功能和命令菜单说明：<https://core.telegram.org/bots/features>
