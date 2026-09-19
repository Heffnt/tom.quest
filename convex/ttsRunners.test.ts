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

describe("the step lease", () => {
  async function runnerWithStep(t: TestConvex<typeof schema>) {
    const { internal } = await import("./_generated/api");
    const runnerId = await t.mutation(internal.ttsRunners.internalCreateRunner, { seed: seed() });
    const step = await t.run(async (ctx) => (await ctx.db.query("runnerSteps").collect())[0]);
    return { runnerId, stepId: step._id, internal };
  }

  it("admits one claim, and a held lease refuses the next", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { runnerId, stepId, internal } = await runnerWithStep(t);
    const first = await t.mutation(internal.ttsRunners.internalClaimRunnerStep, { stepId });
    expect(first.admitted).toBe(true);
    if (!first.admitted) throw new Error("unreachable");
    expect(first.stepRunId).toMatch(/^claude:box:[0-9a-f-]{36}$/);
    const runner = await t.run((ctx) => ctx.db.get(runnerId));
    expect(runner?.lease?.stepRunId).toBe(first.stepRunId);
    expect(runner!.lease!.deadline - runner!.lease!.takenAt).toBe(4 * TEN_MINUTES);
    // A second request slipped in while the lease is held.
    const second = await t.run((ctx) => ctx.db.insert("runnerSteps", { runnerId, environment: "runner", dueAt: Date.now(), status: "requested" }));
    const refused = await t.mutation(internal.ttsRunners.internalClaimRunnerStep, { stepId: second });
    expect(refused).toEqual({ admitted: false, reason: "deferred: the step before it was still running" });
    const row = await t.run((ctx) => ctx.db.get(second));
    expect(row?.status).toBe("failed");
  });

  it("expires a lease past its deadline: a failed-step event, a free runner, the next step scheduled", async () => {
    vi.useFakeTimers();
    vi.stubEnv("SLACK_TTS_BROKEN_CHANNEL_ID", "");
    const t = convexTest(schema, modules);
    const { runnerId, stepId, internal } = await runnerWithStep(t);
    const claimed = await t.mutation(internal.ttsRunners.internalClaimRunnerStep, { stepId });
    if (!claimed.admitted) throw new Error("unreachable");
    // The daemon restarted; the step's process is gone and no check-in came.
    vi.advanceTimersByTime(4 * TEN_MINUTES + 1);
    await t.mutation(internal.ttsRunners.internalRunnerSweep, {});
    const state = await t.run(async (ctx) => ({
      runner: await ctx.db.get(runnerId),
      events: await ctx.db.query("runnerEvents").withIndex("by_runner_kind_at", (q) => q.eq("runnerId", runnerId).eq("kind", "step-failed")).collect(),
      step: await ctx.db.get(stepId),
    }));
    expect(state.runner?.lease).toBeUndefined();
    expect(state.events).toHaveLength(1);
    expect(state.events[0].text).toBe("the box's daemon restarted while this step was running");
    expect(state.events[0].stepRunId).toBe(claimed.stepRunId);
    expect(state.step?.status).toBe("failed");
    expect(state.runner!.nextStepAt).toBe(Date.now() + TEN_MINUTES);
    // The chain continues: when the next step comes due, it names the dead
    // step as the one it continues.
    vi.advanceTimersByTime(TEN_MINUTES);
    await t.mutation(internal.ttsRunners.internalRunnerSweep, {});
    const next = await t.run(async (ctx) => (await ctx.db.query("runnerSteps").collect()).filter((s) => s.status === "requested"));
    expect(next).toHaveLength(1);
    expect(next[0].previousStepRunId).toBe(claimed.stepRunId);
  });

  it("fails a step that exited without checking in, once", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { runnerId, stepId, internal } = await runnerWithStep(t);
    await t.mutation(internal.ttsRunners.internalClaimRunnerStep, { stepId });
    await t.mutation(internal.ttsRunners.internalFinishRunnerStep, { stepId, exitCode: 1, launched: true });
    await t.mutation(internal.ttsRunners.internalFinishRunnerStep, { stepId, exitCode: 1, launched: true });
    const failed = await t.run((ctx) => ctx.db.query("runnerEvents").withIndex("by_runner_kind_at", (q) => q.eq("runnerId", runnerId).eq("kind", "step-failed")).collect());
    expect(failed).toHaveLength(1);
    expect(failed[0].text).toBe("the step ended without checking in (exit 1)");
    expect((await t.run((ctx) => ctx.db.get(runnerId)))?.lease).toBeUndefined();
  });

  it("lists a due step on the daemon's poll and nothing about sessions changes", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { runnerId, stepId, internal } = await runnerWithStep(t);
    const polled = await t.mutation(internal.claudeSessions.internalPoll, { version: "t", daemonStartedAt: 1 });
    expect(polled.sessions).toEqual([]);
    expect(polled.runnerSteps).toEqual([expect.objectContaining({ stepId, runnerId, model: "opus", repo: "ComplexMultiTrigger" })]);
    const sessions = await t.run((ctx) => ctx.db.query("claudeSessions").collect());
    expect(sessions).toEqual([]);
  });
});

describe("the step prompt", () => {
  const COMMIT = "0123abcd0123abcd0123abcd0123abcd0123abcd";
  // The research page names the repository, which is how a CMT runner's step
  // is granted his research: the repository row, not a todo category.
  const RESEARCH = "---\nupdated: 2026-09-09\ncategories: [research, cmt, complexmultitrigger]\n---\n\n# Research\n\n## Current state\n\n- The September campaign.\n";

  async function publish(t: TestConvex<typeof schema>) {
    const { contextPublication } = await import("../scripts/context-fixture.mjs");
    const publication = contextPublication(COMMIT);
    await t.run(async (ctx) => {
      await ctx.db.insert("modelOfTomPublication", {
        key: "current", commit: COMMIT, committedAt: 1, pushed: true,
        operate: publication.layers.operate,
        headers: publication.headers.filter((header: { layers: string[] }) => header.layers.join(",") === "operate"),
      });
      for (const file of publication.files) {
        const body = file.path === "model-of-tom/areas/research.md" ? RESEARCH : file.body;
        await ctx.db.insert("modelOfTomFiles", {
          name: file.path.slice("model-of-tom/".length).replace(/\.md$/, ""),
          body, sourcePath: file.path, bytes: body.length, commit: COMMIT, syncedAt: 1, pushed: true,
        });
      }
      for (const name of ["write", "know-intent", "know-week", "know-research", "know-admin", "repo-complexmultitrigger"]) {
        await ctx.db.insert("ttsSkills", {
          name,
          group: name === "write" ? "write" : name.startsWith("repo-") ? "repo" : "know",
          description: `what ${name} covers`, body: `the body of ${name}`, references: [],
          sourcePaths: [`model-of-tom/${name}.md`], commit: COMMIT, syncedAt: 1, pushed: true,
        });
      }
    });
  }

  async function claimedPrompt(t: TestConvex<typeof schema>) {
    const { internal } = await import("./_generated/api");
    const steps = await t.run((ctx) => ctx.db.query("runnerSteps").withIndex("by_status_due", (q) => q.eq("status", "requested")).collect());
    const claimed = await t.mutation(internal.ttsRunners.internalClaimRunnerStep, { stepId: steps[0]._id });
    if (!claimed.admitted) throw new Error(claimed.reason);
    return claimed;
  }

  it("grants what the design says and carries the document, the rubric, the never list and the pen", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await publish(t);
    const { internal } = await import("./_generated/api");
    const runnerId = await t.mutation(internal.ttsRunners.internalCreateRunner, { seed: seed({ specs: ["sweeps/train/train25_*.yaml"], budgetGpuHours: 500 }) });
    const claimed = await claimedPrompt(t);
    const prompt = claimed.prompt;
    const grants = prompt.slice(0, prompt.indexOf("You are one step"));
    for (const name of ["write", "know-intent", "know-research", "repo-complexmultitrigger"]) expect(grants).toContain(name);
    expect(grants).not.toContain("know-admin");
    expect(prompt).toContain("Watch the sweep.");
    expect(prompt).toContain("@@RUNNER_FACTS@@");
    expect(prompt).toContain("DECIDE one of: continue, change, ask, hand-off or finish.");
    // A probe that may not call the delegate: every question not its own is Tom's.
    expect(prompt).toContain("- plan: a question that changes what the experiment is");
    expect(prompt).toMatch(/- plan: [^\n]*Now, Tom answers it/);
    expect(prompt).toContain("This runner may never call the delegate");
    expect(prompt).not.toContain("tts-ask --runner");
    for (const item of (await import("./ttsShared")).NARROW_LIST) expect(prompt).toContain(item.decision);
    expect(prompt).toContain(`tts-runner-step --runner ${runnerId} --step-run ${claimed.stepRunId}`);
    expect(prompt).toContain("tts-turing tree|node|read <path>");
    expect(prompt).toContain("Never restart, stop, or kill `tts-session-host`");
    expect(claimed.sensor).toEqual({ specs: ["sweeps/train/train25_*.yaml"], budgetGpuHours: 500, failures: [] });
  });

  it("builds an observe-only step while a blocking ask is unanswered, and carries Tom's reply once it comes", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await publish(t);
    const { internal } = await import("./_generated/api");
    const runnerId = await t.mutation(internal.ttsRunners.internalCreateRunner, { seed: seed({ delegateAllowed: true }) });
    const askId = await t.run((ctx) => ctx.db.insert("runnerEvents", { runnerId, at: Date.now(), kind: "ask", tier: "plan", blocking: true, text: "Should the next stage skip pythia?" }));
    const blocked = (await claimedPrompt(t)).prompt;
    expect(blocked).toContain("ACT: change nothing.");
    expect(blocked).toContain("Should the next stage skip pythia?");
    expect(blocked).toContain("DECIDE one of: continue or ask.");
    expect(blocked).toContain("which is waiting-on-tom");
    expect(blocked).toContain(`tts-ask --runner ${runnerId}`);

    // Tom answers; the lease is freed and the next step reads his words whole.
    vi.advanceTimersByTime(1000);
    await t.run(async (ctx) => {
      await ctx.db.patch(askId, { answeredAt: Date.now(), answerText: "Yes, skip pythia." });
      await ctx.db.insert("runnerEvents", { runnerId, at: Date.now(), kind: "reply", text: "Yes, skip pythia.\nThe 1.4b too." });
      await ctx.db.patch(runnerId, { lease: undefined });
      await ctx.db.insert("runnerSteps", { runnerId, environment: "runner", dueAt: Date.now(), status: "requested" });
    });
    const answered = (await claimedPrompt(t)).prompt;
    expect(answered).not.toContain("ACT: change nothing.");
    expect(answered).toContain("> Yes, skip pythia.\n> The 1.4b too.");
    expect(answered).toContain("which is running");
  });
});
