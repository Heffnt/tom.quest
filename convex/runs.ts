import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireTom } from "./authRoles";
import { SESSION_MODEL } from "./ttsShared";

const RUN_KIND = v.union(
  v.literal("session"), v.literal("worker"), v.literal("code"),
  v.literal("prospect"), v.literal("job"), v.literal("delegate"),
  v.literal("subagent"), v.literal("codex-child"), v.literal("unknown"),
);
const RUN_STATUS = v.union(v.literal("running"), v.literal("ended"), v.literal("failed"), v.literal("unknown"));
const ROW_KIND = v.union(
  v.literal("user"), v.literal("assistant-text"), v.literal("thinking"),
  v.literal("tool-call"), v.literal("tool-result"), v.literal("permission"),
  v.literal("system"), v.literal("error"), v.literal("child-run"), v.literal("context"),
);
const FILE = v.object({
  path: v.string(), sourceHash: v.string(), storedHash: v.string(), bytes: v.number(), storedBytes: v.number(),
  committedLine: v.number(), committedPrefixSha256: v.string(), storeKey: v.optional(v.string()), incompleteTail: v.optional(v.boolean()),
});
const CONTEXT = v.object({
  wikitomCommit: v.optional(v.string()), layersKnown: v.boolean(), layersGiven: v.array(v.string()), layersDenied: v.array(v.string()),
  skillsOffered: v.array(v.string()), skillsUsed: v.array(v.string()), tools: v.array(v.string()), hooks: v.array(v.string()),
  cwd: v.optional(v.string()), gitBranch: v.optional(v.string()), gitCommit: v.optional(v.string()), baseInstructionsHash: v.optional(v.string()),
  entrypoint: v.optional(v.string()), originator: v.optional(v.string()), permissionMode: v.optional(v.string()), contextWindow: v.optional(v.number()),
});
const OUTCOME = v.object({
  endedReason: v.optional(v.string()), finalTextSeq: v.optional(v.number()),
  totals: v.object({ inputTokens: v.number(), cacheReadTokens: v.number(), cacheWriteTokens: v.number(), outputTokens: v.number(), thinkingTokens: v.number(), totalTokens: v.number() }),
  costUsd: v.optional(v.number()), priceTableVersion: v.optional(v.string()), turns: v.number(), toolCalls: v.number(),
});
const RUN = v.object({
  runId: v.string(), parentRunId: v.optional(v.string()), rootRunId: v.string(), depth: v.number(), spawnedByToolUseId: v.optional(v.string()), linkKnown: v.boolean(),
  origin: v.string(), continuesRunId: v.optional(v.string()), host: v.union(v.literal("laptop"), v.literal("box")), runner: v.union(v.literal("claude"), v.literal("codex")),
  model: v.optional(v.string()), sessionModel: v.optional(SESSION_MODEL), effort: v.optional(v.string()), runtimeVersion: v.optional(v.string()), parserVersion: v.string(), kind: RUN_KIND, status: RUN_STATUS,
  startedAt: v.number(), lastLineAt: v.number(), context: v.optional(CONTEXT), outcome: v.optional(OUTCOME), todoId: v.optional(v.id("dtsTodos")), batchId: v.optional(v.id("batches")), mergeKey: v.optional(v.string()), sessionId: v.optional(v.id("claudeSessions")), file: FILE,
});
const PROVENANCE = v.object({ fileVersion: v.string(), file: v.string(), lineStart: v.number(), lineEnd: v.number(), block: v.number(), parserVersion: v.string(), sourceKind: v.string() });
const ROW = v.object({
  seq: v.number(), turn: v.number(), kind: ROW_KIND, content: v.any(), provenance: PROVENANCE, digest: v.string(), depth: v.number(), parentToolUseId: v.optional(v.string()),
  overflow: v.optional(v.object({ sha256: v.string(), byteLength: v.number(), chunkCount: v.number() })), createdAt: v.number(),
});

async function requireTomForRuns(ctx: QueryCtx) {
  await requireTom(ctx, "Runs");
}

async function runAt(ctx: MutationCtx, runId: string) {
  return await ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", runId)).first();
}
async function rowAt(ctx: MutationCtx, runId: string, seq: number) {
  return await ctx.db.query("claudeMessages").withIndex("by_run_seq", (q) => q.eq("runId", runId).eq("seq", seq)).first();
}
async function overflowAt(ctx: MutationCtx, runId: string, seq: number, index: number) {
  return await ctx.db.query("claudeMessageOverflow").withIndex("by_run_seq_index", (q) => q.eq("runId", runId).eq("seq", seq).eq("index", index)).first();
}

function event(ctx: MutationCtx, kind: string, data: Record<string, unknown>) {
  return ctx.db.insert("dtsEvents", { at: Date.now(), kind, data });
}

function stub(run: { runId: string; parentRunId?: string; rootRunId: string; depth: number; spawnedByToolUseId?: string; linkKnown: boolean }, parent: { host: "laptop" | "box"; runner: "claude" | "codex"; parserVersion: string; lastLineAt: number }, kind: "subagent" | "codex-child" | "unknown") {
  return {
    ...run, host: parent.host, runner: parent.runner, kind, status: "unknown" as const, origin: "unknown", parserVersion: parent.parserVersion,
    startedAt: parent.lastLineAt, lastLineAt: parent.lastLineAt,
    file: { path: "", sourceHash: "", storedHash: "", bytes: 0, storedBytes: 0, committedLine: 0, committedPrefixSha256: "" }, ingestedAt: Date.now(),
  };
}

function validOrigin(origin: string) {
  return ["session", "daemon", "hook", "laptop", "unknown"].includes(origin) || /^cron:[\w.-]{1,64}$/.test(origin);
}

async function parentCycleLength(ctx: MutationCtx, runId: string, parentRunId?: string) {
  if (!parentRunId) return 0;
  if (parentRunId === runId) return 1;
  let current: string | undefined = parentRunId;
  for (let hops = 0; current && hops < 32; hops += 1) {
    if (current === runId) return hops + 1;
    const found = await runAt(ctx, current);
    current = found?.parentRunId;
  }
  // A chain beyond the bounded walk is unsafe for every recursive reader.
  return current === undefined ? 0 : 32;
}

export const internalIngest = internalMutation({
  args: { run: RUN, rows: v.array(ROW), children: v.array(v.object({ runId: v.string(), parentRunId: v.string(), rootRunId: v.string(), depth: v.number(), spawnedByToolUseId: v.optional(v.string()), linkKnown: v.boolean() })) },
  handler: async (ctx, args) => {
    if (args.run.runId === "") return { ok: false as const, reason: "runId required" };
    if (!validOrigin(args.run.origin)) return { ok: false as const, reason: "invalid origin" };
    if (args.rows.length > 200) return { ok: false as const, reason: "too many rows" };
    let previous = -1;
    for (const row of args.rows) {
      if (!Number.isInteger(row.seq) || row.seq < 0 || row.seq <= previous) return { ok: false as const, reason: "rows must have ascending non-negative seq" };
      if (!/^[0-9a-f]{16}$/.test(row.digest)) return { ok: false as const, reason: "invalid entry digest" };
      if (row.provenance.fileVersion !== args.run.file.storedHash) return { ok: false as const, reason: "row file version mismatch" };
      previous = row.seq;
    }
    const cycleLength = await parentCycleLength(ctx, args.run.runId, args.run.parentRunId);
    if (cycleLength) {
      await event(ctx, "runs-parent-cycle", { runId: args.run.runId, parentRunId: args.run.parentRunId, chainLength: cycleLength });
      return { ok: false as const, reason: "parent cycle" };
    }

    const existing = await runAt(ctx, args.run.runId);
    if (existing && existing.file.path !== "" && args.run.file.bytes < existing.file.bytes) {
      await event(ctx, "runs-file-shrank", { runId: args.run.runId, storedBytes: existing.file.bytes, presentedBytes: args.run.file.bytes, path: args.run.file.path });
      return { ok: false as const, reason: "file shrank" };
    }
    // A longer page presents the prefix through its new cursor, so its hash is
    // expected to differ. An older page is harmlessly late; only the same
    // cursor can make a like-for-like prefix claim that proves a rewrite.
    if (existing && existing.file.path !== "" && args.run.file.committedLine === existing.file.committedLine && args.run.file.committedPrefixSha256 !== existing.file.committedPrefixSha256) {
      await event(ctx, "runs-file-rewritten", { runId: args.run.runId, storedPrefixHash: existing.file.committedPrefixSha256, presentedPrefixHash: args.run.file.committedPrefixSha256, storedVersion: existing.file.storedHash, presentedVersion: args.run.file.storedHash });
      return { ok: false as const, reason: "file rewritten" };
    }

    // Detect every collision before writing anything, so an immutable row never
    // leaves a partially-applied page behind.
    for (const row of args.rows) {
      const landed = await rowAt(ctx, args.run.runId, row.seq);
      if (landed && landed.digest !== row.digest) {
        await event(ctx, "runs-entry-mismatch", { runId: args.run.runId, seq: row.seq, storedDigest: landed.digest, presentedDigest: row.digest });
        return { ok: false as const, reason: "entry digest mismatch" };
      }
    }

    if (!existing) {
      await ctx.db.insert("runs", { ...args.run, ingestedAt: Date.now() });
    } else {
      const advances = args.run.file.committedLine > existing.file.committedLine;
      const patch: Record<string, unknown> = { ingestedAt: Date.now() };
      if (advances) patch.file = args.run.file;
      else patch.file = { ...existing.file, committedLine: Math.max(existing.file.committedLine, args.run.file.committedLine) };
      for (const key of ["status", "outcome", "lastLineAt", "model", "sessionModel", "effort", "context", "runtimeVersion", "parserVersion", "continuesRunId"] as const) if (args.run[key] !== undefined) patch[key] = args.run[key];
      if (existing.kind === "unknown") patch.kind = args.run.kind;
      if (existing.origin === "unknown") patch.origin = args.run.origin;
      if (!existing.linkKnown && args.run.linkKnown && args.run.spawnedByToolUseId) { patch.linkKnown = true; patch.spawnedByToolUseId = args.run.spawnedByToolUseId; }
      if (existing.file.path === "") Object.assign(patch, { parentRunId: args.run.parentRunId, rootRunId: args.run.rootRunId, depth: args.run.depth, host: args.run.host, runner: args.run.runner, startedAt: args.run.startedAt });
      await ctx.db.patch(existing._id, patch);
    }

    for (const child of args.children) {
      if (!(await runAt(ctx, child.runId))) await ctx.db.insert("runs", stub(child, args.run, child.runId.startsWith("codex:") ? "codex-child" : "subagent"));
    }
    if (args.run.parentRunId && !(await runAt(ctx, args.run.parentRunId))) {
      await ctx.db.insert("runs", stub({ runId: args.run.parentRunId, rootRunId: args.run.rootRunId, depth: Math.max(args.run.depth - 1, 0), linkKnown: false }, args.run, "unknown"));
    }

    let inserted = 0, skipped = 0;
    for (const row of args.rows) {
      if (await rowAt(ctx, args.run.runId, row.seq)) { skipped += 1; continue; }
      await ctx.db.insert("claudeMessages", { runId: args.run.runId, seq: row.seq, turn: row.turn, kind: row.kind, content: row.content, provenance: row.provenance, digest: row.digest, depth: row.depth, parentToolUseId: row.parentToolUseId, overflow: row.overflow, createdAt: row.createdAt });
      inserted += 1;
    }
    if (args.run.sessionId) await ctx.db.patch(args.run.sessionId, { runId: args.run.runId });
    const landed = await runAt(ctx, args.run.runId);
    return { ok: true as const, runId: args.run.runId, inserted, skipped, committedLine: landed?.file.committedLine ?? args.run.file.committedLine };
  },
});

function refuseOverflow(reason: string, where: { runId: string; seq: number; index?: number }) {
  console.warn(`runs overflow refused: ${reason} (run ${where.runId}, seq ${where.seq}${where.index === undefined ? ")" : `, chunk ${where.index})`}`);
  return { ok: false as const, reason };
}
const chunkBytes = (text: string) => new TextEncoder().encode(text).length;
export const internalIngestOverflow = internalMutation({
  args: { runId: v.string(), seq: v.number(), index: v.number(), chunkCount: v.number(), text: v.string() },
  handler: async (ctx, args) => {
    const where = { runId: args.runId, seq: args.seq, index: args.index };
    // Chunks may arrive before their row, but never before the run itself:
    // otherwise a misspelled id leaves uncollectable overflow behind.
    if (!(await runAt(ctx, args.runId))) return refuseOverflow("no run", where);
    if (!Number.isInteger(args.seq) || args.seq < 0 || !Number.isInteger(args.index) || args.index < 0 || !Number.isInteger(args.chunkCount) || args.chunkCount < 1 || args.index >= args.chunkCount) return refuseOverflow("malformed chunk", where);
    if (chunkBytes(args.text) > 256 * 1024) return refuseOverflow("chunk too large", where);
    const row = await rowAt(ctx, args.runId, args.seq);
    if (row?.overflow && row.overflow.chunkCount !== args.chunkCount) return refuseOverflow("chunkCount disagrees with the row's stamp", where);
    const existing = await overflowAt(ctx, args.runId, args.seq, args.index);
    if (existing) await ctx.db.patch(existing._id, { chunkCount: args.chunkCount, text: args.text });
    else await ctx.db.insert("claudeMessageOverflow", { runId: args.runId, seq: args.seq, index: args.index, chunkCount: args.chunkCount, text: args.text, createdAt: Date.now() });
    return { ok: true as const, index: args.index };
  },
});
export const internalStampOverflow = internalMutation({
  args: { runId: v.string(), seq: v.number(), sha256: v.string(), byteLength: v.number(), chunkCount: v.number() },
  handler: async (ctx, args) => {
    const where = { runId: args.runId, seq: args.seq };
    if (!Number.isInteger(args.seq) || args.seq < 0 || !Number.isInteger(args.chunkCount) || args.chunkCount < 1 || !Number.isInteger(args.byteLength) || args.byteLength < 0 || !/^[0-9a-f]{64}$/.test(args.sha256)) return refuseOverflow("malformed stamp", where);
    const row = await rowAt(ctx, args.runId, args.seq);
    if (!row) return refuseOverflow("no message row", where);
    const stamp = { sha256: args.sha256, byteLength: args.byteLength, chunkCount: args.chunkCount };
    if (row.overflow) return row.overflow.sha256 === stamp.sha256 && row.overflow.byteLength === stamp.byteLength && row.overflow.chunkCount === stamp.chunkCount ? { ok: true as const, stamped: false } : refuseOverflow("row already stamped", where);
    const last = await overflowAt(ctx, args.runId, args.seq, args.chunkCount - 1);
    if (!last || last.chunkCount !== args.chunkCount) return refuseOverflow("chunks incomplete", where);
    await ctx.db.patch(row._id, { overflow: stamp });
    return { ok: true as const, stamped: true };
  },
});

export const get = query({ args: { runId: v.string() }, handler: async (ctx, args) => { await requireTomForRuns(ctx); return await ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", args.runId)).first(); } });
export const children = query({ args: { runId: v.string() }, handler: async (ctx, args) => { await requireTomForRuns(ctx); const children = await ctx.db.query("runs").withIndex("by_parent", (q) => q.eq("parentRunId", args.runId)).take(200); return children.sort((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId)); } });
export const rows = query({ args: { runId: v.string(), paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => { await requireTomForRuns(ctx); const page = await ctx.db.query("claudeMessages").withIndex("by_run_seq", (q) => q.eq("runId", args.runId)).order("asc").paginate(args.paginationOpts); return { ...page, page: page.page.map((row) => ({ ...row, hasOverflow: row.overflow !== undefined, fullByteLength: row.overflow?.byteLength })) }; } });
export const entry = query({ args: { runId: v.string(), seq: v.number() }, handler: async (ctx, args) => { await requireTomForRuns(ctx); const row = await ctx.db.query("claudeMessages").withIndex("by_run_seq", (q) => q.eq("runId", args.runId).eq("seq", args.seq)).first(); return row ? { provenance: row.provenance, content: row.content, overflow: row.overflow, digest: row.digest } : null; } });

export const internalBackfillRunIds = internalMutation({
  args: { cursor: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 200;
    const page = await ctx.db.query("claudeSessions").withIndex("by_createdAt").order("asc").paginate({ cursor: args.cursor ?? null, numItems: limit });
    let patched = 0;
    for (const session of page.page) if (session.sdkSessionId && !session.runId) { await ctx.db.patch(session._id, { runId: `claude:box:${session.sdkSessionId}` }); patched += 1; }
    return { scanned: page.page.length, patched, cursor: page.isDone ? null : page.continueCursor };
  },
});
