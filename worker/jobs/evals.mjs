// evals.mjs — the behaviour half of the evals layer, run on the Jarvis Box.
//
// The question: did changing a pinned file make the outputs worse? It is
// answered by re-running the jobs that write for Tom over the GOLDEN SET — the
// labelled items built out of his own rulings (scripts/export-golden.mjs) and
// out of the 27 mined explanations (scripts/import-explanation-golden.mjs) —
// and having a JUDGE score each new output against the ruling.
//
// Sibling: scripts/check-writing-standard.mjs is the mechanical half — regex
// rules over stored explanations, ratcheting a baseline. This is the semantic
// half. Neither replaces the other, and neither is folded into the other: one
// reads prod and gates nothing, this one gates a pull request and reads git.
//
// Plain Node ESM, ZERO npm dependencies — tts-lib.mjs's rule; this file lands
// in /opt/tts/ with the rest through worker/setup.sh.
//
//   node /opt/tts/evals.mjs --repo tom.quest --sha <sha> [--base <sha>] [--limit N] [--jobs prepare,code-brief] [--ablation] [--force]
//   node /opt/tts/evals.mjs --serve     # one polling pass over the request queue
//   node /opt/tts/evals.mjs --weekly    # the full set against both repos' main
//   node /opt/tts/evals.mjs --tasks <repo>
//
// The box POLLS. It has no inbound door: it talks out to Convex, GitHub and
// Slack, and nothing talks in but SSH with Tom's key. A GitHub Action posts a
// request to Convex and waits; a cron tick here picks it up.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { convexFetch, extractJsonObject, loadEnv, nyHour, runClaude, serverErrorMessage } from "./tts-lib.mjs";
import { cacheRepoDir } from "./tts-code-lib.mjs";
// The cap on the node arm, imported rather than re-declared: worker/jobs/graph.mjs
// owns every number about the graph, and a second copy of this one here would
// drift the day either moves.
import { ABLATION_NODE_CAP } from "./graph.mjs";

export const EVALS_RUN = "evals-run";
export const EVALS_REQUEST = "evals-request";

export const REGEN_MODEL = process.env.TTS_EVALS_REGEN_MODEL || "haiku";
export const JUDGE_MODEL = process.env.TTS_EVALS_JUDGE_MODEL || "fable";
export const REGEN_TIMEOUT_MS = 5 * 60 * 1000;
export const JUDGE_TIMEOUT_MS = 3 * 60 * 1000;

/** The on-commit set: the newest 20 approve and 20 revise across the whole
 *  golden set, by ruledAt. The weekly run uses everything. */
export const PR_ITEMS = 40;

/**
 * How many times an item is tried at the head commit before one failure of it
 * is called a regression.
 *
 * EVERY ITEM IS A LIVE MODEL CALL, so one pass or one fail is a sample, not a
 * measurement: the same commit scored twice an hour apart has come back 8/29
 * with no regression and 6/29 with one, with nothing in the diff touching the
 * item that moved. A one-trial gate fails a merge on the regeneration's noise
 * as readily as on the change under test.
 *
 * The rule is the same for every item, and it is not a re-roll of a chosen
 * one: an item that PASSED AT BASE and fails at head is tried again, up to
 * this many head trials in all, and it is a regression only if EVERY head
 * trial fails. Passing once and failing once is a fact about the item, kept as
 * `flaky` and reported — never counted as a regression, never hidden.
 *
 * The extra work is bounded by the same condition. An item that failed at base
 * too, or that base never scored, is tried exactly once, as before.
 */
export const HEAD_TRIALS = 3;

/**
 * How many times a `run` case is scored.
 *
 * Three for a regression case. Five for a capability case, because a
 * capability case passing is not a report: it is the moment the case
 * GRADUATES into the set that gates every future merge, and a promotion made
 * on one lucky trial writes the regeneration's noise into the gate itself. The
 * promotion rests on more evidence than the report does.
 *
 * One on a pull request, for every case alike. A pull-request run answers "did
 * this change break something", and one trial answers that loudly enough to
 * stop a merge; the row records `trials: 1` so the gate compares like with
 * like rather than reading a one-trial head against a three-trial base.
 */
export const TRIALS_REGRESSION = 3;
export const TRIALS_CAPABILITY = 5;
export const PR_TRIALS = 1;

/**
 * The trial count of ONE case. It is read off the item and never re-derived by
 * the runner: the export knows a case's kind when it writes the file, so a
 * case Tom later wants run more often is changed by editing that one file
 * rather than by changing a rule here. The kind is the fallback, for an item
 * written before the field existed.
 */
export function trialsFor(item, { pr = false } = {}) {
  if (pr) return PR_TRIALS;
  if (Number.isInteger(item?.trials) && item.trials > 0) return item.trials;
  return item?.kind === "capability" ? TRIALS_CAPABILITY : TRIALS_REGRESSION;
}

/** Worktrees and cache clones; free to delete, by the box's no-state rule. */
export const WORK_DIR = "/var/cache/tts/evals";
export const GOLDEN_DIR = "evals/golden";
export const TASKS_DIR = "evals/tasks";

/** The layer names the prelude assembler knows (scripts/prelude.mjs). The
 *  parts were renamed from blocks to layers; this file uses the new word. */
export const LAYER_NAMES = ["operate", "write", "know"];

/**
 * operate/write/know come from WikiTom; the builders and the golden set come
 * from tom.quest. A run pins ONE of them at `sha` and takes the other at its
 * default branch, because that is what merging the pull request would produce.
 */
export function treesFor(repo, sha) {
  return repo === "WikiTom"
    ? { wikitom: sha, tomquest: "origin/main" }
    : { wikitom: "origin/main", tomquest: sha };
}

/**
 * An item's verdict in the two words the judge prompt takes. The rulings half
 * of the set already carries one; the explanation half carries Tom's own
 * reaction as a LABEL — "landed" is an approve and "did not" is a revise, and
 * that is the whole mapping.
 */
export function verdictOf(item) {
  if (item.verdict === "approve" || item.verdict === "revise") return item.verdict;
  return item.label === "landed" ? "approve" : "revise";
}

/** Tom has not been through the mined explanations one by one. An item he has
 *  not confirmed is run and reported, but never fails a pull request. */
export function isConfirmed(item) {
  return item.confirmedByTom !== false;
}

/** Every golden item in a tom.quest tree, id-ascending. THE LAYOUT IS
 *  evals/golden/ AND ONE LEVEL BELOW IT: the exporter writes its rulings items
 *  into the root, and each producer that files a set of its own gets a
 *  directory named for it — `explanations/` (scripts/import-explanation-golden.mjs),
 *  `learning/` (the nightly learning step's two). The directories are DISCOVERED
 *  rather than listed, so a new set is a directory and not an edit here; the
 *  walk stops at one level because an item's own `partition` field is what
 *  groups the report, not its path. */
export function loadGolden(tomquestTree) {
  const root = path.join(tomquestTree, GOLDEN_DIR);
  if (!fs.existsSync(root)) return [];
  const roots = [root];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) roots.push(path.join(root, entry.name));
  }
  const items = [];
  for (const dir of roots) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      if (!fs.statSync(file).isFile()) continue;
      items.push(JSON.parse(fs.readFileSync(file, "utf8")));
    }
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  return items;
}

/** What makes two runs comparable: the sorted ids and their file bytes. The
 *  gate refuses to compare runs whose hashes differ, because they scored
 *  different sets and the comparison would be a lie. */
export function goldenHash(items) {
  const hash = crypto.createHash("sha256");
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(item.id);
    hash.update("\0");
    hash.update(JSON.stringify(item));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/** The newest `count` approve and `count` revise across the whole set, by
 *  ruledAt descending — the set a pull request scores. Items with no ruledAt
 *  (the mined explanations) sort by their day. */
export function selectItems(items, count = PR_ITEMS / 2) {
  const stamp = (item) => item.ruledAt ?? Date.parse(`${item.ruledOn ?? "1970-01-01"}T00:00:00Z`);
  const take = (verdict) => items
    .filter((item) => verdictOf(item) === verdict)
    .sort((a, b) => stamp(b) - stamp(a) || a.id.localeCompare(b.id))
    .slice(0, count);
  return [...take("approve"), ...take("revise")].sort((a, b) => a.id.localeCompare(b.id));
}

export function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The layer text this run's WikiTom tree yields, assembled by the ONE
 * assembler — scripts/prelude.mjs in the pinned tom.quest tree. The assembly
 * is not re-implemented here, and the metadata comes from the same script's
 * --json form rather than from a second parse of its output.
 */
export function layersFor(tomquestTree, wikitomTree, names, run = execFileSync) {
  const script = path.join(tomquestTree, "scripts", "prelude.mjs");
  const args = ["--wikitom", wikitomTree, "--layers", names.join(",")];
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 };
  const text = run(process.execPath, [script, ...args], options);
  const meta = JSON.parse(run(process.execPath, [script, ...args, "--json"], options));
  return { names, skills: [], text, commit: meta.commit, files: meta.files };
}

/**
 * The inline module the PINNED tree's own scripts/skills.mjs is asked through.
 *
 * A CHILD PROCESS RATHER THAN AN IMPORT, for two reasons. worker/setup.sh
 * copies evals.mjs to /opt/tts/evals.mjs and skills.mjs to
 * /opt/tts/scripts/skills.mjs — a different relative path from the one the two
 * have in the repo — so no static import of it resolves in both homes. And the
 * copy beside this file is not the one to ask anyway: what a case was given is
 * what the TREE UNDER TEST names and renders, not what this checkout would.
 *
 * It answers three things in one spawn: the directory each requested name is
 * published under, which of them the publication actually holds, and the grant
 * block those two facts imply.
 */
const SKILLS_ASK = [
  "const [href, json] = process.argv.slice(1);",
  "const input = JSON.parse(json);",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "import(href).then((skills) => {",
  "  const granted = [];",
  "  const refused = [];",
  "  const files = [];",
  "  for (const name of input.names) {",
  "    const file = path.join(input.out, skills.skillDirName(name), 'SKILL.md');",
  "    if (fs.existsSync(file)) { granted.push(name); files.push(file); }",
  "    else refused.push({ name, why: input.why[name] || 'the publication at this commit does not hold it' });",
  "  }",
  "  const grants = skills.renderGrants({ commit: input.commit, granted, refused });",
  "  process.stdout.write(JSON.stringify({ granted, refused, files, grants }));",
  "});",
].join("\n");

const RUN_OPTIONS = { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 };

/**
 * ONE PUBLICATION PER PAIR OF TREES, kept for the life of the process.
 *
 * The ablation arm asks for a dozen near-identical name sets and every case
 * asks for its own; each of those would otherwise re-read every page of WikiTom
 * out of git. The publication does not depend on the names at all — it is the
 * whole catalogue — so it is built once and the name sets read out of it.
 *
 * The key is the pair of worktree directories, which one run pins for its whole
 * lifetime: runEvals makes them at the top and removes them in its `finally`,
 * and a head run and a base run never share both.
 */
const publications = new Map();

export function publicationFor(tomquestTree, wikitomTree, run = execFileSync, workDir = WORK_DIR) {
  const key = `${tomquestTree} ${wikitomTree}`;
  const held = publications.get(key);
  if (held !== undefined) return held;
  const out = path.join(workDir, "skills", crypto.createHash("sha256").update(key).digest("hex").slice(0, 16));
  const script = path.join(tomquestTree, "scripts", "publish-skills.mjs");
  // The two trees are handed in as the two REPOSITORIES as well as as the
  // sources of the pages: `repo-tom.quest` and `repo-WikiTom` are then the
  // rules files of the exact commits this run pins, which is the standard every
  // other part of the prelude is held to. A repository the run pins nothing of
  // — ComplexMultiTrigger — has no commit here to read, and comes back as a
  // refusal in the grant block rather than as whatever some checkout's HEAD says.
  const result = JSON.parse(run(process.execPath, [
    script,
    "--wikitom", wikitomTree,
    "--out", out,
    "--repo", `tom.quest=${tomquestTree}`,
    "--repo", `WikiTom=${wikitomTree}`,
    "--json",
  ], RUN_OPTIONS));
  const built = {
    commit: result.commit,
    out: result.out ?? out,
    published: (result.skills ?? []).map((skill) => skill.name),
    why: Object.fromEntries((result.refused ?? []).map((entry) => [entry.name, entry.why])),
  };
  publications.set(key, built);
  return built;
}

/** The body of a published SKILL.md: its generated frontmatter and provenance
 *  comment off, the page itself untouched. What a run that loaded the skill
 *  read is the page; the two generated lines above it are how the harness finds
 *  the file, not part of what it says. */
export function skillBodyOf(text) {
  let rest = String(text ?? "");
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(rest);
  if (frontmatter !== null) rest = rest.slice(frontmatter[0].length);
  return rest.replace(/^\s*<!--[\s\S]*?-->[ \t]*\r?\n/, "").trim();
}

/**
 * The prelude text a case was given when its name set carries SKILLS.
 *
 * Generalises layersFor; it is NOT a second assembler. The layer half goes
 * through the same pinned scripts/prelude.mjs. The skill half runs the PINNED
 * tree's own scripts/publish-skills.mjs against the PINNED WikiTom tree and
 * reads what that wrote, so what comes back is the catalogue those two commits
 * produce and never a second opinion about what a skill is.
 *
 * The text is the layer text, then the grant block, then the granted skills'
 * BODIES, in the order the names were given. The bodies are the point: what the
 * eval measures is what the run could actually see, and the ablation arm's
 * whole purpose is that removing a skill removes its body from this text.
 *
 * A name the publication does not hold is a REFUSAL in the grant block, not a
 * throw. WikiTom is Tom's to edit, and a case naming a skill he has since
 * emptied should score the prompt a run would be given today — which says, in
 * the grant block, that the skill was asked for and is not there.
 */
export function skillsFor(tomquestTree, wikitomTree, names, run = execFileSync, workDir = WORK_DIR) {
  const layerNames = names?.layers ?? [];
  const skillNames = names?.skills ?? [];
  const publication = publicationFor(tomquestTree, wikitomTree, run, workDir);
  const layers = layerNames.length === 0 ? null : layersFor(tomquestTree, wikitomTree, layerNames, run);
  const asked = JSON.parse(run(process.execPath, [
    "-e", SKILLS_ASK,
    pathToFileURL(path.join(tomquestTree, "scripts", "skills.mjs")).href,
    JSON.stringify({ names: skillNames, out: publication.out, commit: publication.commit, why: publication.why }),
  ], RUN_OPTIONS));
  const loaded = asked.files.map((file) => ({
    path: path.relative(publication.out, file).replace(/\\/g, "/"),
    body: skillBodyOf(fs.readFileSync(file, "utf8")),
  }));
  return {
    names: layerNames,
    skills: skillNames,
    text: [...(layers === null ? [] : [layers.text]), asked.grants, ...loaded.map((one) => one.body)].join("\n\n"),
    commit: publication.commit,
    // ONE SHAPE for both halves — `{ path, bytes }`, which is what prelude.mjs's
    // --json gives for the layer files — so a reader of this list never has to
    // ask which half an entry came from.
    files: [
      ...(layers?.files ?? []),
      ...loaded.map((one) => ({ path: one.path, bytes: Buffer.byteLength(one.body, "utf8") })),
    ],
  };
}

/**
 * The prelude a case was given, when what it was given is a NAME SET rather
 * than a job's fixed layer selection: `{ layers: [...], skills: [...] }`.
 *
 * The layer half goes through the same pinned scripts/prelude.mjs; the skill
 * half goes through io.skills, which is handed BOTH TREES and the whole name
 * set — the catalogue is built out of the pinned WikiTom by the pinned
 * tom.quest, and neither half of that pair can be assumed from the other.
 */
export const NO_PRELUDE = Object.freeze({ names: [], skills: [], text: "", commit: null, files: [], known: false });

/** An io with NO SKILL ASSEMBLER WIRED, asked for a name set that carries
 *  skills. realIo wires one, so what reaches this is a test io or a caller that
 *  built its own — and the refusal stays explicit rather than quietly
 *  assembling the layer half alone: a case scored on a prompt missing part of
 *  what the original run saw would report the difference as a regression.
 *  runCase turns it into a skip, before any model call is paid for. */
export class SkillsNotAssembledError extends Error {}
export const SKILL_SEAM_REASON = "skill prelude not assembled — the io in use wired no skill assembler";

export function preludeFrom(io, tomquestTree, wikitomTree, names) {
  const layers = names?.layers ?? [];
  const skills = names?.skills ?? [];
  // Nothing to assemble is not an error and must not reach prelude.mjs, which
  // refuses an empty --layers.
  if (layers.length === 0 && skills.length === 0) return NO_PRELUDE;
  if (skills.length > 0) {
    if (typeof io.skills !== "function") throw new SkillsNotAssembledError(SKILL_SEAM_REASON);
    return io.skills(tomquestTree, wikitomTree, names);
  }
  return io.layers(tomquestTree, wikitomTree, layers);
}

/**
 * The prompt each job's CURRENT builder would produce for one item, today.
 * One entry per job; adding a job is one row. The builders are imported from
 * the PINNED tom.quest worktree, never from the running copy — that is the
 * whole point: the eval measures the tree under test, not the tree the cron
 * happens to run.
 *
 * The PARSE is the runner's own (tts-lib's extractJsonObject): unwrapping a
 * model answer is plumbing, not the thing under test, and the pinned builders
 * do not export it.
 *
 * `build` is handed item.input.priorReviseSentence and NEVER item.sentence.
 * The sentence of the ruling being used as the label is the answer; a
 * regeneration that saw it would be scored on its own reading comprehension.
 *
 * Every `build` takes (item, layers, mod, context). `context` is the fourth
 * argument rather than a fifth entry in `layers` because a job whose prelude
 * travels ON THE ITEM — the `run` job below — assembles its own, and the
 * assembler is the run's, not the job's.
 */
export const JOBS = {
  prepare: {
    layers: ["write", "know"],
    module: "worker/jobs/plan-graphs.mjs",
    build: (item, layers, mod) => mod.preparePrompt(
      {
        statement: item.input.statement,
        source: item.input.source,
        provenance: item.input.provenance,
        category: item.input.category,
        createdAt: item.input.createdAt,
      },
      item.input.priorReviseSentence,
      item.input.today,
      layers.text,
    ),
    parse: (answer) => extractJsonObject(answer),
    fields: ["brief", "entryAction", "workDescription", "groundUpExplanation"],
    opts: { maxTurns: 4 },
  },
  "code-brief": {
    layers: ["write", "know"],
    module: "worker/jobs/plan-graphs.mjs",
    build: (item, layers, mod) => mod.briefPrompt(item.input.entryYaml ?? item.input.statement, item.input.priorReviseSentence, layers.text),
    parse: (answer) => extractJsonObject(answer),
    fields: ["brief", "recommendation", "execClass", "evidence"],
    // Needs a CMT checkout and read-only tools, like the real brief pass.
    opts: { cwd: "@cmt", maxTurns: 8 },
  },
  // The planner writes for a whole run, not for one batch, so the context is
  // the real one with every OTHER list empty: the batch under test is the only
  // graph, and the run's revise sentence is the prior one, never the label.
  "batch-plan": {
    layers: ["write", "know"],
    module: "worker/jobs/plan-graphs.mjs",
    build: (item, layers, mod) => mod.graphPrompt({
      writingStandard: layers.text,
      vocabulary: "",
      sessionRepos: [],
      graphs: [{
        id: item.subject?.batchId ?? item.id,
        statement: item.input.statement,
        tasks: (item.input.memberStatements ?? []).map((statement, index) => ({
          id: `t${index}`, statement, actor: "agent", status: "active", needs: [],
        })),
      }],
      graphsHeldBack: 0,
      activeStatements: [item.input.statement],
      candidates: [],
      candidatesHeldBack: 0,
      code: [],
      archivedStatements: [],
      repairs: [],
      revises: item.input.priorReviseSentence === null
        ? []
        : [{ batchId: item.subject?.batchId ?? null, sentence: item.input.priorReviseSentence }],
      notes: [],
      recentRulings: [],
    }),
    parse: (answer) => extractJsonObject(answer),
    fields: ["groundUpExplanation"],
    opts: { maxTurns: 6 },
  },
  // The mined explanations are not a job's output — they are what an agent
  // wrote to Tom in a session. The regeneration is the same act: the topic,
  // its context lines, and the write and know layers, and nothing else.
  explanation: {
    layers: ["write", "know"],
    module: null,
    build: (item, layers) => [
      layers.text,
      ``,
      `Write Tom a ground-up explanation of the topic below. He has not been`,
      `given the concepts it rests on, so build them before you use them.`,
      ``,
      `Answer with the explanation itself and nothing else: no preamble, no`,
      `restatement of the question, no closing offer of further help.`,
      ``,
      ...item.input.contextLines,
      ``,
      `Topic: ${item.input.topic}`,
    ].join("\n"),
    parse: (answer) => ({ explanation: String(answer ?? "").trim() }),
    fields: ["explanation"],
    opts: { maxTurns: 2 },
  },
  // One REGISTERED RUN, replayed. The case is mined out of a runLabels row
  // rather than out of snapshot text, so what it carries is the run's own
  // assembled prompt and the text Tom judged, and its rubric is the label's
  // meaning in his words.
  //
  // `layers: []` means the selection is NOT FIXED PER JOB: it travels on the
  // item as input.preludeNames, because the question a run case asks is
  // whether the same names, assembled from this tree, still produce what he
  // approved — and a job-wide selection would replay a prompt the original run
  // never saw. runItem resolves it per item; `build` asks the same cached
  // assembler for the text.
  //
  // A case whose prelude was not known is replayed VERBATIM from input.prompt:
  // there is nothing to assemble, and assembling something else would score a
  // different prompt than the one that was labelled.
  run: {
    layers: [],
    module: null,
    build: (item, _layers, _mod, context) => (item.input.preludeKnown
      ? `${context.prelude(item.input.preludeNames).text}\n${item.input.task}`
      : item.input.prompt),
    parse: (answer) => ({ text: String(answer ?? "").trim() }),
    fields: ["text"],
    proseFields: ["text"],
    opts: { maxTurns: 6 },
  },
  // The nightly learning step's two items (evals/golden/learning/). They are
  // the only job here scored WITHOUT a judge: what the item asks is whether the
  // regenerated answer still lands the one change it must land and still lands
  // nothing on the night it must refuse, and applyLearningChanges answers that
  // deterministically. `score` below is what runItem calls in the judge's place.
  learning: {
    // No layer text: the pages' own rules travel with the pages, and
    // learningPrompt takes none. The write layer is asked for anyway because
    // runItem resolves a job's layers before it builds — it is one cached call
    // per run and its text reaches nothing here.
    layers: ["write"],
    // TWO MODULES, merged into one namespace by loadModules: the prompt and
    // the writer are in nightly.mjs, the ground signals it is given are in
    // learning-ground.mjs, and both come from the PINNED tree.
    module: ["worker/jobs/nightly.mjs", "worker/jobs/learning-ground.mjs"],
    build: (item, layers, mod) => mod.learningPrompt(
      learningStepInput(item.input),
      new Map(Object.entries(item.input.pages ?? {})),
      new Map(Object.entries(item.input.evidencePages ?? {})),
      learningSignals(item.input, mod),
      item.input.day,
    ).prompt,
    parse: (answer, mod) => mod.parseLearningAnswer(answer),
    score: (item, fresh, mod) => scoreLearning(item, fresh, mod),
    fields: [],
    opts: { maxTurns: 2 },
  },
};

/**
 * A golden learning item's `input` as the nightly step's own input object: the
 * turns carrying the fields the job reads, and the window in epoch
 * milliseconds. The same conversion worker/jobs/learning-golden.test.mjs makes
 * — one item shape, two readers, and the item file is the only place it is
 * written down.
 */
export function learningStepInput(input) {
  const at = (date) => Date.parse(`${date}T12:00:00.000Z`);
  return {
    since: Date.parse(input.window.since),
    until: Date.parse(input.window.until),
    tomTurns: (input.tomTurns ?? []).map((turn) => ({
      id: turn.turnId,
      sessionId: turn.session,
      sdkSessionId: `${turn.session}-0000-0000-0000-000000000000`,
      sessionTitle: turn.sessionTitle ?? "",
      text: turn.tom,
      at: at(turn.date),
      replyBefore: turn.agentBefore ?? null,
      replyAfter: turn.agentAfter ?? null,
    })),
    slackReplies: input.slackReplies ?? [],
    rulings: input.rulings ?? [],
    objections: [],
    changes: [],
  };
}

/** The ground signals of one learning item, found by the pinned tree's OWN
 *  code — never read off the item. The signal objects carry more than the item
 *  records about them (the sentence each rests on, which applyLearningChanges
 *  checks a change's "said:" entry against), and a signal list assembled here
 *  by hand would refuse changes the real job accepts. */
export function learningSignals(input, mod) {
  const step = learningStepInput(input);
  return mod.groundSignals(step, {
    cite: (turn) => `session ${mod.sessionCitation(turn)}`,
    day: (at) => mod.utcDay(at),
  }).signals;
}

/**
 * One learning item, scored with no model call: run the regenerated answer
 * through the real applyLearningChanges and compare WHAT LANDED with the
 * item's `expect.applied`, by file, section and kind.
 *
 * What landed is the whole test, and refusals are deliberately not compared: on
 * the refusal item the right answer is to propose nothing at all, which refuses
 * nothing — the item's own recorded refusals belong to the deliberately bad
 * answer the vitest suite feeds it. Nothing landing IS the item passing there.
 */
export function scoreLearning(item, fresh, mod) {
  // `fresh` is what parseLearningAnswer returns: the CHANGES ARRAY, not the
  // object around it, which is what applyLearningChanges takes.
  const result = mod.applyLearningChanges(
    new Map(Object.entries(item.input.pages ?? {})),
    Array.isArray(fresh) ? fresh : (fresh?.changes ?? []),
    {
      day: item.input.day,
      evidence: mod.learningEvidence(learningStepInput(item.input)),
      evidencePages: new Map(Object.entries(item.input.evidencePages ?? {})),
      signals: learningSignals(item.input, mod),
    },
  );
  const shape = (change) => `${change.file}#${change.section}:${change.kind ?? change.op}`;
  const landed = result.applied.map(shape).sort();
  const wanted = (item.expect?.applied ?? []).map(shape).sort();
  if (landed.join("|") === wanted.join("|")) {
    return {
      judged: "pass",
      reason: wanted.length === 0
        ? `nothing landed, as the item requires (${result.refused.length} refused)`
        : `landed ${wanted.join(", ")}`,
    };
  }
  return {
    judged: "fail",
    reason: `landed ${landed.length === 0 ? "nothing" : landed.join(", ")}, expected ` +
      `${wanted.length === 0 ? "nothing" : wanted.join(", ")}` +
      (result.refused.length === 0 ? "" : ` (refused: ${result.refused.map((one) => one.reason).join("; ")})`),
  };
}

/** Each field of an output under a line naming it. */
function fieldBlocks(output, fields) {
  return fields
    .filter((field) => output?.[field] !== undefined && output?.[field] !== null)
    .map((field) => `[${field}]\n${String(output[field])}`)
    .join("\n\n");
}

/**
 * The judge prompt. The fixed text is first and the volatile data last, per the
 * cache-aware ordering rule. The mode block is the ONE that matches the item's
 * verdict; the other is not sent.
 *
 * Two things not to get wrong:
 *  - On an approve item the sentence is not sent AT ALL. An approve ruling's
 *    optional sentence is a steering note, and showing it would make the judge
 *    score against a note Tom wrote about something else.
 *  - priorReviseSentence is stripped from the INPUT block. The judge does not
 *    need it and it reads as an instruction.
 *
 * The prompt carries NO layer text. The judge is not writing for Tom; it is
 * comparing two texts against one sentence, which is what makes Fable
 * affordable here.
 *
 * A `run` case brings its own sentence: expected.rubric is the meaning of the
 * label Tom put on that run, in his words, and it is sent VERBATIM under its
 * own heading on an approve case as well as a revise one. The approve rule
 * above — never show an approve ruling's optional sentence — is about a
 * STEERING NOTE written about something else; a rubric is written about this
 * output, and withholding it would leave the judge with nothing to judge
 * against. A capability case also carries a target: the thing the output must
 * now do and did not do before.
 */
export function judgePrompt(item, fresh, fields) {
  const verdict = verdictOf(item);
  const input = { ...item.input };
  delete input.priorReviseSentence;
  const rubric = typeof item.expected?.rubric === "string" && item.expected.rubric.trim() !== ""
    ? item.expected.rubric
    : null;
  const target = item.kind === "capability" && typeof item.expected?.target === "string" && item.expected.target.trim() !== ""
    ? item.expected.target
    : null;
  const revise = [
    `Tom rejected the OLD output with the sentence below. Does the NEW output fix what that sentence`,
    `objects to?`,
    `- "pass" — the NEW output does not have the fault his sentence names.`,
    `- "fail" — the NEW output still has that fault, or has replaced it with the same fault`,
    `  somewhere else in the text.`,
    `Judge the fault his sentence names and nothing else. A NEW output that is worse in some other`,
    `way still passes if the named fault is gone; name that in the reason.`,
  ];
  const approve = [
    `Tom accepted the OLD output. Does the NEW output keep what he accepted?`,
    `- "pass" — the NEW output covers the same facts about the same subject, in the same form, and`,
    `  asserts nothing the input does not support.`,
    `- "fail" — the NEW output drops a fact the OLD output carried, changes the form (a section it`,
    `  must have, the document shape, the length class of a field), or asserts something the input`,
    `  does not support.`,
    `Different wording is not a failure. Only a loss or an invention is.`,
  ];
  return [
    `You are judging one output of Tom's todo system against a ruling Tom already made.`,
    ``,
    `Tom is one person. His agents write for him, and he rules on what they write with one of four`,
    `words: approve, revise, session, archive. A "revise" ruling carries one sentence of his saying`,
    `what was wrong with it. An "approve" ruling means the output was good enough for him to act on.`,
    ``,
    `You are given: the input the output was written from, the OLD output Tom ruled on, his verdict,`,
    `his sentence where he wrote one, and a NEW output written just now by the same job from the`,
    `same input, after the instruction files that job reads were changed. The question is whether`,
    `the change held.`,
    ``,
    `THE QUESTION`,
    ``,
    ...(verdict === "revise" ? revise : approve),
    ``,
    `RULES`,
    ``,
    `- You are checking one thing. Never judge on style preference, on which output you find better`,
    `  written, or on anything Tom did not rule on.`,
    `- The reason is one sentence, under 30 words, and names the specific text that decided it —`,
    `  quote three or four words of the NEW output. "It is worse" is not a reason.`,
    `- Answer with ONE JSON object and nothing else, no code fence:`,
    `{"verdict":"pass","reason":"<one sentence>"}`,
    ``,
    `--- INPUT THE OUTPUT WAS WRITTEN FROM ---`,
    JSON.stringify(input, null, 1),
    ``,
    `--- TOM'S VERDICT ---`,
    verdict,
    ``,
    ...(rubric === null && verdict === "revise" ? [`--- TOM'S SENTENCE ---`, item.sentence ?? "", ``] : []),
    ...(rubric === null ? [] : [`--- WHAT TOM'S LABEL MEANS ---`, rubric, ``]),
    ...(target === null
      ? []
      : [`--- WHAT THE OUTPUT MUST NOW DO ---`, `the output must now do this; it did not before.`, target, ``]),
    `--- OLD OUTPUT (the one he ruled on) ---`,
    fieldBlocks(item.output, fields),
    ``,
    `--- NEW OUTPUT (written just now) ---`,
    fieldBlocks(fresh, fields),
  ].join("\n");
}

/**
 * A judge answer that is not {verdict: pass|fail, reason: <non-empty>} is a
 * FAIL with the answer's head in the reason — the same treatment a failed
 * regeneration gets, and for the same reason: a call that cannot produce a
 * readable answer is a worse outcome than one that produces a bad one, and
 * hiding it would let a broken judge show as a clean run.
 */
export function parseJudge(answer) {
  let parsed;
  try {
    parsed = extractJsonObject(answer);
  } catch {
    return { judged: "fail", reason: `judge answer unreadable: ${String(answer ?? "").slice(0, 120)}` };
  }
  const verdict = parsed?.verdict;
  const reason = parsed?.reason;
  if ((verdict !== "pass" && verdict !== "fail") || typeof reason !== "string" || reason.trim() === "") {
    return { judged: "fail", reason: `judge answer unreadable: ${String(answer ?? "").slice(0, 120)}` };
  }
  return { judged: verdict, reason: reason.trim() };
}

// ── The deterministic checks ─────────────────────────────────────────────────
// Everything below decides WITHOUT A MODEL, and a failure here is the trial's
// verdict with the judge never called. A text that broke a rule Tom wrote down
// is not a matter of reading, and the judge is the expensive half.

/**
 * mustName and mustNotName, read off an answer's own text.
 *
 * ONE FUNCTION, TWO CALLERS: runTask passes a task's `expect`, runCase passes
 * a case's. An ABSENT `expect` checks nothing and returns null — that is what
 * makes it safe to call on every case, and it is why the `expect` block is
 * normally absent from a golden file rather than written out empty.
 */
export function mechanicalChecks(expect, text) {
  const haystack = String(text ?? "").toLowerCase();
  for (const needle of expect?.mustName ?? []) {
    if (!haystack.includes(String(needle).toLowerCase())) return `does not name ${JSON.stringify(needle)}`;
  }
  for (const needle of expect?.mustNotName ?? []) {
    if (haystack.includes(String(needle).toLowerCase())) return `names ${JSON.stringify(needle)}, which it must not`;
  }
  return null;
}

/**
 * WHICH FIELDS THE WRITING STANDARD BINDS, and it is not all of them.
 *
 * scripts/check-writing-standard.mjs exports two rule sets, and the difference
 * is the whole finding here. `RULES` are rules of the HTML-DOCUMENT FORM —
 * no-doctype, no-close-html, no-h1, no-style — which the writing standard
 * attaches to a GROUND-UP EXPLANATION and to nothing else. `BRIEF_RULES` is
 * empty, deliberately: a brief is markdown by construction, so no mechanical
 * rule binds it, and that emptiness is a measurement rather than a gap (read
 * its comment there).
 *
 * So the rules are not applied field-blind. Running `RULES` over a free-form
 * field would fail every case on no-doctype — a `run` case's `text` is not an
 * HTML document and the standard fixes no form for it, so no rules run on it
 * at all. That is what makes this check safe to run on every job: a field the
 * standard says nothing about is checked against nothing.
 *
 * A rule added to BRIEF_RULES over there lands here with no edit.
 */
export const HTML_STANDARD_FIELDS = Object.freeze(["groundUpExplanation", "explanation"]);
export const BRIEF_STANDARD_FIELDS = Object.freeze(["brief", "recommendation", "workDescription"]);

export function standardRulesFor(field, standard) {
  if (standard === null || standard === undefined) return null;
  if (HTML_STANDARD_FIELDS.includes(field)) return standard.RULES ?? null;
  if (BRIEF_STANDARD_FIELDS.includes(field)) return standard.BRIEF_RULES ?? null;
  return null;
}

/**
 * The writing standard's rule bodies, loaded the way loadGate loads the gate.
 *
 * THE FILE HAS THREE HOMES — /opt/tts beside the jobs, scripts/ in a checkout,
 * and CI — and check-writing-standard.mjs sits beside evals-check.mjs in only
 * some of them. An absent file is "no rules ran", never a failure: a box whose
 * setup.sh has not copied it yet must not start failing every case on a check
 * it cannot perform.
 */
export async function loadWritingStandard() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.join(here, "check-writing-standard.mjs"),
    path.join(here, "..", "..", "scripts", "check-writing-standard.mjs"),
  ]) {
    if (fs.existsSync(candidate)) return await import(pathToFileURL(candidate).href);
  }
  return null;
}

/** Every field of one output as one text, for a check that reads the answer
 *  rather than one field of it. */
function outputText(fresh, fields) {
  return fields.map((field) => fresh?.[field]).filter((value) => typeof value === "string").join("\n\n");
}

/**
 * The deterministic verdict on one regenerated output, or null.
 *
 * IN THIS ORDER, and the order is the cost order: the schema (job.parse, which
 * already threw before this is reached), then the item's own mustName and
 * mustNotName, then the writing standard over the fields it binds. Only a
 * `null` from here buys a judge call.
 */
export function deterministicFailure(item, job, fresh, standard) {
  const fields = job.proseFields ?? job.fields ?? [];
  const mechanical = mechanicalChecks(item.expect, outputText(fresh, fields));
  if (mechanical !== null) return mechanical;
  for (const field of fields) {
    const rules = standardRulesFor(field, standard);
    if (rules === null || rules.length === 0) continue;
    const value = fresh?.[field];
    // An absent field is the judge's business — it is a loss, not a broken
    // form, and failing it here would report the wrong fault.
    if (typeof value !== "string" || value.trim() === "") continue;
    const broken = standard.failuresFor(value, rules);
    if (broken.length > 0) return `${field} fails the writing standard: ${broken.join(", ")}`;
  }
  return null;
}

/** The four fields every result of one item carries, whichever path scored it. */
export function baseOf(item) {
  return { id: item.id, partition: item.partition, verdict: verdictOf(item), confirmed: isConfirmed(item) };
}

/**
 * The prelude ONE ITEM is given.
 *
 * A job with a fixed layer selection names it on the job, and that call is
 * cached per run. A job whose selection travels on the item — `layers: []` —
 * reads it off input.preludeNames, which is what makes a `run` case replayable
 * with exactly the names its original run was given. A case whose prelude was
 * not known has none: its prompt is replayed verbatim, and the run this eval
 * registers says layersKnown false rather than claiming a selection nobody
 * recorded.
 */
function preludeFor(item, job, context) {
  if ((job.layers ?? []).length > 0) return context.layers(job.layers);
  if (item.input?.preludeKnown !== true) return NO_PRELUDE;
  return context.prelude(item.input.preludeNames ?? { layers: [], skills: [] });
}

/**
 * One item: build the prompt, regenerate, judge. Never throws — a failure is
 * a result, so one bad item cannot end the run.
 *
 * `deterministic` is the hook runCase passes: a function of the parsed output
 * returning a reason or null, called AFTER the parse and BEFORE the judge.
 * It is a hook rather than a body here so that there is still exactly one
 * regeneration path, and so that the landed jobs — which were never scored
 * against these checks — keep scoring exactly as they did.
 *
 * `receipt` is runClaude's out-parameter, filled with the token of the run it
 * spooled. runClaude cannot change its return type (seven callers use the
 * answer as a string), so the token comes back this way.
 */
export async function runItem(item, context, io, { deterministic = null, receipt = undefined } = {}) {
  const job = JOBS[item.job];
  const base = baseOf(item);
  if (job === undefined) {
    return { ...base, judged: "fail", reason: `no runner for job ${item.job}` };
  }
  let fresh;
  try {
    const layers = preludeFor(item, job, context);
    const known = layers.known !== false;
    const prompt = String(job.build(item, layers, context.modules[item.job], context));
    // The honesty check, enforced at run time as well as in the test. The
    // label sentence is the answer to a ruling item; a `run` case's RUBRIC is
    // the answer to it, and it is the whole answer — the case carries no
    // sentence and the rubric is what the judge scores against. A regeneration
    // that was handed either proves nothing.
    for (const [what, answer] of [["label sentence", item.sentence], ["rubric", item.expected?.rubric]]) {
      if (typeof answer === "string" && answer !== "" && prompt.includes(answer)) {
        return { ...base, judged: "fail", reason: `regeneration failed: the ${what} reached the prompt` };
      }
    }
    const answer = await io.runClaude(prompt, {
      model: REGEN_MODEL,
      timeoutMs: REGEN_TIMEOUT_MS,
      ...job.opts,
      cwd: job.opts?.cwd === "@cmt" ? context.cmtDir : job.opts?.cwd,
      ...(receipt === undefined ? {} : { receipt }),
      registration: {
        origin: "cron:evals",
        kind: "job",
        layersKnown: known,
        layersGiven: known ? layers.names : [],
        layersDenied: known ? LAYER_NAMES.filter((name) => !layers.names.includes(name)) : [],
        skillsGranted: layers.skills ?? [],
        ...(layers.commit ? { wikitomCommit: layers.commit } : {}),
      },
    });
    fresh = job.parse(answer, context.modules[item.job]);
  } catch (err) {
    // An io with no skill assembler is a SKIP, not a failure: nothing about the
    // tree under test was measured, and calling that a regression would fail a
    // merge over a gap in the harness. realIo wires one, so a real run never
    // reaches this; a test io or a caller that built its own still can.
    if (err instanceof SkillsNotAssembledError) return { ...base, judged: "skip", reason: err.message };
    return { ...base, judged: "fail", reason: `regeneration failed: ${serverErrorMessage(err)}` };
  }
  if (deterministic !== null) {
    // A check that throws is a failed check, reported as one. runItem never
    // throws, and a hook is not allowed to be the thing that breaks that.
    let reason;
    try {
      reason = deterministic(fresh);
    } catch (err) {
      return { ...base, judged: "fail", reason: `deterministic check failed: ${serverErrorMessage(err)}` };
    }
    if (reason !== null) return { ...base, judged: "fail", reason };
  }
  // A job that can score itself does. The learning items are the case: what
  // they ask is answered by running the regenerated answer through the job's
  // own code, so no judge is called and the answer is not a matter of reading.
  if (typeof job.score === "function") {
    try {
      return { ...base, ...job.score(item, fresh, context.modules[item.job]) };
    } catch (err) {
      return { ...base, judged: "fail", reason: `scoring failed: ${serverErrorMessage(err)}` };
    }
  }
  let answer;
  try {
    answer = await io.runClaude(judgePrompt(item, fresh, job.fields), {
      model: JUDGE_MODEL,
      timeoutMs: JUDGE_TIMEOUT_MS,
      maxTurns: 1,
      registration: {
        origin: "cron:evals",
        kind: "job",
        layersKnown: false,
        layersGiven: [],
        layersDenied: [],
      },
    });
  } catch (err) {
    return { ...base, judged: "fail", reason: `judge answer unreadable: ${serverErrorMessage(err)}` };
  }
  return { ...base, ...parseJudge(answer) };
}

/**
 * An item that passed at least one head trial and failed at least one other.
 * It is a PASS — it passed — and it is counted apart, because a set with
 * flaky items in it is a set whose single-trial numbers move on their own.
 */
export function isFlaky(result) {
  const trials = result?.trials;
  if (trials === undefined || trials === null) return false;
  return trials.headPassed > 0 && trials.headPassed < trials.head;
}

/**
 * Counts and a list. Nothing is averaged, weighted or scored out of ten — an
 * item passes or it does not, and the aggregate is descriptive, like every
 * other fact in this system.
 */
export function aggregate(results) {
  const byPartition = new Map();
  const byVerdict = { approve: { items: 0, pass: 0 }, revise: { items: 0, pass: 0 } };
  let pass = 0;
  let flaky = 0;
  for (const result of results) {
    if (isFlaky(result)) flaky += 1;
    const row = byPartition.get(result.partition) ?? { partition: result.partition, items: 0, pass: 0, fail: 0 };
    row.items += 1;
    row[result.judged === "pass" ? "pass" : "fail"] += 1;
    byPartition.set(result.partition, row);
    const verdict = byVerdict[result.verdict];
    if (verdict !== undefined) {
      verdict.items += 1;
      if (result.judged === "pass") verdict.pass += 1;
    }
    if (result.judged === "pass") pass += 1;
  }
  return {
    items: results.length,
    pass,
    fail: results.length - pass,
    // Passed once, failed once. NEVER a regression and never folded into the
    // fail count: it is the noise in the measurement, said out loud.
    flaky,
    byPartition: [...byPartition.values()].sort((a, b) => a.partition.localeCompare(b.partition)),
    byVerdict,
    failures: results
      .filter((result) => result.judged !== "pass")
      .map(({ id, partition, verdict, reason, confirmed, trials }) => ({
        id, partition, verdict, reason, confirmed,
        // The failure carries its own trial count, so a row read later says
        // whether this id failed once or failed every time it was tried.
        ...(trials === undefined ? {} : { trials }),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/**
 * Every task file for a repo, id-ascending. An absent or empty directory is
 * NOT an error: the tasks are Tom's to pick, and the writing evals ship first.
 */
export function loadTasks(tomquestTree, repo) {
  const dir = path.join(tomquestTree, TASKS_DIR, repo);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * The trigger files: the items that ask whether a name is reached for when it
 * should be and left alone when it should not.
 *
 * A *.draft.json IS NOT LOADED. A draft is a file somebody is still writing,
 * and a set that silently picks one up scores an item nobody has finished
 * writing down.
 *
 * The count rule the set has to satisfy — at least as many negatives as
 * positives in every file — is enforced in worker/jobs/evals.test.mjs, where
 * `npm test` says so in one line. It does not belong in a merge check that has
 * to fetch a run from the box to state a fact about a checked-in file.
 */
export const TRIGGERS_DIR = "evals/triggers";

/**
 * The eight area pages the know layer requires, and therefore the eight
 * `know-<area>` skills the layer became.
 *
 * A FROZEN LIST, not a read of the WikiTom tree, and not an import. loadTriggers
 * is handed a tom.quest tree and no WikiTom tree at all, so there is nothing
 * here to derive an area list from; and scripts/skills.mjs — which holds the
 * same eight in PRELUDE_LAYERS.know.areas.required — cannot be imported from
 * this file, because worker/setup.sh puts the two at relative paths that differ
 * between the repo and /opt/tts.
 *
 * So it is written down twice, and worker/jobs/evals.test.mjs PINS THE TWO
 * EQUAL: vitest runs from the repo root, where the import does resolve, and an
 * area Tom adds without touching this list is a red test naming it rather than
 * a skill that quietly stops being scored.
 */
export const KNOW_AREAS = Object.freeze([
  "admin",
  "agent-systems",
  "climbing",
  "health-and-food",
  "mental-health",
  "money",
  "research",
  "social",
]);

/**
 * A layer name, as the skill names that layer became.
 *
 * The trigger files predate the skills and name layers; this is the one table
 * that maps them, so an old file keeps scoring and a new one names a skill
 * directly. `operate` maps to nothing because the base is not a skill: it is
 * the one file every prompt carries whoever the run writes for, and there is
 * nothing to grant or withhold.
 */
export const LAYER_SKILL_ALIASES = Object.freeze({
  operate: Object.freeze([]),
  write: Object.freeze(["write"]),
  know: Object.freeze(["know-intent", "know-week", ...KNOW_AREAS.map((area) => `know-${area}`)]),
});

/** The skill names one loaded trigger is about: a `skill` file names its own,
 *  and a `layer` file names the skills that layer became. A file whose name is
 *  in neither table is about nothing nameable, and says so with an empty list
 *  rather than with a guess. */
export function triggerSkills(trigger) {
  if (trigger?.kind === "skill") return typeof trigger.name === "string" && trigger.name !== "" ? [trigger.name] : [];
  if (trigger?.kind === "layer") return [...(LAYER_SKILL_ALIASES[trigger.name] ?? [])];
  return [];
}

export function loadTriggers(tomquestTree) {
  const dir = path.join(tomquestTree, TRIGGERS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".draft.json"))
    .sort()
    .map((name) => {
      const trigger = { file: name, ...JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) };
      // NORMALISED ON THE WAY OUT, never written into the file. A trigger file
      // is Tom-facing text about one name, and a list of skill names copied
      // into it would be a second copy of LAYER_SKILL_ALIASES that goes stale
      // the day an area page is added.
      return { ...trigger, skills: triggerSkills(trigger) };
    });
}

/** How many positives and negatives one trigger file carries, whichever way it
 *  writes them: as a `cases` list flagged `negative`, which is the form every
 *  checked-in file uses, or as the lists or counts the first sketch of the
 *  format had. ONE SPELLING of the count, so the rule and the report cannot
 *  come to disagree. */
export function triggerCounts(trigger) {
  const count = (value) => (Array.isArray(value) ? value.length : (Number.isFinite(value) ? value : 0));
  if (Array.isArray(trigger?.cases)) {
    const negatives = trigger.cases.filter((one) => one?.negative === true).length;
    return { positives: trigger.cases.length - negatives, negatives };
  }
  return { positives: count(trigger?.positives), negatives: count(trigger?.negatives) };
}

/**
 * The five task kinds, and which of them still wait on a branch.
 *
 * `locate`, `explain` and `change` are the repo-task kinds. `delegate` and
 * `slack` are two widenings of that closed union, each defined by its own
 * design and each built on its own branch — and BOTH OF THOSE BRANCHES ARE
 * MERGED (uac/delegate at f0da2f9, uac/slack at 325bf31), so neither kind is
 * held back any more and all five items run.
 *
 * TASK_BRANCHES is kept, empty, and so is the skip it drives: it is the one
 * place a kind whose runner genuinely has not landed is named, and a widening
 * that arrives on a branch adds its row here and takes it out on merge. An
 * empty map means nothing is waiting on a branch — a kind with no runner wired
 * is a different fact, and runTask says that one separately.
 */
export const TASK_KINDS = Object.freeze(["locate", "explain", "change", "delegate", "slack"]);
export const TASK_BRANCHES = Object.freeze({});

/**
 * One task against one worktree. Returns { id, judged, reason } — the same
 * shape a golden item's result has, so aggregate() takes both.
 */
export async function runTask(task, trees, io) {
  const base = { id: task.id, partition: `task/${task.repo}`, verdict: "approve", confirmed: true };
  if (!TASK_KINDS.includes(task.kind)) {
    return { ...base, judged: "fail", reason: `unknown task kind ${task.kind}` };
  }
  const branch = TASK_BRANCHES[task.kind];
  if (branch !== undefined) {
    // The item format and this interface are settled; the code that answers
    // these items arrives with its own branch.
    return { ...base, judged: "skip", reason: `${task.kind} runner arrives with branch ${branch}` };
  }
  if (typeof io?.runTaskKind !== "function") {
    return { ...base, judged: "skip", reason: `no runner wired for task kind ${task.kind}` };
  }
  const produced = await io.runTaskKind(task, trees);
  // THE MECHANICAL HALF DECIDES FIRST. mustName and mustNotName are read off
  // the answer's own text with no model in the loop, and a violation is the
  // item's score — the kind runner's own verdict, and any judge behind it, is
  // not consulted about a text that already broke the item's rule. The check
  // runs only when the runner surfaced its text: a runner that reports a
  // verdict and no answer has nothing to check mechanically, and scoring an
  // absent text against mustName would fail every such item.
  if (typeof produced?.text === "string") {
    const mechanical = mechanicalChecks(task.expect, produced.text);
    if (mechanical !== null) return { ...base, ...produced, judged: "fail", reason: mechanical };
  }
  return { ...base, ...produced };
}

/** A bare 40-hex commit id, or the abbreviation of one. A ref that looks like
 *  this is a COMMIT, not a branch, and the cache clone will not have it unless
 *  it was asked for by name. */
const SHA_LIKE = /^[0-9a-f]{7,40}$/;

/**
 * Make `ref` resolvable in the cache clone, or throw saying it is not.
 *
 * THE CACHE CLONE IS SHALLOW AND BRANCH-ONLY (tts-code-lib.mjs cacheRepoDir:
 * `clone --depth 1 --branch <branch>`, then `fetch --depth 1 origin <branch>`),
 * so a pull-request head sha is in the repo only by accident. `git worktree add
 * --detach <dir> <sha>` on a sha the repo does not have throws, and before this
 * every tom.quest pull-request run died there. GitHub serves an exact commit id
 * to `git fetch`, so the sha is asked for by name.
 */
export function ensureRef(repoDir, ref, run = git) {
  const has = () => {
    try {
      run(repoDir, "cat-file", "-e", `${ref}^{commit}`);
      return true;
    } catch {
      return false;
    }
  };
  if (has()) return;
  if (!SHA_LIKE.test(String(ref))) {
    throw new Error(`${ref} is not in the cache clone of ${repoDir} and is not a commit id to fetch`);
  }
  try {
    run(repoDir, "fetch", "--depth", "1", "origin", ref);
  } catch (error) {
    throw new Error(`could not fetch ${ref}: ${String(error?.message ?? error).split("\n")[0]}`);
  }
  if (!has()) throw new Error(`fetched ${ref} but it is still not a commit in ${repoDir}`);
}

/**
 * A detached worktree of `ref` on a cache clone, and a function that removes
 * it. A worktree is exactly the tool for reading another commit without
 * touching a checkout somebody else owns — the nightly job owns /root/wikitom's
 * working tree, and this must never reset --hard it.
 */
export function worktreeFor(repoDir, repo, ref) {
  const dir = path.join(WORK_DIR, repo, `${ref}`.replace(/[^A-Za-z0-9]/g, "-").slice(0, 24));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });
  git(repoDir, "worktree", "prune");
  git(repoDir, "worktree", "add", "--detach", dir, ref);
  return {
    dir,
    commit: git(dir, "rev-parse", "HEAD").trim(),
    remove: () => {
      try {
        git(repoDir, "worktree", "remove", "--force", dir);
      } catch {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** The modules a set of items needs, imported from the pinned tom.quest tree. */
export async function loadModules(tomquestTree, items) {
  const modules = {};
  for (const item of items) {
    const job = JOBS[item.job];
    if (job === undefined || job.module === null || modules[item.job] !== undefined) continue;
    // A job may name MORE THAN ONE module of the pinned tree — the learning
    // job's prompt and writer are in nightly.mjs and the ground signals it is
    // given are in learning-ground.mjs. They are merged into one namespace so
    // build, parse and score each take a single `mod`, and the FIRST path
    // listed wins a name both export.
    const paths = Array.isArray(job.module) ? job.module : [job.module];
    const loaded = [];
    for (const rel of paths) loaded.push(await import(pathToFileURL(path.join(tomquestTree, rel)).href));
    modules[item.job] = loaded.length === 1 ? loaded[0] : Object.assign({}, ...loaded.reverse());
  }
  return modules;
}

/**
 * The ids a run PASSED: every id it scored, less every id it recorded a
 * failure for, golden items and repo tasks alike. This is the only thing the
 * head run needs from the base run — the retry rule tries again exactly the
 * items the base passed, which is exactly the set gate() could call a
 * regression.
 */
export function passedIds(run) {
  if (run === null || run === undefined) return new Set();
  const failed = new Set([...(run.failures ?? []), ...(run.tasks?.failures ?? [])].map((failure) => failure.id));
  return new Set((run.scoredIds ?? []).filter((id) => !failed.has(id)));
}

/**
 * One item, scored as many times as HEAD_TRIALS allows.
 *
 * `once` is the whole scoring of one item — runItem or runTask — and it is
 * called a second and third time only when the first call FAILED an item the
 * BASE PASSED, and it stops the moment one of them passes. Everything else
 * costs exactly one call, as before.
 *
 * The result kept is the first passing trial if there was one, else the first
 * trial: a run in which nothing was retried is the old run's result with
 * `trials` added and nothing else moved.
 */
export async function runTrials(id, basePassed, once) {
  const first = await once();
  if (first.judged === "skip") return first;
  if (first.judged === "pass" || !basePassed.has(id)) {
    return { ...first, trials: { head: 1, headPassed: first.judged === "pass" ? 1 : 0 } };
  }
  const results = [first];
  while (results.length < HEAD_TRIALS) {
    const next = await once();
    results.push(next);
    if (next.judged === "pass") break;
  }
  const passing = results.find((result) => result.judged === "pass");
  return {
    ...(passing ?? first),
    trials: { head: results.length, headPassed: results.filter((result) => result.judged === "pass").length },
  };
}

// ── Efficiency, read off the record ──────────────────────────────────────────

/**
 * One run's tokens: FOUR COLUMNS, NAMED. thinkingTokens is NOT one of them and
 * must not be added.
 *
 * VERIFIED AGAINST BOTH PARSERS in worker/runs/ingest.mjs — totalsOf, and the
 * totals reduce on each of the Claude path and the Codex path. thinkingTokens
 * is parsed out of output_tokens_details.thinking_tokens /
 * reasoning_output_tokens, which is a BREAKDOWN OF output_tokens rather than a
 * fifth column, and both parsers compute
 * totalTokens = input + cacheRead + cacheWrite + output with thinking left
 * out. Adding it here would double-count every thinking token.
 *
 * The numbers are READ BACK FROM THE RECORD and never counted by the harness.
 * That is what makes "read from the run file rather than estimated" true of
 * the evals too, and it is the only way the two cache columns are right.
 */
export const tokensOf = (totals) =>
  totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens;

/**
 * How long a trial waits for its own run to appear in the record. SHORT AND
 * BOUNDED: the sweeper needs a moment to see the file, and a trial that waited
 * on it forever would cost more than the measurement is worth.
 *
 * The wait counts ATTEMPTS rather than reading a clock, because io.now is the
 * run's injected clock and a fake one does not advance.
 */
export const RUN_RECORD_WAIT_MS = 60_000;
export const RUN_RECORD_POLL_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runRecordFor(io, token) {
  // No token means runClaude spooled no registration, or the receipt
  // out-parameter is not wired in this tree. The trial's tokens are unknown,
  // which is reported and fails nothing.
  if (typeof token !== "string" || token === "" || typeof io.runRecord !== "function") {
    return { tokens: null, turns: null };
  }
  const attempts = Math.max(1, Math.ceil(RUN_RECORD_WAIT_MS / RUN_RECORD_POLL_MS));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let record = null;
    try {
      record = await io.runRecord(token);
    } catch {
      // A record that cannot be fetched is an unknown cost, not a failed case.
    }
    const totals = record?.outcome?.totals;
    if (totals !== undefined && totals !== null) {
      return { tokens: tokensOf(totals), turns: record.outcome.turns ?? null };
    }
    if (attempt < attempts - 1) await (io.sleep ?? sleep)(RUN_RECORD_POLL_MS);
  }
  return { tokens: null, turns: null };
}

/** The MEDIAN trial's tokens, not the mean: one timed-out trial must not fail
 *  a case on cost. A trial whose tokens are unknown is left out, and a case
 *  with no readable trial has no number at all. */
export function medianTokens(perTrial) {
  const numbers = (perTrial ?? []).map((trial) => trial.tokens).filter((value) => typeof value === "number").sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 1 ? numbers[middle] : Math.round((numbers[middle - 1] + numbers[middle]) / 2);
}

/** How much more a case may cost at head before the rise is a finding. */
export const EFFICIENCY_RISE = 3;

/**
 * One case's efficiency, head against base. Pure.
 *
 * THE SAME-OUTPUT CLAUSE IS LOAD-BEARING. A case fails on efficiency only when
 * it cost more than EFFICIENCY_RISE times the base AND its judged result is
 * IDENTICAL in both runs: a case whose output got better and longer is a fact
 * to report, not a failure, and without the clause every genuine improvement
 * would fail this arm.
 *
 * An unknown cost on either side — no record came back within the wait — is
 * REPORTED AS UNKNOWN AND FAILS NOTHING. A slow sweeper must not turn into a
 * red merge check.
 */
export function efficiencyVerdict(headCase, baseCase) {
  const headTokens = headCase?.tokensMedian ?? null;
  const baseTokens = baseCase?.tokensMedian ?? null;
  if (typeof headTokens !== "number" || typeof baseTokens !== "number" || baseTokens === 0) {
    return { failed: false, headTokens, baseTokens };
  }
  const sameVerdict = headCase.judged === baseCase.judged;
  return { failed: sameVerdict && headTokens > baseTokens * EFFICIENCY_RISE, headTokens, baseTokens };
}

/** The efficiency block of a row: how many cases carried a cost, how many did
 *  not, and every rise. The rises need the base run's per-case medians, so
 *  they are computed where the base row is in hand (stampAgainstBase). */
export function efficiencyOf(results, baseResults) {
  // ONLY THE CASES THAT WERE MEASURED. A case with no `tokensMedian` key was
  // never asked what it cost — every non-`run` job is one — and counting it as
  // an unknown would report the whole set as unmeasured on a run that measured
  // everything it could.
  const cases = (results ?? []).filter((one) => one !== null && one !== undefined && "tokensMedian" in one);
  const byId = new Map((baseResults ?? []).map((one) => [one.id, one]));
  const rises = [];
  for (const headCase of cases) {
    const verdict = efficiencyVerdict(headCase, byId.get(headCase.id));
    if (verdict.failed) rises.push({ id: headCase.id, headTokens: verdict.headTokens, baseTokens: verdict.baseTokens });
  }
  return {
    cases: cases.length,
    unknown: cases.filter((one) => typeof one.tokensMedian !== "number").length,
    rises: rises.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// ── One case, over its trials ────────────────────────────────────────────────

/**
 * One `run` case, scored.
 *
 * TWO RULES MEET HERE AND THEY ANSWER DIFFERENT QUESTIONS. Do not collapse
 * them, and do not flip the gate to pass^k.
 *
 * THE LANDED RULE — HEAD_TRIALS, runTrials, isFlaky, and the `flaky` count in
 * aggregate and in scripts/evals-check.mjs's report — says an item that passed
 * one trial and failed another IS A PASS, counted apart as flaky and never a
 * regression, because every item is a live model call and a one-trial gate
 * fails a merge on the regeneration's noise. That rule governs THE MERGE GATE,
 * and this function keeps its semantics exactly: `judged` is "pass" when ANY
 * trial passed, and the `trials: { head, headPassed }` object below is the
 * shape isFlaky and aggregate already read — so a flaky `run` case is counted
 * flaky by code that needed no edit at all.
 *
 * THE STRICTER STANDARD — passK, every trial passed — governs GRADUATION: the
 * weekly pass that promotes a capability case into the set gating every future
 * merge reads passK, because promoting a case on one lucky trial writes the
 * noise straight into the gate. It is RECORDED here and gates nothing.
 *
 * passAtK is recorded and gates nothing; it is `judged` said as a number.
 *
 * The count of trials is `trialCount` rather than `trials`, because `trials`
 * is already the landed object above and a second meaning for one name is how
 * two readers come to disagree about what a row says.
 */
export async function runCase(item, context, io, { pr = false } = {}) {
  const job = JOBS[item.job];
  const base = baseOf(item);
  if (job === undefined) return { ...base, judged: "fail", reason: `no runner for job ${item.job}` };
  const standard = await loadWritingStandard();
  const deterministic = (fresh) => deterministicFailure(item, job, fresh, standard);
  const count = trialsFor(item, { pr });
  const perTrial = [];
  for (let trial = 0; trial < count; trial += 1) {
    const receipt = {};
    const result = await runItem(item, context, io, { deterministic, receipt });
    // A skip is not a trial. An io with no skill assembler throws while the
    // prompt is being assembled, before any model call, so nothing has been
    // spent and nothing is scored — the case is counted as skipped, that is
    // all, and realIo never takes this path.
    if (result.judged === "skip") return { ...base, judged: "skip", reason: result.reason };
    const record = await runRecordFor(io, receipt.runToken);
    perTrial.push({ judged: result.judged, reason: result.reason, tokens: record.tokens, turns: record.turns });
  }
  const passed = perTrial.filter((trial) => trial.judged === "pass").length;
  const failing = perTrial.find((trial) => trial.judged !== "pass");
  return {
    ...base,
    judged: passed > 0 ? "pass" : "fail",
    reason: (failing ?? perTrial[0])?.reason,
    trialCount: perTrial.length,
    passed,
    passK: perTrial.length > 0 && passed === perTrial.length,
    passAtK: passed > 0,
    trials: { head: perTrial.length, headPassed: passed },
    tokensMedian: medianTokens(perTrial),
    perTrial,
  };
}

// ── The ablation arm ─────────────────────────────────────────────────────────

/**
 * Every node id a case's prompt carried, in the order the arm will ablate them.
 *
 * `input.preludeNodes` is the case's own `context.graphNodes`, and it comes in
 * one of two shapes. A WALK is a list of entries each carrying a `cost` — the
 * least total edge cost from a seed, which worker/jobs/graph.mjs's `walk`
 * computes — and the FIVE LOWEST-COST nodes are taken, because a low cost is a
 * node the walk reached first and therefore the part of the prompt the case's
 * own subject pulls hardest on; ablating the cheapest five asks whether the
 * nodes the walk is most confident about are carrying anything. The id breaks a
 * tie, so two nodes at one cost order the same way on two machines.
 *
 * A FLAT LIST of ids carries no cost, and the first five are taken IN THE
 * LIST'S OWN ORDER — which is the prompt's own order, since `givenNodes` writes
 * the ids in the order the prompt rendered them. There is nothing else to sort
 * a flat list by, and inventing a ranking for it would make the arm's selection
 * a judgement this file is not entitled to make.
 */
export function ablationNodes(preludeNodes) {
  const list = Array.isArray(preludeNodes) ? preludeNodes : [];
  const idOf = (entry) => (typeof entry === "string" ? entry : String(entry?.id ?? ""));
  const walked = list.every(
    (entry) => entry !== null && typeof entry === "object" && typeof entry.cost === "number",
  );
  const ordered = walked && list.length > 0
    ? [...list].sort((a, b) => a.cost - b.cost || idOf(a).localeCompare(idOf(b)))
    : list;
  return ordered.map(idOf).filter((id) => id !== "").slice(0, ABLATION_NODE_CAP);
}

/**
 * The same case, assembled without one name.
 *
 * THERE IS NO THIRD WORKTREE AND treesFor IS NOT TOUCHED. What is ablated is A
 * NAME IN A SET, not a state of the repository: the arm assembles the same
 * prelude from the same two trees with one name taken out of the selection. A
 * third worktree would imply a third commit, and would turn "run this case
 * without the know layer" into a git operation, which it is not.
 *
 * ONE TRIAL PER ABLATED NAME, never the case's own trial count. The arm is
 * REPORTED AND NEVER GATED, and n x trials x names is the whole cost of this
 * phase; one trial per name over a 200-case weekly set is far more evidence
 * than a removal proposal needs.
 *
 * A NODE IS THE THIRD LIST, beside the layers and the skills. A layer and a
 * skill are names for a set of nodes, so ablating one asks a question about a
 * file; ablating a node asks it about one line, which is the unit a removal
 * proposal is written in. The nodes come off `input.preludeNodes` — the case's
 * own `context.graphNodes`, the ids its prompt actually carried — and a case
 * that has none contributes no node rows.
 *
 * THE CAP IS ABLATION_NODE_CAP AND THE REASON IS ARITHMETIC: a case's prompt
 * admits up to GRAPH_NODES_CAP nodes, and one trial each would be a fortyfold
 * arm on a prompt of forty. Five nodes over a 200-case weekly set is a thousand
 * trials, which is more evidence than a removal proposal needs.
 *
 * A case whose prelude was not known is SKIPPED and counted: you cannot remove
 * a name from a prompt that was replayed verbatim.
 */
export async function ablationFor(item, context, io, withPass) {
  const names = item.input?.preludeNames ?? { layers: [], skills: [] };
  if (item.input?.preludeKnown !== true) {
    return { rows: [], skipped: [{ id: item.id, reason: "the prompt was replayed verbatim; there is no name to remove" }] };
  }
  const job = JOBS[item.job];
  const standard = await loadWritingStandard();
  const deterministic = (fresh) => deterministicFailure(item, job, fresh, standard);
  const nodes = ablationNodes(item.input?.preludeNodes);
  const everyNode = Array.isArray(item.input?.preludeNodes)
    ? item.input.preludeNodes.map((entry) => (typeof entry === "string" ? entry : String(entry?.id ?? "")))
    : [];
  const rows = [];
  const skipped = [];
  for (const [kind, list] of [["layer", names.layers ?? []], ["skill", names.skills ?? []], ["node", nodes]]) {
    for (const name of list) {
      const without = {
        ...item,
        input: {
          ...item.input,
          // THE NODE LIST TRAVELS IN preludeNames because that object is the
          // whole of what the assembler is handed (JOBS.run.build calls
          // context.prelude(item.input.preludeNames) and reads nothing else), so
          // a node removed anywhere else would assemble the identical prompt and
          // score the same run twice. An assembler that does not read `nodes`
          // yet produces the same prompt either way, and the row then says
          // withoutPass equals withPass — which is what that assembler did, not
          // a claim about the node.
          preludeNames: {
            layers: (names.layers ?? []).filter((one) => kind !== "layer" || one !== name),
            skills: (names.skills ?? []).filter((one) => kind !== "skill" || one !== name),
            ...(kind === "node" ? { nodes: everyNode.filter((one) => one !== name) } : {}),
          },
          ...(kind === "node" ? { preludeNodes: everyNode.filter((one) => one !== name) } : {}),
        },
      };
      const result = await runItem(without, context, io, { deterministic });
      if (result.judged === "skip") {
        skipped.push({ id: item.id, reason: result.reason });
        continue;
      }
      rows.push({ id: item.id, name, kind, withPass, withoutPass: result.judged === "pass" });
    }
  }
  return { rows, skipped };
}

/**
 * How many cases a name needs behind it before its ablation is worth reading.
 * Below this the comparison is noise, and a removal proposal resting on two
 * cases is exactly the confident-and-wrong simplification this whole layer is
 * written against.
 */
export const MIN_ABLATION_CASES = 5;

/**
 * Which names did not earn their tokens, computed over the WEEKLY SET and
 * never per case: a name that one case passes without is a coin toss, and the
 * question is whether the name is carrying its cases at all.
 *
 * REPORTED, NEVER GATED. The golden set is mined out of Tom's rulings rather
 * than designed for coverage, so a name whose cases pass without it may still
 * be preventing a failure mode the set does not contain. This says what the
 * set shows; what to remove is his.
 */
export function ablationFindings(ablation) {
  const byName = new Map();
  for (const row of ablation ?? []) {
    // KEYED ON THE KIND AND THE NAME TOGETHER, and each finding says which kind
    // it is about. A node's `name` is its node id (`line:1a2b3c4d`), a layer's
    // is a layer name, and nothing stops a future id from reading like a name —
    // one key would silently add the two counts together and report a finding
    // about neither.
    const kind = String(row.kind ?? "");
    const key = `${kind}|${row.name}`;
    const entry = byName.get(key) ?? { name: row.name, kind, cases: 0, withPass: 0, withoutPass: 0 };
    entry.cases += 1;
    if (row.withPass) entry.withPass += 1;
    if (row.withoutPass) entry.withoutPass += 1;
    byName.set(key, entry);
  }
  return [...byName.values()]
    .filter((entry) => entry.cases >= MIN_ABLATION_CASES)
    .map((entry) => ({ ...entry, earned: entry.withoutPass / entry.cases < entry.withPass / entry.cases }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
}

/**
 * One run: the golden items of the pinned tom.quest tree, regenerated against
 * the pinned WikiTom tree, judged, aggregated, and posted as one evals-run row.
 * `io` carries every side effect so the test can drive this with no network
 * and no model.
 */
export async function runEvals({ repo, sha, limit = PR_ITEMS, jobs = null, weekly = false, ablation = false, basePassed = new Set() }, io) {
  const startedAt = io.now();
  const trees = treesFor(repo, sha);
  const tomquest = io.worktree("tom.quest", trees.tomquest);
  const wikitom = io.worktree("WikiTom", trees.wikitom);
  try {
    const all = loadGolden(tomquest.dir);
    const wanted = jobs === null ? all : all.filter((item) => jobs.includes(item.job));
    const items = weekly ? wanted : selectItems(wanted, Math.max(1, Math.floor(limit / 2)));
    const modules = await io.loadModules(tomquest.dir, items);
    const layerCache = new Map();
    const preludeCache = new Map();
    const context = {
      cmtDir: io.cmtDir?.() ?? undefined,
      modules,
      layers: (names) => {
        const key = names.join(",");
        if (!layerCache.has(key)) layerCache.set(key, io.layers(tomquest.dir, wikitom.dir, names));
        return layerCache.get(key);
      },
      // ONE ASSEMBLY PER NAME SET PER RUN. The ablation arm asks for a dozen
      // near-identical sets and every case asks for its own, so the cache is
      // what keeps this to a handful of prelude.mjs invocations rather than
      // one per trial.
      prelude: (names) => {
        // THE NODE LIST IS PART OF THE KEY. The node arm asks for the same
        // layers and the same skills with one node id missing, so a key built
        // from the two name lists alone would hand every node trial the cached
        // assembly of the trial before it and score one prompt five times.
        const key = `${(names?.layers ?? []).join(",")}|${(names?.skills ?? []).join(",")}|${(names?.nodes ?? []).join(",")}`;
        if (!preludeCache.has(key)) preludeCache.set(key, preludeFrom(io, tomquest.dir, wikitom.dir, names));
        return preludeCache.get(key);
      },
    };
    const results = [];
    const ablationRows = [];
    const ablationSkipped = [];
    for (const item of items) {
      // A `run` case is scored over its own trials with the deterministic
      // checks in front of the judge; every other item keeps the landed
      // retrial path exactly as it was. A weekly run is the full-trials run
      // and everything else is a pull-request run.
      if (item.job === "run") {
        const result = await runCase(item, context, io, { pr: !weekly });
        results.push(result);
        if (ablation && result.judged !== "skip") {
          const arm = await ablationFor(item, context, io, result.judged === "pass");
          ablationRows.push(...arm.rows);
          ablationSkipped.push(...arm.skipped);
        }
        continue;
      }
      results.push(await runTrials(item.id, basePassed, () => runItem(item, context, io)));
    }
    const tasks = [];
    for (const taskRepo of io.taskRepos?.(tomquest.dir) ?? []) {
      for (const task of loadTasks(tomquest.dir, taskRepo)) {
        tasks.push(await runTrials(task.id, basePassed, () => runTask(task, trees, io)));
      }
    }
    const scored = results.filter((result) => result.judged !== "skip");
    const summary = aggregate(scored);
    return {
      repo,
      // The RESOLVED commit of whichever repo this run pins, so a run named
      // "origin/main" is recorded and keyed by the sha it actually scored.
      sha: repo === "WikiTom" ? wikitom.commit : tomquest.commit,
      tomquest: tomquest.commit,
      wikitom: wikitom.commit,
      goldenHash: goldenHash(all),
      regenModel: REGEN_MODEL,
      judgeModel: JUDGE_MODEL,
      startedAt,
      finishedAt: io.now(),
      // Trials, not items: a retried item costs its calls again and the row
      // says so. The ablation arm is one trial per name and costs the same two
      // calls each, so it is counted rather than hidden.
      calls: (scored.reduce((total, result) => total + (result.trials?.head ?? 1), 0) + ablationRows.length) * 2,
      // The ids actually scored, so the gate can tell a newly added item apart
      // from one that regressed without re-deriving the selection.
      scoredIds: [...scored, ...tasks.filter((task) => task.judged !== "skip")].map((result) => result.id).sort(),
      skipped: results.filter((result) => result.judged === "skip").map(({ id, reason }) => ({ id, reason })),
      // A --weekly run SAYS SO ON THE ROW. The weekly graduation pass
      // (scripts/graduate-golden.mjs) promotes a capability case on this
      // evidence and no other: a pull-request run scores a 40-item subset
      // against one branch's tree, and a case promoted on that would let one
      // branch raise the bar for main permanently. That pass refuses a row
      // which does not say, rather than inferring it from the item count.
      weekly,
      // ONE LIST about the cases, never two. Every scored case, how it scored,
      // whether it passed EVERY trial, and what its median trial cost.
      //
      // `passK` means one thing across both scoring paths: on a `run` case it
      // is the case's own, and on everything going through the landed
      // runTrials path it is derived from the same trial counts — otherwise
      // the graduation pass would be reading a field that exists on only half
      // the rows and silently graduating nothing from the other half.
      //
      // `tokensMedian` is ABSENT on a case that was never measured and null on
      // a measured case whose record did not come back: the difference between
      // "not asked" and "asked, no answer". The efficiency block counts only
      // the cases that were asked.
      results: scored.map((result) => ({
        id: result.id,
        judged: result.judged,
        passK: result.passK ?? (result.trials === undefined
          ? result.judged === "pass"
          : result.trials.headPassed === result.trials.head),
        ...(result.perTrial === undefined ? {} : { tokensMedian: result.tokensMedian ?? null }),
      })),
      ablation: ablationRows,
      ablationSkipped,
      ...summary,
      tasks: aggregate(tasks.filter((task) => task.judged !== "skip")),
      tasksSkipped: tasks.filter((task) => task.judged === "skip").map(({ id, reason }) => ({ id, reason })),
    };
  } finally {
    tomquest.remove();
    wikitom.remove();
  }
}

const FLAGS = new Set(["--serve", "--weekly", "--force", "--ablation"]);
const VALUED = new Set(["--repo", "--sha", "--base", "--tasks", "--limit", "--jobs"]);

export function parseArgs(argv) {
  const options = {
    repo: null, sha: null, base: null, limit: PR_ITEMS,
    jobs: null, force: false, serve: false, weekly: false, ablation: false, tasks: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const name = argument.includes("=") ? argument.slice(0, argument.indexOf("=")) : argument;
    if (FLAGS.has(name)) {
      options[name.slice(2)] = true;
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
    if (name === "--limit") options.limit = Number(value);
    else if (name === "--jobs") options.jobs = value.split(",").filter(Boolean);
    else options[name.slice(2)] = value;
  }
  if (!options.serve && !options.weekly && options.tasks === null && (options.repo === null || options.sha === null)) {
    throw new Error("--repo and --sha are required unless --serve, --weekly or --tasks is given");
  }
  if (!Number.isFinite(options.limit) || options.limit <= 0) throw new Error("--limit must be a positive number");
  // The ablation arm runs nightly and weekly and NEVER on a pull request: it
  // costs one extra trial per name per case, it is reported and gates nothing,
  // and a merge must not wait on a measurement no gate reads. A weekly run
  // turns it on; a nightly run asks for it by name; --serve leaves it off.
  if (options.weekly) options.ablation = true;
  return options;
}

/** The io a real run uses. Everything that touches the network, git, the disk
 *  or a model lives here, so the test drives runEvals with none of them. */
function realIo(env) {
  return {
    now: () => Date.now(),
    runClaude: async (prompt, options) => runClaude(prompt, options),
    layers: (tomquestTree, wikitomTree, names) => layersFor(tomquestTree, wikitomTree, names),
    // The skill half of a name set, assembled by running the PINNED tree's own
    // scripts/publish-skills.mjs against the PINNED WikiTom tree and reading
    // what it wrote. Both trees go through, because the catalogue is one tree's
    // generator over the other tree's pages; skillsFor is the only thing that
    // needs to know that, and preludeFrom just hands the pair on.
    skills: (tomquestTree, wikitomTree, names) => skillsFor(tomquestTree, wikitomTree, names),
    //
    // One trial's own run, read back out of the record so its tokens and turns
    // are the ones the sweeper parsed rather than a number this file counted.
    // A run the sweeper has not seen yet is null, and null is unknown.
    runRecord: async (token) => {
      try {
        const answer = await convexFetch(env, `/tts/run-by-token?token=${encodeURIComponent(token)}`);
        return answer?.run ?? (answer?.runId ? answer : null);
      } catch {
        return null;
      }
    },
    loadModules,
    cmtDir: () => cacheRepoDir(env, { name: "ComplexMultiTrigger", owner: "Heffnt", branch: "master" }),
    taskRepos: (tomquestTree) => {
      const dir = path.join(tomquestTree, TASKS_DIR);
      return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    },
    worktree: (repo, ref) => {
      const repoDir = repo === "WikiTom"
        ? (process.env.WIKITOM_DIR || "/root/wikitom")
        : cacheRepoDir(env, { name: "tom.quest", owner: "Heffnt", branch: "main" });
      // Never reset --hard the WikiTom checkout: the nightly job owns its
      // working tree. A fetch plus a detached worktree reads the commit
      // without touching it.
      try {
        git(repoDir, "fetch", "origin");
      } catch {
        // A shallow clone can refuse a bare `fetch origin`; the exact ref
        // below is the fetch that matters and it says so if it fails.
      }
      ensureRef(repoDir, ref);
      return worktreeFor(repoDir, repo, ref);
    },
  };
}

async function postRun(env, data) {
  await convexFetch(env, "/tts/event", { kind: EVALS_RUN, key: `${data.repo}@${data.sha}`, data });
}

/**
 * The row a run that could not be made posts anyway.
 *
 * THE QUEUE IS DRAINED BY ANSWERS, NOT BY ATTEMPTS: `--serve` takes the OLDEST
 * request with no evals-run row at its key, so one sha the box cannot fetch or
 * check out is picked again on every tick and every later request waits behind
 * it forever. A recorded failure is the answer — it says what happened, and it
 * opens nothing: `regressions: null` denies the merge gate's evals arm, and
 * `error` makes scripts/evals-check.mjs's gate() fail rather than read "no
 * failures" off a run that scored nothing.
 */
export function failedRun({ repo, sha, error, at }) {
  return {
    repo,
    sha,
    tomquest: null,
    wikitom: null,
    goldenHash: null,
    regenModel: REGEN_MODEL,
    judgeModel: JUDGE_MODEL,
    startedAt: at,
    finishedAt: at,
    calls: 0,
    error,
    items: 0,
    pass: 0,
    fail: 0,
    flaky: 0,
    regressions: null,
    stillFailing: 0,
    // A run that could not be made checked no diff either, so the coverage
    // field says so rather than saying "satisfied". The merge gate denies on
    // null, which is what a row carrying `error` must do on every arm.
    goldenCoverage: null,
    weekly: false,
    byPartition: [],
    byVerdict: { approve: { items: 0, pass: 0 }, revise: { items: 0, pass: 0 } },
    failures: [],
    scoredIds: [],
    skipped: [],
    results: [],
    efficiency: { cases: 0, unknown: 0, rises: [] },
    ablation: [],
    ablationSkipped: [],
    tasks: aggregate([]),
    tasksSkipped: [],
  };
}

/**
 * The comparison lives in scripts/evals-check.mjs, because the pull-request
 * check is a standalone file with no imports (WikiTom's Action fetches it on
 * its own). The runner stamps the same numbers onto the row so the digest does
 * no comparison of its own, so it loads that ONE body from wherever it is:
 * beside this file in /opt/tts, or in scripts/ in a checkout.
 */
export async function loadGate() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.join(here, "evals-check.mjs"),
    path.join(here, "..", "..", "scripts", "evals-check.mjs"),
  ]) {
    if (fs.existsSync(candidate)) return await import(pathToFileURL(candidate).href);
  }
  return null;
}

/**
 * Stamp regressions, stillFailing and goldenCoverage onto a run, and mark each
 * failure with whether it is one — the digest prints regression lines and must
 * not have to compare two runs to know which they are.
 *
 * `diff` is the changed-path list the pull-request check computed and sent on
 * its request, and the pull-request body it read the escape-hatch trailer from.
 * THE SAME LIST REACHES BOTH SIDES: the check judges coverage in its own log
 * from the list it computed, and the box stamps the verdict onto the row from
 * the list that travelled with the request, so the log and the row cannot
 * disagree about what was judged.
 */
export async function stampAgainstBase(data, base, diff = {}) {
  const gateModule = await loadGate();
  // THREE-VALUED, and the third value is not a failure. `null` says nobody
  // asked this run about a diff — a --weekly run, a run by hand — and the
  // merge gate denies on it, which is right: a merge always has a diff, so a
  // run that was never asked has not answered. A gate that opened on "we did
  // not check" is the failure the `regressions: null` rule below prevents, and
  // this field takes the same posture on purpose.
  const goldenCoverage = gateModule === null
    ? null
    : gateModule.goldenItemRule(diff.changed, diff.prBody);
  if (gateModule === null || base === null || base === undefined) {
    // NULL, NOT ZERO. A run compared to nothing has no number of regressions,
    // and the merge gate opens its evals arm on exactly `regressions === 0`
    // (convex/ttsMerge.ts) — stamping 0 here would let a head that was never
    // compared to anything satisfy "evals with no regression". A non-number
    // is refused there and the deny message says the number was unreadable.
    return {
      ...data,
      regressions: null,
      stillFailing: 0,
      // Coverage is a fact about the DIFF, not about the comparison, so a run
      // with no base still answers it. A branch that changed a watched file
      // and shipped no item owes one whether or not anything scored its base.
      goldenCoverage,
      // No base, no rise: a cost is a comparison, and there is nothing to
      // compare to. The cases and the unknowns are still stated, because they
      // are facts about this run alone.
      efficiency: efficiencyOf(data.results, null),
      failures: data.failures.map((failure) => ({ ...failure, regression: false })),
    };
  }
  const verdict = gateModule.gate(data, base, { changed: diff.changed, prBody: diff.prBody });
  const regressed = new Set(verdict.regressions.map((failure) => failure.id));
  return {
    ...data,
    regressions: verdict.regressions.length,
    stillFailing: verdict.stillFailing.length,
    // From the gate's own verdict rather than from the rule called twice: one
    // body decides what coverage is, here and in the check's log alike.
    goldenCoverage: verdict.goldenCoverage,
    efficiency: efficiencyOf(data.results, base.results),
    failures: data.failures.map((failure) => ({ ...failure, regression: regressed.has(failure.id) })),
  };
}

async function runAndPost(env, io, { repo, sha, base, limit, jobs, weekly, ablation = false, force, changed, prBody }) {
  const existing = force ? null : await convexFetch(env, `/tts/evals-run?repo=${repo}&sha=${sha}`);
  if (existing?.run) {
    console.log(`[evals] ${repo}@${sha} already scored (${existing.run.pass}/${existing.run.items}); --force to rerun`);
    return existing.run;
  }
  // The base runs FIRST when nothing has scored it: a head run with no
  // baseline can only report, and the box is the only machine that can make
  // one, so it makes it here rather than leaving the check blind. It runs
  // WITHOUT the ablation arm — a baseline exists to be compared against, and
  // the arm is reported off the head run alone.
  let baseData = null;
  if (base) {
    const baseRun = await convexFetch(env, `/tts/evals-run?repo=${repo}&sha=${base}`);
    baseData = baseRun?.run ?? null;
    if (baseData === null) {
      baseData = await stampAgainstBase(await runEvals({ repo, sha: base, limit, jobs, weekly }, io), null);
      await postRun(env, baseData);
      console.log(`[evals] base ${repo}@${base}: ${baseData.pass}/${baseData.items} pass`);
    }
  }
  // The base's passing ids are the head run's retry list: exactly those items
  // can become a regression, so exactly those are tried again when they fail.
  const data = await stampAgainstBase(
    await runEvals({ repo, sha, limit, jobs, weekly, ablation, basePassed: passedIds(baseData) }, io),
    baseData,
    { changed, prBody },
  );
  await postRun(env, data);
  console.log(
    `[evals] ${repo}@${sha}: ${data.pass}/${data.items} pass, ` +
      `${data.regressions === null ? "compared to no base" : `${data.regressions} regression(s)`}, ` +
      `${(data.flaky ?? 0) + (data.tasks?.flaky ?? 0)} flaky, ` +
      `${data.stillFailing} still failing, ` +
      `golden coverage ${data.goldenCoverage === null ? "not asked" : data.goldenCoverage} ` +
      `(golden ${data.goldenHash})`,
  );
  return data;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = loadEnv({ require: ["CONVEX_SITE_URL", "TTS_WORKER_KEY"] });
  const io = realIo(env);

  if (options.tasks !== null) {
    const tomquest = io.worktree("tom.quest", "origin/main");
    try {
      const tasks = loadTasks(tomquest.dir, options.tasks);
      if (tasks.length === 0) {
        console.log(`evals: no repo tasks defined for ${options.tasks}`);
        return;
      }
      for (const task of tasks) {
        const result = await runTask(task, treesFor("tom.quest", "origin/main"), io);
        console.log(`${result.id}\t${result.judged}\t${result.reason ?? ""}`);
      }
    } finally {
      tomquest.remove();
    }
    return;
  }

  if (options.serve) {
    // One request per pass, so a cron tick is bounded.
    const { request } = await convexFetch(env, "/tts/evals-request");
    if (request === null || request === undefined) {
      console.log("[evals] no unanswered request");
      return;
    }
    try {
      await runAndPost(env, io, {
        repo: request.repo,
        sha: request.sha,
        base: request.baseSha,
        limit: options.limit,
        jobs: options.jobs,
        weekly: false,
        // A served request IS the pull-request run. The ablation arm never
        // runs here, whatever the command line said.
        ablation: false,
        // THE CHECK'S OWN DIFF, carried on the request. The box cannot compute
        // it — it has a shallow cache clone with no merge base — and a second
        // list computed here would be a second answer to the same question.
        // An older request carries neither, and neither is inferred: the
        // coverage verdict is then null and the merge gate denies, which is
        // the right answer for a run nobody asked about a diff.
        changed: request.changed,
        prBody: request.prBody,
        force: options.force,
      });
    } catch (error) {
      // A run that threw still has to be ANSWERED, or this request is taken
      // again on every tick and nothing behind it is ever served.
      const reason = serverErrorMessage(error);
      console.error(`[evals] ${request.repo}@${request.sha} could not be run: ${reason}`);
      await postRun(env, failedRun({ repo: request.repo, sha: request.sha, error: reason, at: Date.now() }));
    }
    return;
  }

  if (options.weekly) {
    // Two cron slots cover the same New York hour across the daylight-saving
    // switch; exactly one of them is 4 a.m. there, the same guard the nightly
    // and weekly jobs use.
    if (!options.force && nyHour(Date.now()) !== 4) {
      console.log(`[evals] NY hour is ${nyHour(Date.now())}, not 4 — this is the off-season cron slot, exiting`);
      return;
    }
    for (const repo of ["tom.quest", "WikiTom"]) {
      await runAndPost(env, io, { repo, sha: "origin/main", base: null, limit: options.limit, jobs: options.jobs, weekly: true, ablation: options.ablation, force: true });
    }
    return;
  }

  await runAndPost(env, io, {
    repo: options.repo,
    sha: options.sha,
    base: options.base,
    limit: options.limit,
    jobs: options.jobs,
    weekly: false,
    ablation: options.ablation,
    force: options.force,
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[evals] FAILED: ${serverErrorMessage(error)}`);
    process.exit(1);
  });
}
