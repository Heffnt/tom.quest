// ── A MESSAGE IN TOM'S NAME NEEDS HIS SIGN-OFF ROW ──────────────────────────
// Tom, 2026-09-25: agents "can also send messages in my name after i have
// reviewed the content and explicitily signed off." This module is the wall
// that sentence needs (the guarantee "only Tom speaks for Tom"; the invariant
// "message a human as him without a sign-off row on that exact text: never").
//
// THREE STEPS, THREE WRITERS, and only the middle one is his:
//   1. PROPOSE. An agent posts the exact text, the recipient and the channel
//      through POST /tts/send-proposal (the worker key). That writes one
//      dtsEvents row of kind "send-proposal" and opens one needs-you reply
//      under the digest naming the recipient and the channel, never the text. No
//      sign-off, no send.
//   2. SIGN. Tom reads the verbatim text on /tts and presses "sign and send".
//      That is signAndSend, a requireTom mutation, and it is the ONLY function
//      in this repository that inserts into `signoffs`. No HTTP route reaches
//      it; the worker key cannot write a sign-off (convex/ttsSignoff.test.ts
//      holds the repository to that by source scan as well as by call).
//   3. SEND. deliverAsTom, below, is the one gate every send to a human other
//      than Tom passes: it claims a sign-off whose sha256(text), recipient and
//      channel all match what is about to go out, and refuses when none does.
//      The Slack send (internalSendProposal → the one Slack door) and the
//      calendar door with guests (convex/ttsCalendarWrite.ts) both go through
//      it. A claim stamps the row's `usedAt`, so one signature is one send.
//
// WHY NEITHER THE PROPOSAL ROUTE NOR THE CHECK CAN BE A DELETION. Deleting the
// route leaves an agent no way to put the exact text in front of Tom, so the
// only paths left to another human are ones he never reads. Deleting the check
// leaves the sign-off a record of what he approved rather than a condition on
// what goes out, and a send of any other text would still go. Together they are
// the wall; either alone is not.
//
// WHAT THE RECORD SHOWS. A delivered send is one dtsEvents row of kind
// "sent-as-tom" { recipient, channel, sha256, signedAt }: /observe lists it
// with the rulings and the morning message lists it with the decisions. A
// refused or failed send is a "send-as-tom-failed" row, which is a line in the
// digest's broken section (convex/ttsDigest.ts).

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireTom } from "./authRoles";
import { logEvent } from "./tts";
import { NEEDS_TOM, nyCalendarDayKey, nyHhmm } from "./ttsShared";
import { listForDigest, openNeedsYou } from "./jarvis/outbox";
import { composeProposalAsk, renderSlack } from "./ttsCompose";

/** The label the gates name: the sign-off control lives on the TTS page. */
const SURFACE = "TTS";

/** An agent's proposed message, waiting for Tom (dtsEvents kind). */
export const SEND_PROPOSAL = "send-proposal";
/** A message that went out in Tom's name on his sign-off (dtsEvents kind). */
export const SENT_AS_TOM = "sent-as-tom";
/** A send that was refused (no matching sign-off) or failed on delivery. The
 *  "-failed" suffix is what makes it a line in the digest's broken section. */
export const SEND_AS_TOM_FAILED = "send-as-tom-failed";
/** A send whose outcome is unknown (a dropped answer, a 5xx, a network error):
 *  it may have gone out. Its sign-off stays spent, nothing retries it, and it
 *  is a broken line in the digest for Tom to check. Not a "-failed" kind: the
 *  digest line is its own, written with it (internalRecordUnknown). */
export const SEND_AS_TOM_UNKNOWN = "send-as-tom-unknown";
/** The mark an unknown delivery's error carries across an action boundary,
 *  where an error's class does not survive. */
const OUTCOME_UNKNOWN = "outcome unknown";

/** The channel of a calendar event with guests: the calendar door. */
export const CALENDAR_CHANNEL = "calendar";
/** A Slack conversation: a channel (C…, G…), a direct message (D…) or a
 *  user (U…, W…), whom the workspace bot messages directly. */
const SLACK_CHANNEL = /^slack:([CDGUW][A-Z0-9]{4,})$/;

/** The words a refusal carries, so the calendar route can answer 403 for it
 *  rather than the 400 a malformed event gets. */
export const NO_SIGNOFF = "no sign-off of Tom's matches this text, recipient and channel";

const TEXT_MAX = 4000;
const RECIPIENT_MAX = 200;
const WHY_MAX = 500;
const GUESTS_MAX = 20;
/** The proposals the page reads, newest first. Tens a week at most. */
const PROPOSALS_READ = 200;

type CalendarInvite = {
  title: string;
  start: number;
  end: number;
  description?: string;
  location?: string;
  recurrence?: string[];
  guests: string[];
};

const CALENDAR_INVITE = v.object({
  title: v.string(),
  start: v.number(),
  end: v.number(),
  description: v.optional(v.string()),
  location: v.optional(v.string()),
  recurrence: v.optional(v.array(v.string())),
  guests: v.array(v.string()),
});

// Kept: "sending" refuses a second press before the scheduled send finishes, which would otherwise schedule a second send that the spent sign-off refuses and records as a failure.
// "sending": his press queued the send, no sign-off claimed yet.
// "delivering": the sign-off was claimed (in the same mutation) and the
// delivery is under way; a send found here stopped mid-delivery, so its
// outcome is unknown, never failed.
// "unknown": the send may have gone out; it is never signed again, only declined.
type ProposalStatus = "proposed" | "sending" | "delivering" | "sent" | "failed" | "unknown" | "declined";

/** What a "send-proposal" row's `data` holds. */
type ProposalData = {
  text: string;
  sha256: string;
  recipient: string;
  channel: string;
  agentId?: string;
  why?: string;
  event?: CalendarInvite;
  status: ProposalStatus;
  signedAt?: number;
  sentAt?: number;
  error?: string;
  /** The sign-off a delivery claimed, set with "delivering". */
  signoffId?: Id<"signoffs">;
};

/** sha256 of the text's UTF-8 bytes, lower-case hex. Exact bytes: nothing is
 *  trimmed or normalised, so a changed space is a different message. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Which door a channel names, or null for one this module does not send on. */
function parseChannel(
  channel: string,
): { via: "slack"; conversation: string } | { via: "calendar" } | null {
  if (channel === CALENDAR_CHANNEL) return { via: "calendar" };
  const slack = SLACK_CHANNEL.exec(channel);
  return slack === null ? null : { via: "slack", conversation: slack[1] };
}

/** A calendar event's recipient: its guests, lower-cased, deduplicated and
 *  sorted, so the same people in another order are the same recipient. */
export function calendarRecipient(guests: string[]): string {
  return [...new Set(guests.map((g) => g.trim().toLowerCase()).filter((g) => g !== ""))]
    .sort()
    .join(", ");
}

/** THE TEXT OF AN INVITATION, which is what Tom signs for a calendar event:
 *  every field a guest receives, in one fixed order. The door recomputes it
 *  from the event it is about to create, so an event that differs from the
 *  signed one in any of these fields matches no sign-off. */
export function invitationText(e: CalendarInvite): string {
  const startDay = nyCalendarDayKey(e.start);
  const endDay = nyCalendarDayKey(e.end);
  const until = endDay === startDay ? nyHhmm(e.end) : `${endDay} ${nyHhmm(e.end)}`;
  const lines = [
    `Title: ${e.title.trim()}`,
    `When: ${startDay} ${nyHhmm(e.start)} to ${until}, New York time`,
  ];
  if (e.location !== undefined && e.location !== "") lines.push(`Where: ${e.location}`);
  if (e.recurrence !== undefined && e.recurrence.length > 0) {
    lines.push(`Repeats: ${e.recurrence.join("; ")}`);
  }
  lines.push(`Guests: ${calendarRecipient(e.guests)}`);
  if (e.description !== undefined && e.description !== "") lines.push("", e.description);
  return lines.join("\n");
}

/** A proposal as the route accepts it, before it has a row. */
type ProposalInput = {
  text: string;
  recipient: string;
  channel: string;
  why?: string;
  event?: CalendarInvite;
};

const EMAIL = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;

/**
 * The body of POST /tts/send-proposal, checked. Two shapes:
 *   Slack:    { channel: "slack:<conversation id>", recipient, text, why? }
 *   calendar: { channel: "calendar", event: { title, start, end, guests,
 *               description?, location?, recurrence? }, why? }
 * A calendar proposal carries no `text` or `recipient`: both are derived from
 * the event (invitationText, calendarRecipient), because the door derives them
 * the same way when it checks, and a second spelling could only disagree.
 */
export function parseProposal(b: Record<string, unknown>): { proposal: ProposalInput } | { error: string } {
  if (typeof b.channel !== "string") return { error: "channel (string) required" };
  const door = parseChannel(b.channel);
  if (door === null) {
    return { error: `channel must be "calendar" or "slack:<conversation id>", not ${JSON.stringify(b.channel).slice(0, 80)}` };
  }
  let why: string | undefined;
  if (b.why !== undefined) {
    if (typeof b.why !== "string" || b.why.length > WHY_MAX) {
      return { error: `why, when given, is a string of at most ${WHY_MAX} characters` };
    }
    why = b.why.trim() === "" ? undefined : b.why.trim();
  }
  if (door.via === "slack") {
    if (b.event !== undefined) return { error: "event is for a calendar proposal; a Slack one sends text" };
    if (typeof b.text !== "string" || b.text.trim() === "") return { error: "text (non-empty string) required" };
    if (b.text.length > TEXT_MAX) return { error: `text is at most ${TEXT_MAX} characters` };
    if (typeof b.recipient !== "string" || b.recipient.trim() === "") {
      return { error: "recipient (non-empty string) required: the person the message is addressed to" };
    }
    if (b.recipient.length > RECIPIENT_MAX) return { error: `recipient is at most ${RECIPIENT_MAX} characters` };
    return {
      proposal: {
        text: b.text,
        recipient: b.recipient.trim(),
        channel: b.channel,
        ...(why === undefined ? {} : { why }),
      },
    };
  }
  if (b.text !== undefined || b.recipient !== undefined) {
    return { error: "a calendar proposal sends event only; its text and recipient are derived from the event" };
  }
  const e = (b.event ?? null) as Record<string, unknown> | null;
  if (e === null || typeof e !== "object") return { error: "event (object) required for a calendar proposal" };
  if (typeof e.title !== "string" || e.title.trim() === "") return { error: "event.title (non-empty string) required" };
  if (typeof e.start !== "number" || typeof e.end !== "number" || !(e.end > e.start)) {
    return { error: "event.start and event.end (epoch ms, end after start) required" };
  }
  if (!Array.isArray(e.guests) || e.guests.length === 0 || e.guests.length > GUESTS_MAX) {
    return { error: `event.guests (1 to ${GUESTS_MAX} email addresses) required: an event with no guests needs no sign-off` };
  }
  if (!e.guests.every((g) => typeof g === "string" && EMAIL.test(g.trim()))) {
    return { error: "every event.guests entry is an email address" };
  }
  for (const name of ["description", "location"] as const) {
    if (e[name] !== undefined && typeof e[name] !== "string") return { error: `event.${name}, when given, is a string` };
  }
  if (e.recurrence !== undefined && !(Array.isArray(e.recurrence) && e.recurrence.every((r) => typeof r === "string"))) {
    return { error: "event.recurrence, when given, is an array of strings" };
  }
  const event: CalendarInvite = {
    title: e.title,
    start: e.start,
    end: e.end,
    guests: (e.guests as string[]).map((g) => g.trim()),
    ...(e.description === undefined ? {} : { description: e.description as string }),
    ...(e.location === undefined ? {} : { location: e.location as string }),
    ...(e.recurrence === undefined ? {} : { recurrence: e.recurrence as string[] }),
  };
  const text = invitationText(event);
  if (text.length > TEXT_MAX) return { error: `the invitation is at most ${TEXT_MAX} characters` };
  return {
    proposal: {
      text,
      recipient: calendarRecipient(event.guests),
      channel: CALENDAR_CHANNEL,
      ...(why === undefined ? {} : { why }),
      event,
    },
  };
}

function proposalOf(row: Doc<"dtsEvents"> | null): ProposalData | null {
  if (row === null || row.kind !== SEND_PROPOSAL) return null;
  return row.data as ProposalData;
}

// ── 1. Propose (the worker key, through POST /tts/send-proposal) ────────────

/**
 * One needs-you reply per proposal, under the day's digest in the one output
 * channel (convex/jarvis/digest.ts), so a proposal does not wait unseen until
 * he next opens /tts. It names the recipient and the channel and links to
 * where he signs; it never carries the text (composeProposalAsk). The
 * proposal is new, so its id is a key no earlier reply holds. Its subject is
 * the job "send-proposal": his reply to it is a note on the record and signs
 * nothing.
 */
async function openProposalNeedsYou(
  ctx: MutationCtx,
  proposalId: Id<"dtsEvents">,
  target: { recipient: string; channel: string },
): Promise<void> {
  const key = `${SEND_PROPOSAL}:${proposalId}`;
  await logEvent(ctx, NEEDS_TOM, undefined, { key, proposalId, recipient: target.recipient, channel: target.channel }, key);
  await openNeedsYou(ctx, { key, job: SEND_PROPOSAL, text: renderSlack(composeProposalAsk(target)) });
}

export const internalPropose = internalMutation({
  args: {
    text: v.string(),
    recipient: v.string(),
    channel: v.string(),
    agentId: v.optional(v.string()),
    why: v.optional(v.string()),
    event: v.optional(CALENDAR_INVITE),
  },
  handler: async (ctx, args): Promise<{ proposalId: Id<"dtsEvents">; sha256: string }> => {
    if (parseChannel(args.channel) === null) throw new Error(`not a channel a message can be sent on: ${args.channel}`);
    const sha256 = await sha256Hex(args.text);
    const data: ProposalData = { ...args, sha256, status: "proposed" };
    const proposalId = await logEvent(ctx, SEND_PROPOSAL, undefined, data);
    await openProposalNeedsYou(ctx, proposalId, { recipient: args.recipient, channel: args.channel });
    return { proposalId, sha256 };
  },
});

// ── 2. Sign (Tom only) ──────────────────────────────────────────────────────

/** The proposals waiting on him, and the ones on their way or refused, newest
 *  first. A sent one leaves this list for /observe; a declined one leaves it. */
export const listProposals = query({
  args: {},
  handler: async (ctx) => {
    await requireTom(ctx, SURFACE);
    const rows = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", SEND_PROPOSAL))
      .order("desc")
      .take(PROPOSALS_READ);
    return rows.flatMap((row) => {
      const p = proposalOf(row);
      if (p === null || p.status === "sent" || p.status === "declined") return [];
      return [{
        id: row._id,
        at: row.at,
        text: p.text,
        recipient: p.recipient,
        channel: p.channel,
        agentId: p.agentId ?? null,
        why: p.why ?? null,
        status: p.status,
        error: p.error ?? null,
      }];
    });
  },
});

/**
 * THE ONE WRITER OF `signoffs`. Tom's press of "sign and send" beside the
 * verbatim text: it records his sign-off on exactly that text, recipient and
 * channel, and schedules the send, which checks for this row and takes it.
 * The hash is computed here from the stored text, never taken from the
 * proposal, so a row whose hash was written wrong signs what he read.
 *
 * A second press after a failed delivery reuses the sign-off the failure
 * released rather than writing another, so one proposal is at most one
 * unused signature.
 */
export const signAndSend = mutation({
  args: { proposalId: v.id("dtsEvents") },
  handler: async (ctx, { proposalId }) => {
    await requireTom(ctx, SURFACE);
    const row = await ctx.db.get(proposalId);
    const p = proposalOf(row);
    if (row === null || p === null) throw new Error("no such proposal");
    if (p.status !== "proposed" && p.status !== "failed") {
      return { signed: false as const, status: p.status };
    }
    const sha256 = await sha256Hex(p.text);
    const unused = (
      await ctx.db
        .query("signoffs")
        .withIndex("by_match", (q) =>
          q.eq("sha256", sha256).eq("recipient", p.recipient).eq("channel", p.channel),
        )
        .collect()
    ).find((s) => s.usedAt === undefined);
    const signedAt = Date.now();
    if (unused === undefined) {
      await ctx.db.insert("signoffs", {
        text: p.text,
        sha256,
        recipient: p.recipient,
        channel: p.channel,
        signedAt,
        signedBy: "tom",
      });
    }
    const next: ProposalData = { ...p, status: "sending", signedAt: unused?.signedAt ?? signedAt };
    delete next.error;
    await ctx.db.patch(proposalId, { data: next });
    await ctx.scheduler.runAfter(0, internal.ttsSignoff.internalSendProposal, { proposalId });
    return { signed: true as const, status: "sending" as const };
  },
});

/** Tom's "decline": the proposal leaves his list and nothing is sent. */
export const decline = mutation({
  args: { proposalId: v.id("dtsEvents") },
  handler: async (ctx, { proposalId }) => {
    await requireTom(ctx, SURFACE);
    const row = await ctx.db.get(proposalId);
    const p = proposalOf(row);
    if (row === null || p === null) throw new Error("no such proposal");
    if (p.status !== "proposed" && p.status !== "failed" && p.status !== "unknown") {
      return { declined: false as const, status: p.status };
    }
    await ctx.db.patch(proposalId, { data: { ...p, status: "declined" } });
    return { declined: true as const, status: "declined" as const };
  },
});

// ── 3. Send (the one gate) ──────────────────────────────────────────────────

export const internalProposal = internalQuery({
  args: { proposalId: v.id("dtsEvents") },
  handler: async (ctx, { proposalId }) => proposalOf(await ctx.db.get(proposalId)),
});

/** Take the sign-off that matches, or say there is none. Atomic: two sends of
 *  one signed text race for one row and one of them is refused. */
export const internalClaimSignoff = internalMutation({
  args: {
    text: v.string(),
    recipient: v.string(),
    channel: v.string(),
    // The proposal the claim delivers: marked "delivering" in this same
    // mutation, so no moment exists where the sign-off is spent and the
    // proposal still reads as merely queued.
    proposalId: v.optional(v.id("dtsEvents")),
  },
  handler: async (
    ctx,
    { text, recipient, channel, proposalId },
  ): Promise<
    | { ok: true; signoffId: Id<"signoffs">; sha256: string; signedAt: number }
    | { ok: false; sha256: string }
  > => {
    const sha256 = await sha256Hex(text);
    // Kept, not deletable: this match on sha256(text) + recipient + channel is
    // what makes his sign-off a condition on what goes out (I5) rather than a
    // note of what he approved; the text compare is the hash's own backstop.
    const match = (
      await ctx.db
        .query("signoffs")
        .withIndex("by_match", (q) =>
          q.eq("sha256", sha256).eq("recipient", recipient).eq("channel", channel),
        )
        .collect()
    ).find((s) => s.usedAt === undefined && s.signedBy === "tom" && s.text === text);
    if (match === undefined) return { ok: false, sha256 };
    await ctx.db.patch(match._id, { usedAt: Date.now() });
    if (proposalId !== undefined) {
      const p = proposalOf(await ctx.db.get(proposalId));
      if (p !== null) await ctx.db.patch(proposalId, { data: { ...p, status: "delivering", signoffId: match._id } });
    }
    return { ok: true, signoffId: match._id, sha256, signedAt: match.signedAt };
  },
});

/** A delivery that failed after its claim gives the signature back, so his
 *  press is not spent on a message nobody received. */
export const internalReleaseSignoff = internalMutation({
  args: { signoffId: v.id("signoffs") },
  handler: async (ctx, { signoffId }) => {
    await ctx.db.patch(signoffId, { usedAt: undefined });
  },
});

export const internalRecordSent = internalMutation({
  args: { recipient: v.string(), channel: v.string(), sha256: v.string(), signedAt: v.number() },
  handler: async (ctx, args) => {
    await logEvent(ctx, SENT_AS_TOM, undefined, args);
  },
});

export const internalRecordUnknown = internalMutation({
  args: {
    signoffId: v.id("signoffs"),
    recipient: v.string(),
    channel: v.string(),
    sha256: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    await logEvent(ctx, SEND_AS_TOM_UNKNOWN, undefined, { job: "send-as-tom", ...args });
    // Keyed by the sign-off: each unknown send is its own line, whatever
    // text it shares with another (the digest lists a key once a day).
    await listForDigest(ctx, {
      section: "broken",
      job: `send-as-tom:${args.signoffId}`,
      statement: `A message in your name to ${args.recipient} may or may not have gone out: the send's answer was lost. Check the conversation before sending it again.`,
    });
  },
});

export const internalRecordFailed = internalMutation({
  args: { recipient: v.string(), channel: v.string(), sha256: v.string(), error: v.string() },
  handler: async (ctx, args) => {
    await logEvent(ctx, SEND_AS_TOM_FAILED, undefined, { job: "send-as-tom", ...args });
  },
});

/** A delivery the far side definitely did not take: nothing went out, so the
 *  sign-off's claim may be released for another attempt. Any other throw from
 *  a delivery may have followed a send (a dropped answer, a failed write after
 *  the post), and keeps the claim, so the same signed text cannot go twice. */
export class DeliveryRefused extends Error {}

/**
 * THE GATE. Every send to a human other than Tom runs its delivery inside
 * this: a sign-off that matches sha256(text) + recipient + channel is claimed
 * first, the delivery runs only if one was, and the outcome is recorded —
 * "sent-as-tom" when it went, "send-as-tom-failed" when it was refused
 * (DeliveryRefused, which alone releases the claim), "send-as-tom-unknown"
 * for any other throw: it may have gone out, so the claim stays spent, the
 * error thrown on carries OUTCOME_UNKNOWN, and Tom is told in the digest.
 */
export async function deliverAsTom<T>(
  ctx: ActionCtx,
  target: { text: string; recipient: string; channel: string; proposalId?: Id<"dtsEvents"> },
  deliver: () => Promise<T>,
): Promise<T> {
  const claim = await ctx.runMutation(internal.ttsSignoff.internalClaimSignoff, {
    text: target.text,
    recipient: target.recipient,
    channel: target.channel,
    proposalId: target.proposalId,
  });
  // Kept, not deletable: this refusal is the wall for I5. Without it a text he
  // never signed goes out in his name, and the record is the only trace.
  if (!claim.ok) {
    await ctx.runMutation(internal.ttsSignoff.internalRecordFailed, {
      recipient: target.recipient,
      channel: target.channel,
      sha256: claim.sha256,
      error: `refused: ${NO_SIGNOFF}`,
    });
    throw new Error(`refused: ${NO_SIGNOFF}`);
  }
  let delivered: T;
  try {
    delivered = await deliver();
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const outcome = { recipient: target.recipient, channel: target.channel, sha256: claim.sha256, error };
    if (e instanceof DeliveryRefused) {
      await ctx.runMutation(internal.ttsSignoff.internalReleaseSignoff, { signoffId: claim.signoffId });
      await ctx.runMutation(internal.ttsSignoff.internalRecordFailed, outcome);
      throw e;
    }
    await recordUnknown(ctx, { ...outcome, signoffId: claim.signoffId });
    throw new Error(`${OUTCOME_UNKNOWN}: ${error}`);
  }
  // THE SEND RETURNED. Recording it is not the send: a throw here leaves the
  // message out and its claim spent, so the outcome is unknown, never failed.
  try {
    await ctx.runMutation(internal.ttsSignoff.internalRecordSent, {
      recipient: target.recipient,
      channel: target.channel,
      sha256: claim.sha256,
      signedAt: claim.signedAt,
    });
  } catch (e) {
    const error = `it went out, but its record failed: ${e instanceof Error ? e.message : String(e)}`;
    await recordUnknown(ctx, { recipient: target.recipient, channel: target.channel, sha256: claim.sha256, error, signoffId: claim.signoffId });
    throw new Error(`${OUTCOME_UNKNOWN}: ${error}`);
  }
  return delivered;
}

/** Record an unknown outcome and its digest line. A throw while recording it
 *  changes nothing about the outcome: the caller still throws OUTCOME_UNKNOWN,
 *  so the proposal is marked unknown and its sign-off stays spent. */
async function recordUnknown(
  ctx: ActionCtx,
  args: { signoffId: Id<"signoffs">; recipient: string; channel: string; sha256: string; error: string },
): Promise<void> {
  try {
    await ctx.runMutation(internal.ttsSignoff.internalRecordUnknown, args);
  } catch (e) {
    console.error(`send-as-tom: the unknown outcome for ${args.recipient} was not recorded: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export const internalFinishProposal = internalMutation({
  args: {
    proposalId: v.id("dtsEvents"),
    outcome: v.union(v.literal("sent"), v.literal("failed"), v.literal("unknown")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { proposalId, outcome, error }) => {
    const row = await ctx.db.get(proposalId);
    const p = proposalOf(row);
    if (p === null) return;
    const next: ProposalData =
      outcome === "sent"
        ? { ...p, status: "sent", sentAt: Date.now() }
        : { ...p, status: outcome, error: error ?? "the send failed" };
    await ctx.db.patch(proposalId, { data: next });
  },
});

/**
 * Send one proposal, scheduled by signAndSend. It is not trusted to have been
 * scheduled by him: whoever runs it, the send goes through deliverAsTom, and
 * a proposal nobody signed is refused there.
 */
export const internalSendProposal = internalAction({
  args: { proposalId: v.id("dtsEvents") },
  handler: async (ctx, { proposalId }): Promise<{ sent: boolean; error?: string }> => {
    const p = await ctx.runQuery(internal.ttsSignoff.internalProposal, { proposalId });
    if (p === null) return { sent: false, error: "no such proposal" };
    // ONLY A NEVER-SENT PROPOSAL IS SENT: "sending" (his press scheduled
    // this) or "proposed" (refused at the gate below without his sign-off).
    // A rerun on anything else — sent, unknown, failed, declined — changes
    // nothing: rewriting an unknown one to failed would let a fresh sign-off
    // resend a message that may have gone out. Only his clear moves it on.
    // A SEND FOUND DELIVERING stopped after its sign-off was claimed and
    // before its outcome was written: it may have gone out. Unknown, surfaced,
    // its sign-off left spent.
    if (p.status === "delivering") {
      const error = "the send stopped after its sign-off was claimed, before its outcome was written";
      if (p.signoffId !== undefined) {
        await recordUnknown(ctx, { signoffId: p.signoffId, recipient: p.recipient, channel: p.channel, sha256: p.sha256, error });
      }
      await ctx.runMutation(internal.ttsSignoff.internalFinishProposal, { proposalId, outcome: "unknown", error });
      return { sent: false, error: `${OUTCOME_UNKNOWN}: ${error}` };
    }
    if (p.status !== "sending" && p.status !== "proposed") {
      return { sent: false, error: `not sendable: the proposal is ${p.status}` };
    }
    const door = parseChannel(p.channel);
    try {
      if (door === null) throw new Error(`not a channel a message can be sent on: ${p.channel}`);
      if (door.via === "slack") {
        await deliverAsTom(ctx, { ...p, proposalId }, async () => {
          const posted = await ctx.runAction(internal.ttsSync.sendSlack, {
            text: p.text,
            channel: door.conversation,
            subject: { kind: "job", id: SENT_AS_TOM },
            once: true,
          });
          if (!posted.ok && posted.refused) throw new DeliveryRefused(`Slack refused the message: ${posted.error}`);
          if (!posted.ok) throw new Error(`the Slack post's outcome is unknown: ${posted.error}`);
          return posted;
        });
      } else {
        if (p.event === undefined) throw new Error("a calendar proposal without its event");
        // The calendar door checks the sign-off itself, from the event it is
        // about to create; the text it derives is this proposal's text.
        await ctx.runAction(internal.ttsCalendarWrite.internalCreateEvent, { ...p.event, proposalId });
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const outcome = error.includes(OUTCOME_UNKNOWN) ? "unknown" : "failed";
      await ctx.runMutation(internal.ttsSignoff.internalFinishProposal, { proposalId, outcome, error });
      return { sent: false, error };
    }
    await ctx.runMutation(internal.ttsSignoff.internalFinishProposal, { proposalId, outcome: "sent" });
    return { sent: true };
  },
});
