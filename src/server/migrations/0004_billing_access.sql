alter table users add column manual_access boolean not null default false;
update users set manual_access = true where status = 'active' and stripe_subscription_id is null;
alter table users add column checkout_session_id text;
alter table users add column checkout_expires_at timestamptz;
alter table users add column subscription_updated_at bigint not null default 0;
alter table sessions add column scope text not null default 'workspace' check (scope in ('workspace', 'billing'));
