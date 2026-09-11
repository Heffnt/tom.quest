import { expect, it } from "vitest";
import { parseClaudeFile } from "../ingest.mjs";
import { claudeUserTurn, jsonl } from "./fixtures.mjs";
it("keeps rows deterministic, incremental, and leaves an unfinished tail unread", () => {
  const sourceRows = Array.from({ length: 16 }, (_, index) => claudeUserTurn({ text: `turn-${index}` }));
  const firstText = jsonl(sourceRows.slice(0, 10));
  const first = parseClaudeFile({ path: "/r", text: firstText, host: "laptop", fileVersion: "v" });
  const again = parseClaudeFile({ path: "/r", text: firstText, host: "laptop", fileVersion: "v" });
  expect(again.rows).toEqual(first.rows);
  expect(first.lastLine).toBe(10);
  const tailRows = sourceRows.slice(10);
  const tail = jsonl(tailRows);
  const grown = parseClaudeFile({ path: "/r", text: tail, host: "laptop", fileVersion: "v2", fromLine: first.lastLine, baseLine: 10 });
  const emitted = grown.rows.filter((row) => row.kind === "user");
  expect(emitted).toHaveLength(6);
  expect(grown.rows.some((row) => row.kind === "context")).toBe(false);
  expect(emitted.map((row) => row.seq)).toEqual([11_000, 12_000, 13_000, 14_000, 15_000, 16_000]);
  expect(emitted.map((row) => row.provenance.lineStart)).toEqual([10, 11, 12, 13, 14, 15]);
  expect(emitted.map((row) => row.content.text)).toEqual(["turn-10", "turn-11", "turn-12", "turn-13", "turn-14", "turn-15"]);
  const retry = parseClaudeFile({ path: "/r", text: tail, host: "laptop", fileVersion: "v2", fromLine: first.lastLine, baseLine: 10 });
  expect(retry).toEqual(grown);
  expect(retry.rows).not.toHaveLength(0);
  expect(retry.rows.map((row) => row.digest)).toEqual(grown.rows.map((row) => row.digest));
  const incomplete = parseClaudeFile({ path: "/r", text: `${firstText}{`, host: "laptop", fileVersion: "v" });
  expect(incomplete).toMatchObject({ incompleteTail: true, lastLine: 10 });
});

it("reads a formerly incomplete final line exactly once after its newline lands", () => {
  const completed = jsonl([claudeUserTurn({ text: "first" })]);
  const finalLine = JSON.stringify(claudeUserTurn({ text: "completed after append" }));
  const partialLength = Math.floor(finalLine.length / 2);
  const initial = parseClaudeFile({ path: "/r", text: `${completed}${finalLine.slice(0, partialLength)}`, host: "laptop", fileVersion: "v" });
  expect(initial).toMatchObject({ incompleteTail: true, lastLine: 1 });
  expect(initial.rows.filter((row) => row.kind === "user")).toHaveLength(1);

  const appended = parseClaudeFile({ path: "/r", text: `${finalLine}\n`, host: "laptop", fileVersion: "v2", fromLine: initial.lastLine });
  const rows = appended.rows.filter((row) => row.kind === "user");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ seq: 2000, provenance: { lineStart: 1 } });
  expect(appended).toMatchObject({ incompleteTail: false, lastLine: 2 });
});

it("uses a source-prefix hash that changes when a committed line is rewritten", () => {
  const original = jsonl([claudeUserTurn({ text: "one" }), claudeUserTurn({ text: "two" })]);
  const rewritten = jsonl([claudeUserTurn({ text: "changed" }), claudeUserTurn({ text: "two" })]);
  const a = parseClaudeFile({ path: "/r", text: original, host: "laptop", fileVersion: "v" });
  const b = parseClaudeFile({ path: "/r", text: rewritten, host: "laptop", fileVersion: "v2" });
  expect(a.run.file.committedPrefixSha256).not.toBe(b.run.file.committedPrefixSha256);
});

it("does not change old row digests when a file grows", () => {
  const first = parseClaudeFile({ path: "/r", text: jsonl([claudeUserTurn({ text: "one" })]), host: "laptop", fileVersion: "v" });
  const grown = parseClaudeFile({ path: "/r", text: jsonl([claudeUserTurn({ text: "one" }), claudeUserTurn({ text: "two" })]), host: "laptop", fileVersion: "v2" });
  expect(grown.rows.find((row) => row.kind === "user").digest).toBe(first.rows.find((row) => row.kind === "user").digest);
});
