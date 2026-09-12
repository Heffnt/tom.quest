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
      briefs: [brief(), brief({ externalId: "cmt-002", recommendation: "archive", evidence: "commit abc123 closed this" })],
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
    expect(second?.recommendation).toBe("archive");
    const events = await tom.query(api.tts.listRecentEvents, {});
    const briefed = events.filter((e) => e.kind === "code-briefed");
    expect(briefed).toHaveLength(2); // one event per batch, not per row
    expect(briefed.some((e) => (e.data as { count: number }).count === 2)).toBe(true);
  });

  // witness: drop the upsert and insert a second row — the page would show
  // two briefs for one code todo and the fresher one would not be findable.
  // (The importance guard that stood alongside this is gone with the field:
  // the lifeos update dropped it from the dtsCodeBriefs validator, so the
  // schema itself now refuses a rating.)
  it("re-briefing one code todo replaces the row rather than adding one", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [brief()],
    });
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [brief({ sourceHash: "hash-b" })],
    });
    const rows = await tom.query(api.ttsCode.listCodeBriefs, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceHash).toBe("hash-b"); // the re-brief itself landed
  });

  // ── The door check's mark ─────────────────────────────────────────────────
  // The planner reads its own brief against the writing standard and retries
  // once; a brief that fails both attempts is posted anyway and carries the
  // complaints (Tom, 2026-09-12) — withholding it would leave the PREVIOUS
  // brief standing under an entry that has since changed.

  // witness: drop `doorFaults` from the row in internalStoreBriefs and the
  // first assertion goes red; spread it conditionally, the way
  // producedByRunToken is spread, and the LAST one does — a clean re-brief
  // would keep the refused brief's mark under text the door passed.
  it("the door mark round-trips through the upsert, and a passing re-brief clears it", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const fault = "brief: brief-markup — a brief is prose — no heading, list, or code fence";
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [brief({ brief: "# Plan\nIt is stale. Rewrite it.", doorFaults: [fault] })],
    });
    let [row] = await tom.query(api.ttsCode.listCodeBriefs, {});
    expect(row.doorFaults).toEqual([fault]);

    // A brief that never failed stores no mark at all.
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [brief({ externalId: "cmt-002" })],
    });
    const clean = (await tom.query(api.ttsCode.listCodeBriefs, {})).find(
      (r) => r.externalId === "cmt-002",
    );
    expect(clean?.doorFaults).toBeUndefined();

    // THE STALE-MARK CASE. The upsert replaces the brief TEXT, so the mark
    // must go with it: this re-brief passed the door, so the row must carry
    // no mark — the page would otherwise print "refused twice" under a brief
    // the door accepted.
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [brief({ sourceHash: "hash-b", brief: "It is current. Nothing to change." })],
    });
    [row] = (await tom.query(api.ttsCode.listCodeBriefs, {})).filter(
      (r) => r.externalId === "cmt-001",
    );
    expect(row.brief).toBe("It is current. Nothing to change.");
    expect(row.doorFaults).toBeUndefined();
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
