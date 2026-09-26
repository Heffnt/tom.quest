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
 *  The needs-you run sits third: a captured item the email triage judged to
 *  need him today, which no worker may raise with him directly (Tom,
 *  2026-09-21), so this message says it. The objection list stays second.
 *
 *  The calendar run is printed between "needs-you-today" and "overnight" and is not
 *  named here: it is his day, not a ranked list, and it has no page of its own
 *  to send him to. `fit` reduces it in printed order like any other run.
 */
export const SECTION_ORDER = ["today", "objections", "needs-you-today", "overnight", "broken", "box"] as const;

/** Per-section item caps, before the whole-message fit. Nearest him, most
 *  room. */
export const SECTION_CAPS = {
  today: 12,
  objections: 12,
  calendar: 12,
  overnight: 6,
  broken: 4,
  box: 8,
} as const;

// ── Display text ─────────────────────────────────────────────────────────────

/** Slack mrkdwn reserves these three inside message text and link labels. The
 *  ONE copy (VQC C1). */
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
 *  link, from the last back; the first run is never reduced, nor is the
 *  needs-you-today run, which names what no one else tells him (Tom,
 *  2026-09-21); then, still over, lines are dropped by lastResortDrop.
 *  Returns whether anything was reduced (recorded on the digest-sent row as
 *  `truncated`, as today). */
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
      if (current.lines[runs[i].start].section === PROTECTED_RUN) continue;
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
    const drop = lastResortDrop(current.lines);
    if (drop < 0) break;
    const lines = current.lines;
    current = { ...current, lines: withoutEmptyRuns([...lines.slice(0, drop), ...lines.slice(drop + 1)]) };
    truncated = true;
  }
  return { message: current, truncated };
}

/** Which line the last resort drops, or -1 for none: the last line of any
 *  other run first; then the last needs-you-today line, since an item whose
 *  line is dropped is not marked surfaced and comes back the next morning;
 *  then the first run's last line, but never its lead and first item, which
 *  the first line names. */
function lastResortDrop(lines: Line[]): number {
  const runs = sectionRuns(lines);
  const first = runs[0];
  const inFirst = (i: number) => first !== undefined && i >= first.start && i < first.end;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!inFirst(i) && lines[i].section !== PROTECTED_RUN) return i;
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].section === PROTECTED_RUN && lines[i].role !== "lead") return i;
  }
  if (first !== undefined && first.end - first.start > 2) return first.end - 1;
  return -1;
}

/** The lines with every run that has lost all its item lines removed whole,
 *  lead and note included: a lead with nothing under it is a malformed run. */
function withoutEmptyRuns(lines: Line[]): Line[] {
  const keep: Line[] = [];
  for (const { start, end } of sectionRuns(lines)) {
    const run = lines.slice(start, end);
    if (run[0].role === "lead" && !run.some((line) => line.role === "item")) continue;
    keep.push(...run);
  }
  return keep;
}

/** The run `fit` never reduces, and whose lines the last resort drops only
 *  after every other run but the first. */
const PROTECTED_RUN = "needs-you-today";

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
export const TAB_CALENDAR = "https://tom.quest/tts?tab=calendar";
const SESSION_URL = "https://www.tom.quest/agents?session=";

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
  /** TRUE FOR A MERGE, which the box landed on its own after three mechanical
   *  gates — nothing decided it in his name. The objection list carries both
   *  kinds (convex/ttsDigest.ts MERGE) and the lead must not credit a merge to
   *  the delegate, so the two are counted separately. */
  merged?: boolean;
  /** TRUE FOR A MESSAGE SENT IN HIS NAME on his own sign-off
   *  (convex/ttsSignoff.ts): he decided it by pressing "sign and send", so
   *  the lead credits it to neither the delegate nor the gates. */
  sentAsTom?: boolean;
};

/** One line per TODO, from every session event in the window that named it
 *  (Tom, 2026-09-24: no batches). Sessions contribute the two facts Tom can
 *  use — how many ended with a recorded outcome, and whether one is still
 *  running — never "session opened". A night of five sessions on one todo is
 *  ONE sentence about that todo. Sessions on no todo share one tail row,
 *  `todoId` null, which links the newest of those sessions. */
export type TodoOutcome = {
  todoId: string | null; // null = the tail: sessions on no todo
  statement: string; // the todo's own statement; the tail's is not printed
  /** The newest session in the window on it; the tail's link. */
  sessionId: string | null;
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

/** One captured item a poller's triage judged to need Tom today. `why` is the
 *  triage's own few words, empty when it gave none. Workers never raise these
 *  with him; the morning message and the hourly line say them. */
type NeedsYouTodayFact = {
  todoId: string;
  statement: string;
  why: string;
  /** "Ten days late." when the item also carries a date; it is then said
   *  here once, with its reason, and not again under today. */
  countdown?: string;
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
  /** How many of the WHOLE objection list — printed and beyond — are merges
   *  rather than delegate decisions. Absent means "count the printed ones",
   *  which is right whenever nothing was held back. */
  objectionMerges?: number;
  /** How many of the WHOLE objection list are messages sent in his name on
   *  his sign-off. Absent means "count the printed ones". */
  objectionSent?: number;
  /** Captured since the last morning message, still active, and judged by the
   *  triage to need him today; oldest first. */
  needsYou: NeedsYouTodayFact[];
  /** What sessions did overnight, one row per todo, the tail last. */
  overnightByTodo: TodoOutcome[];
  broken: BrokenFact[];
  /** What changed on the Jarvis Box since the last digest (convex/boxChanges.ts
   *  boxChangeLines): one line per agent that ran root commands, per deploy,
   *  per setup run, per other kind of change. Absent or empty: nothing did. */
  boxChanges?: BoxChangeFact[];
};

/** One line of the box-changes run: its fact id (`box:…`), its sentence, and
 *  its link. Declared here, not imported, for the import restriction above. */
export type BoxChangeFact = { id: string; text: string; url: string };

export type NeedsYouFacts = {
  todoId: string;
  statement: string;
  entryAction?: string;
  reason: string;
  sourceUrl?: string | null;
};

export type CaptureFact = { todoId: string; statement: string };

export type ContinuedFact = {
  sessionId: string;
  title: string;
  /** The raw status value; never printed, looked up below. */
  status: string;
};

export function elapsedText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}m`;
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
  const url = o.todoId ? itemUrl(o.todoId) : TAB_EVERYTHING;
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

/** One needs-you-today item: the todo's statement, then the triage's reason
 *  when it gave one, then its lateness when it is dated. */
function needsYouTodayLine(n: NeedsYouTodayFact): string {
  const late = n.countdown ? ` ${stripStop(n.countdown)}.` : "";
  const why = lowerFirst(stripStop(n.why));
  const build = (head: string, reason: string) =>
    reason === "" ? `${head}.${late}` : `${head}, which needs you today because ${reason}.${late}`;
  // THE REASON IS KEPT. When the line is too long the statement gives first,
  // to its first clause and then to its first six words, and only then is the
  // reason cut, at a word and with no ellipsis, never dropped whole.
  const heads = [stripStop(n.statement), shortClause(n.statement), shortClause(n.statement).split(" ").slice(0, 6).join(" ")];
  for (const head of heads) {
    const line = build(head, why);
    if (line.length <= LINE_CHARS) return statement(line);
  }
  // Words first; a single word too long to fit (a pasted link, say) is cut
  // by characters, the statement to at most sixty and the reason to the room
  // left, so the line always keeps both and never needs statement()'s cut.
  const head = heads[2].length > 60 ? heads[2].slice(0, 60).trim() : heads[2];
  const words = why.split(" ");
  while (words.length > 1 && build(head, words.join(" ")).length > LINE_CHARS) words.pop();
  let reason = words.join(" ").replace(/[\s,;:—-]+$/, "");
  const over = build(head, reason).length - LINE_CHARS;
  if (over > 0) reason = reason.slice(0, Math.max(1, reason.length - over));
  return statement(build(head, reason));
}

/** The today run's line counting the dated todos it leaves to the needs-you
 *  run, or null when it leaves none. The template prints it and the facts
 *  block carries it, so a written message can say it too. */
function leftBelowLine(f: TodayFacts): string | null {
  const n = f.today.filter((item) => f.needsYou.some((needs) => needs.todoId === item.id)).length;
  if (n === 0) return null;
  return `${capitalise(countWord(n))} dated ${plural(n, "todo is", "todos are")} named below, with why ${n === 1 ? "it needs" : "they need"} you today.`;
}

/** The needs-you-today run's lead. */
function needsYouTodayLead(n: number): string {
  return `${capitalise(countWord(n))} captured ${plural(n, "todo needs", "todos need")} you today, as the email triage judged ${n === 1 ? "it" : "them"}.`;
}

/** `{statement}: 3 sessions on it ended and one is still running.`, each
 *  clause omitted when it has nothing to say, and `{statement}: a session on
 *  it recorded no outcome.` when neither has. The tail row names no todo, so
 *  its line is `3 sessions on no todo ended.` without a statement. */
export function todoOutcomeLine(o: TodoOutcome): string {
  const tail = o.todoId === null;
  const where = tail ? "on no todo" : "on it";
  const ended = `${o.finished} ${plural(o.finished, "session", "sessions")} ${where} ended`;
  const body =
    o.finished > 0 && o.running
      ? `${ended} and one is still running`
      : o.finished > 0
        ? ended
        : o.running
          ? `a session ${where} is still running`
          : `a session ${where} recorded no outcome`;
  return statement(tail ? capitalise(body) : `${capitalise(stripStop(o.statement))}: ${body}`);
}

/** The link of one overnight row: the todo, else the tail's newest session,
 *  else the everything tab. */
function todoOutcomeUrl(o: TodoOutcome): string {
  if (o.todoId !== null) return itemUrl(o.todoId);
  return o.sessionId !== null ? sessionUrl(o.sessionId) : TAB_EVERYTHING;
}

/** The overnight run's lead. It carries no number: the plan pass that counted
 *  batches is gone, and the rows below are the count. */
const OVERNIGHT_LEAD = "Overnight, the box's sessions worked on these todos.";
/** The box-changes run's lead (plan-root T1). */
export const BOX_LEAD = "What ran as root and what changed on the Jarvis Box.";

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

/** How many of the objection list are merges. `objectionMerges` counts the
 *  WHOLE list (the gatherer knows what the cap held back); without it the
 *  printed lines are the whole list and counting them is the same answer. */
function objectionMergeCount(f: TodayFacts): number {
  return f.objectionMerges ?? f.objections.filter((o) => o.merged === true).length;
}

/** How many of the objection list are messages sent on his sign-off, counted
 *  the same way as the merges. */
function objectionSentCount(f: TodayFacts): number {
  return f.objectionSent ?? f.objections.filter((o) => o.sentAsTom === true).length;
}

/**
 * The objection list's lead. TWO KINDS SHARE THE LIST and the lead names each
 * for what it is: things were DECIDED in his name (the delegate's decisions, a
 * ruling read from his words, a model-of-Tom line the nightly wrote), and the box MERGED
 * things that passed three mechanical gates with nobody deciding anything. A
 * morning of merges credited to the delegate is a false statement about who
 * acted, which is the one thing this list exists to let him object to.
 */
export function objectionsLead(all: number, merges: number, sent = 0): string {
  const decided = Math.max(0, all - merges - sent);
  const stand = "silence means they stand";
  // THE THIRD KIND: a message that went out in his name on his own sign-off.
  // He decided it, so it is neither the delegate's nor the gates', and there
  // is nothing left for silence to let stand once it has been sent.
  if (sent > 0) {
    const went = `${countWord(sent)} ${plural(sent, "message", "messages")} went out on your sign-off`;
    const others: string[] = [];
    if (decided > 0) others.push(`${countWord(decided)} ${plural(decided, "thing was", "things were")} decided in your name`);
    if (merges > 0) {
      others.push(`${countWord(merges)} ${plural(merges, "merge", "merges")} landed on ${plural(merges, "its", "their")} own`);
    }
    if (others.length === 0) return `${capitalise(went)}.`;
    return `${capitalise(others.join(", "))} and ${went}; ${stand}.`;
  }
  if (merges === 0) {
    return `${capitalise(countWord(all))} ${plural(all, "thing was", "things were")} decided in your name while you were asleep; ${stand}.`;
  }
  const landed = `${countWord(merges)} ${plural(merges, "merge", "merges")} landed on ${plural(merges, "its", "their")} own`;
  if (decided === 0) {
    return `${capitalise(landed)} while you were asleep; ${stand}.`;
  }
  return `${capitalise(countWord(decided))} ${plural(decided, "thing was", "things were")} decided in your name while you were asleep and ${landed}; ${stand}.`;
}

// ── The seven kinds ──────────────────────────────────────────────────────────

/**
 * The morning message. Runs today → objection list → the calendar →
 * done overnight → broken, fits one Slack message, and shrinks the sections
 * furthest from him first.
 *
 * OUTCOMES, NEVER LOGGED EVENTS: the overnight run prints one line per todo
 * saying what the sessions on it came to. "plan stored", "created", "retired", "session
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
  // A flagged item is said once, in the needs-you run, with its reason and
  // its lateness; the today run leaves it to that run.
  for (const needs of f.needsYou) seen.add(needs.todoId);
  for (const item of f.today) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    todayItems.push({ text: todayLine(item), url: itemUrl(item.id) });
  }
  // The dated todos left to the needs-you run: the today run says how many,
  // so none goes missing from it silently and it never falls to "nothing is
  // dated" while one waits below.
  const below = leftBelowLine(f);
  if (below !== null) todayItems.push({ text: below, url: TAB_EVERYTHING });
  const readyMore =
    f.readyBeyond > 0
      ? {
          text: `${f.readyBeyond} other ${plural(f.readyBeyond, "todo is", "todos are")} ready, and not one of them is dated.`,
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
  //    has taken no decision and nothing merged — the rows may not exist at
  //    all yet. The lead counts the two kinds separately (objectionsLead).
  if (f.objections.length > 0) {
    const beyond = f.objectionsBeyond ?? 0;
    const all = f.objections.length + beyond;
    pushRun(
      lines,
      "objections",
      objectionsLead(all, objectionMergeCount(f), objectionSentCount(f)),
      f.objections.map((objection, index) => objectionLine(objection, index + 1)),
      SECTION_CAPS.objections,
      beyond > 0
        ? {
            text: `${beyond} more ${plural(beyond, "decision is", "decisions are")} on the page.`,
            url: TAB_EVERYTHING,
          }
        : undefined,
    );
    note(lines, "objections", o.canReply, 'reply "revert 2", or "2: what to do instead".');
  }

  // 3. What the email triage judged to need him today. No worker opens a
  //    needs-you thread for these (Tom, 2026-09-21: workers "should not reach
  //    me at all directly"), so this run is where he hears of them, and a
  //    reply naming the item reaches it as every digest reply does.
  //    Every item, uncapped: each is a thing only he can settle, and `fit`
  //    never reduces this run (PROTECTED_RUN).
  pushRun(
    lines,
    "needs-you-today",
    needsYouTodayLead(f.needsYou.length),
    f.needsYou.map((n) => ({ text: needsYouTodayLine(n), url: itemUrl(n.todoId) })),
    f.needsYou.length,
  );

  // 4. The calendar. Rows from a feed marked private in TTS_ICS_FEEDS never
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

  // 5. What the box left behind overnight, one line per todo.
  if (f.overnightByTodo.length > 0) {
    pushRun(
      lines,
      "overnight",
      OVERNIGHT_LEAD,
      f.overnightByTodo.map((o) => ({ text: todoOutcomeLine(o), url: todoOutcomeUrl(o) })),
      SECTION_CAPS.overnight,
    );
  }

  // 6. What broke.
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

  // 7. What changed on the box (plan-root T1, guarantee G4): the last run,
  //    so the first `fit` reduces. No reply invitation: a change is objected
  //    to where it happened, and a change to who can act already has its own
  //    #tts-decisions thread.
  if ((f.boxChanges ?? []).length > 0) {
    pushRun(
      lines,
      "box",
      BOX_LEAD,
      (f.boxChanges ?? []).map((b) => ({ text: b.text, url: b.url })),
      SECTION_CAPS.box,
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
  const decisions =
    f.objections.length > 0
      ? ` ${capitalise(countWord(f.objections.length))} ${plural(f.objections.length, "decision was", "decisions were")} taken for you overnight.`
      : "";
  const needs =
    f.needsYou.length > 0
      ? ` ${capitalise(countWord(f.needsYou.length))} captured ${plural(f.needsYou.length, "todo needs", "todos need")} you today.`
      : "";
  let head: string;
  // The all-clear predates the needs-you run: the first line has always said
  // when nothing else waits. It stays, and is said only when it is true.
  let nothingElse = "";
  if (f.lateCount === 0) {
    head = "Nothing is dated today and nothing is late. The calendar is your whole day.";
  } else {
    const first = f.today[0];
    const oldest = f.oldestLateBy ? `, the oldest by ${f.oldestLateBy}` : "";
    const start = first ? `; ${lowerFirst(shortClause(first.statement))} is the one to start with` : "";
    head = `${capitalise(countWord(f.lateCount))} ${plural(f.lateCount, "thing carries", "things carry")} a date you have passed${oldest}${start}.`;
    // Said only when it is true: nothing decided for him and nothing flagged.
    if (decisions === "" && needs === "") nothingElse = " Nothing else needs an answer from you today.";
  }
  // The needs-you sentence is the one that gives when the line would pass its
  // cap: `fit` never shortens a first line, and the run below still says it.
  const full = `${head}${decisions}${needs}${nothingElse}`;
  return full.length <= FIRST_LINE_CHARS ? full : `${head}${decisions}`;
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

/** A message an agent proposes to send in Tom's name (convex/ttsSignoff.ts):
 *  who it is for and where it goes, NEVER its text. He reads the text where he
 *  signs it, on /tts beside the two controls, so Slack holds no copy of a
 *  message in his name that he has not signed. */
type ProposalAskFacts = { recipient: string; channel: string };

/** No note line: a reply in this thread is a note on the record, never a
 *  sign-off, which only his press on /tts writes. */
export function composeProposalAsk(f: ProposalAskFacts): Message {
  const slack = /^slack:(.+)$/.exec(f.channel);
  const what = slack === null ? "a calendar invitation" : "a Slack message";
  const where = slack === null ? "" : ` in ${slack[1]}`;
  const hold = "Nothing goes out until you sign it on /tts.";
  const first = `An agent proposes ${what} in your name to ${f.recipient}${where}. ${hold}`;
  return {
    firstLine: first.length <= FIRST_LINE_CHARS ? first : `An agent proposes ${what} in your name. ${hold}`,
    lines: [{ role: "item", text: "Open it to read the text, then sign or decline it.", url: TAB_EVERYTHING }],
  };
}

/** The #dump capture reply. It stops echoing his own words back and says what
 *  happens next — the one fact he does not already have.
 *
 *  HIS WORD IS "THE DIGEST". Every line Tom or a model can read names the
 *  morning message "the digest"; the other phrase survives only in comments. */
export function composeCaptured(f: CaptureFact): Message {
  return {
    firstLine: "Captured; it is prepared tonight and reaches you in the digest.",
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

// ── The facts block ──────────────────────────────────────────────────────────
// The day's facts, each with an id, its link and its numbers: the digest is
// rendered from them (composeToday), and the record keeps them beside the
// text, so what the digest said can be read as data and not only as prose.
// No model writes from them any more (Tom, 2026-09-26: "A list of what ran is
// more trustworthy than prose about it"), so nothing checks a draft against
// them.

export type Fact = {
  /** A fact the digest prints on a line of its own: each item that needs
   *  Tom today, which no one else tells him (Tom, 2026-09-21). */
  required?: true;
  id: string;
  /** The deterministic sentence about this fact. */
  text: string;
  urls: string[];
  numbers: string[];
};

type FactsBlock = {
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
  const flagged = new Set(f.needsYou.map((n) => n.todoId));
  for (const item of f.today) {
    if (flagged.has(item.id)) continue; // its fact is its needs-you-today one
    facts.push(fact(`todo:${item.id}`, todayLine(item), [itemUrl(item.id)]));
  }
  const below = leftBelowLine(f);
  if (below !== null) facts.push(fact("today:left-below", below, [TAB_EVERYTHING], [f.today.filter((item) => flagged.has(item.id)).length]));
  if (f.readyBeyond > 0) {
    facts.push(
      fact(
        "ready:beyond",
        `${f.readyBeyond} other ${plural(f.readyBeyond, "todo is", "todos are")} ready, and not one of them is dated.`,
        [TAB_EVERYTHING],
        [f.readyBeyond],
      ),
    );
  }
  f.objections.forEach((objection, index) => {
    const line = objectionLine(objection, index + 1);
    facts.push(fact(`ask:${objection.askId}`, line.text, [line.url], [index + 1]));
  });
  if (f.needsYou.length > 0) {
    facts.push(fact("needs-you-today:count", needsYouTodayLead(f.needsYou.length), [], [f.needsYou.length]));
  }
  for (const n of f.needsYou) {
    facts.push({ ...fact(`needs-you-today:${n.todoId}`, needsYouTodayLine(n), [itemUrl(n.todoId)]), required: true });
  }
  if (f.calendarLead) facts.push(fact("calendar:lead", f.calendarLead, [TAB_CALENDAR]));
  f.calendar.forEach((span, index) => {
    facts.push(fact(`calendar:${index}`, calendarLine(span), [TAB_CALENDAR]));
  });
  for (const o of f.overnightByTodo) {
    facts.push(
      fact(`overnight-todo:${o.todoId ?? "none"}`, todoOutcomeLine(o), [todoOutcomeUrl(o)], [o.finished]),
    );
  }
  f.broken.forEach((b, index) => {
    facts.push(
      fact(`broken:${index}`, `${b.statement} ${b.detail ?? ""}`.trim(), b.url ? [b.url] : [], [
        b.count ?? 1,
      ]),
    );
  });
  for (const b of f.boxChanges ?? []) facts.push(fact(b.id, b.text, [b.url]));
  return { kind: "today", day: f.day, canReply, facts };
}
