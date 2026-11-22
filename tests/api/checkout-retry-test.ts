import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { buildApp } from "../../src/server/app";
import { loadConfig } from "../../src/server/config";
import { closeDatabase, getDatabase } from "../../src/server/db";

assert.equal(process.env.APP_ENV, "test", "Checkout tests require the isolated database");
const config = {
  ...loadConfig(),
  stripeSecretKey: "sk_test_fixture",
  stripePriceId: "price_card",
  stripeTopupProductId: "prod_wallet",
  stripeWebhookSecret: "checkout-fixture",
  stripeLiveMode: false,
  stripeTopupPrices: {}
};
const db = getDatabase(config);
const stripe = new Stripe("sk_test_fixture");
const response = <T>(value: unknown) => value as Stripe.Response<T>;
const customers = new Map<string, { id: string; params: string }>();
const emails = new Map<string, string>();
const users: string[] = [];
let failCheckout = false;
let existingSubscriptions: Stripe.Subscription[] = [];
let checkoutCalls = 0;
stripe.customers.create = async (params, options) => {
  const key = options?.idempotencyKey;
  assert.ok(key);
  const old = customers.get(key);
  // Simulate Stripe rejecting reuse of an idempotency key with changed parameters.
  if (old && old.params !== JSON.stringify(params))
    throw new Error("Idempotency parameter mismatch");
  const customer = old ?? { id: "cus_" + randomUUID(), params: JSON.stringify(params) };
  customers.set(key, customer);
  return response<Stripe.Customer>({ id: customer.id });
};
stripe.customers.update = async (id, params) => {
  if (params?.email) emails.set(id, params.email);
  return response<Stripe.Customer>({ id });
};
stripe.products.retrieve = async () =>
  response<Stripe.Product>({ id: "prod_wallet", active: true, livemode: false });
stripe.prices.retrieve = async () =>
  response<Stripe.Price>({
    id: "price_card",
    active: true,
    currency: "hkd",
    unit_amount: 1000,
    recurring: { interval: "month", interval_count: 1 }
  });
stripe.subscriptions.list = (() =>
  Object.assign(
    Promise.resolve({
      data: existingSubscriptions.slice(0, 100),
      has_more: existingSubscriptions.length > 100
    }),
    {
      async *[Symbol.asyncIterator]() {
        yield* existingSubscriptions;
      }
    }
  )) as unknown as typeof stripe.subscriptions.list;
stripe.checkout.sessions.create = async (params) => {
  checkoutCalls++;
  if (failCheckout) throw new Error("Temporary Checkout outage after customer creation");
  const id = "cs_" + randomUUID();
  assert.equal(params?.managed_payments?.enabled, params?.mode === "subscription");
  return response<Stripe.Checkout.Session>({
    id,
    url: "https://checkout.stripe.com/" + id,
    status: "open",
    expires_at: Math.floor(Date.now() / 1000) + 3600
  });
};
const app = buildApp(config, { database: db, stripe });
async function register() {
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      username: "checkout-retry-" + randomUUID(),
      password: "test-password",
      email: randomUUID() + "@example.test"
    }
  });
  assert.equal(r.statusCode, 201);
  const { user, token } = r.json().data;
  users.push(user.id);
  return { id: user.id, headers: { authorization: `Bearer ${token}` } };
}
async function checkout(
  user: Awaited<ReturnType<typeof register>>,
  kind: "card" | "wallet",
  key = randomUUID()
) {
  return app.inject({
    method: "POST",
    url: kind === "card" ? "/api/billing/checkout-session" : "/api/billing/topups/checkout-session",
    headers: user.headers,
    payload: kind === "wallet" ? { amount: 3000, requestId: key } : undefined
  });
}
try {
  for (const first of ["card", "wallet"] as const) {
    const user = await register();
    const count = customers.size;
    failCheckout = true;
    assert.equal((await checkout(user, first)).statusCode, 500);
    assert.equal(customers.size, count + 1, "Stripe customer survives failed DB transaction");
    assert.equal(
      (await db.query("select stripe_customer_id from users where id=$1", [user.id])).rows[0]
        .stripe_customer_id,
      null
    );
    await app.inject({
      method: "PUT",
      url: "/api/billing/email",
      headers: user.headers,
      payload: { email: "after-" + user.id + "@example.test" }
    });
    failCheckout = false;
    const retry = await checkout(user, first === "card" ? "wallet" : "card");
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(customers.size, count + 1, "Switching payment modes reuses the same customer");
    const customer = customers.get("notes-customer-" + user.id)!;
    assert.equal(
      (await db.query("select stripe_customer_id from users where id=$1", [user.id])).rows[0]
        .stripe_customer_id,
      customer.id
    );
    assert.equal(emails.get(customer.id), "after-" + user.id + "@example.test");
  }
  const user = await register();
  const requestId = randomUUID();
  failCheckout = true;
  await checkout(user, "wallet", requestId);
  await app.inject({
    method: "PUT",
    url: "/api/billing/email",
    headers: user.headers,
    payload: { email: "retry@example.test" }
  });
  failCheckout = false;
  assert.equal((await checkout(user, "wallet", requestId)).statusCode, 200);
  assert.equal(
    (await db.query("select count(*)::int as count from wallet_topups where user_id=$1", [user.id]))
      .rows[0].count,
    1
  );

  const paged = await register();
  existingSubscriptions = Array.from(
    { length: 100 },
    (_, i) => ({ id: "sub_old_" + i, status: "canceled" }) as Stripe.Subscription
  );
  existingSubscriptions.push({ id: "sub_active", status: "active" } as Stripe.Subscription);
  const calls = checkoutCalls;
  assert.equal((await checkout(paged, "card")).statusCode, 409);
  assert.equal(
    checkoutCalls,
    calls,
    "An active subscription after page one blocks duplicate checkout"
  );
  console.log(
    "[checkout-retry] cross-payment recovery, mutable email, persistent top-up intent and subscription pagination passed"
  );
} finally {
  await app.close();
  for (const id of users) await db.query("delete from users where id=$1", [id]);
  await closeDatabase();
}
