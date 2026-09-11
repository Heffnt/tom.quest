/**
// NO SHEBANG LINE, for nightly.mjs's reason (worker/jobs/write-slack.mjs and
// scripts/export-golden.mjs say it too): this file is imported by its own test,
// and the test bundler rewrites an imported module by prepending an import —
// which lands in front of a shebang and fails to parse. Every caller already
// names the interpreter.
 * graduate-golden.mjs — the pass that turns a capability case into a regression.
 *
 * A golden item under evals/golden/runs/ is mined from Tom's own judgment of a
 * run's output, and it carries a `kind`. The two kinds ask opposite questions:
 *
 *   capability — can the system do a thing it CANNOT do yet? The case is
 *                EXPECTED TO FAIL, every week, until the change that fixes it
 *                lands. The evals gate never counts its failure as a regression.
 *   regression — does a thing that works still work? Its failure fails a merge.
 *
 * Graduation is the one-way move between them, and this script is it: the first
 * WEEKLY run in which a capability case passes every trial, its file is
 * rewritten with kind "regression" and a graduatedAt stamp. From then on the
 * case gates every merge like any other, and a later failure of it IS a
 * regression.
 *
 * IT IS A FILE REWRITE, AND THAT IS THE POINT. evals/golden/** is a watched
 * path (scripts/evals-check.mjs WATCHED_PATHS), so the rewrite lands on a
 * branch and goes through the evals gate like every other change — a graduation
 * that would itself cause a regression is caught by the machinery it is
 * joining. Nothing about a graduation is privileged.
 *
 * The script WRITES FILES AND NOTHING ELSE. It never commits, never pushes,
 * never posts — not to Slack, not to Convex. The weekly job calls it and lands
 * the result on a branch for the ordinary gate to score. IT MUST NEVER PUSH TO
 * MAIN FROM THE BOX: the set that gates every merge is not edited in the night
 * by a cron job with nothing scoring the edit.
 *
 *   node scripts/graduate-golden.mjs --run <row.json> [--golden evals/golden] [--dry-run] [--list]
 *   node scripts/graduate-golden.mjs --repo tom.quest --sha <sha> [--golden DIR] [--dry-run] [--list]
 *
 * With --run NOTHING ON THE NETWORK IS TOUCHED AT ALL — that is how the test
 * and a run by hand drive it. Without it the row comes from Convex the way
 * scripts/export-golden.mjs reads its input: CONVEX_SITE_URL and TTS_WORKER_KEY
 * in the environment, X-TTS-Key on the request.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The same directory worker/jobs/evals.mjs calls GOLDEN_DIR. Spelled again
 *  rather than imported: see loadItems for why that file is not imported. */
export const DEFAULT_GOLDEN = "evals/golden";

/** How wide a rubric is allowed to be on a --list line. */
export const RUBRIC_WIDTH = 80;

/**
 * The run row, whichever of its two forms arrived.
 *
 * /tts/evals-run answers an envelope — `{ run, base }` — and a row saved to a
 * file by hand is the row itself. Both are what somebody has to hand, so both
 * are taken, and the envelope is RECOGNISED BY ITS KEY rather than guessed at
 * from the shape: an envelope carrying `run: null` is an answer meaning "there
 * is no such run", and unwrapping it to null is the right reading, where
 * falling back to the envelope would hand the rest of this file an object with
 * no weekly flag and no cases that looks exactly like an ancient row.
 */
export function runFrom(parsed) {
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "run" in parsed) return parsed.run;
  return parsed;
}

/**
 * The run's per-case results.
 *
 * NOT `failures`. That list carries only the cases that failed, and a
 * graduation is made of passes — reading it would be reading the one half of
 * the run that can never graduate anything.
 */
export function caseResults(run) {
  return Array.isArray(run?.results) ? run.results : null;
}

/**
 * Why this row can graduate nothing, or null when it can.
 *
 * GRADUATION REQUIRES THE PASS ON THE WEEKLY RUN, NEVER ON A PULL-REQUEST RUN.
 * A pull-request run scores a 40-item subset (worker/jobs/evals.mjs
 * selectItems) against ONE BRANCH'S TREE. A capability case that passes there
 * passed against that branch and nothing else, and promoting it on that
 * evidence would let a branch that happens to fix one case permanently raise
 * the bar for main — the branch goes away, the promotion does not.
 *
 * ABSENT IS A VALUE AND IS NEVER INFERRED. A row that does not say which kind
 * of run it was is refused rather than read as weekly: the cheap wrong answer
 * here is the one that silently promotes on a pull-request row, and it is cheap
 * precisely because nothing about it looks wrong afterwards.
 */
export function refusalFor(run) {
  if (run === null || run === undefined || typeof run !== "object" || Array.isArray(run)) {
    return "there is no run row to read — pass --run <file.json>, or --repo and --sha.";
  }
  if (run.weekly !== true) {
    const said = run.weekly === undefined ? "absent" : JSON.stringify(run.weekly);
    return `the row's weekly is ${said}, and only a weekly run graduates a case — a pull-request run ` +
      `scores a 40-item subset against one branch's tree, so a case promoted on that evidence would let ` +
      `one branch raise the bar for main. Absent is a value and is never inferred.`;
  }
  if (typeof run.finishedAt !== "number" || !Number.isFinite(run.finishedAt)) {
    return "the row has no finishedAt, and graduatedAt records when the case passed, not when this script ran.";
  }
  if (caseResults(run) === null) {
    return "the row carries no per-case results, and a graduation reads passK off one — `failures` is the " +
      "failing half of the run and can graduate nothing.";
  }
  return null;
}

/**
 * Tom's sentence for one item, wherever this item shape keeps it.
 *
 * A run item states it as `expected.rubric` — the sentence he wrote judging the
 * output. The older rulings items (scripts/export-golden.mjs) carry it as
 * `sentence`, and both are read so a --list line never comes out empty for want
 * of one field name.
 */
export function rubricOf(item) {
  const rubric = item?.expected?.rubric;
  if (typeof rubric === "string" && rubric !== "") return rubric;
  return typeof item?.sentence === "string" ? item.sentence : "";
}

/** One line of a tab-separated list stays one line: a rubric's own newlines
 *  would otherwise split a row in two and no column would line up again. */
export function clip(text, width = RUBRIC_WIDTH) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

/**
 * The graduated item.
 *
 * `graduatedAt` IS THE RUN'S finishedAt, NEVER Date.now(). The fact being
 * recorded is when the case passed, not when somebody got round to running this
 * — and it makes the rewrite reproducible: the same row put through this script
 * next month writes the same bytes.
 *
 * `verdict` IS LEFT ALONE. It is a compatibility shim, kept so that
 * worker/jobs/evals.mjs's verdictOf, selectItems and aggregate need no change
 * for the new item kind: all three read `verdict`, a run item carries one, and
 * `kind` is the real field. Phase 9's retirement matrix
 * (docs/lifeos-retirement.md) gains a line for `verdict` on a golden item;
 * until it does, rewriting or dropping it here would break three readers to
 * tidy one field.
 *
 * Every other field is copied through untouched. The spread preserves key
 * order, `kind` is rewritten where it already stands, and `graduatedAt` is the
 * one new key.
 */
export function rewrite(item, at) {
  return { ...item, kind: "regression", graduatedAt: at };
}

/**
 * What this run graduates, what it does not, and how much of the set was
 * promoted already. Pure: it touches neither the network nor the disk, and the
 * caller does the writing.
 *
 * `items` is the loader's output — `{ file, item }` records, the path BESIDE
 * the item rather than inside it, because a graduation is a file rewrite and
 * the item itself has to come out byte for byte as it went in.
 *
 * THE THREE OUTCOMES, and the one non-outcome:
 *  - a capability case whose passK is true GRADUATES;
 *  - a capability case that passK does not say yes for is SKIPPED, with the
 *    reason travelling with it;
 *  - an item already kind "regression" is UNTOUCHED and counted, which is what
 *    makes a second run of this a no-op;
 *  - an item with NO `kind` at all is not part of this question and is counted
 *    nowhere. The older golden items predate both the field and the lifecycle,
 *    and folding the whole set into "untouched" would make that number mean
 *    "the size of the golden set" instead of "cases already promoted".
 */
export function graduationsFrom(run, items) {
  const refusal = refusalFor(run);
  if (refusal !== null) return { graduated: [], skipped: [], untouched: 0, refusal };
  const byId = new Map(caseResults(run).map((result) => [result.id, result]));
  const graduated = [];
  const skipped = [];
  let untouched = 0;
  for (const record of items ?? []) {
    const item = record?.item ?? record;
    if (item?.kind === "regression") {
      untouched += 1;
      continue;
    }
    if (item?.kind !== "capability") continue;
    const result = byId.get(item.id);
    if (result === undefined) {
      skipped.push({ id: item.id, why: "not scored by this run" });
      continue;
    }
    // passK, NOT judged. `judged` is the gate's verdict, and the gate passes an
    // item that passed ANY head trial (worker/jobs/evals.mjs runTrials keeps
    // the first passing one); `passK` is true only when EVERY trial passed.
    // Promoting a case into the set that gates every future merge rests on
    // every trial — a case that passes one time in three is a flaky case, and a
    // flaky case in the regression set is a merge denied at random.
    if (result.passK === undefined || result.passK === null) {
      skipped.push({
        id: item.id,
        why: "passK absent — the row does not say whether every trial passed, and a case graduates on every trial, not on one",
      });
      continue;
    }
    if (result.passK !== true) {
      skipped.push({ id: item.id, why: "passK false — the case did not pass every trial of this run" });
      continue;
    }
    graduated.push({
      id: item.id,
      sentence: rubricOf(item),
      file: record?.file ?? null,
      partition: item.partition ?? "",
      item: rewrite(item, run.finishedAt),
    });
  }
  graduated.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  skipped.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { graduated, skipped, untouched, refusal: null };
}

/**
 * Every golden item of a checkout, with the file it came out of.
 *
 * THE LAYOUT IS worker/jobs/evals.mjs loadGolden's — evals/golden/ and ONE
 * level below it, the directories discovered rather than listed, so
 * evals/golden/runs/ needs no edit here. loadGolden itself is not imported for
 * two reasons: it returns items with no path, and a rewrite is nothing but a
 * path plus an item; and that file is a box file that imports the worker's
 * tts-lib, which a laptop script has no business dragging in.
 */
export function loadItems(goldenDir) {
  if (!fs.existsSync(goldenDir)) return [];
  const roots = [goldenDir];
  for (const entry of fs.readdirSync(goldenDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) roots.push(path.join(goldenDir, entry.name));
  }
  const records = [];
  for (const dir of roots) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      if (!fs.statSync(file).isFile()) continue;
      records.push({ file, item: JSON.parse(fs.readFileSync(file, "utf8")) });
    }
  }
  return records.sort((a, b) => String(a.item?.id).localeCompare(String(b.item?.id)));
}

/**
 * The one line printed on every run.
 *
 * Three numbers and no adjectives. "Still failing" is every capability case
 * that did NOT graduate, which includes the handful this run did not score at
 * all — that distinction is real and it lives in each skipped case's own
 * reason, not in a fourth number nobody would read.
 */
export function summarise({ graduated, skipped, untouched }) {
  return `graduation: ${graduated.length} capability cases graduated, ${skipped.length} still failing, ${untouched} untouched.`;
}

const FLAGS = new Set(["--dry-run", "--list"]);
const VALUED = new Set(["--run", "--golden", "--repo", "--sha"]);

export function parseArgs(argv) {
  const options = { run: null, golden: DEFAULT_GOLDEN, repo: null, sha: null, dryRun: false, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (FLAGS.has(argument)) {
      options[argument === "--dry-run" ? "dryRun" : "list"] = true;
      continue;
    }
    if (!VALUED.has(argument)) throw new Error(`unknown argument ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} needs a value`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  // The two sources are ALTERNATIVES, and both at once is refused rather than
  // quietly resolved: somebody who passed a file and a sha meant one of them,
  // and a script that silently picked the file would have graduated cases off a
  // row he believes came off the wire.
  if (options.run !== null && (options.repo !== null || options.sha !== null)) {
    throw new Error("--run reads a row from a file and --repo/--sha read one from Convex; give one or the other");
  }
  if (options.run === null && (options.repo === null || options.sha === null)) {
    throw new Error("--run <file.json>, or both --repo and --sha, is required");
  }
  return options;
}

/** The row from Convex, read the way scripts/export-golden.mjs reads its own
 *  input. Called only when --run was not given, so a --run invocation opens no
 *  socket and needs no credential in the environment at all. */
async function fetchRun({ repo, sha }) {
  const site = process.env.CONVEX_SITE_URL;
  const key = process.env.TTS_WORKER_KEY;
  if (!site || !key) {
    console.error(
      "graduate-golden: CONVEX_SITE_URL and TTS_WORKER_KEY must be set to read a run row from Convex — or pass --run <file.json>.",
    );
    process.exit(2);
  }
  const route = `/tts/evals-run?repo=${encodeURIComponent(repo)}&sha=${encodeURIComponent(sha)}`;
  const response = await fetch(`${site.replace(/\/+$/, "")}${route}`, { headers: { "X-TTS-Key": key } });
  if (!response.ok) {
    console.error(`graduate-golden: /tts/evals-run -> HTTP ${response.status}`);
    process.exit(2);
  }
  return runFrom(await response.json());
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const run = options.run === null
    ? await fetchRun(options)
    : runFrom(JSON.parse(fs.readFileSync(options.run, "utf8")));
  const result = graduationsFrom(run, loadItems(options.golden));
  if (!options.dryRun) {
    for (const graduation of result.graduated) {
      fs.writeFileSync(graduation.file, `${JSON.stringify(graduation.item, null, 2)}\n`);
    }
  }
  if (options.list) {
    for (const graduation of result.graduated) {
      console.log(`${graduation.id}\t${graduation.partition}\t${clip(graduation.sentence)}`);
    }
  }
  // The refusal goes to stderr and the summary to stdout even then: a caller
  // reading the last line of stdout gets the same shape of answer whether the
  // row graduated nothing because nothing passed or because it was the wrong
  // kind of run, and the reason is on the stream that carries reasons.
  if (result.refusal !== null) console.error(`graduate-golden: refused — ${result.refusal}`);
  console.log(summarise(result));
  if (result.refusal !== null) process.exit(2);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`graduate-golden: ${error.message}`);
    process.exit(2);
  });
}
