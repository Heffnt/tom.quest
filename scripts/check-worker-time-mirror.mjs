// Guardrail: the America/New_York DST rule exists twice, and this check makes
// the second copy provably identical to the first.
//
// convex/ttsShared.ts is the one home for TTS time math (vqc/adoption.md ruling
// tts-shared-time-edge). The worker jobs cannot import it: worker/setup.sh
// copies only worker/jobs/*.mjs into /opt/tts on the Jarvis Box, the box holds
// no checkout of convex/, there is no build step there, and a cron-started
// plain Node process loads no .ts. So worker/jobs/tts-lib.mjs restates the
// rule by hand, under the same names.
//
// Unlike the session-constant mirrors (scripts/check-session-mirrors.mjs),
// which compare source text, this one cannot: TypeScript and JavaScript never
// byte-match. It compares BEHAVIOR instead — it imports both modules and runs
// them against each other over every hour of 2020-2035 and both edges of every
// DST transition. Any drift of a single hour on either side fails here.
//
// It also fences the NAMES. The worker copy must export the one home's names
// (nyOffsetHours, nyLocalHour) and must not carry a second name for the same
// value; two names for one offset is how the concept drifts in prose even when
// the arithmetic still agrees.
//
// Both sides are also checked against a fixed table of transition instants
// taken from US law, and against this machine's own timezone database, so a
// change that breaks both copies the same way still fails.
//
// Requires Node >= 22.18 (or --experimental-strip-types), which imports a .ts
// module directly by erasing its type annotations. CI pins Node 22 and the
// Jarvis Box runs Node 22.

const sharedUrl = new URL("../convex/ttsShared.ts", import.meta.url);
const workerUrl = new URL("../worker/jobs/tts-lib.mjs", import.meta.url);

const failures = [];
const note = (msg) => {
  if (failures.length < 12) failures.push(msg);
  else if (failures.length === 12) failures.push("… further mismatches hidden");
};

let shared;
try {
  shared = await import(sharedUrl.href);
} catch (err) {
  console.error("Worker time-mirror check FAILED:");
  console.error(
    `  - could not import convex/ttsShared.ts (${err.message}). This check ` +
      `runs the TypeScript one home directly, which needs Node >= 22.18 for ` +
      `type stripping; this is Node ${process.version}.`,
  );
  process.exit(1);
}
const worker = await import(workerUrl.href);

// ---------------------------------------------------------------------------
// 1. Names: one name per concept, on both sides.
// ---------------------------------------------------------------------------
for (const name of ["nyOffsetHours", "nyLocalHour"]) {
  if (typeof shared[name] !== "function") {
    note(`convex/ttsShared.ts no longer exports ${name}()`);
  }
  if (typeof worker[name] !== "function") {
    note(
      `worker/jobs/tts-lib.mjs no longer exports ${name}() — the mirror must ` +
        `use the one home's name for the concept`,
    );
  }
}
// Names the mirror used before the two sides were reconciled. Their return is a
// second name for a value that already has one.
for (const dead of ["nyUtcOffsetHours", "nyHour", "nyWallClock"]) {
  if (worker[dead] !== undefined) {
    note(
      `worker/jobs/tts-lib.mjs exports ${dead}() — a second name for a value ` +
        `convex/ttsShared.ts already names (nyOffsetHours / nyLocalHour)`,
    );
  }
}
if (failures.length > 0) report(); // the sweeps below would only throw

// ---------------------------------------------------------------------------
// 2. Absolute truth: the transitions US law fixes, checked on both sides.
// ---------------------------------------------------------------------------
// Spring forward at 2:00 EST = 07:00 UTC on the 2nd Sunday of March; fall back
// at 2:00 EDT = 06:00 UTC on the 1st Sunday of November. One millisecond before
// each instant the old offset still holds.
const TRANSITIONS = [
  { at: Date.UTC(2024, 2, 10, 7), before: -5, after: -4 },
  { at: Date.UTC(2024, 10, 3, 6), before: -4, after: -5 },
  { at: Date.UTC(2025, 2, 9, 7), before: -5, after: -4 },
  { at: Date.UTC(2025, 10, 2, 6), before: -4, after: -5 },
  { at: Date.UTC(2026, 2, 8, 7), before: -5, after: -4 },
  { at: Date.UTC(2026, 10, 1, 6), before: -4, after: -5 },
  { at: Date.UTC(2027, 2, 14, 7), before: -5, after: -4 },
  { at: Date.UTC(2027, 10, 7, 6), before: -4, after: -5 },
];
for (const t of TRANSITIONS) {
  for (const [side, mod] of [
    ["convex/ttsShared.ts", shared],
    ["worker/jobs/tts-lib.mjs", worker],
  ]) {
    const before = mod.nyOffsetHours(t.at - 1);
    const after = mod.nyOffsetHours(t.at);
    if (before !== t.before || after !== t.after) {
      note(
        `${side}: at ${new Date(t.at).toISOString()} the offset goes ` +
          `${before} → ${after}, US law says ${t.before} → ${t.after}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Behavioral equality, hour by hour across sixteen years.
// ---------------------------------------------------------------------------
const HOUR_MS = 3_600_000;
const FIRST_YEAR = 2020;
const LAST_YEAR = 2035;
let checked = 0;
let previous = null;
const transitions = [];

const SWEEP_START = Date.UTC(FIRST_YEAR, 0, 1);
const SWEEP_END = Date.UTC(LAST_YEAR + 1, 0, 1);

for (let ms = SWEEP_START; ms < SWEEP_END; ms += HOUR_MS) {
  const a = shared.nyOffsetHours(ms);
  const b = worker.nyOffsetHours(ms);
  checked += 1;
  if (a !== b) {
    note(
      `nyOffsetHours drifted at ${new Date(ms).toISOString()}: ` +
        `ttsShared.ts ${a}, tts-lib.mjs ${b}`,
    );
  }
  const ha = shared.nyLocalHour(ms);
  const hb = worker.nyLocalHour(ms);
  if (ha !== hb) {
    note(
      `nyLocalHour drifted at ${new Date(ms).toISOString()}: ` +
        `ttsShared.ts ${ha}, tts-lib.mjs ${hb}`,
    );
  }
  // Transitions land on exact UTC hours, so this hourly sweep steps onto each
  // one; probe the millisecond on either side of it too, where an off-by-one
  // comparison (>= vs >) hides.
  if (previous !== null && a !== previous) {
    transitions.push(ms);
    for (const edge of [ms - 1, ms + 1]) {
      if (shared.nyOffsetHours(edge) !== worker.nyOffsetHours(edge)) {
        note(
          `nyOffsetHours drifted at the transition edge ` +
            `${new Date(edge).toISOString()}: ttsShared.ts ` +
            `${shared.nyOffsetHours(edge)}, tts-lib.mjs ` +
            `${worker.nyOffsetHours(edge)}`,
        );
      }
    }
  }
  previous = a;
}

// ---------------------------------------------------------------------------
// 3b. Both copies against the machine's timezone database.
// ---------------------------------------------------------------------------
// Sections 2 and 3 catch one copy drifting from the other, and drift from the
// eight transitions written out above. This catches both copies being wrong the
// same way in a year the table does not list: Intl.DateTimeFormat reads the
// operating system's IANA timezone database, which neither the Convex runtime
// nor a bare Jarvis Box can be trusted to have — which is why the rule is hand
// written in the first place — but the machine running this check does have it.
// Skipped, with a printed note, on a build of Node whose ICU carries no
// timezone data, so a trimmed runtime cannot turn this red by itself.
const nyFormatter = (() => {
  try {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      timeZoneName: "shortOffset",
    });
    // A trimmed ICU quietly answers as UTC; a July instant must read GMT-4.
    return /GMT-4/.test(f.format(Date.UTC(2026, 6, 1, 12))) ? f : null;
  } catch {
    return null;
  }
})();

if (nyFormatter) {
  const icuOffsetHours = (ms) =>
    Number(
      nyFormatter
        .formatToParts(ms)
        .find((p) => p.type === "timeZoneName")
        .value.replace("GMT", ""), // "GMT-4" → -4
    );
  const probes = [];
  for (let year = FIRST_YEAR; year <= LAST_YEAR; year += 1) {
    for (const [month, day] of [
      [0, 15],
      [3, 15],
      [6, 15],
      [9, 15],
    ]) {
      probes.push(Date.UTC(year, month, day, 12));
    }
  }
  for (const t of transitions) probes.push(t - 1, t);
  for (const ms of probes) {
    const truth = icuOffsetHours(ms);
    for (const [side, mod] of [
      ["convex/ttsShared.ts", shared],
      ["worker/jobs/tts-lib.mjs", worker],
    ]) {
      if (mod.nyOffsetHours(ms) !== truth) {
        note(
          `${side}: offset ${mod.nyOffsetHours(ms)} at ` +
            `${new Date(ms).toISOString()}, but this machine's timezone ` +
            `database says ${truth}`,
        );
      }
    }
  }
} else {
  console.log(
    "  (this Node build has no America/New_York timezone data — skipped the " +
      "cross-check against the operating system)",
  );
}

// ---------------------------------------------------------------------------
// 4. Noon New York: the worker's dueAt writer against the one home's general
//    form, and against what noon means.
// ---------------------------------------------------------------------------
// worker nyNoonUtcMs(day) is the single-sampling special case of shared
// nyTimeUtcMs(day, 12); every writer of dueAt uses it, so a disagreement moves
// due dates by a day at the calendar edges.
for (let ms = SWEEP_START; ms < SWEEP_END; ms += 86_400_000) {
  const day = new Date(ms).toISOString().slice(0, 10);
  const workerNoon = worker.nyNoonUtcMs(day);
  const sharedNoon = shared.nyTimeUtcMs(day, 12);
  if (workerNoon !== sharedNoon) {
    note(
      `noon disagrees for ${day}: tts-lib.mjs nyNoonUtcMs ` +
        `${new Date(workerNoon).toISOString()}, ttsShared.ts ` +
        `nyTimeUtcMs(day, 12) ${new Date(sharedNoon).toISOString()}`,
    );
  }
  if (shared.nyLocalHour(workerNoon) !== 12) {
    note(
      `nyNoonUtcMs(${day}) is not noon in New York: it is ` +
        `${shared.nyLocalHour(workerNoon)} o'clock`,
    );
  }
  if (shared.nyCalendarDayKey(workerNoon) !== day) {
    note(
      `nyNoonUtcMs(${day}) falls on NY calendar date ` +
        `${shared.nyCalendarDayKey(workerNoon)}`,
    );
  }
}

report();

function report() {
  if (failures.length > 0) {
    console.error("Worker time-mirror check FAILED:");
    for (const f of failures) console.error("  - " + f);
    console.error(
      "  convex/ttsShared.ts is the one home; worker/jobs/tts-lib.mjs " +
        "mirrors it by hand because /opt/tts on the Jarvis Box cannot load " +
        ".ts. Fix both in the same commit.",
    );
    process.exit(1);
  }
  console.log(
    `Worker time-mirror check passed (${checked} hours of ` +
      `${FIRST_YEAR}-${LAST_YEAR}).`,
  );
}
