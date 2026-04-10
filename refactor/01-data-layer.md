# Module 1: Data Layer

## Overview

The data layer is the plumbing that lets any page on tom.quest fetch data from or send commands to the Turing HPC cluster. It replaces ~10 separate API route files and all manual fetch/loading/error patterns in page components with 3 files.

## Architecture

```
Browser component
  → useTuring("/gpu-report")           (client hook, SWR-based)
  → GET /api/turing/gpu-report         (catch-all proxy route)
  → proxyToTuring("/gpu-report")       (server-side helper)
  → Supabase lookup for tunnel URL     (cached 1 min)
  → fetch(tunnelUrl + "/gpu-report")   (Cloudflare tunnel to FastAPI)
```

## Files to Create

### 1. `app/lib/turing.ts` — Server-side proxy helper (~40 lines)

This module does one thing: given a path, fetch it from Turing's FastAPI server.

**Exports:**

- `proxyToTuring(path: string, init?: RequestInit): Promise<Response>` — Resolves the current tunnel URL from Supabase (cached 1 minute in a module-level variable), then calls `fetch(tunnelUrl + path, init)`.
- `getTunnelUrl(): Promise<string>` — Returns the current Cloudflare tunnel URL for Turing (cached 1 minute). Used by the proxy helper internally, and also by the `/api/turing/tunnel-url` route to expose the URL to the terminal component. Checks a module-level cache (`cachedUrl` + `cacheTime`). If expired or empty, queries Supabase `turing_connections` table filtered by `user_id = TOM_USER_ID`, reads `tunnel_url`, caches it, and returns it. Throws `"Turing backend not connected"` if no row found.
- `isTom(userId: string | undefined): boolean` — Returns `true` if the given user ID matches `process.env.TOM_USER_ID`.

**Dependencies:**

- `@supabase/supabase-js` (via a server Supabase client)
- `process.env.TOM_USER_ID`
- `process.env.SUPABASE_SERVICE_KEY` (for server-side Supabase client)

**Implementation details:**

- The Supabase client for this module should be created with `createClient(url, serviceKey)` using the service key (not the anon key) since this runs server-side in API routes.
- Cache TTL is 60 seconds. Use `let cachedUrl: string | null = null` and `let cacheTime = 0` at module scope.
- No retry logic. No multi-user resolution. No cache invalidation on error. If Turing is unreachable, the fetch will fail and the error propagates to the client naturally.
- The `isTom` function is a simple string comparison: `userId === process.env.TOM_USER_ID`.

### 2. `app/api/turing/[...path]/route.ts` — Catch-all proxy route (~60 lines)

A single Next.js route handler that replaces all existing `app/api/turing/*` route files (gpu-report, jobs, allocate, dirs, file, sessions, etc.) except for `register/route.ts` and `connection/route.ts` which handle Turing connection setup (those are kept separately — see notes below).

**Exports:**

- `GET(request, { params })` — Proxies GET requests to Turing.
- `POST(request, { params })` — Checks `isTom`, then proxies POST requests.
- `DELETE(request, { params })` — Checks `isTom`, then proxies DELETE requests.

**Logic (shared `proxy` function):**

1. Read `x-user-id` from request headers.
2. If the HTTP method is not GET, check `isTom(userId)`. If not Tom, return `403 { error: "Read-only access" }`.
3. Join the `params.path` array with `/` to build the Turing path.
4. Call `proxyToTuring("/" + path, { method, headers, body })`.
5. Return the upstream response body and status code, with `Content-Type: application/json`.

**Important Next.js detail:**

- In Next.js 15+, `params` is a Promise. The handler must `await params` before accessing `.path`.

**Query string forwarding:**

- The proxy must forward query parameters from the original request to the upstream URL. Extract them from `request.url` using `new URL(request.url).search` and append to the Turing URL.

**Body forwarding:**

- For POST/DELETE, read the body with `await request.text()` and pass it through. Do NOT parse/re-serialize JSON — pass it as-is to preserve the exact payload.

**What this does NOT handle:**

- The `/api/turing/register` route (heartbeat from FastAPI) — this stays as its own route file because it writes to Supabase, not proxied to Turing.
- The `/api/turing/connection` route (user connecting their key) — this also stays separate.
- The `/api/turing/tunnel-url` route (returns tunnel URL for WebSocket terminal) — this stays separate because it returns Turing's URL, not data from Turing. Tom-only. See below.
- The catch-all will NOT match these because Next.js gives specific routes priority over catch-all routes.

### 2b. `app/api/turing/tunnel-url/route.ts` — Tunnel URL endpoint (~15 lines)

A Tom-only endpoint that returns the current Cloudflare tunnel URL. Used by the interactive terminal component to open a direct WebSocket connection to Turing.

**Export:** `GET(request)` handler.

**Logic:**

1. Read `x-user-id` from request headers.
2. If not `isTom(userId)`, return 403.
3. Call `getTunnelUrl()` from `app/lib/turing.ts`.
4. Return `{ url: tunnelUrl }`.

The terminal component calls this endpoint, then constructs a WebSocket URL like `wss://{tunnelUrl}/ws/sessions/{sessionName}` (replacing `https://` with `wss://`).

### 3. `app/lib/hooks/use-turing.ts` — Client-side data hooks (~80 lines)

Two hooks that components use for all Turing data access.

**Dependency:** `swr` (install with `npm install swr`)

**Export 1: `useTuring<T>(path, options?)`**

For reading data (GET requests with caching and auto-refresh).

```typescript
interface UseTuringOptions {
  refreshInterval?: number;  // seconds (not milliseconds)
}

interface UseTuringResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}
```

Implementation:
1. Get `user` from `useAuth()` context.
2. Define a `fetcher` function that calls `fetch(url, { headers })` where headers include `x-user-id: user.id` if a user is logged in. The fetcher throws on non-ok responses (read the response text for the error message).
3. Call `useSWR<T>("/api/turing" + path, fetcher, swr_options)`.
4. Map SWR's return values to our simpler interface:
   - `data` = `swr.data ?? null`
   - `error` = if `swr.error` exists, extract its message, otherwise `null`
   - `loading` = `swr.isLoading`
   - `refresh` = `() => swr.mutate()`
5. For `refreshInterval`, convert seconds to milliseconds when passing to SWR (`options.refreshInterval * 1000`).

**Export 2: `useTuringMutation<TBody, TResponse>(path, method?)`**

For write operations (POST, DELETE — no caching).

```typescript
interface UseTuringMutationResult<TBody, TResponse> {
  trigger: (body: TBody) => Promise<TResponse | null>;
  loading: boolean;
  error: string | null;
}
```

Implementation:
1. Get `user` from `useAuth()` context.
2. Manage `loading` and `error` with `useState`.
3. The `trigger` function:
   - Sets loading true, error null.
   - Calls `fetch("/api/turing" + path, { method, headers with x-user-id and Content-Type, body: JSON.stringify(body) })`.
   - On success: parse JSON, return it.
   - On failure: set error message, return null.
   - Finally: set loading false.
4. Wrap `trigger` in `useCallback` with `[user, path, method]` deps.
5. Default `method` is `"POST"`.

**SWR configuration:**

- Do NOT set any global SWR configuration (no `SWRConfig` provider). Keep defaults: revalidate on focus (yes), revalidate on reconnect (yes), dedupe interval (2s).

## Files to Delete

After this module is implemented, delete these files (they are replaced by the catch-all):

- `app/api/turing/gpu-report/route.ts`
- `app/api/turing/allocate/route.ts`
- `app/api/turing/jobs/route.ts`
- `app/api/turing/jobs/[jobId]/route.ts`
- `app/api/turing/dirs/route.ts`
- `app/api/turing/file/route.ts`
- `app/api/turing/sessions/[sessionName]/output/route.ts`
- `app/api/turing/boolback/[...path]/route.ts` (BoolBack is being removed)

Keep these files (they are NOT proxied to Turing):

- `app/api/turing/register/route.ts` (heartbeat receiver)
- `app/api/turing/connection/route.ts` (connection key management)

## Files to Modify

- `app/lib/turing.ts` — Replace entirely with the simplified version described above. The old version has multi-user resolution (`resolveConnection`, `getUserConnection`), retry-on-530 logic, cache invalidation, and `canUserWrite`. All of that is removed.

## Rules

1. All Turing data access in components MUST use `useTuring` or `useTuringMutation`. No raw `fetch` calls to `/api/turing/*`.
2. The catch-all proxy route is a dumb pipe. It does NOT parse, validate, or transform data. Business logic belongs in the FastAPI server.
3. Write permission (Tom check) is enforced in exactly one place: the catch-all route handler.
4. Components never see auth headers, tunnel URLs, or Supabase. The hooks handle all of that.
5. The `refreshInterval` option is in seconds (the hook converts to milliseconds for SWR internally).

## Testing

### Unit tests for `use-turing.ts`

Use React Testing Library + a mock SWR provider or mock `fetch`.

Test cases:
- `useTuring` returns loading=true initially, then data after fetch resolves
- `useTuring` returns error string when fetch fails
- `useTuring` passes `x-user-id` header when user is logged in
- `useTuring` omits `x-user-id` header when no user
- `useTuring` with `refreshInterval` passes correct millisecond value to SWR
- `useTuring.refresh()` triggers a re-fetch
- `useTuringMutation.trigger()` sends correct method, headers, and JSON body
- `useTuringMutation` returns null and sets error on failure
- `useTuringMutation` returns parsed response on success

### Integration tests for the catch-all route

Test cases:
- GET requests are proxied without auth check
- POST requests without Tom user ID return 403
- POST requests with Tom user ID are proxied
- DELETE requests without Tom user ID return 403
- Query parameters are forwarded to upstream
- Request body is forwarded as-is
- Upstream errors (500, 404) are passed through to client

### E2E tests (Playwright)

These come later when pages are built. The data layer itself is tested via unit/integration tests.

## Dependencies to Install

```
npm install swr
```

No other new dependencies.

## Migration Notes

- The old `app/lib/turing.ts` exports `fetchTuring` and `canUserWrite`. Any remaining code that imports these (outside of deleted route files) needs to be updated. Search for imports of these functions.
- The old `debugFetch` wrapper in pages (which injected `x-user-id` headers) is no longer needed — the hooks handle this. Pages should stop using `debugFetch` for Turing calls.
- The debug logging system (`logDebug`, `debugFetch` from `app/lib/debug.ts`) is NOT part of this module. It will be addressed separately. For now, the hooks do not emit debug log events. This is intentional — debug logging will be redesigned as its own module.
