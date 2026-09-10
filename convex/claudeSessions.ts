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
import { isIsoDay } from "../worker/jobs/markdown-sections.mjs";
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

// The staleness threshold lives in ttsShared (one home; the worker daemon's
// literal mirror is fenced by scripts/check-session-mirrors.mjs), and so do
// the live-status list this file scans by (LIVE_STATUSES / isLive, formerly
// declared here AND in app/sessions/lib.ts) and
// the graph rules the frontier walk below reads (buildDoneSet / isReady) — the
// page, the planner, and the scheduler must all mean the same thing by
// "ready". The caller-selected model-of-tom layers each opener carries come
// from ttsSkills.modelOfTomPrelude, read once per opener in insertSession below.
import { withoutModelOfTomPrelude } from "./ttsSkills";
import { assembleContext, type ContextSubject } from "./ttsContext";
import {
  AUTONOMOUS_SESSION_CONTRACT,
  CODEX_FALLBACK_MODEL,
  CODEX_USAGE_STALE_MS,
  CODEX_WEEKLY_CAP_PERCENT,
  CODE_TODO_PATH,
  CODE_TODO_REPOS,
  DAEMON_STALE_MS,
  DEFAULT_SESSION_MODEL,
  LIVE_STATUSES,
  MODEL_OF_TOM_HEADER,
  NO_REPO,
  SESSION_MODEL,
  SESSION_REPO_NAMES,
  buildDoneSet,
  goalCheckable,
  isLive,
  isPrepared,
  isReady,
  isSessionRepo,
  modelFamily,
  normalizeSessionRepos,
  tracksCodeTodos,
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

// ── Session event messages (todo tts-session-needs-you-notify) ───────────────
// A Slack line the moment a session needs Tom or records what it did. The
// Slack POST is an ACTION (network), so a mutation cannot await it — it is
// scheduled at runAfter(0) and rides the transaction: if the mutation rolls
// back, the message is never scheduled at all, so Slack never reports a
// transition that did not happen.
//
// EDGE TRIGGERS ONLY. Every call site below sits on a transition that the
// surrounding code makes unrepeatable (a live→terminal status patch, an
// undefined→set outcome). The daemon polls and
// flushes continuously; a level-triggered "is this session blocked" check
// would send one message per flush for the whole time Tom is asleep.
function notifySessionEvent(
  ctx: MutationCtx,
  sessionId: Id<"claudeSessions">,
  text: string,
): Promise<Id<"_scheduled_functions">> {
  return ctx.scheduler.runAfter(
    0,
    internal.ttsSync.internalSessionEventMessage,
    { sessionId, text },
  );
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

// Finalized transcript, seq-ascending, paginated — history rows never change,
// so pages are cache-friendly forever.
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
    const page = await ctx.db
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
  if (!message) return null;
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

// Tom's door: what the sessions page expands a cut row into.
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

// Pending inbound rows double as the optimistic echo of not-yet-delivered
// user turns; the client renders them at the transcript's end.
export const getPendingInbound = query({
  args: { sessionId: v.id("claudeSessions") },
  handler: async (ctx, { sessionId }) => {
    await requireTomId(ctx);
    return await ctx.db
      .query("claudeInbound")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", sessionId).eq("status", "pending"),
      )
      .collect(); // bounded: pending commands are transient and few
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
 *  1. `explicit` — a human (or a caller who genuinely knows) named the set.
 *  2. `batch.repos` — the batch DECLARED its repos at formation. Tom's ruling
 *     2026-08-30: a batch declares, the scheduler does not guess. An explicit
 *     empty array is an answer ("this batch needs no checkout"), which is why
 *     the test is `!== undefined` and not truthiness.
 *  3. The substring scan over the item's own words. The last resort and the
 *     weakest: it is case-sensitive and matches anywhere, so it reads "the
 *     tom.quest dashboard" and "not tom.quest" identically. Kept only because
 *     dropping it would regress every batch-less legacy todo to no checkout at
 *     all; (2) is what makes it stop mattering.
 *
 * (The v1 batch-member vote that used to sit between (2) and (3) — each
 * {repo, externalId} member one tally mark — went with `members` itself: the
 * graph migration turned every v1 batch into a `batches` row, which declares
 * its repos, and that IS rule (2).)
 *
 * Returns the canonical, normalized list — possibly empty, which means the
 * empty-scratch posture (`repo: "none"`).
 */
function resolveSessionRepos(input: {
  explicit?: readonly string[] | string;
  batch?: { repos?: string[] } | null;
  todo?: Doc<"dtsTodos"> | null;
  extraText?: string;
}): string[] {
  if (input.explicit !== undefined) {
    return normalizeSessionRepos(input.explicit);
  }
  if (input.batch?.repos !== undefined) {
    return normalizeSessionRepos(input.batch.repos);
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
      SESSION_REPO_NAMES.filter((repo) => text.includes(repo)),
    );
  }
  return [];
}

type SessionSeed = {
  title: string;
  kind: "gate" | "focus-item" | "weekly" | "adhoc" | "block";
  /** Already through resolveSessionRepos. Empty = the empty-scratch posture. */
  repos: string[];
  todoId?: Id<"dtsTodos">;
  /** The batch this session was opened on, when its subject IS a batch. */
  batchId?: Id<"batches">;
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
  /** Kind "weekly" only (schema: agendaDay, agendaSubjects): the day the
   * Friday job ran for, and the todo and batch ids its agenda's forks name. */
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
async function insertSession(
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
    batchId: seed.batchId,
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
  // Four parts in prompt order, and the order is the point:
  //   prefix     header line 1 + the map + the operate rules + the write layer.
  //              Identical for every run at one WikiTom commit — the cache
  //              boundary, and the transcript's first line, so the row records
  //              what the session began with.
  //   expanded   header line 2 + only what this session's subject picks out of
  //              the know layer. "" when nothing did.
  //   body       the mission the builder wrote, plus the code-session lines and
  //              the outcome pen. The task layer the map promises is last.
  //   fetchable  header line 3 + one line per thing NOT in the prompt, each
  //              naming the command or path that gets it. An index, not
  //              content, and the most volatile part, so it sits after the task.
  //
  // The subject is already in hand: the seed's todo, else its batch, else its
  // first repo, else nothing. `reachesTom` is TRUE for every opener — the
  // outcome, the digest and the transcript all reach him — which is what puts
  // the write layer in the prefix.
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
  // expanded and fetchable parts come from the live record either way.
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
      ? { kind: "todo", todoId: seed.todoId }
      : seed.batchId !== undefined
        ? { kind: "batch", batchId: seed.batchId }
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
    (context.expanded === "" ? "" : "\n\n" + context.expanded) +
    "\n\n" +
    body +
    (codeSessionLines.length > 0 ? "\n\n" + codeSessionLines.join("\n") : "") +
    (seed.outcomePen === false ? "" : outcomePenFooter(sessionId, repos)) +
    "\n\n" +
    context.fetchable;
  // What this opener was given, for the delivery check to read beside what the
  // session then did (schema: contextExpanded / contextBytes). Written on the
  // row inserted above, in the same transaction as the opener it describes.
  await ctx.db.patch(sessionId, {
    contextExpanded: context.manifest,
    contextBytes: context.bytes,
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
  //
  // A session opened ON a batch has no todoId, so the row names the batch in
  // its data and carries it as the key: the weekly gather reads "was this
  // goal evaluated" off by_todo for the goal's own sessions and off
  // by_kind_key for the sessions of its batch (convex/ttsWeekly.ts).
  await logEvent(
    ctx,
    "session-created",
    seed.todoId,
    {
      sessionId,
      title: seed.title,
      kind: seed.kind,
      mode: seed.mode ?? "interactive",
      repos,
      batchId: seed.batchId,
    },
    seed.batchId,
  );
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
 * One page of a session's finalized transcript, seq-ascending — what the
 * daemon reads to write .tts-transcript.md for a fork (forkSessionAs). It is
 * an internalQuery behind the key-authed GET /sessions/transcript route
 * (convex/http.ts): getMessages next to it is Tom-gated and pages newest-first
 * for the browser, and the daemon holds no identity and needs oldest-first.
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
    const page = await ctx.db
      .query("claudeMessages")
      .withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId))
      .order("asc")
      .paginate({ numItems: TRANSCRIPT_PAGE_SIZE, cursor: cursor ?? null });
    return {
      rows: page.page.map((m) => ({
        seq: m.seq,
        turn: m.turn,
        kind: m.kind,
        content: m.content,
        parentToolUseId: m.parentToolUseId,
        // Metadata only, as on the browser's rows: the fork's transcript file
        // renders the cut, and this says what the cut hid and how to ask for
        // it (claudeMessageOverflow under this sessionId + seq).
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
  // A session opened ON a batch names the batch itself (ledger graduation
  // session-repos-need-batch-subject): the resolver reads the batch's
  // declared repos directly instead of hoping to reach it through a todo.
  batchId: v.optional(v.id("batches")),
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
    batchId,
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
    batchId?: Id<"batches">;
    blockCategory?: string;
    model?: SessionModel;
    initialPrompt: string;
    agendaDay?: string;
    agendaSubjects?: string[];
  },
): Promise<Id<"claudeSessions">> {
  if (initialPrompt.trim() === "") throw new Error("initialPrompt is empty");
  // A todo- or batch-scoped session with no repos named inherits the answer
  // from its subject rather than silently landing on an empty scratch
  // workspace — the failure this whole unification exists to stop. The
  // batch is reached directly when the session names one, and through the
  // todo otherwise.
  const todo = todoId !== undefined ? await ctx.db.get(todoId) : null;
  const batch =
    batchId !== undefined
      ? await ctx.db.get(batchId)
      : todo?.batchId !== undefined
        ? await ctx.db.get(todo.batchId)
        : null;
  return await insertSession(
    ctx,
    {
      title,
      kind,
      repos: resolveSessionRepos({
        explicit: repos ?? repo,
        batch,
        todo,
        extraText: batch
          ? `${batch.statement} ${batch.groundUpExplanation ?? ""}`
          : "",
      }),
      todoId,
      batchId,
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
// session has: the day the job ran for, and the todo and batch ids the
// agenda's forks name. A weekly session's turns rule on those ids only
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
function sessionOutcomePen({
  sessionId,
  leadIn,
  summary,
  after,
  planRepair = false,
  fenced = false,
}: {
  sessionId: Id<"claudeSessions">,
  leadIn: string;
  summary: string;
  after?: string;
  planRepair?: boolean;
  fenced?: boolean;
}): string {
  const command =
    `curl -s -X POST "$CONVEX_SITE_URL/tts/session-outcome" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"sessionId": "${sessionId}", "outcome": "completed", "summary": "${summary}"${planRepair ? ', "planRepair": "optional: the edge that was wrong"' : ""}}'`;
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
    // Reopening an autonomous session IS taking it over: Tom is now in the
    // conversation, so the posture becomes interactive. Left as
    // "autonomous", the daemon would re-apply the auto-end path (end the
    // session after the agent's next final turn, under a wall-clock cap) and
    // close the conversation out from under him.
    mode: "interactive",
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
  // todo or batch it was opened on, its kind — because it is the same work
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
      batchId: session.batchId,
      blockCategory: session.blockCategory,
      mode: "interactive",
      model,
      forkedFrom: sessionId,
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
  },
});

// ── Internal: daemon poll (heartbeat + full state pull) ──────────────────────
// One POST /sessions/poll per tick returns everything the daemon needs for
// every non-terminal session — full state each time, no cursors: the payload
// is small (a handful of sessions, pending rows only) and idempotent pulls
// make daemon restarts a non-event (the no-state rule).

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
    // the same throttled heartbeat as `load`.
    codexUsage: v.optional(
      v.object({
        weeklyUsedPercent: v.number(),
        fiveHourUsedPercent: v.number(),
        weeklyResetsAt: v.optional(v.number()),
        readAt: v.number(),
      }),
    ),
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
      });
    }

    const sessions: unknown[] = [];
    for (const status of LIVE_STATUSES) {
      const rows = await ctx.db
        .query("claudeSessions")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect(); // bounded: live sessions are few by design
      for (const s of rows) {
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
        });
      }
    }
    return { now, sessions };
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
      await notifySessionEvent(
        ctx,
        args.sessionId,
        outcomeEventText(session.title, args.outcome, args.outcomeSummary),
      );
      await logEvent(
        ctx,
        "session-outcome",
        session.todoId,
        {
          sessionId: args.sessionId,
          title: session.title,
          outcome: args.outcome,
          summary: args.outcomeSummary,
          batchId: session.batchId,
        },
        session.batchId,
      );
    }

    for (const upd of args.inboundUpdates ?? []) {
      const row = await ctx.db.get(upd.id);
      if (row && row.sessionId === args.sessionId) {
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
      await notifySessionEvent(
        ctx,
        args.sessionId,
        `session "${session.title}" failed — ${
          args.endedReason ?? session.endedReason ?? "no reason reported"
        }`,
      );
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
    // THE WRONG-EDGE CHANNEL (schema v2, 2026-08-29). A worker claims one
    // ready todo and finds, in the doing, that the graph was wrong about it: a
    // `needs` edge that is not a real prerequisite (the task was doable all
    // along), or a prerequisite the graph never named (the task could not
    // start). It writes that sentence here, and the mutation records it as a
    // dtsEvents row of kind "plan-repair". This is the ONLY channel by which
    // doing the work corrects the planning of it — the planner reads these
    // each run (tts.internalRecentPlanRepairs) and fixes the structure. The
    // worker never edits the graph itself: reporting an edge and rewriting one
    // are different authorities.
    planRepair: v.optional(v.string()),
  },
  handler: async (ctx, { id, outcome, summary, planRepair }) => {
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
      await notifySessionEvent(
        ctx,
        normalized,
        outcomeEventText(session.title, outcome, summary),
      );
      // Same edge, same reason, into the events table the hourly update reads.
      await logEvent(
        ctx,
        "session-outcome",
        session.todoId,
        {
          sessionId: normalized,
          title: session.title,
          outcome,
          summary: summary.trim(),
          batchId: session.batchId,
        },
        session.batchId,
      );
    }
    // The plan-repair event, written whenever the worker sent one — including
    // on a re-record, because a second wording of the same ending may be where
    // the wrong edge was finally named. It carries the batch as well as the
    // todo: the planner works one batch at a time and needs to know which
    // graph to look at, and the session row itself names only the todo.
    const repair = planRepair?.trim();
    if (repair) {
      const todo =
        session.todoId !== undefined
          ? await ctx.db.get(session.todoId)
          : null;
      await logEvent(ctx, "plan-repair", session.todoId, {
        sessionId: normalized,
        batchId: todo?.batchId,
        note: repair,
      });
    }
  },
});

// ── Open tool work (the subagent fold's live half) ──────────────────────────
// What is this session's model DOING right now? Derived entirely from the
// finalized tool-call / tool-result rows — the transcript is the only source;
// nothing here is invented state. A Task call with no result is a running
// subagent; a background Bash call is a long-running command whose latest
// BashOutput/KillShell check is its freshest known state.

const PREVIEW_CHARS = 200;
// Evidence texts (launch results, latest checks) carry the FULL content text,
// hard-capped — this query promises verbatim evidence bounded by scroll, not a
// preview.
const EVIDENCE_CHARS = 2000;

// This answers about CURRENT work, so the reads are bounded newest-first
// windows via by_session_kind: a Task or launch older than the window is out
// of scope by construction — the transcript remains the full record.
// This keeps read cost constant for the life of a session.
const TOOL_CALL_WINDOW = 500;
const TOOL_RESULT_WINDOW = 800;

// Tool-call/tool-result content is daemon-written v.any(); read it loosely.
type ToolCallContent = {
  toolName?: string;
  toolUseId?: string;
  input?: unknown;
};
type ToolResultContent = {
  toolUseId?: string;
  content?: unknown;
  isError?: boolean;
};

// Flatten a tool-result content payload (a string, or an array of typed
// blocks) to plain text for previews and id matching. Lockstep with
// app/sessions/lib.ts contentToText (the client's renderer of the same
// daemon-written shapes — the client bundle cannot import this server module).
function contentText(x: unknown): string {
  if (typeof x === "string") return x;
  if (Array.isArray(x)) {
    return x
      .map((b) =>
        typeof (b as { text?: unknown })?.text === "string"
          ? (b as { text: string }).text
          : JSON.stringify(b),
      )
      .join("\n");
  }
  return x === undefined ? "" : JSON.stringify(x);
}

// Lockstep with app/sessions/lib.ts previewLine (the client's one-line
// truncation of the same content).
function previewText(x: unknown): string {
  const s = contentText(x);
  return s.length > PREVIEW_CHARS ? s.slice(0, PREVIEW_CHARS) + "…" : s;
}

// Full-text evidence, capped at EVIDENCE_CHARS — never the 200-char preview.
function evidenceText(x: unknown): string {
  const s = contentText(x);
  return s.length > EVIDENCE_CHARS ? s.slice(0, EVIDENCE_CHARS) + "…" : s;
}

// A background launch's result text names the shell id (bash_N / shell_N);
// checks are matched ONLY by exact equality of that id against the check
// input's id-valued fields — substring containment mismatched bash_1 against
// bash_12.
const SHELL_ID_RE = /\b(bash_\d+|shell_\d+)\b/;

export const getOpenToolWork = query({
  args: { sessionId: v.id("claudeSessions") },
  handler: async (ctx, { sessionId }) => {
    await requireTomId(ctx);
    const session = await ctx.db.get(sessionId);
    // A terminal session has no OPEN work by definition — nothing to say.
    if (!session || !isLive(session.status)) {
      return { agents: [], commands: [], finished: [] };
    }
    // Kind-scoped index reads, bounded newest-first (TOOL_*_WINDOW above),
    // reversed so downstream logic stays seq-ascending ("last wins" = newest).
    const calls = (
      await ctx.db
        .query("claudeMessages")
        .withIndex("by_session_kind", (q) =>
          q.eq("sessionId", sessionId).eq("kind", "tool-call"),
        )
        .order("desc")
        .take(TOOL_CALL_WINDOW)
    ).reverse();
    const results = (
      await ctx.db
        .query("claudeMessages")
        .withIndex("by_session_kind", (q) =>
          q.eq("sessionId", sessionId).eq("kind", "tool-result"),
        )
        .order("desc")
        .take(TOOL_RESULT_WINDOW)
    ).reverse();
    const resultById = new Map<string, Doc<"claudeMessages">>();
    for (const r of results) {
      const id = (r.content as ToolResultContent)?.toolUseId;
      if (typeof id === "string") resultById.set(id, r);
    }
    // Newest tool-call per parent Task (calls are seq-ascending: last wins) —
    // "what is this subagent doing right now".
    const newestChildByParent = new Map<string, Doc<"claudeMessages">>();
    for (const call of calls) {
      if (call.parentToolUseId !== undefined) {
        newestChildByParent.set(call.parentToolUseId, call);
      }
    }

    // ONE name per fact — this is the canonical field list, and the client
    // reads exactly these names (no aliases on either side). The reader is
    // the transcript's subagent fold (app/sessions/components/transcript.tsx):
    // it takes `agents` — the running ones, with their type, description,
    // startedAt and current call — for its summary line, because those are
    // facts about a live subagent that are not rows in the transcript. The
    // agent panel this query was written for is gone (the lifeos update, phase
    // 7); `finished` and `commands` are what it read and the fold does not,
    // and docs/lifeos-retirement.md names them as the two losses.
    type AgentEntry = {
      toolUseId: string;
      subagentType: string;
      description: string;
      startedAt: number;
      running: boolean;
      current?: { toolName: string; inputPreview: string };
    };
    type FinishedAgentEntry = {
      toolUseId: string;
      subagentType: string;
      startedAt: number;
      durationMs: number;
      isError: boolean;
      resultPreview: string;
    };
    type CommandEntry = {
      toolUseId: string;
      command: string;
      startedAt: number;
      launchResultText?: string;
      latestCheck?: { toolName: string; resultText: string; at: number };
    };
    const agents: AgentEntry[] = [];
    const finished: FinishedAgentEntry[] = [];
    const commands: CommandEntry[] = [];

    // Background-command checks: BashOutput/KillShell calls, seq-ascending.
    const checks = calls.filter((call) => {
      const name = (call.content as ToolCallContent)?.toolName;
      return name === "BashOutput" || name === "KillShell";
    });

    for (const call of calls) {
      const c = call.content as ToolCallContent;
      if (typeof c?.toolUseId !== "string") continue;
      const input = (c.input ?? {}) as Record<string, unknown>;
      const result = resultById.get(c.toolUseId);

      if (c.toolName === "Task") {
        if (result === undefined) {
          const entry: AgentEntry = {
            toolUseId: c.toolUseId,
            subagentType:
              typeof input.subagent_type === "string"
                ? input.subagent_type
                : "",
            description:
              typeof input.description === "string" ? input.description : "",
            startedAt: call.createdAt,
            running: true,
          };
          const child = newestChildByParent.get(c.toolUseId);
          if (child) {
            const cc = child.content as ToolCallContent;
            entry.current = {
              toolName: cc?.toolName ?? "",
              inputPreview: previewText(cc?.input),
            };
          }
          agents.push(entry);
        } else {
          finished.push({
            toolUseId: c.toolUseId,
            subagentType:
              typeof input.subagent_type === "string"
                ? input.subagent_type
                : "",
            startedAt: call.createdAt,
            durationMs: result.createdAt - call.createdAt,
            isError: (result.content as ToolResultContent)?.isError === true,
            resultPreview: previewText(
              (result.content as ToolResultContent)?.content,
            ),
          });
        }
      } else if (c.toolName === "Bash" && input.run_in_background === true) {
        const entry: CommandEntry = {
          toolUseId: c.toolUseId,
          command: typeof input.command === "string" ? input.command : "",
          startedAt: call.createdAt,
        };
        if (result !== undefined) {
          // The launch result names the shell id (SHELL_ID_RE); a check
          // belongs to this launch ONLY when one of its id-valued input
          // fields EQUALS that id — substring containment matched bash_1
          // against bash_12. Invent no state: no id in the text, no checks.
          const launchContent = (result.content as ToolResultContent)?.content;
          entry.launchResultText = evidenceText(launchContent);
          const shellId = contentText(launchContent).match(SHELL_ID_RE)?.[1];
          for (const check of checks) {
            if (shellId === undefined) break;
            if (check.createdAt < call.createdAt) continue; // predates launch
            const checkContent = check.content as ToolCallContent;
            const checkInput = (checkContent?.input ?? {}) as Record<
              string,
              unknown
            >;
            const matches = Object.entries(checkInput).some(
              ([key, value]) => /id/i.test(key) && value === shellId,
            );
            if (!matches) continue;
            const checkResult =
              typeof checkContent?.toolUseId === "string"
                ? resultById.get(checkContent.toolUseId)
                : undefined;
            // checks are seq-ascending, so the last match is the newest.
            entry.latestCheck = {
              toolName: checkContent?.toolName ?? "",
              resultText: evidenceText(
                (checkResult?.content as ToolResultContent)?.content,
              ),
              at: checkResult?.createdAt ?? check.createdAt,
            };
          }
        }
        commands.push(entry);
      }
    }

    // History caps: newest 10 finished agents and newest 10 launches, newest
    // last (both lists are call-order; end order matches closely enough for a
    // tail).
    return {
      agents,
      commands: commands.slice(-10),
      finished: finished.slice(-10),
    };
  },
});

// ── Autonomous-fleet config (P3) ─────────────────────────────────────────────

// THE FOUR ADMISSION NUMBERS LIVE HERE, IN CODE (the lifeos update, phase 7).
// They describe how hard the Jarvis Box may be pushed — the load and memory
// ceilings admission is judged against, and the two runaway failsafes — and
// they were set once and never touched again. A number nobody changes is not a
// decision; it is mechanism, and mechanism belongs in code rather than in a
// row Tom has to hold in his head to read the sessions page. So NO DOOR WRITES
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
// app/sessions/components/session-list.tsx. The stored default model is
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
// with pickMissionRepo — a case-sensitive substring search over the todo's and
// batch's words that could only ever return ONE repo. It is gone: batches
// declare their repos (Tom, 2026-08-30), and the substring scan survives only
// as the resolver's last fallback for batch-less legacy rows.

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
// The box's two read-only commands, named in every autonomous mission prompt.
// An installed command no prompt names is not access: tts-browse sat on the
// box unmentioned while sessions that changed a page still ended by asking
// Tom to go and look (found 2026-08-30, salvaged from unmerged commit
// 703f526 when #33 superseded that branch).
const BOX_TOOLS_PARAGRAPH = [
  "Two read-only commands exist on this box:",
  "- `tts-browse <url> [--login] [--out /tmp/page.png]` opens a real browser on a page and prints its console errors and failed requests, then writes a screenshot you can read back. `--login` signs in with the agent account — every /turing and /tts page is role-gated, so an anonymous 200 can hide 401s underneath. LOOK at any page you changed instead of asking Tom to.",
  "- `tts-turing health|gpus|jobs|output <name>` reads the WPI Turing cluster through the API's read-only key. It cannot allocate, cancel, run, or read files — those need Tom. A verb answering 401 means the read key is not installed yet; record that in your outcome instead of retrying.",
].join("\n");

// The daemon that runs THIS session runs every other live session on the box
// too, so an agent that restarts it to pick up its own change kills itself
// mid-turn and takes the rest of the fleet with it. Named in every prompt
// shape — checkout or empty scratch, autonomous or interactive — because the
// one shape that goes unsaid is the one that does it.
const DAEMON_RESTART_SENTENCE =
  "Never restart, stop, or kill `tts-session-host` — it is the daemon running this session and every other live session on this box; if a change needs a restart, say so in your outcome and the supervisor restarts it.";

function workspaceParagraph(
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
    promptFact("brief", todo.brief),
  ];
  const lines: (string | null)[] = [
    AUTONOMOUS_SESSION_CONTRACT,
    "",
    `The goal: do the groundwork this item needs — research, draft, gather — and write what you produce into the item via the prepare pen below. Set readiness to "prepared" when the write-up is complete — and only then; a prepared item that is active, awake and unblocked is what TTS shows Tom as ready.`,
    "",
    // Ratified doctrine (Tom, 2026-08-29): his input gates PERSISTENCE, never
    // implementation — a session that halts at a decision leaves him nothing
    // concrete to rule on.
    `Tom decisions: a decision of Tom's does NOT block you. Implement your best-judgment option and name the alternatives you passed over in the write-up; the decision then surfaces where the work persists — the pull request, or the ruling on this item. Leave for Tom only what ONLY he can do: rulings, merges, and real-world actions.`,
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
          `Prohibitions: never record a ruling and never change a status — verdicts and status changes are Tom's pens alone. NEVER merge, and never push any branch other than session/${sessionId} — merging is Tom's gate.`,
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

// ── The worker mission (schema v2, ratified 2026-08-29) ──────────────────────
// The successor to buildAutoMissionPrompt for every todo that lives inside a
// BATCH. The old builder stays for the rows that have no batch — one prompt
// cannot honestly serve both (a groundwork mission writes up a whole item; a
// worker advances ONE node of a graph).
//
// THE CONTRACT THIS PROMPT WRITES DOWN: the session claimed exactly one READY
// todo — every id in its `needs` is done — and advances it by ONE STABLE
// STATE. A stable state is one another session can pick up from cold: the task
// recorded done with its evidence, or the task prepared to the point where the
// only thing left is Tom's judgment. Half a task with nothing written down is
// not a state; it is work that has to be done again.

/** One neighbour of the claimed todo, resolved by the scheduler. */
type GraphNeighbor = {
  statement: string;
  status: string;
  kind: "task" | "goal";
  // Who does it. Carried because a neighbour that is Tom's is waiting on HIM,
  // which is a different fact from a neighbour another session may be holding.
  actor?: "tom" | "agent";
  evidence?: string;
};

function buildWorkerPrompt(args: {
  todo: Doc<"dtsTodos">;
  batch: Doc<"batches">;
  sessionId: Id<"claudeSessions">;
  repos: string[];
  needs: GraphNeighbor[];
  dependents: GraphNeighbor[];
  siblings: GraphNeighbor[];
  /** The statements of the batches this batch needs (all done by the time a
   * worker is here — the scheduler admits no batch with an open need). */
  batchNeeds?: string[];
  /** Tom's must-not-break lines on this batch's goals, each with the goal it
   * is on. Binding on every step toward those goals — so on this one. */
  mustNotBreak?: { goal: string; line: string }[];
}): string {
  const {
    todo,
    batch,
    sessionId,
    repos,
    needs,
    dependents,
    siblings,
    batchNeeds = [],
    mustNotBreak = [],
  } = args;
  const isGoal = todo.kind === "goal";
  const neighborLine = (n: GraphNeighbor) =>
    `- [${n.kind}, ${n.status}${
      n.kind === "task" ? `, ${n.actor ?? "agent"}` : ""
    }] "${n.statement}"${n.evidence ? ` (evidence: ${n.evidence})` : ""}`;
  const batchContext: (string | null)[] = [
    `THE BATCH ("${batch.statement}"):`,
    promptFact("ground-up explanation", batch.groundUpExplanation),
    batchNeeds.length > 0
      ? `this batch needs (every one of them done — that is why its work is open): ${batchNeeds
          .map((n) => `"${n}"`)
          .join(", ")}`
      : null,
    ...(mustNotBreak.length > 0
      ? [
          "",
          "MUST NOT BREAK — Tom's own lines on this batch's goals. They bind every step toward those goals, so they bind this one; a change that would break one is not a change to make, whatever else the task says:",
          ...mustNotBreak.map((m) => `- on the goal "${m.goal}": ${m.line}`),
        ]
      : []),
  ];
  const todoContext: (string | null)[] = [
    `YOU HAVE CLAIMED ONE TODO IN THIS BATCH, and only this one ("${todo.statement}"):`,
    `kind: ${isGoal ? "goal" : "task"}`,
    isGoal ? null : `who does it: ${todo.actor ?? "agent"}`,
    promptFact("condition", todo.condition),
    promptFact("must not break (Tom's own line, binding)", todo.mustNotBreak),
    promptFact("ground-up explanation", todo.groundUpExplanation),
    promptFact("work description", todo.workDescription),
    promptFact("entry action", todo.entryAction),
    promptFact("evidence recorded so far", todo.evidence),
    promptFact("body", todo.body),
    promptFact(
      "code subject",
      todo.codeRepo !== undefined && todo.codeExternalId !== undefined
        ? `${todo.codeRepo} ${todo.codeExternalId}`
        : undefined,
    ),
    "",
    needs.length > 0
      ? `ITS NEEDS (${needs.length}, every one of them done — that is why this todo is ready):`
      : "ITS NEEDS: none. It was ready from the moment the batch was formed.",
    ...needs.map(neighborLine),
    "",
    dependents.length > 0
      ? `WHAT NEEDS IT (${dependents.length} — these become ready the moment yours is done):`
      : "WHAT NEEDS IT: nothing in this batch waits on it.",
    ...dependents.map(neighborLine),
    "",
    siblings.length > 0
      ? `ALSO READY IN THIS BATCH RIGHT NOW (${siblings.length}). Do NOT work them: another session may be holding any of them, and the ones marked "tom" are waiting on him. They are here so you know what is moving beside you:`
      : "NOTHING ELSE IS READY IN THIS BATCH right now.",
    ...siblings.map(neighborLine),
  ];
  const lines: (string | null)[] = [
    AUTONOMOUS_SESSION_CONTRACT,
    "",
    "Everything you write into TTS obeys the writing standard in the model-of-tom files this prompt begins with, verbatim.",
    "",
    BOX_TOOLS_PARAGRAPH,
    "",
  ];

  lines.push(
    "",
    "THE CONTRACT: advance your one todo by ONE STABLE STATE, then stop. A stable state is one another session can pick up from cold — the work recorded done with the artifact that shows it, or the question prepared to the point where only Tom's answer is missing. Half a task with nothing written down is not a state; it is work someone has to do again.",
    "",
    ...(isGoal
      ? [
          "Your todo is a GOAL, so the work is CHECKING, not building. The condition above is a statement about the world that is either true yet or not. Find out which — in the repository, in the system, in whatever the condition is about. If it holds, record the goal done with evidence naming exactly what you checked and what you saw. If it does not hold, change nothing and say in your outcome summary what is still missing; a goal that is not met yet is an honest, complete session, and the fleet asks the same question again a day later.",
        ]
      : [
          'Your todo is a TASK. There are two ways it ends, and which one it is becomes clear as you work:',
          "",
          "1. THE WORK IS YOURS TO DO. Do it, then record the task done with its evidence — the branch, the pull request, the file you wrote, the answer you established. Evidence is what makes the completion checkable by someone who was not here.",
          "",
          "2. THE WORK TURNS OUT TO NEED TOM'S JUDGMENT. Do not stop at the question. Prepare it, then set readiness to prepared and leave the task open. His input gates what PERSISTS — a merge, a ruling, a real-world action — never what you implement: where you can implement your best-judgment option and name what you passed over, do that instead of asking.",
        ]),
    "",
    // The wrong-edge report. Doing the work is the only thing that can correct
    // the planning of it, and a worker that silently works around a bad edge
    // leaves the next worker to discover it again.
    "IF THE GRAPH WAS WRONG, SAY SO. You may find that a need above was not a real prerequisite (your todo was doable all along), or that something the graph never named actually blocked you. Report it with the planRepair field of the outcome pen, in one sentence naming the edge. Do not edit the graph yourself — the planner owns its structure, and reporting an edge and rewriting one are different authorities.",
    "",
    "The pens (shell commands; CONVEX_SITE_URL and TTS_WORKER_KEY are already set in this session's environment):",
    "",
    "1. Record your todo DONE, with the evidence that shows it:",
    "```",
    `curl -s -X POST "$CONVEX_SITE_URL/tts/prepare-todo" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"id": "${todo._id}", "status": "done", "evidence": "one line naming the artifact"}'`,
    "```",
    "",
    "2. Or hand it to Tom, when only his judgment is left:",
    "```",
    `curl -s -X POST "$CONVEX_SITE_URL/tts/prepare-todo" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"id": "${todo._id}", "readiness": "prepared", "groundUpExplanation": "...", "entryAction": "the smallest next action", "evidence": "what you produced on the way"}'`,
    "```",
    "Every field except \"id\" is optional — send only what you produced, and send both commands if you both produced something and finished.",
    "",
    sessionOutcomePen({
      sessionId,
      leadIn: "3. Record this session's outcome when you stop:",
      summary: "one line: what moved and where it landed",
      planRepair: true,
      fenced: true,
    }),
    // Four words, two stored values. The store keeps two ("completed" and
    // "errored") because the scheduler's backoff reads exactly that
    // distinction; the four words are what Tom and the planner read, so they
    // lead the summary.
    "There are FOUR outcomes, and the word you choose is the first word of your summary:",
    '- COMPLETED — you advanced the todo one state (recorded it done, or prepared it for Tom). Send outcome "completed".',
    '- DEFERRED — you could not start because a prerequisite really is missing. NAME it in the summary and report it as a planRepair. Send outcome "errored" with a summary starting "deferred: ".',
    '- FAILED — the work was yours and it did not land. Send outcome "errored" with a summary starting "failed: ". This todo then waits a day before the fleet tries it again, so say what would have to be different.',
    '- ABANDONED — the todo should not be done at all any more. Send outcome "errored" with a summary starting "abandoned: " and the reason. You are reporting that judgment, not acting on it: only Tom retires a todo.',
    "",
    ...(repos.length === 0
      ? [
          // Same reason as the legacy builder's no-repo branch above: no
          // workspace paragraph here, so the daemon sentence rides along.
          `Prohibitions: never record a ruling and never change the status of anything but the one todo you claimed — verdicts are Tom's pens alone. Never touch code: this session has an EMPTY scratch directory and no repository, so anything needing code goes to Tom as a prepared task instead. ${DAEMON_RESTART_SENTENCE}`,
        ]
      : [
          workspaceParagraph(
            repos,
            sessionId,
            "Implement the code your todo needs, and name what landed in your evidence.",
          ),
          "",
          `Prohibitions: never record a ruling and never change the status of anything but the one todo you claimed — verdicts are Tom's pens alone. NEVER merge, and never push any branch other than session/${sessionId} — merging is Tom's gate.`,
        ]),
    "",
    "Ending: record the outcome, then simply stop responding — the daemon ends the session after your final turn.",
    "",
    ...batchContext,
    "",
    ...todoContext,
  );
  return lines.filter((l): l is string => l !== null).join("\n");
}

// ── The code mission (the lifeos update, phase 7) ────────────────────────────
// Tom's approve or archive ruling on a CODE todo — an entry in a repo's
// vqc/todos.yaml, briefed on the /tts page — is carried out by an autonomous
// session on that repo's checkout, the way worker/jobs/execute-approved.mjs
// did on its own hourly clone before this: implement the plan (approve) or
// close the entry (archive), run the registry's own guard test, commit, push
// session/<id>, open a pull request. MERGING THE PULL REQUEST IS TOM'S GATE —
// nothing lands on the default branch by itself, which is why the box's
// unified auto mode is acceptable here: the blast radius is one branch.

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
    AUTONOMOUS_SESSION_CONTRACT,
    "",
    workspaceParagraph(
      [repo],
      sessionId,
      `${verdict === "approve" ? "Implement the plan, then close the entry." : "Close the entry."} Run \`${guard ?? "the repository's own guard test for that file"}\` and the tests nearest your change, and fix what you break — a pull request never carries a malformed registry.`,
    ),
    "",
    `Open the pull request in every case that produced commits: it is how the work reaches Tom, and merging it is his gate. Its body STARTS with the line "CHANGE REPORT:" and ends with the line "Merging this pull request is the persist-tom-gate for ${repo} ${externalId}."`,
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
    `Prohibitions: never record a ruling and never change the status of any TTS todo — verdicts are Tom's pens alone. NEVER merge, and never push any branch other than ${branch} — merging is Tom's gate.`,
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
    if (!isSessionRepo(repo) || !tracksCodeTodos(repo)) {
      await refuse(`no session can check out ${repo}`);
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
// to make more to-dos." A PROSPECTING MISSION is an autonomous session that
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
    AUTONOMOUS_SESSION_CONTRACT,
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
  // At most PROSPECT_MAX_LIVE prospectors alive at once. An autonomous session
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
// changes only as the batch's tasks land. So a checked-and-unmet goal waits a
// day and is asked again, rather than being retired by the completed-backoff
// (which reads "the session finished, and the row did not change" as "settled"
// — true of a task, and the opposite of true of a goal).
const AUTO_GOAL_RECHECK_MS = 24 * 60 * 60 * 1000;
// How many autonomous sessions one todo may ever consume. The completed-run
// rule below re-admits a todo whenever a session actually advanced its row, so
// a task that genuinely takes four sessions gets four. This is the far bound on
// the other case: a task that keeps recording progress and never finishes would
// otherwise draw sessions forever. Past it the row still stands, still renders
// ready on /tts, and is Tom's to move.
const AUTO_MAX_SESSIONS_PER_TODO = 8;
// How long a batch rests after Tom rules "session" on it. He asked for a
// conversation, and the fleet must not consume the request by working the
// graph out from under it — but a batch `session` verdict can never be marked
// applied (claudeSessions has no batch subject yet, see ttsRulings), so an
// applied-forever test would freeze every task in the graph permanently. A day
// is the pause: long enough to have the conversation, short enough that
// forgetting to have it costs a day rather than the batch.
const AUTO_BATCH_SESSION_PAUSE_MS = 24 * 60 * 60 * 1000;
// Usage-pressure fingerprints in an ending's own words — daemon endedReason
// or agent outcomeSummary. LOCKSTEP with worker/session-host/session.mjs
// USAGE_LIMIT_RE: both sides carry exactly this regex, narrowed on purpose to
// account usage caps — transient API weather ("rate limit", "overloaded")
// must not stand the fleet down for 3h. "session limit" is here from
// observation: the CLI's live cap text on 2026-08-30 was "You've hit your
// session limit · resets 8:10am (UTC)", which matched neither original
// alternative, so the breaker never tripped and the scheduler burned a dozen
// launches against a wall for an hour. The daemon routes SDK error text into
// outcomeSummary on any abnormal autonomous turn end ("autonomous turn
// failed: …"), which is what makes this breaker live: the usage-limit
// wording actually reaches the fields tested below.
//
// PER FAMILY since 2026-09-04. The alternatives after "session limit" are
// Codex's wordings — the Codex CLI reports a cap as usage_limit_reached /
// rate_limit_reached rather than in Claude's prose — and the breaker now asks
// WHICH family a tripped ending belonged to (modelFamily of its row's model).
// Claude tripping still stands the whole tick down (nothing else can run a
// Claude session); Codex tripping only closes the Codex door, exactly like the
// weekly gate.
// scripts/check-session-mirrors.mjs fails the build when the two homes drift.
const AUTO_USAGE_RE = /usage.?limit|limit reached|session limit|usage_limit_(reached|exceeded)|rate_limit_reached|hit your usage limit/i;

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
    const liveAutonomous = liveSessions.filter(
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
        AUTO_USAGE_RE.test(s.endedReason ?? "") ||
        AUTO_USAGE_RE.test(s.outcomeSummary ?? "")
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
    // TWO WORLDS, IN ONE ORDER. The frontier walk comes first: every todo that
    // lives inside a schema-v2 batch and is READY (each id in its `needs` is
    // done) is a candidate, ordered by where its batch sits on its path. The
    // LEGACY lanes follow, unchanged, for the rows that have no batch — before
    // the migration runs the graph is empty and those lanes are the only thing
    // feeding the fleet, and after it they thin out on their own as the rows
    // they serve are migrated. Nothing had to be deleted to add the frontier.
    //
    // ONE collect feeds everything below: todoById (member/prompt resolution
    // needs terminal rows too), the batch-ownership set, the done set the
    // frontier is computed against, and the lanes — which read only ACTIVE
    // rows, filtered once here instead of once per lane.
    const todos = await ctx.db.query("dtsTodos").collect();
    const todoById = new Map<Id<"dtsTodos">, Doc<"dtsTodos">>(
      todos.map((t) => [t._id, t]),
    );
    // Active AND awake: an active row whose wakeAt is ahead is the lifeos
    // spelling of "waiting" (ttsShared.wakeAtPassed), and the lanes below
    // never handed a waiting row to a worker.
    const active = todos.filter((t) => t.status === "active" && wakeAtPassed(t, now));
    // THE DONE SET AND THE FRONTIER come from ttsShared — the ONE
    // implementation the /tts page also reads, so the fleet and the surface
    // cannot disagree about which todos are ready.
    const doneSet = buildDoneSet(todos);
    // The batches table is human-scale (a few dozen rows for years), like the
    // todo collect above.
    const batchRows = await ctx.db.query("batches").collect();
    const batchById = new Map<Id<"batches">, Doc<"batches">>(
      batchRows.map((b) => [b._id, b]),
    );
    // Tom rules on the BATCH now, so the pending-ruling exclusion has to be
    // asked at that level too — the per-todo version below cannot see a
    // verdict recorded against the batch a task lives in. One collect of an
    // append-only table written at human pace (the /tts page collects it
    // wholesale on every load).
    const liveBySubject = liveRulings(await ctx.db.query("dtsRulings").collect());
    // Two readiness values (ruling 18), read through the one home.
    const unprepared = (t: Doc<"dtsTodos">): boolean => !isPrepared(t.readiness);

    // ── Per-candidate exclusions (cheapest first) ────────────────────────────
    const computeExcluded = async (t: Doc<"dtsTodos">): Promise<boolean> => {
      // Code todos live in the mirror; their work happens in the repo.
      if (t.category === "code") return true;
      // (The v1 batch-member exclusion that used to sit here — a member of a
      // non-terminal batch is owned by the batch — went with `members`: a
      // batch's contents point back at it with batchId now, and the lanes
      // below filter on that.)
      // (A row carrying batchId used to be excluded outright, because nothing
      // here read `needs` and scheduling one directly would have worked a
      // blocked step. The frontier walk below reads `needs`, so the blanket
      // exclusion is gone and the legacy lanes filter on batchId instead.)
      // An existing live session already references this todo — checked
      // against the liveSessions array the failsafe (d) already collected,
      // not a per-candidate by_todo query.
      if (liveSessions.some((s) => s.todoId === t._id)) return true;
      // A live (unapplied) ruling means Tom already spoke — do not race it;
      // a live "session" verdict must not be silently consumed by an
      // autonomous session (a real conversation was asked for).
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
      // Backoff from autonomous session history (do not redo settled work) —
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
            // the case that has to be asked again once the tasks have moved.
            // Nothing bumps a goal's updatedAt (binding deliberately does not,
            // and the planner never rewrites goals), so the row-changed test
            // below would retire every goal after its first check and the
            // batch would never reach done.
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
      lane: "graph" | "block" | "dated" | "whenever";
      blockCategory?: string;
      batch?: Doc<"batches">;
    };
    const candidates: Candidate[] = [];

    // ── (0) THE FRONTIER: ready todos inside active batches ──────────────────
    // A candidate here is READY (isReady: active, and every id in `needs`
    // done) and AGENT-WORKABLE. A task is agent-workable while its actor is
    // not "tom" — an actor-"tom" task is a thing only he can do (a ruling, a
    // merge, a real-world action), and a session that "did" one would be
    // inventing the fact. A goal is workable when its condition is checkable:
    // the mission for a goal is to CHECK the world, which needs something
    // written to check — either the condition sentence or the code subject it
    // binds. A row inside a batch with no `kind` reads as a task (schema).
    const readyByBatch = new Map<string, Doc<"dtsTodos">[]>();
    for (const t of todos) {
      if (t.batchId === undefined) continue;
      if (!isReady(t, doneSet, now)) continue;
      const list = readyByBatch.get(t.batchId) ?? [];
      list.push(t);
      readyByBatch.set(t.batchId, list);
    }
    const agentWorkable = (t: Doc<"dtsTodos">): boolean =>
      t.kind === "goal" ? goalCheckable(t) : t.actor !== "tom";

    // A batch's own needs (the lifeos update): every batch named there must
    // be done or archived before any of this batch's work is handed out —
    // the same rule as between todos, one level up. A batch on a retired
    // path with no needs field keeps the path ORDER below during the widen.
    const batchNeedsMet = (batch: Doc<"batches">): boolean =>
      (batch.needs ?? []).every((id) => {
        const need = batchById.get(id);
        return need !== undefined && need.status !== "active";
      });

    const graphCandidates: Candidate[] = [];
    for (const [batchId, ready] of readyByBatch) {
      const batch = batchById.get(batchId as Id<"batches">);
      // A batch that is done or archived is not work, and a row pointing at a
      // batch that is not there is not something to guess about.
      if (!batch || batch.status !== "active") continue;
      if (!batchNeedsMet(batch)) continue;
      // The batch-level half of the pending-ruling exclusion: an unapplied
      // verdict means Tom has spoken and the fleet must not race him. A
      // "session" verdict asked for a conversation, and it is the one verdict
      // nothing can ever mark applied at the batch level — so it PAUSES the
      // graph for a day rather than freezing it forever (a permanent freeze
      // costs every task in the batch, recoverable only by a second ruling
      // nothing tells him to record).
      const ruling = liveBySubject.get(
        subjectKey({ subjectType: "batch", batchId }),
      );
      if (ruling) {
        const paused =
          ruling.verdict === "session"
            ? now - ruling.ruledAt < AUTO_BATCH_SESSION_PAUSE_MS
            : ruling.appliedAt === undefined;
        if (paused) continue;
      }
      const workable = ready.filter(agentWorkable);
      const tasks = workable.filter((t) => t.kind !== "goal");
      for (const t of tasks) {
        graphCandidates.push({ todo: t, lane: "graph", batch });
      }
      // WORK FIRST, THEN CHECK. A goal has no needs — binding sets batchId and
      // kind and nothing else — so it is ready from the moment it is bound,
      // before a single task of the batch has run. Scheduling it there spends a
      // session asking a question whose answer is certainly "not yet". A goal
      // becomes checkable work only once no task of its batch can be admitted
      // at all: that is when the world has had its chance to change. (Tested
      // through excluded(), not through the ready set: a batch whose every
      // ready task is held by a live session or resting on a backoff has no
      // work moving either, and "nothing ready" alone would never come true
      // for it.)
      let taskMoving = false;
      for (const t of tasks) {
        if (!(await excluded(t))) {
          taskMoving = true;
          break;
        }
      }
      if (taskMoving) continue;
      for (const t of workable) {
        if (t.kind === "goal") {
          graphCandidates.push({ todo: t, lane: "graph", batch });
        }
      }
    }
    // THE ORDER: how soon the work is due, then how long it has sat. The
    // sequencing Tom stated between batches is not a tiebreak here — it is
    // `needs`, and batchNeedsMet above has already refused every candidate
    // whose batch is waiting on another. What reaches this sort is work that
    // may all legitimately proceed, so dates order it (Tom's ruling
    // 2026-08-29: ordering comes from needs and dates, never a rating). The
    // retired `path` sorted here by name, then position, then must-over-helps.
    graphCandidates.sort((a, b) => {
      const dueA = a.todo.dueAt ?? Infinity;
      const dueB = b.todo.dueAt ?? Infinity;
      if (dueA !== dueB) return dueA - dueB;
      return a.todo.updatedAt - b.todo.updatedAt; // stalest first
    });
    candidates.push(...graphCandidates);
    // THE FRONTIER'S QUOTA. Strict priority with no quota starves the legacy
    // lanes outright: once the planner has been running for a day there are
    // routinely more ready graph tasks than a tick has slots, and the walk
    // never reaches them. So the frontier takes at most capacity-1 of the
    // tick's slots whenever the tick has more than one, and the admission loop
    // runs a SECOND pass with no quota — a reserved slot the legacy lanes did
    // not use goes back to the graph rather than being left unspent.
    const graphQuota = capacity <= 1 ? capacity : capacity - 1;

    // ── The GROUNDWORK lanes (rows outside every batch) ──────────────────────
    // Each lane below hands out a todo that lives outside the graph, and each
    // carries one test: the row must have no batchId. A row inside a batch is
    // the frontier's to schedule, and these lanes read readiness, which says
    // nothing about a graph node. (The v1 BATCH lane that used to be lane (2)
    // — an active row carrying `members` with an open agent plan step — went
    // with those two fields: the lifeos update, phase 7.)
    //
    // ONE EXCEPTION, and it is the block lane's: a GOAL is one of Tom's own
    // todos, bound to a batch by the planner and otherwise unchanged. Binding
    // it must not be what stops it getting groundwork — that would mean the
    // planner silently removes a todo from every lane, the frontier (which
    // only checks a goal, and only when the batch's work has stalled) and the
    // preparer alike, precisely when Tom has put committed time on it.
    const legacy = (t: Doc<"dtsTodos">): boolean => t.batchId === undefined;
    const legacyOrGoal = (t: Doc<"dtsTodos">): boolean =>
      t.batchId === undefined || t.kind === "goal";

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
        // todoById, not `active`, because a block's subject may be a bound
        // goal — but the sleep test `active` already applied has to be asked
        // here too: a row whose wakeAt is still ahead is asleep, and a block
        // on it does not wake it (no lane hands out a sleeping row).
        const t = todoById.get(block.todoId);
        if (!t || t.status !== "active" || !wakeAtPassed(t, now)) continue;
        if (!legacyOrGoal(t)) continue;
        // Not ready: not yet prepared.
        if (unprepared(t)) candidates.push({ todo: t, lane: "block" });
      } else if (block.category !== undefined && block.category !== "code") {
        // Category block: the stalest NON-excluded unprepared todo in the
        // category — probed through excluded() (memoized, so the admission
        // loop re-check is free). The old pick-one-then-test admitted nothing
        // whenever the single stalest pick happened to be excluded.
        const inCategory = active
          .filter(
            (t) =>
              t.category === block.category &&
              legacyOrGoal(t) &&
              unprepared(t),
          )
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
      (t) => legacy(t) && t.timingClass === "dated" && unprepared(t),
    );
    dated.sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
    for (const t of dated) candidates.push({ todo: t, lane: "dated" });

    // (3) Whenever actives, stalest first. The condition-bound lane that used
    // to sit here is gone with the value it read (the lifeos update, phase 7):
    // a row that was condition-bound is now a task carrying its condition in
    // its statement, asleep until its wake time, and it reaches a worker
    // through this lane once it wakes.
    const whenever = active.filter(
      (t) => legacy(t) && t.timingClass === "whenever" && unprepared(t),
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
      // answer (batch declaration first, the old guess only as its fallback).
      // A graph task adds its batch's words to that fallback, because the task
      // itself is one line.
      const repos = resolveSessionRepos({
        batch: c.batch,
        todo: c.todo,
        extraText: c.batch
          ? `${c.batch.statement} ${c.batch.groundUpExplanation ?? ""}`
          : "",
      });

      // The prompt is built BEFORE the insert (as a builder closed over
      // everything but the session id, which does not exist yet) so both lanes
      // reach the same one row-builder instead of each writing their own pair
      // of inserts. Whichever lane runs, `extra` is what the event records
      // beyond the session and the todo.
      let prompt: (sessionId: Id<"claudeSessions">) => string;
      let extra: Record<string, unknown> = {};

      // ── The graph world's mission ──────────────────────────────────────────
      // A candidate from the frontier gets the WORKER prompt: its batch, the
      // needs that are already done (with what they produced), what waits on
      // it, and the rest of the ready set beside it.
      if (c.lane === "graph" && c.batch !== undefined) {
        const batch = c.batch;
        const asNeighbor = (t: Doc<"dtsTodos">): GraphNeighbor => ({
          statement: t.statement,
          status: t.status,
          kind: t.kind === "goal" ? "goal" : "task",
          actor: t.actor,
          evidence: t.evidence,
        });
        const needs = (c.todo.needs ?? [])
          .map((id) => todoById.get(id))
          .filter((t): t is Doc<"dtsTodos"> => t !== undefined)
          .map(asNeighbor);
        // Everything that needs this todo, wherever it lives. Not scoped to the
        // batch: `needs` may point at a batch-less todo (addressable() in
        // tts.ts permits it), so a batch-scoped filter hides exactly the
        // dependent the worker would never otherwise hear about.
        const dependents = todos
          .filter((t) => (t.needs ?? []).includes(c.todo._id))
          .map(asNeighbor);
        const siblings = (readyByBatch.get(c.todo.batchId as string) ?? [])
          .filter((t) => t._id !== c.todo._id)
          .map(asNeighbor);
        const batchNeeds = (batch.needs ?? [])
          .map((id) => batchById.get(id)?.statement)
          .filter((s): s is string => s !== undefined);
        // Tom's must-not-break lines on the batch's goals, where the goal's
        // statement is: binding on every task toward them.
        const mustNotBreak = todos
          .filter(
            (t) =>
              t.batchId === batch._id &&
              t.kind === "goal" &&
              (t.mustNotBreak ?? "").trim() !== "",
          )
          .map((t) => ({ goal: t.statement, line: t.mustNotBreak!.trim() }));
        prompt = (sessionId) =>
          buildWorkerPrompt({
            todo: c.todo,
            batch,
            sessionId,
            repos,
            needs,
            dependents,
            siblings,
            batchNeeds,
            mustNotBreak,
          });
        extra = { batchId: batch._id };
      } else {
        prompt = (sessionId) => buildAutoMissionPrompt(c.todo, sessionId, repos);
      }

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
        ...extra,
      });
    };

    // THE CODE LANE goes first: Tom's approve and archive rulings on code
    // todos are work he ratified by hand, and any lane placed after the walk
    // can be starved by it — a full frontier or a long legacy backlog fills
    // every slot of every tick. It takes at most one slot (CODE_MISSIONS_PER_TICK).
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

    // PASS ONE holds the frontier to its quota, so a tick with more ready
    // graph tasks than slots still reaches the legacy lanes. PASS TWO runs the
    // same walk with the quota lifted: a slot the legacy lanes had nothing to
    // put in goes back to the graph rather than going unspent.
    for (const c of candidates) {
      if (admittedSoFar() >= capacity) break;
      if (c.lane === "graph" && (counts.graph ?? 0) >= graphQuota) continue;
      if (picked.has(c.todo._id)) continue;
      if (await excluded(c.todo)) continue;
      await admit(c);
    }
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
      await admitProspectMission(ctx, now, liveSessions, fleet);
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
