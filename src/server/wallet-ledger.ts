import type pg from "pg";
import { transaction, type Database } from "./db";
export const monthlyAmount = 1000;
export type Wallet = {
  user_id: string;
  balance: number;
  auto_renew: boolean;
  period_end: Date | null;
  anchor_day: number | null;
  paused: boolean;
};
export async function lockWallet(client: pg.PoolClient, userId: string): Promise<Wallet> {
  // All wallet and card writers lock the owner before the wallet/order.
  await client.query("select id from users where id=$1 for update", [userId]);
  await client.query("insert into wallets(user_id) values($1) on conflict do nothing", [userId]);
  const {
    rows: [wallet]
  } = await client.query<Wallet>("select * from wallets where user_id=$1 for update", [userId]);
  return wallet;
}
export async function postLedger(
  client: pg.PoolClient,
  userId: string,
  amount: number,
  kind: string,
  reference: string
): Promise<boolean> {
  const {
    rows: [existing]
  } = await client.query("select id from wallet_ledger where reference=$1", [reference]);
  if (existing) return false;
  const {
    rows: [wallet]
  } = await client.query<Wallet>(
    "update wallets set balance=balance+$2 where user_id=$1 returning *",
    [userId, amount]
  );
  await client.query(
    "insert into wallet_ledger(user_id,amount,balance_after,kind,reference) values($1,$2,$3,$4,$5)",
    [userId, amount, wallet.balance, kind, reference]
  );
  return true;
}
export function nextMonth(start: Date, anchor: number): Date {
  const end = new Date(start);
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(anchor, last));
  return end;
}
export async function renewWalletLocked(
  client: pg.PoolClient,
  userId: string,
  now = new Date()
): Promise<void> {
  const wallet = await lockWallet(client, userId);
  if (!wallet.auto_renew || (wallet.period_end && wallet.period_end > now)) return;
  const {
    rows: [owner]
  } = await client.query(
    "select manual_access,stripe_subscription_id,subscription_status,current_period_end from users where id=$1",
    [userId]
  );
  if (
    owner.manual_access ||
    (owner.stripe_subscription_id &&
      !["canceled", "incomplete_expired"].includes(owner.subscription_status)) ||
    (owner.current_period_end && owner.current_period_end > now)
  )
    return;
  if (wallet.balance < monthlyAmount) {
    await client.query("update wallets set paused=true where user_id=$1", [userId]);
    return;
  }
  // No retrospective charges after an outage or a period of insufficient funds.
  const continuous =
    wallet.period_end && !wallet.paused && now.getTime() - wallet.period_end.getTime() <= 120_000;
  const start = continuous ? wallet.period_end! : now;
  const anchor = continuous ? wallet.anchor_day! : start.getUTCDate();
  const end = nextMonth(start, anchor);
  const key = "wallet-cycle:" + userId + ":" + (wallet.period_end?.toISOString() ?? "first");
  if (!(await postLedger(client, userId, -monthlyAmount, "subscription", key)))
    throw new Error("Charged cycle missing entitlement");
  await client.query(
    "update wallets set period_end=$2,anchor_day=$3,paused=false where user_id=$1",
    [userId, end, anchor]
  );
  await client.query(
    "update users set status='active',activated_at=coalesce(activated_at,now()) where id=$1",
    [userId]
  );
}
export async function renewDueWallets(db: Database): Promise<void> {
  const { rows } = await db.query<{ user_id: string }>(
    "select user_id from wallets where auto_renew and balance >= $1 and (period_end is null or period_end<=now())",
    [monthlyAmount]
  );
  for (const row of rows) await transaction(db, (client) => renewWalletLocked(client, row.user_id));
}
