import { describe, expect, it } from "vitest";
import {
  countVoices,
  dateLabel,
  filterLines,
  groupByKind,
  evalItemLineSuffix,
  evalItemsForLine,
  joinLines,
  linesRestedOn,
  passRate,
  segmentBullets,
  sourcesOf,
  type IntentLine,
} from "./lib";

// EVERY FIXTURE HERE IS INVENTED. His pages are private to WikiTom and this
// repository is public.

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
    line({ id: "c", kind: "ruling", voice: "his", source: "rulings" }),
  ];

  it("shows everything when nothing is picked", () => {
    expect(filterLines(lines, { kind: "all", voice: "all", source: "all" })).toHaveLength(3);
  });

  it("narrows on each of the three at once", () => {
    expect(filterLines(lines, { kind: "ruling", voice: "his", source: "rulings" }).map((x) => x.id))
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
    expect(sourcesOf([line(), line({ source: "rulings" }), line()]))
      .toEqual(["model-of-tom/intent.md", "rulings"]);
  });

  it("counts the three voices", () => {
    expect(countVoices([line(), line({ voice: "inferred" }), line({ voice: "inferred" })]))
      .toEqual({ his: 1, inferred: 2, unattributed: 0 });
  });
});

describe("segmentBullets", () => {
  const prompt = [
    "MODEL-OF-TOM FILES (WikiTom commit abc): model-of-tom/agent-rules.md",
    "",
    "── model-of-tom/agent-rules.md ──",
    "# Agent rules",
    "",
    "## Never",
    "- Guess.",
    "- Spend money,",
    "  or message anyone.",
    "",
    "SKILLS (WikiTom commit abc)",
  ].join("\n");

  it("cuts out each bullet of a tracked page, with the lines it wraps onto", () => {
    const parts = segmentBullets(prompt);
    expect(parts.filter((part) => part.kind === "bullet")).toEqual([
      { kind: "bullet", text: "- Guess.", source: "model-of-tom/agent-rules.md", key: "Guess." },
      {
        kind: "bullet",
        text: "- Spend money,\n  or message anyone.",
        source: "model-of-tom/agent-rules.md",
        key: "Spend money, or message anyone.",
      },
    ]);
  });

  it("keeps the text verbatim", () => {
    expect(segmentBullets(prompt).map((part) => part.text).join("\n")).toBe(prompt);
  });

  it("leaves the bullets of an untracked file as plain text", () => {
    const body = "── model-of-tom/writing.md ──\n- Be plain.\n\n── model-of-tom/intent.md ──\n- Ship it.";
    const bullets = segmentBullets(body).filter((part) => part.kind === "bullet");
    expect(bullets.map((part) => part.text)).toEqual(["- Ship it."]);
  });

  it("finds no bullet in a text with no file header", () => {
    expect(segmentBullets("- a\n- b")).toEqual([{ kind: "text", text: "- a\n- b" }]);
  });
});

describe("joinLines", () => {
  const listed = line({
    id: "model-of-tom/agent-rules.md#9",
    kind: "standing-rule",
    text: "Spend money,   or message anyone.",
    source: "model-of-tom/agent-rules.md",
    voice: "his",
  });

  it("joins a bullet to its line on file and spacing-normalised text", () => {
    const rows = joinLines(segmentBullets("── model-of-tom/agent-rules.md ──\n- Spend money,\n  or message anyone."), [listed]);
    expect(rows[1]).toEqual({ kind: "bullet", text: "- Spend money,\n  or message anyone.", line: listed });
  });

  it("never joins the same text written in another file", () => {
    const rows = joinLines(segmentBullets("── model-of-tom/priorities.md ──\n- Spend money, or message anyone."), [listed]);
    expect(rows[1]).toMatchObject({ kind: "bullet", line: { source: "model-of-tom/priorities.md", evidence: [] } });
    expect(rows[1].kind === "bullet" && rows[1].line.id).not.toBe(listed.id);
  });

  it("opens a bullet the list does not hold as a line with no evidence", () => {
    const rows = joinLines(segmentBullets("── model-of-tom/intent.md ──\n- A newer line (inferred)"), []);
    expect(rows[1]).toMatchObject({
      kind: "bullet",
      line: { kind: "direction", voice: "inferred", locator: "unmatched", evidence: [] },
    });
  });
});

describe("linesRestedOn", () => {
  const lines = [
    line(),
    line({ id: "model-of-tom/intent.md#9", section: "Directions" }),
    line({ id: "model-of-tom/agent-rules.md#3", kind: "standing-rule", source: "model-of-tom/agent-rules.md", section: "How you work" }),
    line({ id: "CMT AGENTS.md#4", kind: "standing-rule", source: "CMT AGENTS.md", section: "commands", voice: "unattributed" }),
    line({ id: "rulings/qs7abc758ddm40", kind: "ruling", source: "rulings", section: "life", locator: "qs7abc758ddm40" }),
  ];

  it("resolves a page section, whatever its case, to the lines under it", () => {
    expect(linesRestedOn("model-of-tom/intent.md#what to protect", lines).map((l) => l.id)).toEqual(["model-of-tom/intent.md#5"]);
    expect(linesRestedOn("model-of-tom/agent-rules.md#How you work", lines).map((l) => l.id)).toEqual(["model-of-tom/agent-rules.md#3"]);
  });

  it("resolves an evidence entry to the page's lines, and a repo's evidence entry to its AGENTS.md rules", () => {
    expect(linesRestedOn("model-of-tom/evidence/intent.md:Directions", lines).map((l) => l.id)).toEqual(["model-of-tom/intent.md#9"]);
    expect(linesRestedOn("model-of-tom/evidence/repos/CMT.md:AGENTS.md#commands", lines).map((l) => l.id)).toEqual(["CMT AGENTS.md#4"]);
  });

  it("resolves a ruling id and a line number, and nothing it cannot read", () => {
    expect(linesRestedOn("ruling:qs7abc758ddm40", lines).map((l) => l.id)).toEqual(["rulings/qs7abc758ddm40"]);
    expect(linesRestedOn("model-of-tom/intent.md#9", lines).map((l) => l.id)).toEqual(["model-of-tom/intent.md#9"]);
    expect(linesRestedOn("model-of-tom/intent.md#Nowhere", lines)).toEqual([]);
    expect(linesRestedOn("just words", lines)).toEqual([]);
    expect(linesRestedOn("model-of-tom/evidence/repos/CMT.md:commands", lines)).toEqual([]);
  });
});

describe("evalItemsForLine", () => {
  const items = [
    { name: "rule/ruling-758ddm40", passed: 1, runs: 3 },
    { name: "rule/ruling-td8dkhd8", passed: 2, runs: 2 },
    { name: "wall/pre-push-clean", passed: 5, runs: 5 },
  ];
  const ruling = line({ id: "rulings/qs7abc758ddm40", kind: "ruling", source: "rulings" });

  it("names a ruling line by the last eight characters of its id, and no other kind of line", () => {
    expect(evalItemLineSuffix("rule/ruling-758ddm40")).toBe("758ddm40");
    expect(evalItemLineSuffix("wall/pre-push-clean")).toBeNull();
    expect(evalItemsForLine(ruling, items).map((i) => i.name)).toEqual(["rule/ruling-758ddm40"]);
    expect(evalItemsForLine(line({ id: "model-of-tom/intent.md#758ddm40" }), items)).toEqual([]);
  });

  it("sums the pass rate over the items naming the line, or answers null for none", () => {
    expect(passRate(evalItemsForLine(ruling, items))).toEqual({ passed: 1, runs: 3 });
    expect(passRate([])).toBeNull();
  });
});
