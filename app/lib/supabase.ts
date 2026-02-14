import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// Check if Supabase is configured
export function isSupabaseConfigured(): boolean {
  return !!(SUPABASE_URL && SUPABASE_ANON_KEY);
}

let browserClient: SupabaseClient | null = null;

// Browser client for client components
export function createBrowserSupabaseClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) {
    return null;
  }
  if (!browserClient) {
    browserClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return browserClient;
}

// Server client with service key for Tom-only operations
export function createServerSupabaseClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return null;
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

// Check if a user ID matches Tom
export function isTomUser(userId: string | undefined): boolean {
  return userId === process.env.TOM_USER_ID;
}

// Types for our database tables
export interface Profile {
  id: string;
  username: string;
  created_at: string;
}

export interface Feedback {
  id: string;
  user_id: string | null;
  name: string | null;
  content: string;
  created_at: string;
}

export interface TuringConnection {
  id: string;
  user_id: string | null;
  connection_key: string;
  tunnel_url: string;
  created_at: string;
  last_heartbeat: string | null;
}

export interface UserSetting {
  id: string;
  user_id: string;
  setting_key: string;
  value: unknown;
  created_at: string;
  updated_at: string;
}

export interface CubeRating {
  id: string;
  user_id: string;
  scryfall_id: string;
  power: number | null;
  synergy: number | null;
  theme: number | null;
  include: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/*
SQL Schema - Run this in Supabase SQL Editor:

-- Profiles table (extends auth.users)
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  username text unique not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS
alter table public.profiles enable row level security;

-- Profiles policies
create policy "Public profiles are viewable by everyone" on profiles for select using (true);
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);

-- Auto-create profile on signup
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, username)
  values (new.id, new.raw_user_meta_data->>'username');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Feedback table
create table public.feedback (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete set null,
  name text,
  content text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.feedback enable row level security;
create policy "Anyone can insert feedback" on feedback
  for insert with check (user_id is null or auth.uid() = user_id);
create policy "Feedback owner can read" on feedback
  for select using (auth.uid() = user_id);

-- Turing connections table (key-based: API registers by key, user links by key)
create table public.turing_connections (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete set null unique,
  connection_key text unique not null,
  tunnel_url text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  last_heartbeat timestamp with time zone
);

alter table public.turing_connections enable row level security;
create policy "Users can view own turing connection" on turing_connections for select using (auth.uid() = user_id);
create policy "Users can update own turing connection" on turing_connections for update using (auth.uid() = user_id);

-- Migration from old schema:
-- ALTER TABLE turing_connections ADD COLUMN connection_key text unique;
-- ALTER TABLE turing_connections ADD COLUMN last_heartbeat timestamp with time zone;
-- ALTER TABLE turing_connections ALTER COLUMN user_id DROP NOT NULL;
-- ALTER TABLE turing_connections DROP COLUMN IF EXISTS last_verified;
-- ALTER TABLE turing_connections DROP CONSTRAINT turing_connections_user_id_fkey;
-- ALTER TABLE turing_connections ADD CONSTRAINT turing_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
-- DROP POLICY IF EXISTS "Users can insert own turing connection" ON turing_connections;
-- DROP POLICY IF EXISTS "Users can delete own turing connection" ON turing_connections;

-- User settings table
create table public.user_settings (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  setting_key text not null,
  value jsonb not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique (user_id, setting_key)
);

alter table public.user_settings enable row level security;
create policy "Users can view own settings" on user_settings for select using (auth.uid() = user_id);
create policy "Users can insert own settings" on user_settings for insert with check (auth.uid() = user_id);
create policy "Users can update own settings" on user_settings for update using (auth.uid() = user_id);

-- Cube ratings table (MTG cube card ratings)
create table public.cube_ratings (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  scryfall_id text not null,
  power smallint,
  synergy smallint,
  theme smallint,
  include boolean not null,
  notes text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique (user_id, scryfall_id),
  constraint cube_ratings_power_range check (power is null or (power >= 1 and power <= 5)),
  constraint cube_ratings_synergy_range check (synergy is null or (synergy >= 1 and synergy <= 5)),
  constraint cube_ratings_theme_range check (theme is null or (theme >= 1 and theme <= 5))
);

alter table public.cube_ratings enable row level security;
create policy "Cube ratings are viewable by everyone" on cube_ratings for select using (true);
create policy "Users can insert own cube ratings" on cube_ratings for insert with check (auth.uid() = user_id);
create policy "Users can update own cube ratings" on cube_ratings for update using (auth.uid() = user_id);
*/
