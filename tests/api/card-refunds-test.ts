import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { buildApp } from "../../src/server/app";
import { loadConfig } from "../../src/server/config";
import { closeDatabase, getDatabase } from "../../src/server/db";

assert.equal(process.env.APP_ENV, "test", "Card refund tests require the isolated database");
const config = {
  ...loadConfig(),
  stripeSecretKey: "sk_test_fixture",
  stripePriceId: "price_card",
  stripeTopupProductId: "prod_wallet",
  stripeWebhookSecret: "refund-fixture",
  stripeLiveMode: false
};
const db = getDatabase(config);
const stripe = new Stripe("sk_test_fixture");
const response = <T>(value: unknown) => value as Stripe.Response<T>;
function list<T>(data: T[]) {
  return Object.assign(Promise.resolve({ data, has_more: false }), {
    async *[Symbol.asyncIterator]() {
      yield* data;
    }
  });
}
type Fixture = {
  userId: string;
  token: string;
  workspaceToken: string;
  sub: Stripe.Subscription;
  charge: Stripe.Charge;
  invoice: Stripe.Invoice;
  refund: Stripe.Refund;
  pi: Stripe.PaymentIntent;
};
const fixtures: Fixture[] = [];
const events: string[] = [];
let cancels = 0;
let failCancel = false;
let loseCancelResponse = false;
stripe.charges.retrieve = async (id) =>
  response<Stripe.Charge>(fixtures.find((f) => f.charge.id === id)!.charge);
stripe.paymentIntents.retrieve = async (id) =>
  response<Stripe.PaymentIntent>(fixtures.find((f) => f.pi.id === id)!.pi);
stripe.refunds.list = ((params: Stripe.RefundListParams) =>
  list(
    fixtures
      .filter((f) => f.charge.id === params.charge || f.pi.id === params.payment_intent)
      .map((f) => f.refund)
  )) as unknown as typeof stripe.refunds.list;
stripe.invoicePayments.list = ((params: Stripe.InvoicePaymentListParams) =>
  list(
    fixtures
      .filter((f) => f.pi.id === params.payment?.payment_intent)
      .map((f) => ({
        invoice: f.invoice.id,
        status: "paid",
        livemode: false,
        payment: { type: "payment_intent", payment_intent: f.pi.id }
      }))
  )) as unknown as typeof stripe.invoicePayments.list;
stripe.invoices.retrieve = async (id) =>
  response<Stripe.Invoice>(fixtures.find((f) => f.invoice.id === id)!.invoice);
stripe.invoices.listLineItems = ((id: string) => {
  const f = fixtures.find((f) => f.invoice.id === id)!;
  return list([
    {
      pricing: { price_details: { price: f.sub.items.data[0].price.id } },
      parent: { subscription_item_details: { proration: false } },
      period: { end: Math.floor(Date.now() / 1000) + 86400 }
    }
  ]);
}) as unknown as typeof stripe.invoices.listLineItems;
stripe.subscriptions.retrieve = async (id) =>
  response<Stripe.Subscription>(fixtures.find((f) => f.sub.id === id)!.sub);
stripe.subscriptions.cancel = async (id, params) => {
  assert.deepEqual(params, { invoice_now: false, prorate: false });
  cancels++;
  if (failCancel) throw new Error("Cancellation temporarily unavailable");
  const sub = fixtures.find((f) => f.sub.id === id)!.sub;
  sub.status = "canceled";
  sub.canceled_at = Math.floor(Date.now() / 1000);
  if (loseCancelResponse) throw new Error("Lost response after successful cancellation");
  return response<Stripe.Subscription>(sub);
};
const app = buildApp(config, { database: db, stripe });
async function fixture() {
  const username = "card-refund-" + randomUUID();
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, password: "test-password" }
  });
  assert.equal(r.statusCode, 201);
  const { user, token } = r.json().data;
  const id = randomUUID();
  const sub = {
    id: "sub_" + id,
    customer: "cus_" + id,
    metadata: { userId: user.id },
    items: { data: [{ price: { id: "price_card" } }] },
    status: "active",
    livemode: false,
    created: 100,
    cancel_at_period_end: false,
    canceled_at: null,
    cancel_at: null
  } as unknown as Stripe.Subscription;
  const invoice = {
    id: "in_" + id,
    customer: sub.customer,
    livemode: false,
    status: "paid",
    parent: { subscription_details: { subscription: sub.id } }
  } as Stripe.Invoice;
  sub.latest_invoice = invoice;
  const pi = { id: "pi_" + id, metadata: {} } as Stripe.PaymentIntent;
  const charge = {
    id: "ch_" + id,
    customer: sub.customer,
    paid: true,
    amount: 1000,
    currency: "hkd",
    livemode: false,
    payment_intent: pi.id
  } as Stripe.Charge;
  const refund = {
    id: "re_" + id,
    charge: charge.id,
    payment_intent: pi.id,
    currency: "hkd",
    amount: 500,
    status: "succeeded"
  } as Stripe.Refund;
  await db.query(
    `update users set stripe_customer_id=$1,stripe_subscription_id=$2,
    current_period_end=now()+interval '1 month', grace_period_end=now()+interval '1 month',
    subscription_status='active',status='active',checkout_session_id=$3 where id=$4`,
    [sub.customer, sub.id, "cs_" + id, user.id]
  );
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password: "test-password" }
  });
  assert.equal(login.statusCode, 200);
  const f = {
    userId: user.id,
    token,
    workspaceToken: login.json().data.token,
    sub,
    charge,
    invoice,
    refund,
    pi
  };
  fixtures.push(f);
  return f;
}
function event(type: Stripe.Event.Type, object: unknown, livemode = false) {
  const id = "evt_" + randomUUID();
  events.push(id);
  return { id, type, livemode, created: Math.floor(Date.now() / 1000), data: { object } };
}
async function deliver(e: ReturnType<typeof event>, valid = true) {
  const payload = JSON.stringify(e);
  return app.inject({
    method: "POST",
    url: "/api/billing/webhook",
    payload,
    headers: {
      "content-type": "application/json",
      "stripe-signature": valid
        ? stripe.webhooks.generateTestHeaderString({ payload, secret: config.stripeWebhookSecret })
        : "invalid"
    }
  });
}
async function status(f: Fixture) {
  return (
    await app.inject({
      method: "GET",
      url: "/api/billing/status",
      headers: { authorization: `Bearer ${f.token}` }
    })
  ).json().data;
}
async function revoked(f: Fixture) {
  const s = await status(f);
  assert.equal(s.active, false);
  assert.equal(s.cardPeriodEnd, null);
  assert.equal(s.gracePeriodEnd, null);
  const access = await app.inject({
    method: "GET",
    url: "/api/tree",
    headers: { authorization: `Bearer ${f.workspaceToken}` }
  });
  assert.equal(access.statusCode, 403, "Existing workspace sessions must lose access immediately");
}
try {
  const partial = await fixture();
  assert.equal((await deliver(event("charge.refunded", partial.charge), false)).statusCode, 400);
  assert.equal((await deliver(event("charge.refunded", partial.charge, true))).statusCode, 400);
  for (const refundStatus of ["pending", "failed", "canceled"] as const) {
    partial.refund.status = refundStatus;
    assert.equal((await deliver(event("refund.updated", partial.refund))).statusCode, 200);
    assert.equal((await status(partial)).active, true);
  }
  assert.equal(cancels, 0);
  partial.refund.status = "succeeded";
  const paidRefund = event("refund.updated", partial.refund);
  assert.equal((await deliver(paidRefund)).statusCode, 200);
  await revoked(partial);
  assert.equal(partial.sub.status, "canceled");
  assert.equal((await status(partial)).status, "canceled");
  await Promise.all([deliver(paidRefund), deliver(paidRefund)]);
  await deliver(event("charge.refunded", partial.charge));
  assert.equal(cancels, 1, "Duplicate refund notifications do not cancel twice");
  for (const e of [
    event("invoice.paid", partial.invoice),
    event("customer.subscription.updated", partial.sub),
    event("customer.subscription.deleted", partial.sub),
    event("checkout.session.completed", {
      id: "cs_" + partial.sub.id.slice(4),
      customer: partial.sub.customer,
      mode: "subscription",
      subscription: partial.sub.id,
      metadata: { userId: partial.userId }
    })
  ])
    assert.equal((await deliver(e)).statusCode, 200);
  await revoked(partial);

  // A fresh subscription can grant access; replaying an old refund must not revoke it.
  const renewed = await fixture();
  await db.query("update users set stripe_subscription_id=null where id=$1", [renewed.userId]);
  renewed.sub.customer = partial.sub.customer;
  renewed.sub.metadata.userId = partial.userId;
  renewed.sub.created = 200;
  renewed.invoice.customer = partial.sub.customer;
  assert.equal((await deliver(event("invoice.paid", renewed.invoice))).statusCode, 200);
  assert.equal((await status(partial)).active, true);
  assert.ok((await status(partial)).cardPeriodEnd);
  await deliver(event("charge.refunded", partial.charge));
  assert.equal((await status(partial)).active, true);
  assert.equal(renewed.sub.status, "active");

  const concurrent = await fixture();
  const concurrentResponses = await Promise.all([
    deliver(event("charge.refunded", concurrent.charge)),
    deliver(event("refund.updated", concurrent.refund))
  ]);
  assert.ok(concurrentResponses.every((r) => r.statusCode === 200));
  await revoked(concurrent);
  assert.equal(
    (
      await db.query("select 1 from refunded_card_subscriptions where subscription_id=$1", [
        concurrent.sub.id
      ])
    ).rowCount,
    1
  );

  const full = await fixture();
  full.refund.amount = 1000;
  assert.equal((await deliver(event("charge.refunded", full.charge))).statusCode, 200);
  await revoked(full);

  const retry = await fixture();
  const retryEvent = event("charge.refunded", retry.charge);
  failCancel = true;
  assert.equal((await deliver(retryEvent)).statusCode, 500);
  await revoked(retry);
  assert.equal(
    (await db.query("select 1 from stripe_events where id=$1", [retryEvent.id])).rowCount,
    0
  );
  await deliver(event("invoice.paid", retry.invoice));
  await revoked(retry);
  failCancel = false;
  assert.equal((await deliver(retryEvent)).statusCode, 200);
  assert.equal(retry.sub.status, "canceled");
  await revoked(retry);

  const lost = await fixture();
  loseCancelResponse = true;
  assert.equal((await deliver(event("charge.refunded", lost.charge))).statusCode, 200);
  loseCancelResponse = false;
  await revoked(lost);

  const early = await fixture();
  await db.query(
    "update users set stripe_subscription_id=null,subscription_status=null,current_period_end=null,grace_period_end=null where id=$1",
    [early.userId]
  );
  assert.equal((await deliver(event("charge.refunded", early.charge))).statusCode, 200);
  await deliver(event("invoice.paid", early.invoice));
  await revoked(early);

  const replaced = await fixture();
  await db.query("update users set stripe_subscription_id='sub_replacement' where id=$1", [
    replaced.userId
  ]);
  const before = (await status(replaced)).cardPeriodEnd;
  assert.equal((await deliver(event("charge.refunded", replaced.charge))).statusCode, 200);
  assert.equal((await status(replaced)).cardPeriodEnd, before);
  assert.equal((await status(replaced)).active, true);
  assert.equal(replaced.sub.status, "canceled");

  const wallet = await fixture();
  await db.query(
    "insert into wallets(user_id,balance,period_end) values($1,2300,now()+interval '1 month')",
    [wallet.userId]
  );
  assert.equal((await deliver(event("charge.refunded", wallet.charge))).statusCode, 200);
  assert.equal((await status(wallet)).active, true);
  assert.equal((await status(wallet)).wallet.balance, 2300);
  assert.equal((await status(wallet)).cardPeriodEnd, null);

  const manual = await fixture();
  await db.query("update users set manual_access=true where id=$1", [manual.userId]);
  await deliver(event("charge.refunded", manual.charge));
  assert.equal((await status(manual)).active, true);

  for (const invalid of ["customer", "price", "owner", "mode", "currency"] as const) {
    const f = await fixture();
    const previous: number = cancels;
    if (invalid === "customer") f.invoice.customer = "cus_other";
    if (invalid === "price") f.sub.items.data[0].price.id = "price_other";
    if (invalid === "owner") f.sub.metadata.userId = randomUUID();
    if (invalid === "mode") f.charge.livemode = true;
    if (invalid === "currency") f.charge.currency = "usd";
    assert.equal((await deliver(event("charge.refunded", f.charge))).statusCode, 200);
    assert.equal(cancels, previous);
    assert.equal((await status(f)).active, true);
  }
  console.log(
    "[card-refunds] partial/full, signatures, pending/failed, retries, lost responses, event ordering, access revocation and isolation passed"
  );
} finally {
  await app.close();
  for (const f of fixtures) await db.query("delete from users where id=$1", [f.userId]);
  await db.query("delete from stripe_events where id=any($1::text[])", [events]);
  await closeDatabase();
}
