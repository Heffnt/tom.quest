// Run OpenAI Codex CLI headlessly and print only its final answer.
//
// This is the one place in the repo that knows the shape of the `codex exec`
// command line. Claude Code reaches Codex through it in three ways: the
// `codex` subagent (.claude/agents/codex.md), the /codex skill
// (.claude/skills/codex/SKILL.md), and Workflow scripts that pass
// `agentType: 'codex'`. All three pipe a prompt to this script's stdin and
// read the answer from its stdout. On the Jarvis Box the same file is also
// `tts-codex` on the PATH (setup.sh copies it to /opt/tts/codex-run.mjs), so a
// session in any repo reaches Codex with these same flags.
//
// Why a wrapper at all: a bare `codex exec` writes several hundred kilobytes
// of progress, reasoning, and tool transcript to stderr, leaks stray lines
// from the Windows sandbox helper onto stdout, blocks on stdin if nothing is
// attached, and fires the desktop app's notify hook after every turn. Each of
// those would either hang a Claude session or flood its context. Here the
// answer comes from Codex's `-o` file (the only clean channel), stderr goes to
// a log file, stdin is fed and closed, and the notify hook is disabled.
//
// Usage:
//   node scripts/codex-run.mjs [options] < prompt.txt
//
// Options (every one is optional):
//   --cwd DIR          repo Codex works in            (default: current dir)
//   --sandbox MODE     read-only | workspace-write    (default: workspace-write)
//   --model NAME       Codex model                    (default: gpt-5.6-sol)
//   --effort LEVEL     minimal|low|medium|high|xhigh  (default: xhigh)
//   --timeout MS       hard kill after this long      (default: none; 0 = none)
//   --schema FILE      JSON Schema the answer must match
//   --keep-logs        print the stderr log path instead of deleting it
//   --no-operate       do not inject WikiTom's operate instructions
//
// THERE IS NO TIME LIMIT BY DEFAULT (Tom's ruling, 2026-09-09). A Codex run at
// `xhigh` on real work routinely outlasts any number worth guessing, and a kill
// throws away everything it had done. A cap is opt-in: pass `--timeout MS` and
// the run is killed at that point, exactly as before. Callers that cannot wait
// forever should run the wrapper in the background rather than cap it.
//
// Exit codes: Codex's own code on completion; 124 on timeout, when a --timeout
// was given (partial answer, if any, is still printed); 2 for bad arguments or
// a missing binary.
//
// THE DEFAULTS ARE TOM'S RULING (2026-09-04): the strongest model at the
// highest reasoning effort, and Codex may edit files. `workspace-write` lets it
// write under --cwd and reach the network (the two together are what a session
// runner needs: install a dep, run a test, fix the file). `--sandbox read-only`
// is still there and is what review paths pass, because a reviewer that edits
// the thing it is reviewing has destroyed the evidence. `danger-full-access` is
// deliberately not accepted here; run Codex by hand if you ever need it.
//
// The model default is a NAME, not a deferral to ~/.codex/config.toml, so that
// a machine whose config was never written still runs the fleet model.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const SANDBOXES = new Set(["read-only", "workspace-write"]);
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const DEFAULT_TIMEOUT_MS = 0; // 0 = no timeout; a cap is opt-in via --timeout
const DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_EFFORT = "xhigh";
const DEFAULT_SANDBOX = "workspace-write";

function fail(message, code = 2) {
  process.stderr.write(`codex-run: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    sandbox: DEFAULT_SANDBOX,
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    timeout: DEFAULT_TIMEOUT_MS,
    schema: null,
    keepLogs: false,
    operate: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case "--cwd": opts.cwd = next(); break;
      case "--sandbox": opts.sandbox = next(); break;
      case "--model": opts.model = next(); break;
      case "--effort": opts.effort = next(); break;
      case "--timeout": opts.timeout = Number(next()); break;
      case "--schema": opts.schema = next(); break;
      case "--keep-logs": opts.keepLogs = true; break;
      case "--no-operate": opts.operate = false; break;
      default: fail(`unknown option ${arg}`);
    }
  }
  if (!SANDBOXES.has(opts.sandbox)) fail(`--sandbox must be one of ${[...SANDBOXES].join(", ")}`);
  if (!EFFORTS.has(opts.effort)) fail(`--effort must be one of ${[...EFFORTS].join(", ")}`);
  if (!Number.isFinite(opts.timeout) || opts.timeout < 0) fail("--timeout must be a number of milliseconds, or 0 for no limit");
  if (!existsSync(opts.cwd)) fail(`--cwd ${opts.cwd} does not exist`);
  if (opts.schema && !existsSync(opts.schema)) fail(`--schema ${opts.schema} does not exist`);
  return opts;
}

// Binary lookup order: CODEX_BIN env var, then `codex` on PATH (the pinned npm
// install, on the laptop and the box alike). The Codex desktop app's bundled
// binary is deliberately NOT a fallback: it lags the npm release and rejects
// the gpt-5.6 models.
function resolveBinary() {
  if (process.env.CODEX_BIN) {
    if (!existsSync(process.env.CODEX_BIN)) fail(`CODEX_BIN=${process.env.CODEX_BIN} does not exist`);
    return process.env.CODEX_BIN;
  }
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  fail("codex binary not found: set CODEX_BIN, or run `npm i -g @openai/codex@0.153.3`");
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Read a committed object, never the work tree: an in-progress nightly edit
// must not alter a Codex run's operate instructions.
function operateInstructions() {
  const wikitom = process.env.WIKITOM_DIR
    || (process.platform === "win32" ? "C:/Users/heffn/Desktop/WikiTom" : "/root/wikitom");
  try {
    if (!existsSync(wikitom)) throw new Error("checkout absent");
    const resolved = realpathSync.native(wikitom);
    return execFileSync(
      "git",
      ["-c", `safe.directory=${resolved}`, "-C", wikitom, "show", "HEAD:model-of-tom/agent-rules.md"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    // One stable line makes the missing personal checkout visible without
    // making the launcher unusable on machines that do not have one.
    process.stderr.write("codex-run: operate instructions unavailable; continuing without them\n");
    return null;
  }
}

function killTree(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

const opts = parseArgs(process.argv.slice(2));
const prompt = readStdin();
if (!prompt.trim()) fail("no prompt on stdin");

const operate = opts.operate ? operateInstructions() : null;

const bin = resolveBinary();
const workDir = mkdtempSync(join(tmpdir(), "codex-run-"));
const lastMessage = join(workDir, "last.txt");
const errLog = join(workDir, "stderr.log");

const args = [
  "exec",
  "--sandbox", opts.sandbox,
  "--ephemeral",
  // On the Jarvis Box `tts-codex` runs from repo-"none" scratch workdirs and
  // from /root; without this Codex refuses ("Not inside a trusted directory")
  // before reading the prompt. The daemon's runner passes it for the same
  // reason. Harmless inside a repo.
  "--skip-git-repo-check",
  "--color", "never",
  "-C", opts.cwd,
  "-o", lastMessage,
  "-c", "notify=[]",
  "-c", `model_reasoning_effort=${opts.effort}`,
];
if (operate !== null) {
  // JSON strings are valid TOML basic strings and preserve quotes/newlines.
  args.push("-c", `developer_instructions=${JSON.stringify(operate)}`);
}
// Under workspace-write, a sandboxed Codex has no network by default, which
// turns "run the tests" into a dependency-install failure. Harmless under
// read-only, but say it only where it applies so the read-only path stays
// visibly the narrow one.
if (opts.sandbox === "workspace-write") {
  args.push("-c", "sandbox_workspace_write.network_access=true");
}
if (opts.model) args.push("-m", opts.model);
if (opts.schema) args.push("--output-schema", opts.schema);
args.push("-"); // prompt arrives on stdin, so no command-line length limit

// A .cmd shim (the npm install) only runs through cmd.exe.
const useShell = process.platform === "win32" && bin.toLowerCase().endsWith(".cmd");
const quote = (s) => (useShell ? `"${s.replace(/\\(?=")/g, "\\\\").replace(/"/g, '""')}"` : s);

const errStream = createWriteStream(errLog);
const child = spawn(useShell ? quote(bin) : bin, args.map(quote), {
  cwd: opts.cwd,
  shell: useShell,
  stdio: ["pipe", "pipe", "pipe"],
  detached: process.platform !== "win32",
  windowsHide: true,
});
child.stdout.pipe(errStream, { end: false }); // stray sandbox lines land here, not on our stdout
child.stderr.pipe(errStream, { end: false });
child.stdin.end(prompt);

let timedOut = false;
// No timer at all unless a cap was asked for. An unreferenced timer would also
// hold the event loop open, so this is the whole of "no timeout".
const timer = opts.timeout > 0
  ? setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeout)
  : null;
const stopTimer = () => { if (timer) clearTimeout(timer); };

const started = Date.now();
child.on("error", (err) => {
  stopTimer();
  fail(`could not start ${bin}: ${err.message}`);
});
child.on("close", (code) => {
  stopTimer();
  errStream.end();
  const seconds = Math.round((Date.now() - started) / 1000);
  let answer = "";
  try { answer = readFileSync(lastMessage, "utf8"); } catch { /* no answer written */ }
  process.stdout.write(answer);
  if (answer && !answer.endsWith("\n")) process.stdout.write("\n");

  if (timedOut) {
    process.stderr.write(`codex-run: timed out after ${seconds}s (limit ${opts.timeout} ms)\n`);
  } else if (code !== 0) {
    let tail = "";
    try { tail = readFileSync(errLog, "utf8").trim().split("\n").slice(-5).join("\n"); } catch { /* ignore */ }
    process.stderr.write(`codex-run: codex exited ${code} after ${seconds}s\n${tail}\n`);
  } else if (!answer.trim()) {
    process.stderr.write(`codex-run: codex exited 0 after ${seconds}s but wrote no answer\n`);
  } else {
    process.stderr.write(`codex-run: exit 0 after ${seconds}s\n`);
  }

  if (opts.keepLogs) {
    process.stderr.write(`codex-run: stderr log at ${errLog}\n`);
  } else {
    rmSync(workDir, { recursive: true, force: true });
  }
  process.exit(timedOut ? 124 : (code ?? 1));
});
