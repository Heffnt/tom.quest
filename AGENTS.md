## Cursor Cloud specific instructions

### Services

| Service | Command | Port | Notes |
|---|---|---|---|
| Next.js dev server | `npm run dev` | 3000 | Main app; works without Supabase (auth/data features degrade gracefully) |
| Python FastAPI (tom-quest-api/) | `python main.py` | 8000 | Optional; requires HPC environment with Slurm/tmux/cloudflared — not runnable in cloud VM |

### Environment variables

Supabase credentials are required for auth and data features. Without them the app still starts and renders all pages but auth/data features return null.

- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anon key
- `SUPABASE_SERVICE_KEY` — Supabase service role key (server-side)
- `TOM_USER_ID` — UUID identifying Tom for admin features

Place these in `.env.local` at the repo root.

### Lint / Build / Dev

See `package.json` scripts: `npm run lint`, `npm run build`, `npm run dev`. Pre-existing lint errors (7 `@typescript-eslint/no-explicit-any` and 1 `react/no-unescaped-entities`) are known and do not block the build.

### Gotchas

- `npm run build` can fail on stale `.next/dev/types`; delete `.next` and rerun if that happens.
- The lockfile is `package-lock.json` — use `npm`, not pnpm/yarn.
- Node.js 22+ is required (Next.js 16).
- `tom-quest-api/` is a separate FastAPI service designed for the Turing HPC cluster and cannot run in a standard dev environment (needs Slurm, tmux, cloudflared).
