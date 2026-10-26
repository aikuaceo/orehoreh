-- OREH operators: who may use the admin page, and a record of what they did.
-- Operators sign in with an email link (Supabase Auth); admin-order checks the email against this table.
create table public.admins (
  email      text primary key check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name       text,
  created_at timestamptz not null default now()
);

create table public.admin_actions (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  admin      text not null,
  action     text not null,
  target     text,
  detail     jsonb
);
create index admin_actions_at on public.admin_actions (at desc);

alter table public.admins enable row level security;
alter table public.admin_actions enable row level security;
revoke all on public.admins, public.admin_actions from anon, authenticated;

-- Add operators in the SQL editor (kept out of the repo, which is public):
--   insert into public.admins (email, name) values ('<email>', '<name>');
