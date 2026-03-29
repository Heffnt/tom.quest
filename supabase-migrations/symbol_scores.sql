-- Symbol Game leaderboard table
-- Run this in Supabase SQL Editor

create table public.symbol_scores (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  username text not null,
  time_ms integer not null check (time_ms >= 0),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Index for leaderboard queries
create index symbol_scores_time_idx on public.symbol_scores (time_ms asc);

-- Enable RLS
alter table public.symbol_scores enable row level security;

-- Everyone can view scores (public leaderboard)
create policy "Scores are viewable by everyone"
  on symbol_scores for select using (true);

-- Users can insert their own scores
create policy "Users can insert own scores"
  on symbol_scores for insert with check (auth.uid() = user_id);
