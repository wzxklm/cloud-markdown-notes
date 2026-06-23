create table if not exists app_metadata (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

insert into app_metadata (key, value)
values ('schema', 'phase-0')
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
