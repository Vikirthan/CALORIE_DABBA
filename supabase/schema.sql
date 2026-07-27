-- Dabba: Supabase Postgres schema
-- Run this once in your project's SQL Editor (https://app.supabase.com/project/_/sql)

-- ---------- profiles ----------
-- One row per authenticated user: body stats, goal, and the last computed macro plan.
create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  weight_kg numeric,
  height_cm numeric,
  age integer,
  gender text,
  activity_level text,
  goal_type text default 'maintain',
  goal_rate_kg_per_week numeric default 0,
  goal_description text default '',
  insights text,
  cached_targets jsonb,
  daily_goal_calories numeric default 2000,
  updated_at timestamptz not null default now()
);

alter table profiles enable row level security;

drop policy if exists "Users can view their own profile" on profiles;
create policy "Users can view their own profile"
  on profiles for select using (auth.uid() = user_id);

drop policy if exists "Users can insert their own profile" on profiles;
create policy "Users can insert their own profile"
  on profiles for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update their own profile" on profiles;
create policy "Users can update their own profile"
  on profiles for update using (auth.uid() = user_id);

-- ---------- entries ----------
-- Many rows per user: one per logged food item.
create table if not exists entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  source text not null,
  name text not null,
  serving_note text default '',
  calories numeric not null,
  protein numeric default 0,
  carbs numeric default 0,
  fat numeric default 0,
  logged_at timestamptz not null default now()
);

create index if not exists entries_user_date_idx on entries (user_id, date);

alter table entries enable row level security;

drop policy if exists "Users can view their own entries" on entries;
create policy "Users can view their own entries"
  on entries for select using (auth.uid() = user_id);

drop policy if exists "Users can insert their own entries" on entries;
create policy "Users can insert their own entries"
  on entries for insert with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own entries" on entries;
create policy "Users can delete their own entries"
  on entries for delete using (auth.uid() = user_id);

-- ---------- realtime ----------
-- Lets the client subscribe to live INSERT/DELETE events on entries.
-- Guarded because "alter publication ... add table" errors if entries is
-- already a member (e.g. re-running this whole script after the first pass).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'entries'
  ) then
    alter publication supabase_realtime add table entries;
  end if;
end $$;

-- ---------- user_status (admin approval gate) ----------
-- One row per signed-up user, auto-created on signup, starting unapproved.
-- Only the service-role key (used by the admin endpoints in server.js) can
-- flip `approved` — there is deliberately no update policy for regular users.
create table if not exists user_status (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  approved boolean not null default false,
  created_at timestamptz not null default now()
);

alter table user_status enable row level security;

drop policy if exists "Users can view their own status" on user_status;
create policy "Users can view their own status"
  on user_status for select using (auth.uid() = user_id);

-- Auto-populate user_status whenever someone signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_status (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- One-time backfill: anyone who signed up before this table existed is
-- auto-approved (they were already using the app) instead of getting locked out.
insert into public.user_status (user_id, email, approved)
select id, email, true from auth.users
on conflict (user_id) do nothing;
