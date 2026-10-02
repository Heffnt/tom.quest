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
        typeof reply?.data?.kind === "string" ? (reply.data.kind as "fact" | "todo" | "rule" | "errand" | "question") : null;
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
        return byKind.map((row) => {
          const { line, href } = agentChange({ ...row, kind } as AgentChangeRow);
          return { id: row._id, at: row.at, kind, line, href };
        });
      }),
    );
    return changes.flat().sort((a, b) => a.at - b.at);
  },
});
