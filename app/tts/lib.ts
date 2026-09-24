// Shared types + date/age helpers for the /tts surface.
// All persisted dates are epoch-ms numbers (convex/schema.ts dtsTodos).

import type { Doc } from "@/convex/_generated/dataModel";
import type { runnerStatus } from "@/convex/ttsRunners";

export type Todo = Doc<"dtsTodos">;
export type MirrorRow = Doc<"dtsCodeTodoMirror">;
export type CodeBrief = Doc<"dtsCodeBriefs">;
// A ruling the page shows: on a todo or a code entry. Answers to a worker's
// elevation are rulings too, and listRulings leaves them out.
export type Ruling = Doc<"dtsRulings"> & { subjectType: "life" | "code" };

/** A ruling as listRulings returns it. A ruling on a batch can still come
 * back until the schema stops declaring that subject (Tom, 2026-09-24: no
 * batches); the record keeps it, no page shows its subject, and
 * liveRulingsByKey drops it. Once the schema narrows this is Ruling. */
type ListedRuling = Doc<"dtsRulings"> & { subjectType: string };

/** Whether a listed ruling is on a subject this page shows. */
function isPageRuling(r: ListedRuling): r is Ruling {
  return r.subjectType === "life" || r.subjectType === "code";
}

// The closed verdict set — convex/ttsRulings.ts owns the union; this is the
// client's iterable of the same four values.
export type RulingVerdict = "approve" | "revise" | "session" | "archive";
export const VERDICTS: RulingVerdict[] = [
  "approve",
  "revise",
  "session",
  "archive",
];

// Where a todo can be ruled on from the page: active and prepared (ruling 18:
// readiness is two values, and ttsShared.isPrepared reads the retired
// spellings too). ONE definition — the todo row's verdict chips and the detail
// dialog's verdict buttons read it, so the set of items offering the four
// verdicts cannot drift between surfaces. The needs-me selector is stricter:
// it wants the COMPUTED ready (isReadyForTom — awake and unblocked as well).
export function isRulable(t: Todo): boolean {
  return t.status === "active" && isPrepared(t.readiness);
}

// ── Ruling subject identity + live-ruling derivation ─────────────────────────
// Client mirror of convex/ttsRulings.ts subjectKey/liveRulings — same key
// format, same newest-ruledAt/_creationTime rule, so the tab, the badge, and
// the worker feed always agree on which ruling is live.

export function rulingSubjectKey(r: {
  subjectType: "life" | "code";
  todoId?: string;
  repo?: string;
  externalId?: string;
}): string {
  if (r.subjectType === "life") return `life ${r.todoId}`;
  return codeSubjectKey(r.repo!, r.externalId!);
}

export function codeSubjectKey(repo: string, externalId: string): string {
  return `code ${repo} ${externalId}`;
}

// ── The todo graph (schema v2) ───────────────────────────────────────────────
// NOT redefined here: convex/ttsShared.ts is the ONE home for the graph rules,
// so the server's frontier and the page's frontier cannot drift. This is only
// the client's local name for them.
import {
  buildDoneSet,
  isPrepared,
  isReadyForTom,
  waitingReason,
  wakeAtPassed,
} from "@/convex/ttsShared";
export {
  MAX_NEEDS,
  buildDoneSet,
  isPrepared,
  isReady,
  isReadyForTom,
  frontier,
  normalizeReadiness,
} from "@/convex/ttsShared";

export function liveRulingsByKey(
  rulings: readonly ListedRuling[],
): Map<string, Ruling> {
  const newest = new Map<string, Ruling>();
  for (const row of rulings) {
    if (!isPageRuling(row)) continue;
    const key = rulingSubjectKey(row);
    const prior = newest.get(key);
    if (
      !prior ||
      row.ruledAt > prior.ruledAt ||
      (row.ruledAt === prior.ruledAt && row._creationTime > prior._creationTime)
    ) {
      newest.set(key, row);
    }
  }
  return newest;
}

// ── The needs-me selector (ONE definition; the everything tab's awaiting
// section renders it, the tab's badge counts it) ─────────────────────────────
// life: READY FOR TOM (ruling 18, ttsShared.isReadyForTom: prepared, active,
//   awake, every need done), excluding todos whose live ruling is NEWER than
//   the todo's last update — a ruled gate is answered until the preparer
//   touches the todo again (re-prep bumps updatedAt to at least ruledAt).
// code: open + briefed, where the live ruling is missing or NOT NEWER than
//   the brief — a re-brief after a revise ruling returns the item for a fresh
//   ruling (mirror of convex/ttsRulings.ts briefAwaitsRuling).
// pending: live rulings not yet applied (the "ruled, applying" section).
//
// BOTH COMPARISONS ARE `<=` ON PURPOSE — DO NOT TIGHTEN EITHER TO `<`.
// ruledAt, updatedAt and preparedAt are whole-millisecond Date.now() values
// written by separate mutations, so a ruling and a re-prep/re-brief CAN carry
// the same number. Strict `<` reads that tie as "already answered" and drops
// an item that genuinely changed after its ruling off Tom's pile, with
// nothing to put it back; `<=` costs at most one extra look at an item he
// just ruled. convex/ttsRulings.ts briefAwaitsRuling carries the same rule
// and the same warning.

export type NeedsMe = {
  lifeRows: Todo[];
  codeRows: { row: MirrorRow; brief: CodeBrief }[];
  pending: Ruling[];
};

export function selectNeedsMe(
  todos: Todo[],
  mirror: MirrorRow[],
  briefs: CodeBrief[],
  rulings: readonly ListedRuling[],
  now: number = Date.now(),
): NeedsMe {
  const live = liveRulingsByKey(rulings);
  const doneSet = buildDoneSet(todos);

  const lifeRows = todos.filter((t) => {
    if (!isReadyForTom(t, doneSet, now)) return false;
    const ruling = live.get(
      rulingSubjectKey({ subjectType: "life", todoId: t._id }),
    );
    return ruling === undefined || ruling.ruledAt <= t.updatedAt;
  });

  const briefByKey = new Map(
    briefs.map((b) => [codeSubjectKey(b.repo, b.externalId), b]),
  );
  const codeRows: NeedsMe["codeRows"] = [];
  for (const row of mirror) {
    if (row.status !== "open") continue;
    const key = codeSubjectKey(row.repo, row.externalId);
    const brief = briefByKey.get(key);
    if (!brief) continue;
    const ruling = live.get(key);
    if (ruling === undefined || ruling.ruledAt <= brief.preparedAt) {
      codeRows.push({ row, brief });
    }
  }

  const pending = [...live.values()].filter((r) => r.appliedAt === undefined);

  return { lifeRows, codeRows, pending };
}

// ── Today's view (the lifeos update, phase 7) ─────────────────────────────────
// The calendar's today column used to render a queue row a job wrote every
// morning (dtsDailyQueues). It is COMPUTED now, from the same subscriptions the
// tab already holds, in five lists — each a fact about the row and the day:
//   overdue   — dated before the day started
//   due       — dated inside the day
//   scheduled — with a committed block on it overlapping the day
//   ready     — ready for Tom (ttsShared.isReadyForTom: prepared, active,
//               awake, every need done)
//   waking    — its wakeAt inside the day (a sleep that ends today)
// Every list draws from the same pool: active rows not asleep past the day (a
// wakeAt at or after the day's end — the lifeos spelling of "waiting", which
// the retired queue never listed, however it was dated). Every active todo is
// in the pool: with batches gone (Tom, 2026-09-24) no todo is a step some
// other card shows instead.
// A parity note on overdue: the queue took dueAt before the instant it ran
// (4 a.m., so in effect before the day), this takes dueAt before the day's
// start — a todo due earlier today is "due", not "overdue": a fact about the
// day, not the clock, so the column does not re-sort itself during the day.
// `entries` is the column's render order: each todo once, under the FIRST of
// those reasons that holds for it, in that order — so an overdue todo that is
// also ready shows as overdue, the fact that outranks the other.

export type TodayReason = "overdue" | "due" | "scheduled" | "ready" | "waking";
export type TodayEntry = { todo: Todo; reason: TodayReason };
export type TodayView = {
  overdue: Todo[];
  due: Todo[];
  scheduled: Todo[];
  ready: Todo[];
  waking: Todo[];
  entries: TodayEntry[];
};

export function selectToday(
  todos: Todo[],
  blocks: readonly { todoId?: string; start: number; end: number }[],
  day: { start: number; end: number },
  now: number = Date.now(),
): TodayView {
  // The pool (the header above). The sleep test is against the day's last
  // instant: a sleep that ends inside the day is over for the day (and a
  // "waking" entry).
  const active = todos.filter(
    (t) => t.status === "active" && wakeAtPassed(t, day.end - 1),
  );
  const byDue = (a: Todo, b: Todo) => (a.dueAt ?? 0) - (b.dueAt ?? 0);
  const overdue = active
    .filter((t) => t.dueAt !== undefined && t.dueAt < day.start)
    .sort(byDue);
  const due = active
    .filter((t) => t.dueAt !== undefined && t.dueAt >= day.start && t.dueAt < day.end)
    .sort(byDue);
  const scheduledIds = new Set(
    blocks
      .filter((b) => b.todoId !== undefined && b.start < day.end && b.end > day.start)
      .map((b) => b.todoId as string),
  );
  const scheduled = active.filter((t) => scheduledIds.has(t._id as string));
  const doneSet = buildDoneSet(todos);
  const ready = active.filter((t) => isReadyForTom(t, doneSet, now));
  const waking = active
    .filter((t) => t.wakeAt !== undefined && t.wakeAt >= day.start && t.wakeAt < day.end)
    .sort((a, b) => (a.wakeAt ?? 0) - (b.wakeAt ?? 0));

  const seen = new Set<string>();
  const entries: TodayEntry[] = [];
  const take = (list: Todo[], reason: TodayReason) => {
    for (const todo of list) {
      if (seen.has(todo._id as string)) continue;
      seen.add(todo._id as string);
      entries.push({ todo, reason });
    }
  };
  take(overdue, "overdue");
  take(due, "due");
  take(scheduled, "scheduled");
  take(ready, "ready");
  take(waking, "waking");
  return { overdue, due, scheduled, ready, waking, entries };
}

// ── The whole set at a glance (vqc/pages.md, the toolbox page) ─────────────
// A page opens with the whole: every todo falls in exactly one SHAPE, so the
// area figure's cells add up to the set. The shape is the waiting reason
// (ttsShared.waitingReason, the one home of that rule) in Tom's words, with
// two facts that outrank it: done and archived are where a todo ended, and
// overdue — a date already behind it — is the fact that outranks why it waits,
// the same precedence selectToday gives it.

type TodoShape =
  | "overdue"
  | "waiting on you"
  | "waiting on another todo"
  | "waiting on a credential"
  | "not yet prepared"
  | "with a date"
  | "with an agent"
  | "done"
  | "archived";

/** The shapes in the order a page lists them: what needs Tom first. */
export const SHAPES: readonly TodoShape[] = [
  "overdue",
  "waiting on you",
  "waiting on another todo",
  "waiting on a credential",
  "not yet prepared",
  "with a date",
  "with an agent",
  "done",
  "archived",
];

/** Where one todo sits. `doneSet` is buildDoneSet over the whole list. */
function shapeOf(
  todo: Todo,
  doneSet: ReadonlySet<string>,
  now: number,
): TodoShape {
  if (todo.status === "done") return "done";
  if (todo.status === "archived") return "archived";
  if (todo.dueAt !== undefined && todo.dueAt < now) return "overdue";
  const reason = waitingReason(todo, { now, doneSet });
  switch (reason?.kind) {
    case "wake":
      return "with a date";
    case "need":
      return "waiting on another todo";
    case "credential":
      return "waiting on a credential";
    case "unprepared":
      return "not yet prepared";
    case "tom":
      return "waiting on you";
    default:
      return "with an agent";
  }
}

/** A source name as a page shows it: its words, not its hyphens. */
export function sourceWords(source: string): string {
  return source.replace(/[-_]+/g, " ");
}

/** One cell of the shape figure: the todos of one shape from one source. */
type ShapeCell = {
  key: string;
  label: string;
  count: number;
  group: TodoShape;
  todos: Todo[];
};

/**
 * Counts by shape × source, one cell per pair that holds a todo, in SHAPES
 * order and then by count. Each cell carries its todos, soonest date first and
 * then newest, so the drawer that lists a cell reads them from here.
 */
export function shapeCells(todos: Todo[], now: number): ShapeCell[] {
  const doneSet = buildDoneSet(todos);
  const byKey = new Map<string, ShapeCell>();
  for (const todo of todos) {
    const group = shapeOf(todo, doneSet, now);
    const key = `${group}|${todo.source}`;
    let cell = byKey.get(key);
    if (!cell) {
      cell = { key, label: sourceWords(todo.source), count: 0, group, todos: [] };
      byKey.set(key, cell);
    }
    cell.count += 1;
    cell.todos.push(todo);
  }
  const soonest = (a: Todo, b: Todo) =>
    (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) ||
    b._creationTime - a._creationTime;
  const cells = [...byKey.values()];
  for (const cell of cells) cell.todos.sort(soonest);
  return cells.sort(
    (a, b) =>
      SHAPES.indexOf(a.group) - SHAPES.indexOf(b.group) || b.count - a.count,
  );
}

/** How many todos are in each shape, every shape present (zero included). */
export function shapeCounts(cells: readonly ShapeCell[]): Record<TodoShape, number> {
  const counts = Object.fromEntries(SHAPES.map((s) => [s, 0])) as Record<TodoShape, number>;
  for (const cell of cells) counts[cell.group] += cell.count;
  return counts;
}

/** One row of the by-source table. */
type SourceRow = {
  source: string;
  waitingOnYou: number;
  notYetPrepared: number;
  done: number;
  total: number;
};

/** The shape cells folded by source, largest source first. */
export function sourceRows(cells: readonly ShapeCell[]): SourceRow[] {
  const rows = new Map<string, SourceRow>();
  for (const cell of cells) {
    let row = rows.get(cell.label);
    if (!row) {
      row = { source: cell.label, waitingOnYou: 0, notYetPrepared: 0, done: 0, total: 0 };
      rows.set(cell.label, row);
    }
    if (cell.group === "waiting on you") row.waitingOnYou += cell.count;
    if (cell.group === "not yet prepared") row.notYetPrepared += cell.count;
    if (cell.group === "done") row.done += cell.count;
    row.total += cell.count;
  }
  return [...rows.values()].sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));
}

/**
 * The one todo a page puts in front of Tom to rule on: the needs-me life rows
 * (selectNeedsMe, so a todo he has already ruled on stays off until it is
 * prepared again), soonest date first, then oldest. Undefined when none waits.
 */
export function nextForTom(
  todos: Todo[],
  rulings: readonly ListedRuling[],
  now: number,
): Todo | undefined {
  const { lifeRows } = selectNeedsMe(todos, [], [], rulings, now);
  return [...lifeRows].sort(
    (a, b) =>
      (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) ||
      a._creationTime - b._creationTime,
  )[0];
}

export type EventRow = Doc<"dtsEvents">;

/**
 * An event kind as a lane name in Tom's words (vqc/pages.md, principle 6), or
 * null for a kind whose name cannot be said on a page. Kinds are code: "tests-
 * run" names a finished check and reads as "tests"; a kind about agent runs'
 * environment ("runs-environment-defaulted") has no page wording, so it is
 * counted with every other kind rather than renamed into something it is not.
 */
function laneName(kind: string): string | null {
  const words = sourceWords(kind);
  if (/\benvironment\b/i.test(words) || /^runs?\b/i.test(words)) return null;
  return words.replace(/ run$/, "");
}

/**
 * Events per time bin per kind, for a time figure: the `laneCount` kinds with
 * the most events in the window, each its own lane, and every other kind —
 * with any kind laneName cannot name — together in one more. The window is `binCount` bins of `binMs` ending at
 * `now`; an event outside it is not counted. Labels are each bin's start as a
 * local hour.
 */
export function eventLanes(
  events: readonly EventRow[],
  now: number,
  binCount: number,
  binMs: number,
  laneCount: number,
): { lanes: { name: string; bins: number[] }[]; binLabels: string[] } {
  const start = now - binCount * binMs;
  const inWindow = events.filter((e) => e.at >= start && e.at < now);
  const perKind = new Map<string, number>();
  for (const e of inWindow) perKind.set(e.kind, (perKind.get(e.kind) ?? 0) + 1);
  const top = [...perKind.entries()]
    .filter(([kind]) => laneName(kind) !== null)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, laneCount)
    .map(([kind]) => kind);
  const laneOf = (kind: string) => {
    const i = top.indexOf(kind);
    return i === -1 ? top.length : i;
  };
  const lanes = top.map((kind) => ({ name: laneName(kind) ?? kind, bins: new Array<number>(binCount).fill(0) }));
  if (perKind.size > top.length) {
    lanes.push({ name: "every other kind", bins: new Array<number>(binCount).fill(0) });
  }
  for (const e of inWindow) {
    const bin = Math.min(binCount - 1, Math.floor((e.at - start) / binMs));
    lanes[laneOf(e.kind)].bins[bin] += 1;
  }
  const binLabels = Array.from({ length: binCount }, (_, i) => {
    const d = new Date(start + i * binMs);
    return `${String(d.getHours()).padStart(2, "0")}:00`;
  });
  return { lanes, binLabels };
}

/** The agents a session list holds, by status, as a figure strip's figures:
 *  "working" is the stored `running`, "starting" is requested or starting. */
export function agentFigures(
  sessions: readonly { status: Doc<"claudeSessions">["status"] }[],
): { value: number; name: string }[] {
  const count = (...statuses: Doc<"claudeSessions">["status"][]) =>
    sessions.filter((s) => statuses.includes(s.status)).length;
  return [
    { value: sessions.length, name: "agents" },
    { value: count("running"), name: "working" },
    { value: count("idle"), name: "idle" },
    { value: count("requested", "starting"), name: "starting" },
    { value: count("ended"), name: "ended" },
    { value: count("failed"), name: "failed" },
  ];
}

/** A runner's status in words, the same on the everything tab and the run view. */
export const RUNNER_STATUS_WORDS: Record<ReturnType<typeof runnerStatus>, string> = {
  running: "running",
  "waiting-on-tom": "waiting on Tom",
  done: "done",
  failed: "failed",
  "handed-off": "handed off",
};

/** e.message for Errors, String(e) otherwise — the error line under a control. */
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The intent vocabulary is owned by convex/ttsShared.ts (ttsItemLink is the
// single producer of ?item=&intent= links); this is just its local name.
export type { TtsLinkIntent as LinkIntent } from "@/convex/ttsShared";

/** "Aug 30, 2026" — absolute date, shown small/faint next to countdown text. */
export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** "2026-08-30" in local time — for date-history lines. */
export function isoDate(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Descriptive age: "12 min ago", "3 h ago", "1 day ago", "41 days ago". */
export function ageText(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

/** Descriptive time until: "due now", "in 7 min", "in 3 h", "in 2 days". The
 *  minute-grained counterpart of ageText, for a runner's next step; the
 *  day-grained countdownText would read "today" for every one of them. */
export function untilText(ms: number, now: number): string {
  const mins = Math.ceil((ms - now) / 60_000);
  if (mins < 1) return "due now";
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "in 1 day" : `in ${days} days`;
}
