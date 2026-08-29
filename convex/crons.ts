import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "poll turing health",
  { seconds: 30 },
  internal.serverHealth.pollTuring,
);

crons.interval(
  "reconcile gpu pool",
  { seconds: 60 },
  internal.gpuPool.reconcile,
);

// ── TTS (spec: WikiTom tts/spec.md §7) ──────────────────────────────────────
// The digest anchors at 5 a.m. America/New_York. Convex crons are UTC-only, so
// each job fires at both possible UTC times (EDT/EST) and the handler's
// local-hour guard lets exactly one proceed — DST needs no cron edits.

// Fallback queue prep + waking of due `waiting` items, in the 4 a.m. hour.
crons.cron("tts queue prep (edt)", "45 8 * * *", internal.tts.internalPrepareFallbackQueue, {});
crons.cron("tts queue prep (est)", "45 9 * * *", internal.tts.internalPrepareFallbackQueue, {});

// The digest ALWAYS sends at 5 (sends-even-when-empty rule).
crons.cron("tts digest (edt)", "0 9 * * *", internal.ttsSync.sendDigest, {});
crons.cron("tts digest (est)", "0 10 * * *", internal.ttsSync.sendDigest, {});

// Code-todo mirror refresh from GitHub default branches.
crons.interval("tts mirror refresh", { hours: 6 }, internal.ttsSync.refreshMirror, {});

// ── TTS autonomous fleet (P3) ───────────────────────────────────────────────
// Load-based admission of autonomous groundwork sessions. Off by default
// (claudeAutoConfig.enabled, no row = false), so the interval is safe to ship
// ahead of the enable pen.
crons.interval(
  "tts auto-session scheduler",
  { minutes: 5 },
  internal.claudeSessions.internalAutoSchedule,
  {},
);

export default crons;
