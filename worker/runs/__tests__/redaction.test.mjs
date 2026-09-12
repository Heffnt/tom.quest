import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { parseClaudeFile } from "../ingest.mjs";
import { openStore } from "../store.mjs";
import { overflowFor } from "../../session-host/overflow.mjs";
import { claudeToolResult, jsonl } from "./fixtures.mjs";

it("redacts before the 32KB cut and retains the checked overflow", () => {
  const token = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
  const result = parseClaudeFile({ path: "/r", host: "laptop", fileVersion: "v", text: jsonl([claudeToolResult({ content: `${token} ${"x".repeat(40_000)}` })]) });
  const row = result.rows.find((entry) => entry.kind === "tool-result");
  const serializedRows = JSON.stringify(result.rows);
  const overflowText = row.overflow.chunks.join("");

  expect(serializedRows).toContain("[redacted:github]");
  expect(serializedRows).not.toContain(token);
  expect(overflowText).toContain("[redacted:github]");
  expect(overflowText).not.toContain(token);
  expect(row.overflow).toMatchObject({ sha256: expect.any(String), byteLength: expect.any(Number), chunkCount: expect.any(Number) });
  expect(row.overflow.byteLength).toBe(Buffer.byteLength(overflowText));
  expect(row.overflow.sha256).toBe(crypto.createHash("sha256").update(overflowText, "utf8").digest("hex"));
  expect(row.overflow.chunkCount).toBe(row.overflow.chunks.length);
  const checkedOverflow = overflowFor(overflowText);
  expect(row.overflow).toEqual({
    sha256: checkedOverflow.sha256,
    byteLength: checkedOverflow.byteLength,
    chunkCount: checkedOverflow.chunkCount,
    chunks: checkedOverflow.chunks,
  });
  expect(row.digest).not.toContain(token);
});

it("redacts named assignments before parser rows and overflow are derived", () => {
  const secret = ["r4Nd0m", "-Secret_Value.1234567890-abcdefghijklmnopqrstuvwxyz"].join("");
  const result = parseClaudeFile({
    path: "/r",
    host: "laptop",
    fileVersion: "v",
    text: jsonl([claudeToolResult({ content: `CLIENT_SECRET=${secret} ${"x".repeat(40_000)}` })]),
  });
  const row = result.rows.find((entry) => entry.kind === "tool-result");
  const allStoredRowFacts = JSON.stringify({ rows: result.rows, overflow: row.overflow, digest: row.digest });

  expect(allStoredRowFacts).toContain("[redacted:secret]");
  expect(allStoredRowFacts).not.toContain(secret);
  expect(row.overflow.chunks.join("")).not.toContain(secret);
  expect(row.digest).not.toContain(secret);
});

it("redacts a named secret through store retrieval before parser overflow", () => {
  const secret = ["r4Nd0m", "-Secret_Value.1234567890-abcdefghijklmnopqrstuvwxyz"].join("");
  const source = jsonl([claudeToolResult({ content: `CLIENT_SECRET=${secret} ${"x".repeat(40_000)}` })]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runs-redaction-pipeline-"));
  const store = openStore({ dir });
  const stored = store.put({ runtime: "claude", threadId: "session", host: "laptop", sourceBytes: Buffer.from(source) });
  const storedBytes = store.get({ runtime: "claude", threadId: "session", host: "laptop", fileVersion: stored.fileVersion });
  const storedText = storedBytes.toString("utf8");
  const result = parseClaudeFile({ path: "/r", host: "laptop", fileVersion: stored.fileVersion, text: storedText });
  const row = result.rows.find((entry) => entry.kind === "tool-result");
  const serializedRows = JSON.stringify(result.rows);
  const overflowText = row.overflow.chunks.join("");

  expect(storedText).toContain("[redacted:secret]");
  expect(storedText).not.toContain(secret);
  expect(fs.readFileSync(path.join(dir, stored.key)).includes(Buffer.from(secret))).toBe(false);
  expect(serializedRows).not.toContain(secret);
  expect(JSON.stringify(result.rows.map((entry) => entry.digest))).not.toContain(secret);
  expect(overflowText).not.toContain(secret);
  expect(row.overflow.byteLength).toBe(Buffer.byteLength(overflowText));
  expect(row.overflow.sha256).toBe(crypto.createHash("sha256").update(overflowText, "utf8").digest("hex"));
  expect(row.overflow.chunkCount).toBe(row.overflow.chunks.length);
  const checkedOverflow = overflowFor(overflowText);
  expect(row.overflow).toEqual({
    sha256: checkedOverflow.sha256,
    byteLength: checkedOverflow.byteLength,
    chunkCount: checkedOverflow.chunkCount,
    chunks: checkedOverflow.chunks,
  });
});
