import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
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
  liveRulings,
  markLiveSessionRulingApplied,
  subjectKey,
} from "./ttsRulings";
import { logEvent } from "./tts";

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
// the graph rules the frontier walk below reads (buildDoneSet / isReady) — the
// page, the planner, and the scheduler must all mean the same thing by
// "ready". The writing standard the worker mission pastes into its prompt is
// the synced WikiTom skill (ttsSkills.skillText), with WRITING_STANDARD as its
// fallback.
import { skillText } from "./ttsSkills";
import {
  DAEMON_STALE_MS,
  NO_REPO,
  SESSION_REPO_NAMES,
  WRITING_SKILL,
  WRITING_STANDARD,
  buildDoneSet,
  goalCheckable,
  isReady,
  normalizeSessionRepos,
  sessionRepos,
} from "./ttsShared";
export { DAEMON_STALE_MS };

const LIVE_STATUSES = [
  "requested",
  "starting",
  "idle",
  "running",
  "awaiting-permission",
] as const;

function isLive(status: Doc<"claudeSessions">["status"]): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(status);
}

// Un-acked permission decisions for a session, bounded: newest 25 per decided
// status, filtered to appliedAt-unset. Correct in practice because un-acked
// decisions are by construction the most recent rows (the daemon acks within
// a poll cycle); acked history beyond the window is irrelevant.
async function recentUnappliedDecisions(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"claudeSessions">,
): Promise<Doc<"claudePermissions">[]> {
  const out: Doc<"claudePermissions">[] = [];
  for (const status of ["allowed", "denied"] as const) {
    const rows = await ctx.db
      .query("claudePermissions")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", sessionId).eq("status", status),
      )
      .order("desc")
      .take(25);
    out.push(...rows.filter((p) => p.appliedAt === undefined));
  }
  return out;
}

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

/**
 * Both Tom-facing session reads return the row with `repos` ALWAYS PRESENT —
 * `sessionRepos` applied once here rather than `repos ?? [repo]` respelled at
 * every screen that renders a session. The schema states the rule; stating it
 * at the boundary means a future reader inherits it instead of having to know
 * it, and it is the same expression internalListLive already projects, so the
 * browser and the cron see one shape. Everything else is the raw document.
 */
function withRepos<T extends Doc<"claudeSessions">>(
  session: T,
): T & { repos: string[] } {
  return { ...session, repos: sessionRepos(session) };
}

export const listSessions = query({
  args: {},
  handler: async (ctx) => {
    await requireTomId(ctx);
    // Newest first; the session list is human-scale (take, not collect —
    // ledger tts-collect-pagination discipline).
    const rows = await ctx.db.query("claudeSessions").order("desc").take(100);
    return rows.map(withRepos);
  },
});

export const getSession = query({
  args: { id: v.id("claudeSessions") },
  handler: async (ctx, { id }) => {
    await requireTomId(ctx);
    const session = await ctx.db.get(id);
    return session === null ? null : withRepos(session);
  },
});

// Finalized transcript, seq-ascending, paginated — history rows never change,
// so pages are cache-friendly forever.
export const getMessages = query({
  args: {
    sessionId: v.id("claudeSessions"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { sessionId, paginationOpts }) => {
    await requireTomId(ctx);
    return await ctx.db
      .query("claudeMessages")
      .withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId))
      .order("desc") // newest page first; client reverses within a page
      .paginate(paginationOpts);
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

export const getPendingPermissions = query({
  args: { sessionId: v.id("claudeSessions") },
  handler: async (ctx, { sessionId }) => {
    await requireTomId(ctx);
    return await ctx.db
      .query("claudePermissions")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", sessionId).eq("status", "pending"),
      )
      .collect(); // bounded: a session blocks while one is pending
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
 *  3. The batch-member vote — each {repo, externalId} member is one tally mark
 *     and the most frequent wins (ties keep the first seen: Map preserves
 *     insertion order and the comparison is strict >).
 *  4. The substring scan over the item's own words. The last resort and the
 *     weakest: it is case-sensitive and matches anywhere, so it reads "the
 *     tom.quest dashboard" and "not tom.quest" identically. Kept only because
 *     dropping it would regress every batch-less legacy todo to no checkout at
 *     all; (2) is what makes it stop mattering.
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
    const tally = new Map<string, number>();
    for (const m of todo.members ?? []) {
      // A code member is the {repo, externalId} pair; a life member carries
      // todoId instead and votes for nothing.
      if (m.repo === undefined || m.externalId === undefined) continue;
      tally.set(m.repo, (tally.get(m.repo) ?? 0) + 1);
    }
    let winner: string | undefined;
    let winnerCount = 0;
    for (const [repo, count] of tally) {
      if (count > winnerCount) {
        winner = repo;
        winnerCount = count;
      }
    }
    if (winner !== undefined) return normalizeSessionRepos(winner);
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
  mode?: "interactive" | "autonomous";
  model?: "fable";
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
    mode: seed.mode,
    model: seed.model,
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
  const text =
    seed.prompt(sessionId, repos) +
    (seed.outcomePen === false ? "" : outcomePenFooter(sessionId, repos));
  await ctx.db.insert("claudeInbound", {
    sessionId,
    kind: "user-turn",
    text,
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
        repos: sessionRepos(s),
        createdAt: s.createdAt,
        lastSdkEventAt: s.lastSdkEventAt,
      }));
  },
});

// ── Tom-facing mutations ─────────────────────────────────────────────────────

export const createSession = mutation({
  args: {
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
    initialPrompt: v.string(),
  },
  handler: async (
    ctx,
    { title, kind, repos, repo, todoId, batchId, blockCategory, initialPrompt },
  ) => {
    await requireTomId(ctx);
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
        // The ratified rule is "every session ends with a written outcome
        // record". An INTERACTIVE session had no writer for its own outcome at
        // all until the footer was appended server-side, after the insert.
        prompt: () => initialPrompt,
      },
      Date.now(),
    );
  },
});

// The interactive twin of the autonomous mission's pen #2 — same route, same
// key, same env contract (CONVEX_SITE_URL + TTS_WORKER_KEY are the only two
// variables the daemon injects; SESSIONS_WORKER_KEY never enters a
// model-reachable environment). Kept verbatim-close to the autonomous wording
// so the two prompts teach one command, not two.
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
      : "";
  return (
    workspace +
    `\n\n---\nThis session's id: ${sessionId}. When the session's work concludes (or you and Tom agree it is done), record the outcome:\n` +
    `curl -s -X POST "$CONVEX_SITE_URL/tts/session-outcome" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"sessionId": "${sessionId}", "outcome": "completed", "summary": "one line: what happened"}'\n` +
    `("completed" = the session's purpose was met; otherwise "errored" with what blocked it. CONVEX_SITE_URL and TTS_WORKER_KEY are already set in this session's environment.)`
  );
}

// Re-entry (spec §9: an ended session accepts a follow-up turn and continues
// with context intact). Before this, an ending was a dead end — the only way
// back to a finished conversation was a NEW session with none of its context.
export const reopenSession = mutation({
  args: { sessionId: v.id("claudeSessions"), text: v.string() },
  handler: async (ctx, { sessionId, text }) => {
    await requireTomId(ctx);
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
      ...(session.mode === "autonomous"
        ? { reopenedFromAutonomous: true }
        : {}),
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
  },
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

export const sendMessage = mutation({
  args: { sessionId: v.id("claudeSessions"), text: v.string() },
  handler: async (ctx, { sessionId, text }) => {
    await requireTomId(ctx);
    const session = await getSessionOrThrow(ctx, sessionId);
    if (!isLive(session.status)) {
      throw new Error(`Session is ${session.status} — messages cannot be sent`);
    }
    if (text.trim() === "") throw new Error("Message is empty");
    await ctx.db.insert("claudeInbound", {
      sessionId,
      kind: "user-turn",
      text,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

// interrupt = stop the current turn, keep the session; stop = end the session.
export const sendControl = mutation({
  args: {
    sessionId: v.id("claudeSessions"),
    kind: v.union(v.literal("interrupt"), v.literal("stop")),
  },
  handler: async (ctx, { sessionId, kind }) => {
    await requireTomId(ctx);
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
  },
});

export const decidePermission = mutation({
  args: {
    requestId: v.string(),
    decision: v.union(v.literal("allowed"), v.literal("denied")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { requestId, decision, note }) => {
    await requireTomId(ctx);
    const row = await ctx.db
      .query("claudePermissions")
      .withIndex("by_request", (q) => q.eq("requestId", requestId))
      .first();
    if (!row) throw new Error("Permission request not found");
    // Compare-and-set: only pending → decided. A second tab's tap is a no-op.
    if (row.status !== "pending") return;
    await ctx.db.patch(row._id, {
      status: decision,
      decidedAt: Date.now(),
      decidedBy: "tom",
      note,
    });
  },
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
    const pendingPermissions = await ctx.db
      .query("claudePermissions")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", sessionId).eq("status", "pending"),
      )
      .collect();
    for (const row of pendingPermissions) {
      await ctx.db.patch(row._id, {
        status: "expired",
        decidedAt: now,
        decidedBy: "force-close",
      });
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
  },
  handler: async (
    ctx,
    { version, activeAccount, daemonStartedAt, lastIngestError, load },
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
        // Decisions the daemon has not yet applied to the SDK (decided but
        // no appliedAt) — plus pending ones so a restarted daemon can
        // re-register its local promise bookkeeping. Bounded with take(25)
        // newest-first (review finding: a plain collect re-reads the
        // session's whole decision HISTORY on the hot path; un-acked rows
        // are always recent and 0-1 in number).
        const permissions = (
          await ctx.db
            .query("claudePermissions")
            .withIndex("by_session_status", (q) =>
              q.eq("sessionId", s._id).eq("status", "pending"),
            )
            .collect()
        ).concat(await recentUnappliedDecisions(ctx, s._id));
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
          // The model tier, when the claimed task asked for one. Absent is the
          // default and the norm (a worker runs Opus); the daemon reads this
          // and passes it to the SDK.
          model: s.model,
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
          permissions,
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
        v.literal("awaiting-permission"),
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
    // There is no permissionRequests arg: under the unified auto gate the
    // daemon parks nothing for Tom (#canUseTool returns allow or deny on every
    // path), so nothing ever produced one. The permissionUpdates ack loop below
    // stays — historical pending rows still need expiring and acking.
    // Daemon acks that a decision reached the SDK; also used to mark
    // pending rows expired/superseded on restart or stop.
    permissionUpdates: v.optional(
      v.array(
        v.object({
          requestId: v.string(),
          applied: v.optional(v.boolean()),
          status: v.optional(
            v.union(v.literal("superseded"), v.literal("expired")),
          ),
          decidedBy: v.optional(v.string()),
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
        if (row.seq < session.nextSeq) continue; // retry replay — drop
        await ctx.db.insert("claudeMessages", {
          sessionId: args.sessionId,
          seq: row.seq,
          turn: row.turn,
          kind: row.kind,
          content: row.content,
          parentToolUseId: row.parentToolUseId,
          createdAt: now,
        });
        if (row.seq > maxSeq) maxSeq = row.seq;
      }
      patch.nextSeq = maxSeq + 1;
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
    for (const upd of args.permissionUpdates ?? []) {
      const row = await ctx.db
        .query("claudePermissions")
        .withIndex("by_request", (q) => q.eq("requestId", upd.requestId))
        .first();
      if (!row || row.sessionId !== args.sessionId) continue;
      const p: Record<string, unknown> = {};
      if (upd.applied) p.appliedAt = now;
      if (upd.status !== undefined && row.status === "pending") {
        p.status = upd.status;
        p.decidedAt = now;
        p.decidedBy = upd.decidedBy ?? "daemon";
      }
      if (Object.keys(p).length > 0) await ctx.db.patch(row._id, p);
    }

    // Piggyback: this session's pending commands and undelivered decisions
    // ride back on the flush response (~400ms latency while streaming).
    const pendingInbound = await ctx.db
      .query("claudeInbound")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", args.sessionId).eq("status", "pending"),
      )
      .collect();
    const fresh = await ctx.db.get(args.sessionId);
    const decisions = await recentUnappliedDecisions(ctx, args.sessionId);
    return {
      nextSeq: fresh?.nextSeq ?? session.nextSeq,
      sessionStatus: fresh?.status ?? session.status,
      pendingInbound,
      decisions,
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
      await logEvent(ctx, "session-outcome", session.todoId, {
        sessionId: normalized,
        title: session.title,
        outcome,
        summary: summary.trim(),
      });
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

// ── Open tool work (P2 agent panel) ──────────────────────────────────────────
// What is this session's model DOING right now? Derived entirely from the
// finalized tool-call / tool-result rows — the transcript is the only source;
// nothing here is invented state. A Task call with no result is a running
// subagent; a background Bash call is a long-running command whose latest
// BashOutput/KillShell check is its freshest known state.

const PREVIEW_CHARS = 200;
// Evidence texts (launch results, latest checks) carry the FULL content text,
// hard-capped — the panel promises verbatim evidence bounded by scroll, not a
// preview.
const EVIDENCE_CHARS = 2000;

// The panel shows CURRENT work, so the reads are bounded newest-first windows
// via by_session_kind: a Task or launch older than the window has scrolled out
// of panel scope by construction — the transcript remains the full record.
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
    // A terminal session has no OPEN work by definition — empty panel.
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
    // agent-panel reads exactly these names (no aliases on either side).
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

    // Panel history caps: newest 10 finished agents and newest 10 launches,
    // newest last (both lists are call-order; end order matches closely
    // enough for a panel history).
    return {
      agents,
      commands: commands.slice(-10),
      finished: finished.slice(-10),
    };
  },
});

// ── Autonomous-fleet config (P3) ─────────────────────────────────────────────

// Defaults when no claudeAutoConfig row exists. enabled FALSE: the fleet runs
// nothing until the enable pen is used deliberately.
const AUTO_DEFAULTS = {
  enabled: false,
  maxLoadPerCpu: 0.8,
  minFreeMemMb: 1024,
  maxLiveAutonomous: 8,
  maxNewPerTick: 2,
} as const;

const AUTO_CONFIG_FIELDS = {
  enabled: v.boolean(),
  maxLoadPerCpu: v.number(),
  minFreeMemMb: v.number(),
  maxLiveAutonomous: v.number(),
  maxNewPerTick: v.number(),
};

async function upsertAutoConfig(
  ctx: MutationCtx,
  fields: {
    enabled: boolean;
    maxLoadPerCpu: number;
    minFreeMemMb: number;
    maxLiveAutonomous: number;
    maxNewPerTick: number;
  },
): Promise<void> {
  const existing = await ctx.db.query("claudeAutoConfig").first();
  const row = { ...fields, updatedAt: Date.now() };
  if (existing) {
    await ctx.db.patch(existing._id, row);
  } else {
    await ctx.db.insert("claudeAutoConfig", row);
  }
}

export const getAutoConfig = query({
  args: {},
  handler: async (ctx) => {
    await requireTomId(ctx);
    const row = await ctx.db.query("claudeAutoConfig").first();
    return row
      ? { ...row, fromDefaults: false }
      : { ...AUTO_DEFAULTS, fromDefaults: true };
  },
});

export const setAutoConfig = mutation({
  args: AUTO_CONFIG_FIELDS,
  handler: async (ctx, fields) => {
    await requireTomId(ctx);
    await upsertAutoConfig(ctx, fields);
  },
});

// The CLI pen for supervised enable at deploy:
// `npx convex run claudeSessions:internalSetAutoConfig '{"enabled": true, ...}'`
// — same upsert as setAutoConfig (which needs Tom's browser identity the Jarvis Box
// does not hold). Use only while supervising the first ticks.
export const internalSetAutoConfig = internalMutation({
  args: AUTO_CONFIG_FIELDS,
  handler: async (ctx, fields) => {
    await upsertAutoConfig(ctx, fields);
  },
});

// ── Autonomous mission prompt ────────────────────────────────────────────────

// Live context for one batch member, resolved by the scheduler against the
// todo collect / mirror it already holds.
type AutoMemberContext = {
  kind: "life" | "code";
  label?: string;
  statement: string;
  status: string;
};

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
function workspaceParagraph(
  repos: string[],
  sessionId: Id<"claudeSessions">,
  work: string,
): string {
  const branch = `session/${sessionId}`;
  if (repos.length === 1) {
    return `The workspace: your working directory is a fresh checkout of ${repos[0]} on branch ${branch}. ${work} Commit as you go and push the branch (the remote is already configured). Open a pull request with \`gh pr create\` ONLY when the work is merge-ready, and say so in the outcome summary.`;
  }
  const list = repos.map((r) => `\`./${r}\``).join(" and ");
  return `The workspace: your working directory holds ${repos.length} fresh checkouts, one per repository — ${list}. Each is on its own branch ${branch}. ${work} \`cd\` into the repository you are changing before running git: commit as you go and push ${branch} in EACH repository you touched (every remote is already configured), and open a pull request per repository with \`gh pr create\` ONLY when that repository's work is merge-ready. Name every branch and pull request you opened in the outcome summary.`;
}

// Opening prompt for an AUTONOMOUS session (house voice: the ground-up
// contract of app/lib/tts-session-prompt.ts, adapted for a session no one is
// watching live). The sessionId rides in so the outcome pen can name this
// session — the agent has no other way to learn its own id.
//
// Lockstep: app/lib/tts-session-prompt.ts is the interactive twin (its
// CONTRACT opening, buildTodoSessionPrompt's item facts block, and the batch
// members/plan blocks) — both files carry a note naming the other, and the
// facts-block wording ('The item ("…"):', "The plan (N steps, in order):",
// "The members (N, live statuses):") is kept identical where the posture
// allows. No import across the convex boundary: that module is client code.
function buildAutoMissionPrompt(
  todo: Doc<"dtsTodos">,
  sessionId: Id<"claudeSessions">,
  repos: string[],
  members?: AutoMemberContext[],
): string {
  const lines: (string | null)[] = [
    `You are working inside TTS (Toms Todo System) in an AUTONOMOUS session — no one is watching this transcript live, and nothing you write in chat reaches anyone unless a pen (a command below) records it. Follow the ground-up contract in everything you write into the system: define terms on first use, invent no names, concrete before abstract; language is descriptive, never evaluative.`,
    "",
    // Facts block — same labels and order as the interactive twin's
    // buildTodoSessionPrompt (category is autonomous-only: it scopes what a
    // block-lane session may touch).
    `The item ("${todo.statement}"):`,
    promptFact("category", todo.category),
    promptFact("work description", todo.workDescription),
    promptFact("entry action", todo.entryAction),
    promptFact("body", todo.body),
    promptFact("brief", todo.brief),
  ];
  const plan = todo.plan ?? [];
  if (plan.length > 0) {
    lines.push("", `The plan (${plan.length} steps, in order):`);
    plan.forEach((step, i) => {
      lines.push(
        `${i + 1}. [${step.actor}, ${step.status}] ${step.text}${step.evidence ? ` (evidence: ${step.evidence})` : ""}`,
      );
    });
  }
  if (todo.members !== undefined) {
    lines.push(
      "",
      "This item is a BATCH: one grouping of several todos, so one session's worth of shared context advances all of them.",
    );
    const resolved = members ?? [];
    if (resolved.length > 0) {
      lines.push("", `The members (${resolved.length}, live statuses):`);
      for (const m of resolved) {
        lines.push(
          `- [${m.kind}${m.label ? ` ${m.label}` : ""}, ${m.status}] "${m.statement}"`,
        );
      }
    }
  }
  lines.push(
    "",
    `The goal: do every open plan step with actor "agent" — research, draft, gather, and write what you produce into the item via the prepare pen below. Advance readiness to "ready-for-tom" ONLY when the remaining work genuinely needs Tom. For a batch, refine the plan and check off the agent steps you complete (always post the FULL updated plan, never a diff).`,
    "",
    // Ratified doctrine (Tom, 2026-08-29): his input gates PERSISTENCE, never
    // implementation — a session that halts at a decision leaves him nothing
    // concrete to rule on.
    `Tom decisions: a plan step that names a decision of Tom's does NOT block you. Implement your best-judgment option and name the alternatives you passed over in that step's text or its evidence; the decision then surfaces where the work persists — the pull request, or the batch's ruling. Reserve actor-"tom" steps for what ONLY Tom can do: rulings, merges, and real-world actions.`,
    "",
    // The env contract: the daemon injects ONLY these two variables into an
    // autonomous session's shell — SESSIONS_WORKER_KEY (the ingest key) never
    // enters a model-reachable environment (the auth-clobber lesson), which
    // is why the outcome pen below rides the TTS key.
    "The pens (shell commands; CONVEX_SITE_URL and TTS_WORKER_KEY are already set in this session's environment):",
    "",
    "1. Write your work into the item:",
    "```",
    `curl -s -X POST "$CONVEX_SITE_URL/tts/prepare-todo" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"id": "${todo._id}", "brief": "...", "entryAction": "...", "workDescription": "...", "readiness": "preparing", "plan": [{"text": "...", "actor": "agent", "status": "open"}]}'`,
    "```",
    'Every field except "id" is optional — send only what you produced. On a batch only "plan" lands (the server skips the other fields by design).',
    "",
    "2. Record this session's outcome when the mission is done:",
    "```",
    `curl -s -X POST "$CONVEX_SITE_URL/tts/session-outcome" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"sessionId": "${sessionId}", "outcome": "completed", "summary": "one line: what landed where"}'`,
    "```",
    '"completed" means the mission produced its artifact; otherwise record "errored" with a summary saying what blocked you.',
    "",
    // Two workspace variants. No repos is the groundwork posture (unchanged);
    // a repo-equipped mission implements the code itself and stops exactly at
    // the merge — the one gate the doctrine keeps for Tom.
    ...(repos.length === 0
      ? [
          "Prohibitions: never record a ruling and never change a status — verdicts and status changes are Tom's pens alone. Never touch code — this session has an EMPTY scratch directory and no repository; anything that needs code goes into the plan as an open step instead.",
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
    "Ending: record the outcome via the /tts/session-outcome command, then simply stop responding — the daemon ends the session after your final turn.",
  );
  return lines.filter((l): l is string => l !== null).join("\n");
}

// ── The worker mission (schema v2, ratified 2026-08-29) ──────────────────────
// The successor to buildAutoMissionPrompt for every todo that lives inside a
// BATCH. The old builder stays, unchanged, for the legacy rows that have no
// batch — the two worlds run side by side until the migration drains the old
// one, and one prompt cannot honestly serve both (a legacy mission works a
// whole item through a plan; a worker advances ONE node of a graph).
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
  /** The writing skill's text, resolved by the caller (synced or fallback). */
  writingStandard: string;
}): string {
  const {
    todo,
    batch,
    sessionId,
    repos,
    needs,
    dependents,
    siblings,
    writingStandard,
  } = args;
  const isGoal = todo.kind === "goal";
  const lines: (string | null)[] = [
    "You are working inside TTS (Toms Todo System) in an AUTONOMOUS session — no one is watching this transcript live, and nothing you write in chat reaches anyone unless a pen (a command below) records it.",
    "",
    // The closed vocabulary, defined before it is used. These are Tom's words
    // and they are law: writing back to him in any other words costs him a
    // translation he did not ask for.
    "The vocabulary, which is closed — these words mean exactly this and nothing else:",
    "- A BATCH holds how a set of todos gets completed. It is not itself a todo and it is never worked directly.",
    "- A TASK is work someone does. A GOAL is a state of the world the batch is for, written as a condition that is either true yet or not.",
    "- NEEDS are the todos a todo cannot proceed without. A todo is READY when every one of its needs is done (archived counts as done — a need that was set aside is not going to happen).",
    "- A PATH is a named sequence of batches. A MUST edge means the previous batch has to land first; a HELPS edge means it only makes this one easier.",
    '- DISPLAY TEXT is the short line always on screen. A GROUND-UP EXPLANATION is the self-contained layer behind it: a complete HTML document, shown fullscreen, whose exact form the standard below specifies.',
    "",
    "Everything you write into TTS obeys this standard, verbatim:",
    "",
    writingStandard,
    "",
    `THE BATCH ("${batch.statement}"):`,
    promptFact("ground-up explanation", batch.groundUpExplanation),
    batch.path
      ? `path: "${batch.path.name}", position ${batch.path.index}${
          batch.path.edge !== undefined
            ? `, linked to the previous batch by a "${batch.path.edge}" edge`
            : " (the first batch on it)"
        }`
      : null,
    "",
    `YOU HAVE CLAIMED ONE TODO IN THIS BATCH, and only this one ("${todo.statement}"):`,
    `kind: ${isGoal ? "goal" : "task"}`,
    isGoal ? null : `who does it: ${todo.actor ?? "agent"}`,
    promptFact("condition", todo.condition),
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
  ];

  const neighborLine = (n: GraphNeighbor) =>
    `- [${n.kind}, ${n.status}${
      n.kind === "task" ? `, ${n.actor ?? "agent"}` : ""
    }] "${n.statement}"${n.evidence ? ` (evidence: ${n.evidence})` : ""}`;
  lines.push(
    "",
    needs.length > 0
      ? `ITS NEEDS (${needs.length}, every one of them done — that is why this todo is ready):`
      : "ITS NEEDS: none. It was ready from the moment the batch was formed.",
    ...needs.map(neighborLine),
  );
  lines.push(
    "",
    dependents.length > 0
      ? `WHAT NEEDS IT (${dependents.length} — these become ready the moment yours is done):`
      : "WHAT NEEDS IT: nothing in this batch waits on it.",
    ...dependents.map(neighborLine),
  );
  lines.push(
    "",
    siblings.length > 0
      ? `ALSO READY IN THIS BATCH RIGHT NOW (${siblings.length}). Do NOT work them: another session may be holding any of them, and the ones marked "tom" are waiting on him. They are here so you know what is moving beside you:`
      : "NOTHING ELSE IS READY IN THIS BATCH right now.",
    ...siblings.map(neighborLine),
  );

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
          "2. THE WORK TURNS OUT TO NEED TOM'S JUDGMENT. Do not stop at the question. Prepare it so completely that his part is one reply: write the ground-up explanation (self-contained, defining every term, complete for a reader who has none of this context), state the options as they actually stand, and give your recommendation with the one reason for it. Then set readiness to ready-for-tom and leave the task open. His input gates what PERSISTS — a merge, a ruling, a real-world action — never what you implement: where you can implement your best-judgment option and name what you passed over, do that instead of asking.",
          "",
          "THAT EXPLANATION IS A COMPLETE HTML DOCUMENT, not a paragraph — from \"<!DOCTYPE html>\" to \"</html>\", with its own inline <style> block and nothing loaded from outside: no script, no event handler, no external stylesheet, font, image, or URL. It renders fullscreen in a sandbox with no scripting and no network, so anything external is a hole in the page. Palette #0a0e17 background, #e2e8f0 text, #94a3b8 secondary, #e8a040 accent, #1e293b borders; about 15px body type, real <h1>/<h2> headings, short sections, a <table> for enumerable facts, bordered <div> boxes with → or ↓ arrows where a shape helps. The standard above says what it must cover; write the whole page, because there is no way to amend one and a fragment overwrites what is stored.",
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
    `curl -s -X POST "$CONVEX_SITE_URL/tts/prepare-todo" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"id": "${todo._id}", "readiness": "ready-for-tom", "groundUpExplanation": "...", "entryAction": "the smallest next action", "evidence": "what you produced on the way"}'`,
    "```",
    "Every field except \"id\" is optional — send only what you produced, and send both commands if you both produced something and finished.",
    "",
    "A groundUpExplanation is a whole HTML document and will not survive being typed inline in that command. Write the document to a file, build the request body from it, and post the file:",
    "```",
    `# after writing the page to /tmp/explanation.html\njq -Rs --arg id '${todo._id}' '{id: $id, readiness: "ready-for-tom", groundUpExplanation: .}' < /tmp/explanation.html > /tmp/tts-body.json\ncurl -s -X POST "$CONVEX_SITE_URL/tts/prepare-todo" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d @/tmp/tts-body.json`,
    "```",
    "Any equivalent works (node, python) — the point is that the JSON escaping is done by a tool and never by hand. Add the other fields to the jq object as you need them.",
    "",
    "3. Record this session's outcome when you stop:",
    "```",
    `curl -s -X POST "$CONVEX_SITE_URL/tts/session-outcome" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"sessionId": "${sessionId}", "outcome": "completed", "summary": "one line: what moved and where it landed", "planRepair": "optional: the edge that was wrong"}'`,
    "```",
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
          "Prohibitions: never record a ruling and never change the status of anything but the one todo you claimed — verdicts are Tom's pens alone. Never touch code: this session has an EMPTY scratch directory and no repository, so anything needing code goes to Tom as a prepared task instead.",
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
  );
  return lines.filter((l): l is string => l !== null).join("\n");
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

// Opening prompt for a PROSPECTING mission. Same house voice and same shape as
// buildAutoMissionPrompt (contract opening → the mission → the pens → the
// prohibitions → the ending), with two differences that follow from working no
// todo: there is no item facts block and no prepare pen, and the read-first
// step is mandatory because the only way to avoid handing Tom a duplicate is
// to look at what he already holds.
function buildProspectMissionPrompt(
  repo: string,
  sessionId: Id<"claudeSessions">,
): string {
  const lines: string[] = [
    `You are working inside TTS (Toms Todo System) in an AUTONOMOUS session — no one is watching this transcript live, and nothing you write in chat reaches anyone unless a pen (a command below) records it. Follow the ground-up contract in everything you write into the system: define terms on first use, invent no names, concrete before abstract; language is descriptive, never evaluative.`,
    "",
    `The mission: this session PROSPECTS — it works no todo item. TTS had session capacity left over after handing out its real todo work this tick, and spends it here. Your working directory is a fresh checkout of ${repo}. Read it for CONCRETE, ACTIONABLE issues worth carrying as items in Tom's todo system, and capture each NEW one with the capture pen below. This mission only READS and CAPTURES — no code changes, no commits, no pushes, no pull requests.`,
    "",
    "What counts as a finding:",
    "- a failing or skipped test — name the test and the file it lives in",
    "- dead code: a function, export, module, flag, or config key nothing reaches",
    "- a document that contradicts the code it describes — name both files",
    "- a TODO or FIXME comment in the source that nothing tracks",
    "- a broken link between modules: a stale import path, a field one side renamed and the other still reads, one rule implemented two different ways in two files",
    "- vocabulary drift: one fact carried under two names, or one name meaning two different things",
    "",
    `The quality bar: every finding NAMES the file or files it lives in, and is actionable by a future session holding nothing but your one sentence and the repo. A finding you are not certain about is still worth capturing when it is CONCRETE — Tom reads every item and declining one costs him a glance. What is not worth capturing is a style nitpick or a "this could be cleaner" with no named change: if you cannot say what would change and where, it is not a finding. At most ${PROSPECT_CAPTURE_CAP} captures for the whole mission: a short list of real findings is worth more than a long one, and finding NOTHING new is an honest, complete outcome.`,
    "",
    "The pens (shell commands; CONVEX_SITE_URL and TTS_WORKER_KEY are already set in this session's environment):",
    "",
    "1. READ WHAT TTS ALREADY HOLDS — do this BEFORE you capture anything:",
    "```",
    `curl -s "$CONVEX_SITE_URL/tts/state" -H "X-TTS-Key: $TTS_WORKER_KEY"`,
    "```",
    'The response carries every item in the system under "todos". Read their statements. Never capture a finding that restates one of them, or that an item plainly already covers — a duplicate costs Tom a triage he has already done.',
  ];
  // ComplexMultiTrigger tracks its own code todos in-repo (vqc/todos.yaml is
  // the file the dtsCodeTodoMirror cron reads from each repo's default
  // branch). Those are already-tracked work and must not be re-captured.
  if (repo === "ComplexMultiTrigger") {
    lines.push(
      "",
      `This repo also tracks its own code todos in \`vqc/todos.yaml\` in your checkout. Read that file too, and drop any finding it already names.`,
    );
  }
  lines.push(
    "",
    "2. Capture ONE new finding (repeat per finding, up to the cap above):",
    "```",
    `curl -s -X POST "$CONVEX_SITE_URL/tts/capture" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"statement": "Delete the unreachable helper someHelper in path/to/file.ts", "source": "prospecting", "provenance": "prospect mission ${sessionId}, ${repo}, path/to/file.ts"}'`,
    "```",
    'The statement is ONE imperative sentence that names the file or files. The provenance is where you found it, in exactly the shape above — that is how the item says which mission and which path it came from. Keep "source" as "prospecting".',
    "",
    "3. Record this session's outcome when the mission is done:",
    "```",
    `curl -s -X POST "$CONVEX_SITE_URL/tts/session-outcome" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"sessionId": "${sessionId}", "outcome": "completed", "summary": "one line: what was captured"}'`,
    "```",
    '"completed" is the right outcome whether you captured findings or none — say what you captured, or say "nothing new found" and mean it. Record "errored" only when something blocked the review itself (the checkout was unusable, /tts/state would not answer).',
    "",
    `Prohibitions: never record a ruling and never change a status — verdicts and status changes are Tom's pens alone. Change no file in the checkout, commit nothing, push nothing, and open no pull request: this mission's only output is captured items. Do not capture a duplicate of something TTS already holds, and do not capture more than ${PROSPECT_CAPTURE_CAP} items.`,
    "",
    "Ending: record the outcome via the /tts/session-outcome command, then simply stop responding — the daemon ends the session after your final turn.",
  );
  return lines.join("\n");
}

// The prospecting lane's whole body, called with whatever per-tick budget the
// work walk left unspent. Returns the repo it prospected, or undefined when it
// declined. It creates AT MOST ONE mission per tick: a second one would read a
// tree the first has not finished reading.
async function admitProspectMission(
  ctx: MutationCtx,
  now: number,
  liveSessions: Doc<"claudeSessions">[],
): Promise<string | undefined> {
  // At most PROSPECT_MAX_LIVE prospectors alive at once. An autonomous session
  // with NO todoId is what a prospecting mission looks like — a mission for
  // real work always carries the todo it works, so this needs no extra field to
  // key off. (liveSessions is this tick's snapshot, taken before any creation;
  // since this lane creates one mission per tick at most, nothing it made can
  // be missing from the count it just used.)
  const liveProspectors = liveSessions.filter(
    (s) => s.mode === "autonomous" && s.todoId === undefined,
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
// scripts/check-session-mirrors.mjs fails the build when the two homes drift.
const AUTO_USAGE_RE = /usage.?limit|limit reached|session limit/i;

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
    const config =
      (await ctx.db.query("claudeAutoConfig").first()) ?? { ...AUTO_DEFAULTS };
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

    // (e) Usage circuit breaker: an autonomous ending in the last 3h that
    // names usage/rate pressure means the whole tick stands down.
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
    const tripped = recentTerminal.some(
      (s) =>
        wasAutonomous(s) &&
        (AUTO_USAGE_RE.test(s.endedReason ?? "") ||
          AUTO_USAGE_RE.test(s.outcomeSummary ?? "")),
    );
    if (tripped) return;

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
    const active = todos.filter((t) => t.status === "active");
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
    // Members of non-terminal batches — the batch owns them (exclusion below).
    const batchOwned = new Set<string>();
    for (const t of todos) {
      if (t.members !== undefined && t.status !== "done" && t.status !== "archived") {
        for (const m of t.members) {
          if (m.todoId !== undefined) batchOwned.add(m.todoId);
        }
      }
    }

    const hasOpenAgentStep = (t: Doc<"dtsTodos">): boolean =>
      (t.plan ?? []).some((s) => s.actor === "agent" && s.status === "open");
    const unprepared = (t: Doc<"dtsTodos">): boolean =>
      t.readiness === "unprepared" || t.readiness === "preparing";

    // ── Per-candidate exclusions (cheapest first) ────────────────────────────
    const computeExcluded = async (t: Doc<"dtsTodos">): Promise<boolean> => {
      // Code todos live in the mirror; their work happens in the repo.
      if (t.category === "code") return true;
      // A member of a non-terminal batch is owned by the batch.
      if (batchOwned.has(t._id)) return true;
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
      lane:
        | "graph"
        | "block"
        | "batch"
        | "dated"
        | "condition-bound"
        | "whenever";
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
      if (!isReady(t, doneSet)) continue;
      const list = readyByBatch.get(t.batchId) ?? [];
      list.push(t);
      readyByBatch.set(t.batchId, list);
    }
    const agentWorkable = (t: Doc<"dtsTodos">): boolean =>
      t.kind === "goal" ? goalCheckable(t) : t.actor !== "tom";

    const graphCandidates: Candidate[] = [];
    for (const [batchId, ready] of readyByBatch) {
      const batch = batchById.get(batchId as Id<"batches">);
      // A batch that is done or archived is not work, and a row pointing at a
      // batch that is not there is not something to guess about.
      if (!batch || batch.status !== "active") continue;
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
    // THE ORDER: where the work sits on a path first, then how soon it is due,
    // then how long it has sat. Paths are the sequencing Tom stated between
    // batches, so they outrank everything else: candidates are grouped by path
    // name, and inside a path the earliest position comes first (that is the
    // stage the path is actually waiting on). At one position a "must" link
    // beats a "helps" link — a must-linked batch is on the critical line of
    // the path and a helps-linked one is not. A batch on no path sorts after
    // every batch that is on one: a stated sequence is a stronger signal than
    // no sequence at all.
    const edgeRank = (edge?: string): number => (edge === "must" ? 0 : 1);
    graphCandidates.sort((a, b) => {
      const pa = a.batch?.path;
      const pb = b.batch?.path;
      if ((pa === undefined) !== (pb === undefined)) {
        return pa === undefined ? 1 : -1;
      }
      if (pa && pb) {
        if (pa.name !== pb.name) return pa.name < pb.name ? -1 : 1;
        if (pa.index !== pb.index) return pa.index - pb.index;
        if (edgeRank(pa.edge) !== edgeRank(pb.edge)) {
          return edgeRank(pa.edge) - edgeRank(pb.edge);
        }
      }
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

    // ── The LEGACY lanes (pre-migration rows only) ───────────────────────────
    // Every lane below is the v1 walk, untouched except for one added test:
    // the row must have no batchId. A row inside a batch is the frontier's to
    // schedule, and these lanes read v1 vocabulary (readiness, members, the
    // plan) that says nothing about a graph node.
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
        const t = todoById.get(block.todoId);
        if (!t || t.status !== "active" || !legacyOrGoal(t)) continue;
        // Not ready: a plain todo short of ready-for-tom, or a batch with
        // open agent plan steps still to do.
        const notReady =
          t.members !== undefined
            ? hasOpenAgentStep(t)
            : t.readiness !== "ready-for-tom";
        if (notReady) candidates.push({ todo: t, lane: "block" });
      } else if (block.category !== undefined && block.category !== "code") {
        // Category block: the stalest NON-excluded unprepared todo in the
        // category — probed through excluded() (memoized, so the admission
        // loop re-check is free). The old pick-one-then-test admitted nothing
        // whenever the single stalest pick happened to be excluded.
        const inCategory = active
          .filter(
            (t) =>
              t.category === block.category &&
              t.members === undefined &&
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

    // (2) Active batches with open agent plan steps, stalest first — the same
    // updatedAt ordering the whenever lane below uses. Ordering comes from
    // paths and dates, never a rating (Tom's ruling 2026-08-29).
    const v1Batches = active.filter(
      (t) => t.members !== undefined && legacy(t) && hasOpenAgentStep(t),
    );
    v1Batches.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const t of v1Batches) candidates.push({ todo: t, lane: "batch" });

    // (3) Dated actives still unprepared, soonest due first.
    const dated = active.filter(
      (t) =>
        t.members === undefined &&
        legacy(t) &&
        t.timingClass === "dated" &&
        unprepared(t),
    );
    dated.sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
    for (const t of dated) candidates.push({ todo: t, lane: "dated" });

    // (4) Condition-bound actives, tightest latest-safe first.
    const conditionBound = active.filter(
      (t) =>
        t.members === undefined &&
        legacy(t) &&
        t.timingClass === "condition-bound" &&
        unprepared(t),
    );
    conditionBound.sort(
      (a, b) => (a.latestSafeAt ?? Infinity) - (b.latestSafeAt ?? Infinity),
    );
    for (const t of conditionBound) {
      candidates.push({ todo: t, lane: "condition-bound" });
    }

    // (5) Whenever actives, stalest first.
    const whenever = active.filter(
      (t) =>
        t.members === undefined &&
        legacy(t) &&
        t.timingClass === "whenever" &&
        unprepared(t),
    );
    whenever.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const t of whenever) candidates.push({ todo: t, lane: "whenever" });

    // ── Admit up to `capacity` picks ─────────────────────────────────────────
    // One read for the whole tick: every worker prompt this tick writes carries
    // the same standard, and re-reading it per admission would say otherwise.
    const writingStandard = await skillText(ctx, WRITING_SKILL, WRITING_STANDARD);
    const picked = new Set<string>();
    const counts: Record<string, number> = {};
    const admit = async (c: Candidate): Promise<void> => {
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
        prompt = (sessionId) =>
          buildWorkerPrompt({
            todo: c.todo,
            batch,
            sessionId,
            repos,
            needs,
            dependents,
            siblings,
            writingStandard,
          });
        extra = { batchId: batch._id };
      } else {
        // Resolve batch members for the mission prompt (life via the collect,
        // code via the mirror).
        let members: AutoMemberContext[] | undefined;
        if (c.todo.members !== undefined) {
          members = [];
          for (const m of c.todo.members) {
            if (m.todoId !== undefined) {
              const t = todoById.get(m.todoId);
              members.push({
                kind: "life",
                statement: t?.statement ?? "(missing todo)",
                status: t?.status ?? "missing",
              });
            } else {
              const row = await ctx.db
                .query("dtsCodeTodoMirror")
                .withIndex("by_repo_external", (q) =>
                  q
                    .eq("repo", m.repo ?? "")
                    .eq("externalId", m.externalId ?? ""),
                )
                .first();
              members.push({
                kind: "code",
                label: `${m.repo} ${m.externalId}`,
                statement: row?.statement ?? "(closed upstream)",
                status: row?.status ?? "closed",
              });
            }
          }
        }
        prompt = (sessionId) =>
          buildAutoMissionPrompt(c.todo, sessionId, repos, members);
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
          // The model tier, carried from the task the planner tagged. Absent is
          // the default and the norm: a worker runs Opus, and only a task
          // marked "fable" writes anything here.
          model: c.todo.model === "fable" ? "fable" : undefined,
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

    // PASS ONE holds the frontier to its quota, so a tick with more ready
    // graph tasks than slots still reaches the legacy lanes. PASS TWO runs the
    // same walk with the quota lifted: a slot the legacy lanes had nothing to
    // put in goes back to the graph rather than going unspent.
    for (const c of candidates) {
      if (picked.size >= capacity) break;
      if (c.lane === "graph" && (counts.graph ?? 0) >= graphQuota) continue;
      if (picked.has(c.todo._id)) continue;
      if (await excluded(c.todo)) continue;
      await admit(c);
    }
    for (const c of candidates) {
      if (picked.size >= capacity) break;
      if (picked.has(c.todo._id)) continue;
      if (await excluded(c.todo)) continue;
      await admit(c);
    }

    // ── The prospecting lane (parallel with the work walk) ───────────────────
    // Real todo work has now taken its share of `capacity`; prospecting spends
    // what is LEFT, on this same tick. The guard is the leftover budget itself
    // (picked.size < capacity), so prospecting can never take a slot the walk
    // above wanted — but an unspent slot goes to prospecting rather than going
    // unused, which is the full-capacity rule. The mission it creates is an
    // ordinary autonomous session: it counts against maxLiveAutonomous on every
    // later tick, and against this tick's budget as the one pick it is.
    if (picked.size < capacity) {
      await admitProspectMission(ctx, now, liveSessions);
    }

    // Quiet when idle: the scheduler event only exists when real work was
    // admitted — no-op ticks leave no trace. A prospecting admission does not
    // pass through here: its trace is the "prospect-mission-created" event,
    // which names the session and the repo.
    if (picked.size > 0) {
      await logEvent(ctx, "auto-session-scheduler", undefined, {
        admitted: picked.size,
        counts,
        liveAutonomousBefore: liveAutonomous,
      });
    }
  },
});
