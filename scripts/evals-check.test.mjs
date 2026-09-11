import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  gate,
  goldenItemRule,
  matchesWatched,
  noItemTrailer,
  report,
  POLL_TIMEOUT_MS,
  WATCHED_PATHS,
} from "./evals-check.mjs";

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

  // gate() routes an unconfirmed failure out of `regressions` on purpose. The
  // summary line is where that state stops being invisible in the CI log.
  it("says how many failures went to unconfirmed, in the summary line", () => {
    const head = run({ pass: 1, fail: 2, failures: [
      failure("explanation-n1", { confirmed: false }),
      failure("explanation-n2", { confirmed: false }),
    ] });
    const base = run({ sha: "9f8e7d6c" });
    const lines = report(head, base, gate(head, base));
    expect(lines[lines.length - 1]).toBe("PASSED: 0 regressions. 2 unconfirmed failures reported, not gated.");
  });

  it("fails a run the box could not make, rather than reading no failures off it", () => {
    const head = run({ items: 0, pass: 0, fail: 0, scoredIds: [], error: "could not fetch deadbeef" });
    const verdict = gate(head, null);
    expect(verdict).toMatchObject({ ok: false, reason: "could not fetch deadbeef" });
    expect(report(head, null, verdict).join("\n")).toContain("FAILED: the run could not be made");
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

  it("prints one line for a clean check, and says the flaky count even at zero", () => {
    const head = run();
    const lines = report(head, run({ sha: "9f8e7d6c" }), gate(head, run({ sha: "9f8e7d6c" })));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("3 pass, 0 fail, 0 regressions, 0 flaky.");
  });

  // Flaky is reported and never gated: an item that passed one head trial and
  // failed another is a pass, in no failure list, and the count is how the
  // check says the set moved on its own.
  it("prints the flaky count from the golden items and the repo tasks together", () => {
    const head = run({ flaky: 1, tasks: { failures: [], flaky: 2 } });
    const verdict = gate(head, run({ sha: "9f8e7d6c" }));
    expect(verdict.ok).toBe(true);
    expect(report(head, run({ sha: "9f8e7d6c" }), verdict)[0]).toContain("0 regressions, 3 flaky.");
  });

  it("watches the paths the two workflows fire on", () => {
    expect(WATCHED_PATHS).toContain("model-of-tom/**");
    expect(WATCHED_PATHS).toContain("evals/golden/**");
  });

  // A capability item is one that asks whether the system can now do a thing
  // it could not do before. gate() partitions on WHAT THE BASE RUN DID, never
  // on what the item calls itself, and this pins that: a capability the base
  // proved and the head lost is a regression like any other. A gate that read
  // `kind` would open a hole one week wide after every fix, until the weekly
  // graduation pass rewrote the label.
  it("counts a capability item that passed in base and fails in head as a regression", () => {
    const scoredIds = ["one", "two", "cap-delegate-refusal"];
    const head = run({
      pass: 2,
      fail: 1,
      scoredIds,
      failures: [failure("cap-delegate-refusal", { kind: "capability" })],
    });
    const base = run({ sha: "9f8e7d6c", scoredIds });
    const verdict = gate(head, base);
    expect(verdict.ok).toBe(false);
    expect(verdict.regressions.map((one) => one.id)).toEqual(["cap-delegate-refusal"]);
    expect(verdict.newFailing).toEqual([]);
  });

  // MEASURED on PR #170 (2026-09-11): ~50 minutes for 29 items plus a clone
  // and two worktrees. A wait shorter than that fails the check on silence
  // while the run is still going, and the re-run pays the cost again.
  it("waits longer than the slowest run the box has actually taken", () => {
    expect(POLL_TIMEOUT_MS).toBeGreaterThanOrEqual(75 * 60 * 1000);
    // Repo-root-relative, the spelling convex/claudeSessions.test.ts uses:
    // vitest runs from the root and import.meta.url is rewritten by the
    // transform.
    const workflow = readFileSync(".github/workflows/evals.yml", "utf8");
    const jobTimeout = Number(/timeout-minutes:\s*(\d+)/.exec(workflow)?.[1]);
    // A job timeout below the wait kills the check before its own deadline and
    // reports a job failure instead of the box's silence.
    expect(jobTimeout).toBeGreaterThan(POLL_TIMEOUT_MS / 60_000);
  });
});

describe("matchesWatched", () => {
  it("takes each of the three forms the list is written in", () => {
    // exact
    expect(matchesWatched("scripts/prelude.mjs")).toBe(true);
    expect(matchesWatched("scripts/prelude.test.mjs")).toBe(false);
    // a leading ** — the name anywhere, including at the root
    expect(matchesWatched("worker/AGENTS.md")).toBe(true);
    expect(matchesWatched("convex/deep/nested/CLAUDE.md")).toBe(true);
    expect(matchesWatched("AGENTS.md")).toBe(true);
    expect(matchesWatched("docs/NOT-AGENTS.md")).toBe(false);
    // a trailing ** — anything under the directory, at any depth
    expect(matchesWatched("model-of-tom/intent.md")).toBe(true);
    expect(matchesWatched("evals/golden/runs/2026-09-11.json")).toBe(true);
    expect(matchesWatched("model-of-tom-old/intent.md")).toBe(false);
  });

  it("answers false for what is not a path at all", () => {
    expect(matchesWatched(undefined)).toBe(false);
    expect(matchesWatched("")).toBe(false);
    expect(matchesWatched(12)).toBe(false);
  });

  // The two lists are one fact spelled twice, and they had already drifted:
  // the workflow fired on paths WATCHED_PATHS had never heard of and missed
  // one it watched. This is the pin. A generated workflow file would be a file
  // nobody can read in a pull request; a failing test names the drift in a
  // line.
  it("is the same list as the workflow's paths:, in the same order", () => {
    // \r? throughout: a Windows checkout hands this file back with CRLF, and a
    // test that only reads LF passes on the box and fails on Tom's laptop.
    const workflow = readFileSync(".github/workflows/evals.yml", "utf8");
    const block = /\r?\n {4}paths:\r?\n((?:[ \t]+- ".*"\r?\n)+)/.exec(workflow);
    expect(block).not.toBe(null);
    const paths = [...block[1].matchAll(/- "([^"]+)"/g)].map((hit) => hit[1]);
    expect(paths).toEqual(WATCHED_PATHS);
  });
});

describe("noItemTrailer", () => {
  it("reads the reason off its own line, anywhere in the body", () => {
    expect(noItemTrailer("Lands the narrow.\n\nevals: no-item pure deletion, no new behaviour\n")).toBe(
      "pure deletion, no new behaviour",
    );
    expect(noItemTrailer("evals:no-item   a typo fix in a comment  ")).toBe("a typo fix in a comment");
    expect(noItemTrailer("EVALS: NO-ITEM shouting still counts")).toBe("shouting still counts");
  });

  it("does not read a hatch that a sentence is merely describing", () => {
    expect(noItemTrailer("Put `evals: no-item <reason>` on the body if you owe none.")).toBe(null);
    expect(noItemTrailer("evals: no-item")).toBe(null);
    expect(noItemTrailer(undefined)).toBe(null);
  });
});

describe("the golden-item rule", () => {
  const WATCHED = ["model-of-tom/intent.md"];

  it("answers null when no diff was supplied — a weekly or by-hand run", () => {
    expect(goldenItemRule(undefined, "")).toBe(null);
    expect(goldenItemRule(null, "")).toBe(null);
    const verdict = gate(run(), run({ sha: "9f8e7d6c" }));
    expect(verdict.goldenCoverage).toBe(null);
    expect(verdict.ok).toBe(true);
  });

  it("answers true when nothing watched changed", () => {
    expect(goldenItemRule(["app/page.tsx", "README.md"], "")).toBe(true);
    expect(goldenItemRule([], "")).toBe(true);
  });

  it("answers false when a watched file changed and no item shipped", () => {
    expect(goldenItemRule(WATCHED, "A body with no hatch in it.")).toBe(false);
  });

  it("is satisfied by an item under evals/golden or evals/triggers", () => {
    expect(goldenItemRule([...WATCHED, "evals/golden/runs/x.json"], "")).toBe(true);
    expect(goldenItemRule([...WATCHED, "evals/triggers/delegate-refusal.md"], "")).toBe(true);
  });

  it("is excused by the trailer, and the check prints the reason it gave", () => {
    const head = run();
    const base = run({ sha: "9f8e7d6c" });
    const verdict = gate(head, base, {
      changed: WATCHED,
      prBody: "Reworded one paragraph.\n\nevals: no-item wording only, no rule changed\n",
    });
    expect(verdict).toMatchObject({ ok: true, goldenCoverage: true });
    const lines = report(head, base, verdict).join("\n");
    expect(lines).toContain("golden item excused: wording only, no rule changed");
  });

  it("fails the check, names what is owed and the escape hatch", () => {
    const head = run();
    const base = run({ sha: "9f8e7d6c" });
    const verdict = gate(head, base, { changed: WATCHED, prBody: "" });
    expect(verdict).toMatchObject({ ok: false, goldenCoverage: false, regressions: [] });
    const lines = report(head, base, verdict);
    expect(lines.join("\n")).toContain("NO GOLDEN ITEM");
    expect(lines.join("\n")).toContain("evals/golden/** or evals/triggers/**");
    // Zero regressions and still a failure: the summary has to say which.
    expect(lines[lines.length - 1]).toBe(
      "FAILED: a watched context file changed and no golden item shipped with it.",
    );
  });

  // Every verdict shape carries the field, so no caller reads `undefined` and
  // has to guess whether that meant "no" or "never asked".
  it("carries coverage on the early-return verdicts too", () => {
    expect(gate(null, run(), { changed: WATCHED, prBody: "" }).goldenCoverage).toBe(false);
    const broken = run({ items: 0, pass: 0, fail: 0, scoredIds: [], error: "could not fetch deadbeef" });
    expect(gate(broken, null, { changed: [], prBody: "" }).goldenCoverage).toBe(true);
  });
});
