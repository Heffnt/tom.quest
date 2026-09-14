/**
// NO SHEBANG LINE, for nightly.mjs's reason (scripts/export-golden.mjs and
// scripts/evals-check.mjs say it too): this file is imported by its own test,
// and the test bundler rewrites an imported module by prepending an import —
// which lands in front of a shebang and fails to parse. Every caller already
// names the interpreter (`node scripts/scaffold-negatives.mjs`).
 * scaffold-negatives.mjs — drafts the missing half of a trigger set.
 *
 * A TRIGGER CASE asks whether a layer's rules fire where they should and, the
 * half that decides whether the set is worth anything, do NOT fire where they
 * should not. A set of positives alone cannot fail a layer that has swallowed
 * every prompt in sight, so evals/triggers/ holds at least as many negatives as
 * positives in every file. This script drafts negatives to fill that quota:
 * one per positive already in the file, each an empty prompt and an empty
 * needle list for a person to complete.
 *
 * WHY IT DRAFTS AND DOES NOT WRITE THE SET
 *
 * A negative invented by a model and wrong does not merely fail — it fails
 * FOREVER, so the next reader learns that the file's red lines are noise and
 * stops reading them, and a real failure lands on a set already trained to be
 * ignored. That is strictly worse than having no case at all. So nothing here
 * writes a case that runs:
 *
 *   - this script writes `<stem>.draft.json` AND NOTHING ELSE;
 *   - a draft carries an empty prompt and an empty `mustNotName`, because the
 *     one thing a scaffold genuinely knows is that a negative is owed, not what
 *     it should say;
 *   - Tom confirms a case by writing it and RENAMING the file to `<stem>.json`;
 *   - the runner loads `evals/triggers/*.json` and ignores `*.draft.json`.
 *
 * That last line is the contract between the two halves — the loader lives in
 * worker/jobs/evals.mjs and is written against exactly this rule, so the rename
 * is the whole of confirmation and neither half can drift without the other
 * noticing. `confirmedByTom: false` rides on every drafted case for the same
 * reason it rides on a mined golden item: an item he has not been through is
 * run and reported, never used to fail a pull request.
 *
 * The headings a layer's own sources carry are read out of the ONE assembler,
 * scripts/prelude.mjs, the way worker/jobs/evals.mjs layersFor does it — by
 * running it and reading its `--json` form. The assembly is not re-implemented
 * here, and a rule heading that moves in WikiTom moves in the drafts with it.
 *
 *   node scripts/scaffold-negatives.mjs [--wikitom DIR] [--out evals/triggers] [--dry-run] [--list]
 *
 * No network, no model, no credentials: it runs one child process and writes
 * files under --out.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The laptop checkout; the box passes WIKITOM_DIR (/root/wikitom). The same
 *  default scripts/export-golden.mjs takes, and for the same reason: both read
 *  the vault and neither should need a flag on either machine. */
export const DEFAULT_WIKITOM = process.env.WIKITOM_DIR || "C:/Users/heffn/Desktop/WikiTom";
export const DEFAULT_OUT = "evals/triggers";

/** This checkout, so the prelude assembler is the one beside this file rather
 *  than whichever copy the working directory happens to sit in. */
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What a trigger file can be about. Every row is one file in evals/triggers/,
 * named `<kind>-<name>.json`.
 *
 * THE LAYERS ARE THE WHOLE TABLE TODAY. Phase 6 adds skills — a named bundle
 * of rules fetched for one run rather than carried on every run — and a skill
 * needs exactly the same question asked of it, more urgently: a skill that
 * fires on every prompt is a layer that nobody voted for. Its row goes here,
 * with its headings coming from the skill's own describe() rather than from a
 * WikiTom layer, and nothing else in this file changes:
 *
 *   // { name: "<skill>", kind: "skill", headings: (skill) => skill.describe().headings },
 */
export const SOURCES = Object.freeze([
  Object.freeze({ name: "operate", kind: "layer", layer: "operate" }),
  Object.freeze({ name: "write", kind: "layer", layer: "write" }),
  Object.freeze({ name: "know", kind: "layer", layer: "know" }),
]);

/** A source's file stem. The kind is in the name so a skill file and a layer
 *  file of the same name cannot collide once phase 6 lands. */
export function fileStem(source) {
  return `${source.kind}-${source.name}`;
}

/**
 * The rule headings of one assembled layer — the `## ` lines of the files it
 * renders. They are what a person writing the missing negative needs in front
 * of them: a negative is always "these rules, and not here".
 *
 * DEDUPED, because a layer is many files rendered into one text and the same
 * heading recurs across them — the know layer's eight area pages each carry a
 * "Current state", and eight identical entries in a hint list is eight times
 * the reading for none of the information.
 */
export function headingsOf(text) {
  return [...new Set([...String(text ?? "").matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((match) => match[1]))];
}

/**
 * The assembler's own metadata for a set of layers. Run, never re-implemented:
 * the layer selection, the area expansion and the file order are settled in
 * scripts/skills.mjs and read by two assemblers already, and a third
 * spelling of them here would drift the day WikiTom gains a file.
 */
export function readLayers(wikitom, names, run = execFileSync) {
  const script = path.join(REPO_ROOT, "scripts", "prelude.mjs");
  const args = ["--wikitom", wikitom, "--layers", names.join(","), "--json"];
  const out = run(process.execPath, [script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/** A case already in a trigger file that asserts a rule FIRES. `negative` is
 *  read as a flag and not as a truthy value, so a file that omits it on its
 *  positives still counts them. */
export function isPositive(one) {
  return one?.negative !== true;
}

/**
 * The draft for one source: one negative per positive the file already holds,
 * paired to it by id so a reader can see at a glance which positive is still
 * unbalanced. A source with no positives drafts no cases and is still written,
 * because "nothing is owed here" is an answer and an absent file is not.
 *
 * The prompt and the needles are LEFT EMPTY on purpose — see the header. What
 * the scaffold knows is that a negative is owed and which rules it is about;
 * what it must not guess is the prompt that proves it.
 */
export function draftFor(source, { headings = [], existing = null } = {}) {
  const positives = (existing?.cases ?? []).filter(isPositive);
  return {
    name: source.name,
    kind: source.kind,
    draft: true,
    note: `A draft, and nothing in it runs: the runner loads evals/triggers/*.json and ignores *.draft.json. ` +
      `Each case below is the negative one positive in ${fileStem(source)}.json still owes — write its prompt ` +
      `and its mustNotName needles, then rename this file to ${fileStem(source)}.json to put them in the set.`,
    // The layer's own rule headings, carried into the draft so the person
    // writing a prompt has the rules in front of them rather than in another
    // window. Read from the assembler, so they are this commit's headings.
    headings,
    cases: positives.map((positive) => ({
      id: `${positive.id}-neg`,
      negative: true,
      prompt: "",
      why: `the ${source.name} ${source.kind}'s rules must not fire on a prompt they have no reach over`,
      expect: { mustNotName: [] },
      confirmedByTom: false,
    })),
  };
}

/**
 * Every source's draft, and the files written for them. `io` carries the child
 * process and the disk, so the test drives this with neither.
 *
 * `--list` and `--dry-run` both write nothing; they differ only in what main()
 * prints, and the drafts are built either way so that what is reported is the
 * thing that would have been written.
 */
export function scaffold({ wikitom = DEFAULT_WIKITOM, out = DEFAULT_OUT, dryRun = false, list = false } = {}, io) {
  const layerNames = SOURCES.filter((source) => source.kind === "layer").map((source) => source.layer);
  const meta = layerNames.length === 0 ? { layers: {} } : io.layers(wikitom, layerNames);
  const drafts = SOURCES.map((source) => {
    const existing = io.existing(out, fileStem(source));
    return {
      source,
      file: path.join(out, `${fileStem(source)}.draft.json`),
      draft: draftFor(source, { headings: headingsOf(meta.layers?.[source.layer]), existing }),
      positives: (existing?.cases ?? []).filter(isPositive).length,
    };
  });
  const written = [];
  if (!dryRun && !list) {
    for (const one of drafts) {
      io.write(one.file, `${JSON.stringify(one.draft, null, 2)}\n`);
      written.push(one.file);
    }
  }
  return { commit: meta.commit ?? null, drafts, written };
}

/** The io a real run uses: one child process and the disk, and nothing else. */
export function realIo(run = execFileSync) {
  return {
    layers: (wikitom, names) => readLayers(wikitom, names, run),
    existing: (out, stem) => {
      const file = path.join(out, `${stem}.json`);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    },
    write: (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
  };
}

const FLAGS = new Set(["--dry-run", "--list"]);
const VALUED = new Set(["--wikitom", "--out"]);

export function parseArgs(argv) {
  const options = { wikitom: DEFAULT_WIKITOM, out: DEFAULT_OUT, dryRun: false, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const name = argument.includes("=") ? argument.slice(0, argument.indexOf("=")) : argument;
    if (FLAGS.has(name)) {
      options[name === "--dry-run" ? "dryRun" : "list"] = true;
      continue;
    }
    if (!VALUED.has(name)) throw new Error(`unknown argument ${argument}`);
    let value;
    if (argument.includes("=")) value = argument.slice(argument.indexOf("=") + 1);
    else {
      value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
      index += 1;
    }
    options[name.slice(2)] = value;
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const result = scaffold(options, realIo());
  for (const one of result.drafts) {
    const owed = one.draft.cases.length;
    const verb = options.list || options.dryRun ? "would draft" : "drafted";
    console.log(
      `${fileStem(one.source)}\t${one.positives} positive(s)\t${verb} ${owed} negative(s)\t${one.file}` +
        `${one.draft.headings.length === 0 ? "" : `\t[${one.draft.headings.join(", ")}]`}`,
    );
  }
  if (options.list || options.dryRun) console.log("nothing written");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`scaffold-negatives: ${error.message}`);
    process.exitCode = 2;
  }
}
