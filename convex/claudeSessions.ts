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
  markCodeSessionRulingsApplied,
  markLiveSessionRulingApplied,
} from "./ttsRulings";
import { logEvent } from "./tts";
import { appendNotes, inboundRowIdOf, NOTES, rowSource } from "./sessionRows";
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
import { DAEMON_RESTART_SENTENCE, FABLE_AVAILABILITY, USAGE_LIMIT_REPORT } from "./ttsShared";
import {
  DAEMON_STALE_MS,
  DEFAULT_SESSION_MODEL,
  LIVE_STATUSES,
  MODEL_OF_TOM_HEADER,
  NO_REPO,
  SESSION_MODEL,
  SESSION_REPO_NAMES,
  isLive,
  modelFamily,
  normalizeSessionRepos,
  ttsSessionLink,
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
// The rows are the agent file's, read by the session's runId
// (convex/sessionRows.ts rowSource). A session whose run is not named yet has
// no rows to show, and gets an empty page rather than an error: its first
// turn is still running.
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
    const page = await ctx.db
      .query("claudeMessages")
      .withIndex("by_run_seq", (q) => q.eq("runId", source.runId))
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
// of documents by the 256KB chunk cap (agents.internalIngestOverflow) whatever
// the byte budget says. The budget normally stops the walk first.
const OVERFLOW_READ_CHUNKS = 8;

const utf8 = new TextEncoder();
const utf8Bytes = (text: string) => utf8.encode(text).length;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8.encode(text));
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * The complete payload behind one message, chunks reassembled in order.
 *
 * `fromIndex` continues a previous read at its `nextIndex`; concatenating the
 * `text` of every page in order reproduces exactly what was stored.
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
  /** The run whose agent file the row came from. */
  runId: string;
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
  // A row's chunks sit under its own key, (runId, seq).
  const { runId } = message;
  if (runId === undefined) return null;
  if (!message.overflow) {
    return {
      hasOverflow: false,
      runId,
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
      .withIndex("by_run_seq_index", (q) =>
        q.eq("runId", runId).eq("seq", message.seq).gte("index", fromIndex),
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
    runId,
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
    if (session === null) return pending;
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
  v.literal("therapy"),
);

/**
 * Which repos should this session check out? Answered once, here, in a fixed
 * order of authority — each source consulted only when the one above it says
 * nothing:
 *
 *  1. `explicit` — the caller named the set: the session form, the weekly
 *     job. This is the normal path. An explicit empty
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
  kind: Doc<"claudeSessions">["kind"];
  /** Already through resolveSessionRepos. Empty = the empty-scratch posture.
   * Kind "therapy" must name none: insertSession refuses it otherwise. */
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
  // A therapy session opens on no repo (Tom's ruling 2026-09-25). Refused
  // rather than quietly emptied: a caller that named a repo for one asked for
  // something this kind does not do, and the error says so before any row or
  // opener exists. Here, not in createSessionFrom, because this is the one
  // row-builder every launch surface goes through.
  if (seed.kind === "therapy" && repos.length > 0) {
    throw new Error(
      `a therapy session opens on no repo; this one named ${repos.join(", ")}`,
    );
  }
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
  // A therapy session's subject is the mental-health area, whatever todo it
  // was opened on: the router grants write, know-intent and
  // know-mental-health for it. It is the one thing that builds an area
  // subject; the Jarvis session-start hook routes the same subject when the
  // session host hands it TTS_SESSION_KIND=therapy.
  const subject: ContextSubject =
    seed.kind === "therapy"
      ? { kind: "area", area: "mental-health" }
      : seed.todoId !== undefined
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
 * (convex/sessionRows.ts rowSource): the agent file's by runId, so a row's
 * content is in the parser's shape (a tool call's `name`, `id` and `input`).
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
    const page = await ctx.db
      .query("claudeMessages")
      .withIndex("by_run_seq", (q) => q.eq("runId", source.runId))
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
        // it (claudeMessageOverflow under the row's runId and seq).
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
      // A therapy session's repos are known without a guess: none. The word
      // guess over a todo would otherwise name one and insertSession refuse it.
      repos: resolveSessionRepos({
        explicit: repos ?? repo ?? (kind === "therapy" ? [] : undefined),
        todo,
      }),
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

// The one outcome pen for the interactive footer. The caller owns its
// session-specific purpose and outcome wording; this owns the
// credential-bearing command and its exact JSON shape.
function sessionOutcomePen({
  sessionId,
  leadIn,
  summary,
  after,
}: {
  sessionId: Id<"claudeSessions">,
  leadIn: string;
  summary: string;
  after?: string;
}): string {
  const command =
    `curl -s -X POST "$CONVEX_SITE_URL/tts/session-outcome" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"sessionId": "${sessionId}", "outcome": "completed", "summary": "${summary}"}'`;
  return [leadIn, command, after].filter((line): line is string => line !== undefined).join("\n");
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
    // Codex account usage, read off the Codex CLI by the daemon and stored
    // for the pages. Reported on the same throttled heartbeat as `load`. The
    // five-hour figure is absent when the account reports no such window
    // (schema.ts says which plans).
    codexUsage: v.optional(
      v.object({
        weeklyUsedPercent: v.number(),
        fiveHourUsedPercent: v.optional(v.number()),
        weeklyResetsAt: v.optional(v.number()),
        readAt: v.number(),
      }),
    ),
    // The model slugs the box's Codex CLI lists, stored for the pages.
    codexModels: v.optional(v.array(v.string())),
    // Accepted and ignored: the daemon on the box still sends both (Jarvis
    // worker/session-host/session-host.mjs, for the hosted runs of the
    // deleted orchestrator), and a validator refuses an unknown argument,
    // which would stop every session's poll. Delete both lines once the
    // Jarvis branch night/w1-dead-generation is live on the box.
    hosts: v.optional(v.array(v.string())),
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
          // The newest row the agent file has landed for this session (its
          // seq, turn and line time), absent before the run has any. The
          // daemon clears its live tail when the turn's rows have landed, not
          // at the turn's result, and this is how it sees them land.
          newestRow: await newestRunRow(ctx, s),
        });
      }
    }
    return { now, sessions };
  },
});

// ── Internal: daemon ingest (per-session flush) ──────────────────────────────
// ONE transaction per flush (~400ms cadence while streaming). Carries any
// subset of: status transition, stream-buffer replacement, notes, inbound
// acks. It carries no transcript rows: a session's rows are its agent file's,
// landed by the sweep (convex/sessionRows.ts). The response piggybacks this
// session's pending commands, which is what makes polling feel push-like
// exactly when a turn is live.

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
    // What the daemon says about the session that is not a row: a model
    // change, a rebuilt workspace, preserved or discarded work, the time cap,
    // a failed delivery. Stored in sessionNotes, each text cut to 1 KB, and
    // drawn on the page between the rows by time.
    notes: v.optional(NOTES),
    cwd: v.optional(v.string()),
    lastSdkEventAt: v.optional(v.number()),
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

    // Notes are facts: a terminal or pre-reopen payload still lands them.
    if (args.notes !== undefined) await appendNotes(ctx, args.sessionId, args.notes);

    // Terminal sessions (forceClose is browser-owned) accept notes — a note
    // is a fact about what happened — but no state: a late
    // daemon flush must not resurrect the status, overwrite the endedReason
    // that records what actually happened, or advance activity facts
    // (review finding: the guard originally covered status alone).
    const terminal = !isLive(session.status);
    // The same "notes yes, state no" verdict for a payload from BEFORE a reopen.
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
        // A turn Tom typed becomes a session-reply label when the agent
        // file's user row for it lands (convex/agents.ts internalIngest),
        // not here: the row the label names is the file's.
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

// ── The workspace paragraph ──────────────────────────────────────────────────

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
