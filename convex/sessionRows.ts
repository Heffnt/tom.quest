// sessionRows.ts — where a session's rows come from.
//
// ONE TRANSCRIPT PATH (Tom's ruling of 2026-09-25, "I want one transcript
// path. dry absolutism."). A session's rows are its agent file's: the file the
// CLI itself writes, swept into claudeMessages under the session's runId. The
// session daemon writes no rows once it sends `rowsFromFiles`, which sets
// `rowsFrom: "runs"` on the session. Sessions from before that cutover keep
// the rows the daemon wrote, under their sessionId, until the backfill
// replaces them.
//
// Every reader of a session's rows asks rowSource below which of the two it
// is reading, so the answer is written once: the page (getMessages), the fork
// transcript (internalTranscriptPage), the delivered-turn echo
// (getPendingInbound) and the nightly learning's reply context.

import type { Doc, Id } from "./_generated/dataModel";
import { INBOUND_ROW_LABEL } from "../shared/session-constants.mjs";

/**
 * Which rows a session reads.
 *
 *   run     rowsFrom "runs" with its runId known: claudeMessages by runId.
 *   none    rowsFrom "runs" before the sweep or the daemon has named its run:
 *           there is nothing to read yet, and the daemon's old rows under the
 *           sessionId are not a stand-in for the file's.
 *   daemon  a session from before the cutover: claudeMessages by sessionId.
 */
export type RowSource =
  | { from: "run"; runId: string }
  | { from: "none" }
  | { from: "daemon"; sessionId: Id<"claudeSessions"> };

export function rowSource(
  session: Pick<Doc<"claudeSessions">, "_id" | "rowsFrom" | "runId">,
): RowSource {
  if (session.rowsFrom !== "runs") return { from: "daemon", sessionId: session._id };
  return session.runId === undefined ? { from: "none" } : { from: "run", runId: session.runId };
}

/** The last line of a turn Tom typed, as it arrives in the agent file's user
 *  row: a blank line, the label, one space, the claudeInbound id. */
const LABEL_PATTERN = INBOUND_ROW_LABEL.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
const INBOUND_LINE = new RegExp(`\\n\\n${LABEL_PATTERN} ([A-Za-z0-9_-]+)\\s*$`);

/**
 * The claudeInbound id a user row's text ends with, or null. This names which
 * of Tom's turns the row is; it is text in a file, so a caller that acts on it
 * checks the row it names (getPendingInbound).
 */
export function inboundRowIdOf(content: unknown): string | null {
  const text = typeof content === "string"
    ? content
    : (content as { text?: unknown } | null | undefined)?.text;
  if (typeof text !== "string") return null;
  return INBOUND_LINE.exec(text)?.[1] ?? null;
}
