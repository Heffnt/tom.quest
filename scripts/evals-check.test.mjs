import { describe, expect, it } from "vitest";
import { gate, report, WATCHED_PATHS } from "./evals-check.mjs";

const failure = (id, over = {}) => ({ id, partition: "prepare/chores", verdict: "revise", reason: `${id} reason`, confirmed: true, ...over });

const run = (over = {}) => ({
  repo: "tom.quest",
  sha: "a1b2c3d4e5f6",
  goldenHash: "3f9c1a22b0de",
  items: 3,
  pass: 3,
  fail: 0,
  scoredIds: ["one", "two", "three"],
  failures: [],
  tasks: { items: 0, pass: 0, fail: 0, failures: [] },
  ...over,
});

describe("gate", () => {
  it("fails on an item that passes in base and fails in head, and names it", () => {
    const head = run({ pass: 2, fail: 1, failures: [failure("one")] });
    const verdict = gate(head, run({ sha: "9f8e7d6c" }));
    expect(verdict.ok).toBe(false);
    expect(verdict.regressions.map((one) => one.id)).toEqual(["one"]);
    const lines = report(head, run({ sha: "9f8e7d6c" }), verdict).join("\n");
    expect(lines).toContain("REGRESSION  one");
    expect(lines).toContain("FAILED: 1 regression.");
  });

  it("passes an item failing in both, and prints it under still failing", () => {
    const head = run({ pass: 2, fail: 1, failures: [failure("one")] });
    const base = run({ sha: "9f8e7d6c", pass: 2, fail: 1, failures: [failure("one")] });
    const verdict = gate(head, base);
    expect(verdict.ok).toBe(true);
    expect(verdict.stillFailing.map((one) => one.id)).toEqual(["one"]);
    expect(report(head, base, verdict).join("\n")).toContain("still failing  one");
  });

  it("passes with no baseline when the base run is missing", () => {
    const head = run({ pass: 2, fail: 1, failures: [failure("one")] });
    const verdict = gate(head, null);
    expect(verdict).toMatchObject({ ok: true, noBaseline: true });
    expect(verdict.newFailing.map((one) => one.id)).toEqual(["one"]);
    expect(report(head, null, verdict).join("\n")).toContain("no baseline for the base commit");
  });
});

describe("gate, continued", () => {
  it("fails on a golden-set hash mismatch and says how to re-run the base", () => {
    const head = run();
    const base = run({ sha: "9f8e7d6c", goldenHash: "0000deadbeef" });
    const verdict = gate(head, base);
    expect(verdict).toMatchObject({ ok: false, mismatch: true });
    const lines = report(head, base, verdict).join("\n");
    expect(lines).toContain("GOLDEN SET MISMATCH");
    expect(lines).toContain("--repo tom.quest --sha 9f8e7d6c --force");
  });

  it("prints fixed for an item that fails in base and passes in head", () => {
    const head = run();
    const base = run({ sha: "9f8e7d6c", pass: 2, fail: 1, failures: [failure("one")] });
    const verdict = gate(head, base);
    expect(verdict.ok).toBe(true);
    expect(verdict.fixed.map((one) => one.id)).toEqual(["one"]);
    expect(report(head, base, verdict).join("\n")).toContain("fixed  one");
  });

  it("reports but never fails on an item Tom has not confirmed", () => {
    const head = run({ pass: 2, fail: 1, failures: [failure("explanation-n1", { confirmed: false, partition: "explanation/WikiTom" })] });
    const verdict = gate(head, run({ sha: "9f8e7d6c" }));
    expect(verdict.ok).toBe(true);
    expect(verdict.regressions).toEqual([]);
    expect(report(head, run({ sha: "9f8e7d6c" }), verdict).join("\n")).toContain("unconfirmed  explanation-n1");
  });

  it("counts an item head scored and base never did as new, not as a regression", () => {
    const head = run({ pass: 2, fail: 1, scoredIds: ["one", "two", "three", "four"], failures: [failure("four")] });
    const verdict = gate(head, run({ sha: "9f8e7d6c" }));
    expect(verdict).toMatchObject({ ok: true });
    expect(verdict.newFailing.map((one) => one.id)).toEqual(["four"]);
  });

  it("fails when there is no head run at all", () => {
    expect(gate(null, run())).toMatchObject({ ok: false, reason: "no head run" });
  });

  it("takes a repo task's failure through the same rule", () => {
    const scoredIds = ["one", "two", "three", "slack-01-morning"];
    const head = run({ scoredIds, tasks: { items: 1, pass: 0, fail: 1, failures: [failure("slack-01-morning", { partition: "task/slack" })] } });
    const base = run({ sha: "9f8e7d6c", scoredIds });
    expect(gate(head, base).regressions.map((one) => one.id)).toEqual(["slack-01-morning"]);
  });

  it("prints one line for a clean check", () => {
    const head = run();
    const lines = report(head, run({ sha: "9f8e7d6c" }), gate(head, run({ sha: "9f8e7d6c" })));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("3 pass, 0 fail, 0 regressions.");
  });

  it("watches the paths the two workflows fire on", () => {
    expect(WATCHED_PATHS).toContain("model-of-tom/**");
    expect(WATCHED_PATHS).toContain("evals/golden/**");
  });
});
