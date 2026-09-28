import { describe, expect, it } from "vitest";
import {
  dayLogWeeklyFacts,
  dailyWaistAverages,
  mondayOf,
  monthlyBenchmarkBests,
  newYorkMonth,
  weeklyMorningAverages,
  weeklyRuns,
} from "../day-log-trends.mjs";

describe("day-log trends", () => {
  it("groups New York morning values into Monday-starting weekly averages", () => {
    expect(mondayOf("2026-09-06")).toBe("2026-08-31");
    expect(weeklyMorningAverages([
      { day: "2026-09-01", value: 180, partOfDay: "morning", entryCreatedAt: Date.UTC(2026, 8, 1, 20) },
      { day: "2026-09-06", value: 182, partOfDay: "unknown", entryCreatedAt: Date.UTC(2026, 8, 6, 13) },
      { day: "2026-09-06", value: 190, partOfDay: "unknown", entryCreatedAt: Date.UTC(2026, 8, 6, 17) },
      { day: "2026-09-07", value: 178, partOfDay: "morning", entryCreatedAt: Date.UTC(2026, 8, 7, 20) },
    ])).toEqual([
      { week: "2026-08-31", value: 181, count: 2 },
      { week: "2026-09-07", value: 178, count: 1 },
    ]);
  });

  it("uses New York month boundaries and keeps each benchmark direction", () => {
    expect(newYorkMonth(Date.UTC(2026, 2, 1, 4, 59))).toBe("2026-02");
    expect(newYorkMonth(Date.UTC(2026, 2, 1, 5, 0))).toBe("2026-03");
    expect(monthlyBenchmarkBests([
      { day: "2026-02-01", metric: "pullup_added_weight", value: 20 },
      { day: "2026-02-12", metric: "pullup_added_weight", value: 25 },
      { day: "2026-02-20", metric: "pullup_added_weight", value: 40, revertedAt: 1 },
      { day: "2026-03-01", metric: "pullup_added_weight", value: 15 },
      { day: "2026-02-02", metric: "hang_20mm", value: 18 },
      { day: "2026-02-03", metric: "hang_20mm", value: 23 },
      { day: "2026-02-04", metric: "sprint_40yd", value: 7.4 },
      { day: "2026-02-05", metric: "sprint_40yd", value: 6.9 },
      { day: "2026-02-06", metric: "sprint_40yd", value: 4, revertedAt: 1 },
      { day: "2026-02-07", metric: "loop_1_4mi", value: 470 },
      { day: "2026-02-08", metric: "loop_1_4mi", value: 455 },
    ])).toEqual([
      { metric: "pullup_added_weight", month: "2026-02", value: 25, count: 2 },
      { metric: "pullup_added_weight", month: "2026-03", value: 15, count: 1 },
      { metric: "hang_20mm", month: "2026-02", value: 23, count: 2 },
      { metric: "sprint_40yd", month: "2026-02", value: 6.9, count: 2 },
      { metric: "loop_1_4mi", month: "2026-02", value: 455, count: 2 },
    ]);
  });

  it("averages active waist readings per day", () => {
    expect(dailyWaistAverages([
      { day: "2026-09-01", metric: "waist", value: 31 },
      { day: "2026-09-01", metric: "waist", value: 32 },
      { day: "2026-09-01", metric: "waist", value: 40, revertedAt: 1 },
      { day: "2026-09-02", metric: "waist", value: 30.5 },
      { day: "2026-09-02", metric: "weight", value: 180 },
    ])).toEqual([
      { day: "2026-09-01", value: 31.5, count: 2 },
      { day: "2026-09-02", value: 30.5, count: 1 },
    ]);
  });

  it("counts active runs by Monday week and sums only known distances", () => {
    expect(weeklyRuns([
      { day: "2026-09-01", activity: "run", distanceMi: 3.1 },
      { day: "2026-09-06", activity: "run" },
      { day: "2026-09-07", activity: "run" },
      { day: "2026-09-08", activity: "walk", distanceMi: 2 },
      { day: "2026-09-08", activity: "run", distanceMi: 6, revertedAt: 1 },
    ])).toEqual([
      { week: "2026-08-31", count: 2, distanceMi: 3.1 },
      { week: "2026-09-07", count: 1, distanceMi: null },
    ]);
  });

  it("excludes reverted readings from weekly morning averages", () => {
    expect(weeklyMorningAverages([
      { day: "2026-09-01", value: 180, partOfDay: "morning", entryCreatedAt: Date.UTC(2026, 8, 1, 12) },
      { day: "2026-09-02", value: 200, partOfDay: "morning", entryCreatedAt: Date.UTC(2026, 8, 2, 12), revertedAt: 1 },
    ])).toEqual([
      { week: "2026-08-31", value: 180, count: 1 },
    ]);
  });
});

describe("Friday day-log facts", () => {
  const today = "2026-09-28";

  it("reports rolling weight averages, the latest waist, and a flat three-week waist", () => {
    expect(dayLogWeeklyFacts([
      { day: "2026-09-22", metric: "weight", value: 180, partOfDay: "morning" },
      { day: "2026-09-28", metric: "weight", value: 182, partOfDay: "morning" },
      { day: "2026-09-15", metric: "weight", value: 184, partOfDay: "morning" },
      { day: "2026-09-01", metric: "waist", value: 34.5 },
      { day: "2026-09-14", metric: "waist", value: 34.25 },
      { day: "2026-09-28", metric: "waist", value: 34.5 },
      { day: "2026-09-20", type: "workout", activity: "run" },
      { day: "2026-09-27", type: "workout", activity: "run" },
      { day: "2026-09-28", type: "workout", activity: "run" },
    ], today)).toEqual({
      weekAvgWeight: 181,
      prevWeekAvgWeight: 184,
      latestWaist: { value: 34.5, day: "2026-09-28" },
      waistFlat3w: true,
      runCount: 2,
    });
  });

  it("does not call a waist flat after a reading moves more than one quarter inch", () => {
    expect(dayLogWeeklyFacts([
      { day: "2026-09-01", metric: "waist", value: 34.5 },
      { day: "2026-09-14", metric: "waist", value: 33.9 },
      { day: "2026-09-28", metric: "waist", value: 34.5 },
    ], today)?.waistFlat3w).toBe(false);
  });

  it("requires a waist reading at least three weeks before the latest reading", () => {
    expect(dayLogWeeklyFacts([
      { day: "2026-09-09", metric: "waist", value: 34.5 },
      { day: "2026-09-28", metric: "waist", value: 34.5 },
    ], today)).toMatchObject({
      latestWaist: { value: 34.5, day: "2026-09-28" },
      waistFlat3w: false,
    });
  });

  it("excludes reverted items from every fact", () => {
    expect(dayLogWeeklyFacts([
      { day: "2026-09-28", metric: "weight", value: 181, partOfDay: "morning" },
      { day: "2026-09-27", metric: "weight", value: 190, partOfDay: "morning", revertedAt: 1 },
      { day: "2026-09-28", type: "workout", activity: "run" },
      { day: "2026-09-27", type: "workout", activity: "run", revertedAt: 1 },
    ], today)).toMatchObject({ weekAvgWeight: 181, runCount: 1 });
  });

  it("omits the facts when every item is older than the 28-day window", () => {
    expect(dayLogWeeklyFacts([
      { day: "2026-08-31", metric: "weight", value: 181, partOfDay: "morning" },
    ], today)).toBeNull();
  });
});
