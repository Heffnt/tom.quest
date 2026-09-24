import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test/temp.mjs";
import { noItemTrailer as rowTrailer } from "../shared/evals-row.mjs";
import {
  COVERAGE_NOT_REQUIRED,
  changedPathsFromGit,
  gate,
  goldenItemRule,
  matchesWatched,
  noItemTrailer,
  report,
  POLL_TIMEOUT_MS,
  unaffectedBy,
  waitForEvals,
  WATCHED_PATHS,
  costLine,
  JOB_INPUTS,
  SLOW_RUN_MS,
  jobsAffectedBy,
  SHARED_PROMPT_INPUTS,
} from "./evals-check.mjs";

const failure = (id, over = {}) => ({ id, partition: "prepare/chores", verdict: "revise", reason: `${id} reason`, confirmed: true, ...over });

const run = (over = {}) => {
  const scoredIds = over.scoredIds ?? ["one", "two", "three"];
  return {
    repo: "tom.quest",
    sha: "a1b2c3d4e5f6",
    goldenHash: "3f9c1a22b0de",
    items: 3,
    pass: 3,
    fail: 0,
    scoredIds,
    scoredHashes: over.scoredHashes ?? Object.fromEntries(scoredIds.map((id) => [id, `hash-${id}`])),
    failures: [],
    tasks: { items: 0, pass: 0, fail: 0, failures: [] },
    ...over,
  };
};

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

  it("fails partial runner errors without also reporting them as still failing", () => {
    const head = run({ pass: 26, fail: 3, items: 29, failures: [failure("one", { errored: true }), failure("two", { errored: true }), failure("three", { errored: true })] });
    const base = run({ sha: "9f8e7d6c", items: 29, pass: 29, scoredIds: Array.from({ length: 29 }, (_, i) => `item-${i}`) });
    const verdict = gate(head, base);
    expect(verdict).toMatchObject({ ok: false, regressions: [] });
    expect(verdict.stillFailing).toHaveLength(0);
    expect(report(head, base, verdict).join("\n")).not.toContain("still failing");
    expect(report(head, base, verdict).at(-1)).toBe("FAILED: 3 errored.");
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
  it("allows a head whose scored set is the base plus a new item", () => {
    const head = run({
      scoredIds: ["one", "two", "three", "four"],
      goldenHash: "added-item-hash",
    });
    const base = run({ sha: "9f8e7d6c" });
    expect(gate(head, base)).toMatchObject({ ok: true, mismatch: false });
    expect(report(head, base, gate(head, base)).join("\n")).toContain("new scored items: four");
  });

  it("reports base-only items as removed without treating them as regressions", () => {
    const head = run({
      scoredIds: ["one", "two"],
    });
    const base = run({ sha: "9f8e7d6c" });
    const verdict = gate(head, base);
    expect(verdict).toMatchObject({ ok: true, mismatch: false, mismatchDetail: { removed: ["three"] } });
    expect(report(head, base, verdict).join("\n")).toContain("removed scored items: three");
  });

  it("treats a same-id changed item as new rather than a regression", () => {
    const head = run({
      pass: 2,
      fail: 1,
      scoredHashes: { one: "changed", two: "hash-two", three: "hash-three" },
      failures: [failure("one")],
    });
    const base = run({ sha: "9f8e7d6c" });
    expect(gate(head, base)).toMatchObject({ ok: true, newFailing: [expect.objectContaining({ id: "one" })], mismatchDetail: {
      changed: ["one"], new: ["one"], removed: ["one"],
    } });
    const baseFailure = run({ sha: "9f8e7d6c", pass: 2, fail: 1, failures: [failure("one")] });
    expect(gate(head, baseFailure)).toMatchObject({
      stillFailing: [],
      newFailing: [expect.objectContaining({ id: "one" })],
    });
  });

  it("fails as a nonmeasurement when no same-content item intersects", () => {
    const head = run();
    const base = run({ sha: "9f8e7d6c", scoredHashes: { one: "changed", two: "changed", three: "changed" } });
    const verdict = gate(head, base);
    expect(verdict).toMatchObject({ ok: false, mismatch: true, mismatchDetail: { kind: "nonmeasurement" } });
    expect(report(head, base, verdict).join("\n")).toContain("re-run the base and head");
    expect(report(head, base, verdict).join("\n")).toContain("the runs share no scored item with the same content hash");
  });

  it("fails as a nonmeasurement when a row predates the per-item hashes", () => {
    const head = run();
    const base = run({ sha: "9f8e7d6c", scoredHashes: undefined });
    const verdict = gate(head, base);
    expect(verdict).toMatchObject({ ok: false, mismatch: true, mismatchDetail: { kind: "nonmeasurement" } });
    expect(report(head, base, verdict).join("\n")).toContain("one or both runs lack per-item content hashes");
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
    expect(report(head, null, verdict).join("\n")).toBe("the evals could not run on the box: could not fetch deadbeef");
  });

  it("fails the new catastrophic row shape before regressions can open it", () => {
    const head = run({ error: true, reason: "runner failed: Not logged in", regressions: 0 });
    const verdict = gate(head, run());
    expect(verdict.ok).toBe(false);
    expect(report(head, run(), verdict)).toEqual(["the evals could not run on the box: runner failed: Not logged in"]);
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

  // EVERY DIRECTORY THE SET IS READ FROM IS WATCHED. loadTriggers reads
  // evals/triggers/*.json into the run, so a trigger-only change moves what the
  // set measures — and the workflow `paths:` list this constant replaced never
  // named the directory. That omission failed CLOSED while the filter lived in
  // the workflow (no job, no row, gate denied for want of one); inside the check
  // it fails OPEN, writing a passing unaffected row for a change to the set
  // itself. Found by the box's audit.
  it("watches every directory the eval set is read from", () => {
    expect(WATCHED_PATHS).toContain("evals/triggers/**");
    expect(unaffectedBy(["evals/triggers/layer-know.json"])).toBe(false);
    expect(unaffectedBy(["evals/tasks/slack.json"])).toBe(false);
    expect(unaffectedBy(["evals/golden/x.md"])).toBe(false);
  });

  // The skill table, its generator, the router that grants them, and the set
  // the triggers are part of. Each decides what a run's prompt carries, which
  // is what this list means by a context file — while the harness's own files
  // stay out, because watching them fires a fifty-minute run on every change to
  // the evals code itself.
  it("watches the skill table and its generator, and still not the harness", () => {
    expect(WATCHED_PATHS).toContain("shared/skills.mjs");
    expect(WATCHED_PATHS).toContain("scripts/publish-skills.mjs");
    expect(WATCHED_PATHS).toContain("shared/skill-router.mjs");
    expect(WATCHED_PATHS).toContain("evals/triggers/**");
    expect(WATCHED_PATHS).not.toContain("worker/jobs/evals.mjs");
    expect(WATCHED_PATHS).not.toContain("scripts/evals-check.mjs");
    expect(matchesWatched("shared/skills.mjs")).toBe(true);
    expect(matchesWatched("evals/triggers/skill-know-research.json")).toBe(true);
    expect(matchesWatched("worker/jobs/evals.mjs")).toBe(false);
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

  it("gives WikiTom requests their GitHub run identity", () => {
    const workflow = readFileSync("evals/wikitom/evals.yml", "utf8");
    expect(workflow).toMatch(/\r?\n\s*RUN_ID:\s*\$\{\{ github\.run_id \}\}/);
  });

  it("prints a forced by-hand recovery command after the box times out", () => {
    const source = readFileSync("scripts/evals-check.mjs", "utf8");
    expect(source).toMatch(
      /the Jarvis Box did not answer[\s\S]*node \/opt\/tts\/evals\.mjs --repo \$\{repo\} --sha \$\{sha\} --force/,
    );
  });

  it("prints a protocol gap and exits non-zero after one poll", async () => {
    const gap = "the box's evals runner is at protocol 1; this door needs 2 — run worker/setup.sh on the box";
    const callFn = vi.fn(async () => ({
      run: null,
      boxEvalsVersion: 1,
      evalsProtocol: 2,
      protocolGap: gap,
    }));
    const error = vi.fn();
    const exit = vi.fn();
    const sleepFn = vi.fn();
    const result = await waitForEvals(
      {
        site: "https://example.convex.site",
        key: "key",
        repo: "tom.quest",
        sha: "abc1234",
        baseSha: "base123",
        deadline: 1_000,
      },
      { callFn, error, exit, sleepFn, now: () => 0, log: vi.fn() },
    );
    expect(callFn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(gap);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(sleepFn).not.toHaveBeenCalled();
    expect(result.protocolGap).toBe(true);
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

  // The list used to be spelled twice — here and as the workflow's `paths:` —
  // and the two drifted in both directions before a test pinned them equal.
  // The copy is GONE now: the workflow fires on every pull request and this
  // list decides inside the check, where the answer lands on a row. This is
  // the pin that keeps the second spelling from coming back, because a
  // workflow that does not run records nothing, and no row denies the merge.
  it("is the only spelling: the workflow filters no paths of its own", () => {
    // \r? throughout: a Windows checkout hands this file back with CRLF, and a
    // test that only reads LF passes on the box and fails on Tom's laptop.
    const workflow = readFileSync(".github/workflows/evals.yml", "utf8");
    expect(/\r?\n {4}paths(-ignore)?:/.test(workflow)).toBe(false);
    expect(/\r?\non:\r?\n {2}pull_request:\r?\n/.test(workflow)).toBe(true);
  });
});

// THE FILTER THAT USED TO BE THE WORKFLOW'S. A pull request touching nothing
// watched gets a row saying so instead of no row at all — which is what a
// skipped workflow left behind, and what the merge gate denies on.
describe("unaffectedBy", () => {
  it("is true when no changed path is watched", () => {
    expect(unaffectedBy(["convex/ttsMerge.ts", "worker/jobs/evals.mjs"])).toBe(true);
    expect(unaffectedBy([])).toBe(true);
  });

  it("is false when any one of them is", () => {
    expect(unaffectedBy(["convex/ttsMerge.ts", "model-of-tom/intent.md"])).toBe(false);
    expect(unaffectedBy(["worker/AGENTS.md"])).toBe(false);
  });

  // A diff that could not be read is NOT an unaffected branch. Answering
  // "nothing watched changed" off a list nobody computed would skip the evals
  // on exactly the runs that lost their diff; those pay for a full run.
  it("is false when there is no diff at all", () => {
    expect(unaffectedBy(null)).toBe(false);
    expect(unaffectedBy(undefined)).toBe(false);
  });
});

// THE DIFF THE SHORTCUT IS READ FROM. `git diff --name-only` prints a detected
// rename as its DESTINATION alone, so moving a watched context file out of a
// watched directory would reach unaffectedBy() as one unwatched path — and the
// branch would get a passing row with nothing scored. `--no-renames` makes the
// move a delete and an add, and the delete is watched.
describe("the changed-path diff", () => {
  it("sees a watched file moved out of a watched directory", () => {
    const dir = tempDir("evals-rename-");
    const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    mkdirSync(path.join(dir, "model-of-tom"), { recursive: true });
    writeFileSync(path.join(dir, "model-of-tom", "intent.md"), ["a line", "and another", ""].join("\n"));
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").trim();
    mkdirSync(path.join(dir, "docs"), { recursive: true });
    git("mv", "model-of-tom/intent.md", "docs/intent.md");
    git("commit", "-qm", "move it out");
    const head = git("rev-parse", "HEAD").trim();
    const paths = (...flags) => git("diff", ...flags, "--name-only", `${base}...${head}`)
      .split(new RegExp("\\r?\\n"))
      .filter((line) => line !== "");
    // The hole, stated: rename detection hides the watched path entirely.
    expect(paths()).toEqual(["docs/intent.md"]);
    expect(unaffectedBy(paths())).toBe(true);
    // And the flag the check passes closes it.
    expect(paths("--no-renames").sort()).toEqual(["docs/intent.md", "model-of-tom/intent.md"]);
    expect(unaffectedBy(paths("--no-renames"))).toBe(false);
  });

  // The check reads its own diff inside main(), which no test can call, so the
  // flag is pinned on the source the way the workflow's own facts are.
  it("is the flag the check actually passes", () => {
    const source = readFileSync("scripts/evals-check.mjs", "utf8");
    expect(source).toContain('execFileSync("git", ["diff", "--no-renames", "--name-only", "-z"');
  });

  it("keeps a non-ASCII trigger pathname unquoted and affected", () => {
    const changed = changedPathsFromGit("evals/triggers/skill-know-h\u00e9alth.json\0");
    expect(changed).toEqual(["evals/triggers/skill-know-h\u00e9alth.json"]);
    expect(unaffectedBy(changed)).toBe(false);
  });

  // The queue tells a pull request's live head from the shas behind it by the
  // workflow run's id, and it can only do that if the workflow hands it over.
  it("is given the push order the queue reads", () => {
    const workflow = readFileSync(".github/workflows/evals.yml", "utf8");
    expect(workflow).toMatch(/RUN_ID:\s*\$\{\{\s*github\.run_id\s*\}\}/);
    expect(readFileSync("scripts/evals-check.mjs", "utf8")).toContain("process.env.RUN_ID");
  });
});

describe("an unaffected row", () => {
  const row = (over = {}) => ({
    repo: "tom.quest",
    sha: "2e08b28e9df",
    unaffected: true,
    changed: ["convex/ttsMerge.ts", "worker/jobs/evals.mjs"],
    items: 40,
    pass: 40,
    fail: 0,
    regressions: 0,
    failures: [],
    scoredIds: [],
    tasks: { items: 0, pass: 0, fail: 0, failures: [] },
    ...over,
  });

  it("passes the gate and answers coverage not-required", () => {
    const verdict = gate(row(), null, { changed: ["convex/ttsMerge.ts"], prBody: "" });
    expect(verdict.ok).toBe(true);
    expect(verdict.goldenCoverage).toBe(COVERAGE_NOT_REQUIRED);
    expect(verdict.regressions).toEqual([]);
  });

  // The same words convex/ttsMerge.ts puts on the gate's `why` and the
  // #tts-decisions merge line, so all three say one thing about the commit.
  it("reports one line naming what was looked at", () => {
    const lines = report(row(), null, gate(row(), null));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("the evals are unaffected — no watched path changed");
    expect(lines[0]).toContain("2 paths");
  });
});

// The row the box posts for a head a later push replaced. It is never a run:
// nothing was cloned and nothing was scored, and the only sentence worth
// printing is which sha to look at instead.
describe("a superseded row", () => {
  const row = (over = {}) => ({
    repo: "tom.quest",
    sha: "2e08b28e9df",
    superseded: true,
    supersededBy: "0b1ca1fdeadbeef",
    error: "superseded by 0b1ca1f; re-run this check at the head of the branch",
    items: 0,
    pass: 0,
    fail: 0,
    regressions: null,
    goldenCoverage: null,
    failures: [],
    scoredIds: [],
    tasks: { items: 0, pass: 0, fail: 0, failures: [] },
    ...over,
  });

  it("fails, and names the sha to re-run at", () => {
    const verdict = gate(row(), null, { changed: ["model-of-tom/intent.md"], prBody: "" });
    expect(verdict).toMatchObject({ ok: false, reason: "superseded by 0b1ca1f, re-run at head" });
    expect(verdict.regressions).toEqual([]);
  });

  it("reports two lines and no numbers", () => {
    const lines = report(row(), null, gate(row(), null));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("superseded by 0b1ca1f");
    expect(lines[1]).toContain("Re-run this check at the head of the branch");
    // No set line: there was no set, no base and nothing compared.
    expect(lines.join(" ")).not.toContain("golden set");
  });

  // A row carrying BOTH fields — and every superseded row does — reads as the
  // supersession, not as a run the box could not make.
  it("is read before the error a run that failed would carry", () => {
    expect(report(row(), null, gate(row(), null)).join(" "))
      .not.toContain("the run could not be made");
  });

  // A REQUEST OLDER THAN THE PROTOCOL carries the protocol's name in that
  // field rather than a sha (shared/evals-row.mjs PROTOCOL_SUPERSEDED).
  // It fails the same way and asks for the same thing — a re-run at the head —
  // and the name is printed whole, because seven characters of it would say
  // "protoco".
  const legacy = () => row({
    supersededBy: "protocol-2",
    error: "filed before evals protocol 2; re-run this check at the head of the branch",
  });

  it("fails a pre-protocol request and still asks for a re-run at the head", () => {
    const verdict = gate(legacy(), null, { changed: ["model-of-tom/intent.md"], prBody: "" });
    expect(verdict).toMatchObject({
      ok: false,
      reason: "filed before the box's evals protocol, re-run at head",
    });
    const lines = report(legacy(), null, verdict);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("filed before the box's evals protocol");
    expect(lines.join(" ")).not.toContain("protoco.");
    expect(lines.join(" ")).not.toContain("a later push replaced this head");
    expect(lines[1]).toContain("Re-run this check at the head of the branch");
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

  // THE SECOND SPELLING, KEPT HONEST. shared/evals-row.mjs carries this
  // reader too, because the Convex door needs it to decide whether a re-filed
  // request is the same question (evalsRequestIdentity) and cannot import this
  // file: it has zero imports on purpose — WikiTom's Action fetches the single
  // file and runs it. Two bodies of one rule can only be trusted if something
  // runs both, so this does.
  it("agrees with the copy the Convex door reads", () => {
    const bodies = [
      "Lands the narrow.\n\nevals: no-item pure deletion, no new behaviour\n",
      "evals:no-item   a typo fix in a comment  ",
      "EVALS: NO-ITEM shouting still counts",
      "Put `evals: no-item <reason>` on the body if you owe none.",
      "evals: no-item",
      "\tevals: no-item  leading tab and trailing space \t",
      "first line\r\nevals: no-item windows line endings\r\nlast line",
      "an evals: no-item reason mid-sentence does not count",
      "",
      undefined,
      null,
      42,
    ];
    for (const body of bodies) {
      expect([body, rowTrailer(body)]).toEqual([body, noItemTrailer(body)]);
    }
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

  it("is satisfied by an item under evals/golden", () => {
    expect(goldenItemRule([...WATCHED, "evals/golden/runs/x.json"], "")).toBe(true);
    expect(goldenItemRule([...WATCHED, "evals/triggers/skill-know-research.json"], "")).toBe(false);
  });

  // A trigger directly scores the published descriptions and their router, so
  // those three watched files may ship one instead of a golden item. Other
  // watched files cannot: a trigger is not evidence about an arbitrary prompt
  // context change.
  it("lets a trigger cover only a skill description or router change", () => {
    const changed = ["shared/skills.mjs"];
    expect(goldenItemRule(changed, "Split one description shape in two.")).toBe(false);
    expect(goldenItemRule([...changed, "evals/triggers/skill-know-research.json"], "")).toBe(false);
    expect(goldenItemRule([...changed, "evals/triggers/skill-know-research.json"], "", ["skill-know-research.json"])).toBe(true);
    expect(goldenItemRule(["model-of-tom/intent.md", "evals/triggers/skill-know-research.json"], "")).toBe(false);
    expect(goldenItemRule(["scripts/publish-skills.mjs", "evals/triggers/a.json"], "", ["a.json"])).toBe(true);
    expect(goldenItemRule(["shared/skill-router.mjs", "evals/triggers/a.json"], "", ["a.json"])).toBe(true);
    expect(goldenItemRule([
      "shared/skills.mjs",
      "evals/triggers/skill-know-research.json",
      "model-of-tom/intent.md",
    ], "", ["skill-know-research.json"])).toBe(false);
    expect(goldenItemRule(changed, "Split one description shape in two.\n\nevals: no-item no rule changed, only a comment\n")).toBe(true);
    const head = run({ triggerFilesRun: ["skill-know-research.json"] });
    const verdict = gate(head, run({ sha: "9f8e7d6c" }), {
      changed,
      prBody: "evals: no-item no rule changed, only a comment",
    });
    expect(verdict).toMatchObject({ ok: true, goldenCoverage: true });
    expect(report(head, run({ sha: "9f8e7d6c" }), verdict).join("\n"))
      .toContain("golden item excused: no rule changed, only a comment");
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
    expect(lines.join("\n")).toContain("evals/golden/**");
    expect(lines.join("\n")).toContain("a trigger file satisfies coverage only after its cases ran in this pull-request run");
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

describe("what one job's prompt reads", () => {
  // THE HOLE THIS CLOSED. `checkin` builds its prompt from
  // worker/jobs/runner-checkin.mjs and `learning` from worker/jobs/nightly.mjs
  // and worker/jobs/learning-ground.mjs, and none of the three was watched — so
  // a change to the check-in judge's own prompt was `unaffected`, wrote a
  // passing row with nothing scored, and merged with the nine items that exist
  // to score it never run.
  it("watches the files the check-in and learning jobs build their prompts from", () => {
    expect(matchesWatched("worker/jobs/runner-checkin.mjs")).toBe(true);
    expect(matchesWatched("worker/jobs/nightly.mjs")).toBe(true);
    expect(matchesWatched("worker/jobs/learning-ground.mjs")).toBe(true);
    expect(unaffectedBy(["worker/jobs/runner-checkin.mjs"])).toBe(false);
  });

  // A path named here that WATCHED_PATHS does not carry can never be reached:
  // the branch would be called unaffected and nothing would consult this table.
  it("names nothing the watch does not already cover", () => {
    for (const [job, inputs] of Object.entries(JOB_INPUTS)) {
      for (const input of inputs) {
        expect(matchesWatched(input), `${job} reads ${input}, which is not watched`).toBe(true);
      }
    }
    for (const shared of SHARED_PROMPT_INPUTS) expect(WATCHED_PATHS).toContain(shared);
  });

  it("narrows an ordinary diff to the jobs that read what it touched", () => {
    expect(jobsAffectedBy(["worker/jobs/runner-checkin.mjs"])).toEqual(["checkin"]);
    expect(jobsAffectedBy(["worker/jobs/plan-graphs.mjs"])).toEqual(["code-brief", "prepare"]);
    // Nothing watched at all: no job reads it, and the whole-run shortcut has
    // already answered this branch anyway.
    expect(jobsAffectedBy(["README.md"])).toEqual([]);
  });

  it("refuses to narrow when a shared input moved, or when nobody supplied a diff", () => {
    // Every prompt carries the layers, so every item moves.
    expect(jobsAffectedBy(["model-of-tom/intent.md"])).toBeNull();
    expect(jobsAffectedBy(["shared/skills.mjs"])).toBeNull();
    expect(jobsAffectedBy(["evals/golden/explanations/explanation-p1.json"])).toBeNull();
    // A weekly run and a run by hand supply no list: null regenerates all.
    expect(jobsAffectedBy(undefined)).toBeNull();
    expect(jobsAffectedBy(null)).toBeNull();
  });

  it("refuses to narrow on a watched path no job claims", () => {
    // Watched, and not in any job's row: some job may read it by a route this
    // table does not describe, so the honest answer is the unnarrowed one.
    expect(WATCHED_PATHS).toContain("convex/ttsDigest.ts");
    expect(Object.values(JOB_INPUTS).flat()).not.toContain("convex/ttsDigest.ts");
    expect(jobsAffectedBy(["convex/ttsDigest.ts"])).toBeNull();
  });
});

describe("the cost line", () => {
  const timing = { durationMs: 21 * 60 * 1000, regenerated: 3, cached: 30, skipped: 0, unreplayable: 15, concurrency: 4 };

  it("says what the run spent its minutes on", () => {
    const [line] = costLine({ timing, calls: 6 });
    expect(line).toContain("21 min at 4 at a time, 6 calls");
    expect(line).toContain("3 regenerated");
    expect(line).toContain("30 carried over from the base");
    expect(line).toContain("15 unreplayable");
  });

  it("names a run that ran long, and says nothing about one that did not", () => {
    expect(costLine({ timing, calls: 6 })).toHaveLength(1);
    const slow = costLine({ timing: { ...timing, durationMs: SLOW_RUN_MS + 1 }, calls: 6 });
    expect(slow).toHaveLength(2);
    expect(slow[1]).toContain("SLOW");
  });

  it("prints nothing for a row written before the timing field", () => {
    expect(costLine({ calls: 6 })).toEqual([]);
    expect(costLine({ timing: null })).toEqual([]);
    expect(costLine({ timing: {} })).toEqual([]);
  });

  it("rides on the one-line clean check rather than replacing it", () => {
    const head = run({ timing });
    const verdict = gate(head, run({ sha: "9f8e7d6c" }));
    const lines = report(head, run({ sha: "9f8e7d6c" }), verdict);
    expect(lines[0]).toContain("0 regressions");
    expect(lines[1]).toContain("21 min at 4 at a time");
  });
});
