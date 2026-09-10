import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PRELUDE_LAYERS } from "./prelude.mjs";
import { PULL_TIMEOUT_MS, pullWikiTom } from "./session-start-hook.mjs";

const HOOK = path.resolve("scripts/session-start-hook.mjs");
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...IDENTITY, ...args], { encoding: "utf8" });
}

function write(dir, relative, body) {
  const target = path.join(dir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

/** A WikiTom with every page the know layer names — the hook now builds the
 * FETCHABLE index too, and the index is a list of what exists. */
function fixture({ know = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-start-wikitom-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  write(dir, "model-of-tom/agent-rules.md", "# Operate\n\n## Map\n\n- Read this.\n");
  write(dir, "model-of-tom/writing.md", "# Writing\n\nUse short sentences.\n");
  write(dir, "model-of-tom/ground.md", "# Ground\n\nKnown facts.\n");
  if (know) {
    write(dir, "model-of-tom/intent.md", "# Intent\n\n## Directions\n\n- Ship.\n");
    write(dir, "model-of-tom/priorities.md", "# Priorities\n\n## What becomes a todo\n\n- Dated things.\n");
    write(dir, "model-of-tom/schedule.md", "# Schedule\n\n## Week\n\n- Monday — practice.\n");
    for (const area of PRELUDE_LAYERS.know.areas.required) {
      write(dir, area, `---\nupdated: 2026-09-09\n---\n\n## Current state\n\n- Present.\n`);
    }
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  return dir;
}

function run(env) {
  return spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    input: '{"hook_event_name":"SessionStart"}\n',
    env: { ...process.env, ...env },
  });
}

describe("session-start-hook", () => {
  // The hook carries the MAP now (the dynamic-context round): the stable
  // prefix — agent-rules.md, writing.md, ground.md — and the fetchable index,
  // and no know layer at all.
  it("returns the stable prefix and the fetchable index at local HEAD, with no know layer", () => {
    const dir = fixture();
    const commit = git(dir, "rev-parse", "HEAD").trim();
    const result = run({ WIKITOM_DIR: dir });
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(Object.keys(json)).toEqual(["hookSpecificOutput"]);
    expect(Object.keys(json.hookSpecificOutput)).toEqual(["hookEventName", "additionalContext"]);
    expect(json.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const context = json.hookSpecificOutput.additionalContext;
    expect(context).toBe(
      `MODEL-OF-TOM FILES (WikiTom commit ${commit}): model-of-tom/agent-rules.md, model-of-tom/writing.md, model-of-tom/ground.md\n\n`
      + "── model-of-tom/agent-rules.md ──\n# Operate\n\n## Map\n\n- Read this.\n\n\n"
      + "── model-of-tom/writing.md ──\n# Writing\n\nUse short sentences.\n\n\n"
      + "── model-of-tom/ground.md ──\n# Ground\n\nKnown facts.\n\n\n"
      + context.slice(context.indexOf("MODEL-OF-TOM FETCHABLE")),
    );
    // Nothing of the know layer is here, and every page of it is one line away.
    expect(context).not.toContain("── model-of-tom/intent.md ──");
    expect(context).not.toContain("── model-of-tom/areas/admin.md ──");
    expect(context).toContain("- know layer, whole");
    expect(context).toContain("--layers know");
    expect(context).toContain("- model-of-tom/areas/admin.md");
  });

  it("keeps the prefix when only the index cannot be built", () => {
    // A checkout missing the know pages: the index cannot be listed, and the
    // prefix — which is what a laptop session cannot work without — still goes.
    const dir = fixture({ know: false });
    const result = run({ WIKITOM_DIR: dir });
    expect(result.status).toBe(0);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(context).toContain("── model-of-tom/agent-rules.md ──");
    expect(context).toContain("── model-of-tom/writing.md ──");
    expect(context).toContain("fetchable index could not be built:");
    expect(context).not.toContain("MODEL-OF-TOM FETCHABLE");
  });

  it("reports a one-line load failure and exits successfully", () => {
    const result = run({ WIKITOM_DIR: path.join(os.tmpdir(), "missing-session-start-wikitom") });
    expect(result.status).toBe(0);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(context).toMatch(/^model-of-tom context could not be loaded: .+$/);
    expect(context).not.toContain("\n");
  });

  // A session start waits for the pull, so the pull must be capped: without a
  // timeout one slow fetch made a laptop session wait two minutes.
  it("caps the WikiTom pull at fifteen seconds", () => {
    const dir = fixture();
    const calls = [];
    const fakeExecFileSync = (file, args, options) => { calls.push({ file, args, options }); };

    expect(pullWikiTom(dir, fakeExecFileSync)).toBe(true);
    expect(calls).toEqual([{
      file: "git",
      args: ["-C", dir, "pull", "--ff-only", "--quiet"],
      options: { stdio: "ignore", timeout: 15_000 },
    }]);
    expect(PULL_TIMEOUT_MS).toBe(15_000);
  });

  it("skips the pull when WikiTom is absent, and swallows a pull that fails", () => {
    const absent = path.join(os.tmpdir(), "missing-session-start-wikitom");
    const never = () => { throw new Error("must not run"); };
    expect(pullWikiTom(absent, never)).toBe(false);

    const dir = fixture();
    const killed = () => { throw Object.assign(new Error("timed out"), { signal: "SIGTERM" }); };
    expect(pullWikiTom(dir, killed)).toBe(false);
  });
});
