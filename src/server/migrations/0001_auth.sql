create table if not exists users (
  id uuid primary key,
  username text unique not null,
  password_hash text not null,
  role text not null check (role in ('admin', 'user')),
  status text not null check (status in ('active', 'pending')),
  created_at timestamptz not null default now(),
  activated_at timestamptz
);

create unique index if not exists users_username_lower_idx
on users (lower(username));

create table if not exists sessions (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text unique not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists sessions_user_id_idx
on sessions (user_id);

create index if not exists sessions_expires_at_idx
on sessions (expires_at);
