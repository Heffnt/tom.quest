# Module 3: Turing Dashboard

## Overview

The Turing dashboard is the core feature of tom.quest — a web interface for managing GPU jobs on the university HPC cluster. The current implementation is a single 1,650-line file with 47 state variables. This module breaks it into focused sub-components, each hiding its own complexity behind a simple interface.

## Dependencies on Other Modules

- **Module 1 (Data Layer):** `useTuring` for reading GPU/job data, `useTuringMutation` for allocate/cancel, `/api/turing/tunnel-url` for terminal WebSocket URL.
- **Module 2 (Auth):** `useAuth` for `isTom` check (gates terminal access and write operations).

## File Structure

```
app/
  turing/
    page.tsx                          — Page shell (~50 lines)
    components/
      gpu-grid.tsx                    — GPU availability visualization
      allocate-form.tsx               — Allocation form with dir picker + command presets
      job-table.tsx                   — Active jobs table with cancel modals
      terminal-modal.tsx              — Interactive xterm.js terminal (Tom only)
      session-viewer.tsx              — Read-only tmux output viewer (non-Tom)
  lib/
    hooks/
      use-persisted-settings.ts       — Generic settings persistence hook

tom-quest-api/
    ws.py                             — WebSocket endpoint for terminal PTY
    requirements.txt                  — Add websockets dependency
    main.py                           — Register WebSocket route
```

## Component Designs

### 1. `app/turing/page.tsx` — Page Shell

The page component composes everything. It owns the two `useTuring` data subscriptions and passes data down to children.

**Behavior:**

1. Call `useTuring<GPUReport>("/gpu-report", { refreshInterval: 30 })`.
2. Call `useTuring<Job[]>("/jobs", { refreshInterval: 30 })`.
3. Get `isTom` from `useAuth()`.
4. Render title, description, and all sub-components.
5. Show a read-only banner for non-Tom users.

**Props passed to children:**

- `<GPUGrid>` receives `gpuReport` data (or null), loading state, and error.
- `<AllocateForm>` receives `isTom` (to show/hide), and an `onSuccess` callback that calls `gpus.refresh()` and `jobs.refresh()`.
- `<JobTable>` receives `jobs` data, loading state, error, `isTom`, and `jobs.refresh()`.

**What this does NOT own:**

- Any form state (that's in AllocateForm)
- Collapsed partitions (that's in GPUGrid)
- Cancel modal state (that's in JobTable)
- Terminal state (that's in TerminalModal)

### 2. `app/turing/components/gpu-grid.tsx` — GPU Availability

A display component that renders the SVG grid of GPU boxes.

**Interface:**

```typescript
interface GPUGridProps {
  data: GPUReport | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}
```

**Internal state (managed by the component, not exposed):**

- `collapsedPartitions: Set<string>` — which partition sections are collapsed
- `gpuOnlyFilter: boolean` — whether to show only GPU-named nodes

**Persistence:** Collapsed partitions and gpuOnlyFilter are persisted via `usePersistedSettings` (see below) under the key `"turing_gpu_grid"`.

**Rendering:**

- Section header: "GPU Availability" with a refresh button.
- Legend row: colored boxes with counts for Free (green), In Use (gray), Down (red). Counts reflect only visible (non-collapsed) nodes.
- GPU-only filter toggle.
- For each partition: a collapsible section header. Inside, for each GPU type: a label (e.g. "nvidia (H100)") and a row of node cards. Each node card contains:
  - Node name (monospace)
  - SVG grid of GPU boxes (colored by status)
  - Memory bar showing allocated/total GB
- Footer: visible GPU totals.

**GPU type labels:** Map `{ nvidia: "H100", tesla: "V100" }`. Show as `"nvidia (H100)"`.

**Accessibility:** Use `<section>` with `aria-label` for each partition. Use `<button>` for collapsible headers with `aria-expanded`.

### 3. `app/turing/components/allocate-form.tsx` — Allocation Form

A form component for requesting GPU allocations. Only rendered when `isTom` is true.

**Interface:**

```typescript
interface AllocateFormProps {
  isTom: boolean;
  onSuccess: () => void;  // called after successful allocation to refresh data
}
```

If `isTom` is false, renders a message: "Sign in as Tom to allocate GPUs."

**Internal state:**

- `gpuType: string` — selected GPU type
- `count: string` — number of GPUs (blank = all free)
- `timeMins: string` — allocation time in minutes
- `memoryMb: string` — memory in MB
- `projectDir: string` — project directory path
- `recentDirs: string[]` — recently used directories (persisted)
- `commands: string[]` — list of commands to run
- `commandPresets: Record<string, { name: string; commands: string[] }[]>` — saved command sets per directory (persisted)

**Uses:** `useTuringMutation` for the `/allocate` endpoint, `useTuring` for `/gpu-types` (to populate the GPU type dropdown with free counts).

**Directory selection redesign:**

- Primary UX: a text input where you type/paste a path.
- Below the input: a dropdown of `recentDirs` (most recent first, max 10). Click one to fill the input.
- Secondary: a "Browse" button that opens the directory browser modal as a fallback.
- When a directory is used for allocation, it's added to the front of `recentDirs` (deduped).
- The directory browser modal (if opened) uses `useTuring("/dirs?path=...")` to list directories. It's a simple modal with an "Up" button, a list of subdirectories, and a "Select" button.

**Command presets redesign:**

- Only visible when `projectDir` is non-empty.
- A dropdown (HTML `<select>`) listing saved presets for the current directory.
- "Load" fills the commands list. "Delete" removes the selected preset.
- A "Save current commands as..." input + button to save the current command list as a named preset.
- Presets are stored in `commandPresets[projectDir]` and persisted via settings.

**Command list:**

- A vertical list of text inputs, each with a remove button (shown when >1 command).
- An "Add command" button at the bottom.

**Validation (before submitting):**

- GPU type must be selected.
- Time must be a positive integer.
- Memory must be a positive integer.
- Count (if provided) must be 1-12.
- Show validation errors inline, not as alerts.

**On submit:**

1. Call `allocate.trigger({ gpu_type, time_mins, memory_mb, count, commands, project_dir })`.
2. On success: show success message, add `projectDir` to `recentDirs`, call `onSuccess()`.
3. On error: show error message from the mutation.

**Persistence:** `recentDirs`, `commandPresets`, `gpuType`, `timeMins`, `memoryMb` are persisted via `usePersistedSettings` under key `"turing_allocate"`.

### 4. `app/turing/components/job-table.tsx` — Active Jobs Table

A table of active SLURM jobs with cancel and terminal/view actions.

**Interface:**

```typescript
interface JobTableProps {
  data: Job[] | null;
  loading: boolean;
  error: string | null;
  isTom: boolean;
  onRefresh: () => void;
}
```

**Internal state:**

- `cancelJobId: string | null` — which job's cancel confirmation modal is open
- `cancelAllOpen: boolean` — whether the "cancel all" confirmation modal is open
- `terminalSession: string | null` — which session's terminal/viewer is open

**Table columns:** Job ID, GPU type, Status (with colored badge), Time Left, Session name, Actions.

**Status display:** RUNNING jobs get a green badge, PENDING gets yellow. The reason string (node name or queue reason) is shown in parentheses.

**Actions column:**

- "Terminal" button (Tom only, only for RUNNING jobs with a session name): opens `<TerminalModal>`.
- "View" button (non-Tom, only for RUNNING jobs with a session name): opens `<SessionViewer>`.
- "Cancel" button (Tom only): opens a confirmation modal.

**Cancel modals:**

- Single cancel: "Cancel job {id}?" with Keep/Cancel buttons.
- Cancel all: "Cancel all {n} jobs?" with Keep/Cancel All buttons.
- Both modals show loading state during the cancel request and error messages on failure.
- Use `useTuringMutation("/jobs/{id}", "DELETE")` for single cancel. For cancel all, iterate through jobs sequentially.
- On successful cancel, call `onRefresh()`.

**Session navigation:** When a terminal/viewer is open, show left/right arrows if there are multiple viewable sessions. This allows cycling through sessions without closing and reopening.

**Accessibility:** Use `<table>` with `<thead>` and `<tbody>`. Cancel buttons have `aria-label="Cancel job {id}"`. Modal has `role="dialog"` and `aria-modal="true"`.

### 5. `app/turing/components/terminal-modal.tsx` — Interactive Terminal (Tom only)

A full interactive terminal emulator in the browser using xterm.js, connected to a tmux session on Turing via WebSocket.

**Interface:**

```typescript
interface TerminalModalProps {
  sessionName: string;
  allSessions: string[];       // for left/right navigation
  onClose: () => void;
  onNavigate: (sessionName: string) => void;
}
```

**Dependencies to install:**

- `@xterm/xterm` — terminal emulator UI
- `@xterm/addon-fit` — auto-resize terminal to container
- `@xterm/addon-web-links` — clickable URLs in terminal output

**Behavior:**

1. On mount, fetch the tunnel URL from `/api/turing/tunnel-url` (Tom-only endpoint from Module 1).
2. Construct WebSocket URL: replace `https://` with `wss://` in the tunnel URL, append `/ws/sessions/{sessionName}`.
3. Open a WebSocket connection.
4. Initialize an xterm.js `Terminal` instance and attach it to a container `<div>`.
5. Pipe WebSocket messages to `terminal.write()` (data from Turing → screen).
6. Pipe `terminal.onData()` to WebSocket `send()` (keystrokes → Turing).
7. Use the `FitAddon` to resize the terminal when the modal resizes. Send resize events to the WebSocket so the server-side PTY adjusts.
8. On unmount (modal close), close the WebSocket and dispose the terminal.

**Reconnection:** If the WebSocket closes unexpectedly, show "Connection lost" in the terminal and attempt to reconnect after 2 seconds, up to 3 times.

**Modal UI:**

- Header: session name, left/right navigation arrows (if multiple sessions), session counter ("2/5"), close button.
- Body: the xterm.js terminal filling the available space.
- The modal should be large (max-w-5xl, max-h-[90vh]) to give the terminal room.

**Navigation:** When `onNavigate` is called (arrow buttons), the component disconnects from the current session and connects to the new one.

**Resize protocol:** When the terminal resizes (FitAddon reports new cols/rows), send a JSON message over the WebSocket: `{ "type": "resize", "cols": N, "rows": N }`. The server-side PTY handler adjusts accordingly.

### 6. `app/turing/components/session-viewer.tsx` — Read-Only Viewer (non-Tom)

A simpler modal for non-Tom users that shows tmux output without interactivity.

**Interface:**

```typescript
interface SessionViewerProps {
  sessionName: string;
  allSessions: string[];
  onClose: () => void;
  onNavigate: (sessionName: string) => void;
}
```

**Behavior:**

1. Fetch session output via `useTuring("/sessions/{sessionName}/output")`.
2. Display in a `<pre>` block with monospace font, green text on black background.
3. Auto-refresh toggle with configurable interval (default 2 seconds).
4. Auto-scroll to bottom on new content.

**Modal UI:** Same layout as TerminalModal (header with navigation, body with output) but no input capability.

### 7. `app/lib/hooks/use-persisted-settings.ts` — Settings Persistence

A generic hook for persisting user preferences.

**Interface:**

```typescript
function usePersistedSettings<T extends Record<string, unknown>>(
  key: string,
  defaults: T
): [T, (update: Partial<T>) => void]
```

Returns the current settings and an updater function.

**Behavior:**

1. On mount:
   - If user is logged in: fetch from Supabase `user_settings` table (key = `key`).
   - If not logged in: read from `localStorage`.
   - Merge with `defaults` (so new fields get default values).
2. The updater function:
   - Merges the partial update into the current settings.
   - Debounces the save by 400ms.
   - If logged in: save to Supabase `user_settings`.
   - If not logged in: save to `localStorage`.

**Why it's generic:** This hook doesn't know or care what it's persisting. GPUGrid uses it for collapsed partitions. AllocateForm uses it for recent dirs and presets. Any future component can use it for its own settings.

## Backend Changes

### `tom-quest-api/ws.py` — WebSocket Terminal Endpoint (~80 lines)

A new module that provides an interactive terminal over WebSocket.

**Endpoint:** `WebSocket /ws/sessions/{session_name}`

**Behavior:**

1. Validate the session exists (check `tmux has-session -t {session_name}`). If not, close the WebSocket with an error message.
2. Create a pseudo-terminal (PTY) using Python's `pty` module: `pty.openpty()` returns a master and slave file descriptor.
3. Spawn a subprocess: `tmux attach-session -t {session_name}` with the slave as its stdin/stdout/stderr and `start_new_session=True`.
4. Start two async tasks:
   - **Read loop:** Read from the master fd, send bytes to the WebSocket as binary messages.
   - **Write loop:** Receive messages from the WebSocket. If binary/text, write to the master fd (keystrokes). If JSON with `type: "resize"`, call `fcntl/ioctl` to resize the PTY (`TIOCSWINSZ`).
5. When the WebSocket closes, kill the subprocess (but NOT the tmux session — we're detaching, not destroying).
6. When the subprocess exits, close the WebSocket.

**Authentication:** The WebSocket endpoint must verify the API key from the request headers or query parameters. Since WebSocket connections pass through Cloudflare tunnel, the API key should be sent as a query parameter: `wss://tunnel/ws/sessions/X?key=API_KEY`. The server validates this matches the stored API key before accepting the connection.

**Dependencies:**

- Python standard library: `pty`, `os`, `fcntl`, `struct`, `asyncio`, `signal`
- FastAPI/Starlette WebSocket support (already available, no new pip dependency needed)

**Add to `tom-quest-api/requirements.txt`:** No new packages needed. FastAPI includes WebSocket support via Starlette.

### `tom-quest-api/main.py` — Register WebSocket Route

Add the WebSocket route from `ws.py` to the FastAPI app. The WebSocket endpoint should be registered with the API key dependency.

### `tom-quest-api/tmux.py` — No Changes

The existing tmux module provides `session_exists()` and `capture_output()` which are still used by the read-only viewer endpoint and the WebSocket validator.

## Types

### Shared types file: `app/turing/types.ts`

```typescript
interface GPUReport {
  nodes: NodeInfo[];
  summary: {
    available: GPUTypeInfo[];
    unavailable: GPUTypeInfo[];
    free: GPUTypeInfo[];
  };
}

interface NodeInfo {
  name: string;
  gpu_type: string;
  partition: string;
  total_gpus: number;
  allocated_gpus: number;
  state: "up" | "down" | "drain";
  memory_total_mb: number;
  memory_allocated_mb: number;
}

interface GPUTypeInfo {
  type: string;
  count: number;
  nodes: string[];
}

interface Job {
  job_id: string;
  gpu_type: string;
  status: string;
  time_remaining: string;
  time_remaining_seconds: number;
  screen_name: string;
  start_time: string;
  end_time: string;
}

interface AllocateRequest {
  gpu_type: string;
  time_mins: number;
  memory_mb: number;
  count: number;
  commands: string[];
  project_dir: string;
}

interface AllocateResponse {
  success: boolean;
  job_ids: string[];
  screen_names: string[];
  errors: string[];
}
```

## Auto-Refresh Controls

The current page has a global "Auto-refresh" toggle and interval input at the top. In the refactored version:

- The page shell owns a `refreshInterval` state (persisted via `usePersistedSettings("turing_page", { refreshInterval: 30 })`).
- This value is passed to both `useTuring` calls.
- A small control bar at the top of the page shows: Refresh All button, auto-refresh toggle, interval input.
- Individual sections also have their own Refresh buttons that call `gpus.refresh()` or `jobs.refresh()`.

## Rules

1. The page component (`page.tsx`) has NO `useState` calls except through hooks. All state lives in sub-components or hooks.
2. Each sub-component manages its own UI state internally. The page passes data in and receives callbacks out.
3. The interactive terminal is Tom-only. Non-Tom users see the read-only session viewer.
4. Cancel operations are Tom-only. Non-Tom users see job data but cannot cancel.
5. All user preferences are persisted via `usePersistedSettings`. No manual localStorage or Supabase calls in components.
6. The WebSocket terminal connects directly to the Cloudflare tunnel (not through the Next.js proxy). The tunnel URL is fetched from a Tom-only API endpoint.

## Testing

### Unit tests

- GPUGrid: renders correct number of node cards, respects collapsed partitions, gpuOnlyFilter works
- AllocateForm: validation rejects invalid inputs, recent dirs are updated on submit, command presets save/load/delete correctly
- JobTable: renders all jobs, cancel modal opens/closes, Tom-only actions are hidden for non-Tom
- TerminalModal: constructs correct WebSocket URL from tunnel URL, sends resize events
- SessionViewer: displays output, auto-refresh triggers re-fetch
- usePersistedSettings: loads from localStorage for guests, loads from Supabase for logged-in users, debounces saves

### Integration tests

- Allocate form submits to `/api/turing/allocate` with correct payload
- Cancel job sends DELETE to `/api/turing/jobs/{id}`
- Tunnel URL endpoint returns 403 for non-Tom users

### E2E tests (Playwright)

- Load Turing page, verify GPU grid renders with partition headers
- Open allocate form, fill fields, submit (mock backend)
- View job table, click cancel, confirm modal, verify job disappears
- Open terminal modal (as Tom), verify xterm.js renders
- Verify non-Tom user sees read-only viewer instead of terminal
- Verify non-Tom user cannot see allocate form or cancel buttons

## Dependencies to Install

**Frontend (npm):**

```
npm install @xterm/xterm @xterm/addon-fit @xterm/addon-web-links
```

**Backend (pip):** No new packages needed. FastAPI includes WebSocket support. Python's `pty` module is in the standard library.

## Migration Notes

- The current `app/turing/page.tsx` (1,650 lines) is replaced entirely. No incremental migration — it's a full rewrite.
- The current `app/lib/userSettings.ts` is replaced by `use-persisted-settings.ts`. The new hook has the same Supabase table underneath but a simpler interface.
- Delete `app/lib/userSettings.ts` after this module is complete.
