#!/usr/bin/env node
// poll-dump.mjs — poll the Slack #dump channel and submit every new human
// message to Convex as an unprepared DTS capture.
//
// Run by cron every 2 minutes (see /etc/cron.d/dts). Also runnable by hand:
//   node /opt/dts/poll-dump.mjs
//
// STATE: the ONLY local state on this box is the cursor file
// /var/lib/dts/dump-cursor, holding the Slack ts of the last captured
// message. Everything durable lives in Convex (the no-state rule). Losing
// the cursor is harmless-by-design: on the next run with no cursor we only
// look back 24 hours, so at worst the last day of #dump messages is captured
// AGAIN as duplicate todos, which Tom can simply archive. That trade
// (rare, visible, manually fixable duplication) is deliberately preferred
// over any clever server-side dedup machinery.
//
// The cursor is advanced after EVERY successful capture (not once at the
// end), so a crash mid-batch re-captures at most one message.

import fs from "node:fs";
import { loadEnv, convexFetch } from "./dts-lib.mjs";

const CURSOR_FILE = "/var/lib/dts/dump-cursor";
const FIRST_RUN_LOOKBACK_SECONDS = 24 * 3600; // no cursor -> only last 24h
const MAX_PAGES = 10; // safety bound; 10 pages x 200 msgs is far beyond a day of #dump

// --- Slack Web API helper (GET with query params + bearer token). ----------
// Slack's Web API accepts GET with URL params for these read methods; the
// bot token goes in the Authorization header, never in the URL.
async function slack(env, method, params) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  if (!res.ok) throw new Error(`slack ${method} -> HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`slack ${method} -> ${data.error}`);
  return data;
}

async function main() {
  const env = loadEnv();

  // Cursor: Slack ts (e.g. "1724750000.123456") of the last captured message.
  // conversations.history with oldest=<ts> is EXCLUSIVE of oldest by default,
  // which is exactly what we want: "everything after the last one I took".
  let cursor = null;
  try {
    cursor = fs.readFileSync(CURSOR_FILE, "utf8").trim() || null;
  } catch {
    // No cursor file — first run (or the box was rebuilt). Fall through.
  }
  // Slack ts format is "<seconds>.<6 digits>" — hand it a clean fixed-point
  // value, not a raw float print.
  const oldest =
    cursor ?? (Date.now() / 1000 - FIRST_RUN_LOOKBACK_SECONDS).toFixed(6);

  // Fetch all new messages. Slack returns them NEWEST-first and paginates via
  // response_metadata.next_cursor; we collect every page then sort ascending
  // so captures (and cursor advances) happen in chronological order. `oldest`
  // positions only the FIRST page — later pages are addressed by the page
  // cursor alone (mixing both can re-walk the same page).
  const messages = [];
  let pageCursor = undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await slack(env, "conversations.history", {
      channel: env.SLACK_DUMP_CHANNEL_ID,
      oldest: pageCursor === undefined ? oldest : undefined,
      limit: 200,
      cursor: pageCursor,
    });
    messages.push(...(data.messages ?? []));
    pageCursor = data.response_metadata?.next_cursor;
    if (!data.has_more || !pageCursor) break;
  }

  // Keep only plain human messages:
  //  - bot_id      -> posted by a bot/app (including our own digest) — skip
  //  - subtype     -> joins, edits, thread broadcasts, file comments, … — skip
  //  - empty text  -> file-only posts etc. — nothing to capture
  const human = messages
    .filter((m) => !m.bot_id && !m.subtype && m.text && m.text.trim() !== "")
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  if (human.length === 0) {
    // Nothing new. Exit 0 quietly so the every-2-minutes cron stays silent
    // in the logs when the world is idle.
    return;
  }

  for (const m of human) {
    // Provenance: a permalink lets Tom jump from a todo back to the original
    // Slack message. Best-effort — if the permalink call fails we still
    // capture, with a plain-text reference instead.
    let provenance = `slack:#dump ts=${m.ts}`;
    try {
      const link = await slack(env, "chat.getPermalink", {
        channel: env.SLACK_DUMP_CHANNEL_ID,
        message_ts: m.ts,
      });
      if (link.permalink) provenance = link.permalink;
    } catch (err) {
      console.log(`[poll-dump] permalink failed for ts=${m.ts}: ${err.message}`);
    }

    const result = await convexFetch(env, "/dts/capture", {
      statement: m.text,
      source: "slack-capture",
      provenance,
    });

    // Advance the cursor IMMEDIATELY after each successful capture, so a
    // crash between messages never re-captures more than the one in flight.
    fs.writeFileSync(CURSOR_FILE, m.ts);

    console.log(
      `[poll-dump] captured ts=${m.ts} id=${result.id ?? "?"} ` +
        `"${m.text.slice(0, 60).replace(/\s+/g, " ")}"`,
    );
  }
}

main().catch((err) => {
  // Any hard failure (env missing, Slack down, Convex rejecting) lands here.
  // Log and exit 1 — cron will simply try again in 2 minutes, and the cursor
  // guarantees we pick up exactly where we left off.
  console.error(`[poll-dump] FAILED: ${err.message}`);
  process.exit(1);
});
