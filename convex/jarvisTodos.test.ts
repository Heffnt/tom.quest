import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

// The box's todo doors (convex/jarvis/todos.ts) and the day facts through
// POST /jarvis/event, over HTTP with the box's key, as `jarvis write` posts
// them. convex-test names modules by their path under convex/, so the glob
// starts at the convex root.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const KEY = { "X-Jarvis-Key": "k", "Content-Type": "application/json" };

beforeAll(async () => {
  await convexTest({ schema, modules }).fetch("/jarvis/todos/open");
}, 60_000);

afterEach(() => vi.unstubAllEnvs());

function harness() {
  vi.stubEnv("JARVIS_KEY", "k");
  return convexTest({ schema, modules });
}

type T = ReturnType<typeof harness>;
const post = (t: T, path: string, body: unknown) =>
  t.fetch(path, { method: "POST", headers: KEY, body: JSON.stringify(body) });

describe("POST /jarvis/todo", () => {
  it("writes his words exactly, the due and reminder times, as his own prepared todo", async () => {
    const t = harness();
    const response = await post(t, "/jarvis/todo", {
      statement: "  return Spectrum hardware ",
      dueAt: 1_791_000_000_000,
      reminderAt: 1_790_990_000_000,
      writeId: "todo:w1",
      provenance: { session: "todo" },
    });
    expect(response.status).toBe(200);
    const answer = await response.json();
    expect(answer).toMatchObject({ ok: true, duplicate: false });
    const row = await t.run((ctx) => ctx.db.get(answer.id as Id<"todos">));
    expect(row).toMatchObject({
      statement: "  return Spectrum hardware ",
      dueAt: 1_791_000_000_000,
      reminderAt: 1_790_990_000_000,
      timingClass: "dated",
      status: "active",
      readiness: "prepared",
      actor: "tom",
      source: "session",
      provenance: "jarvis write: session todo",
      writeId: "todo:w1",
    });
  });

  it("answers a resend with the row it already wrote", async () => {
    const t = harness();
    const first = await (await post(t, "/jarvis/todo", { statement: "buy couch", writeId: "todo:w2" })).json();
    const again = await (await post(t, "/jarvis/todo", { statement: "buy couch", writeId: "todo:w2" })).json();
    expect(again).toEqual({ ok: true, id: first.id, duplicate: true });
    expect((await t.run((ctx) => ctx.db.query("todos").collect())).length).toBe(1);
  });

  it("refuses what the box refuses, with the same sentence, and without the key", async () => {
    const t = harness();
    const bad = await post(t, "/jarvis/todo", { statement: "a", due: 5 });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("a todo holds only statement, dueAt, reminderAt, writeId; due is not one of them");
    const keyless = await t.fetch("/jarvis/todo", { method: "POST", body: JSON.stringify({ statement: "a" }) });
    expect(keyless.status).toBe(401);
  });
});

describe("POST /jarvis/todo/done and GET /jarvis/todos/open", () => {
  it("lists the open ones, dated first, and marks one done once", async () => {
    const t = harness();
    const plain = (await (await post(t, "/jarvis/todo", { statement: "buy desk" })).json()).id;
    const dated = (await (await post(t, "/jarvis/todo", { statement: "oil change", dueAt: 1_791_000_000_000 })).json()).id;
    const open = await (await t.fetch("/jarvis/todos/open", { headers: KEY })).json();
    expect(open.truncated).toBe(false);
    expect(open.todos.map((row: { id: string }) => row.id)).toEqual([dated, plain]);

    const done = await post(t, "/jarvis/todo/done", { todo: dated });
    expect(await done.json()).toEqual({ ok: true, id: dated, already: false });
    const row = await t.run((ctx) => ctx.db.get(dated as Id<"todos">));
    expect(row?.status).toBe("done");
    expect(typeof row?.doneAt).toBe("number");
    expect(await (await post(t, "/jarvis/todo/done", { todo: dated })).json()).toEqual({ ok: true, id: dated, already: true });

    const after = await (await t.fetch("/jarvis/todos/open", { headers: KEY })).json();
    expect(after.todos.map((r: { id: string }) => r.id)).toEqual([plain]);
  });

  it("keeps an overdue todo when the open list is over its cap, reading the soonest due first", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      for (let i = 0; i < 305; i++) {
        await ctx.db.insert("todos", { statement: `undated ${i}`, readiness: "prepared", status: "active", timingClass: "whenever", source: "session", createdAt: i, updatedAt: 10_000 + i });
      }
      for (let i = 0; i < 305; i++) {
        await ctx.db.insert("todos", { statement: `dated ${i}`, readiness: "prepared", status: "active", timingClass: "dated", dueAt: 1_000_000 + i, source: "session", createdAt: 1, updatedAt: i });
      }
    });
    const open = await (await t.fetch("/jarvis/todos/open", { headers: KEY })).json();
    expect(open.truncated).toBe(true);
    const statements = open.todos.map((row: { statement: string }) => row.statement);
    expect(statements.slice(0, 2)).toEqual(["dated 0", "dated 1"]);
    expect(statements[300]).toBe("undated 0");
    expect(statements).toHaveLength(600);
  });

  it("refuses a done that names no todo", async () => {
    const t = harness();
    const missing = await post(t, "/jarvis/todo/done", { todo: "nope" });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toContain("no todo has the id nope");
  });
});

describe("a day fact through POST /jarvis/event", () => {
  it("is written once per data.id, and refused when malformed", async () => {
    const t = harness();
    const meal = { kind: "meal", data: { id: "meal:r1", day: "2026-10-06", summary: "chicken and rice", quote: "had chicken and rice", proteinG: 45, calories: 700 } };
    const first = await (await post(t, "/jarvis/event", meal)).json();
    const again = await (await post(t, "/jarvis/event", meal)).json();
    expect(again.id).toBe(first.id);
    expect(again.duplicate).toBe(true);
    const bad = await post(t, "/jarvis/event", { kind: "weight", data: { day: "2026-10-06", summary: "weighed in", metric: "weight", value: 175, unit: "kg" } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("a weight event names data.unit for weight as lb");
  });
});
