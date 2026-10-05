// thread.ts — the Jarvis thread's record side: Tom's one standing conversation
// with Jarvis, on the /thread page. A message he types is an appended row of
// the record's append-only `events` table. The box appends its one-line reply
// under an ordinary message. The record appends each day's thread-digest and
// each line of the silence alarm (convex/jarvis/jobs.ts); Tom's messages under
// a digest are nested beneath it, and a numbered reply is routed to the
// digest's matching needs-you item here.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireTom } from "./authRoles";
import { DAY_LOG_ENTRY_MAX } from "./dayLog";
import { MIB, ReadBudget, getWithin, readWithin } from "./readBudget";
import { readCutLine } from "./ttsCompose";
import {
  NEEDS_TOM_ANSWERED, SILENCE_ALARM, THREAD_DIGEST, THREAD_NEEDS_YOU, laterDigestItems, type DigestItem,
} from "./jarvis/outbox";
import { insertEvent } from "./jarvis/record";
import { logEvent } from "./tts";
import { answerNeedsYou, numberedReply } from "./ttsSlack";
import { SESSION_REPOS, type SlackSubject } from "./ttsShared";
import { THREAD_REPLY_KINDS } from "../shared/jarvis-events.mjs";

const SURFACE = "Thread";

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
  | { kind: "merge"; data: { repo: keyof typeof SESSION_REPOS; sha: string; subject: string } }
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

function repoLink(repo: keyof typeof SESSION_REPOS, path: string): string {
  return `https://github.com/${SESSION_REPOS[repo]}/${path}`;
}

/** One agent change as the thread renders it: its line and diff link. */
export function agentChange(row: AgentChangeRow): { line: string; href: string | null } {
  switch (row.kind) {
    case "merge": {
      const { repo, sha, subject } = row.data;
      return {
        line: `Merged ${repo} ${sha.slice(0, 7)}: ${subject}`,
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

export const send = mutation({
  args: { text: v.string(), subject: v.optional(v.id("events")) },
  handler: async (ctx, { text, subject }) => {
    await requireTom(ctx, SURFACE);
    if (text.trim() === "") throw new Error("A message cannot be empty");
    if (text.length > DAY_LOG_ENTRY_MAX) throw new Error(`A message is at most ${DAY_LOG_ENTRY_MAX} characters`);
    let digestId: Id<"events"> | undefined;
    if (subject !== undefined) {
      const named = await ctx.db.get(subject);
      if (named?.kind === THREAD_DIGEST) {
        digestId = subject;
      } else if (named === null || !(AGENT_CHANGE_KINDS as readonly string[]).includes(named.kind)) {
        throw new Error("A reply names a change Jarvis reported or a digest");
      }
    }
    const id = await insertEvent(ctx, {
      kind: "thread-message",
      at: Date.now(),
      provenance: { user: "tom" },
      text,
      ...(subject === undefined ? {} : { subject }),
    });
    if (digestId !== undefined) {
      // The message is recorded verbatim before routing. The route therefore
      // runs in a sub-mutation: a routing failure must not roll that message
      // back, for the same reason ttsSlack.slackThreadReplyFrom isolates its
      // routing transaction.
      try {
        const answered: null = await ctx.runMutation(
          internal.thread.internalAnswerDigestReply, { digestId, messageId: id, text },
        );
        void answered;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        await insertEvent(ctx, { kind: "thread-reply", subject: id, data: { kind: "answer", error },
          text: `Not answered: ${error}. Your reply is kept here.`,
        });
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

function answerText(n: number, subject: NeedsSubject, outcome: AnswerOutcome): string {
  switch (outcome.outcome) {
    case "done": return `Item ${n}: its todo is marked done.`;
    case "time-note": return `Item ${n}: the date is a time note on its todo.`;
    case "tom-note":
      return subject.kind === "todo"
        ? `Item ${n}: your reply is a note on its todo.`
        : `Item ${n}: your reply is a note on the ${subject.id} job.`;
  }
}

export const internalAnswerDigestReply = internalMutation({
  args: { digestId: v.id("events"), messageId: v.id("events"), text: v.string() },
  handler: async (ctx, { digestId, messageId, text }): Promise<null> => {
    const digest = await ctx.db.get(digestId);
    if (digest?.kind !== THREAD_DIGEST || typeof digest.subject !== "string") throw new Error("A reply on the thread names a digest");
    const parsed = numberedReply(text);
    const items = [...digestItems(digest.data), ...await laterDigestItems(ctx, digestId)];
    const item = parsed === null ? undefined : items.find((one) => one.n === parsed.n);
    const itemSubject: NeedsSubject | undefined = item?.todoId !== undefined
      ? { kind: "todo", id: item.todoId as Id<"todos"> | Id<"dtsTodos"> }
      : item?.job !== undefined ? { kind: "job", id: item.job } : undefined;
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

type Reply = { at: number; text: string | undefined; kind: (typeof THREAD_REPLY_KINDS)[number] | null } | null;

/** What /thread's messages query reads, newest first, each under its own
 *  allotment of one ReadBudget (convex/readBudget.ts): 8.25 MiB in all, plus
 *  at most one document per read past it, under Convex's 16 MiB limit. The
 *  reads run one after another, as ReadBudget requires. */
const PAGE_READS = {
  messages: { what: "thread messages", bytes: 2 * MIB, rows: 500 },
  digests: { what: "thread digests", bytes: 4 * MIB, rows: 60 },
  items: { what: "needs-you items", bytes: MIB, rows: 500 },
  alarms: { what: "silence-alarm lines", bytes: MIB / 4, rows: 200 },
  replies: { what: "Jarvis's replies", bytes: MIB },
};

export const messages = query({
  args: {},
  handler: async (ctx) => {
    await requireTom(ctx, SURFACE);
    const since = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const budget = ReadBudget.of(MIB * 8.25);
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
    const replyBudget = budget.allot(PAGE_READS.replies.what, PAGE_READS.replies.bytes);
    const said = new Map<string, { id: Id<"events">; at: number; text: string; reply: Reply }>();
    for (const row of messageRows) {
      const reply = await getWithin(replyBudget, () => ctx.db
        .query("events")
        .withIndex("by_kind_subject_at", (q) => q.eq("kind", "thread-reply").eq("subject", row._id))
        .order("desc")
        .first());
      said.set(row._id, { id: row._id, at: row.at, text: row.text ?? "", reply: reply == null ? null
        : { at: reply.at, text: reply.text, kind: typeof reply.data?.kind === "string" ? reply.data.kind as (typeof THREAD_REPLY_KINDS)[number] : null } });
    }
    const digestIds = new Set<string>(digestRows.map((digest) => digest._id));
    const messages = messageRows
      .filter((row) => row.subject === undefined || !digestIds.has(row.subject))
      .map((row) => ({ kind: "message" as const, ...said.get(row._id)!, subject: row.subject ?? null }));
    const digests = digestRows.map((digest) => ({ kind: "digest" as const, id: digest._id, at: digest.at,
      day: digest.subject as string, text: digest.text,
      items: digestItems(digest.data).map(({ n, text }) => ({ n, text })),
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
    return {
      entries: [...messages, ...digests, ...items, ...alarms].sort((a, b) => a.at - b.at),
      cuts: budget.cuts().map(readCutLine),
    };
  },
});

export const changes = query({
  args: {},
  handler: async (ctx) => {
    await requireTom(ctx, SURFACE);
    const since = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const changes = await Promise.all(
      AGENT_CHANGE_KINDS.map(async (kind) => {
        const byKind = await ctx.db
          .query("events")
          .withIndex("by_kind_at", (q) => q.eq("kind", kind).gte("at", since))
          .order("desc")
          .take(200);
        return byKind.flatMap((row) => {
          const changeRow = checkedAgentChangeRow(row, kind);
          if (changeRow === null) return [];
          const { line, href } = agentChange(changeRow);
          return { id: row._id, at: row.at, kind, line, href };
        });
      }),
    );
    return changes.flat().sort((a, b) => a.at - b.at);
  },
});
