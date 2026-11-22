import type { Database } from "./db";
import { renewDueWallets } from "./wallet-ledger";

// Both billing sources grant only confirmed paid time. Manual access remains independent.
export async function expirePaidAccess(db: Database): Promise<void> {
  await renewDueWallets(db);
  await db.query(`update users set status='pending'
    where role='user' and not manual_access and status='active'
    and (stripe_subscription_id is not null or exists(select 1 from wallets where user_id=users.id and period_end is not null))
    and coalesce(grace_period_end,current_period_end,'-infinity'::timestamptz)<=now()
    and not exists(select 1 from wallets where user_id=users.id and period_end>now())`);
}
