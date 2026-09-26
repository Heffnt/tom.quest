import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";
import {
  ASSIGNMENT_SOURCE,
  type AssignmentInput,
  canvasProvenance,
  provenanceExternalId,
} from "./ttsCanvas";
import { gatherTodayFacts } from "./ttsDigest";
import { DAY_MS, nyCalendarDayKey } from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// The sync does no windowing of its own — worker/jobs/poll-canvas.mjs owns the
// fetch and the window now (mapCanvasAssignments lives there, with its tests),
// so these instants only need to be stable, not near the real clock.
const DUE = Date.UTC(2026, 8, 3, 3, 59); // 2026-09-02 23:59 EDT
const URL_14 = "https://canvas.wpi.edu/courses/1/assignments/14";

function assignment(over: Partial<AssignmentInput> = {}): AssignmentInput {
  return {
    externalId: "14",
    courseCode: "CS4241",
    name: "Project 3",
    htmlUrl: URL_14,
    dueAt: DUE,
    submitted: false,
    ...over,
  };
}

async function sync(t: ReturnType<typeof convexTest>, assignments: AssignmentInput[]) {
  return await t.mutation(internal.ttsCanvas.internalSyncCanvasTodos, {
    assignments,
  });
}

const allTodos = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
const allEvents = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("dtsEvents").collect());

/** Tom, for the reopen tests: setStatus is his door and it is gated on him. */
async function withTom(t: ReturnType<typeof convexTest>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}

describe("canvas provenance", () => {
  it("round-trips the assignment id through the provenance string", () => {
    const p = canvasProvenance("98765", URL_14);
    expect(p).toBe(`canvas:assignment:98765 ${URL_14}`);
    expect(provenanceExternalId(p)).toBe("98765");
    // A todo from any other source carries no assignment id to match on.
    expect(provenanceExternalId(undefined)).toBeNull();
    expect(provenanceExternalId("slack:C123/p170")).toBeNull();
  });
});

describe("internalSyncCanvasTodos", () => {
  it("inserts one dated, external todo per new unsubmitted assignment", async () => {
    const t = convexTest({ schema, modules });
    const result = await sync(t, [assignment()]);
    expect(result).toMatchObject({ seen: 1, created: 1, completed: 0, dateMoved: 0 });

    const todos = await allTodos(t);
    expect(todos).toHaveLength(1);
    const todo = todos[0];
    expect(todo.statement).toBe("CS4241: Project 3");
    expect(todo.source).toBe("canvas");
    expect(todo.status).toBe("active");
    expect(todo.timingClass).toBe("dated");
    expect(todo.dateKind).toBe("external"); // an instructor's date, not Tom's
    expect(todo.dueAt).toBe(DUE);
    expect(todo.provenance).toBe(canvasProvenance("14", URL_14));
    expect(todo.entryAction).toBe(`Open ${URL_14}`);

    const captured = (await allEvents(t)).filter((e) => e.kind === "captured");
    expect(captured).toHaveLength(1);
    expect(captured[0].todoId).toBe(todo._id);
    expect(captured[0].data).toEqual({ source: "canvas" });
  });

  it("is idempotent — the same assignment twice is still one todo", async () => {
    const t = convexTest({ schema, modules });
    await sync(t, [assignment()]);
    const second = await sync(t, [assignment()]);
    expect(second).toMatchObject({ created: 0, completed: 0, dateMoved: 0 });
    expect(await allTodos(t)).toHaveLength(1);
  });

  it("never mints a todo for work already submitted before we saw it", async () => {
    const t = convexTest({ schema, modules });
    const result = await sync(t, [assignment({ submitted: true })]);
    expect(result).toMatchObject({ seen: 1, created: 0, completed: 0 });
    expect(await allTodos(t)).toHaveLength(0);
    expect(await allEvents(t)).toHaveLength(0);
  });

  it("moves the date when the instructor moves it, ignoring sub-minute jitter", async () => {
    const t = convexTest({ schema, modules });
    await sync(t, [assignment()]);

    // Canvas re-reports the same instant a few seconds off: not a real move.
    const jitter = await sync(t, [assignment({ dueAt: DUE + 30_000 })]);
    expect(jitter.dateMoved).toBe(0);
    expect((await allTodos(t))[0].dueAt).toBe(DUE);

    const moved = DUE + 2 * 86_400_000;
    const result = await sync(t, [assignment({ dueAt: moved })]);
    expect(result.dateMoved).toBe(1);
    const todo = (await allTodos(t))[0];
    expect(todo.dueAt).toBe(moved);
    expect(todo.timingClass).toBe("dated");
    // No date OUTCOME: an upstream move is a corrected fact, not a
    // renegotiation Tom has to answer for (kept-dates rule, spec §8).
    expect(todo.dateOutcomes).toBeUndefined();

    const updated = (await allEvents(t)).filter((e) => e.kind === "updated");
    expect(updated).toHaveLength(1);
    expect(updated[0].todoId).toBe(todo._id);
    expect(updated[0].data).toEqual({ fields: ["dueAt"], via: "canvas-sync" });
  });

  it("completes an open todo when Canvas shows a submission", async () => {
    const t = convexTest({ schema, modules });
    await sync(t, [assignment()]);
    const before = (await allTodos(t))[0];

    const result = await sync(t, [assignment({ submitted: true })]);
    expect(result).toMatchObject({ completed: 1, created: 0 });

    const todo = (await allTodos(t))[0];
    expect(todo._id).toBe(before._id); // completed in place, never re-minted
    expect(todo.status).toBe("done");
    expect(todo.doneAt).toBeDefined();
    // applyDateOutcome files the kept date and CLEARS dueAt — the obligation
    // is discharged, so nothing is still owed on that instant.
    expect(todo.dueAt).toBeUndefined();
    expect(todo.dateOutcomes).toHaveLength(1);
    expect(todo.dateOutcomes?.[0]).toMatchObject({
      dueAt: DUE,
      outcome: "done",
      note: "submitted on Canvas",
    });
    expect(
      (await allEvents(t)).some(
        (e) => e.kind === "date-outcome" && e.todoId === todo._id,
      ),
    ).toBe(true);
  });

  // The label defect this file was fixed for: worker/jobs/poll-canvas.mjs used
  // to capture Canvas ANNOUNCEMENTS under this same source, so every sync read
  // them, failed to key them, and dropped them without a word. Announcements
  // now carry "canvas-announcement"; a row under "canvas" that is not an
  // assignment is a fact the sync REPORTS instead of swallowing.
  it("reports, and never adopts, a source-canvas row that is not an assignment", async () => {
    const t = convexTest({ schema, modules });
    const strayId = await t.run(async (ctx) =>
      ctx.db.insert("dtsTodos", {
        statement: "Sign up for the CS4241 demo slot",
        readiness: "unprepared",
        status: "active",
        timingClass: "whenever",
        kind: "task",
        actor: "tom",
        source: ASSIGNMENT_SOURCE,
        provenance: "https://canvas.wpi.edu/courses/1/discussion_topics/991",
        createdAt: 1,
        updatedAt: 1,
      }),
    );

    const result = await sync(t, [assignment()]);
    expect(result).toMatchObject({ created: 1, foreign: 1 });

    // The stray row is untouched — not completed, not re-dated, not re-minted
    // as an assignment — and the real assignment still got its own row.
    const stray = await t.run(async (ctx) => ctx.db.get(strayId));
    expect(stray).toMatchObject({ status: "active", timingClass: "whenever" });
    expect(await allTodos(t)).toHaveLength(2);
  });

  it("counts no foreign rows when every canvas row is an assignment", async () => {
    const t = convexTest({ schema, modules });
    await sync(t, [assignment()]);
    expect(await sync(t, [assignment()])).toMatchObject({ foreign: 0 });
  });

  // TOM'S ANSWER IS THE NEWER ONE. Canvas keeps saying "submitted" for ever,
  // so a row he deliberately put back — wrong file, a resubmission asked for,
  // the work not actually finished — was completed again by the next tick,
  // within thirty minutes and with no message anywhere.
  it("does not re-complete an assignment Tom reopened after it was completed", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await sync(t, [assignment()]);
    await sync(t, [assignment({ submitted: true })]);
    const id = (await allTodos(t))[0]._id;
    expect((await allTodos(t))[0].status).toBe("done");

    await tom.mutation(api.tts.setStatus, { id, status: "active" });
    const reopenedAt = (await allTodos(t))[0].updatedAt;
    const eventCount = (await allEvents(t)).length;

    // Canvas still reports the submission, every half hour, for ever.
    const result = await sync(t, [assignment({ submitted: true })]);
    expect(result).toMatchObject({ completed: 0, reopened: 1 });
    const todo = (await allTodos(t))[0];
    expect(todo.status).toBe("active");
    expect(todo.doneAt).toBeUndefined();
    expect(todo.updatedAt).toBe(reopenedAt); // not touched at all
    expect(await allEvents(t)).toHaveLength(eventCount);

    // And it stays reopened however many ticks Canvas gets.
    expect(await sync(t, [assignment({ submitted: true })])).toMatchObject({
      completed: 0,
      reopened: 1,
    });
    expect((await allTodos(t))[0].status).toBe("active");
  });

  it("still completes a submitted assignment that has never been completed", async () => {
    // The guard is about a completion Tom answered, not about any status
    // change: an ordinary row archived and made active again has no completion
    // behind it, and its submission is still the fact that finishes it.
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await sync(t, [assignment()]);
    const id = (await allTodos(t))[0]._id;
    await tom.mutation(api.tts.setStatus, { id, status: "archived" });
    await tom.mutation(api.tts.setStatus, { id, status: "active" });

    expect(await sync(t, [assignment({ submitted: true })])).toMatchObject({
      completed: 1,
      reopened: 0,
    });
    expect((await allTodos(t))[0].status).toBe("done");
  });

  it("leaves an already-done todo untouched on later syncs", async () => {
    const t = convexTest({ schema, modules });
    await sync(t, [assignment()]);
    await sync(t, [assignment({ submitted: true })]);
    const done = (await allTodos(t))[0] as Doc<"dtsTodos">;
    const eventCount = (await allEvents(t)).length;

    // Both a still-submitted report and a late date move must be no-ops: the
    // row is terminal, and re-resolving it would double-file the outcome.
    const again = await sync(t, [
      assignment({ submitted: true, dueAt: DUE + 7 * 86_400_000 }),
    ]);
    expect(again).toMatchObject({ created: 0, completed: 0, dateMoved: 0 });
    expect(await allTodos(t)).toEqual([done]);
    expect(await allEvents(t)).toHaveLength(eventCount);
  });
});

// ── The door the box poller comes through (the lifeos update, phase 6) ───────
// worker/jobs/poll-canvas.mjs owns the fetch now — one job, one CANVAS_TOKEN
// copy — and posts the whole window here every 30 minutes. That makes REPLAY
// the ordinary case, not an edge one, so it is checked at the door and not
// only at the mutation.
describe("POST /tts/canvas-assignments", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function post(t: ReturnType<typeof convexTest>, body: unknown, key = "s3cret") {
    return await t.fetch("/tts/canvas-assignments", {
      method: "POST",
      headers: { "X-TTS-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("syncs what the poller read, and a replay of it creates no second todo", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });

    const first = await post(t, { assignments: [assignment()] });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, seen: 1, created: 1 });

    // The next tick reads the same window and posts the same assignment.
    const replay = await post(t, { assignments: [assignment()] });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      created: 0,
      completed: 0,
      dateMoved: 0,
    });
    expect(await allTodos(t)).toHaveLength(1);
  });

  it("refuses a body that is not an assignments array", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const res = await post(t, { assignments: "all of them" });
    expect(res.status).toBe(400);
    expect(await allTodos(t)).toHaveLength(0);
  });

  it("is closed to a caller without the worker key", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    expect((await post(t, { assignments: [assignment()] }, "nope")).status).toBe(401);
    expect(await allTodos(t)).toHaveLength(0);
  });
});

// ── The box's one voice for a failure (the lifeos update, phase 6) ───────────
// A cron job on the Jarvis Box could only ever write to /var/log/tts, which Tom
// does not read. This route is how an expired Canvas token becomes a line in
// the morning digest instead.
describe("POST /tts/job-failed", () => {
  // Fake timers, so a test can set the instant its reports land at and the
  // window the digest reads them over.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function report(
    t: ReturnType<typeof convexTest>,
    body: unknown,
    key = "s3cret",
  ) {
    return await t.fetch("/tts/job-failed", {
      method: "POST",
      headers: { "X-TTS-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function ok(t: ReturnType<typeof convexTest>, body: unknown, key = "s3cret") {
    return await t.fetch("/tts/job-ok", {
      method: "POST",
      headers: { "X-TTS-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // A job's reports live in the record's events table (convex/jarvis/jobs.ts):
  // every post is a row, and a repeat of a standing condition carries
  // data.standingSince. The reports are the rows without it.
  const recordRows = (t: ReturnType<typeof convexTest>) => t.run(async (ctx) => ctx.db.query("events").collect());
  const failures = async (t: ReturnType<typeof convexTest>) =>
    (await recordRows(t)).filter(
      (e) => e.kind === "job-failed" && (e.data as { standingSince?: number }).standingSince === undefined,
    );

  it("records the job and its plain message as a digest-readable failure", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const error = "Canvas rejected the access token (HTTP 401)";
    expect((await report(t, { job: "poll-canvas", error })).status).toBe(200);

    const rows = await failures(t);
    expect(rows).toHaveLength(1);
    // The kind ends in "-failed", which is the whole rule convex/ttsDigest.ts
    // reads to put a row in the morning digest's failures section.
    expect(rows[0].kind.endsWith("-failed")).toBe(true);
    expect(rows[0].data).toEqual({ job: "poll-canvas", error });
    expect(rows[0].subject).toBeUndefined(); // an unkeyed report is per call
  });

  // A DEAD CREDENTIAL IS DEAD FOR DAYS, and the job reporting it runs every
  // thirty minutes. Unkeyed that was a row every half hour for ever: the
  // morning digest listed each one and the hourly update repeated the same
  // sentence around the clock, burying the one fact Tom needed under its own
  // repetitions.
  it("reports once per condition, however many ticks post it", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const failure = {
      job: "poll-canvas",
      error: "Canvas rejected the access token (HTTP 401)",
      key: "poll-canvas:canvas-auth",
    };
    expect(await (await report(t, failure)).json()).toMatchObject({ reported: true });
    for (let tick = 0; tick < 5; tick++) {
      expect(await (await report(t, failure)).json()).toMatchObject({
        reported: false,
      });
    }
    const rows = await failures(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe("poll-canvas:canvas-auth");
  });

  it("reports the next expiry, because the clean run in between closed the last", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const key = "poll-canvas:canvas-auth";
    const failure = { job: "poll-canvas", error: "HTTP 401", key };
    await report(t, failure);

    // Tom minted a new token and the job read Canvas again.
    const recovery = await ok(t, { job: "poll-canvas", key });
    expect(recovery.status).toBe(200);
    expect(await recovery.json()).toMatchObject({ recovered: true });
    // A clean run that ends nothing is not news and writes nothing.
    expect(await (await ok(t, { job: "poll-canvas", key })).json()).toMatchObject({
      recovered: false,
    });
    const recovered = (await recordRows(t)).filter((e) => e.kind === "job-recovered");
    expect(recovered).toHaveLength(1);
    expect(recovered[0].subject).toBe(key);

    // Months later the new token expires too, and that is a second fact.
    expect(await (await report(t, failure)).json()).toMatchObject({ reported: true });
    expect(await failures(t)).toHaveLength(2);
  });

  it("keeps two conditions apart, and an unkeyed report out of both", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    await report(t, { job: "poll-canvas", error: "HTTP 401", key: "a" });
    await report(t, { job: "poll-gmail", error: "no verdict", key: "b" });
    await report(t, { job: "poll-canvas", error: "one bad run" });
    await report(t, { job: "poll-canvas", error: "another bad run" });
    expect(await failures(t)).toHaveLength(4);
  });

  // A job's failure reaches Tom as a line in the digest's broken section,
  // read from its own row (convex/ttsDigest.ts gatherTodayFacts, through
  // convex/jarvis/jobs.ts failuresInWindow). Nothing posts to Slack on a
  // report: there is one output channel, and the digest is what it carries.
  const slackScheduled = async (t: ReturnType<typeof convexTest>) =>
    await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.name.includes("ttsSync")),
    );
  const digestBroken = async (t: ReturnType<typeof convexTest>) =>
    await t.run(async (ctx) => {
      const now = Date.now() + 1;
      const facts = await gatherTodayFacts(ctx, { day: nyCalendarDayKey(now), now, since: now - DAY_MS });
      return facts.broken;
    });

  it("puts one digest failure for a report, marks a condition already standing, and posts nothing", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    vi.setSystemTime(Date.UTC(2026, 8, 26, 12));
    const t = convexTest({ schema, modules });
    const failure = {
      job: "agents-sweep",
      error: "the sweep could not read the run table",
      key: "agents-sweep:read",
    };
    expect(await (await report(t, failure)).json()).toMatchObject({ reported: true });
    expect(await digestBroken(t)).toEqual([
      { statement: "The agents-sweep job failed overnight.", detail: failure.error, count: 1 },
    ]);

    // The same condition again the same day: its row is marked standing, and
    // the digest still reads the one report.
    vi.setSystemTime(Date.UTC(2026, 8, 26, 12, 30));
    expect(await (await report(t, failure)).json()).toMatchObject({ reported: false });
    const rows = (await recordRows(t)).filter((e) => e.kind === "job-failed").sort((a, b) => a.at - b.at);
    expect(rows.map((e) => (e.data as { standingSince?: number }).standingSince)).toEqual([
      undefined,
      Date.UTC(2026, 8, 26, 12),
    ]);
    expect(await digestBroken(t)).toHaveLength(1);
    expect((await digestBroken(t))[0].count).toBe(1);
    expect(await slackScheduled(t)).toEqual([]);
  });

  it("puts exactly one digest failure per job, however many reports, counting them", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    vi.setSystemTime(Date.UTC(2026, 8, 26, 12));
    const t = convexTest({ schema, modules });
    // Unkeyed, so each report is its own row; the line is still one per job.
    for (const body of [
      { job: "deploy", error: "vercel build failed" },
      { job: "deploy", error: "vercel build failed again" },
      { job: "agents-sweep", error: "sweep failed" },
    ]) {
      await report(t, body);
      vi.advanceTimersByTime(60_000);
    }

    expect(await failures(t)).toHaveLength(3);
    const broken = await digestBroken(t);
    expect(broken).toHaveLength(2);
    expect(broken.filter((b) => b.statement.includes("deploy"))).toMatchObject([{ count: 2 }]);
    expect(broken.filter((b) => b.statement.includes("agents-sweep"))).toMatchObject([{ count: 1 }]);
    expect(await slackScheduled(t)).toEqual([]);
  });

  // witness: the digest grouped failures by job, so two conditions of one
  // job were one line, and the one that recovered made the line say the job
  // ran clean again while the other still failed.
  it("puts one digest line per condition, so a recovered one does not mask another of the same job", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    vi.setSystemTime(Date.UTC(2026, 8, 26, 12));
    const t = convexTest({ schema, modules });
    await report(t, { job: "poll-canvas", key: "poll-canvas:canvas-auth", error: "Canvas rejected the token" });
    vi.advanceTimersByTime(60_000);
    await report(t, { job: "poll-canvas", key: "poll-canvas:feed", error: "the feed timed out" });
    vi.advanceTimersByTime(60_000);
    expect((await ok(t, { job: "poll-canvas", key: "poll-canvas:feed" })).status).toBe(200);
    const broken = await digestBroken(t);
    expect(broken).toHaveLength(2);
    expect(broken.filter((b) => b.statement.includes("running clean again") || b.statement.includes("run clean again"))).toHaveLength(1);
    expect(broken.find((b) => b.detail === "Canvas rejected the token")?.statement).not.toContain("clean again");
  });

  // witness: the line kept the first report's statement, so a condition
  // that failed, recovered and failed again read as running clean.
  it("reads a condition that failed again after it recovered as failing", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    vi.setSystemTime(Date.UTC(2026, 8, 26, 12));
    const t = convexTest({ schema, modules });
    await report(t, { job: "poll-canvas", key: "poll-canvas:canvas-auth", error: "first failure" });
    vi.advanceTimersByTime(60_000);
    expect((await ok(t, { job: "poll-canvas", key: "poll-canvas:canvas-auth" })).status).toBe(200);
    vi.advanceTimersByTime(60_000);
    await report(t, { job: "poll-canvas", key: "poll-canvas:canvas-auth", error: "second failure" });
    const broken = await digestBroken(t);
    expect(broken).toHaveLength(1);
    expect(broken[0].statement).not.toContain("clean again");
    expect(broken[0].detail).toBe("second failure");
  });

  it("refuses a blank key on either route, and an unnamed clean run", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    expect((await report(t, { job: "j", error: "e", key: "  " })).status).toBe(400);
    expect((await report(t, { job: "j", error: "e", key: 17 })).status).toBe(400);
    expect((await ok(t, { job: "j" })).status).toBe(400);
    expect((await ok(t, { key: "a" })).status).toBe(400);
    expect((await ok(t, { job: "j", key: "a" }, "nope")).status).toBe(401);
    expect(await allEvents(t)).toHaveLength(0);
  });

  it("refuses a report that names no job or no error", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    for (const body of [
      { error: "x" },
      { job: "poll-canvas" },
      { job: "", error: "x" },
    ]) {
      expect((await report(t, body)).status).toBe(400);
    }
    expect(await allEvents(t)).toHaveLength(0);
  });

  it("is closed to a caller without the worker key", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    expect(
      (await report(t, { job: "poll-canvas", error: "x" }, "nope")).status,
    ).toBe(401);
    expect(await allEvents(t)).toHaveLength(0);
  });
});
