import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
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
    expect(await t.mutation(internal.runs.internalIngestOverflow, { runId: "claude:laptop:missing", seq: 0, index: 0, chunkCount: 1, text: "orphan" })).toEqual({ ok: false, reason: "no run" });
    await t.mutation(internal.runs.internalIngest, { run: run(), rows: [row()], children: [] } as never);
    expect(await t.mutation(internal.runs.internalStampOverflow, { runId: "claude:laptop:root", seq: 0, sha256: "a".repeat(64), byteLength: 2, chunkCount: 1 })).toEqual({ ok: false, reason: "chunks incomplete" });
    await t.mutation(internal.runs.internalIngestOverflow, { runId: "claude:laptop:root", seq: 0, index: 0, chunkCount: 1, text: "ok" });
    expect(await t.mutation(internal.runs.internalStampOverflow, { runId: "claude:laptop:root", seq: 0, sha256: "a".repeat(64), byteLength: 2, chunkCount: 1 })).toEqual({ ok: true, stamped: true });
    const page = await withTom(t);
    expect((await page.query(api.runs.rows, { runId: "claude:laptop:root", paginationOpts: { cursor: null, numItems: 1 } })).page[0]).toMatchObject({ hasOverflow: true, fullByteLength: 2 });
  });

  it("keeps the cursor monotonic across append pages and late payloads", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.runs.internalIngest, { run: run(), rows: [row()], children: [] } as never);
    const grown = run({ file: { ...run().file, bytes: 20, committedLine: 2, committedPrefixSha256: "grown-prefix" } });
    expect(await t.mutation(internal.runs.internalIngest, { run: grown, rows: [row(1000, { digest: "1111111111111111" })], children: [] } as never)).toMatchObject({ ok: true, inserted: 1, committedLine: 2 });
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
});
