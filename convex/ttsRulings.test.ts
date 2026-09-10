import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { matchQuotedUnit, turnSpans, turnUnits } from "./ttsRulings";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function publishSessionPrelude(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    const current = await ctx.db
      .query("modelOfTomPublication")
      .first();
    if (current !== null) return;
    await ctx.db.insert("modelOfTomPublication", {
      key: "current",
      commit: "rulings-session-test",
      committedAt: 1,
      pushed: true,
        operate: "operate layer",
        write: "write layer",
        know: "know layer",
      // The opener takes the stable prefix (the dynamic-context round): the
      // map, the operate rules and the write layer.
      headers: [{
        layers: ["operate", "write"],
        header: "MODEL-OF-TOM FILES (WikiTom commit rulings-session-test): operate,write",
      }],
    });
  });
}

async function withTom(t: ReturnType<typeof convexTest>) {
  await publishSessionPrelude(t);
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
}> = {}) => ({
  repo: "ComplexMultiTrigger",
  externalId: "cmt-001",
  sourceHash: "hash-a",
  brief: "# Ground-up brief\nwhat, why, how",
  recommendation: "approve" as const,
  execClass: "box" as const,
  ...over,
});

// Overwrite every brief's preparedAt and every ruling's ruledAt with values
// the test chose. The awaiting-ruling predicate compares two whole-millisecond
// Date.now() stamps written by different mutations, so a test that lets the
// real clock set them is asserting how fast the machine ran, not what the
// predicate says. Both fields are plain numbers on the row (convex/schema.ts
// dtsCodeBriefs.preparedAt, dtsRulings.ruledAt), so writing them directly is
// the whole mechanism.
async function setTimes(
  t: ReturnType<typeof convexTest>,
  { preparedAt, ruledAt }: { preparedAt: number; ruledAt: number },
) {
  await t.run(async (ctx) => {
    for (const b of await ctx.db.query("dtsCodeBriefs").collect()) {
      await ctx.db.patch(b._id, { preparedAt });
    }
    for (const r of await ctx.db.query("dtsRulings").collect()) {
      await ctx.db.patch(r._id, { ruledAt });
    }
  });
}

describe("TTS unified rulings", () => {
  // witness: remove the requireTom call from listRulings or recordRuling in
  // convex/ttsRulings.ts
  it("gates every Tom-facing function on the tom role", async () => {
    const t = convexTest({ schema, modules });
    await expect(t.query(api.ttsRulings.listRulings, {})).rejects.toThrow();
    await expect(
      t.mutation(api.ttsRulings.recordRuling, {
        repo: "r",
        externalId: "x",
        verdict: "approve",
      }),
    ).rejects.toThrow();
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "u", email: "u@tom.quest", role: "user" }),
    );
    const user = t.withIdentity({ subject: userId });
    await expect(user.query(api.ttsRulings.listRulings, {})).rejects.toThrow();
    await expect(
      user.mutation(api.ttsRulings.recordRuling, {
        repo: "r",
        externalId: "x",
        verdict: "approve",
      }),
    ).rejects.toThrow();
  });

  // witness: drop the `isLife === isCode` throw from recordRuling in
  // convex/ttsRulings.ts
  it("a ruling has exactly one subject", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "x" });
    // Zero subjects.
    await expect(
      tom.mutation(api.ttsRulings.recordRuling, { verdict: "approve" }),
    ).rejects.toThrow(/exactly one subject/);
    // Two subjects.
    await expect(
      tom.mutation(api.ttsRulings.recordRuling, {
        todoId,
        repo: "ComplexMultiTrigger",
        externalId: "cmt-001",
        verdict: "approve",
      }),
    ).rejects.toThrow(/exactly one subject/);
    // Half a code subject.
    await expect(
      tom.mutation(api.ttsRulings.recordRuling, {
        repo: "ComplexMultiTrigger",
        verdict: "approve",
      }),
    ).rejects.toThrow(/both repo and externalId/);
  });

  // witness: drop the `verdict === "revise" && !trimmed` throw in
  // convex/ttsRulings.ts
  it("revise requires the sentence", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await expect(
      tom.mutation(api.ttsRulings.recordRuling, {
        repo: "ComplexMultiTrigger",
        externalId: "cmt-001",
        verdict: "revise",
      }),
    ).rejects.toThrow(/sentence/);
    // A whitespace-only sentence is no sentence.
    await expect(
      tom.mutation(api.ttsRulings.recordRuling, {
        repo: "ComplexMultiTrigger",
        externalId: "cmt-001",
        verdict: "revise",
        sentence: "   ",
      }),
    ).rejects.toThrow(/sentence/);
  });

  // witness: drop the readiness patch from recordRuling's revise branch in
  // convex/ttsRulings.ts
  it("revise on a life todo drops readiness to unprepared", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, {
      statement: "email Ana Maria",
    });
    await tom.mutation(api.tts.updateTodo, {
      id: todoId,
      readiness: "prepared",
    });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId,
      verdict: "revise",
      sentence: "  ask about the Friday slot instead  ",
    });
    const [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.readiness).toBe("unprepared");
    const [ruling] = await tom.query(api.ttsRulings.listRulings, {});
    expect(ruling.subjectType).toBe("life");
    expect(ruling.sentence).toBe("ask about the Friday slot instead"); // trimmed
    expect(ruling.appliedAt).toBeUndefined(); // the preparer consumes it
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(
      events.some((e) => e.kind === "ruling" && e.todoId === todoId),
    ).toBe(true);
  });

  // witness: drop the applyStatusChange call from recordRuling's archive
  // branch in convex/ttsRulings.ts
  it("archive on a life todo archives it immediately", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, {
      statement: "renew the thing",
    });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId,
      verdict: "archive",
      unarchiveCondition: "when the renewal window reopens",
    });
    const [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.status).toBe("archived");
    expect(todo.archivedAt).toBeDefined();
    expect(todo.unarchiveCondition).toBe("when the renewal window reopens");
    const [ruling] = await tom.query(api.ttsRulings.listRulings, {});
    expect(ruling.appliedAt).toBeDefined();
    expect(ruling.applyResult).toBe("status archived");
  });

  it("session (life) and approve (code) leave appliedAt unset", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "talk" });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId,
      verdict: "session",
    });
    await tom.mutation(api.ttsRulings.recordRuling, {
      repo: "ComplexMultiTrigger",
      externalId: "cmt-001",
      verdict: "approve",
    });
    const rulings = await tom.query(api.ttsRulings.listRulings, {});
    expect(rulings).toHaveLength(2);
    expect(rulings.every((r) => r.appliedAt === undefined)).toBe(true);
    expect(rulings.every((r) => r.applyResult === undefined)).toBe(true);
  });

  // ── Every verdict's effect at write time (the lifeos update, phase 7: there
  // is no apply job on the box) ────────────────────────────────────────────
  // witness: drop any one of the four life branches in insertRuling.
  it("life: approve ratifies, archive archives, revise hands back, session waits for Tom's session", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const ids: Record<string, Id<"dtsTodos">> = {};
    for (const verdict of ["approve", "archive", "revise", "session"] as const) {
      ids[verdict] = await tom.mutation(api.tts.createTodo, { statement: verdict });
      await tom.mutation(api.ttsRulings.recordRuling, {
        todoId: ids[verdict],
        verdict,
        sentence: verdict === "revise" ? "shorter" : undefined,
      });
    }
    const rulings = await tom.query(api.ttsRulings.listRulings, {});
    const by = (verdict: string) => rulings.find((r) => r.verdict === verdict)!;
    expect(by("approve").applyResult).toBe("plan ratified");
    expect(by("archive").applyResult).toBe("status archived");
    expect((await t.run(async (ctx) => ctx.db.get(ids.archive)))?.status).toBe("archived");
    // revise: readiness dropped here; the planner's prepare pass consumes it.
    expect(by("revise").appliedAt).toBeUndefined();
    expect((await t.run(async (ctx) => ctx.db.get(ids.revise)))?.readiness).toBe("unprepared");
    // session: applied the moment Tom opens a session on the todo.
    expect(by("session").appliedAt).toBeUndefined();
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "talk",
      kind: "focus-item",
      repo: "none",
      todoId: ids.session,
      initialPrompt: "hello",
    });
    const after = (await tom.query(api.ttsRulings.listRulings, {})).find(
      (r) => r.verdict === "session",
    )!;
    expect(after.applyResult).toBe(`session ${sessionId}`);
    const pending = await t.query(internal.ttsRulings.internalPendingRulings, {});
    expect(pending.map((r) => r.verdict)).toEqual(["revise"]);
  });

  // witness: drop the code-session block from claudeSessions.insertSession, or the
  // call to it in claudeSessions.insertSession.
  it("code: revise waits for the planner's brief pass; session applies when the code block session opens; approve and archive wait for the scheduler", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const code = (externalId: string) => ({ repo: "ComplexMultiTrigger", externalId });
    await tom.mutation(api.ttsRulings.recordRuling, { ...code("c-revise"), verdict: "revise", sentence: "again" });
    await tom.mutation(api.ttsRulings.recordRuling, { ...code("c-session"), verdict: "session" });
    await tom.mutation(api.ttsRulings.recordRuling, { ...code("c-approve"), verdict: "approve" });
    await tom.mutation(api.ttsRulings.recordRuling, { ...code("c-archive"), verdict: "archive" });
    let pending = await t.query(internal.ttsRulings.internalPendingRulings, {});
    expect(pending.map((r) => r.externalId).sort()).toEqual(
      ["c-approve", "c-archive", "c-revise", "c-session"],
    );
    // A block session on ANOTHER category, and an autonomous mission, apply
    // nothing on the code subject.
    await tom.mutation(api.claudeSessions.createSession, {
      title: "admin block",
      kind: "block",
      blockCategory: "admin",
      repo: "none",
      initialPrompt: "hello",
    });
    pending = await t.query(internal.ttsRulings.internalPendingRulings, {});
    expect(pending.some((r) => r.externalId === "c-session")).toBe(true);
    // The code block session is the conversation Tom asked for.
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "code block",
      kind: "block",
      blockCategory: "code",
      repo: "ComplexMultiTrigger",
      initialPrompt: "hello",
    });
    const rulings = await tom.query(api.ttsRulings.listRulings, {});
    const session = rulings.find((r) => r.externalId === "c-session")!;
    expect(session.applyResult).toBe(`session ${sessionId}`);
    // The other three still ride the feed for their consumers: the planner's
    // brief pass (revise) and the auto-session scheduler (approve, archive).
    pending = await t.query(internal.ttsRulings.internalPendingRulings, {});
    expect(pending.map((r) => r.externalId).sort()).toEqual(
      ["c-approve", "c-archive", "c-revise"],
    );
  });

  // witness: drop the codeSessionRulingLines append from
  // claudeSessions.insertSession, or mark a ruling the opener did not name —
  // a verdict would be consumed without the conversation Tom asked for ever
  // reaching the session.
  it("the code block session names every code session verdict it consumes, with Tom's sentence, and consumes only those", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const code = (externalId: string) => ({ repo: "ComplexMultiTrigger", externalId });
    await t.mutation(internal.tts.internalReplaceMirror, {
      repo: "ComplexMultiTrigger",
      rows: [
        { externalId: "c-one", tier: "R", status: "open", statement: "drop the CLI flag", url: "u" },
      ],
    });
    // Two live session verdicts, one with a note; one superseded by a newer
    // approve; one already applied by an earlier block session.
    await tom.mutation(api.ttsRulings.recordRuling, { ...code("c-one"), verdict: "session", sentence: "talk me through the flag" });
    await tom.mutation(api.ttsRulings.recordRuling, { ...code("c-two"), verdict: "session" });
    await tom.mutation(api.ttsRulings.recordRuling, { ...code("c-old"), verdict: "session" });
    await tom.mutation(api.ttsRulings.recordRuling, { ...code("c-old"), verdict: "approve" });
    const doneId = await tom.mutation(api.ttsRulings.recordRuling, { ...code("c-done"), verdict: "session" });
    await t.run(async (ctx) => {
      // Rulings on one subject must order by ruledAt; the fake clock can
      // give the two c-old rows the same millisecond.
      const rows = await ctx.db.query("dtsRulings").collect();
      for (const r of rows) {
        if (r.externalId === "c-old" && r.verdict === "approve") {
          await ctx.db.patch(r._id, { ruledAt: r.ruledAt + 1 });
        }
      }
      await ctx.db.patch(doneId, { appliedAt: 1, applyResult: "session earlier" });
    });

    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "code block",
      kind: "block",
      blockCategory: "code",
      repo: "ComplexMultiTrigger",
      initialPrompt: "hello",
    });
    const [inbound] = await tom.query(api.claudeSessions.getPendingInbound, { sessionId });
    const text = inbound.text ?? "";
    expect(text).toContain('Tom ruled "session" on these code todos (2)');
    expect(text).toContain(
      '- ComplexMultiTrigger c-one "drop the CLI flag" — he wrote: talk me through the flag',
    );
    expect(text).toContain("- ComplexMultiTrigger c-two — no note written");
    expect(text).not.toContain("c-old");
    expect(text).not.toContain("c-done");

    const rulings = await tom.query(api.ttsRulings.listRulings, {});
    const by = (externalId: string, verdict: string) =>
      rulings.find((r) => r.externalId === externalId && r.verdict === verdict)!;
    expect(by("c-one", "session").applyResult).toBe(`session ${sessionId}`);
    expect(by("c-two", "session").applyResult).toBe(`session ${sessionId}`);
    expect(by("c-old", "session").appliedAt).toBeUndefined(); // superseded history
    expect(by("c-old", "approve").appliedAt).toBeUndefined(); // the scheduler's
    expect(by("c-done", "session").applyResult).toBe("session earlier");
    const pending = await t.query(internal.ttsRulings.internalPendingRulings, {});
    expect(pending.map((r) => `${r.externalId} ${r.verdict}`)).toEqual(["c-old approve"]);
  });

  // witness: drop the life-approve instant-apply branch from insertRuling in
  // convex/ttsRulings.ts — the ruling would ride the pending feed forever
  // (no worker consumes life approvals; Tom is the executor).
  it("approve on a LIFE todo applies instantly as ratification", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "go" });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId,
      verdict: "approve",
    });
    const [ruling] = await tom.query(api.ttsRulings.listRulings, {});
    expect(ruling.appliedAt).toBeDefined();
    expect(ruling.applyResult).toBe("plan ratified");
    expect(
      await t.query(internal.ttsRulings.internalPendingRulings, {}),
    ).toHaveLength(0);
  });

  // witness: drop the tomTouchedAt patch from insertRuling's life path in
  // convex/ttsRulings.ts — the planner could rewrite a row Tom just ruled on.
  it("approve, session, and archive each stamp tomTouchedAt (row frozen)", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    for (const verdict of ["approve", "session", "archive"] as const) {
      const todoId = await tom.mutation(api.tts.createTodo, {
        statement: `rule ${verdict}`,
      });
      let todo = await t.run(async (ctx) => ctx.db.get(todoId));
      expect(todo?.tomTouchedAt).toBeUndefined();
      await tom.mutation(api.ttsRulings.recordRuling, { todoId, verdict });
      todo = await t.run(async (ctx) => ctx.db.get(todoId));
      expect(todo?.tomTouchedAt).toBeDefined();
    }
  });

  // witness: drop the `verdict !== "revise"` guard from insertRuling's
  // tomTouchedAt patch in convex/ttsRulings.ts — revise hands the subject BACK
  // to the preparing agent, so freezing the row would strand every todo Tom
  // ever asked the planner to prepare again.
  it("revise does NOT stamp tomTouchedAt — the row goes back to the agent", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "redo" });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId,
      verdict: "revise",
      sentence: "split the travel bits out",
    });
    const todo = await t.run(async (ctx) => ctx.db.get(todoId));
    expect(todo?.tomTouchedAt).toBeUndefined();
    expect(todo?.readiness).toBe("unprepared"); // the revise effect still landed
  });

  // witness: change briefAwaitsRuling back to "any ruling clears the item" in
  // convex/ttsRulings.ts — a revise→re-brief cycle would never return the item.
  //
  // Every timestamp below is WRITTEN, never sampled from the clock. The
  // earlier version of this test recorded the ruling and the re-brief through
  // their mutations and let both stamp Date.now(), which made the assertion
  // depend on the two writes landing in different milliseconds: it failed once
  // in a full run (expected 1, received 0) and passed on a rerun of the same
  // tree. Same-millisecond ordering is now its own case below, asserted rather
  // than occasionally sampled.
  it("a re-brief NEWER than the live ruling puts the item back on the pile", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [brief({ externalId: "cycle" })],
    });
    await tom.mutation(api.ttsRulings.recordRuling, {
      repo: "ComplexMultiTrigger",
      externalId: "cycle",
      verdict: "revise",
      sentence: "narrower scope",
    });
    // Brief prepared at 1000, ruled at 2000: the ruling answers the brief.
    await setTimes(t, { preparedAt: 1000, ruledAt: 2000 });
    expect(
      await t.query(internal.ttsRulings.internalAwaitingRulingCount, {}),
    ).toBe(0);
    // The worker re-briefs after applying the revise — the fresh brief's
    // preparedAt is newer than the ruling, so the item awaits a fresh ruling.
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [brief({ externalId: "cycle", sourceHash: "hash-b" })],
    });
    await setTimes(t, { preparedAt: 3000, ruledAt: 2000 });
    expect(
      await t.query(internal.ttsRulings.internalAwaitingRulingCount, {}),
    ).toBe(1);
  });

  // witness: change `ruling.ruledAt <= brief.preparedAt` back to `<` in
  // briefAwaitsRuling (convex/ttsRulings.ts) — this case returns 0, and in
  // production a re-briefed item silently leaves Tom's pile with nothing able
  // to put it back.
  it("a ruling and a re-brief in the SAME millisecond keep the item on the pile", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [brief({ externalId: "tie" })],
    });
    await tom.mutation(api.ttsRulings.recordRuling, {
      repo: "ComplexMultiTrigger",
      externalId: "tie",
      verdict: "revise",
      sentence: "narrower scope",
    });
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [brief({ externalId: "tie", sourceHash: "hash-b" })],
    });
    // Both stamps are whole-millisecond Date.now() values written by two
    // different mutations, so they can be equal. The tie is decided in favour
    // of keeping the item in front of Tom.
    await setTimes(t, { preparedAt: 1000, ruledAt: 1000 });
    expect(
      await t.query(internal.ttsRulings.internalAwaitingRulingCount, {}),
    ).toBe(1);
  });

  // witness: delete internalRecordRuling from convex/ttsRulings.ts — the
  // block-session pen (npx convex run under deploy credentials) breaks.
  it("internalRecordRuling is the session pen: same semantics, no identity", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "pen" });
    await t.mutation(internal.ttsRulings.internalRecordRuling, {
      todoId,
      verdict: "revise",
      sentence: "spoken in session",
    });
    const [ruling] = await tom.query(api.ttsRulings.listRulings, {});
    expect(ruling.verdict).toBe("revise");
    expect(ruling.sentence).toBe("spoken in session");
    const todo = await t.run(async (ctx) =>
      ctx.db.get((await ctx.db.query("dtsTodos").collect())[0]._id),
    );
    expect(todo?.readiness).toBe("unprepared");
    await expect(
      t.mutation(internal.ttsRulings.internalRecordRuling, {
        todoId: "not-a-real-id",
        verdict: "approve",
      }),
    ).rejects.toThrow(/Unknown todo id/);
  });

  // witness: drop the `newest.get(...)?._id === row._id` clause from
  // internalPendingRulings in convex/ttsRulings.ts
  it("pending rulings exclude applied AND superseded rows, per subject key", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "life" });
    const base = Date.now();
    const insert = (row: {
      subjectType: "life" | "code";
      todoId?: typeof todoId;
      repo?: string;
      externalId?: string;
      ruledAt: number;
      appliedAt?: number;
      applyResult?: string;
    }) =>
      t.run(async (ctx) =>
        ctx.db.insert("dtsRulings", { verdict: "approve", ...row }),
      );
    // Life subject: older ruling superseded by a newer sibling.
    await insert({ subjectType: "life", todoId, ruledAt: base - 1000 });
    const liveLife = await insert({ subjectType: "life", todoId, ruledAt: base });
    // Code subject already applied — not pending.
    await insert({
      subjectType: "code",
      repo: "ComplexMultiTrigger",
      externalId: "b",
      ruledAt: base,
      appliedAt: base + 1,
      applyResult: "sha deadbeef",
    });
    // Code subject keyed (repo, externalId): the newer row supersedes...
    await insert({
      subjectType: "code",
      repo: "ComplexMultiTrigger",
      externalId: "c",
      ruledAt: base - 1000,
    });
    const liveCode = await insert({
      subjectType: "code",
      repo: "ComplexMultiTrigger",
      externalId: "c",
      ruledAt: base,
    });
    // ...but the same externalId in ANOTHER repo is a distinct subject.
    const otherRepo = await insert({
      subjectType: "code",
      repo: "tom.quest",
      externalId: "c",
      ruledAt: base - 500,
    });
    const pending = await t.query(internal.ttsRulings.internalPendingRulings, {});
    expect(pending.map((r) => r._id).sort()).toEqual(
      [liveLife, liveCode, otherRepo].sort(),
    );
  });

  // witness: replace `normalized` with the raw string id in
  // internalMarkRulingApplied's patch call in convex/ttsRulings.ts
  it("marks a ruling applied and rejects a bad id by name", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.ttsRulings.recordRuling, {
      repo: "tom.quest",
      externalId: "tq-004",
      verdict: "approve",
    });
    await t.mutation(internal.ttsRulings.internalMarkRulingApplied, {
      id,
      result: "https://github.com/Heffnt/tom.quest/pull/99",
    });
    const [row] = await tom.query(api.ttsRulings.listRulings, {});
    expect(row.appliedAt).toBeDefined();
    expect(row.applyResult).toBe("https://github.com/Heffnt/tom.quest/pull/99");
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(events.some((e) => e.kind === "ruling-applied")).toBe(true);
    await expect(
      t.mutation(internal.ttsRulings.internalMarkRulingApplied, {
        id: "not-a-real-id",
        result: "x",
      }),
    ).rejects.toThrow(/Unknown ruling id/);
  });

  // witness: count ALL briefs (drop the `!ruled.has` filter) in
  // internalAwaitingRulingCount in convex/ttsRulings.ts
  it("awaiting-ruling count covers briefed code items with no ruling at all", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [
        brief({ externalId: "ruled" }),
        brief({ externalId: "unruled-1" }),
        brief({ externalId: "unruled-2" }),
      ],
    });
    expect(
      await t.query(internal.ttsRulings.internalAwaitingRulingCount, {}),
    ).toBe(3);
    // Any ruling — even unapplied — takes the item off the pile. The two
    // stamps are whole-millisecond Date.now() values written by two different
    // mutations, and the predicate reads a TIE as "still awaiting", so a fast
    // machine would count 3 here; setTimes pins them so this asserts the
    // predicate rather than the clock.
    await tom.mutation(api.ttsRulings.recordRuling, {
      repo: "ComplexMultiTrigger",
      externalId: "ruled",
      verdict: "session",
    });
    await setTimes(t, { preparedAt: 1000, ruledAt: 2000 });
    expect(
      await t.query(internal.ttsRulings.internalAwaitingRulingCount, {}),
    ).toBe(2);
    // A ruling on the same externalId in ANOTHER repo does not count (the
    // key is the (repo, externalId) pair)...
    await tom.mutation(api.ttsRulings.recordRuling, {
      repo: "tom.quest",
      externalId: "unruled-1",
      verdict: "approve",
    });
    // ...and neither does a life ruling.
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "x" });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId,
      verdict: "session",
    });
    await setTimes(t, { preparedAt: 1000, ruledAt: 2000 });
    expect(
      await t.query(internal.ttsRulings.internalAwaitingRulingCount, {}),
    ).toBe(2);
  });

  // witness: reject `sentence` on any verdict but revise in insertRuling
  // (convex/dtsRulings.ts) and the approve/session assertions below go red.
  it("accepts a sentence on every verdict; revise still requires one", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const a = await tom.mutation(api.tts.createTodo, { statement: "approve me" });
    const s = await tom.mutation(api.tts.createTodo, { statement: "talk to me" });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId: a,
      verdict: "approve",
      sentence: "yes, and keep the scope to the kitchen",
    });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId: s,
      verdict: "session",
      sentence: "I want to see the numbers first",
    });
    const rulings = await tom.query(api.ttsRulings.listRulings, {});
    expect(rulings.find((r) => r.todoId === a)?.sentence).toBe(
      "yes, and keep the scope to the kitchen",
    );
    expect(rulings.find((r) => r.todoId === s)?.sentence).toBe(
      "I want to see the numbers first",
    );
    // A blank sentence is stored as absent, not as "".
    const b = await tom.mutation(api.tts.createTodo, { statement: "no note" });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId: b,
      verdict: "approve",
      sentence: "   ",
    });
    expect(
      (await tom.query(api.ttsRulings.listRulings, {})).find(
        (r) => r.todoId === b,
      )?.sentence,
    ).toBeUndefined();
    // revise is still the one verdict that cannot go without one.
    const r = await tom.mutation(api.tts.createTodo, { statement: "redo" });
    await expect(
      tom.mutation(api.ttsRulings.recordRuling, { todoId: r, verdict: "revise" }),
    ).rejects.toThrow(/sentence verdict/);
  });

  // witness: drop the `unarchiveCondition ?? trimmed` fallback in insertRuling
  // — the archive note would stop meaning "propose it back when…".
  it("an archive sentence IS the unarchive condition", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, { statement: "shelve it" });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId: id,
      verdict: "archive",
      sentence: "when the lease renews",
    });
    const [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.status).toBe("archived");
    expect(todo.unarchiveCondition).toBe("when the lease renews");
    // An explicit unarchiveCondition still wins over the sentence.
    const other = await tom.mutation(api.tts.createTodo, { statement: "other" });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId: other,
      verdict: "archive",
      sentence: "a note",
      unarchiveCondition: "the explicit one",
    });
    const todos = await tom.query(api.tts.listTodos, {});
    expect(todos.find((x) => x._id === other)?.unarchiveCondition).toBe(
      "the explicit one",
    );
  });
});

// ── Rulings from Tom's own words (ruling 15, 2026-09-05) ─────────────────────
// POST /tts/ruling is the agent's door to write what Tom SAID as a ruling.
// Every test here goes through the route with the worker key, because the
// checks are what make the door Tom's pen and not the agent's: the turn must
// be Tom-authored, the sentence must be in it verbatim, and one turn rules on
// one subject once. witness: delete any one check in
// internalRecordRulingFromTomWords (convex/ttsRulings.ts).
describe("a ruling from Tom's words", () => {
  // A session Tom typed one turn in, and the agent one. The session is ABOUT
  // something (check 5 binds rulings to it): the dentist todo by default, the
  // "code" block for code subjects, or nothing at all (adhoc).
  async function sessionWithTurns(
    t: ReturnType<typeof convexTest>,
    about: "todo" | "code-block" | "adhoc" = "todo",
  ) {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, {
      statement: "call the dentist",
    });
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "talk",
      repo: "none",
      initialPrompt: "hello",
      ...(about === "todo"
        ? { kind: "focus-item" as const, todoId }
        : about === "code-block"
          ? { kind: "block" as const, blockCategory: "code" }
          : { kind: "adhoc" as const }),
    });
    await tom.mutation(api.claudeSessions.sendMessage, {
      sessionId,
      text: "ok. archive the dentist one, I already went.",
    });
    await t.mutation(internal.claudeSessions.internalSendMessage, {
      sessionId,
      text: "archive the dentist one, I already went.",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("claudeInbound").collect(),
    );
    const tomRow = rows.find((r) => r.author === "tom")!;
    const agentRow = rows.find((r) => r.text?.startsWith("archive"))!;
    return { tom, todoId, tomRow, agentRow, sessionId };
  }

  const post = (t: ReturnType<typeof convexTest>, body: unknown) =>
    t.fetch("/tts/ruling", {
      method: "POST",
      headers: { "X-TTS-Key": "s3cret", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("writes the ruling with provenance and applies it, from a turn Tom typed", async () => {
    const t = convexTest({ schema, modules });
    const { tom, todoId, tomRow } = await sessionWithTurns(t);
    const res = await post(t, {
      inboundId: tomRow._id,
      verdict: "archive",
      subjectType: "life",
      subjectId: todoId,
      quote: "archive the dentist one, I already went.",
    });
    expect(res.status).toBe(200);
    const [ruling] = await tom.query(api.ttsRulings.listRulings, {});
    expect(ruling.verdict).toBe("archive");
    expect(ruling.todoId).toBe(todoId);
    expect(ruling.provenance).toEqual({
      from: "tom-words",
      inboundId: tomRow._id,
      quote: "archive the dentist one, I already went.",
    });
    // Applied through the same path as the archive button: the todo is
    // archived and the ruling is marked applied.
    expect(ruling.appliedAt).toBeDefined();
    const [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.status).toBe("archived");
    // witness: pass the quote as `sentence` to insertRuling. The quote is
    // provenance only — it never becomes the ruling's sentence, and archive
    // through this door leaves the page's return condition unset.
    expect(ruling.sentence).toBeUndefined();
    expect(todo.unarchiveCondition).toBeUndefined();
    // The digest reads events: the ruling event carries the provenance.
    const events = await tom.query(api.tts.listRecentEvents, {});
    const event = events.find((e) => e.kind === "ruling");
    expect(event?.data?.provenance?.from).toBe("tom-words");
  });

  // witness: drop step 6 of internalRecordRulingFromTomWords. revise is the
  // one verdict that cannot exist without the ruling's own sentence (the
  // worker's redirect), so it is required there and refused everywhere else.
  it("sentence is required on revise and refused on every other verdict", async () => {
    const t = convexTest({ schema, modules });
    const { tom, todoId, tomRow } = await sessionWithTurns(t);
    const body = {
      inboundId: tomRow._id,
      subjectType: "life",
      subjectId: todoId,
      quote: "archive the dentist one, I already went.",
    };
    const bare = await post(t, { ...body, verdict: "revise" });
    expect(bare.status).toBe(400);
    expect((await bare.json()).error).toMatch(/revise needs a sentence/);
    const noted = await post(t, {
      ...body,
      verdict: "archive",
      sentence: "until the next check-up",
    });
    expect(noted.status).toBe(400);
    expect((await noted.json()).error).toMatch(/revise redirect only/);
    expect(await tom.query(api.ttsRulings.listRulings, {})).toHaveLength(0);
    // The quote may be the redirect itself.
    const revised = await post(t, {
      ...body,
      verdict: "revise",
      sentence: "archive the dentist one, I already went.",
    });
    expect(revised.status).toBe(200);
    const [ruling] = await tom.query(api.ttsRulings.listRulings, {});
    expect(ruling.sentence).toBe("archive the dentist one, I already went.");
    expect(ruling.provenance?.quote).toBe(
      "archive the dentist one, I already went.",
    );
  });

  // witness: store `redirect` (the caller's text) instead of the matched span
  // in step 6. The redirect is what the preparing agent obeys, so a line the
  // agent composed would be the agent redirecting itself under Tom's name:
  // it is held to the same check as the quote — a whole sentence of the same
  // turn, stored as the turn's own text.
  it("refuses a revise redirect the agent composed; accepts one that is Tom's own sentence", async () => {
    const t = convexTest({ schema, modules });
    const { tom, todoId, tomRow, sessionId } = await sessionWithTurns(t);
    const composed = await post(t, {
      inboundId: tomRow._id,
      verdict: "revise",
      subjectType: "life",
      subjectId: todoId,
      quote: "archive the dentist one, I already went.",
      sentence: "book the hygienist, not the dentist",
    });
    expect(composed.status).toBe(400);
    expect((await composed.json()).error).toMatch(/redirect must be a whole sentence/);
    expect(await tom.query(api.ttsRulings.listRulings, {})).toHaveLength(0);
    // A second turn of Tom's, with the redirect as its own sentence.
    await tom.mutation(api.claudeSessions.sendMessage, {
      sessionId,
      text: "no wait, revise it. book the hygienist, not the dentist!",
    });
    const second = (
      await t.run(async (ctx) => ctx.db.query("claudeInbound").collect())
    ).find((r) => r.text?.startsWith("no wait"))!;
    const spoken = await post(t, {
      inboundId: second._id,
      verdict: "revise",
      subjectType: "life",
      subjectId: todoId,
      quote: "no wait, revise it",
      // A fragment of the redirect sentence is refused like a fragment of the quote.
      sentence: "book the hygienist",
    });
    expect(spoken.status).toBe(400);
    expect((await spoken.json()).error).toMatch(/redirect must be a whole sentence/);
    const whole = await post(t, {
      inboundId: second._id,
      verdict: "revise",
      subjectType: "life",
      subjectId: todoId,
      quote: "no wait, revise it",
      sentence: "book the hygienist, not the dentist",
    });
    expect(whole.status).toBe(200);
    const [ruling] = await tom.query(api.ttsRulings.listRulings, {});
    // Both stored as the turn's own text, terminators included.
    expect(ruling.sentence).toBe("book the hygienist, not the dentist!");
    expect(ruling.provenance?.quote).toBe("no wait, revise it.");
  });

  it("refuses a turn the agent wrote (the pen, or the opener)", async () => {
    const t = convexTest({ schema, modules });
    const { tom, todoId, agentRow } = await sessionWithTurns(t);
    const res = await post(t, {
      inboundId: agentRow._id,
      verdict: "archive",
      subjectType: "life",
      subjectId: todoId,
      quote: "archive the dentist one, I already went.",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not typed by Tom/);
    expect(await tom.query(api.ttsRulings.listRulings, {})).toHaveLength(0);
  });

  // witness: put `row.text.includes(quoted)` back in place of matchQuotedUnit
  // in convex/ttsRulings.ts. A fragment that IS in the turn ("the dentist one")
  // is refused: the quote must be one whole sentence or line of the turn.
  it("refuses a sentence that is not a whole sentence or line of the turn", async () => {
    const t = convexTest({ schema, modules });
    const { tom, todoId, tomRow } = await sessionWithTurns(t);
    for (const sentence of [
      "Archive the dentist one",
      "the dentist one, I already went",
      "ok. archive the dentist one, I already went.",
    ]) {
      const res = await post(t, {
        inboundId: tomRow._id,
        verdict: "archive",
        subjectType: "life",
        subjectId: todoId,
        quote: sentence,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/whole sentence|exactly one sentence/);
    }
    expect(await tom.query(api.ttsRulings.listRulings, {})).toHaveLength(0);
  });

  // The terminator is not part of the unit, and a "." inside a token ("1.5",
  // "tom.quest") does not split it.
  it("turnUnits splits at newlines and sentence ends only", () => {
    expect(
      turnUnits("ok. archive it, I already went.\nship 1.5 to tom.quest!  fine?"),
    ).toEqual(["ok", "archive it, I already went", "ship 1.5 to tom.quest", "fine"]);
    expect(matchQuotedUnit("archive it, I already went.", "archive it, I already went")).toEqual({
      unit: "archive it, I already went",
      source: "archive it, I already went.",
    });
  });

  // witness: return `{ unit }` from matchQuotedUnit and store `quoted` in the
  // provenance. The match ignores the terminator so the agent's retyping can
  // LOCATE the sentence, but what is stored is the turn's own substring,
  // terminator and all — "Archive this?" never becomes "Archive this!".
  it("stores the turn's own substring as the quote, not the caller's retyping", () => {
    expect(turnSpans("Archive this?  and the other one!")).toEqual([
      { unit: "Archive this", source: "Archive this?" },
      { unit: "and the other one", source: "and the other one!" },
    ]);
    expect(matchQuotedUnit("Archive this? ok", "Archive this!")).toEqual({
      unit: "Archive this",
      source: "Archive this?",
    });
  });

  it("writes the quote as it appears in the turn when the agent retyped its punctuation", async () => {
    const t = convexTest({ schema, modules });
    const { tom, todoId, tomRow } = await sessionWithTurns(t);
    const res = await post(t, {
      inboundId: tomRow._id,
      verdict: "archive",
      subjectType: "life",
      subjectId: todoId,
      quote: "archive the dentist one, I already went!",
    });
    expect(res.status).toBe(200);
    const [ruling] = await tom.query(api.ttsRulings.listRulings, {});
    expect(ruling.provenance?.quote).toBe("archive the dentist one, I already went.");
  });

  // witness: drop the mirror or brief lookups from resolveSubject. A code
  // subject is accepted only when it is open in the mirror AND briefed — the
  // brief is what Tom was shown, and approve here is what the scheduler's code
  // lane admits as a worker mission.
  it("accepts a code subject that is open in the mirror and briefed, refuses one without a brief", async () => {
    const t = convexTest({ schema, modules });
    const { tom, tomRow } = await sessionWithTurns(t, "code-block");
    await t.mutation(internal.tts.internalReplaceMirror, {
      repo: "ComplexMultiTrigger",
      rows: [
        { externalId: "cmt-001", tier: "R", status: "open", statement: "s1", url: "u" },
        { externalId: "cmt-002", tier: "R", status: "open", statement: "s2", url: "u" },
      ],
    });
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [brief({ externalId: "cmt-001" })],
    });
    const body = {
      inboundId: tomRow._id,
      verdict: "approve",
      subjectType: "code",
      quote: "archive the dentist one, I already went.",
    };
    const unbriefed = await post(t, { ...body, subjectId: "ComplexMultiTrigger cmt-002" });
    expect(unbriefed.status).toBe(400);
    expect((await unbriefed.json()).error).toMatch(/no brief/);
    const briefed = await post(t, { ...body, subjectId: "ComplexMultiTrigger cmt-001" });
    expect(briefed.status).toBe(200);
    const [ruling] = await tom.query(api.ttsRulings.listRulings, {});
    expect(ruling).toMatchObject({
      subjectType: "code",
      repo: "ComplexMultiTrigger",
      externalId: "cmt-001",
      verdict: "approve",
    });
  });

  it("refuses the same turn ruling twice on the same subject", async () => {
    const t = convexTest({ schema, modules });
    const { tom, todoId, tomRow } = await sessionWithTurns(t);
    const body = {
      inboundId: tomRow._id,
      verdict: "session",
      subjectType: "life",
      subjectId: todoId,
      quote: "archive the dentist one, I already went.",
    };
    expect((await post(t, body)).status).toBe(200);
    const again = await post(t, { ...body, verdict: "approve" });
    expect(again.status).toBe(400);
    expect((await again.json()).error).toMatch(/already ruled/);
    expect(await tom.query(api.ttsRulings.listRulings, {})).toHaveLength(1);
  });

  it("refuses an unknown row, a bad verdict, and the wrong key", async () => {
    const t = convexTest({ schema, modules });
    const { todoId, tomRow } = await sessionWithTurns(t);
    const body = {
      inboundId: tomRow._id,
      verdict: "archive",
      subjectType: "life",
      subjectId: todoId,
      quote: "archive the dentist one, I already went.",
    };
    expect((await post(t, { ...body, inboundId: "not-a-row" })).status).toBe(400);
    expect((await post(t, { ...body, verdict: "defer" })).status).toBe(400);
    const wrongKey = await t.fetch("/tts/ruling", {
      method: "POST",
      headers: { "X-TTS-Key": "nope", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(wrongKey.status).toBe(401);
  });

  // witness: change `row.author !== "tom"` to `row.author === "agent"` in
  // convex/ttsRulings.ts. A row from before the author field has no author,
  // and no author is not Tom.
  it("refuses a row whose author is unset", async () => {
    const t = convexTest({ schema, modules });
    const { tom, todoId, tomRow } = await sessionWithTurns(t);
    const unsetId = await t.run(async (ctx) =>
      ctx.db.insert("claudeInbound", {
        sessionId: tomRow.sessionId,
        kind: "user-turn",
        text: "archive the dentist one, I already went.",
        status: "pending",
        createdAt: Date.now(),
      }),
    );
    const res = await post(t, {
      inboundId: unsetId,
      verdict: "archive",
      subjectType: "life",
      subjectId: todoId,
      quote: "archive the dentist one, I already went.",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/author is unset/);
    expect(await tom.query(api.ttsRulings.listRulings, {})).toHaveLength(0);
  });

  // witness: drop the ctx.db.get after normalizeId in resolveSubject. A
  // well-formed id that names a row in another table is not a subject.
  it("refuses a well-formed id from another table as a subject", async () => {
    const t = convexTest({ schema, modules });
    const { tom, todoId, tomRow } = await sessionWithTurns(t);
    const body = {
      inboundId: tomRow._id,
      verdict: "archive",
      quote: "archive the dentist one, I already went.",
    };
    const inboundAsTodo = await post(t, {
      ...body,
      subjectType: "life",
      subjectId: tomRow._id,
    });
    expect(inboundAsTodo.status).toBe(400);
    expect((await inboundAsTodo.json()).error).toMatch(/Unknown todo id/);
    const todoAsBatch = await post(t, {
      ...body,
      subjectType: "batch",
      subjectId: todoId,
    });
    expect(todoAsBatch.status).toBe(400);
    expect((await todoAsBatch.json()).error).toMatch(/Unknown batch id/);
    expect(await tom.query(api.ttsRulings.listRulings, {})).toHaveLength(0);
  });

  // witness: drop the mirror lookup from resolveSubject. An unknown repo and
  // an externalId the mirror does not hold are both refused before any brief
  // is consulted — so no approve can name a code todo Tom never saw.
  it("refuses a code subject with an unknown repo, and one the mirror does not hold", async () => {
    const t = convexTest({ schema, modules });
    const { tom, tomRow } = await sessionWithTurns(t, "code-block");
    await t.mutation(internal.tts.internalReplaceMirror, {
      repo: "ComplexMultiTrigger",
      rows: [
        { externalId: "cmt-001", tier: "R", status: "open", statement: "s1", url: "u" },
      ],
    });
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [brief({ externalId: "cmt-001" }), brief({ externalId: "cmt-999" })],
    });
    const body = {
      inboundId: tomRow._id,
      verdict: "approve",
      subjectType: "code",
      quote: "archive the dentist one, I already went.",
    };
    const unknownRepo = await post(t, { ...body, subjectId: "nowhere cmt-001" });
    expect(unknownRepo.status).toBe(400);
    expect((await unknownRepo.json()).error).toMatch(/Unknown repo/);
    // Briefed but not mirrored: the brief alone does not make a subject.
    const unmirrored = await post(t, {
      ...body,
      subjectId: "ComplexMultiTrigger cmt-999",
    });
    expect(unmirrored.status).toBe(400);
    expect((await unmirrored.json()).error).toMatch(/Unknown code todo/);
    expect(await tom.query(api.ttsRulings.listRulings, {})).toHaveLength(0);
  });

  // witness: set MIN_QUOTE_WORDS to 1 in convex/ttsRulings.ts. "ok" is a
  // whole unit of the turn ("ok. archive the dentist one, …") and is still
  // refused.
  it("refuses a single-word quote", async () => {
    const t = convexTest({ schema, modules });
    const { tom, todoId, tomRow } = await sessionWithTurns(t);
    const res = await post(t, {
      inboundId: tomRow._id,
      verdict: "approve",
      subjectType: "life",
      subjectId: todoId,
      quote: "ok",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/single word/);
    expect(await tom.query(api.ttsRulings.listRulings, {})).toHaveLength(0);
  });

  // witness: drop check 5 (refuseUnlessSessionSubject) from
  // internalRecordRulingFromTomWords. The dedupe is per subject, so without
  // the binding one sentence Tom said about the dentist rules the passport
  // todo as readily — a valid turn replayed against any subject in the
  // record. The refusal is its own reason: the subject exists, the session
  // was just not about it.
  it("refuses a subject the turn's session was not about", async () => {
    const t = convexTest({ schema, modules });
    const { tom, todoId, tomRow } = await sessionWithTurns(t);
    const otherId = await tom.mutation(api.tts.createTodo, {
      statement: "renew the passport",
    });
    const body = {
      inboundId: tomRow._id,
      verdict: "session",
      subjectType: "life",
      quote: "archive the dentist one, I already went.",
    };
    const other = await post(t, { ...body, subjectId: otherId });
    expect(other.status).toBe(400);
    expect((await other.json()).error).toMatch(
      /session about the todo .*, not about this subject/,
    );
    expect(await tom.query(api.ttsRulings.listRulings, {})).toHaveLength(0);
    expect((await post(t, { ...body, subjectId: todoId })).status).toBe(200);
  });

  // A session on a batch is about the batch AND the todos in it — one turn
  // may rule on several of those (the dedupe stays per subject) — and about
  // nothing outside it.
  it("binds a batch session's turns to the batch and its member todos", async () => {
    const t = convexTest({ schema, modules });
    const { tom, todoId, tomRow } = await sessionWithTurns(t, "adhoc");
    const memberId = await tom.mutation(api.tts.createTodo, {
      statement: "find the insurance card",
    });
    const strayId = await tom.mutation(api.tts.createTodo, {
      statement: "renew the passport",
    });
    const batchId = await t.run(async (ctx) => {
      const now = Date.now();
      const id = await ctx.db.insert("batches", {
        statement: "the dentist visit",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(todoId, { batchId: id });
      await ctx.db.patch(memberId, { batchId: id });
      return id;
    });
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "the batch",
      kind: "adhoc",
      repo: "none",
      batchId,
      initialPrompt: "hello",
    });
    await tom.mutation(api.claudeSessions.sendMessage, {
      sessionId,
      text: "approve the whole dentist batch, both bits.",
    });
    const turn = (
      await t.run(async (ctx) => ctx.db.query("claudeInbound").collect())
    ).find((r) => r.sessionId === sessionId && r.author === "tom")!;
    const body = {
      inboundId: turn._id,
      verdict: "approve",
      quote: "approve the whole dentist batch, both bits.",
    };
    expect(
      (await post(t, { ...body, subjectType: "batch", subjectId: batchId })).status,
    ).toBe(200);
    expect(
      (await post(t, { ...body, subjectType: "life", subjectId: todoId })).status,
    ).toBe(200);
    expect(
      (await post(t, { ...body, subjectType: "life", subjectId: memberId })).status,
    ).toBe(200);
    const stray = await post(t, { ...body, subjectType: "life", subjectId: strayId });
    expect(stray.status).toBe(400);
    expect((await stray.json()).error).toMatch(/session about the batch/);
    const rulings = await tom.query(api.ttsRulings.listRulings, {});
    expect(rulings).toHaveLength(3);
    expect(rulings.every((r) => r.provenance?.inboundId === turn._id)).toBe(true);
    // The dentist turn from the adhoc session (no subject at all) rules nothing,
    // not even the todo it names.
    const adhoc = await post(t, {
      inboundId: tomRow._id,
      verdict: "archive",
      subjectType: "life",
      subjectId: todoId,
      quote: "archive the dentist one, I already went.",
    });
    expect(adhoc.status).toBe(400);
    expect((await adhoc.json()).error).toMatch(/about no todo, batch, or block/);
  });

  // The weekly session's turns rule on what its agenda names — the todo and
  // batch ids the Friday job stored on the row (the lifeos update, phase 8) —
  // and on nothing else: not a todo the agenda did not name, never code.
  it("binds a weekly session's turns to the subjects its agenda names", async () => {
    const t = convexTest({ schema, modules });
    const { tom, todoId } = await sessionWithTurns(t, "adhoc");
    const { batchId, otherId } = await t.run(async (ctx) => {
      const now = Date.now();
      const batchId = await ctx.db.insert("batches", {
        statement: "the paper",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const otherId = await ctx.db.insert("dtsTodos", {
        statement: "renew the passport",
        status: "active",
        readiness: "unprepared",
        timingClass: "whenever",
        source: "tom",
        createdAt: now,
        updatedAt: now,
      });
      return { batchId, otherId };
    });
    // The job's pen: the agenda names the dentist todo and the paper batch.
    const sessionId = await t.mutation(internal.claudeSessions.internalCreateWeeklySession, {
      title: "Weekly 2026-09-11",
      initialPrompt: "the agenda",
      day: "2026-09-11",
      agendaSubjects: [todoId, batchId],
    });
    await tom.mutation(api.claudeSessions.sendMessage, {
      sessionId,
      text: "fork 1: archive the dentist one. fork 2: approve the paper batch. and archive the passport one.",
    });
    const turn = (
      await t.run(async (ctx) => ctx.db.query("claudeInbound").collect())
    ).find((r) => r.sessionId === sessionId && r.author === "tom")!;
    const life = await post(t, {
      inboundId: turn._id,
      verdict: "archive",
      subjectType: "life",
      subjectId: todoId,
      quote: "fork 1: archive the dentist one.",
    });
    expect(life.status).toBe(200);
    const batch = await post(t, {
      inboundId: turn._id,
      verdict: "approve",
      subjectType: "batch",
      subjectId: batchId,
      quote: "fork 2: approve the paper batch.",
    });
    expect(batch.status).toBe(200);
    // A todo the agenda did not name: refused as not what the session was
    // about, even though the turn mentions it.
    const unnamed = await post(t, {
      inboundId: turn._id,
      verdict: "archive",
      subjectType: "life",
      subjectId: otherId,
      quote: "and archive the passport one.",
    });
    expect(unnamed.status).toBe(400);
    expect((await unnamed.json()).error).toMatch(/its agenda names/);
    const code = await post(t, {
      inboundId: turn._id,
      verdict: "approve",
      subjectType: "code",
      subjectId: "ComplexMultiTrigger 42",
      quote: "fork 2: approve the paper batch.",
    });
    expect(code.status).toBe(400);
    const rulings = await tom.query(api.ttsRulings.listRulings, {});
    expect(rulings.map((r) => r.verdict).sort()).toEqual(["approve", "archive"]);
  });

  // A weekly session opened from the page carries no agenda, so its turns
  // rule on nothing — the kind alone opens no subject.
  it("refuses every subject from a weekly session with no agenda", async () => {
    const t = convexTest({ schema, modules });
    const { tom, todoId } = await sessionWithTurns(t, "adhoc");
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "Weekly by hand",
      kind: "weekly",
      repo: "none",
      initialPrompt: "no agenda",
    });
    await tom.mutation(api.claudeSessions.sendMessage, {
      sessionId,
      text: "archive the dentist one.",
    });
    const turn = (
      await t.run(async (ctx) => ctx.db.query("claudeInbound").collect())
    ).find((r) => r.sessionId === sessionId && r.author === "tom")!;
    const res = await post(t, {
      inboundId: turn._id,
      verdict: "archive",
      subjectType: "life",
      subjectId: todoId,
      quote: "archive the dentist one.",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/the 0 subject\(s\) its agenda names/);
  });

  // A block session is about the todos of its category — those its opening
  // prompt listed — and nothing else.
  it("binds a block session's turns to the todos of its category", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const tom = await withTom(t);
    const choreId = await tom.mutation(api.tts.createTodo, {
      statement: "descale the kettle",
      category: "chores",
    });
    const otherId = await tom.mutation(api.tts.createTodo, {
      statement: "renew the passport",
      category: "admin",
    });
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "chores block",
      kind: "block",
      blockCategory: "chores",
      repo: "none",
      initialPrompt: "hello",
    });
    await tom.mutation(api.claudeSessions.sendMessage, {
      sessionId,
      text: "archive the kettle one, it is fine now.",
    });
    const turn = (
      await t.run(async (ctx) => ctx.db.query("claudeInbound").collect())
    ).find((r) => r.author === "tom")!;
    const body = {
      inboundId: turn._id,
      verdict: "archive",
      subjectType: "life",
      quote: "archive the kettle one, it is fine now.",
    };
    const other = await post(t, { ...body, subjectId: otherId });
    expect(other.status).toBe(400);
    expect((await other.json()).error).toMatch(/session about the "chores" block/);
    expect((await post(t, { ...body, subjectId: choreId })).status).toBe(200);
    expect(await tom.query(api.ttsRulings.listRulings, {})).toHaveLength(1);
  });
});
