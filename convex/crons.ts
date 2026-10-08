import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// THE BOX STARTS MOST TIMED WORK (Tom, 2026-09-26). The record's timed work —
// the Turing health light, the pull-request mirror and its landings — is a task the box's record-tick job starts through POST /jarvis/tick
// (convex/jarvis/tick.ts). What runs here is the record's own clock when the
// box does not: the silence alarm.

const crons = cronJobs();

// THE SILENCE ALARM (convex/jarvis/jobs.ts checkSilence) records one
// silence-alarm event and sends a phone notification when a watched box job
// has not run clean for three intervals. It runs here every two minutes.
crons.interval("box silence alarm", { minutes: 2 }, internal.ttsJobs.internalCheckSilence, {});

export default crons;
