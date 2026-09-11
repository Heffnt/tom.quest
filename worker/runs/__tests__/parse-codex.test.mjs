import { describe, expect, it } from "vitest";
import { parseCodexFile } from "../ingest.mjs";
import { codexMeta, codexResponseItem, codexTaskComplete, codexTokenCount, codexTurnContext, codexUsageRecord, jsonl } from "./fixtures.mjs";
const parse = (rows) => parseCodexFile({ path: "/rollout.jsonl", text: jsonl(rows), host: "laptop", fileVersion: "v" });
describe("Codex parser", () => {
  it.each([
    ["reasoning", codexResponseItem("reasoning", { summary: ["summary"] }), "thinking"],
    ["function call", codexResponseItem("function_call", { name: "tool", arguments: "{}" }), "tool-call"],
    ["function output", codexResponseItem("function_call_output", { call_id: "call", output: "out" }), "tool-result"],
    ["custom call", codexResponseItem("custom_tool_call", { name: "tool", input: "{}" }), "tool-call"],
    ["custom output", codexResponseItem("custom_tool_call_output", { call_id: "call", output: "out" }), "tool-result"],
    ["unknown response", codexResponseItem("future"), "system"],
  ])("maps response_item %s", (_name, row, kind) => {
    expect(parse([codexMeta(), row]).rows.some((entry) => entry.kind === kind)).toBe(true);
  });
  it.each([
    ["task_started", { type: "task_started" }], ["item_completed", { type: "item_completed" }],
    ["unknown event", { type: "future-event" }],
  ])("accounts for event_msg %s", (_name, payload) => {
    const result = parse([codexMeta(), { type: "event_msg", payload, timestamp: "2026-01-01T00:00:00Z" }]);
    if (payload.type === "future-event") expect(result.rows.some((entry) => entry.kind === "system")).toBe(true);
    else expect(result.rows.filter((entry) => entry.kind !== "context")).toHaveLength(0);
  });
  it("takes model/effort from turn context and hashes base instructions", () => {
    const result = parse([codexMeta({ baseInstructions: "private base" }), codexTurnContext({ model: "model", effort: "xhigh" })]);
    expect(result.run).toMatchObject({ model: "model", effort: "xhigh" });
    expect(result.run.context.baseInstructionsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("private base");
  });
  it("uses the last cumulative count or usage-record fallback", () => {
    expect(parse([codexMeta(), codexTokenCount({ total: 20 }), codexTokenCount({ total: 30 })]).run.outcome.totals.totalTokens).toBe(30);
    expect(parse([codexMeta(), codexUsageRecord({ usage: { input_tokens: 2, output_tokens: 3 } })]).run.outcome.totals.totalTokens).toBe(5);
  });
  it("records per-request long-context evidence without adding duplicate totals", () => {
    const result = parse([
      codexMeta(), codexTurnContext({ model: "gpt-5.6-sol" }),
      codexTokenCount({ input: 10, cachedInput: 0, cacheWrite: 0, output: 2, total: 12, lastInput: 300_000, responseId: "request-1" }),
      codexTokenCount({ input: 10, cachedInput: 0, cacheWrite: 0, output: 2, total: 12, lastInput: 300_000, responseId: "request-1" }),
    ]);
    expect(result.run.outcome.totals).toMatchObject({ inputTokens: 10, totalTokens: 12, longContextRequests: 1 });
    expect(result.run.outcome.costUsd).toBeUndefined();
  });
  it("does not duplicate a completed last assistant message", () => {
    const result = parse([codexMeta(), codexResponseItem("message", { role: "assistant", content: [{ output_text: "done" }] }), codexTaskComplete({ lastAgentMessage: "done" })]);
    expect(result.rows.filter((row) => row.kind === "assistant-text")).toHaveLength(1);
  });
  it("reports a repeated model switch only once", () => {
    const result = parse([codexMeta(), codexTurnContext({ model: "first" }), codexTurnContext({ model: "second" }), codexTurnContext({ model: "second" })]);
    expect(result.rows.filter((row) => row.kind === "error" && /model changed/.test(row.content.error))).toHaveLength(1);
  });
  it("uses an absolute base line when parsing an incremental tail", () => {
    const sourceRows = Array.from({ length: 16 }, (_, index) => codexResponseItem("message", { role: "assistant", content: [{ output_text: `turn-${index}` }] }));
    const first = parseCodexFile({ path: "/rollout.jsonl", host: "laptop", fileVersion: "v", text: jsonl(sourceRows.slice(0, 10)) });
    const result = parseCodexFile({
      path: "/rollout.jsonl", host: "laptop", fileVersion: "v2", fromLine: first.lastLine, baseLine: 10,
      text: jsonl(sourceRows.slice(10)),
    });
    expect(first.lastLine).toBe(10);
    expect(result.rows).toHaveLength(6);
    expect(result.rows.map((row) => row.seq)).toEqual([11_000, 12_000, 13_000, 14_000, 15_000, 16_000]);
    expect(result.rows.map((row) => row.provenance.lineStart)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(result.rows.map((row) => row.content.text)).toEqual(["turn-10", "turn-11", "turn-12", "turn-13", "turn-14", "turn-15"]);
    expect(result.rows.some((row) => row.kind === "context")).toBe(false);
    expect(result.lastLine).toBe(16);
  });
  it("accounts for every zero-row state line while task_complete stays emitted", () => {
    const result = parse([
      codexMeta(),
      codexTurnContext(),
      codexResponseItem("message", { role: "developer", content: [{ input_text: "context" }] }),
      codexTokenCount(),
      { type: "event_msg", timestamp: "2026-01-01T00:00:00Z", payload: { type: "task_started" } },
      { type: "event_msg", timestamp: "2026-01-01T00:00:00Z", payload: { type: "item_completed" } },
      codexUsageRecord(),
      { type: "world_state", timestamp: "2026-01-01T00:00:00Z", payload: {} },
      codexTaskComplete({ lastAgentMessage: "final" }),
    ]);
    expect(result.dropped).toMatchObject({
      "session_meta/unknown": 1,
      "turn_context/unknown": 1,
      "response_item/message": 1,
      "event_msg/token_count": 1,
      "event_msg/task_started": 1,
      "event_msg/item_completed": 1,
      "token_usage_record/unknown": 1,
      "world_state/unknown": 1,
    });
    expect(result.rows.filter((row) => row.provenance.sourceKind === "event_msg/task_complete")).toHaveLength(1);
  });
  it("drops superseded task_complete lines and emits only the pending final one", () => {
    const result = parse([codexMeta(), codexTaskComplete({ lastAgentMessage: "first" }), codexTaskComplete({ lastAgentMessage: "second" })]);
    expect(result.dropped["event_msg/task_complete"]).toBe(1);
    const final = result.rows.filter((row) => row.provenance.sourceKind === "event_msg/task_complete");
    expect(final).toHaveLength(1);
    expect(final[0].content.text).toBe("second");
  });
});
