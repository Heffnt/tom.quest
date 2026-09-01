// Tests for the pure halves of scripts/grade-writing-standard.mjs — the parts
// that decide WHAT is sent to the model and WHAT is believed of the answer.
// The model call itself is not exercised here: it costs money and returns a
// different answer every time, which is the whole reason its count is
// advisory rather than a ratchet.
import { describe, expect, it } from "vitest";
import {
  RULES,
  buildPrompt,
  planCalls,
  parseVerdicts,
  proseOf,
  unitsFrom,
} from "./grade-writing-standard.mjs";

const HTML = `<!DOCTYPE html><html><head><style>body{color:#e2e8f0}</style></head>
<body><h1>A title</h1><p>The batch &amp; its todos.</p></body></html>`;

describe("proseOf", () => {
  // witness: delete the <style> replacement and the CSS comes through.
  it("drops the style block, the markup, and the entities of an explanation", () => {
    const prose = proseOf(HTML, "ground-up explanation");
    expect(prose).not.toContain("#e2e8f0");
    expect(prose).not.toContain("<h1>");
    expect(prose).toContain("A title");
    expect(prose).toContain("The batch & its todos.");
  });

  // witness: make proseOf strip markup for briefs too and this fails — a brief
  // is markdown, and stripping "<" spans out of markdown loses real prose.
  it("leaves a brief alone", () => {
    expect(proseOf("  A brief with *markdown*.  ", "brief")).toBe(
      "A brief with *markdown*.",
    );
  });
});

describe("unitsFrom", () => {
  // witness: make unitsFrom return one unit per todo instead of one per stored
  // piece of prose, and the todo carrying both stops being graded twice.
  it("yields one unit per stored brief and one per stored explanation", () => {
    const units = unitsFrom([
      { _id: "a", statement: "both", brief: "b", groundUpExplanation: HTML },
      { _id: "b", statement: "brief only", brief: "b" },
      { _id: "c", statement: "explanation only", groundUpExplanation: HTML },
      { _id: "d", statement: "neither", brief: "   ", groundUpExplanation: "" },
    ]);
    expect(units.map((u) => `${u.todoId}:${u.kind}`)).toEqual([
      "a:brief",
      "a:ground-up explanation",
      "b:brief",
      "c:ground-up explanation",
    ]);
  });
});

describe("planCalls", () => {
  const unit = (n, size) => ({ todoId: String(n), prose: "x".repeat(size) });

  // witness: drop the maxChars term from the split condition and one call
  // carries the whole corpus.
  it("splits on the character budget", () => {
    const calls = planCalls([unit(1, 900), unit(2, 900), unit(3, 900)], {
      maxChars: 1000,
      maxUnits: 6,
    });
    expect(calls.map((c) => c.length)).toEqual([1, 1, 1]);
  });

  // witness: drop the maxUnits term and this becomes one call of five.
  it("splits on the unit count even when every unit is tiny", () => {
    const calls = planCalls([1, 2, 3, 4, 5].map((n) => unit(n, 10)), {
      maxChars: 10000,
      maxUnits: 2,
    });
    expect(calls.map((c) => c.length)).toEqual([2, 2, 1]);
  });

  // witness: return early on an over-budget single unit and it is never graded.
  it("never drops a unit larger than the whole budget", () => {
    const calls = planCalls([unit(1, 50000)], { maxChars: 1000, maxUnits: 6 });
    expect(calls).toHaveLength(1);
    expect(calls[0][0].todoId).toBe("1");
  });
});

describe("buildPrompt", () => {
  // witness: paste a copy of the standard into the script instead of passing
  // the served one in, and this stops proving the served text is what is used.
  it("carries the served writing standard and the unit prose", () => {
    const prompt = buildPrompt(
      [{ todoId: "a", kind: "brief", statement: "the line", prose: "the prose" }],
      { writingStandard: "STANDARD-MARKER", rules: RULES.slice(0, 1) },
    );
    expect(prompt).toContain("STANDARD-MARKER");
    expect(prompt).toContain("the prose");
    expect(prompt).toContain("artifact-not-described");
    expect(prompt).toContain("UNIT 1");
  });
});

describe("parseVerdicts", () => {
  const batch = [
    { todoId: "a", kind: "brief", statement: "one" },
    { todoId: "b", kind: "ground-up explanation", statement: "two" },
  ];
  const ids = ["artifact-not-described", "vague-reference"];

  // witness: return every row instead of the ones with rules, and units that
  // passed appear in the failing list.
  it("keeps only units the model flagged, keyed back to their todo", () => {
    const answer = `\`\`\`json
{"units":[{"unit":1,"rules":[]},{"unit":2,"rules":[{"id":"vague-reference","quote":"it","reason":"no referent"}]}]}
\`\`\``;
    const findings = parseVerdicts(answer, batch, ids);
    expect(findings).toHaveLength(1);
    expect(findings[0].todoId).toBe("b");
    expect(findings[0].rules[0].id).toBe("vague-reference");
  });

  // witness: drop the range check and a hallucinated unit number crashes the
  // run or, worse, files a finding against the wrong todo.
  it("drops unit numbers and rule ids the model invented", () => {
    const answer =
      '{"units":[{"unit":9,"rules":[{"id":"vague-reference"}]},' +
      '{"unit":1,"rules":[{"id":"tone-is-wrong","quote":"x"}]}]}';
    expect(parseVerdicts(answer, batch, ids)).toEqual([]);
  });
});
