import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireTom } from "./authRoles";
import { SESSION_MODEL } from "./ttsShared";

const RUN_KIND = v.union(
  v.literal("session"), v.literal("worker"), v.literal("code"),
  v.literal("prospect"), v.literal("job"), v.literal("delegate"),
  v.literal("subagent"), v.literal("codex-child"), v.literal("unknown"),
);
const RUN_STATUS = v.union(v.literal("running"), v.literal("ended"), v.literal("failed"), v.literal("abandoned"), v.literal("unknown"));
const RUN_MODE = v.union(v.literal("interactive"), v.literal("autonomous"));
const ROW_KIND = v.union(
  v.literal("user"), v.literal("assistant-text"), v.literal("thinking"),
  v.literal("tool-call"), v.literal("tool-result"), v.literal("permission"),
  v.literal("system"), v.literal("error"), v.literal("child-run"), v.literal("context"),
);
const FILE = v.object({
  path: v.string(), sourceHash: v.string(), storedHash: v.string(), bytes: v.number(), storedBytes: v.number(),
  committedLine: v.number(), committedPrefixSha256: v.string(), sidecarStoredHash: v.optional(v.string()),
  storeKey: v.optional(v.string()), incompleteTail: v.optional(v.boolean()),
});
const ATTACHMENT = v.object({ file: v.string(), bytes: v.number(), sha256: v.string() });
const CONTEXT = v.object({
  wikitomCommit: v.optional(v.string()), layersKnown: v.boolean(), layersGiven: v.array(v.string()), layersDenied: v.array(v.string()),
  skillsOffered: v.array(v.string()), skillsUsed: v.array(v.string()), tools: v.array(v.string()), hooks: v.array(v.string()),
  cwd: v.optional(v.string()), gitBranch: v.optional(v.string()), gitCommit: v.optional(v.string()), baseInstructionsHash: v.optional(v.string()),
  entrypoint: v.optional(v.string()), originator: v.optional(v.string()), permissionMode: v.optional(v.string()), contextWindow: v.optional(v.number()),
  registered: v.optional(v.boolean()), launcher: v.optional(v.string()), modelRequested: v.optional(v.string()),
  skillsGranted: v.optional(v.array(v.string())), skillsRefused: v.optional(v.array(v.string())),
  promptSha256: v.optional(v.string()), writingStandardSource: v.optional(v.string()),
});
const OUTCOME = v.object({
  endedReason: v.optional(v.string()), finalTextSeq: v.optional(v.number()),
  totals: v.object({
    inputTokens: v.number(), cacheReadTokens: v.number(), cacheWriteTokens: v.number(),
    cacheWrite5mTokens: v.number(), cacheWrite1hTokens: v.number(), cacheWriteBreakdownKnown: v.boolean(),
    outputTokens: v.number(), thinkingTokens: v.number(), totalTokens: v.number(), longContextRequests: v.optional(v.number()),
  }),
  costUsd: v.optional(v.number()), priceTableVersion: v.optional(v.string()), turns: v.number(), toolCalls: v.number(),
});
const RUN = v.object({
  runId: v.string(), parentRunId: v.optional(v.string()), rootRunId: v.string(), depth: v.number(), spawnedByToolUseId: v.optional(v.string()), linkKnown: v.boolean(),
  origin: v.string(), continuesRunId: v.optional(v.string()), host: v.union(v.literal("laptop"), v.literal("box")), runner: v.union(v.literal("claude"), v.literal("codex")),
  model: v.optional(v.string()), sessionModel: v.optional(SESSION_MODEL), effort: v.optional(v.string()), runtimeVersion: v.optional(v.string()), parserVersion: v.string(), kind: RUN_KIND, status: RUN_STATUS,
  mode: v.optional(RUN_MODE), startedAt: v.number(), lastLineAt: v.number(), context: v.optional(CONTEXT), outcome: v.optional(OUTCOME), attachments: v.array(ATTACHMENT),
  todoId: v.optional(v.id("dtsTodos")), batchId: v.optional(v.id("batches")), mergeKey: v.optional(v.string()), sessionId: v.optional(v.id("claudeSessions")),
  envelopeKey: v.optional(v.string()), cutoverAt: v.optional(v.number()), abandonedAt: v.optional(v.number()), file: FILE,
});
const PROVENANCE = v.object({ fileVersion: v.string(), file: v.string(), lineStart: v.number(), lineEnd: v.number(), block: v.number(), parserVersion: v.string(), sourceKind: v.string() });
const ROW = v.object({
  seq: v.number(), turn: v.number(), kind: ROW_KIND, content: v.any(), provenance: PROVENANCE, digest: v.string(), depth: v.number(), parentToolUseId: v.optional(v.string()),
  overflow: v.optional(v.object({ sha256: v.string(), byteLength: v.number(), chunkCount: v.number() })), createdAt: v.number(),
});
const CHILD = v.object({ runId: v.string(), parentRunId: v.string(), rootRunId: v.string(), depth: v.number(), spawnedByToolUseId: v.optional(v.string()), linkKnown: v.boolean() });

const RUN_ID = /^(claude|codex):(laptop|box):[A-Za-z0-9._-]{8,128}(\/[A-Za-z0-9._-]{8,128})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_DESCENDANT_REPAIR = 500;
const MAX_OVERFLOW_CHUNKS = 500;

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && value > 0;
}
function validHash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}
function validRunId(runId: unknown): runId is string {
  return typeof runId === "string" && RUN_ID.test(runId);
}
function runIdMatches(runId: string, runner: "claude" | "codex", host: "laptop" | "box") {
  return runId.startsWith(`${runner}:${host}:`);
}
function isStubFile(file: { path: string; sourceHash: string; storedHash: string; bytes: number; storedBytes: number; committedLine: number; committedPrefixSha256: string }) {
  return file.path === "" && file.sourceHash === "" && file.storedHash === "" && file.bytes === 0 && file.storedBytes === 0 && file.committedLine === 0 && file.committedPrefixSha256 === "";
}
function validFile(file: {
  path: string; sourceHash: string; storedHash: string; bytes: number; storedBytes: number; committedLine: number; committedPrefixSha256: string; sidecarStoredHash?: string;
}) {
  if (isStubFile(file)) return file.sidecarStoredHash === undefined;
  return file.path !== "" && validHash(file.sourceHash) && validHash(file.storedHash) && nonNegativeInteger(file.bytes) && nonNegativeInteger(file.storedBytes) && nonNegativeInteger(file.committedLine) && validHash(file.committedPrefixSha256) && (file.sidecarStoredHash === undefined || validHash(file.sidecarStoredHash));
}

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
    startedAt: parent.lastLineAt, lastLineAt: parent.lastLineAt, attachments: [],
    file: { path: "", sourceHash: "", storedHash: "", bytes: 0, storedBytes: 0, committedLine: 0, committedPrefixSha256: "" }, ingestedAt: Date.now(),
  };
}

function validOrigin(origin: string) {
  return ["session", "planner", "worker", "nightly", "weekly", "delegate", "job", "daemon", "hook", "laptop", "unknown"].includes(origin) || /^cron:[\w.-]{1,64}$/.test(origin);
}
async function fileVersionAt(ctx: MutationCtx, runId: string, fileVersion: string) {
  return await ctx.db
    .query("runFileVersions")
    .withIndex("by_run_id_and_file_version", (q) => q.eq("runId", runId).eq("fileVersion", fileVersion))
    .unique();
}

function validOutcome(outcome: {
  endedReason?: string; finalTextSeq?: number; totals: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number; cacheWriteBreakdownKnown: boolean; outputTokens: number; thinkingTokens: number; totalTokens: number; longContextRequests?: number }; costUsd?: number; priceTableVersion?: string; turns: number; toolCalls: number;
}) {
  const totals = outcome.totals;
  const values = [totals.inputTokens, totals.cacheReadTokens, totals.cacheWriteTokens, totals.cacheWrite5mTokens, totals.cacheWrite1hTokens, totals.outputTokens, totals.thinkingTokens, totals.totalTokens, outcome.turns, outcome.toolCalls];
  if (!values.every(nonNegativeInteger) || (outcome.finalTextSeq !== undefined && !nonNegativeInteger(outcome.finalTextSeq)) || (totals.longContextRequests !== undefined && !nonNegativeInteger(totals.longContextRequests))) return false;
  if (outcome.costUsd !== undefined && (typeof outcome.costUsd !== "number" || !Number.isFinite(outcome.costUsd) || outcome.costUsd < 0)) return false;
  return !totals.cacheWriteBreakdownKnown || totals.cacheWriteTokens === totals.cacheWrite5mTokens + totals.cacheWrite1hTokens;
}

function validRunPayload(run: {
  runId: string; parentRunId?: string; rootRunId: string; depth: number; spawnedByToolUseId?: string; linkKnown: boolean; origin: string; continuesRunId?: string; host: "laptop" | "box"; runner: "claude" | "codex"; kind: string; mode?: "interactive" | "autonomous"; startedAt: number; lastLineAt: number; context?: { baseInstructionsHash?: string; contextWindow?: number }; outcome?: Parameters<typeof validOutcome>[0]; attachments: { file: string; bytes: number; sha256: string }[]; file: Parameters<typeof validFile>[0];
}) {
  if (!validRunId(run.runId) || !validRunId(run.rootRunId) || !runIdMatches(run.runId, run.runner, run.host) || !runIdMatches(run.rootRunId, run.runner, run.host)) return false;
  if (run.parentRunId !== undefined && (!validRunId(run.parentRunId) || !runIdMatches(run.parentRunId, run.runner, run.host))) return false;
  if (run.continuesRunId !== undefined && !validRunId(run.continuesRunId)) return false;
  if (run.mode !== undefined && run.kind !== "session") return false;
  if (!nonNegativeInteger(run.depth) || !nonNegativeInteger(run.startedAt) || !nonNegativeInteger(run.lastLineAt) || !validFile(run.file)) return false;
  if (!validOrigin(run.origin) || (run.linkKnown && run.parentRunId !== undefined && !run.spawnedByToolUseId)) return false;
  if (run.context?.baseInstructionsHash !== undefined && !validHash(run.context.baseInstructionsHash)) return false;
  if (run.context?.contextWindow !== undefined && !nonNegativeInteger(run.context.contextWindow)) return false;
  if (run.outcome !== undefined && !validOutcome(run.outcome)) return false;
  return run.attachments.every((attachment) => attachment.file !== "" && nonNegativeInteger(attachment.bytes) && validHash(attachment.sha256));
}

function validRow(row: {
  seq: number; turn: number; digest: string; depth: number; createdAt: number; overflow?: { sha256: string; byteLength: number; chunkCount: number }; provenance: { fileVersion: string; lineStart: number; lineEnd: number; block: number };
}) {
  return nonNegativeInteger(row.seq) && nonNegativeInteger(row.turn) && validHash(row.provenance.fileVersion) && nonNegativeInteger(row.provenance.lineStart) && nonNegativeInteger(row.provenance.lineEnd) && row.provenance.lineEnd >= row.provenance.lineStart && nonNegativeInteger(row.provenance.block) && nonNegativeInteger(row.depth) && nonNegativeInteger(row.createdAt) && /^[0-9a-f]{16}$/.test(row.digest) && (row.overflow === undefined || (validHash(row.overflow.sha256) && nonNegativeInteger(row.overflow.byteLength) && positiveInteger(row.overflow.chunkCount)));
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

async function descendantsForRepair(ctx: MutationCtx, runId: string, rootRunId: string, depth: number) {
  const pending = [{ runId, depth }];
  const repairs: { id: string; rootRunId: string; depth: number }[] = [];
  while (pending.length > 0) {
    const current = pending.shift()!;
    const children = await ctx.db.query("runs").withIndex("by_parent", (q) => q.eq("parentRunId", current.runId)).take(MAX_DESCENDANT_REPAIR + 1);
    for (const child of children) {
      if (repairs.length >= MAX_DESCENDANT_REPAIR) return null;
      const childDepth = current.depth + 1;
      repairs.push({ id: child._id, rootRunId, depth: childDepth });
      pending.push({ runId: child.runId, depth: childDepth });
    }
  }
  return repairs;
}

export const internalIngest = internalMutation({
  args: { run: RUN, rows: v.array(ROW), children: v.array(CHILD), previousCommittedLine: v.number(), previousPrefixSha256: v.string() },
  handler: async (ctx, args) => {
    if (!validRunPayload(args.run) || !nonNegativeInteger(args.previousCommittedLine) || !validHash(args.previousPrefixSha256)) return { ok: false as const, reason: "invalid run record" };
    if (args.rows.length > 200) return { ok: false as const, reason: "too many rows" };

    const existing = await runAt(ctx, args.run.runId);
    const knownParent = args.run.parentRunId ? await runAt(ctx, args.run.parentRunId) : null;
    let rootRunId = args.run.rootRunId;
    let depth = args.run.depth;
    if (existing && !isStubFile(existing.file)) {
      if (existing.parentRunId !== args.run.parentRunId) return { ok: false as const, reason: "parent cannot change" };
      rootRunId = existing.rootRunId;
      depth = existing.depth;
    } else if (!args.run.parentRunId) {
      if (args.run.rootRunId !== args.run.runId || args.run.depth !== 0 || !args.run.linkKnown) return { ok: false as const, reason: "invalid root run" };
    } else if (knownParent) {
      rootRunId = knownParent.rootRunId;
      depth = knownParent.depth + 1;
    } else {
      // A missing parent is a root stub until its own file names its parent.
      // Filling that stub repairs this run and its descendants below. The depth
      // stays the one the CLI sidecar gave this run: the sweep reaches a
      // grandchild before its parent whenever the file names sort that way, and
      // inventing depth 1 here made every row of a deeper run fail the row-depth
      // check below and dead-letter the whole run on a permanent 400.
      rootRunId = args.run.parentRunId;
    }
    let run = { ...args.run, rootRunId, depth };
    // A box Claude root has the same CLI id as its live session. Resolve that
    // exact join in the ingest transaction so a missed daemon stamp repairs
    // itself without a second worker round trip.
    if (run.sessionId === undefined && run.runner === "claude" && run.host === "box" && run.depth === 0) {
      const sdkSessionId = run.runId.slice("claude:box:".length);
      if (run.runId.startsWith("claude:box:") && sdkSessionId !== "" && !sdkSessionId.includes("/")) {
        const session = await ctx.db
          .query("claudeSessions")
          .withIndex("by_sdk_session_id", (q) => q.eq("sdkSessionId", sdkSessionId))
          .unique();
        if (session) run = { ...run, sessionId: session._id };
      }
    }

    let previous = -1;
    for (const row of args.rows) {
      if (!validRow(row) || row.seq <= previous || row.depth !== run.depth) return { ok: false as const, reason: "invalid run row" };
      if (row.overflow !== undefined) return { ok: false as const, reason: "overflow must be stamped separately" };
      if (row.provenance.fileVersion !== run.file.storedHash) return { ok: false as const, reason: "row file version mismatch" };
      previous = row.seq;
    }

    const cycleLength = await parentCycleLength(ctx, run.runId, run.parentRunId);
    if (cycleLength) {
      await event(ctx, "runs-parent-cycle", { runId: run.runId, parentRunId: run.parentRunId, chainLength: cycleLength });
      return { ok: false as const, reason: "parent cycle" };
    }

    const knownChildren = new Map<string, Awaited<ReturnType<typeof runAt>>>();
    const childIds = new Set<string>();
    for (const child of args.children) {
      if (!validRunId(child.runId) || !validRunId(child.parentRunId) || !validRunId(child.rootRunId) || !nonNegativeInteger(child.depth) || child.runId === run.runId || child.parentRunId !== run.runId || child.rootRunId !== run.rootRunId || child.depth !== run.depth + 1 || (child.linkKnown && !child.spawnedByToolUseId) || childIds.has(child.runId)) return { ok: false as const, reason: "invalid child edge" };
      const childCycleLength = await parentCycleLength(ctx, child.runId, run.runId);
      if (childCycleLength) {
        await event(ctx, "runs-parent-cycle", { runId: child.runId, parentRunId: run.runId, chainLength: childCycleLength });
        return { ok: false as const, reason: "parent cycle" };
      }
      const knownChild = await runAt(ctx, child.runId);
      if (knownChild?.parentRunId !== undefined && knownChild.parentRunId !== run.runId) return { ok: false as const, reason: "child parent mismatch" };
      knownChildren.set(child.runId, knownChild);
      childIds.add(child.runId);
    }

    // The tuple is a compare-and-swap fence, not a hint about the page being
    // appended. It catches a rewritten old prefix even when this page also has
    // later lines, before this mutation changes any record row.
    if (existing && !isStubFile(existing.file)) {
      if (args.previousCommittedLine !== existing.file.committedLine || args.previousPrefixSha256 !== existing.file.committedPrefixSha256) {
        await event(ctx, "runs-file-rewritten", { runId: run.runId, storedPrefixHash: existing.file.committedPrefixSha256, presentedPrefixHash: args.previousPrefixSha256, storedVersion: existing.file.storedHash, presentedVersion: run.file.storedHash });
        return { ok: false as const, reason: "file rewritten" };
      }
      if (run.file.bytes < existing.file.bytes) {
        await event(ctx, "runs-file-shrank", { runId: run.runId, storedBytes: existing.file.bytes, presentedBytes: run.file.bytes, path: run.file.path });
        return { ok: false as const, reason: "file shrank" };
      }
      if (run.file.committedLine < existing.file.committedLine) return { ok: false as const, reason: "committed cursor regressed" };
      if (run.file.committedLine === existing.file.committedLine && run.file.committedPrefixSha256 !== existing.file.committedPrefixSha256) {
        await event(ctx, "runs-file-rewritten", { runId: run.runId, storedPrefixHash: existing.file.committedPrefixSha256, presentedPrefixHash: run.file.committedPrefixSha256, storedVersion: existing.file.storedHash, presentedVersion: run.file.storedHash });
        return { ok: false as const, reason: "file rewritten" };
      }
    }

    // Detect every collision before writing anything, so an immutable row never
    // leaves a partially-applied page behind.
    for (const row of args.rows) {
      const landed = await rowAt(ctx, run.runId, row.seq);
      if (landed && landed.digest !== row.digest) {
        await event(ctx, "runs-entry-mismatch", { runId: run.runId, seq: row.seq, storedDigest: landed.digest, presentedDigest: row.digest });
        return { ok: false as const, reason: "entry digest mismatch" };
      }
    }

    const repairNeeded = Boolean(existing && isStubFile(existing.file) && (existing.rootRunId !== run.rootRunId || existing.depth !== run.depth));
    const descendantRepairs = repairNeeded ? await descendantsForRepair(ctx, run.runId, run.rootRunId, run.depth) : [];
    if (descendantRepairs === null) return { ok: false as const, reason: "descendant repair too large" };

    const ingestedAt = Date.now();
    if (run.parentRunId && !knownParent) {
      await ctx.db.insert("runs", stub({ runId: run.parentRunId, rootRunId: run.parentRunId, depth: 0, linkKnown: true }, run, "unknown"));
    }
    if (!existing) {
      await ctx.db.insert("runs", { ...run, ingestedAt });
    } else {
      const advances = run.file.committedLine > existing.file.committedLine;
      const patch: Record<string, unknown> = { ingestedAt };
      if (advances || isStubFile(existing.file)) patch.file = run.file;
      if (advances || isStubFile(existing.file)) patch.attachments = run.attachments;
      // The envelope's fields arrive with a later page as readily as the first,
      // so registration repairs a run that was ingested before its launcher's
      // sidecar was claimed.
      for (const key of ["status", "outcome", "mode", "lastLineAt", "model", "sessionModel", "effort", "context", "runtimeVersion", "parserVersion", "continuesRunId", "todoId", "batchId", "mergeKey", "envelopeKey", "abandonedAt"] as const) if (run[key] !== undefined) patch[key] = run[key];
      if (run.sessionId !== undefined && existing.sessionId === undefined) patch.sessionId = run.sessionId;
      if (existing.kind === "unknown") patch.kind = run.kind;
      if (existing.origin === "unknown") patch.origin = run.origin;
      if (!existing.linkKnown && run.linkKnown && run.spawnedByToolUseId) { patch.linkKnown = true; patch.spawnedByToolUseId = run.spawnedByToolUseId; }
      if (isStubFile(existing.file)) Object.assign(patch, { parentRunId: run.parentRunId, rootRunId: run.rootRunId, depth: run.depth, host: run.host, runner: run.runner, startedAt: run.startedAt });
      await ctx.db.patch(existing._id, patch);
    }

    // The mutable run keeps the latest file pointer; this append-only table
    // keeps every verified version the nightly manifest must write exactly
    // once, including versions created in the same millisecond.
    if (!isStubFile(run.file) && run.file.storeKey !== undefined && !(await fileVersionAt(ctx, run.runId, run.file.storedHash))) {
      const prefix = `${run.runner}:${run.host}:`;
      await ctx.db.insert("runFileVersions", {
        runId: run.runId,
        runner: run.runner,
        host: run.host,
        threadId: run.runId.startsWith(prefix) ? run.runId.slice(prefix.length) : run.runId,
        depth: run.depth,
        parentRunId: run.parentRunId,
        fileVersion: run.file.storedHash,
        storeKey: run.file.storeKey,
        sourceHash: run.file.sourceHash,
        rawBytes: run.file.bytes,
        storedBytes: run.file.storedBytes,
        parserVersion: run.parserVersion,
        runtimeVersion: run.runtimeVersion,
        startedAt: run.startedAt,
        lastLineAt: run.lastLineAt,
        at: ingestedAt,
      });
    }

    for (const child of args.children) {
      if (!knownChildren.get(child.runId)) await ctx.db.insert("runs", stub(child, run, child.runId.startsWith("codex:") ? "codex-child" : "subagent"));
    }
    for (const repair of descendantRepairs) await ctx.db.patch(repair.id as never, { rootRunId: repair.rootRunId, depth: repair.depth });

    let inserted = 0, skipped = 0;
    for (const row of args.rows) {
      if (await rowAt(ctx, run.runId, row.seq)) { skipped += 1; continue; }
      await ctx.db.insert("claudeMessages", { runId: run.runId, seq: row.seq, turn: row.turn, kind: row.kind, content: row.content, provenance: row.provenance, digest: row.digest, depth: row.depth, parentToolUseId: row.parentToolUseId, createdAt: row.createdAt });
      inserted += 1;
    }
    // Three writers converge on this field; whoever is first wins, so a later
    // one never renames a session's run.
    if (run.sessionId) {
      const session = await ctx.db.get(run.sessionId);
      if (session && session.runId === undefined) await ctx.db.patch(run.sessionId, { runId: run.runId });
    }
    const landed = await runAt(ctx, run.runId);
    return { ok: true as const, runId: run.runId, inserted, skipped, committedLine: landed?.file.committedLine ?? run.file.committedLine };
  },
});

async function runIdLogPrefix(runId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(runId));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 12);
}
async function refuseOverflow(reason: string, where: { runId: string; seq: number; index?: number }) {
  console.warn(`runs overflow refused: ${reason} (run sha256:${await runIdLogPrefix(where.runId)}, seq ${where.seq}${where.index === undefined ? ")" : `, chunk ${where.index})`}`);
  return { ok: false as const, reason };
}
const chunkBytes = (text: string) => new TextEncoder().encode(text).length;
async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const internalIngestOverflow = internalMutation({
  args: { runId: v.string(), seq: v.number(), index: v.number(), chunkCount: v.number(), text: v.string() },
  handler: async (ctx, args) => {
    const where = { runId: args.runId, seq: args.seq, index: args.index };
    if (!validRunId(args.runId)) return await refuseOverflow("invalid runId", where);
    // Chunks may arrive before their row, but never before the run itself:
    // otherwise a misspelled id leaves uncollectable overflow behind.
    if (!(await runAt(ctx, args.runId))) return await refuseOverflow("no run", where);
    if (!nonNegativeInteger(args.seq) || !nonNegativeInteger(args.index) || !positiveInteger(args.chunkCount) || args.chunkCount > MAX_OVERFLOW_CHUNKS || args.index >= args.chunkCount) return await refuseOverflow("malformed chunk", where);
    if (chunkBytes(args.text) > 256 * 1024) return await refuseOverflow("chunk too large", where);
    const row = await rowAt(ctx, args.runId, args.seq);
    if (row?.overflow) return await refuseOverflow("row already stamped", where);
    const existing = await overflowAt(ctx, args.runId, args.seq, args.index);
    if (existing) {
      if (existing.chunkCount !== args.chunkCount || existing.text !== args.text) return await refuseOverflow("chunk already written", where);
      return { ok: true as const, index: args.index };
    }
    await ctx.db.insert("claudeMessageOverflow", { runId: args.runId, seq: args.seq, index: args.index, chunkCount: args.chunkCount, text: args.text, createdAt: Date.now() });
    return { ok: true as const, index: args.index };
  },
});

export const internalStampOverflow = internalMutation({
  args: { runId: v.string(), seq: v.number(), sha256: v.string(), byteLength: v.number(), chunkCount: v.number() },
  handler: async (ctx, args) => {
    const where = { runId: args.runId, seq: args.seq };
    if (!validRunId(args.runId)) return await refuseOverflow("invalid runId", where);
    if (!nonNegativeInteger(args.seq) || !positiveInteger(args.chunkCount) || args.chunkCount > MAX_OVERFLOW_CHUNKS || !nonNegativeInteger(args.byteLength) || !validHash(args.sha256)) return await refuseOverflow("malformed stamp", where);
    const row = await rowAt(ctx, args.runId, args.seq);
    if (!row) return await refuseOverflow("no message row", where);
    const stamp = { sha256: args.sha256, byteLength: args.byteLength, chunkCount: args.chunkCount };
    if (row.overflow) return row.overflow.sha256 === stamp.sha256 && row.overflow.byteLength === stamp.byteLength && row.overflow.chunkCount === stamp.chunkCount ? { ok: true as const, stamped: false } : await refuseOverflow("row already stamped", where);
    let text = "";
    for (let index = 0; index < args.chunkCount; index += 1) {
      const chunk = await overflowAt(ctx, args.runId, args.seq, index);
      if (!chunk || chunk.chunkCount !== args.chunkCount) return await refuseOverflow("chunks incomplete", where);
      text += chunk.text;
    }
    if (chunkBytes(text) !== args.byteLength || await sha256(text) !== args.sha256) return await refuseOverflow("chunk integrity mismatch", where);
    await ctx.db.patch(row._id, { overflow: stamp });
    return { ok: true as const, stamped: true };
  },
});

const SHADOW_IGNORED_KINDS = new Set(["context", "child-run"]);
const SHADOW_TEXT_KINDS = new Set(["user", "assistant-text", "thinking"]);

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "text" in content && typeof (content as { text?: unknown }).text === "string") {
    return (content as { text: string }).text;
  }
  try { return JSON.stringify(content); } catch { return ""; }
}

function normalizeTrailingWhitespace(text: string): string {
  return text.replace(/[ \t]+$/gm, "").replace(/\s+$/u, "");
}

type ShadowDigestRow = { seq: number; kind: string; digest: string };
type ShadowCount = { kind: string; daemon: number; file: number };
type ShadowState = {
  sessionId: Id<"claudeSessions">;
  runLastLineAt: number;
  daemonCursor: string | null;
  fileCursor: string | null;
  daemonDone: boolean;
  fileDone: boolean;
  daemonPending: ShadowDigestRow[];
  filePending: ShadowDigestRow[];
  counts: ShadowCount[];
  daemonRows: number;
  fileRows: number;
  daemonTextRows: number;
  fileTextRows: number;
  textMatches: number;
  firstDiffSeq?: number;
  daemonTextSha256: string;
  fileTextSha256: string;
};

const SHADOW_STATE = v.object({
  sessionId: v.id("claudeSessions"),
  runLastLineAt: v.number(),
  daemonCursor: v.union(v.string(), v.null()),
  fileCursor: v.union(v.string(), v.null()),
  daemonDone: v.boolean(),
  fileDone: v.boolean(),
  daemonPending: v.array(v.object({ seq: v.number(), kind: v.string(), digest: v.string() })),
  filePending: v.array(v.object({ seq: v.number(), kind: v.string(), digest: v.string() })),
  counts: v.array(v.object({ kind: v.string(), daemon: v.number(), file: v.number() })),
  daemonRows: v.number(),
  fileRows: v.number(),
  daemonTextRows: v.number(),
  fileTextRows: v.number(),
  textMatches: v.number(),
  firstDiffSeq: v.optional(v.number()),
  daemonTextSha256: v.string(),
  fileTextSha256: v.string(),
});

function addKindCount(state: ShadowState, side: "daemon" | "file", kind: string) {
  let count = state.counts.find((entry) => entry.kind === kind);
  if (!count) {
    count = { kind, daemon: 0, file: 0 };
    state.counts.push(count);
  }
  count[side] += 1;
}

async function addShadowPage(
  state: ShadowState,
  side: "daemon" | "file",
  rows: Array<{ seq: number; kind: string; content: unknown }>,
) {
  for (const row of rows) {
    if (SHADOW_IGNORED_KINDS.has(row.kind)) continue;
    addKindCount(state, side, row.kind);
    if (side === "daemon") state.daemonRows += 1;
    else state.fileRows += 1;
    if (!SHADOW_TEXT_KINDS.has(row.kind)) continue;
    const digest = await sha256(normalizeTrailingWhitespace(textContent(row.content)));
    const pending = side === "daemon" ? state.daemonPending : state.filePending;
    pending.push({ seq: row.seq, kind: row.kind, digest });
    if (side === "daemon") {
      state.daemonTextRows += 1;
      state.daemonTextSha256 = await sha256(`${state.daemonTextSha256}\n${row.kind}\n${digest}`);
    } else {
      state.fileTextRows += 1;
      state.fileTextSha256 = await sha256(`${state.fileTextSha256}\n${row.kind}\n${digest}`);
    }
  }
}

export const internalEligibleComparisons = internalQuery({
  args: {
    status: v.union(v.literal("ended"), v.literal("failed")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const comparisons = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", "runs-shadow-compare").gte("at", cutoff))
      .order("desc")
      .take(1000);
    const comparedAt = new Map<string, number>();
    for (const comparison of comparisons) {
      const data = comparison.data;
      if (!data || typeof data !== "object") continue;
      const result = data as { runId?: unknown; runStatus?: unknown };
      if (typeof result.runId !== "string" || (result.runStatus !== "ended" && result.runStatus !== "failed")) continue;
      if (!comparedAt.has(result.runId)) comparedAt.set(result.runId, comparison.at);
    }
    const page = await ctx.db
      .query("claudeSessions")
      .withIndex("by_status", (q) => q.eq("status", args.status).gte("statusChangedAt", cutoff))
      .order("asc")
      .paginate(args.paginationOpts);
    const eligible: Array<{ sessionId: Id<"claudeSessions">; runId: string }> = [];
    for (const session of page.page) {
      const runId = session.runId;
      if (!runId || session.rowsFrom === "runs") continue;
      const run = await ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", runId)).unique();
      // A clean comparison while the run was still unknown cannot authorize a
      // later cutover. Only terminal run rows enter the comparison pipeline.
      if (!run || (run.status !== "ended" && run.status !== "failed") || (comparedAt.get(run.runId) ?? -Infinity) >= run.lastLineAt) continue;
      eligible.push({ sessionId: session._id, runId: run.runId });
    }
    return {
      eligible,
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

// The comparison stays beside both row sets. Only counts and digests leave
// this transaction; transcript text is neither returned nor written to the
// event that the digest reads.
export const internalShadowCompare = internalMutation({
  args: { sessionId: v.id("claudeSessions"), state: v.optional(SHADOW_STATE) },
  handler: async (ctx, { sessionId, state: priorState }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) throw new Error("session not found");
    if (!session.runId) throw new Error("session has no run");
    const run = await runAt(ctx, session.runId);
    if (!run) throw new Error("run not found");
    if (run.status !== "ended" && run.status !== "failed") throw new Error("run is not terminal");

    const emptyDigest = await sha256("");
    const state: ShadowState = priorState && priorState.sessionId === sessionId && priorState.runLastLineAt === run.lastLineAt
      ? {
          ...priorState,
          daemonPending: priorState.daemonPending.map((row) => ({ ...row })),
          filePending: priorState.filePending.map((row) => ({ ...row })),
          counts: priorState.counts.map((count) => ({ ...count })),
        }
      : {
          sessionId,
          runLastLineAt: run.lastLineAt,
          daemonCursor: null,
          fileCursor: null,
          daemonDone: false,
          fileDone: false,
          daemonPending: [],
          filePending: [],
          counts: [],
          daemonRows: 0,
          fileRows: 0,
          daemonTextRows: 0,
          fileTextRows: 0,
          textMatches: 0,
          daemonTextSha256: emptyDigest,
          fileTextSha256: emptyDigest,
        };

    // Each invocation reads at most one 100-row page from each source. The
    // unmatched boundary rows are hashes only and stay bounded by one page.
    if (state.daemonPending.length === 0 && !state.daemonDone) {
      const page = await ctx.db
        .query("claudeMessages")
        .withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId))
        .order("asc")
        .paginate({ cursor: state.daemonCursor, numItems: 100 });
      await addShadowPage(state, "daemon", page.page);
      state.daemonDone = page.isDone;
      state.daemonCursor = page.isDone ? null : page.continueCursor;
    }
    if (state.filePending.length === 0 && !state.fileDone) {
      const page = await ctx.db
        .query("claudeMessages")
        .withIndex("by_run_seq", (q) => q.eq("runId", session.runId))
        .order("asc")
        .paginate({ cursor: state.fileCursor, numItems: 100 });
      await addShadowPage(state, "file", page.page);
      state.fileDone = page.isDone;
      state.fileCursor = page.isDone ? null : page.continueCursor;
    }

    while (state.daemonPending.length > 0 && state.filePending.length > 0) {
      const daemonRow = state.daemonPending.shift()!;
      const fileRow = state.filePending.shift()!;
      if (daemonRow.kind === fileRow.kind && daemonRow.digest === fileRow.digest) state.textMatches += 1;
      else if (state.firstDiffSeq === undefined) state.firstDiffSeq = fileRow.seq;
    }
    if (state.daemonDone && state.daemonPending.length === 0 && state.filePending.length > 0) {
      if (state.firstDiffSeq === undefined) state.firstDiffSeq = state.filePending[0].seq;
      state.filePending = [];
    }
    if (state.fileDone && state.filePending.length === 0 && state.daemonPending.length > 0) {
      if (state.firstDiffSeq === undefined) state.firstDiffSeq = state.daemonPending[0].seq;
      state.daemonPending = [];
    }

    if (!state.daemonDone || !state.fileDone || state.daemonPending.length > 0 || state.filePending.length > 0) {
      return { complete: false as const, runId: run.runId, daemonRows: state.daemonRows, fileRows: state.fileRows, state };
    }

    const byKind: Record<string, { daemon: number; file: number }> = Object.fromEntries(
      [...state.counts]
        .sort((left, right) => left.kind.localeCompare(right.kind))
        .map(({ kind, daemon, file }) => [kind, { daemon, file }]),
    );
    const textRows = Math.max(state.daemonTextRows, state.fileTextRows);
    const clean = Object.values(byKind).every((count) => count.daemon === count.file) && state.firstDiffSeq === undefined;
    const result = {
      complete: true as const,
      runId: run.runId,
      runStatus: run.status,
      daemonRows: state.daemonRows,
      fileRows: state.fileRows,
      byKind,
      textRows,
      textMatches: state.textMatches,
      ...(state.firstDiffSeq === undefined ? {} : { firstDiffSeq: state.firstDiffSeq }),
      daemonTextSha256: state.daemonTextSha256,
      fileTextSha256: state.fileTextSha256,
      clean,
    };

    await event(ctx, "runs-shadow-compare", result);
    const runPatch: Record<string, unknown> = {};
    if (clean) {
      const cutoverAt = run.cutoverAt ?? Date.now();
      if (session.rowsFrom !== "runs") await ctx.db.patch(sessionId, { rowsFrom: "runs" });
      if (run.cutoverAt === undefined) runPatch.cutoverAt = cutoverAt;
    }
    if (Object.keys(runPatch).length > 0) await ctx.db.patch(run._id, runPatch);
    return result;
  },
});

// The nightly writer consumes immutable manifest lines, not database rows.
// Pagination remains over the source index even when a page contains stubs
// with no verified store key, so its cursor always advances.
export const internalManifest = internalQuery({
  args: {
    since: v.number(),
    afterRunId: v.optional(v.string()),
    afterFileVersion: v.optional(v.string()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, { since, afterRunId, afterFileVersion, cursor }) => {
    if ((afterRunId === undefined) !== (afterFileVersion === undefined)) {
      throw new Error("manifest checkpoint requires runId and fileVersion together");
    }
    const hasCompositeCheckpoint = afterRunId !== undefined && afterFileVersion !== undefined;
    const page = await ctx.db
      .query("runFileVersions")
      .withIndex("by_at_and_run_id_and_file_version", (q) => hasCompositeCheckpoint ? q.gte("at", since) : q.gt("at", since))
      .order("asc")
      .paginate({ numItems: 200, cursor: cursor ?? null });
    return {
      entries: page.page
        .filter((version) => !hasCompositeCheckpoint || version.at > since || version.runId > afterRunId || (version.runId === afterRunId && version.fileVersion > afterFileVersion))
        .map((version) => ({
          run_id: version.runId,
          runner: version.runner,
          host: version.host,
          thread_id: version.threadId,
          depth: version.depth,
          parent_run_id: version.parentRunId ?? null,
          file_version: version.fileVersion,
          store_key: version.storeKey,
          source_sha256: version.sourceHash,
          raw_bytes: version.rawBytes,
          stored_bytes: version.storedBytes,
          parser_version: version.parserVersion,
          runtime_version: version.runtimeVersion ?? null,
          started_at: version.startedAt,
          last_line_at: version.lastLineAt,
          at: version.at,
        })),
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

function assertRunId(runId: string) {
  if (!validRunId(runId)) throw new Error("invalid runId");
}

export const get = query({ args: { runId: v.string() }, handler: async (ctx, args) => { await requireTomForRuns(ctx); assertRunId(args.runId); return await ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", args.runId)).first(); } });
export const children = query({
  args: { runId: v.string(), cursor: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireTomForRuns(ctx);
    assertRunId(args.runId);
    const limit = args.limit ?? 100;
    if (!positiveInteger(limit) || limit > 500) throw new Error("children limit must be an integer from 1 to 500");
    const page = await ctx.db.query("runs").withIndex("by_parent", (q) => q.eq("parentRunId", args.runId)).paginate({ cursor: args.cursor ?? null, numItems: limit });
    return { items: page.page, nextCursor: page.isDone ? null : page.continueCursor };
  },
});
export const rows = query({ args: { runId: v.string(), paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => { await requireTomForRuns(ctx); assertRunId(args.runId); const page = await ctx.db.query("claudeMessages").withIndex("by_run_seq", (q) => q.eq("runId", args.runId)).order("asc").paginate(args.paginationOpts); return { ...page, page: page.page.map((row) => ({ ...row, hasOverflow: row.overflow !== undefined, fullByteLength: row.overflow?.byteLength })) }; } });
export const entry = query({ args: { runId: v.string(), seq: v.number() }, handler: async (ctx, args) => { await requireTomForRuns(ctx); assertRunId(args.runId); if (!nonNegativeInteger(args.seq)) throw new Error("invalid seq"); const row = await ctx.db.query("claudeMessages").withIndex("by_run_seq", (q) => q.eq("runId", args.runId).eq("seq", args.seq)).first(); return row ? { provenance: row.provenance, content: row.content, overflow: row.overflow, digest: row.digest } : null; } });

export const internalBackfillRunIds = internalMutation({
  args: { cursor: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 200;
    if (!positiveInteger(limit) || limit > 500) throw new Error("backfill limit must be an integer from 1 to 500");
    const page = await ctx.db.query("claudeSessions").withIndex("by_createdAt").order("asc").paginate({ cursor: args.cursor ?? null, numItems: limit });
    let patched = 0;
    for (const session of page.page) {
      const runId = session.sdkSessionId ? `claude:box:${session.sdkSessionId}` : undefined;
      if (runId && !session.runId && validRunId(runId)) { await ctx.db.patch(session._id, { runId }); patched += 1; }
    }
    return { scanned: page.page.length, patched, cursor: page.isDone ? null : page.continueCursor };
  },
});
