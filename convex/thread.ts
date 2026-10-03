// thread.ts — the Jarvis thread's record side: Tom's one standing conversation
// with Jarvis, on the /thread page. A message he types is an appended row of
// the record's append-only `events` table. The box appends its one-line reply
// under an ordinary message. It also appends each day's thread-digest; Tom's
// messages under that digest are nested beneath it, and a numbered reply is
// routed to the digest's matching needs-you item here.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type QueryCtx } from "./_generated/server";
import { requireTom } from "./authRoles";
import { DAY_LOG_ENTRY_MAX } from "./dayLog";
import { THREAD_DIGEST } from "./jarvis/digest";
import { insertEvent } from "./jarvis/record";
import { logEvent } from "./tts";
import { answerNeedsYou, numberedReply } from "./ttsSlack";
import { SESSION_REPOS, type SlackSubject } from "./ttsShared";

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

type DigestItem = { n: number; key: string; text: string; todoId?: string; job?: string };
type NeedsSubject = Extract<SlackSubject, { kind: "todo" | "job" }>;
type AnswerOutcome = Awaited<ReturnType<typeof answerNeedsYou>>;

function digestItems(data: unknown): DigestItem[] {
  const rows = (data as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((value) => {
    if (value === null || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    if (!Number.isInteger(item.n) || (item.n as number) < 1 || typeof item.key !== "string" || typeof item.text !== "string") {
      return [];
    }
    return [{ n: item.n as number, key: item.key, text: item.text,
      ...(typeof item.todoId === "string" ? { todoId: item.todoId } : {}),
      ...(typeof item.job === "string" ? { job: item.job } : {}),
    }];
  });
}

function answerText(n: number, subject: NeedsSubject, outcome: AnswerOutcome): string {
  switch (outcome.outcome) {
    case "done": return `Item ${n}: its todo is marked done.`;
    case "time-note": return `Item ${n}: the date is a time note on its todo.`;
    case "tom-note":
      return subject.kind === "todo"
        ? `Item ${n}: your reply is a note on its todo.`
        : `Item ${n}: your reply is a note on the ${subject.id} job.`;
    default: return `Item ${n}: answered (${outcome.outcome}).`;
  }
}

export const internalAnswerDigestReply = internalMutation({
  args: { digestId: v.id("events"), messageId: v.id("events"), text: v.string() },
  handler: async (ctx, { digestId, messageId, text }): Promise<null> => {
    const digest = await ctx.db.get(digestId);
    if (digest?.kind !== THREAD_DIGEST || typeof digest.subject !== "string") throw new Error("A reply on the thread names a digest");
    const parsed = numberedReply(text);
    const item = parsed === null ? undefined : digestItems(digest.data).find((one) => one.n === parsed.n);
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

type ReplyKind = "fact" | "todo" | "rule" | "errand" | "question" | "answer";

async function newestReply(ctx: QueryCtx, messageId: Id<"events">) {
  const reply = await ctx.db
    .query("events")
    .withIndex("by_kind_subject_at", (q) => q.eq("kind", "thread-reply").eq("subject", messageId))
    .order("desc")
    .first();
  const kind = typeof reply?.data?.kind === "string" ? reply.data.kind as ReplyKind : null;
  return reply === null ? null : { at: reply.at, text: reply.text, kind };
}

export const messages = query({
  args: {},
  handler: async (ctx) => {
    await requireTom(ctx, SURFACE);
    const since = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const [messageRows, digestRows] = await Promise.all([
      ctx.db
        .query("events")
        .withIndex("by_kind_at", (q) => q.eq("kind", "thread-message").gte("at", since))
        .order("desc")
        .take(500),
      ctx.db
        .query("events")
        .withIndex("by_kind_at", (q) => q.eq("kind", THREAD_DIGEST).gte("at", since))
        .order("desc")
        .take(60),
    ]);
    const digestIds = new Set<string>(digestRows.map((digest) => digest._id));
    const messages = await Promise.all(
      messageRows
        .filter((row) => row.subject === undefined || !digestIds.has(row.subject))
        .map(async (row) => ({ kind: "message" as const,
          id: row._id, at: row.at, text: row.text, subject: row.subject ?? null,
          reply: await newestReply(ctx, row._id),
        })),
    );
    const digests = await Promise.all(digestRows.map(async (digest) => {
      const replies = await ctx.db
        .query("events")
        .withIndex("by_kind_subject_at", (q) =>
          q.eq("kind", "thread-message").eq("subject", digest._id))
        .order("asc")
        .take(500);
      return { kind: "digest" as const, id: digest._id, at: digest.at,
        day: digest.subject as string, text: digest.text,
        items: digestItems(digest.data).map(({ n, text }) => ({ n, text })),
        replies: await Promise.all(replies.map(async (row) => ({ id: row._id, at: row.at, text: row.text,
          reply: await newestReply(ctx, row._id),
        }))),
      };
    }));
    return [...messages, ...digests].sort((a, b) => a.at - b.at);
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
