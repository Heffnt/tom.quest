import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { MODEL_OF_TOM_HEADER } from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// Session creation fails closed when the model-of-tom publication singleton is
// absent (convex/ttsSkills.ts modelOfTomText), so a test that opens a session
// seeds it the way convex/claudeSessions.test.ts does.
const TEST_PRELUDE_LAYERS = { operate: "test operate layer", write: "test write layer", know: "test know layer" };
const TEST_PRELUDE_HEADERS = ([
  ["operate"], ["write"], ["know"], ["operate", "write"],
  ["operate", "know"], ["write", "know"], ["operate", "write", "know"],
] as const).map((names) => ({ layers: [...names], header: `${MODEL_OF_TOM_HEADER} (WikiTom commit testprelude): ${names.join(",")}` }));

async function withTom(t: ReturnType<typeof convexTest>) {
  const id = await t.run((ctx) => ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }));
  await t.run(async (ctx) => {
    if (await ctx.db.query("modelOfTomPublication").first()) return;
    await ctx.db.insert("modelOfTomPublication", {
      key: "current", commit: "testprelude", committedAt: 1, pushed: true,
      ...TEST_PRELUDE_LAYERS, headers: TEST_PRELUDE_HEADERS,
    });
  });
  return t.withIdentity({ subject: id });
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    runId: "claude:laptop:root", rootRunId: "claude:laptop:root", depth: 0, linkKnown: true,
    origin: "unknown", host: "laptop", runner: "claude", parserVersion: "runs-parser-1", kind: "session", status: "unknown", startedAt: 1, lastLineAt: 2,
    file: { path: "C:/root.jsonl", sourceHash: "source", storedHash: "stored", bytes: 10, storedBytes: 8, committedLine: 1, committedPrefixSha256: "prefix" },
    ...overrides,
  };
}
function row(seq = 0, overrides: Record<string, unknown> = {}) {
  return { seq, turn: 0, kind: "context", content: { layersKnown: false }, provenance: { fileVersion: "stored", file: "C:/root.jsonl", lineStart: seq, lineEnd: seq, block: 0, parserVersion: "runs-parser-1", sourceKind: "system" }, digest: "0123456789abcdef", depth: 0, createdAt: seq + 1, ...overrides };
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
    const result = await t.mutation(internal.runs.internalIngest, { run: run(), rows: [row(0), row(1, { digest: "fedcba9876543210", kind: "assistant-text" })], children: [] } as never);
    expect(result).toMatchObject({ ok: true, inserted: 2, skipped: 0, committedLine: 1 });
    const tom = await withTom(t);
    expect((await tom.query(api.runs.get, { runId: "claude:laptop:root" }))?.runId).toBe("claude:laptop:root");
    const rows = await tom.query(api.runs.rows, { runId: "claude:laptop:root", paginationOpts: { cursor: null, numItems: 10 } });
    expect(rows.page.map((entry) => entry.seq)).toEqual([0, 1]);
    expect(await tom.query(api.runs.entry, { runId: "claude:laptop:root", seq: 1 })).toEqual({
      provenance: { fileVersion: "stored", file: "C:/root.jsonl", lineStart: 1, lineEnd: 1, block: 0, parserVersion: "runs-parser-1", sourceKind: "system" },
      content: { layersKnown: false }, overflow: undefined, digest: "fedcba9876543210",
    });
  });

  it("skips a retry and rejects a conflicting immutable entry", async () => {
    const t = convexTest(schema, modules);
    const input = { run: run(), rows: [row()], children: [] };
    await t.mutation(internal.runs.internalIngest, input as never);
    expect(await t.mutation(internal.runs.internalIngest, input as never)).toMatchObject({ ok: true, inserted: 0, skipped: 1 });
    expect(await t.mutation(internal.runs.internalIngest, { ...input, rows: [row(0, { digest: "aaaaaaaaaaaaaaaa" })] } as never)).toEqual({ ok: false, reason: "entry digest mismatch" });
    const landed = await t.run((ctx) => ctx.db.query("claudeMessages").withIndex("by_run_seq", (q) => q.eq("runId", "claude:laptop:root").eq("seq", 0)).unique());
    expect(landed).toMatchObject({ digest: "0123456789abcdef", content: { layersKnown: false } });
    const events = await t.run((ctx) => ctx.db.query("dtsEvents").collect());
    expect(events.some((event) => event.kind === "runs-entry-mismatch")).toBe(true);
  });

  it("preserves a child stub until the child file fills it", async () => {
    const t = convexTest(schema, modules);
    const childId = "claude:laptop:root/child";
    await t.mutation(internal.runs.internalIngest, { run: run(), rows: [], children: [{ runId: childId, parentRunId: "claude:laptop:root", rootRunId: "claude:laptop:root", depth: 1, linkKnown: true, spawnedByToolUseId: "tool" }] } as never);
    expect((await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", childId)).unique()))?.file.path).toBe("");
    await t.mutation(internal.runs.internalIngest, { run: run({ runId: childId, parentRunId: "claude:laptop:root", rootRunId: "claude:laptop:root", depth: 1, kind: "subagent", file: { path: "C:/child.jsonl", sourceHash: "child", storedHash: "child-stored", bytes: 5, storedBytes: 5, committedLine: 1, committedPrefixSha256: "child-prefix" } }), rows: [row(0, { provenance: { fileVersion: "child-stored", file: "C:/child.jsonl", lineStart: 0, lineEnd: 0, block: 0, parserVersion: "runs-parser-1", sourceKind: "system" }, depth: 1 })], children: [] } as never);
    expect((await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", childId)).unique()))?.file.path).toBe("C:/child.jsonl");
    await t.mutation(internal.runs.internalIngest, { run: run(), rows: [], children: [{ runId: childId, parentRunId: "claude:laptop:root", rootRunId: "claude:laptop:root", depth: 1, linkKnown: true, spawnedByToolUseId: "different-tool" }] } as never);
    expect((await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", childId)).unique()))?.file.path).toBe("C:/child.jsonl");
  });

  it("refuses cycles, shrinks, and rewritten committed prefixes", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, { run: run(), rows: [row()], children: [] } as never);
    expect(await t.mutation(internal.runs.internalIngest, { run: run({ parentRunId: "claude:laptop:root" }), rows: [], children: [] } as never)).toEqual({ ok: false, reason: "parent cycle" });
    expect(await t.mutation(internal.runs.internalIngest, { run: run({ file: { ...run().file, bytes: 9 } }), rows: [], children: [] } as never)).toEqual({ ok: false, reason: "file shrank" });
    expect(await t.mutation(internal.runs.internalIngest, { run: run({ file: { ...run().file, committedPrefixSha256: "rewritten" } }), rows: [], children: [] } as never)).toEqual({ ok: false, reason: "file rewritten" });
    const rows = await t.run((ctx) => ctx.db.query("claudeMessages").withIndex("by_run_seq", (q) => q.eq("runId", "claude:laptop:root")).collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ digest: "0123456789abcdef", content: { layersKnown: false } });
  });

  it("stamps overflow only after its chunks and backfills session links once", async () => {
    const t = convexTest(schema, modules);
    const stamp = { sha256: "a".repeat(64), byteLength: 2, chunkCount: 1 };
    expect(await t.mutation(internal.runs.internalIngestOverflow, { runId: "claude:laptop:root", seq: 0, index: 0, chunkCount: 1, text: "ok" })).toEqual({ ok: true, index: 0 });
    expect(await t.mutation(internal.runs.internalStampOverflow, { runId: "claude:laptop:root", seq: 0, ...stamp })).toEqual({ ok: true, stamped: false });
    await t.mutation(internal.runs.internalIngest, { run: run(), rows: [row(0, { overflow: stamp })], children: [] } as never);
    await t.mutation(internal.runs.internalIngest, { run: run(), rows: [row(1, { digest: "1111111111111111" })], children: [] } as never);
    expect(await t.mutation(internal.runs.internalStampOverflow, { runId: "claude:laptop:root", seq: 1, ...stamp })).toEqual({ ok: false, reason: "chunks incomplete" });
    await t.mutation(internal.runs.internalIngestOverflow, { runId: "claude:laptop:root", seq: 0, index: 0, chunkCount: 1, text: "ok" });
    await t.mutation(internal.runs.internalIngestOverflow, { runId: "claude:laptop:root", seq: 1, index: 0, chunkCount: 1, text: "ok" });
    expect(await t.mutation(internal.runs.internalStampOverflow, { runId: "claude:laptop:root", seq: 1, ...stamp })).toEqual({ ok: true, stamped: true });
    const page = await withTom(t);
    expect((await page.query(api.runs.rows, { runId: "claude:laptop:root", paginationOpts: { cursor: null, numItems: 1 } })).page[0]).toMatchObject({ hasOverflow: true, fullByteLength: 2 });
  });

  it("keeps the cursor monotonic across append pages and late payloads", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, { run: run(), rows: [row()], children: [] } as never);
    const grown = run({ file: { ...run().file, bytes: 20, committedLine: 2, committedPrefixSha256: "grown-prefix" } });
    expect(await t.mutation(internal.runs.internalIngest, { run: grown, rows: [], children: [], previousCommittedLine: 1, previousCommittedPrefixSha256: "rewritten-under-cursor" } as never)).toEqual({ ok: false, reason: "file rewritten" });
    expect(await t.mutation(internal.runs.internalIngest, { run: grown, rows: [row(1000, { digest: "1111111111111111" })], children: [], previousCommittedLine: 1, previousCommittedPrefixSha256: "prefix" } as never)).toMatchObject({ ok: true, inserted: 1, committedLine: 2 });
    const late = run({ file: { ...run().file, bytes: 20, committedLine: 1, committedPrefixSha256: "grown-prefix" } });
    expect(await t.mutation(internal.runs.internalIngest, { run: late, rows: [], children: [] } as never)).toMatchObject({ ok: true, committedLine: 2 });
    const stored = await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:laptop:root")).unique());
    expect(stored?.file.committedLine).toBe(2);
  });

  it("fills orphan parent stubs, rejects a two-node cycle, and leaves labels untouched", async () => {
    const t = convexTest(schema, modules);
    const parentId = "claude:laptop:missing-parent";
    const child = run({ runId: "claude:laptop:orphan", parentRunId: parentId, rootRunId: parentId, depth: 1, kind: "subagent" });
    await t.mutation(internal.runs.internalIngest, { run: child, rows: [], children: [] } as never);
    expect((await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", parentId)).unique()))?.file.path).toBe("");
    await t.mutation(internal.runs.internalIngest, { run: run({ runId: parentId, rootRunId: parentId, kind: "session" }), rows: [row()], children: [] } as never);
    expect((await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", parentId)).unique()))?.file.path).toBe("C:/root.jsonl");
    const a = "claude:laptop:a", b = "claude:laptop:b";
    await t.mutation(internal.runs.internalIngest, { run: run({ runId: a, rootRunId: a, parentRunId: b }), rows: [], children: [] } as never);
    expect(await t.mutation(internal.runs.internalIngest, { run: run({ runId: b, rootRunId: a, parentRunId: a }), rows: [], children: [] } as never)).toEqual({ ok: false, reason: "parent cycle" });
    expect((await t.run((ctx) => ctx.db.query("dtsEvents").collect())).some((event) => event.kind === "runs-parent-cycle")).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("runLabels").collect())).toEqual([]);
  });

  it("only upgrades unknown kind/origin and an unknown link", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, { run: run({ kind: "unknown", origin: "unknown", linkKnown: false }), rows: [], children: [] } as never);
    await t.mutation(internal.runs.internalIngest, { run: run({ kind: "session", origin: "laptop", linkKnown: true, spawnedByToolUseId: "exact" }), rows: [], children: [] } as never);
    await t.mutation(internal.runs.internalIngest, { run: run({ kind: "unknown", origin: "unknown", linkKnown: false }), rows: [], children: [] } as never);
    const stored = await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:laptop:root")).unique());
    expect(stored).toMatchObject({ kind: "session", origin: "laptop", linkKnown: true, spawnedByToolUseId: "exact" });
  });

  it("denies every public reader without Tom identity", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, { run: run(), rows: [row()], children: [] } as never);
    const stranger = t.withIdentity({ subject: "someone-else" });
    await expect(stranger.query(api.runs.get, { runId: "claude:laptop:root" })).rejects.toThrow();
    await expect(stranger.query(api.runs.children, { runId: "claude:laptop:root" })).rejects.toThrow();
    await expect(stranger.query(api.runs.rows, { runId: "claude:laptop:root", paginationOpts: { cursor: null, numItems: 1 } })).rejects.toThrow();
    await expect(stranger.query(api.runs.entry, { runId: "claude:laptop:root", seq: 0 })).rejects.toThrow();
  });

  it("pages the idempotent legacy-session backfill", async () => {
    const t = convexTest(schema, modules);
    const owner = await withTom(t);
    const first = await owner.mutation(api.claudeSessions.createSession, { title: "one", kind: "adhoc", repo: "none", initialPrompt: "one" });
    const second = await owner.mutation(api.claudeSessions.createSession, { title: "two", kind: "adhoc", repo: "none", initialPrompt: "two" });
    const third = await owner.mutation(api.claudeSessions.createSession, { title: "three", kind: "adhoc", repo: "none", initialPrompt: "three" });
    await t.run(async (ctx) => { await ctx.db.patch(first, { sdkSessionId: "first-sdk" }); await ctx.db.patch(third, { sdkSessionId: "third-sdk", runId: "already-linked" }); });
    let cursor: string | undefined;
    let scanned = 0, patched = 0, sawCursor = false;
    do {
      const page = await t.mutation(internal.runs.internalBackfillRunIds, { cursor, limit: 1 });
      scanned += page.scanned; patched += page.patched; sawCursor ||= page.cursor !== null;
      cursor = page.cursor ?? undefined;
    } while (cursor);
    expect({ scanned, patched, sawCursor }).toEqual({ scanned: 3, patched: 1, sawCursor: true });
    const sessions = await t.run(async (ctx) => [await ctx.db.get(first), await ctx.db.get(second), await ctx.db.get(third)]);
    expect(sessions.map((session) => session?.runId)).toEqual(["claude:box:first-sdk", undefined, "already-linked"]);
    expect((await t.mutation(internal.runs.internalBackfillRunIds, { limit: 1 })).patched).toBe(0);
  });

  it("switches getMessages from daemon rows to the same run-row page shape", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await session(t, { status: "running" });
    const stamp = { sha256: "a".repeat(64), byteLength: 20, chunkCount: 1 };
    await daemonRow(t, sessionId, 0, "user", { text: "hello" });
    await daemonRow(t, sessionId, 1, "assistant-text", { text: "answer" }, stamp);
    await t.mutation(internal.runs.internalIngest, {
      run: run({ sessionId }),
      rows: [
        row(0, { kind: "user", content: { text: "hello" } }),
        row(1, { kind: "assistant-text", content: { text: "answer" }, digest: "1111111111111111", overflow: stamp }),
      ],
      children: [],
    } as never);
    const tom = await withTom(t);
    const pick = (page: Array<Record<string, unknown>>) => page.map(({ seq, kind, content, hasOverflow, fullByteLength }) => ({ seq, kind, content, hasOverflow, fullByteLength }));
    const before = await tom.query(api.claudeSessions.getMessages, { sessionId, paginationOpts: { cursor: null, numItems: 10 } });
    await t.mutation(internal.claudeSessions.internalIngest, { sessionId, runId: "different-run-must-not-replace-the-link", rowsFromFiles: true });
    const after = await tom.query(api.claudeSessions.getMessages, { sessionId, paginationOpts: { cursor: null, numItems: 10 } });
    expect(pick(after.page as never)).toEqual(pick(before.page as never));
    expect(after.page.map((entry) => entry.seq)).toEqual([1, 0]);
    expect(await t.run((ctx) => ctx.db.get(sessionId))).toMatchObject({ runId: "claude:laptop:root", rowsFrom: "runs" });
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
    const result = await t.mutation(internal.runs.internalIngest, {
      run: run({ runId: "claude:box:sdk-root", rootRunId: "claude:box:sdk-root", host: "box" }),
      rows: [], children: [],
    } as never);
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
    await t.mutation(internal.runs.internalIngest, {
      run: run({
        sessionId, status: "ended", envelopeKey: "runs/registration.json.gz",
        context: {
          layersKnown: true, layersGiven: ["write"], layersDenied: [], skillsOffered: [], skillsUsed: [], tools: [], hooks: [],
          registered: true, launcher: "worker/jobs/evals.mjs", modelRequested: "claude-fable-5", skillsGranted: [], skillsRefused: [], promptSha256: "prompt", writingStandardSource: "/tts/capture-context",
        },
      }),
      rows: [
        row(0, { kind: "context", content: { modelRequested: "claude-fable-5" } }),
        row(1000, { kind: "user", content: { text }, digest: "1111111111111111" }),
        row(1500, { kind: "child-run", content: { childRunId: "claude:laptop:root/child" }, digest: "2222222222222222" }),
        row(2000, { kind: "assistant-text", content: { text: "answer" }, digest: "3333333333333333" }),
        row(3000, { kind: "thinking", content: { text: "reasoning" }, digest: "4444444444444444" }),
        row(4000, { kind: "tool-call", content: { name: "Read" }, digest: "5555555555555555" }),
      ], children: [],
    } as never);

    const eligible = await t.query(internal.runs.internalEligibleComparisons, { status: "ended", paginationOpts: { cursor: null, numItems: 100 } });
    expect(eligible.eligible).toContainEqual({ sessionId, runId: "claude:laptop:root" });
    const comparison = await t.mutation(internal.runs.internalShadowCompare, { sessionId });
    expect(comparison).toMatchObject({
      runId: "claude:laptop:root", daemonRows: 4, fileRows: 4,
      byKind: { user: { daemon: 1, file: 1 }, "assistant-text": { daemon: 1, file: 1 }, thinking: { daemon: 1, file: 1 }, "tool-call": { daemon: 1, file: 1 } },
      textRows: 3, textMatches: 3, clean: true,
    });
    expect(comparison).not.toHaveProperty("firstDiffSeq");
    const [storedRun, storedSession, comparisonEvent] = await t.run(async (ctx) => [
      await ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:laptop:root")).unique(),
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
    await t.mutation(internal.runs.internalIngest, {
      run: run({ sessionId, status: "failed" }),
      rows: [row(1000, { kind: "user", content: { text: "file text" }, digest: "1111111111111111" })],
      children: [],
    } as never);
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
    await t.mutation(internal.runs.internalIngest, {
      run: run({ sessionId, status: "ended" }),
      rows: Array.from({ length: 101 }, (_, seq) => row(seq, {
        kind: "user",
        content: { text: seq === 100 ? "late-mismatch" : `row-${seq}` },
        digest: seq.toString(16).padStart(16, "0"),
      })),
      children: [],
    } as never);
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
    await t.mutation(internal.runs.internalIngest, { run: run({ sessionId }), rows: [], children: [] } as never);
    const unknown = await t.query(internal.runs.internalEligibleComparisons, { status: "ended", paginationOpts: { cursor: null, numItems: 100 } });
    expect(unknown.eligible).toEqual([]);
    await expect(t.mutation(internal.runs.internalShadowCompare, { sessionId })).rejects.toThrow("run is not terminal");
    await t.mutation(internal.runs.internalIngest, { run: run({ sessionId, status: "ended" }), rows: [], children: [] } as never);
    const terminal = await t.query(internal.runs.internalEligibleComparisons, { status: "ended", paginationOpts: { cursor: null, numItems: 100 } });
    expect(terminal.eligible).toEqual([{ sessionId, runId: "claude:laptop:root" }]);
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

  it("returns the earliest 200 children from the ordered index", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let index = 200; index >= 0; index -= 1) {
        const runId = `claude:laptop:root/child-${index.toString().padStart(3, "0")}`;
        await ctx.db.insert("runs", { ...run({ runId, parentRunId: "claude:laptop:root", depth: 1, kind: "subagent", startedAt: index }), ingestedAt: Date.now() } as never);
      }
    });
    const tom = await withTom(t);
    const children = await tom.query(api.runs.children, { runId: "claude:laptop:root" });
    expect(children).toHaveLength(200);
    expect(children.map((child) => child.startedAt)).toEqual(Array.from({ length: 200 }, (_, index) => index));
  });

  it("accepts abandoned lifecycle state and emits paged manifest entries", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, {
      run: run({
        origin: "job", status: "abandoned", abandonedAt: 123,
        envelopeKey: "runs/claude/laptop/root/registration-hash.json.gz",
        file: { ...run().file, storeKey: "runs/claude/laptop/root/stored.jsonl.gz" },
      }), rows: [], children: [],
    } as never);
    const stored = await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:laptop:root")).unique());
    expect(stored).toMatchObject({ status: "abandoned", abandonedAt: 123, origin: "job" });
    const manifest = await t.query(internal.runs.internalManifest, { since: 0 });
    expect(manifest.entries).toEqual([expect.objectContaining({
      run_id: "claude:laptop:root", thread_id: "root", file_version: "stored",
      store_key: "runs/claude/laptop/root/stored.jsonl.gz", parent_run_id: null,
    })]);
    expect((await t.query(internal.runs.internalManifest, { since: manifest.entries[0].at, afterRunId: manifest.entries[0].run_id, afterFileVersion: manifest.entries[0].file_version })).entries).toEqual([]);
    await t.mutation(internal.runs.internalIngest, { run: run({ status: "ended" }), rows: [], children: [] } as never);
    expect((await t.run((ctx) => ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", "claude:laptop:root")).unique()))?.status).toBe("ended");
  });

  it("manifests each file version once across retries and equal timestamps", async () => {
    const t = convexTest(schema, modules);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const firstRun = run({ file: { ...run().file, storedHash: "version-a", storeKey: "runs/a.jsonl.gz" } });
      await t.mutation(internal.runs.internalIngest, { run: firstRun, rows: [], children: [] } as never);
      const secondRun = run({ file: { ...run().file, storedHash: "version-b", storeKey: "runs/b.jsonl.gz", bytes: 20, committedLine: 2, committedPrefixSha256: "prefix-b" } });
      const secondInput = { run: secondRun, rows: [], children: [], previousCommittedLine: 1, previousCommittedPrefixSha256: "prefix" };
      await t.mutation(internal.runs.internalIngest, secondInput as never);
      await t.mutation(internal.runs.internalIngest, secondInput as never);
      const versions = await t.run((ctx) => ctx.db.query("runFileVersions").collect());
      expect(versions.map((version) => version.fileVersion).sort()).toEqual(["version-a", "version-b"]);
      const manifest = await t.query(internal.runs.internalManifest, { since: 0 });
      expect(manifest.entries.map((entry) => entry.file_version)).toEqual(["version-a", "version-b"]);
      const resumed = await t.query(internal.runs.internalManifest, {
        since: manifest.entries[0].at,
        afterRunId: manifest.entries[0].run_id,
        afterFileVersion: manifest.entries[0].file_version,
      });
      expect(resumed.entries.map((entry) => entry.file_version)).toEqual(["version-b"]);
    } finally {
      now.mockRestore();
    }
  });
});
