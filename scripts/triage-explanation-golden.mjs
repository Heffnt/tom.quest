/**
 * NO SHEBANG LINE, for nightly.mjs's reason (worker/jobs/write-slack.mjs says
 * it too): this file is imported by its own test, and the test bundler rewrites
 * an imported module by prepending an import — which lands in front of a
 * shebang and fails to parse. Every caller already names the interpreter.
 *
 * Marks each mined explanation item `unreplayable`, or clears the mark.
 *
 * WHY THE MARK IS DERIVED AND NOT TYPED. The question an item answers is
 * whether the replay can be handed what the original agent had, and the only
 * thing that knows is the transcript: whether WikiTom's archive holds it, and
 * whether the agent reached for a tool after Tom's request. Both are read by
 * worker/jobs/evals-replay.mjs, so this script asks that module rather than
 * restating its rule — a second reading of the archive would be a second answer
 * to the same question.
 *
 * WHY IT IS AN AUTHORING SCRIPT AND NOT A CHECK. It needs the WikiTom archive,
 * which CI has no copy of and a public repository may not carry, so its ANSWER
 * is committed and the script is how the answer is re-derived when the archive
 * grows. Two of the 27 sessions post-date the last laptop archive; when the
 * next one lands, this is the one command that repairs them.
 *
 * Usage:
 *   node scripts/triage-explanation-golden.mjs
 *   node scripts/triage-explanation-golden.mjs --wikitom /root/wikitom --dry-run
 */
import fs from "node:fs";
import path from "node:path";
import { replayContext } from "../worker/jobs/evals-replay.mjs";

const GOLDEN_EXPLANATIONS = "evals/golden/explanations";

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

/**
 * One item's triage: the item as it should be on disk, and what changed.
 *
 * THE MARK IS A SENTENCE UNDER ONE KEY, `unreplayable`, and it is placed
 * directly after `confirmedByTom` so a reader of the file meets it before the
 * input it is about. A repaired item has the key REMOVED rather than set to
 * false: the runner reads presence, and a file carrying `unreplayable: false`
 * would be a second way to say the same thing.
 */
export function triageItem(item, wikitomTree, { replay = replayContext } = {}) {
  const context = replay(wikitomTree, item);
  const was = item.unreplayable ?? null;
  const now = context.unreplayable ?? null;
  if (was === now) return { item, changed: false, why: now };
  const next = {};
  for (const [key, value] of Object.entries(item)) {
    if (key === "unreplayable") continue;
    next[key] = value;
    if (key === "confirmedByTom" && now !== null) next.unreplayable = now;
  }
  // An item with no `confirmedByTom` to anchor to still gets the mark, at the
  // end, rather than silently going unmarked.
  if (now !== null && next.unreplayable === undefined) next.unreplayable = now;
  return { item: next, changed: true, why: now, from: was };
}

export function triage(dir, wikitomTree, { write = true, replay = replayContext } = {}) {
  const rows = [];
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort()) {
    const file = path.join(dir, name);
    const item = JSON.parse(fs.readFileSync(file, "utf8"));
    const result = triageItem(item, wikitomTree, { replay });
    if (result.changed && write) fs.writeFileSync(file, `${JSON.stringify(result.item, null, 2)}\n`);
    rows.push({ id: item.id, changed: result.changed, unreplayable: result.why });
  }
  return rows;
}

function main() {
  const args = process.argv.slice(2);
  const wikitom = optionValue(args, "--wikitom", process.env.WIKITOM_DIR ?? "/root/wikitom");
  const dir = optionValue(args, "--dir", GOLDEN_EXPLANATIONS);
  const dryRun = args.includes("--dry-run");
  const rows = triage(dir, wikitom, { write: !dryRun });
  for (const row of rows) {
    console.log(`${row.id}\t${row.unreplayable === null ? "replayable" : "unreplayable"}` +
      `${row.changed ? " (changed)" : ""}\t${row.unreplayable ?? ""}`);
  }
  const marked = rows.filter((row) => row.unreplayable !== null).length;
  console.log(`\n${rows.length - marked} replayable, ${marked} unreplayable${dryRun ? " (dry run, nothing written)" : ""}.`);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`) main();
