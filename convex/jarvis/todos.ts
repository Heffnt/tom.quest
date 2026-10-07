// todos.ts — the box's three doors to the todos table, for the persistent
// sessions that hold Tom's list (design of 2026-10-06, section 7): write a
// todo, mark one done, read the open ones. Jarvis's `jarvis write todo`
// (worker/cli/write.mjs) is their one caller.
//
// POST /jarvis/todo        { statement, dueAt?, reminderAt?, writeId?, provenance? }
//                          -> { ok, id, duplicate }
// POST /jarvis/todo/done   { todo } -> { ok, id, already }
// GET  /jarvis/todos/open  -> { ok, todos: [{ id, statement, status, dueAt?,
//                             reminderAt?, createdAt }], truncated }
//
// The body is checked by shared/jarvis-todos.mjs, the same checks the box
// runs before the network. A todo written here is his: actor "tom" and
// readiness "prepared", as the restart's seven are (convex/ttsMigrations.ts
// internalAddRestartTodos), so no agent prepares, plans or works it, and
// tomTouchedAt freezes it to every agent pen. Its statement is stored exactly
// as given.

import { v } from "convex/values";
import { httpAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { applyStatusChange, logEvent } from "../tts";
import { jarvisAuth, jsonResponse } from "./auth";
import { resolveId } from "./tables";
import { TODO_OPEN_STATUSES, todoCreateProblem, todoDoneProblem } from "../../shared/jarvis-todos.mjs";

/** The source a todo written through these doors carries. */
const SESSION_TODO_SOURCE = "session";

/** The most open todos one read answers, per open status and per half
 *  (dated, undated): the read's cap. */
const OPEN_TODOS_MAX = 300;

export const create = internalMutation({
  args: {
    statement: v.string(),
    dueAt: v.optional(v.number()),
    reminderAt: v.optional(v.number()),
    writeId: v.optional(v.string()),
    provenance: v.optional(v.string()),
  },
  handler: async (ctx, { provenance, ...fields }) => {
    const problem = todoCreateProblem(fields);
    if (problem !== null) throw new Error(problem);
    const { statement, dueAt, reminderAt, writeId } = fields;
    // A RESEND IS NOT A SECOND TODO: the same writeId answers the row it wrote.
    if (writeId !== undefined) {
      const earlier = await ctx.db
        .query("todos")
        .withIndex("by_writeId", (q) => q.eq("writeId", writeId))
        .first();
      if (earlier !== null) return { id: earlier._id, duplicate: true };
    }
    const now = Date.now();
    const id = await ctx.db.insert("todos", {
      statement,
      readiness: "prepared",
      status: "active",
      timingClass: dueAt !== undefined ? "dated" : "whenever",
      ...(dueAt !== undefined ? { dueAt, dateKind: "self-imposed" as const } : {}),
      ...(reminderAt !== undefined ? { reminderAt } : {}),
      ...(writeId !== undefined ? { writeId } : {}),
      kind: "task",
      actor: "tom",
      source: SESSION_TODO_SOURCE,
      provenance,
      tomTouchedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await logEvent(ctx, "created", id, { source: SESSION_TODO_SOURCE, provenance });
    return { id, duplicate: false };
  },
});

export const markDone = internalMutation({
  args: { todo: v.string() },
  handler: async (ctx, { todo: given }) => {
    const problem = todoDoneProblem({ todo: given });
    if (problem !== null) throw new Error(problem);
    const id = await resolveId(ctx, "todos", given);
    const row = id === null ? null : await ctx.db.get(id);
    if (id === null || row === null) throw new Error(`no todo has the id ${given}`);
    if (row.status === "done") return { id, already: true };
    await applyStatusChange(ctx, row, { status: "done" });
    // He said it is done, so it is his touch (convex/tts.ts setStatus).
    await ctx.db.patch(id, { tomTouchedAt: Date.now() });
    return { id, already: false };
  },
});

function openRow(row: Doc<"todos">) {
  return {
    id: row._id,
    statement: row.statement,
    status: row.status,
    ...(row.dueAt !== undefined ? { dueAt: row.dueAt } : {}),
    ...(row.reminderAt !== undefined ? { reminderAt: row.reminderAt } : {}),
    createdAt: row.createdAt,
  };
}

export const open = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Read in the order answered, on the due-date index, so the cap drops
    // only the latest-due and the newest undated rows, never an overdue one:
    // dated rows soonest due first, then undated rows oldest first. "Oldest"
    // is the row's _creationTime, the order the index holds rows of one key
    // in, so the rows the cap keeps are the ones the sort puts first (a row
    // copied in from the old table carries an earlier createdAt than its
    // _creationTime, so createdAt would not match the index).
    const dated: Doc<"todos">[] = [];
    const undated: Doc<"todos">[] = [];
    let truncated = false;
    const keep = (into: Doc<"todos">[], page: Doc<"todos">[]) => {
      if (page.length > OPEN_TODOS_MAX) truncated = true;
      into.push(...page.slice(0, OPEN_TODOS_MAX));
    };
    for (const status of TODO_OPEN_STATUSES as Doc<"todos">["status"][]) {
      keep(dated, await ctx.db
        .query("todos")
        .withIndex("by_status_and_due", (q) => q.eq("status", status).gte("dueAt", 0))
        .take(OPEN_TODOS_MAX + 1));
      keep(undated, await ctx.db
        .query("todos")
        .withIndex("by_status_and_due", (q) => q.eq("status", status).eq("dueAt", undefined))
        .take(OPEN_TODOS_MAX + 1));
    }
    // Two statuses read apart are merged into the one order.
    dated.sort((a, b) => (a.dueAt as number) - (b.dueAt as number));
    undated.sort((a, b) => a._creationTime - b._creationTime);
    return { todos: [...dated, ...undated].map(openRow), truncated };
  },
});

async function jsonBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false, response: jsonResponse(400, { error: "invalid JSON body" }) };
  }
}

/** The writer, as the todo's provenance line: the session, else the agent.
 *  Kept because it is the todo's one record of which session or agent wrote
 *  it (guarantee G4, Tom understands what ran): without it a todo written by
 *  the dump session and one written by the todo session read the same. */
function provenanceLine(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { session, agentId } = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const [label, part] of [["session", session], ["agent", agentId]] as const) {
    if (part === undefined) continue;
    if (typeof part !== "string" || part.trim() === "") return null;
    parts.push(`${label} ${part}`);
  }
  return parts.length === 0 ? undefined : `jarvis write: ${parts.join(", ")}`;
}

export const postTodo = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  const parsed = await jsonBody(request);
  if (!parsed.ok) return parsed.response;
  if (parsed.body === null || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
    return jsonResponse(400, { error: "a todo is a JSON object" });
  }
  const { provenance, ...fields } = parsed.body as Record<string, unknown>;
  const line = provenanceLine(provenance);
  if (line === null) return jsonResponse(400, { error: "provenance, when given, is an object of non-empty session and agentId strings" });
  const problem = todoCreateProblem(fields);
  if (problem !== null) return jsonResponse(400, { error: problem });
  try {
    const { id, duplicate } = await ctx.runMutation(internal.jarvis.todos.create, {
      ...(fields as { statement: string; dueAt?: number; reminderAt?: number; writeId?: string }),
      ...(line !== undefined ? { provenance: line } : {}),
    });
    return jsonResponse(200, { ok: true, id, duplicate });
  } catch (e) {
    return jsonResponse(400, { error: e instanceof Error ? e.message : String(e) });
  }
});

export const postTodoDone = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  const parsed = await jsonBody(request);
  if (!parsed.ok) return parsed.response;
  const problem = todoDoneProblem(parsed.body);
  if (problem !== null) return jsonResponse(400, { error: problem });
  try {
    const { id, already } = await ctx.runMutation(internal.jarvis.todos.markDone, {
      todo: (parsed.body as { todo: string }).todo,
    });
    return jsonResponse(200, { ok: true, id, already });
  } catch (e) {
    return jsonResponse(400, { error: e instanceof Error ? e.message : String(e) });
  }
});

export const getOpenTodos = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  const { todos, truncated } = await ctx.runQuery(internal.jarvis.todos.open, {});
  return jsonResponse(200, { ok: true, todos, truncated });
});
