import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireTom, requireTomOrAgent } from "./authRoles";
import { redactSecrets } from "../shared/redact.mjs";
import { CHECKIN_RULES, checkInFailures } from "../shared/checkin-rules.mjs";
import { assembleContext, type ContextSubject } from "./ttsContext";
import type { RunnerFact } from "./ttsCompose";
import {
  BOX_TOOLS_PARAGRAPH,
  DAEMON_RESTART_SENTENCE,
  NARROW_LIST,
  RUNNER_ACT_PARAGRAPH,
  RUNNER_ANSWERER,
  RUNNER_CEILING,
  RUNNER_CEILING_DEFAULT,
  RUNNER_DECISION,
  RUNNER_TIERS,
  RUNNER_TIER,
  RUNNER_TYPE,
  SESSION_MODEL,
  SESSION_MODELS,
  SESSION_REPO_NAMES,
  NO_REPO,
  CEILING_REPLY_FORM,
  parseCeilingReply,
  runnerCeilingFaults,
  runnerCeilingWords,
  type RunnerAnswerer,
  type RunnerCeiling,
  type RunnerTier,
  type SessionModel,
} from "./ttsShared";

// ── Runners ──────────────────────────────────────────────────────────────────
// A runner watches one experiment through a chain of short step agents on the
// box. The row (convex/schema.ts `runners`) holds the handoff document, the
// step length and the lease; each step starts cold from the document, checks
// in, rewrites the document and ends. This module is the row's one writer:
// internalCreateRunner below is the only insert, and the step schedule, the
// claim and the check-in record live beside it.

/** A step's model when the runner names none. A runner step is a Claude run
 *  launched with a session id the claim mints (see internalClaimRunnerStep),
 *  and Codex takes no such id, so the default is Claude's strongest rather than
 *  the fleet's DEFAULT_SESSION_MODEL, which is a Codex model. */
const DEFAULT_RUNNER_MODEL: SessionModel = "opus";

const RUNNER_TITLE_MAX = 200;
const RUNNER_DOCUMENT_MAX = 200_000;
/** The shortest step the schedule takes. A step is a whole cold run: shorter
 *  than this and the next is due before the last has read its document. */
const RUNNER_STEP_MIN_MS = 5 * 60_000;
const RUNNER_STEP_MAX_MS = 24 * 60 * 60_000;

/** The runner's ceiling per request, the default when the row names none. */
function ceilingOf(runner: Pick<Doc<"runners">, "ceiling">): RunnerCeiling {
  return runner.ceiling ?? RUNNER_CEILING_DEFAULT;
}

// ── Status, derived ──────────────────────────────────────────────────────────

type RunnerStatus = "done" | "failed" | "handed-off" | "waiting-on-tom" | "running";

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

/** This runner's asks nobody has answered, blocking or not. */
async function openAsks(ctx: QueryCtx, runnerId: Id<"runners">) {
  return ctx.db
    .query("runnerEvents")
    .withIndex("by_open_ask", (q) => q.eq("runnerId", runnerId).eq("kind", "ask").eq("answeredAt", undefined))
    .take(50);
}

/** This runner's asks Tom has not answered that hold its steps to observing. */
export async function openBlockingAsks(ctx: QueryCtx, runnerId: Id<"runners">) {
  return (await openAsks(ctx, runnerId)).filter((ask) => ask.blocking === true);
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

type AnswererRuling = {
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

const KNOWN_AWAY_QUIET_MS = 2 * 60 * 60_000;

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

const RUNNER_SUBJECT = v.object({ kind: v.literal("todo"), todoId: v.id("dtsTodos") });

const RUNNER_SOURCE = v.union(
  v.object({ kind: v.literal("prompt"), text: v.string() }),
  v.object({ kind: v.literal("handoff"), runnerId: v.id("runners") }),
  v.object({ kind: v.literal("document"), text: v.string() }),
);

const RUNNER_SEED = {
  title: v.string(),
  type: RUNNER_TYPE,
  experimentHost: v.union(v.literal("turing"), v.literal("box")),
  repo: v.string(),
  ref: v.optional(v.string()),
  stepMs: v.number(),
  model: v.optional(SESSION_MODEL),
  delegateAllowed: v.optional(v.boolean()),
  budgetGpuHours: v.optional(v.number()),
  ceiling: v.optional(RUNNER_CEILING),
  specs: v.optional(v.array(v.string())),
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
  if (seed.ceiling !== undefined) faults.push(...runnerCeilingFaults(seed.ceiling));
  if (seed.specs !== undefined) {
    if (seed.repo === NO_REPO) faults.push("Sweep specs need a repo to expand them in.");
    if (seed.specs.length > 50 || seed.specs.some((spec) => !/^[\w.*?/[\]-]{1,200}$/.test(spec) || spec.startsWith("/") || spec.split("/").includes(".."))) {
      faults.push("Sweep specs are at most fifty glob patterns relative to the repo.");
    }
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
function promptDocument(title: string, text: string): string {
  return `# ${title}\n\n## Objective\n\n${text.trim()}\n`;
}

/** A successor's document: the predecessor's final document under a section
 *  that says where it came from. */
function handoffDocument(from: { title: string; document: string }): string {
  return `## Handed off from ${from.title}\n\nThis runner continues the one named above. Its final document follows as it stood.\n\n${from.document.trim()}\n`;
}

/**
 * THE ONLY PLACE A runners ROW IS INSERTED. It writes the row, the first
 * document event, and the first step request, due now; a Convex mutation is
 * one transaction, so a refusal writes none of the three.
 */
async function insertRunner(
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
    // Named only on Tom's own form (createRunner); the pen refuses one, and a
    // hand-off successor starts at the default like any runner, since anyone
    // holding the pen's key could otherwise hand off from a raised runner.
    ...(seed.ceiling !== undefined ? { ceiling: seed.ceiling } : {}),
    ...(seed.specs !== undefined ? { specs: seed.specs } : {}),
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
  args: { ...RUNNER_SEED, subject: v.optional(RUNNER_SUBJECT) },
  handler: async (ctx, { subject, ...rest }) => {
    await requireTom(ctx, "Runners");
    return insertRunner(ctx, { ...rest, ...(subject ? { subject } : {}) }, { kind: "tom" }, Date.now());
  },
});

// ── The step schedule ────────────────────────────────────────────────────────

/** The newest step of this runner that was given an agent id: its id becomes
 *  the next step agent's continuesRunId. */
async function lastStepAgentId(ctx: QueryCtx, runnerId: Id<"runners">): Promise<string | undefined> {
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

const STEP_DEFERRED_REASON = "deferred: the step before it was still running";

/**
 * Open the runner's next step: a runnerSteps row, requested, due now. Nothing
 * when the runner has ended or a step is already waiting or running. A lease
 * still inside its deadline means the step before is still at work: that is
 * recorded as a deferred step, never as silence, so the next check-in can say
 * a step was skipped and why.
 */
async function openStep(ctx: MutationCtx, runnerId: Id<"runners">, now: number) {
  const runner = await ctx.db.get(runnerId);
  if (!runner || runner.endedAt !== undefined) return null;
  if (await liveStep(ctx, runnerId)) return null;
  if (runner.lease && runner.lease.deadline >= now) {
    await ctx.db.insert("runnerSteps", {
      runnerId, environment: "runner", dueAt: now, status: "failed", finishedAt: now, reason: STEP_DEFERRED_REASON,
    });
    return null;
  }
  const previousStepRunId = await lastStepAgentId(ctx, runnerId);
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
function leaseMs(stepMs: number): number {
  return Math.min(4 * stepMs, 2 * 60 * 60_000);
}

/** The record's link to one agent, the one spelling a check-in carries. */
export function agentLink(agentId: string): string {
  return `https://www.tom.quest/agents?agent=${encodeURIComponent(agentId)}`;
}

/** A step agent's id: a Claude agent on the box, under a session id minted
 *  here. The box starts the CLI with that session id, so the record's own id
 *  for the step is known before the step exists, and the next step's
 *  continuesRunId names it exactly. */
function mintStepAgentId(): string {
  return `claude:box:${crypto.randomUUID()}`;
}

const STEP_FAILED = {
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
 * daemons cannot both hold it. Admission mints the step agent's id, takes the
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
    const stepRunId = mintStepAgentId();
    await ctx.db.patch(runner._id, { lease: { stepRunId, deadline: now + leaseMs(runner.stepMs), takenAt: now } });
    await ctx.db.patch(stepId, { status: "claimed", claimedAt: now, stepRunId });
    const prompt = await buildRunnerStepPrompt(ctx, { runner: (await ctx.db.get(runner._id))!, stepRunId, now });
    const since = await sinceLastCheckIn(ctx, runner._id);
    return {
      admitted: true as const,
      stepRunId,
      runnerId: runner._id,
      // The box hands the step the runner key only when this is true, so a step
      // told to change nothing cannot act on the cluster and then find its
      // check-in refused, which would leave the act out of the record.
      actsOnCluster: mayActOnCluster(runner, (await openBlockingAsks(ctx, runner._id)).length),
      repo: runner.repo,
      ...(runner.ref !== undefined ? { ref: runner.ref } : {}),
      model: runner.model ?? DEFAULT_RUNNER_MODEL,
      ...(step.previousStepRunId !== undefined ? { previousStepRunId: step.previousStepRunId } : {}),
      prompt,
      // What the box's sensor needs beside the checkout.
      sensor: {
        specs: runner.specs ?? [],
        ...(runner.budgetGpuHours !== undefined ? { budgetGpuHours: runner.budgetGpuHours } : {}),
        ceiling: ceilingOf(runner),
        failures: since.failures.map((failure) => ({ at: failure.at, text: failure.text ?? "" })),
      },
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
    ...(stepRunId !== undefined ? { url: agentLink(stepRunId) } : {}),
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

/** Where the daemon writes the sensor's facts block into the prompt. A daemon
 *  that has not been rolled out yet leaves it, and the step reads the line
 *  below it saying the facts were not read. */
const FACTS_PLACEHOLDER = "@@RUNNER_FACTS@@";

/** Everything since this runner's last check-in that the next step must see:
 *  Tom's replies, whole, and every step that failed or was skipped. */
async function sinceLastCheckIn(ctx: QueryCtx, runnerId: Id<"runners">) {
  const last = await ctx.db
    .query("runnerEvents")
    .withIndex("by_runner_kind_at", (q) => q.eq("runnerId", runnerId).eq("kind", "check-in"))
    .order("desc")
    .first();
  const since = last?.at ?? 0;
  const replies = await ctx.db
    .query("runnerEvents")
    .withIndex("by_runner_kind_at", (q) => q.eq("runnerId", runnerId).eq("kind", "reply").gt("at", since))
    .take(50);
  const failures = await ctx.db
    .query("runnerEvents")
    .withIndex("by_runner_kind_at", (q) => q.eq("runnerId", runnerId).eq("kind", "step-failed").gt("at", since))
    .take(50);
  const steps = await ctx.db
    .query("runnerSteps")
    .withIndex("by_runner_due", (q) => q.eq("runnerId", runnerId).gt("dueAt", since))
    .take(100);
  const deferred = steps.filter((step) => step.status === "failed" && step.reason === STEP_DEFERRED_REASON).length;
  return { lastCheckIn: last, replies, failures, deferred };
}

const TIER_MEANING: Record<RunnerTier, string> = {
  routine: "a question inside the plan the document already states: which cell to look at, whether a warning is the known benign one, when to look again",
  plan: "a question that changes what the experiment is: a different spec, a stage skipped, a result read a new way, a stop condition moved",
  setup: "a question that changes what the experiment costs or where it runs: more GPUs, a longer time limit, another partition, a spend against the budget",
};

const ANSWERER_WORDS: Record<RunnerAnswerer, string> = {
  self: "you decide it and say what you decided in the check-in",
  tom: "Tom answers it: raise it with --ask, and it opens a thread in #tts-needs-you",
  delegate: "the delegate answers it through tts-ask; its answer is a decision Tom may object to",
};

/** The rubric column for this runner, overrides applied, as the step reads it. */
function renderRubric(runner: Pick<Doc<"runners">, "type" | "delegateAllowed" | "askOverrides">, knownAwayNow: { away: boolean; because: string }): string {
  const lines = [
    `The asking rubric for this runner (a ${runner.type}). Before you ask anything, judge its tier. The tier names are this prompt's words, not Tom's: a check-in describes the kind of question in plain words and never names its tier.`,
  ];
  for (const tier of RUNNER_TIERS) {
    const now = answererFor(runner, tier, { knownAway: knownAwayNow.away });
    const later = tier === "plan" && runner.type === "campaign" && now.answerer === "tom"
      ? answererFor(runner, tier, { knownAway: knownAwayNow.away, stepsUnanswered: 1 })
      : null;
    const after = later && later.answerer !== now.answerer ? ` If a whole step passes with no answer from Tom, ${ANSWERER_WORDS[later.answerer]}.` : "";
    lines.push(`- ${tier}: ${TIER_MEANING[tier]}. Now, ${ANSWERER_WORDS[now.answerer]}${now.marked ? ", and it is marked for his objection list in the morning" : ""}.${after}`);
  }
  lines.push(`Tom is ${knownAwayNow.away ? "known to be away" : "taken to be present"} right now: ${knownAwayNow.because}.`);
  if (!runner.delegateAllowed) lines.push("This runner may never call the delegate; every question that is not yours to decide is Tom's.");
  return lines.join("\n");
}

/**
 * What every check-in promises, beside the form rules the pen runs. Tom's
 * writing standard defines every term outside his known list at first use,
 * and a label invented inside a prompt is the likeliest to reach him
 * undefined: the proof run's three check-ins each failed the judge twice on
 * this prompt's own words (a tier name, "this runner", an exit code) and on a
 * question with no default. So the prompt names those words here.
 */
function checkInContract(runner: Pick<Doc<"runners">, "title" | "stepMs" | "ceiling">): string {
  const minutes = Math.round(runner.stepMs / 60_000);
  return [
    "## The check-in",
    "Tom reads the check-in on his phone, with no memory of this prompt or the document, and a judge reads it against his writing standard before he does. Read that standard before you write: `tts-search skills write` prints it, and the ground.md it names beside it lists the terms he already knows. The judge fails a check-in on any line of it. Every check-in also keeps these promises:",
    `- It passes the pen's form rules, which run before the judge: ${CHECKIN_RULES.map((rule) => rule.why).join("; ")}.`,
    `- Name this runner once, in the first sentence, by its title in Tom's record, "${runner.title}", saying that it is an agent that checks the experiment in steps, and write as I after that: never "this runner", "the runner", "the agent" or "the watch".`,
    "- Define at first use, inline, every term this prompt or the document introduces: the experiment's short name with what the experiment is, a percentage with what it is a share of, and the document as the runner's notes for its next step. A label that serves only this prompt, such as a tier name, is not his: describe the thing instead (a question that changes what the experiment is), and leave out any word you cannot define in a clause.",
    "- Name only what Tom needs to know where the experiment stands or to answer a question. The document is written in the code's words: a script, a log, a stop condition or a stage you mention is described by what it does, in words, or left out. Never ask him to type a command.",
    "- Describe a process's exit code or an HTTP status in words: say the step's process was stopped by a signal, or the cluster refused the request as unauthorized, never the bare number.",
    `- For every question open for Tom, new or still unanswered, say what the next step will do if he does not answer, and when, as one clock time given once: the next step runs about ${minutes} minutes after this check-in is recorded, unless you move it with --next-step-ms, and a moved step says why. A new question goes under the one "Rulings requested" heading, numbered, each one paragraph: what is gained and lost each way, the one you recommend and why, and that default. The default is the recommendation, since Tom takes a recommendation he does not answer as agreed.`,
    `- A launch that needs more than my ceiling, now ${runnerCeilingWords(ceilingOf(runner))}, is a question under "Rulings requested" like any other: say how many GPUs, how long and how much memory it needs, and what for. Tom raises the ceiling with ${CEILING_REPLY_FORM}; say that form in the question in plain words. You never raise it yourself and never ask anyone but Tom to.`,
    `- Put the numbers from the facts block in one short Markdown table with two columns, what was counted and what this step found, and say so in the sentence before it, with what one unit of work is: one stage of the pipeline for one sweep setting, such as training one model, finished once its output folder holds a completion marker. The table takes about a third of the length cap, so the prose around it stays short. Its rows, in these words: jobs on the account running on the cluster; GPUs free on the cluster; units of work the sweep files ask for (the frontier's size); units known finished (its done count); my steps that failed since the last check-in; GPU-hours this runner's jobs used since I began. A quantity the box could not read or check is a row that says so and why, in words, with no number: a count carried over from an earlier step or a total of zero because nothing was read counts nothing seen.`,
    "- Say what was seen and what was done; never grade your own work.",
    "- Name each job this step launched or cancelled on the cluster in one sentence: what it was for, and how you saw it take effect, the new job in the queue by its name or the cancelled one gone from it. Name at most two this way and count the rest in one sentence, since the table already takes a third of the length cap. A launch the budget refused, or one the cluster refused as not this runner's to make, is said in words, with what you will do instead.",
    "- Write no colon in a prose line; the label rule refuses a short opening phrase before one.",
    "- Before you call the pen, reread the draft once as the judge will: find each word Tom would not know, from this prompt, the document or the code, and define it where it first appears or cut it.",
  ].join("\n");
}

/** Whether a step may launch and cancel jobs on the cluster: its experiment
 *  runs on Turing and no blocking question of Tom's is open. The one predicate
 *  the prompt, the claim (whether the box hands the step the runner key) and
 *  the record (whether it takes the step's acts) all read. */
function mayActOnCluster(runner: Pick<Doc<"runners">, "experimentHost">, openBlockingAsks: number): boolean {
  return runner.experimentHost === "turing" && openBlockingAsks === 0;
}

function stepBranch(runnerId: Id<"runners">): string {
  return `runner/${runnerId}`;
}

/**
 * The prompt one step starts from, cold. In order: what a step is, the
 * document, the facts block, Tom's replies since the last step, the failures
 * and skips since then, the step contract, the rubric, the never list, the
 * tools, the pens, and how to end.
 *
 * A runner with an unanswered blocking ask gets an OBSERVE-ONLY step: the act
 * clause says change nothing, and the decisions narrow to continue or ask.
 * Steps keep running on schedule, so Tom still gets his tick.
 */
async function buildRunnerStepPrompt(
  ctx: QueryCtx,
  { runner, stepRunId, now }: { runner: Doc<"runners">; stepRunId: string; now: number },
): Promise<string> {
  const since = await sinceLastCheckIn(ctx, runner._id);
  const blocking = await openBlockingAsks(ctx, runner._id);
  const observeOnly = blocking.length > 0;
  const away = await knownAway(ctx, now);
  const status = runnerStatus({ runner, openBlockingAsks: blocking.length });

  // A stored batch subject counts as no subject: the schema narrow removes it.
  const subject: ContextSubject = runner.subject?.kind === "todo"
    ? { kind: "todo", todoId: runner.subject.todoId }
    : runner.repo !== NO_REPO
      ? { kind: "repo", repo: runner.repo }
      : { kind: "none" };
  // A step whose skills cannot be routed still runs, and says so, as the box's
  // session-start hook does. assembleContext fails closed on an unposted
  // publication, and a throw here would roll the claim back and leave the
  // request to be claimed and refused on every poll.
  let grants: string;
  try {
    grants = (await assembleContext(ctx, subject, { reachesTom: true, caller: "runner-step", now })).grants;
  } catch (error) {
    grants = `SKILLS could not be routed: ${error instanceof Error ? error.message : String(error)}`;
  }

  const replies = since.replies.length === 0
    ? "Tom has not replied since the last step."
    : since.replies.map((reply) => `Tom replied at ${new Date(reply.at).toISOString()}:\n> ${(reply.text ?? "").split("\n").join("\n> ")}${ceilingReplyNote(reply.data)}`).join("\n\n");
  const missed: string[] = [];
  for (const failure of since.failures) missed.push(`- A step failed: ${failure.text ?? "no reason recorded"}.`);
  if (since.deferred > 0) missed.push(`- ${since.deferred} step${since.deferred === 1 ? " was" : "s were"} skipped because the step before was still running.`);

  const decisions = observeOnly ? "continue or ask" : "continue, change, ask, hand-off or finish";
  // A runner on a Turing experiment may launch and cancel its own jobs there,
  // through tts-turing-act; an observe-only step may not act at all.
  const actsOnCluster = mayActOnCluster(runner, blocking.length);
  const act = observeOnly
    ? `ACT: change nothing. Tom has not answered ${blocking.length === 1 ? "the blocking question" : `${blocking.length} blocking questions`} this runner asked (${blocking.map((ask) => `"${ask.text ?? ""}"`).join("; ")}), so this step observes and checks in, and does not act on the experiment, the checkout or the document's plan.`
    : `ACT on the decision. A change is the smallest one the document asks for, and the check-in says what it changed and how to undo it. Files you change in the checkout are committed on the branch ${stepBranch(runner._id)}, pushed with \`git push origin HEAD:refs/heads/${stepBranch(runner._id)}\`, and never merged or pushed to master; the checkout is deleted when this step ends, so an unpushed commit is lost.${actsOnCluster ? ` On the cluster you may launch jobs for this experiment and cancel the ones this runner launched, with \`tts-turing-act\` (under Tools), inside the runner's GPU-hour budget and its ceiling of ${runnerCeilingWords(ceilingOf(runner))}; each launch or cancel is recorded with the pen's \`--act\` and verified in the queue.` : ""}`;

  const pen = [
    "The step pen records your check-in and schedules the next step. Write the check-in to a file and the rewritten document to another, then call:",
    `\`tts-runner-step --runner ${runner._id} --step-run ${stepRunId} --decision <${decisions.replaceAll(" or ", "|").replaceAll(", ", "|")}> --check-in-file <path> --document <path>\``,
    "Add `--ask 'tier|blocking|question'` once per question for Tom (tier is routine, plan or setup; blocking is yes or no), and `--next-step-ms <n>` to bring the next step forward or push it back once.",
    ...(actsOnCluster ? ["Add `--act 'launch|<job id>|<what it was for and how it was verified>'` or `--act 'cancel|<job id>|<...>'` once per launch or cancel this step made; each becomes one entry in the record beside the check-in."] : []),
    "The pen checks the check-in against Tom's writing standard, first by its form rules and then by a judge. If it exits 5 it prints what failed and records nothing: rewrite the check-in once and call it again. A second failure is recorded and posted marked as having failed the writing check.",
  ];
  if (runner.delegateAllowed) {
    pen.push(`For a question the rubric gives the delegate: \`tts-ask --runner ${runner._id} --question "<one sentence>" --option "<a>" --option "<b>" --recommend "<the one you would take>" --fallback "<what you will do if it does not answer>"\`. It answers questions about how the work is run, never about what the experiment finds. At most five asks a day for this runner.`);
  }

  const narrow = NARROW_LIST.map((item) => `- ${item.decision}`).join("\n");
  const facts = `${FACTS_PLACEHOLDER}\n(If the line above is the bare placeholder, the box did not read the facts for this step: say so in the check-in and read what you need with the commands below.)`;

  return [
    grants,
    `You are one step of the runner "${runner.title}" (runner ${runner._id}), which is ${status}. A runner watches one experiment through a chain of short steps: each starts cold, reads the document below as its whole memory, looks at the experiment, decides one thing, acts on it, checks in, rewrites the document for the step after it, and ends. Nothing is re-entered, and nothing you do not write into the document survives this step. Your step agent is ${stepRunId}.`,
    `## The document (version ${runner.documentVersion})\n\n${runner.document}`,
    `## The facts, read by the box before you started\n\n${facts}`,
    `## Tom's replies since the last step\n\n${replies}`,
    `## Since the last check-in\n\n${missed.length > 0 ? missed.join("\n") : "No step failed or was skipped."}`,
    [
      "## The step",
      `OBSERVE. The facts above were read by deterministic code; start from them and judge. Look further where the document asks: the cluster with \`tts-turing jobs|gpus|output <name>\`, the results tree with \`tts-turing tree|node|read <path>\` (paths relative to the results root), and the checkout of ${runner.repo === NO_REPO ? "no repository (this step has an empty scratch directory)" : runner.repo} that is your working directory.`,
      `DECIDE one of: ${decisions}. Continue means the experiment needs nothing from you this step. Change means you will make one change. Ask means a question you may not answer yourself. Hand-off means this runner's work continues under a new runner from its document. Finish means the document's stop condition holds.`,
      act,
      "VERIFY every act on a channel other than the one that acted: a job submitted is seen in the queue, a file written is read back, a post is seen by its stored timestamp. The check-in names the verification for each act.",
      "CHECK IN through the pen below, with the document rewritten so the next step can start cold from it: what the experiment is, where it stands, what this step saw and did, and what the next step should look at first.",
    ].join("\n\n"),
    checkInContract(runner),
    renderRubric(runner, away),
    `## Never, in any cell of the rubric\n\nThese are Tom's alone. The delegate refuses them and so do you; a step that reaches one checks in with an ask for Tom and changes nothing:\n${narrow}`,
    `## Tools\n\n${BOX_TOOLS_PARAGRAPH}${actsOnCluster ? `\n\n${RUNNER_ACT_PARAGRAPH}` : ""}\n\n${DAEMON_RESTART_SENTENCE}`,
    `## The pens\n\n${pen.join("\n\n")}`,
    "## Ending\n\nCall the step pen once it has accepted the check-in, then stop. A step that ends without checking in is recorded as a failed step and Tom hears about it in #tts-broken.",
  ].filter((part) => part !== "").join("\n\n");
}

// ── The facts ────────────────────────────────────────────────────────────────

/** The facts block the box's sensor read for one claimed step. Held on the
 *  step row, and copied onto the check-in from there. */
export const internalRecordStepFacts = internalMutation({
  args: { stepId: v.id("runnerSteps"), facts: v.any() },
  handler: async (ctx, { stepId, facts }) => {
    const step = await ctx.db.get(stepId);
    if (!step || step.status !== "claimed") return { recorded: false };
    await ctx.db.patch(stepId, { facts });
    return { recorded: true };
  },
});

// ── The check-in ─────────────────────────────────────────────────────────────

const ASK = v.object({ tier: RUNNER_TIER, blocking: v.boolean(), text: v.string() });
const GRADED = v.object({
  verdict: v.union(v.literal("pass"), v.literal("fail")),
  complaints: v.array(v.string()),
  attempts: v.number(),
  judgeModel: v.string(),
});

const RUNNER_ASK_MAX_CHARS = 600;

// One launch or cancel a step made on the experiment, as the pen reports it.
const ACT = v.object({ verb: v.union(v.literal("launch"), v.literal("cancel")), jobId: v.string(), text: v.string() });
const RUNNER_ACTS_MAX = 10;
const RUNNER_ACT_MAX_CHARS = 300;

/**
 * THE STEP PEN'S RECORD, in one transaction: the check-in, the rewritten
 * document, one ask per question, the next step scheduled and the lease
 * released together, so a crash between posting and releasing is impossible.
 *
 * Refused, in a sentence and writing nothing: a body with no grade (the
 * grading cannot be skipped), a step that does not hold the runner's lease, a
 * decision an observe-only step may not take. The form rules run again here,
 * so a forged pass on a malformed check-in is recorded as a fail and posted
 * marked anyway.
 */
export const internalRecordStep = internalMutation({
  args: {
    runnerId: v.id("runners"),
    stepRunId: v.string(),
    decision: RUNNER_DECISION,
    checkIn: v.string(),
    document: v.string(),
    asks: v.array(ASK),
    acts: v.optional(v.array(ACT)),
    nextStepMs: v.optional(v.number()),
    graded: v.optional(GRADED),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    if (!args.graded) throw new Error("A check-in is recorded only with its grade; call it through tts-runner-step.");
    const runner = await ctx.db.get(args.runnerId);
    if (!runner) throw new Error("No such runner.");
    if (runner.endedAt !== undefined) throw new Error("This runner has ended; its steps check in no more.");
    if (runner.lease?.stepRunId !== args.stepRunId) {
      throw new Error("This step does not hold the runner's lease: it ran past its deadline and was written off, and the next step has the runner now.");
    }
    const blocking = await openBlockingAsks(ctx, runner._id);
    if (blocking.length > 0 && args.decision !== "continue" && args.decision !== "ask") {
      throw new Error("While Tom has not answered a blocking question, a step may only continue or ask.");
    }
    if (args.document.trim() === "") throw new Error("The rewritten document is empty.");
    if (args.document.length > RUNNER_DOCUMENT_MAX) throw new Error(`A runner's document is at most ${RUNNER_DOCUMENT_MAX} characters.`);
    for (const ask of args.asks) {
      if (ask.text.trim() === "" || ask.text.length > RUNNER_ASK_MAX_CHARS) throw new Error(`Each question is one to ${RUNNER_ASK_MAX_CHARS} characters.`);
    }
    if (args.decision === "ask" && args.asks.length === 0) throw new Error("A decision of ask carries at least one question.");
    const acts = args.acts ?? [];
    if (acts.length > 0 && !mayActOnCluster(runner, blocking.length)) {
      throw new Error(blocking.length > 0
        ? "While Tom has not answered a blocking question, a step changes nothing, so it records no launch or cancel."
        : "This runner's experiment is not on the cluster, so its steps record no launch or cancel there.");
    }
    if (acts.length > RUNNER_ACTS_MAX) throw new Error(`A step records at most ${RUNNER_ACTS_MAX} launches and cancels.`);
    for (const act of acts) {
      if (!/^\d+$/.test(act.jobId.trim())) throw new Error("Each launch or cancel names its job by its cluster job number.");
      if (act.text.trim() === "" || act.text.length > RUNNER_ACT_MAX_CHARS) throw new Error(`Each launch or cancel is said in one to ${RUNNER_ACT_MAX_CHARS} characters.`);
    }

    // The record's own form check. The pen ran it too; this is the door.
    const faults = checkInFailures(args.checkIn);
    const graded = faults.length > 0 && args.graded.verdict === "pass"
      ? { ...args.graded, verdict: "fail" as const, complaints: [...args.graded.complaints, ...faults.map((f) => `${f.id}: ${f.why}.`)] }
      : args.graded;

    const recent = await ctx.db
      .query("runnerSteps")
      .withIndex("by_runner_due", (q) => q.eq("runnerId", runner._id))
      .order("desc")
      .take(20);
    const step = recent.find((row) => row.stepRunId === args.stepRunId);
    const since = await sinceLastCheckIn(ctx, runner._id);
    const number = (await ctx.db
      .query("runnerEvents")
      .withIndex("by_runner_kind_at", (q) => q.eq("runnerId", runner._id).eq("kind", "check-in"))
      .collect()).length + 1;

    const checkInId = await ctx.db.insert("runnerEvents", {
      runnerId: runner._id,
      at: now,
      kind: "check-in",
      stepRunId: args.stepRunId,
      text: args.checkIn.trim(),
      decision: args.decision,
      graded,
      data: {
        number,
        facts: step?.facts ?? null,
        failures: since.failures.length,
        skipped: since.deferred,
        asks: args.asks.length,
        acts: acts.length,
      },
    });
    for (const act of acts) {
      await ctx.db.insert("runnerEvents", {
        runnerId: runner._id,
        at: now,
        kind: "act",
        stepRunId: args.stepRunId,
        text: act.text.trim(),
        data: { verb: act.verb, jobId: act.jobId.trim() },
      });
    }
    const documentVersion = runner.documentVersion + 1;
    await ctx.db.insert("runnerEvents", {
      runnerId: runner._id,
      at: now,
      kind: "document",
      stepRunId: args.stepRunId,
      text: args.document,
      data: { version: documentVersion },
    });
    const knownAwayNow = args.asks.length > 0 ? await knownAway(ctx, now) : { away: false, because: "" };
    const askIds: Id<"runnerEvents">[] = [];
    for (const ask of args.asks) {
      const answerer = answererFor(runner, ask.tier, { knownAway: knownAwayNow.away });
      askIds.push(await ctx.db.insert("runnerEvents", {
        runnerId: runner._id,
        at: now,
        kind: "ask",
        stepRunId: args.stepRunId,
        tier: ask.tier,
        blocking: ask.blocking,
        text: ask.text.trim(),
        data: { answerer: answerer.answerer, marked: answerer.marked, because: answerer.because },
      }));
    }
    if (step) await ctx.db.patch(step._id, { status: "done", finishedAt: now });

    // The schedule and the lease, together.
    const ends = args.decision === "finish" || args.decision === "hand-off";
    const stepMs = args.nextStepMs !== undefined
      ? Math.min(Math.max(Math.round(args.nextStepMs), RUNNER_STEP_MIN_MS), RUNNER_STEP_MAX_MS)
      : runner.stepMs;
    const nextStepAt = now + stepMs;
    await ctx.db.patch(runner._id, {
      document: args.document,
      documentVersion,
      lease: undefined,
      ...(ends ? { endedAt: now, endedReason: args.decision === "finish" ? "finish" as const : "hand-off" as const } : { nextStepAt }),
    });
    if (!ends) await ctx.scheduler.runAt(nextStepAt, internal.ttsRunners.internalOpenStep, { runnerId: runner._id });

    await ctx.scheduler.runAfter(0, internal.ttsSync.sendRunnerCheckIn, { checkInId });
    for (const askId of askIds) {
      await ctx.scheduler.runAfter(0, internal.ttsRunners.internalRouteAsk, { askId });
    }
    return { recorded: true, checkInId, ...(ends ? { ended: args.decision } : { nextStepAt }) };
  },
});

/** Where a recorded ask goes. Tom's opens a #tts-needs-you thread; the
 *  delegate's and the step's own are recorded and answered where they are
 *  asked (the step calls tts-ask itself), and say so on the row. */
export const internalRouteAsk = internalMutation({
  args: { askId: v.id("runnerEvents") },
  handler: async (ctx, { askId }) => {
    const ask = await ctx.db.get(askId);
    if (!ask || ask.kind !== "ask") return { routed: false };
    const answerer = (ask.data as { answerer?: RunnerAnswerer } | undefined)?.answerer;
    if (answerer !== "tom") return { routed: false, answerer };
    await ctx.scheduler.runAfter(0, internal.ttsSlack.internalOpenNeedsTomThread, {
      runner: { runnerId: ask.runnerId, askId },
      reason: ask.text ?? "",
      key: `runner-ask:${askId}`,
    });
    return { routed: true, answerer };
  },
});

/** What the check-in post reads: the composer's facts, and the thread it
 *  goes in. */
export const internalCheckInFacts = internalQuery({
  args: { checkInId: v.id("runnerEvents") },
  handler: async (ctx, { checkInId }) => {
    const event = await ctx.db.get(checkInId);
    if (!event || event.kind !== "check-in") return null;
    const runner = await ctx.db.get(event.runnerId);
    if (!runner) return null;
    const first = await ctx.db
      .query("runnerEvents")
      .withIndex("by_runner_kind_at", (q) => q.eq("runnerId", runner._id).eq("kind", "check-in"))
      .order("asc")
      .first();
    const data = (event.data ?? {}) as { number?: number; facts?: unknown; failures?: number; skipped?: number; asks?: number };
    return {
      runnerId: runner._id,
      threadTs: first && first._id !== event._id ? first.slackTs : undefined,
      isRoot: first?._id === event._id,
      facts: {
        title: runner.title,
        number: data.number ?? 1,
        decision: event.decision ?? "continue",
        facts: (data.facts ?? null) as never,
        failures: data.failures ?? 0,
        skipped: data.skipped ?? 0,
        asks: data.asks ?? 0,
        checkIn: event.text ?? "",
        graded: { verdict: event.graded?.verdict ?? "fail", complaints: event.graded?.complaints ?? [] },
        agentUrl: agentLink(event.stepRunId ?? ""),
      },
    };
  },
});

/** The post's Slack ts on its check-in event: the first one is the thread
 *  root every later check-in replies under. */
export const internalCheckInPosted = internalMutation({
  args: { checkInId: v.id("runnerEvents"), ts: v.string() },
  handler: async (ctx, { checkInId, ts }) => {
    await ctx.db.patch(checkInId, { slackTs: ts });
  },
});

// ── Tom's reply ──────────────────────────────────────────────────────────────

/**
 * A reply of Tom's in a runner's thread, in #tts-runners or #tts-needs-you. It
 * is a reply event the next step reads whole, and it answers the runner's
 * newest open question. It is not a ruling: the rulings table is for todos,
 * and his words stay his on the event.
 */
export async function recordRunnerReply(ctx: MutationCtx, runnerId: Id<"runners">, text: string, at: { channel: string; ts: string; threadTs: string }) {
  const runner = await ctx.db.get(runnerId);
  if (!runner) throw new Error("The runner this thread belongs to no longer exists.");
  const now = Date.now();
  const open = await ctx.db
    .query("runnerEvents")
    .withIndex("by_open_ask", (q) => q.eq("runnerId", runnerId).eq("kind", "ask").eq("answeredAt", undefined))
    .order("desc")
    .first();
  if (open) await ctx.db.patch(open._id, { answeredAt: now, answerText: text });
  // A reply that starts with "ceiling" is Tom's ruling on what one launch may
  // ask for, and THE ONE PLACE a runner's ceiling moves after its creation:
  // the events route admits only his Slack user. There is no door for a
  // session. Every run on the box holds the same worker key, a runner step
  // included, so a door could not tell a session acting for Tom from a step
  // raising its own ceiling, and an agent never widens its own permissions.
  // The reply event records the old and new numbers, and the next step reads
  // under his words what they did.
  const ruled = parseCeilingReply(text, ceilingOf(runner));
  let ceiling: { from: RunnerCeiling; to: RunnerCeiling } | undefined;
  if (ruled && "ceiling" in ruled) {
    ceiling = { from: ceilingOf(runner), to: ruled.ceiling };
    await ctx.db.patch(runnerId, { ceiling: ruled.ceiling });
  }
  await ctx.db.insert("runnerEvents", {
    runnerId,
    at: now,
    kind: "reply",
    text,
    slackTs: at.ts,
    data: {
      channel: at.channel,
      threadTs: at.threadTs,
      ...(open ? { answers: open._id } : {}),
      ...(ceiling ? { ceiling } : {}),
      ...(ruled && "fault" in ruled ? { ceilingRefused: ruled.fault } : {}),
    },
  });
  return { outcome: "runner-reply" as const, runnerId };
}

// ── The ceiling ──────────────────────────────────────────────────────────────

/** What a reply did to the ceiling, as the next step reads it under the reply. */
function ceilingReplyNote(data: unknown): string {
  const d = (data ?? {}) as { ceiling?: { from: RunnerCeiling; to: RunnerCeiling }; ceilingRefused?: string };
  if (d.ceiling) return `\n(This reply set the ceiling from ${runnerCeilingWords(d.ceiling.from)} to ${runnerCeilingWords(d.ceiling.to)}.)`;
  if (d.ceilingRefused) return `\n(This reply did not change the ceiling: ${d.ceilingRefused})`;
  return "";
}

// ── The page ─────────────────────────────────────────────────────────────────

/** How much of a check-in's first line the digest and the page print. */
const CHECK_IN_LINE_CHARS = 120;

/** A check-in's first line of prose: the first line that is neither blank, a
 *  heading nor a table row, cut at a word boundary with no ellipsis. Null for
 *  no check-in. The digest's runner line and the page's row both print it.
 *  A check-in is markdown written to the writing standard, which puts
 *  enumerable facts in tables and may open on a heading; neither reads as
 *  a sentence when printed alone on one line. */
function checkInFirstLine(text: string | undefined): string | null {
  if (text === undefined) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const line = lines.find((l) => !/^#{1,6}\s/.test(l) && !/^\|.*\|$/.test(l)) ?? lines[0];
  if (line === undefined) return null;
  if (line.length <= CHECK_IN_LINE_CHARS) return line;
  const cut = line.slice(0, CHECK_IN_LINE_CHARS);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:—-]+$/, "");
}

/** The newest check-in of a runner, or null. */
async function lastCheckIn(ctx: QueryCtx, runnerId: Id<"runners">) {
  return ctx.db
    .query("runnerEvents")
    .withIndex("by_runner_kind_at", (q) => q.eq("runnerId", runnerId).eq("kind", "check-in"))
    .order("desc")
    .first();
}

/** Every live runner as the morning message and the hourly update state it,
 *  the ones waiting on Tom first, then newest first. The same read the sweep
 *  makes, capped lower: this is a list for him, not a schedule. */
export async function liveRunnerFacts(ctx: QueryCtx): Promise<RunnerFact[]> {
  const live = await ctx.db
    .query("runners")
    .withIndex("by_ended", (q) => q.eq("endedAt", undefined))
    .take(20);
  const rows = await Promise.all(
    live.map(async (runner) => {
      const open = await openAsks(ctx, runner._id);
      const status = runnerStatus({ runner, openBlockingAsks: open.filter((ask) => ask.blocking === true).length });
      const checkIn = await lastCheckIn(ctx, runner._id);
      return {
        createdAt: runner.createdAt,
        fact: {
          runnerId: runner._id as string,
          title: runner.title,
          // A live runner's status is one of these two (runnerStatus).
          status: status === "waiting-on-tom" ? ("waiting-on-tom" as const) : ("running" as const),
          lastCheckIn: checkInFirstLine(checkIn?.text),
          openQuestion: open.length > 0,
        },
      };
    }),
  );
  return rows
    .sort(
      (a, b) =>
        Number(b.fact.status === "waiting-on-tom") - Number(a.fact.status === "waiting-on-tom") ||
        b.createdAt - a.createdAt,
    )
    .map((row) => row.fact);
}

/** The runner a step agent belongs to, by the id in its `runner:<id>` origin:
 *  its title and its derived status, for the agents page's agent view. Behind
 *  the same gate as the agent record it sits beside. */
export const runnerTitle = query({
  args: { runnerId: v.string() },
  handler: async (ctx, { runnerId }) => {
    await requireTom(ctx, "Agents");
    const id = ctx.db.normalizeId("runners", runnerId);
    const runner = id === null ? null : await ctx.db.get(id);
    if (!runner) return null;
    const blocking = await openBlockingAsks(ctx, runner._id);
    return { title: runner.title, status: runnerStatus({ runner, openBlockingAsks: blocking.length }) };
  },
});

/** How many runners the /tts page lists, live and ended together. */
const PAGE_RUNNERS = 50;
/** How many check-ins and asks one expanded row shows. */
const PAGE_EVENTS = 50;

/** Every runner, newest first, as the /tts page lists it. Status is
 *  runnerStatus's; the page derives none of its own. */
export const listRunners = query({
  args: {},
  handler: async (ctx) => {
    await requireTomOrAgent(ctx, "TTS");
    const runners = await ctx.db.query("runners").withIndex("by_created").order("desc").take(PAGE_RUNNERS);
    return Promise.all(
      runners.map(async (runner) => {
        const open = await openAsks(ctx, runner._id);
        const blocking = open.filter((ask) => ask.blocking === true).length;
        const checkIn = await lastCheckIn(ctx, runner._id);
        return {
          runnerId: runner._id,
          title: runner.title,
          type: runner.type,
          experimentHost: runner.experimentHost,
          stepMs: runner.stepMs,
          nextStepAt: runner.nextStepAt,
          createdAt: runner.createdAt,
          endedAt: runner.endedAt ?? null,
          status: runnerStatus({ runner, openBlockingAsks: blocking }),
          openBlockingAsks: blocking,
          lastCheckIn: checkIn === null ? null : { at: checkIn.at, line: checkInFirstLine(checkIn.text) },
          stepRunId: (await lastStepAgentId(ctx, runner._id)) ?? null,
        };
      }),
    );
  },
});

/** One runner's document, its check-ins and the questions it asked, newest
 *  first, for its expanded row on the /tts page. */
export const runnerDetail = query({
  args: { runnerId: v.id("runners") },
  handler: async (ctx, { runnerId }) => {
    await requireTomOrAgent(ctx, "TTS");
    const runner = await ctx.db.get(runnerId);
    if (!runner) return null;
    const ofKind = (kind: "check-in" | "ask") =>
      ctx.db
        .query("runnerEvents")
        .withIndex("by_runner_kind_at", (q) => q.eq("runnerId", runnerId).eq("kind", kind))
        .order("desc")
        .take(PAGE_EVENTS);
    const [checkIns, asks] = await Promise.all([ofKind("check-in"), ofKind("ask")]);
    return {
      document: runner.document,
      documentVersion: runner.documentVersion,
      checkIns: checkIns.map((event) => ({
        id: event._id,
        at: event.at,
        stepRunId: event.stepRunId ?? null,
        decision: event.decision ?? null,
        verdict: event.graded?.verdict ?? null,
        text: event.text ?? "",
      })),
      asks: asks.map((event) => ({
        id: event._id,
        at: event.at,
        stepRunId: event.stepRunId ?? null,
        tier: event.tier ?? null,
        blocking: event.blocking === true,
        answeredAt: event.answeredAt ?? null,
        answerText: event.answerText ?? null,
        text: event.text ?? "",
      })),
    };
  },
});
