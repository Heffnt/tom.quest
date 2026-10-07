import { describe, expect, it } from "vitest";
import {
  TODO_CREATE_FIELDS,
  TODO_OPEN_STATUSES,
  TODO_STATEMENT_MAX,
  todoCreateProblem,
  todoDoneProblem,
} from "../jarvis-todos.mjs";
import { FACT_KINDS, REPEATS_BY_DATA_ID } from "../jarvis-events.mjs";

describe("a todo create", () => {
  it("takes his words alone, or with a due and a reminder time", () => {
    expect(todoCreateProblem({ statement: "buy desk" })).toBeNull();
    expect(todoCreateProblem({ statement: "oil change", dueAt: 1_791_000_000_000, reminderAt: 1_790_990_000_000, writeId: "todo:abc" })).toBeNull();
    expect(TODO_CREATE_FIELDS).toEqual(["statement", "dueAt", "reminderAt", "writeId"]);
  });

  it("refuses a missing, blank or overlong statement", () => {
    expect(todoCreateProblem({})).toMatch(/statement, his words/);
    expect(todoCreateProblem({ statement: "  " })).toMatch(/statement, his words/);
    expect(todoCreateProblem({ statement: "x".repeat(TODO_STATEMENT_MAX + 1) })).toMatch(/at most 2000/);
  });

  it("refuses a time that is not whole epoch milliseconds", () => {
    expect(todoCreateProblem({ statement: "a", dueAt: "2026-10-08" })).toMatch(/dueAt/);
    expect(todoCreateProblem({ statement: "a", dueAt: 1.5 })).toMatch(/dueAt/);
    expect(todoCreateProblem({ statement: "a", reminderAt: -1 })).toMatch(/reminderAt/);
  });

  it("refuses a field the table does not hold, naming it", () => {
    expect(todoCreateProblem({ statement: "a", due: 1 })).toBe("a todo holds only statement, dueAt, reminderAt, writeId; due is not one of them");
    expect(todoCreateProblem(["a"])).toBe("a todo is a JSON object");
    expect(todoCreateProblem({ statement: "a", writeId: "" })).toMatch(/writeId/);
  });
});

describe("a todo done", () => {
  it("names the todo's id and nothing else", () => {
    expect(todoDoneProblem({ todo: "k123" })).toBeNull();
    expect(todoDoneProblem({ todo: "" })).toMatch(/todo, the todo's id/);
    expect(todoDoneProblem({ todo: "k1", note: "x" })).toBe("a done holds only todo; note is not it");
  });

  it("leaves open meaning active or waiting", () => {
    expect(TODO_OPEN_STATUSES).toEqual(["active", "waiting"]);
  });
});

describe("the day facts", () => {
  it("are recorded once per data.id, so a resend is not a second fact", () => {
    for (const kind of FACT_KINDS) expect(REPEATS_BY_DATA_ID).toContain(kind);
  });
});
