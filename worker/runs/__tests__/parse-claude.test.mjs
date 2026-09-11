import { describe, expect, it } from "vitest";
import { parseClaudeFile } from "../ingest.mjs";
import { claudeAssistant, claudeAttachment, claudeSystem, claudeTextBlock, claudeThinkingBlock, claudeToolResult, claudeToolUseBlock, claudeUnknown, claudeUserText, claudeUserTurn, jsonl, persistedOutput } from "./fixtures.mjs";
const parse = (rows) => parseClaudeFile({ path: "/run.jsonl", text: jsonl(rows), host: "laptop", fileVersion: "v" });
describe("Claude parser", () => {
  it.each([
    ["string user", claudeUserTurn(), "user"],
    ["text-block user", claudeUserText(), "user"],
    ["thinking", claudeAssistant({ blocks: [claudeThinkingBlock()] }), "thinking"],
    ["assistant text", claudeAssistant({ blocks: [claudeTextBlock()] }), "assistant-text"],
    ["api error", claudeSystem({ subtype: "api_error", error: "bad" }), "error"],
    ["compact boundary", claudeSystem({ subtype: "compact_boundary" }), "system"],
    ["other system", claudeSystem({ subtype: "new-system" }), "system"],
    ["file attachment", claudeAttachment("file", { content: "file" }), "system"],
    ["unknown attachment", claudeAttachment("new-attachment"), "system"],
  ])("maps %s to a visible %s row", (_name, source, kind) => {
    expect(parse([source]).rows.some((row) => row.kind === kind)).toBe(true);
  });
  it.each([
    ["queue-operation", { type: "queue-operation" }], ["last-prompt", { type: "last-prompt" }],
    ["custom-title", { type: "custom-title" }], ["atis-latch", { type: "atis-latch" }],
    ["bridge-session", { type: "bridge-session" }], ["file-history-snapshot", { type: "file-history-snapshot" }],
    ["file-history-delta", { type: "file-history-delta" }],
  ])("accounts for dropped %s", (type, source) => {
    const result = parse([{ sessionId: "session", timestamp: "2026-01-01T00:00:00Z", ...source }]);
    expect(result.dropped[type]).toBe(1);
  });
  it.each(["total_tokens_reminder", "batching_reminder_sent", "silent_turn_reminder", "remote_session_change"])("accounts for dropped %s attachment", (type) => {
    expect(parse([claudeAttachment(type)]).dropped[`attachment/${type}`]).toBe(1);
  });
  it("maps blocks with line-derived seqs and parent tool links", () => {
    const result = parse([claudeAssistant({ blocks: [claudeThinkingBlock(), claudeTextBlock(), claudeToolUseBlock({ id: "x" })] }), claudeToolResult({ toolUseId: "x" })]);
    expect(result.rows.filter((row) => row.kind !== "context").map((row) => row.seq)).toEqual([1, 2, 3, 1000]);
    expect(result.rows.map((row) => row.seq)).toEqual([0, 1, 2, 3, 1000]);
    expect(result.rows.find((row) => row.kind === "tool-result").parentToolUseId).toBe("x");
  });
  it("keeps new types visible and malformed lines recoverable", () => {
    const unknown = parse([claudeUnknown("future")]);
    expect(unknown.rows.some((row) => row.kind === "system" && row.content.unknownLineType === "future")).toBe(true);
    const malformed = parseClaudeFile({ path: "/x", text: "not-json\n", host: "laptop", fileVersion: "v" });
    expect(malformed.rows.some((row) => row.kind === "error")).toBe(true);
  });
  it("reports a model switch and persisted-output pointer", () => {
    const result = parse([claudeAssistant({ model: "a" }), claudeAssistant({ model: "b" }), claudeAssistant({ model: "b" }), claudeToolResult({ content: persistedOutput({ path: "/saved" }) })]);
    expect(result.run.model).toBe("a");
    expect(result.rows.filter((row) => row.kind === "error" && /model changed/.test(row.content.error))).toHaveLength(1);
    expect(result.rows.find((row) => row.kind === "tool-result").content.persistedOutput.path).toBe("/saved");
  });
  it("extracts the real attachment and stop-hook shapes", () => {
    const result = parse([
      claudeAttachment("instructions", { files: [{ content: "instructions" }] }), claudeAttachment("session_context", { context: "session context" }),
      claudeAttachment("deferred_tools_record", { entries: [{ name: "Bash" }] }), claudeAttachment("deferred_tools_delta", { addedNames: ["Read"], readdedNames: ["Write"] }),
      claudeAttachment("agent_listing_delta", { addedTypes: ["worker"] }), claudeAttachment("mcp_instructions_delta", { addedNames: ["server"] }),
      claudeAttachment("skill_listing", { names: ["skill"] }), claudeAttachment("invoked_skills", { skills: [{ name: "used" }] }),
      claudeSystem({ subtype: "stop_hook_summary", hookInfos: [{ command: "hook" }] }), claudeUserTurn({ text: "prompt" }),
    ]);
    expect(result.run.context).toMatchObject({ tools: ["Bash", "Read", "Write", "server", "worker"], skillsOffered: ["skill"], skillsUsed: ["used"], hooks: ["hook"] });
    expect(result.rows.find((row) => row.kind === "context").content.prompt).toMatch(/instructions[\s\S]*session context[\s\S]*prompt/);
    expect(result.dropped).toMatchObject({
      "attachment/instructions": 1,
      "attachment/session_context": 1,
      "attachment/deferred_tools_record": 1,
      "attachment/deferred_tools_delta": 1,
      "attachment/agent_listing_delta": 1,
      "attachment/mcp_instructions_delta": 1,
      "attachment/skill_listing": 1,
      "attachment/invoked_skills": 1,
      "system/stop_hook_summary": 1,
    });
  });
});
