// Shared types + date/age helpers for the /dts surface.
// All persisted dates are epoch-ms numbers (convex/schema.ts dtsTodos).

import type { Doc } from "@/convex/_generated/dataModel";

export type Todo = Doc<"dtsTodos">;
export type MirrorRow = Doc<"dtsCodeTodoMirror">;
export type CodeBrief = Doc<"dtsCodeBriefs">;
export type Ruling = Doc<"dtsRulings">;

// The closed verdict set — convex/dtsRulings.ts owns the union; this is the
// client's iterable of the same four values.
export type RulingVerdict = "approve" | "revise" | "session" | "archive";
export const VERDICTS: RulingVerdict[] = [
  "approve",
  "revise",
  "session",
  "archive",
];

// ── Ruling subject identity + live-ruling derivation ─────────────────────────
// Client mirror of convex/dtsRulings.ts subjectKey/liveRulings — same key
// format, same newest-ruledAt/_creationTime rule, so the tabs, the badge, and
// the worker feed always agree on which ruling is live.

export function rulingSubjectKey(r: {
  subjectType: "life" | "code";
  todoId?: string;
  repo?: string;
  externalId?: string;
}): string {
  return r.subjectType === "life"
    ? `life ${r.todoId}`
    : `code ${r.repo} ${r.externalId}`;
}

export function codeSubjectKey(repo: string, externalId: string): string {
  return `code ${repo} ${externalId}`;
}

export function liveRulingsByKey(rulings: Ruling[]): Map<string, Ruling> {
  const newest = new Map<string, Ruling>();
  for (const row of rulings) {
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

// ── The needs-me selector (ONE definition; the tab renders it, the badge
// counts it) ─────────────────────────────────────────────────────────────────
// life: active + ready-for-tom, excluding todos whose live ruling is at least
//   as new as the todo's last update — a ruled gate is answered until the
//   preparer touches the todo again (re-prep bumps updatedAt past ruledAt).
// code: open + briefed, where the live ruling is missing or OLDER than the
//   brief — a re-brief after a revise ruling returns the item for a fresh
//   ruling (mirror of convex/dtsRulings.ts briefAwaitsRuling).
// pending: live rulings not yet applied (the "ruled, applying" strip).

export type NeedsMe = {
  lifeRows: Todo[];
  codeRows: { row: MirrorRow; brief: CodeBrief }[];
  pending: Ruling[];
};

export function selectNeedsMe(
  todos: Todo[],
  mirror: MirrorRow[],
  briefs: CodeBrief[],
  rulings: Ruling[],
): NeedsMe {
  const live = liveRulingsByKey(rulings);

  const lifeRows = todos.filter((t) => {
    if (t.status !== "active" || t.readiness !== "ready-for-tom") return false;
    const ruling = live.get(
      rulingSubjectKey({ subjectType: "life", todoId: t._id }),
    );
    return ruling === undefined || ruling.ruledAt < t.updatedAt;
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
    if (ruling === undefined || ruling.ruledAt < brief.preparedAt) {
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

/** Epoch ms → <input type="datetime-local"> value in LOCAL time. */
export function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// The intent vocabulary is owned by convex/dtsShared.ts (dtsItemLink is the
// single producer of ?item=&intent= links); this is just its local name.
export type { DtsLinkIntent as LinkIntent } from "@/convex/dtsShared";

/** "Aug 30, 2026" — absolute date, shown small/faint next to countdown text. */
export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** "2026-08-30" in local time — for date-history lines and date-input prefills. */
export function isoDate(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * <input type="date"> value → epoch ms at noon LOCAL time (avoids the
 * UTC-midnight off-by-one when the value round-trips through a date key).
 */
export function parseDateInput(value: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(`${value}T12:00:00`).getTime();
  return Number.isNaN(ms) ? undefined : ms;
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
