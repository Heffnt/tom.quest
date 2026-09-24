// The settings worker/setup.sh writes into each account slot, pinned by
// running the script's own Node block against a scratch directory. The block
// is a heredoc inside setup.sh, so the test cuts it out and runs it exactly as
// the rollout does: `node -` with HOOK_CONFIG_DIR and INCLUDE_CONTEXT_HOOK set.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test/temp.mjs";

const setup = fs.readFileSync(path.resolve("worker/setup.sh"), "utf8");
const block = setup.match(/node - <<'NODE'\n([\s\S]*?)\nNODE\n/)?.[1];

function runBlock(directory, includeContextHook) {
  const result = spawnSync(process.execPath, ["-"], {
    input: block,
    encoding: "utf8",
    env: { ...process.env, HOOK_CONFIG_DIR: directory, INCLUDE_CONTEXT_HOOK: includeContextHook },
  });
  expect(result.status, result.stderr).toBe(0);
}

function slot(existing) {
  const directory = tempDir("slot-");
  if (existing) fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify(existing));
  return directory;
}

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

describe("the account slot settings setup.sh writes", () => {
  it("finds the settings block in setup.sh", () => {
    expect(block).toContain("settings.json");
  });

  // Tom, 2026-09-22: context is Jarvis's. What Anthropic's CLI ships that does
  // the same job is off in every Claude slot.
  it("turns off auto-memory, bundled skills, workflows, connectors, web and MCP tools", () => {
    const directory = slot();
    runBlock(directory, "1");
    const settings = read(path.join(directory, "settings.json"));
    expect(settings).toMatchObject({
      autoMemoryEnabled: false,
      autoDreamEnabled: false,
      disableBundledSkills: true,
      disableWorkflows: true,
      disableClaudeAiConnectors: true,
      permissions: { deny: ["WebSearch", "WebFetch", "mcp__*"] },
    });
  });

  // A slot's settings are also edited by hand and by the CLI itself; the
  // rollout adds its rules and keeps everything else, and a second run adds
  // nothing.
  it("keeps what the slot already had and adds each rule once", () => {
    const directory = slot({
      theme: "dark",
      autoMemoryEnabled: true,
      permissions: { allow: ["Bash(ls)"], deny: ["Bash(rm -rf /)", "WebFetch"] },
    });
    runBlock(directory, "1");
    runBlock(directory, "1");
    const settings = read(path.join(directory, "settings.json"));
    expect(settings.theme).toBe("dark");
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.permissions.allow).toEqual(["Bash(ls)"]);
    expect(settings.permissions.deny).toEqual(["Bash(rm -rf /)", "WebFetch", "WebSearch", "mcp__*"]);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  // Codex reads hooks.json, not settings.json; none of these keys are Codex's.
  it("writes none of them for Codex", () => {
    const directory = path.join(tempDir("setup-settings-codex-"), ".codex");
    fs.mkdirSync(directory);
    runBlock(directory, "0");
    const hooks = read(path.join(directory, "hooks.json"));
    expect(Object.keys(hooks)).toEqual(["hooks"]);
  });
});
