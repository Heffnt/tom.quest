import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireTom } from "./authRoles";
import {
  DAY_LOG_ACTIVITIES,
  DAY_LOG_BODY_PARTS,
  DAY_LOG_BOUNDS,
  DAY_LOG_KINDS,
  DAY_LOG_METRICS,
  DAY_LOG_PARTS_OF_DAY,
  DAY_LOG_VOCABULARY,
} from "./dayLogVocabulary";
import { nyCalendarDayKey, nyOffsetHours } from "./ttsShared";

const SURFACE = "Log";
const ENTRY_MAX = 4_000;
const PAGE_DAYS = 60;
const SERIES_DAYS = 366;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

type WireItem = Record<string, unknown>;

function isDay(value: unknown): value is string {
  return typeof value === "string" && DAY_KEY.test(value) && new Date(Date.parse(value)).toISOString().slice(0, 10) === value;
}

function itemError(message: string): never {
  throw new Error(message);
}

function number(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) itemError(`${name} must be a finite number`);
  return value;
}

function string(value: unknown, name: string, max?: number): string {
  if (typeof value !== "string" || value === "") itemError(`${name} is required`);
  if (max !== undefined && value.length > max) itemError(`${name} is at most ${max} characters`);
  return value;
}

function dayIsInEntryWindow(day: string, entryDay: string): boolean {
  const earliest = new Date(Date.parse(entryDay) - DAY_LOG_BOUNDS.maxDaysBack * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return day >= earliest && day <= entryDay;
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function validateItem(raw: unknown, entry: Doc<"dayLogEntries">): {
  kind: (typeof DAY_LOG_KINDS)[number];
  day: string;
  quote: string;
  summary: string;
  metric?: string;
  value?: number;
  unit?: string;
  partOfDay?: (typeof DAY_LOG_PARTS_OF_DAY)[number];
  activity?: (typeof DAY_LOG_ACTIVITIES)[number];
  bodyParts?: string[];
  distanceMi?: number;
  durationMin?: number;
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) itemError("each item must be an object");
  const item = raw as WireItem;
  if (!isOneOf(item.kind, DAY_LOG_KINDS)) itemError("item kind is unknown");
  const day = string(item.day, "item day");
  if (!isDay(day) || !dayIsInEntryWindow(day, entry.day)) itemError("item day is outside the entry window");
  const quote = string(item.quote, "item quote", DAY_LOG_BOUNDS.quoteMax);
  if (!entry.text.includes(quote)) itemError("item quote must be a verbatim substring of the entry");
  const summary = string(item.summary, "item summary", DAY_LOG_BOUNDS.summaryMax);

  if (item.kind === "measurement") {
    const metric = string(item.metric, "measurement metric");
    const definition = DAY_LOG_METRICS[metric as keyof typeof DAY_LOG_METRICS];
    if (!definition) itemError("measurement metric is unknown");
    const value = number(item.value, "measurement value");
    if (value < definition.min || value > definition.max) itemError("measurement value is outside the metric range");
    const unit = string(item.unit, "measurement unit");
    if (unit !== definition.unit) itemError("measurement unit does not match the metric");
    if (!isOneOf(item.partOfDay, DAY_LOG_PARTS_OF_DAY)) itemError("measurement partOfDay is unknown");
    return { kind: item.kind, day, quote, summary, metric, value, unit, partOfDay: item.partOfDay };
  }

  if (item.kind === "workout") {
    if (!isOneOf(item.activity, DAY_LOG_ACTIVITIES)) itemError("workout activity is unknown");
    let bodyParts: string[] | undefined;
    if (item.bodyParts !== undefined) {
      if (!Array.isArray(item.bodyParts) || item.bodyParts.length > DAY_LOG_BOUNDS.bodyPartsMax || !item.bodyParts.every((part) => isOneOf(part, DAY_LOG_BODY_PARTS))) {
        itemError("workout bodyParts are invalid");
      }
      if (new Set(item.bodyParts).size !== item.bodyParts.length) itemError("workout bodyParts must not repeat");
      bodyParts = item.bodyParts;
    }
    const optionalNonnegative = (value: unknown, name: string): number | undefined => {
      if (value === undefined) return undefined;
      const parsed = number(value, name);
      if (parsed < 0) itemError(`${name} must not be negative`);
      return parsed;
    };
    const distanceMi = optionalNonnegative(item.distanceMi, "workout distanceMi");
    const durationMin = optionalNonnegative(item.durationMin, "workout durationMin");
    return {
      kind: item.kind,
      day,
      quote,
      summary,
      activity: item.activity,
      ...(bodyParts === undefined ? {} : { bodyParts }),
      ...(distanceMi === undefined ? {} : { distanceMi }),
      ...(durationMin === undefined ? {} : { durationMin }),
    };
  }

  return { kind: item.kind, day, quote, summary };
}

function itemKindWord(item: { kind: string; activity?: string }): string {
  if (item.kind === "workout" && item.activity === "run") return "run";
  if (item.kind === "food") return "meal";
  if (item.kind === "work") return "work item";
  return item.kind;
}

function countWord(count: number, word: string): string {
  const quantity = count === 1 ? "a" : new Intl.NumberFormat("en-US", { style: "decimal" }).format(count);
  return `${quantity} ${count === 1 ? word : `${word}s`}`;
}

function joinClauses(clauses: string[]): string {
  if (clauses.length === 1) return clauses[0];
  if (clauses.length === 2) return `${clauses[0]}, and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses.at(-1)}`;
}

/** The sole source of page wording for a worker verdict. */
export function dayLogResultLine(
  status: "pending" | "applied" | "needs-session",
  items: Array<{ kind: string; metric?: string; value?: number; unit?: string; activity?: string }>,
): string {
  if (status === "pending") return "Jarvis has not read this yet.";
  if (status === "needs-session") return "Jarvis could not read this entry; it stays here and still goes to nightly learning.";
  const measurements = items
    .filter((item) => item.kind === "measurement" && item.metric !== undefined && item.value !== undefined && item.unit !== undefined)
    .map((item) => `your ${item.metric!.replaceAll("_", " ")}, ${item.value!.toFixed(1)} ${item.unit}`);
  const grouped = new Map<string, number>();
  for (const item of items.filter((item) => item.kind !== "measurement")) {
    const word = itemKindWord(item);
    grouped.set(word, (grouped.get(word) ?? 0) + 1);
  }
  const clauses = [...measurements, ...[...grouped.entries()].map(([word, count]) => countWord(count, word))];
  return clauses.length === 0 ? "Jarvis found nothing to record." : `Jarvis recorded ${joinClauses(clauses)}.`;
}

function timeLabel(at: number): string {
  const date = new Date(at + nyOffsetHours(at) * 3_600_000);
  const hour = date.getUTCHours();
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hour % 12 || 12}:${minute} ${hour < 12 ? "a.m." : "p.m."}`;
}

export const submit = mutation({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    await requireTom(ctx, SURFACE);
    if (text.trim() === "") throw new Error("Log entries cannot be empty");
    if (text.length > ENTRY_MAX) throw new Error(`Log entries are at most ${ENTRY_MAX} characters`);
    const createdAt = Date.now();
    const id = await ctx.db.insert("dayLogEntries", { text, createdAt, day: nyCalendarDayKey(createdAt), status: "pending" });
    await ctx.db.insert("dtsEvents", { at: createdAt, kind: "day-log", data: { entryId: id } });
    return { id };
  },
});

export const page = query({
  args: {},
  handler: async (ctx) => {
    await requireTom(ctx, SURFACE);
    const since = new Date(Date.now() - PAGE_DAYS * 86_400_000).toISOString().slice(0, 10);
    const entries = await ctx.db.query("dayLogEntries").withIndex("by_day", (q) => q.gte("day", since)).order("desc").take(500);
    return await Promise.all(entries.map(async (entry) => ({
      ...entry,
      result: entry.result ?? dayLogResultLine(entry.status, []),
      items: (await ctx.db.query("dayLogItems").withIndex("by_entry", (q) => q.eq("entryId", entry._id)).collect()).filter((item) => item.revertedAt === undefined),
    })));
  },
});

export const series = query({
  args: {},
  handler: async (ctx) => {
    await requireTom(ctx, SURFACE);
    const since = new Date(Date.now() - SERIES_DAYS * 86_400_000).toISOString().slice(0, 10);
    const values = (await Promise.all(Object.keys(DAY_LOG_METRICS).map(async (metric) =>
      await ctx.db.query("dayLogItems").withIndex("by_metric_day", (q) => q.eq("metric", metric).gte("day", since)).collect(),
    ))).flat().filter((item) => item.revertedAt === undefined && item.value !== undefined && item.partOfDay !== undefined);
    return await Promise.all(values.map(async (item) => {
      const entry = await ctx.db.get(item.entryId);
      return { ...item, entryCreatedAt: entry?.createdAt ?? item.createdAt };
    }));
  },
});

export const internalPending = internalQuery({
  args: {},
  handler: async (ctx) => {
    const entries = await ctx.db.query("dayLogEntries").withIndex("by_status", (q) => q.eq("status", "pending")).take(10);
    const todoLists = await Promise.all(["active", "waiting"].map((status) =>
      ctx.db.query("todos").withIndex("by_status", (q) => q.eq("status", status as "active" | "waiting")).order("desc").take(150),
    ));
    const openTodos = todoLists.flat().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 150).map((todo) => ({
      id: todo._id,
      statement: todo.statement,
      due: todo.dueAt === undefined ? null : nyCalendarDayKey(todo.dueAt),
      dateKind: todo.dateKind ?? null,
      status: todo.status as "active" | "waiting",
    }));
    const now = Date.now();
    return {
      today: nyCalendarDayKey(now),
      now,
      entries: entries.map((entry) => ({ id: entry._id, text: entry.text, createdAt: entry.createdAt, day: entry.day, time: timeLabel(entry.createdAt) })),
      vocabulary: DAY_LOG_VOCABULARY,
      openTodos,
    };
  },
});

export const internalApplyDayLog = internalMutation({
  args: {
    id: v.string(),
    status: v.union(v.literal("applied"), v.literal("needs-session")),
    items: v.array(v.any()),
    actions: v.array(v.any()),
    warning: v.optional(v.any()),
    failure: v.optional(v.union(v.literal("model"), v.literal("parse"), v.literal("refused"))),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, { id, status, items, actions, warning, failure, detail }) => {
    const entryId = ctx.db.normalizeId("dayLogEntries", id);
    const entry = entryId === null ? null : await ctx.db.get(entryId);
    if (entryId === null || entry === null) throw new Error("no such entry");
    if (entry.status !== "pending") return { ok: true, already: true };
    if (items.length > DAY_LOG_BOUNDS.maxItems) throw new Error(`at most ${DAY_LOG_BOUNDS.maxItems} items per entry`);
    if (actions.length > DAY_LOG_BOUNDS.maxActions) throw new Error(`at most ${DAY_LOG_BOUNDS.maxActions} actions per entry`);
    if (actions.length > 0) throw new Error("actions not yet supported");
    if (warning !== undefined) throw new Error("warnings not yet supported");
    if (status === "needs-session" && items.length > 0) throw new Error("a needs-session entry carries no items");
    if (status === "needs-session" && failure === undefined) throw new Error("failure is required when status is needs-session");
    if (detail !== undefined && detail.length > 500) throw new Error("detail is at most 500 characters");
    const validItems = items.map((item) => validateItem(item, entry));
    const now = Date.now();
    if (status === "applied") {
      for (const item of validItems) await ctx.db.insert("dayLogItems", { entryId, ...item, createdAt: now });
    }
    const result = dayLogResultLine(status, validItems);
    await ctx.db.patch(entryId, { status, result, resolvedAt: now });
    await ctx.db.insert("dtsEvents", {
      at: now,
      kind: "day-log-resolved",
      data: { status, itemKinds: validItems.map((item) => item.kind), ...(failure === undefined ? {} : { failure }), ...(detail === undefined ? {} : { detail }) },
    });
    return { ok: true, applied: validItems.length, result };
  },
});
