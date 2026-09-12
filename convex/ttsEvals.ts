import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { DAY_MS, modelOfTomHeadOf } from "./ttsShared";
// The key every fact about one commit is filed under has one home, in
// convex/ttsMerge.ts. Two spellings of it index two different sets of rows: a
// row written under one is invisible to a reader using the other.
import { commitKey } from "./ttsMerge";

export const PRELUDE_DELIVERY = "prelude-delivery";
export const EVALS_REQUEST = "evals-request";
export const EVALS_RUN = "evals-run";

/** A week of refused posts must not make an otherwise placeable session look
 * unplaced. The nightly check is deliberately before tonight's post. */
export const COMMIT_TIMELINE_LOOKBACK_MS = 8 * DAY_MS;
export const GOLDEN_MAX_ITEMS = 200;
export const GOLDEN_PER_VERDICT_MAX = 20;

// These reads are intentionally finite. The rows are operational input to a
// worker, never an unbounded browser list; a later pagination protocol can
// widen a limit without changing a query into a table scan.
const TIMELINE_READ_LIMIT = 2_000;
const SESSION_READ_LIMIT = 2_000;
const INBOUND_READ_LIMIT = 1_000;
const GOLDEN_RULING_READ_LIMIT = 2_000;
const BATCH_MEMBER_READ_LIMIT = 500;
const EVALS_REQUEST_SCAN_LIMIT = 500;
const EVALS_SEARCH_SCAN_LIMIT = 2_000;

export type PreludeSession = {
  id: string;
  title: string;
  kind: string;
  createdAt: number;
  had: string | null;
  expected: string;
  behindDays: number;
};

export type PreludeDeliveryFacts = {
  since: number;
  until: number;
  current: number;
  stale: PreludeSession[];
  missing: PreludeSession[];
  unplaced: number;
};

type TimelineEntry = { at: number; commit: string };

function postedCommit(row: { at: number; data?: unknown }): TimelineEntry | null {
  if (typeof row.data !== "object" || row.data === null) return null;
  const data = row.data as Record<string, unknown>;
  return typeof data.commit === "string" && data.commit !== "" && Array.isArray(data.posted) && data.posted.length > 0
    ? { at: row.at, commit: data.commit }
    : null;
}

function sameCommit(a: string, b: string): boolean {
  return a.slice(0, 12).toLowerCase() === b.slice(0, 12).toLowerCase();
}

function lastTimelineEntry(timeline: TimelineEntry[], at: number): TimelineEntry | null {
  let result: TimelineEntry | null = null;
  for (const entry of timeline) {
    if (entry.at > at) break;
    result = entry;
  }
  return result;
}

export const internalPreludeDelivery = internalQuery({
  args: { since: v.number(), until: v.number() },
  handler: async (ctx, { since, until }): Promise<PreludeDeliveryFacts> => {
    const timelineRows = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) =>
        q.eq("kind", "nightly-run").gte("at", since - COMMIT_TIMELINE_LOOKBACK_MS).lt("at", until),
      )
      .order("asc")
      .take(TIMELINE_READ_LIMIT);
    const timeline = timelineRows
      .map(postedCommit)
      .filter((entry): entry is TimelineEntry => entry !== null);
    const sessions = await ctx.db
      .query("claudeSessions")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", since).lt("_creationTime", until))
      .order("asc")
      .take(SESSION_READ_LIMIT);

    const stale: PreludeSession[] = [];
    const missing: PreludeSession[] = [];
    let current = 0;
    let unplaced = 0;

    for (const session of sessions) {
      const expectedEntry = lastTimelineEntry(timeline, session.createdAt);
      if (expectedEntry === null) {
        unplaced += 1;
        continue;
      }
      const inbound = await ctx.db
        .query("claudeInbound")
        .withIndex("by_session_status", (q) => q.eq("sessionId", session._id))
        .take(INBOUND_READ_LIMIT);
      const opener = inbound
        .filter((row) => row.kind === "user-turn" && row.author === "agent")
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (opener?.text === undefined) {
        unplaced += 1;
        continue;
      }
      const head = modelOfTomHeadOf(opener.text);
      if (head === null) {
        missing.push({
          id: session._id,
          title: session.title,
          kind: session.kind,
          createdAt: session.createdAt,
          had: null,
          expected: expectedEntry.commit,
          behindDays: 0,
        });
        continue;
      }
      if (head.commit !== null && sameCommit(head.commit, expectedEntry.commit)) {
        current += 1;
        continue;
      }
      const had = head.commit;
      const hadEntry = had === null
        ? null
        : timeline.find((entry) => sameCommit(entry.commit, had));
      stale.push({
        id: session._id,
        title: session.title,
        kind: session.kind,
        createdAt: session.createdAt,
        had: head.commit,
        expected: expectedEntry.commit,
        behindDays: hadEntry === undefined || hadEntry === null
          ? -1
          : Math.floor((expectedEntry.at - hadEntry.at) / DAY_MS),
      });
    }

    const chronological = (a: PreludeSession, b: PreludeSession) => a.createdAt - b.createdAt;
    stale.sort(chronological);
    missing.sort(chronological);
    return { since, until, current, stale: stale.slice(0, 50), missing: missing.slice(0, 50), unplaced };
  },
});

/** The newest delivery report supplies the default boundary for a rerun. */
export const internalLatestPreludeDeliveryAt = internalQuery({
  args: {},
  handler: async (ctx): Promise<number | null> => {
    const row = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", PRELUDE_DELIVERY))
      .order("desc")
      .first();
    return row?.at ?? null;
  },
});

type GoldenItemForPartition = {
  job: "prepare" | "code-brief" | "batch-plan";
  category?: string | null;
  repo?: string | null;
};

/** Job/category is the one stable grouping for golden-set selection. */
export function partitionOf(item: GoldenItemForPartition): string {
  if (item.job === "prepare") return `prepare/${item.category || "uncategorised"}`;
  if (item.job === "code-brief") return `code-brief/${item.repo || "unknown"}`;
  return "batch-plan/batch";
}

type GoldenCandidate = {
  rulingId: string;
  ruledAt: number;
  appliedAt: number | null;
  verdict: "approve" | "revise";
  sentence: string | null;
  job: "prepare" | "code-brief" | "batch-plan";
  partition: string;
  subject: Record<string, unknown>;
  resolution: Record<string, unknown>;
};

export const internalGoldenInput = internalQuery({
  args: { limitPerPartition: v.optional(v.number()) },
  handler: async (ctx, { limitPerPartition = GOLDEN_PER_VERDICT_MAX }) => {
    const perVerdict = Math.min(
      GOLDEN_PER_VERDICT_MAX,
      Math.max(1, Math.floor(Number.isFinite(limitPerPartition) ? limitPerPartition : GOLDEN_PER_VERDICT_MAX)),
    );
    const rulings = await ctx.db
      .query("dtsRulings")
      .withIndex("by_ruled", (q) => q)
      .order("desc")
      .take(GOLDEN_RULING_READ_LIMIT);
    const candidates: GoldenCandidate[] = [];

    for (const ruling of rulings) {
      if (ruling.verdict !== "approve" && ruling.verdict !== "revise") continue;
      if (ruling.subjectType === "life" && ruling.todoId !== undefined) {
        const todo = await ctx.db.get("dtsTodos", ruling.todoId);
        if (todo === null) continue;
        candidates.push({
          rulingId: ruling._id,
          ruledAt: ruling.ruledAt,
          appliedAt: ruling.appliedAt ?? null,
          verdict: ruling.verdict,
          sentence: ruling.sentence ?? null,
          job: "prepare",
          partition: partitionOf({ job: "prepare", category: todo.category }),
          subject: { type: "life", todoId: ruling.todoId },
          resolution: {
            table: "dtsTodos",
            rowId: todo._id,
            input: {
              statement: todo.statement,
              source: todo.source,
              provenance: todo.provenance ?? null,
              category: todo.category ?? null,
              createdAt: todo.createdAt,
            },
          },
        });
      } else if (
        ruling.subjectType === "code" &&
        ruling.repo !== undefined &&
        ruling.externalId !== undefined
      ) {
        const [brief, mirror] = await Promise.all([
          ctx.db.query("dtsCodeBriefs").withIndex("by_repo_external", (q) =>
            q.eq("repo", ruling.repo!).eq("externalId", ruling.externalId!),
          ).unique(),
          ctx.db.query("dtsCodeTodoMirror").withIndex("by_repo_external", (q) =>
            q.eq("repo", ruling.repo!).eq("externalId", ruling.externalId!),
          ).unique(),
        ]);
        if (brief === null || mirror === null) continue;
        candidates.push({
          rulingId: ruling._id,
          ruledAt: ruling.ruledAt,
          appliedAt: ruling.appliedAt ?? null,
          verdict: ruling.verdict,
          sentence: ruling.sentence ?? null,
          job: "code-brief",
          partition: partitionOf({ job: "code-brief", repo: ruling.repo }),
          subject: { type: "code", repo: ruling.repo, externalId: ruling.externalId },
          resolution: {
            table: "dtsCodeBriefs",
            rowId: brief._id,
            mirrorTable: "dtsCodeTodoMirror",
            mirrorRowId: mirror._id,
            input: { repo: ruling.repo, externalId: ruling.externalId, statement: mirror.statement },
          },
        });
      } else if (ruling.subjectType === "batch" && ruling.batchId !== undefined) {
        const batch = await ctx.db.get("batches", ruling.batchId);
        if (batch === null) continue;
        const members = await ctx.db
          .query("dtsTodos")
          .withIndex("by_batch", (q) => q.eq("batchId", ruling.batchId))
          .take(BATCH_MEMBER_READ_LIMIT);
        candidates.push({
          rulingId: ruling._id,
          ruledAt: ruling.ruledAt,
          appliedAt: ruling.appliedAt ?? null,
          verdict: ruling.verdict,
          sentence: ruling.sentence ?? null,
          job: "batch-plan",
          partition: partitionOf({ job: "batch-plan" }),
          subject: { type: "batch", batchId: ruling.batchId },
          resolution: {
            table: "batches",
            rowId: batch._id,
            input: { statement: batch.statement, memberStatements: members.map((member) => member.statement) },
          },
        });
      }
    }

    const grouped = new Map<string, GoldenCandidate[]>();
    for (const candidate of candidates) {
      const group = grouped.get(candidate.partition) ?? [];
      group.push(candidate);
      grouped.set(candidate.partition, group);
    }
    const partitions = [...grouped.entries()]
      .map(([partition, entries]) => {
        const selected = (verdict: "approve" | "revise") => entries
          .filter((entry) => entry.verdict === verdict)
          .sort((a, b) => b.ruledAt - a.ruledAt || a.rulingId.localeCompare(b.rulingId))
          .slice(0, perVerdict);
        return { partition, total: entries.length, entries: [...selected("approve"), ...selected("revise")] };
      })
      .sort((a, b) => b.total - a.total || a.partition.localeCompare(b.partition));
    const items: GoldenCandidate[] = [];
    for (const partition of partitions) {
      if (items.length + partition.entries.length > GOLDEN_MAX_ITEMS) continue;
      items.push(...partition.entries);
    }
    return { limitPerPartition: perVerdict, items };
  },
});

// ── The label corpus: what Tom judged, with the run he judged ────────────────
//
// internalGoldenInput above mines RULED SUBJECTS out of dtsRulings and leaves
// the output Tom read to a WikiTom snapshot on the exporter's machine. This
// reads the other corpus: convex/runLabels.ts rows, where the edge from Tom's
// act to the run that wrote the text is an exact token rather than a snapshot
// lookup, so the transcript itself can travel with the judgment.

/** The three doors a judgment comes through.
 *
 * "session-reply" IS NOT READ, and its absence is the design rather than an
 * oversight: every session-reply label is `judgment: false` by construction,
 * because a reply is not a judgment until something classifies it as one, and
 * phase 7 builds no classifier. A model's opinion of Tom's tone would be
 * putting a verdict nobody reviewed into the very corpus the golden set is
 * mined from, and a session reply is the highest-volume door of the four — a
 * classifier wrong one time in twenty poisons the set faster than the rulings
 * fill it, and nothing downstream can tell an invented verdict from one of
 * his. The `judgment === true` filter below is therefore the whole gate, and
 * the source list is what makes the gate legible. */
export const LABEL_SOURCES_READ = ["ruling", "objection", "digest-reaction"] as const;

/** The seq of a run's CONTEXT row. Every ingested run writes one, and it is
 *  what a replay needs before the span means anything. */
const LABEL_CONTEXT_SEQ = 0;

// Finite like every other read in this file. The judgment filter runs after
// the take, so the limit is on rows examined and not on items returned: a
// stretch of `session` and `archive` verdicts (labels, not judgments) must not
// be able to push the judgments out of a page.
const LABEL_READ_LIMIT = 2_000;
// A ruling, an objection and a digest reaction all carry the ONE-ROW final
// span convex/runLabels.ts writes, so this bound is never reached today. It
// exists because `rowSpan` is a pair of numbers written by a caller, and an
// unbounded range read behind a caller's arithmetic is a table scan waiting
// for the first wide span anyone writes.
const LABEL_SPAN_ROW_MAX = 50;
// Digest-sent rows carry no key (ttsDigest.lastDigestSent depends on that), so
// a reaction's day comes from one bounded newest-first take rather than a
// lookup per label — at most GOLDEN_MAX_ITEMS labels would otherwise each pay
// for their own scan. The morning goes out daily, so this is well over half a
// year of them; a reaction older than the page returns a null subjectKey and
// the exporter keys on the label's own day instead.
const DIGEST_DAY_READ_LIMIT = 250;

export type LabelItem = {
  labelId: string;
  at: number;
  source: string;
  polarity: string;
  meaning: string;
  ref: string;
  run: {
    runId: string;
    origin: string;
    kind: string;
    model: string | null;
    context: Doc<"runs">["context"] | null;
    outcome: Doc<"runs">["outcome"] | null;
  } | null;
  rows: {
    contextRow: Doc<"claudeMessages"> | null;
    spanRows: Doc<"claudeMessages">[];
  };
  link: { todoId?: string; batchId?: string; subjectKey: string | null };
};

/** The subject's identity in the one spelling convex/ttsRulings.ts subjectKey
 *  defines. Read locally rather than imported for the reason runLabels gives:
 *  ttsRulings schedules into the label writer, and this file is on the other
 *  side of that edge. */
function rulingSubjectKey(ruling: Doc<"dtsRulings">): string {
  if (ruling.subjectType === "life") return `life ${ruling.todoId}`;
  if (ruling.subjectType === "batch") return `batch ${ruling.batchId}`;
  return `code ${ruling.repo} ${ruling.externalId}`;
}

/** Each digest-sent row's Slack ts to the day it covered, in one read. The
 *  kind is spelled out rather than imported from ttsDigest, which imports this
 *  file for PRELUDE_DELIVERY and EVALS_RUN: the other direction would close
 *  the cycle. */
async function digestDayByTs(ctx: QueryCtx): Promise<Map<string, string>> {
  const rows = await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", "digest-sent"))
    .order("desc")
    .take(DIGEST_DAY_READ_LIMIT);
  const days = new Map<string, string>();
  for (const row of rows) {
    const data = (row.data ?? {}) as { slackTs?: unknown; day?: unknown };
    if (typeof data.slackTs === "string" && typeof data.day === "string" && !days.has(data.slackTs)) {
      days.set(data.slackTs, data.day);
    }
  }
  return days;
}

/**
 * What the label's act was ABOUT, from the act's own ref.
 *
 * `ref` is the idempotency key the writer chose, and it is the only edge back
 * to the act: `ruling:<id>`, `objection:<eventId>`, `reaction:<channel>:<ts>:
 * <emoji>`. Reading the subject back out of it costs one point lookup per
 * label and keeps `runLabels` free of a denormalised copy that a later edit to
 * a ruling would leave stale.
 *
 * A digest reaction has no ruling subject at all, so it is keyed on the day it
 * covered; a null answer is a supported one and the exporter keys on the
 * label's own day.
 */
async function linkOf(
  ctx: QueryCtx,
  label: Doc<"runLabels">,
  digestDays: Map<string, string>,
): Promise<{ todoId?: string; batchId?: string; subjectKey: string | null }> {
  if (label.source === "ruling") {
    const rulingId = ctx.db.normalizeId("dtsRulings", label.ref.slice("ruling:".length));
    const ruling = rulingId === null ? null : await ctx.db.get(rulingId);
    if (ruling === null) return { subjectKey: null };
    return {
      ...(ruling.todoId === undefined ? {} : { todoId: ruling.todoId }),
      ...(ruling.batchId === undefined ? {} : { batchId: ruling.batchId }),
      subjectKey: rulingSubjectKey(ruling),
    };
  }
  if (label.source === "objection") {
    // An objection's subject is the delegate decision or the merge it reverts,
    // named by its askId — the same spelling runLabels.unlinked records when
    // the act cannot be linked at all, so a corpus and an absence read alike.
    const eventId = ctx.db.normalizeId("dtsEvents", label.ref.slice("objection:".length));
    const event = eventId === null ? null : await ctx.db.get(eventId);
    if (event === null) return { subjectKey: null };
    const askId = (event.data as { askId?: unknown } | undefined)?.askId;
    return {
      ...(event.todoId === undefined ? {} : { todoId: event.todoId }),
      subjectKey: typeof askId === "string" ? askId : null,
    };
  }
  // reaction:<channel>:<ts>:<emoji> — a Slack channel id, a Slack ts and an
  // emoji base name all carry no colon, so the segments split cleanly.
  const ts = label.ref.split(":")[2] ?? "";
  const day = digestDays.get(ts);
  return { subjectKey: day === undefined ? null : `digest:${day}` };
}

/**
 * GET /tts/label-input's body: every judgment Tom made about a run's output,
 * with the run and the transcript rows the judgment covers.
 *
 * Bounded the way internalGoldenInput is bounded and for the same reason —
 * this is operational input to the exporter, never a browser list. The per-
 * source cut is GOLDEN_PER_VERDICT_MAX applied per SOURCE rather than per
 * verdict (a label's polarity is not a verdict and the doors, not the
 * polarities, are what a thin corpus is thin in), and sources are added whole
 * under GOLDEN_MAX_ITEMS so a page is never a partial door.
 *
 * A LABEL WHOSE RUN HAS BEEN EVICTED FROM THE 30-DAY WINDOW COMES BACK WITH
 * `run: null` and the exporter counts it unbuildable — exactly the posture the
 * snapshot exporter already takes for a ruling with no snapshot behind it.
 * Phase 7 does NOT fetch an evicted run back out of the store: a second
 * fetcher here would be a second mechanism to keep true about which bytes are
 * a run's, and what it would buy is small — the corpus loses only what fell
 * out of a 30-day window BETWEEN the label and the export, which a nightly
 * export makes rare. If that ever stops being rare the answer is to export
 * more often, not to grow a second reader.
 *
 * THE ROWS ARE A TRANSCRIPT'S BYTES AND THEY END UP IN A FILE ON DISK, and
 * nothing is redacted here on purpose. scripts/export-golden.mjs drops an item
 * WHOLE when redactSecrets would change it (hasCredentialShapedText), because
 * a "[redacted:…]" marker in the middle of an output is a difference the judge
 * would score and the item is worthless anyway. A second drop here would be a
 * second rule about the same bytes, and two rules about one thing is how the
 * two come to disagree. A row cut at 32 KB travels with its `overflow` pointer
 * exactly as stored: the pointer is what tells a reader the content is short,
 * and reassembling it here would be that same second mechanism again.
 */
export const internalLabelInput = internalQuery({
  args: { limitPerSource: v.optional(v.number()) },
  handler: async (ctx, { limitPerSource = GOLDEN_PER_VERDICT_MAX }): Promise<{ items: LabelItem[] }> => {
    const perSource = Math.min(
      GOLDEN_PER_VERDICT_MAX,
      Math.max(1, Math.floor(Number.isFinite(limitPerSource) ? limitPerSource : GOLDEN_PER_VERDICT_MAX)),
    );
    const bySource: Doc<"runLabels">[][] = [];
    for (const source of LABEL_SOURCES_READ) {
      const rows = await ctx.db
        .query("runLabels")
        .withIndex("by_source_at", (q) => q.eq("source", source))
        .order("desc")
        .take(LABEL_READ_LIMIT);
      bySource.push(rows.filter((row) => row.judgment === true).slice(0, perSource));
    }
    const selected: Doc<"runLabels">[] = [];
    for (const group of bySource) {
      if (selected.length + group.length > GOLDEN_MAX_ITEMS) continue;
      selected.push(...group);
    }
    const digestDays = selected.some((label) => label.source === "digest-reaction")
      ? await digestDayByTs(ctx)
      : new Map<string, string>();

    const items: LabelItem[] = [];
    for (const label of selected) {
      const run = await ctx.db
        .query("runs")
        .withIndex("by_run_id", (q) => q.eq("runId", label.runId))
        .first();
      const contextRow = await ctx.db
        .query("claudeMessages")
        .withIndex("by_run_seq", (q) => q.eq("runId", label.runId).eq("seq", LABEL_CONTEXT_SEQ))
        .first();
      // The span the judgment covers, or the one row that carried the final
      // text when the label named no span. Neither present means the run's
      // rows are gone or it never spoke, and the exporter sees an empty span
      // rather than a guess at which rows Tom meant.
      const span = label.rowSpan
        ?? (typeof run?.outcome?.finalTextSeq === "number"
          ? { seqStart: run.outcome.finalTextSeq, seqEnd: run.outcome.finalTextSeq }
          : undefined);
      const spanRows = span === undefined
        ? []
        : await ctx.db
          .query("claudeMessages")
          .withIndex("by_run_seq", (q) =>
            q.eq("runId", label.runId).gte("seq", span.seqStart).lte("seq", span.seqEnd),
          )
          .take(LABEL_SPAN_ROW_MAX);
      items.push({
        labelId: label._id,
        at: label.at,
        source: label.source,
        polarity: label.polarity,
        meaning: label.meaning,
        ref: label.ref,
        run: run === null ? null : {
          runId: run.runId,
          origin: run.origin,
          kind: run.kind,
          model: run.model ?? null,
          context: run.context ?? null,
          outcome: run.outcome ?? null,
        },
        rows: { contextRow, spanRows },
        link: await linkOf(ctx, label, digestDays),
      });
    }
    return { items };
  },
});

/**
 * One run, by the registration token it stamped on what it wrote.
 *
 * This is how the evals harness reads a trial's tokens and turns BACK FROM THE
 * RECORD rather than counting them in the harness, which is the only way the
 * two cache columns are right (worker/jobs/evals.mjs tokensOf). The harness
 * polls it with a short bounded wait after each trial because the sweeper
 * needs a moment to see the run's file, so NULL IS A NORMAL ANSWER — it means
 * "not swept yet", never an error, and a trial whose record never arrives
 * reports unknown tokens and fails nothing.
 *
 * Deliberately narrow: a token names a run, and a caller holding a token is
 * owed that run's identity and its totals, not its transcript.
 */
export const internalRunByToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const run = await ctx.db
      .query("runs")
      .withIndex("by_reg_token", (q) => q.eq("regToken", token))
      .first();
    return run === null ? null : { runId: run.runId, outcome: run.outcome ?? null };
  },
});

type EvalsRequest = {
  repo: string;
  sha: string;
  baseSha: string | null;
  pr: number | null;
  paths: string[];
  // WHAT THIS BRANCH ACTUALLY CHANGED, and the body an escape-hatch trailer
  // would be on.
  //
  // `paths` above is the WATCHED list — the same constant on every request.
  // These two are the DIFF, computed once by the pull-request check in the
  // checkout CI already has, and carried here so the box can stamp the golden
  // coverage verdict onto the run row from the same list the check judged in
  // its log. The box cannot compute them: it holds a shallow cache clone with
  // no merge base, and a list it derived itself would be a second answer to a
  // question already answered.
  //
  // NULL IS A VALUE and is never inferred. A request from an older check, or
  // from a machine whose git could not answer, carries neither; the run's
  // goldenCoverage is then null, and the merge gate denies — because a merge
  // always has a diff, so a run nobody asked has not answered.
  changed: string[] | null;
  prBody: string | null;
  requestedAt: number;
};

function requestData(data: unknown): EvalsRequest | null {
  if (typeof data !== "object" || data === null) return null;
  const value = data as Record<string, unknown>;
  return typeof value.repo === "string" && typeof value.sha === "string" &&
    Array.isArray(value.paths) && value.paths.every((path) => typeof path === "string") &&
    typeof value.requestedAt === "number"
    ? {
      repo: value.repo,
      sha: value.sha,
      baseSha: typeof value.baseSha === "string" ? value.baseSha : null,
      pr: typeof value.pr === "number" ? value.pr : null,
      paths: value.paths,
      changed: Array.isArray(value.changed) && value.changed.every((path) => typeof path === "string")
        ? (value.changed as string[])
        : null,
      prBody: typeof value.prBody === "string" ? value.prBody : null,
      requestedAt: value.requestedAt,
    }
    : null;
}

export const internalRequestEvals = internalMutation({
  args: {
    repo: v.string(),
    sha: v.string(),
    baseSha: v.optional(v.string()),
    pr: v.optional(v.number()),
    paths: v.array(v.string()),
    changed: v.optional(v.array(v.string())),
    prBody: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const key = commitKey(args.repo, args.sha);
    const existing = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", EVALS_REQUEST).eq("key", key))
      .first();
    if (existing !== null) return { existing: true };
    const requestedAt = Date.now();
    await ctx.db.insert("dtsEvents", {
      at: requestedAt,
      kind: EVALS_REQUEST,
      key,
      data: {
        repo: args.repo,
        sha: args.sha,
        baseSha: args.baseSha ?? null,
        pr: args.pr ?? null,
        paths: args.paths,
        changed: args.changed ?? null,
        // A pull-request body is text somebody else wrote, so it is stored and
        // read as DATA — the only thing anything does with it is look for one
        // anchored `evals: no-item` line.
        prBody: args.prBody ?? null,
        requestedAt,
      },
    });
    return { existing: false };
  },
});

async function runForKey(ctx: QueryCtx, key: string) {
  return await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", EVALS_RUN).eq("key", key))
    .order("desc")
    .first();
}

export const internalEvalsRun = internalQuery({
  args: { repo: v.string(), sha: v.string(), baseSha: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const run = await runForKey(ctx, commitKey(args.repo, args.sha));
    const base = args.baseSha === undefined ? null : await runForKey(ctx, commitKey(args.repo, args.baseSha));
    return { run: run?.data ?? null, base: base?.data ?? null };
  },
});

export const internalOldestEvalsRequest = internalQuery({
  args: {},
  handler: async (ctx): Promise<EvalsRequest | null> => {
    const rows = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", EVALS_REQUEST))
      .order("asc")
      .take(EVALS_REQUEST_SCAN_LIMIT);
    for (const row of rows) {
      if (row.key === undefined) continue;
      const run = await runForKey(ctx, row.key);
      if (run === null) {
        const request = requestData(row.data);
        if (request !== null) return request;
      }
    }
    return null;
  },
});

type EvalsRunData = {
  repo?: unknown;
  sha?: unknown;
  failures?: unknown;
};

export const internalSearchEvals = internalQuery({
  args: {
    repo: v.optional(v.string()),
    sha: v.optional(v.string()),
    since: v.optional(v.number()),
    failing: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(200, Math.max(1, Math.floor(args.limit ?? 20)));
    const query = ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => args.since === undefined
        ? q.eq("kind", EVALS_RUN)
        : q.eq("kind", EVALS_RUN).gte("at", args.since!),
      )
      .order("desc");
    const rows = await query.take(EVALS_SEARCH_SCAN_LIMIT);
    const runs = rows
      .map((row) => ({ id: row._id, at: row.at, data: (row.data ?? {}) as EvalsRunData }))
      .filter((row) =>
        (args.repo === undefined || row.data.repo === args.repo) &&
        (args.sha === undefined || row.data.sha === args.sha),
      );
    if (args.failing) {
      return runs.flatMap((run) => Array.isArray(run.data.failures)
        ? run.data.failures.map((failure) => ({ eventId: run.id, at: run.at, repo: run.data.repo, sha: run.data.sha, failure }))
        : [],
      ).slice(0, limit);
    }
    return runs.slice(0, limit);
  },
});
