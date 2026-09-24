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
//                      or openrouter/<vendor>/<model>, served by OpenRouter
//   --effort LEVEL     minimal|low|medium|high|xhigh  (default: xhigh)
//   --timeout MS       hard kill after this long      (default: none; 0 = none)
//   --schema FILE      JSON Schema the answer must match
//   --keep-logs        print the stderr log path instead of deleting it
//   --no-operate       do not inject WikiTom's operate instructions
//   --grant NAME       a skill this run is given         (repeatable)
//   --refuse NAME=WHY  a skill withheld, and why         (repeatable)
//
// A MECHANICAL CODEX CHILD GETS THE BASE AND NOTHING ELSE. Both skill options
// default to empty, and with neither the prompt carries no grant block at all.
// That is the map's own division of labour — the operate page assigns the
// mechanical work - reading, changing and checking code - to Codex. A
// run doing mechanical work needs the operate layer and its prompt, not the
// write or know layers, so nothing is granted until its spawner names one. A
// named skill is granted only after its installed SKILL.md is found; otherwise
// the block and registration record its refusal and reason.
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
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, createWriteStream } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

// This file runs here in a checkout and flat at /opt/tts/codex-run.mjs on the
// box. Both layouts share the one installed registration body in runs/.
const registrationUrl = [
  new URL("../worker/runs/registration.mjs", import.meta.url),
  new URL("./runs/registration.mjs", import.meta.url),
].find((candidate) => existsSync(fileURLToPath(candidate)));
if (!registrationUrl) throw new Error("run registration module is not installed");
const { writeRegistration } = await import(registrationUrl.href);

// The grant renderer, resolved the same way and for the same reason. In a
// checkout this file IS scripts/codex-run.mjs, so skills.mjs sits beside it;
// setup.sh installs this file flat at /opt/tts/codex-run.mjs while skills.mjs
// lands at /opt/tts/scripts/skills.mjs, one directory down. Neither candidate
// can resolve in the other layout, so the pair is unambiguous.
//
// The URL is resolved here but IMPORTED ONLY WHEN A SKILL IS NAMED. tts-codex
// runs from any repo, including checkouts that predate skills.mjs, and a run
// that asked for no skill must not be broken by a module it never needed.
const skillsUrl = [
  new URL("./skills.mjs", import.meta.url),
  new URL("./scripts/skills.mjs", import.meta.url),
].find((candidate) => existsSync(fileURLToPath(candidate)));

// The graph, resolved the same way again: in a checkout this file is
// scripts/codex-run.mjs and the module is ../worker/jobs/graph.mjs; installed
// flat at /opt/tts/codex-run.mjs it sits beside the other jobs.
const graphUrl = [
  new URL("../worker/jobs/graph.mjs", import.meta.url),
  new URL("./graph.mjs", import.meta.url),
].find((candidate) => existsSync(fileURLToPath(candidate)));

// The published graph's version, from the one module that reads it. Resolved
// as the pair above; worker-env.mjs touches nothing at module load, so this
// one is imported straight away rather than at the point of use.
const workerEnvUrl = [
  new URL("../worker/jobs/worker-env.mjs", import.meta.url),
  new URL("./worker-env.mjs", import.meta.url),
].find((candidate) => existsSync(fileURLToPath(candidate)));
const workerEnv = workerEnvUrl ? await import(workerEnvUrl.href) : null;
const readGraphVersion = workerEnv ? workerEnv.graphVersion : () => null;

// AN OPENROUTER MODEL IS SPELLED openrouter/<vendor>/<model>, for example
// openrouter/deepseek/deepseek-v4-flash: OpenRouter's own model id behind one
// prefix that says which provider serves it. The run is still Codex; only the
// model provider changes, to the [model_providers.openrouter] entry that
// worker/setup.sh writes into ~/.codex/config.toml. The whole spelling is what
// the registration records as the model requested, and the rollout records
// the id Codex sent, <vendor>/<model>.
const OPENROUTER_PREFIX = "openrouter/";
const OPENROUTER_KEY = "OPENROUTER_API_KEY";

// OpenRouter's model id, or null for a model the default provider serves.
function openrouterModelOf(model) {
  if (!model.startsWith(OPENROUTER_PREFIX)) return null;
  const id = model.slice(OPENROUTER_PREFIX.length);
  if (!/^[^/\s]+\/\S+$/.test(id)) fail(`${model}: an OpenRouter model is spelled openrouter/<vendor>/<model>`);
  return id;
}

// THE KEY IS READ HERE, NOT INHERITED. Every model-reachable spawn on the box
// drops it (worker/session-host/env-scrub.mjs), so a session's shell never
// holds it; this launcher reads it from the one env file only for a run that
// names an OpenRouter model, and hands it to that Codex process alone. A
// caller whose own environment already carries it (a laptop) is used as is.
// RUN_ENV_FILE is worker/runs/config.mjs's override of the file's path.
function openrouterKey() {
  const file = process.env.RUN_ENV_FILE || workerEnv?.ENV_PATH;
  const fromEnv = Boolean(process.env[OPENROUTER_KEY]);
  let value = fromEnv ? process.env[OPENROUTER_KEY] : null;
  if (!fromEnv) {
    try { value = file && workerEnv ? workerEnv.loadEnv({ path: file })[OPENROUTER_KEY] : null; } catch {}
  }
  if (!value) fail(`an openrouter/ model needs ${OPENROUTER_KEY}, which is in neither this environment nor ${file ?? "the worker env file"}`);
  // REMOVAL CHECK: Codex builds the Authorization header from this value and,
  // when the value is not a legal header value, SENDS THE REQUEST WITHOUT ONE
  // rather than failing. OpenRouter then answers "401 Missing Authentication
  // header", which reads as a key that never arrived. A key pasted into a
  // terminal can carry the paste's escape sequences (ESC[200~ ... ESC[201~)
  // or a stray control character; nothing earlier on the path can see that,
  // because the env file is parsed as text and the key's value is never shown.
  // An OpenRouter key is printable ASCII with no spaces (sk-or-v1-<hex>), so
  // anything else is refused here, reported by character class, never by value.
  const bad = [...value].filter((ch) => !/^[\x21-\x7e]$/.test(ch));
  if (bad.length > 0) {
    const control = bad.filter((ch) => ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f).length;
    const space = bad.filter((ch) => ch === " ").length;
    const other = bad.length - control - space;
    const where = fromEnv ? "this environment" : file;
    fail(`${OPENROUTER_KEY} in ${where} holds ${bad.length} character(s) an OpenRouter key never contains `
      + `(${control} control, ${space} space, ${other} non-ASCII); with a control character Codex sends no `
      + `Authorization header at all. Rewrite the line with printable characters only.`);
  }
  return value;
}

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
    // Empty by default: a mechanical Codex child gets the base and nothing else.
    granted: [],
    refused: [],
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
      // REMOVAL CHECK: --grant and --refuse carry the spawner's per-run authority
      // decision into both the prompt and the receipt. Removing them would
      // force an all-skills default or lose why a skill was withheld.
      case "--grant": {
        const name = next().trim();
        if (!name) fail("--grant needs a skill name");
        opts.granted.push(name);
        break;
      }
      case "--refuse": {
        // NAME=WHY, split at the first "=" so a reason may contain one.
        const value = next();
        const at = value.indexOf("=");
        if (at <= 0) fail("--refuse takes NAME=WHY");
        const name = value.slice(0, at).trim();
        const why = value.slice(at + 1).trim();
        if (!name || !why) fail("--refuse takes NAME=WHY");
        opts.refused.push({ name, why });
        break;
      }
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

// Normalize once before conflict checks, rendering, and registration. The
// grant block names bare skills, so its receipt must use that same spelling.
// Keep the caller's raw spelling only for a useful duplicate-decision error.
async function normalizeSkillDecisions(opts) {
  opts.rawGranted = [...opts.granted];
  opts.rawRefused = opts.refused.map(({ name }) => name);
  opts.canonicalGranted = [...opts.granted];
  opts.canonicalRefused = [...opts.rawRefused];
  if (!skillsUrl || (opts.granted.length === 0 && opts.refused.length === 0)) return;
  const { bareSkillName, SKILL_PREFIX } = await import(skillsUrl.href);
  const normalize = (name) => {
    try {
      const bare = bareSkillName(name);
      return { name: bare, canonical: `${SKILL_PREFIX}${bare}` };
    } catch {
      // Preserve an unsupported name so the existing missing-catalog path can
      // explain the refusal rather than failing before it renders the block.
      return { name, canonical: name };
    }
  };
  const grants = opts.granted.map(normalize);
  const refusals = opts.refused.map((entry) => ({ entry, normalized: normalize(entry.name) }));
  opts.granted = grants.map(({ name }) => name);
  opts.canonicalGranted = grants.map(({ canonical }) => canonical);
  opts.refused = refusals.map(({ entry, normalized }) => ({ ...entry, name: normalized.name }));
  opts.canonicalRefused = refusals.map(({ normalized }) => normalized.canonical);
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

function isRegularFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

// The prompt and the installed catalog both name a skill by the normalized
// directory mapping. A second spelling is still the same authority decision:
// accepting both would make a grant and a refusal, or two grants, look like
// distinct caller choices when the run can load only one SKILL.md.
async function validateSkillDecisions(opts) {
  const decisions = [
    ...opts.granted.map((name, index) => ({
      kind: "grant", name, rawName: opts.rawGranted?.[index] ?? name, canonical: opts.canonicalGranted?.[index] ?? name,
    })),
    ...opts.refused.map(({ name }, index) => ({
      kind: "refuse", name, rawName: opts.rawRefused?.[index] ?? name, canonical: opts.canonicalRefused?.[index] ?? name,
    })),
  ];
  if (decisions.length < 2) return;

  const seen = new Map();
  for (const decision of decisions) {
    // A launcher copied without skills.mjs can still reject exact conflicts.
    // Two distinct spellings count as equivalent only when the installed
    // catalog's own mapping successfully resolves both of them.
    const canonical = decision.canonical;
    const previous = seen.get(canonical);
    if (!previous) {
      seen.set(canonical, decision);
      continue;
    }
    if (previous.kind === decision.kind) {
      if (previous.rawName === decision.rawName) {
        fail(`--${decision.kind} names ${decision.rawName} more than once`);
      }
      fail(`--${decision.kind} names ${previous.rawName} and ${decision.rawName} as the same skill (${canonical})`);
    }
    fail(`--${decision.kind} ${decision.rawName} conflicts with --${previous.kind} ${previous.rawName} (${canonical})`);
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
    const commit = execFileSync(
      "git",
      ["-c", `safe.directory=${resolved}`, "-C", wikitom, "rev-parse", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const text = execFileSync(
      "git",
      ["-c", `safe.directory=${resolved}`, "-C", wikitom, "show", `${commit}:model-of-tom/agent-rules.md`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return { text, commit };
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
await normalizeSkillDecisions(opts);
await validateSkillDecisions(opts);
const prompt = readStdin();
if (!prompt.trim()) fail("no prompt on stdin");
// Settled before the registration is spooled, so a refused run leaves none.
const openrouterModel = openrouterModelOf(opts.model);
const openrouterApiKey = openrouterModel === null ? null : openrouterKey();

const operate = opts.operate ? operateInstructions() : null;

// A grant is labeled with the installed catalog's own published commit, never
// the WikiTom checkout's current HEAD. The checkout is shown separately when
// it has advanced; a missing checkout therefore cannot relabel a published
// catalog, and a hand-written SKILL.md has no authority to become a grant.
let grantBlock = "";
let granted = opts.granted;
let refused = opts.refused;
let skillCatalogCommit = null;
if (granted.length > 0 || refused.length > 0) {
  if (!skillsUrl) {
    process.stderr.write("codex-run: skills named but scripts/skills.mjs is not installed; grant block omitted\n");
    granted = []; refused = [];
  } else {
    const { PUBLISHED_SKILL_METADATA, renderGrants, skillDirName } = await import(skillsUrl.href);
    const codexHome = process.env.CODEX_HOME && process.env.CODEX_HOME.trim() !== ""
      ? process.env.CODEX_HOME
      : join(homedir(), ".codex");
    const installedSkills = join(codexHome, "skills");
    const available = [];
    const unavailable = [];
    for (const name of granted) {
      let skillFile;
      try {
        skillFile = join(installedSkills, skillDirName(name), "SKILL.md");
      } catch {
        unavailable.push({ name, why: "the skill name is not supported by the installed catalog" });
        continue;
      }
      if (!isRegularFile(skillFile)) {
        unavailable.push({ name, why: "its installed SKILL.md is missing" });
        continue;
      }
      let publishedCommit;
      try {
        // An installed catalog older than the sidecar has no name to read here
        // and lands in the same refusal as one whose sidecar is gone: either
        // way this process never saw the commit those bodies were built at.
        const metadata = join(installedSkills, skillDirName(name), PUBLISHED_SKILL_METADATA);
        publishedCommit = JSON.parse(readFileSync(metadata, "utf8")).commit;
      } catch {
        unavailable.push({ name, why: "its published catalog metadata is missing or invalid" });
        continue;
      }
      if (typeof publishedCommit !== "string" || !/^[0-9a-f]{7,64}$/i.test(publishedCommit)) {
        unavailable.push({ name, why: "its published catalog metadata is missing or invalid" });
        continue;
      }
      publishedCommit = publishedCommit.toLowerCase();
      if (skillCatalogCommit !== null && skillCatalogCommit !== publishedCommit) {
        unavailable.push({ name, why: `its published catalog is at ${publishedCommit}, unlike ${skillCatalogCommit}` });
        continue;
      }
      skillCatalogCommit = publishedCommit;
      available.push(name);
    }
    granted = available;
    refused = [...refused, ...unavailable];
    const labelCommit = skillCatalogCommit ?? operate?.commit;
    if (labelCommit) {
      grantBlock = renderGrants({ commit: labelCommit, checkoutCommit: skillCatalogCommit ? operate?.commit : null, granted, refused });
    } else {
      process.stderr.write("codex-run: skills named but no published catalog commit to cite; grant block omitted\n");
      granted = []; refused = [];
    }
  }
}

// WHAT THIS PROMPT CARRIES, as node ids. This launcher holds the one prefix
// page's BODY — `operate.text` is model-of-tom/agent-rules.md read out of the
// WikiTom commit above, and it goes into developerInstructions verbatim — so
// the line and heading nodes are named from the bytes the run will actually
// see, not guessed from a working directory. The granted skill names ride
// along as their own nodes, because the run was told it may load them.
//
// THE PREFIX IS agent-rules.md ALONE here: a mechanical Codex child gets the
// operate layer and nothing else, so writing.md and ground.md are not in this
// prompt and must not be claimed.
//
// ABSENT STAYS A SUPPORTED VALUE. No operate read and no graph module both mean
// this launcher does not know what the prompt carried, and `undefined` says
// that; an empty array would claim it carried nothing. The import is guarded
// for the same reason the grant block is: tts-codex runs from any repo,
// including one whose install predates graph.mjs, and a run that would
// otherwise have launched must not die on a module it only wanted to annotate
// itself with.
let graphNodes;
if (graphUrl && operate) {
  try {
    const { givenNodes } = await import(graphUrl.href);
    graphNodes = givenNodes({
      pages: [{ path: "model-of-tom/agent-rules.md", body: operate.text }],
      prefixPaths: ["model-of-tom/agent-rules.md"],
      granted,
    });
  } catch {
    process.stderr.write("codex-run: graph module unavailable; the run's node ids are not recorded\n");
    graphNodes = undefined;
  }
}

const stateDir = process.env.RUN_SWEEP_STATE_DIR
  || (process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "tts", "runs")
    : "/var/cache/tts/runs");
const layersGiven = operate ? ["operate"] : [];
const spooled = writeRegistration({
  spoolDir: process.env.TTS_RUN_REG_SPOOL || join(stateDir, "registration"),
  writer: {
    file: "scripts/codex-run.mjs",
    job: String(process.env.TTS_RUN_ORIGIN ?? "codex-run").replace(/^cron:/, ""),
  },
  registration: {
    host: process.env.RUN_HOST === "box" || process.env.RUN_HOST === "laptop" ? process.env.RUN_HOST : null,
    cli: "codex",
    origin: process.env.TTS_RUN_ORIGIN || "job",
    kind: process.env.TTS_RUN_PARENT_RUN_ID ? "codex-child" : "job",
    // A launcher's word wins; a child with a parent says nothing and runs where
    // its parent runs; a run with neither is a worker.
    ...(["session", "worker", "runner"].includes(process.env.TTS_RUN_ENVIRONMENT)
      ? { environment: process.env.TTS_RUN_ENVIRONMENT }
      : process.env.TTS_RUN_PARENT_RUN_ID ? {} : { environment: "worker" }),
    modelRequested: opts.model,
    effortRequested: opts.effort,
    cwd: opts.cwd,
    parentRunId: process.env.TTS_RUN_PARENT_RUN_ID || null,
    // The commit this run is ABOUT, when its launcher knows one — the audit
    // sets it (worker/jobs/audit.mjs) so its own tool calls can be found from
    // the commit afterwards. Spread conditionally: an absent env writes no key
    // rather than a null one, and mergeRegistration only copies what is there.
    ...(process.env.TTS_RUN_MERGE_KEY ? { mergeKey: process.env.TTS_RUN_MERGE_KEY } : {}),
    spawnedByToolUseId: null,
    continuesRunId: null,
    layersKnown: true,
    layersGiven,
    // Denied means a caller refused the layer. An operate file this run could
    // not read was not denied to it — it was absent, and layersGiven already
    // says so without inventing an intent nobody had.
    layersDenied: opts.operate ? [] : ["operate"],
    skillsGranted: [...granted],
    // The run record takes strings; renderGrants takes the pair. One reason,
    // written once, reaches both.
    skillsRefused: refused.map(({ name, why }) => `${name} — ${why}`),
    tools: { allowed: null, denied: null },
    hooksConfigured: ["SessionStart", "SessionEnd", "Stop", "SubagentStart", "SubagentStop"],
    ...(skillCatalogCommit || operate ? { wikitomCommit: skillCatalogCommit ?? operate.commit } : {}),
    promptSha256: crypto.createHash("sha256").update(prompt).digest("hex"),
    graphVersion: readGraphVersion() ?? undefined,
    // Spread rather than set, so a launcher that could not name the nodes
    // writes no key at all rather than an empty list.
    ...(graphNodes === undefined ? {} : { graphNodes }),
  },
});
const childEnv = {
  ...process.env,
  TTS_RUN_REG_TOKEN: spooled.token,
  TTS_RUN_REG_SPOOL: process.env.TTS_RUN_REG_SPOOL || join(stateDir, "registration"),
};
// Only an OpenRouter run's Codex holds the key; any other run's never does.
delete childEnv[OPENROUTER_KEY];
if (openrouterApiKey !== null) childEnv[OPENROUTER_KEY] = openrouterApiKey;

const bin = resolveBinary();
const workDir = mkdtempSync(join(tmpdir(), "codex-run-"));
const lastMessage = join(workDir, "last.txt");
const errLog = join(workDir, "stderr.log");

// THE WORK DIRECTORY GOES ON EVERY EXIT, not only on the child's `close`. A
// Codex run is routinely cut short — the model backgrounded it and its turn
// ended, box-run settled it as a survivor, ssh dropped — and each of those
// left the directory in /tmp for good: 5,278 of them, 158 MB, by 2026-09-23.
// `exit` covers fail() and every ordinary return, the three signals turn a
// kill into an exit, and rmSync in an exit handler is synchronous, which is
// the only kind of work an exit handler can finish. A SIGKILL is the one that
// still leaks, and nothing in this process can change that.
let reaped = false;
function reapWorkDir() {
  if (reaped || opts.keepLogs) return;
  reaped = true;
  try { rmSync(workDir, { recursive: true, force: true }); } catch {}
}
process.on("exit", reapWorkDir);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    try { killTree(child); } catch {}
    process.exit(130);
  });
}

const args = [
  "exec",
  "--sandbox", opts.sandbox,
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
// JSON strings are valid TOML basic strings and preserve quotes/newlines. The
// non-secret token also lets the sweeper bind a rollout when exec fires no hook.
//
// Order is operate, then grants, then the token. THE TOKEN LINE IS LAST and
// alone on its line, because findCodexRegistration anchors its regex to a line
// start and a line end; nothing may be appended after it.
const developerInstructions = [operate?.text ?? "", grantBlock, `TTS-RUN-TOKEN: ${spooled.token}`]
  .filter(Boolean)
  .join("\n");
args.push("-c", `developer_instructions=${JSON.stringify(developerInstructions)}`);
// Under workspace-write, a sandboxed Codex has no network by default, which
// turns "run the tests" into a dependency-install failure. Harmless under
// read-only, but say it only where it applies so the read-only path stays
// visibly the narrow one.
if (opts.sandbox === "workspace-write") {
  args.push("-c", "sandbox_workspace_write.network_access=true");
}
if (openrouterModel !== null) {
  // The provider entry is config.toml's; this selects it for this run only.
  // Codex reads the key from its own environment through the entry's env_key,
  // and passes its environment on to every command the model runs unless told
  // otherwise (shell_environment_policy.ignore_default_excludes defaults to
  // true, which keeps *KEY* names), so the exclude keeps the key out of the
  // model's shell.
  args.push("-c", 'model_provider="openrouter"');
  args.push("-c", `shell_environment_policy.exclude=${JSON.stringify([OPENROUTER_KEY])}`);
  args.push("-m", openrouterModel);
} else if (opts.model) args.push("-m", opts.model);
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
  env: childEnv,
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
  }
  // The exit handler does the reap, here and on every other way out.
  process.exit(timedOut ? 124 : (code ?? 1));
});
