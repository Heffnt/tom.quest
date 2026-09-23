// box-run.mjs — run one agent on the Jarvis Box and print only its report.
//
// THIS IS THE BOX HALF OF THE TRANSPORT. Tom types in the desktop app on his
// laptop; the orchestrator there reads, thinks, commits and pushes, and spawns
// nothing locally. Every piece of work is a `box` subagent, which runs
// scripts/box-agent.mjs (the laptop half), which ssh's one line to the box,
// which is `tts-run`, which is this file. The pair is the whole transport:
// there is no daemon in it, no queue service, and no new key.
//
// IT IS ALSO THE BOX'S ONE LAUNCHER. The cron jobs and the delegate reach the
// same body in process: worker/jobs/tts-lib.mjs's runClaude calls boxRunSync
// below instead of building a `claude` command line of its own. So every
// unattended run on the box runs under the same scrubbed environment and
// writes its envelope under this file's name. Only the command line's runs
// take a slot from the semaphore; a job's call does not (see prepareRun). The
// session daemon is the one exception, and stays one: it drives the Agent SDK
// for streaming input and interrupts (worker/session-host/README.md).
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
//   --cli claude|codex      which CLI runs                 (default: claude)
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
//   --timeout MS            hard kill                      (default: none)
//   --help                  print this block
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
//
//   A claude run from the command line gets TOOLS_ALLOWED, BANNED_TOOLS denied,
//   acceptEdits, no turn cap and text output. The tool lists, the permission
//   mode, the turn cap, the output format and a caller's own directory are
//   in-process options only (boxRun, boxRunSync): the jobs that set them call
//   the launcher in process, and no command-line caller ever passed them.
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
// --timeout was given, including a process the CLI left running past it; 75 (EX_TEMPFAIL) when the memory guard refuses or a
// caller's slot wait runs out; 2 for bad arguments, an unresolvable ref, or a
// missing binary. In process these are the `exitCode` of a thrown
// BoxRunError; only main() turns one into an exit.

import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runConfig } from "./config.mjs";
import { claimRegistration, writeRegistration } from "./registration.mjs";

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
export const BANNED_TOOLS = Object.freeze(["AskUserQuestion"]);

/** Every tool an empty `allowedTools` has to deny by name (claudeArgs). It is
 *  not a policy — worker/session-host/banned-tools.mjs is that — but the
 *  spelling of "none", for a caller that wants a model and no tools at all:
 *  the evals explanation regeneration, whose whole input is its prompt.
 *
 *  IT HAS TO BE THE WHOLE BUILT-IN SET, AND THE FILE-AND-SHELL HALF IS NOT IT.
 *  Measured on the box against the installed CLI (2.1.272) by reading the
 *  `init` envelope of `--output-format stream-json --verbose`, which lists the
 *  tools the model is actually handed: an empty allow-list plus the eighteen
 *  names this list used to hold still left SIXTEEN reachable — CronCreate,
 *  CronDelete, CronList, DesignSync, EnterWorktree, ExitWorktree, ListAgents,
 *  ReportFindings, ScheduleWakeup, SendMessage, TaskCreate, TaskGet, TaskList,
 *  TaskUpdate, ToolSearch, Workflow. A job that asked for no tools had sixteen,
 *  and ToolSearch is the worst of them: its whole purpose is to fetch the
 *  schemas of tools that were deferred, which re-opens the set this flag just
 *  closed. With the names below the same probe reports zero tools.
 *
 *  Names the CLI does not know are IGNORED, so the retired spellings stay:
 *  being complete costs nothing and falling behind costs a run.
 *
 *  worker/jobs/tts-lib.mjs re-exports this name for the callers that always
 *  imported it from there; it is a forward, never a copy. */
export const DENIABLE_TOOLS = Object.freeze([
  "Task", "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate",
  "Bash", "BashOutput", "KillShell", "KillBash", "Glob", "Grep", "Read", "Edit",
  "MultiEdit", "Write", "NotebookRead", "NotebookEdit", "WebFetch", "WebSearch",
  "TodoWrite", "SlashCommand", "Skill", "ExitPlanMode", "AskUserQuestion",
  "ToolSearch", "Workflow", "ListAgents", "ReportFindings", "ScheduleWakeup",
  "SendMessage", "EnterWorktree", "ExitWorktree", "DesignSync",
  "CronCreate", "CronDelete", "CronList",
  "ListMcpResourcesTool", "ReadMcpResourceTool",
]);

const DEFAULT_MAX_PARALLEL = 2;
const TESTS_MIN_FREE_MB = 2048;
const SEMAPHORE_RETRY_MS = 5000;
const LOCK_STALE_MS = 30_000;
const DEFAULT_CLAUDE_CONFIG_DIR = "/root/.claude-accounts/active";
// What an in-process caller's child may print before the call gives up on it.
// runClaude's execFileSync used the same number.
const SYNC_MAX_BUFFER = 32 * 1024 * 1024;
// How often the launcher looks for a run's processes after its CLI exits.
const SURVIVOR_POLL_MS = 500;

/**
 * Every refusal and every failure before the child exits. The command line
 * turns one into a line of stderr and its exit code; an in-process caller
 * catches it. Nothing in this file calls process.exit outside main(), because
 * the cron jobs and the test suite call it in their own process.
 *
 * `reason` is "busy" when a caller's slot wait ran out, so a caller with a
 * fallback can tell a full box from a broken one. `runToken` is set when the
 * envelope was already spooled, so a caller can still name the run.
 */
export class BoxRunError extends Error {
  constructor(message, exitCode = 2, reason = null) {
    super(message);
    this.name = "BoxRunError";
    this.exitCode = exitCode;
    this.reason = reason;
    this.runToken = null;
  }
}

function fail(message, code = 2, reason = null) {
  throw new BoxRunError(message, code, reason);
}

function note(message) {
  // A PROGRESS LINE MUST NOT BE ABLE TO KILL THE RUN. guardStderr says how a
  // failed write gets here; the catch is for the other shape, a pipe whose
  // reader is gone, which throws EPIPE at the call.
  try {
    process.stderr.write(`box-run: ${message}\n`);
  } catch {}
}

// ENOSPC ON OUR OWN STDERR IS NOT A REASON TO DIE. On the box a run's stderr is
// a file, and a file stream reports a failed write as an 'error' event on the
// next tick rather than as a throw the writer can catch — with no listener on
// it that is an uncaught exception. On 2026-09-22 the box filled, a run died
// exactly there, between its last progress line and the reap that would have
// freed 1.1 GB, and the disk never came back. Installed from prepareRun, the
// one funnel every run goes through, so the command line, a job's boxRunSync
// and the daemon's runner steps are all covered by the same line.
let stderrGuarded = false;
function guardStderr() {
  if (stderrGuarded) return;
  stderrGuarded = true;
  process.stderr.on("error", () => {});
}

// This file runs here in a checkout (worker/runs/) and flat at /opt/tts/runs/.
// `../session-host/` resolves to the installed daemon modules in BOTH layouts,
// so one relative candidate is correct; the absolute one is the fallback for a
// half-installed box, where a missing redactor must fail loudly rather than
// let unredacted bytes reach stdout.
function moduleUrl(relative, installed) {
  const candidates = [new URL(relative, import.meta.url), new URL(`file://${installed}`)];
  const found = candidates.find((candidate) => candidate.protocol === "file:" && fs.existsSync(fileURLToPath(candidate)));
  if (!found) throw new Error(`box-run: ${relative} is not installed`);
  return found.href;
}

const { redactSecrets } = await import(moduleUrl("../session-host/redact.mjs", "/opt/tts/session-host/redact.mjs"));
const { scrubbedEnv } = await import(moduleUrl("../session-host/env-scrub.mjs", "/opt/tts/session-host/env-scrub.mjs"));

function parseArgs(argv) {
  const opts = {
    cli: "claude",
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
    timeoutMs: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case "--cli": opts.cli = next(); break;
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
      case "--timeout": opts.timeoutMs = Number(next()); break;
      // REMOVAL CHECK: Tom asked for it (2026-09-21). tts-run is reached by its
      // PATH name, and without this the flags are written only in this file.
      case "--help": return { help: true };
      default: fail(`unknown option ${arg}`);
    }
  }
  // THE COMMAND LINE'S OWN DEFAULTS, and only the command line's. A run a
  // session sends here gets the box run's tool set and edits without asking;
  // an in-process caller that names nothing gets nothing added, which is what
  // runClaude always handed the CLI.
  if (opts.cli === "claude") {
    opts.allowedTools = [...TOOLS_ALLOWED];
    opts.deniedTools = [...BANNED_TOOLS];
    opts.permissionMode = "acceptEdits";
  }
  return opts;
}

/**
 * The options a run is performed with, checked and completed. Both entries
 * take this, so a flag on the command line and the same option in process
 * are refused or honoured alike.
 */
function normalize(input) {
  const opts = {
    cli: "claude", repo: REPO_NONE, ref: null, cwd: null, model: null, effort: null, sandbox: null, schema: null,
    outputFormat: "text", tests: false, install: false, parent: null, root: null, depth: null,
    keepWorktree: false, timeoutMs: 0, registration: null, slotWaitMs: undefined, env: process.env,
    ...Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined)),
  };
  opts.depth = opts.depth ?? null;
  if (typeof opts.prompt !== "string" || !opts.prompt.trim()) fail("no prompt on stdin");
  if (opts.cli !== "claude" && opts.cli !== "codex") fail("--cli must be claude or codex");
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
  // The same rule for a directory the caller owns: a worktree and a caller's
  // directory are two answers to one question, and either would silently lose.
  if (opts.cwd !== null) {
    if (opts.repo !== REPO_NONE) fail("--cwd names the directory itself; it cannot be given with a --repo");
    if (typeof opts.cwd !== "string" || !path.isAbsolute(opts.cwd)) fail("--cwd must be an absolute directory");
    let isDir = false;
    try { isDir = fs.statSync(opts.cwd).isDirectory(); } catch {}
    if (!isDir) fail(`--cwd ${opts.cwd} is not a directory`);
  }
  // REMOVAL CHECK on both range tests: the record cannot refuse what never
  // reaches it. `--timeout` is read HERE and nowhere else — it arms the kill
  // timer below, whose `opts.timeoutMs > 0` is false for NaN, so `--timeout abc`
  // without this line means a caller asked for a hard limit and silently got
  // none. `--depth` does reach the record, as JSON, where a NaN serialises to
  // null: convex/runs.ts then refuses the payload with a 400 and dead-letters
  // it AFTER the run has spent its model calls, which is the trade the
  // `--root and --depth` refusal below already argues one line of stderr beats.
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0) fail("--timeout must be a number of milliseconds, or 0 for no limit");
  if (opts.depth !== null && (!Number.isInteger(opts.depth) || opts.depth < 0)) fail("--depth must be a whole number");
  if (opts.maxTurns !== undefined && (!Number.isInteger(opts.maxTurns) || opts.maxTurns < 1)) fail("--max-turns must be a whole number of turns");
  if (opts.slotWaitMs !== undefined && (!Number.isFinite(opts.slotWaitMs) || opts.slotWaitMs < 0)) fail("slotWaitMs must be a number of milliseconds");
  if (opts.outputFormat !== "text" && opts.outputFormat !== "json") fail("--output-format must be text or json");
  for (const key of ["allowedTools", "deniedTools"]) {
    const list = opts[key];
    if (list !== undefined && (!Array.isArray(list) || list.some((tool) => typeof tool !== "string" || tool === ""))) {
      fail(`${key} must be an array of non-empty strings`);
    }
  }
  // THE CLAUDE-ONLY FLAGS ARE REFUSED FOR CODEX, not dropped: tts-codex has
  // no door for a tool list, a permission mode or a turn cap, and a caller who
  // named one would otherwise believe the run was bounded by it.
  if (opts.cli === "codex") {
    const named = ["allowedTools", "deniedTools", "permissionMode", "maxTurns"].filter((key) => opts[key] !== undefined);
    if (named.length > 0 || opts.outputFormat !== "text") fail(`a Codex run takes no ${named[0] ?? "outputFormat"}; those flags are claude only`);
    // ONE RUN, ONE AUTHOR OF ITS ENVELOPE — see the registration block below.
    if (opts.registration) fail("a Codex run registers itself through codex-run.mjs; pass no registration");
  }
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
  if (opts.sessionId !== undefined && opts.sessionId !== null) {
    if (opts.cli !== "claude") fail("a session id is a Claude run's; Codex takes none");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(opts.sessionId))) fail("sessionId must be a UUID");
  }
  // The model default depends on the CLI, so it cannot be a constant above.
  // gpt-5.6-sol IS THE FLEET DEFAULT and the only right answer here: it is
  // scripts/codex-run.mjs's DEFAULT_MODEL, so the two ways of reaching Codex
  // agree, and a box run is a run of its own rather than a Codex child (a
  // child is the one thing named gpt-5.6-terra). Naming terra here also made
  // .claude/agents/codex.md's "the defaults are already the strongest model"
  // false for every run that went through the box, which is now all of them.
  if (!opts.model) opts.model = opts.cli === "codex" ? "gpt-5.6-sol" : "opus";
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

/**
 * The command line `claude -p` is given, as data.
 *
 * SPLIT OUT SO IT CAN BE READ WITHOUT BEING RUN. What the flags come to is the
 * whole of what a caller's tool and turn settings mean, and inside a run the
 * only way to see them was to spawn a child and watch what it did — which is
 * no way to find out that a job asking for no tools was being handed sixteen.
 * Every argument is decided here and nothing here touches the process, the
 * environment or the registration. A setting the caller left out is left out
 * of the command line: the defaults are the caller's (parseArgs has the
 * command line's), never this function's.
 */
export function claudeArgs({ model, outputFormat = "text", maxTurns, allowedTools, deniedTools, permissionMode, sessionId } = {}) {
  const args = ["-p", "--output-format", outputFormat];
  // A caller that must know the run's id before it starts names the session
  // id itself: a runner step's id is minted at its claim, so the next step's
  // continuesRunId can name it exactly (convex/ttsRunners.ts). In process only.
  if (sessionId) args.push("--session-id", sessionId);
  // THE CLI HONOURS --max-turns. `claude --help` does not list it, which is
  // what this file's older comment went by, but a job run on the box that ran
  // out of turns comes back as an `error_max_turns` result envelope, and the
  // audit fallback died at eight turns before audit.mjs gave it forty — both
  // observed on the box. It is passed only when a caller names a budget; the
  // command line names none by default, so a session's box run is bounded by
  // the model's own stop and by --timeout, as before.
  if (maxTurns !== undefined) args.push("--max-turns", String(maxTurns));
  if (model) args.push("--model", model);
  if (permissionMode) args.push("--permission-mode", permissionMode);
  // normalize() has already refused a malformed list; this is its one check.
  if (allowedTools !== undefined) args.push("--allowedTools", allowedTools.join(","));
  // AN EMPTY LIST MEANS NO TOOLS, AND THE ALLOW-LIST ALONE DOES NOT SAY SO.
  // `--allowedTools` pre-approves; it does not withhold, and the default
  // permission mode hands the model its read tools without asking either way.
  // The flag that withholds names its tools, so an empty allow-list has to
  // name them — DENIABLE_TOOLS is that spelling and the only reason it exists.
  const denied = [...(deniedTools ?? []), ...(Array.isArray(allowedTools) && allowedTools.length === 0 ? DENIABLE_TOOLS : [])];
  if (denied.length > 0) args.push("--disallowedTools", [...new Set(denied)].join(","));
  return args;
}

/**
 * The `--output-format json` result envelope out of whatever the CLI printed,
 * or null when it printed something else (or nothing).
 *
 * ONE READER FOR BOTH ENDS. A run that succeeds prints the envelope on stdout;
 * a run that fails prints it too and then exits non-zero. Reading it in two
 * places is how the failing end came to read it in none.
 */
export function resultEnvelopeOf(stdout) {
  if (typeof stdout !== "string" || stdout.trim() === "") return null;
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (error) {
    // Not the JSON envelope. Anything other than bad JSON is a real fault.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return envelope && typeof envelope === "object" && envelope.type === "result" ? envelope : null;
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
    fail(`refused — free memory is ${availableMb} MB, a test run needs ${TESTS_MIN_FREE_MB} MB; nothing was started`, 75);
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
 * waiting by default: a queued run is a working run.
 *
 * `waitMs` is the one exception, for a caller that is standing still with a
 * fallback of its own — a runner step (worker/session-host/runner-step.mjs).
 * Past it the wait ends in a BoxRunError whose reason is "busy".
 *
 * Returns a release function. Every exit path must call it.
 */
function takeSlot({ id, counterFile, lockFile, limit, sleepMs = SEMAPHORE_RETRY_MS, announce = note, waitMs }) {
  let announced = false;
  const started = Date.now();
  for (;;) {
    let busy = 0;
    const taken = withLock(lockFile, () => {
      const holders = readCounter(counterFile).filter((holder) => alive(holder?.pid));
      if (holders.length < limit) {
        writeCounter(counterFile, [...holders, { id, pid: process.pid, at: Date.now() }]);
        return true;
      }
      writeCounter(counterFile, holders);
      busy = holders.length;
      if (!announced) {
        // THE FIRST REFUSAL ONLY. A line every five seconds would bury the
        // report the laptop agent is waiting to relay.
        announce(`queued behind ${holders.length} (limit ${limit})`);
        announced = true;
      }
      return false;
    });
    if (taken) break;
    if (waitMs !== undefined && Date.now() - started >= waitMs) {
      fail(`the box is busy: ${busy} runs hold all ${limit} slots, and this caller waits ${waitMs} ms at most; nothing was started`, 75, "busy");
    }
    sleep(waitMs === undefined ? sleepMs : Math.max(1, Math.min(sleepMs, waitMs - (Date.now() - started))));
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

function gitOrFail(args, what, { cwd, env } = {}) {
  const result = git(args, { cwd, env });
  if (result.status !== 0) {
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
  } else {
    if (git(["-C", mirror, "remote", "update"], { env: gitEnv }).status !== 0) {
      // A stale mirror is still a usable mirror when the ref is already in it.
      // Refusing here would turn a network blip into a refused run.
      note(`could not update the ${repo} mirror; using what is already there`);
    }
    pruneMirror(mirror, gitEnv);
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
  // `remote update` still mirrors everything IN; only the push side
  // goes back to git's ordinary fast-forward-only behaviour. It runs on every
  // call rather than only after a clone, because the box already holds mirrors
  // cloned before this line existed. `--unset` exits 5 on a key that is not
  // there, which is why it is not gitOrFail.
  git(["-C", mirror, "config", "--unset", "remote.origin.mirror"], { env: gitEnv });
  return mirror;
}

/**
 * Delete the mirror's refs GitHub no longer has, except a branch a live
 * worktree has checked out.
 *
 * A RUN'S BRANCH LIVES IN THIS MIRROR, NOT IN ITS WORKTREE. A worktree shares
 * the mirror's refs, so a branch a run makes and has not pushed yet is a ref
 * here that GitHub does not have, and `remote update --prune` deleted it on
 * the next run's refresh. The run's HEAD then named a branch that no longer
 * existed, and its next commit started a new history without the earlier ones
 * (run 96feb5c4, 2026-09-18). So the prune is done by hand: git's own dry run
 * names what it would delete, and every branch a worktree names is kept.
 * A kept branch is the run's to push; the reap removes its worktree, and the
 * next refresh prunes the branch then if GitHub never got it.
 *
 * REMOVAL CHECK on pruning at all: resolveRef answers `--ref NAME` from this
 * mirror's refs/heads, so without a prune a branch deleted on GitHub (every
 * squash-merged one) would still resolve here, to its old commit, and a run
 * would work on a stale tree instead of being refused.
 */
function pruneMirror(mirror, env) {
  const dryRun = git(["-C", mirror, "remote", "prune", "--dry-run", "origin"], { env });
  if (dryRun.status !== 0) return;
  const checkedOut = new Set(
    String(git(["-C", mirror, "worktree", "list", "--porcelain"], { env }).stdout ?? "")
      .split("\n")
      .filter((line) => line.startsWith("branch "))
      .map((line) => line.slice("branch ".length).trim()),
  );
  for (const line of String(dryRun.stdout ?? "").split("\n")) {
    const ref = /\[would prune\]\s+(refs\/\S+)/.exec(line)?.[1];
    if (!ref) continue;
    if (checkedOut.has(ref)) {
      note(`kept ${ref}: a live worktree has it checked out`);
      continue;
    }
    git(["-C", mirror, "update-ref", "-d", ref], { env });
  }
}

function resolveRef(mirror, ref, env) {
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
// The run itself: prepare, spawn, finish. Everything above is testable in
// isolation. prepareRun and finishRun are the one body; boxRun (the command
// line's) and boxRunSync (runClaude's) differ in how they wait for the child
// and in the slot: boxRun queues for one, boxRunSync takes none.
// ---------------------------------------------------------------------------

/**
 * The command line's slot: queue on the semaphore, return the release.
 *
 * A RUN INSIDE A RUN TAKES NO SECOND SLOT, and without this rule the transport
 * deadlocks on its ordinary path. A box run holds its slot for the whole life
 * of its CLI child; that child has Task, a tom.quest worktree, and agent files
 * that now send `box` and `codex` through scripts/box-agent.mjs, which on the
 * box runs tts-run right here. So the child asks for a slot its own parent is
 * still holding. At the default limit of 2, two box runs that each delegate —
 * which "mechanical work runs on Codex" makes the normal thing, not the exotic
 * one — leave both children queued behind two live parents for ever, and the
 * relay is told `queued behind` is not an error. At limit 1 a single run that
 * asks Codex anything hangs itself.
 *
 * The semaphore counts the WORK THE BOX IS ASKED FOR, which is what it was
 * sized for: one full test suite is about 1.6 GB and the box holds two of
 * those. A subagent inside a run is part of that run's budget, not a new
 * one, and the run above it is the thing that has to finish before the slot
 * comes back. TTS_RUN_SLOT_HELD is set on every child this file spawns, so
 * the whole subtree under one slot inherits it however deep the delegation
 * goes.
 */
function queueForSlot({ id, opts, env, config }) {
  if (env.TTS_RUN_SLOT_HELD === "1") {
    note("running under the parent run's slot; not queueing");
    return () => {};
  }
  return takeSlot({
    id,
    counterFile: path.join(config.stateDir, "semaphore.json"),
    lockFile: path.join(config.stateDir, "semaphore.lock"),
    limit: Number.isInteger(config.maxParallel) && config.maxParallel > 0 ? config.maxParallel : DEFAULT_MAX_PARALLEL,
    waitMs: opts.slotWaitMs,
    // REMOVAL CHECK on RUN_SEMAPHORE_RETRY_MS: the queue's proof is that a
    // second run waits and then goes, and at the real retry interval that test
    // would take the interval itself to run, once per case, for ever. The seam
    // shortens the sleep and nothing else — the limit, the slot file and the
    // stale reclaim are untouched — so what the test exercises is the same code
    // a run takes. Deleting it leaves the queue with no test.
    sleepMs: Number(env.RUN_SEMAPHORE_RETRY_MS) > 0 ? Number(env.RUN_SEMAPHORE_RETRY_MS) : SEMAPHORE_RETRY_MS,
  });
}

/**
 * A job's slot: none. A JOB'S MODEL CALL (boxRunSync, through runClaude)
 * TAKES NO SLOT, because the semaphore cannot simply apply to everything: it
 * deadlocked the box on 2026-09-19. Two box runs, each holding one of the two
 * slots, sat waiting for their pull requests' evals; the evals `--serve` pass
 * makes its model calls through this path, so it queued for a slot behind the
 * very runs waiting on its answer, and nobody finished. The same wait sits
 * under every job whose output a run might be waiting on. A job needs no slot
 * for its own protection either: each cron line runs under `flock -n` and the
 * evals pass under its own lock (worker/jobs/evals-lock.mjs), so a job cannot
 * pile up on itself, and its call is one short model turn, not the test suite
 * the slots were sized for.
 */
function noSlot() {
  return () => {};
}

/**
 * Everything before the child starts: the memory guard, the slot (`slot`, the
 * entry's way of getting one), the work directory, the registration envelope
 * and the command line. Returns a handle the spawn and finishRun take. On a
 * throw, whatever was taken is given back.
 */
function prepareRun(options, slot = noSlot) {
  const opts = normalize(options);
  const env = opts.env;

  // BEFORE ANYTHING ELSE: a run that cannot report must still be able to reap.
  guardStderr();

  // BEFORE THE SEMAPHORE AND BEFORE ANY WORK: a refused run must start nothing,
  // take no slot, and clone nothing.
  refuseIfMemoryIsShort(opts, env);

  const config = runConfig({ env });
  const stateDir = config.stateDir;
  const pnpmStore = path.join(path.dirname(stateDir), "pnpm-store");

  const id = crypto.randomUUID().slice(0, 8);
  const workDir = path.join(stateDir, "work", id);
  const release = slot({ id, opts, env, config });

  let mirror = null;
  let checkout = null;
  let reaped = false;
  const reap = () => {
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
  };
  // The command line reaps on a signal; it has to know the reap as soon as
  // there is something to reap.
  opts.onReap?.(reap);

  let spooled = null;
  try {
    let cwd;
    fs.mkdirSync(workDir, { recursive: true });
    if (opts.cwd !== null) {
      // A DIRECTORY THE CALLER OWNS is used as it is and never reaped: the
      // delegate's WikiTom worktree, the CMT cache clone, a job's tmpdir. Only
      // the work directory with the child's stderr log is this run's.
      cwd = opts.cwd;
    } else if (opts.repo === REPO_NONE) {
      cwd = path.join(workDir, "ws");
      fs.mkdirSync(cwd, { recursive: true });
    } else {
      mirror = ensureMirror(opts.repo, path.join(stateDir, "repos"), env);
      const sha = resolveRef(mirror, opts.ref, env);
      checkout = path.join(workDir, opts.repo);
      gitOrFail(["-C", mirror, "worktree", "add", "--detach", checkout, sha], `could not make a worktree at ${sha}`, {
        env: { ...env, GIT_LFS_SKIP_SMUDGE: "1" },
      });
      cwd = checkout;
      if (opts.install) {
        const pnpm = pnpmBinary(env);
        if (!pnpm) fail("pnpm is not installed on the box");
        note(`pnpm install in ${opts.repo}`);
        const installed = spawnSync(pnpm, ["install", "--frozen-lockfile", "--store-dir", pnpmStore], {
          cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32",
        });
        if (installed.status !== 0) {
          process.stderr.write(`${String(installed.stderr ?? "").trim().split("\n").slice(-10).join("\n")}\n`);
          fail("pnpm install failed in the worktree");
        }
      }
    }

    // REGISTRATION IS WRITTEN BEFORE THE CHILD CAN START, so the record holds
    // the envelope even when the run dies in its first turn. The envelope is
    // the caller's — the command line's is sessionRegistration below, a job's
    // is composed by runClaude — and this file is always its writer, which is
    // what the record takes as the run's launcher (registration.mjs). A caller
    // that named no directory gets the one the run actually ran in.
    //
    // ONE RUN, ONE AUTHOR OF ITS ENVELOPE. scripts/codex-run.mjs registers the
    // run it starts itself — its own prompt hash, its own skills, its own graph
    // version — under a token it mints, and it never reads TTS_RUN_REG_TOKEN.
    // So for the Codex runner a second envelope written here is an orphan:
    // codex-run's is the one the sweep claims, this one is never claimed, and
    // the spool holds it until cleanup deletes it. Worse, the parent went with
    // it — the run landed as an unparented `job` and the tree edge this whole
    // transport exists to record was lost. normalize() therefore refuses a
    // registration for Codex, and this hands over the one fact codex-run
    // cannot know: the parent, below.
    const spoolDir = env.TTS_RUN_REG_SPOOL || path.join(stateDir, "registration");
    if (opts.registration) {
      spooled = writeRegistration({
        spoolDir,
        writer: { file: "worker/runs/box-run.mjs", job: "box-run" },
        registration: { cwd, ...opts.registration },
      });
    }

    const namedEnvironment = namedEnvironmentOf(env);
    const childEnv = {
      ...scrubbedEnv({ keepTtsKey: true, source: env }),
      CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR || DEFAULT_CLAUDE_CONFIG_DIR,
      WIKITOM_DIR: env.WIKITOM_DIR || "/root/wikitom",
      ...(spooled ? { TTS_RUN_REG_TOKEN: spooled.token } : {}),
      TTS_RUN_REG_SPOOL: spoolDir,
      RUN_HOST: "box",
      GIT_LFS_SKIP_SMUDGE: "1",
      // THE SLOT THIS RUN HOLDS COVERS EVERYTHING UNDER IT. See the semaphore
      // block above: a `box` or `codex` subagent inside this child reaches
      // box-run.mjs again through scripts/box-agent.mjs, and asking for a second
      // slot while its own parent holds one is the deadlock. Inherited, not
      // recomputed, so it survives however many levels the delegation goes.
      TTS_RUN_SLOT_HELD: "1",
      // Every process under this run inherits this, whatever session or
      // process group it moves to; survivorsOf reads it back.
      TTS_BOX_RUN_ID: id,
    };
    // A token the caller's own process was started under is not this child's.
    if (!spooled) delete childEnv.TTS_RUN_REG_TOKEN;
    // THE PARENT GOES TO WHICHEVER WRITER OWNS THE ENVELOPE, and never to both.
    // For Claude the envelope above already carries it, so the variable is
    // cleared: two writers for one field is the bug registration.mjs's header
    // warns about. For Codex there is no envelope from here at all, and this
    // variable is the only way the edge reaches codex-run.mjs's own — it is
    // what turns that run from an unparented `job` into a `codex-child` under
    // the session that asked for it. mergeRegistration fills the root and the
    // depth from the parent when the launcher names neither, which is this case.
    if (opts.cli === "codex" && opts.parent) childEnv.TTS_RUN_PARENT_RUN_ID = opts.parent;
    else delete childEnv.TTS_RUN_PARENT_RUN_ID;
    // The environment follows the same one-writer rule: codex-run.mjs names it
    // in the only Codex envelope, so only the Codex child is told.
    if (opts.cli === "codex" && namedEnvironment) childEnv.TTS_RUN_ENVIRONMENT = namedEnvironment;
    else delete childEnv.TTS_RUN_ENVIRONMENT;
    // THE RUNNER KEY REACHES A RUNNER STEP'S PROCESS AND NOTHING ELSE. The scrub
    // above removed it; it goes back only when this run's own envelope is a
    // runner step's (runner-step.mjs's stepRegistration), which no command line
    // can ask for: a subagent the step spawns through box-run registers as a
    // `subagent` under its own envelope, and a Codex run carries no envelope
    // from here, so neither gets it back. Keyed on the registration, not on
    // TTS_RUN_ENVIRONMENT, which a model can export and which only Codex
    // children are told. What the step's own shell runs inherits it, and
    // tts-turing-act is what spends it.
    if (isRunnerStep(opts.registration) && env.TURING_RUNNER_KEY) childEnv.TURING_RUNNER_KEY = env.TURING_RUNNER_KEY;
    else delete childEnv.TURING_RUNNER_KEY;

    let bin;
    let args;
    if (opts.cli === "codex") {
      // A CODEX WEEKLY-CAP ERROR IS A LEGITIMATE OUTCOME, not a transport
      // failure: tts-codex's own message and exit code come back unaltered.
      bin = codexBinary(env);
      args = ["--cwd", cwd, "--model", opts.model];
      if (opts.effort) args.push("--effort", opts.effort);
      if (opts.sandbox) args.push("--sandbox", opts.sandbox);
      if (opts.schema) args.push("--schema", opts.schema);
      if (opts.timeoutMs > 0) args.push("--timeout", String(opts.timeoutMs));
    } else {
      bin = claudeBinary(env);
      args = claudeArgs(opts);
    }

    const useShell = process.platform === "win32" && bin.toLowerCase().endsWith(".cmd");
    const quote = (s) => (useShell ? `"${String(s).replace(/\\(?=")/g, "\\\\").replace(/"/g, '""')}"` : s);
    return {
      id, opts, cwd, workDir, reap, spooled,
      errLog: path.join(workDir, "stderr.log"),
      configDir: childEnv.CLAUDE_CONFIG_DIR,
      command: useShell ? quote(bin) : bin,
      args: args.map(quote),
      spawnOptions: { cwd, env: childEnv, shell: useShell, windowsHide: true },
    };
  } catch (error) {
    reap();
    if (error instanceof BoxRunError && spooled) error.runToken = spooled.token;
    if (error instanceof BoxRunError) throw error;
    const wrapped = new BoxRunError(error?.message ?? String(error));
    if (spooled) wrapped.runToken = spooled.token;
    throw wrapped;
  }
}

/** A runner step's own envelope: the one run that holds the runner key. */
function isRunnerStep(registration) {
  return registration?.environment === "runner" && registration?.kind === "runner-step";
}

function namedEnvironmentOf(env) {
  return ["session", "worker", "runner"].includes(env.TTS_RUN_ENVIRONMENT) ? env.TTS_RUN_ENVIRONMENT : null;
}

/**
 * After the child: the answer, the claim, the reap. `stdout` is everything the
 * child printed; with --output-format json the answer is the envelope's
 * `result`, and the envelope itself comes back for a caller that reads its
 * subtype.
 */
function finishRun(run, { stdout, code, signal, timedOut, survivors = [] }) {
  // THE REAP IS THE FINALLY, not a line near the end. Everything between here
  // and the return reads a file, parses an envelope or writes a note, and any
  // of them can throw — a full disk throws in all three. This function runs
  // inside a stream callback, so a throw that escapes it is an uncaught
  // exception that takes the process down with the worktree still on disk.
  try {
    return finishedResult(run, { stdout, code, signal, timedOut, survivors });
  } finally {
    run.reap();
  }
}

function finishedResult(run, { stdout, code, signal, timedOut, survivors }) {
  const { opts } = run;
  const envelope = opts.outputFormat === "json" ? resultEnvelopeOf(stdout) : null;
  const text = typeof envelope?.result === "string" ? envelope.result : stdout;
  // THE CLAIM IS MADE WHERE THE CHILD RAN. The run file lives under the config
  // directory the child was actually given, keyed by its cwd, so this is the
  // one place both are known; a caller that guessed the directory would claim
  // a file under another account slot.
  if (run.spooled && typeof envelope?.session_id === "string" && envelope.session_id) {
    const project = path.resolve(run.cwd).replaceAll("\\", "-").replaceAll("/", "-").replaceAll(":", "-");
    const runFile = path.join(run.configDir, "projects", project, `${envelope.session_id}.jsonl`);
    try {
      claimRegistration({
        spoolDir: path.dirname(run.spooled.file),
        token: run.spooled.token,
        runFile,
        claim: { by: "launcher:box-run", threadId: envelope.session_id, runFile, hookPayloadKeys: [] },
      });
    } catch (error) {
      // REMOVAL CHECK: the SessionStart hook claims the same envelope, and this
      // claim stays because for a Claude run nothing else claims a spool when
      // the hook does not (its five-second timeout, a slot without the hook).
      // claimRegistration is idempotent on the token, so the second claim costs
      // nothing. A claim that fails here leaves it to the hook and never loses
      // the answer.
      note(`could not claim the envelope: ${error?.message ?? error}`);
    }
  }
  // THE TAIL, NOT THE PATH. The reap deletes the work directory, so naming the
  // log file would hand the caller an address that no longer resolves — and the
  // one case this matters most is the one where the CLI wrote no answer at all,
  // which is exactly where a Codex weekly-cap message lives. --keep-worktree is
  // what keeps the whole log.
  let stderrTail = "";
  if (code !== 0 || timedOut) {
    try { stderrTail = redactSecrets(fs.readFileSync(run.errLog, "utf8")).trim().split("\n").slice(-5).join("\n"); } catch {}
  }
  return {
    id: run.id,
    seconds: Math.round((Date.now() - run.startedAt) / 1000),
    text,
    // Work killed at the time limit is a timeout, whether the CLI or a process
    // it left running was still going.
    exitCode: timedOut || survivors.length > 0 ? 124 : (code ?? 1),
    signal: signal ?? null,
    timedOut: timedOut || survivors.length > 0,
    envelope,
    runToken: run.spooled?.token ?? null,
    stderrTail,
    survivors,
    workDir: run.workDir,
    errLog: run.errLog,
  };
}

/**
 * The processes still alive that this run started, found by the TTS_BOX_RUN_ID
 * every one of them inherited: [{ pid, command }].
 *
 * A BOX RUN'S WORK CAN OUTLIVE ITS CLI. A model that starts a command in the
 * background and then ends its turn ends the CLI while the command runs on;
 * the launcher used to reap the worktree under it at once, and the run's
 * report was the model's last line, "waiting" (runs 0ea27b8e, 17aa7df2 and
 * 02839c97 on 2026-09-19). The environment, not the process group, is the
 * test, because a CLI's shell may start its own session and an orphan's
 * parent becomes init, while the environment goes with every descendant.
 * Linux only, through /proc; elsewhere nothing is found and nothing waits.
 */
function survivorsOf(id, { procDir = "/proc" } = {}) {
  if (process.platform !== "linux") return [];
  const marker = `TTS_BOX_RUN_ID=${id}`;
  const found = [];
  let entries = [];
  try { entries = fs.readdirSync(procDir); } catch { return []; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      if (!fs.readFileSync(path.join(procDir, entry, "environ"), "latin1").split("\0").includes(marker)) continue;
      const command = fs.readFileSync(path.join(procDir, entry, "cmdline"), "utf8").split("\0").filter(Boolean).join(" ");
      found.push({ pid: Number(entry), command: command.slice(0, 200) });
    } catch {
      // A process that exited between the listing and the read is not a survivor.
    }
  }
  return found;
}

/** How long the launcher may wait for survivors: the rest of the run's
 *  --timeout, or without limit when none was given (no limit by default, the
 *  2026-09-09 ruling); nothing after a timeout, which is a hard kill. */
function survivorBudget(run, timedOut) {
  if (timedOut) return 0;
  if (!(run.opts.timeoutMs > 0)) return Infinity;
  return Math.max(0, run.opts.timeoutMs - (Date.now() - run.startedAt));
}

/** Kill what outlived the wait, and say on stderr what the wait was. The
 *  kill rescans until nothing tagged is left, because a survivor can fork
 *  between one scan and its kill, and that child would outlive the reap. */
function settleSurvivors(run, waitedMs, left) {
  if (waitedMs > 0) note(`waited ${Math.round(waitedMs / 1000)}s after the CLI exited for the processes it started`);
  const killed = new Map();
  for (let round = 0; left.length > 0 && round < 50; round += 1) {
    for (const survivor of left) {
      killed.set(survivor.pid, survivor);
      try { process.kill(survivor.pid, "SIGKILL"); } catch {}
    }
    sleep(20);
    left = survivorsOf(run.id);
  }
  if (left.length > 0) note(`${left.length} process(es) of this run would not die: ${left.map((survivor) => survivor.pid).join(", ")}`);
  return [...killed.values()];
}

async function waitForSurvivors(run, timedOut) {
  const budget = survivorBudget(run, timedOut);
  const started = Date.now();
  let left = survivorsOf(run.id);
  while (left.length > 0 && Date.now() - started < budget) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(SURVIVOR_POLL_MS, budget - (Date.now() - started))));
    left = survivorsOf(run.id);
  }
  return settleSurvivors(run, Date.now() - started, left);
}

function waitForSurvivorsSync(run, timedOut) {
  const budget = survivorBudget(run, timedOut);
  const started = Date.now();
  let left = survivorsOf(run.id);
  while (left.length > 0 && Date.now() - started < budget) {
    sleep(Math.min(SURVIVOR_POLL_MS, budget - (Date.now() - started)));
    left = survivorsOf(run.id);
  }
  return settleSurvivors(run, Date.now() - started, left);
}

/**
 * Perform one run and wait for it without blocking the event loop. This is the
 * command line's entry; it streams nothing, so its answer and main()'s output
 * are the same bytes they always were.
 *
 * Takes: prompt, cli, model, effort, sandbox, schema, cwd or repo/ref,
 * allowedTools, deniedTools, permissionMode, maxTurns, timeoutMs, outputFormat,
 * registration (an envelope object, or null for none), slotWaitMs, sessionId
 * (claude only: the CLI session id to start the run under), beforeSpawn
 * (async ({ cwd, prompt }) -> the prompt to send),
 * tests/install, parent/root/depth, keepWorktree, env (default process.env),
 * onReap (handed the reap as soon as there is one).
 *
 * Returns { text, exitCode, envelope, runToken, ... }. Throws a BoxRunError
 * for everything that happens before the child exits.
 */
export async function boxRun(options) {
  const run = prepareRun(options, queueForSlot);
  // A caller's last word on the prompt, once the checkout exists and before
  // the child starts: a runner step's sensor reads the experiment in the
  // step's own worktree and writes its facts into the prompt here, so the
  // model sees them before it sees anything else (worker/runs/runner-sensor.mjs).
  // In process only; the command line has no such door.
  if (typeof options?.beforeSpawn === "function") {
    try {
      const prompt = await options.beforeSpawn({ cwd: run.cwd, prompt: run.opts.prompt });
      if (typeof prompt === "string" && prompt.trim()) run.opts.prompt = prompt;
    } catch (error) {
      run.reap();
      throw Object.assign(new BoxRunError(`the caller's pre-launch step failed: ${error?.message ?? error}`), { runToken: run.spooled?.token ?? null });
    }
  }
  let errStream;
  try {
    fs.mkdirSync(path.dirname(run.errLog), { recursive: true });
    errStream = fs.createWriteStream(run.errLog);
  } catch (error) {
    // A log the run cannot open is the one failure that used to leave the
    // whole checkout behind: these two lines sat outside every try, and on a
    // full disk they are the first thing to throw.
    run.reap();
    throw Object.assign(new BoxRunError(`could not open the run log: ${error?.message ?? error}`), { runToken: run.spooled?.token ?? null });
  }
  // THE LOG IS NOT WORTH THE RUN. Nothing listens for this stream's errors by
  // default, and an unhandled 'error' on a stream is an uncaught exception:
  // one ENOSPC while the child's stderr is piping killed the launcher with its
  // worktree still on disk, so the disk that caused it never came back.
  errStream.on("error", (error) => note(`the run log stopped: ${error?.message ?? error}`));
  let child;
  run.startedAt = Date.now();
  try {
    child = spawn(run.command, run.args, { ...run.spawnOptions, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    errStream.end();
    run.reap();
    throw Object.assign(new BoxRunError(`could not start ${run.command}: ${error.message}`), { runToken: run.spooled?.token ?? null });
  }
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  // THE CHILD'S STDERR NEVER REACHES OUR STDOUT. It carries progress, tool
  // chatter and whatever a failing command printed; the laptop relays stdout
  // whole, so one stray line there becomes a sentence Tom reads as the report.
  child.stderr.pipe(errStream, { end: false });
  child.stdin.on("error", () => {});
  child.stdin.end(run.opts.prompt);

  // REMOVAL CHECK on --timeout: the ruling is that there is no time limit BY
  // DEFAULT, and this flag is off unless a caller names it (timeoutMs is 0,
  // the timer is null, nothing is armed). What it cannot become is nothing at
  // all: a run holds a slot until its CLI child closes, so a child that wedges —
  // waiting on a prompt it will never get, or a command that never returns —
  // holds that slot for ever, and with the subtree rule above it holds it for
  // everything under it too. A caller that knows its work is bounded is the only
  // thing that can free the box short of a human on the box, and the relay is
  // told to pass a `--timeout` straight through when the request names one.
  //
  // REMOVAL CHECK on the win32 branch beside it, and on the `.cmd` branch in the
  // spawn: this file only ever runs on Linux, and its TESTS also run on Tom's
  // Windows laptop. The fake CLI they spawn cannot be a plain script there —
  // Windows has no shebang, so a Node fake is reachable only through a `.cmd`
  // shim, which Node refuses to spawn without a shell. Deleting the branches
  // deletes the suite's ability to run the real file at all, and `child.kill`
  // on Windows leaves the shim's grandchild alive, which is what taskkill /T is
  // for. The production path takes the else in both.
  let timedOut = false;
  const timer = run.opts.timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        else child.kill("SIGKILL");
      }, run.opts.timeoutMs)
    : null;

  return new Promise((resolve, reject) => {
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      errStream.end();
      run.reap();
      reject(Object.assign(new BoxRunError(`could not start ${run.command}: ${error.message}`), { runToken: run.spooled?.token ?? null }));
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      // The log is read back by finishRun, so it has to be flushed first.
      waitForSurvivors(run, timedOut).then((survivors) => {
        errStream.end(() => resolve(finishRun(run, { stdout, code, signal, timedOut, survivors })));
      });
    });
  });
}

/**
 * The same run, waited for synchronously. runClaude has always been a
 * synchronous call whose answer its callers use as a string on the next line,
 * and a job's model call has nothing else to do while it waits; so this is
 * that call's shape, over the same prepareRun and finishRun as boxRun.
 *
 * A timeout here is spawnSync's: the child gets SIGTERM, as execFileSync gave
 * it, and the result says timedOut with exit 124.
 *
 * It takes no slot: noSlot above says why.
 */
export function boxRunSync(options) {
  const run = prepareRun(options);
  run.startedAt = Date.now();
  const result = spawnSync(run.command, run.args, {
    ...run.spawnOptions,
    input: run.opts.prompt,
    encoding: "utf8",
    maxBuffer: SYNC_MAX_BUFFER,
    ...(run.opts.timeoutMs > 0 ? { timeout: run.opts.timeoutMs } : {}),
  });
  try { fs.writeFileSync(run.errLog, result.stderr ?? ""); } catch {}
  const timedOut = result.error?.code === "ETIMEDOUT";
  if (result.error && !timedOut) {
    run.reap();
    throw Object.assign(new BoxRunError(`could not start ${run.command}: ${result.error.message}`), { runToken: run.spooled?.token ?? null });
  }
  const survivors = waitForSurvivorsSync(run, timedOut);
  return finishRun(run, { stdout: result.stdout ?? "", code: result.status, signal: result.signal, timedOut, survivors });
}

/**
 * The envelope of a run a session sent over the transport. The command line's
 * and nobody else's: a job composes its own (runClaude).
 *
 * origin is `session`: `laptop-orchestrator` is not in convex/runs.ts's
 * validOrigin, origin names what STARTED a run — a session did — and
 * host: "box" already records where it ran.
 *
 * kind is `subagent`: it is a run a session spawned by a tool call. Left to the
 * Claude parser, a `-p` run with a user line reads as a session, and a second
 * session in the tree is a false fact.
 *
 * linkKnown is false WITH a parent: convex/runs.ts's validRunPayload refuses a
 * run where linkKnown and a parentRunId meet without a spawnedByToolUseId, and
 * the Bash tool call that launched this run does not expose its id to the
 * command line. An unknown link is recorded unknown.
 *
 * rootRunId and depth travel WITH the parent: a run whose parent nobody has
 * swept yet keeps the root and depth its own sidecar gave it, and a Claude root
 * file parses at depth 0 — which convex/runs.ts refuses against a parent.
 *
 * WHERE THE RUN STARTS is named only for a run nobody launched from a parent:
 * with --parent the record gives the run its parent's environment, and a word
 * here would overrule that with a guess. A launcher that knows better says so
 * in TTS_RUN_ENVIRONMENT, which wins over both.
 */
function sessionRegistration(opts, prompt, env) {
  const namedEnvironment = namedEnvironmentOf(env);
  return {
    host: "box",
    cli: opts.cli,
    origin: "session",
    kind: "subagent",
    ...(namedEnvironment ? { environment: namedEnvironment } : opts.parent ? {} : { environment: "worker" }),
    modelRequested: opts.model ?? "opus",
    ...(opts.effort ? { effortRequested: opts.effort } : {}),
    ...(opts.parent
      ? { parentRunId: opts.parent, rootRunId: opts.root ?? opts.parent, depth: opts.depth ?? 1, linkKnown: false }
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
    tools: { allowed: [...(opts.allowedTools ?? [])], denied: [...(opts.deniedTools ?? [])] },
    hooksConfigured: ["SessionStart", "SessionEnd", "Stop", "SubagentStart", "SubagentStop"],
    promptSha256: crypto.createHash("sha256").update(prompt).digest("hex"),
  };
}

/** The Usage block of this file's header, as `--help` prints it. */
function usage() {
  const header = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
  const start = header.findIndex((line) => line.startsWith("// Usage:"));
  const end = header.findIndex((line, index) => index > start && line.startsWith("//   --help"));
  return `${header.slice(start, end + 1).map((line) => line.replace(/^\/\/ ?/, "")).join("\n")}\n`;
}

/** The command line: flags and stdin in, the report and one status line out. */
async function main() {
  let reap = () => {};
  // REMOVAL CHECK: the slot reclaim covers HALF of what a signalled run leaves,
  // and the other half has no cleanup anywhere. takeSlot filters holders by
  // `alive(holder.pid)`, so a killed run's slot is indeed reclaimed — by the NEXT
  // run, which is soon enough. Its worktree is not: nothing else on the box runs
  // `git worktree remove` or prunes <stateDir>/work/<id>, so without these
  // handlers every Ctrl-C and every `systemctl stop` leaves a full detached
  // checkout of tom.quest or ComplexMultiTrigger on disk for good, and the
  // mirror's worktree list grows an entry per kill. `--keep-worktree` is the way
  // to ask for that deliberately; reap() honours it either way.
  // SIGHUP is on the list because it is the common one on this box: `tts-run`
  // is what the laptop sends over ssh, and a dropped connection hangs up the
  // run rather than interrupting or terminating it.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      reap();
      process.exit(130);
    });
  }
  let opts;
  let result;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      process.stdout.write(usage());
      process.exit(0);
    }
    const prompt = readStdin();
    if (!prompt.trim()) fail("no prompt on stdin");
    result = await boxRun({
      ...opts,
      prompt,
      registration: opts.cli === "codex" ? null : sessionRegistration(opts, prompt, process.env),
      onReap: (fn) => { reap = fn; },
    });
  } catch (error) {
    // boxRun reaps on the failures it can see, but not on one thrown past it —
    // a redactor that will not load, a bug in this file. reap() is idempotent,
    // so calling it here costs nothing and closes the last path out of main()
    // that left a worktree on disk.
    reap();
    note(String(error?.message ?? error));
    process.exit(error instanceof BoxRunError ? error.exitCode : 2);
  }
  // Redaction is a choke point, not a courtesy: the sweep redacts again on
  // every byte that reaches the store, and this is that same function applied
  // before a single byte reaches the laptop's transcript.
  const report = redactSecrets(result.text);
  process.stdout.write(report);
  if (report && !report.endsWith("\n")) process.stdout.write("\n");
  // A PROCESS THE RUN STARTED THAT OUTLIVED ITS TIME LIMIT was killed before
  // the reap, and the report says so: the work it was doing is not in it.
  if (result.survivors.length > 0) {
    process.stdout.write(redactSecrets(`box-run: ${result.survivors.length} process(es) this run started were still running when its time limit ran out, and were killed: ${result.survivors.map((survivor) => survivor.command).join("; ")}\n`));
  }
  // THE STATUS LINE IS LAST AND ON STDOUT, so the laptop agent reads it off the
  // final line of the one block it relays.
  const { seconds } = result;
  process.stdout.write(`box-run: run ${result.id} host box cli ${opts.cli} exit ${result.exitCode} after ${seconds}s\n`);
  if (result.timedOut) note(`timed out after ${seconds}s (limit ${opts.timeoutMs} ms)`);
  else if (result.exitCode !== 0) {
    note(`${opts.cli} exited ${result.exitCode} after ${seconds}s`);
    if (result.stderrTail) process.stderr.write(`${result.stderrTail}\n`);
  } else note(`exit 0 after ${seconds}s`);
  if (opts.keepWorktree) note(`work dir kept at ${result.workDir}, log at ${result.errLog}`);
  process.exit(result.exitCode);
}

// ONLY AS THE ENTRY SCRIPT. worker/jobs/tts-lib.mjs imports this file for
// boxRunSync, and an import that parsed the job's argv and read its stdin
// would launch a run nobody asked for.
// argv[1] is resolved through links because Node loads the main module by its
// real path, which is what import.meta.url names.
let entry = "";
try { entry = process.argv[1] ? fs.realpathSync(process.argv[1]) : ""; } catch {}
if (entry && fileURLToPath(import.meta.url) === entry) await main();
