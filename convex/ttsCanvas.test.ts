import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";
import {
  type AssignmentInput,
  canvasProvenance,
  mapCanvasAssignments,
  provenanceExternalId,
} from "./ttsCanvas";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// The sync does no windowing of its own (mapCanvasAssignments already did it),
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

describe("mapCanvasAssignments", () => {
  const now = Date.UTC(2026, 7, 27, 12); // window: 2026-08-13 .. 2026-10-26

  it("keeps only published, dated, in-window assignments", () => {
    const courses = [
      { id: 1, course_code: "CS4241", name: "Webware" },
      { id: 2, name: "Mathematical Modeling" }, // no course_code -> name
    ];
    const byCourse = new Map([
      [
        1,
        [
          { id: 10, name: "draft", due_at: "2026-08-30T03:59:00Z", published: false },
          { id: 11, name: "no date", due_at: null, published: true },
          { id: 12, name: "final exam", due_at: "2026-12-01T05:00:00Z" }, // past windowEnd
          { id: 13, name: "week 1", due_at: "2026-07-20T05:00:00Z" }, // before windowStart
          { id: 14, name: "unparseable", due_at: "not a date" },
          {
            id: 15,
            name: "Project 3",
            html_url: URL_14,
            due_at: "2026-08-30T03:59:00Z",
            published: true,
            submission: { submitted_at: null },
          },
        ],
      ],
      [
        2,
        [
          {
            id: 20,
            name: "HW 5",
            html_url: "https://canvas.wpi.edu/courses/2/assignments/20",
            due_at: "2026-08-25T03:59:00Z",
            submission: { submitted_at: "2026-08-24T18:02:00Z" },
          },
        ],
      ],
    ]);

    const out = mapCanvasAssignments(courses, byCourse, now);
    expect(out.map((a) => a.externalId)).toEqual(["15", "20"]);
    expect(out[0]).toEqual({
      externalId: "15",
      courseCode: "CS4241",
      name: "Project 3",
      htmlUrl: URL_14,
      dueAt: Date.UTC(2026, 7, 30, 3, 59),
      submitted: false,
    });
    // course_code absent -> the course name stands in as the statement prefix.
    expect(out[1].courseCode).toBe("Mathematical Modeling");
    expect(out[1].submitted).toBe(true);
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
