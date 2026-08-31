#!/usr/bin/env node
// plan-graphs.mjs — THE PLANNER. Maintains the graph inside every batch via
// headless Claude.
//
// Run by cron every 2 hours at :07 UTC (see /etc/cron.d/tts, where it replaces
// form-batches.mjs at cutover). Manual run:
//   node /opt/tts/plan-graphs.mjs
//
// WHAT A BATCH IS NOW (schema v2, ratified 2026-08-29). A batch is NOT a todo.
// It is its own row, and it holds one thing: HOW a set of todos gets
// completed. Its contents are todos pointing back at it, in two kinds:
//   goal — a state of the world the batch is FOR, checkable by a condition
//          ("the lease is signed"). Goals are the todos Tom already had; the
//          batch is the machinery for reaching them.
//   task — a piece of work someone does. Tasks are what this job writes.
// Tasks and goals are wired by `needs`: a todo is READY when every id in its
// needs is done (archived counts as done — a need that was set aside is not
// going to happen, and leaving it blocking would strand the graph forever).
// Batches are sequenced by a named `path`: each batch sits at an `index` on
// it, and its `edge` describes the link to the previous batch — "must" (that
// one has to land first) or "helps" (it only makes this easier).
//
// THE JOB'S ONE RESPONSIBILITY: for each batch, propose the graph. It executes
// nothing and rules on nothing. Every gate lives on the server
// (tts.internalStorePlanGraph): a Tom-touched batch is frozen and never
// rewritten, a task that fails validation is DROPPED with a named reason while
// the rest of the graph still lands, cycles are dropped, and the per-batch
// skip report comes back here to be logged.
//
// GROUND-UP EXPLANATIONS ARE HTML DOCUMENTS (Tom, 2026-08-29: rendered as
// prose they are "an incomprehensible wall of text"). Every explanation this
// job writes — the batch's and each task's — is a complete self-contained HTML
// page, which the /tts page shows fullscreen in a sandboxed, script-less
// iframe. The form is specified once, in the writing standard that rides in on
// /tts/batch-context; the prompt below only names the requirement and the
// palette. Stored explanations come back into the prompt as extracted-text
// PREVIEWS, never as markup.
//
// SUCCESSOR TO form-batches.mjs. That job groups todos into v1 batches (a
// dtsTodos row carrying `members`); this one maintains v2 graphs. They run
// side by side until cutover, and they cannot collide: the server refuses a v1
// batch that claims a row already inside a v2 batch, and the two consume
// different ruling feeds (form-batches takes `life` revise rulings whose
// subject is a members-bearing todo; this job takes `batch` revise rulings,
// which only exist in v2).
//
// REVISE RULINGS: Tom can rule "revise" on a batch with one written sentence.
// This job embeds those sentences in the prompt (they override any other
// reading of the inputs) and consumes each via /tts/ruling-applied only once
// the server reports that batch as stored — a skipped batch leaves its ruling
// pending, so the next run tries again on the same sentence.
//
// PLAN REPAIRS: a worker that reached a task and found the graph wrong (an
// edge that is not a real prerequisite, a missing one that blocked it) records
// a "plan-repair" event. That is the only channel by which doing the work
// corrects the planning of it, so those reports are injected as instructions
// to FIX THE STRUCTURE, not as commentary. Like a revise ruling they are
// CONSUMED once the batch they are about has been re-planned
// (/tts/plan-repairs-consumed): an instruction re-asserted every two hours
// after it has been carried out is an instruction to change something else.
//
// NO-STATE RULE: Convex is read and written each run. The only local file is
// the input-hash cursor in /var/lib/tts/ — losing it merely costs one extra
// Claude invocation on inputs that had not changed.

import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  loadEnv,
  convexFetch,
  runClaude,
  extractJsonObject,
  identifierTypeOf,
} from "./tts-lib.mjs";

const HASH_PATH = "/var/lib/tts/plan-input-hash";
// Bump when the prompt changes semantics: it joins the input hash, so a new
// prompt re-plans even inputs that have not changed.
const PROMPT_VERSION = 2;
const CLAUDE_TIMEOUT_MS = 20 * 60 * 1000;

// One run offers at most this many unbatched life todos as goal candidates
// (oldest first) and clips each brief. An unbounded offer sank real
// form-batches runs: at 122+ todos with full briefs the single completion blew
// the timeout three runs in a row (2026-08-29). The 2-hourly cron drains any
// backlog in slices — todos placed in a batch this run drop out of the next
// run's offer.
const MAX_LIFE_PER_RUN = 80;
const MAX_BRIEF_CHARS = 400;
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

function clip(text, max) {
  if (typeof text !== "string" || text === "") return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

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

function prompt(ctx) {
  return [
    `You are the PLANNER for TTS, Tom's todo system. Your job is to maintain`,
    `the GRAPH inside each batch. You propose structure; Tom rules. Nothing`,
    `you output executes anything.`,
    ``,
    `THE VOCABULARY IS FIXED. Use these words and only these words for these`,
    `things — do not invent synonyms, and do not coin new names for anything:`,
    `- batch — a row holding HOW a set of todos gets completed. It is not a`,
    `  todo. It contains todos of two kinds.`,
    `- goal — a todo that is a state of the world the batch is FOR, checkable`,
    `  by a condition ("the lease is signed"). Goals are the todos Tom already`,
    `  had; they are the reason the batch exists. You bind existing todos as`,
    `  goals; you never invent one.`,
    `- task — a todo that is a piece of work someone does. Tasks are what you`,
    `  write.`,
    `- needs — the dependency edges. A todo lists the ids of the todos that`,
    `  must be finished before it can start.`,
    `- ready — a todo is ready when it is active and every todo in its needs is`,
    `  done. That set is the frontier: the work that can start right now.`,
    `- path — the sequence BETWEEN batches. A batch sits at an index on a named`,
    `  path, and its edge to the previous batch is either "must" (that batch`,
    `  has to land first) or "helps" (it only makes this one easier).`,
    `- repos — the repositories a batch's work lives in, DECLARED by you on`,
    `  the batch. Every session TTS opens for this batch or for a task inside`,
    `  it checks out exactly this set, so a batch whose work touches two`,
    `  repositories declares both and gets one session holding both checkouts.`,
    `  The only legal names are ${ctx.sessionRepos.join(", ")}; a batch whose`,
    `  work needs no repository declares [].`,
    `- display text — the short line always on screen (a statement).`,
    `- ground-up explanation — the self-contained layer behind a "more"`,
    `  control. It is a COMPLETE HTML DOCUMENT, rendered fullscreen; the`,
    `  writing standard below gives its exact form.`,
    ``,
    ctx.writingStandard,
    ``,
    `EXISTING BATCHES WITH THEIR GRAPHS (JSON). Each: id, statement,`,
    `groundUpExplanationPreview, path, repos, frozen, tasks, goals. A task`,
    `carries id,`,
    `statement, actor, status, needs, condition, evidence, model, and its own`,
    `groundUpExplanationPreview. EVERY "...Preview" value is readable text`,
    `EXTRACTED from a stored HTML document and then CLIPPED — it is there so`,
    `you know what an explanation already covers, it is not the document, and`,
    `it must never be copied into your output:`,
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
    `externalId, statement). CONTEXT ONLY — these are entries in`,
    `repo todo files, not todo rows, so they cannot be bound as goals. Use them`,
    `to know what work exists when you write tasks and explanations:`,
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
    ``,
    `TASK — output the batches whose graphs you are writing this run. Rules:`,
    ``,
    `EVERY BATCH CARRIES A PATH — no exceptions. Paths are the independent`,
    `lanes of work; keep the set of path names SMALL and STABLE (reuse the`,
    `names already on existing batches before inventing one), give each batch`,
    `its index in its lane, and mark its edge to the previous batch "must"`,
    `(has to land first) or "helps" (only makes this one easier). A batch`,
    `without a path renders in an "unpathed" bucket Tom has told us he does`,
    `not want to live in.`,
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
    `MODEL. Workers run on Opus by default and you write nothing for that. Add`,
    `"model": "fable" to a task ONLY when its difficulty genuinely warrants the`,
    `stronger model — novel design, a subtle correctness argument, deep`,
    `unfamiliar code. Mechanical or well-specified work does not.`,
    ``,
    `WRITING. Every "statement" is display text: short, names the thing, no`,
    `explanation. Every "groundUpExplanation" obeys the WRITING STANDARD`,
    `above, in full — which means it is a COMPLETE, SELF-CONTAINED HTML`,
    `DOCUMENT, from "<!DOCTYPE html>" to "</html>", carrying its own inline`,
    `<style> and nothing external: no script, no event handler, no stylesheet,`,
    `font, image, or URL loaded from anywhere. It renders fullscreen in a`,
    `sandbox with no scripting and no network, so anything external is a hole`,
    `in the page. Palette #0a0e17 background, #e2e8f0 text, #94a3b8 secondary,`,
    `#e8a040 accent, #1e293b borders; ~15px body type, real <h1>/<h2>`,
    `headings, short sections, a <table> for enumerable facts, and bordered`,
    `<div> boxes with → or ↓ arrows where a shape helps. Write the whole`,
    `document as the JSON string value, escaped as JSON requires.`,
    ``,
    `WRITE AN EXPLANATION ONLY WHEN YOU MEAN TO REPLACE ONE. A batch or task`,
    `whose explanation is already right keeps it by OMISSION — leave the field`,
    `out. When you do include it, you are writing the entire document fresh;`,
    `there is no way to amend one, and a fragment overwrites a whole page.`,
    ``,
    `EVERY NEW TASK AND EVERY NEW BATCH GETS ONE. Tom rules from that document`,
    `and nothing else, so it must stand alone: what this is, why it exists,`,
    `what each term in the statement means, where it stands now, what happens`,
    `next and who does it, and — for a task whose actor is "tom" — exactly`,
    `what he is deciding, as the numbered decision list the standard`,
    `describes.`,
    ``,
    `ARCHIVE. Set "archive": true on a batch whose goals are all reached or`,
    `abandoned. Never on a frozen one.`,
    ``,
    `Answer ONLY a JSON object, no prose, no code fences. Both`,
    `"groundUpExplanation" fields hold a whole HTML document as one JSON`,
    `string (shown here abbreviated):`,
    `{"batches": [{"batchId": "...", "statement": "...",`,
    ` "groundUpExplanation": "<!DOCTYPE html><html><head><style>…</style>`,
    `</head><body>…</body></html>",`,
    ` "path": {"name": "...", "index": 0, "edge": "must"},`,
    ` "repos": ["tom.quest"],`,
    ` "tasks": [{"id": "...", "statement": "...", "actor": "agent",`,
    `            "needs": ["<todo id>", 0], "condition": "...",`,
    `            "groundUpExplanation": "<!DOCTYPE html>…</html>",`,
    `            "status": "active", "model": "fable"}],`,
    ` "goalIds": ["..."], "archive": false}]}`,
  ].join("\n");
}

async function main() {
  const env = loadEnv();

  // --- Gather context ------------------------------------------------------
  const context = await convexFetch(env, "/tts/batch-context");
  const { todos, mirror, briefs, recentRulings, batches, planRepairs } = context;
  const { pending } = await convexFetch(env, "/tts/rulings");

  const all = Array.isArray(todos) ? todos : [];
  const batchRows = Array.isArray(batches) ? batches : [];
  // The writing standard is the WikiTom skill model-of-tom/skills/writing-to-tom
  // (synced into Convex; convex/ttsShared.ts WRITING_STANDARD is the fallback
  // copy), and it rides this payload because this file is Node ESM on the
  // Jarvis Box, which never loads TypeScript and holds no WikiTom checkout. A run without it
  // would quietly produce prose written to no standard at all, which is worse
  // than not running — so it is fatal.
  const writingStandard = context.writingStandard;
  if (typeof writingStandard !== "string" || writingStandard.trim() === "") {
    throw new Error(
      "/tts/batch-context returned no writingStandard — the server half of the " +
        "one-home rule is missing; refusing to write prose to no standard",
    );
  }

  // The repo names a batch may declare, from the one home (convex/ttsShared.ts)
  // via the payload — same reason writingStandard rides it. Fatal if missing
  // for the same reason too: a planner guessing repo names would declare ones
  // the daemon cannot clone, and every session on that batch would die on its
  // first turn.
  const sessionRepos = context.sessionRepos;
  if (!Array.isArray(sessionRepos) || sessionRepos.length === 0) {
    throw new Error(
      "/tts/batch-context returned no sessionRepos — refusing to let the " +
        "planner guess which repositories exist",
    );
  }

  const activeBatches = batchRows.filter((b) => b.status === "active");
  const archivedStatements = batchRows
    .filter((b) => b.status === "archived" || b.status === "done")
    .map((b) => b.statement);
  const activeStatements = activeBatches.map((b) => b.statement);

  // Pending revise rulings ON BATCHES only. A revise on a plain life todo
  // belongs to prepare-life-todos.mjs, and a revise on a v1 batch (a
  // members-bearing todo, identifierType "life") belongs to form-batches.mjs —
  // both read the same feed, and each consumes only its own kind.
  const batchById = new Map(activeBatches.map((b) => [b._id, b]));
  const revises = [];
  for (const r of Array.isArray(pending) ? pending : []) {
    if (identifierTypeOf(r) !== "batch" || r.verdict !== "revise" || !r.batchId) {
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
    if (identifierTypeOf(r) === "batch") {
      return `batch "${batchById.get(r.batchId)?.statement ?? r.batchId}"`;
    }
    if (identifierTypeOf(r) === "life") {
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
      path: b.path ?? null,
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
          status: t.status,
          codeRepo: t.codeRepo ?? null,
          codeExternalId: t.codeExternalId ?? null,
        })),
    };
  });

  // Goal candidates: active todos in no batch at all. A row already inside a
  // v2 batch is owned by it, and a row inside a v1 batch (offered as a
  // `members` entry) is claimed too — the server refuses a cross-batch claim
  // either way, so offering one here would only buy a dropped batch and a
  // wasted Claude call.
  const v1Claimed = new Set(
    all
      .filter((t) => Array.isArray(t.members) && t.status !== "archived" && t.status !== "done")
      .flatMap((t) => t.members.filter((m) => m.todoId).map((m) => m.todoId)),
  );
  const candidatesEligible = all
    .filter(
      (t) =>
        t.status === "active" &&
        t.members === undefined &&
        (t.batchId === undefined || t.batchId === null) &&
        !v1Claimed.has(t._id),
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
    return; // no graphs to maintain and nothing to build one from
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
        sessionRepos,
      }),
    )
    .digest("hex");
  let storedHash = null;
  try {
    storedHash = fs.readFileSync(HASH_PATH, "utf8").trim();
  } catch {
    // no cursor yet — first run, or the Jarvis Box was rebuilt
  }
  if (inputHash === storedHash && revises.length === 0) return; // quiet when idle

  // --- One Claude call for every graph this run ----------------------------
  console.log(
    `[plan-graphs] ${graphs.length} graph(s) (${graphsHeldBack} held back), ` +
      `${candidates.length} goal candidate(s) (${candidatesHeldBack} held back), ` +
      `${repairs.length} plan repair(s), ${revises.length} revise ruling(s) — asking Claude…`,
  );
  const answer = runClaude(
    prompt({
      writingStandard,
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
        identifierType: identifierTypeOf(r),
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
      result = await convexFetch(env, "/tts/plan-graph", batch);
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
    await convexFetch(env, "/tts/plan-repairs-consumed", { ids: consumable });
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
    // full Claude call every two hours forever, re-applying an instruction
    // that already landed. The server always returns the batch id.
    if (!served.has(r.batchId)) {
      console.log(
        `[plan-graphs] revise ruling for "${r.statement}" left pending: ` +
          `the re-planned batch did not store`,
      );
      continue;
    }
    await convexFetch(env, "/tts/ruling-applied", {
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
    return;
  }
  fs.writeFileSync(HASH_PATH, inputHash + "\n");
}

main().catch((err) => {
  console.error(`[plan-graphs] FAILED: ${err.message}`);
  process.exit(1);
});
