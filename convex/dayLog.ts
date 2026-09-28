import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
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
  DAY_LOG_WARNING_CLASSES,
} from "./dayLogVocabulary";
import { back } from "./jarvis/tables";
import { applyDateOutcome, applyStatusChange, captureTodo, logEvent } from "./tts";
import { applyRepeatUpdate } from "./ttsRepeats";
import { matchQuotedUnit } from "./ttsRulings";
import { openNeedsTomThread } from "./ttsSlack";
import { nyCalendarDayKey, nyOffsetHours, nyTimeUtcMs } from "./ttsShared";

const SURFACE = "Log";
const ENTRY_MAX = 4_000;
const PAGE_DAYS = 60;
const SERIES_DAYS = 366;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const ACTION_KINDS = ["todo-done", "todo-archive", "todo-move", "todo-capture", "repeat-off", "repeat-on"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

type ActionKind = (typeof ACTION_KINDS)[number];
type WireItem = Record<string, unknown>;
type WireAction = Record<string, unknown>;
type TodoSnapshot = {
  status: Doc<"todos">["status"];
  doneAt: number | null;
  dueAt: number | null;
  dateKind: Doc<"todos">["dateKind"] | null;
  timingClass: Doc<"todos">["timingClass"];
  dateOutcomes: Doc<"todos">["dateOutcomes"] | null;
  wakeAt: number | null;
  updatedAt: number;
  archivedAt: number | null;
  unarchiveCondition: string | null;
};
type RepeatSnapshot = { active: boolean; updatedAt: number };
type ValidatedWarning = {
  class: (typeof DAY_LOG_WARNING_CLASSES)[number];
  quote: string;
  source: "model" | "phrase-check";
};
type ValidatedAction =
  | { kind: "todo-done" | "todo-archive"; quote: string; todo: Doc<"todos"> }
  | { kind: "todo-move"; quote: string; todo: Doc<"todos">; due: string }
  | { kind: "todo-capture"; quote: string; statement: string }
  | { kind: "repeat-off" | "repeat-on"; quote: string; repeat: Doc<"ttsRepeats"> };
type ResultAction = { kind: ActionKind; statement: string; due?: string };

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

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) itemError(`${name} must be an object`);
  return value as Record<string, unknown>;
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
  const item = object(raw, "each item") as WireItem;
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

function actionQuote(entry: Doc<"dayLogEntries">, value: unknown): string {
  const quote = string(value, "action quote", DAY_LOG_BOUNDS.quoteMax);
  const matched = matchQuotedUnit(entry.text, quote);
  if ("refused" in matched) itemError(matched.refused.replace(/^refused: /, "action quote: "));
  return matched.source;
}

function lastMoveDay(today: string): string {
  return new Date(Date.parse(today) + 365 * 86_400_000).toISOString().slice(0, 10);
}

async function validateActions(
  ctx: MutationCtx,
  rawActions: unknown[],
  entry: Doc<"dayLogEntries">,
): Promise<ValidatedAction[]> {
  const todoIds = new Set<string>();
  const repeatIds = new Set<string>();
  const today = nyCalendarDayKey(Date.now());
  const latest = lastMoveDay(today);
  const actions: ValidatedAction[] = [];

  for (const raw of rawActions) {
    const action = object(raw, "each action") as WireAction;
    if (!isOneOf(action.kind, ACTION_KINDS)) itemError("action is unknown");
    const quote = actionQuote(entry, action.quote);
    if (action.kind === "todo-capture") {
      const statement = string(action.statement, "capture statement").trim();
      if (statement.length < DAY_LOG_BOUNDS.statementMin || statement.length > DAY_LOG_BOUNDS.statementMax) {
        itemError(`capture statement must be ${DAY_LOG_BOUNDS.statementMin} to ${DAY_LOG_BOUNDS.statementMax} characters`);
      }
      actions.push({ kind: action.kind, quote, statement });
      continue;
    }

    if (action.kind === "repeat-off" || action.kind === "repeat-on") {
      const repeatId = string(action.repeatId, "repeat id");
      const normalized = ctx.db.normalizeId("ttsRepeats", repeatId);
      const repeat = normalized === null ? null : await ctx.db.get(normalized);
      if (!repeat) itemError("repeat does not exist");
      if (repeatIds.has(repeat._id)) itemError("at most one action may name a repeat");
      repeatIds.add(repeat._id);
      if (action.kind === "repeat-off" && !repeat.active) itemError("repeat-off requires an active repeat");
      if (action.kind === "repeat-on" && repeat.active) itemError("repeat-on requires an inactive repeat");
      actions.push({ kind: action.kind, quote, repeat });
      continue;
    }

    const todoId = string(action.todoId, "todo id");
    const normalized = ctx.db.normalizeId("todos", todoId);
    const todo = normalized === null ? null : await ctx.db.get(normalized);
    if (!todo) itemError("todo does not exist");
    if (todo.status !== "active" && todo.status !== "waiting") itemError("todo must be active or waiting");
    if (todoIds.has(todo._id)) itemError("at most one action may name a todo");
    todoIds.add(todo._id);

    if (action.kind === "todo-move") {
      const due = string(action.due, "move due");
      if (!isDay(due) || due < today || due > latest) itemError("move due must be within the next 365 days");
      if (todo.dueAt === undefined) itemError("todo has no date to move");
      actions.push({ kind: action.kind, quote, todo, due });
    } else {
      actions.push({ kind: action.kind, quote, todo });
    }
  }
  return actions;
}

function validateWarning(raw: unknown, entry: Doc<"dayLogEntries">): ValidatedWarning {
  const warning = object(raw, "warning");
  if (!isOneOf(warning.class, DAY_LOG_WARNING_CLASSES)) itemError("warning class is unknown");
  const quote = string(warning.quote, "warning quote", DAY_LOG_BOUNDS.quoteMax);
  if (!entry.text.includes(quote)) itemError("warning quote must be a verbatim substring of the entry");
  if (warning.source !== "model" && warning.source !== "phrase-check") itemError("warning source is unknown");
  return { class: warning.class, quote, source: warning.source };
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

function shortStatement(statement: string): string {
  return statement.length <= 60 ? statement : `${statement.slice(0, 59)}…`;
}

function dayLabel(day: string): string {
  const date = new Date(Date.parse(day));
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function actionResultLine(action: ResultAction): string {
  const statement = shortStatement(action.statement);
  switch (action.kind) {
    case "todo-done":
      return `Jarvis marked "${statement}" done.`;
    case "todo-archive":
      return `Jarvis archived "${statement}".`;
    case "todo-move":
      return `Jarvis moved "${statement}" to ${dayLabel(action.due!)}.`;
    case "todo-capture":
      return `Jarvis added "${statement}" to your todos.`;
    case "repeat-off":
      return `Jarvis paused the repeat "${statement}".`;
    case "repeat-on":
      return `Jarvis restarted the repeat "${statement}".`;
  }
  throw new Error("unknown day-log action");
}

/** The sole source of page wording for a worker result. */
export function dayLogResultLine(
  status: "pending" | "applied" | "needs-session",
  items: Array<{ kind: string; metric?: string; value?: number; unit?: string; activity?: string }>,
  actions: ResultAction[] = [],
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
  const itemClauses = [...measurements, ...[...grouped.entries()].map(([word, count]) => countWord(count, word))];
  const lines = itemClauses.length === 0 ? [] : [`Jarvis recorded ${joinClauses(itemClauses)}.`];
  lines.push(...actions.map(actionResultLine));
  return lines.length === 0 ? "Jarvis found nothing to record." : lines.join(" ");
}

function timeLabel(at: number): string {
  const date = new Date(at + nyOffsetHours(at) * 3_600_000);
  const hour = date.getUTCHours();
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hour % 12 || 12}:${minute} ${hour < 12 ? "a.m." : "p.m."}`;
}

function entryDateTimeLabel(at: number): string {
  const date = new Date(at + nyOffsetHours(at) * 3_600_000);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${timeLabel(at)}`;
}

function snapshotTodo(todo: Doc<"todos">): TodoSnapshot {
  return {
    status: todo.status,
    doneAt: todo.doneAt ?? null,
    dueAt: todo.dueAt ?? null,
    dateKind: todo.dateKind ?? null,
    timingClass: todo.timingClass,
    dateOutcomes: todo.dateOutcomes ?? null,
    wakeAt: todo.wakeAt ?? null,
    updatedAt: todo.updatedAt,
    archivedAt: todo.archivedAt ?? null,
    unarchiveCondition: todo.unarchiveCondition ?? null,
  };
}

function snapshotRepeat(repeat: Doc<"ttsRepeats">): RepeatSnapshot {
  return { active: repeat.active, updatedAt: repeat.updatedAt };
}

function snapshotCapturedTodo(todo: Doc<"todos">): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(todo).filter(([key]) => key !== "_id" && key !== "_creationTime"),
  );
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
}

function sameState(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function todoPatch(snapshot: TodoSnapshot): Record<string, unknown> {
  return {
    status: snapshot.status,
    doneAt: snapshot.doneAt ?? undefined,
    dueAt: snapshot.dueAt ?? undefined,
    dateKind: snapshot.dateKind ?? undefined,
    timingClass: snapshot.timingClass,
    dateOutcomes: snapshot.dateOutcomes ?? undefined,
    wakeAt: snapshot.wakeAt ?? undefined,
    updatedAt: snapshot.updatedAt,
    archivedAt: snapshot.archivedAt ?? undefined,
    unarchiveCondition: snapshot.unarchiveCondition ?? undefined,
  };
}

function warningReason(warning: ValidatedWarning, entry: Doc<"dayLogEntries">): string {
  const at = entryDateTimeLabel(entry.createdAt);
  if (warning.class === "crisis-language") {
    return `Your log entry of ${at} uses words the log raises with you. Reply here if you want a session.`;
  }
  const signs: Record<Exclude<(typeof DAY_LOG_WARNING_CLASSES)[number], "crisis-language">, string> = {
    "chest-pain": "chest pain",
    fainting: "fainting",
    heartbeat: "a racing or irregular heartbeat that did not settle",
    "light-headedness": "light-headedness that lasted",
  };
  const sign = signs[warning.class];
  return `Your log entry of ${at} mentions ${sign}. That is one of the signs the log raises for a doctor's check before more hard training.`;
}

/** Applies and records one bounded consequence of a cited day-log sentence. */
export async function applyDayLogAction(
  ctx: MutationCtx,
  entryId: Doc<"dayLogEntries">["_id"],
  action: ValidatedAction,
): Promise<ResultAction> {
  const appliedAt = Date.now();
  if (action.kind === "todo-capture") {
    const todoId = await captureTodo(ctx, {
      statement: action.statement,
      source: "day-log",
      provenance: `day-log:${entryId}`,
    });
    const todo = await ctx.db.get(todoId);
    if (!todo) throw new Error("captured todo was not stored");
    await ctx.db.insert("dayLogActions", {
      entryId,
      kind: action.kind,
      todoId,
      statement: todo.statement,
      quote: action.quote,
      before: {},
      after: snapshotCapturedTodo(todo),
      appliedAt,
    });
    return { kind: action.kind, statement: todo.statement };
  }

  if (action.kind === "repeat-off" || action.kind === "repeat-on") {
    const before = snapshotRepeat(action.repeat);
    await applyRepeatUpdate(ctx, action.repeat, { active: action.kind === "repeat-on" });
    const afterRepeat = await ctx.db.get(action.repeat._id);
    if (!afterRepeat) throw new Error("repeat was not stored");
    await ctx.db.insert("dayLogActions", {
      entryId,
      kind: action.kind,
      repeatId: action.repeat._id,
      statement: action.repeat.statement,
      quote: action.quote,
      before,
      after: snapshotRepeat(afterRepeat),
      appliedAt,
    });
    return { kind: action.kind, statement: action.repeat.statement };
  }

  const before = snapshotTodo(action.todo);
  if (action.kind === "todo-done") {
    await applyStatusChange(ctx, action.todo, { status: "done" });
  } else if (action.kind === "todo-archive") {
    await applyStatusChange(ctx, action.todo, { status: "archived" });
  } else {
    const outcome = Date.now() < action.todo.dueAt! ? "renegotiated" : "missed";
    await applyDateOutcome(ctx, action.todo, { outcome, newDueAt: nyTimeUtcMs(action.due, 12) });
  }
  const afterTodo = await ctx.db.get(action.todo._id);
  if (!afterTodo) throw new Error("todo was not stored");
  await ctx.db.insert("dayLogActions", {
    entryId,
    kind: action.kind,
    todoId: action.todo._id,
    statement: action.todo.statement,
    ...(action.kind === "todo-move" ? { due: action.due } : {}),
    quote: action.quote,
    before,
    after: snapshotTodo(afterTodo),
    appliedAt,
  });
  return {
    kind: action.kind,
    statement: action.todo.statement,
    ...(action.kind === "todo-move" ? { due: action.due } : {}),
  };
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
    return await Promise.all(entries.map(async (entry) => {
      const actions = await ctx.db
        .query("dayLogActions")
        .withIndex("by_entry", (q) => q.eq("entryId", entry._id))
        .take(DAY_LOG_BOUNDS.maxActions);
      return {
        ...entry,
        result: entry.result ?? dayLogResultLine(entry.status, []),
        items: await ctx.db.query("dayLogItems").withIndex("by_entry", (q) => q.eq("entryId", entry._id)).take(DAY_LOG_BOUNDS.maxItems),
        actions: actions.map((action) => ({
          ...action,
          result: dayLogResultLine("applied", [], [{
            kind: action.kind,
            statement: action.statement ?? "",
            ...(action.due === undefined ? {} : { due: action.due }),
          }]),
        })),
      };
    }));
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

export const undoItem = mutation({
  args: { id: v.id("dayLogItems") },
  handler: async (ctx, { id }) => {
    await requireTom(ctx, SURFACE);
    const item = await ctx.db.get(id);
    if (!item) throw new Error("Log item not found");
    if (item.revertedAt !== undefined) return { already: true };
    const revertedAt = Date.now();
    await ctx.db.patch(id, { revertedAt });
    await logEvent(ctx, "day-log-undo", undefined, { itemId: id });
    return { ok: true, revertedAt };
  },
});

export const undoAction = mutation({
  args: { id: v.id("dayLogActions") },
  handler: async (ctx, { id }) => {
    await requireTom(ctx, SURFACE);
    const action = await ctx.db.get(id);
    if (!action) throw new Error("Log action not found");
    if (action.revertedAt !== undefined) return { already: true };

    if (action.todoId !== undefined) {
      const todo = await ctx.db.get(action.todoId);
      const unchanged = todo !== null && (
        action.kind === "todo-capture"
          ? sameState(snapshotCapturedTodo(todo), action.after)
          : sameState(snapshotTodo(todo), action.after)
      );
      if (!unchanged || !todo) {
        throw new Error("This has changed since Jarvis touched it; change it on /tts instead.");
      }
      if (action.kind === "todo-capture") {
        await applyStatusChange(ctx, todo, { status: "archived" });
      } else {
        await ctx.db.patch(todo._id, todoPatch(action.before as TodoSnapshot));
        await back(ctx, "todos", todo._id);
      }
      await ctx.db.patch(id, { revertedAt: Date.now() });
      await logEvent(ctx, "day-log-undo", todo._id, { actionId: id });
      return { ok: true };
    }

    if (action.repeatId !== undefined) {
      const repeat = await ctx.db.get(action.repeatId);
      if (!repeat || !sameState(snapshotRepeat(repeat), action.after)) {
        throw new Error("This has changed since Jarvis touched it; change it on /tts instead.");
      }
      const before = action.before as RepeatSnapshot;
      await ctx.db.patch(repeat._id, { active: before.active, updatedAt: before.updatedAt });
      await ctx.db.patch(id, { revertedAt: Date.now() });
      await logEvent(ctx, "day-log-undo", undefined, { actionId: id, repeatId: repeat._id });
      return { ok: true };
    }

    throw new Error("Log action has no target");
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
    const openRepeats = (await ctx.db.query("ttsRepeats").take(100)).map((repeat) => ({
      id: repeat._id,
      description: repeat.statement,
      active: repeat.active,
    }));
    const now = Date.now();
    return {
      today: nyCalendarDayKey(now),
      now,
      entries: entries.map((entry) => ({ id: entry._id, text: entry.text, createdAt: entry.createdAt, day: entry.day, time: timeLabel(entry.createdAt) })),
      vocabulary: DAY_LOG_VOCABULARY,
      openRepeats,
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
    if (status === "needs-session" && (items.length > 0 || actions.length > 0)) throw new Error("a needs-session entry carries no items or actions");
    if (status === "needs-session" && failure === undefined) throw new Error("failure is required when status is needs-session");
    if (detail !== undefined && detail.length > 500) throw new Error("detail is at most 500 characters");

    const validItems = items.map((item) => validateItem(item, entry));
    const validActions = await validateActions(ctx, actions, entry);
    const validWarning = warning === undefined ? undefined : validateWarning(warning, entry);
    const now = Date.now();
    if (status === "applied") {
      for (const item of validItems) await ctx.db.insert("dayLogItems", { entryId, ...item, createdAt: now });
    }
    const appliedActions: ResultAction[] = [];
    for (const action of validActions) appliedActions.push(await applyDayLogAction(ctx, entryId, action));

    let warningTodoId: Doc<"todos">["_id"] | undefined;
    if (validWarning !== undefined) {
      const at = entryDateTimeLabel(entry.createdAt);
      warningTodoId = await captureTodo(ctx, {
        statement: `Read your log entry of ${at}`,
        source: "day-log",
        provenance: `day-log:${entryId}`,
      });
      await openNeedsTomThread(ctx, {
        todoId: warningTodoId,
        reason: warningReason(validWarning, entry),
        key: `day-log:${entryId}`,
        canReply: Boolean(process.env.SLACK_SIGNING_SECRET && process.env.TOM_SLACK_USER_ID),
      });
    }

    const result = dayLogResultLine(status, validItems, appliedActions);
    await ctx.db.patch(entryId, {
      status,
      result,
      resolvedAt: now,
      ...(validWarning === undefined || warningTodoId === undefined ? {} : { warning: { ...validWarning, todoId: warningTodoId } }),
    });
    await ctx.db.insert("dtsEvents", {
      at: now,
      kind: "day-log-resolved",
      data: {
        status,
        itemKinds: validItems.map((item) => item.kind),
        actionKinds: validActions.map((action) => action.kind),
        ...(failure === undefined ? {} : { failure }),
        ...(detail === undefined ? {} : { detail }),
      },
    });
    return { ok: true, applied: validItems.length + appliedActions.length, result };
  },
});
