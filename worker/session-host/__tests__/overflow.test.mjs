// The complete payload behind the 32KB cut (worker/session-host/overflow.mjs).
// What these pin: a cut payload comes back byte-identical under its recorded
// hash; the redaction runs on the WHOLE text and so cannot be defeated by a
// credential lying across a chunk boundary; a payload Convex refuses ends up
// on disk instead of nowhere; and the ORDER — the finalize row that names the
// bytes is held out of the flush until the last chunk is acknowledged, and
// released unstamped when they never are. session.mjs cannot be loaded here
// (the Agent SDK is installed only on the box), so the hold lives in
// OverflowQueue, which session.mjs drives and these tests drive the same way.
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
  OverflowQueue,
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
    // One shape on the wire: the hash and byte length belong to the row's
    // stamp, written once the chunks are up, not to every chunk.
    expect(posted[0]).toEqual({
      sessionId: "sess1",
      seq: 7,
      index: 0,
      chunkCount: overflow.chunkCount,
      text: overflow.chunks[0],
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
    // The status, never the response body: this string lands in an error
    // row, an event and journald, and a body could carry payload text.
    expect(res.error).toBe("HTTP 400");
    expect(res.error).not.toContain("too big");
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

// The hold: what session.mjs asks the queue on every flush (#takeOutbox →
// readyCount) and what the queue does to the row it was handed (hold →
// stamp on success, release unstamped and report on failure, abandon on
// force-kill). Rows here are the outbox's own objects, seqs assigned.
describe("OverflowQueue (the row waits for its chunks)", () => {
  function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "tts-overflow-queue-"));
  }

  /** A post whose every call waits until the test lets it through. */
  function gatedPost() {
    const posted = [];
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    return {
      posted,
      release,
      post: async (body) => {
        await gate;
        posted.push(body);
      },
    };
  }

  function queueFor(root, post, hooks = {}) {
    const stored = [];
    const unstored = [];
    const queue = new OverflowQueue({
      post,
      sessionId: "sessQ",
      sessionsRoot: root,
      sleep: noSleep,
      backoffMs: noBackoff,
      onStored: (row) => stored.push(row),
      onUnstored: (failure) => unstored.push(failure),
      ...hooks,
    });
    return { queue, stored, unstored };
  }

  // witness: push the row to the flush as soon as it is finalized (the
  // stamp riding along) — the row would reach Convex naming chunks that are
  // not there yet, and if they never arrive the stamp would be a lie.
  it("holds the row, and every row after it, until the last chunk is acknowledged", async () => {
    const root = tmpRoot();
    const { posted, release, post } = gatedPost();
    const { queue, stored } = queueFor(root, post);
    const overflow = overflowFor(bigResult(), 100_000);
    expect(overflow.chunkCount).toBeGreaterThan(1);

    // The outbox as session.mjs keeps it: the cut row, then a later row.
    const cut = { seq: 5, kind: "tool-result", content: { content: "cut…" } };
    const later = { seq: 6, kind: "assistant-text", content: { text: "ok" } };
    const outbox = [cut, later];
    queue.hold(cut, overflow);

    // A flush now takes nothing: not the held row, not the one behind it
    // (seq order — the server's floor would drop 5 if 6 landed first).
    expect(queue.readyCount(outbox)).toBe(0);
    expect(queue.idle).toBe(false);
    expect(cut.overflow).toBeUndefined();
    await Promise.resolve();
    expect(queue.readyCount(outbox)).toBe(0);

    release();
    await queue.settled;

    // Every chunk went, in order, and only then was the row stamped and
    // released — remove the pump and this is where it fails.
    expect(posted.map((p) => p.index)).toEqual(
      overflow.chunks.map((_, i) => i),
    );
    expect(cut.overflow).toEqual({
      sha256: overflow.sha256,
      byteLength: overflow.byteLength,
      chunkCount: overflow.chunkCount,
    });
    expect(queue.readyCount(outbox)).toBe(2);
    expect(queue.idle).toBe(true);
    expect(stored).toEqual([cut]);
    expect(fs.existsSync(path.join(root, "sessQ"))).toBe(false);
  });

  it("releases the rows ahead of a held one, and rows behind it stay", () => {
    const { queue } = queueFor(tmpRoot(), gatedPost().post);
    const rows = [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }];
    queue.hold(rows[2], overflowFor(bigResult(1000)));
    expect(queue.readyCount(rows)).toBe(2);
    expect(queue.readyCount(rows.slice(2))).toBe(0);
    expect(queue.readyCount([])).toBe(0);
  });

  // witness: leave the stamp on a row whose upload failed — a reader would
  // find a hole under a hash that promises otherwise, forever.
  it("releases an unstored row WITHOUT a stamp and reports the loss with the file", async () => {
    const root = tmpRoot();
    const { queue, stored, unstored } = queueFor(root, async () => {
      const err = new Error("/sessions/overflow -> HTTP 400: too big");
      err.status = 400;
      err.bodyText = "too big";
      throw err;
    });
    const overflow = overflowFor(bigResult(1000));
    const cut = { seq: 9, kind: "thinking", content: { text: "cut…" } };
    const outbox = [cut];
    queue.hold(cut, overflow);
    expect(queue.readyCount(outbox)).toBe(0);

    await queue.settled;

    expect(cut.overflow).toBeUndefined();
    expect(queue.readyCount(outbox)).toBe(1);
    expect(stored).toEqual([]);
    const file = overflowPath(root, "sessQ", 9);
    expect(unstored).toEqual([
      { seq: 9, byteLength: overflow.byteLength, error: "HTTP 400", path: file },
    ]);
    expect(fs.readFileSync(file, "utf8")).toBe(overflow.text);
    expect(queue.idle).toBe(true);
  });

  // witness: drop the queue at force-kill with a log line — the bytes would
  // be on disk with no error row, no event and no file named anywhere the
  // server can see (the finding this pins).
  it("abandon() at force-kill keeps every unstored payload on disk and reports each", async () => {
    const root = tmpRoot();
    const { posted, release, post } = gatedPost();
    const { queue, stored, unstored } = queueFor(root, post);
    const first = overflowFor(bigResult(1000));
    const second = overflowFor(bigResult(2000));
    const rowA = { seq: 3, kind: "tool-result", content: {} };
    const rowB = { seq: 4, kind: "tool-result", content: {} };
    const outbox = [rowA, rowB];
    queue.hold(rowA, first); // in flight, waiting on the gate
    queue.hold(rowB, second); // queued behind it
    expect(queue.readyCount(outbox)).toBe(0);

    queue.abandon("unstored at force-kill");

    // Both released unstamped for the final flush, both on disk, both
    // reported — the in-flight one included.
    expect(queue.readyCount(outbox)).toBe(2);
    expect(queue.idle).toBe(true);
    expect(rowA.overflow).toBeUndefined();
    expect(rowB.overflow).toBeUndefined();
    expect(unstored).toEqual([
      {
        seq: 3,
        byteLength: first.byteLength,
        error: "unstored at force-kill",
        path: overflowPath(root, "sessQ", 3),
      },
      {
        seq: 4,
        byteLength: second.byteLength,
        error: "unstored at force-kill",
        path: overflowPath(root, "sessQ", 4),
      },
    ]);
    expect(fs.readFileSync(overflowPath(root, "sessQ", 3), "utf8")).toBe(first.text);
    expect(fs.readFileSync(overflowPath(root, "sessQ", 4), "utf8")).toBe(second.text);

    // The upload that was in flight completes late: it must not stamp a row
    // that already went up unstamped, nor call anything stored.
    release();
    await queue.settled;
    expect(rowA.overflow).toBeUndefined();
    expect(stored).toEqual([]);
    expect(posted.length).toBeLessThanOrEqual(1);
  });
});
