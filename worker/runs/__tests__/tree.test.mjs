import { expect, it } from "vitest";
import { parseClaudeFile } from "../ingest.mjs";
import { claudeAssistant, claudeTaskResultLaunched, claudeToolUseBlock, jsonl, subagentMeta } from "./fixtures.mjs";
it("links nested Claude children by exact Task tool use", () => {
  const root = parseClaudeFile({ path: "/root", host: "laptop", fileVersion: "r", text: jsonl([claudeAssistant({ blocks: [claudeToolUseBlock({ id: "a", name: "Task" })] }), claudeTaskResultLaunched({ toolUseId: "a", agentId: "A" })]) });
  const child = parseClaudeFile({ path: "/A", host: "laptop", fileVersion: "c", parentSessionId: "session", agentMeta: subagentMeta({ parentAgentId: "A", spawnDepth: 2 }), text: jsonl([]) });
  expect(root.children[0]).toMatchObject({ depth: 1, spawnedByToolUseId: "a", linkKnown: true });
  expect(child.run).toMatchObject({ depth: 2, parentRunId: "claude:laptop:session/A" });
});

it("defaults a missing sidecar depth to one, marks an unknown spawn honestly, and retains stored pointers", () => {
  const storedHash = "a".repeat(64);
  const attachmentHash = "b".repeat(64);
  const child = parseClaudeFile({
    path: "/A", host: "laptop", fileVersion: "c", parentSessionId: "session",
    agentMeta: { ...subagentMeta({ spawnDepth: undefined, toolUseId: "" }), agentId: "A" },
    sidecar: { storedHash },
    attachments: [{ file: "/tool-results/output.txt", bytes: 12, sha256: attachmentHash }],
    text: jsonl([]),
  });
  expect(child.run).toMatchObject({ depth: 1, linkKnown: false, attachments: [{ file: "/tool-results/output.txt", bytes: 12, sha256: attachmentHash }] });
  expect(child.run.file.sidecarStoredHash).toBe(storedHash);
  expect(child.attachments).toEqual(child.run.attachments);
  expect(child.rows.some((row) => row.kind === "error" && /missing spawnDepth/.test(row.content.error))).toBe(true);
});
