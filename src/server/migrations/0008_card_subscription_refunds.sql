create table refunded_card_subscriptions (
  subscription_id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  charge_id text not null,
  refunded_at timestamptz not null default now()
);
create index refunded_card_subscriptions_user_idx on refunded_card_subscriptions(user_id);
