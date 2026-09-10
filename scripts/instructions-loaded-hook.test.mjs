import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendLine,
  logLine,
  MAX_LOG_BYTES,
  shouldRollUp,
} from "./instructions-loaded-hook.mjs";

describe("instructions-loaded hook", () => {
  it("records content length and digest without persisting file_content", () => {
    const content = "private instruction";
    const line = logLine({
      hook_event_name: "InstructionsLoaded",
      session_id: "session-1",
      load_reason: "include",
      file_path: "C:\\work\\AGENTS.md",
      file_content: content,
      cwd: "C:\\work",
    }, new Date("2026-09-09T18:04:11.221Z"));

    expect(line).toEqual({
      at: "2026-09-09T18:04:11.221Z",
      session: "session-1",
      reason: "include",
      path: "C:/work/AGENTS.md",
      bytes: Buffer.byteLength(content),
      sha: crypto.createHash("sha256").update(content).digest("hex").slice(0, 8),
      cwd: "C:/work",
    });
    expect(line).not.toHaveProperty("file_content");
  });

  it("ignores non-InstructionsLoaded payloads", () => {
    expect(logLine({ hook_event_name: "SessionStart", file_content: "anything" })).toBeNull();
  });

  it("rotates an oversized log and swallows an unwritable destination", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instructions-loaded-"));
    const logPath = path.join(dir, "instructions-loaded.jsonl");
    fs.writeFileSync(logPath, Buffer.alloc(MAX_LOG_BYTES + 1, "x"));

    appendLine(logPath, { session: "after-rotation" });
    expect(fs.statSync(path.join(dir, "instructions-loaded.1.jsonl")).size).toBe(MAX_LOG_BYTES + 1);
    expect(fs.readFileSync(logPath, "utf8")).toBe('{"session":"after-rotation"}\n');

    const notADirectory = path.join(dir, "not-a-directory");
    fs.writeFileSync(notADirectory, "file");
    expect(() => appendLine(path.join(notADirectory, "log.jsonl"), { session: "ignored" })).not.toThrow();
  });

  it("claims a UTC rollup slot once per day", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instructions-loaded-stamp-"));
    const stamp = path.join(dir, "last-rollup");
    const day = new Date("2026-09-09T23:59:00.000Z");

    expect(shouldRollUp(stamp, day)).toBe(true);
    expect(shouldRollUp(stamp, day)).toBe(false);
    expect(shouldRollUp(stamp, new Date("2026-09-10T00:01:00.000Z"))).toBe(true);
  });
});
