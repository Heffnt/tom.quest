"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { SLACK_SUBJECT, replyRouteLive, type SlackSubject } from "./ttsShared";

// Convex actions that reach outside Convex: the one Slack door.
// Spec: WikiTom tts/spec.md §7.

const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";

// ── The one door to Slack (the lifeos update, phase 2) ───────────────────────
// EVERY chat.postMessage in Convex goes through postSlack: the digest, the
// hourly update, session event lines, the reply at capture, and the thread
// notices convex/ttsSlack.ts schedules. What the door guarantees, and no
// caller has to remember: a message names its subject; a delivered message is
// recorded as a dtsEvents "slack-sent" row (channel, ts, thread, subject,
// text) so Tom's threaded reply can be routed back to what it answers; a
// refused one is recorded as "slack-send-failed". No worker posts to Slack on
// its own: the capture is the one replier to a #dump message, and a refused
// reply stays a recorded failure rather than a second sender's turn.
//
// Missing env is log-and-return (ruling digest-env-missing-is-quiet,
// vqc/adoption.md, 2026-08-27). The channel defaults to #tts.
//
// ONE IN-RUN RETRY, at the door rather than in any caller: most refusals here
// are a rate limit or a dropped connection that the second attempt fixes, and
// the digest is the one message Tom's morning depends on. The failure row is
// written once, after the retry, and says how many attempts it took.
//
type SlackSendResult =
  | { ok: true; ts: string }
  | { ok: false; error: string; refused: boolean };

// The pause before the retry. Long enough for a rate limit or a dropped
// connection to clear, short enough that a 5 a.m. action does not sit waiting.
const SLACK_RETRY_DELAY_MS = 2_000;

async function postOnce(
  token: string,
  target: string,
  { text, threadTs }: { text: string; threadTs?: string },
): Promise<{ ok: boolean; ts?: string; error?: string; refused?: boolean }> {
  try {
    const res = await fetch(SLACK_POST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: target,
        text,
        unfurl_links: false,
        ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
      }),
    });
    const answer = (await res.json()) as { ok: boolean; ts?: string; error?: string };
    // Slack's own ok:false is a definite refusal; anything else unknown.
    return answer.ok === false ? { ...answer, refused: true } : answer;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function postSlack(
  ctx: ActionCtx,
  {
    text,
    subject,
    channel,
    threadTs,
    windowEnd,
  }: {
    text: string;
    subject: SlackSubject;
    channel?: string;
    threadTs?: string;
    // THE COMPOSITION BOUNDARY, for a message composed against a window: the
    // instant the caller read Convex up to. It is recorded on the failure row
    // and nowhere else, because a resend of that row has to advance the window
    // to the boundary the TEXT covers, not to the clock the failure was
    // written at. Composing, retrying and recording take seconds, and every
    // event inside them would otherwise fall between two digests.
    windowEnd?: number;
  },
): Promise<SlackSendResult> {
  const token = process.env.SLACK_BOT_TOKEN;
  const target = channel ?? process.env.SLACK_TTS_CHANNEL_ID;
  if (!token || !target) {
    console.error(
      `TTS slack (${subject.kind}): SLACK_BOT_TOKEN / SLACK_TTS_CHANNEL_ID not configured`,
    );
    return { ok: false, error: "not configured", refused: true };
  }
  let result = await postOnce(token, target, { text, threadTs });
  let attempts = 1;
  if (!result.ok || typeof result.ts !== "string") {
    console.error(
      `TTS slack (${subject.kind}): Slack rejected the post: ${result.error ?? "no ts in Slack's answer"} — retrying once`,
    );
    await new Promise((resolve) => setTimeout(resolve, SLACK_RETRY_DELAY_MS));
    result = await postOnce(token, target, { text, threadTs });
    attempts = 2;
  }
  if (!result.ok || typeof result.ts !== "string") {
    const error = result.error ?? "no ts in Slack's answer";
    console.error(`TTS slack (${subject.kind}): Slack rejected the post: ${error}`);
    // The text goes on the failure row: it is what a later resend posts
    // unchanged, so the message Tom missed is the message he eventually gets.
    await ctx.runMutation(internal.ttsSlack.internalRecordSlackFailed, {
      channel: target,
      threadTs,
      subject,
      error,
      text,
      attempts,
      windowEnd,
    });
    return { ok: false, error, refused: result.refused === true };
  }
  await ctx.runMutation(internal.ttsSlack.internalRecordSlackSent, {
    channel: target,
    ts: result.ts,
    threadTs,
    subject,
    text,
  });
  return { ok: true, ts: result.ts };
}

/** The door as a schedulable function, for mutations (a capture, a thread
 * reply) that cannot do network I/O themselves. Same effect as postSlack. */
export const sendSlack = internalAction({
  args: {
    text: v.string(),
    subject: SLACK_SUBJECT,
    channel: v.optional(v.string()),
    threadTs: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<SlackSendResult> =>
    await postSlack(ctx, args),
});

// The one config check, replyRouteLive, lives in convex/ttsShared.ts so the
// plain-runtime digest area (convex/jarvis/digest.ts) reads it too.
export { replyRouteLive };

// ── What left this file (Tom, 2026-09-26: #dump in, one out) ─────────────────
// The digest's Convex sender and its Fable draft door, the hourly update, and
// the per-channel senders for #tts-decisions, #tts-broken, #tts-simplify and
// #tts-runners are gone. The box writes the one deterministic digest (Jarvis
// worker/jobs/write-slack.mjs over convex/jarvis/digest.ts), and what each
// channel carried is a section of it, read from the record: decisions and
// merges in the objection list, failures and recoveries in broken, box
// changes in box. The door above stays for the replies Convex itself posts
// (the capture reply in #dump, a thread notice) and the silence alarm.
