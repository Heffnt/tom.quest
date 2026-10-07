// The nightly job's server half (the lifeos update, phase 4). The job itself
// is worker/jobs/nightly.mjs on the Jarvis Box; it reaches Convex only over
// the TTS_WORKER_KEY routes in convex/http.ts, and these are the reads and
// writes it needs that nothing else provided:
//
//   GET  /tts/learning-input what the learning step reads: the turns Tom
//                            typed since the last learning run with the
//                            agent's replies around them, his rulings, and
//                            the objections not yet applied
//   POST /tts/event          one dtsEvents row — how the job records a
//                            failed step, its learning run, each change it
//                            made, each reversal, and its summary
//   POST /tts/learning-objections-consumed
//                            stamps the objections the job has acted on, so
//                            the next night does not act on them again
//
// The post of the model-of-tom files lives with the store (ttsSkills.ts).

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { clip } from "../shared/clip.mjs";
import { rowSource, type RowSource } from "./sessionRows";
// The kinds this pen routes onward besides LEARNING_CHANGE. Their rows,
// their fields and the reasoning are documented where they are declared.
import { BOX_CHANGE, boxChangeEvent, boxChangeFaults, type BoxChange } from "./boxChanges";
import { copyDtsRow, recordEvent } from "./jarvis/events";

// ── The learning input ───────────────────────────────────────────────────────
// The learning step reads what Tom did: the turns he typed in sessions
// (claudeInbound rows authored "tom"), the agent's reply on either
// side of each (what he was answering and what came of it — the context his
// words are read in, never a source of lines on their own), his threaded
// rulings — never the spec (design section 4, "Learning").
//
// THE WINDOW starts where the last learning run's ended: `since` is optional
// and defaults to the `until` of the newest "learning-run" row, so a night
// the job did not run is read the next night rather than dropped; with no
// run on record it is the day before. The reply says which (`sinceSource`).
//
// The cap is on what is RETURNED, never on what is looked at: a read that
// takes N rows and filters them afterwards drops what it was looking for as
// soon as the window holds more than N rows of anything else — and the
// agents' turns and the instrumentation events outnumber Tom's by far. Each
// read below either pins the value in an index or examines the whole window.
export const LEARNING_INPUT_MAX = 2000;
// The agent's replies are looked up per turn, two reads each pinned on the
// session and the kind, for at most this many turns; past it a turn goes out
// without them. A reply is clipped to LEARNING_REPLY_CHARS — it is context,
// and one assistant-text row can be a 32KB essay.
export const LEARNING_REPLY_TURNS = 300;
export const LEARNING_REPLY_CHARS = 1500;
// The objections not yet acted on, and the changes an objection can name:
// the newest of each, more than a week of nights.
export const LEARNING_OBJECTIONS_MAX = 200;
export const LEARNING_CHANGES_MAX = 500;
// The repo-learning step's input: the sessions that ENDED in the window with
// an outcome. The read is per status on by_status rather than a filtered scan,
// so the cap falls on ended sessions and not on a window whose running ones
// outnumber them.
export const LEARNING_REPO_SESSIONS_MAX = 40;
// The proposals dedupe looks back over, and the ones a night reconciles.
const REPO_PROPOSALS_MAX = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The agent's reply as the job shows it: clip() from shared/clip.mjs,
 * the one clipping rule the jobs use, at LEARNING_REPLY_CHARS. */
function clipReply(text: unknown): string | null {
  return clip(text, LEARNING_REPLY_CHARS);
}

export const internalLearningInput = internalQuery({
  args: { since: v.optional(v.number()), until: v.number() },
  handler: async (ctx, { since: givenSince, until }) => {
    let since: number;
    let sinceSource: "given" | "learning-run" | "default";
    if (givenSince !== undefined) {
      since = givenSince;
      sinceSource = "given";
    } else {
      const last = await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_at", (q) => q.eq("kind", "learning-run"))
        .order("desc")
        .first();
      const lastUntil = (last?.data as { until?: unknown } | undefined)?.until;
      if (typeof lastUntil === "number" && lastUntil < until) {
        since = lastUntil;
        sinceSource = "learning-run";
      } else {
        since = until - DAY_MS;
        sinceSource = "default";
      }
    }
    // by_author, so the window is Tom's rows — not the first N rows of
    // everyone's, most of which are an agent's.
    const inbound = await ctx.db
      .query("claudeInbound")
      .withIndex("by_author", (q) =>
        q.eq("author", "tom").gte("_creationTime", since).lt("_creationTime", until),
      )
      .take(LEARNING_INPUT_MAX);
    const tomTurns = [];
    // Per session, read once: the title, the SDK session id — the id the
    // pages cite a session by (its first 8 hex characters; WikiTom's
    // sessions/ archive is keyed by the whole of it), which the session host
    // stores on the row as sdkSessionId once the SDK reports it — and where
    // its rows come from (convex/sessionRows.ts rowSource).
    const sessions = new Map<
      string,
      { title: string; sdkSessionId: string | null; source: RowSource; therapy: boolean }
    >();
    let repliesLookedUp = 0;
    for (const row of inbound) {
      if (row.kind !== "user-turn") continue;
      let session = sessions.get(row.sessionId);
      if (session === undefined) {
        const s = await ctx.db.get(row.sessionId);
        session = {
          title: s?.title ?? "",
          sdkSessionId: s?.sdkSessionId ?? null,
          source: s === null ? { from: "none" } : rowSource(s),
          therapy: s?.kind === "therapy",
        };
        sessions.set(row.sessionId, session);
      }
      // A therapy session's turns never reach the learning step (Tom's ruling
      // 2026-09-25): the session owns the mental-health page itself.
      if (session.therapy) continue;
      // The agent's text just before the turn and just after it. The index
      // pins the run and the kind; the filter walks the rows on one side of
      // the turn's instant and stops at the first. A session's rows are its
      // agent file's, by runId.
      let replyBefore: string | null = null;
      let replyAfter: string | null = null;
      const source = session.source;
      if (repliesLookedUp < LEARNING_REPLY_TURNS && source.from === "run") {
        repliesLookedUp += 1;
        const assistantText = () =>
          ctx.db
            .query("claudeMessages")
            .withIndex("by_run_kind", (q) =>
              q.eq("runId", source.runId).eq("kind", "assistant-text"),
            );
        const before = await assistantText()
          .order("desc")
          .filter((q) => q.lte(q.field("createdAt"), row.createdAt))
          .first();
        const after = await assistantText()
          .order("asc")
          .filter((q) => q.gt(q.field("createdAt"), row.createdAt))
          .first();
        replyBefore = clipReply((before?.content as { text?: unknown } | undefined)?.text);
        replyAfter = clipReply((after?.content as { text?: unknown } | undefined)?.text);
      }
      tomTurns.push({
        id: row._id,
        sessionId: row.sessionId,
        sdkSessionId: session.sdkSessionId,
        sessionTitle: session.title,
        text: row.text ?? "",
        at: row.createdAt,
        replyBefore,
        replyAfter,
      });
    }
    const rulings = (
      await ctx.db
        .query("rulings")
        .withIndex("by_ruled", (q) => q.gte("ruledAt", since).lt("ruledAt", until))
        // A delegate ruling is the delegate's reading of Tom, not his words:
        // learning from it would teach the model of Tom its own guesses. Left
        // out before the cap, so it never takes a place one of his would.
        .filter((q) => q.neq(q.field("ruledBy"), "delegate"))
        .take(LEARNING_INPUT_MAX)
    )
      .map((r) => ({
      id: r._id,
      at: r.ruledAt,
      verdict: r.verdict,
      subjectType: r.subjectType,
      todoId: r.todoId,
      repo: r.repo,
      externalId: r.externalId,
      sentence: r.sentence,
      quote: r.provenance?.quote,
    }));
    // The objections Tom has raised that no night has acted on yet (an
    // objection is consumed once, whichever way it went), oldest first, and
    // the changes an objection can name — by the change's id or by the
    // line's text; the job does the matching. The reverts ride along under
    // `changes` too, each row saying which kind it is (`eventKind`): both
    // kinds carry the body blob the page was left with (`resultBlob`), and
    // the job reverts only a page whose body still hashes to the newest.
    const objections = (
      await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_at", (q) => q.eq("kind", "learning-objection"))
        .order("desc")
        .take(LEARNING_OBJECTIONS_MAX)
    )
      .filter((e) => e.consumedAt === undefined)
      .reverse()
      .map((e) => {
        const d = (e.data ?? {}) as { id?: unknown; text?: unknown };
        return {
          eventId: e._id,
          at: e.at,
          id: typeof d.id === "string" ? d.id : null,
          text: typeof d.text === "string" ? d.text : "",
        };
      });
    const recorded = async (kind: "learning-change" | "learning-reverted") =>
      await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_at", (q) => q.eq("kind", kind))
        .order("desc")
        .take(LEARNING_CHANGES_MAX);
    const changes = [...(await recorded("learning-change")), ...(await recorded("learning-reverted"))]
      .sort((a, b) => b.at - a.at)
      .slice(0, LEARNING_CHANGES_MAX)
      .map((e) => ({
        eventId: e._id,
        eventKind: e.kind,
        at: e.at,
        ...((e.data ?? {}) as Record<string, unknown>),
      }));
    // ── The repo-learning step's input ───────────────────────────────────────
    // The sessions that ENDED in the window with an outcome. by_status is
    // ["status", "statusChangedAt"], so the range read is per status: one read
    // per terminal status rather than a filtered scan whose cap would fall on
    // the sessions still running. A session in no repository ("none") teaches
    // nothing about a rule file and is dropped here, and so is a therapy
    // session, by its kind (Tom's ruling 2026-09-25): insertSession already
    // refuses one with a repo, and this names the exclusion where it is read.
    const ended = (
      await Promise.all(
        (["ended", "failed"] as const).map((status) =>
          ctx.db
            .query("claudeSessions")
            .withIndex("by_status", (q) =>
              q.eq("status", status).gte("statusChangedAt", since).lt("statusChangedAt", until),
            )
            .take(LEARNING_REPO_SESSIONS_MAX * 2),
        ),
      )
    ).flat();
    const repoSessions = ended
      .filter((s) => s.outcome !== undefined && s.repo !== "none" && s.kind !== "therapy")
      .sort((a, b) => b.statusChangedAt - a.statusChangedAt)
      .slice(0, LEARNING_REPO_SESSIONS_MAX)
      .map((s) => ({
        id: s._id,
        sdkSessionId: s.sdkSessionId ?? null,
        title: s.title,
        repos: s.repos ?? [s.repo],
        repo: s.repo,
        cwd: s.cwd ?? null,
        model: s.model ?? "opus",
        mode: s.mode ?? "interactive",
        outcome: s.outcome,
        outcomeSummary: s.outcomeSummary ?? null,
        endedReason: s.endedReason ?? null,
        at: s.statusChangedAt,
      }));
    // What the step dedupes against and what it reconciles: every proposal
    // still on record, and the ones whose status moved since the last run.
    // The rows carry their own status, so one read serves all three uses.
    const proposalRows = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", "repo-proposal"))
      .order("desc")
      .take(REPO_PROPOSALS_MAX);
    const proposalData = proposalRows.map((e) => ({
      eventId: e._id,
      at: e.at,
      ...((e.data ?? {}) as Record<string, unknown>),
    }));
    const sinceLastRun = (kind: string) => (r: { at: number; kind: string }) =>
      r.kind === kind && r.at >= since && r.at < until;
    const moved = await ctx.db
      .query("dtsEvents")
      .withIndex("by_at", (q) => q.gte("at", since).lt("at", until))
      .take(LEARNING_INPUT_MAX);
    const repoProposalsApplied = moved
      .filter(sinceLastRun("repo-proposal-applied"))
      .map((e) => ({ ...((e.data ?? {}) as Record<string, unknown>) }));
    const repoProposalsDropped = moved
      .filter(sinceLastRun("repo-proposal-dropped"))
      .map((e) => ({ ...((e.data ?? {}) as Record<string, unknown>) }));
    return {
      since,
      sinceSource,
      until,
      tomTurns,
      rulings,
      objections,
      changes,
      repoSessions,
      repoProposals: proposalData,
      repoProposalsApplied,
      repoProposalsDropped,
    };
  },
});

// ── Repository-rule proposals ────────────────────────────────────────────────
// The nightly repo-learning step proposes a line for a repository's nested
// AGENTS.md. The line lands in that repository, through its own checks, when a
// session working there applies it — so the row here is the OPEN LIST a
// session reads and the record of what became of each one.

/** How many open proposals one repository's read returns. */
export const OPEN_REPO_PROPOSALS_MAX = 50;

/** The open proposals for one repository, newest first. What a session
 * working in `<repo>` reads before it edits that repository's rule files. */
export const internalOpenRepoProposals = internalQuery({
  args: { repo: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, { repo, limit }) => {
    const rows = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", "repo-proposal"))
      .order("desc")
      .take(OPEN_REPO_PROPOSALS_MAX * 4);
    const cap = Math.max(1, Math.min(OPEN_REPO_PROPOSALS_MAX, Math.floor(limit ?? OPEN_REPO_PROPOSALS_MAX)));
    return {
      // `at` rides along with the row's own fields: a proposal carries no date
      // of its own, and a reader — the session about to apply it, tts-search
      // proposals — needs to know how old the night that proposed it was.
      proposals: rows
        .map((e) => ({ at: e.at, ...(e.data ?? {}) }) as Record<string, unknown>)
        .filter((d) => d.status === "open" && (repo === undefined || d.repo === repo))
        .slice(0, cap),
    };
  },
});

/**
 * A session applied a proposal in its repository. The row's status becomes
 * "applied", the commit and the FINAL wording are stamped on it — the review
 * may have changed the words, and the next night's reconcile rewrites the
 * evidence entry to what actually merged — and a "repo-proposal-applied" event
 * carries it to the record.
 *
 * An id that names no open proposal is reported rather than thrown: a session
 * that applied a line twice, or named a proposal Tom had already dropped, is
 * not a failed night.
 */
export const internalApplyRepoProposal = internalMutation({
  args: { id: v.string(), commit: v.string(), line: v.optional(v.string()) },
  handler: async (ctx, { id, commit, line }) => {
    const rows = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", "repo-proposal").eq("key", id))
      .take(2);
    const row = rows[0];
    if (row === undefined) return { applied: false, reason: `no repository-rule proposal ${id}` };
    const data = (row.data ?? {}) as Record<string, unknown>;
    if (data.status === "applied") return { applied: false, reason: `proposal ${id} is already applied` };
    const appliedLine = typeof line === "string" && line.trim() !== "" ? line.trim() : (data.line as string);
    await ctx.db.patch(row._id, {
      data: { ...data, status: "applied", commit, appliedLine },
    });
    const at = Date.now();
    const appliedData = {
      id,
      repo: data.repo,
      file: data.file,
      section: data.section,
      line: data.line,
      appliedLine,
      commit,
    };
    await ctx.db.insert("dtsEvents", { at, kind: "repo-proposal-applied", key: id, data: appliedData });
    // The Jarvis thread reads agent changes from the events table: this
    // applied proposal and its dtsEvents row are one fact, so the copy rides
    // in this transaction.
    await copyDtsRow(ctx, { at, kind: "repo-proposal-applied", key: id, data: appliedData });
    return { applied: true, repo: data.repo, file: data.file };
  },
});

/**
 * Tom objected to a proposal. The row's status becomes "dropped" and a
 * "repo-proposal-dropped" event carries it to the record and to the next
 * night's repo-learning step, which writes `dropped:` on the
 * evidence entry — the record then says the rule was proposed and why it is
 * not a rule, which is what stops the next night proposing it again.
 */
export const internalDropRepoProposal = internalMutation({
  args: { id: v.string(), reply: v.optional(v.string()) },
  handler: async (ctx, { id, reply }) => {
    const rows = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", "repo-proposal").eq("key", id))
      .take(2);
    const row = rows[0];
    if (row === undefined) return { dropped: false, reason: `no repository-rule proposal ${id}` };
    const data = (row.data ?? {}) as Record<string, unknown>;
    if (data.status === "dropped") return { dropped: false, reason: `proposal ${id} is already dropped` };
    await ctx.db.patch(row._id, { data: { ...data, status: "dropped" } });
    await ctx.db.insert("dtsEvents", {
      at: Date.now(),
      kind: "repo-proposal-dropped",
      key: id,
      data: {
        id,
        repo: data.repo,
        file: data.file,
        section: data.section,
        line: data.line,
        reply: clip(reply, 200) ?? "",
        reason: "your objection",
      },
    });
    return { dropped: true, repo: data.repo, file: data.file };
  },
});

/** Stamp the objections the job has acted on, whichever way it went. An id
 * that is not an unconsumed "learning-objection" row is skipped rather than
 * an error: the list came from the read above, and a stale id costs nothing. */
export const internalConsumeLearningObjections = internalMutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const now = Date.now();
    let consumed = 0;
    for (const raw of ids) {
      const id = ctx.db.normalizeId("dtsEvents", raw);
      if (id === null) continue;
      const row = await ctx.db.get(id);
      if (!row || row.kind !== "learning-objection" || row.consumedAt !== undefined) continue;
      await ctx.db.patch(id, { consumedAt: now });
      consumed += 1;
    }
    return { consumed };
  },
});

// ── The event pen ────────────────────────────────────────────────────────────
// The job's kinds are its own ("nightly-failure", "learning-run",
// "learning-change", "learning-reverted", "learning-revert-failed",
// "nightly-run", both the night's summary and, keyed `WikiTom@<sha>`, each
// commit it is about to push, which the merge gate reads: convex/ttsMerge.ts
// NIGHTLY_RUN); the pattern keeps the pen to lowercase kebab-case names.
export const EVENT_KIND_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/** Kinds written by the nightly job. */
export const LEARNING_CHANGE = "learning-change";

/**
 * A box change posted through the legacy pen (POST /tts/event, body { kind:
 * "box-change", data, key }), recorded as the `events` row POST /jarvis/event
 * would write (convex/boxChanges.ts boxChangeEvent), hook and all. The pen's
 * `key` was the agentId; it must still agree with data.agentId. Here only
 * while a box that has not deployed Jarvis night/w4 still posts box changes
 * through the pen; goes with the pen.
 */
export const internalRecordBoxChange = internalMutation({
  args: { data: v.any(), key: v.optional(v.string()) },
  handler: async (ctx, { data, key }) => {
    const faults = boxChangeFaults(data);
    if (faults.length > 0) throw new Error(`not a box change: ${faults.join("; ")}`);
    const change = data as BoxChange;
    if (key !== change.agentId) throw new Error("a box change's key is its agentId, and it has none when the agentId is absent");
    const { id, result } = await recordEvent(ctx, boxChangeEvent(change));
    return { id: id as string, duplicate: (result as { duplicate?: boolean } | undefined)?.duplicate === true };
  },
});

export const internalRecordWorkerEvent = internalMutation({
  // `key`: the indexed lookup key (schema dtsEvents.key) — the weekly job's
  // "weekly-run" row carries its day, so a rerun finds it on by_kind_key.
  args: { kind: v.string(), data: v.optional(v.any()), key: v.optional(v.string()) },
  handler: async (ctx, { kind, data, key }) => {
    if (!EVENT_KIND_PATTERN.test(kind)) {
      throw new Error(`not a worker event kind: ${kind}`);
    }
    // A box change is a row of the record's events table, not of this one
    // (internalRecordBoxChange below; POST /tts/event hands it there).
    if (kind === BOX_CHANGE) throw new Error("a box change is recorded through POST /jarvis/event");
    const row = { at: Date.now(), kind, data, key };
    const id = await ctx.db.insert("dtsEvents", row);
    // The same row in the one record, in this transaction (jarvis/events.ts
    // copyDtsRow): a second mutation could fail or be retried after the first
    // committed, leaving one table without the row or the other with two.
    await copyDtsRow(ctx, row);
    return id;
  },
});
