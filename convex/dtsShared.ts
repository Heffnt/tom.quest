// DTS time helpers — the 5 a.m. America/New_York day boundary (spec §7).
// Implemented without Intl so behavior is identical in the Convex runtime,
// Node (worker box), and the browser. US DST rules: clocks spring forward at
// 2:00 EST (07:00 UTC) on the second Sunday of March and fall back at 2:00 EDT
// (06:00 UTC) on the first Sunday of November.
//
// THE THREE DAY QUESTIONS (they have different answers before 5 a.m. — mixing
// them up was this module's original sin, caught in review):
//   dtsDayKey(now)      "which DTS day is it right now?"   2 a.m. → yesterday.
//   dtsPrepDay(now)     "which day is a prep run building?" the day of the NEXT
//                       digest — at 4:30 a.m. that's the day STARTING at 5.
//   nyCalendarDayKey(t) "what calendar date is this instant, on a NY clock?"
//                       used for due-date arithmetic, where '2 a.m. belongs to
//                       yesterday' would be wrong.

const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

// The scheduling anchors (single source of truth for the guard hours; the UTC
// cron times in convex/crons.ts and worker/setup.sh are derived as hour+4
// (EDT) and hour+5 (EST) and say so in their comments).
export const DTS_PREP_NY_HOUR = 4; // prep jobs run in the 4 a.m. hour
export const DTS_DIGEST_NY_HOUR = 5; // the digest sends at 5 — the day boundary

function nthSundayUtcMs(year: number, monthIndex: number, n: number): number {
  const first = Date.UTC(year, monthIndex, 1);
  const firstDow = new Date(first).getUTCDay(); // 0 = Sunday
  const firstSundayDate = 1 + ((7 - firstDow) % 7);
  return Date.UTC(year, monthIndex, firstSundayDate + (n - 1) * 7);
}

/** UTC offset of America/New_York in hours (-4 in EDT, -5 in EST). */
export function nyOffsetHours(utcMs: number): number {
  const year = new Date(utcMs).getUTCFullYear();
  const springMs = nthSundayUtcMs(year, 2, 2) + 7 * HOUR_MS; // 2:00 EST
  const fallMs = nthSundayUtcMs(year, 10, 1) + 6 * HOUR_MS; // 2:00 EDT
  return utcMs >= springMs && utcMs < fallMs ? -4 : -5;
}

/** Local wall-clock hour (0-23) in America/New_York. */
export function nyLocalHour(utcMs: number): number {
  return new Date(utcMs + nyOffsetHours(utcMs) * HOUR_MS).getUTCHours();
}

/** The NY calendar date (YYYY-MM-DD) of an instant — plain wall-clock date. */
export function nyCalendarDayKey(utcMs: number): string {
  return new Date(utcMs + nyOffsetHours(utcMs) * HOUR_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The DTS day key (YYYY-MM-DD) for an instant: the NY calendar date, with the
 * day rolling over at 5 a.m. local rather than midnight — so 2 a.m. Tuesday
 * still belongs to Monday's day. Used by getToday and the digest send.
 */
export function dtsDayKey(utcMs: number): string {
  const shifted = utcMs + (nyOffsetHours(utcMs) - DTS_DIGEST_NY_HOUR) * HOUR_MS;
  return new Date(shifted).toISOString().slice(0, 10);
}

/**
 * The day a PREP run is building: the day of the next 5 a.m. digest. During
 * the pre-dawn prep window (midnight–5 a.m.) this is the day about to start —
 * NOT dtsDayKey(now), which still says yesterday. From 5 a.m. onward it equals
 * dtsDayKey(now) (a midday --force re-prep rebuilds today's queue).
 * Implemented as "the DTS day five hours from now".
 */
export function dtsPrepDay(utcMs: number): string {
  return dtsDayKey(utcMs + DTS_DIGEST_NY_HOUR * HOUR_MS);
}

/**
 * UTC bounds [start, end) of a DTS day: 5 a.m. NY on the key's date to 5 a.m.
 * NY the next day. The offset is sampled at the date's midday so DST
 * transitions (2 a.m., inside the previous DTS day) cannot skew it.
 */
export function dtsDayBoundsUtc(day: string): { start: number; end: number } {
  const utcMidnight = Date.parse(day);
  const offset = nyOffsetHours(utcMidnight + 12 * HOUR_MS);
  const start = utcMidnight + (DTS_DIGEST_NY_HOUR - offset) * HOUR_MS;
  const offsetNext = nyOffsetHours(utcMidnight + 36 * HOUR_MS);
  const end = utcMidnight + DAY_MS + (DTS_DIGEST_NY_HOUR - offsetNext) * HOUR_MS;
  return { start, end };
}

/**
 * Human countdown text for a due date, e.g. "in 3 days", "today", "2 days
 * overdue". Compares NY CALENDAR dates (not DTS days): an item due at 2 a.m.
 * is due on that calendar date, and the 5 a.m. shift would report it a day
 * early. Convention (schema comment + worker prompt): writers store dueAt as
 * noon New York; an exact-UTC-midnight timestamp still reads as the prior NY
 * evening and will be off by one — normalize at the writer.
 */
export function countdownText(dueAt: number, now: number): string {
  const dayDiff =
    (Date.parse(nyCalendarDayKey(dueAt)) - Date.parse(nyCalendarDayKey(now))) /
    DAY_MS;
  if (dayDiff === 0) return "today";
  if (dayDiff === 1) return "tomorrow";
  if (dayDiff > 1) return `in ${dayDiff} days`;
  if (dayDiff === -1) return "1 day overdue";
  return `${-dayDiff} days overdue`;
}

/** Deep link to one item on the /dts page (Everything tab), optionally
 * carrying an intent the page confirms before acting (state changes only on
 * the confirmed click — Slack's link-preview crawler fetches URLs, spec §7).
 * The single producer of the ?item=&intent= vocabulary consumed by app/dts.
 * Old /inventory links redirect to /dts with params preserved. */
export type DtsLinkIntent = "done" | "archive" | "engage";
export function dtsItemLink(todoId: string, intent?: DtsLinkIntent): string {
  return `https://tom.quest/dts?item=${todoId}${intent ? `&intent=${intent}` : ""}`;
}
