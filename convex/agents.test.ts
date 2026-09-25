import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { MODEL_OF_TOM_HEADER } from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

/** What worker/agents/ingest.mjs stamps on every row; every claudeMessages row has one. */
const ROW_PROVENANCE = { fileVersion: "f".repeat(64), file: "/agent.jsonl", lineStart: 1, lineEnd: 1, block: 0, parserVersion: "runs-parser-2", sourceKind: "fixture" };
const SOURCE_HASH = "a".repeat(64);
const STORED_HASH = "b".repeat(64);
const PREFIX_HASH = "c".repeat(64);
const PREVIOUS_HASH = "d".repeat(64);
const GROWN_PREFIX_HASH = "e".repeat(64);
const VERSION_A_HASH = "1".repeat(64);
const VERSION_B_HASH = "2".repeat(64);
const HELLO_WORLD_SHA256 = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

// Session creation fails closed when the model-of-tom publication singleton is
// absent, so reader tests seed it just as claudeSessions tests do.
const TEST_PRELUDE_LAYERS = { operate: "test operate layer", write: "test write layer", know: "test know layer" };
const TEST_PRELUDE_HEADERS = ([
  ["operate"], ["write"], ["know"], ["operate", "write"],
  ["operate", "know"], ["write", "know"], ["operate", "write", "know"],
] as const).map((names) => ({ layers: [...names], header: `${MODEL_OF_TOM_HEADER} (WikiTom commit testprelude): ${names.join(",")}` }));

async function withTom(t: ReturnType<typeof convexTest>) {
  const id = await t.run((ctx) => ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }));
  await t.run(async (ctx) => {
    if (await ctx.db.query("modelOfTomPublication").first()) return;
    await ctx.db.insert("modelOfTomPublication", { key: "current", commit: "testprelude", committedAt: 1, pushed: true, ...TEST_PRELUDE_LAYERS, headers: TEST_PRELUDE_HEADERS });
  });
  return t.withIdentity({ subject: id });
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    runId: "claude:laptop:root-run", rootRunId: "claude:laptop:root-run", depth: 0, linkKnown: true,
    origin: "unknown", host: "laptop", cli: "claude", parserVersion: "runs-parser-1", kind: "session", status: "unknown", startedAt: 1, lastLineAt: 2,
    attachments: [],
    file: { path: "C:/root.jsonl", sourceHash: SOURCE_HASH, storedHash: STORED_HASH, bytes: 10, storedBytes: 8, committedLine: 1, committedPrefixSha256: PREFIX_HASH },
    ...overrides,
  };
}
function row(seq = 0, overrides: Record<string, unknown> = {}) {
  return {
    seq, turn: 0, kind: "context", content: { layersKnown: false },
    provenance: { fileVersion: STORED_HASH, file: "C:/root.jsonl", lineStart: seq, lineEnd: seq, block: 0, parserVersion: "runs-parser-1", sourceKind: "system" },
    digest: "0123456789abcdef", depth: 0, createdAt: seq + 1, ...overrides,
  };
}
function ingest(value = run(), rows = [row()], children: unknown[] = [], previousCommittedLine = 0, previousPrefixSha256 = PREVIOUS_HASH) {
  return { run: value, rows, children, previousCommittedLine, previousPrefixSha256 };
}
function retry(value = run(), rows = [row()], children: unknown[] = []) {
  return ingest(value, rows, children, 1, PREFIX_HASH);
}
function child(runId: string, parentRunId: string, rootRunId: string, depth: number, linkKnown = true) {
  return { runId, parentRunId, rootRunId, depth, linkKnown, ...(linkKnown ? { spawnedByToolUseId: "exact-tool-use" } : {}) };
}

async function session(t: ReturnType<typeof convexTest>, overrides: Record<string, unknown> = {}) {
  return await t.run((ctx) => ctx.db.insert("claudeSessions", {
    title: "run comparison", kind: "adhoc", repo: "none", status: "ended",
    statusChangedAt: Date.now(), nextSeq: 0, createdAt: Date.now(), ...overrides,
  } as never));
}


describe("agents", () => {
  it("ingests immutable rows and returns them in source order", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(internal.agents.internalIngest, ingest(run(), [row(0), row(1, { digest: "fedcba9876543210", kind: "assistant-text" })]) as never);
    expect(result).toMatchObject({ ok: true, inserted: 2, skipped: 0, committedLine: 1 });
    const tom = await withTom(t);
    expect((await tom.query(api.agents.get, { agentId: "claude:laptop:root-run" }))?.runId).toBe("claude:laptop:root-run");
    const rows = await tom.query(api.agents.rows, { agentId: "claude:laptop:root-run", paginationOpts: { cursor: null, numItems: 10 } });
    expect(rows.page.map((entry) => entry.seq)).toEqual([0, 1]);
    expect(await tom.query(api.agents.entry, { agentId: "claude:laptop:root-run", seq: 1 })).toMatchObject({ provenance: { fileVersion: STORED_HASH }, digest: "fedcba9876543210" });
  });

  it("uses the prior cursor/hash tuple as an append compare-and-swap fence", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.internalIngest, ingest() as never);
    const grown = run({ file: { ...run().file, bytes: 20, committedLine: 2, committedPrefixSha256: GROWN_PREFIX_HASH } });
    expect(await t.mutation(internal.agents.internalIngest, ingest(grown, [row(1000, { digest: "1111111111111111" })], [], 1, PREFIX_HASH) as never)).toMatchObject({ ok: true, inserted: 1, committedLine: 2 });

    // A rewrite plus append cannot bypass the fence just because its new cursor
    // is greater than the stored cursor.
    const rewrittenAppend = run({ file: { ...run().file, bytes: 30, committedLine: 3, committedPrefixSha256: "f".repeat(64) } });
    // The refusal names the cursor the record holds. Without it a sweeper that
    // lost its own cursor has no way back: it re-presents line 0 of a file the
    // record already committed, is refused for ever, and strands the run.
    expect(await t.mutation(internal.agents.internalIngest, ingest(rewrittenAppend, [row(2000, { digest: "2222222222222222" })], [], 2, "0".repeat(64)) as never)).toEqual({ ok: false, reason: "file rewritten", committedLine: 2, committedPrefixSha256: GROWN_PREFIX_HASH });
    const landed = await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:laptop:root-run")).unique());
    expect(landed?.file.committedLine).toBe(2);
    expect((await t.run((ctx) => ctx.db.query("claudeMessages").withIndex("by_run_seq", (q) => q.eq("runId", "claude:laptop:root-run")).collect())).map((entry) => entry.seq)).toEqual([0, 1000]);
  });

  // witness: the sweep walks a session's subagent files in name order, so a
  // grandchild is routinely ingested before its own parent has been seen. The
  // run's depth was forced to 1 in that case and every row was then refused as
  // "invalid run row", which dead-lettered each depth-2-and-deeper run on a
  // permanent 400 — one real session lost fifty runs that way.
  it("lands a grandchild swept before its parent, and repairs the tree when the parent arrives", async () => {
    const t = convexTest(schema, modules);
    const grandchild = run({
      runId: "claude:laptop:root-run/grandchild-agent", rootRunId: "claude:laptop:root-run",
      parentRunId: "claude:laptop:root-run/middle-agent", depth: 2, kind: "subagent",
      spawnedByToolUseId: "exact-tool-use",
      file: { ...run().file, path: "C:/grandchild.jsonl" },
    });
    expect(await t.mutation(internal.agents.internalIngest, ingest(grandchild, [row(0, { depth: 2 })]) as never))
      .toMatchObject({ ok: true, inserted: 1 });

    // The second grandchild reads the placeholder its sibling created; before
    // that placeholder carried a true position it derived depth 1 from it and
    // was refused in turn.
    const sibling = run({
      runId: "claude:laptop:root-run/sibling-agent", rootRunId: "claude:laptop:root-run",
      parentRunId: "claude:laptop:root-run/middle-agent", depth: 2, kind: "subagent",
      spawnedByToolUseId: "exact-tool-use",
      file: { ...run().file, path: "C:/sibling.jsonl" },
    });
    expect(await t.mutation(internal.agents.internalIngest, ingest(sibling, [row(0, { depth: 2 })]) as never))
      .toMatchObject({ ok: true, inserted: 1 });

    const middle = run({
      runId: "claude:laptop:root-run/middle-agent", rootRunId: "claude:laptop:root-run",
      parentRunId: "claude:laptop:root-run", depth: 1, kind: "subagent",
      spawnedByToolUseId: "exact-tool-use",
      file: { ...run().file, path: "C:/middle.jsonl" },
    });
    expect(await t.mutation(internal.agents.internalIngest, ingest(middle, [row(0, { depth: 1 })]) as never))
      .toMatchObject({ ok: true, inserted: 1 });

    for (const [runId, path] of [["claude:laptop:root-run/grandchild-agent", "C:/grandchild.jsonl"], ["claude:laptop:root-run/sibling-agent", "C:/sibling.jsonl"]] as const) {
      const landed = await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", runId)).unique());
      expect(landed, runId).toMatchObject({ depth: 2, rootRunId: "claude:laptop:root-run", parentRunId: "claude:laptop:root-run/middle-agent" });
      expect(landed?.file.path).toBe(path);
    }
  });

  // witness: six spawn_agent children of a Codex run that a Claude box run
  // launched were refused as "invalid run row" on 2026-09-19: the record put
  // them at depth 2 under their depth-1 parent, and their pages said 1.
  it("stores a child's rows at the depth the record gives the run, not the page's", async () => {
    const t = convexTest(schema, modules);
    const parent = run({
      runId: "codex:box:parent-thread", rootRunId: "claude:box:launcher-run", parentRunId: "claude:box:launcher-run",
      depth: 1, linkKnown: false, host: "box", cli: "codex", kind: "unknown",
      file: { ...run().file, path: "/parent.jsonl" },
    });
    expect(await t.mutation(internal.agents.internalIngest, ingest(parent, [row(0, { depth: 1 })]) as never)).toMatchObject({ ok: true });
    const child = run({
      runId: "codex:box:child-thread", rootRunId: "codex:box:parent-thread", parentRunId: "codex:box:parent-thread",
      depth: 1, linkKnown: false, host: "box", cli: "codex", kind: "codex-child",
      file: { ...run().file, path: "/child.jsonl" },
    });
    expect(await t.mutation(internal.agents.internalIngest, ingest(child, [row(0, { depth: 1 }), row(1000, { depth: 1 })]) as never)).toMatchObject({ ok: true, inserted: 2 });
    const landed = await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "codex:box:child-thread")).unique());
    expect(landed).toMatchObject({ depth: 2, rootRunId: "claude:box:launcher-run" });
    const rows = await t.run((ctx) => ctx.db.query("claudeMessages").withIndex("by_run_seq", (q) => q.eq("runId", "codex:box:child-thread")).collect());
    expect(rows.map((entry) => entry.depth)).toEqual([2, 2]);
  });

  it("refuses malformed identifiers, numeric facts, and child edges before writes", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.agents.internalIngest, ingest(run({ runId: "not-a-run" })) as never)).toEqual({ ok: false, reason: "invalid run record" });
    expect(await t.mutation(internal.agents.internalIngest, ingest(run({ startedAt: -1 })) as never)).toEqual({ ok: false, reason: "invalid run record" });
    expect(await t.mutation(internal.agents.internalIngest, ingest(run(), [], [child("claude:laptop:child-run", "claude:laptop:not-root", "claude:laptop:root-run", 1)]) as never)).toEqual({ ok: false, reason: "invalid child edge" });
    expect(await t.run((ctx) => ctx.db.query("runs").collect())).toEqual([]);
  });

  it("takes a Workflow's agent as an ordinary child with no spawning tool-use id", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.internalIngest, ingest(run()) as never);
    // The Workflow sidecar carries no toolUseId, so the link is honestly
    // unknown; the workflow it belongs to is on the run's context instead.
    const agent = run({
      runId: "claude:laptop:root-run/a27aa4b9a7caecc56", parentRunId: "claude:laptop:root-run", depth: 1, linkKnown: false,
      kind: "subagent", origin: "workflow",
      context: { layersKnown: false, layersGiven: [], layersDenied: [], skillsOffered: [], skillsUsed: [], tools: [], hooks: [], workflowId: "wf_abc" },
    });
    expect(await t.mutation(internal.agents.internalIngest, ingest(agent, [row(0, { depth: 1 })]) as never)).toMatchObject({ ok: true });
    const stored = await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:laptop:root-run/a27aa4b9a7caecc56")).unique());
    expect(stored).toMatchObject({ depth: 1, parentRunId: "claude:laptop:root-run", origin: "workflow", linkKnown: false });
    expect(stored?.spawnedByToolUseId).toBeUndefined();
    expect(stored?.context?.workflowId).toBe("wf_abc");
  });

  it("round-trips the graph version and the given node ids, and refuses a node id that is not a string", async () => {
    const t = convexTest(schema, modules);
    const graphNodes = ["page:model-of-tom/agent-rules.md", "heading:model-of-tom/agent-rules.md#Map", "line:1a2b3c4d", "skill:write"];
    const context = {
      layersKnown: false, layersGiven: [], layersDenied: [], skillsOffered: [], skillsUsed: [], tools: [], hooks: [],
      graphVersion: "0123456789abcdef", graphNodes,
    };
    expect(await t.mutation(internal.agents.internalIngest, ingest(run({ context })) as never)).toMatchObject({ ok: true });
    const stored = await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:laptop:root-run")).unique());
    expect(stored?.context?.graphVersion).toBe("0123456789abcdef");
    expect(stored?.context?.graphNodes).toEqual(graphNodes);

    // The list is v.array(v.string()) on both sides — a node id is a string or
    // it is not a node id, and the door refuses it rather than storing a shape
    // no reader of the `given` edges can follow.
    const bad = convexTest(schema, modules);
    await expect(bad.mutation(internal.agents.internalIngest, ingest(run({
      context: { ...context, graphNodes: ["line:1a2b3c4d", 7] },
    })) as never)).rejects.toThrow();
  });

  it("takes a run that names neither the graph version nor its nodes", async () => {
    // Absent is a supported value: an unregistered run, and one whose launcher
    // could not build a graph, carry nothing and nothing is inferred.
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.agents.internalIngest, ingest(run({
      context: { layersKnown: false, layersGiven: [], layersDenied: [], skillsOffered: [], skillsUsed: [], tools: [], hooks: [] },
    })) as never)).toMatchObject({ ok: true });
    const stored = await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:laptop:root-run")).unique());
    expect(stored?.context?.graphVersion).toBeUndefined();
    expect(stored?.context?.graphNodes).toBeUndefined();
  });

  // witness: worker/agents/launcher.mjs names the laptop session that launched a
  // box run as that run's parent, so a parent edge now crosses hosts. The
  // placeholder used to take its host and runner from the child that revealed
  // it, which recorded a laptop session as a box run — a false fact the
  // sessions view would have shown Tom.
  it("lands box children under the laptop session that launched them, under one laptop stub", async () => {
    const t = convexTest(schema, modules);
    const boxChild = (name: string) => run({
      runId: `claude:box:${name}`, host: "box", kind: "session", linkKnown: false,
      parentRunId: "claude:laptop:orchestrator", rootRunId: "claude:laptop:orchestrator", depth: 1,
      file: { ...run().file, path: `C:/${name}.jsonl` },
    });
    expect(await t.mutation(internal.agents.internalIngest, ingest(boxChild("box-child-one"), [row(0, { depth: 1 })]) as never))
      .toMatchObject({ ok: true, inserted: 1 });
    expect(await t.mutation(internal.agents.internalIngest, ingest(boxChild("box-child-two"), [row(0, { depth: 1 })]) as never))
      .toMatchObject({ ok: true, inserted: 1 });

    const parent = await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:laptop:orchestrator")).unique());
    expect(parent).toMatchObject({ host: "laptop", cli: "claude", kind: "unknown", depth: 0, rootRunId: "claude:laptop:orchestrator" });

    const children = await t.run((ctx) => ctx.db.query("runs").withIndex("by_parent", (q) => q.eq("parentRunId", "claude:laptop:orchestrator")).collect());
    expect(children.map((entry) => entry.runId).sort()).toEqual(["claude:box:box-child-one", "claude:box:box-child-two"]);
    expect(children.every((entry) => entry.host === "box" && entry.depth === 1)).toBe(true);
  });

  describe("environment", () => {
    const at = (t: SchemaTest, runId: string) =>
      t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", runId)).unique());
    const defaulted = (t: SchemaTest) =>
      t.run(async (ctx) => (await ctx.db.query("dtsEvents").collect()).filter((entry) => entry.kind === "agents-environment-defaulted"));
    const childRun = (name: string, overrides: Record<string, unknown> = {}) => run({
      runId: `claude:laptop:${name}`, parentRunId: "claude:laptop:root-run", rootRunId: "claude:laptop:root-run", depth: 1, linkKnown: false, kind: "subagent",
      file: { ...run().file, path: `C:/${name}.jsonl` }, ...overrides,
    });

    it("takes the envelope's word first and counts no guess", async () => {
      const t = convexTest(schema, modules);
      expect(await t.mutation(internal.agents.internalIngest, ingest(run({ environment: "session" })) as never)).toMatchObject({ ok: true });
      expect((await at(t, "claude:laptop:root-run"))?.environment).toBe("session");
      expect(await defaulted(t)).toEqual([]);
    });

    it("gives a silent child its parent's environment", async () => {
      const t = convexTest(schema, modules);
      await t.mutation(internal.agents.internalIngest, ingest(run({ environment: "session" })) as never);
      expect(await t.mutation(internal.agents.internalIngest, ingest(childRun("silent-child"), [row(0, { depth: 1 })]) as never)).toMatchObject({ ok: true });
      expect((await at(t, "claude:laptop:silent-child"))?.environment).toBe("session");
      expect(await defaulted(t)).toEqual([]);
    });

    it("keeps a row's own environment when neither envelope nor parent names one", async () => {
      const t = convexTest(schema, modules);
      await t.mutation(internal.agents.internalIngest, ingest(run({ environment: "runner" })) as never);
      expect(await t.mutation(internal.agents.internalIngest, retry(run({ file: { ...run().file, committedLine: 2, committedPrefixSha256: GROWN_PREFIX_HASH } }), [row(1)]) as never)).toMatchObject({ ok: true });
      expect((await at(t, "claude:laptop:root-run"))?.environment).toBe("runner");
    });

    it("calls a run nothing named a worker, once, and says so", async () => {
      const t = convexTest(schema, modules);
      await t.mutation(internal.agents.internalIngest, ingest(run({ context: { layersKnown: false, layersGiven: [], layersDenied: [], skillsOffered: [], skillsUsed: [], tools: [], hooks: [], launcher: "worker/jobs/example.mjs" } })) as never);
      expect((await at(t, "claude:laptop:root-run"))?.environment).toBe("worker");
      expect((await defaulted(t)).map((entry) => entry.data)).toEqual([{ runId: "claude:laptop:root-run", launcher: "worker/jobs/example.mjs" }]);
      // A later page is a repair, never a second count.
      await t.mutation(internal.agents.internalIngest, retry(run({ file: { ...run().file, committedLine: 2, committedPrefixSha256: GROWN_PREFIX_HASH } }), [row(1)]) as never);
      expect(await defaulted(t)).toHaveLength(1);
    });

    it("repairs a row ingested before its envelope, when a later page names one", async () => {
      const t = convexTest(schema, modules);
      await t.mutation(internal.agents.internalIngest, ingest(run()) as never);
      expect((await at(t, "claude:laptop:root-run"))?.environment).toBe("worker");
      await t.mutation(internal.agents.internalIngest, retry(run({ environment: "session", file: { ...run().file, committedLine: 2, committedPrefixSha256: GROWN_PREFIX_HASH } }), [row(1)]) as never);
      expect((await at(t, "claude:laptop:root-run"))?.environment).toBe("session");
    });

    it("gives a placeholder the environment of the run that revealed it, and its own run repairs it", async () => {
      const t = convexTest(schema, modules);
      await t.mutation(internal.agents.internalIngest, ingest(run({ environment: "session" }), [row()], [child("claude:laptop:stubbed-child", "claude:laptop:root-run", "claude:laptop:root-run", 1)]) as never);
      expect(await at(t, "claude:laptop:stubbed-child")).toMatchObject({ kind: "subagent", environment: "session" });
      expect(await t.mutation(internal.agents.internalIngest, ingest(childRun("orphaned-child", { parentRunId: "claude:laptop:unseen-parent", rootRunId: "claude:laptop:unseen-parent", environment: "runner" }), [row(0, { depth: 1 })]) as never)).toMatchObject({ ok: true });
      expect(await at(t, "claude:laptop:unseen-parent")).toMatchObject({ kind: "unknown", environment: "runner" });
      await t.mutation(internal.agents.internalIngest, ingest(childRun("stubbed-child", { environment: "worker", linkKnown: true, spawnedByToolUseId: "exact-tool-use" }), [row(0, { depth: 1 })]) as never);
      expect((await at(t, "claude:laptop:stubbed-child"))?.environment).toBe("worker");
    });
  });

  it("refuses a run under the old runner spelling, a run naming no cli, and a cli its id contradicts", async () => {
    const t = convexTest(schema, modules);
    const legacy: Record<string, unknown> = run({ runner: "claude" });
    delete legacy.cli;
    await expect(t.mutation(internal.agents.internalIngest, ingest(legacy as never) as never)).rejects.toThrow();
    const nameless: Record<string, unknown> = run({ runId: "claude:laptop:nameless-run", rootRunId: "claude:laptop:nameless-run" });
    delete nameless.cli;
    await expect(t.mutation(internal.agents.internalIngest, ingest(nameless as never) as never)).rejects.toThrow();
    expect(await t.mutation(internal.agents.internalIngest, ingest(run({ runId: "claude:laptop:mismatched-run", rootRunId: "claude:laptop:mismatched-run", cli: "codex" })) as never)).toEqual({ ok: false, reason: "invalid run record" });
  });

  it("stores mode only for session runs", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.agents.internalIngest, ingest(run({ mode: "interactive" })) as never)).toMatchObject({ ok: true });
    const autonomous = run({ runId: "claude:laptop:auto-session", rootRunId: "claude:laptop:auto-session", mode: "autonomous" });
    expect(await t.mutation(internal.agents.internalIngest, ingest(autonomous) as never)).toMatchObject({ ok: true });
    const job = run({ runId: "claude:laptop:cron-job-run", rootRunId: "claude:laptop:cron-job-run", kind: "job", mode: "interactive" });
    expect(await t.mutation(internal.agents.internalIngest, ingest(job) as never)).toEqual({ ok: false, reason: "invalid run record" });
  });

  it("keeps chunks immutable and stamps only a complete, verified reassembly", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.internalIngest, ingest() as never);
    expect(await t.mutation(internal.agents.internalIngest, ingest(run(), [row(1, { overflow: { sha256: "a".repeat(64), byteLength: 1, chunkCount: 1 } })]) as never)).toEqual({ ok: false, reason: "overflow must be stamped separately" });
    expect(await t.mutation(internal.agents.internalStampOverflow, { runId: "claude:laptop:root-run", seq: 0, sha256: HELLO_WORLD_SHA256, byteLength: 11, chunkCount: 2 })).toEqual({ ok: false, reason: "chunks incomplete" });
    expect(await t.mutation(internal.agents.internalIngestOverflow, { runId: "claude:laptop:root-run", seq: 0, index: 1, chunkCount: 2, text: "world" })).toEqual({ ok: true, index: 1 });
    expect(await t.mutation(internal.agents.internalStampOverflow, { runId: "claude:laptop:root-run", seq: 0, sha256: HELLO_WORLD_SHA256, byteLength: 11, chunkCount: 2 })).toEqual({ ok: false, reason: "chunks incomplete" });
    expect(await t.mutation(internal.agents.internalIngestOverflow, { runId: "claude:laptop:root-run", seq: 0, index: 0, chunkCount: 2, text: "hello " })).toEqual({ ok: true, index: 0 });
    expect(await t.mutation(internal.agents.internalIngestOverflow, { runId: "claude:laptop:root-run", seq: 0, index: 0, chunkCount: 2, text: "different" })).toEqual({ ok: false, reason: "chunk already written" });
    expect(await t.mutation(internal.agents.internalStampOverflow, { runId: "claude:laptop:root-run", seq: 0, sha256: "a".repeat(64), byteLength: 11, chunkCount: 2 })).toEqual({ ok: false, reason: "chunk integrity mismatch" });
    expect(await t.mutation(internal.agents.internalStampOverflow, { runId: "claude:laptop:root-run", seq: 0, sha256: HELLO_WORLD_SHA256, byteLength: 11, chunkCount: 2 })).toEqual({ ok: true, stamped: true });
    expect(await t.mutation(internal.agents.internalIngestOverflow, { runId: "claude:laptop:root-run", seq: 0, index: 0, chunkCount: 2, text: "hello " })).toEqual({ ok: false, reason: "row already stamped" });
    const viewer = await withTom(t);
    expect((await viewer.query(api.agents.rows, { agentId: "claude:laptop:root-run", paginationOpts: { cursor: null, numItems: 1 } })).page[0]).toMatchObject({ hasOverflow: true, fullByteLength: 11 });
  });

  for (const cli of ["claude", "codex"] as const) {
    it(`derives a three-level ${cli} tree parent-first`, async () => {
      const t = convexTest(schema, modules);
      const parent = `${cli}:laptop:parent-run`;
      const first = `${cli}:laptop:first-child`;
      const second = `${cli}:laptop:second-child`;
      const parentRun = run({ runId: parent, rootRunId: parent, cli, kind: cli === "claude" ? "session" : "unknown" });
      expect(await t.mutation(internal.agents.internalIngest, ingest(parentRun, [], [child(first, parent, parent, 1, cli === "claude")]) as never)).toMatchObject({ ok: true });
      const firstRun = run({ runId: first, parentRunId: parent, rootRunId: parent, depth: 1, cli, kind: cli === "claude" ? "subagent" : "codex-child", linkKnown: cli === "claude", ...(cli === "claude" ? { spawnedByToolUseId: "exact-tool-use" } : {}) });
      const firstResponse = await t.mutation(internal.agents.internalIngest, ingest(firstRun, [row(0, { depth: 1 })], [child(second, first, parent, 2, cli === "claude")]) as never);
      expect(firstResponse, JSON.stringify(firstResponse)).toMatchObject({ ok: true });
      const secondRun = run({ runId: second, parentRunId: first, rootRunId: parent, depth: 2, cli, kind: cli === "claude" ? "subagent" : "codex-child", linkKnown: cli === "claude", ...(cli === "claude" ? { spawnedByToolUseId: "exact-tool-use" } : {}) });
      expect(await t.mutation(internal.agents.internalIngest, ingest(secondRun, [row(0, { depth: 2 })]) as never)).toMatchObject({ ok: true });
      const tree = await t.run((ctx) => ctx.db.query("runs").withIndex("by_root_depth", (q) => q.eq("rootRunId", parent)).collect());
      expect(tree.map((entry) => [entry.runId, entry.depth])).toEqual(expect.arrayContaining([[parent, 0], [first, 1], [second, 2]]));
    });

    it(`repairs a three-level ${cli} tree when children arrive first`, async () => {
      const t = convexTest(schema, modules);
      const parent = `${cli}:laptop:parent-run`;
      const first = `${cli}:laptop:first-child`;
      const second = `${cli}:laptop:second-child`;
      const secondRun = run({ runId: second, parentRunId: first, rootRunId: first, depth: 1, cli, kind: cli === "claude" ? "subagent" : "codex-child", linkKnown: cli === "claude", ...(cli === "claude" ? { spawnedByToolUseId: "exact-tool-use" } : {}) });
      expect(await t.mutation(internal.agents.internalIngest, ingest(secondRun, [row(0, { depth: 1 })]) as never)).toMatchObject({ ok: true });
      const firstRun = run({ runId: first, parentRunId: parent, rootRunId: parent, depth: 1, cli, kind: cli === "claude" ? "subagent" : "codex-child", linkKnown: cli === "claude", ...(cli === "claude" ? { spawnedByToolUseId: "exact-tool-use" } : {}) });
      expect(await t.mutation(internal.agents.internalIngest, ingest(firstRun, [row(0, { depth: 1 })]) as never)).toMatchObject({ ok: true });
      const parentRun = run({ runId: parent, rootRunId: parent, cli, kind: cli === "claude" ? "session" : "unknown" });
      expect(await t.mutation(internal.agents.internalIngest, ingest(parentRun, []) as never)).toMatchObject({ ok: true });
      const tree = await t.run((ctx) => ctx.db.query("runs").withIndex("by_root_depth", (q) => q.eq("rootRunId", parent)).collect());
      expect(tree.map((entry) => [entry.runId, entry.depth])).toEqual(expect.arrayContaining([[parent, 0], [first, 1], [second, 2]]));
    });
  }

  it("pages children with an explicit bounded cursor contract", async () => {
    const t = convexTest(schema, modules);
    const parent = "claude:laptop:parent-run";
    await t.mutation(internal.agents.internalIngest, ingest(run({ runId: parent, rootRunId: parent }), [], [
      child("claude:laptop:child-one", parent, parent, 1),
      child("claude:laptop:child-two", parent, parent, 1),
    ]) as never);
    const viewer = await withTom(t);
    const first = await viewer.query(api.agents.children, { agentId: parent, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await viewer.query(api.agents.children, { agentId: parent, limit: 1, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    await expect(viewer.query(api.agents.children, { agentId: parent, limit: 501 })).rejects.toThrow();
  });

  it("denies every public reader without Tom identity", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.internalIngest, ingest() as never);
    const stranger = t.withIdentity({ subject: "someone-else" });
    await expect(stranger.query(api.agents.get, { agentId: "claude:laptop:root-run" })).rejects.toThrow();
    await expect(stranger.query(api.agents.children, { agentId: "claude:laptop:root-run" })).rejects.toThrow();
    await expect(stranger.query(api.agents.rows, { agentId: "claude:laptop:root-run", paginationOpts: { cursor: null, numItems: 1 } })).rejects.toThrow();
    await expect(stranger.query(api.agents.entry, { agentId: "claude:laptop:root-run", seq: 0 })).rejects.toThrow();
  });

  // witness: let a later ingest's runId replace the link and the page reads
  // another run's rows under this session.
  it("reads a session's rows from the run it names, and a later runId never replaces the link", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await session(t, { status: "running" });
    const stamp = { sha256: "a".repeat(64), byteLength: 20, chunkCount: 1 };
    const value = run({ sessionId });
    await t.mutation(internal.agents.internalIngest, ingest(value, [
      row(0, { kind: "user", content: { text: "hello" } }),
      row(1, { kind: "assistant-text", content: { text: "answer" }, digest: "1111111111111111" }),
    ], []) as never);
    // The overflow stamp itself is verified elsewhere (chunk reassembly); here
    // it only needs to exist so the page can say the row was cut.
    await t.run(async (ctx) => {
      const inserted = await ctx.db.query("claudeMessages").withIndex("by_run_seq", (q) => q.eq("runId", value.runId).eq("seq", 1)).unique();
      if (inserted) await ctx.db.patch(inserted._id, { overflow: stamp });
    });
    const tom = await withTom(t);
    await t.mutation(internal.claudeSessions.internalIngest, { sessionId, runId: "different-run-must-not-replace-the-link" });
    const page = await tom.query(api.claudeSessions.getMessages, { sessionId, paginationOpts: { cursor: null, numItems: 10 } });
    expect(page.page.map(({ seq, kind, content, hasOverflow, fullByteLength }) => ({ seq, kind, content, hasOverflow, fullByteLength }))).toEqual([
      { seq: 1, kind: "assistant-text", content: { text: "answer" }, hasOverflow: true, fullByteLength: 20 },
      { seq: 0, kind: "user", content: { text: "hello" }, hasOverflow: false, fullByteLength: undefined },
    ]);
    expect((await t.run((ctx) => ctx.db.get(sessionId)))?.runId).toBe(value.runId);
  });

  // A session whose run is not named yet: its first turn is still running.
  // The page shows an empty transcript, never an error that takes it down.
  it("answers an empty page while a session has no run id", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await session(t);
    const tom = await withTom(t);
    const page = await tom.query(api.claudeSessions.getMessages, {
      sessionId,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(page).toMatchObject({ page: [], isDone: true });
  });

  it("repairs a box session link from the Claude root id", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await session(t, { sdkSessionId: "sdk-root", status: "running" });
    const result = await t.mutation(internal.agents.internalIngest, ingest(
      run({ runId: "claude:box:sdk-root", rootRunId: "claude:box:sdk-root", host: "box" }), [], [],
    ) as never);
    expect(result).toMatchObject({ ok: true, runId: "claude:box:sdk-root" });
    const [storedRun, storedSession] = await t.run(async (ctx) => [
      await ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:box:sdk-root")).unique(),
      await ctx.db.get(sessionId),
    ]);
    expect(storedRun?.sessionId).toBe(sessionId);
    expect(storedSession?.runId).toBe("claude:box:sdk-root");
  });

  // witness: link only Claude roots by the SDK id and a Codex session's rows
  // land under a run no session names — the page reads nothing for it, the
  // labeller finds no session, and eviction treats its transcript as nobody's.
  it("links a box Codex root to the session that names its run", async () => {
    const t = convexTest(schema, modules);
    const runId = "codex:box:019a7c1e-thread-1";
    const sessionId = await session(t, { status: "running", runId, model: "gpt-5.6-sol", sdkSessionId: "019a7c1e-thread-1" });
    const result = await t.mutation(internal.agents.internalIngest, ingest(
      run({ runId, rootRunId: runId, host: "box", cli: "codex" }), [], [],
    ) as never);
    expect(result).toMatchObject({ ok: true, runId });
    const stored = await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", runId)).unique());
    expect(stored?.sessionId).toBe(sessionId);
    // A Codex root no session names stays unlinked.
    await t.mutation(internal.agents.internalIngest, ingest(
      run({ runId: "codex:box:019a7c1e-thread-2", rootRunId: "codex:box:019a7c1e-thread-2", host: "box", cli: "codex" }), [], [],
    ) as never);
    const other = await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "codex:box:019a7c1e-thread-2")).unique());
    expect(other?.sessionId).toBeUndefined();
  });

  // The sweep can read an agent file that carries no envelope and no end
  // marker, long after its session ended. The session row is the fact: witness — take the file's silence as the answer and
  // every old session's run reads as an unknown worker, abandoned.
  describe("a session's root run", () => {
    const boxRun = (id: string, overrides: Record<string, unknown> = {}) =>
      run({ runId: `claude:box:${id}`, rootRunId: `claude:box:${id}`, host: "box", kind: "unknown", ...overrides });
    const at = (t: SchemaTest, runId: string) =>
      t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", runId)).unique());
    const defaulted = (t: SchemaTest) =>
      t.run(async (ctx) => (await ctx.db.query("dtsEvents").collect()).filter((entry) => entry.kind === "agents-environment-defaulted"));

    it("is the session's, and ended with it, when the file says nothing", async () => {
      const t = convexTest(schema, modules);
      const sessionId = await session(t, { status: "ended", sdkSessionId: "sdk-old-session" });
      expect(await t.mutation(internal.agents.internalIngest, ingest(boxRun("sdk-old-session")) as never)).toMatchObject({ ok: true });
      expect(await at(t, "claude:box:sdk-old-session")).toMatchObject({ sessionId, environment: "session", kind: "session", status: "ended" });
      expect(await defaulted(t)).toEqual([]);
    });

    it("corrects a run the record called a worker and abandoned before its session was known", async () => {
      const t = convexTest(schema, modules);
      const abandoned = { status: "abandoned", abandonedAt: 5 };
      await t.mutation(internal.agents.internalIngest, ingest(boxRun("sdk-late-link", abandoned)) as never);
      expect(await at(t, "claude:box:sdk-late-link")).toMatchObject({ environment: "worker", kind: "unknown", status: "abandoned", abandonedAt: 5 });
      const sessionId = await session(t, { status: "ended", sdkSessionId: "sdk-late-link" });
      await t.mutation(internal.agents.internalIngest, retry(boxRun("sdk-late-link", { ...abandoned, file: { ...run().file, committedLine: 2, committedPrefixSha256: GROWN_PREFIX_HASH } }), [row(1)]) as never);
      const stored = await at(t, "claude:box:sdk-late-link");
      expect(stored).toMatchObject({ sessionId, environment: "session", kind: "session", status: "ended" });
      expect(stored?.abandonedAt).toBeUndefined();
    });

    it("stays abandoned while its session has no ending, and keeps an ending its file names", async () => {
      const t = convexTest(schema, modules);
      await session(t, { status: "idle", sdkSessionId: "sdk-live" });
      await t.mutation(internal.agents.internalIngest, ingest(boxRun("sdk-live", { status: "abandoned", abandonedAt: 5 })) as never);
      expect(await at(t, "claude:box:sdk-live")).toMatchObject({ environment: "session", status: "abandoned", abandonedAt: 5 });

      await session(t, { status: "failed", sdkSessionId: "sdk-failed" });
      await t.mutation(internal.agents.internalIngest, ingest(boxRun("sdk-failed")) as never);
      expect((await at(t, "claude:box:sdk-failed"))?.status).toBe("failed");

      await session(t, { status: "ended", sdkSessionId: "sdk-said-failed" });
      await t.mutation(internal.agents.internalIngest, ingest(boxRun("sdk-said-failed", { status: "failed" })) as never);
      expect((await at(t, "claude:box:sdk-said-failed"))?.status).toBe("failed");
    });

    it("keeps an environment the envelope named, and a kind the file named", async () => {
      const t = convexTest(schema, modules);
      await session(t, { status: "ended", sdkSessionId: "sdk-named" });
      await t.mutation(internal.agents.internalIngest, ingest(boxRun("sdk-named", { environment: "orchestrator", kind: "job" })) as never);
      expect(await at(t, "claude:box:sdk-named")).toMatchObject({ environment: "orchestrator", kind: "job", status: "ended" });
    });

    it("is linked by the session that names it when the SDK id does not match", async () => {
      const t = convexTest(schema, modules);
      const sessionId = await session(t, { status: "ended", runId: "claude:box:named-by-run-id" });
      await t.mutation(internal.agents.internalIngest, ingest(boxRun("named-by-run-id")) as never);
      expect(await at(t, "claude:box:named-by-run-id")).toMatchObject({ sessionId, environment: "session", status: "ended" });
    });
  });

  it("gives a session's next run the run it continues, and never links the old run to itself", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await session(t, { sdkSessionId: "sdk-after-reopen", continuesRunId: "claude:box:sdk-before-reopen" });
    const at = (runId: string) => t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", runId)).unique());
    await t.mutation(internal.agents.internalIngest, ingest(run({ runId: "claude:box:sdk-after-reopen", rootRunId: "claude:box:sdk-after-reopen", host: "box" }), [], []) as never);
    expect(await at("claude:box:sdk-after-reopen")).toMatchObject({ sessionId, continuesRunId: "claude:box:sdk-before-reopen" });
    // A late page of the old run, carrying the same session, stays unlinked.
    await t.mutation(internal.agents.internalIngest, ingest(run({ runId: "claude:box:sdk-before-reopen", rootRunId: "claude:box:sdk-before-reopen", host: "box", sessionId }), [], []) as never);
    expect((await at("claude:box:sdk-before-reopen"))?.continuesRunId).toBeUndefined();
  });

  it("accepts abandoned lifecycle state and emits paged manifest entries", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.internalIngest, ingest(run({
        origin: "job", status: "abandoned", abandonedAt: 123,
        envelopeKey: "runs/claude/laptop/root/registration-hash.json.gz",
        file: { ...run().file, storeKey: "runs/claude/laptop/root/stored.jsonl.gz" },
      }), [], []) as never);
    const stored = await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:laptop:root-run")).unique());
    expect(stored).toMatchObject({ status: "abandoned", abandonedAt: 123, origin: "job" });
    const manifest = await t.query(internal.agents.internalManifest, { since: 0 });
    expect(manifest.entries).toEqual([expect.objectContaining({
      run_id: "claude:laptop:root-run", cli: "claude", thread_id: "root-run", file_version: STORED_HASH,
      store_key: "runs/claude/laptop/root/stored.jsonl.gz", parent_run_id: null,
    })]);
    expect((await t.query(internal.agents.internalManifest, { since: manifest.entries[0].at, afterRunId: manifest.entries[0].run_id, afterFileVersion: manifest.entries[0].file_version })).entries).toEqual([]);
    await t.mutation(internal.agents.internalIngest, retry(run({ status: "ended" }), [], []) as never);
    expect((await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:laptop:root-run")).unique()))?.status).toBe("ended");
  });

  it("manifests each file version once across retries and equal timestamps", async () => {
    const t = convexTest(schema, modules);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const firstRun = run({ file: { ...run().file, storedHash: VERSION_A_HASH, storeKey: "runs/a.jsonl.gz" } });
      await t.mutation(internal.agents.internalIngest, ingest(firstRun, [], []) as never);
      const secondRun = run({ file: { ...run().file, storedHash: VERSION_B_HASH, storeKey: "runs/b.jsonl.gz", bytes: 20, committedLine: 2, committedPrefixSha256: GROWN_PREFIX_HASH } });
      const secondInput = retry(secondRun, [], []);
      await t.mutation(internal.agents.internalIngest, secondInput as never);
      await t.mutation(internal.agents.internalIngest, secondInput as never);
      const versions = await t.run((ctx) => ctx.db.query("runFileVersions").collect());
      expect(versions.map((version) => version.fileVersion).sort()).toEqual([VERSION_A_HASH, VERSION_B_HASH]);
      const manifest = await t.query(internal.agents.internalManifest, { since: 0 });
      expect(manifest.entries.map((entry) => entry.file_version)).toEqual([VERSION_A_HASH, VERSION_B_HASH]);
      const resumed = await t.query(internal.agents.internalManifest, {
        since: manifest.entries[0].at,
        afterRunId: manifest.entries[0].run_id,
        afterFileVersion: manifest.entries[0].file_version,
      });
      expect(resumed.entries.map((entry) => entry.file_version)).toEqual([VERSION_B_HASH]);
    } finally {
      now.mockRestore();
    }
  });
});

// ── Opening an old run from the store, and the window that makes it needed ───
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const STORE_KEY = "runs/claude/laptop/root-run/stored.jsonl.gz";
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 30 * DAY_MS;
// 04:30 America/New_York in January (EST, UTC-5): the one hour the eviction
// handler's guard lets through.
const EVICTION_HOUR_UTC = Date.UTC(2026, 0, 15, 9, 30);

// The schema-aware handle, so a helper may read a real index by name.
const schemaTest = () => convexTest(schema, modules);
type SchemaTest = ReturnType<typeof schemaTest>;

function storedRun(overrides: Record<string, unknown> = {}) {
  return run({ file: { ...run().file, storeKey: STORE_KEY }, ...overrides });
}
/** The shape the backlog importer posts: one index row, no transcript rows. */
function backlogIngest(overrides: Record<string, unknown> = {}) {
  const value = storedRun({ ...overrides, file: { ...run().file, committedLine: 0, committedPrefixSha256: EMPTY_SHA256, storeKey: STORE_KEY, totalLines: 4000 } });
  return ingest(value, [], [], 0, EMPTY_SHA256);
}
async function runRow(t: SchemaTest, runId: string) {
  return await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", runId)).unique());
}
async function requests(t: SchemaTest, runId?: string) {
  const all = await t.run((ctx) => ctx.db.query("runMaterializeRequests").collect());
  return runId ? all.filter((request) => request.runId === runId) : all;
}
async function evictedEvents(t: SchemaTest) {
  return await t.run((ctx) => ctx.db.query("dtsEvents").withIndex("by_kind_at", (q) => q.eq("kind", "agents-evicted")).collect());
}

describe("agents: materialize requests", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a run with no store key, and every caller who is not Tom", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.internalIngest, ingest() as never);
    const tom = await withTom(t);
    await expect(tom.mutation(api.agents.requestMaterialize, { agentId: "claude:laptop:root-run" })).rejects.toThrow("agent has no store key");
    await expect(tom.mutation(api.agents.requestMaterialize, { agentId: "claude:laptop:absent-run" })).rejects.toThrow("agent not found");
    await expect(tom.mutation(api.agents.requestMaterialize, { agentId: "not-a-run" })).rejects.toThrow("invalid agentId");
    expect(await requests(t)).toEqual([]);
    const stranger = t.withIdentity({ subject: "someone-else" });
    await expect(stranger.mutation(api.agents.requestMaterialize, { agentId: "claude:laptop:root-run" })).rejects.toThrow();
    await expect(stranger.query(api.agents.materializeStatus, { agentId: "claude:laptop:root-run" })).rejects.toThrow();
    await expect(stranger.mutation(api.agents.markOpened, { agentId: "claude:laptop:root-run" })).rejects.toThrow();
  });

  it("queues one request while it is pending and a fresh one once it is answered", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.internalIngest, backlogIngest() as never);
    const tom = await withTom(t);
    const first = await tom.mutation(api.agents.requestMaterialize, { agentId: "claude:laptop:root-run" });
    const second = await tom.mutation(api.agents.requestMaterialize, { agentId: "claude:laptop:root-run" });
    expect(second?._id).toBe(first?._id);
    expect(await requests(t)).toHaveLength(1);
    expect(first).toMatchObject({ status: "pending", requestedBy: "tom", slice: 1 });
    expect(await tom.query(api.agents.materializeStatus, { agentId: "claude:laptop:root-run" })).toMatchObject({ _id: first?._id });

    await t.mutation(internal.agents.internalAnswerMaterialize, { requestId: first!._id, status: "failed", reason: "store unreachable" });
    const third = await tom.mutation(api.agents.requestMaterialize, { agentId: "claude:laptop:root-run" });
    expect(third?._id).not.toBe(first?._id);
    expect(await requests(t)).toHaveLength(2);
    // The status query reads the newest, which is the one the page waits on.
    expect(await tom.query(api.agents.materializeStatus, { agentId: "claude:laptop:root-run" })).toMatchObject({ _id: third?._id, status: "pending" });
    expect(await tom.query(api.agents.materializeStatus, { agentId: "claude:laptop:other-run" })).toBeNull();
  });

  it("hands the box the oldest pending request, answerable even when its agent is gone", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.internalIngest, backlogIngest() as never);
    const orphan = await t.run((ctx) => ctx.db.insert("runMaterializeRequests", { runId: "codex:box:vanished-thread", requestedBy: "worker", requestedAt: 1, status: "pending", slice: 1 }));
    const tom = await withTom(t);
    await tom.mutation(api.agents.requestMaterialize, { agentId: "claude:laptop:root-run" });

    const oldest = await t.query(internal.agents.internalNextMaterialize, {});
    expect(oldest.request).toMatchObject({
      requestId: orphan, agentId: "codex:box:vanished-thread", cli: "codex", host: "box",
      threadId: "vanished-thread", depth: 0, parentAgentId: null, hasRows: false, fromLine: 0,
      file: { storeKey: null, sidecarStoredHash: null, totalLines: null },
    });
    await t.mutation(internal.agents.internalAnswerMaterialize, { requestId: orphan, status: "failed", reason: "agent is gone" });

    // A backlog run has no rows, so the parse starts at line 0.
    const backlog = await t.query(internal.agents.internalNextMaterialize, {});
    expect(backlog.request).toMatchObject({
      agentId: "claude:laptop:root-run", cli: "claude", host: "laptop", threadId: "root-run",
      hasRows: false, fromLine: 0, file: { storeKey: STORE_KEY, totalLines: 4000, committedLine: 0 },
    });
    expect(backlog.request).not.toHaveProperty("runner");

    // A continuation resumes from the lines already in the record.
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:laptop:root-run")).unique();
      if (stored) await ctx.db.patch(stored._id, { file: { ...stored.file, committedLine: 2000, committedPrefixSha256: PREFIX_HASH } });
      await ctx.db.insert("claudeMessages", { runId: "claude:laptop:root-run", seq: 0, turn: 0, kind: "user", content: { text: "x" }, provenance: { fileVersion: STORED_HASH, file: "C:/root.jsonl", lineStart: 0, lineEnd: 0, block: 0, parserVersion: "runs-parser-1", sourceKind: "user" }, digest: "0123456789abcdef", depth: 0, createdAt: 1 });
    });
    const continued = await t.query(internal.agents.internalNextMaterialize, {});
    expect(continued.request).toMatchObject({ hasRows: true, fromLine: 2000 });
  });

  it("records what the box answered and continues the run itself, once", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.internalIngest, backlogIngest() as never);
    const tom = await withTom(t);
    const first = await tom.mutation(api.agents.requestMaterialize, { agentId: "claude:laptop:root-run" });
    const rowsSource = { from: "store" as const, at: 10, parserVersion: "runs-parser-1", storeKey: STORE_KEY, rowsFromLine: 0, rowsToLine: 2000, slices: 1, droppedLines: 3, partial: ["unknown-line-types"] };

    expect(await t.mutation(internal.agents.internalAnswerMaterialize, { requestId: first!._id, status: "served", reason: "a".repeat(201) })).toEqual({ ok: false, reason: "reason too long" });
    expect(await t.mutation(internal.agents.internalAnswerMaterialize, { requestId: first!._id, status: "failed", reason: "the bucket said no" })).toEqual({ ok: false, reason: "reason outside the closed vocabulary" });
    expect(await t.mutation(internal.agents.internalAnswerMaterialize, { requestId: first!._id, status: "served", rowsSource: { ...rowsSource, partial: ["everything-is-fine"] } })).toEqual({ ok: false, reason: "partial outside the closed vocabulary" });
    expect((await requests(t))[0].status).toBe("pending");

    expect(await t.mutation(internal.agents.internalAnswerMaterialize, { requestId: first!._id, status: "served", rowsIngested: 2000, fromLine: 0, toLine: 2000, totalLines: 4000, rowsSource })).toEqual({ ok: true, alreadyAnswered: false, continuation: true });
    const stored = await runRow(t, "claude:laptop:root-run");
    expect(stored?.rowsSource).toMatchObject({ from: "store", rowsFromLine: 0, rowsToLine: 2000, droppedLines: 3, partial: ["unknown-line-types"] });
    expect(stored?.file.totalLines).toBe(4000);
    const queued = await requests(t, "claude:laptop:root-run");
    expect(queued.filter((request) => request.status === "pending")).toHaveLength(1);
    expect(queued.find((request) => request.status === "pending")).toMatchObject({ slice: 2, requestedBy: "tom" });
    expect(queued.find((request) => request.status === "served")).toMatchObject({ rowsIngested: 2000, fromLine: 0, toLine: 2000 });

    // The same answer again queues nothing further.
    expect(await t.mutation(internal.agents.internalAnswerMaterialize, { requestId: first!._id, status: "served", toLine: 2000, totalLines: 4000 })).toEqual({ ok: true, alreadyAnswered: true, continuation: false });
    expect(await requests(t, "claude:laptop:root-run")).toHaveLength(2);
  });

  it("accepts an answer that says it served the agent's newest version instead of the one requested", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.internalIngest, backlogIngest() as never);
    const tom = await withTom(t);
    const first = await tom.mutation(api.agents.requestMaterialize, { agentId: "claude:laptop:root-run" });
    const rowsSource = { from: "store" as const, at: 10, parserVersion: "runs-parser-1", storeKey: STORE_KEY, rowsFromLine: 0, rowsToLine: 2000, slices: 1, droppedLines: 0, partial: ["served-newer-version"] };
    expect(await t.mutation(internal.agents.internalAnswerMaterialize, { requestId: first!._id, status: "served", rowsIngested: 2000, fromLine: 0, toLine: 2000, totalLines: 4000, rowsSource })).toMatchObject({ ok: true, alreadyAnswered: false });
    expect((await runRow(t, "claude:laptop:root-run"))?.rowsSource?.partial).toEqual(["served-newer-version"]);
    expect((await requests(t, "claude:laptop:root-run")).find((request) => request.status === "served")).toMatchObject({ rowsIngested: 2000 });
  });

  it("stops at the fifth slice and says the cap was reached", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.internalIngest, backlogIngest() as never);
    const last = await t.run((ctx) => ctx.db.insert("runMaterializeRequests", { runId: "claude:laptop:root-run", requestedBy: "tom", requestedAt: 5, status: "pending", slice: 5 }));
    const answer = await t.mutation(internal.agents.internalAnswerMaterialize, {
      requestId: last, status: "served", rowsIngested: 100, fromLine: 3000, toLine: 3900, totalLines: 4000,
      rowsSource: { from: "store", at: 20, parserVersion: "runs-parser-1", storeKey: STORE_KEY, rowsFromLine: 3000, rowsToLine: 3900, slices: 5, droppedLines: 0, partial: [] },
    });
    expect(answer).toEqual({ ok: true, alreadyAnswered: false, continuation: false });
    expect((await runRow(t, "claude:laptop:root-run"))?.rowsSource?.partial).toEqual(["row-cap-reached"]);
    expect((await requests(t, "claude:laptop:root-run")).filter((request) => request.status === "pending")).toEqual([]);
  });
});

describe("agents: the row window", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("gives an index-only backlog row no window at all, and a row-bearing ingest one", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.internalIngest, backlogIngest() as never);
    expect((await runRow(t, "claude:laptop:root-run"))?.rowsUntil).toBeUndefined();

    const grown = convexTest(schema, modules);
    await grown.mutation(internal.agents.internalIngest, ingest() as never);
    expect((await runRow(grown, "claude:laptop:root-run"))?.rowsUntil).toBe(2 + WINDOW_MS);
    // A no-op ingest of the same file writes nothing; a later line moves it.
    await grown.mutation(internal.agents.internalIngest, retry(run(), []) as never);
    expect((await runRow(grown, "claude:laptop:root-run"))?.rowsUntil).toBe(2 + WINDOW_MS);
    await grown.mutation(internal.agents.internalIngest, retry(run({ lastLineAt: 5000 }), []) as never);
    expect((await runRow(grown, "claude:laptop:root-run"))?.rowsUntil).toBe(5000 + WINDOW_MS);
  });

  it("moves the window on an opened run only past the one-day threshold", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.internalIngest, ingest() as never);
    await t.mutation(internal.agents.internalIngest, backlogIngest({ runId: "claude:laptop:index-only", rootRunId: "claude:laptop:index-only" }) as never);
    const tom = await withTom(t);

    expect(await tom.mutation(api.agents.markOpened, { agentId: "claude:laptop:root-run" })).toEqual({ ok: true, moved: true });
    const moved = (await runRow(t, "claude:laptop:root-run"))?.rowsUntil;
    expect(moved).toBeGreaterThan(2 + WINDOW_MS);
    // Reading the same run again inside the day is not a second write.
    expect(await tom.mutation(api.agents.markOpened, { agentId: "claude:laptop:root-run" })).toEqual({ ok: true, moved: false });
    expect((await runRow(t, "claude:laptop:root-run"))?.rowsUntil).toBe(moved);
    // Looking at an index-only run does not make it evictable.
    expect(await tom.mutation(api.agents.markOpened, { agentId: "claude:laptop:index-only" })).toEqual({ ok: true, moved: false });
    expect((await runRow(t, "claude:laptop:index-only"))?.rowsUntil).toBeUndefined();
    expect(await tom.mutation(api.agents.markOpened, { agentId: "claude:laptop:absent-run" })).toEqual({ ok: true, moved: false });
  });
});

describe("agents: eviction", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  async function seedEvictable(t: SchemaTest, now: number, rows = 450) {
    const runId = "claude:laptop:root-run";
    await t.run(async (ctx) => {
      const existing = await ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", runId)).unique();
      if (existing) await ctx.db.patch(existing._id, { rowsUntil: now - DAY_MS });
      else await ctx.db.insert("runs", { ...storedRun({ status: "ended", startedAt: now - 61 * DAY_MS, lastLineAt: now - 60 * DAY_MS }), environment: "worker", ingestedAt: now, rowsUntil: now - DAY_MS } as never);
      for (let seq = 0; seq < rows; seq += 1) {
        const overflow = seq < 2 ? { sha256: "a".repeat(64), byteLength: 6, chunkCount: 2 } : undefined;
        await ctx.db.insert("claudeMessages", { runId, seq, turn: 0, kind: "user", content: { text: "x" }, digest: "0123456789abcdef", depth: 0, createdAt: seq + 1, overflow, provenance: ROW_PROVENANCE } as never);
        if (overflow) for (let index = 0; index < 2; index += 1) await ctx.db.insert("claudeMessageOverflow", { runId, seq, index, chunkCount: 2, text: "abc", createdAt: 1 } as never);
      }
    });
    return runId;
  }
  async function transcript(t: SchemaTest, runId: string) {
    return await t.run(async (ctx) => ({
      rows: (await ctx.db.query("claudeMessages").withIndex("by_run_seq", (q) => q.eq("runId", runId)).collect()).length,
      chunks: (await ctx.db.query("claudeMessageOverflow").withIndex("by_run_seq_index", (q) => q.eq("runId", runId)).collect()).length,
      labels: (await ctx.db.query("runLabels").withIndex("by_run_at", (q) => q.eq("runId", runId)).collect()).length,
    }));
  }
  async function tick(t: SchemaTest) {
    await t.mutation(internal.agents.internalEvictTick, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }

  it("evicts rows and their chunks exactly once, and leaves the index row standing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EVICTION_HOUR_UTC);
    vi.stubEnv("AGENTS_EVICTION_ENABLED", "1");
    const t = convexTest(schema, modules);
    const now = Date.now();
    const runId = await seedEvictable(t, now);
    await t.run((ctx) => ctx.db.insert("runLabels", { runId, source: "ruling", actor: "tom", polarity: "good", meaning: "kept the record", judgment: true, ref: "ruling:evict-test", at: now }));
    expect(await transcript(t, runId)).toEqual({ rows: 450, chunks: 4, labels: 1 });

    await tick(t);
    expect(await transcript(t, runId)).toEqual({ rows: 0, chunks: 0, labels: 1 });
    const evicted = await runRow(t, runId);
    expect(evicted).toMatchObject({ runId, rowsEvictedAt: now, file: { storeKey: STORE_KEY } });
    expect(evicted?.rowsUntil).toBeUndefined();
    expect((await evictedEvents(t)).map((entry) => entry.data)).toEqual([
      { at: now, runs: 1, rowsDeleted: 450, overflowChunksDeleted: 4, deferred: 0, truncated: false, oldestRowsUntil: null },
    ]);

    // A second tick over the same record touches nothing: the last act of
    // evicting a run is to take it out of the scan index.
    await tick(t);
    expect((await evictedEvents(t))[1].data).toMatchObject({ runs: 0, rowsDeleted: 0, overflowChunksDeleted: 0, deferred: 0 });

    // A third tick, after the rows came back from the store, evicts them again.
    await t.mutation(internal.agents.internalIngest, retry(run({ status: "ended", lastLineAt: now - 60 * DAY_MS, file: { ...run().file, storeKey: STORE_KEY } }), [row(0)]) as never);
    expect((await transcript(t, runId)).rows).toBe(1);
    expect((await runRow(t, runId))?.rowsUntil).toBe(now - 60 * DAY_MS + WINDOW_MS);
    await tick(t);
    expect(await transcript(t, runId)).toEqual({ rows: 0, chunks: 0, labels: 1 });
    expect((await evictedEvents(t))[2].data).toMatchObject({ runs: 1, rowsDeleted: 1, overflowChunksDeleted: 0 });
  });

  it("refuses a running run, a live session's run, and a run inside the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EVICTION_HOUR_UTC);
    vi.stubEnv("AGENTS_EVICTION_ENABLED", "1");
    const t = convexTest(schema, modules);
    const now = Date.now();
    const sessionId = await session(t, { status: "running" });
    const kept = [
      { runId: "claude:laptop:still-running", status: "running", lastLineAt: now - 60 * DAY_MS },
      { runId: "claude:laptop:live-session", status: "ended", lastLineAt: now - 60 * DAY_MS, sessionId },
      { runId: "claude:laptop:recent-lines", status: "ended", lastLineAt: now - 60 * 60 * 1000 },
    ];
    await t.run(async (ctx) => {
      for (const record of kept) {
        await ctx.db.insert("runs", { ...storedRun({ ...record, rootRunId: record.runId, startedAt: 1 }), environment: "worker", ingestedAt: now, rowsUntil: now - DAY_MS } as never);
        await ctx.db.insert("claudeMessages", { runId: record.runId, seq: 0, turn: 0, kind: "user", content: { text: "x" }, provenance: ROW_PROVENANCE, digest: "0123456789abcdef", depth: 0, createdAt: 1 } as never);
      }
    });

    await tick(t);
    for (const record of kept) {
      expect((await transcript(t, record.runId)).rows, record.runId).toBe(1);
      expect((await runRow(t, record.runId))?.rowsUntil, record.runId).toBe(now + DAY_MS);
    }
    expect((await evictedEvents(t))[0].data).toMatchObject({ runs: 0, rowsDeleted: 0, deferred: 3, truncated: false, oldestRowsUntil: now + DAY_MS });
  });

  // witness: keep only a LIVE session's run and a session Tom ended last week
  // loses its transcript tonight: its run's last line is older than the
  // window, and reading a session through its session never moves the run's
  // window.
  it("keeps a session's run until the session has been ended for the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EVICTION_HOUR_UTC);
    vi.stubEnv("AGENTS_EVICTION_ENABLED", "1");
    const t = convexTest(schema, modules);
    const now = Date.now();
    const endedLastWeek = await session(t, { status: "ended", statusChangedAt: now - 7 * DAY_MS });
    const endedLongAgo = await session(t, { status: "ended", statusChangedAt: now - 45 * DAY_MS });
    const records = [
      { runId: "claude:laptop:ended-last-week", sessionId: endedLastWeek },
      { runId: "claude:laptop:ended-long-ago", sessionId: endedLongAgo },
    ];
    await t.run(async (ctx) => {
      for (const record of records) {
        await ctx.db.insert("runs", { ...storedRun({ ...record, rootRunId: record.runId, status: "ended", startedAt: 1, lastLineAt: now - 60 * DAY_MS }), environment: "session", ingestedAt: now, rowsUntil: now - DAY_MS } as never);
        await ctx.db.insert("claudeMessages", { runId: record.runId, seq: 0, turn: 0, kind: "user", content: { text: "x" }, provenance: ROW_PROVENANCE, digest: "0123456789abcdef", depth: 0, createdAt: 1 } as never);
      }
    });

    await tick(t);
    expect((await transcript(t, "claude:laptop:ended-last-week")).rows).toBe(1);
    expect((await runRow(t, "claude:laptop:ended-last-week"))?.rowsUntil).toBe(now + DAY_MS);
    expect((await transcript(t, "claude:laptop:ended-long-ago")).rows).toBe(0);
  });

  it("deletes nothing while AGENTS_EVICTION_ENABLED is unset, and says so", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EVICTION_HOUR_UTC);
    const t = convexTest(schema, modules);
    const runId = await seedEvictable(t, Date.now(), 3);
    expect(await t.mutation(internal.agents.internalEvictTick, {})).toEqual({ ok: true, disabled: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await transcript(t, runId)).rows).toBe(3);
    expect((await evictedEvents(t))[0].data).toMatchObject({ runs: 0, rowsDeleted: 0, deferred: 0, disabled: true });
    expect((await runRow(t, runId))?.rowsUntil).toBe(Date.now() - DAY_MS);
  });

  it("leaves the record alone outside the eviction hour", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 15, 20, 0));
    vi.stubEnv("AGENTS_EVICTION_ENABLED", "1");
    const t = convexTest(schema, modules);
    const runId = await seedEvictable(t, Date.now(), 3);
    expect(await t.mutation(internal.agents.internalEvictTick, {})).toEqual({ ok: true, skipped: "not the eviction hour" });
    expect((await transcript(t, runId)).rows).toBe(3);
    expect(await evictedEvents(t)).toEqual([]);
  });
});

describe("agents.roots", () => {
  async function root(t: ReturnType<typeof convexTest>, runId: string, host: "laptop" | "box", startedAt: number) {
    expect(await t.mutation(internal.agents.internalIngest, ingest(run({ runId, rootRunId: runId, host, startedAt }), [], []) as never)).toMatchObject({ ok: true });
  }

  it("lists roots and never their children", async () => {
    const t = convexTest(schema, modules);
    const parent = "claude:laptop:root-run";
    await t.mutation(internal.agents.internalIngest, ingest(run(), [], [child("claude:laptop:child-run", parent, parent, 1)]) as never);
    const viewer = await withTom(t);
    expect((await viewer.query(api.agents.roots, {})).map((entry) => entry.runId)).toEqual([parent]);
  });

  it("merges both hosts newest first", async () => {
    const t = convexTest(schema, modules);
    await root(t, "claude:laptop:laptop-old", "laptop", 10);
    await root(t, "claude:box:box-newer", "box", 20);
    await root(t, "claude:laptop:laptop-new", "laptop", 30);
    await root(t, "claude:box:box-oldest", "box", 5);
    const viewer = await withTom(t);
    expect((await viewer.query(api.agents.roots, {})).map((entry) => entry.runId)).toEqual([
      "claude:laptop:laptop-new", "claude:box:box-newer", "claude:laptop:laptop-old", "claude:box:box-oldest",
    ]);
  });

  it("breaks a same-millisecond tie on runId", async () => {
    const t = convexTest(schema, modules);
    await root(t, "claude:laptop:tie-bravo", "laptop", 7);
    await root(t, "claude:box:tie-alpha", "box", 7);
    await root(t, "claude:laptop:tie-later", "laptop", 8);
    const viewer = await withTom(t);
    expect((await viewer.query(api.agents.roots, {})).map((entry) => entry.runId)).toEqual([
      "claude:laptop:tie-later", "claude:box:tie-alpha", "claude:laptop:tie-bravo",
    ]);
  });

  it("narrows to one host", async () => {
    const t = convexTest(schema, modules);
    await root(t, "claude:laptop:laptop-one", "laptop", 10);
    await root(t, "claude:box:box-run-one", "box", 20);
    const viewer = await withTom(t);
    expect((await viewer.query(api.agents.roots, { host: "box" })).map((entry) => entry.runId)).toEqual(["claude:box:box-run-one"]);
    expect((await viewer.query(api.agents.roots, { host: "laptop" })).map((entry) => entry.runId)).toEqual(["claude:laptop:laptop-one"]);
  });

  it("caps the merged result and refuses a limit outside 1..500", async () => {
    const t = convexTest(schema, modules);
    await root(t, "claude:laptop:laptop-old", "laptop", 10);
    await root(t, "claude:box:box-newest", "box", 30);
    await root(t, "claude:laptop:laptop-mid", "laptop", 20);
    const viewer = await withTom(t);
    expect((await viewer.query(api.agents.roots, { limit: 2 })).map((entry) => entry.runId)).toEqual([
      "claude:box:box-newest", "claude:laptop:laptop-mid",
    ]);
    await expect(viewer.query(api.agents.roots, { limit: 0 })).rejects.toThrow();
    await expect(viewer.query(api.agents.roots, { limit: 501 })).rejects.toThrow();
  });

  it("denies the reader without Tom identity", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.internalIngest, ingest() as never);
    const stranger = t.withIdentity({ subject: "someone-else" });
    await expect(stranger.query(api.agents.roots, {})).rejects.toThrow();
  });
});

// ── runs.internalRunTrace: the audit's own run, by its token ─────────────────
// What the trace checker reads to tell a claim from a fact: it said it opened a
// path, and this is every Read, Grep and Glob call the run actually made.
describe("agents: one agent's tool calls, by its registration token", () => {
  afterEach(() => vi.unstubAllEnvs());

  // The canonical example UUID, and a fixture. The door checks the token’s
  // SHAPE before the indexed lookup, so a shapeless placeholder would not
  // exercise the path this suite exists for. `gitleaks:allow` because
  // generic-api-key fires on the NAME plus the value’s entropy, not on any
  // real key — and now that the secret scan feeds the tests-run row, a false
  // positive here is a blocked merge rather than one red check nobody reads.
  const TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"; // gitleaks:allow
  const TRACE_RUN_ID = "claude:box:audit-trace-run";
  const TOTALS = {
    inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, cacheWrite5mTokens: 30,
    cacheWrite1hTokens: 0, cacheWriteBreakdownKnown: true, outputTokens: 40,
    // 999, not 100: `tokens` is the tokensOf SUM of four fields, never this.
    thinkingTokens: 5, totalTokens: 999,
  };

  async function seed(
    t: SchemaTest,
    rows: Array<{ kind: string; content: unknown }>,
    // `null` is a run with NO outcome — a run still going. It cannot be
    // `undefined`, which a default parameter reads as "not given".
    outcome: unknown | null = { turns: 12, toolCalls: 3, totals: TOTALS },
  ) {
    await t.run(async (ctx) => {
      await ctx.db.insert("runs", {
        ...storedRun({ runId: TRACE_RUN_ID, rootRunId: TRACE_RUN_ID, host: "box", kind: "job", status: "ended", environment: "worker" }),
        regToken: TOKEN,
        ...(outcome === null ? {} : { outcome }),
        ingestedAt: 1,
      } as never);
      for (const [seq, row] of rows.entries()) {
        await ctx.db.insert("claudeMessages", {
          runId: TRACE_RUN_ID, seq, turn: 0, kind: row.kind, content: row.content, provenance: ROW_PROVENANCE, createdAt: seq + 1,
        } as never);
      }
    });
  }
  const trace = (t: SchemaTest) => t.query(internal.agents.internalAgentTrace, { token: TOKEN });

  it("returns the tool-call rows and nothing else in the transcript", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { kind: "user", content: { text: "audit this head" } },
      { kind: "tool-call", content: { name: "Read", input: { file_path: "convex/http.ts" } } },
      { kind: "assistant-text", content: { text: "VERDICT: APPROVED" } },
      { kind: "tool-result", content: { text: "every byte of convex/http.ts" } },
      { kind: "thinking", content: { text: "thinking about convex/http.ts" } },
    ]);
    const answer = await trace(t);
    expect(answer?.toolCalls).toEqual([{ name: "Read", path: "convex/http.ts" }]);
    // The words of the run never leave: not the prompt, not the answer, not the
    // tool result, not the thinking.
    const serialized = JSON.stringify(answer);
    expect(serialized).not.toContain("audit this head");
    expect(serialized).not.toContain("VERDICT");
    expect(serialized).not.toContain("every byte");
    expect(serialized).not.toContain("thinking about");
  });

  it("reads a path out of file_path, path or pattern, in that order", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { kind: "tool-call", content: { name: "Read", input: { file_path: "convex/agents.ts" } } },
      { kind: "tool-call", content: { name: "Glob", input: { path: "convex/" } } },
      { kind: "tool-call", content: { name: "Grep", input: { pattern: "internalRunTrace" } } },
      // Both present: file_path wins, because it is the one a Read names.
      { kind: "tool-call", content: { name: "Edit", input: { file_path: "convex/http.ts", path: "elsewhere" } } },
    ]);
    expect((await trace(t))?.toolCalls).toEqual([
      { name: "Read", path: "convex/agents.ts" },
      { name: "Glob", path: "convex/" },
      { name: "Grep", path: "internalRunTrace" },
      { name: "Edit", path: "convex/http.ts" },
    ]);
  });

  // `content` is v.any(), so one row the daemon wrote oddly must cost this run
  // its trace no more than one bad line costs a file its parse.
  it("drops a row whose content cannot be read, rather than throwing", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { kind: "tool-call", content: null },
      { kind: "tool-call", content: "Read convex/http.ts" },
      { kind: "tool-call", content: 7 },
      { kind: "tool-call", content: {} },
      { kind: "tool-call", content: { name: 42, input: { file_path: "convex/http.ts" } } },
      { kind: "tool-call", content: { name: "", input: { file_path: "convex/http.ts" } } },
      // A name it CAN read and an input it cannot is half a row, and the half
      // it can read is the half finding 2 counts.
      { kind: "tool-call", content: { name: "Bash", input: "npm test" } },
      { kind: "tool-call", content: { name: "Read", input: { file_path: 7 } } },
      { kind: "tool-call", content: { name: "Read", input: { file_path: "convex/agents.ts" } } },
    ]);
    expect((await trace(t))?.toolCalls).toEqual([
      { name: "Bash", path: null },
      { name: "Read", path: null },
      { name: "Read", path: "convex/agents.ts" },
    ]);
  });

  it("redacts a credential-shaped argument and cuts a long one at 300", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { kind: "tool-call", content: { name: "Grep", input: { pattern: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" } } },
      { kind: "tool-call", content: { name: "Read", input: { file_path: `convex/${"a".repeat(400)}.ts` } } },
    ]);
    const toolCalls = (await trace(t))?.toolCalls ?? [];
    expect(toolCalls[0]).toEqual({ name: "Grep", path: "[redacted:github]" });
    expect(toolCalls[1]?.path).toHaveLength(300);
  });

  it("reads turns and tokens off the outcome, and answers null where there is none", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [{ kind: "tool-call", content: { name: "Read", input: { file_path: "a/b.ts" } } }]);
    // input + cacheRead + cacheWrite + output, the sum worker/jobs/evals.mjs
    // tokensOf makes — not totalTokens, which is 999 on this row.
    expect(await trace(t)).toMatchObject({ agentId: TRACE_RUN_ID, turns: 12, tokens: 100 });

    const running = convexTest(schema, modules);
    await seed(running, [{ kind: "tool-call", content: { name: "Read", input: { file_path: "a/b.ts" } } }], null);
    expect(await trace(running)).toMatchObject({ turns: null, tokens: null });
  });

  it("answers null for a token no run carries", async () => {
    const t = convexTest(schema, modules);
    await seed(t, []);
    expect(await t.query(internal.agents.internalAgentTrace, { token: "00000000-0000-4000-8000-000000000000" })).toBeNull();
  });

  // THE BOUND IS 400 ROWS, and the answer says when it bit: a cut list makes
  // finding 2 fire on a path that WAS read and fell past the cut, so the reader
  // has to be able to tell a whole trace from a slice.
  it("stops at 400 rows and declares the cut", async () => {
    const t = convexTest(schema, modules);
    await seed(
      t,
      Array.from({ length: 500 }, (_, index) => ({
        kind: "tool-call" as const,
        content: { name: "Read", input: { file_path: `convex/file-${index}.ts` } },
      })),
    );
    const answer = await trace(t);
    expect(answer?.toolCalls).toHaveLength(400);
    expect(answer?.toolCalls.at(-1)).toEqual({ name: "Read", path: "convex/file-399.ts" });
    expect(answer?.truncated).toBe(true);

    const short = convexTest(schema, modules);
    await seed(short, [{ kind: "tool-call", content: { name: "Read", input: { file_path: "a/b.ts" } } }]);
    expect((await trace(short))?.truncated).toBe(false);
  });
});

// ── One token, one agent ─────────────────────────────────────────────────────
// The registration token sits in the prompt's registration block, so a copied
// prompt can carry another agent's token. The first agent to reach the record
// with it keeps it; any other agent's page carrying it is refused.
describe("agents: a registration token belongs to one agent", () => {
  const TOKEN = "5a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d"; // gitleaks:allow — a fixture, not a credential
  const FIRST = "claude:box:token-first-agent";
  const SECOND = "claude:box:token-second-agent";
  const agent = (runId: string) => run({ runId, rootRunId: runId, host: "box", regToken: TOKEN, file: { ...run().file, path: `/srv/${runId}.jsonl` } });
  const duplicates = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) => (await ctx.db.query("dtsEvents").collect()).filter((entry) => entry.kind === "agents-token-duplicate"));

  it("refuses a second agent carrying the same token and records both agents and the token's first eight characters", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.agents.internalIngest, ingest(agent(FIRST)) as never)).toMatchObject({ ok: true });
    const refused = await t.mutation(internal.agents.internalIngest, ingest(agent(SECOND)) as never);
    expect(refused).toEqual({ ok: false, reason: "token held by another agent" });
    // Nothing of the second agent was written.
    const stored = await t.run((ctx) => ctx.db.query("runs").collect());
    expect(stored.map((entry) => entry.runId)).toEqual([FIRST]);
    expect(await t.run((ctx) => ctx.db.query("claudeMessages").withIndex("by_run_seq", (q) => q.eq("runId", SECOND)).collect())).toEqual([]);
    const events = await duplicates(t);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ agentId: SECOND, heldByAgentId: FIRST, tokenPrefix: TOKEN.slice(0, 8) });
    expect(JSON.stringify(events[0].data)).not.toContain(TOKEN);
  });

  it("takes the same agent's pages again under its own token", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.agents.internalIngest, ingest(agent(FIRST)) as never)).toMatchObject({ ok: true, inserted: 1 });
    expect(await t.mutation(internal.agents.internalIngest, retry(agent(FIRST)) as never)).toMatchObject({ ok: true, inserted: 0, skipped: 1 });
    expect(await t.mutation(internal.agents.internalIngest, retry(agent(FIRST), [row(0), row(1, { digest: "fedcba9876543210", kind: "assistant-text" })]) as never)).toMatchObject({ ok: true, inserted: 1 });
    expect(await duplicates(t)).toEqual([]);
  });
});
