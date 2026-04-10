# Module 4: Symbol Game

## Overview

A canvas-based mini-game where you time taps to land 3 lines in the correct zones of a rotating symbol. Fastest times are saved to a leaderboard. In the refactored site, this lives on the home page (designed in the frontend shell module).

## Dependencies on Other Modules

- **Module 2 (Auth):** `useAuth` for user identity (save scores, display username).

## Key Design Decisions

- The game logic and canvas rendering stay coupled in one component. This is appropriate for a canvas game — separating them would add complexity without benefit.
- The leaderboard is extracted into its own component. It's a separate concern (fetching/displaying a list of scores) that doesn't need to know about game mechanics.
- Supabase is accessed directly for score operations (insert and select on `symbol_scores`). No API route needed — the RLS policies handle authorization, and the data doesn't go through Turing.
- The page wrapper is a server component. The game canvas and leaderboard are client components.

## File Structure

```
app/
  components/
    symbol-game.tsx        — Canvas game (client component, ~400 lines)
    leaderboard.tsx        — Score list (client component, ~80 lines)
```

These are placed in `app/components/` (not a route directory) because the game will be embedded on the home page rather than having its own route.

## Component Designs

### 1. `app/components/symbol-game.tsx` — The Game

A self-contained canvas game component.

**Interface:**

```typescript
interface SymbolGameProps {
  onWin?: (timeMs: number) => void;  // called when player completes the symbol
}
```

**Internal state:**

- `phase: "idle" | "playing" | "launching" | "win" | "fail"` — current game state
- `placed: PlacedLine[]` — lines that have been placed
- `startMs: number` — timestamp when the round started
- `endMs: number` — completion time in ms (set on win)
- `spinDir: number` — current rotation direction (1 or -1)

**Game constants (module-level, not exported):**

- `CANVAS_SIZE = 400`
- `CIRCLE_R = 140` — circle radius
- `TARGETS` — 3 target angles (left diagonal, center, right diagonal)
- `ZONE_TOL` — angular tolerance for a hit (~12.8 degrees)
- `SPIN_BASE = 1.8` — base spin speed (rad/s)
- `SPIN_ACCEL = 0.4` — extra speed per placed line
- `LAUNCH_MS = 160` — launch animation duration

**Animation loop:**

- Uses `requestAnimationFrame` for smooth rendering.
- Mutable refs (`useRef`) track game state inside the animation loop to avoid stale closures. React state is updated in parallel for UI re-renders (overlays).
- The `draw()` function renders: outer circle, rotating horizontal bar, zone guides (dashed), placed lines (white for hits, red for misses), launching line animation, waiting line indicators at bottom, up arrow.

**Input handling:**

- Click/tap on canvas or spacebar triggers `handleTap`.
- In idle/win/fail phase: starts a new round.
- In playing phase: launches a line (enters "launching" phase).
- In launching phase: ignored (wait for animation to complete).

**Win/fail detection:**

- After launch animation completes, compute the line's local angle in the rotating frame.
- Check if it falls within `ZONE_TOL` of any unclaimed target.
- Hit + all 3 placed: win. Miss: fail.
- On win, call `onWin(elapsedMs)` if provided.

**Overlays (rendered as positioned divs over the canvas):**

- Idle: "Tap to Start" + "or press Space"
- Win: elapsed time, "Symbol complete!", play again prompt
- Fail: "Missed!", "Line landed outside a zone", try again prompt

**DPR handling:** Scale canvas by `window.devicePixelRatio` for crisp rendering on retina displays.

**Accessibility:** The canvas should have `role="application"` and `aria-label="Symbol game - tap or press space to play"`.

### 2. `app/components/leaderboard.tsx` — Score List

A collapsible leaderboard showing top times.

**Interface:**

```typescript
interface LeaderboardProps {
  onSaveScore?: (timeMs: number) => void;  // if provided, shows "Save score" button
  pendingScore?: number | null;             // score waiting to be saved
  saved?: boolean;                          // whether the pending score was saved
}
```

Actually, the leaderboard should be simpler. It just displays scores and handles saving.

**Revised interface:**

```typescript
// No props needed — it manages its own data
```

**Internal state:**

- `scores: LeaderboardEntry[]` — fetched from Supabase
- `open: boolean` — whether the list is expanded
- `saving: boolean` — whether a save is in progress
- `pendingTimeMs: number | null` — a score waiting to be saved (set by parent via ref or callback)
- `saved: boolean` — whether the last score was saved

**Behavior:**

- On mount, fetch top 20 scores from `symbol_scores` ordered by `time_ms` ascending.
- Toggle button: "Leaderboard" / "Hide Leaderboard".
- When expanded, show a ranked list: position number, username, formatted time.
- Top 3 get colored position numbers (gold, silver, bronze).
- Expose a `saveScore(timeMs: number)` method via `useImperativeHandle` (or just have the parent pass the score as a prop).

**Score saving:**

- Requires a logged-in user (from `useAuth`).
- Inserts into `symbol_scores` with `user_id`, `username` (from `user.user_metadata.username`), and `time_ms`.
- Uses Supabase client directly (not useTuring — this isn't Turing data).
- After save, re-fetch the leaderboard.

**If not logged in:** Show a "Sign in to save score" button that triggers the login modal. The parent page handles this (since LoginModal is a shared component).

### Integration on Home Page

The home page (`app/page.tsx`) will embed both components. The exact layout is designed in the frontend shell module, but the integration looks like:

```typescript
// In the home page (designed later in frontend shell module)
<SymbolGame onWin={(ms) => leaderboardRef.current?.offerSave(ms)} />
<Leaderboard ref={leaderboardRef} />
```

Or simpler with state lifting:

```typescript
const [lastWinMs, setLastWinMs] = useState<number | null>(null);

<SymbolGame onWin={setLastWinMs} />
<Leaderboard pendingScore={lastWinMs} />
```

The exact pattern is decided during frontend shell design. The key point: SymbolGame doesn't know about scores or Supabase. Leaderboard doesn't know about game mechanics. They communicate through a simple number (the completion time).

## Types

```typescript
interface PlacedLine {
  localAngle: number;   // angle in the rotating frame
  hit: boolean;         // landed in a valid zone?
}

interface LeaderboardEntry {
  id: string;
  username: string;
  time_ms: number;
  created_at: string;
}

type Phase = "idle" | "playing" | "launching" | "win" | "fail";
```

## Rules

1. The game component has zero knowledge of Supabase, auth, or score persistence. It just reports wins via `onWin`.
2. The leaderboard component has zero knowledge of game mechanics. It just displays and saves scores.
3. Canvas rendering uses `requestAnimationFrame`, never `setInterval`.
4. Mutable refs are used for state accessed inside the animation loop. React state is used only for UI overlays.
5. The `draw()` function is a pure function (canvas context + state in, pixels out). No side effects.

## Testing

### Unit tests

- `normalizeAngle` returns values in [-PI, PI]
- Zone detection: angle within tolerance of a target is a hit
- Zone detection: angle outside tolerance is a miss
- Zone detection: angle matching an already-claimed target is a miss
- Spin speed increases with number of placed lines
- `formatTime` formats milliseconds as "N.NNNs"

### E2E tests (Playwright)

- Game canvas renders on the home page
- Clicking canvas starts the game (phase changes from idle to playing)
- Leaderboard toggle shows/hides the score list
- Score list shows entries sorted by time ascending

## Dependencies

No new dependencies. The game uses the native Canvas API. The leaderboard uses the existing Supabase client.

## Migration Notes

- Delete `app/symbol/page.tsx` — the game moves to the home page.
- The `symbol_scores` Supabase table schema stays the same (already defined in Module 2's SQL).
- The `/api/symbol/scores/route.ts` API route can be deleted — the leaderboard reads from Supabase directly using the browser client with RLS.
