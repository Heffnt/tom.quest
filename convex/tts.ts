import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireTom } from "./authRoles";
import {
  goalCheckable,
  nyCalendarDayKey,
  nyOffsetHours,
} from "./ttsShared";
import { ZONE } from "../shared/clock.mjs";
import { eitherId, resolveId } from "./jarvis/tables";

// TTS (Delegated Todo System) — life-todo store, instrumentation and daily queue.
// Spec: WikiTom tts/spec.md. Everything Tom-facing is
// Tom-gated (forge.ts pattern); everything the Jarvis Box or crons touch goes
// through internal functions (http.ts routes are key-authed with TTS_WORKER_KEY).

// The WRITE gate: Tom only. Every mutation on this surface calls it.
async function requireTomId(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  return await requireTom(ctx, "TTS");
}

// The worker's pen below still ACCEPTS retired readiness spellings and stores
// them normalized.
const STATUS = v.union(
  v.literal("active"),
  v.literal("waiting"),
  v.literal("archived"),
  v.literal("done"),
);
const TIMING_CLASS = v.union(v.literal("dated"), v.literal("whenever"));
const DATE_KIND = v.union(v.literal("external"), v.literal("self-imposed"));
const DATE_OUTCOME = v.union(
  v.literal("done"),
  v.literal("renegotiated"),
  v.literal("missed"),
);
export async function logEvent(
  ctx: MutationCtx,
  kind: string,
  todoId?: Id<"todos"> | Id<"dtsTodos">,
  data?: unknown,
  // The indexed lookup key (schema: dtsEvents.key) — set on the kinds the
  // schema comment lists, and on no other.
  key?: string,
) {
  // A failure row (convex/ttsShared.ts isFailureKind) records the condition;
  // nothing posts here.
  // The row names its todo by the plain id, whichever form it was handed (a
  // session or a stored reference may hold the old one); an id naming no row
  // names no todo (convex/jarvis/tables.ts resolveId).
  const id = await ctx.db.insert("dtsEvents", {
    at: Date.now(),
    kind,
    todoId: todoId === undefined ? undefined : ((await resolveId(ctx, "todos", todoId)) ?? undefined),
    data: data === undefined ? undefined : data,
    key,
  });
  return id;
}

// ── Tom-facing queries ───────────────────────────────────────────────────────

// Inventory: everything, always (spec §6). Single-user table, small for years —
// a full collect is fine and lets the client group/filter freely.
export const listTodos = query({
  args: {},
  handler: async (ctx) => {
    await requireTomId(ctx);
    return await ctx.db.query("todos").collect();
  },
});

// ── Tom-facing mutations ─────────────────────────────────────────────────────

export const createTodo = mutation({
  args: {
    statement: v.string(),
    body: v.optional(v.string()),
    timingClass: v.optional(TIMING_CLASS),
    dueAt: v.optional(v.number()),
    dateKind: v.optional(DATE_KIND),
    condition: v.optional(v.string()),
    workDescription: v.optional(v.string()),
    entryAction: v.optional(v.string()),
    category: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTomId(ctx);
    const now = Date.now();
    const timingClass = args.timingClass ?? (args.dueAt ? "dated" : "whenever");
    const id = await ctx.db.insert("todos", {
      statement: args.statement.trim(),
      body: args.body,
      readiness: "unprepared",
      status: "active",
      timingClass,
      dueAt: args.dueAt,
      dateKind: args.dueAt ? (args.dateKind ?? "self-imposed") : undefined,
      condition: args.condition,
      category: args.category,
      source: "manual",
      workDescription: args.workDescription,
      entryAction: args.entryAction,
      createdAt: now,
      updatedAt: now,
    });
    await logEvent(ctx, "created", id, { source: "manual" });
    return id;
  },
});

/** What a write that changes a todo's dueAt also writes: the rollover's mark
 *  for the old date no longer holds (schema todos.rolledOverDueAt), so the
 *  5 a.m. rollover reads the row again once its new date passes. Every write
 *  of dueAt carries it. */
export const DATE_MOVED = { rolledOverDueAt: undefined } as const;

// The ONE place an open date resolves as kept when an item completes — called
// by internalTriage(done) and recordDateOutcome(done) so the kept-dates side
// effects cannot drift between the two paths (review finding).
function resolveDateAsDone(
  todo: Doc<"todos">,
  now: number,
  note: string | undefined,
  patch: Record<string, unknown>,
) {
  patch.status = "done";
  patch.doneAt = now;
  if (todo.dueAt !== undefined) {
    patch.dateOutcomes = [
      ...(todo.dateOutcomes ?? []),
      { dueAt: todo.dueAt, outcome: "done" as const, recordedAt: now, note },
    ];
    patch.dueAt = undefined;
    Object.assign(patch, DATE_MOVED);
  }
}

// The ONE implementation of a status transition (spec §5.1) — used by the
// internalTriage (live sessions applying Tom's spoken rulings via `npx convex
// run`), and by ttsRulings.recordRuling
// (the archive verdict). Nothing is ever deleted: "archived" and "done" are
// the only terminal states, both kept and visible.
export async function applyStatusChange(
  ctx: MutationCtx,
  todo: Doc<"todos">,
  args: {
    status: "active" | "waiting" | "archived" | "done";
    wakeAt?: number;
    unarchiveCondition?: string;
    note?: string;
  },
) {
  const { status, wakeAt, unarchiveCondition, note } = args;
  const now = Date.now();
  const patch: Record<string, unknown> = { status, updatedAt: now };
  if (status === "active") {
    // Reopening: stale terminal/sleep facts must not linger on a live item
    // (descriptive-never-evaluative demands the panel state be TRUE).
    patch.doneAt = undefined;
    patch.archivedAt = undefined;
    patch.unarchiveCondition = undefined;
    patch.wakeAt = undefined;
  }
  if (status === "waiting") {
    // A sleep is a TIME (the lifeos update, phase 7). The prose wake
    // condition this branch used to store is retired: what a row is waiting
    // for belongs in its statement, where every reader already looks.
    patch.wakeAt = wakeAt;
  }
  if (status === "archived") {
    patch.archivedAt = now;
    patch.unarchiveCondition = unarchiveCondition;
  }
  if (status === "done") {
    // An open date on a completed item resolves as kept (kept-dates rule).
    resolveDateAsDone(todo, now, note, patch);
  }
  await ctx.db.patch(todo._id, patch);
  await logEvent(ctx, "status-changed", todo._id, {
    from: todo.status,
    to: status,
    note,
  });
}

// Triage from a LIVE session with Tom (the Friday session, or any interactive
// session where he rules out loud and the session agent records it): an
// internal mutation so the agent can apply rulings via `npx convex run
// tts:internalTriage` with the deploy credentials Tom's machine holds. Only
// ever run while Tom is present and ruling — it is his pen, not a policy
// actor. It uses the shared status-transition implementation, plus an
// optional self-imposed date for undated items (dated items keep the
// kept-dates rule: dates move only via recordDateOutcome).
export const internalTriage = internalMutation({
  args: {
    id: v.string(),
    status: v.optional(STATUS),
    dueAt: v.optional(v.number()),
    wakeAt: v.optional(v.number()),
    unarchiveCondition: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { id, status, dueAt, ...rest }) => {
    const normalized = await resolveId(ctx, "todos", id);
    if (!normalized) throw new Error(`Unknown todo id: ${id}`);
    const todo = await ctx.db.get(normalized);
    if (!todo) throw new Error(`Unknown todo id: ${id}`);
    if (dueAt !== undefined) {
      if (todo.dueAt !== undefined) {
        throw new Error(
          "Item already has a date — move it via recordDateOutcome (kept-dates rule), not triage",
        );
      }
      await ctx.db.patch(normalized, {
        dueAt,
        ...DATE_MOVED,
        dateKind: "self-imposed",
        timingClass: "dated",
        updatedAt: Date.now(),
      });
      await logEvent(ctx, "updated", normalized, { fields: ["dueAt"], via: "triage" });
    }
    if (status !== undefined) {
      const fresh = await ctx.db.get(normalized);
      if (fresh) await applyStatusChange(ctx, fresh, { status, ...rest });
    }
    // Triage is Tom's pen: a Tom touch, so the row is frozen to the planner —
    // but only when the call actually did something. A no-op/retry pen call
    // must not freeze a row.
    if (status !== undefined || dueAt !== undefined) {
      await ctx.db.patch(normalized, { tomTouchedAt: Date.now() });
    }
  },
});

// Bulk field edits from a LIVE session with Tom (the internalTriage pattern):
// an internal mutation so the session agent can record Tom's spoken rulings
// via `npx convex run tts:internalBulkUpdate` with the deploy credentials
// Tom's machine holds. Only ever run while Tom is present and ruling — it is
// his pen, not a policy actor.
export const internalBulkUpdate = internalMutation({
  args: {
    updates: v.array(
      v.object({
        id: v.string(),
        category: v.optional(v.union(v.string(), v.null())),
        entryAction: v.optional(v.string()),
        workDescription: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { updates }) => {
    for (const u of updates) {
      const normalized = await resolveId(ctx, "todos", u.id);
      if (!normalized) throw new Error(`Unknown todo id: ${u.id}`);
      const todo = await ctx.db.get(normalized);
      if (!todo) throw new Error(`Unknown todo id: ${u.id}`);
      const now = Date.now();
      const patch: Record<string, unknown> = { tomTouchedAt: now };
      const fields: string[] = [];
      if (u.category !== undefined) {
        patch.category = u.category === null ? undefined : u.category;
        fields.push("category");
      }
      if (u.entryAction !== undefined) {
        patch.entryAction = u.entryAction;
        fields.push("entryAction");
      }
      if (u.workDescription !== undefined) {
        patch.workDescription = u.workDescription;
        fields.push("workDescription");
      }
      // Every field this pen writes is a content edit, so it bumps updatedAt;
      // a call that carries none must not (the ruledAt<updatedAt predicate
      // would resurface an already-ruled gate).
      if (fields.length > 0) patch.updatedAt = now;
      await ctx.db.patch(normalized, patch);
      await logEvent(ctx, "bulk-updated", normalized, { fields });
    }
  },
});

// The ONE implementation of the kept-dates rule (spec §8) — used by the
// Tom-gated recordDateOutcome below AND by internalApplyTimeNote (the time-note
// worker acting on Tom's written instruction), so the rule cannot drift between
// the two doors. Every date resolves to done | renegotiated | missed;
// renegotiation is only legal BEFORE the date arrives; the silent slide is the
// one forbidden outcome. "renegotiated" and "missed" both take a newDueAt only
// when the item stays dated ("missed" without a new date drops the item back to
// whenever with the miss on record).
export async function applyDateOutcome(
  ctx: MutationCtx,
  todo: Doc<"todos">,
  {
    outcome,
    newDueAt,
    note,
  }: {
    outcome: "done" | "renegotiated" | "missed";
    newDueAt?: number;
    note?: string;
  },
) {
  if (todo.dueAt === undefined) throw new Error("Todo has no date to resolve");
  const now = Date.now();
  if (outcome === "renegotiated") {
    if (now >= todo.dueAt) {
      throw new Error(
        "Renegotiation is only allowed before the date arrives — record it as missed, then set a new date",
      );
    }
    if (newDueAt === undefined) {
      throw new Error("Renegotiation requires the new date");
    }
  }
  const patch: Record<string, unknown> = {
    updatedAt: now,
    dateOutcomes: [
      ...(todo.dateOutcomes ?? []),
      { dueAt: todo.dueAt, outcome, recordedAt: now, note },
    ],
  };
  if (outcome === "done") {
    resolveDateAsDone(todo, now, note, patch); // overwrites dateOutcomes consistently
  } else if (newDueAt !== undefined) {
    patch.dueAt = newDueAt;
    Object.assign(patch, DATE_MOVED);
    if (todo.dateKind === undefined) patch.dateKind = "self-imposed";
  } else {
    patch.dueAt = undefined;
    Object.assign(patch, DATE_MOVED);
    patch.timingClass = "whenever";
  }
  await ctx.db.patch(todo._id, patch);
  await logEvent(ctx, "date-outcome", todo._id, { outcome, newDueAt, note });
}

export const recordDateOutcome = mutation({
  args: {
    id: eitherId.todos,
    outcome: DATE_OUTCOME,
    newDueAt: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...args }) => {
    await requireTomId(ctx);
    const plain = await resolveId(ctx, "todos", id);
    const todo = plain === null ? null : await ctx.db.get(plain);
    if (!todo) throw new Error("TTS todo not found");
    await applyDateOutcome(ctx, todo, args);
  },
});

// The record's clock for the planner, read through
// shared/clock.mjs (the box reads the same zone through its own clock.mjs).
export function nowContext(utcMs: number) {
  return {
    now: utcMs,
    nowIso: new Date(utcMs).toISOString(),
    nyCalendarDay: nyCalendarDayKey(utcMs),
    nyOffsetHours: nyOffsetHours(utcMs),
    timezone: ZONE,
  };
}

// ── Internal: worker submissions (via key-authed http.ts routes) ─────────────

export const internalCapture = internalMutation({
  args: {
    statement: v.string(),
    source: v.string(),
    provenance: v.optional(v.string()),
    threadMessageId: v.optional(v.string()),
    dueAt: v.optional(v.number()),
    dateKind: v.optional(v.union(v.literal("external"), v.literal("self-imposed"))),
  },
  handler: async (
    ctx,
    { statement, source, provenance, threadMessageId, dueAt, dateKind },
  ) => {
    const now = Date.now();
    const stored = threadMessageId === undefined
      ? null
      : (await ctx.db
          .query("todos")
          .withIndex("by_threadMessageId", (q) => q.eq("threadMessageId", threadMessageId))
          .first()) ?? null;
    // Idempotent on the thread message: a box job that acted but crashed
    // before posting its reply must not mint the todo twice on its next run.
    if (stored) return stored._id;
    // A dated capture names its dateKind: dueAt is the time, dateKind says
    // who imposed it, and both ride the row. Without dueAt the row stays
    // whenever, exactly as a plain capture did.
    if (dueAt !== undefined && dateKind === undefined) {
      throw new Error("a dated capture names its dateKind");
    }
    const id = await ctx.db.insert("todos", {
      statement: statement.trim(),
      readiness: "unprepared",
      status: "active",
      timingClass: dueAt !== undefined ? "dated" : "whenever",
      dueAt,
      ...(dueAt !== undefined ? { dateKind } : {}),
      threadMessageId,
      source,
      provenance,
      createdAt: now,
      updatedAt: now,
    });
    await logEvent(ctx, "captured", id, { source });
    return id;
  },
});

// The preparation path for LIFE todos (spec §15, swarm-lite): the worker's
// preparer job advances an unprepared capture toward prepared by
// attaching the ground-up brief, the smallest entry action, and a qualitative
// work description. It never touches statement or status — those are Tom's
// (or the capture's) and preparation must not rewrite intent. Since
// 2026-08-29 it may also set a FIRST dueAt, and only when the statement
// itself states the date (the QuickAdd date input is gone): Tom's own words,
// never an agent's guess, and never over an existing date.
export const internalPrepareTodo = internalMutation({
  args: {
    id: v.string(),
    brief: v.optional(v.string()),
    entryAction: v.optional(v.string()),
    workDescription: v.optional(v.string()),
    // "prepared" is the value (ruling 18), and the only one this pen takes.
    // The retired spellings a pre-rename box job wrote are refused since the
    // narrow (the lifeos update, phase 7; the planner's prepare pass writes
    // "prepared"). The literal "unprepared" is refused too: an agent must
    // never erase the record that a todo was written up.
    readiness: v.optional(v.literal("prepared")),
    // ── The worker's three args (schema v2, 2026-08-29) ──────────────────────
    // A worker session advances one todo by one stable state, and this is the
    // pen it writes that state with. It needs three things the plan-era pen
    // did not have:
    //   evidence             — the artifact that shows the work happened (a
    //                          branch, a pull request, a written brief). The
    //                          schema field of the same name, per row.
    //   groundUpExplanation  — the self-contained "more" layer, written when a
    //                          task turns out to need Tom's judgment and he has
    //                          to be able to rule on it cold.
    //   status: "done"       — closes the row, which is what makes every todo
    //                          that NEEDS it ready. Accepted for any todo Tom
    //                          has not ruled on, once its evidence is recorded
    //                          (the bars are at the end of the handler). "done"
    //                          is the only value — archiving and sleeping stay
    //                          Tom's verdicts.
    evidence: v.optional(v.string()),
    groundUpExplanation: v.optional(v.string()),
    status: v.optional(v.literal("done")),
    // The date the STATEMENT itself states ("pay rent sept 3"). The QuickAdd
    // date input is gone (2026-08-29), so this is how an explicit date Tom
    // wrote in his own words reaches the row. Statement text is Tom's, so this
    // is not an agent inventing a date — but the guard below is absolute: only
    // when the todo has no dueAt yet, never an overwrite.
    dueAt: v.optional(v.number()),
    dateKind: v.optional(DATE_KIND),
    // THE RUN THAT WROTE THE WRITE-UP. A ruling of Tom's on this todo is a
    // judgment about the text he read on the page, and this token is the only
    // honest edge back to the run that produced it (convex/agentLabels.ts; the
    // schema note on runs.regToken says why a time-window search over `runs`
    // by todoId is wrong on the ordinary case). Absent is a supported value:
    // an unregistered caller stamps nothing and a ruling on the row writes no
    // label rather than a guessed one.
    runToken: v.optional(v.string()),
    // THE DOOR CHECK'S MARK (phase 9). The planner's prepare pass reads what
    // it wrote against the writing standard and retries once; a write-up that
    // fails on both attempts is still posted, and these are the complaints it
    // failed on (Tom, 2026-09-12: "Agreed." — a silent hole costs more than a
    // marked fault). They ride the "prepared" event's `data` below rather than
    // the todo row: `data` is v.any(), so no schema change, and dtsEvents
    // by_todo already finds them. A PASS SENDS NO doorFaults KEY AT ALL, so
    // the newest "prepared" row answers "was the last write-up refused" by
    // itself and there is nothing to clear.
    doorFaults: v.optional(v.array(v.string())),
  },
  handler: async (
    ctx,
    { id, brief, entryAction, workDescription, readiness, dueAt, dateKind, evidence, groundUpExplanation, status, runToken, doorFaults },
  ) => {
    const normalized = await resolveId(ctx, "todos", id);
    if (!normalized) throw new Error(`Unknown todo id: ${id}`);
    const todo = await ctx.db.get(normalized);
    if (!todo) throw new Error(`Unknown todo id: ${id}`);
    const now = Date.now();
    const patch: Record<string, unknown> = { updatedAt: now };
    // Every field lands on every row. The batch gate that used to sit here —
    // a row carrying `members` took only its plan, because the v1 batcher
    // owned its brief — went with the v1 batch itself (the lifeos update,
    // phase 7): there is no grouping brief for a single-todo preparer to
    // overwrite any more, and a batch is its own `batches` row.
    if (brief !== undefined) patch.brief = brief;
    if (evidence !== undefined) patch.evidence = evidence;
    if (groundUpExplanation !== undefined) {
      patch.groundUpExplanation = groundUpExplanation;
    }
    if (entryAction !== undefined) patch.entryAction = entryAction;
    if (workDescription !== undefined) patch.workDescription = workDescription;
    if (readiness !== undefined) patch.readiness = readiness;
    if (dueAt !== undefined) {
      // Kept-dates rule (spec §8): a stored date moves only through
      // recordDateOutcome / a time note. The preparer gets the FIRST date
      // only — an existing one is never overwritten, and the skip is named.
      // A RESOLVED date counts as a date: an item whose date was recorded
      // missed or renegotiated has a dateOutcomes history, and letting a
      // re-prep read the same statement and hand back the very date Tom just
      // resolved would resurrect it behind his back.
      if (todo.dueAt !== undefined || (todo.dateOutcomes ?? []).length > 0) {
        await logEvent(ctx, "due-skipped", normalized, { dueAt });
      } else {
        patch.dueAt = dueAt;
        Object.assign(patch, DATE_MOVED);
        patch.dateKind = dateKind ?? "self-imposed";
        patch.timingClass = "dated";
      }
    }
    const written = [
      patch.brief !== undefined && "brief",
      patch.entryAction !== undefined && "entryAction",
      patch.workDescription !== undefined && "workDescription",
      patch.dueAt !== undefined && "dueAt",
      patch.evidence !== undefined && "evidence",
      patch.groundUpExplanation !== undefined && "groundUpExplanation",
    ].filter(Boolean);
    // THE STAMP FOLLOWS THE TEXT, and only the text. A call that wrote one of
    // the prepared fields above produced what Tom reads on the page, and its
    // run owns that text. A call that wrote NONE of them — the graph worker's
    // bare `status: "done"`, which closes a row and says nothing — wrote no
    // Tom-facing words, and stamping it would hand that run the credit (and
    // the blame) for a write-up another run made: a ruling on the row would
    // then be scored against the wrong output, which is the one failure the
    // whole token mechanism exists to prevent.
    if (runToken !== undefined && written.length > 0) {
      patch.producedByRunToken = runToken;
    }
    await ctx.db.patch(normalized, patch);
    await logEvent(ctx, "prepared", normalized, {
      readiness: patch.readiness,
      fields: written,
      ...(doorFaults === undefined ? {} : { doorFaults }),
    });
    // Completion runs LAST and through the ONE transition implementation
    // (applyStatusChange): a raw status patch would skip the kept-dates
    // resolution on a dated row and emit no status-changed event. It reads the
    // row as it stands AFTER the patch above, so the evidence written in the
    // same call is already on it.
    if (status === "done") {
      const fresh = await ctx.db.get(normalized);
      if (!fresh) return { ok: true as const };
      // THE THREE BARS, most specific first. Each is a NAMED refusal rather
      // than a silent skip: a worker that thinks it closed a todo and did not
      // would report work as landed that is still open, and only this row
      // would say otherwise.
      //
      //   (a) evidence recorded. Tom ruled on 2026-09-24 to have no batches,
      //       so agents move toward completing all todos, and any todo he has
      //       not ruled on may be closed by an agent with its evidence
      //       recorded. The bar that stood here before — only a todo inside a
      //       batch could be completed by the pen — cannot stay: with no
      //       batches it would let no agent complete anything, the opposite of
      //       the ruling. The evidence bar replaces it as the thing that stops
      //       a bare status write closing one of Tom's todos with nothing to
      //       show for it.
      //   (b) a goal's condition is a GOAL CONDITION — a sentence about the
      //       world that is either true yet or not. A goal with no condition
      //       and no code subject has nothing an agent can go and check, and
      //       closing it would be closing Tom's todo for him. A todo with a
      //       condition is closed only when the condition is met, which is what
      //       its evidence has to show.
      //   (c) not frozen, unless it is a checkable goal. tomTouchedAt is the
      //       mark that Tom has ruled on the row, and every other agent write
      //       in this file respects it. A CHECKABLE goal is the one exception,
      //       and it is the design: its condition, not a judgment, decides it,
      //       and checking the world and recording the answer is a goal's
      //       whole contract.
      const why =
        (fresh.evidence ?? "").trim() === ""
          ? "a todo is completed by the pen only with its evidence recorded"
          : fresh.kind === "goal" && !goalCheckable(fresh)
            ? "a goal is completed by the pen only when it has a checkable condition or a code subject"
            : fresh.tomTouchedAt !== undefined && fresh.kind !== "goal"
              ? "Tom-touched (frozen) — only he closes a row he has ruled on"
              : null;
      // A refusal is answered, not swallowed: the caller gets it back (the
      // route answers 409 with the why) and the event keeps it on the record.
      // The fields written above stand — they are the write-up, which is not
      // what was refused — so the answer names only the completion.
      if (why !== null) {
        await logEvent(ctx, "done-skipped", normalized, { why });
        return { ok: false as const, reason: `not completed: ${why}` };
      }
      if (fresh.status !== "done") {
        await applyStatusChange(ctx, fresh, {
          status: "done",
          note: "worker: task completed",
        });
      }
    }
    return { ok: true as const };
  },
});

export const internalListTodos = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("todos").collect();
  },
});
