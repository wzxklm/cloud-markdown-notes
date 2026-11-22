# Self-hosting Notes

**English** · [简体中文](self-hosting.zh-CN.md)

Notes runs the app and PostgreSQL with Docker Compose. Choose one of the two methods below, then [configure and start the instance](#configure-and-start-the-instance). The commands use Bash. For a public instance, you also need a domain and an HTTPS reverse proxy.

## Deploy a published image

Use this method to run an official release. You need Docker with Compose and curl. Pull the image, read its Git revision, and download the configuration from that same revision. The example uses `latest` to select a release and then pins the deployed image by digest.

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

Set `NOTES_IMAGE` to the full reference beginning with `miketop/cloud-markdown-notes@sha256:` in the output. Keep both Compose files in the same directory. The self-hosting file extends the production file, so only pass the self-hosting file when starting the app.

## Build from source

Use this method to deploy a specific commit or your own changes. You need Git and Docker with Compose. The Dockerfile’s `production` target installs dependencies, compiles the frontend and backend, and packages the runtime in the image.

```bash
git clone https://github.com/wzxklm/cloud-markdown-notes.git
cd cloud-markdown-notes
# To build a specific revision, first run git checkout <tag-or-commit>
image="notes-selfhost:$(git rev-parse --short=12 HEAD)"
docker build --target production -f docker/Dockerfile -t "$image" .
echo "$image"
```

Set `NOTES_IMAGE` to the local image name printed above. Commit local changes before building if you want the tag to identify the exact source.

## Configure and start the instance

From the deployment directory created above, create a private environment file for the new instance:

```bash
(umask 077; cp -n .env.prod.example .env.prod)
```

Edit `.env.prod`:

- Set `NOTES_IMAGE` to the digest or local tag selected above. Generate separate values for `POSTGRES_PASSWORD`, `SESSION_SECRET`, and `ADMIN_PASSWORD`, for example with `openssl rand -hex 32`. Set the password in `DATABASE_URL` to the same value as `POSTGRES_PASSWORD`.
- Set `PUBLIC_BASE_URL` and `NOTES_API_URL` to your HTTPS origin. Set `SITE_OPERATOR` and `SUPPORT_EMAIL` for your instance.
- You can leave the Stripe settings empty. To offer subscriptions or one-time top-ups, follow the sandbox instructions below.

```bash
dc=(docker compose --env-file .env.prod -f docker/compose.selfhost.yml)
"${dc[@]}" config --quiet
"${dc[@]}" up -d --wait
"${dc[@]}" ps
```

Private ChatGPT connection URLs carry a credential in the query string. Configure proxies, error logs and tracing to omit MCP request URLs and query parameters, including on upstream failures.

Point the reverse proxy at `127.0.0.1:5173` (or your configured web port), preserving the request path and Authorization header. Check the homepage, contact page, and `/api/health`. Run `"${dc[@]}" logs --tail 100` to read logs or `"${dc[@]}" stop` to stop the services. Database and workspace data live under `PROD_HOST_DATA_ROOT`, relative to the Compose file directory. The template uses `docker/runtime/selfhost/`.

Before upgrading, stop writes and back up the database, workspaces, environment file, and current image reference. For a published image, pull the target release and check its configuration. For a source build, build a new tag from the target commit. Keep the existing environment settings and data paths, update `NOTES_IMAGE`, and run the same `up -d --wait` command.

## Stripe sandbox setup

Use one sandbox for all of the settings below. Notes uses Hong Kong dollars. Webhooks confirm payment and the paid access period.

| Setting | Value |
| --- | --- |
| `STRIPE_SECRET_KEY`, `STRIPE_LIVEMODE` | The sandbox API secret key and `false`, respectively. |
| `STRIPE_PRICE_ID` | An active recurring price of HK$10 every month. Card subscriptions use Managed Payments and the pinned `2026-02-25.preview` API. Confirm your account supports them. |
| `STRIPE_TOPUP_PRODUCT_ID` | An active product ID for one-time wallet top-ups. |
| `STRIPE_TOPUP_PRICE_10`, `STRIPE_TOPUP_PRICE_30`, `STRIPE_TOPUP_PRICE_100` | Optional one-time HKD price IDs on the same product for each amount. Leave blank to generate price data for the amount selected. |
| `STRIPE_WEBHOOK_SECRET` | The signing secret for the webhook endpoint below. |

Configure the Customer Portal in the Stripe Dashboard and enable the cancellation policy your site offers. Create a snapshot webhook destination at `https://your-domain/api/billing/webhook` with snapshot event version `2026-08-26.dahlia`. Subscribe to these events:

- Checkout: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`
- Invoices and subscriptions: `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`
- Refunds and disputes: `charge.refunded`, `refund.updated`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`

See Stripe’s guides to [Managed Payments](https://docs.stripe.com/payments/managed-payments), the [Customer Portal](https://docs.stripe.com/customer-management/integrate-customer-portal), and [webhooks](https://docs.stripe.com/webhooks).

## Verify both payment flows

1. Register two ordinary users with email addresses. Leave both pending and use [Stripe test payment methods](https://docs.stripe.com/testing).
2. **Card subscription.** Subscribe the first user for HK$10/month. Verify the webhook delivery returns 2xx, refresh Billing, check the paid-through date, and open the workspace. Schedule cancellation at period end in the Portal. Billing should show the cancellation and retain paid access.
3. **Wallet top-up.** Top up the second user by HK$30. Verify there is one credit, the balance is HK$30, and balance renewal is off. Redeliver the success event and verify the balance stays at HK$30. Enable balance renewal. Verify a HK$10 deduction, a HK$20 balance, and one month of access.
4. **Cancellations and refunds.** Start another test top-up and cancel it. Verify the balance does not increase. Issue a partial test refund against the successful top-up and check for a reversal of the same amount. Refund the test card subscription payment and verify that its subscription is canceled and its access revoked. Use delivery status and app logs to investigate discrepancies.
5. **Go live.** Use a separate database and workspaces for the live instance. Switch to the live API key, products, prices, and webhook signing secret, set `STRIPE_LIVEMODE=true`, and configure the live Customer Portal separately.
