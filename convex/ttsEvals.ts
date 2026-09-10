import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { DAY_MS, modelOfTomHeadOf } from "./ttsShared";

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

type EvalsRequest = {
  repo: string;
  sha: string;
  baseSha: string | null;
  pr: number | null;
  paths: string[];
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
  },
  handler: async (ctx, args) => {
    const key = `${args.repo}@${args.sha}`;
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
      data: { repo: args.repo, sha: args.sha, baseSha: args.baseSha ?? null, pr: args.pr ?? null, paths: args.paths, requestedAt },
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
    const run = await runForKey(ctx, `${args.repo}@${args.sha}`);
    const base = args.baseSha === undefined ? null : await runForKey(ctx, `${args.repo}@${args.baseSha}`);
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
