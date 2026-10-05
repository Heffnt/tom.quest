import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { gatherTodayFacts } from "./ttsDigest";
import { nyCalendarDayKey } from "./ttsShared";
import {
  CAP_REFUSAL,
  DELEGATE_DECISION,
  DELEGATE_MAX_PER_JOB,
  DELEGATE_MAX_PER_SESSION,
  objectionRank,
  stripNarrowListId,
  type ObjectionFact,
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
    // so the digest listed it as a decision made in his name. The box took
    // its fallback: the row reads as refused, the cap its reason, and the
    // digest parks it rather than listing a decision.
    const capped = written.find((row) => row.key === "aaaaaaaa")!;
    expect(capped.data).toMatchObject({ refused: true, refusedBecause: CAP_REFUSAL });
    const facts = await t.run(async (ctx) => {
      const now = Date.now() + 1;
      return await gatherTodayFacts(ctx, { day: nyCalendarDayKey(now), now, since: now - 86_400_000 });
    });
    expect(facts.objections.find((o) => o.askId === "aaaaaaaa")).toMatchObject({ refused: true, refusedBecause: CAP_REFUSAL });
    expect(facts.objections.find((o) => o.askId === "00000000")).toMatchObject({ refused: false });
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
        url: "/intent#decision-3f9c1a22",
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

// The needs-you item a trade-off was shown to Tom as, as POST /tts/needs-tom
// stores it (convex/ttsSlack.ts internalOpenNeedsTomThread): the question and
// the options he read, which his reply's letter is read against.
async function showItem(t: TestConvex<typeof schema>, key: string) {
  await t.run(async (ctx) =>
    ctx.db.insert("dtsEvents", {
      at: Date.now(),
      kind: "needs-tom",
      key,
      data: { key, reason: "It recommends a.", question: body().question, options: body().options },
    }),
  );
}

// A DECISION BY TOM: Jarvis `jarvis decide --trade-off` (Jarvis #262) held a
// question for him on /thread, and his numbered reply is the decision. The
// record writes it only when his own needs-tom-answered row backs it.
describe("POST /tts/ask — a decision by Tom", () => {
  afterEach(() => vi.unstubAllEnvs());

  const KEY_OF = "delegate-ask:3f9c1a22";
  const decisionsOf = (t: TestConvex<typeof schema>) =>
    t.run(async (ctx) => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "decision")).collect());
  // His reply as tom.quest #339 writes it: subject the item's key, his provenance.
  const answer = (t: TestConvex<typeof schema>, said: string, over: Record<string, unknown> = {}) =>
    t.run(async (ctx) =>
      ctx.db.insert("events", {
        kind: "needs-tom-answered",
        at: Date.now(),
        provenance: { user: "tom" },
        subject: KEY_OF,
        data: { answer: said, via: "thread" },
        ...over,
      }),
    );
  const byTom = (over: Record<string, unknown> = {}) =>
    body({
      job: "poll-gmail",
      decision: "Leave it Wednesday and warn him it may be shut.",
      reason: 'Tom answered on /thread: "b"',
      model: "tom",
      ms: 0,
      promptSha: "tom-answer",
      decidedBy: "tom",
      needsTomId: KEY_OF,
      waitedMs: 180_000,
      waitNote: "Tom answered on /thread after 3 minutes",
      ...over,
    });

  it("writes his answer as a decision row in his name, naming the reply that backs it", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    await showItem(t, KEY_OF);
    const replyId = await answer(t, "b");
    const response = await post(t, byTom());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, attended: false, capped: false });
    const [row, ...rest] = await decisionsOf(t);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      subject: "3f9c1a22",
      provenance: { user: "tom" },
      data: {
        caller: "job:poll-gmail",
        decision: "Leave it Wednesday and warn him it may be shut.",
        decidedBy: "tom",
        waitedMs: 180_000,
        waitNote: "Tom answered on /thread after 3 minutes",
        needsTomId: KEY_OF,
        answerEventId: replyId,
        refused: false,
      },
    });
    // The ask row keeps the same facts, so a retry rebuilds the same row.
    const [ask] = await rows(t);
    expect(ask.data).toMatchObject({ decidedBy: "tom", waitedMs: 180_000, answerEventId: replyId, refused: false, attended: false });
  });

  it("takes his own words as the decision when they name no option", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    await showItem(t, KEY_OF);
    await answer(t, "Ask the consulate first.");
    expect((await post(t, byTom({ decision: "Ask the consulate first." }))).status).toBe(200);
    expect((await decisionsOf(t))[0].data.decision).toBe("Ask the consulate first.");
  });

  it("refuses a decision by Tom that no answer of his backs, and writes nothing", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    await showItem(t, KEY_OF);
    const refusal = async (payload: Record<string, unknown>) => {
      const response = await post(t, payload);
      expect(response.status).toBe(400);
      return ((await response.json()) as { error: string }).error;
    };
    // No reply of his under the item.
    expect(await refusal(byTom())).toContain("no answer of Tom's to delegate-ask:3f9c1a22");
    // A reply under the item that was not written as his.
    await answer(t, "b", { provenance: { job: "thread-reply" } });
    expect(await refusal(byTom())).toContain("was not written as Tom's");
    // His reply names option b; the body claims option a.
    await answer(t, "b");
    expect(await refusal(byTom({ decision: "Move it to Thursday morning." }))).toContain("is not what Tom's answer");
    // His reply to another ask's item cannot back this one.
    expect(await refusal(byTom({ needsTomId: "delegate-ask:0badc0de" }))).toContain("names this ask's needs-you item");
    expect(await rows(t)).toEqual([]);
    expect(await decisionsOf(t)).toEqual([]);
    // The route's own shape checks.
    expect(await refusal(byTom({ needsTomId: undefined }))).toContain("names needsTomId");
    expect(await refusal(byTom({ refused: true, refusedBecause: "money — a payment" }))).toContain("refused false");
    expect(await refusal(byTom({ decision: null }))).toContain("decision set");
    expect(await refusal(body({ job: "poll-gmail", needsTomId: KEY_OF }))).toContain('only with decidedBy "tom"');
    expect(await refusal(body({ job: "poll-gmail", decidedBy: "someone" }))).toContain('"delegate" or "tom"');
    // Backed, the same body is written.
    expect((await post(t, byTom())).status).toBe(200);
    expect(await decisionsOf(t)).toHaveLength(1);
  });

  it("reads his letter against the question and options he was shown, not the caller's", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const refusal = async (payload: Record<string, unknown>) => {
      const response = await post(t, payload);
      expect(response.status).toBe(400);
      return ((await response.json()) as { error: string }).error;
    };
    await answer(t, "b");
    // No question with options was stored on the item: his "b" names nothing.
    expect(await refusal(byTom())).toContain("holds no question with options shown to Tom");
    await showItem(t, KEY_OF);
    // The same "b" against the options swapped: b is now "Move it to Thursday
    // morning.", which he did not choose. Refused, and nothing is written.
    const swapped = [...body().options].reverse();
    expect(await refusal(byTom({ options: swapped, recommendation: swapped[0], decision: swapped[1] }))).toContain(
      "the options are not the ones Tom was shown",
    );
    // A third option added, or the question changed, is refused the same way.
    expect(await refusal(byTom({ options: [...body().options, "Cancel it."] }))).toContain("the options are not the ones Tom was shown");
    expect(await refusal(byTom({ question: "Do I cancel the passport appointment?" }))).toContain("the question is not the one Tom was shown");
    expect(await rows(t)).toEqual([]);
    expect(await decisionsOf(t)).toEqual([]);
    // The options he was shown: his "b" is option b.
    expect((await post(t, byTom())).status).toBe(200);
    expect((await decisionsOf(t))[0].data.decision).toBe("Leave it Wednesday and warn him it may be shut.");
  });

  it("sends no push for his own decision", async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv("TTS_WORKER_KEY", KEY);
      const t = convexTest({ schema, modules });
      await showItem(t, KEY_OF);
    await showItem(t, KEY_OF);
      await answer(t, "b");
      expect((await post(t, byTom())).status).toBe(200);
      const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
      expect(scheduled.filter((job) => job.name.includes("pushSend"))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes neither the attended check nor the cap, and does not spend the caller's cap", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    await showItem(t, KEY_OF);
    await answer(t, "b");
    const attended = await seedSession(t);
    const own = await post(t, byTom({ job: undefined, sessionId: attended }));
    expect(await own.json()).toMatchObject({ attended: false, capped: false });
    expect((await decisionsOf(t))[0].data.refused).toBe(false);
    // Three decisions of his for poll-gmail leave its three delegate asks intact.
    for (const askId of ["7a000001", "7a000002", "7a000003"]) {
      await showItem(t, `delegate-ask:${askId}`);
      await t.run(async (ctx) =>
        ctx.db.insert("events", {
          kind: "needs-tom-answered", at: Date.now(), provenance: { user: "tom" },
          subject: `delegate-ask:${askId}`, data: { answer: "a", via: "thread" },
        }),
      );
      const response = await post(t, byTom({ askId, needsTomId: `delegate-ask:${askId}`, decision: "Move it to Thursday morning." }));
      expect(response.status).toBe(200);
    }
    for (const askId of ["7b000001", "7b000002", "7b000003"]) {
      expect(await (await post(t, body({ job: "poll-gmail", askId }))).json()).toMatchObject({ capped: false });
    }
    expect(await (await post(t, body({ job: "poll-gmail", askId: "7b000004" }))).json()).toMatchObject({ capped: true });
  });
});

describe("POST /tts/ask — the wait for Tom is stored", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps waitedMs and waitNote on the ask and the decision row, and the digest says who decided after how long", async () => {
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
    await showItem(t, "delegate-ask:7e000001");
    await t.run(async (ctx) =>
      ctx.db.insert("events", {
        kind: "needs-tom-answered", at: Date.now(), provenance: { user: "tom" },
        subject: "delegate-ask:7e000001", data: { answer: "a", via: "thread" },
      }),
    );
    await post(t, body({
      job: "poll-gmail", askId: "7e000001", decidedBy: "tom", needsTomId: "delegate-ask:7e000001",
      model: "tom", promptSha: "tom-answer", ms: 0, waitedMs: 720_000,
    }));
    // A negative wait is refused.
    expect((await post(t, body({ job: "poll-gmail", askId: "7e000002", waitedMs: -1 }))).status).toBe(400);

    const facts = await t.run(async (ctx) => {
      const now = Date.now() + 1;
      return await gatherTodayFacts(ctx, { day: nyCalendarDayKey(now), now, since: now - 86_400_000 });
    });
    // One line per decision (#354), read from its decision row.
    const of = (askId: string) => facts.objections.filter((o) => o.askId === askId);
    expect(of("3f9c1a22")).toEqual([expect.objectContaining({ decidedByText: "decided by the delegate after waiting 120 minutes" })]);
    expect(of("c0ffee00")).toHaveLength(1);
    expect(of("c0ffee00")[0].decidedByText).toBeUndefined();
    expect(of("7e000001")).toEqual([expect.objectContaining({ decidedByTom: true, decidedByText: "decided by Tom after 12 minutes" })]);
    expect(facts.objectionTom).toBe(1);
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

describe("objectionRank", () => {
  const fact = (over: Partial<ObjectionFact>): ObjectionFact => ({
    askId: "a",
    at: 0,
    todoId: null,
    decision: "took it",
    reason: "because",
    refused: false,
    refusedBecause: null,
    fallback: "the fallback",
    subject: null,
    objectedAt: null,
    ...over,
  });
  const due = new Set(["due"]);
  const ready = new Set(["ready"]);

  it("puts a refusal on a dated item first, then any refusal, then silence", () => {
    expect(objectionRank(fact({ refused: true, todoId: "due" }), ready, due)).toBe(0);
    expect(objectionRank(fact({ refused: true, todoId: "ready" }), ready, due)).toBe(1);
    expect(objectionRank(fact({ decision: null }), ready, due)).toBe(2);
  });

  it("then a decision on a dated item, a ready one, any todo, then the run itself", () => {
    expect(objectionRank(fact({ todoId: "due" }), ready, due)).toBe(3);
    expect(objectionRank(fact({ todoId: "ready" }), ready, due)).toBe(4);
    expect(objectionRank(fact({ todoId: "other" }), ready, due)).toBe(5);
    expect(objectionRank(fact({ todoId: null }), ready, due)).toBe(6);
  });

  it("orders a mixed list by tier, ties newest first", () => {
    const items = [
      fact({ askId: "plain", at: 10 }),
      fact({ askId: "refused-due", at: 1, refused: true, todoId: "due" }),
      fact({ askId: "silent-old", at: 1, decision: null }),
      fact({ askId: "silent-new", at: 2, decision: null }),
      fact({ askId: "refused", at: 9, refused: true }),
    ];
    const sorted = [...items].sort(
      (a, b) => objectionRank(a, ready, due) - objectionRank(b, ready, due) || b.at - a.at,
    );
    expect(sorted.map((item) => item.askId)).toEqual([
      "refused-due",
      "refused",
      "silent-new",
      "silent-old",
      "plain",
    ]);
  });
});

describe("stripNarrowListId", () => {
  it("drops the id and keeps the sentence", () => {
    expect(
      stripNarrowListId("message-in-his-name — a message to another human in your name"),
    ).toBe("a message to another human in your name");
  });

  it("is a no-op on a sentence carrying no id", () => {
    expect(stripNarrowListId("  a message to another human  ")).toBe(
      "a message to another human",
    );
  });
});
