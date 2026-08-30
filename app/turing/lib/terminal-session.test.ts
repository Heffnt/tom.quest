// Guards the one-module rule for the interactive terminal. Before this module
// existed, the credential fetch, the reconnect limit, the font and the whole
// open/fit/resize/reconnect flow were written once in the terminal modal and
// again in the full-page terminal, so a change to either rule landed on one
// surface only. The source checks below fail if that duplication returns; the
// fetchWsCredentials cases pin the shared credential behaviour.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";

// xterm measures a canvas the moment it is imported, and jsdom has no canvas
// implementation, so it prints a "not implemented" error during module load.
// This stub is hoisted above the import below and keeps the test output clean;
// nothing here draws a terminal.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
});

import { fetchWsCredentials, MAX_RECONNECTS, VSCODE_TERMINAL_FONT } from "./terminal-session";

const ROOT = process.cwd();
const MODAL = path.join(ROOT, "app/turing/components/terminal-modal.tsx");
const PAGE = path.join(ROOT, "app/turing/terminal/[session]/terminal-client.tsx");
const SHARED_COMPONENT = path.join(ROOT, "app/turing/components/interactive-terminal.tsx");
const HEAVY_LIBS_CHECK = path.join(ROOT, "scripts/check-heavy-libs.mjs");

const surfaces = [
  { name: "terminal modal", file: MODAL },
  { name: "full-page terminal", file: PAGE },
];

describe("terminal surfaces render from one module", () => {
  for (const surface of surfaces) {
    describe(surface.name, () => {
      const source = fs.readFileSync(surface.file, "utf8");

      it("renders InteractiveTerminal instead of building its own terminal", () => {
        expect(source).toMatch(/interactive-terminal/);
        expect(source).toMatch(/<InteractiveTerminal/);
      });

      it("does not import xterm directly", () => {
        expect(source).not.toMatch(/@xterm\//);
      });

      it("does not redeclare the credential fetch, reconnect limit or font", () => {
        expect(source).not.toMatch(/function fetchWsCredentials/);
        expect(source).not.toMatch(/ws-credentials/);
        expect(source).not.toMatch(/const MAX_RECONNECTS/);
        expect(source).not.toMatch(/const VSCODE_TERMINAL_FONT/);
      });

      it("does not open a WebSocket or a ResizeObserver of its own", () => {
        expect(source).not.toMatch(/new WebSocket\(/);
        expect(source).not.toMatch(/new ResizeObserver\(/);
      });
    });
  }

  it("keeps the shared component as the only caller of startTerminalSession", () => {
    const sharedSource = fs.readFileSync(SHARED_COMPONENT, "utf8");
    expect(sharedSource).toMatch(/startTerminalSession/);
    for (const surface of surfaces) {
      expect(fs.readFileSync(surface.file, "utf8")).not.toMatch(/startTerminalSession/);
    }
  });

  it("allows xterm in exactly one file, this module", () => {
    const check = fs.readFileSync(HEAVY_LIBS_CHECK, "utf8");
    const block = check.match(/const XTERM_ALLOWED_FILES = new Set\(\[([\s\S]*?)\]\)/);
    expect(block).not.toBeNull();
    const allowed = [...(block?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(allowed).toEqual(["app/turing/lib/terminal-session.ts"]);
  });
});

describe("shared terminal constants", () => {
  it("keeps one reconnect limit and one font for both surfaces", () => {
    expect(MAX_RECONNECTS).toBe(3);
    expect(VSCODE_TERMINAL_FONT).toBe('Consolas, "Courier New", monospace');
  });
});

describe("fetchWsCredentials", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(implementation: (url: string, init?: RequestInit) => Promise<unknown>) {
    const spy = vi.fn(implementation);
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("sends the session name and bearer token, and returns the credentials", async () => {
    const spy = stubFetch(async () =>
      new Response(JSON.stringify({ wsUrl: "wss://turing.tom.quest", token: "short-lived" }), {
        status: 200,
      }),
    );
    const creds = await fetchWsCredentials("auth-token", "my session", "modal");
    expect(creds).toEqual({ wsUrl: "wss://turing.tom.quest", token: "short-lived" });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("/api/turing/ws-credentials?session=my%20session");
    expect((init as { headers: Record<string, string> }).headers).toEqual({
      Authorization: "Bearer auth-token",
    });
  });

  it("omits the authorization header when there is no token", async () => {
    const spy = stubFetch(async () =>
      new Response(JSON.stringify({ wsUrl: "wss://x", token: "t" }), { status: 200 }),
    );
    await fetchWsCredentials(null, "s", "page");
    const [, init] = spy.mock.calls[0];
    expect((init as { headers: Record<string, string> }).headers).toEqual({});
  });

  it("returns null on a failed response", async () => {
    stubFetch(async () => new Response("nope", { status: 403 }));
    expect(await fetchWsCredentials("auth-token", "s", "page")).toBeNull();
  });

  it("returns null when the response is missing wsUrl or token", async () => {
    stubFetch(async () => new Response(JSON.stringify({ wsUrl: "wss://x" }), { status: 200 }));
    expect(await fetchWsCredentials("auth-token", "s", "modal")).toBeNull();
  });

  it("returns null when the request throws", async () => {
    stubFetch(async () => {
      throw new Error("Network error");
    });
    expect(await fetchWsCredentials("auth-token", "s", "modal")).toBeNull();
  });
});
