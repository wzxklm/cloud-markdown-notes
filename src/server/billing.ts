import Stripe from "stripe";
import type { FastifyInstance } from "fastify";
import { apiSuccess } from "../shared/api";
import { apiError } from "../shared/errors";
import { makeBillingAuthenticate, requireCurrentUser } from "./auth";
import type { AppConfig } from "./config";
import { transaction, type Database } from "./db";

// The supplied Managed Payments blueprint explicitly specifies this preview.
export const stripeVersion = "2026-02-25.preview";
export function createStripe(config: AppConfig): Stripe | undefined {
  return config.stripeSecretKey ? new Stripe(config.stripeSecretKey, {
    // @ts-expect-error Stripe types describe the latest stable version; blueprint requires preview.
    apiVersion: stripeVersion
  }) : undefined;
}
const idOf = (value: string | { id: string } | null | undefined) => typeof value === "string" ? value : value?.id;
type BillingRow = {
  id: string; email: string | null; stripe_customer_id: string | null;
  stripe_subscription_id: string | null; subscription_status: string | null;
  current_period_end: Date | null; grace_period_end: Date | null;
  checkout_session_id: string | null; manual_access: boolean;
  subscription_cancel_at: Date | null; subscription_cancel_at_period_end: boolean; subscription_canceled_at: Date | null;
};

export function registerBillingRoutes(app: FastifyInstance, config: AppConfig, db: Database, stripe = createStripe(config)): void {
  const authenticate = makeBillingAuthenticate(config, db);
  const enabled = Boolean(stripe && config.stripePriceId && config.stripeWebhookSecret);

  app.get("/api/billing/status", { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireCurrentUser(request, reply); if (!user) return;
    const { rows: [row] } = await db.query<BillingRow>("select * from users where id = $1", [user.id]);
    // Webhooks record confirmed paid access and subscription changes. A remote
    // subscription period can advance before payment, so never copy it here.
    return apiSuccess({ user, status: row.subscription_status, currentPeriodEnd: row.current_period_end,
      gracePeriodEnd: row.grace_period_end, active: user.status === "active", manualAccess: row.manual_access,
      hasCustomer: Boolean(row.stripe_customer_id), enabled,
      cancelAt: row.subscription_cancel_at, cancelAtPeriodEnd: row.subscription_cancel_at_period_end, canceledAt: row.subscription_canceled_at });
  });

  app.put<{ Body: { email?: unknown } }>("/api/billing/email", { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireCurrentUser(request, reply); if (!user) return;
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply.status(400).send(apiError("VALIDATION_ERROR", "A valid email is required."));
    await db.query("update users set email = $1 where id = $2", [email, user.id]);
    return apiSuccess({ email });
  });

  app.post("/api/billing/checkout-session", { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireCurrentUser(request, reply); if (!user) return;
    if (!enabled || !stripe) return reply.status(503).send(apiError("BILLING_NOT_CONFIGURED", "Billing is not configured."));
    const result = await transaction(db, async (client) => {
      const { rows: [row] } = await client.query<BillingRow>("select * from users where id = $1 for update", [user.id]);
      if (!row.email) return { error: "Add your email before subscribing." };
      const price = await stripe.prices.retrieve(config.stripePriceId!, { expand: ["product"] });
      if (!price.active || price.currency !== "hkd" || price.unit_amount !== 1000 || price.recurring?.interval !== "month" || price.recurring.interval_count !== 1) throw new Error("STRIPE_PRICE_ID must be an active HKD 10 monthly price.");
      let customer = row.stripe_customer_id;
      if (!customer) {
        customer = (await stripe.customers.create({ metadata: { userId: user.id } }, { idempotencyKey: `notes-customer-${user.id}` })).id;
        await client.query("update users set stripe_customer_id = $1 where id = $2", [customer, user.id]);
      }
      await stripe.customers.update(customer, { email: row.email });
      const subscriptions = await stripe.subscriptions.list({ customer, status: "all", limit: 100 });
      if (subscriptions.data.some((sub) => !["canceled", "incomplete_expired"].includes(sub.status))) return { error: "A subscription already exists. Manage it in the billing portal." };
      if (row.checkout_session_id) {
        const session = await stripe.checkout.sessions.retrieve(row.checkout_session_id);
        if (session.status === "open" && session.url) return { url: session.url };
        if (session.status === "complete" && !row.stripe_subscription_id) return { error: "Payment is processing. Refresh your subscription status." };
      }
      const session = await stripe.checkout.sessions.create({ mode: "subscription", customer,
        line_items: [{ price: config.stripePriceId!, quantity: 1 }], managed_payments: { enabled: true },
        success_url: `${config.publicBaseUrl}/billing?checkout=success`, cancel_url: `${config.publicBaseUrl}/billing?checkout=cancelled`,
        client_reference_id: user.id, metadata: { userId: user.id }, subscription_data: { metadata: { userId: user.id } }
      }, { idempotencyKey: `notes-checkout-${user.id}-${row.checkout_session_id ?? "first"}` });
      await client.query("update users set checkout_session_id = $1, checkout_expires_at = $2 where id = $3", [session.id, new Date(session.expires_at * 1000), user.id]);
      return { url: session.url };
    });
    if (result.error) return reply.status(409).send(apiError("CHECKOUT_NOT_READY", result.error));
    return apiSuccess(result);
  });

  app.post("/api/billing/portal-session", { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireCurrentUser(request, reply); if (!user) return;
    if (!enabled || !stripe) return reply.status(503).send(apiError("BILLING_NOT_CONFIGURED", "Billing is not configured."));
    const { rows: [row] } = await db.query<BillingRow>("select * from users where id = $1", [user.id]);
    if (!row.stripe_customer_id) return reply.status(409).send(apiError("CHECKOUT_NOT_READY", "No Stripe customer exists yet."));
    const portal = await stripe.billingPortal.sessions.create({ customer: row.stripe_customer_id, return_url: `${config.publicBaseUrl}/billing` });
    return apiSuccess({ url: portal.url });
  });

  app.post("/api/billing/webhook", { config: { rawBody: true } }, async (request, reply) => {
    if (!enabled || !stripe) return reply.status(503).send(apiError("BILLING_NOT_CONFIGURED", "Billing is not configured."));
    let event: Stripe.Event;
    try {
      const signature = request.headers["stripe-signature"];
      if (!request.rawBody || typeof signature !== "string") throw new Error("Missing signature or raw body");
      event = stripe.webhooks.constructEvent(request.rawBody, signature, config.stripeWebhookSecret!);
    } catch { return reply.status(400).send(apiError("VALIDATION_ERROR", "Invalid Stripe webhook signature.")); }
    await processBillingEvent(db, stripe, config.stripePriceId!, event);
    return apiSuccess({ received: true });
  });
}

export async function processBillingEvent(db: Database, stripe: Stripe, priceId: string, event: Stripe.Event): Promise<void> {
  const relevant = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "invoice.paid", "invoice.payment_failed", "customer.subscription.updated", "customer.subscription.deleted"];
  if (!relevant.includes(event.type)) return;
  await transaction(db, async (client) => {
    const inserted = await client.query("insert into stripe_events (id) values ($1) on conflict do nothing", [event.id]);
    if (!inserted.rowCount) return;
    const object = event.data.object as Stripe.Checkout.Session | Stripe.Subscription | Stripe.Invoice;
    const customerId = idOf(object.customer);
    const { rows: [owner] } = await client.query<BillingRow>("select * from users where stripe_customer_id = $1 for update", [customerId]);
    if (!owner) return;
    let subId: string | undefined;
    let paidEnd: number | undefined;
    if (event.type.startsWith("checkout.session.")) {
      const session = object as Stripe.Checkout.Session;
      if (session.mode !== "subscription" || session.metadata?.userId !== owner.id || session.id !== owner.checkout_session_id) return;
      subId = idOf(session.subscription);
    } else if (event.type.startsWith("invoice.")) {
      const invoice = await stripe.invoices.retrieve(object.id);
      subId = idOf(invoice.parent?.subscription_details?.subscription);
      if (event.type === "invoice.paid" && invoice.status === "paid") {
        // Invoice line periods are paid entitlement, unlike a subscription's
        // current period which can advance while the renewal invoice is unpaid.
        const lines = await stripe.invoices.listLineItems(invoice.id, { limit: 100 });
        const ends = lines.data.filter((line) => line.pricing?.price_details?.price === priceId && line.parent?.subscription_item_details && !line.parent.subscription_item_details.proration).map((line) => line.period.end);
        if (ends.length) paidEnd = Math.max(...ends);
      }
    } else subId = object.id;
    if (!subId) return;
    const sub = await stripe.subscriptions.retrieve(subId, { expand: ["latest_invoice"] });
    if (idOf(sub.customer) !== customerId || sub.metadata.userId !== owner.id || !sub.items.data.some((item) => item.price.id === priceId)) return;
    // Never let a delayed old subscription overwrite a replacement subscription.
    if (owner.stripe_subscription_id && owner.stripe_subscription_id !== sub.id) {
      const old = await stripe.subscriptions.retrieve(owner.stripe_subscription_id);
      if (!["canceled", "incomplete_expired"].includes(old.status) || old.created >= sub.created) return;
    }
    if (event.type.startsWith("checkout.session.")) {
      const invoice = sub.latest_invoice;
      if (invoice && typeof invoice !== "string" && invoice.status === "paid") {
        const lines = await stripe.invoices.listLineItems(invoice.id, { limit: 100 });
        const ends = lines.data.filter((line) => line.pricing?.price_details?.price === priceId && !line.parent?.subscription_item_details?.proration).map((line) => line.period.end);
        if (ends.length) paidEnd = Math.max(...ends);
      }
    }
    await client.query(`update users set stripe_subscription_id = $1,
      subscription_status = case when subscription_updated_at <= $2 then $3 else subscription_status end,
      subscription_updated_at = greatest(subscription_updated_at, $2),
      subscription_cancel_at_period_end = case when subscription_updated_at <= $2 then $5 else subscription_cancel_at_period_end end,
      subscription_canceled_at = case when subscription_updated_at <= $2 then $6 else subscription_canceled_at end,
      subscription_cancel_at = case when subscription_updated_at <= $2 then $7 else subscription_cancel_at end
      where id = $4`, [sub.id, event.created, sub.status, owner.id, sub.cancel_at_period_end, sub.canceled_at ? new Date(sub.canceled_at * 1000) : null, sub.cancel_at ? new Date(sub.cancel_at * 1000) : null]);
    if (paidEnd) {
      await client.query(`update users set current_period_end = greatest(current_period_end, $1::timestamptz),
        grace_period_end = null, status = case when manual_access or greatest(current_period_end, $1::timestamptz) > now() then 'active' else 'pending' end,
        activated_at = coalesce(activated_at, now()) where id = $2`, [new Date(paidEnd * 1000), owner.id]);
    }
    // No extra free days: the remaining paid period is the grace period agreed
    // in the plan. Failure/cancellation never shortens or extends paid access.
    await client.query(`update users set status = 'pending' where id = $1 and role = 'user' and not manual_access
      and coalesce(current_period_end, '-infinity'::timestamptz) <= now()`, [owner.id]);
  });
}
