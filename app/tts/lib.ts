// Shared types + date/age helpers for the /tts surface.
// All persisted dates are epoch-ms numbers (convex/schema.ts todos).

import type { Doc } from "@/convex/_generated/dataModel";
import type { runnerStatus } from "@/convex/ttsRunners";

export type Todo = Doc<"todos">;
export type MirrorRow = Doc<"dtsCodeTodoMirror">;
export type CodeBrief = Doc<"dtsCodeBriefs">;
// A ruling the page shows: on a todo or a code entry.
export type Ruling = Doc<"rulings"> & { subjectType: "life" | "code" };

/** A ruling as listRulings returns it. A ruling on a batch can still come
 * back until the schema stops declaring that subject (Tom, 2026-09-24: no
 * batches); the record keeps it, no page shows its subject, and
 * liveRulingsByKey drops it. Once the schema narrows this is Ruling. */
type ListedRuling = Doc<"rulings"> & { subjectType: string };

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
