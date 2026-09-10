import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  MERGE_AMBIGUOUS_DENIAL,
  MERGE_CHAINED_DENIAL,
  mergeAllowedRow,
  mergeCommandOf,
  mergeDenial,
  mergeUnreadableDenial,
} from "../merge-gate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sessionSource = fs.readFileSync(path.join(here, "..", "session.mjs"), "utf8");

const ONE = [{ repo: "tom.quest", dir: "/var/cache/tts/sessions/s1/tom.quest" }];
const TWO = [
  { repo: "tom.quest", dir: "/var/cache/tts/sessions/s1/tom.quest" },
  { repo: "WikiTom", dir: "/var/cache/tts/sessions/s1/WikiTom" },
];

describe("mergeCommandOf", () => {
  it("is null for everything that is not a merge, so ordinary work pays nothing", () => {
    for (const command of [
      "pnpm test",
      "git commit -m 'merge the two lists'",
      "git log --merges",
      "gh pr create --fill",
      "grep -rn merge convex/",
      "git rebase main",
    ]) {
      expect(mergeCommandOf(command, { checkouts: ONE }), command).toBe(null);
    }
  });

  it("catches both spellings Tom named, and the -C form a multi-repo session must use", () => {
    expect(mergeCommandOf("git merge main", { checkouts: ONE })).toEqual({
      repo: "tom.quest",
      dir: ONE[0].dir,
    });
    expect(mergeCommandOf("gh pr merge 42 --squash", { checkouts: ONE })).toEqual({
      repo: "tom.quest",
      dir: ONE[0].dir,
    });
    expect(
      mergeCommandOf(`git -C ${TWO[1].dir} merge --ff-only origin/main`, { checkouts: TWO }),
    ).toEqual({ repo: "WikiTom", dir: TWO[1].dir });
  });

  // `git merge` carries NO danger fingerprint, so before this it took the
  // zero-latency path and was never seen at all. That is the hole the gate
  // closes, and it is worth a test of its own.
  it("sees a plain `git merge`, which no danger fingerprint ever matched", () => {
    expect(mergeCommandOf("git merge --no-ff session/abc", { checkouts: ONE })).not.toBe(null);
  });

  it("refuses a merge buried in a longer command line", () => {
    for (const command of [
      "git merge main && git push origin main",
      "git merge main; rm -rf /",
      "git merge main | tee log",
      "git merge $(git rev-parse HEAD~1)",
    ]) {
      expect(mergeCommandOf(command, { checkouts: ONE }), command).toEqual({ chained: true });
    }
  });

  it("keeps a semicolon inside a quoted message from reading as a chain", () => {
    expect(
      mergeCommandOf("git merge main -m 'lands the gate; reports the merge'", { checkouts: ONE }),
    ).toEqual({ repo: "tom.quest", dir: ONE[0].dir });
  });

  it("asks a multi-checkout session which repository it means", () => {
    expect(mergeCommandOf("git merge main", { checkouts: TWO })).toEqual({ ambiguous: true });
  });
});

describe("what a denied session is told", () => {
  const gate = {
    repo: "tom.quest",
    sha: "a1b2c3d4e5f6",
    allowed: false,
    missing: ["audit", "evals"],
    checks: [
      { name: "tests", passed: true, why: "the tests are green at a1b2c3d" },
      { name: "audit", passed: false, why: "no audit verdict is recorded for a1b2c3d" },
      { name: "evals", passed: false, why: "no evals run scored a1b2c3d" },
    ],
  };

  it("names which of the three are missing, and how each is satisfied", () => {
    const text = mergeDenial(gate);
    expect(text).toContain("missing audit, evals");
    expect(text).toContain("no audit verdict is recorded");
    expect(text).toContain("no evals run scored");
    expect(text).toContain("VERDICT: APPROVED");
    // Not the one that passed: a deny message that lists work already done is
    // a deny message a session redoes work against.
    expect(text).not.toContain("the tests are green");
  });

  it("says the same three words the prompt and the morning line use", () => {
    for (const word of ["tests", "audit", "evals"]) {
      expect(mergeDenial({ missing: [word], checks: [] })).toContain(word);
    }
  });

  it("has a sentence for a chained merge, an ambiguous one, and an unread gate", () => {
    expect(MERGE_CHAINED_DENIAL).toContain("its own command");
    expect(MERGE_AMBIGUOUS_DENIAL).toContain("git -C");
    expect(mergeUnreadableDenial("timeout")).toContain("timeout");
    // FAIL-CLOSED: an unread gate denies. The word "denied" is the contract.
    expect(mergeUnreadableDenial("timeout").startsWith("denied")).toBe(true);
  });

  it("says WHY a merge was allowed, not only that it was", () => {
    const row = mergeAllowedRow({
      repo: "tom.quest",
      sha: "a1b2c3d4e5f6",
      checks: [
        { name: "tests", passed: true, why: "the tests are green at a1b2c3d" },
        { name: "audit", passed: true, why: "the audit approved a1b2c3d" },
        { name: "evals", passed: true, why: "the evals scored a1b2c3d with no regression" },
      ],
    });
    expect(row).toContain("tom.quest a1b2c3d");
    expect(row).toContain("the tests are green");
    expect(row).toContain("the audit approved");
    expect(row).toContain("no regression");
  });
});

// The daemon's own wiring, read from its source: session.mjs needs the Agent
// SDK to import, so the checks that matter are structural (banned-tools.test
// .mjs's pattern).
describe("the daemon's wiring", () => {
  it("rules on a merge BEFORE the danger fingerprint, not after it", () => {
    const merge = sessionSource.indexOf("const merge = mergeCommandOf(command, {");
    const tier2 = sessionSource.indexOf("if (BASH_DANGER_RE.test(command)) {");
    expect(merge).toBeGreaterThan(-1);
    expect(tier2).toBeGreaterThan(-1);
    expect(merge).toBeLessThan(tier2);
  });

  it("no longer tells the classifier that merging is Tom's gate", () => {
    expect(sessionSource).not.toContain("merging is Tom's gate");
  });

  it("reads the gate with the worker key and denies on anything it cannot read", () => {
    const body = sessionSource.slice(sessionSource.indexOf("async #mergeDenialFor("));
    expect(body).toContain("/tts/merge-gate");
    expect(body).toContain('"X-TTS-Key": this.env.TTS_WORKER_KEY');
    expect(body).toContain("mergeUnreadableDenial");
    expect(body).toContain("rev-parse");
  });
});
