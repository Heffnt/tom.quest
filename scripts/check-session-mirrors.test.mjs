import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

// check-writing-standard.test.mjs is the precedent for a vitest test living
// beside a guardrail script. That script exports pure functions its test
// imports; this one exports nothing and calls process.exit, so the test runs it
// as a subprocess from the repo root rather than reshape a straight-line script
// for testability.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, ".claude/worktrees/__mirror-fence-fixture__");

/** Run the guardrail and return its exit code plus everything it printed, so a
 *  red test shows the fence's own failure lines instead of a bare throw. */
function runCheck() {
  try {
    const stdout = execFileSync("node", ["scripts/check-session-mirrors.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, output: stdout };
  } catch (err) {
    return { code: err.status, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

afterEach(() => {
  rmSync(FIXTURE, { recursive: true, force: true });
});

// Agent worktrees under .claude/worktrees/ are gitignored full copies of this
// repo. The file copied here is the one home itself — convex/ttsShared.ts names
// all three session repos within a few characters — so if ".claude" ever leaves
// SKIP_DIR in check-session-mirrors.mjs, the walk reads this copy at a path
// REPO_LIST_ALLOWED (exact relative paths) cannot match and the one home is
// reported as a copy of itself.
it("does not read an agent worktree's repo copy as a second home", () => {
  mkdirSync(join(FIXTURE, "convex"), { recursive: true });
  cpSync(join(ROOT, "convex/ttsShared.ts"), join(FIXTURE, "convex/ttsShared.ts"));

  const { code, output } = runCheck();

  expect(output).toContain("Session mirror check passed.");
  expect(code).toBe(0);
});
