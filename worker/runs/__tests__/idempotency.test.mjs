import { expect, it } from "vitest";
import { parseClaudeFile } from "../ingest.mjs";
import { claudeUserTurn, jsonl } from "./fixtures.mjs";
it("keeps rows deterministic, incremental, and leaves an unfinished tail unread", () => {
  const rows = Array.from({ length: 10 }, (_, index) => claudeUserTurn({ text: `turn-${index}` }));
  const text = jsonl(rows);
  const first = parseClaudeFile({ path: "/r", text, host: "laptop", fileVersion: "v" });
  const again = parseClaudeFile({ path: "/r", text, host: "laptop", fileVersion: "v" });
  expect(again.rows).toEqual(first.rows);
  const grown = parseClaudeFile({ path: "/r", text: jsonl([...rows, ...rows.slice(0, 6)]), host: "laptop", fileVersion: "v2", fromLine: first.lastLine });
  expect(grown.rows.every((row) => row.seq >= first.lastLine * 1000)).toBe(true);
  expect(grown.run.startedAt).toBe(first.run.startedAt);
  expect(grown.run.context).toEqual(first.run.context);
  expect(grown.run.outcome.totals.totalTokens).toBe(first.run.outcome.totals.totalTokens);
  const incomplete = parseClaudeFile({ path: "/r", text: `${text}{`, host: "laptop", fileVersion: "v" });
  expect(incomplete).toMatchObject({ incompleteTail: true, lastLine: 10 });
});

it("reads a formerly incomplete final line exactly once after its newline lands", () => {
  const completed = jsonl([claudeUserTurn({ text: "first" })]);
  const finalLine = JSON.stringify(claudeUserTurn({ text: "completed after append" }));
  const partialLength = Math.floor(finalLine.length / 2);
  const initial = parseClaudeFile({ path: "/r", text: `${completed}${finalLine.slice(0, partialLength)}`, host: "laptop", fileVersion: "v" });
  expect(initial).toMatchObject({ incompleteTail: true, lastLine: 1 });
  expect(initial.rows.filter((row) => row.kind === "user")).toHaveLength(1);

  const appended = parseClaudeFile({ path: "/r", text: `${completed}${finalLine}\n`, host: "laptop", fileVersion: "v2", fromLine: initial.lastLine });
  const rows = appended.rows.filter((row) => row.kind === "user");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ seq: 1000, provenance: { lineStart: 1 } });
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
