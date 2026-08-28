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
  DTS_PREP_NY_HOUR,
  dtsDayBoundsUtc,
  dtsDayKey,
  dtsPrepDay,
  nyLocalHour,
} from "./dtsShared";

// DTS (Delegated Todo System) — life-todo store, instrumentation, daily queue,
// and the code-todo mirror. Spec: WikiTom dts/spec.md. Everything Tom-facing is
// Tom-gated (forge.ts pattern); everything the worker box or crons touch goes
// through internal functions (http.ts routes are key-authed with DTS_WORKER_KEY).

async function requireTomId(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  return await requireTom(ctx, "DTS");
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
    const day = dtsDayKey(Date.now());
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
  },
  handler: async (ctx, { id, ...fields }) => {
    await requireTomId(ctx);
    const todo = await ctx.db.get(id);
    if (!todo) throw new Error("DTS todo not found");
    // Kept-dates rule (spec §8): a date never just disappears — the silent
    // slide is the one forbidden outcome. Clearing dueAt directly is refused;
    // dates leave via recordDateOutcome (done / renegotiated / missed).
    if (fields.dueAt === null && todo.dueAt !== undefined) {
      throw new Error(
        "A date is never cleared silently — resolve it via recordDateOutcome (renegotiated before the date, or missed)",
      );
    }
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
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

// Status transitions (spec §5.1). Nothing is ever deleted: "archived" and
// "done" are the only terminal states, both kept and visible (principle 2).
export const setStatus = mutation({
  args: {
    id: v.id("dtsTodos"),
    status: STATUS,
    wakeCondition: v.optional(v.string()),
    wakeAt: v.optional(v.number()),
    unarchiveCondition: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { id, status, wakeCondition, wakeAt, unarchiveCondition, note }) => {
    await requireTomId(ctx);
    const todo = await ctx.db.get(id);
    if (!todo) throw new Error("DTS todo not found");
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
    await ctx.db.patch(id, patch);
    await logEvent(ctx, "status-changed", id, {
      from: todo.status,
      to: status,
      note,
    });
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
    if (!todo) throw new Error("DTS todo not found");
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

// Instrumentation hook for the surfaces (spec §10): Focus/Inventory record
// engagement, queue cycling, session starts, etc. Kind is free-form by
// convention; the analysis layer is a later DTS todo.
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

export const internalListTodos = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("dtsTodos").collect();
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
    if (!force && nyLocalHour(now) !== DTS_PREP_NY_HOUR) return; // 4 a.m. hour, before the 5 a.m. send
    // CRITICAL: prep runs BEFORE the 5 a.m. boundary, so dtsDayKey(now) would
    // name YESTERDAY. dtsPrepDay names the day the coming digest belongs to —
    // the digest and getToday then find this row. (Review-caught bug.)
    const day = dtsPrepDay(now);
    const bounds = dtsDayBoundsUtc(day);

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

    const active = await ctx.db
      .query("dtsTodos")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();
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

// ── Internal: code-todo mirror upserts (from dtsSync.refreshMirror) ──────────
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
