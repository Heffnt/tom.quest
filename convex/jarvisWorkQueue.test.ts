import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";
import { follow, resolveId } from "./jarvis/tables";

// GET /jarvis/context?for=work-queue: the todos an unattended agent may work
// now, computed by the record's own rules (convex/ttsRulings.ts
// internalWorkQueue), so the box's work queue keeps no copy of them.

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

type T = ReturnType<typeof convexTest>;
const KEY = { "X-Jarvis-Key": "not-a-key" };
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
/** When every fixture todo last changed; a ruling after it answers it. */
const UPDATED = NOW - 2 * DAY;

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

type Verdict = "approve" | "revise" | "session" | "archive";

/** One todo as the dual write stores it (old row, then its plain copy),
 *  eligible unless `fields` says otherwise, with its rulings, oldest first. */
async function todo(
  ctx: MutationCtx,
  statement: string,
  fields: Record<string, unknown> = {},
  rulings: { verdict: Verdict; at: number; sentence?: string }[] = [{ verdict: "approve", at: UPDATED + 1000 }],
) {
  const old = await ctx.db.insert("dtsTodos", {
    statement,
    brief: `the brief for ${statement}`,
    readiness: "prepared",
    status: "active",
    actor: "agent",
    timingClass: "whenever",
    source: "test",
    createdAt: UPDATED,
    updatedAt: UPDATED,
    ...fields,
  } as never);
  await follow(ctx, "todos", old);
  const ids: Id<"rulings">[] = [];
  for (const r of rulings) {
    ids.push(
      await ctx.db.insert("rulings", {
        subjectType: "life",
        todoId: old,
        verdict: r.verdict,
        ruledAt: r.at,
        ...(r.sentence === undefined ? {} : { sentence: r.sentence }),
      }),
    );
  }
  return { old, plain: (await resolveId(ctx, "todos", old))!, rulings: ids };
}

async function workQueue(t: T) {
  vi.stubEnv("JARVIS_KEY", KEY["X-Jarvis-Key"]);
  const res = await t.fetch("/jarvis/context?for=work-queue", { headers: KEY });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    todos: {
      id: string;
      title: string;
      brief: string;
      entryAction: string | null;
      workDescription: string | null;
      doneWhen: string | null;
      mustNotBreak: string | null;
      approve: { rulingId: string; sentence: string | null };
    }[];
  };
}

/** The work queue's outcome on a todo, as the box posts it. */
async function outcome(t: T, subject: string, rulingId: string | undefined, result: string, at: number) {
  vi.stubEnv("JARVIS_KEY", KEY["X-Jarvis-Key"]);
  return await t.fetch("/jarvis/event", {
    method: "POST",
    headers: { ...KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "session-outcome",
      at,
      provenance: { job: "work-queue" },
      subject,
      data: { job: "work-queue", outcome: result, summary: "s", ...(rulingId === undefined ? {} : { rulingId }) },
    }),
  });
}

describe("GET /jarvis/context?for=work-queue", () => {
  it("serves an eligible todo with its plain id, title, the whole prepared instruction and Tom's approve, sentence verbatim", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    const [one, bare] = await t.run(async (ctx) => [
      await todo(
        ctx,
        "file the lease",
        {
          entryAction: "open the landlord's email",
          workDescription: "fill the form and send it",
          condition: "the landlord has the signed form",
          mustNotBreak: "never sign for Tom",
        },
        [{ verdict: "approve", at: UPDATED + 1000, sentence: "Do it before Friday, not after." }],
      ),
      await todo(ctx, "the bare one", { updatedAt: UPDATED + 10 }, [{ verdict: "approve", at: UPDATED + 1000 }]),
    ]);
    expect(await workQueue(t)).toEqual({
      todos: [
        {
          id: one.plain,
          title: "file the lease",
          brief: "the brief for file the lease",
          entryAction: "open the landlord's email",
          workDescription: "fill the form and send it",
          doneWhen: "the landlord has the signed form",
          mustNotBreak: "never sign for Tom",
          approve: { rulingId: one.rulings[0], sentence: "Do it before Friday, not after." },
        },
        {
          id: bare.plain,
          title: "the bare one",
          brief: "the brief for the bare one",
          entryAction: null,
          workDescription: null,
          doneWhen: null,
          mustNotBreak: null,
          approve: { rulingId: bare.rulings[0], sentence: null },
        },
      ],
    });
  });

  it("leaves out a todo worked under its approve: for good once completed, a day after an errored run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    const rows = await t.run(async (ctx) => ({
      completed: await todo(ctx, "completed long ago"),
      errored: await todo(ctx, "errored an hour ago"),
      stale: await todo(ctx, "errored two days ago"),
      other: await todo(ctx, "completed under an older approve", {}, [
        { verdict: "approve", at: UPDATED - 5000 },
        { verdict: "approve", at: UPDATED + 1000 },
      ]),
      unkeyed: await todo(ctx, "an outcome naming no ruling"),
    }));
    // Either id form of the todo is taken.
    expect((await outcome(t, rows.completed.old, rows.completed.rulings[0], "completed", NOW - 30 * DAY)).status).toBe(200);
    expect((await outcome(t, rows.errored.plain, rows.errored.rulings[0], "errored", NOW - 3_600_000)).status).toBe(200);
    expect((await outcome(t, rows.stale.plain, rows.stale.rulings[0], "errored", NOW - 2 * DAY)).status).toBe(200);
    expect((await outcome(t, rows.other.plain, rows.other.rulings[0], "completed", NOW - DAY)).status).toBe(200);
    expect((await outcome(t, rows.unkeyed.plain, undefined, "completed", NOW - DAY)).status).toBe(200);
    const refused = await outcome(t, rows.unkeyed.plain, "not-a-ruling", "completed", NOW);
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe("a session-outcome event's data.rulingId names no ruling");
    expect((await workQueue(t)).todos.map((row) => row.title).sort()).toEqual([
      "an outcome naming no ruling",
      "completed under an older approve",
      "errored two days ago",
    ]);
    // The day passes: the errored one is offered again; the completed never.
    vi.setSystemTime(NOW + DAY);
    expect((await workQueue(t)).todos.map((row) => row.title)).toContain("errored an hour ago");
    expect((await workQueue(t)).todos.map((row) => row.title)).not.toContain("completed long ago");
  });

  it("leaves out every todo one of the rules excludes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await todo(ctx, "done already", { status: "done" });
      await todo(ctx, "archived", { status: "archived" });
      await todo(ctx, "asleep", { wakeAt: NOW + DAY });
      const blocker = await todo(ctx, "the blocker, Tom's", { actor: "tom" });
      await todo(ctx, "blocked", { needs: [blocker.old] });
      await todo(ctx, "raw", { readiness: "unprepared" });
      await todo(ctx, "Tom's own", { actor: "tom" });
      await todo(ctx, "no actor", { actor: undefined });
      await todo(ctx, "changed since the approve", {}, [{ verdict: "approve", at: UPDATED - 1000 }]);
      await todo(ctx, "approved the instant it changed", {}, [{ verdict: "approve", at: UPDATED }]);
      await todo(ctx, "wants a session", {}, [{ verdict: "session", at: UPDATED + 1000 }]);
      await todo(ctx, "archive ruled", {}, [{ verdict: "archive", at: UPDATED + 1000 }]);
      await todo(ctx, "revise ruled", {}, [{ verdict: "revise", at: UPDATED + 1000, sentence: "Redo the brief." }]);
      await todo(ctx, "approve, then session", {}, [
        { verdict: "approve", at: UPDATED + 1000 },
        { verdict: "session", at: UPDATED + 2000 },
      ]);
      await todo(ctx, "never ruled", {}, []);
      await todo(ctx, "no brief", { brief: undefined });
      await todo(ctx, "a blank brief", { brief: "   " });
    });
    expect((await workQueue(t)).todos).toEqual([]);
  });

  it("orders by need: dated soonest due first, then the rest stalest first; a done need does not block", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const need = await todo(ctx, "the need, done", { status: "done" });
      await todo(ctx, "fresh", { updatedAt: UPDATED - 10 });
      await todo(ctx, "due later", { timingClass: "dated", dueAt: NOW + 3 * DAY });
      await todo(ctx, "stale", { updatedAt: UPDATED - 1000, needs: [need.old] });
      await todo(ctx, "due soon", { timingClass: "dated", dueAt: NOW + DAY });
    });
    expect((await workQueue(t)).todos.map((row) => row.title)).toEqual(["due soon", "due later", "stale", "fresh"]);
  });
});
