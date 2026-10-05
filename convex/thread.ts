// thread.ts — the Jarvis thread's record side: Tom's one standing conversation
// with Jarvis, on the /thread page. A message he types is an appended row of
// the record's append-only `events` table, never a state row: it is written
// only through insertEvent, and a box job (a later change) reads those rows
// and appends its one-line reply under each.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requireTom } from "./authRoles";
import { insertEvent } from "./jarvis/record";
import { DAY_LOG_ENTRY_MAX } from "./dayLog";
import { SESSION_REPOS } from "./ttsShared";
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
    if (subject !== undefined) {
      const named = await ctx.db.get(subject);
      if (named === null || !(AGENT_CHANGE_KINDS as readonly string[]).includes(named.kind)) {
        throw new Error("A reply names a change Jarvis reported");
      }
    }
    const id = await insertEvent(ctx, {
      kind: "thread-message",
      at: Date.now(),
      provenance: { user: "tom" },
      text,
      ...(subject === undefined ? {} : { subject }),
    });
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

export const messages = query({
  args: {},
  handler: async (ctx) => {
    await requireTom(ctx, SURFACE);
    const since = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const rows = await ctx.db
      .query("events")
      .withIndex("by_kind_at", (q) => q.eq("kind", "thread-message").gte("at", since))
      .order("desc")
      .take(500);
    const messages = await Promise.all(rows.map(async (row) => {
      const reply = await ctx.db
        .query("events")
        .withIndex("by_kind_subject_at", (q) => q.eq("kind", "thread-reply").eq("subject", row._id))
        .order("desc")
        .first();
      const kind =
        typeof reply?.data?.kind === "string" ? (reply.data.kind as (typeof THREAD_REPLY_KINDS)[number]) : null;
      return {
        id: row._id,
        at: row.at,
        text: row.text,
        subject: row.subject ?? null,
        reply: reply === null ? null : { at: reply.at, text: reply.text, kind },
      };
    }));
    return messages.sort((a, b) => a.at - b.at);
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
