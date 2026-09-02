// Regression test for check 6 of check-session-mirrors.mjs (the repo-list
// fence) and specifically for what it must NOT read: agent worktrees.
//
// A git worktree is a second checkout of this repository, and agents make
// theirs under .claude/worktrees/<name>/. Every file of the repo therefore
// exists a second time under that path, including convex/ttsShared.ts — the one
// home of the repo list. The fence's allowlist matches by exact path, so the
// copy is not allowlisted and the fence reported the one home as a second home,
// turning `pnpm check:guardrails` red for the whole session that made a
// worktree. SKIP_DIR now contains ".claude" and this test is what keeps it
// there, together with the second case: the exclusion must not have been
// widened into blindness at any other path.
//
// The script has no exported functions (it is a top-level script that exits
// non-zero on failure), so both cases run it as a subprocess from the repo root.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ONE_HOME = "convex/ttsShared.ts";

/** Directories this test creates inside the repo, removed after every case. */
const FAKE_WORKTREE = join(repoRoot, ".claude/worktrees/vitest-fence-probe");
const PLANTED_DIR = join(repoRoot, "vitest-fence-probe");

const runCheck = () =>
  spawnSync("node", ["scripts/check-session-mirrors.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

/** Copy the real one home to `dest`, so the probe carries a genuine repo list
 *  rather than a hand-written imitation that could drift from the real one. */
const copyOneHomeTo = (dir) => {
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(repoRoot, ONE_HOME), join(dir, "ttsShared.ts"));
};

afterEach(() => {
  rmSync(FAKE_WORKTREE, { recursive: true, force: true });
  rmSync(PLANTED_DIR, { recursive: true, force: true });
});

describe("the repo-list fence and agent worktrees", () => {
  it("passes with a full repo copy under .claude/worktrees/", () => {
    copyOneHomeTo(join(FAKE_WORKTREE, "convex"));
    const run = runCheck();
    expect(run.stdout + run.stderr).not.toContain(".claude");
    expect(run.status).toBe(0);
  });

  it("still fails on a second home outside .claude", () => {
    copyOneHomeTo(PLANTED_DIR);
    const run = runCheck();
    expect(run.stderr).toContain("vitest-fence-probe/ttsShared.ts");
    expect(run.status).toBe(1);
  });
});
