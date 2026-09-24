// box-run.mjs against a fake CLI. Nothing here reaches the network, the real
// `claude` binary, or the box: the mirror is a bare repository the test builds,
// /proc/meminfo is a file the test writes, and the CLI is a script that echoes
// what the test told it to echo.

import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../../test/temp.mjs";
import { parseRegistrationBlock } from "../registration.mjs";

const RUNNER = path.resolve("worker/runs/box-run.mjs");
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

const temp = (tag) => tempDir(`box-run-${tag}-`);

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
    'import { spawn } from "node:child_process";',
    'const started = Date.now();',
    // A command the fake leaves running in its own session when it exits, the
    // way a model's backgrounded shell outlives the CLI's turn.
    'if (process.env.FAKE_BACKGROUND) spawn("sh", ["-c", process.env.FAKE_BACKGROUND], { detached: true, stdio: "ignore" }).unref();',
    // The two registration variables are recorded beside argv because they are
    // the whole of what box-run.mjs hands a child about the record it belongs
    // to, and the child is the only place they can be observed.
    'const seen = () => ({ argv: process.argv.slice(2), cwd: process.cwd(), regToken: process.env.TTS_RUN_REG_TOKEN ?? null, parent: process.env.TTS_RUN_PARENT_RUN_ID ?? null, environment: process.env.TTS_RUN_ENVIRONMENT ?? null, slotHeld: process.env.TTS_RUN_SLOT_HELD ?? null, runnerKey: process.env.TURING_RUNNER_KEY ?? null, openrouterKey: process.env.OPENROUTER_API_KEY ?? null });',
    'if (process.env.FAKE_RECORD) fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ ...seen(), started }));',
    'let stdin = "";',
    'try { stdin = fs.readFileSync(0, "utf8"); } catch {}',
    'if (process.env.FAKE_PROMPT_AT) fs.writeFileSync(process.env.FAKE_PROMPT_AT, stdin);',
    'const sleepMs = Number(process.env.FAKE_SLEEP_MS ?? 0);',
    'if (sleepMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);',
    'if (process.env.FAKE_RECORD) fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ ...seen(), started, ended: Date.now() }));',
    // Every invocation's argv, appended, for a case that runs the CLI twice.
    'if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");',
    // An account out of one model's usage: that model is refused the way the
    // CLI refuses it, with the reason as the envelope's result and exit 1.
    'if (process.env.FAKE_REFUSE_MODEL && String(process.argv[process.argv.indexOf("--model") + 1]).includes(process.env.FAKE_REFUSE_MODEL)) { process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: process.env.FAKE_REFUSAL ?? "You\'ve hit your monthly spend limit" })); process.exit(1); }',
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
 * clones from GitHub. `remote update` on a remote-less bare repository
 * is a no-op, which is exactly the "mirror already present" path. */
function localMirror(stateDir, repo) {
  const mirror = path.join(stateDir, "repos", `${repo}.git`);
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", mirror]);
  // What `git clone --mirror` leaves behind, set by hand because this fixture
  // is built locally rather than cloned: with it on, every push from a run's
  // worktree is a force-push of every ref plus a delete of every branch this
  // repository has not fetched.
  execFileSync("git", ["-C", mirror, "config", "remote.origin.mirror", "true"]);
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
    // Cleared rather than inherited: a suite run from inside a box run would
    // otherwise see the parent's slot and every semaphore case would pass for
    // the wrong reason.
    TTS_RUN_SLOT_HELD: "",
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
    expect(result.stdout).toMatch(/^the report\nbox-run: run [0-9a-f]{8} host box cli claude exit 0 after \d+s\n$/);
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
    // The registration block first, then the request exactly as it was sent.
    const sent = fs.readFileSync(promptAt, "utf8");
    const block = parseRegistrationBlock(sent);
    expect(block).not.toBeNull();
    expect(sent.endsWith("\n```\n\nthe exact request\n")).toBe(true);
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

  // witness: this used to pass gpt-5.6-terra, which is the name reserved for a
  // Codex CHILD. A box run is a run of its own, and now that every Codex run
  // goes through the box, a different default here would silently mean the
  // fleet default is not what scripts/codex-run.mjs and .claude/agents/codex.md
  // both say it is.
  it("gives a Codex run the fleet default model, the same one codex-run.mjs names", () => {
    const stateDir = temp("state");
    const record = path.join(stateDir, "record.json");
    const result = run(["--repo", "none", "--cli", "codex"], {
      stateDir,
      env: { TTS_CODEX_BIN: fakeCli("codex-model"), FAKE_RECORD: record },
    });
    expect(result.status).toBe(0);
    const { argv } = JSON.parse(fs.readFileSync(record, "utf8"));
    expect(argv[argv.indexOf("--model") + 1]).toBe("gpt-5.6-sol");
    const codexRun = fs.readFileSync(path.resolve("scripts/codex-run.mjs"), "utf8");
    expect(codexRun).toContain('const DEFAULT_MODEL = "gpt-5.6-sol"');
  });

  // An openrouter/<vendor>/<model> name reaches tts-codex whole: codex-run.mjs
  // is the one reader of the prefix. The key never rides along from here; the
  // scrub drops it and codex-run.mjs reads it from the env file itself.
  it("hands an OpenRouter model to Codex whole, without the key", () => {
    const stateDir = temp("state");
    const record = path.join(stateDir, "record.json");
    const result = run(["--repo", "none", "--cli", "codex", "--model", "openrouter/deepseek/deepseek-v4-flash"], {
      stateDir,
      env: { TTS_CODEX_BIN: fakeCli("codex-openrouter"), FAKE_RECORD: record, OPENROUTER_API_KEY: "sk-or-test" },
    });
    expect(result.status).toBe(0);
    const { argv, openrouterKey } = JSON.parse(fs.readFileSync(record, "utf8"));
    expect(argv[argv.indexOf("--model") + 1]).toBe("openrouter/deepseek/deepseek-v4-flash");
    expect(openrouterKey).toBeNull();
  });

  it("refuses an OpenRouter model on the Claude CLI and starts nothing", () => {
    const stateDir = temp("state");
    const record = path.join(stateDir, "record.json");
    const result = run(["--repo", "none", "--model", "openrouter/deepseek/deepseek-v4-flash"], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("claude-openrouter"), FAKE_RECORD: record },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("runs through Codex; pass --cli codex");
    expect(fs.existsSync(record)).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "work"))).toBe(false);
  });

  it("refuses --runner, the flag's old spelling", () => {
    const result = run(["--repo", "none", "--runner", "codex"], { stateDir: temp("state") });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown option --runner");
  });

  // witness: box-run.mjs used to write its own envelope for a Codex run and
  // delete TTS_RUN_PARENT_RUN_ID. codex-run.mjs mints its own token and never
  // reads box-run's, so that envelope was never claimed and the Codex run
  // landed as an unparented `job` — the tree edge lost, quietly.
  it("hands a Codex run its parent instead of writing a second envelope for it", () => {
    const stateDir = temp("state");
    const record = path.join(stateDir, "record.json");
    const parent = "claude:laptop:11111111-2222-4333-8444-555555555555";
    const result = run(["--repo", "none", "--cli", "codex", "--parent", parent], {
      stateDir,
      env: { TTS_CODEX_BIN: fakeCli("codex-parent"), FAKE_RECORD: record },
    });
    expect(result.status).toBe(0);
    const seen = JSON.parse(fs.readFileSync(record, "utf8"));
    expect(seen.parent).toBe(parent);
    expect(seen.environment).toBeNull();
    // No token, because there is no envelope here for one to claim.
    expect(seen.regToken).toBeNull();
    const spoolDir = path.join(stateDir, "registration");
    const spooled = fs.existsSync(spoolDir) ? fs.readdirSync(spoolDir).filter((n) => n.endsWith(".json")) : [];
    expect(spooled).toEqual([]);
  });

  it("writes a registration envelope naming the parent, the root and the depth", () => {
    const stateDir = temp("state");
    const parent = "claude:laptop:11111111-2222-4333-8444-555555555555";
    const promptAt = path.join(stateDir, "prompt.txt");
    const result = run(["--repo", "none", "--parent", parent], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("register"), FAKE_PROMPT_AT: promptAt },
    });
    expect(result.status).toBe(0);
    const spoolDir = path.join(stateDir, "registration");
    const names = fs.readdirSync(spoolDir).filter((name) => name.endsWith(".json"));
    expect(names).toHaveLength(1);
    const spool = JSON.parse(fs.readFileSync(path.join(spoolDir, names[0]), "utf8"));
    const sent = fs.readFileSync(promptAt, "utf8");
    // THE SPOOL HOLDS THE TOKEN AND THE PROMPT HOLDS THE REST: no registration
    // group beside the token, and no token in the text the model reads.
    expect(spool).not.toHaveProperty("registration");
    expect(sent).not.toContain(spool.token);
    const { writer, registration } = parseRegistrationBlock(sent);
    expect(writer).toEqual(spool.writer);
    expect(writer.file).toBe("worker/runs/box-run.mjs");
    expect(registration).toMatchObject({
      host: "box",
      cli: "claude",
      origin: "session",
      kind: "subagent",
      parentRunId: parent,
      rootRunId: parent,
      depth: 1,
      // convex/runs.ts refuses linkKnown with a parent and no tool-use id.
      linkKnown: false,
      layersKnown: false,
    });
    // With a parent the envelope names no environment: the record gives the
    // run its parent's.
    expect(registration).not.toHaveProperty("environment");
    expect(registration.tools.denied).toEqual(["AskUserQuestion"]);
  });

  it("calls a run with no parent a worker, and takes a launcher's named environment over both", () => {
    const envelopeOf = (args, env) => {
      const stateDir = temp("state");
      const promptAt = path.join(stateDir, "prompt.txt");
      const result = run(["--repo", "none", ...args], { stateDir, env: { CLAUDE_BIN: fakeCli("environment"), FAKE_PROMPT_AT: promptAt, ...env } });
      expect(result.status).toBe(0);
      return parseRegistrationBlock(fs.readFileSync(promptAt, "utf8")).registration;
    };
    const parent = "claude:laptop:11111111-2222-4333-8444-555555555555";
    expect(envelopeOf([], {}).environment).toBe("worker");
    expect(envelopeOf([], { TTS_RUN_ENVIRONMENT: "runner" }).environment).toBe("runner");
    expect(envelopeOf(["--parent", parent], { TTS_RUN_ENVIRONMENT: "session" }).environment).toBe("session");
    expect(envelopeOf([], { TTS_RUN_ENVIRONMENT: "autonomous" }).environment).toBe("worker");
  });

  it("tells a Codex child a named environment and clears one that is not", () => {
    const seenWith = (env) => {
      const stateDir = temp("state");
      const record = path.join(stateDir, "record.json");
      const result = run(["--repo", "none", "--cli", "codex"], { stateDir, env: { TTS_CODEX_BIN: fakeCli("codex-environment"), FAKE_RECORD: record, ...env } });
      expect(result.status).toBe(0);
      return JSON.parse(fs.readFileSync(record, "utf8"));
    };
    expect(seenWith({ TTS_RUN_ENVIRONMENT: "runner" }).environment).toBe("runner");
    expect(seenWith({ TTS_RUN_ENVIRONMENT: "nonsense" }).environment).toBeNull();
  });
});

// EVERY TEST HERE THAT CALLS localMirror CARRIES AN EXPLICIT 30s TIMEOUT, and
// the default 5s is the reason. localMirror is eight real git processes — init
// bare, init, add, commit, remote add, push, rev-parse — and the run under test
// then clones and adds a worktree off that mirror, so one case is a dozen
// process spawns before an assertion runs. Five seconds is a budget for a test
// that touches files, not one that starts a dozen processes on a loaded runner:
// these three passed alone and timed out inside the full suite. The merge gate
// writes a commit's tests row ONCE, so a timeout here bars that head for good —
// the same call worker/runs, convex/runs.test.ts made for its 250-row fixture.
const GIT_FIXTURE_MS = 30_000;

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
  }, GIT_FIXTURE_MS);

  // witness: leave remote.origin.mirror set and a run's ordinary `git push`
  // force-updates every ref on GitHub to this mirror's copy and deletes every
  // branch the mirror has not fetched — main moving backwards is a deploy.
  it("takes the mirror flag off the repository a run's worktree pushes from", () => {
    const stateDir = temp("state");
    const { mirror, sha } = localMirror(stateDir, "tom.quest");
    expect(git(mirror, "config", "--get", "remote.origin.mirror").trim()).toBe("true");
    const result = run(["--repo", "tom.quest", "--ref", sha], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("mirror-flag") },
    });
    expect(result.status).toBe(0);
    // `config --get` on a key that is gone exits 1 and prints nothing, which is
    // the whole assertion; spawnSync rather than execFileSync because that
    // exit code is the expected one and must not throw.
    const after = spawnSync("git", ["-C", mirror, "config", "--get", "remote.origin.mirror"], { encoding: "utf8" });
    expect(after.stdout.trim()).toBe("");
    expect(after.status).toBe(1);
  }, GIT_FIXTURE_MS);

  // witness: run 96feb5c4 (2026-09-18) lost its first commits because another
  // run's mirror refresh ran `remote update --prune`, which deleted the branch
  // the first run had made in its worktree and not yet pushed.
  it("keeps a branch a live worktree has checked out when the refresh prunes", () => {
    const stateDir = temp("state");
    const upstream = temp("upstream");
    execFileSync("git", ["init", "-q", "-b", "main", upstream]);
    git(upstream, "commit", "-q", "--allow-empty", "-m", "seed");
    git(upstream, "branch", "deleted-upstream");
    const mirror = path.join(stateDir, "repos", "tom.quest.git");
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    execFileSync("git", ["clone", "-q", "--mirror", upstream, mirror]);
    git(upstream, "branch", "-D", "deleted-upstream");
    // A live run's worktree on a branch GitHub has never seen, and a local
    // branch nobody has checked out.
    const live = path.join(temp("live"), "wt");
    git(mirror, "worktree", "add", "-q", "-b", "run/unpushed", live, "main");
    git(mirror, "branch", "left-behind", "main");
    const result = run(["--repo", "tom.quest", "--ref", "main"], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("prune") },
    });
    expect(result.status).toBe(0);
    const heads = git(mirror, "for-each-ref", "--format=%(refname)", "refs/heads").trim().split("\n");
    expect(heads).toContain("refs/heads/run/unpushed");
    expect(heads).not.toContain("refs/heads/left-behind");
    expect(heads).not.toContain("refs/heads/deleted-upstream");
    expect(result.stderr).toContain("kept refs/heads/run/unpushed");
  }, GIT_FIXTURE_MS);

  it("reaps the work directory after a failing run too", () => {
    const stateDir = temp("state");
    const { sha } = localMirror(stateDir, "tom.quest");
    const result = run(["--repo", "tom.quest", "--ref", sha], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("fail"), FAKE_EXIT: "3" },
    });
    expect(result.status).toBe(3);
    expect(statusLine(result.stdout)).toMatch(/cli claude exit 3 after \d+s$/);
    expect(fs.readdirSync(path.join(stateDir, "work"))).toEqual([]);
  }, GIT_FIXTURE_MS);

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
  }, GIT_FIXTURE_MS);

  it("refuses an unknown repo before doing any work", () => {
    const stateDir = temp("state");
    const result = run(["--repo", "Byobu"], { stateDir, env: { CLAUDE_BIN: fakeCli("badrepo") } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown repo");
    expect(fs.existsSync(path.join(stateDir, "work"))).toBe(false);
  });

  // THE THREE ARGUMENT REFUSALS, each pinned because the alternative to each is
  // silence. A `--ref` under `--repo none` would run in an empty directory and
  // report a commit it never saw; a bad `--timeout` is read nowhere but the
  // kill timer, whose `> 0` test is false for NaN, so the caller would ask for
  // a hard limit and get none; a bad `--depth` serialises to null in the
  // registration and is refused by the record after the run has been paid for.
  it("refuses a --ref with no repo to resolve it in", () => {
    const stateDir = temp("state");
    const result = run(["--ref", "main"], { stateDir, env: { CLAUDE_BIN: fakeCli("refnorepo") } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--ref needs a --repo");
    expect(fs.existsSync(path.join(stateDir, "work"))).toBe(false);
  });

  it("refuses a --timeout that is not a number of milliseconds", () => {
    const stateDir = temp("state");
    const result = run(["--timeout", "soon"], { stateDir, env: { CLAUDE_BIN: fakeCli("badtimeout") } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--timeout must be a number of milliseconds");
    expect(fs.existsSync(path.join(stateDir, "work"))).toBe(false);
  });

  it("refuses a --depth that is not a whole number", () => {
    const stateDir = temp("state");
    const result = run(["--parent", "run_parent", "--depth", "deep"], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("baddepth") },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--depth must be a whole number");
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

  // witness: a run's CLI child has Task and a tom.quest worktree whose agent
  // files send `box` and `codex` through box-agent.mjs, which on the box starts
  // box-run.mjs again. Asking for a second slot while the parent still holds
  // one deadlocks the pair — the parent is alive, so nothing reclaims it, and
  // the relay is told `queued behind` is not an error.
  it("takes no second slot for a run started inside a run, even with the box full", () => {
    const stateDir = temp("state");
    fs.mkdirSync(stateDir, { recursive: true });
    // A live holder: this process. The counter says the box is full and the
    // holder is not reclaimable, so a top-level run here would wait for ever.
    const holder = { id: "parentrn", pid: process.pid, at: Date.now() };
    fs.writeFileSync(path.join(stateDir, "semaphore.json"), `${JSON.stringify({ count: 1, holders: [holder] })}\n`);
    const result = run(["--repo", "none"], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("nested"), RUN_MAX_PARALLEL: "1", TTS_RUN_SLOT_HELD: "1" },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("queued behind");
    expect(result.stderr).toContain("running under the parent run's slot");
    // The parent's holder is untouched: this run neither took a slot nor
    // released one that was not its own.
    const counter = JSON.parse(fs.readFileSync(path.join(stateDir, "semaphore.json"), "utf8"));
    expect(counter.holders).toEqual([holder]);
  });

  it("passes the held slot down to the run it starts, so the whole subtree shares one", () => {
    const stateDir = temp("state");
    const record = path.join(stateDir, "record.json");
    const result = run(["--repo", "none"], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("slot-down"), FAKE_RECORD: record },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(record, "utf8")).slotHeld).toBe("1");
  });

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

// THE SAME BODY, CALLED IN PROCESS. worker/jobs/tts-lib.mjs's runClaude calls
// boxRunSync instead of spawning this file, so every case below runs in the
// test's own process against the same fake CLI — which is also the proof that
// importing the file launches nothing and that a refusal is a throw, not an
// exit that would take the test runner down with it.
const entry = await import("../box-run.mjs");

function inProcess(tag, extra = {}) {
  const stateDir = temp("state");
  const record = path.join(stateDir, "record.json");
  const env = baseEnv(stateDir, { CLAUDE_BIN: fakeCli(tag), FAKE_RECORD: record, CLAUDE_CONFIG_DIR: path.join(stateDir, "account"), ...extra });
  return { stateDir, record, env, seen: () => JSON.parse(fs.readFileSync(record, "utf8")) };
}

describe("claudeArgs", () => {
  const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

  it("names every deniable tool when the allow-list is empty", () => {
    const args = entry.claudeArgs({ model: "sonnet", allowedTools: [] });
    expect(args).toContain("--disallowedTools");
    // The whole list, in its own order — not a subset that merely holds the
    // few names some older assertion happened to check.
    expect(valueAfter(args, "--disallowedTools").split(",")).toEqual([...entry.DENIABLE_TOOLS]);
    // The four kinds a tool-free job could still reach before this list was
    // whole: an agent spawner, a scheduler, a network reader, and the schema
    // fetcher whose whole purpose is re-opening the tools the CLI deferred.
    for (const tool of ["Task", "ScheduleWakeup", "WebFetch", "ToolSearch"]) {
      expect(valueAfter(args, "--disallowedTools").split(",")).toContain(tool);
    }
    // Both flags or neither: the allow-list alone leaves the default
    // permission mode handing over its read tools.
    expect(valueAfter(args, "--allowedTools")).toBe("");
  });

  it("denies nothing when the caller named tools", () => {
    const args = entry.claudeArgs({ model: "sonnet", allowedTools: ["Read", "Glob", "Grep"] });
    expect(args).not.toContain("--disallowedTools");
    expect(valueAfter(args, "--allowedTools")).toBe("Read,Glob,Grep");
  });

  it("carries a turn budget only when it was given one", () => {
    expect(valueAfter(entry.claudeArgs({ maxTurns: 8 }), "--max-turns")).toBe("8");
    expect(entry.claudeArgs({})).not.toContain("--max-turns");
  });

  it("starts the run under a session id only when a caller names one", () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(valueAfter(entry.claudeArgs({ sessionId: id }), "--session-id")).toBe(id);
    expect(entry.claudeArgs({})).not.toContain("--session-id");
  });

  // The one check on the list is normalize()'s, which every entry passes.
  it("refuses a tool list that is not non-empty strings", () => {
    const { env } = inProcess("bad-tools");
    expect(() => entry.boxRunSync({ prompt: "p", env, allowedTools: "Read", registration: null })).toThrow(/allowedTools/);
    expect(() => entry.boxRunSync({ prompt: "p", env, allowedTools: ["Read", ""], registration: null })).toThrow(/allowedTools/);
  });
});

describe("box-run in process", () => {
  it("builds the command line from its options and adds nothing the caller did not name", () => {
    const { env, seen } = inProcess("inproc-argv");
    const result = entry.boxRunSync({
      prompt: "p", env, model: "sonnet", outputFormat: "json", maxTurns: 3,
      permissionMode: "bypassPermissions", allowedTools: ["Read", "Glob", "Grep"], registration: null,
    });
    expect(result.exitCode).toBe(0);
    const { argv } = seen();
    expect(argv).toEqual([
      "-p", "--output-format", "json", "--max-turns", "3", "--model", "sonnet",
      "--permission-mode", "bypassPermissions", "--allowedTools", "Read,Glob,Grep",
    ]);
  });

  it("denies every tool by name for an empty allow-list", () => {
    const { env, seen } = inProcess("inproc-none");
    entry.boxRunSync({ prompt: "p", env, allowedTools: [], registration: null });
    const { argv } = seen();
    expect(argv[argv.indexOf("--disallowedTools") + 1].split(",")).toEqual([...entry.DENIABLE_TOOLS]);
  });

  it("runs in the directory the caller owns and leaves it in place", () => {
    const own = temp("own-cwd");
    const { env, seen } = inProcess("inproc-cwd");
    entry.boxRunSync({ prompt: "p", env, cwd: own, registration: null });
    expect(fs.realpathSync(seen().cwd)).toBe(fs.realpathSync(own));
    expect(fs.existsSync(own)).toBe(true);
  });

  it("throws a refusal with its exit code instead of exiting", () => {
    const { env, stateDir } = inProcess("inproc-refuse", { MEMINFO_PATH: "" });
    env.MEMINFO_PATH = meminfo(stateDir, 300 * 1024);
    let thrown = null;
    try { entry.boxRunSync({ prompt: "p", env, tests: true }); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(entry.BoxRunError);
    expect(thrown.exitCode).toBe(75);
    expect(thrown.message).toMatch(/free memory is 300 MB/);
    expect(() => entry.boxRunSync({ prompt: "p", env, repo: "none", ref: "main" })).toThrow(/--ref needs a --repo/);
    expect(() => entry.boxRunSync({ prompt: "p", env, cli: "codex", maxTurns: 2 })).toThrow(/claude only/);
  });

  it("unwraps the JSON envelope, hands back its token, and claims the run where the child ran", () => {
    const sessionId = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const { env, stateDir } = inProcess("inproc-json", {
      FAKE_ANSWER: JSON.stringify({ type: "result", subtype: "success", result: "the answer", session_id: sessionId }),
      FAKE_PROMPT_AT: path.join(temp("inproc-json-prompt"), "prompt.txt"),
    });
    const own = temp("claim-cwd");
    const result = entry.boxRunSync({
      prompt: "p", env, cwd: own, outputFormat: "json",
      registration: { host: null, cli: "claude", origin: "cron:poll-gmail", kind: "job", environment: "worker" },
    });
    expect(result.text).toBe("the answer");
    expect(result.envelope.subtype).toBe("success");
    expect(typeof result.runToken).toBe("string");
    const project = path.resolve(own).replaceAll("\\", "-").replaceAll("/", "-").replaceAll(":", "-");
    const sidecar = path.join(stateDir, "account", "projects", project, `${sessionId}.registration.json`);
    const claimed = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    expect(claimed.token).toBe(result.runToken);
    // The launcher the record takes from writer.file is this file, while the
    // origin stays the job's own.
    expect(claimed.writer.file).toBe("worker/runs/box-run.mjs");
    // The claim moved the token, the writer and the block's hash; the
    // registration group is in the prompt the child read, and nowhere else.
    expect(claimed).not.toHaveProperty("registration");
    const { registration } = parseRegistrationBlock(fs.readFileSync(env.FAKE_PROMPT_AT, "utf8"));
    expect(registration.origin).toBe("cron:poll-gmail");
    expect(registration.cwd).toBe(own);
  });

  it("hands the runner key to a runner step's process and to no other run", () => {
    const step = { host: "box", cli: "claude", origin: "runner:k97abc", kind: "runner-step", environment: "runner" };
    const cases = [
      [step, "runner-key"],
      [{ ...step, kind: "job", environment: "worker" }, null],
      // A subagent the step spawns registers under its own envelope; exporting
      // the environment name does not earn it the key.
      [{ ...step, kind: "subagent" }, null],
      [null, null],
    ];
    for (const [registration, expected] of cases) {
      const { env, seen } = inProcess(`inproc-runner-key-${registration?.kind ?? "none"}`, { TURING_RUNNER_KEY: "runner-key", TTS_RUN_ENVIRONMENT: "runner" });
      entry.boxRunSync({ prompt: "p", env, cwd: temp("runner-key-cwd"), registration });
      expect(seen().runnerKey, `registration ${registration?.kind ?? "none"}`).toBe(expected);
    }
  });

  it("gives up on a full box after the caller's wait, starts nothing, and says the box is busy", async () => {
    const { env, stateDir, record } = inProcess("inproc-busy", { RUN_MAX_PARALLEL: "1" });
    const holder = { id: "holder01", pid: process.pid, at: Date.now() };
    fs.writeFileSync(path.join(stateDir, "semaphore.json"), `${JSON.stringify({ count: 1, holders: [holder] })}\n`);
    let thrown = null;
    try { await entry.boxRun({ prompt: "p", env, slotWaitMs: 120, registration: null }); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(entry.BoxRunError);
    expect(thrown.reason).toBe("busy");
    expect(thrown.exitCode).toBe(75);
    expect(fs.existsSync(record)).toBe(false);
  });

  it("waits for the child without blocking in the command line's entry", async () => {
    const { env } = inProcess("inproc-async", { FAKE_ANSWER: "async answer\n" });
    const result = await entry.boxRun({ prompt: "p", env, registration: null });
    expect(result.text).toBe("async answer\n");
    expect(result.exitCode).toBe(0);
  });
});

// witness: runs 0ea27b8e, 17aa7df2 and 02839c97 (2026-09-19) backgrounded a
// wait, ended their turn, and were reaped with the work still running.
describe.skipIf(process.platform !== "linux")("box-run waits for what the CLI left running", () => {
  it("waits for a process the CLI started to finish before it reaps", () => {
    const stateDir = temp("state");
    const late = path.join(temp("late"), "done.txt");
    const started = Date.now();
    const result = run(["--repo", "none"], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("survivor"), FAKE_BACKGROUND: `sleep 2; echo done > ${late}` },
    });
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    expect(fs.readFileSync(late, "utf8")).toBe("done\n");
    expect(result.stderr).toMatch(/waited \d+s after the CLI exited/);
    expect(result.stdout).not.toContain("still running");
    expect(fs.readdirSync(path.join(stateDir, "work"))).toEqual([]);
  });

  it("kills what outlives the run's time limit and names it in the report", () => {
    const stateDir = temp("state");
    const late = path.join(temp("late"), "never.txt");
    const result = run(["--repo", "none", "--timeout", "1500"], {
      stateDir,
      env: { CLAUDE_BIN: fakeCli("outlives"), FAKE_BACKGROUND: `sleep 30; echo late > ${late}` },
    });
    // A timeout, like any other: the work was cut off.
    expect(result.status).toBe(124);
    expect(result.stdout).toMatch(/\d process\(es\) this run started were still running when its time limit ran out, and were killed: .*sh -c sleep 30/);
    expect(statusLine(result.stdout)).toMatch(/exit 124 after \d+s$/);
    const ps = spawnSync("pgrep", ["-f", `echo late > ${late}`], { encoding: "utf8" });
    expect(ps.stdout.trim()).toBe("");
  });
});

// witness: on 2026-09-22 the box's disk filled, a run died writing a progress
// line, and the 1.1 GB worktree it left behind was still there a day later —
// so the disk that caused the death never came back. A launcher that cannot
// reap when the disk is full is a launcher that cannot recover from a full
// disk. /dev/full answers every write with ENOSPC, which is that failure
// exactly, and SIGHUP is how an ssh-dropped `tts-run` dies.
describe.skipIf(process.platform !== "linux")("box-run reaps on every exit path", () => {
  it("reaps the worktree when every write to its own stderr fails with ENOSPC", () => {
    const stateDir = temp("state");
    const { mirror, sha } = localMirror(stateDir, "tom.quest");
    const full = fs.openSync("/dev/full", "w");
    try {
      const result = spawnSync(process.execPath, [RUNNER, "--repo", "tom.quest", "--ref", sha], {
        encoding: "utf8",
        input: "do the work\n",
        env: baseEnv(stateDir, { CLAUDE_BIN: fakeCli("enospc") }),
        stdio: ["pipe", "pipe", full],
      });
      // The answer still came back and the run still ended on its own code —
      // a full disk costs the progress lines, not the run.
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("fake answer");
    } finally {
      fs.closeSync(full);
    }
    expect(fs.readdirSync(path.join(stateDir, "work"))).toEqual([]);
    expect(git(mirror, "worktree", "list")).not.toContain(path.join(stateDir, "work"));
  }, GIT_FIXTURE_MS);

  it("reaps the worktree when the run is hung up on", async () => {
    const stateDir = temp("state");
    const { mirror, sha } = localMirror(stateDir, "tom.quest");
    const child = spawn(process.execPath, [RUNNER, "--repo", "tom.quest", "--ref", sha], {
      encoding: "utf8",
      env: baseEnv(stateDir, { CLAUDE_BIN: fakeCli("hangup"), FAKE_SLEEP_MS: "30000" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end("do the work\n");
    // The worktree has to exist before the signal, or the test proves nothing.
    const work = path.join(stateDir, "work");
    const made = () => (fs.existsSync(work) ? fs.readdirSync(work) : []);
    const deadline = Date.now() + 20_000;
    while (made().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(made()).toHaveLength(1);
    child.kill("SIGHUP");
    await new Promise((resolve) => child.on("close", resolve));
    expect(fs.readdirSync(path.join(stateDir, "work"))).toEqual([]);
    expect(git(mirror, "worktree", "list")).not.toContain(path.join(stateDir, "work"));
  }, GIT_FIXTURE_MS);
});

describe("box-run command line flags", () => {
  // The six in-process settings were once command-line flags too; no caller
  // passed one, so the command line refuses them like any unknown option.
  it("refuses the settings that exist only in process", () => {
    for (const flag of ["--cwd", "--allowed-tools", "--disallowed-tools", "--permission-mode", "--max-turns", "--output-format"]) {
      const result = run(["--repo", "none", flag, "x"], { stateDir: temp("state"), env: { CLAUDE_BIN: fakeCli("gone") } });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`unknown option ${flag}`);
    }
  });

  it("prints the usage block for --help and starts nothing", () => {
    const record = path.join(temp("help"), "record.json");
    const result = run(["--help"], { stateDir: temp("state"), env: { CLAUDE_BIN: fakeCli("help"), FAKE_RECORD: record } });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Usage:\n/);
    expect(result.stdout).toContain("--timeout MS");
    expect(result.stdout).not.toContain("REMOVAL CHECK");
    expect(fs.existsSync(record)).toBe(false);
  });
});

// THE MODEL CEILING (worker/runs/models.mjs; Tom's rulings of 2026-09-24). A
// request for Fable runs Opus only while the Fable availability file says
// Fable is unavailable; a Fable run refused for a limit sets it so and runs
// again at Opus; the probe asks Fable whatever the file says and lifts it.
const models = await import("../models.mjs");

describe("box-run model ceiling", () => {
  const argvs = (log) => fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const modelOf = (argv) => argv[argv.indexOf("--model") + 1];

  it("runs a Fable request as Fable while Fable is available, and as Opus while it is not", () => {
    const { env, stateDir, seen } = inProcess("ceiling-state");
    entry.boxRunSync({ prompt: "p", env, model: "fable", registration: null });
    expect(modelOf(seen().argv)).toBe("fable");
    models.markFableUnavailable(stateDir, { at: 1000, reason: "You've hit your monthly spend limit" });
    entry.boxRunSync({ prompt: "p", env, model: "fable", registration: null });
    expect(modelOf(seen().argv)).toBe("opus");
    // A model at or below the ceiling is untouched either way.
    entry.boxRunSync({ prompt: "p", env, model: "sonnet", registration: null });
    expect(modelOf(seen().argv)).toBe("sonnet");
  });

  it("marks Fable unavailable when a Fable run is refused for a limit, and runs again at Opus", async () => {
    const stateDir = temp("ceiling-refused");
    const log = path.join(stateDir, "argv.log");
    const { env } = inProcess("ceiling-refused", { FAKE_REFUSE_MODEL: "fable", FAKE_LOG: log, FAKE_ANSWER: JSON.stringify({ type: "result", subtype: "success", result: "judged" }) });
    const result = entry.boxRunSync({ prompt: "p", env, model: "fable", outputFormat: "json", registration: null });
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe("judged");
    expect(result.model).toBe("opus");
    expect(argvs(log).map(modelOf)).toEqual(["fable", "opus"]);
    const state = models.readFableState(env.RUN_SWEEP_STATE_DIR);
    expect(state.available).toBe(false);
    expect(state.reason).toMatch(/monthly spend limit/);
    // The asynchronous entry takes the same path.
    fs.rmSync(log);
    models.markFableAvailable(env.RUN_SWEEP_STATE_DIR);
    const again = await entry.boxRun({ prompt: "p", env, model: "claude-fable-5-1", outputFormat: "json", registration: null, slotWaitMs: 5_000 });
    expect(again.text).toBe("judged");
    expect(argvs(log).map(modelOf)).toEqual(["claude-fable-5-1", "opus"]);
    // And the entry that takes no slot, which the evals pass awaits.
    fs.rmSync(log);
    models.markFableAvailable(env.RUN_SWEEP_STATE_DIR);
    const noSlot = await entry.boxRunNoSlot({ prompt: "p", env, model: "fable", outputFormat: "json", registration: null });
    expect(noSlot.text).toBe("judged");
    expect(argvs(log).map(modelOf)).toEqual(["fable", "opus"]);
  });

  it("leaves Fable available after a failure that is not a limit", () => {
    const { env } = inProcess("ceiling-other", { FAKE_REFUSE_MODEL: "fable", FAKE_REFUSAL: "the API is overloaded" });
    const result = entry.boxRunSync({ prompt: "p", env, model: "fable", outputFormat: "json", registration: null });
    expect(result.exitCode).toBe(1);
    expect(models.readFableState(env.RUN_SWEEP_STATE_DIR).available).toBe(true);
  });

  it("the probe asks Fable past the ceiling, lifts it on an answer, and moves only the check time on a refusal", async () => {
    const refused = inProcess("probe-refused", { FAKE_REFUSE_MODEL: "fable" });
    models.markFableUnavailable(refused.stateDir, { at: 1000, reason: "You've hit your monthly spend limit" });
    const still = await entry.probeFable({ env: refused.env, now: () => 5000 });
    expect(modelOf(refused.seen().argv)).toBe("fable");
    expect(refused.seen().argv).toEqual(expect.arrayContaining(["--max-turns", "1"]));
    expect(still).toMatchObject({ available: false, since: 1000, checkedAt: 5000 });

    const answered = inProcess("probe-answered", { FAKE_ANSWER: JSON.stringify({ type: "result", subtype: "success", result: "ready" }) });
    models.markFableUnavailable(answered.stateDir, { at: 1000, reason: "You've hit your monthly spend limit" });
    const lifted = await entry.probeFable({ env: answered.env, now: () => 7000 });
    expect(lifted).toEqual({ available: true, since: 7000, checkedAt: 7000 });
    expect(models.readFableState(answered.stateDir).available).toBe(true);
    // The next Fable request runs Fable.
    entry.boxRunSync({ prompt: "p", env: answered.env, model: "fable", registration: null });
    expect(modelOf(answered.seen().argv)).toBe("fable");
  });
});
