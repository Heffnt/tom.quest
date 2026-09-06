import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { recordMissedKeepingDate } from "./tts";
import {
  DAY_MS,
  countdownText,
  nyCalendarDayBoundsUtc,
  nyHhmm,
  ttsItemLink,
  type SlackSubject,
} from "./ttsShared";

// ── The digest (the lifeos update, phase 2; rulings 13, 14) ──────────────────
// Deterministic: every line comes from a query, no model call. The sender
// (convex/ttsSync.ts sendDigest) runs the missed rollover, reads
// internalComposeDigest, posts to #tts, and records the send. This module is
// plain runtime (no "use node") so its composer is a pure function a test can
// call with hand-built facts.
//
// Sections, in this order; each omitted when empty except the first:
//   1. due and overdue today, with each item's entry action and, for a date
//      that passed without an outcome, the reply path
//   2. committed blocks and calendar events today
//   3. captures from email since the last digest
//   4. what the box did overnight, grouped by batch
//   5. items ready for Tom
//   6. job failures
//   7. every WikiTom commit since the last digest, with its author (fetched by
//      the sender — GitHub is outside this runtime — and never omitted: when
//      the deployment's token cannot read WikiTom the section is one line
//      saying so, because a silently absent section reads as "no commits")
//   8. rulings recorded from Tom's own words since the last digest
//   9. model-of-Tom lines the nightly job wrote (kind "learning-change";
//      empty until phase 4)

// ── The digest's own bookkeeping row (dtsEvents) ─────────────────────────────
// TWO KINDS OF ROW come out of a sent digest, and they answer different
// questions:
//
//   "slack-sent" / "slack-send-failed" belong to the ONE DOOR
//   (convex/ttsSync.ts postSlack → convex/ttsSlack.ts). They are keyed by the
//   Slack thread and carry the subject, so a threaded reply from Tom is routed
//   back to what it answers, and a failure row carries the text a later resend
//   posts unchanged. The digest does not write them and must not read them for
//   its own bookkeeping — their key is a thread, not a day.
//
//   "digest-sent" (written by tts.internalMarkDigestSent) is the DIGEST's own
//   row: data { day, windowEnd }. `day` is the once-a-day dedupe key; a rerun
//   the same day finds it and stops. `windowEnd` is the `now` the digest was
//   COMPOSED against, and it is where the NEXT digest's window starts. The
//   row's own `at` is later — composing, posting to Slack and writing the row
//   all take time — so starting the next window there would skip everything
//   that happened in the gap. This mirrors the hourly update's marker row
//   exactly (convex/ttsSync.ts HOURLY_UPDATE_SENT).
export const SLACK_SENT = "slack-sent";
export const SLACK_FAILED = "slack-send-failed";
export const DIGEST_SENT = "digest-sent";
export function digestSubject(day: string): SlackSubject {
  return { kind: "digest", day };
}

/** " (kind identifier)" for a failure line, or "" when a row carries no
 * subject. Each SLACK_SUBJECT member names its subject in its own field —
 * `day`, `hour` or `id` — and the digest only prints them, so it takes
 * whichever is there rather than knowing the union member by member. */
function slackSubjectLabel(raw: unknown): string {
  if (raw === null || typeof raw !== "object") return "";
  const s = raw as { kind?: unknown; day?: unknown; hour?: unknown; id?: unknown };
  if (typeof s.kind !== "string") return "";
  const named = [s.day, s.hour, s.id].find((x) => typeof x === "string");
  return ` (${s.kind}${named === undefined ? "" : ` ${named as string}`})`;
}

// The nightly job's model-of-Tom lines (phase 4 writes them; the digest reads
// them from day one so the section is live the morning the job first runs).
//   kind "learning-change", data { id, file, before, after, evidence }
export const LEARNING_CHANGE = "learning-change";

// The note the rollover writes on the outcome row, so the row says who wrote
// it when Tom reads the item's history.
export const ROLLOVER_NOTE = "passed without an outcome; recorded at the 5 a.m. rollover";

// ── The missed rollover (ruling 14) ──────────────────────────────────────────
// At 5 a.m. New York, before composing: every active dated todo whose date is
// before the new calendar day and which has no outcome recorded for that date
// gets the outcome "missed", ONCE, through tts.recordMissedKeepingDate. That
// path writes the outcome row and NOTHING else — the date stays, its dateKind
// stays, and updatedAt is not bumped (see the comment there). The item is then
// still listed as overdue with its original date until Tom replies done or
// gives a new one. Idempotent: the outcome row's dueAt equals the todo's dueAt
// afterwards, and that equality is the "already recorded" check.
export function isPassedWithoutOutcome(
  todo: Pick<Doc<"dtsTodos">, "status" | "dueAt" | "dateOutcomes">,
  newDayStart: number,
): boolean {
  if (todo.status !== "active" || todo.dueAt === undefined) return false;
  if (todo.dueAt >= newDayStart) return false;
  const dueAt = todo.dueAt;
  return !(todo.dateOutcomes ?? []).some((o) => o.dueAt === dueAt);
}

export const internalRollMissed = internalMutation({
  args: { day: v.string() },
  handler: async (ctx, { day }) => {
    const { start } = nyCalendarDayBoundsUtc(day);
    // The rows the rollover can possibly touch, and no others: active, dated,
    // and dated before the new day. The `gte(0)` lower bound excludes the
    // undated rows, which sort before every number in a Convex index.
    const passed = await ctx.db
      .query("dtsTodos")
      .withIndex("by_status_and_due", (q) =>
        q.eq("status", "active").gte("dueAt", 0).lt("dueAt", start),
      )
      .collect();
    const rolled: Id<"dtsTodos">[] = [];
    for (const todo of passed) {
      if (!isPassedWithoutOutcome(todo, start)) continue;
      await recordMissedKeepingDate(ctx, todo, ROLLOVER_NOTE);
      rolled.push(todo._id);
    }
    return rolled;
  },
});

// ── WikiTom commits (plan §3: "every WikiTom commit made since the last
// digest, with author") ──────────────────────────────────────────────────────
// WikiTom is Tom's own repository, and the digest is where he sees what moved
// in it overnight. GitHub is outside the Convex query runtime, so the SENDER
// fetches (convex/ttsSync.ts, with the deployment's GITHUB_MIRROR_TOKEN) and
// hands the result to the composer.
//
// That token is scoped to ComplexMultiTrigger and tom.quest today, so a
// WikiTom read comes back 403/404 until Tom widens it. The section then says
// exactly that instead of disappearing — an omitted section would read as "no
// commits were made", which is a different fact.
export type WikiTomCommit = {
  sha: string;
  message: string;
  author: string;
  url: string;
};
export const WIKITOM_UNREADABLE = "WikiTom commits: not readable (no credential)";
export const WIKITOM_COMMIT = v.object({
  sha: v.string(),
  message: v.string(),
  author: v.string(),
  url: v.string(),
});

// ── Facts → text ─────────────────────────────────────────────────────────────
// Structural types, not Docs, so the composer is testable with literals.
export type DigestFacts = {
  day: string;
  now: number;
  since: number;
  due: {
    id: string;
    statement: string;
    dueAt: number;
    entryAction?: string;
    // The date passed and "missed" is on record for it (the rollover's mark,
    // or Tom's own missed-and-kept-the-date); the line carries the reply path.
    missed: boolean;
  }[];
  blocks: { start: number; end: number; label: string }[];
  calendar: { start: number; end: number; title: string; allDay: boolean }[];
  emailCaptures: { id: string; statement: string; entryAction?: string }[];
  overnight: { batch: string | null; text: string }[];
  ready: { id: string; statement: string; entryAction?: string }[];
  failures: { at: number; text: string }[];
  // null = WikiTom could not be read at all (see WIKITOM_UNREADABLE).
  wikitom: WikiTomCommit[] | null;
  rulings: {
    verdict: string;
    subject: string;
    // Tom's own sentence, from the ruling's provenance (ttsRulings check 3).
    // The ONLY text the digest prints between quotation marks.
    quote?: string;
    // The ruling's own `sentence` — the revise redirect through the words
    // door (itself a sentence of Tom's turn since check 7), or whatever a
    // provenance-carrying row of another shape holds. Printed as the
    // redirect, never as a quotation of Tom: the field is what an agent
    // acts on, and the digest must not present it as what Tom said.
    redirect?: string;
    provenance: string;
  }[];
  learning: {
    id: string;
    file: string;
    before: string;
    after: string;
    evidence: string;
  }[];
};

// Slack mrkdwn reserves these three inside message text and link labels.
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function itemLine(item: { id: string; statement: string; entryAction?: string }) {
  const entry = item.entryAction ? ` — ${slackEscape(item.entryAction)}` : "";
  return `- <${ttsItemLink(item.id)}|${slackEscape(item.statement)}>${entry}`;
}

export function composeDigest(f: DigestFacts): string {
  const lines: string[] = [`*TTS digest — ${f.day}*`, "", "*Due and overdue*"];

  if (f.due.length === 0) {
    lines.push("- nothing");
  }
  for (const d of [...f.due].sort((a, b) => a.dueAt - b.dueAt)) {
    const replyPath = d.missed ? " — missed: reply done, or a new date" : "";
    lines.push(`${itemLine(d)} — ${countdownText(d.dueAt, f.now)}${replyPath}`);
  }

  const spans = [
    ...f.blocks.map((b) => ({ start: b.start, end: b.end, text: b.label, allDay: false })),
    ...f.calendar.map((e) => ({ start: e.start, end: e.end, text: e.title, allDay: e.allDay })),
  ].sort((a, b) => a.start - b.start);
  if (spans.length > 0) {
    lines.push("", "*Blocks and calendar*");
    for (const s of spans) {
      const when = s.allDay ? "all day" : `${nyHhmm(s.start)}–${nyHhmm(s.end)}`;
      lines.push(`- ${when} ${slackEscape(s.text)}`);
    }
  }

  if (f.emailCaptures.length > 0) {
    lines.push("", "*Captured from email*");
    for (const c of f.emailCaptures) lines.push(itemLine(c));
  }

  if (f.overnight.length > 0) {
    lines.push("", "*Overnight, by batch*");
    const groups = new Map<string | null, string[]>();
    for (const o of f.overnight) {
      const list = groups.get(o.batch) ?? [];
      list.push(o.text);
      groups.set(o.batch, list);
    }
    // Named batches first, in first-seen order; the batch-less tail last.
    const keys = [...groups.keys()].sort((a, b) =>
      a === null ? 1 : b === null ? -1 : 0,
    );
    for (const key of keys) {
      lines.push(`_${key === null ? "no batch" : slackEscape(key)}_`);
      for (const text of groups.get(key) ?? []) lines.push(`- ${text}`);
    }
  }

  if (f.ready.length > 0) {
    lines.push("", "*Ready for you*");
    for (const r of f.ready) lines.push(itemLine(r));
  }

  if (f.failures.length > 0) {
    lines.push("", "*Job failures*");
    for (const x of [...f.failures].sort((a, b) => a.at - b.at)) {
      lines.push(`- ${nyHhmm(x.at)} ${x.text}`);
    }
  }

  if (f.wikitom === null) {
    lines.push("", WIKITOM_UNREADABLE);
  } else if (f.wikitom.length > 0) {
    lines.push("", "*WikiTom commits*");
    for (const c of f.wikitom) {
      lines.push(
        `- <${c.url}|${slackEscape(c.sha.slice(0, 7))}> ${slackEscape(c.message)} — ${slackEscape(c.author)}`,
      );
    }
  }

  if (f.rulings.length > 0) {
    lines.push("", "*Rulings from your words*");
    for (const r of f.rulings) {
      const quote = r.quote ? `: "${slackEscape(r.quote)}"` : "";
      const redirect = r.redirect ? ` — redirect: ${slackEscape(r.redirect)}` : "";
      lines.push(
        `- ${r.verdict} on ${r.subject}${quote}${redirect} (${slackEscape(r.provenance)})`,
      );
    }
  }

  if (f.learning.length > 0) {
    lines.push("", "*Model of Tom*");
    for (const l of f.learning) {
      lines.push(
        `- [${slackEscape(l.id)}] ${slackEscape(l.file)}: "${slackEscape(l.before)}" → "${slackEscape(l.after)}" (${slackEscape(l.evidence)})`,
      );
    }
  }

  return lines.join("\n");
}

// ── Gathering the facts ──────────────────────────────────────────────────────

// Bounded newest-first walk of dtsEvents for a kind, the internalLastEventAt
// pattern: dtsEvents is busy instrumentation, and if the kind is not inside
// this many rows "never" is the honest answer.
const EVENT_SCAN = 2000;

// The same shape for the email-capture read: the newest rows on the source
// index, cut at the window. A window holding more email captures than this is
// a mail flood, and the digest is a morning read.
const CAPTURE_SCAN = 500;

/**
 * The newest "digest-sent" row: which day went out last, and where that run's
 * window ended. Read on the by_kind_key index, whose columns are
 * (kind, key, at) — "digest-sent" rows never carry a key, so within the kind
 * the order IS time order and `.order("desc").first()` is the newest row. A
 * scan of recent events would not do: dtsEvents is busy instrumentation and a
 * daily row falls off the end of any bounded scan.
 *
 * `windowEnd` is absent on rows written before the lifeos update. Those are
 * from August and naming their `at` as the next window's start would open a
 * weeks-wide window, so they answer null and the caller covers the last day.
 */
async function lastDigestSent(
  ctx: QueryCtx,
): Promise<{ day: string | null; windowEnd: number | null } | null> {
  const row = await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", DIGEST_SENT))
    .order("desc")
    .first();
  if (!row) return null;
  const d = (row.data ?? {}) as { day?: unknown; windowEnd?: unknown };
  return {
    day: typeof d.day === "string" ? d.day : null,
    windowEnd: typeof d.windowEnd === "number" ? d.windowEnd : null,
  };
}

/**
 * The two facts a digest run needs from the last one, in one read: the day it
 * covered (`lastDay` — equal to today means today's has gone out) and where
 * this run's window starts. The sender needs `since` before it composes,
 * because it fetches WikiTom's commits over the same window.
 */
export const internalDigestWindow = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    const row = await lastDigestSent(ctx);
    return { lastDay: row?.day ?? null, since: row?.windowEnd ?? now - DAY_MS };
  },
});

// A ruling written from Tom's own words (ruling 15) carries a provenance the
// ruling route stamps; a row without one is a button ruling, not a sentence.
// ANY non-empty provenance is reported. The shape is the ruling piece's to
// define and it is already two shapes — a plain string, and the object PR #144
// writes ({ from: "tom-words", ... }) — so this reader takes both and never
// judges the CONTENT. It matched /session|slack/ before, which silently
// dropped every ruling whose provenance was worded differently: the digest is
// how Tom catches a misread sentence, so a ruling it does not print is a
// misread he never sees.
const PROVENANCE_PARTS = 4; // enough to name the source; the line stays a line
export function provenanceText(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim() === "" ? null : raw.trim();
  if (raw === null || typeof raw !== "object") return null;
  const parts = Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .map(([k, v]) => `${k} ${v}`)
    .slice(0, PROVENANCE_PARTS);
  return parts.length === 0 ? null : parts.join(", ");
}
// The words door (ttsRulings.internalRecordRulingFromTomWords) writes
// { from, inboundId, quote }: `quote` is Tom's sentence and is lifted out to
// be printed AS his quotation; the rest names the source. Any other
// non-empty shape is a source with no quotation to print.
function rulingProvenance(
  r: Doc<"dtsRulings">,
): { quote?: string; provenance: string } | null {
  const raw = (r as unknown as Record<string, unknown>).provenance;
  if (raw !== null && typeof raw === "object" && "quote" in raw) {
    const { quote, ...source } = raw as Record<string, unknown>;
    const provenance = provenanceText(source);
    if (typeof quote === "string" && quote.trim() !== "") {
      return { quote: quote.trim(), provenance: provenance ?? "from Tom's words" };
    }
    return provenance === null ? null : { provenance };
  }
  const provenance = provenanceText(raw);
  return provenance === null ? null : { provenance };
}

const SESSION_LINK = "https://tom.quest/sessions?session=";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export async function gatherDigestFacts(
  ctx: QueryCtx,
  {
    day,
    now,
    since,
    wikitom,
  }: {
    day: string;
    now: number;
    since: number;
    // The sender's WikiTom read; null (or absent) means it could not be read.
    wikitom?: WikiTomCommit[] | null;
  },
): Promise<DigestFacts> {
  const { start: dayStart, end: dayEnd } = nyCalendarDayBoundsUtc(day);

  // Names for the ids the sections actually touch, fetched one at a time and
  // remembered. The whole dtsTodos and batches tables were read here before —
  // two full-table scans that grow with the record forever, for a handful of
  // lookups.
  const todoCache = new Map<string, Doc<"dtsTodos"> | null>();
  const todoOf = async (
    id: Id<"dtsTodos"> | undefined,
  ): Promise<Doc<"dtsTodos"> | null> => {
    if (id === undefined) return null;
    const hit = todoCache.get(id);
    if (hit !== undefined) return hit;
    const row = await ctx.db.get(id);
    todoCache.set(id, row);
    return row;
  };
  const batchCache = new Map<string, string | null>();
  const batchName = async (
    id: Id<"batches"> | undefined,
  ): Promise<string | null> => {
    if (id === undefined) return null;
    const hit = batchCache.get(id);
    if (hit !== undefined) return hit;
    const name = (await ctx.db.get(id))?.statement ?? null;
    batchCache.set(id, name);
    return name;
  };
  const batchOfTodo = async (
    id: Id<"dtsTodos"> | undefined,
  ): Promise<string | null> => await batchName((await todoOf(id))?.batchId);

  // 1. Due and overdue: every active dated todo due today or earlier. Read on
  // the (status, dueAt) index, so the scan is the overdue items themselves —
  // the `gte(0)` lower bound is what excludes the undated rows, which sort
  // before every number in a Convex index.
  const due = (
    await ctx.db
      .query("dtsTodos")
      .withIndex("by_status_and_due", (q) =>
        q.eq("status", "active").gte("dueAt", 0).lt("dueAt", dayEnd),
      )
      .collect()
  )
    .filter((t) => t.dueAt !== undefined)
    .map((t) => ({
      id: t._id as string,
      statement: t.statement,
      dueAt: t.dueAt as number,
      entryAction: t.entryAction,
      missed: (t.dateOutcomes ?? []).some(
        (o) => o.dueAt === t.dueAt && o.outcome === "missed",
      ),
    }));
  const dueIds = new Set(due.map((d) => d.id));

  // 2. Blocks and calendar events overlapping the calendar day. Both windows
  // open 31 days back — the longest span either table is expected to hold —
  // rather than reading every row ever written before the end of today.
  const blockRows = await ctx.db
    .query("dtsBlocks")
    .withIndex("by_start", (q) =>
      q.gte("start", dayStart - 31 * DAY_MS).lt("start", dayEnd),
    )
    .collect();
  const blocks = await Promise.all(
    blockRows
      .filter((b) => b.end > dayStart)
      .map(async (b) => ({
        start: b.start,
        end: b.end,
        label:
          (await todoOf(b.todoId))?.statement ?? b.category ?? b.note ?? "block",
      })),
  );
  const calendar = (
    await ctx.db
      .query("ttsCalendarEvents")
      .withIndex("by_start", (q) => q.gte("start", dayStart - 31 * DAY_MS).lt("start", dayEnd))
      .collect()
  )
    .filter((e) => e.end > dayStart)
    .map((e) => ({ start: e.start, end: e.end, title: e.title, allDay: e.allDay }));

  // 3. Email captures since the last digest — not the ones already listed as
  // due above (the ready section skips those for the same reason: one item,
  // one line, or the reply path in the due line is the one Tom misses).
  // Newest-first on the source index, then cut at the window. CAP: the newest
  // CAPTURE_SCAN email rows. The window is a night, and a night that captured
  // more than this from email is a mail flood, not a morning read.
  const emailCaptures = (
    await ctx.db
      .query("dtsTodos")
      .withIndex("by_source", (q) => q.eq("source", "email"))
      .order("desc")
      .take(CAPTURE_SCAN)
  )
    .filter(
      (t) => t.createdAt >= since && t.createdAt < now && !dueIds.has(t._id as string),
    )
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((t) => ({ id: t._id as string, statement: t.statement, entryAction: t.entryAction }));

  // 4, 6, 7, 8 read the events since the last digest, oldest first.
  const events = (
    await ctx.db
      .query("dtsEvents")
      .withIndex("by_at", (q) => q.gte("at", since).lt("at", now))
      .order("desc")
      .take(EVENT_SCAN)
  ).reverse();

  const overnight: DigestFacts["overnight"] = [];
  const failures: DigestFacts["failures"] = [];
  const learning: DigestFacts["learning"] = [];
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const sessionId = str(d.sessionId);
    const sessionRowId =
      sessionId !== undefined ? ctx.db.normalizeId("claudeSessions", sessionId) : null;
    const session = sessionRowId ? await ctx.db.get(sessionRowId) : null;
    const sessionBatch =
      (await batchName(session?.batchId)) ??
      (await batchOfTodo(session?.todoId ?? e.todoId));
    const sessionLink = (title: string | undefined) =>
      sessionId !== undefined
        ? `<${SESSION_LINK}${sessionId}|${slackEscape(title ?? "session")}>`
        : slackEscape(title ?? "session");

    switch (e.kind) {
      case "session-created":
        overnight.push({
          batch: sessionBatch,
          text: `session opened: ${sessionLink(str(d.title))}${d.mode === "autonomous" ? " (autonomous)" : ""}`,
        });
        break;
      case "session-outcome": {
        const summary = str(d.summary);
        overnight.push({
          batch: sessionBatch,
          text: `session ${str(d.outcome) ?? "finished"}: ${sessionLink(str(d.title))}${summary ? ` — ${slackEscape(summary)}` : ""}`,
        });
        break;
      }
      case "session-ended":
        if (d.status === "failed") {
          const reason = str(d.endedReason);
          failures.push({
            at: e.at,
            text: `session failed: ${sessionLink(str(d.title))}${reason ? ` — ${slackEscape(reason)}` : ""}`,
          });
        }
        break;
      case "graph-batch-formed":
        overnight.push({
          batch: str(d.statement) ?? null,
          text: "batch formed",
        });
        break;
      case "graph-stored": {
        const batchId = str(d.batchId);
        const counts = ["created", "updated", "retired", "archived"]
          .map((k) => (typeof d[k] === "number" && d[k] !== 0 ? `${d[k]} ${k}` : null))
          .filter((x): x is string => x !== null);
        overnight.push({
          batch: batchId
            ? await batchName(ctx.db.normalizeId("batches", batchId) ?? undefined)
            : null,
          text: `plan stored${counts.length > 0 ? `: ${counts.join(", ")}` : ""}`,
        });
        break;
      }
      case "plan-repair": {
        const batchId = str(d.batchId);
        overnight.push({
          batch:
            (batchId
              ? await batchName(ctx.db.normalizeId("batches", batchId) ?? undefined)
              : null) ?? (await batchOfTodo(e.todoId)),
          text: `plan repair reported: ${slackEscape(str(d.note) ?? "")}`,
        });
        break;
      }
      case "prepared": {
        const todo = await todoOf(e.todoId);
        if (todo) {
          overnight.push({
            batch: await batchName(todo.batchId),
            text: `prepared <${ttsItemLink(todo._id)}|${slackEscape(todo.statement)}>`,
          });
        }
        break;
      }
      case "time-note-resolved": {
        const todo = await todoOf(e.todoId);
        overnight.push({
          batch: await batchName(todo?.batchId),
          text: `time note ${d.status === "applied" ? "applied" : "needs a session"}: ${slackEscape(str(d.result) ?? "")}`,
        });
        break;
      }
      case "calendar-event-created":
        overnight.push({
          batch: null,
          text: `calendar event written: ${slackEscape(str(d.title) ?? "")}`,
        });
        break;
      case LEARNING_CHANGE:
        learning.push({
          id: str(d.id) ?? "",
          file: str(d.file) ?? "",
          before: str(d.before) ?? "",
          after: str(d.after) ?? "",
          evidence: str(d.evidence) ?? "",
        });
        break;
      default:
        // Every job failure is a "-failed" kind ("slack-send-failed" is the
        // Slack door's; the box's jobs report theirs as "job-failed" through
        // POST /tts/job-failed). A Slack failure is named by its SUBJECT, a
        // box job's by the JOB — the same slot, whichever the row carries.
        if (e.kind.endsWith("-failed")) {
          const job = str(d.job);
          const what =
            slackSubjectLabel(d.subject) || (job === undefined ? "" : ` (${job})`);
          failures.push({
            at: e.at,
            text: `${e.kind}${what}: ${slackEscape(str(d.error) ?? "")}`,
          });
        }
    }
  }

  // 5. Ready for Tom (not already listed as due). Read on the readiness index,
  // so the scan is the ready list itself — the shortest list in the record,
  // because a row leaves it the moment Tom rules on it.
  const ready = (
    await ctx.db
      .query("dtsTodos")
      .withIndex("by_readiness", (q) => q.eq("readiness", "ready-for-tom"))
      .collect()
  )
    .filter((t) => t.status === "active" && !dueIds.has(t._id as string))
    .map((t) => ({ id: t._id as string, statement: t.statement, entryAction: t.entryAction }));

  // 7. Rulings from Tom's words since the last digest.
  const rulingRows = await ctx.db
    .query("dtsRulings")
    .withIndex("by_ruled", (q) => q.gte("ruledAt", since).lt("ruledAt", now))
    .collect();
  const rulings: DigestFacts["rulings"] = [];
  for (const r of rulingRows) {
    const source = rulingProvenance(r);
    if (source === null) continue;
    const subject =
      r.todoId !== undefined
        ? `<${ttsItemLink(r.todoId)}|${slackEscape((await todoOf(r.todoId))?.statement ?? "todo")}>`
        : r.batchId !== undefined
          ? slackEscape((await batchName(r.batchId)) ?? "batch")
          : slackEscape(`${r.repo ?? ""}#${r.externalId ?? ""}`);
    rulings.push({
      verdict: r.verdict,
      subject,
      quote: source.quote,
      redirect: r.sentence,
      provenance: source.provenance,
    });
  }

  return {
    day,
    now,
    since,
    due,
    blocks,
    calendar,
    emailCaptures,
    overnight,
    ready,
    failures,
    wikitom: wikitom ?? null,
    rulings,
    learning,
  };
}

// The window's start: the END of the last sent digest's window, else one day
// back. Read from the digest's own "digest-sent" row rather than
// dtsDailyQueues.digestSentAt — a row is written per SEND, and its windowEnd
// is the instant the digest was composed against, so the seconds spent
// composing and posting are inside the next window instead of falling between
// the two. A missed morning is not lost: the next digest simply covers both.
async function digestWindowStart(ctx: QueryCtx, now: number): Promise<number> {
  const row = await lastDigestSent(ctx);
  return row?.windowEnd ?? now - DAY_MS;
}

export const internalComposeDigest = internalQuery({
  // `since` is the window start the sender already read (internalDigestWindow-
  // Start), passed back so one run composes and fetches over the same window.
  // Absent — a manual run, a test — it is read here.
  args: {
    day: v.string(),
    now: v.number(),
    since: v.optional(v.number()),
    // Absent = the caller did not read WikiTom, which the digest reports as
    // unreadable rather than as an empty list.
    wikitom: v.optional(v.union(v.null(), v.array(WIKITOM_COMMIT))),
  },
  handler: async (ctx, { day, now, since: givenSince, wikitom }) => {
    const since = givenSince ?? (await digestWindowStart(ctx, now));
    const facts = await gatherDigestFacts(ctx, { day, now, since, wikitom });
    return {
      text: composeDigest(facts),
      since,
      // Every todo the digest showed, for the "surfaced" instrumentation.
      surfacedTodoIds: [
        ...facts.due.map((d) => d.id),
        ...facts.emailCaptures.map((c) => c.id),
        ...facts.ready.map((r) => r.id),
      ].map((id) => ctx.db.normalizeId("dtsTodos", id)!),
    };
  },
});
