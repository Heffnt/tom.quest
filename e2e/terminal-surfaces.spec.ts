// Drives both Turing terminal surfaces against a real tmux session and checks
// that connecting, resizing and one forced reconnect behave the same on each.
//
// Both surfaces render app/turing/components/interactive-terminal.tsx, which
// calls startTerminalSession in app/turing/lib/terminal-session.ts. This spec
// is the behavioural counterpart to app/turing/lib/terminal-session.test.ts:
// that one reads the two surface files and fails if either regrows its own
// terminal; this one opens a browser, attaches to a live tmux session over a
// real WebSocket, and compares what the two surfaces actually do.
//
// What it needs, and why it skips by default:
//   1. E2E_TERMINAL_LIVE=1.
//   2. A running copy of turing-api/ reachable at TURING_API_URL, started with
//      the same TURING_API_KEY the Next.js server has. The WebSocket token is
//      an HMAC over that key (app/lib/turing.ts signWsToken,
//      turing-api/ws.py verify_ws_token), so the two must match.
//   3. tmux on the same machine as that copy of turing-api, because the spec
//      creates the sessions it attaches to and forces the disconnect by
//      detaching the tmux client. That copy of turing-api must be started with
//      TERM set to a real terminal type (xterm-256color): it forks
//      "tmux attach-session" into a pseudo-terminal and inherits its own
//      environment, and with TERM unset tmux refuses to attach with
//      "open terminal failed: terminal does not support clear".
//   4. TERMINAL_HARNESS=1 on the Next.js server, which turns on
//      /turing/terminal-harness — the route that mounts the terminal modal
//      without a Convex-authenticated admin.
//
// The one thing this spec fakes is the admin gate. /api/turing/ws-credentials
// calls requireAdmin, which needs a Convex login this process does not have,
// so the spec intercepts that one request and answers it with signWsToken —
// the same function the route itself calls. Everything past that point is
// real: a real WebSocket, a real pseudo-terminal, a real tmux session.

import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { signWsToken } from "../app/lib/turing";

const LIVE = process.env.E2E_TERMINAL_LIVE === "1";

// Escape hatch for machines whose Linux release is newer than the pinned
// Playwright knows how to download a browser for: point E2E_CHROMIUM_PATH at
// any Chromium build and it is used instead. Unset, the pinned browser is used
// and nothing changes.
const CHROMIUM_PATH = process.env.E2E_CHROMIUM_PATH;
if (CHROMIUM_PATH) {
  test.use({ launchOptions: { executablePath: CHROMIUM_PATH }, ignoreHTTPSErrors: true });
}

test.describe.configure({ mode: "serial" });

type SurfaceName = "modal" | "page";

/** How each surface is reached and how it is put into interactive mode. */
const SURFACES: { surface: SurfaceName; session: string; open: (page: Page, session: string) => Promise<void> }[] = [
  {
    surface: "modal",
    session: "e2e-terminal-modal",
    async open(page, session) {
      await page.goto(`/turing/terminal-harness?session=${encodeURIComponent(session)}`);
      await page.getByRole("button", { name: "Open Terminal" }).click();
    },
  },
  {
    surface: "page",
    session: "e2e-terminal-page",
    async open(page, session) {
      await page.goto(`/turing/terminal/${encodeURIComponent(session)}?mode=interactive`);
    },
  },
];

function tmux(...args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tmuxQuiet(...args: string[]): string {
  try {
    return tmux(...args);
  } catch {
    return "";
  }
}

function createSession(session: string) {
  tmuxQuiet("kill-session", "-t", session);
  tmux("new-session", "-d", "-s", session);
  tmux("set-option", "-t", session, "window-size", "latest");
}

function attachedClients(session: string): number {
  const out = tmuxQuiet("list-clients", "-t", session, "-F", "#{client_tty}");
  return out ? out.split("\n").filter((line) => line.trim()).length : 0;
}

function windowSize(session: string): { cols: number; rows: number } {
  const out = tmuxQuiet("display-message", "-p", "-t", session, "#{window_width}x#{window_height}");
  const [cols, rows] = out.split("x").map((n) => Number(n));
  return { cols: cols || 0, rows: rows || 0 };
}

/** Poll a synchronous probe until it satisfies `done` or the budget runs out. */
async function until<T>(probe: () => T, done: (value: T) => boolean, budgetMs = 20_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let value = probe();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = probe();
  }
  return value;
}

/** Everything the terminal has painted, as one string. */
async function screenText(page: Page): Promise<string> {
  return (await page.locator(".xterm-rows").first().innerText()).replace(/ /g, " ");
}

/**
 * Type a command into the terminal and wait for its output. The command is
 * written so the line the user types and the line the shell prints differ:
 * printf 'ROUNDTRIP-%s\n' <name> is typed, ROUNDTRIP-<name> is printed. Seeing
 * the printed form proves the bytes went browser → WebSocket → pseudo-terminal
 * → tmux and back, not merely that the keystrokes echoed locally.
 */
async function roundTrip(page: Page, name: string): Promise<boolean> {
  await page.locator(".xterm-screen").first().click();
  await page.keyboard.type(`printf 'ROUNDTRIP-%s\\n' ${name}`);
  await page.keyboard.press("Enter");
  try {
    await expect
      .poll(() => screenText(page), { timeout: 15_000 })
      .toContain(`ROUNDTRIP-${name}`);
    return true;
  } catch {
    return false;
  }
}

/** What one surface did. The two records are compared field by field. */
type Observation = {
  attachedOnConnect: number;
  firstRoundTrip: boolean;
  sizeSmall: { cols: number; rows: number };
  sizeLarge: { cols: number; rows: number };
  reconnectBanner: string | null;
  attachedAfterReconnect: number;
  roundTripAfterReconnect: boolean;
};

async function observe(page: Page, spec: (typeof SURFACES)[number]): Promise<Observation> {
  const { session, surface } = spec;
  createSession(session);

  // The admin gate is the only thing standing in for something real. See the
  // file header.
  await page.route("**/api/turing/ws-credentials*", async (route) => {
    const url = new URL(route.request().url());
    const creds = signWsToken({
      userId: "e2e-terminal-surfaces",
      sessionName: url.searchParams.get("session") ?? "",
      ttlMs: 5 * 60 * 1000,
    });
    await route.fulfill({ json: creds });
  });

  await page.setViewportSize({ width: 900, height: 600 });
  await spec.open(page, session);

  // Connect.
  const attachedOnConnect = await until(() => attachedClients(session), (n) => n === 1);
  const firstRoundTrip = await roundTrip(page, `${surface}-connect`);
  const sizeSmall = windowSize(session);

  // Resize. The terminal is sized to its container by the fit addon and the
  // new size is sent over the WebSocket, which resizes the tmux window, so the
  // dimensions tmux reports are the check.
  await page.setViewportSize({ width: 1400, height: 950 });
  const sizeLarge = await until(
    () => windowSize(session),
    (size) => size.cols > sizeSmall.cols && size.rows > sizeSmall.rows,
  );

  // Forced reconnect. Detaching the tmux client ends the pseudo-terminal the
  // service forked for this connection, without destroying the session, so the
  // surface must notice the drop, say so, and reattach to the same session.
  //
  // The service only discovers the dead pseudo-terminal when it next writes to
  // it (turing-api/ws.py, _read_ws blocks on the socket), so after detaching we
  // press Enter until the write fails and the socket closes. That is a property
  // of the service, not of the browser code, and it is the same for both
  // surfaces.
  //
  // The banner is caught by polling rather than by reading the final screen:
  // the reconnect follows 2 seconds later (RECONNECT_DELAY_MS) and the fresh
  // tmux attach clears the screen, so the message is on screen only briefly.
  tmuxQuiet("detach-client", "-s", session);
  let reconnectBanner: string | null = null;
  const bannerDeadline = Date.now() + 30_000;
  let nudges = 0;
  while (Date.now() < bannerDeadline && !reconnectBanner) {
    reconnectBanner =
      (await screenText(page)).match(/Connection lost — reconnecting \(\d+\/\d+\)…/)?.[0] ?? null;
    if (reconnectBanner) break;
    if (nudges < 20 && attachedClients(session) === 0) {
      await page.keyboard.press("Enter");
      nudges += 1;
    }
    await sleep(200);
  }
  const attachedAfterReconnect = await until(() => attachedClients(session), (n) => n === 1, 30_000);
  const roundTripAfterReconnect = await roundTrip(page, `${surface}-reconnect`);

  return {
    attachedOnConnect,
    firstRoundTrip,
    sizeSmall,
    sizeLarge,
    reconnectBanner,
    attachedAfterReconnect,
    roundTripAfterReconnect,
  };
}

test.describe("both terminal surfaces against a live tmux session", () => {
  test.skip(!LIVE, "Set E2E_TERMINAL_LIVE=1 with turing-api and tmux running locally. See the file header.");
  test.slow();

  const observations = new Map<SurfaceName, Observation>();

  for (const spec of SURFACES) {
    test(`${spec.surface}: connects, resizes and survives one forced reconnect`, async ({ page }) => {
      const observed = await observe(page, spec);
      observations.set(spec.surface, observed);
      console.log(`[${spec.surface}]`, JSON.stringify(observed));

      expect(observed.attachedOnConnect, "one tmux client attached").toBe(1);
      expect(observed.firstRoundTrip, "typed command round-tripped through the pseudo-terminal").toBe(true);
      expect(observed.sizeLarge.cols, "tmux window widened with the viewport").toBeGreaterThan(observed.sizeSmall.cols);
      expect(observed.sizeLarge.rows, "tmux window heightened with the viewport").toBeGreaterThan(observed.sizeSmall.rows);
      expect(observed.reconnectBanner, "the drop was announced in the terminal").toBe(
        "Connection lost — reconnecting (1/3)…",
      );
      expect(observed.attachedAfterReconnect, "reattached to the same session").toBe(1);
      expect(observed.roundTripAfterReconnect, "usable again after the reconnect").toBe(true);
    });
  }

  test("the two surfaces behave the same", async () => {
    const modal = observations.get("modal");
    const page = observations.get("page");
    expect(modal, "modal observation recorded").toBeDefined();
    expect(page, "page observation recorded").toBeDefined();
    if (!modal || !page) return;

    // Sizes are not compared as numbers: the modal draws the terminal inside a
    // dialog with a header and padding, the full page draws it edge to edge, so
    // the two hold different numbers of columns by design. What must match is
    // the behaviour — both attach, both round-trip, both grow with the
    // viewport, both announce the same drop and both come back.
    const shape = (o: Observation) => ({
      attachedOnConnect: o.attachedOnConnect,
      firstRoundTrip: o.firstRoundTrip,
      grewOnResize: o.sizeLarge.cols > o.sizeSmall.cols && o.sizeLarge.rows > o.sizeSmall.rows,
      reconnectBanner: o.reconnectBanner,
      attachedAfterReconnect: o.attachedAfterReconnect,
      roundTripAfterReconnect: o.roundTripAfterReconnect,
    });
    expect(shape(modal)).toEqual(shape(page));
  });

  test.afterAll(() => {
    for (const spec of SURFACES) tmuxQuiet("kill-session", "-t", spec.session);
  });
});
