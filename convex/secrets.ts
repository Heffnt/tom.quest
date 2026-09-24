// The /secrets mailbox: Tom pastes a value on tom.quest/secrets, the
// session-host daemon on the Jarvis Box takes it into /etc/tts/worker.env, and
// the value is then deleted here. Convex holds a value only while a delivery
// is waiting; afterwards the row keeps the name and the two dates.
//
// WHO READS A VALUE. Nobody through a query: `list` returns names and dates
// only, to Tom too. The one reader is `internalPending`, reached only through
// GET /sessions/secrets in convex/http.ts, behind SESSIONS_WORKER_KEY — the
// daemon's own key, which worker/session-host/env-scrub.mjs keeps out of every
// agent's shell. It is deliberately NOT the TTS_WORKER_KEY door: that key is
// in every session's shell and every cron job's agentic run, so a pending
// value behind it would be one curl away from any agent.
//
// NO VALUE IN AN ERROR. Every refusal below names the variable, never the
// value, because a thrown message reaches the browser, the Convex logs and,
// through a failed HTTP call, the daemon's journal.

import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireTom } from "./authRoles";

const LABEL = "Secrets";

// An env-file variable name: what worker-env.mjs's loadEnv and systemd's
// EnvironmentFile both read back as one key.
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
// Far above any API key or token; a bound so the row stays small.
const SECRET_VALUE_MAX = 16 * 1024;

export const set = mutation({
  args: { name: v.string(), value: v.string() },
  handler: async (ctx, { name, value }) => {
    await requireTom(ctx, LABEL);
    if (!SECRET_NAME.test(name)) {
      throw new Error("name must be upper-case letters, digits and underscores, not starting with a digit");
    }
    // A pasted value usually carries a trailing newline. Any line break or
    // NUL left inside would split the env file's NAME=value line in two.
    const trimmed = value.trim();
    if (trimmed === "") throw new Error(`${name}: value is empty`);
    if (/[\r\n\0]/.test(trimmed)) throw new Error(`${name}: value contains a line break`);
    if (trimmed.length > SECRET_VALUE_MAX) throw new Error(`${name}: value is longer than ${SECRET_VALUE_MAX} characters`);
    const now = Date.now();
    const row = await ctx.db
      .query("secretMailbox")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
    if (row) {
      // A new value replaces a waiting one, and a taken date belongs to the
      // value that was taken, so it goes.
      await ctx.db.replace(row._id, { name, value: trimmed, setAt: now });
    } else {
      await ctx.db.insert("secretMailbox", { name, value: trimmed, setAt: now });
    }
    return null;
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireTom(ctx, LABEL);
    const rows = await ctx.db.query("secretMailbox").collect();
    return rows
      .map((row) => ({
        name: row.name,
        setAt: row.setAt,
        ...(row.takenAt !== undefined ? { takenAt: row.takenAt } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

// Every value waiting for the box. `setAt` rides along so the taken report
// can say which value it took.
export const internalPending = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("secretMailbox").collect();
    return rows
      .filter((row) => row.value !== undefined)
      .map((row) => ({ name: row.name, value: row.value as string, setAt: row.setAt }));
  },
});

// The box wrote `name` into its env file. The value is deleted only when the
// row still holds the value the box read (`setAt` matches): if Tom set a new
// one while the delivery was in flight, the new value stays waiting and the
// next poll delivers it over the old line.
export const internalTaken = internalMutation({
  args: { name: v.string(), setAt: v.number() },
  handler: async (ctx, { name, setAt }) => {
    const row = await ctx.db
      .query("secretMailbox")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
    if (!row) return { ok: false as const, reason: "no such name" };
    if (row.setAt !== setAt) return { ok: false as const, reason: "replaced by a newer value" };
    if (row.value === undefined) return { ok: true as const };
    await ctx.db.replace(row._id, { name: row.name, setAt: row.setAt, takenAt: Date.now() });
    return { ok: true as const };
  },
});
