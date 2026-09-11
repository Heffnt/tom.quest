import { expect, it } from "vitest";
import { parseClaudeFile } from "../ingest.mjs";
import { claudeAssistant, claudeTaskResultLaunched, claudeToolUseBlock, jsonl, subagentMeta } from "./fixtures.mjs";
it("links nested Claude children by exact Task tool use", () => {
  const root = parseClaudeFile({ path: "/root", host: "laptop", fileVersion: "r", text: jsonl([claudeAssistant({ blocks: [claudeToolUseBlock({ id: "a", name: "Task" })] }), claudeTaskResultLaunched({ toolUseId: "a", agentId: "A" })]) });
  const child = parseClaudeFile({ path: "/A", host: "laptop", fileVersion: "c", parentSessionId: "session", agentMeta: subagentMeta({ parentAgentId: "A", spawnDepth: 2 }), text: jsonl([]) });
  expect(root.children[0]).toMatchObject({ depth: 1, spawnedByToolUseId: "a", linkKnown: true });
  expect(child.run).toMatchObject({ depth: 2, parentRunId: "claude:laptop:session/A" });
});
