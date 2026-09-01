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
