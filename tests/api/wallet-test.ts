import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { buildApp } from "../../src/server/app";
import { loadConfig } from "../../src/server/config";
import { closeDatabase, getDatabase, transaction } from "../../src/server/db";
import {
  lockWallet,
  nextMonth,
  postLedger,
  renewWalletLocked
} from "../../src/server/wallet-ledger";
import { processWalletEvent } from "../../src/server/wallet";
import { expirePaidAccess } from "../../src/server/access";

assert.equal(process.env.APP_ENV, "test", "Wallet tests must use an isolated database");
const config = {
  ...loadConfig(),
  stripeSecretKey: "sk_test_fixture",
  stripePriceId: "price_month",
  stripeWebhookSecret: "wallet-fixture",
  stripeTopupProductId: "prod_wallet",
  stripeLiveMode: false,
  stripeTopupPrices: {}
};
const db = getDatabase(config);
const stripe = new Stripe("sk_test_fixture");
const sessions = new Map<string, Stripe.Checkout.Session>();
const charges = new Map<string, Stripe.Charge>();
const intents = new Map<string, Stripe.PaymentIntent>();
let listedSubs: Stripe.Subscription[] = [];
let createCalls = 0;
let refundPending = false;
let failAfterCreate = false;
const idempotent = new Map<string, Stripe.Checkout.Session>();
const response = <T>(x: unknown) => x as Stripe.Response<T>;
stripe.products.retrieve = async () =>
  response<Stripe.Product>({ id: "prod_wallet", active: true, livemode: false });
stripe.customers.create = async (params) =>
  response<Stripe.Customer>({
    id:
      "cus_" +
      (params?.metadata && typeof params.metadata === "object" ? params.metadata.userId : "missing")
  });
stripe.customers.update = async (id) => response<Stripe.Customer>({ id });
stripe.subscriptions.list = (() =>
  Object.assign(Promise.resolve({ data: listedSubs }), {
    async *[Symbol.asyncIterator]() {
      yield* listedSubs;
    }
  })) as unknown as typeof stripe.subscriptions.list;
stripe.subscriptions.retrieve = async (id) =>
  response<Stripe.Subscription>(listedSubs.find((s) => s.id === id) ?? { id, status: "canceled" });
stripe.checkout.sessions.create = async (params, options) => {
  assert.equal(params?.managed_payments?.enabled, false);
  assert.equal(params?.automatic_tax?.enabled, false);
  assert.equal(params?.adaptive_pricing?.enabled, false);
  const previous = idempotent.get(options?.idempotencyKey ?? "");
  if (previous) return response<Stripe.Checkout.Session>(previous);
  createCalls++;
  const id = "cs_" + randomUUID();
  const amount = params?.line_items?.[0].price_data?.unit_amount ?? 1000;
  const piId = "pi_" + randomUUID();
  const session = {
    ...params,
    id,
    url: "https://checkout.stripe.com/test/" + id,
    status: "open",
    payment_status: "unpaid",
    amount_total: amount,
    currency: "hkd",
    livemode: false,
    payment_intent: piId
  } as unknown as Stripe.Checkout.Session;
  sessions.set(id, session);
  idempotent.set(options?.idempotencyKey ?? "", session);
  intents.set(piId, {
    id: piId,
    metadata: params?.payment_intent_data?.metadata,
    amount,
    currency: "hkd"
  } as Stripe.PaymentIntent);
  charges.set("ch_" + piId, {
    id: "ch_" + piId,
    payment_intent: piId,
    amount,
    currency: "hkd",
    amount_refunded: 0,
    customer: params?.customer,
    livemode: false
  } as Stripe.Charge);
  if (failAfterCreate) {
    failAfterCreate = false;
    throw new Error("Simulated network failure after Stripe accepted checkout");
  }
  return response<Stripe.Checkout.Session>(session);
};
stripe.checkout.sessions.retrieve = async (id) =>
  response<Stripe.Checkout.Session>(sessions.get(id));
stripe.checkout.sessions.expire = async (id) => {
  const session = sessions.get(id)!;
  session.status = "expired";
  return response<Stripe.Checkout.Session>(session);
};
stripe.checkout.sessions.listLineItems = (async () =>
  response<Stripe.ApiList<Stripe.LineItem>>({
    data: [{ quantity: 1, price: { product: "prod_wallet" } }],
    has_more: false
  })) as unknown as typeof stripe.checkout.sessions.listLineItems;
stripe.charges.retrieve = async (id) => response<Stripe.Charge>(charges.get(id));
stripe.refunds.list = ((params: { payment_intent: string }) => ({
  async *[Symbol.asyncIterator]() {
    const charge = charges.get("ch_" + params.payment_intent);
    if (charge?.amount_refunded)
      yield {
        amount: charge.amount_refunded,
        currency: "hkd",
        status: refundPending ? "pending" : "succeeded"
      };
  }
})) as unknown as typeof stripe.refunds.list;
stripe.paymentIntents.retrieve = async (id) => response<Stripe.PaymentIntent>(intents.get(id));
const app = buildApp(config, { database: db, stripe });
const users: string[] = [];
const events: string[] = [];
async function register() {
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      username: "wallet-" + randomUUID(),
      password: "test-password",
      email: randomUUID() + "@example.test"
    }
  });
  assert.equal(r.statusCode, 201, r.body);
  const { user, token } = r.json().data;
  users.push(user.id);
  return { id: user.id, headers: { authorization: "Bearer " + token } };
}
type User = Awaited<ReturnType<typeof register>>;
async function status(user: User) {
  const r = await app.inject({ method: "GET", url: "/api/billing/status", headers: user.headers });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().data;
}
async function topup(user: User, amount = 3000, key = randomUUID()) {
  const r = await app.inject({
    method: "POST",
    url: "/api/billing/topups/checkout-session",
    headers: user.headers,
    payload: { amount, requestId: key }
  });
  assert.equal(r.statusCode, 200, r.body);
  const order = r.json().data;
  const {
    rows: [stored]
  } = await db.query("select * from wallet_topups where id=$1", [order.orderId]);
  return { order, session: sessions.get(stored.session_id)!, key };
}
function event(type: string, object: unknown) {
  const id = "evt_wallet_" + randomUUID();
  events.push(id);
  return {
    id,
    type,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object }
  } as Stripe.Event;
}
async function deliver(e: Stripe.Event) {
  const payload = JSON.stringify(e);
  return app.inject({
    method: "POST",
    url: "/api/billing/webhook",
    payload,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripe.webhooks.generateTestHeaderString({
        payload,
        secret: config.stripeWebhookSecret
      })
    }
  });
}
async function paid(t: Awaited<ReturnType<typeof topup>>) {
  t.session.status = "complete";
  t.session.payment_status = "paid";
  const e = event("checkout.session.completed", t.session);
  const r = await deliver(e);
  assert.equal(r.statusCode, 200, r.body);
  return e;
}
try {
  assert.equal(
    nextMonth(new Date("2028-01-31T12:34:56Z"), 31).toISOString(),
    "2028-02-29T12:34:56.000Z"
  );
  assert.equal(
    nextMonth(new Date("2028-02-29T12:34:56Z"), 31).toISOString(),
    "2028-03-31T12:34:56.000Z"
  );
  const u = await register(),
    other = await register();
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/billing/wallet/transactions" })).statusCode,
    401
  );
  for (const amount of [999, 100001, 1001, 10.5, "1000"]) {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/billing/topups/checkout-session",
          headers: u.headers,
          payload: { amount, requestId: randomUUID() }
        })
      ).statusCode,
      400
    );
  }
  const t = await topup(u);
  assert.equal((await status(u)).wallet.balance, 0);
  assert.equal((await status(u)).active, false, "Pending checkout does not grant access");
  const duplicate = await topup(u, 3000, t.key);
  assert.equal(duplicate.order.orderId, t.order.orderId);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/billing/topups/" + t.order.orderId,
        headers: other.headers
      })
    ).statusCode,
    404
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/billing/webhook",
        payload: {},
        headers: { "stripe-signature": "invalid" }
      })
    ).statusCode,
    400
  );
  const goodAmount = t.session.amount_total;
  t.session.amount_total = 9000;
  const bad = event("checkout.session.completed", t.session);
  assert.equal((await deliver(bad)).statusCode, 500);
  t.session.amount_total = goodAmount;
  const e = await paid(t);
  await Promise.all([
    deliver(e),
    deliver(event("checkout.session.async_payment_succeeded", t.session))
  ]);
  assert.equal(
    (await status(u)).wallet.balance,
    3000,
    "Different Stripe events cannot double credit the same session"
  );
  assert.equal((await status(u)).active, false, "Top-up alone does not subscribe");
  const attempts = await Promise.all(
    [1, 2, 3].map(() =>
      app.inject({ method: "POST", url: "/api/billing/wallet/subscription", headers: u.headers })
    )
  );
  for (const r of attempts) assert.equal(r.statusCode, 200, r.body);
  assert.equal(
    (await status(u)).wallet.balance,
    2000,
    "Concurrent subscription requests debit once"
  );
  assert.equal((await status(u)).active, true);
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/billing/checkout-session", headers: u.headers }))
      .statusCode,
    409
  );
  await app.inject({
    method: "DELETE",
    url: "/api/billing/wallet/subscription",
    headers: u.headers
  });
  assert.equal((await status(u)).active, true, "Cancellation retains paid time");
  await app.inject({ method: "POST", url: "/api/billing/wallet/subscription", headers: u.headers });
  assert.equal((await status(u)).wallet.balance, 2000, "Resuming paid wallet time is free");
  await db.query("update wallets set period_end=now()-interval '1 second' where user_id=$1", [
    u.id
  ]);
  await Promise.all([expirePaidAccess(db), expirePaidAccess(db)]);
  assert.equal((await status(u)).wallet.balance, 1000, "Concurrent renewal debits once");
  await db.query("update wallets set period_end=now()-interval '1 second' where user_id=$1", [
    u.id
  ]);
  await expirePaidAccess(db);
  assert.equal((await status(u)).wallet.balance, 0);
  await db.query("update wallets set period_end=now()-interval '1 day' where user_id=$1", [u.id]);
  assert.equal((await status(u)).active, false, "Wallet-only subscriptions expire");
  await db.query(
    "update wallets set period_end=now()-interval '10 seconds',paused=false where user_id=$1",
    [u.id]
  );
  const recoveryStart = Date.now();
  const recovery = await topup(u, 1000);
  await paid(recovery);
  const resumedEnd = new Date((await status(u)).wallet.periodEnd);
  assert.ok(
    resumedEnd >= nextMonth(new Date(recoveryStart), new Date(recoveryStart).getUTCDate()),
    "Recovery starts from payment time"
  );
  assert.equal((await status(u)).active, true);
  assert.equal((await status(u)).wallet.balance, 0);
  const charge = charges.get("ch_" + recovery.session.payment_intent)!;
  charge.amount_refunded = 1000;
  refundPending = true;
  await deliver(event("refund.updated", { id: "re_pending", charge: charge.id }));
  assert.equal((await status(u)).wallet.balance, 0, "Pending refund must not reduce balance");
  refundPending = false;
  const refund = event("charge.refunded", charge);
  assert.equal((await deliver(refund)).statusCode, 200);
  await deliver(refund);
  assert.equal((await status(u)).wallet.balance, -1000);
  assert.equal((await status(u)).active, true, "Refund does not remove paid time");
  await db.query("update wallets set period_end=now()-interval '1 second' where user_id=$1", [
    u.id
  ]);
  assert.equal((await status(u)).active, false, "Negative balance cannot renew");
  const beforeRefund = await topup(other, 3000);
  const ch = charges.get("ch_" + beforeRefund.session.payment_intent)!;
  ch.amount_refunded = 500;
  assert.equal((await deliver(event("charge.refunded", ch))).statusCode, 200);
  await paid(beforeRefund);
  assert.equal((await status(other)).wallet.balance, 2500, "Refund before credit is applied once");
  const dispute = { id: "dp_" + randomUUID(), charge: ch.id, amount: 3000, currency: "hkd" };
  const withdrawn = event("charge.dispute.funds_withdrawn", dispute);
  await deliver(withdrawn);
  assert.equal(
    (await status(other)).wallet.balance,
    0,
    "Refund and dispute cannot reverse more than the top-up"
  );
  await deliver(event("charge.dispute.funds_reinstated", dispute));
  assert.equal((await status(other)).wallet.balance, 2500);
  await deliver(event("charge.dispute.funds_withdrawn", dispute));
  assert.equal(
    (await status(other)).wallet.balance,
    2500,
    "Late withdrawal cannot undo reinstatement"
  );
  const mismatch = event("checkout.session.completed", beforeRefund.session);
  mismatch.livemode = true;
  assert.equal((await deliver(mismatch)).statusCode, 400);
  const third = await register();
  const expired = await topup(third);
  expired.session.status = "expired";
  await deliver(event("checkout.session.expired", expired.session));
  assert.equal((await status(third)).wallet.balance, 0);
  const failed = await topup(third);
  await deliver(event("checkout.session.async_payment_failed", failed.session));
  assert.equal((await status(third)).wallet.balance, 0);
  const key = randomUUID();
  failAfterCreate = true;
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/billing/topups/checkout-session",
        headers: third.headers,
        payload: { amount: 3000, requestId: key }
      })
    ).statusCode,
    500
  );
  const count = createCalls;
  await topup(third, 3000, key);
  assert.equal(createCalls, count, "Retry after response loss reuses Stripe idempotency key");
  await transaction(db, async (client) => {
    await lockWallet(client, third.id);
    await postLedger(client, third.id, 1000, "topup", "test-seed:" + third.id);
  });
  listedSubs = [{ id: "sub_active", status: "active" } as Stripe.Subscription];
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/billing/wallet/subscription",
        headers: third.headers
      })
    ).statusCode,
    409
  );
  listedSubs = [];
  const open = {
    id: "cs_card_open",
    status: "open",
    mode: "subscription"
  } as Stripe.Checkout.Session;
  sessions.set(open.id, open);
  await db.query("update users set checkout_session_id=$2 where id=$1", [third.id, open.id]);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/billing/wallet/subscription",
        headers: third.headers
      })
    ).statusCode,
    200
  );
  assert.equal(open.status, "expired", "Switching closes pending card checkout");
  await db.query(
    "update wallets set period_end='2028-01-31T12:00:00Z',anchor_day=31 where user_id=$1",
    [third.id]
  );
  await transaction(db, async (client) => {
    await lockWallet(client, third.id);
    await postLedger(client, third.id, 3000, "topup", "test-calendar:" + third.id);
    await renewWalletLocked(client, third.id, new Date("2028-01-31T12:00:01Z"));
  });
  let {
    rows: [w]
  } = await db.query("select * from wallets where user_id=$1", [third.id]);
  assert.equal(w.period_end.toISOString(), "2028-02-29T12:00:00.000Z");
  await transaction(db, (client) =>
    renewWalletLocked(client, third.id, new Date("2028-02-29T12:00:01Z"))
  );
  ({
    rows: [w]
  } = await db.query("select * from wallets where user_id=$1", [third.id]));
  assert.equal(w.period_end.toISOString(), "2028-03-31T12:00:00.000Z");
  for (let i = 0; i < 25; i++)
    await transaction(db, async (client) => {
      await lockWallet(client, other.id);
      await postLedger(client, other.id, 100, "topup", "page:" + other.id + ":" + i);
    });
  const page = (
    await app.inject({
      method: "GET",
      url: "/api/billing/wallet/transactions",
      headers: other.headers
    })
  ).json().data;
  assert.equal(page.transactions.length, 20);
  assert.ok(page.nextCursor);
  const page2 = (
    await app.inject({
      method: "GET",
      url: "/api/billing/wallet/transactions?before=" + page.nextCursor,
      headers: other.headers
    })
  ).json().data;
  assert.ok(page2.transactions.length);
  assert.ok(
    !page2.transactions.some((r: { id: string }) =>
      page.transactions.some((p: { id: string }) => p.id === r.id)
    )
  );
  const { rows: balances } = await db.query(
    "select w.user_id,w.balance,coalesce(sum(l.amount),0)::integer as total from wallets w left join wallet_ledger l on l.user_id=w.user_id where w.user_id=any($1::uuid[]) group by w.user_id",
    [users]
  );
  for (const b of balances) assert.equal(b.balance, b.total, "Ledger matches balance");
  assert.equal(await processWalletEvent(db, stripe, config, event("invoice.paid", {})), false);
  console.log(
    "[wallet] validation, isolation, signed webhooks, idempotency, concurrency, expiry, recovery, switching, refunds, disputes, calendar and pagination passed"
  );
} finally {
  await app.close();
  await db.query("delete from stripe_events where id=any($1::text[])", [events]);
  await db.query("delete from users where id=any($1::uuid[])", [users]);
  await closeDatabase();
}
