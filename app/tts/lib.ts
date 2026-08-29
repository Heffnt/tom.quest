// Shared types + date/age helpers for the /tts surface.
// All persisted dates are epoch-ms numbers (convex/schema.ts dtsTodos).

import type { Doc } from "@/convex/_generated/dataModel";

export type Todo = Doc<"dtsTodos">;
export type Batch = Doc<"batches">;
export type MirrorRow = Doc<"dtsCodeTodoMirror">;
export type CodeBrief = Doc<"dtsCodeBriefs">;
export type Ruling = Doc<"dtsRulings">;

export type Importance = NonNullable<Todo["importance"]>;
export type PlanStep = NonNullable<Todo["plan"]>[number];
export type Member = NonNullable<Todo["members"]>[number];

export const IMPORTANCE_LEVELS = ["low", "medium", "high"] as const;

// The closed verdict set — convex/ttsRulings.ts owns the union; this is the
// client's iterable of the same four values.
export type RulingVerdict = "approve" | "revise" | "session" | "archive";
export const VERDICTS: RulingVerdict[] = [
  "approve",
  "revise",
  "session",
  "archive",
];

// ── Ruling subject identity + live-ruling derivation ─────────────────────────
// Client mirror of convex/ttsRulings.ts subjectKey/liveRulings — same key
// format, same newest-ruledAt/_creationTime rule, so the tabs, the badge, and
// the worker feed always agree on which ruling is live.

export function rulingSubjectKey(r: {
  subjectType: "life" | "code" | "batch";
  todoId?: string;
  repo?: string;
  externalId?: string;
  batchId?: string;
}): string {
  if (r.subjectType === "life") return `life ${r.todoId}`;
  if (r.subjectType === "batch") return `batch ${r.batchId}`;
  return `code ${r.repo} ${r.externalId}`;
}

export function codeSubjectKey(repo: string, externalId: string): string {
  return `code ${repo} ${externalId}`;
}

/** A schema-v2 batch subject (a `batches` row is its own ruling subject). */
export function batchSubjectKey(batchId: string): string {
  return `batch ${batchId}`;
}

// ── Batches v1 ───────────────────────────────────────────────────────────────
// A row with `members` IS a batch — that one field is the whole discrimination
// (convex/schema.ts dtsTodos). Superseded by the schema-v2 `batches` table
// (its own row) and kept live until cutover.

export function isBatch(t: Todo): boolean {
  return t.members !== undefined;
}

// ── The todo graph (schema v2) ───────────────────────────────────────────────
// NOT redefined here: convex/ttsShared.ts is the ONE home for the graph rules,
// so the server's frontier and the page's frontier cannot drift. This is only
// the client's local name for them.
export {
  MAX_NEEDS,
  buildDoneSet,
  isReady,
  frontier,
} from "@/convex/ttsShared";

// Client mirror of convex/tts.ts memberKey — one definition of the key format,
// delegated to rulingSubjectKey/codeSubjectKey above, so member identity and
// ruling identity cannot drift apart.
export function clientMemberKey(m: Member): string {
  return m.todoId !== undefined
    ? rulingSubjectKey({ subjectType: "life", todoId: m.todoId })
    : codeSubjectKey(m.repo!, m.externalId!);
}

/**
 * Open actor-"tom" steps — the card's "needs you" strip. Each step keeps its
 * index in the todo's plan array, because that index is what
 * tts.setPlanStep({index}) addresses.
 */
export function planNeedsYou(plan: PlanStep[] | undefined): {
  count: number;
  steps: { step: PlanStep; index: number }[];
} {
  const steps = (plan ?? [])
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.actor === "tom" && step.status === "open");
  return { count: steps.length, steps };
}

/**
 * Member completion against the maps the caller already builds (the batches
 * tab holds both in a useMemo): a life member is done when its todo is
 * done|archived; a code member ONLY when its mirror row exists and is closed.
 * A missing mirror row is not evidence of completion — it may be closed
 * upstream or it may be an id that never matched a row — so it does not count.
 */
export function memberProgress(
  members: Member[],
  todoById: Map<string, Todo>,
  mirrorByKey: Map<string, MirrorRow>,
): { done: number; total: number } {
  let done = 0;
  for (const m of members) {
    if (m.todoId !== undefined) {
      const t = todoById.get(m.todoId);
      if (t && (t.status === "done" || t.status === "archived")) done += 1;
    } else {
      const row = mirrorByKey.get(codeSubjectKey(m.repo!, m.externalId!));
      if (row && row.status === "closed") done += 1;
    }
  }
  return { done, total: members.length };
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
//   ruling (mirror of convex/ttsRulings.ts briefAwaitsRuling).
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

// ── The batches selector (ONE definition; the batches tab renders it, the
// badge counts it) ───────────────────────────────────────────────────────────
// batches: non-terminal (active|waiting) batch rows; awaitingRuling is
//   selectNeedsMe lifeRows membership — a batch IS a life todo, so the same
//   live-ruling predicate decides when it needs a ruling.
// unbatchedLife/unbatchedCode: the selectNeedsMe rows minus subjects claimed
//   by any non-terminal batch (and minus the batch rows themselves).
// pending: passed through from selectNeedsMe.

const IMPORTANCE_RANK = { low: 1, medium: 2, high: 3 } as const;

export type BatchesSelection = {
  batches: { todo: Todo; awaitingRuling: boolean }[];
  unbatchedLife: Todo[];
  unbatchedCode: { row: MirrorRow; brief: CodeBrief }[];
  pending: Ruling[];
};

export function selectBatches(
  todos: Todo[],
  mirror: MirrorRow[],
  briefs: CodeBrief[],
  rulings: Ruling[],
): BatchesSelection {
  const { lifeRows, codeRows, pending } = selectNeedsMe(
    todos,
    mirror,
    briefs,
    rulings,
  );

  const batchTodos = todos.filter(
    (t) => isBatch(t) && (t.status === "active" || t.status === "waiting"),
  );

  const claimed = new Set<string>();
  for (const b of batchTodos) {
    for (const m of b.members ?? []) claimed.add(clientMemberKey(m));
  }
  const batchIds = new Set<string>(batchTodos.map((t) => t._id as string));
  const lifeIds = new Set<string>(lifeRows.map((t) => t._id as string));

  // Importance desc (unset last), tie createdAt asc.
  const batches = batchTodos
    .map((todo) => ({ todo, awaitingRuling: lifeIds.has(todo._id as string) }))
    .sort((a, b) => {
      const ra = a.todo.importance
        ? IMPORTANCE_RANK[a.todo.importance.level]
        : 0;
      const rb = b.todo.importance
        ? IMPORTANCE_RANK[b.todo.importance.level]
        : 0;
      if (ra !== rb) return rb - ra;
      return a.todo.createdAt - b.todo.createdAt;
    });

  const unbatchedLife = lifeRows.filter(
    (t) =>
      // A row bound into a graph batch renders inside that batch's card —
      // its ONE home. Listing it here too would repeat content.
      t.batchId === undefined &&
      !batchIds.has(t._id as string) &&
      !claimed.has(clientMemberKey({ todoId: t._id })),
  );
  const unbatchedCode = codeRows.filter(
    ({ row }) => !claimed.has(codeSubjectKey(row.repo, row.externalId)),
  );

  return { batches, unbatchedLife, unbatchedCode, pending };
}

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
