import type Stripe from "stripe";
import { transaction, type Database } from "./db";

const idOf = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : value?.id;

// Refund revocation is durable before calling Stripe. A failed cancellation returns
// non-2xx so Stripe retries, without restoring local access in the meantime.
export async function processCardRefund(
  db: Database,
  stripe: Stripe,
  priceId: string,
  event: Stripe.Event
): Promise<void> {
  if ((await db.query("select 1 from stripe_events where id=$1", [event.id])).rowCount) return;
  const object = event.data.object as Stripe.Charge | Stripe.Refund;
  const chargeId =
    event.type === "charge.refunded" ? object.id : idOf((object as Stripe.Refund).charge);
  if (!chargeId) return;
  const charge = await stripe.charges.retrieve(chargeId);
  const paymentIntent = idOf(charge.payment_intent);
  const customerId = idOf(charge.customer);
  if (
    !paymentIntent ||
    !customerId ||
    !charge.paid ||
    charge.currency !== "hkd" ||
    charge.livemode !== event.livemode
  )
    return;
  let refunded = false;
  for await (const refund of stripe.refunds.list({ charge: charge.id, limit: 100 })) {
    if (
      refund.status === "succeeded" &&
      refund.amount > 0 &&
      refund.currency === charge.currency &&
      idOf(refund.charge) === charge.id
    )
      refunded = true;
  }
  if (!refunded) return;

  const subscriptions = new Map<string, Stripe.Subscription>();
  for await (const payment of stripe.invoicePayments.list({
    payment: { type: "payment_intent", payment_intent: paymentIntent },
    limit: 100
  })) {
    if (
      payment.status !== "paid" ||
      payment.livemode !== event.livemode ||
      idOf(payment.payment.payment_intent) !== paymentIntent
    )
      continue;
    const invoice = await stripe.invoices.retrieve(idOf(payment.invoice)!);
    const subId = idOf(invoice.parent?.subscription_details?.subscription);
    if (!subId || idOf(invoice.customer) !== customerId || invoice.livemode !== event.livemode)
      continue;
    let hasPrice = false;
    for await (const line of stripe.invoices.listLineItems(invoice.id, { limit: 100 })) {
      if (line.pricing?.price_details?.price === priceId && line.parent?.subscription_item_details)
        hasPrice = true;
    }
    if (!hasPrice) continue;
    const sub = await stripe.subscriptions.retrieve(subId);
    if (
      idOf(sub.customer) === customerId &&
      sub.livemode === event.livemode &&
      sub.items.data.some((item) => item.price.id === priceId)
    )
      subscriptions.set(sub.id, sub);
  }

  for (const sub of subscriptions.values()) {
    const owned = await transaction(db, async (client) => {
      const {
        rows: [owner]
      } = await client.query<{ id: string }>(
        "select id from users where stripe_customer_id=$1 for update",
        [customerId]
      );
      if (!owner || sub.metadata.userId !== owner.id) return false;
      await client.query(
        `insert into refunded_card_subscriptions(subscription_id,user_id,charge_id)
         values($1,$2,$3) on conflict(subscription_id) do nothing`,
        [sub.id, owner.id, charge.id]
      );
      // A historical refund must never revoke a replacement subscription or wallet access.
      await client.query(
        `update users set stripe_subscription_id=$1, current_period_end=null, grace_period_end=null,
         status=case when role='admin' or manual_access or exists(
           select 1 from wallets where user_id=users.id and period_end>now()
         ) then 'active' else 'pending' end
         where id=$2 and (stripe_subscription_id=$1 or stripe_subscription_id is null)`,
        [sub.id, owner.id]
      );
      return true;
    });
    if (!owned) continue;
    let canceled = await stripe.subscriptions.retrieve(sub.id);
    if (!["canceled", "incomplete_expired"].includes(canceled.status)) {
      try {
        canceled = await stripe.subscriptions.cancel(sub.id, {
          invoice_now: false,
          prorate: false
        });
      } catch (error) {
        // Stripe can accept cancellation but lose the response. Verify before retrying.
        canceled = await stripe.subscriptions.retrieve(sub.id);
        if (!["canceled", "incomplete_expired"].includes(canceled.status)) throw error;
      }
    }
    if (!["canceled", "incomplete_expired"].includes(canceled.status))
      throw new Error("Refunded card subscription cancellation is not confirmed");
    await db.query(
      `update users set subscription_status='canceled', subscription_cancel_at_period_end=false,
       subscription_cancel_at=null, subscription_canceled_at=$2,
       subscription_updated_at=greatest(subscription_updated_at,$3)
       where stripe_subscription_id=$1`,
      [sub.id, new Date((canceled.canceled_at ?? event.created) * 1000), event.created]
    );
  }
  await db.query("insert into stripe_events(id) values($1) on conflict do nothing", [event.id]);
}
