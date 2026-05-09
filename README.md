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

tom.quest has **one Convex deployment** (prod). Local dev runs `next dev` against prod Convex — same data, same auth, same Tom account. There is no separate dev deployment. Trade-off: every `npx convex deploy` lands live for real users. See [philosophy/personal-project-pragmatism](#) and [principles/single-deployment](#) in the wiki for the rationale.

### One-time setup

```bash
pnpm install
npx vercel link               # link this checkout to your Vercel project
npx convex login              # authenticate the Convex CLI to your account
pnpm secrets:init             # pulls Vercel prod + Convex prod env into secrets/*.env
```

After `secrets:init`, `secrets/next.env` and `secrets/convex.env` are the **single source of truth** for all tom.quest secrets (gitignored).

### Daily workflow

```bash
pnpm dev:all                  # next dev (against prod Convex) + convex dev watcher for typegen
```

Open [http://localhost:3000](http://localhost:3000) and sign in with your real account.

### Changing a secret

1. Edit `secrets/next.env` (Next-side: Vercel + local) or `secrets/convex.env` (Convex-side).
2. Run `pnpm secrets:sync`. Pushes to platforms and rewrites `.env.local`.

To also delete platform vars not present in `secrets/*.env`, use `pnpm secrets:sync --prune` (opt-in; safer to default off).

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

All env vars live in `secrets/next.env` (Vercel-side) and `secrets/convex.env` (Convex-side). `pnpm secrets:sync` is the only command that should write to Vercel or Convex env.

### Vercel-side (`secrets/next.env`)

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_CONVEX_URL` | Convex prod deployment URL |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | Convex prod HTTP actions URL |
| `CONVEX_DEPLOY_KEY` | Convex deploy key |
| `SENTRY_AUTH_TOKEN` | Sentry source-maps auth |
| `OPENCLAW_GATEWAY_URL`, `JARVIS_GATEWAY_PASSWORD` | Jarvis socket config |
| `TURING_API_URL`, `TURING_API_KEY` | Turing API discovery + auth |
| Optional: `JARVIS_DEVICE_{ID,PUBLIC_KEY,PRIVATE_KEY}` | Shared Jarvis device identity |
| Optional: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CODEX_AUTH_JSON` | Canvas page LLM credentials |

### Convex-side (`secrets/convex.env`)

| Variable | Purpose |
|----------|---------|
| `SITE_URL` | Public site URL (e.g. `https://www.tom.quest`) |
| `JWT_PRIVATE_KEY` | Convex Auth JWT signing key |
| `JWKS` | Convex Auth public key set |
| `TOM_SETUP_SECRET` | Secret for the Tom-promotion mutation |

## Turing GPU Dashboard

The `/turing` page proxies requests through Next.js API routes to a FastAPI backend running on the WPI Turing HPC login node.

### Architecture

1. **Turing API** (`turing-api/`) is a FastAPI service running on a Turing login node and exposes GPU/job/terminal endpoints.
2. **Named cloudflared tunnel** maps `turing.tom.quest` to the API's local port. Stable URL — runs as a sibling process to the API.
3. **Next.js API routes** (`/api/turing/*`) read `TURING_API_URL` from env, attach the `X-API-Key` header, and proxy requests to the API. The shared key never leaves Vercel.
4. **Terminal WebSocket** opens directly from the browser to `wss://turing.tom.quest`. Auth via a short-lived HMAC token issued by `/api/turing/ws-credentials` (admin-only).
5. **Liveness** is owned by a Convex cron action (`internal.serverHealth.pollTuring`) that probes `/health` every 30s and writes the outcome to the `serverHealth` table; the UI reads it via a reactive query.

### On Turing

First-time setup:

```bash
cd ~/tom.quest/turing-api
pip install -r requirements.txt
```

Create a `.env` file (or scp `secrets/turing-api.env` from your dev machine):

```
TURING_API_KEY=<same value as in next.env and convex.env>
```

Set up a named cloudflared tunnel pointed at the API's local port (one-time):

```bash
cloudflared tunnel login
cloudflared tunnel create turing-api
cloudflared tunnel route dns turing-api turing.tom.quest

# ~/.cloudflared/config.yml — substitute the tunnel UUID printed by `create`:
# tunnel: <uuid>
# credentials-file: /home/<user>/.cloudflared/<uuid>.json
# ingress:
#   - hostname: turing.tom.quest
#     service: http://localhost:8000
#   - service: http_status:404
```

Run the API and the tunnel side by side. Two screens / tmux windows works fine:

```bash
# window 1
python main.py

# window 2
cloudflared tunnel run turing-api
```

### Updating on Turing

```bash
cd ~/tom.quest && git pull
# kill and restart the python process; cloudflared keeps running
cd turing-api && python main.py
```
