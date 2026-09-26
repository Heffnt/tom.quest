"use node";

import { v } from "convex/values";
import { load as loadYaml } from "js-yaml";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { CODE_TODO_PATH, CODE_TODO_REPOS, SLACK_SUBJECT, replyRouteLive, type SlackSubject } from "./ttsShared";

// Convex actions that reach outside Convex: the one Slack door, and the
// GitHub vqc/todos.yaml mirror refresh (a record-tick task, convex/jarvis/tick.ts).
// Spec: WikiTom tts/spec.md §7, §5.3.

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
type SlackSendResult =
  | { ok: true; ts: string }
  | { ok: false; error: string };

// The pause before the retry. Long enough for a rate limit or a dropped
// connection to clear, short enough that a 5 a.m. action does not sit waiting.
const SLACK_RETRY_DELAY_MS = 2_000;

async function postOnce(
  token: string,
  target: string,
  { text, threadTs }: { text: string; threadTs?: string },
): Promise<{ ok: boolean; ts?: string; error?: string }> {
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
    return (await res.json()) as { ok: boolean; ts?: string; error?: string };
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
    return { ok: false, error: "not configured" };
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
    return { ok: false, error };
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

// ── Code-todo mirror refresh (spec §5.3) ─────────────────────────────────────
// Reads each repo's vqc/todos.yaml from its DEFAULT branch (worktrees carry
// divergent copies) via the GitHub contents API. Link-by-id-never-copy: the
// mirror stores only what the Inventory needs to display + deep-link. Silently
// a no-op until GITHUB_MIRROR_TOKEN is configured.
// Which repos, and which branch each file is read from, comes from the one
// home in ttsShared — the prospecting prompt reads the same list to know which
// checkouts hold a registry a prospector must not re-capture from.
const MIRROR_SOURCES = Object.entries(CODE_TODO_REPOS).map(([repo, { branch }]) => ({
  repo,
  branch,
}));

type VqcEntry = {
  id?: unknown;
  tier?: unknown;
  readiness?: unknown;
  status?: unknown;
  statement?: unknown;
  closed?: unknown;
};

export const refreshMirror = internalAction({
  args: {},
  handler: async (ctx): Promise<{ failures: string[] }> => {
    const token = process.env.GITHUB_MIRROR_TOKEN;
    if (!token) return { failures: [] };
    // A repository that failed is a failure of the run (convex/jarvis/tick.ts
    // failuresOf); the others are still mirrored.
    const failures: string[] = [];
    const fail = (message: string) => {
      console.error(message);
      failures.push(message);
    };
    for (const { repo, branch } of MIRROR_SOURCES) {
      try {
        const res = await fetch(
          `https://api.github.com/repos/Heffnt/${repo}/contents/${CODE_TODO_PATH}?ref=${branch}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github.raw+json",
              "User-Agent": "tts-mirror",
            },
          },
        );
        if (res.status === 404) continue; // repo has no vqc file (yet)
        if (!res.ok) {
          fail(`TTS mirror: ${repo} fetch failed (${res.status})`);
          continue;
        }
        const parsed = loadYaml(await res.text());
        if (!Array.isArray(parsed)) {
          fail(`TTS mirror: ${repo} vqc/todos.yaml is not a list`);
          continue;
        }
        const url = `https://github.com/Heffnt/${repo}/blob/${branch}/${CODE_TODO_PATH}`;
        const rows = (parsed as VqcEntry[])
          .filter((e) => typeof e?.id === "string")
          .map((e) => ({
            externalId: e.id as string,
            // Verbatim repo vocabulary, tier first: CMT entries carry `tier`
            // (single letters, until its rename todo lands); tom.quest carries
            // `readiness`.
            tier: String(e.tier ?? e.readiness ?? "?"),
            status:
              e.closed !== undefined ||
              e.status === "done" ||
              e.status === "archived" ||
              e.status === "closed"
                ? "closed"
                : "open",
            statement: String(e.statement ?? "").trim(),
            url,
          }));
        // Shape-change guard (review finding): a non-empty upstream list that
        // parses to zero rows means the format changed, not that every todo
        // vanished — replacing would silently wipe the mirror. Keep the stale
        // mirror and complain instead.
        if (parsed.length > 0 && rows.length === 0) {
          fail(
            `TTS mirror: ${repo} vqc/todos.yaml parsed to 0 entries from ${parsed.length} list items — format change? Mirror left untouched.`,
          );
          continue;
        }
        await ctx.runMutation(internal.tts.internalReplaceMirror, { repo, rows });
      } catch (err) {
        fail(`TTS mirror: ${repo} refresh error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { failures };
  },
});
