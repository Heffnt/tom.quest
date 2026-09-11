import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { MODEL_OF_TOM_HEADER } from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const SOURCE_HASH = "a".repeat(64);
const STORED_HASH = "b".repeat(64);
const PREFIX_HASH = "c".repeat(64);
const PREVIOUS_HASH = "d".repeat(64);
const GROWN_PREFIX_HASH = "e".repeat(64);
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

  it("refuses malformed identifiers, numeric facts, and child edges before writes", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.runs.internalIngest, ingest(run({ runId: "not-a-run" })) as never)).toEqual({ ok: false, reason: "invalid run record" });
    expect(await t.mutation(internal.runs.internalIngest, ingest(run({ startedAt: -1 })) as never)).toEqual({ ok: false, reason: "invalid run record" });
    expect(await t.mutation(internal.runs.internalIngest, ingest(run(), [], [child("claude:laptop:child-run", "claude:laptop:not-root", "claude:laptop:root-run", 1)]) as never)).toEqual({ ok: false, reason: "invalid child edge" });
    expect(await t.run((ctx) => ctx.db.query("runs").collect())).toEqual([]);
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
});
