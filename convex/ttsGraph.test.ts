import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  MAX_NEEDS,
  buildDoneSet,
  frontier,
  isPrepared,
  isReady,
  isReadyForTom,
  normalizeReadiness,
} from "./ttsShared";

// The todo graph: todos wired by `needs`, and the ones whose needs are all
// done are "ready". Batches, which grouped todos into graphs, went with Tom's
// ruling of 2026-09-24 ("I dont want to have batches at all anymore"); `needs`
// and the ready rule stayed, and so did the worker pen that closes a todo.

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function withTom(t: ReturnType<typeof convexTest>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}

// ── The graph rules (convex/ttsShared.ts — the ONE home) ─────────────────────

describe("ttsShared graph rules", () => {
  const NOW = Date.UTC(2026, 8, 5, 12);
  const todo = (
    _id: string,
    status: Doc<"todos">["status"],
    needs?: string[],
    wakeAt?: number,
  ) => ({ _id, status, needs, wakeAt });

  // witness: change isReady to ignore `needs` in convex/ttsShared.ts — every
  // blocked todo would report ready and the frontier would be the whole batch.
  it("ready = active AND every need done", () => {
    const rows = [
      todo("a", "done"),
      todo("b", "active", ["a"]),
      todo("c", "active", ["b"]),
    ];
    const done = buildDoneSet(rows);
    expect(isReady(rows[1], done, NOW)).toBe(true);
    expect(isReady(rows[2], done, NOW)).toBe(false);
    // No needs at all: ready the moment it is active.
    expect(isReady(todo("d", "active"), done, NOW)).toBe(true);
    // EVERY need, not some: one unmet need is enough to block.
    expect(isReady(todo("e", "active", ["a", "b"]), done, NOW)).toBe(false);
  });

  // witness: drop "archived" from buildDoneSet — a set-aside need would block
  // the rest of its graph forever.
  it("archived counts as done, matching memberProgress", () => {
    const rows = [todo("a", "archived"), todo("b", "active", ["a"])];
    expect(buildDoneSet(rows)).toEqual(new Set(["a"]));
    expect(isReady(rows[1], buildDoneSet(rows), NOW)).toBe(true);
  });

  // witness: let isReady accept status "waiting" — a sleeping todo would be
  // offered as ready work.
  it("waiting, done, and archived todos are never ready", () => {
    const done = new Set<string>();
    expect(isReady(todo("a", "waiting"), done, NOW)).toBe(false);
    expect(isReady(todo("b", "done"), done, NOW)).toBe(false);
    expect(isReady(todo("c", "archived"), done, NOW)).toBe(false);
  });

  // witness: drop wakeAtPassed from isReady — an active row put to sleep by
  // the lifeos migration (waiting → active + wakeAt) would be offered as
  // ready work before its wake time.
  it("an active row whose wakeAt is ahead is asleep, not ready", () => {
    const done = new Set<string>();
    expect(isReady(todo("a", "active", [], NOW + 1), done, NOW)).toBe(false);
    expect(isReady(todo("b", "active", [], NOW), done, NOW)).toBe(true);
    expect(isReady(todo("c", "active", [], NOW - 1), done, NOW)).toBe(true);
  });

  it("frontier is the ready list, in the order given", () => {
    const rows = [
      todo("a", "done"),
      todo("b", "active", ["a"]),
      todo("c", "active", ["b"]),
      todo("d", "waiting"),
      todo("e", "active"),
      todo("f", "active", [], NOW + 60_000),
    ];
    expect(frontier(rows, NOW).map((r) => r._id)).toEqual(["b", "e"]);
  });

  // ── Readiness, two values (ruling 18) ──────────────────────────────────────
  // One reading per stored spelling. "ready-for-tom" was a finished write-up;
  // "preparing" was a half-finished one, and a half-prepared capture is never
  // ready — it reads as unprepared so the preparer picks it up again.
  it("ready-for-tom reads as prepared, preparing as unprepared", () => {
    expect(normalizeReadiness("unprepared")).toBe("unprepared");
    expect(normalizeReadiness("prepared")).toBe("prepared");
    expect(normalizeReadiness("preparing")).toBe("unprepared");
    expect(normalizeReadiness("ready-for-tom")).toBe("prepared");
    expect(isPrepared("unprepared")).toBe(false);
    expect(isPrepared("preparing")).toBe(false);
    expect(isPrepared("ready-for-tom")).toBe(true);
  });

  // witness: drop any one of the four conjuncts from isReadyForTom — a raw
  // capture, a sleeping row, a blocked row, or a done row would be listed as
  // ready for Tom.
  it("ready for Tom = prepared, active, awake, every need done", () => {
    const rows = [
      { ...todo("a", "done"), readiness: "prepared" as const },
      { ...todo("b", "active", ["a"]), readiness: "prepared" as const },
      { ...todo("c", "active", ["a"]), readiness: "unprepared" as const },
      { ...todo("d", "active", ["b"]), readiness: "prepared" as const },
      { ...todo("e", "active", [], NOW + 1), readiness: "prepared" as const },
      { ...todo("f", "waiting"), readiness: "prepared" as const },
      { ...todo("g", "active"), readiness: "ready-for-tom" as const },
    ];
    const done = buildDoneSet(rows);
    const ready = rows.filter((r) => isReadyForTom(r, done, NOW)).map((r) => r._id);
    expect(ready).toEqual(["b", "g"]);
  });

  it("bounds a todo's fan-in", () => {
    expect(MAX_NEEDS).toBe(10);
  });
});


// ── The worker pen's completion (tts.internalPrepareTodo status "done") ─────

describe("TTS worker pen: closing a todo", () => {
  const skips = async (t: ReturnType<typeof convexTest>) =>
    (await t.run(async (ctx) => ctx.db.query("dtsEvents").collect()))
      .filter((e) => e.kind === "done-skipped")
      .map((e) => (e.data as { why: string }).why);
  const statusOf = async (t: ReturnType<typeof convexTest>, id: Id<"todos">) =>
    (await t.run(async (ctx) => ctx.db.get(id)))?.status;

  // witness: put back the bar "only a todo inside a batch may be completed by
  // the pen" — with no batches, this standalone todo stays active and no agent
  // could complete anything, the opposite of Tom's ruling of 2026-09-24.
  it("closes a standalone todo Tom has not ruled on, once its evidence is recorded", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, { statement: "draft the landlord questions" });
    await t.mutation(internal.tts.internalPrepareTodo, {
      id,
      status: "done",
      evidence: "questions.md, eight questions",
    });
    expect(await statusOf(t, id)).toBe("done");
    expect(await skips(t)).toEqual([]);
  });

  // witness: drop the evidence bar — a bare status write would close one of
  // Tom's todos with nothing recorded to show the work happened.
  it("refuses to close a todo with no evidence recorded", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, { statement: "draft the landlord questions" });
    await t.mutation(internal.tts.internalPrepareTodo, { id, status: "done" });
    expect(await statusOf(t, id)).toBe("active");
    expect(await skips(t)).toEqual([
      "a todo is completed by the pen only with its evidence recorded",
    ]);
    // Evidence written in an earlier call counts: the bar reads the row.
    await t.mutation(internal.tts.internalPrepareTodo, { id, evidence: "questions.md" });
    await t.mutation(internal.tts.internalPrepareTodo, { id, status: "done" });
    expect(await statusOf(t, id)).toBe("done");
  });

  it("refuses a frozen task and an uncheckable goal, and closes a checkable goal", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);

    // A task Tom has ruled on.
    const task = await tom.mutation(api.tts.createTodo, { statement: "call the landlord" });
    await t.run(async (ctx) => ctx.db.patch(task, { kind: "task", tomTouchedAt: Date.now() }));
    await t.mutation(internal.tts.internalPrepareTodo, { id: task, status: "done", evidence: "e" });
    expect(await statusOf(t, task)).toBe("active");
    expect(await skips(t)).toEqual([
      "Tom-touched (frozen) — only he closes a row he has ruled on",
    ]);

    // A goal with no condition and no code subject: nothing to check.
    const triggerGoal = await tom.mutation(api.tts.createTodo, { statement: "renew the apartment lease" });
    await t.run(async (ctx) => ctx.db.patch(triggerGoal, { kind: "goal" }));
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: triggerGoal,
      status: "done",
      evidence: "the paperwork arrived",
    });
    expect(await statusOf(t, triggerGoal)).toBe("active");
    expect((await skips(t))[1]).toMatch(/checkable condition/);

    // A CHECKABLE goal is the one thing an agent may close on a Tom-touched
    // row: its condition, not a judgment, decides it.
    const realGoal = await tom.mutation(api.tts.createTodo, { statement: "the lease is signed" });
    await t.run(async (ctx) =>
      ctx.db.patch(realGoal, {
        kind: "goal",
        condition: "the signed lease is in the folder",
        tomTouchedAt: Date.now(),
      }),
    );
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: realGoal,
      status: "done",
      evidence: "lease.pdf, signed both sides",
    });
    expect(await statusOf(t, realGoal)).toBe("done");
  });

});
