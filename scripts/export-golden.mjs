/**
// NO SHEBANG LINE, for nightly.mjs's reason (worker/jobs/write-slack.mjs says
// it too): this file is imported by its own test, and the test bundler
// rewrites an imported module by prepending an import — which lands in front
// of a shebang and fails to parse. Every caller already names the interpreter.
 * export-golden.mjs - builds the golden set out of Tom's own rulings.
 *
 * A dtsRulings row with verdict "revise" is a failed output plus the one
 * sentence saying what was wrong with it; an "approve" is a pass. Those are
 * labels, already written, and this script turns them into files.
 *
 * The one hard part: a revise ruling's judged output is gone from the live row,
 * because the prepare pass re-prepares on a pending revise and overwrites the
 * fields. The text survives in exactly one place - the nightly snapshot in
 * WikiTom (worker/jobs/nightly.mjs snapshotStep), which writes every row's full
 * state each night. So the output Tom judged is the row as it stood in the
 * newest snapshot commit at or before the ruling. A ruling with no snapshot
 * behind it is skipped and counted, never guessed at.
 *
 * Sibling: scripts/check-writing-standard.mjs is the mechanical half of the
 * same question - regex rules over stored explanations, ratcheting a baseline.
 * This is the semantic half. Neither replaces the other.
 *
 *   node scripts/export-golden.mjs [--source rulings|labels|both]
 *                                  [--wikitom DIR] [--out evals/golden] [--dry-run] [--list]
 *
 * TWO SOURCES, ONE SCRIPT. `--source labels` mines the runLabels table instead
 * of the snapshot: every act of Tom's about a registered run - a ruling, an
 * objection, an emoji on the digest - is a label, and a judgment label is an
 * eval case whose rubric is his own sentence. It is a flag and NOT a second
 * script, because the two sources share every rule that decides what a golden
 * item IS: the id rule, the dedupe, the credential-shaped-text drop, the
 * write-out and the summary. Splitting them would be two spellings of one
 * definition, and the two would drift.
 *
 * THE FLAG SELECTS THE READER AND THE OUTPUT DIRECTORY AND NOTHING ELSE.
 *
 *   rulings  GET /tts/golden-input   ->  evals/golden/*.json
 *   labels   GET /tts/label-input    ->  evals/golden/runs/*.json
 *
 * The run-derived cases go in their own directory because worker/jobs/evals.mjs
 * loadGolden DISCOVERS one level of directories - so a new directory is the
 * entire wiring for a new set, with no edit to the loader, to goldenHash or to
 * selectItems. The two hand-maintained sets beside it (`explanations/`, mined
 * by scripts/import-explanation-golden.mjs, and `learning/`) are not touched by
 * either pass.
 *
 * Credentials the check-writing-standard.mjs way: CONVEX_SITE_URL and
 * TTS_WORKER_KEY in the environment, X-TTS-Key on the request.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../worker/session-host/redact.mjs";
import { assemblePrelude } from "./prelude.mjs";

/** Where the nightly job writes the snapshot inside the WikiTom checkout. */
export const SNAPSHOT_DIR = "tts/snapshot";
export const DEFAULT_OUT = "evals/golden";
/** The run-derived set's own directory, one level below the rulings set. It is
 *  a NAME AND NOT A REGISTRATION: loadGolden walks whatever directories it
 *  finds here. */
export const RUNS_SUBDIR = "runs";
/** The laptop checkout; the box passes WIKITOM_DIR (/root/wikitom). */
export const DEFAULT_WIKITOM = process.env.WIKITOM_DIR || "C:/Users/heffn/Desktop/WikiTom";

/** The table each job's judged output lives in, and the fields Tom ruled on. */
export const JOB_TABLES = Object.freeze({
  prepare: { table: "dtsTodos", fields: ["brief", "entryAction", "workDescription", "groundUpExplanation"] },
  "code-brief": { table: "dtsCodeBriefs", fields: ["brief", "recommendation", "execClass", "evidence"] },
  "batch-plan": { table: "batches", fields: ["groundUpExplanation"] },
});

export function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * The blob of `rel` in the newest commit whose committer date is at or before
 * `at`. Null when no such commit touched the path - which means the ruling
 * predates the snapshot and the item cannot be built.
 */
export function snapshotAt(dir, rel, at) {
  const sha = git(dir, "log", "-1", "--format=%H", `--before=${Math.floor(at / 1000)}`, "--", rel).trim();
  if (sha === "") return null;
  try {
    return { sha, text: git(dir, "show", `${sha}:${rel}`) };
  } catch {
    return null;
  }
}

/** The commit that held the snapshot directory at or before `at`. */
export function snapshotCommitAt(dir, at) {
  const sha = git(dir, "log", "-1", "--format=%H", `--before=${Math.floor(at / 1000)}`, "--", SNAPSHOT_DIR).trim();
  return sha === "" ? null : sha;
}

/** True for either form the nightly job writes (nightly.mjs isTableFile). */
export function isTableFile(table, name) {
  return name === `${table}.jsonl` || new RegExp(`^${table}\\.part\\d+\\.jsonl\\.gz$`).test(name);
}

/**
 * Every row of one table at one snapshot commit, keyed by _id. Handles both
 * forms planTableFiles writes: the plain .jsonl and the gzipped .partNN parts.
 */
export function snapshotRows(dir, sha, table) {
  const names = git(dir, "ls-tree", "--name-only", sha, "--", `${SNAPSHOT_DIR}/`)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => path.posix.basename(line))
    .filter((name) => isTableFile(table, name));
  const rows = new Map();
  for (const name of names) {
    const rel = `${SNAPSHOT_DIR}/${name}`;
    const raw = name.endsWith(".gz")
      ? zlib.gunzipSync(execFileSync("git", ["-C", dir, "show", `${sha}:${rel}`], {
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      })).toString("utf8")
      : git(dir, "show", `${sha}:${rel}`);
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row._id === "string") rows.set(row._id, row);
      } catch {
        // A truncated tail in an old snapshot is not worth failing an export.
      }
    }
  }
  return rows;
}

/** Lowercase, [a-z0-9-] only - the id has to be a filename. */
export function slug(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "none";
}

/** `<job>-<category>-<first 12 of the ruling id>`, stable across exports. */
export function goldenId(item) {
  const category = item.partition.includes("/") ? item.partition.split("/").slice(1).join("/") : item.partition;
  return `${slug(item.job)}-${slug(category)}-${String(item.rulingId).slice(0, 12)}`;
}

/**
 * The sentence the run that produced the judged output actually saw: the newest
 * APPLIED revise ruling on the same subject strictly before this one. Never the
 * sentence of the ruling being used as the label - handing the regeneration the
 * answer is exactly what would make the eval a lie.
 */
export function priorReviseSentence(item, allItems) {
  const key = JSON.stringify(item.subject);
  const earlier = allItems
    .filter((other) =>
      JSON.stringify(other.subject) === key &&
      other.verdict === "revise" &&
      other.ruledAt < item.ruledAt &&
      other.appliedAt !== null && other.appliedAt !== undefined &&
      typeof other.sentence === "string" && other.sentence !== "")
    .sort((a, b) => b.ruledAt - a.ruledAt);
  return earlier[0]?.sentence ?? null;
}

/** The New York calendar day of an instant, which is the `today` a prepare run
 *  was given and the day a bare month+day in the output resolves against. */
export function nyDay(at) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

/**
 * A golden item is compared text-for-text by a judge, so an item whose text
 * redactSecrets would change is DROPPED WHOLE rather than redacted and kept: a
 * "[redacted:github]" marker in the middle of an output is a difference the
 * judge would score, and the item is worthless anyway.
 */
export function hasCredentialShapedText(item) {
  const text = JSON.stringify(item);
  return redactSecrets(text) !== text;
}

/** One item in the golden-item file shape, or null when the snapshot cannot
 *  supply the output Tom actually ruled on. */
export function buildItem(candidate, snapshot, allCandidates) {
  const spec = JOB_TABLES[candidate.job];
  if (spec === undefined) return null;
  const row = snapshot.rows.get(candidate.resolution.rowId);
  if (row === undefined) return null;
  const output = {};
  for (const field of spec.fields) {
    if (row[field] !== undefined && row[field] !== null) output[field] = row[field];
  }
  if (Object.keys(output).length === 0) return null;
  // The input as it stood then, not as it stands now: the statement or the
  // category can have been edited since, and the output was written from the
  // older one.
  const input = { ...candidate.resolution.input };
  for (const field of ["statement", "source", "provenance", "category", "createdAt"]) {
    if (row[field] !== undefined) input[field] = row[field];
  }
  return {
    id: goldenId(candidate),
    job: candidate.job,
    partition: candidate.partition,
    verdict: candidate.verdict,
    sentence: candidate.sentence ?? null,
    ruledAt: candidate.ruledAt,
    ruledOn: nyDay(candidate.ruledAt),
    rulingId: candidate.rulingId,
    subject: candidate.subject,
    snapshot: { commit: snapshot.sha, path: `${SNAPSHOT_DIR}/${spec.table}.jsonl` },
    input: {
      ...input,
      priorReviseSentence: priorReviseSentence(candidate, allCandidates),
      today: nyDay(candidate.ruledAt),
    },
    output,
  };
}

/** Every item the input yields, with the counts that say what was lost and why. */
export function buildGoldenSet(candidates, readSnapshot) {
  const items = [];
  let unbuildable = 0;
  let redacted = 0;
  for (const candidate of candidates) {
    const spec = JOB_TABLES[candidate.job];
    const snapshot = spec === undefined ? null : readSnapshot(spec.table, candidate.ruledAt);
    if (snapshot === null) {
      unbuildable += 1;
      continue;
    }
    const item = buildItem(candidate, snapshot, candidates);
    if (item === null) {
      unbuildable += 1;
      continue;
    }
    if (hasCredentialShapedText(item)) {
      redacted += 1;
      continue;
    }
    items.push(item);
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  return { items, unbuildable, redacted };
}

export function summarise({ items, unbuildable, redacted }) {
  const partitions = new Set(items.map((item) => item.partition));
  const approve = items.filter((item) => item.verdict === "approve").length;
  return `golden set: ${items.length} items in ${partitions.size} partitions ` +
    `(${approve} approve, ${items.length - approve} revise); ` +
    `${unbuildable} rulings unbuildable (no snapshot), ${redacted} dropped (credential-shaped text).`;
}

// ── The labels source ───────────────────────────────────────────────────────
//
// Everything below turns ONE runLabels row into ONE golden item. The row is
// already a judgment of Tom's about one run's output; what this half adds is
// the prompt/prelude split, the intent dedupe, and the two-word verdict the
// existing runner still reads.

/** `good` and `bad` are the only polarities that name a direction, and only a
 *  judgment label reaches this script at all. A `mixed` or `neutral` row is a
 *  record of something Tom did, not a statement that the text was right or
 *  wrong, and there is no honest kind to give it. */
export const KIND_BY_POLARITY = Object.freeze({ good: "regression", bad: "capability" });

/**
 * TWO WORDS FOR ONE FACT, ON PURPOSE AND WITH AN END DATE.
 *
 * `kind` is the vocabulary this round introduced; `verdict` is the old one that
 * verdictOf, selectItems and aggregate's byVerdict in worker/jobs/evals.mjs are
 * written against. Carrying both means a run-derived case scores through the
 * landed machinery with NO change to any of those three - which is the whole
 * reason the shim exists. It is still a smell, so phase 9's retirement list
 * gains one line: `verdict` on a golden item, superseded by `kind`.
 */
export const VERDICT_BY_POLARITY = Object.freeze({ good: "approve", bad: "revise" });

/** How many times a case is regenerated on the weekly run. Stored ON THE ITEM
 *  rather than derived by the runner, so a case Tom wants run more often is one
 *  file edit and not a rule change (worker/jobs/evals.mjs trialsFor reads it). */
export const TRIALS_BY_KIND = Object.freeze({ regression: 3, capability: 5 });

/** `run-<source>-<first 12 of the label id>`, stable across exports and
 *  filename-safe, the same shape and for the same reason as goldenId. */
export function runGoldenId(label) {
  return `run-${slug(label.source)}-${slug(String(label.labelId ?? "").slice(0, 12))}`;
}

/**
 * THE PROMPT IS SPLIT INTO PRELUDE AND TASK, and the prelude half is thrown
 * away: the runner RE-ASSEMBLES it from the tree under test and prepends it to
 * the task. Replaying the recorded prompt verbatim would score the context tree
 * the run HAD rather than the one under test, which would make the eval unable
 * to gate a context change - the one thing it exists to do.
 *
 * The seam is exactly one newline, because that is what the runner puts back:
 * `${context.prelude(names).text}\n${item.input.task}`. A prompt whose prelude
 * is followed by anything else - no newline, a space, a second header - is
 * refused rather than split at a guess, because a split that does not rebuild
 * the original bytes is a silently different prompt.
 *
 * Returns `{ preludeKnown: true, task }`, or null when no split can be made.
 */
export function splitPrelude(prompt, preludeText) {
  if (typeof prompt !== "string" || typeof preludeText !== "string" || preludeText === "") return null;
  const seam = `${preludeText}\n`;
  if (!prompt.startsWith(seam)) return null;
  return { preludeKnown: true, task: prompt.slice(seam.length) };
}

/**
 * The prelude one run was given, re-assembled at THAT run's WikiTom commit.
 *
 * This is not a second assembler: it is scripts/prelude.mjs's own
 * assemblePrelude, the same function worker/jobs/evals.mjs reaches through
 * `prelude.mjs --layers`, called in process because this script already lives
 * in the tree it would otherwise spawn.
 *
 * Returns `{ text }`, or `{ reason }` naming why the run's prefix cannot be
 * reproduced. Every reason is counted and none is guessed around.
 */
export function preludeTextFor(wikitom, context, assemble = assemblePrelude) {
  if (context?.layersKnown !== true) return { reason: "the run recorded no layer selection" };
  const layers = context.layersGiven ?? [];
  if (layers.length === 0) return { reason: "the run was given no layers" };
  // The skill half has no assembler yet (worker/jobs/evals.mjs calls that the
  // phase 6 seam). Splitting on the layer text alone would leave the skill text
  // sitting at the front of `task`, where it would be replayed verbatim while
  // claiming to be the run's own work - a corruption with no symptom.
  if ((context.skillsUsed ?? []).length > 0) return { reason: "the run was given skills, which no assembler here can rebuild" };
  const commit = context.wikitomCommit;
  if (typeof commit !== "string" || commit === "") return { reason: "the run recorded no WikiTom commit" };
  try {
    return { text: assemble({ wikitom, commit, layers }).text };
  } catch (error) {
    // A commit the checkout does not have, or a layer file that was absent at
    // it. An honest count beats a guessed split.
    return { reason: `the prelude cannot be assembled at the run's commit (${error.message})` };
  }
}

/** The text Tom judged: the span rows' assistant text. Separate rows were
 *  separate turns, so they are joined with a blank line rather than run
 *  together, which would fuse the end of one turn onto the start of the next. */
export function outputTextOf(rows) {
  return (rows?.spanRows ?? [])
    .map((row) => row?.content?.text)
    .filter((text) => typeof text === "string" && text.trim() !== "")
    .join("\n\n");
}

/**
 * WHAT ONE BEHAVIOUR UNDER TEST IS: a subject and the job that wrote for it.
 *
 * Tom ruling three times on one todo's prepare output over a week is one
 * behaviour, not three. Keeping all three would triple-weight that todo in
 * every aggregate and would fill selectItems's newest-N window with one
 * argument. A reaction on the digest and a ruling on a todo are different
 * intents and both survive.
 *
 * The subject half is ttsRulings.subjectKey's own spelling, supplied by the
 * route. A label with no subject is a digest reaction - the digest has no
 * ruling subject - so it keys on the New York day it happened, which is what
 * collapses two emoji on one morning into one case.
 */
export function intentKeyOf(label) {
  const supplied = label?.link?.subjectKey;
  const subject = typeof supplied === "string" && supplied.trim() !== ""
    ? supplied
    // The source stays in the fallback for anything that is NOT a digest
    // reaction, so a sourceless objection cannot collapse into that morning's
    // emoji just because they share a day.
    : `${label.source === "digest-reaction" ? "digest" : label.source}:${nyDay(label.at)}`;
  return `${subject}|${label.run?.origin ?? "unknown"}:${label.run?.kind ?? "unknown"}`;
}

/**
 * One golden item out of one label, or `{ unbuildable: <reason> }`.
 *
 * A case that cannot carry its prelude split is NOT dropped: it is written with
 * `preludeKnown: false` and the WHOLE PROMPT VERBATIM, because every laptop
 * terminal and everything from before runs were registered is in that state and
 * dropping them would throw away most of the corpus. Such a case scores the
 * builders and the judge but not the layers - it is BLIND TO A LAYER CHANGE -
 * so it is counted apart and the weekly line says how many there are. It is
 * also never used as ablation evidence, because you cannot ablate a name
 * nobody recorded; worker/jobs/evals.mjs ablationFor enforces that, and this is
 * the other end of the same rule.
 */
export function buildRunCase(label, preludeFor) {
  const kind = KIND_BY_POLARITY[label?.polarity];
  if (kind === undefined) return { unbuildable: "the polarity names no direction" };
  if (label.run === null || label.run === undefined) return { unbuildable: "the label named no run" };
  const rubric = typeof label.meaning === "string" ? label.meaning.trim() : "";
  if (rubric === "") return { unbuildable: "the label carries no sentence" };
  const text = outputTextOf(label.rows);
  if (text === "") return { unbuildable: "the run recorded no text to judge" };
  // The recorded row is the bytes the run was actually handed; the run's own
  // context field is the same string when both exist, and the fallback for a
  // run whose context row was pruned.
  const prompt = label.rows?.contextRow?.content?.prompt ?? label.run.context?.prompt ?? null;
  const context = label.run.context ?? {};
  const assembled = typeof prompt === "string" && prompt !== ""
    ? preludeFor(context)
    : { reason: "the run recorded no prompt" };
  const split = assembled.text === undefined ? null : splitPrelude(prompt, assembled.text);
  const blindReason = split !== null
    ? null
    : assembled.reason ?? "the assembled prelude is not the prompt's prefix";
  if (split === null && (typeof prompt !== "string" || prompt === "")) {
    return { unbuildable: "the run recorded neither a prompt nor a prelude" };
  }
  const seqs = (label.rows?.spanRows ?? [])
    .map((row) => row?.seq)
    .filter((seq) => Number.isInteger(seq));
  return {
    blindReason,
    item: {
      id: runGoldenId(label),
      job: "run",
      partition: `${RUNS_SUBDIR}/${slug(label.run.origin)}`,
      kind,
      verdict: VERDICT_BY_POLARITY[label.polarity],
      // EVERY run-derived case is confirmed, because every one of them is an
      // act of his: a ruling he made, an objection he typed, an emoji he
      // tapped. The field exists for the 27 mined explanations, which were
      // INFERRED from his reactions in old transcripts and which he has not
      // been through. A label is not inferred.
      confirmedByTom: true,
      trials: TRIALS_BY_KIND[kind],
      negative: false,
      labelId: label.labelId,
      labelSource: label.source,
      runId: label.run.runId,
      at: label.at,
      intentKey: intentKeyOf(label),
      input: {
        ...(split ?? { preludeKnown: false, task: null }),
        preludeNames: { layers: context.layersGiven ?? [], skills: context.skillsUsed ?? [] },
        prompt: split === null ? prompt : null,
        contextRowSeq: label.rows?.contextRow?.seq ?? null,
        spanSeqs: seqs.length === 0 ? null : [Math.min(...seqs), Math.max(...seqs)],
      },
      // THE RUBRIC IS THE ANSWER, so it lives here and NEVER in `input`. A
      // regeneration handed the sentence it is being judged against proves
      // nothing; the runner has a run-time honesty check that fails any prompt
      // containing it, and this is where that check is made keepable.
      expected: { rubric, target: kind === "capability" ? rubric : null },
      output: { text },
    },
  };
}

/** Newest label wins one intent; the rest are counted, never written. The tie
 *  break is the id, so two labels at one instant order the same way twice. */
export function dedupeByIntent(items) {
  const newest = new Map();
  for (const item of items) {
    const held = newest.get(item.intentKey);
    if (held === undefined || item.at > held.at || (item.at === held.at && item.id > held.id)) {
      newest.set(item.intentKey, item);
    }
  }
  const kept = [...newest.values()];
  return { items: kept, superseded: items.length - kept.length };
}

/** Every run case the labels yield, with the counts that say what was lost and
 *  why. `preludeFor` is the seam the tests drive: a function of the run's
 *  context returning `{ text }` or `{ reason }`. */
export function buildRunGoldenSet(labels, preludeFor) {
  const built = [];
  let redacted = 0;
  const unbuildableReasons = new Map();
  const blindReasons = new Map();
  const count = (map, reason) => map.set(reason, (map.get(reason) ?? 0) + 1);
  for (const label of labels) {
    const result = buildRunCase(label, preludeFor);
    if (result.unbuildable !== undefined) {
      count(unbuildableReasons, result.unbuildable);
      continue;
    }
    if (hasCredentialShapedText(result.item)) {
      redacted += 1;
      continue;
    }
    if (result.blindReason !== null) count(blindReasons, result.blindReason);
    built.push(result.item);
  }
  const { items, superseded } = dedupeByIntent(built);
  items.sort((a, b) => a.id.localeCompare(b.id));
  return {
    items,
    unbuildable: [...unbuildableReasons.values()].reduce((total, n) => total + n, 0),
    unbuildableReasons,
    blind: items.filter((item) => item.input.preludeKnown !== true).length,
    blindReasons,
    superseded,
    redacted,
  };
}

export function summariseRuns({ items, unbuildable, unbuildableReasons, superseded, redacted, blind }) {
  const partitions = new Set(items.map((item) => item.partition));
  const regression = items.filter((item) => item.kind === "regression").length;
  const reasons = [...unbuildableReasons.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${reason} ${n}`)
    .join(", ");
  return `golden set (labels): ${items.length} items in ${partitions.size} partitions ` +
    `(${regression} regression, ${items.length - regression} capability); ` +
    `${unbuildable} unbuildable (${reasons}), ${superseded} superseded, ` +
    `${redacted} dropped (credential-shaped text), ${blind} blind to a layer change.`;
}

// ── The command line ────────────────────────────────────────────────────────

export const SOURCES = Object.freeze(["rulings", "labels", "both"]);

function parseArgs(argv) {
  const options = { source: "both", wikitom: DEFAULT_WIKITOM, out: DEFAULT_OUT, dryRun: false, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--list") options.list = true;
    else if (argument === "--wikitom" || argument === "--out" || argument === "--source") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${argument} needs a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else throw new Error(`unknown argument ${argument}`);
  }
  if (!SOURCES.includes(options.source)) throw new Error(`--source must be one of ${SOURCES.join(", ")}`);
  return options;
}

/**
 * ONE SOURCE'S DIRECTORY, wiped and rewritten.
 *
 * The wipe is `readdirSync` plus `endsWith(".json")`, which is exactly what
 * keeps it scoped: a directory entry never ends in `.json`, so the rulings pass
 * cannot reach `runs/`, `explanations/` or `learning/`, and the labels pass -
 * whose directory holds nothing else - cannot reach up. Neither pass ever sees
 * the other's directory.
 */
function rewriteDir(dir, items) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".json")) fs.rmSync(path.join(dir, name));
  }
  for (const item of items) {
    fs.writeFileSync(path.join(dir, `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`);
  }
}

async function readInput(site, key, route) {
  const response = await fetch(`${site.replace(/\/+$/, "")}${route}`, { headers: { "X-TTS-Key": key } });
  if (!response.ok) {
    console.error(`export-golden: ${route} -> HTTP ${response.status}`);
    process.exit(2);
  }
  return await response.json();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const site = process.env.CONVEX_SITE_URL;
  const key = process.env.TTS_WORKER_KEY;
  if (!site || !key) {
    console.error(
      "export-golden: CONVEX_SITE_URL and TTS_WORKER_KEY must be set - the exporter reads the ruling table in prod.",
    );
    process.exit(2);
  }
  if (options.source === "rulings" || options.source === "both") {
    const { items: candidates } = await readInput(site, key, "/tts/golden-input");
    const cache = new Map();
    const readSnapshot = (table, at) => {
      const sha = snapshotCommitAt(options.wikitom, at);
      if (sha === null) return null;
      const cacheKey = `${sha}:${table}`;
      if (!cache.has(cacheKey)) cache.set(cacheKey, { sha, rows: snapshotRows(options.wikitom, sha, table) });
      return cache.get(cacheKey);
    };
    const result = buildGoldenSet(candidates, readSnapshot);
    if (!options.dryRun) rewriteDir(options.out, result.items);
    if (options.list) {
      for (const item of result.items) console.log(`${item.id}\t${item.partition}\t${item.verdict}\t${item.ruledOn}`);
    }
    console.log(summarise(result));
  }
  if (options.source === "labels" || options.source === "both") {
    const { items: labels } = await readInput(site, key, "/tts/label-input");
    // ONE ASSEMBLY PER COMMIT AND LAYER SET. A week of rulings on one todo is
    // a week of runs at a handful of WikiTom commits, and assembling the same
    // prelude once per label would be a git walk per case.
    const cache = new Map();
    const preludeFor = (context) => {
      const cacheKey = `${context?.wikitomCommit ?? ""}|${(context?.layersGiven ?? []).join(",")}` +
        `|${(context?.skillsUsed ?? []).join(",")}|${context?.layersKnown === true}`;
      if (!cache.has(cacheKey)) cache.set(cacheKey, preludeTextFor(options.wikitom, context));
      return cache.get(cacheKey);
    };
    const result = buildRunGoldenSet(labels, preludeFor);
    if (!options.dryRun) rewriteDir(path.join(options.out, RUNS_SUBDIR), result.items);
    if (options.list) {
      for (const item of result.items) {
        console.log(`${item.id}\t${item.partition}\t${item.kind}\t${nyDay(item.at)}\t${item.input.preludeKnown ? "layers" : "blind"}`);
      }
    }
    console.log(summariseRuns(result));
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`export-golden: ${error.message}`);
    process.exit(2);
  });
}
