import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { recordMissedKeepingDate } from "./tts";
import {
  DAY_MS,
  READINESS_VALUES,
  RETIRED_READINESS_VALUES,
  buildDoneSet,
  countdownText,
  isPrepared,
  isReadyForTom,
  nyCalendarDayBoundsUtc,
  nyHhmm,
  ttsItemLink,
  ttsTabLink,
  type SlackSubject,
  type TtsTab,
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
//   9. model-of-Tom lines the nightly job wrote (kind "learning-change"),
//      each with its id — a reply in this thread naming the id is the
//      objection — and the lines it reverted or could not revert on an
//      earlier objection ("learning-reverted", "learning-revert-failed")
//
// A digest is a morning read, not the list: an item is one line (clipToLine)
// and a section prints at most SECTION_ITEM_CAP of them before naming what is
// left on the /tts page.

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

// The nightly job's model-of-Tom lines (worker/jobs/nightly.mjs learningStep
// writes them; the digest prints each with its id, which is what a reply in
// the digest thread names to object — convex/ttsSlack.ts).
//   kind "learning-change",        data { id, file, section, before, after, evidence, modelOfTomCommit }
//   kind "learning-reverted",      data { id, file, before, after, objection, modelOfTomCommit }
//   kind "learning-revert-failed", data { id?, file?, reason, objection }
export const LEARNING_CHANGE = "learning-change";
export const LEARNING_REVERTED = "learning-reverted";
export const LEARNING_REVERT_FAILED = "learning-revert-failed";

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
    // "changed": a line the job wrote; "reverted": one it took back on
    // Tom's objection (before is the learned line, after what it restored);
    // "revert-failed": an objection it could not apply, with the reason.
    status: "changed" | "reverted" | "revert-failed";
    id: string;
    file: string;
    before: string;
    after: string;
    evidence: string;
    reason?: string;
  }[];
};

// Slack mrkdwn reserves these three inside message text and link labels.
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── One item, one line ───────────────────────────────────────────────────────
// The digest is a morning read and the full list lives on the /tts page, so an
// item contributes ONE line to it. A statement is written for the page, not for
// Slack: a code todo's runs to 300 characters over several sentences, and the
// first live digest (2026-09-06) printed every one of them in full — ten Slack
// messages Tom had to scroll. Every statement and every entry action the digest
// prints goes through clipToLine, which is the only place the length of a
// printed statement is decided.
export const ITEM_TEXT_CHARS = 110;

/**
 * A statement or an entry action as one line: whitespace collapsed, then cut at
 * whichever comes first — the end of the first sentence, or ITEM_TEXT_CHARS at
 * a word boundary — with "…" when anything was dropped. A sentence is kept
 * whole (its full stop included); only the character cut needs a word boundary.
 */
export function clipToLine(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  const sentence = text.match(/[.!?](?=\s|$)/);
  if (sentence?.index !== undefined && sentence.index < ITEM_TEXT_CHARS) {
    const end = sentence.index + 1;
    return end >= text.length ? text : `${text.slice(0, end)}…`;
  }
  if (text.length <= ITEM_TEXT_CHARS) return text;
  const cut = text.slice(0, ITEM_TEXT_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function itemLine(item: { id: string; statement: string; entryAction?: string }) {
  const entry = item.entryAction
    ? ` — ${slackEscape(clipToLine(item.entryAction))}`
    : "";
  return `- <${ttsItemLink(item.id)}|${slackEscape(clipToLine(item.statement))}>${entry}`;
}

// ── A section, and what it leaves for the page ───────────────────────────────
// The digest is a morning read; the full list lives on the /tts page. So a
// section prints at most SECTION_ITEM_CAP items and then ONE line saying how
// many it did not print, linking to the tab of the page where the rest is read.
// The three sections whose items are not on that page — job failures, WikiTom
// commits, model-of-Tom lines — say the count and link nowhere.
export const SECTION_ITEM_CAP = 12;

type Section = {
  header: string;
  lines: string[]; // already capped, count line included
  count: number; // items the section holds, printed or not
  tab: TtsTab | null; // where the rest is read
};

function moreLine(hidden: number, tab: TtsTab | null): string {
  return tab === null
    ? `- +${hidden} more`
    : `- <${ttsTabLink(tab)}|+${hidden} more on the page>`;
}

function section(header: string, items: string[], tab: TtsTab | null): Section {
  const lines = items.slice(0, SECTION_ITEM_CAP);
  if (items.length > lines.length) {
    lines.push(moreLine(items.length - lines.length, tab));
  }
  return { header, lines, count: items.length, tab };
}

function digestSections(f: DigestFacts): Section[] {
  const sections: Section[] = [];

  // OVERDUE-LONGEST FIRST (ascending date), because this section is the one
  // that overflows and what the cap drops has to be the newest: an item three
  // weeks late is the one Tom needs named in the morning.
  const dueLines = [...f.due]
    .sort((a, b) => a.dueAt - b.dueAt)
    .map((d) => {
      const replyPath = d.missed ? " — missed: reply done, or a new date" : "";
      return `${itemLine(d)} — ${countdownText(d.dueAt, f.now)}${replyPath}`;
    });
  // The one section that is printed even when empty (sends-even-when-empty).
  sections.push(
    f.due.length === 0
      ? { header: "*Due and overdue*", lines: ["- nothing"], count: 0, tab: null }
      : section("*Due and overdue*", dueLines, "everything"),
  );

  const spans = [
    ...f.blocks.map((b) => ({ start: b.start, end: b.end, text: b.label, allDay: false })),
    ...f.calendar.map((e) => ({ start: e.start, end: e.end, text: e.title, allDay: e.allDay })),
  ].sort((a, b) => a.start - b.start);
  if (spans.length > 0) {
    sections.push(
      section(
        "*Blocks and calendar*",
        spans.map((s) => {
          const when = s.allDay ? "all day" : `${nyHhmm(s.start)}–${nyHhmm(s.end)}`;
          return `- ${when} ${slackEscape(clipToLine(s.text))}`;
        }),
        "calendar",
      ),
    );
  }

  if (f.emailCaptures.length > 0) {
    sections.push(
      section("*Captured from email*", f.emailCaptures.map(itemLine), "everything"),
    );
  }

  if (f.overnight.length > 0) {
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
    // The cap counts EVENTS, not the batch headings between them: a heading is
    // printed only when at least one of its events fits under the cap.
    const lines: string[] = [];
    let shown = 0;
    for (const key of keys) {
      const room = SECTION_ITEM_CAP - shown;
      if (room <= 0) break;
      const texts = groups.get(key) ?? [];
      lines.push(`_${key === null ? "no batch" : slackEscape(key)}_`);
      for (const text of texts.slice(0, room)) lines.push(`- ${text}`);
      shown += Math.min(room, texts.length);
    }
    if (f.overnight.length > shown) {
      lines.push(moreLine(f.overnight.length - shown, "batches"));
    }
    sections.push({
      header: "*Overnight, by batch*",
      lines,
      count: f.overnight.length,
      tab: "batches",
    });
  }

  if (f.ready.length > 0) {
    sections.push(section("*Ready for you*", f.ready.map(itemLine), "everything"));
  }

  if (f.failures.length > 0) {
    sections.push(
      section(
        "*Job failures*",
        [...f.failures]
          .sort((a, b) => a.at - b.at)
          .map((x) => `- ${nyHhmm(x.at)} ${x.text}`),
        null,
      ),
    );
  }

  if (f.wikitom === null) {
    sections.push({ header: WIKITOM_UNREADABLE, lines: [], count: 0, tab: null });
  } else if (f.wikitom.length > 0) {
    sections.push(
      section(
        "*WikiTom commits*",
        f.wikitom.map(
          (c) =>
            `- <${c.url}|${slackEscape(c.sha.slice(0, 7))}> ${slackEscape(c.message)} — ${slackEscape(c.author)}`,
        ),
        null,
      ),
    );
  }

  if (f.rulings.length > 0) {
    sections.push(
      section(
        "*Rulings from your words*",
        f.rulings.map((r) => {
          const quote = r.quote ? `: "${slackEscape(r.quote)}"` : "";
          const redirect = r.redirect
            ? ` — redirect: ${slackEscape(r.redirect)}`
            : "";
          return `- ${r.verdict} on ${r.subject}${quote}${redirect} (${slackEscape(r.provenance)})`;
        }),
        "batches",
      ),
    );
  }

  if (f.learning.length > 0) {
    sections.push(
      section(
        "*Model of Tom*",
        f.learning.map((l) => {
          const id = `[${slackEscape(l.id)}]`;
          const file = slackEscape(l.file);
          switch (l.status) {
            case "reverted":
              return `- ${id} ${file}: reverted on your objection — "${slackEscape(l.before)}"${l.after === "" ? "" : ` → "${slackEscape(l.after)}"`}`;
            case "revert-failed":
              return `- ${id} ${file}: NOT reverted — ${slackEscape(l.reason ?? "")}`;
            default:
              return l.before === ""
                ? `- ${id} ${file}: + "${slackEscape(l.after)}" (${slackEscape(l.evidence)})`
                : `- ${id} ${file}: "${slackEscape(l.before)}" → "${slackEscape(l.after)}" (${slackEscape(l.evidence)})`;
          }
        }),
        null,
      ),
    );
  }

  return sections;
}

function render(day: string, sections: Section[]): string {
  const lines: string[] = [`*TTS digest — ${day}*`];
  for (const s of sections) lines.push("", s.header, ...s.lines);
  return lines.join("\n");
}

// ── One Slack message ────────────────────────────────────────────────────────
// Slack takes 4,000 characters in a message and cuts what is longer into more
// of them: the first live digest (2026-09-06) arrived as TEN. The two caps
// above make that unlikely; this one makes it impossible. Composition is
// finished first, and if the whole thing is still over DIGEST_MAX_CHARS the
// sections are reduced to their count line from the LAST one back — due and
// overdue, the first, is never reduced, and the sections nearest it are the
// ones Tom reads. `truncated` travels to the "digest-sent" row so a week of
// digests can say how often the morning did not fit.
export const DIGEST_MAX_CHARS = 3_900;

export function composeDigest(f: DigestFacts): {
  text: string;
  truncated: boolean;
} {
  const sections = digestSections(f);
  let text = render(f.day, sections);
  if (text.length <= DIGEST_MAX_CHARS) return { text, truncated: false };
  for (let i = sections.length - 1; i >= 1; i--) {
    const s = sections[i];
    if (s.lines.length <= 1) continue; // already one line, or none
    sections[i] = { ...s, lines: [moreLine(s.count, s.tab)] };
    text = render(f.day, sections);
    if (text.length <= DIGEST_MAX_CHARS) return { text, truncated: true };
  }
  // Every section but the first reduced and still over: the first section alone
  // is longer than a Slack message, so it is cut at the character. Twelve items
  // cannot reach this today; a change to SECTION_ITEM_CAP could.
  return { text: `${text.slice(0, DIGEST_MAX_CHARS - 1)}…`, truncated: true };
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
      case LEARNING_REVERTED:
      case LEARNING_REVERT_FAILED:
        learning.push({
          status:
            e.kind === LEARNING_CHANGE
              ? "changed"
              : e.kind === LEARNING_REVERTED
                ? "reverted"
                : "revert-failed",
          id: str(d.id) ?? "?",
          file: str(d.file) ?? "",
          before: str(d.before) ?? "",
          after: str(d.after) ?? "",
          evidence: str(d.evidence) ?? "",
          reason: str(d.reason),
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

  // 5. Ready for Tom (not already listed as due) — ruling 18's computation
  // (ttsShared.isReadyForTom: prepared, active, awake, every need done). Read
  // on the readiness index for each spelling that READS as prepared (the
  // value and, until NARROW, "ready-for-tom"; "preparing" reads as unprepared
  // and is never listed), so the scan is the prepared list itself — the
  // shortest list in the record. A row's needs are fetched by id (bounded
  // by MAX_NEEDS) to build the done set, instead of collecting the table.
  const preparedRows: Doc<"dtsTodos">[] = [];
  for (const spelling of [...READINESS_VALUES, ...RETIRED_READINESS_VALUES]) {
    if (!isPrepared(spelling)) continue;
    preparedRows.push(
      ...(await ctx.db
        .query("dtsTodos")
        .withIndex("by_readiness", (q) => q.eq("readiness", spelling))
        .collect()),
    );
  }
  const ready: DigestFacts["ready"] = [];
  for (const t of preparedRows) {
    if (t.status !== "active" || dueIds.has(t._id as string)) continue;
    const needRows: Doc<"dtsTodos">[] = [];
    for (const id of t.needs ?? []) {
      const need = await ctx.db.get(id);
      if (need) needRows.push(need);
    }
    if (!isReadyForTom(t, buildDoneSet(needRows), now)) continue;
    ready.push({ id: t._id as string, statement: t.statement, entryAction: t.entryAction });
  }

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
    const { text, truncated } = composeDigest(facts);
    return {
      text,
      // Whether sections were reduced to a count line to fit one Slack
      // message; the sender records it on the "digest-sent" row.
      truncated,
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
