// thread.ts — the Jarvis thread's record side: the one page Tom checks
// (tom.quest/thread). A message he types is an appended row of the record's
// append-only `events` table. The box appends its one-line reply under an
// ordinary message. The record appends each day's thread-digest and each line
// of the silence alarm (convex/jarvis/jobs.ts). The stream (messages,
// changes) is every row the page shows, in time order; the open items (open)
// are what waits on him, read through the index of rows not yet closed
// (data.closedAt) and checked against the rows that close them.
// A reply names the row it answers, and send does what a reply to that type
// of row does: a numbered reply answers the digest's needs-you item, a reply
// under a decision is his objection, under a suggestion his answer, under a
// session's question a turn of that session.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireTom } from "./authRoles";
import { sendMessageFrom } from "./claudeSessions";
import { DAY_LOG_ENTRY_MAX } from "./dayLog";
import { DISAGREEMENT_SETTLED, decisionOf, settleDecision, settlements } from "./jarvis/intent";
import type { Value } from "convex/values";
import { MIB, ReadBudget, getWithin, readWithin } from "./readBudget";
import { readCutLine } from "./ttsCompose";
import {
  ITEM_TEXT_MAX_BYTES, NEEDS_TOM_ANSWERED, NEEDS_YOU_OPENED, NEEDS_YOU_WINDOW_MS, SILENCE_ALARM, THREAD_DIGEST, THREAD_NEEDS_YOU,
  cutToBytes, laterDigestItems, type DigestItem,
} from "./jarvis/outbox";
import { insertEvent } from "./jarvis/record";
import { resolveId } from "./jarvis/tables";
import { logEvent } from "./tts";
import { AUDIT_VERDICT, TESTS_RUN } from "./ttsMerge";
import { answerNeedsYou, numberedReply, parseObjectionReply, recordLineObjection } from "./ttsSlack";
import { LIVE_STATUSES, SESSION_REPOS, commitKey, type SlackSubject } from "./ttsShared";
import { THREAD_REPLY_KINDS, registryDiffOf } from "../shared/jarvis-events.mjs";

const SURFACE = "Thread";

/** The stream's window: rows older than this are not read. */
const WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
/** The most rows of one type the stream or the open items read. */
const TYPE_READ_MAX = 200;
const PAUSE = "pause";
const SUGGESTION = "suggestion";
const QUALITY_CHECK = "quality-check";
const DIAGNOSIS = "diagnosis";
/** The one pause reason the thread shows: a question only he can answer. */
const AWAITING_YOU = "awaiting you, present";

// The four kinds of agent change that appear in the Jarvis thread. Each is
// written only by the Jarvis Box's jobs and agents, never by Tom, so the kind
// alone says the actor is an agent: a reply sent under one is his objection.
export const AGENT_CHANGE_KINDS = [
  "merge",
  "deploy",
  "learning-change",
  "repo-proposal-applied",
] as const;

type AgentChangeRow = Omit<Doc<"events">, "kind" | "data"> & (
  | {
      kind: "merge";
      data: {
        repo: keyof typeof SESSION_REPOS; sha: string; subject: string;
        // Written by convex/gateLandings.ts since this change; absent on older rows.
        pull?: { number: number; title: string }; claim?: string; explanation?: string;
      };
    }
  | { kind: "deploy"; data: { repo: keyof typeof SESSION_REPOS; from: string; to: string; commits: string[] } }
  | { kind: "learning-change"; data: { file: string; section: string; modelOfTomCommit: string | null } }
  | {
      kind: "repo-proposal-applied";
      data: { repo: keyof typeof SESSION_REPOS; file: string; appliedLine: string; commit: string };
    }
);

type ChangeData<K extends AgentChangeRow["kind"]> = Extract<AgentChangeRow, { kind: K }>["data"];
type LearningChangeData = Omit<ChangeData<"learning-change">, "modelOfTomCommit"> & {
  modelOfTomCommit?: string | null;
};

// These guards cannot be deleted: /tts/event writes these rows through an
// unvalidated route, and one bad row must not hide every change from the page.
function isMergeData(data: unknown): data is ChangeData<"merge"> {
  if (data === null || typeof data !== "object") return false;
  const fields = data as Record<string, unknown>;
  return (
    typeof fields.repo === "string" &&
    Object.prototype.hasOwnProperty.call(SESSION_REPOS, fields.repo) &&
    typeof fields.sha === "string" &&
    typeof fields.subject === "string"
  );
}

function isDeployData(data: unknown): data is ChangeData<"deploy"> {
  if (data === null || typeof data !== "object") return false;
  const fields = data as Record<string, unknown>;
  return (
    typeof fields.repo === "string" &&
    Object.prototype.hasOwnProperty.call(SESSION_REPOS, fields.repo) &&
    typeof fields.from === "string" &&
    typeof fields.to === "string" &&
    Array.isArray(fields.commits)
  );
}

function isLearningChangeData(data: unknown): data is LearningChangeData {
  if (data === null || typeof data !== "object") return false;
  const fields = data as Record<string, unknown>;
  return (
    typeof fields.file === "string" &&
    typeof fields.section === "string" &&
    (fields.modelOfTomCommit === undefined ||
      fields.modelOfTomCommit === null ||
      typeof fields.modelOfTomCommit === "string")
  );
}

function isRepoProposalAppliedData(data: unknown): data is ChangeData<"repo-proposal-applied"> {
  if (data === null || typeof data !== "object") return false;
  const fields = data as Record<string, unknown>;
  return (
    typeof fields.repo === "string" &&
    Object.prototype.hasOwnProperty.call(SESSION_REPOS, fields.repo) &&
    typeof fields.file === "string" &&
    typeof fields.appliedLine === "string" &&
    typeof fields.commit === "string"
  );
}

function checkedAgentChangeRow(row: Doc<"events">, kind: AgentChangeRow["kind"]): AgentChangeRow | null {
  switch (kind) {
    case "merge":
      return isMergeData(row.data) ? { ...row, kind, data: row.data } : null;
    case "deploy":
      return isDeployData(row.data) ? { ...row, kind, data: row.data } : null;
    case "learning-change":
      return isLearningChangeData(row.data)
        ? { ...row, kind, data: { ...row.data, modelOfTomCommit: row.data.modelOfTomCommit ?? null } }
        : null;
    case "repo-proposal-applied":
      return isRepoProposalAppliedData(row.data) ? { ...row, kind, data: row.data } : null;
  }
}

// Not deletable: the row's data is v.any(), and a merge row written by an
// older writer through /tts/event may carry a malformed pull.
function isPull(value: unknown): value is { number: number; title: string } {
  const pull = value as { number?: unknown; title?: unknown } | null | undefined;
  return typeof pull?.number === "number" && typeof pull.title === "string";
}

function repoLink(repo: keyof typeof SESSION_REPOS, path: string): string {
  return `https://github.com/${SESSION_REPOS[repo]}/${path}`;
}

/** One agent change as the thread renders it: its line and diff link. */
export function agentChange(row: AgentChangeRow): { line: string; href: string | null } {
  switch (row.kind) {
    case "merge": {
      const { repo, sha, subject, pull } = row.data;
      // Kept: no landing row the record holds carries `pull` (68 merge rows
      // from 2026-09-28 to 2026-10-05, read 2026-10-05, none with it), since
      // only convex/gateLandings.ts writes it, from this change on; the
      // stream reads 60 days of them.
      return {
        line: isPull(pull) ? `Merged ${repo} #${pull.number}: ${pull.title}` : `Merged ${repo} ${sha.slice(0, 7)}: ${subject}`,
        href: repoLink(repo, `commit/${sha}`),
      };
    }
    case "deploy": {
      const { repo, from, to, commits } = row.data;
      return {
        line: `Deployed ${repo} ${from.slice(0, 7)}..${to.slice(0, 7)}, ${commits.length} commit(s)`,
        href: repoLink(repo, `compare/${from}...${to}`),
      };
    }
    case "learning-change": {
      const { file, section, modelOfTomCommit } = row.data;
      return {
        line: `Changed ${file}${section !== "" ? ` § ${section}` : ""}`,
        href: modelOfTomCommit === null ? null : `https://github.com/Heffnt/WikiTom/commit/${modelOfTomCommit}`,
      };
    }
    case "repo-proposal-applied": {
      const { repo, file, appliedLine, commit } = row.data;
      return {
        line: `Added a rule to ${repo} ${file}: ${appliedLine}`,
        href: repoLink(repo, `commit/${commit}`),
      };
    }
  }
}

/** The refusal of a reply whose subject names a row no reply answers. */
const REPLY_REFUSED =
  "A reply names a digest, a change, a decision, a suggestion, a check, a diagnosis or a session's question";

/** Whether a reply may name this row: the row types section 4 of the thread's
 *  contract lists, each with what a reply to it does in send. */
function answersRow(row: Doc<"events">): boolean {
  if (row.kind === PAUSE) {
    const data = (row.data ?? {}) as { reason?: unknown; sessionId?: unknown };
    return data.reason === AWAITING_YOU && typeof data.sessionId === "string";
  }
  return [THREAD_DIGEST, "decision", SUGGESTION, QUALITY_CHECK, DIAGNOSIS,
    ...AGENT_CHANGE_KINDS].includes(row.kind);
}

/** The newest digest when `text` is a numbered reply to one of its items; a
 *  numbered message with no target is his answer by number to the open items
 *  the page shows at its top. Null otherwise. */
async function numberedForNewestDigest(ctx: QueryCtx, text: string): Promise<Doc<"events"> | null> {
  const parsed = numberedReply(text);
  if (parsed === null) return null;
  const digest = await ctx.db
    .query("events")
    .withIndex("by_kind_at", (q) => q.eq("kind", THREAD_DIGEST))
    .order("desc")
    .first();
  if (digest === null) return null;
  const items = [...digestItems(digest.data), ...await laterDigestItems(ctx, digest._id)];
  return items.some((item) => item.n === parsed.n) ? digest : null;
}

/** Run one routing sub-mutation so that its failure keeps his message: the
 *  message is recorded verbatim before routing, and a routing failure must not
 *  roll it back, for the same reason ttsSlack.slackThreadReplyFrom isolates
 *  its routing transaction. */
async function routeKeepingMessage(ctx: MutationCtx, messageId: Id<"events">, route: () => Promise<null>) {
  try {
    await route();
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await insertEvent(ctx, { kind: "thread-reply", subject: messageId, data: { kind: "answer", error },
      text: `Not answered: ${error}. Your reply is kept here.`,
    });
  }
}

export const send = mutation({
  args: { text: v.string(), subject: v.optional(v.id("events")) },
  handler: async (ctx, { text, subject }) => {
    await requireTom(ctx, SURFACE);
    if (text.trim() === "") throw new Error("A message cannot be empty");
    if (text.length > DAY_LOG_ENTRY_MAX) throw new Error(`A message is at most ${DAY_LOG_ENTRY_MAX} characters`);
    let named: Doc<"events"> | null;
    if (subject !== undefined) {
      named = await ctx.db.get(subject);
      if (named === null || !answersRow(named)) throw new Error(REPLY_REFUSED);
    } else {
      named = await numberedForNewestDigest(ctx, text);
    }
    const id = await insertEvent(ctx, {
      kind: "thread-message",
      at: Date.now(),
      provenance: { user: "tom" },
      text,
      ...(named === null ? {} : { subject: named._id }),
    });
    if (named === null) return { id };
    const row = named;
    switch (row.kind) {
      case THREAD_DIGEST:
        await routeKeepingMessage(ctx, id, async () => await ctx.runMutation(
          internal.thread.internalAnswerDigestReply, { digestId: row._id, messageId: id, text },
        ));
        break;
      case "decision":
        // His sentence is the objection: one code path with /intent's settle.
        await settleDecision(ctx, row.subject as string, "revise", text.trim());
        break;
      case SUGGESTION:
        // The one write the page makes to a row it did not create.
        await ctx.db.patch(row._id, { data: { ...(row.data ?? {}), answer: { at: Date.now(), text, messageId: id }, closedAt: Date.now() } });
        break;
      case PAUSE: {
        const sessionId = ctx.db.normalizeId("claudeSessions", (row.data as { sessionId: string }).sessionId);
        if (sessionId === null) throw new Error("The question names no session");
        await sendMessageFrom(ctx, { sessionId, text, author: "tom" });
        break;
      }
    }
    return { id };
  },
});

/**
 * Tom says on the thread that a part has an issue, or that it has none: an
 * `issue` row, or a `use` row with state "working", by him, subject the part
 * (shared/jarvis-events.mjs; convex/jarvis/partStates.ts reads both). The box's
 * thread-reply job writes the same rows when it reads either from a message.
 */
export const reportOnPart = mutation({
  args: { part: v.string(), report: v.union(v.literal("issue"), v.literal("no-issues")), text: v.string() },
  handler: async (ctx, { part, report, text }) => {
    await requireTom(ctx, SURFACE);
    // The validator refuses an empty part and an empty text; it bounds no
    // text's length, so the thread's message limit is kept here, as send keeps it.
    if (text.length > DAY_LOG_ENTRY_MAX) throw new Error(`A report is at most ${DAY_LOG_ENTRY_MAX} characters`);
    const id = await insertEvent(ctx, {
      kind: report === "issue" ? "issue" : "use",
      at: Date.now(),
      provenance: { user: "tom" },
      subject: part,
      data: report === "issue" ? { part, by: "tom" } : { part, by: "tom", state: "working" },
      text,
    });
    return { id };
  },
});

type NeedsSubject = Extract<SlackSubject, { kind: "todo" | "job" }>;
type AnswerOutcome = Awaited<ReturnType<typeof answerNeedsYou>>;

function digestItems(data: unknown): DigestItem[] {
  // RECORD_ONLY_KINDS keeps worker-key writers out, so the writer's type is trusted.
  return (data as { items: DigestItem[] }).items;
}

function needsSubject(item: { todoId?: unknown; job?: unknown }): NeedsSubject | undefined {
  return typeof item.todoId === "string"
    ? { kind: "todo", id: item.todoId as Id<"todos"> | Id<"dtsTodos"> }
    : typeof item.job === "string" ? { kind: "job", id: item.job } : undefined;
}

function answerText(n: number, subject: NeedsSubject, outcome: AnswerOutcome): string {
  const item = `Item ${n}`;
  switch (outcome.outcome) {
    case "done": return `${item}: its todo is marked done.`;
    case "time-note": return `${item}: the date is a time note on its todo.`;
    case "tom-note":
      return subject.kind === "todo"
        ? `${item}: your reply is a note on its todo.`
        : `${item}: your reply is a note on the ${subject.id} job.`;
  }
}

export const internalAnswerDigestReply = internalMutation({
  args: { digestId: v.id("events"), messageId: v.id("events"), text: v.string() },
  handler: async (ctx, { digestId, messageId, text }): Promise<null> => {
    const digest = await ctx.db.get(digestId);
    if (digest?.kind !== THREAD_DIGEST || typeof digest.subject !== "string") throw new Error("A reply on the thread names a digest");
    // The digest numbers its objection lines 1..k (data.objectionAskIds, in
    // printed order) and its needs-you items from k + 1, so "revert 2" or
    // "2: leave it" on a line up to k objects to that line's decision, through
    // the same code as the reply under the Slack digest. This branch cannot be
    // deleted: the Slack route is reached only by a Slack reply, so without it
    // a reply here would be a note, not an objection.
    const objected = await recordLineObjection(ctx, text, (digest.data as { objectionAskIds?: unknown }).objectionAskIds,
      digest.subject, { channel: "thread", ts: messageId, threadTs: digestId });
    const objection = objected === undefined ? null : parseObjectionReply(text);
    if (objection !== null) {
      await insertEvent(ctx, { kind: "thread-reply", subject: messageId,
        data: { kind: "answer", outcome: "objection", n: objection.n },
        text: `Line ${objection.n}: your objection is recorded.`,
      });
      return null;
    }
    const parsed = numberedReply(text);
    const items = [...digestItems(digest.data), ...await laterDigestItems(ctx, digestId)];
    const item = parsed === null ? undefined : items.find((one) => one.n === parsed.n);
    const itemSubject = item === undefined ? undefined : needsSubject(item);
    if (parsed !== null && item !== undefined && itemSubject !== undefined) {
      const outcome = await answerNeedsYou(
        ctx,
        { n: item.n, subject: itemSubject, answeredKey: `thread:${digestId}#${item.n}` },
        { text, said: parsed.rest, numbered: true },
        { threadDigestId: digestId, threadMessageId: messageId },
      );
      await insertEvent(ctx, {
        kind: NEEDS_TOM_ANSWERED,
        provenance: { user: "tom" },
        subject: item.key,
        data: { answer: parsed.rest === "" ? text : parsed.rest, via: "thread" },
      });
      // Answered: the open items' index leaves its opening.
      const opening = await ctx.db
        .query("events")
        .withIndex("by_kind_subject_at", (q) => q.eq("kind", NEEDS_YOU_OPENED).eq("subject", item.key))
        .first();
      if (opening !== null) await closeRow(ctx, opening);
      await insertEvent(ctx, { kind: "thread-reply", subject: messageId,
        data: { kind: "answer", outcome: outcome.outcome, n: item.n },
        text: answerText(item.n, itemSubject, outcome),
      });
      return null;
    }
    const day = digest.subject;
    await logEvent(ctx, "tom-note", undefined, { text, subject: { kind: "today", day }, day,
      threadDigestId: digestId, threadMessageId: messageId });
    await insertEvent(ctx, { kind: "thread-reply", subject: messageId, data: { kind: "fact" },
      text: parsed === null
        ? `Kept as a note on the ${day} digest.`
        : `Kept as a note on the ${day} digest; no item is numbered ${parsed.n}.`,
    });
    return null;
  },
});

/** A lookup the budget stopped: what it stands for is unknown, so a reader
 *  draws without it, counts as partial, and takes a yes or no as unknown. */
export const CUT = { cut: true } as const;
type Cut = typeof CUT;
const isCut = (value: unknown): value is Cut => value === CUT;

async function lookup<T extends Record<string, Value>>(budget: ReadBudget, read: () => Promise<T | null>): Promise<T | null | Cut> {
  const found = await getWithin(budget, read);
  return found === undefined ? CUT : found;
}

type Reply = { at: number; text: string | undefined; kind: (typeof THREAD_REPLY_KINDS)[number] | null } | null | Cut;

/** The box's reply to one of his messages, under `budget`. */
export async function replyOf(ctx: QueryCtx, message: Id<"events">, budget: ReadBudget): Promise<Reply> {
  const reply = await lookup(budget, () => ctx.db
    .query("events")
    .withIndex("by_kind_subject_at", (q) => q.eq("kind", "thread-reply").eq("subject", message))
    .order("desc")
    .first());
  if (reply === null || isCut(reply)) return reply;
  return { at: reply.at, text: reply.text, kind: typeof reply.data?.kind === "string" ? reply.data.kind as (typeof THREAD_REPLY_KINDS)[number] : null };
}

/** The budget every read of thread.messages shares, settlements included:
 *  at most this plus one document, under Convex's 16 MiB; a stop is a cut. */
const PAGE_READ_BYTES = 10 * MIB;

/** Each read's allotment and rows, newest first, run one after another. */
const PAGE_READS = {
  settlements: { what: "his settlements", bytes: MIB / 2, rows: 500 },
  messages: { what: "thread messages", bytes: 2 * MIB, rows: 500 },
  digests: { what: "thread digests", bytes: 4 * MIB, rows: 60 },
  items: { what: "needs-you items", bytes: MIB, rows: 500 },
  alarms: { what: "silence-alarm lines", bytes: MIB / 4, rows: 200 },
  replies: { what: "Jarvis's replies", bytes: MIB },
  decisions: { what: "the delegate's decisions", bytes: MIB, rows: 200 },
  suggestions: { what: "suggestions", bytes: MIB / 2, rows: 200 },
  checks: { what: "quality checks", bytes: MIB / 2, rows: 200 },
  diagnoses: { what: "diagnoses", bytes: MIB / 4, rows: 200 },
};

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Where a suggestion's subject is read: a todo's page, a commit, or a part on
 *  /design; a rule line's heading has no page of its own. */
function suggestionHref(ctx: QueryCtx, subject: string): string | null {
  if (ctx.db.normalizeId("todos", subject) !== null) return `/jarvis?item=${subject}`;
  const commit = /^([^@\s]+)@([0-9a-f]{7,40})$/.exec(subject);
  if (commit !== null && Object.prototype.hasOwnProperty.call(SESSION_REPOS, commit[1])) {
    return repoLink(commit[1] as keyof typeof SESSION_REPOS, `commit/${commit[2]}`);
  }
  return /^[a-z0-9][a-z0-9-]*$/.test(subject) ? `/design#${subject}` : null;
}

/** One `decision` row as the stream draws it, with his settlement of it;
 *  null for a refused or unanswered ask, which took nothing in his name. */
function decisionEntry(row: Doc<"events">, settled: Parameters<typeof decisionOf>[1]) {
  const data = (row.data ?? {}) as { refused?: unknown; decision?: unknown };
  if (data.refused === true || typeof data.decision !== "string") return null;
  const decision = decisionOf(row, settled);
  if (decision === null || decision.decision === null) return null;
  const { askId, question, reason, restedOn, wouldChange, caller, model, todoId, decidedByTom, waitedMs } = decision;
  return { kind: "decision" as const, id: row._id, at: row.at, askId, question, decision: decision.decision,
    reason, restedOn, wouldChange, caller, model, todoId, decidedByTom, waitedMs,
    settled: decision.settled === null ? null
      : { at: decision.settled.at, verdict: decision.settled.verdict, sentence: decision.settled.sentence },
  };
}

/** One `suggestion` row as the stream and the open items draw it. */
function suggestionEntry(ctx: QueryCtx, row: Doc<"events">) {
  const data = (row.data ?? {}) as {
    class: string; built: boolean; restsOn?: { text?: unknown; source?: unknown };
    answer?: { at: number; text: string; messageId: string };
  };
  const restsOn = str(data.restsOn?.text) === null ? null
    : { text: data.restsOn!.text as string, source: str(data.restsOn!.source) ?? "" };
  return { kind: "suggestion" as const, id: row._id, at: row.at, subject: row.subject as string,
    href: suggestionHref(ctx, row.subject as string), class: data.class, built: data.built, restsOn,
    answer: data.answer ?? null, text: row.text ?? "" };
}

/** The decision a link names (/thread#<row id>) past the stream's 60 days,
 *  with its settlement; any other id answers null. */
export const row = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    await requireTom(ctx, SURFACE);
    const eventId = ctx.db.normalizeId("events", id);
    const found = eventId === null ? null : await ctx.db.get(eventId);
    if (found === null || found.kind !== "decision" || found.subject === undefined) return null;
    const subject = `decision:${found.subject}`;
    const settlement = await ctx.db
      .query("events")
      .withIndex("by_kind_subject_at", (q) => q.eq("kind", DISAGREEMENT_SETTLED).eq("subject", subject))
      .order("desc")
      .first();
    const data = (settlement?.data ?? {}) as { verdict?: unknown; sentence?: unknown; rulingId?: unknown };
    const settled: Parameters<typeof decisionOf>[1] = new Map();
    if (settlement !== null && (data.verdict === "approve" || data.verdict === "revise")) {
      settled.set(subject, { at: settlement.at, verdict: data.verdict, sentence: str(data.sentence), rulingId: str(data.rulingId) });
    }
    return decisionEntry(found, settled);
  },
});

export const messages = query({
  args: {},
  handler: async (ctx) => {
    await requireTom(ctx, SURFACE);
    const since = Date.now() - WINDOW_MS;
    const budget = ReadBudget.of(PAGE_READ_BYTES);
    // First: whether a decision is settled rests on it.
    const settled = await settlements(ctx, budget.allot(PAGE_READS.settlements.what, PAGE_READS.settlements.bytes));
    const newest = (kind: string, read: { what: string; bytes: number; rows: number }) => readWithin(
      budget.allot(read.what, read.bytes),
      ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", kind).gte("at", since)).order("desc"),
      read.rows,
    );
    // One read of Tom's messages serves the page: those under a digest are
    // its replies, so no reply is read twice.
    const messageRows = await newest("thread-message", PAGE_READS.messages);
    const digestRows = await newest(THREAD_DIGEST, PAGE_READS.digests);
    const itemRows = await newest(THREAD_NEEDS_YOU, PAGE_READS.items);
    const alarmRows = await newest(SILENCE_ALARM, PAGE_READS.alarms);
    const decisionRows = await newest("decision", PAGE_READS.decisions);
    const suggestionRows = await newest(SUGGESTION, PAGE_READS.suggestions);
    const checkRows = await newest(QUALITY_CHECK, PAGE_READS.checks);
    const diagnosisRows = await newest(DIAGNOSIS, PAGE_READS.diagnoses);
    const replyBudget = budget.allot(PAGE_READS.replies.what, PAGE_READS.replies.bytes);
    const said = new Map<string, { id: Id<"events">; at: number; text: string; reply: Reply }>();
    for (const row of messageRows) {
      said.set(row._id, { id: row._id, at: row.at, text: row.text ?? "", reply: await replyOf(ctx, row._id, replyBudget) });
    }
    const digestIds = new Set<string>(digestRows.map((digest) => digest._id));
    const messages = messageRows
      .filter((row) => row.subject === undefined || !digestIds.has(row.subject))
      .map((row) => ({ kind: "message" as const, ...said.get(row._id)!, subject: row.subject ?? null }));
    const laterCounts = new Map<string, number>();
    for (const row of itemRows) laterCounts.set(row.subject as string, (laterCounts.get(row.subject as string) ?? 0) + 1);
    const digests = digestRows.map((digest) => ({ kind: "digest" as const, id: digest._id, at: digest.at,
      day: digest.subject as string, text: digest.text,
      items: digestItems(digest.data).map(({ n, text }) => ({ n, text })),
      // Kept: #339 lands before this change and appends a digest each
      // morning without sectionCounts until this change lands; the stream
      // reads 60 days of digests.
      sectionCounts: (digest.data as { sectionCounts?: Record<string, number> }).sectionCounts ?? {},
      laterItems: laterCounts.get(digest._id) ?? 0,
      replies: messageRows.filter((row) => row.subject === digest._id).reverse().map((row) => said.get(row._id)!),
    }));
    const digestDays = new Map(digestRows.map((digest) => [digest._id as string, digest.subject as string]));
    const items = itemRows.flatMap((row) => {
      const digestId = row.subject as Id<"events">;
      const day = digestDays.get(digestId);
      // This cannot be deleted: an item whose capped parent is absent has no
      // trustworthy day to group under on the page.
      if (day === undefined) return [];
      return [{ kind: "item" as const, id: row._id, at: row.at, digestId, day,
        n: (row.data as { n: number }).n, text: row.text ?? "" }];
    });
    const alarms = alarmRows.map((row) => ({ kind: "alarm" as const, id: row._id, at: row.at, text: row.text ?? "",
      href: (row.data as { href: string }).href }));
    // A refused or unanswered ask took nothing in his name: it is no decision
    // he settles.
    const decisions = decisionRows.flatMap((row) => {
      const entry = decisionEntry(row, settled);
      return entry === null ? [] : [entry];
    });
    const suggestions = suggestionRows.map((row) => suggestionEntry(ctx, row));
    const checks = checkRows.flatMap((row) => {
      const data = row.data as { part: string; check: string; measure: number; target: number | null;
        result: string; agentHref?: unknown };
      if (data.result !== "failed") return [];
      return [{ kind: "check" as const, id: row._id, at: row.at, part: data.part, check: data.check,
        measure: data.measure, target: data.target, agentHref: str(data.agentHref) }];
    });
    const diagnoses = diagnosisRows.map((row) => {
      const data = row.data as { part: string; causes: Array<{ n?: unknown; class?: unknown; sentence?: unknown }>;
        fixLanding?: unknown; preventionLanding?: unknown };
      return { kind: "diagnosis" as const, id: row._id, at: row.at, part: data.part, text: row.text ?? "",
        causes: data.causes.map((cause) => ({ n: Number(cause.n), class: str(cause.class) ?? "", sentence: str(cause.sentence) ?? "" })),
        fixLanding: str(data.fixLanding), preventionLanding: str(data.preventionLanding) };
    });
    return {
      entries: [...messages, ...digests, ...items, ...alarms, ...decisions, ...suggestions, ...checks, ...diagnoses]
        .sort((a, b) => a.at - b.at),
      cuts: budget.cuts().map(readCutLine),
    };
  },
});

async function headRow(ctx: QueryCtx, kind: string, repo: string, sha: string) {
  return await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", kind).eq("key", commitKey(repo, sha)))
    .order("desc")
    .first();
}

/** The bytes of everything thread.changes reads, each read one of its
 *  allotments, run one after another: at most this plus one document. */
const CHANGES_READ_BYTES = 8 * MIB;

/** A landing's return from its head's tests-run and audit rows; with either
 *  lookup cut, none: no diff, no parts, checksAlone unknown. */
export async function landingReturn(ctx: QueryCtx, repo: string, sha: string, budget: ReadBudget) {
  const tests = await lookup(budget, () => headRow(ctx, TESTS_RUN, repo, sha));
  const audit = await lookup(budget, () => headRow(ctx, AUDIT_VERDICT, repo, sha));
  if (isCut(tests) || isCut(audit)) return { diff: null, parts: [], checksAlone: null };
  // A removed part has no registry row, so its id names it.
  const registryDiff = registryDiffOf((tests?.data as { registryDiff?: unknown } | undefined)?.registryDiff);
  const diff = registryDiff === null ? null
    : { added: registryDiff.added, changed: registryDiff.changed, removed: registryDiff.removed };
  const named = (id: string) => str((registryDiff?.rows[id] as { name?: unknown } | undefined)?.name) ?? id;
  const parts = diff === null ? [] : [
    ...diff.added.map((id: string) => ({ id, name: named(id), fate: "added" as const })),
    ...diff.changed.map((id: string) => ({ id, name: named(id), fate: "changed" as const })),
    ...diff.removed.map((id: string) => ({ id, name: id, fate: "removed" as const })),
  ];
  return { diff, parts, checksAlone: (audit?.data as { model?: unknown } | undefined)?.model === "none" };
}

export const changes = query({
  args: {},
  handler: async (ctx) => {
    await requireTom(ctx, SURFACE);
    const since = Date.now() - WINDOW_MS;
    const budget = ReadBudget.of(CHANGES_READ_BYTES);
    const rows: Array<[Doc<"events">, (typeof AGENT_CHANGE_KINDS)[number]]> = [];
    for (const kind of AGENT_CHANGE_KINDS) {
      const byKind = await readWithin(budget.allot(`${kind} rows`, MIB), ctx.db
        .query("events")
        .withIndex("by_kind_at", (q) => q.eq("kind", kind).gte("at", since))
        .order("desc"), TYPE_READ_MAX);
      rows.push(...byKind.map((row): [Doc<"events">, (typeof AGENT_CHANGE_KINDS)[number]] => [row, kind]));
    }
    const lookups = budget.allot("landings' tests and audits", 4 * MIB);
    const changes = [];
    for (const [row, kind] of rows) changes.push(await (async () => {
          const changeRow = checkedAgentChangeRow(row, kind);
          if (changeRow === null) return [];
          const { line, href } = agentChange(changeRow);
          if (changeRow.kind !== "merge") return [{ id: row._id, at: row.at, kind: changeRow.kind, line, href }];
          const { repo, sha, pull, claim, explanation } = changeRow.data;
          return [{ id: row._id, at: row.at, kind: changeRow.kind, line, href, repo, sha,
            pull: isPull(pull) ? { number: pull.number, title: pull.title } : null,
            claim: str(claim), ...await landingReturn(ctx, repo, sha, lookups), explanation: str(explanation) }];
    })());
    return { entries: changes.flat().sort((a, b) => a.at - b.at), cuts: budget.cuts().map(readCutLine) };
  },
});

// ── The open items ─────────────────────────────────────────────────────────
// What waits on him. No read takes the newest N of a growing kind: openings,
// decisions and suggestions are read through the index of rows not yet
// closed (data.closedAt, set by internalCloseOpenItems after each digest);
// a question is each live session's newest pause, a loop run each part's
// newest check. Every read and lookup is under one budget; a stop is a cut.

/** The bytes of the open items' reads; each read is one of its allotments. */
const OPEN_READ_BYTES = 6 * MIB;

/** The rows of one kind not closed yet, oldest first. */
function unclosed(ctx: QueryCtx, kind: string) {
  return ctx.db
    .query("events")
    .withIndex("by_kind_closed_at", (q) => q.eq("kind", kind).eq("data.closedAt", undefined))
    .order("asc");
}

/** Where a sweep resumes: after the row (at, id), in the index's order of
 *  `at` then creation time, so rows sharing a millisecond resume exactly. */
type Cursor = "start" | { at: number; id: Id<"events"> };
const cursorArg = v.optional(v.union(v.literal("start"), v.object({ at: v.number(), id: v.id("events") })));

/** The rows of one kind not closed yet that come after `cursor`. */
async function* unclosedAfter(ctx: QueryCtx, kind: string, cursor: Cursor) {
  if (cursor === "start") {
    yield* unclosed(ctx, kind);
    return;
  }
  const last = await ctx.db.get(cursor.id);
  yield* ctx.db.query("events").withIndex("by_kind_closed_at", (q) => {
    const same = q.eq("kind", kind).eq("data.closedAt", undefined).eq("at", cursor.at);
    return last === null ? same : same.gt("_creationTime", last._creationTime);
  });
  yield* ctx.db.query("events")
    .withIndex("by_kind_closed_at", (q) => q.eq("kind", kind).eq("data.closedAt", undefined).gt("at", cursor.at));
}

/** Mark a row as no longer waiting on him: the open items' index leaves it. */
async function closeRow(ctx: MutationCtx, row: Doc<"events">): Promise<void> {
  await ctx.db.patch(row._id, { data: { ...((row.data ?? {}) as Record<string, unknown>), closedAt: Date.now() } });
}

/** An opening still waiting, with its todo's statement; null when answered,
 *  its todo done or archived, or its job recovered; CUT when unknown. */
async function openingState(ctx: QueryCtx, row: Doc<"events">, budget: ReadBudget): Promise<{ statement?: string } | null | Cut> {
  const key = row.subject;
  if (key === undefined) return null;
  const answered = await lookup(budget, () => ctx.db
    .query("events")
    .withIndex("by_kind_subject_at", (q) => q.eq("kind", NEEDS_TOM_ANSWERED).eq("subject", key))
    .first());
  if (answered !== null) return isCut(answered) ? CUT : null;
  const data = (row.data ?? {}) as { todoId?: unknown; job?: unknown };
  const todoId = str(data.todoId);
  if (todoId !== null) {
    const todo = await lookup(budget, async () => {
      const plain = ctx.db.normalizeId("todos", todoId) ?? await resolveId(ctx, "todos", todoId);
      return plain === null ? null : await ctx.db.get(plain);
    });
    if (isCut(todo)) return CUT;
    if (todo !== null && (todo.status === "done" || todo.status === "archived")) return null;
    return todo === null ? {} : { statement: todo.statement };
  }
  if (str(data.job) !== null) {
    const recovered = await lookup(budget, () => ctx.db
      .query("events")
      .withIndex("by_kind_subject_at", (q) => q.eq("kind", "job-recovered").eq("subject", key).gt("at", row.at))
      .first());
    if (recovered !== null) return isCut(recovered) ? CUT : null;
  }
  return {};
}

/** A delegate's decision he has not settled; CUT when unknown. */
export async function decisionState(ctx: QueryCtx, row: Doc<"events">, budget: ReadBudget) {
  const decision = decisionOf(row, new Map());
  if (decision === null || decision.refused || decision.decision === null || decision.decidedByTom) return null;
  const settled = await lookup(budget, () => ctx.db
    .query("events")
    .withIndex("by_kind_subject_at", (q) => q.eq("kind", DISAGREEMENT_SETTLED).eq("subject", `decision:${decision.askId}`))
    .first());
  if (isCut(settled)) return CUT;
  return settled === null ? { ...decision, decision: decision.decision } : null;
}

/** Every needs-you item still open, with the number and digest on its
 *  opening (data.n, data.digestId, from the sweep or jarvis/outbox
 *  openNeedsYou). One with no number waits only on a missing digest, which
 *  the silence alarm reports, so it is not listed. */
export async function openNeedsYou(ctx: QueryCtx, budget: ReadBudget) {
  const rows = await readWithin(budget.allot("needs-you openings", 1.5 * MIB), unclosed(ctx, NEEDS_YOU_OPENED), Number.POSITIVE_INFINITY);
  const lookups = budget.allot("needs-you answers, todos and digests", 1.5 * MIB);
  const open = [];
  for (const row of rows) open.push(await (async () => {
    const data = (row.data ?? {}) as { n?: unknown; digestId?: unknown; todoId?: unknown; job?: unknown };
    const digestId = typeof data.digestId === "string" ? ctx.db.normalizeId("events", data.digestId) : null;
    if (typeof data.n !== "number" || digestId === null || row.subject === undefined) return [];
    const state = await openingState(ctx, row, lookups);
    const digest = state === null || isCut(state) ? null : await lookup(lookups, () => ctx.db.get(digestId));
    if (state === null || isCut(state) || digest === null || isCut(digest)) return [];
    const todoId = str(data.todoId);
    const job = str(data.job);
    return [{
      id: row._id, key: row.subject, at: row.at, text: cutToBytes(row.text ?? "", ITEM_TEXT_MAX_BYTES),
      ...(todoId === null ? {} : { todoId }),
      ...(state.statement === undefined ? {} : { statement: state.statement }),
      ...(job === null ? {} : { job }),
      n: data.n, digestId, day: digest.subject as string, digestAt: digest.at,
    }];
  })());
  // The newest digest's items first, by number; then each older digest's,
  // newest digest first.
  return open.flat().sort((a, b) => b.digestAt - a.digestAt || a.n - b.n);
}

/** Every session that is live: few at once, read by status. */
async function liveSessions(ctx: QueryCtx, budget: ReadBudget) {
  const sessions = budget.allot("live sessions", MIB / 2);
  const live = [];
  for (const status of LIVE_STATUSES) {
    live.push(...await readWithin(sessions, ctx.db.query("claudeSessions").withIndex("by_status", (q) => q.eq("status", status)), Number.POSITIVE_INFINITY));
  }
  return { live, cut: !sessions.open };
}

const INBOUND_STATUSES: Doc<"claudeInbound">["status"][] = ["pending", "delivered", "done", "interrupted", "failed"];

/** Each live session's newest pause, when it is a question only he can
 *  answer and he has not answered it here or in the session. */
async function openQuestions(ctx: QueryCtx, { live }: { live: Doc<"claudeSessions">[] }, budget: ReadBudget) {
  const turns = budget.allot("session questions and turns", MIB / 2);
  const questions = [];
  for (const session of live) questions.push(...await openQuestion(ctx, session, turns));
  return questions.sort((a, b) => a.at - b.at);
}

/** One live session's open question; none when a lookup was cut, since
 *  whether it is answered is then unknown (the cut line says so). */
export async function openQuestion(ctx: QueryCtx, session: Doc<"claudeSessions">, turns: ReadBudget) {
  const sessionId = session._id as string;
  const row = await lookup(turns, () => ctx.db
    .query("events")
    .withIndex("by_kind_subject_at", (q) => q.eq("kind", PAUSE).eq("subject", sessionId))
    .order("desc")
    .first());
  if (row === null || isCut(row)) return [];
  const data = row.data as { reason: string; question?: unknown };
  if (data.reason !== AWAITING_YOU) return [];
  const answered = await lookup(turns, () => ctx.db
    .query("events")
    .withIndex("by_kind_subject_at", (q) => q.eq("kind", "thread-message").eq("subject", row._id))
    .first());
  if (answered !== null) return [];
  // Only a turn Tom wrote answers it: an agent's turn, an interrupt or a
  // stop is no answer of his. Each status is an index range from the pause
  // row's creation, both server times: the pause's `at` is its writer's.
  for (const status of INBOUND_STATUSES) {
    const after = await readWithin(turns, ctx.db
      .query("claudeInbound")
      .withIndex("by_session_status", (q) => q.eq("sessionId", session._id).eq("status", status).gt("_creationTime", row._creationTime)),
    Number.POSITIVE_INFINITY);
    if (after.some((turn) => turn.kind === "user-turn" && turn.author === "tom")) return [];
    if (!turns.open) return [];
  }
  return [{ id: row._id, at: row.at, sessionId, title: session.title,
    question: row.text ?? str(data.question) ?? "", href: `/agents?session=${sessionId}` }];
}

/** The counts. Open loop runs, absent until a quality check exists: the
 *  parts of the newest registry whose newest check failed. `partial` names
 *  each count built from a cut read: the true count is at least it. */
export async function openCounts(ctx: QueryCtx, live: { live: Doc<"claudeSessions">[]; cut: boolean }, budget: ReadBudget) {
  const checks = budget.allot("the registry and each part's newest check", MIB);
  const partial: Array<"openLoopRuns" | "liveSessions"> = live.cut ? ["liveSessions"] : [];
  const anyCheck = await lookup(checks, () => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", QUALITY_CHECK)).first());
  const registry = anyCheck === null || isCut(anyCheck) ? anyCheck
    : await lookup(checks, () => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "registry")).order("desc").first());
  let cut = isCut(registry);
  const parts = ((isCut(registry) ? undefined : registry?.data as { parts?: Array<{ id?: unknown }> } | undefined)?.parts ?? [])
    .flatMap((part) => (typeof part.id === "string" ? [part.id] : []));
  let failed = 0;
  for (const part of parts) {
    const newest = await lookup(checks, () => ctx.db
      .query("events")
      .withIndex("by_kind_subject_at", (q) => q.eq("kind", QUALITY_CHECK).eq("subject", part))
      .order("desc")
      .first());
    if (isCut(newest)) cut = true;
    else if ((newest?.data as { result?: unknown } | undefined)?.result === "failed") failed += 1;
  }
  if (cut) partial.unshift("openLoopRuns");
  return {
    ...(anyCheck === null ? {} : { openLoopRuns: failed }),
    liveSessions: live.live.length,
    partial,
  };
}

/** Every suggestion he has not answered, whatever its age, oldest first: like
 *  an unsettled decision, it waits on him, and the stream reads 60 days. */
async function openSuggestions(ctx: QueryCtx, budget: ReadBudget) {
  const rows = await readWithin(budget.allot("suggestions", MIB / 2), unclosed(ctx, SUGGESTION), Number.POSITIVE_INFINITY);
  return rows.filter((row) => (row.data as { answer?: unknown }).answer === undefined).map((row) => suggestionEntry(ctx, row));
}

/** Every decision of the delegate's he has not settled, whatever its age. */
async function openDecisions(ctx: QueryCtx, budget: ReadBudget) {
  const rows = await readWithin(budget.allot("decisions", MIB / 2), unclosed(ctx, "decision"), Number.POSITIVE_INFINITY);
  const settlementsRead = budget.allot("decisions' settlements", MIB / 4);
  const open = [];
  for (const row of rows) {
    const state = await decisionState(ctx, row, settlementsRead);
    const entry = state === null || isCut(state) ? null : decisionEntry(row, new Map());
    if (entry !== null) open.push(entry);
  }
  return open;
}

export const open = query({
  args: {},
  handler: async (ctx) => {
    await requireTom(ctx, SURFACE);
    // Reads under one budget run one after another (convex/readBudget.ts).
    const budget = ReadBudget.of(OPEN_READ_BYTES);
    const needsYou = await openNeedsYou(ctx, budget);
    const decisions = await openDecisions(ctx, budget);
    const suggestions = await openSuggestions(ctx, budget);
    const live = await liveSessions(ctx, budget);
    const questions = await openQuestions(ctx, live, budget);
    const counts = await openCounts(ctx, live, budget);
    return { needsYou, questions, decisions, suggestions, counts, cuts: budget.cuts().map(readCutLine) };
  },
});

/** The bytes one sweep reads, its allotments sharing it. */
const SWEEP_READ_BYTES = 10 * MIB;

/** Close each opening, decision and suggestion that stopped waiting on him,
 *  after each digest. A kind cut by the budget hands the next run its last
 *  row decided, (at, row id), and that run resumes right after it. */
const SWEEP_KINDS = { openings: cursorArg, decisions: cursorArg, suggestions: cursorArg };

export const internalCloseOpenItems = internalMutation({
  args: { from: v.optional(v.object(SWEEP_KINDS)) },
  handler: async (ctx, { from }): Promise<{ closed: number }> => {
    const now = Date.now();
    const budget = ReadBudget.of(SWEEP_READ_BYTES);
    let closed = 0;
    // The numbers the digests of the last NEEDS_YOU_WINDOW_MS gave, by key:
    // an opening a digest listed gets its number and digest here.
    const digests = await readWithin(budget.allot("thread digests", MIB * 3 / 4), ctx.db
      .query("events")
      .withIndex("by_kind_at", (q) => q.eq("kind", THREAD_DIGEST).gte("at", now - NEEDS_YOU_WINDOW_MS))
      .order("desc"), Number.POSITIVE_INFINITY);
    const listed = new Map<string, { n: number; digestId: Id<"events"> }>();
    for (const digest of digests) {
      for (const item of digestItems(digest.data)) if (!listed.has(item.key)) listed.set(item.key, { n: item.n, digestId: digest._id });
    }
    const next: Partial<Record<keyof typeof SWEEP_KINDS, Cursor>> = {};
    // `shut` is CUT when a row's lookups were cut: the
    // kind's run ends at the row before it.
    const sweep = async (name: keyof typeof SWEEP_KINDS, kind: string, bytes: number,
      shut: (row: Doc<"events">, lookups: ReadBudget) => Promise<boolean | Cut>) => {
      const cursor = from === undefined ? "start" : from[name];
      if (cursor === undefined) return;
      const rows = await readWithin(budget.allot(name, bytes), unclosedAfter(ctx, kind, cursor), Number.POSITIVE_INFINITY);
      const lookups = budget.allot(`${name} lookups`, 2 * MIB);
      let reached: Cursor = cursor;
      for (const row of rows) {
        const done = await shut(row, lookups);
        if (isCut(done)) break;
        if (done) {
          await closeRow(ctx, row);
          closed += 1;
        }
        reached = { at: row.at, id: row._id };
      }
      if (budget.cuts().some((cut) => cut.what === name || cut.what === `${name} lookups`)) next[name] = reached;
    };
    await sweep("openings", NEEDS_YOU_OPENED, 1.5 * MIB, async (row, lookups) => {
      const data = (row.data ?? {}) as Record<string, unknown>;
      const number = typeof data.n === "number" || row.subject === undefined ? undefined : listed.get(row.subject);
      if (number !== undefined) await ctx.db.patch(row._id, { data: { ...data, ...number } });
      const numbered = typeof data.n === "number" || number !== undefined;
      if (!numbered && row.at < now - NEEDS_YOU_WINDOW_MS) return true;
      const state = await openingState(ctx, row, lookups);
      return isCut(state) ? CUT : state === null;
    });
    await sweep("decisions", "decision", MIB * 3 / 4, async (row, lookups) => {
      const state = await decisionState(ctx, row, lookups);
      return isCut(state) ? CUT : state === null;
    });
    await sweep("suggestions", SUGGESTION, MIB * 3 / 4, async (row) => (row.data as { answer?: unknown }).answer !== undefined);
    if (Object.keys(next).length > 0) await ctx.scheduler.runAfter(0, internal.thread.internalCloseOpenItems, { from: next });
    return { closed };
  },
});
