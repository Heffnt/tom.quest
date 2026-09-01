#!/usr/bin/env node
// poll-dump.mjs — the RECONCILIATION BACKSTOP behind the Slack push route.
// It polls the Slack #dump channel and offers every new human message to
// Convex as an unprepared TTS capture.
//
// NOT the fast path anymore. Tom ruled 2026-08-30 that Slack PUSHES each
// #dump message to Convex at POST /slack/events, which captures it about a
// second after it is typed. This job stays because Slack's event delivery is
// best-effort, not guaranteed: an event Slack drops, or one that arrives while
// Convex is unreachable, exists nowhere else. So this is the slower loop whose
// only job is to notice what the fast path dropped.
//
// Run by cron HOURLY (see /etc/cron.d/tts). Also runnable by hand:
//   node /opt/tts/poll-dump.mjs
//
// STATE: the ONLY local state on the Jarvis Box is the cursor file
// /var/lib/tts/dump-cursor, holding the Slack ts of the last message this job
// offered. Everything durable lives in Convex (the no-state rule). The cursor
// advances on messages THIS job files, so it lags behind the push route and
// this job re-offers what the push route already took — which is fine and
// intended, because captures are idempotent on the Slack message ts server-side
// (convex/tts.ts internalCapture, index by_slackTs). The server returns the
// existing todo and reports duplicate: true; nothing is minted twice.
//
// That same guard is what makes losing the cursor a non-event: with no cursor
// we look back 24 hours and re-offer that whole day, and every message already
// captured is refused. (Before the dedupe guard existed this produced a day of
// duplicate todos Tom archived by hand.)
//
// The cursor is advanced after EVERY successful offer (not once at the end),
// so a crash mid-batch re-offers at most one message.

import fs from "node:fs";
import { spawn } from "node:child_process";
import { loadEnv, convexFetch, slackGet } from "./tts-lib.mjs";

const CURSOR_FILE = "/var/lib/tts/dump-cursor";
const FIRST_RUN_LOOKBACK_SECONDS = 24 * 3600; // no cursor -> only last 24h
const MAX_PAGES = 10; // safety bound; 10 pages x 200 msgs is far beyond a day of #dump

// The Slack helper moved to tts-lib.mjs (slackGet / slackPost) when the
// threaded reply next door needed the POST half: one home for both verbs
// rather than this file's GET-only copy plus a second one (VQC C1).
const slack = slackGet;

// Preparation is spawned DETACHED after a run that captured something NEW, so
// a message the push route missed is prepared on this same run instead of
// waiting for the next prepare-life-todos cron tick. flock -n is what makes
// that safe: this spawn and the cron take the same lock, and whichever loses
// simply exits.
//
// HONEST LATENCY, end to end, for a message the push route DID take (the
// normal case): captured about a second after it is typed, then prepared after
// up to one 2-minute prepare-life-todos tick plus one Claude call. "Captured
// instantly, prepared within a few minutes" is the true sentence; "instant" on
// its own is not. For a message only this backstop catches, add up to an hour
// for the poll tick.
function spawnPreparation() {
  try {
    const child = spawn(
      "/usr/bin/flock",
      [
        "-n",
        "/var/lock/tts-prepare-life-todos.lock",
        "/usr/bin/node",
        "/opt/tts/prepare-life-todos.mjs",
      ],
      { detached: true, stdio: "ignore" },
    );
    // Unref so this job exits without waiting on a Claude call that can run
    // for minutes; the child keeps running under init.
    child.unref();
  } catch (err) {
    // Never fatal: the capture already landed, and the cron tick prepares it
    // shortly regardless. Losing the speed-up is not losing the work.
    console.log(`[poll-dump] could not spawn preparation: ${err.message}`);
  }
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
    // No cursor file — first run (or the Jarvis Box was rebuilt). Fall through.
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
    // Nothing new. Exit 0 quietly so the hourly cron stays silent in the logs
    // when the world is idle.
    return;
  }

  // How many of this run's offers the server actually turned into todos. In
  // the healthy state this is ZERO on almost every run: the push route got
  // there first and every offer below is refused as a duplicate. A run with a
  // non-zero count is this job doing the one thing it exists for — catching an
  // event Slack never delivered.
  let captured = 0;

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

    const result = await convexFetch(env, "/tts/capture", {
      statement: m.text,
      source: "slack-capture",
      provenance,
      // The coordinates the threaded reply is addressed to. Also the dedupe
      // key: this job is now the BACKSTOP behind the /slack/events push route,
      // so it re-offers messages the push route already captured, and the
      // server returns the existing todo instead of minting a second one.
      slackChannel: env.SLACK_DUMP_CHANNEL_ID,
      slackTs: m.ts,
    });

    // Advance the cursor IMMEDIATELY after each successful offer, so a crash
    // between messages never re-offers more than the one in flight.
    fs.writeFileSync(CURSOR_FILE, m.ts);

    const excerpt = `"${m.text.slice(0, 60).replace(/\s+/g, " ")}"`;
    if (result.duplicate) {
      // The normal, healthy line: the push route already captured this
      // message and the server refused a second one. Logged rather than
      // silent because these two lines are how the log says which path is
      // doing the work.
      console.log(
        `[poll-dump] duplicate refused ts=${m.ts} id=${result.id ?? "?"} ` +
          `(already captured by /slack/events) ${excerpt}`,
      );
    } else {
      captured += 1;
      console.log(
        `[poll-dump] captured ts=${m.ts} id=${result.id ?? "?"} ` +
          `(push route missed it) ${excerpt}`,
      );
    }
  }

  // One spawn for the whole run, not one per message: preparation processes a
  // batch, so a second overlapping run would only lose its lock and exit.
  //
  // Only when something NEW landed. A run that refused every offer as a
  // duplicate has created no unprepared todo, and the push route's own
  // captures are already served by the prepare-life-todos cron tick.
  if (captured > 0) spawnPreparation();
}

main().catch((err) => {
  // Any hard failure (env missing, Slack down, Convex rejecting) lands here.
  // Log and exit 1 — cron will simply try again next hour, and the cursor
  // guarantees we pick up exactly where we left off.
  console.error(`[poll-dump] FAILED: ${err.message}`);
  process.exit(1);
});
