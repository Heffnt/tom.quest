import { describe, expect, it } from "vitest";
import {
  countVoices,
  dateLabel,
  filterLines,
  groupByKind,
  sourcesOf,
  type IntentLine,
} from "./lib";

function line(over: Partial<IntentLine> = {}): IntentLine {
  return {
    id: "model-of-tom/intent.md#5",
    kind: "direction",
    text: "A line",
    section: "What to protect",
    voice: "his",
    source: "model-of-tom/intent.md",
    locator: "line 5",
    at: Date.UTC(2026, 7, 20),
    dateText: "2026-08-20",
    evidence: [],
    ...over,
  };
}

describe("filterLines", () => {
  const lines = [
    line(),
    line({ id: "b", kind: "standing-rule", voice: "unattributed", source: "tom.quest AGENTS.md" }),
    line({ id: "c", kind: "ruling", voice: "his", source: "dtsRulings" }),
  ];

  it("shows everything when nothing is picked", () => {
    expect(filterLines(lines, { kind: "all", voice: "all", source: "all" })).toHaveLength(3);
  });

  it("narrows on each of the three at once", () => {
    expect(filterLines(lines, { kind: "ruling", voice: "his", source: "dtsRulings" }).map((x) => x.id))
      .toEqual(["c"]);
    expect(filterLines(lines, { kind: "ruling", voice: "his", source: "model-of-tom/intent.md" }))
      .toEqual([]);
  });
});

describe("groupByKind", () => {
  it("draws the kinds in their own order and keeps each group's order", () => {
    const grouped = groupByKind([
      line({ id: "1", kind: "label", at: 3 }),
      line({ id: "2", kind: "direction", at: 2 }),
      line({ id: "3", kind: "direction", at: 1 }),
    ]);
    expect(grouped.map((group) => group.kind)).toEqual(["direction", "label"]);
    expect(grouped[0].lines.map((x) => x.id)).toEqual(["2", "3"]);
  });

  it("leaves out a kind the record holds nothing of", () => {
    expect(groupByKind([line({ kind: "ruling" })]).map((group) => group.kind)).toEqual(["ruling"]);
  });
});

describe("dateLabel", () => {
  // The file says 2026-08-20 and the page says 2026-08-20. Reading that as an
  // instant and printing it in New York would say the 19th.
  it("prints a file's own date verbatim", () => {
    expect(dateLabel(line())).toBe("2026-08-20");
  });

  it("prints a record row's instant in his own day", () => {
    expect(dateLabel(line({ dateText: null, at: Date.UTC(2026, 7, 20, 12) }))).toBe("2026-08-20");
    // 01:00 UTC is still the previous evening in New York.
    expect(dateLabel(line({ dateText: null, at: Date.UTC(2026, 7, 20, 1) }))).toBe("2026-08-19");
  });

  it("says so when a line carries no date at all", () => {
    expect(dateLabel(line({ dateText: null, at: null }))).toBe("undated");
  });
});

describe("sourcesOf and countVoices", () => {
  it("lists each source once, sorted", () => {
    expect(sourcesOf([line(), line({ source: "dtsRulings" }), line()]))
      .toEqual(["dtsRulings", "model-of-tom/intent.md"]);
  });

  it("counts the three voices", () => {
    expect(countVoices([line(), line({ voice: "inferred" }), line({ voice: "inferred" })]))
      .toEqual({ his: 1, inferred: 2, unattributed: 0 });
  });
});
