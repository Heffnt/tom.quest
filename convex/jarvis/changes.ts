// changes.ts — the changes table: one row per branch headed for main of one of
// the box's own repositories (/var/lib/tts/git/<name>.git), the row that
// replaces a pull request (the redesign of 2026-10-06, sections 8.1 and 12.2).
//
// TWO WRITERS, BOTH PROGRAMS ON THE BOX, never an agent:
//   - the receiving hook (Jarvis worker/git-hooks/receive.mjs, post-receive),
//     on every push of a branch other than main: state checking, with the
//     head, the author, the head commit message's first line and the rest, and
//     whether the message carries the trailer "Complex: yes";
//   - the gate job (Jarvis worker/git-hooks/gate.mjs), which runs the checks on
//     that head and writes the outcome: blocked (a check failed, with the
//     reason), rejected (the audit refused it, with its findings) or landed
//     (main was fast-forwarded to the head).
//
// POST /jarvis/change { repo, branch, head, state, pushedAt?, author?,
// title?, description?, complex?, base?, auditRequired?, auditWhy?, reason? }
// (pushedAt, author and title are required with state checking):
//   - state checking opens the branch's change at `head`, or moves the open
//     one there (a later push of the same branch re-runs its checks). A
//     branch whose newest row is landed gets a new row, so a landed row stays
//     as history. Checking for a head any row of the branch has landed
//     changes nothing. It carries `pushedAt`, when the box received the push
//     (its receiving hook's stamp, which the gate job sends again from its
//     queue): two posts for one branch can arrive out of order, and a post
//     for another head not pushed after the row's own is refused, so the row
//     never moves back to an older head; and a blocked or rejected row is
//     reopened for its own head only by a later push of it, so a duplicate
//     post never erases the gate job's outcome.
//   - any other state applies only to the row at that same head that has not
//     landed: a job finishing an older head after a newer push must not
//     overwrite the newer head's state. Answers { ok, applied, id?, why? }.
// GET /jarvis/changes?repo=&branch=&limit=: newest first; all repositories,
// one repository, or one branch of one repository (a branch alone is refused).
//
// Text fields come from commit messages and check output, so each is redacted
// (shared/redact.mjs) and capped before it is stored.

import { v } from "convex/values";
import { httpAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { redactSecrets } from "../../shared/redact.mjs";
import { jarvisAuth, jsonResponse } from "./auth";

const CHANGE_STATES = ["checking", "blocked", "landed", "rejected"] as const;
type ChangeState = (typeof CHANGE_STATES)[number];

const TITLE_MAX = 300;
const DESCRIPTION_MAX = 4_000;
const REASON_MAX = 2_000;
const LIST_MAX = 100;

const stateValidator = v.union(v.literal("checking"), v.literal("blocked"), v.literal("landed"), v.literal("rejected"));

function clean(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  const redacted = String(redactSecrets(text)).trim();
  if (redacted === "") return undefined;
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

export const write = internalMutation({
  args: {
    repo: v.string(),
    branch: v.string(),
    head: v.string(),
    state: stateValidator,
    author: v.optional(v.string()),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    complex: v.optional(v.boolean()),
    pushedAt: v.optional(v.number()),
    base: v.optional(v.string()),
    auditRequired: v.optional(v.boolean()),
    auditWhy: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ applied: boolean; id?: string; why?: string }> => {
    const now = Date.now();
    const newest = await ctx.db
      .query("changes")
      .withIndex("by_repo_and_branch", (q) => q.eq("repo", args.repo).eq("branch", args.branch))
      .order("desc")
      .first();
    const checked = {
      ...(args.base !== undefined ? { base: args.base } : {}),
      ...(args.auditRequired !== undefined ? { auditRequired: args.auditRequired } : {}),
      ...(args.auditWhy !== undefined ? { auditWhy: clean(args.auditWhy, REASON_MAX) } : {}),
    };
    if (args.state === "checking") {
      const landedHere = await ctx.db
        .query("changes")
        .withIndex("by_repo_and_branch_and_head", (q) => q.eq("repo", args.repo).eq("branch", args.branch).eq("head", args.head))
        .filter((q) => q.eq(q.field("state"), "landed"))
        .first();
      if (landedHere !== null) {
        return { applied: false, id: landedHere._id, why: `${args.head.slice(0, 7)} already landed` };
      }
      if (
        newest !== null && newest.head !== args.head
        // Not later is refused, equal included: two heads with one stamp
        // cannot be ordered, and the row keeps the head it holds.
        && newest.pushedAt !== undefined && args.pushedAt !== undefined && args.pushedAt <= newest.pushedAt
      ) {
        return { applied: false, id: newest._id, why: `${args.head.slice(0, 7)} was not pushed after the row's ${newest.head.slice(0, 7)}` };
      }
      // A blocked or rejected row holds the gate job's finished outcome for
      // its head. Only a later push of that head (a later stamp) reopens it; a
      // duplicate or delayed post of the same push changes nothing.
      if (
        newest !== null && newest.head === args.head && (newest.state === "blocked" || newest.state === "rejected")
        && !(args.pushedAt !== undefined && newest.pushedAt !== undefined && args.pushedAt > newest.pushedAt)
      ) {
        return { applied: false, id: newest._id, why: `${args.head.slice(0, 7)} was already checked: ${newest.state}` };
      }
      const pushedAt = newest !== null && newest.head === args.head && newest.pushedAt !== undefined
        ? Math.max(newest.pushedAt, args.pushedAt ?? 0)
        : args.pushedAt;
      const opened = {
        ...(pushedAt !== undefined ? { pushedAt } : {}),
        head: args.head,
        author: clean(args.author, TITLE_MAX) ?? newest?.author ?? "unknown",
        title: clean(args.title, TITLE_MAX) ?? newest?.title ?? "(no message)",
        description: clean(args.description, DESCRIPTION_MAX),
        complex: args.complex ?? false,
        state: "checking" as const,
        reason: undefined,
        landedAt: undefined,
        updatedAt: now,
        ...checked,
      };
      if (newest !== null && newest.state !== "landed") {
        // A new head starts its checks afresh: what the old head's checks said
        // about the audit no longer holds.
        const reset = newest.head === args.head ? {} : { base: undefined, auditRequired: undefined, auditWhy: undefined };
        await ctx.db.patch(newest._id, { ...reset, ...opened });
        return { applied: true, id: newest._id };
      }
      const id = await ctx.db.insert("changes", {
        repo: args.repo,
        branch: args.branch,
        createdAt: now,
        ...opened,
      });
      return { applied: true, id };
    }
    if (newest === null) return { applied: false, why: `no change row for ${args.repo} ${args.branch}` };
    if (newest.head !== args.head) {
      return { applied: false, id: newest._id, why: `the row is at ${newest.head.slice(0, 7)}, not ${args.head.slice(0, 7)}` };
    }
    if (newest.state === "landed") return { applied: false, id: newest._id, why: `${args.head.slice(0, 7)} already landed` };
    // A blocked or rejected row is the finished outcome for its head: a
    // delayed or duplicate outcome of the same head changes nothing, and only
    // a later push of the head (a later stamp, above) reopens it.
    if (newest.state !== "checking") return { applied: false, id: newest._id, why: `${args.head.slice(0, 7)} was already checked: ${newest.state}` };
    await ctx.db.patch(newest._id, {
      state: args.state,
      reason: args.state === "landed" ? undefined : clean(args.reason, REASON_MAX),
      ...(args.state === "landed" ? { landedAt: now } : {}),
      updatedAt: now,
      ...checked,
    });
    return { applied: true, id: newest._id };
  },
});

export const list = internalQuery({
  args: { repo: v.optional(v.string()), branch: v.optional(v.string()), limit: v.number() },
  handler: async (ctx, { repo, branch, limit }): Promise<Doc<"changes">[]> => {
    const take = Math.max(1, Math.min(LIST_MAX, Math.floor(limit)));
    // A branch is named within a repository; the route refuses one alone.
    if (branch !== undefined && repo === undefined) throw new Error("branch needs repo");
    if (repo !== undefined && branch !== undefined) {
      return await ctx.db
        .query("changes")
        .withIndex("by_repo_and_branch", (q) => q.eq("repo", repo).eq("branch", branch))
        .order("desc")
        .take(take);
    }
    if (repo !== undefined) {
      return await ctx.db
        .query("changes")
        .withIndex("by_repo_and_updatedAt", (q) => q.eq("repo", repo))
        .order("desc")
        .take(take);
    }
    return await ctx.db.query("changes").withIndex("by_updatedAt").order("desc").take(take);
  },
});

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export const postChange = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
  const repo = text(b.repo);
  const branch = text(b.branch);
  const head = text(b.head);
  if (!repo || !branch || !head) return jsonResponse(400, { error: "repo, branch and head (non-empty strings) required" });
  if (!SHA.test(head)) return jsonResponse(400, { error: "head must be a full commit id" });
  if (branch === "main") return jsonResponse(400, { error: "main is what a change lands on, not a change" });
  if (!(CHANGE_STATES as readonly string[]).includes(String(b.state))) {
    return jsonResponse(400, { error: `state must be one of ${CHANGE_STATES.join(", ")}` });
  }
  const state = b.state as ChangeState;
  for (const member of ["complex", "auditRequired"]) {
    if (b[member] !== undefined && typeof b[member] !== "boolean") return jsonResponse(400, { error: `${member}, when given, must be a boolean` });
  }
  const base = text(b.base);
  if (base !== undefined && !SHA.test(base)) return jsonResponse(400, { error: "base, when given, must be a full commit id" });
  if (b.pushedAt !== undefined && !(typeof b.pushedAt === "number" && Number.isFinite(b.pushedAt) && b.pushedAt > 0)) {
    return jsonResponse(400, { error: "pushedAt, when given, must be a time in ms" });
  }
  if (state === "checking" && (!text(b.author) || !text(b.title) || b.pushedAt === undefined)) {
    return jsonResponse(400, { error: "author, title and pushedAt are required when a change opens" });
  }
  const result = await ctx.runMutation(internal.jarvis.changes.write, {
    repo,
    branch,
    head,
    state,
    ...(text(b.author) ? { author: text(b.author) } : {}),
    ...(text(b.title) ? { title: text(b.title) } : {}),
    ...(text(b.description) ? { description: text(b.description) } : {}),
    ...(typeof b.complex === "boolean" ? { complex: b.complex } : {}),
    ...(typeof b.pushedAt === "number" ? { pushedAt: b.pushedAt } : {}),
    ...(base ? { base } : {}),
    ...(typeof b.auditRequired === "boolean" ? { auditRequired: b.auditRequired } : {}),
    ...(text(b.auditWhy) ? { auditWhy: text(b.auditWhy) } : {}),
    ...(text(b.reason) ? { reason: text(b.reason) } : {}),
  });
  return jsonResponse(200, { ok: true, ...result });
});

export const getChanges = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const repo = url.searchParams.get("repo") || undefined;
  const branch = url.searchParams.get("branch") || undefined;
  if (branch !== undefined && repo === undefined) return jsonResponse(400, { error: "branch needs repo" });
  const limit = Number(url.searchParams.get("limit") ?? 20);
  if (!Number.isFinite(limit) || limit < 1) return jsonResponse(400, { error: "limit must be a positive number" });
  const rows = await ctx.runQuery(internal.jarvis.changes.list, { repo, branch, limit });
  return jsonResponse(200, { ok: true, changes: rows });
});
