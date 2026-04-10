# Module 0: Frontend Shell

## Overview

The frontend shell is the visual foundation of tom.quest — the layout, navigation, global styles, and design system that every page inherits. It is built first because every other module depends on it.

## Design Philosophy: "Observatory"

tom.quest is the personal site of a PhD student researching AI security. The design draws from scientific instrument panels and observatory control rooms: dark, precise, purposeful. Every element earns its place. The visual language communicates: this person builds precise things.

The Symbol game (a rotating circle with timed line placements) is the site's logo and visual DNA. Its geometry — circles, thin lines, rotational motion, stark contrast — informs the design language across every page.

**Key principles:**

- **Precision over decoration.** Spacing is exact. Borders are thin. Alignment is deliberate. Nothing is approximate.
- **Instrument aesthetic.** The site feels like a well-designed control panel. Dark surfaces, muted labels, accent-lit indicators. Information is displayed, not decorated.
- **Restraint.** Generous negative space. Few colors. Motion is slow and purposeful — things settle into place like a gauge needle, never bounce or overshoot.
- **Depth through subtlety.** Backgrounds are not flat black — they have a deep blue undertone that gives dimension. Surfaces lift slightly from the background. Borders are barely visible until you need them.

## Design System

### Color Palette (CSS custom properties)

```css
--color-bg:          #0a0e17;    /* deep navy-black — the void */
--color-surface:     #111827;    /* cards, panels — slightly lifted */
--color-surface-alt: #1a2332;    /* hover states, secondary surfaces */
--color-border:      #1e293b;    /* thin precise dividers */
--color-text:        #e2e8f0;    /* primary text — off-white */
--color-text-muted:  #64748b;    /* labels, metadata, secondary info */
--color-text-faint:  #334155;    /* disabled, placeholder */
--color-accent:      #e8a040;    /* amber — instrument light, active indicators */
--color-accent-dim:  #e8a04020;  /* amber at low opacity — subtle glows, backgrounds */
--color-success:     #22c55e;    /* green — status OK, free GPUs */
--color-warning:     #eab308;    /* yellow — pending, caution */
--color-error:       #ef4444;    /* red — errors, down, failed */
```

The accent color is amber, not blue. Blue is expected for tech sites. Amber says "precision instrument" — it's the color of warming lights, old gauges, and observatory equipment. It's warm against the cold dark background and immediately sets this site apart.

The background is not pure black (#000). It's a deep navy (#0a0e17) with blue undertones that give the dark surfaces depth and atmosphere, like looking into deep water or a night sky.

### Typography

Three tiers, each chosen for the instrument metaphor:

**Display — Syne (Google Fonts)**
- Weights: 600, 700, 800
- Used for: page titles, section headings, the site name
- Why: Geometric with real personality. Angular, precise, slightly futuristic without being sci-fi. Not overused. It feels like text etched into a control panel faceplate.

**Body — IBM Plex Sans (Google Fonts)**
- Weights: 400, 500, 600
- Used for: paragraphs, UI labels, buttons, navigation
- Why: Designed by IBM for technical interfaces. Clean, highly readable, feels engineered rather than designed. Pairs well with Syne's geometry.

**Mono — IBM Plex Mono (Google Fonts)**
- Weights: 400, 500
- Used for: job IDs, session names, terminal output, GPU node names, paths, code, data values
- Why: Same family as the body font so it harmonizes visually. Technical data should always feel like data, not prose.

**Type scale:**

```css
--text-xs:   0.75rem;   /* 12px — fine print, badges */
--text-sm:   0.875rem;  /* 14px — secondary labels, metadata */
--text-base: 1rem;      /* 16px — body text */
--text-lg:   1.125rem;  /* 18px — lead paragraphs */
--text-xl:   1.25rem;   /* 20px — section subheadings */
--text-2xl:  1.5rem;    /* 24px — section headings */
--text-3xl:  1.875rem;  /* 30px — page subtitles */
--text-4xl:  2.25rem;   /* 36px — page titles */
--text-5xl:  3rem;      /* 48px — hero display */
```

**Letter spacing:** Headings in Syne use slightly positive tracking (+0.01em to +0.02em) to let the geometric letterforms breathe. Body text uses default tracking. Monospace uses no extra tracking.

### Spacing

Use Tailwind's default spacing scale. Consistent spacing is critical to the precision feel:

- Between sections: `space-y-16` (4rem)
- Between content blocks: `space-y-8` (2rem)
- Inside panels/cards: `p-6` (1.5rem)
- Between form fields: `space-y-4` (1rem)

### Borders & Surfaces

- Borders are 1px, using `--color-border`. Never thicker unless it's a deliberate accent.
- Cards/panels use `--color-surface` background with `border border-[--color-border] rounded-lg`.
- No shadows. Depth comes from color differentiation (surface vs background), not blur.
- Hover states on interactive surfaces: shift to `--color-surface-alt`.

### Motion

All animation is CSS-only. No animation libraries.

**Page entrance:** Content fades in with a slight upward translation. Like a gauge needle settling.

```css
@keyframes settle {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.animate-settle {
  animation: settle 0.5s ease-out forwards;
}
```

Use staggered `animation-delay` for sequential elements (0ms, 80ms, 160ms). Never more than 3-4 staggered items — restraint, not waterfall.

**Hover transitions:** `transition-colors duration-150` — fast and crisp, like a switch flipping. No slow fades.

**No bounce, no spring, no overshoot.** Everything moves like precision machinery: smooth, damped, purposeful.

### Interactive Elements

**Buttons:**

- Primary: `bg-[--color-accent] text-[--color-bg] font-medium` — amber on dark. Used sparingly for the most important action on a page.
- Secondary: `bg-[--color-surface-alt] text-[--color-text] border border-[--color-border]` — subtle, for most actions.
- Danger: `text-[--color-error] bg-[--color-error]/10` — for cancel, delete.
- All buttons: `rounded-lg px-4 py-2 text-sm`. No rounded-full pills. Rectangular with slight rounding — precise, not playful.

**Inputs:**

- `bg-[--color-bg] border border-[--color-border] rounded-lg px-3 py-2 text-[--color-text]`
- Focus: `border-[--color-accent] outline-none` — the amber accent lights up on focus, like an instrument being activated.
- Font: IBM Plex Sans for labels, IBM Plex Mono for data inputs (paths, IDs, commands).

**Toggle switches:**

- Small, precise. Off: `bg-[--color-surface-alt] border-[--color-border]`. On: `bg-[--color-accent]`.
- The knob should be a clean circle that slides — no labels inside the switch.

**Status indicators:**

- Small circles (w-2 h-2): green for connected/running, amber for pending/warning, red for error/down.
- These are the "LED lights" of the control panel.

### Accessibility & Agent Navigability

Every interactive element and content section should use semantic HTML:

- `<nav>` for navigation with `aria-label="Main navigation"`
- `<main>` for page content
- `<header>` for the nav bar
- `<section>` with `aria-label` for each content section
- `<button>` for all clickable elements (never `<div onClick>`)
- `<table>` with `<thead>` and `<tbody>` for tabular data
- `role="dialog"` and `aria-modal="true"` for modals
- All form inputs have associated `<label>` elements

This matters because the user wants the site navigable by Playwright agents. Semantic HTML means agents can find elements by role (`getByRole('button', { name: 'Allocate' })`) instead of fragile CSS selectors.

## File Structure

```
app/
  layout.tsx                    — Root layout (server component)
  globals.css                   — Design system CSS variables, base styles, animations
  page.tsx                      — Home page (Symbol game, server wrapper)
  bio/
    page.tsx                    — Bio page (server component, static)
  turing/
    page.tsx                    — (built in Module 3)
  jarvis/
    page.tsx                    — (exists, updated in Module 5)
  lib/
    auth.tsx                    — (built in Module 2)
    supabase.ts                 — (built in Module 2)
  components/
    navigation.tsx              — Nav bar (client component)
    login-modal.tsx             — Sign in / sign up modal (client component)
    profile-modal.tsx           — Username display + sign out (client component)
    symbol-game.tsx             — (built in Module 4)
    leaderboard.tsx             — (built in Module 4)
    debug-drawer.tsx            — Tom-only debug log drawer (client component)
```

## File Designs

### 1. `app/globals.css`

Contains:

- Tailwind v4 import: `@import "tailwindcss";`
- `@theme inline` block defining all CSS custom properties (colors, fonts, spacing)
- Font-face declarations or Google Fonts import for Syne, IBM Plex Sans, IBM Plex Mono
- Base element styles:
  - `body`: `background: var(--color-bg); color: var(--color-text); font-family: 'IBM Plex Sans', sans-serif;`
  - `h1, h2, h3`: `font-family: 'Syne', sans-serif;`
  - `code, pre, .font-mono`: `font-family: 'IBM Plex Mono', monospace;`
  - `button, input, select, textarea`: `font: inherit;` (prevents browser defaults)
- Animation keyframes: `settle` (fade up), with utility classes `.animate-settle`, `.animate-settle-delay-1`, `.animate-settle-delay-2`, `.animate-settle-delay-3` (80ms increments)
- No scrollbar styling (keep native)

**Font loading:** Use `next/font/google` in `layout.tsx` to load Syne, IBM Plex Sans, and IBM Plex Mono. This gives automatic font optimization (preload, font-display swap, no layout shift). Define CSS variables for each: `--font-display`, `--font-body`, `--font-mono`.

### 2. `app/layout.tsx` — Root Layout

Server component. Minimal.

```
html (lang="en")
  body (font variables, antialiased)
    AuthProvider           ← client boundary starts here
      header
        Navigation
      main
        {children}
      DebugDrawer          ← Tom-only, renders nothing for others
```

**Key decisions:**

- `AuthProvider` wraps the entire tree because both Navigation (needs user state) and DebugDrawer (needs isTom) are client components.
- `<main>` has `pt-16` (or whatever the nav height is) to clear the fixed nav.
- No `FeedbackButton`. No `ClientProviders` wrapper — AuthProvider is used directly.
- Metadata: title "tom.Quest", description, favicon.

### 3. `app/components/navigation.tsx` — Nav Bar

Client component (needs `useAuth` for login state and `usePathname` for active link).

**Desktop layout (>= 768px):**

```
[logo]                                    [Bio] [Turing] [Jarvis]  [Log in / username]
```

- Fixed to top, `bg-[--color-bg]/80 backdrop-blur-sm border-b border-[--color-border]`.
- Logo: the tom.quest wordmark (SVG, links to `/`). White, subtle hover opacity change.
- Links: IBM Plex Sans, `text-sm`, `text-[--color-text-muted]`. Active page: `text-[--color-accent]` with a small amber dot indicator below (2px wide, centered under the text). Hover: `text-[--color-text]`.
- Login button: `border border-[--color-border] rounded-lg px-3 py-1.5 text-sm`. When logged in: shows username. Tom's username gets a subtle amber border.
- `<nav>` element with `aria-label="Main navigation"`. Links are an `<ul>` with `<li>` items.

**Mobile layout (< 768px):**

- Logo on left, hamburger icon on right.
- Hamburger opens a full-screen overlay: dark background, centered links stacked vertically, larger text. Close button (X) in top right.
- The overlay uses `role="dialog"` and `aria-modal="true"`. Focus is trapped inside while open.

**Nav links array:**

```typescript
const NAV_LINKS = [
  { href: "/bio", label: "Bio" },
  { href: "/turing", label: "Turing" },
  { href: "/jarvis", label: "Jarvis" },
];
```

No conditional links. No Feedback link. No Credits link.

### 4. `app/components/login-modal.tsx` — Auth Modal

Client component. A modal for signing in or signing up.

**Behavior:**

- Defaults to "Sign in" mode. Toggle to "Sign up" mode.
- Fields: Username (text input) and Password (password input).
- Sign up: calls `signUp(username, password)` from `useAuth()`.
- Sign in: calls `signIn(username, password)` from `useAuth()`.
- Shows error messages inline below the form.
- On success: closes the modal.
- Backdrop click or X button closes the modal.

**Styling:**

- Centered modal over a dark backdrop (`bg-black/60 backdrop-blur-sm`).
- Modal card: `bg-[--color-surface] border border-[--color-border] rounded-lg p-6 max-w-sm`.
- Submit button uses the primary amber style.
- The modal should use `role="dialog"`, `aria-modal="true"`, and trap focus.

### 5. `app/components/profile-modal.tsx` — Profile Modal

Client component. Shows when clicking the username in the nav.

**Content:**

- Display username (from `user.user_metadata.username`)
- "Sign out" button (calls `signOut()` from `useAuth()`)
- Close button

**Styling:** Same modal pattern as login-modal. Small and focused.

### 6. `app/components/debug-drawer.tsx` — Tom-Only Debug Panel

Client component. A slide-out drawer for inspecting all network activity and errors.

**Visibility:** Only renders content when `isTom` is true. For all other users, renders nothing (returns null).

**Trigger:** A small amber dot (`w-3 h-3 rounded-full bg-[--color-accent]`) fixed to the bottom-right corner. Only visible to Tom. Clicking it slides the drawer open.

**Drawer layout:**

- Slides in from the right edge of the screen.
- Width: `max-w-lg` (32rem). Full height.
- Background: `--color-surface`. Border on the left edge.
- Does NOT push page content (it overlays).

**Header (sticky at top of drawer):**

- "Debug" title
- Close button (X)
- Filter toggles: small badges for each log type (request, response, error, info). Click to toggle visibility. Active filters use their type color; inactive are muted.
- Search input for filtering log text
- Clear button to wipe logs

**Log entries:**

- Each entry shows: timestamp (monospace, muted), type badge (colored), message.
- Expandable: click an entry to show full detail (request body, response body, error stack).
- Color coding: request=blue, response=green, error=red, info=amber.
- Max 500 entries (drop oldest).

**How logs get there:**

- Keep the existing `CustomEvent` pattern from `app/lib/debug.ts`. Components dispatch `tomquest-debug` events on `window`, the drawer listens.
- `logDebug()` and `debugFetch()` stay as utilities. They work even when the drawer is not mounted (events fire into the void for non-Tom users — no performance cost).

**Why a drawer instead of a bottom panel:**

- The bottom panel in the current site pushes page content up (adjusts body padding). This breaks layouts and is visually disruptive.
- A right-edge drawer overlays without affecting layout. It's the standard pattern for dev tools panels.
- It slides in/out cleanly with a CSS transform transition.

**Agent-friendly errors:**

- Error log entries should include: the URL that failed, the HTTP status code, the response body (if available), and a clear error message.
- The full detail view for each entry shows raw JSON that an agent could parse.

### 7. `app/page.tsx` — Home Page

Server component wrapper with client game components.

**Layout:**

```
Full viewport height, centered content:

  [Symbol Game canvas — 400x400, centered]

  [Tom Heffernan]              ← Syne, text-4xl, animate-settle
  [PhD Student, AI @ WPI]     ← IBM Plex Sans, text-lg, text-muted, animate-settle-delay-1

  [Leaderboard toggle]        ← animate-settle-delay-2
```

- The game is the hero. It sits in the center of the viewport, already rotating when you arrive.
- Name and descriptor are below the game, centered, understated.
- Leaderboard is below that, collapsed by default.
- Generous vertical spacing between game, name, and leaderboard.
- The login modal is imported here (for "sign in to save score" flow from the game).

**Server/client split:**

- `page.tsx` is a server component that renders the static text (name, descriptor) and imports the client components (`SymbolGame`, `Leaderboard`).
- The game and leaderboard are `"use client"` components.

### 8. `app/bio/page.tsx` — Bio Page

Server component. Static content. No client-side JavaScript.

**Content sections (same as current, restyled):**

- About (paragraph)
- Research Interests (bulleted list)
- Education (timeline with left border)
- Skills (tag chips)
- Connect (LinkedIn link)

**Styling:**

- `max-w-3xl mx-auto px-6 py-16`
- Page title: Syne, `text-4xl font-bold`
- Section headings: Syne, `text-2xl font-semibold`
- Body text: IBM Plex Sans, `text-[--color-text]/80 leading-relaxed`
- Skill tags: `border border-[--color-border] rounded-lg px-3 py-1 text-sm text-[--color-text-muted]`
- Education timeline: left border uses `border-[--color-border]`, not `border-white/20`
- Section spacing: `mt-12` between sections
- Staggered settle animation on sections

## Files to Delete

- `app/components/AuthProvider.tsx` — replaced by `app/lib/auth.tsx` (Module 2)
- `app/components/ClientProviders.tsx` — no longer needed, AuthProvider used directly in layout
- `app/components/FeedbackButton.tsx` — feedback removed entirely
- `app/components/DebugPanel.tsx` — replaced by `debug-drawer.tsx`
- `app/components/Navigation.tsx` — replaced by `navigation.tsx` with new design
- `app/components/LoginModal.tsx` — replaced by `login-modal.tsx` with new design
- `app/components/ProfileModal.tsx` — replaced by `profile-modal.tsx` with new design
- `app/page.tsx` — replaced with new home page
- `app/bio/page.tsx` — replaced with restyled version
- `app/symbol/page.tsx` — game moves to home page
- `app/feedback/page.tsx` — feedback removed
- `app/credits/page.tsx` — credits removed
- `app/cube/` — entire directory removed
- `app/boolback/` — entire directory removed
- `app/api/feedback/route.ts` — feedback removed
- `app/api/auth/is-tom/route.ts` — replaced by client-side check (Module 2)
- `app/api/symbol/scores/route.ts` — leaderboard uses Supabase directly
- `app/api/cube/` — entire directory removed
- `app/lib/debug.ts` — keep this file (the event dispatch utilities), but the DebugPanel consumer is replaced by debug-drawer
- `app/lib/userSettings.ts` — replaced by `use-persisted-settings.ts` (Module 3)

## Dependencies to Install

```
npm install @next/font
```

No other new dependencies. Syne, IBM Plex Sans, and IBM Plex Mono are loaded via `next/font/google` (built into Next.js, no additional package needed). Remove `@next/font` from the command above — `next/font` is built in.

Actually, no new dependencies are needed for this module. `next/font/google` is built into Next.js.

## Rules

1. Every page that can be a server component MUST be a server component. Only add `"use client"` to components that need interactivity (hooks, event handlers, browser APIs). The Bio page ships zero JavaScript.
2. All colors use CSS custom properties, never hardcoded hex values in components. This makes the design system changeable from one place.
3. All headings use Syne. All body text uses IBM Plex Sans. All data/code uses IBM Plex Mono. No exceptions.
4. Animation is CSS-only. No animation libraries. Motion is always `ease-out` — things decelerate into place, never bounce.
5. The debug drawer renders `null` for non-Tom users. It should not add event listeners, allocate state, or do any work when inactive.
6. Navigation uses semantic HTML (`<nav>`, `<ul>`, `<li>`, `<a>`). All interactive elements are `<button>` or `<a>`, never `<div onClick>`.
7. The mobile menu traps focus and is dismissable with Escape.
8. No shadows anywhere. Depth comes from color differentiation only.

## Testing

### E2E tests (Playwright)

- Home page loads with the Symbol game canvas visible
- Navigation links are present and lead to correct pages
- Bio page renders all sections (About, Research, Education, Skills, Connect)
- Login modal opens from nav, sign up works, modal closes on success
- Profile modal shows username and sign out button
- Mobile: hamburger menu opens overlay with all nav links
- Debug drawer is NOT visible when not logged in as Tom
- Debug drawer IS visible (amber dot) when logged in as Tom
- Debug drawer opens on dot click, shows log entries, closes on X
- Active nav link shows amber indicator on the correct page
