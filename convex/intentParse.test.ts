import { describe, expect, it } from "vitest";
import {
  parseAdoptionRulings,
  parseBlockList,
  parseBullets,
  parseDate,
  parseEvidence,
  parseModelOfTomPage,
  parseRepoRules,
  parseSpecRevisions,
  parseSteering,
} from "./intentParse";

// EVERY FIXTURE HERE IS INVENTED. The real pages are private to WikiTom and
// this repository is public, so the grammar is asserted against text written
// for the test and never against his.

describe("parseDate", () => {
  it("reads a full date at UTC midnight", () => {
    expect(parseDate("2026-08-20")).toBe(Date.UTC(2026, 7, 20));
  });

  it("reads a month as its first day", () => {
    expect(parseDate("April 2026")).toBe(Date.UTC(2026, 3, 1));
  });

  it("returns null for anything else", () => {
    expect(parseDate("last spring")).toBeNull();
    expect(parseDate("2026-13-01")).toBe(Date.UTC(2026, 12, 1));
  });
});

describe("parseBullets", () => {
  const page = [
    "# Title",
    "",
    "Prose that is not a bullet.",
    "",
    "## First",
    "",
    "- one",
    "- two",
    "  wrapped onto a second line",
    "",
    "## Second",
    "",
    "- three",
  ].join("\n");

  it("takes each bullet under the heading above it, with its line number", () => {
    expect(parseBullets(page)).toEqual([
      { section: "First", text: "one", line: 7 },
      { section: "First", text: "two wrapped onto a second line", line: 8 },
      { section: "Second", text: "three", line: 13 },
    ]);
  });

  it("uses the deepest heading, not the outermost", () => {
    const nested = ["## Map", "", "### Skills", "", "- a skill rule"].join("\n");
    expect(parseBullets(nested)[0].section).toBe("Skills");
  });

  it("returns nothing for a page with no bullets", () => {
    expect(parseBullets("# Title\n\nAll prose.\n")).toEqual([]);
  });
});

describe("parseEvidence", () => {
  const evidence = [
    "# Evidence",
    "",
    "## What to protect",
    "",
    "- line: The test system keeps working.",
    "  said: 2026-08-20 · a session · \"keep it working\"",
    "  read: 2026-09-01 · a file · the code says so,",
    "    and says it twice.",
    "- line: Something inferred. (inferred)",
    "  rests on: 2026-07-04 · an older note · nobody has said this since.",
  ].join("\n");

  it("gives each line its entries, with the form and the date", () => {
    const found = parseEvidence(evidence);
    expect([...found.keys()]).toEqual([
      "The test system keeps working.",
      "Something inferred. (inferred)",
    ]);
    const entries = found.get("The test system keeps working.")!;
    expect(entries.map((entry) => entry.form)).toEqual(["said", "read"]);
    expect(entries[0].date).toBe("2026-08-20");
  });

  it("folds a wrapped entry into one entry", () => {
    const entries = parseEvidence(evidence).get("The test system keeps working.")!;
    expect(entries[1].text).toBe("2026-09-01 · a file · the code says so, and says it twice.");
  });

  it("gives an unknown line no entries", () => {
    expect(parseEvidence(evidence).get("A line nobody wrote")).toBeUndefined();
  });
});

describe("parseModelOfTomPage", () => {
  const body = [
    "# Intent",
    "",
    "## What to protect",
    "",
    "- The test system keeps working.",
    "- Something inferred. (inferred)",
    "- A line with no evidence at all.",
  ].join("\n");
  const evidence = [
    "## What to protect",
    "",
    "- line: The test system keeps working.",
    "  said: 2026-08-20 · a session · \"keep it working\"",
    "  paraphrase: 2026-09-01 · a note · it still holds.",
    "- line: Something inferred. (inferred)",
    "  rests on: 2026-07-04 · an older note · nobody has said this since.",
  ].join("\n");

  const lines = parseModelOfTomPage({
    path: "model-of-tom/intent.md",
    body,
    evidence,
    kind: "direction",
  });

  it("carries the kind, the section and where the line is written", () => {
    expect(lines[0]).toMatchObject({
      kind: "direction",
      section: "What to protect",
      source: "model-of-tom/intent.md",
      locator: "line 5",
      id: "model-of-tom/intent.md#5",
    });
  });

  it("dates a line by the newest evidence entry behind it", () => {
    expect(lines[0].at).toBe(Date.UTC(2026, 8, 1));
    expect(lines[0].dateText).toBe("2026-09-01");
  });

  it("calls a line his when his words stand behind it", () => {
    expect(lines[0].voice).toBe("his");
  });

  it("calls a marked line inferred whatever its evidence says", () => {
    expect(lines[1].voice).toBe("inferred");
  });

  it("calls a line with no evidence file entry unattributed", () => {
    expect(lines[2].voice).toBe("unattributed");
    expect(lines[2].at).toBeNull();
    expect(lines[2].evidence).toEqual([]);
  });

  // A map line read off the code is a fact about the system. It is not his
  // words and it is not an inference about him, and the page must not say
  // either of those.
  it("calls a line whose only evidence was read off the code unattributed", () => {
    const read = parseModelOfTomPage({
      path: "model-of-tom/agent-rules.md",
      body: "## Jobs\n\n- The digest runs every morning.",
      evidence: [
        "## Jobs",
        "",
        "- line: The digest runs every morning.",
        "  read: 2026-09-12 · a branch · the cron says so.",
      ].join("\n"),
      kind: "standing-rule",
    });
    expect(read[0].voice).toBe("unattributed");
    expect(read[0].at).toBe(Date.UTC(2026, 8, 12));
  });

  it("calls a line a paraphrase of his words his", () => {
    const paraphrased = parseModelOfTomPage({
      path: "model-of-tom/intent.md",
      body: "## What to protect\n\n- He is never observed while he works.",
      evidence: [
        "## What to protect",
        "",
        "- line: He is never observed while he works.",
        "  paraphrase: 2026-08-19 · a session · observation was tested and failed for him.",
      ].join("\n"),
      kind: "direction",
    });
    expect(paraphrased[0].voice).toBe("his");
  });

  it("gives a line whose wording drifted from the evidence no evidence", () => {
    const drifted = parseModelOfTomPage({
      path: "model-of-tom/intent.md",
      body: "## What to protect\n\n- The test system keeps working, mostly.",
      evidence,
      kind: "direction",
    });
    expect(drifted[0].evidence).toEqual([]);
    expect(drifted[0].voice).toBe("unattributed");
  });
});

describe("parseBlockList", () => {
  it("reads a folded value as one line", () => {
    const blocks = parseBlockList(
      [
        "- id: first",
        "  kind: preference",
        "  correction: >-",
        "    say it plainly,",
        "    and say it once",
        "- id: second",
        "  correction: short",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.fields.id)).toEqual(["first", "second"]);
    expect(blocks[0].fields.correction).toBe("say it plainly, and say it once");
    expect(blocks[0].line).toBe(1);
    expect(blocks[1].line).toBe(6);
  });

  it("ends a block at a line that is not indented", () => {
    const blocks = parseBlockList("- id: first\n  correction: a\n\n## Heading\n\n- id: second\n  correction: b");
    expect(blocks).toHaveLength(2);
    expect(blocks[1].fields.correction).toBe("b");
  });
});

describe("parseSteering", () => {
  const body = [
    "# steering",
    "",
    "- id: say-it-once",
    "  kind: preference",
    "  owner: tom",
    "  created: 2026-08-25",
    "  trigger: >-",
    "    any explanation written for him",
    "  correction: >-",
    "    Define every term on first use.",
    "  incidents: 0",
    "",
    "- id: someone-elses",
    "  kind: gotcha",
    "  owner: raha",
    "  created: 2026-08-26",
    "  correction: Not his taste.",
  ].join("\n");

  it("takes the correction as the rule and the trigger as its evidence", () => {
    const lines = parseSteering({ path: "vqc/steering.yaml", body });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: "standing-rule",
      text: "Define every term on first use.",
      section: "preference",
      voice: "his",
      source: "vqc/steering.yaml",
      locator: "say-it-once",
      dateText: "2026-08-25",
    });
    expect(lines[0].at).toBe(Date.UTC(2026, 7, 25));
    expect(lines[0].evidence).toEqual([
      { form: "trigger", text: "any explanation written for him", date: "2026-08-25" },
    ]);
  });

  it("leaves out an entry owned by anyone but him", () => {
    expect(parseSteering({ path: "vqc/steering.yaml", body }).map((line) => line.locator))
      .not.toContain("someone-elses");
  });
});

describe("parseAdoptionRulings", () => {
  const body = [
    "# adoption",
    "",
    "## Cadences",
    "",
    "- id: not-a-ruling",
    "  ruling: outside the log",
    "",
    "## Rulings log (append-only: id, date, question, ruling, cites)",
    "",
    "- id: one-home",
    "  date: 2026-08-27",
    "  question: Where does the shared helper live?",
    "  ruling: One home for it, and the layering aesthetic",
    "    loses.",
    "  cites: [C1, D5]",
  ].join("\n");

  it("reads only the rulings log, and carries the question as evidence", () => {
    const lines = parseAdoptionRulings({ path: "vqc/adoption.md", body });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: "ruling",
      text: "One home for it, and the layering aesthetic loses.",
      section: "Rulings log",
      voice: "his",
      locator: "line 10",
      dateText: "2026-08-27",
    });
    expect(lines[0].evidence.map((entry) => entry.form)).toEqual(["question", "cites"]);
  });

  it("returns nothing when the file has no rulings log", () => {
    expect(parseAdoptionRulings({ path: "vqc/adoption.md", body: "# adoption\n\n- id: x\n  ruling: y" }))
      .toEqual([]);
  });
});

describe("parseSpecRevisions", () => {
  const body = [
    "# spec",
    "",
    "**Revision (2026-08-27, implementation collaboration):** His rulings applied — the readiness tiers were reshaped.",
    "",
    "**Revision (undated):** not a dated note.",
    "",
    "Prose that mentions a revision but is not one.",
  ].join("\n");

  it("takes each dated note with its label as the section", () => {
    const lines = parseSpecRevisions({ path: "tts/spec.md", body });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: "ruling",
      section: "implementation collaboration",
      locator: "line 3",
      dateText: "2026-08-27",
      voice: "his",
    });
    expect(lines[0].text.startsWith("His rulings applied")).toBe(true);
  });
});

describe("parseRepoRules", () => {
  it("names the repository and the file, and claims nothing about whose words they are", () => {
    const lines = parseRepoRules({
      repo: "tom.quest",
      path: "app/AGENTS.md",
      body: "# app\n\n## ui\n\n- Nothing moves unexpectedly.",
    });
    expect(lines).toEqual([
      {
        id: "tom.quest app/AGENTS.md#5",
        kind: "standing-rule",
        text: "Nothing moves unexpectedly.",
        section: "ui",
        voice: "unattributed",
        source: "tom.quest app/AGENTS.md",
        locator: "line 5",
        at: null,
        dateText: null,
        evidence: [],
      },
    ]);
  });
});
