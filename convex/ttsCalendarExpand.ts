"use node";
// ICS text → concrete calendar occurrences, for the TTS calendar mirror
// (schema: ttsCalendarEvents). Pure functions — the fetch action
// (convex/ttsCalendarFetch.ts) calls expandIcsText and the tests exercise it
// on fixture ICS text directly.
//
// Parsing and recurrence math are node-ical's (its expandRecurringEvent
// handles RRULE expansion, EXDATE exclusions, and RECURRENCE-ID overrides,
// with timezones resolved internally via rrule-temporal). What this module
// adds is the mapping to rows:
//   - timed events: real epoch instants, straight from the expansion.
//   - all-day events: node-ical hands back HOST-local midnights built from
//     calendar components; we read the calendar date back out of the local
//     getters (host-timezone-independent, since that is how they were built)
//     and anchor it to America/New_York midnight, where Tom's days live.

import ical from "node-ical";
import { normalDayBoundsUtc, DAY_MS } from "./ttsShared";

export type ExpandedEvent = {
  uid: string;
  title: string;
  start: number; // epoch ms
  end: number; // epoch ms, >= start
  allDay: boolean;
  location?: string;
};

/** Cap per feed — bounds the replace-mutation payload. Sorted by start, so an
 * overflowing feed loses its far tail, not near events. */
export const MAX_EVENTS_PER_FEED = 1500;

// node-ical text fields are usually strings but arrive as { params, val }
// when the ICS property carried parameters (e.g. SUMMARY;LANGUAGE=en:…).
function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "val" in value) {
    const v = (value as { val: unknown }).val;
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** Calendar date of a component-built local-midnight Date, via local getters. */
function localDayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Expand one feed's ICS text into concrete occurrences overlapping
 * [windowStartMs, windowEndMs). One malformed VEVENT is skipped, never the
 * whole feed.
 */
export function expandIcsText(
  icsText: string,
  windowStartMs: number,
  windowEndMs: number,
): ExpandedEvent[] {
  const parsed = ical.sync.parseICS(icsText);
  const from = new Date(windowStartMs);
  const to = new Date(windowEndMs);
  const out: ExpandedEvent[] = [];
  const seen = new Set<string>();

  for (const key of Object.keys(parsed)) {
    const ev = parsed[key] as Record<string, unknown> & {
      type?: string;
      uid?: string;
      recurrenceid?: unknown;
    };
    if (!ev || ev.type !== "VEVENT") continue;
    // A RECURRENCE-ID row is an override of some parent series; the parent's
    // expansion emits it. Expanding it standalone would double-count it.
    if (ev.recurrenceid !== undefined) continue;

    let instances: Array<{
      start: Date;
      end: Date;
      isFullDay: boolean;
      event?: Record<string, unknown>;
    }>;
    try {
      instances = ical.expandRecurringEvent(
        ev as never,
        // expandOngoing: an event straddling the window edge still counts as
        // schedule knowledge for the days inside the window.
        { from, to, expandOngoing: true },
      ) as never;
    } catch {
      continue;
    }

    const uid = typeof ev.uid === "string" ? ev.uid : key;
    for (const inst of instances) {
      const title =
        textOf(inst.event?.summary) ?? textOf(ev.summary) ?? "(untitled)";
      const location = textOf(inst.event?.location) ?? textOf(ev.location);
      let start: number;
      let end: number;
      if (inst.isFullDay) {
        start = normalDayBoundsUtc(localDayKey(inst.start)).start;
        // DTEND on all-day events is EXCLUSIVE; a one-day event's end Date is
        // already the next local midnight (node-ical applies the day span).
        end = Math.max(
          normalDayBoundsUtc(localDayKey(inst.end)).start,
          start + DAY_MS,
        );
      } else {
        start = inst.start.getTime();
        end = Math.max(inst.end.getTime(), start);
      }
      const dedupeKey = `${uid}#${start}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({ uid, title, start, end, allDay: inst.isFullDay, location });
    }
  }

  out.sort((a, b) => a.start - b.start);
  return out.slice(0, MAX_EVENTS_PER_FEED);
}
