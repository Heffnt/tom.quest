// thread.ts — the Jarvis thread's record side: Tom's one standing conversation
// with Jarvis, on the /thread page. A message he types is an appended row of
// the record's append-only `events` table, never a state row: it is written
// only through insertEvent, and a box job (a later change) reads those rows
// and appends its one-line reply under each.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTom } from "./authRoles";
import { insertEvent } from "./jarvis/record";
import { DAY_LOG_ENTRY_MAX } from "./dayLog";

const SURFACE = "Thread";

export const send = mutation({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    await requireTom(ctx, SURFACE);
    if (text.trim() === "") throw new Error("A message cannot be empty");
    if (text.length > DAY_LOG_ENTRY_MAX) throw new Error(`A message is at most ${DAY_LOG_ENTRY_MAX} characters`);
    const id = await insertEvent(ctx, {
      kind: "thread-message",
      at: Date.now(),
      provenance: { user: "tom" },
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
        typeof reply?.data?.kind === "string" ? (reply.data.kind as "fact" | "todo" | "rule" | "errand" | "question") : null;
      return {
        id: row._id,
        at: row.at,
        text: row.text,
        reply: reply === null ? null : { at: reply.at, text: reply.text, kind },
      };
    }));
    return messages.sort((a, b) => a.at - b.at);
  },
});
