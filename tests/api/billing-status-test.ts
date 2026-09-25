import assert from "node:assert/strict";
import Stripe from "stripe";
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
try {
  const registration = await app.inject({ method: "POST", url: "/api/auth/register", payload: {
    username: `billing-regression-${Date.now()}`, password: "test-password"
  } });
  assert.equal(registration.statusCode, 201);
  const { user, token } = registration.json().data;
  userId = user.id;
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
    await db.query("delete from sessions where user_id = $1", [userId]);
    await db.query("delete from users where id = $1", [userId]);
  }
  await closeDatabase();
}
