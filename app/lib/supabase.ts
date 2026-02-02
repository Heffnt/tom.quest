import { createBrowserClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';

// Browser client for client components
export function createBrowserSupabaseClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// Server client with service key for Tom-only operations
export function createServerSupabaseClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );
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

export interface Device {
  id: string;
  device_id: string;
  user_id: string | null;
  device_name: string;
  created_at: string;
  last_seen: string;
  total_visits: number;
  total_time_seconds: number;
}

export interface Message {
  id: string;
  device_id: string;
  content: string;
  from_tom: boolean;
  created_at: string;
}

export interface PageVisit {
  id: string;
  device_id: string;
  path: string;
  entered_at: string;
  duration_seconds: number | null;
}

export interface TuringConnection {
  id: string;
  user_id: string;
  tunnel_url: string;
  created_at: string;
  last_verified: string | null;
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

-- Devices table
create table public.devices (
  id uuid default gen_random_uuid() primary key,
  device_id text unique not null,
  user_id uuid references public.profiles(id) on delete set null,
  device_name text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  last_seen timestamp with time zone default timezone('utc'::text, now()) not null,
  total_visits integer default 1 not null,
  total_time_seconds integer default 0 not null
);

alter table public.devices enable row level security;
create policy "Devices are insertable by anyone" on devices for insert with check (true);
create policy "Devices are updatable by anyone" on devices for update using (true);
create policy "Devices are viewable by anyone" on devices for select using (true);

-- Messages table
create table public.messages (
  id uuid default gen_random_uuid() primary key,
  device_id text references public.devices(device_id) on delete cascade not null,
  content text not null,
  from_tom boolean default false not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.messages enable row level security;
create policy "Messages are insertable by anyone" on messages for insert with check (true);
create policy "Messages are viewable by anyone" on messages for select using (true);

-- Page visits table
create table public.page_visits (
  id uuid default gen_random_uuid() primary key,
  device_id text references public.devices(device_id) on delete cascade not null,
  path text not null,
  entered_at timestamp with time zone default timezone('utc'::text, now()) not null,
  duration_seconds integer
);

alter table public.page_visits enable row level security;
create policy "Page visits are insertable by anyone" on page_visits for insert with check (true);
create policy "Page visits are updatable by anyone" on page_visits for update using (true);
create policy "Page visits are viewable by anyone" on page_visits for select using (true);

-- Turing connections table
create table public.turing_connections (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade unique not null,
  tunnel_url text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  last_verified timestamp with time zone
);

alter table public.turing_connections enable row level security;
create policy "Users can view own turing connection" on turing_connections for select using (auth.uid() = user_id);
create policy "Users can insert own turing connection" on turing_connections for insert with check (auth.uid() = user_id);
create policy "Users can update own turing connection" on turing_connections for update using (auth.uid() = user_id);
create policy "Users can delete own turing connection" on turing_connections for delete using (auth.uid() = user_id);
*/
