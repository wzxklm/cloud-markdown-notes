# 用自己的 Stripe 账户部署 Notes

以下命令从本仓库根目录执行，适用于新实例。需要 Docker Compose、域名和能把 HTTPS 请求转发到本机 Web 端口的反向代理。

## 启动服务

1. 创建私有配置：`(umask 077; cp -n .env.prod.example .env.prod)`。分别生成数据库密码、会话密钥和管理员密码并替换模板值，例如使用 `openssl rand -hex 32`。数据库密码同时用于连接 URL，使用十六进制可避免 URL 转义问题。
2. 设置 `PUBLIC_BASE_URL` 和 `NOTES_API_URL` 为你的 HTTPS 站点，填写 `SITE_OPERATOR`、`SUPPORT_EMAIL`，检查条款、隐私和退款页面是否符合你的业务。计费和 MCP 不需要另开公网端口。
3. 选择与本指南匹配的已发布镜像。下面的 <release-tag> 可填写已发布版本标签，或填写 latest 以解析当前 main 发布版的固定摘要。执行 `docker pull miketop/cloud-markdown-notes:<release-tag>`，再执行 `docker image inspect --format '{{index .RepoDigests 0}}' miketop/cloud-markdown-notes:<release-tag>`，把完整摘要填入 `NOTES_IMAGE`。测试尚未发布的源码可运行 `docker build --target production -f docker/Dockerfile -t notes-selfhost:source .`，填写 `NOTES_IMAGE=notes-selfhost:source`。
4. 从根目录启动。首次可以留空 Stripe 配置以核对站点和联系信息。更新环境文件后，再执行同一条 up 命令。

```bash
dc=(docker compose --env-file .env.prod -f docker/compose.selfhost.yml)
"${dc[@]}" config --quiet
"${dc[@]}" up -d --wait
"${dc[@]}" ps
```

反代到 `127.0.0.1:5173`（若改过 Web 端口则相应调整），保留请求路径和 Authorization 头。访问首页、联系页面与 `/api/health`。日常日志用 `"${dc[@]}" logs --tail 100`，停止用 `"${dc[@]}" stop`。数据库与工作区位于相对于 Compose 文件目录的 `PROD_HOST_DATA_ROOT`。升级前停写并备份两者、环境文件以及原镜像引用。

## Stripe 沙箱配置

全程选用同一个沙箱。以下设置采用服务内置的港币价格。费用与有效期由 Webhook 确认。

| 配置 | 在 Stripe 中准备的值 |
|---|---|
| STRIPE_SECRET_KEY、STRIPE_LIVEMODE | 沙箱 API secret key，模式填 false |
| STRIPE_PRICE_ID | 活跃的循环 Price，HK$10、每 1 个月。卡订阅使用 Managed Payments 和代码固定的 preview API，先确认你的账户可用。 |
| STRIPE_TOPUP_PRODUCT_ID | 一次性余额充值使用的活跃 Product ID |
| STRIPE_TOPUP_PRICE_10 / _30 / _100 | 可选。同一充值产品下对应金额的一次性 HKD Price。留空时服务按用户选择的金额创建价格数据。 |
| STRIPE_WEBHOOK_SECRET | 以下 Webhook 端点自己的签名密钥 |

在 Dashboard 配置 Customer Portal，启用符合站点约定的订阅取消方式。在事件目的地新增快照 Webhook，指向 `https://你的域名/api/billing/webhook`，按 README 记录的事件版本配置，订阅以下事件：

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
