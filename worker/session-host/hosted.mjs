// hosted.mjs — what the daemon does with a HOSTED run between its turns.
//
// A hosted run is an unattended run the daemon keeps alive across turns so a
// message can reach it mid-run: the orchestrator (one long-lived run that
// hands work out) and each worker the orchestrator spawned (Tom, 2026-09-21).
// The server says which rows are hosted (the poll row's `environment`, read
// off the hostedRuns table in convex/orchestrator.ts). Every other unattended
// session keeps the one-turn life session.mjs has always given it.
//
// Dependency-free so the repo's vitest can run it
// (`__tests__/hosted.test.mjs`); session.mjs cannot be imported there.

/** The last line of the orchestrator's final message when it asks to be
 * restarted from its document. MIRROR of ORCHESTRATOR_COMPACT_WORD in
 * convex/ttsShared.ts; scripts/check-session-mirrors.mjs fences the two. */
export const ORCHESTRATOR_COMPACT_WORD = "JARVIS-COMPACT";

/** The endedReason a compaction ends with. convex/orchestrator.ts reads it to
 * tell a compaction (restart now, crash count cleared) from a crash. */
export const COMPACT_ENDED_REASON = "orchestrator compacted";

/**
 * How long a hosted worker with an open elevation waits, idle, for its answer.
 * A reserved decision waits on Tom, who may not reply for a day, and an idle
 * worker holds one of the four hosted places the whole time; past this the
 * worker ends and the orchestrator is told, and the answer, when it comes, is
 * still recorded on the elevation. It cannot be deleted because without it a
 * question Tom never answers holds a place for ever.
 */
export const WORKER_ANSWER_WAIT_MS = 12 * 60 * 60 * 1000;

/**
 * The run envelope's three names for a daemon session: where it starts, what
 * kind of run it is, and its environment. An interactive session is a session
 * with Tom; an unattended one is a worker; the orchestrator's runs start where
 * every unattended session does and name their own environment.
 */
export function runEnvelope(mode, environment) {
  if (environment === "orchestrator") return { origin: "daemon", kind: "job", environment: "orchestrator" };
  if (mode === "autonomous") return { origin: "daemon", kind: "job", environment: "worker" };
  return { origin: "session", kind: "session", environment: "session" };
}

/** True when the orchestrator's final message asks to compact: its last
 * non-empty line is exactly the word. */
export function asksToCompact(text) {
  if (typeof text !== "string") return false;
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines.length > 0 && lines[lines.length - 1] === ORCHESTRATOR_COMPACT_WORD;
}

/**
 * What a hosted run does at the end of a turn that succeeded (a failed turn
 * ends it errored, as for any unattended session). The orchestrator ends only when it
 * asks to compact; otherwise it goes idle and waits for its next message. A
 * worker goes idle too and waits for the next poll to say whether it is done
 * (hostedIdleVerdict), because the pens it called during the turn are read by
 * the server, not by this daemon.
 *
 * @returns {"compact" | "idle"}
 */
export function hostedTurnEnd({ environment, finalText }) {
  return environment === "orchestrator" && asksToCompact(finalText) ? "compact" : "idle";
}

/**
 * What an idle hosted run does on a poll, once any message waiting for it has
 * been handed over (session.mjs calls this only when none is being delivered). `idleSince` is when its last turn
 * ended; `polledAt` is when the poll carrying the server's facts was sent. A
 * poll sent before the turn ended cannot have seen an elevation or an outcome
 * the turn wrote, so it decides nothing.
 *
 * @returns {"wait" | "end" | "end-waited"}
 */
export function hostedIdleVerdict({
  environment,
  outcomeRecorded,
  openElevations,
  idleSince,
  polledAt,
  now,
}) {
  // The orchestrator lives until it compacts, crashes or is stopped.
  if (environment !== "worker") return "wait";
  if (typeof idleSince !== "number" || typeof polledAt !== "number" || polledAt <= idleSince) return "wait";
  if (outcomeRecorded) return "end";
  if (openElevations > 0) return now - idleSince >= WORKER_ANSWER_WAIT_MS ? "end-waited" : "wait";
  return "end";
}

/** The slugs a `codex debug models` catalog lists for use (visibility
 * "list"); session-host.mjs reports them on the heartbeat. */
export function listedCodexModels(text) {
  const models = JSON.parse(text)?.models;
  if (!Array.isArray(models)) throw new Error("codex debug models printed no model list");
  return models.filter((m) => m?.visibility === "list").map((m) => m.slug);
}
