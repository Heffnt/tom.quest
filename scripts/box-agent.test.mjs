// box-agent.mjs against a fake ssh. Nothing here reaches the Jarvis Box: the
// TTS_SSH_BIN seam points at a script that records its argv and its stdin, and
// the current-run pointer is a file the test writes at the one path
// scripts/run-hook.mjs owns.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test/temp.mjs";

const AGENT = path.resolve("scripts/box-agent.mjs");
const HOOK = path.resolve("scripts/run-hook.mjs");
const RUN_ID = "claude:laptop:11111111-2222-4333-8444-555555555555";

// run-hook.mjs resolves its registration module off import.meta.url, which the
// vitest transform replaces with a non-file URL, so neither it nor box-agent.mjs
// can be imported into this suite. The pointer path has one home in that hook;
// ask a real Node for it rather than keeping a second copy of the rule here.
function currentRunPointerPath(stateDir, cwd) {
  const probe = "const m = await import(process.argv[1]); process.stdout.write(m.currentRunPointerPath(process.argv[2], process.argv[3]));";
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe, pathToFileURL(HOOK).href, stateDir, cwd], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

const temp = (tag) => tempDir(`box-agent-${tag}-`);

/** A fake ssh: it writes its argv and its stdin where the test can read them,
 * prints what the test chose, and exits with the code the test chose. */
function fakeSsh(tag) {
  const dir = temp(`ssh-${tag}`);
  const script = path.join(dir, "fake-ssh.mjs");
  fs.writeFileSync(script, [
    'import fs from "node:fs";',
    'let stdin = "";',
    'try { stdin = fs.readFileSync(0, "utf8"); } catch {}',
    'fs.writeFileSync(process.env.FAKE_SSH_ARGV, JSON.stringify({ argv: process.argv.slice(2), stdin }));',
    'process.stdout.write(process.env.FAKE_SSH_OUT ?? "");',
    'process.stderr.write(process.env.FAKE_SSH_ERR ?? "");',
    'process.exit(Number(process.env.FAKE_SSH_EXIT ?? 0));',
  ].join("\n"));
  if (process.platform === "win32") {
    const command = path.join(dir, "ssh.cmd");
    fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0fake-ssh.mjs" %*\r\n`);
    return command;
  }
  fs.writeFileSync(script, `#!/usr/bin/env node\n${fs.readFileSync(script, "utf8")}`);
  fs.chmodSync(script, 0o755);
  return script;
}

function writePointer(stateDir, cwd, { at = Date.now(), runId = RUN_ID, depth = 0 } = {}) {
  const file = currentRunPointerPath(stateDir, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ runId, rootRunId: runId, depth, sessionId: "s", runFile: "r", at })}\n`);
  return file;
}

function run({ stateDir, cwd, args = ["--repo", "tom.quest"], env = {}, input = "the request\n" }) {
  const argvFile = path.join(stateDir, `argv-${Math.random().toString(36).slice(2)}.json`);
  const result = spawnSync(process.execPath, [AGENT, ...args], {
    cwd,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      RUN_SWEEP_STATE_DIR: stateDir,
      // The env file is pinned at a path that does not exist, so no machine's
      // /etc/tts/worker.env or ~/.tts/env can decide a case here — this suite
      // has to run the same on a laptop, on CI and on the box itself.
      RUN_ENV_FILE: path.join(stateDir, "no-such-env"),
      RUN_HOST: "laptop",
      TTS_BOX_HOST: "box.test",
      TTS_SSH_BIN: fakeSsh("run"),
      FAKE_SSH_ARGV: argvFile,
      ...env,
    },
  });
  result.sent = fs.existsSync(argvFile) ? JSON.parse(fs.readFileSync(argvFile, "utf8")) : null;
  return result;
}

describe("box-agent parent resolution", () => {
  it("passes the laptop session's run id, root and depth + 1 when the pointer is fresh", () => {
    const stateDir = temp("state");
    const cwd = temp("cwd");
    writePointer(stateDir, cwd);
    const result = run({ stateDir, cwd });
    expect(result.status).toBe(0);
    const remote = result.sent.argv[result.sent.argv.length - 1];
    // Every remote token is quoted, the parent flags included: one rule for
    // the whole line rather than two, so no argument is ever the shell's.
    expect(remote).toContain(`'--parent' '${RUN_ID}'`);
    expect(remote).toContain(`'--root' '${RUN_ID}'`);
    expect(remote).toContain("'--depth' '1'");
    expect(result.stderr).not.toContain("recorded as a root");
  });

  it("passes no parent, and says so, when the pointer is older than 24 hours", () => {
    const stateDir = temp("state");
    const cwd = temp("cwd");
    writePointer(stateDir, cwd, { at: Date.now() - 25 * 60 * 60 * 1000 });
    const result = run({ stateDir, cwd });
    expect(result.status).toBe(0);
    expect(result.sent.argv[result.sent.argv.length - 1]).not.toContain("--parent");
    expect(result.stderr).toContain("box-agent: the current-run pointer is stale; this box run is recorded as a root");
  });

  it("passes no parent, and says so, when there is no pointer at all", () => {
    const stateDir = temp("state");
    const cwd = temp("cwd");
    const result = run({ stateDir, cwd });
    expect(result.status).toBe(0);
    expect(result.sent.argv[result.sent.argv.length - 1]).not.toContain("--parent");
    expect(result.stderr).toContain("box-agent: no current laptop run; this box run is recorded as a root");
  });

  it("counts depth from the pointer, so a child of a child lands one deeper", () => {
    const stateDir = temp("state");
    const cwd = temp("cwd");
    writePointer(stateDir, cwd, { depth: 2 });
    const result = run({ stateDir, cwd });
    expect(result.sent.argv[result.sent.argv.length - 1]).toContain("'--depth' '3'");
  });
});

describe("box-agent as a pipe", () => {
  it("relays stdout byte for byte and exits with ssh's code", () => {
    const stateDir = temp("state");
    const cwd = temp("cwd");
    const answer = "line one\nline two\nbox-run: run abcd1234 host box cli claude exit 0 after 12s\n";
    const result = run({ stateDir, cwd, env: { FAKE_SSH_OUT: answer, FAKE_SSH_EXIT: "7" } });
    expect(result.stdout).toBe(answer);
    expect(result.status).toBe(7);
  });

  it("hands the prompt through on stdin and the flags through unaltered", () => {
    const stateDir = temp("state");
    const cwd = temp("cwd");
    const result = run({
      stateDir,
      cwd,
      args: ["--cli", "codex", "--repo", "tom.quest", "--ref", "uae/box", "--sandbox", "read-only"],
      input: "review this\n",
    });
    expect(result.sent.stdin).toBe("review this\n");
    const remote = result.sent.argv[result.sent.argv.length - 1];
    expect(remote.startsWith("tts-run '--cli' 'codex' '--repo' 'tom.quest' '--ref' 'uae/box' '--sandbox' 'read-only'")).toBe(true);
  });

  it("builds the ssh line from the host, user and key seams", () => {
    const stateDir = temp("state");
    const cwd = temp("cwd");
    const result = run({
      stateDir,
      cwd,
      env: { TTS_BOX_HOST: "box.test", TTS_BOX_USER: "runner", TTS_BOX_KEY: "/keys/box" },
    });
    expect(result.sent.argv).toContain("BatchMode=yes");
    expect(result.sent.argv).toContain("ServerAliveInterval=30");
    expect(result.sent.argv).toContain("ServerAliveCountMax=6");
    expect(result.sent.argv[result.sent.argv.indexOf("-i") + 1]).toBe("/keys/box");
    expect(result.sent.argv).toContain("runner@box.test");
  });

  it("quotes every remote argument, so a shell metacharacter is data", () => {
    const stateDir = temp("state");
    const cwd = temp("cwd");
    const result = run({ stateDir, cwd, args: ["--ref", "a; rm -rf /"] });
    const remote = result.sent.argv[result.sent.argv.length - 1];
    expect(remote).toContain("'a; rm -rf /'");
  });
});

describe("box-agent on the box", () => {
  // witness: the box holds a tom.quest checkout at /root/tom.quest and another
  // in every worktree box-run.mjs makes, so ".claude/agents/codex.md says run
  // this when the file exists" fires there too. Sending the run over ssh from
  // the box is the box dialling itself with a key it does not hold.
  it("runs the command here instead of sending it, when RUN_HOST is box", () => {
    const stateDir = temp("state");
    const cwd = temp("cwd");
    writePointer(stateDir, cwd);
    const result = run({
      stateDir,
      cwd,
      env: { RUN_HOST: "box", TTS_BOX_CMD: fakeSsh("local"), TTS_SSH_BIN: path.join(temp("unused"), "never-run") },
    });
    expect(result.status).toBe(0);
    // Unquoted, because no shell stands between this process and box-run.mjs.
    expect(result.sent.argv).toEqual(["--repo", "tom.quest", "--parent", RUN_ID, "--root", RUN_ID, "--depth", "1"]);
    expect(result.sent.stdin).toBe("the request\n");
  });

  it("refuses with 255 and names the variable when no box address is set", () => {
    const stateDir = temp("state");
    const cwd = temp("cwd");
    const result = run({ stateDir, cwd, env: { TTS_BOX_HOST: "" } });
    expect(result.status).toBe(255);
    expect(result.stderr).toContain("TTS_BOX_HOST");
    expect(result.stderr).toContain("no run was started");
    // Nothing was spawned: a guessed address is worse than a refusal.
    expect(result.sent).toBeNull();
  });
});
