#!/usr/bin/env node
// prepare-life-todos.mjs — advance unprepared LIFE todos toward ready-for-tom.
//
// Run by cron every 2nd hour at :37 (see /etc/cron.d/tts). Manual run:
//   node /opt/tts/prepare-life-todos.mjs [--force]
//
// WHY: a thought Tom dumps into #dump (or a consolidation candidate) lands as
// a raw one-line statement with readiness "unprepared". The TTS principle is
// that volume reaches Tom PRE-CHEWED — the swarm prepares, Tom rules. This is
// the swarm's smallest member: per unprepared life todo, headless Claude
// writes a short ground-up brief, the smallest entry action, and a
// qualitative work description, then advances readiness. It never rewrites
// the statement and never changes status — preparation must not alter intent
// (those are Tom's).
//
// DATES (2026-08-29): the QuickAdd date input is gone from the /dts page, so
// an explicit date now reaches a todo through the words Tom captured. This job
// extracts a date ONLY when the STATEMENT itself states one ("pay rent sept
// 3") — that is Tom's own text, not an agent inventing a date — and only for a
// todo with no date AND no resolved date in its history. The server
// (internalPrepareTodo) enforces the same guard: a first date only, never an
// overwrite and never a resurrection of one Tom already resolved. It also asks
// whose deadline it is ("dateKind"), so an externally imposed date is not
// filed as one Tom chose. Everything vaguer than an explicit date stays
// undated; Tom's time notes are how dates move after that.
//
// readiness after preparation:
//   ready-for-tom  — a self-contained personal task: the only missing thing
//                    is Tom doing/deciding it.
//   preparing      — genuinely needs more agent work (research, drafting)
//                    before Tom's attention is well spent. Still gets the
//                    fields; deeper preparation is a later swarm feature.
//
// REVISE RULINGS: Tom can rule "revise" on a prepared life todo with one
// written sentence that redirects the preparation (the server drops the
// todo's readiness back to "preparing" when he does). This job reads the
// unified rulings feed at /tts/rulings, takes the LIFE rows with verdict
// "revise", re-prepares each such todo with Tom's sentence embedded in the
// prompt, and POSTs /tts/ruling-applied so the ruling is consumed and
// the UI shows the outcome. Batches (members-bearing life todos) are skipped
// everywhere here — form-batches.mjs owns their briefs and their rulings.
//
// NO-STATE RULE: nothing local; Convex is read and written each run.

import {
  loadEnv,
  convexFetch,
  runClaude,
  extractJsonObject,
  nyNoonUtcMs,
  slackPost,
} from "./tts-lib.mjs";

const BATCH_MAX = 10;
const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000;

// ── The one threaded reply per #dump message (Tom, 2026-08-30) ───────────────
// EXACTLY ONE, and the guard has to be durable rather than a variable in this
// run: this job re-prepares on --force and on every revise ruling, so a
// per-run flag would post again each time Tom revised a brief.
//
// The reply is posted AFTER preparation lands, which is why it lives here and
// not in poll-dump.mjs: it says how TTS INTERPRETED the message, and there is
// nothing to say until there is a brief. It names the three things a reader
// needs to know the message was understood — what TTS thinks it is, the
// smallest way in, and whether it is waiting on Tom or on more agent work —
// plus a deep link.
//
// Failure is reported, never fatal: the preparation already landed, and a todo
// with no reply is a smaller loss than a run that stops.
async function postThreadedReply(env, todo, parsed) {
  if (todo.slackRepliedAt !== undefined) return; // already answered, once
  if (!todo.slackChannel || !todo.slackTs) return; // not from a Slack message
  const readiness =
    parsed.readiness === "ready-for-tom"
      ? "waiting on you"
      : "still being prepared";
  const text = [
    `Captured as a todo — ${readiness}.`,
    ``,
    parsed.brief.trim(),
    ``,
    `Way in: ${parsed.entryAction.trim()}`,
    `https://tom.quest/tts?item=${todo._id}`,
  ].join("\n");
  try {
    const posted = await slackPost(env, "chat.postMessage", {
      channel: todo.slackChannel,
      thread_ts: todo.slackTs,
      text,
      unfurl_links: false,
    });
    // Record the reply BEFORE anything else can re-enter this todo. The server
    // refuses a second stamp, so two racing runs still leave exactly one
    // recorded reply.
    await convexFetch(env, "/tts/slack-replied", {
      id: todo._id,
      replyTs: posted.ts,
    });
  } catch (err) {
    console.error(
      `[prepare-life-todos] ${todo._id} Slack reply failed: ${err.message}`,
    );
  }
}

function prompt(todo, reviseSentence, today) {
  return [
    `You are preparing one item in TTS, Tom's personal todo system. It was`,
    `captured as a raw thought; your job is to make it arrive pre-chewed.`,
    ``,
    `The item (JSON):`,
    JSON.stringify(
      {
        statement: todo.statement,
        source: todo.source,
        provenance: todo.provenance ?? null,
        createdAt: todo.createdAt,
      },
      null,
      2,
    ),
    ``,
    ...(reviseSentence
      ? [
          `Tom reviewed an earlier preparation of this item and ruled "revise" —`,
          `his one written sentence below redirects this re-preparation and`,
          `overrides any other reading of the item:`,
          ``,
          `Tom's revise ruling: ${reviseSentence}`,
          ``,
        ]
      : []),
    `Write, in plain language (define any term Tom might not know; invent no`,
    `names; descriptive, never evaluative — no praise, no urgency theater):`,
    `1. "brief" — 2-5 sentences, ground-up: what this item is, why it likely`,
    `   exists, and anything a person acting on it should know. If the`,
    `   statement is too terse to interpret confidently, say so plainly in the`,
    `   brief and phrase what needs clarifying.`,
    `2. "entryAction" — the SMALLEST first action, imperative, under 10 words`,
    `   (e.g. "Open the reservation page", "Draft two sentences to Ana").`,
    `3. "workDescription" — the kind/size of engagement, qualitatively, a few`,
    `   words (e.g. "a two-minute errand", "a short ruling", "a session's`,
    `   worth of writing"). NEVER a numeric time estimate.`,
    `4. "readiness" — "ready-for-tom" if the only missing ingredient is Tom`,
    `   acting or deciding; "preparing" if an agent could still usefully do`,
    `   groundwork first (research, drafting, gathering links).`,
    `5. "dueDate" — ONLY when the statement ITSELF names an explicit date`,
    `   ("pay rent sept 3", "call the bank on Friday the 12th"). Then give it`,
    `   as "YYYY-MM-DD"; today is ${today} in New York, which is how you`,
    `   resolve a bare month+day or weekday to a year. Otherwise give null.`,
    `   NEVER infer, estimate, or invent a date — no "this seems urgent, so`,
    `   next week". A date you were not told in the statement is a date that`,
    `   does not exist. Only the words in "statement" count; a date mentioned`,
    `   anywhere else is not this item's date.`,
    `6. "dateKind" — ONLY when you gave a dueDate. "external" if the statement`,
    `   shows the deadline was imposed by someone or something else (a bill, a`,
    `   landlord, a booking window, a court date); "self-imposed" if it reads`,
    `   as Tom's own choice of when. When the statement does not say, answer`,
    `   "self-imposed". Otherwise give null.`,
    ``,
    `Answer ONLY a JSON object:`,
    `{"brief": "...", "entryAction": "...", "workDescription": "...",`,
    ` "readiness": "...", "dueDate": null, "dateKind": null}`,
  ].join("\n");
}

async function main() {
  const force = process.argv.includes("--force");
  const env = loadEnv();
  const state = await convexFetch(env, "/tts/state");

  // Pending revise rulings on LIFE todos, keyed by todoId. The feed already
  // filters to unapplied-and-not-superseded rows; code rows on the same feed
  // belong to apply-rulings.mjs / execute-approved.mjs.
  //
  // A members-bearing todo is a BATCH: its revise rulings belong to
  // form-batches.mjs. This job's single-todo prompt would overwrite a grouping
  // brief and consume the ruling the batcher needs. (The server now also
  // refuses batch brief writes — this filter keeps the job from burning a
  // Claude call and stealing the ruling before that refusal.)
  const todoById = new Map((state.todos ?? []).map((t) => [t._id, t]));
  const { pending } = await convexFetch(env, "/tts/rulings");
  const reviseByTodo = new Map();
  for (const r of Array.isArray(pending) ? pending : []) {
    if (r.subjectType !== "life" || r.verdict !== "revise" || !r.todoId) continue;
    const subject = todoById.get(r.todoId);
    if (subject && subject.members !== undefined) continue; // batch — not ours
    reviseByTodo.set(r.todoId, r);
  }

  // Unprepared active todos — plus revise-ruled todos REGARDLESS of status
  // (a revise verdict drops readiness to "preparing" server-side; the sentence
  // is what pulls the todo back into the batch, and preparation only touches
  // brief/entryAction/workDescription, so re-preparing a waiting or archived
  // todo is safe — an active-only filter would strand the ruling pending
  // forever if Tom changed the status after ruling). --force also re-prepares
  // "preparing" items (useful after improving this prompt).
  //
  // members === undefined on BOTH branches: a members-bearing todo is a batch,
  // and batches are prepared (and re-formed on revise) by form-batches.mjs.
  // A schema-v2 TASK (a row carrying batchId whose kind is not "goal") is
  // excluded for the same reason one schema version later: it is a step inside
  // a batches row, "unprepared" is this job's INBOX rather than a resting
  // state, and briefing one would advance it to "ready-for-tom" and flood the
  // needs-me feed with plan steps.
  //
  // A GOAL IS NOT EXCLUDED. A goal is one of Tom's own todos that the planner
  // bound to a batch and otherwise left untouched — binding must not be what
  // stops it getting prepared, or the planner would silently remove a todo
  // from this job, from the legacy lanes, and from the frontier at once.
  const isGraphTask = (t) =>
    t.batchId !== undefined && t.batchId !== null && t.kind !== "goal";
  const targets = (state.todos ?? []).filter(
    (t) =>
      t.members === undefined &&
      !isGraphTask(t) &&
      (reviseByTodo.has(t._id) ||
        (t.status === "active" &&
          (t.readiness === "unprepared" ||
            (force && t.readiness === "preparing")))),
  );
  if (targets.length === 0) return; // quiet when idle

  const batch = targets.slice(0, BATCH_MAX);
  console.log(
    `[prepare-life-todos] ${targets.length} to prepare ` +
      `(${reviseByTodo.size} revise ruling(s) pending), processing ${batch.length}`,
  );

  let failures = 0;
  for (const todo of batch) {
    const revise = reviseByTodo.get(todo._id) ?? null;
    try {
      const answer = runClaude(
        prompt(todo, revise?.sentence ?? null, state.nyCalendarDay),
        { timeoutMs: CLAUDE_TIMEOUT_MS },
      );
      const parsed = extractJsonObject(answer);
      if (
        typeof parsed.brief !== "string" ||
        typeof parsed.entryAction !== "string" ||
        typeof parsed.workDescription !== "string" ||
        (parsed.readiness !== "ready-for-tom" && parsed.readiness !== "preparing")
      ) {
        throw new Error(`bad shape: ${JSON.stringify(parsed).slice(0, 120)}`);
      }
      // A date the STATEMENT states, in Tom's own words. Sent only when the
      // todo has no date AND no date HISTORY — a todo whose date Tom already
      // resolved (missed, renegotiated) must never have that same date handed
      // back to it by a re-prep of the same sentence. The server enforces both
      // halves regardless (internalPrepareTodo); this filter just keeps the job
      // from asking. A malformed date is dropped, never guessed at: the rest of
      // the preparation still lands.
      let dueAt;
      const dateSettled =
        todo.dueAt !== undefined || (todo.dateOutcomes ?? []).length > 0;
      if (typeof parsed.dueDate === "string" && !dateSettled) {
        try {
          dueAt = nyNoonUtcMs(parsed.dueDate.trim());
        } catch (e) {
          console.error(
            `[prepare-life-todos] ${todo._id} ignoring dueDate: ${e.message}`,
          );
        }
      }
      // Whose deadline it is, as the statement reads it — passed through, not
      // assumed. Anything but a clean "external" is self-imposed.
      const dateKind = parsed.dateKind === "external" ? "external" : "self-imposed";
      await convexFetch(env, "/tts/prepare-todo", {
        id: todo._id,
        brief: parsed.brief,
        entryAction: parsed.entryAction,
        workDescription: parsed.workDescription,
        readiness: parsed.readiness,
        ...(dueAt !== undefined ? { dueAt, dateKind } : {}),
      });
      // The one threaded reply, after the preparation it describes has landed.
      await postThreadedReply(env, todo, parsed);
      if (revise) {
        // The re-prep landed — consume the ruling so the UI shows the
        // outcome and the next run doesn't re-prepare on the same sentence.
        await convexFetch(env, "/tts/ruling-applied", {
          id: revise._id,
          result: "revised: brief re-prepared",
        });
      }
      console.log(
        `[prepare-life-todos] prepared ${todo._id} -> ${parsed.readiness}` +
          `${revise ? " (revise ruling applied)" : ""} ` +
          `"${todo.statement.slice(0, 50).replace(/\s+/g, " ")}"`,
      );
    } catch (err) {
      // Per-item failure: log and continue — the item stays unprepared (or
      // its revise ruling stays pending) and the next run retries it. One
      // bad item must not starve the batch.
      failures++;
      console.error(
        `[prepare-life-todos] ${todo._id} FAILED: ${String(err.message ?? err).slice(-200)}`,
      );
    }
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[prepare-life-todos] FAILED: ${err.message}`);
  process.exit(1);
});
