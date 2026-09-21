import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { answererFor, runnerStatus, type RunnerSeed } from "./ttsRunners";
import type { RunnerTier } from "./ttsShared";
import type { Id } from "./_generated/dataModel";

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
    const { runnerId } = (await response.json()) as { runnerId: Id<"runners"> };
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
    const { runnerId } = (await second.json()) as { runnerId: Id<"runners"> };
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
      [seed({ ceiling: { gpus: 17, minutes: 240, memoryMb: 128000 } }), "at most 16"],
      [{ ...seed(), ceiling: { gpus: 4 } }, "ceiling must be"],
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

describe("the ceiling", () => {
  function ceilingPost(t: TestConvex<typeof schema>, body: unknown) {
    return t.fetch("/tts/runner-ceiling", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TTS-Key": KEY },
      body: JSON.stringify(body),
    });
  }

  it("holds a new runner to the default, takes one a session sets at creation, and hands it to the box with the claim", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest(schema, modules);
    const { internal } = await import("./_generated/api");
    const plain = (await (await post(t, seed())).json()).runnerId as Id<"runners">;
    const wide = (await (await post(t, seed({ title: "wide", ceiling: { gpus: 8, minutes: 720, memoryMb: 256000 } }))).json()).runnerId as Id<"runners">;
    expect((await t.run((ctx) => ctx.db.get(plain)))?.ceiling).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(wide)))?.ceiling).toEqual({ gpus: 8, minutes: 720, memoryMb: 256000 });
    const steps = await t.run((ctx) => ctx.db.query("runnerSteps").collect());
    const claims = [];
    for (const step of steps) claims.push(await t.mutation(internal.ttsRunners.internalClaimRunnerStep, { stepId: step._id }));
    const sensors = claims.map((c) => (c.admitted ? c.sensor.ceiling : null));
    expect(sensors).toEqual([{ gpus: 2, minutes: 240, memoryMb: 128000 }, { gpus: 8, minutes: 720, memoryMb: 256000 }]);
    const prompt = claims[0].admitted ? claims[0].prompt : "";
    expect(prompt).toContain("my ceiling, now 2 GPUs, 240 minutes and 128000 MB of memory per request");
    expect(prompt).toContain('starts with the word "ceiling"');
    expect(prompt).toContain("You never raise it yourself");
    expect(prompt).toContain("inside the runner's GPU-hour budget and its ceiling of 2 GPUs, 240 minutes and 128000 MB of memory per request;");
  });

  it("keeps the box's fallback ceiling equal to the record's default", async () => {
    const { DEFAULT_CEILING } = await import("../worker/runs/runner-sensor.mjs");
    const { RUNNER_CEILING_DEFAULT } = await import("./ttsShared");
    expect(DEFAULT_CEILING).toEqual(RUNNER_CEILING_DEFAULT);
  });

  it("reads Tom's ceiling reply", async () => {
    const { parseCeilingReply, RUNNER_CEILING_DEFAULT: d } = await import("./ttsShared");
    expect(parseCeilingReply("Yes, skip pythia.", d)).toBeNull();
    expect(parseCeilingReply("ceiling 16 GPUs", d)).toEqual({ ceiling: { gpus: 16, minutes: 240, memoryMb: 128000 } });
    expect(parseCeilingReply("Ceiling 8 GPUs, 12 hours, 256 GB", d)).toEqual({ ceiling: { gpus: 8, minutes: 720, memoryMb: 256000 } });
    expect(parseCeilingReply("ceiling 600 minutes and 200000 MB", d)).toEqual({ ceiling: { gpus: 2, minutes: 600, memoryMb: 200000 } });
    expect(parseCeilingReply("ceiling 17 gpus", d)).toMatchObject({ fault: expect.stringContaining("at most 16") });
    expect(parseCeilingReply("ceiling 25 hours", d)).toMatchObject({ fault: expect.stringContaining("at most 1440") });
    expect(parseCeilingReply("ceiling please", d)).toMatchObject({ fault: expect.stringContaining("names no number") });
  });

  it("moves on Tom's reply in the runner's thread, recorded with the old and new numbers, and the next step reads it", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { internal } = await import("./_generated/api");
    const runnerId = await t.mutation(internal.ttsRunners.internalCreateRunner, { seed: seed() });
    const reply = (text: string, ts: string) => t.mutation(internal.ttsSlack.internalRouteReply, {
      subject: { kind: "runner", id: runnerId },
      text,
      at: { channel: "CNEEDS", ts, threadTs: "1.0" },
    });
    expect(await reply("ceiling 16 GPUs, 24 hours", "2.0")).toEqual({ outcome: "runner-reply", runnerId });
    expect((await t.run((ctx) => ctx.db.get(runnerId)))?.ceiling).toEqual({ gpus: 16, minutes: 1440, memoryMb: 128000 });
    await reply("ceiling 20 GPUs", "3.0");
    expect((await t.run((ctx) => ctx.db.get(runnerId)))?.ceiling).toEqual({ gpus: 16, minutes: 1440, memoryMb: 128000 });
    const events = await t.run((ctx) => ctx.db.query("runnerEvents").withIndex("by_runner_kind_at", (q) => q.eq("runnerId", runnerId).eq("kind", "ceiling")).collect());
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ from: { gpus: 2, minutes: 240 }, to: { gpus: 16, minutes: 1440 } });
    expect(events[0].slackTs).toBe("2.0");
    expect(events[0].text).toBe("The ceiling moved from 2 GPUs, 240 minutes and 128000 MB of memory per request to 16 GPUs, 1440 minutes and 128000 MB of memory per request.");
    const step = await t.run(async (ctx) => (await ctx.db.query("runnerSteps").collect())[0]);
    const claim = await t.mutation(internal.ttsRunners.internalClaimRunnerStep, { stepId: step._id });
    if (!claim.admitted) throw new Error(claim.reason);
    expect(claim.sensor.ceiling).toEqual({ gpus: 16, minutes: 1440, memoryMb: 128000 });
    expect(claim.prompt).toContain("(This reply set the ceiling from 2 GPUs");
    expect(claim.prompt).toContain("(This reply did not change the ceiling: The ceiling's GPUs may be at most 16");
  });

  it("passes to a hand-off successor unless its seed names one", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest(schema, modules);
    const wide = { gpus: 16, minutes: 1440, memoryMb: 512000 };
    const first = (await (await post(t, seed({ ceiling: wide }))).json()).runnerId as Id<"runners">;
    const next = (await (await post(t, seed({ title: "next", from: { kind: "handoff", runnerId: first } }))).json()).runnerId as Id<"runners">;
    expect((await t.run((ctx) => ctx.db.get(next)))?.ceiling).toEqual(wide);
  });

  it("has no door for a session or a step", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest(schema, modules);
    const runnerId = (await (await post(t, seed())).json()).runnerId as Id<"runners">;
    const response = await ceilingPost(t, { runnerId, runId: "claude:box:session-1", why: "x", ceiling: { gpus: 16 } });
    expect(response.status).toBe(404);
    expect((await t.run((ctx) => ctx.db.get(runnerId)))?.ceiling).toBeUndefined();
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
  const RESEARCH = "---\nupdated: 2026-09-09\ncategories: [study-one, study-two, complexmultitrigger]\n---\n\n# Research\n\n## Current state\n\n- The September campaign.\n";

  async function publish(t: TestConvex<typeof schema>) {
    const { contextPublication } = await import("../scripts/context-fixture.mjs");
    const publication = contextPublication(COMMIT);
    await t.run(async (ctx) => {
      await ctx.db.insert("modelOfTomPublication", {
        key: "current", commit: COMMIT, committedAt: 1, pushed: true,
        operate: publication.layers.operate,
        headers: publication.headers.filter((header: { layers: string[] }) => header.layers.join(",") === "operate") as never,
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
    // The check-in contract names the prompt's own words, which the proof
    // run's check-ins carried to Tom undefined.
    const contract = prompt.slice(prompt.indexOf("## The check-in"), prompt.indexOf("The asking rubric"));
    expect(contract).toContain(`by its title in Tom's record, "${seed().title}"`);
    expect(contract).toContain("units of work the sweep files ask for");
    expect(contract).toContain("with no number");
    expect(contract).toContain("`tts-search skills write` prints it");
    expect(contract).toContain("Never ask him to type a command.");
    expect(contract).toContain("The default is the recommendation");
    expect(contract).toContain("reread the draft once as the judge will");
    for (const rule of (await import("../scripts/checkin-rules.mjs")).CHECKIN_RULES) expect(contract).toContain(rule.why);
    expect(contract).toContain("describe the thing instead");
    expect(contract).toContain("exit code or an HTTP status in words");
    expect(contract).toContain("what the next step will do if he does not answer, and when, as one clock time given once");
    expect(contract).toContain("one short Markdown table with two columns");
    expect(prompt).not.toContain("name the tier you judged in the check-in");
    expect(claimed.sensor).toEqual({ specs: ["sweeps/train/train25_*.yaml"], budgetGpuHours: 500, ceiling: { gpus: 2, minutes: 240, memoryMb: 128000 }, failures: [] });
    // A runner on a Turing experiment is told how to act on the cluster, and
    // records each act with the pen.
    expect(prompt).toContain("tts-turing-act launch --runner");
    expect(prompt).toContain("--act 'launch|<job id>|");
    expect(prompt).toContain("On the cluster you may launch jobs for this experiment");
    expect(contract).toContain("Name at most two this way and count the rest");
    expect(claimed.actsOnCluster).toBe(true);
  });

  it("tells a runner whose experiment is on the box nothing about acting on the cluster", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await publish(t);
    const { internal } = await import("./_generated/api");
    await t.mutation(internal.ttsRunners.internalCreateRunner, { seed: seed({ experimentHost: "box" }) });
    const boxClaim = await claimedPrompt(t);
    const prompt = boxClaim.prompt;
    expect(boxClaim.actsOnCluster).toBe(false);
    expect(prompt).not.toContain("tts-turing-act");
    expect(prompt).not.toContain("--act '");
    // What sessions are told about the read-only command is unchanged.
    expect(prompt).toContain("It cannot allocate, cancel, run, or read files outside the results tree");
  });

  it("builds an observe-only step while a blocking ask is unanswered, and carries Tom's reply once it comes", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await publish(t);
    const { internal } = await import("./_generated/api");
    const runnerId = await t.mutation(internal.ttsRunners.internalCreateRunner, { seed: seed({ delegateAllowed: true }) });
    const askId = await t.run((ctx) => ctx.db.insert("runnerEvents", { runnerId, at: Date.now(), kind: "ask", tier: "plan", blocking: true, text: "Should the next stage skip pythia?" }));
    const blockedClaim = await claimedPrompt(t);
    const blocked = blockedClaim.prompt;
    expect(blockedClaim.actsOnCluster).toBe(false);
    expect(blocked).toContain("ACT: change nothing.");
    expect(blocked).not.toContain("tts-turing-act");
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

describe("the check-in", () => {
  const GOOD = "The sweep has 12 jobs running.\n\nNothing changed, and nothing failed.";
  const PASS = { verdict: "pass" as const, complaints: [], attempts: 1, judgeModel: "fable" };

  async function claimed(t: TestConvex<typeof schema>, over: Partial<RunnerSeed> = {}) {
    const { internal } = await import("./_generated/api");
    const runnerId = await t.mutation(internal.ttsRunners.internalCreateRunner, { seed: seed(over) });
    const step = await t.run(async (ctx) => (await ctx.db.query("runnerSteps").collect())[0]);
    const claim = await t.mutation(internal.ttsRunners.internalClaimRunnerStep, { stepId: step._id });
    if (!claim.admitted) throw new Error(claim.reason);
    await t.mutation(internal.ttsRunners.internalRecordStepFacts, { stepId: step._id, facts: { version: 1, jobs: { live: 12, running: 12 }, frontier: { size: 100, done: 40, remaining: 60, unchecked: 0 }, gpuHours: { spent: 3.5, budget: 500 } } });
    return { runnerId, stepRunId: claim.stepRunId, stepId: step._id, internal };
  }

  it("records the check-in, the document and the schedule, and frees the lease, in one step", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { runnerId, stepRunId, stepId, internal } = await claimed(t);
    const result = await t.mutation(internal.ttsRunners.internalRecordStep, { runnerId, stepRunId, decision: "continue", checkIn: GOOD, document: "# TRAIN25\n\nVersion two.\n", asks: [], graded: PASS });
    expect("nextStepAt" in result && result.nextStepAt).toBe(Date.now() + TEN_MINUTES);
    const state = await t.run(async (ctx) => ({
      runner: await ctx.db.get(runnerId),
      step: await ctx.db.get(stepId),
      events: await ctx.db.query("runnerEvents").withIndex("by_runner_at", (q) => q.eq("runnerId", runnerId)).collect(),
    }));
    expect(state.runner?.lease).toBeUndefined();
    expect(state.runner?.documentVersion).toBe(2);
    expect(state.runner?.document).toContain("Version two.");
    expect(state.step?.status).toBe("done");
    const checkIn = state.events.find((e) => e.kind === "check-in")!;
    expect(checkIn.graded?.verdict).toBe("pass");
    // The facts come from the box's post on the step row, not from the pen.
    expect((checkIn.data as { facts: { jobs: { live: number } } }).facts.jobs.live).toBe(12);
    expect(state.events.map((e) => e.kind)).toEqual(["document", "check-in", "document"]);
  });

  it("refuses a body with no grade, a step without the lease, and an act while a blocking question is open", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { runnerId, stepRunId, internal } = await claimed(t);
    const base = { runnerId, stepRunId, decision: "continue" as const, checkIn: GOOD, document: "d", asks: [] };
    await expect(t.mutation(internal.ttsRunners.internalRecordStep, base)).rejects.toThrow(/only with its grade/);
    await expect(t.mutation(internal.ttsRunners.internalRecordStep, { ...base, stepRunId: "claude:box:00000000-0000-4000-8000-000000000000", graded: PASS })).rejects.toThrow(/does not hold the runner's lease/);
    await t.run((ctx) => ctx.db.insert("runnerEvents", { runnerId, at: Date.now(), kind: "ask", tier: "plan", blocking: true, text: "Skip pythia?" }));
    await expect(t.mutation(internal.ttsRunners.internalRecordStep, { ...base, decision: "change", graded: PASS })).rejects.toThrow(/may only continue or ask/);
    const events = await t.run((ctx) => ctx.db.query("runnerEvents").withIndex("by_runner_kind_at", (q) => q.eq("runnerId", runnerId).eq("kind", "check-in")).collect());
    expect(events).toEqual([]);
  });

  it("records each launch and cancel as an act beside the check-in, and counts them", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { runnerId, stepRunId, internal } = await claimed(t);
    const acts = [
      { verb: "launch" as const, jobId: "4101", text: "Launched one probe job to test the new data path; the queue showed it by its name." },
      { verb: "cancel" as const, jobId: "4101", text: "Cancelled the probe once it had started; the next read of the queue no longer showed it." },
    ];
    await t.mutation(internal.ttsRunners.internalRecordStep, { runnerId, stepRunId, decision: "change", checkIn: GOOD, document: "d", asks: [], acts, graded: PASS });
    const events = await t.run((ctx) => ctx.db.query("runnerEvents").withIndex("by_runner_at", (q) => q.eq("runnerId", runnerId)).collect());
    const recorded = events.filter((e) => e.kind === "act");
    expect(recorded.map((e) => e.data)).toEqual([{ verb: "launch", jobId: "4101" }, { verb: "cancel", jobId: "4101" }]);
    expect(recorded.every((e) => e.stepRunId === stepRunId)).toBe(true);
    expect(recorded[0].text).toContain("the queue showed it");
    expect((events.find((e) => e.kind === "check-in")!.data as { acts: number }).acts).toBe(2);
  });

  it("refuses acts on an observe-only step, too many acts, and an act with no words", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { runnerId, stepRunId, internal } = await claimed(t);
    const act = { verb: "launch" as const, jobId: "4101", text: "Launched a probe; seen in the queue by name." };
    const base = { runnerId, stepRunId, decision: "continue" as const, checkIn: GOOD, document: "d", asks: [], graded: PASS };
    await expect(t.mutation(internal.ttsRunners.internalRecordStep, { ...base, acts: Array(11).fill(act) })).rejects.toThrow(/at most 10/);
    await expect(t.mutation(internal.ttsRunners.internalRecordStep, { ...base, acts: [{ ...act, text: " " }] })).rejects.toThrow(/one to 300 characters/);
    await expect(t.mutation(internal.ttsRunners.internalRecordStep, { ...base, acts: [{ ...act, text: "x".repeat(301) }] })).rejects.toThrow(/one to 300 characters/);
    await expect(t.mutation(internal.ttsRunners.internalRecordStep, { ...base, acts: [{ ...act, jobId: "not-a-job" }] })).rejects.toThrow(/cluster job number/);
    await t.run((ctx) => ctx.db.insert("runnerEvents", { runnerId, at: Date.now(), kind: "ask", tier: "plan", blocking: true, text: "Skip pythia?" }));
    await expect(t.mutation(internal.ttsRunners.internalRecordStep, { ...base, acts: [act] })).rejects.toThrow(/records no launch or cancel/);
    const events = await t.run((ctx) => ctx.db.query("runnerEvents").withIndex("by_runner_kind_at", (q) => q.eq("runnerId", runnerId).eq("kind", "act")).collect());
    expect(events).toEqual([]);
  });

  it("refuses acts from a runner whose experiment is on the box", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { runnerId, stepRunId, internal } = await claimed(t, { experimentHost: "box" });
    const act = { verb: "launch" as const, jobId: "4101", text: "Launched a probe; seen in the queue by name." };
    await expect(t.mutation(internal.ttsRunners.internalRecordStep, { runnerId, stepRunId, decision: "change", checkIn: GOOD, document: "d", asks: [], acts: [act], graded: PASS })).rejects.toThrow(/not on the cluster/);
  });

  it("marks a forged pass on a malformed check-in as failed", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { runnerId, stepRunId, internal } = await claimed(t);
    await t.mutation(internal.ttsRunners.internalRecordStep, { runnerId, stepRunId, decision: "continue", checkIn: "## Status\n\nFine", document: "d", asks: [], graded: PASS });
    const checkIn = await t.run(async (ctx) => (await ctx.db.query("runnerEvents").withIndex("by_runner_kind_at", (q) => q.eq("runnerId", runnerId).eq("kind", "check-in")).collect())[0]);
    expect(checkIn.graded?.verdict).toBe("fail");
    expect(checkIn.graded?.complaints.join(" ")).toMatch(/checkin-heading/);
  });

  it("ends the runner on finish, and the status derives done", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { runnerId, stepRunId, internal } = await claimed(t);
    await t.mutation(internal.ttsRunners.internalRecordStep, { runnerId, stepRunId, decision: "finish", checkIn: GOOD, document: "d", asks: [], graded: PASS });
    const runner = await t.run((ctx) => ctx.db.get(runnerId));
    expect(runner?.endedReason).toBe("finish");
    expect(runnerStatus({ runner: runner!, openBlockingAsks: 0 })).toBe("done");
    vi.advanceTimersByTime(TEN_MINUTES * 2);
    await t.mutation(internal.ttsRunners.internalRunnerSweep, {});
    const requested = await t.run(async (ctx) => (await ctx.db.query("runnerSteps").collect()).filter((s) => s.status === "requested"));
    expect(requested).toEqual([]);
  });
});

describe("composeCheckIn", () => {
  const base = {
    title: "TRAIN25 campaign",
    number: 3,
    decision: "continue" as const,
    facts: { jobs: { live: 12, running: 11 }, frontier: { size: 21081, done: 20412, remaining: 669, unchecked: 0 }, gpuHours: { spent: 41.5, budget: 500 } },
    failures: 0,
    skipped: 0,
    asks: 0,
    checkIn: "Nothing changed.",
    graded: { verdict: "pass" as const, complaints: [] },
    runUrl: "https://www.tom.quest/sessions?run=claude%3Abox%3Ax",
  };

  it("still composes one line when nothing changed, the numbers in their fixed order", async () => {
    const { composeCheckIn, checkInBody, renderSlack } = await import("./ttsCompose");
    const message = composeCheckIn(base);
    expect(message.firstLine).toBe("TRAIN25 campaign, check-in 3: 11 of 12 jobs running, 20412 of 21081 results done, 41.5 of 500 GPU-hours used; it changed nothing.");
    expect(renderSlack(message)).toContain("Open the step that wrote this check-in.");
    expect(checkInBody(base)).toBe("Nothing changed.");
  });

  it("says when the box read nothing, and when steps failed or were skipped", async () => {
    const { composeCheckIn } = await import("./ttsCompose");
    const line = composeCheckIn({ ...base, facts: null, failures: 1, skipped: 2 }).firstLine;
    expect(line).toContain("the jobs were not read");
    expect(line).toContain("one step failed since the last check-in");
    expect(line).toContain("two steps were skipped because the one before was still running");
  });

  it("renders the facts table in Slack as one line per row, what was counted then what this step found", async () => {
    const { checkInBody } = await import("./ttsCompose");
    const checkIn = [
      "The first column names what was counted, the second what this step found.",
      "",
      "| What was counted | This step |",
      "| --- | --- |",
      "| Jobs of the experiment running on the cluster | 11 |",
      "| GPUs free on the cluster | 3 |",
      "| Units of work the sweep files ask for | 21081 |",
      "| Units known finished | 20412 |",
      "| My steps that failed since the last check-in | 0 |",
      "| GPU-hours this runner's jobs used since I began | not read: the accounting call timed out |",
      "",
      "Nothing changed.",
    ].join("\n");
    expect(checkInBody({ ...base, checkIn })).toBe([
      "The first column names what was counted, the second what this step found.",
      "",
      "Jobs of the experiment running on the cluster: 11",
      "GPUs free on the cluster: 3",
      "Units of work the sweep files ask for: 21081",
      "Units known finished: 20412",
      "My steps that failed since the last check-in: 0",
      "GPU-hours this runner's jobs used since I began: not read: the accounting call timed out",
      "",
      "Nothing changed.",
    ].join("\n"));
  });

  it("posts a check-in that failed its grade marked", async () => {
    const { checkInBody } = await import("./ttsCompose");
    const body = checkInBody({ ...base, graded: { verdict: "fail", complaints: ["The word grinder is coined."] } });
    expect(body.startsWith("This check-in did not pass the writing check. The word grinder is coined.")).toBe(true);
    expect(body.endsWith("Nothing changed.")).toBe(true);
  });
});

describe("a question for Tom", () => {
  const PASS = { verdict: "pass" as const, complaints: [], attempts: 1, judgeModel: "fable" };
  const ASKING = "Two cells are stuck.\n\n## Rulings requested\n\n1. Should I skip pythia? If you do not answer, I keep training it.";

  it("opens a needs-you thread, holds the runner to observing, and his reply reaches the next step", async () => {
    vi.useFakeTimers();
    vi.stubEnv("SLACK_TTS_NEEDS_YOU_CHANNEL_ID", "CNEEDS");
    const t = convexTest(schema, modules);
    const { internal } = await import("./_generated/api");
    const runnerId = await t.mutation(internal.ttsRunners.internalCreateRunner, { seed: seed() });
    const step = await t.run(async (ctx) => (await ctx.db.query("runnerSteps").collect())[0]);
    const claim = await t.mutation(internal.ttsRunners.internalClaimRunnerStep, { stepId: step._id });
    if (!claim.admitted) throw new Error(claim.reason);
    await t.mutation(internal.ttsRunners.internalRecordStep, {
      runnerId, stepRunId: claim.stepRunId, decision: "ask", checkIn: ASKING, document: "d",
      asks: [{ tier: "plan", blocking: true, text: "Should I skip pythia?" }], graded: PASS,
    });
    // The ask is routed: this probe may not call the delegate, so it is Tom's.
    const ask = await t.run(async (ctx) => (await ctx.db.query("runnerEvents").withIndex("by_runner_kind_at", (q) => q.eq("runnerId", runnerId).eq("kind", "ask")).collect())[0]);
    expect((ask.data as { answerer: string }).answerer).toBe("tom");
    const routed = await t.mutation(internal.ttsRunners.internalRouteAsk, { askId: ask._id });
    expect(routed).toEqual({ routed: true, answerer: "tom" });
    const opened = await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, { runner: { runnerId, askId: ask._id }, reason: "Should I skip pythia?", key: `runner-ask:${ask._id}` });
    expect(opened.opened).toBe(true);
    // A redelivered ask opens nothing twice.
    expect((await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, { runner: { runnerId, askId: ask._id }, reason: "x", key: `runner-ask:${ask._id}` })).opened).toBe(false);
    let runner = await t.run((ctx) => ctx.db.get(runnerId));
    expect(runnerStatus({ runner: runner!, openBlockingAsks: 1 })).toBe("waiting-on-tom");

    // His reply in the thread: the door's slack-sent row names the runner.
    const reply = await t.mutation(internal.ttsSlack.internalRouteReply, {
      subject: { kind: "runner", id: runnerId },
      text: "Yes, skip pythia.",
      at: { channel: "CNEEDS", ts: "2.0", threadTs: "1.0" },
    });
    expect(reply).toEqual({ outcome: "runner-reply", runnerId });
    const answered = await t.run((ctx) => ctx.db.get(ask._id));
    expect(answered?.answerText).toBe("Yes, skip pythia.");
    const { openBlockingAsks: open } = await import("./ttsRunners");
    expect(await t.run(async (ctx) => (await open(ctx, runnerId)).length)).toBe(0);
    runner = await t.run((ctx) => ctx.db.get(runnerId));
    expect(runnerStatus({ runner: runner!, openBlockingAsks: 0 })).toBe("running");
    // It is not a ruling.
    expect(await t.run((ctx) => ctx.db.query("dtsRulings").collect())).toEqual([]);
  });

  it("composes the question whole under a first line that says whether the runner is holding still", async () => {
    const { composeRunnerAsk, runnerAskBody, renderSlack } = await import("./ttsCompose");
    const facts = { title: "TRAIN25 campaign", question: "Should I skip pythia? If you do not answer, I keep training it.", tier: "plan" as const, blocking: true, stepUrl: "https://www.tom.quest/sessions?run=x" };
    const text = renderSlack(composeRunnerAsk(facts, { canReply: true }));
    expect(text.split("\n")[0]).toBe("The runner TRAIN25 campaign has a question about what the experiment is only you can settle. Its steps change nothing until you answer.");
    expect(text).toContain("reply here");
    expect(runnerAskBody(facts)).toBe(facts.question);
  });

  it("caps the delegate per runner, across its steps", async () => {
    const t = convexTest(schema, modules);
    const { internal } = await import("./_generated/api");
    const { DELEGATE_MAX_PER_RUNNER } = await import("./ttsAsk");
    const runnerId = await t.mutation(internal.ttsRunners.internalCreateRunner, { seed: seed({ delegateAllowed: true }) });
    const ask = (i: number) => ({
      askId: `0000000${i}`, runnerId, question: "Resubmit on the long partition?", options: ["yes", "no"], recommendation: "yes",
      fallback: "no", decision: "yes", reason: "The short partition keeps timing out.", refused: false, refusedBecause: null,
      model: "fable", ms: 1, promptSha: "x",
    });
    const results = [];
    for (let i = 0; i <= DELEGATE_MAX_PER_RUNNER; i += 1) results.push(await t.mutation(internal.ttsAsk.internalRecordAsk, ask(i)));
    expect(results.slice(0, DELEGATE_MAX_PER_RUNNER).every((r) => !r.capped)).toBe(true);
    expect(results[DELEGATE_MAX_PER_RUNNER].capped).toBe(true);
    await expect(t.mutation(internal.ttsAsk.internalRecordAsk, { ...ask(9), runnerId: "nonsense" })).rejects.toThrow(/Unknown runner id/);
  });
});

describe("the page", () => {
  const PASS = { verdict: "pass" as const, complaints: [], attempts: 1, judgeModel: "fable" };
  const ASKING = "The sweep has 12 jobs running.\n\nOne question is open for Tom.";

  async function asUser(t: TestConvex<typeof schema>, role: "tom" | "agent" | "user") {
    const userId = await t.run((ctx) => ctx.db.insert("users", { name: role, email: `${role}@tom.quest`, role }));
    return t.withIdentity({ subject: userId });
  }

  /** A runner whose one step checked in and asked Tom a blocking question,
   *  and a second that ended before it ever stepped. */
  async function seeded(t: TestConvex<typeof schema>) {
    const { internal } = await import("./_generated/api");
    vi.useFakeTimers();
    const runnerId = await t.mutation(internal.ttsRunners.internalCreateRunner, { seed: seed() });
    const step = await t.run(async (ctx) => (await ctx.db.query("runnerSteps").collect())[0]);
    const claim = await t.mutation(internal.ttsRunners.internalClaimRunnerStep, { stepId: step._id });
    if (!claim.admitted) throw new Error(claim.reason);
    await t.mutation(internal.ttsRunners.internalRecordStep, {
      runnerId, stepRunId: claim.stepRunId, decision: "ask", checkIn: ASKING, document: "# TRAIN25\n\nVersion two.\n",
      asks: [{ tier: "plan", blocking: true, text: "Should I skip pythia?" }], graded: PASS,
    });
    vi.advanceTimersByTime(1000);
    const ended = await t.mutation(internal.ttsRunners.internalCreateRunner, { seed: seed({ title: "An ended probe" }) });
    await t.run((ctx) => ctx.db.patch(ended, { endedAt: Date.now(), endedReason: "finish" }));
    return { runnerId, ended, stepRunId: claim.stepRunId };
  }

  it("lists every runner newest first, with its derived status, its last check-in and its newest step run", async () => {
    const t = convexTest(schema, modules);
    const { api } = await import("./_generated/api");
    const { runnerId, ended, stepRunId } = await seeded(t);
    const tom = await asUser(t, "tom");
    const rows = await tom.query(api.ttsRunners.listRunners, {});
    expect(rows.map((r) => r.runnerId)).toEqual([ended, runnerId]);
    const live = rows[1];
    expect(live).toMatchObject({
      title: "TRAIN25 campaign",
      type: "probe",
      experimentHost: "turing",
      stepMs: TEN_MINUTES,
      endedAt: null,
      status: "waiting-on-tom",
      openBlockingAsks: 1,
      stepRunId,
    });
    expect(live.lastCheckIn?.line).toBe("The sweep has 12 jobs running.");
    expect(rows[0]).toMatchObject({ status: "done", lastCheckIn: null });
  });

  it("gives one runner's document, check-ins and questions, newest first", async () => {
    const t = convexTest(schema, modules);
    const { api } = await import("./_generated/api");
    const { runnerId, stepRunId } = await seeded(t);
    const tom = await asUser(t, "tom");
    const detail = await tom.query(api.ttsRunners.runnerDetail, { runnerId });
    expect(detail?.document).toContain("Version two.");
    expect(detail?.documentVersion).toBe(2);
    expect(detail?.checkIns).toHaveLength(1);
    expect(detail?.checkIns[0]).toMatchObject({ stepRunId, decision: "ask", verdict: "pass", text: ASKING });
    expect(detail?.asks).toHaveLength(1);
    expect(detail?.asks[0]).toMatchObject({ tier: "plan", blocking: true, answeredAt: null, answerText: null, text: "Should I skip pythia?" });
  });

  it("lets the agent account read both, and refuses anyone else", async () => {
    const t = convexTest(schema, modules);
    const { api } = await import("./_generated/api");
    const { runnerId } = await seeded(t);
    const agent = await asUser(t, "agent");
    expect(await agent.query(api.ttsRunners.listRunners, {})).toHaveLength(2);
    expect(await agent.query(api.ttsRunners.runnerDetail, { runnerId })).not.toBeNull();
    const user = await asUser(t, "user");
    await expect(user.query(api.ttsRunners.listRunners, {})).rejects.toThrow(/restricted to Tom/);
    await expect(user.query(api.ttsRunners.runnerDetail, { runnerId })).rejects.toThrow(/restricted to Tom/);
    await expect(t.query(api.ttsRunners.listRunners, {})).rejects.toThrow();
  });
});
