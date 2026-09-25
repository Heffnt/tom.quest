import { paginationOptsValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireTom } from "./authRoles";
import {
  liveCodeSessionRulings,
  liveRulings,
  markCodeSessionRulingsApplied,
  markLiveSessionRulingApplied,
  subjectKey,
} from "./ttsRulings";
import { logEvent } from "./tts";
import { inboundRowIdOf, rowSource } from "./sessionRows";
import { isIsoDay } from "../shared/markdown-sections.mjs";
import { redactSecrets } from "../shared/redact.mjs";
import { codeSessionRulingLines } from "../app/lib/tts-session-prompt";

// Claude Code session surface — the Convex half of the web wrapper around
// headless Claude Code sessions on the Jarvis Box. CANONICAL DESIGN HOME:
// WikiTom tts/spec.md §20 (ratified 2026-08-28; first-principles, canvas
// explicitly NOT a precedent — steering gotcha canvas-code-unvalidated).
// Convex IS the stream: the daemon persists SDK events via key-authed
// /sessions/* routes; the browser subscribes.
//
// Ownership split (state machine): the BROWSER owns create, inbound commands
// (user-turn / interrupt / stop), permission decisions, and stale-only
// forceClose. The DAEMON owns every other transition, reported as fact.

async function requireTomId(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  return await requireTom(ctx, "Sessions");
}

// The staleness threshold comes through ttsShared (its one home is
// shared/session-constants.mjs, which the worker daemon imports too), and so do
// the live-status list this file scans by (LIVE_STATUSES / isLive, formerly
// declared here AND in app/agents/lib.ts). The model-of-tom context each opener carries is assembled for that
// opener's own subject by ttsContext.assembleContext, called once per opener in
// insertSession below; ttsSkills keeps only the header parser it strips with.
import { withoutModelOfTomPrelude } from "./ttsSkills";
import { assembleContext, type ContextSubject } from "./ttsContext";
import { dueRunnerSteps } from "./ttsRunners";
import { hostedFacts, onHostedSessionEnded, renewOrchestratorLease } from "./orchestrator";
import { BOX_TOOLS_PARAGRAPH, DAEMON_RESTART_SENTENCE, FABLE_AVAILABILITY, USAGE_LIMIT_REPORT } from "./ttsShared";
import { EVALS_REQUIRED_FOR_MERGE } from "./ttsMerge";
import { briefForPrompt } from "../shared/context-relevance.mjs";
import { USAGE_LIMIT_RE } from "../shared/session-constants.mjs";
import {
  WORKER_CONTRACT,
  CODEX_FALLBACK_MODEL,
  CODEX_USAGE_STALE_MS,
  CODEX_WEEKLY_CAP_PERCENT,
  CODE_TODO_PATH,
  CODE_TODO_REPOS,
  DAEMON_STALE_MS,
  DEFAULT_SESSION_MODEL,
  LIVE_STATUSES,
  MODEL_OF_TOM_HEADER,
  NARROW_LIST,
  NO_REPO,
  SESSION_MODEL,
  SESSION_REPO_NAMES,
  isLive,
  isPrepared,
  isSessionRepo,
  modelFamily,
  normalizeSessionRepos,
  tracksCodeTodos,
  ttsSessionLink,
  wakeAtPassed,
} from "./ttsShared";
import type { SessionModel } from "./ttsShared";
export { DAEMON_STALE_MS };

async function getSessionOrThrow(
  ctx: QueryCtx | MutationCtx,
  id: Id<"claudeSessions">,
): Promise<Doc<"claudeSessions">> {
  const session = await ctx.db.get(id);
  if (!session) throw new Error("Session not found");
  return session;
}

// ── A session that failed (slack-design.md §1.2) ─────────────────────────────
// THE PER-SESSION EVENT LINE IS GONE. It was switched off from the day it was
// written and it had no channel of its own: a session recording an outcome is
// not something Tom does anything about, and it reaches him in the morning
// message's overnight run. The one case that IS a message is a session that
// FAILED, and that goes to #tts-broken.
//
// The Slack POST is an ACTION (network), so a mutation cannot await it — it is
// scheduled at runAfter(0) and rides the transaction: if the mutation rolls
// back, the message is never scheduled at all, so Slack never reports a
// transition that did not happen.
//
// EDGE TRIGGERS ONLY. Every call site below sits on a transition that the
// surrounding code makes unrepeatable (a live→terminal status patch, an
// undefined→set outcome). The daemon polls and flushes continuously; a
// level-triggered check would send one message per flush for the whole time
// Tom is asleep. #tts-broken dedupes on the job as well, and a session's job
// name is the session itself, so two failures of one session are one message.
function notifySessionFailed(
  ctx: MutationCtx,
  sessionId: Id<"claudeSessions">,
  title: string,
  reason: string | undefined,
): Promise<Id<"_scheduled_functions">> {
  return ctx.scheduler.runAfter(0, internal.ttsSync.sendBroken, {
    job: `session:${sessionId}`,
    statement: `A session stopped without finishing what it was carrying, so nothing it was doing is done.`,
    // THE REASON AND THE TITLE ARE FREE TEXT a session wrote about itself, so
    // both go through the one credential filter (the same redactSecrets
    // convex/ttsSearch.ts and worker/session-host use) before they can become
    // a #tts-broken line: a run that printed a token can put it in either.
    detail: redactSecrets(`${title} stopped: ${reason ?? "no reason was reported"}`),
    url: ttsSessionLink(sessionId),
  });
}

// ONE wording for an outcome event, shared by the daemon's stamp
// (internalIngest) and the agent's pen (internalRecordOutcome) — the two
// writers of the same fact must not describe it two ways. Descriptive, one
// line, no exclamation marks.
function outcomeEventText(
  title: string,
  outcome: "completed" | "errored",
  summary: string | undefined,
): string {
  const said = (summary ?? "").trim();
  return `session "${title}" recorded its outcome: ${outcome} — ${
    said === "" ? "no summary reported" : said
  }`;
}

// ── Tom-facing queries ───────────────────────────────────────────────────────

export const listSessions = query({
  args: {},
  handler: async (ctx) => {
    await requireTomId(ctx);
    // Newest first; the session list is human-scale (take, not collect —
    // ledger tts-collect-pagination discipline).
    return await ctx.db.query("claudeSessions").order("desc").take(100);
  },
});

export const getSession = query({
  args: { id: v.id("claudeSessions") },
  handler: async (ctx, { id }) => {
    await requireTomId(ctx);
    return await ctx.db.get(id);
  },
});

// A session's rows, newest page first, paginated — history rows never change,
// so pages are cache-friendly forever.
//
// The rows are the agent file's, read by the session's runId, for every
// session since the cutover (convex/sessionRows.ts rowSource); a session from
// before it reads the rows the daemon wrote. Both indexes return the same row
// shape in the same order, so the page cannot tell which it got. A session
// whose run is not named yet has no rows to show, and gets an empty page
// rather than an error: its first turn is still running.
//
// Every row says whether the 32KB cut hid anything (`hasOverflow`) and how
// many bytes the whole payload is (`fullByteLength`), so the page can offer an
// expand without fetching a single oversized payload to find out. The bytes
// themselves come from getMessageOverflow below, one message at a time.
export const getMessages = query({
  args: {
    sessionId: v.id("claudeSessions"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { sessionId, paginationOpts }) => {
    await requireTomId(ctx);
    const session = await ctx.db.get(sessionId);
    const source = session === null ? { from: "none" as const } : rowSource(session);
    if (source.from === "none") {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const page = source.from === "run"
      ? await ctx.db
          .query("claudeMessages")
          .withIndex("by_run_seq", (q) => q.eq("runId", source.runId))
          .order("desc")
          .paginate(paginationOpts)
      : await ctx.db
          .query("claudeMessages")
          .withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId))
          .order("desc") // newest page first; client reverses within a page
          .paginate(paginationOpts);
    return {
      ...page,
      page: page.page.map((m) => ({
        ...m,
        hasOverflow: m.overflow !== undefined,
        fullByteLength: m.overflow?.byteLength,
      })),
    };
  },
});

// How much reassembled payload one read returns before it hands back a cursor.
// A message's overflow can be hundreds of megabytes; a query that collected
// all of it would simply fail, and silently returning a prefix would be the
// truncation this whole path exists to undo.
export const OVERFLOW_READ_BYTES = 1024 * 1024;

// The most chunk rows one read scans: one ranged index scan, bounded at 2MB
// of documents by the chunk cap below whatever the byte budget says. The
// budget normally stops the walk first.
const OVERFLOW_READ_CHUNKS = 8;

// The largest chunk the overflow route accepts — OVERFLOW_CHUNK_BYTES in
// worker/session-host/overflow.mjs, spelled again here because no import
// crosses that boundary. Convex caps a document at ~1MB; this keeps a chunk
// row well inside it and is what bounds every read above.
export const OVERFLOW_CHUNK_MAX_BYTES = 256 * 1024;

// How many chunk rows one sweep deletes before scheduling itself again: the
// same 2MB read bound as a page, because a delete reads the document too.
const OVERFLOW_SWEEP_CHUNKS = 8;

const utf8 = new TextEncoder();
const utf8Bytes = (text: string) => utf8.encode(text).length;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8.encode(text));
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** The finalized row at (sessionId, seq), if it has landed. */
async function messageAt(
  ctx: QueryCtx,
  sessionId: Id<"claudeSessions">,
  seq: number,
) {
  return await ctx.db
    .query("claudeMessages")
    .withIndex("by_session_seq", (q) =>
      q.eq("sessionId", sessionId).eq("seq", seq),
    )
    .first();
}

/** One chunk row of a message's complete payload, if it has landed. */
async function chunkAt(
  ctx: QueryCtx,
  sessionId: Id<"claudeSessions">,
  seq: number,
  index: number,
) {
  return await ctx.db
    .query("claudeMessageOverflow")
    .withIndex("by_session_seq_index", (q) =>
      q.eq("sessionId", sessionId).eq("seq", seq).eq("index", index),
    )
    .first();
}

/**
 * The complete payload behind one message, chunks reassembled in order.
 *
 * `fromIndex` continues a previous read at its `nextIndex`; concatenating the
 * `text` of every page in order reproduces exactly what the daemon stored.
 * A page says how many UTF-8 bytes it carries (`bytes`) and whether the walk
 * reached the last chunk the row names (`end`); `complete` is the stronger
 * claim, made only when it was checked: the whole payload came back in this
 * one call, its bytes sum to the row's `byteLength`, and it hashes to the
 * row's `sha256`. A paged reader gets `end` on its last page and sums `bytes`
 * against `byteLength` itself — counting chunks would call a hole complete.
 */
export type MessageOverflowRead = {
  /** False = nothing was cut and `content` on the row IS the whole payload. */
  hasOverflow: boolean;
  sessionId: Id<"claudeSessions">;
  seq: number;
  /** Of the stored text, so a reassembly can be checked against it. */
  sha256?: string;
  byteLength?: number;
  chunkCount?: number;
  fromIndex: number;
  /** Where to continue; null = the walk stopped (at the end, or at a hole). */
  nextIndex: number | null;
  /** UTF-8 bytes of `text` — what a paged reader sums against `byteLength`. */
  bytes: number;
  /** The walk reached the last chunk the row names with no index missing. */
  end: boolean;
  /** Read whole in this call AND its bytes and hash match the row's stamp. */
  complete: boolean;
  text: string;
};

async function messageOverflow(
  ctx: QueryCtx,
  messageId: Id<"claudeMessages">,
  fromIndex: number,
): Promise<MessageOverflowRead | null> {
  const message = await ctx.db.get(messageId);
  // Run rows share this table but deliberately have no legacy session link;
  // this reader serves only the session surface.
  if (!message?.sessionId) return null;
  if (!message.overflow) {
    return {
      hasOverflow: false,
      sessionId: message.sessionId,
      seq: message.seq,
      fromIndex: 0,
      nextIndex: null,
      bytes: 0,
      end: true,
      complete: true,
      text: "",
    };
  }
  const { sha256, byteLength, chunkCount } = message.overflow;
  const parts: string[] = [];
  let bytes = 0;
  let end = false;
  let nextIndex: number | null = null;
  let expected = fromIndex;
  if (Number.isInteger(fromIndex) && fromIndex >= 0 && fromIndex < chunkCount) {
    // One ranged scan from `fromIndex` up, never one point read per index.
    const chunks = await ctx.db
      .query("claudeMessageOverflow")
      .withIndex("by_session_seq_index", (q) =>
        q
          .eq("sessionId", message.sessionId)
          .eq("seq", message.seq)
          .gte("index", fromIndex),
      )
      .take(OVERFLOW_READ_CHUNKS);
    for (const chunk of chunks) {
      if (chunk.index !== expected) break; // a hole — reported, never papered over
      parts.push(chunk.text);
      bytes += utf8Bytes(chunk.text);
      expected += 1;
      if (expected === chunkCount) {
        end = true;
        break;
      }
      if (bytes >= OVERFLOW_READ_BYTES) {
        nextIndex = expected;
        break;
      }
    }
    // The window was consumed whole with neither the end nor the budget
    // reached: more chunks may lie past it. A shorter window means the index
    // simply had no more rows — a hole, and nextIndex stays null.
    if (
      !end &&
      nextIndex === null &&
      parts.length === chunks.length &&
      chunks.length === OVERFLOW_READ_CHUNKS
    ) {
      nextIndex = expected;
    }
  }
  const text = parts.join("");
  // Verified, not counted: the stamp's byte length and hash, on the whole.
  const complete =
    end && fromIndex === 0 && bytes === byteLength
      ? (await sha256Hex(text)) === sha256
      : false;
  return {
    hasOverflow: true,
    sessionId: message.sessionId,
    seq: message.seq,
    sha256,
    byteLength,
    chunkCount,
    fromIndex,
    nextIndex,
    bytes,
    end,
    complete,
    text,
  };
}

// Tom's door: what the agents page expands a cut row into.
export const getMessageOverflow = query({
  args: {
    messageId: v.id("claudeMessages"),
    fromIndex: v.optional(v.number()),
  },
  handler: async (ctx, { messageId, fromIndex }) => {
    await requireTomId(ctx);
    return await messageOverflow(ctx, messageId, fromIndex ?? 0);
  },
});

// The daemon's door (no identity): the same body behind the session-host key,
// for the archive sweep that writes raw transcripts into WikiTom.
export const internalMessageOverflow = internalQuery({
  args: {
    messageId: v.id("claudeMessages"),
    fromIndex: v.optional(v.number()),
  },
  handler: async (ctx, { messageId, fromIndex }) => {
    return await messageOverflow(ctx, messageId, fromIndex ?? 0);
  },
});

// The live tail — one tiny row; the hot subscription during streaming.
export const getStreamBuf = query({
  args: { sessionId: v.id("claudeSessions") },
  handler: async (ctx, { sessionId }) => {
    await requireTomId(ctx);
    return await ctx.db
      .query("claudeStreamBuf")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
  },
});

// What the page shows after the rows: Tom's words from the moment he sends
// them until a row records them. Pending rows are the echo of commands not yet
// delivered. A session whose rows come from the agent file records a turn only
// when the sweep lands the file at the turn's end, so the turn of Tom's the
// daemon has delivered (or finished) rides along too, until a user row naming
// it by its `inbound row:` line is in the run's rows. Without it his words
// would vanish from the page for the whole turn the agent spends on them.
const RECORDED_SCAN = 20;

async function unrecordedTomTurn(
  ctx: QueryCtx,
  session: Doc<"claudeSessions">,
): Promise<Doc<"claudeInbound"> | null> {
  const newestOf = async (status: "delivered" | "done") =>
    await ctx.db
      .query("claudeInbound")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", session._id).eq("status", status),
      )
      .order("desc")
      .take(RECORDED_SCAN);
  // Only a turn Tom typed carries the id line a row can be matched on.
  const turn = [...(await newestOf("delivered")), ...(await newestOf("done"))]
    .filter((row) => row.kind === "user-turn" && row.author === "tom")
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (turn === undefined) return null;
  const source = rowSource(session);
  if (source.from === "run") {
    const userRows = await ctx.db
      .query("claudeMessages")
      .withIndex("by_run_kind", (q) => q.eq("runId", source.runId).eq("kind", "user"))
      .order("desc")
      .take(RECORDED_SCAN);
    if (userRows.some((row) => inboundRowIdOf(row.content) === turn._id)) return null;
  }
  return turn;
}

export const getPendingInbound = query({
  args: { sessionId: v.id("claudeSessions") },
  handler: async (ctx, { sessionId }) => {
    await requireTomId(ctx);
    const pending = await ctx.db
      .query("claudeInbound")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", sessionId).eq("status", "pending"),
      )
      .collect(); // bounded: pending commands are transient and few
    const session = await ctx.db.get(sessionId);
    // A session from before the cutover: the daemon wrote the user row in the
    // same flush that marked the turn delivered, so nothing is unrecorded.
    if (session === null || rowSource(session).from === "daemon") return pending;
    const unrecorded = await unrecordedTomTurn(ctx, session);
    return unrecorded === null ? pending : [unrecorded, ...pending];
  },
});

export const getDaemonHealth = query({
  args: {},
  handler: async (ctx) => {
    await requireTomId(ctx);
    return await ctx.db.query("claudeDaemonHealth").first();
  },
});

// ── ONE session-creation path (VQC C1: one home) ─────────────────────────────
// Ratified by Tom 2026-08-30, after a session created with repo "none" spent
// its whole run unable to clone or push: FOUR client call sites each built
// their own createSession arguments and TWO server paths bypassed the mutation
// with a db.insert of their own, so "which repo does this session get?" had six
// answers and the wrong one was reachable from every button.
//
// Everything below is now the only way a claudeSessions row is born:
//   resolveSessionRepos  — the ONE answer to "which repos does this hold?"
//   insertSession        — the ONE row-builder (session row + its first turn)
// A new launch surface calls these; it does not write its own insert.

const SESSION_KIND = v.union(
  v.literal("gate"),
  v.literal("focus-item"),
  v.literal("weekly"),
  v.literal("adhoc"),
  v.literal("block"),
);

/**
 * Which repos should this session check out? Answered once, here, in a fixed
 * order of authority — each source consulted only when the one above it says
 * nothing:
 *
 *  1. `explicit` — the caller named the set: the orchestrator's spawn, the
 *     session form, the weekly job. This is the normal path. An explicit empty
 *     array is an answer ("no checkout").
 *  2. The substring scan over the item's own words. The fallback, and the
 *     weakest: it is case-sensitive and matches anywhere, so it reads "the
 *     tom.quest dashboard" and "not tom.quest" identically, and it never
 *     finds the Jarvis repository (TEXT_SCAN_SKIPPED below). It is kept for
 *     the one caller that names no repos: the page's open-a-session button on
 *     a todo, and the scheduler's groundwork lanes, which open on one todo.
 *
 * (A batch's declared repos used to sit between (1) and (2). Batches went with
 * Tom's ruling of 2026-09-24 — "I dont want to have batches at all anymore" —
 * and no declaration replaced them: whoever opens a session names its repos.)
 *
 * Returns the canonical, normalized list — possibly empty, which means the
 * empty-scratch posture (`repo: "none"`).
 */
function resolveSessionRepos(input: {
  explicit?: readonly string[] | string;
  todo?: Doc<"dtsTodos"> | null;
  extraText?: string;
}): string[] {
  if (input.explicit !== undefined) {
    return normalizeSessionRepos(input.explicit);
  }
  const todo = input.todo;
  if (todo) {
    const text = `${todo.statement} ${todo.brief ?? ""} ${
      todo.groundUpExplanation ?? ""
    } ${input.extraText ?? ""}`;
    // Every repo the words name, not just the first: a todo naming both
    // tom.quest and WikiTom now gets both, which is the whole point of the
    // multi-repo ruling.
    return normalizeSessionRepos(
      SESSION_REPO_NAMES.filter(
        (repo) => !TEXT_SCAN_SKIPPED.includes(repo) && text.includes(repo),
      ),
    );
  }
  return [];
}

// The repos the substring scan above never matches. "Jarvis" is also the name
// of the whole agent system, and "the Jarvis Box" is in prose everywhere, so a
// match on it would clone Heffnt/Jarvis for every todo that mentions the box.
// Work in the Jarvis repository reaches a session only when its caller names
// the repository, which is the normal path.
const TEXT_SCAN_SKIPPED: readonly string[] = ["Jarvis"];

type SessionSeed = {
  title: string;
  kind: "gate" | "focus-item" | "weekly" | "adhoc" | "block";
  /** Already through resolveSessionRepos. Empty = the empty-scratch posture. */
  repos: string[];
  todoId?: Id<"dtsTodos">;
  blockCategory?: string;
  /** The code todo a worker mission was admitted for (schema: codeRepo /
   * codeExternalId) — both or neither. */
  codeSubject?: { repo: string; externalId: string };
  mode?: "interactive" | "autonomous";
  /** Absent = DEFAULT_SESSION_MODEL. Every row inserted from here carries an
   * explicit model; only rows predating 2026-09-04 have the field absent. */
  model?: SessionModel;
  /** Provenance for a "reopen as": the session this one continues on another
   * model (forkSessionAs). */
  forkedFrom?: Id<"claudeSessions">;
  /** The run the forked session was recorded as, which this one continues. */
  continuesRunId?: string;
  /** Kind "weekly" only (schema: agendaDay, agendaSubjects): the day the
   * Friday job ran for, and the todo ids its agenda's forks name. */
  agendaDay?: string;
  agendaSubjects?: string[];
  /**
   * The session's first turn. A BUILDER, not a string, because every prompt
   * this system writes names the session's own id (the outcome pen) and that
   * id does not exist until the insert — the client composing the prompt
   * cannot know it, and neither can the scheduler.
   */
  prompt: (sessionId: Id<"claudeSessions">, repos: string[]) => string;
  /**
   * Append the interactive outcome-pen footer. The autonomous prompts build
   * their own pen inline (with mission-specific wording), so they pass false.
   */
  outcomePen?: boolean;
};

/**
 * THE row-builder. Every claudeSessions row in this codebase is inserted here,
 * together with the claudeInbound row carrying its first turn — the two are one
 * fact ("a session was requested to do this"), and splitting them across call
 * sites is what let a session exist with no prompt and a prompt exist with no
 * repo.
 *
 * Writes BOTH repo fields: `repos` (the live list) and `repo` (the pre-ruling
 * single string, kept because prod schema is additive-only and every reader
 * that has not moved yet still reads it). repo = repos[0] ?? "none".
 */
export async function insertSession(
  ctx: MutationCtx,
  seed: SessionSeed,
  now: number,
): Promise<Id<"claudeSessions">> {
  const repos = normalizeSessionRepos(seed.repos);
  const sessionId = await ctx.db.insert("claudeSessions", {
    title: seed.title.trim() || "Untitled session",
    kind: seed.kind,
    repos,
    repo: repos[0] ?? NO_REPO,
    todoId: seed.todoId,
    blockCategory: seed.kind === "block" ? seed.blockCategory : undefined,
    codeRepo: seed.codeSubject?.repo,
    codeExternalId: seed.codeSubject?.externalId,
    mode: seed.mode,
    // EVERY new row carries an explicit model (Tom's ruling 2026-09-04: the
    // model is the choice, and the family behind it picks the runner). Absent
    // is reserved for rows written before models existed, which ran Opus —
    // which is exactly what modelFamily() reads an absent field as.
    model: seed.model ?? DEFAULT_SESSION_MODEL,
    forkedFrom: seed.forkedFrom,
    continuesRunId: seed.continuesRunId,
    agendaDay: seed.agendaDay,
    agendaSubjects: seed.agendaSubjects,
    status: "requested",
    statusChangedAt: now,
    nextSeq: 0,
    createdAt: now,
  });
  // A "session" verdict is applied the moment its session exists — the
  // supersession rule lives in ttsRulings.ts, not here.
  //
  // INTERACTIVE ONLY, and that is the point of the check rather than an
  // oversight: Tom's "session" verdict asks for a CONVERSATION with him. An
  // autonomous mission that happened to claim the same todo would otherwise
  // consume that ruling, and the conversation Tom asked for would never
  // happen while the ruling read as satisfied.
  if (seed.todoId !== undefined && seed.mode !== "autonomous") {
    await markLiveSessionRulingApplied(ctx, seed.todoId, sessionId);
  }
  // The code twin: a "session" verdict on a code todo is applied when Tom
  // opens the CODE BLOCK session — the interactive session whose turns are
  // about code todos (ttsRulings.refuseUnlessSessionSubject reads it that
  // way). Same interactive-only reason as above. (The block lane skips a
  // "code" category block by name, so no autonomous block session on code
  // exists today; the mode check is the guard should one ever be made.)
  //
  // A verdict is consumed ONLY IF THE OPENER NAMES IT: the prompt Tom's
  // browser built cannot know which code todos carry a live session verdict,
  // so the set is read here, each subject and Tom's sentence are appended to
  // the opener below, and exactly that set is marked — one read, one list,
  // one mark, so what the session is told and what the record says it
  // consumed cannot differ.
  let codeSessionLines: string[] = [];
  if (
    seed.kind === "block" &&
    seed.blockCategory === "code" &&
    seed.mode !== "autonomous"
  ) {
    const consumed = await liveCodeSessionRulings(ctx);
    const subjects = [];
    for (const r of consumed) {
      const mirrored = await ctx.db
        .query("dtsCodeTodoMirror")
        .withIndex("by_repo_external", (q) =>
          q.eq("repo", r.repo!).eq("externalId", r.externalId!),
        )
        .first();
      subjects.push({
        repo: r.repo!,
        externalId: r.externalId!,
        statement: mirrored?.statement,
        sentence: r.sentence,
      });
    }
    codeSessionLines = codeSessionRulingLines(subjects);
    await markCodeSessionRulingsApplied(ctx, consumed, sessionId);
  }
  // The opener carries the model-of-tom context ASSEMBLED FOR ITS OWN SUBJECT
  // (the dynamic-context round, Tom's ruling 2026-09-09), rather than a
  // caller-selected set of whole layers: the browser-built prompts, the worker
  // missions, the CLI pen, a fork — one home, here, rather than each builder
  // pasting its own copy.
  //
  // Three parts in prompt order, and the order is the point:
  //   prefix   header line 1 + the map + the operate rules. Identical for every
  //            run at one WikiTom commit — the cache boundary, and the
  //            transcript's first line, so the row records what the session
  //            began with.
  //   grants   the skills this session may load, by name, about two hundred
  //            bytes. The session loads a body itself, once, if it needs it.
  //   body     the mission the builder wrote, plus the code-session lines and
  //            the outcome pen. The task layer the map promises is last, and it
  //            is now the last thing in the prompt: the fetchable index went
  //            when the skill catalog replaced it.
  //
  // The subject is already in hand: the seed's todo, else its first repo, else
  // nothing. `reachesTom` is TRUE for every opener — the
  // outcome, the digest and the transcript all reach him — which is what grants
  // it the `write` skill.
  //
  // Publication fails closed: with no complete posted layer set, assembleContext
  // throws and this mutation publishes neither the session nor its opener.
  //
  // AND ONLY HERE: a seed whose prompt already begins with the header — a live
  // opener copied into the Create session box, a builder that pasted its own
  // copy — has that copy TAKEN OFF and the live one put there instead
  // (withoutModelOfTomPrelude), so the session opens and the transcript's first
  // line names one commit: the one this deployment holds. Two headers naming
  // two commits is what nothing reading the row could make sense of, and one
  // paste is a normal thing for Tom to do. WHAT IS STRIPPED IS THE STABLE
  // PREFIX, which is all a paste can carry that is not rebuilt anyway: the
  // grant block comes from the live record and the live catalog either way.
  //
  // A prefix read at some OTHER commit is still refused, because there is
  // nothing in the text that says where it stops and the prompt starts (see
  // withoutModelOfTomPrelude). The refusal writes nothing: a Convex mutation
  // is one transaction, so the row inserted above and the ruling marks after
  // it go back with the throw — pinned by the test, which finds no session and
  // no inbound row.
  const prompt = seed.prompt(sessionId, repos);
  const subject: ContextSubject =
    seed.todoId !== undefined
      ? { kind: "todo", todoId: seed.todoId, repos: repos.filter((repo) => repo !== NO_REPO) }
      : repos.length > 0 && repos[0] !== NO_REPO
        ? { kind: "repo", repo: repos[0] }
        : { kind: "none" };
  const context = await assembleContext(ctx, subject, { reachesTom: true, caller: "opener", now });
  const body = withoutModelOfTomPrelude(prompt, context.prefix);
  if (body === null) {
    throw new Error(
      `the prompt begins with a model-of-tom prelude ("${MODEL_OF_TOM_HEADER}") read at another commit; the opener adds the live one, and where a prelude from another commit stops and the prompt starts is not written down anywhere in it`,
    );
  }
  const text =
    context.prefix +
    "\n\n" +
    context.grants +
    "\n\n" +
    body +
    (codeSessionLines.length > 0 ? "\n\n" + codeSessionLines.join("\n") : "") +
    (seed.outcomePen === false ? "" : outcomePenFooter(sessionId, repos));
  // What this opener was given, for the delivery check to read beside what the
  // session then did (schema: contextExpanded / contextBytes).
  //
  // THE TWO FIELDS KEEP THEIR PHASE-4 NAMES until phase 9 renames them, and
  // what they hold is what replaced what they were named for: the GRANTED SKILL
  // NAMES where the expanded manifest was, and the grant block's bytes in the
  // `expanded` slot. `fetchable` is 0 because there is no fetchable block any
  // more — the catalog is the index. A reader of an old row and a reader of a
  // new one are reading the same question ("what did this opener carry"), which
  // is why the rename waits rather than splitting the field in two.
  await ctx.db.patch(sessionId, {
    contextExpanded: context.granted,
    contextBytes: { prefix: context.bytes.prefix, expanded: context.bytes.grants, fetchable: 0 },
  });
  await ctx.db.insert("claudeInbound", {
    sessionId,
    kind: "user-turn",
    text,
    // The opener is code-built, whoever asked for the session: it can never
    // be the source of a ruling in Tom's words (schema: author).
    //
    // FOLLOW-UP: an adhoc session's initialPrompt is text Tom typed in the
    // browser, wrapped here in the code-built prompt, and it is stamped
    // "agent" with the rest. That is the safe direction (a ruling in the
    // opener is refused, never misattributed), and the prompt tells the agent
    // to ask him to restate it in a later turn (app/lib/tts-session-prompt.ts
    // RULING_PEN). Giving the opener a "tom" author means splitting Tom's
    // words from the prompt around them, which is its own change.
    author: "agent",
    status: "pending",
    createdAt: now,
  });
  // Session lifecycle in the events table. dtsEvents is what the hourly Slack
  // update reads for "what happened since last time", and until this line only
  // plan repairs crossed over from the session world — so a night of fleet
  // work left no trace there at all. One home for the creation event, now that
  // there is one home for the creation.
  await logEvent(ctx, "session-created", seed.todoId, {
    sessionId,
    title: seed.title,
    kind: seed.kind,
    mode: seed.mode ?? "interactive",
    repos,
  });
  return sessionId;
}

/**
 * Every live session, for a CRON. listSessions and getDaemonHealth are
 * requireTomId-gated, so the hourly update — which has no identity — could not
 * read them; this file previously contained no internalQuery at all.
 *
 * Read-only and deliberately narrow: what is running, since when, and what it
 * is working on. Nothing here claims to see sessions running anywhere but the
 * Jarvis Box (ledger: tts-agents-off-box-invisible).
 */
export const internalListLive = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows: Doc<"claudeSessions">[] = [];
    for (const status of LIVE_STATUSES) {
      rows.push(
        ...(await ctx.db
          .query("claudeSessions")
          .withIndex("by_status", (q) => q.eq("status", status))
          .collect()), // bounded: live sessions are few by design
      );
    }
    return rows
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => ({
        id: s._id,
        title: s.title,
        status: s.status,
        kind: s.kind,
        mode: s.mode ?? "interactive",
        repos: s.repos ?? (s.repo === NO_REPO ? [] : [s.repo]),
        createdAt: s.createdAt,
        lastSdkEventAt: s.lastSdkEventAt,
      }));
  },
});

/**
 * One page of a session's rows, seq-ascending — what the daemon reads to
 * write .tts-transcript.md for a fork (forkSessionAs). It is an internalQuery
 * behind the key-authed GET /sessions/transcript route (convex/http.ts):
 * getMessages next to it is Tom-gated and pages newest-first for the browser,
 * and the daemon holds no identity and needs oldest-first.
 *
 * The rows are the ones getMessages shows, from the same switch
 * (convex/sessionRows.ts rowSource): the agent file's by runId since the
 * cutover, so a row's content is in the parser's shape (a tool call's `name`,
 * `id` and `input`), and the daemon's by sessionId before it.
 *
 * Paged rather than collected on purpose: a long session's transcript is
 * thousands of rows, which is exactly the unbounded read the collect rule
 * exists to stop.
 */
export const TRANSCRIPT_PAGE_SIZE = 200;
export const internalTranscriptPage = internalQuery({
  args: {
    sessionId: v.id("claudeSessions"),
    /** The opaque `nextCursor` of the previous page; absent = from the start. */
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, { sessionId, cursor }) => {
    const session = await ctx.db.get(sessionId);
    const source = session === null ? { from: "none" as const } : rowSource(session);
    if (source.from === "none") return { rows: [], nextCursor: null };
    const paging = { numItems: TRANSCRIPT_PAGE_SIZE, cursor: cursor ?? null };
    const page = source.from === "run"
      ? await ctx.db
          .query("claudeMessages")
          .withIndex("by_run_seq", (q) => q.eq("runId", source.runId))
          .order("asc")
          .paginate(paging)
      : await ctx.db
          .query("claudeMessages")
          .withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId))
          .order("asc")
          .paginate(paging);
    return {
      rows: page.page.map((m) => ({
        seq: m.seq,
        turn: m.turn,
        kind: m.kind,
        content: m.content,
        parentToolUseId: m.parentToolUseId,
        // Metadata only, as on the browser's rows: the fork's transcript file
        // renders the cut, and this says what the cut hid and how to ask for
        // it (claudeMessageOverflow under the row's sessionId or runId + seq).
        overflow: m.overflow,
        createdAt: m.createdAt,
      })),
      // null, not the cursor, on the last page: the daemon's loop stops on it.
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

// ── Tom-facing mutations ─────────────────────────────────────────────────────

// The one argument shape and body behind BOTH doors below: Tom's browser
// mutation (requireTomId) and the CLI pen (internalMutation, run with
// `npx convex run claudeSessions:internalCreateSession '{…}'` against the
// deployment — the same pattern as internalSetAutoConfig). One body, so the
// two doors can never resolve repos or seed the row differently.
const CREATE_SESSION_ARGS = {
  title: v.string(),
  kind: SESSION_KIND,
  // The live argument: the repos this session checks out. `repo` is the
  // pre-ruling single-string form, still accepted so an older client (or a
  // saved link) keeps working; both go through the same resolver.
  repos: v.optional(v.array(v.string())),
  repo: v.optional(v.string()),
  todoId: v.optional(v.id("dtsTodos")),
  blockCategory: v.optional(v.string()),
  // Tom picks the model for his own sessions (ratified 2026-09-04). Absent
  // takes DEFAULT_SESSION_MODEL, which insertSession supplies.
  model: v.optional(SESSION_MODEL),
  initialPrompt: v.string(),
};

async function createSessionFrom(
  ctx: MutationCtx,
  {
    title,
    kind,
    repos,
    repo,
    todoId,
    blockCategory,
    model,
    initialPrompt,
    agendaDay,
    agendaSubjects,
  }: {
    title: string;
    kind: Doc<"claudeSessions">["kind"];
    repos?: string[];
    repo?: string;
    todoId?: Id<"dtsTodos">;
    blockCategory?: string;
    model?: SessionModel;
    initialPrompt: string;
    agendaDay?: string;
    agendaSubjects?: string[];
  },
): Promise<Id<"claudeSessions">> {
  if (initialPrompt.trim() === "") throw new Error("initialPrompt is empty");
  // A todo-scoped session with no repos named falls back to the word guess
  // over the todo rather than silently landing on an empty scratch workspace.
  const todo = todoId !== undefined ? await ctx.db.get(todoId) : null;
  return await insertSession(
    ctx,
    {
      title,
      kind,
      repos: resolveSessionRepos({ explicit: repos ?? repo, todo }),
      todoId,
      blockCategory,
      model,
      agendaDay,
      agendaSubjects,
      // The ratified rule is "every session ends with a written outcome
      // record". An INTERACTIVE session had no writer for its own outcome at
      // all until the footer was appended server-side, after the insert.
      prompt: () => initialPrompt,
    },
    Date.now(),
  );
}

export const createSession = mutation({
  args: CREATE_SESSION_ARGS,
  handler: async (ctx, args) => {
    await requireTomId(ctx);
    return await createSessionFrom(ctx, args);
  },
});

// The CLI pen (Tom, 2026-09-04: "you should be able to log in as tom" — an
// agent never types his password, so it opens sessions through the deploy
// credential instead). Internal, so only the Convex CLI or another function
// can reach it; identical effect to the browser's Create session button.
export const internalCreateSession = internalMutation({
  args: CREATE_SESSION_ARGS,
  handler: async (ctx, args) => await createSessionFrom(ctx, args),
});

// The Friday job's pen (POST /tts/session; the lifeos update, phase 8). Kind
// "weekly" and nothing else, and two facts the row must carry that no other
// session has: the day the job ran for, and the todo ids the agenda's forks
// name. A weekly session's turns rule on those ids only
// (ttsRulings refuseUnlessSessionSubject) — the agenda, not the session's
// kind, is what says what Tom was talking about. Any holder of
// TTS_WORKER_KEY reaches this door, so it also refuses a second weekly
// session for the same day: the one the job opened is the weekly session.
export const internalCreateWeeklySession = internalMutation({
  args: {
    title: v.string(),
    repos: v.optional(v.array(v.string())),
    model: v.optional(SESSION_MODEL),
    initialPrompt: v.string(),
    day: v.string(),
    agendaSubjects: v.array(v.string()),
  },
  handler: async (ctx, { title, repos, model, initialPrompt, day, agendaSubjects }) => {
    if (!isIsoDay(day)) throw new Error(`day must be a YYYY-MM-DD date, got: ${day}`);
    const existing = await ctx.db
      .query("claudeSessions")
      .withIndex("by_kind_agenda_day", (q) => q.eq("kind", "weekly").eq("agendaDay", day))
      .first();
    if (existing !== null) {
      throw new Error(
        `refused: the weekly session for ${day} already exists (${existing._id})`,
      );
    }
    return await createSessionFrom(ctx, {
      title,
      kind: "weekly",
      repos,
      model,
      initialPrompt,
      agendaDay: day,
      agendaSubjects: [...new Set(agendaSubjects.map((s) => s.trim()).filter((s) => s !== ""))],
    });
  },
});

// Every Tom-facing session mutation below carries the same pen, built the same
// way as createSession / internalCreateSession above: ONE args object, ONE body
// function holding every validation, then two doors onto it — the browser
// mutation (requireTomId, then the body) and the `internalX` twin (the body).
// The pens are reopenSession, setSessionModel, forkSessionAs, sendMessage and
// sendControl; the validations live in the body precisely so a pen can never
// skip a check the browser enforces. Not repeated on each one.

// The one outcome pen for the interactive footer and every autonomous mission.
// The caller owns its session-specific purpose and outcome wording; this owns
// the credential-bearing command and its exact JSON shape.
export function sessionOutcomePen({
  sessionId,
  leadIn,
  summary,
  after,
  fenced = false,
}: {
  sessionId: Id<"claudeSessions">,
  leadIn: string;
  summary: string;
  after?: string;
  fenced?: boolean;
}): string {
  const command =
    `curl -s -X POST "$CONVEX_SITE_URL/tts/session-outcome" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"sessionId": "${sessionId}", "outcome": "completed", "summary": "${summary}"}'`;
  return fenced
    ? [leadIn, "```", command, "```", after].filter((line): line is string => line !== undefined).join("\n")
    : [leadIn, command, after].filter((line): line is string => line !== undefined).join("\n");
}

// The interactive twin of the autonomous mission's pen: same route, same key,
// and the same env contract (CONVEX_SITE_URL + TTS_WORKER_KEY are the only two
// variables the daemon injects; SESSIONS_WORKER_KEY never enters a
// model-reachable environment).
//
// The footer also carries the WORKSPACE contract when the session holds a
// checkout. The client-built prompts cannot know it (repos are resolved
// server-side, and the branch name needs the session id), and an interactive
// session that was never told the rules pushed `tts/verdict-and-names` on
// 2026-08-30 and burned turns against the command gate's denial.
function outcomePenFooter(
  sessionId: Id<"claudeSessions">,
  repos: string[],
): string {
  const workspace =
    repos.length > 0
      ? `\n\n${workspaceParagraph(
          repos,
          sessionId,
          `Work Tom asks for happens in this checkout, and session/${sessionId} is the ONLY branch this session may push — the command gate denies any other name.`,
        )}`
      : // No checkout still means a shell on the box, so the daemon rule is
        // stated on its own rather than skipped with the workspace paragraph.
        `\n\n${DAEMON_RESTART_SENTENCE}`;
  return (
    workspace +
    "\n\n---\n" +
    sessionOutcomePen({
      sessionId,
      leadIn: `This session's id: ${sessionId}. When the session's work concludes (or you and Tom agree it is done), record the outcome:`,
      summary: "one line: what happened",
      after:
        '("completed" = the session\'s purpose was met; otherwise "errored" with what blocked it. CONVEX_SITE_URL and TTS_WORKER_KEY are already set in this session\'s environment.)',
    })
  );
}

// Re-entry (spec §9: an ended session accepts a follow-up turn and continues
// with context intact). Before this, an ending was a dead end — the only way
// back to a finished conversation was a NEW session with none of its context.
const REOPEN_SESSION_ARGS = {
  sessionId: v.id("claudeSessions"),
  text: v.string(),
};

// TurnAuthor is declared with the send-message door below (schema:
// claudeInbound.author) — one home for both turn writers.
async function reopenSessionFrom(
  ctx: MutationCtx,
  { sessionId, text }: { sessionId: Id<"claudeSessions">; text: string },
  author: TurnAuthor,
): Promise<void> {
  const session = await getSessionOrThrow(ctx, sessionId);
  if (session.status !== "ended" && session.status !== "failed") {
    throw new Error(
      `Session is ${session.status} — a live session takes a turn via sendMessage; reopen is for an ended or failed one`,
    );
  }
  if (text.trim() === "") throw new Error("Message is empty");
  const now = Date.now();
  await ctx.db.patch(sessionId, {
    status: "idle",
    statusChangedAt: now,
    // Reopening a worker IS taking it over: Tom is now in the
    // conversation, so the posture becomes interactive. Left as
    // "autonomous", the daemon would re-apply the auto-end path (end the
    // session after the agent's next final turn, under a wall-clock cap) and
    // close the conversation out from under him.
    mode: "interactive",
    // A reopen resumes the CLI thread under a new SDK id, so what follows is a
    // new run; this names the one it continues.
    ...(session.runId ? { continuesRunId: session.runId } : {}),
    // ...but the flip must not ERASE the fact that this was an autonomous
    // run: the scheduler's per-todo backoff walk reads history by
    // `mode === "autonomous"`, and a reopened-then-ended run vanishing from
    // that history re-admits work Tom just closed by hand. This field is the
    // history signal `mode` can no longer carry.
    ...(session.mode === "autonomous" ? { reopenedFromAutonomous: true } : {}),
    // The two facts the DAEMON needs (see the note below): reopenedAt marks
    // this re-entry into the live poll as a reopen rather than a restart, and
    // reopenEpoch is the generation a pre-reopen ingest replay is measured
    // against (internalIngest drops stale STATE).
    reopenedAt: now,
    reopenEpoch: (session.reopenEpoch ?? 0) + 1,
    // endedReason / outcome / outcomeSummary are deliberately LEFT IN PLACE:
    // they are the honest history of the PREVIOUS ending, not claims about
    // the session's present state, and the transcript that follows keeps
    // them honest. Clearing them would erase the record of how it ended.
  });
  await ctx.db.insert("claudeInbound", {
    sessionId,
    kind: "user-turn",
    text,
    author,
    status: "pending",
    createdAt: now,
  });
  // A reopened session reappears in the poll's live scan, and delivery
  // resumes from sdkSessionId (the SDK resume key persisted on the row).
  // But the daemon DOES need the two fields above to handle it honestly:
  // re-entering the live poll with no local Session is byte-identical to a
  // daemon restart, so without reopenedAt the adoption writes a false
  // "session-host restarted; previous turn interrupted" row; and if the
  // daemon still holds a draining local for the ending it just reported, its
  // blind flush retry would land as a stale ingest without reopenEpoch. Both
  // are read in worker/session-host/session-host.mjs (poll loop +
  // adoptSession); the epoch also rides every ingest payload.
}

export const reopenSession = mutation({
  args: REOPEN_SESSION_ARGS,
  handler: async (ctx, args) => {
    await requireTomId(ctx);
    await reopenSessionFrom(ctx, args, "tom");
  },
});

export const internalReopenSession = internalMutation({
  args: REOPEN_SESSION_ARGS,
  handler: async (ctx, args) => await reopenSessionFrom(ctx, args, "agent"),
});

// Retitling is pure labelling — the title is Tom's handle on a session in the
// list, and nothing downstream keys off it.
export const renameSession = mutation({
  args: { sessionId: v.id("claudeSessions"), title: v.string() },
  handler: async (ctx, { sessionId, title }) => {
    await requireTomId(ctx);
    await getSessionOrThrow(ctx, sessionId);
    const trimmed = title.trim();
    if (trimmed === "") throw new Error("Title is empty");
    await ctx.db.patch(sessionId, { title: trimmed });
  },
});

// ── Changing a live session's model (ratified by Tom, 2026-09-04) ────────────
// He can always choose the model, at creation and mid-session. WITHIN A FAMILY
// this is a patch and nothing else: the daemon re-reads `model` off every poll
// and hands the next turn to the same runner with a different model id, so the
// conversation continues unbroken.
//
// ACROSS families it cannot be a patch, and that is why this refuses one. A
// Claude session's continuity IS its SDK session (sdkSessionId, the resume
// key); Codex holds its own thread of the same kind. Neither can adopt the
// other's, so a cross-family "change" is a new session that reads the old
// one's transcript — forkSessionAs, below.
const SET_SESSION_MODEL_ARGS = {
  sessionId: v.id("claudeSessions"),
  model: SESSION_MODEL,
};

async function setSessionModelFrom(
  ctx: MutationCtx,
  {
    sessionId,
    model,
  }: { sessionId: Id<"claudeSessions">; model: SessionModel },
): Promise<void> {
  const session = await getSessionOrThrow(ctx, sessionId);
  if (!isLive(session.status)) {
    throw new Error(
      `Session is ${session.status} — the model of a finished session is history`,
    );
  }
  if (modelFamily(session.model) !== modelFamily(model)) {
    throw new Error("use forkSessionAs for a cross-family change");
  }
  await ctx.db.patch(sessionId, { model });
}

export const setSessionModel = mutation({
  args: SET_SESSION_MODEL_ARGS,
  handler: async (ctx, args) => {
    await requireTomId(ctx);
    await setSessionModelFrom(ctx, args);
  },
});

export const internalSetSessionModel = internalMutation({
  args: SET_SESSION_MODEL_ARGS,
  handler: async (ctx, args) => await setSessionModelFrom(ctx, args),
});

/**
 * The first turn of a "reopen as": what the new session is, where the old
 * conversation is, and what to do with it. The transcript file is the whole
 * mechanism — a fork carries no SDK state across, so the previous session
 * exists for it only as text on disk.
 *
 * COMPACTION IS THE AGENT'S OWN JUDGMENT, said here explicitly because the
 * alternative was a server-side summarizer: nobody else compacts this, so a
 * session that wants a shorter working copy writes one itself.
 */
function buildForkPrompt(
  previousSessionId: Id<"claudeSessions">,
  model: SessionModel,
  text: string,
): string {
  return (
    `This session continues session ${previousSessionId} on a different model (${model}). ` +
    `The full transcript of that session — every turn of it, in order — is in the file .tts-transcript.md at the root of this workspace; ` +
    `the worker wrote it there before this first turn. Read it before you do anything else, in parts if it is large enough that one read would not fit, ` +
    `and then carry on from where it stops. Whether you also write yourself a shorter, compacted version of it is your own judgment: nothing and nobody else compacts it for you.` +
    `\n\n---\n${text}`
  );
}

// A cross-family model change: a NEW session that reads the old one's
// transcript, and the old one ended normally so its outcome stays intact.
// Returns the new session's id.
const FORK_SESSION_AS_ARGS = {
  sessionId: v.id("claudeSessions"),
  model: SESSION_MODEL,
  text: v.string(),
};

async function forkSessionAsFrom(
  ctx: MutationCtx,
  {
    sessionId,
    model,
    text,
  }: {
    sessionId: Id<"claudeSessions">;
    model: SessionModel;
    text: string;
  },
): Promise<Id<"claudeSessions">> {
  const session = await getSessionOrThrow(ctx, sessionId);
  if (text.trim() === "") throw new Error("Message is empty");
  const now = Date.now();
  // The fork inherits the whole SUBJECT of the old session — its repos, the
  // todo it was opened on, its kind — because it is the same work
  // being continued; only the model and the transcript-on-disk differ. Mode
  // is interactive: Tom asked for this session by hand, whatever the old
  // one's posture was.
  const forkId = await insertSession(
    ctx,
    {
      title: `${session.title} (as ${model})`,
      kind: session.kind,
      repos: session.repos ?? (session.repo === NO_REPO ? [] : [session.repo]),
      todoId: session.todoId,
      blockCategory: session.blockCategory,
      mode: "interactive",
      model,
      forkedFrom: sessionId,
      continuesRunId: session.runId,
      prompt: () => buildForkPrompt(sessionId, model, text),
    },
    now,
  );
  // End the OLD session the ordinary way — the same pending "stop" row the
  // browser's stop button enqueues — rather than patching it terminal here.
  // The daemon owns every status transition it can see, and a server-side
  // force-terminal would strand the process still holding the session and
  // skip the outcome it is in the middle of writing.
  if (isLive(session.status)) {
    const pending = await ctx.db
      .query("claudeInbound")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", sessionId).eq("status", "pending"),
      )
      .collect();
    if (!pending.some((p) => p.kind === "stop")) {
      await ctx.db.insert("claudeInbound", {
        sessionId,
        kind: "stop",
        status: "pending",
        createdAt: now,
      });
    }
  }
  return forkId;
}

export const forkSessionAs = mutation({
  args: FORK_SESSION_AS_ARGS,
  handler: async (ctx, args) => {
    await requireTomId(ctx);
    return await forkSessionAsFrom(ctx, args);
  },
});

export const internalForkSessionAs = internalMutation({
  args: FORK_SESSION_AS_ARGS,
  handler: async (ctx, args) => await forkSessionAsFrom(ctx, args),
});

// Who typed a turn (schema: claudeInbound.author). The browser door is behind
// requireTomId, so it writes "tom". The internal door is the CLI pen and every
// code path that relays a turn; it writes "agent" unless the caller can vouch
// for Tom — the one such caller is ttsSlack.sessionReply, which has a reply the
// events route verified came from TOM_SLACK_USER_ID and passes "tom". Only a
// "tom" turn can become a ruling in his words (ruling 15,
// ttsRulings.internalRecordRulingFromTomWords).
const TURN_AUTHOR = v.union(v.literal("tom"), v.literal("agent"));
type TurnAuthor = Infer<typeof TURN_AUTHOR>;

const SEND_MESSAGE_ARGS = {
  sessionId: v.id("claudeSessions"),
  text: v.string(),
};

async function sendMessageFrom(
  ctx: MutationCtx,
  {
    sessionId,
    text,
    author,
  }: { sessionId: Id<"claudeSessions">; text: string; author: TurnAuthor },
): Promise<void> {
  const session = await getSessionOrThrow(ctx, sessionId);
  if (!isLive(session.status)) {
    throw new Error(`Session is ${session.status} — messages cannot be sent`);
  }
  if (text.trim() === "") throw new Error("Message is empty");
  await ctx.db.insert("claudeInbound", {
    sessionId,
    kind: "user-turn",
    text,
    author,
    status: "pending",
    createdAt: Date.now(),
  });
}

export const sendMessage = mutation({
  args: SEND_MESSAGE_ARGS,
  handler: async (ctx, args) => {
    await requireTomId(ctx);
    await sendMessageFrom(ctx, { ...args, author: "tom" });
  },
});

export const internalSendMessage = internalMutation({
  args: { ...SEND_MESSAGE_ARGS, author: v.optional(TURN_AUTHOR) },
  handler: async (ctx, { author, ...args }) =>
    await sendMessageFrom(ctx, { ...args, author: author ?? "agent" }),
});

// interrupt = stop the current turn, keep the session; stop = end the session.
const SEND_CONTROL_ARGS = {
  sessionId: v.id("claudeSessions"),
  kind: v.union(v.literal("interrupt"), v.literal("stop")),
};

async function sendControlFrom(
  ctx: MutationCtx,
  {
    sessionId,
    kind,
  }: { sessionId: Id<"claudeSessions">; kind: "interrupt" | "stop" },
): Promise<void> {
  const session = await getSessionOrThrow(ctx, sessionId);
  if (!isLive(session.status)) {
    throw new Error(`Session is ${session.status}`);
  }
  // Idempotent: a same-kind control already pending is not duplicated.
  const pending = await ctx.db
    .query("claudeInbound")
    .withIndex("by_session_status", (q) =>
      q.eq("sessionId", sessionId).eq("status", "pending"),
    )
    .collect();
  if (pending.some((p) => p.kind === kind)) return;
  await ctx.db.insert("claudeInbound", {
    sessionId,
    kind,
    status: "pending",
    createdAt: Date.now(),
  });
}

export const sendControl = mutation({
  args: SEND_CONTROL_ARGS,
  handler: async (ctx, args) => {
    await requireTomId(ctx);
    await sendControlFrom(ctx, args);
  },
});

export const internalSendControl = internalMutation({
  args: SEND_CONTROL_ARGS,
  handler: async (ctx, args) => await sendControlFrom(ctx, args),
});

// Force-close is the last resort for a session whose daemon is unreachable:
// allowed ONLY when the heartbeat is stale (a reachable daemon should execute
// a stop command instead, so state stays daemon-reported fact).
export const forceClose = mutation({
  args: { sessionId: v.id("claudeSessions") },
  handler: async (ctx, { sessionId }) => {
    await requireTomId(ctx);
    const session = await getSessionOrThrow(ctx, sessionId);
    if (!isLive(session.status)) return;
    const health = await ctx.db.query("claudeDaemonHealth").first();
    if (health && Date.now() - health.lastSeenAt < DAEMON_STALE_MS) {
      throw new Error(
        "The worker is reachable — use stop; force-close is only for a stale worker",
      );
    }
    const now = Date.now();
    await ctx.db.patch(sessionId, {
      status: "ended",
      statusChangedAt: now,
      endedReason: "force-closed by Tom; worker unconfirmed",
    });
    // Settle the orphans (review finding): nothing else ever will — a
    // force-closed session drops out of the daemon's live scan, so pending
    // rows would pin ghost "sending" bubbles and a live-looking permission
    // card forever.
    const pendingInbound = await ctx.db
      .query("claudeInbound")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", sessionId).eq("status", "pending"),
      )
      .collect();
    for (const row of pendingInbound) {
      await ctx.db.patch(row._id, { status: "interrupted" });
    }
    const buf = await ctx.db
      .query("claudeStreamBuf")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    if (buf) await ctx.db.delete(buf._id);
    // A returning daemon learns from the poll that this session is terminal
    // and kills any process it still holds for it.
    await onHostedSessionEnded(ctx, session, { status: "ended", endedReason: "force-closed by Tom; worker unconfirmed" });
  },
});

// ── Internal: daemon poll (heartbeat + full state pull) ──────────────────────
// One POST /sessions/poll per tick returns everything the daemon needs for
// every non-terminal session — full state each time, no cursors: the payload
// is small (a handful of sessions, pending rows only) and idempotent pulls
// make daemon restarts a non-event (the no-state rule).

async function newestRunRow(
  ctx: QueryCtx,
  session: Doc<"claudeSessions">,
): Promise<{ seq: number; turn: number; createdAt: number } | undefined> {
  const source = rowSource(session);
  if (source.from !== "run") return undefined;
  const row = await ctx.db
    .query("claudeMessages")
    .withIndex("by_run_seq", (q) => q.eq("runId", source.runId))
    .order("desc")
    .first();
  return row === null ? undefined : { seq: row.seq, turn: row.turn, createdAt: row.createdAt };
}

export const internalPoll = internalMutation({
  args: {
    version: v.string(),
    activeAccount: v.optional(v.string()),
    daemonStartedAt: v.number(),
    // The daemon's report of its most recent permanently-rejected flush
    // (review finding: a dropped write must be visible on the surface, not
    // only in journald).
    lastIngestError: v.optional(v.string()),
    // Jarvis Box load snapshot — the scheduler's load-based admission input.
    // Stored on the same throttled heartbeat writes (no extra patch cadence).
    load: v.optional(
      v.object({
        loadavg1: v.number(),
        cpus: v.number(),
        freeMemMb: v.number(),
        totalMemMb: v.number(),
        liveSessions: v.number(),
      }),
    ),
    // Codex account usage, read off the Codex CLI by the daemon. The
    // scheduler's weekly gate reads it back; absent is UNKNOWN, and so is a
    // reading whose `readAt` is older than CODEX_USAGE_STALE_MS — the daemon
    // keeps resending its last successful reading with that reading's OWN
    // readAt while later reads fail, so age is the signal. Unknown admits: a
    // daemon that cannot read the CLI must not freeze the fleet. Reported on
    // the same throttled heartbeat as `load`. The five-hour figure is absent
    // when the account reports no such window (schema.ts says which plans).
    codexUsage: v.optional(
      v.object({
        weeklyUsedPercent: v.number(),
        fiveHourUsedPercent: v.optional(v.number()),
        weeklyResetsAt: v.optional(v.number()),
        readAt: v.number(),
      }),
    ),
    // The model slugs the box's Codex CLI lists; the orchestrator's model is
    // picked from them (convex/orchestrator.ts orchestratorModel).
    codexModels: v.optional(v.array(v.string())),
    // What this daemon can host beyond ordinary sessions. A daemon that does
    // not name "orchestrator" and "worker" is never shown a hosted row: an old
    // copy on the box would end it after its first turn.
    hosts: v.optional(v.array(v.string())),
    // The session ids the daemon holds; the orchestrator's lease is renewed
    // while its live run is among them.
    held: v.optional(v.array(v.string())),
    // Whether Fable answers on the box (ttsShared FABLE_AVAILABILITY), absent
    // while the daemon has none recorded. Stored for the pages; nothing here
    // gates on it — the launcher reads its own file.
    fableAvailability: v.optional(FABLE_AVAILABILITY),
    // The latest usage limit a Claude session hit that was not a Fable
    // refusal (ttsShared USAGE_LIMIT_REPORT). Recorded, never acted on.
    usageLimit: v.optional(USAGE_LIMIT_REPORT),
  },
  handler: async (
    ctx,
    {
      version,
      activeAccount,
      daemonStartedAt,
      lastIngestError,
      load,
      codexUsage,
      codexModels,
      hosts,
      held,
      fableAvailability,
      usageLimit,
    },
  ) => {
    const now = Date.now();
    const health = await ctx.db.query("claudeDaemonHealth").first();
    if (health) {
      // Throttle heartbeat writes: patch at most every 10s (subscription
      // economy), but always on daemon restart or an error report.
      if (
        now - health.lastSeenAt > 10_000 ||
        health.daemonStartedAt !== daemonStartedAt ||
        lastIngestError !== undefined
      ) {
        await ctx.db.patch(health._id, {
          lastSeenAt: now,
          daemonStartedAt,
          version,
          activeAccount,
          ...(load !== undefined ? { load } : {}),
          ...(codexUsage !== undefined ? { codexUsage } : {}),
          ...(codexModels !== undefined ? { codexModels } : {}),
          ...(fableAvailability !== undefined ? { fableAvailability } : {}),
          ...(usageLimit !== undefined ? { usageLimit } : {}),
          ...(lastIngestError !== undefined ? { lastIngestError } : {}),
        });
      }
    } else {
      await ctx.db.insert("claudeDaemonHealth", {
        lastSeenAt: now,
        daemonStartedAt,
        version,
        activeAccount,
        load,
        codexUsage,
        codexModels,
        fableAvailability,
        usageLimit,
      });
    }
    if (held !== undefined) await renewOrchestratorLease(ctx, held, now);
    const hostsHosted = hosts?.includes("orchestrator") === true && hosts.includes("worker");

    const sessions: unknown[] = [];
    for (const status of LIVE_STATUSES) {
      const rows = await ctx.db
        .query("claudeSessions")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect(); // bounded: live sessions are few by design
      for (const s of rows) {
        // A hosted row (the orchestrator's run, or a worker it spawned) goes
        // only to a daemon that hosts them, with what decides its ending.
        const hosted = await hostedFacts(ctx, s);
        if (hosted !== undefined && !hostsHosted) continue;
        const pendingInbound = await ctx.db
          .query("claudeInbound")
          .withIndex("by_session_status", (q) =>
            q.eq("sessionId", s._id).eq("status", "pending"),
          )
          .collect();
        sessions.push({
          id: s._id,
          status: s.status,
          kind: s.kind,
          title: s.title,
          // Both repo fields. `repos` is what the daemon clones from; `repo`
          // rides along for rows written before the multi-repo ruling, whose
          // `repos` is absent (the daemon reads `repos ?? [repo]`).
          repos: s.repos,
          repo: s.repo,
          // Posture + subject: the daemon needs mode at claim/adopt (an
          // autonomous session gets the auto-end + wall-clock-cap path) and
          // todoId/blockCategory to name what it is working on.
          mode: s.mode,
          todoId: s.todoId,
          blockCategory: s.blockCategory,
          // The model this session runs on, re-read EVERY tick: setSessionModel
          // patches the row mid-session and the daemon switches on the next
          // poll. Its family picks the runner (Agent SDK vs Codex CLI); absent
          // means a pre-2026-09-04 row, which ran Opus.
          model: s.model,
          // The session this one continues on a different model. The daemon
          // writes that session's transcript to .tts-transcript.md in the
          // workspace before the first turn — the fork's prompt tells the agent
          // to read it (forkSessionAs).
          forkedFrom: s.forkedFrom,
          sdkSessionId: s.sdkSessionId,
          nextSeq: s.nextSeq,
          // The reopen protocol: reopenedAt tells the adopt path this session
          // re-entered the live scan by a reopen (no restart happened, no turn
          // was interrupted); reopenEpoch is stamped into every ingest the
          // daemon sends for it, so a pre-reopen flush replay is recognizable
          // as stale server-side.
          reopenedAt: s.reopenedAt,
          reopenEpoch: s.reopenEpoch ?? 0,
          pendingInbound,
          // The newest row the agent file has landed for this session (its
          // seq, turn and line time), absent before the run has any. The
          // daemon clears its live tail when the turn's rows have landed, not
          // at the turn's result, and this is how it sees them land.
          newestRow: await newestRunRow(ctx, s),
          ...(hosted ?? {}),
        });
      }
    }
    // Runner steps ride the same poll: one more array on this payload, one
    // more branch in the daemon's walk, no second loop and no second key. A
    // step is not a session and writes no session row (convex/ttsRunners.ts).
    const runnerSteps = await dueRunnerSteps(ctx, now);
    return { now, sessions, runnerSteps };
  },
});

// ── Internal: daemon ingest (per-session flush) ──────────────────────────────
// ONE transaction per flush (~400ms cadence while streaming). Carries any
// subset of: status transition, stream-buffer replacement, finalized message
// rows, inbound acks, permission acks. The response piggybacks this
// session's pending commands + fresh decisions, which is what makes polling
// feel push-like exactly when a turn is live.

const MESSAGE_KIND = v.union(
  v.literal("user"),
  v.literal("assistant-text"),
  v.literal("thinking"),
  v.literal("tool-call"),
  v.literal("tool-result"),
  v.literal("permission"),
  v.literal("system"),
  v.literal("error"),
);

/**
 * The assistant-text row immediately BEFORE `seq` in this session — the output
 * a reply landing at `seq` is about, and the start of the span its label
 * carries (convex/agentLabels.ts).
 *
 * Bounded rather than unbounded: an opening turn has no assistant row before
 * it at all, and a session whose last hundred rows are tool traffic is a
 * session where the reply is not answering any one thing the agent said.
 * Undefined then, and the label carries no span — never a span starting at
 * zero, which would read as "the whole run".
 */
const PRIOR_ASSISTANT_SCAN = 100;

async function priorAssistantRowSeq(
  ctx: MutationCtx,
  sessionId: Id<"claudeSessions">,
  seq: number,
): Promise<number | undefined> {
  const before = await ctx.db
    .query("claudeMessages")
    .withIndex("by_session_seq", (q) =>
      q.eq("sessionId", sessionId).lt("seq", seq),
    )
    .order("desc")
    .take(PRIOR_ASSISTANT_SCAN);
  return before.find((row) => row.kind === "assistant-text")?.seq;
}

export const internalIngest = internalMutation({
  args: {
    sessionId: v.id("claudeSessions"),
    // The reopen generation this daemon holds for the session (from the poll
    // row it claimed/adopted from). A payload whose epoch is older than the
    // row's carries pre-reopen state and is treated as stale below.
    reopenEpoch: v.optional(v.number()),
    // Daemon-reported session facts (all optional — send what changed).
    status: v.optional(
      v.union(
        v.literal("starting"),
        v.literal("idle"),
        v.literal("running"),
        v.literal("ended"),
        v.literal("failed"),
      ),
    ),
    endedReason: v.optional(v.string()),
    sdkSessionId: v.optional(v.string()),
    // Set once the daemon knows the CLI id; never replace an existing join.
    runId: v.optional(v.string()),
    // True: this session's rows come from its agent file (rowsFrom "runs"),
    // and every reader of them honours that (convex/sessionRows.ts). Never
    // unset once set.
    rowsFromFiles: v.optional(v.boolean()),
    cwd: v.optional(v.string()),
    lastSdkEventAt: v.optional(v.number()),
    // Finalized rows, seq-ascending. Rows with seq < nextSeq are dropped
    // (idempotency floor — network retries are safe blind retries).
    finalize: v.optional(
      v.array(
        v.object({
          seq: v.number(),
          turn: v.number(),
          kind: MESSAGE_KIND,
          content: v.any(),
          // Subagent parentage: on a tool-call emitted inside a running Task
          // subagent, the parent Task's toolUseId.
          parentToolUseId: v.optional(v.string()),
          // The 32KB cut fired and the complete payload is in
          // claudeMessageOverflow under this (sessionId, seq): the daemon
          // holds a row back from the flush until its last chunk has been
          // acknowledged (OverflowQueue in worker/session-host/overflow.mjs),
          // so a stamped row always follows its chunks. Metadata only — the
          // bytes never ride the ingest body.
          overflow: v.optional(
            v.object({
              sha256: v.string(),
              byteLength: v.number(),
              chunkCount: v.number(),
            }),
          ),
        }),
      ),
    ),
    // Complete payloads the daemon could NOT store (a permanent rejection, or
    // retries spent). Each becomes a dtsEvents row naming the file on the box
    // that still holds the bytes — a payload is never dropped in silence.
    overflowFailures: v.optional(
      v.array(
        v.object({
          seq: v.number(),
          error: v.string(),
          path: v.optional(v.string()),
          byteLength: v.optional(v.number()),
        }),
      ),
    ),
    // Daemon-stamped session outcome (the autonomous auto-end / time-cap
    // path). Applied ONLY when the session has no outcome yet — an
    // agent-recorded outcome (internalRecordOutcome) always wins over the
    // daemon's cap-path stamp.
    outcome: v.optional(
      v.union(v.literal("completed"), v.literal("errored")),
    ),
    outcomeSummary: v.optional(v.string()),
    // Live-tail replacement; null clears it (turn boundary).
    buf: v.optional(
      v.union(
        v.object({ turn: v.number(), seq: v.number(), text: v.string() }),
        v.null(),
      ),
    ),
    inboundUpdates: v.optional(
      v.array(
        v.object({
          id: v.id("claudeInbound"),
          status: v.union(
            v.literal("delivered"),
            v.literal("done"),
            v.literal("interrupted"),
            v.literal("failed"),
          ),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const session = await getSessionOrThrow(ctx, args.sessionId);
    const now = Date.now();
    const patch: Record<string, unknown> = {};

    // The seq of the transcript row this flush wrote for a delivered user
    // turn. The daemon finalizes that row and pushes the turn's
    // inboundUpdates entry in the same outbox (worker/session-host/session.mjs
    // deliver), so the two halves of "Tom's turn became a transcript row"
    // arrive in one payload and the label below can name the row.
    let finalizedUserSeq: number | undefined;

    if (args.finalize && args.finalize.length > 0) {
      let maxSeq = session.nextSeq - 1;
      for (const row of args.finalize) {
        if (row.seq < session.nextSeq) {
          // Retry replay — drop. A retry's twin already landed under this seq
          // with the same stamp, and the chunks are the twin's; only when the
          // landed row carries NO stamp (a seq collision, not a retry) do the
          // chunks this replay uploaded belong to nothing, and get swept.
          if (row.overflow) {
            const landed = await messageAt(ctx, args.sessionId, row.seq);
            if (!landed?.overflow) {
              await sweepMessageOverflow(ctx, args.sessionId, row.seq);
            }
          }
          continue;
        }
        await ctx.db.insert("claudeMessages", {
          sessionId: args.sessionId,
          seq: row.seq,
          turn: row.turn,
          kind: row.kind,
          content: row.content,
          parentToolUseId: row.parentToolUseId,
          overflow: row.overflow,
          createdAt: now,
        });
        if (row.kind === "user") finalizedUserSeq = row.seq;
        if (row.seq > maxSeq) maxSeq = row.seq;
      }
      patch.nextSeq = maxSeq + 1;
    }

    // A complete payload that never reached storage is a hole in the record,
    // so it is recorded as one: the transcript already carries the daemon's
    // error row, and this is the event the digest and the weekly gather read.
    for (const failure of args.overflowFailures ?? []) {
      await logEvent(ctx, "session-overflow-unstored", session.todoId, {
        sessionId: args.sessionId,
        title: session.title,
        seq: failure.seq,
        error: failure.error,
        path: failure.path,
        byteLength: failure.byteLength,
      });
    }

    // Terminal sessions (forceClose is browser-owned) accept FINALIZE rows —
    // transcript completeness is nothing-is-lost — but no state: a late
    // daemon flush must not resurrect the status, overwrite the endedReason
    // that records what actually happened, or advance activity facts
    // (review finding: the guard originally covered status alone).
    const terminal = !isLive(session.status);
    // The same "rows yes, state no" verdict for a payload from BEFORE a reopen.
    // The daemon's ending flush is a blind retry (a committed mutation whose
    // response was lost is re-sent verbatim), and Tom can reopen in that
    // window — the replay then arrives at a LIVE row, so `terminal` is false
    // and the old ending would be re-applied over the reopen, sweeping his new
    // turn to "interrupted". The epoch the daemon stamped is the ordering fact
    // that tells the two apart.
    const stale =
      args.reopenEpoch !== undefined &&
      args.reopenEpoch < (session.reopenEpoch ?? 0);
    const noState = terminal || stale;

    // (A stale payload also clears the live tail here. That is self-healing:
    // the reopened session's own daemon rewrites the buf on its next flush,
    // ~400ms later.)
    if (args.buf !== undefined || noState) {
      const existing = await ctx.db
        .query("claudeStreamBuf")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .first();
      if (noState || args.buf === null) {
        if (existing) await ctx.db.delete(existing._id);
      } else if (args.buf) {
        if (existing) {
          await ctx.db.patch(existing._id, { ...args.buf, updatedAt: now });
        } else {
          await ctx.db.insert("claudeStreamBuf", {
            sessionId: args.sessionId,
            ...args.buf,
            updatedAt: now,
          });
        }
      }
    }

    if (!noState) {
      if (args.status !== undefined && args.status !== session.status) {
        patch.status = args.status;
        patch.statusChangedAt = now;
        // The ENDING edge, in the events table. Crossed at most once per
        // session per reopen (the guard is `!== session.status`), which is what
        // keeps the hourly update from reporting the same ending every hour.
        if (args.status === "ended" || args.status === "failed") {
          await logEvent(ctx, "session-ended", session.todoId, {
            sessionId: args.sessionId,
            title: session.title,
            status: args.status,
            endedReason: args.endedReason,
          });
        }
      }
      if (args.endedReason !== undefined) patch.endedReason = args.endedReason;
      if (args.sdkSessionId !== undefined)
        patch.sdkSessionId = args.sdkSessionId;
      if (args.runId !== undefined && session.runId === undefined)
        patch.runId = args.runId;
      if (args.rowsFromFiles === true && session.rowsFrom !== "runs")
        patch.rowsFrom = "runs";
      if (args.cwd !== undefined) patch.cwd = args.cwd;
      if (args.lastSdkEventAt !== undefined)
        patch.lastSdkEventAt = args.lastSdkEventAt;
      // The reopen is spent the moment the session is actually running again:
      // this daemon has taken the reopening turn, so the NEXT adoption of this
      // session really would be a restart and must say so. Only a current-epoch
      // payload may clear it (a stale replay never reaches this branch).
      if (args.status === "running" && session.reopenedAt !== undefined) {
        patch.reopenedAt = undefined;
      }
    }
    // Daemon-stamped outcome lands ONLY on a session with no outcome yet —
    // an agent-recorded outcome always wins over the daemon's cap-path stamp.
    const outcomeNewlyApplied =
      args.outcome !== undefined && session.outcome === undefined;
    if (outcomeNewlyApplied) {
      patch.outcome = args.outcome;
      if (args.outcomeSummary !== undefined) {
        patch.outcomeSummary = args.outcomeSummary;
      }
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.sessionId, patch);
    }

    // EDGE: the outcome field went undefined → set, and it can only make that
    // crossing once (every later ingest reads a defined session.outcome and
    // skips the branch above). The daemon may re-send the same outcome on
    // every flush of a closing session; only the first one notifies.
    if (outcomeNewlyApplied && args.outcome !== undefined) {
      if (args.outcome === "errored") {
        await notifySessionFailed(
          ctx,
          args.sessionId,
          session.title,
          args.outcomeSummary ?? outcomeEventText(session.title, args.outcome, args.outcomeSummary),
        );
      }
      await logEvent(ctx, "session-outcome", session.todoId, {
        sessionId: args.sessionId,
        title: session.title,
        outcome: args.outcome,
        summary: args.outcomeSummary,
      });
    }

    for (const upd of args.inboundUpdates ?? []) {
      const row = await ctx.db.get(upd.id);
      if (row && row.sessionId === args.sessionId) {
        // A TURN TOM TYPED BECOMES A LABEL HERE, at the pending → delivered
        // edge, and NOT at enqueue (sendMessage / reopenSession, which insert
        // the pending row). The distinction is the whole point: a pending row
        // is something Tom typed into a box, and a pending row the daemon
        // never delivered — an interrupted turn, a session force-closed before
        // its flush — was never said TO a run and has no run's output to be
        // about. What the model received is what the transcript records, so
        // the transcript row is the act (convex/agentLabels.ts writer three).
        //
        // AN "agent" TURN WRITES NOTHING, and that is the whole gate: the CLI
        // pen, the code-built opener and every relayed turn are authored by
        // agents, and an agent's own turn becoming a label would put an
        // unreviewed verdict into the corpus the golden set is mined from. A
        // row from before the author field has no author and counts as not
        // Tom, exactly as internalRecordRulingFromTomWords reads it.
        //
        // The row's own `text` is Tom's words ALONE: the transcript row
        // carries what the model received (his text plus the id line the
        // daemon appends), and the label records what he said.
        if (
          row.status === "pending" &&
          upd.status === "delivered" &&
          row.kind === "user-turn" &&
          row.author === "tom" &&
          typeof row.text === "string" &&
          finalizedUserSeq !== undefined
        ) {
          const priorAssistantSeq = await priorAssistantRowSeq(
            ctx,
            args.sessionId,
            finalizedUserSeq,
          );
          await ctx.scheduler.runAfter(
            0,
            internal.agentLabels.internalLabelFromSessionReply,
            {
              sessionId: args.sessionId,
              seq: finalizedUserSeq,
              text: row.text,
              // WHEN HE TYPED IT, not when the daemon got to it: the writer
              // picks the run of this session that had started by `at`, and a
              // reply belongs to the conversation it landed in rather than to
              // whatever was running by the time the turn was handed over.
              at: row.createdAt,
              ...(priorAssistantSeq === undefined ? {} : { priorAssistantSeq }),
            },
          );
        }
        await ctx.db.patch(upd.id, {
          status: upd.status,
          deliveredAt: upd.status === "delivered" ? now : row.deliveredAt,
        });
      }
    }

    // A payload that ENDS the session settles its still-pending inbound rows
    // as "interrupted" (the forceClose orphan-settling pattern): a terminal
    // session drops out of the daemon's live scan, so nothing else would ever
    // settle them and a pending stop/user-turn row would spin in the UI
    // forever. Runs AFTER the inboundUpdates loop so the daemon's own
    // delivered/done facts from the same flush win first.
    const becameTerminal =
      !noState &&
      (args.status === "ended" || args.status === "failed");
    if (becameTerminal) {
      const orphanedInbound = await ctx.db
        .query("claudeInbound")
        .withIndex("by_session_status", (q) =>
          q.eq("sessionId", args.sessionId).eq("status", "pending"),
        )
        .collect();
      for (const row of orphanedInbound) {
        await ctx.db.patch(row._id, { status: "interrupted" });
      }
    }

    // EDGE: a failure is reported once, on the live→terminal crossing.
    // `becameTerminal` requires `!noState` (the session was live at the top of
    // this transaction AND the payload is not a pre-reopen replay), and the
    // patch above just made it terminal, so every later flush computes
    // `terminal === true` and cannot re-fire. The `stale` half is what closes
    // the reopen hole: a replayed failure flush arrives at a live row again,
    // and without it Tom would be told twice about one failure.
    if (becameTerminal && args.status === "failed") {
      await notifySessionFailed(
        ctx,
        args.sessionId,
        session.title,
        args.endedReason ?? session.endedReason,
      );
    }
    // A hosted run's ending: the orchestrator is restarted from its document,
    // and a worker's orchestrator is told (convex/orchestrator.ts). Once, on
    // the same live→terminal edge.
    if (becameTerminal) {
      await onHostedSessionEnded(ctx, session, {
        status: args.status!,
        endedReason: args.endedReason ?? session.endedReason,
      });
    }

    // NOTE (review finding): there was a permission-REQUEST insert loop here,
    // with a Slack "waiting on a permission decision" message on the insert
    // edge. It was unreachable: the daemon's unified auto gate allows or denies
    // every tool call itself and has never had a producer for such a request,
    // so the loop could only ever run for a payload no code emits. Removed
    // rather than left as a promise the system does not keep. The live
    // needs-you edges are the failed ending above and the first outcome record;
    // a genuine "this session needs Tom" signal has to be wired to a reachable
    // edge (a turn that ends with a question), which is new work.
    // The ack loop that stood here went with the permission table (the lifeos
    // update, phase 7).

    // Piggyback: this session's pending commands ride back on the flush
    // response (~400ms latency while streaming).
    const pendingInbound = await ctx.db
      .query("claudeInbound")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", args.sessionId).eq("status", "pending"),
      )
      .collect();
    const fresh = await ctx.db.get(args.sessionId);
    return {
      nextSeq: fresh?.nextSeq ?? session.nextSeq,
      sessionStatus: fresh?.status ?? session.status,
      pendingInbound,
    };
  },
});

// ── Internal: overflow chunks (the complete payload) ─────────────────────────
// One chunk of one message's full payload, ≤256KB, behind POST
// /sessions/overflow. Each chunk is its own mutation: nothing here is inside
// internalIngest's transaction. The ordering — chunks first, then the row that
// names them — is the daemon's to keep, and it keeps it by holding the row out
// of the flush until the last chunk is acknowledged (OverflowQueue in
// worker/session-host/overflow.mjs). A row whose upload failed lands with no
// `overflow` stamp, its failure arrives as an overflowFailures entry above,
// and reingest-overflow.mjs on the box later uploads the chunks again and
// stamps the row through internalStampOverflow below.
//
// Upsert by (sessionId, seq, index): the daemon retries blindly, and a
// re-sent chunk must overwrite rather than double the payload. A chunk is
// REFUSED — { ok: false, reason }, which the route returns as 409 so the
// daemon stops re-sending it — when its shape is wrong or when a row already
// stamped under this seq names a different chunkCount: that chunk is not part
// of the payload the row promises, and storing it would corrupt one.

/** A refusal's shape, and the one place the reason is logged (never text). */
function refuseOverflow(
  reason: string,
  where: { sessionId: Id<"claudeSessions">; seq: number; index?: number },
) {
  console.warn(
    `overflow refused: ${reason} (session ${where.sessionId}, seq ${where.seq}` +
      (where.index === undefined ? ")" : `, chunk ${where.index})`),
  );
  return { ok: false as const, reason };
}

export const internalIngestOverflow = internalMutation({
  args: {
    sessionId: v.id("claudeSessions"),
    seq: v.number(),
    index: v.number(),
    chunkCount: v.number(),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    await getSessionOrThrow(ctx, args.sessionId);
    const where = { sessionId: args.sessionId, seq: args.seq, index: args.index };
    if (
      !Number.isInteger(args.seq) ||
      args.seq < 0 ||
      !Number.isInteger(args.chunkCount) ||
      args.chunkCount < 1 ||
      !Number.isInteger(args.index) ||
      args.index < 0 ||
      args.index >= args.chunkCount
    ) {
      return refuseOverflow("malformed chunk", where);
    }
    if (utf8Bytes(args.text) > OVERFLOW_CHUNK_MAX_BYTES) {
      return refuseOverflow("chunk too large", where);
    }
    const row = await messageAt(ctx, args.sessionId, args.seq);
    if (row?.overflow && row.overflow.chunkCount !== args.chunkCount) {
      return refuseOverflow("chunkCount disagrees with the row's stamp", where);
    }
    const existing = await chunkAt(ctx, args.sessionId, args.seq, args.index);
    if (existing) {
      await ctx.db.patch(existing._id, {
        chunkCount: args.chunkCount,
        text: args.text,
      });
    } else {
      await ctx.db.insert("claudeMessageOverflow", {
        sessionId: args.sessionId,
        seq: args.seq,
        index: args.index,
        chunkCount: args.chunkCount,
        text: args.text,
        createdAt: Date.now(),
      });
    }
    return { ok: true as const, index: args.index };
  },
});

// The re-ingest's second step, behind POST /sessions/overflow/stamp: the
// row landed without its stamp when the live upload failed, the chunks are
// up now, and this names them from the row. Refused when there is no row
// under the seq, when the row is already stamped with something else, or
// when the last chunk the stamp would name is not there (the uploads run in
// order, so the last one standing means the set is whole). Stamping the same
// values twice is a no-op, so a re-run after a lost response is safe.
export const internalStampOverflow = internalMutation({
  args: {
    sessionId: v.id("claudeSessions"),
    seq: v.number(),
    sha256: v.string(),
    byteLength: v.number(),
    chunkCount: v.number(),
  },
  handler: async (ctx, args) => {
    await getSessionOrThrow(ctx, args.sessionId);
    const where = { sessionId: args.sessionId, seq: args.seq };
    if (
      !Number.isInteger(args.seq) ||
      args.seq < 0 ||
      !Number.isInteger(args.chunkCount) ||
      args.chunkCount < 1 ||
      !Number.isInteger(args.byteLength) ||
      args.byteLength < 0 ||
      !/^[0-9a-f]{64}$/.test(args.sha256)
    ) {
      return refuseOverflow("malformed stamp", where);
    }
    const row = await messageAt(ctx, args.sessionId, args.seq);
    if (!row) return refuseOverflow("no message row", where);
    const stamp = {
      sha256: args.sha256,
      byteLength: args.byteLength,
      chunkCount: args.chunkCount,
    };
    if (row.overflow) {
      const same =
        row.overflow.sha256 === stamp.sha256 &&
        row.overflow.byteLength === stamp.byteLength &&
        row.overflow.chunkCount === stamp.chunkCount;
      if (same) return { ok: true as const, stamped: false };
      return refuseOverflow("row already stamped", where);
    }
    const last = await chunkAt(ctx, args.sessionId, args.seq, args.chunkCount - 1);
    if (!last || last.chunkCount !== args.chunkCount) {
      return refuseOverflow("chunks incomplete", where);
    }
    await ctx.db.patch(row._id, { overflow: stamp });
    return { ok: true as const, stamped: true };
  },
});

// Remove every chunk under (sessionId, seq): the one home for taking a
// message's complete payload out, called by the seq floor above for a
// stamped replay whose landed twin has no stamp, and what any future removal
// of claudeMessages rows must call for each row that carried `overflow`
// (nothing removes messages today). Deletes read their documents, so a
// payload of hundreds of chunks goes in bounded steps, each scheduling the
// next.
export async function sweepMessageOverflow(
  ctx: MutationCtx,
  sessionId: Id<"claudeSessions">,
  seq: number,
) {
  await ctx.scheduler.runAfter(0, internal.claudeSessions.internalSweepOverflow, {
    sessionId,
    seq,
  });
}

export const internalSweepOverflow = internalMutation({
  args: { sessionId: v.id("claudeSessions"), seq: v.number() },
  handler: async (ctx, { sessionId, seq }) => {
    const chunks = await ctx.db
      .query("claudeMessageOverflow")
      .withIndex("by_session_seq_index", (q) =>
        q.eq("sessionId", sessionId).eq("seq", seq),
      )
      .take(OVERFLOW_SWEEP_CHUNKS);
    for (const chunk of chunks) await ctx.db.delete(chunk._id);
    if (chunks.length === OVERFLOW_SWEEP_CHUNKS) {
      await sweepMessageOverflow(ctx, sessionId, seq);
    }
    return { deleted: chunks.length };
  },
});

// ── Session outcomes (ratified 2026-08-28) ───────────────────────────────────
// Every session ends with a written outcome record: "completed" (purpose met —
// including ending by recording rulings that hand work back to the pipeline)
// or "errored". A session with neither is in progress (resumable via
// sdkSessionId). Internal so the session agent itself can write it via
// `npx convex run claudeSessions:internalRecordOutcome` at wrap-up — the same
// pen pattern as tts.internalTriage; the daemon may also stamp "errored" on
// failures it observes.
export const internalRecordOutcome = internalMutation({
  args: {
    id: v.string(),
    outcome: v.union(v.literal("completed"), v.literal("errored")),
    summary: v.string(),
    // (The wrong-edge channel, `planRepair`, went with the plan pass that read
    // it: with no planner forming graphs, a "plan-repair" event had no reader.)
  },
  handler: async (ctx, { id, outcome, summary }) => {
    const normalized = ctx.db.normalizeId("claudeSessions", id);
    if (!normalized) throw new Error(`Unknown session id: ${id}`);
    const session = await ctx.db.get(normalized);
    if (!session) throw new Error(`Unknown session id: ${id}`);
    // Read the PRE-patch value: unlike the daemon's stamp in internalIngest,
    // this pen overwrites freely (the agent may re-record a sharper summary,
    // or correct completed → errored after a late failure), so the row itself
    // stops being an edge after the first write.
    const firstRecord = session.outcome === undefined;
    await ctx.db.patch(normalized, {
      outcome,
      outcomeSummary: summary.trim(),
    });
    // EDGE: only the first record notifies. A re-record still lands in the
    // row — the surface always shows the agent's latest word — but Slack is
    // told once, so an agent that revises its wording three times does not
    // ping Tom three times.
    if (firstRecord) {
      if (outcome === "errored") {
        await notifySessionFailed(
          ctx,
          normalized,
          session.title,
          summary.trim() === "" ? undefined : summary.trim(),
        );
      }
      // Same edge, same reason, into the events table the hourly update reads.
      await logEvent(ctx, "session-outcome", session.todoId, {
        sessionId: normalized,
        title: session.title,
        outcome,
        summary: summary.trim(),
      });
    }
  },
});

// ── Autonomous-fleet config (P3) ─────────────────────────────────────────────

// THE FOUR ADMISSION NUMBERS LIVE HERE, IN CODE (the lifeos update, phase 7).
// They describe how hard the Jarvis Box may be pushed — the load and memory
// ceilings admission is judged against, and the two runaway failsafes — and
// they were set once and never touched again. A number nobody changes is not a
// decision; it is mechanism, and mechanism belongs in code rather than in a
// row Tom has to hold in his head to read the agents page. So NO DOOR WRITES
// THEM any more: both pens below write these values verbatim, and Tom's own
// door (setAutoConfig) takes `enabled` alone.
//
// The columns stay in the schema until NARROW, and the scheduler still reads
// the row, so a value written before this change keeps working until the next
// press of the switch copies the code values over it. At NARROW the columns go
// and every reader takes them from here.
//
// enabled FALSE: the fleet runs nothing until the switch is deliberately on.
export const AUTO_DEFAULTS = {
  enabled: false,
  maxLoadPerCpu: 0.8,
  minFreeMemMb: 1024,
  maxLiveAutonomous: 8,
  maxNewPerTick: 2,
  defaultModel: DEFAULT_SESSION_MODEL,
} as const;

/**
 * The one writer of the singleton row. It takes the two things that are still
 * decisions — whether the fleet runs, and which model it runs on — and writes
 * the four admission numbers from AUTO_DEFAULTS every time, which is what
 * makes those numbers code-owned while their columns are still in the schema.
 * An omitted `defaultModel` keeps whatever the row already holds (undefined is
 * never written), so a call that says nothing about the model cannot reset it.
 */
async function upsertAutoConfig(
  ctx: MutationCtx,
  fields: { enabled: boolean; defaultModel?: SessionModel },
): Promise<void> {
  const existing = await ctx.db.query("claudeAutoConfig").first();
  const { enabled, defaultModel } = fields;
  const row = {
    maxLoadPerCpu: AUTO_DEFAULTS.maxLoadPerCpu,
    minFreeMemMb: AUTO_DEFAULTS.minFreeMemMb,
    maxLiveAutonomous: AUTO_DEFAULTS.maxLiveAutonomous,
    maxNewPerTick: AUTO_DEFAULTS.maxNewPerTick,
    enabled,
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    updatedAt: Date.now(),
  };
  if (existing) {
    await ctx.db.patch(existing._id, row);
  } else {
    await ctx.db.insert("claudeAutoConfig", row);
  }
}

// What the page reads. The four numbers come from the code, not from the row,
// so the answer is what the scheduler will actually be admitting under once
// the switch is next pressed — and so a row still carrying an older value
// cannot show Tom a number nothing means to keep.
export const getAutoConfig = query({
  args: {},
  handler: async (ctx) => {
    await requireTomId(ctx);
    const row = await ctx.db.query("claudeAutoConfig").first();
    return {
      ...AUTO_DEFAULTS,
      ...(row === null
        ? {}
        : {
            enabled: row.enabled,
            // A row written before the field existed still has a default: the
            // model named here is the one the scheduler would actually use.
            defaultModel: row.defaultModel ?? DEFAULT_SESSION_MODEL,
          }),
      fromDefaults: row === null,
    };
  },
});

// Tom's door, and the whole of it: ON or OFF. See the fleet strip in
// app/agents/components/session-list.tsx. The stored default model is
// carried through untouched — a press of "stop" decides nothing about which
// model the fleet runs on.
export const setAutoConfig = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }) => {
    await requireTomId(ctx);
    await upsertAutoConfig(ctx, { enabled });
  },
});

// The CLI pen for supervised enable at deploy:
// `npx convex run claudeSessions:internalSetAutoConfig '{"enabled": true}'`
// — same upsert as setAutoConfig (which needs Tom's browser identity the
// Jarvis Box does not hold), plus the fleet's default model, which has no
// browser control. Use only while supervising the first ticks. It no longer
// takes the four admission numbers: they are code-owned (AUTO_DEFAULTS), and
// a command line that names one is refused rather than quietly ignored.
export const internalSetAutoConfig = internalMutation({
  args: { enabled: v.boolean(), defaultModel: v.optional(SESSION_MODEL) },
  handler: async (ctx, fields) => {
    await upsertAutoConfig(ctx, fields);
  },
});

// ── Autonomous mission prompt ────────────────────────────────────────────────

function promptFact(label: string, value: string | undefined): string | null {
  return value && value.trim() !== "" ? `${label}: ${value}` : null;
}

// Which repos a mission's workspace holds is answered ONCE, by
// resolveSessionRepos above (the one home). This lane used to answer it here,
// with pickMissionRepo — a case-sensitive substring search over the todo's
// words that could only ever return ONE repo. It is gone; the substring scan
// survives only as the resolver's fallback when no caller names the repos.

/**
 * The workspace paragraph, one home for every mission prompt. The agent must
 * be told exactly what is on disk and where, because it cannot see the clone
 * plan: with one repo the working directory IS the checkout, with several it
 * is the PARENT holding one directory per repo (the daemon's ensureWorkdir is
 * the other half of this contract — keep the two in step).
 *
 * `work` is the lane's own sentence about what to do with the checkout, kept
 * per-caller because a groundwork mission and a worker mission mean different
 * things by "implement".
 */
// BOX_TOOLS_PARAGRAPH and DAEMON_RESTART_SENTENCE live in ttsShared.ts, which
// the runner's step prompt (convex/ttsRunners.ts) reads too.

export function workspaceParagraph(
  repos: string[],
  sessionId: Id<"claudeSessions">,
  work: string,
): string {
  const branch = `session/${sessionId}`;
  if (repos.length === 1) {
    return `The workspace: your working directory is a fresh checkout of ${repos[0]} on branch ${branch}. ${work} Commit as you go and push the branch (the remote is already configured). Open a pull request with \`gh pr create\` ONLY when the work is merge-ready, and say so in the outcome summary. ${DAEMON_RESTART_SENTENCE}`;
  }
  const list = repos.map((r) => `\`./${r}\``).join(" and ");
  return `The workspace: your working directory holds ${repos.length} fresh checkouts, one per repository — ${list}. Each is on its own branch ${branch}. ${work} \`cd\` into the repository you are changing before running git: commit as you go and push ${branch} in EACH repository you touched (every remote is already configured), and open a pull request per repository with \`gh pr create\` ONLY when that repository's work is merge-ready. Name every branch and pull request you opened in the outcome summary. ${DAEMON_RESTART_SENTENCE}`;
}

// Autonomous sessions are unattended, so a question that genuinely needs
// Tom's judgment goes to the delegate instead of quietly becoming a todo.
// The narrow list itself stays in ttsShared: the worker command and this
// prompt must name the same four things Tom keeps for himself.
function delegateDoctrine(sessionId: Id<"claudeSessions">, todoId?: Id<"dtsTodos">): string {
  const todo = todoId === undefined ? "" : ` --todo ${todoId}`;
  const narrow = NARROW_LIST.map((item) => item.decision).join("; ");
  return [
    "When a decision genuinely cannot be taken on your own judgment, ask the delegate — one command, one answer, about two minutes:",
    `\`tts-ask --session ${sessionId}${todo} --question "<one sentence>" --option "<a>" --option "<b>" --recommend "<the one you would take>" --fallback "<what you will do if it does not answer>"\``,
    "The delegate is a Fable run holding Tom's rules and intent. Its answer is a decision, not a ruling; it is recorded and appears in his objection list, where silence means it stands. Do not start a second ask in parallel or do other work while it runs.",
    `It refuses only this narrow list: ${narrow}. On a refusal, do not take the action: park the item through the prepare pen with readiness \"prepared\", the one action only Tom can take, and evidence naming the ask and your default; then carry on. If it does not answer, take your stated fallback, say so in the outcome summary, and carry on. At most five asks in one session; decide everything else yourself.`,
  ].join("\n\n");
}

// A merge is unattended work once its three mechanical checks pass (Tom,
// 2026-09-09: merging is mechanical when the tests, the audit and the evals
// pass, and is then REPORTED for objection rather than asked about — which is
// why it is not on the narrow list). Since Tom's ruling of 2026-09-24 the
// evals are reported but not required, for now: EVALS_REQUIRED_FOR_MERGE in
// convex/ttsMerge.ts decides, and this paragraph reads the same constant so
// it and the box say the same thing.
//
// THE GATE IS MECHANICAL AND THE BOX ENFORCES IT. A lone `git merge` or
// `gh pr merge` is ruled on by the daemon before it runs: it reads HEAD in the
// checkout and asks GET /tts/merge-gate for the checks
// (worker/session-host/merge-gate.mjs, convex/ttsMerge.ts). Every required
// check on record → the command runs and a transcript row says which checks
// let it. Any missing → denied, naming them. So this paragraph and the box
// agree, and a session that reads it and tries to merge finds out immediately
// which one is not there yet.
//
// POST /tts/merge is the REPORT, and it runs the same gate again: it is what
// puts the merge in the morning's objection list and posts one line to
// #tts-decisions. It cannot make an ungated merge legitimate.
export function mergeGate(): string {
  return [
    EVALS_REQUIRED_FOR_MERGE
      ? "Merging is mechanical, not Tom's gate. A merge is allowed when three things are on record for the exact commit you are merging: the tests are green, an audit approved it (a `VERDICT: APPROVED` line posted to /tts/audit), and an evals run scored it with no regression."
      : "Merging is mechanical, not Tom's gate. A merge is allowed when two things are on record for the exact commit you are merging: the tests are green, and an audit approved it (a `VERDICT: APPROVED` line posted to /tts/audit). The evals are still scored and reported for the commit, but by Tom's ruling of 2026-09-24 they are not required for merging for now.",
    "Run the merge as its OWN command — `git merge` or `gh pr merge`, nothing chained to it. The box checks them itself and either runs it or denies it naming which are missing; you never have to ask.",
    "After a merge, POST /tts/merge through the worker-key pen with its repo, the merged sha, and a concise summary. That is the report, not the permission: it puts the merge in Tom's morning objection list and in #tts-decisions, where silence means it stands.",
  ].join("\n\n");
}

// Opening prompt for an AUTONOMOUS session. The sessionId rides in so the
// outcome pen can name this session — the agent has no other way to learn its
// own id. Interactive openings have their own framing in
// app/lib/tts-session-prompt.ts; they do not share this autonomous contract.
function buildAutoMissionPrompt(
  todo: Doc<"dtsTodos">,
  sessionId: Id<"claudeSessions">,
  repos: string[],
): string {
  // Facts block — same labels and order as the interactive twin's
  // buildTodoSessionPrompt (category is autonomous-only: it scopes what a
  // block-lane session may touch).
  const itemContext = [
    `The item ("${todo.statement}"):`,
    promptFact("category", todo.category),
    promptFact("work description", todo.workDescription),
    promptFact("entry action", todo.entryAction),
    promptFact("body", todo.body),
    // Cut at the same cap the interactive twin uses, through the same
    // function, which appends the line saying where the rest is
    // (shared/context-relevance.mjs).
    promptFact("brief", todo.brief === undefined ? undefined : briefForPrompt(todo.brief).text),
    // Tom's must-not-break line on a goal: it binds every step toward the goal.
    // The worker prompt that carried it went with batches (2026-09-24); this is
    // where an agent working the goal now reads it.
    promptFact("must not break (Tom's line; a change that would break it is not a change to make)", todo.mustNotBreak),
  ];
  const lines: (string | null)[] = [
    WORKER_CONTRACT,
    "",
    `The goal: do the groundwork this item needs — research, draft, gather — and write what you produce into the item via the prepare pen below. Set readiness to "prepared" when the write-up is complete — and only then; a prepared item that is active, awake and unblocked is what TTS shows Tom as ready.`,
    "",
    // Ratified doctrine (Tom, 2026-08-29): his input gates PERSISTENCE, never
    // implementation — a session that halts at a decision leaves him nothing
    // concrete to rule on.
    `Tom decisions: a decision of Tom's does NOT block you. Implement your best-judgment option and name the alternatives you passed over in the write-up; the decision then surfaces where the work persists — the pull request, or the ruling on this item. Leave for Tom only what ONLY he can do: rulings and real-world actions.`,
    "",
    delegateDoctrine(sessionId, todo._id),
    "",
  ];
  lines.push(
    "",
    // The env contract: the daemon injects ONLY these two variables into an
    // autonomous session's shell — SESSIONS_WORKER_KEY (the ingest key) never
    // enters a model-reachable environment (the auth-clobber lesson), which
    // is why the outcome pen below rides the TTS key.
    "The pens (shell commands; CONVEX_SITE_URL and TTS_WORKER_KEY are already set in this session's environment):",
    "",
    "1. Write your work into the item:",
    "```",
    `curl -s -X POST "$CONVEX_SITE_URL/tts/prepare-todo" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"id": "${todo._id}", "brief": "...", "entryAction": "...", "workDescription": "...", "readiness": "prepared"}'`,
    "```",
    'Every field except "id" is optional — send only what you produced.',
    "",
    sessionOutcomePen({
      sessionId,
      leadIn: "2. Record this session's outcome when the mission is done:",
      summary: "one line: what landed where",
      after:
        '"completed" means the mission produced its artifact; otherwise record "errored" with a summary saying what blocked you.',
      fenced: true,
    }),
    "",
    // Two workspace variants. No repos is the groundwork posture (unchanged);
    // a repo-equipped mission implements the code itself and stops exactly at
    // the merge — the one gate the doctrine keeps for Tom.
    ...(repos.length === 0
      ? [
          // No workspace paragraph in this posture, so the daemon sentence
          // rides here instead — a session with no checkout still has a shell
          // on the box and can still stop the daemon.
          `Prohibitions: never record a ruling and never change a status — verdicts and status changes are Tom's pens alone. Never touch code — this session has an EMPTY scratch directory and no repository; anything that needs code goes into the write-up as work still to do instead. ${DAEMON_RESTART_SENTENCE}`,
        ]
      : [
          workspaceParagraph(
            repos,
            sessionId,
            "Implement the agent steps INCLUDING the code ones.",
          ),
          "",
          `Prohibitions: never record a ruling and never change a status — verdicts and status changes are Tom's pens alone. Never push any branch other than session/${sessionId}. ${mergeGate()}`,
        ]),
    "",
    BOX_TOOLS_PARAGRAPH,
    "",
    "Ending: record the outcome via the /tts/session-outcome command, then simply stop responding — the daemon ends the session after your final turn.",
    "",
    ...itemContext,
  );
  return lines.filter((l): l is string => l !== null).join("\n");
}

// ── The code mission (the lifeos update, phase 7) ────────────────────────────
// Tom's approve or archive ruling on a CODE todo — an entry in a repo's
// vqc/todos.yaml, briefed on the /tts page — is carried out by an autonomous
// session on that repo's checkout, the way worker/jobs/execute-approved.mjs
// did on its own hourly clone before this: implement the plan (approve) or
// close the entry (archive), run the registry's own guard test, commit, push
// session/<id>, open a pull request, and merge only after the three mechanical
// checks pass for its head — the box enforces that itself (worker/session-host/
// merge-gate.mjs). Every merge is then recorded for objection.

/** How a registry-keeping repo checks its own todo file — read off the one
 * home (ttsShared CODE_TODO_REPOS). A mission is told to run it and to fix
 * what it breaks: the PR must never carry a malformed registry. */
const codeTodoGuard = (repo: string): string | undefined =>
  tracksCodeTodos(repo)
    ? CODE_TODO_REPOS[repo as keyof typeof CODE_TODO_REPOS].guard
    : undefined;

/** The one line a code mission's ruling row records at admission. */
export const codeMissionApplyResult = (sessionId: string): string =>
  `admitted as session ${sessionId}`;

function buildCodeMissionPrompt(args: {
  repo: string;
  externalId: string;
  verdict: "approve" | "archive";
  sentence?: string;
  statement: string;
  brief: string;
  sessionId: Id<"claudeSessions">;
}): string {
  const { repo, externalId, verdict, sentence, statement, brief, sessionId } = args;
  const branch = `session/${sessionId}`;
  const guard = codeTodoGuard(repo);
  const codeTodoContext: (string | null)[] = [
    verdict === "approve"
      ? `TOM RULED "approve": the entry's attached plan is the ratified decision, not a suggestion. Implement it faithfully. Where the plan is silent, follow the repository's existing conventions and do not widen scope. Close the entry in ${CODE_TODO_PATH} in this same body of work, per that file's own discipline: move it below the closed-todos banner, keeping its full body, adding a \`closed: <today>\` date and a \`resolution:\` describing what landed.`
      : `TOM RULED "archive": the entry is set aside — already done, moot, or superseded. Do NOT implement it. Close it in ${CODE_TODO_PATH} per that file's own discipline: move the entry below the closed-todos banner, keeping its full body, adding a \`closed: <today>\` date and a \`resolution:\` that says it was archived by Tom's TTS ruling${sentence ? " and quotes his sentence" : ""}, with the evidence the brief names if it names any. Until your pull request merges, the TTS mirror of ${CODE_TODO_PATH} still says the entry is open, so a second "archive" ruling on it would open a second pull request for the same close — say so in the pull request body, so Tom merges rather than re-rules.`,
    "",
    `THE CODE TODO: the entry \`${externalId}\` in ${CODE_TODO_PATH} of the ${repo} repository — the repository's own registry of decided work, where each entry carries a statement, a completion condition and (for the ready tier) a plan. The repository is the system of record for it; TTS only mirrors it.`,
    `statement: ${statement}`,
    promptFact("Tom's sentence with the ruling", sentence),
    "",
    "THE BRIEF Tom ruled from (written against the tree as it stood then; verify against the tree in front of you, and name in your pull request anything that has moved):",
    brief,
  ];
  const lines: (string | null)[] = [
    WORKER_CONTRACT,
    "",
    delegateDoctrine(sessionId),
    "",
    workspaceParagraph(
      [repo],
      sessionId,
      `${verdict === "approve" ? "Implement the plan, then close the entry." : "Close the entry."} Run \`${guard ?? "the repository's own guard test for that file"}\` and the tests nearest your change, and fix what you break — a pull request never carries a malformed registry.`,
    ),
    "",
    `Open the pull request in every case that produced commits: it is how the work reaches Tom. Its body STARTS with the line "CHANGE REPORT:" and ends with the line "This pull request may merge only when the tests, the audit and the evals all pass for its head; its merge is then reported for objection."`,
    "",
    sessionOutcomePen({
      sessionId,
      leadIn:
        "The pen (a shell command; CONVEX_SITE_URL and TTS_WORKER_KEY are already set in this session's environment). Record this session's outcome when you stop:",
      summary: "one line: the pull request URL and what it does",
      after:
        '"completed" means the pull request exists; otherwise record "errored" with a summary that says what blocked you — Tom re-rules to retry.',
      fenced: true,
    }),
    "",
    `Prohibitions: never record a ruling and never change the status of any TTS todo — verdicts are Tom's pens alone. Never push any branch other than ${branch}. ${mergeGate()}`,
    "",
    BOX_TOOLS_PARAGRAPH,
    "",
    "Ending: record the outcome, then simply stop responding — the daemon ends the session after your final turn.",
    "",
    ...codeTodoContext,
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

// At most this many code missions admitted per tick, and at most this many
// live at once. One, as execute-approved ran one per hour: it keeps pull
// requests reviewable in series and a bad run costs one slot, not a pileup.
const CODE_MISSIONS_PER_TICK = 1;
const CODE_MISSIONS_MAX_LIVE = 1;

/**
 * The code lane: Tom's live, unapplied approve and archive rulings on code
 * todos — archives first, then oldest ruling first — each admitted as a
 * worker mission on its repo's checkout. A ruling applies AT ADMISSION with the session id — a failed
 * mission is not retried by the fleet; Tom re-rules to retry, as with the
 * executor before. Returns how many it admitted (0 or 1).
 *
 * What it refuses, and how it records the refusal:
 *   - a repo no session can check out, or an entry not open in the mirror, or
 *     one with no brief: the ruling is marked applied with the reason, so it
 *     cannot ride the feed forever;
 *   - the per-subject ceiling (AUTO_MAX_SESSIONS_PER_TODO, by_code_subject):
 *     marked applied with the reason for the same cause;
 *   - a live mission on the same subject, or CODE_MISSIONS_MAX_LIVE reached:
 *     left pending for a later tick.
 */
async function admitCodeMissions(
  ctx: MutationCtx,
  now: number,
  liveSessions: Doc<"claudeSessions">[],
  fleet: FleetModelContext,
  liveBySubject: Map<string, Doc<"dtsRulings">>,
  budget: number,
): Promise<number> {
  if (budget <= 0) return 0;
  const liveCode = liveSessions.filter(
    (s) => s.mode === "autonomous" && s.codeRepo !== undefined,
  );
  if (liveCode.length >= CODE_MISSIONS_MAX_LIVE) return 0;

  const rulings = [...liveBySubject.values()]
    .filter(
      (r) =>
        r.subjectType === "code" &&
        r.appliedAt === undefined &&
        (r.verdict === "approve" || r.verdict === "archive") &&
        r.repo !== undefined &&
        r.externalId !== undefined,
    )
    // Archives first, then oldest ruling first: closing an entry is one
    // registry edit and a pull request, cheap and short, and it is Tom
    // setting work ASIDE — an approve behind it can implement for an hour,
    // and holding a set-aside behind that, one mission at a time, leaves the
    // entry open in the mirror (and on Tom's plate) for no reason.
    .sort(
      (a, b) =>
        (a.verdict === "archive" ? 0 : 1) - (b.verdict === "archive" ? 0 : 1) ||
        a.ruledAt - b.ruledAt,
    );

  let admitted = 0;
  for (const ruling of rulings) {
    if (admitted >= Math.min(budget, CODE_MISSIONS_PER_TICK)) break;
    const repo = ruling.repo!;
    const externalId = ruling.externalId!;
    const verdict = ruling.verdict as "approve" | "archive";
    const refuse = async (why: string) => {
      await ctx.db.patch(ruling._id, {
        appliedAt: now,
        applyResult: `refused: ${why}`,
      });
      await logEvent(ctx, "ruling-applied", undefined, {
        verdict,
        repo,
        externalId,
        result: `refused: ${why}`,
      });
    };
    if (!isSessionRepo(repo)) {
      await refuse(`no session can check out ${repo}`);
      continue;
    }
    if (!tracksCodeTodos(repo)) {
      await refuse(`${repo} keeps no code-todo file any more`);
      continue;
    }
    if (
      liveCode.some((s) => s.codeRepo === repo && s.codeExternalId === externalId)
    ) {
      continue; // a mission on it is already running
    }
    const mirrored = await ctx.db
      .query("dtsCodeTodoMirror")
      .withIndex("by_repo_external", (q) =>
        q.eq("repo", repo).eq("externalId", externalId),
      )
      .first();
    if (!mirrored || mirrored.status !== "open") {
      await refuse(`${externalId} is not open in the ${repo} mirror`);
      continue;
    }
    const brief = await ctx.db
      .query("dtsCodeBriefs")
      .withIndex("by_repo_external", (q) =>
        q.eq("repo", repo).eq("externalId", externalId),
      )
      .unique();
    if (!brief) {
      await refuse(`${externalId} has no brief`);
      continue;
    }
    // The far bound, per subject — the todo rule, one level over.
    const history = await ctx.db
      .query("claudeSessions")
      .withIndex("by_code_subject", (q) =>
        q.eq("codeRepo", repo).eq("codeExternalId", externalId),
      )
      .collect();
    if (history.filter(wasAutonomous).length >= AUTO_MAX_SESSIONS_PER_TODO) {
      await refuse(
        `${externalId} has drawn ${AUTO_MAX_SESSIONS_PER_TODO} missions already`,
      );
      continue;
    }
    // The fleet default, falling back off Codex when the door is shut; a
    // code todo carries no model tag, so "wait" cannot come back.
    const model = await resolveFleetModel(ctx, fleet);
    const sessionId = await insertSession(
      ctx,
      {
        title: `auto: ${verdict} ${externalId}`,
        kind: "adhoc",
        repos: resolveSessionRepos({ explicit: [repo] }),
        codeSubject: { repo, externalId },
        mode: "autonomous",
        model,
        prompt: (id) =>
          buildCodeMissionPrompt({
            repo,
            externalId,
            verdict,
            sentence: ruling.sentence,
            statement: mirrored.statement,
            brief: brief.brief,
            sessionId: id,
          }),
        outcomePen: false,
      },
      now,
    );
    // The ruling is applied HERE, with the session that carries it out —
    // the moment its effect exists (ttsRulings.ts header).
    await ctx.db.patch(ruling._id, {
      appliedAt: now,
      applyResult: codeMissionApplyResult(sessionId),
    });
    await logEvent(ctx, "ruling-applied", undefined, {
      verdict,
      repo,
      externalId,
      result: codeMissionApplyResult(sessionId),
    });
    await logEvent(ctx, "auto-session-created", undefined, {
      sessionId,
      repo,
      externalId,
      verdict,
    });
    liveCode.push({ codeRepo: repo, codeExternalId: externalId } as Doc<"claudeSessions">);
    admitted++;
  }
  return admitted;
}

// ── The prospecting lane ─────────────────────────────────────────────────────
// Tom's directive (2026-08-29): "review the CMT and tom.quest repos for issues
// to make more to-dos." A PROSPECTING MISSION is a worker that
// works no todo: it reads one repo's fresh checkout, looks for concrete issues,
// and captures each new one as an unprepared item.
//
// PARALLEL, NOT LAST RESORT (Tom's amendment the same night: keeping the Jarvis Box at
// FULL CAPACITY overnight is the top priority, and "six hours is insane"). Real
// todo work takes the per-tick budget FIRST; prospecting spends whatever is
// left over on the same tick. So a tick that admits one real mission out of a
// budget of two admits a prospector alongside it — the budget is a capacity
// bound, and leaving it unspent is the thing being fixed.
//
// Doctrine kept intact: input gates PERSISTENCE, not implementation, and the
// worker key may CAPTURE but never rule. A captured finding lands as an
// ordinary unprepared todo and waits for Tom's pen like any other. Speculative
// findings are welcome — Tom reviews everything, and a review he declines costs
// him one glance.

// Which repos get prospected: every session repo EXCEPT the ones named here.
// Derived from SESSION_REPOS (the one home) rather than hand-listed, so a repo
// added there is prospected by default and a repo that should not be has to say
// why — the exclusion carries the reason, which a second hand-written list
// could not. WikiTom is a wiki, not a source of code issues.
const PROSPECT_EXCLUDED: readonly string[] = ["WikiTom"];
const PROSPECT_REPOS = SESSION_REPO_NAMES.filter(
  (repo) => !PROSPECT_EXCLUDED.includes(repo),
);

// How many prospecting missions may be LIVE at once. Two, so both repos can be
// under review at the same time while real work keeps its own slots; every
// prospector still counts against maxLiveAutonomous like any other session.
const PROSPECT_MAX_LIVE = 2;

// At most one prospecting mission per repo per 30 minutes. Not a backoff and
// not a rationing device — just enough to stop a repo being re-scanned in
// identical state twice in a row: a capture needs a few minutes to flow into
// prep, so a scan minutes apart would read the same tree and reach the same
// findings. The clock starts at CREATION, so a prospector that errors has
// already spent the window by the time it ends.
const PROSPECT_COOLDOWN_MS = 30 * 60 * 1000;
// How far back the cooldown/fairness read looks, and how many rows it may
// read. dtsEvents is the system's append-only instrumentation (busy: every
// surfacing, capture, and queue cycle lands there), so the read is bounded on
// both axes — see the truncation note in admitProspectMission.
const PROSPECT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const PROSPECT_EVENT_SCAN = 1000;
// Quality over volume: the cap is stated in the prompt, not enforced here (the
// capture route is the agent's own pen). One number, one home.
const PROSPECT_CAPTURE_CAP = 8;

// Opening prompt for a PROSPECTING mission. It puts the fixed finding criteria
// before mission-specific context, then the pens, prohibitions, and ending.
// There is no item facts block or prepare pen, and the read-first step is
// mandatory because the only way to avoid handing Tom a duplicate is to look
// at what he already holds.
function buildProspectMissionPrompt(
  repo: string,
  sessionId: Id<"claudeSessions">,
): string {
  const prospectContext = [
    `The mission: this session PROSPECTS — it works no todo item. TTS had session capacity left over after handing out its real todo work this tick, and spends it here. Your working directory is a fresh checkout of ${repo}. Read it for actionable issues worth carrying as items in Tom's todo system, and capture each NEW one with the capture pen below. This mission only READS and CAPTURES — no code changes, no commits, no pushes, no pull requests.`,
  ];
  const lines: string[] = [
    WORKER_CONTRACT,
    "",
    "What counts as a finding:",
    "- a failing or skipped test — name the test and the file it lives in",
    "- dead code: a function, export, module, flag, or config key nothing reaches",
    "- a document that contradicts the code it describes — name both files",
    "- a TODO or FIXME comment in the source that nothing tracks",
    "- a broken link between modules: a stale import path, a field one side renamed and the other still reads, one rule implemented two different ways in two files",
    "- vocabulary drift: one fact carried under two names, or one name meaning two different things",
    "",
    `The quality bar: every finding NAMES the file or files it lives in, and is actionable by a future session holding nothing but your one sentence and the repo. A finding you are not certain about is still worth capturing when it names a change — Tom reads every item and declining one costs him a glance. What is not worth capturing is a style nitpick or a "this could be cleaner" with no named change: if you cannot say what would change and where, it is not a finding. At most ${PROSPECT_CAPTURE_CAP} captures for the whole mission: a short list of real findings is worth more than a long one, and finding NOTHING new is an honest, complete outcome.`,
    "",
    delegateDoctrine(sessionId),
  ];
  // A repo that governs itself by an in-repo code-todo registry holds
  // already-tracked work a prospector must not re-capture. WHICH repos those
  // are comes from the one home the mirror cron reads (ttsShared
  // .CODE_TODO_REPOS) — this was hand-written as `repo === "ComplexMultiTrigger"`
  // and went stale the moment tom.quest grew a registry of its own: the cron
  // mirrored tom.quest's 15 entries while tom.quest prospectors were never told
  // the file existed.
  //
  // The CHECKOUT, not /tts/state, is what the prospector reads. /tts/state
  // answers "what items does TTS hold" (dtsTodos); these entries are not items
  // — dtsCodeTodoMirror is a link-by-id-never-copy reflection of a file the
  // repo owns, refreshed from the DEFAULT branch, so it is stale exactly when
  // a prospector's own branch has moved. The file in front of the prospector
  // is the fresher and more authoritative copy of the same fact.
  if (tracksCodeTodos(repo)) {
    lines.push(
      "",
      `This repo also tracks its own code todos in \`${CODE_TODO_PATH}\` in your checkout — a governed registry of work already decided on. Read that file too, and drop any finding it already names.`,
    );
  }
  lines.push(
    "",
    "The pens (shell commands; CONVEX_SITE_URL and TTS_WORKER_KEY are already set in this session's environment):",
    "",
    "1. READ WHAT TTS ALREADY HOLDS — do this BEFORE you capture anything:",
    "```",
    `curl -s "$CONVEX_SITE_URL/tts/state" -H "X-TTS-Key: $TTS_WORKER_KEY"`,
    "```",
    'The response carries every item in the system under "todos". Read their statements. Never capture a finding that restates one of them, or that an item plainly already covers — a duplicate costs Tom a triage he has already done.',
    "",
    "2. Capture ONE new finding (repeat per finding, up to the cap above):",
    "```",
    `curl -s -X POST "$CONVEX_SITE_URL/tts/capture" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"statement": "Delete the unreachable helper someHelper in path/to/file.ts", "source": "prospecting", "provenance": "prospect mission ${sessionId}, ${repo}, path/to/file.ts"}'`,
    "```",
    'The statement is ONE imperative sentence that names the file or files. The provenance is where you found it, in exactly the shape above — that is how the item says which mission and which path it came from. Keep "source" as "prospecting".',
    "",
    sessionOutcomePen({
      sessionId,
      leadIn: "3. Record this session's outcome when the mission is done:",
      summary: "one line: what was captured",
      after:
        '"completed" is the right outcome whether you captured findings or none — say what you captured, or say "nothing new found" and mean it. Record "errored" only when something blocked the review itself (the checkout was unusable, /tts/state would not answer).',
      fenced: true,
    }),
    "",
    // This prompt builds its own workspace sentence rather than calling
    // workspaceParagraph (a prospector pushes nothing), so it names the daemon
    // rule itself.
    `Prohibitions: never record a ruling and never change a status — verdicts and status changes are Tom's pens alone. Change no file in the checkout, commit nothing, push nothing, and open no pull request: this mission's only output is captured items. Do not capture a duplicate of something TTS already holds, and do not capture more than ${PROSPECT_CAPTURE_CAP} items. ${DAEMON_RESTART_SENTENCE}`,
    "",
    "Ending: record the outcome via the /tts/session-outcome command, then simply stop responding — the daemon ends the session after your final turn.",
    "",
    ...prospectContext,
  );
  return lines.join("\n");
}

/**
 * What the fleet knows about models when it starts a session: the fleet default
 * and whether the Codex door is shut. Read once per tick and handed to every
 * lane, so no lane can quietly answer the question for itself.
 */
type FleetModelContext = {
  defaultModel?: SessionModel;
  codexClosed: boolean;
  codexWeeklyCapped: boolean;
};

/**
 * WHICH MODEL a fleet-started session runs on — ONE HOME for the rule, because
 * every lane that starts a session needs it and the prospecting lane drifted:
 * it passed no model at all, so a prospector took insertSession's built-in
 * default, ignoring both the fleet knob Tom sets and the Codex door the rest of
 * the tick respects.
 *
 * The order is the todo's own tag (the planner's judgment about THAT task),
 * then the fleet default, then the built-in default. When the Codex door is
 * shut and that answer is a Codex model the two cases part ways: a TAGGED todo
 * WAITS (undefined — the tag is a judgment, not a preference), while an
 * untagged one falls back to Claude, logged so the morning's history says why
 * the models differ. A prospecting mission carries no tag, so it is always the
 * untagged case and never gets `undefined` back.
 */
async function resolveFleetModel(
  ctx: MutationCtx,
  fleet: FleetModelContext,
  tagged?: SessionModel,
  todoId?: Id<"dtsTodos">,
): Promise<SessionModel | undefined> {
  const model = tagged ?? fleet.defaultModel ?? DEFAULT_SESSION_MODEL;
  if (!fleet.codexClosed || modelFamily(model) !== "codex") return model;
  if (tagged !== undefined) return undefined;
  await logEvent(ctx, "auto-model-fallback", todoId, {
    ...(todoId !== undefined ? { todoId } : {}),
    from: model,
    to: CODEX_FALLBACK_MODEL,
    reason: fleet.codexWeeklyCapped
      ? `codex weekly usage at or past ${CODEX_WEEKLY_CAP_PERCENT}%`
      : "a recent autonomous codex session ended on a usage limit",
  });
  return CODEX_FALLBACK_MODEL;
}

// The prospecting lane's whole body, called with whatever per-tick budget the
// work walk left unspent. Returns the repo it prospected, or undefined when it
// declined. It creates AT MOST ONE mission per tick: a second one would read a
// tree the first has not finished reading.
async function admitProspectMission(
  ctx: MutationCtx,
  now: number,
  liveSessions: Doc<"claudeSessions">[],
  fleet: FleetModelContext,
): Promise<string | undefined> {
  // At most PROSPECT_MAX_LIVE prospectors alive at once. A worker
  // with NO todoId and NO code subject is what a prospecting mission looks
  // like — a mission for real work always carries the todo it works, and a
  // code mission the code todo, so this needs no extra field to key off.
  // (liveSessions is this tick's snapshot, taken before any creation; since
  // this lane creates one mission per tick at most, nothing it made can be
  // missing from the count it just used.)
  const liveProspectors = liveSessions.filter(
    (s) =>
      s.mode === "autonomous" &&
      s.todoId === undefined &&
      s.codeRepo === undefined,
  ).length;
  if (liveProspectors >= PROSPECT_MAX_LIVE) return undefined;

  // The cooldown and the fairness order both come from this lane's own event
  // trail. Read NEWEST-first inside a lookback window and bounded: truncation
  // drops the OLDEST rows, so a repo's cooldown-relevant event is always in
  // the scan and the bound can only cost fairness, never the cooldown.
  const recentEvents = await ctx.db
    .query("dtsEvents")
    .withIndex("by_at", (q) => q.gte("at", now - PROSPECT_LOOKBACK_MS))
    .order("desc")
    .take(PROSPECT_EVENT_SCAN);
  // ...unless the scan filled up INSIDE the cooldown window, where it cannot
  // prove any repo is out of cooldown. Decline the tick rather than guess — a
  // wrongly-skipped tick costs five minutes, and a wrongly-admitted one costs a
  // whole session re-reading a tree it just read. With a 30-minute window this
  // branch needs PROSPECT_EVENT_SCAN events inside half an hour, which the
  // system does not produce in ordinary use.
  const oldestScanned = recentEvents[recentEvents.length - 1]?.at;
  if (
    recentEvents.length >= PROSPECT_EVENT_SCAN &&
    oldestScanned !== undefined &&
    oldestScanned > now - PROSPECT_COOLDOWN_MS
  ) {
    return undefined;
  }

  // Rows are newest-first, so the first sighting of a repo IS its last
  // prospecting.
  const lastByRepo = new Map<string, number>();
  for (const e of recentEvents) {
    if (e.kind !== "prospect-mission-created") continue;
    const eventRepo = (e.data as { repo?: unknown } | undefined)?.repo;
    if (typeof eventRepo !== "string") continue;
    if (!lastByRepo.has(eventRepo)) lastByRepo.set(eventRepo, e.at);
  }

  // The eligible repo whose last prospecting is OLDEST wins; a repo never
  // prospected is older than any timestamp, and a tie keeps PROSPECT_REPOS
  // order (the comparison is strict <).
  let repo: string | undefined;
  let repoLastAt = Infinity;
  for (const candidate of PROSPECT_REPOS) {
    const lastAt = lastByRepo.get(candidate) ?? -Infinity;
    if (now - lastAt < PROSPECT_COOLDOWN_MS) continue;
    if (lastAt < repoLastAt) {
      repo = candidate;
      repoLastAt = lastAt;
    }
  }
  if (repo === undefined) return undefined;

  // Same model rule as the work walk — a prospector is an ordinary autonomous
  // session and runs on the fleet default, falling back off Codex when the
  // door is shut. It carries no todo, so the tag argument is absent, the
  // "wait" answer cannot come back, and the fallback event names no todoId.
  const model = await resolveFleetModel(ctx, fleet);

  const sessionId = await insertSession(
    ctx,
    {
      title: `prospect: ${repo}`,
      // "adhoc" because this mission works no todo — which is also the fact the
      // one-at-a-time check above reads (todoId stays unset).
      kind: "adhoc",
      // Exactly one repo, on purpose: a prospecting mission reads ONE tree and
      // the cooldown/fairness walk below is per-repo.
      repos: resolveSessionRepos({ explicit: [repo] }),
      mode: "autonomous",
      model,
      prompt: (id) => buildProspectMissionPrompt(repo!, id),
      // The prospect prompt builds its own capture + outcome pens inline.
      outcomePen: false,
    },
    now,
  );
  // The cooldown clock, started at CREATION rather than at the outcome: an
  // errored prospector has already written this row, so the 30 minutes above is
  // the entire wait for a failed run and this lane needs no second mechanism.
  await logEvent(ctx, "prospect-mission-created", undefined, {
    sessionId,
    repo,
  });
  return repo;
}

// ── Autonomous-session scheduler (P3, cron every 5 min) ──────────────────────
// Walks Tom's committed and pending work and admits up to a handful of
// autonomous groundwork sessions when — and only when — the Jarvis Box has headroom.
// Load-based admission is the PRIMARY throttle (Tom's ruling: no scalar cap as
// primary); a heavy session with many subagents raises loadavg and blocks new
// admissions naturally. maxLiveAutonomous is a runaway failsafe only,
// maxNewPerTick a clone-burst bound.

const AUTO_BLOCK_HORIZON_MS = 48 * 60 * 60 * 1000;
const AUTO_BACKOFF_MS = 24 * 60 * 60 * 1000;
const AUTO_CIRCUIT_WINDOW_MS = 3 * 60 * 60 * 1000;
// How long a GOAL rests between checks. A goal is not work — it is a question
// put to the world ("is the lease signed yet?"), and the honest answer to it
// changes only as the world moves. So a checked-and-unmet goal waits a
// day and is asked again, rather than being retired by the completed-backoff
// (which reads "the session finished, and the row did not change" as "settled"
// — true of a task, and the opposite of true of a goal).
const AUTO_GOAL_RECHECK_MS = 24 * 60 * 60 * 1000;
// How many workers one todo may ever consume. The completed-run
// rule below re-admits a todo whenever a session actually advanced its row, so
// a task that genuinely takes four sessions gets four. This is the far bound on
// the other case: a task that keeps recording progress and never finishes would
// otherwise draw sessions forever. Past it the row still stands, still renders
// ready on /tts, and is Tom's to move.
const AUTO_MAX_SESSIONS_PER_TODO = 8;
// Usage-pressure fingerprints in an ending's own words — daemon endedReason
// or agent outcomeSummary — are USAGE_LIMIT_RE (shared/session-constants.mjs),
// the same regex the daemon records a cap with; its comment says why it is
// narrow. The daemon routes SDK error text into outcomeSummary on any abnormal
// autonomous turn end ("autonomous turn failed: …"), which is what makes this
// breaker live: the usage-limit wording actually reaches the fields tested
// below.
//
// PER FAMILY since 2026-09-04. The regex's later alternatives are Codex's
// wordings — the Codex CLI reports a cap as usage_limit_reached /
// rate_limit_reached rather than in Claude's prose — and the breaker asks
// WHICH family a tripped ending belonged to (modelFamily of its row's model).
// Claude tripping still stands the whole tick down (nothing else can run a
// Claude session); Codex tripping only closes the Codex door, exactly like the
// weekly gate.

// "This session RAN as an autonomous one" — the question every history read
// below is actually asking. `mode` alone answers it wrongly for a reopened
// session: reopenSession flips mode to "interactive" so the daemon drops the
// auto-end path, which would silently drop the run out of the backoff walk and
// out of the usage breaker's window. reopenedFromAutonomous is the provenance
// that survives the flip.
function wasAutonomous(s: Doc<"claudeSessions">): boolean {
  return s.mode === "autonomous" || s.reopenedFromAutonomous === true;
}

export const internalAutoSchedule = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // (a) Off unless deliberately enabled — no config row means disabled.
    // The row decides ONE thing (and names the fleet's model); the admission
    // numbers come from the code (AUTO_DEFAULTS) unless the row still carries
    // values written before they became code-owned, which the next press of
    // the switch overwrites. At NARROW the columns go and this is just the
    // constants.
    const row = await ctx.db.query("claudeAutoConfig").first();
    const config = { ...AUTO_DEFAULTS, ...(row ?? {}) };
    if (!config.enabled) return;

    // (b) A stale daemon cannot start sessions — admission needs a live box.
    const health = await ctx.db.query("claudeDaemonHealth").first();
    if (!health || now - health.lastSeenAt > DAEMON_STALE_MS) return;

    // (c) LOAD-BASED ADMISSION — the primary throttle: no load report, high
    // per-cpu load, or low free memory all mean no new admissions this tick.
    const load = health.load;
    if (
      !load ||
      load.cpus <= 0 ||
      load.loadavg1 / load.cpus > config.maxLoadPerCpu ||
      load.freeMemMb < config.minFreeMemMb
    ) {
      return;
    }

    // (d) Runaway failsafe: live autonomous count under the hard cap.
    const liveSessions: Doc<"claudeSessions">[] = [];
    for (const status of LIVE_STATUSES) {
      liveSessions.push(
        ...(await ctx.db
          .query("claudeSessions")
          .withIndex("by_status", (q) => q.eq("status", status))
          .collect()), // bounded: live sessions are few by design
      );
    }
    // The orchestrator's runs and the workers it spawned are hosted runs with
    // a limit of their own (convex/orchestrator.ts); they are not this
    // scheduler's sessions and take none of its places, though a todo one of
    // them holds is still excluded below.
    const ownSessions: Doc<"claudeSessions">[] = [];
    for (const s of liveSessions) {
      if ((await hostedFacts(ctx, s)) === undefined) ownSessions.push(s);
    }
    const liveAutonomous = ownSessions.filter(
      (s) => s.mode === "autonomous",
    ).length;
    if (liveAutonomous >= config.maxLiveAutonomous) return;

    // (e) Usage circuit breaker, PER FAMILY: an autonomous ending in the last
    // 3h that names usage pressure closes the door for the family THAT session
    // ran on — the two accounts are separate, and a capped Codex account says
    // nothing about the Claude one.
    const recentTerminal: Doc<"claudeSessions">[] = [];
    for (const status of ["ended", "failed"] as const) {
      recentTerminal.push(
        ...(await ctx.db
          .query("claudeSessions")
          .withIndex("by_status", (q) =>
            q.eq("status", status).gte("statusChangedAt", now - AUTO_CIRCUIT_WINDOW_MS),
          )
          .collect()),
      );
    }
    const trippedFamilies = new Set<string>();
    for (const s of recentTerminal) {
      if (!wasAutonomous(s)) continue;
      if (
        USAGE_LIMIT_RE.test(s.endedReason ?? "") ||
        USAGE_LIMIT_RE.test(s.outcomeSummary ?? "")
      ) {
        trippedFamilies.add(modelFamily(s.model));
      }
    }
    // Claude capped = nothing runs: it is the fallback every Codex candidate
    // lands on, so admitting anything at all would just re-hit the same wall.
    if (trippedFamilies.has("claude")) return;
    const codexTripped = trippedFamilies.has("codex");

    // (f) The Codex WEEKLY gate (Tom, 2026-09-04). Read off the daemon's
    // heartbeat; absent usage is UNKNOWN and unknown ADMITS, so a daemon that
    // cannot read the CLI never silently freezes the fleet. The five-hour
    // window is deliberately not gated — it refills on its own.
    //
    // A reading also EXPIRES. The daemon keeps resending its last successful
    // reading, with that reading's original readAt, when a later read fails —
    // so an old readAt is exactly the case "nobody has been able to ask Codex
    // for a while", and it reads as UNKNOWN too. Without this, one 90% reading
    // taken before the CLI broke would hold the Codex door shut for as long as
    // the daemon stayed up.
    const codexUsage = health.codexUsage;
    const codexWeeklyCapped =
      codexUsage !== undefined &&
      now - codexUsage.readAt <= CODEX_USAGE_STALE_MS &&
      codexUsage.weeklyUsedPercent >= CODEX_WEEKLY_CAP_PERCENT;
    // Either signal shuts the same door, and the two behave identically: a
    // candidate that ASKED for Codex waits (its tag is a judgment, not a
    // preference), while one that only inherited the fleet default falls back.
    const codexClosed = codexTripped || codexWeeklyCapped;
    // Everything resolveFleetModel needs, decided once for the whole tick and
    // handed to both lanes — the work walk below and the prospecting lane.
    const fleet: FleetModelContext = {
      defaultModel: config.defaultModel,
      codexClosed,
      codexWeeklyCapped,
    };

    const capacity = Math.min(
      config.maxNewPerTick,
      config.maxLiveAutonomous - liveAutonomous,
    );
    if (capacity <= 0) return;

    // ── The work walk ────────────────────────────────────────────────────────
    // The GROUNDWORK lanes below, over every active todo. The frontier walk
    // that used to come first — ready todos inside active batches, each handed
    // to a worker mission — went with batches (Tom's ruling of 2026-09-24: "I
    // dont want to have batches at all anymore because I want to remove
    // structure to allow agents to freely move toward completing all todos in
    // the best way they (or the orchistrator) see fit."). Which todo an agent
    // completes next is the orchestrator's to choose, not a lane's.
    //
    // ONE collect feeds everything below: todoById (a block's subject may be a
    // row the active filter drops) and the lanes — which read only ACTIVE rows,
    // filtered once here instead of once per lane.
    const todos = await ctx.db.query("dtsTodos").collect();
    const todoById = new Map<Id<"dtsTodos">, Doc<"dtsTodos">>(
      todos.map((t) => [t._id, t]),
    );
    // Active AND awake: an active row whose wakeAt is ahead is the lifeos
    // spelling of "waiting" (ttsShared.wakeAtPassed), and the lanes below
    // never handed a waiting row to a worker.
    const active = todos.filter((t) => t.status === "active" && wakeAtPassed(t, now));
    // Tom's live rulings, for the code lane. One collect of an append-only
    // table written at human pace (the /tts page collects it wholesale on
    // every load).
    const liveBySubject = liveRulings(await ctx.db.query("dtsRulings").collect());
    // Two readiness values (ruling 18), read through the one home.
    const unprepared = (t: Doc<"dtsTodos">): boolean => !isPrepared(t.readiness);

    // ── Per-candidate exclusions (cheapest first) ────────────────────────────
    const computeExcluded = async (t: Doc<"dtsTodos">): Promise<boolean> => {
      // Code todos live in the mirror; their work happens in the repo.
      if (t.category === "code") return true;
      // An existing live session already references this todo — checked
      // against the liveSessions array the failsafe (d) already collected,
      // not a per-candidate by_todo query.
      if (liveSessions.some((s) => s.todoId === t._id)) return true;
      // A live (unapplied) ruling means Tom already spoke — do not race it;
      // a live "session" verdict must not be silently consumed by a
      // worker (a real conversation was asked for).
      const rulings = await ctx.db
        .query("dtsRulings")
        .withIndex("by_todo", (q) => q.eq("todoId", t._id))
        .collect();
      const live = liveRulings(rulings).get(
        subjectKey({ subjectType: "life", todoId: t._id }),
      );
      if (live && (live.appliedAt === undefined || live.verdict === "session")) {
        return true;
      }
      // Backoff from worker history (do not redo settled work) —
      // the ONE remaining by_todo collect: backoff needs the terminal history
      // the liveSessions array cannot carry.
      const history = await ctx.db
        .query("claudeSessions")
        .withIndex("by_todo", (q) => q.eq("todoId", t._id))
        .collect();
      const auto = history
        .filter(wasAutonomous)
        .sort((a, b) => b.createdAt - a.createdAt);
      const newest = auto[0];
      if (newest) {
        // A recent non-completed run: wait 24h before another try.
        if (
          newest.outcome !== "completed" &&
          now - newest.statusChangedAt < AUTO_BACKOFF_MS
        ) {
          return true;
        }
        // Three straight non-completed runs: wait for the todo to change.
        if (
          auto.length >= 3 &&
          auto.slice(0, 3).every((s) => s.outcome !== "completed") &&
          t.updatedAt <= newest.createdAt
        ) {
          return true;
        }
        // The far bound: no todo draws sessions without end.
        if (auto.length >= AUTO_MAX_SESSIONS_PER_TODO) return true;
        if (newest.outcome === "completed") {
          if (t.kind === "goal") {
            // A GOAL is a question, not work. "The session completed and the
            // row did not change" means the answer was NO — which is exactly
            // the case that has to be asked again once the world has moved.
            // Nothing bumps a goal's updatedAt when the world changes, so the
            // row-changed test below would retire every goal after its first
            // check.
            if (now - newest.statusChangedAt < AUTO_GOAL_RECHECK_MS) return true;
          } else if (t.updatedAt <= newest.createdAt) {
            // Last run completed and wrote NOTHING to the row: settled, do not
            // redo it. Measured against the session's START, not its end:
            // statusChangedAt is stamped when the session ends, AFTER every pen
            // write it made, so an end-stamp test excludes precisely the
            // sessions that did record progress — and the contract asks a
            // worker for ONE STABLE STATE that "another session can pick up
            // from cold". A row that moved during the session earns that
            // second session; a row that did not, does not.
            return true;
          }
        }
      }
      return false;
    };
    // Memoized: the category-block lane probes candidates through excluded()
    // too, so a todo must not pay the ruling/history reads twice per tick.
    const exclusionByTodo = new Map<string, boolean>();
    const excluded = async (t: Doc<"dtsTodos">): Promise<boolean> => {
      const cached = exclusionByTodo.get(t._id);
      if (cached !== undefined) return cached;
      const verdict = await computeExcluded(t);
      exclusionByTodo.set(t._id, verdict);
      return verdict;
    };

    // Candidates in walk order; lane + blockCategory ride along for the
    // created session's kind and the scheduler event's counts.
    type Candidate = {
      todo: Doc<"dtsTodos">;
      lane: "block" | "dated" | "whenever";
      blockCategory?: string;
    };
    const candidates: Candidate[] = [];

    // (1) Block prep: committed time starting within 48h whose subject is not
    // ready — the nearest commitments get groundwork first.
    const blocks = await ctx.db
      .query("dtsBlocks")
      .withIndex("by_start", (q) =>
        q.gte("start", now).lt("start", now + AUTO_BLOCK_HORIZON_MS),
      )
      .collect();
    for (const block of blocks) {
      if (block.todoId !== undefined) {
        // todoById, not `active` — but the sleep test `active` already applied
        // has to be asked here too: a row whose wakeAt is still ahead is
        // asleep, and a block on it does not wake it (no lane hands out a
        // sleeping row).
        const t = todoById.get(block.todoId);
        if (!t || t.status !== "active" || !wakeAtPassed(t, now)) continue;
        // Not ready: not yet prepared.
        if (unprepared(t)) candidates.push({ todo: t, lane: "block" });
      } else if (block.category !== undefined && block.category !== "code") {
        // Category block: the stalest NON-excluded unprepared todo in the
        // category — probed through excluded() (memoized, so the admission
        // loop re-check is free). The old pick-one-then-test admitted nothing
        // whenever the single stalest pick happened to be excluded.
        const inCategory = active
          .filter((t) => t.category === block.category && unprepared(t))
          .sort((a, b) => a.updatedAt - b.updatedAt);
        for (const t of inCategory) {
          if (await excluded(t)) continue;
          candidates.push({
            todo: t,
            lane: "block",
            blockCategory: block.category,
          });
          break;
        }
      }
    }

    // (2) Dated actives still unprepared, soonest due first. Ordering comes
    // from needs and dates, never a rating (Tom's ruling 2026-08-29).
    const dated = active.filter(
      (t) => t.timingClass === "dated" && unprepared(t),
    );
    dated.sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
    for (const t of dated) candidates.push({ todo: t, lane: "dated" });

    // (3) Whenever actives, stalest first. The condition-bound lane that used
    // to sit here is gone with the value it read (the lifeos update, phase 7):
    // a row that was condition-bound is now a task carrying its condition in
    // its statement, asleep until its wake time, and it reaches a worker
    // through this lane once it wakes.
    const whenever = active.filter(
      (t) => t.timingClass === "whenever" && unprepared(t),
    );
    whenever.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const t of whenever) candidates.push({ todo: t, lane: "whenever" });

    // ── Admit up to `capacity` picks ─────────────────────────────────────────
    const picked = new Set<string>();
    const counts: Record<string, number> = {};
    const admit = async (c: Candidate): Promise<void> => {
      // ── Which model does this session run on? ────────────────────────────
      // resolveFleetModel is the one home for the rule (the prospecting lane
      // asks it the same question). Resolved BEFORE picked.add, because the
      // Codex door being shut can send a Codex-TAGGED candidate back to the
      // queue — `undefined` — rather than into a session.
      const model = await resolveFleetModel(ctx, fleet, c.todo.model, c.todo._id);
      if (model === undefined) return;
      picked.add(c.todo._id);
      counts[c.lane] = (counts[c.lane] ?? 0) + 1;

      // Which repos this mission checks out — resolveSessionRepos is the one
      // answer; a groundwork mission names none, so it is the word guess.
      const repos = resolveSessionRepos({ todo: c.todo });

      // The prompt is built BEFORE the insert (as a builder closed over
      // everything but the session id, which does not exist yet).
      const prompt = (sessionId: Id<"claudeSessions">) =>
        buildAutoMissionPrompt(c.todo, sessionId, repos);

      const sessionId = await insertSession(
        ctx,
        {
          title: "auto: " + c.todo.statement.slice(0, 60),
          // Category-block picks work a category ("block"); everything else
          // targets the one todo ("focus-item").
          kind: c.blockCategory !== undefined ? "block" : "focus-item",
          blockCategory: c.blockCategory,
          todoId: c.todo._id,
          repos,
          mode: "autonomous",
          // Resolved above: the todo's tag, else the fleet default, else the
          // Codex fallback when the weekly cap or the breaker shut that door.
          model,
          prompt,
          // Both autonomous prompts build their own outcome pen inline, with
          // mission-specific wording.
          outcomePen: false,
        },
        now,
      );
      await logEvent(ctx, "auto-session-created", c.todo._id, {
        sessionId,
        todoId: c.todo._id,
      });
    };

    // THE CODE LANE goes first: Tom's approve and archive rulings on code
    // todos are work he ratified by hand, and any lane placed after the walk
    // can be starved by it — a long groundwork backlog fills every slot of
    // every tick. It takes at most one slot (CODE_MISSIONS_PER_TICK).
    const codeAdmitted = await admitCodeMissions(
      ctx,
      now,
      liveSessions,
      fleet,
      liveBySubject,
      capacity,
    );
    if (codeAdmitted > 0) counts.code = codeAdmitted;
    const admittedSoFar = () => picked.size + codeAdmitted;

    for (const c of candidates) {
      if (admittedSoFar() >= capacity) break;
      if (picked.has(c.todo._id)) continue;
      if (await excluded(c.todo)) continue;
      await admit(c);
    }

    // ── The prospecting lane (parallel with the work walk) ───────────────────
    // Real todo work has now taken its share of `capacity`; prospecting spends
    // what is LEFT, on this same tick. The guard is the leftover budget itself,
    // so prospecting can never take a slot the walk above wanted — but an
    // unspent slot goes to prospecting rather than going unused, which is the
    // full-capacity rule. The mission it creates is an ordinary autonomous
    // session: it counts against maxLiveAutonomous on every later tick, and
    // against this tick's budget as the one pick it is.
    if (admittedSoFar() < capacity) {
      await admitProspectMission(ctx, now, ownSessions, fleet);
    }

    // Quiet when idle: the scheduler event only exists when real work was
    // admitted — no-op ticks leave no trace. A prospecting admission does not
    // pass through here: its trace is the "prospect-mission-created" event,
    // which names the session and the repo.
    if (admittedSoFar() > 0) {
      await logEvent(ctx, "auto-session-scheduler", undefined, {
        admitted: admittedSoFar(),
        counts,
        liveAutonomousBefore: liveAutonomous,
      });
    }
  },
});
