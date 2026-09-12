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
// step 7, or move one below the `== [8/10] cron ==` heading.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, posix } from "node:path";

const SETUP = "worker/setup.sh";
const CRON_HEADING = '== [8/10] cron ==';

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
const RELATIVE_IMPORT = /^\s*import\s[^\n]*?from\s+["'](\.\.?\/[^"']+)["']/gm;

const relativeImportsOf = (file) => {
  const text = readFileSync(file, "utf8");
  const here = dirname(file).split("\\").join("/");
  return [...text.matchAll(RELATIVE_IMPORT)].map((m) => posix.normalize(posix.join(here, m[1])));
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
  if (!cp.test(beforeCron)) {
    if (new RegExp(`cp\\s+"\\$WORKER_DIR"/${escaped}\\s`).test(setup)) {
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
console.log(`setup.sh import check passed (${needed.size} cross-directory imports, all copied before the cron).`);
