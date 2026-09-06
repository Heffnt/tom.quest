// Tests for the one home that reads a WikiTom markdown page by heading
// (worker/jobs/markdown-sections.mjs). Two callers in two languages depend on
// the same answer — the nightly job's area-page reduction and Convex's
// capture-triage section — so what is pinned here is where a section starts
// and stops, not what either caller asks for.

import { describe, expect, it } from "vitest";

import {
  enclosingHeadings,
  extractSections,
  frontmatterBlock,
  isIsoDay,
  parseFrontmatter,
  sectionSpan,
  setFrontmatterField,
} from "./markdown-sections.mjs";

const AREA = ["Current state", "Must not break"];

describe("isIsoDay", () => {
  it("accepts only a real day that round-trips through Date", () => {
    expect(isIsoDay("2026-09-11")).toBe(true);
    expect(isIsoDay("2028-02-29")).toBe(true);
    expect(isIsoDay("2026-02-30")).toBe(false);
    expect(isIsoDay("2027-02-29")).toBe(false);
    expect(isIsoDay("2026-13-01")).toBe(false);
    expect(isIsoDay("2026-9-11")).toBe(false);
    expect(isIsoDay(" 2026-09-11")).toBe(false);
    expect(isIsoDay(undefined)).toBe(false);
  });
});

describe("frontmatter", () => {
  const page = "---\nupdated: 2026-09-06\nreviewed:\nwindow_days: 30\n---\n# Research\n\ntext\n";

  it("reads the key: value lines between the fences and leaves the body", () => {
    expect(parseFrontmatter(page)).toEqual({
      fields: { updated: "2026-09-06", reviewed: "", window_days: "30" },
      body: "# Research\n\ntext\n",
    });
    expect(frontmatterBlock(page)).toBe("---\nupdated: 2026-09-06\nreviewed:\nwindow_days: 30\n---");
  });

  it("gives a page without a fence no fields and itself as the body", () => {
    expect(parseFrontmatter("# Plain\n")).toEqual({ fields: {}, body: "# Plain\n" });
    expect(parseFrontmatter("---\nnever closed\n")).toEqual({
      fields: {},
      body: "---\nnever closed\n",
    });
    expect(parseFrontmatter(undefined)).toEqual({ fields: {}, body: "" });
    expect(frontmatterBlock("# Plain\n")).toBe("");
  });

  it("sets a field in place and changes nothing else", () => {
    expect(setFrontmatterField(page, "reviewed", "2026-09-11")).toBe(
      "---\nupdated: 2026-09-06\nreviewed: 2026-09-11\nwindow_days: 30\n---\n# Research\n\ntext\n",
    );
  });

  it("appends a missing key before the closing fence, and gives a bare page a block", () => {
    expect(setFrontmatterField("---\nupdated: 2026-09-06\n---\nbody\n", "reviewed", "2026-09-11")).toBe(
      "---\nupdated: 2026-09-06\nreviewed: 2026-09-11\n---\nbody\n",
    );
    expect(setFrontmatterField("# Plain\n", "reviewed", "2026-09-11")).toBe(
      "---\nreviewed: 2026-09-11\n---\n# Plain\n",
    );
  });

  it("round-trips through parseFrontmatter", () => {
    const out = setFrontmatterField(page, "reviewed", "2026-09-11");
    expect(parseFrontmatter(out).fields.reviewed).toBe("2026-09-11");
  });
});

describe("sectionSpan", () => {
  const lines = [
    "# Page",
    "## Current state",
    "- a",
    "### Detail",
    "- b",
    "## Must Not Break",
    "- c",
  ];
  it("runs from the heading to the next heading of the same or a higher level, case-insensitively", () => {
    expect(sectionSpan(lines, "current state")).toEqual({ start: 1, end: 5, level: 2 });
    expect(sectionSpan(lines, "Detail")).toEqual({ start: 3, end: 5, level: 3 });
    expect(sectionSpan(lines, "must not break")).toEqual({ start: 5, end: 7, level: 2 });
    expect(sectionSpan(lines, "Ideal state")).toBeNull();
  });
});

describe("enclosingHeadings", () => {
  const lines = [
    "# Page",
    "## Ideal state",
    "- a",
    "### Training goals",
    "#### By December",
    "- b",
    "## Must not break",
    "- c",
  ];
  it("walks up from a heading to every heading above it of a higher level, nearest first", () => {
    expect(enclosingHeadings(lines, 4)).toEqual(["Training goals", "Ideal state", "Page"]);
    expect(enclosingHeadings(lines, 3)).toEqual(["Ideal state", "Page"]);
    expect(enclosingHeadings(lines, 6)).toEqual(["Page"]);
    expect(enclosingHeadings(lines, 0)).toEqual([]);
  });
  it("treats a body line as under the nearest heading of any level", () => {
    expect(enclosingHeadings(lines, 5)).toEqual(["By December", "Training goals", "Ideal state", "Page"]);
    expect(enclosingHeadings(lines, 7)).toEqual(["Must not break", "Page"]);
  });
});

describe("extractSections", () => {
  const page = [
    "---",
    "updated: 2026-09-05",
    "---",
    "# Research",
    "",
    "## Current state",
    "",
    "- CMT campaign live (2026-09-05, evidence: PR #104)",
    "",
    "### Detail",
    "",
    "- a sub-point that belongs to the section",
    "",
    "## Ideal state",
    "",
    "Tom's words, never posted.",
    "",
    "## Must not break",
    "",
    "- the D5 judge fix",
    "",
    "## Notes",
    "",
    "not posted either",
  ].join("\n");

  it("takes the two headed sections, sub-headings included, and nothing else", () => {
    const out = extractSections(page, AREA);
    expect(out).toBe(
      [
        "## Current state",
        "",
        "- CMT campaign live (2026-09-05, evidence: PR #104)",
        "",
        "### Detail",
        "",
        "- a sub-point that belongs to the section",
        "",
        "## Must not break",
        "",
        "- the D5 judge fix",
      ].join("\n"),
    );
    expect(out).not.toContain("Ideal state");
    expect(out).not.toContain("Tom's words");
    expect(out).not.toContain("Notes");
  });

  it("returns the sections in the fixed order whatever the page's order, and matches headings case-insensitively", () => {
    const flipped = "# Health\n\n## MUST NOT BREAK\n\n- sleep\n\n## current state\n\n- fine\n";
    expect(extractSections(flipped, AREA)).toBe(
      "## current state\n\n- fine\n\n## MUST NOT BREAK\n\n- sleep",
    );
  });

  it("is empty for a page with neither section, and copes with CRLF", () => {
    expect(extractSections("# Nothing\n\nprose\n", AREA)).toBe("");
    expect(extractSections("## Current state\r\n\r\n- x\r\n## Other\r\n", AREA)).toBe(
      "## Current state\n\n- x",
    );
  });

  it("is empty for nothing at all, so a caller with no stored page falls back", () => {
    expect(extractSections("", AREA)).toBe("");
    expect(extractSections(null, AREA)).toBe("");
    expect(extractSections(undefined, AREA)).toBe("");
  });
});
