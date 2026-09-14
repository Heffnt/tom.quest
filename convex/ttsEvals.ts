import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { DAY_MS, modelOfTomHeadOf } from "./ttsShared";

export const PRELUDE_DELIVERY = "prelude-delivery";
export const EVALS_REQUEST = "evals-request";
export const EVALS_RUN = "evals-run";

/**
 * The coverage answer an UNAFFECTED run carries.
 *
 * `true` says a watched context file changed and this branch shipped what it
 * owed. This says the question never arose — no watched path changed at all —
 * and convex/ttsMerge.ts opens the evals arm on either, in different words.
 * The distinction is kept because a gate that wrote `true` on an unscored row
 * would be a row saying something it did not check.
 *
 * ONE WORD, THREE READERS: this merge-gate constant, scripts/evals-check.mjs
 * and worker/jobs/evals.mjs unaffectedRun. The box is the only writer of an
 * unaffected row; neither of the other runtimes can import it from there.
 */
export const COVERAGE_NOT_REQUIRED = "not-required";

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
export const EVALS_REQUEST_SCAN_LIMIT = 500;
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
  // THE WORKFLOW RUN'S ID, which is GitHub's own push order: it makes one run
  // per push event, in the order the events arrive, with an increasing id.
  //
  // The queue needs that order and CANNOT take it from when the requests
  // arrived. Two pushes a minute apart start two jobs that each spend twenty
  // to forty seconds on checkout and node before filing anything, so the newer
  // push's request can reach Convex first — and a queue reading arrival order
  // would then mark the LIVE head superseded, permanently: the row it writes
  // is exactly what stops the box picking that sha up again.
  //
  // NULL IS A VALUE. A check that sends no id supersedes nothing and is
  // superseded by nothing, which is the safe answer for a request whose place
  // in the push order is unknown — an older check, or WikiTom's Action, which
  // fetches this file's sibling and runs it with its own environment.
  runId: number | null;
  paths: string[];
  // Client hints from the checkout the pull request runs. The box computes its
  // own diff and uses it for coverage; these stay only for diagnostics and the
  // no-item body text. An omitted hint has no effect on the box's decision.
  changed: string[] | null;
  prBody: string | null;
  // CI's `changed` and `unaffected` values are hints. The box recomputes the
  // diff from its own clone and imports WATCHED_PATHS from the base worktree;
  // retaining the claim only lets its eventual run record a refuted claim.
  unaffectedClaimed: boolean;
  requestedAt: number;
  // A LATER PUSH TO THE SAME PULL REQUEST already filed its own request, so
  // this sha is not the head of anything any more. The box answers a request
  // carrying this in one POST — no clone, no worktree, no model (worker/jobs/
  // evals.mjs supersededRun) — so a morning of four pushes costs one run
  // rather than four, and the check on the live head stops waiting out its
  // seventy-five minutes behind three dead ones.
  //
  // DERIVED ON EVERY READ, NEVER STORED. It is a fact about the queue as it
  // stands, not about the request as it was filed: the head of a branch moves
  // with every push, and a field written at file time would say what was true
  // then. A request that is the newest of its pull request carries null, and
  // so does one whose check sent no pull-request number.
  supersededBy: string | null;
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
      runId: typeof value.runId === "number" ? value.runId : null,
      paths: value.paths,
      changed: Array.isArray(value.changed) && value.changed.every((path) => typeof path === "string")
        ? (value.changed as string[])
        : null,
      prBody: typeof value.prBody === "string" ? value.prBody : null,
      unaffectedClaimed: value.unaffectedClaimed === true || value.unaffected === true,
      requestedAt: value.requestedAt,
      // The queue decides this, not the row; internalOldestEvalsRequest fills
      // it in on the one request it hands out.
      supersededBy: null,
    }
    : null;
}

export const internalRequestEvals = internalMutation({
  args: {
    repo: v.string(),
    sha: v.string(),
    baseSha: v.optional(v.string()),
    pr: v.optional(v.number()),
    runId: v.optional(v.number()),
    paths: v.array(v.string()),
    changed: v.optional(v.array(v.string())),
    prBody: v.optional(v.string()),
    unaffected: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const key = `${args.repo}@${args.sha}`;
    const existing = await requestRowFor(ctx, key);
    const requestedAt = Date.now();
    // A REQUEST FOR A SHA THAT ALREADY HAS ONE IS A NEW QUESTION, not a
    // duplicate of the old one. Only two things file it: a re-run of the check,
    // and a force-push that puts an earlier commit back at the head of the
    // branch. Both mean somebody is asking about this sha NOW, and the answer
    // must be built out of what they are asking with.
    //
    // Leaving the row untouched — which is what it did — dropped the newer
    // workflow run's id on the floor. A branch that returned to an earlier sha
    // kept the id it carried the first time, so headShaByPullRequest went on
    // naming the LATER sha the head, the live head stayed classified as
    // superseded, and every re-run of its check read the same permanent
    // superseded row. That head could never be scored and so never merged.
    //
    // THE WHOLE PAYLOAD IS REPLACED, not two fields of it. `baseSha`, `pr`,
    // `changed`, `prBody` and `unaffected` are all facts about the DIFF the
    // check just read, and a sha can be asked about against a different base —
    // a pull request retargeted, a rebase that moves the merge base. Keeping
    // the first request's copies would score the sha against a base nobody
    // asked about, apply an `evals: no-item` trailer off a body since edited,
    // or — worst — answer a request whose diff now touches a watched path with
    // the old request's `unaffected: true`. One payload builder for both the
    // insert and the replace, so the two spellings cannot come apart.
    //
    // `runId` IS THE ONE EXCEPTION, AND IT MOVES ONLY UPWARD. It is GitHub's
    // push order, and this takes the maximum for the same reason
    // headShaByPullRequest compares with a strict `>`: a re-run keeps its
    // original run's id, so re-running an OLD sha's check must not make that
    // sha look newest, and a request carrying no id cannot lower one that does.
    const currentRunId = existing === null ? null : requestData(existing.data)?.runId ?? null;
    const runId = args.runId !== undefined && (currentRunId === null || args.runId > currentRunId)
      ? args.runId
      : currentRunId;
    const data = {
      repo: args.repo,
      sha: args.sha,
      baseSha: args.baseSha ?? null,
      pr: args.pr ?? null,
      runId,
      paths: args.paths,
      changed: args.changed ?? null,
      // A pull-request body is text somebody else wrote, so it is stored and
      // read as DATA — the only thing anything does with it is look for one
      // anchored `evals: no-item` line.
      prBody: args.prBody ?? null,
      unaffectedClaimed: args.unaffected === true,
      // MOVES EVERY TIME, and that is what un-answers a stale row that scored
      // nothing: answeredRun below reads one written BEFORE the request
      // standing now as the answer to a question nobody is asking any more.
      requestedAt,
    };
    if (existing === null) {
      await ctx.db.insert("dtsEvents", { at: requestedAt, kind: EVALS_REQUEST, key, data });
    } else {
      // `at` MOVES WITH THE QUESTION, and it has to. It is the field
      // internalOldestEvalsRequest's index and trailing window are built on, so
      // a renewed request left at its original `at` ages out of that window and
      // becomes invisible — while the re-filing has just staled whatever
      // answered it. The sha would then be unanswered AND unservable, and its
      // check would time out on every retry: exactly the force-push-back case
      // this door exists to make work. Re-dating costs the row its old place in
      // line, which is the right trade: a question asked now belongs where it
      // was asked, and `--serve` answers everything cheap ahead of it on the
      // same tick anyway.
      await ctx.db.patch(existing._id, { at: requestedAt, data });
    }
    return { existing: existing !== null };
  },
});

// Either ctx: the door's request mutation reads this too, to answer an
// unaffected request without writing a second row over one that exists.
async function runForKey(ctx: QueryCtx | MutationCtx, key: string) {
  return await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", EVALS_RUN).eq("key", key))
    .order("desc")
    .first();
}

async function requestRowFor(ctx: QueryCtx | MutationCtx, key: string) {
  return await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", EVALS_REQUEST).eq("key", key))
    .first();
}

/**
 * A ROW IS NOT A RUN. Three kinds of evals-run row score nothing and are
 * written in a POST each: a branch that touched no watched path
 * (`unaffected`), a head a later push replaced (`superseded`), and a sha the
 * box could not fetch or check out (`error`).
 *
 * ONE SPELLING, read by both the readers that care. convex/ttsWeekly.ts skips
 * these three when it counts the week's runs — counted, they said they were
 * runs the week did, that they were CLEAN runs, and, being the newest rows,
 * their empty arrays replaced the real measurement. answeredRun below asks the
 * same question for a different reason. A second copy of the list is how the
 * two come apart the next time a fourth kind is added.
 */
export function scoredNothing(data: unknown): boolean {
  const d = (data ?? {}) as Record<string, unknown>;
  return d.unaffected === true || d.superseded === true || d.error === true ||
    (typeof d.error === "string" && d.error !== "");
}

/**
 * The newest evals-run row that ANSWERS THE REQUEST STANDING NOW, or null.
 *
 * A ROW THAT SCORED NOTHING IS NOT A VERDICT ON THE COMMIT. A scored row is a
 * measurement of the tree: it ran the set and got numbers. A stamped row names
 * the request it measured exactly. The three
 * rows scoredNothing names are answers to A PARTICULAR REQUEST instead —
 * `superseded` says a later push had already replaced this head when the queue
 * looked, `unaffected` says the diff THAT REQUEST CARRIED touched no watched
 * path, and an `error` row says the tree could not be read that time. All
 * three are facts about a moment, not about a commit.
 *
 * It is the same shape convex/ttsMerge.ts gives an UNAVAILABLE audit — the
 * ABSENCE of an answer rather than an answer — and it needs the same escape.
 * Write-once over it meant a branch force-pushed back to an earlier sha could
 * never be scored: the superseded row from the first time round was permanent,
 * so the queue skipped the request as answered, the box's `already scored`
 * short-circuit refused to run it, and the check read the stale row and failed
 * on every re-run. A valid head was left unmergeable with nothing able to fix
 * it. The `unaffected` row is the same hole pointing the other way and it OPENS
 * the gate: ask about a sha against one base, get `no watched path changed`,
 * then ask about the same sha against a base whose diff DOES touch one, and a
 * stale row would answer `unaffected` to a question it never heard.
 *
 * What this deliberately does NOT do is make a row disappear for a sha nothing
 * is asking about again. Nobody re-files that request, so its `requestedAt`
 * stays where it was, the row stands, and the check on it still reads
 * `superseded by <sha>, re-run at head` on its first poll. A re-run of a
 * genuinely superseded sha's check re-files and is handed out again — and the
 * queue answers it superseded a second time, in one POST and no model, because
 * the head map has not moved either.
 *
 * The stale row is NEVER deleted. It stays in the event log, exactly as the
 * UNAVAILABLE audit row does, so the record still says the queue passed this
 * sha over once; the newest row is simply the one every reader takes.
 */
async function answeredRun(ctx: QueryCtx | MutationCtx, key: string) {
  const run = await runForKey(ctx, key);
  if (run === null) return null;
  const request = requestData((await requestRowFor(ctx, key))?.data);
  // No request row at all: nothing is asking anything, so the row stands.
  if (request === null) return run;
  // Every row answers a standing request only by its exact stamp. An unstamped
  // legacy row cannot establish which request it answered, so it remains
  // historical until no request stands.
  const answers = (run.data as { answersRequestAt?: unknown }).answersRequestAt;
  return typeof answers === "number" && answers === request.requestedAt ? run : null;
}

/**
 * The gate's own read of the evals row, through the same staleness rule.
 *
 * convex/ttsMerge.ts read the newest row directly, which is the one place where
 * reading a stale one OPENS something rather than merely delaying it: a former
 * `unaffected` row left standing for a sha since re-asked against a base whose
 * diff DOES touch a watched path would answer the gate `no watched path
 * changed`. Every other reader goes through answeredRun; the gate is the reader
 * it mattered most for, and it was the one that did not.
 */
export async function answeredEvalsRun(ctx: QueryCtx | MutationCtx, repo: string, sha: string) {
  return await answeredRun(ctx, `${repo}@${sha}`);
}

/** The request currently standing for a sha, if there is one. Readers that
 *  must distinguish historical rows from a run still being served use this
 *  alongside answeredEvalsRun. */
export async function evalsRequestFor(ctx: QueryCtx | MutationCtx, repo: string, sha: string) {
  return requestData((await requestRowFor(ctx, `${repo}@${sha}`))?.data);
}

export const internalEvalsRun = internalQuery({
  args: { repo: v.string(), sha: v.string(), baseSha: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const run = await answeredRun(ctx, `${args.repo}@${args.sha}`);
    const base = args.baseSha === undefined ? null : await answeredRun(ctx, `${args.repo}@${args.baseSha}`);
    // The requested head remains visible so CI can report a box failure. A
    // base is comparison evidence, though, and a nonmeasurement cannot seed it.
    return { run: run?.data ?? null, base: base === null || scoredNothing(base.data) ? null : base.data };
  },
});

// The worker revalidates a request by this same identity just before a long
// scored run posts. Returning the stored request, rather than the queue head,
// lets another PR's request be served independently without masking a replace
// of this sha's own question.
export const internalEvalsRequest = internalQuery({
  args: { repo: v.string(), sha: v.string() },
  handler: async (ctx, args) => await evalsRequestFor(ctx, args.repo, args.sha),
});

/**
 * The head of each pull request, off the rows already read.
 *
 * The key is the repo and the pull-request number, because that is what "the
 * same branch" means to everything downstream: the check sends the number, a
 * branch has one open pull request, and a sha belongs to one head.
 *
 * ORDERED BY `runId`, NEVER BY ARRIVAL. The workflow run's id is GitHub's own
 * push order (see the field's comment above); the order the requests reached
 * Convex is the order two CI jobs happened to finish their checkout in, and
 * two pushes a minute apart can arrive the wrong way round. Reading arrival
 * order would let the LIVE head be marked superseded, and that mistake does
 * not heal: the row written for it is exactly what stops the box picking that
 * sha up again, so the pull request's check fails at every re-run with nothing
 * able to score it.
 *
 * A request with NO id is in the map for nothing — it supersedes nothing and
 * nothing supersedes it. That is the safe answer for a request whose place in
 * the push order is unknown, and it is what every request filed before this
 * field existed carries.
 *
 * NO SECOND READ. The rows are the queue scan's own window; a read of its own
 * would double what this query costs on every five-minute poll, and these rows
 * carry a pull-request body each. A pull request whose newest request falls
 * outside the window names an older sha as its head, which only makes the
 * sha the log points at less useful — the request being answered is superseded
 * either way.
 */
function headShaByPullRequest(rows: Doc<"dtsEvents">[]): Map<string, { sha: string; runId: number }> {
  const head = new Map<string, { sha: string; runId: number }>();
  for (const row of rows) {
    const request = requestData(row.data);
    if (request === null || request.pr === null || request.runId === null) continue;
    const key = `${request.repo}#${request.pr}`;
    const seen = head.get(key);
    if (seen === undefined || request.runId > seen.runId) {
      head.set(key, { sha: request.sha, runId: request.runId });
    }
  }
  return head;
}

export const internalOldestEvalsRequest = internalQuery({
  args: {},
  handler: async (ctx): Promise<EvalsRequest | null> => {
    // THE WINDOW IS THE MOST RECENT REQUESTS, NOT THE FIRST ONES EVER FILED.
    //
    // This read `.order("asc")`, which takes the OLDEST rows in the table — and
    // request rows are never deleted. Every one of the first five hundred is
    // long since answered, so once the table passed that mark the query would
    // find no unanswered request in its window and return null forever: every
    // new head's check would wait out its seventy-five minutes and fail, with
    // nothing able to score anything again. The queue would be dead, silently,
    // and no row would say why.
    //
    // It was survivable while `.github/workflows/evals.yml` carried a `paths:`
    // filter and requests were rare. This branch deleted that filter so the
    // check runs on EVERY pull request and files a request for every head, so
    // the branch that made the bug reachable is the one that has to fix it.
    //
    // Read from the newest end and reversed, the window is a TRAILING one: the
    // hand-out order inside it is still oldest-first, and the head map below is
    // still computed off the same rows with no second read. What falls out of a
    // trailing window is an unanswered request older than five hundred newer
    // ones — a head whose check gave up long ago, which is the right thing to
    // drop, and the opposite of dropping every head from now on.
    const recent = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", EVALS_REQUEST))
      .order("desc")
      .take(EVALS_REQUEST_SCAN_LIMIT);
    const rows = recent.reverse();
    // WHAT EACH PULL REQUEST'S HEAD IS, off the same window. A morning of four
    // pushes to one branch files four requests, and the box serves one per
    // pass at about thirty-five minutes: the check on the fourth waits out
    // three runs of shas nobody will merge and then fails on its own deadline.
    // Three of those four are answered in a POST each instead.
    const heads = headShaByPullRequest(rows);
    for (const row of rows) {
      if (row.key === undefined) continue;
      // A STALE SUPERSEDED ROW DOES NOT ANSWER THIS REQUEST (answeredRun): a
      // sha the branch has come back to is handed out again and scored for
      // real, rather than skipped forever as already answered.
      const run = await answeredRun(ctx, row.key);
      if (run === null) {
        const request = requestData(row.data);
        if (request === null) continue;
        // THE OLDEST UNANSWERED REQUEST IS STILL THE ONE HANDED OUT, superseded
        // or not. The order does not change; what changes is that a superseded
        // one is answered without a run, so the queue behind it advances on the
        // same pass rather than on the next cron tick (worker/jobs/evals.mjs
        // --serve keeps going while the answer cost no model).
        //
        // A request with no `runId` has no place in the push order, so it is
        // never superseded: `head` is undefined for it, and the strict `>` on
        // the run ids is what decides every other case.
        const head = request.pr === null || request.runId === null
          ? undefined
          : heads.get(`${request.repo}#${request.pr}`);
        return head === undefined || head.runId <= request.runId!
          ? request
          : { ...request, supersededBy: head.sha };
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
