import { describe, expect, it } from "vitest";
import { parseClaudeFile, parseCodexFile } from "../ingest.mjs";

const jsonl = (entries) => `${entries.map(JSON.stringify).join("\n")}\n`;

describe("run parsers", () => {
  it("maps Claude Task results, persists the source cursor, and keeps prompt parts", () => {
    const parsed = parseClaudeFile({ path: "/a.jsonl", host: "laptop", fileVersion: "version", text: jsonl([
      { type: "attachment", timestamp: "2026-01-01T00:00:00Z", sessionId: "s", attachment: { type: "instructions", content: "instruction" } },
      { type: "attachment", timestamp: "2026-01-01T00:00:01Z", sessionId: "s", attachment: { type: "session_context", content: "context" } },
      { type: "user", timestamp: "2026-01-01T00:00:02Z", sessionId: "s", message: { content: "prompt" }, origin: { kind: "human" } },
      { type: "assistant", timestamp: "2026-01-01T00:00:03Z", sessionId: "s", requestId: "r", message: { model: "model", usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: "tool_use", id: "task", name: "Task", input: { description: "remembered" } }] } },
      { type: "user", timestamp: "2026-01-01T00:00:04Z", sessionId: "s", message: { content: [{ type: "tool_result", tool_use_id: "task", content: "launched" }] }, toolUseResult: { agentId: "child", status: "async_launched", resolvedModel: "child-model" } },
    ]) });
    expect(parsed.run.file.committedLine).toBe(5);
    expect(parsed.run.context).toMatchObject({ layersKnown: false });
    expect(parsed.rows.find((row) => row.kind === "context").content.prompt).toMatch(/instruction[\s\S]*context[\s\S]*prompt/);
    expect(parsed.rows.find((row) => row.kind === "child-run").content.description).toBe("remembered");
  });

  it("takes Codex model and both permission facts from turn_context", () => {
    const parsed = parseCodexFile({ path: "/c.jsonl", host: "laptop", fileVersion: "version", text: jsonl([
      { type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: { id: "thread", cwd: "/work" } },
      { type: "turn_context", timestamp: "2026-01-01T00:00:01Z", payload: { turn_id: "t", model: "gpt", effort: "high", approval_policy: "never", sandbox_policy: { type: "workspace-write" } } },
    ]) });
    expect(parsed.run).toMatchObject({ model: "gpt", effort: "high", startedAt: Date.parse("2026-01-01T00:00:00Z") });
    expect(parsed.run.context.permissionMode).toBe("approval=never; sandbox=workspace-write");
  });
});
