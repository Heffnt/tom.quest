import { describe, expect, it } from "vitest";
import { trainingDay } from "./trainingDay";

describe("trainingDay", () => {
  it("reads a versioned training section, stripped cells, and notes for an abbreviated day", () => {
    const day = trainingDay(`
# Plan
## Training week — revision 9
| Day | Morning | Evening | Optional |
| --- | --- | --- | --- |
| **Mon** | **Orbit + map** | — | Rest |
| Tuesday | Signal | - | |

- **Monday** uses the longer route.
Monday keeps the blue marker.
- Tuesday uses the shorter route.

## Later section
- Monday is not a note for this slot.
`, `
## Session ideas — revision 3
- This list is only a general introduction.
- Route (Monday, Wednesday), for navigation: trace a short path.
- Orbit & map: make a simple route. (inferred)
- Session: count the markers.
`, "MONDAY");

    expect(day).toEqual({
      cells: [
        { column: "Morning", text: "Orbit + map" },
        { column: "Optional", text: "Rest" },
      ],
      notes: ["Monday uses the longer route.", "Monday keeps the blue marker."],
      ideas: [
        { label: "Route", text: "trace a short path." },
        { label: "Orbit & map", text: "make a simple route." },
      ],
    });
  });

  it("matches an abbreviated weekday in a required training section", () => {
    const day = trainingDay(`
Before the table.
## Training week
| **Day** | Block |
| --- | --- |
| Tue | Signal |
| Wed | Beacon |
`, `
### Session ideas for this revision
- Signal (Tuesday morning): check the pattern.
- Beacon: trace the outline.
`, "tue");

    expect(day).toEqual({
      cells: [{ column: "Block", text: "Signal" }],
      notes: [],
      ideas: [{ label: "Signal", text: "check the pattern." }],
    });
  });

  it("does not match an idea through a common word alone", () => {
    const day = trainingDay(`
## Training week — current
| Day | Block |
| --- | --- |
| Monday | Morning session |
`, `
## Session ideas
- Session: count the markers.
`, "monday");

    expect(day?.ideas).toEqual([]);
  });

  it("returns null when the schedule is missing or has no row for the weekday", () => {
    expect(trainingDay("", "", "monday")).toBeNull();
    expect(trainingDay(`
| Day | Block |
| --- | --- |
| Monday | Signal |
`, "", "monday")).toBeNull();
    expect(trainingDay(`
## Training week
| Day | Block |
| --- | --- |
| Tuesday | Signal |
`, "", "monday")).toBeNull();
  });
});
