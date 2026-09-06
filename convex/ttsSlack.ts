import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { logEvent } from "./tts";
import {
  SLACK_SUBJECT,
  slackThreadKey,
  type SlackSubject,
} from "./ttsShared";

// Slack, the Convex side (the lifeos update, phase 2).
//
//  THE RECORD OF EVERY SEND. convex/ttsSync.ts holds the one door that
//     posts to Slack; after each post it calls recordSlackSent below, which
//     writes a dtsEvents row of kind "slack-sent" keyed by the thread the
//     message lives in, carrying the message's subject. That row is what a
//     later reply from Tom is matched against.

// ── The record of a send ─────────────────────────────────────────────────────

const RECORD_SLACK_SENT_ARGS = {
  channel: v.string(),
  ts: v.string(),
  threadTs: v.optional(v.string()),
  subject: SLACK_SUBJECT,
  text: v.string(),
};

/**
 * One "slack-sent" row per posted message: channel, ts, the thread it lives
 * in (its own ts when it is a root), its subject, and the text as posted.
 * When the subject is a todo, the todo's slackReplyTs is stamped — the FIRST
 * reply only, never re-pointed: the reply that exists in Slack is the first
 * one (Tom's ruling 2026-08-30: exactly one reply per #dump message).
 */
export async function recordSlackSent(
  ctx: MutationCtx,
  {
    channel,
    ts,
    threadTs,
    subject,
    text,
  }: {
    channel: string;
    ts: string;
    threadTs?: string;
    subject: SlackSubject;
    text: string;
  },
): Promise<void> {
  const todoId = subject.kind === "todo" ? subject.id : undefined;
  await ctx.db.insert("dtsEvents", {
    at: Date.now(),
    kind: "slack-sent",
    key: slackThreadKey(channel, threadTs ?? ts),
    todoId,
    data: { channel, ts, threadTs, subject, text },
  });
  if (todoId !== undefined) {
    const todo = await ctx.db.get(todoId);
    if (todo && todo.slackRepliedAt === undefined) {
      await ctx.db.patch(todoId, {
        slackRepliedAt: Date.now(),
        slackReplyTs: ts,
      });
    }
  }
}

export const internalRecordSlackSent = internalMutation({
  args: RECORD_SLACK_SENT_ARGS,
  handler: async (ctx, args) => {
    await recordSlackSent(ctx, args);
  },
});

/** A send Slack refused (or that never reached Slack) is a fact too: one
 * "slack-send-failed" row with the subject, so the digest can report it. */
export const internalRecordSlackFailed = internalMutation({
  args: {
    channel: v.optional(v.string()),
    threadTs: v.optional(v.string()),
    subject: SLACK_SUBJECT,
    error: v.string(),
  },
  handler: async (ctx, { channel, threadTs, subject, error }) => {
    await logEvent(
      ctx,
      "slack-send-failed",
      subject.kind === "todo" ? subject.id : undefined,
      { channel, threadTs, subject, error },
    );
  },
});

// The worker's reply pen (POST /tts/slack-replied): prepare-life-todos.mjs
// posted its one threaded reply and records it here. The same first-reply-only
// rule as recordSlackSent, which it goes through — so a worker send leaves the
// same "slack-sent" row as a Convex send.
export const internalMarkSlackReplied = internalMutation({
  args: { id: v.string(), replyTs: v.optional(v.string()) },
  handler: async (ctx, { id, replyTs }) => {
    const normalized = ctx.db.normalizeId("dtsTodos", id);
    const todo = normalized && (await ctx.db.get(normalized));
    if (!todo) throw new Error(`Unknown todo id: ${id}`);
    if (todo.slackRepliedAt !== undefined) return { alreadyReplied: true };
    if (todo.slackChannel !== undefined && replyTs !== undefined) {
      await recordSlackSent(ctx, {
        channel: todo.slackChannel,
        ts: replyTs,
        threadTs: todo.slackTs,
        subject: { kind: "todo", id: todo._id },
        text: "(posted by prepare-life-todos.mjs)",
      });
    } else {
      // No coordinates to key a thread on: stamp the guard and nothing else.
      await ctx.db.patch(todo._id, {
        slackRepliedAt: Date.now(),
        slackReplyTs: replyTs,
      });
    }
    return { alreadyReplied: false };
  },
});
