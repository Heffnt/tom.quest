#!/usr/bin/env node
// plan-graphs.mjs — THE PLANNER. One run, three passes, in this order:
//
//   1. PREPARE — every unprepared life todo (a #dump capture, an email
//      capture, a Canvas announcement, a todo Tom ruled "revise" on) gets its
//      write-up: a brief, the smallest entry action, a work description, a
//      ground-up explanation, and readiness "prepared". One headless-Claude
//      call per todo. This pass used to be its own job (prepare-life-todos.mjs,
//      every 2 minutes) and was absorbed here in the lifeos update, phase 7:
//      the planner already reads every todo every run, and a capture's
//      write-up and its place in a graph are one job's worth of reading.
//      Nothing here posts to Slack — the events route replies at capture.
//   2. BRIEF — every open CMT code todo whose YAML changed, or that Tom ruled
//      "revise" on, gets a ground-up brief against the current tree and a
//      recommendation in the four verdict words (was brief-code-todos.mjs).
//   3. PLAN — maintain the graph inside every batch via headless Claude.
//
// Run by cron every 30 minutes under flock (see /etc/cron.d/tts). Manual run:
//   node /opt/tts/plan-graphs.mjs            # all three passes
//   node /opt/tts/plan-graphs.mjs --force    # also re-prepare prepared todos
//                                            # and re-brief EVERY open entry
//
// WHAT A BATCH IS (schema v2, ratified 2026-08-29). A batch is NOT a todo.
// It is its own row, and it holds one thing: HOW a set of todos gets
// completed. Its contents are todos pointing back at it, in two kinds:
//   goal — a state of the world the batch is FOR, checkable by a condition
//          ("the lease is signed"). Goals are the todos Tom already had; the
//          batch is the machinery for reaching them.
//   task — a piece of work someone does. Tasks are what this job writes.
// Tasks and goals are wired by `needs`: a todo is READY when every id in its
// needs is done (archived counts as done — a need that was set aside is not
// going to happen, and leaving it blocking would strand the graph forever).
// Batches are sequenced by `needs` too (the lifeos update, phase 7): a batch
// lists the ids of the batches that must land before it, the same word as
// between todos. That is the only sequencing there is — the named `path` it
// succeeded was derived into needs by a migration and dropped.
//
// THE PLAN PASS'S ONE RESPONSIBILITY: for each batch, propose the graph. It
// executes nothing and rules on nothing. Every gate lives on the server
// (tts.internalStorePlanGraph): a Tom-touched batch is frozen and never
// rewritten, a task that fails validation is DROPPED with a named reason while
// the rest of the graph still lands, cycles are dropped, and the per-batch
// skip report comes back here to be logged.
//
// THE PREPARE PASS NEVER REWRITES INTENT. It writes brief, entryAction,
// workDescription, groundUpExplanation and readiness; the statement and the
// status are Tom's (the server pen, tts.internalPrepareTodo, enforces the
// same). A date reaches a todo through this pass ONLY when the statement
// itself states one ("pay rent sept 3") — Tom's own words, never a guess —
// and only as a FIRST date (the pen refuses an overwrite and a resurrection
// of a date Tom already resolved). Whether a prepared todo is READY for Tom
// is computed on the server (convex/ttsShared.ts isReadyForTom), never
// written here.
//
// GROUND-UP EXPLANATIONS ARE HTML DOCUMENTS (Tom, 2026-08-29: rendered as
// prose they are "an incomprehensible wall of text"). Every explanation this
// job writes — a prepared todo's, the batch's, each task's — is a complete
// self-contained HTML page, which the /tts page shows fullscreen in a
// sandboxed, script-less iframe. The form is specified once, in the writing
// standard that rides in on /tts/batch-context; the prompts below only name
// the requirement and the palette. Stored explanations come back into the
// plan prompt as extracted-text PREVIEWS, never as markup.
//
// REVISE RULINGS. Tom can rule "revise" with one written sentence on a life
// todo (the prepare pass re-prepares it with the sentence in the prompt) or on
// a batch (the plan pass embeds the sentence; it overrides any other reading
// of the inputs). Each is consumed via /tts/ruling-applied only once its
// effect landed — a skipped batch or a failed preparation leaves its ruling
// pending, so the next run tries again on the same sentence.
//
// PLAN REPAIRS: a worker that reached a task and found the graph wrong (an
// edge that is not a real prerequisite, a missing one that blocked it) records
// a "plan-repair" event. That is the only channel by which doing the work
// corrects the planning of it, so those reports are injected as instructions
// to FIX THE STRUCTURE, not as commentary. Like a revise ruling they are
// CONSUMED once the batch they are about has been re-planned
// (/tts/plan-repairs-consumed): an instruction re-asserted every half hour
// after it has been carried out is an instruction to change something else.
//
// NO-STATE RULE: Convex is read and written each run. The only local file is
// the input-hash cursor in /var/lib/tts/ — losing it merely costs one extra
// Claude invocation on inputs that had not changed.
//
// TESTABLE HALVES. The passes are exported and take their model call and
// their Convex writes as an `io` argument, so worker/jobs/plan-graphs.test.mjs
// runs them against stubs; main() below wires the real ones. Importing this
// module is safe: it only runs main() when node was pointed at the file (the
// `invokedDirectly` guard at the bottom).

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  loadEnv,
  convexFetch,
  runClaude,
  extractJsonObject,
  clip,
  nyNoonUtcMs,
  MAX_LIFE_PER_RUN,
  MAX_BRIEF_CHARS,
  JSON_ONLY_ANSWER,
} from "./tts-lib.mjs";
import {
  CMT_REPO,
  TODOS_PATH,
  cmtRepoDir,
  yamlToJson,
  sourceHash,
  readBriefHashes,
  writeBriefHashes,
  findEntryBlock,
} from "./tts-code-lib.mjs";

const HASH_PATH = "/var/lib/tts/plan-input-hash";
// Bump when the plan prompt changes semantics: it joins the input hash, so a
// new prompt re-plans even inputs that have not changed.
const PROMPT_VERSION = 4;
const CLAUDE_TIMEOUT_MS = 20 * 60 * 1000;

// MAX_LIFE_PER_RUN (how many unbatched life todos one run offers as goal
// candidates) and MAX_BRIEF_CHARS, together with clip(), are imported from
// tts-lib.mjs, the one home for the brief-clipping rule. Do not re-declare
// them here.
// Full graphs shown per run, most-recently-updated first. EVERY active batch's
// statement is listed regardless (one line each, so the planner cannot
// recreate a grouping that already exists); only this many carry their whole
// task list. Same bounding logic as the life slice, applied to the other axis.
const MAX_GRAPHS_PER_RUN = 20;
// Ground-up explanations are shown CLIPPED, under a field name that is not an
// output field (`groundUpExplanationPreview`), so a clipped copy can never be
// pasted back as the real value and truncate it. Since 2026-08-29 every stored
// explanation is a COMPLETE HTML DOCUMENT (Tom's ruling: prose renders as an
// incomprehensible wall of text, so the "more" layer is a fullscreen page), so
// both the batch's and the task's are previewed, and the preview is built from
// text EXTRACTED from the document — clipping raw HTML yields 240 characters
// of doctype and <style>, which tells the planner nothing about the content
// and would show it a half-open tag as if it were prose.
const MAX_PREVIEW_CHARS = 240;
const MAX_BATCH_PREVIEW_CHARS = 600;
const MAX_CODE_TODOS = 60;
const NOTE_MAX = 20;

// ── The prepare pass's bounds ────────────────────────────────────────────────
// Todos prepared per run. One Claude call each, so the bound is the run's
// worst case: PREPARE_MAX × PREPARE_TIMEOUT_MS, inside the 30-minute cadence
// only because the cron line's flock makes an overrun a skipped tick rather
// than a second run. A backlog drains PREPARE_MAX per run.
export const PREPARE_MAX = 10;
export const PREPARE_TIMEOUT_MS = 5 * 60 * 1000;
// The one value preparation produces (ruling 18); ready is computed.
export const PREPARED = "prepared";

/**
 * The readable text of a ground-up explanation, for preview only. An HTML
 * document (anything whose first non-space character is "<") is reduced to its
 * prose: head matter dropped, tags removed, whitespace collapsed, the handful
 * of entities that survive that unescaped. Legacy plain-text explanations pass
 * through untouched. Lossy on purpose — nothing built here is ever stored.
 */
function explanationText(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (!value.trimStart().startsWith("<")) return value;
  return value
    .replace(/<!DOCTYPE[^>]*>/gi, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** An explanation as the planner sees it: extracted text, clipped. */
function explanationPreview(value, max) {
  return clip(explanationText(value), max);
}


// ── PASS 1: prepare ──────────────────────────────────────────────────────────

/** The prompt that prepares ONE life todo. */
export function preparePrompt(todo, reviseSentence, today, writingStandard) {
  return [
    writingStandard,
    ``,
    `You are preparing one item in TTS, Tom's personal todo system. It was`,
    `captured as a raw thought; your job is to make it arrive pre-chewed.`,
    ``,
    `Write:`,
    `1. "brief" - 2-5 sentences. If the statement is too terse to interpret`,
    `   confidently, say so plainly in the brief and phrase what needs clarifying.`,
    `2. "entryAction" - the SMALLEST first action, imperative, under 10 words`,
    `   (e.g. "Open the reservation page", "Draft two sentences to Ana").`,
    `3. "workDescription" - the kind/size of engagement, qualitatively, a few`,
    `   words (e.g. "a two-minute errand", "a short ruling", "a session's`,
    `   worth of writing"). NEVER a numeric time estimate.`,
    `4. "groundUpExplanation"`,
    `5. "dueDate" - ONLY when the statement ITSELF names an explicit date`,
    `   ("pay rent sept 3", "call the bank on Friday the 12th"). Then give it`,
    `   as "YYYY-MM-DD". Otherwise give null.`,
    `   NEVER infer, estimate, or invent a date - no "this seems urgent, so`,
    `   next week". A date you were not told in the statement is a date that`,
    `   does not exist. Only the words in "statement" count; a date mentioned`,
    `   anywhere else is not this item's date.`,
    `6. "dateKind" - ONLY when you gave a dueDate. "external" if the statement`,
    `   shows the deadline was imposed by someone or something else (a bill, a`,
    `   landlord, a booking window, a court date); "self-imposed" if it reads`,
    `   as Tom's own choice of when. When the statement does not say, answer`,
    `   "self-imposed". Otherwise give null.`,
    ``,
    JSON_ONLY_ANSWER,
    `{"brief": "...", "entryAction": "...", "workDescription": "...",`,
    ` "groundUpExplanation": "<explanation>",`,
    ` "dueDate": null, "dateKind": null}`,
    ``,
    `The item (JSON):`,
    JSON.stringify({
      statement: todo.statement,
      source: todo.source,
      provenance: todo.provenance ?? null,
      category: todo.category ?? null,
      createdAt: todo.createdAt,
    }, null, 2),
    ``,
    ...(reviseSentence ? [
      `Tom reviewed an earlier preparation of this item and ruled "revise" -`,
      `his one written sentence below redirects this re-preparation and`,
      `overrides any other reading of the item:`,
      ``,
      `Tom's revise ruling: ${reviseSentence}`,
      ``,
    ] : []),
    `Today is ${today} in New York, which is how you resolve a bare month+day`,
    `or weekday to a year.`,
  ].join("\n");
}

/** A row inside a batch that is not a goal: a step of a graph, never prepared
 * on its own ("unprepared" is a task's resting state; briefing one would
 * flood the needs-me feed with plan steps). */
const isGraphTask = (t) =>
  t.batchId !== undefined && t.batchId !== null && t.kind !== "goal";

/**
 * Which todos this run prepares, and the revise ruling each carries, from the
 * pending-rulings feed and the todo list:
 *   - a graph task is never prepared here (see isGraphTask); a GOAL is — it is
 *     one of Tom's own todos the planner bound, and binding must not be what
 *     stops it getting prepared;
 *   - an active unprepared todo is prepared; with `force`, a prepared one too;
 *   - a todo with a pending life "revise" ruling is re-prepared REGARDLESS of
 *     status (the verdict dropped its readiness server-side; the sentence is
 *     what pulls it back in, and preparation touches no status, so
 *     re-preparing an archived todo is safe — an active-only filter would
 *     strand the ruling pending forever if Tom changed the status after
 *     ruling).
 */
export function selectPrepareTargets(todos, pending, { force = false } = {}) {
  const all = Array.isArray(todos) ? todos : [];
  const reviseByTodo = new Map();
  for (const r of Array.isArray(pending) ? pending : []) {
    if (r.subjectType !== "life" || r.verdict !== "revise" || !r.todoId) continue;
    reviseByTodo.set(r.todoId, r);
  }
  const targets = all.filter(
    (t) =>
      !isGraphTask(t) &&
      (reviseByTodo.has(t._id) ||
        (t.status === "active" && (t.readiness === "unprepared" || force))),
  );
  return { targets, reviseByTodo };
}

/**
 * The prepare pass. `io.runClaude(prompt, opts)` answers the model call and
 * `io.post(path, body)` is the Convex write; both are the real functions in
 * main() and stubs in the tests. Returns the counts and the ids prepared, and
 * MUTATES the todo objects it prepared (brief, readiness) so the plan pass in
 * the same run sees the write-up it just made without a second read.
 */
export async function prepareLifeTodos(
  { todos, pending, today, writingStandard, force = false },
  io,
) {
  const { targets, reviseByTodo } = selectPrepareTargets(todos, pending, { force });
  if (targets.length === 0) return { prepared: 0, failed: 0, preparedIds: [] };
  const batch = targets.slice(0, PREPARE_MAX);
  console.log(
    `[plan-graphs] prepare: ${targets.length} to prepare ` +
      `(${reviseByTodo.size} revise ruling(s) pending), processing ${batch.length}`,
  );
  let failed = 0;
  const preparedIds = [];
  for (const todo of batch) {
    const revise = reviseByTodo.get(todo._id) ?? null;
    try {
      const answer = io.runClaude(
        preparePrompt(todo, revise?.sentence ?? null, today, writingStandard),
        { timeoutMs: PREPARE_TIMEOUT_MS },
      );
      const parsed = extractJsonObject(answer);
      if (
        typeof parsed.brief !== "string" ||
        typeof parsed.entryAction !== "string" ||
        typeof parsed.workDescription !== "string" ||
        typeof parsed.groundUpExplanation !== "string" ||
        parsed.groundUpExplanation.trim() === ""
      ) {
        throw new Error(`bad shape: ${JSON.stringify(parsed).slice(0, 120)}`);
      }
      // A date the STATEMENT states, in Tom's own words. Sent only when the
      // todo has no date AND no date HISTORY — a todo whose date Tom already
      // resolved (missed, renegotiated) must never have that same date handed
      // back to it by a re-prep of the same sentence. The server enforces both
      // halves regardless (internalPrepareTodo); this filter keeps the job
      // from asking. A malformed date is dropped, never guessed at: the rest
      // of the preparation still lands.
      let dueAt;
      const dateSettled =
        todo.dueAt !== undefined || (todo.dateOutcomes ?? []).length > 0;
      if (typeof parsed.dueDate === "string" && !dateSettled) {
        try {
          dueAt = nyNoonUtcMs(parsed.dueDate.trim());
        } catch (e) {
          console.error(`[plan-graphs] ${todo._id} ignoring dueDate: ${e.message}`);
        }
      }
      // Whose deadline it is, as the statement reads it — passed through, not
      // assumed. Anything but a clean "external" is self-imposed.
      const dateKind = parsed.dateKind === "external" ? "external" : "self-imposed";
      await io.post("/tts/prepare-todo", {
        id: todo._id,
        brief: parsed.brief,
        entryAction: parsed.entryAction,
        workDescription: parsed.workDescription,
        groundUpExplanation: parsed.groundUpExplanation,
        readiness: PREPARED,
        ...(dueAt !== undefined ? { dueAt, dateKind } : {}),
      });
      if (revise) {
        // The re-prep landed — consume the ruling so the UI shows the
        // outcome and the next run doesn't re-prepare on the same sentence.
        await io.post("/tts/ruling-applied", {
          id: revise._id,
          result: "revised: brief re-prepared",
        });
      }
      // What the plan pass reads in this same run.
      todo.brief = parsed.brief;
      todo.readiness = PREPARED;
      preparedIds.push(todo._id);
      console.log(
        `[plan-graphs] prepared ${todo._id}` +
          `${revise ? " (revise ruling applied)" : ""} ` +
          `"${todo.statement.slice(0, 50).replace(/\s+/g, " ")}"`,
      );
    } catch (err) {
      // Per-item failure: log and continue — the item stays unprepared (or
      // its revise ruling stays pending) and the next run retries it. One
      // bad item must not starve the batch.
      failed++;
      console.error(
        `[plan-graphs] prepare ${todo._id} FAILED: ${String(err.message ?? err).slice(-200)}`,
      );
    }
  }
  return { prepared: preparedIds.length, failed, preparedIds };
}

// ── PASS 2: brief ────────────────────────────────────────────────────────────
// Every OPEN entry of CMT's vqc/todos.yaml gets a ground-up brief against the
// CURRENT tree and a recommendation in the four verdict words. This pass used
// to be brief-code-todos.mjs (every 2 hours at :17), absorbed here in the
// lifeos update, phase 7. Incremental: an entry is re-briefed only when its
// YAML changed since the last posted brief (a sha256 source hash per entry in
// /var/lib/tts/brief-hashes.json — losing the file re-briefs everything once,
// and the Convex POST upserts) or when Tom ruled "revise" on it (the pending
// ruling's sentence rides into the prompt as the replan note, and the ruling
// is consumed once the fresh brief has posted). Each success is durable in
// dependency order (Convex, then the cursor), so a crash mid-run loses at
// most the entry in flight. Convex holds the one copy of a brief: the worker
// mission that carries out an approve or archive reads it from there.

// At most this many briefs per run (all pending with --force). Bounds the run:
// 8 entries × the 10-minute per-entry timeout is 80 minutes worst case; the
// cron line's flock turns an overrun into skipped ticks, never a second run.
export const BRIEF_MAX_PER_RUN = 8;
export const BRIEF_TIMEOUT_MS = 10 * 60 * 1000;
// Briefing gets a real exploration budget (vs the non-agentic default of 8):
// the model must open cited ledger/constitution/code files to judge whether a
// plan still matches the tree, and each file read is a turn.
export const BRIEF_MAX_TURNS = 40;

// The four verdict words (the lifeos update): the recommendation is the
// worker's read of what Tom will rule, spelled in the words he rules in.
// convex/ttsShared.ts RECOMMENDATION_VALUES is the one home; this is the
// box's literal mirror (Node never loads .ts).
export const RECOMMENDATIONS = new Set(["approve", "revise", "session", "archive"]);
export const EXEC_CLASSES = new Set(["needs-turing", "box"]);

// Build the per-entry prompt. `entryYaml` is the entry's RAW block from
// todos.yaml (real YAML beats re-serialized JSON: Tom's comments and block
// scalars survive), `replanNote` is Tom's revise sentence when he ruled
// revise, else null.
export function briefPrompt(entryYaml, replanNote, writingStandard) {
  return [
    writingStandard,
    ``,
    `You are briefing Tom on ONE entry of vqc/todos.yaml in the ComplexMultiTrigger`,
    `repo. Your working directory is a checkout of that repo at current master -`,
    `use your file-reading tools to open the files, ledger entries, and constitution`,
    `articles the entry cites, and any code the plan touches. Verify, don't assume.`,
    ``,
    `Write a GROUND-UP brief for Tom (~250-400 words).`,
    ``,
    `End with a recommendation - the verdict Tom will most likely rule, in`,
    `the four words he rules in - chosen by EXACTLY these criteria, in order;`,
    `the first that applies wins:`,
    `1. The completion condition is already satisfied by landed work, or the`,
    `   intent is moot/superseded -> "archive", and set "evidence" to the`,
    `   commits/files that prove it.`,
    `2. The intent is live but the plan is stale against the tree -> "revise".`,
    `3. The plan is live but embeds an open judgment call Tom has not made -`,
    `   ALL tier-C entries land here by definition -> "session".`,
    `4. All clean -> "approve".`,
    ``,
    `Also classify execClass: "needs-turing" if executing the plan requires the`,
    `SLURM cluster / GPUs, else "box" (runnable on an ordinary Linux box).`,
    ``,
    JSON_ONLY_ANSWER,
    `{"brief": "...", "recommendation": "approve|revise|session|archive",`,
    ` "execClass": "needs-turing|box", "evidence": "..." (optional)}`,
    ``,
    `The entry:`,
    ``,
    entryYaml,
    ``,
    ...(replanNote !== null ? [
      `Tom ruled "revise" on this entry's existing brief and plan` +
        (replanNote ? ` with the sentence: ${replanNote}` : `.`),
      `His sentence overrides any other reading of the entry. Propose a`,
      `FRESH plan inside the brief, grounded in the current tree.`,
      ``,
    ] : []),
  ].join("\n");
}

/**
 * Which entries this run briefs: every open entry whose source hash moved
 * since its last brief, plus every open entry with a pending code "revise"
 * ruling (re-briefed whatever its hash, with the sentence as the replan
 * note), plus everything with `force`. `entries` are the parsed open entries
 * of todos.yaml, `hashes` the cursor file's map.
 */
export function selectBriefTargets(entries, hashes, pending, { force = false } = {}) {
  const reviseById = new Map();
  for (const r of Array.isArray(pending) ? pending : []) {
    if (r.subjectType !== "code" || r.verdict !== "revise") continue;
    if (r.repo !== CMT_REPO || typeof r.externalId !== "string") continue;
    reviseById.set(r.externalId, r);
  }
  const targets = [];
  for (const entry of entries) {
    const key = `${CMT_REPO}:${entry.id}`;
    const hash = sourceHash(entry);
    const revise = reviseById.get(entry.id) ?? null;
    if (!force && !revise && hashes[key] === hash) continue; // unchanged
    targets.push({ entry, key, hash, revise });
  }
  return targets;
}

/**
 * The brief pass. `repo` is the CMT checkout the model reads from: its
 * directory (the model's cwd), the raw todos.yaml text (for the entry blocks)
 * and the parsed OPEN entries. `io` adds two file-shaped hooks to the pass
 * contract — `readHashes()` and `writeHashes(map)` — so the tests keep the
 * cursor in memory.
 */
export async function briefCodeTodos({ repo, pending, writingStandard, force = false }, io) {
  const hashes = io.readHashes();
  const targets = selectBriefTargets(repo.entries, hashes, pending, { force });
  if (targets.length === 0) return { briefed: 0, failed: 0 }; // quiet when idle
  const batch = force ? targets : targets.slice(0, BRIEF_MAX_PER_RUN);
  console.log(
    `[plan-graphs] brief: ${targets.length} entr${targets.length === 1 ? "y" : "ies"} to brief, ` +
      `processing ${batch.length}${force ? " (--force)" : ""}`,
  );
  let briefed = 0;
  let failed = 0;
  for (const { entry, key, hash, revise } of batch) {
    try {
      // The raw YAML block for the prompt; fall back to JSON if the block
      // scan somehow misses (it shouldn't — the entry came from this file).
      const found = findEntryBlock(repo.todosText, entry.id);
      const entryYaml = found ? found.block : JSON.stringify(entry, null, 2);
      const replanNote = revise ? (revise.sentence ?? "") : null;

      const answer = io.runClaude(briefPrompt(entryYaml, replanNote, writingStandard), {
        cwd: repo.dir, // non-agentic: read-only tools over the repo, no edits
        timeoutMs: BRIEF_TIMEOUT_MS,
        maxTurns: BRIEF_MAX_TURNS,
      });
      const parsed = extractJsonObject(answer);

      // Validate hard — a brief with a garbage recommendation would render
      // as a broken ruling card in the UI, so fail THIS entry loudly instead.
      if (typeof parsed.brief !== "string" || parsed.brief.trim() === "") {
        throw new Error("answer has no brief text");
      }
      if (!RECOMMENDATIONS.has(parsed.recommendation)) {
        throw new Error(`invalid recommendation: ${JSON.stringify(parsed.recommendation)}`);
      }
      if (!EXEC_CLASSES.has(parsed.execClass)) {
        throw new Error(`invalid execClass: ${JSON.stringify(parsed.execClass)}`);
      }
      const evidence =
        typeof parsed.evidence === "string" && parsed.evidence.trim() !== ""
          ? parsed.evidence
          : undefined;

      // Durable in dependency order: Convex first (the system of record),
      // then the cursor — so a crash can only leave us re-doing work, never
      // believing work happened that didn't.
      await io.post("/tts/code-briefs", {
        briefs: [
          {
            repo: CMT_REPO,
            externalId: entry.id,
            sourceHash: hash,
            brief: parsed.brief,
            recommendation: parsed.recommendation,
            execClass: parsed.execClass,
            ...(evidence ? { evidence } : {}),
          },
        ],
      });
      hashes[key] = hash;
      io.writeHashes(hashes);
      if (revise) {
        // The fresh brief landed — consume the ruling so the UI shows the
        // outcome and the next run does not re-brief on the same sentence.
        await io.post("/tts/ruling-applied", {
          id: revise._id,
          result: "revised: brief re-written with a fresh plan",
        });
      }
      briefed++;
      console.log(
        `[plan-graphs] briefed ${entry.id}: ${parsed.recommendation} ` +
          `(${parsed.execClass}${revise ? ", fresh plan after revise" : ""})`,
      );
    } catch (err) {
      // Per-entry failure: the entry keeps its old cursor (or its revise
      // ruling stays pending) and the next run retries it.
      failed++;
      console.error(`[plan-graphs] brief ${entry.id} FAILED: ${err.message}`);
    }
  }
  return { briefed, failed };
}

// ── PASS 3: plan ─────────────────────────────────────────────────────────────

export function graphPrompt(ctx) {
  return [
    ctx.writingStandard,
    ``,
    ctx.vocabulary,
    ``,
    `You are the PLANNER for TTS, Tom's todo system. Your job is to maintain`,
    `the GRAPH inside each batch. You propose structure; Tom rules. Nothing`,
    `you output executes anything.`,
    ``,
    `TASK — output the batches whose graphs you are writing this run. Rules:`,
    ``,
    `SEQUENCE BATCHES WITH NEEDS. When a batch genuinely cannot start until`,
    `another batch has landed, put that batch's id in its "needs". Most`,
    `batches need nothing and run beside each other; a need is a true`,
    `prerequisite, never "this would help".`,
    ``,
    `GOALS ARE THE ACCUMULATED TODOS. A goal is an END STATE Tom wanted, and`,
    `it already exists as a todo — put its id in "goalIds". Never write a goal`,
    `as a task. A batch with no goal is a batch with no reason to exist.`,
    ``,
    `TASKS ARE THE WORK. Each task is one concrete piece of work with one`,
    `actor: "agent" for what an agent does, "tom" for what needs Tom — phrase`,
    `Tom's tasks as the decision or action put to him.`,
    ``,
    `EDGES MODEL TRUE PREREQUISITES, NOTHING ELSE. Put B in A's needs only`,
    `when A genuinely cannot start until B is finished. Work that could`,
    `proceed at the same time gets NO edge between it: parallel workstreams`,
    `are separate branches out of whatever they actually depend on. A single`,
    `chain through everything is almost always wrong — it is the shape you get`,
    `by listing steps in the order you thought of them, and it makes the ready`,
    `set one task wide when the real frontier is four.`,
    ``,
    `DE-CHAIN EVERY MIGRATED GRAPH YOU TOUCH. The graphs migrated from the`,
    `old system are single chains BY CONSTRUCTION — their edges record the`,
    `order steps were once written down, not real prerequisites. When a batch`,
    `you output has OPEN tasks forming one straight line, that structure is`,
    `presumed wrong: re-emit every open task (by id, statement verbatim) with`,
    `its needs REBUILT from actual dependencies. Most batches should come out`,
    `with several parallel branches; keep a chain only where each task truly`,
    `consumes the previous one's output. Preserve-by-omission does not apply`,
    `to this audit — an untouched chain is a chain you are asserting is real.`,
    ``,
    `CARRY DONE TASKS FORWARD UNTOUCHED. A task with "status": "done" already`,
    `happened. Re-emit it with its id, its statement verbatim, and its needs`,
    `unchanged. Never reword it, never re-open it, never drop it.`,
    ``,
    `PRESERVE BY OMISSION. Any field you leave out keeps the value already`,
    `stored. Omit a field rather than guessing at it, and never copy back a`,
    `"...Preview" value — those are extracted text, not the stored document.`,
    ``,
    `WITH ONE EXCEPTION: "statement" IS ALWAYS REQUIRED. Every batch object you`,
    `output carries its statement, and every task object carries its own, even`,
    `when neither has changed — repeat the stored text verbatim. A batch with`,
    `no statement cannot be stored at all, and the whole graph under it is`,
    `lost.`,
    ``,
    `IDS. Echo "batchId" and a task "id" whenever you are rewriting something`,
    `from the lists above; omit them for anything new. A task's "needs" holds`,
    `either an existing todo id (a string) or the position of an EARLIER task`,
    `in the same "tasks" array (a number, zero-based).`,
    ``,
    `MODEL. Workers run the fleet default, whatever Tom currently has it set`,
    `to (today gpt-5.6-sol), and you write NOTHING for that — omitting "model"`,
    `is the normal case and the right one for almost every task.`,
    ``,
    `Add "model" ONLY when a task needs one specific model, and then use`,
    `exactly one of: "opus" | "sonnet" | "fable" | "gpt-5.6-sol" |`,
    `"gpt-5.6-terra". The gpt-5.6-* names run the task on Codex; the others`,
    `run it on Claude. Reach for one only for these reasons:`,
    `  "fable"          the hardest Claude-side reasoning — novel design, a`,
    `                   subtle correctness argument, deep unfamiliar code.`,
    `  "opus"/"sonnet"  the task needs Claude specifically (a Claude-only`,
    `                   tool, or work on Claude's own configuration).`,
    `  "gpt-5.6-terra"  a cheap mechanical batch — bulk renames, repetitive`,
    `                   edits, wide but shallow reading.`,
    `  "gpt-5.6-sol"    the task needs Codex specifically at full strength.`,
    `Mechanical or well-specified work does not warrant a stronger model.`,
    ``,
    `WRITE AN EXPLANATION ONLY WHEN YOU MEAN TO REPLACE ONE. A batch or task`,
    `whose explanation is already right keeps it by OMISSION — leave the field`,
    `out. When you do include it, you are writing the entire document fresh;`,
    `there is no way to amend one, and a fragment overwrites a whole page.`,
    ``,
    `EVERY NEW TASK AND EVERY NEW BATCH GETS ONE.`,
    ``,
    `ARCHIVE. Set "archive": true on a batch whose goals are all reached or`,
    `abandoned. Never on a frozen one.`,
    ``,
    JSON_ONLY_ANSWER,
    `{"batches": [{"batchId": "...", "statement": "...",`,
    ` "groundUpExplanation": "<explanation>",`,
    ` "needs": ["<batch id>"],`,
    ` "repos": ["<repo>"],`,
    ` "tasks": [{"id": "...", "statement": "...", "actor": "<actor>",`,
    `            "needs": ["<todo id>", 0], "condition": "...",`,
    `            "groundUpExplanation": "<explanation>",`,
    `            "status": "active", "model": "<model>"}],`,
    ` "goalIds": ["..."], "archive": false}]}`,
    ``,
    `EXISTING BATCHES WITH THEIR GRAPHS (JSON). Each: id, statement,`,
    `groundUpExplanationPreview, needs (batch ids), repos,`,
    `frozen, tasks, goals. A goal carries id, statement, condition, status,`,
    `mustNotBreak (Tom's line, or null), codeRepo, codeExternalId. A task`,
    `carries id, statement, actor, status, needs, condition, evidence, model,`,
    `and its own groundUpExplanationPreview. Every "...Preview" value is`,
    `readable extracted text, not a value you may copy into output:`,
    JSON.stringify(ctx.graphs, null, 2),
    ``,
    ...(ctx.graphsHeldBack > 0
      ? [
          `${ctx.graphsHeldBack} more active batches are held back this run to`,
          `bound the call; their statements are listed below so you do not`,
          `recreate them. The next run gets their graphs.`,
          ``,
        ]
      : []),
    `EVERY ACTIVE BATCH STATEMENT (including any held back above). Do not`,
    `create a new batch whose statement duplicates one of these:`,
    ...ctx.activeStatements.map((s) => `- ${s}`),
    ``,
    `A batch with "frozen": true has been touched by Tom and is OFF LIMITS:`,
    `never output its id and never archive it.`,
    ``,
    `TODOS NOT IN ANY BATCH — your candidate GOALS (JSON; each: id, statement,`,
    `brief, category, dueAt — dueAt is epoch ms or null; brief is clipped):`,
    JSON.stringify(ctx.candidates, null, 2),
    ``,
    ...(ctx.candidatesHeldBack > 0
      ? [
          `${ctx.candidatesHeldBack} more unbatched todos are held back this`,
          `run to bound the call. Work with what you see; the next run gets`,
          `the rest.`,
          ``,
        ]
      : []),
    `OPEN CODE TODOS in Tom's repos, with prepared briefs (JSON; each: repo,`,
    `externalId, statement). CONTEXT ONLY — these are entries in repo todo`,
    `files, not todo rows, so they cannot be bound as goals. Use them to know`,
    `what work exists when you write tasks and explanations:`,
    JSON.stringify(ctx.code, null, 2),
    ``,
    ...(ctx.archivedStatements.length > 0
      ? [
          `ARCHIVED AND FINISHED BATCH STATEMENTS — groupings that were`,
          `retired. Do NOT recreate an equivalent grouping under a new name:`,
          ...ctx.archivedStatements.map((s) => `- ${s}`),
          ``,
        ]
      : []),
    ...(ctx.repairs.length > 0
      ? [
          `PLAN REPAIRS. A worker reached one of these tasks and found the`,
          `graph WRONG — an edge that was not a real prerequisite, or a missing`,
          `one that blocked it. These are instructions to FIX THE STRUCTURE,`,
          `not commentary to note:`,
          ...ctx.repairs.map((r) => `- ${r}`),
          ``,
        ]
      : []),
    ...(ctx.revises.length > 0
      ? [
          `Tom ruled "revise" on these batches — each sentence redirects the`,
          `re-planning and overrides any other reading of the inputs:`,
          ...ctx.revises.map((r) => `- batch "${r.statement}": ${r.sentence}`),
          ``,
        ]
      : []),
    ...(ctx.notes.length > 0
      ? [
          `NOTES TOM WROTE WITH HIS APPROVE AND SESSION RULINGS. These are`,
          `steering context about what he wants, not instructions to re-plan a`,
          `specific batch and not items to act on:`,
          ...ctx.notes.map((n) => `- [${n.verdict}] ${n.subject}: ${n.sentence}`),
          ``,
        ]
      : []),
    `TOM'S RECENT RULINGS, newest first (behavioral evidence: what he`,
    `approves, revises, sends to a session, archives — use it to infer what he`,
    `cares about, not as items to act on):`,
    JSON.stringify(ctx.recentRulings, null, 2),
  ].join("\n");
}

/**
 * The plan pass: one Claude call for every graph this run, one pen call per
 * batch. `context` is the /tts/batch-context payload (its todos possibly
 * already annotated by the prepare pass), `pending` the rulings feed. Same
 * `io` contract as the prepare pass.
 */
export async function planGraphs(context, pending, io) {
  const { todos, mirror, briefs, recentRulings, batches, planRepairs } = context;

  const all = Array.isArray(todos) ? todos : [];
  const batchRows = Array.isArray(batches) ? batches : [];
  const writingStandard = context.writingStandard;
  const vocabulary = context.vocabulary;
  const sessionRepos = context.sessionRepos;

  const activeBatches = batchRows.filter((b) => b.status === "active");
  const archivedStatements = batchRows
    .filter((b) => b.status === "archived" || b.status === "done")
    .map((b) => b.statement);
  const activeStatements = activeBatches.map((b) => b.statement);

  // Pending revise rulings ON BATCHES only. A revise on a plain life todo
  // belongs to the prepare pass above, which reads the same feed and consumes
  // only its own kind.
  const batchById = new Map(activeBatches.map((b) => [b._id, b]));
  const revises = [];
  for (const r of Array.isArray(pending) ? pending : []) {
    if (r.subjectType !== "batch" || r.verdict !== "revise" || !r.batchId) {
      continue;
    }
    const batch = batchById.get(r.batchId);
    if (batch) {
      revises.push({
        ruling: r,
        batchId: batch._id,
        statement: batch.statement,
        sentence: r.sentence ?? "",
      });
    }
  }

  // Notes Tom wrote with his APPROVE and SESSION verdicts: standing steering
  // context, never consumed. ARCHIVE sentences are excluded on purpose — an
  // archive note is the UNARCHIVE CONDITION for one retired item, not
  // steering about what to plan.
  const recent = Array.isArray(recentRulings) ? recentRulings : [];
  const statementOfSubject = (r) => {
    if (r.subjectType === "batch") {
      return `batch "${batchById.get(r.batchId)?.statement ?? r.batchId}"`;
    }
    if (r.subjectType === "life") {
      return `todo "${all.find((t) => t._id === r.todoId)?.statement ?? r.todoId}"`;
    }
    return `code ${r.repo} ${r.externalId}`;
  };
  const notes = recent
    .filter(
      (r) =>
        (r.verdict === "approve" || r.verdict === "session") &&
        (r.sentence ?? "").trim() !== "",
    )
    .slice(0, NOTE_MAX)
    .map((r) => ({
      verdict: r.verdict,
      subject: statementOfSubject(r),
      sentence: r.sentence.trim(),
    }));

  // Plan repairs, newest first, rendered as one line each. The event's `data`
  // is worker-written and its exact shape belongs to the worker, so read it
  // defensively: name the task if the event names one, and pass the report
  // through as text either way.
  // Each carries the event id and the batch the reported task lives in, so a
  // repair can be CONSUMED once the batch it is about has been re-planned. A
  // repair is an instruction, not a record: left unconsumed the same "fix this
  // edge" is re-asserted every run for a week, long after the edge is gone.
  const repairRows = (Array.isArray(planRepairs) ? planRepairs : []).map((e) => {
    const data = e?.data ?? {};
    const todo = all.find((t) => t._id === (e.todoId ?? data.todoId));
    const subject = todo?.statement ?? data.statement ?? "an unnamed task";
    const report =
      typeof data === "string"
        ? data
        : (data.report ?? data.finding ?? data.note ?? JSON.stringify(data));
    return {
      id: e._id,
      batchId: todo?.batchId ?? null,
      line: `task "${subject}": ${report}`,
    };
  });
  const repairs = repairRows.map((r) => r.line);

  // Existing graphs, most-recently-updated first, bounded. Compact
  // projections — exactly the fields the planner reasons over.
  const contentsByBatch = new Map();
  for (const todo of all) {
    if (todo.batchId === undefined || todo.batchId === null) continue;
    if (!contentsByBatch.has(todo.batchId)) contentsByBatch.set(todo.batchId, []);
    contentsByBatch.get(todo.batchId).push(todo);
  }
  // STALEST FIRST. A stored batch's updatedAt moves when a run lands changes,
  // so recency-first re-showed the same freshly-planned batches every run and
  // the tail never entered the slice — the de-chain sweep starved. Stalest
  // first makes the slice a rotation: every landed update sends that batch to
  // the back of the line and the least-recently-planned graph is always next.
  const graphsOrdered = [...activeBatches].sort(
    (a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0),
  );
  const graphsHeldBack = Math.max(0, graphsOrdered.length - MAX_GRAPHS_PER_RUN);
  const graphs = graphsOrdered.slice(0, MAX_GRAPHS_PER_RUN).map((b) => {
    const contents = contentsByBatch.get(b._id) ?? [];
    return {
      id: b._id,
      statement: b.statement,
      // Preview, not the value. A batch explanation is now a whole HTML
      // document; pasting twenty of them into one prompt is what blew the
      // completion timeout on the life slice, and the planner never needs the
      // markup back — PRESERVE BY OMISSION keeps a document it does not
      // rewrite, and a document it does rewrite it writes from scratch.
      groundUpExplanationPreview: explanationPreview(
        b.groundUpExplanation,
        MAX_BATCH_PREVIEW_CHARS,
      ),
      needs: b.needs ?? [],
      // null = never declared (omitting "repos" preserves that); [] = declared
      // as needing no checkout. The planner has to be able to tell them apart.
      repos: b.repos ?? null,
      frozen: b.tomTouchedAt !== undefined,
      tasks: contents
        .filter((t) => t.kind !== "goal")
        .map((t) => ({
          id: t._id,
          statement: t.statement,
          actor: t.actor ?? null,
          status: t.status,
          needs: t.needs ?? [],
          condition: t.condition ?? null,
          evidence: t.evidence ?? null,
          model: t.model ?? null,
          groundUpExplanationPreview: explanationPreview(
            t.groundUpExplanation,
            MAX_PREVIEW_CHARS,
          ),
        })),
      goals: contents
        .filter((t) => t.kind === "goal")
        .map((t) => ({
          id: t._id,
          statement: t.statement,
          condition: t.condition ?? null,
          mustNotBreak: t.mustNotBreak ?? null,
          status: t.status,
          codeRepo: t.codeRepo ?? null,
          codeExternalId: t.codeExternalId ?? null,
        })),
    };
  });

  // Goal candidates: active todos in no batch at all. A row already inside a
  // batch is owned by it — the server refuses a cross-batch claim, so offering
  // one here would only buy a dropped batch and a wasted Claude call.
  const candidatesEligible = all
    .filter(
      (t) =>
        t.status === "active" &&
        (t.batchId === undefined || t.batchId === null),
    )
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const candidatesHeldBack = Math.max(
    0,
    candidatesEligible.length - MAX_LIFE_PER_RUN,
  );
  const candidates = candidatesEligible.slice(0, MAX_LIFE_PER_RUN).map((t) => ({
    id: t._id,
    statement: t.statement,
    brief: clip(t.brief, MAX_BRIEF_CHARS),
    category: t.category ?? null,
    dueAt: t.dueAt ?? null,
  }));

  const briefByKey = new Map(
    (Array.isArray(briefs) ? briefs : []).map((b) => [
      `${b.repo} ${b.externalId}`,
      b,
    ]),
  );
  const code = (Array.isArray(mirror) ? mirror : [])
    .flatMap((m) => {
      const brief = briefByKey.get(`${m.repo} ${m.externalId}`);
      if (m.status !== "open" || !brief) return [];
      return [
        {
          repo: m.repo,
          externalId: m.externalId,
          statement: m.statement,
        },
      ];
    })
    .slice(0, MAX_CODE_TODOS);

  if (graphs.length === 0 && candidates.length === 0) {
    return { ran: false }; // no graphs to maintain and nothing to build one from
  }

  // --- Input hash: skip the Claude call when nothing changed ----------------
  // The hash covers everything the model sees; a pending batch-revise forces a
  // run regardless (the sentence must be consumed even if re-ruled
  // identically). The cursor file is harmless to lose — one wasted run.
  const reviseSentences = revises.map((r) => r.sentence);
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        promptVersion: PROMPT_VERSION,
        graphs,
        activeStatements,
        candidates,
        code,
        archivedStatements,
        repairs,
        reviseSentences,
        notes,
        writingStandard,
        vocabulary,
        sessionRepos,
      }),
    )
    .digest("hex");
  const storedHash = io.readHash();
  if (inputHash === storedHash && revises.length === 0) return { ran: false }; // quiet when idle

  // --- One Claude call for every graph this run ----------------------------
  console.log(
    `[plan-graphs] ${graphs.length} graph(s) (${graphsHeldBack} held back), ` +
      `${candidates.length} goal candidate(s) (${candidatesHeldBack} held back), ` +
      `${repairs.length} plan repair(s), ${revises.length} revise ruling(s) — asking Claude…`,
  );
  const answer = io.runClaude(
    graphPrompt({
      writingStandard,
      vocabulary,
      sessionRepos,
      graphs,
      graphsHeldBack,
      activeStatements,
      candidates,
      candidatesHeldBack,
      code,
      archivedStatements,
      repairs,
      revises,
      notes,
      recentRulings: recent.map((r) => ({
        subjectType: r.subjectType,
        todoId: r.todoId ?? null,
        batchId: r.batchId ?? null,
        repo: r.repo ?? null,
        externalId: r.externalId ?? null,
        verdict: r.verdict,
        sentence: r.sentence ?? null,
        ruledAt: r.ruledAt,
      })),
    }),
    { timeoutMs: CLAUDE_TIMEOUT_MS },
  );
  const parsed = extractJsonObject(answer);
  if (!Array.isArray(parsed.batches)) {
    throw new Error(
      `bad shape (no batches array): ${JSON.stringify(parsed).slice(0, 120)}`,
    );
  }

  // --- Ship it, ONE BATCH PER CALL -----------------------------------------
  // The pen takes one batch's graph at a time, so a batch the server refuses
  // costs only itself: the rest of the run still lands. `served` records the
  // BATCH IDS that actually stored, which is what decides whether a revise
  // ruling and a plan repair are consumed below.
  const totals = {
    created: 0,
    updated: 0,
    unchanged: 0,
    goalsBound: 0,
    retired: 0,
    archived: 0,
  };
  const served = new Set();
  let failed = 0;
  for (const batch of parsed.batches) {
    let statement =
      typeof batch?.statement === "string" ? batch.statement.trim() : "";
    // PRESERVE BY OMISSION vs. a REQUIRED field. The prompt tells the planner
    // that any field it leaves out keeps the stored value, so on a batch it is
    // only re-planning the tasks of, omitting `statement` is exactly what that
    // rule asks for — but the pen's `statement` is required (v.string()), so
    // the whole graph was being dropped here instead. On 2026-08-29 that cost
    // one entire run: 8 batches emitted, 8 dropped, 0 stored. When the model
    // named the batch by id, the stored statement IS the preserved value, so
    // fill it in and ship the graph. Only a batch that is both nameless and
    // unidentifiable is genuinely unusable.
    if (statement === "" && typeof batch?.batchId === "string") {
      const known = batchById.get(batch.batchId);
      if (known) {
        statement = known.statement;
        batch.statement = known.statement;
      }
    }
    if (statement === "") {
      console.log(
        `[plan-graphs] dropped a batch with no statement and no known id ` +
          `(batchId: ${JSON.stringify(batch?.batchId ?? null)}, ` +
          `${Array.isArray(batch?.tasks) ? batch.tasks.length : 0} task(s))`,
      );
      failed++;
      continue;
    }
    let result;
    try {
      result = await io.post("/tts/plan-graph", batch);
    } catch (err) {
      // One batch refused is one batch lost, not a failed run — its revise
      // ruling (if any) stays pending and the next run retries it.
      console.error(`[plan-graphs] "${statement}" FAILED: ${err.message}`);
      failed++;
      continue;
    }
    for (const key of Object.keys(totals)) totals[key] += result[key] ?? 0;
    const skipped = result.skipped ?? [];
    // Whether the batch's graph stored is the SERVER'S statement (batchStored),
    // not something inferred from the skip report: a task's skip carries the
    // task's statement as its ref, so a task whose statement happens to equal
    // the batch's read as a refused batch and silently cost Tom his ruling.
    if (result.batchStored && result.batchId) served.add(result.batchId);
    console.log(
      `[plan-graphs] "${statement}": ${result.created} created, ` +
        `${result.updated} updated, ${result.unchanged} unchanged, ` +
        `${result.goalsBound} goal(s) bound, ${result.retired ?? 0} retired, ` +
        `${result.archived} archived, ${skipped.length} skipped`,
    );
    for (const s of skipped) {
      console.log(`[plan-graphs] skipped ${s.ref}: ${s.why}`);
    }
    for (const d of result.droppedTasks ?? []) {
      console.log(
        `[plan-graphs] dropped task ${d.index} ("${d.statement}"): ${d.why}`,
      );
    }
  }
  console.log(
    `[plan-graphs] totals: ${totals.created} created, ${totals.updated} updated, ` +
      `${totals.unchanged} unchanged, ${totals.goalsBound} goal(s) bound, ` +
      `${totals.retired} retired, ${totals.archived} archived, ` +
      `${failed} batch(es) lost`,
  );

  // Consume the plan repairs this run actually answered: the ones whose task
  // lives in a batch that stored, plus the ones whose task can no longer be
  // found at all (nothing will ever be able to act on those, and re-asserting
  // them for a week only invites the planner to restructure something else).
  // A repair about a batch that was held back or refused stays unconsumed and
  // is shown again next run — the same discipline as a revise ruling.
  const consumable = repairRows
    .filter((r) => r.batchId === null || served.has(r.batchId))
    .map((r) => r.id)
    .filter((id) => typeof id === "string");
  if (consumable.length > 0) {
    await io.post("/tts/plan-repairs-consumed", { ids: consumable });
    console.log(`[plan-graphs] consumed ${consumable.length} plan repair(s)`);
  }

  // Consume a batch-revise ruling ONLY when its re-plan actually landed. The
  // server DROPS what fails validation instead of rejecting the call, so a
  // skipped batch means Tom's sentence was never served: consuming the ruling
  // there would retire it silently and the graph would stay wrong. Left
  // pending, it forces the next run (the hash check is bypassed while a revise
  // is pending) to try again.
  for (const r of revises) {
    // Keyed by BATCH ID, not by statement: the whole point of many a revise
    // sentence is a rename ("call this batch something clearer"), and the
    // planner then stores the batch under a new statement. Keying on the
    // stored statement leaves such a ruling pending forever — and a pending
    // revise bypasses the input-hash short-circuit, so the job would make a
    // full Claude call every run forever, re-applying an instruction that
    // already landed. The server always returns the batch id.
    if (!served.has(r.batchId)) {
      console.log(
        `[plan-graphs] revise ruling for "${r.statement}" left pending: ` +
          `the re-planned batch did not store`,
      );
      continue;
    }
    await io.post("/tts/ruling-applied", {
      id: r.ruling._id,
      result: "revised: graph re-planned",
    });
  }

  // Hash written LAST (Convex-first durability ordering): a crash anywhere
  // above leaves no cursor, so the next cron run simply redoes the work.
  //
  // AND NOT AT ALL WHEN THE RUN STORED NOTHING while losing batches. The
  // cursor's promise is "these inputs have been planned"; a run whose every
  // batch was refused planned none of them, and writing the cursor there is
  // what turns one bad completion into silence — the next run sees the same
  // hash and returns immediately, so the graphs stay unplanned until some
  // unrelated todo changes the inputs. Seen 2026-08-29 (8 emitted, 8 lost).
  if (served.size === 0 && failed > 0) {
    console.log(
      `[plan-graphs] cursor NOT advanced: ${failed} batch(es) lost and none ` +
        `stored — the next run retries these same inputs`,
    );
    return { ran: true, totals, failed };
  }
  io.writeHash(inputHash);
  return { ran: true, totals, failed };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const force = process.argv.includes("--force");
  const env = loadEnv();
  const io = {
    runClaude,
    post: (path, body) => convexFetch(env, path, body),
    readHash: () => {
      try {
        return fs.readFileSync(HASH_PATH, "utf8").trim();
      } catch {
        return null; // no cursor yet — first run, or the Jarvis Box was rebuilt
      }
    },
    writeHash: (hash) => fs.writeFileSync(HASH_PATH, hash + "\n"),
  };

  // --- Gather context (one read each; both passes work from these) ----------
  const context = await convexFetch(env, "/tts/batch-context");
  const { pending } = await convexFetch(env, "/tts/rulings");

  // The writing standard is the published write + know prelude. It rides this
  // payload because this file is Node ESM on the Jarvis Box, which never
  // loads TypeScript and holds no WikiTom checkout. A run without it would
  // quietly produce prose written to no standard at all, which is worse than
  // not running — so it is fatal, for both passes.
  if (typeof context.writingStandard !== "string" || context.writingStandard.trim() === "") {
    throw new Error("model-of-tom layer write is not stored");
  }
  if (typeof context.vocabulary !== "string" || context.vocabulary.trim() === "") {
    throw new Error("batch-context vocabulary is missing");
  }
  // The repo names a batch may declare, from the one home (convex/ttsShared.ts)
  // via the payload — same reason writingStandard rides it. Fatal if missing
  // for the same reason too: a planner guessing repo names would declare ones
  // the daemon cannot clone, and every session on that batch would die on its
  // first turn.
  if (!Array.isArray(context.sessionRepos) || context.sessionRepos.length === 0) {
    throw new Error(
      "/tts/batch-context returned no sessionRepos — refusing to let the " +
        "planner guess which repositories exist",
    );
  }
  // The New York calendar date, for resolving "sept 3" in a statement. The
  // server owns the clock (the /tts/state convention); the planner repeats it
  // back and never computes a day of its own.
  if (typeof context.nyCalendarDay !== "string") {
    throw new Error("/tts/batch-context returned no nyCalendarDay");
  }

  let failures = 0;

  // --- Pass 1: prepare ------------------------------------------------------
  // A failure inside the pass is per-item and counted; a failure of the pass
  // itself (the feed unreadable, say) is logged and the plan pass still runs —
  // the two passes share reads, not fates.
  try {
    const result = await prepareLifeTodos(
      {
        todos: context.todos,
        pending,
        today: context.nyCalendarDay,
        writingStandard: context.writingStandard,
        force,
      },
      io,
    );
    failures += result.failed;
  } catch (err) {
    failures++;
    console.error(`[plan-graphs] prepare pass FAILED: ${err.message}`);
  }

  // --- Pass 2: brief --------------------------------------------------------
  // The CMT checkout is refreshed only when the pass runs at all: without
  // GH_TOKEN there is no clone to read, and a planner that cannot brief still
  // prepares and plans — one line says which half is standing down.
  if (!env.GH_TOKEN) {
    console.log("[plan-graphs] brief: GH_TOKEN missing in worker.env — skipping");
  } else {
    try {
      const dir = cmtRepoDir(env);
      const todosFile = path.join(dir, TODOS_PATH);
      const parsed = yamlToJson(todosFile);
      if (!Array.isArray(parsed)) throw new Error(`${TODOS_PATH} did not parse to a list`);
      // Open = no `closed` field. (The file also keeps closed entries below a
      // banner comment, but the field is the machine-readable truth — the
      // banner is for humans and the guard test enforces the pairing.)
      const entries = parsed.filter(
        (e) => e && typeof e === "object" && !("closed" in e),
      );
      const result = await briefCodeTodos(
        {
          repo: { dir, todosText: fs.readFileSync(todosFile, "utf8"), entries },
          pending,
          writingStandard: context.writingStandard,
          force,
        },
        { ...io, readHashes: readBriefHashes, writeHashes: writeBriefHashes },
      );
      failures += result.failed;
    } catch (err) {
      failures++;
      console.error(`[plan-graphs] brief pass FAILED: ${err.message}`);
    }
  }

  // --- Pass 3: plan ---------------------------------------------------------
  try {
    const result = await planGraphs(context, pending, io);
    if (result.ran) failures += result.failed;
  } catch (err) {
    failures++;
    console.error(`[plan-graphs] plan pass FAILED: ${err.message}`);
  }

  if (failures > 0) process.exitCode = 1;
}

// Run ONLY when node was pointed at this file — the guard every job with
// tested pure halves carries, so a test that imports the passes above does
// not fire the job.
const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[plan-graphs] FAILED: ${err.message}`);
    process.exit(1);
  });
}
