create table wallets (
 user_id uuid primary key references users(id) on delete cascade,
 balance integer not null default 0,
 auto_renew boolean not null default false,
 period_end timestamptz,
 anchor_day integer check (anchor_day between 1 and 31),
 paused boolean not null default false
);
create table wallet_topups (
 id uuid primary key,
 user_id uuid not null references users(id) on delete cascade,
 request_id uuid not null,
 amount integer not null check (amount between 1000 and 100000 and amount % 100 = 0),
 currency text not null default 'hkd' check (currency='hkd'),
 status text not null default 'pending' check (status in ('pending','paid','failed','expired')),
 session_id text unique,
 payment_intent_id text unique,
 refunded integer not null default 0 check (refunded>=0),
 reversed integer not null default 0 check (reversed>=0 and reversed<=amount),
 created_at timestamptz not null default now(),
 unique(user_id,request_id)
);
create table wallet_disputes (
 id text primary key,
 topup_id uuid not null references wallet_topups(id) on delete cascade,
 amount integer not null check (amount>0),
 withdrawn boolean not null default false,
 reinstated boolean not null default false
);
create table wallet_ledger (
 id bigserial primary key,
 user_id uuid not null references users(id) on delete cascade,
 amount integer not null check (amount<>0),
 balance_after integer not null,
 kind text not null check (kind in ('topup','subscription','reversal')),
 reference text not null unique,
 created_at timestamptz not null default now()
);
create index wallet_ledger_user_idx on wallet_ledger(user_id,id desc);
create index wallet_topups_user_idx on wallet_topups(user_id,created_at desc);
