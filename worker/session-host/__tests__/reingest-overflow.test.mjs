// The re-ingest job (worker/session-host/reingest-overflow.mjs): the complete
// payloads the daemon left at /var/cache/tts/sessions/<id>/overflow/<seq> go
// up again, the row is stamped from the file's own hash, and only then is the
// file deleted. What these pin: the order (chunks, stamp, delete — a file is
// never gone before the server has acknowledged the stamp); a file too young
// to be whole is left alone; a file that still cannot be stored stays, named
// with the reason.
//
// `lib.mjs` is imported through a mocked `worker-env.mjs`, as overflow.test.mjs
// explains.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../worker-env.mjs", () => ({
  ENV_PATH: "/etc/tts/worker.env",
  loadEnv: () => ({}),
}));

import { overflowPath, writeOverflowFallback } from "../overflow.mjs";
import {
  MIN_AGE_MS,
  listOverflowFiles,
  reingestOverflow,
} from "../reingest-overflow.mjs";

const sha256 = (text) =>
  crypto.createHash("sha256").update(text, "utf8").digest("hex");

const noSleep = async () => {};
const noBackoff = () => 0;
const quiet = () => {};

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tts-reingest-"));
}

/** A payload file the daemon would have left, aged past MIN_AGE_MS. */
function leave(root, sessionId, seq, text, { ageMs = MIN_AGE_MS * 2 } = {}) {
  const file = writeOverflowFallback(root, sessionId, seq, text);
  const then = new Date(Date.now() - ageMs);
  fs.utimesSync(file, then, then);
  return file;
}

describe("listOverflowFiles", () => {
  it("finds every aged payload file, sessions and seqs in order, and skips the rest", () => {
    const root = tmpRoot();
    leave(root, "sessB", 4, "b4");
    leave(root, "sessA", 12, "a12");
    leave(root, "sessA", 3, "a3");
    leave(root, "sessA", 7, "fresh", { ageMs: 0 }); // still being written
    fs.writeFileSync(path.join(root, "sessA", "overflow", "notes.txt"), "x");
    fs.mkdirSync(path.join(root, "sessC", "ws"), { recursive: true }); // no overflow dir

    const found = listOverflowFiles(root);
    expect(found).toEqual([
      { sessionId: "sessA", seq: 3, file: overflowPath(root, "sessA", 3) },
      { sessionId: "sessA", seq: 12, file: overflowPath(root, "sessA", 12) },
      { sessionId: "sessB", seq: 4, file: overflowPath(root, "sessB", 4) },
    ]);
    expect(listOverflowFiles(path.join(root, "nowhere"))).toEqual([]);
  });
});

describe("reingestOverflow", () => {
  // witness: delete the file before the stamp is acknowledged — a stamp the
  // server refused would leave chunks nobody names and no file to try again.
  it("uploads the chunks, stamps the row, then deletes the file", async () => {
    const root = tmpRoot();
    const text = "line of output — é\n".repeat(30_000); // ~660KB: three chunks
    const file = leave(root, "sess1", 5, text);
    const calls = [];
    const summary = await reingestOverflow({
      sessionsRoot: root,
      post: async (body) => {
        calls.push(["chunk", body.index]);
        expect(fs.existsSync(file)).toBe(true);
      },
      stamp: async (body) => {
        calls.push(["stamp", body]);
        expect(fs.existsSync(file)).toBe(true);
        return { ok: true, stamped: true };
      },
      sleep: noSleep,
      backoffMs: noBackoff,
      log: quiet,
    });

    expect(summary).toEqual({ files: 1, stored: 1, kept: [] });
    expect(calls.at(-1)[0]).toBe("stamp");
    expect(calls.slice(0, -1).map(([, index]) => index)).toEqual([0, 1, 2]);
    expect(calls.at(-1)[1]).toEqual({
      sessionId: "sess1",
      seq: 5,
      sha256: sha256(text),
      byteLength: Buffer.byteLength(text, "utf8"),
      chunkCount: 3,
    });
    // The file is gone, and so is the empty session dir it kept alive.
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(root, "sess1"))).toBe(false);
  });

  it("keeps a file the server still refuses, and says why", async () => {
    const root = tmpRoot();
    const rejected = leave(root, "sess2", 1, "rejected payload");
    const unstamped = leave(root, "sess2", 2, "stamp refused");
    const summary = await reingestOverflow({
      sessionsRoot: root,
      post: async (body) => {
        if (body.seq === 1) {
          const err = new Error("/sessions/overflow -> HTTP 409: chunkCount disagrees with the row's stamp");
          err.status = 409;
          err.bodyText = "chunkCount disagrees with the row's stamp";
          throw err;
        }
      },
      stamp: async () => {
        const err = new Error("/sessions/overflow/stamp -> HTTP 409: no message row");
        err.status = 409;
        throw err;
      },
      sleep: noSleep,
      backoffMs: noBackoff,
      log: quiet,
    });

    expect(summary).toEqual({
      files: 2,
      stored: 0,
      kept: [
        { file: rejected, stage: "chunks", error: "HTTP 409" },
        { file: unstamped, stage: "stamp", error: "HTTP 409" },
      ],
    });
    // Both files untouched — not rewritten under themselves, not deleted.
    expect(fs.readFileSync(rejected, "utf8")).toBe("rejected payload");
    expect(fs.readFileSync(unstamped, "utf8")).toBe("stamp refused");
  });

  it("leaves a live session's workdir alone when its overflow dir empties", async () => {
    const root = tmpRoot();
    const file = leave(root, "sess3", 0, "payload");
    fs.mkdirSync(path.join(root, "sess3", "ws"), { recursive: true });
    await reingestOverflow({
      sessionsRoot: root,
      post: async () => {},
      stamp: async () => ({ ok: true, stamped: true }),
      sleep: noSleep,
      backoffMs: noBackoff,
      log: quiet,
    });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(root, "sess3", "overflow"))).toBe(false);
    expect(fs.existsSync(path.join(root, "sess3", "ws"))).toBe(true);
  });
});
