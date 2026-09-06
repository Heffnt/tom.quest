// Tests for the Friday job (worker/jobs/weekly.mjs): its pure halves, and the
// whole run against fakes for its doors (REAL_IO's shape — Convex, the model,
// the lock, git, the clock). What is pinned is what a mistake in would be
// silent: that every fact reaches the agenda with no cap, that zero forks
// renders as the one sentence, that the sustainability question is the fixed
// words, what the first week says, what a missing checkout says, how the
// model's answer is checked before it becomes an agenda, that a failed model
// call or gather still yields the agenda and the one session, that a day is
// run once, and that two missed weeks put the cadence line first.
//
// Importing the job module is safe: it only calls main() when node was
// pointed at the file (the `invokedDirectly` guard at the bottom).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CADENCE_LINE,
  CHECKOUT_ABSENT_LINE,
  FIRST_WEEK_LINE,
  NO_FORKS_LINE,
  OUTCOME_HEADING,
  SUSTAINABILITY_QUESTION,
  WEEKLY_DIR,
  agendaFileName,
  agendaSubjects,
  appendOutcome,
  buildAgendaPrompt,
  cadenceLine,
  duration,
  isAreaPagePath,
  isDay,
  outcomeTimingOf,
  parseAgendaAnswer,
  priorAgendaLines,
  readPriorAgenda,
  renderAgenda,
  renderFactLines,
  runWeekly,
  sessionPrompt,
} from "./weekly.mjs";

const DAY = 86_400_000;
const UNTIL = Date.UTC(2026, 8, 11, 8); // 2026-09-11 08:00 UTC, 4 a.m. EDT
const SINCE = UNTIL - 7 * DAY;

const tmpDirs = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** The gather's answer with nothing in it (convex/ttsWeekly.ts WeeklyFacts). */
function emptyFacts() {
  return {
    since: SINCE,
    until: UNTIL,
    completions: [],
    captures: [],
    dateOutcomes: [],
    surfacedUntouched: [],
    goalsWithoutOpenTask: [],
    goalsNotEvaluated: [],
    integrations: [
      { name: "gmail", state: "running", since: null, detail: null },
      { name: "canvas", state: "running", since: null, detail: null },
      { name: "outlook", state: "running", since: null, detail: null },
    ],
    areaPages: [],
    modelOfTom: { commit: null, syncedAt: null, files: [], totalBytes: 0 },
    learning: { changes: 0, reverted: 0, revertFailed: 0, lines: [] },
    jobFailures: [],
    threads: [],
    readiness: { prepared: 0, unprepared: 0 },
  };
}

/** One of everything. */
function fullFacts() {
  return {
    ...emptyFacts(),
    completions: [{ id: "t1", statement: "file the form", kind: "task", batch: "the paper", doneAt: UNTIL - 2 * DAY }],
    captures: [
      { source: "email", count: 1, items: [{ id: "t2", statement: "from mail", createdAt: UNTIL - DAY }] },
      { source: "slack-capture", count: 1, items: [{ id: "t3", statement: "from slack", createdAt: UNTIL - DAY }] },
    ],
    dateOutcomes: [
      { todoId: "t4", statement: "the deadline", outcome: "missed", at: UNTIL - 3 * DAY, newDueAt: UNTIL - 3 * DAY, note: "rolled" },
      { todoId: "t5", statement: "the other date", outcome: "renegotiated", at: UNTIL - 3 * DAY, newDueAt: UNTIL + 4 * DAY, note: null },
    ],
    surfacedUntouched: [{ id: "t6", statement: "the ignored one", surfaced: 3, firstAt: UNTIL - 5 * DAY }],
    goalsWithoutOpenTask: [{ id: "g1", statement: "lease signed", batch: "the lease" }],
    goalsNotEvaluated: [{ id: "g1", statement: "lease signed", batch: "the lease", lastEvaluatedAt: null }],
    integrations: [
      { name: "gmail", state: "running", since: null, detail: null },
      { name: "canvas", state: "waiting-on-credential", since: UNTIL - 6 * DAY, detail: "Canvas said 401" },
      { name: "outlook", state: "declined", since: UNTIL - 4 * DAY, detail: "the WPI mailbox is read by hand" },
    ],
    areaPages: [
      { path: "model-of-tom/areas/admin.md", updatedOn: "2026-09-06", reviewedOn: "2026-09-10", windowDays: 60, reviewedAgeDays: 1, pastWindow: false },
      { path: "model-of-tom/areas/money.md", updatedOn: "2026-09-06", reviewedOn: null, windowDays: 30, reviewedAgeDays: null, pastWindow: true },
      { path: "model-of-tom/areas/research.md", updatedOn: "2026-09-06", reviewedOn: "2026-01-01", windowDays: 30, reviewedAgeDays: 253, pastWindow: true },
    ],
    modelOfTom: {
      commit: "abc1234def5678",
      syncedAt: UNTIL - DAY,
      files: [
        { path: "model-of-tom/areas/research.md", bytes: 1200 },
        { path: "model-of-tom/writing.md", bytes: 800 },
      ],
      totalBytes: 2000,
    },
    learning: {
      changes: 1,
      reverted: 1,
      revertFailed: 1,
      lines: [
        { kind: "learning-change", at: UNTIL - 3 * DAY, id: "lc1", file: "model-of-tom/areas/research.md", before: "", after: "- a line", evidence: "session x", error: null },
        { kind: "learning-reverted", at: UNTIL - 2 * DAY, id: "lc1", file: "model-of-tom/areas/research.md", before: null, after: null, evidence: null, error: null },
        { kind: "learning-revert-failed", at: UNTIL - DAY, id: "lc0", file: null, before: null, after: null, evidence: null, error: "base hash moved" },
      ],
    },
    jobFailures: [
      { job: "nightly", count: 1, lines: [{ at: UNTIL - 2 * DAY, error: "nightly-failure: refused" }] },
      { job: "poll-canvas", count: 1, lines: [{ at: UNTIL - 6 * DAY, error: "Canvas said 401" }] },
    ],
    threads: [
      { todoId: "t7", statement: "reply to the dean", askedAt: UNTIL - 2 * DAY, repliedAt: UNTIL - 2 * DAY + 90 * 60_000, replyMs: 90 * 60_000 },
      { todoId: "t8", statement: "sign the form", askedAt: UNTIL - DAY, repliedAt: null, replyMs: null },
    ],
    readiness: { prepared: 1, unprepared: 9 },
  };
}

describe("renderFactLines", () => {
  it("says every fact kind is empty when the week holds nothing", () => {
    const lines = renderFactLines(emptyFacts());
    expect(lines).toEqual([
      "Window: 2026-09-04 to 2026-09-11 (seven days).",
      "Completed: 0.",
      "Captured: 0.",
      "Date outcomes: 0.",
      "Surfaced three or more times and untouched: 0.",
      "Goals with no open task in their batch: 0.",
      "Open goals no worker has evaluated in seven days: 0.",
      "Integrations: gmail running; canvas running; outlook running.",
      "Area pages: 0, past their window: 0.",
      "Model-of-tom files every prompt begins with: 0 files, 0 bytes in all, no commit posted yet.",
      "Nightly learning: 0 changes, 0 reverted, 0 reverts failed.",
      "Job failures: none.",
      "Threads that needed Tom: 0.",
      "Todos: 0 prepared, 0 unprepared.",
    ]);
  });

  it("carries every fact kind, each with its date, count, or duration", () => {
    const text = renderFactLines(fullFacts()).join("\n");
    expect(text).toContain('- file the form (2026-09-09; task, batch "the paper"; id t1)');
    expect(text).toContain("Captured: 2 — by source: email 1, slack-capture 1.");
    expect(text).toContain("- (email) from mail (2026-09-10; id t2)");
    expect(text).toContain("Date outcomes: 2 — done 0, renegotiated 1, missed 1.");
    expect(text).toContain("- missed: the deadline (2026-09-08; note: rolled; id t4)");
    expect(text).toContain("- renegotiated: the other date (2026-09-08; new date 2026-09-15; id t5)");
    expect(text).toContain("- the ignored one (surfaced 3 times since 2026-09-06; id t6)");
    expect(text).toContain('- lease signed (batch "the lease") (id g1)');
    expect(text).toContain('- lease signed (batch "the lease") — last evaluated never (id g1)');
    expect(text).toContain(
      'Integrations: gmail running; canvas waiting on a credential since 2026-09-05 (Canvas said 401); outlook declined on 2026-09-07 ("the WPI mailbox is read by hand").',
    );
    expect(text).toContain("Area pages: 3, past their window: 2.");
    expect(text).toContain("- admin: reviewed 2026-09-10 (1 day ago), window 60 days");
    expect(text).toContain("- money: never reviewed, window 30 days — past its window");
    expect(text).toContain("- research: reviewed 2026-01-01 (253 days ago), window 30 days — past its window");
    expect(text).toContain("Model-of-tom files every prompt begins with: 2 files, 2000 bytes in all, at WikiTom commit abc1234def56 (2026-09-10).");
    expect(text).toContain("- model-of-tom/writing.md: 800 bytes");
    expect(text).toContain("Nightly learning: 1 change, 1 reverted, 1 revert failed.");
    expect(text).toContain('- 2026-09-08 model-of-tom/areas/research.md: "" → "- a line" (evidence: session x)');
    expect(text).toContain("- 2026-09-09 reverted lc1 in model-of-tom/areas/research.md");
    expect(text).toContain("- 2026-09-10 revert of lc0 failed: base hash moved");
    expect(text).toContain("Job failures: nightly 1, poll-canvas 1.");
    expect(text).toContain("- nightly 2026-09-09: nightly-failure: refused");
    expect(text).toContain("Threads that needed Tom: 2 — replied 1, unanswered 1.");
    expect(text).toContain("- reply to the dean: asked 2026-09-09, replied after 1h 30m (id t7)");
    expect(text).toContain("- sign the form: asked 2026-09-10, no reply yet (id t8)");
    expect(text).toContain("Todos: 1 prepared, 9 unprepared.");
  });

  // NO CAPS: the agenda writes every fact, not a fixed number of them.
  it("lists every item without a cap", () => {
    const facts = emptyFacts();
    facts.completions = Array.from({ length: 150 }, (_, i) => ({
      id: `t${i}`,
      statement: `done ${i}`,
      kind: "task",
      batch: null,
      doneAt: UNTIL - DAY,
    }));
    const lines = renderFactLines(facts);
    expect(lines.filter((l) => l.startsWith("- done "))).toHaveLength(150);
    expect(lines).toContain("Completed: 150.");
  });

  it("grades nothing", () => {
    const text = renderFactLines(fullFacts()).join("\n").toLowerCase();
    for (const word of ["score", "grade", "good week", "bad week", "well done", "behind"]) {
      expect(text).not.toContain(word);
    }
  });
});

describe("duration", () => {
  it("reads as minutes, hours, or days", () => {
    expect(duration(10_000)).toBe("under a minute");
    expect(duration(45 * 60_000)).toBe("45m");
    expect(duration(90 * 60_000)).toBe("1h 30m");
    expect(duration(2 * DAY + 3 * 3_600_000)).toBe("2d 3h");
    expect(duration(3 * DAY)).toBe("3d");
  });
});

describe("readPriorAgenda", () => {
  it("says the checkout is absent when the directory is not a git checkout", () => {
    const dir = tmp();
    expect(readPriorAgenda(dir)).toEqual({ checkout: false, file: null, day: null, outcome: null, recent: [] });
    expect(readPriorAgenda(path.join(dir, "never-made"))).toMatchObject({ checkout: false });
  });

  it("finds no file on the first week", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, ".git"));
    expect(readPriorAgenda(dir)).toEqual({ checkout: true, file: null, day: null, outcome: null, recent: [] });
    fs.mkdirSync(path.join(dir, WEEKLY_DIR), { recursive: true });
    write(dir, `${WEEKLY_DIR}/README.md`, "not an agenda\n");
    expect(readPriorAgenda(dir).file).toBeNull();
  });

  it("reads the newest agenda and its outcome, empty when the section is bare", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, ".git"));
    write(dir, `${WEEKLY_DIR}/2026-08-28.md`, "# old\n\n## Outcome\n\ntiming: on time\n");
    write(
      dir,
      `${WEEKLY_DIR}/2026-09-04.md`,
      renderAgenda({ day: "2026-09-04", lines: ["Completed: 3."], priorLines: [FIRST_WEEK_LINE], forks: [] }),
    );
    expect(readPriorAgenda(dir)).toEqual({
      checkout: true,
      file: `${WEEKLY_DIR}/2026-09-04.md`,
      day: "2026-09-04",
      outcome: null,
      // newest first: last week with no outcome yet, the week before on time
      recent: [
        { day: "2026-09-04", timing: null },
        { day: "2026-08-28", timing: "on time" },
      ],
    });
    const filled = appendOutcome(
      fs.readFileSync(path.join(dir, WEEKLY_DIR, "2026-09-04.md"), "utf8"),
      "timing: late\nsustainable: mostly, the paper week was long\nrulings:\n1. archive it",
    );
    write(dir, `${WEEKLY_DIR}/2026-09-04.md`, filled);
    expect(readPriorAgenda(dir).outcome).toBe(
      "timing: late\nsustainable: mostly, the paper week was long\nrulings:\n1. archive it",
    );
    expect(readPriorAgenda(dir).recent[0]).toEqual({ day: "2026-09-04", timing: "late" });
  });

  // A rerun's own file is not last week's: with today named, the newest file
  // BEFORE today is last week's, and today's file (Outcome and all) is skipped.
  it("skips today's own file when today is named", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, ".git"));
    write(dir, `${WEEKLY_DIR}/2026-09-04.md`, "# last week\n\n## Outcome\n\ntiming: late\n");
    write(dir, `${WEEKLY_DIR}/2026-09-11.md`, "# today, a rerun\n\n## Outcome\n\ntiming: on time\n");
    expect(readPriorAgenda(dir, "2026-09-11")).toMatchObject({ day: "2026-09-04", outcome: "timing: late" });
    expect(readPriorAgenda(dir)).toMatchObject({ day: "2026-09-11" });
    expect(readPriorAgenda(dir, "2026-09-04")).toMatchObject({ file: null });
  });
});

describe("the consecutive-miss rule", () => {
  const late = { day: "2026-09-04", timing: "late" };
  const skipped = { day: "2026-08-28", timing: "skipped" };
  const onTime = { day: "2026-08-28", timing: "on time" };
  const unrecorded = { day: "2026-08-28", timing: null };

  it("fires on two misses in a row — late, skipped, or no outcome — and on nothing less", () => {
    expect(cadenceLine([late, skipped])).toBe(
      `${CADENCE_LINE} — the last two weekly sessions: 2026-09-04 late, 2026-08-28 skipped.`,
    );
    expect(cadenceLine([late, unrecorded])).toContain("2026-08-28 no outcome recorded");
    expect(cadenceLine([{ day: "2026-09-04", timing: "skipped" }, late])).not.toBeNull();
    expect(cadenceLine([late, onTime])).toBeNull();
    expect(cadenceLine([onTime, skipped])).toBeNull();
    expect(cadenceLine([late])).toBeNull();
    expect(cadenceLine([])).toBeNull();
    // only the two newest count
    expect(cadenceLine([onTime, late, skipped])).toBeNull();
  });

  it("puts the line first in the agenda, before the facts, and nowhere otherwise", () => {
    const fired = renderAgenda({ day: "2026-09-11", lines: ["Completed: 0."], priorLines: [], forks: [], recent: [late, skipped] });
    expect(fired.startsWith(`# Weekly agenda — 2026-09-11\n\n**${CADENCE_LINE}`)).toBe(true);
    expect(fired.indexOf(CADENCE_LINE)).toBeLessThan(fired.indexOf("## Facts"));
    const quiet = renderAgenda({ day: "2026-09-11", lines: ["Completed: 0."], priorLines: [], forks: [], recent: [late, onTime] });
    expect(quiet).not.toContain(CADENCE_LINE);
    expect(quiet.startsWith("# Weekly agenda — 2026-09-11\n\n## Facts")).toBe(true);
  });

  it("is the job's rule, not the model's: the prompt does not ask for a cadence fork", () => {
    const text = buildAgendaPrompt({ factLines: [], priorLines: [] });
    expect(text).not.toContain("the cadence itself");
    expect(text).toContain("not yours to raise");
  });
});

// ── The run, whole, against fakes ────────────────────────────────────────────
// REAL_IO's shape: fetch, model, lock, abortStaleRebase, commit, sync, now.
// The checkout is a directory with a `.git` entry (all the run reads of it);
// git itself is the fake commit/sync, so what is pinned is what the run
// writes and asks for, in what order.
const ENV = { CONVEX_SITE_URL: "https://x.convex.site", TTS_WORKER_KEY: "k" };

function checkout() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}

function fakeIo({ facts = emptyFacts(), answer = { lines: ["Completed: 0."], forks: [] }, modelError = null, gatherError = null, runRow = null, sessionError = null } = {}) {
  const calls = { fetch: [], model: [], abort: 0, commits: [] };
  const io = {
    now: () => UNTIL,
    fetch: async (_env, p, body) => {
      calls.fetch.push({ path: p, body });
      if (p.startsWith("/tts/weekly-input")) {
        if (gatherError !== null) throw new Error(gatherError);
        return facts;
      }
      if (p.startsWith("/tts/weekly-run")) return { run: runRow };
      if (p === "/tts/session") {
        if (sessionError !== null) throw new Error(sessionError);
        return { ok: true, sessionId: "sess-new" };
      }
      if (p === "/tts/event") return { ok: true, id: `ev${calls.fetch.length}` };
      throw new Error(`unexpected ${p}`);
    },
    model: (prompt, opts) => {
      calls.model.push({ prompt, opts });
      if (modelError !== null) throw new Error(modelError);
      return JSON.stringify(answer);
    },
    lock: async (fn) => await fn(),
    abortStaleRebase: () => {
      calls.abort++;
      return [];
    },
    commit: (_dir, commits, day, opts) => {
      calls.commits.push({ commits, day, opts });
      return { made: commits.map((c) => c.message), failures: [] };
    },
    sync: () => ({ pulled: true, pushed: true, failures: [] }),
  };
  return { io, calls };
}

const posted = (calls, kind) => calls.fetch.filter((c) => c.path === "/tts/event" && c.body.kind === kind);
const sessions = (calls) => calls.fetch.filter((c) => c.path === "/tts/session");

describe("the run — one per day", () => {
  it("refuses a day whose agenda file exists: nothing written, no session, no model call", async () => {
    const dir = checkout();
    write(dir, `${WEEKLY_DIR}/2026-09-11.md`, "# earlier today\n\n## Outcome\n\ntiming: on time\n");
    const { io, calls } = fakeIo();
    const result = await runWeekly({ force: true, env: ENV, dir, io });
    expect(result.refused).toContain("2026-09-11 was already run: the agenda file tts/weekly/2026-09-11.md is in the checkout");
    expect(fs.readFileSync(path.join(dir, WEEKLY_DIR, "2026-09-11.md"), "utf8")).toContain("timing: on time");
    expect(calls.model).toHaveLength(0);
    expect(calls.commits).toHaveLength(0);
    expect(sessions(calls)).toHaveLength(0);
    expect(posted(calls, "weekly-run")).toHaveLength(0);
    expect(calls.fetch.map((c) => c.path)).toEqual(["/tts/weekly-run?day=2026-09-11"]);
  });

  it("refuses a day whose weekly-run row exists, even with no file", async () => {
    const dir = checkout();
    const { io, calls } = fakeIo({ runRow: { at: UNTIL - 3_600_000, file: null, sessionId: "sess-earlier", failures: 1 } });
    const result = await runWeekly({ force: true, env: ENV, dir, io });
    expect(result.refused).toContain("a weekly-run row for 2026-09-11 names session sess-earlier");
    expect(result.sessionId).toBe("sess-earlier");
    expect(fs.existsSync(path.join(dir, WEEKLY_DIR, "2026-09-11.md"))).toBe(false);
    expect(calls.model).toHaveLength(0);
    expect(sessions(calls)).toHaveLength(0);
  });

  it("writes the cadence line first when the two prior agendas were missed", async () => {
    const dir = checkout();
    write(dir, `${WEEKLY_DIR}/2026-08-28.md`, "# two weeks ago\n\n## Outcome\n\ntiming: skipped\n");
    write(dir, `${WEEKLY_DIR}/2026-09-04.md`, "# last week\n\n## Outcome\n\ntiming: late\nsustainable: no\n");
    const { io } = fakeIo();
    const result = await runWeekly({ force: true, env: ENV, dir, io });
    expect(result.refused).toBeNull();
    const text = fs.readFileSync(path.join(dir, WEEKLY_DIR, "2026-09-11.md"), "utf8");
    expect(text.startsWith(`# Weekly agenda — 2026-09-11\n\n**${CADENCE_LINE} — the last two weekly sessions: 2026-09-04 late, 2026-08-28 skipped.**`)).toBe(true);
  });

  it("on a clean day: one model call, the agenda committed once, one session named on the forks' subjects, one run row", async () => {
    const dir = checkout();
    const fork = {
      title: "the ignored one",
      subject: { type: "life", id: "t6" },
      sides: [
        { option: "archive it", cost: "the intent leaves the active list" },
        { option: "keep it", cost: "another week untouched" },
      ],
      recommendation: "archive",
    };
    const { io, calls } = fakeIo({ facts: fullFacts(), answer: { lines: ["Completed: 1.", "Captured: 2."], forks: [fork, { ...fork, subject: null }] } });
    const result = await runWeekly({ force: true, env: ENV, dir, io });
    expect(result).toEqual({ day: "2026-09-11", file: "tts/weekly/2026-09-11.md", sessionId: "sess-new", failures: [], refused: null });
    // the model, once, on the rendered facts
    expect(calls.model).toHaveLength(1);
    expect(calls.model[0].prompt).toContain("THE FACTS:\nWindow: 2026-09-04 to 2026-09-11 (seven days).");
    expect(calls.model[0].prompt).toContain(`LAST WEEK:\n${FIRST_WEEK_LINE}`);
    expect(calls.model[0].opts).toMatchObject({ model: "opus" });
    // the file, under one abort and one commit that does not repeat it
    const text = fs.readFileSync(path.join(dir, WEEKLY_DIR, "2026-09-11.md"), "utf8");
    expect(text).toContain("- Completed: 1.\n- Captured: 2.");
    expect(text).toContain("1. the ignored one (life t6)");
    expect(text).toContain("2. the ignored one\n");
    expect(text.trimEnd().endsWith(OUTCOME_HEADING)).toBe(true);
    expect(calls.abort).toBe(1);
    expect(calls.commits).toEqual([
      { commits: [{ paths: [WEEKLY_DIR], message: "weekly: 2026-09-11 — the agenda" }], day: "2026-09-11", opts: { guardRebase: false } },
    ]);
    // the session, once, with the agenda as its opener and the subjects on the row
    const [session] = sessions(calls);
    expect(sessions(calls)).toHaveLength(1);
    expect(session.body).toMatchObject({ title: "Weekly 2026-09-11", kind: "weekly", day: "2026-09-11", agendaSubjects: ["t6"], repos: [], model: "opus" });
    expect(session.body.initialPrompt).toContain("It is the file tts/weekly/2026-09-11.md in the WikiTom checkout");
    expect(session.body.initialPrompt.trimEnd().endsWith(text.trimEnd())).toBe(true);
    // the record: no failure rows, one run row keyed on the day
    expect(posted(calls, "weekly-failure")).toHaveLength(0);
    const [run] = posted(calls, "weekly-run");
    expect(run.body.key).toBe("2026-09-11");
    expect(run.body.data).toMatchObject({ day: "2026-09-11", file: "tts/weekly/2026-09-11.md", pushed: true, sessionId: "sess-new", lines: 2, forks: 2, firstWeek: true, failures: [] });
  });

  // A failed model call is a failure row and an agenda all the same: the
  // facts as the job rendered them, no forks, and the session still opens.
  it("on a failed model call still writes the agenda (the facts, no forks) and opens the one session", async () => {
    const dir = checkout();
    const { io, calls } = fakeIo({ facts: fullFacts(), modelError: "claude returned an error envelope (subtype: error_max_turns)" });
    const result = await runWeekly({ force: true, env: ENV, dir, io });
    expect(result.failures).toEqual([{ step: "model", error: "claude returned an error envelope (subtype: error_max_turns)" }]);
    expect(result.file).toBe("tts/weekly/2026-09-11.md");
    expect(result.sessionId).toBe("sess-new");
    const text = fs.readFileSync(path.join(dir, WEEKLY_DIR, "2026-09-11.md"), "utf8");
    expect(text).toContain("(the model call failed — claude returned an error envelope (subtype: error_max_turns) — so these are the gathered facts as the job rendered them, and no forks were written)");
    expect(text).toContain("- Completed: 1.\n- - file the form (2026-09-09; task, batch \"the paper\"; id t1)");
    expect(text).toContain(`## Forks\n\n${NO_FORKS_LINE}`);
    expect(calls.model).toHaveLength(1);
    expect(sessions(calls)).toHaveLength(1);
    expect(sessions(calls)[0].body.agendaSubjects).toEqual([]);
    expect(posted(calls, "weekly-failure").map((c) => c.body.data.step)).toEqual(["model"]);
    expect(posted(calls, "weekly-run")).toHaveLength(1);
  });

  // A failed gather has nothing to give the model: the agenda says so, and
  // the session still opens on it.
  it("on a failed gather makes no model call, writes the agenda saying so, and opens the one session", async () => {
    const dir = checkout();
    const { io, calls } = fakeIo({ gatherError: "/tts/weekly-input -> HTTP 500: boom" });
    const result = await runWeekly({ force: true, env: ENV, dir, io });
    expect(result.failures.map((f) => f.step)).toEqual(["gather"]);
    expect(calls.model).toHaveLength(0);
    const text = fs.readFileSync(path.join(dir, WEEKLY_DIR, "2026-09-11.md"), "utf8");
    expect(text).toContain("(the model call failed — the gather failed, so there was nothing to give the model — so these are the gathered facts");
    expect(text).toContain("- The gather failed; no facts were read this week (see the job failures).");
    expect(text).toContain(SUSTAINABILITY_QUESTION);
    expect(text).toContain(NO_FORKS_LINE);
    expect(sessions(calls)).toHaveLength(1);
    expect(sessions(calls)[0].body.initialPrompt).toContain(text.trimEnd());
    expect(posted(calls, "weekly-run")[0].body.data).toMatchObject({ file: "tts/weekly/2026-09-11.md", sessionId: "sess-new", forks: 0 });
  });

  // With the checkout absent nothing is committed, the failure is recorded,
  // and the session opens with the agenda in its prompt alone.
  it("with the checkout absent records the failure, commits nothing, and opens the session on the prompt alone", async () => {
    const dir = tmp();
    const { io, calls } = fakeIo();
    const result = await runWeekly({ force: true, env: ENV, dir, io });
    expect(result.failures.map((f) => f.step)).toEqual(["checkout"]);
    expect(result.file).toBeNull();
    expect(calls.commits).toHaveLength(0);
    expect(calls.abort).toBe(0);
    expect(sessions(calls)).toHaveLength(1);
    expect(sessions(calls)[0].body.initialPrompt).toContain("The WikiTom checkout was absent when the job ran, so the agenda exists only in this prompt");
    expect(sessions(calls)[0].body.initialPrompt).toContain(`- ${CHECKOUT_ABSENT_LINE}`);
    expect(posted(calls, "weekly-run")[0].body.data).toMatchObject({ file: null, pushed: false, sessionId: "sess-new" });
  });

  it("with --overwrite rewrites the file, keeps the earlier session, and records the run keyed on the day", async () => {
    const dir = checkout();
    write(dir, `${WEEKLY_DIR}/2026-09-04.md`, "# last week\n\n## Outcome\n\ntiming: late\n");
    write(dir, `${WEEKLY_DIR}/2026-09-11.md`, "# earlier today\n\n## Outcome\n\ntiming: on time\n");
    const { io, calls } = fakeIo({ runRow: { at: UNTIL - 3_600_000, file: "tts/weekly/2026-09-11.md", sessionId: "sess-earlier", failures: 0 } });
    const result = await runWeekly({ force: true, overwrite: true, env: ENV, dir, io });
    expect(result).toMatchObject({ day: "2026-09-11", file: "tts/weekly/2026-09-11.md", sessionId: "sess-earlier", failures: [], refused: null });
    const text = fs.readFileSync(path.join(dir, WEEKLY_DIR, "2026-09-11.md"), "utf8");
    expect(text).toContain("# Weekly agenda — 2026-09-11");
    expect(text).not.toContain("timing: on time");
    // last week is 09-04, not the file this run replaced
    expect(text).toContain("Last week's agenda (tts/weekly/2026-09-04.md), outcome:");
    expect(sessions(calls)).toHaveLength(0);
    const run = posted(calls, "weekly-run");
    expect(run).toHaveLength(1);
    expect(run[0].body.key).toBe("2026-09-11");
    expect(run[0].body.data).toMatchObject({ day: "2026-09-11", sessionId: "sess-earlier", file: "tts/weekly/2026-09-11.md" });
  });
});

describe("priorAgendaLines", () => {
  it("says so on the first week, and when the checkout was absent", () => {
    expect(priorAgendaLines({ checkout: true, file: null, day: null, outcome: null })).toEqual([FIRST_WEEK_LINE]);
    expect(priorAgendaLines({ checkout: false, file: null, day: null, outcome: null })).toEqual([CHECKOUT_ABSENT_LINE]);
  });

  it("carries last week's outcome, or says its section is empty", () => {
    expect(priorAgendaLines({ checkout: true, file: "tts/weekly/2026-09-04.md", day: "2026-09-04", outcome: null })[0]).toBe(
      "Last week's agenda (tts/weekly/2026-09-04.md): its Outcome section is empty — the session was not held, or its outcome was not written.",
    );
    expect(
      priorAgendaLines({ checkout: true, file: "tts/weekly/2026-09-04.md", day: "2026-09-04", outcome: "timing: on time\nsustainable: yes" }),
    ).toEqual(["Last week's agenda (tts/weekly/2026-09-04.md), outcome:", "  timing: on time", "  sustainable: yes"]);
  });
});

describe("parseAgendaAnswer", () => {
  const fork = {
    title: "the ignored one",
    subject: { type: "life", id: "t6" },
    sides: [
      { option: "archive it", cost: "the intent is lost from the active list" },
      { option: "keep it", cost: "another week of surfacing untouched" },
    ],
    recommendation: "archive: three surfacings and no touch",
  };

  it("takes lines and forks, subject included, and zero forks", () => {
    const parsed = parseAgendaAnswer(`\`\`\`json\n${JSON.stringify({ lines: [" Completed: 1. "], forks: [fork] })}\n\`\`\``);
    expect(parsed.lines).toEqual(["Completed: 1."]);
    expect(parsed.forks).toEqual([fork]);
    expect(parseAgendaAnswer(JSON.stringify({ lines: ["x"], forks: [] })).forks).toEqual([]);
    expect(parseAgendaAnswer(JSON.stringify({ lines: ["x"], forks: [{ ...fork, subject: null }] })).forks[0].subject).toBeNull();
    expect(parseAgendaAnswer(JSON.stringify({ lines: ["x"], forks: [{ ...fork, subject: { type: "code", id: "x" } }] })).forks[0].subject).toBeNull();
  });

  it("refuses a fork without two sides, a side without a cost, or no recommendation", () => {
    const answer = (f) => JSON.stringify({ lines: ["x"], forks: [f] });
    expect(() => parseAgendaAnswer(answer({ ...fork, sides: [fork.sides[0]] }))).toThrow(/exactly two sides/);
    expect(() => parseAgendaAnswer(answer({ ...fork, sides: [fork.sides[0], { option: "keep it" }] }))).toThrow(/option and a cost/);
    expect(() => parseAgendaAnswer(answer({ ...fork, recommendation: "" }))).toThrow(/no recommendation/);
    expect(() => parseAgendaAnswer(answer({ ...fork, title: "" }))).toThrow(/no title/);
    expect(() => parseAgendaAnswer(JSON.stringify({ forks: [] }))).toThrow(/lines/);
    expect(() => parseAgendaAnswer("no json here")).toThrow(/no JSON object/);
  });

  it("keeps every fork the model wrote — no cap", () => {
    const forks = Array.from({ length: 40 }, (_, i) => ({ ...fork, title: `fork ${i}` }));
    expect(parseAgendaAnswer(JSON.stringify({ lines: ["x"], forks })).forks).toHaveLength(40);
  });

  // What the session may rule on is the forks' subject ids, each once; a
  // fork about the system names none.
  it("names the forks' subjects for the session row, each once", () => {
    const { forks } = parseAgendaAnswer(
      JSON.stringify({
        lines: ["x"],
        forks: [fork, { ...fork, subject: null }, { ...fork, subject: { type: "batch", id: "b1" } }, fork],
      }),
    );
    expect(agendaSubjects(forks)).toEqual(["t6", "b1"]);
    expect(agendaSubjects([])).toEqual([]);
  });
});

describe("renderAgenda", () => {
  it("is facts, then the question verbatim, then the forks numbered, then an empty Outcome", () => {
    const text = renderAgenda({
      day: "2026-09-11",
      lines: ["Completed: 1.", "Captured: 0."],
      priorLines: [FIRST_WEEK_LINE],
      forks: [
        {
          title: "the ignored one",
          subject: { type: "life", id: "t6" },
          sides: [
            { option: "archive it", cost: "the intent leaves the active list" },
            { option: "keep it", cost: "another week untouched" },
          ],
          recommendation: "archive",
        },
        {
          title: "the cadence",
          subject: null,
          sides: [
            { option: "keep Friday", cost: "another late week if Fridays stay full" },
            { option: "move to Sunday", cost: "the digest's week ends mid-weekend" },
          ],
          recommendation: "keep Friday for one more week",
        },
      ],
    });
    const facts = text.indexOf("## Facts");
    const question = text.indexOf(SUSTAINABILITY_QUESTION);
    const forks = text.indexOf("## Forks");
    const outcome = text.indexOf(OUTCOME_HEADING);
    expect(facts).toBeGreaterThan(-1);
    expect(question).toBeGreaterThan(facts);
    expect(forks).toBeGreaterThan(question);
    expect(outcome).toBeGreaterThan(forks);
    expect(text).toContain("\n## The question\n\ndid this week feel sustainable?\n");
    expect(text).toContain("- Completed: 1.");
    expect(text).toContain(`- ${FIRST_WEEK_LINE}`);
    expect(text).toContain("1. the ignored one (life t6)\n   - A: archive it — cost: the intent leaves the active list\n   - B: keep it — cost: another week untouched\n   - recommendation: archive");
    expect(text).toContain("2. the cadence\n");
    expect(text.trimEnd().endsWith(OUTCOME_HEADING)).toBe(true);
    expect(text).not.toContain(NO_FORKS_LINE);
  });

  it("renders zero forks as the one sentence", () => {
    const text = renderAgenda({ day: "2026-09-11", lines: ["Completed: 0."], priorLines: [FIRST_WEEK_LINE], forks: [] });
    expect(text).toContain(`## Forks\n\n${NO_FORKS_LINE}\n\n${OUTCOME_HEADING}`);
    expect(text).toContain(SUSTAINABILITY_QUESTION);
  });

  it("numbers every fork — no cap", () => {
    const forks = Array.from({ length: 25 }, (_, i) => ({
      title: `fork ${i + 1}`,
      subject: null,
      sides: [
        { option: "a", cost: "b" },
        { option: "c", cost: "d" },
      ],
      recommendation: "a",
    }));
    const text = renderAgenda({ day: "2026-09-11", lines: [], priorLines: [FIRST_WEEK_LINE], forks });
    expect(text).toContain("\n25. fork 25\n");
  });

  it("says when the model call failed and still carries the facts", () => {
    const text = renderAgenda({
      day: "2026-09-11",
      lines: renderFactLines(emptyFacts()),
      priorLines: [FIRST_WEEK_LINE],
      forks: [],
      modelError: "claude returned an error envelope",
    });
    expect(text).toContain("(the model call failed — claude returned an error envelope — so these are the gathered facts as the job rendered them, and no forks were written)");
    expect(text).toContain("- Todos: 0 prepared, 0 unprepared.");
    expect(text).toContain(NO_FORKS_LINE);
  });

  it("names the file under tts/weekly by the day", () => {
    expect(agendaFileName("2026-09-11")).toBe("tts/weekly/2026-09-11.md");
  });
});

describe("the outcome", () => {
  it("appends under the Outcome heading, and again after it", () => {
    const agenda = renderAgenda({ day: "2026-09-11", lines: [], priorLines: [FIRST_WEEK_LINE], forks: [] });
    const once = appendOutcome(agenda, "timing: on time\nsustainable: yes\nrulings:\n");
    expect(once.endsWith(`${OUTCOME_HEADING}\n\ntiming: on time\nsustainable: yes\nrulings:\n`)).toBe(true);
    const twice = appendOutcome(once, "note: added later");
    expect(twice.endsWith("rulings:\n\nnote: added later\n")).toBe(true);
    expect(appendOutcome("no heading here", "timing: late")).toBe(`no heading here\n\n${OUTCOME_HEADING}\n\ntiming: late\n`);
  });

  it("reads the timing off the first line, one of three words", () => {
    expect(outcomeTimingOf("timing: on time\nsustainable: yes")).toBe("on time");
    expect(outcomeTimingOf("Timing: Late")).toBe("late");
    expect(outcomeTimingOf("timing: skipped")).toBe("skipped");
    expect(outcomeTimingOf("timing: early")).toBeNull();
    expect(outcomeTimingOf("sustainable: yes\ntiming: late")).toBeNull();
    expect(outcomeTimingOf("")).toBeNull();
  });
});

describe("the session's pens' arguments", () => {
  it("accepts an area page path and a date, nothing else", () => {
    expect(isAreaPagePath("model-of-tom/areas/research.md")).toBe(true);
    expect(isAreaPagePath("model-of-tom/writing.md")).toBe(false);
    expect(isAreaPagePath("model-of-tom/areas/../writing.md")).toBe(false);
    expect(isAreaPagePath("/root/wikitom/model-of-tom/areas/research.md")).toBe(false);
    expect(isDay("2026-09-11")).toBe(true);
    expect(isDay("2026-9-11")).toBe(false);
    expect(isDay("friday")).toBe(false);
    // Date.parse takes Feb 30 as March 2; the round trip does not.
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("2028-02-29")).toBe(true);
  });
});

describe("sessionPrompt", () => {
  const agenda = renderAgenda({ day: "2026-09-11", lines: ["Completed: 0."], priorLines: [FIRST_WEEK_LINE], forks: [] });

  it("carries the agenda, the question verbatim, and the two pens", () => {
    const text = sessionPrompt({ day: "2026-09-11", agenda, file: "tts/weekly/2026-09-11.md", checkout: true });
    expect(text).toContain(`"${SUSTAINABILITY_QUESTION}"`);
    expect(text).toContain("It is the file tts/weekly/2026-09-11.md in the WikiTom checkout on this box");
    expect(text).toContain("node /opt/tts/weekly.mjs reviewed model-of-tom/areas/<page>.md <today, YYYY-MM-DD>");
    expect(text).toContain("node /opt/tts/weekly.mjs outcome 2026-09-11 <that file>");
    expect(text).toContain('"$CONVEX_SITE_URL/tts/ruling"');
    expect(text.endsWith(agenda)).toBe(true);
  });

  it("says the checkout was absent, and still carries the agenda", () => {
    const text = sessionPrompt({ day: "2026-09-11", agenda, file: null, checkout: false });
    expect(text).toContain("The WikiTom checkout was absent when the job ran, so the agenda exists only in this prompt");
    expect(text.endsWith(agenda)).toBe(true);
  });
});

describe("buildAgendaPrompt", () => {
  it("gives the model the facts and last week, asks for every fork with zero valid, and forbids grading", () => {
    const text = buildAgendaPrompt({ factLines: renderFactLines(emptyFacts()), priorLines: [FIRST_WEEK_LINE] });
    expect(text).toContain("THE FACTS:\nWindow: 2026-09-04 to 2026-09-11 (seven days).");
    expect(text).toContain(`LAST WEEK:\n${FIRST_WEEK_LINE}`);
    expect(text).toContain("NO CAPS");
    expect(text).toContain("ZERO forks is a valid answer");
    expect(text).toContain("no score, no grade");
    expect(text).toContain('"sides": exactly two objects');
  });
});
