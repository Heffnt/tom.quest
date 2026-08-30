#!/usr/bin/env node
// poll-dump.mjs — poll the Slack #dump channel and submit every new human
// message to Convex as an unprepared TTS capture.
//
// Run by cron every 2 minutes (see /etc/cron.d/tts). Also runnable by hand:
//   node /opt/tts/poll-dump.mjs
//
// HAND-OFF (Tom's ruling 2026-08-30): a run that captured anything kicks off
// prepare-life-todos.mjs in the background before exiting, so the message is
// prepared — and answered in its own Slack thread — on this tick instead of
// the next 2-minute one. See spawnPreparer below.
//
// STATE: the ONLY local state on the Jarvis Box is the cursor file
// /var/lib/tts/dump-cursor, holding the Slack ts of the last captured
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
import { spawn } from "node:child_process";
import { loadEnv, convexFetch, slackGet } from "./tts-lib.mjs";

const CURSOR_FILE = "/var/lib/tts/dump-cursor";
const FIRST_RUN_LOOKBACK_SECONDS = 24 * 3600; // no cursor -> only last 24h
const MAX_PAGES = 10; // safety bound; 10 pages x 200 msgs is far beyond a day of #dump

// The preparer this job hands off to, and the lock they share. Identical to
// the cron line in worker/setup.sh — same lock path, same binary, same script
// — so the two entry points can never run two preparers at once.
const PREPARE_LOCK = "/var/lock/tts-prepare-life-todos.lock";
const PREPARE_SCRIPT = "/opt/tts/prepare-life-todos.mjs";
const PREPARE_LOG = "/var/log/tts/prepare-life-todos.log";

// Start the preparer NOW, in the background, and return immediately.
//
// WHY (Tom's ruling 2026-08-30): a #dump message gets a threaded Slack reply
// saying how TTS read it, and that reply is written by prepare-life-todos.mjs.
// Cron runs that job every 2 minutes anyway; kicking it off here removes the
// wait for the next tick, so the usual path is captured-prepared-replied
// within one poll of this job.
//
// HONEST LATENCY: this is not "immediate". A message waits up to one poll tick
// of THIS job (<= 2 minutes) to be noticed at all, and preparation then costs
// one headless Claude call. Same tick, not same second.
//
// DETACHED, so this job exits as soon as its captures are filed rather than
// holding a cron slot open for the length of a Claude call. flock -n means a
// preparer already running (from cron, or from a previous poll) makes this a
// no-op: the spawned flock exits non-zero, having started nothing, and that
// run will pick up the todos just captured or the next tick will.
function spawnPreparer() {
  // Append to the same log cron writes, so both entry points leave one
  // readable trail. A hand-run of this job as a non-root user cannot open that
  // file — discard the output rather than failing the capture that succeeded.
  let stdio = "ignore";
  try {
    const fd = fs.openSync(PREPARE_LOG, "a");
    stdio = ["ignore", fd, fd];
  } catch {
    // not writable here — run silently
  }
  try {
    const child = spawn(
      "/usr/bin/flock",
      ["-n", PREPARE_LOCK, "/usr/bin/node", PREPARE_SCRIPT],
      { detached: true, stdio },
    );
    // Do not let the spawn's failure to launch (flock missing, script absent)
    // kill this process: captures are already durable in Convex, and cron will
    // prepare them within two minutes regardless.
    child.on("error", (err) =>
      console.error(`[poll-dump] preparer spawn failed: ${err.message}`),
    );
    child.unref();
    console.log("[poll-dump] preparer kicked off");
  } catch (err) {
    console.error(`[poll-dump] preparer spawn failed: ${err.message}`);
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
    const data = await slackGet(env, "conversations.history", {
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

  // Counted so the hand-off below fires once per run and only when this run
  // actually put something in front of the preparer.
  let captured = 0;
  try {
    for (const m of human) {
      // Provenance: a permalink lets Tom jump from a todo back to the original
      // Slack message. Best-effort — if the permalink call fails we still
      // capture, with a plain-text reference instead.
      let provenance = `slack:#dump ts=${m.ts}`;
      try {
        const link = await slackGet(env, "chat.getPermalink", {
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
        // The coordinates of THIS message, so the preparer can reply in its
        // thread (Tom's ruling 2026-08-30). Machine facts, kept apart from
        // `provenance` above, which is the line Tom reads. m.ts doubles as the
        // thread_ts of a reply to the message.
        slackChannel: env.SLACK_DUMP_CHANNEL_ID,
        slackTs: m.ts,
      });

      // Advance the cursor IMMEDIATELY after each successful capture, so a
      // crash between messages never re-captures more than the one in flight.
      fs.writeFileSync(CURSOR_FILE, m.ts);
      captured++;

      console.log(
        `[poll-dump] captured ts=${m.ts} id=${result.id ?? "?"} ` +
          `"${m.text.slice(0, 60).replace(/\s+/g, " ")}"`,
      );
    }
  } finally {
    // ONE hand-off per run, after the loop rather than per message: the
    // preparer reads every unprepared todo in one pass, and flock would
    // collapse per-message spawns into this same single run anyway.
    //
    // In a `finally` because a message that fails partway through the loop
    // must not strand the ones already captured — those rows are durable and
    // deserve preparing on this tick, not in two minutes.
    if (captured > 0) spawnPreparer();
  }
}

main().catch((err) => {
  // Any hard failure (env missing, Slack down, Convex rejecting) lands here.
  // Log and exit 1 — cron will simply try again in 2 minutes, and the cursor
  // guarantees we pick up exactly where we left off.
  console.error(`[poll-dump] FAILED: ${err.message}`);
  process.exit(1);
});
