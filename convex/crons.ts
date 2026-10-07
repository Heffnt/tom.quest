import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// THE BOX STARTS MOST TIMED WORK (Tom, 2026-09-26). The record's timed work —
// the Turing health light, the pull-request mirror and its merges, the
// code-todo mirror, the row eviction — is a task the box's record-tick job starts through POST /jarvis/tick
// (convex/jarvis/tick.ts). What runs here is the record's own clock: the
// thread digest (Tom's ruling of 2026-10-05, the digest on a Convex cron at
// 05:00) and what must run when the box does not.

const crons = cronJobs();

// THE THREAD DIGEST (convex/jarvis/digest.ts appendThreadDigest): the day's
// digest appended to the Jarvis thread with its numbered needs-you items, and
// one web push. Convex's cron schedules are UTC only (neither the installed
// convex 1.37 nor 1.46 has a time zone field), and New York is a whole number
// of hours from UTC, so the top of every UTC hour is the top of a New York
// hour in both summer and winter time. The mutation appends from 5 a.m. New
// York and once per day, so the 05:00 run appends and the other runs read one
// row and stop; a 05:00 run that failed is retried at 06:00 and each hour
// after, through 23:00 New York (the runs from midnight to 04:00 stop at the
// 5 a.m. check).
crons.cron("thread digest", "0 * * * *", internal.jarvis.digest.appendThreadDigest, {});

// THE SILENCE ALARM (convex/jarvis/jobs.ts checkSilence): a line on the Jarvis
// thread and a web push when a watched box job — the box-change reader, the
// state comparison, the sweep, the record tick — has not run clean for three
// of its intervals, and when 6 a.m. New York passes with no thread digest for
// the day. It is how the box's silence is heard, so it runs here and not on
// the box. Every two minutes, the shortest interval it watches.
crons.interval("box silence alarm", { minutes: 2 }, internal.ttsJobs.internalCheckSilence, {});

export default crons;
