import { describe, expect, it } from "vitest";
import { codexSkillsOffered, codexSkillsUsed, parseCodexFile } from "../ingest.mjs";
import { codexDeveloper, codexMeta, codexResponseItem, codexSkillsInstructions, codexTaskComplete, codexTokenCount, codexToolCall, codexTurnContext, codexUsageRecord, jsonl } from "./fixtures.mjs";
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
  // witness: every box Codex run on CLI 0.153.3 was refused by the record
  // (285 dead-letter pages by 2026-09-19) because session_meta.context_window
  // is an object naming a window id there, and it reached contextWindow.
  it("reads the context window size off token_count when session_meta names a window id", () => {
    const whole = [
      codexMeta({ contextWindow: { window_id: "w-1" } }),
      codexTurnContext(),
      codexTokenCount({ modelContextWindow: 258_400 }),
      codexResponseItem("message", { role: "assistant", content: [{ output_text: "later" }] }),
    ];
    const result = parse(whole);
    expect(result.run.context.contextWindow).toBe(258_400);
    expect(result.rows.find((row) => row.kind === "context").content.contextWindow).toBe(258_400);
    // A tail with no token_count keeps the size its sweep state carried.
    const tail = parseCodexFile({ path: "/rollout.jsonl", text: jsonl(whole.slice(3)), contextText: jsonl(whole), host: "laptop", fileVersion: "v", baseLine: 3, priorRun: result.run, priorMeta: result.codexMeta });
    expect(tail.run.context.contextWindow).toBe(258_400);
    expect(parse([codexMeta({ contextWindow: { window_id: "w-1" } }), codexTurnContext()]).run.context).not.toHaveProperty("contextWindow");
  });
  it("takes model/effort from turn context and hashes base instructions", () => {
    const result = parse([codexMeta({ baseInstructions: "private base" }), codexTurnContext({ model: "model", effort: "xhigh" })]);
    expect(result.run).toMatchObject({ model: "model", effort: "xhigh" });
    expect(result.rows.find((row) => row.kind === "context").content.model).toBe("model");
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
  it("carries the prior outcome through a second part with no assistant text", () => {
    const first = parseCodexFile({
      path: "/rollout.jsonl",
      host: "laptop",
      fileVersion: "v1",
      text: jsonl([
        codexMeta(),
        codexTurnContext({ model: "gpt-5.6-sol" }),
        codexResponseItem("message", { role: "assistant", content: [{ output_text: "first final answer" }] }),
        codexTokenCount({ input: 7, cachedInput: 0, cacheWrite: 0, output: 3, reasoning: 0, total: 10 }),
      ]),
    });
    const priorRun = {
      ...first.run,
      outcome: { ...first.run.outcome, endedReason: "completed" },
    };
    const second = parseCodexFile({
      path: "/rollout.jsonl",
      host: "laptop",
      fileVersion: "v2",
      baseLine: first.lastLine,
      text: jsonl([codexToolCall({ name: "read_file", args: {} })]),
      priorRun,
      priorMeta: first.codexMeta,
    });
    expect(second.rows.some((row) => row.kind === "assistant-text")).toBe(false);
    expect(second.run.outcome).toMatchObject({
      finalTextSeq: first.run.outcome.finalTextSeq,
      endedReason: "completed",
      totals: first.run.outcome.totals,
      toolCalls: first.run.outcome.toolCalls + 1,
    });
  });
  it("keeps a turn-ID map through incremental sweep tails", () => {
    const first = parseCodexFile({
      path: "/rollout.jsonl",
      host: "laptop",
      fileVersion: "v1",
      text: jsonl([codexMeta(), codexTurnContext({ turnId: "first" })]),
    });
    const repeated = parseCodexFile({
      path: "/rollout.jsonl",
      host: "laptop",
      fileVersion: "v2",
      baseLine: first.lastLine,
      text: jsonl([
        codexTurnContext({ turnId: "first" }),
        codexResponseItem("message", { role: "assistant", content: [{ output_text: "same turn" }] }),
      ]),
      priorRun: first.run,
      priorMeta: first.codexMeta,
    });
    expect(repeated.rows.find((row) => row.kind === "assistant-text").turn).toBe(0);
    expect(repeated.run.outcome.turns).toBe(1);
    const second = parseCodexFile({
      path: "/rollout.jsonl",
      host: "laptop",
      fileVersion: "v3",
      baseLine: repeated.lastLine,
      text: jsonl([
        codexTurnContext({ turnId: "second" }),
        codexResponseItem("message", { role: "assistant", content: [{ output_text: "second turn" }] }),
      ]),
      priorRun: repeated.run,
      priorMeta: repeated.codexMeta,
    });
    expect(second.rows.find((row) => row.kind === "assistant-text").turn).toBe(1);
    expect(second.run.outcome.turns).toBe(2);
    expect(second.codexMeta.turnIds).toEqual(["first", "second"]);
  });
  it("recovers the legacy turn-ID map before parsing its first incremental tail", () => {
    const source = [
      codexMeta(),
      codexTurnContext({ turnId: "first" }),
      codexResponseItem("message", { role: "assistant", content: [{ output_text: "first turn" }] }),
      codexTurnContext({ turnId: "first" }),
      codexResponseItem("message", { role: "assistant", content: [{ output_text: "same first turn" }] }),
      codexTurnContext({ turnId: "second" }),
      codexResponseItem("message", { role: "assistant", content: [{ output_text: "second turn" }] }),
    ];
    const result = parseCodexFile({
      path: "/rollout.jsonl", host: "laptop", fileVersion: "v2",
      baseLine: 3,
      text: jsonl(source.slice(3)),
      contextText: jsonl(source),
    });
    expect(result.rows.filter((row) => row.kind === "assistant-text").map((row) => row.turn)).toEqual([0, 1]);
    expect(result.run.outcome.turns).toBe(2);
    expect(result.codexMeta.turnIds).toEqual(["first", "second"]);
  });
  it("fills a missing turn-ID map in HEAD-shaped prior metadata", () => {
    const prefix = [codexMeta(), codexTurnContext({ turnId: "first" })];
    const first = parseCodexFile({ path: "/rollout.jsonl", host: "laptop", fileVersion: "v1", text: jsonl(prefix) });
    const headMeta = { ...first.codexMeta };
    delete headMeta.turnIds;
    const tail = [
      codexTurnContext({ turnId: "second" }),
      codexResponseItem("message", { role: "assistant", content: [{ output_text: "second turn" }] }),
    ];
    const result = parseCodexFile({
      path: "/rollout.jsonl", host: "laptop", fileVersion: "v2", baseLine: first.lastLine,
      text: jsonl(tail), contextText: jsonl([...prefix, ...tail]), priorRun: first.run,
      priorMeta: headMeta,
    });
    expect(result.rows.find((row) => row.kind === "assistant-text").turn).toBe(1);
    expect(result.run.outcome.turns).toBe(2);
    expect(result.codexMeta).toMatchObject({ id: first.codexMeta.id, git: first.codexMeta.git, turnIds: ["first", "second"] });
  });
  it("makes every post-context sweep split agree with a whole Codex fold", () => {
    const source = [
      codexMeta(),
      codexTurnContext({ turnId: "first", model: "first" }),
      codexTokenCount({ input: 10, cachedInput: 0, cacheWrite: 0, output: 2, total: 12, lastInput: 300_000, responseId: "long-request" }),
      codexUsageRecord({ usage: { input_tokens: 900, output_tokens: 100 } }),
      // The second copy is normal rollout noise.  When the sweep splits
      // between these two lines, it must not emit a second model-change row.
      codexTurnContext({ turnId: "second", model: "second" }),
      codexTurnContext({ turnId: "second", model: "second" }),
      // This is the same request as before the split; cardinality alone would
      // count it again.  The following request must still count separately.
      codexTokenCount({ input: 20, cachedInput: 0, cacheWrite: 0, output: 3, total: 23, lastInput: 300_000, responseId: "long-request" }),
      codexTokenCount({ input: 30, cachedInput: 0, cacheWrite: 0, output: 4, total: 34, lastInput: 300_000, responseId: "another-long-request" }),
      // A nullable token count makes the fold use all usage records instead
      // of the earlier cumulative count, even if it lands in a later tail.
      codexUsageRecord({ usage: { input_tokens: 800, output_tokens: 200 } }),
      { type: "event_msg", timestamp: "2026-01-01T00:00:00Z", payload: { type: "token_count", info: {} } },
      codexResponseItem("message", { role: "assistant", content: [{ output_text: "final answer" }] }),
      codexTaskComplete({ turnId: "second", lastAgentMessage: "final answer" }),
    ];
    const wholeText = jsonl(source);
    const whole = parseCodexFile({ path: "/rollout.jsonl", host: "laptop", fileVersion: "v", text: wholeText });
    expect(whole.rows.filter((row) => row.kind === "error" && /model changed/.test(row.content.error))).toHaveLength(1);
    const withoutFile = (run) => {
      const { file, ...record } = run;
      return record;
    };

    // Every safe source boundary after session metadata and initial context is
    // a sweep boundary candidate.  In particular this covers the assistant /
    // task_complete pair, the duplicated model switch, and repeated response
    // ids on opposite sides of a tail.
    for (let boundary = 2; boundary < source.length; boundary += 1) {
      const prefix = parseCodexFile({
        path: "/rollout.jsonl", host: "laptop", fileVersion: "v",
        text: jsonl(source.slice(0, boundary)),
      });
      const tail = parseCodexFile({
        path: "/rollout.jsonl", host: "laptop", fileVersion: "v",
        baseLine: boundary, text: jsonl(source.slice(boundary)), contextText: wholeText,
        priorRun: prefix.run, priorMeta: prefix.codexMeta,
      });
      expect([...prefix.rows, ...tail.rows], `boundary ${boundary}`).toEqual(whole.rows);
      expect(withoutFile(tail.run), `boundary ${boundary}`).toEqual(withoutFile(whole.run));
      expect(tail.codexMeta, `boundary ${boundary}`).toEqual(whole.codexMeta);
      expect(tail.run.outcome.totals).toMatchObject({ totalTokens: 2_000, longContextRequests: 2 });
    }
  });
  it("uses all accepted usage records after a tail clears total_token_usage", () => {
    const source = [
      codexMeta(),
      codexUsageRecord({ usage: { input_tokens: 5, output_tokens: 1 } }),
      codexTokenCount({ input: 100, cachedInput: 0, cacheWrite: 0, output: 10, reasoning: 0, total: 110 }),
      codexUsageRecord({ usage: { input_tokens: 7, output_tokens: 2 } }),
      { type: "event_msg", timestamp: "2026-01-01T00:00:00Z", payload: { type: "token_count", info: {} } },
    ];
    const wholeText = jsonl(source);
    const whole = parseCodexFile({ path: "/rollout.jsonl", host: "laptop", fileVersion: "v", text: wholeText });
    const prefix = parseCodexFile({ path: "/rollout.jsonl", host: "laptop", fileVersion: "v", text: jsonl(source.slice(0, 3)) });
    const tail = parseCodexFile({
      path: "/rollout.jsonl", host: "laptop", fileVersion: "v", baseLine: 3,
      text: jsonl(source.slice(3)), contextText: wholeText, priorRun: prefix.run, priorMeta: prefix.codexMeta,
    });
    expect(tail.run.outcome.totals).toMatchObject({ inputTokens: 12, outputTokens: 3, totalTokens: 15 });
    expect(tail.run.outcome.totals).toEqual(whole.run.outcome.totals);
    expect(tail.codexMeta).toEqual(whole.codexMeta);
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

// Codex has no skill tool. The catalog is text in the first developer message,
// and a skill counts as used when a tool call went and read its SKILL.md. Both
// halves are parsed out of the rollout, and both are checked here.
describe("Codex skill catalog", () => {
  // The descriptions carry colon-spaces of their own, which is the case the
  // name rule has to survive alongside the namespaced name.
  const SKILLS = [
    { name: "tom-write", description: "Writing to Tom: voice, length, and what a report owes him.", file: "r0/tom-write/SKILL.md" },
    { name: "sites:sites-building", description: "Use Sites to build websites: pages, styling, deploys.", file: "r1/sites-building/SKILL.md" },
  ];
  const catalog = (roots) => codexSkillsInstructions({ roots, skills: SKILLS });
  const ROOTS = { r0: "C:/Users/heffn/.codex/skills", r1: "C:/Users/heffn/.codex/skills/.system" };

  it("reads every offered name, the namespaced one included", () => {
    expect(codexSkillsOffered(catalog(ROOTS)).names).toEqual(["sites:sites-building", "tom-write"]);
  });

  it("expands each short path through the roots table", () => {
    const offered = codexSkillsOffered(catalog(ROOTS));
    expect(offered.paths).toEqual({
      "tom-write": "C:/Users/heffn/.codex/skills/tom-write/SKILL.md",
      "sites:sites-building": "C:/Users/heffn/.codex/skills/.system/sites-building/SKILL.md",
    });
    expect(offered.shortPaths["tom-write"]).toBe("r0/tom-write/SKILL.md");
  });

  it("rebuilds the roots table per rollout, so a reordered r0 still expands", () => {
    // The CLI omits a root with nothing under it, so r0 is whichever directory
    // came first in THAT run: the same short paths, a different meaning.
    const offered = codexSkillsOffered(catalog({ r0: "C:/Users/heffn/.codex/skills/.system", r1: "C:/Users/heffn/.codex/skills" }));
    expect(offered.paths).toEqual({
      "tom-write": "C:/Users/heffn/.codex/skills/.system/tom-write/SKILL.md",
      "sites:sites-building": "C:/Users/heffn/.codex/skills/sites-building/SKILL.md",
    });
  });

  it("rejects an entry whose skill root was not declared", () => {
    const malformed = codexSkillsInstructions({
      roots: ROOTS,
      skills: [...SKILLS, { name: "unbound", description: "bad root", file: "r9/unbound/SKILL.md" }],
    });
    expect(codexSkillsOffered(malformed)).toEqual({
      names: ["sites:sites-building", "tom-write"],
      paths: {
        "tom-write": "C:/Users/heffn/.codex/skills/tom-write/SKILL.md",
        "sites:sites-building": "C:/Users/heffn/.codex/skills/.system/sites-building/SKILL.md",
      },
      shortPaths: {
        "tom-write": "r0/tom-write/SKILL.md",
        "sites:sites-building": "r1/sites-building/SKILL.md",
      },
    });
  });

  it("counts a skill as used only when a tool call read its file", () => {
    const offered = codexSkillsOffered(catalog(ROOTS));
    // A Windows path reaches the arguments as JSON, its separators doubled.
    const read = JSON.stringify({ command: ["bash", "-lc", "cat C:\\Users\\heffn\\.codex\\skills\\tom-write\\SKILL.md"] });
    expect(read).toContain("C:\\\\Users");
    expect(codexSkillsUsed(offered, [read])).toEqual(["tom-write"]);
    expect(codexSkillsUsed(offered, ['{"command":"ls"}'])).toEqual([]);
  });

  it("accepts the short rN form a model may quote instead of expanding", () => {
    const offered = codexSkillsOffered(catalog(ROOTS));
    expect(codexSkillsUsed(offered, ['{"path":"r1/sites-building/SKILL.md"}'])).toEqual(["sites:sites-building"]);
  });

  it("reports a rollout with no catalog as offered nothing, not as an error", () => {
    expect(codexSkillsOffered("just a prompt")).toEqual({ names: [], paths: {}, shortPaths: {} });
    expect(codexSkillsOffered(undefined)).toEqual({ names: [], paths: {}, shortPaths: {} });
    expect(codexSkillsUsed(codexSkillsOffered(""), ["anything"])).toEqual([]);
    const result = parse([codexMeta(), codexTurnContext(), codexDeveloper("TTS-RUN-TOKEN: 11111111-2222-3333-4444-555555555555")]);
    expect(result.run.context.skillsOffered).toEqual([]);
    expect(result.run.context.skillsUsed).toEqual([]);
  });

  it("carries both halves onto a whole rollout's context", () => {
    const result = parse([
      codexMeta(),
      codexTurnContext({ model: "gpt-5.6-terra" }),
      codexDeveloper(`${catalog(ROOTS)}\nTTS-RUN-TOKEN: 11111111-2222-3333-4444-555555555555`),
      codexToolCall({ args: { command: ["bash", "-lc", "cat C:/Users/heffn/.codex/skills/tom-write/SKILL.md"] } }),
      codexResponseItem("message", { role: "assistant", content: [{ output_text: "read it" }] }),
      codexTokenCount({ total: 12 }),
      codexTaskComplete({ lastAgentMessage: "read it" }),
    ]);
    expect(result.run.context.skillsOffered).toEqual(["sites:sites-building", "tom-write"]);
    expect(result.run.context.skillsUsed).toEqual(["tom-write"]);
    const contextRow = result.rows.find((row) => row.kind === "context");
    expect(contextRow.content.skillsUsed).toEqual(["tom-write"]);
    // The catalog is PREPENDED to what codex-run.mjs supplies, so the token
    // line still stands alone at the end of the developer message.
    expect(contextRow.content.prompt).toMatch(/<\/skills_instructions>\nTTS-RUN-TOKEN: /);
  });
});
