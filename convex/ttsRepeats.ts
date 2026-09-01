// Repeating todos (integrations round, 2026-08-29). A ttsRepeats row is a
// standing rule ("core + antagonist training", monday+friday, 18:00); the
// 4:30 a.m. generator mints that day's instances as REAL dtsTodos rows —
// dated, self-imposed, source "repeating" — so every instance gets the full
// kept-dates treatment: doing it records done, skipping it records a miss,
// and the weekly session reads the honest record. The rule itself is
// schedule mechanics (like dtsBlocks): editable and deletable freely, with
// every change logged to dtsEvents.
//
// The generator runs BEFORE the 4:45 queue prep (crons.ts), so the day's
// instances are already in the corpus when the queue is built and they land
// in the digest as ordinary due-today items.

import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireTom, requireTomOrAgent } from "./authRoles";
import { logEvent } from "./tts";
import {
  TTS_PREP_NY_HOUR,
  nyCalendarDayBoundsUtc,
  nyLocalHour,
  nyTimeUtcMs,
  ttsPrepDay,
  weekdayWordOf,
} from "./ttsShared";

export const WEEKDAY = v.union(
  v.literal("monday"),
  v.literal("tuesday"),
  v.literal("wednesday"),
  v.literal("thursday"),
  v.literal("friday"),
  v.literal("saturday"),
  v.literal("sunday"),
);

const TIME_OF_DAY = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** The instance provenance string — the generator's idempotence key. */
export function repeatProvenance(repeatId: string, day: string): string {
  return `repeat:${repeatId}:${day}`;
}

const RULE_FIELDS = {
  statement: v.string(),
  daysOfWeek: v.array(WEEKDAY),
  timeOfDay: v.optional(v.string()),
  skipWhenCalendarHas: v.optional(v.string()),
  category: v.optional(v.string()),
  entryAction: v.optional(v.string()),
  workDescription: v.optional(v.string()),
  groundUpExplanation: v.optional(v.string()),
  body: v.optional(v.string()),
};

/**
 * Is the incoming value the same fact as the stored one? Every rule field is a
 * string, an optional string, or the weekday array — and the weekday array is
 * compared as a SET, because the day picker emits days in tap order while the
 * row was stored in whatever order an earlier tap produced, and "monday,friday"
 * versus "friday,monday" is not an edit.
 */
function sameValue(stored: unknown, next: unknown): boolean {
  if (Array.isArray(stored) && Array.isArray(next)) {
    // Sorted-join, not set-membership: membership plus equal length would call
    // ["monday","friday"] and ["monday","monday"] the same, and drop that edit
    // silently. The day picker cannot produce a duplicate, but `npx convex run
    // ttsRepeats:updateRepeat` — a documented pen for this table — can.
    return (
      [...stored].sort().join("\u0000") === [...next].sort().join("\u0000")
    );
  }
  return stored === next;
}

function validateRule(args: { daysOfWeek: string[]; timeOfDay?: string; statement: string }) {
  if (args.statement.trim() === "") throw new Error("Statement is required");
  if (args.daysOfWeek.length === 0) {
    throw new Error("A repeat needs at least one weekday");
  }
  if (args.timeOfDay !== undefined && !TIME_OF_DAY.test(args.timeOfDay)) {
    throw new Error('timeOfDay must be 24h "HH:MM"');
  }
}

// ── Tom-facing CRUD ─────────────────────────────────────────────────────────

export const listRepeats = query({
  args: {},
  handler: async (ctx) => {
    await requireTomOrAgent(ctx, "TTS");
    return await ctx.db.query("ttsRepeats").collect();
  },
});

export const createRepeat = mutation({
  args: RULE_FIELDS,
  handler: async (ctx, args) => {
    await requireTom(ctx, "TTS");
    validateRule(args);
    const now = Date.now();
    const id = await ctx.db.insert("ttsRepeats", {
      ...args,
      statement: args.statement.trim(),
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await logEvent(ctx, "repeat-created", undefined, {
      repeatId: id,
      statement: args.statement.trim(),
      daysOfWeek: args.daysOfWeek,
    });
    return id;
  },
});

export const updateRepeat = mutation({
  args: {
    id: v.id("ttsRepeats"),
    statement: v.optional(v.string()),
    daysOfWeek: v.optional(v.array(WEEKDAY)),
    timeOfDay: v.optional(v.union(v.string(), v.null())),
    skipWhenCalendarHas: v.optional(v.union(v.string(), v.null())),
    category: v.optional(v.union(v.string(), v.null())),
    entryAction: v.optional(v.union(v.string(), v.null())),
    workDescription: v.optional(v.union(v.string(), v.null())),
    groundUpExplanation: v.optional(v.union(v.string(), v.null())),
    body: v.optional(v.union(v.string(), v.null())),
    active: v.optional(v.boolean()),
  },
  handler: async (ctx, { id, ...updates }) => {
    await requireTom(ctx, "TTS");
    const rule = await ctx.db.get(id);
    if (!rule) throw new Error("Repeat not found");
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    const fields: string[] = [];
    for (const [key, value] of Object.entries(updates)) {
      // Three cases, and the middle one is why the arg types are
      // `optional(union(T, null))`: ABSENT means "leave it alone", null means
      // "clear it" (stored as undefined — Convex's absent-field spelling), and
      // any other value means "set it to this".
      if (value === undefined) continue;
      const next =
        value === null
          ? undefined
          : key === "statement"
            ? (value as string).trim()
            : value;
      // The edit dialog sends every field it holds on every save, so most of
      // them arrive equal to what is already stored. Only the ones that
      // actually move are patched and named in the event — otherwise a save
      // with one weekday changed would record all nine as changed, and the
      // event log would stop being evidence of anything.
      if (sameValue(rule[key as keyof typeof rule], next)) continue;
      patch[key] = next;
      fields.push(key);
    }
    // Nothing moved: no write and no event. A no-op save leaves no trace
    // rather than a repeat-updated with an empty field list.
    if (fields.length === 0) return { changed: [] };
    // Sorted, because the unsorted order is whatever order the arguments
    // arrived in — a property of the caller, not a fact about the rule, and
    // two identical edits would log two different-looking events.
    fields.sort();
    validateRule({
      statement: (patch.statement as string) ?? rule.statement,
      daysOfWeek: (patch.daysOfWeek as string[]) ?? rule.daysOfWeek,
      timeOfDay:
        "timeOfDay" in patch ? (patch.timeOfDay as string | undefined) : rule.timeOfDay,
    });
    await ctx.db.patch(id, patch);
    await logEvent(ctx, "repeat-updated", undefined, { repeatId: id, fields });
    return { changed: fields };
  },
});

// A rule is schedule mechanics, so hard delete is legal (the dtsBlocks
// precedent) — but the full rule goes into the event record first, so the
// deletion leaves a readable fact, and every already-minted instance is a
// real todo that keeps living under nothing-ever-lost.
export const deleteRepeat = mutation({
  args: { id: v.id("ttsRepeats") },
  handler: async (ctx, { id }) => {
    await requireTom(ctx, "TTS");
    const rule = await ctx.db.get(id);
    if (!rule) throw new Error("Repeat not found");
    await ctx.db.delete(id);
    await logEvent(ctx, "repeat-deleted", undefined, { rule });
  },
});

// Tom's pen for repeats (the internalTriage pattern): an internal mutation so
// a session agent can record his SPOKEN repeat rulings via `npx convex run
// ttsRepeats:internalCreateRepeat` with the deploy credentials Tom's machine
// holds. Only ever run while Tom is present and ruling — it is his pen, not a
// policy actor. Same validation as createRepeat, one implementation.
export const internalCreateRepeat = internalMutation({
  args: RULE_FIELDS,
  handler: async (ctx, args) => {
    validateRule(args);
    const now = Date.now();
    const id = await ctx.db.insert("ttsRepeats", {
      ...args,
      statement: args.statement.trim(),
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await logEvent(ctx, "repeat-created", undefined, {
      repeatId: id,
      statement: args.statement.trim(),
      daysOfWeek: args.daysOfWeek,
      via: "pen",
    });
    return id;
  },
});

// ── The generator ───────────────────────────────────────────────────────────

export const internalGenerateRepeats = internalMutation({
  args: {
    force: v.optional(v.boolean()),
    // Test/backfill door: generate for a specific day instead of ttsPrepDay.
    day: v.optional(v.string()),
  },
  handler: async (ctx, { force, day: dayOverride }) => {
    const now = Date.now();
    if (!force && nyLocalHour(now) !== TTS_PREP_NY_HOUR) return; // DST guard
    const day = dayOverride ?? ttsPrepDay(now);
    const weekday = weekdayWordOf(day);
    const bounds = nyCalendarDayBoundsUtc(day);

    const rules = (await ctx.db.query("ttsRepeats").collect()).filter(
      (r) => r.active && r.daysOfWeek.includes(weekday),
    );
    if (rules.length === 0) return { day, created: 0 };

    // The day's calendar mirror rows, for skipWhenCalendarHas.
    const dayEvents = (
      await ctx.db
        .query("ttsCalendarEvents")
        .withIndex("by_start", (q) =>
          q.gte("start", bounds.start - 31 * 86_400_000).lt("start", bounds.end),
        )
        .collect()
    ).filter((e) => e.end > bounds.start);

    // Idempotence: an instance's provenance is `repeat:<ruleId>:<day>`.
    const existing = new Set(
      (
        await ctx.db
          .query("dtsTodos")
          .withIndex("by_source", (q) => q.eq("source", "repeating"))
          .collect()
      ).map((t) => t.provenance),
    );

    let created = 0;
    for (const rule of rules) {
      const provenance = repeatProvenance(rule._id, day);
      if (existing.has(provenance)) continue;

      if (rule.skipWhenCalendarHas !== undefined) {
        const needle = rule.skipWhenCalendarHas.toLowerCase();
        const match = dayEvents.find((e) =>
          e.title.toLowerCase().includes(needle),
        );
        if (match) {
          // A recorded fact, not a todo: the calendar already claims this day.
          await logEvent(ctx, "repeat-skipped", undefined, {
            repeatId: rule._id,
            day,
            calendarEvent: match.title,
          });
          continue;
        }
      }

      let dueAt: number;
      if (rule.timeOfDay !== undefined) {
        const [h, m] = rule.timeOfDay.split(":").map(Number);
        dueAt = nyTimeUtcMs(day, h, m);
      } else {
        dueAt = nyTimeUtcMs(day, 12); // the noon storage convention
      }

      const id = await ctx.db.insert("dtsTodos", {
        statement: rule.statement,
        body: rule.body,
        // Ready by construction: the rule already carries everything an
        // instance needs, so the preparer never churns on these.
        readiness: "ready-for-tom",
        status: "active",
        timingClass: "dated",
        dueAt,
        dateKind: "self-imposed",
        kind: "task",
        actor: "tom",
        category: rule.category,
        entryAction: rule.entryAction,
        workDescription: rule.workDescription,
        groundUpExplanation: rule.groundUpExplanation,
        source: "repeating",
        provenance,
        createdAt: now,
        updatedAt: now,
      });
      await logEvent(ctx, "created", id, {
        source: "repeating",
        repeatId: rule._id,
        day,
      });
      created++;
    }
    return { day, created };
  },
});
