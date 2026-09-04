// @vitest-environment node
//
// The fork-transcript rendering (fork-transcript.mjs): what a "reopen as"
// session finds in .tts-transcript.md. Pinned against the GET
// /sessions/transcript row shape — { seq, turn, kind, content,
// parentToolUseId?, createdAt } — because that file is the ONLY continuity a
// cross-family fork has.

import { describe, expect, it } from "vitest";

import { FORK_TRANSCRIPT_FILE, renderTranscript } from "../fork-transcript.mjs";

const rows = [
  { seq: 1, turn: 1, kind: "user", content: { text: "fix the bug" }, createdAt: 1 },
  { seq: 2, turn: 1, kind: "thinking", content: { text: "secret scratch" }, createdAt: 2 },
  {
    seq: 3,
    turn: 1,
    kind: "tool-call",
    content: { toolName: "Bash", toolUseId: "t1", input: { command: "grep -r bug .\n".repeat(50) } },
    createdAt: 3,
  },
  {
    seq: 4,
    turn: 1,
    kind: "tool-result",
    content: { toolUseId: "t1", content: "x".repeat(2000), isError: true },
    createdAt: 4,
  },
  {
    seq: 5,
    turn: 1,
    kind: "tool-call",
    content: { toolName: "Read", toolUseId: "t2", input: { file_path: "a.ts" } },
    parentToolUseId: "task-1",
    createdAt: 5,
  },
  { seq: 6, turn: 1, kind: "assistant-text", content: { text: "Fixed it." }, createdAt: 6 },
  { seq: 7, turn: 2, kind: "system", content: { text: "model changed to sonnet" }, createdAt: 7 },
  { seq: 8, turn: 2, kind: "error", content: { message: "usage limit reached" }, createdAt: 8 },
  { seq: 9, turn: 2, kind: "permission", content: { toolName: "Bash", status: "allowed" }, createdAt: 9 },
];

describe("renderTranscript", () => {
  const md = renderTranscript(rows, { forkedFrom: "sess_1" });

  it("names the source session and the file is the agreed one", () => {
    expect(md).toMatch(/^# Transcript of session sess_1/);
    expect(FORK_TRANSCRIPT_FILE).toBe(".tts-transcript.md");
  });

  it("puts a header on every turn change", () => {
    expect(md).toContain("## Turn 1");
    expect(md).toContain("## Turn 2");
    expect(md.match(/## Turn /g)).toHaveLength(2);
  });

  it("renders user and assistant text in full and omits thinking", () => {
    expect(md).toContain("**User:**\n\nfix the bug");
    expect(md).toContain("**Assistant:**\n\nFixed it.");
    expect(md).not.toContain("secret scratch");
  });

  it("renders tool calls as one truncated line and results truncated", () => {
    const call = md.split("\n").find((l) => l.startsWith("- tool Bash:"));
    expect(call).toBeDefined();
    expect(call.length).toBeLessThan(330);
    expect(call).not.toContain("\n");
    const result = md.split("\n").find((l) => l.startsWith("  - result (error):"));
    expect(result).toBeDefined();
    expect(result.length).toBeLessThan(430);
  });

  it("marks subagent rows", () => {
    expect(md).toContain("- tool Read (subagent):");
  });

  it("renders system and error rows verbatim, and unknown kinds previewed", () => {
    expect(md).toContain("> system: model changed to sonnet");
    expect(md).toContain("> error: usage limit reached");
    expect(md).toContain("> permission: ");
  });

  it("renders an empty transcript without throwing", () => {
    expect(renderTranscript([], { forkedFrom: "x" })).toContain("# Transcript of session x");
  });
});
