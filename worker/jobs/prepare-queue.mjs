#!/usr/bin/env node
// prepare-queue.mjs — run headless Claude Code to choose today's TTS queue
// and write the daily digest, then POST both to Convex.
//
// Run by cron at 08:30 AND 09:30 UTC (see /etc/cron.d/tts). Only one of those
// is 4-something a.m. in New York, depending on daylight saving; the NY-hour
// guard below lets exactly that one proceed. Manual run for testing:
//   node /opt/tts/prepare-queue.mjs --force
//
// RELIABILITY SPLIT (why failure here is acceptable): this worker job is the
// smart-but-optional half. The Convex side runs a dumb fallback queue prep at
// 4:45 a.m. NY, and the 5 a.m. digest cron in Convex ALWAYS sends — with
// whatever was prepared, saying in-band when worker prep never arrived. So:
// missing digest = Convex/Slack breakage; digest reporting missing prep =
// worker breakage. Zero monitoring infrastructure needed. Consequently, on
// ANY failure this script just logs and exits 1 — no retries, no heroics.
//
// NO-STATE RULE: this script keeps nothing on disk. Everything it needs comes
// from Convex (/tts/state) and everything it produces goes to Convex
// (/tts/prep). The Jarvis Box can vanish at 4:31 and today is still covered.

import {
  loadEnv,
  convexFetch,
  nyHour,
  runClaude,
  extractJsonObject,
} from "./tts-lib.mjs";

const QUEUE_MAX = 7;

async function main() {
  const force = process.argv.includes("--force");
  const now = Date.now();

  // --- DST guard -----------------------------------------------------------
  // Cron can't express "4:30 a.m. New York" directly (system cron is UTC and
  // ignores DST), so it fires at both 08:30 and 09:30 UTC and we keep only
  // the run that lands inside the 4 a.m. NY hour.
  if (!force && nyHour(now) !== 4) {
    console.log(
      `[prepare-queue] NY hour is ${nyHour(now)}, not 4 — this is the ` +
        `off-season cron slot, exiting (use --force to override)`,
    );
    return;
  }

  const env = loadEnv();

  // --- Fetch state; THE SERVER OWNS THE DAY KEY ----------------------------
  // /tts/state returns `prepDay`: the day the coming 5 a.m. digest belongs
  // to, computed by Convex. The Jarvis Box deliberately does NOT compute day keys —
  // a second hand-rolled copy of the 5 a.m./DST math diverged from Convex's
  // on DST-transition Sundays (review-caught), so the day is now a
  // server-owned fact and this job just repeats it back.
  const state = await convexFetch(env, "/tts/state");
  const day = state.prepDay;
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`/tts/state returned no usable prepDay: ${JSON.stringify(day)}`);
  }

  // --- Idempotence: has today already been prepared? -----------------------
  // The 08:30/09:30 double-fire plus manual runs mean we can be called more
  // than once per day; if a worker-prepared queue already exists, do nothing.
  // (A queue prepared by the Convex FALLBACK does not stop us: worker prep is
  // the better version and /tts/prep overwrites it.)
  if (state.queue && state.queue.preparedBy === "worker") {
    console.log(`[prepare-queue] queue for ${day} already prepared by worker — nothing to do`);
    return;
  }

  // Only live items are queueable; archived/done stay out of the prompt too
  // (smaller prompt, no temptation for the model to resurrect them).
  const todos = (state.todos ?? []).filter(
    (t) => t.status === "active" || t.status === "waiting",
  );

  // With zero live todos there is nothing for a model to decide — post the
  // deterministic empty result ourselves and save a Claude invocation.
  if (todos.length === 0) {
    await convexFetch(env, "/tts/prep", {
      day,
      todoIds: [],
      reasons: [],
      digestText: "Nothing today.",
    });
    console.log(`[prepare-queue] ${day}: no live todos — posted empty queue + "Nothing today."`);
    return;
  }

  // Compact projection: just the fields the model needs to rank and describe.
  const compact = todos.map((t) => ({
    _id: t._id,
    statement: t.statement,
    readiness: t.readiness,
    status: t.status,
    timingClass: t.timingClass,
    dueAt: t.dueAt ?? null,
    condition: t.condition ?? null,
    latestSafeAt: t.latestSafeAt ?? null,
    workDescription: t.workDescription ?? null,
    entryAction: t.entryAction ?? null,
    updatedAt: t.updatedAt,
    source: t.source,
  }));

  // --- The prompt ----------------------------------------------------------
  // FUTURE IMPROVEMENT: the /tts/state API does not yet return yesterday's
  // digestText. When it does, include it in this prompt so the model can obey
  // the "repeat daily but reworded, never copy-pasted" rule against the
  // actual previous wording instead of from scratch.
  const prompt = [
    `You are preparing today's queue and daily digest for TTS, Tom's personal todo system.`,
    ``,
    `Today's day key: ${day}. Current time in epoch ms: ${now}. All dueAt/latestSafeAt/updatedAt values are epoch ms.`,
    ``,
    `Here is the full list of live todos as JSON (status "active" or "waiting"):`,
    ``,
    JSON.stringify(compact, null, 2),
    ``,
    `Tom's external calendar for the coming week (CONTEXT ONLY — these are`,
    `mirror rows of his Google/Outlook/Canvas calendars, not todos, and must`,
    `never be queued or mentioned as items; use them to judge how loaded a day`,
    `already is):`,
    ``,
    JSON.stringify(
      (state.calendarEvents ?? []).map((e) => ({
        title: e.title,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
      })),
      null,
      2,
    ),
    ``,
    `TASK 1 — choose an ordered queue of AT MOST ${QUEUE_MAX} todo _ids for today:`,
    `- Queue ONLY items with status "active". Items with status "waiting" are`,
    `  included above for context (their wake conditions) and must NOT be queued.`,
    `- Dated items that are due today or overdue come first.`,
    `- Then the nearest condition-bound items (timingClass "condition-bound").`,
    `- Then stale items (not touched in a long time, judged by updatedAt).`,
    `- Include EXACTLY ONE "invitation": a single item picked from the undated`,
    `  "whenever" pool (timingClass "whenever", no dueAt), placed last. If that`,
    `  pool is empty, no invitation.`,
    `- Give a one-word-ish reason per queued item (e.g. "overdue", "due-today",`,
    `  "stale", "invitation").`,
    ``,
    `TASK 2 — write the daily digest in Slack mrkdwn. Rules:`,
    `- Descriptive, never evaluative: facts only — zero verdicts, no praise, no scolding.`,
    `- Plain language; define anything unusual the moment it appears.`,
    `- Every reminder is framed with its smallest entry action (the tiniest first step).`,
    `- Countdowns as time-distance, e.g. "in 3 days", never bare dates alone.`,
    `- Link every item mention using Slack mrkdwn link syntax:`,
    `  <https://tom.quest/tts?item=THE_ID|the item's statement>`,
    `  where THE_ID is that todo's _id from the JSON. Never a bare statement.`,
    `- Sections, in this order, and NOTHING else:`,
    `  *Dated* — items with dates, nearest first.`,
    `  *Today's queue* — the queued items, in order, each with its entry action.`,
    `  *Waiting on you* — just the COUNT of items with readiness "ready-for-tom",`,
    `  linked as <https://tom.quest/tts|TTS>.`,
    `  *Invitation* — the one invitation item, framed gently.`,
    `- Omit a section entirely when it has nothing in it.`,
    `- If there is nothing to say at all, the digest is the single line: Nothing today.`,
    `- NEVER invent todos. Only items from the JSON above may appear.`,
    `- Reminders may repeat day after day, but must be reworded each day, never copy-pasted.`,
    ``,
    `Answer with ONLY a JSON object, no prose, no code fences:`,
    `{"todoIds": ["...", ...], "reasons": ["...", ...], "digestText": "..."}`,
    `todoIds and reasons must have the same length and parallel order.`,
  ].join("\n");

  // --- Run headless Claude -------------------------------------------------
  // Model deliberately left at the CLI default — Tom's Max plan covers it,
  // and one prep call a day is nowhere near any limit. runClaude (tts-lib)
  // owns the mechanics: prompt over stdin, envelope unwrapping, the
  // --max-turns 8 non-agentic default, and the active-account config dir.
  console.log(`[prepare-queue] ${day}: asking Claude to rank ${todos.length} todos…`);
  const answerText = runClaude(prompt, {
    timeoutMs: 10 * 60 * 1000, // ten minutes, then give up (fallback covers the day)
  });

  // --- Parse robustly ------------------------------------------------------
  // extractJsonObject strips code fences the model might add despite
  // instructions and takes the outermost {...} span.
  const parsed = extractJsonObject(answerText);

  // --- Validate ------------------------------------------------------------
  const knownIds = new Set(todos.map((t) => t._id));
  if (!Array.isArray(parsed.todoIds)) throw new Error("todoIds is not an array");
  if (typeof parsed.digestText !== "string" || parsed.digestText.trim() === "") {
    throw new Error("digestText missing or empty");
  }
  const reasonsIn = Array.isArray(parsed.reasons) ? parsed.reasons : [];
  const todoIds = [];
  const reasons = [];
  for (let i = 0; i < parsed.todoIds.length; i++) {
    const id = parsed.todoIds[i];
    if (!knownIds.has(id)) {
      // A hallucinated or stale id — drop it rather than fail the whole day.
      console.log(`[prepare-queue] dropping unknown todo id from answer: ${id}`);
      continue;
    }
    if (todoIds.includes(id)) continue; // dedupe, keep first occurrence
    if (todoIds.length >= QUEUE_MAX) break; // hard cap
    todoIds.push(id);
    reasons.push(typeof reasonsIn[i] === "string" ? reasonsIn[i] : "");
  }

  // --- Ship it -------------------------------------------------------------
  await convexFetch(env, "/tts/prep", {
    day,
    todoIds,
    reasons,
    digestText: parsed.digestText,
  });
  console.log(
    `[prepare-queue] ${day}: prepared queue of ${todoIds.length} ` +
      `(digest ${parsed.digestText.length} chars) — posted to Convex`,
  );
}

main().catch((err) => {
  // Any failure: log it and exit 1. The Convex fallback prep (4:45) and the
  // always-sends digest (5:00) cover the day; the digest will say in-band
  // that worker prep never arrived, which is the monitoring signal.
  console.error(`[prepare-queue] FAILED: ${err.message}`);
  process.exit(1);
});
