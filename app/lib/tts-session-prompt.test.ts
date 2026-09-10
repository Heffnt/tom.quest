import { describe, expect, it } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import {
  buildBatchSessionPrompt,
  buildTodoSessionPrompt,
} from "./tts-session-prompt";

const todo = {
  _id: "todo-1",
  _creationTime: 1,
  statement: "review the deployment plan",
  status: "active",
  readiness: "prepared",
  createdAt: 1,
  updatedAt: 1,
} as unknown as Doc<"dtsTodos">;

describe("interactive session prompts", () => {
  it("keeps interactive framing to the session's scope before item data", () => {
    const prompt = buildTodoSessionPrompt(todo, "gate");

    expect(prompt.startsWith("You are working inside TTS")).toBe(true);
    expect(prompt).toContain("Stay scoped to the single item below unless Tom widens the scope");
    expect(prompt).not.toContain("Follow the writing standard");
    expect(prompt).not.toContain("what Tom needs to decide plus a recommendation");
    expect(prompt.indexOf("This is a tom-gate session:")).toBeLessThan(
      prompt.indexOf('The item ("review the deployment plan"):'));
  });

  it("keeps batch action rules without restating the shared vocabulary", () => {
    const prompt = buildBatchSessionPrompt({
      id: "batch-1" as never,
      statement: "ship the deployment plan",
      tasks: [],
      goals: [],
    });

    expect(prompt).toContain("This is a batch session. Work the ready tasks with Tom");
    expect(prompt).not.toContain("A BATCH holds how a set of todos gets completed");
    expect(prompt.indexOf("This is a batch session.")).toBeLessThan(
      prompt.indexOf('THE BATCH ("ship the deployment plan"):'));
  });
});
