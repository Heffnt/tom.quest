// KEPT: cron starts flat /opt/tts jobs, so preserving the worker module tree
// would require changing every deployed cron command.
// Guardrail: worker/setup.sh step 7 must copy EVERY file the runs/ modules
// import from outside runs/, and must do it before step 8 writes the cron.
//
// The failure this exists to stop is not a degraded feature. Node ESM resolves
// a static import at module load, so one missing file means the module cannot
// be imported at all and the cron entry that runs it dies with
// ERR_MODULE_NOT_FOUND every tick — silently, in a log nobody reads. It has
// happened twice: `../jobs/worker-env.mjs` (fixed with an explicit cp line and
// the invariant comment in step 7) and `../session-host/{cut,overflow,redact}
// .mjs`, which step 9 did copy but only AFTER step 8 had already started the
// sweep, so every fresh install's first sweep failed.
//
// The rule this enforces, in the shape the box actually has: runs/ lands at
// /opt/tts/runs/, so a `../<dir>/<file>` specifier resolves to
// /opt/tts/<dir>/<file>, a path the flat `cp .../jobs/*.mjs /opt/tts/` never
// fills. The closure is transitive — a copied file's own relative imports need
// lines too (cut.mjs → overflow.mjs → redact.mjs is three files, not one).
//
// witness: delete any `cp "$WORKER_DIR"/session-host/redact.mjs …` line from
// step 7, or move one below the `== [8/11] cron ==` heading.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, posix } from "node:path";
import { unaffectedBy } from "./evals-check.mjs";

const SETUP = "worker/setup.sh";
const CRON_HEADING = '== [8/11] cron ==';
// The one complete session-host copy contains every `.mjs` module there. It
// covers an imported session-host file only when this exact command lands
// before cron; a broader glob would hide a missing module or wrong destination.
const SESSION_HOST_COPY = /cp\s+"\$WORKER_DIR"\/session-host\/\*\.mjs\s+"\$WORKER_DIR"\/session-host\/package\.json\s+\\?\s*[\r\n]+\s*\/opt\/tts\/session-host\/(?:\s|$)/m;

const setup = readFileSync(SETUP, "utf8");
const failures = [];

const cronAt = setup.indexOf(CRON_HEADING);
if (cronAt === -1) {
  failures.push(`${SETUP}: the '${CRON_HEADING}' heading is gone — this check cannot tell early copies from late ones`);
}
// Everything the installer has done by the time the first cron tick can fire.
const beforeCron = cronAt === -1 ? setup : setup.slice(0, cronAt);

// Static relative imports only: `import … from "../x.mjs"` / "./x.mjs". A
// dynamic import() would not be resolved at load and is not this rule's
// concern.
//
// THE SPECIFIER LIST SPANS LINES, AND `export … from` IS AN IMPORT TOO. The
// first spelling of this was `[^\n]*?`, which silently skipped both — and
// scripts/prelude.mjs happens to import worker/jobs/context-relevance.mjs
// across five lines, so the file this fence was written to catch was the file
// it could not see. `[^;'"\`]*?` is what keeps the lazy span inside one
// statement: it cannot cross a semicolon into the next, and it cannot cross a
// quote into an unrelated string.
const RELATIVE_IMPORT = /(?:^|\n)[ \t]*(?:import|export)\b[^;'"`]*?\bfrom[ \t\r\n]*["'](\.\.?\/[^"']+)["']/g;
// `import "./x.mjs"` with no bindings: run for its side effects, and still a
// file this module needs at load.
const SIDE_EFFECT_IMPORT = /(?:^|\n)[ \t]*import[ \t]+["'](\.\.?\/[^"']+)["']/g;

const relativeImportsOf = (file) => {
  const text = readFileSync(file, "utf8");
  const here = dirname(file).split("\\").join("/");
  return [...text.matchAll(RELATIVE_IMPORT), ...text.matchAll(SIDE_EFFECT_IMPORT)]
    .map((m) => posix.normalize(posix.join(here, m[1])));
};

/** Every file reachable from `roots` by static relative imports, roots
 *  included, as repo paths. The installed-script fence below walks the same
 *  imports with a box path beside each repo path, so it keeps its own queue;
 *  both read a file's imports through relativeImportsOf. */
const reachableFrom = (roots, onMissing) => {
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift();
    let imports;
    try {
      imports = relativeImportsOf(file);
    } catch {
      onMissing(file);
      continue;
    }
    for (const target of imports) {
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
};

// Start from every runs/ module; the glob `cp .../runs/*.mjs /opt/tts/runs/`
// already covers files that stay inside runs/, so only what leaves it is
// checked.
const roots = readdirSync("worker/runs")
  .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
  .map((name) => `worker/runs/${name}`);

const needed = new Map(); // repo path -> the importer that first reached it
const queue = [...roots];
const seen = new Set(roots);
while (queue.length > 0) {
  const file = queue.shift();
  let imports;
  try {
    imports = relativeImportsOf(file);
  } catch {
    failures.push(`${file} is imported but does not exist`);
    continue;
  }
  for (const target of imports) {
    if (!target.startsWith("worker/runs/") && !needed.has(target)) needed.set(target, file);
    if (seen.has(target)) continue;
    seen.add(target);
    queue.push(target);
  }
}

if (needed.size === 0) {
  failures.push("no cross-directory imports parsed out of worker/runs/*.mjs — the fence cannot run");
}

// ── Fence 2: what the eval prelude reads is what the eval gate watches ──────
//
// scripts/evals-check.mjs decides INSIDE the check whether a branch could have
// moved the eval set, and a branch it calls unaffected gets a passing row with
// nothing scored. The runner builds every scored item's prompt by executing the
// pinned scripts/prelude.mjs — so each file that prelude transitively imports
// changes what the set measures exactly as prelude.mjs itself does, and each
// must make a branch AFFECTED on its own.
//
// DERIVED, NOT REMEMBERED. WATCHED_PATHS named `scripts/prelude.mjs` and none
// of the three files it imports, so a change to any one of them alone was
// misclassified. Enumerating them by hand is the thing this deletes: the graph
// is walked here, and a fourth import fails this check until it is watched.
const PRELUDE_ROOT = "scripts/prelude.mjs";
const preludeFiles = reachableFrom([PRELUDE_ROOT], (file) =>
  failures.push(`${file} is imported by the prelude graph but does not exist`),
);
if (preludeFiles.size < 2) {
  failures.push(`no relative imports parsed out of ${PRELUDE_ROOT} — the prelude fence cannot run`);
}
for (const file of [...preludeFiles].sort()) {
  if (unaffectedBy([file])) {
    failures.push(
      `${file} is read by ${PRELUDE_ROOT} but is not watched: add it to WATCHED_PATHS in ` +
        `scripts/evals-check.mjs, or the evals gate calls a change to it unaffected and scores nothing`,
    );
  }
}

// ── Fence 3: every installed script's imports land on a filled path ─────────
//
// Step 7 installs scripts/*.mjs files by name, mostly to /opt/tts/scripts/,
// and those import shared/ and each other by relative path. On the box a
// specifier resolves against the directory the file was COPIED to, so
// `../shared/skills.mjs` from /opt/tts/scripts/ needs /opt/tts/shared/skills.mjs
// to exist before the first cron tick. Deleting the one line that copies
// shared/ would leave the SessionStart hook and the delegate prelude throwing
// ERR_MODULE_NOT_FOUND at load, and nothing else would notice.
//
// So every installed script is walked with the pair it has: its repo path and
// its box path. Each relative import moves both by the same specifier, and the
// box path must be written by a cp line before the cron, from that same repo
// file, into a directory a mkdir -p before the cron created. A symlink in the
// repo is walked as the file it names, as `cp` copies it.
//
// witness: delete the `cp "$WORKER_DIR"/../shared/*.mjs /opt/tts/shared/` line.
const BOX_ROOT = "/opt/tts";
const cpLines = (text) => {
  const out = [];
  for (const line of text.replace(/\\\r?\n[ \t]*/g, " ").split(/\r?\n/)) {
    const match = /^[ \t]*cp[ \t]+([^;&|>#]+)/.exec(line);
    if (!match) continue;
    const words = match[1].trim().split(/\s+/).filter((word) => !word.startsWith("-"));
    if (words.length < 2) continue;
    const dest = words.pop();
    const sources = words
      .filter((word) => word.startsWith('"$WORKER_DIR"/'))
      .map((word) => posix.normalize(posix.join("worker", word.slice('"$WORKER_DIR"/'.length))));
    if (sources.length > 0) out.push({ sources, dest, intoDir: dest.endsWith("/") || words.length > 1 });
  }
  return out;
};
const globMatches = (pattern, file) =>
  posix.dirname(pattern) === posix.dirname(file) &&
  new RegExp(`^${posix.basename(pattern).split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`)
    .test(posix.basename(file));
const copiesBeforeCron = cpLines(beforeCron);
const boxPathsOf = (repoFile) =>
  copiesBeforeCron.flatMap(({ sources, dest, intoDir }) =>
    sources.some((source) => globMatches(source, repoFile))
      ? [intoDir ? posix.join(dest, posix.basename(repoFile)) : dest]
      : [],
  );
const madeDirs = [...beforeCron.replace(/\\\r?\n[ \t]*/g, " ").matchAll(/mkdir -p([^\n]*)/g)]
  .flatMap((m) => m[1].trim().split(/\s+/))
  .map((dir) => dir.replace(/\/+$/, ""));
const scriptRoots = copiesBeforeCron.flatMap(({ sources }) =>
  sources.filter((source) => /^scripts\/[\w.-]+\.mjs$/.test(source)),
);
if (scriptRoots.length === 0) {
  failures.push(`${SETUP}: no cp line installs a scripts/*.mjs before '${CRON_HEADING}' — the installed-script fence cannot run`);
}
const walked = new Set();
const scriptQueue = [...new Set(scriptRoots)].flatMap((repo) => boxPathsOf(repo).map((box) => ({ repo, box, from: null })));
while (scriptQueue.length > 0) {
  const { repo, box, from } = scriptQueue.shift();
  if (walked.has(`${repo}\t${box}`)) continue;
  walked.add(`${repo}\t${box}`);
  if (from !== null) {
    if (!boxPathsOf(repo).includes(box)) {
      failures.push(
        `${SETUP}: ${from.repo}, installed as ${from.box}, imports ${repo}, which it finds at ${box} — ` +
          `no cp line before '${CRON_HEADING}' puts ${repo} there, so it fails with ERR_MODULE_NOT_FOUND at load`,
      );
      continue;
    }
    const dir = posix.dirname(box);
    if (dir !== BOX_ROOT && !madeDirs.includes(dir)) {
      failures.push(`${SETUP}: nothing creates ${dir} before '${CRON_HEADING}', so the cp of ${repo} has nowhere to land`);
    }
  }
  let imports;
  try {
    imports = relativeImportsOf(repo);
  } catch {
    failures.push(`${repo} is imported by an installed script but does not exist`);
    continue;
  }
  const repoDir = posix.dirname(repo);
  for (const target of imports) {
    const specifier = posix.relative(repoDir, target);
    scriptQueue.push({ repo: target, box: posix.normalize(posix.join(posix.dirname(box), specifier)), from: { repo, box } });
  }
}

for (const [target, importer] of [...needed].sort()) {
  const rest = target.replace(/^worker\//, ""); // e.g. session-host/redact.mjs
  const dir = posix.dirname(rest);
  if (dir === ".") {
    failures.push(`${importer} imports ${target}, which is not under a worker/ subdirectory — this check does not know where it lands on the box`);
    continue;
  }
  const escaped = rest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The destination may be spelled as the full path or as the directory.
  const cp = new RegExp(`cp\\s+"\\$WORKER_DIR"/${escaped}\\s+/opt/tts/${escaped.replace(/\\\//g, "/")}(?:\\s|$)|cp\\s+"\\$WORKER_DIR"/${escaped}\\s+/opt/tts/${dir}/(?:\\s|$)`, "m");
  const copiedBySessionHostGlob = dir === "session-host" && SESSION_HOST_COPY.test(beforeCron);
  if (!cp.test(beforeCron) && !copiedBySessionHostGlob) {
    if (new RegExp(`cp\\s+"\\$WORKER_DIR"/${escaped}\\s`).test(setup) ||
      (dir === "session-host" && SESSION_HOST_COPY.test(setup))) {
      failures.push(`${SETUP}: ${rest} is copied only after '${CRON_HEADING}' — the first cron tick runs before it lands. Move the cp line into step 7 (${importer} imports it).`);
    } else {
      failures.push(`${SETUP}: no line copies ${rest} to /opt/tts/${rest}, which ${importer} imports — the cron entry that runs it will fail with ERR_MODULE_NOT_FOUND every tick. Add: cp "$WORKER_DIR"/${rest} /opt/tts/${rest}`);
    }
  }
  if (!new RegExp(`mkdir -p[^\\n]*/opt/tts/${dir}(?![\\w./-])`, "m").test(beforeCron)) {
    failures.push(`${SETUP}: nothing creates /opt/tts/${dir} before '${CRON_HEADING}', so the cp of ${rest} has nowhere to land`);
  }
}

if (failures.length > 0) {
  console.error("setup.sh import check FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(
  `setup.sh import check passed (${needed.size} cross-directory imports, all copied before the cron; ` +
    `${walked.size} installed script files, every import landing on a copied path; ` +
    `${preludeFiles.size} files in the prelude graph, all watched).`,
);
