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

// Rulings moved to the unified dtsRulings table (dtsRulings.test.ts); this
// file covers what remains in dtsCode.ts — the brief store.
describe("DTS code-todo briefs", () => {
  // witness: remove the requireTom call from listCodeBriefs in convex/dtsCode.ts
  it("gates listCodeBriefs on the tom role", async () => {
    const t = convexTest({ schema, modules });
    await expect(t.query(api.dtsCode.listCodeBriefs, {})).rejects.toThrow();
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "u", email: "u@tom.quest", role: "user" }),
    );
    const user = t.withIdentity({ subject: userId });
    await expect(user.query(api.dtsCode.listCodeBriefs, {})).rejects.toThrow();
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
    const rows = await tom.query(api.dtsCode.listCodeBriefs, {});
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

  // witness: drop the setBy-"tom" guard from internalStoreBriefs in
  // convex/dtsCode.ts — a re-brief would overwrite Tom's ruling on importance.
  it("briefs carry agent importance; Tom's override survives a re-brief", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.dtsCode.internalStoreBriefs, {
      briefs: [
        { ...brief(), importanceLevel: "medium", importanceRationale: "blocks the campaign" },
      ],
    });
    let [row] = await tom.query(api.dtsCode.listCodeBriefs, {});
    expect(row.importance).toMatchObject({
      level: "medium",
      setBy: "agent",
      rationale: "blocks the campaign",
    });
    await tom.mutation(api.dtsCode.setCodeImportance, {
      repo: "ComplexMultiTrigger",
      externalId: "cmt-001",
      level: "high",
    });
    await t.mutation(internal.dtsCode.internalStoreBriefs, {
      briefs: [{ ...brief({ sourceHash: "hash-b" }), importanceLevel: "low" }],
    });
    [row] = await tom.query(api.dtsCode.listCodeBriefs, {});
    expect(row.sourceHash).toBe("hash-b"); // the re-brief itself landed
    expect(row.importance).toMatchObject({ level: "high", setBy: "tom" });
    const events = await tom.query(api.dts.listRecentEvents, {});
    expect(events.some((e) => e.kind === "importance-skipped")).toBe(true);
  });

  // witness: make dts.agentImportancePatch return undefined for an existing
  // AGENT value too — the shared guard blocks only Tom's, so a re-brief must
  // still be able to revise the agent's own estimate.
  it("a re-brief revises the agent's OWN importance (and clears when Tom clears)", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.dtsCode.internalStoreBriefs, {
      briefs: [{ ...brief(), importanceLevel: "low" }],
    });
    await t.mutation(internal.dtsCode.internalStoreBriefs, {
      briefs: [
        {
          ...brief({ sourceHash: "hash-b" }),
          importanceLevel: "high",
          importanceRationale: "now blocks the campaign",
        },
      ],
    });
    let [row] = await tom.query(api.dtsCode.listCodeBriefs, {});
    expect(row.importance).toMatchObject({
      level: "high",
      setBy: "agent",
      rationale: "now blocks the campaign",
    });
    // Tom rules, then clears: the agent may write again.
    await tom.mutation(api.dtsCode.setCodeImportance, {
      repo: "ComplexMultiTrigger",
      externalId: "cmt-001",
      level: "low",
    });
    await tom.mutation(api.dtsCode.setCodeImportance, {
      repo: "ComplexMultiTrigger",
      externalId: "cmt-001",
      level: null,
    });
    await t.mutation(internal.dtsCode.internalStoreBriefs, {
      briefs: [{ ...brief({ sourceHash: "hash-c" }), importanceLevel: "medium" }],
    });
    [row] = await tom.query(api.dtsCode.listCodeBriefs, {});
    expect(row.importance).toMatchObject({ level: "medium", setBy: "agent" });
  });

  it("setCodeImportance writes setBy tom, clears on null, names a missing brief", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.dtsCode.internalStoreBriefs, { briefs: [brief()] });
    await tom.mutation(api.dtsCode.setCodeImportance, {
      repo: "ComplexMultiTrigger",
      externalId: "cmt-001",
      level: "low",
    });
    let [row] = await tom.query(api.dtsCode.listCodeBriefs, {});
    expect(row.importance).toMatchObject({ level: "low", setBy: "tom" });
    await tom.mutation(api.dtsCode.setCodeImportance, {
      repo: "ComplexMultiTrigger",
      externalId: "cmt-001",
      level: null,
    });
    [row] = await tom.query(api.dtsCode.listCodeBriefs, {});
    expect(row.importance).toBeUndefined();
    await expect(
      tom.mutation(api.dtsCode.setCodeImportance, {
        repo: "ComplexMultiTrigger",
        externalId: "no-such-item",
        level: "low",
      }),
    ).rejects.toThrow(/not found/);
  });

  it("internalListBriefs returns every stored brief for the worker", async () => {
    const t = convexTest({ schema, modules });
    await t.mutation(internal.dtsCode.internalStoreBriefs, {
      briefs: [brief(), brief({ repo: "tom.quest", externalId: "tq-001", execClass: "needs-turing" })],
    });
    const rows = await t.query(internal.dtsCode.internalListBriefs, {});
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.preparedAt !== undefined)).toBe(true);
  });
});
