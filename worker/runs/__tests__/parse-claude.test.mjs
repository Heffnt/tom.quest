import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { MODEL_OF_TOM_HEADER as CONVEX_MODEL_OF_TOM_HEADER } from "../../../convex/ttsShared.ts";
import { MODEL_OF_TOM_HEADER as WORKER_MODEL_OF_TOM_HEADER, PARSER_VERSION, modelOfTomFromPrompt, parseClaudeFile } from "../ingest.mjs";
import { claudeAssistant, claudeAttachment, claudeLine, claudeSystem, claudeTaskResultLaunched, claudeTextBlock, claudeThinkingBlock, claudeToolResult, claudeToolUseBlock, claudeUnknown, claudeUserText, claudeUserTurn, jsonl, persistedOutput } from "./fixtures.mjs";
const parse = (rows) => parseClaudeFile({ path: "/run.jsonl", text: jsonl(rows), host: "laptop", fileVersion: "v" });

const CONTEXT_ATTACHMENT_TYPES = [
  "environment", "instructions", "session_context", "model", "date", "prompt_snapshot", "auto_mode",
  "command_permissions", "skill_listing", "invoked_skills", "deferred_tools_record", "deferred_tools_delta",
  "agent_listing_delta", "mcp_instructions_delta",
];
const HOOK_ATTACHMENT_TYPES = ["hook_additional_context", "hook_success", "hook_non_blocking_error"];
const VISIBLE_ATTACHMENT_TYPES = ["file", "edited_text_file", "queued_command"];
const DROPPED_ATTACHMENT_TYPES = ["total_tokens_reminder", "batching_reminder_sent", "silent_turn_reminder", "remote_session_change"];
const DROPPED_BOOKKEEPING_TYPES = ["queue-operation", "last-prompt", "custom-title", "atis-latch", "bridge-session", "file-history-snapshot", "file-history-delta"];
describe("Claude parser", () => {
  it.each([
    ["string user", claudeUserTurn(), "user"],
    ["text-block user", claudeUserText(), "user"],
    ["thinking", claudeAssistant({ blocks: [claudeThinkingBlock()] }), "thinking"],
    ["assistant text", claudeAssistant({ blocks: [claudeTextBlock()] }), "assistant-text"],
    ["api error", claudeSystem({ subtype: "api_error", error: "bad" }), "error"],
    ["compact boundary", claudeSystem({ subtype: "compact_boundary" }), "system"],
    ["other system", claudeSystem({ subtype: "new-system" }), "system"],
    ["unknown attachment", claudeAttachment("new-attachment"), "system"],
  ])("maps %s to a visible %s row", (_name, source, kind) => {
    expect(parse([source]).rows.some((row) => row.kind === kind)).toBe(true);
  });
  it.each(DROPPED_BOOKKEEPING_TYPES)("accounts for dropped bookkeeping %s", (type) => {
    const source = { type };
    const result = parse([{ sessionId: "session", timestamp: "2026-01-01T00:00:00Z", ...source }]);
    expect(result.dropped[type]).toBe(1);
  });
  it.each(DROPPED_ATTACHMENT_TYPES)("accounts for dropped %s attachment", (type) => {
    expect(parse([claudeAttachment(type)]).dropped[`attachment/${type}`]).toBe(1);
  });
  it.each(CONTEXT_ATTACHMENT_TYPES)("folds context attachment %s into the context entry", (type) => {
    const result = parse([claudeAttachment(type)]);
    expect(result.rows.filter((row) => row.kind !== "context")).toHaveLength(0);
    expect(result.dropped[`attachment/${type}`]).toBe(1);
  });
  it.each(HOOK_ATTACHMENT_TYPES)("folds hook attachment %s into context hooks", (type) => {
    const result = parse([claudeAttachment(type, {}, { hookName: "hook" })]);
    expect(result.rows.filter((row) => row.kind !== "context")).toHaveLength(0);
    expect(result.run.context.hooks).toEqual(["hook"]);
    expect(result.dropped[`attachment/${type}`]).toBe(1);
  });
  it.each(VISIBLE_ATTACHMENT_TYPES)("keeps visible attachment %s as a system row", (type) => {
    const result = parse([claudeAttachment(type, { content: "visible" })]);
    expect(result.rows.some((row) => row.kind === "system" && row.content.attachment.type === type)).toBe(true);
  });
  it("maps blocks with line-derived seqs and parent tool links", () => {
    const result = parse([claudeAssistant({ blocks: [claudeThinkingBlock(), claudeTextBlock(), claudeToolUseBlock({ id: "x" })] }), claudeToolResult({ toolUseId: "x" })]);
    expect(result.rows.filter((row) => row.kind !== "context").map((row) => row.seq)).toEqual([1000, 1001, 1002, 2000]);
    expect(result.rows.map((row) => row.seq)).toEqual([0, 1000, 1001, 1002, 2000]);
    expect(result.rows.find((row) => row.kind === "tool-result").parentToolUseId).toBe("x");
  });
  it.each([
    ["meta user", claudeLine({ isMeta: true, message: { content: "meta" } })],
    ["compact user", claudeLine({ isCompactSummary: true, message: { content: "compact" } })],
  ])("maps %s to a system row", (_name, source) => {
    expect(parse([source]).rows.some((row) => row.kind === "system")).toBe(true);
  });
  it("maps Task tool use and result to tool, result, and child-run rows", () => {
    const result = parse([
      claudeAssistant({ blocks: [claudeToolUseBlock({ id: "task", name: "Task", input: { description: "work" } })] }),
      claudeTaskResultLaunched({ toolUseId: "task", agentId: "agent" }),
    ]);
    expect(result.rows.map((row) => row.kind)).toEqual(["context", "tool-call", "tool-result", "child-run"]);
    expect(result.children).toMatchObject([{ spawnedByToolUseId: "task", linkKnown: true }]);
  });
  it("keeps unrecognised assistant blocks visible", () => {
    const result = parse([claudeAssistant({ blocks: [{ type: "future-block", value: "future" }] })]);
    expect(result.rows.some((row) => row.kind === "system" && row.content.unknownAssistantBlock.type === "future-block")).toBe(true);
  });
  it("folds assistant usage into totals without a transcript row", () => {
    const result = parse([claudeAssistant({ usage: { input_tokens: 3, output_tokens: 4 } })]);
    expect(result.rows.filter((row) => row.kind !== "context")).toHaveLength(0);
    expect(result.run.outcome.totals).toMatchObject({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
  });
  it("folds a stop-hook summary into context hooks without a transcript row", () => {
    const result = parse([claudeSystem({ subtype: "stop_hook_summary", hookInfos: [{ command: "stop-hook" }] })]);
    expect(result.rows.filter((row) => row.kind !== "context")).toHaveLength(0);
    expect(result.run.context.hooks).toEqual(["stop-hook"]);
    expect(result.dropped["system/stop_hook_summary"]).toBe(1);
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
    expect(result.rows.find((row) => row.kind === "context").content.model).toBe("a");
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
      claudeAssistant({ blocks: [claudeToolUseBlock({ id: "only-call", name: "OnlyAssistantTool" })] }),
    ]);
    expect(result.run.context).toMatchObject({ tools: ["Bash", "OnlyAssistantTool", "Read", "Write", "server", "worker"], skillsOffered: ["skill"], skillsUsed: ["used"], hooks: ["hook"] });
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

  it("keeps structured context while only a long prompt moves to overflow", () => {
    const result = parse([
      claudeAttachment("deferred_tools_record", { entries: [{ name: "Bash" }] }),
      claudeUserTurn({ text: "p".repeat(40_000) }),
    ]);
    const context = result.rows.find((row) => row.kind === "context");
    expect(context.content.tools).toEqual(["Bash"]);
    expect(context.content.prompt).toHaveLength(32 * 1024);
    expect(context.content.promptTruncation).toMatch(/truncated/);
    expect(context.overflow).toMatchObject({ sha256: expect.any(String), chunkCount: expect.any(Number) });
    expect(JSON.parse(context.overflow.chunks.join("")).tools).toEqual(["Bash"]);
  });

  it("uses the shared model-of-tom header spelling and parses its committed layers", () => {
    expect(WORKER_MODEL_OF_TOM_HEADER).toBe(CONVEX_MODEL_OF_TOM_HEADER);
    expect(modelOfTomFromPrompt(`${CONVEX_MODEL_OF_TOM_HEADER} (WikiTom commit abcdef1): operate, write`)).toEqual({
      wikitomCommit: "abcdef1", layersKnown: true, layersGiven: ["operate", "write"], layersDenied: ["know"],
    });
  });

  it("takes usage only from the final line of each Claude request and preserves cache durations", () => {
    const usage = (input, five, hour, output) => ({
      input_tokens: input, cache_read_input_tokens: 2, cache_creation_input_tokens: five + hour, output_tokens: output,
      cache_creation: { ephemeral_5m_input_tokens: five, ephemeral_1h_input_tokens: hour },
      output_tokens_details: { thinking_tokens: 1 },
    });
    const result = parse([
      claudeAssistant({ model: "claude-sonnet-5", requestId: "same", usage: usage(1, 2, 3, 4) }),
      claudeAssistant({ model: "claude-sonnet-5", requestId: "same", usage: usage(10, 20, 30, 40) }),
    ]);
    expect(result.run.outcome.totals).toMatchObject({ inputTokens: 10, cacheWriteTokens: 50, cacheWrite5mTokens: 20, cacheWrite1hTokens: 30, cacheWriteBreakdownKnown: true, outputTokens: 40 });
  });

  it("does not assign a cost to a legacy cache-write total with no duration", () => {
    const result = parse([claudeAssistant({
      model: "claude-fable-5-1",
      usage: { input_tokens: 1, cache_creation_input_tokens: 2, output_tokens: 3 },
    })]);
    expect(result.run.outcome.totals).toMatchObject({ cacheWrite5mTokens: 2, cacheWrite1hTokens: 0, cacheWriteTokens: 2, cacheWriteBreakdownKnown: false });
    expect(result.run.outcome.costUsd).toBeUndefined();
  });

  it("hashes normalized JSON so the digest survives an HTTP JSON round trip", () => {
    const result = parse([claudeUserTurn({ text: "round-trip" })]);
    const row = result.rows.find((entry) => entry.kind === "user");
    const stable = (value) => Array.isArray(value)
      ? `[${value.map(stable).join(",")}]`
      : value && typeof value === "object"
        ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
        : JSON.stringify(value);
    const content = JSON.parse(JSON.stringify(row.content));
    const digest = createHash("sha256").update(`${PARSER_VERSION}\n${result.run.runId}\n${row.seq}\n${row.kind}\n${stable(content)}`).digest("hex").slice(0, 16);
    expect(digest).toBe(row.digest);
  });
});
