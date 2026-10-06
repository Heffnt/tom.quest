// sessionRegistration.ts — the record's half of two facts the box's programs
// write about sessions it did not start (design section 12.3):
//
//   1. A session row keyed by the Claude session id, written by the
//      SessionStart hook (Jarvis scripts/agent-hook.mjs) for a session Claude
//      Desktop or a shell started. The sessions page lists it, and the session
//      host runs a reply on it by that id (claudeSessions.internalPoll lists it
//      once a message makes it the host's).
//   2. A row per subagent a session dispatched, written by the SubagentStart
//      and SubagentStop hooks; the session host reads the running ones to
//      resume a subagent whose parent process is gone.
//
// POST /agents/session-register, POST /agents/subagent and
// GET /sessions/subagents/running (convex/http.ts) are the routes, under the
// sessions key.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { SESSION_LOGIN } from "./ttsShared";

const TITLE_MAX = 200;
const BRIEF_MAX = 4096;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Write or update the row of a session by its Claude session id.
 *
 * A new row is an idle interactive session on no repository, held by the
 * client that started it. On an existing row: `client` changes only on a row
 * this registration made (a row the host created carries none, and the host
 * keeps holding it); the title is filled only while it is empty; the login
 * only while it is absent, because after that it is the sessions page's
 * selector that says which login runs the session.
 */
export const internalRegisterSession = internalMutation({
  args: {
    sdkSessionId: v.string(),
    client: v.union(v.literal("desktop"), v.literal("host")),
    login: v.optional(SESSION_LOGIN),
    transcriptPath: v.optional(v.string()),
    cwd: v.optional(v.string()),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const title = args.title === undefined ? undefined : cut(args.title.trim(), TITLE_MAX);
    const existing = await ctx.db
      .query("claudeSessions")
      .withIndex("by_sdk_session_id", (q) => q.eq("sdkSessionId", args.sdkSessionId))
      .first();
    if (existing === null) {
      const id = await ctx.db.insert("claudeSessions", {
        title: title ?? "",
        kind: "adhoc",
        repos: [],
        repo: "none",
        mode: "interactive",
        status: "idle",
        statusChangedAt: now,
        sdkSessionId: args.sdkSessionId,
        client: args.client,
        ...(args.login !== undefined ? { login: args.login } : {}),
        ...(args.transcriptPath !== undefined ? { transcriptPath: args.transcriptPath } : {}),
        ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
        nextSeq: 0,
        createdAt: now,
      });
      return { id, created: true };
    }
    const patch: Record<string, unknown> = {};
    if (existing.client !== undefined && existing.client !== args.client) patch.client = args.client;
    if (args.transcriptPath !== undefined && existing.transcriptPath !== args.transcriptPath) patch.transcriptPath = args.transcriptPath;
    if (args.cwd !== undefined && existing.cwd === undefined) patch.cwd = args.cwd;
    if (title && existing.title === "") patch.title = title;
    if (args.login !== undefined && existing.login === undefined) patch.login = args.login;
    if (Object.keys(patch).length > 0) await ctx.db.patch(existing._id, patch);
    return { id: existing._id, created: false };
  },
});

/**
 * One event of a subagent's life: its start (the row is written, state
 * running), its report (state reported) or its end with no report, and a
 * resume by the session host. Idempotent: a start for a row that exists
 * changes nothing, and an end of an ended row changes nothing.
 */
export const internalSubagentEvent = internalMutation({
  args: {
    event: v.union(v.literal("start"), v.literal("reported"), v.literal("ended-without-report"), v.literal("resumed")),
    agentId: v.string(),
    parentSessionId: v.optional(v.string()),
    transcriptPath: v.optional(v.string()),
    brief: v.optional(v.string()),
    login: v.optional(v.string()),
    cwd: v.optional(v.string()),
    resumedSessionId: v.optional(v.string()),
    resumedTranscriptPath: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const row = await ctx.db
      .query("subagentRuns")
      .withIndex("by_agent_id", (q) => q.eq("agentId", args.agentId))
      .first();
    if (args.event === "start") {
      if (row !== null) return { id: row._id, changed: false };
      if (!args.parentSessionId || !args.transcriptPath) throw new Error("a subagent's start needs parentSessionId and transcriptPath");
      const id = await ctx.db.insert("subagentRuns", {
        agentId: args.agentId,
        parentSessionId: args.parentSessionId,
        transcriptPath: args.transcriptPath,
        brief: cut(args.brief ?? "", BRIEF_MAX),
        state: "running",
        ...(args.login !== undefined ? { login: args.login } : {}),
        ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
        startedAt: now,
      });
      return { id, changed: true };
    }
    if (row === null) return { id: null, changed: false };
    if (args.event === "resumed") {
      await ctx.db.patch(row._id, {
        resumedAt: now,
        resumeCount: (row.resumeCount ?? 0) + 1,
        ...(args.resumedSessionId !== undefined ? { resumedSessionId: args.resumedSessionId } : {}),
        ...(args.resumedTranscriptPath !== undefined ? { resumedTranscriptPath: args.resumedTranscriptPath } : {}),
      });
      return { id: row._id, changed: true };
    }
    if (row.state === args.event) return { id: row._id, changed: false };
    // A report outranks an ending without one; nothing outranks a report.
    if (row.state === "reported") return { id: row._id, changed: false };
    await ctx.db.patch(row._id, { state: args.event, endedAt: now });
    return { id: row._id, changed: true };
  },
});

/** The subagents still running, oldest first, for the session host's check. */
export const internalRunningSubagents = internalQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db
      .query("subagentRuns")
      .withIndex("by_state", (q) => q.eq("state", "running"))
      .take(100)).map((row) => ({
      agentId: row.agentId,
      parentSessionId: row.parentSessionId,
      transcriptPath: row.transcriptPath,
      login: row.login,
      cwd: row.cwd,
      startedAt: row.startedAt,
      resumedAt: row.resumedAt,
      resumeCount: row.resumeCount ?? 0,
      resumedSessionId: row.resumedSessionId,
      resumedTranscriptPath: row.resumedTranscriptPath,
    })),
});
