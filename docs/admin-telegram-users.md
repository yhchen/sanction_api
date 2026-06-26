# ADMIN_TELEGRAM_USERS 查看与配置指引

本文档说明如何查看、获取并配置 Telegram 机器人的管理员名单 `ADMIN_TELEGRAM_USERS`。

> 注意：`ADMIN_TELEGRAM_USERS` 必须填写 Telegram **数字用户 ID**，不能填写 `@username`。

## 1. 查看当前配置

### 查看 `.env` 文件中的配置

```bash
cd /Users/ethanchan/dev/finance/sanction_api

grep '^ADMIN_TELEGRAM_USERS=' .env
```

如果看到类似下面的内容，说明还没有配置真实管理员 ID：

```dotenv
ADMIN_TELEGRAM_USERS=replace-with-your-telegram-user-id
```

或：

```dotenv
ADMIN_TELEGRAM_USERS=
```

### 查看当前 shell 环境中的配置

```bash
printenv ADMIN_TELEGRAM_USERS
```

如果没有输出，说明当前终端还没有导入 `.env`。

### 导入 `.env` 后再查看

```bash
set -a
source .env
set +a

printenv ADMIN_TELEGRAM_USERS
```

当前项目不会自动读取 `.env`，每次用这种方式启动前都需要先导入环境变量。

## 2. 第一次获取管理员 Telegram 数字 ID

如果你还不知道自己的 Telegram 数字 ID，按下面步骤操作。

### 2.1 先清空管理员配置

编辑 `.env`：

```bash
nano .env
```

把管理员配置改为空：

```dotenv
ADMIN_TELEGRAM_USERS=
```

不要保留占位符：

```dotenv
ADMIN_TELEGRAM_USERS=replace-with-your-telegram-user-id
```

### 2.2 导入环境变量

```bash
set -a
source .env
set +a
```

### 2.3 构建并启动机器人

```bash
npm run build
node dist/index.js
```

### 2.4 在 Telegram 中获取数字 ID

打开 Telegram，进入机器人：

```text
@Debarred_bot
```

发送：

```text
/start
```

如果你尚未被授权，机器人会返回你的 Telegram 数字用户 ID，例如：

```text
Your Telegram user id is 123456789. Send /request to ask an admin for access.
```

记下这个数字 ID。

### 2.5 停止机器人

回到终端，按：

```text
Ctrl+C
```

## 3. 配置单个管理员

编辑 `.env`：

```bash
nano .env
```

把 `ADMIN_TELEGRAM_USERS` 改为你的数字 ID：

```dotenv
ADMIN_TELEGRAM_USERS=123456789
```

保存后重新导入环境变量：

```bash
set -a
source .env
set +a
```

重新启动机器人：

```bash
node dist/index.js
```

## 4. 配置多个管理员

多个管理员用英文逗号分隔，不要加空格也可以，加空格通常也会被 trim 处理，但建议保持简单：

```dotenv
ADMIN_TELEGRAM_USERS=123456789,987654321
```

每个管理员都应该：

1. 打开 `@Debarred_bot`。
2. 发送 `/start`。

原因是 Telegram 只允许机器人主动私信已经启动过该机器人的用户。如果管理员从未打开过机器人，机器人可能无法把用户申请通知发给该管理员。

## 5. 验证管理员是否生效

重启机器人后，管理员在 Telegram 中发送：

```text
/start
```

如果配置生效，机器人回复中会出现管理员命令提示，例如：

```text
Admin commands: /approve <telegram_user_id>.
```

也可以测试批准命令：

```text
/approve 123456789
```

如果返回 `Unauthorized.`，说明当前 Telegram 账号不在 `ADMIN_TELEGRAM_USERS` 中，或机器人进程没有加载最新环境变量。

## 6. 常见问题

### `.env` 已修改，但机器人仍然不认管理员

通常是因为机器人进程没有重新加载环境变量。

处理方式：

1. 停止机器人：`Ctrl+C`
2. 重新导入 `.env`：

```bash
set -a
source .env
set +a
```

3. 重新启动：

```bash
node dist/index.js
```

### `ADMIN_TELEGRAM_USERS` 写了 `@username`，但无效

这是错误配置。必须写数字 ID：

```dotenv
ADMIN_TELEGRAM_USERS=123456789
```

不要写：

```dotenv
ADMIN_TELEGRAM_USERS=@alice
```

### 管理员收不到 `/request` 申请通知

检查：

- 管理员数字 ID 是否写入 `ADMIN_TELEGRAM_USERS`。
- 管理员是否已经打开机器人并发送过 `/start`。
- 机器人是否正在运行。
- `.env` 是否已经重新导入。
- 机器人进程是否使用的是最新启动的进程。

### 用户批准后仍不能访问

检查：

- 管理员是否批准了正确的用户数字 ID。
- `approved-users.json` 是否生成并包含该用户 ID。
- `APPROVED_TELEGRAM_USERS_PATH` 是否指向正确路径。
- 机器人进程是否有写入 `approved-users.json` 的权限。

## 7. 推荐配置模板

管理员批准模式推荐配置：

```dotenv
TELEGRAM_BOT_TOKEN=replace-with-new-token-from-BotFather
ALLOWED_TELEGRAM_USERS=
ADMIN_TELEGRAM_USERS=123456789
APPROVED_TELEGRAM_USERS_PATH=./approved-users.json
SENZING_PATH=./senzing.json
TARGETS_NESTED_PATH=./targets.nested.json
MIN_FUZZY_SCORE=0.8
MAX_RESULTS=5
MAX_MESSAGE_CHARS=3800
```

上线前确认：

- [ ] `ADMIN_TELEGRAM_USERS` 是数字 ID。
- [ ] 多个管理员用英文逗号分隔。
- [ ] 每个管理员都已经对机器人发送过 `/start`。
- [ ] 已重新导入 `.env` 并重启机器人。
- [ ] `.env` 没有提交到 Git。
