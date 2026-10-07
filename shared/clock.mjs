// THE ONE HOME for zone work in tom.quest: every conversion of an instant to a
// reading in America/New_York, Tom's zone, and back. The record
// (convex/ttsShared.ts re-exports its day functions under their old names) and
// every page import it, so no page reads the browser's zone and no rendering
// prints UTC.
//
// The zone table does the conversion: Intl.DateTimeFormat with the zone named.
// The Convex default runtime, Node and every browser the site supports carry
// it; the day log's weekly trends (shared/day-log-trends.mjs, removed with
// the day log) read New York hours through it in the Convex runtime before
// this file existed. The box's
// worker/jobs/clock.mjs in the Jarvis repository is the same contract for the
// box's own Node.
//
// One display form for a time Tom reads: "Sun Oct 4, 9:58 pm" (displayForm),
// "9:58 pm" when the day is already on the line (displayTime), "Sun Oct 4" for
// a day (displayDay, displayDayKey). It never says EST or EDT.
//
// Plain ESM with no imports, as every module in shared/ is.

export const ZONE = "America/New_York";

/** The hour, New York, at which one TTS day ends and the next begins: Tom's
 *  "tom days (end at 5am)". */
export const DAY_START_HOUR = 5;

const DAY_MS = 86_400_000;

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");

/**
 * The New York wall-clock reading of an instant (epoch milliseconds).
 * @param {number} ms
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: string }}
 *   month 1-12, hour 0-23, weekday "Sun".."Sat"
 */
export function newYorkParts(ms) {
  /** @type {Record<string, string>} */
  const p = {};
  for (const { type, value } of PARTS.formatToParts(new Date(ms))) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: p.weekday,
  };
}

/**
 * The calendar date of an instant in New York, YYYY-MM-DD.
 * @param {number} ms
 */
export function newYorkDay(ms) {
  const p = newYorkParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * New York wall-clock "HH:MM", 24-hour: for arithmetic and machine lines, not
 * for Tom (he reads displayTime).
 * @param {number} ms
 */
export function newYorkHhmm(ms) {
  const p = newYorkParts(ms);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * New York's offset from UTC at an instant, in hours: -4 in daylight time, -5
 * in standard time.
 * @param {number} ms
 */
export function newYorkOffsetHours(ms) {
  const p = newYorkParts(ms);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (wall - Math.floor(ms / 1000) * 1000) / 3_600_000;
}

/**
 * The instant of a New York wall-clock time on a YYYY-MM-DD calendar date.
 * The offset is read at the wall-clock reading taken as UTC, then again at
 * that first guess, which lands on the right side of a daylight-saving change
 * (one hour wide). A time the clocks repeat (1:30 am on the first Sunday of
 * November) is its first occurrence; a time they skip (2:30 am on the second
 * Sunday of March) comes back as the instant an hour earlier, 1:30 am, as the
 * record's nyTimeUtcMs always did.
 * @param {string} day
 * @param {number} hour
 * @param {number} [minute]
 */
export function newYorkInstant(day, hour, minute = 0) {
  const naive = Date.parse(day) + hour * 3_600_000 + minute * 60_000;
  const guess = naive - newYorkOffsetHours(naive) * 3_600_000;
  return naive - newYorkOffsetHours(guess) * 3_600_000;
}

/**
 * The TTS day of an instant, YYYY-MM-DD: the New York calendar date, except
 * that before 5 am it is still the previous day.
 * @param {number} ms
 */
export function ttsDayKey(ms) {
  const p = newYorkParts(ms);
  const date = Date.UTC(p.year, p.month - 1, p.day) - (p.hour < DAY_START_HOUR ? DAY_MS : 0);
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * "9:58 pm": the time of an instant in New York, 12-hour with am or pm.
 * @param {number} ms
 */
export function displayTime(ms) {
  const p = newYorkParts(ms);
  return `${p.hour % 12 || 12}:${pad(p.minute)} ${p.hour < 12 ? "am" : "pm"}`;
}

/**
 * "Sun Oct 4": the New York day of an instant.
 * @param {number} ms
 */
export function displayDay(ms) {
  const p = newYorkParts(ms);
  return `${p.weekday} ${MONTHS[p.month - 1]} ${p.day}`;
}

/**
 * "Sun Oct 4, 9:58 pm": the display form of an instant.
 * @param {number} ms
 */
export function displayForm(ms) {
  return `${displayDay(ms)}, ${displayTime(ms)}`;
}

/**
 * "Sun Oct 4" for a YYYY-MM-DD calendar date, which has no zone.
 * @param {string} day
 */
export function displayDayKey(day) {
  const at = new Date(Date.parse(day));
  return `${WEEKDAYS[at.getUTCDay()]} ${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
}

/**
 * A YYYY-MM-DD calendar date moved by whole days.
 * @param {string} day
 * @param {number} days
 */
export function addDays(day, days) {
  return new Date(Date.parse(day) + days * DAY_MS).toISOString().slice(0, 10);
}
