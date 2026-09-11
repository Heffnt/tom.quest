import { expect, it } from "vitest";
import { parseClaudeFile } from "../ingest.mjs";
import { claudeToolResult, jsonl } from "./fixtures.mjs";
it("redacts before the 32KB cut and retains the checked overflow", () => {
  const token = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
  const result = parseClaudeFile({ path: "/r", host: "laptop", fileVersion: "v", text: jsonl([claudeToolResult({ content: `${token} ${"x".repeat(40_000)}` })]) });
  const row = result.rows.find((entry) => entry.kind === "tool-result");
  expect(JSON.stringify(row.content)).toContain("[redacted:github]");
  expect(row.overflow).toMatchObject({ sha256: expect.any(String), byteLength: expect.any(Number), chunkCount: expect.any(Number) });
});
