// Regression fence for the banned-tool posture (worker/session-host/
// banned-tools.mjs): AskUserQuestion must stay banned in tom.quest sessions,
// and both places that enforce it must stay wired.
//
// The behavior half imports the module directly. The wiring half reads
// session.mjs as TEXT, because that module imports @anthropic-ai/
// claude-agent-sdk, which is installed only on the worker box — importing it
// here would fail on the dependency rather than on the posture. Two narrow
// source assertions are the most this side can check without that install.
//
// This directory is deliberately NOT flat: setup.sh installs the daemon with
// `cp worker/session-host/*.mjs`, a non-recursive glob, so a test file one
// level down never ships to the box.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BANNED_TOOLS, bannedToolDenial } from "../banned-tools.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sessionSource = fs.readFileSync(
  path.join(here, "..", "session.mjs"),
  "utf8",
);

describe("banned tools", () => {
  it("bans AskUserQuestion", () => {
    expect(BANNED_TOOLS).toContain("AskUserQuestion");
  });

  it("denies AskUserQuestion in both session modes", () => {
    for (const mode of ["interactive", "autonomous"]) {
      const message = bannedToolDenial("AskUserQuestion", mode);
      expect(message).not.toBeNull();
      expect(message).toContain("AskUserQuestion");
    }
  });

  it("tells an interactive session to ask Tom in reply text", () => {
    const message = bannedToolDenial("AskUserQuestion", "interactive");
    expect(message).toMatch(/reply text/);
  });

  it("tells an autonomous session to decide and surface the alternatives", () => {
    const message = bannedToolDenial("AskUserQuestion", "autonomous");
    expect(message).toMatch(/best-judgment/);
    expect(message).toMatch(/alternatives/);
  });

  it("leaves every non-banned tool alone", () => {
    for (const tool of ["Bash", "Edit", "Write", "Read", "Task", "WebFetch"]) {
      expect(bannedToolDenial(tool, "interactive")).toBeNull();
      expect(bannedToolDenial(tool, "autonomous")).toBeNull();
    }
  });
});

describe("session.mjs wiring", () => {
  it("passes the ban to the SDK as disallowedTools", () => {
    expect(sessionSource).toMatch(/disallowedTools:\s*BANNED_TOOLS/);
  });

  it("re-checks the ban in the permission gate", () => {
    expect(sessionSource).toMatch(/bannedToolDenial\(toolName,\s*this\.mode\)/);
  });
});

// The 2026-09-04 ruling: per-command checks are autonomous-only, EXCEPT the
// two that protect something other than the session asking — the ban above
// and the Tier-0 daemon self-destruction guard. Read as text for the same
// reason as the wiring block: the gate lives in a module vitest cannot
// import. The order of the three landmarks inside #canUseTool is the
// assertion: ban, then Tier 0, then the mode gate, then everything else.
describe("session.mjs permission gate, by mode (ruling 2026-09-04)", () => {
  const gateStart = sessionSource.indexOf("async #canUseTool(");
  const gate = sessionSource.slice(gateStart, sessionSource.indexOf("async #classifyBash(", gateStart));

  it("has the gate", () => {
    expect(gateStart).toBeGreaterThan(-1);
    expect(gate.length).toBeGreaterThan(0);
  });

  it("keeps the Tier-0 self-destruction deny OUTSIDE the autonomous gate", () => {
    const tier0 = gate.indexOf("DAEMON_SELF_DESTRUCT_RE.test(");
    const modeGate = gate.indexOf('if (this.mode !== "autonomous")');
    expect(tier0).toBeGreaterThan(-1);
    expect(modeGate).toBeGreaterThan(-1);
    expect(tier0).toBeLessThan(modeGate);
    // …and the ban stays ahead of both.
    expect(gate.indexOf("bannedToolDenial(")).toBeLessThan(tier0);
  });

  it("gates the edit check and the Bash tiers behind mode === autonomous", () => {
    const modeGate = gate.indexOf('if (this.mode !== "autonomous")');
    expect(gate.indexOf("EDIT_TOOLS.has(toolName)")).toBeGreaterThan(modeGate);
    expect(gate.indexOf("SANCTIONED_PEN_RE.test(")).toBeGreaterThan(modeGate);
    expect(gate.indexOf("BASH_DANGER_RE.test(")).toBeGreaterThan(modeGate);
    expect(gate.indexOf("this.#classifyBash(")).toBeGreaterThan(modeGate);
    // The interactive branch returns allow right there.
    expect(gate.slice(modeGate, modeGate + 300)).toMatch(/return \{ behavior: "allow"/);
  });

  it("names the Tier-0 pattern once, with the daemon service in it", () => {
    expect(sessionSource).toMatch(/const DAEMON_SELF_DESTRUCT_RE =\s*\n?\s*\/.*tts-session-host/);
  });
});

// The session-shell env scrub: the secret-name list moved to env-scrub.mjs
// (one home for the session shell, the classifier and the daemon's Codex
// spawns) and is fenced there by __tests__/env-scrub.test.mjs. What stays
// here is the wiring: startQuery must hand the SDK child scrubbedEnv's
// output and nothing broader, so a `printenv` in any session cannot show a
// daemon secret even if the box's worker.env grows one.
describe("session.mjs env scrub", () => {
  const scrub = sessionSource.slice(
    sessionSource.indexOf("startQuery({ resume } = {})"),
    sessionSource.indexOf("...inheritedEnv"),
  );
  it("builds the session env from scrubbedEnv, keeping only the TTS key", () => {
    expect(scrub).toMatch(/const inheritedEnv = scrubbedEnv\(\{ keepTtsKey: true \}\);/);
    expect(scrub).not.toMatch(/= process\.env;/);
  });
  it("imports scrubbedEnv from lib.mjs (which re-exports env-scrub.mjs)", () => {
    expect(sessionSource).toMatch(/import \{[^}]*\bscrubbedEnv\b[^}]*\} from "\.\/lib\.mjs"/);
  });
});

// Routing by model family: the Claude branch passes the SDK a model id only
// when the name maps to one, the Codex branch hands the runner id + effort.
describe("session.mjs model routing", () => {
  it("mirrors SESSION_MODELS and defaults an absent model to opus", () => {
    expect(sessionSource).toMatch(/const SESSION_MODELS = \{/);
    expect(sessionSource).toMatch(/SESSION_MODELS\[name \?\? "opus"\]\.family/);
  });

  it("branches on family codex to the Codex runner with id + effort", () => {
    expect(sessionSource).toMatch(/if \(spec\.family === "codex"\)/);
    expect(sessionSource).toMatch(/codexQuery\(\{/);
    expect(sessionSource).toMatch(/model: spec\.id,\s*\n\s*effort: spec\.effort,/);
  });

  it("passes the SDK a model only when the name has an id", () => {
    expect(sessionSource).toMatch(/\.\.\.\(spec\.id \? \{ model: spec\.id \} : \{\}\)/);
  });

  it("fires the Claude account auto-switch for family claude only", () => {
    const fn = sessionSource.slice(sessionSource.indexOf("#maybeUsageSignal(text) {"));
    expect(fn.slice(0, 200)).toMatch(/if \(this\.family !== "claude"\) return;/);
  });
});
