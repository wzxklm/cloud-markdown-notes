import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { FastifyInstance } from "fastify";
import { apiSuccess } from "../shared/api";
import { makeBillingAuthenticate, requireCurrentUser } from "./auth";
import type { AppConfig } from "./config";
import { transaction, type Database } from "./db";
import { WorkspaceError } from "./workspace";
import { lockWallet, monthlyAmount, postLedger, renewWalletLocked } from "./wallet-ledger";
import type pg from "pg";

type Topup = {
  id: string;
  user_id: string;
  amount: number;
  status: string;
  session_id: string | null;
  payment_intent_id: string | null;
  refunded: number;
  reversed: number;
  created_at: Date;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : v?.id);
function fail(message: string, status = 409): never {
  throw new WorkspaceError(
    status === 400 ? "VALIDATION_ERROR" : "CHECKOUT_NOT_READY",
    message,
    status
  );
}
export const walletEnabled = (config: AppConfig, stripe?: Stripe) =>
  Boolean(stripe && config.stripeTopupProductId && config.stripeWebhookSecret);
export function registerWalletRoutes(
  app: FastifyInstance,
  config: AppConfig,
  db: Database,
  stripe?: Stripe
): void {
  const authenticate = makeBillingAuthenticate(config, db);
  const paymentClient = () => {
    if (!stripe || !walletEnabled(config, stripe))
      throw new WorkspaceError(
        "BILLING_NOT_CONFIGURED",
        "Balance payments are not configured.",
        503
      );
    return stripe;
  };
  app.get<{ Querystring: { before?: string } }>(
    "/api/billing/wallet/transactions",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) return;
      const before = request.query.before;
      if (before && !/^[1-9][0-9]{0,18}$/.test(before)) fail("Invalid transaction cursor.", 400);
      const { rows } = await db.query(
        'select id::text,amount,balance_after as "balanceAfter",kind,created_at as "createdAt" from wallet_ledger where user_id=$1 and ($2::bigint is null or id<$2::bigint) order by wallet_ledger.id desc limit 21',
        [user.id, before ?? null]
      );
      return apiSuccess({
        transactions: rows.slice(0, 20),
        nextCursor: rows.length > 20 ? rows[19].id : null
      });
    }
  );
  app.get<{ Params: { id: string } }>(
    "/api/billing/topups/:id",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) return;
      if (!uuid.test(request.params.id)) fail("Invalid top-up ID.", 400);
      const {
        rows: [order]
      } = await db.query(
        'select id,amount,status,refunded,reversed,created_at as "createdAt" from wallet_topups where id=$1 and user_id=$2',
        [request.params.id, user.id]
      );
      if (!order) throw new WorkspaceError("PATH_NOT_FOUND", "Top-up not found.", 404);
      return apiSuccess(order);
    }
  );
  app.post<{ Body: { amount?: unknown; requestId?: unknown } }>(
    "/api/billing/topups/checkout-session",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) return;
      const remote = paymentClient();
      const { amount, requestId } = request.body ?? {};
      if (
        typeof amount !== "number" ||
        !Number.isInteger(amount) ||
        amount < 1000 ||
        amount > 100000 ||
        amount % 100 !== 0 ||
        typeof requestId !== "string" ||
        !uuid.test(requestId)
      )
        fail("Choose HKD 10–1000 in whole dollars and supply a request UUID.", 400);
      const cents = amount as number;
      const key = requestId as string;
      // Persist the intent before contacting Stripe: retrying an interrupted request reuses it.
      const order = await transaction(db, async (client) => {
        await lockWallet(client, user.id);
        const {
          rows: [owner]
        } = await client.query("select email from users where id=$1", [user.id]);
        if (!owner.email) fail("Add your email before topping up.");
        const {
          rows: [old]
        } = await client.query<Topup>(
          "select * from wallet_topups where user_id=$1 and request_id=$2",
          [user.id, key]
        );
        if (old) {
          if (old.amount !== cents) fail("This request ID belongs to another amount.");
          return old;
        }
        const {
          rows: [created]
        } = await client.query<Topup>(
          "insert into wallet_topups(id,user_id,request_id,amount) values($1,$2,$3,$4) returning *",
          [randomUUID(), user.id, key, cents]
        );
        return created;
      });
      if (order.status !== "pending")
        fail("This top-up is already completed or closed. Start a new top-up.");
      if (order.session_id) {
        const session = await remote.checkout.sessions.retrieve(order.session_id);
        if (session.status === "open" && session.url)
          return apiSuccess({ url: session.url, orderId: order.id });
        fail(
          "This checkout is closed or awaiting payment confirmation. Check its status before paying again."
        );
      }
      if (Date.now() - order.created_at.getTime() > 23 * 60 * 60 * 1000)
        fail(
          "This unfinished request has expired. Check payment history before starting a new top-up."
        );
      const session = await transaction(db, async (client) => {
        await lockWallet(client, user.id);
        const {
          rows: [owner]
        } = await client.query("select email,stripe_customer_id from users where id=$1", [user.id]);
        let customer = owner.stripe_customer_id as string | null;
        if (!customer) {
          customer = (
            await remote.customers.create(
              { metadata: { userId: user.id } },
              { idempotencyKey: "notes-customer-" + user.id }
            )
          ).id;
          await client.query("update users set stripe_customer_id=$1 where id=$2", [
            customer,
            user.id
          ]);
        }
        // Share identical idempotent customer creation with card checkout; email is mutable.
        await remote.customers.update(customer, { email: owner.email });
        const product = await remote.products.retrieve(config.stripeTopupProductId!);
        if (product.deleted || !product.active || product.livemode !== config.stripeLiveMode)
          throw new Error("Top-up product environment or availability mismatch");
        const priceId = config.stripeTopupPrices?.[cents];
        if (priceId) {
          const price = await remote.prices.retrieve(priceId);
          if (
            !price.active ||
            price.type !== "one_time" ||
            price.currency !== "hkd" ||
            price.unit_amount !== cents ||
            idOf(price.product) !== product.id
          )
            throw new Error("Top-up price mismatch");
        }
        const created = await remote.checkout.sessions.create(
          {
            mode: "payment",
            customer,
            client_reference_id: user.id,
            managed_payments: { enabled: false },
            automatic_tax: { enabled: false },
            adaptive_pricing: { enabled: false },
            line_items: [
              priceId
                ? { price: priceId, quantity: 1 }
                : {
                    price_data: { currency: "hkd", product: product.id, unit_amount: cents },
                    quantity: 1
                  }
            ],
            metadata: { userId: user.id, topupId: order.id, purpose: "wallet_topup" },
            payment_intent_data: {
              metadata: { userId: user.id, topupId: order.id, purpose: "wallet_topup" }
            },
            success_url: config.publicBaseUrl + "/billing?topup=" + order.id,
            cancel_url: config.publicBaseUrl + "/billing?topup=" + order.id + "&checkout=cancelled"
          },
          { idempotencyKey: "notes-topup-" + order.id }
        );
        await client.query("update wallet_topups set session_id=$2 where id=$1", [
          order.id,
          created.id
        ]);
        return created;
      });
      return apiSuccess({ url: session.url, orderId: order.id });
    }
  );
  app.post(
    "/api/billing/wallet/subscription",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) return;
      const remote = paymentClient();
      await transaction(db, async (client) => {
        const wallet = await lockWallet(client, user.id);
        const {
          rows: [owner]
        } = await client.query("select * from users where id=$1", [user.id]);
        if (wallet.auto_renew) return;
        if (owner.manual_access)
          fail("Administrator access is already enabled; no paid subscription is needed.");
        if (owner.current_period_end && owner.current_period_end > new Date())
          fail("Wait until your card-paid access ends before switching to balance.");
        if (owner.stripe_customer_id) {
          for await (const sub of remote.subscriptions.list({
            customer: owner.stripe_customer_id,
            status: "all",
            limit: 100
          })) {
            if (!["canceled", "incomplete_expired"].includes(sub.status))
              fail("Cancel your card subscription in the portal and wait until it ends.");
          }
        }
        if (owner.stripe_subscription_id) {
          const previous = await remote.subscriptions.retrieve(owner.stripe_subscription_id);
          if (!["canceled", "incomplete_expired"].includes(previous.status))
            fail("Your previous card subscription has not ended.");
          await client.query("update users set subscription_status=$2 where id=$1", [
            user.id,
            previous.status
          ]);
        }
        if (owner.checkout_session_id) {
          let checkout = await remote.checkout.sessions.retrieve(owner.checkout_session_id);
          if (checkout.status === "open")
            checkout = await remote.checkout.sessions.expire(checkout.id);
          if (checkout.status === "complete") {
            const subId = idOf(checkout.subscription);
            if (!subId) fail("Card payment is still processing.");
            const sub = await remote.subscriptions.retrieve(subId);
            if (!["canceled", "incomplete_expired"].includes(sub.status))
              fail("Card subscription is still active or processing.");
            if (checkout.payment_status !== "paid" && sub.status !== "incomplete_expired")
              fail("Card payment is still processing.");
          }
        }
        if (
          (!wallet.period_end || wallet.period_end <= new Date()) &&
          wallet.balance < monthlyAmount
        )
          throw new WorkspaceError("PAYMENT_REQUIRED", "At least HKD 10 balance is required.", 402);
        await client.query("update wallets set auto_renew=true where user_id=$1", [user.id]);
        await renewWalletLocked(client, user.id);
      });
      return apiSuccess({ autoRenew: true });
    }
  );
  app.delete(
    "/api/billing/wallet/subscription",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) return;
      await transaction(db, async (client) => {
        await lockWallet(client, user.id);
        await client.query("update wallets set auto_renew=false where user_id=$1", [user.id]);
      });
      return apiSuccess({ autoRenew: false });
    }
  );
}
async function reconcileReversal(
  client: pg.PoolClient,
  order: Topup,
  reference: string
): Promise<void> {
  const {
    rows: [disputes]
  } = await client.query(
    "select coalesce(sum(amount),0)::integer as amount from wallet_disputes where topup_id=$1 and withdrawn and not reinstated",
    [order.id]
  );
  const target = Math.min(order.amount, order.refunded + disputes.amount);
  if (order.status === "paid" && target !== order.reversed)
    await postLedger(
      client,
      order.user_id,
      order.reversed - target,
      "reversal",
      "reversal:" + reference
    );
  await client.query("update wallet_topups set reversed=$2 where id=$1", [order.id, target]);
}
export async function processWalletEvent(
  db: Database,
  stripe: Stripe,
  config: AppConfig,
  event: Stripe.Event
): Promise<boolean> {
  if (event.livemode !== config.stripeLiveMode)
    throw new Error("Stripe event environment mismatch");
  if (event.type.startsWith("checkout.session.")) {
    const object = event.data.object as Stripe.Checkout.Session;
    if (object.mode !== "payment") return false;
    if (object.metadata?.purpose !== "wallet_topup") return true;
    const session = await stripe.checkout.sessions.retrieve(object.id);
    const topupId = session.metadata?.topupId;
    if (!topupId || !uuid.test(topupId)) throw new Error("Missing top-up reference");
    const lines = await stripe.checkout.sessions.listLineItems(session.id, { limit: 2 });
    await transaction(db, async (client) => {
      const {
        rows: [candidate]
      } = await client.query<Topup>("select * from wallet_topups where id=$1", [topupId]);
      if (!candidate) throw new Error("Unknown top-up; retry after order persistence");
      const beforeCredit = await lockWallet(client, candidate.user_id);
      const inserted = await client.query(
        "insert into stripe_events(id) values($1) on conflict do nothing",
        [event.id]
      );
      if (!inserted.rowCount) return;
      const {
        rows: [order]
      } = await client.query<Topup>("select * from wallet_topups where id=$1 for update", [
        topupId
      ]);
      const {
        rows: [owner]
      } = await client.query("select stripe_customer_id from users where id=$1", [order.user_id]);
      if (
        session.livemode !== config.stripeLiveMode ||
        session.mode !== "payment" ||
        session.metadata?.userId !== order.user_id ||
        session.client_reference_id !== order.user_id ||
        idOf(session.customer) !== owner.stripe_customer_id ||
        (order.session_id && session.id !== order.session_id) ||
        session.currency !== "hkd" ||
        session.amount_total !== order.amount ||
        lines.data.length !== 1 ||
        lines.has_more ||
        lines.data[0].quantity !== 1 ||
        idOf(lines.data[0].price?.product) !== config.stripeTopupProductId
      )
        throw new Error("Top-up payment verification failed");
      const piId = idOf(session.payment_intent);
      await client.query(
        "update wallet_topups set session_id=$2,payment_intent_id=coalesce($3,payment_intent_id) where id=$1",
        [order.id, session.id, piId ?? null]
      );
      if (session.status === "complete" && session.payment_status === "paid") {
        if (!piId) throw new Error("Missing paid PaymentIntent");
        if (order.status !== "paid") {
          if (
            beforeCredit.auto_renew &&
            beforeCredit.period_end &&
            beforeCredit.period_end <= new Date() &&
            beforeCredit.balance < monthlyAmount
          )
            await client.query("update wallets set paused=true where user_id=$1", [order.user_id]);
          await postLedger(client, order.user_id, order.amount, "topup", "topup:" + order.id);
          // A refund/dispute may have arrived before the completion event.
          if (order.reversed)
            await postLedger(
              client,
              order.user_id,
              -order.reversed,
              "reversal",
              "prepaid-reversal:" + order.id
            );
          await client.query("update wallet_topups set status='paid' where id=$1", [order.id]);
        }
        await renewWalletLocked(client, order.user_id);
      } else if (
        order.status !== "paid" &&
        (session.status === "expired" || event.type === "checkout.session.async_payment_failed")
      ) {
        await client.query("update wallet_topups set status=$2 where id=$1", [
          order.id,
          session.status === "expired" ? "expired" : "failed"
        ]);
      }
    });
    return true;
  }
  const reversing = [
    "charge.refunded",
    "refund.updated",
    "charge.dispute.funds_withdrawn",
    "charge.dispute.funds_reinstated"
  ];
  if (!reversing.includes(event.type)) return false;
  const object = event.data.object as Stripe.Charge | Stripe.Refund | Stripe.Dispute;
  const chargeId =
    event.type === "charge.refunded"
      ? object.id
      : idOf((object as Stripe.Refund | Stripe.Dispute).charge);
  if (!chargeId) return true;
  const charge = await stripe.charges.retrieve(chargeId);
  const piId = idOf(charge.payment_intent);
  if (!piId) return true;
  const pi = await stripe.paymentIntents.retrieve(piId);
  if (pi.metadata.purpose !== "wallet_topup") return false;
  let successfulRefunds = 0;
  for await (const refund of stripe.refunds.list({ payment_intent: piId, limit: 100 })) {
    if (refund.status === "succeeded" && refund.currency === "hkd")
      successfulRefunds += refund.amount;
  }
  const topupId = pi.metadata.topupId;
  if (!uuid.test(topupId ?? "")) throw new Error("Invalid top-up reversal reference");
  await transaction(db, async (client) => {
    const {
      rows: [candidate]
    } = await client.query<Topup>("select * from wallet_topups where id=$1", [topupId]);
    if (!candidate) throw new Error("Unknown top-up reversal");
    await lockWallet(client, candidate.user_id);
    const inserted = await client.query(
      "insert into stripe_events(id) values($1) on conflict do nothing",
      [event.id]
    );
    if (!inserted.rowCount) return;
    const {
      rows: [order]
    } = await client.query<Topup>("select * from wallet_topups where id=$1 for update", [topupId]);
    const {
      rows: [owner]
    } = await client.query("select stripe_customer_id from users where id=$1", [order.user_id]);
    if (
      charge.livemode !== config.stripeLiveMode ||
      charge.currency !== "hkd" ||
      charge.amount !== order.amount ||
      idOf(charge.customer) !== owner.stripe_customer_id ||
      pi.metadata.userId !== order.user_id ||
      (order.payment_intent_id && order.payment_intent_id !== piId)
    )
      throw new Error("Top-up reversal verification failed");
    // Successful refunded amount is monotonic; stale deliveries cannot undo a refund.
    order.refunded = Math.max(order.refunded, successfulRefunds);
    await client.query("update wallet_topups set refunded=$2,payment_intent_id=$3 where id=$1", [
      order.id,
      order.refunded,
      piId
    ]);
    if (event.type.startsWith("charge.dispute.")) {
      const dispute = object as Stripe.Dispute;
      if (dispute.currency !== "hkd" || dispute.amount > order.amount)
        throw new Error("Dispute currency or amount mismatch");
      await client.query(
        `insert into wallet_disputes(id,topup_id,amount,withdrawn,reinstated) values($1,$2,$3,$4,$5)
        on conflict(id) do update set withdrawn=wallet_disputes.withdrawn or excluded.withdrawn,reinstated=wallet_disputes.reinstated or excluded.reinstated`,
        [
          dispute.id,
          order.id,
          dispute.amount,
          event.type === "charge.dispute.funds_withdrawn",
          event.type === "charge.dispute.funds_reinstated"
        ]
      );
    }
    await reconcileReversal(client, order, event.id);
  });
  return true;
}
