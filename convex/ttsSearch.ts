import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { redactSecrets } from "../worker/session-host/redact.mjs";

// Search reads historical prose that may have been stored before ingest grew
// its redaction choke point. This is deliberately the exact same pure helper
// used by worker/session-host, never a copied list of credential patterns.
const FIELD_EXCERPT_CHARS = 160;
const TEXT_EXCERPT_CHARS = 240;
const REPO_EXCERPT_CHARS = 64;
const MAX_RETURNED_REPOS = 6;

function normalized(text: string): string {
  return text.trim().toLowerCase();
}

function includesQuery(text: string, query: string): boolean {
  return normalized(text).includes(query);
}

// Query against the whole redacted value, then return only a small window.
// At 200 rows these caps keep even the ruling projection comfortably below
// Convex's response limit, including worst-case four-byte Unicode text.
function excerpt(text: string, query: string, maxChars = FIELD_EXCERPT_CHARS): string {
  if (text.length <= maxChars) return text;
  const foundAt = query === "" ? -1 : normalized(text).indexOf(query);
  if (foundAt < 0) return `${text.slice(0, maxChars - 1)}…`;
  const bodyChars = maxChars - 2;
  let start = Math.max(0, foundAt - Math.floor(bodyChars / 3));
  const end = Math.min(text.length, start + bodyChars);
  start = Math.max(0, end - bodyChars);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

// Search is a recent-record tool, not a table export. The extra candidates
// leave room for a selective text query without an unbounded scan.
function searchLimits(limit: number): { limit: number; candidateBudget: number } {
  const safe = Number.isFinite(limit) ? Math.floor(limit) : 1;
  const bounded = Math.min(200, Math.max(1, safe));
  return { limit: bounded, candidateBudget: Math.min(1_600, Math.max(24, bounded * 8)) };
}

function appendFlattenedText(value: unknown, parts: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    parts.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) appendFlattenedText(item, parts);
  } else if (typeof value === "object") {
    for (const item of Object.values(value)) appendFlattenedText(item, parts);
  }
}

function flattenedText(value: unknown): string {
  const parts: string[] = [];
  appendFlattenedText(value, parts);
  return parts.join(" ");
}

const todoStatuses = ["active", "waiting", "archived", "done"] as const;
type TodoStatus = (typeof todoStatuses)[number];

function isTodoStatus(value: string): value is TodoStatus {
  return (todoStatuses as readonly string[]).includes(value);
}

export const rulings = internalQuery({
  args: { query: v.string(), limit: v.number(), since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const query = normalized(args.query);
    if (query === "") return [];
    const { limit, candidateBudget } = searchLimits(args.limit);
    const candidates = args.since === undefined
      ? await ctx.db
          .query("dtsRulings")
          .withIndex("by_ruled")
          .order("desc")
          .take(candidateBudget)
      : await ctx.db
          .query("dtsRulings")
          .withIndex("by_ruled", (q) => q.gte("ruledAt", args.since!))
          .order("desc")
          .take(candidateBudget);
    const results = [];
    for (const ruling of candidates) {
      const todo = ruling.todoId ? await ctx.db.get(ruling.todoId) : null;
      const sentenceSource = ruling.sentence ? redactSecrets(ruling.sentence) : null;
      const todoSource = todo ? redactSecrets(todo.statement) : null;
      const sentence = sentenceSource ? excerpt(sentenceSource, query) : null;
      const todoStatement = todoSource ? excerpt(todoSource, query) : null;
      if (!includesQuery([sentenceSource, todoSource].filter(Boolean).join(" "), query)) continue;
      results.push({
        id: ruling._id,
        subjectType: ruling.subjectType,
        verdict: ruling.verdict,
        sentence,
        provenance: ruling.provenance
          ? {
              from: ruling.provenance.from,
              inboundId: excerpt(redactSecrets(ruling.provenance.inboundId), query),
              quote: excerpt(redactSecrets(ruling.provenance.quote), query),
            }
          : null,
        date: ruling.ruledAt,
        todoStatement,
      });
      if (results.length === limit) break;
    }
    return results;
  },
});

export const sessions = internalQuery({
  args: {
    query: v.string(),
    limit: v.number(),
    repo: v.optional(v.string()),
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const query = normalized(args.query);
    const repo = args.repo === undefined ? undefined : normalized(args.repo);
    const { limit, candidateBudget } = searchLimits(args.limit);
    const candidates = await ctx.db.query("claudeSessions").order("desc").take(candidateBudget);
    const results = [];
    for (const session of candidates) {
      // An explicitly empty repos array means no checkout; do not fall back to
      // the legacy string in that case.
      const repos = session.repos ?? (session.repo === "none" ? [] : [session.repo]);
      if (repo !== undefined && !repos.some((name) => normalized(name) === repo)) continue;
      if (args.since !== undefined && session.createdAt < args.since) continue;
      const source = redactSecrets(
        [
          session.title,
          session.kind,
          session.status,
          session.mode,
          session.model ?? "opus",
          session.outcomeSummary,
          session.endedReason,
          ...repos,
        ]
          .filter((value): value is string => typeof value === "string")
          .join(" "),
      );
      if (query !== "" && !includesQuery(source, query)) continue;
      results.push({
        id: session._id,
        title: excerpt(redactSecrets(session.title), query),
        kind: session.kind,
        status: session.status,
        mode: session.mode ?? "interactive",
        model: session.model ?? "opus",
        repos: repos
          .slice(0, MAX_RETURNED_REPOS)
          .map((name) => excerpt(redactSecrets(name), query, REPO_EXCERPT_CHARS)),
        outcomeSummary: session.outcomeSummary
          ? excerpt(redactSecrets(session.outcomeSummary), query)
          : null,
        date: session.createdAt,
        url: `https://tom.quest/sessions?session=${session._id}`,
      });
      if (results.length === limit) break;
    }
    return results;
  },
});

export const events = internalQuery({
  args: { query: v.string(), limit: v.number(), since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const query = normalized(args.query);
    if (query === "") return [];
    const { limit, candidateBudget } = searchLimits(args.limit);
    const candidates = args.since === undefined
      ? await ctx.db
          .query("dtsEvents")
          .withIndex("by_at")
          .order("desc")
          .take(candidateBudget)
      : await ctx.db
          .query("dtsEvents")
          .withIndex("by_at", (q) => q.gte("at", args.since!))
          .order("desc")
          .take(candidateBudget);
    const results = [];
    for (const event of candidates) {
      const todo = event.todoId ? await ctx.db.get(event.todoId) : null;
      const textSource = redactSecrets(
        [todo?.statement, flattenedText(event.data)].filter(Boolean).join(" "),
      );
      const matchSource = redactSecrets([event.kind, textSource].filter(Boolean).join(" "));
      if (!includesQuery(matchSource, query)) continue;
      results.push({
        id: event._id,
        kind: excerpt(redactSecrets(event.kind), query),
        date: event.at,
        text: excerpt(textSource, query, TEXT_EXCERPT_CHARS),
      });
      if (results.length === limit) break;
    }
    return results;
  },
});

export const todos = internalQuery({
  args: {
    query: v.string(),
    limit: v.number(),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const query = normalized(args.query);
    if (query === "") return [];
    const status = args.status === undefined ? undefined : normalized(args.status);
    if (status !== undefined && !isTodoStatus(status)) return [];
    const { limit, candidateBudget } = searchLimits(args.limit);
    const candidates = status === undefined
      ? await ctx.db.query("dtsTodos").order("desc").take(candidateBudget)
      : await ctx.db
          .query("dtsTodos")
          .withIndex("by_status", (q) => q.eq("status", status))
          .order("desc")
          .take(candidateBudget);
    const results = [];
    for (const todo of candidates) {
      const statementSource = redactSecrets(todo.statement);
      if (!includesQuery(statementSource, query)) continue;
      results.push({
        id: todo._id,
        statement: excerpt(statementSource, query, TEXT_EXCERPT_CHARS),
        status: todo.status,
        category: todo.category ? excerpt(redactSecrets(todo.category), query) : null,
        createdAt: todo.createdAt,
        updatedAt: todo.updatedAt,
        dueAt: todo.dueAt ?? null,
        wakeAt: todo.wakeAt ?? null,
        doneAt: todo.doneAt ?? null,
        archivedAt: todo.archivedAt ?? null,
      });
      if (results.length === limit) break;
    }
    return results;
  },
});
