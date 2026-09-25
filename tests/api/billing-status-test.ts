import assert from "node:assert/strict";
import Stripe from "stripe";
import { processBillingEvent } from "../../src/server/billing";
import { buildApp } from "../../src/server/app";
import { loadConfig } from "../../src/server/config";
import { closeDatabase, getDatabase } from "../../src/server/db";

assert.equal(process.env.APP_ENV, "test", "Run only in the isolated test environment");
const config = { ...loadConfig(), stripePriceId: "price_fixture", stripeWebhookSecret: "fixture" };
const db = getDatabase(config);
const stripe = new Stripe("sk_test_fixture");
stripe.subscriptions.retrieve = async () => { throw new Error("Status must not call Stripe"); };
const app = buildApp(config, { database: db, stripe });
let userId: string | undefined;
const eventPrefix = `evt_cancellation_${Date.now()}_`;
try {
  const registration = await app.inject({ method: "POST", url: "/api/auth/register", payload: {
    username: `billing-regression-${Date.now()}`, password: "test-password"
  } });
  assert.equal(registration.statusCode, 201);
  const { user, token } = registration.json().data;
  userId = user.id;
  assert.ok(userId);
  const headers = { authorization: `Bearer ${token}` };
  const paidEnd = new Date(Date.now() + 86_400_000);
  const canceledAt = new Date();
  await db.query(`update users set stripe_subscription_id = 'sub_fixture',
    subscription_status = 'active', status = 'active', current_period_end = $1,
    subscription_cancel_at_period_end = true, subscription_canceled_at = $2 where id = $3`,
    [paidEnd, canceledAt, userId]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.inject({ method: "GET", url: "/api/billing/status", headers });
    assert.equal(response.statusCode, 200);
    const data = response.json().data;
    assert.equal(data.active, true);
    assert.equal(data.cancelAtPeriodEnd, true);
    assert.equal(data.canceledAt, canceledAt.toISOString());
    assert.equal(data.currentPeriodEnd, paidEnd.toISOString());
  }
  // Exercise webhook ingestion, not just a pre-populated cancellation flag.
  await db.query("update users set stripe_customer_id = 'cus_fixture' where id = $1", [userId]);
  let subscription: { id: string; customer: string; status: string; metadata: { userId: string }; items: { data: { price: { id: string } }[] }; cancel_at_period_end: boolean; cancel_at: number | null; canceled_at: number | null } = {
    id: "sub_fixture", customer: "cus_fixture", status: "active",
    metadata: { userId }, items: { data: [{ price: { id: "price_fixture" } }] },
    cancel_at_period_end: false, cancel_at: Math.floor(paidEnd.getTime() / 1000),
    canceled_at: Math.floor(canceledAt.getTime() / 1000)
  };
  let eventNumber = 0;
  async function sendUpdate(created: number) {
    stripe.subscriptions.retrieve = async () => subscription as unknown as Stripe.Response<Stripe.Subscription>;
    try {
      await processBillingEvent(db, stripe, "price_fixture", {
        id: `${eventPrefix}${++eventNumber}`, type: "customer.subscription.updated", created,
        data: { object: { id: "sub_fixture", customer: "cus_fixture" } }
      } as Stripe.Event);
    } finally {
      stripe.subscriptions.retrieve = async () => { throw new Error("Status must not call Stripe"); };
    }
    const response = await app.inject({ method: "GET", url: "/api/billing/status", headers });
    assert.equal(response.statusCode, 200);
    const data = response.json().data;
    assert.equal(data.currentPeriodEnd, paidEnd.toISOString());
    assert.equal(data.active, true);
    return data;
  }
  const scheduled = await sendUpdate(100);
  assert.equal(scheduled.cancelAtPeriodEnd, false);
  assert.equal(scheduled.cancelAt, new Date(subscription.cancel_at! * 1000).toISOString());
  assert.equal(scheduled.status, "active");

  subscription = { ...subscription, cancel_at_period_end: true };
  assert.equal((await sendUpdate(101)).cancelAtPeriodEnd, true);

  // Stripe clears both fields when the user resumes automatic renewal.
  subscription = { ...subscription, cancel_at_period_end: false, cancel_at: null, canceled_at: null };
  const resumed = await sendUpdate(102);
  assert.equal(resumed.cancelAt, null);
  assert.equal(resumed.cancelAtPeriodEnd, false);
  assert.equal(resumed.canceledAt, null);

  subscription = { ...subscription, cancel_at: Math.floor(paidEnd.getTime() / 1000) };
  assert.equal((await sendUpdate(101)).cancelAt, null, "Old events cannot restore cancellation");

  subscription = { ...subscription, status: "canceled", cancel_at: null };
  assert.equal((await sendUpdate(103)).status, "canceled");
  const { rows: [stored] } = await db.query("select current_period_end from users where id = $1", [userId]);
  assert.equal(stored.current_period_end.toISOString(), paidEnd.toISOString());
  await db.query("update users set current_period_end = now() - interval '1 day' where id = $1", [userId]);
  const expired = await app.inject({ method: "GET", url: "/api/billing/status", headers });
  assert.equal(expired.statusCode, 200);
  assert.equal(expired.json().data.active, false);
  const workspace = await app.inject({ method: "POST", url: "/api/billing/workspace-session", headers });
  assert.equal(workspace.statusCode, 403);
  console.log("[billing-status] paid access, cancellation and expiry passed");
} finally {
  await app.close();
  if (userId) {
    await db.query("delete from stripe_events where id like $1", [`${eventPrefix}%`]);
    await db.query("delete from sessions where user_id = $1", [userId]);
    await db.query("delete from users where id = $1", [userId]);
  }
  await closeDatabase();
}
