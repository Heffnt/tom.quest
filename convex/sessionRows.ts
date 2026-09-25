// sessionRows.ts — where a session's rows come from, and the notes beside them.
//
// ONE TRANSCRIPT PATH (Tom's ruling of 2026-09-25, "I want one transcript
// path. dry absolutism."). A session's rows are its agent file's: the file the
// CLI itself writes, swept into claudeMessages under the session's runId.
// There is no second source. A session whose runId is not known yet has no
// rows to read.
//
// Every reader of a session's rows asks rowSource below, so the answer is
// written once: the page (getMessages), the fork transcript
// (internalTranscriptPage), the delivered-turn echo (getPendingInbound), the
// poll's newest row and the nightly learning's reply context.
//
// What the daemon knows about a session that is not in the agent file — the
// model changed, the workspace was rebuilt, work was preserved or discarded,
// the time cap fired — is a NOTE, not a row: the sessionNotes table, written
// through the ingest's `notes` and drawn on the page between the rows by time.

import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireTom } from "./authRoles";
import { INBOUND_ROW_LABEL } from "../shared/session-constants.mjs";

/**
 * Which rows a session reads.
 *
 *   run   its runId is known: claudeMessages by runId.
 *   none  no runId: a session before the sweep or the daemon has named its
 *         run, where there is nothing to read yet; or one of the two sessions
 *         that failed on 2026-09-01 before any file was written. The page
 *         shows such a session's status, endedReason and notes over no rows.
 */
export type RowSource = { from: "run"; runId: string } | { from: "none" };

export function rowSource(session: Pick<Doc<"claudeSessions">, "runId">): RowSource {
  return session.runId === undefined ? { from: "none" } : { from: "run", runId: session.runId };
}

/** The last line of a turn Tom typed, as it arrives in the agent file's user
 *  row: a blank line, the label, one space, the claudeInbound id. */
const LABEL_PATTERN = INBOUND_ROW_LABEL.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
const INBOUND_LINE = new RegExp(`\\n\\n${LABEL_PATTERN} ([A-Za-z0-9_-]+)\\s*$`);

/**
 * The claudeInbound id a user row's text ends with, or null. This names which
 * of Tom's turns the row is; it is text in a file, so a caller that acts on it
 * checks the row it names (convex/agents.ts sessionReplyLabel,
 * getPendingInbound).
 */
export function inboundRowIdOf(content: unknown): string | null {
  const text = typeof content === "string"
    ? content
    : (content as { text?: unknown } | null | undefined)?.text;
  if (typeof text !== "string") return null;
  return INBOUND_LINE.exec(text)?.[1] ?? null;
}

// ── Notes ────────────────────────────────────────────────────────────────────

/** A note's text is cut to this many UTF-8 bytes at insert. A note is one
 *  line about what happened (a git error, a stderr tail), never a payload. */
const NOTE_TEXT_MAX_BYTES = 1024;

/** The notes one read returns, newest kept. A session carries a handful. */
const NOTES_READ_MAX = 500;

/** The ingest's `notes` field: what happened and when, as the daemon saw it. */
export const NOTES = v.array(v.object({ at: v.number(), text: v.string() }));

/** `text` cut to `maxBytes` of UTF-8 on a code point boundary. */
function capUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += char;
  }
  return out;
}

/**
 * Insert the daemon's notes. The ingest is a blind retry, so a note already
 * stored with the same instant and text is not stored twice. Accepted on a
 * terminal or stale payload too, exactly as rows were: a note is a fact about
 * what happened, not session state.
 */
export async function appendNotes(
  ctx: MutationCtx,
  sessionId: Id<"claudeSessions">,
  notes: ReadonlyArray<{ at: number; text: string }>,
): Promise<void> {
  for (const note of notes) {
    const text = capUtf8(note.text.trim(), NOTE_TEXT_MAX_BYTES);
    if (text === "" || !Number.isFinite(note.at)) continue;
    const sameInstant = await ctx.db
      .query("sessionNotes")
      .withIndex("by_session_at", (q) => q.eq("sessionId", sessionId).eq("at", note.at))
      .take(20);
    if (sameInstant.some((stored) => stored.text === text)) continue;
    await ctx.db.insert("sessionNotes", { sessionId, at: note.at, text });
  }
}

/** A session's notes, oldest first — the page draws them between its rows. */
export const notes = query({
  args: { sessionId: v.id("claudeSessions") },
  handler: async (ctx, { sessionId }) => {
    await requireTom(ctx, "Sessions");
    const newest = await ctx.db
      .query("sessionNotes")
      .withIndex("by_session_at", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .take(NOTES_READ_MAX);
    return newest.reverse();
  },
});
