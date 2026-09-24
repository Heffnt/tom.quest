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
//   node /opt/tts/evals.mjs --repo tom.quest --sha <sha> [--limit N] [--jobs prepare,code-brief] [--ablation] [--force]
//   node /opt/tts/evals.mjs --serve     # one polling pass over the request queue
//   node /opt/tts/evals.mjs --weekly    # the full set against both repos' main
//   node /opt/tts/evals.mjs --tasks <repo>
//   node /opt/tts/evals.mjs --faults-only   # the planted-fault audits, nothing else
//   node /opt/tts/evals.mjs --weekly --dry-run   # compute it all, post nothing
//
// The box POLLS. It has no inbound door: it talks out to Convex, GitHub and
// Slack, and nothing talks in but SSH with Tom's key. A GitHub Action posts a
// request to Convex and waits; a cron tick here picks it up.
//
// roll the box (worker/setup.sh) before or immediately after merging a change to the evals row contract; until it rolls, every evals request is pending and the gate names the protocol gap
//
// Then drain the pre-protocol queue once, from the laptop or the box:
//   npx convex run ttsEvals:internalSupersedeLegacyEvalsRequests '{}'
// Requests older than EVALS_PROTOCOL_SINCE (jobs/evals-row.mjs) are answered
// superseded without a model call either way; the drain does them all at once
// instead of twenty-five per five-minute pass, so a live head files behind an
// empty queue.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  convexFetch,
  extractJsonObject,
  loadEnv,
  nyHour,
  nyUtcOffsetHours,
  reportJobFailed,
  reportJobOk,
  MODELS,
  modelLabel,
  runClaude,
  runClaudeAsync,
  serverErrorMessage,
} from "./tts-lib.mjs";
import { cacheRepoDir } from "./tts-code-lib.mjs";
import { redactSecrets } from "./session-archive.mjs";
import {
  EVALS_PROTOCOL,
  scoredNothing,
  supersededFields,
  supersededName,
} from "./evals-row.mjs";
import { BOX_WIKITOM_DIR } from "./search-lib.mjs";
// THE AUDIT'S OWN PROMPT, IMPORTED AND NEVER RE-IMPLEMENTED. The planted-fault
// arm below asks the real auditor the real question about a fixture diff; a
// second copy of that prompt here would measure a prompt nothing else uses.
// Only the two stable exports are taken, so a change to how audit.mjs chunks or
// runs a diff lands here with no edit.
import { AUDIT_UNAVAILABLE, auditPrompt } from "./audit.mjs";
import { pruneStaleWorktrees, takeEvalsLock } from "./evals-lock.mjs";
import { replayContext } from "./evals-replay.mjs";

export const EVALS_RUN = "evals-run";
export const EVALS_REQUEST = "evals-request";
export const EVALS_PROTOCOL_FAILURE_KEY = "runs-evals:protocol";
export const EVALS_JOB = "runs-evals";

const REGEN_MODEL = process.env.TTS_EVALS_REGEN_MODEL || MODELS.evalsRegen;
export const JUDGE_MODEL = process.env.TTS_EVALS_JUDGE_MODEL || MODELS.evalsJudge;
export const REGEN_TIMEOUT_MS = 5 * 60 * 1000;
export const JUDGE_TIMEOUT_MS = 3 * 60 * 1000;

/** How many times an UNREADABLE judge answer is asked again. One: a malformed
 *  JSON string is a slip of the sampling and the second draw fixes it, and a
 *  judge that cannot write the object twice is telling the run something the
 *  run should record rather than paper over. A readable verdict is never
 *  retried at any count. */
export const JUDGE_RETRIES = 1;

/** The on-commit set: the newest 20 approve and 20 revise across the whole
 *  golden set, by ruledAt. The weekly run uses everything. */
export const PR_ITEMS = 40;

/** How many superseded requests one `--serve` pass will answer before leaving
 *  the rest to the next tick. Each costs one POST and no model, so this is a
 *  stop against a door that kept handing back the same request, not a budget
 *  against cost. */
export const SERVE_SUPERSEDED_LIMIT = 25;

/** A shallow cache needs this much history from each trusted tip before Git
 * can name their merge base. A deeper unbounded fetch would make a polling
 * pass depend on the whole repository history. */
export const DIFF_HISTORY_DEEPEN = 256;

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

/**
 * The reason an item's ORIGINAL INPUT CANNOT BE PUT IN FRONT OF THE MODEL, or
 * null. It is a sentence in the item's own file, written there by
 * scripts/triage-explanation-golden.mjs out of what the session archive shows.
 *
 * A MARKED ITEM IS NEVER SCORED AND NEVER DELETED, and the two halves of that
 * are equally deliberate. Never scored, because a replay that cannot reproduce
 * the input measures the gap and not the tree — the 27 mined explanations
 * failed identically at base and at head for exactly that reason, which made
 * them a cost the gate paid and learned nothing from. Never deleted, because
 * the item still records a real thing Tom ruled on, the reason it cannot be
 * replayed is a fact about the archive rather than about the item, and two of
 * the fifteen become replayable the day the next laptop archive lands.
 *
 * IT IS COUNTED SEPARATELY ON THE ROW (`unreplayable`) rather than folded into
 * `skipped`, because those are different facts: a skip is something this run
 * did not get to, and this is something no run can do.
 */
export function unreplayableReason(item) {
  const why = item?.unreplayable;
  return typeof why === "string" && why.trim() !== "" ? why.trim() : null;
}

/** An input the archive cannot supply at RUN TIME, though the item file carries
 *  no mark — a box whose WikiTom worktree has no session archive, an item
 *  imported since the last triage. runItem turns it into a skip before any
 *  model call, the way SkillsNotAssembledError is turned into one: nothing
 *  about the tree under test was measured, so calling it a regression would
 *  fail a merge over a gap in the harness. */
export class ReplayUnavailableError extends Error {}

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

/** The exact bytes of one scored item, retained on the run so the gate compares
 * only equal-id, equal-content measurements. */
export function contentHash(item) {
  return crypto.createHash("sha256").update(JSON.stringify(item)).digest("hex");
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
 * A module of the PINNED tree that phase 2 moved into shared/, at whichever
 * path that tree has it. A pin from before the move holds it at `oldRel`, and
 * a baseline run still checks such pins out, so both are tried: shared/ first,
 * then the old home.
 */
export function pinnedModule(tree, file, oldRel) {
  const moved = path.join(tree, "shared", file);
  return fs.existsSync(moved) ? moved : path.join(tree, oldRel);
}

/**
 * The inline module the PINNED tree's own skills.mjs is asked through.
 *
 * A CHILD PROCESS RATHER THAN AN IMPORT, for two reasons. worker/setup.sh
 * copies evals.mjs to /opt/tts/evals.mjs and skills.mjs to
 * /opt/tts/shared/skills.mjs — a different relative path from the one the two
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
 * The key is the pair of commits that the publisher reads, not the reusable
 * worktree directories. Weekly runs recreate `origin/main` at the same paths;
 * after either repository advances, reusing a catalogue made from those paths
 * would pair a new recorded commit with old skill bodies.
 */
const publications = new Map();

/** The two immutable objects a publication reads: WikiTom supplies its pages,
 * and tom.quest supplies the published repository rules. */
function publicationKey(tomquestTree, wikitomTree) {
  const tomquest = git(tomquestTree, "rev-parse", "HEAD").trim();
  const wikitom = git(wikitomTree, "rev-parse", "HEAD").trim();
  return `${tomquest} ${wikitom}`;
}

/** Hash the exact on-disk catalog bytes the pinned publisher produced. */
export function catalogHashFor(out) {
  const hash = crypto.createHash("sha256");
  const visit = (dir, relative = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(child, childRelative);
      else if (entry.isFile()) {
        hash.update(childRelative);
        hash.update("\0");
        hash.update(fs.readFileSync(child));
        hash.update("\0");
      }
    }
  };
  visit(out);
  return hash.digest("hex");
}

export function publicationFor(tomquestTree, wikitomTree, run = execFileSync, workDir = WORK_DIR) {
  const key = publicationKey(tomquestTree, wikitomTree);
  const held = publications.get(key);
  if (held !== undefined) return held;
  const out = path.join(workDir, "skills", crypto.createHash("sha256").update(key).digest("hex").slice(0, 16));
  const script = path.join(tomquestTree, "scripts", "publish-skills.mjs");
  // The two trees are handed in as the two REPOSITORIES as well as as the
  // sources of the pages: `repo-tom-quest` and `repo-wikitom` are then the
  // rules files of the exact commits this run pins, which is the standard every
  // other part of the prelude is held to. A repository the run pins nothing of
  // has no commit here to read, and comes back as a refusal in the grant block
  // rather than as whatever some checkout's HEAD says.
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
    out: result.out,
    catalogHash: catalogHashFor(result.out),
    published: result.skills.map((skill) => skill.name),
    why: Object.fromEntries(result.refused.map((entry) => [entry.name, entry.why])),
  };
  publications.set(key, built);
  return built;
}

/** The body of a published SKILL.md: its generated frontmatter and provenance
 *  comment off, the page itself untouched. What a run that loaded the skill
 *  read is the page; the two generated lines above it are how the harness finds
 *  the file, not part of what it says. */
export function skillBodyOf(text) {
  // The publisher is the only writer here, but a partial or corrupt generated
  // file must fail this evaluation rather than silently score a different prompt.
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  if (frontmatter === null) throw new Error("published SKILL.md has no frontmatter");
  const rest = text.slice(frontmatter[0].length);
  const provenance = /^\s*<!--[\s\S]*?-->[ \t]*\r?\n/.exec(rest);
  if (provenance === null) throw new Error("published SKILL.md has no provenance");
  return rest.slice(provenance[0].length).trim();
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
    pathToFileURL(pinnedModule(tomquestTree, "skills.mjs", "scripts/skills.mjs")).href,
    JSON.stringify({ names: skillNames, out: publication.out, commit: publication.commit, why: publication.why }),
  ], RUN_OPTIONS));
  const loaded = asked.files.map((file) => ({
    path: path.relative(publication.out, file).replace(/\\/g, "/"),
    body: skillBodyOf(fs.readFileSync(file, "utf8")),
  }));
  return {
    names: layerNames,
    skills: asked.granted,
    skillsRefused: asked.refused.map((entry) => entry.name),
    text: [...(layers === null ? [] : [layers.text]), asked.grants, ...loaded.map((one) => one.body)].join("\n\n"),
    commit: publication.commit,
    catalogHash: publication.catalogHash,
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
    // REMOVAL CHECK: cannot remove; scoring a prompt missing requested skill bodies would turn an assembly fault into an apparent model regression.
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
    // THE ONE JOB WHOSE `brief` IS THE LIFE TODO'S BRIEF, so the one job whose
    // `brief` the SIZE rules (2-5 sentences, at most 400 characters) bind. The
    // field name alone cannot say this — the code-brief job below also writes
    // a field called `brief`, and that one is 250 to 400 WORDS — so the job
    // declares it and standardRulesFor reads the declaration. A job that names
    // nothing here gets the form rules on its brief fields, which is the right
    // default for everything but this.
    briefSizeFields: ["brief"],
    opts: { maxTurns: 4 },
  },
  "code-brief": {
    layers: ["write", "know"],
    module: "worker/jobs/plan-graphs.mjs",
    build: (item, layers, mod) => mod.briefPrompt(item.input.entryYaml ?? item.input.statement, item.input.priorReviseSentence, layers.text),
    parse: (answer) => extractJsonObject(answer),
    fields: ["brief", "recommendation", "execClass", "evidence"],
    // Needs a CMT checkout and read-only tools, as the retired brief pass did.
    opts: { cwd: "@cmt", maxTurns: 8 },
  },
  // The mined explanations are not a job's output — they are what an agent
  // wrote to Tom in a session. The regeneration is the same act: the session
  // that agent was in, up to and including Tom's request, and the write and
  // know layers.
  //
  // THE SESSION IS THE INPUT, AND IT USED TO BE MISSING. This prompt carried
  // the topic and two context lines, which is not what the original agent had
  // by three orders of magnitude, so the regeneration answered "I don't have
  // the context" and the judge failed it at base and at head alike — 21 of the
  // 27 on the run at 129370b (2026-09-22). An item that scores the same however
  // the tree under test changes is measuring nothing and gating nothing while
  // costing a call each side. worker/jobs/evals-replay.mjs reads the session
  // back out of WikiTom's archive; an item whose input it cannot carry whole is
  // `unreplayable` in its own file and never reaches here.
  explanation: {
    layers: ["write", "know"],
    module: null,
    build: (item, layers, _mod, context) => [
      layers.text,
      ``,
      `Below is a working session with Tom, up to and including his request. Write`,
      `the answer to that request: a ground-up explanation of the topic named at the`,
      `end. He has not been given the concepts it rests on, so build them before you`,
      `use them.`,
      ``,
      `Answer with the explanation itself and nothing else: no preamble, no`,
      `restatement of the question, no closing offer of further help.`,
      ``,
      ...item.input.contextLines,
      ``,
      `--- THE SESSION ---`,
      ...context.replay(item).lines,
      `--- END OF THE SESSION ---`,
      ``,
      `Topic: ${item.input.topic}`,
    ].join("\n"),
    parse: (answer) => ({ explanation: String(answer ?? "").trim() }),
    fields: ["explanation"],
    // NO TOOLS, AND A BUDGET THAT DOES NOT DEPEND ON THAT HOLDING. Every one
    // of these items failed `error_max_turns` on the box on 2026-09-14: the
    // prompt carries the topic and its context lines, and the model went
    // reading the tree anyway — one turn to Read, one to Grep, and the budget
    // was gone before a word was written. The empty allow-list was the answer
    // to that.
    //
    // IT DID NOT CLOSE THE HOLE, because an allow-list is not what withholds
    // and DENIABLE_TOOLS was only the file-and-shell half of the CLI's set.
    // Eight of the twelve evals runs recorded between 2026-09-13 and
    // 2026-09-15 carried a runner error; all seventeen of those errors were
    // explanation items, fifteen at `error_max_turns` and two an unreadable
    // judge answer, and a different handful each run — which is why it read as
    // flake rather than as a fault. A runner error denies the merge fail-closed
    // (convex/ttsMerge.ts), so one of twenty-seven items burning two turns held
    // the gate shut for the whole branch. The probe in DENIABLE_TOOLS' header
    // found the cause: this job was still being handed sixteen tools.
    //
    // BOTH HALVES, because either alone is a guess. The list now denies the
    // whole built-in set, so there is nothing left to spend a turn on; and the
    // budget goes to eight — runClaude's own default, chosen there
    // for exactly this reason — so a job with no tools is never one stray call
    // from a runner error again. The turns cost tokens and nothing else: with
    // no tools there is no tree to read and no command to run, and an answer
    // that arrives on turn one still ends on turn one.
    opts: { maxTurns: 8, allowedTools: [] },
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
  // The runner check-in judge (worker/jobs/runner-checkin.mjs), scored against
  // evals/golden/checkins/. The regeneration IS the judge's call: the item holds
  // a fixed check-in and the verdict the judge must reach on it, so a change to
  // the judge's prompt or to the writing standard that flips a verdict is a
  // regression here. Scored without a second judge, by comparing verdicts.
  checkin: {
    layers: ["write"],
    module: "worker/jobs/runner-checkin.mjs",
    build: (item, layers, mod) => mod.checkInJudgePrompt(item.input.checkIn, layers.text),
    parse: (answer, mod) => mod.parseCheckInVerdict(answer),
    score: (item, fresh) => scoreCheckIn(item, fresh),
    fields: [],
    opts: { maxTurns: 1 },
  },
};

/** One golden check-in: the judge's fresh verdict against the one the item
 *  says it must reach. An unreadable answer is a failed item, never a pass. */
export function scoreCheckIn(item, fresh) {
  const wanted = item.expected?.verdict;
  if (fresh?.unreadable) return { judged: "fail", reason: `the judge's answer could not be read: ${fresh.head ?? ""}` };
  if (fresh?.verdict === wanted) {
    return { judged: "pass", reason: wanted === "fail" ? `failed it, as required: ${(fresh.complaints ?? []).join(" ")}`.trim() : "passed it, as required" };
  }
  return { judged: "fail", reason: `the judge said ${fresh?.verdict ?? "nothing"}, the item requires ${wanted}${fresh?.complaints?.length ? `: ${fresh.complaints.join(" ")}` : ""}` };
}

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
 *
 * `hideVerdict` DROPS EXACTLY TWO SECTIONS — TOM'S VERDICT and TOM'S SENTENCE —
 * and nothing else. It is the seam the judge-agreement measure below replays
 * through: that measure asks whether the judge reaches Tom's answer WITHOUT
 * being handed it, so the prompt it sends must be this prompt with his answer
 * taken out, and not a second prompt body written beside it. Two prompt bodies
 * would mean the thing measured is not the thing that runs.
 */
export function judgePrompt(item, fresh, fields, { hideVerdict = false } = {}) {
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
    `  give three or four words of the NEW output. Saying it is worse is not a reason.`,
    `- PUT NO QUOTATION MARKS IN THE REASON, of any kind. The reason is a JSON string value and one`,
    `  unescaped quote makes the whole answer unreadable — which is scored as a failed item, not as`,
    `  the verdict you reached. Name the words plainly, without quoting them.`,
    `- Answer with ONE JSON object and nothing else, no code fence:`,
    `{"verdict":"pass","reason":"<one sentence>"}`,
    ``,
    `--- INPUT THE OUTPUT WAS WRITTEN FROM ---`,
    JSON.stringify(input, null, 1),
    ``,
    ...(hideVerdict ? [] : [`--- TOM'S VERDICT ---`, verdict, ``]),
    ...(hideVerdict || rubric !== null || verdict !== "revise"
      ? []
      : [`--- TOM'S SENTENCE ---`, item.sentence ?? "", ``]),
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
 * An unreadable judge answer is MARKED, not merely worded.
 *
 * runItem asks the judge a second time when it sees this flag, and "did the
 * reason happen to start with these words" is not a thing to branch on. The
 * flag never reaches a row: aggregate's failure list names the fields it
 * carries, and this is not one of them.
 */
export const JUDGE_UNREADABLE = "judge answer unreadable";

function judgeUnreadable(answer) {
  return {
    ...runnerFailure(`${JUDGE_UNREADABLE}: ${String(answer ?? "").slice(0, 120)}`),
    judgeUnreadable: true,
  };
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
    return judgeUnreadable(answer);
  }
  const verdict = parsed?.verdict;
  const reason = parsed?.reason;
  if ((verdict !== "pass" && verdict !== "fail") || typeof reason !== "string" || reason.trim() === "") {
    return judgeUnreadable(answer);
  }
  // Judge output is untrusted text which reaches the persisted failure record
  // and CI report. Keep its diagnostic content, but never its credentials.
  return { judged: verdict, reason: redactSecrets(reason.trim()) };
}

/** A model/transport failure is not a negative measurement. Redact it before it
 * can become an item reason, aggregate error, persisted row, or log line. */
export function runnerFailure(error) {
  const message = redactSecrets(String(error ?? "runner failed")).slice(0, 300);
  return { judged: "fail", errored: true, errorMessage: message, reason: `runner failed: ${message}` };
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
 * WHICH FIELDS THE WRITING STANDARD BINDS, and it is not all of them, and it
 * is not the same rules for each.
 *
 * scripts/check-writing-standard.mjs exports two rule sets. `RULES` are rules
 * of the HTML-DOCUMENT FORM — no-doctype, no-close-html, no-h1, no-style —
 * which the writing standard attaches to a GROUND-UP EXPLANATION and to
 * nothing else. `BRIEF_RULES` are the four mechanical demands the prepare
 * prompt makes of the LIFE TODO'S BRIEF.
 *
 * The rules are not applied field-blind, for two separate reasons.
 *
 * FIRST, `RULES` over a free-form field would fail every case on no-doctype —
 * a `run` case's `text` is not an HTML document and the standard fixes no form
 * for it — so no rules run on it at all. A field the standard says nothing
 * about is checked against nothing, which is what makes this check safe to run
 * on every job.
 *
 * SECOND, only TWO of the four BRIEF_RULES bind the three brief-shaped fields
 * below. brief-sentences (2 to 5) and brief-length (at most 400 characters)
 * are demands on the SIZE of the life todo's brief, and nothing else here is
 * that field: a `recommendation` is one word, a `workDescription` is a few,
 * and the code-brief job's `brief` is 250 to 400 WORDS. Handing those three
 * the size rules fails every affected golden item DETERMINISTICALLY — the
 * check below runs before the judge — so `regressions` on the evals-run row
 * never returns to zero and the merge gate's evals arm denies every merge.
 * The split's one home is BRIEF_SIZE_RULE_IDS / briefFormRules() over there,
 * and this file selects from it rather than restating it.
 *
 * WHICH `brief` IS WHICH IS THE JOB'S ANSWER, NOT THE FIELD NAME'S. Two jobs
 * write a field called `brief` and they are different fields, so the job says
 * which of its brief fields the size rules bind (`briefSizeFields` in JOBS
 * above) and this function reads that. `job` defaults to nothing size-bound:
 * a two-argument call — an older caller, a test — gets the form rules, which
 * is the answer for every brief field but the prepare job's.
 *
 * A rule added to BRIEF_RULES over there lands here with no edit, in the form
 * set unless it is also named in BRIEF_SIZE_RULE_IDS.
 */
export const HTML_STANDARD_FIELDS = Object.freeze(["groundUpExplanation", "explanation"]);
export const BRIEF_STANDARD_FIELDS = Object.freeze(["brief", "recommendation", "workDescription"]);

export function standardRulesFor(field, standard, job = null) {
  if (standard === null || standard === undefined) return null;
  if (HTML_STANDARD_FIELDS.includes(field)) return standard.RULES ?? null;
  if (!BRIEF_STANDARD_FIELDS.includes(field)) return null;
  if ((job?.briefSizeFields ?? []).includes(field)) return standard.BRIEF_RULES ?? null;
  // A standard module too old to export briefFormRules checks nothing here,
  // the same answer an absent module gives — never the full set by fallback,
  // which is the failure this whole comment is about.
  return standard.briefFormRules?.() ?? null;
}

/**
 * The writing standard's rule bodies, loaded the way loadGate loads the gate.
 *
 * THE FILE HAS THREE HOMES — /opt/tts/scripts/ below the flat jobs, scripts/
 * in a checkout, and CI — so both paths are tried. An absent file is "no rules ran", never a failure: a box whose
 * setup.sh has not copied it yet must not start failing every case on a check
 * it cannot perform.
 */
export async function loadWritingStandard() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.join(here, "scripts", "check-writing-standard.mjs"),
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
    const rules = standardRulesFor(field, standard, job);
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
        skillsRefused: layers.skillsRefused ?? [],
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
    // Same posture, same reason: the prompt could not be assembled, so nothing
    // was spent and nothing about the tree was measured.
    if (err instanceof ReplayUnavailableError) {
      return { ...base, judged: "skip", reason: err.message, unreplayable: true };
    }
    return { ...base, ...runnerFailure(serverErrorMessage(err)) };
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
      return { ...base, ...runnerFailure(serverErrorMessage(err)) };
    }
  }
  // ONE RETRY, AND ONLY FOR AN ANSWER THAT COULD NOT BE READ.
  //
  // The judge writes a JSON object with the reason inside it, and the rule
  // above asks it for three or four words of the output — which it kept
  // supplying in quotation marks, unescaped, so the object would not parse and
  // the item scored `judge answer unreadable`. The prompt now forbids the
  // quotes; this is the second half, because a prompt rule is a tendency and
  // not a guarantee, and one malformed string should not fail an item whose
  // regeneration was fine.
  //
  // WHY THE PROMPT RULE IS NOT ENOUGH ON ITS OWN, and why the parser is not
  // the place instead. A prompt rule moves a model's tendency and does not
  // bound it, and the cost of the residue is not a worse reason but a FAILED
  // ITEM — a regression on the merge gate, from an item whose regeneration was
  // fine. A parser taught to tolerate quotes is the other way out and a worse
  // one: it would have to guess where the JSON string ends, and a judge that
  // wrote a reason with a comma and a brace in it would be guessed wrong
  // silently, which turns an unreadable answer into a WRONG one. Deleting this
  // means choosing between those two. The second ask costs one Fable call on
  // the rare item that needs it.
  //
  // IT IS NOT A RETRY OF A VERDICT. A judge that answers `fail` readably is
  // asked once and its answer stands — retrying until the wanted answer
  // arrives is exactly how a measurement becomes a wish. Only unreadability is
  // retried, and only once; a second failure is a failed item with the
  // answer's head in the reason, as before.
  let verdict;
  let judgeRetries = 0;
  for (;;) {
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
      return { ...base, ...runnerFailure(serverErrorMessage(err)), judgeRetries };
    }
    verdict = parseJudge(answer);
    if (verdict.judgeUnreadable !== true || judgeRetries >= JUDGE_RETRIES) break;
    judgeRetries += 1;
  }
  return { ...base, ...verdict, judgeRetries };
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
  let errored = 0;
  // How often the judge had to be asked twice because its first answer was not
  // readable JSON. A DIAGNOSTIC, never a gate: the merge arm reads regressions.
  // A number climbing here says the judge prompt is drifting back towards
  // quoting, which is a thing to fix in the prompt and not in the parser.
  let judgeRetries = 0;
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
    if (result.errored === true) errored += 1;
    if (Number.isInteger(result.judgeRetries)) judgeRetries += result.judgeRetries;
  }
  return {
    items: results.length,
    pass,
    fail: results.length - pass,
    // Passed once, failed once. NEVER a regression and never folded into the
    // fail count: it is the noise in the measurement, said out loud.
    flaky,
    errored,
    judgeRetries,
    byPartition: [...byPartition.values()].sort((a, b) => a.partition.localeCompare(b.partition)),
    byVerdict,
    failures: results
      .filter((result) => result.judged !== "pass")
      .map(({ id, partition, verdict, reason, confirmed, trials, errored, method }) => ({
        id, partition, verdict, reason, confirmed,
        ...(errored === true ? { errored: true } : {}),
        ...(method === undefined ? {} : { method }),
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

/** The area-trigger files live in WikiTom because their cases may only be
 * stored with the private area pages they exercise. Intent and week remain
 * public trigger files: neither is an area page. */
export const AREA_TRIGGER_FILES = Object.freeze([
  "skill-know-admin.json",
  "skill-know-agent-systems.json",
  "skill-know-climbing.json",
  "skill-know-health-and-food.json",
  "skill-know-mental-health.json",
  "skill-know-money.json",
  "skill-know-research.json",
  "skill-know-social.json",
]);

/**
 * The eight area pages the know layer requires, and therefore the eight
 * `know-<area>` skills the layer became.
 *
 * A FROZEN LIST, not a read of the WikiTom tree, and not an import. loadTriggers
 * is handed a tom.quest tree and no WikiTom tree at all, so there is nothing
 * here to derive an area list from; and shared/skills.mjs — which holds the
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
 * that maps them. The layer triggers deliberately exercise a whole layer;
 * replacing one with a single skill trigger would no longer test its complete
 * grant set. The deployed worker cannot import shared/skills.mjs because
 * setup installs those files at different relative paths, so this checked and
 * tested mapping remains the one compatible representation. `operate` maps to
 * nothing because the base is not a skill: it is the one file every prompt
 * carries whoever the run writes for, and there is nothing to grant or withhold.
 */
export const LAYER_SKILL_ALIASES = Object.freeze({
  operate: Object.freeze([]),
  write: Object.freeze(["write"]),
  know: Object.freeze(["know-intent", "know-week", ...KNOW_AREAS.map((area) => `know-${area}`)]),
});

/**
 * The mapping, REQUIRED and never defaulted. The identity default this replaces
 * was the one path on which a trigger's skill name was spelled without
 * shared/skills.mjs: a caller that forgot `repoSkillName` scored
 * `repo-tom.quest`, a name no publisher can produce, and the miss looked like a
 * clean run. There is nothing here to fall back TO — a name spelled by anything
 * but the central function is wrong — so the absent mapping is an error.
 */
function skillNameMapping({ bareSkillName, repoSkillName } = {}) {
  if (typeof bareSkillName !== "function" || typeof repoSkillName !== "function") {
    throw new Error("trigger skill names need the shared/skills.mjs mapping (bareSkillName and repoSkillName)");
  }
  return { bareSkillName, repoSkillName };
}

/** The skill names one loaded trigger is about: a `skill` file names its own,
 *  and a `layer` file names the skills that layer became. */
export function triggerSkills(trigger, mapping = {}) {
  if (trigger?.kind === "skill") {
    if (typeof trigger.name !== "string" || trigger.name === "") throw new Error("skill trigger needs a name");
    const { bareSkillName, repoSkillName } = skillNameMapping(mapping);
    // Repository labels keep their punctuation and capitalization for humans;
    // their published skill name comes only from the central mapping. THE
    // FILE'S OWN `name` MUST BE THAT NAME: a fixture holding a second spelling
    // of the repository is the defect this round found, and tolerating it in
    // the file while silently scoring the mapped name leaves the wrong name
    // readable, quotable, and free to spread into ids and expectations.
    if (typeof trigger.repo === "string" && trigger.repo !== "") {
      const published = repoSkillName(trigger.repo);
      if (trigger.name !== published) {
        throw new Error(`skill trigger for ${trigger.repo} is named ${trigger.name}; the published skill is ${published}`);
      }
      return [published];
    }
    const bare = bareSkillName(trigger.name);
    if (trigger.name !== bare) {
      throw new Error(`skill trigger is named ${trigger.name}; the published skill is ${bare}`);
    }
    return [bare];
  }
  if (trigger?.kind === "layer") {
    const skills = LAYER_SKILL_ALIASES[trigger.name];
    if (skills === undefined) throw new Error(`unknown layer trigger ${String(trigger.name)}`);
    const { bareSkillName } = skillNameMapping(mapping);
    return skills.map((name) => bareSkillName(name));
  }
  throw new Error(`unknown trigger kind ${String(trigger?.kind)}`);
}

export function loadTriggers(tomquestTree, { wikitomDir = BOX_WIKITOM_DIR, bareSkillName, repoSkillName } = {}) {
  const publicDir = path.join(tomquestTree, TRIGGERS_DIR);
  const privateDir = path.join(wikitomDir, TRIGGERS_DIR);
  const files = [
    ...(fs.existsSync(publicDir)
      ? fs.readdirSync(publicDir)
        .filter((name) => name.endsWith(".json") && !name.endsWith(".draft.json") && !AREA_TRIGGER_FILES.includes(name))
        .map((name) => ({ dir: publicDir, name }))
      : []),
    ...AREA_TRIGGER_FILES.map((name) => ({ dir: privateDir, name })),
  ];
  return files
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ dir, name }) => {
      const trigger = { file: name, ...JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) };
      // A checked-in trigger is executable input. Validate its dispatch shape
      // while the source filename is still known, including the private area
      // fixtures that this checkout cannot repair.
      if (Array.isArray(trigger.cases)) {
        for (const one of trigger.cases) {
          const id = typeof one?.id === "string" && one.id.trim() !== "" ? one.id : "<missing id>";
          try {
            triggerBase(trigger, one);
            triggerMethod(one);
          } catch (error) {
            throw new Error(`trigger case ${id} in ${name}: ${error.message}`);
          }
        }
      }
      // NORMALISED ON THE WAY OUT, never written into the file. A trigger file
      // is Tom-facing text about one name, and a list of skill names copied
      // into it would be a second copy of LAYER_SKILL_ALIASES that goes stale
      // the day an area page is added.
      try {
        return { ...trigger, skills: triggerSkills(trigger, { bareSkillName, repoSkillName }) };
      } catch (error) {
        throw new Error(`trigger ${name}: ${error.message}`);
      }
    });
}

/** How many positives and negatives one current-format trigger file carries. */
export function triggerCounts(trigger) {
  if (!Array.isArray(trigger?.cases)) throw new Error("trigger needs a cases list");
  const negatives = trigger.cases.filter((one) => one?.negative === true).length;
  return { positives: trigger.cases.length - negatives, negatives };
}

/** The executable trigger filenames changed by a pull request. Drafts and
 * malformed paths cannot claim coverage because the runner never loads them. */
export function changedTriggerFiles(changed) {
  if (!Array.isArray(changed)) return new Set();
  return new Set(changed
    .filter((path) => typeof path === "string")
    .map((path) => path.replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((path) => path.startsWith(`${TRIGGERS_DIR}/`) && path.endsWith(".json") && !path.endsWith(".draft.json"))
    .map((path) => path.slice(`${TRIGGERS_DIR}/`.length)));
}

/**
 * The two trigger case methods. A `route` case is a complete, generic input to
 * routeSkills: `caller`, `subject`, optional `record`/`cwd`/`repoDirs`, and an
 * `expected` router result. It contains no prose for a model to interpret, so
 * it is scored once without a runner. A case with a prompt is an output-
 * behaviour check and therefore needs the runner once. A malformed checked-in
 * case is an authoring error, not a measurement to silently skip.
 */
export const TRIGGER_METHOD_ROUTER = "router";
export const TRIGGER_METHOD_RUNNER = "runner";

export function triggerMethod(one) {
  const hasRoute = one !== null && typeof one === "object" && Object.hasOwn(one, "route");
  const hasPrompt = one !== null && typeof one === "object" && Object.hasOwn(one, "prompt");
  if (hasRoute && hasPrompt) throw new Error("trigger case cannot carry both route and prompt");
  // A router case is scored by exact comparison against `route.expected`;
  // scoreTriggerRoute never reads `expect`. One checked in anyway held two
  // spellings of a skill name that no publisher produces, and read as a
  // passing assertion because a mustNotName nobody can name is vacuously true.
  // The expectation has one home, so the second one is refused rather than
  // ignored.
  if (hasRoute && Object.hasOwn(one, "expect")) {
    throw new Error("router case scores route.expected; it cannot also carry expect");
  }
  if (hasRoute) return TRIGGER_METHOD_ROUTER;
  if (hasPrompt && typeof one.prompt === "string" && one.prompt.trim() !== "") return TRIGGER_METHOD_RUNNER;
  throw new Error("trigger case needs route or prompt");
}

export function triggerBase(trigger, one) {
  if (typeof one?.id !== "string" || one.id.trim() === "") {
    throw new Error("trigger case needs a non-empty id");
  }
  // A case id names the skill it is about, and `<kind>-<name>-` is how every
  // trigger file already spells it. Anchoring it here is what keeps a skill
  // name from acquiring a second spelling in the one field nothing validates:
  // the two repo files carried `skill-repo-tom.quest-…` ids for a skill
  // published as `repo-tom-quest`.
  if (typeof trigger?.kind === "string" && typeof trigger?.name === "string" && trigger.name !== "") {
    const prefix = `${trigger.kind}-${trigger.name}-`;
    if (!one.id.startsWith(prefix)) throw new Error(`trigger case id ${one.id} does not start with ${prefix}`);
  }
  return {
    id: one.id,
    partition: `trigger/${trigger?.name ?? "unknown"}`,
    verdict: "approve",
    confirmed: one?.confirmedByTom === true,
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Score one schema-described router case. It deliberately has no fallback to
 * a model: a partial route description is a broken fixture, not a question a
 * model is permitted to answer. */
export function scoreTriggerRoute(trigger, one, router) {
  const base = triggerBase(trigger, one);
  if (one?.route === null || typeof one?.route !== "object" || Array.isArray(one.route)) {
    return { ...base, method: TRIGGER_METHOD_ROUTER, judged: "fail", reason: "router case needs a route object" };
  }
  const expected = one.route.expected;
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    return { ...base, method: TRIGGER_METHOD_ROUTER, judged: "fail", reason: "router case needs an expected result" };
  }
  try {
    const actual = router({
      caller: one.route.caller,
      subject: one.route.subject,
      record: one.route.record,
      cwd: one.route.cwd,
      repoDirs: one.route.repoDirs,
      pages: one.route.pages,
      published: one.route.published,
    });
    const projected = {
      granted: actual.granted,
      refused: actual.refused,
      repoRulesSource: actual.repoRulesSource,
    };
    return sameJson(projected, expected)
      ? { ...base, method: TRIGGER_METHOD_ROUTER, judged: "pass", trials: { head: 1, headPassed: 1 } }
      : { ...base, method: TRIGGER_METHOD_ROUTER, judged: "fail", reason: "router result differs from the case expectation", trials: { head: 1, headPassed: 0 } };
  } catch (error) {
    return { ...base, method: TRIGGER_METHOD_ROUTER, judged: "fail", reason: `router failed: ${serverErrorMessage(error)}`, trials: { head: 1, headPassed: 0 } };
  }
}

/** One model-required trigger case. Its checked-in mechanical expectation is
 * the verdict, so there is no second judge call after the one runner call. */
export async function runTriggerCase(trigger, one, io, router = null, publication = null) {
  const method = triggerMethod(one);
  if (method === TRIGGER_METHOD_ROUTER) return scoreTriggerRoute(trigger, one, router);
  const base = triggerBase(trigger, one);
  const pinReason = publication?.reason ?? (
    publication === null ||
    typeof publication.text !== "string" ||
    typeof publication.expectedCommit !== "string" ||
    publication.commit !== publication.expectedCommit ||
    !/^[0-9a-f]{64}$/.test(publication.catalogHash ?? "")
      ? "the trigger publication could not be pinned to the named WikiTom commit"
      : null
  );
  // REMOVAL CHECK: cannot remove; an unpinned runner result can be stamped with a WikiTom commit whose skill bytes it never saw.
  if (pinReason !== null) return { ...base, method, judged: "skip", reason: pinReason };
  try {
    const answer = await io.runClaude([publication.text, one.prompt].filter((part) => part !== "").join("\n\n"), {
      model: REGEN_MODEL,
      timeoutMs: REGEN_TIMEOUT_MS,
      maxTurns: JOBS.run.opts.maxTurns,
      registration: {
        origin: "cron:evals",
        kind: "job",
        layersKnown: true,
        layersGiven: [],
        layersDenied: [],
        skillsGranted: publication.skills ?? [],
        skillsRefused: publication.skillsRefused ?? [],
        wikitomCommit: publication.commit,
      },
    });
    const reason = mechanicalChecks(one.expect, answer);
    return reason === null
      ? { ...base, method, judged: "pass", trials: { head: 1, headPassed: 1 } }
      : { ...base, method, judged: "fail", reason, trials: { head: 1, headPassed: 0 } };
  } catch (error) {
    return { ...base, method, judged: "fail", reason: `trigger runner failed: ${serverErrorMessage(error)}`, trials: { head: 1, headPassed: 0 } };
  }
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
  let produced;
  try {
    produced = await io.runTaskKind(task, trees);
  } catch (error) {
    return { ...base, ...runnerFailure(serverErrorMessage(error)) };
  }
  // Task runners are separate wiring seams. Their output cannot be trusted to
  // have this shape: deleting the guard would let a broken runner become a
  // persisted measurement with no verdict instead of an explicit failed item.
  if (produced === null || typeof produced !== "object" || (produced.judged !== "pass" && produced.judged !== "fail" && produced.judged !== "skip")) {
    return { ...base, ...runnerFailure("task runner returned no usable answer") };
  }
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
 * The code repositories an evals request may name, each with the GitHub home
 * and the default branch its cache clone follows. The box cannot import
 * convex/ttsShared.ts and no payload this job reads carries SESSION_REPOS, so
 * the three are spelled here. A repository missing from this map used to get a
 * tom.quest tree without a word; it now gets an error, which the request's
 * failed row reports.
 */
export const EVALS_CODE_REPOS = Object.freeze({
  "tom.quest": Object.freeze({ owner: "Heffnt", name: "tom.quest", branch: "main" }),
  ComplexMultiTrigger: Object.freeze({ owner: "Heffnt", name: "ComplexMultiTrigger", branch: "master" }),
  // The box's own code. Its pull requests are checked by a box job, which
  // posts the evals request itself, since the repository runs no GitHub Actions.
  Jarvis: Object.freeze({ owner: "Heffnt", name: "Jarvis", branch: "main" }),
});

/**
 * The directory a worktree of `repo` is cut from. WikiTom is the nightly job's
 * own checkout, never a cache clone. Every code repository is its cache clone.
 */
export function evalsRepoDir(env, repo, { cache = cacheRepoDir, wikitomDir = process.env.WIKITOM_DIR } = {}) {
  if (repo === "WikiTom") return wikitomDir || "/root/wikitom";
  const spec = EVALS_CODE_REPOS[repo];
  if (!spec) throw new Error(`${repo} is not a repository evals can check out`);
  return cache(env, spec);
}

/**
 * A detached worktree of `ref` on a cache clone, and a function that removes
 * it. A worktree is exactly the tool for reading another commit without
 * touching a checkout somebody else owns — the nightly job owns /root/wikitom's
 * working tree, and this must never reset --hard it.
 */
export function worktreeFor(repoDir, repo, ref, { pid = process.pid } = {}) {
  // THE PATH CARRIES THE PROCESS THAT MADE IT, and the rmSync on the next line
  // is why it has to. This built its name out of the repo and the ref alone,
  // so a run started by hand and the five-minute `--serve` cron, asked about
  // the same head, computed the same directory — and each one began by
  // deleting the other's checkout. The head worktree disappeared under a
  // regeneration, the run died somewhere unrelated to the cause, and the row
  // it posted said the tree could not be read (twice, 2026-09-14).
  //
  // The lock in main() is the real answer: two runs do not start. This is what
  // makes the two-runs case merely wasteful rather than corrupting, for the
  // paths around the lock — a run under a different lock file, a debug run —
  // and it is what lets pruneStaleWorktrees tell a dead run's debris from a
  // live run's tree (worker/jobs/evals-lock.mjs).
  const slug = `${ref}`.replace(/[^A-Za-z0-9]/g, "-").slice(0, 24);
  const dir = path.join(WORK_DIR, repo, `${slug}.${pid}`);
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
  if (run === null || run === undefined || scoredNothing(run)) return new Set();
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
  // A runner failure is terminal evidence for this item. Retrying a failed
  // transport until it happens to work would turn an outage into a pass.
  if (first.errored === true) return { ...first, trials: { head: 1, headPassed: 0 } };
  if (first.judged === "pass" || !basePassed.has(id)) {
    return { ...first, trials: { head: 1, headPassed: first.judged === "pass" ? 1 : 0 } };
  }
  const results = [first];
  while (results.length < HEAD_TRIALS) {
    const next = await once();
    results.push(next);
    if (next.errored === true) {
      return { ...next, trials: { head: results.length, headPassed: results.filter((result) => result.judged === "pass").length } };
    }
    if (next.judged === "pass") break;
  }
  const passing = results.find((result) => result.judged === "pass");
  return {
    ...(passing ?? first),
    // A retry that passed is a flaky case, and the first trial is the one that
    // failed: its reason is the one worth keeping (the row's result entry).
    ...(passing ? { failedReason: first.reason } : {}),
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
    if (result.errored === true) {
      return {
        ...base,
        ...result,
        trialCount: perTrial.length,
        passed: 0,
        passK: false,
        passAtK: false,
        trials: { head: perTrial.length, headPassed: 0 },
        tokensMedian: medianTokens(perTrial),
        perTrial,
      };
    }
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

// THERE IS NO NODE ARM, and the reason is that there is no assembler that can
// drop a node. `preludeFrom` reads `names.layers` and `names.skills` and
// nothing else, so a trial that removed a node id from the set it is handed
// would assemble the IDENTICAL prompt and score the same prompt twice. On a
// sampling model those two runs differ by noise, `ablationFindings` reads a
// differing pair as `earned: false`, and worker/jobs/weekly.mjs posts every
// such row to /tts/weekly-decisions as a removal proposal that stands unless
// somebody objects — a rule line flagged for deletion by a measurement that
// never deleted it, at a cost of about a thousand trials a week.
//
// So the arm is not here rather than gated off: a flag would be a second thing
// to get wrong, and the selection rule it guarded (the five lowest-cost nodes
// of a walk, ties by id) is one small function to write again. It comes back in
// THE SAME COMMIT as the assembler that drops a node, because neither half
// means anything without the other. `graphVersion` and `graphNodes` on the run
// row, the walk, `tts search node` and `near` are untouched: those record and
// read what a prompt carried, which is true whether or not anything ablates it.

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
 * TWO LISTS, NOT THREE: a layer and a skill, each of which `preludeFrom`
 * actually assembles. A node would be the third and is not here — see the
 * block above this one for why an arm nothing can assemble without is worse
 * than no arm.
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
  const rows = [];
  const skipped = [];
  for (const [kind, list] of [["layer", names.layers ?? []], ["skill", names.skills ?? []]]) {
    for (const name of list) {
      const without = {
        ...item,
        input: {
          ...item.input,
          // preludeNames IS THE WHOLE OF WHAT THE ASSEMBLER IS HANDED —
          // JOBS.run.build calls context.prelude(item.input.preludeNames) and
          // reads nothing else — so a name removed anywhere but here would
          // assemble the identical prompt and score the same run twice.
          preludeNames: {
            layers: (names.layers ?? []).filter((one) => kind !== "layer" || one !== name),
            skills: (names.skills ?? []).filter((one) => kind !== "skill" || one !== name),
          },
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
    // KEYED ON THE KIND AND THE NAME TOGETHER, AND THE KIND DOES NOT TRAVEL.
    // A layer and a skill can carry one name — `write` was a layer and is now a
    // skill — and one key would add the two counts together and report a
    // finding about neither, so the kind belongs in the key. It does NOT belong
    // on the finding: the twin of this function in convex/ttsWeekly.ts feeds
    // POST /tts/weekly-decisions, whose argument check is an exact object, and
    // Convex refuses a field that check does not list. The two copies emit the
    // same shape so that neither can teach the other a field the route rejects.
    const key = `${String(row.kind ?? "")}|${row.name}`;
    const entry = byName.get(key) ?? { name: row.name, cases: 0, withPass: 0, withoutPass: 0 };
    entry.cases += 1;
    if (row.withPass) entry.withPass += 1;
    if (row.withoutPass) entry.withoutPass += 1;
    byName.set(key, entry);
  }
  return [...byName.values()]
    .filter((entry) => entry.cases >= MIN_ABLATION_CASES)
    .map((entry) => ({ ...entry, earned: entry.withoutPass / entry.cases < entry.withPass / entry.cases }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── The verifiers, measured ──────────────────────────────────────────────────
//
// THERE ARE EXACTLY THREE VERIFIERS: the checks (tests-run), the audit
// (audit-verdict) and the evals (evals-run). Tom's own label is the ground
// truth above all three. Everything in this section MEASURES those verifiers
// and GATES NOTHING — no merge arm reads it, no CI job runs it, no door is
// touched. A judge that gated on its own unmeasured agreement is exactly the
// failure the audit declines to lint for, and a measurement that grew into a
// gate would be that failure with an extra step.
//
// Two measures live here. The third (§6.2, the audit against Tom's later
// objections) is computed in Convex off the event record and is deliberately
// NOT here: it needs rows this file never reads, and a second answer to one
// question is two things to keep true.

/** The standing caveat, carried as a FIELD on the scorecard and not only as a
 *  comment: the weekly facts block is read by a model and by Tom, and a number
 *  that travels without the sentence saying what it is not becomes a verdict
 *  the moment somebody quotes it. */
export const VERIFIER_CAVEAT =
  "These measures report and never gate: a judge's agreement with twenty of his " +
  "labels is evidence about the judge, not a verdict on any output it scored.";

/** How many of his labels the judge is replayed against. Twenty is a week's
 *  evidence about the judge and not a census of the corpus; the cost is twenty
 *  Fable calls, once a week. */
export const LABEL_SAMPLE = 20;

/** Every list on the scorecard is capped, and every string in one is cut.
 *  The scorecard rides a weekly evals-run row that a model reads whole, so an
 *  unbounded list of reasons is an unbounded prompt. */
export const SCORECARD_LIST_MAX = 20;
export const SCORECARD_STRING_MAX = 300;

const capString = (value) => String(value ?? "").slice(0, SCORECARD_STRING_MAX);

/** One entry of a capped list, every string in it cut to the same length. */
function capEntry(entry) {
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    out[key] = typeof value === "string" ? capString(value) : value;
  }
  return out;
}

const capList = (list) => list.slice(0, SCORECARD_LIST_MAX).map(capEntry);

/**
 * The text Tom judged, off the label's own span rows.
 *
 * Separate rows were separate turns, so they are joined with a blank line
 * rather than run together, which would fuse the end of one turn onto the start
 * of the next. This is the same join scripts/export-golden.mjs makes
 * (outputTextOf) — it is written twice rather than imported because that script
 * is a laptop-side exporter with its own dependencies and this file ships to
 * /opt/tts with none; the rule it spells is one line and is stated in both.
 *
 * An empty string means the text CANNOT BE RECOVERED, which is a skip and never
 * a silent drop. NO SECOND DOOR IS ADDED to fetch it: GET /tts/label-input
 * already carries the rows, and a run whose rows fell out of the thirty-day
 * window is not recoverable from anywhere the box can reach.
 */
export function labelOutputText(label) {
  return (label?.rows?.spanRows ?? [])
    .map((row) => row?.content?.text)
    .filter((text) => typeof text === "string" && text.trim() !== "")
    .join("\n\n");
}

/** His polarity as the two words this file's judge answers in. */
const JUDGE_FOR_POLARITY = { good: "pass", bad: "fail" };

/**
 * One label as an item judgePrompt takes.
 *
 * THREE CHOICES HERE, AND EACH ONE IS ABOUT NOT HANDING THE JUDGE THE ANSWER.
 *
 *  - `verdict` is ALWAYS "approve", never derived from his polarity. verdictOf
 *    picks which mode block the prompt carries, and a block picked from his
 *    label would put his answer into the question — the measurement would then
 *    be of the prompt's leak and not of the judge.
 *  - No `sentence` and no `expected.rubric`. His meaning IS his answer, and
 *    both of those blocks would print it verbatim. (Dropping the rubric is why
 *    hideVerdict only has two sections to drop: with no rubric and no sentence
 *    set, TOM'S SENTENCE is already absent and TOM'S VERDICT is the one thing
 *    left to hide.)
 *  - `output` is EMPTY. This is a replay of his judgement over ONE text, not a
 *    regeneration of it: there is no older output the text could have dropped a
 *    fact from, and pasting the same text into both halves would make every
 *    answer trivially "pass".
 *
 * WHAT THIS COSTS, said out loud: with an empty OLD output the approve block's
 * question collapses to "does this text assert anything its input does not
 * support", which is a weaker question than the one Tom answered, and it leans
 * towards "pass". The agreement number is therefore evidence about the judge
 * and not a score — VERIFIER_CAVEAT, which rides the row.
 */
export function replayItem(label) {
  return {
    id: String(label?.labelId ?? ""),
    job: "run",
    partition: `labels/${label?.source ?? "unknown"}`,
    kind: "regression",
    verdict: "approve",
    confirmedByTom: true,
    input: {
      runId: label?.run?.runId ?? null,
      origin: label?.run?.origin ?? null,
      kind: label?.run?.kind ?? null,
      model: label?.run?.model ?? null,
    },
    output: {},
  };
}

/**
 * §6.1 — the evals judge replayed against Tom's own labels.
 *
 * The newest LABEL_SAMPLE judgment labels whose polarity points one way or the
 * other are replayed through the SAME judge prompt the evals use, with his
 * verdict hidden, and the judge's pass/fail is counted against his good/bad.
 *
 * NEWEST-FIRST RATHER THAN RANDOM, for the reason convex/ttsSimplify.ts gives
 * for its own sample: the same week measured twice must give the same answer,
 * and a sample that moves turns every re-run into a diff nobody can read.
 *
 * SKIPS ARE COUNTED, NEVER SILENT, and the split is stated once here: `items`
 * is the number of labels ACTUALLY JUDGED, and `skipped` is the number that
 * could not be — a skip is not in `items` and not in `agreed`, so `agreed` out
 * of `items` is a rate over what was measured rather than a rate quietly
 * diluted by what was not.
 */
export async function judgeAgreement(io, { limit = LABEL_SAMPLE } = {}) {
  const empty = { items: 0, agreed: 0, skipped: 0, disagreements: [], skips: [] };
  if (typeof io?.labels !== "function") return empty;
  let answer;
  try {
    answer = await io.labels(limit);
  } catch (error) {
    // A door that cannot be read measures nothing. It is not a failure of the
    // judge and must not be reported as a disagreement.
    return { ...empty, skips: [{ runId: null, reason: capString(`the label door could not be read: ${serverErrorMessage(error)}`) }] };
  }
  // The door already returns only `judgment: true` rows (convex/ttsEvals.ts
  // internalLabelInput filters on it), so the filter below is the same rule
  // said again where it is read rather than a second rule: a row that ever
  // arrives carrying `judgment: false` is not a judgment and is not replayed.
  const labels = (answer?.items ?? [])
    .filter((label) => label?.judgment !== false)
    .filter((label) => JUDGE_FOR_POLARITY[label?.polarity] !== undefined)
    .sort((a, b) => (b?.at ?? 0) - (a?.at ?? 0) || String(a?.labelId).localeCompare(String(b?.labelId)))
    .slice(0, limit);
  const disagreements = [];
  const skips = [];
  let items = 0;
  let agreed = 0;
  for (const label of labels) {
    const runId = label?.run?.runId ?? null;
    if (label?.run === null || label?.run === undefined) {
      skips.push({ runId, reason: "the label named no run, or the run has left the thirty-day window" });
      continue;
    }
    const text = labelOutputText(label);
    if (text === "") {
      skips.push({ runId, reason: "the run recorded no text to judge" });
      continue;
    }
    let raw;
    try {
      raw = await io.runClaude(judgePrompt(replayItem(label), { text }, JOBS.run.fields, { hideVerdict: true }), {
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
    } catch (error) {
      skips.push({ runId, reason: `the judge could not be run: ${serverErrorMessage(error)}` });
      continue;
    }
    const verdict = parseJudge(raw);
    const tom = label.polarity;
    items += 1;
    if (JUDGE_FOR_POLARITY[tom] === verdict.judged) {
      agreed += 1;
      continue;
    }
    disagreements.push({ runId, tom, judge: verdict.judged, reason: verdict.reason });
  }
  return {
    items,
    agreed,
    skipped: skips.length,
    disagreements: capList(disagreements),
    skips: capList(skips),
  };
}

// ── §6.3 — the planted faults ────────────────────────────────────────────────

/** Where the fixtures live in a checkout. */
export const AUDIT_FAULTS_DIR = "evals/audit-faults";

/**
 * The fixture directory, found the way loadWritingStandard and loadGate find
 * their one file: THE TREE HAS MORE THAN ONE HOME. In a checkout the fixtures
 * are evals/audit-faults/; on the box this file lands in /opt/tts, where the
 * directory sits beside it if setup.sh copied it and does not if it has not.
 * An absent directory is ZERO FIXTURES and never a failure — a box whose setup
 * has not copied them yet must not start reporting a broken arm.
 *
 * TTS_AUDIT_FAULTS_DIR in the environment overrides both, so the box can be
 * pointed at a checkout without an edit here.
 */
export function auditFaultsRoot(env = {}) {
  const named = env?.TTS_AUDIT_FAULTS_DIR ?? process.env.TTS_AUDIT_FAULTS_DIR;
  if (typeof named === "string" && named !== "") return named;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.join(here, "audit-faults"),
    path.join(here, "..", "..", AUDIT_FAULTS_DIR),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(here, "..", "..", AUDIT_FAULTS_DIR);
}

/**
 * The planted-fault fixtures, id-ascending.
 *
 * A fixture is `# ` header lines and then a diff. Everything from the first
 * `diff --git ` line on is the diff proper and is fed to the auditor VERBATIM;
 * the headers are read here and never sent, so a header cannot tell the auditor
 * what it is supposed to find.
 *
 * `witness:` IS THE CONVENTION vqc/ledger.yaml's `no-witness-fault-harness`
 * entry asks for while no fault runner exists: each fault names the one-line
 * edit that makes the correct answer wrong, so a reader can check that the
 * fixture still plants what it claims to plant. This arm is the runner that
 * entry describes for ONE detector — the audit — and not for the vitest guards
 * the entry is about, so the entry stays open.
 */
export function loadAuditFaults(dir = undefined) {
  const root = dir ?? auditFaultsRoot();
  if (!fs.existsSync(root)) return [];
  const faults = [];
  for (const name of fs.readdirSync(root).sort()) {
    if (!name.endsWith(".diff")) continue;
    const file = path.join(root, name);
    if (!fs.statSync(file).isFile()) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const start = lines.findIndex((line) => line.startsWith("diff --git "));
    const headerLines = start === -1 ? lines : lines.slice(0, start);
    const headers = {};
    for (const line of headerLines) {
      if (!line.startsWith("# ")) continue;
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      headers[line.slice(2, colon).trim()] = line.slice(colon + 1).trim();
    }
    faults.push({
      id: headers.id ?? name.replace(/\.diff$/, ""),
      subject: headers.subject ?? "",
      witness: headers.witness ?? "",
      diff: start === -1 ? "" : lines.slice(start).join("\n"),
    });
  }
  return faults.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The audit's one machine-readable line, ANCHORED AND ALONE ON ITS LINE, so a
 * verdict quoted inside the prose ("do not write VERDICT: APPROVED unless…") is
 * not mistaken for the verdict.
 *
 * THE ANCHORED FORM'S ONE HOME IS convex/ttsMerge.ts auditVerdictOf, which is
 * what the merge gate actually reads; this is the same regex, spelled here
 * because worker/jobs/audit.mjs exports no verdict reader and a TypeScript
 * Convex module cannot be imported by a plain-ESM box job. If audit.mjs ever
 * exports one, this goes and the import takes its place.
 */
export function faultVerdictOf(text) {
  const hit = /^[ \t]*VERDICT:[ \t]*([A-Za-z][A-Za-z_-]*)[ \t]*$/im.exec(String(text ?? ""));
  return hit === null ? null : hit[1].toUpperCase();
}

/** The word the correct answer on every fixture is. */
export const FAULT_REFUSED = "REFUSED";

/** What the fixture auditor runs on. Opus, named explicitly like every other
 *  spawn in the fleet, with a wall clock and a turn budget of its own: the
 *  fixture diff is small, but a read-only auditor that runs out of turns is
 *  recorded as unavailable, which reads as a broken arm rather than a short
 *  budget (worker/jobs/audit.mjs learned this on its first fallback run). */
export const FAULT_AUDIT_MODEL = process.env.TTS_EVALS_FAULT_AUDIT_MODEL || MODELS.evalsFaultAudit;
export const FAULT_AUDIT_TIMEOUT_MS = 10 * 60 * 1000;
export const FAULT_AUDIT_MAX_TURNS = 8;

/**
 * MONTHLY, NOT WEEKLY. The fixtures cost three auditor runs and the question
 * they answer — does the auditor still refuse a change it must refuse — moves
 * on the timescale of the audit prompt changing, not on the timescale of a
 * week's merges. The month's run is the weekly run whose date falls in the
 * first seven days of the month, which is exactly the weekly Saturday that
 * opens a month, read on NEW YORK's calendar because that is the clock every
 * cron guard in this fleet keeps.
 *
 * `--force` and `--faults-only` run it whatever the date says, so the arm can
 * be exercised by hand; the pair then reads `ran: true, reason: "not this
 * month"`, which is the honest reading — it ran, and this was not its week.
 */
export function faultsMonthly(at, force = false) {
  const dayOfMonth = new Date(at + nyUtcOffsetHours(at) * 3_600_000).getUTCDate();
  const thisMonth = dayOfMonth <= 7;
  return { ran: thisMonth || force === true, reason: thisMonth ? "this month" : "not this month" };
}

/**
 * Each fixture, fed to the audit prompt UNCHANGED and scored by its verdict
 * word alone.
 *
 * A MISSED FAULT IS A FACT AND NOTHING ELSE. It opens no todo, files no
 * objection and fails no check: "the audit approved one planted fault this
 * month" is a thing Tom reads and decides about, and a job that turned it into
 * a todo would be deciding for him. AND THE FIXTURE IS NEVER TUNED UNTIL IT
 * REFUSES — an APPROVED verdict in a real run IS the finding, and editing the
 * diff until the auditor refuses it would turn the measurement into a mirror.
 */
export async function faultAudits(io, { at, force = false, dir = undefined } = {}) {
  const gate = faultsMonthly(at, force);
  if (!gate.ran) return { ran: false, reason: gate.reason, items: 0, refused: 0, results: [] };
  const faults = loadAuditFaults(dir);
  const results = [];
  for (const fault of faults) {
    let verdict;
    try {
      const answer = await io.audit(auditPrompt({
        repo: "tom.quest",
        sha: `audit-fault:${fault.id}`,
        base: null,
        subject: fault.subject,
        diff: fault.diff,
        truncated: false,
      }));
      // An auditor that answered with no verdict line and an auditor that could
      // not run are DIFFERENT FACTS, and neither is a refusal.
      verdict = faultVerdictOf(answer) ?? AUDIT_UNAVAILABLE;
    } catch {
      verdict = AUDIT_UNAVAILABLE;
    }
    results.push({ id: fault.id, verdict });
  }
  return {
    ran: true,
    reason: gate.reason,
    items: faults.length,
    refused: results.filter((result) => result.verdict === FAULT_REFUSED).length,
    results,
  };
}

/**
 * The whole scorecard, computed once a week and read off the weekly
 * `evals-run` row by convex/ttsWeekly.ts. REPORTS AND NEVER GATES.
 *
 * `env` is taken so the fixture directory can be named in the environment
 * (auditFaultsRoot); every side effect still goes through `io`, so the test
 * drives this with no model and no network.
 */
export async function verifierScorecard(io, env, { at, force = false } = {}) {
  return {
    at,
    caveat: VERIFIER_CAVEAT,
    judge: await judgeAgreement(io),
    faults: await faultAudits(io, { at, force, dir: auditFaultsRoot(env) }),
  };
}

// ── Cost: what a run does not have to do twice ───────────────────────────────

/**
 * How many items are in flight at once.
 *
 * FOUR, AND THE LIMIT IS THE BOX AND NOT THE MODEL. Each item is a CLI child
 * process with a checkout's worth of environment behind it; the box runs the
 * session daemon, the cron jobs and the cluster poller beside this. Four keeps
 * the pass under the load a single Codex session already puts on it, and the
 * measured pull-request runs — 70 to 84 calls in 20 to 31 minutes, one at a
 * time (2026-09-22) — become roughly a quarter of that wall clock.
 *
 * IT IS NOT A REASON TO ASK FOR MORE ITEMS. The whole point of the two
 * shortcuts below is that a run scores the items its diff can move; this is
 * what makes the ones it does score take less of an afternoon.
 */
export const ITEM_CONCURRENCY = (() => {
  const named = Number(process.env.TTS_EVALS_CONCURRENCY);
  return Number.isInteger(named) && named > 0 ? named : 4;
})();

/**
 * `worker` over every entry of `list`, at most `limit` at a time, answers in
 * the list's own order.
 *
 * THE ORDER IS THE POINT OF THE INDEX. A run's results, failures and scoredIds
 * are compared with another run's, and a set that comes back in completion
 * order would put a different sentence in `errors` and a different item first
 * in every list depending on which model call happened to return first. So each
 * answer is written to its own slot and nothing is pushed.
 */
export async function inPool(list, limit, worker) {
  const answers = new Array(list.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      answers[index] = await worker(list[index], index);
    }
  });
  await Promise.all(lanes);
  return answers;
}

/**
 * The base run's own result for one item, when the head does not have to score
 * it again — otherwise null.
 *
 * THREE CONDITIONS, AND EVERY ONE OF THEM IS NECESSARY.
 *
 * The item's BYTES must be identical on both sides. That is the same test the
 * gate compares on (scripts/evals-check.mjs mismatchOf), and without it a run
 * would carry over a measurement of a different item under the same id.
 *
 * The item's JOB must read nothing this diff touched. `affectedJobs` is the
 * base tree's answer, never the head's (trustedRequestDiff), because a head
 * that could narrow this list could carry its own base results over the change
 * it just made.
 *
 * And the base run must actually have SCORED it. A base that skipped an item,
 * or never selected it, has no result to carry and the head scores it.
 *
 * WHAT IT IS NOT. It is not a cache with a lifetime, a key or an eviction rule:
 * it is one row the head already fetched, read for the ids it may reuse. The
 * saving is the whole reason this is safe to do at all — an item whose bytes
 * and whose inputs are identical on both sides CANNOT have a different result
 * for any reason but the sampling, and paying a model call to re-roll the
 * sampling on the base side is exactly what HEAD_TRIALS exists to not do.
 */
export function carriedResultFor(item, carryOver, affectedJobs) {
  if (carryOver === null || carryOver === undefined || scoredNothing(carryOver)) return null;
  if (!Array.isArray(affectedJobs) || affectedJobs.includes(item.job)) return null;
  if (carryOver.scoredHashes?.[item.id] !== contentHash(item)) return null;
  const result = (carryOver.results ?? []).find((one) => one.id === item.id);
  if (result === undefined || (result.judged !== "pass" && result.judged !== "fail")) return null;
  return {
    ...baseOf(item),
    judged: result.judged,
    ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
    passK: result.passK === true,
    // ONE TRIAL, AND IT IS THE BASE'S. The head spent nothing; saying it tried
    // three times would make `calls` and the flaky count into fiction.
    trials: { head: 1, headPassed: result.judged === "pass" ? 1 : 0 },
    carried: true,
  };
}

/** The pinned skill-name mapping. Trigger files keep human repository labels,
 * while the evaluated catalog uses the one canonical bare spelling. */
async function triggerNameMappingFor(tomquestTree, io) {
  if (io.triggerNameMapping !== undefined) return io.triggerNameMapping;
  const skillsModule = await import(pathToFileURL(pinnedModule(tomquestTree, "skills.mjs", "scripts/skills.mjs")).href);
  return {
    bareSkillName: skillsModule.bareSkillName,
    repoSkillName: skillsModule.repoSkillName,
  };
}

/** The pinned router and the pinned area pages it reads. The router is imported
 * from the worktree being evaluated, not this box copy: a weekly result must
 * change when the router at either pinned commit changes. Tests may supply the
 * complete bound router to keep their trees intentionally small. */
async function triggerRouterFor(tomquestTree, wikitomTree, io) {
  if (typeof io.triggerRouter === "function") return io.triggerRouter;
  const routerModule = await import(pathToFileURL(pinnedModule(tomquestTree, "skill-router.mjs", "worker/jobs/skill-router.mjs")).href);
  const skillsModule = await import(pathToFileURL(pinnedModule(tomquestTree, "skills.mjs", "scripts/skills.mjs")).href);
  const areas = path.join(wikitomTree, skillsModule.AREAS_DIR);
  const pages = fs.existsSync(areas)
    ? fs.readdirSync(areas).filter((name) => name.endsWith(".md")).sort().map((name) => ({
      path: path.posix.join(skillsModule.AREAS_DIR, name),
      body: fs.readFileSync(path.join(areas, name), "utf8"),
    }))
    : [];
  const published = publicationFor(tomquestTree, wikitomTree).published;
  return (input) => routerModule.routeSkills({ ...input, pages: input.pages ?? pages, published: input.published ?? published });
}

/**
 * One run: the golden items of the pinned tom.quest tree, regenerated against
 * the pinned WikiTom tree, judged, aggregated, and posted as one evals-run row.
 * `io` carries every side effect so the test can drive this with no network
 * and no model.
 */
export async function runEvals({ repo, sha, limit = PR_ITEMS, jobs = null, weekly = false, ablation = false, basePassed = new Set(), changed = undefined, carryOver = null, affectedJobs = null }, io) {
  const startedAt = io.now();
  const trees = treesFor(repo, sha);
  const tomquest = io.worktree("tom.quest", trees.tomquest);
  const wikitom = io.worktree("WikiTom", trees.wikitom);
  try {
    const all = loadGolden(tomquest.dir);
    const wanted = jobs === null ? all : all.filter((item) => jobs.includes(item.job));
    // UNREPLAYABLE ITEMS ARE TAKEN OUT BEFORE THE SELECTION, NOT AFTER IT, and
    // that is the half of this that is not about cost. selectItems takes the
    // newest twenty approve and twenty revise, so twenty-seven mined
    // explanations filled the approve half and pushed the `run` case and both
    // `learning` items — the three scored WITHOUT a judge, and the only ones in
    // the set whose input the replay reproduces exactly — out of every
    // pull-request run. Fifteen of the twenty-seven cannot be replayed at all,
    // so a budget spent on them was a budget spent measuring nothing while the
    // items that measure something were not run.
    const replayable = wanted.filter((item) => unreplayableReason(item) === null);
    const unreplayableItems = wanted
      .filter((item) => unreplayableReason(item) !== null)
      .map((item) => ({ id: item.id, partition: item.partition, why: unreplayableReason(item) }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const items = weekly ? replayable : selectItems(replayable, Math.max(1, Math.floor(limit / 2)));
    // Weekly runs take the whole trigger set. A pull-request run takes every
    // case from exactly the trigger files it changed, so its coverage cannot
    // be satisfied by a case deferred to the weekly job.
    const changedTriggers = changedTriggerFiles(changed);
    const shouldLoadTriggers = weekly || changedTriggers.size > 0;
    const triggerNameMapping = shouldLoadTriggers ? await triggerNameMappingFor(tomquest.dir, io) : null;
    const triggers = shouldLoadTriggers
      ? loadTriggers(tomquest.dir, { wikitomDir: wikitom.dir, ...triggerNameMapping })
        .filter((trigger) => weekly || changedTriggers.has(trigger.file))
      : [];
    const triggerCases = triggers.flatMap((trigger) => (trigger.cases ?? []).map((one) => ({ trigger, one })));
    const router = triggerCases.some(({ one }) => triggerMethod(one) === TRIGGER_METHOD_ROUTER)
      ? await triggerRouterFor(tomquest.dir, wikitom.dir, io)
      : null;
    const modules = await io.loadModules(tomquest.dir, items);
    const layerCache = new Map();
    const preludeCache = new Map();
    const replayCache = new Map();
    const context = {
      cmtDir: io.cmtDir?.() ?? undefined,
      modules,
      // The session an explanation item was written from, read out of the
      // PINNED WikiTom tree — the same tree the layers come from, so an item is
      // replayed against the archive the run pins rather than whatever this
      // box's checkout holds today. Cached per item because a retried item
      // would otherwise gunzip a half-megabyte transcript again.
      replay: (item) => {
        if (!replayCache.has(item.id)) {
          const found = typeof io.replay === "function"
            ? io.replay(wikitom.dir, item)
            : { unreplayable: "the io in use wired no replay reader" };
          replayCache.set(item.id, found);
        }
        const found = replayCache.get(item.id);
        // A THROW RATHER THAN AN EMPTY BLOCK. Building the prompt without the
        // session would score the model on a gap in the harness and report the
        // difference as a regression; runItem turns this into a skip before any
        // call is paid for.
        if (found.unreplayable !== undefined) throw new ReplayUnavailableError(found.unreplayable);
        return found;
      },
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
        // The key is the two name lists, which are the whole of what
        // `preludeFrom` reads. A third part for a node list went with the node
        // arm: nothing sets `names.nodes`, so it contributed an empty string to
        // every key and named a caller that does not exist.
        const key = `${(names?.layers ?? []).join(",")}|${(names?.skills ?? []).join(",")}`;
        if (!preludeCache.has(key)) preludeCache.set(key, preludeFrom(io, tomquest.dir, wikitom.dir, names));
        return preludeCache.get(key);
      },
    };
    // CARRIED FIRST, AND WITHOUT A LANE. An item the base already answered
    // costs nothing and must not occupy one of the four; separating them here
    // also means the pool's size is the number of items actually being scored,
    // which is what the timing line reports.
    const carried = new Map();
    for (const item of items) {
      const reuse = carriedResultFor(item, carryOver, affectedJobs);
      if (reuse !== null) carried.set(item.id, reuse);
    }
    const toScore = items.filter((item) => !carried.has(item.id));
    // THE ABLATION ARM STAYS BEHIND ITS CASE. It is one trial per name on the
    // case that just ran, reported and never gated, so it rides inside that
    // case's lane rather than opening lanes of its own — and its rows come back
    // WITH that case rather than being pushed onto a shared list, so the order
    // of the arm is the order the names were removed in and not the order the
    // lanes happened to finish.
    const scoredResults = await inPool(toScore, ITEM_CONCURRENCY, async (item) => {
      // A `run` case is scored over its own trials with the deterministic
      // checks in front of the judge; every other item keeps the landed
      // retrial path exactly as it was. A weekly run is the full-trials run
      // and everything else is a pull-request run.
      if (item.job === "run") {
        const result = await runCase(item, context, io, { pr: !weekly });
        if (ablation && result.judged !== "skip") {
          const arm = await ablationFor(item, context, io, result.judged === "pass");
          return { result, arm };
        }
        return { result, arm: null };
      }
      return { result: await runTrials(item.id, basePassed, () => runItem(item, context, io)), arm: null };
    });
    const ablationRows = scoredResults.flatMap((one) => one.arm?.rows ?? []);
    const ablationSkipped = scoredResults.flatMap((one) => one.arm?.skipped ?? []);
    const byId = new Map(toScore.map((item, index) => [item.id, scoredResults[index].result]));
    const results = items.map((item) => carried.get(item.id) ?? byId.get(item.id));
    // THE PUBLICATION IS PINNED BEFORE THE LANES OPEN. The loop below both
    // reads and writes `catalogHash` — one case establishes the run's catalog
    // identity and every later one is checked against it — so it is a sequence
    // and not a set of independent items. The RUNNER CALL each case then makes
    // is independent, and that is what goes in the pool underneath.
    let catalogHash = null;
    const pinnedFor = [];
    for (const { trigger, one } of triggerCases) {
      let pinned = null;
      if (triggerMethod(one) === TRIGGER_METHOD_RUNNER) {
        try {
          // Real runner prompts always carry operate. Triggers must score that
          // same prompt, including when their only mapped grant is an area skill.
          const requested = { layers: ["operate"], skills: trigger.skills ?? [] };
          // Even a trigger with no skill names (operate) must pin the catalog
          // identity; preludeFrom deliberately returns early for an empty set.
          let assembled;
          if (requested.skills.length === 0) {
            if (typeof io.skills !== "function") throw new SkillsNotAssembledError(SKILL_SEAM_REASON);
            assembled = io.skills(tomquest.dir, wikitom.dir, requested);
          } else {
            assembled = context.prelude(requested);
          }
          pinned = { ...assembled, expectedCommit: wikitom.commit };
          if (assembled.commit === wikitom.commit && /^[0-9a-f]{64}$/.test(assembled.catalogHash ?? "")) {
            if (catalogHash !== null && catalogHash !== assembled.catalogHash) {
              pinned = { reason: "the pinned trigger catalog changed during the eval run" };
            } else {
              catalogHash = assembled.catalogHash;
            }
          }
        } catch (error) {
          pinned = { reason: `the trigger publication could not be pinned: ${serverErrorMessage(error)}` };
        }
      }
      pinnedFor.push(pinned);
    }
    const triggerResults = await inPool(
      triggerCases,
      ITEM_CONCURRENCY,
      async ({ trigger, one }, index) => await runTriggerCase(trigger, one, io, router, pinnedFor[index]),
    );
    // SORTED, so the repo order a run scores its tasks in is the same on every
    // box. `scoredIds` and `scoredHashes` are sorted downstream, but the ORDER
    // OF EXECUTION decides which task reaches a rate limit first, and a run
    // that fails a different task each time is a run whose failures cannot be
    // compared with the last one's.
    const taskItems = [...(io.taskRepos?.(tomquest.dir) ?? [])].sort()
      .flatMap((taskRepo) => loadTasks(tomquest.dir, taskRepo));
    const tasks = [];
    for (const task of taskItems) tasks.push(await runTrials(task.id, basePassed, () => runTask(task, trees, io)));
    const scored = results.filter((result) => result.judged !== "skip");
    const scoredTriggers = triggerResults.filter((result) => result.judged !== "skip");
    const scoredTasks = tasks.filter((task) => task.judged !== "skip");
    const scoredAll = [...scored, ...scoredTriggers];
    const sourceById = new Map();
    for (const source of [...items, ...triggerCases.map(({ trigger, one }) => ({ ...one, trigger: trigger.file })), ...taskItems]) {
      if (sourceById.has(source.id)) throw new Error(`duplicate scored item id ${source.id}`);
      sourceById.set(source.id, source);
    }
    const scoredHashes = Object.fromEntries([...scoredAll, ...scoredTasks]
      .map((result) => {
        const source = sourceById.get(result.id);
        if (source === undefined) throw new Error(`scored item ${result.id} has no source`);
        return [result.id, contentHash(source)];
      })
      .sort(([left], [right]) => left.localeCompare(right)));
    // A file is listed only when EVERY one of its cases ran, so a skipped case
    // cannot leave a file claiming coverage it did not measure.
    const ranByFile = new Map();
    triggerCases.forEach(({ trigger }, index) => {
      const ran = triggerResults[index]?.judged !== "skip";
      ranByFile.set(trigger.file, (ranByFile.get(trigger.file) ?? true) && ran);
    });
    const triggerFilesRun = [...ranByFile].filter(([, ran]) => ran).map(([file]) => file).sort();
    const summary = aggregate(scoredAll);
    const taskSummary = aggregate(scoredTasks);
    const errors = [...scoredAll, ...scoredTasks]
      .filter((result) => result.errored === true)
      .map((result) => result.errorMessage ?? String(result.reason ?? "runner failed").replace(/^runner failed: /, ""))
      .slice(0, 3);
    const errored = summary.errored + taskSummary.errored;
    // EVERY MEASURED CASE COUNTS, TRIGGERS INCLUDED. The trigger cases are
    // scored items like any other since phase 6, so a run whose runner died
    // must weigh them the same way — counting only the golden items would let
    // a broken box look survivable in proportion to how many triggers it also
    // failed to score.
    const scoredItems = scoredAll.length + scoredTasks.length;
    const finishedAt = io.now();
    // A run is catastrophic when at least one item was scored and
    // errored * 2 >= scoredItems: exactly half is runner failed because less
    // than half of expected evidence remains trustworthy. All-error is included.
    const catastrophic = scoredItems > 0 && errored * 2 >= scoredItems;
    return {
      repo,
      // The RESOLVED commit of whichever repo this run pins, so a run named
      // "origin/main" is recorded and keyed by the sha it actually scored.
      sha: repo === "WikiTom" ? wikitom.commit : tomquest.commit,
      tomquest: tomquest.commit,
      wikitom: wikitom.commit,
      catalogHash,
      goldenHash: goldenHash([...all, ...triggerCases.map(({ trigger, one }) => ({ ...one, trigger: trigger.file }))]),
      // The model that ran, marked when the box's model ceiling changed it
      // (worker/runs/models.mjs modelLabel).
      regenModel: modelLabel(REGEN_MODEL),
      judgeModel: modelLabel(JUDGE_MODEL),
      startedAt,
      finishedAt,
      // Trials, not items: a retried item costs its calls again and the row
      // says so. The ablation arm is one trial per name and costs the same two
      // calls each, so it is counted rather than hidden. A CARRIED item cost
      // nothing and is left out — a call count including the base's calls would
      // be the one number on this row that is not about this run.
      calls: (scored.filter((result) => result.carried !== true)
        .reduce((total, result) => total + (result.trials?.head ?? 1), 0) + ablationRows.length) * 2 +
        scoredTriggers.filter((result) => result.method === TRIGGER_METHOD_RUNNER).length,
      // WHAT THIS RUN COST AND WHY, in one object, so a check that wants to
      // warn on a slow run reads a number instead of subtracting two stamps and
      // guessing what filled the gap.
      //
      // The four counts are a partition of the items this run was handed:
      // `regenerated` paid for calls, `cached` came from the base row
      // unchanged, `unreplayable` could not be put in front of the model at
      // all, and `skipped` is everything the runner could not assemble this
      // time. `concurrency` is here because a duration means nothing without
      // it — the same work at four lanes and at one is the same calls and a
      // different afternoon.
      timing: {
        durationMs: finishedAt - startedAt,
        regenerated: toScore.length,
        cached: carried.size,
        skipped: [...results, ...triggerResults].filter((result) => result?.judged === "skip").length,
        unreplayable: unreplayableItems.length,
        concurrency: ITEM_CONCURRENCY,
      },
      // The ids actually scored, so the gate can tell a newly added item apart
      // from one that regressed without re-deriving the selection.
      scoredIds: [...scoredAll, ...scoredTasks].map((result) => result.id).sort(),
      scoredHashes,
      // The coverage gate requires every changed trigger filename to be here.
      triggerFilesRun,
      skipped: [...results, ...triggerResults].filter((result) => result.judged === "skip").map(({ id, reason, method }) => ({ id, reason, method })),
      // THE COUNT AND THE LIST, SAID OUT LOUD AND NEVER FOLDED INTO `items`.
      // An item whose input no prompt can carry is not a pass, not a failure
      // and not a skip: it is a measurement nobody can make. The row carries
      // the number so the check can print it, and the reasons so a reader never
      // has to open fifteen files to learn why the set shrank.
      unreplayable: unreplayableItems.length,
      unreplayableItems,
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
      //
      // `reason` is the scorer's own sentence, the failing trial's when one
      // failed (runCase's reason, runTrials's failedReason), so a flaky case
      // can be told from a failing one without re-running it. A passing case
      // keeps its reason too: the repair brief under Tom's 2026-09-21 ruling
      // asks for every item's, and a pass for the wrong reason shows only in
      // it. Bounded, because the row holds every scored case.
      results: scoredAll.map((result) => ({
        id: result.id,
        judged: result.judged,
        ...resultReason(result.failedReason ?? result.reason),
        ...(result.errored === true ? { errored: true } : {}),
        ...(result.method === undefined ? {} : { method: result.method }),
        passK: result.passK ?? (result.trials === undefined
          ? result.judged === "pass"
          : result.trials.headPassed === result.trials.head),
        ...(result.perTrial === undefined ? {} : { tokensMedian: result.tokensMedian ?? null }),
        // A CARRIED RESULT SAYS SO. The gate compares it like any other — it is
        // the base's own answer to the same bytes under the same inputs — but a
        // reader of the row must be able to tell a result this run measured
        // from one it reused, or `calls` and the numbers beside it read as a
        // contradiction.
        ...(result.carried === true ? { carried: true } : {}),
      })),
      ablation: ablationRows,
      ablationSkipped,
      ...summary,
      errored,
      errors,
      ...(catastrophic
        ? { error: true, reason: `runner failed: ${errors[0] ?? "runner failed"}`, regressions: null, goldenCoverage: null }
        : {}),
      tasks: taskSummary,
      tasksSkipped: tasks.filter((task) => task.judged === "skip").map(({ id, reason }) => ({ id, reason })),
    };
  } finally {
    tomquest.remove();
    wikitom.remove();
  }
}

/** A scorer's reason as a result entry keeps it: redacted, at most
 *  RESULT_REASON_CHARS characters, absent when there is none. */
const RESULT_REASON_CHARS = 300;
function resultReason(reason) {
  if (typeof reason !== "string" || reason.trim() === "") return {};
  return { reason: redactSecrets(reason.trim()).slice(0, RESULT_REASON_CHARS) };
}

const FLAGS = new Set(["--serve", "--weekly", "--force", "--ablation", "--faults-only", "--dry-run"]);
const VALUED = new Set(["--repo", "--sha", "--tasks", "--limit", "--jobs"]);

/**
 * The option key of a flag whose own name is not its key.
 *
 * The line below is `options[name.slice(2)] = true`, which for `--faults-only`
 * would set `options["faults-only"]` — a key nobody reads, so the flag would
 * parse cleanly and do nothing. The mapping is EXPLICIT rather than a
 * hyphen-to-camel rule, so a flag whose key is not what a rule would produce is
 * one row here and not a surprise.
 */
const FLAG_KEYS = { "--faults-only": "faultsOnly", "--dry-run": "dryRun" };

export function parseArgs(argv) {
  const options = {
    repo: null, sha: null, limit: PR_ITEMS,
    jobs: null, force: false, serve: false, weekly: false, ablation: false, tasks: null,
    faultsOnly: false, dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const name = argument.includes("=") ? argument.slice(0, argument.indexOf("=")) : argument;
    if (FLAGS.has(name)) {
      options[FLAG_KEYS[name] ?? name.slice(2)] = true;
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
  // --faults-only scores three checked-in fixtures and reads no tree at all, so
  // it needs neither a repo nor a sha, exactly as --weekly and --tasks do not.
  if (
    !options.serve && !options.weekly && !options.faultsOnly && options.tasks === null &&
    (options.repo === null || options.sha === null)
  ) {
    throw new Error("--repo and --sha are required unless --serve, --weekly, --faults-only or --tasks is given");
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
 *  or a model lives here, so the test drives runEvals with none of them.
 *
 *  Its model calls take no box slot (box-run.mjs's noSlot): the runs a pass
 *  scores hold the slots while they wait for its answer. */
export function realIo(env) {
  return {
    now: () => Date.now(),
    // THE ASYNC DOOR, and it is what makes ITEM_CONCURRENCY mean anything.
    // runClaude blocks the event loop for the whole call (spawnSync), so four
    // lanes over it would run one at a time and only look concurrent.
    // runClaudeAsync is the same call, the same envelope and the same no-slot
    // policy, awaited instead of waited for.
    runClaude: async (prompt, options) => await runClaudeAsync(prompt, options),
    layers: (tomquestTree, wikitomTree, names) => layersFor(tomquestTree, wikitomTree, names),
    // The session an explanation item was written from, out of the pinned
    // WikiTom tree. worker/jobs/evals-replay.mjs says why it is read from there
    // rather than carried in the item.
    replay: (wikitomTree, item) => replayContext(wikitomTree, item),
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
    // Tom's own labels, with the run behind each and the transcript rows the
    // judgment covers. THE SAME DOOR scripts/export-golden.mjs --source labels
    // reads, asked for the same bytes: the judge-agreement measure replays what
    // the corpus is mined from, so a second reader here would be a second
    // answer to "what did he judge".
    //
    // `limitPerSource` is the door's own cut and this measure takes the newest
    // LABEL_SAMPLE across all sources afterwards, so it asks for that many per
    // source rather than trying to spell one cut in two places.
    labels: async (limit) =>
      await convexFetch(env, `/tts/label-input?limitPerSource=${encodeURIComponent(String(limit))}`),
    // The planted-fault auditor. The fixture is a self-contained diff carried
    // whole in the prompt, so it needs no checkout and no Codex sandbox: this
    // is the SAME PROMPT the audit sends, put to the model the audit itself
    // falls back to. It is deliberately not worker/jobs/audit.mjs's runner —
    // that one posts to /tts/audit and would write an audit row for a commit
    // that does not exist — and it gates nothing, so the second family's
    // opinion is not what is being bought here.
    audit: async (prompt) => runClaude(prompt, {
      model: FAULT_AUDIT_MODEL,
      timeoutMs: FAULT_AUDIT_TIMEOUT_MS,
      maxTurns: FAULT_AUDIT_MAX_TURNS,
      registration: {
        origin: "cron:evals",
        kind: "job",
        layersKnown: false,
        layersGiven: [],
        layersDenied: [],
      },
    }),
    loadModules,
    cmtDir: () => cacheRepoDir(env, EVALS_CODE_REPOS.ComplexMultiTrigger),
    taskRepos: (tomquestTree) => {
      const dir = path.join(tomquestTree, TASKS_DIR);
      return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    },
    worktree: (repo, ref) => {
      const repoDir = evalsRepoDir(env, repo);
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

/** Every queue read identifies the installed runner before the door answers. */
export function evalsRequestRoute({ repo, sha } = {}) {
  const params = new URLSearchParams({ boxEvalsVersion: String(EVALS_PROTOCOL) });
  if (repo !== undefined) params.set("repo", repo);
  if (sha !== undefined) params.set("sha", sha);
  return `/tts/evals-request?${params}`;
}

/** One writer for every evals row, including cheap and failed answers. */
async function postRun(env, data) {
  await convexFetch(env, "/tts/event", {
    kind: EVALS_RUN,
    key: `${data.repo}@${data.sha}`,
    data: { ...data, boxEvalsVersion: EVALS_PROTOCOL },
  });
}

/** The fields of a row that scored nothing — shared by the two rows the box
 *  posts without running anything, so the pair cannot drift in the fields
 *  every reader of an evals run expects to find. */
/**
 * `answersRequestAt` IS THE QUESTION THIS ROW ANSWERS, and it is what makes a
 * row that scored nothing datable at all.
 *
 * These rows are not measurements of a commit: `superseded` says a later push
 * had already replaced this head when the queue looked, and an `error` row says
 * the tree could not be read that time. convex/ttsEvals.ts answeredRun has to
 * be able to tell such a row apart from one answering a question since
 * withdrawn, and comparing WRITE TIMES cannot do it. The box reads the request
 * and then posts, seconds later: if the sha becomes the live head again in
 * between, the row lands stamped AFTER the replacement request and a clock
 * comparison accepts the stale supersession — failing the live head until yet
 * another re-run. Carrying the request's own `requestedAt` makes the match
 * exact instead of racy.
 */
function unscoredRun({ repo, sha, at, answersRequestAt = null }) {
  return {
    repo,
    sha,
    answersRequestAt,
    tomquest: null,
    wikitom: null,
    goldenHash: null,
    regenModel: modelLabel(REGEN_MODEL),
    judgeModel: modelLabel(JUDGE_MODEL),
    startedAt: at,
    finishedAt: at,
    calls: 0,
    items: 0,
    pass: 0,
    fail: 0,
    flaky: 0,
    stillFailing: 0,
    weekly: false,
    byPartition: [],
    byVerdict: { approve: { items: 0, pass: 0 }, revise: { items: 0, pass: 0 } },
    failures: [],
    scoredIds: [],
    scoredHashes: {},
    triggerFilesRun: [],
    skipped: [],
    unreplayable: 0,
    unreplayableItems: [],
    timing: { durationMs: 0, regenerated: 0, cached: 0, skipped: 0, unreplayable: 0, concurrency: ITEM_CONCURRENCY },
    results: [],
    efficiency: { cases: 0, unknown: 0, rises: [] },
    ablation: [],
    ablationSkipped: [],
    tasks: aggregate([]),
    tasksSkipped: [],
  };
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
export function failedRun({ repo, sha, error, at, answersRequestAt = null }) {
  return {
    ...unscoredRun({ repo, sha, at, answersRequestAt }),
    error: redactSecrets(String(error ?? "runner failed")).slice(0, 300),
    regressions: null,
    // A run that could not be made checked no diff either, so the coverage
    // field says so rather than saying "satisfied". The merge gate denies on
    // null, which is what a row carrying `error` must do on every arm.
    goldenCoverage: null,
  };
}

/**
 * The row a head A LATER PUSH REPLACED is answered with, with no model run.
 *
 * Four pushes to one branch in a morning file four requests. The box serves
 * the oldest unanswered one per pass and a pass is about thirty-five minutes,
 * so the check on the fourth sha waits out three runs of shas nobody will ever
 * merge and then fails on its own seventy-five-minute deadline — which is what
 * happened to #172 and #173 on 2026-09-12. The queue names the head of each
 * pull request (convex/ttsEvals.ts internalOldestEvalsRequest), and every sha
 * that is not it is answered here in one POST.
 *
 * IT DENIES, and it must: `regressions: null` and `goldenCoverage: null` are
 * what convex/ttsMerge.ts refuses on, so a stale sha can never carry a gate
 * open. `error` carries the same sentence for readers older than this field —
 * a copy of scripts/evals-check.mjs that predates the superseded branch still
 * fails the check, and says why.
 *
 * `by` IS NOT ALWAYS A SHA. The queue also hands out a request filed before the
 * evals protocol with the protocol's name in that field (convex/ttsEvals.ts
 * internalOldestEvalsRequest), which this answers the same way and just as
 * cheaply. The denying fields are the shared ones, so the row the door writes
 * when it drains that backlog in bulk and the row this writes are one shape.
 */
export function supersededRun({ repo, sha, by, at, answersRequestAt = null }) {
  return {
    ...unscoredRun({ repo, sha, at, answersRequestAt }),
    ...supersededFields(by),
  };
}

/** The word an unaffected row answers golden coverage with. One fact, three
 *  homes — scripts/evals-check.mjs COVERAGE_NOT_REQUIRED and convex/
 *  ttsEvals.ts's constant of the same name are the other two, and neither can
 *  be imported here (the gate module is loaded by path, Convex not at all). */
export const COVERAGE_NOT_REQUIRED = "not-required";

/**
 * The row a branch that touched NOTHING WATCHED gets, with no model run.
 *
 * The box writes this only after it reads its own diff and the base tree's
 * policy. Convex files the client claim but never stamps the row, so every
 * request reaches `--serve` and an untrusted head cannot bypass the gate.
 *
 * `regressions: 0` is honest here in a way it would not be on a failed run:
 * nothing was scored because nothing could have regressed. `items` and `pass`
 * restate the base commit's numbers when a base run exists; `goldenHash` stays
 * null, because this row hashed no set of its own.
 */
export function unaffectedRun({ repo, sha, changed, base, at, answersRequestAt = null }) {
  return {
    ...unscoredRun({ repo, sha, at, answersRequestAt }),
    unaffected: true,
    changed: changed ?? null,
    items: typeof base?.items === "number" ? base.items : 0,
    pass: typeof base?.pass === "number" ? base.pass : 0,
    regressions: 0,
    goldenCoverage: COVERAGE_NOT_REQUIRED,
  };
}

/** Git's `-z` output is the only safe filename transport: a path may contain
 * a newline, so line splitting or Git's quoted display format would turn one
 * changed file into a different list. */
export function changedPathsFromGit(out) {
  return String(out).split("\0").filter((entry) => entry !== "");
}

/**
 * The base tree's watch policy, or `null` when that tree is older than the
 * policy — the file absent, or present without the two exports the box reads.
 *
 * THIS IS NOT A FALLBACK THAT GUESSES. It answers one question — can this base
 * say what is watched — and the caller's answer to "no" is to score the whole
 * evaluation, which is what the box would have done for any watched change.
 * There is no narrower list to substitute and none is invented here: the head's
 * own copy is exactly what may not be trusted (see trustedRequestDiff).
 *
 * WHY THIS IS NOT A THROW, WHICH IS WHAT IT REPLACED. `unaffectedBy` arrives on
 * this branch, so between a box rollout and the merge that brings it — the
 * order worker/README.md documents — every base is a base without it. Throwing
 * wrote a failed row per request, stamped `answersRequestAt` on it, and those
 * stamps stay current after the merge: the checks stay red until someone reruns
 * them by hand. Nothing about a missing shortcut makes a measurement unsafe, so
 * nothing about it should fail one.
 */
export async function basePolicyOf(dir) {
  const file = path.join(dir, "scripts", "evals-check.mjs");
  if (!fs.existsSync(file)) return null;
  const policy = await import(pathToFileURL(file).href);
  if (!Array.isArray(policy.WATCHED_PATHS) || typeof policy.unaffectedBy !== "function") return null;
  return policy;
}

/**
 * The box, rather than the pull-request checkout, decides whether a request
 * is unaffected. Both commits are detached worktrees in the request's cache:
 * the diff is read from that cache and the watch policy is imported from the
 * trusted tom.quest base.
 *
 * A head may edit scripts/evals-check.mjs to narrow the list, so it is never
 * imported here. WikiTom's Action fetches this check from tom.quest, so its
 * policy comes from tom.quest's base too: the request repository supplies the
 * comparison, and no request head supplies the watch.
 *
 * A shallow cache needs its box-fetched main and head tips deepened by a
 * bounded amount before Git can find their merge base; that base names the
 * branch diff while current main remains the evaluation baseline. The request
 * `baseSha` is not used because a request can be stale or retargeted. A
 * two-dot diff intersected with head paths still needs head history, so it
 * would add another shallow-history rule instead of establishing the branch.
 *
 * `basePolicy` says which base answered: `"present"`, or `"absent"` when the
 * base is older than the policy — see basePolicyOf.
 */
export async function trustedRequestDiff(request, io, run = git) {
  let baseTree = null;
  let headTree = null;
  let policyTree = null;
  try {
    // `baseSha` is a CI hint. The box's own origin/main is the only baseline
    // that may decide policy, an empty diff, or comparison provenance.
    baseTree = io.worktree(request.repo, "origin/main");
    headTree = io.worktree(request.repo, request.sha);
    policyTree = request.repo === "tom.quest"
      ? baseTree
      : io.worktree("tom.quest", "origin/main");
    const policy = await basePolicyOf(policyTree.dir);
    // This fetch has both tips from the box's cache, never a commit named by
    // the request. Complete cache clones reject --deepen, so deepen only when
    // Git says this cache is shallow. If their bounded history has no common
    // ancestor, the catch below posts the required failed row rather than
    // scoring a guessed diff.
    const shallow = run(baseTree.dir, "rev-parse", "--is-shallow-repository").trim() === "true";
    if (shallow) {
      run(
        baseTree.dir,
        "fetch", "--deepen", String(DIFF_HISTORY_DEEPEN), "origin", "main", headTree.commit,
      );
    }
    // `git merge-base` SAYS "NO COMMON ANCESTOR" BY EXITING 1, not by printing
    // an empty line — and `run` throws on a non-zero exit. The empty-string
    // test that used to stand here could therefore never fire, and the row read
    // a bare `Command failed: git … merge-base …` instead (seen for the purged
    // shas 5c2178c, e9d750d, 04ad3c8, af3ce9d, 98882ab). The catch is what the
    // dead branch is replaced by, and it cannot itself be deleted: without it
    // the one failure a purged mirror actually produces is the one the row
    // cannot name.
    //
    // EXIT 1 IS THE ONLY CODE THAT MEANS THIS. A missing repository, an
    // unreadable object or a bad argument exits 128, and those are rethrown
    // unchanged so the row goes on naming what git said.
    let mergeBase;
    try {
      mergeBase = run(baseTree.dir, "merge-base", baseTree.commit, headTree.commit).trim();
    } catch (error) {
      if (error?.status !== 1) throw error;
      throw new Error(
        `no common ancestor between ${baseTree.commit} and ${headTree.commit} in the box's mirror`,
      );
    }
    const out = run(
      baseTree.dir,
      "diff", "--no-renames", "--name-only", "-z",
      `${mergeBase}..${headTree.commit}`,
    );
    const changed = changedPathsFromGit(out);
    // A BASE THAT CANNOT SAY WHAT IS WATCHED HAS EVERYTHING WATCHED. The only
    // shortcut the policy can authorise is the no-run one, so its absence costs
    // a full scored run and nothing else: the comparison base, the changed list
    // and the coverage input are all still the box's own.
    if (policy === null) {
      return { base: baseTree.commit, changed, unaffected: false, watchedPaths: null, basePolicy: "absent", affectedJobs: null };
    }
    // The list is read from the same base module that supplies its predicate.
    const watchedPaths = [...policy.WATCHED_PATHS];
    return {
      base: baseTree.commit,
      changed,
      unaffected: policy.unaffectedBy(changed),
      watchedPaths,
      basePolicy: "present",
      // WHICH JOBS THIS DIFF CAN MOVE, from the same base module for the same
      // reason the watch comes from it: a head that narrowed this list would
      // carry its own base results over a change that moved them. A base too
      // old to answer says null, which regenerates everything — the same answer
      // an absent policy gives the shortcut above.
      affectedJobs: typeof policy.jobsAffectedBy === "function" ? policy.jobsAffectedBy(changed) : null,
    };
  } catch (error) {
    const reason = redactSecrets(serverErrorMessage(error)).slice(0, 300);
    console.error(`[evals] ${request.repo}@${request.sha}: could not establish the box diff (${reason}); failing the request`);
    return { base: null, changed: null, unaffected: false, error: reason };
  } finally {
    if (policyTree !== baseTree) policyTree?.remove();
    headTree?.remove();
    baseTree?.remove();
  }
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
  // A head that scored nothing is not a comparison, and neither is a base
  // that scored nothing. The shared helper includes request-only rows too:
  // normal unaffected and superseded requests bypass this path, but they fail
  // closed if one reaches stamping unexpectedly.
  // A run is catastrophic when at least one item was scored and
  // errored * 2 >= scoredItems: exactly half is runner failed because less than
  // half of expected evidence remains trustworthy. All-error is included.
  if (scoredNothing(data)) {
    return {
      ...data,
      regressions: null,
      stillFailing: 0,
      goldenCoverage: null,
      efficiency: efficiencyOf(data.results, null),
      failures: data.failures.map((failure) => ({ ...failure, regression: false })),
    };
  }
  if (gateModule === null || base === null || base === undefined || scoredNothing(base)) {
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
    // An errored item leaves no trustworthy comparison number: `0` would open
    // the merge gate even though the eval gate refused this run. Keep the count
    // so the gate's denial says what the runner did not answer.
    regressions: verdict.errored.length > 0 ? null : verdict.regressions.length,
    errored: verdict.errored.length,
    stillFailing: verdict.stillFailing.length,
    // From the gate's own verdict rather than from the rule called twice: one
    // body decides what coverage is, here and in the check's log alike.
    goldenCoverage: verdict.goldenCoverage,
    efficiency: efficiencyOf(data.results, base.results),
    failures: data.failures.map((failure) => ({ ...failure, regression: regressed.has(failure.id) })),
  };
}

/**
 * `dryRun` COMPUTES EVERYTHING AND WRITES NOTHING: the run data is printed and
 * postRun is not called. A measurement nobody asked for must not write a row —
 * a dry run exists so a change to this file can be read before it lands in the
 * record, and a dry run that posted would put a rehearsal into the record the
 * digest and the merge gate read.
 *
 * `scorecard` is the verifier scorecard, stamped onto the row before it is
 * posted the way `ablation` and `efficiency` already ride it — one key on one
 * row, so convex/ttsWeekly.ts reads it with no new field, no new index and no
 * new row kind.
 */
export async function runAndPost(env, io, {
  repo, sha, base, limit, jobs, weekly, ablation = false, force, changed, prBody,
  dryRun = false, scorecard = undefined, answersRequestAt = null, unaffectedClaimed = false,
  basePolicy = null, affectedJobs = null,
}) {
  const existing = force || dryRun ? null : await convexFetch(env, `/tts/evals-run?repo=${repo}&sha=${sha}`);
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
    if (scoredNothing(baseData)) baseData = null;
    if (baseData === null) {
      baseData = await stampAgainstBase(await runEvals({ repo, sha: base, limit, jobs, weekly }, io), null);
      if (!dryRun) await postRun(env, baseData);
      console.log(`[evals] base ${repo}@${base}: ${baseData.pass}/${baseData.items} pass`);
    }
  }
  // The base's passing ids are the head run's retry list: exactly those items
  // can become a regression, so exactly those are tried again when they fail.
  const data = {
    ...await stampAgainstBase(
      await runEvals({
        repo, sha, limit, jobs, weekly, ablation, basePassed: passedIds(baseData), changed,
        // THE ONE THING A HEAD MAY REUSE FROM ITS BASE. `carryOver` is the base
        // row itself, and runEvals reuses a result from it only when the item's
        // bytes are identical on both sides AND its job reads nothing this diff
        // touched. Both halves are checked there; here is only where the two
        // facts are handed over together, because neither means anything alone.
        // A weekly run carries nothing over: it is the measurement the
        // graduation pass rests on, and it scores everything.
        carryOver: weekly ? null : baseData,
        affectedJobs: weekly ? null : affectedJobs,
      }, io),
      baseData,
      { changed, prBody },
    ),
    // A scored row is an answer to this request too. Convex revalidates these
    // facts before any reader, including the merge gate, accepts the row.
    ...(answersRequestAt === null ? {} : {
      answersRequestAt,
      answersBaseSha: base ?? null,
      answersChanged: changed ?? null,
      answersPrBody: prBody ?? null,
      ...(unaffectedClaimed ? { unaffectedClaimed: true, unaffected: false } : {}),
    }),
    ...(scorecard === undefined ? {} : { verifierScorecard: scorecard }),
    // ONLY THE ABSENCE IS RECORDED. A present policy is every ordinary row, and
    // a field that says "normal" on every row says nothing on any of them; this
    // one exists so that a full run the box took because its base could not
    // name a watch is legible as that, rather than as a branch that happened to
    // touch something watched.
    ...(basePolicy === "absent" ? { basePolicy: "absent" } : {}),
  };
  if (dryRun) console.log(JSON.stringify(data, null, 2));
  else if (answersRequestAt !== null) {
    // A run can take fifty minutes. Check the request it started for rather
    // than the queue head, which may be another PR entirely. A replacement
    // gets a nonmeasurement answer for this old identity, so the shared
    // currentness rule leaves the newer request queued and the gate closed.
    const current = await convexFetch(
      env,
      evalsRequestRoute({ repo, sha }),
    );
    if (current?.request?.requestedAt !== answersRequestAt) {
      const stale = failedRun({
        repo,
        sha,
        error: "eval request replaced while the runner was measuring it",
        at: Date.now(),
        answersRequestAt,
      });
      await postRun(env, stale);
      return stale;
    }
    await postRun(env, data);
  } else await postRun(env, data);
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

/**
 * The live question a person is trying to answer with a direct run.
 *
 * This is deliberately independent of `--force`: `--force` decides whether an
 * existing measurement is rerun, while this identity says which standing
 * request that measurement answers. A plain direct run after a request was
 * re-filed must carry it too, or Convex correctly leaves the new request
 * unanswered and the person's work is invisible to the check.
 */
export async function directRequestIdentity(env, { repo, sha }) {
  const { request } = await convexFetch(
    env,
    evalsRequestRoute({ repo, sha }),
  );
  if (request === null || request === undefined) return null;
  return {
    prBody: request.prBody ?? null,
    answersRequestAt: request.requestedAt ?? null,
    unaffectedClaimed: requestClaimsUnaffected(request),
  };
}

/** Requests filed before `unaffected` became `unaffectedClaimed` can still be
 * waiting when this deploys. Like `answersRequestAt`, keep their old spelling
 * through that rollout window; remove it after no pre-rename request can stand
 * in the queue. */
function requestClaimsUnaffected(request) {
  return request.unaffectedClaimed === true || request.unaffected === true;
}

/**
 * One polling pass over the request queue.
 *
 * ONE SCORED REQUEST PER PASS, so a cron tick is bounded — and that is the only
 * thing bounded, because it is the only thing that costs anything. A superseded
 * request is one POST and no model, so the pass keeps taking them: a queue four
 * dead pushes deep drains on THIS tick and the live head is served on it too,
 * rather than one dead sha every five minutes. The count is a stop, not a
 * budget: a door that kept handing back the same request would otherwise spin
 * here forever. The bound cannot be deleted: repeated delivery after an answer
 * is a queue failure, and one cron pass must stop instead of spinning on it.
 *
 * Exported so that stop can be tested. It is reached only through `--serve`,
 * and the shape of the bug it guards against — a loop that keeps asking a door
 * whose answer it did nothing to change — is not visible from serveRequest.
 */
export async function servePass(env, io, options = {}) {
  let protocolChecked = false;
  for (let answered = 0; answered < SERVE_SUPERSEDED_LIMIT; answered += 1) {
    const response = await convexFetch(env, evalsRequestRoute());
    const doorProtocol = Number.isSafeInteger(response?.evalsProtocol) && response.evalsProtocol > 0
      ? response.evalsProtocol
      : null;
    const seenProtocol = Number.isSafeInteger(response?.boxEvalsVersion) && response.boxEvalsVersion > 0
      ? response.boxEvalsVersion
      : EVALS_PROTOCOL;
    if (doorProtocol !== null && seenProtocol < doorProtocol) {
      // This guard cannot be deleted: without it an installed old runner keeps
      // taking work whose answers the deployed door must refuse, once per cron
      // tick, while every later request waits behind it.
      const gap = typeof response.protocolGap === "string" && response.protocolGap !== ""
        ? response.protocolGap
        : `the box's evals runner is at protocol ${seenProtocol}; this door needs ${doorProtocol} — run worker/setup.sh on the box`;
      await (options.reportFailed ?? reportJobFailed)(env, {
        job: EVALS_JOB,
        key: EVALS_PROTOCOL_FAILURE_KEY,
        error: gap,
      });
      throw new Error(gap);
    }
    if (!protocolChecked && options.dryRun !== true) {
      await (options.reportOk ?? reportJobOk)(env, {
        job: EVALS_JOB,
        key: EVALS_PROTOCOL_FAILURE_KEY,
      });
      protocolChecked = true;
    }
    const { request } = response;
    if (request === null || request === undefined) {
      console.log("[evals] no unanswered request");
      return;
    }
    const data = await serveRequest(env, io, request, options);
    // A DRY RUN ANSWERS NOTHING — that is the whole point of it — so there is
    // nothing behind this request to move on to: the door would hand back the
    // same request on every turn of this loop, twenty-five times, and then
    // print that twenty-five requests had been answered. One request, and the
    // pass is over.
    if (options.dryRun === true || data?.superseded !== true) return;
  }
  console.log(
    `[evals] ${SERVE_SUPERSEDED_LIMIT} superseded requests answered this pass; ` +
      `the rest wait for the next tick`,
  );
}

/**
 * One queued request, answered.
 *
 * Exported so the two paths out of it can be tested without a command line:
 * an UNAFFECTED request is answered from the request alone, with `io` never
 * touched — no clone, no worktree, no model — and every other request goes to
 * the runner as before.
 *
 * `options.dryRun` WRITES NOTHING, on every arm and not only the scored one.
 * A dry run exists so a change to this file can be read before it lands in the
 * record, and the three cheap arms below — superseded, unaffected, failed —
 * each write a row exactly as a scored run does. A dry run that posted one
 * would put a rehearsal into the record the digest and the merge gate read,
 * and would ANSWER the request besides, taking it out of the queue the next
 * real tick was going to serve.
 */
export async function serveRequest(env, io, request, options = {}) {
  const dryRun = options.dryRun === true;
  // A LATER PUSH ALREADY REPLACED THIS HEAD, as the queue read it (convex/
  // ttsEvals.ts internalOldestEvalsRequest). FIRST, before every other branch:
  // it is the cheapest answer there is, and nothing else about a sha nobody
  // will merge is worth learning.
  if (
    typeof request.supersededBy === "string" && request.supersededBy !== "" &&
    request.supersededBy !== request.sha
  ) {
    const data = supersededRun({
      repo: request.repo,
      sha: request.sha,
      by: request.supersededBy,
      at: Date.now(),
      answersRequestAt: request.requestedAt ?? null,
    });
    if (!dryRun) await postRun(env, data);
    console.log(
      `[evals] ${request.repo}@${request.sha}: superseded by ` +
        `${supersededName(request.supersededBy)} — answered without a run`,
    );
    return data;
  }
  // The client must not decide this shortcut.
  // The box decides from its own diff and base-tree policy.
  // from a door that could not — and the answer is still the same row, written
  // `changed` and `unaffected` from CI are claims. Only this box-side diff,
  // judged with the base tree's policy, may take the no-run shortcut.
  const boxDiff = await trustedRequestDiff(request, io, options.diffRun ?? git);
  const unaffectedClaimed = requestClaimsUnaffected(request);
  if (typeof boxDiff.error === "string" && boxDiff.error !== "") {
    // A box diff is the evidence for both a baseline and the no-run shortcut.
    // Without it, a scored row would look like a valid no-baseline run and
    // could downgrade a regression to a new failure.
    const data = failedRun({
      repo: request.repo,
      sha: request.sha,
      error: boxDiff.error,
      at: Date.now(),
      answersRequestAt: request.requestedAt ?? null,
    });
    if (!dryRun) await postRun(env, data);
    return data;
  }
  if (boxDiff.unaffected) {
    const base = boxDiff.base
      ? (await convexFetch(env, `/tts/evals-run?repo=${request.repo}&sha=${boxDiff.base}`))?.run ?? null
      : null;
    const data = unaffectedRun({
      repo: request.repo,
      sha: request.sha,
      changed: boxDiff.changed,
      base: scoredNothing(base) ? null : base,
      at: Date.now(),
      answersRequestAt: request.requestedAt ?? null,
    });
    if (unaffectedClaimed) data.unaffectedClaimed = true;
    if (!dryRun) await postRun(env, data);
    console.log(
      `[evals] ${request.repo}@${request.sha}: unaffected — no watched path changed, nothing scored`,
    );
    return data;
  }
  try {
    return await runAndPost(env, io, {
      repo: request.repo,
      sha: request.sha,
      base: boxDiff.base,
      limit: options.limit,
      jobs: options.jobs,
      weekly: false,
      // A served request IS the pull-request run. The ablation arm never
      // runs here, whatever the command line said.
      ablation: false,
      // The box's own diff is the coverage input.
      // it — it has a shallow cache clone with no merge base — and a second
      changed: boxDiff.changed,
      affectedJobs: boxDiff.affectedJobs ?? null,
      prBody: request.prBody,
      // The same identity cheap rows carry: a request replaced while this
      // long run is in flight cannot accept this old measurement as current.
      answersRequestAt: request.requestedAt ?? null,
      unaffectedClaimed,
      basePolicy: boxDiff.basePolicy ?? null,
      force: options.force,
      dryRun,
    });
  } catch (error) {
    // A run that threw still has to be ANSWERED, or this request is taken
    // again on every tick and nothing behind it is ever served.
    const reason = redactSecrets(serverErrorMessage(error)).slice(0, 300);
    console.error(`[evals] ${request.repo}@${request.sha} could not be run: ${reason}`);
    const data = failedRun({
      repo: request.repo,
      sha: request.sha,
      error: reason,
      at: Date.now(),
      answersRequestAt: request.requestedAt ?? null,
    });
    if (!dryRun) await postRun(env, data);
    return data;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // ONE EVALS RUN ON THIS BOX AT A TIME, TAKEN HERE AND NOT IN THE CRON LINE.
  //
  // The cron was the only thing that had ever started this file, so nothing
  // guarded the case that actually happened: a run started by hand while the
  // five-minute `--serve` tick was mid-run. Both cleared the same worktrees
  // and both posted rows. A lock in the crontab would still not have covered
  // it — the hand-run does not go through the crontab — so it is taken by the
  // program itself, where every caller passes.
  //
  // REFUSING IS NOT FAILING. A held lock is the normal state of a job that
  // runs every five minutes and sometimes takes fifty minutes; the next tick
  // takes it. The line says who holds it, and the exit is clean so the tick
  // does not read as a broken job.
  const lock = takeEvalsLock({ what: process.argv.slice(2).join(" ") || "evals" });
  if (!lock.held) {
    console.log(`[evals] another evals run is already going — ${lock.why}; this one is doing nothing`);
    return;
  }
  try {
    await runMain(options);
  } finally {
    lock.release();
  }
}

async function runMain(options) {
  // The debris of runs that were killed, cleared before this one adds its own.
  // Worktrees name the process that made them, so this takes only what no live
  // run owns (worker/jobs/evals-lock.mjs).
  const pruned = pruneStaleWorktrees(WORK_DIR);
  if (pruned.length > 0) console.log(`[evals] cleared ${pruned.length} worktree(s) left by runs that died`);
  const env = loadEnv({ require: ["CONVEX_SITE_URL", "TTS_WORKER_KEY"] });
  const io = realIo(env);

  // --faults-only ANSWERS ONE QUESTION AND SCORES NO EVAL SET: does the auditor
  // still refuse the three changes it must refuse. It runs the fixtures
  // whatever the date says, prints their verdicts, and POSTS NOTHING.
  //
  // It posts nothing even alongside --weekly, which is a deliberate departure
  // from the brief: the scorecard rides a weekly evals-run row, and this path
  // scores no set, so there is no such row to ride. Minting one would put a
  // measurement onto a row that measured nothing, which is the one thing a row
  // carrying `error` in this file already refuses to do.
  if (options.faultsOnly) {
    const faults = await faultAudits(io, { at: Date.now(), force: true, dir: auditFaultsRoot(env) });
    for (const result of faults.results) console.log(`${result.id}\t${result.verdict}`);
    console.log(
      `[evals] planted faults: ${faults.refused}/${faults.items} refused (${faults.reason}); ` +
        `a missed fault is a fact and opens nothing`,
    );
    return;
  }

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
    await servePass(env, io, options);
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
    // THE SCORECARD IS COMPUTED ONCE AND RIDES ONE ROW — tom.quest's.
    //
    // ONE ROW RATHER THAN TWO because it is a measurement of the VERIFIERS, not
    // of either repository's golden set: two copies of one measurement is two
    // things to keep true, and the reader (convex/ttsWeekly.ts) would have to
    // pick which of two disagreeing copies was the week's. tom.quest carries it
    // because the judge prompt, the fixtures and the audit all live there.
    //
    // It is computed BEFORE the two set runs rather than after them, which the
    // brief put the other way round: runAndPost posts its row from inside
    // itself, so a scorecard computed afterwards could only be attached by
    // posting the same key a second time — two rows saying different things
    // about one run, which is the failure the key exists to prevent. Nothing
    // about the scorecard depends on either run, so the order is free.
    const scorecard = await verifierScorecard(io, env, { at: Date.now(), force: options.force });
    for (const repo of ["tom.quest", "WikiTom"]) {
      await runAndPost(env, io, {
        repo,
        sha: "origin/main",
        base: null,
        limit: options.limit,
        jobs: options.jobs,
        weekly: true,
        ablation: options.ablation,
        force: true,
        dryRun: options.dryRun,
        ...(repo === "tom.quest" ? { scorecard } : {}),
      });
    }
    return;
  }

  const requestIdentity = await directRequestIdentity(
    env,
    { repo: options.repo, sha: options.sha },
  );
  const boxDiff = await trustedRequestDiff({ repo: options.repo, sha: options.sha }, io);
  // A direct run has no served request to receive failedRun. It cannot score
  // without the trusted comparison: a null base would hide a broken box as a
  // valid no-baseline measurement.
  if (typeof boxDiff.error === "string" && boxDiff.error !== "") {
    throw new Error(`could not establish the trusted diff: ${boxDiff.error}`);
  }

  await runAndPost(env, io, {
    repo: options.repo,
    sha: options.sha,
    base: boxDiff.base,
    limit: options.limit,
    jobs: options.jobs,
    weekly: false,
    ablation: options.ablation,
    force: options.force,
    dryRun: options.dryRun,
    changed: boxDiff.changed,
    prBody: requestIdentity?.prBody,
    answersRequestAt: requestIdentity?.answersRequestAt ?? null,
    unaffectedClaimed: requestIdentity?.unaffectedClaimed ?? false,
    basePolicy: boxDiff.basePolicy ?? null,
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[evals] FAILED: ${serverErrorMessage(error)}`);
    process.exit(1);
  });
}
