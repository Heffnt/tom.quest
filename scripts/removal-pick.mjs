// removal-pick.mjs — the removal loop's controller: which ONE violation the
// day's run removes. Deterministic code, never a model.
// NO SHEBANG LINE, for check-writing-standard.mjs's reason: the test beside it
// imports this file.
//
//   node scripts/removal-pick.mjs [--exclude <ruleId>-<fingerprint>,...]
//
// Prints one JSON object: `{ violation, live, baseline, excluded }`, where
// `violation` is the chosen record (removal-sensor.mjs's shape, with its
// estimate and matched text) or null when nothing is left to pick.
//
// IT RUNS INSIDE THE CHECKOUT IT MEASURES. worker/jobs/removal-loop.mjs runs
// from /opt/tts and shells out to this file in its own clone of the branch it
// works against, so the sensor, the rules and the baseline that decide the
// pick are always the same commit's. A job that imported its own copy of the
// ranking would pick with yesterday's rules against today's baseline.
//
// THE RANKING, in order: the lines the removal would delete, then the files it
// touches, fewest first — the smallest change is the one most likely to be
// right and cheapest to review — then the rule, the path and the fingerprint,
// which exist only so a tie breaks the same way twice. The estimates are the
// sensor's, measured at collection time; nothing here parses code.
//
// ONLY BASELINE VIOLATIONS ARE PICKED. On a branch the guardrails check keeps
// clean, live and baseline are the same set; where they are not, a violation
// that is live and not in the baseline is a change in flight, not the loop's.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { BASELINE_PATH, byteCompare, collect, keyOf, parseBaseline, realIo } from "./removal-sensor.mjs";

/** The branch a violation's pull request is cut on. Rule and fingerprint, not
 *  the path: two copies of one helper are one removal. */
export function branchFor(violation) {
  return `loop/removals/${violation.ruleId}-${violation.fingerprint}`;
}

/** What `--exclude` and a closed pull request's branch name both spell. */
function excludeKeyOf(violation) {
  return `${violation.ruleId}-${violation.fingerprint}`;
}

/** Smallest first; see the header for why each key is where it is. */
export function rank(violations) {
  return [...violations].sort(
    (a, b) =>
      a.lines - b.lines ||
      a.files - b.files ||
      byteCompare(a.ruleId, b.ruleId) ||
      byteCompare(a.path, b.path) ||
      byteCompare(a.fingerprint, b.fingerprint),
  );
}

/** The one violation to remove, or null. */
export function pickOne(violations, baselineKeys, excluded = []) {
  const inBaseline = new Set(baselineKeys);
  const skip = new Set(excluded);
  return rank(violations).find((v) => inBaseline.has(keyOf(v)) && !skip.has(excludeKeyOf(v))) ?? null;
}

function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--exclude");
  const excluded = at === -1 ? [] : String(argv[at + 1] ?? "").split(",").filter(Boolean);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const io = realIo(root);
  const live = collect(io);
  const baseline = parseBaseline(io.readFile(BASELINE_PATH));
  const violation = pickOne(live, baseline, excluded);
  console.log(JSON.stringify({ violation, live: live.length, baseline: baseline.length, excluded: excluded.length }));
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`removal-pick: ${error.message}`);
    process.exit(1);
  }
}
