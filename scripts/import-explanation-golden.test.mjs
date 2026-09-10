import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXPECTED_EXAMPLES, parseExplanationExamples } from "./import-explanation-golden.mjs";

// The mined source is raw session evidence and is not in the repo. When it is
// reachable the parse itself is tested; the checked-in corpus is tested either
// way, because that is what the runner actually reads.
const source = process.env.EXPLANATION_EXAMPLES_SOURCE ??
  "C:/Users/heffn/AppData/Local/Temp/claude/C--Users-heffn-Desktop-tom-quest--claude-worktrees-unified-agent-context-fa13a6/f15926cf-9201-40fb-9367-e40d223c31f4/scratchpad/uac/explanation-examples.md";
const goldenDir = "evals/golden/explanations";

const items = readdirSync(goldenDir)
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(join(goldenDir, file), "utf8")));

describe("explanation golden importer", () => {
  it("parses every labelled example, with Tom's own reaction as the sentence", () => {
    if (!existsSync(source)) return;
    const entries = parseExplanationExamples(readFileSync(source, "utf8"), source);
    expect(entries).toHaveLength(EXPECTED_EXAMPLES);
    expect(entries.filter((entry) => entry.label === "landed")).toHaveLength(12);
    expect(entries.filter((entry) => entry.label === "did not")).toHaveLength(15);
    expect(entries[0]).toMatchObject({
      id: "explanation-p1",
      source: "explanation",
      job: "explanation",
      partition: "explanation/ComplexMultiTrigger",
      label: "landed",
      confirmedByTom: false,
      input: { topic: "How pooled AUROC is computed", contextLines: ["Date: 2026-08-09", "Project: ComplexMultiTrigger"] },
    });
    expect(entries[0].sentence.startsWith("Okay, that makes sense.")).toBe(true);
  });

  it("never puts the label sentence inside the judged output", () => {
    if (!existsSync(source)) return;
    for (const entry of parseExplanationExamples(readFileSync(source, "utf8"), source)) {
      expect(entry.output.explanation).not.toContain(entry.sentence);
    }
  });

  it("keeps a complete checked-in corpus in the golden-item shape", () => {
    expect(items).toHaveLength(EXPECTED_EXAMPLES);
    expect(items.filter((item) => item.label === "landed")).toHaveLength(12);
    for (const item of items) {
      expect(item.id).toMatch(/^explanation-[pn]\d+$/);
      expect(item.partition.startsWith("explanation/")).toBe(true);
      expect(item.confirmedByTom).toBe(false);
      expect(item.sentence.length).toBeGreaterThan(0);
      expect(item.output.explanation.length).toBeGreaterThan(0);
      expect(item.ruledOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(new Set(items.map((item) => item.id)).size).toBe(EXPECTED_EXAMPLES);
  });
});
