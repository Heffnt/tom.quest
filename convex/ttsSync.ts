"use node";

import { v } from "convex/values";
import { load as loadYaml } from "js-yaml";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  TTS_DIGEST_NY_HOUR,
  countdownText,
  tomDayKey,
  ttsItemLink,
  nyLocalHour,
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
    const day = tomDayKey(now);
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
  // A todo claimed as a member of a non-terminal batch does not count on its
  // own — the batch row is the unit awaiting the ruling (mirrors selectBatches
  // client-side); the batch row itself still counts.
  const claimed = new Set<string>();
  for (const t of todos) {
    if (t.members === undefined) continue;
    if (t.status !== "active" && t.status !== "waiting") continue;
    for (const m of t.members) {
      if (m.todoId !== undefined) claimed.add(m.todoId);
    }
  }
  const atGate = todos.filter(
    (t) =>
      t.status === "active" &&
      t.readiness === "ready-for-tom" &&
      !claimed.has(t._id),
  );
  if (atGate.length > 0) {
    lines.push(
      "",
      `*Waiting on you:* ${atGate.length} item${atGate.length === 1 ? "" : "s"} at a tom-gate — <https://tom.quest/tts|the batches tab>`,
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
    atGate.length === 0 &&
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
