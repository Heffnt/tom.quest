import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TranscriptMessage } from "../lib";
import MessageRow from "./message-row";

function message(kind: string, content: unknown): TranscriptMessage {
  return {
    _id: "message",
    _creationTime: 1,
    runId: "claude:laptop:root",
    seq: 1,
    turn: 0,
    kind,
    content,
    createdAt: 1,
  } as TranscriptMessage;
}

afterEach(cleanup);

describe("MessageRow run-file kinds", () => {
  it("renders context, child runs, and an unrecognised kind as collapsed raw rows", () => {
    const { container } = render(
      <>
        <MessageRow message={message("context", { modelRequested: "claude-fable-5", layersGiven: ["write", "know"], cwd: "C:/work", prompt: "work" })} />
        <MessageRow message={message("child-run", { childRunId: "claude:laptop:root/child", agentType: "research", model: "claude-fable-5", status: "completed" })} />
        <MessageRow message={message("future-runtime-row", { value: "kept raw" })} />
      </>,
    );

    const text = container.textContent ?? "";
    expect(container.querySelectorAll("details")).toHaveLength(3);
    expect(text).toContain("model claude-fable-5");
    expect(text).toContain("claude:laptop:root/child");
    expect(text).toContain("future-runtime-row");
    expect(text).toContain("kept raw");
  });
});
