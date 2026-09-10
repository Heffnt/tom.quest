# app

## ui

- Nothing moves the user unexpectedly; never auto-scroll.
- A numeric interval is a text input, not a number spinner.
- Clickable text not styled as a button is underlined at rest; non-clickable text is never underlined. Accent colour alone never signals clickability; it also marks state.
- Everything clickable changes visibly on hover (background or brightness at minimum); a block-level clickable (row, card, paragraph) signals through that, not an underline.
- One info mechanism: a tap-to-open popover (never hover-only or native `title=`; both are dead on touch) holding a plain-language line on what the control does on the backend, plus the function call in small mono. New surfaces use it; an existing one migrates when otherwise touched.
- No explainer text in product UI. A page is data plus actions; explanation happens in conversation.
- An interaction never shifts layout. No inline form between controls; anything composed (note, ruling, schedule) opens in a fixed dialog.
- Actions sit near the top of an item's detail; each label names its backend effect.

## state

- UI-only state goes in Zustand; inspect it with the Zustand devtools.
- Server-derived data enters Zustand only as an optimistic copy that syncs back to Convex.

## routing

- A user-facing URL is `tom.quest/{slug}`; no query param, hash fragment or nested prefix for a top-level quest.
- A dynamic segment is only for a naturally dynamic resource (`/turing/terminal/[session]`).
- Pages are registered in `app/components/page-routes.ts`; the home page and nav autocomplete render from `PAGES`, so a registered page needs no other wiring.
- `page-routes.test.ts` hard-codes the guest page order; a new public page updates it. The visibility e2e iterates `PAGES`.
- A static asset lives outside every route's path prefix: `app/<slug>/page.tsx` shadows all of `/<slug>/*`, so `public/<slug>/x.png` 404s; the `/perfume` artwork is under `public/art/ingredients/`.

## gates

- A page's `visibility` is `public`, `authenticated`, `admin` or `tom`; `agentReadable: true` on the same row lets the `agent` account read it.
- On the client, `canReadSurface(label)` gates an `agent` read. In a route handler a read is `requireAdminOrAgent(request, surface)`; a write is `requireAdmin` or `requireTom`.
- A write that fires on page arrival is gated on `isTom`, so a headless screenshot records nothing.
- `/turing`, the cluster terminal included, is `visibility: "admin"`. Never narrow it to `isTom`.

## turing

- The terminal WebSocket opens from the browser to `wss://turing.tom.quest` with a short-lived HMAC token from `/api/turing/ws-credentials`.
- `app/lib/turing.ts` aborts a proxied call at 20 s; `GET /boolback-snapshot` can take longer, so the browser loads the blob in parallel and treats snapshot status as freshness only.
- Give a snapshot rebuild POST a client timeout of 45 s or more, or a second call duplicates the build.

## serving

- `next build` and `next start` in a worktree take the parent checkout as workspace root (two lockfiles) and serve the parent's `public/` and `.next`, so a new asset 404s locally and a stale parent build can be served; check it through a Playwright route intercept or on production. `outputFileTracingRoot` does not fix this.
- On Windows the PID `netstat` prints is not the node process: the old `next start` keeps the port and the new one silently fails to bind. Free it with `Get-NetTCPConnection -LocalPort <n> -State Listen | Stop-Process -Force`.
