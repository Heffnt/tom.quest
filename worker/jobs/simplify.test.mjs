// Tests for the weekly simplification pass (worker/jobs/simplify.mjs): its
// pure halves, and the whole run against fakes for its doors (REAL_IO's shape —
// Convex, the model, git, gh, the clock, the marker file, stdout).
//
// What is pinned is what a mistake in would be SILENT. The measurement's
// numbers and every candidate on a fixture with known counts, so a threshold
// changed by accident fails here and not in a proposal Tom reads. Every one of
// the parser's refusals, one assertion each, because each refusal is a
// different way for a model to invent something the measurement never said.
// That a day runs once, that an empty answer is a clean run, that a failed
// model call still leaves the facts recorded, and that a dry run writes
// nothing at all.
//
// Importing the job module is safe: it only calls main() when node was pointed
// at the file (the `invokedDirectly` guard at the bottom of it).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ADMIT_PER_RUN,
  FACTS_TEXT_MAX_BYTES,
  MAX_PROPOSALS,
  MIN_LOADED,
  OPERATE_FILE,
  PROPOSAL_COOLDOWN_WEEKS,
  SIMPLIFY_ADMITTED,
  SIMPLIFY_PROPOSAL,
  SIMPLIFY_RUN,
  blastRows,
  candidateFor,
  decisionPreview,
  factsBlock,
  factsText,
  grepCounts,
  jaccard,
  nounsOf,
  parseProposals,
  proposalId,
  proxyMattered,
  ruleId,
  ruleLines,
  runSimplify,
  schemaFields,
  simplifyPrompt,
} from "./simplify.mjs";

const DAY = "2026-09-11";
// 2026-09-11 08:00 UTC is 4 a.m. EDT — the cron slot the NY-hour guard keeps.
const NOW = Date.UTC(2026, 8, 11, 8);

const tmpDirs = [];
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// ── The fixture with known counts ────────────────────────────────────────────
//
// 100 runs; 40 of them under /root/tomquest/worker, 35 at the checkout root,
// 25 with no working directory recorded at all. Three skills, one used on 95
// of the 100. Three schema fields, one with no grep hit and one with twelve.
// Three merge-gate heads: 40/0, 40/3 and 12/0.

const RULES_FIXTURE = [
  "# Agent rules",
  "",
  "- Commit with a full message before every stop.",
  "- The orchestrator implements nothing; subagents do the work.",
  "- Ask in prose.",
].join("\n");

const ROOT_AGENTS = ["# tom.quest", "", "- Every change lands through the merge gate."].join("\n");
const WORKER_AGENTS = ["# worker", "", "- The worker jobs never import a npm dependency."].join("\n");

const SCHEMA_FIXTURE = [
  'import { defineSchema, defineTable } from "convex/server";',
  "",
  "export default defineSchema({",
  "  widgets: defineTable({",
  "    unusedField: v.string(),",
  "    usedField: v.number(),",
  "    nested: v.object({",
  "      innerField: v.string(),",
  "      deeper: v.number(),",
  "    }),",
  '  }).index("by_used", ["usedField"]),',
  "});",
].join("\n");

/** Twenty-four sampled runs, all with a readable transcript — above MIN_LOADED,
 *  which is the floor on the proxy's DENOMINATOR as well as on `loaded`, so
 *  these rules are measurable at all. Two carry the orchestrator rule's words;
 *  none carries the commit rule's pair, so that rule scores zero against a
 *  generous proxy. */
function sample() {
  const runs = [];
  for (let i = 0; i < 24; i += 1) {
    runs.push({
      runId: `run-${i}`,
      startedAt: NOW - i * 3_600_000,
      depth: 0,
      tokens: i < 2 ? ["orchestrator", "subagents", "convex"] : ["convex", "planner"],
    });
  }
  return runs;
}

function input(overrides = {}) {
  return {
    window: { since: NOW - 28 * 86_400_000, until: NOW, weeks: 4 },
    runs: { total: 100, capped: false, byOrigin: {}, byRunner: {}, byHost: {}, byKind: {}, withContext: 90, layersKnownTrue: 80 },
    layers: [],
    skills: [
      { name: "graphify-search", offered: 100, used: 95 },
      { name: "browser-preview", offered: 100, used: 0 },
      { name: "skill", offered: 100, used: 0 },
    ],
    tools: [{ name: "Read", runs: 100 }],
    hooks: [{ name: "SessionStart", runs: 100 }],
    cwds: [
      { cwd: "/root/tomquest/worker", runs: 40 },
      { cwd: "/root/tomquest", runs: 35 },
      { cwd: null, runs: 25 },
    ],
    sample: sample(),
    gate: {
      tests: { heads: 40, failed: 0, failures: [] },
      audit: { heads: 40, failed: 3, failures: [{ key: "tom.quest@abc", why: "REFUSED", at: NOW }] },
      evals: { heads: 12, failed: 0, failures: [] },
    },
    evals: { runs: 4, withAblation: 0, ablation: [] },
    priorProposals: [],
    writingStandard: "WRITE STANDARD",
    ...overrides,
  };
}

/** The checkout the job reads the schema, the AGENTS.md files and git grep
 *  from, and the WikiTom checkout beside it. */
function checkouts() {
  const repoDir = tmp("simplify-repo-");
  const wiki = tmp("simplify-wiki-");
  write(repoDir, "convex/schema.ts", SCHEMA_FIXTURE);
  write(repoDir, "AGENTS.md", ROOT_AGENTS);
  write(repoDir, "worker/AGENTS.md", WORKER_AGENTS);
  write(repoDir, "node_modules/AGENTS.md", "- this one is skipped");
  write(wiki, OPERATE_FILE, RULES_FIXTURE);
  write(wiki, "model-of-tom/intent.md", "- The orchestrator implements nothing; subagents do the work.");
  return { repoDir, wiki };
}

/** git grep's answer: twelve lines mention usedField and nothing mentions the
 *  other two. Exit 1 with no output is what real `git grep` does on no match,
 *  and the job must read that as zero rather than as a failure. */
function fakeGit(calls = []) {
  return (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] !== "grep") return { ok: false, status: 1, stdout: "", error: null };
    const hits = [];
    for (let i = 0; i < 12; i += 1) hits.push(`convex/widgets.ts:${i + 1}:  usedField: ${i},`);
    return { ok: true, status: 0, stdout: `${hits.join("\n")}\n`, error: null };
  };
}

/** gh absent. Every Guardrails row is then `known: false` and forced to keep. */
const ghAbsent = () => ({ ok: false, status: 127, stdout: "", error: "gh: command not found" });

function harness({
  answer = '{"proposals":[]}',
  open = [],
  simplifyInput = input(),
  marker = null,
  modelThrows = false,
  repoDirThrows = false,
} = {}) {
  const { repoDir, wiki } = checkouts();
  const posted = [];
  const captured = [];
  const paths = [];
  const out = [];
  const fetchedRepo = [];
  const reports = { failed: [], ok: [] };
  const markers = new Map(marker === null ? [] : [[DAY, marker]]);
  const io = {
    fetch: async (env, route, body) => {
      paths.push(route);
      // The door's own field name and its own row shape (convex/http.ts
      // ttsSimplifyOpen over ttsSimplify.internalOpenProposals). A fixture
      // that invented either would prove the job against a door that does not
      // exist, which is the one thing a fake must not do.
      if (route === "/tts/simplify-open") return { open };
      if (route.startsWith("/tts/simplify-input")) return simplifyInput;
      if (route === "/tts/capture") {
        captured.push(body);
        return { ok: true, id: `todo-${captured.length}` };
      }
      if (route === "/tts/event") {
        posted.push(body);
        return { ok: true, id: `event-${posted.length}` };
      }
      throw new Error(`unexpected route ${route}`);
    },
    model: () => {
      if (modelThrows) throw new Error("claude returned an error envelope (subtype: error_max_turns)");
      return answer;
    },
    now: () => NOW,
    readFile: (file) => fs.readFileSync(file, "utf8"),
    exists: (file) => fs.existsSync(file),
    readDir: (dir) => fs.readdirSync(dir, { withFileTypes: true }),
    git: fakeGit(),
    gh: ghAbsent,
    repoDir: (env) => {
      fetchedRepo.push(env);
      if (repoDirThrows) throw new Error("missing GH_TOKEN in /etc/tts/worker.env — the cache clones need it");
      return repoDir;
    },
    markerRead: (day) => markers.get(day) ?? null,
    markerWrite: (day, record) => markers.set(day, record),
    reportFailed: async (env, body) => reports.failed.push(body),
    reportOk: async (env, body) => reports.ok.push(body),
    out: (line) => out.push(line),
  };
  const run = (extra = {}) =>
    runSimplify({
      force: true,
      env: { CONVEX_SITE_URL: "https://example.invalid", TTS_WORKER_KEY: "fake" },
      dir: wiki,
      repoDir,
      repoName: "tomquest",
      io,
      ...extra,
    });
  return { run, posted, captured, paths, out, reports, markers, repoDir, wiki, io, fetchedRepo };
}

const byId = (rows) => new Map(rows.map((row) => [row.id, row]));
const rowFor = (rows, text) => rows.find((row) => row.text === text);

// ── 1. the measurement ───────────────────────────────────────────────────────

describe("the measurement on a fixture with known counts", () => {
  it("pins every loaded, every proxy.mattered and every candidate", async () => {
    const { run } = harness();
    const result = await run({ printFacts: true });
    const rows = result.facts.rows;

    // Rules of the operate layer: loaded is runs.total, because the base layer
    // is on every run.
    const commit = rowFor(rows, "- Commit with a full message before every stop.");
    expect(commit.loaded).toBe(100);
    expect(commit.loadedUnknown).toBe(0);
    expect(commit.proxy.mattered).toBe(0);
    expect(commit.candidate).toBe("remove");

    const orchestrator = rowFor(rows, "- The orchestrator implements nothing; subagents do the work.");
    expect(orchestrator.loaded).toBe(100);
    expect(orchestrator.proxy.mattered).toBe(2);
    expect(orchestrator.candidate).toBe("keep");
    // Its words are a line of intent.md, so it is his to change either way.
    expect(orchestrator.needsHisWords).toBe(true);

    // The root AGENTS.md: every cwd inside a directory named like the checkout.
    const rootRule = rowFor(rows, "- Every change lands through the merge gate.");
    expect(rootRule.loaded).toBe(75);
    expect(rootRule.loadedUnknown).toBe(25);

    // worker/AGENTS.md: only the runs at or under worker/.
    const workerRule = rowFor(rows, "- The worker jobs never import a npm dependency.");
    expect(workerRule.loaded).toBe(40);
    expect(workerRule.loadedUnknown).toBe(25);
    expect(workerRule.proxy.mattered).toBe(0);
    expect(workerRule.candidate).toBe("remove");

    // Skills, exact: 95 of 100 is base prompt, 0 of 100 is a removal.
    const graphify = rowFor(rows, "graphify-search");
    expect(graphify.proxy.mattered).toBe(95);
    expect(graphify.candidate).toBe("collapse");
    expect(graphify.collapseInto).toBe(OPERATE_FILE);
    const browser = rowFor(rows, "browser-preview");
    expect(browser.loaded).toBe(100);
    expect(browser.proxy.mattered).toBe(0);
    expect(browser.candidate).toBe("remove");

    // Schema fields: zero grep hits is the removal, twelve is not a keep
    // argument but is recorded, and a nested field is not a row at all.
    const unused = rowFor(rows, "unusedField");
    expect(unused.grep).toEqual({ count: 0, upperBound: true });
    expect(unused.candidate).toBe("remove");
    const used = rowFor(rows, "usedField");
    expect(used.grep.count).toBe(12);
    expect(used.candidate).toBe("keep");
    expect(rowFor(rows, "innerField")).toBeUndefined();

    // Checks: 40 heads and no failure is a removal; 3 failures is a keep; 12
    // heads is below MIN_LOADED and is a keep whatever the failures say.
    const tests = rowFor(rows, "the merge gate's tests head");
    expect(tests.failures).toEqual({ failed: 0, heads: 40, known: true });
    expect(tests.candidate).toBe("remove");
    const audit = rowFor(rows, "the merge gate's audit head");
    expect(audit.failures.failed).toBe(3);
    expect(audit.candidate).toBe("keep");
    const evals = rowFor(rows, "the merge gate's evals head");
    expect(evals.failures.heads).toBeLessThan(MIN_LOADED);
    expect(evals.candidate).toBe("keep");
  });
});

// ── 2. the proxy is a proxy ──────────────────────────────────────────────────

describe("the proxy counts assistant text, not tool results", () => {
  it("scores zero on a bag built without the tool-result words and one with them", () => {
    // The token bag skips tool-result rows, which is the input route's job, so
    // the seam is asserted here: the same nouns decide the count.
    const nouns = nounsOf("The orchestrator implements nothing; subagents do the work.");
    const withoutToolResult = [{ tokens: ["convex", "planner", "digest"] }];
    const withToolResult = [{ tokens: ["convex", "orchestrator", "subagents"] }];
    expect(proxyMattered(nouns, withoutToolResult)).toBe(0);
    expect(proxyMattered(nouns, withToolResult)).toBe(1);
  });
});

// ── 3. too few nouns ─────────────────────────────────────────────────────────

describe("a rule with fewer than two nouns", () => {
  it("has no proxy and is kept", async () => {
    const { run } = harness();
    const result = await run({ printFacts: true });
    const ask = rowFor(result.facts.rows, "- Ask in prose.");
    expect(ask.proxy.mattered).toBeNull();
    expect(ask.proxy.nouns).toEqual([]);
    expect(ask.proxy.note).toBe("no proxy");
    expect(ask.candidate).toBe("keep");
  });
});

// ── 4. an unread failure history ─────────────────────────────────────────────

describe("a check whose failure history was not read", () => {
  it("is kept even though no failure is recorded", () => {
    const row = {
      id: "aaaaaaaa",
      class: "check",
      where: ".github/workflows/guardrails.yml",
      text: "the secret-scan job of the Guardrails workflow",
      loaded: 0,
      loadedUnknown: 0,
      proxy: { nouns: [], mattered: null, sample: 0, note: "" },
      failures: { failed: 0, heads: 500, known: false },
      grep: null,
    };
    expect(candidateFor(row, { runsTotal: 100, peers: [row] }).candidate).toBe("keep");
    expect(candidateFor({ ...row, failures: { ...row.failures, known: true } }, { runsTotal: 100, peers: [] }).candidate).toBe("remove");
  });
});

// ── 5. the parser's refusals ─────────────────────────────────────────────────

function rows() {
  return [
    {
      id: "r0000001",
      class: "rule",
      where: "worker/AGENTS.md",
      text: "- a removable line",
      loaded: 40,
      loadedUnknown: 25,
      proxy: { nouns: ["worker", "import"], mattered: 0, sample: 10, note: "" },
      failures: { failed: 0, heads: 0, known: true },
      grep: null,
      candidate: "remove",
      collapseInto: null,
      needsHisWords: false,
    },
    {
      id: "r0000002",
      class: "rule",
      where: "worker/AGENTS.md",
      text: "- a collapsible line that is longer than its neighbour",
      loaded: 40,
      loadedUnknown: 25,
      proxy: { nouns: ["worker", "import"], mattered: 3, sample: 10, note: "" },
      failures: { failed: 0, heads: 0, known: true },
      grep: null,
      candidate: "collapse",
      collapseInto: "r0000003",
      needsHisWords: false,
    },
    {
      id: "r0000003",
      class: "rule",
      where: "worker/AGENTS.md",
      text: "- the short one",
      loaded: 40,
      loadedUnknown: 25,
      proxy: { nouns: ["worker", "import"], mattered: 3, sample: 10, note: "" },
      failures: { failed: 0, heads: 0, known: true },
      grep: null,
      candidate: "keep",
      collapseInto: null,
      needsHisWords: false,
    },
    {
      id: "r0000004",
      class: "rule",
      where: OPERATE_FILE,
      text: "- a removable line Tom already ruled on",
      loaded: 100,
      loadedUnknown: 25,
      proxy: { nouns: ["ruling", "verdict"], mattered: 0, sample: 10, note: "" },
      failures: { failed: 0, heads: 0, known: true },
      grep: null,
      candidate: "remove",
      collapseInto: null,
      needsHisWords: true,
    },
  ];
}

function proposal(overrides = {}) {
  return {
    id: "r0000001",
    action: "remove",
    into: null,
    sentence: "worker/AGENTS.md no longer carries the line about imports.",
    evidence: "Loaded on 40 runs, matched by 0 of 10 sampled runs.",
    counterfactual: "Nothing in the 10 runs read would have changed had the line been absent.",
    needsHisWords: false,
    ...overrides,
  };
}

const answerOf = (...list) => JSON.stringify({ proposals: list });

describe("parsing the model's proposals", () => {
  it("keeps a well-formed proposal and gives it a day-and-row id", () => {
    const { proposals, refused } = parseProposals(answerOf(proposal()), { rows: rows(), day: DAY });
    expect(refused).toEqual([]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].id).toBe(proposalId(DAY, "r0000001"));
    expect(proposals[0].rowId).toBe("r0000001");
    expect(proposals[0].action).toBe("remove");
  });

  it("drops a proposal that names a keep row", () => {
    const { proposals, refused } = parseProposals(answerOf(proposal({ id: "r0000003" })), { rows: rows(), day: DAY });
    expect(proposals).toHaveLength(0);
    expect(refused[0].why).toBe("named a row it may not propose from");
  });

  it("drops a proposal that names no row at all", () => {
    const { proposals, refused } = parseProposals(answerOf(proposal({ id: "invented1" })), { rows: rows(), day: DAY });
    expect(proposals).toHaveLength(0);
    expect(refused[0].why).toBe("named a row it may not propose from");
  });

  it("drops an action that is not the row's candidate", () => {
    const { proposals, refused } = parseProposals(
      answerOf(proposal({ id: "r0000002", action: "remove" })),
      { rows: rows(), day: DAY },
    );
    expect(proposals).toHaveLength(0);
    expect(refused[0].why).toContain('the measurement says "collapse"');
  });

  it("drops a collapse with no into", () => {
    const { proposals, refused } = parseProposals(
      answerOf(proposal({ id: "r0000002", action: "collapse", into: null })),
      { rows: rows(), day: DAY },
    );
    expect(proposals).toHaveLength(0);
    expect(refused[0].why).toContain("must name r0000003");
  });

  it("drops evidence carrying an integer that is not one of the row's numbers", () => {
    const { proposals, refused } = parseProposals(
      answerOf(proposal({ evidence: "Loaded on 40 runs, matched by 0 of 137 sampled runs." })),
      { rows: rows(), day: DAY },
    );
    expect(proposals).toHaveLength(0);
    expect(refused[0].why).toContain("names 137");
  });

  it("cannot lower a needsHisWords the measurement raised", () => {
    const { proposals } = parseProposals(
      answerOf(proposal({ id: "r0000004", needsHisWords: false, evidence: "Loaded on 100 runs, matched by 0 of 10." })),
      { rows: rows(), day: DAY },
    );
    expect(proposals[0].needsHisWords).toBe(true);
  });

  it("drops the sixth proposal", () => {
    // Six proposals over four rows: the ids repeat, which is fine — the cap is
    // on how many survive, and the sixth is past it.
    const six = [
      proposal(),
      proposal({ id: "r0000002", action: "collapse", into: "r0000003", evidence: "3 of 10 sampled runs." }),
      proposal({ id: "r0000004", evidence: "Loaded on 100 runs." }),
      proposal(),
      proposal({ id: "r0000002", action: "collapse", into: "r0000003", evidence: "3 of 10 sampled runs." }),
      proposal({ id: "r0000004", evidence: "Loaded on 100 runs." }),
    ];
    const { proposals, refused } = parseProposals(answerOf(...six), { rows: rows(), day: DAY });
    expect(proposals).toHaveLength(MAX_PROPOSALS);
    expect(refused).toHaveLength(1);
    expect(refused[0].why).toContain(`past the fifth`);
  });

  it("drops a row proposed three weeks ago", () => {
    const at = Date.parse(`${DAY}T00:00:00.000Z`) - 21 * 86_400_000;
    const { proposals, refused } = parseProposals(answerOf(proposal()), {
      rows: rows(),
      priorProposals: [{ askId: "simplify:aaaa", rowId: "r0000001", at, objectedAt: null }],
      day: DAY,
    });
    expect(proposals).toHaveLength(0);
    expect(refused[0].why).toContain(`last ${PROPOSAL_COOLDOWN_WEEKS} weeks`);
  });

  it("drops a row Tom objected to, however long ago", () => {
    const at = Date.parse(`${DAY}T00:00:00.000Z`) - 400 * 86_400_000;
    const { proposals, refused } = parseProposals(answerOf(proposal()), {
      rows: rows(),
      priorProposals: [{ askId: "simplify:aaaa", rowId: "r0000001", at, objectedAt: at + 3600_000 }],
      day: DAY,
    });
    expect(proposals).toHaveLength(0);
    expect(refused[0].why).toContain("an objection is permanent");
  });
});

// ── 6. an empty list is a clean run ──────────────────────────────────────────

describe("an empty proposal list", () => {
  it("is a clean run and records proposed: 0", async () => {
    const { run, posted, reports } = harness({ answer: '{"proposals": []}' });
    const result = await run();
    expect(result.failures).toEqual([]);
    expect(result.proposed).toBe(0);
    const runEvent = posted.find((event) => event.kind === SIMPLIFY_RUN);
    expect(runEvent.key).toBe(DAY);
    expect(runEvent.data.proposed).toBe(0);
    expect(posted.filter((event) => event.kind === SIMPLIFY_PROPOSAL)).toHaveLength(0);
    expect(reports.ok).toHaveLength(1);
    expect(reports.failed).toHaveLength(0);
  });
});

// ── 7. the model call failing ────────────────────────────────────────────────

describe("a failed model call", () => {
  it("still records the facts, proposes nothing, and reports the failure once", async () => {
    const { run, posted, reports } = harness({ modelThrows: true });
    const result = await run();
    expect(result.proposed).toBe(0);
    const runEvent = posted.find((event) => event.kind === SIMPLIFY_RUN);
    expect(runEvent.data.proposed).toBe(0);
    expect(runEvent.data.modelError).toContain("error_max_turns");
    expect(runEvent.data.facts.rows.length).toBeGreaterThan(0);
    // The event carries the numbers whole and the re-derivable parts trimmed,
    // so one run's measurement fits one Convex document.
    expect(typeof runEvent.data.facts.rows[0].proxy.nouns).toBe("number");
    expect(runEvent.data.facts.rows[0].evidence).toBeUndefined();
    expect(runEvent.data.facts.rows[0].loaded).toBe(100);
    expect(reports.failed).toHaveLength(1);
    expect(reports.failed[0].job).toBe("simplify");
    expect(reports.ok).toHaveLength(0);
  });
});

// ── 8. admission ─────────────────────────────────────────────────────────────

function openProposal(n, extra = {}) {
  return {
    // askId is the row's key AND the thread's id; proposalId is the pass's own
    // 8-hex id, which only the provenance sentence names.
    askId: `simplify:p${n}`,
    proposalId: `p${n}`,
    rowId: `r000000${n}`,
    sentence: `after this, thing ${n} is gone`,
    evidence: `Loaded on 40 runs.`,
    counterfactual: "Nothing read would have changed.",
    day: "2026-09-04",
    ...extra,
  };
}

describe("the objection window", () => {
  it("admits the open proposals and never the one Tom objected to", async () => {
    const open = [openProposal(1), openProposal(2), openProposal(3, { objectedAt: NOW - 86_400_000 })];
    const { run, captured, posted } = harness({ open });
    const result = await run();
    expect(result.admitted).toBe(2);
    expect(captured).toHaveLength(2);
    expect(captured.map((c) => c.statement)).toEqual(["after this, thing 1 is gone", "after this, thing 2 is gone"]);
    expect(captured[0].source).toBe("simplify");
    expect(captured[0].provenance).toContain("the weekly simplification pass, 2026-09-04");
    const admits = posted.filter((event) => event.kind === SIMPLIFY_ADMITTED);
    expect(admits).toHaveLength(2);
    // THE KEY IS THE askId THE DOOR RETURNED, verbatim — the join that makes
    // internalOpenProposals stop returning this proposal next week.
    expect(admits[0].key).toBe("simplify:p1");
    expect(admits[0].data.askId).toBe("simplify:p1");
    expect(admits[0].data.proposalId).toBe("p1");
    expect(admits[0].data.todoId).toBe("todo-1");
  });

  it("leaves one waiting when four are open", async () => {
    const open = [openProposal(1), openProposal(2), openProposal(3), openProposal(4)];
    const { run, captured } = harness({ open });
    const result = await run();
    expect(result.admitted).toBe(ADMIT_PER_RUN);
    expect(captured).toHaveLength(ADMIT_PER_RUN);
    expect(result.waiting).toBe(1);
  });
});

// ── 8b. the checkout the measurement reads ───────────────────────────────────

describe("the tom.quest cache clone", () => {
  it("is fetched when no directory was named, and taken as given when one was", async () => {
    const named = harness();
    await named.run();
    expect(named.fetchedRepo).toHaveLength(0);

    const unnamed = harness();
    const result = await unnamed.run({ repoDir: null });
    expect(unnamed.fetchedRepo).toHaveLength(1);
    // The fetch happened and the schema was read out of what came back, which
    // is the whole point: a week-old clone would propose deleting a field
    // added on Tuesday.
    expect(result.facts.repoReadable).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("states the failure and measures the rules anyway when the fetch fails", async () => {
    const { run } = harness({ repoDirThrows: true });
    const result = await run({ repoDir: null });
    expect(result.failures.some((line) => line.includes("cache clone could not be refreshed"))).toBe(true);
    // No credential is in the stated failure beyond the name of the variable
    // the fetch said was missing, which is what the operator has to know.
    expect(result.failures.join("\n")).not.toContain("x-access-token");
    // The operate layer is in the table regardless: it comes from WikiTom.
    expect(result.facts.rows.some((row) => row.class === "rule")).toBe(true);
  });
});

// ── 9. one run per day ───────────────────────────────────────────────────────

describe("one run per day", () => {
  it("writes nothing and returns refused when the day already ran", async () => {
    const { run, posted, captured, paths } = harness({ marker: { day: DAY, proposed: 2, posted: 2, at: NOW } });
    const result = await run();
    expect(result.refused).toContain("already run");
    expect(posted).toHaveLength(0);
    expect(captured).toHaveLength(0);
    expect(paths).toHaveLength(0);
  });

  it("runs the same day again under --overwrite", async () => {
    const { run, posted } = harness({ marker: { day: DAY, proposed: 0, posted: 0, at: NOW } });
    const result = await run({ overwrite: true });
    expect(result.refused).toBeNull();
    expect(posted.find((event) => event.kind === SIMPLIFY_RUN)).toBeTruthy();
  });
});

// ── 10. the facts text ───────────────────────────────────────────────────────

describe("the facts text", () => {
  it("opens with the window, the runs, the sample and the proxy caveat", async () => {
    const { run, out } = harness();
    await run({ printFacts: true });
    const head = out[0].split("\n").slice(0, 12).join("\n");
    expect(head).toContain("Window:");
    expect(head).toContain("4 weeks");
    expect(head).toContain("Runs in the window: 100");
    expect(head).toContain("Sampled for the proxy: 24");
    // The denominator every proxy below is out of, named where the model
    // cannot miss it: a sample that was not read is not a sample of nothing.
    expect(head).toContain("24 of them came back with any words at all");
    expect(head).toContain('deliberately biased toward "it mattered"');
    expect(head).toContain("UPPER BOUND");
  });

  // THE ONE FAILURE THIS PASS MUST NOT HAVE. Runs get registered before their
  // transcript rows are ingested, so a week can hand the measurement a sample
  // of runs whose token bags are all empty. Every rule then matches nothing —
  // which, without this floor, reads as "no rule mattered to any run" and makes
  // the whole operate layer removable in one morning.
  it("proposes no removal at all when too few sampled runs had a readable transcript", async () => {
    const unread = input({
      sample: Array.from({ length: 30 }, (_, i) => ({
        runId: `run-${i}`,
        startedAt: NOW,
        depth: 0,
        tokens: [],
      })),
    });
    const { run } = harness({ simplifyInput: unread });
    const result = await run({ printFacts: true });
    const rules = result.facts.rows.filter((row) => row.class === "rule");
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((row) => row.candidate !== "remove")).toBe(true);
    expect(result.facts.sampleReadable).toBe(0);
    // And the block says why, rather than printing a table of zeroes that
    // reads like a measurement.
    expect(result.facts.rows.every((row) => row.proxy.sample !== 30 || row.class !== "rule")).toBe(true);
  });

  it("drops keep rows from the bottom when the table is over the cap, and says how many", () => {
    const long = "x".repeat(400);
    const many = [];
    for (let i = 0; i < 400; i += 1) {
      many.push({
        id: `k${String(i).padStart(7, "0")}`,
        class: "rule",
        where: "worker/AGENTS.md",
        text: `${long} ${i}`,
        loaded: 40,
        loadedUnknown: 0,
        proxy: { nouns: ["alpha", "bravo"], mattered: 3, sample: 10, note: "" },
        failures: { failed: 0, heads: 0, known: true },
        grep: null,
        candidate: i === 0 ? "remove" : "keep",
        collapseInto: null,
        needsHisWords: false,
        evidence: "",
      });
    }
    const facts = factsBlock({
      day: DAY,
      input: input(),
      table: { rows: many, duplicateRuleLines: 0 },
      repoReadable: true,
      failures: [],
    });
    const text = factsText(facts);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(FACTS_TEXT_MAX_BYTES);
    expect(text).toMatch(/\(\d+ keep row\(s\) were dropped from the bottom/);
    // The one removable row is never among what goes.
    expect(text).toContain("#k0000000");
  });
});

// ── 11. the schema parse ─────────────────────────────────────────────────────

describe("schemaFields", () => {
  it("collects a table's top-level fields and not the fields nested inside one", () => {
    const fields = schemaFields(SCHEMA_FIXTURE);
    expect(fields).toEqual([
      { table: "widgets", name: "unusedField" },
      { table: "widgets", name: "usedField" },
      { table: "widgets", name: "nested" },
    ]);
  });

  it("reads git grep's exit 1 as zero hits, not as a failure", () => {
    const io = { git: () => ({ ok: false, status: 1, stdout: "", error: null }) };
    const { counts, failures } = grepCounts(["unusedField"], io, { dir: "/w" });
    expect(counts.get("unusedField")).toBe(0);
    expect(failures).toEqual([]);
  });

  it("records a git grep that failed for another reason", () => {
    const io = { git: () => ({ ok: false, status: 128, stdout: "", error: "not a git repository" }) };
    const { failures } = grepCounts(["unusedField"], io, { dir: "/w" });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("not a git repository");
  });
});

// ── 12. the rule id ──────────────────────────────────────────────────────────

describe("ruleId", () => {
  it("is stable across a bullet marker, case and whitespace, and differs for another line", () => {
    const base = ruleId("Commit with a full message before every stop.");
    expect(ruleId("- Commit with a full message before every stop.")).toBe(base);
    expect(ruleId("  *   COMMIT   with a full   message before every stop.")).toBe(base);
    expect(ruleId("1. commit with a full message before every stop.")).toBe(base);
    expect(ruleId("Commit with a full message before every push.")).not.toBe(base);
  });

  it("is a hash and not a line number, so a line above it can go", () => {
    const file = ruleLines(RULES_FIXTURE);
    const before = ruleId(file[1].text);
    const after = ruleLines(RULES_FIXTURE.replace("- Commit with a full message before every stop.\n", ""));
    expect(ruleId(after[0].text)).toBe(before);
  });
});

// ── 13. the dry run ──────────────────────────────────────────────────────────

describe("a dry run", () => {
  it("renders the decisions preview and posts nothing", async () => {
    const answer = answerOf(proposal({ id: "r0000001" }));
    const { run, paths, out, posted, captured, markers } = harness({ answer });
    // The rows the dry run measures are the fixture's, so the proposal has to
    // name one of them: the worker rule that no sampled run matched.
    const measured = await run({ printFacts: true });
    const removable = measured.facts.rows.find((row) => row.candidate === "remove" && row.class === "rule");
    const harnessTwo = harness({
      answer: answerOf({
        id: removable.id,
        action: "remove",
        into: null,
        sentence: `after this, ${removable.where} no longer carries that line.`,
        evidence: `Loaded on ${removable.loaded} run(s); ${removable.proxy.mattered} of ${removable.proxy.sample} sampled runs carry its words.`,
        counterfactual: "Nothing in the sampled runs would have gone differently without it.",
        needsHisWords: false,
      }),
    });
    const result = await harnessTwo.run({ dryRun: true });

    expect(result.proposed).toBe(1);
    expect(result.posted).toBe(0);
    expect(harnessTwo.posted).toHaveLength(0);
    expect(harnessTwo.captured).toHaveLength(0);
    expect(harnessTwo.paths.every((route) => route !== "/tts/event" && route !== "/tts/capture")).toBe(true);
    expect(harnessTwo.paths.every((route) => route !== "/tts/simplify-open")).toBe(true);
    expect(harnessTwo.markers.size).toBe(0);
    const printed = harnessTwo.out.join("\n");
    expect(printed).toContain("#tts-decisions — via ttsSync.sendDecision -> ttsCompose.composeDecision");
    expect(printed).toContain(`askId: simplify:${proposalId(DAY, removable.id)}`);
    expect(printed).toContain("decision: after this,");
    expect(printed).toContain("reason: Loaded on");
    // Untouched by the dry run above.
    expect(paths.some((route) => route.startsWith("/tts/simplify-input"))).toBe(true);
    expect(posted).toHaveLength(0);
    expect(captured).toHaveLength(0);
    expect(out.length).toBeGreaterThan(0);
  });

  it("names the refusal fields when the proposal needs his words", () => {
    const lines = decisionPreview({ id: "abc12345", sentence: "s", evidence: "e", counterfactual: "c", needsHisWords: true });
    expect(lines).toContain("refused: true");
    expect(lines.some((line) => line.startsWith("refusedBecause: "))).toBe(true);
  });
});

// ── The prompt, and the small pure helpers it leans on ───────────────────────

describe("the prompt", () => {
  it("puts the fixed text first and the facts last", () => {
    const prompt = simplifyPrompt({ facts: "THE-FACTS-MARKER", writingStandard: "WRITE STANDARD" });
    expect(prompt.indexOf("agents can handle complexity")).toBeLessThan(prompt.indexOf("THE-FACTS-MARKER"));
    expect(prompt.indexOf("WRITE STANDARD")).toBeLessThan(prompt.indexOf("THE-FACTS-MARKER"));
    expect(prompt.trimEnd().endsWith("THE-FACTS-MARKER")).toBe(true);
    expect(prompt).toContain("an empty list is the common answer");
  });
});

describe("jaccard", () => {
  it("scores two empty sets as nothing in common, so neither collapses", () => {
    expect(jaccard([], [])).toBe(0);
    expect(jaccard(["alpha", "bravo", "charlie"], ["alpha", "bravo", "delta"])).toBeCloseTo(0.5);
  });
});

describe("blastRows", () => {
  it("collapses the longer of two near-identical lines into the shorter", () => {
    // Both lines matter to the sampled runs, so neither is removable and the
    // pair rule is what decides them — the removal rules run first by design.
    const matched = [{ tokens: ["commit", "message", "unasked"] }];
    const table = blastRows({
      input: { runs: { total: 100 }, sample: matched, skills: [], cwds: [] },
      fields: [],
      checks: [],
      hisWordsLines: [],
      repoName: "tomquest",
      ruleFiles: [
        {
          where: "worker/AGENTS.md",
          loaded: 100,
          loadedUnknown: 0,
          lines: [
            { line: 1, text: "- commit before every stop, unasked, with a full message" },
            { line: 2, text: "- commit before every stop with a message" },
          ],
        },
      ],
    });
    const map = byId(table.rows);
    const longer = table.rows.find((row) => row.text.includes("unasked"));
    const shorter = table.rows.find((row) => !row.text.includes("unasked"));
    expect(longer.candidate).toBe("collapse");
    expect(longer.collapseInto).toBe(shorter.id);
    expect(map.get(shorter.id).candidate).not.toBe("collapse");
  });
});
