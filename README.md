# Cloud Markdown Notes

多用户 Markdown 笔记服务，提供 Web、HTTP API、CLI 和 MCP。每个用户使用独立 workspace，支持目录、编辑、搜索、Git 版本、ZIP 导入导出和固定版本分享。当前生产入口为 https://notes.bosschat.de。

## 当前生产部署

Compose：`docker/compose.prod.yml`；环境：`.env.prod`；项目名：`notes-prod`；服务：`app`、`db`。API 为 `127.0.0.1:18081`，Web 为 `127.0.0.1:5173`，PostgreSQL 16 不发布主机端口。

**所有生产命令必须保持下面的项目目录。** 它决定相对挂载路径，改为 `/root/notes` 可能连接一个新的空数据库。

```bash
cd /root/notes
dc=(docker compose --project-directory /root/notes/docker --env-file /root/notes/.env.prod -f /root/notes/docker/compose.prod.yml -p notes-prod)
"${dc[@]}" config --quiet
"${dc[@]}" up -d --wait --pull never
"${dc[@]}" ps
curl -fsS http://127.0.0.1:18081/api/health
```

同一 Bash 会话中，查看日志用 `"${dc[@]}" logs --tail 100`，停止用 `"${dc[@]}" stop -t 90`，恢复用 `"${dc[@]}" up -d --wait --pull never`，重启用 `"${dc[@]}" restart`。

| 数据 | 主机位置 |
| --- | --- |
| PostgreSQL | `docker/runtime/prod/postgres/` |
| 用户笔记、Git 历史、目录元数据 | `docker/runtime/prod/workspaces/` |
| 凭据、外部地址、Stripe 配置 | `.env.prod` |
| 镜像和数据库备份 | `backups/` |

应用镜像为 `local/notes:mcp-tabs-20261122`，数据库镜像由生产 Compose 固定，两者均为 `pull_policy: never`。恢复时，应用镜像从 `backups/mcp-tabs-20261122T063410Z/release-image.tar.gz` 导入，数据库镜像从 `backups/mcp-keys-20261122T062724Z/rollback-images.tar.gz` 导入，命令为 `gzip -dc <归档路径> | docker image load`。升级前执行一致性备份，再显式修改 Compose 的 `image`。
生产启动会执行数据库迁移，再启动 API/Web。Web 将 `/api/*` 和 `/mcp` 代理到 API，其他页面使用 SPA fallback。

生产凭据只存 `.env.prod`；不要从 example 覆盖。`PROD_HOST_API_PORT=18081`、`PROD_HOST_WEB_PORT=5173`，`PUBLIC_BASE_URL=https://notes.bosschat.de`。Nginx 清单见 `/root/nginx/sites.json`，生成站点为 `/root/nginx/config/conf.d/notes.conf`。

备份整个数据库、workspace 和配置的一致状态，不能仅保留 SQL 或 ZIP 导出。按 [主机备份恢复流程](../README.md#备份恢复与迁移) 使用上述 dc 数组；首次迁移的逻辑备份为 `backups/post-migration-20261005.dump`。公网迁移还需 Nginx、Cloudflare、证书工具和 UFW；不要覆盖目标已有 Nginx。

## 开发与测试

应用开发镜像基于 Node.js 24；源码挂载到 `/app`。主机编排 Compose，依赖、构建和测试在开发/测试容器内执行，不在生产容器执行。

现有开发端口默认值会与生产冲突，且默认未限制绑定地址。使用以下命令覆盖为 localhost 的独立端口：

```bash
cd /root/notes
export HOST_API_PORT=127.0.0.1:18082 HOST_WEB_PORT=127.0.0.1:15173
export HOST_DATA_ROOT=./runtime/dev
dev=(docker compose --env-file .env.dev --project-directory /root/notes -f /root/notes/docker/compose.yml -p notes-dev)
"${dev[@]}" config --quiet
"${dev[@]}" up -d --build app db
"${dev[@]}" exec app sh
# 开发容器内 /app：
npm run lint
npm run build
exit
# 主机结束开发环境：
"${dev[@]}" down
```

开发访问 `http://127.0.0.1:15173`，API 为 `http://127.0.0.1:18082/api`；通过 SSH 隧道访问，不直接公开开发端口。开发数据为 `runtime/dev/`，与生产 `docker/runtime/prod/` 分离；`.env.dev` 不得填生产凭据。现有 `app_node_modules` 命名卷仅为可重建依赖缓存，不存业务数据。

完整测试从**主机**启动，不需要给开发容器挂载 Docker socket：

```bash
cd /root/notes
sh tests/run-e2e.sh
```

`npm test` 调用同一 Docker 编排脚本，不能在无 Docker 的普通开发容器中直接运行。测试使用 `notes-test`，不发布端口，数据和报告位于 `runtime/fulltest-docker/`；测试开始会清理其数据库及 workspace，禁止改指生产数据。

容器内总入口 `tests/full-test-runner.ts` 依次执行计费状态回归、API、CLI、MCP 和 Playwright 测试。CLI 测试打包并安装真实 npm 产物；失败时保留日志和报告。功能清单见 [可测试功能](docs/可测试功能.md)，维护规则见 [AGENTS.md](AGENTS.md)。清单是测试要求，不是最新一轮通过记录。

## API、CLI 与 MCP

JSON API 成功返回 `{ "data": ... }`，失败返回 `{ "error": { "code": ..., "message": ... } }`；ZIP 导出是二进制。认证使用 `Authorization: Bearer <会话token>`。

| 功能 | API 入口 |
| --- | --- |
| 健康、登录、当前账号 | `/api/health`、`/api/auth/login`、`/api/auth/me` |
| 注册、退出、管理员 | `/api/auth/register`、`/api/auth/logout`、`/api/admin/users/*` |
| 文件夹和笔记 | `/api/folders`、`/api/tree`、`/api/notes`，移动用相应 `/move` |
| 版本管理 | `/api/version/status`、`diff`、`commit`、`history`、`show`、`discard`、`restore` |
| 检索 | `/api/search/glob`、`grep`、`read` |
| 导入导出 | `/api/import/dry-run`、`/api/import`、`/api/export.zip` |
| 分享 | `/api/shares`、`/api/shares/public/:slug`；页面 `/s/:slug` |

完整方法和断言见 [功能清单](docs/可测试功能.md)。替换/局部编辑前读取 `fileVersion` 并作为 `ifMatch` 提交；局部编辑行号从 1 开始、两端包含，空内容删除指定行。`EDIT_CONFLICT` 时重读后重试，不覆盖新版本。
分享仅发布已提交且工作区干净的笔记，内容固定到该 commit；ZIP 导出不包含完整数据库或 Git 历史，不能替代备份。

CLI 只要求客户端 Node.js 18+，不要求安装服务端。安装和命令示例见 [CLI README](packages/cli/README.md)。在开发容器可直接运行 `notes help`；访问生产必须显式使用 `https://notes.bosschat.de`，不要把 CLI 默认 localhost:8080 当作本机生产 Notes。

仓库提供 [cloud-notes-cli skill](docs/skills/cloud-notes-cli/SKILL.md)，可按客户端的技能安装方式使用；技能本身不包含 CLI。无需为了 VPS 维护在主机全局安装或自动更新 npm 包。

### 创建个人 MCP 密钥

1. 登录 Notes，进入工作区的 **MCP keys**，给设备起名，点击 **Create MCP key**。复制只在创建时显示的密钥。
2. 在 Windows、macOS 或 Linux 的 MCP 客户端选择 Streamable HTTP，地址填写 `https://notes.bosschat.de/mcp`，将密钥粘贴到 Bearer token 栏，无需安装 Notes CLI。
3. 在 Codex 中也可编辑用户的 `~/.codex/config.toml`（Windows 为 `%USERPROFILE%\.codex\config.toml`），添加或替换同名配置后重新加载 MCP：

```toml
[mcp_servers.cloud-notes]
url = "https://notes.bosschat.de/mcp"
http_headers = { Authorization = "Bearer YOUR_MCP_KEY" }
```

密钥允许 MCP 工具读写本人工作区，包括版本、导入和分享。使用 HTTPS，并限制本地配置文件的读取权限。每个客户端可使用独立密钥；丢失密钥时在 **MCP keys** 撤销并重新创建。密钥持续有效直至撤销，账号失去工作区访问权限时也无法调用工具。已有工作区会话 Bearer 令牌仍可使用。数据库迁移 `0009_mcp_keys.sql` 新增个人密钥表，保存摘要和管理信息。

## 账户、订阅与页面

Web 注册需要邮箱，新用户为 pending；API 允许省略 email，提供时校验格式。管理员激活或有效付费可以授予工作区访问，pending 的计费会话不能当工作区会话使用。

当前代码的 Stripe 方案为 HKD 10/月；服务端配置 `STRIPE_SECRET_KEY`、`STRIPE_PRICE_ID`、`STRIPE_WEBHOOK_SECRET`。Price 必须满足代码校验，Checkout 使用 Managed Payments 与 `2026-02-25.preview` API。修改支付流程前核对 `src/server/billing.ts`，不凭旧文档直接升级 API。

Webhook 地址为 `https://notes.bosschat.de/api/billing/webhook`，处理 `checkout.session.completed`、`checkout.session.async_payment_succeeded`、`invoice.paid`、`invoice.payment_failed`、`customer.subscription.updated`、`customer.subscription.deleted` 以及下文列出的充值、退款和争议事件。访问期限依据 webhook 确认的已付款期限，状态查询和取消操作不自行延长权限。

公开页面为 `/`、`/login`、`/register`、`/billing`、`/terms`、`/privacy`、`/refunds`、`/contact`。法律和联系文案在 Web 源码中维护，不在运维文档重复一份；人工退款/隐私处理不等于已有自动退款或自动删除能力。

## 构建与发布

业务修改先在隔离开发环境验证。生产构建使用 `docker/Dockerfile` 的 `production` 阶段，在主机获得部署授权后执行；选定新镜像标签，再修改实际生产 Compose 的 image，不能依赖已失效的 NOTES_IMAGE 覆盖。

CLI 包位于 `packages/cli`，版本和 Node 要求以 package.json 为准。在开发容器执行 `npm --prefix packages/cli pack --dry-run`，prepack 会构建 `dist/index.js`；只有明确要求发布时才执行 npm publish。Docker 镜像发布工作流位于 `.github/workflows/docker-publish.yml`，涉及外部发布时先核对触发规则和目标仓库，不以推送文档代替部署。

## 余额充值

余额功能部署于 https://notes.bosschat.de，使用 Stripe Live mode；原 card 订阅继续可用。公开测试站点已退役，开发与自动化测试按上面的隔离容器流程重新创建，禁止使用生产凭据。

### Stripe 与业务规则

- 保留 card 的 HKD 10/月 Managed Payments 订阅；充值用普通 Checkout `mode=payment`，不启用 Managed Payments、税费附加、折扣或自动货币转换；支付与入账金额均为 HKD。
- 充值档位 HKD 10/30/100，自定义 HKD 10–1000 整数。余额不失效、不可转账或提现。充值本身不开通订阅，用户显式开启余额续费。
- 余额订阅每个 UTC 日历月扣 1000 港分；月底截断但保留原始日锚点。取消续费保留已付款权限；不足则到期停用，充值后为仍启用续费的用户从恢复时刻开始新周期。长时间停机不追扣历史月份；定时任务正常调度延迟不超过两分钟时沿用原周期。
- card 与余额续费互斥；切换必须等待旧订阅终止和已付费期限结束。启用余额会关闭尚未完成的 card Checkout；不自动取消有效 card 订阅。
- 卡订阅与充值共享一致的客户创建幂等参数，邮箱单独同步；首请求失败后可切换支付方式重试。卡订阅检查遍历所有分页，避免漏掉仍有效的订阅。
- PostgreSQL 保存订单、余额和流水。Stripe 验签、环境/币种/金额/产品/用户核验通过后才入账；重复或乱序事件不重复充值或扣款。
- 首次卡订阅付款支持 7 个自然日内申请全额无理由退款，以申请发送时间为准，每位客户仅一次；续费、重复注册及余额订阅扣款不适用。余额订阅首次及续费扣款不退款，只有未消费充值余额可申请人工原路退款，审核金额不得超过可用余额及原订单可退金额。适用法律及 Stripe/Link 规则要求的权利不受影响。
- 人工在 Stripe 原路退款；成功退款与争议资金撤回/返还驱动账本冲正。同一充值的退款和争议合计冲正不超过充值额。负余额阻止余额续费，已购买期限保留，不提供自助退款或提现接口。
- 卡订阅退款：`charge.refunded` / `refund.updated` 经 Stripe 查询确认任意金额成功退款后，撤销原订阅权限并立即取消该 Stripe 订阅。待处理/失败退款不撤权；历史订阅退款不影响替代订阅、余额订阅或管理员授权。退款记录持久化到 `refunded_card_subscriptions`，阻止晚到的付款事件重新开通；取消失败返回非 2xx，由 Stripe 重试，期间本地权限保持撤销。取消不额外生成账单或按比例退款。
- 正式 webhook：`https://notes.bosschat.de/api/billing/webhook`；当前快照事件版本 `2026-08-26.dahlia`。应用 Stripe 调用仍采用既有 `2026-02-25.preview`，没有升级生产 API 版本。
- 在原六类事件基础上增加 `checkout.session.async_payment_failed`、`checkout.session.expired`、`charge.refunded`、`refund.updated`、`charge.dispute.funds_withdrawn`、`charge.dispute.funds_reinstated`。Webhook 失败返回非 2xx，待 Stripe 重投；不要手工给订单加余额。

配置项（实际密钥只保存在私密环境文件）：

| 变量 | 用途 |
| --- | --- |
| STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET | 对应环境的 API/签名密钥 |
| STRIPE_PRICE_ID | HKD 10/月 card Price |
| STRIPE_TOPUP_PRODUCT_ID | 充值 Product |
| STRIPE_TOPUP_PRICE_10 / _30 / _100 | 三个一次性 Price，可省略后由同一 Product 动态定价 |
| STRIPE_LIVEMODE | 测试固定 false；正式必须 true |
| PUBLIC_BASE_URL | 与站点一致，正式为 https://notes.bosschat.de |

### 余额 API

所有用户接口接受 billing 或 workspace 会话，金额为整数港分；沿用 `{data}` / `{error}` 响应。

| 方法与路径 | 行为 |
| --- | --- |
| GET /api/billing/status | 增加 wallet（balance/currency/autoRenew/periodEnd/enabled）、cardPeriodEnd；currentPeriodEnd 为两种来源的有效已付费截止时间 |
| POST /api/billing/topups/checkout-session | body: amount（1000–100000 且为100倍数）、requestId（UUID）；返回 url、orderId；网络重试必须复用 requestId |
| GET /api/billing/topups/:id | 仅本人订单，返回 pending/paid/failed/expired 及退款/冲正金额 |
| GET /api/billing/wallet/transactions?before= | 每页20条，nextCursor 分页，按数值流水ID倒序 |
| POST /api/billing/wallet/subscription | 开启或恢复余额续费，首次扣款后开通 |
| DELETE /api/billing/wallet/subscription | 取消未来续费，保留已付费期限 |

### 备份与升级回退

本次升级备份为 `backups/wallet-production-20261008/`：`images.tar.gz` 保存升级前后应用和数据库镜像，`database.dump` 为停写后的逻辑备份，`data.tar.gz` 为数据库干净停机后的原始数据及 workspace，另有升级前生产环境和 Compose 配置。目录权限 700，文件 600；禁止入库或公开。长期备份按主机通用流程执行。

迁移 `0007_wallet.sql` 新增余额表；`0008_card_subscription_refunds.sql` 新增卡订阅退款撤权记录表，均不修改既有用户权限，不追溯触发历史退款。生产构建及部署：

```bash
cd /root/notes
docker build --target production -f docker/Dockerfile -t local/notes:billing-audit-20261008 .
prod=(docker compose --project-directory /root/notes/docker --env-file /root/notes/.env.prod -f /root/notes/docker/compose.prod.yml -p notes-prod)
"${prod[@]}" config --quiet
"${prod[@]}" up -d --wait --pull never
curl -fsS http://127.0.0.1:18081/api/health
```

当前计费审查修复版镜像、升级前数据库和 workspace 备份位于 `backups/billing-audit-production-20261008/`。使用 `gzip -dc backups/billing-audit-production-20261008/image.tar.gz | docker image load` 恢复镜像；本次无数据库迁移，回退镜像仍保留卡退款撤权功能。

首次卡订阅 7 天退款条款版镜像为 `backups/image-first-card-refund-20261008.tar.gz`；恢复命令为 `gzip -dc backups/image-first-card-refund-20261008.tar.gz | docker image load`。此版仅修改公开条款和页面提示，不增加数据库迁移。

卡退款自动撤权版的升级前数据库、workspace 和配置备份在 `backups/card-refunds-production-20261008/`；该目录的 `image.tar.gz` 为卡退款自动撤权版镜像，可用 `gzip -dc backups/card-refunds-production-20261008/image.tar.gz | docker image load` 恢复。

退款条款文案版镜像另存于 `backups/image-refund-policy-20261008.tar.gz`，可用 `gzip -dc backups/image-refund-policy-20261008.tar.gz | docker image load` 恢复。此版仅更新前端条款及提示，不含数据迁移。

后续升级使用新的唯一镜像标签，先一致备份再显式修改 Compose。数据恢复前停止 app/db，另存当前数据；将 `data.tar.gz` 解压到空恢复目录，保留 UID/GID，核对后替换对应 `docker/runtime/prod/`。逻辑恢复使用 `pg_restore` 导入空数据库，不覆盖仍在写入的数据库。缺少本地镜像时执行 `gzip -dc backups/wallet-production-20261008/images.tar.gz | docker image load`。

产生余额业务数据后，旧镜像不识别余额权限，不能直接回滚后继续收款。回退前暂停充值入口，停止新写入并备份新增账本；保留新增表及流水，禁止通过删除表或恢复旧库丢弃付款记录。确认没有新增付款时，可将备份的 `compose.prod.before.yml` 和 `env.prod.before` 恢复到原路径，再执行上述生产启动命令；已有付款时优先修复或按账本核对后处理。

卡退款撤权上线后，不应直接回退到不识别 `refunded_card_subscriptions` 的镜像，否则重投付款事件可能恢复已退款权限。先暂停受影响卡订阅的付款事件处理、保留撤权表和数据库备份，并优先向前修复；不得删表或恢复旧库丢弃退款记录。
