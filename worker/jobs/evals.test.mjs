import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ablationFindings,
  ablationFor,
  aggregate,
  efficiencyOf,
  efficiencyVerdict,
  failedRun,
  goldenHash,
  HEAD_TRIALS,
  isFlaky,
  JOBS,
  judgePrompt,
  loadGolden,
  loadTasks,
  loadTriggers,
  loadWritingStandard,
  mechanicalChecks,
  medianTokens,
  MIN_ABLATION_CASES,
  parseArgs,
  parseJudge,
  passedIds,
  preludeFrom,
  PR_TRIALS,
  runCase,
  runEvals,
  runItem,
  runTask,
  runTrials,
  scoreLearning,
  selectItems,
  SKILL_SEAM_REASON,
  SkillsNotAssembledError,
  stampAgainstBase,
  standardRulesFor,
  TASK_BRANCHES,
  tokensOf,
  treesFor,
  trialsFor,
  triggerCounts,
  TRIALS_CAPABILITY,
  TRIALS_REGRESSION,
  verdictOf,
} from "./evals.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const LABEL = "This tells me nothing I did not already know from the statement.";
const PRIOR = "Say what the lock actually is.";

const item = (over = {}) => ({
  id: "prepare-chores-k17abc",
  job: "prepare",
  partition: "prepare/chores",
  verdict: "revise",
  sentence: LABEL,
  ruledAt: 1_756_900_000_000,
  ruledOn: "2026-09-03",
  rulingId: "k17abc123def456",
  subject: { type: "life", todoId: "ph79" },
  input: {
    statement: "sort out the bike lock",
    source: "slack-capture",
    provenance: null,
    category: "chores",
    createdAt: 1_756_800_000_000,
    priorReviseSentence: PRIOR,
    today: "2026-09-03",
  },
  output: { brief: "The old lock is seized.", entryAction: "Open the shop page", workDescription: "an errand", groundUpExplanation: "<html>old</html>" },
  ...over,
});

const MARKER = "LAYER-TEXT-MARKER-DO-NOT-LEAK";
const layers = { names: ["write", "know"], text: `${MARKER}\nwrite plainly.`, commit: "abc123", files: [] };

describe("treesFor", () => {
  it("pins the repo under test and takes the other at its default branch", () => {
    expect(treesFor("WikiTom", "deadbeef")).toEqual({ wikitom: "deadbeef", tomquest: "origin/main" });
    expect(treesFor("tom.quest", "deadbeef")).toEqual({ wikitom: "origin/main", tomquest: "deadbeef" });
  });
});

describe("the honesty rule", () => {
  // Written first, and it is the test that keeps the eval honest: a
  // regeneration handed the label sentence is scoring its own reading.
  it("puts the prior revise sentence in the prepare prompt and never the label sentence", async () => {
    const mod = await import("./plan-graphs.mjs");
    const prompt = JOBS.prepare.build(item(), layers, mod);
    expect(prompt).toContain(PRIOR);
    expect(prompt).not.toContain(LABEL);
    expect(prompt).toContain("sort out the bike lock");
    expect(prompt).toContain("2026-09-03");
  });

  it("puts nothing but the topic and its context lines in an explanation prompt", () => {
    const explanation = item({
      job: "explanation",
      verdict: undefined,
      label: "did not",
      sentence: "im struggling to understand",
      confirmedByTom: false,
      input: { topic: "How pooled AUROC is computed", contextLines: ["Date: 2026-08-09", "Project: ComplexMultiTrigger"] },
      output: { explanation: "the old one" },
    });
    const prompt = JOBS.explanation.build(explanation, layers);
    expect(prompt).toContain(MARKER);
    expect(prompt).toContain("How pooled AUROC is computed");
    expect(prompt).toContain("Project: ComplexMultiTrigger");
    expect(prompt).not.toContain("im struggling to understand");
    expect(prompt).not.toContain("the old one");
  });
});

describe("judgePrompt", () => {
  const fields = JOBS.prepare.fields;
  const fresh = { brief: "The lock is a Kryptonite D-lock, seized at the barrel.", entryAction: "Open the shop page", workDescription: "an errand", groundUpExplanation: "<html>new</html>" };

  it("carries the sentence on a revise item", () => {
    const prompt = judgePrompt(item(), fresh, fields);
    expect(prompt).toContain("--- TOM'S SENTENCE ---");
    expect(prompt).toContain(LABEL);
    expect(prompt).toContain("Tom rejected the OLD output");
    expect(prompt).not.toContain("Tom accepted the OLD output");
  });

  it("omits the sentence block entirely on an approve item, and the approve note with it", () => {
    const prompt = judgePrompt(item({ verdict: "approve", sentence: "A steering note about something else." }), fresh, fields);
    expect(prompt).not.toContain("--- TOM'S SENTENCE ---");
    expect(prompt).not.toContain("A steering note about something else.");
    expect(prompt).toContain("Tom accepted the OLD output");
  });

  it("strips priorReviseSentence from the input block", () => {
    expect(judgePrompt(item(), fresh, fields)).not.toContain(PRIOR);
  });

  it("carries no layer text at all", () => {
    const prompt = judgePrompt(item(), fresh, fields);
    expect(prompt).not.toContain(MARKER);
    expect(prompt).not.toContain("write plainly.");
  });

  it("treats a landed label as approve and a did-not label as revise", () => {
    expect(verdictOf({ label: "landed" })).toBe("approve");
    expect(verdictOf({ label: "did not" })).toBe("revise");
    expect(verdictOf({ verdict: "revise", label: "landed" })).toBe("revise");
  });
});

function context(mod) {
  return { modules: { prepare: mod, explanation: undefined }, layers: () => layers, cmtDir: undefined };
}

describe("runItem", () => {
  it("turns a thrown regeneration into a fail and does not stop the run", async () => {
    const mod = await import("./plan-graphs.mjs");
    const results = [];
    let first = true;
    for (const one of [item(), item({ id: "second" })]) {
      results.push(await runItem(one, context(mod), {
        runClaude: async (prompt) => {
          const regenerating = !prompt.startsWith("You are judging");
          if (regenerating && first) {
            first = false;
            throw new Error("timed out");
          }
          return regenerating
            ? JSON.stringify({ brief: "a", entryAction: "b", workDescription: "c", groundUpExplanation: "d" })
            : JSON.stringify({ verdict: "pass", reason: "fixed, now names the D-lock barrel" });
        },
      }));
    }
    expect(results[0]).toMatchObject({ judged: "fail", reason: expect.stringMatching(/^regeneration failed/) });
    expect(results[1].judged).toBe("pass");
  });

  it("turns an unreadable judge answer into a fail with the answer's head", async () => {
    const mod = await import("./plan-graphs.mjs");
    let call = 0;
    const result = await runItem(item(), context(mod), {
      runClaude: async () => {
        call += 1;
        return call === 1
          ? JSON.stringify({ brief: "a", entryAction: "b", workDescription: "c", groundUpExplanation: "d" })
          : "I think it is probably fine, honestly";
      },
    });
    expect(result).toMatchObject({ judged: "fail", reason: expect.stringMatching(/^judge answer unreadable/) });
  });

  it("refuses to score an item whose label sentence reached the prompt", async () => {
    const mod = await import("./plan-graphs.mjs");
    const leaking = item({ input: { ...item().input, statement: `sort out the bike lock. ${LABEL}` } });
    const result = await runItem(leaking, context(mod), { runClaude: async () => "never called" });
    expect(result).toMatchObject({ judged: "fail", reason: "regeneration failed: the label sentence reached the prompt" });
  });

  it("fails an item whose job has no runner", async () => {
    const result = await runItem(item({ job: "not-a-job" }), context(null), { runClaude: async () => "" });
    expect(result).toMatchObject({ judged: "fail", reason: "no runner for job not-a-job" });
  });
});

describe("parseJudge", () => {
  it("accepts a bare JSON object and a fenced one", () => {
    expect(parseJudge('{"verdict":"pass","reason":"names the D-lock barrel"}')).toEqual({ judged: "pass", reason: "names the D-lock barrel" });
    expect(parseJudge('```json\n{"verdict":"fail","reason":"still restates the statement"}\n```').judged).toBe("fail");
  });

  it("rejects a verdict that is not pass or fail, and an empty reason", () => {
    expect(parseJudge('{"verdict":"maybe","reason":"x"}').reason).toMatch(/^judge answer unreadable/);
    expect(parseJudge('{"verdict":"pass","reason":"  "}').reason).toMatch(/^judge answer unreadable/);
  });
});

describe("aggregate", () => {
  it("counts by partition and by verdict and sorts failures by id", () => {
    const summary = aggregate([
      { id: "b", partition: "prepare/chores", verdict: "revise", judged: "fail", reason: "still restates", confirmed: true },
      { id: "a", partition: "prepare/chores", verdict: "approve", judged: "pass", reason: "kept", confirmed: true },
      { id: "c", partition: "explanation/WikiTom", verdict: "revise", judged: "fail", reason: "dense", confirmed: false },
    ]);
    expect(summary).toMatchObject({ items: 3, pass: 1, fail: 2 });
    expect(summary.byPartition).toEqual([
      { partition: "explanation/WikiTom", items: 1, pass: 0, fail: 1 },
      { partition: "prepare/chores", items: 2, pass: 1, fail: 1 },
    ]);
    expect(summary.byVerdict).toEqual({ approve: { items: 1, pass: 1 }, revise: { items: 2, pass: 0 } });
    expect(summary.failures.map((failure) => failure.id)).toEqual(["b", "c"]);
    expect(summary.failures[1].confirmed).toBe(false);
  });
});

function tree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-tree-"));
  dirs.push(dir);
  return dir;
}

function writeJson(dir, rel, value) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

describe("loadGolden", () => {
  it("reads both homes, sorts by id, and hashes the whole set", () => {
    const dir = tree();
    writeJson(dir, "evals/golden/prepare-chores-k17abc.json", item());
    writeJson(dir, "evals/golden/explanations/explanation-p1.json", item({ id: "explanation-p1", job: "explanation", label: "landed", verdict: undefined, confirmedByTom: false }));
    const items = loadGolden(dir);
    expect(items.map((one) => one.id)).toEqual(["explanation-p1", "prepare-chores-k17abc"]);
    const before = goldenHash(items);
    expect(goldenHash([...items].reverse())).toBe(before);
    writeJson(dir, "evals/golden/prepare-chores-k17abc.json", item({ sentence: "a different sentence" }));
    expect(goldenHash(loadGolden(dir))).not.toBe(before);
  });

  it("is empty and does not throw for a tree with no golden set", () => {
    expect(loadGolden(tree())).toEqual([]);
  });
});

describe("selectItems", () => {
  it("takes the newest of each verdict up to the cap", () => {
    const items = [];
    for (let index = 0; index < 30; index += 1) {
      items.push(item({ id: `a${index}`, verdict: "approve", ruledAt: 1000 + index }));
      items.push(item({ id: `r${index}`, verdict: "revise", ruledAt: 1000 + index }));
    }
    const chosen = selectItems(items, 3);
    expect(chosen).toHaveLength(6);
    expect(chosen.filter((one) => one.verdict === "approve").map((one) => one.id).sort()).toEqual(["a27", "a28", "a29"]);
  });
});

describe("repo tasks", () => {
  it("returns an empty list for an absent directory and does not throw", () => {
    expect(loadTasks(tree(), "tom.quest")).toEqual([]);
  });

  it("reads a repo's task files id-ascending", () => {
    const dir = tree();
    writeJson(dir, "evals/tasks/tom.quest/02-b.json", { id: "b", repo: "tom.quest", kind: "locate" });
    writeJson(dir, "evals/tasks/tom.quest/01-a.json", { id: "a", repo: "tom.quest", kind: "locate" });
    expect(loadTasks(dir, "tom.quest").map((task) => task.id)).toEqual(["a", "b"]);
  });

  // uac/delegate and uac/slack are both merged, so neither kind is held back
  // by a branch any more. The map stays as the mechanism, empty.
  it("holds no kind back behind a branch, and skips only for a runner that is not wired", async () => {
    expect(TASK_BRANCHES).toEqual({});
    const delegate = await runTask({ id: "delegate-01-answers", repo: "delegate", kind: "delegate" }, {}, {});
    expect(delegate).toMatchObject({ judged: "skip", reason: "no runner wired for task kind delegate" });
    const slack = await runTask({ id: "slack-01-morning", repo: "slack", kind: "slack" }, {}, {});
    expect(slack).toMatchObject({ judged: "skip", reason: "no runner wired for task kind slack" });
  });

  it("runs a wired kind and takes its result", async () => {
    const task = { id: "slack-01-morning", repo: "slack", kind: "slack", expect: { mustName: ["667"], mustNotName: [] } };
    const result = await runTask(task, {}, {
      runTaskKind: async () => ({ judged: "pass", reason: "names the count", text: "667 more ready items" }),
    });
    expect(result).toMatchObject({ id: "slack-01-morning", partition: "task/slack", judged: "pass" });
  });

  // The mechanical half, and it decides without a model: an answer that names
  // what the item says it must not name is a fail whatever the runner said.
  it("fails an answer on mustName and mustNotName before any judge sees it", async () => {
    const task = { id: "t", repo: "slack", kind: "slack", expect: { mustName: ["667"], mustNotName: ["plan stored"] } };
    const missing = await runTask(task, {}, {
      runTaskKind: async () => ({ judged: "pass", reason: "the runner liked it", text: "nothing much" }),
    });
    expect(missing).toMatchObject({ judged: "fail", reason: 'does not name "667"' });
    const forbidden = await runTask(task, {}, {
      runTaskKind: async () => ({ judged: "pass", reason: "the runner liked it", text: "667 items, plan stored" }),
    });
    expect(forbidden).toMatchObject({ judged: "fail", reason: 'names "plan stored", which it must not' });
  });

  it("leaves a runner that reports no text to its own verdict", async () => {
    const task = { id: "t", repo: "slack", kind: "slack", expect: { mustName: ["667"], mustNotName: [] } };
    const result = await runTask(task, {}, { runTaskKind: async () => ({ judged: "pass", reason: "scored elsewhere" }) });
    expect(result.judged).toBe("pass");
  });

  it("fails an unknown task kind rather than silently passing it", async () => {
    expect(await runTask({ id: "x", repo: "tom.quest", kind: "invent" }, {}, {})).toMatchObject({ judged: "fail" });
  });

  it("reads the checked-in delegate and slack items in the shape the runner expects", () => {
    const repoRoot = path.resolve(".");
    for (const [repo, count] of [["delegate", 2], ["slack", 3]]) {
      const tasks = loadTasks(repoRoot, repo);
      expect(tasks).toHaveLength(count);
      for (const task of tasks) {
        expect(task.kind).toBe(repo);
        expect(task.repo).toBe(repo);
        expect(typeof task.expect.sentence).toBe("string");
        expect(Array.isArray(task.expect.mustName)).toBe(true);
        expect(Array.isArray(task.expect.mustNotName)).toBe(true);
      }
    }
  });
});

describe("the learning job", () => {
  const golden = (name) => JSON.parse(
    fs.readFileSync(path.join(path.resolve("."), "evals", "golden", "learning", `${name}.json`), "utf8"),
  );

  it("has a runner at all, so the two items are not scored 'no runner for job learning'", () => {
    expect(typeof JOBS.learning?.build).toBe("function");
    expect(typeof JOBS.learning?.parse).toBe("function");
  });

  it("builds the nightly prompt out of the item and scores the answer with no judge", async () => {
    const mod = Object.assign({}, await import("./learning-ground.mjs"), await import("./nightly.mjs"));
    const one = golden("learning-ground-said-knows");
    const prompt = JOBS.learning.build(one, layers, mod);
    expect(prompt).toContain("GROUND SIGNALS");
    expect(prompt).toContain("I understand the vocab you defined");
    expect(prompt).toContain("model-of-tom/ground.md");
    const fresh = JOBS.learning.parse(JSON.stringify(one.input.answer), mod);
    expect(scoreLearning(one, fresh, mod)).toMatchObject({ judged: "pass" });
  });

  it("fails the ground item when the regeneration lands nothing", async () => {
    const mod = Object.assign({}, await import("./learning-ground.mjs"), await import("./nightly.mjs"));
    expect(scoreLearning(golden("learning-ground-said-knows"), [], mod)).toMatchObject({ judged: "fail" });
  });

  // The refusal item's whole test is that nothing lands: an answer that
  // proposes nothing and the item's own recorded bad answer both pass it.
  it("passes the refusal item on an empty answer and on the answer it carries", async () => {
    const mod = Object.assign({}, await import("./learning-ground.mjs"), await import("./nightly.mjs"));
    const one = golden("learning-refusal-no-evidence");
    expect(scoreLearning(one, [], mod)).toMatchObject({ judged: "pass" });
    const fresh = JOBS.learning.parse(JSON.stringify(one.input.answer), mod);
    expect(scoreLearning(one, fresh, mod)).toMatchObject({ judged: "pass" });
  });
});

describe("stampAgainstBase", () => {
  // convex/ttsMerge.ts opens the evals arm on exactly `regressions === 0`, so
  // a run compared to nothing must not carry a zero.
  it("stamps regressions null when there is no base", async () => {
    expect((await stampAgainstBase({ failures: [] }, null)).regressions).toBe(null);
  });

  it("counts the regressions when there is one", async () => {
    const failure = { id: "a", partition: "prepare/chores", verdict: "revise", reason: "r", confirmed: true };
    const head = { goldenHash: "h", scoredIds: ["a"], failures: [failure], tasks: { failures: [] } };
    const base = { goldenHash: "h", scoredIds: ["a"], failures: [], tasks: { failures: [] } };
    const stamped = await stampAgainstBase(head, base);
    expect(stamped.regressions).toBe(1);
    expect(stamped.failures[0].regression).toBe(true);
  });
});

// Every item is a live model call, so one trial is a sample and not a
// measurement. The rule under test is the same for every item: an item the
// BASE PASSED that fails at head is tried again, and it is a regression only
// if every head trial fails.
describe("the head trials", () => {
  const fakeRunner = (...verdicts) => {
    const answers = [...verdicts];
    const calls = { count: 0 };
    const once = async () => {
      calls.count += 1;
      const judged = answers.shift() ?? "fail";
      return { id: "a", partition: "prepare/chores", verdict: "revise", confirmed: true, judged, reason: `trial ${calls.count}` };
    };
    return { once, calls };
  };
  const rowFor = (result) => ({ goldenHash: "h", scoredIds: ["a"], ...aggregate([result]), tasks: aggregate([]) });
  const basePassing = { goldenHash: "h", scoredIds: ["a"], failures: [], tasks: { failures: [] } };
  const baseFailing = {
    goldenHash: "h", scoredIds: ["a"], tasks: { failures: [] },
    failures: [{ id: "a", partition: "prepare/chores", verdict: "revise", reason: "was already bad", confirmed: true }],
  };

  it("calls a regression only when every head trial fails", async () => {
    const { once, calls } = fakeRunner("fail", "fail", "fail");
    const result = await runTrials("a", new Set(["a"]), once);
    expect(calls.count).toBe(HEAD_TRIALS);
    expect(result.judged).toBe("fail");
    expect(result.trials).toEqual({ head: 3, headPassed: 0 });
    expect(isFlaky(result)).toBe(false);
    const stamped = await stampAgainstBase(rowFor(result), basePassing);
    expect(stamped.regressions).toBe(1);
    expect(stamped.flaky).toBe(0);
    expect(stamped.failures[0].trials).toEqual({ head: 3, headPassed: 0 });
  });

  it("calls an item that failed then passed flaky, counts it as a pass, and never as a regression", async () => {
    const { once, calls } = fakeRunner("fail", "pass", "fail");
    const result = await runTrials("a", new Set(["a"]), once);
    // It stops on the pass: the third trial is never paid for.
    expect(calls.count).toBe(2);
    expect(result.judged).toBe("pass");
    expect(result.trials).toEqual({ head: 2, headPassed: 1 });
    expect(isFlaky(result)).toBe(true);
    const stamped = await stampAgainstBase(rowFor(result), basePassing);
    expect(stamped).toMatchObject({ pass: 1, fail: 0, flaky: 1, regressions: 0 });
    expect(stamped.failures).toEqual([]);
  });

  it("leaves an item that failed at base alone: one trial, still failing, no retry", async () => {
    const { once, calls } = fakeRunner("fail", "pass", "pass");
    const result = await runTrials("a", passedIds(baseFailing), once);
    expect(calls.count).toBe(1);
    expect(result.judged).toBe("fail");
    expect(result.trials).toEqual({ head: 1, headPassed: 0 });
    const stamped = await stampAgainstBase(rowFor(result), baseFailing);
    expect(stamped).toMatchObject({ regressions: 0, stillFailing: 1, flaky: 0 });
  });

  it("pays one call for an item that passes first time, base or no base", async () => {
    const first = await runTrials("a", new Set(["a"]), fakeRunner("pass").once);
    expect(first.trials).toEqual({ head: 1, headPassed: 1 });
    expect(isFlaky(first)).toBe(false);
    const { once, calls } = fakeRunner("fail");
    expect((await runTrials("a", new Set(), once)).trials).toEqual({ head: 1, headPassed: 0 });
    expect(calls.count).toBe(1);
  });

  it("reads the base's passing ids off the row, tasks and golden items alike", () => {
    const base = {
      scoredIds: ["a", "b", "task-1"],
      failures: [{ id: "b" }],
      tasks: { failures: [{ id: "task-1" }] },
    };
    expect([...passedIds(base)]).toEqual(["a"]);
    expect(passedIds(null).size).toBe(0);
  });
});

describe("runEvals carries the trial rule end to end", () => {
  const golden = item({ id: "a", sentence: LABEL });
  const io = (answers, dir) => ({
    now: () => 1,
    runClaude: async () => answers.shift() ?? '{"verdict":"fail","reason":"out of answers"}',
    layers: () => layers,
    loadModules: async () => ({ prepare: { preparePrompt: () => "PROMPT WITH NO LABEL IN IT" } }),
    taskRepos: () => [],
    worktree: (repo) => ({ dir, commit: repo === "WikiTom" ? "wiki1" : "tq1", remove: () => {} }),
  });
  const regen = '{"brief":"b","entryAction":"e","workDescription":"w","groundUpExplanation":"g"}';
  const goldenDir = () => {
    const dir = tree();
    writeJson(dir, path.join("evals", "golden", "a.json"), golden);
    return dir;
  };

  it("retries an item the base passed and records the flake", async () => {
    const dir = goldenDir();
    const answers = [regen, '{"verdict":"fail","reason":"no"}', regen, '{"verdict":"pass","reason":"yes"}'];
    const run = await runEvals({ repo: "tom.quest", sha: "head", basePassed: new Set(["a"]) }, io(answers, dir));
    expect(run).toMatchObject({ items: 1, pass: 1, fail: 0, flaky: 1 });
    expect(answers).toEqual([]);
    // Trials, not items: the retried item cost its two calls twice.
    expect(run.calls).toBe(4);
  });

  it("pays for one trial when the base did not pass the item", async () => {
    const dir = goldenDir();
    const answers = [regen, '{"verdict":"fail","reason":"no"}', regen, '{"verdict":"pass","reason":"yes"}'];
    const run = await runEvals({ repo: "tom.quest", sha: "head" }, io(answers, dir));
    expect(run).toMatchObject({ items: 1, pass: 0, fail: 1, flaky: 0, calls: 2 });
    expect(answers.length).toBe(2);
  });
});

describe("parseArgs", () => {
  it("takes both spellings of a valued flag", () => {
    expect(parseArgs(["--repo", "tom.quest", "--sha", "abc"])).toMatchObject({ repo: "tom.quest", sha: "abc" });
    expect(parseArgs(["--repo=WikiTom", "--sha=def", "--jobs=prepare,explanation"])).toMatchObject({ repo: "WikiTom", jobs: ["prepare", "explanation"] });
  });

  it("needs a repo and a sha unless it is serving, weekly, or listing tasks", () => {
    expect(() => parseArgs([])).toThrow(/--repo and --sha/);
    expect(parseArgs(["--serve"]).serve).toBe(true);
    expect(parseArgs(["--tasks", "slack"]).tasks).toBe("slack");
  });

  it("refuses an unknown argument and a non-positive limit", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--serve", "--limit", "0"])).toThrow(/--limit/);
  });

  // The ablation arm is reported and gates nothing, so it never runs on the
  // path a pull request takes.
  it("turns the ablation arm on for a weekly run, takes it by name, and leaves it off when serving", () => {
    expect(parseArgs(["--weekly"]).ablation).toBe(true);
    expect(parseArgs(["--repo", "tom.quest", "--sha", "abc", "--ablation"]).ablation).toBe(true);
    expect(parseArgs(["--serve"]).ablation).toBe(false);
    expect(parseArgs(["--repo", "tom.quest", "--sha", "abc"]).ablation).toBe(false);
  });
});

// ── The `run` case ───────────────────────────────────────────────────────────
// A case mined from a runLabels row: the run's own assembled prompt, the text
// Tom judged, and his label's meaning as the rubric.

const RUBRIC = "He said the update named the blocker instead of restating the plan.";
const PRELUDE = "PRELUDE-TEXT";

const runCaseItem = (over = {}) => ({
  id: "run-ruling-k97x2m4bq1zp",
  job: "run",
  partition: "runs/planner:worker",
  kind: "regression",
  verdict: "approve",
  confirmedByTom: true,
  trials: 3,
  negative: false,
  labelId: "kl1", labelSource: "ruling", runId: "claude:box:abc", at: 1_757_000_000_000,
  intentKey: "planner:worker",
  input: {
    preludeKnown: true,
    preludeNames: { layers: ["operate", "write", "know"], skills: [] },
    task: "TASK BODY: write the hourly line.",
    prompt: null,
    contextRowSeq: 0,
    spanSeqs: [412, 412],
  },
  expected: { rubric: RUBRIC, target: null },
  output: { text: "the text he judged" },
  ...over,
});

function runContext(over = {}) {
  return {
    modules: {},
    cmtDir: undefined,
    layers: () => layers,
    prelude: (names) => ({
      names: names?.layers ?? [],
      skills: names?.skills ?? [],
      text: `${PRELUDE}[${(names?.layers ?? []).join("+")}]`,
      commit: "w1",
      files: [],
    }),
    ...over,
  };
}

/** A fake runner: `verdicts` are the judge's answers in order, `answers` the
 *  regeneration's. Every prompt is kept, and the two calls are counted apart
 *  so a test can say the judge was never reached. */
function runIo(verdicts = [], answers = [], over = {}) {
  const calls = { regen: 0, judge: 0, prompts: [] };
  const io = {
    calls,
    now: () => 1,
    sleep: async () => {},
    runClaude: async (prompt, options) => {
      calls.prompts.push(prompt);
      if (String(prompt).startsWith("You are judging")) {
        calls.judge += 1;
        return JSON.stringify({ verdict: verdicts.shift() ?? "fail", reason: `judge ${calls.judge}` });
      }
      calls.regen += 1;
      if (options?.receipt) options.receipt.runToken = `tok-${calls.regen}`;
      return answers.shift() ?? "a fresh answer";
    },
    ...over,
  };
  return io;
}

describe("the run job", () => {
  it("builds the prompt out of the assembled prelude and the run's own task", () => {
    const prompt = JOBS.run.build(runCaseItem(), null, null, runContext());
    expect(prompt).toBe(`${PRELUDE}[operate+write+know]\nTASK BODY: write the hourly line.`);
    expect(JOBS.run.parse("  an answer  ")).toEqual({ text: "an answer" });
  });

  it("replays a case whose prelude was not known verbatim, and assembles nothing", () => {
    const item = runCaseItem({
      input: { ...runCaseItem().input, preludeKnown: false, prompt: "THE WHOLE PROMPT AS IT WAS SENT" },
    });
    const context = runContext({ prelude: () => { throw new Error("must not assemble"); } });
    expect(JOBS.run.build(item, null, null, context)).toBe("THE WHOLE PROMPT AS IT WAS SENT");
  });

  // A run case carries no sentence: its rubric IS the answer, so a
  // regeneration handed the rubric is scoring its own reading.
  it("refuses to score a case whose rubric reached the prompt", async () => {
    const item = runCaseItem({ input: { ...runCaseItem().input, task: `Write the line. ${RUBRIC}` } });
    const io = runIo();
    const result = await runItem(item, runContext(), io);
    expect(result).toMatchObject({ judged: "fail", reason: "regeneration failed: the rubric reached the prompt" });
    expect(io.calls.regen).toBe(0);
  });

  it("sends the rubric to the judge verbatim, and the target only on a capability case", () => {
    const approve = judgePrompt(runCaseItem(), { text: "new" }, JOBS.run.fields);
    expect(approve).toContain("--- WHAT TOM'S LABEL MEANS ---");
    expect(approve).toContain(RUBRIC);
    expect(approve).not.toContain("the output must now do this");
    const capability = judgePrompt(
      runCaseItem({ kind: "capability", expected: { rubric: RUBRIC, target: "name the blocker" } }),
      { text: "new" },
      JOBS.run.fields,
    );
    expect(capability).toContain("the output must now do this; it did not before.");
    expect(capability).toContain("name the blocker");
  });
});

describe("the phase 6 skills seam", () => {
  it("refuses a name set carrying skills while no assembler is wired", () => {
    const io = { layers: () => layers };
    expect(() => preludeFrom(io, "tq", "wiki", { layers: ["operate"], skills: ["merge-gate"] }))
      .toThrow(SkillsNotAssembledError);
    expect(preludeFrom(io, "tq", "wiki", { layers: ["operate"], skills: [] })).toBe(layers);
    // Nothing to assemble is not an error, and must not reach prelude.mjs.
    expect(preludeFrom(io, "tq", "wiki", { layers: [], skills: [] }).text).toBe("");
  });

  it("hands the whole name set to the assembler once one is wired", () => {
    const seen = [];
    const io = { layers: () => layers, skills: (tree, names) => { seen.push([tree, names]); return { ...layers, skills: names.skills }; } };
    const built = preludeFrom(io, "tq", "wiki", { layers: ["operate"], skills: ["merge-gate"] });
    expect(seen).toEqual([["tq", { layers: ["operate"], skills: ["merge-gate"] }]]);
    expect(built.skills).toEqual(["merge-gate"]);
  });

  it("skips a case whose run was given skills, counts it, and calls no model", async () => {
    const io = runIo();
    const context = runContext({
      prelude: (names) => {
        if ((names.skills ?? []).length > 0) throw new SkillsNotAssembledError(SKILL_SEAM_REASON);
        return { names: names.layers, skills: [], text: PRELUDE, commit: "w1", files: [] };
      },
    });
    const item = runCaseItem({ input: { ...runCaseItem().input, preludeNames: { layers: ["operate"], skills: ["merge-gate"] } } });
    const result = await runCase(item, context, io, { pr: false });
    expect(result).toMatchObject({ judged: "skip", reason: SKILL_SEAM_REASON });
    expect(io.calls.regen).toBe(0);
    expect(io.calls.judge).toBe(0);
  });
});

// Two rules meet in runCase. The landed one governs the merge gate: passing
// one trial is a pass, and a flake is never a regression. The stricter one
// (passK) governs graduation and gates nothing.
describe("the trials of a run case", () => {
  it("reads the count off the item, falls back to the kind, and pays one trial on a pull request", () => {
    expect(trialsFor(runCaseItem())).toBe(3);
    expect(trialsFor(runCaseItem({ trials: 7 }))).toBe(7);
    expect(trialsFor(runCaseItem({ trials: undefined }))).toBe(TRIALS_REGRESSION);
    expect(trialsFor(runCaseItem({ trials: undefined, kind: "capability" }))).toBe(TRIALS_CAPABILITY);
    expect(trialsFor(runCaseItem({ trials: 7, kind: "capability" }), { pr: true })).toBe(PR_TRIALS);
  });

  it("needs every trial for passK and any trial for the verdict the gate reads", async () => {
    const io = runIo(["pass", "fail", "pass"]);
    const result = await runCase(runCaseItem(), runContext(), io, { pr: false });
    expect(io.calls.regen).toBe(3);
    expect(result).toMatchObject({ judged: "pass", trialCount: 3, passed: 2, passK: false, passAtK: true });
    expect(result.trials).toEqual({ head: 3, headPassed: 2 });
    // The reason is the first failing trial's, so the row says what went wrong
    // rather than what went right.
    expect(result.reason).toBe("judge 2");
    const clean = await runCase(runCaseItem(), runContext(), runIo(["pass", "pass", "pass"]), { pr: false });
    expect(clean).toMatchObject({ passK: true, passAtK: true, judged: "pass" });
    const broken = await runCase(runCaseItem(), runContext(), runIo(["fail", "fail", "fail"]), { pr: false });
    expect(broken).toMatchObject({ passK: false, passAtK: false, judged: "fail" });
  });

  it("runs every trial independently — it does not stop on the first pass", async () => {
    const io = runIo(["pass", "pass", "pass"]);
    await runCase(runCaseItem(), runContext(), io, { pr: false });
    expect(io.calls.regen).toBe(3);
    expect(io.calls.judge).toBe(3);
  });

  it("pays one trial on a pull-request run and records that count", async () => {
    const io = runIo(["fail"]);
    const result = await runCase(runCaseItem(), runContext(), io, { pr: true });
    expect(io.calls.regen).toBe(1);
    expect(result.trials).toEqual({ head: 1, headPassed: 0 });
  });

  // The landed flaky count reads `trials: {head, headPassed}`, so a flaky run
  // case is counted by code that needed no edit.
  it("lands a flaky run case in the existing flaky count", async () => {
    const result = await runCase(runCaseItem(), runContext(), runIo(["pass", "fail", "pass"]), { pr: false });
    expect(isFlaky(result)).toBe(true);
    const summary = aggregate([result]);
    expect(summary).toMatchObject({ items: 1, pass: 1, fail: 0, flaky: 1 });
  });
});

describe("the deterministic checks", () => {
  it("checks nothing when the case has no expect block", () => {
    expect(mechanicalChecks(undefined, "anything at all")).toBe(null);
    expect(mechanicalChecks({}, "anything at all")).toBe(null);
    expect(mechanicalChecks({ mustNotName: ["blocker"] }, "the blocker is the judge fix")).toMatch(/^names "blocker"/);
  });

  it("fails a mustNotName violation and never calls the judge", async () => {
    const item = runCaseItem({ expect: { mustName: [], mustNotName: ["plan stored"] } });
    const io = runIo(["pass"], ["the plan stored under the batch"]);
    const result = await runCase(item, runContext(), io, { pr: true });
    expect(result).toMatchObject({ judged: "fail", reason: 'names "plan stored", which it must not' });
    expect(io.calls.regen).toBe(1);
    expect(io.calls.judge).toBe(0);
  });

  // The HTML rules are rules of the ground-up explanation's FORM. Applying
  // them to a free-form field would fail every case on no-doctype, so the
  // field decides which rules run — and a `run` case's text gets none.
  it("applies the HTML rules only to the explanation fields", async () => {
    const standard = await loadWritingStandard();
    expect(standard).not.toBe(null);
    expect(standardRulesFor("groundUpExplanation", standard)).toBe(standard.RULES);
    expect(standardRulesFor("explanation", standard)).toBe(standard.RULES);
    expect(standardRulesFor("brief", standard)).toBe(standard.BRIEF_RULES);
    expect(standardRulesFor("text", standard)).toBe(null);
    expect(standardRulesFor("entryAction", standard)).toBe(null);
    // An absent file is "no rules ran", never a failure.
    expect(standardRulesFor("groundUpExplanation", null)).toBe(null);
  });

  it("fails a writing-standard breach before any judge sees it", async () => {
    const item = {
      id: "batch-plan-1", job: "batch-plan", partition: "batch-plan/x", verdict: "approve",
      input: { statement: "s", memberStatements: [], priorReviseSentence: null },
      output: { groundUpExplanation: "<!DOCTYPE html><html><head><style></style></head><body><h1>x</h1></body></html>" },
    };
    const context = runContext({ modules: { "batch-plan": { graphPrompt: () => "A PROMPT" } } });
    const io = runIo(["pass"], [JSON.stringify({ groundUpExplanation: "a wall of markdown text" })]);
    const result = await runCase(item, context, io, { pr: true });
    expect(result.judged).toBe("fail");
    expect(result.reason).toMatch(/^groundUpExplanation fails the writing standard: .*no-doctype/);
    expect(io.calls.judge).toBe(0);
  });

  it("lets a well-formed explanation through to the judge", async () => {
    const item = {
      id: "batch-plan-2", job: "batch-plan", partition: "batch-plan/x", verdict: "approve",
      input: { statement: "s", memberStatements: [], priorReviseSentence: null },
      output: { groundUpExplanation: "<!DOCTYPE html><html><head><style></style></head><body><h1>x</h1></body></html>" },
    };
    const context = runContext({ modules: { "batch-plan": { graphPrompt: () => "A PROMPT" } } });
    const good = "<!DOCTYPE html><html><head><style>p{}</style></head><body><h1>The lock</h1><p>It is seized.</p></body></html>";
    const io = runIo(["pass"], [JSON.stringify({ groundUpExplanation: good })]);
    expect((await runCase(item, context, io, { pr: true })).judged).toBe("pass");
    expect(io.calls.judge).toBe(1);
  });
});

describe("efficiency", () => {
  const totals = {
    inputTokens: 1000, cacheReadTokens: 20_000, cacheWriteTokens: 500,
    cacheWrite5mTokens: 500, cacheWrite1hTokens: 0, cacheWriteBreakdownKnown: true,
    outputTokens: 300, thinkingTokens: 250, totalTokens: 21_800,
  };

  // thinkingTokens is a BREAKDOWN OF output_tokens in both parsers
  // (worker/runs/ingest.mjs), so adding it would double-count.
  it("sums the four named columns and leaves thinking out", () => {
    expect(tokensOf(totals)).toBe(21_800);
    expect(tokensOf({ ...totals, thinkingTokens: 0 })).toBe(21_800);
  });

  it("takes the median and leaves an unreadable trial out of it", () => {
    expect(medianTokens([{ tokens: 10 }, { tokens: 1000 }, { tokens: 20 }])).toBe(20);
    expect(medianTokens([{ tokens: 10 }, { tokens: null }, { tokens: 30 }])).toBe(20);
    expect(medianTokens([{ tokens: null }, { tokens: null }])).toBe(null);
    expect(medianTokens([])).toBe(null);
  });

  it("reads a trial's tokens back off the record", async () => {
    const io = runIo(["pass"], [], {
      runRecord: async (token) => (token === "tok-1" ? { runId: "r", outcome: { totals, turns: 4 } } : null),
    });
    const result = await runCase(runCaseItem({ trials: 1 }), runContext(), io, { pr: false });
    expect(result.perTrial).toEqual([{ judged: "pass", reason: "judge 1", tokens: 21_800, turns: 4 }]);
    expect(result.tokensMedian).toBe(21_800);
  });

  it("reports an unreadable record as unknown and fails nothing", async () => {
    const io = runIo(["pass"], [], { runRecord: async () => null });
    const result = await runCase(runCaseItem({ trials: 1 }), runContext(), io, { pr: false });
    expect(result.judged).toBe("pass");
    expect(result.tokensMedian).toBe(null);
    expect(efficiencyOf([{ id: "a", tokensMedian: null, judged: "pass" }], null))
      .toEqual({ cases: 1, unknown: 1, rises: [] });
  });

  // The same-output clause is load-bearing: an output that got better and
  // longer is a fact to report, not a failure.
  it("fails a threefold rise only when the verdict did not change", () => {
    const head = { id: "a", tokensMedian: 3001, judged: "pass" };
    const base = { id: "a", tokensMedian: 1000, judged: "pass" };
    expect(efficiencyVerdict(head, base)).toMatchObject({ failed: true, headTokens: 3001, baseTokens: 1000 });
    expect(efficiencyVerdict(head, { ...base, judged: "fail" }).failed).toBe(false);
    expect(efficiencyVerdict({ ...head, tokensMedian: 3000 }, base).failed).toBe(false);
    expect(efficiencyVerdict({ ...head, tokensMedian: null }, base).failed).toBe(false);
    expect(efficiencyVerdict(head, undefined).failed).toBe(false);
  });

  it("stamps the rises onto the row where the base is in hand", async () => {
    const head = {
      goldenHash: "h", scoredIds: ["a"], failures: [], tasks: { failures: [] },
      results: [{ id: "a", tokensMedian: 9000, judged: "pass", passK: true }, { id: "b", tokensMedian: null, judged: "pass", passK: true }],
    };
    const base = {
      goldenHash: "h", scoredIds: ["a"], failures: [], tasks: { failures: [] },
      results: [{ id: "a", tokensMedian: 1000, judged: "pass", passK: true }, { id: "b", tokensMedian: 100, judged: "pass", passK: true }],
    };
    const stamped = await stampAgainstBase(head, base);
    expect(stamped.efficiency).toEqual({ cases: 2, unknown: 1, rises: [{ id: "a", headTokens: 9000, baseTokens: 1000 }] });
    expect((await stampAgainstBase(head, null)).efficiency.rises).toEqual([]);
  });

  it("counts only the cases that were asked what they cost", () => {
    // A case with no tokensMedian KEY was never measured — every non-`run` job
    // is one — and counting it as an unknown would report a run that measured
    // everything it could as having measured nothing.
    const mixed = [{ id: "a", judged: "pass", passK: true }, { id: "b", judged: "pass", passK: true, tokensMedian: 500 }];
    expect(efficiencyOf(mixed, null)).toEqual({ cases: 1, unknown: 0, rises: [] });
  });
});

// The coverage verdict travels with the request, is decided by the gate's own
// body, and lands on the row the merge arm reads. THE SAME LIST REACHES BOTH
// SIDES so the CI log and the row cannot disagree about what was judged.
describe("golden coverage on the row", () => {
  const row = () => ({ goldenHash: "h", scoredIds: [], failures: [], tasks: { failures: [] }, results: [] });

  it("is false when a watched file changed and no item shipped", async () => {
    const stamped = await stampAgainstBase(row(), row(), { changed: ["scripts/prelude.mjs"] });
    expect(stamped.goldenCoverage).toBe(false);
  });

  it("is true when an item shipped, and true when the trailer excuses it", async () => {
    expect((await stampAgainstBase(row(), row(), { changed: ["scripts/prelude.mjs", "evals/golden/runs/a.json"] })).goldenCoverage).toBe(true);
    expect((await stampAgainstBase(row(), row(), {
      changed: ["scripts/prelude.mjs"],
      prBody: "a body\nevals: no-item the change is a comment\n",
    })).goldenCoverage).toBe(true);
  });

  it("is null when nobody asked about a diff, base or no base", async () => {
    // A --weekly run and a run by hand are not merge candidates. The merge gate
    // denies on null, which is the right answer for a run that was never asked.
    expect((await stampAgainstBase(row(), row())).goldenCoverage).toBe(null);
    expect((await stampAgainstBase(row(), null)).goldenCoverage).toBe(null);
  });

  it("is answered with no base at all, because coverage is a fact about the diff", async () => {
    // A branch that changed a watched file and shipped no item owes one
    // whether or not anything ever scored its base.
    expect((await stampAgainstBase(row(), null, { changed: ["AGENTS.md"] })).goldenCoverage).toBe(false);
  });

  it("says null on a run that could not be made", () => {
    const failed = failedRun({ repo: "tom.quest", sha: "deadbee", error: "no such commit", at: 1 });
    expect(failed.goldenCoverage).toBe(null);
    expect(failed.regressions).toBe(null);
    expect(failed.weekly).toBe(false);
  });
});

describe("the ablation arm", () => {
  it("runs one trial per name and records the pair", async () => {
    const io = runIo(["fail", "pass", "pass"]);
    const arm = await ablationFor(runCaseItem(), runContext(), io, true);
    expect(io.calls.regen).toBe(3);
    expect(arm.rows).toEqual([
      { id: "run-ruling-k97x2m4bq1zp", name: "operate", kind: "layer", withPass: true, withoutPass: false },
      { id: "run-ruling-k97x2m4bq1zp", name: "write", kind: "layer", withPass: true, withoutPass: true },
      { id: "run-ruling-k97x2m4bq1zp", name: "know", kind: "layer", withPass: true, withoutPass: true },
    ]);
    // Each trial assembled the prelude with exactly that one name removed.
    expect(io.calls.prompts[0]).toContain("[write+know]");
    expect(io.calls.prompts[2]).toContain("[operate+know]");
  });

  it("skips a case whose prompt was replayed verbatim, and counts it", async () => {
    const item = runCaseItem({ input: { ...runCaseItem().input, preludeKnown: false, prompt: "REPLAYED" } });
    const io = runIo();
    const arm = await ablationFor(item, runContext(), io, true);
    expect(arm.rows).toEqual([]);
    expect(arm.skipped).toEqual([{ id: item.id, reason: "the prompt was replayed verbatim; there is no name to remove" }]);
    expect(io.calls.regen).toBe(0);
  });

  // The finding is computed over the whole weekly set and never per case, and
  // a name with too little behind it is not reported at all.
  it("needs MIN_ABLATION_CASES behind a name before it reports one", () => {
    const rows = (name, count, withPass, withoutPass) => Array.from({ length: count }, (_, index) => ({
      id: `c${index}`, name, kind: "layer", withPass, withoutPass,
    }));
    expect(ablationFindings(rows("know", MIN_ABLATION_CASES - 1, true, true))).toEqual([]);
    expect(ablationFindings(rows("know", 5, true, true))).toEqual([
      { name: "know", cases: 5, withPass: 5, withoutPass: 5, earned: false },
    ]);
    expect(ablationFindings([...rows("write", 5, true, false)])).toEqual([
      { name: "write", cases: 5, withPass: 5, withoutPass: 0, earned: true },
    ]);
    expect(ablationFindings([])).toEqual([]);
  });
});

describe("runEvals over a run case", () => {
  const runIoFor = (dir, verdicts) => runIo(verdicts, [], {
    layers: () => layers,
    loadModules: async () => ({}),
    taskRepos: () => [],
    worktree: (repo) => ({ dir, commit: repo === "WikiTom" ? "wiki1" : "tq1", remove: () => {} }),
  });
  const caseDir = (over) => {
    const dir = tree();
    writeJson(dir, path.join("evals", "golden", "runs", "a.json"), runCaseItem({ id: "a", ...over }));
    return dir;
  };

  it("scores one trial on a pull-request run and records the case's cost", async () => {
    const dir = caseDir();
    const io = runIoFor(dir, ["pass"]);
    const run = await runEvals({ repo: "tom.quest", sha: "head" }, io);
    expect(run).toMatchObject({ items: 1, pass: 1, fail: 0 });
    expect(io.calls.regen).toBe(1);
    expect(run.results).toEqual([{ id: "a", judged: "pass", passK: true, tokensMedian: null }]);
    expect(run.ablation).toEqual([]);
  });

  it("takes every trial on a weekly run", async () => {
    const io = runIoFor(caseDir(), ["pass", "pass", "pass"]);
    await runEvals({ repo: "tom.quest", sha: "origin/main", weekly: true }, io);
    expect(io.calls.regen).toBe(3);
  });

  it("runs the arm when it is asked for and never otherwise", async () => {
    const io = runIoFor(caseDir(), ["pass", "pass", "pass", "pass"]);
    const run = await runEvals({ repo: "tom.quest", sha: "head", ablation: true }, io);
    // One trial for the case, then one per ablated name.
    expect(io.calls.regen).toBe(4);
    expect(run.ablation.map((row) => row.name)).toEqual(["operate", "write", "know"]);
    expect(run.ablation.every((row) => row.withPass === true)).toBe(true);
    const quiet = runIoFor(caseDir(), ["pass"]);
    expect((await runEvals({ repo: "tom.quest", sha: "head" }, quiet)).ablation).toEqual([]);
    expect(quiet.calls.regen).toBe(1);
  });
});

// The count rule lives here, where `npm test` states it in one line, rather
// than in a merge check that would have to fetch a run from the box to say
// something about a checked-in file.
describe("the trigger set", () => {
  it("carries at least as many negatives as positives in every file", () => {
    // The directory arrives with another branch; until then there is nothing
    // to count, and an empty set is not a failure.
    const short = loadTriggers(path.resolve("."))
      .map((trigger) => ({ file: trigger.file, ...triggerCounts(trigger) }))
      .filter((counts) => counts.negatives < counts.positives);
    expect(short).toEqual([]);
  });

  it("never loads a draft", () => {
    const dir = tree();
    writeJson(dir, path.join("evals", "triggers", "hourly.json"), { positives: ["a"], negatives: ["b", "c"] });
    writeJson(dir, path.join("evals", "triggers", "hourly.draft.json"), { positives: ["a", "b"], negatives: [] });
    expect(loadTriggers(dir).map((one) => one.file)).toEqual(["hourly.json"]);
    expect(triggerCounts(loadTriggers(dir)[0])).toEqual({ positives: 1, negatives: 2 });
    expect(loadTriggers(tree())).toEqual([]);
  });
});
