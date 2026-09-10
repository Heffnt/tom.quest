import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregate,
  goldenHash,
  JOBS,
  judgePrompt,
  loadGolden,
  loadTasks,
  parseArgs,
  parseJudge,
  runItem,
  runTask,
  scoreLearning,
  selectItems,
  stampAgainstBase,
  TASK_BRANCHES,
  treesFor,
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
});
