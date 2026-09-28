import { describe, expect, it } from "vitest";
import { mondayOf, weeklyMorningAverages } from "../day-log-trends.mjs";

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
