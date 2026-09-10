"use node";

import { v } from "convex/values";
import { load as loadYaml } from "js-yaml";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  CODE_TODO_PATH,
  CODE_TODO_REPOS,
  SLACK_SUBJECT,
  TTS_DIGEST_NY_HOUR,
  slackHourKey,
  ttsDayBoundsUtc,
  ttsDayKey,
  nyHhmm,
  nyLocalHour,
  type SlackSubject,
} from "./ttsShared";
import { WIKITOM_UNREADABLE, todaySubject, type WikiTomCommit } from "./ttsDigest";
import { HOURLY_UPDATE_ABANDONED, HOURLY_UPDATE_SENT } from "./ttsHourly";
import {
  composeBroken,
  composeDecision,
  composeHourly,
  dropFaultyLines,
  fit,
  isQuietHour,
  renderSlack,
  type BrokenFact,
  type DecisionFact,
  type HourlyFacts,
  type Message,
} from "./ttsCompose";

// TTS actions that reach outside Convex: the 5 a.m. Slack digest, the hourly
// update, and the GitHub vqc/todos.yaml mirror refresh.
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
export const SLACK_RETRY_DELAY_MS = 2_000;

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

// ── The six channels (slack-design.md §1) ────────────────────────────────────
// Six rooms, each with one purpose and one cadence: #tts-today (the morning
// message), #tts-decisions (object, or let it stand), #tts-needs-you (settle
// it), #tts-hourly (glance), #tts-broken (the box is failing), #dump (capture).
// Tom's steps to create them and set these ids are slack-design.md §5.1.

export type SlackChannelKind = "today" | "decisions" | "needsYou" | "hourly" | "broken";

const CHANNEL_ENV: Record<SlackChannelKind, string> = {
  today: "SLACK_TTS_TODAY_CHANNEL_ID",
  decisions: "SLACK_TTS_DECISIONS_CHANNEL_ID",
  needsYou: "SLACK_TTS_NEEDS_YOU_CHANNEL_ID",
  hourly: "SLACK_TTS_HOURLY_CHANNEL_ID",
  broken: "SLACK_TTS_BROKEN_CHANNEL_ID",
};

/** Each channel, or null when its variable is unset. Missing = log once and do
 *  not post (ruling digest-env-missing-is-quiet) — EXCEPT the today channel,
 *  which falls back to SLACK_TTS_CHANNEL_ID, because a missing variable must
 *  not silence the morning. #tts renamed to #tts-today keeps its id, so that
 *  fallback is the same room under its old variable. */
export function channelFor(kind: SlackChannelKind): string | null {
  const own = process.env[CHANNEL_ENV[kind]];
  if (typeof own === "string" && own !== "") return own;
  if (kind === "today") {
    const legacy = process.env.SLACK_TTS_CHANNEL_ID;
    if (typeof legacy === "string" && legacy !== "") return legacy;
  }
  console.error(`TTS slack: ${CHANNEL_ENV[kind]} not configured — nothing posted to #tts-${kind}`);
  return null;
}

/** THE ONE CONFIG CHECK. A message says "reply here" only when a reply would
 *  actually reach TTS: POST /slack/events answers 503 without
 *  SLACK_SIGNING_SECRET, and ignores every message without TOM_SLACK_USER_ID.
 *  Today the morning message prints "missed: reply done, or a new date" six
 *  times a day into a route that answers 503 — the only call to action in the
 *  whole system, and it is dead. A message that asks for something it cannot
 *  receive teaches him to ignore the ones that can. */
export function replyRouteLive(): boolean {
  return Boolean(process.env.SLACK_SIGNING_SECRET && process.env.TOM_SLACK_USER_ID);
}

/** Render a composed message for Slack, dropping any line that breaks the form
 *  and logging what was dropped. The message itself is never dropped. */
export function renderChecked(m: Message, canReply: boolean, where: string): string {
  const { message, faults } = dropFaultyLines(m, { canReply });
  for (const fault of faults) console.error(`TTS slack (${where}): ${fault}`);
  return renderSlack(fit(message).message);
}

/** Deliver an already-verified Fable draft through the same one Slack door as
 * every other message. The draft row claims delivery before this action runs,
 * so a timeout and a late accepted draft cannot create two posts. */
export const sendSlackDraft = internalAction({
  args: { requestId: v.string() },
  handler: async (ctx, { requestId }): Promise<{ sent: boolean; mode?: string; reason?: string; error?: string }> => {
    const draft = await ctx.runMutation(internal.ttsSlackDrafts.internalTakeSlackDraftDelivery, {
      requestId,
    });
    if (draft === null) return { sent: false, reason: "not deliverable" };
    const result = await postSlack(ctx, {
      text: draft.text,
      subject: draft.subject,
      ...(draft.channel === undefined ? {} : { channel: draft.channel }),
      ...(draft.threadTs === undefined ? {} : { threadTs: draft.threadTs }),
      ...(draft.marks === null ? {} : { windowEnd: draft.marks.windowEnd }),
    });
    await ctx.runMutation(internal.ttsSlackDrafts.internalFinishSlackDraftDelivery, {
      requestId,
      ...(result.ok ? {} : { error: result.error }),
    });
    if (!result.ok) return { sent: false, error: result.error };
    // The morning message's own bookkeeping travels with the draft, so the day
    // is marked with the window the FACTS were read against whichever path
    // wrote the text — and `writtenBy` says which one did.
    if (draft.marks !== null) {
      await ctx.runMutation(internal.tts.internalMarkDigestSent, {
        day: draft.marks.day,
        surfacedTodoIds: draft.marks.surfacedTodoIds,
        windowEnd: draft.marks.windowEnd,
        truncated: draft.marks.truncated,
        objectionAskIds: draft.marks.objectionAskIds,
        writtenBy: draft.mode,
        facts: draft.facts,
      });
    }
    return { sent: true, mode: draft.mode };
  },
});

// ONE SWITCH PER MESSAGE KIND. Tom 2026-08-29 turned outbound Slack off as a
// whole ("inbound dump only until the messaging shape is redesigned"); the
// lifeos update (2026-09-05) turns the shapes back on one at a time, each
// behind its own switch, so turning one on never turns another on. The
// INBOUND path (worker/jobs/poll-dump.mjs → /tts/capture) is untouched.
//   DIGEST_ENABLED                 the 5 a.m. morning message (on)
//   TTS_MORNING_WRITER=off         (env) the Fable run on the box does NOT
//                                  write it; the plain template is posted here
//   HOURLY_UPDATE_ENABLED          the hourly line, below, in #tts-hourly
//   DECISION_MESSAGES_ENABLED      #tts-decisions
//   BROKEN_MESSAGES_ENABLED        #tts-broken
// The per-session event line is GONE, not switched off (slack-design.md §1.2):
// a session that needs a decision opens a needs-you thread, and a session that
// failed posts to #tts-broken.
const DIGEST_ENABLED: boolean = true;
/** The Fable writer, off with TTS_MORNING_WRITER=off on the deployment. It is
 *  an env var and not a constant like its siblings for one reason: the writer
 *  lives on the Jarvis Box, so turning it off is what Tom does when the box is
 *  down for a while and he would rather have the template at 5 a.m. than the
 *  template at 5:05. Read per call, so a value set after the isolate warmed up
 *  counts. */
export function morningWriterEnabled(): boolean {
  return process.env.TTS_MORNING_WRITER !== "off";
}

const DECISION_MESSAGES_ENABLED: boolean = true;
const BROKEN_MESSAGES_ENABLED: boolean = true;

// ── Daily digest (the lifeos update, phase 2; spec §7) ──────────────────────
// Scheduled at two UTC times with a local-hour guard so DST needs no cron
// edits; a run proceeds when it is at or after 5 a.m. New York and today's
// digest has not gone out, so a tick that misses the 5 a.m. hour still sends
// the day's digest late rather than skipping the day. ALWAYS sent, even when
// short (sends-even-when-empty rule): a missing digest means Convex/Slack
// breakage.
//
// The run, in order:
//   1. the missed rollover (ttsDigest.internalRollMissed): every active dated
//      todo whose date passed with no outcome gets "missed" once, date kept;
//   2. read the window start, fetch WikiTom's commits over it from GitHub (the
//      one read outside Convex the digest needs), then compose
//      (ttsDigest.internalComposeToday): deterministic, from queries, no model
//      call, no stored queue;
//   3. post through the one door above, subject {kind: "digest", day} — which
//      records the "slack-sent" row a threaded reply from Tom is matched
//      against, retries once on a refusal, and on a second refusal records a
//      "slack-send-failed" row carrying the text the hourly update's tick
//      resends unchanged once that message is switched on;
//   4. mark the day sent: the "digest-sent" row {day, windowEnd} is BOTH the
//      dedupe key for a rerun and the start of the NEXT digest's window — the
//      digest's own bookkeeping, the same shape the hourly update keeps, and
//      separate from the door's row, which belongs to reply routing.
export const sendToday = internalAction({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (!DIGEST_ENABLED && !force) return;
    const now = Date.now();
    // NOT YET SENT TODAY, AND IT IS PAST 5 A.M. — not "it is the 5 a.m. hour".
    // Both UTC crons can miss that hour (a deployment, a Convex delay, a clock
    // an hour out), and an equality guard turns a missed hour into a silently
    // skipped morning. The day key already rolls at 5 (ttsDayKey), so a later
    // tick names today, and the already-sent check below is what keeps it to
    // one send a day. Before 5 the key still names yesterday, whose digest has
    // gone out — the guard is what stops it re-sending under yesterday's key.
    if (!force && nyLocalHour(now) < TTS_DIGEST_NY_HOUR) return;
    const day = ttsDayKey(now);
    // One read for both facts the last digest leaves behind: which day it
    // covered, and where this run's window starts.
    const { lastDay, since } = await ctx.runQuery(
      internal.ttsDigest.internalDigestWindow,
      { now },
    );
    if (lastDay === day && !force) return;

    await ctx.runMutation(internal.ttsDigest.internalRollMissed, { day });
    // One window for the whole run: the composer reads Convex over it and the
    // WikiTom read covers the same one. WikiTom's COMMITS are no longer a
    // section (§4.3): the read stays only to detect that the repository is
    // unreadable, which is a #tts-broken line.
    const wikitom = await fetchWikiTomCommits(since, now);
    const canReply = replyRouteLive();
    const { text, truncated, surfacedTodoIds, objectionAskIds, facts } = await ctx.runQuery(
      internal.ttsDigest.internalComposeToday,
      { day, now, since, canReply },
    );
    if (wikitom === null && BROKEN_MESSAGES_ENABLED) {
      await ctx.scheduler.runAfter(0, internal.ttsSync.sendBroken, {
        job: "wikitom-read",
        statement: WIKITOM_UNREADABLE,
      });
    }

    // ── Who writes it (Tom 2026-09-09, amendment 2) ─────────────────────────
    // The facts above are deterministic and are stored on the digest event, so
    // the transcript shows the inputs. A Fable run on the box
    // (worker/jobs/write-slack.mjs) reads them, writes the message, and a
    // verifier checks every link and every number in what it wrote against
    // them; on a second failure the request falls back to `text`, the plain
    // template, which is why the morning cannot go silent. The draft row
    // carries the digest's own bookkeeping so whichever path posts marks the
    // day sent with the same window.
    const channel = channelFor("today");
    if (morningWriterEnabled()) {
      const opened = await ctx.runMutation(internal.ttsSlackDrafts.internalOpenSlackDraft, {
        requestId: `today:${day}`,
        kind: "today",
        subject: todaySubject(day),
        ...(channel === null ? {} : { channel }),
        facts,
        canReply,
        fallback: text,
        // objectionAskIds RIDES ALONG: whichever path posts, the digest-sent
        // row it marks the day with carries the objection list's own
        // numbering, and a threaded "revert 2" is resolved against that row
        // (convex/ttsSlack.ts namedObjection). Without it here the writer
        // path — the default — dropped every numbered objection silently.
        marks: { day, windowEnd: now, surfacedTodoIds, truncated, objectionAskIds },
      });
      if (opened.opened) return;
      // A request for this day already exists — a re-run, or a --force. Fall
      // through and post the template rather than opening a second one.
    }

    // TWO LINES OF DEFENCE against a Slack blip, because the digest is the one
    // message Tom's morning depends on: the door's one in-run retry, and the
    // "slack-send-failed" row it writes when the retry fails too, which the
    // hourly update's tick resends unchanged — that second owner is switched
    // ON as of the hourly piece (HOURLY_UPDATE_ENABLED), so a refused digest
    // now reaches Tom within the hour rather than not at all.
    // windowEnd travels with the send so that a REFUSED one leaves the
    // boundary behind on its failure row: the hourly update's resend posts
    // this same text and marks the day sent with this same `now`, so tomorrow
    // starts where today's reading actually stopped. Without it the resend
    // would mark the day at the failure row's own clock and everything
    // recorded between composing and failing would be reported by no digest.
    const posted = await postSlack(ctx, {
      text,
      subject: todaySubject(day),
      ...(channel === null ? {} : { channel }),
      windowEnd: now,
    });
    if (!posted.ok) return;
    await ctx.runMutation(internal.tts.internalMarkDigestSent, {
      day,
      surfacedTodoIds,
      // The objection list's numbering travels with the send: a threaded
      // "revert 2" is resolved against this row, not recomputed.
      objectionAskIds,
      // windowEnd, not the row's own `at`: the next digest starts its window
      // where this one's ended, and composing plus posting takes seconds that
      // would otherwise be reported by neither digest.
      windowEnd: now,
      // The morning did not fit one Slack message and sections were reduced to
      // one sentence each: on the row, so a week of them can be counted.
      truncated,
      // Which path wrote it — the template here, "fable" when the box did.
      writtenBy: "template",
      // THE FACTS BLOCK, on the event: the transcript shows the inputs the
      // message was written from, not only the message (amendment 2).
      facts,
    });
  },
});

// ── WikiTom commits for the digest (plan §3) ─────────────────────────────────
// Every commit pushed to WikiTom's default branch inside the digest's window,
// with its author. Read with GITHUB_MIRROR_TOKEN — the one GitHub credential
// this deployment has (the same one the code-todo mirror and the skill sync
// use). It is scoped to ComplexMultiTrigger and tom.quest today, so WikiTom
// answers 403/404 until Tom widens it; every unreadable case (no token, a
// refusal, a network error, a shape that is not a commit list) returns null,
// and the digest prints WIKITOM_UNREADABLE so the gap is visible rather than
// looking like a quiet week.
//
// CAP: one page of 100. A night with more commits than that is a bulk import,
// and the digest is a morning read, not a changelog.
const WIKITOM_REPO = "Heffnt/WikiTom";
const WIKITOM_COMMIT_CAP = 100;

async function fetchWikiTomCommits(
  since: number,
  until: number,
): Promise<WikiTomCommit[] | null> {
  const token = process.env.GITHUB_MIRROR_TOKEN;
  if (!token) return null;
  try {
    const url =
      `https://api.github.com/repos/${WIKITOM_REPO}/commits` +
      `?since=${new Date(since).toISOString()}&until=${new Date(until).toISOString()}` +
      `&per_page=${WIKITOM_COMMIT_CAP}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "tts-digest",
      },
    });
    if (!res.ok) {
      console.error(`TTS digest: WikiTom commits unreadable (${res.status})`);
      return null;
    }
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) {
      console.error("TTS digest: WikiTom commits response is not a list");
      return null;
    }
    return body.map((entry) => {
      const e = (entry ?? {}) as {
        sha?: unknown;
        html_url?: unknown;
        commit?: { message?: unknown; author?: { name?: unknown } };
        author?: { login?: unknown };
      };
      const sha = typeof e.sha === "string" ? e.sha : "";
      const message =
        typeof e.commit?.message === "string" ? e.commit.message.split("\n")[0] : "";
      const author =
        (typeof e.commit?.author?.name === "string" ? e.commit.author.name : "") ||
        (typeof e.author?.login === "string" ? e.author.login : "") ||
        "unknown author";
      return {
        sha,
        message,
        author,
        url:
          typeof e.html_url === "string"
            ? e.html_url
            : `https://github.com/${WIKITOM_REPO}/commit/${sha}`,
      };
    });
  } catch (err) {
    console.error(
      `TTS digest: WikiTom commit read error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}


// ── #tts-decisions: one message per delegated decision ───────────────────────
// One action: revert. The default is silence, and silence is consent. This is
// the channel the round exists for — without it Tom can only object at 5 a.m.
// about a decision taken at 2 p.m., by which time the run that acted on it has
// finished. The morning's objection list is the last call on the same rows.
//
// CLAIMED FOR THE DAY under the "object" ask, so the same decision does not
// also arrive as a live line and a morning line on ONE day; the next morning
// is a different TTS day and re-raises it deliberately (slack-design.md §2.5).
export const sendDecision = internalAction({
  args: {
    askId: v.string(),
    todoId: v.optional(v.string()),
    decision: v.string(),
    reason: v.optional(v.string()),
    refused: v.optional(v.boolean()),
    refusedBecause: v.optional(v.string()),
    fallback: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ sent: boolean; reason?: string; error?: string }> => {
    if (!DECISION_MESSAGES_ENABLED) return { sent: false, reason: "switched off" };
    const channel = channelFor("decisions");
    if (channel === null) return { sent: false, reason: "not configured" };
    const day = ttsDayKey(Date.now());
    const claim = await ctx.runMutation(internal.ttsSlack.internalClaimSlackItem, {
      day,
      ask: "object",
      itemId: args.todoId ?? args.askId,
      channel: "decisions",
    });
    if (!claim.claimed) return { sent: false, reason: `already claimed by ${claim.by}` };
    const fact: DecisionFact = args;
    const canReply = replyRouteLive();
    const posted = await postSlack(ctx, {
      text: renderChecked(composeDecision(fact, { canReply }), canReply, "decision"),
      subject: { kind: "ask", id: args.askId },
      channel,
    });
    return posted.ok ? { sent: true } : { sent: false, error: posted.error };
  },
});

// ── #tts-broken: one message per distinct failure ────────────────────────────
// No action most days, and a session on the days it matters. SEPARATE from
// #tts-hourly because the hourly line is silent when nothing changed: putting
// failures there would destroy the only property that makes silence
// informative.
//
// Deduped BY JOB for the TTS day — a poller failing every ten minutes posts
// once and the morning message states the count. That claim uses its own ask
// name, so it never collides with the "act"/"object" index a channel shares.
export const sendBroken = internalAction({
  args: {
    job: v.string(),
    statement: v.string(),
    detail: v.optional(v.string()),
    url: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { job, statement, detail, url },
  ): Promise<{ sent: boolean; reason?: string; error?: string }> => {
    if (!BROKEN_MESSAGES_ENABLED) return { sent: false, reason: "switched off" };
    const channel = channelFor("broken");
    if (channel === null) return { sent: false, reason: "not configured" };
    const claim = await ctx.runMutation(internal.ttsSlack.internalClaimSlackItem, {
      day: ttsDayKey(Date.now()),
      ask: "broken",
      itemId: job,
      channel: "broken",
    });
    if (!claim.claimed) return { sent: false, reason: "already reported today" };
    const fact: BrokenFact = { statement, detail, url };
    const posted = await postSlack(ctx, {
      text: renderChecked(composeBroken(fact), false, "broken"),
      subject: { kind: "job", id: job },
      channel,
    });
    return posted.ok ? { sent: true } : { sent: false, error: posted.error };
  },
});

// ── The hourly update (Tom's ruling 2026-08-30; the lifeos update, phase 2) ──
// Every hour, 24/7, in #tts-hourly (SLACK_TTS_HOURLY_CHANNEL_ID — its OWN
// channel, not #tts): what the box is running now, which batches were worked
// since the last update, what changed since the last update — or ONE line
// saying nothing did. The facts are read by convex/ttsHourly.ts and the text
// composed by convex/ttsCompose.ts; this action is the send, and it sends
// through the one door above like every other message.
//
// SENDS EVEN WHEN EMPTY, on the same reasoning as the digest
// (digest-env-missing-is-quiet, vqc/adoption.md): a quiet hour is a fact worth
// stating, and the ABSENT message is then the alarm.
//
// ITS OWN SWITCH (see the per-kind switches at the top): a different message
// with a different ruling behind it, so turning the digest on did not turn
// this on, and this being on does not turn the session event lines on.
const HOURLY_UPDATE_ENABLED: boolean = true;

// The first run has no marker to read back. One hour, so a fresh deployment's
// first update is an ordinary one rather than a dump of all history.
const HOURLY_UPDATE_FIRST_WINDOW_MS = 60 * 60 * 1000;

// The refusals that will not change. Slack's misconfiguration vocabulary: the
// channel is gone or unjoined or archived, the token is dead, the message is
// too long. Retrying one of these next hour retries it every hour for ever,
// against a window that never advances — so the hour is closed unreported (the
// "hourly-update-abandoned" marker) and the door's "slack-send-failed" row is
// what says the hour was lost and why.
//
// NAMED EXPLICITLY, and everything else counts as transient — including a
// thrown fetch, whose message is whatever the runtime said. Guessing wrong
// this way costs a longer message next hour (and the section caps bound even
// that); guessing wrong the other way throws away an hour Tom never sees.
//
// The door has ALREADY retried once by the time an error reaches here, so this
// classifies a refusal that survived a retry, not one attempt.
const PERMANENT_SLACK_ERRORS = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "no_permission",
  "restricted_action",
  "org_login_required",
  "msg_too_long",
  "invalid_arguments",
  // The door's own word when neither the token nor a channel is configured.
  // Nothing about the next hour makes that different.
  "not configured",
]);

export const sendHourlyUpdate = internalAction({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (!HOURLY_UPDATE_ENABLED && !force) return;
    const now = Date.now();

    // The hourly channel is a SECOND channel the door does not default to, so
    // it is checked here rather than left to the door's own env check. Missing
    // = one log line and no send (the sanctioned log-and-return, ruling
    // digest-env-missing-is-quiet): a cron that throws adds no louder channel
    // than this line, and the missing message is itself the signal.
    // worker/bin/tts-slack-setup prints the id.
    const channel = channelFor("hourly");
    if (!process.env.SLACK_BOT_TOKEN || channel === null) {
      console.error("TTS hourly update: SLACK_BOT_TOKEN not configured — skipped");
      return;
    }

    // ── The digest resend ────────────────────────────────────────────────────
    // The one duty this message owes another: today's digest, if it was
    // composed and refused, goes out here before anything else — the SAME
    // text, unchanged. It goes to the DIGEST's channel, #tts (the door's
    // default), because the digest is Tom's morning message and #tts-hourly is
    // a different room; a resend into #tts-hourly would deliver it where he is
    // not reading it. Marking the day sent is what stops the next tick
    // resending it.
    const day = ttsDayKey(now);
    const bounds = ttsDayBoundsUtc(day);
    const owed = await ctx.runQuery(internal.ttsHourly.internalDigestToResend, {
      day,
      dayStart: bounds.start,
      dayEnd: bounds.end,
    });
    if (owed !== null) {
      const resent = await postSlack(ctx, {
        text: owed.text,
        subject: todaySubject(day),
        ...(channelFor("today") === null ? {} : { channel: channelFor("today") as string }),
        // The boundary travels with the RESEND too, not just the first send:
        // a refused resend writes a fresh "slack-send-failed" row, and that
        // row is the newest one internalDigestToResend reads next hour. Drop
        // it here and the second row carries only its own `at`, so a retry
        // that keeps failing walks the boundary forward an hour at a time and
        // tomorrow's digest starts after events no digest ever reported.
        windowEnd: owed.windowEnd,
      });
      if (resent.ok) {
        await ctx.runMutation(internal.tts.internalMarkDigestSent, {
          day,
          // The composer's list of surfaced todos did not survive the failed
          // send, and the digest's text did. Reposting the text Tom missed
          // matters; re-emitting the "surfaced" instrumentation does not.
          surfacedTodoIds: [],
          windowEnd: owed.windowEnd,
        });
      }
      // A refused resend needs nothing here: the door wrote a fresh
      // "slack-send-failed" row carrying the same text and the same boundary,
      // so the next tick owes the same digest against the same window.
    }

    // ── The window ───────────────────────────────────────────────────────────
    const lastEnd: number | null = await ctx.runQuery(
      internal.ttsHourly.internalLastHourlyWindowEnd,
      {},
    );
    const since = lastEnd ?? now - HOURLY_UPDATE_FIRST_WINDOW_MS;

    const facts: HourlyFacts = {
      now,
      since,
      // The window is normally the last hour and the line says nothing about
      // it; a longer one (a missed tick, a run of refusals) names where it
      // starts, once, at the end of the sentence.
      ...(now - since > HOURLY_UPDATE_FIRST_WINDOW_MS * 1.5
        ? { sinceLabel: nyHhmm(since) }
        : {}),
      running: await ctx.runQuery(internal.ttsHourly.internalRunningNow, { now }),
      batches: await ctx.runQuery(internal.ttsHourly.internalBatchesWorked, {
        since,
        now,
      }),
      changes: await ctx.runQuery(internal.ttsHourly.internalChangedSince, {
        start: since,
        end: now,
      }),
    };

    // ── THE SILENCE RULE (slack-design.md §4.4) ─────────────────────────────
    // Nothing running, no batch worked, nothing changed: NOTHING IS POSTED,
    // and the marker is still written, with posted:false. The marker is what
    // advances the window; skipping it would make the next hour re-read this
    // one and the message would slowly grow a tail of hours nobody saw.
    // `posted` is on the row so a week of them can say how many hours were
    // quiet.
    //
    // The old heartbeat line is deleted, and with it "the absent message is
    // the alarm" for this channel. That property moves where it belongs: the
    // MORNING MESSAGE is the proof of life (it sends even when empty, from a
    // cron, at a fixed hour), and #tts-broken carries every job failure.
    const message = composeHourly(facts);
    if (message === null) {
      await ctx.runMutation(internal.tts.internalLogEvent, {
        kind: HOURLY_UPDATE_SENT,
        data: { windowStart: since, windowEnd: now, quiet: true, posted: false },
      });
      return;
    }

    const sent = await postSlack(ctx, {
      text: renderChecked(message, false, "hourly"),
      subject: { kind: "hourly", hour: slackHourKey(now) },
      channel,
    });
    // The marker below is what advances the window, so it is NOT written on a
    // transient refusal: the next update then covers this window too, and a
    // Slack outage delays the history rather than losing it.
    if (!sent.ok) {
      if (PERMANENT_SLACK_ERRORS.has(sent.error)) {
        await ctx.runMutation(internal.tts.internalLogEvent, {
          kind: HOURLY_UPDATE_ABANDONED,
          data: { windowStart: since, windowEnd: now, error: sent.error },
        });
      } else if (lastEnd === null) {
        // THE FIRST RUN, REFUSED. "Cover this window again next hour" needs a
        // window to come back to, and the first run has no marker to read: the
        // next run would compute its own now-minus-an-hour and the refused
        // hour's oldest end would be gone for good. So the window START is
        // recorded as a marker of its own — an abandoned window of zero width,
        // reporting nothing, saying only where reporting begins. The next run
        // reads it as its start and covers both hours.
        //
        // Only on a transient refusal, and only with no marker: a permanent
        // one closes the hour above, and every later run already has a marker.
        await ctx.runMutation(internal.tts.internalLogEvent, {
          kind: HOURLY_UPDATE_ABANDONED,
          data: { windowStart: since, windowEnd: since, error: sent.error },
        });
      }
      return;
    }
    await ctx.runMutation(internal.tts.internalLogEvent, {
      kind: HOURLY_UPDATE_SENT,
      data: { windowStart: since, windowEnd: now, quiet: isQuietHour(facts), posted: true },
    });
  },
});

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
  handler: async (ctx) => {
    const token = process.env.GITHUB_MIRROR_TOKEN;
    if (!token) return;
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
          console.error(`TTS mirror: ${repo} fetch failed (${res.status})`);
          continue;
        }
        const parsed = loadYaml(await res.text());
        if (!Array.isArray(parsed)) {
          console.error(`TTS mirror: ${repo} vqc/todos.yaml is not a list`);
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
          console.error(
            `TTS mirror: ${repo} vqc/todos.yaml parsed to 0 entries from ${parsed.length} list items — format change? Mirror left untouched.`,
          );
          continue;
        }
        await ctx.runMutation(internal.tts.internalReplaceMirror, { repo, rows });
      } catch (err) {
        console.error(
          `TTS mirror: ${repo} refresh error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  },
});
