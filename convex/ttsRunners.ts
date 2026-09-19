import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireTom } from "./authRoles";
import { redactSecrets } from "../worker/session-host/redact.mjs";
import {
  RUNNER_ANSWERER,
  RUNNER_TIER,
  RUNNER_TYPE,
  SESSION_MODEL,
  SESSION_MODELS,
  SESSION_REPO_NAMES,
  NO_REPO,
  type RunnerAnswerer,
  type RunnerTier,
  type SessionModel,
} from "./ttsShared";

// ── Runners ──────────────────────────────────────────────────────────────────
// A runner watches one experiment through a chain of short step runs on the
// box. The row (convex/schema.ts `runners`) holds the handoff document, the
// step length and the lease; each step starts cold from the document, checks
// in, rewrites the document and ends. This module is the row's one writer:
// internalCreateRunner below is the only insert, and the step schedule, the
// claim and the check-in record live beside it.

/** A step's model when the runner names none. A runner step is a Claude run
 *  launched with a session id the claim mints (see internalClaimRunnerStep),
 *  and Codex takes no such id, so the default is Claude's strongest rather than
 *  the fleet's DEFAULT_SESSION_MODEL, which is a Codex model. */
export const DEFAULT_RUNNER_MODEL: SessionModel = "opus";

export const RUNNER_TITLE_MAX = 200;
export const RUNNER_DOCUMENT_MAX = 200_000;
/** The shortest step the schedule takes. A step is a whole cold run: shorter
 *  than this and the next is due before the last has read its document. */
export const RUNNER_STEP_MIN_MS = 5 * 60_000;
export const RUNNER_STEP_MAX_MS = 24 * 60 * 60_000;

// ── Status, derived ──────────────────────────────────────────────────────────

export type RunnerStatus = "done" | "failed" | "handed-off" | "waiting-on-tom" | "running";

/**
 * THE ONE HOME of a runner's status. It is not a field (the schema says why);
 * the page, the digest, the step prompt and the Slack composer all call this.
 *
 * A finished runner is done, a failed one failed, one that handed its document
 * to a successor handed-off. A live runner with an unanswered blocking ask is
 * waiting on Tom; every other live runner is running.
 */
export function runnerStatus({
  runner,
  openBlockingAsks,
}: {
  runner: Pick<Doc<"runners">, "endedAt" | "endedReason">;
  openBlockingAsks: number;
  now?: number;
}): RunnerStatus {
  if (runner.endedAt !== undefined) {
    if (runner.endedReason === "failed") return "failed";
    if (runner.endedReason === "hand-off") return "handed-off";
    return "done";
  }
  return openBlockingAsks > 0 ? "waiting-on-tom" : "running";
}

/** This runner's asks Tom has not answered that hold its steps to observing. */
export async function openBlockingAsks(ctx: QueryCtx, runnerId: Id<"runners">) {
  const open = await ctx.db
    .query("runnerEvents")
    .withIndex("by_open_ask", (q) => q.eq("runnerId", runnerId).eq("kind", "ask").eq("answeredAt", undefined))
    .take(50);
  return open.filter((ask) => ask.blocking === true);
}

// ── The asking rubric ────────────────────────────────────────────────────────
// Three tiers of question, two runner types, and who answers each cell.
//
//              routine   plan                               setup
//   campaign   self      Tom; the delegate after one step   Tom while present; the
//                        with no answer                     delegate when known away,
//                                                           marked for the digest
//   probe      self      the delegate at once               the delegate at once
//
// `askOverrides` replaces a cell. A runner with delegateAllowed false never
// reaches the delegate: a delegate cell becomes Tom's. The never list
// (NARROW_LIST) is refused in every cell; that refusal is the delegate's own
// and the step prompt's, not a cell here.

export type AnswererRuling = {
  answerer: RunnerAnswerer;
  /** The delegate answered a setup question in Tom's absence: the digest's
   *  objection list must carry it. */
  marked: boolean;
  because: string;
};

export function answererFor(
  runner: Pick<Doc<"runners">, "type" | "delegateAllowed" | "askOverrides">,
  tier: RunnerTier,
  { knownAway, stepsUnanswered = 0 }: { knownAway: boolean; stepsUnanswered?: number },
): AnswererRuling {
  const override = runner.askOverrides?.find((cell) => cell.tier === tier);
  let ruling: AnswererRuling;
  if (override) {
    ruling = { answerer: override.answerer, marked: false, because: `this runner's override names ${override.answerer} for a ${tier} question` };
  } else if (tier === "routine") {
    ruling = { answerer: "self", marked: false, because: "a routine question is inside the plan, so the step decides it" };
  } else if (runner.type === "probe") {
    ruling = { answerer: "delegate", marked: false, because: `a probe's ${tier} question goes to the delegate at once` };
  } else if (tier === "plan") {
    ruling = stepsUnanswered >= 1
      ? { answerer: "delegate", marked: false, because: "a campaign's plan question went a whole step with no answer from Tom" }
      : { answerer: "tom", marked: false, because: "a campaign's plan question is Tom's first" };
  } else {
    ruling = knownAway
      ? { answerer: "delegate", marked: true, because: "a campaign's setup question while Tom is known to be away goes to the delegate, marked" }
      : { answerer: "tom", marked: false, because: "a campaign's setup question is Tom's while he is present" };
  }
  if (ruling.answerer === "delegate" && !runner.delegateAllowed) {
    return { answerer: "tom", marked: false, because: `${ruling.because}, but this runner may not call the delegate` };
  }
  return ruling;
}

// ── Known away ───────────────────────────────────────────────────────────────

export const KNOWN_AWAY_QUIET_MS = 2 * 60 * 60_000;

/**
 * Whether Tom is known to be away, and the sentence why. Away is: no turn from
 * him in a session and no Slack reply from him inside two hours, or a calendar
 * block covering now.
 *
 * The brief named a third read, the sleep window on the week page. The week
 * page names no sleep window, and a fixed night window here would be a fact
 * invented about him; the two-hour silence already covers a night.
 *
 * `because` never names a calendar row: a private feed's rows are never named
 * in anything he reads, and this sentence can reach a check-in.
 */
export async function knownAway(ctx: QueryCtx, now: number): Promise<{ away: boolean; because: string }> {
  const turn = await ctx.db
    .query("claudeInbound")
    .withIndex("by_author", (q) => q.eq("author", "tom"))
    .order("desc")
    .first();
  if (turn && now - turn.createdAt < KNOWN_AWAY_QUIET_MS) {
    const block = await calendarBlockAt(ctx, now);
    if (block) return { away: true, because: "a calendar block covers now" };
    return { away: false, because: "Tom typed in a session within the last two hours" };
  }
  const tomSlackUser = process.env.TOM_SLACK_USER_ID;
  const replies = await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_at", (q) => q.eq("kind", "slack-event").gte("at", now - KNOWN_AWAY_QUIET_MS))
    .order("desc")
    .take(20);
  // The events route admits only Tom's messages, so every slack-event row is
  // his; the user check is kept for when that route ever admits another.
  const replied = replies.some((row) => {
    const user = (row.data as { user?: unknown } | undefined)?.user;
    return tomSlackUser === undefined || user === tomSlackUser;
  });
  if (await calendarBlockAt(ctx, now)) return { away: true, because: "a calendar block covers now" };
  if (replied) return { away: false, because: "Tom replied in Slack within the last two hours" };
  return { away: true, because: "Tom has not typed in a session or replied in Slack for two hours" };
}

async function calendarBlockAt(ctx: QueryCtx, now: number) {
  // An event covering now started at most a day ago; an all-day row is a date,
  // not a block of his time.
  const started = await ctx.db
    .query("ttsCalendarEvents")
    .withIndex("by_start", (q) => q.gte("start", now - 24 * 60 * 60_000).lte("start", now))
    .take(200);
  return started.some((event) => !event.allDay && event.end > now);
}

export const internalKnownAway = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, { now }) => knownAway(ctx, now),
});

// ── The create door ──────────────────────────────────────────────────────────

const RUNNER_SUBJECT = v.union(
  v.object({ kind: v.literal("todo"), todoId: v.id("dtsTodos") }),
  v.object({ kind: v.literal("batch"), batchId: v.id("batches") }),
);

const RUNNER_SOURCE = v.union(
  v.object({ kind: v.literal("prompt"), text: v.string() }),
  v.object({ kind: v.literal("handoff"), runnerId: v.id("runners") }),
  v.object({ kind: v.literal("document"), text: v.string() }),
);

export const RUNNER_SEED = {
  title: v.string(),
  type: RUNNER_TYPE,
  experimentHost: v.union(v.literal("turing"), v.literal("box")),
  repo: v.string(),
  ref: v.optional(v.string()),
  stepMs: v.number(),
  model: v.optional(SESSION_MODEL),
  delegateAllowed: v.optional(v.boolean()),
  budgetGpuHours: v.optional(v.number()),
  askOverrides: v.optional(v.array(v.object({ tier: RUNNER_TIER, answerer: RUNNER_ANSWERER }))),
  subject: v.optional(RUNNER_SUBJECT),
  from: RUNNER_SOURCE,
};
const RUNNER_SEED_OBJECT = v.object(RUNNER_SEED);
export type RunnerSeed = Infer<typeof RUNNER_SEED_OBJECT>;

/** The seed's faults, each a sentence, or an empty list. The HTTP route and
 *  the Tom-only mutation both refuse through this before anything is written. */
export function runnerSeedFaults(seed: RunnerSeed): string[] {
  const faults: string[] = [];
  const title = seed.title.trim();
  if (title === "") faults.push("A runner needs a title.");
  if (title.length > RUNNER_TITLE_MAX) faults.push(`A runner's title is at most ${RUNNER_TITLE_MAX} characters.`);
  if (/[\r\n]/.test(title)) faults.push("A runner's title is one line.");
  if (seed.repo !== NO_REPO && !(SESSION_REPO_NAMES as readonly string[]).includes(seed.repo)) {
    faults.push(`The repo must be one of ${SESSION_REPO_NAMES.join(", ")}, or "none".`);
  }
  if (seed.ref !== undefined && seed.repo === NO_REPO) faults.push("A ref needs a repo to resolve it in.");
  if (seed.ref !== undefined && !/^[\w./-]{1,200}$/.test(seed.ref)) faults.push("The ref is not a branch, tag or commit name.");
  if (!Number.isInteger(seed.stepMs) || seed.stepMs < RUNNER_STEP_MIN_MS || seed.stepMs > RUNNER_STEP_MAX_MS) {
    faults.push("The step length must be a whole number of milliseconds between five minutes and a day.");
  }
  if (seed.model !== undefined && SESSION_MODELS[seed.model].family !== "claude") {
    faults.push("A runner's steps run on Claude; name opus, sonnet or fable, or no model.");
  }
  if (seed.budgetGpuHours !== undefined && !(Number.isFinite(seed.budgetGpuHours) && seed.budgetGpuHours >= 0)) {
    faults.push("The GPU-hour budget must be a number of hours, zero or more.");
  }
  const tiers = (seed.askOverrides ?? []).map((cell) => cell.tier);
  if (new Set(tiers).size !== tiers.length) faults.push("Each tier may be overridden once.");
  if (seed.delegateAllowed === false && (seed.askOverrides ?? []).some((cell) => cell.answerer === "delegate")) {
    faults.push("An override names the delegate on a runner that may not call it.");
  }
  if (seed.from.kind !== "handoff" && seed.from.text.trim() === "") {
    faults.push(`A runner started from a ${seed.from.kind} needs its text.`);
  }
  return faults;
}

/** The one-section document a runner started from a prompt holds until its
 *  first step writes the rest. */
export function promptDocument(title: string, text: string): string {
  return `# ${title}\n\n## Objective\n\n${text.trim()}\n`;
}

/** A successor's document: the predecessor's final document under a section
 *  that says where it came from. */
export function handoffDocument(from: { title: string; document: string }): string {
  return `## Handed off from ${from.title}\n\nThis runner continues the one named above. Its final document follows as it stood.\n\n${from.document.trim()}\n`;
}

/**
 * THE ONLY PLACE A runners ROW IS INSERTED. It writes the row, the first
 * document event, and the first step request, due now; a Convex mutation is
 * one transaction, so a refusal writes none of the three.
 */
export async function insertRunner(
  ctx: MutationCtx,
  seed: RunnerSeed,
  createdBy: Doc<"runners">["createdBy"],
  now: number,
): Promise<Id<"runners">> {
  const faults = runnerSeedFaults(seed);
  if (faults.length > 0) throw new Error(faults.join(" "));
  let document: string;
  if (seed.from.kind === "handoff") {
    const from = await ctx.db.get(seed.from.runnerId);
    if (!from) throw new Error("The runner named to hand off from does not exist.");
    document = handoffDocument(from);
  } else if (seed.from.kind === "prompt") {
    document = promptDocument(seed.title.trim(), seed.from.text);
  } else {
    document = seed.from.text;
  }
  if (document.length > RUNNER_DOCUMENT_MAX) throw new Error(`A runner's document is at most ${RUNNER_DOCUMENT_MAX} characters.`);
  const runnerId = await ctx.db.insert("runners", {
    title: seed.title.trim(),
    type: seed.type,
    ...(seed.subject ? { subject: seed.subject } : {}),
    experimentHost: seed.experimentHost,
    repo: seed.repo,
    ...(seed.ref !== undefined ? { ref: seed.ref } : {}),
    stepMs: seed.stepMs,
    nextStepAt: now,
    ...(seed.budgetGpuHours !== undefined ? { budgetGpuHours: seed.budgetGpuHours } : {}),
    ...(seed.model !== undefined ? { model: seed.model } : {}),
    delegateAllowed: seed.delegateAllowed ?? true,
    ...(seed.askOverrides !== undefined ? { askOverrides: seed.askOverrides } : {}),
    document,
    documentVersion: 1,
    createdBy,
    createdAt: now,
  });
  await ctx.db.insert("runnerEvents", {
    runnerId,
    at: now,
    kind: "document",
    text: document,
    data: { version: 1, from: seed.from.kind },
  });
  await openStep(ctx, runnerId, now);
  return runnerId;
}

export const internalCreateRunner = internalMutation({
  args: { seed: RUNNER_SEED_OBJECT, createdBy: v.optional(v.object({ kind: v.literal("run"), runId: v.string() })) },
  handler: async (ctx, { seed, createdBy }) => insertRunner(ctx, seed, createdBy ?? { kind: "tom" }, Date.now()),
});

/** Tom opens a runner from a session he is in. Same seed, same builder. */
export const createRunner = mutation({
  args: RUNNER_SEED,
  handler: async (ctx, seed) => {
    await requireTom(ctx, "Runners");
    return insertRunner(ctx, seed, { kind: "tom" }, Date.now());
  },
});

// ── The step schedule ────────────────────────────────────────────────────────

/** The newest step of this runner that was given a run id: its id becomes the
 *  next step run's continuesRunId. */
async function lastStepRunId(ctx: QueryCtx, runnerId: Id<"runners">): Promise<string | undefined> {
  const recent = await ctx.db
    .query("runnerSteps")
    .withIndex("by_runner_due", (q) => q.eq("runnerId", runnerId))
    .order("desc")
    .take(20);
  return recent.find((step) => step.stepRunId !== undefined)?.stepRunId;
}

/** This runner's step that is waiting to be claimed or is running, if any. */
async function liveStep(ctx: QueryCtx, runnerId: Id<"runners">) {
  const recent = await ctx.db
    .query("runnerSteps")
    .withIndex("by_runner_due", (q) => q.eq("runnerId", runnerId))
    .order("desc")
    .take(20);
  return recent.find((step) => step.status === "requested" || step.status === "claimed") ?? null;
}

export const STEP_DEFERRED_REASON = "deferred: the step before it was still running";

/**
 * Open the runner's next step: a runnerSteps row, requested, due now. Nothing
 * when the runner has ended or a step is already waiting or running. A lease
 * still inside its deadline means the step before is still at work: that is
 * recorded as a deferred step, never as silence, so the next check-in can say
 * a step was skipped and why.
 */
export async function openStep(ctx: MutationCtx, runnerId: Id<"runners">, now: number) {
  const runner = await ctx.db.get(runnerId);
  if (!runner || runner.endedAt !== undefined) return null;
  if (await liveStep(ctx, runnerId)) return null;
  if (runner.lease && runner.lease.deadline >= now) {
    await ctx.db.insert("runnerSteps", {
      runnerId, environment: "runner", dueAt: now, status: "failed", finishedAt: now, reason: STEP_DEFERRED_REASON,
    });
    return null;
  }
  const previousStepRunId = await lastStepRunId(ctx, runnerId);
  return ctx.db.insert("runnerSteps", {
    runnerId,
    environment: "runner",
    dueAt: now,
    status: "requested",
    ...(previousStepRunId !== undefined ? { previousStepRunId } : {}),
  });
}

export const internalOpenStep = internalMutation({
  args: { runnerId: v.id("runners") },
  handler: async (ctx, { runnerId }) => {
    const runner = await ctx.db.get(runnerId);
    // A scheduled call that arrives before nextStepAt is a stale prompt from a
    // schedule the check-in has since moved; the newer call is already queued.
    if (!runner || Date.now() < runner.nextStepAt) return null;
    return openStep(ctx, runnerId, Date.now());
  },
});

// ── The claim ────────────────────────────────────────────────────────────────

/** How long a step may hold its runner: four step lengths, at most two hours.
 *  A step alive past this is a step whose process died, and the sweep frees
 *  the runner for the next. */
export function leaseMs(stepMs: number): number {
  return Math.min(4 * stepMs, 2 * 60 * 60_000);
}

/** The run record's link to one run, the one spelling a check-in carries. */
export function runLink(runId: string): string {
  return `https://www.tom.quest/sessions?run=${encodeURIComponent(runId)}`;
}

/** A step run's id: a Claude run on the box, under a session id minted here.
 *  The box starts the CLI with that session id, so the run record's own id for
 *  the step is known before the step exists, and the next step's
 *  continuesRunId names it exactly. */
export function mintStepRunId(): string {
  return `claude:box:${crypto.randomUUID()}`;
}

export const STEP_FAILED = {
  restarted: "the box's daemon restarted while this step was running",
  noCheckIn: "the step ended without checking in",
  notLaunched: "the box could not launch the step",
} as const;

/** The step requests the box should launch now, for the poll payload. */
export async function dueRunnerSteps(ctx: QueryCtx, now: number) {
  const due = await ctx.db
    .query("runnerSteps")
    .withIndex("by_status_due", (q) => q.eq("status", "requested").lte("dueAt", now))
    .take(20);
  const out = [];
  for (const step of due) {
    const runner = await ctx.db.get(step.runnerId);
    if (!runner) continue;
    out.push({
      stepId: step._id,
      runnerId: runner._id,
      title: runner.title,
      repo: runner.repo,
      ...(runner.ref !== undefined ? { ref: runner.ref } : {}),
      model: runner.model ?? DEFAULT_RUNNER_MODEL,
      ...(step.previousStepRunId !== undefined ? { previousStepRunId: step.previousStepRunId } : {}),
      stepMs: runner.stepMs,
    });
  }
  return out;
}

/**
 * ADMISSION, in one transaction. The step is admitted only when the runner's
 * lease is free or past its deadline; Convex serializes two claimers, so two
 * daemons cannot both hold it. Admission mints the step run's id, takes the
 * lease, marks the request claimed and returns the prompt. A refusal is an
 * answer too: the request is written failed with a fixed reason, so the queue
 * drains.
 */
export const internalClaimRunnerStep = internalMutation({
  args: { stepId: v.id("runnerSteps") },
  handler: async (ctx, { stepId }) => {
    const now = Date.now();
    const step = await ctx.db.get(stepId);
    if (!step || step.status !== "requested") return { admitted: false as const, reason: "the step is no longer requested" };
    const runner = await ctx.db.get(step.runnerId);
    if (!runner || runner.endedAt !== undefined) {
      await ctx.db.patch(stepId, { status: "failed", finishedAt: now, reason: "the runner has ended" });
      return { admitted: false as const, reason: "the runner has ended" };
    }
    if (runner.lease && runner.lease.deadline >= now) {
      await ctx.db.patch(stepId, { status: "failed", finishedAt: now, reason: STEP_DEFERRED_REASON });
      return { admitted: false as const, reason: STEP_DEFERRED_REASON };
    }
    // A lease past its deadline is a dead step the sweep has not reached yet.
    if (runner.lease) await expireLease(ctx, runner, now);
    const stepRunId = mintStepRunId();
    await ctx.db.patch(runner._id, { lease: { stepRunId, deadline: now + leaseMs(runner.stepMs), takenAt: now } });
    await ctx.db.patch(stepId, { status: "claimed", claimedAt: now, stepRunId });
    const prompt = await buildStepPrompt(ctx, (await ctx.db.get(runner._id))!, stepRunId, now);
    return {
      admitted: true as const,
      stepRunId,
      runnerId: runner._id,
      repo: runner.repo,
      ...(runner.ref !== undefined ? { ref: runner.ref } : {}),
      model: runner.model ?? DEFAULT_RUNNER_MODEL,
      ...(step.previousStepRunId !== undefined ? { previousStepRunId: step.previousStepRunId } : {}),
      prompt,
    };
  },
});

/**
 * The box's word that a step's process has exited. A step that checked in is
 * already done and this changes nothing. One that did not failed: the lease it
 * held is freed, a step-failed event says why, the next step is scheduled a
 * step length on, and #tts-broken hears once.
 */
export const internalFinishRunnerStep = internalMutation({
  args: { stepId: v.id("runnerSteps"), exitCode: v.number(), launched: v.boolean() },
  handler: async (ctx, { stepId, exitCode, launched }) => {
    const now = Date.now();
    const step = await ctx.db.get(stepId);
    if (!step) return { recorded: false };
    if (step.status !== "claimed") return { recorded: false };
    const reason = launched ? STEP_FAILED.noCheckIn : STEP_FAILED.notLaunched;
    await ctx.db.patch(stepId, { status: "failed", finishedAt: now, reason });
    const runner = await ctx.db.get(step.runnerId);
    if (!runner) return { recorded: true };
    await failStep(ctx, runner, step.stepRunId, `${reason} (exit ${exitCode})`, now);
    return { recorded: true };
  },
});

/** One step died: its event, the lease freed if it was this step's, the next
 *  step scheduled, one #tts-broken line per runner per day. */
async function failStep(ctx: MutationCtx, runner: Doc<"runners">, stepRunId: string | undefined, reason: string, now: number) {
  await ctx.db.insert("runnerEvents", {
    runnerId: runner._id,
    at: now,
    kind: "step-failed",
    ...(stepRunId !== undefined ? { stepRunId } : {}),
    text: reason,
  });
  const patch: Partial<Doc<"runners">> = {};
  if (runner.lease && (stepRunId === undefined || runner.lease.stepRunId === stepRunId)) patch.lease = undefined;
  if (runner.endedAt === undefined) {
    const nextStepAt = now + runner.stepMs;
    patch.nextStepAt = nextStepAt;
    await ctx.scheduler.runAt(nextStepAt, internal.ttsRunners.internalOpenStep, { runnerId: runner._id });
  }
  await ctx.db.patch(runner._id, patch);
  await ctx.scheduler.runAfter(0, internal.ttsSync.sendBroken, {
    job: `runner:${runner._id}`,
    statement: "A runner's step stopped before it checked in, so that step's look at the experiment was lost; the next step runs on schedule.",
    detail: redactSecrets(`${runner.title}: ${reason}`),
    ...(stepRunId !== undefined ? { url: runLink(stepRunId) } : {}),
  });
}

/** A lease past its deadline: the step that held it is dead. Its request row
 *  is failed and failStep does the rest. */
async function expireLease(ctx: MutationCtx, runner: Doc<"runners">, now: number) {
  const stepRunId = runner.lease?.stepRunId;
  const recent = await ctx.db
    .query("runnerSteps")
    .withIndex("by_runner_due", (q) => q.eq("runnerId", runner._id))
    .order("desc")
    .take(20);
  const held = recent.find((step) => step.stepRunId === stepRunId && step.status === "claimed");
  if (held) await ctx.db.patch(held._id, { status: "failed", finishedAt: now, reason: STEP_FAILED.restarted });
  await failStep(ctx, runner, stepRunId, STEP_FAILED.restarted, now);
}

/**
 * The backstop, every minute. nextStepAt is the truth about the schedule and
 * the scheduled call is only its prompt, so this opens a step for any live
 * runner that is due with none waiting or running, and expires any lease past
 * its deadline. Nothing else recovers a lost schedule.
 */
export const internalRunnerSweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const live = await ctx.db
      .query("runners")
      .withIndex("by_ended", (q) => q.eq("endedAt", undefined))
      .take(100);
    for (const runner of live) {
      if (runner.lease && runner.lease.deadline < now) {
        await expireLease(ctx, runner, now);
        continue;
      }
      if (runner.nextStepAt <= now) await openStep(ctx, runner._id, now);
    }
  },
});

// ── The step prompt ──────────────────────────────────────────────────────────

async function buildStepPrompt(ctx: QueryCtx, runner: Doc<"runners">, stepRunId: string, _now: number): Promise<string> {
  return [
    `You are one step of the runner "${runner.title}". Your step run id is ${stepRunId}.`,
    "## The document",
    runner.document,
  ].join("\n\n");
}
