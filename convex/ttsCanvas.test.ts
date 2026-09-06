import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";
import {
  ASSIGNMENT_SOURCE,
  type AssignmentInput,
  canvasProvenance,
  provenanceExternalId,
} from "./ttsCanvas";

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
  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("records the job and its plain message as a digest-readable failure", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const error = "Canvas rejected the access token (HTTP 401)";
    expect((await report(t, { job: "poll-canvas", error })).status).toBe(200);

    const rows = (await allEvents(t)).filter((e) => e.kind === "job-failed");
    expect(rows).toHaveLength(1);
    // The kind ends in "-failed", which is the whole rule convex/ttsDigest.ts
    // reads to put a row in the morning digest's failures section.
    expect(rows[0].kind.endsWith("-failed")).toBe(true);
    expect(rows[0].data).toEqual({ job: "poll-canvas", error });
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
