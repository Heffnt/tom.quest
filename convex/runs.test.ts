import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
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
