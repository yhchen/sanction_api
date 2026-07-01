# Sanction API Telegram Bot

这是一个基于 Node.js / TypeScript 的 Telegram 机器人，用本地 OpenSanctions 衍生数据文件做 Debarred 名单查询。机器人支持私有部署、管理员批准访问、基础信息查询和完整制裁详情查询。

## 功能概览

- 通过 Telegram 查询完整主名称或完整别名是否命中 Debarred 记录。
- 支持纯文本模糊候选搜索；直接发送主名称或别名的部分输入会返回可能匹配的完整名称候选。
- 支持 `/check`、`/search`、`/basic`、`/full` 查询命令；菜单选择无参数命令时会等待用户下一条输入。
- 命中后会返回 `/basic` 和 `/full` 内联按钮，便于继续查看详情。
- 支持三种访问控制模式：公开、静态白名单、管理员批准。
- 未授权用户可发送 `/request` 申请访问；管理员可用 `/approve` 批准。
- 管理员可手动发送 `/update` 检查 OpenSanctions debarment 数据更新；机器人也会每天 05:00 自动检查。
- 启动时优先打开或构建 SQLite 查询库；如果首次启动时数据为空，会先用空库启动服务，再自动触发一次数据更新。

## 数据文件

运行时默认读取以下本地文件：

| 文件 | 用途 |
| --- | --- |
| `senzing.json` | SQLite 构建输入，提供名称、别名、风险主题和基础信息。 |
| `targets.nested.json` | SQLite 构建输入，提供 OpenSanctions record id 对应的 `/full` 制裁详情。 |
| `sanction.sqlite` | 运行时查询库，默认由 `senzing.json` 和 `targets.nested.json` 构建。 |
| `entities.ftm.json` | V1 阶段只做过评估，不作为当前查询数据源。 |
| `refresh-metadata.json` | 最近一次成功刷新后的 dataset version 和目标资源 checksum，用于避免无变化时下载大文件。 |

注意：虽然文件名是 `.json`，当前读取逻辑按 JSONL 处理，也就是每一行都是一个独立 JSON 对象。

## 匹配规则

- 查询使用规范化后的完整主名称或完整别名精确匹配，来源是 `NAMES[].NAME_FULL`。
- `/check`、`/basic`、`/full` 使用完整主名称或完整别名精确匹配。例如：`/check YATAI SMART INDUSTRIAL NEW CITY` 和 `/check YATAI NEW CITY` 都可以命中同一条记录，但 `/check Yatai Smart` 不会按部分名称判断为 `Debarred`。
- `/search <name>` 和无等待模式下的纯文本会执行模糊候选搜索，会在主名称和别名中查找可能匹配的名称候选，不直接判定 `Debarred`。例如：`Yatai Smart` 或 `Myanmar Yatai` 可返回 `YATAI SMART INDUSTRIAL NEW CITY` 候选。
- 配置 `TELEGRAM_BOT_USERNAME` 后，`/search` 和纯文本模糊搜索结果会在每个候选旁显示 `Full` 链接；点击后通过 Telegram deep link 返回该记录的完整制裁详情。
- 只有包含风险主题 `debarment` 的记录会返回为 `Debarred`。
- `/search <name>` 返回按相关性排序且数量受控的候选名称。
- `/basic <name>` 返回基础记录信息。
- `/full <name>` 返回制裁详情。
- `/check`、`/basic`、`/full` 后面不带名称时，机器人会进入对应精确查询等待输入模式；下一条普通文本会作为完整主名称或完整别名执行并清除等待状态。`/search` 后面不带名称时，下一条普通文本会作为模糊候选搜索输入。
- `/cancel` 可清除等待输入模式。
- 当消息不是命令且没有等待输入模式时，机器人会把纯文本内容当作模糊候选搜索处理。

## 快速开始

### 1. 准备环境

需要：

- Node.js 20 或更高版本。
- 一个 Telegram Bot Token。
- 本地数据文件：`senzing.json` 和 `targets.nested.json`；如果首次启动时缺少这些文件，进程需要能访问 OpenSanctions 下载地址以自动补齐。

安装依赖：

```bash
npm install
```

### 2. 配置环境变量

最小配置示例：

```bash
export TELEGRAM_BOT_TOKEN="<bot-token>"
export ALLOWED_TELEGRAM_USERS=""
export ADMIN_TELEGRAM_USERS="123456789"
export APPROVED_TELEGRAM_USERS_PATH="./approved-users.json"
export SENZING_PATH="./senzing.json"
export TARGETS_NESTED_PATH="./targets.nested.json"
export SQLITE_PATH="./sanction.sqlite"
export REFRESH_METADATA_PATH="./refresh-metadata.json"
export REFRESH_SCHEDULE_TIME="05:00"
export MIN_FUZZY_SCORE="0.8"
export MAX_RESULTS="5"
export MAX_MESSAGE_CHARS="3800"
```

也可以复制 `.env.example` 作为部署配置模板，但运行方式需要确保这些变量已经注入到进程环境中。

### 3. 启动机器人

生产方式：

```bash
npm run build
node dist/index.js
```

PM2 托管方式：

```bash
cp .env.example .env
# 编辑 .env，填入 Telegram token、管理员 ID 和数据文件路径
npm install
npm install -g pm2
npm run pm2:start
pm2 save
```

PM2 会读取 `ecosystem.config.cjs`，使用 Node.js 20 的 `--env-file=.env` 加载部署配置，并托管运行 `dist/index.js`。常用管理命令：

```bash
npm run pm2:status
npm run pm2:logs
npm run pm2:restart
npm run pm2:stop
```

服务器重启后自动恢复 PM2 进程列表，需要按 PM2 对当前系统生成自启动命令：

```bash
pm2 startup
```

执行 `pm2 startup` 输出的命令后，再执行 `pm2 save` 保存当前进程列表。

开发方式：

```bash
npm run dev
```

## 环境变量说明

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 无 | 必填。由 Telegram `@BotFather` 生成的机器人 token。 |
| `TELEGRAM_BOT_USERNAME` | 空字符串 | Bot 用户名，用于在模糊搜索结果中生成可点击的 `Full` 链接，例如 `ExampleDebarmentBot`。为空时不渲染 deep link。 |
| `ALLOWED_TELEGRAM_USERS` | 空字符串 | 访问控制白名单。`*` 表示公开；逗号分隔的数字 ID 表示静态白名单；空字符串可配合管理员批准模式。 |
| `ADMIN_TELEGRAM_USERS` | 空字符串 | 管理员 Telegram 数字用户 ID，多个 ID 用逗号分隔。管理员可批准访问申请。 |
| `APPROVED_TELEGRAM_USERS_PATH` | `./approved-users.json` | 管理员批准后的用户 ID 存储文件。运行进程必须有写入权限。 |
| `SENZING_PATH` | `./senzing.json` | `senzing.json` 数据文件路径。 |
| `TARGETS_NESTED_PATH` | `./targets.nested.json` | `targets.nested.json` 数据文件路径。 |
| `SQLITE_PATH` | `./sanction.sqlite` | SQLite 查询库路径；启动和刷新时会从 JSONL 数据构建或替换该文件。 |
| `REFRESH_METADATA_PATH` | `./refresh-metadata.json` | 最近一次成功数据刷新的 metadata/checksum 存储路径。运行进程必须有写入权限。 |
| `REFRESH_SCHEDULE_TIME` | `05:00` | 每日自动刷新检查时间，使用运行服务器本地时区，格式为 `HH:MM`。 |
| `MIN_FUZZY_SCORE` | `0.8` | 模糊候选搜索的最低分数阈值；低于该分数的候选不会显示。取值范围为 `0` 到 `1`。 |
| `MAX_RESULTS` | `5` | 单次查询最多返回的匹配数量。 |
| `MAX_MESSAGE_CHARS` | `3800` | 单条 Telegram 消息的最大输出字符数；不能超过 Telegram 限制。 |

`approved-users.json` 会包含真实 Telegram 用户 ID，已被 `.gitignore` 忽略，不要提交到仓库。`refresh-metadata.json` 是运行时状态文件，也不应提交。

## 访问控制配置

正常部署时建议选择以下一种模式。

| 模式 | 配置 | 行为 |
| --- | --- | --- |
| 公开模式 | `ALLOWED_TELEGRAM_USERS="*"` | 任意 Telegram 用户都可以查询。 |
| 静态白名单模式 | `ALLOWED_TELEGRAM_USERS="123,456"` | 只有列出的 Telegram 数字用户 ID 可以查询。 |
| 管理员批准模式 | `ALLOWED_TELEGRAM_USERS=""`，`ADMIN_TELEGRAM_USERS="123"` | 用户发送 `/request` 申请访问，管理员用 `/approve` 批准。 |

补充规则：

- 管理员 ID 始终有查询权限。
- 运行时批准的用户会写入 `APPROVED_TELEGRAM_USERS_PATH` 指向的 JSON 文件。
- `ADMIN_TELEGRAM_USERS` 和 `ALLOWED_TELEGRAM_USERS` 都必须使用 Telegram 数字用户 ID，不能使用 `@username`。

## Telegram 配置指引

### 1. 创建机器人

1. 打开 Telegram，搜索官方 `@BotFather`。
2. 发送 `/newbot`。
3. 根据提示设置机器人显示名称。
4. 设置唯一的机器人用户名，用户名通常需要以 `bot` 结尾。
5. 复制 BotFather 返回的 token，并配置为 `TELEGRAM_BOT_TOKEN`。

请妥善保管 token。任何拿到 token 的人都可以控制这个机器人。

### 2. 命令菜单自动注册

机器人启动时会自动向 Telegram 注册命令菜单，不需要再到 `@BotFather` 手工配置。菜单中只显示面向查询和入口的快速指令：

- `/start` - 显示帮助和访问状态
- `/check` - 查询完整主名称或完整别名的 Debarred 状态
- `/search` - 按主名称或别名的部分输入搜索候选
- `/basic` - 显示基础记录信息
- `/full` - 显示完整制裁详情

`/request`、`/approve` 和管理员专用的 `/update` 仍然可以手动输入使用，但不会显示在命令菜单中。未授权用户通过 `/start` 的提示了解如何发送 `/request` 申请访问；管理员仍可手动使用 `/approve` 批准用户。

从菜单选择 `/check`、`/basic` 或 `/full` 时，Telegram 只会发送命令本身；机器人会提示用户继续发送完整主名称或完整别名。选择 `/search` 时，机器人会提示用户发送主名称或别名的部分输入用于候选搜索。发送 `/cancel` 可以取消当前等待输入模式。`/cancel` 不显示在命令菜单中。

如果启动时 Telegram 命令菜单注册失败，机器人会启动失败并退出，便于部署时及时发现 token、网络或 Telegram API 配置问题。

### 3. 获取管理员 Telegram 数字用户 ID

`ADMIN_TELEGRAM_USERS` 必须配置数字用户 ID。推荐用机器人自举获取：

1. 先配置 `TELEGRAM_BOT_TOKEN`。
2. 临时启动机器人。
3. 管理员本人在 Telegram 中打开这个机器人。
4. 管理员发送 `/start`。
5. 如果尚未授权，机器人会回复该管理员的 Telegram 数字用户 ID。
6. 停止机器人，把该 ID 写入 `ADMIN_TELEGRAM_USERS`。

单个管理员：

```bash
export ADMIN_TELEGRAM_USERS="123456789"
```

多个管理员：

```bash
export ADMIN_TELEGRAM_USERS="123456789,987654321"
```

每个管理员都应该先打开机器人并发送一次 `/start`。Telegram 只允许机器人主动私信已经启动过该机器人的用户，否则管理员可能收不到访问申请通知。

### 4. 管理员批准模式配置示例

```bash
export TELEGRAM_BOT_TOKEN="<bot-token-from-BotFather>"
export ALLOWED_TELEGRAM_USERS=""
export ADMIN_TELEGRAM_USERS="<admin-telegram-numeric-id>"
export APPROVED_TELEGRAM_USERS_PATH="./approved-users.json"
export SENZING_PATH="./senzing.json"
export TARGETS_NESTED_PATH="./targets.nested.json"
export SQLITE_PATH="./sanction.sqlite"
export REFRESH_METADATA_PATH="./refresh-metadata.json"
export REFRESH_SCHEDULE_TIME="05:00"
export MIN_FUZZY_SCORE="0.8"
export MAX_RESULTS="5"
export MAX_MESSAGE_CHARS="3800"
```

启动：

```bash
npm run build
node dist/index.js
```

确认 `APPROVED_TELEGRAM_USERS_PATH` 指向的位置可写。第一次批准用户时，机器人会创建或更新这个文件。

### 5. 用户申请流程

1. 用户在 Telegram 中打开机器人。
2. 用户发送 `/start`。
3. 如果用户尚未获批，机器人会显示该用户的 Telegram 数字用户 ID，并提示发送 `/request`。
4. 用户发送 `/request`。
5. 机器人把申请详情私信给所有已配置管理员。

### 6. 管理员批准流程

管理员收到申请消息后，可以用任一方式批准：

- 直接回复那条申请消息：`/approve`
- 主动发送：`/approve <telegram_user_id>`，例如：

```text
/approve 123456789
```

批准成功后：

1. 机器人会把用户 ID 写入 `approved-users.json`。
2. 被批准的用户会收到访问已开通的通知。
3. 用户可以使用 `/check`、`/basic`、`/full` 做完整主名称或完整别名精确查询，也可以发送主名称或别名的部分输入、或使用 `/search` 做模糊候选搜索。

### 7. 管理员数据刷新

管理员可以手动发送：

```text
/update
```

机器人会先读取 OpenSanctions debarment metadata：

```text
https://data.opensanctions.org/datasets/latest/debarment/index.json
```

刷新流程：

1. 比较远端 `senzing.json` 和 `targets.nested.json` 的 checksum 与 `REFRESH_METADATA_PATH` 中的本地 metadata。
2. 如果 checksum 相同，不下载完整文件，直接回复数据已经是最新。
3. 如果任一目标资源变化，从同一个 metadata version 下载两个目标资源到临时文件。
4. 先验证下载文件，并在临时目录构建 SQLite 查询库。
5. 只有 JSONL 文件和 SQLite 查询库都构建成功后，才替换本地文件、写入刷新 metadata，并热切换查询服务。
6. 任何 metadata、下载、验证或索引构建失败都会保留旧数据，玩家查询继续使用旧索引。

机器人启动后还会按 `REFRESH_SCHEDULE_TIME` 每天自动执行同一条安全刷新路径，默认是服务器本地时区 05:00。并发刷新会被拒绝，管理员会收到已有刷新正在运行的回复。

`/update` 不会加入公开命令菜单；只有 `ADMIN_TELEGRAM_USERS` 中的管理员可以执行。

### 8. 管理员收不到申请通知时的检查项

请确认：

- 管理员 ID 已写入 `ADMIN_TELEGRAM_USERS`。
- `ADMIN_TELEGRAM_USERS` 中是数字用户 ID，不是 `@username`。
- 管理员已经打开机器人并发送过 `/start`。
- 机器人进程有权限写入 `approved-users.json`。
- 机器人使用的是正确的 `TELEGRAM_BOT_TOKEN`。

## Telegram 中的使用方式

| 操作 | 命令或消息 |
| --- | --- |
| 查看帮助和访问状态 | `/start` |
| 申请访问 | `/request` |
| 查询完整主名称 | `/check YATAI SMART INDUSTRIAL NEW CITY` |
| 查询完整别名 | `/check YATAI NEW CITY` |
| 搜索候选名称 | `/search Yatai Smart` |
| 搜索别名候选 | `/search Myanmar Yatai` |
| 纯文本候选搜索 | `Yatai Smart` |
| 查询基础信息 | `/basic YATAI SMART INDUSTRIAL NEW CITY` |
| 查询完整制裁详情 | `/full YATAI SMART INDUSTRIAL NEW CITY` |
| 菜单查询 | 选择 `/check`、`/basic` 或 `/full` 后，再发送完整主名称或完整别名；选择 `/search` 后发送主名称或别名的部分输入 |
| 取消等待输入 | `/cancel` |
| 管理员批准用户 | `/approve 123456789` |
| 管理员刷新数据 | `/update` |
| 精确完整主名称状态查询 | `/check YATAI SMART INDUSTRIAL NEW CITY` |
| 精确完整别名状态查询 | `/check YATAI NEW CITY` |

## 架构说明

V1 版本把文件解析逻辑放在 repository adapter 中，业务查询通过 repository interface 暴露给服务层和 Telegram handler。

当前实现：

- `sqliteBuilder` 从 `senzing.json` 和 `targets.nested.json` 构建 `sanction.sqlite`。
- `SqliteSenzingRepository` 从 SQLite 查询完整名称、完整别名和模糊候选。
- `SqliteTargetDetailsRepository` 从 SQLite 读取 OpenSanctions nested sanctions，并返回较小的 `SanctionDetail` DTO。
- Telegram handler 只依赖领域服务和 repository interface，不直接暴露原始 OpenSanctions nested record。

这样做的目的是让后续替换为 MongoDB 或其他持久化 adapter 时，不需要重写 Telegram bot handler。

当前实现选择 SQLite 作为运行时查询库，以降低 JSONL 全量内存索引的启动和内存压力。如果未来需要 MongoDB 或其他持久化 adapter，可以保留 service 和 handler contract，只替换 repository adapter。

## 开发和验证命令

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

说明：

- `npm run typecheck`：执行 TypeScript 类型检查。
- `npm test`：运行 Vitest 测试。
- `npm run build`：构建生产输出到 `dist/`。
- `npm run dev`：使用 `tsx` 直接运行源码。

## 安全和部署注意事项

- 不要提交 `TELEGRAM_BOT_TOKEN`。
- 不要提交 `approved-users.json`。
- 不要把 `ADMIN_TELEGRAM_USERS` 配成 `@username`；必须使用数字用户 ID。
- 私有部署建议使用管理员批准模式，而不是公开模式。
- 如果部署在服务器上，确保数据文件路径和 `APPROVED_TELEGRAM_USERS_PATH` 都是运行用户可读写的正确路径。

## 独立操作指引

Telegram 创建、token 重新生成、管理员 ID 获取、命令菜单自动注册和批准流程的完整步骤见 [`docs/telegram-operation-guide.md`](docs/telegram-operation-guide.md)。
单独的 `ADMIN_TELEGRAM_USERS` 查看与配置步骤见 [`docs/admin-telegram-users.md`](docs/admin-telegram-users.md)。

## 官方参考

- Telegram BotFather 教程：<https://core.telegram.org/bots/tutorial>
- Telegram Bot 功能和命令菜单说明：<https://core.telegram.org/bots/features>
