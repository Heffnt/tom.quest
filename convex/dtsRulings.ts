import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireTom } from "./authRoles";
import { applyStatusChange, logEvent } from "./dts";

// Tom's rulings, unified over life and code todos (ratified 2026-08-28).
// A ruling = subject + verdict + optional sentence + timestamp. The closed
// verdict set (see schema.ts dtsRulings) is the ONLY vocabulary any ruling
// button anywhere may use:
//   approve — execute as briefed
//   revise  — one written sentence redirects the preparing agent, no session
//   session — this needs conversation
//   archive — set aside
// "defer" is not a verdict: not ruling IS deferring; timing changes are a
// reschedule (dtsBlocks / a time note), not a ruling.
//
// SENTENCE ON ANY VERDICT (2026-08-29): all four verdicts accept the optional
// `sentence`. Required only on revise; on archive it is the unarchive
// condition; on approve/session it is a free note that reaches the batcher
// prompt, the preparer prompt, and the session's opening prompt.
//
// Life-subject verdicts take their immediate effect here (revise drops
// readiness to "preparing"; archive archives). Code subjects are applied by
// the worker's apply job (repo is the system of record). appliedAt/applyResult
// record the application either way; a newer ruling on the same subject
// supersedes an older unapplied one (append-only, history kept).

const VERDICT = v.union(
  v.literal("approve"),
  v.literal("revise"),
  v.literal("session"),
  v.literal("archive"),
);

export type RulingVerdict = "approve" | "revise" | "session" | "archive";

// The ONE definition of a ruling subject's identity (repo names carry no
// spaces; the type prefix keeps life and code keys disjoint). Client code
// derives live rulings with the same rule via app/dts/lib.ts.
export const subjectKey = (row: {
  subjectType: "life" | "code";
  todoId?: string;
  repo?: string;
  externalId?: string;
}) =>
  row.subjectType === "life"
    ? `life ${row.todoId}`
    : `code ${row.repo} ${row.externalId}`;

// ── Tom-facing ───────────────────────────────────────────────────────────────

// Everything, always: append-only at human pace — a full collect is fine and
// lets the client find the live (newest ruledAt) ruling per subject.
export const listRulings = query({
  args: {},
  handler: async (ctx) => {
    await requireTom(ctx, "DTS");
    return await ctx.db.query("dtsRulings").collect();
  },
});

// The ONE implementation of recording a ruling — used by the Tom-gated
// recordRuling below and by internalRecordRuling (a live session's pen, the
// dts.internalTriage pattern), so verdict semantics cannot drift between the
// two doors.
async function insertRuling(
  ctx: MutationCtx,
  {
    todoId,
    repo,
    externalId,
    verdict,
    sentence,
    unarchiveCondition,
  }: {
    todoId?: Id<"dtsTodos">;
    repo?: string;
    externalId?: string;
    verdict: RulingVerdict;
    sentence?: string;
    unarchiveCondition?: string;
  },
) {
  const isLife = todoId !== undefined;
    const isCode = repo !== undefined || externalId !== undefined;
    if (isLife === isCode) {
      throw new Error(
        "A ruling has exactly one subject: todoId (life) OR repo+externalId (code)",
      );
    }
    if (isCode && (repo === undefined || externalId === undefined)) {
      throw new Error("A code ruling requires both repo and externalId");
    }
    // One optional written note on EVERY verdict (ratified 2026-08-29): the
    // four verdicts are uniform, each taking an optional note. Its MEANING is
    // per-verdict and unchanged — revise: the redirect (still required);
    // archive: the condition to propose it back; approve/session: free
    // steering the worker prompts and the session prompt read.
    const trimmed = sentence?.trim();
    if (verdict === "revise" && !trimmed) {
      throw new Error(
        "revise is the sentence verdict — write the sentence that redirects the agent",
      );
    }
    const now = Date.now();

    let appliedAt: number | undefined;
    let applyResult: string | undefined;
    if (isLife) {
      const todo = await ctx.db.get(todoId);
      if (!todo) throw new Error("DTS todo not found");
      // A ruling is a Tom touch: tomTouchedAt freezes the row to the batcher
      // (internalStoreBatches never rewrites or retires it) — EXCEPT revise,
      // the one verdict that hands the subject BACK to the preparing agent
      // (for a batch, the batcher must stay allowed to re-form it).
      if (verdict !== "revise") {
        await ctx.db.patch(todoId, { tomTouchedAt: now });
      }
      if (verdict === "revise") {
        await ctx.db.patch(todoId, { readiness: "preparing", updatedAt: now });
      }
      if (verdict === "archive") {
        await applyStatusChange(ctx, todo, {
          status: "archived",
          // On archive the sentence IS the unarchive condition (the one
          // option row now sends a single note per verdict); the older
          // explicit arg still wins when a caller passes both.
          unarchiveCondition: unarchiveCondition ?? trimmed,
          note: trimmed,
        });
        appliedAt = now;
        applyResult = "status archived";
      }
      if (verdict === "approve") {
        // No agent executes life todos yet — Tom is the executor. Approving a
        // life plan is pure ratification, so it applies the moment it is
        // recorded (leaving it "pending" would strand it forever: every
        // worker filters life rows to revise). When a life executor exists,
        // this is the line that changes.
        appliedAt = now;
        applyResult = "plan ratified";
      }
      // session: applied when the session is created (claudeSessions.createSession marks).
    }

    const id = await ctx.db.insert("dtsRulings", {
      subjectType: isLife ? "life" : "code",
      todoId,
      repo,
      externalId,
      verdict,
      sentence: trimmed || undefined,
      ruledAt: now,
      appliedAt,
      applyResult,
    });
    await logEvent(ctx, "ruling", todoId, {
      verdict,
      repo,
      externalId,
      sentence: trimmed || undefined,
    });
    return id;
}

export const recordRuling = mutation({
  args: {
    todoId: v.optional(v.id("dtsTodos")),
    repo: v.optional(v.string()),
    externalId: v.optional(v.string()),
    verdict: VERDICT,
    sentence: v.optional(v.string()),
    // archive on a life todo only: the condition under which it should be
    // proposed back (same field setStatus carries).
    unarchiveCondition: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTom(ctx, "DTS");
    return await insertRuling(ctx, args);
  },
});

// A live session's ruling pen (dts.internalTriage pattern): internal so the
// session agent can record Tom's spoken verdicts via `npx convex run
// dtsRulings:internalRecordRuling` with deploy credentials — recordRuling
// above requires Tom's browser identity, which the box does not hold. Only
// ever run while Tom is present and ruling; it is his pen, not a policy actor.
export const internalRecordRuling = internalMutation({
  args: {
    todoId: v.optional(v.string()),
    repo: v.optional(v.string()),
    externalId: v.optional(v.string()),
    verdict: VERDICT,
    sentence: v.optional(v.string()),
    unarchiveCondition: v.optional(v.string()),
  },
  handler: async (ctx, { todoId, ...rest }) => {
    let normalized: Id<"dtsTodos"> | undefined;
    if (todoId !== undefined) {
      const id = ctx.db.normalizeId("dtsTodos", todoId);
      if (!id) throw new Error(`Unknown todo id: ${todoId}`);
      normalized = id;
    }
    return await insertRuling(ctx, { todoId: normalized, ...rest });
  },
});

// ── Internal: worker paths (key-authed http.ts routes) ───────────────────────

/** Newest ruling per subject, from a full collect. */
export function liveRulings(
  all: Doc<"dtsRulings">[],
): Map<string, Doc<"dtsRulings">> {
  const newest = new Map<string, Doc<"dtsRulings">>();
  for (const row of all) {
    const key = subjectKey(row);
    const prior = newest.get(key);
    // ruledAt wins; _creationTime breaks same-millisecond ties.
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

/**
 * A "session" verdict is applied the moment its session exists. Called by
 * claudeSessions.createSession so the supersession rule stays defined HERE
 * (one implementation), not inlined at the session layer.
 */
export async function markLiveSessionRulingApplied(
  ctx: MutationCtx,
  todoId: Id<"dtsTodos">,
  sessionId: string,
): Promise<void> {
  const rulings = await ctx.db
    .query("dtsRulings")
    .withIndex("by_todo", (q) => q.eq("todoId", todoId))
    .collect();
  const live = liveRulings(rulings).get(
    subjectKey({ subjectType: "life", todoId }),
  );
  if (live && live.verdict === "session" && live.appliedAt === undefined) {
    await ctx.db.patch(live._id, {
      appliedAt: Date.now(),
      applyResult: `session ${sessionId}`,
    });
  }
}

// The rulings a worker job should act on: appliedAt unset AND not superseded
// (a newer ruling on the same subject makes the older one dead history). Both
// subject types ride the same feed — the worker filters by subjectType (code →
// apply job; life revise → the preparer consumes the sentence).
export const internalPendingRulings = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("dtsRulings").collect();
    const newest = liveRulings(all);
    return all.filter(
      (row) =>
        row.appliedAt === undefined &&
        newest.get(subjectKey(row))?._id === row._id,
    );
  },
});

// Apply callback: the worker reports what it did (commit sha / PR url) or how
// it failed (error text) — either way the ruling is consumed (appliedAt set),
// with the outcome on record in applyResult.
export const internalMarkRulingApplied = internalMutation({
  args: { id: v.string(), result: v.string() },
  handler: async (ctx, { id, result }) => {
    // The worker sends plain strings over HTTP; normalizeId is the proper
    // reject-with-a-name path for malformed/wrong-table ids.
    const normalized = ctx.db.normalizeId("dtsRulings", id);
    if (!normalized) throw new Error(`Unknown ruling id: ${id}`);
    const ruling = await ctx.db.get(normalized);
    if (!ruling) throw new Error(`Unknown ruling id: ${id}`);
    await ctx.db.patch(normalized, { appliedAt: Date.now(), applyResult: result });
    await logEvent(ctx, "ruling-applied", ruling.todoId, {
      verdict: ruling.verdict,
      repo: ruling.repo,
      externalId: ruling.externalId,
      result,
    });
  },
});

// Digest input: how many briefed code todos await a ruling. A brief awaits
// when its live ruling is missing OR OLDER than the brief — a re-brief after
// a revise ruling puts the item back on Tom's plate (the fresh plan needs a
// fresh ruling). The client-side needs-me selector (app/dts/lib.ts) mirrors
// this predicate.
export function briefAwaitsRuling(
  brief: { repo: string; externalId: string; preparedAt: number },
  live: Map<string, Doc<"dtsRulings">>,
): boolean {
  const ruling = live.get(
    subjectKey({
      subjectType: "code",
      repo: brief.repo,
      externalId: brief.externalId,
    }),
  );
  return ruling === undefined || ruling.ruledAt < brief.preparedAt;
}

// Batcher context (GET /dts/batch-context): what Tom ruled lately, newest
// first — a grouping signal, not a work feed (that is internalPendingRulings).
export const internalRecentRulings = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    return await ctx.db
      .query("dtsRulings")
      .withIndex("by_ruled")
      .order("desc")
      .take(Math.min(limit ?? 200, 1000));
  },
});

export const internalAwaitingRulingCount = internalQuery({
  args: {},
  handler: async (ctx) => {
    const briefs = await ctx.db.query("dtsCodeBriefs").collect();
    const live = liveRulings(await ctx.db.query("dtsRulings").collect());
    return briefs.filter((b) => briefAwaitsRuling(b, live)).length;
  },
});

// One-time migration (run at deploy: `npx convex run dtsRulings:internalMigrateCodeRulings`):
// copy dtsCodeRulings history into the unified table under the ratified
// verdict mapping. "defer" rows are NOT copied — defer is no longer a verdict
// (not ruling is deferring); they stay in the deprecated table as history.
// Idempotent: a row whose (repo, externalId, ruledAt) already exists is skipped.
export const internalMigrateCodeRulings = internalMutation({
  args: {},
  handler: async (ctx) => {
    const MAP: Record<string, RulingVerdict | undefined> = {
      approve: "approve",
      "stale-replan": "revise",
      "needs-session": "session",
      "propose-archive": "archive",
      defer: undefined,
    };
    const old = await ctx.db.query("dtsCodeRulings").collect();
    const existing = await ctx.db.query("dtsRulings").collect();
    const seen = new Set(
      existing
        .filter((r) => r.subjectType === "code")
        .map((r) => `${r.repo} ${r.externalId} ${r.ruledAt}`),
    );
    let copied = 0;
    let skippedDefer = 0;
    for (const row of old) {
      const verdict = MAP[row.ruling];
      if (verdict === undefined) {
        skippedDefer++;
        continue;
      }
      const key = `${row.repo} ${row.externalId} ${row.ruledAt}`;
      if (seen.has(key)) continue;
      await ctx.db.insert("dtsRulings", {
        subjectType: "code",
        repo: row.repo,
        externalId: row.externalId,
        verdict,
        // revise requires a sentence (recordRuling invariant) — a note-less
        // stale-replan row gets an honest placeholder rather than minting a
        // sentence-less revise ruling.
        sentence:
          verdict === "revise" && !row.note
            ? "(migrated stale-replan ruling — no note was recorded)"
            : row.note,
        ruledAt: row.ruledAt,
        appliedAt: row.appliedAt,
        applyResult: row.applyResult,
      });
      copied++;
    }
    return { copied, skippedDefer, total: old.length };
  },
});
