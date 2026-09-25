alter table users add column if not exists subscription_cancel_at_period_end boolean not null default false;
alter table users add column if not exists subscription_canceled_at timestamptz;
