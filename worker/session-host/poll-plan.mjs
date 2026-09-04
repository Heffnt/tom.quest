// poll-plan.mjs — what the poll walk does with ONE row of /sessions/poll,
// given the local Session it may already hold and the ids of every session
// the same poll lists. session-host.mjs's loop is a switch over the answer;
// the decision lives here, dependency-free, so the repo's vitest can pin it
// (__tests__/poll-plan.test.mjs) — session-host.mjs itself imports the Agent
// SDK through session.mjs and cannot be loaded there.
//
// The answers, in the order the walk checks them:
//   "wait"       a local we consider over is listed live again (Tom reopened
//                it in the window between our ending flush landing and the
//                reap) but its ending flush has not drained — its final rows
//                still belong in the transcript, so leave it one more poll
//   "readopt"    the same case, drained (or force-killed): drop the stale
//                local and adopt the row as a reopen
//   "reconcile"  a known live session: decisions, commands, defensive seq
//   "defer-fork" a fresh row that continues another session (forkedFrom)
//                whose source is STILL in this poll's live list: not claimed
//                yet. The source leaves the list when its stop lands and it
//                ends; claiming before that snapshots a transcript that stops
//                mid-turn (session.mjs #writeForkTranscript says why the
//                fetch must see the source's ending)
//   "claim"      a fresh row — or one a previous daemon died on before the
//                SDK ever reported an id (nothing to resume; start over)
//   "adopt"      a live row this daemon holds no local for: a restart, or a
//                reopen of a session it had already reaped
export function planRow(row, { local, liveIds }) {
  if (local && (local.dead || local.status === "ended" || local.status === "failed")) {
    if (!local.dead && !local.isDrained()) return "wait";
    return "readopt";
  }
  if (local) return "reconcile";
  if (row.status === "requested" || (row.status === "starting" && !row.sdkSessionId)) {
    if (
      row.forkedFrom !== undefined &&
      row.forkedFrom !== null &&
      liveIds.has(String(row.forkedFrom))
    ) {
      return "defer-fork";
    }
    return "claim";
  }
  return "adopt";
}
