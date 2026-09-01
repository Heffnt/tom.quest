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

// Rulings moved to the unified ttsRulings table (ttsRulings.test.ts); this
// file covers what remains in ttsCode.ts — the brief store.
describe("TTS code-todo briefs", () => {
  // witness: remove the requireTom call from listCodeBriefs in convex/ttsCode.ts
  it("gates listCodeBriefs on the tom role", async () => {
    const t = convexTest({ schema, modules });
    await expect(t.query(api.ttsCode.listCodeBriefs, {})).rejects.toThrow();
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "u", email: "u@tom.quest", role: "user" }),
    );
    const user = t.withIdentity({ subject: userId });
    await expect(user.query(api.ttsCode.listCodeBriefs, {})).rejects.toThrow();
  });

  // witness: change internalStoreBriefs's patch branch to insert in convex/ttsCode.ts
  it("upserts briefs by (repo, externalId) — a re-brief replaces, not duplicates", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [brief(), brief({ externalId: "cmt-002", recommendation: "propose-archive", evidence: "commit abc123 closed this" })],
    });
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [brief({ sourceHash: "hash-b", brief: "rewritten after upstream edit" })],
    });
    const rows = await tom.query(api.ttsCode.listCodeBriefs, {});
    expect(rows).toHaveLength(2); // cmt-001 overwritten in place, cmt-002 untouched
    const first = rows.find((r) => r.externalId === "cmt-001");
    expect(first?.sourceHash).toBe("hash-b");
    expect(first?.brief).toBe("rewritten after upstream edit");
    const second = rows.find((r) => r.externalId === "cmt-002");
    expect(second?.evidence).toBe("commit abc123 closed this");
    const events = await tom.query(api.tts.listRecentEvents, {});
    const briefed = events.filter((e) => e.kind === "code-briefed");
    expect(briefed).toHaveLength(2); // one event per batch, not per row
    expect(briefed.some((e) => (e.data as { count: number }).count === 2)).toBe(true);
  });

  // Importance is RETIRED (Tom's ruling 2026-08-29, "no importance guesses").
  // witness: give internalStoreBriefs an importance arg again in
  // convex/ttsCode.ts and write it — a stored brief would carry a rating.
  it("stores no importance: the retired field stays absent on every brief", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [brief()],
    });
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [brief({ sourceHash: "hash-b" })],
    });
    const [row] = await tom.query(api.ttsCode.listCodeBriefs, {});
    expect(row.sourceHash).toBe("hash-b"); // the re-brief itself landed
    expect(row.importance).toBeUndefined();
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(events.some((e) => e.kind === "importance-skipped")).toBe(false);
  });

  it("internalListBriefs returns every stored brief for the worker", async () => {
    const t = convexTest({ schema, modules });
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [brief(), brief({ repo: "tom.quest", externalId: "tq-001", execClass: "needs-turing" })],
    });
    const rows = await t.query(internal.ttsCode.internalListBriefs, {});
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.preparedAt !== undefined)).toBe(true);
  });
});
