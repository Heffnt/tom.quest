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

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function home(d: Record<string, unknown>): string | null {
  const repo = str(d.repo);
  return repo !== "" && Object.prototype.hasOwnProperty.call(SESSION_REPOS, repo)
    ? SESSION_REPOS[repo as keyof typeof SESSION_REPOS].toString()
    : null;
}

/** One agent change as the thread renders it: its line, and a link when the
 *  row carries a repo known to SESSION_REPOS and the fields a link needs. A
 *  malformed row yields the line it can and no link; nothing here throws. */
export function agentChange(row: Doc<"events">): { line: string; href: string | null } {
  const d = (typeof row.data === "object" && row.data !== null ? row.data : {}) as Record<string, unknown>;
  const base = home(d);
  const link = base === null ? null : (path: string) => `https://github.com/${base}/${path}`;
  switch (row.kind) {
    case "merge": {
      const sha = str(d.sha);
      return {
        line: `Merged ${str(d.repo)} ${sha.slice(0, 7)}: ${str(d.subject)}`,
        href: sha !== "" && link !== null ? link(`commit/${sha}`) : null,
      };
    }
    case "deploy": {
      const from = str(d.from);
      const to = str(d.to);
      const commits = Array.isArray(d.commits) ? d.commits : [];
      return {
        line: `Deployed ${str(d.repo)} ${from.slice(0, 7)}..${to.slice(0, 7)}, ${commits.length} commit(s)`,
        href: from !== "" && to !== "" && link !== null ? link(`compare/${from}...${to}`) : null,
      };
    }
    case "learning-change": {
      const section = str(d.section);
      const commit = str(d.modelOfTomCommit);
      return {
        line: `Changed ${str(d.file)}${section !== "" ? ` § ${section}` : ""}`,
        href: commit !== "" ? `https://github.com/Heffnt/WikiTom/commit/${commit}` : null,
      };
    }
    case "repo-proposal-applied": {
      const commit = str(d.commit);
      return {
        line: `Added a rule to ${str(d.repo)} ${str(d.file)}: ${str(d.appliedLine)}`,
        href: commit !== "" && link !== null ? link(`commit/${commit}`) : null,
      };
    }
    default:
      return { line: "", href: null };
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
    const changes = await Promise.all(
      AGENT_CHANGE_KINDS.map(async (kind) => {
        const byKind = await ctx.db
          .query("events")
          .withIndex("by_kind_at", (q) => q.eq("kind", kind).gte("at", since))
          .order("desc")
          .take(200);
        return byKind.map((row) => {
          const { line, href } = agentChange(row);
          return { id: row._id, at: row.at, kind, line, href };
        });
      }),
    );
    return {
      messages: messages.sort((a, b) => a.at - b.at),
      changes: changes.flat().sort((a, b) => a.at - b.at),
    };
  },
});
