import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireTom } from "./authRoles";
import { LIVE_STATUSES, SESSION_MODEL, nyLocalHour } from "./ttsShared";
import { redactSecrets } from "../shared/redact.mjs";
import { inboundRowIdOf } from "./sessionRows";

const AGENT_KIND = v.union(
  v.literal("session"), v.literal("job"), v.literal("delegate"),
  v.literal("subagent"), v.literal("codex-child"), v.literal("runner-step"), v.literal("unknown"),
);
// Where a run ran: a session Tom talks to, a worker nobody watches, a
// runner, or the orchestrator that hands work out. Named by the launcher's
// envelope, else inherited from the parent row.
const AGENT_ENVIRONMENT = v.union(v.literal("session"), v.literal("worker"), v.literal("runner"), v.literal("orchestrator"));
type AgentEnvironment = "session" | "worker" | "runner" | "orchestrator";
const AGENT_CLI = v.union(v.literal("claude"), v.literal("codex"));
type AgentCli = "claude" | "codex";
const AGENT_STATUS = v.union(v.literal("running"), v.literal("ended"), v.literal("failed"), v.literal("abandoned"), v.literal("unknown"));
const AGENT_MODE = v.union(v.literal("interactive"), v.literal("autonomous"));
const ROW_KIND = v.union(
  v.literal("user"), v.literal("assistant-text"), v.literal("thinking"),
  v.literal("tool-call"), v.literal("tool-result"), v.literal("permission"),
  v.literal("system"), v.literal("error"), v.literal("child-run"), v.literal("context"),
);
const FILE = v.object({
  path: v.string(), sourceHash: v.string(), storedHash: v.string(), bytes: v.number(), storedBytes: v.number(),
  committedLine: v.number(), committedPrefixSha256: v.string(), sidecarStoredHash: v.optional(v.string()),
  storeKey: v.optional(v.string()), incompleteTail: v.optional(v.boolean()),
  // The whole file's length, written only by a reader that saw the whole file:
  // the backlog importer (which keeps no rows) and the materialize job. This
  // validator is strict, so without the field here every such ingest is refused.
  totalLines: v.optional(v.number()),
});
// The run's answer to "where did these rows come from, and what is missing".
const ROWS_SOURCE = v.object({
  from: v.literal("store"), at: v.number(), parserVersion: v.string(), storeKey: v.string(),
  rowsFromLine: v.number(), rowsToLine: v.number(), slices: v.number(), droppedLines: v.number(),
  partial: v.array(v.string()),
});
const ATTACHMENT = v.object({ file: v.string(), bytes: v.number(), sha256: v.string() });
const CONTEXT = v.object({
  wikitomCommit: v.optional(v.string()), layersKnown: v.boolean(), layersGiven: v.array(v.string()), layersDenied: v.array(v.string()),
  skillsOffered: v.array(v.string()), skillsUsed: v.array(v.string()), tools: v.array(v.string()), hooks: v.array(v.string()),
  cwd: v.optional(v.string()), gitBranch: v.optional(v.string()), gitCommit: v.optional(v.string()), baseInstructionsHash: v.optional(v.string()),
  entrypoint: v.optional(v.string()), originator: v.optional(v.string()), permissionMode: v.optional(v.string()), contextWindow: v.optional(v.number()),
  registered: v.optional(v.boolean()), launcher: v.optional(v.string()), modelRequested: v.optional(v.string()),
  skillsGranted: v.optional(v.array(v.string())), skillsRefused: v.optional(v.array(v.string())),
  promptSha256: v.optional(v.string()), writingStandardSource: v.optional(v.string()), workflowId: v.optional(v.string()),
  // What the run ASKED FOR, as "<name> (<result>)" — the Skill tool calls its
  // transcript holds, beside skillsGranted, which is what the prompt offered
  // it. Same field as convex/schema.ts runs.context; a run carrying it is
  // refused at store time without it here. NO WRITER SENDS IT ANY MORE since
  // Jarvis's registration change of 2026-09-25; it stays accepted because
  // stored rows carry it and the schema is additive-only.
  skillsAsked: v.optional(v.array(v.string())),
  // The graph version a run ran under, and the exact node ids its prompt
  // carried — the `given` edges. ABSENT IS A SUPPORTED VALUE, as it is for
  // wikitomCommit and regToken: an unregistered run, and a run whose launcher
  // could not build a graph, carry nothing, and nothing is inferred from that.
  graphVersion: v.optional(v.string()),
  graphNodes: v.optional(v.array(v.string())),
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
const AGENT = v.object({
  runId: v.string(), parentRunId: v.optional(v.string()), rootRunId: v.string(), depth: v.number(), spawnedByToolUseId: v.optional(v.string()), linkKnown: v.boolean(),
  origin: v.string(), continuesRunId: v.optional(v.string()), host: v.union(v.literal("laptop"), v.literal("box")),
  // The CLI family the run ran under.
  cli: AGENT_CLI,
  environment: v.optional(AGENT_ENVIRONMENT),
  model: v.optional(v.string()), sessionModel: v.optional(SESSION_MODEL), effort: v.optional(v.string()), runtimeVersion: v.optional(v.string()), parserVersion: v.string(), kind: AGENT_KIND, status: AGENT_STATUS,
  mode: v.optional(AGENT_MODE), startedAt: v.number(), lastLineAt: v.number(), context: v.optional(CONTEXT), outcome: v.optional(OUTCOME), attachments: v.array(ATTACHMENT),
  // batchId stays accepted while a box that has not rolled out still sends it;
  // nothing reads it, and the schema narrow removes it.
  todoId: v.optional(v.id("dtsTodos")), batchId: v.optional(v.id("batches")), mergeKey: v.optional(v.string()), sessionId: v.optional(v.id("claudeSessions")),
  regToken: v.optional(v.string()),
  envelopeKey: v.optional(v.string()), cutoverAt: v.optional(v.number()), abandonedAt: v.optional(v.number()), file: FILE,
});
const PROVENANCE = v.object({ fileVersion: v.string(), file: v.string(), lineStart: v.number(), lineEnd: v.number(), block: v.number(), parserVersion: v.string(), sourceKind: v.string() });
const ROW = v.object({
  seq: v.number(), turn: v.number(), kind: ROW_KIND, content: v.any(), provenance: PROVENANCE, digest: v.string(), depth: v.number(), parentToolUseId: v.optional(v.string()),
  overflow: v.optional(v.object({ sha256: v.string(), byteLength: v.number(), chunkCount: v.number() })), createdAt: v.number(),
});
const CHILD = v.object({ runId: v.string(), parentRunId: v.string(), rootRunId: v.string(), depth: v.number(), spawnedByToolUseId: v.optional(v.string()), linkKnown: v.boolean() });

const AGENT_ID = /^(claude|codex):(laptop|box):[A-Za-z0-9._-]{8,128}(\/[A-Za-z0-9._-]{8,128})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_DESCENDANT_REPAIR = 500;
const MAX_OVERFLOW_CHUNKS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How long a run's rows stay in the record after its last line — or after Tom
 * last opened it. Read at CALL time, not at import time: a deployment variable
 * changed between deploys must take effect without a module reload, and a test
 * that stubs it must not depend on import order.
 */
function rowWindowMs(): number {
  const days = Number(process.env.AGENTS_ROW_WINDOW_DAYS ?? 30);
  return (Number.isFinite(days) && days > 0 ? days : 30) * DAY_MS;
}
/** Eviction is OFF unless the deployment says otherwise — also read at call time. */
function evictionEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env.AGENTS_EVICTION_ENABLED ?? ""));
}

// One click must not become an hour of mutations: a request ingests at most one
// slice, and a run stops after five of them and says so.
const MAX_SLICES = 5;
const EVICT_AGENTS_PER_TICK = 20;
const EVICT_ROWS_PER_STEP = 200;
const EVICT_MAX_STEPS = 200;
const MAX_REASON_LENGTH = 200;

// Both vocabularies are closed. The box answers with a fixed phrase so a
// transcript, a path or a bucket error can never be reflected into the record.
const MATERIALIZE_REASONS = new Set([
  "object missing from store", "object hash mismatch", "store unreachable",
  "no store key", "file too large", "parse produced no rows", "agent is gone",
]);
const MATERIALIZE_PARTIAL = new Set([
  "sidecar-missing", "no-envelope", "pre-parser-fields",
  "unknown-line-types", "row-cap-reached", "incomplete-tail",
  // The store keeps an agent's newest file version and retains older ones
  // away; a request for a version no longer held is served from the newest
  // one, and the answer says so rather than passing it off as the one asked for.
  "served-newer-version",
]);

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && value > 0;
}
function validHash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}
function validAgentId(runId: unknown): runId is string {
  return typeof runId === "string" && AGENT_ID.test(runId);
}
function agentIdMatches(runId: string, cli: AgentCli, host: "laptop" | "box") {
  return runId.startsWith(`${cli}:${host}:`);
}
export function isStubFile(file: { path: string; sourceHash: string; storedHash: string; bytes: number; storedBytes: number; committedLine: number; committedPrefixSha256: string }) {
  return file.path === "" && file.sourceHash === "" && file.storedHash === "" && file.bytes === 0 && file.storedBytes === 0 && file.committedLine === 0 && file.committedPrefixSha256 === "";
}
/**
 * What the record holds for a file, said out loud on a refusal.
 *
 * A rewrite refusal is the record telling a sweeper that the prefix it
 * presented is not the prefix the record committed. Until this field existed
 * the sweeper was told only THAT, never WHERE the record stands, so a sweeper
 * whose own cursor had gone missing had no way back: it presented line 0 of a
 * file the record had already committed, was refused — correctly — and
 * dead-lettered every page of that run for good. The cursor is a fact about
 * the caller's own file and the caller is already authenticated to write it,
 * so naming it costs nothing and is the only thing that can end the stall.
 */
function heldCursor(file: { committedLine: number; committedPrefixSha256: string }) {
  return { committedLine: file.committedLine, committedPrefixSha256: file.committedPrefixSha256 };
}
function validFile(file: {
  path: string; sourceHash: string; storedHash: string; bytes: number; storedBytes: number; committedLine: number; committedPrefixSha256: string; sidecarStoredHash?: string;
}) {
  if (isStubFile(file)) return file.sidecarStoredHash === undefined;
  return file.path !== "" && validHash(file.sourceHash) && validHash(file.storedHash) && nonNegativeInteger(file.bytes) && nonNegativeInteger(file.storedBytes) && nonNegativeInteger(file.committedLine) && validHash(file.committedPrefixSha256) && (file.sidecarStoredHash === undefined || validHash(file.sidecarStoredHash));
}

async function agentAt(ctx: QueryCtx | MutationCtx, runId: string) {
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

// A PLACEHOLDER'S HOST AND CLI COME FROM THE ID IT IS STUBBING, never from
// the run that revealed it. A cross-host parent link is ordinary now — the
// laptop orchestrator spawns box runs through worker/agents/launcher.mjs, which
// names the laptop session as the box run's parent — so taking them from the
// revealing run would record a laptop session as a box run, and the sessions
// view would show Tom that false fact. agentIdMatches already requires a run id
// to name its own host and CLI, so the id is the honest source and both
// call sites (a parent stub and a child stub) are right by the same rule.
// parserVersion and the timestamps stay with the revealing run: it is the only
// evidence of when the placeholder's run was alive. The environment stays with
// it too, for the same reason: no id names one, and a child runs where its
// parent runs until an envelope of its own says otherwise.
function stub(run: { runId: string; parentRunId?: string; rootRunId: string; depth: number; spawnedByToolUseId?: string; linkKnown: boolean }, evidence: { parserVersion: string; lastLineAt: number; environment: AgentEnvironment }, kind: "subagent" | "codex-child" | "unknown") {
  const host: "laptop" | "box" = run.runId.startsWith("claude:laptop:") || run.runId.startsWith("codex:laptop:") ? "laptop" : "box";
  const cli: AgentCli = run.runId.startsWith("codex:") ? "codex" : "claude";
  return {
    ...run, host, cli, kind, status: "unknown" as const, origin: "unknown", parserVersion: evidence.parserVersion,
    environment: evidence.environment,
    startedAt: evidence.lastLineAt, lastLineAt: evidence.lastLineAt, attachments: [],
    file: { path: "", sourceHash: "", storedHash: "", bytes: 0, storedBytes: 0, committedLine: 0, committedPrefixSha256: "" }, ingestedAt: Date.now(),
  };
}

// `runner:<id>` is a runner's step run: the id is the runners row it belongs
// to, which is how the agents page names the runner beside the chain.
// `desktop` is a box session no launcher started, which scripts/agent-hook.mjs
// records as Tom's: his laptop app's Code tab over ssh, or `claude` typed there.
// REMOVAL CHECK: the list is the ingest's refusal of an origin nobody wrote on
// purpose; without this entry every desktop session's row is refused.
function validOrigin(origin: string) {
  return ["session", "planner", "nightly", "weekly", "delegate", "job", "daemon", "hook", "laptop", "desktop", "workflow", "unknown"].includes(origin) || /^cron:[\w.-]{1,64}$/.test(origin) || /^runner:[a-z0-9]{1,64}$/.test(origin);
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

function validAgentPayload(run: {
  runId: string; parentRunId?: string; rootRunId: string; depth: number; spawnedByToolUseId?: string; linkKnown: boolean; origin: string; continuesRunId?: string; host: "laptop" | "box"; cli?: AgentCli; kind: string; mode?: "interactive" | "autonomous"; startedAt: number; lastLineAt: number; context?: { baseInstructionsHash?: string; contextWindow?: number }; outcome?: Parameters<typeof validOutcome>[0]; attachments: { file: string; bytes: number; sha256: string }[]; file: Parameters<typeof validFile>[0];
}) {
  // ONLY AN AGENT'S OWN ID MUST NAME ITS OWN HOST AND CLI. The edge ids may
  // name another: worker/agents/launcher.mjs makes a laptop session the parent of
  // a box run, so that run's parentRunId and rootRunId are laptop ids and
  // holding them to the child's host would refuse the whole record. They are
  // still checked as ids, and the root rule below — a run with no parent must
  // be its own root — keeps a root's own id and its rootRunId in agreement.
  const cli = run.cli;
  if (cli === undefined || !validAgentId(run.runId) || !validAgentId(run.rootRunId) || !agentIdMatches(run.runId, cli, run.host)) return false;
  if (run.parentRunId !== undefined && !validAgentId(run.parentRunId)) return false;
  if (run.continuesRunId !== undefined && !validAgentId(run.continuesRunId)) return false;
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
    const found = await agentAt(ctx, current);
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

/**
 * The assistant-text row immediately BEFORE `seq` in this run — the output a
 * reply landing at `seq` is about, and the start of the span its label
 * carries (convex/agentLabels.ts).
 *
 * Bounded rather than unbounded: an opening turn has no assistant row before
 * it at all, and a run whose last hundred rows are tool traffic is a run
 * where the reply is not answering any one thing the agent said. Undefined
 * then, and the label carries no span — never a span starting at zero, which
 * would read as "the whole run".
 */
const PRIOR_ASSISTANT_SCAN = 100;

async function priorAssistantRowSeq(ctx: MutationCtx, runId: string, seq: number): Promise<number | undefined> {
  const before = await ctx.db
    .query("claudeMessages")
    .withIndex("by_run_seq", (q) => q.eq("runId", runId).lt("seq", seq))
    .order("desc")
    .take(PRIOR_ASSISTANT_SCAN);
  return before.find((row) => row.kind === "assistant-text")?.seq;
}

/**
 * A TURN TOM TYPED BECOMES A LABEL WHEN ITS ROW LANDS. The daemon ends every
 * turn Tom typed with an `inbound row: <id>` line (convex/sessionRows.ts
 * inboundRowIdOf), so the agent file's user row names the claudeInbound row it
 * delivered. That line is text in a file, and text can be copied into any
 * run's prompt, so it is an edge only when every fact agrees:
 *
 *   - the id names a claudeInbound row that is a user turn authored by Tom
 *     (an agent's own turn writing a label would put an unreviewed verdict
 *     into the corpus the golden set is mined from);
 *   - this run is a root (depth 0), and it is the run that row's session
 *     names (`session.runId === run.runId`).
 *
 * A copied line in another run's prompt fails the second test and writes
 * nothing. The label's text is the inbound row's (Tom's words alone, without
 * the id line), its time is when he typed it, and its span is in this run's
 * own seq space.
 */
async function sessionReplyLabel(ctx: MutationCtx, run: Doc<"runs">, seq: number, content: unknown) {
  if (run.depth !== 0) return;
  const id = inboundRowIdOf(content);
  const inboundId = id === null ? null : ctx.db.normalizeId("claudeInbound", id);
  if (inboundId === null) return;
  const inbound = await ctx.db.get(inboundId);
  if (inbound === null || inbound.kind !== "user-turn" || inbound.author !== "tom" || typeof inbound.text !== "string") return;
  const session = await ctx.db.get(inbound.sessionId);
  if (session === null || session.runId !== run.runId) return;
  const priorAssistantSeq = await priorAssistantRowSeq(ctx, run.runId, seq);
  await ctx.scheduler.runAfter(0, internal.agentLabels.internalLabelFromSessionReply, {
    runId: run.runId,
    inboundId,
    seq,
    text: inbound.text,
    at: inbound.createdAt,
    ...(priorAssistantSeq === undefined ? {} : { priorAssistantSeq }),
  });
}

export const internalIngest = internalMutation({
  args: { run: AGENT, rows: v.array(ROW), children: v.array(CHILD), previousCommittedLine: v.number(), previousPrefixSha256: v.string() },
  handler: async (ctx, args) => {
    if (!validAgentPayload(args.run) || !nonNegativeInteger(args.previousCommittedLine) || !validHash(args.previousPrefixSha256)) return { ok: false as const, reason: "invalid run record" };
    if (args.rows.length > 200) return { ok: false as const, reason: "too many rows" };

    // ONE TOKEN, ONE AGENT. The registration token sits in the prompt's
    // registration block, so a prompt copied into another agent carries the
    // first agent's token, and a label or a produced-by edge that follows the
    // token would land on the wrong agent. The first agent to reach the record
    // with a token keeps it; a page from any other agent carrying it is
    // refused before anything is written, with a fixed phrase like every
    // other refusal here, and one event names both agents and the token's
    // first eight characters, never the whole token. Returning rather than
    // throwing is what lets that event commit.
    if (args.run.regToken !== undefined) {
      const token = args.run.regToken;
      const holders = await ctx.db.query("runs").withIndex("by_reg_token", (q) => q.eq("regToken", token)).take(8);
      const holder = holders.find((row) => row.runId !== args.run.runId);
      if (holder) {
        await event(ctx, "agents-token-duplicate", { agentId: args.run.runId, heldByAgentId: holder.runId, tokenPrefix: token.slice(0, 8) });
        return { ok: false as const, reason: "token held by another agent" };
      }
    }

    const existing = await agentAt(ctx, args.run.runId);
    const knownParent = args.run.parentRunId ? await agentAt(ctx, args.run.parentRunId) : null;
    let rootRunId = args.run.rootRunId;
    let depth = args.run.depth;
    if (existing && !isStubFile(existing.file)) {
      if (existing.parentRunId !== args.run.parentRunId) return { ok: false as const, reason: "parent cannot change" };
      rootRunId = existing.rootRunId;
      depth = existing.depth;
    } else if (!args.run.parentRunId) {
      if (args.run.rootRunId !== args.run.runId || args.run.depth !== 0 || !args.run.linkKnown) return { ok: false as const, reason: "invalid root run" };
    } else if (knownParent && !isStubFile(knownParent.file)) {
      rootRunId = knownParent.rootRunId;
      depth = knownParent.depth + 1;
    }
    // Anything else — a parent nobody has swept yet — keeps the depth and the
    // root the CLI's own sidecar gave this run. The sweep reaches a grandchild
    // before its parent whenever the file names sort that way, and deriving a
    // position from a parent that is not there yet made every row of a deeper
    // run fail the row-depth check that stood below, which dead-lettered the
    // whole run on a permanent 400.
    //
    // A ROW TAKES THE DEPTH THE RECORD GIVES ITS AGENT, not the depth the page
    // says. The file knows only that it sits one level under its parent; the
    // record knows where that parent sits. A Codex child whose parent a Claude
    // box run launched is depth 2 here and depth 1 in its own file, and the
    // check that refused a row at any other depth than its run's dead-lettered
    // six such children on 2026-09-19.
    let linked = { ...args.run, rootRunId, depth };
    // A box Claude root has the same CLI id as its live session. Resolve that
    // exact join in the ingest transaction so a missed daemon stamp repairs
    // itself without a second worker round trip.
    if (linked.sessionId === undefined && linked.cli === "claude" && linked.host === "box" && linked.depth === 0) {
      const sdkSessionId = linked.runId.slice("claude:box:".length);
      if (linked.runId.startsWith("claude:box:") && sdkSessionId !== "" && !sdkSessionId.includes("/")) {
        const session = await ctx.db
          .query("claudeSessions")
          .withIndex("by_sdk_session_id", (q) => q.eq("sdkSessionId", sdkSessionId))
          .unique();
        if (session) linked = { ...linked, sessionId: session._id };
      }
    }
    // A box root is linked by the session row that names its run. A Codex
    // session needs it: the daemon reports the rollout's id as the session's
    // runId, and its sdkSessionId is a Codex thread id rather than a Claude
    // one, so the Claude join above cannot find it. A Claude root whose
    // session names it but whose SDK id the join above missed takes it too.
    if (linked.sessionId === undefined && linked.host === "box" && linked.depth === 0) {
      const session = await ctx.db
        .query("claudeSessions")
        .withIndex("by_run_id", (q) => q.eq("runId", linked.runId))
        .first();
      if (session) linked = { ...linked, sessionId: session._id };
    }
    const linkedSession = linked.sessionId === undefined ? null : await ctx.db.get(linked.sessionId);
    // A reopened or forked session names the run it continues. Its next run
    // takes that link; the run it names never does, so a late page of the old
    // run cannot link to itself.
    if (linkedSession !== null && linked.continuesRunId === undefined) {
      if (linkedSession.continuesRunId !== undefined && linkedSession.continuesRunId !== linked.runId) linked = { ...linked, continuesRunId: linkedSession.continuesRunId };
    }

    // A SESSION'S ROOT RUN TAKES WHAT THE SESSION ROW SAYS where the file
    // says nothing. The session row is the fact: this run is a session Tom
    // talks to, and it has ended when its session has. The agent file of a
    // session from before the envelope, or one the sweep reads long after it
    // ended (the backfill of the old sessions), carries no environment, no
    // kind and no end marker, and without this every such run would read as
    // an unknown worker, or as abandoned.
    const sessionRoot = linkedSession !== null && linked.depth === 0 ? linkedSession : null;
    // The envelope names the environment; a run without one runs where its
    // parent ran; a session's root runs in the session; failing those, a row
    // already in the record keeps its own. Only then is it a worker, and that
    // guess is counted below. A row the record defaulted to worker before its
    // session was known is not a named environment, so the session corrects it.
    const inherited = knownParent?.environment ?? existing?.environment;
    const fromSession = args.run.environment === undefined && knownParent?.environment === undefined
      && sessionRoot !== null && (inherited === undefined || inherited === "worker");
    const environment: AgentEnvironment = args.run.environment ?? (fromSession ? "session" : inherited ?? "worker");
    const environmentDefaulted = args.run.environment === undefined && inherited === undefined && !fromSession;
    const kind = sessionRoot !== null && linked.kind === "unknown" ? "session" as const : linked.kind;
    // A RUN A SESSION NAMES IS NEVER ABANDONED WHILE ITS SESSION HAS ENDED.
    // Abandoned means the file stopped with no ending; a session that ended or
    // failed is that ending. A file that says it ended or failed keeps its own
    // word; a session with no ending leaves the file's status as it is.
    const sessionEnded = sessionRoot !== null && (sessionRoot.status === "ended" || sessionRoot.status === "failed")
      && (linked.status === "unknown" || linked.status === "running" || linked.status === "abandoned");
    const run = sessionEnded && sessionRoot !== null
      ? { ...linked, environment, kind, status: sessionRoot.status as "ended" | "failed", abandonedAt: undefined }
      : { ...linked, environment, kind };

    let previous = -1;
    for (const row of args.rows) {
      if (!validRow(row) || row.seq <= previous) return { ok: false as const, reason: "invalid run row" };
      if (row.overflow !== undefined) return { ok: false as const, reason: "overflow must be stamped separately" };
      if (row.provenance.fileVersion !== run.file.storedHash) return { ok: false as const, reason: "row file version mismatch" };
      previous = row.seq;
    }

    const cycleLength = await parentCycleLength(ctx, run.runId, run.parentRunId);
    if (cycleLength) {
      await event(ctx, "agents-parent-cycle", { runId: run.runId, parentRunId: run.parentRunId, chainLength: cycleLength });
      return { ok: false as const, reason: "parent cycle" };
    }

    const knownChildren = new Map<string, Awaited<ReturnType<typeof agentAt>>>();
    const childIds = new Set<string>();
    for (const child of args.children) {
      if (!validAgentId(child.runId) || !validAgentId(child.parentRunId) || !validAgentId(child.rootRunId) || !nonNegativeInteger(child.depth) || child.runId === run.runId || child.parentRunId !== run.runId || child.rootRunId !== run.rootRunId || child.depth !== run.depth + 1 || (child.linkKnown && !child.spawnedByToolUseId) || childIds.has(child.runId)) return { ok: false as const, reason: "invalid child edge" };
      const childCycleLength = await parentCycleLength(ctx, child.runId, run.runId);
      if (childCycleLength) {
        await event(ctx, "agents-parent-cycle", { runId: child.runId, parentRunId: run.runId, chainLength: childCycleLength });
        return { ok: false as const, reason: "parent cycle" };
      }
      const knownChild = await agentAt(ctx, child.runId);
      if (knownChild?.parentRunId !== undefined && knownChild.parentRunId !== run.runId) return { ok: false as const, reason: "child parent mismatch" };
      knownChildren.set(child.runId, knownChild);
      childIds.add(child.runId);
    }

    // The tuple is a compare-and-swap fence, not a hint about the page being
    // appended. It catches a rewritten old prefix even when this page also has
    // later lines, before this mutation changes any record row.
    if (existing && !isStubFile(existing.file)) {
      if (args.previousCommittedLine !== existing.file.committedLine || args.previousPrefixSha256 !== existing.file.committedPrefixSha256) {
        await event(ctx, "agents-file-rewritten", { runId: run.runId, storedPrefixHash: existing.file.committedPrefixSha256, presentedPrefixHash: args.previousPrefixSha256, storedVersion: existing.file.storedHash, presentedVersion: run.file.storedHash });
        return { ok: false as const, reason: "file rewritten", ...heldCursor(existing.file) };
      }
      if (run.file.bytes < existing.file.bytes) {
        await event(ctx, "agents-file-shrank", { runId: run.runId, storedBytes: existing.file.bytes, presentedBytes: run.file.bytes, path: run.file.path });
        return { ok: false as const, reason: "file shrank" };
      }
      if (run.file.committedLine < existing.file.committedLine) return { ok: false as const, reason: "committed cursor regressed" };
      if (run.file.committedLine === existing.file.committedLine && run.file.committedPrefixSha256 !== existing.file.committedPrefixSha256) {
        await event(ctx, "agents-file-rewritten", { runId: run.runId, storedPrefixHash: existing.file.committedPrefixSha256, presentedPrefixHash: run.file.committedPrefixSha256, storedVersion: existing.file.storedHash, presentedVersion: run.file.storedHash });
        return { ok: false as const, reason: "file rewritten", ...heldCursor(existing.file) };
      }
    }

    // Detect every collision before writing anything, so an immutable row never
    // leaves a partially-applied page behind.
    for (const row of args.rows) {
      const landed = await rowAt(ctx, run.runId, row.seq);
      if (landed && landed.digest !== row.digest) {
        await event(ctx, "agents-entry-mismatch", { runId: run.runId, seq: row.seq, storedDigest: landed.digest, presentedDigest: row.digest });
        return { ok: false as const, reason: "entry digest mismatch" };
      }
    }

    const repairNeeded = Boolean(existing && isStubFile(existing.file) && (existing.rootRunId !== run.rootRunId || existing.depth !== run.depth));
    const descendantRepairs = repairNeeded ? await descendantsForRepair(ctx, run.runId, run.rootRunId, run.depth) : [];
    if (descendantRepairs === null) return { ok: false as const, reason: "descendant repair too large" };

    const ingestedAt = Date.now();
    if (run.parentRunId && !knownParent) {
      // The placeholder takes its position from the child's own file rather
      // than calling itself a root: a run that knows it sits at depth 3 knows
      // its parent sits at depth 2, and the next sibling to arrive then reads
      // a true position instead of a self-root at depth 0.
      await ctx.db.insert("runs", stub({ runId: run.parentRunId, rootRunId: run.rootRunId, depth: Math.max(run.depth - 1, 0), linkKnown: true }, run, "unknown"));
    }
    if (!existing) {
      await ctx.db.insert("runs", { ...run, ingestedAt });
      if (environmentDefaulted) await event(ctx, "agents-environment-defaulted", { runId: run.runId, launcher: run.context?.launcher });
    } else {
      const advances = run.file.committedLine > existing.file.committedLine;
      const patch: Record<string, unknown> = { ingestedAt };
      if (advances || isStubFile(existing.file)) patch.file = run.file;
      if (advances || isStubFile(existing.file)) patch.attachments = run.attachments;
      // The envelope's fields arrive with a later page as readily as the first,
      // so registration repairs a run that was ingested before its launcher's
      // sidecar was claimed.
      // regToken rides this list for the same reason as envelopeKey: a run
      // ingested before its launcher's sidecar was claimed has no token, and
      // the repair page is the only thing that can give it one. Without that
      // every label about a run whose first page beat its envelope would be
      // unlinked forever.
      for (const key of ["status", "outcome", "mode", "lastLineAt", "model", "sessionModel", "effort", "context", "runtimeVersion", "parserVersion", "environment", "continuesRunId", "todoId", "batchId", "mergeKey", "regToken", "envelopeKey", "abandonedAt"] as const) if (run[key] !== undefined) patch[key] = run[key];
      if (run.sessionId !== undefined && existing.sessionId === undefined) patch.sessionId = run.sessionId;
      if (existing.kind === "unknown") patch.kind = run.kind;
      if (existing.origin === "unknown") patch.origin = run.origin;
      if (!existing.linkKnown && run.linkKnown && run.spawnedByToolUseId) { patch.linkKnown = true; patch.spawnedByToolUseId = run.spawnedByToolUseId; }
      if (isStubFile(existing.file)) Object.assign(patch, { parentRunId: run.parentRunId, rootRunId: run.rootRunId, depth: run.depth, host: run.host, cli: run.cli, environment: run.environment, startedAt: run.startedAt });
      if (sessionEnded && existing.abandonedAt !== undefined) patch.abandonedAt = undefined;
      await ctx.db.patch(existing._id, patch);
    }

    // The mutable run keeps the latest file pointer; this append-only table
    // keeps every verified version the nightly manifest must write exactly
    // once, including versions created in the same millisecond.
    if (!isStubFile(run.file) && run.file.storeKey !== undefined && !(await fileVersionAt(ctx, run.runId, run.file.storedHash))) {
      const prefix = `${run.cli}:${run.host}:`;
      await ctx.db.insert("runFileVersions", {
        runId: run.runId,
        cli: run.cli,
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
    const insertedSeqs = new Set<number>();
    for (const row of args.rows) {
      if (await rowAt(ctx, run.runId, row.seq)) { skipped += 1; continue; }
      await ctx.db.insert("claudeMessages", { runId: run.runId, seq: row.seq, turn: row.turn, kind: row.kind, content: row.content, provenance: row.provenance, digest: row.digest, depth: run.depth, parentToolUseId: row.parentToolUseId, createdAt: row.createdAt });
      insertedSeqs.add(row.seq);
      inserted += 1;
    }
    // Three writers converge on this field; whoever is first wins, so a later
    // one never renames a session's run.
    if (run.sessionId) {
      const session = await ctx.db.get(run.sessionId);
      if (session && session.runId === undefined) await ctx.db.patch(run.sessionId, { runId: run.runId });
    }
    const landed = await agentAt(ctx, run.runId);
    // A turn Tom typed becomes a session-reply label when its row lands here.
    if (landed) {
      for (const row of args.rows) {
        if (row.kind === "user" && insertedSeqs.has(row.seq)) await sessionReplyLabel(ctx, landed, row.seq, row.content);
      }
    }
    // `rowsUntil` is present IF AND ONLY IF this run's rows are in the record.
    // That invariant is what bounds the eviction scan and what makes eviction
    // idempotent, so it is maintained here, in the one place every writer of
    // rows passes through: the live sweep, a cut-over session, a materialize.
    // An index-only backlog row (rows: [], no prior window) gets no field at
    // all, and a no-op ingest writes nothing.
    if (landed && (inserted > 0 || existing?.rowsUntil !== undefined)) {
      const rowsUntil = Math.max(landed.rowsUntil ?? 0, run.lastLineAt + rowWindowMs());
      if (rowsUntil > (landed.rowsUntil ?? 0)) await ctx.db.patch(landed._id, { rowsUntil });
    }
    return { ok: true as const, runId: run.runId, inserted, skipped, committedLine: landed?.file.committedLine ?? run.file.committedLine };
  },
});

async function agentIdLogPrefix(runId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(runId));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 12);
}
async function refuseOverflow(reason: string, where: { runId: string; seq: number; index?: number }) {
  console.warn(`runs overflow refused: ${reason} (run sha256:${await agentIdLogPrefix(where.runId)}, seq ${where.seq}${where.index === undefined ? ")" : `, chunk ${where.index})`}`);
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
    if (!validAgentId(args.runId)) return await refuseOverflow("invalid runId", where);
    // Chunks may arrive before their row, but never before the run itself:
    // otherwise a misspelled id leaves uncollectable overflow behind.
    if (!(await agentAt(ctx, args.runId))) return await refuseOverflow("no run", where);
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
    if (!validAgentId(args.runId)) return await refuseOverflow("invalid runId", where);
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

const SHADOW_PAGE_ROWS = 100;
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
  // The seq of the last row read from each side — a floor, not a pagination
  // cursor. Convex allows ONE paginated query per function call and this
  // comparison reads two indexes, so both sides are bounded `.take()` reads
  // over an explicit seq floor. (sessionId, seq) and (runId, seq) are each
  // unique — the seq floor on both writers — so `gt("seq", …)` neither skips
  // a row nor returns one twice.
  daemonAfterSeq: number | null;
  fileAfterSeq: number | null;
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
  daemonAfterSeq: v.union(v.number(), v.null()),
  fileAfterSeq: v.union(v.number(), v.null()),
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
    // The new kind only. Comparisons stored as runs-shadow-compare before the
    // rename leave this 24-hour window within a day of the deploy; until then
    // a session compared under the old kind can be compared once more, which
    // writes one more event and changes nothing else. The data keys `runId`
    // and `runStatus` are the stored spelling and stay.
    const comparisons = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", "agents-shadow-compare").gte("at", cutoff))
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
    const run = await agentAt(ctx, session.runId);
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
          daemonAfterSeq: null,
          fileAfterSeq: null,
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
    // Both reads are `.take()` over a seq floor, never `.paginate()`: a single
    // Convex function may run only one paginated query, and this one reads two
    // indexes — the second `.paginate()` threw, which is what answered every
    // /agents/compare call with HTTP 400.
    if (state.daemonPending.length === 0 && !state.daemonDone) {
      const rows = await ctx.db
        .query("claudeMessages")
        .withIndex("by_session_seq", (q) => {
          const scoped = q.eq("sessionId", sessionId);
          return state.daemonAfterSeq === null ? scoped : scoped.gt("seq", state.daemonAfterSeq);
        })
        .order("asc")
        .take(SHADOW_PAGE_ROWS);
      await addShadowPage(state, "daemon", rows);
      state.daemonDone = rows.length < SHADOW_PAGE_ROWS;
      if (rows.length > 0) state.daemonAfterSeq = rows[rows.length - 1].seq;
    }
    if (state.filePending.length === 0 && !state.fileDone) {
      const runId = session.runId;
      const rows = await ctx.db
        .query("claudeMessages")
        .withIndex("by_run_seq", (q) => {
          const scoped = q.eq("runId", runId);
          return state.fileAfterSeq === null ? scoped : scoped.gt("seq", state.fileAfterSeq);
        })
        .order("asc")
        .take(SHADOW_PAGE_ROWS);
      await addShadowPage(state, "file", rows);
      state.fileDone = rows.length < SHADOW_PAGE_ROWS;
      if (rows.length > 0) state.fileAfterSeq = rows[rows.length - 1].seq;
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

    await event(ctx, "agents-shadow-compare", result);
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
          cli: version.cli,
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

// ── The audit's own run, read back to check its own claims ───────────────────

/** How many transcript rows one trace reads. THE BOUND IS 400 ROWS, NOT 400
 *  TOOL CALLS: a transcript interleaves user, assistant, thinking and
 *  tool-result rows, so a long run's tool calls are cut well before there are
 *  400 of them. See the note on `truncated` below for what that costs. */
const AGENT_TRACE_MAX_ROWS = 400;

/** A tool name or path is USER TEXT — whatever the model typed — and this door
 *  hands it to a job that posts it onto an event, so it is redacted and cut on
 *  the way out, exactly as ttsMerge.internalRecordAudit treats every string it
 *  is given from outside. */
const AGENT_TRACE_MAX_CHARS = 300;
const traceText = (value: string) => redactSecrets(value).slice(0, AGENT_TRACE_MAX_CHARS);

/**
 * ONE AGENT'S TOOL CALLS, by the registration token it stamped on what it wrote.
 *
 * WHY IT EXISTS. The audit checks its own claims against ITS OWN AGENT: it says
 * it opened `convex/foo.ts`, and this answers whether any Read, Grep or Glob
 * call in that run ever named that path (worker/jobs/audit.mjs, finding 2).
 * Without it the audit's "I read the whole change" is unverifiable, which is
 * the exact fault this round closes.
 *
 * `null` FOR AN UNKNOWN TOKEN IS A NORMAL ANSWER and never an error, exactly as
 * ttsEvals.internalRunByToken treats it: the sweeper needs a moment to see the
 * run's file, so the caller polls with a short bounded wait and a trace that
 * never arrives is a counted absence, not a failed audit.
 *
 * NARROW LIKE ITS SIBLING. A caller holding a token is owed this run's tool
 * NAMES AND PATHS — never its transcript, its tool results, or any other field
 * of a call's input.
 */
export const internalAgentTrace = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const run = await ctx.db
      .query("runs")
      .withIndex("by_reg_token", (q) => q.eq("regToken", token))
      .first();
    if (run === null) return null;
    const rows = await ctx.db
      .query("claudeMessages")
      .withIndex("by_run_seq", (q) => q.eq("runId", run.runId))
      .take(AGENT_TRACE_MAX_ROWS);
    const toolCalls: Array<{ name: string; path: string | null }> = [];
    for (const row of rows) {
      if (row.kind !== "tool-call") continue;
      // `content` is v.any(), so every field is read defensively and a row that
      // cannot be read is DROPPED rather than thrown on: one malformed row must
      // not cost an audit its whole trace.
      const content = (row.content ?? {}) as Record<string, unknown>;
      if (typeof content.name !== "string" || content.name === "") continue;
      const input =
        typeof content.input === "object" && content.input !== null && !Array.isArray(content.input)
          ? (content.input as Record<string, unknown>)
          : {};
      // The first present of the three: Read and Edit name `file_path`, Glob
      // and some tools name `path`, and Grep names `pattern`.
      const named = [input.file_path, input.path, input.pattern].find(
        (value) => typeof value === "string" && value !== "",
      );
      toolCalls.push({
        name: traceText(content.name),
        path: typeof named === "string" ? traceText(named) : null,
      });
    }
    // THE SAME ARITHMETIC AS worker/jobs/evals.mjs `tokensOf`, and deliberately
    // not a second one: input + cache-read + cache-write + output, those four
    // fields and no others. That function is the other home; if the sum changes
    // there it changes here.
    const totals = run.outcome?.totals;
    const tokens =
      totals === undefined
        ? null
        : totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens;
    return {
      agentId: run.runId,
      turns: run.outcome?.turns ?? null,
      tokens,
      toolCalls,
      // WHY THE TRUNCATION IS DECLARED RATHER THAN SWALLOWED. A cut list does
      // not quieten finding 2, it makes it LOUDER AND WRONG: the finding fires
      // when a path the audit claims is in NO tool call of the list, so a path
      // that was genuinely read on turn 300 and fell past the cut is reported
      // as a claim the record does not support — a false accusation against an
      // honest audit, which is the one failure this round cannot afford,
      // because a check that cries wolf is a check nobody reads. So the cut is
      // a fact on the answer, and a reader that sees `truncated: true` can
      // silence finding 2 the way `trace.available: false` already silences it.
      // The alternative — an unbounded read — is a transaction this deployment
      // pays for on behalf of whoever holds a token, which is why the bound
      // stays. An audit whose own run is longer than 400 rows is not a case
      // this door serves fully, and it says so rather than guessing.
      truncated: rows.length === AGENT_TRACE_MAX_ROWS,
    };
  },
});

function assertAgentId(agentId: string) {
  if (!validAgentId(agentId)) throw new Error("invalid agentId");
}

export const get = query({ args: { agentId: v.string() }, handler: async (ctx, args) => { await requireTom(ctx, "Agents"); assertAgentId(args.agentId); return await ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", args.agentId)).first(); } });
export const children = query({
  args: { agentId: v.string(), cursor: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireTom(ctx, "Agents");
    assertAgentId(args.agentId);
    const limit = args.limit ?? 100;
    if (!positiveInteger(limit) || limit > 500) throw new Error("children limit must be an integer from 1 to 500");
    const page = await ctx.db.query("runs").withIndex("by_parent", (q) => q.eq("parentRunId", args.agentId)).paginate({ cursor: args.cursor ?? null, numItems: limit });
    return { items: page.page, nextCursor: page.isDone ? null : page.continueCursor };
  },
});
export const rows = query({ args: { agentId: v.string(), paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => { await requireTom(ctx, "Agents"); assertAgentId(args.agentId); const page = await ctx.db.query("claudeMessages").withIndex("by_run_seq", (q) => q.eq("runId", args.agentId)).order("asc").paginate(args.paginationOpts); return { ...page, page: page.page.map((row) => ({ ...row, hasOverflow: row.overflow !== undefined, fullByteLength: row.overflow?.byteLength })) }; } });
export const entry = query({ args: { agentId: v.string(), seq: v.number() }, handler: async (ctx, args) => { await requireTom(ctx, "Agents"); assertAgentId(args.agentId); if (!nonNegativeInteger(args.seq)) throw new Error("invalid seq"); const row = await ctx.db.query("claudeMessages").withIndex("by_run_seq", (q) => q.eq("runId", args.agentId).eq("seq", args.seq)).first(); return row ? { provenance: row.provenance, content: row.content, overflow: row.overflow, digest: row.digest } : null; } });

// ── Opening an old run from the store ────────────────────────────────────────
// Convex holds no S3 reader credential and no second request signer, so a run
// whose rows are not in the record opens by asking the box for them. Tom (or a
// job) queues a request here; `worker/agents/materialize.mjs` serves it and
// ingests the rows through the existing /agents/ingest door. There is no second
// ingest path.

async function newestRequest(ctx: QueryCtx | MutationCtx, runId: string) {
  return await ctx.db
    .query("runMaterializeRequests")
    .withIndex("by_run_requestedAt", (q) => q.eq("runId", runId))
    .order("desc")
    .first();
}

/**
 * The one place a request is queued, shared by Tom's mutation and the worker
 * route so the refusals and the idempotence cannot drift apart. Idempotent
 * while a request is pending: a second press returns the first request rather
 * than queueing work the box would do twice.
 */
async function enqueueMaterialize(ctx: MutationCtx, runId: string, requestedBy: "tom" | "worker") {
  if (!validAgentId(runId)) return { ok: false as const, reason: "invalid agentId" };
  const run = await agentAt(ctx, runId);
  if (!run) return { ok: false as const, reason: "agent not found" };
  if (!run.file.storeKey) return { ok: false as const, reason: "agent has no store key" };
  const newest = await newestRequest(ctx, runId);
  if (newest && newest.status === "pending") {
    return { ok: true as const, requestId: newest._id, slice: newest.slice, queued: false };
  }
  const requestId = await ctx.db.insert("runMaterializeRequests", {
    runId, requestedBy, requestedAt: Date.now(), status: "pending" as const, slice: 1,
  });
  return { ok: true as const, requestId, slice: 1, queued: true };
}

export const requestMaterialize = mutation({
  args: { agentId: v.string() },
  handler: async (ctx, args) => {
    await requireTom(ctx, "Agents");
    const queued = await enqueueMaterialize(ctx, args.agentId, "tom");
    // Fixed phrases: the page renders the refusal and nothing here echoes a payload.
    if (!queued.ok) throw new Error(queued.reason);
    return await ctx.db.get(queued.requestId);
  },
});

export const materializeStatus = query({
  args: { agentId: v.string() },
  handler: async (ctx, args) => {
    await requireTom(ctx, "Agents");
    assertAgentId(args.agentId);
    return await newestRequest(ctx, args.agentId);
  },
});

// Reading a run is what keeps it in the record — but only a run that HAS rows,
// so looking at an index-only backlog run never makes it evictable, and reading
// the same run six times in an afternoon is one write, not six.
export const markOpened = mutation({
  args: { agentId: v.string() },
  handler: async (ctx, args) => {
    await requireTom(ctx, "Agents");
    assertAgentId(args.agentId);
    const run = await agentAt(ctx, args.agentId);
    if (!run || run.rowsUntil === undefined) return { ok: true as const, moved: false };
    const next = Date.now() + rowWindowMs();
    if (next <= run.rowsUntil + DAY_MS) return { ok: true as const, moved: false };
    await ctx.db.patch(run._id, { rowsUntil: next });
    return { ok: true as const, moved: true };
  },
});

// The worker-key twin of requestMaterialize (phase 7's evals will need an old
// run's rows). It answers rather than throws, because an HTTP route turns the
// answer into a status code.
export const internalRequestMaterialize = internalMutation({
  args: { runId: v.string(), requestedBy: v.union(v.literal("tom"), v.literal("worker")) },
  handler: async (ctx, args) => {
    const queued = await enqueueMaterialize(ctx, args.runId, args.requestedBy);
    if (!queued.ok) return queued;
    return { ok: true as const, requestId: queued.requestId, slice: queued.slice, queued: queued.queued };
  },
});

export const internalNextMaterialize = internalQuery({
  args: {},
  handler: async (ctx) => {
    const request = await ctx.db
      .query("runMaterializeRequests")
      .withIndex("by_status_requestedAt", (q) => q.eq("status", "pending"))
      .order("asc")
      .first();
    if (!request) return { request: null };
    const run = await agentAt(ctx, request.runId);
    // A request whose run vanished, or whose run never had a store key, is
    // still answerable: it comes back with `storeKey: null` so the job writes
    // `failed` and the queue drains. Skipping it would park it at the head of
    // the queue forever — the queue is drained by answers, not by attempts.
    const cli = run?.cli;
    const prefix = run ? `${cli}:${run.host}:` : `${request.runId.split(":").slice(0, 2).join(":")}:`;
    const file = run
      ? {
          path: run.file.path, sourceHash: run.file.sourceHash, storedHash: run.file.storedHash,
          bytes: run.file.bytes, storedBytes: run.file.storedBytes,
          committedLine: run.file.committedLine, committedPrefixSha256: run.file.committedPrefixSha256,
          storeKey: run.file.storeKey ?? null, sidecarStoredHash: run.file.sidecarStoredHash ?? null,
          totalLines: run.file.totalLines ?? null, incompleteTail: run.file.incompleteTail ?? false,
        }
      : {
          path: "", sourceHash: "", storedHash: "", bytes: 0, storedBytes: 0,
          committedLine: 0, committedPrefixSha256: "", storeKey: null,
          sidecarStoredHash: null, totalLines: null, incompleteTail: false,
        };
    const hasRows = Boolean(
      await ctx.db.query("claudeMessages").withIndex("by_run_seq", (q) => q.eq("runId", request.runId)).first(),
    );
    return {
      request: {
        requestId: request._id, agentId: request.runId, slice: request.slice,
        requestedBy: request.requestedBy, requestedAt: request.requestedAt,
        cli: cli ?? request.runId.split(":")[0],
        host: run?.host ?? request.runId.split(":")[1],
        threadId: request.runId.startsWith(prefix) ? request.runId.slice(prefix.length) : request.runId,
        depth: run?.depth ?? 0,
        parentAgentId: run?.parentRunId ?? null,
        file,
        hasRows,
        // Where the parse resumes: a backlog run has no rows and starts at 0, a
        // continuation starts at the lines already in the record.
        fromLine: hasRows ? file.committedLine : 0,
      },
    };
  },
});

export const internalAnswerMaterialize = internalMutation({
  args: {
    requestId: v.id("runMaterializeRequests"),
    status: v.union(v.literal("served"), v.literal("failed")),
    reason: v.optional(v.string()),
    rowsIngested: v.optional(v.number()),
    fromLine: v.optional(v.number()),
    toLine: v.optional(v.number()),
    totalLines: v.optional(v.number()),
    rowsSource: v.optional(ROWS_SOURCE),
  },
  handler: async (ctx, args) => {
    if (args.reason !== undefined && args.reason.length > MAX_REASON_LENGTH) return { ok: false as const, reason: "reason too long" };
    if (args.reason !== undefined && !MATERIALIZE_REASONS.has(args.reason)) return { ok: false as const, reason: "reason outside the closed vocabulary" };
    if (args.rowsSource && !args.rowsSource.partial.every((value) => MATERIALIZE_PARTIAL.has(value))) return { ok: false as const, reason: "partial outside the closed vocabulary" };
    for (const count of [args.rowsIngested, args.fromLine, args.toLine, args.totalLines]) {
      if (count !== undefined && !nonNegativeInteger(count)) return { ok: false as const, reason: "invalid line counts" };
    }
    const request = await ctx.db.get(args.requestId);
    if (!request) return { ok: false as const, reason: "request not found" };
    // A second answer to the same request changes nothing: a retried POST must
    // not queue a second continuation.
    if (request.status !== "pending") return { ok: true as const, alreadyAnswered: true, continuation: false };

    await ctx.db.patch(request._id, {
      status: args.status, servedAt: Date.now(),
      ...(args.reason === undefined ? {} : { reason: args.reason }),
      ...(args.rowsIngested === undefined ? {} : { rowsIngested: args.rowsIngested }),
      ...(args.fromLine === undefined ? {} : { fromLine: args.fromLine }),
      ...(args.toLine === undefined ? {} : { toLine: args.toLine }),
    });
    if (args.status !== "served") return { ok: true as const, alreadyAnswered: false, continuation: false };

    const run = await agentAt(ctx, request.runId);
    const totalLines = args.totalLines ?? run?.file.totalLines;
    const linesRemain = args.toLine !== undefined && totalLines !== undefined && args.toLine < totalLines;
    // After the last slice the run keeps `committedLine < totalLines` and the
    // page must say why, so the cap names itself even if the job did not.
    let rowsSource = args.rowsSource;
    if (rowsSource && linesRemain && request.slice >= MAX_SLICES && !rowsSource.partial.includes("row-cap-reached")) {
      rowsSource = { ...rowsSource, partial: [...rowsSource.partial, "row-cap-reached"] };
    }
    if (run) {
      const patch: Record<string, unknown> = {};
      if (rowsSource) patch.rowsSource = rowsSource;
      if (args.totalLines !== undefined) patch.file = { ...run.file, totalLines: args.totalLines };
      if (Object.keys(patch).length > 0) await ctx.db.patch(run._id, patch);
    }

    // A reader who opened a run wants the run: the continuation is queued here
    // rather than asked of Tom again. Never a second pending request for one
    // run, however this route is retried.
    let continuation = false;
    if (linesRemain && request.slice < MAX_SLICES) {
      const newest = await newestRequest(ctx, request.runId);
      if (!newest || newest.status !== "pending") {
        await ctx.db.insert("runMaterializeRequests", {
          runId: request.runId, requestedBy: request.requestedBy, requestedAt: Date.now(),
          status: "pending" as const, slice: request.slice + 1,
        });
        continuation = true;
      }
    }
    return { ok: true as const, alreadyAnswered: false, continuation };
  },
});

// ── Eviction: what makes the window a window ─────────────────────────────────
// Rows for runs outside the window and not opened inside it are removed nightly.
// The run index is never removed, a label is never removed, and the store is
// never touched — nothing here destroys a byte the store does not already hold.
// A run a session names is exempt until its session has been ended for the
// row window (evictRefusal): its rows are that session's transcript.

/**
 * Why this run keeps its rows tonight, or null when it may lose them.
 *
 * A RUN A SESSION NAMES KEEPS ITS ROWS while the session is live and for the
 * row window (30 days unless the deployment says otherwise) after it ended.
 * Those rows are the session's whole transcript — the agent file is the only
 * source of a session's rows — and a session Tom can still reopen or scroll
 * back through is read by its session, which neither opens the run nor moves
 * its window, so the run's own last-line clock would evict it under him.
 */
async function evictRefusal(ctx: MutationCtx, run: Doc<"runs">, now: number) {
  if (run.status === "running") return "running";
  if (run.lastLineAt > now - rowWindowMs()) return "inside the window";
  if (run.sessionId) {
    const session = await ctx.db.get(run.sessionId);
    if (session && (LIVE_STATUSES as readonly string[]).includes(session.status)) return "live session";
    if (session && session.statusChangedAt > now - rowWindowMs()) return "session ended inside the window";
  }
  return null;
}

/**
 * Delete up to `budget` documents of one run's transcript. CHUNKS BEFORE THEIR
 * ROW, so a crash can never leave overflow nobody can find — the same discipline
 * as claudeSessions.internalSweepOverflow, applied to the run key.
 */
async function evictAgentStep(ctx: MutationCtx, runId: string, budget: number) {
  let rowsDeleted = 0;
  let overflowChunksDeleted = 0;
  while (budget > 0) {
    const batch = await ctx.db
      .query("claudeMessages")
      .withIndex("by_run_seq", (q) => q.eq("runId", runId))
      .take(Math.min(budget, EVICT_ROWS_PER_STEP));
    if (batch.length === 0) return { rowsDeleted, overflowChunksDeleted, done: true, budget };
    for (const row of batch) {
      if (budget <= 0) break;
      if (row.overflow) {
        while (budget > 0) {
          const chunks = await ctx.db
            .query("claudeMessageOverflow")
            .withIndex("by_run_seq_index", (q) => q.eq("runId", runId).eq("seq", row.seq))
            .take(budget);
          if (chunks.length === 0) break;
          for (const chunk of chunks) {
            await ctx.db.delete(chunk._id);
            overflowChunksDeleted += 1;
            budget -= 1;
          }
        }
        // Out of budget with chunks still to find: leave the row, and the next
        // step meets it again with its overflow stamp intact.
        if (budget <= 0) return { rowsDeleted, overflowChunksDeleted, done: false, budget };
      }
      await ctx.db.delete(row._id);
      rowsDeleted += 1;
      budget -= 1;
    }
  }
  return { rowsDeleted, overflowChunksDeleted, done: false, budget };
}

export const internalEvictTick = internalMutation({
  args: {
    // `cursor` is accepted because a caller may carry one, and deliberately
    // unused: every run a step touches LEAVES the scan window (evicted → the
    // field is cleared, deferred → it moves a day forward), so the next step's
    // scan resumes where this one stopped without one.
    cursor: v.optional(v.string()),
    runs: v.optional(v.number()),
    rowsDeleted: v.optional(v.number()),
    overflowChunksDeleted: v.optional(v.number()),
    deferred: v.optional(v.number()),
    steps: v.optional(v.number()),
    pendingRunId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // OFF by default. Turning it on is the caller's action, after the S3
    // backend is live on that deployment and a materialize has round-tripped
    // there: evicting rows whose store objects sit in a local directory on a
    // machine that may be reinstalled is deleting what nothing can restore.
    if (!evictionEnabled()) {
      await event(ctx, "agents-evicted", {
        at: Date.now(), runs: 0, rowsDeleted: 0, overflowChunksDeleted: 0,
        deferred: 0, truncated: false, disabled: true,
      });
      return { ok: true as const, disabled: true };
    }

    const steps = args.steps ?? 0;
    const now = Date.now();
    // The house DST pattern: a cron pair fires at both possible UTC times and
    // this guard lets exactly one through. A CONTINUATION does not re-check, so
    // a long eviction is not cut in half at the hour boundary.
    if (steps === 0 && args.pendingRunId === undefined && nyLocalHour(now) !== 4) {
      return { ok: true as const, skipped: "not the eviction hour" };
    }

    let runsEvicted = args.runs ?? 0;
    let rowsDeleted = args.rowsDeleted ?? 0;
    let overflowChunksDeleted = args.overflowChunksDeleted ?? 0;
    let deferred = args.deferred ?? 0;
    let budget = EVICT_ROWS_PER_STEP;
    let pendingRunId: string | undefined;
    let worked = false;

    const finish = async (runId: string) => {
      const run = await agentAt(ctx, runId);
      // Clearing `rowsUntil` takes the run out of the scan index — that, and
      // not a cursor, is what makes the tick idempotent. The runs row, its
      // labels, its file, outcome, context, rowsSource and edges all stay.
      if (run) await ctx.db.patch(run._id, { rowsEvictedAt: now, rowsUntil: undefined });
      runsEvicted += 1;
    };

    if (args.pendingRunId !== undefined) {
      const step = await evictAgentStep(ctx, args.pendingRunId, budget);
      rowsDeleted += step.rowsDeleted;
      overflowChunksDeleted += step.overflowChunksDeleted;
      budget = step.budget;
      worked = true;
      if (step.done) await finish(args.pendingRunId);
      else pendingRunId = args.pendingRunId;
    } else {
      // BOTH bounds: a document missing an optional indexed field sorts before
      // every value, so a bare `.lt()` would sweep every run that has no rows.
      const candidates = await ctx.db
        .query("runs")
        .withIndex("by_rows_until", (q) => q.gt("rowsUntil", 0).lt("rowsUntil", now))
        .take(EVICT_AGENTS_PER_TICK);
      for (const run of candidates) {
        const refusal = await evictRefusal(ctx, run, now);
        if (refusal) {
          // A live run whose clock says otherwise is a bug to see, not rows to
          // lose: push the window a day past NOW — a day past a week-stale
          // value would still be in the past, and the run would be re-deferred
          // on every step of every tick.
          await ctx.db.patch(run._id, { rowsUntil: Math.max(run.rowsUntil ?? now, now) + DAY_MS });
          deferred += 1;
          worked = true;
          continue;
        }
        const step = await evictAgentStep(ctx, run.runId, budget);
        rowsDeleted += step.rowsDeleted;
        overflowChunksDeleted += step.overflowChunksDeleted;
        budget = step.budget;
        worked = true;
        if (step.done) await finish(run.runId);
        else pendingRunId = run.runId;
        break;
      }
    }

    const truncated = steps + 1 >= EVICT_MAX_STEPS;
    if (worked && !truncated) {
      await ctx.scheduler.runAfter(0, internal.agents.internalEvictTick, {
        runs: runsEvicted, rowsDeleted, overflowChunksDeleted, deferred,
        steps: steps + 1, ...(pendingRunId === undefined ? {} : { pendingRunId }),
      });
      return { ok: true as const, scheduled: true };
    }

    const oldest = await ctx.db
      .query("runs")
      .withIndex("by_rows_until", (q) => q.gt("rowsUntil", 0))
      .order("asc")
      .first();
    // One row, counts only: no run id, no row content.
    await event(ctx, "agents-evicted", {
      at: now, runs: runsEvicted, rowsDeleted, overflowChunksDeleted, deferred,
      truncated: worked && truncated, oldestRowsUntil: oldest?.rowsUntil ?? null,
    });
    return { ok: true as const, runs: runsEvicted, rowsDeleted, overflowChunksDeleted, deferred, truncated: worked && truncated };
  },
});

// The list wants the newest roots, and a root is the only run with no parent
// above it, so depth is pinned to 0 inside the index rather than filtered out
// after the read. Because that index leads with the host, "both hosts" is two
// bounded reads merged here, never a scan of every child run ever ingested.
// The cap is the page's, not the table's: this phase has no cursor, so the
// merged array itself is the answer.
export const roots = query({
  args: {
    host: v.optional(v.union(v.literal("laptop"), v.literal("box"))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTom(ctx, "Agents");
    const limit = args.limit ?? 50;
    if (!positiveInteger(limit) || limit > 500) throw new Error("roots limit must be an integer from 1 to 500");
    const hosts: Array<"laptop" | "box"> = args.host ? [args.host] : ["laptop", "box"];
    const perHost = await Promise.all(hosts.map((host) => ctx.db
      .query("runs")
      .withIndex("by_host_depth_started", (q) => q.eq("host", host).eq("depth", 0))
      .order("desc")
      .take(limit)));
    // Two runs can start in the same millisecond, so startedAt alone is not a
    // total order across the merge; runId settles those pairs the same way on
    // every read.
    return perHost.flat()
      .sort((left, right) => right.startedAt - left.startedAt || (left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0))
      .slice(0, limit);
  },
});

/**
 * Everything Tom did about this run, oldest first — a ruling on the row it
 * wrote, an objection in #tts-decisions, a reply he typed at it, an emoji on
 * the morning it wrote. The run page draws one strip from this under the
 * outcome, and DRAWS NO BAND AT ALL when the answer is empty: an empty strip
 * on every run is clutter that displays nothing, which is why the strip was
 * deferred until there were rows to put in it.
 *
 * Unpaginated on purpose. A run collects a handful of labels at human pace —
 * the table's whole write path is four doors Tom himself goes through — so a
 * page boundary here would be a mechanism with nothing to do.
 */
export const labels = query({
  args: { agentId: v.string() },
  handler: async (ctx, args) => {
    await requireTom(ctx, "Agents");
    assertAgentId(args.agentId);
    return await ctx.db
      .query("runLabels")
      .withIndex("by_run_at", (q) => q.eq("runId", args.agentId))
      .order("asc")
      .take(200);
  },
});
