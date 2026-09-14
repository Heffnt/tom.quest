import { describe, expect, it } from "vitest";
import { checkPrivatePaths, privatePathFindings } from "./check-private-paths.mjs";

describe("private path guardrail", () => {
  it("allows the two public know triggers and ordinary eval files", () => {
    expect(privatePathFindings([
      "evals/triggers/skill-know-intent.json",
      "evals/triggers/skill-know-week.json",
      "evals/triggers/layer-know.json",
      "evals/golden/runs/example.json",
    ])).toEqual([]);
  });

  it("rejects every know-area trigger spelling and the forbidden private paths", () => {
    expect(privatePathFindings([
      "evals\\triggers\\skill-know-research.json",
      "model-of-tom/areas/money.md",
      "evals/snapshots/areas/social.json",
      "evals/private/raw.json",
    ])).toEqual([
      { file: "evals/private/raw.json", rule: "private eval fixture directory" },
      { file: "evals/snapshots/areas/social.json", rule: "area-page copy under evals" },
      { file: "evals/triggers/skill-know-research.json", rule: "private know-area trigger" },
      { file: "model-of-tom/areas/money.md", rule: "model-of-tom area page" },
    ]);
  });

  it("checks only the tracked paths supplied by git", () => {
    const run = (_file, args, options) => {
      expect(args).toEqual(["ls-files", "-z"]);
      expect(options.encoding).toBe("utf8");
      return "evals/triggers/skill-know-health-and-food.json\0README.md\0";
    };
    expect(checkPrivatePaths(run)).toEqual([
      { file: "evals/triggers/skill-know-health-and-food.json", rule: "private know-area trigger" },
    ]);
  });
});
