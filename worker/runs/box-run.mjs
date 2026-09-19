// box-run.mjs — run one agent on the Jarvis Box and print only its report.
//
// THIS IS THE BOX HALF OF THE TRANSPORT. Tom types in the desktop app on his
// laptop; the orchestrator there reads, thinks, commits and pushes, and spawns
// nothing locally. Every piece of work is a `box` subagent, which runs
// scripts/box-agent.mjs (the laptop half), which ssh's one line to the box,
// which is `tts-run`, which is this file. The pair is the whole transport:
// there is no daemon in it, no queue service, and no new key.
//
// Vocabulary, once, because these are tom.quest's words and not English's:
//   run       — one CLI thread: one assembled prompt, its turns, its tool
//               calls, its children, its ending.
//   session   — a run Tom talks to. A box child is a run, never a session.
//   slot      — one of the box's two Claude accounts under
//               /root/.claude-accounts, with `active` a symlink to one.
//   worktree  — a git worktree off a bare mirror, one per run, reaped at exit.
//   semaphore — the counting lock that caps how many runs execute at once.
//
// Usage:
//   node /opt/tts/runs/box-run.mjs [options] < prompt.txt
//
//   --runner claude|codex   which CLI runs                 (default: claude)
//   --repo NAME             tom.quest | ComplexMultiTrigger | WikiTom | none
//   --ref REF               branch, tag or sha to check out
//   --model NAME            model for the run
//   --effort LEVEL          codex only, passed through
//   --sandbox MODE          codex only, passed through
//   --schema FILE           codex only, passed through
//   --tests                 this run will run a test suite (arms the guard)
//   --install               pnpm install in the worktree   (implied by --tests)
//   --parent RUNID          the laptop session's run id
//   --root RUNID            that run's rootRunId           (default: --parent)
//   --depth N               the parent's depth + 1         (default: 1)
//   --keep-worktree         do not reap at exit (debugging)
//
//     REMOVAL CHECK on --keep-worktree: the need it meets cannot be met some
//     other way, because the reap DELETES THE ONLY COPY. A run's report comes
//     back over the transport and its transcript is ingested, but the tree it
//     edited exists nowhere else: box.md tells a caller that results come back
//     as commits, so anything a run changed and did not commit — the half-done
//     edit, the failing build's output, the file it wrote to the wrong path —
//     is gone the moment it exits. There is no snapshot, no archive and no
//     second checkout to look at afterwards, and the log the reap removes with
//     the tree is the same story. The flag is off by default and the reap is
//     unconditional without it.
//   --timeout MS            hard kill                      (default: none)
//
// THE PROMPT ARRIVES ON STDIN, never as an argument — the same reason
// codex-run.mjs passes `-`: no command-line length limit, and no prompt text
// visible in `ps` to anyone with a shell on the box.
//
// STDOUT IS THE REPORT AND THE STATUS LINE AND NOTHING ELSE. Progress, the
// queue notice, timings and the child's own stderr go to stderr or to a log
// file under the work directory. The laptop agent relays one block, unparsed,
// so anything else on stdout becomes a false sentence in Tom's transcript.
//
// THERE IS NO TIME LIMIT BY DEFAULT (Tom's ruling, 2026-09-09), the same as
// codex-run.mjs: a real run outlasts any number worth guessing, and a kill
// throws away everything it had done.
//
// Exit codes: the CLI's own code on completion; 124 on timeout when a
// --timeout was given; 75 (EX_TEMPFAIL) when the memory guard refuses; 2 for
// bad arguments, an unresolvable ref, or a missing binary.

import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runConfig } from "./config.mjs";
import { writeRegistration } from "./registration.mjs";

// MIRROR of REPO_GITHUB in worker/session-host/session.mjs and SESSION_REPOS
// in convex/ttsShared.ts. Restated rather than imported: session.mjs pulls the
// whole daemon (npm deps, the Convex client) and this file must stay a plain
// zero-dependency script that runs from /opt/tts/runs. scripts/check-session-
// mirrors.mjs fences the three copies against each other.
const REPO_GITHUB = {
  "tom.quest": "Heffnt/tom.quest",
  ComplexMultiTrigger: "Heffnt/ComplexMultiTrigger",
  WikiTom: "Heffnt/WikiTom",
};

/** The sentinel repo value meaning "no checkout, an empty scratch workspace". */
const REPO_NONE = "none";

// What a box run may do. `Task` is in it BECAUSE a box run may spawn its own
// children on the box, which is the point of moving the work here. Reading and
// writing are in it because a run that cannot edit cannot land work.
const TOOLS_ALLOWED = Object.freeze([
  "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Glob", "Grep", "Bash", "TodoWrite", "WebFetch", "WebSearch", "Task",
]);

// MIRROR of BANNED_TOOLS in worker/session-host. A box child has no surface to
// ask a question on: the laptop agent that started it is a transport relay,
// and nobody is watching this run's stdin.
const BANNED_TOOLS = Object.freeze(["AskUserQuestion"]);

const DEFAULT_MAX_PARALLEL = 2;
const TESTS_MIN_FREE_MB = 2048;
const SEMAPHORE_RETRY_MS = 5000;
const LOCK_STALE_MS = 30_000;

function fail(message, code = 2) {
  process.stderr.write(`box-run: ${message}\n`);
  process.exit(code);
}

function note(message) {
  process.stderr.write(`box-run: ${message}\n`);
}

// This file runs here in a checkout (worker/runs/) and flat at /opt/tts/runs/.
// `../session-host/` resolves to the installed daemon modules in BOTH layouts,
// so one relative candidate is correct; the absolute one is the fallback for a
// half-installed box, where a missing redactor must fail loudly rather than
// let unredacted bytes reach stdout.
function moduleUrl(relative, installed) {
  const candidates = [new URL(relative, import.meta.url), new URL(`file://${installed}`)];
  const found = candidates.find((candidate) => fs.existsSync(fileURLToPath(candidate)));
  if (!found) throw new Error(`box-run: ${relative} is not installed`);
  return found.href;
}

const { redactSecrets } = await import(moduleUrl("../session-host/redact.mjs", "/opt/tts/session-host/redact.mjs"));
const { scrubbedEnv } = await import(moduleUrl("../session-host/env-scrub.mjs", "/opt/tts/session-host/env-scrub.mjs"));

function parseArgs(argv) {
  const opts = {
    runner: "claude",
    repo: REPO_NONE,
    ref: null,
    model: null,
    effort: null,
    sandbox: null,
    schema: null,
    tests: false,
    install: false,
    parent: null,
    root: null,
    depth: null,
    keepWorktree: false,
    timeout: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case "--runner": opts.runner = next(); break;
      case "--repo": opts.repo = next(); break;
      case "--ref": opts.ref = next(); break;
      case "--model": opts.model = next(); break;
      case "--effort": opts.effort = next(); break;
      case "--sandbox": opts.sandbox = next(); break;
      case "--schema": opts.schema = next(); break;
      case "--tests": opts.tests = true; break;
      case "--install": opts.install = true; break;
      case "--parent": opts.parent = next(); break;
      case "--root": opts.root = next(); break;
      case "--depth": opts.depth = Number(next()); break;
      case "--keep-worktree": opts.keepWorktree = true; break;
      case "--timeout": opts.timeout = Number(next()); break;
      default: fail(`unknown option ${arg}`);
    }
  }
  if (opts.runner !== "claude" && opts.runner !== "codex") fail("--runner must be claude or codex");
  if (opts.repo !== REPO_NONE && !REPO_GITHUB[opts.repo]) {
    fail(`unknown repo "${opts.repo}" — expected one of ${Object.keys(REPO_GITHUB).join(", ")}, or "none"`);
  }
  // REMOVAL CHECK: ignoring the `--ref` instead is the one thing this must not
  // do. `--repo none` gives the run no checkout at all — it works in an empty
  // directory — so a caller who named a ref and was answered silently would get
  // a run that never saw that commit and a report that names it anyway. That is
  // the same shape the `--root and --depth need a --parent` refusal below
  // spells out at length: a flag a caller passed is either honoured or refused,
  // never dropped on the floor.
  if (opts.repo === REPO_NONE && opts.ref) fail("--ref needs a --repo to resolve it in");
  // REMOVAL CHECK on both range tests: the record cannot refuse what never
  // reaches it. `--timeout` is read HERE and nowhere else — it arms the kill
  // timer below, whose `opts.timeout > 0` is false for NaN, so `--timeout abc`
  // without this line means a caller asked for a hard limit and silently got
  // none. `--depth` does reach the record, as JSON, where a NaN serialises to
  // null: convex/runs.ts then refuses the payload with a 400 and dead-letters
  // it AFTER the run has spent its model calls, which is the trade the
  // `--root and --depth` refusal below already argues one line of stderr beats.
  if (!Number.isFinite(opts.timeout) || opts.timeout < 0) fail("--timeout must be a number of milliseconds, or 0 for no limit");
  if (opts.depth !== null && (!Number.isInteger(opts.depth) || opts.depth < 0)) fail("--depth must be a whole number");
  // REMOVAL CHECK: this cannot go, because the two branches below are what it
  // protects. `--root` and `--depth` without a `--parent` describe a position
  // in a tree with no edge leading to it, and the registration writer spreads
  // all three or none — so the pair would be dropped on the floor and the run
  // would record a root of itself at depth 0 while its caller believed it had
  // said otherwise. Silently ignoring two flags a caller passed is the shape
  // this refuses; accepting them without a parent would put a run at a depth
  // its own rootRunId contradicts, which convex/runs.ts then refuses anyway,
  // 400 and dead-lettered instead of one line of stderr.
  if (!opts.parent && (opts.root || opts.depth !== null)) fail("--root and --depth need a --parent");
  // The model default depends on the runner, so it cannot be a constant above.
  // gpt-5.6-sol IS THE FLEET DEFAULT and the only right answer here: it is
  // scripts/codex-run.mjs's DEFAULT_MODEL, so the two ways of reaching Codex
  // agree, and a box run is a run of its own rather than a Codex child (a
  // child is the one thing named gpt-5.6-terra). Naming terra here also made
  // .claude/agents/codex.md's "the defaults are already the strongest model"
  // false for every run that went through the box, which is now all of them.
  if (!opts.model) opts.model = opts.runner === "codex" ? "gpt-5.6-sol" : "opus";
  // REMOVAL CHECK on --install as its own flag: --tests implies it, but the
  // reverse is not true and folding them together would arm the memory guard
  // for work that does not need it. A run that builds, lints, typechecks or
  // reads a dependency's source needs node_modules and costs nothing like a
  // test suite; with one flag it would be refused on a box that is merely busy
  // (exit 75), and the alternative — one flag that never arms the guard —
  // deletes the guard instead of this.
  if (opts.tests) opts.install = true;
  if (opts.parent) {
    if (opts.root === null) opts.root = opts.parent;
    if (opts.depth === null) opts.depth = 1;
  }
  return opts;
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// THE GUARD KEYS ON AN EXPLICIT FLAG, NEVER ON READING THE PROMPT. Inferring
// "this run will compile and test" from prompt text is a guess, and a guess
// that refuses a run is worse than no guard at all.
//
// REMOVAL CHECK: the semaphore cannot take this guard's place, because the two
// count different things. RUN_MAX_PARALLEL counts RUNS THIS TRANSPORT STARTED,
// and the memory on a 7.7 GB box is spent by everything else on it as well —
// the session-host daemon and its sessions, the nightly, the evals server, the
// graph build. Two slots free says nothing about whether 1.6 GB is. A limit
// low enough to be safe against every one of those at once would refuse work
// on an idle box, which is the failure the semaphore exists to avoid. So the
// semaphore bounds contention and this reads the actual number.
function refuseIfMemoryIsShort(opts, env) {
  if (!opts.tests) return;
  // REMOVAL CHECK on MEMINFO_PATH: without it this guard has no test at all.
  // /proc/meminfo is Linux's and read-only — it does not exist on the Windows
  // laptop this suite also runs on, and no machine can be made to report 300
  // MB free on demand. The seam is read once, here, and the only writer of it
  // is the test; a run never sets it, and the fallback is the real file.
  const file = env.MEMINFO_PATH || "/proc/meminfo";
  let availableMb = null;
  try {
    const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(fs.readFileSync(file, "utf8"));
    if (match) availableMb = Math.floor(Number(match[1]) / 1024);
  } catch {
    availableMb = null;
  }
  if (availableMb === null) {
    // No readable MemAvailable is not a refusal. The guard exists to stop a
    // test run thrashing a 7.7 GB box; a machine that cannot report its memory
    // has given no evidence that it is short, and refusing on no evidence is
    // the failure mode decided item 10 rules out.
    note("free memory is unreadable; the test-memory guard did not run");
    return;
  }
  if (availableMb < TESTS_MIN_FREE_MB) {
    process.stderr.write(
      `box-run: refused — free memory is ${availableMb} MB, a test run needs ${TESTS_MIN_FREE_MB} MB; nothing was started\n`,
    );
    process.exit(75);
  }
}

// An exclusive-create lock with a stale reclaim — the same discipline
// registration.mjs's withEnvelopeLock uses, and for the same reason: it is one
// filesystem primitive, it works on every platform this repo's tests run on,
// and a holder that died does not wedge the box forever. flock(1) is the Linux
// idiom, but the semaphore is also exercised by vitest on Windows, and a
// locking mechanism nobody can test is worse than one that is tested.
//
// REMOVAL CHECK on the attempt cap: the stale reclaim cannot be the only guard
// because it only fires on a lock file OLDER than LOCK_STALE_MS, and the
// holder here is alive and touching it — it holds the lock for the few
// milliseconds it takes to read and rewrite the slot file, so a live holder is
// never stale. What the cap catches is the case the reclaim is blind to: a
// lock directory that cannot be unlinked (a permission change, a full disk),
// where every attempt raises EEXIST, every stat says fresh, and the loop is
// infinite. A box run has no time limit, so nothing above would ever end it —
// the process would sit there holding a slot for ever with nothing on stdout.
// 2000 attempts at 20 ms is a forty-second ceiling and then a named error.
function withLock(lockFile, operation) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    let handle;
    try {
      handle = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, at: Date.now() }));
      try { return operation(); }
      finally {
        fs.closeSync(handle);
        try { fs.unlinkSync(lockFile); } catch {}
      }
    } catch (error) {
      if (handle !== undefined) try { fs.closeSync(handle); } catch {}
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {}
      sleep(20);
    }
  }
  throw new Error("the run semaphore lock is busy");
}

// Registration is synchronous because the envelope must exist before a spawn,
// and so is this: Atomics.wait blocks without a CPU spin.
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to somebody else — still a
    // live holder. Only ESRCH proves the slot is free.
    return error?.code === "EPERM";
  }
}

function readCounter(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(value?.holders) ? value.holders : [];
  } catch {
    return [];
  }
}

function writeCounter(file, holders) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify({ count: holders.length, holders })}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/**
 * A COUNTING LOCK, not N slot files. A slot-file scheme makes a queued run wait
 * on one specific slot; a counter with a retry loop lets it take whichever
 * frees first, which is what "queue beyond N" means. There is no cap on the
 * waiting: a queued run is a working run.
 *
 * Returns a release function. Every exit path must call it.
 */
function takeSlot({ id, counterFile, lockFile, limit, sleepMs = SEMAPHORE_RETRY_MS, announce = note }) {
  let announced = false;
  for (;;) {
    const taken = withLock(lockFile, () => {
      const holders = readCounter(counterFile).filter((holder) => alive(holder?.pid));
      if (holders.length < limit) {
        writeCounter(counterFile, [...holders, { id, pid: process.pid, at: Date.now() }]);
        return true;
      }
      writeCounter(counterFile, holders);
      if (!announced) {
        // THE FIRST REFUSAL ONLY. A line every five seconds would bury the
        // report the laptop agent is waiting to relay.
        announce(`queued behind ${holders.length} (limit ${limit})`);
        announced = true;
      }
      return false;
    });
    if (taken) break;
    sleep(sleepMs);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      withLock(lockFile, () => {
        writeCounter(counterFile, readCounter(counterFile).filter((holder) => holder?.id !== id && alive(holder?.pid)));
      });
    } catch {
      // A release that cannot take the lock leaves a holder whose pid is gone,
      // and the next run reclaims it. Never fail a finished run over this.
    }
  };
}

function git(args, { cwd, env } = {}) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  return result;
}

function gitOrFail(args, what, { cwd, env, before } = {}) {
  const result = git(args, { cwd, env });
  if (result.status !== 0) {
    if (before) before();
    fail(`${what}: ${String(result.stderr ?? "").trim().split("\n").slice(-3).join("; ")}`);
  }
  return result;
}

/**
 * Repos reach the box as BARE MIRRORS under <stateDir>/repos/<repo>.git, and
 * each run gets a worktree off the mirror. Not off /root/tom.quest: setup.sh
 * resets that checkout hard on every rollout, so a worktree attached to it
 * would be destroyed mid-run.
 *
 * The URL stays clean; the global credential helper setup.sh installs supplies
 * the token at ask time, so no work tree ever holds it.
 */
function ensureMirror(repo, reposDir, env) {
  const mirror = path.join(reposDir, `${repo}.git`);
  const url = `https://github.com/${REPO_GITHUB[repo]}.git`;
  // GIT_LFS_SKIP_SMUDGE: an LFS pointer must not pull its blob here — the box
  // has no LFS credentials and the payload is never what a run needs.
  const gitEnv = { ...env, GIT_LFS_SKIP_SMUDGE: "1" };
  if (!fs.existsSync(path.join(mirror, "HEAD"))) {
    fs.mkdirSync(reposDir, { recursive: true });
    note(`mirroring ${repo}`);
    gitOrFail(["clone", "--mirror", url, mirror], `could not mirror ${repo}`, { env: gitEnv });
  } else if (git(["-C", mirror, "remote", "update", "--prune"], { env: gitEnv }).status !== 0) {
    // A stale mirror is still a usable mirror when the ref is already in it.
    // Refusing here would turn a network blip into a refused run.
    note(`could not update the ${repo} mirror; using what is already there`);
  }
  // THE MIRROR FLAG COMES OFF, EVERY TIME, AND THIS IS NOT COSMETIC.
  // `clone --mirror` is `--bare` plus the fetch refspec plus
  // `remote.origin.mirror = true`, and that last one means "every push from
  // this repository behaves as though --mirror were on the command line". A
  // run's worktree is added off this repository and shares its config, so the
  // ordinary thing a run does when it is finished — `git push`, or
  // `git push origin HEAD:branch` — would FORCE every ref on GitHub to this
  // mirror's copy and DELETE every branch the mirror has not fetched. The
  // mirror is only as fresh as the last `remote update`, and the branch above
  // carries on when that update fails. main moving backwards is a Vercel
  // deploy of an older tree, and a branch pushed since the last update is gone
  // with nothing in git to restore it from. Bash is in TOOLS_ALLOWED and
  // .claude/agents/box.md tells a caller results come back as commits, so this
  // is the normal path, not an exotic one.
  //
  // Unsetting it leaves the `+refs/*:refs/*` fetch refspec alone, so
  // `remote update --prune` still mirrors everything IN; only the push side
  // goes back to git's ordinary fast-forward-only behaviour. It runs on every
  // call rather than only after a clone, because the box already holds mirrors
  // cloned before this line existed. `--unset` exits 5 on a key that is not
  // there, which is why it is not gitOrFail.
  git(["-C", mirror, "config", "--unset", "remote.origin.mirror"], { env: gitEnv });
  return mirror;
}

function resolveRef(mirror, ref, env, onFail) {
  // NO `origin/<ref>` CANDIDATE. A mirror fetches with +refs/*:refs/*, so a
  // branch lands at refs/heads/<name> and there is no refs/remotes/origin/*
  // namespace in the repository at all — the candidate could never match, and
  // a candidate that cannot match reads as a fallback that exists.
  const candidates = ref ? [ref, `refs/heads/${ref}`, `refs/tags/${ref}`] : ["HEAD"];
  for (const candidate of candidates) {
    const result = git(["-C", mirror, "rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { env });
    const sha = String(result.stdout ?? "").trim();
    if (result.status === 0 && sha) return sha;
  }
  // FETCH FIRST, FAIL LOUDLY, NEVER FALL BACK TO THE DEFAULT BRANCH. A run that
  // silently worked on main instead of the branch it was given would report
  // results about code nobody asked about.
  if (onFail) onFail();
  fail(`--ref ${ref} does not resolve in the ${path.basename(mirror, ".git")} mirror`);
  return null;
}

function onPath(env, names) {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function pnpmBinary(env) {
  return onPath(env, process.platform === "win32" ? ["pnpm.cmd", "pnpm.exe", "pnpm"] : ["pnpm"]);
}

// REMOVAL CHECK on CLAUDE_BIN and TTS_CODEX_BIN: without them every test in
// this file would start a real Claude or Codex run — an account, a model, a
// bill and an answer nobody can predict — which is not a test. They are the
// one seam by which the whole body (the worktree, the semaphore, the envelope,
// the redaction, the status line) is exercised against a child that does what
// the case told it to. A run never sets either: the fallbacks are `claude` on
// PATH and the installed /usr/local/bin/tts-codex, and a CLAUDE_BIN that does
// not exist is refused rather than silently falling through to the real one.
function claudeBinary(env) {
  if (env.CLAUDE_BIN) {
    if (!fs.existsSync(env.CLAUDE_BIN)) fail(`CLAUDE_BIN=${env.CLAUDE_BIN} does not exist`);
    return env.CLAUDE_BIN;
  }
  const found = onPath(env, process.platform === "win32" ? ["claude.cmd", "claude.exe", "claude"] : ["claude"]);
  if (!found) fail("claude binary not found: set CLAUDE_BIN, or install Claude Code on the box");
  return found;
}

function codexBinary(env) {
  const candidate = env.TTS_CODEX_BIN || "/usr/local/bin/tts-codex";
  if (!fs.existsSync(candidate)) fail(`tts-codex is not installed at ${candidate}`);
  return candidate;
}

// ---------------------------------------------------------------------------
// The run itself. Everything above is testable in isolation; this is the body
// tts-run forwards to.
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const prompt = readStdin();
if (!prompt.trim()) fail("no prompt on stdin");

// BEFORE THE SEMAPHORE AND BEFORE ANY WORK: a refused run must start nothing,
// take no slot, and clone nothing.
refuseIfMemoryIsShort(opts, process.env);

const config = runConfig();
const stateDir = config.stateDir;
const pnpmStore = path.join(path.dirname(stateDir), "pnpm-store");
const limit = Number.isInteger(config.maxParallel) && config.maxParallel > 0 ? config.maxParallel : DEFAULT_MAX_PARALLEL;

const id = crypto.randomUUID().slice(0, 8);
const workDir = path.join(stateDir, "work", id);

// A RUN INSIDE A RUN TAKES NO SECOND SLOT, and without this rule the transport
// deadlocks on its ordinary path. A box run holds its slot for the whole life
// of its CLI child; that child has Task, a tom.quest worktree, and agent files
// that now send `box` and `codex` through scripts/box-agent.mjs, which on the
// box runs tts-run right here. So the child asks for a slot its own parent is
// still holding. At the default limit of 2, two box runs that each delegate —
// which "mechanical work runs on Codex" makes the normal thing, not the exotic
// one — leave both children queued behind two live parents for ever, and the
// relay is told `queued behind` is not an error. At limit 1 a single run that
// asks Codex anything hangs itself.
//
// The semaphore counts the WORK THE LAPTOP SENT, which is what it was sized
// for: one full test suite is about 1.6 GB and the box holds two of those. A
// subagent inside a run is part of that run's budget, not a new one, and the
// run above it is the thing that has to finish before the slot comes back.
// TTS_RUN_SLOT_HELD is set on every child this file spawns, so the whole
// subtree under one slot inherits it however deep the delegation goes.
const inheritedSlot = process.env.TTS_RUN_SLOT_HELD === "1";
if (inheritedSlot) note("running under the parent run's slot; not queueing");
const release = inheritedSlot ? () => {} : takeSlot({
  id,
  counterFile: path.join(stateDir, "semaphore.json"),
  lockFile: path.join(stateDir, "semaphore.lock"),
  limit,
  // REMOVAL CHECK on RUN_SEMAPHORE_RETRY_MS: the queue's proof is that a
  // second run waits and then goes, and at the real retry interval that test
  // would take the interval itself to run, once per case, for ever. The seam
  // shortens the sleep and nothing else — the limit, the slot file and the
  // stale reclaim are untouched — so what the test exercises is the same code
  // a run takes. Deleting it leaves the queue with no test.
  sleepMs: Number(process.env.RUN_SEMAPHORE_RETRY_MS) > 0 ? Number(process.env.RUN_SEMAPHORE_RETRY_MS) : SEMAPHORE_RETRY_MS,
});

let mirror = null;
let checkout = null;
let reaped = false;

function reap() {
  if (reaped) return;
  reaped = true;
  try {
    if (!opts.keepWorktree) {
      if (mirror && checkout) git(["-C", mirror, "worktree", "remove", "--force", checkout]);
      if (mirror) git(["-C", mirror, "worktree", "prune"]);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  } catch {
    // A work tree that will not reap costs disk, not correctness. The release
    // below is the part that must always happen.
  }
  release();
}

// REMOVAL CHECK: the slot reclaim covers HALF of what a signalled run leaves,
// and the other half has no cleanup anywhere. takeSlot filters holders by
// `alive(holder.pid)`, so a killed run's slot is indeed reclaimed — by the NEXT
// run, which is soon enough. Its worktree is not: nothing else on the box runs
// `git worktree remove` or prunes <stateDir>/work/<id>, so without these
// handlers every Ctrl-C and every `systemctl stop` leaves a full detached
// checkout of tom.quest or ComplexMultiTrigger on disk for good, and the
// mirror's worktree list grows an entry per kill. `--keep-worktree` is the way
// to ask for that deliberately; reap() honours it either way.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    reap();
    process.exit(130);
  });
}

let cwd;
try {
  fs.mkdirSync(workDir, { recursive: true });
  if (opts.repo === REPO_NONE) {
    cwd = path.join(workDir, "ws");
    fs.mkdirSync(cwd, { recursive: true });
  } else {
    mirror = ensureMirror(opts.repo, path.join(stateDir, "repos"), process.env);
    const sha = resolveRef(mirror, opts.ref, process.env, reap);
    checkout = path.join(workDir, opts.repo);
    gitOrFail(["-C", mirror, "worktree", "add", "--detach", checkout, sha], `could not make a worktree at ${sha}`, {
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
      before: reap,
    });
    cwd = checkout;
    if (opts.install) {
      const pnpm = pnpmBinary(process.env);
      if (!pnpm) { reap(); fail("pnpm is not installed on the box"); }
      note(`pnpm install in ${opts.repo}`);
      const installed = spawnSync(pnpm, ["install", "--frozen-lockfile", "--store-dir", pnpmStore], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32",
      });
      if (installed.status !== 0) {
        process.stderr.write(`${String(installed.stderr ?? "").trim().split("\n").slice(-10).join("\n")}\n`);
        reap();
        fail("pnpm install failed in the worktree");
      }
    }
  }
} catch (error) {
  reap();
  fail(error?.message ?? String(error));
}

// REGISTRATION IS WRITTEN BEFORE THE CHILD CAN START, so the record holds the
// envelope even when the run dies in its first turn.
//
// origin is `session`: `laptop-orchestrator` is not in convex/runs.ts's
// validOrigin, origin names what STARTED a run — a session did — and
// host: "box" already records where it ran.
//
// kind is `subagent`: it is a run a session spawned by a tool call. Left to the
// Claude parser, a `-p` run with a user line reads as a session, and a second
// session in the tree is a false fact.
//
// linkKnown is false WITH a parent: convex/runs.ts's validRunPayload refuses a
// run where linkKnown and a parentRunId meet without a spawnedByToolUseId, and
// the Bash tool call that launched this run does not expose its id to the
// command line. An unknown link is recorded unknown.
//
// rootRunId and depth travel WITH the parent: a run whose parent nobody has
// swept yet keeps the root and depth its own sidecar gave it, and a Claude root
// file parses at depth 0 — which convex/runs.ts refuses against a parent.
//
// ONE RUN, ONE AUTHOR OF ITS ENVELOPE. scripts/codex-run.mjs registers the run
// it starts itself — its own prompt hash, its own skills, its own graph
// version — under a token it mints, and it never reads TTS_RUN_REG_TOKEN. So
// for the Codex runner a second envelope written here is an orphan: codex-run's
// is the one the sweep claims, this one is never claimed, and the spool holds
// it until cleanup deletes it. Worse, the parent went with it — the run landed
// as an unparented `job` and the tree edge this whole transport exists to
// record was lost. This file therefore writes nothing for Codex and hands over
// the one fact codex-run cannot know: the parent, below.
// WHERE THE RUN STARTS is named only for a run nobody launched from a parent:
// with --parent the record gives the run its parent's environment, and a word
// here would overrule that with a guess. A launcher that knows better says so
// in TTS_RUN_ENVIRONMENT, which wins over both.
const namedEnvironment = ["session", "worker", "runner"].includes(process.env.TTS_RUN_ENVIRONMENT) ? process.env.TTS_RUN_ENVIRONMENT : null;
const spooled = opts.runner === "codex" ? null : writeRegistration({
  spoolDir: process.env.TTS_RUN_REG_SPOOL || path.join(stateDir, "registration"),
  writer: { file: "worker/runs/box-run.mjs", job: "box-run" },
  registration: {
    host: "box",
    runner: opts.runner,
    origin: "session",
    kind: "subagent",
    ...(namedEnvironment ? { environment: namedEnvironment } : opts.parent ? {} : { environment: "worker" }),
    modelRequested: opts.model,
    ...(opts.effort ? { effortRequested: opts.effort } : {}),
    cwd,
    ...(opts.parent
      ? { parentRunId: opts.parent, rootRunId: opts.root, depth: opts.depth, linkKnown: false }
      : {}),
    spawnedByToolUseId: null,
    continuesRunId: null,
    // The box's own SessionStart hook assembles the operate layer and renders
    // the grant block (setup.sh installs it in every account slot). A second
    // authority naming layers here is exactly the drift laptop-setup.mjs's
    // removeHookConfig was written to stop.
    layersKnown: false,
    layersGiven: [],
    layersDenied: [],
    skillsGranted: [],
    skillsRefused: [],
    tools: { allowed: [...TOOLS_ALLOWED], denied: [...BANNED_TOOLS] },
    hooksConfigured: ["SessionStart", "SessionEnd", "Stop", "SubagentStart", "SubagentStop"],
    promptSha256: crypto.createHash("sha256").update(prompt).digest("hex"),
  },
});

const childEnv = {
  ...scrubbedEnv({ keepTtsKey: true }),
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || "/root/.claude-accounts/active",
  WIKITOM_DIR: process.env.WIKITOM_DIR || "/root/wikitom",
  ...(spooled ? { TTS_RUN_REG_TOKEN: spooled.token } : {}),
  TTS_RUN_REG_SPOOL: process.env.TTS_RUN_REG_SPOOL || path.join(stateDir, "registration"),
  RUN_HOST: "box",
  GIT_LFS_SKIP_SMUDGE: "1",
  // THE SLOT THIS RUN HOLDS COVERS EVERYTHING UNDER IT. See the semaphore
  // block above: a `box` or `codex` subagent inside this child reaches
  // box-run.mjs again through scripts/box-agent.mjs, and asking for a second
  // slot while its own parent holds one is the deadlock. Inherited, not
  // recomputed, so it survives however many levels the delegation goes.
  TTS_RUN_SLOT_HELD: "1",
};
// THE PARENT GOES TO WHICHEVER WRITER OWNS THE ENVELOPE, and never to both.
// For Claude the envelope above already carries it, so the variable is cleared:
// two writers for one field is the bug registration.mjs's header warns about.
// For Codex there is no envelope from here at all, and this variable is the
// only way the edge reaches codex-run.mjs's own — it is what turns that run
// from an unparented `job` into a `codex-child` under the session that asked
// for it. mergeRegistration fills the root and the depth from the parent when
// the launcher names neither, which is this case.
if (opts.runner === "codex" && opts.parent) childEnv.TTS_RUN_PARENT_RUN_ID = opts.parent;
else delete childEnv.TTS_RUN_PARENT_RUN_ID;
// The environment follows the same one-writer rule: codex-run.mjs names it in
// the only Codex envelope, so only the Codex child is told.
if (opts.runner === "codex" && namedEnvironment) childEnv.TTS_RUN_ENVIRONMENT = namedEnvironment;
else delete childEnv.TTS_RUN_ENVIRONMENT;

let bin;
let args;
if (opts.runner === "codex") {
  // A CODEX WEEKLY-CAP ERROR IS A LEGITIMATE OUTCOME, not a transport failure:
  // tts-codex's own message and exit code come back unaltered below.
  bin = codexBinary(process.env);
  args = ["--cwd", cwd, "--model", opts.model];
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.sandbox) args.push("--sandbox", opts.sandbox);
  if (opts.schema) args.push("--schema", opts.schema);
  if (opts.timeout > 0) args.push("--timeout", String(opts.timeout));
} else {
  bin = claudeBinary(process.env);
  // THERE IS NO TURN CAP HERE because the CLI has none. The daemon's
  // AUTO_MAX_TURNS is `maxTurns` on the SDK's query options, which is a
  // different door; `claude --help` on the box (2.1.270) offers no --max-turns,
  // and the only budget flag it does offer is --max-budget-usd, for API-key
  // users rather than the box's account slots. A box run's bound is the model's
  // own stop, and --timeout is the hard one a caller can set.
  args = [
    "-p",
    "--output-format", "text",
    "--model", opts.model,
    "--allowedTools", TOOLS_ALLOWED.join(","),
    "--disallowedTools", BANNED_TOOLS.join(","),
    "--permission-mode", "acceptEdits",
  ];
}

const errLog = path.join(workDir, "stderr.log");
const errStream = fs.createWriteStream(errLog);
const useShell = process.platform === "win32" && bin.toLowerCase().endsWith(".cmd");
const quote = (s) => (useShell ? `"${String(s).replace(/\\(?=")/g, "\\\\").replace(/"/g, '""')}"` : s);

const child = spawn(useShell ? quote(bin) : bin, args.map(quote), {
  cwd,
  env: childEnv,
  shell: useShell,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let answer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => { answer += chunk; });
// THE CHILD'S STDERR NEVER REACHES OUR STDOUT. It carries progress, tool
// chatter and whatever a failing command printed; the laptop relays stdout
// whole, so one stray line there becomes a sentence Tom reads as the report.
child.stderr.pipe(errStream, { end: false });
child.stdin.on("error", () => {});
child.stdin.end(prompt);

// REMOVAL CHECK on --timeout: the ruling is that there is no time limit BY
// DEFAULT, and this flag is off unless a caller names it (opts.timeout is 0,
// the timer is null, nothing is armed). What it cannot become is nothing at
// all: a run holds a slot until its CLI child closes, so a child that wedges —
// waiting on a prompt it will never get, or a command that never returns —
// holds that slot for ever, and with the subtree rule above it holds it for
// everything under it too. A caller that knows its work is bounded is the only
// thing that can free the box short of a human on the box, and the relay is
// told to pass a `--timeout` straight through when the request names one.
//
// REMOVAL CHECK on the win32 branch beside it, and on the `.cmd` branch in the
// spawn below: this file only ever runs on Linux, and its TESTS only ever run
// on Tom's Windows laptop and on CI. The fake CLI they spawn cannot be a plain
// script there — Windows has no shebang, so a Node fake is reachable only
// through a `.cmd` shim, which Node refuses to spawn without a shell. Deleting
// the branches deletes the suite's ability to run the real file at all, and
// `child.kill` on Windows leaves the shim's grandchild alive, which is what
// taskkill /T is for. The production path takes the else in both.
let timedOut = false;
const timer = opts.timeout > 0
  ? setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGKILL");
    }, opts.timeout)
  : null;

const started = Date.now();

child.on("error", (error) => {
  if (timer) clearTimeout(timer);
  errStream.end();
  reap();
  fail(`could not start ${bin}: ${error.message}`);
});

child.on("close", (code) => {
  if (timer) clearTimeout(timer);
  errStream.end();
  const seconds = Math.round((Date.now() - started) / 1000);
  const exit = timedOut ? 124 : (code ?? 1);
  // Redaction is a choke point, not a courtesy: the sweep redacts again on
  // every byte that reaches the store, and this is that same function applied
  // before a single byte reaches the laptop's transcript.
  const report = redactSecrets(answer);
  process.stdout.write(report);
  if (report && !report.endsWith("\n")) process.stdout.write("\n");
  // THE STATUS LINE IS LAST AND ON STDOUT, so the laptop agent reads it off the
  // final line of the one block it relays.
  process.stdout.write(`box-run: run ${id} host box runner ${opts.runner} exit ${exit} after ${seconds}s\n`);
  if (timedOut) note(`timed out after ${seconds}s (limit ${opts.timeout} ms)`);
  else if (code !== 0) {
    note(`${opts.runner} exited ${code} after ${seconds}s`);
    // THE TAIL, NOT THE PATH. The reap below deletes the work directory, so
    // naming the log file would hand the laptop an address that no longer
    // resolves — and the one case this matters most is the one where the CLI
    // wrote no answer at all, which is exactly where a Codex weekly-cap
    // message lives. --keep-worktree is what keeps the whole log.
    let tail = "";
    try { tail = redactSecrets(fs.readFileSync(errLog, "utf8")).trim().split("\n").slice(-5).join("\n"); } catch {}
    if (tail) process.stderr.write(`${tail}\n`);
  } else note(`exit 0 after ${seconds}s`);
  if (opts.keepWorktree) note(`work dir kept at ${workDir}, log at ${errLog}`);
  reap();
  process.exit(exit);
});
