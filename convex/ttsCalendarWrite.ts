// The ONE write door to Tom's Google Calendar (ruled 2026-08-31: "we need to
// automate this so that you and tom.quest sessions can add things to my
// calendar"). Every surface goes through internalCreateEvent:
//   - interactive Claude sessions on Tom's machine: `npx convex run
//     ttsCalendarWrite:internalCreateEvent '<json>'` (deploy credentials —
//     a pen, used while Tom is present or on his instruction)
//   - Jarvis Box jobs and sessions: POST /tts/calendar-event (TTS_WORKER_KEY)
// Credentials (Convex env): GOOGLE_CALENDAR_CLIENT_ID / _CLIENT_SECRET /
// _REFRESH_TOKEN — minted once by Tom with worker/jobs/calendar-auth.mjs,
// scope calendar.events only (event CRUD, no calendar admin). Deliberately a
// SEPARATE token from the Gmail one: one leaked credential must not open the
// other surface.
//
// Every creation is logged to dtsEvents (kind "calendar-event-created") and a
// mirror refresh is scheduled, so the new event shows on /tts within the ICS
// feed's own propagation delay rather than waiting for the hourly cron.

import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { logEvent } from "./tts";

export type CreateEventArgs = {
  title: string;
  start: number; // epoch ms
  end: number; // epoch ms, > start
  description?: string;
  location?: string;
  // Raw iCalendar recurrence lines, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"].
  // Expanded by Google in the event's time zone (America/New_York).
  recurrence?: string[];
  calendarId?: string; // default "primary" (Tom's own calendar)
};

/** Pure request-body builder — exported for tests. */
export function buildEventBody(args: CreateEventArgs) {
  if (args.title.trim() === "") throw new Error("title is required");
  if (!(args.end > args.start)) throw new Error("end must be after start");
  return {
    summary: args.title.trim(),
    description: args.description,
    location: args.location,
    start: {
      dateTime: new Date(args.start).toISOString(),
      timeZone: "America/New_York",
    },
    end: {
      dateTime: new Date(args.end).toISOString(),
      timeZone: "America/New_York",
    },
    recurrence: args.recurrence,
  };
}

export const internalCreateEvent = internalAction({
  args: {
    title: v.string(),
    start: v.number(),
    end: v.number(),
    description: v.optional(v.string()),
    location: v.optional(v.string()),
    recurrence: v.optional(v.array(v.string())),
    calendarId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ id: string; htmlLink: string }> => {
    const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        "Calendar write is not configured — GOOGLE_CALENDAR_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN missing from the Convex env (mint them with worker/jobs/calendar-auth.mjs)",
      );
    }

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!tokenRes.ok) {
      throw new Error(
        `calendar token refresh -> HTTP ${tokenRes.status}: ${(await tokenRes.text()).slice(0, 200)}`,
      );
    }
    const accessToken = (await tokenRes.json()).access_token as string;

    const calendarId = args.calendarId ?? "primary";
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildEventBody(args)),
      },
    );
    if (!res.ok) {
      throw new Error(
        `calendar insert -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }
    const created = (await res.json()) as { id: string; htmlLink: string };

    await ctx.runMutation(internal.ttsCalendarWrite.internalLogCreated, {
      title: args.title,
      start: args.start,
      end: args.end,
      recurring: (args.recurrence?.length ?? 0) > 0,
      htmlLink: created.htmlLink,
    });
    // The mirror learns about the event through the ICS feed; refresh now so
    // it appears as soon as Google's feed serves it, not at the next hour.
    await ctx.scheduler.runAfter(0, internal.ttsCalendarFetch.refreshFeeds, {});
    return { id: created.id, htmlLink: created.htmlLink };
  },
});

// Transparency record (spec §10): every write to Tom's calendar leaves a
// dtsEvents row, whoever made it and whyever.
export const internalLogCreated = internalMutation({
  args: {
    title: v.string(),
    start: v.number(),
    end: v.number(),
    recurring: v.boolean(),
    htmlLink: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await logEvent(ctx, "calendar-event-created", undefined, args);
  },
});
