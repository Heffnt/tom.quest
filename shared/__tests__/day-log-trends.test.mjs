import { describe, expect, it } from "vitest";
import { dayLogWeeklyFacts, mondayOf, weeklyMorningAverages } from "../day-log-trends.mjs";

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
      { day: "2026-09-20", kind: "workout", activity: "run" },
      { day: "2026-09-27", kind: "workout", activity: "run" },
      { day: "2026-09-28", kind: "workout", activity: "run" },
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
      { day: "2026-09-28", kind: "workout", activity: "run" },
      { day: "2026-09-27", kind: "workout", activity: "run", revertedAt: 1 },
    ], today)).toMatchObject({ weekAvgWeight: 181, runCount: 1 });
  });

  it("omits the facts when every item is older than the 28-day window", () => {
    expect(dayLogWeeklyFacts([
      { day: "2026-08-31", metric: "weight", value: 181, partOfDay: "morning" },
    ], today)).toBeNull();
  });
});
