// models.mjs — which Claude model each box job runs on, and the model ceiling
// that stands in for Fable while Tom's account has no Fable usage left.
//
// ONE HOME. Every job, the delegate, the digest writer, the evals pass and the
// session daemon's classifier take their model from MODELS below. Every path
// on the box that turns a requested model into the one actually run applies
// underCeiling(): box-run.mjs's prepareRun for every `tts-run` and every job's
// runClaude, and worker/session-host/session.mjs's modelSpec() for a session
// the daemon starts. A change of tier is one line here.
//
// This file imports no other file of this repository, so it lands beside
// box-run.mjs at /opt/tts/runs/ with the `cp .../runs/*.mjs` line in
// worker/setup.sh and every layout reaches it: the session daemon by
// ../runs/models.mjs, and the jobs through tts-lib.mjs, which loads it from the
// directory it found the launcher in.
//
// The session model names Tom picks from (opus, sonnet, fable and the Codex
// models) are a different table: convex/ttsShared.ts SESSION_MODELS, mirrored
// in session.mjs. The ceiling applies to those too, in modelSpec().

import fs from "node:fs";
import path from "node:path";

// THE MODEL CEILING. Tom's rulings, 2026-09-24, verbatim: "lets keep the box on
// my wpi claude account even though it is out of fable usage and have it max
// out at opus for now. even for delegate. I want to save my usage for my
// heffnt account for personal use." and "make sure that the opus ceiling is
// temporary and we switch back to fable when my weekly limit resets."
//
// The ceiling is a STATE, not a setting: the Fable availability file below.
// While it says Fable is unavailable, a request for Fable runs this model
// instead, and the log line and the record say "fable requested, opus at the
// ceiling". A run that asked for Fable and was refused for a spend or usage
// limit sets it unavailable (box-run.mjs, session.mjs); the session daemon's
// hourly Fable probe sets it available again (box-run.mjs probeFable). Nothing
// is edited to lift the ceiling: the first probe Fable answers lifts it.
export const MODEL_CEILING = "opus";

// THE MODEL EACH ROLE RUNS ON. Sonnet is the budget model: Tom's ruling,
// 2026-09-24, verbatim: "I want to stop using haiku for anything and switch to
// sonnet as the budget anthropic model."
//
// The keys are roles, not job names, so two jobs doing the same shape of work
// cannot drift apart:
//
//   planner          the planning passes (prepare a life todo, plan the
//                    graphs): judgment over Tom's own words and his goals.
//   triage           a capture verdict over a batch of inbound items (Gmail,
//                    Canvas): classify-shaped, high volume, the budget model.
//   timeNotes        reading one of Tom's time sentences into actions.
//   simplify         the weekly simplification pass (worker/jobs/simplify.mjs).
//                    Its id is spelled in full so the model recorded on the run
//                    matches its row in worker/runs/prices.mjs.
//   delegate         tts-ask, the delegate (worker/jobs/delegate.mjs).
//   digest           the Slack writer (worker/jobs/write-slack.mjs): writing to
//                    Tom in his own register.
//   evalsRegen       the evals pass's rewrite of an item (worker/jobs/evals.mjs).
//   evalsJudge       the evals pass's judge, and the runner check-in's.
//   evalsFaultAudit  the evals pass's planted-fault audit.
//   learning         the nightly learning pass (worker/jobs/nightly.mjs).
//   weekly           the Friday agenda (worker/jobs/weekly.mjs).
//   removalActuator  the removal loop's box run (worker/jobs/removal-loop.mjs).
//   classifier       the session daemon's Bash danger classifier
//                    (worker/session-host/session.mjs).
//
// Three of these read an environment override first (TTS_EVALS_*_MODEL and
// TTS_LEARNING_MODEL, at their use); the ceiling applies to an override too.
export const MODELS = Object.freeze({
  planner: "opus",
  triage: "claude-sonnet-5",
  timeNotes: "claude-sonnet-5",
  simplify: "claude-fable-5-1",
  delegate: "fable",
  digest: "fable",
  evalsRegen: "sonnet",
  evalsJudge: "fable",
  evalsFaultAudit: "opus",
  learning: "opus",
  weekly: "opus",
  removalActuator: "opus",
  classifier: "claude-sonnet-5",
});

// The Claude tiers from the lowest to the highest. A model name is read by the
// tier word it contains, so the aliases the CLI takes ("opus") and the full ids
// ("claude-fable-5-1") compare alike.
const CLAUDE_TIERS = ["haiku", "sonnet", "opus", "fable"];

/** The tier word of a Claude model name, or null for anything else (a Codex
 *  model, an empty value). */
function claudeTierOf(model) {
  if (typeof model !== "string") return null;
  const lower = model.toLowerCase();
  return CLAUDE_TIERS.find((tier) => lower.includes(tier)) ?? null;
}

/** Whether a model is above the ceiling: today, whether it is Fable. */
export function aboveCeiling(model) {
  const tier = claudeTierOf(model);
  return tier !== null && CLAUDE_TIERS.indexOf(tier) > CLAUDE_TIERS.indexOf(MODEL_CEILING);
}

// ── Fable availability ───────────────────────────────────────────────────────
//
// One small JSON file in the box's run state directory (runConfig's stateDir,
// /var/cache/tts/runs on the box), written by the launcher and the session
// daemon and read by both before a run starts:
//
//   { available: boolean, since: ms, checkedAt: ms, reason?: string }
//
// `since` is when the value last changed; `checkedAt` is the last time a run
// or a probe found it out. An absent or unreadable file reads as available:
// the first Fable run then either answers or is refused and writes the file,
// so a cleared cache costs one refused call. The daemon reports the file on
// its heartbeat (convex/claudeSessions.ts, claudeDaemonHealth.fableAvailability)
// for the pages that show it.

const FABLE_STATE_FILE = "fable-availability.json";

/** How often the daemon's probe asks Fable again while it is unavailable. */
export const FABLE_PROBE_INTERVAL_MS = 60 * 60 * 1000;

/** The CLI's refusal for an account out of Fable usage. The text on the box
 *  since 2026-09-22 is "You've hit your monthly spend limit"; the usage-limit
 *  wording is the CLI's other cap message. */
export const FABLE_LIMIT_RE = /spend limit|usage.?limit/i;

function fableStatePath(stateDir) {
  return path.join(stateDir, FABLE_STATE_FILE);
}

/** The Fable availability state; `{ available: true }` when none is recorded. */
export function readFableState(stateDir) {
  try {
    const state = JSON.parse(fs.readFileSync(fableStatePath(stateDir), "utf8"));
    if (typeof state?.available === "boolean") return state;
  } catch {
    // absent or unreadable: available, as the header says
  }
  return { available: true };
}

function writeFableState(stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = fableStatePath(stateDir);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state)}\n`);
  fs.renameSync(temp, file);
  return state;
}

/** A run asked for Fable and was refused for a limit. `since` keeps the first
 *  refusal while the state is already unavailable. */
export function markFableUnavailable(stateDir, { at = Date.now(), reason = "" } = {}) {
  const prior = readFableState(stateDir);
  return writeFableState(stateDir, {
    available: false,
    since: prior.available === false && Number.isFinite(prior.since) ? prior.since : at,
    checkedAt: at,
    reason: String(reason).replace(/\s+/g, " ").trim().slice(0, 200),
  });
}

/** Fable answered: the ceiling lifts. */
export function markFableAvailable(stateDir, { at = Date.now() } = {}) {
  return writeFableState(stateDir, { available: true, since: at, checkedAt: at });
}

/** A probe that found Fable still unavailable: only the check time moves. */
export function noteFableProbe(stateDir, { at = Date.now(), reason } = {}) {
  const prior = readFableState(stateDir);
  if (prior.available !== false) return prior;
  return writeFableState(stateDir, { ...prior, checkedAt: at, ...(reason ? { reason: String(reason).replace(/\s+/g, " ").trim().slice(0, 200) } : {}) });
}

/** Whether the probe is due: Fable is unavailable and the last check is at
 *  least FABLE_PROBE_INTERVAL_MS old. */
export function fableProbeDue(state, now = Date.now()) {
  return state.available === false && !(now - (state.checkedAt ?? 0) < FABLE_PROBE_INTERVAL_MS);
}

/**
 * The model a request actually runs on, given the Fable availability state.
 * `{ model, requested, atCeiling }`: `model` is the one to run, `requested`
 * the one asked for, and `atCeiling` says the two differ because Fable is
 * unavailable. A model at or below the ceiling, or any request while Fable is
 * available, runs as asked.
 */
export function underCeiling(requested, fable = { available: true }) {
  if (fable.available === false && aboveCeiling(requested)) {
    return { model: MODEL_CEILING, requested, atCeiling: true };
  }
  return { model: requested, requested, atCeiling: false };
}

/** The line a log or a transcript row carries when the ceiling changed the
 *  model: "fable requested, opus at the ceiling". */
export function ceilingNote({ requested, model }) {
  return `${requested} requested, ${model} at the ceiling`;
}

/**
 * The model a record names for a run, in the shape the audit's fallback uses
 * ("audit by claude-opus-5, Codex at its cap"): the requested model when it ran
 * as asked, else "opus (fable requested, at the ceiling)".
 */
export function modelLabel(requested, fable = { available: true }) {
  const resolved = underCeiling(requested, fable);
  return resolved.atCeiling ? `${resolved.model} (${resolved.requested} requested, at the ceiling)` : requested;
}
