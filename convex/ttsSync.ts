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
  ttsDayKey,
  ttsSessionLink,
  nyHhmm,
  nyLocalHour,
  type SlackSubject,
} from "./ttsShared";
import { digestSubject, type WikiTomCommit } from "./ttsDigest";

// TTS actions that reach outside Convex: the 5 a.m. Slack digest and the
// GitHub vqc/todos.yaml mirror refresh. Spec: WikiTom tts/spec.md §7, §5.3.

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
  }: {
    text: string;
    subject: SlackSubject;
    channel?: string;
    threadTs?: string;
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

// ONE SWITCH PER MESSAGE KIND. Tom 2026-08-29 turned outbound Slack off as a
// whole ("inbound dump only until the messaging shape is redesigned"); the
// lifeos update (2026-09-05) turns the shapes back on one at a time, each
// behind its own switch, so turning one on never turns another on. The
// INBOUND path (worker/jobs/poll-dump.mjs → /tts/capture) is untouched.
//   DIGEST_ENABLED                 the 5 a.m. digest (on: phase 2, this file)
//   SESSION_EVENT_MESSAGES_ENABLED per-session event lines (off: the events
//                                  route replaces them)
//   HOURLY_UPDATE_ENABLED          the hourly update, below (the hourly piece)
const DIGEST_ENABLED: boolean = true;
const SESSION_EVENT_MESSAGES_ENABLED: boolean = false;

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
//      (ttsDigest.internalComposeDigest): deterministic, from queries, no model
//      call, no dtsDailyQueues.digestText;
//   3. post through the one door above, subject {kind: "digest", day} — which
//      records the "slack-sent" row a threaded reply from Tom is matched
//      against, retries once on a refusal, and on a second refusal records a
//      "slack-send-failed" row carrying the text the hourly update's tick
//      resends unchanged once that message is switched on;
//   4. mark the day sent: the "digest-sent" row {day, windowEnd} is BOTH the
//      dedupe key for a rerun and the start of the NEXT digest's window — the
//      digest's own bookkeeping, the same shape the hourly update keeps, and
//      separate from the door's row, which belongs to reply routing.
export const sendDigest = internalAction({
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
    // WikiTom fetch reads GitHub over the same one.
    const wikitom = await fetchWikiTomCommits(since, now);
    const { text, surfacedTodoIds } = await ctx.runQuery(
      internal.ttsDigest.internalComposeDigest,
      { day, now, since, wikitom },
    );

    // TWO LINES OF DEFENCE against a Slack blip, because the digest is the one
    // message Tom's morning depends on: the door's one in-run retry, and the
    // "slack-send-failed" row it writes when the retry fails too, which the
    // hourly update's tick resends unchanged. That second owner is switched
    // OFF today (HOURLY_UPDATE_ENABLED), which is why the retry is not
    // optional.
    const posted = await postSlack(ctx, { text, subject: digestSubject(day) });
    if (!posted.ok) return;
    await ctx.runMutation(internal.tts.internalMarkDigestSent, {
      day,
      surfacedTodoIds,
      // windowEnd, not the row's own `at`: the next digest starts its window
      // where this one's ended, and composing plus posting takes seconds that
      // would otherwise be reported by neither digest.
      windowEnd: now,
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


// ── Session event messages (todo tts-session-needs-you-notify) ───────────────
// The OUTBOUND half of spec §7's two-way event messages: one Slack line the
// moment a session needs Tom (a permission decision) or records what it did
// (an outcome, or a failure), each carrying a deep link to the session.
//
// Through the one door above, to #tts, with the session as its subject — so
// Tom's reply in the message's thread becomes the session's next turn
// (convex/ttsSlack.ts).
//
// The CALLERS decide when to send (convex/claudeSessions.ts schedules this on
// edge-triggered transitions only, so a session that polls for an hour while
// blocked still produces exactly one message). Nothing here dedupes.
export const internalSessionEventMessage = internalAction({
  args: { sessionId: v.id("claudeSessions"), text: v.string() },
  handler: async (ctx, { sessionId, text }) => {
    // Callers still SCHEDULE this action on their edge transitions (the trigger
    // wiring is what the tests cover); it posts nothing while the switch is off.
    if (!SESSION_EVENT_MESSAGES_ENABLED) return;
    // The link is the point: the message says what happened, the URL is where
    // to act on it.
    await postSlack(ctx, {
      text: `${text}\n${ttsSessionLink(sessionId)}`,
      subject: { kind: "session", id: sessionId },
    });
  },
});

// ── The hourly update (Tom's ruling 2026-08-30) ──────────────────────────────
// Three parts, in this order, every hour:
//   (a) what Tom is scheduled to be doing AT THAT MOMENT,
//   (b) every agent currently working on TTS,
//   (c) what has happened since the last update.
//
// SENDS EVEN WHEN EMPTY, on the same reasoning as the digest
// (digest-env-missing-is-quiet, vqc/adoption.md): a quiet hour is a fact worth
// stating, and the ABSENT message is then the alarm. An hour with nothing in
// any of the three parts still posts "nothing scheduled / no agents / nothing
// since the last update".
//
// ITS OWN SWITCH (see the per-kind switches at the top): a different message
// with a different ruling behind it, so turning the digest on did not turn
// this on.
const HOURLY_UPDATE_ENABLED: boolean = false;

// The window's own bookkeeping. A dtsEvents row is written after each send, and
// the newest one is read before composing — so the window is [last sent, now]
// and a MISSED cron tick loses nothing: the next update simply covers two
// hours. Without it the window would be a hardcoded hour, and every skipped
// tick would silently drop an hour of history.
const HOURLY_UPDATE_SENT = "hourly-update-sent";
// The first run has no marker to read back. One hour, so a fresh deployment's
// first update is an ordinary one rather than a dump of all history.
const HOURLY_UPDATE_FIRST_WINDOW_MS = 60 * 60 * 1000;

export const sendHourlyUpdate = internalAction({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (!HOURLY_UPDATE_ENABLED && !force) return;
    const now = Date.now();

    // ── The window ───────────────────────────────────────────────────────────
    const lastSent = await ctx.runQuery(internal.tts.internalLastEventAt, {
      kind: HOURLY_UPDATE_SENT,
    });
    const since = lastSent ?? now - HOURLY_UPDATE_FIRST_WINDOW_MS;

    // ── (a) What Tom is scheduled to be doing right now ──────────────────────
    // Two sources, read separately so an empty answer says WHICH half was
    // empty: the blocks Tom placed, and the read-only ICS calendar mirror.
    const blocks = await ctx.runQuery(internal.tts.internalScheduleAt, {
      at: now,
    });
    const events = await ctx.runQuery(
      internal.ttsCalendar.internalListEventsInRange,
      { start: now, end: now + 1 },
    );
    const scheduleLines = [
      ...blocks.map(
        (b) =>
          `- ${nyHhmm(b.start)}–${nyHhmm(b.end)} ${
            b.statement ?? b.category ?? b.note ?? "block"
          }`,
      ),
      ...events.map((e) => `- ${nyHhmm(e.start)}–${nyHhmm(e.end)} ${e.title}`),
    ];

    // ── (b) Every agent currently working on TTS ─────────────────────────────
    const live = await ctx.runQuery(
      internal.claudeSessions.internalListLive,
      {},
    );

    // ── (c) What has happened since the last update ──────────────────────────
    const since_events = await ctx.runQuery(internal.tts.internalEventsInRange, {
      start: since,
      end: now,
    });
    // The kinds worth a line in Slack. dtsEvents is busy instrumentation —
    // every surfacing and queue cycle lands there — so reporting all of it
    // would bury the three or four facts that matter in an hour.
    const REPORTABLE: Record<string, string> = {
      captured: "captured",
      "session-created": "session opened",
      "session-outcome": "session finished",
      "session-ended": "session ended",
      ruling: "you ruled",
      "plan-repair": "plan repair reported",
      "batches-stored": "batches re-formed",
      "graph-batch-formed": "batch formed",
    };
    const counts = new Map<string, number>();
    for (const e of since_events) {
      const label = REPORTABLE[e.kind];
      if (label === undefined) continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }

    const text = [
      `*TTS — ${nyHhmm(now)}*`,
      ``,
      `*Now*`,
      ...(scheduleLines.length > 0 ? scheduleLines : ["- nothing scheduled"]),
      ``,
      `*Agents working*`,
      ...(live.length > 0
        ? live.map(
            (s) =>
              `- ${s.title} (${s.status}, ${s.mode}${
                s.repos.length > 0 ? `, ${s.repos.join(" + ")}` : ""
              })`,
          )
        : ["- none"]),
      ``,
      `*Since ${nyHhmm(since)}*`,
      ...(counts.size > 0
        ? [...counts].map(([label, n]) => `- ${label}: ${n}`)
        : ["- nothing"]),
    ].join("\n");

    // The marker below is NOT written on a failed send, on purpose: the next
    // update then covers this window too, so a Slack outage delays the
    // history rather than losing it.
    const sent = await postSlack(ctx, {
      text,
      subject: { kind: "hourly", hour: slackHourKey(now) },
    });
    if (!sent.ok) return;
    await ctx.runMutation(internal.tts.internalLogEvent, {
      kind: HOURLY_UPDATE_SENT,
      data: { windowStart: since, windowEnd: now },
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
const MIRROR_SOURCES = Object.entries(CODE_TODO_REPOS).map(([repo, branch]) => ({
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
