#!/usr/bin/env node
// prepare-life-todos.mjs — advance unprepared LIFE todos toward ready-for-tom.
//
// Run by cron EVERY 2 MINUTES under flock (see /etc/cron.d/tts), and kicked
// off directly by poll-dump.mjs the moment it captures, so a #dump message is
// normally prepared on the same tick it is read. Manual run:
//   node /opt/tts/prepare-life-todos.mjs [--force]
//
// The 2-minute schedule is affordable because this job returns before spending
// a Claude call when nothing is unprepared (see the `targets.length === 0`
// line below) — an idle tick costs one HTTP GET.
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

// ── The threaded Slack reply (Tom's ruling 2026-08-30) ──────────────────────
// A thought dumped into #dump gets ONE reply in its own thread, saying how TTS
// read it: the brief, the smallest entry action, where the readiness landed,
// and a link to the item. This is what makes the capture a conversation rather
// than a hole Tom types into.
//
// SCOPE NOTE: convex/ttsSync.ts holds OUTBOUND_SLACK_ENABLED = false, Tom's
// 2026-08-29 switch that silenced the daily digest and the session messages.
// This reply is not covered by that switch and is not a re-opening of it: it
// is a reply inside the thread of a message Tom just wrote, in the channel he
// wrote it in, one per capture — the shape he ruled for on 2026-08-30. The
// broadcast messages that switch turned off stay off.

// The item's page on tom.quest. Mirrors convex/ttsShared.ts ttsItemLink; the
// worker shares no code with Convex (it is dependency-free plain Node), so the
// URL shape is written twice on purpose. If the /tts page's link parameter
// ever changes, both must change.
function itemLink(todoId) {
  return `https://tom.quest/tts?item=${todoId}`;
}

// The reply text. Slack mrkdwn: *bold*, and <url|label> for a link.
// Plain and descriptive — it reports what TTS did, it does not sell it.
function replyText(todo, parsed) {
  const readiness =
    parsed.readiness === "ready-for-tom"
      ? "ready for you — the only thing missing is you acting or deciding"
      : "still preparing — an agent can usefully do more groundwork first";
  return [
    `Filed. Here is how TTS read that:`,
    ``,
    parsed.brief,
    ``,
    `*First action:* ${parsed.entryAction}`,
    `*Work:* ${parsed.workDescription}`,
    `*Readiness:* ${readiness}`,
    ``,
    `<${itemLink(todo._id)}|Open it on tom.Quest>`,
  ].join("\n");
}

// Post that reply, at most once per todo, ever.
//
// THE ORDER IS THE POINT. The claim (/tts/slack-replied) is taken BEFORE the
// Slack call, not after. This job re-prepares a todo on --force and on every
// "revise" ruling Tom writes, so without a durable claim one capture would be
// answered again on each re-preparation. Claiming first means a crash, a
// timeout or an overlapping run between the two steps can only ever LOSE a
// reply — never duplicate one — and Tom's rule is the absolute "must never
// reply twice".
//
// The named cost: if Slack refuses the post, that todo gets no reply at all.
// The failure is logged with the todo id; the item itself is prepared and
// visible on tom.quest regardless, which is the surface that matters.
//
// Failure NEVER propagates: preparation already succeeded and been stored, and
// an unsendable message must not turn a prepared todo into a failed one.
async function replyInThread(env, todo, parsed) {
  if (!todo.slackChannel || !todo.slackTs) return; // not a Slack capture
  if (todo.slackRepliedAt !== undefined) return; // already answered
  try {
    const claim = await convexFetch(env, "/tts/slack-replied", { id: todo._id });
    if (!claim.stamped) return; // someone else already holds the reply
    await slackPost(env, "chat.postMessage", {
      channel: todo.slackChannel,
      thread_ts: todo.slackTs,
      text: replyText(todo, parsed),
      unfurl_links: false,
    });
    console.log(`[prepare-life-todos] replied in thread ts=${todo.slackTs}`);
  } catch (err) {
    console.error(
      `[prepare-life-todos] ${todo._id} slack reply FAILED: ${err.message}`,
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

  // NEWEST FIRST. /tts/state returns rows oldest-first, and only BATCH_MAX of
  // them are prepared per run — so with oldest-first ordering a handful of
  // todos that can never be prepared (a server refusal, a model that keeps
  // answering the wrong shape) would hold every slot forever and a #dump
  // message captured a second ago would never be reached, never prepared, and
  // never replied to. Since 2026-08-30 that is a promise broken in front of
  // Tom rather than a slow queue, so the freshest capture goes first and a
  // permanently stuck item is what starves instead.
  //
  // This costs nothing when the backlog fits in one batch, which is the normal
  // case: the job runs every 2 minutes and captures arrive one at a time.
  targets.sort((a, b) => b.createdAt - a.createdAt);

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
      // The preparation is stored. Answer the #dump message in its own thread
      // with what TTS made of it — at most once per capture, ever.
      await replyInThread(env, todo, parsed);
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
      //
      // ⚠ RETRY RATE. There is no backoff here, and since 2026-08-30 this job
      // runs every 2 MINUTES rather than every 2 hours: a todo that fails to
      // prepare for a structural reason (a server refusal, a model that
      // answers the wrong shape every time) is now retried ~720 times a day,
      // each retry a headless Claude call, instead of ~12. Nothing caps that.
      // Watch /var/log/tts/prepare-life-todos.log for the same todo id
      // repeating; the stopgap is to archive the offending todo, and the fix
      // (if it ever comes up) is a per-todo attempt count — which needs a home
      // for that count, and this job deliberately keeps NO local state, so the
      // home would have to be Convex.
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
