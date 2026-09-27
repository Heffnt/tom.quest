import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { follow, resolveId } from "./jarvis/tables";
import { gatherTodayFacts } from "./ttsDigest";
import { gatherWeeklyFacts, WEEK_MS } from "./ttsWeekly";
import { nyCalendarDayKey } from "./ttsShared";

// The box's work queue posts each finished agent's outcome to POST
// /jarvis/event with the todo as subject, in either id form (convex/jarvis/
// tables.ts), and the digest and the weekly count it on that todo.

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

type T = ReturnType<typeof convexTest>;

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function withTom(t: T) {
  const tomId = await t.run(async (ctx) => ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }));
  return t.withIdentity({ subject: tomId });
}

const DAY = 86_400_000;

/** A todo, a block on it and a time note on the block, written through the
 *  doors (so the dual write made their plain rows), with both ids of each. */
async function seed(t: T) {
  const tom = await withTom(t);
  const todo = await tom.mutation(api.tts.createTodo, { statement: "renew the lease", dueAt: Date.now() + 3 * DAY });
  const block = await tom.mutation(api.tts.createBlock, { start: Date.now() + DAY, end: Date.now() + DAY + 3_600_000, todoId: todo });
  const note = await tom.mutation(api.tts.createTimeNote, { text: "move it to Friday", blockId: block });
  const plain = await t.run(async (ctx) => ({
    todo: (await resolveId(ctx, "todos", todo))!,
    block: (await resolveId(ctx, "blocks", block))!,
    note: (await resolveId(ctx, "timeNotes", note))!,
  }));
  return { tom, old: { todo, block, note }, plain };
}

// The box's work queue (Jarvis worker/jobs/work-queue.mjs, pull request 74)
// records each finished agent as one session-outcome event on its todo.
describe("a work-queue outcome on its todo", () => {
  const KEY = "not-a-key";
  const post = (t: T, body: unknown) =>
    t.fetch("/jarvis/event", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Jarvis-Key": KEY },
      body: JSON.stringify(body),
    });
  const outcome = (subject: unknown, at: number, result = "completed") => ({
    kind: "session-outcome",
    at,
    provenance: { job: "work-queue" },
    subject,
    data: { job: "work-queue", outcome: result, summary: "called the landlord", costUsd: 0.4 },
  });

  it("is taken with the todo as subject in either form, kept under the plain id; any other subject is refused", async () => {
    vi.stubEnv("JARVIS_KEY", KEY);
    const t = convexTest({ schema, modules });
    const { old, plain } = await seed(t);
    expect((await post(t, outcome(old.todo, Date.now()))).status).toBe(200);
    expect((await post(t, outcome(plain.todo, Date.now()))).status).toBe(200);
    const rows = await t.run(async (ctx) => ctx.db.query("events").collect());
    expect(rows.filter((r) => r.kind === "session-outcome").map((r) => r.subject)).toEqual([plain.todo, plain.todo]);
    for (const subject of [undefined, "work-queue:x:1", old.block]) {
      const res = await post(t, outcome(subject, Date.now()));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("a session-outcome event names its todo as its subject");
    }
  });

  it("is counted on its todo in the digest, one finished run per outcome, and an errored one is a failure line", async () => {
    vi.stubEnv("JARVIS_KEY", KEY);
    const t = convexTest({ schema, modules });
    const { old, plain } = await seed(t);
    const now = Date.now();
    await post(t, outcome(old.todo, now - 3 * 3_600_000));
    await post(t, outcome(plain.todo, now - 2 * 3_600_000, "errored"));
    // The copy of a POST /tts/event row names its key, not a todo: not read here.
    await t.run(async (ctx) => {
      await ctx.db.insert("events", { kind: "session-outcome", at: now - 3_600_000, provenance: {}, subject: `work-queue:${old.todo}:1`, data: {} });
      await follow(ctx, "todos", old.todo);
    });
    const facts = await t.run(async (ctx) => gatherTodayFacts(ctx, { day: nyCalendarDayKey(now), now, since: now - DAY }));
    expect(facts.overnightByTodo).toEqual([
      expect.objectContaining({ todoId: plain.todo, statement: "renew the lease", finished: 2 }),
    ]);
    expect(facts.broken.filter((row) => row.statement.startsWith("A session ended in an error"))).toHaveLength(1);
  });

  // witness: the read of the window's outcomes took the OLDEST 2,000, so a
  // busy night left its newest outcomes out of the digest.
  it("counts the night's newest outcome however many came before it", async () => {
    const t = convexTest({ schema, modules });
    const { plain } = await seed(t);
    const now = Date.now();
    const newest = await t.run(async (ctx) => {
      const other = await ctx.db.insert("dtsTodos", {
        statement: "the last one worked",
        readiness: "prepared",
        status: "active",
        timingClass: "whenever",
        source: "test",
        createdAt: now,
        updatedAt: now,
      });
      await follow(ctx, "todos", other);
      const otherPlain = (await resolveId(ctx, "todos", other))!;
      for (let n = 0; n < 2000; n += 1) {
        await ctx.db.insert("events", { kind: "session-outcome", at: now - 5 * 3_600_000 + n, provenance: {}, subject: plain.todo, data: { outcome: "completed" } });
      }
      await ctx.db.insert("events", { kind: "session-outcome", at: now - 60_000, provenance: {}, subject: otherPlain, data: { outcome: "completed" } });
      return otherPlain;
    });
    const facts = await t.run(async (ctx) => gatherTodayFacts(ctx, { day: nyCalendarDayKey(now), now, since: now - DAY }));
    expect(facts.overnightByTodo).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ todoId: newest, statement: "the last one worked", finished: 1 }),
        expect.objectContaining({ todoId: plain.todo, finished: 1999 }),
      ]),
    );
  });

  it("is an evaluation of its goal in the weekly", async () => {
    vi.stubEnv("JARVIS_KEY", KEY);
    const t = convexTest({ schema, modules });
    const now = Date.now();
    const goals = await t.run(async (ctx) => {
      const make = async (statement: string) => {
        const id = await ctx.db.insert("dtsTodos", {
          statement,
          kind: "goal",
          readiness: "unprepared",
          status: "active",
          timingClass: "whenever",
          source: "test",
          createdAt: now - 20 * DAY,
          updatedAt: now - 20 * DAY,
        });
        await follow(ctx, "todos", id);
        return { old: id, plain: (await resolveId(ctx, "todos", id)) as Id<"todos"> };
      };
      return { worked: await make("paper submitted"), idle: await make("lease signed") };
    });
    expect((await post(t, outcome(goals.worked.plain, now - 2 * DAY))).status).toBe(200);
    const until = now + 1000;
    const f = await t.run(async (ctx) => gatherWeeklyFacts(ctx, { since: until - WEEK_MS, until }));
    expect(f.goalsNotEvaluated.map((g) => g.statement)).toEqual(["lease signed"]);
  });
});
