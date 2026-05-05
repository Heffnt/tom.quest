# tom.Quest

Personal website for Tom Heffernan — PhD Student in Artificial Intelligence at WPI.

## Quests

| Route | What | Visibility |
|-------|------|------------|
| `/thmm` | Tiny CPU simulator + datapath | Public |
| `/clouds` | Interactive LiDAR point-cloud viewer | Public |
| `/game` | Symbol-shooting mini-game | Public |
| `/bio` | About Tom | Public |
| `/help` | How tom.quest works | Public |
| `/turing` | SLURM cluster + GPU dashboard | Admin |
| `/jarvis` | Personal AI assistant | Tom |
| `/logo` | tom.Quest brand lab | Tom |

## Tech Stack

- **Framework:** Next.js 16 (App Router) + React 19
- **Backend / DB:** [Convex](https://convex.dev) — schema, queries, mutations, HTTP actions, Convex Auth
- **Auth:** Convex Auth with password provider; three roles: `user`, `admin`, `tom`
- **Client state:** Zustand (UI-only state; server state stays in Convex)
- **Styling:** Tailwind CSS v4 with theme tokens in `app/globals.css`
- **Observability:** Sentry (errors, performance, session replay)
- **Testing:** Vitest + convex-test (unit/component), Playwright (E2E)
- **Package manager:** pnpm
- **Hosting:** Vercel (frontend) + Convex Cloud (backend)

## Development

```bash
pnpm install
pnpm dev:all          # starts Next.js + Convex dev server
```

Open [http://localhost:3000](http://localhost:3000).

### Verification

```bash
pnpm build            # production build
pnpm test             # Vitest unit/component tests
pnpm test:e2e         # Playwright E2E tests
pnpm lint             # ESLint
```

## Deployment

Vercel is connected to the `main` branch. The build command is overridden to:

```
npx convex deploy --cmd 'pnpm build'
```

This pushes Convex functions to prod and builds Next.js with the correct `NEXT_PUBLIC_CONVEX_URL` injected at build time.

### Required Vercel Environment Variables (Production)

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_CONVEX_URL` | Convex prod deployment URL |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | Convex prod HTTP actions URL |
| `CONVEX_DEPLOY_KEY` | Convex deploy key (from Convex dashboard) |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry DSN |
| `SENTRY_ORG` | Sentry organization slug |
| `SENTRY_PROJECT` | Sentry project slug |
| `SENTRY_AUTH_TOKEN` | Sentry auth token (for source maps) |

### Required Convex Environment Variables (set via `npx convex env set --prod`)

| Variable | Purpose |
|----------|---------|
| `SITE_URL` | Public site URL (e.g. `https://www.tom.quest`) |
| `JWT_PRIVATE_KEY` | Convex Auth JWT signing key |
| `JWKS` | Convex Auth public key set |
| `TOM_SETUP_SECRET` | Secret for the Tom account promotion mutation |
| `TURING_REGISTRATION_SECRET` | Shared secret for FastAPI worker registration |

## Turing GPU Dashboard

The `/turing` page proxies requests through Next.js API routes to a FastAPI backend running on the WPI Turing HPC login node.

### Architecture

1. **FastAPI worker** (`tom-quest-api/`) runs on a Turing login node and exposes GPU/job/terminal APIs.
2. **Cloudflare Quick Tunnel** (`cloudflared`) creates a public URL for the worker.
3. **Worker registers** the tunnel URL with Convex via the `/api/turing/register` HTTP action, authenticated by `TURING_REGISTRATION_SECRET`.
4. **Convex auto-links** the connection to the Tom user.
5. **Next.js API routes** (`/api/turing/*`) look up the tunnel URL from Convex and proxy requests to the FastAPI worker.

### On Turing

```bash
cd ~/tom.quest/tom-quest-api
pip install -r requirements.txt
```

Create a `.env` file:

```
CONVEX_SITE_URL=https://<prod-deployment>.convex.site
TURING_REGISTRATION_SECRET=<same secret as Convex env>
```

Run:

```bash
python main.py
```

The tunnel starts automatically and registers with Convex. The connection key is printed to the console; enter it on `tom.quest/turing` to link the connection (or it auto-links to Tom on registration).

### Updating on Turing

```bash
cd ~/tom.quest && git pull
cd tom-quest-api && python main.py
```
