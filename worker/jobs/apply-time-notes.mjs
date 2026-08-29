#!/usr/bin/env node
// apply-time-notes.mjs — carry out Tom's freeform TIME NOTES.
//
// Run by cron every 2 minutes (see /etc/cron.d/dts). Manual run:
//   node /opt/tts/apply-time-notes.mjs
//
// WHAT A TIME NOTE IS: the /dts page has no date or time pickers left. When
// Tom wants anything about time changed he writes one sentence against exactly
// one context — a todo ("push this to next Wednesday"), a calendar block
// ("make it an hour earlier"), or a calendar day ("Sat 9-11 for chores"). This
// job is the reader: per pending note, one Claude call turns the sentence into
// concrete actions, and Convex carries them out.
//
// THE AGENT PROPOSES, THE SERVER DECIDES: every action is re-validated by
// dts.internalApplyTimeNote against the same helpers the Tom-gated mutations
// use — above all the kept-dates rule (a date is renegotiated only BEFORE it
// arrives; after that it is missed). A rejected apply rolls back whole; this
// job then re-submits the note as "needs-session" carrying the server's own
// reason, so a refused instruction reaches Tom instead of silently landing.
//
// NEVER GUESS: an ambiguous sentence ("sometime next week-ish") is NOT worth a
// wrong date. The model is told to answer "needs-session" with a one-line
// reason, which is the page's escape hatch — Tom opens a session and says it
// out loud.
//
// THE FAILURE POLICY, in two phases (see main()). Phase 1 turns the sentence
// into a verdict; everything that can go wrong there is a CONTENT failure
// (unusable model answer, bad shape, an action that will not convert) and the
// note is filed needs-session with the reason, because re-asking every two
// minutes gets the same nothing back. Phase 2 writes the verdict; a 4xx is the
// server REFUSING it (re-filed needs-session in the server's own words), while
// a 5xx or a network throw is ENVIRONMENTAL — the note stays pending and the
// next tick retries it whole (the apply-rulings.mjs failure policy).
//
// COST: the queue is usually empty and the job exits before spending anything.
// Parsing one sentence into a fixed action vocabulary is mechanical, so it
// runs on a cheap model.
//
// NO-STATE RULE: nothing local; Convex is read and written each run.

import {
  loadEnv,
  convexFetch,
  serverErrorMessage,
  runClaude,
  extractJsonObject,
  nyUtcOffsetHours,
  nyNoonUtcMs,
} from "./tts-lib.mjs";

const NOTE_MAX = 10; // per run; the rest wait two minutes
const CLAUDE_TIMEOUT_MS = 3 * 60 * 1000;
const MODEL = "claude-sonnet-5"; // mechanical parsing — no need for a big model

// ---------------------------------------------------------------------------
// New York wall-clock <-> epoch ms
// ---------------------------------------------------------------------------
// The model reads and writes LOCAL wall-clock strings, never epoch ms: asking
// a model for a millisecond timestamp is asking for an off-by-a-timezone bug.
// The DST rules live in tts-lib (nyUtcOffsetHours); nothing is reimplemented.

/** "YYYY-MM-DD HH:MM" in New York for an epoch-ms instant. */
function nyLocal(ms) {
  if (typeof ms !== "number") return null;
  const shifted = new Date(ms + nyUtcOffsetHours(ms) * 3_600_000);
  return shifted.toISOString().slice(0, 16).replace("T", " ");
}

/** Epoch ms for a "YYYY-MM-DDTHH:MM" (or "YYYY-MM-DD HH:MM") New York time. */
function fromNyLocal(text) {
  const s = String(text).trim().replace(" ", "T");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) {
    throw new Error(`not a YYYY-MM-DDTHH:MM local time: ${text}`);
  }
  const asUtc = Date.parse(`${s}:00Z`);
  if (Number.isNaN(asUtc)) throw new Error(`unparseable local time: ${text}`);
  // Offset sampled at the same instant read as UTC — within a few hours of the
  // real one, which only matters inside the 1-hour DST seam.
  return asUtc - nyUtcOffsetHours(asUtc) * 3_600_000;
}

// ---------------------------------------------------------------------------
// Context rendering — the facts the note is about, in local time
// ---------------------------------------------------------------------------

function renderBlock(b) {
  return {
    blockId: b._id,
    start: nyLocal(b.start),
    end: nyLocal(b.end),
    todoId: b.todoId ?? null,
    category: b.category ?? null,
    note: b.note ?? null,
  };
}

function renderContext(context) {
  if (!context) return { kind: "unknown" };
  if (context.kind === "todo") {
    const t = context.todo;
    if (!t) return { kind: "todo", todo: null };
    return {
      kind: "todo",
      todo: {
        statement: t.statement,
        status: t.status,
        timingClass: t.timingClass,
        due: nyLocal(t.dueAt),
        dateKind: t.dateKind,
        latestSafe: nyLocal(t.latestSafeAt),
        wakeAt: nyLocal(t.wakeAt),
        wakeCondition: t.wakeCondition,
        dateOutcomes: (t.dateOutcomes ?? []).map((o) => ({
          date: nyLocal(o.dueAt),
          outcome: o.outcome,
          note: o.note ?? null,
        })),
      },
    };
  }
  if (context.kind === "block") {
    return {
      kind: "block",
      block: context.block ? renderBlock(context.block) : null,
      sameDayBlocks: (context.sameDayBlocks ?? []).map(renderBlock),
    };
  }
  if (context.kind === "day") {
    return {
      kind: "day",
      dayBlocks: (context.dayBlocks ?? []).map(renderBlock),
      activeTodos: (context.activeTodos ?? []).map((t) => ({
        todoId: t._id,
        statement: t.statement,
        category: t.category,
        due: nyLocal(t.dueAt),
      })),
    };
  }
  return { kind: context.kind ?? "unknown" };
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

function prompt(note, clock) {
  // note.day is the calendar-date LABEL of the column Tom clicked, already
  // "YYYY-MM-DD" in New York (schema: dtsTimeNotes.day) — it goes into the
  // prompt verbatim. There is no timestamp to convert and nothing to get wrong.
  const dayLine =
    typeof note.day === "string" && note.day
      ? `The note is about the calendar day ${note.day} (New York).`
      : null;
  return [
    `You are reading ONE "time note" in TTS, Tom's personal todo system. A`,
    `time note is a sentence Tom wrote about time — a due date, a wake time, a`,
    `block of committed time on his calendar. Your job is to turn that one`,
    `sentence into concrete actions, or to say plainly that you cannot.`,
    ``,
    `RIGHT NOW: ${clock.nyCalendarDay} ${nyLocal(clock.now)} in ${clock.timezone}`,
    `(all times below, and every time you write, are New York wall clock).`,
    ``,
    `TOM WROTE: ${note.text}`,
    ...(dayLine ? [``, dayLine] : []),
    ``,
    `WHAT THE NOTE IS ABOUT (JSON):`,
    JSON.stringify(renderContext(note.context), null, 2),
    ``,
    `THE ACTIONS YOU MAY ASK FOR. Nothing else exists; an instruction that`,
    `needs anything else is "needs-session".`,
    `  {"kind":"set-due","date":"YYYY-MM-DD","dateKind":"external"|"self-imposed"}`,
    `      Give the todo its FIRST date. Illegal if it already has one.`,
    `      "external" = someone else set the deadline; "self-imposed" = Tom did`,
    `      (default to "self-imposed" unless the note says otherwise).`,
    `  {"kind":"renegotiate","newDate":"YYYY-MM-DD","note":"..."}`,
    `      Move an EXISTING date. Legal ONLY while the current date is still`,
    `      ahead. This is the kept-dates rule: a date never just slides.`,
    `  {"kind":"record-missed","date":"YYYY-MM-DD","note":"..."}`,
    `      The date passed and was not kept. Only when it is already past AND`,
    `      Tom's sentence says so. "date" is OPTIONAL and is the REPLACEMENT`,
    `      date, when his sentence names one ("blew Tuesday, do it Friday").`,
    `      Leave it out and the item goes back to having no date, with the miss`,
    `      on record.`,
    `  {"kind":"set-date-kind","dateKind":"external"|"self-imposed"}`,
    `      The date STAYS; only whose deadline it is was wrong ("that's the`,
    `      landlord's date, not mine"). Needs a todo that already has a date.`,
    `  {"kind":"set-latest-safe","date":"YYYY-MM-DD"}  — latest safe moment for`,
    `      a condition-bound item.  {"kind":"clear-latest-safe"}`,
    `  {"kind":"set-waiting","wakeDate":"YYYY-MM-DD","wakeCondition":"..."}`,
    `      Put the todo to sleep (both fields optional).  {"kind":"set-active"}`,
    `      wakes it.`,
    `  {"kind":"create-block","start":"YYYY-MM-DDTHH:MM","end":"...",`,
    `   "todoId":"...","category":"..."}`,
    `      Place committed time. A block targets EXACTLY ONE of todoId or`,
    `      category — never both, never neither. On a note written against a`,
    `      todo, omit both and it targets that todo.`,
    `  {"kind":"update-block","blockId":"...","start":"...","end":"..."}`,
    `  {"kind":"delete-block","blockId":"..."}`,
    `      blockId VERBATIM from the context above.`,
    ``,
    `RULES:`,
    `- NEVER guess an ambiguous time. If the sentence does not pin down what`,
    `  you would have to write ("sometime next week", "earlier", with no`,
    `  anchor), answer status "needs-session" with a one-line reason. A wrong`,
    `  date is far worse than a note Tom talks through in a session.`,
    `- Answer status "needs-session" too when the note asks for anything`,
    `  outside the action list, or when the context contradicts it (e.g. it`,
    `  says "push it back" but the date already passed — that is a miss).`,
    `- A weekday with no date ("Wednesday") means the NEXT such weekday from`,
    `  today. A bare month+day takes the nearest year that is not in the past.`,
    `- "result" is ONE plain sentence of what was done, in Tom's words, no`,
    `  jargon: "due set to Wed Sep 2", "moved the chores block to 10-12".`,
    `  For "needs-session" it is the one-line reason instead.`,
    `- Descriptive, never evaluative. No praise, no urgency.`,
    ``,
    `Answer ONLY a JSON object, no prose, no code fences:`,
    `{"status": "applied", "result": "...", "actions": [ ... ]}`,
    `or`,
    `{"status": "needs-session", "result": "...", "actions": []}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Model answer -> wire shape
// ---------------------------------------------------------------------------

// Convert one model action to the shape POST /tts/apply-time-note takes
// (epoch ms). Throws on anything malformed — the caller turns that into a
// needs-session, because a half-understood action must never be sent.
function toWireAction(a) {
  if (typeof a !== "object" || a === null) throw new Error("action is not an object");
  const note = typeof a.note === "string" ? a.note : undefined;
  switch (a.kind) {
    case "set-due":
      return {
        kind: "set-due",
        dueAt: nyNoonUtcMs(String(a.date).trim()),
        dateKind: a.dateKind === "external" ? "external" : "self-imposed",
      };
    case "renegotiate":
      return {
        kind: "renegotiate",
        newDueAt: nyNoonUtcMs(String(a.newDate).trim()),
        ...(note ? { note } : {}),
      };
    case "record-missed":
      return {
        kind: "record-missed",
        ...(a.date ? { newDueAt: nyNoonUtcMs(String(a.date).trim()) } : {}),
        ...(note ? { note } : {}),
      };
    case "set-date-kind":
      if (a.dateKind !== "external" && a.dateKind !== "self-imposed") {
        throw new Error(
          `set-date-kind needs "external" or "self-imposed": ${JSON.stringify(a.dateKind)}`,
        );
      }
      return { kind: "set-date-kind", dateKind: a.dateKind };
    case "set-latest-safe":
      return {
        kind: "set-latest-safe",
        latestSafeAt: nyNoonUtcMs(String(a.date).trim()),
      };
    case "clear-latest-safe":
      return { kind: "clear-latest-safe" };
    case "set-waiting":
      return {
        kind: "set-waiting",
        ...(a.wakeDate ? { wakeAt: nyNoonUtcMs(String(a.wakeDate).trim()) } : {}),
        ...(typeof a.wakeCondition === "string" && a.wakeCondition.trim()
          ? { wakeCondition: a.wakeCondition.trim() }
          : {}),
      };
    case "set-active":
      return { kind: "set-active" };
    case "create-block":
      return {
        kind: "create-block",
        start: fromNyLocal(a.start),
        end: fromNyLocal(a.end),
        ...(typeof a.todoId === "string" && a.todoId ? { todoId: a.todoId } : {}),
        ...(typeof a.category === "string" && a.category.trim()
          ? { category: a.category.trim() }
          : {}),
      };
    case "update-block":
      if (typeof a.blockId !== "string" || !a.blockId) {
        throw new Error("update-block needs a blockId");
      }
      return {
        kind: "update-block",
        blockId: a.blockId,
        start: fromNyLocal(a.start),
        end: fromNyLocal(a.end),
      };
    case "delete-block":
      if (typeof a.blockId !== "string" || !a.blockId) {
        throw new Error("delete-block needs a blockId");
      }
      return { kind: "delete-block", blockId: a.blockId };
    default:
      throw new Error(`unknown action kind: ${JSON.stringify(a.kind)}`);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const env = loadEnv();
  const state = await convexFetch(env, "/tts/time-notes", {});
  const notes = Array.isArray(state.notes) ? state.notes : [];
  if (notes.length === 0) return; // the common case: exit before spending anything

  const batch = notes.slice(0, NOTE_MAX);
  console.log(
    `[apply-time-notes] ${notes.length} pending, processing ${batch.length}`,
  );

  let failures = 0;
  for (const note of batch) {
    // ── Phase 1: READ the sentence ───────────────────────────────────────
    // Everything in here is a CONTENT failure — the model call, the parse, the
    // shape check, the action conversion. Asking the same question again in
    // two minutes gets the same nothing back, so the note goes to Tom with the
    // reason rather than looping forever. The verdict below is always
    // well-formed; the only question left is whether the server accepts it.
    let verdict;
    try {
      const answer = runClaude(prompt(note, state), {
        timeoutMs: CLAUDE_TIMEOUT_MS,
        model: MODEL,
      });
      const parsed = extractJsonObject(answer);
      if (
        (parsed.status !== "applied" && parsed.status !== "needs-session") ||
        typeof parsed.result !== "string" ||
        parsed.result.trim() === ""
      ) {
        throw new Error(`bad shape: ${JSON.stringify(parsed).slice(0, 160)}`);
      }
      verdict =
        parsed.status === "needs-session"
          ? { status: "needs-session", result: parsed.result.trim() }
          : {
              status: "applied",
              result: parsed.result.trim(),
              actions: (Array.isArray(parsed.actions) ? parsed.actions : []).map(
                toWireAction,
              ),
            };
    } catch (err) {
      failures++;
      const why = String(err.message ?? err).slice(-300);
      console.error(`[apply-time-notes] ${note._id} unreadable: ${why}`);
      verdict = {
        status: "needs-session",
        result: `could not read the instruction (${why})`,
      };
    }

    // ── Phase 2: WRITE the verdict ───────────────────────────────────────
    // A 4xx is the SERVER refusing what we sent (kept-dates, a block target, a
    // stale id): nothing landed — the mutation rolls back whole — and sending
    // it again changes nothing, so the note is re-filed as needs-session in the
    // server's own words. Anything else (5xx, network, a dead endpoint) is
    // ENVIRONMENTAL: the note stays pending and the next tick retries it whole.
    try {
      await convexFetch(env, "/tts/apply-time-note", { id: note._id, ...verdict });
      console.log(
        `[apply-time-notes] ${note._id} ${verdict.status}: ${verdict.result}`,
      );
    } catch (err) {
      failures++;
      const refused =
        verdict.status === "applied" && err.status >= 400 && err.status < 500;
      if (!refused) {
        console.error(
          `[apply-time-notes] ${note._id} left pending: ${String(err.message ?? err).slice(-300)}`,
        );
        continue;
      }
      const why = `refused: ${serverErrorMessage(err).slice(0, 300)}`;
      try {
        await convexFetch(env, "/tts/apply-time-note", {
          id: note._id,
          status: "needs-session",
          result: why,
        });
        console.error(`[apply-time-notes] ${note._id} ${why}`);
      } catch (e2) {
        // Even the re-file failed (network). The note stays pending and the
        // next tick retries the whole thing.
        console.error(
          `[apply-time-notes] ${note._id} could not be marked needs-session: ${e2.message}`,
        );
      }
    }
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[apply-time-notes] FAILED: ${err.message}`);
  process.exit(1);
});
