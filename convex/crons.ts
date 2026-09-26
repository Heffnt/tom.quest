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

// The runners' backstop (convex/ttsRunners.ts): opens a step for any runner
// whose nextStepAt has passed with none waiting or running, and frees any lease
// past its deadline. A runner's schedule is a field, not this cron; this is
// what recovers a scheduled call that was lost.
crons.interval(
  "runner sweep",
  { seconds: 60 },
  internal.ttsRunners.internalRunnerSweep,
);

// ── TTS (spec: WikiTom tts/spec.md §7) ──────────────────────────────────────
// The TTS day anchors at 5 a.m. America/New_York. Convex crons are UTC-only, so
// each job fires at both possible UTC times (EDT/EST) and the handler's
// local-hour guard lets exactly one proceed — DST needs no cron edits.

// Repeating-todo generation, 4:30 NY — BEFORE the 5 a.m. digest, so the
// day's minted instances are in the record when the digest reads it. (The
// 4:45 fallback queue prep that used to sit between them is gone — the lifeos
// update, phase 7: today's view is computed, not stored.)
crons.cron("tts repeats (edt)", "30 8 * * *", internal.ttsRepeats.internalGenerateRepeats, {});
crons.cron("tts repeats (est)", "30 9 * * *", internal.ttsRepeats.internalGenerateRepeats, {});

// THE MORNING MESSAGE, 5 a.m. (slack-design.md, Tom 2026-09-09): the missed
// rollover, then the day's facts gathered deterministically, then either the
// Fable run on the box writing it (the request the box picks up) or the plain
// template — one post to #tts-today every day, even when short. Behind
// DIGEST_ENABLED in convex/ttsSync.ts (its own switch, per message kind). The
// cron NAMES are unchanged so a rename does not lose their history.
crons.cron("tts digest (edt)", "0 9 * * *", internal.ttsSync.sendToday, {});
crons.cron("tts digest (est)", "0 10 * * *", internal.ttsSync.sendToday, {});

// The HOURLY UPDATE (Tom's ruling 2026-08-30; the lifeos update, phase 2):
// what the box is running, which todos were worked, what changed since the
// last one — OR NOTHING AT ALL when nothing changed — every hour, 24/7, in
// #tts-hourly
// (SLACK_TTS_HOURLY_CHANNEL_ID; unset = one log line, no send). Its OWN switch
// inside the action (HOURLY_UPDATE_ENABLED in convex/ttsSync.ts, ON) — a
// separate switch from the 5 a.m. digest's, so turning this on does not turn
// that back on. Plain interval, not a cron pair: this message has no local-hour
// anchor to defend against DST.
crons.interval(
  "tts hourly update",
  { hours: 1 },
  internal.ttsSync.sendHourlyUpdate,
  {},
);

// THE SILENCE ALARM (plan-root T3; convex/ttsJobs.ts internalCheckSilence):
// a #tts-broken line when the reader of box changes, the comparison of box
// state or the sweep has not run clean for three of its intervals. Every two
// minutes, the shortest interval it watches.
crons.interval("box silence alarm", { minutes: 2 }, internal.ttsJobs.internalCheckSilence, {});

// Code-todo mirror refresh from GitHub default branches.
crons.interval("tts mirror refresh", { hours: 6 }, internal.ttsSync.refreshMirror, {});

// The mirror of open pull requests, and the landing of every approved one
// whose gate has turned green (convex/observeMerge.ts). The observation page's
// Approve control records the ruling; this is what merges it afterwards.
crons.interval(
  "observe pull requests",
  { minutes: 5 },
  internal.observeMerge.refreshOpenPulls,
  {},
);

// The model-of-tom files are POSTED by the nightly job on the Jarvis Box
// (POST /tts/model-of-tom), not pulled by a cron — no Convex-side read of
// WikiTom exists (the lifeos update, phase 4).

// Calendar mirror refresh from the ICS feeds in TTS_ICS_FEEDS (quiet no-op
// until the env var is set). Hourly: calendars move on human timescales.
crons.interval(
  "tts calendar refresh",
  { hours: 1 },
  internal.ttsCalendarFetch.refreshFeeds,
  {},
);

// Row eviction, 04:15 NY — before repeats at 04:30 and the digest at 05:00, so
// the morning reads a settled record. The pair plus the handler's local-hour
// guard is the same DST pattern as the jobs above: both fire, one proceeds.
// AGENTS_EVICTION_ENABLED is OFF by default and the tick then deletes nothing and
// says so in its event; turning it on is the caller's action, after the store
// is the recovery source on that deployment. The cron names keep the word
// runs because a renamed cron loses its history.
crons.cron("runs evict (edt)", "15 8 * * *", internal.agents.internalEvictTick, {});
crons.cron("runs evict (est)", "15 9 * * *", internal.agents.internalEvictTick, {});

export default crons;
