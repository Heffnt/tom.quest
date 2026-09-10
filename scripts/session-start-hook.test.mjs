import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

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

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-start-wikitom-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  write(dir, "model-of-tom/agent-rules.md", "# Operate\n\nDo not include me.\n");
  write(dir, "model-of-tom/writing.md", "# Writing\n\nUse short sentences.\n");
  write(dir, "model-of-tom/ground.md", "# Ground\n\nKnown facts.\n");
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
  it("returns exactly the write layer at local HEAD in the SessionStart shape", () => {
    const dir = fixture();
    const commit = git(dir, "rev-parse", "HEAD").trim();
    const result = run({ WIKITOM_DIR: dir });
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(Object.keys(json)).toEqual(["hookSpecificOutput"]);
    expect(Object.keys(json.hookSpecificOutput)).toEqual(["hookEventName", "additionalContext"]);
    expect(json.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(json.hookSpecificOutput.additionalContext).toBe(
      `MODEL-OF-TOM FILES (WikiTom commit ${commit}): model-of-tom/writing.md, model-of-tom/ground.md\n\n`
      + "── model-of-tom/writing.md ──\n# Writing\n\nUse short sentences.\n\n\n"
      + "── model-of-tom/ground.md ──\n# Ground\n\nKnown facts.\n",
    );
    expect(json.hookSpecificOutput.additionalContext).not.toContain("Do not include me.");
  });

  it("reports a one-line load failure and exits successfully", () => {
    const result = run({ WIKITOM_DIR: path.join(os.tmpdir(), "missing-session-start-wikitom") });
    expect(result.status).toBe(0);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(context).toMatch(/^write layer could not be loaded: .+$/);
    expect(context).not.toContain("\n");
  });
});
