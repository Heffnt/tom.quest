import { describe, expect, it } from "vitest";
import { labelDays, mealDays, niceTicks, trainingWeeks, weekOf, weightDays } from "./lib";

describe("history lib", () => {
  it("puts a day in the week that starts on its Monday", () => {
    expect(weekOf("2026-10-05")).toBe("2026-10-05");
    expect(weekOf("2026-10-04")).toBe("2026-09-28");
    expect(weekOf("2026-10-07")).toBe("2026-10-05");
  });

  it("counts a session once per body part it trained, with its activity when it names none", () => {
    const weeks = trainingWeeks([
      { id: "a", at: 0, day: "2026-10-05", text: "", bodyParts: ["back", "fingers", "fingers"] },
      { id: "b", at: 0, day: "2026-10-06", text: "", bodyParts: ["fingers"] },
      { id: "c", at: 0, day: "2026-10-07", text: "", activity: "run", bodyParts: [] },
    ], ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(weeks).toEqual([
      { week: "2026-09-28", parts: [], total: 0 },
      { week: "2026-10-05", parts: [{ part: "fingers", sessions: 2 }, { part: "back", sessions: 1 }, { part: "run", sessions: 1 }], total: 4 },
    ]);
  });

  it("totals protein and calories only where he gave them", () => {
    const days = mealDays([
      { id: "a", at: 0, day: "2026-10-05", text: "", proteinG: 30 },
      { id: "b", at: 0, day: "2026-10-05", text: "", proteinG: 20, calories: 500 },
      { id: "c", at: 0, day: "2026-10-06", text: "" },
    ], ["2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(days.map((d) => [d.day, d.meals.length, d.proteinG, d.calories])).toEqual([
      ["2026-10-05", 2, 50, 500],
      ["2026-10-06", 1, null, null],
      ["2026-10-07", 0, null, null],
    ]);
  });

  it("averages a day's weigh-ins into one point", () => {
    expect(weightDays([
      { id: "a", at: 0, day: "2026-10-06", lb: 181 },
      { id: "b", at: 0, day: "2026-10-05", lb: 182 },
      { id: "c", at: 0, day: "2026-10-06", lb: 180 },
    ])).toEqual([{ day: "2026-10-05", lb: 182, readings: 1 }, { day: "2026-10-06", lb: 180.5, readings: 2 }]);
  });

  it("makes round ticks that cover the values", () => {
    expect(niceTicks(179.5, 182.5, 4)).toEqual([179, 180, 181, 182, 183]);
    expect(niceTicks(0, 7, 4)).toEqual([0, 2, 4, 6, 8]);
  });

  it("labels the first and last day and spaces the rest", () => {
    const days = Array.from({ length: 28 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
    const labels = labelDays(days, 5);
    expect(labels[0]).toBe(days[0]);
    expect(labels.at(-1)).toBe(days.at(-1));
    expect(labels).toHaveLength(5);
  });
});
