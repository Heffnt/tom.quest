import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { insertCopied } from "../test/core-tables";

// The box's work queue posts each finished agent's outcome to POST
// /jarvis/event with the todo as subject, in either id form (convex/jarvis/
// tables.ts).

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

/** A todo from before step C (its old row and its plain copy). */
async function seed(t: T) {
  const tom = await withTom(t);
  const ids = await t.run(async (ctx) => {
    const todo = await insertCopied(ctx, "todos", { statement: "renew the lease", readiness: "unprepared", status: "active", timingClass: "dated", dueAt: Date.now() + 3 * DAY, source: "manual", createdAt: 1, updatedAt: 1 });
    return { todo };
  });
  return {
    tom,
    old: { todo: ids.todo.old },
    plain: { todo: ids.todo.plain },
  };
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

  it("a retry with the same data.id is not recorded again: ok, duplicate, and the first row's id", async () => {
    vi.stubEnv("JARVIS_KEY", KEY);
    const t = convexTest({ schema, modules });
    const { old, plain } = await seed(t);
    const runId = `work-queue:${plain.todo}:r1:1700000000000`;
    const sent = { ...outcome(plain.todo, Date.now()), data: { ...outcome(plain.todo, 0).data, id: runId } };
    const first = await (await post(t, sent)).json();
    expect(first).toMatchObject({ ok: true, duplicate: false });
    // The retry, with the todo in its other id form: the same run.
    const again = await post(t, { ...sent, subject: old.todo });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, id: first.id, duplicate: true });
    // Another run of the same todo is another outcome.
    const next = await (await post(t, { ...sent, data: { ...sent.data, id: `${runId}1` } })).json();
    expect(next).toMatchObject({ ok: true, duplicate: false });
    const rows = await t.run(async (ctx) => ctx.db.query("events").collect());
    expect(rows.filter((r) => r.kind === "session-outcome").map((r) => r._id)).toEqual([first.id, next.id]);
  });

  it("finds a retry by its id behind many earlier outcomes on the same todo", async () => {
    vi.stubEnv("JARVIS_KEY", KEY);
    const t = convexTest({ schema, modules });
    const { plain } = await seed(t);
    const at = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 5000; i += 1) {
        await ctx.db.insert("events", { kind: "session-outcome", at: at - 10_000 + i, provenance: {}, subject: plain.todo, data: { id: `work-queue:${plain.todo}:r0:${i}` } });
      }
    });
    const sent = { ...outcome(plain.todo, at), data: { ...outcome(plain.todo, 0).data, id: `work-queue:${plain.todo}:r1:${at}` } };
    const first = await (await post(t, sent)).json();
    expect(await (await post(t, sent)).json()).toEqual({ ok: true, id: first.id, duplicate: true });
  });

  it("is taken with the todo as subject in either form, kept under the plain id; any other subject is refused", async () => {
    vi.stubEnv("JARVIS_KEY", KEY);
    const t = convexTest({ schema, modules });
    const { old, plain } = await seed(t);
    expect((await post(t, outcome(old.todo, Date.now()))).status).toBe(200);
    expect((await post(t, outcome(plain.todo, Date.now()))).status).toBe(200);
    const rows = await t.run(async (ctx) => ctx.db.query("events").collect());
    expect(rows.filter((r) => r.kind === "session-outcome").map((r) => r.subject)).toEqual([plain.todo, plain.todo]);
    for (const subject of [undefined, "work-queue:x:1"]) {
      const res = await post(t, outcome(subject, Date.now()));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("a session-outcome event names its todo as its subject");
    }
  });

});
