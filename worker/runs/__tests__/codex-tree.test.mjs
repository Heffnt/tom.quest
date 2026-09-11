import { expect, it } from "vitest";
import { parseCodexFile } from "../ingest.mjs";
import { codexMeta, jsonl } from "./fixtures.mjs";
it("links Codex children without inventing a spawning tool call", () => {
  const direct = parseCodexFile({ path: "/c", host: "laptop", fileVersion: "v", text: jsonl([codexMeta({ id: "child", parent: "parent" })]) });
  const objectParent = parseCodexFile({ path: "/c", host: "laptop", fileVersion: "v", text: jsonl([{ ...codexMeta({ id: "child2" }), payload: { id: "child2", parent: { thread_id: "parent" } } }]) });
  expect(direct.run).toMatchObject({ parentRunId: "codex:laptop:parent", rootRunId: "codex:laptop:parent", linkKnown: false });
  expect(objectParent.run.parentRunId).toBe("codex:laptop:parent");
  expect(direct.run.spawnedByToolUseId).toBeUndefined();
});
