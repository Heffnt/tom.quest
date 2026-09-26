import { convexTest } from "convex-test";
import { beforeAll, describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { resolveId } from "./jarvis/tables";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

/** Run the copy to the end, one page at a time, as the chained copy does. */
async function copyAll(t: ReturnType<typeof convexTest>) {
  let cursor: string | null = null;
  for (;;) {
    const page: { isDone: boolean; continueCursor: string } = await t.mutation(internal.jarvis.tables.copy, {
      cursor,
      pageSize: 2,
      chain: false,
    });
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
}

const todo = {
  statement: "a todo",
  readiness: "unprepared" as const,
  status: "active" as const,
  timingClass: "whenever" as const,
  source: "test",
  createdAt: 1,
  updatedAt: 1,
};

describe("the rulings copy", () => {
  it("copies every field, keeps the old id and the todo it names, and a second run changes nothing", async () => {
    const t = convexTest({ schema, modules });
    const ids = await t.run(async (ctx) => {
      const b = await ctx.db.insert("dtsTodos", todo);
      const r = await ctx.db.insert("dtsRulings", { subjectType: "life", todoId: b, verdict: "archive", ruledAt: 5 });
      const s = await ctx.db.insert("dtsRulings", { subjectType: "code", repo: "tom.quest", externalId: "x", verdict: "approve", ruledAt: 6 });
      const u = await ctx.db.insert("dtsRulings", { subjectType: "life", todoId: b, verdict: "revise", sentence: "later", ruledAt: 7 });
      return { b, r, s, u };
    });
    await copyAll(t);
    await copyAll(t);
    const rulings = await t.run(async (ctx) => ctx.db.query("rulings").collect());
    expect(rulings).toHaveLength(3);
    // The ruling names its todo as it did: rulings name dtsTodos until todos move.
    expect(rulings.find((row) => row.legacyId === ids.r)).toMatchObject({ todoId: ids.b, verdict: "archive", ruledAt: 5 });
    expect(await t.action(internal.jarvis.tables.counts, {})).toEqual({ rulings: { old: 3, new: 3, copied: 3, whole: true } });
  });

  it("points a ruling's labels at its new id", async () => {
    const t = convexTest({ schema, modules });
    const old = await t.run(async (ctx) => {
      const r = await ctx.db.insert("dtsRulings", { subjectType: "life", verdict: "archive", ruledAt: 1 });
      await ctx.db.insert("runLabels", {
        runId: "run", source: "ruling", actor: "tom", polarity: "good", meaning: "m", judgment: true, ref: `ruling:${r}`, at: 1,
      } as never);
      return r;
    });
    await copyAll(t);
    expect(await t.mutation(internal.jarvis.tables.remapRulingRefs, {})).toEqual({ labels: 1 });
    const { ruling, label } = await t.run(async (ctx) => ({
      ruling: (await ctx.db.query("rulings").collect())[0],
      label: (await ctx.db.query("runLabels").collect())[0],
    }));
    expect(ruling.legacyId).toBe(old);
    expect(label.ref).toBe(`ruling:${ruling._id}`);
  });

  it("patches a copied ruling from a newer old row, never from an older one", async () => {
    const t = convexTest({ schema, modules });
    const r = await t.run(async (ctx) => ctx.db.insert("dtsRulings", { subjectType: "life", verdict: "approve", ruledAt: 10 }));
    await copyAll(t);
    // The old code applied it after the first copy: the second copy brings it.
    await t.run(async (ctx) => ctx.db.patch(r, { appliedAt: 20 }));
    await copyAll(t);
    const copied = await t.run(async (ctx) => (await ctx.db.query("rulings").collect())[0]);
    expect(copied.appliedAt).toBe(20);
    // The new code wrote since: a later copy leaves it.
    await t.run(async (ctx) => ctx.db.patch(copied._id, { sentence: "new code's note", appliedAt: 30 }));
    await copyAll(t);
    expect((await t.run(async (ctx) => (await ctx.db.query("rulings").collect())[0])).sentence).toBe("new code's note");
  });

  it("resolves a ruling by its new id or the id it had before the rename", async () => {
    const t = convexTest({ schema, modules });
    const old = await t.run(async (ctx) => ctx.db.insert("dtsRulings", { subjectType: "life", verdict: "archive", ruledAt: 1 }));
    await copyAll(t);
    await t.run(async (ctx) => {
      const copied = (await ctx.db.query("rulings").collect())[0];
      expect(await resolveId(ctx, "rulings", old)).toBe(copied._id);
      expect(await resolveId(ctx, "rulings", copied._id)).toBe(copied._id);
      expect(await resolveId(ctx, "rulings", "not-an-id")).toBeNull();
      const other = await ctx.db.insert("dtsTodos", todo);
      expect(await resolveId(ctx, "rulings", other as unknown as Id<"rulings">)).toBeNull();
    });
  });

  // The todos, blocks and timeNotes switch is its own pull request with a
  // faithful sync; this stack's copy takes no other table.
  it("copies rulings and no other table", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsTodos", todo);
    });
    await copyAll(t);
    expect(await t.run(async (ctx) => ctx.db.query("todos").collect())).toEqual([]);
    expect(Object.keys(await t.action(internal.jarvis.tables.counts, {}))).toEqual(["rulings"]);
  });
});
