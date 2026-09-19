import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { answererFor, runnerStatus, type RunnerSeed } from "./ttsRunners";
import type { RunnerTier } from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const KEY = "worker-key";
const TEN_MINUTES = 10 * 60_000;

export function seed(over: Partial<RunnerSeed> = {}): RunnerSeed {
  return {
    title: "TRAIN25 campaign",
    type: "probe",
    experimentHost: "turing",
    repo: "ComplexMultiTrigger",
    stepMs: TEN_MINUTES,
    delegateAllowed: false,
    from: { kind: "document", text: "# TRAIN25\n\n## Objective\n\nWatch the sweep.\n" },
    ...over,
  };
}

function post(t: TestConvex<typeof schema>, body: unknown) {
  return t.fetch("/tts/runner", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TTS-Key": KEY },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("runnerStatus", () => {
  it("derives every status from the ending and the open blocking asks", () => {
    expect(runnerStatus({ runner: {}, openBlockingAsks: 0 })).toBe("running");
    expect(runnerStatus({ runner: {}, openBlockingAsks: 1 })).toBe("waiting-on-tom");
    expect(runnerStatus({ runner: { endedAt: 1, endedReason: "finish" }, openBlockingAsks: 0 })).toBe("done");
    expect(runnerStatus({ runner: { endedAt: 1, endedReason: "hand-off" }, openBlockingAsks: 0 })).toBe("handed-off");
    expect(runnerStatus({ runner: { endedAt: 1, endedReason: "failed" }, openBlockingAsks: 0 })).toBe("failed");
    // An ended runner is ended whatever it was still asking.
    expect(runnerStatus({ runner: { endedAt: 1, endedReason: "finish" }, openBlockingAsks: 2 })).toBe("done");
  });
});

describe("answererFor", () => {
  const campaign = { type: "campaign" as const, delegateAllowed: true };
  const probe = { type: "probe" as const, delegateAllowed: true };
  const cell = (runner: Parameters<typeof answererFor>[0], tier: RunnerTier, knownAway = false, stepsUnanswered = 0) =>
    answererFor(runner, tier, { knownAway, stepsUnanswered });

  it("answers every campaign cell as the rubric says", () => {
    expect(cell(campaign, "routine").answerer).toBe("self");
    expect(cell(campaign, "plan").answerer).toBe("tom");
    expect(cell(campaign, "plan", false, 1).answerer).toBe("delegate");
    expect(cell(campaign, "setup").answerer).toBe("tom");
    const away = cell(campaign, "setup", true);
    expect(away.answerer).toBe("delegate");
    expect(away.marked).toBe(true);
  });

  it("answers every probe cell as the rubric says", () => {
    expect(cell(probe, "routine").answerer).toBe("self");
    expect(cell(probe, "plan").answerer).toBe("delegate");
    expect(cell(probe, "setup").answerer).toBe("delegate");
    expect(cell(probe, "setup", true).marked).toBe(false);
  });

  it("replaces a cell with the runner's override", () => {
    const runner = { ...campaign, askOverrides: [{ tier: "routine" as const, answerer: "tom" as const }] };
    expect(cell(runner, "routine").answerer).toBe("tom");
    expect(cell(runner, "plan").answerer).toBe("tom");
  });

  it("gives Tom every cell the delegate would take when the runner may not call it", () => {
    const closed = { ...probe, delegateAllowed: false };
    expect(cell(closed, "plan").answerer).toBe("tom");
    expect(cell(closed, "setup").answerer).toBe("tom");
    expect(cell({ ...campaign, delegateAllowed: false }, "setup", true).answerer).toBe("tom");
    expect(cell(closed, "routine").answerer).toBe("self");
  });
});

describe("the create door", () => {
  it("writes the row, the first document and a step due now, from a document", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest(schema, modules);
    const response = await post(t, seed());
    expect(response.status).toBe(200);
    const { runnerId } = await response.json();
    const state = await t.run(async (ctx) => ({
      runner: await ctx.db.get(runnerId),
      events: await ctx.db.query("runnerEvents").collect(),
      steps: await ctx.db.query("runnerSteps").collect(),
    }));
    expect(state.runner?.document).toBe(seed().from.kind === "document" ? (seed().from as { text: string }).text : "");
    expect(state.runner?.documentVersion).toBe(1);
    expect(state.runner?.createdBy).toEqual({ kind: "tom" });
    expect(state.events.map((e) => e.kind)).toEqual(["document"]);
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0].status).toBe("requested");
    expect(state.steps[0].environment).toBe("runner");
  });

  it("prepends where a handoff came from", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest(schema, modules);
    const first = (await (await post(t, seed())).json()).runnerId;
    const second = await post(t, seed({ title: "TRAIN25 follow-up", from: { kind: "handoff", runnerId: first } }));
    const { runnerId } = await second.json();
    const runner = await t.run((ctx) => ctx.db.get(runnerId));
    expect(runner?.document.startsWith("## Handed off from TRAIN25 campaign")).toBe(true);
    expect(runner?.document).toContain("Watch the sweep.");
  });

  it("refuses a malformed seed in a sentence and writes nothing", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest(schema, modules);
    const refusals = [
      [seed({ stepMs: 1000 }), "step length"],
      [seed({ repo: "elsewhere" }), "repo must be one of"],
      [seed({ model: "gpt-5.6-sol" }), "run on Claude"],
      [seed({ askOverrides: [{ tier: "plan", answerer: "delegate" }] }), "may not call it"],
      [{ ...seed(), from: { kind: "letter" } }, "from.kind"],
    ] as const;
    for (const [body, words] of refusals) {
      const response = await post(t, body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(words);
    }
    const rows = await t.run(async (ctx) => [
      ...(await ctx.db.query("runners").collect()),
      ...(await ctx.db.query("runnerEvents").collect()),
      ...(await ctx.db.query("runnerSteps").collect()),
    ]);
    expect(rows).toEqual([]);
  });

  it("keeps the Tom-only mutation behind the Tom gate", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation((await import("./_generated/api")).api.ttsRunners.createRunner, seed())).rejects.toThrow();
  });
});

describe("known away", () => {
  it("is away after two quiet hours and present after a turn from Tom", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T15:00:00Z"));
    const t = convexTest(schema, modules);
    const { internal } = await import("./_generated/api");
    const now = Date.now();
    expect((await t.query(internal.ttsRunners.internalKnownAway, { now })).away).toBe(true);
    await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("claudeSessions", { title: "s", kind: "adhoc", repo: "none", status: "idle", statusChangedAt: now, nextSeq: 0, createdAt: now });
      await ctx.db.insert("claudeInbound", { sessionId, kind: "user-turn", text: "hi", author: "tom", status: "done", createdAt: now - 60_000 });
    });
    expect((await t.query(internal.ttsRunners.internalKnownAway, { now })).away).toBe(false);
    await t.run((ctx) => ctx.db.insert("ttsCalendarEvents", { feed: "google", uid: "u", title: "a block", start: now - 60_000, end: now + 60_000, allDay: false, syncedAt: now }));
    const blocked = await t.query(internal.ttsRunners.internalKnownAway, { now });
    expect(blocked).toEqual({ away: true, because: "a calendar block covers now" });
  });
});
