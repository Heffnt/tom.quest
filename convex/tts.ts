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
  TTS_PREP_NY_HOUR,
  ttsDayBoundsUtc,
  ttsDayKey,
  ttsPrepDay,
  nyLocalHour,
} from "./ttsShared";

// TTS (Delegated Todo System) — life-todo store, instrumentation, daily queue,
// and the code-todo mirror. Spec: WikiTom tts/spec.md. Everything Tom-facing is
// Tom-gated (forge.ts pattern); everything the worker box or crons touch goes
// through internal functions (http.ts routes are key-authed with TTS_WORKER_KEY).

async function requireTomId(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  return await requireTom(ctx, "TTS");
}

// One queue size for every producer: the fallback rules here and (mirrored in
// its prompt) the worker's Claude prep, enforced again at intake in
// internalStoreWorkerPrep.
const QUEUE_MAX = 7;

const READINESS = v.union(
  v.literal("unprepared"),
  v.literal("preparing"),
  v.literal("ready-for-tom"),
);
const STATUS = v.union(
  v.literal("active"),
  v.literal("waiting"),
  v.literal("archived"),
  v.literal("done"),
);
const TIMING_CLASS = v.union(
  v.literal("dated"),
  v.literal("condition-bound"),
  v.literal("whenever"),
);
const DATE_KIND = v.union(v.literal("external"), v.literal("self-imposed"));
const DATE_OUTCOME = v.union(
  v.literal("done"),
  v.literal("renegotiated"),
  v.literal("missed"),
);
export const IMPORTANCE_LEVEL = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
);
// The ONE server-side encoding of importance order: higher = more important,
// unset ranks 0 (below "low"). Lockstep with app/tts/lib.ts IMPORTANCE_RANK —
// the client bundle cannot import this server module, so it carries a copy of
// the same values; change both together.
export const IMPORTANCE_RANK = { low: 1, medium: 2, high: 3 } as const;
// A batch member addresses exactly one subject, in the ttsRulings shape
// (life by todoId, code by repo+externalId) — enforced in validateBatchMembers.
const MEMBER = v.object({
  todoId: v.optional(v.id("dtsTodos")),
  repo: v.optional(v.string()),
  externalId: v.optional(v.string()),
});
const PLAN_STEP = v.object({
  text: v.string(),
  actor: v.union(v.literal("tom"), v.literal("agent")),
  status: v.union(v.literal("open"), v.literal("done")),
  doneAt: v.optional(v.number()),
  evidence: v.optional(v.string()),
});

type Member = { todoId?: Id<"dtsTodos">; repo?: string; externalId?: string };

// Same identity convention as ttsRulings.subjectKey — one vocabulary for
// "which subject is this" everywhere.
export function memberKey(m: Member): string {
  return m.todoId !== undefined
    ? `life ${m.todoId}`
    : `code ${m.repo} ${m.externalId}`;
}

// Array caps (Convex guideline: array fields on a document must be bounded —
// an unbounded array grows a single row without limit). A batch groups 1..20
// subjects; a plan holds at most 40 steps.
const MAX_BATCH_MEMBERS = 20;
const MAX_PLAN_STEPS = 40;

type Importance = {
  level: "low" | "medium" | "high";
  setBy: "tom" | "agent";
  setAt: number;
  rationale?: string;
};

// The ONE implementation of the agent-importance guard (used by
// internalPrepareTodo, internalStoreBatches, and ttsCode.internalStoreBriefs):
// an agent write never overwrites Tom's — returns undefined when the stored
// value has setBy "tom" (the caller logs importance-skipped), else the new
// importance object.
export function agentImportancePatch(
  existing: Importance | undefined,
  level: "low" | "medium" | "high",
  rationale: string | undefined,
  now: number,
): Importance | undefined {
  if (existing?.setBy === "tom") return undefined;
  return { level, setBy: "agent", setAt: now, rationale };
}

// Shared membership gate (updateTodo + internalStoreBatches): every member
// addresses exactly one subject, no duplicates, no batch-in-batch, no batch
// containing itself. Code members are NOT checked against the mirror — mirror
// rows churn on upstream close; a vanished code member renders "closed
// upstream" client-side.
async function validateBatchMembers(
  ctx: QueryCtx | MutationCtx,
  members: Member[],
  opts: {
    selfId?: Id<"dtsTodos">;
    // Callers that already hold a full collect (internalStoreBatches) pass it
    // here so member lookups reuse it instead of per-member ctx.db.get.
    todoById?: Map<Id<"dtsTodos">, Doc<"dtsTodos">>;
  } = {},
) {
  // Bounded arrays (Convex unbounded-array-field guideline): an empty batch
  // is not a grouping, and a batch never exceeds MAX_BATCH_MEMBERS subjects.
  if (members.length === 0) {
    throw new Error("A batch needs at least one member");
  }
  if (members.length > MAX_BATCH_MEMBERS) {
    throw new Error(
      `A batch holds at most ${MAX_BATCH_MEMBERS} members — got ${members.length}`,
    );
  }
  const seen = new Set<string>();
  for (const m of members) {
    const isLife = m.todoId !== undefined;
    const isCode = m.repo !== undefined || m.externalId !== undefined;
    if (isLife === isCode) {
      throw new Error(
        `A member addresses exactly one subject: todoId (life) OR repo+externalId (code) — got ${JSON.stringify(m)}`,
      );
    }
    if (isCode && (m.repo === undefined || m.externalId === undefined)) {
      throw new Error(
        `A code member needs both repo and externalId — got ${JSON.stringify(m)}`,
      );
    }
    const key = memberKey(m);
    if (seen.has(key)) throw new Error(`Duplicate member: ${key}`);
    seen.add(key);
    if (m.todoId !== undefined) {
      if (m.todoId === opts.selfId) {
        throw new Error("A batch cannot contain itself");
      }
      const todo = opts.todoById
        ? opts.todoById.get(m.todoId)
        : await ctx.db.get(m.todoId);
      if (!todo) throw new Error(`Member todo not found: ${m.todoId}`);
      if (todo.members !== undefined) {
        throw new Error(
          `"${todo.statement}" is itself a batch — no batch-in-batch`,
        );
      }
    }
  }
}

export async function logEvent(
  ctx: MutationCtx,
  kind: string,
  todoId?: Id<"dtsTodos">,
  data?: unknown,
) {
  await ctx.db.insert("dtsEvents", {
    at: Date.now(),
    kind,
    todoId,
    data: data === undefined ? undefined : data,
  });
}

// ── Tom-facing queries ───────────────────────────────────────────────────────

// Inventory: everything, always (spec §6). Single-user table, small for years —
// a full collect is fine and lets the client group/filter freely.
export const listTodos = query({
  args: {},
  handler: async (ctx) => {
    await requireTomId(ctx);
    return await ctx.db.query("dtsTodos").collect();
  },
});

export const listMirror = query({
  args: {},
  handler: async (ctx) => {
    await requireTomId(ctx);
    return await ctx.db.query("dtsCodeTodoMirror").collect();
  },
});

// Focus: today's queue row (entries joined with their todos) — null when no
// prep has happened yet today.
export const getToday = query({
  args: {},
  handler: async (ctx) => {
    await requireTomId(ctx);
    const day = ttsDayKey(Date.now());
    const row = await ctx.db
      .query("dtsDailyQueues")
      .withIndex("by_day", (q) => q.eq("day", day))
      .first();
    if (!row) return { day, queue: null };
    const todos = [];
    for (const entry of row.entries) {
      const todo = await ctx.db.get(entry.todoId);
      if (todo) todos.push({ ...todo, queueReason: entry.reason });
    }
    return {
      day,
      queue: {
        preparedAt: row.preparedAt,
        preparedBy: row.preparedBy,
        digestSentAt: row.digestSentAt,
        todos,
      },
    };
  },
});

export const listRecentEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requireTomId(ctx);
    return await ctx.db
      .query("dtsEvents")
      .withIndex("by_at")
      .order("desc")
      .take(Math.min(limit ?? 200, 1000));
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
    latestSafeAt: v.optional(v.number()),
    workDescription: v.optional(v.string()),
    entryAction: v.optional(v.string()),
    category: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTomId(ctx);
    const now = Date.now();
    const timingClass = args.timingClass ?? (args.dueAt ? "dated" : "whenever");
    const id = await ctx.db.insert("dtsTodos", {
      statement: args.statement.trim(),
      body: args.body,
      readiness: "unprepared",
      status: "active",
      timingClass,
      dueAt: args.dueAt,
      dateKind: args.dueAt ? (args.dateKind ?? "self-imposed") : undefined,
      condition: args.condition,
      latestSafeAt: args.latestSafeAt,
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

// Generic field edit. Only fields present in args change; updatedAt always
// bumps. Status transitions go through setStatus (they carry side effects).
export const updateTodo = mutation({
  args: {
    id: v.id("dtsTodos"),
    statement: v.optional(v.string()),
    body: v.optional(v.string()),
    readiness: v.optional(READINESS),
    timingClass: v.optional(TIMING_CLASS),
    dueAt: v.optional(v.union(v.number(), v.null())),
    dateKind: v.optional(DATE_KIND),
    condition: v.optional(v.string()),
    latestSafeAt: v.optional(v.union(v.number(), v.null())),
    wakeCondition: v.optional(v.string()),
    wakeAt: v.optional(v.union(v.number(), v.null())),
    unarchiveCondition: v.optional(v.string()),
    workDescription: v.optional(v.string()),
    entryAction: v.optional(v.string()),
    brief: v.optional(v.string()),
    category: v.optional(v.union(v.string(), v.null())),
    members: v.optional(v.union(v.array(MEMBER), v.null())),
    plan: v.optional(v.union(v.array(PLAN_STEP), v.null())),
  },
  handler: async (ctx, { id, ...fields }) => {
    await requireTomId(ctx);
    const todo = await ctx.db.get(id);
    if (!todo) throw new Error("TTS todo not found");
    // Kept-dates rule (spec §8): a date never just disappears — the silent
    // slide is the one forbidden outcome. Clearing dueAt directly is refused;
    // dates leave via recordDateOutcome (done / renegotiated / missed).
    if (fields.dueAt === null && todo.dueAt !== undefined) {
      throw new Error(
        "A date is never cleared silently — resolve it via recordDateOutcome (renegotiated before the date, or missed)",
      );
    }
    // Bounded arrays (Convex unbounded-array-field guideline): a plan never
    // exceeds MAX_PLAN_STEPS steps.
    if (
      fields.plan !== undefined &&
      fields.plan !== null &&
      fields.plan.length > MAX_PLAN_STEPS
    ) {
      throw new Error(
        `A plan holds at most ${MAX_PLAN_STEPS} steps — got ${fields.plan.length}`,
      );
    }
    // Batch membership: validated per member, then against every OTHER
    // non-terminal batch — a subject lives in at most one (full collect:
    // single-user table).
    if (fields.members !== undefined && fields.members !== null) {
      await validateBatchMembers(ctx, fields.members, { selfId: id });
      const keys = new Set(fields.members.map(memberKey));
      const selfKey = memberKey({ todoId: id });
      const all = await ctx.db.query("dtsTodos").collect();
      for (const other of all) {
        if (other._id === id || other.members === undefined) continue;
        if (other.status !== "active" && other.status !== "waiting") continue;
        for (const m of other.members) {
          if (keys.has(memberKey(m))) {
            throw new Error(
              `${memberKey(m)} is already in batch "${other.statement}"`,
            );
          }
          // The other direction of validateBatchMembers' no-batch-in-batch
          // rule: promoting a row to a batch while it is itself a member of a
          // non-terminal batch would nest batches through the back door.
          if (memberKey(m) === selfKey) {
            throw new Error(
              `"${todo.statement}" is a member of batch "${other.statement}" — no batch-in-batch`,
            );
          }
        }
      }
    }
    const now = Date.now();
    // Every updateTodo edit is a Tom touch — tomTouchedAt marks the row FROZEN
    // to the batcher (internalStoreBatches never rewrites or retires it).
    const patch: Record<string, unknown> = { updatedAt: now, tomTouchedAt: now };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      patch[key] = value === null ? undefined : value;
    }
    // Setting a due date on a whenever item promotes it to dated (spec §5.2);
    // an explicit timingClass in the same call wins.
    if (
      patch.dueAt !== undefined &&
      fields.timingClass === undefined &&
      todo.timingClass === "whenever"
    ) {
      patch.timingClass = "dated";
      if (patch.dateKind === undefined && todo.dateKind === undefined) {
        patch.dateKind = "self-imposed";
      }
    }
    await ctx.db.patch(id, patch);
    await logEvent(ctx, "updated", id, { fields: Object.keys(fields) });
  },
});

// The ONE place an open date resolves as kept when an item completes — called
// by setStatus(done) and recordDateOutcome(done) so the kept-dates side
// effects cannot drift between the two paths (review finding).
function resolveDateAsDone(
  todo: Doc<"dtsTodos">,
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
  }
}

// The ONE implementation of a status transition (spec §5.1) — used by the
// Tom-gated setStatus below, by internalTriage (live sessions applying
// Tom's spoken rulings via `npx convex run`), and by ttsRulings.recordRuling
// (the archive verdict). Nothing is ever deleted: "archived" and "done" are
// the only terminal states, both kept and visible.
export async function applyStatusChange(
  ctx: MutationCtx,
  todo: Doc<"dtsTodos">,
  args: {
    status: "active" | "waiting" | "archived" | "done";
    wakeCondition?: string;
    wakeAt?: number;
    unarchiveCondition?: string;
    note?: string;
  },
) {
  const { status, wakeCondition, wakeAt, unarchiveCondition, note } = args;
  const now = Date.now();
  const patch: Record<string, unknown> = { status, updatedAt: now };
  if (status === "active") {
    // Reopening: stale terminal/sleep facts must not linger on a live item
    // (descriptive-never-evaluative demands the panel state be TRUE).
    patch.doneAt = undefined;
    patch.archivedAt = undefined;
    patch.unarchiveCondition = undefined;
    patch.wakeCondition = undefined;
    patch.wakeAt = undefined;
  }
  if (status === "waiting") {
    patch.wakeCondition = wakeCondition;
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

export const setStatus = mutation({
  args: {
    id: v.id("dtsTodos"),
    status: STATUS,
    wakeCondition: v.optional(v.string()),
    wakeAt: v.optional(v.number()),
    unarchiveCondition: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...args }) => {
    await requireTomId(ctx);
    const todo = await ctx.db.get(id);
    if (!todo) throw new Error("TTS todo not found");
    await applyStatusChange(ctx, todo, args);
    // Stamped HERE, not in applyStatusChange: internalStoreBatches archives
    // its own batches through applyStatusChange, and an agent action must not
    // stamp a Tom touch (tomTouchedAt freezes the row to the batcher).
    await ctx.db.patch(id, { tomTouchedAt: Date.now() });
  },
});

// Triage from a LIVE session with Tom (the Friday session, or any interactive
// session where he rules out loud and the session agent records it): an
// internal mutation so the agent can apply rulings via `npx convex run
// tts:internalTriage` with the deploy credentials Tom's machine holds. Only
// ever run while Tom is present and ruling — it is his pen, not a policy
// actor. Same status semantics as setStatus (one implementation), plus an
// optional self-imposed date for undated items (dated items keep the
// kept-dates rule: dates move only via recordDateOutcome).
export const internalTriage = internalMutation({
  args: {
    id: v.string(),
    status: v.optional(STATUS),
    dueAt: v.optional(v.number()),
    wakeCondition: v.optional(v.string()),
    wakeAt: v.optional(v.number()),
    unarchiveCondition: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { id, status, dueAt, ...rest }) => {
    const normalized = ctx.db.normalizeId("dtsTodos", id);
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
    // Triage is Tom's pen: a Tom touch, so the row is frozen to the batcher —
    // but only when the call actually did something. A no-op/retry pen call
    // must not freeze a batch.
    if (status !== undefined || dueAt !== undefined) {
      await ctx.db.patch(normalized, { tomTouchedAt: Date.now() });
    }
  },
});

// Bulk field edits from a LIVE session with Tom (the internalTriage pattern):
// an internal mutation so the session agent can record Tom's spoken rulings
// via `npx convex run tts:internalBulkUpdate` with the deploy credentials
// Tom's machine holds. Only ever run while Tom is present and ruling — it is
// his pen, not a policy actor; importance therefore lands as setBy "tom"
// (it records his SPOKEN ruling, which the agent guard must respect).
export const internalBulkUpdate = internalMutation({
  args: {
    updates: v.array(
      v.object({
        id: v.string(),
        importanceLevel: v.optional(v.union(IMPORTANCE_LEVEL, v.null())),
        importanceRationale: v.optional(v.string()),
        category: v.optional(v.union(v.string(), v.null())),
        entryAction: v.optional(v.string()),
        workDescription: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { updates }) => {
    for (const u of updates) {
      const normalized = ctx.db.normalizeId("dtsTodos", u.id);
      if (!normalized) throw new Error(`Unknown todo id: ${u.id}`);
      const todo = await ctx.db.get(normalized);
      if (!todo) throw new Error(`Unknown todo id: ${u.id}`);
      const now = Date.now();
      const patch: Record<string, unknown> = { tomTouchedAt: now };
      const fields: string[] = [];
      if (u.importanceLevel !== undefined) {
        patch.importance =
          u.importanceLevel === null
            ? undefined
            : {
                level: u.importanceLevel,
                setBy: "tom",
                setAt: now,
                rationale: u.importanceRationale,
              };
        fields.push("importance");
      }
      let content = false;
      if (u.category !== undefined) {
        patch.category = u.category === null ? undefined : u.category;
        fields.push("category");
        content = true;
      }
      if (u.entryAction !== undefined) {
        patch.entryAction = u.entryAction;
        fields.push("entryAction");
        content = true;
      }
      if (u.workDescription !== undefined) {
        patch.workDescription = u.workDescription;
        fields.push("workDescription");
        content = true;
      }
      // Content edits bump updatedAt; importance alone is an annotation and
      // must not resurface ruled gates (the ruledAt<updatedAt predicate).
      if (content) patch.updatedAt = now;
      await ctx.db.patch(normalized, patch);
      await logEvent(ctx, "bulk-updated", normalized, { fields });
    }
  },
});

// Kept-dates rule (spec §8): every date resolves to done | renegotiated |
// missed; renegotiation is only legal BEFORE the date arrives; the silent
// slide is the one forbidden outcome. "renegotiated" and "missed" both require
// a newDueAt only when the item stays dated ("missed" without a new date drops
// the item back to whenever with the miss on record).
export const recordDateOutcome = mutation({
  args: {
    id: v.id("dtsTodos"),
    outcome: DATE_OUTCOME,
    newDueAt: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { id, outcome, newDueAt, note }) => {
    await requireTomId(ctx);
    const todo = await ctx.db.get(id);
    if (!todo) throw new Error("TTS todo not found");
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
      if (todo.dateKind === undefined) patch.dateKind = "self-imposed";
    } else {
      patch.dueAt = undefined;
      patch.timingClass = "whenever";
    }
    await ctx.db.patch(id, patch);
    await logEvent(ctx, "date-outcome", id, { outcome, newDueAt, note });
  },
});

// Tom's importance override (null clears the whole object). An annotation, so
// no updatedAt bump — bumping would resurface ruled gates via the needs-me
// ruledAt<updatedAt predicate. setBy "tom" makes every agent write a no-op
// until cleared (the guard lives in the internal mutations).
export const setImportance = mutation({
  args: {
    id: v.id("dtsTodos"),
    level: v.union(IMPORTANCE_LEVEL, v.null()),
  },
  handler: async (ctx, { id, level }) => {
    await requireTomId(ctx);
    const todo = await ctx.db.get(id);
    if (!todo) throw new Error("TTS todo not found");
    const now = Date.now();
    await ctx.db.patch(id, {
      importance:
        level === null ? undefined : { level, setBy: "tom", setAt: now },
      tomTouchedAt: now,
    });
    await logEvent(ctx, "importance-set", id, { level, setBy: "tom" });
  },
});

// Tom checks a plan step off (or reopens it). An annotation like importance:
// tomTouchedAt is stamped, updatedAt is not.
export const setPlanStep = mutation({
  args: {
    id: v.id("dtsTodos"),
    index: v.number(),
    status: v.union(v.literal("open"), v.literal("done")),
  },
  handler: async (ctx, { id, index, status }) => {
    await requireTomId(ctx);
    const todo = await ctx.db.get(id);
    if (!todo) throw new Error("TTS todo not found");
    if (todo.plan === undefined) throw new Error("Todo has no plan");
    if (!Number.isInteger(index) || index < 0 || index >= todo.plan.length) {
      throw new Error(`Plan has no step ${index}`);
    }
    const now = Date.now();
    // doneAt: undefined on reopen — an undefined object field is stored as
    // absent, so the stale timestamp clears.
    const plan = todo.plan.map((step, i) =>
      i === index
        ? { ...step, status, doneAt: status === "done" ? now : undefined }
        : step,
    );
    await ctx.db.patch(id, { plan, tomTouchedAt: now });
    await logEvent(ctx, "plan-step", id, { index, status });
  },
});

// ── Blocks: committed time (ratified 2026-08-28) ─────────────────────────────
// One row = one placed span on Tom's calendar, targeting exactly one todo
// (per-todo commitment) or one category ("chores"; "code" = the code-todo
// mirror). Blocks are calendar strokes, not todos — moving or deleting one is
// rescheduling, recorded as an event, never a "ruling".

function requireOneBlockTarget(todoId: unknown, category: unknown) {
  if ((todoId === undefined) === (category === undefined)) {
    throw new Error(
      "A block targets exactly one thing: a todoId OR a category",
    );
  }
}

// Optional [start, end) window: blocks overlapping it (block.start < end AND
// block.end > start), served from the by_start index so the calendar's
// subscription carries one week, not the whole ever-growing table. No args =
// everything (small-table admin/test use).
export const listBlocks = query({
  args: { start: v.optional(v.number()), end: v.optional(v.number()) },
  handler: async (ctx, { start, end }) => {
    await requireTomId(ctx);
    const rows =
      end === undefined
        ? await ctx.db.query("dtsBlocks").collect()
        : await ctx.db
            .query("dtsBlocks")
            .withIndex("by_start", (q) => q.lt("start", end))
            .collect();
    return start === undefined ? rows : rows.filter((b) => b.end > start);
  },
});

export const createBlock = mutation({
  args: {
    start: v.number(),
    end: v.number(),
    todoId: v.optional(v.id("dtsTodos")),
    category: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { start, end, todoId, category, note }) => {
    await requireTomId(ctx);
    // Trim BEFORE the exactly-one check: a whitespace-only category must not
    // pass the check and then collapse into a targetless block.
    const trimmedCategory = category?.trim() || undefined;
    requireOneBlockTarget(todoId, trimmedCategory);
    if (end <= start) throw new Error("A block ends after it starts");
    if (todoId !== undefined) {
      const todo = await ctx.db.get(todoId);
      if (!todo) throw new Error("TTS todo not found");
    }
    const id = await ctx.db.insert("dtsBlocks", {
      start,
      end,
      todoId,
      category: trimmedCategory,
      note,
      createdAt: Date.now(),
    });
    await logEvent(ctx, "block-created", todoId, { start, end, category });
    return id;
  },
});

export const updateBlock = mutation({
  args: {
    id: v.id("dtsBlocks"),
    start: v.optional(v.number()),
    end: v.optional(v.number()),
    note: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { id, start, end, note }) => {
    await requireTomId(ctx);
    const block = await ctx.db.get(id);
    if (!block) throw new Error("Block not found");
    const nextStart = start ?? block.start;
    const nextEnd = end ?? block.end;
    if (nextEnd <= nextStart) throw new Error("A block ends after it starts");
    await ctx.db.patch(id, {
      start: nextStart,
      end: nextEnd,
      note: note === null ? undefined : (note ?? block.note),
    });
    // block-moved only when the span actually changed — a note-only edit is
    // not a move and must not fake one in the event stream.
    if (nextStart !== block.start || nextEnd !== block.end) {
      await logEvent(ctx, "block-moved", block.todoId, {
        from: { start: block.start, end: block.end },
        to: { start: nextStart, end: nextEnd },
        category: block.category,
      });
    }
  },
});

export const deleteBlock = mutation({
  args: { id: v.id("dtsBlocks") },
  handler: async (ctx, { id }) => {
    await requireTomId(ctx);
    const block = await ctx.db.get(id);
    if (!block) throw new Error("Block not found");
    await ctx.db.delete(id);
    await logEvent(ctx, "block-deleted", block.todoId, {
      start: block.start,
      end: block.end,
      category: block.category,
    });
  },
});

// Instrumentation hook for the surfaces (spec §10): Focus/Inventory record
// engagement, queue cycling, session starts, etc. Kind is free-form by
// convention; the analysis layer is a later TTS todo.
export const recordEvent = mutation({
  args: {
    kind: v.string(),
    todoId: v.optional(v.id("dtsTodos")),
    data: v.optional(v.any()),
  },
  handler: async (ctx, { kind, todoId, data }) => {
    await requireTomId(ctx);
    await logEvent(ctx, kind, todoId, data);
  },
});

// ── Internal: worker submissions (via key-authed http.ts routes) ─────────────

export const internalCapture = internalMutation({
  args: {
    statement: v.string(),
    source: v.string(),
    provenance: v.optional(v.string()),
  },
  handler: async (ctx, { statement, source, provenance }) => {
    const now = Date.now();
    const id = await ctx.db.insert("dtsTodos", {
      statement: statement.trim(),
      readiness: "unprepared",
      status: "active",
      timingClass: "whenever",
      source,
      provenance,
      createdAt: now,
      updatedAt: now,
    });
    await logEvent(ctx, "captured", id, { source });
    return id;
  },
});

export const internalStoreWorkerPrep = internalMutation({
  args: {
    day: v.string(),
    todoIds: v.array(v.string()),
    reasons: v.optional(v.array(v.string())),
    digestText: v.optional(v.string()),
  },
  handler: async (ctx, { day, todoIds, reasons, digestText }) => {
    const entries: { todoId: Id<"dtsTodos">; reason?: string }[] = [];
    const dropped: { id: string; why: string }[] = [];
    for (let i = 0; i < todoIds.length; i++) {
      // The worker sends plain strings over HTTP; normalizeId is the proper
      // reject-with-a-name path for malformed/wrong-table ids.
      const normalized = ctx.db.normalizeId("dtsTodos", todoIds[i]);
      if (!normalized) throw new Error(`Unknown todo id: ${todoIds[i]}`);
      const todo = await ctx.db.get(normalized);
      if (!todo) throw new Error(`Unknown todo id: ${todoIds[i]}`);
      // The model sees waiting items for context but must not queue them; a
      // sleeping card on Focus would contradict the Inventory. Drop, don't
      // reject — one bad pick shouldn't cost the whole prepared queue.
      if (todo.status !== "active") {
        dropped.push({ id: todoIds[i], why: `status ${todo.status}` });
        continue;
      }
      if (entries.length >= QUEUE_MAX) {
        dropped.push({ id: todoIds[i], why: "over queue cap" });
        continue;
      }
      entries.push({ todoId: todo._id, reason: reasons?.[i] });
    }
    const now = Date.now();
    const existing = await ctx.db
      .query("dtsDailyQueues")
      .withIndex("by_day", (q) => q.eq("day", day))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        entries,
        digestText,
        preparedAt: now,
        preparedBy: "worker",
      });
    } else {
      await ctx.db.insert("dtsDailyQueues", {
        day,
        entries,
        digestText,
        preparedAt: now,
        preparedBy: "worker",
      });
    }
    await logEvent(ctx, "queue-prepared", undefined, {
      day,
      by: "worker",
      count: entries.length,
      dropped: dropped.length > 0 ? dropped : undefined,
    });
  },
});

// The preparation path for LIFE todos (spec §15, swarm-lite): the worker's
// preparer job advances an unprepared capture toward ready-for-tom by
// attaching the ground-up brief, the smallest entry action, and a qualitative
// work description. It never touches statement/status/dates — those are
// Tom's (or the capture's) and preparation must not rewrite intent.
export const internalPrepareTodo = internalMutation({
  args: {
    id: v.string(),
    brief: v.optional(v.string()),
    entryAction: v.optional(v.string()),
    workDescription: v.optional(v.string()),
    readiness: v.optional(
      v.union(v.literal("preparing"), v.literal("ready-for-tom")),
    ),
    importanceLevel: v.optional(IMPORTANCE_LEVEL),
    importanceRationale: v.optional(v.string()),
    plan: v.optional(v.array(PLAN_STEP)),
  },
  handler: async (
    ctx,
    { id, brief, entryAction, workDescription, readiness, importanceLevel, importanceRationale, plan },
  ) => {
    const normalized = ctx.db.normalizeId("dtsTodos", id);
    if (!normalized) throw new Error(`Unknown todo id: ${id}`);
    const todo = await ctx.db.get(normalized);
    if (!todo) throw new Error(`Unknown todo id: ${id}`);
    // Bounded arrays (Convex unbounded-array-field guideline): a plan never
    // exceeds MAX_PLAN_STEPS steps.
    if (plan !== undefined && plan.length > MAX_PLAN_STEPS) {
      throw new Error(
        `A plan holds at most ${MAX_PLAN_STEPS} steps — got ${plan.length}`,
      );
    }
    const now = Date.now();
    const patch: Record<string, unknown> = { updatedAt: now };
    if (todo.members !== undefined) {
      // Batch gate: the batcher (internalStoreBatches) owns batch briefs —
      // the single-todo preparer must never rewrite a grouping brief. ONLY the
      // plan field may land here (session agents update plans through this
      // pen); everything else is skipped with one named event.
      const skippedFields = [
        brief !== undefined && "brief",
        entryAction !== undefined && "entryAction",
        workDescription !== undefined && "workDescription",
        readiness !== undefined && "readiness",
        importanceLevel !== undefined && "importance",
      ].filter(Boolean);
      if (skippedFields.length > 0) {
        await logEvent(ctx, "prepare-skipped-batch", normalized, {
          fields: skippedFields,
        });
      }
    } else {
      if (brief !== undefined) patch.brief = brief;
      if (entryAction !== undefined) patch.entryAction = entryAction;
      if (workDescription !== undefined) patch.workDescription = workDescription;
      if (readiness !== undefined) patch.readiness = readiness;
      if (importanceLevel !== undefined) {
        // Agent importance never overwrites Tom's (setBy-"tom" guard).
        const importance = agentImportancePatch(
          todo.importance,
          importanceLevel,
          importanceRationale,
          now,
        );
        if (importance === undefined) {
          await logEvent(ctx, "importance-skipped", normalized, {
            level: importanceLevel,
          });
        } else {
          patch.importance = importance;
        }
      }
    }
    let planSkipReason: string | undefined;
    if (plan !== undefined) {
      // Tom's asks may never vanish from a plan by agent hand — but only
      // once he HAS a hand in the row: on a Tom-touched row the incoming
      // plan is accepted iff every existing actor-"tom" step's text appears
      // verbatim among the incoming steps (agents may check off, reorder,
      // and add freely). An untouched row's plan is wholly agent-authored
      // (the batcher wrote it), so agents rewrite it freely — the first
      // supervised fleet run showed the unconditional check refusing
      // legitimate refinements of agent-authored tom-steps.
      const incomingTexts = new Set(plan.map((s) => s.text));
      const droppedTomStep =
        todo.tomTouchedAt === undefined
          ? undefined
          : (todo.plan ?? []).find(
              (s) => s.actor === "tom" && !incomingTexts.has(s.text),
            );
      if (droppedTomStep !== undefined) {
        planSkipReason = `tom-step dropped: "${droppedTomStep.text}"`;
        await logEvent(ctx, "plan-skipped", normalized, {
          reason: "tom-step dropped",
          step: droppedTomStep.text,
        });
      } else {
        patch.plan = plan;
      }
    }
    await ctx.db.patch(normalized, patch);
    await logEvent(ctx, "prepared", normalized, {
      readiness: patch.readiness,
      fields: [
        patch.brief !== undefined && "brief",
        patch.entryAction !== undefined && "entryAction",
        patch.workDescription !== undefined && "workDescription",
        patch.importance !== undefined && "importance",
        patch.plan !== undefined && "plan",
      ].filter(Boolean),
    });
    // The pen's answer: a skipped plan must be VISIBLE to the writing agent
    // (the first fleet run had agents report refinements that were silently
    // refused) — the /tts/prepare-todo route returns this verbatim.
    return {
      planApplied: plan !== undefined ? patch.plan !== undefined : undefined,
      ...(planSkipReason !== undefined ? { planSkipReason } : {}),
    };
  },
});

// The batcher's write path (key-authed POST /tts/batches). Drop-don't-reject
// (the internalStoreWorkerPrep pattern): one bad grouping must not fail the
// batch run, so a batch that fails member validation, collides on an occupied
// member, or targets a row the batcher may not touch is SKIPPED with a named
// reason. A row is batcher-writable only while source "batcher", status
// "active", and never Tom-touched (tomTouchedAt set = FROZEN).
export const internalStoreBatches = internalMutation({
  args: {
    batches: v.array(
      v.object({
        id: v.optional(v.string()),
        statement: v.string(),
        brief: v.string(),
        members: v.array(MEMBER),
        plan: v.optional(v.array(PLAN_STEP)),
        importanceLevel: v.optional(IMPORTANCE_LEVEL),
        importanceRationale: v.optional(v.string()),
      }),
    ),
    archiveIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { batches, archiveIds }) => {
    const skipped: { ref: string; why: string }[] = [];
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let archived = 0;

    // null = writable; otherwise the plain-language reason it is not.
    const notWritable = (todo: Doc<"dtsTodos">): string | null => {
      if (todo.source !== "batcher") return `source ${todo.source} is not batcher`;
      if (todo.tomTouchedAt !== undefined) return "Tom-touched (frozen)";
      if (todo.status !== "active") return `status ${todo.status}`;
      return null;
    };

    // Archives first: a regroup is archive-old + create-new in one call, so
    // retired batches must free their members before the occupied map is
    // built. Goes through applyStatusChange (which does NOT stamp
    // tomTouchedAt — this is an agent action, not a Tom touch).
    for (const raw of archiveIds ?? []) {
      const normalized = ctx.db.normalizeId("dtsTodos", raw);
      const todo = normalized && (await ctx.db.get(normalized));
      if (!todo) {
        skipped.push({ ref: raw, why: "unknown todo id" });
        continue;
      }
      const frozen = notWritable(todo);
      if (frozen) {
        skipped.push({ ref: raw, why: frozen });
        continue;
      }
      await applyStatusChange(ctx, todo, {
        status: "archived",
        note: "batcher: regrouped or members terminal",
      });
      archived++;
    }

    // Occupied-member map from ALL non-terminal members-bearing rows, each
    // entry tagged with its owner batch id: a desired batch's member conflicts
    // UNLESS the occupying owner is that batch itself (a rewrite may keep its
    // own members). Consequence, on purpose: moving a member from existing
    // batch X to a new batch takes two runs (run 1: X's rewrite drops it;
    // run 2: the new batch claims it) — conservative, so a skipped rewrite can
    // never leave a subject claimable twice. Each landed batch extends the map
    // so in-call batches conflict pairwise. One collect feeds this map, the
    // rewrite lookups, and validateBatchMembers (opts.todoById).
    const all = await ctx.db.query("dtsTodos").collect();
    const todoById = new Map<Id<"dtsTodos">, Doc<"dtsTodos">>(
      all.map((t) => [t._id, t]),
    );
    const occupied = new Map<
      string,
      { id: Id<"dtsTodos">; statement: string }
    >();
    for (const todo of all) {
      if (todo.members === undefined) continue;
      if (todo.status !== "active" && todo.status !== "waiting") continue;
      for (const m of todo.members) {
        occupied.set(memberKey(m), { id: todo._id, statement: todo.statement });
      }
    }

    const now = Date.now();
    for (const b of batches) {
      const normalized =
        b.id === undefined ? null : ctx.db.normalizeId("dtsTodos", b.id);
      if (b.id !== undefined && !normalized) {
        skipped.push({ ref: b.statement, why: `unknown todo id: ${b.id}` });
        continue;
      }
      // Bounded arrays (Convex unbounded-array-field guideline) — a per-batch
      // skip like the other validation failures.
      if (b.plan !== undefined && b.plan.length > MAX_PLAN_STEPS) {
        skipped.push({
          ref: b.statement,
          why: `a plan holds at most ${MAX_PLAN_STEPS} steps — got ${b.plan.length}`,
        });
        continue;
      }
      try {
        await validateBatchMembers(ctx, b.members, {
          selfId: normalized ?? undefined,
          todoById,
        });
      } catch (e) {
        skipped.push({
          ref: b.statement,
          why: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      const conflict = b.members.find((m) => {
        const owner = occupied.get(memberKey(m));
        return owner !== undefined && owner.id !== normalized;
      });
      if (conflict) {
        skipped.push({
          ref: b.statement,
          why: `${memberKey(conflict)} is already in batch "${occupied.get(memberKey(conflict))!.statement}"`,
        });
        continue;
      }
      if (normalized) {
        const todo = todoById.get(normalized);
        if (!todo) {
          skipped.push({ ref: b.statement, why: `unknown todo id: ${b.id}` });
          continue;
        }
        const frozen = notWritable(todo);
        if (frozen) {
          skipped.push({ ref: b.statement, why: frozen });
          continue;
        }
        // Rewrite of what the batcher owns — but an ABSENT plan or importance
        // PRESERVES the stored value (internalStoreBriefs semantics: an LLM
        // omission must not delete state); only explicit values overwrite,
        // and Tom's importance is never overwritten (agentImportancePatch).
        let importance = todo.importance;
        if (b.importanceLevel !== undefined) {
          const next = agentImportancePatch(
            todo.importance,
            b.importanceLevel,
            b.importanceRationale,
            now,
          );
          if (next === undefined) {
            await logEvent(ctx, "importance-skipped", normalized, {
              level: b.importanceLevel,
            });
          } else if (
            todo.importance?.setBy === "agent" &&
            todo.importance.level === next.level &&
            todo.importance.rationale === next.rationale
          ) {
            // Same agent value re-posted: keep the stored object (its setAt)
            // so the unchanged check below can recognize a no-op run.
          } else {
            importance = next;
          }
        }
        const projected = {
          statement: b.statement.trim(),
          brief: b.brief,
          members: b.members,
          plan: b.plan ?? todo.plan,
          importance,
        };
        const stored = {
          statement: todo.statement,
          brief: todo.brief,
          members: todo.members,
          plan: todo.plan,
          importance: todo.importance,
        };
        // No-op rewrite: nothing changed, so skip the patch entirely — a
        // 6-hourly re-post must not bump updatedAt and re-push every open
        // client. Counted as "unchanged", neither updated nor skipped.
        if (JSON.stringify(projected) === JSON.stringify(stored)) {
          unchanged++;
        } else {
          await ctx.db.patch(normalized, { ...projected, updatedAt: now });
          updated++;
        }
        for (const m of b.members) {
          occupied.set(memberKey(m), {
            id: normalized,
            statement: projected.statement,
          });
        }
      } else {
        const id = await ctx.db.insert("dtsTodos", {
          statement: b.statement.trim(),
          brief: b.brief,
          members: b.members,
          plan: b.plan,
          importance:
            b.importanceLevel !== undefined
              ? agentImportancePatch(
                  undefined,
                  b.importanceLevel,
                  b.importanceRationale,
                  now,
                )
              : undefined,
          readiness: "ready-for-tom",
          status: "active",
          timingClass: "whenever",
          source: "batcher",
          createdAt: now,
          updatedAt: now,
        });
        await logEvent(ctx, "batch-formed", id, { members: b.members.length });
        created++;
        for (const m of b.members) {
          occupied.set(memberKey(m), { id, statement: b.statement.trim() });
        }
      }
    }

    await logEvent(ctx, "batches-stored", undefined, {
      created,
      updated,
      unchanged,
      archived,
      skipped: skipped.length > 0 ? skipped : undefined,
    });
    return { created, updated, unchanged, archived, skipped };
  },
});

export const internalListTodos = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("dtsTodos").collect();
  },
});

export const internalListMirror = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("dtsCodeTodoMirror").collect();
  },
});

export const internalGetDay = internalQuery({
  args: { day: v.string() },
  handler: async (ctx, { day }) => {
    return await ctx.db
      .query("dtsDailyQueues")
      .withIndex("by_day", (q) => q.eq("day", day))
      .first();
  },
});

export const internalMarkDigestSent = internalMutation({
  args: { day: v.string(), surfacedTodoIds: v.array(v.id("dtsTodos")) },
  handler: async (ctx, { day, surfacedTodoIds }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("dtsDailyQueues")
      .withIndex("by_day", (q) => q.eq("day", day))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { digestSentAt: now });
    } else {
      await ctx.db.insert("dtsDailyQueues", {
        day,
        entries: [],
        preparedAt: now,
        preparedBy: "fallback",
        digestSentAt: now,
      });
    }
    for (const todoId of surfacedTodoIds) {
      await logEvent(ctx, "surfaced", todoId, { via: "digest", day });
    }
    await logEvent(ctx, "digest-sent", undefined, { day });
  },
});

// ── Internal: fallback queue prep (cron; spec §7 reliability split) ──────────
// Runs shortly before 5 a.m. local (two UTC crons + local-hour guard so DST
// needs no cron edits). Wakes due `waiting` items, then builds a simple-rules
// queue if the worker hasn't posted one. The worker's Claude-written prep, when
// it lands, overwrites this via internalStoreWorkerPrep.
export const internalPrepareFallbackQueue = internalMutation({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    const now = Date.now();
    if (!force && nyLocalHour(now) !== TTS_PREP_NY_HOUR) return; // 4 a.m. hour, before the 5 a.m. send
    // CRITICAL: prep runs BEFORE the 5 a.m. boundary, so ttsDayKey(now) would
    // name YESTERDAY. ttsPrepDay names the day the coming digest belongs to —
    // the digest and getToday then find this row. (Review-caught bug.)
    const day = ttsPrepDay(now);
    const bounds = ttsDayBoundsUtc(day);

    // Wake waiting items whose wake time falls inside the day being prepared —
    // not `wakeAt <= now`: wake times are stored as noon local, and a 4 a.m.
    // check against `now` would wake everything one day late (review-caught).
    const waiting = await ctx.db
      .query("dtsTodos")
      .withIndex("by_status", (q) => q.eq("status", "waiting"))
      .collect();
    for (const todo of waiting) {
      if (todo.wakeAt !== undefined && todo.wakeAt < bounds.end) {
        await ctx.db.patch(todo._id, {
          status: "active",
          updatedAt: now,
          wakeAt: undefined,
          wakeCondition: undefined,
        });
        await logEvent(ctx, "woke", todo._id, { wakeCondition: todo.wakeCondition });
      }
    }

    const existing = await ctx.db
      .query("dtsDailyQueues")
      .withIndex("by_day", (q) => q.eq("day", day))
      .first();
    if (existing && !force) return; // worker already prepared today

    const active = (
      await ctx.db
        .query("dtsTodos")
        .withIndex("by_status", (q) => q.eq("status", "active"))
        .collect()
    ) // The dumb fallback cannot reason about batch/member overlap, so it
      // skips batches; the worker's Claude prep may queue them.
      .filter((t) => t.members === undefined);
    const endOfToday = bounds.end; // 5 a.m. NY tomorrow, DST-correct
    const entries: { todoId: Id<"dtsTodos">; reason?: string }[] = [];
    const used = new Set<string>();
    const add = (todo: Doc<"dtsTodos">, reason: string) => {
      if (used.has(todo._id) || entries.length >= QUEUE_MAX) return;
      used.add(todo._id);
      entries.push({ todoId: todo._id, reason });
    };

    const dated = active
      .filter((t) => t.dueAt !== undefined)
      .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
    for (const t of dated) {
      if ((t.dueAt ?? 0) < now) add(t, "overdue");
      else if ((t.dueAt ?? 0) <= endOfToday) add(t, "due");
    }
    const conditionBound = active
      .filter(
        (t) =>
          t.timingClass === "condition-bound" &&
          t.latestSafeAt !== undefined &&
          t.latestSafeAt <= now + 14 * 86_400_000,
      )
      .sort((a, b) => (a.latestSafeAt ?? 0) - (b.latestSafeAt ?? 0));
    for (const t of conditionBound.slice(0, 2)) add(t, "condition");
    // Reserve the invitation slot (spec §7) before stale-fill, or every
    // `whenever` item gets consumed as filler and no invitation survives.
    const stale = [...active].sort((a, b) => a.updatedAt - b.updatedAt);
    const invitation = stale.find(
      (t) => t.timingClass === "whenever" && !used.has(t._id),
    );
    if (invitation) add(invitation, "invitation");
    for (const t of stale) {
      if (entries.length >= QUEUE_MAX) break;
      add(t, "stale");
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        entries,
        preparedAt: now,
        preparedBy: "fallback",
        digestText: undefined,
      });
    } else {
      await ctx.db.insert("dtsDailyQueues", {
        day,
        entries,
        preparedAt: now,
        preparedBy: "fallback",
      });
    }
    await logEvent(ctx, "queue-prepared", undefined, {
      day,
      by: "fallback",
      count: entries.length,
    });
  },
});

// ── Internal: code-todo mirror upserts (from ttsSync.refreshMirror) ──────────
export const internalReplaceMirror = internalMutation({
  args: {
    repo: v.string(),
    rows: v.array(
      v.object({
        externalId: v.string(),
        tier: v.string(),
        status: v.string(),
        statement: v.string(),
        url: v.string(),
      }),
    ),
  },
  handler: async (ctx, { repo, rows }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("dtsCodeTodoMirror")
      .withIndex("by_repo_external", (q) => q.eq("repo", repo))
      .collect();
    const byId = new Map(existing.map((r) => [r.externalId, r]));
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.externalId);
      const prior = byId.get(row.externalId);
      if (prior) {
        await ctx.db.patch(prior._id, { ...row, syncedAt: now });
      } else {
        await ctx.db.insert("dtsCodeTodoMirror", { repo, ...row, syncedAt: now });
      }
    }
    // A row missing from the file was closed-and-rewritten or renamed upstream;
    // the mirror only reflects, so drop it (the repo is the system of record —
    // nothing-is-lost applies to LIFE todos, not to this display cache).
    for (const prior of existing) {
      if (!seen.has(prior.externalId)) await ctx.db.delete(prior._id);
    }
  },
});
