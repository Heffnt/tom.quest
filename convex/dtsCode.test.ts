import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function withTom(t: ReturnType<typeof convexTest>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}

const brief = (over: Partial<{
  repo: string;
  externalId: string;
  sourceHash: string;
  brief: string;
  recommendation: "approve" | "needs-session" | "propose-archive" | "stale-replan";
  execClass: "box" | "needs-turing";
  evidence: string;
}> = {}) => ({
  repo: "ComplexMultiTrigger",
  externalId: "cmt-001",
  sourceHash: "hash-a",
  brief: "# Ground-up brief\nwhat, why, how",
  recommendation: "approve" as const,
  execClass: "box" as const,
  ...over,
});

describe("DTS code-todo ruling loop", () => {
  // witness: remove the requireTom call from listCodeBriefs in convex/dtsCode.ts
  it("gates every Tom-facing function on the tom role", async () => {
    const t = convexTest({ schema, modules });
    await expect(t.query(api.dtsCode.listCodeBriefs, {})).rejects.toThrow();
    await expect(t.query(api.dtsCode.listCodeRulings, {})).rejects.toThrow();
    await expect(
      t.mutation(api.dtsCode.recordCodeRuling, {
        repo: "r",
        externalId: "x",
        ruling: "approve",
      }),
    ).rejects.toThrow();
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "u", email: "u@tom.quest", role: "user" }),
    );
    const user = t.withIdentity({ subject: userId });
    await expect(user.query(api.dtsCode.listCodeBriefs, {})).rejects.toThrow();
    await expect(
      user.mutation(api.dtsCode.recordCodeRuling, {
        repo: "r",
        externalId: "x",
        ruling: "approve",
      }),
    ).rejects.toThrow();
  });

  // witness: drop the logEvent call from recordCodeRuling in convex/dtsCode.ts
  it("records a ruling, lists it, and instruments it", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.dtsCode.recordCodeRuling, {
      repo: "ComplexMultiTrigger",
      externalId: "cmt-001",
      ruling: "needs-session",
      note: "walk me through the judge change first",
    });
    const rulings = await tom.query(api.dtsCode.listCodeRulings, {});
    expect(rulings).toHaveLength(1);
    expect(rulings[0]._id).toBe(id);
    expect(rulings[0].ruling).toBe("needs-session");
    expect(rulings[0].note).toBe("walk me through the judge change first");
    expect(rulings[0].ruledAt).toBeDefined();
    expect(rulings[0].appliedAt).toBeUndefined();
    const events = await tom.query(api.dts.listRecentEvents, {});
    const event = events.find((e) => e.kind === "code-ruling");
    expect(event).toBeDefined();
    expect(event?.data).toMatchObject({
      repo: "ComplexMultiTrigger",
      externalId: "cmt-001",
      ruling: "needs-session",
    });
  });

  // witness: change internalStoreBriefs's patch branch to insert in convex/dtsCode.ts
  it("upserts briefs by (repo, externalId) — a re-brief replaces, not duplicates", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.dtsCode.internalStoreBriefs, {
      briefs: [brief(), brief({ externalId: "cmt-002", recommendation: "propose-archive", evidence: "commit abc123 closed this" })],
    });
    await t.mutation(internal.dtsCode.internalStoreBriefs, {
      briefs: [brief({ sourceHash: "hash-b", brief: "rewritten after upstream edit" })],
    });
    const rows = await t.run(async (ctx) => ctx.db.query("dtsCodeBriefs").collect());
    expect(rows).toHaveLength(2); // cmt-001 overwritten in place, cmt-002 untouched
    const first = rows.find((r) => r.externalId === "cmt-001");
    expect(first?.sourceHash).toBe("hash-b");
    expect(first?.brief).toBe("rewritten after upstream edit");
    const second = rows.find((r) => r.externalId === "cmt-002");
    expect(second?.evidence).toBe("commit abc123 closed this");
    const events = await tom.query(api.dts.listRecentEvents, {});
    const briefed = events.filter((e) => e.kind === "code-briefed");
    expect(briefed).toHaveLength(2); // one event per batch, not per row
    expect(briefed.some((e) => (e.data as { count: number }).count === 2)).toBe(true);
  });

  // witness: drop the `newest.get(...)?._id === row._id` clause from
  // internalPendingRulings in convex/dtsCode.ts
  it("pending rulings exclude applied AND superseded rows", async () => {
    const t = convexTest({ schema, modules });
    const base = Date.now();
    const insert = (fields: {
      externalId: string;
      ruledAt: number;
      ruling?: "approve" | "defer";
      appliedAt?: number;
      applyResult?: string;
    }) =>
      t.run(async (ctx) =>
        ctx.db.insert("dtsCodeRulings", {
          repo: "ComplexMultiTrigger",
          ruling: "approve",
          ...fields,
        }),
      );
    // Item a: one unapplied ruling — pending.
    const liveId = await insert({ externalId: "a", ruledAt: base });
    // Item b: already applied — not pending.
    await insert({
      externalId: "b",
      ruledAt: base,
      appliedAt: base + 1,
      applyResult: "sha deadbeef",
    });
    // Item c: an older unapplied ruling superseded by a newer sibling — only
    // the newest is live; the old one must never be executed.
    await insert({ externalId: "c", ruledAt: base - 1000, ruling: "approve" });
    const newerId = await insert({
      externalId: "c",
      ruledAt: base,
      ruling: "defer",
    });
    const pending = await t.query(internal.dtsCode.internalPendingRulings, {});
    expect(pending.map((r) => r._id).sort()).toEqual([liveId, newerId].sort());
    // Rows carry _id for the apply callback.
    expect(pending.every((r) => typeof r._id === "string")).toBe(true);
  });

  // witness: replace `normalized` with the raw string id in
  // internalMarkRulingApplied's patch call in convex/dtsCode.ts
  it("marks a ruling applied and rejects a bad id by name", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.dtsCode.recordCodeRuling, {
      repo: "tom.quest",
      externalId: "tq-004",
      ruling: "approve",
    });
    await t.mutation(internal.dtsCode.internalMarkRulingApplied, {
      id,
      result: "https://github.com/Heffnt/tom.quest/pull/99",
    });
    const [row] = await tom.query(api.dtsCode.listCodeRulings, {});
    expect(row.appliedAt).toBeDefined();
    expect(row.applyResult).toBe("https://github.com/Heffnt/tom.quest/pull/99");
    const events = await tom.query(api.dts.listRecentEvents, {});
    expect(events.some((e) => e.kind === "code-ruling-applied")).toBe(true);
    // A malformed id is rejected by name, applied rows untouched.
    await expect(
      t.mutation(internal.dtsCode.internalMarkRulingApplied, {
        id: "not-a-real-id",
        result: "x",
      }),
    ).rejects.toThrow(/Unknown ruling id/);
  });

  // witness: count ALL briefs (drop the `!ruled.has` filter) in
  // internalAwaitingRulingCount in convex/dtsCode.ts
  it("awaiting-ruling count covers briefed items with no ruling at all", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.dtsCode.internalStoreBriefs, {
      briefs: [
        brief({ externalId: "ruled" }),
        brief({ externalId: "unruled-1" }),
        brief({ externalId: "unruled-2" }),
      ],
    });
    expect(
      await t.query(internal.dtsCode.internalAwaitingRulingCount, {}),
    ).toBe(3);
    // Any ruling — even "defer", even unapplied — takes the item off the pile.
    await tom.mutation(api.dtsCode.recordCodeRuling, {
      repo: "ComplexMultiTrigger",
      externalId: "ruled",
      ruling: "defer",
    });
    expect(
      await t.query(internal.dtsCode.internalAwaitingRulingCount, {}),
    ).toBe(2);
    // A ruling on an item from ANOTHER repo with the same externalId does not
    // count (the key is the (repo, externalId) pair).
    await tom.mutation(api.dtsCode.recordCodeRuling, {
      repo: "tom.quest",
      externalId: "unruled-1",
      ruling: "approve",
    });
    expect(
      await t.query(internal.dtsCode.internalAwaitingRulingCount, {}),
    ).toBe(2);
  });
});
