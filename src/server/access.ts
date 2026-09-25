import type { Database } from "./db";

// Run before authorizing a workspace request. A missed webhook must not grant
// unlimited access. Manual activation remains independent of Stripe billing.
export async function expirePaidAccess(db: Database): Promise<void> {
  await db.query(`update users set status = 'pending'
    where role = 'user' and not manual_access and status = 'active'
    and stripe_subscription_id is not null
    and coalesce(grace_period_end, current_period_end, '-infinity'::timestamptz) <= now()`);
}
