import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const RUNNER = path.resolve("scripts/codex-run.mjs");
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...IDENTITY, ...args], { encoding: "utf8" });
}

function write(dir, relative, body) {
  const target = path.join(dir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

function wikitomFixture({ rules = "# Rules\n\nKeep the promise.\n" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-run-wikitom-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  if (rules !== null) write(dir, "model-of-tom/agent-rules.md", rules);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  return dir;
}

function fakeCodex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-run-fake-"));
  const script = path.join(dir, "fake-codex.mjs");
  fs.writeFileSync(script, [
    'import fs from "node:fs";',
    'const output = process.argv[process.argv.indexOf("-o") + 1];',
    'fs.writeFileSync(process.env.FAKE_CODEX_ARGS, JSON.stringify(process.argv.slice(2)));',
    'fs.writeFileSync(output, "fake answer\\n");',
  ].join("\n"));
  if (process.platform === "win32") {
    const command = path.join(dir, "codex.cmd");
    fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`);
    return command;
  }
  fs.chmodSync(script, 0o755);
  fs.writeFileSync(script, `#!/usr/bin/env node\n${fs.readFileSync(script, "utf8")}`);
  return script;
}

function run(args, env) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: "utf8",
    input: "answer this\n",
    env: { ...process.env, ...env },
  });
}

describe("codex-run operate instructions", () => {
  it("injects the exact committed operate file as a TOML string", () => {
    const rules = '# Rules\n\nSay "hello".\n';
    const argsFile = path.join(os.tmpdir(), `codex-run-args-${Date.now()}.json`);
    const result = run([], {
      CODEX_BIN: fakeCodex(),
      WIKITOM_DIR: wikitomFixture({ rules }),
      FAKE_CODEX_ARGS: argsFile,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("fake answer\n");
    const codexArgs = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    expect(codexArgs).toContain(`developer_instructions=${JSON.stringify(rules)}`);
  });

  it("skips the read entirely with --no-operate", () => {
    const argsFile = path.join(os.tmpdir(), `codex-run-args-${Date.now()}-skip.json`);
    const result = run(["--no-operate"], {
      CODEX_BIN: fakeCodex(),
      WIKITOM_DIR: path.join(os.tmpdir(), "no-wikitom-here"),
      FAKE_CODEX_ARGS: argsFile,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("operate instructions unavailable");
    expect(JSON.parse(fs.readFileSync(argsFile, "utf8")).some((arg) => arg.startsWith("developer_instructions="))).toBe(false);
  });

  it("continues after one unavailable-instructions warning", () => {
    const argsFile = path.join(os.tmpdir(), `codex-run-args-${Date.now()}-missing.json`);
    const result = run([], {
      CODEX_BIN: fakeCodex(),
      WIKITOM_DIR: path.join(os.tmpdir(), "no-wikitom-here"),
      FAKE_CODEX_ARGS: argsFile,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("codex-run: operate instructions unavailable; continuing without them\n");
    expect(result.stderr.match(/operate instructions unavailable/g)).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(argsFile, "utf8")).some((arg) => arg.startsWith("developer_instructions="))).toBe(false);
  });
});
