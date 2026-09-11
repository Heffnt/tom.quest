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
    const layers = context.layers(job.layers);
    const prompt = job.build(item, layers, context.modules[item.job]);
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
      registration: {
        origin: "cron:evals",
        kind: "job",
        layersKnown: true,
        layersGiven: layers.names,
        layersDenied: ["operate", "write", "know"].filter((name) => !layers.names.includes(name)),
        wikitomCommit: layers.commit,
      },
    });
    fresh = job.parse(answer, context.modules[item.job]);
  } catch (err) {
    return { ...base, judged: "fail", reason: `regeneration failed: ${serverErrorMessage(err)}` };
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
  const produced = await io.runTaskKind(task, trees);
  // THE MECHANICAL HALF DECIDES FIRST. mustName and mustNotName are read off
  // the answer's own text with no model in the loop, and a violation is the
  // item's score — the kind runner's own verdict, and any judge behind it, is
  // not consulted about a text that already broke the item's rule. The check
  // runs only when the runner surfaced its text: a runner that reports a
  // verdict and no answer has nothing to check mechanically, and scoring an
  // absent text against mustName would fail every such item.
  if (typeof produced?.text === "string") {
    const mechanical = mechanicalChecks(task, produced.text);
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

/**
 * One run: the golden items of the pinned tom.quest tree, regenerated against
 * the pinned WikiTom tree, judged, aggregated, and posted as one evals-run row.
 * `io` carries every side effect so the test can drive this with no network
 * and no model.
 */
export async function runEvals({ repo, sha, limit = PR_ITEMS, jobs = null, weekly = false, basePassed = new Set() }, io) {
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
    for (const item of items) results.push(await runTrials(item.id, basePassed, () => runItem(item, context, io)));
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
      // says so.
      calls: scored.reduce((total, result) => total + (result.trials?.head ?? 1), 0) * 2,
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
    byPartition: [],
    byVerdict: { approve: { items: 0, pass: 0 }, revise: { items: 0, pass: 0 } },
    failures: [],
    scoredIds: [],
    skipped: [],
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
 * Stamp regressions and stillFailing onto a run, and mark each failure with
 * whether it is one — the digest prints regression lines and must not have to
 * compare two runs to know which they are.
 */
export async function stampAgainstBase(data, base) {
  const gateModule = await loadGate();
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
  // The base's passing ids are the head run's retry list: exactly those items
  // can become a regression, so exactly those are tried again when they fail.
  const data = await stampAgainstBase(
    await runEvals({ repo, sha, limit, jobs, weekly, basePassed: passedIds(baseData) }, io),
    baseData,
  );
  await postRun(env, data);
  console.log(
    `[evals] ${repo}@${sha}: ${data.pass}/${data.items} pass, ` +
      `${data.regressions === null ? "compared to no base" : `${data.regressions} regression(s)`}, ` +
      `${(data.flaky ?? 0) + (data.tasks?.flaky ?? 0)} flaky, ` +
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
    try {
      await runAndPost(env, io, {
        repo: request.repo,
        sha: request.sha,
        base: request.baseSha,
        limit: options.limit,
        jobs: options.jobs,
        weekly: false,
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
