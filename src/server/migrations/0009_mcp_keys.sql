create table mcp_keys (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  token_hash text unique not null,
  created_at timestamptz not null default now()
);
create index mcp_keys_user_created_idx on mcp_keys (user_id, created_at desc);
