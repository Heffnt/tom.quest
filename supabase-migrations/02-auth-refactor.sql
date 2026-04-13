-- Module 2 auth migration.
-- Run in the Supabase SQL Editor.
-- Set :tom_id to Tom's auth.users.id before running (Supabase SQL Editor supports \set or just hard-code it in the delete line).

-- 1. Wipe all non-Tom accounts (cascades to profiles, symbol_scores, user_settings).
--    Turing connections use ON DELETE SET NULL so Tom's row is unaffected.
--    REPLACE the UUID below with Tom's user id before running.
delete from auth.users
where id <> 'REPLACE-WITH-TOM-USER-ID';

-- 2. Drop tables no longer used.
drop table if exists public.cube_ratings;

-- 3. Tighten turing_connections RLS: service key only (no client access).
alter table public.turing_connections enable row level security;
drop policy if exists "Users can view own turing connection" on public.turing_connections;
drop policy if exists "Users can update own turing connection" on public.turing_connections;
drop policy if exists "Users can insert own turing connection" on public.turing_connections;
drop policy if exists "Users can delete own turing connection" on public.turing_connections;
drop policy if exists "Service key only" on public.turing_connections;
create policy "Service key only" on public.turing_connections for all using (false);

-- 4. Simplify feedback RLS.
alter table public.feedback enable row level security;
drop policy if exists "Anyone can insert feedback" on public.feedback;
drop policy if exists "Feedback owner can read" on public.feedback;
create policy "Anyone can insert feedback" on public.feedback for insert with check (true);

-- 5. Ensure the new-user trigger exists (creates profile row from user_metadata.username).
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, username)
  values (new.id, new.raw_user_meta_data->>'username')
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 6. Make sure symbol_scores exists (one-off — skip if already created via symbol_scores.sql).
-- create table if not exists public.symbol_scores ... (see supabase-migrations/symbol_scores.sql)
