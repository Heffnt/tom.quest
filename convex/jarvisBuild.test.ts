import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { insertCopied } from "../test/core-tables";

// A session building a todo writes todo-state and handoff rows on it
// (shared/jarvis-events.mjs has the shapes; convex/jarvis/build.ts the
// record's checks, the done hook and the read).

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

type T = ReturnType<typeof convexTest>;

const KEY = "not-a-key";
const HEADERS = { "Content-Type": "application/json", "X-Jarvis-Key": KEY };
const post = (t: T, body: unknown) => t.fetch("/jarvis/event", { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
const AGENT = "claude:box:session-1";

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A todo in both id forms (the old row and its plain copy). */
async function seedTodo(t: T, statement = "refuse a whitespace-only statement") {
  return await t.run(async (ctx) =>
    insertCopied(ctx, "todos", { statement, readiness: "unprepared", status: "active", timingClass: "whenever", source: "manual", createdAt: 1, updatedAt: 1 }),
  );
}

const todoState = (subject: string, data: Record<string, unknown>) => ({
  kind: "todo-state",
  provenance: { agentId: AGENT },
  subject,
  data: { by: AGENT, ...data },
  text: `todo ${subject} is ${String(data.state)}`,
});

const handoff = (subject: string, transition: string, data: Record<string, unknown> = {}) => ({
  kind: "handoff",
  provenance: { agentId: AGENT },
  subject,
  data: { transition, sentences: [], state: "where it stands", next: "the next step", pointers: {}, ...data },
  text: `${transition} on todo ${subject}: the next step`,
});

const order = (todoId: string) => ({
  todo: [{ id: todoId, statement: "refuse a whitespace-only statement" }],
  design: "every door that stores a statement refuses a whitespace-only one",
  checks: [{ type: "mechanical", command: "pnpm vitest run convex/tts.test.ts", expected: "exit 0" }],
  decisions: { sentences: ["go"], answered: [] },
  outOfScope: [],
  walls: [],
  agents: { tasks: [{ n: 1, name: "refusals and tests", role: "worker", check: "the vitest command exits 0" }] },
  builder: "session",
});

async function written(t: T, body: unknown): Promise<{ id: string; todoStatus?: string }> {
  const res = await post(t, body);
  const json = await res.json();
  expect({ status: res.status, json }).toMatchObject({ status: 200, json: { ok: true } });
  return json;
}

async function refused(t: T, body: unknown): Promise<string> {
  const res = await post(t, body);
  expect(res.status).toBe(400);
  return (await res.json()).error;
}

describe("a build's rows through POST /jarvis/event", () => {
  it("takes one build from in session to done, and done sets the todo's status", async () => {
    vi.stubEnv("JARVIS_KEY", KEY);
    const t = convexTest({ schema, modules });
    const todo = await seedTodo(t);
    // The todo named in its old id form is kept as its plain id.
    const first = await written(t, todoState(todo.old, { state: "in session", from: "waiting" }));
    const h1 = await written(t, handoff(todo.old, "exploration to design", { sentences: [{ at: 1, text: "design the refusals" }] }));
    const h2 = await written(t, handoff(todo.plain, "design to build", { previous: h1.id, order: order(todo.plain) }));
    await written(t, todoState(todo.plain, { state: "building", from: "in session", orderRowId: h2.id, builder: "session" }));
    const h3 = await written(t, handoff(todo.plain, "build to review", { previous: h2.id }));
    const h4 = await written(t, handoff(todo.plain, "review to landing", { previous: h3.id, gate: { testsRunRowId: "r1", auditVerdictRowId: "r2" } }));
    const h5 = await written(t, handoff(todo.plain, "landing to return", { previous: h4.id, mergeRowId: "m1", commit: "abc1234" }));
    const returned = await written(t, todoState(todo.plain, { state: "returned", from: "building", mergeRowId: "m1", pullRequest: { repo: "tom.quest", number: 350 } }));
    expect(returned.todoStatus).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(todo.plain)))?.status).toBe("active");

    const done = await written(t, todoState(todo.plain, { state: "done", from: "returned", sentence: "done" }));
    expect(done.todoStatus).toBe("done");
    const after = await t.run((ctx) => ctx.db.get(todo.plain));
    expect(after).toMatchObject({ status: "done" });
    expect(after?.doneAt).toEqual(expect.any(Number));

    const rows = await t.run((ctx) => ctx.db.query("events").withIndex("by_subject_at", (q) => q.eq("subject", todo.plain)).collect());
    expect(rows.map((row) => row.kind)).toEqual(["todo-state", "handoff", "handoff", "todo-state", "handoff", "handoff", "handoff", "todo-state", "todo-state"]);
    expect(rows[0]._id).toBe(first.id);

    // The read: the newest of each on the todo, named in either id form.
    const res = await t.fetch(`/jarvis/build-state?todo=${todo.old}`, { headers: HEADERS });
    const body = await res.json();
    expect(body.todos).toHaveLength(1);
    expect(body.todos[0]).toMatchObject({
      todoId: todo.plain,
      status: "done",
      todoState: { _id: done.id, data: { state: "done" } },
      handoff: { _id: h5.id, data: { transition: "landing to return" } },
    });
  });

  it("refuses a row whose subject names no todo, and one the shared check refuses", async () => {
    vi.stubEnv("JARVIS_KEY", KEY);
    const t = convexTest({ schema, modules });
    expect(await refused(t, todoState("no-such-todo", { state: "in session", from: "waiting" }))).toBe("a todo-state event names its todo as its subject");
    expect(await refused(t, handoff("no-such-todo", "exploration to design"))).toBe("a handoff event names its todo as its subject");
    const todo = await seedTodo(t);
    expect(await refused(t, todoState(todo.plain, { state: "started", from: "waiting" }))).toContain("data.state as one of");
    expect(await refused(t, { ...handoff(todo.plain, "exploration to design"), data: { state: "x" } })).toContain("data.transition as one of");
    expect(await t.run((ctx) => ctx.db.query("events").collect())).toHaveLength(0);
  });

  it("keeps a todo's handoffs one chain: the first names no previous, each later one the newest", async () => {
    vi.stubEnv("JARVIS_KEY", KEY);
    const t = convexTest({ schema, modules });
    const todo = await seedTodo(t);
    expect(await refused(t, handoff(todo.plain, "exploration to design", { previous: "e0" }))).toBe("the first handoff on a todo names no data.previous");
    const h1 = await written(t, handoff(todo.plain, "exploration to design"));
    expect(await refused(t, handoff(todo.plain, "design to build", { order: order(todo.plain) }))).toBe(
      `a handoff names data.previous as the todo's newest handoff, ${h1.id}`,
    );
    const h2 = await written(t, handoff(todo.plain, "design to build", { previous: h1.id, order: order(todo.plain) }));
    // Pointing past the newest is refused too.
    expect(await refused(t, handoff(todo.plain, "build to review", { previous: h1.id }))).toContain(h2.id);
    // Another todo's chain starts on its own.
    const other = await seedTodo(t, "another todo");
    await written(t, handoff(other.plain, "exploration to design"));
  });

  it("heads the chain with the handoff written last, even one dated before its predecessor, so it cannot fork", async () => {
    vi.stubEnv("JARVIS_KEY", KEY);
    const t = convexTest({ schema, modules });
    const todo = await seedTodo(t);
    const now = Date.now();
    const h1 = await written(t, { ...handoff(todo.plain, "exploration to design"), at: now - 60_000 });
    // Backdated: its writer dates it a minute before h1.
    const h2 = await written(t, { ...handoff(todo.plain, "design to build", { previous: h1.id, order: order(todo.plain) }), at: now - 120_000 });
    // h1 is not the head any more, whatever the dates say: naming it again would fork the chain.
    expect(await refused(t, handoff(todo.plain, "build to review", { previous: h1.id }))).toBe(
      `a handoff names data.previous as the todo's newest handoff, ${h2.id}`,
    );
    const body = await (await t.fetch(`/jarvis/build-state?todo=${todo.plain}`, { headers: HEADERS })).json();
    expect(body.todos[0].handoff._id).toBe(h2.id);
    const h3 = await written(t, handoff(todo.plain, "build to review", { previous: h2.id }));
    const chain = await t.run((ctx) => ctx.db.query("events").withIndex("by_kind_subject", (q) => q.eq("kind", "handoff").eq("subject", todo.plain)).collect());
    expect(chain.map((row) => [row._id, (row.data as { previous?: string }).previous])).toEqual([
      [h1.id, undefined],
      [h2.id, h1.id],
      [h3.id, h2.id],
    ]);
  });

  it("refuses an ordered or building state whose order is not the todo's design to build handoff", async () => {
    vi.stubEnv("JARVIS_KEY", KEY);
    const t = convexTest({ schema, modules });
    const todo = await seedTodo(t);
    const other = await seedTodo(t, "another todo");
    const h1 = await written(t, handoff(todo.plain, "exploration to design"));
    const theirs = await written(t, handoff(other.plain, "exploration to design"));
    const h2Other = await written(t, handoff(other.plain, "design to build", { previous: theirs.id, order: order(other.plain) }));
    const building = (orderRowId: string) => todoState(todo.plain, { state: "building", from: "in session", orderRowId, builder: "session" });
    const sentence = "a todo-state building names data.orderRowId as the todo's design to build handoff";
    expect(await refused(t, building(h1.id))).toBe(sentence);
    expect(await refused(t, building(h2Other.id))).toBe(sentence);
    expect(await refused(t, building("not-an-id"))).toBe(sentence);
    const h2 = await written(t, handoff(todo.plain, "design to build", { previous: h1.id, order: { ...order(todo.plain), builder: "orchestrator" } }));
    await written(t, todoState(todo.plain, { state: "ordered", from: "in session", orderRowId: h2.id, builder: "orchestrator" }));
  });

  it("answers, with no todo named, each moved todo's newest rows, the most recently moved first", async () => {
    vi.stubEnv("JARVIS_KEY", KEY);
    const t = convexTest({ schema, modules });
    const a = await seedTodo(t, "todo a");
    const b = await seedTodo(t, "todo b");
    const quiet = await seedTodo(t, "todo with no build row");
    await written(t, { ...todoState(a.plain, { state: "in session", from: "waiting" }), at: Date.now() - 3000 });
    await written(t, { ...todoState(b.plain, { state: "in session", from: "waiting" }), at: Date.now() - 2000 });
    await written(t, { ...todoState(a.plain, { state: "waiting", from: "in session" }), at: Date.now() - 1000 });
    const body = await (await t.fetch("/jarvis/build-state", { headers: HEADERS })).json();
    expect(body.todos.map((s: { statement: string; todoState: { data: { state: string } } }) => [s.statement, s.todoState.data.state])).toEqual([
      ["todo a", "waiting"],
      ["todo b", "in session"],
    ]);
    // A todo named with no build row answers both as null; an unknown id is left out.
    const named = await (await t.fetch(`/jarvis/build-state?todo=${quiet.plain}&todo=nothing`, { headers: HEADERS })).json();
    expect(named.todos).toEqual([{ todoId: quiet.plain, statement: "todo with no build row", status: "active", todoState: null, handoff: null }]);
    expect((await t.fetch("/jarvis/build-state")).status).toBe(401);
  });
});

describe("Tom's door for a build's rows", () => {
  async function tom(t: T) {
    const id = await t.run((ctx) => ctx.db.insert("users", { name: "tom", email: "tom@example.test", role: "tom" }));
    return t.withIdentity({ subject: id });
  }

  it("writes a todo-state with his provenance, runs the done hook, and refuses anyone else", async () => {
    const t = convexTest({ schema, modules });
    const viewer = await tom(t);
    const todo = await seedTodo(t);
    const { id } = await viewer.mutation(api.jarvis.events.recordForTom, {
      kind: "todo-state",
      subject: todo.old,
      data: { state: "done", from: "in session", sentence: "this one is done" },
      text: `todo ${todo.plain} is done`,
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ subject: todo.plain, provenance: { user: "tom" }, data: { state: "done", by: "tom" } });
    expect((await t.run((ctx) => ctx.db.get(todo.plain)))?.status).toBe("done");
    expect((await viewer.query(api.jarvis.build.newestForTom, { todoIds: [todo.plain] }))[0]).toMatchObject({ todoState: { _id: id } });

    await expect(
      viewer.mutation(api.jarvis.events.recordForTom, { kind: "handoff", subject: todo.plain, data: { transition: "leaving" }, text: "x" }),
    ).rejects.toThrow("data.sentences");

    const userId = await t.run((ctx) => ctx.db.insert("users", { name: "reader", email: "reader@example.test", role: "user" }));
    const reader = t.withIdentity({ subject: userId });
    await expect(
      reader.mutation(api.jarvis.events.recordForTom, { kind: "todo-state", subject: todo.plain, data: { state: "waiting", from: "done" }, text: "x" }),
    ).rejects.toThrow("Agents access is restricted to Tom");
    await expect(reader.query(api.jarvis.build.newestForTom, {})).rejects.toThrow("Agents access is restricted to Tom");
  });
});
