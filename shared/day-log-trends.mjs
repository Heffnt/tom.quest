/**
 * The chart inputs are intentionally small plain objects so the browser,
 * Convex, and the box can use the same calculation without a chart library.
 */

const DAY_MS = 86_400_000;

function offsetDay(day, days) {
  return new Date(Date.parse(day) + days * DAY_MS).toISOString().slice(0, 10);
}

function newYorkHour(at) {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at)).find((part) => part.type === "hour")?.value;
  return Number(hour);
}

function isMorningValue(item) {
  const isMorning = item.partOfDay === "morning";
  const isEarlyUnknown = item.partOfDay === "unknown"
    && Number.isFinite(item.entryCreatedAt)
    && newYorkHour(item.entryCreatedAt) < 12;
  return isMorning || isEarlyUnknown;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function average(values) {
  return values.length === 0 ? null : mean(values);
}

function itemTime(item) {
  return Number.isFinite(item.entryCreatedAt)
    ? item.entryCreatedAt
    : Number.isFinite(item.createdAt)
      ? item.createdAt
      : 0;
}

function newestFirst(a, b) {
  return b.day.localeCompare(a.day) || itemTime(b) - itemTime(a);
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
    if (!isMorningValue(item)) continue;
    const week = mondayOf(item.day);
    const values = buckets.get(week) ?? [];
    values.push(item.value);
    buckets.set(week, values);
  }
  return [...buckets.entries()]
    .map(([week, values]) => ({
      week,
      value: mean(values),
      count: values.length,
    }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

/** The earliest New York calendar day retained by the Friday agenda facts. */
export function dayLogLookbackStart(today) {
  return offsetDay(today, -27);
}

/**
 * The rolling day-log facts used by the Friday agenda. `day` is already a
 * New York calendar day, so date windows do not change at UTC midnight.
 */
export function dayLogWeeklyFacts(items, today) {
  const lookbackStart = dayLogLookbackStart(today);
  const currentWeekStart = offsetDay(today, -6);
  const previousWeekStart = offsetDay(today, -13);
  const previousWeekEnd = offsetDay(today, -7);
  const current = items.filter((item) =>
    item.revertedAt === undefined
    && typeof item.day === "string"
    && item.day >= lookbackStart
    && item.day <= today,
  );
  if (current.length === 0) return null;

  const morningWeightAverage = (start, end) => average(current
    .filter((item) =>
      item.metric === "weight"
      && typeof item.value === "number"
      && Number.isFinite(item.value)
      && item.day >= start
      && item.day <= end
      && isMorningValue(item),
    )
    .map((item) => item.value));

  const waists = current
    .filter((item) =>
      item.metric === "waist"
      && typeof item.value === "number"
      && Number.isFinite(item.value),
    )
    .sort(newestFirst);
  const latest = waists[0] ?? null;
  const reference = latest === null
    ? null
    : waists.find((item) => item.day <= offsetDay(latest.day, -21)) ?? null;
  const waistFlat3w = latest !== null
    && reference !== null
    && waists
      .filter((item) => item.day >= reference.day && item.day <= latest.day)
      .every((item) => Math.abs(item.value - latest.value) <= 0.25);

  return {
    weekAvgWeight: morningWeightAverage(currentWeekStart, today),
    prevWeekAvgWeight: morningWeightAverage(previousWeekStart, previousWeekEnd),
    latestWaist: latest === null ? null : { value: latest.value, day: latest.day },
    waistFlat3w,
    runCount: current.filter((item) =>
      item.day >= currentWeekStart
      && item.kind === "workout"
      && item.activity === "run",
    ).length,
  };
}
