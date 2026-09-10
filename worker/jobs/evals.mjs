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
//   node /opt/tts/evals.mjs --repo tom.quest --sha <sha> [--base <sha>] [--limit N] [--jobs prepare,code-brief] [--force]
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

export const EVALS_RUN = "evals-run";
export const EVALS_REQUEST = "evals-request";

export const REGEN_MODEL = process.env.TTS_EVALS_REGEN_MODEL || "haiku";
export const JUDGE_MODEL = process.env.TTS_EVALS_JUDGE_MODEL || "fable";
export const REGEN_TIMEOUT_MS = 5 * 60 * 1000;
export const JUDGE_TIMEOUT_MS = 3 * 60 * 1000;

/** The on-commit set: the newest 20 approve and 20 revise across the whole
 *  golden set, by ruledAt. The weekly run uses everything. */
export const PR_ITEMS = 40;
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

/** Every golden item in a tom.quest tree, id-ascending. Both homes are read:
 *  evals/golden/*.json (the exporter's) and evals/golden/explanations/*.json
 *  (the importer's). */
export function loadGolden(tomquestTree) {
  const roots = [path.join(tomquestTree, GOLDEN_DIR), path.join(tomquestTree, GOLDEN_DIR, "explanations")];
  const items = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).sort()) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(root, name);
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
  return { names, text, commit: meta.commit, files: meta.files };
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
};

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
 */
export function judgePrompt(item, fresh, fields) {
  const verdict = verdictOf(item);
  const input = { ...item.input };
  delete input.priorReviseSentence;
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
    ...(verdict === "revise" ? [`--- TOM'S SENTENCE ---`, item.sentence ?? "", ``] : []),
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

/** One item: build the prompt, regenerate, judge. Never throws — a failure is
 *  a result, so one bad item cannot end the run. */
export async function runItem(item, context, io) {
  const job = JOBS[item.job];
  const base = { id: item.id, partition: item.partition, verdict: verdictOf(item), confirmed: isConfirmed(item) };
  if (job === undefined) {
    return { ...base, judged: "fail", reason: `no runner for job ${item.job}` };
  }
  let fresh;
  try {
    const prompt = job.build(item, context.layers(job.layers), context.modules[item.job]);
    if (typeof item.sentence === "string" && item.sentence !== "" && prompt.includes(item.sentence)) {
      // The honesty check, enforced at run time as well as in the test: a
      // regeneration that was handed the label sentence proves nothing.
      return { ...base, judged: "fail", reason: "regeneration failed: the label sentence reached the prompt" };
    }
    const answer = await io.runClaude(prompt, {
      model: REGEN_MODEL,
      timeoutMs: REGEN_TIMEOUT_MS,
      ...job.opts,
      cwd: job.opts?.cwd === "@cmt" ? context.cmtDir : job.opts?.cwd,
    });
    fresh = job.parse(answer, context.modules[item.job]);
  } catch (err) {
    return { ...base, judged: "fail", reason: `regeneration failed: ${serverErrorMessage(err)}` };
  }
  let answer;
  try {
    answer = await io.runClaude(judgePrompt(item, fresh, job.fields), {
      model: JUDGE_MODEL,
      timeoutMs: JUDGE_TIMEOUT_MS,
      maxTurns: 1,
    });
  } catch (err) {
    return { ...base, judged: "fail", reason: `judge answer unreadable: ${serverErrorMessage(err)}` };
  }
  return { ...base, ...parseJudge(answer) };
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
  for (const result of results) {
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
    byPartition: [...byPartition.values()].sort((a, b) => a.partition.localeCompare(b.partition)),
    byVerdict,
    failures: results
      .filter((result) => result.judged !== "pass")
      .map(({ id, partition, verdict, reason, confirmed }) => ({ id, partition, verdict, reason, confirmed }))
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
 * The five task kinds, and which of them this branch can actually run.
 *
 * `locate`, `explain` and `change` are the repo-task kinds. `delegate` and
 * `slack` are two widenings of that closed union, each defined by its own
 * design and each built on its own branch — the item FORMAT and this runner's
 * interface land here so the writing evals are not held up, and the branch
 * named below supplies the code that answers them.
 */
export const TASK_KINDS = Object.freeze(["locate", "explain", "change", "delegate", "slack"]);
export const TASK_BRANCHES = Object.freeze({ delegate: "uac/delegate", slack: "uac/slack" });

/** The mechanical checks every task kind runs before any model call. */
export function mechanicalChecks(task, text) {
  const haystack = String(text ?? "").toLowerCase();
  for (const needle of task.expect?.mustName ?? []) {
    if (!haystack.includes(String(needle).toLowerCase())) return `does not name ${JSON.stringify(needle)}`;
  }
  for (const needle of task.expect?.mustNotName ?? []) {
    if (haystack.includes(String(needle).toLowerCase())) return `names ${JSON.stringify(needle)}, which it must not`;
  }
  return null;
}

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
  return { ...base, ...(await io.runTaskKind(task, trees)) };
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
    modules[item.job] = await import(pathToFileURL(path.join(tomquestTree, job.module)).href);
  }
  return modules;
}

/**
 * One run: the golden items of the pinned tom.quest tree, regenerated against
 * the pinned WikiTom tree, judged, aggregated, and posted as one evals-run row.
 * `io` carries every side effect so the test can drive this with no network
 * and no model.
 */
export async function runEvals({ repo, sha, limit = PR_ITEMS, jobs = null, weekly = false }, io) {
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
    const context = {
      cmtDir: io.cmtDir?.() ?? undefined,
      modules,
      layers: (names) => {
        const key = names.join(",");
        if (!layerCache.has(key)) layerCache.set(key, io.layers(tomquest.dir, wikitom.dir, names));
        return layerCache.get(key);
      },
    };
    const results = [];
    for (const item of items) results.push(await runItem(item, context, io));
    const tasks = [];
    for (const taskRepo of io.taskRepos?.(tomquest.dir) ?? []) {
      for (const task of loadTasks(tomquest.dir, taskRepo)) tasks.push(await runTask(task, trees, io));
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
      calls: scored.length * 2,
      // The ids actually scored, so the gate can tell a newly added item apart
      // from one that regressed without re-deriving the selection.
      scoredIds: [...scored, ...tasks.filter((task) => task.judged !== "skip")].map((result) => result.id).sort(),
      skipped: results.filter((result) => result.judged === "skip").map(({ id, reason }) => ({ id, reason })),
      ...summary,
      tasks: aggregate(tasks.filter((task) => task.judged !== "skip")),
      tasksSkipped: tasks.filter((task) => task.judged === "skip").map(({ id, reason }) => ({ id, reason })),
    };
  } finally {
    tomquest.remove();
    wikitom.remove();
  }
}

const FLAGS = new Set(["--serve", "--weekly", "--force"]);
const VALUED = new Set(["--repo", "--sha", "--base", "--tasks", "--limit", "--jobs"]);

export function parseArgs(argv) {
  const options = {
    repo: null, sha: null, base: null, limit: PR_ITEMS,
    jobs: null, force: false, serve: false, weekly: false, tasks: null,
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
  return options;
}

/** The io a real run uses. Everything that touches the network, git, the disk
 *  or a model lives here, so the test drives runEvals with none of them. */
function realIo(env) {
  return {
    now: () => Date.now(),
    runClaude: async (prompt, options) => runClaude(prompt, options),
    layers: (tomquestTree, wikitomTree, names) => layersFor(tomquestTree, wikitomTree, names),
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
      git(repoDir, "fetch", "origin");
      return worktreeFor(repoDir, repo, ref);
    },
  };
}

async function postRun(env, data) {
  await convexFetch(env, "/tts/event", { kind: EVALS_RUN, key: `${data.repo}@${data.sha}`, data });
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
 * Stamp regressions and stillFailing onto a run, and mark each failure with
 * whether it is one — the digest prints regression lines and must not have to
 * compare two runs to know which they are.
 */
export async function stampAgainstBase(data, base) {
  const gateModule = await loadGate();
  if (gateModule === null || base === null || base === undefined) {
    return {
      ...data,
      regressions: 0,
      stillFailing: 0,
      failures: data.failures.map((failure) => ({ ...failure, regression: false })),
    };
  }
  const verdict = gateModule.gate(data, base);
  const regressed = new Set(verdict.regressions.map((failure) => failure.id));
  return {
    ...data,
    regressions: verdict.regressions.length,
    stillFailing: verdict.stillFailing.length,
    failures: data.failures.map((failure) => ({ ...failure, regression: regressed.has(failure.id) })),
  };
}

async function runAndPost(env, io, { repo, sha, base, limit, jobs, weekly, force }) {
  const existing = force ? null : await convexFetch(env, `/tts/evals-run?repo=${repo}&sha=${sha}`);
  if (existing?.run) {
    console.log(`[evals] ${repo}@${sha} already scored (${existing.run.pass}/${existing.run.items}); --force to rerun`);
    return existing.run;
  }
  // The base runs FIRST when nothing has scored it: a head run with no
  // baseline can only report, and the box is the only machine that can make
  // one, so it makes it here rather than leaving the check blind.
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
  const data = await stampAgainstBase(await runEvals({ repo, sha, limit, jobs, weekly }, io), baseData);
  await postRun(env, data);
  console.log(
    `[evals] ${repo}@${sha}: ${data.pass}/${data.items} pass, ${data.regressions} regression(s), ` +
      `${data.stillFailing} still failing (golden ${data.goldenHash})`,
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
    await runAndPost(env, io, {
      repo: request.repo,
      sha: request.sha,
      base: request.baseSha,
      limit: options.limit,
      jobs: options.jobs,
      weekly: false,
      force: options.force,
    });
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
      await runAndPost(env, io, { repo, sha: "origin/main", base: null, limit: options.limit, jobs: options.jobs, weekly: true, force: true });
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
