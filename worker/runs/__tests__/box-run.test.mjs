// box-run.mjs against a fake CLI. Nothing here reaches the network, the real
// `claude` binary, or the box: the mirror is a bare repository the test builds,
// /proc/meminfo is a file the test writes, and the CLI is a script that echoes
// what the test told it to echo.

import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RUNNER = path.resolve("worker/runs/box-run.mjs");
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

const temp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `box-run-${tag}-`));

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...IDENTITY, ...args], { encoding: "utf8" });
}

/**
 * A fake `claude`. It records its argv, its cwd and the moment it ran, writes
 * the answer the test chose to stdout and a line to stderr, and exits with the
 * code the test chose. FAKE_* names carry the choices so one script serves
 * every case.
 */
function fakeCli(tag) {
  const dir = temp(`fake-${tag}`);
  const script = path.join(dir, "fake-cli.mjs");
  fs.writeFileSync(script, [
    'import fs from "node:fs";',
    'const started = Date.now();',
    'if (process.env.FAKE_RECORD) fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), started }));',
    'let stdin = "";',
    'try { stdin = fs.readFileSync(0, "utf8"); } catch {}',
    'if (process.env.FAKE_PROMPT_AT) fs.writeFileSync(process.env.FAKE_PROMPT_AT, stdin);',
    'const sleepMs = Number(process.env.FAKE_SLEEP_MS ?? 0);',
    'if (sleepMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);',
    'if (process.env.FAKE_RECORD) fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), started, ended: Date.now() }));',
    'process.stderr.write("fake-cli: chatter that must not reach stdout\\n");',
    'process.stdout.write(process.env.FAKE_ANSWER ?? "fake answer\\n");',
    'process.exit(Number(process.env.FAKE_EXIT ?? 0));',
  ].join("\n"));
  if (process.platform === "win32") {
    const command = path.join(dir, "claude.cmd");
    fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0fake-cli.mjs" %*\r\n`);
    return command;
  }
  fs.writeFileSync(script, `#!/usr/bin/env node\n${fs.readFileSync(script, "utf8")}`);
  fs.chmodSync(script, 0o755);
  return script;
}

/** A bare mirror where ensureMirror expects one, built locally so the run never
 * clones from GitHub. `remote update --prune` on a remote-less bare repository
 * is a no-op, which is exactly the "mirror already present" path. */
function localMirror(stateDir, repo) {
  const mirror = path.join(stateDir, "repos", `${repo}.git`);
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", mirror]);
  const work = temp("seed");
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  fs.writeFileSync(path.join(work, "README.md"), "seed\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "seed");
  git(work, "remote", "add", "origin", mirror);
  git(work, "push", "-q", "origin", "main");
  const sha = git(work, "rev-parse", "HEAD").trim();
  return { mirror, sha };
}

function baseEnv(stateDir, extra = {}) {
  return {
    ...process.env,
    RUN_SWEEP_STATE_DIR: stateDir,
    // An env file the resolver cannot read, so no machine's /etc/tts/worker.env
    // or ~/.tts/env can reach into a test.
    RUN_ENV_FILE: path.join(stateDir, "no-such-env"),
    TTS_RUN_REG_SPOOL: path.join(stateDir, "registration"),
    RUN_SEMAPHORE_RETRY_MS: "50",
    ...extra,
  };
}

function run(args, { stateDir, env = {}, input = "do the work\n" } = {}) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: "utf8",
    input,
    env: baseEnv(stateDir, env),
  });
}

function statusLine(stdout) {
  const lines = String(stdout).trimEnd().split("\n");
  return lines[lines.length - 1];
}

function meminfo(dir, availableKb) {
  const file = path.join(dir, "meminfo");
  fs.writeFileSync(file, `MemTotal:        8039152 kB\nMemFree:          123456 kB\nMemAvailable:    ${availableKb} kB\n`);
  return file;
}

describe("box-run stdout contract", () => {
  it("prints the answer and one status line, and nothing else", () => {
    const stateDir = temp("state");
    const record = path.join(stateDir, "record.json");
    const result = run(["--repo", "none"], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("stdout"), FAKE_RECORD: record, FAKE_ANSWER: "the report\n" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^the report\nbox-run: run [0-9a-f]{8} host box runner claude exit 0 after \d+s\n$/);
    // The child's own chatter went to the log, not to the block the laptop relays.
    expect(result.stdout).not.toContain("chatter");
    expect(result.stderr).toContain("box-run: exit 0");
  });

  it("redacts a credential shape out of the answer before it leaves the box", () => {
    const stateDir = temp("state");
    const secret = `ghp_${"a".repeat(24)}`;
    const result = run(["--repo", "none"], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("redact"), FAKE_ANSWER: `token is ${secret} ok\n` },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[redacted:github]");
    expect(result.stdout).not.toContain(secret);
  });

  it("hands the prompt to the CLI on stdin and the tool lists on its command line", () => {
    const stateDir = temp("state");
    const record = path.join(stateDir, "record.json");
    const promptAt = path.join(stateDir, "prompt.txt");
    const result = run(["--repo", "none", "--model", "opus"], {
      stateDir,
      input: "the exact request\n",
      env: { CLAUDE_BIN: fakeCli("argv"), FAKE_RECORD: record, FAKE_PROMPT_AT: promptAt },
    });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(promptAt, "utf8")).toBe("the exact request\n");
    const { argv, cwd } = JSON.parse(fs.readFileSync(record, "utf8"));
    expect(argv).toContain("-p");
    expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    // The installed CLI has no turn cap: maxTurns is an SDK option, not a flag.
    expect(argv).not.toContain("--max-turns");
    expect(argv[argv.indexOf("--disallowedTools") + 1]).toBe("AskUserQuestion");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toContain("Task");
    // --repo none is an empty scratch workspace named ws.
    expect(path.basename(cwd)).toBe("ws");
  });

  it("writes a registration envelope naming the parent, the root and the depth", () => {
    const stateDir = temp("state");
    const parent = "claude:laptop:11111111-2222-4333-8444-555555555555";
    const result = run(["--repo", "none", "--parent", parent], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("register") },
    });
    expect(result.status).toBe(0);
    const spoolDir = path.join(stateDir, "registration");
    const names = fs.readdirSync(spoolDir).filter((name) => name.endsWith(".json"));
    expect(names).toHaveLength(1);
    const { writer, registration } = JSON.parse(fs.readFileSync(path.join(spoolDir, names[0]), "utf8"));
    expect(writer.file).toBe("worker/runs/box-run.mjs");
    expect(registration).toMatchObject({
      host: "box",
      runner: "claude",
      origin: "session",
      kind: "subagent",
      parentRunId: parent,
      rootRunId: parent,
      depth: 1,
      // convex/runs.ts refuses linkKnown with a parent and no tool-use id.
      linkKnown: false,
      layersKnown: false,
    });
    expect(registration.tools.denied).toEqual(["AskUserQuestion"]);
  });
});

describe("box-run worktrees", () => {
  it("makes a worktree off the mirror at the ref it was given, and reaps it", () => {
    const stateDir = temp("state");
    const record = path.join(stateDir, "record.json");
    const { sha } = localMirror(stateDir, "tom.quest");
    const result = run(["--repo", "tom.quest", "--ref", sha], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("worktree"), FAKE_RECORD: record },
    });
    expect(result.status).toBe(0);
    const { cwd } = JSON.parse(fs.readFileSync(record, "utf8"));
    expect(path.basename(cwd)).toBe("tom.quest");
    expect(fs.existsSync(path.join(cwd, "README.md"))).toBe(false); // already reaped
    expect(fs.readdirSync(path.join(stateDir, "work"))).toEqual([]);
  });

  it("reaps the work directory after a failing run too", () => {
    const stateDir = temp("state");
    const { sha } = localMirror(stateDir, "tom.quest");
    const result = run(["--repo", "tom.quest", "--ref", sha], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("fail"), FAKE_EXIT: "3" },
    });
    expect(result.status).toBe(3);
    expect(statusLine(result.stdout)).toMatch(/runner claude exit 3 after \d+s$/);
    expect(fs.readdirSync(path.join(stateDir, "work"))).toEqual([]);
  });

  it("keeps the work directory with --keep-worktree", () => {
    const stateDir = temp("state");
    const result = run(["--repo", "none", "--keep-worktree"], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("keep") },
    });
    expect(result.status).toBe(0);
    expect(fs.readdirSync(path.join(stateDir, "work"))).toHaveLength(1);
  });

  it("refuses a ref that does not resolve and names it, instead of falling back", () => {
    const stateDir = temp("state");
    localMirror(stateDir, "tom.quest");
    const result = run(["--repo", "tom.quest", "--ref", "no-such-branch"], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("badref") },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no-such-branch");
    expect(result.stdout).toBe("");
    expect(fs.readdirSync(path.join(stateDir, "work"))).toEqual([]);
  });

  it("refuses an unknown repo before doing any work", () => {
    const stateDir = temp("state");
    const result = run(["--repo", "Byobu"], { stateDir, env: { CLAUDE_BIN: fakeCli("badrepo") } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown repo");
    expect(fs.existsSync(path.join(stateDir, "work"))).toBe(false);
  });
});

describe("box-run memory guard", () => {
  it("refuses a --tests run below 2 GB, starts nothing, and exits 75", () => {
    const stateDir = temp("state");
    const record = path.join(stateDir, "record.json");
    const result = run(["--repo", "none", "--tests"], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("mem-low"), FAKE_RECORD: record, MEMINFO_PATH: meminfo(stateDir, 1024 * 1024) },
    });
    expect(result.status).toBe(75);
    expect(result.stderr.trim()).toBe(
      "box-run: refused — free memory is 1024 MB, a test run needs 2048 MB; nothing was started",
    );
    expect(result.stdout).toBe("");
    expect(fs.existsSync(record)).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "work"))).toBe(false);
  });

  it("runs a --tests run above 2 GB", () => {
    const stateDir = temp("state");
    const result = run(["--repo", "none", "--tests"], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("mem-high"), MEMINFO_PATH: meminfo(stateDir, 4 * 1024 * 1024) },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("refused");
  });

  it("does not read memory at all without --tests", () => {
    const stateDir = temp("state");
    const result = run(["--repo", "none"], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("mem-off"), MEMINFO_PATH: meminfo(stateDir, 1024) },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("refused");
  });
});

describe("box-run semaphore", () => {
  it("queues the second run behind the first at RUN_MAX_PARALLEL=1, announcing once", async () => {
    const stateDir = temp("state");
    const bin = fakeCli("queue");
    const records = [path.join(stateDir, "a.json"), path.join(stateDir, "b.json")];
    const start = (record) => new Promise((resolve) => {
      const child = spawn(process.execPath, [RUNNER, "--repo", "none"], {
        env: baseEnv(stateDir, { CLAUDE_BIN: bin, FAKE_RECORD: record, FAKE_SLEEP_MS: "1200", RUN_MAX_PARALLEL: "1" }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdout.resume();
      child.stdin.end("work\n");
      child.on("close", (code) => resolve({ code, stderr }));
    });
    const [first, second] = await Promise.all([start(records[0]), start(records[1])]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const queued = `${first.stderr}${second.stderr}`.split("\n").filter((line) => line.includes("queued behind"));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toBe("box-run: queued behind 1 (limit 1)");
    // Their working windows must not overlap: the later one started after the
    // earlier one finished, which is what a limit of one means.
    const runs = records.map((file) => JSON.parse(fs.readFileSync(file, "utf8"))).sort((a, b) => a.started - b.started);
    expect(runs[1].started).toBeGreaterThanOrEqual(runs[0].ended);
  }, 30_000);

  it("reclaims a holder whose process is gone", () => {
    const stateDir = temp("state");
    fs.mkdirSync(stateDir, { recursive: true });
    // A pid that cannot be running: the counter says the box is full, and the
    // next run must notice the holder is dead rather than wait forever.
    const dead = { id: "deadbeef", pid: 0x7fffffff, at: Date.now() };
    fs.writeFileSync(path.join(stateDir, "semaphore.json"), `${JSON.stringify({ count: 1, holders: [dead] })}\n`);
    const result = run(["--repo", "none"], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("reclaim"), RUN_MAX_PARALLEL: "1" },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("queued behind");
    const counter = JSON.parse(fs.readFileSync(path.join(stateDir, "semaphore.json"), "utf8"));
    expect(counter.holders).toEqual([]);
  });
});
