import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const brief = (over: Partial<{
  repo: string;
  externalId: string;
  sourceHash: string;
  brief: string;
  recommendation: "approve" | "revise" | "session" | "archive";
  execClass: "box" | "needs-turing";
  evidence: string;
  doorFaults: string[];
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
// file covers what remains in ttsCode.ts — reading the stored briefs.
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

  it("internalListBriefs returns every stored brief for the worker", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      for (const row of [brief(), brief({ repo: "tom.quest", externalId: "tq-001", execClass: "needs-turing" })]) {
        await ctx.db.insert("dtsCodeBriefs", { ...row, preparedAt: Date.now() });
      }
    });
    const rows = await t.query(internal.ttsCode.internalListBriefs, {});
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.preparedAt !== undefined)).toBe(true);
  });
});
