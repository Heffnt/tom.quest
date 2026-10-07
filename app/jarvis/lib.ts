// Shared types + date/age helpers for the /tts surface.
// All persisted dates are epoch-ms numbers (convex/schema.ts todos).

import type { Doc, Id } from "@/convex/_generated/dataModel";
import { displayDay, newYorkDay, newYorkParts } from "@/shared/clock.mjs";

export type Todo = Doc<"todos">;
export type MirrorRow = Doc<"dtsCodeTodoMirror">;
export type CodeBrief = Doc<"dtsCodeBriefs">;
// A ruling the page shows: on a todo or a code entry. listRulings hands its
// todo's plain id (convex/jarvis/tables.ts withPlainTodoIds), the id a Todo
// row carries.
export type Ruling = Omit<Doc<"rulings">, "todoId"> & { todoId?: Id<"todos">; subjectType: "life" | "code" };

/** A ruling as listRulings returns it. The batch subject went with the
 * batches table (2026-09-26), so every listed ruling is a Ruling; the guard
 * below stays as the page's own check of what it shows. */
type ListedRuling = Omit<Doc<"rulings">, "todoId"> & { todoId?: Id<"todos">; subjectType: string };

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
  rulingAnswers,
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
    return ruling === undefined || !rulingAnswers(ruling, t);
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

/** e.message for Errors, String(e) otherwise — the error line under a control. */
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The intent vocabulary is owned by convex/ttsShared.ts (ttsItemLink is the
// single producer of ?item=&intent= links); this is just its local name.
export type { TtsLinkIntent as LinkIntent } from "@/convex/ttsShared";

/** "Sun Aug 30, 2026" — absolute New York date, shown small/faint next to countdown text. */
export function fmtDate(ms: number): string {
  return `${displayDay(ms)}, ${newYorkParts(ms).year}`;
}

/** "2026-08-30", the New York date — for date-history lines. */
export const isoDate = newYorkDay;

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
