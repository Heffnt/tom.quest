"use node";
// The fetching half of the TTS calendar mirror (hourly cron). Reads the
// Convex env var TTS_ICS_FEEDS — JSON like
//   [{"name":"google","url":"https://calendar.google.com/calendar/ical/…/basic.ics"},
//    {"name":"outlook","url":"https://outlook.office365.com/owa/calendar/…/calendar.ics"}]
// — fetches each ICS feed, expands it to concrete occurrences
// (convex/ttsCalendarExpand.ts), and replaces that feed's mirror rows
// (convex/ttsCalendar.ts internalReplaceFeed).
//
// Failure honesty: a feed that fails to fetch or parse KEEPS its last good
// rows — stale schedule knowledge beats a blank calendar that reads as "free
// all day". The error is logged and returned; the next hourly run retries.

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { expandIcsText } from "./ttsCalendarExpand";
import { DAY_MS } from "./ttsShared";

/** The sync window: recent past for context, two months ahead for planning. */
const WINDOW_PAST_DAYS = 7;
const WINDOW_FUTURE_DAYS = 60;

type FeedConfig = { name: string; url: string };

function parseFeedConfig(raw: string): FeedConfig[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("TTS_ICS_FEEDS must be a JSON array");
  return parsed.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    if (typeof e?.name !== "string" || typeof e?.url !== "string") {
      throw new Error(`TTS_ICS_FEEDS[${i}] needs {name, url}`);
    }
    return { name: e.name, url: e.url };
  });
}

export const refreshFeeds = internalAction({
  args: {},
  handler: async (ctx) => {
    const raw = process.env.TTS_ICS_FEEDS;
    if (!raw || raw.trim() === "") {
      // Not configured yet — a quiet no-op, so the cron ships ahead of the
      // env var the way the mirror crons do.
      return { skipped: "TTS_ICS_FEEDS not set" };
    }
    const feeds = parseFeedConfig(raw);
    const now = Date.now();
    const windowStart = now - WINDOW_PAST_DAYS * DAY_MS;
    const windowEnd = now + WINDOW_FUTURE_DAYS * DAY_MS;

    const results: Array<Record<string, unknown>> = [];
    for (const feed of feeds) {
      try {
        const res = await fetch(feed.url, { redirect: "follow" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const events = expandIcsText(text, windowStart, windowEnd);
        const result = await ctx.runMutation(
          internal.ttsCalendar.internalReplaceFeed,
          { feed: feed.name, events },
        );
        results.push(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`calendar feed "${feed.name}" failed: ${message}`);
        results.push({ feed: feed.name, error: message });
      }
    }
    return { results };
  },
});
