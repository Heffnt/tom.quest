import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { DELEGATE_OBJECTION } from "./ttsAsk";
import { DIGEST_SENT } from "./ttsDigest";
import { EVALS_RUN } from "./ttsEvals";
import { AUDIT_VERDICT, TESTS_RUN, commitKey } from "./ttsMerge";
import {
  OBJECTION_FLOOR_MS,
  SAMPLE_RUNS,
  SIMPLIFY_ADMITTED,
  SIMPLIFY_PROPOSAL,
  WINDOW_WEEKS,
} from "./ttsSimplify";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

/** A fixed instant, so every assertion below is arithmetic rather than a race
 *  with the clock. */
const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function convex() {
  return convexTest({ schema, modules });
}

type RunOver = {
  runId?: string;
  startedAt?: number;
  depth?: number;
  origin?: string;
  host?: "laptop" | "box";
  runner?: "claude" | "codex";
  kind?: "session" | "worker" | "code" | "prospect" | "job" | "delegate" | "subagent" | "codex-child" | "unknown";
  context?: Record<string, unknown> | null;
};

let seeded = 0;

/** ONE seed helper, shared by every test below: a `runs` row with every field
 *  the table demands and nothing interesting in the fields this pass does not
 *  read, so a test that overrides one field says exactly what it is about. */
async function seedRun(t: TestConvex<typeof schema>, over: RunOver = {}) {
  const runId = over.runId ?? `run-${(seeded += 1)}`;
  await t.run(async (ctx) => {
    await ctx.db.insert("runs", {
      runId,
      rootRunId: runId,
      depth: over.depth ?? 0,
      linkKnown: true,
      origin: over.origin ?? "cli",
      host: over.host ?? "box",
      runner: over.runner ?? "claude",
      parserVersion: "1",
      kind: over.kind ?? "session",
      status: "ended",
      startedAt: over.startedAt ?? NOW - DAY,
      lastLineAt: over.startedAt ?? NOW - DAY,
      ...(over.context === null
        ? {}
        : {
            context: {
              layersKnown: true,
              layersGiven: ["operate", "write"],
              layersDenied: ["know"],
              skillsOffered: ["graphify"],
              skillsUsed: [],
              tools: ["Bash", "Read"],
              hooks: ["PostToolUse"],
              cwd: "C:/repo/tom.quest",
              ...over.context,
            } as never,
          }),
      attachments: [],
      file: {
        path: `/store/${runId}.jsonl`,
        sourceHash: "s",
        storedHash: "h",
        bytes: 1,
        storedBytes: 1,
        committedLine: 1,
        committedPrefixSha256: "p",
      },
      ingestedAt: NOW,
    });
  });
  return runId;
}

async function seedMessage(
  t: TestConvex<typeof schema>,
  runId: string,
  seq: number,
  kind: "user" | "assistant-text" | "tool-call" | "tool-result",
  content: unknown,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("claudeMessages", { runId, seq, turn: 1, kind, content, createdAt: NOW });
  });
}

async function seedEvent(
  t: TestConvex<typeof schema>,
  kind: string,
  at: number,
  data?: Record<string, unknown>,
  key?: string,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("dtsEvents", { at, kind, ...(key === undefined ? {} : { key }), data });
  });
}

const gather = (t: TestConvex<typeof schema>, until = NOW) =>
  t.query(internal.ttsSimplify.internalSimplifyInput, { until });

const openProposals = (t: TestConvex<typeof schema>, now = NOW) =>
  t.query(internal.ttsSimplify.internalOpenProposals, { now });

// ── 1. The counts ────────────────────────────────────────────────────────────

describe("internalSimplifyInput — the counts off the runs in the window", () => {
  it("counts runs, layers, skills, tools, hooks and cwds", async () => {
    const t = convex();
    // Three ordinary runs, one Codex run on the laptop in another directory,
    // and one run with no envelope at all.
    await seedRun(t);
    await seedRun(t);
    await seedRun(t, { context: { skillsUsed: ["graphify"], hooks: [] } });
    await seedRun(t, {
      host: "laptop",
      runner: "codex",
      kind: "code",
      origin: "codex-cli",
      context: { cwd: "C:/repo/CMT", tools: ["Bash"], layersDenied: [] },
    });
    await seedRun(t, { context: null });
    // Outside the window on both sides: neither is counted.
    await seedRun(t, { startedAt: NOW - (WINDOW_WEEKS * 7 + 1) * DAY });
    await seedRun(t, { startedAt: NOW + DAY });

    const facts = await gather(t);
    expect(facts.runs.total).toBe(5);
    expect(facts.runs.capped).toBe(false);
    expect(facts.runs.withContext).toBe(4);
    expect(facts.runs.layersKnownTrue).toBe(4);
    expect(facts.runs.byHost).toEqual({ box: 4, laptop: 1 });
    expect(facts.runs.byRunner).toEqual({ claude: 4, codex: 1 });
    expect(facts.runs.byKind).toEqual({ session: 4, code: 1 });
    expect(facts.runs.byOrigin).toEqual({ cli: 4, "codex-cli": 1 });

    expect(facts.layers).toEqual([
      { name: "operate", given: 4, denied: 0 },
      { name: "write", given: 4, denied: 0 },
      { name: "know", given: 0, denied: 3 },
    ]);
    expect(facts.skills).toEqual([{ name: "graphify", offered: 4, used: 1 }]);
    expect(facts.tools).toEqual([
      { name: "Bash", runs: 4 },
      { name: "Read", runs: 3 },
    ]);
    expect(facts.hooks).toEqual([{ name: "PostToolUse", runs: 3 }]);
    // The null row is always the last one, and counts the envelope-less run.
    expect(facts.cwds).toEqual([
      { cwd: "C:/repo/tom.quest", runs: 3 },
      { cwd: "C:/repo/CMT", runs: 1 },
      { cwd: null, runs: 1 },
    ]);
  });

  it("caps the sample at SAMPLE_RUNS while the counts stay whole", async () => {
    const t = convex();
    const extra = 5;
    for (let i = 0; i < SAMPLE_RUNS + extra; i += 1) {
      await seedRun(t, { startedAt: NOW - DAY - i * 1_000 });
    }
    const facts = await gather(t);
    expect(facts.runs.total).toBe(SAMPLE_RUNS + extra);
    expect(facts.sample).toHaveLength(SAMPLE_RUNS);
    // Newest-first, so the same week measured twice samples the same runs.
    expect(facts.sample[0].startedAt).toBeGreaterThan(facts.sample[1].startedAt);
  });
});

// ── 2. The token bag ─────────────────────────────────────────────────────────

describe("the token bag", () => {
  it("takes the run's own words and NOT a file it happened to read", async () => {
    const t = convex();
    const runId = await seedRun(t);
    await seedMessage(t, runId, 1, "tool-result", {
      text: "quixotry appears only in a file this run read",
    });
    await seedMessage(t, runId, 2, "assistant-text", { text: "the layersgiven rule did nothing" });
    await seedMessage(t, runId, 3, "tool-call", {
      name: "Grep",
      input: { pattern: "borborygmus" },
    });

    const { sample } = await gather(t);
    expect(sample).toHaveLength(1);
    expect(sample[0].tokens).toContain("layersgiven");
    // The tool CALL is the run asking for something, so its words count.
    expect(sample[0].tokens).toContain("borborygmus");
    // The tool RESULT is a file, so its words do not.
    expect(sample[0].tokens).not.toContain("quixotry");
    // And nothing shorter than five characters is a token.
    expect(sample[0].tokens).not.toContain("rule");
  });
});

// ── 3. The gate's failure history ────────────────────────────────────────────

describe("the gate history", () => {
  it("counts distinct heads and distinct failures with ttsMerge's own predicate", async () => {
    const t = convex();
    const green = commitKey("tom.quest", "a".repeat(40));
    const red = commitKey("tom.quest", "b".repeat(40));
    const refused = commitKey("tom.quest", "c".repeat(40));

    await seedEvent(t, TESTS_RUN, NOW - 400 * DAY, { ok: true }, green);
    await seedEvent(t, TESTS_RUN, NOW - 399 * DAY, { ok: false, detail: "one suite" }, red);
    await seedEvent(t, AUDIT_VERDICT, NOW - 398 * DAY, { verdict: "APPROVED" }, green);
    await seedEvent(t, AUDIT_VERDICT, NOW - 397 * DAY, { verdict: "REFUSED" }, refused);
    await seedEvent(t, EVALS_RUN, NOW - 396 * DAY, { regressions: 0 }, green);

    const { gate } = await gather(t);
    // All time, not the window: every row above is more than a year old.
    expect(gate.tests).toMatchObject({ heads: 2, failed: 1 });
    expect(gate.tests.failures[0]).toMatchObject({ key: red });
    expect(gate.tests.failures[0].why).toContain("one suite");

    expect(gate.audit).toMatchObject({ heads: 2, failed: 1 });
    expect(gate.audit.failures[0].key).toBe(refused);
    expect(gate.audit.failures[0].why).toContain("REFUSED");

    // One head, one row, no failure — and the two shas that never reached an
    // evals run are not heads here.
    expect(gate.evals).toMatchObject({ heads: 1, failed: 0, failures: [] });
  });

  it("judges a re-recorded head on its newest row", async () => {
    const t = convex();
    const key = commitKey("tom.quest", "d".repeat(40));
    await seedEvent(t, TESTS_RUN, NOW - 10 * DAY, { ok: false }, key);
    await seedEvent(t, TESTS_RUN, NOW - 9 * DAY, { ok: true }, key);
    const { gate } = await gather(t);
    expect(gate.tests).toMatchObject({ heads: 1, failed: 0 });
  });

  it("reads the evals' ablation deltas when they are there, and 0 when they are not", async () => {
    const t = convex();
    const bare = commitKey("tom.quest", "e".repeat(40));
    const withDeltas = commitKey("tom.quest", "f".repeat(40));
    await seedEvent(t, EVALS_RUN, NOW - DAY, { regressions: 0, repo: "tom.quest" }, bare);
    const absent = await gather(t);
    expect(absent.evals).toMatchObject({ runs: 1, withAblation: 0, ablation: [] });

    await seedEvent(
      t,
      EVALS_RUN,
      NOW - 2 * DAY,
      {
        regressions: 0,
        repo: "tom.quest",
        sha: "f".repeat(40),
        ablation: [{ subject: "know", delta: -0.02 }, { subject: "write", delta: 0 }],
      },
      withDeltas,
    );
    const present = await gather(t);
    expect(present.evals.runs).toBe(2);
    expect(present.evals.withAblation).toBe(1);
    expect(present.evals.ablation).toEqual([
      { subject: "know", delta: -0.02, at: NOW - 2 * DAY, repo: "tom.quest", sha: "f".repeat(40) },
      { subject: "write", delta: 0, at: NOW - 2 * DAY, repo: "tom.quest", sha: "f".repeat(40) },
    ]);
  });
});

// ── 4. The objection window ──────────────────────────────────────────────────

/** One proposal, posted `agoMs` before NOW. */
async function seedProposal(
  t: TestConvex<typeof schema>,
  askId: string,
  agoMs: number,
  data: Record<string, unknown> = {},
) {
  await seedEvent(
    t,
    SIMPLIFY_PROPOSAL,
    NOW - agoMs,
    { rowId: `row-${askId}`, sentence: "the know layer's third file is never read", ...data },
    askId,
  );
}

describe("internalOpenProposals — the 24-hour floor and the digest", () => {
  it("is NOT open with no digest after it", async () => {
    const t = convex();
    await seedProposal(t, "simplify:1", 3 * DAY);
    expect(await openProposals(t)).toEqual([]);
  });

  it("is NOT open when the only digest went out 20 hours after it", async () => {
    const t = convex();
    await seedProposal(t, "simplify:1", 3 * DAY);
    await seedEvent(t, DIGEST_SENT, NOW - 3 * DAY + 20 * HOUR, { day: "2027-01-15" });
    expect(await openProposals(t)).toEqual([]);
  });

  it("IS open when a digest went out 30 hours after it", async () => {
    const t = convex();
    await seedProposal(t, "simplify:1", 3 * DAY);
    await seedEvent(t, DIGEST_SENT, NOW - 3 * DAY + 30 * HOUR, { day: "2027-01-16" });
    const open = await openProposals(t);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      askId: "simplify:1",
      rowId: "row-simplify:1",
      sentence: "the know layer's third file is never read",
      at: NOW - 3 * DAY,
    });
    // The floor is exactly a day.
    expect(NOW - 3 * DAY + 30 * HOUR).toBeGreaterThan(NOW - 3 * DAY + OBJECTION_FLOOR_MS);
  });

  it("is NEVER open once Tom objected, however long the digest has been printing it", async () => {
    const t = convex();
    await seedProposal(t, "simplify:1", 5 * DAY);
    await seedEvent(t, DIGEST_SENT, NOW - 3 * DAY, { day: "2027-01-16" });
    await seedEvent(t, DELEGATE_OBJECTION, NOW - 2 * DAY, { text: "no" }, "simplify:1");
    expect(await openProposals(t)).toEqual([]);
  });

  it("is NOT open once it has been admitted — admitting it twice is two todos", async () => {
    const t = convex();
    await seedProposal(t, "simplify:1", 5 * DAY);
    await seedEvent(t, DIGEST_SENT, NOW - 3 * DAY, { day: "2027-01-16" });
    await seedEvent(t, SIMPLIFY_ADMITTED, NOW - 2 * DAY, { rowId: "row-simplify:1" }, "simplify:1");
    expect(await openProposals(t)).toEqual([]);
  });

  it("is never open on a DRY RUN, whatever the digest did", async () => {
    const t = convex();
    await seedProposal(t, "simplify:1", 5 * DAY, { dryRun: true });
    await seedEvent(t, DIGEST_SENT, NOW - 3 * DAY, { day: "2027-01-16" });
    expect(await openProposals(t)).toEqual([]);
  });

  it("is never open when it NEEDS HIS WORDS — it parks until he rules", async () => {
    const t = convex();
    await seedProposal(t, "simplify:1", 5 * DAY, { needsHisWords: true });
    await seedEvent(t, DIGEST_SENT, NOW - 3 * DAY, { day: "2027-01-16" });
    expect(await openProposals(t)).toEqual([]);
  });

  it("returns the one that has waited longest first", async () => {
    const t = convex();
    await seedProposal(t, "simplify:new", 3 * DAY);
    await seedProposal(t, "simplify:old", 6 * DAY);
    await seedEvent(t, DIGEST_SENT, NOW - HOUR, { day: "2027-01-18" });
    expect((await openProposals(t)).map((p) => p.askId)).toEqual(["simplify:old", "simplify:new"]);
  });
});

describe("what the pass already proposed", () => {
  it("joins each prior proposal to its objection and its admission", async () => {
    const t = convex();
    await seedProposal(t, "simplify:a", 10 * DAY);
    await seedProposal(t, "simplify:b", 9 * DAY, { dryRun: true });
    await seedProposal(t, "simplify:c", 8 * DAY, { needsHisWords: true });
    await seedEvent(t, DELEGATE_OBJECTION, NOW - 9 * DAY, { text: "no" }, "simplify:a");
    await seedEvent(t, SIMPLIFY_ADMITTED, NOW - 7 * DAY, {}, "simplify:c");

    const { priorProposals } = await gather(t);
    const by = Object.fromEntries(priorProposals.map((p) => [p.askId, p]));
    expect(priorProposals).toHaveLength(3);
    expect(by["simplify:a"]).toMatchObject({
      rowId: "row-simplify:a",
      dryRun: false,
      needsHisWords: false,
      objectedAt: NOW - 9 * DAY,
      admittedAt: null,
    });
    expect(by["simplify:b"]).toMatchObject({ dryRun: true, objectedAt: null, admittedAt: null });
    expect(by["simplify:c"]).toMatchObject({ needsHisWords: true, admittedAt: NOW - 7 * DAY });
  });
});

// ── 5. The window ────────────────────────────────────────────────────────────

describe("the window", () => {
  it("starts exactly 28 days before `until`", async () => {
    const t = convex();
    const { window } = await gather(t);
    expect(window.until).toBe(NOW);
    expect(window.weeks).toBe(WINDOW_WEEKS);
    expect(window.since).toBe(NOW - 28 * DAY);
    expect(window.until - window.since).toBe(WINDOW_WEEKS * 7 * 86_400_000);
  });
});
