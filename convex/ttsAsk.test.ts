import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import {
  DELEGATE_DECISION,
  DELEGATE_MAX_PER_SESSION,
  objectionRank,
  stripNarrowListId,
  type ObjectionFact,
} from "./ttsAsk";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const KEY = "worker-key";

async function seedTodo(t: ReturnType<typeof convexTest>, statement: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("dtsTodos", {
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
  t: ReturnType<typeof convexTest>,
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

function post(t: ReturnType<typeof convexTest>, payload: Record<string, unknown>) {
  return t.fetch("/tts/ask", {
    method: "POST",
    headers: { "X-TTS-Key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const rows = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) =>
    ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", DELEGATE_DECISION))
      .collect(),
  );

describe("POST /tts/ask — the delegate's record", () => {
  afterEach(() => vi.unstubAllEnvs());

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
    expect(written.find((row) => row.key === "aaaaaaaa")!.data.capped).toBe(true);
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

describe("POST /tts/merge — the merge report", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("writes one row per merged sha, and a retry writes nothing", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const todoId = await seedTodo(t, "the delegate lands");
    const merge = (over: Record<string, unknown> = {}) =>
      t.fetch("/tts/merge", {
        method: "POST",
        headers: { "X-TTS-Key": KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: "tom.quest",
          sha: "5ad4b21",
          subject: "the delegate and the objection list",
          todoId,
          ...over,
        }),
      });
    expect((await merge()).status).toBe(200);
    const retried = await merge();
    expect((await retried.json()).existing).toBe(true);
    const written = await t.run(async (ctx) =>
      ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_at", (q) => q.eq("kind", "merge"))
        .collect(),
    );
    expect(written).toHaveLength(1);
    expect(written[0].key).toBe("tom.quest:5ad4b21");
    expect(written[0].todoId).toBe(todoId);
  });

  it("400s a report missing its repo, sha or subject", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const response = await t.fetch("/tts/merge", {
      method: "POST",
      headers: { "X-TTS-Key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "tom.quest", sha: "5ad4b21" }),
    });
    expect(response.status).toBe(400);
  });
});

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
