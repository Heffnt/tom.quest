// Every name the session daemon takes from box-run.mjs is one box-run.mjs
// exports.
//
// session-host.mjs loads the launcher with a dynamic import and destructures
// what it needs (`const { boxRun, TOOLS_ALLOWED, BANNED_TOOLS } = await
// boxRunner();`). A name the module does not export destructures to undefined
// with no error at load; the failure comes at the call, on the box. That is
// how TOOLS_ALLOWED went: its export was dropped on 2026-09-19 as unread, and
// every runner step's launch then threw on `[...undefined]`.
//
// session-host.mjs itself cannot be imported here (it pulls the Agent SDK,
// installed only on the box), so its destructurings are read as text, the way
// worker/session-host/__tests__/session-host.test.mjs reads it.
//
// witness: make TOOLS_ALLOWED in box-run.mjs a plain const again.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostSource = fs.readFileSync(path.join(here, "..", "..", "session-host", "session-host.mjs"), "utf8");
const launcher = await import("../box-run.mjs");

/** Every name destructured from `await boxRunner()` in the daemon. */
function namesTakenFromLauncher(source) {
  const names = [];
  for (const m of source.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+boxRunner\(\)/g)) {
    for (const part of m[1].split(",")) {
      const name = part.split(":")[0].trim();
      if (name !== "") names.push(name);
    }
  }
  return names;
}

describe("the session daemon's use of box-run.mjs", () => {
  it("destructures at least the runner step's three names", () => {
    expect(namesTakenFromLauncher(hostSource)).toEqual(expect.arrayContaining(["boxRun", "TOOLS_ALLOWED", "BANNED_TOOLS"]));
  });

  it("takes only names box-run.mjs exports", () => {
    for (const name of namesTakenFromLauncher(hostSource)) {
      expect(launcher[name], `box-run.mjs does not export ${name}`).toBeDefined();
    }
  });

  it("hands a runner step the box run's tool set, with the banned tools denied", () => {
    expect(launcher.TOOLS_ALLOWED).toEqual(expect.arrayContaining(["Read", "Write", "Edit", "Bash", "Task"]));
    expect(launcher.BANNED_TOOLS).toEqual(["AskUserQuestion"]);
    expect(launcher.TOOLS_ALLOWED).not.toContain("AskUserQuestion");
  });
});
