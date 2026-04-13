# Module 2: Auth

## Overview

The auth module manages user identity: who is logged in, whether they're Tom (the admin), and sign-in/sign-up/sign-out flows. It replaces the current 307-line AuthProvider with an ~80-line version that does less on startup and exposes a simpler interface.

## Key Design Decisions

- **Username-only signup.** Users enter a username and password. Supabase requires an email, so we generate a fake one: `normalizeUsername(username) + "@tom.quest"`. The user never sees this email.
- **`isTom` is a client-side check.** The Tom user ID is exposed as `NEXT_PUBLIC_TOM_USER_ID`. The check is `user.id === env var`. No network call.
- **No eager profile fetching.** The old AuthProvider fetched the `profiles` row, the `turing_connections` row, and made an `is-tom` API call on every page load. The new one only restores the Supabase session. If a component needs DB profile data, it queries Supabase itself.
- **No migration.** This is a clean slate. Old accounts in Supabase can be wiped.
- **Profile auto-creation via DB trigger only.** On signup, a Supabase trigger creates a `profiles` row with the username from `user_metadata`. No client-side `ensureProfile` upsert.

## Interface

```typescript
interface AuthContext {
  user: User | null;        // Supabase User object (includes user_metadata.username)
  isTom: boolean;           // true if user.id matches NEXT_PUBLIC_TOM_USER_ID
  loading: boolean;         // true while restoring session on page load
  signIn: (username: string, password: string) => Promise<{ error: string | null }>;
  signUp: (username: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}
```

Components access this via `useAuth()`.

**What is NOT in the interface (compared to current):**

- `session` — components don't need the raw session object
- `profile` — username comes from `user.user_metadata.username`
- `turingConnection` — removed, the proxy layer handles this server-side
- `refreshProfile` / `refreshTuringConnection` — removed
- `isTom` network call — replaced with local check

## Files to Create

### 1. `app/lib/auth.tsx` — AuthProvider + useAuth hook (~80 lines)

This is a `"use client"` module that exports `AuthProvider` (a React context provider) and `useAuth` (a hook to consume it).

**Helper functions (not exported):**

- `normalizeUsername(username: string): string` — lowercases and strips non-alphanumeric characters. Example: `"Alice_123"` becomes `"alice123"`.
- `usernameToEmail(username: string): string` — returns `normalizeUsername(username) + "@tom.quest"`.

**AuthProvider behavior:**

1. On mount, create a Supabase browser client (singleton, same as current).
2. Call `supabase.auth.getSession()` to restore an existing session.
3. Set `user` from the session (or null).
4. Set `loading` to false.
5. Subscribe to `supabase.auth.onAuthStateChange` to update `user` on sign-in/sign-out.
6. Derive `isTom` as: `user?.id === process.env.NEXT_PUBLIC_TOM_USER_ID`.
7. On unmount, unsubscribe.

**`signIn(username, password)`:**

1. Convert username to email via `usernameToEmail(username)`.
2. Call `supabase.auth.signInWithPassword({ email, password })`.
3. Return `{ error: error?.message ?? null }`.

**`signUp(username, password)`:**

1. Validate: `normalizeUsername(username)` must be non-empty. Return error `"Username must contain letters or numbers"` if empty.
2. Convert to email via `usernameToEmail(username)`.
3. Call `supabase.auth.signUp({ email, password, options: { data: { username } } })`.
4. Return `{ error: error?.message ?? null }`.

**`signOut()`:**

1. Call `supabase.auth.signOut()`.
2. If it throws or hangs for >5 seconds, fall back to `supabase.auth.signOut({ scope: "local" })`.

**De-duplication guard:**

- Use a ref to track the last `userId + accessToken` pair. Skip processing `onAuthStateChange` events that match the previous pair. This prevents duplicate work when Supabase emits redundant events (which it does).

### 2. `app/lib/supabase.ts` — Supabase client factories (~30 lines)

Simplified from the current 193-line version. No SQL schema comments (those go in a migration file).

**Exports:**

- `createBrowserSupabaseClient(): SupabaseClient | null` — Singleton browser client using `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Returns null if env vars are missing.
- `createServerSupabaseClient(): SupabaseClient | null` — Creates a new client using `SUPABASE_SERVICE_KEY`. Returns null if env vars are missing. Used by server-side code (API routes, the proxy helper).

No types, no interfaces, no `isTomUser` (that's now in `auth.tsx` as a local check). Keep this file minimal — it's just client creation.

### 3. `app/api/auth/is-tom/route.ts` — DELETE THIS FILE

The `is-tom` API route is no longer needed. `isTom` is a client-side check.

## Files to Delete

- `app/api/auth/is-tom/route.ts` — replaced by client-side check
- `app/components/AuthProvider.tsx` — replaced by `app/lib/auth.tsx`
- `app/lib/supabase.ts` — replaced by new simplified version

## Environment Variables

**Existing (keep):**

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_KEY`

**Tom env vars:**

- Keep both `TOM_USER_ID` and `NEXT_PUBLIC_TOM_USER_ID`.
- `TOM_USER_ID` is the server-only source of truth for Tom-only routes and Turing backend lookup.
- `NEXT_PUBLIC_TOM_USER_ID` is only for the client-side `isTom` check.
- These two env vars must always have the same value. Update them together in Vercel environment settings.

## Supabase Database

Since this is a clean slate, here is the minimal schema needed for auth. Run this SQL in the Supabase SQL editor.

### Tables

**profiles:**

```sql
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  username text unique not null,
  created_at timestamptz default now() not null
);

alter table public.profiles enable row level security;
create policy "Public profiles are viewable by everyone"
  on profiles for select using (true);
create policy "Users can update own profile"
  on profiles for update using (auth.uid() = id);
```

**Auto-create profile on signup (trigger):**

```sql
create or replace function public.handle_new_user()
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
```

**turing_connections** (needed by the data layer proxy):

```sql
create table public.turing_connections (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete set null unique,
  connection_key text unique not null,
  tunnel_url text not null,
  created_at timestamptz default now() not null,
  last_heartbeat timestamptz
);

alter table public.turing_connections enable row level security;
create policy "Service key only" on turing_connections
  for all using (false);
```

Note: The `turing_connections` RLS policy blocks all client access. Only server-side code with the service key can read/write this table. This is intentional — clients never need to see tunnel URLs.

**feedback:**

```sql
create table public.feedback (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete set null,
  name text,
  content text not null,
  created_at timestamptz default now() not null
);

alter table public.feedback enable row level security;
create policy "Anyone can insert feedback"
  on feedback for insert with check (true);
```

**symbol_scores:**

```sql
create table public.symbol_scores (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  username text not null,
  time_ms integer not null,
  created_at timestamptz default now() not null
);

alter table public.symbol_scores enable row level security;
create policy "Scores are public" on symbol_scores for select using (true);
create policy "Users can insert own scores"
  on symbol_scores for insert with check (auth.uid() = user_id);
```

**user_settings:**

```sql
create table public.user_settings (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  setting_key text not null,
  value jsonb not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  unique (user_id, setting_key)
);

alter table public.user_settings enable row level security;
create policy "Users can view own settings"
  on user_settings for select using (auth.uid() = user_id);
create policy "Users can insert own settings"
  on user_settings for insert with check (auth.uid() = user_id);
create policy "Users can update own settings"
  on user_settings for update using (auth.uid() = user_id);
```

### Supabase Auth Config

- Disable email confirmation (so fake @tom.quest emails don't block signup).
- This is set in Supabase dashboard: Authentication > Settings > Email Auth > toggle off "Confirm email".

## Rules

1. `useAuth()` is the only way components access auth state. No direct Supabase auth calls in components.
2. `isTom` is always a client-side check. Never make a network call to determine this.
3. Auth state is `{ user, isTom, loading }`. No other data (profile rows, connections, settings) belongs in the auth context. Components that need other data fetch it themselves.
4. The `signOut` function has a 5-second timeout with local fallback. This is a known Supabase issue where remote sign-out can hang.
5. Username normalization strips everything except lowercase letters and digits. This prevents duplicate accounts from capitalization or special character differences.

## Testing

### Unit tests for auth

- `normalizeUsername` strips non-alphanumeric and lowercases
- `usernameToEmail` produces `normalized@tom.quest`
- `useAuth` returns `loading: true` initially, then `loading: false` after session restore
- `useAuth` returns `isTom: true` when user ID matches env var
- `useAuth` returns `isTom: false` for other users and when logged out
- `signIn` converts username to email before calling Supabase
- `signUp` validates username is non-empty after normalization
- `signUp` passes username in `options.data` for the DB trigger
- `signOut` falls back to local sign-out after 5 second timeout
- Auth state change events update `user` and `isTom`
- Duplicate auth state change events (same userId + token) are ignored

### Integration tests

- Sign up with a username, verify profile row created via trigger
- Sign in with the same username and password
- Sign out and verify user is null

## Getting Username for Display

Components that need to show the current user's name should read `user.user_metadata.username` from the auth context. This is set during signup and persists in the Supabase JWT. No database query needed.

```typescript
const { user } = useAuth();
const username = (user?.user_metadata as { username?: string })?.username ?? "User";
```

If a typed helper is useful, add a `getUsername(user: User): string` function to `app/lib/auth.tsx` as an export.
