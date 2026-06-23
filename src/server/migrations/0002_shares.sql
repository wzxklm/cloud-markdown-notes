create table if not exists shares (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  note_path text not null,
  slug text unique not null,
  commit_sha text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists shares_user_id_idx
on shares (user_id);

create index if not exists shares_slug_active_idx
on shares (slug, active);
