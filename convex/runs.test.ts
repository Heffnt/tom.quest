import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { MODEL_OF_TOM_HEADER } from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
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
    origin: "unknown", host: "laptop", runner: "claude", parserVersion: "runs-parser-1", kind: "session", status: "unknown", startedAt: 1, lastLineAt: 2,
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

async function daemonRow(t: ReturnType<typeof convexTest>, sessionId: string, seq: number, kind: string, content: unknown, overflow?: { sha256: string; byteLength: number; chunkCount: number }) {
  await t.run((ctx) => ctx.db.insert("claudeMessages", {
    sessionId, seq, turn: 0, kind, content, overflow, createdAt: seq + 1,
  } as never));
}

describe("runs", () => {
  it("ingests immutable rows and returns them in source order", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(internal.runs.internalIngest, ingest(run(), [row(0), row(1, { digest: "fedcba9876543210", kind: "assistant-text" })]) as never);
    expect(result).toMatchObject({ ok: true, inserted: 2, skipped: 0, committedLine: 1 });
    const tom = await withTom(t);
    expect((await tom.query(api.runs.get, { runId: "claude:laptop:root-run" }))?.runId).toBe("claude:laptop:root-run");
    const rows = await tom.query(api.runs.rows, { runId: "claude:laptop:root-run", paginationOpts: { cursor: null, numItems: 10 } });
    expect(rows.page.map((entry) => entry.seq)).toEqual([0, 1]);
    expect(await tom.query(api.runs.entry, { runId: "claude:laptop:root-run", seq: 1 })).toMatchObject({ provenance: { fileVersion: STORED_HASH }, digest: "fedcba9876543210" });
  });

  it("uses the prior cursor/hash tuple as an append compare-and-swap fence", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, ingest() as never);
    const grown = run({ file: { ...run().file, bytes: 20, committedLine: 2, committedPrefixSha256: GROWN_PREFIX_HASH } });
    expect(await t.mutation(internal.runs.internalIngest, ingest(grown, [row(1000, { digest: "1111111111111111" })], [], 1, PREFIX_HASH) as never)).toMatchObject({ ok: true, inserted: 1, committedLine: 2 });

    // A rewrite plus append cannot bypass the fence just because its new cursor
    // is greater than the stored cursor.
    const rewrittenAppend = run({ file: { ...run().file, bytes: 30, committedLine: 3, committedPrefixSha256: "f".repeat(64) } });
    expect(await t.mutation(internal.runs.internalIngest, ingest(rewrittenAppend, [row(2000, { digest: "2222222222222222" })], [], 2, "0".repeat(64)) as never)).toEqual({ ok: false, reason: "file rewritten" });
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
    expect(await t.mutation(internal.runs.internalIngest, ingest(grandchild, [row(0, { depth: 2 })]) as never))
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
    expect(await t.mutation(internal.runs.internalIngest, ingest(sibling, [row(0, { depth: 2 })]) as never))
      .toMatchObject({ ok: true, inserted: 1 });

    const middle = run({
      runId: "claude:laptop:root-run/middle-agent", rootRunId: "claude:laptop:root-run",
      parentRunId: "claude:laptop:root-run", depth: 1, kind: "subagent",
      spawnedByToolUseId: "exact-tool-use",
      file: { ...run().file, path: "C:/middle.jsonl" },
    });
    expect(await t.mutation(internal.runs.internalIngest, ingest(middle, [row(0, { depth: 1 })]) as never))
      .toMatchObject({ ok: true, inserted: 1 });

    for (const [runId, path] of [["claude:laptop:root-run/grandchild-agent", "C:/grandchild.jsonl"], ["claude:laptop:root-run/sibling-agent", "C:/sibling.jsonl"]] as const) {
      const landed = await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", runId)).unique());
      expect(landed, runId).toMatchObject({ depth: 2, rootRunId: "claude:laptop:root-run", parentRunId: "claude:laptop:root-run/middle-agent" });
      expect(landed?.file.path).toBe(path);
    }
  });

  it("refuses malformed identifiers, numeric facts, and child edges before writes", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.runs.internalIngest, ingest(run({ runId: "not-a-run" })) as never)).toEqual({ ok: false, reason: "invalid run record" });
    expect(await t.mutation(internal.runs.internalIngest, ingest(run({ startedAt: -1 })) as never)).toEqual({ ok: false, reason: "invalid run record" });
    expect(await t.mutation(internal.runs.internalIngest, ingest(run(), [], [child("claude:laptop:child-run", "claude:laptop:not-root", "claude:laptop:root-run", 1)]) as never)).toEqual({ ok: false, reason: "invalid child edge" });
    expect(await t.run((ctx) => ctx.db.query("runs").collect())).toEqual([]);
  });

  it("takes a Workflow's agent as an ordinary child with no spawning tool-use id", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, ingest(run()) as never);
    // The Workflow sidecar carries no toolUseId, so the link is honestly
    // unknown; the workflow it belongs to is on the run's context instead.
    const agent = run({
      runId: "claude:laptop:root-run/a27aa4b9a7caecc56", parentRunId: "claude:laptop:root-run", depth: 1, linkKnown: false,
      kind: "subagent", origin: "workflow",
      context: { layersKnown: false, layersGiven: [], layersDenied: [], skillsOffered: [], skillsUsed: [], tools: [], hooks: [], workflowId: "wf_abc" },
    });
    expect(await t.mutation(internal.runs.internalIngest, ingest(agent, [row(0, { depth: 1 })]) as never)).toMatchObject({ ok: true });
    const stored = await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:laptop:root-run/a27aa4b9a7caecc56")).unique());
    expect(stored).toMatchObject({ depth: 1, parentRunId: "claude:laptop:root-run", origin: "workflow", linkKnown: false });
    expect(stored?.spawnedByToolUseId).toBeUndefined();
    expect(stored?.context?.workflowId).toBe("wf_abc");
  });

  it("stores mode only for session runs", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.runs.internalIngest, ingest(run({ mode: "interactive" })) as never)).toMatchObject({ ok: true });
    const autonomous = run({ runId: "claude:laptop:auto-session", rootRunId: "claude:laptop:auto-session", mode: "autonomous" });
    expect(await t.mutation(internal.runs.internalIngest, ingest(autonomous) as never)).toMatchObject({ ok: true });
    const worker = run({ runId: "claude:laptop:worker-run", rootRunId: "claude:laptop:worker-run", kind: "worker", mode: "interactive" });
    expect(await t.mutation(internal.runs.internalIngest, ingest(worker) as never)).toEqual({ ok: false, reason: "invalid run record" });
  });

  it("keeps chunks immutable and stamps only a complete, verified reassembly", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, ingest() as never);
    expect(await t.mutation(internal.runs.internalIngest, ingest(run(), [row(1, { overflow: { sha256: "a".repeat(64), byteLength: 1, chunkCount: 1 } })]) as never)).toEqual({ ok: false, reason: "overflow must be stamped separately" });
    expect(await t.mutation(internal.runs.internalStampOverflow, { runId: "claude:laptop:root-run", seq: 0, sha256: HELLO_WORLD_SHA256, byteLength: 11, chunkCount: 2 })).toEqual({ ok: false, reason: "chunks incomplete" });
    expect(await t.mutation(internal.runs.internalIngestOverflow, { runId: "claude:laptop:root-run", seq: 0, index: 1, chunkCount: 2, text: "world" })).toEqual({ ok: true, index: 1 });
    expect(await t.mutation(internal.runs.internalStampOverflow, { runId: "claude:laptop:root-run", seq: 0, sha256: HELLO_WORLD_SHA256, byteLength: 11, chunkCount: 2 })).toEqual({ ok: false, reason: "chunks incomplete" });
    expect(await t.mutation(internal.runs.internalIngestOverflow, { runId: "claude:laptop:root-run", seq: 0, index: 0, chunkCount: 2, text: "hello " })).toEqual({ ok: true, index: 0 });
    expect(await t.mutation(internal.runs.internalIngestOverflow, { runId: "claude:laptop:root-run", seq: 0, index: 0, chunkCount: 2, text: "different" })).toEqual({ ok: false, reason: "chunk already written" });
    expect(await t.mutation(internal.runs.internalStampOverflow, { runId: "claude:laptop:root-run", seq: 0, sha256: "a".repeat(64), byteLength: 11, chunkCount: 2 })).toEqual({ ok: false, reason: "chunk integrity mismatch" });
    expect(await t.mutation(internal.runs.internalStampOverflow, { runId: "claude:laptop:root-run", seq: 0, sha256: HELLO_WORLD_SHA256, byteLength: 11, chunkCount: 2 })).toEqual({ ok: true, stamped: true });
    expect(await t.mutation(internal.runs.internalIngestOverflow, { runId: "claude:laptop:root-run", seq: 0, index: 0, chunkCount: 2, text: "hello " })).toEqual({ ok: false, reason: "row already stamped" });
    const viewer = await withTom(t);
    expect((await viewer.query(api.runs.rows, { runId: "claude:laptop:root-run", paginationOpts: { cursor: null, numItems: 1 } })).page[0]).toMatchObject({ hasOverflow: true, fullByteLength: 11 });
  });

  for (const runner of ["claude", "codex"] as const) {
    it(`derives a three-level ${runner} tree parent-first`, async () => {
      const t = convexTest(schema, modules);
      const parent = `${runner}:laptop:parent-run`;
      const first = `${runner}:laptop:first-child`;
      const second = `${runner}:laptop:second-child`;
      const parentRun = run({ runId: parent, rootRunId: parent, runner, kind: runner === "claude" ? "session" : "unknown" });
      expect(await t.mutation(internal.runs.internalIngest, ingest(parentRun, [], [child(first, parent, parent, 1, runner === "claude")]) as never)).toMatchObject({ ok: true });
      const firstRun = run({ runId: first, parentRunId: parent, rootRunId: parent, depth: 1, runner, kind: runner === "claude" ? "subagent" : "codex-child", linkKnown: runner === "claude", ...(runner === "claude" ? { spawnedByToolUseId: "exact-tool-use" } : {}) });
      const firstResponse = await t.mutation(internal.runs.internalIngest, ingest(firstRun, [row(0, { depth: 1 })], [child(second, first, parent, 2, runner === "claude")]) as never);
      expect(firstResponse, JSON.stringify(firstResponse)).toMatchObject({ ok: true });
      const secondRun = run({ runId: second, parentRunId: first, rootRunId: parent, depth: 2, runner, kind: runner === "claude" ? "subagent" : "codex-child", linkKnown: runner === "claude", ...(runner === "claude" ? { spawnedByToolUseId: "exact-tool-use" } : {}) });
      expect(await t.mutation(internal.runs.internalIngest, ingest(secondRun, [row(0, { depth: 2 })]) as never)).toMatchObject({ ok: true });
      const tree = await t.run((ctx) => ctx.db.query("runs").withIndex("by_root_depth", (q) => q.eq("rootRunId", parent)).collect());
      expect(tree.map((entry) => [entry.runId, entry.depth])).toEqual(expect.arrayContaining([[parent, 0], [first, 1], [second, 2]]));
    });

    it(`repairs a three-level ${runner} tree when children arrive first`, async () => {
      const t = convexTest(schema, modules);
      const parent = `${runner}:laptop:parent-run`;
      const first = `${runner}:laptop:first-child`;
      const second = `${runner}:laptop:second-child`;
      const secondRun = run({ runId: second, parentRunId: first, rootRunId: first, depth: 1, runner, kind: runner === "claude" ? "subagent" : "codex-child", linkKnown: runner === "claude", ...(runner === "claude" ? { spawnedByToolUseId: "exact-tool-use" } : {}) });
      expect(await t.mutation(internal.runs.internalIngest, ingest(secondRun, [row(0, { depth: 1 })]) as never)).toMatchObject({ ok: true });
      const firstRun = run({ runId: first, parentRunId: parent, rootRunId: parent, depth: 1, runner, kind: runner === "claude" ? "subagent" : "codex-child", linkKnown: runner === "claude", ...(runner === "claude" ? { spawnedByToolUseId: "exact-tool-use" } : {}) });
      expect(await t.mutation(internal.runs.internalIngest, ingest(firstRun, [row(0, { depth: 1 })]) as never)).toMatchObject({ ok: true });
      const parentRun = run({ runId: parent, rootRunId: parent, runner, kind: runner === "claude" ? "session" : "unknown" });
      expect(await t.mutation(internal.runs.internalIngest, ingest(parentRun, []) as never)).toMatchObject({ ok: true });
      const tree = await t.run((ctx) => ctx.db.query("runs").withIndex("by_root_depth", (q) => q.eq("rootRunId", parent)).collect());
      expect(tree.map((entry) => [entry.runId, entry.depth])).toEqual(expect.arrayContaining([[parent, 0], [first, 1], [second, 2]]));
    });
  }

  it("pages children with an explicit bounded cursor contract", async () => {
    const t = convexTest(schema, modules);
    const parent = "claude:laptop:parent-run";
    await t.mutation(internal.runs.internalIngest, ingest(run({ runId: parent, rootRunId: parent }), [], [
      child("claude:laptop:child-one", parent, parent, 1),
      child("claude:laptop:child-two", parent, parent, 1),
    ]) as never);
    const viewer = await withTom(t);
    const first = await viewer.query(api.runs.children, { runId: parent, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await viewer.query(api.runs.children, { runId: parent, limit: 1, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    await expect(viewer.query(api.runs.children, { runId: parent, limit: 501 })).rejects.toThrow();
  });

  it("denies every public reader without Tom identity", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, ingest() as never);
    const stranger = t.withIdentity({ subject: "someone-else" });
    await expect(stranger.query(api.runs.get, { runId: "claude:laptop:root-run" })).rejects.toThrow();
    await expect(stranger.query(api.runs.children, { runId: "claude:laptop:root-run" })).rejects.toThrow();
    await expect(stranger.query(api.runs.rows, { runId: "claude:laptop:root-run", paginationOpts: { cursor: null, numItems: 1 } })).rejects.toThrow();
    await expect(stranger.query(api.runs.entry, { runId: "claude:laptop:root-run", seq: 0 })).rejects.toThrow();
  });

  it("pages the idempotent legacy-session backfill only within 1..500", async () => {
    const t = convexTest(schema, modules);
    const owner = await withTom(t);
    const first = await owner.mutation(api.claudeSessions.createSession, { title: "one", kind: "adhoc", repo: "none", initialPrompt: "one" });
    const second = await owner.mutation(api.claudeSessions.createSession, { title: "two", kind: "adhoc", repo: "none", initialPrompt: "two" });
    await t.run(async (ctx) => { await ctx.db.patch(first, { sdkSessionId: "first-sdk" }); await ctx.db.patch(second, { sdkSessionId: "short" }); });
    expect((await t.mutation(internal.runs.internalBackfillRunIds, { limit: 1 })).patched).toBe(1);
    expect((await t.run(async (ctx) => ctx.db.get(first)))?.runId).toBe("claude:box:first-sdk");
    expect((await t.run(async (ctx) => ctx.db.get(second)))?.runId).toBeUndefined();
    await expect(t.mutation(internal.runs.internalBackfillRunIds, { limit: 0 })).rejects.toThrow();
    await expect(t.mutation(internal.runs.internalBackfillRunIds, { limit: 501 })).rejects.toThrow();
  });

  it("switches getMessages from daemon rows to the same run-row page shape", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await session(t, { status: "running" });
    const stamp = { sha256: "a".repeat(64), byteLength: 20, chunkCount: 1 };
    await daemonRow(t, sessionId, 0, "user", { text: "hello" });
    await daemonRow(t, sessionId, 1, "assistant-text", { text: "answer" }, stamp);
    const value = run({ sessionId });
    await t.mutation(internal.runs.internalIngest, ingest(value, [
      row(0, { kind: "user", content: { text: "hello" } }),
      row(1, { kind: "assistant-text", content: { text: "answer" }, digest: "1111111111111111" }),
    ], []) as never);
    // The overflow stamp itself is verified elsewhere (chunk reassembly); here
    // it only needs to exist so the two page shapes can be compared.
    await t.run(async (ctx) => {
      const inserted = await ctx.db.query("claudeMessages").withIndex("by_run_seq", (q) => q.eq("runId", value.runId).eq("seq", 1)).unique();
      if (inserted) await ctx.db.patch(inserted._id, { overflow: stamp });
    });
    const tom = await withTom(t);
    const pick = (page: Array<Record<string, unknown>>) => page.map(({ seq, kind, content, hasOverflow, fullByteLength }) => ({ seq, kind, content, hasOverflow, fullByteLength }));
    const before = await tom.query(api.claudeSessions.getMessages, { sessionId, paginationOpts: { cursor: null, numItems: 10 } });
    await t.mutation(internal.claudeSessions.internalIngest, { sessionId, runId: "different-run-must-not-replace-the-link", rowsFromFiles: true });
    const after = await tom.query(api.claudeSessions.getMessages, { sessionId, paginationOpts: { cursor: null, numItems: 10 } });
    expect(pick(after.page as never)).toEqual(pick(before.page as never));
    expect(after.page.map((entry) => entry.seq)).toEqual([1, 0]);
    expect(await t.run((ctx) => ctx.db.get(sessionId))).toMatchObject({ runId: value.runId, rowsFrom: "runs" });
  });

  it("fails closed when a run-backed session has no run id", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await session(t, { rowsFrom: "runs" });
    await daemonRow(t, sessionId, 0, "user", { text: "must not leak through fallback" });
    const tom = await withTom(t);
    await expect(tom.query(api.claudeSessions.getMessages, {
      sessionId,
      paginationOpts: { cursor: null, numItems: 10 },
    })).rejects.toThrow("run-backed session has no runId");
  });

  it("repairs a box session link from the Claude root id", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await session(t, { sdkSessionId: "sdk-root", status: "running" });
    const result = await t.mutation(internal.runs.internalIngest, ingest(
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

  it("compares row sets without recording text and cuts over a clean terminal run", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await session(t);
    const text = "comparison-text-sentinel";
    await daemonRow(t, sessionId, 0, "user", { text: `${text}   ` });
    await daemonRow(t, sessionId, 1, "assistant-text", { text: "answer" });
    await daemonRow(t, sessionId, 2, "thinking", { text: "reasoning" });
    await daemonRow(t, sessionId, 3, "tool-call", { toolName: "Read" });
    await t.mutation(internal.runs.internalIngest, ingest(run({
        sessionId, status: "ended", envelopeKey: "runs/registration.json.gz",
        context: {
          layersKnown: true, layersGiven: ["write"], layersDenied: [], skillsOffered: [], skillsUsed: [], tools: [], hooks: [],
          registered: true, launcher: "worker/jobs/evals.mjs", modelRequested: "claude-fable-5", skillsGranted: [], skillsRefused: [], promptSha256: "prompt", writingStandardSource: "/tts/capture-context",
        },
      }), [
        row(0, { kind: "context", content: { modelRequested: "claude-fable-5" } }),
        row(1000, { kind: "user", content: { text }, digest: "1111111111111111" }),
        row(1500, { kind: "child-run", content: { childRunId: "claude:laptop:root-run/child" }, digest: "2222222222222222" }),
        row(2000, { kind: "assistant-text", content: { text: "answer" }, digest: "3333333333333333" }),
        row(3000, { kind: "thinking", content: { text: "reasoning" }, digest: "4444444444444444" }),
        row(4000, { kind: "tool-call", content: { name: "Read" }, digest: "5555555555555555" }),
      ], []) as never);

    const eligible = await t.query(internal.runs.internalEligibleComparisons, { status: "ended", paginationOpts: { cursor: null, numItems: 100 } });
    expect(eligible.eligible).toContainEqual({ sessionId, runId: "claude:laptop:root-run" });
    const comparison = await t.mutation(internal.runs.internalShadowCompare, { sessionId });
    expect(comparison).toMatchObject({
      runId: "claude:laptop:root-run", daemonRows: 4, fileRows: 4,
      byKind: { user: { daemon: 1, file: 1 }, "assistant-text": { daemon: 1, file: 1 }, thinking: { daemon: 1, file: 1 }, "tool-call": { daemon: 1, file: 1 } },
      textRows: 3, textMatches: 3, clean: true,
    });
    expect(comparison).not.toHaveProperty("firstDiffSeq");
    const [storedRun, storedSession, comparisonEvent] = await t.run(async (ctx) => [
      await ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:laptop:root-run")).unique(),
      await ctx.db.get(sessionId),
      await ctx.db.query("dtsEvents").withIndex("by_kind_at", (q) => q.eq("kind", "runs-shadow-compare")).first(),
    ]);
    expect(storedRun?.cutoverAt).toEqual(expect.any(Number));
    expect(storedSession?.rowsFrom).toBe("runs");
    expect(JSON.stringify(comparisonEvent?.data)).not.toContain(text);
    const after = await t.query(internal.runs.internalEligibleComparisons, { status: "ended", paginationOpts: { cursor: null, numItems: 100 } });
    expect(after.eligible).not.toContainEqual(expect.objectContaining({ sessionId }));
  });

  it("reports row-count and text differences at the file row without cutting over", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await session(t);
    await daemonRow(t, sessionId, 0, "user", { text: "daemon text" });
    await daemonRow(t, sessionId, 1, "system", { text: "extra" });
    await t.mutation(internal.runs.internalIngest, ingest(
      run({ sessionId, status: "failed" }),
      [row(1000, { kind: "user", content: { text: "file text" }, digest: "1111111111111111" })],
      [],
    ) as never);
    const comparison = await t.mutation(internal.runs.internalShadowCompare, { sessionId });
    expect(comparison).toMatchObject({
      daemonRows: 2, fileRows: 1, textRows: 1, textMatches: 0,
      firstDiffSeq: 1000, clean: false,
      byKind: { system: { daemon: 1, file: 0 }, user: { daemon: 1, file: 1 } },
    });
    expect((await t.run((ctx) => ctx.db.get(sessionId)))?.rowsFrom).toBeUndefined();
  });

  it("continues past 100 rows and never truncates a late mismatch to clean", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await session(t);
    for (let seq = 0; seq < 101; seq += 1) await daemonRow(t, sessionId, seq, "user", { text: `row-${seq}` });
    await t.mutation(internal.runs.internalIngest, ingest(
      run({ sessionId, status: "ended" }),
      Array.from({ length: 101 }, (_, seq) => row(seq, {
        kind: "user",
        content: { text: seq === 100 ? "late-mismatch" : `row-${seq}` },
        digest: seq.toString(16).padStart(16, "0"),
      })),
      [],
    ) as never);
    const first = await t.mutation(internal.runs.internalShadowCompare, { sessionId });
    expect(first).toMatchObject({ complete: false, daemonRows: 100, fileRows: 100 });
    if (first.complete) throw new Error("comparison unexpectedly completed on its first page");
    expect(await t.run((ctx) => ctx.db.query("dtsEvents").withIndex("by_kind_at", (q) => q.eq("kind", "runs-shadow-compare")).collect())).toEqual([]);
    const final = await t.mutation(internal.runs.internalShadowCompare, { sessionId, state: first.state } as never);
    expect(final).toMatchObject({ complete: true, daemonRows: 101, fileRows: 101, textRows: 101, textMatches: 100, firstDiffSeq: 100, clean: false });
    expect((await t.run((ctx) => ctx.db.get(sessionId)))?.rowsFrom).toBeUndefined();
  });

  // The defect this covers: the comparison used to call `.paginate()` on both
  // indexes inside one mutation, which the Convex backend refuses (one
  // paginated query per function), so /runs/compare answered 400 for every
  // session. convex-test does not enforce that limit, so what this asserts is
  // the shape that replaced it: bounded `.take()` reads over a seq floor that
  // still walk three pages a side to a complete, clean verdict.
  it("walks a 250-row session to completion over bounded reads", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await session(t);
    for (let seq = 0; seq < 250; seq += 1) await daemonRow(t, sessionId, seq, "user", { text: `row-${seq}` });
    // The run row comes through the ingest door; its 250 file rows are written
    // directly because one ingest call accepts at most 200 (`too many rows`),
    // and what is under test is the read side, not the append fence.
    expect(await t.mutation(internal.runs.internalIngest, ingest(
      run({ sessionId, status: "ended" }), [], [],
    ) as never)).toMatchObject({ ok: true });
    await t.run(async (ctx) => {
      for (let seq = 0; seq < 250; seq += 1) await ctx.db.insert("claudeMessages", {
        runId: "claude:laptop:root-run", seq, turn: 0, kind: "user", content: { text: `row-${seq}` },
        digest: seq.toString(16).padStart(16, "0"), depth: 0, createdAt: seq + 1,
      } as never);
    });

    let state: unknown;
    let result: Awaited<ReturnType<typeof t.mutation>> | undefined;
    for (let call = 0; call < 20; call += 1) {
      result = await t.mutation(internal.runs.internalShadowCompare, {
        sessionId,
        ...(state === undefined ? {} : { state }),
      } as never);
      if (result.complete) break;
      state = result.state;
    }
    expect(result).toMatchObject({
      complete: true, daemonRows: 250, fileRows: 250, textRows: 250, textMatches: 250, clean: true,
      byKind: { user: { daemon: 250, file: 250 } },
    });
    expect(result).not.toHaveProperty("firstDiffSeq");
    expect((await t.run((ctx) => ctx.db.get(sessionId)))?.rowsFrom).toBe("runs");
  });

  it("admits only terminal run rows and does not suppress their later transition", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await session(t);
    await t.mutation(internal.runs.internalIngest, ingest(run({ sessionId }), [], []) as never);
    const unknown = await t.query(internal.runs.internalEligibleComparisons, { status: "ended", paginationOpts: { cursor: null, numItems: 100 } });
    expect(unknown.eligible).toEqual([]);
    await expect(t.mutation(internal.runs.internalShadowCompare, { sessionId })).rejects.toThrow("run is not terminal");
    await t.mutation(internal.runs.internalIngest, retry(run({ sessionId, status: "ended" }), [], []) as never);
    const terminal = await t.query(internal.runs.internalEligibleComparisons, { status: "ended", paginationOpts: { cursor: null, numItems: 100 } });
    expect(terminal.eligible).toEqual([{ sessionId, runId: "claude:laptop:root-run" }]);
  });

  it("paginates terminal candidates beyond the first 100 sessions", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let index = 0; index < 101; index += 1) {
        const runId = `claude:laptop:candidate-${index.toString().padStart(3, "0")}`;
        const sessionId = await ctx.db.insert("claudeSessions", {
          title: runId, kind: "adhoc", repo: "none", status: "ended",
          statusChangedAt: Date.now(), nextSeq: 0, createdAt: Date.now(), runId,
        } as never);
        await ctx.db.insert("runs", { ...run({ runId, rootRunId: runId, sessionId, status: "ended" }), ingestedAt: Date.now() } as never);
      }
    });
    const first = await t.query(internal.runs.internalEligibleComparisons, { status: "ended", paginationOpts: { cursor: null, numItems: 100 } });
    expect(first).toMatchObject({ isDone: false });
    expect(first.eligible).toHaveLength(100);
    const second = await t.query(internal.runs.internalEligibleComparisons, { status: "ended", paginationOpts: { cursor: first.continueCursor, numItems: 100 } });
    expect(second).toMatchObject({ isDone: true });
    expect(second.eligible).toHaveLength(1);
  });

  it("accepts abandoned lifecycle state and emits paged manifest entries", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, ingest(run({
        origin: "job", status: "abandoned", abandonedAt: 123,
        envelopeKey: "runs/claude/laptop/root/registration-hash.json.gz",
        file: { ...run().file, storeKey: "runs/claude/laptop/root/stored.jsonl.gz" },
      }), [], []) as never);
    const stored = await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:laptop:root-run")).unique());
    expect(stored).toMatchObject({ status: "abandoned", abandonedAt: 123, origin: "job" });
    const manifest = await t.query(internal.runs.internalManifest, { since: 0 });
    expect(manifest.entries).toEqual([expect.objectContaining({
      run_id: "claude:laptop:root-run", thread_id: "root-run", file_version: STORED_HASH,
      store_key: "runs/claude/laptop/root/stored.jsonl.gz", parent_run_id: null,
    })]);
    expect((await t.query(internal.runs.internalManifest, { since: manifest.entries[0].at, afterRunId: manifest.entries[0].run_id, afterFileVersion: manifest.entries[0].file_version })).entries).toEqual([]);
    await t.mutation(internal.runs.internalIngest, retry(run({ status: "ended" }), [], []) as never);
    expect((await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:laptop:root-run")).unique()))?.status).toBe("ended");
  });

  it("manifests each file version once across retries and equal timestamps", async () => {
    const t = convexTest(schema, modules);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const firstRun = run({ file: { ...run().file, storedHash: VERSION_A_HASH, storeKey: "runs/a.jsonl.gz" } });
      await t.mutation(internal.runs.internalIngest, ingest(firstRun, [], []) as never);
      const secondRun = run({ file: { ...run().file, storedHash: VERSION_B_HASH, storeKey: "runs/b.jsonl.gz", bytes: 20, committedLine: 2, committedPrefixSha256: GROWN_PREFIX_HASH } });
      const secondInput = retry(secondRun, [], []);
      await t.mutation(internal.runs.internalIngest, secondInput as never);
      await t.mutation(internal.runs.internalIngest, secondInput as never);
      const versions = await t.run((ctx) => ctx.db.query("runFileVersions").collect());
      expect(versions.map((version) => version.fileVersion).sort()).toEqual([VERSION_A_HASH, VERSION_B_HASH]);
      const manifest = await t.query(internal.runs.internalManifest, { since: 0 });
      expect(manifest.entries.map((entry) => entry.file_version)).toEqual([VERSION_A_HASH, VERSION_B_HASH]);
      const resumed = await t.query(internal.runs.internalManifest, {
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
  return await t.run((ctx) => ctx.db.query("dtsEvents").withIndex("by_kind_at", (q) => q.eq("kind", "runs-evicted")).collect());
}

describe("runs: materialize requests", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a run with no store key, and every caller who is not Tom", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, ingest() as never);
    const tom = await withTom(t);
    await expect(tom.mutation(api.runs.requestMaterialize, { runId: "claude:laptop:root-run" })).rejects.toThrow("run has no store key");
    await expect(tom.mutation(api.runs.requestMaterialize, { runId: "claude:laptop:absent-run" })).rejects.toThrow("run not found");
    await expect(tom.mutation(api.runs.requestMaterialize, { runId: "not-a-run" })).rejects.toThrow("invalid runId");
    expect(await requests(t)).toEqual([]);
    const stranger = t.withIdentity({ subject: "someone-else" });
    await expect(stranger.mutation(api.runs.requestMaterialize, { runId: "claude:laptop:root-run" })).rejects.toThrow();
    await expect(stranger.query(api.runs.materializeStatus, { runId: "claude:laptop:root-run" })).rejects.toThrow();
    await expect(stranger.mutation(api.runs.markOpened, { runId: "claude:laptop:root-run" })).rejects.toThrow();
  });

  it("queues one request while it is pending and a fresh one once it is answered", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, backlogIngest() as never);
    const tom = await withTom(t);
    const first = await tom.mutation(api.runs.requestMaterialize, { runId: "claude:laptop:root-run" });
    const second = await tom.mutation(api.runs.requestMaterialize, { runId: "claude:laptop:root-run" });
    expect(second?._id).toBe(first?._id);
    expect(await requests(t)).toHaveLength(1);
    expect(first).toMatchObject({ status: "pending", requestedBy: "tom", slice: 1 });
    expect(await tom.query(api.runs.materializeStatus, { runId: "claude:laptop:root-run" })).toMatchObject({ _id: first?._id });

    await t.mutation(internal.runs.internalAnswerMaterialize, { requestId: first!._id, status: "failed", reason: "store unreachable" });
    const third = await tom.mutation(api.runs.requestMaterialize, { runId: "claude:laptop:root-run" });
    expect(third?._id).not.toBe(first?._id);
    expect(await requests(t)).toHaveLength(2);
    // The status query reads the newest, which is the one the page waits on.
    expect(await tom.query(api.runs.materializeStatus, { runId: "claude:laptop:root-run" })).toMatchObject({ _id: third?._id, status: "pending" });
    expect(await tom.query(api.runs.materializeStatus, { runId: "claude:laptop:other-run" })).toBeNull();
  });

  it("hands the box the oldest pending request, answerable even when its run is gone", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, backlogIngest() as never);
    const orphan = await t.run((ctx) => ctx.db.insert("runMaterializeRequests", { runId: "codex:box:vanished-thread", requestedBy: "worker", requestedAt: 1, status: "pending", slice: 1 }));
    const tom = await withTom(t);
    await tom.mutation(api.runs.requestMaterialize, { runId: "claude:laptop:root-run" });

    const oldest = await t.query(internal.runs.internalNextMaterialize, {});
    expect(oldest.request).toMatchObject({
      requestId: orphan, runId: "codex:box:vanished-thread", runner: "codex", host: "box",
      threadId: "vanished-thread", depth: 0, parentRunId: null, hasRows: false, fromLine: 0,
      file: { storeKey: null, sidecarStoredHash: null, totalLines: null },
    });
    await t.mutation(internal.runs.internalAnswerMaterialize, { requestId: orphan, status: "failed", reason: "run is gone" });

    // A backlog run has no rows, so the parse starts at line 0.
    const backlog = await t.query(internal.runs.internalNextMaterialize, {});
    expect(backlog.request).toMatchObject({
      runId: "claude:laptop:root-run", runner: "claude", host: "laptop", threadId: "root-run",
      hasRows: false, fromLine: 0, file: { storeKey: STORE_KEY, totalLines: 4000, committedLine: 0 },
    });

    // A continuation resumes from the lines already in the record.
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:laptop:root-run")).unique();
      if (stored) await ctx.db.patch(stored._id, { file: { ...stored.file, committedLine: 2000, committedPrefixSha256: PREFIX_HASH } });
      await ctx.db.insert("claudeMessages", { runId: "claude:laptop:root-run", seq: 0, turn: 0, kind: "user", content: { text: "x" }, digest: "0123456789abcdef", depth: 0, createdAt: 1 });
    });
    const continued = await t.query(internal.runs.internalNextMaterialize, {});
    expect(continued.request).toMatchObject({ hasRows: true, fromLine: 2000 });
  });

  it("records what the box answered and continues the run itself, once", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, backlogIngest() as never);
    const tom = await withTom(t);
    const first = await tom.mutation(api.runs.requestMaterialize, { runId: "claude:laptop:root-run" });
    const rowsSource = { from: "store" as const, at: 10, parserVersion: "runs-parser-1", storeKey: STORE_KEY, rowsFromLine: 0, rowsToLine: 2000, slices: 1, droppedLines: 3, partial: ["unknown-line-types"] };

    expect(await t.mutation(internal.runs.internalAnswerMaterialize, { requestId: first!._id, status: "served", reason: "a".repeat(201) })).toEqual({ ok: false, reason: "reason too long" });
    expect(await t.mutation(internal.runs.internalAnswerMaterialize, { requestId: first!._id, status: "failed", reason: "the bucket said no" })).toEqual({ ok: false, reason: "reason outside the closed vocabulary" });
    expect(await t.mutation(internal.runs.internalAnswerMaterialize, { requestId: first!._id, status: "served", rowsSource: { ...rowsSource, partial: ["everything-is-fine"] } })).toEqual({ ok: false, reason: "partial outside the closed vocabulary" });
    expect((await requests(t))[0].status).toBe("pending");

    expect(await t.mutation(internal.runs.internalAnswerMaterialize, { requestId: first!._id, status: "served", rowsIngested: 2000, fromLine: 0, toLine: 2000, totalLines: 4000, rowsSource })).toEqual({ ok: true, alreadyAnswered: false, continuation: true });
    const stored = await runRow(t, "claude:laptop:root-run");
    expect(stored?.rowsSource).toMatchObject({ from: "store", rowsFromLine: 0, rowsToLine: 2000, droppedLines: 3, partial: ["unknown-line-types"] });
    expect(stored?.file.totalLines).toBe(4000);
    const queued = await requests(t, "claude:laptop:root-run");
    expect(queued.filter((request) => request.status === "pending")).toHaveLength(1);
    expect(queued.find((request) => request.status === "pending")).toMatchObject({ slice: 2, requestedBy: "tom" });
    expect(queued.find((request) => request.status === "served")).toMatchObject({ rowsIngested: 2000, fromLine: 0, toLine: 2000 });

    // The same answer again queues nothing further.
    expect(await t.mutation(internal.runs.internalAnswerMaterialize, { requestId: first!._id, status: "served", toLine: 2000, totalLines: 4000 })).toEqual({ ok: true, alreadyAnswered: true, continuation: false });
    expect(await requests(t, "claude:laptop:root-run")).toHaveLength(2);
  });

  it("stops at the fifth slice and says the cap was reached", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, backlogIngest() as never);
    const last = await t.run((ctx) => ctx.db.insert("runMaterializeRequests", { runId: "claude:laptop:root-run", requestedBy: "tom", requestedAt: 5, status: "pending", slice: 5 }));
    const answer = await t.mutation(internal.runs.internalAnswerMaterialize, {
      requestId: last, status: "served", rowsIngested: 100, fromLine: 3000, toLine: 3900, totalLines: 4000,
      rowsSource: { from: "store", at: 20, parserVersion: "runs-parser-1", storeKey: STORE_KEY, rowsFromLine: 3000, rowsToLine: 3900, slices: 5, droppedLines: 0, partial: [] },
    });
    expect(answer).toEqual({ ok: true, alreadyAnswered: false, continuation: false });
    expect((await runRow(t, "claude:laptop:root-run"))?.rowsSource?.partial).toEqual(["row-cap-reached"]);
    expect((await requests(t, "claude:laptop:root-run")).filter((request) => request.status === "pending")).toEqual([]);
  });
});

describe("runs: the row window", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("gives an index-only backlog row no window at all, and a row-bearing ingest one", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, backlogIngest() as never);
    expect((await runRow(t, "claude:laptop:root-run"))?.rowsUntil).toBeUndefined();

    const grown = convexTest(schema, modules);
    await grown.mutation(internal.runs.internalIngest, ingest() as never);
    expect((await runRow(grown, "claude:laptop:root-run"))?.rowsUntil).toBe(2 + WINDOW_MS);
    // A no-op ingest of the same file writes nothing; a later line moves it.
    await grown.mutation(internal.runs.internalIngest, retry(run(), []) as never);
    expect((await runRow(grown, "claude:laptop:root-run"))?.rowsUntil).toBe(2 + WINDOW_MS);
    await grown.mutation(internal.runs.internalIngest, retry(run({ lastLineAt: 5000 }), []) as never);
    expect((await runRow(grown, "claude:laptop:root-run"))?.rowsUntil).toBe(5000 + WINDOW_MS);
  });

  it("moves the window on an opened run only past the one-day threshold", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, ingest() as never);
    await t.mutation(internal.runs.internalIngest, backlogIngest({ runId: "claude:laptop:index-only", rootRunId: "claude:laptop:index-only" }) as never);
    const tom = await withTom(t);

    expect(await tom.mutation(api.runs.markOpened, { runId: "claude:laptop:root-run" })).toEqual({ ok: true, moved: true });
    const moved = (await runRow(t, "claude:laptop:root-run"))?.rowsUntil;
    expect(moved).toBeGreaterThan(2 + WINDOW_MS);
    // Reading the same run again inside the day is not a second write.
    expect(await tom.mutation(api.runs.markOpened, { runId: "claude:laptop:root-run" })).toEqual({ ok: true, moved: false });
    expect((await runRow(t, "claude:laptop:root-run"))?.rowsUntil).toBe(moved);
    // Looking at an index-only run does not make it evictable.
    expect(await tom.mutation(api.runs.markOpened, { runId: "claude:laptop:index-only" })).toEqual({ ok: true, moved: false });
    expect((await runRow(t, "claude:laptop:index-only"))?.rowsUntil).toBeUndefined();
    expect(await tom.mutation(api.runs.markOpened, { runId: "claude:laptop:absent-run" })).toEqual({ ok: true, moved: false });
  });
});

describe("runs: eviction", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  async function seedEvictable(t: SchemaTest, now: number, rows = 450) {
    const runId = "claude:laptop:root-run";
    await t.run(async (ctx) => {
      const existing = await ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", runId)).unique();
      if (existing) await ctx.db.patch(existing._id, { rowsUntil: now - DAY_MS });
      else await ctx.db.insert("runs", { ...storedRun({ status: "ended", startedAt: now - 61 * DAY_MS, lastLineAt: now - 60 * DAY_MS }), ingestedAt: now, rowsUntil: now - DAY_MS } as never);
      for (let seq = 0; seq < rows; seq += 1) {
        const overflow = seq < 2 ? { sha256: "a".repeat(64), byteLength: 6, chunkCount: 2 } : undefined;
        await ctx.db.insert("claudeMessages", { runId, seq, turn: 0, kind: "user", content: { text: "x" }, digest: "0123456789abcdef", depth: 0, createdAt: seq + 1, overflow } as never);
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
    await t.mutation(internal.runs.internalEvictTick, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }

  it("evicts rows and their chunks exactly once, and leaves the index row standing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EVICTION_HOUR_UTC);
    vi.stubEnv("RUNS_EVICTION_ENABLED", "1");
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
    await t.mutation(internal.runs.internalIngest, retry(run({ status: "ended", lastLineAt: now - 60 * DAY_MS, file: { ...run().file, storeKey: STORE_KEY } }), [row(0)]) as never);
    expect((await transcript(t, runId)).rows).toBe(1);
    expect((await runRow(t, runId))?.rowsUntil).toBe(now - 60 * DAY_MS + WINDOW_MS);
    await tick(t);
    expect(await transcript(t, runId)).toEqual({ rows: 0, chunks: 0, labels: 1 });
    expect((await evictedEvents(t))[2].data).toMatchObject({ runs: 1, rowsDeleted: 1, overflowChunksDeleted: 0 });
  });

  it("refuses a running run, a live session's run, and a run inside the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EVICTION_HOUR_UTC);
    vi.stubEnv("RUNS_EVICTION_ENABLED", "1");
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
        await ctx.db.insert("runs", { ...storedRun({ ...record, rootRunId: record.runId, startedAt: 1 }), ingestedAt: now, rowsUntil: now - DAY_MS } as never);
        await ctx.db.insert("claudeMessages", { runId: record.runId, seq: 0, turn: 0, kind: "user", content: { text: "x" }, digest: "0123456789abcdef", depth: 0, createdAt: 1 } as never);
      }
    });

    await tick(t);
    for (const record of kept) {
      expect((await transcript(t, record.runId)).rows, record.runId).toBe(1);
      expect((await runRow(t, record.runId))?.rowsUntil, record.runId).toBe(now + DAY_MS);
    }
    expect((await evictedEvents(t))[0].data).toMatchObject({ runs: 0, rowsDeleted: 0, deferred: 3, truncated: false, oldestRowsUntil: now + DAY_MS });
  });

  it("deletes nothing while RUNS_EVICTION_ENABLED is unset, and says so", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EVICTION_HOUR_UTC);
    const t = convexTest(schema, modules);
    const runId = await seedEvictable(t, Date.now(), 3);
    expect(await t.mutation(internal.runs.internalEvictTick, {})).toEqual({ ok: true, disabled: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await transcript(t, runId)).rows).toBe(3);
    expect((await evictedEvents(t))[0].data).toMatchObject({ runs: 0, rowsDeleted: 0, deferred: 0, disabled: true });
    expect((await runRow(t, runId))?.rowsUntil).toBe(Date.now() - DAY_MS);
  });

  it("leaves the record alone outside the eviction hour", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 15, 20, 0));
    vi.stubEnv("RUNS_EVICTION_ENABLED", "1");
    const t = convexTest(schema, modules);
    const runId = await seedEvictable(t, Date.now(), 3);
    expect(await t.mutation(internal.runs.internalEvictTick, {})).toEqual({ ok: true, skipped: "not the eviction hour" });
    expect((await transcript(t, runId)).rows).toBe(3);
    expect(await evictedEvents(t)).toEqual([]);
  });
});

describe("runs.roots", () => {
  async function root(t: ReturnType<typeof convexTest>, runId: string, host: "laptop" | "box", startedAt: number) {
    expect(await t.mutation(internal.runs.internalIngest, ingest(run({ runId, rootRunId: runId, host, startedAt }), [], []) as never)).toMatchObject({ ok: true });
  }

  it("lists roots and never their children", async () => {
    const t = convexTest(schema, modules);
    const parent = "claude:laptop:root-run";
    await t.mutation(internal.runs.internalIngest, ingest(run(), [], [child("claude:laptop:child-run", parent, parent, 1)]) as never);
    const viewer = await withTom(t);
    expect((await viewer.query(api.runs.roots, {})).map((entry) => entry.runId)).toEqual([parent]);
  });

  it("merges both hosts newest first", async () => {
    const t = convexTest(schema, modules);
    await root(t, "claude:laptop:laptop-old", "laptop", 10);
    await root(t, "claude:box:box-newer", "box", 20);
    await root(t, "claude:laptop:laptop-new", "laptop", 30);
    await root(t, "claude:box:box-oldest", "box", 5);
    const viewer = await withTom(t);
    expect((await viewer.query(api.runs.roots, {})).map((entry) => entry.runId)).toEqual([
      "claude:laptop:laptop-new", "claude:box:box-newer", "claude:laptop:laptop-old", "claude:box:box-oldest",
    ]);
  });

  it("breaks a same-millisecond tie on runId", async () => {
    const t = convexTest(schema, modules);
    await root(t, "claude:laptop:tie-bravo", "laptop", 7);
    await root(t, "claude:box:tie-alpha", "box", 7);
    await root(t, "claude:laptop:tie-later", "laptop", 8);
    const viewer = await withTom(t);
    expect((await viewer.query(api.runs.roots, {})).map((entry) => entry.runId)).toEqual([
      "claude:laptop:tie-later", "claude:box:tie-alpha", "claude:laptop:tie-bravo",
    ]);
  });

  it("narrows to one host", async () => {
    const t = convexTest(schema, modules);
    await root(t, "claude:laptop:laptop-one", "laptop", 10);
    await root(t, "claude:box:box-run-one", "box", 20);
    const viewer = await withTom(t);
    expect((await viewer.query(api.runs.roots, { host: "box" })).map((entry) => entry.runId)).toEqual(["claude:box:box-run-one"]);
    expect((await viewer.query(api.runs.roots, { host: "laptop" })).map((entry) => entry.runId)).toEqual(["claude:laptop:laptop-one"]);
  });

  it("caps the merged result and refuses a limit outside 1..500", async () => {
    const t = convexTest(schema, modules);
    await root(t, "claude:laptop:laptop-old", "laptop", 10);
    await root(t, "claude:box:box-newest", "box", 30);
    await root(t, "claude:laptop:laptop-mid", "laptop", 20);
    const viewer = await withTom(t);
    expect((await viewer.query(api.runs.roots, { limit: 2 })).map((entry) => entry.runId)).toEqual([
      "claude:box:box-newest", "claude:laptop:laptop-mid",
    ]);
    await expect(viewer.query(api.runs.roots, { limit: 0 })).rejects.toThrow();
    await expect(viewer.query(api.runs.roots, { limit: 501 })).rejects.toThrow();
  });

  it("denies the reader without Tom identity", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, ingest() as never);
    const stranger = t.withIdentity({ subject: "someone-else" });
    await expect(stranger.query(api.runs.roots, {})).rejects.toThrow();
  });
});
