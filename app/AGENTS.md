# App

## UI Rules (ratified by Tom, 2026-08-29)

- Avoid UI behavior that moves the user unexpectedly, especially auto-scrolling.
- Prefer text inputs over number spinners for numeric intervals.
- Clickable text not styled as a button is underlined at rest. Text that is not clickable is never underlined. Accent color alone never signals clickability — it also marks state.
- Everything clickable changes visibly on hover (background or brightness shift at minimum). Block-level clickables — rows, cards, paragraphs that open detail — signal clickability through that hover response rather than an underline.
- One info mechanism: a tap-to-open popover (never hover-only, never native `title=` — both are dead on touch). Content is a plain-language explanation of what the control does on the backend, with the exact function call in small mono. New surfaces use it; existing surfaces migrate when otherwise touched.
- No explainer text in product UI. Pages are data + actions and must be self-explanatory; ground-up explanations happen in conversation, not on the page.
- Interactions never shift layout. No inline forms appearing between controls; anything composed (notes, rulings, scheduling) opens in a fixed dialog.
- Actions sit near the top of an item's detail, and their labels name their exact backend effect.

## State Management

- Client-only UI state belongs in Zustand.
- Do not store server-derived data in Zustand unless it is a local optimistic copy that syncs back to Convex.

## Routing

- User-facing URLs follow `tom.quest/{slug}`.
- Avoid query params, hash fragments, or nested prefixes for top-level quests.
- Dynamic segments are only for naturally dynamic resources, such as `/turing/terminal/[session]`.
- Page visibility is role-gated via each page's `visibility` field: `public`, `authenticated`, `admin`, or `tom`.
- Page metadata lives in `app/components/page-routes.ts`. The home page and the nav autocomplete render from `PAGES`, so a registered page appears without further wiring.
- `app/components/page-routes.test.ts` hard-codes the guest page ordering. Adding a public page means updating that expectation; the visibility e2e iterates `PAGES` and needs no edit.
- Static assets must live outside an app route's path prefix. A page at `app/<slug>/page.tsx` shadows the whole `/<slug>/*` URL space, so `public/<slug>/anything.png` returns 404 both locally and in production — which is why the `/perfume` artwork is served from `public/art/ingredients/`.
