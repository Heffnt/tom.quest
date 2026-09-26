import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// ONE SCHEDULER, ON THE BOX (Tom, 2026-09-26). The record's timed work — the
// Turing health light, the pull-request mirror and its merges, the calendar
// feeds, the code-todo mirror, the repeating todos, the row eviction — is a
// task the box's record-tick job starts through POST /jarvis/tick
// (convex/jarvis/tick.ts),
// and the digest is written by the box (convex/jarvis/digest.ts). What stays
// here is what must run when the box does not.

const crons = cronJobs();

// THE SILENCE ALARM (plan-root T3; convex/jarvis/jobs.ts checkSilence): a line
// in the output channel when a watched box job — the box-change reader, the
// state comparison, the sweep, the digest writer, the record tick — has not
// run clean for three of its intervals, and when 6 a.m. New York passes with
// no digest. It is the one timed thing that cannot live on the box: it is how
// the box's silence is heard. Every two minutes, the shortest interval it
// watches.
crons.interval("box silence alarm", { minutes: 2 }, internal.ttsJobs.internalCheckSilence, {});

export default crons;
