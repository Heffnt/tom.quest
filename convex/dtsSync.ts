"use node";

import { v } from "convex/values";
import { load as loadYaml } from "js-yaml";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  DTS_DIGEST_NY_HOUR,
  countdownText,
  dtsDayKey,
  dtsItemLink,
  nyLocalHour,
} from "./dtsShared";
import type { Doc } from "./_generated/dataModel";

// DTS actions that reach outside Convex: the 5 a.m. Slack digest and the
// GitHub vqc/todos.yaml mirror refresh. Spec: WikiTom dts/spec.md §7, §5.3.

const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";

// ── Daily digest (spec §7) ───────────────────────────────────────────────────
// Scheduled at two UTC times with a local-hour guard so DST needs no cron
// edits; only the run landing in the 5 a.m. New York hour proceeds, and
// digestSentAt makes it once-per-day. ALWAYS sends, even when empty
// (sends-even-when-empty rule): a missing digest means Convex/Slack breakage,
// a digest that reports missing prep means worker breakage.
export const sendDigest = internalAction({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    const now = Date.now();
    if (!force && nyLocalHour(now) !== DTS_DIGEST_NY_HOUR) return;
    const day = dtsDayKey(now);
    const row = await ctx.runQuery(internal.dts.internalGetDay, { day });
    if (row?.digestSentAt && !force) return;

    const token = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.SLACK_DTS_CHANNEL_ID;
    if (!token || !channel) {
      console.error("DTS digest: SLACK_BOT_TOKEN / SLACK_DTS_CHANNEL_ID not configured");
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
        await ctx.runQuery(internal.dts.internalListTodos, {}),
        now,
        await ctx.runQuery(internal.dtsRulings.internalAwaitingRulingCount, {}),
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
      console.error(`DTS digest: Slack rejected the post: ${result.error}`);
      return;
    }
    // Entry ids are validated at intake (internalStoreWorkerPrep) and nothing
    // is ever deleted, so the queue's ids are surfaced as-is.
    await ctx.runMutation(internal.dts.internalMarkDigestSent, {
      day,
      surfacedTodoIds: (row?.entries ?? []).map((e) => e.todoId),
    });
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
  const lines: string[] = [`*DTS digest — ${day}*`];

  const active = todos.filter((t) => t.status === "active");
  const dated = active
    .filter((t) => t.dueAt !== undefined)
    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
  if (dated.length > 0) {
    lines.push("", "*Dated:*");
    for (const t of dated) {
      lines.push(
        `• <${dtsItemLink(t._id)}|${t.statement}> — ${countdownText(t.dueAt ?? now, now)}`,
      );
    }
  }

  const queueTodos = (row?.entries ?? []).flatMap((e) => {
    const todo = byId.get(e.todoId);
    // Dated items are already listed above.
    return todo && todo.dueAt === undefined ? [{ todo, reason: e.reason }] : [];
  });
  if (queueTodos.length > 0) {
    // Explicit ?tab=calendar — bare /dts lands on the batches tab (default).
    lines.push(
      "",
      "*Today's queue* (also on <https://tom.quest/dts?tab=calendar|the calendar tab>):",
    );
    for (const { todo, reason } of queueTodos) {
      // Every reminder carries its entry action (spec §9) and a direct link.
      const entry = todo.entryAction ? ` — ${todo.entryAction}` : "";
      lines.push(
        `• <${dtsItemLink(todo._id)}|${todo.statement}>${entry}${reason ? ` _(${reason})_` : ""}`,
      );
    }
  }

  // Tom-gate items surface on the batches tab (the /dts default tab), where
  // they sit as batches awaiting a ruling or as unbatched singletons.
  const atGate = todos.filter(
    (t) => t.status === "active" && t.readiness === "ready-for-tom",
  );
  if (atGate.length > 0) {
    lines.push(
      "",
      `*Waiting on you:* ${atGate.length} item${atGate.length === 1 ? "" : "s"} at a tom-gate — <https://tom.quest/dts|the batches tab>`,
    );
  }
  // Briefed code todos with no ruling yet sit next to the tom-gate line — the
  // same "waiting on you" area, descriptive, no verdicts; same batches-tab
  // landing (bare /dts defaults there).
  if (awaitingRulingCount > 0) {
    lines.push(
      "",
      `*Code rulings:* ${awaitingRulingCount} briefed item${awaitingRulingCount === 1 ? "" : "s"} awaiting your ruling — <https://tom.quest/dts|the batches tab>`,
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
              "User-Agent": "dts-mirror",
            },
          },
        );
        if (res.status === 404) continue; // repo has no vqc file (yet)
        if (!res.ok) {
          console.error(`DTS mirror: ${repo} fetch failed (${res.status})`);
          continue;
        }
        const parsed = loadYaml(await res.text());
        if (!Array.isArray(parsed)) {
          console.error(`DTS mirror: ${repo} vqc/todos.yaml is not a list`);
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
            `DTS mirror: ${repo} vqc/todos.yaml parsed to 0 entries from ${parsed.length} list items — format change? Mirror left untouched.`,
          );
          continue;
        }
        await ctx.runMutation(internal.dts.internalReplaceMirror, { repo, rows });
      } catch (err) {
        console.error(
          `DTS mirror: ${repo} refresh error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  },
});
