// TTS calendar mirror — the default-runtime half of the ICS ingestion.
// The fetching/parsing half lives in convex/ttsCalendarFetch.ts ("use node",
// because ICS parsing uses the node-ical package); it calls
// internalReplaceFeed here with already-expanded concrete occurrences.
// Schema comments on ttsCalendarEvents (convex/schema.ts) carry the design:
// this table is read-only mirror state of Tom's external calendars, replaced
// per feed on every sync, the way dtsCodeTodoMirror is replaced per repo.

import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireTom } from "./authRoles";

/** One expanded occurrence, as the fetch action hands it over. */
export const CALENDAR_EVENT_INPUT = v.object({
  uid: v.string(),
  title: v.string(),
  start: v.number(),
  end: v.number(),
  allDay: v.boolean(),
  location: v.optional(v.string()),
});

// Events the calendar tab shows for a visible range (the dtsBlocks
// listBlocks contract: [start, end) overlap).
export const listCalendarEvents = query({
  args: { start: v.number(), end: v.number() },
  handler: async (ctx, { start, end }) => {
    await requireTom(ctx, "TTS");
    // by_start serves "starts before the range ends"; the >-start overlap
    // filter runs on that bounded set. Multi-day events longer than 31 days
    // would escape the lower bound — personal calendars don't carry those,
    // and an all-day multi-week event still lands via its own start row.
    const rows = await ctx.db
      .query("ttsCalendarEvents")
      .withIndex("by_start", (q) =>
        q.gte("start", start - 31 * 86_400_000).lt("start", end),
      )
      .collect();
    return rows.filter((e) => e.end > start);
  },
});

// The worker-facing twin of listCalendarEvents (the /tts/state route hands
// the prep job the coming week's events as schedule knowledge).
export const internalListEventsInRange = internalQuery({
  args: { start: v.number(), end: v.number() },
  handler: async (ctx, { start, end }) => {
    const rows = await ctx.db
      .query("ttsCalendarEvents")
      .withIndex("by_start", (q) =>
        q.gte("start", start - 31 * 86_400_000).lt("start", end),
      )
      .collect();
    return rows.filter((e) => e.end > start);
  },
});

// Replace one feed's mirror rows wholesale. The external calendar is the
// system of record; a vanished event vanishes here too (mirror semantics —
// nothing-ever-lost governs todos, and no todo rows live in this table).
export const internalReplaceFeed = internalMutation({
  args: {
    feed: v.string(),
    events: v.array(CALENDAR_EVENT_INPUT),
  },
  handler: async (ctx, { feed, events }) => {
    const existing = await ctx.db
      .query("ttsCalendarEvents")
      .withIndex("by_feed", (q) => q.eq("feed", feed))
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);
    const now = Date.now();
    for (const event of events) {
      await ctx.db.insert("ttsCalendarEvents", {
        feed,
        ...event,
        syncedAt: now,
      });
    }
    return { feed, replaced: existing.length, inserted: events.length };
  },
});
