# Inventory: everything the session screen renders above the message list

Produced for the batch "Remove the session screen's top chrome so the chat fills
the page". This document is the list Tom rules from. Nothing here has been
deleted or changed — the next step is his ruling on each row.

The session screen is `/sessions?session=<id>`, rendered by
`app/sessions/sessions-client.tsx` when a session is open. The message list is
the transcript, `app/sessions/components/transcript.tsx`.

Line numbers are against the branch this file was committed on.

## 1. What sits above the message list, in top-to-bottom screen order

### Layer A — the site navigation bar (not part of this page)

`app/components/app-shell.tsx:37-41` mounts `NavTerm` for every route except
`/`. It is `fixed top-0` and 4rem (64px) tall, so it sits above this page's own
header on the session screen too.

| # | On screen | Renders from | What it does | Sole route? |
|---|---|---|---|---|
| A1 | tom.Quest logo | `app/components/nav-term.tsx:160-168` | Link to `/`. | Only control on this page that reaches the home page. |
| A2 | `>` navigate… text field | `app/components/nav-term.tsx:170-194` | Type a slug, Enter pushes `/<slug>`. Reaches every page including `/sessions` (the list). | No — the browser URL bar reaches the same places. |
| A3 | "show pages ▼" button | `app/components/nav-term.tsx:195-205` | Opens the ranked page dropdown (`nav-term.tsx:232-266`). | Yes for the page list; nothing else enumerates the routes. |
| A4 | "Tom" button (or "Log in") | `app/components/nav-term.tsx:208-227` | Opens the profile modal, or the login modal when signed out. | Yes — sign-out and account details are reachable nowhere else. |
| A5 | "debug" button | `app/components/nav-term.tsx:228` (`DebugToggle`) | Opens the Tom-only left diagnostic panel. | Yes. |

### Layer B — the worker banner (this page, conditional)

`app/sessions/sessions-client.tsx:67-86`, mounted at line 92 inside the session
container. It renders only when the daemon heartbeat is stale or the last
transcript write was rejected. **It was on screen in both captures taken for
this inventory**, so it is not a rare state.

| # | On screen | Renders from | What it does | Sole route? |
|---|---|---|---|---|
| B1 | "worker last heard from … (reports at least every 30s)" / "worker has not reported yet" | `sessions-client.tsx:71-75` | States the daemon is not reporting. Nothing else on the page states it; the "as of …" fact in C10 is derived from the same staleness flag. | Yes. |
| B2 | "last rejected write: …" + up to 200 characters of the Convex error | `sessions-client.tsx:77-83` | States that the daemon tried to write a transcript row and Convex refused it. | Yes — this string exists nowhere else in the app. |

### Layer C — the session header (this page)

`app/sessions/components/session-view.tsx:99-191`, a bordered band of up to
three rows.

| # | On screen | Renders from | What it does | Sole route? |
|---|---|---|---|---|
| C1 | `←` button | `session-view.tsx:101-108` | Calls `onBack` → `closeSession` (`sessions-client.tsx:55-58`): clears the open session and replaces the URL with `/sessions`. | No. Typing `sessions` in the nav field (A2) and the browser back button both return to the list. |
| C2 | Session title, e.g. "auto: Remove tiedEmbeddings from the transformer model config at a" | `session-view.tsx:109-118` | States the title, **and is the rename control**: tapping it swaps in a text input (`120-136`) whose blur saves via the `renameSession` mutation (`81-90`). | **Yes for renaming.** `renameSession` is called from this one place in the whole app. The title text itself also appears on the session list row (`session-list.tsx:410`). |
| C3 | "autonomous" chip | `session-view.tsx:138-142` | States `session.mode === "autonomous"`. | Not on this page anywhere else; duplicated on the list row (`session-list.tsx:422-425`). |
| C4 | Status chip: requested / starting / running / idle / awaiting-permission / failed / ended | `session-view.tsx:143-147`, colours in `app/sessions/lib.ts:30-46` | States the session status. | For a **live** session, yes — the composer shows Interrupt/Stop but never names the status. For an **ended or failed** session the composer already says "session ended — …" (`composer.tsx:117-120`). Duplicated on the list row (`session-list.tsx:413`). |
| C5 | Repository name, e.g. "tom.quest" | `session-view.tsx:150` | States which repository the session was started against. | Only statement of it on this page; duplicated on the list row (`session-list.tsx:427`). |
| C6 | Age, e.g. "12 min ago" | `session-view.tsx:151` | Age of `statusChangedAt` — how long the session has been in its current status. | Only statement of it on this page; duplicated on the list row (`session-list.tsx:428`). |
| C7 | "linked item" link | `session-view.tsx:152-159` | Link to `/tts?item=<todoId>` — the todo this session was opened for. | **Yes, and in both directions.** No other file in the app links a session to its todo, and no TTS surface links a todo to its session: a repo-wide search for `/sessions` outside `app/sessions/` finds only Turing terminal API paths. |
| C8 | Working directory, e.g. `/var/cache/tts/sessions/<id>/tom.quest` | `session-view.tsx:160-162` | States the checkout the session ran in. | Stated nowhere else, though the same path appears incidentally inside transcript tool arguments. |
| C9 | "last output 4m ago" | `session-view.tsx:163-167` (threshold `session-view.tsx:18`, 2 minutes) | Only while `running`: says no SDK event has arrived for over two minutes — the signal that a running session is actually wedged. | Yes. |
| C10 | "as of <time>" | `session-view.tsx:168-175` | Only while the daemon heartbeat is stale and the session is live: warns that the status shown is last-known, not current. | Yes. |
| C11 | "outcome: completed — <summary>" (red when errored) | `session-view.tsx:181-190` | Only for a non-live session: the outcome and its full summary, untruncated. Two lines at 1280px, seven on a phone. | The list row shows the same summary truncated to 90 characters (`session-list.tsx:431-434`); the untruncated text is here only. |

Not above the message list, listed so the ruling is not confused about them: the
agent panel is a sibling **column** to the right (`session-view.tsx:213-217`),
and the permission-card strip (`203-211`) and composer (`220`) are **below**.

## 2. What the chrome costs, measured

Screenshots taken through a signed-in headless browser against production.
Heights to the nearest ~5px.

| Viewport | Session | Nav (A) | Banner (B) | Header (C) | Total before the first message |
|---|---|---|---|---|---|
| 1280×900 | running | 64px | ~50px | ~66px | ~180px, 20% of the viewport |
| 390×844 (phone) | ended, with outcome | 64px | ~84px | ~215px | ~363px, 43% of the viewport |

The banner was present in both. Without it, a phone showing a live session loses
roughly 124px to the nav plus a two-line header.

## 3. How the message list is sized and scrolled

Nothing is computed against the header's height. The chain is:

1. `app/components/app-shell.tsx:32-33` — every non-home route gets `pt-16` on
   `<main>`, which is what reserves space for the `fixed` nav.
2. `app/sessions/sessions-client.tsx:91` — the open-session container is
   `h-[calc(100dvh-4rem)] flex flex-col w-full`. The `4rem` is the nav's height,
   written as a literal.
3. `app/sessions/components/session-view.tsx:98` — `flex-1 min-h-0 flex flex-col`.
   The header at line 99 is an ordinary flex child sized by its own content.
4. `session-view.tsx:199-200` — the conversation row is `flex-1 min-h-0`.
5. `transcript.tsx:352` — `relative flex-1 min-h-0`; the scrolling element is the
   inner `h-full overflow-y-auto` at line 356.

**Consequence for the batch:** deleting the header (layer C) needs no other
change. It is a flex child; removing it hands its rows straight to the
transcript, and no gap is left behind.

**The one real trap** is the nav, not the header. `pt-16` (step 1) and
`calc(100dvh-4rem)` (step 2) are two independent hard-coded copies of the same
4rem. If the nav is removed from this route, both must change together:

- change `pt-16` only → the container is 4rem shorter than the space it has, and
  a 4rem empty band sits at the bottom of the page;
- change the `calc` only → the page is 4rem taller than the viewport, so the
  whole document scrolls underneath the transcript's own scrollbar.

## 4. The part of Tom's ruling that the header alone does not settle

Removing the session header does **not** put a message at the top of the
viewport. The site navigation bar (layer A) renders above it on every non-home
route, so 64px of chrome remains. A ruling that only covers layer C produces a
message list starting at 64px, not 0. Layer A therefore has to be ruled too, and
its five controls include the only routes to sign-out (A4) and the diagnostic
panel (A5) that exist anywhere in the app.
