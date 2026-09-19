import { describe, expect, it } from "vitest";
import { CHECKIN_MAX_CHARS, CHECKIN_RULES, checkInFailures } from "./checkin-rules.mjs";
import { BRIEF_RULES, CHECKIN_RULES as REEXPORTED, failuresFor } from "./check-writing-standard.mjs";

const ids = (text) => checkInFailures(text).map((f) => f.id);

describe("the check-in form rules", () => {
  it("pass a plain check-in, and a ruling requested as a numbered list under its heading", () => {
    expect(ids("The sweep has 12 jobs running.\n\nNothing changed.")).toEqual([]);
    expect(ids("Two cells are stuck.\n\n## Rulings requested\n\n1. Should I stop them? If you do not answer, I keep going.")).toEqual([]);
  });

  it("refuse each malformed shape by its own rule", () => {
    expect(ids("The sweep is running")).toEqual(["checkin-sentences"]);
    expect(ids("The sweep is running and then...")).toContain("checkin-ellipsis");
    expect(ids("It ran.\n\n```\nsqueue\n```")).toContain("checkin-fence");
    expect(ids("## Status\n\nIt ran.")).toEqual(["checkin-heading"]);
    expect(ids("## Rulings requested\n\n1. One?\n\n## Rulings requested\n\n2. Two?")).toEqual(["checkin-heading"]);
    expect(ids("It ran.\n\n1. A numbered line outside the heading.")).toEqual(["checkin-numbered"]);
    expect(ids("Status: green.")).toEqual(["checkin-label"]);
    expect(ids("- **Next step:** look again.")).toEqual(["checkin-label"]);
    expect(ids(`${"A long sentence. ".repeat(100)}`)).toEqual(["checkin-length"]);
    expect(ids("  ")).toEqual(["checkin-empty"]);
    expect(CHECKIN_MAX_CHARS).toBe(1500);
  });

  it("are the rules check-writing-standard.mjs exports, read through its failuresFor, and not the brief rules", () => {
    expect(REEXPORTED).toBe(CHECKIN_RULES);
    expect(failuresFor("## Status\n\nIt ran.", CHECKIN_RULES)).toEqual(["checkin-heading"]);
    // A ruling request is a heading and a numbered list, which a brief refuses.
    const ruling = "Two cells are stuck.\n\n## Rulings requested\n\n1. Should I stop them?";
    expect(failuresFor(ruling, BRIEF_RULES)).toContain("brief-markup");
    expect(failuresFor(ruling, CHECKIN_RULES)).toEqual([]);
  });
});
