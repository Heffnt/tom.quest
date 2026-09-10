// THE ONE COMPOSER. Every message TTS sends Tom on Slack is built here and
// rendered by renderSlack below (slack-design.md §2, Tom 2026-09-09).
//
// IMPORT RESTRICTION, LOAD-BEARING: this file imports NOTHING. Not
// `convex/values`, not `./_generated/*`, not `./ttsShared`. The evals runner
// transpiles it with esbuild and imports it outside the Convex runtime
// (slack-design.md §6.2), and the Fable writer on the box (worker/jobs/
// write-slack.mjs) verifies its drafts with the same functions. A single
// Convex import would make both impossible. The cost is two literal URL
// prefixes duplicated from ttsShared; convex/ttsCompose.test.ts asserts they
// are equal, which is the guard the one-copy rule actually needs.
//
// Nothing here formats a time or a date: the fact gatherer (convex/
// ttsDigest.ts, plain runtime, which may import ttsShared) hands in every
// countdown and every clock span already spelled. This file turns facts into
// sentences and nothing else.

// ── The form ─────────────────────────────────────────────────────────────────

/** THE FORM (Tom, 2026-09-09). One shape for every message TTS sends.
 *
 *  firstLine  — what this is and what he should do, or that there is nothing
 *               to do. It is the only line that may carry no link, and the only
 *               line that may carry a link INSIDE the sentence (linked()).
 *  lines      — everything after. An "item" line is one complete statement in
 *               display text carrying one link. A "lead" line is one complete
 *               statement introducing the item lines beneath it. A "note" line
 *               is the reply invitation, and it is emitted ONLY when the reply
 *               route is live (§5).
 *  more       — where the rest is read. NEVER a bare "+N more": it is a whole
 *               sentence with a link, and it is rendered as the last item line.
 */
export type Link = { text: string; url: string };

/** `section` names which run of the morning message a line belongs to. Every
 *  other message kind has one run and leaves it undefined. */
export type Line =
  | { role: "lead"; text: string; section?: string }
  | { role: "item"; text: string; url: string; section?: string }
  | { role: "note"; text: string; section?: string };

export type Message = {
  firstLine: string;
  lines: Line[];
  more?: Link;
};

/** A statement is at most this long. 140 is one Slack line on a phone in
 *  portrait; the digest's own cut was 110 characters IN THE MIDDLE OF A
 *  SENTENCE, which is why three of the last three mornings carried lines
 *  ending "…your own two-week…". */
export const LINE_CHARS = 140;

/** The first line carries two sentences — what this is, and what to do — and
 *  cutting it is cutting the one line he always reads. */
export const FIRST_LINE_CHARS = 220;

/** Slack cuts a message over 4,000 characters into several. */
export const MESSAGE_MAX_CHARS = 3_900;

/** The morning message's sections, nearest to him first. This ORDER is the
 *  truncation policy: `fit` reduces the LAST run of lines to one sentence,
 *  then the next-to-last, and never touches the first.
 *
 *  The old composer had the same algorithm and got the wrong answer, because
 *  the section that mattered most ("Ready for you") sat second-to-last in a
 *  nine-section order — so on all three of the last three mornings it was
 *  reduced to the single line "+667 more on the page" while eighteen lines of
 *  "plan stored" survived. The fix is the ORDER, not the algorithm.
 *
 *  The calendar run is printed between "objections" and "overnight" and is not
 *  named here: it is his day, not a ranked list, and it has no page of its own
 *  to send him to. `fit` reduces it in printed order like any other run.
 */
export const SECTION_ORDER = ["today", "objections", "overnight", "broken"] as const;

/** Per-section item caps, before the whole-message fit. Nearest him, most
 *  room. */
export const SECTION_CAPS = {
  today: 12,
  objections: 12,
  calendar: 12,
  overnight: 6,
  broken: 4,
} as const;

// ── Display text ─────────────────────────────────────────────────────────────

/** Slack mrkdwn reserves these three inside message text and link labels. The
 *  ONE copy: convex/ttsDigest.ts and convex/ttsHourlyText.ts each had their
 *  own, byte-identical (VQC C1). */
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A link inside a sentence, for firstLine only. */
export function linked(text: string, url: string): string {
  return `<${url}|${slackEscape(text)}>`;
}

/**
 * One complete statement in display text. Whitespace collapsed; ended with a
 * full stop when it ends with none; and, when it is longer than LINE_CHARS,
 * cut at the last clause boundary before the cap — a comma, a semicolon, a
 * colon or an em dash — never mid-word and never mid-thought, then ended with
 * a full stop. NO ELLIPSIS IS EVER PRINTED: a sentence that stops with "…" is
 * a sentence Tom has to open the page to finish, which is the point of the
 * message lost.
 *
 * A statement with no clause boundary before the cap is cut at the last word
 * boundary and ended with a full stop; the composer that produced it is
 * writing badly and the eval (§6) is what catches it.
 */
export function statement(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim().replace(/…/g, "");
  if (collapsed === "") return "";
  const ended = /[.!?]$/.test(collapsed) ? collapsed : `${collapsed}.`;
  if (ended.length <= LINE_CHARS) return ended;
  // The window is the text that could still fit, less the full stop this
  // function always adds back.
  const window = ended.slice(0, LINE_CHARS - 1);
  const clause = Math.max(
    window.lastIndexOf(","),
    window.lastIndexOf(";"),
    window.lastIndexOf(":"),
    window.lastIndexOf("—"),
  );
  // A boundary in the first two fifths of the line throws away more than it
  // saves: "0: Rework the credential file helper ..." would become "0.". Past
  // that, cut at the clause; before it, cut at the last word.
  const cut = clause >= Math.floor(LINE_CHARS * 0.4) ? clause : window.lastIndexOf(" ");
  const kept = (cut > 0 ? window.slice(0, cut) : window).trimEnd();
  return `${kept.replace(/[\s,;:—.!?]+$/, "")}.`;
}

// ── The checker ──────────────────────────────────────────────────────────────

const BARE_ID = /^[A-Za-z0-9]{20,}\b/;
const BARE_MORE = /^\+?\d+ more$/i;
const N_MORE = /\+\s?\d+\s+more/i;

function endsAsSentence(text: string): boolean {
  return /[.!?]$/.test(text.trim());
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\/[^\s<>|]+$/.test(url);
}

/** Every way a message can break the form. Empty array = it obeys it.
 *  Faults, each naming the offending line:
 *    - an item line with no url, or a url that is not http(s)
 *    - a line longer than LINE_CHARS (firstLine is capped at FIRST_LINE_CHARS)
 *    - a line that does not end in "." "?" or "!"
 *    - a line whose text is (or begins with) a bare id
 *    - a line matching /^\+?\d+ more$/i or containing "+N more" with no link
 *    - a lead line with no item line under it
 *    - more than one note line in a section, or a note line when canReply is
 *      false, or a note line that is not last in its section
 *    - a rendered message longer than MESSAGE_MAX_CHARS
 *  Called by every sender before posting: a fault is logged and the LINE is
 *  dropped, never the message — a malformed statement must not cost Tom the
 *  morning. */
export function checkMessage(m: Message, opts: { canReply: boolean }): string[] {
  const faults: string[] = [];
  const first = m.firstLine.trim();
  if (first === "") {
    faults.push("the first line is empty");
  } else {
    if (first.length > FIRST_LINE_CHARS) {
      faults.push(`the first line is ${first.length} characters, over ${FIRST_LINE_CHARS}`);
    }
    if (!endsAsSentence(first)) faults.push("the first line is not a complete statement");
  }
  m.lines.forEach((line, index) => faults.push(...lineFaults(line, index, opts)));
  for (const run of sectionRuns(m.lines)) {
    const lines = m.lines.slice(run.start, run.end);
    const head = lines[0];
    if (head.role === "lead" && !lines.some((line) => line.role === "item")) {
      faults.push(`${lineName(head, run.start)} has no item line under it`);
    }
    const notes = lines.filter((line) => line.role === "note");
    if (notes.length > 1) {
      faults.push(`the section at ${lineName(head, run.start)} has ${notes.length} note lines`);
    }
    if (notes.length === 1 && lines[lines.length - 1].role !== "note") {
      faults.push(`the note line in the section at ${lineName(head, run.start)} is not last in it`);
    }
  }
  if (m.more !== undefined && !isHttpUrl(m.more.url)) {
    faults.push("the more line has no http(s) link");
  }
  const rendered = renderSlack(m);
  if (rendered.length > MESSAGE_MAX_CHARS) {
    faults.push(`the rendered message is ${rendered.length} characters, over ${MESSAGE_MAX_CHARS}`);
  }
  return faults;
}

function lineName(line: Line, index: number): string {
  return `line ${index + 1} ("${line.text.slice(0, 40)}")`;
}

/** The faults a line has ON ITS OWN, without its neighbours. Split out so a
 *  sender can drop exactly the offending lines (dropFaultyLines below). */
function lineFaults(line: Line, index: number, opts: { canReply: boolean }): string[] {
  const faults: string[] = [];
  const name = lineName(line, index);
  if (line.text.trim() === "") faults.push(`${name} is empty`);
  if (line.text.length > LINE_CHARS) {
    faults.push(`${name} is ${line.text.length} characters, over ${LINE_CHARS}`);
  }
  if (!endsAsSentence(line.text)) faults.push(`${name} is not a complete statement`);
  if (BARE_ID.test(line.text.trim())) faults.push(`${name} begins with a bare id`);
  if (BARE_MORE.test(line.text.trim())) faults.push(`${name} is a bare "+N more"`);
  if (line.role !== "item" && N_MORE.test(line.text)) {
    faults.push(`${name} carries "+N more" with no link`);
  }
  if (line.role === "item" && !isHttpUrl(line.url)) faults.push(`${name} has no http(s) link`);
  if (line.role === "note" && !opts.canReply) {
    faults.push(`${name} invites a reply the route cannot receive`);
  }
  return faults;
}

/** A FAULT COSTS THE LINE, NEVER THE MESSAGE. Every sender calls this before
 *  posting: each line that breaks the form on its own is dropped, a lead left
 *  with no item under it goes with them, and the faults come back for the
 *  caller to log. A message that is still over MESSAGE_MAX_CHARS afterwards is
 *  cut by `fit`; one that still breaks the form is posted anyway, because a
 *  malformed statement must not cost Tom the morning. */
export function dropFaultyLines(
  m: Message,
  opts: { canReply: boolean },
): { message: Message; faults: string[] } {
  const faults = checkMessage(m, opts);
  if (faults.length === 0) return { message: m, faults };
  const kept = m.lines.filter((line, index) => lineFaults(line, index, opts).length === 0);
  const pruned = kept.filter((line, index) => {
    if (line.role !== "lead") return true;
    for (let i = index + 1; i < kept.length && kept[i].role !== "lead"; i += 1) {
      if (kept[i].role === "item") return true;
    }
    return false;
  });
  return { message: { ...m, lines: pruned }, faults };
}

// ── The renderer ─────────────────────────────────────────────────────────────

/** The ONE renderer. Every message TTS sends is this function's output.
 *   firstLine
 *   <blank>
 *   lead
 *   - <url|item text>
 *   - <url|item text>
 *   - <more.url|more.text>
 *   <blank>
 *   lead …
 *   note
 *  An item line is the WHOLE statement as the link label: a statement split
 *  into a blue fragment and a grey tail is two things to read, and a line whose
 *  label is a fragment is a line whose link target is guessed.
 *
 *  There is no title line and no *bold* section header anywhere.
 *  "*TTS digest — 2026-09-09*" spent the most prominent line in the message on
 *  a label; Slack already stamps the channel and the time. */
export function renderSlack(m: Message): string {
  const out = [m.firstLine];
  for (const line of m.lines) {
    if (line.role === "lead") out.push("", line.text);
    else if (line.role === "item") out.push(`- <${line.url}|${slackEscape(line.text)}>`);
    else out.push(line.text);
  }
  if (m.more !== undefined) out.push(`- <${m.more.url}|${slackEscape(m.more.text)}>`);
  return out.join("\n");
}

// ── Truncation: distance from him ────────────────────────────────────────────

/** A run is a lead and every line under it, or (for a message with no lead at
 *  all) the whole list. A section is not a type: giving every kind a section
 *  type would put a container in five messages that have one lead each. */
function sectionRuns(lines: Line[]): { start: number; end: number }[] {
  const starts = lines
    .map((line, index) => (line.role === "lead" ? index : -1))
    .filter((index) => index >= 0);
  if (starts.length === 0) return lines.length === 0 ? [] : [{ start: 0, end: lines.length }];
  const runs: { start: number; end: number }[] = [];
  if (starts[0] > 0) runs.push({ start: 0, end: starts[0] });
  starts.forEach((start, i) => runs.push({ start, end: starts[i + 1] ?? lines.length }));
  return runs;
}

/** Reduce until it fits: each run to its lead plus ONE whole sentence with a
 *  link, from the last back; the first run is never reduced; then, still over,
 *  lines are dropped from the end. Returns whether anything was reduced
 *  (recorded on the digest-sent row as `truncated`, as today). */
export function fit(
  m: Message,
  max: number = MESSAGE_MAX_CHARS,
): { message: Message; truncated: boolean } {
  let current: Message = { ...m, lines: [...m.lines] };
  if (renderSlack(current).length <= max) return { message: current, truncated: false };
  let truncated = false;
  for (let guard = 0; guard < 100; guard += 1) {
    const runs = sectionRuns(current.lines);
    // The last run that is still more than a lead and one line under it.
    let target = -1;
    for (let i = runs.length - 1; i >= 1; i -= 1) {
      if (runs[i].end - runs[i].start > 2) {
        target = i;
        break;
      }
    }
    if (target === -1) break;
    const { start, end } = runs[target];
    const lines = current.lines.slice(start, end);
    const lead = lines[0];
    const items = lines.filter((line): line is Extract<Line, { role: "item" }> => line.role === "item");
    if (items.length === 0) break;
    // A reduced run is ONE WHOLE SENTENCE with a link, never a count line.
    const reduced: Line[] = [
      lead,
      {
        role: "item",
        section: lead.section,
        text: statement(
          `${items.length} more ${items.length === 1 ? "line is" : "lines are"} on the page`,
        ),
        url: items[items.length - 1].url,
      },
    ];
    current = {
      ...current,
      lines: [...current.lines.slice(0, start), ...reduced, ...current.lines.slice(end)],
    };
    truncated = true;
    if (renderSlack(current).length <= max) return { message: current, truncated };
  }
  // Every run but the first reduced and still over: lines go from the end
  // rather than a sentence being cut in half. NO ELLIPSIS, at any length.
  while (current.lines.length > 0 && renderSlack(current).length > max) {
    current = { ...current, lines: current.lines.slice(0, -1) };
    truncated = true;
  }
  return { message: current, truncated };
}

// ── The dedup index — one appearance per item per day ────────────────────────

/** THE ASK: what a message wants from Tom. Three values; no message prints it.
 *    "act"    — look at this today. The morning's today section, and a
 *               needs-you thread.
 *    "object" — revert this or let it stand. A decision line, and the morning
 *               objection list.
 *    null     — nothing is wanted. Hourly, broken, the #dump reply: never
 *               claimed, never suppressed.
 *  The index is per ASK, not per item alone. An item may be BOTH something to
 *  do today and the subject of a decision taken about it, and suppressing the
 *  second would silence the objection. */
export type SlackAsk = "act" | "object";

/** dtsEvents kind. key = `<day>:<ask>:<itemId>`, day = ttsDayKey (rolls at
 *  5 a.m. New York). */
export const SLACK_CLAIMED = "slack-claimed";

export function claimKey(day: string, ask: SlackAsk, itemId: string): string {
  return `${day}:${ask}:${itemId}`;
}

// ── The links ────────────────────────────────────────────────────────────────
// The one copy of each lives in convex/ttsShared.ts, which this file may not
// import (see the header). convex/ttsCompose.test.ts asserts they agree.

const ITEM_URL = "https://tom.quest/tts?item=";
export const TAB_EVERYTHING = "https://tom.quest/tts?tab=everything";
export const TAB_BATCHES = "https://tom.quest/tts?tab=batches";
export const TAB_CALENDAR = "https://tom.quest/tts?tab=calendar";
const SESSION_URL = "https://www.tom.quest/sessions?session=";

export function itemUrl(todoId: string): string {
  return `${ITEM_URL}${todoId}`;
}
export function sessionUrl(sessionId: string): string {
  return `${SESSION_URL}${sessionId}`;
}

// ── The facts each kind is composed from ─────────────────────────────────────

export type TodayItem = {
  id: string;
  statement: string;
  entryAction?: string;
  /** Already spelled by the gatherer: "Ten days late.", "Due today." */
  countdown?: string;
  dueAt?: number;
};

/** delegate-design.md §2.2's ObjectionFact, as this composer needs it. The
 *  delegate itself is built on branch uac/delegate; these rows are read by
 *  kind when they are there and nothing is printed when they are not. */
export type ObjectionFact = {
  askId: string;
  todoId?: string;
  decision: string;
  reason?: string;
  refused?: boolean;
  refusedBecause?: string;
  fallback?: string;
  subject?: string;
};

/** One line per BATCH, from every event in the window that named it. The
 *  counts are summed across the window's "graph-stored" rows, so a night of
 *  five plan-stored events on one batch is ONE sentence about that batch, not
 *  five lines saying "plan stored".
 *  Sessions contribute the two facts Tom can use — how many finished, and
 *  whether any is still running — never "session opened".
 *  A batch with no counted change is still listed once, saying so: the batch
 *  names are how he recognises what the night was about. */
export type BatchOutcome = {
  batchId: string | null; // null = the batch-less tail
  statement: string; // the batch's own statement
  added: number;
  reworked: number;
  dropped: number;
  finished: number; // sessions with a recorded outcome
  running: boolean;
};

export type BrokenFact = {
  /** What broke and what it means for him, in one sentence. */
  statement: string;
  /** The detail, as a statement, when there is a link to hang it on. */
  detail?: string;
  url?: string;
  /** How many times it failed in the window; 1 prints no count. */
  count?: number;
};

export type CalendarSpan = {
  title: string;
  /** Already spelled: "16:00 to 17:00". Empty for an all-day entry. */
  when: string;
  allDay: boolean;
};

export type TodayFacts = {
  day: string;
  /** Dated-or-late first (oldest date first), then ready items. */
  today: TodayItem[];
  /** How many of `today` carry a date that has passed. */
  lateCount: number;
  /** "ten days", for the first line. Absent when nothing is late. */
  oldestLateBy?: string;
  /** Ready items not printed, and where the rest is read. */
  readyBeyond: number;
  calendar: CalendarSpan[];
  /** One sentence naming the shape of the day; absent for no calendar. */
  calendarLead?: string;
  objections: ObjectionFact[];
  objectionsBeyond?: number;
  overnight: BatchOutcome[];
  /** Batches planned and finished overnight, for the overnight lead. */
  batchesPlanned: number;
  batchesFinished: number;
  broken: BrokenFact[];
};

export type NeedsYouFacts = {
  todoId: string;
  statement: string;
  entryAction?: string;
  reason: string;
  sourceUrl?: string | null;
};

export type DecisionFact = ObjectionFact;

export type CaptureFact = { todoId: string; statement: string };

export type ContinuedFact = {
  sessionId: string;
  title: string;
  /** The raw status value; never printed, looked up below. */
  status: string;
};

// ── The hourly facts (moved here from convex/ttsHourlyText.ts, unchanged) ────

export type RunningSession = {
  sessionId: string;
  title: string;
  kind: string;
  mode: string;
  status: string;
  statement: string | null; // the todo or batch it is on
  batchId: string | null;
  elapsedMs: number;
};

export type BatchWorked = {
  batchId: string;
  statement: string;
  sessions: number;
  workerEvents: number;
};

export type ChangeKind =
  | "captured"
  | "done"
  | "archived"
  | "ruling"
  | "date-outcome"
  | "failure";

export type Change = {
  kind: ChangeKind;
  at: number;
  text: string; // the todo's statement, the session's title, or the failure
  detail: string | null; // verdict, outcome, source, error
  link: string | null;
};

export type HourlyFacts = {
  now: number;
  since: number;
  /** "13:00", already spelled; absent when the window is the last hour. */
  sinceLabel?: string;
  running: RunningSession[];
  batches: BatchWorked[];
  changes: Change[];
};

export function elapsedText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}m`;
}

export function isQuietHour(f: HourlyFacts): boolean {
  return f.running.length === 0 && f.batches.length === 0 && f.changes.length === 0;
}

// ── Sentence builders ────────────────────────────────────────────────────────

const NUMBER_WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

/** Small counts read as words at the head of a sentence; large ones as
 *  numerals, because "six hundred and sixty-seven" is not something he scans. */
export function countWord(n: number): string {
  return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function stripStop(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
}

/** The today section's line: the statement, the first move, and how late it
 *  is — all inside one sentence, never three em-dash clauses. */
export function todayLine(item: TodayItem): string {
  const action = item.entryAction ? `: ${stripStop(item.entryAction)}.` : ".";
  const countdown = item.countdown ? ` ${stripStop(item.countdown)}.` : "";
  return statement(`${capitalise(stripStop(item.statement))}${action}${countdown}`);
}

/** delegate-design.md §2.4's line, returning a Line's parts rather than a
 *  string. The numbering is the PRINTED order and starts at 1, which is what a
 *  reply of "revert 2" names. */
export function objectionLine(o: ObjectionFact, n: number): { text: string; url: string } {
  const url = o.todoId ? itemUrl(o.todoId) : TAB_BATCHES;
  if (o.refused) {
    const because = o.refusedBecause ? ` — ${stripStop(o.refusedBecause)}` : "";
    return {
      text: statement(`${n}. REFUSED and parked: it would have ${stripStop(o.decision)}${because}`),
      url,
    };
  }
  const because = o.reason ? `, because ${stripStop(o.reason)}` : "";
  return { text: statement(`${n}. ${capitalise(stripStop(o.decision))}${because}`), url };
}

/** `{statement} gained {added} items, reworked {reworked} and dropped
 *  {dropped}.` with each clause omitted at zero, `{statement} was planned and
 *  gained nothing.` when all are zero, and `, and one session is still on it`
 *  appended when `running`. */
export function overnightLine(o: BatchOutcome): string {
  const clauses: string[] = [];
  if (o.added > 0) clauses.push(`gained ${o.added} ${plural(o.added, "item", "items")}`);
  if (o.reworked > 0) clauses.push(`reworked ${o.reworked}`);
  if (o.dropped > 0) clauses.push(`dropped ${o.dropped}`);
  if (o.finished > 0) {
    clauses.push(`finished ${o.finished} ${plural(o.finished, "session", "sessions")}`);
  }
  const body =
    clauses.length === 0
      ? `${stripStop(o.statement)} was planned and gained nothing`
      : `${stripStop(o.statement)} ${joinClauses(clauses)}`;
  return statement(`${body}${o.running ? ", and one session is still on it" : ""}`);
}

function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** WHAT IT MEANS FOR HIM FIRST, then the detail, then how many times — in one
 *  sentence, so `statement` cuts the detail before it cuts the meaning. */
export function brokenLine(b: BrokenFact): string {
  const detail = b.detail === undefined ? "" : ` ${stripStop(b.detail)}.`;
  const times = b.count !== undefined && b.count > 1 ? ` It has failed ${b.count} times.` : "";
  return statement(`${stripStop(b.statement)}.${detail}${times}`);
}

/** The calendar's own line. All-day entries say so; the rest name their span. */
export function calendarLine(span: CalendarSpan): string {
  return statement(
    span.allDay ? `${stripStop(span.title)} runs all day.` : `${stripStop(span.title)} runs ${span.when}.`,
  );
}

// ── Assembly helpers ─────────────────────────────────────────────────────────

type Item = { text: string; url: string };

function pushRun(
  lines: Line[],
  section: string,
  lead: string,
  items: Item[],
  cap: number,
  more?: Item,
): void {
  if (items.length === 0 && more === undefined) return;
  lines.push({ role: "lead", section, text: statement(lead) });
  for (const item of items.slice(0, cap)) {
    lines.push({ role: "item", section, text: statement(item.text), url: item.url });
  }
  if (items.length > cap) {
    const hidden = items.length - cap;
    lines.push({
      role: "item",
      section,
      text: statement(`${hidden} more ${plural(hidden, "line is", "lines are")} on the page`),
      url: items[cap].url,
    });
  }
  if (more !== undefined) {
    lines.push({ role: "item", section, text: statement(more.text), url: more.url });
  }
}

function note(lines: Line[], section: string, canReply: boolean, text: string): void {
  if (canReply) lines.push({ role: "note", section, text: statement(text) });
}

// ── The seven kinds ──────────────────────────────────────────────────────────

/**
 * The morning message. Runs today → objection list → the calendar → done
 * overnight → broken, fits one Slack message, and shrinks the sections
 * furthest from him first.
 *
 * OUTCOMES, NEVER LOGGED EVENTS: the overnight run prints one line per batch
 * saying what the batch now is. "plan stored", "created", "retired", "session
 * opened" and "worker event" appear in no message.
 *
 * This is the TEMPLATE. Since Tom's 2026-09-09 amendment the morning message
 * is normally written by a Fable run on the box from the facts block below;
 * this composer is the floor it falls back to, and the two are the same facts.
 */
export function composeToday(f: TodayFacts, o: { canReply: boolean }): Message {
  const lines: Line[] = [];
  const seen = new Set<string>();

  // 1. Today. Dated-or-late first, then ready. `ready` folded in (§4.3): the
  //    section that matters most is no longer the one truncation eats first.
  const todayItems: Item[] = [];
  for (const item of f.today) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    todayItems.push({ text: todayLine(item), url: itemUrl(item.id) });
  }
  const readyMore =
    f.readyBeyond > 0
      ? {
          text: `${f.readyBeyond} other ${plural(f.readyBeyond, "item is", "items are")} ready, and not one of them is dated.`,
          url: TAB_EVERYTHING,
        }
      : undefined;
  if (todayItems.length > 0 || readyMore !== undefined) {
    pushRun(
      lines,
      "today",
      "Dated, oldest first — each line names the first move.",
      todayItems,
      SECTION_CAPS.today,
      readyMore,
    );
    note(lines, "today", o.canReply, 'reply "done" on a line, or give it a new date.');
  } else {
    // sends-even-when-empty: the section is still printed, because a missing
    // morning message is the breakage alarm.
    pushRun(
      lines,
      "today",
      "Nothing is dated today and nothing is late.",
      [{ text: "Everything waiting on you is on the page.", url: TAB_EVERYTHING }],
      SECTION_CAPS.today,
    );
  }

  // 2. The objection list (delegate-design.md §2.4). Nothing when the delegate
  //    has taken no decision — the rows may not exist at all yet.
  if (f.objections.length > 0) {
    const beyond = f.objectionsBeyond ?? 0;
    const all = f.objections.length + beyond;
    pushRun(
      lines,
      "objections",
      `The delegate decided ${countWord(all)} ${plural(all, "thing", "things")} while you were asleep; silence means they stand.`,
      f.objections.map((objection, index) => objectionLine(objection, index + 1)),
      SECTION_CAPS.objections,
      beyond > 0
        ? {
            text: `${beyond} more ${plural(beyond, "decision is", "decisions are")} on the page.`,
            url: TAB_BATCHES,
          }
        : undefined,
    );
    note(lines, "objections", o.canReply, 'reply "revert 2", or "2: what to do instead".');
  }

  // 3. The calendar. Rows from a feed marked private in TTS_ICS_FEEDS never
  //    reach this list — the gatherer drops them (Tom 2026-09-09, amendment 1).
  if (f.calendar.length > 0) {
    pushRun(
      lines,
      "calendar",
      f.calendarLead ?? "Your day carries these commitments.",
      f.calendar.map((span) => ({ text: calendarLine(span), url: TAB_CALENDAR })),
      SECTION_CAPS.calendar,
    );
  }

  // 4. What the box left behind overnight.
  if (f.overnight.length > 0) {
    pushRun(
      lines,
      "overnight",
      `The box planned ${countWord(f.batchesPlanned)} ${plural(f.batchesPlanned, "batch", "batches")} overnight and finished ${f.batchesFinished === 0 ? "none of them" : countWord(f.batchesFinished)}.`,
      f.overnight.map((batch) => ({ text: overnightLine(batch), url: TAB_BATCHES })),
      SECTION_CAPS.overnight,
    );
  }

  // 5. What broke.
  if (f.broken.length > 0) {
    const failures = f.broken.reduce((sum, b) => sum + (b.count ?? 1), 0);
    pushRun(
      lines,
      "broken",
      `${capitalise(countWord(f.broken.length))} ${plural(f.broken.length, "job", "jobs")} failed overnight${failures === f.broken.length ? "" : `, ${countWord(failures)} times in all`}.`,
      f.broken.map((b) => ({ text: brokenLine(b), url: b.url ?? TAB_EVERYTHING })),
      SECTION_CAPS.broken,
    );
  }

  // NOT fitted here. `fit` is a separate step so the sender can record whether
  // anything had to be reduced (composeTodayFitted), and so a test can hold the
  // whole message before the cut.
  return { firstLine: todayFirstLine(f), lines };
}

/** The morning message, reduced until it fits one Slack message, and whether
 *  anything had to go — the sender records it on the digest-sent row. */
export function composeTodayFitted(
  f: TodayFacts,
  o: { canReply: boolean },
): { message: Message; truncated: boolean } {
  return fit(composeToday(f, o));
}

/** The first line names the count, the age of the worst, and THE ONE TO START
 *  WITH. It never names the message. */
export function todayFirstLine(f: TodayFacts): string {
  const second =
    f.objections.length > 0
      ? ` ${capitalise(countWord(f.objections.length))} ${plural(f.objections.length, "decision was", "decisions were")} taken for you overnight.`
      : " Nothing else needs an answer from you today.";
  if (f.lateCount === 0) {
    return `Nothing is dated today and nothing is late. The calendar is your whole day.${
      f.objections.length > 0 ? second : ""
    }`;
  }
  const first = f.today[0];
  const oldest = f.oldestLateBy ? `, the oldest by ${f.oldestLateBy}` : "";
  const start = first ? `; ${lowerFirst(shortClause(first.statement))} is the one to start with` : "";
  return `${capitalise(countWord(f.lateCount))} ${plural(f.lateCount, "thing carries", "things carry")} a date you have passed${oldest}${start}.${second}`;
}

/** The first clause of a statement, for the first line: up to the first comma,
 *  colon or em dash, and at most a dozen words. */
function shortClause(text: string): string {
  const head = stripStop(text).split(/[,:—]/)[0].trim();
  const words = head.split(" ");
  return words.length <= 12 ? head : words.slice(0, 12).join(" ");
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/**
 * The needs-you thread: one thread per thing only Tom can settle. The reason
 * is the Gmail triage's `verdict.why`; the entry action is the todo's own.
 * THE RAW VENDOR SUBJECT AND THE FROM HEADER ARE NEVER PRINTED — they stay on
 * the needs-tom event row and in the dedupe key.
 */
export function composeNeedsYou(f: NeedsYouFacts, o: { canReply: boolean }): Message {
  const lines: Line[] = [
    { role: "item", section: "needs-you", text: statement(f.statement), url: itemUrl(f.todoId) },
  ];
  if (f.sourceUrl) {
    lines.push({
      role: "item",
      section: "needs-you",
      text: "Open the message it came from.",
      url: f.sourceUrl,
    });
  }
  note(lines, "needs-you", o.canReply, 'reply here with what you decided, or "done".');
  const action = f.entryAction ? ` ${stripStop(f.entryAction)}.` : "";
  return {
    firstLine: `Only you can settle this: ${lowerFirst(stripStop(f.reason))}.${action}`,
    lines,
  };
}

/** The hourly line: one sentence, one link, no title, no sections — and NO
 *  MESSAGE AT ALL when nothing changed. The `kind` and `mode` enumerations
 *  (focus-item, adhoc, autonomous) are never printed; the only one that
 *  survives is the fact of being unattended, spelled "on its own". */
export function composeHourly(f: HourlyFacts): Message | null {
  if (isQuietHour(f)) return null;
  const clauses: string[] = [];
  if (f.running.length === 1) {
    const s = f.running[0];
    const alone = s.mode === "autonomous" ? " on its own" : "";
    const on = s.statement === null ? "" : ` ${stripStop(s.statement)}`;
    clauses.push(
      `${linked(s.title, sessionUrl(s.sessionId))} has been working${on}${alone} for ${elapsedText(s.elapsedMs)}`,
    );
  } else if (f.running.length > 1) {
    const on = f.running.find((s) => s.statement !== null);
    const what =
      on !== undefined
        ? linked(on.statement as string, on.batchId === null ? sessionUrl(on.sessionId) : TAB_BATCHES)
        : linked("what is on the batches page", TAB_BATCHES);
    clauses.push(`${capitalise(countWord(f.running.length))} sessions are working ${what}`);
  } else if (f.batches.length > 0) {
    const b = f.batches[0];
    clauses.push(
      `${capitalise(countWord(f.batches.length))} ${plural(f.batches.length, "batch", "batches")} moved, ${linked(b.statement, TAB_BATCHES)} among them`,
    );
  }
  const changed = changeClauses(f.changes);
  if (changed.length > 0) clauses.push(joinClauses(changed));
  else if (clauses.length > 0) clauses.push("nothing else changed");
  const since = f.sinceLabel ? ` since ${f.sinceLabel}` : "";
  return { firstLine: `${joinWithAnd(clauses)}${since}.`, lines: [] };
}

function joinWithAnd(parts: string[]): string {
  return parts.length <= 1
    ? parts.join("")
    : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** The raw labels captured:/done:/archived:/ruling:/date outcome:/failure: are
 *  gone; the counts are stated as sentences instead. */
function changeClauses(changes: Change[]): string[] {
  const count = (kind: ChangeKind) => changes.filter((c) => c.kind === kind).length;
  const out: string[] = [];
  const captured = count("captured");
  const done = count("done");
  const dates = count("date-outcome");
  const failures = count("failure");
  if (captured > 0) out.push(`${captured} ${plural(captured, "item was", "items were")} captured`);
  if (done > 0) out.push(`${done} finished`);
  if (dates > 0) out.push(`${dates} ${plural(dates, "date", "dates")} moved`);
  if (failures > 0) out.push(`${failures} ${plural(failures, "job", "jobs")} failed`);
  return out;
}

/** A decision the delegate took, the moment it took it. The default is
 *  silence, and silence is consent. */
export function composeDecision(f: DecisionFact, o: { canReply: boolean }): Message {
  const url = f.todoId ? itemUrl(f.todoId) : TAB_BATCHES;
  if (f.refused) {
    const lines: Line[] = [
      {
        role: "item",
        section: "decision",
        text: statement(
          `It would have ${stripStop(f.decision)}${f.fallback ? `; instead the run ${stripStop(f.fallback)}` : ""}`,
        ),
        url,
      },
    ];
    note(lines, "decision", o.canReply, "reply with what to do, or leave it parked.");
    return {
      firstLine: `Parked for you: ${lowerFirst(
        stripStop(f.refusedBecause ?? "it is not a decision an agent may take in your name"),
      )}. Nothing was done in your name.`,
      lines,
    };
  }
  const lines: Line[] = [
    {
      role: "item",
      section: "decision",
      text: statement(
        `${capitalise(stripStop(f.decision))}${f.reason ? `, because ${stripStop(f.reason)}` : ""}`,
      ),
      url,
    },
  ];
  note(lines, "decision", o.canReply, 'reply "revert", or say what to do instead.');
  return { firstLine: "Object if this is wrong; silence means it stands.", lines };
}

/** A failure, in #tts-broken. A failure with no link is one line and no item
 *  lines — the single case where a message is its first line alone, which the
 *  form allows. */
export function composeBroken(f: BrokenFact): Message {
  const firstLine = statement(f.statement);
  if (f.detail === undefined || f.url === undefined) return { firstLine, lines: [] };
  return {
    firstLine,
    lines: [{ role: "item", section: "broken", text: brokenLine(f), url: f.url }],
  };
}

/** The #dump capture reply. It stops echoing his own words back and says what
 *  happens next — the one fact he does not already have. */
export function composeCaptured(f: CaptureFact): Message {
  return {
    firstLine: "Captured; it is prepared tonight and reaches you in tomorrow's morning message.",
    lines: [
      { role: "item", section: "captured", text: statement(f.statement), url: itemUrl(f.todoId) },
    ],
  };
}

/** `ended`, `failed`, `focus-item`, `adhoc` and "seeded with this thread" are
 *  five terms the old sentence printed raw. The status is stated as a fact
 *  through this lookup; the kind is not printed at all. */
const STATUS_AS_FACT: Record<string, string> = {
  ended: "had already finished",
  failed: "had failed",
};

export function composeContinued(f: ContinuedFact): Message {
  const was = STATUS_AS_FACT[f.status] ?? "was no longer running";
  return {
    firstLine: `That session ${was}, so your reply opened a new one carrying this thread with it.`,
    lines: [
      { role: "item", section: "continued", text: statement(f.title), url: sessionUrl(f.sessionId) },
    ],
  };
}

// ── The facts block (Tom 2026-09-09, amendment 2) ────────────────────────────
// The composer's job for the two Fable-written kinds is to gather the day's
// facts deterministically, each with an id, its link and its numbers, and to
// store the block on the digest event so the transcript shows the inputs. The
// Fable run receives the block and writes the message; the verifier below
// checks every link and every number in what it wrote against the block.

export type Fact = {
  id: string;
  /** The deterministic sentence about this fact — what the writer writes FROM. */
  text: string;
  urls: string[];
  numbers: string[];
};

export type FactsBlock = {
  kind: "today" | "needs-you";
  day: string;
  canReply: boolean;
  facts: Fact[];
};

/** Numbers as the verifier compares them: digits only, commas removed, so
 *  "1,001" and "1001" are one number. */
export function numberTokens(text: string): string[] {
  return (text.match(/\b\d[\d,]*(?:\.\d+)?\b/g) ?? []).map((n) => n.replace(/,/g, ""));
}

export function urlTokens(text: string): string[] {
  return text.match(/https?:\/\/[^\s>|)\]]+/g) ?? [];
}

function fact(id: string, text: string, urls: string[], extra: number[] = []): Fact {
  return {
    id,
    text,
    urls,
    numbers: [...new Set([...numberTokens(text), ...extra.map((n) => String(n))])],
  };
}

export function todayFactsBlock(f: TodayFacts, canReply: boolean): FactsBlock {
  const facts: Fact[] = [];
  facts.push(
    fact(
      "today:count",
      `${f.lateCount} ${plural(f.lateCount, "thing carries", "things carry")} a date you have passed${
        f.oldestLateBy ? `, the oldest by ${f.oldestLateBy}` : ""
      }.`,
      [TAB_EVERYTHING],
      [f.lateCount],
    ),
  );
  for (const item of f.today) {
    facts.push(fact(`todo:${item.id}`, todayLine(item), [itemUrl(item.id)]));
  }
  if (f.readyBeyond > 0) {
    facts.push(
      fact(
        "ready:beyond",
        `${f.readyBeyond} other ${plural(f.readyBeyond, "item is", "items are")} ready, and not one of them is dated.`,
        [TAB_EVERYTHING],
        [f.readyBeyond],
      ),
    );
  }
  f.objections.forEach((objection, index) => {
    const line = objectionLine(objection, index + 1);
    facts.push(fact(`ask:${objection.askId}`, line.text, [line.url], [index + 1]));
  });
  if (f.calendarLead) facts.push(fact("calendar:lead", f.calendarLead, [TAB_CALENDAR]));
  f.calendar.forEach((span, index) => {
    facts.push(fact(`calendar:${index}`, calendarLine(span), [TAB_CALENDAR]));
  });
  facts.push(
    fact(
      "overnight:count",
      `The box planned ${f.batchesPlanned} ${plural(f.batchesPlanned, "batch", "batches")} overnight and finished ${f.batchesFinished}.`,
      [TAB_BATCHES],
      [f.batchesPlanned, f.batchesFinished],
    ),
  );
  for (const batch of f.overnight) {
    facts.push(
      fact(`batch:${batch.batchId ?? "none"}`, overnightLine(batch), [TAB_BATCHES], [
        batch.added,
        batch.reworked,
        batch.dropped,
        batch.finished,
      ]),
    );
  }
  f.broken.forEach((b, index) => {
    facts.push(
      fact(`broken:${index}`, `${b.statement} ${b.detail ?? ""}`.trim(), b.url ? [b.url] : [], [
        b.count ?? 1,
      ]),
    );
  });
  return { kind: "today", day: f.day, canReply, facts };
}

export function needsYouFactsBlock(
  f: NeedsYouFacts,
  day: string,
  canReply: boolean,
): FactsBlock {
  const facts: Fact[] = [
    fact(`todo:${f.todoId}`, f.statement, [itemUrl(f.todoId)]),
    fact("reason", f.reason, []),
  ];
  if (f.entryAction) facts.push(fact("entry-action", f.entryAction, []));
  if (f.sourceUrl) facts.push(fact("source", "Open the message it came from.", [f.sourceUrl]));
  return { kind: "needs-you", day, canReply, facts };
}

/** What a Fable run hands back: the same Message shape, plus the fact ids each
 *  line was written from. The citations never reach Slack — they are what lets
 *  a mechanical verifier reject an invented link or an invented number without
 *  judging prose. */
export type DraftLine = Line & { sources: string[] };
export type Draft = {
  firstLine: string;
  firstLineSources: string[];
  lines: DraftLine[];
};

export function draftMessage(draft: Draft): Message {
  return {
    firstLine: draft.firstLine,
    lines: draft.lines.map((line) =>
      line.role === "item"
        ? { role: "item", text: line.text, url: line.url, section: line.section }
        : { role: line.role, text: line.text, section: line.section },
    ),
  };
}

/**
 * THE VERIFIER. Every link and every number in the draft must exist in the
 * facts block, on a fact the LINE ITSELF cites; and the draft must obey the
 * form (checkMessage). Empty array = it may be posted. On a fault the caller
 * retries ONCE with the complaint, then falls back to the plain template, and
 * records which happened — the morning is never silent.
 */
export function verifyDraft(draft: Draft, block: FactsBlock): string[] {
  const byId = new Map(block.facts.map((f) => [f.id, f]));
  const faults: string[] = [];
  const lines = [
    {
      label: "the first line",
      text: draft.firstLine,
      url: undefined as string | undefined,
      sources: draft.firstLineSources ?? [],
      role: "first",
    },
    ...draft.lines.map((line, index) => ({
      label: `line ${index + 1} ("${line.text.slice(0, 40)}")`,
      text: line.text,
      url: line.role === "item" ? line.url : undefined,
      sources: line.sources ?? [],
      role: line.role as string,
    })),
  ];
  for (const line of lines) {
    for (const id of line.sources) {
      if (!byId.has(id)) faults.push(`${line.label} cites an unknown fact "${id}"`);
    }
    const cited = line.sources
      .map((id) => byId.get(id))
      .filter((f): f is Fact => f !== undefined);
    const urls = [...urlTokens(line.text), ...(line.url ? [line.url] : [])];
    const numbers = numberTokens(line.text);
    // A note line is the form's own sentence, not a claim about the world: it
    // carries neither a link nor a number and needs no source.
    if (line.role === "note") {
      if (urls.length > 0 || numbers.length > 0) {
        faults.push(`${line.label} is a reply invitation carrying a link or a number`);
      }
      continue;
    }
    if (cited.length === 0 && (urls.length > 0 || numbers.length > 0)) {
      faults.push(`${line.label} carries a link or a number and cites no fact`);
    }
    for (const url of urls) {
      if (!cited.some((f) => f.urls.includes(url))) {
        faults.push(`${line.label} uses the link ${url}, which is in no fact it cites`);
      }
    }
    for (const number of numbers) {
      if (!cited.some((f) => f.numbers.includes(number))) {
        faults.push(`${line.label} uses the number ${number}, which is in no fact it cites`);
      }
    }
  }
  return [...faults, ...checkMessage(draftMessage(draft), { canReply: block.canReply })];
}
