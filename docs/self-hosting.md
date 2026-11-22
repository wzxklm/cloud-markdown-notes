# 自托管 Notes

两种方式都使用 Docker Compose 运行应用和 PostgreSQL。选下面一种准备应用镜像和部署文件，再完成[配置与启动](#配置与启动)。示例命令使用 Bash。对公网提供服务还需要域名和 HTTPS 反向代理。

## 从公开镜像部署

适合直接运行官方发行版。主机需要 Docker Compose 和 curl，无需安装 Git、Node.js 或构建应用。

在新目录拉取镜像。从镜像标签读取对应的 Git 提交，再下载该版本的配置文件。这里用 `latest` 选择当前发行镜像，实际部署固定到拉取时的摘要。

```bash
mkdir notes-selfhost && cd notes-selfhost
mkdir -p docker
image=miketop/cloud-markdown-notes:latest
docker pull "$image"
revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
source_url="https://raw.githubusercontent.com/wzxklm/cloud-markdown-notes/$revision"
for file in .env.prod.example docker/compose.selfhost.yml docker/compose.prod.yml; do
  curl -fsSL "$source_url/$file" -o "$file" || exit 1
done
docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image"
```

在下一步将输出中以 `miketop/cloud-markdown-notes@sha256:` 开头的完整引用填入 `NOTES_IMAGE`。`compose.selfhost.yml` 复用同目录的 `compose.prod.yml`，启动时只指定自托管文件。

## 从源码部署

适合运行指定提交或自己的修改。主机需要 Git 和 Docker Compose。Dockerfile 的 `production` 阶段会在构建容器中安装依赖、编译前后端并打包运行环境。

```bash
git clone https://github.com/wzxklm/cloud-markdown-notes.git
cd cloud-markdown-notes
# 如需部署指定版本，在构建前执行 git checkout <tag-or-commit>
image="notes-selfhost:$(git rev-parse --short=12 HEAD)"
docker build --target production -f docker/Dockerfile -t "$image" .
echo "$image"
```

将输出的本地镜像名填入 `NOTES_IMAGE`。如果维护自己的改动，先提交再构建，便于根据镜像标签找到对应源码。

## 配置与启动

在所选方式的部署目录中，为新实例执行：

```bash
(umask 077; cp -n .env.prod.example .env.prod)
```

编辑 `.env.prod`：

- 填入上一步确定的 `NOTES_IMAGE`。分别设置 `POSTGRES_PASSWORD`、`SESSION_SECRET` 和 `ADMIN_PASSWORD`，可用 `openssl rand -hex 32` 生成。同步替换 `DATABASE_URL` 中的数据库密码。
- 将 `PUBLIC_BASE_URL` 和 `NOTES_API_URL` 设为自己的 HTTPS 站点，填写 `SITE_OPERATOR` 和 `SUPPORT_EMAIL`。
- Stripe 配置可以留空；需要订阅或一次性充值时，再按下文配置。

```bash
dc=(docker compose --env-file .env.prod -f docker/compose.selfhost.yml)
"${dc[@]}" config --quiet
"${dc[@]}" up -d --wait
"${dc[@]}" ps
```

反代到 `127.0.0.1:5173`（若改过 Web 端口则相应调整），保留请求路径和 Authorization 头。访问首页、联系页面与 `/api/health`。日常日志用 `"${dc[@]}" logs --tail 100`，停止用 `"${dc[@]}" stop`。数据库与工作区位于相对于 Compose 文件目录的 `PROD_HOST_DATA_ROOT`，按模板默认为 `docker/runtime/selfhost/`。

升级时先停写并备份数据库、工作区、环境文件和原镜像引用。镜像部署重新拉取目标版本并核对该版本配置；源码部署从目标提交构建新标签。保留原有私有配置与数据路径，更新 `NOTES_IMAGE` 后执行同一条 `up -d --wait` 命令。

## Stripe 沙箱配置

全程选用同一个沙箱。以下设置采用服务内置的港币价格。费用与有效期由 Webhook 确认。

| 配置 | 在 Stripe 中准备的值 |
|---|---|
| STRIPE_SECRET_KEY、STRIPE_LIVEMODE | 沙箱 API secret key，模式填 false |
| STRIPE_PRICE_ID | 活跃的循环 Price，HK$10、每 1 个月。卡订阅使用 Managed Payments 和固定的 `2026-02-25.preview` API，先确认你的账户可用。 |
| STRIPE_TOPUP_PRODUCT_ID | 一次性余额充值使用的活跃 Product ID |
| STRIPE_TOPUP_PRICE_10 / _30 / _100 | 可选。同一充值产品下对应金额的一次性 HKD Price。留空时服务按用户选择的金额创建价格数据。 |
| STRIPE_WEBHOOK_SECRET | 以下 Webhook 端点自己的签名密钥 |

在 Dashboard 配置 Customer Portal，启用符合站点约定的订阅取消方式。在事件目的地新增快照 Webhook，指向 `https://你的域名/api/billing/webhook`，快照事件版本选用 `2026-08-26.dahlia`，订阅以下事件：

- Checkout：`checkout.session.completed`、`checkout.session.async_payment_succeeded`、`checkout.session.async_payment_failed`、`checkout.session.expired`
- 发票和订阅：`invoice.paid`、`invoice.payment_failed`、`customer.subscription.updated`、`customer.subscription.deleted`
- 退款与争议：`charge.refunded`、`refund.updated`、`charge.dispute.funds_withdrawn`、`charge.dispute.funds_reinstated`

配置参考：[Stripe Managed Payments](https://docs.stripe.com/payments/managed-payments)、[Customer Portal](https://docs.stripe.com/customer-management/integrate-customer-portal)、[Webhook](https://docs.stripe.com/webhooks)。

## 验收两条支付路径

1. 注册两个带邮箱的普通用户，让两者保持待激活。在沙箱使用 [Stripe 测试付款方式](https://docs.stripe.com/testing)。
2. **卡订阅**：第一个用户选择 HK$10/月，完成测试支付。检查 Dashboard 投递返回 2xx，刷新 Billing 后查看已付期限并进入工作区。进入 Portal 设置到期取消，返回后应显示取消安排，已付期限保留。
3. **一次性充值**：第二个用户充值 HK$30，确认钱包增加 HK$30、只有一条入账记录、余额续费仍关闭。重新投递同一成功事件，余额应保持 HK$30。再主动开启余额续费，确认扣除 HK$10、剩余 HK$20 并取得一个月访问权限。
4. **失败和退款**：另开测试充值并取消，确认余额未增加。在 Dashboard 对成功充值发起部分测试退款，确认出现等额冲正。对测试卡订阅付款执行退款并确认原订阅取消、原授权撤销。排障时检查事件投递状态与 app 日志。
5. 正式启用时换成 live API key、live 商品/价格、live Webhook 端点签名密钥，设置 `STRIPE_LIVEMODE=true` 并单独配置 live Portal。沙箱与正式实例使用独立数据库和工作区。
