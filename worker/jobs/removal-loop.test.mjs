import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

import {
  LABEL,
  REMOVAL_LOOP_PR,
  REMOVAL_LOOP_RUN,
  closeComment,
  feedbackText,
  nextSteeringId,
  parseReport,
  refusedKeys,
  runRemovalLoop,
  steeringEntry,
  wordsBeyondRevert,
} from "./removal-loop.mjs";

const NOW = Date.parse("2026-09-19T09:00:00Z"); // 5 a.m. New York
const ENV = { CONVEX_SITE_URL: "https://example.convex.site", TTS_WORKER_KEY: "k" };
const VIOLATION = {
  ruleId: "dead-export",
  path: "app/boolback/components/group-plot.tsx",
  fingerprint: "223ba4a3",
  lines: 1,
  files: 1,
  line: 93,
  text: "export type ExamplePanel = { id: string };",
};
const BODY = "### What was removed\nA type nobody else names.\n\n### Why it cannot be needed\nNothing imports it.\n\n### What a person would notice\nNothing.";
const REPORT = `SUBJECT: boolback: the facet panel type is local to the plot\n\n${BODY}\nbox-run: run abcd1234 host box runner claude exit 0 after 300s\n`;

/** A fake of every door. `open` and `closed` are what gh lists; `removals` is
 *  what GET /tts/removals-open answers; `report` is what the box run prints. */
function world({ open = [], closed = [], removals = [], gate = { allowed: true, missing: [] }, report = REPORT, state = {}, pushed = "f00d\trefs/heads/x" } = {}) {
  const calls = { gh: [], git: [], node: [], boxRun: [], audit: [], fetch: [], out: [], files: {} };
  let saved = null;
  const io = {
    now: () => NOW,
    gh: (args) => {
      calls.gh.push(args);
      if (args[0] === "pr" && args[1] === "list") return { ok: true, stdout: JSON.stringify(args.includes("open") ? open : closed) };
      if (args[0] === "pr" && args[1] === "create") return { ok: true, stdout: "https://github.com/Heffnt/tom.quest/pull/42\n" };
      if (args[0] === "pr" && args[1] === "diff") return { ok: true, stdout: "diff --git a/x b/x\n-export type A = 1;\n+type A = 1;\n" };
      if (args[0] === "pr" && args[1] === "view") return { ok: true, stdout: JSON.stringify({ headRefOid: "beef2" }) };
      return { ok: true, stdout: "" };
    },
    git: (args) => {
      calls.git.push(args);
      if (args.includes("rev-parse")) return { ok: true, stdout: "cafe1234\n" };
      if (args[0] === "ls-remote") return { ok: true, stdout: pushed };
      if (args.includes("merge-base")) return { ok: true, stdout: "base0\n" };
      if (args.includes("show")) return { ok: true, stdout: "- id: removal-loop-dead-export-1\n" };
      return { ok: true, stdout: "" };
    },
    node: (args) => {
      calls.node.push(args);
      return { ok: true, stdout: JSON.stringify({ violation: VIOLATION, live: 603, baseline: 603, excluded: 0 }) };
    },
    boxRun: (args, prompt) => {
      calls.boxRun.push({ args, prompt });
      return { ok: true, status: 0, stdout: report, stderr: "" };
    },
    audit: (args) => {
      calls.audit.push(args);
      return { ok: true, status: 0, stdout: "verdict: APPROVED", stderr: "" };
    },
    fetch: async (_env, route, body) => {
      calls.fetch.push({ route, body });
      if (route === "/tts/removals-open") return { removals };
      if (route.startsWith("/tts/merge-gate")) return gate;
      return { ok: true };
    },
    readFile: () => "# dead-export — the after-state\n",
    exists: () => true,
    yaml: (file) => (file.endsWith("steering.yaml") && file.includes("removal-loop-") ? [] : [
      { id: "ground-up-explanations", trigger: "any explanation for Tom", correction: "Explain ground-up." },
      { id: "removal-loop-dead-export-1", trigger: "a dead export", correction: "keep types a test reads" },
      { id: "plans-inline", trigger: "planning", correction: "inline" },
    ]),
    tempFile: (name, text) => {
      calls.files[name] = text;
      return `/tmp/${name}`;
    },
    stateRead: () => structuredClone(state),
    stateWrite: (next) => {
      saved = next;
    },
    reportFailed: async () => {},
    reportOk: async () => {},
    out: (line) => calls.out.push(line),
  };
  return { io, calls, saved: () => saved };
}

const run = (w, over = {}) => runRemovalLoop({ force: true, env: ENV, io: w.io, ...over });
const events = (calls, kind) => calls.fetch.filter((c) => c.route === "/tts/event" && c.body.kind === kind).map((c) => c.body);

const OPEN_PR = {
  number: 42,
  headRefOid: "beef1",
  headRefName: "loop/removals/dead-export-223ba4a3",
  title: "boolback: the facet panel type is local to the plot",
  url: "https://github.com/Heffnt/tom.quest/pull/42",
  body: BODY,
};

describe("a day with no loop pull request open", () => {
  it("picks, runs Opus once, opens the pull request with the label, and records it for #tts-simplify", async () => {
    const w = world();
    const result = await run(w);
    expect(result).toMatchObject({ action: "opened", pr: 42 });
    expect(w.calls.boxRun).toHaveLength(1);
    expect(w.calls.boxRun[0].args).toEqual([
      "--runner", "claude", "--model", "opus", "--repo", "tom.quest", "--ref", "main", "--install", "--tests",
    ]);
    const prompt = w.calls.boxRun[0].prompt;
    expect(prompt).toContain("app/boolback/components/group-plot.tsx");
    expect(prompt).toContain("git switch -c loop/removals/dead-export-223ba4a3");
    expect(prompt).toContain("# dead-export — the after-state");
    expect(prompt).toContain("Do: Explain ground-up.");
    expect(prompt).toContain("Do: keep types a test reads");
    expect(prompt).not.toContain("inline");
    expect(prompt).toContain("tom-write");
    const create = w.calls.gh.find((a) => a[1] === "create");
    expect(create).toEqual(expect.arrayContaining(["--label", LABEL, "--base", "main", "--title", OPEN_PR.title]));
    expect(w.calls.files["body.md"]).toBe(BODY);
    expect(events(w.calls, REMOVAL_LOOP_PR)).toEqual([
      expect.objectContaining({ key: "loop:42", data: expect.objectContaining({ pr: 42, round: 0, ruleId: "dead-export", sha: "f00d" }) }),
    ]);
    expect(w.calls.audit[0]).toEqual(expect.arrayContaining(["--sha", "f00d", "--base", "base0"]));
    expect(w.saved().audited).toEqual({ f00d: true });
  });

  it("excludes what Tom closed and what a run declined", async () => {
    const w = world({
      closed: [
        { headRefName: "loop/removals/dead-export-11111111", mergedAt: null },
        { headRefName: "loop/removals/dead-export-22222222", mergedAt: "2026-09-10T00:00:00Z" },
      ],
      state: { declined: { "flag-not-deletion-33333333": { why: "a spread passes it" } } },
    });
    await run(w);
    expect(w.calls.node[0]).toEqual(["scripts/removal-pick.mjs", "--exclude", "dead-export-11111111,flag-not-deletion-33333333"]);
  });

  it("records a decline, opens nothing, and never picks it again", async () => {
    const w = world({ report: "DECLINED: a string names it in a cron line\nbox-run: run a host box runner claude exit 0 after 9s\n" });
    const result = await run(w);
    expect(result.action).toBe("declined");
    expect(w.calls.gh.some((a) => a[1] === "create")).toBe(false);
    expect(w.saved().declined["dead-export-223ba4a3"].why).toBe("a string names it in a cron line");
  });

  it("opens nothing when the run pushed nothing", async () => {
    const w = world({ pushed: "" });
    const result = await run(w);
    expect(result.action).toBe("run-failed");
    expect(w.calls.gh.some((a) => a[1] === "create")).toBe(false);
  });

  it("prints the prompt on a dry run and spawns, opens and posts nothing", async () => {
    const w = world();
    const result = await run(w, { dryRun: true });
    expect(result.action).toBe("dry-run");
    expect(w.calls.boxRun).toHaveLength(0);
    expect(w.calls.fetch).toHaveLength(0);
    expect(w.calls.out.join("\n")).toContain("## The violation");
    expect(w.saved()).toBeNull();
  });

  it("does nothing outside five in the morning unless forced", async () => {
    const w = world();
    expect(await runRemovalLoop({ env: ENV, io: { ...w.io, now: () => NOW + 3_600_000 } })).toBeNull();
  });
});

describe("a day with a loop pull request open", () => {
  const row = (over = {}) => ({ askId: "loop:42", pr: 42, round: 0, at: NOW - 30 * 3_600_000, objection: null, windowClosed: false, ...over });

  it("holds while his day is open, spawning nothing and picking nothing", async () => {
    const w = world({ open: [OPEN_PR], removals: [row()], state: { audited: { beef1: true } } });
    const result = await run(w);
    expect(result).toMatchObject({ action: "held", pr: 42 });
    expect(w.calls.boxRun).toHaveLength(0);
    expect(w.calls.node).toHaveLength(0);
    expect(events(w.calls, REMOVAL_LOOP_RUN)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ held: true, pr: 42, action: "held" }) }),
    ]);
    expect(events(w.calls, REMOVAL_LOOP_PR)).toHaveLength(0);
  });

  it("merges when the day and a digest have passed and the gate is open, then records the merge", async () => {
    const w = world({ open: [OPEN_PR], removals: [row({ windowClosed: true })] });
    const result = await run(w);
    expect(result.action).toBe("merged");
    expect(w.calls.gh.find((a) => a[1] === "merge")).toEqual([
      "pr", "merge", "42", "--squash", "--repo", "Heffnt/tom.quest", "--match-head-commit", "beef1",
    ]);
    expect(w.calls.fetch.find((c) => c.route === "/tts/merge").body).toEqual({ repo: "tom.quest", sha: "beef1", subject: OPEN_PR.title });
  });

  it("does not merge while the gate is shut, and audits a head nobody audited", async () => {
    const w = world({ open: [OPEN_PR], removals: [row({ windowClosed: true })], gate: { allowed: false, missing: ["audit"] } });
    const result = await run(w);
    expect(result).toMatchObject({ action: "held", reason: "the merge gate is shut: audit" });
    expect(w.calls.gh.some((a) => a[1] === "merge")).toBe(false);
    expect(w.calls.audit).toHaveLength(1);
  });

  it("closes on a revert, quoting him, and carries his further words to the next pull request", async () => {
    const words = "revert — that type is the plot's public shape";
    const w = world({ open: [OPEN_PR], removals: [row({ objection: { at: NOW - 3_600_000, text: words, revert: true } })] });
    const result = await run(w);
    expect(result.action).toBe("closed");
    const close = w.calls.gh.find((a) => a[1] === "close");
    expect(close.slice(0, 3)).toEqual(["pr", "close", "42"]);
    expect(close[close.indexOf("--comment") + 1]).toContain("> revert — that type is the plot's public shape");
    expect(w.saved().pendingSteering).toEqual([{ words, pr: 42, branch: OPEN_PR.headRefName, day: "2026-09-19" }]);
    expect(w.calls.gh.some((a) => a[1] === "merge")).toBe(false);
  });

});

describe("the pure pieces", () => {
  it("splits a report into subject and body, and strips box-run's status line", () => {
    expect(parseReport(REPORT)).toEqual({ declined: null, subject: OPEN_PR.title, body: BODY });
    expect(parseReport("DECLINED: nope\n").declined).toBe("nope");
    expect(parseReport("I did it!").unusable).toBe("I did it!");
  });

  it("writes a steering entry the registry guard accepts, his words untouched", () => {
    const words = "keep it: the export is read by name\nand say so in the body";
    const text = steeringEntry({ id: "removal-loop-dead-export-2", ruleId: "dead-export", where: "branch x", pr: 42, words, day: "2026-09-19" });
    const [entry] = loadYaml(text);
    expect(entry).toEqual({
      id: "removal-loop-dead-export-2",
      kind: "preference",
      owner: "tom",
      created: expect.anything(),
      trigger: "a removal-loop pull request for dead-export, as on pull request 42 (branch x)",
      correction: words,
      incidents: 1,
      graduation: "prose",
    });
  });

  it("numbers entries per rule", () => {
    expect(nextSteeringId([{ id: "removal-loop-dead-export-1" }, { id: "removal-loop-dead-export-3" }, { id: "removal-loop-flag-not-deletion-7" }], "dead-export")).toBe(
      "removal-loop-dead-export-4",
    );
    expect(nextSteeringId([], "check-not-deletion")).toBe("removal-loop-check-not-deletion-1");
  });

  it("reads a closed branch as a refusal only when it was not merged", () => {
    expect(refusedKeys([{ headRefName: "loop/removals/a-1", mergedAt: null }, { headRefName: "loop/removals/b-2", mergedAt: "x" }])).toEqual(["a-1"]);
  });

  it("tells a bare revert from one with words", () => {
    expect(wordsBeyondRevert("revert")).toBe(false);
    expect(wordsBeyondRevert("Revert.")).toBe(false);
    expect(wordsBeyondRevert("revert, it is read by name")).toBe(true);
  });

  it("quotes every line of his words when it closes", () => {
    expect(closeComment("revert\nplease")).toContain("> revert\n> please");
  });

  it("says so when there is no feedback yet", () => {
    expect(feedbackText([])).toBe("None yet.");
  });
});
