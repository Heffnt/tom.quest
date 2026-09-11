import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { SLACK_SUBJECT, type SlackSubject } from "./ttsShared";
import {
  dropFaultyLines,
  fit,
  renderSlack,
  verifyDraft,
  type Draft,
  type FactsBlock,
} from "./ttsCompose";

// ── The Fable-written message (Tom, 2026-09-09, amendment 2) ─────────────────
// "Each morning message is written by a Fable agent, not filled into a
// template." The composer gathers the day's facts deterministically into a
// FACTS BLOCK (each fact with an id, its link and its numbers) and stores it
// on the digest event so the transcript shows the inputs; a Fable run on the
// box (worker/jobs/write-slack.mjs) receives the write layer, the form rules
// and that block, and writes the message.
//
// THE MODEL DOES NOT LIVE IN CONVEX. Convex has no way to run Claude and the
// box has the accounts, the WikiTom checkout and runClaude. So the 5 a.m. cron
// still owns the morning: it OPENS A REQUEST here and returns, the box picks
// the request up over the HTTP routes, submits a draft, and this file verifies
// it and hands the accepted text to the one Slack door in ttsSync.
//
// THE MORNING IS NEVER SILENT. Three guarantees, in order:
//   1. the verifier is mechanical — every link and every number in the draft
//      must exist in the facts block on a fact the line itself cites, and the
//      draft must obey the message form (ttsCompose.verifyDraft);
//   2. a rejected draft comes back with the complaint and the box retries
//      ONCE; a second rejection is final;
//   3. a request that is not accepted within SLACK_DRAFT_TIMEOUT_MS posts the
//      FALLBACK — the plain template the composer already produced — through a
//      scheduled mutation written at open time, which survives a redeploy.
// Which of the two paths ran is recorded on the digest-sent row as `writtenBy`.
//
// NO NEW TABLE (slack-design.md §7): the request is a dtsEvents row keyed by
// its requestId on by_kind_key, the same marker pattern needs-tom uses, and
// its whole life is one TTS day.
export const SLACK_DRAFT_REQUEST = "slack-draft-request";

/** Long enough for a Fable run over ~10 KB of prelude plus a retry, short
 *  enough that a box that is off does not move the morning into the day. */
export const SLACK_DRAFT_TIMEOUT_MS = 5 * 60_000;

/** One repair turn only. A second rejection leaves the timeout to send the
 *  floor rather than paying for a third run at 5 a.m. */
export const MAX_DRAFT_ATTEMPTS = 2;

/** What the digest owes its own bookkeeping row once the message lands: the
 *  day, the window the facts were read up to, the todos it surfaced, and
 *  whether the template had to be reduced. Carried on the request so whichever
 *  path posts marks the day with the SAME window (convex/ttsSync.ts sendToday).
 */
const MARKS = v.object({
  day: v.string(),
  windowEnd: v.number(),
  surfacedTodoIds: v.array(v.id("dtsTodos")),
  truncated: v.boolean(),
  objectionAskIds: v.optional(v.array(v.string())),
});

type Marks = {
  day: string;
  windowEnd: number;
  surfacedTodoIds: Id<"dtsTodos">[];
  truncated: boolean;
  objectionAskIds?: string[];
};

type DraftRow = {
  requestId: string;
  kind: "today" | "needs-you";
  subject: SlackSubject;
  channel?: string;
  threadTs?: string;
  facts: FactsBlock;
  canReply: boolean;
  fallback: string;
  marks?: Marks;
  openedAt: number;
  timeoutAt: number;
  attempts?: number;
  complaints?: string[];
  mode?: "fable" | "template";
  text?: string;
  // The token of the run that wrote `text`. Absent on the template path and on
  // every draft settled before runs carried one, and absent is the value: a
  // reaction on such a morning writes no label rather than a guessed edge.
  runToken?: string;
  settledAt?: number;
  deliveryClaimedAt?: number;
  deliveredAt?: number;
  deliveryError?: string;
};

function dataOf(row: { data?: unknown }): DraftRow | null {
  const data = row.data as Partial<DraftRow> | undefined;
  if (
    !data ||
    typeof data.requestId !== "string" ||
    (data.kind !== "today" && data.kind !== "needs-you") ||
    typeof data.fallback !== "string" ||
    typeof data.timeoutAt !== "number"
  ) {
    return null;
  }
  return data as DraftRow;
}

async function requestRow(ctx: MutationCtx, requestId: string) {
  return await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", SLACK_DRAFT_REQUEST).eq("key", requestId))
    .first();
}

/** Open the request and arm its timeout. Idempotent on the requestId — two
 *  concurrent opens conflict on the key in Convex and the loser reads the
 *  winner's row, the marker pattern this file borrows from needs-tom. */
export const internalOpenSlackDraft = internalMutation({
  args: {
    requestId: v.string(),
    kind: v.union(v.literal("today"), v.literal("needs-you")),
    subject: SLACK_SUBJECT,
    channel: v.optional(v.string()),
    threadTs: v.optional(v.string()),
    facts: v.any(),
    canReply: v.boolean(),
    fallback: v.string(),
    marks: v.optional(MARKS),
  },
  handler: async (ctx, args): Promise<{ opened: boolean; requestId: string }> => {
    if (args.requestId.trim() === "") throw new Error("requestId is required");
    if (args.fallback.trim() === "") throw new Error("a draft request needs its fallback text");
    const existing = await requestRow(ctx, args.requestId);
    if (existing) return { opened: false, requestId: args.requestId };
    const now = Date.now();
    await ctx.db.insert("dtsEvents", {
      at: now,
      kind: SLACK_DRAFT_REQUEST,
      key: args.requestId,
      data: { ...args, openedAt: now, timeoutAt: now + SLACK_DRAFT_TIMEOUT_MS, attempts: 0, complaints: [] },
    });
    // The timeout is durable and deterministic. It is a FALLBACK only: an
    // accepted draft settles the row first and makes this a quiet no-op.
    await ctx.scheduler.runAfter(
      SLACK_DRAFT_TIMEOUT_MS,
      internal.ttsSlackDrafts.internalFallbackSlackDraft,
      {
        requestId: args.requestId,
        reason: `no accepted draft within ${Math.round(SLACK_DRAFT_TIMEOUT_MS / 60_000)} minutes`,
      },
    );
    return { opened: true, requestId: args.requestId };
  },
});

/** The box asks what it should write. Returns null when there is nothing open
 *  — a settled request, an unknown one, or one that has spent its attempts. */
export const internalOpenDraftRequests = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", SLACK_DRAFT_REQUEST))
      .order("desc")
      .take(limit ?? 10);
    const open = [];
    for (const row of rows) {
      const data = dataOf(row);
      if (!data || data.mode !== undefined) continue;
      if ((data.attempts ?? 0) >= MAX_DRAFT_ATTEMPTS) continue;
      open.push({
        requestId: data.requestId,
        kind: data.kind,
        facts: data.facts,
        canReply: data.canReply,
        attempts: data.attempts ?? 0,
        complaints: data.complaints ?? [],
        timeoutAt: data.timeoutAt,
      });
    }
    return open;
  },
});

/** The box hands back a draft. Verified here, not on the box: the verifier is
 *  the same pure function either side would run, and running it in the
 *  transaction that settles the row is what stops a rejected draft racing the
 *  timeout. */
export const internalSubmitSlackDraft = internalMutation({
  args: {
    requestId: v.string(),
    draft: v.any(),
    // The token of the run that wrote this draft, from the writer's own
    // receipt. It is the edge a reaction on the morning follows back.
    runToken: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { requestId, draft, runToken },
  ): Promise<
    { accepted: true } | { accepted: false; final: boolean; complaints: string[] }
  > => {
    const row = await requestRow(ctx, requestId);
    if (!row) throw new Error(`Unknown Slack draft request: ${requestId}`);
    const data = dataOf(row);
    if (!data) throw new Error(`Malformed Slack draft request: ${requestId}`);
    if (data.mode !== undefined) {
      return { accepted: false, final: true, complaints: ["the request is already settled"] };
    }
    const attempts = (data.attempts ?? 0) + 1;
    const faults = verifyDraft(draft as Draft, data.facts);
    if (faults.length > 0) {
      await ctx.db.patch(row._id, {
        data: { ...data, attempts, complaints: [...(data.complaints ?? []), ...faults] },
      });
      return { accepted: false, final: attempts >= MAX_DRAFT_ATTEMPTS, complaints: faults };
    }
    const { message } = dropFaultyLines(
      {
        firstLine: (draft as Draft).firstLine,
        lines: (draft as Draft).lines.map((line) =>
          line.role === "item"
            ? { role: "item" as const, text: line.text, url: line.url }
            : { role: line.role, text: line.text },
        ),
      },
      { canReply: data.canReply },
    );
    await settle(ctx, row._id, data, "fable", renderSlack(fit(message).message), attempts, runToken);
    return { accepted: true };
  },
});

/** The floor. Called by the scheduled timeout, and by any caller that decides
 *  the writer is not coming. A settled request ignores it. */
export const internalFallbackSlackDraft = internalMutation({
  args: { requestId: v.string(), reason: v.string() },
  handler: async (ctx, { requestId, reason }) => {
    const row = await requestRow(ctx, requestId);
    if (!row) return { fellBack: false, reason: "unknown request" };
    const data = dataOf(row);
    if (!data) return { fellBack: false, reason: "malformed request" };
    if (data.mode !== undefined) return { fellBack: false, reason: data.mode };
    await settle(
      ctx,
      row._id,
      { ...data, complaints: [...(data.complaints ?? []), reason] },
      "template",
      data.fallback,
      data.attempts ?? 0,
    );
    return { fellBack: true };
  },
});

async function settle(
  ctx: MutationCtx,
  id: Parameters<MutationCtx["db"]["patch"]>[0],
  data: DraftRow,
  mode: "fable" | "template",
  text: string,
  attempts: number,
  // The registration token of the run that WROTE this text, carried from the
  // writer's own submission. It travels to the "digest-sent" row and is the
  // edge an emoji on the morning follows back to the run that earned it
  // (convex/runLabels.ts).
  //
  // THE TEMPLATE PATH PASSES NONE, and that is the fact rather than a gap: the
  // plain template is not a run's output, so a reaction on a template morning
  // writes no label instead of scoring a model for words no model wrote.
  runToken?: string,
): Promise<void> {
  await ctx.db.patch(id, {
    data: { ...data, mode, text, attempts, settledAt: Date.now(), ...(runToken === undefined ? {} : { runToken }) },
  });
  await ctx.scheduler.runAfter(0, internal.ttsSync.sendSlackDraft, {
    requestId: data.requestId,
  });
}

/** A delivery claim prevents an accepted draft and its timeout from posting two
 *  messages when Convex replays scheduled work. The action owns the network
 *  call; this mutation owns the serializable state transition before it. */
export const internalTakeSlackDraftDelivery = internalMutation({
  args: { requestId: v.string() },
  handler: async (ctx, { requestId }) => {
    const row = await requestRow(ctx, requestId);
    if (!row) return null;
    const data = dataOf(row);
    if (!data || data.mode === undefined || typeof data.text !== "string") return null;
    if (data.deliveredAt !== undefined || data.deliveryClaimedAt !== undefined) return null;
    await ctx.db.patch(row._id, { data: { ...data, deliveryClaimedAt: Date.now() } });
    return {
      text: data.text,
      subject: data.subject,
      channel: data.channel,
      threadTs: data.threadTs,
      mode: data.mode,
      kind: data.kind,
      facts: data.facts,
      marks: data.marks ?? null,
      // Absent on a template morning and on every draft written before runs
      // carried a token. Absent is a value: the sender writes no token rather
      // than inventing one, and a reaction on that morning writes no label.
      runToken: data.runToken ?? null,
    };
  },
});

export const internalFinishSlackDraftDelivery = internalMutation({
  args: { requestId: v.string(), error: v.optional(v.string()) },
  handler: async (ctx, { requestId, error }) => {
    const row = await requestRow(ctx, requestId);
    if (!row) return;
    const data = dataOf(row);
    if (!data) return;
    await ctx.db.patch(row._id, {
      data:
        error === undefined
          ? { ...data, deliveredAt: Date.now() }
          : { ...data, deliveryClaimedAt: undefined, deliveryError: error },
    });
  },
});
