// build.ts — the rows a session writes while it builds a todo, on the record's
// side. Two kinds, both with the todo's id as subject (shapes in
// shared/jarvis-events.mjs; the box posts them with Jarvis `jarvis write`
// through POST /jarvis/event, Tom through events.ts recordForTom):
//
//   todo-state  where the todo stands in a build; its newest row per todo is
//               the todo's build state.
//   handoff     what the next turn, process or session continues from, one
//               per transition; the "design to build" one carries the work
//               order.
//
// WHAT THE RECORD ADDS TO THE SHARED CHECK, before the insert (prepareBuildRow):
// the subject names a todo that exists, and is kept as its plain id; a
// handoff after the first on a todo names the todo's newest handoff as
// data.previous (the one the record inserted last, whatever its `at`), so
// the handoffs of one todo are one chain with no fork; an ordered or
// building todo-state names the todo's "design to build" handoff as its order.
//
// THE ONE SIDE EFFECT (onTodoState, run by events.ts recordEvent in the same
// mutation): a todo-state "done" sets the todo's status to done through
// convex/tts.ts applyStatusChange, the one status writer, so the todo page's
// field and the state rows agree on done. No other state touches the todo.
//
// THE READ (newest, newestForTom, GET /jarvis/build-state): per todo, its
// newest todo-state and its newest handoff, under a byte budget
// (convex/readBudget.ts) that stops the read before Convex's read limit. The box's SessionStart hook hands
// the next turn its handoff from it, and /agents shows where each todo stands.

import { v } from "convex/values";
import { httpAction, internalQuery, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireTom } from "../authRoles";
import { applyStatusChange } from "../tts";
import { jarvisAuth, jsonResponse } from "./auth";
import { checkEvent } from "./record";
import type { EventInput } from "./record";
import { resolveId } from "./tables";
import { MIB, ReadBudget, getWithin, readWithin, type ReadCut } from "../readBudget";

export const TODO_STATE = "todo-state";
export const HANDOFF = "handoff";

/**
 * The row of one kind the record inserted last on one todo. Insertion order,
 * not the writer's `at`: a writer may date a row in the past, and a handoff
 * chain headed by the newest `at` would leave a backdated handoff off the
 * head, so the next handoff could name the same predecessor and fork it.
 */
async function newestOf(ctx: QueryCtx, kind: string, todoId: string): Promise<Doc<"events"> | null> {
  return await ctx.db
    .query("events")
    .withIndex("by_kind_subject", (q) => q.eq("kind", kind).eq("subject", todoId))
    .order("desc")
    .first();
}

/**
 * Check a todo-state or handoff against the record before it is inserted,
 * and answer it with the todo's plain id as subject. Throws one sentence
 * naming the first thing wrong.
 */
export async function prepareBuildRow(ctx: MutationCtx, input: EventInput): Promise<EventInput> {
  const checked = checkEvent(input);
  if (!checked.ok) throw new Error(checked.error);
  const todoId = input.subject === undefined ? null : await resolveId(ctx, "todos", input.subject);
  if (todoId === null) throw new Error(`a ${input.kind} event names its todo as its subject`);
  const data = checked.event.data as { previous?: string; state?: string; orderRowId?: string };
  if (input.kind === HANDOFF) {
    const newest = await newestOf(ctx, HANDOFF, todoId);
    if (newest === null && data.previous !== undefined) {
      throw new Error("the first handoff on a todo names no data.previous");
    }
    if (newest !== null && data.previous !== newest._id) {
      throw new Error(`a handoff names data.previous as the todo's newest handoff, ${newest._id}`);
    }
  }
  if (input.kind === TODO_STATE && (data.state === "ordered" || data.state === "building")) {
    const orderId = ctx.db.normalizeId("events", data.orderRowId ?? "");
    const order = orderId === null ? null : await ctx.db.get(orderId);
    const transition = (order?.data as { transition?: unknown } | undefined)?.transition;
    if (order === null || order.kind !== HANDOFF || order.subject !== todoId || transition !== "design to build") {
      throw new Error(`a todo-state ${data.state} names data.orderRowId as the todo's design to build handoff`);
    }
  }
  return { ...input, subject: todoId };
}

/** A todo-state "done" sets the todo's status to done; every other state leaves the todo alone. */
export async function onTodoState(ctx: MutationCtx, row: Doc<"events">): Promise<{ todoStatus: "done" } | undefined> {
  const data = row.data as { state?: unknown; sentence?: unknown };
  if (data.state !== "done" || row.subject === undefined) return undefined;
  const todoId = ctx.db.normalizeId("todos", row.subject);
  const todo = todoId === null ? null : await ctx.db.get(todoId);
  if (todo === null) return undefined;
  if (todo.status !== "done") {
    await applyStatusChange(ctx, todo, {
      status: "done",
      note: typeof data.sentence === "string" ? data.sentence : undefined,
    });
  }
  return { todoStatus: "done" };
}

type BuildState = {
  todoId: Id<"todos">;
  statement: string;
  status: Doc<"todos">["status"];
  todoState: Doc<"events"> | null;
  handoff: Doc<"events"> | null;
};

/** The most todos one read answers, and the todo-state rows a read with no todo named scans. */
const TODOS_MAX = 100;
const RECENT_ROWS = 500;

/**
 * The bytes one read of build states may take: half of what one Convex
 * function may read, so the reads outside the budget (an old-form id's
 * lookup) and the one document that crosses it stay under the limit. The
 * scan of recent todo-state rows has its own share, so the todos it names
 * still have room to be read.
 */
export const BUILD_STATE_BYTES = 8 * MIB;
const RECENT_ROWS_BYTES = 2 * MIB;

/**
 * Per todo, its newest todo-state and newest handoff. The todos are the ones
 * named, in either id form (an unknown id is left out; a todo with no build
 * row answers both as null, which is waiting), or with none named, the todos
 * of the newest todo-state rows, the most recently moved first. Every row is
 * read under one ReadBudget, newest first: once it is spent the read stops,
 * the todos read so far are answered, and `cuts` names the read that stopped.
 */
async function buildStates(ctx: QueryCtx, todoIds: string[] | undefined): Promise<{ todos: BuildState[]; cuts: ReadCut[] }> {
  const budget = ReadBudget.of(BUILD_STATE_BYTES);
  let named: string[];
  if (todoIds !== undefined) {
    named = todoIds;
  } else {
    const rows = await readWithin(
      budget.allot("todo-state rows", RECENT_ROWS_BYTES),
      ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", TODO_STATE)).order("desc"),
      RECENT_ROWS,
    );
    named = rows.flatMap((row) => (row.subject === undefined ? [] : [row.subject]));
  }
  const reads = budget.allot("todos and their newest build rows", BUILD_STATE_BYTES);
  const seen = new Set<string>();
  const todos: BuildState[] = [];
  for (const given of named) {
    if (todos.length === TODOS_MAX) break;
    const id = ctx.db.normalizeId("todos", given) ?? (await resolveId(ctx, "todos", given));
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    const todo = await getWithin(reads, () => ctx.db.get(id));
    if (todo === undefined) break;
    if (todo === null) continue;
    const todoState = await getWithin(reads, () => newestOf(ctx, TODO_STATE, id));
    const handoff = await getWithin(reads, () => newestOf(ctx, HANDOFF, id));
    if (todoState === undefined || handoff === undefined) break;
    todos.push({ todoId: id, statement: todo.statement, status: todo.status, todoState, handoff });
  }
  return { todos, cuts: budget.cuts() };
}

const statesArgs = { todoIds: v.optional(v.array(v.string())) };

/** GET /jarvis/build-state's read. */
export const newest = internalQuery({
  args: statesArgs,
  handler: async (ctx, { todoIds }) => await buildStates(ctx, todoIds),
});

/** The same read for Tom's pages (/agents). */
export const newestForTom = query({
  args: statesArgs,
  handler: async (ctx, { todoIds }) => {
    await requireTom(ctx, "Agents");
    return await buildStates(ctx, todoIds);
  },
});

/** GET /jarvis/build-state?todo=<id>[&todo=<id>...]: { ok, todos: [BuildState], cuts }. */
export const getBuildState = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  const named = new URL(request.url).searchParams.getAll("todo").filter((id) => id !== "");
  const { todos, cuts } = await ctx.runQuery(internal.jarvis.build.newest, named.length === 0 ? {} : { todoIds: named });
  return jsonResponse(200, { ok: true, todos, cuts });
});
