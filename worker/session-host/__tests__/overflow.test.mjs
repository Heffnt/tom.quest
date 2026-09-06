// The complete payload behind the 32KB cut (worker/session-host/overflow.mjs).
// What these pin: a cut payload comes back byte-identical under its recorded
// hash; the redaction runs on the WHOLE text and so cannot be defeated by a
// credential lying across a chunk boundary; and a payload Convex refuses ends
// up on disk instead of nowhere.
//
// `lib.mjs` is imported through a mocked `worker-env.mjs`: that module is a
// symlink to ../jobs/worker-env.mjs, which a Windows checkout materializes as
// a plain text file, so the mock is what lets the cut itself (cutWithOverflow)
// be executed here rather than only described.
//
// The one token below is a made-up value of a real shape, assembled at runtime
// from split pieces so no committed LINE spells a whole token.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../worker-env.mjs", () => ({
  ENV_PATH: "/etc/tts/worker.env",
  loadEnv: () => ({}),
}));

import {
  OVERFLOW_CHUNK_BYTES,
  chunkUtf8,
  isPermanentStatus,
  overflowFor,
  overflowPath,
  sendOverflow,
} from "../overflow.mjs";
import { TRUNCATE_LIMIT, cutWithOverflow, truncated } from "../lib.mjs";

const sha256 = (text) =>
  crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** A made-up GitHub token, spelled only at runtime. */
const token = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");

/** A tool result far past the cut, with multibyte characters in it. */
function bigResult(chars = 700_000) {
  // "é" is two UTF-8 bytes, so chunk boundaries land mid-character unless the
  // chunker walks back — which is exactly what the round trip below proves.
  const unit = "line of grep output — é\n";
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

const noSleep = async () => {};
const noBackoff = () => 0;

describe("overflowFor", () => {
  it("reassembles an oversized tool result byte-identical, under its hash", () => {
    const full = bigResult();
    expect(full.length).toBeGreaterThan(TRUNCATE_LIMIT);

    const overflow = overflowFor(full);

    expect(overflow.chunkCount).toBe(
      Math.ceil(Buffer.byteLength(full, "utf8") / OVERFLOW_CHUNK_BYTES),
    );
    expect(overflow.chunks.length).toBe(overflow.chunkCount);
    expect(overflow.chunks.join("")).toBe(full);
    expect(overflow.byteLength).toBe(Buffer.byteLength(full, "utf8"));
    expect(overflow.sha256).toBe(sha256(full));
    // Not one chunk over the cap — the row limit is what makes chunks safe.
    for (const chunk of overflow.chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(
        OVERFLOW_CHUNK_BYTES,
      );
    }
  });

  it("redacts the whole payload, including a token across a chunk boundary", () => {
    // A limit that lands the token's own bytes in two different chunks: if the
    // chunking ran before the redaction, each half would be harmless prose to
    // redactSecrets and the token would be stored intact.
    const limit = 32;
    const full = `x `.repeat(10) + token + ` trailing`;
    const naive = chunkUtf8(full, limit);
    expect(naive.length).toBeGreaterThan(1);
    // Witness that the boundary really does fall inside the token.
    expect(naive.some((c) => c.includes(token))).toBe(false);

    const overflow = overflowFor(full, limit);

    expect(overflow.text).not.toContain(token);
    expect(overflow.text).toContain("[redacted:github]");
    expect(overflow.chunks.join("")).toBe(overflow.text);
    expect(overflow.chunks.join("")).not.toContain(token);
    // The hash describes what was STORED, so a reader can check the bytes
    // they got back against it.
    expect(overflow.sha256).toBe(sha256(overflow.text));
  });
});

describe("chunkUtf8", () => {
  it("never splits a code point", () => {
    // Every character is 4 UTF-8 bytes; a limit of 6 can only fit one per
    // chunk without cutting one in half.
    const full = "😀".repeat(5);
    const chunks = chunkUtf8(full, 6);
    expect(chunks).toEqual(["😀", "😀", "😀", "😀", "😀"]);
    expect(chunks.join("")).toBe(full);
  });

  it("has no chunks for an empty payload", () => {
    expect(chunkUtf8("", 10)).toEqual([]);
  });
});

describe("cutWithOverflow", () => {
  it("stores nothing for a message that fits", () => {
    const cut = cutWithOverflow("a small tool result");
    expect(cut.value).toBe("a small tool result");
    expect(cut.note).toBeUndefined();
    expect(cut.overflow).toBeUndefined();
    // Exactly at the limit is still "fits".
    expect(cutWithOverflow("x".repeat(TRUNCATE_LIMIT)).overflow).toBeUndefined();
  });

  it("cuts the row and keeps the whole payload beside it", () => {
    const full = bigResult();
    const cut = cutWithOverflow(full);
    expect(cut.value).toBe(full.slice(0, TRUNCATE_LIMIT));
    expect(cut.note).toContain("truncated by session-host");
    expect(cut.overflow.chunks.join("")).toBe(full);
    expect(cut.overflow.sha256).toBe(sha256(full));
    // The plain cut is unchanged for callers that want no overflow.
    expect(truncated(full).overflow).toBeUndefined();
  });

  it("keeps the JSON of a non-string payload (a tool input)", () => {
    const input = { command: "grep -r x .", output: "y".repeat(TRUNCATE_LIMIT) };
    const cut = cutWithOverflow(input);
    expect(cut.note).toContain("(JSON)");
    expect(cut.overflow.chunks.join("")).toBe(JSON.stringify(input));
  });
});

describe("sendOverflow", () => {
  function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "tts-overflow-"));
  }

  it("uploads every chunk in order", async () => {
    const root = tmpRoot();
    const posted = [];
    const overflow = overflowFor(bigResult());
    const res = await sendOverflow({
      post: async (body) => posted.push(body),
      sessionId: "sess1",
      seq: 7,
      overflow,
      sessionsRoot: root,
      sleep: noSleep,
      backoffMs: noBackoff,
    });
    expect(res).toEqual({ ok: true, chunkCount: overflow.chunkCount });
    expect(posted.map((p) => p.index)).toEqual(
      overflow.chunks.map((_, i) => i),
    );
    expect(posted.map((p) => p.text).join("")).toBe(overflow.text);
    expect(posted[0]).toMatchObject({
      sessionId: "sess1",
      seq: 7,
      chunkCount: overflow.chunkCount,
      sha256: overflow.sha256,
      byteLength: overflow.byteLength,
    });
    // Nothing on disk when nothing was refused.
    expect(fs.existsSync(path.join(root, "sess1"))).toBe(false);
  });

  it("leaves the payload on disk when the ingest rejects it permanently", async () => {
    const root = tmpRoot();
    const full = `${bigResult(1000)} ${token}`;
    const overflow = overflowFor(full);
    let calls = 0;
    const res = await sendOverflow({
      post: async () => {
        calls += 1;
        const err = new Error("/sessions/overflow -> HTTP 400: too big");
        err.status = 400;
        err.bodyText = "too big";
        throw err;
      },
      sessionId: "sess2",
      seq: 12,
      overflow,
      sessionsRoot: root,
      sleep: noSleep,
      backoffMs: noBackoff,
    });

    expect(calls).toBe(1); // permanent: not retried
    expect(res.ok).toBe(false);
    expect(res.error).toBe("too big");
    const file = overflowPath(root, "sess2", 12);
    expect(res.path).toBe(file);
    const onDisk = fs.readFileSync(file, "utf8");
    // The bytes are there, redacted, and under the hash the row records.
    expect(onDisk).toBe(overflow.text);
    expect(sha256(onDisk)).toBe(overflow.sha256);
    expect(onDisk).not.toContain(token);
  });

  it("retries a transient failure, then gives up to disk", async () => {
    const root = tmpRoot();
    const overflow = overflowFor(bigResult(1000));
    let calls = 0;
    const flaky = await sendOverflow({
      post: async () => {
        calls += 1;
        if (calls < 3) {
          const err = new Error("HTTP 503");
          err.status = 503;
          throw err;
        }
      },
      sessionId: "sess3",
      seq: 1,
      overflow,
      sessionsRoot: root,
      sleep: noSleep,
      backoffMs: noBackoff,
    });
    expect(flaky.ok).toBe(true);
    expect(calls).toBe(3);

    calls = 0;
    const spent = await sendOverflow({
      post: async () => {
        calls += 1;
        const err = new Error("HTTP 503");
        err.status = 503;
        throw err;
      },
      sessionId: "sess4",
      seq: 2,
      overflow,
      sessionsRoot: root,
      sleep: noSleep,
      backoffMs: noBackoff,
      maxAttempts: 4,
    });
    expect(calls).toBe(4);
    expect(spent.ok).toBe(false);
    expect(fs.readFileSync(overflowPath(root, "sess4", 2), "utf8")).toBe(
      overflow.text,
    );
  });
});

describe("isPermanentStatus", () => {
  it("is every 4xx except the two that mean later", () => {
    expect(isPermanentStatus(400)).toBe(true);
    expect(isPermanentStatus(413)).toBe(true);
    expect(isPermanentStatus(408)).toBe(false);
    expect(isPermanentStatus(429)).toBe(false);
    expect(isPermanentStatus(503)).toBe(false);
    expect(isPermanentStatus(undefined)).toBe(false);
  });
});
