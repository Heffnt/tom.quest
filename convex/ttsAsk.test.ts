import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  CAP_REFUSAL,
  DELEGATE_DECISION,
  DELEGATE_MAX_PER_JOB,
  DELEGATE_MAX_PER_SESSION,
} from "./ttsAsk";
import { insertTodo } from "../test/core-tables";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const KEY = "worker-key";

async function seedTodo(t: TestConvex<typeof schema>, statement: string) {
  return await t.run(async (ctx) =>
    insertTodo(ctx, {
      statement,
      status: "active",
      readiness: "prepared",
      timingClass: "whenever",
      source: "tom",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function seedSession(
  t: TestConvex<typeof schema>,
  mode?: "autonomous" | "interactive",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("claudeSessions", {
      title: "a session",
      kind: "focus-item",
      repo: "none",
      status: "idle",
      statusChangedAt: Date.now(),
      nextSeq: 0,
      createdAt: Date.now(),
      ...(mode === undefined ? {} : { mode }),
    }),
  );
}

const body = (over: Record<string, unknown> = {}) => ({
  askId: "3f9c1a22",
  question: "Do I move the passport appointment to Thursday, or leave it Wednesday?",
  options: [
    "Move it to Thursday morning.",
    "Leave it Wednesday and warn him it may be shut.",
  ],
  recommendation: "Move it to Thursday morning.",
  fallback: "Leave it Wednesday and say so in the outcome summary.",
  decision: "Move it to Thursday morning.",
  reason: "The consulate closes Wednesdays in September, so Wednesday is not an appointment.",
  refused: false,
  refusedBecause: null,
  model: "fable",
  ms: 41_200,
  promptSha: "9c1a22b0",
  ...over,
});

function post(t: TestConvex<typeof schema>, payload: Record<string, unknown>) {
  return t.fetch("/tts/ask", {
    method: "POST",
    headers: { "X-TTS-Key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const rows = (t: TestConvex<typeof schema>) =>
  t.run(async (ctx) =>
    ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", DELEGATE_DECISION))
      .collect(),
  );

describe("POST /tts/ask — the delegate's record", () => {
  // A decision taken schedules its phone notification (convex/pushSend.ts
  // sendToAll); held timers keep it a scheduled row the tests read, never a
  // send.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("writes one row keyed by the askId, with the todo on the column", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const todoId = await seedTodo(t, "renew passport");
    const sessionId = await seedSession(t, "autonomous");

    const first = await post(t, body({ sessionId, todoId }));
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.ok).toBe(true);
    expect(firstBody.askId).toBe("3f9c1a22");
    expect(firstBody.attended).toBe(false);
    expect(firstBody.capped).toBe(false);
    expect(firstBody.priorObjections).toEqual([]);

    const written = await rows(t);
    expect(written).toHaveLength(1);
    expect(written[0].key).toBe("3f9c1a22");
    // The COLUMN, not only data: that is what puts the decision on the todo's
    // own timeline (dtsEvents.by_todo).
    expect(written[0].todoId).toBe(todoId);
    expect(written[0].data.decision).toBe("Move it to Thursday morning.");
    expect(written[0].data.promptSha).toBe("9c1a22b0");

    // Idempotent: the same askId a second time writes nothing.
    const second = await post(t, body({ sessionId, todoId, reason: "different" }));
    expect(second.status).toBe(200);
    expect((await second.json()).existing).toBe(true);
    expect(await rows(t)).toHaveLength(1);
  });

  it("refuses an ask from a session Tom is in, whatever the body said", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    // mode absent = interactive (convex/schema.ts).
    const sessionId = await seedSession(t);

    const response = await post(t, body({ sessionId }));
    expect(response.status).toBe(200);
    expect((await response.json()).attended).toBe(true);

    const [row] = await rows(t);
    expect(row.data.attended).toBe(true);
    expect(row.data.refused).toBe(true);
    expect(row.data.refusedBecause).toMatch(/^attended-session:/);
  });

  it("records the ask past the per-session cap rather than dropping it", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const sessionId = await seedSession(t, "autonomous");

    for (let i = 0; i < DELEGATE_MAX_PER_SESSION; i += 1) {
      const response = await post(t, body({ sessionId, askId: `0000000${i}` }));
      expect((await response.json()).capped).toBe(false);
    }
    const sixth = await post(t, body({ sessionId, askId: "aaaaaaaa" }));
    expect((await sixth.json()).capped).toBe(true);
    // Still written — a cap that dropped the row would hide exactly the
    // session that is asking too much.
    const written = await rows(t);
    expect(written).toHaveLength(DELEGATE_MAX_PER_SESSION + 1);
    expect(written.find((row) => row.key === "aaaaaaaa")!.data.capped).toBeUndefined();
    // witness: the capped row kept the delegate's answer as if it were taken,
    // so it read as a decision made in his name. The box took its fallback:
    // the row reads as refused, the cap its reason.
    const capped = written.find((row) => row.key === "aaaaaaaa")!;
    expect(capped.data).toMatchObject({ refused: true, refusedBecause: CAP_REFUSAL });
    expect(written.find((row) => row.key === "00000000")!.data).toMatchObject({ refused: false });
  });

  it("counts the cap per caller, so one session does not cap another", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const a = await seedSession(t, "autonomous");
    const b = await seedSession(t, "autonomous");
    for (let i = 0; i < DELEGATE_MAX_PER_SESSION; i += 1) {
      await post(t, body({ sessionId: a, askId: `1111111${i}` }));
    }
    const other = await post(t, body({ sessionId: b, askId: "bbbbbbbb" }));
    expect((await other.json()).capped).toBe(false);
  });

  it("counts a caller's asks among many other callers' asks in the day, before and after its own", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const others = (from: number) =>
      t.run(async (ctx) => {
        for (let i = 0; i < 300; i += 1) {
          await ctx.db.insert("dtsEvents", { at: Date.now() - 60_000, kind: DELEGATE_DECISION, key: `other${from + i}`, data: { job: `poll-${i % 7}`, sessionId: null } });
        }
      });
    await others(0);
    for (let i = 0; i < DELEGATE_MAX_PER_JOB; i += 1) {
      expect((await (await post(t, body({ job: "poll-gmail", askId: `2222222${i}` }))).json()).capped).toBe(false);
    }
    await others(300);
    expect((await (await post(t, body({ job: "poll-gmail", askId: "ffffffff" }))).json()).capped).toBe(true);
    // A day-old ask of its own no longer counts.
    const fresh = convexTest({ schema, modules });
    await fresh.run(async (ctx) => {
      for (let i = 0; i < DELEGATE_MAX_PER_JOB; i += 1) {
        await ctx.db.insert("dtsEvents", { at: Date.now() - 2 * 86_400_000, kind: DELEGATE_DECISION, key: `old${i}`, data: { job: "poll-gmail", sessionId: null } });
      }
    });
    expect((await (await post(fresh, body({ job: "poll-gmail" }))).json()).capped).toBe(false);
  });

  it("400s a refusal whose refusedBecause names no narrow-list id", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const sessionId = await seedSession(t, "autonomous");
    const response = await post(
      t,
      body({ sessionId, refused: true, refusedBecause: "I did not like the options" }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/narrow-list id/);
    expect(await rows(t)).toHaveLength(0);
  });

  it("accepts a refusal that starts with a narrow-list id", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const sessionId = await seedSession(t, "autonomous");
    const response = await post(
      t,
      body({
        sessionId,
        refused: true,
        refusedBecause:
          "message-in-his-name — writing to the consulate is a message to another human in his name.",
      }),
    );
    expect(response.status).toBe(200);
    expect((await rows(t))[0].data.refused).toBe(true);
  });

  it("400s a recommendation that is not one of the options", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const sessionId = await seedSession(t, "autonomous");
    const response = await post(
      t,
      body({ sessionId, recommendation: "Something else entirely." }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/recommendation/);
  });

  it("400s a body naming both a session and a job, or neither", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const sessionId = await seedSession(t, "autonomous");
    expect((await post(t, body({ sessionId, job: "poll-gmail" }))).status).toBe(400);
    expect((await post(t, body())).status).toBe(400);
  });

  it("records a null decision — the delegate did not answer", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const response = await post(
      t,
      body({
        job: "poll-gmail",
        decision: null,
        reason: "delegate answer unreadable: it depends on the week",
      }),
    );
    expect(response.status).toBe(200);
    const [row] = await rows(t);
    expect(row.data.decision).toBe(null);
    expect(row.data.job).toBe("poll-gmail");
  });

  it("writes the decision row itself, once, and none for an attended, capped or unanswered ask", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const decisions = () =>
      t.run(async (ctx) => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "decision")).collect());
    const response = await post(t, body({ job: "poll-gmail", restedOn: ["ruling:abc"], wouldChange: "A closed consulate." }));
    expect(response.status).toBe(200);
    await post(t, body({ job: "poll-gmail" })); // the same askId again: nothing new
    const [row, ...rest] = await decisions();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      subject: "3f9c1a22",
      provenance: { job: "poll-gmail" },
      data: {
        askId: "3f9c1a22",
        caller: "job:poll-gmail",
        decision: "Move it to Thursday morning.",
        restedOn: ["ruling:abc"],
        wouldChange: "A closed consulate.",
        refused: false,
        model: "fable",
      },
    });
    await post(t, body({ sessionId: await seedSession(t), askId: "cccccccc" })); // attended
    await post(t, body({ job: "poll-gmail", askId: "dddddddd", decision: null })); // no answer
    expect((await decisions()).map((d) => d.subject)).toEqual(["3f9c1a22"]);
    expect((await post(t, body({ job: "poll-gmail", askId: "eeeeeeee", restedOn: "ruling:abc" }))).status).toBe(400);
  });

  // Tom, 2026-10-04: "agreed. lets send notifications to my phone for this."
  it("pushes one notification for a decision taken, and none for a refusal or an ask that took nothing", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const pushes = async () =>
      (await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect()))
        .filter((job) => job.name.includes("sendToAll"))
        .map((job) => job.args[0]);

    expect((await post(t, body({ job: "poll-gmail" }))).status).toBe(200);
    expect(await pushes()).toEqual([
      {
        title: "Delegate decision",
        body: `${body().question}\n${body().decision}`,
        url: "/tts",
      },
    ]);
    // The same askId again writes no second row, so no second push.
    expect((await post(t, body({ job: "poll-gmail" }))).status).toBe(200);
    expect(await pushes()).toHaveLength(1);

    // A refusal writes its decision row (the parked option) and pushes nothing.
    const refusal = await post(
      t,
      body({
        job: "poll-gmail",
        askId: "aaaaaaaa",
        refused: true,
        refusedBecause: "message-in-his-name — writing to the consulate is a message to another human in his name.",
      }),
    );
    expect(refusal.status).toBe(200);
    const refusedRow = await t.run(async (ctx) =>
      ctx.db.query("events").withIndex("by_kind_subject_at", (q) => q.eq("kind", "decision").eq("subject", "aaaaaaaa")).first(),
    );
    expect(refusedRow?.data).toMatchObject({ refused: true });
    // An attended ask, an unanswered one and a capped one write no row and push nothing.
    await post(t, body({ sessionId: await seedSession(t), askId: "cccccccc" }));
    await post(t, body({ job: "poll-gmail", askId: "dddddddd", decision: null }));
    // poll-gmail's fourth ask in a day (3f9c1a22, aaaaaaaa, dddddddd before it) is past its cap.
    expect(DELEGATE_MAX_PER_JOB).toBe(3);
    expect(await (await post(t, body({ job: "poll-gmail", askId: "ffffffff" }))).json()).toMatchObject({ capped: true });
    expect(await pushes()).toHaveLength(1);
  });

  it("puts the question and the decision on one line each, redacted, and cuts the decision at the question's limit", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    // Built by concatenation, so no credential-shaped literal sits in the source.
    const token = "ghp_" + "A".repeat(36);
    const question = `Do I\n  paste ${token}\u0007 and keep the long branch?`;
    // POST /tts/ask caps the question at 400 characters and the decision not at all.
    const long = `Keep it: ${"very ".repeat(100)}long.`;
    await post(t, body({ job: "poll-gmail", question, options: [long, "Drop it."], recommendation: long, decision: long }));
    const [push] = (await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect()))
      .filter((job) => job.name.includes("sendToAll"))
      .map((job) => job.args[0] as { body: string });
    const [first, second, ...rest] = push.body.split("\n");
    expect(rest).toEqual([]);
    expect(push.body).not.toContain(token);
    expect(first).toBe("Do I paste [redacted:github] and keep the long branch?");
    expect(second.startsWith("Keep it: very very")).toBe(true);
    expect(second.length).toBeLessThanOrEqual(400);
    expect(second.endsWith("…")).toBe(true);
  });

  it("a retry of an ask recorded before the decision row was written here writes it, once", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const decisions = () =>
      t.run(async (ctx) => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "decision")).collect());
    // The ask row as the old mutation left it: no decision row beside it.
    await t.run(async (ctx) =>
      ctx.db.insert("dtsEvents", {
        at: Date.now(), kind: DELEGATE_DECISION, key: "3f9c1a22",
        data: { ...body({ job: "poll-gmail" }), sessionId: null, todoId: null, attended: false },
      }),
    );
    // A retry that contradicts the recorded ask is refused and writes nothing.
    const contradicts = await post(t, body({ job: "poll-gmail", decision: "Leave it Wednesday and warn him it may be shut." }));
    expect(contradicts.status).toBe(400);
    expect((await contradicts.json()).error).toContain("already recorded for a different ask");
    expect((await post(t, body({ job: "poll-canvas" }))).status).toBe(400);
    // A todo id that names no todo is not "no todo".
    expect((await post(t, body({ job: "poll-gmail", todoId: "no-such-todo" }))).status).toBe(400);
    expect(await decisions()).toEqual([]);
    // The same ask again: its decision row, built from the ask as recorded,
    // whatever else the retry's body carries.
    expect((await (await post(t, body({ job: "poll-gmail", restedOn: ["ruling:abc"], reason: "another reason" }))).json()).existing).toBe(true);
    await post(t, body({ job: "poll-gmail" }));
    expect(await decisions()).toEqual([
      expect.objectContaining({
        subject: "3f9c1a22",
        provenance: { job: "poll-gmail" },
        data: expect.objectContaining({ caller: "job:poll-gmail", decision: "Move it to Thursday morning.", reason: body().reason, restedOn: [] }),
      }),
    ]);
    // A capped ask took nothing in his name: its retry writes no decision.
    await t.run(async (ctx) =>
      ctx.db.insert("dtsEvents", {
        at: Date.now(), kind: DELEGATE_DECISION, key: "abababab",
        data: { ...body({ job: "poll-gmail", askId: "abababab" }), refused: true, refusedBecause: CAP_REFUSAL, attended: false },
      }),
    );
    await post(t, body({ job: "poll-gmail", askId: "abababab" }));
    expect(await decisions()).toHaveLength(1);
  });

  it("a retry names the recorded todo in either id form, whichever form the ask stored", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    // A todo from before step C: its old row, and the plain copy naming it.
    const fields = { statement: "renew passport", status: "active" as const, readiness: "prepared" as const, timingClass: "whenever" as const, source: "tom", createdAt: Date.now(), updatedAt: Date.now() };
    const { todoId, legacy } = await t.run(async (ctx) => {
      const legacy = await ctx.db.insert("dtsTodos", fields);
      return { legacy, todoId: await ctx.db.insert("todos", { ...fields, legacyId: legacy }) };
    });
    const other = await seedTodo(t, "book the dentist");
    // An ask recorded before the stored references went plain: the old id.
    await t.run(async (ctx) =>
      ctx.db.insert("dtsEvents", {
        at: Date.now(), kind: DELEGATE_DECISION, key: "3f9c1a22",
        data: { ...body({ job: "poll-gmail" }), sessionId: null, todoId: legacy, attended: false },
      }),
    );
    const decision = async (askId: string) =>
      (await t.run(async (ctx) => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "decision")).collect()))
        .find((row) => row.subject === askId)?.data as { todoId?: string } | undefined;
    expect((await (await post(t, body({ job: "poll-gmail", todoId }))).json()).existing).toBe(true);
    // The retry's decision row names the plain todo, though the ask stored the old id.
    expect((await decision("3f9c1a22"))!.todoId).toBe(todoId);
    expect((await (await post(t, body({ job: "poll-gmail", todoId: legacy }))).json()).existing).toBe(true);
    expect((await post(t, body({ job: "poll-gmail", todoId: other }))).status).toBe(400);
    expect((await post(t, body({ job: "poll-gmail" }))).status).toBe(400);
    // An ask recorded now stores the plain id, and its retry may name the old.
    expect((await post(t, body({ job: "poll-gmail", askId: "cdcdcdcd", todoId }))).status).toBe(200);
    expect((await rows(t)).find((row) => row.key === "cdcdcdcd")!.data.todoId).toBe(todoId);
    expect((await (await post(t, body({ job: "poll-gmail", askId: "cdcdcdcd", todoId: legacy }))).json()).existing).toBe(true);
  });

  it("an objection lands on the ask's todo as the plain row, and on none when the stored id names no row", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const fields = { statement: "renew passport", status: "active" as const, readiness: "prepared" as const, timingClass: "whenever" as const, source: "tom", createdAt: Date.now(), updatedAt: Date.now() };
    const { todoId, legacy, gone } = await t.run(async (ctx) => {
      const legacy = await ctx.db.insert("dtsTodos", fields);
      const gone = await ctx.db.insert("dtsTodos", fields);
      await ctx.db.delete(gone);
      return { legacy, gone, todoId: await ctx.db.insert("todos", { ...fields, legacyId: legacy }) };
    });
    // Asks recorded before the stored references went plain: the old id, and
    // one whose id was checked for form only.
    for (const [askId, stored] of [["aaaa0001", legacy], ["aaaa0002", gone]] as const) {
      await t.run(async (ctx) =>
        ctx.db.insert("dtsEvents", {
          at: Date.now(), kind: DELEGATE_DECISION, key: askId, todoId: stored,
          data: { ...body({ job: "poll-gmail", askId }), sessionId: null, todoId: stored, attended: false },
        }),
      );
    }
    const objected = async (askId: string) => {
      const eventId = await t.mutation(internal.ttsAsk.internalRecordDelegateObjection, {
        askId, text: "revert", revert: true, sentence: null, channel: "C", ts: "1.2", threadTs: "1.1",
      });
      return await t.run(async (ctx) => (await ctx.db.get(eventId))!.todoId ?? null);
    };
    expect(await objected("aaaa0001")).toBe(todoId);
    expect(await objected("aaaa0002")).toBeNull();
  });

  it("refuses a decision by Tom, a transport removed with needs-you", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const response = await post(t, body({ job: "poll-gmail", decidedBy: "tom", needsTomId: "delegate-ask:3f9c1a22" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('decidedBy, when given, is "delegate"');
    expect(await rows(t)).toEqual([]);
  });

  it("refuses an unauthenticated caller", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const response = await t.fetch("/tts/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body({ job: "poll-gmail" })),
    });
    expect(response.status).toBe(401);
  });
});

describe("POST /tts/ask — the wait for Tom is stored", () => {
  // A delegate decision schedules its push (tom.quest #340); held timers keep
  // it a scheduled row, never a send after the test's teardown.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("keeps waitedMs and waitNote on the ask and the decision row, and refuses a negative wait", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const waited = await post(
      t,
      body({ job: "poll-gmail", waitedMs: 7_200_000, waitNote: "no answer from Tom on /thread in 120 minutes; the delegate decided" }),
    );
    expect(waited.status).toBe(200);
    const [row] = await t.run(async (ctx) => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "decision")).collect());
    // The caller sent no decidedBy, so the row carries none: absence is the delegate.
    expect(row.data.decidedBy).toBeUndefined();
    expect(row.data).toMatchObject({
      waitedMs: 7_200_000,
      waitNote: "no answer from Tom on /thread in 120 minutes; the delegate decided",
    });
    expect((await rows(t))[0].data).toMatchObject({ waitedMs: 7_200_000 });
    // An ask that was not a trade-off records no wait, as before.
    await post(t, body({ job: "poll-canvas", askId: "c0ffee00" }));
    const plain = await t.run(async (ctx) =>
      ctx.db.query("events").withIndex("by_kind_subject_at", (q) => q.eq("kind", "decision").eq("subject", "c0ffee00")).first(),
    );
    expect(plain!.data.waitedMs).toBeUndefined();
    // A negative wait is refused.
    expect((await post(t, body({ job: "poll-gmail", askId: "7e000002", waitedMs: -1 }))).status).toBe(400);
  });
});

// POST /tts/merge and its mechanical gate are convex/ttsMerge.test.ts:
// merging is not a delegate decision, and the gate is what decides it.

describe("GET /tts/state serves the narrow list", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("carries every item's id and both renderings", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const response = await t.fetch("/tts/state", {
      method: "GET",
      headers: { "X-TTS-Key": KEY },
    });
    expect(response.status).toBe(200);
    const state = await response.json();
    expect(state.narrowList.map((item: { id: string }) => item.id)).toEqual([
      "money",
      "message-in-his-name",
      "irreversible-deletion",
      "credential",
    ]);
    for (const item of state.narrowList) {
      expect(item.decision).toBeTruthy();
      expect(item.command).toBeTruthy();
    }
  });
});

describe("GET /jarvis/context?for=ask tomLastTurnAt", () => {
  const THERAPY_WORDS = "words said only in the therapy session";
  const ORDINARY_WORDS = "words said in an ordinary session";

  async function contextForAsk(t: TestConvex<typeof schema>): Promise<{ text: string; body: Record<string, unknown> }> {
    const res = await t.fetch("/jarvis/context?for=ask&job=work-queue", { headers: { "X-Jarvis-Key": KEY } });
    expect(res.status).toBe(200);
    const text = await res.text();
    return { text, body: JSON.parse(text) };
  }

  it("is the time of his newest turn in any session, a therapy session included, and carries no turn's text", async () => {
    vi.stubEnv("JARVIS_KEY", KEY);
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const session = (kind: "adhoc" | "therapy") =>
        ctx.db.insert("claudeSessions", { title: kind, kind, repo: "none", status: "running", statusChangedAt: 1, nextSeq: 0, createdAt: 1 });
      const ordinary = await session("adhoc");
      const therapy = await session("therapy");
      // Inserted in time order: the index orders his rows by creation.
      await ctx.db.insert("claudeInbound", { sessionId: ordinary, kind: "user-turn", author: "tom", text: ORDINARY_WORDS, status: "done", createdAt: 1_000 });
      await ctx.db.insert("claudeInbound", { sessionId: therapy, kind: "user-turn", author: "tom", text: THERAPY_WORDS, status: "done", createdAt: 2_000 });
      // An agent's turn and a stop of his after it are not his turns.
      await ctx.db.insert("claudeInbound", { sessionId: ordinary, kind: "user-turn", author: "agent", text: "an agent's pen", status: "done", createdAt: 3_000 });
      await ctx.db.insert("claudeInbound", { sessionId: therapy, kind: "stop", author: "tom", status: "done", createdAt: 4_000 });
    });
    const { text, body } = await contextForAsk(t);
    expect(body.tomLastTurnAt).toBe(2_000);
    expect(text).not.toContain(THERAPY_WORDS);
    expect(text).not.toContain(ORDINARY_WORDS);
  });

  it("is null when he has no turn on the record", async () => {
    vi.stubEnv("JARVIS_KEY", KEY);
    const t = convexTest(schema, modules);
    expect((await contextForAsk(t)).body.tomLastTurnAt).toBe(null);
  });
});
