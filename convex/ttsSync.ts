"use node";

import { v } from "convex/values";
import { load as loadYaml } from "js-yaml";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  TTS_DIGEST_NY_HOUR,
  countdownText,
  ttsDayKey,
  ttsItemLink,
  nyLocalHour,
  nyOffsetHours,
} from "./ttsShared";
import type { Doc } from "./_generated/dataModel";

// TTS actions that reach outside Convex: the 5 a.m. Slack digest and the
// GitHub vqc/todos.yaml mirror refresh. Spec: WikiTom tts/spec.md §7, §5.3.

const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";

// Tom 2026-08-29: outbound Slack is OFF — Slack is inbound dump only until the messaging shape is redesigned.
// One switch for every chat.postMessage site in this file. The senders and their
// composition logic stay intact (this is "off for now", not a removal); flip to
// true to turn the messages back on, and re-register the digest crons in
// convex/crons.ts. The INBOUND path (worker/jobs/poll-dump.mjs → /tts/capture)
// is untouched.
const OUTBOUND_SLACK_ENABLED: boolean = false;

// ── Daily digest (spec §7) ───────────────────────────────────────────────────
// Scheduled at two UTC times with a local-hour guard so DST needs no cron
// edits; only the run landing in the 5 a.m. New York hour proceeds, and
// digestSentAt makes it once-per-day. ALWAYS sent, even when empty
// (sends-even-when-empty rule): a missing digest means Convex/Slack breakage,
// a digest that reports missing prep means worker breakage.
// NOW OFF (see OUTBOUND_SLACK_ENABLED above): the crons are unregistered and
// this returns before anything reads, so no digest is composed or posted.
export const sendDigest = internalAction({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    // Tom 2026-08-29: outbound Slack is OFF — Slack is inbound dump only until the messaging shape is redesigned.
    if (!OUTBOUND_SLACK_ENABLED) return;
    const now = Date.now();
    if (!force && nyLocalHour(now) !== TTS_DIGEST_NY_HOUR) return;
    const day = ttsDayKey(now);
    const row = await ctx.runQuery(internal.tts.internalGetDay, { day });
    if (row?.digestSentAt && !force) return;

    const token = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.SLACK_TTS_CHANNEL_ID;
    if (!token || !channel) {
      console.error("TTS digest: SLACK_BOT_TOKEN / SLACK_TTS_CHANNEL_ID not configured");
      return;
    }

    // The full-table reads are only needed when composing the fallback text —
    // the worker-prepared happy path skips them (review finding: this is the
    // one daily payload that would otherwise grow with the never-pruned
    // archive).
    const text =
      row?.digestText ??
      composeFallbackDigest(
        day,
        row ?? null,
        await ctx.runQuery(internal.tts.internalListTodos, {}),
        now,
        await ctx.runQuery(internal.ttsRulings.internalAwaitingRulingCount, {}),
        await ctx.runQuery(internal.ttsRulings.internalWaitingOnYouCount, {}),
      );

    const res = await fetch(SLACK_POST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, text, unfurl_links: false }),
    });
    const result = (await res.json()) as { ok: boolean; error?: string };
    if (!result.ok) {
      console.error(`TTS digest: Slack rejected the post: ${result.error}`);
      return;
    }
    // Entry ids are validated at intake (internalStoreWorkerPrep) and nothing
    // is ever deleted, so the queue's ids are surfaced as-is.
    await ctx.runMutation(internal.tts.internalMarkDigestSent, {
      day,
      surfacedTodoIds: (row?.entries ?? []).map((e) => e.todoId),
    });
  },
});

// ── Session event messages (todo tts-session-needs-you-notify) ───────────────
// The OUTBOUND half of spec §7's two-way event messages: one Slack line the
// moment a session needs Tom (a permission decision) or records what it did
// (an outcome, or a failure), each carrying a deep link to the session.
//
// Same plumbing as the digest above — chat.postMessage with SLACK_BOT_TOKEN,
// posting to SLACK_TTS_CHANNEL_ID. Missing env is log-and-return, following
// the sanctioned ruling `digest-env-missing-is-quiet` (vqc/adoption.md,
// 2026-08-27): a scheduled job that throws adds no louder channel than the
// console line, and the session surface in the browser carries the same facts
// regardless of whether Slack was reachable.
//
// The CALLERS decide when to send (convex/claudeSessions.ts schedules this on
// edge-triggered transitions only, so a session that polls for an hour while
// blocked still produces exactly one message). Nothing here dedupes.
export const internalSessionEventMessage = internalAction({
  args: { sessionId: v.string(), text: v.string() },
  handler: async (_ctx, { sessionId, text }) => {
    // Tom 2026-08-29: outbound Slack is OFF — Slack is inbound dump only until the messaging shape is redesigned.
    // Callers still SCHEDULE this action on their edge transitions (the trigger
    // wiring is what the tests cover); it just posts nothing.
    if (!OUTBOUND_SLACK_ENABLED) return;
    const token = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.SLACK_TTS_CHANNEL_ID;
    if (!token || !channel) {
      console.error(
        "TTS session event: SLACK_BOT_TOKEN / SLACK_TTS_CHANNEL_ID not configured",
      );
      return;
    }
    // The link is the point: the message says what happened, the URL is where
    // to act on it.
    const body = `${text}\nhttps://www.tom.quest/sessions?session=${sessionId}`;
    const res = await fetch(SLACK_POST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, text: body, unfurl_links: false }),
    });
    const result = (await res.json()) as { ok: boolean; error?: string };
    if (!result.ok) {
      console.error(`TTS session event: Slack rejected the post: ${result.error}`);
    }
  },
});

function composeFallbackDigest(
  day: string,
  row: Doc<"dtsDailyQueues"> | null,
  todos: Doc<"dtsTodos">[],
  now: number,
  awaitingRulingCount: number,
  waitingOnYouCount: number,
): string {
  const byId = new Map(todos.map((t) => [t._id, t]));
  const lines: string[] = [`*TTS digest — ${day}*`];

  const active = todos.filter((t) => t.status === "active");
  const dated = active
    .filter((t) => t.dueAt !== undefined)
    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
  if (dated.length > 0) {
    lines.push("", "*Dated:*");
    for (const t of dated) {
      lines.push(
        `• <${ttsItemLink(t._id)}|${t.statement}> — ${countdownText(t.dueAt ?? now, now)}`,
      );
    }
  }

  const queueTodos = (row?.entries ?? []).flatMap((e) => {
    const todo = byId.get(e.todoId);
    // Dated items are already listed above.
    return todo && todo.dueAt === undefined ? [{ todo, reason: e.reason }] : [];
  });
  if (queueTodos.length > 0) {
    // Explicit ?tab=calendar — bare /tts lands on the batches tab (default).
    lines.push(
      "",
      "*Today's queue* (also on <https://tom.quest/tts?tab=calendar|the calendar tab>):",
    );
    for (const { todo, reason } of queueTodos) {
      // Every reminder carries its entry action (spec §9) and a direct link.
      const entry = todo.entryAction ? ` — ${todo.entryAction}` : "";
      lines.push(
        `• <${ttsItemLink(todo._id)}|${todo.statement}>${entry}${reason ? ` _(${reason})_` : ""}`,
      );
    }
  }

  // Tom-gate items surface on the batches tab (the /tts default tab), where
  // they sit as batches awaiting a ruling or as unbatched singletons.
  //
  // THIS FUNCTION NO LONGER DECIDES WHAT COUNTS. The number arrives already
  // computed from internalWaitingOnYouCount (convex/ttsRulings.ts), which is
  // the one definition of the phrase "Waiting on you" — the same query GET
  // /tts/state hands the worker's prep job, so the digest Tom reads says the
  // same number whether the worker wrote it or this fallback did. An inline
  // filter used to live here and omitted the live-ruling freshness test, so it
  // counted todos Tom had already ruled on.
  if (waitingOnYouCount > 0) {
    lines.push(
      "",
      `*Waiting on you:* ${waitingOnYouCount} item${waitingOnYouCount === 1 ? "" : "s"} at a tom-gate — <https://tom.quest/tts|the batches tab>`,
    );
  }
  // Briefed code todos with no ruling yet sit next to the tom-gate line — the
  // same "waiting on you" area, descriptive, no verdicts; same batches-tab
  // landing (bare /tts defaults there).
  if (awaitingRulingCount > 0) {
    lines.push(
      "",
      `*Code rulings:* ${awaitingRulingCount} briefed item${awaitingRulingCount === 1 ? "" : "s"} awaiting your ruling — <https://tom.quest/tts|the batches tab>`,
    );
  }

  if (
    dated.length === 0 &&
    queueTodos.length === 0 &&
    waitingOnYouCount === 0 &&
    awaitingRulingCount === 0
  ) {
    lines.push("", "Nothing today.");
  }

  const note =
    row === null
      ? "_Queue prep did not run — this is the bare fallback digest (worker + fallback both missed)._"
      : row.preparedBy === "fallback"
        ? "_Queue prepared by fallback rules (no worker prep arrived)._"
        : null;
  if (note) lines.push("", note);
  return lines.join("\n");
}

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
// ITS OWN SWITCH, deliberately not OUTBOUND_SLACK_ENABLED: Tom turned the 5 a.m.
// digest off and this is a different message with a different ruling behind it,
// so turning one on must not turn the other on.
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

function hhmm(at: number): string {
  const offset = nyOffsetHours(at);
  const d = new Date(at + offset * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(
    d.getUTCMinutes(),
  ).padStart(2, "0")}`;
}

export const sendHourlyUpdate = internalAction({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (!HOURLY_UPDATE_ENABLED && !force) return;
    const now = Date.now();

    const token = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.SLACK_TTS_CHANNEL_ID;
    if (!token || !channel) {
      // Sanctioned log-and-return (ruling digest-env-missing-is-quiet): a cron
      // that throws adds no louder channel than this line, and the missing
      // message is itself the signal.
      console.error(
        "TTS hourly update: SLACK_BOT_TOKEN / SLACK_TTS_CHANNEL_ID not configured",
      );
      return;
    }

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
          `- ${hhmm(b.start)}–${hhmm(b.end)} ${
            b.statement ?? b.category ?? b.note ?? "block"
          }`,
      ),
      ...events.map((e) => `- ${hhmm(e.start)}–${hhmm(e.end)} ${e.title}`),
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
      `*TTS — ${hhmm(now)}*`,
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
      `*Since ${hhmm(since)}*`,
      ...(counts.size > 0
        ? [...counts].map(([label, n]) => `- ${label}: ${n}`)
        : ["- nothing"]),
    ].join("\n");

    const res = await fetch(SLACK_POST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, text, unfurl_links: false }),
    });
    const result = (await res.json()) as { ok: boolean; error?: string };
    if (!result.ok) {
      // The marker is NOT written on a failed send, on purpose: the next
      // update then covers this window too, so a Slack outage delays the
      // history rather than losing it.
      console.error(`TTS hourly update: Slack rejected the post: ${result.error}`);
      return;
    }
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
const MIRROR_SOURCES = [
  { repo: "ComplexMultiTrigger", branch: "master" },
  { repo: "tom.quest", branch: "main" },
];

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
          `https://api.github.com/repos/Heffnt/${repo}/contents/vqc/todos.yaml?ref=${branch}`,
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
        const url = `https://github.com/Heffnt/${repo}/blob/${branch}/vqc/todos.yaml`;
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
