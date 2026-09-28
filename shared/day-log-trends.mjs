/**
 * The chart inputs are intentionally small plain objects so the browser,
 * Convex, and the box can use the same calculation without a chart library.
 */

const DAY_MS = 86_400_000;

function offsetDay(day, days) {
  return new Date(Date.parse(day) + days * DAY_MS).toISOString().slice(0, 10);
}

export const DAY_LOG_BENCHMARKS = Object.freeze({
  pullup_added_weight: Object.freeze({ direction: "max", unit: "lb" }),
  hang_20mm: Object.freeze({ direction: "max", unit: "s" }),
  sprint_40yd: Object.freeze({ direction: "min", unit: "s" }),
  loop_1_4mi: Object.freeze({ direction: "min", unit: "s" }),
});

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

/** The one morning-weight average used by the page's weeks and Friday facts. */
export function morningWeightAverage(items) {
  const values = items
    .filter((item) =>
      isMorningValue(item)
      && typeof item.value === "number"
      && Number.isFinite(item.value),
    )
    .map((item) => item.value);
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

/** YYYY-MM in New York for an instant. Day-log item days are already New York calendar days. */
export function newYorkMonth(at) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(at));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `${year}-${month}`;
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
    if (
      !isMorningValue(item)
      || typeof item.value !== "number"
      || !Number.isFinite(item.value)
    ) continue;
    const week = mondayOf(item.day);
    const bucket = buckets.get(week) ?? [];
    bucket.push(item);
    buckets.set(week, bucket);
  }
  return [...buckets.entries()]
    .flatMap(([week, bucket]) => {
      const value = morningWeightAverage(bucket);
      return value === null ? [] : [{ week, value, count: bucket.length }];
    })
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
  const current = items.filter((item) =>
    typeof item.day === "string"
    && item.day >= lookbackStart
    && item.day <= today,
  );
  if (current.length === 0) return null;

  // The page's weekly points and these trailing-seven-day facts use the same
  // morning-only average, so an unknown-time measurement cannot reach the
  // two surfaces by different rules.
  const morningWeights = current.filter((item) => item.metric === "weight");
  const averageForWindow = (start, end) => morningWeightAverage(morningWeights.filter((item) => item.day >= start && item.day <= end));

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
    weekAvgWeight: averageForWindow(currentWeekStart, today),
    prevWeekAvgWeight: averageForWindow(previousWeekStart, offsetDay(today, -7)),
    latestWaist: latest === null ? null : { value: latest.value, day: latest.day },
    waistFlat3w,
    runCount: current.filter((item) =>
      item.day >= currentWeekStart
      && item.type === "workout"
      && item.activity === "run",
    ).length,
  };
}

/** One daily mean for every waist reading on that New York calendar day. */
export function dailyWaistAverages(items) {
  const buckets = new Map();
  for (const item of items) {
    if (item.metric !== "waist" || !Number.isFinite(item.value)) continue;
    const values = buckets.get(item.day) ?? [];
    values.push(item.value);
    buckets.set(item.day, values);
  }
  return [...buckets.entries()]
    .map(([day, values]) => ({
      day,
      value: values.reduce((sum, value) => sum + value, 0) / values.length,
      count: values.length,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** The best value in each New York calendar month for every benchmark. */
export function monthlyBenchmarkBests(items) {
  const buckets = new Map();
  for (const item of items) {
    const benchmark = DAY_LOG_BENCHMARKS[item.metric];
    if (!benchmark || !Number.isFinite(item.value)) continue;
    const month = item.day.slice(0, 7);
    const key = `${item.metric}:${month}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, { metric: item.metric, month, value: item.value, count: 1 });
      continue;
    }
    bucket.count += 1;
    if ((benchmark.direction === "max" && item.value > bucket.value) || (benchmark.direction === "min" && item.value < bucket.value)) {
      bucket.value = item.value;
    }
  }
  const order = new Map(Object.keys(DAY_LOG_BENCHMARKS).map((metric, index) => [metric, index]));
  return [...buckets.values()].sort((a, b) => {
    const metricOrder = (order.get(a.metric) ?? 0) - (order.get(b.metric) ?? 0);
    return metricOrder === 0 ? a.month.localeCompare(b.month) : metricOrder;
  });
}

/** Run items grouped into Monday-starting New York weeks. */
export function weeklyRuns(items) {
  const buckets = new Map();
  for (const item of items) {
    if (item.activity !== "run") continue;
    const week = mondayOf(item.day);
    const bucket = buckets.get(week) ?? { count: 0, distanceMi: 0, distanceCount: 0 };
    bucket.count += 1;
    if (Number.isFinite(item.distanceMi)) {
      bucket.distanceMi += item.distanceMi;
      bucket.distanceCount += 1;
    }
    buckets.set(week, bucket);
  }
  return [...buckets.entries()]
    .map(([week, bucket]) => ({
      week,
      count: bucket.count,
      distanceMi: bucket.distanceCount === 0 ? null : bucket.distanceMi,
    }))
    .sort((a, b) => a.week.localeCompare(b.week));
}
