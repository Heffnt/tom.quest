/**
 * The chart inputs are intentionally small plain objects so the browser,
 * Convex, and the box can use the same calculation without a chart library.
 */

const DAY_MS = 86_400_000;

function newYorkHour(at) {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at)).find((part) => part.type === "hour")?.value;
  return Number(hour);
}

/** Monday YYYY-MM-DD for a calendar day that is already in New York. */
export function mondayOf(day) {
  const at = Date.parse(day);
  const weekday = new Date(at).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  return new Date(at - daysSinceMonday * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Weekly means for morning values. Unknown-time values count only when their
 * entry arrived before noon in New York, which keeps an omitted qualifier from
 * being mistaken for an evening reading.
 */
export function weeklyMorningAverages(items) {
  const buckets = new Map();
  for (const item of items) {
    const isMorning = item.partOfDay === "morning";
    const isEarlyUnknown = item.partOfDay === "unknown" && newYorkHour(item.entryCreatedAt) < 12;
    if (!isMorning && !isEarlyUnknown) continue;
    const week = mondayOf(item.day);
    const values = buckets.get(week) ?? [];
    values.push(item.value);
    buckets.set(week, values);
  }
  return [...buckets.entries()]
    .map(([week, values]) => ({
      week,
      value: values.reduce((sum, value) => sum + value, 0) / values.length,
      count: values.length,
    }))
    .sort((a, b) => a.week.localeCompare(b.week));
}
