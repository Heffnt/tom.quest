import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { gzipDeterministic, openStore } from "../store.mjs";

describe("run store", () => {
  it("keeps a redacted immutable version and its rewrite descriptor", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runs-store-"));
    const store = openStore({ dir });
    const token = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
    const first = store.put({ runtime: "claude", threadId: "thread", host: "laptop", sourceBytes: Buffer.from(`token ${token}\n`) });
    const second = store.put({ runtime: "claude", threadId: "thread", host: "laptop", sourceBytes: Buffer.from(`token ${token}\n`) });
    expect(second.created).toBe(false);
    expect(second.fileVersion).toBe(first.fileVersion);
    expect(first.key).toMatch(/^runs\/claude\/laptop\/thread\/[a-f0-9]+\.jsonl\.gz$/);
    const stored = store.get({ runtime: "claude", threadId: "thread", host: "laptop", fileVersion: first.fileVersion }).toString();
    expect(stored).toContain("[redacted:github]");
    expect(stored).not.toContain(token);
    expect(fs.readFileSync(path.join(dir, first.key)).includes(Buffer.from(token))).toBe(false);
    const { created: _created, ...descriptor } = first;
    expect(store.head({ runtime: "claude", threadId: "thread", host: "laptop", fileVersion: first.fileVersion, sourceHash: first.sourceHash })).toEqual(descriptor);
  });

  it("compresses equal bytes identically", () => {
    expect(gzipDeterministic(Buffer.from("same"))).toEqual(gzipDeterministic(Buffer.from("same")));
  });
  it("accepts a Claude child identity as two safe key segments", () => {
    const store = openStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "runs-store-child-")) });
    const stored = store.put({ runtime: "claude", threadId: "session/agent", host: "laptop", sourceBytes: Buffer.from("child\n") });
    expect(stored.key).toMatch(/^runs\/claude\/laptop\/session\/agent\/[a-f0-9]+\.jsonl\.gz$/);
    expect(store.get({ runtime: "claude", threadId: "session/agent", host: "laptop", fileVersion: stored.fileVersion }).toString()).toBe("child\n");
  });

  it("keeps distinct source descriptors for equivalent redacted objects", () => {
    const store = openStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "runs-store-equivalent-")) });
    const firstToken = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
    const secondToken = ["gh", "p_", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"].join("");
    const first = store.put({ runtime: "claude", threadId: "thread", host: "laptop", sourceBytes: Buffer.from(`token=${firstToken}\n`) });
    const second = store.put({ runtime: "claude", threadId: "thread", host: "laptop", sourceBytes: Buffer.from(`token=${secondToken}\n`) });

    expect(first.sourceHash).not.toBe(second.sourceHash);
    expect(first.storedHash).toBe(second.storedHash);
    expect(second.created).toBe(false);
    expect(store.head({ runtime: "claude", threadId: "thread", host: "laptop", fileVersion: first.fileVersion, sourceHash: first.sourceHash })).toEqual(expect.objectContaining({ sourceHash: first.sourceHash }));
    expect(store.head({ runtime: "claude", threadId: "thread", host: "laptop", fileVersion: second.fileVersion, sourceHash: second.sourceHash })).toEqual(expect.objectContaining({ sourceHash: second.sourceHash }));
  });

  it("stores redacted sidecars as distinct immutable objects", () => {
    const store = openStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "runs-store-sidecar-")) });
    const token = ["r4Nd0m", "-Secret_Value.1234567890-abcdefghijklmnopqrstuvwxyz"].join("");
    const sidecar = store.put({
      runtime: "claude",
      threadId: "session/agent",
      host: "laptop",
      kind: "sidecar",
      sourceBytes: Buffer.from(JSON.stringify({ client_secret: token })),
    });

    expect(sidecar.kind).toBe("sidecar");
    expect(sidecar.key).toMatch(/\.sidecar\.json\.gz$/);
    const restored = store.get({ runtime: "claude", threadId: "session/agent", host: "laptop", fileVersion: sidecar.storedHash, kind: "sidecar" }).toString();
    expect(restored).toContain("[redacted:secret]");
    expect(restored).not.toContain(token);
    expect(store.head({ runtime: "claude", threadId: "session/agent", host: "laptop", fileVersion: sidecar.storedHash, sourceHash: sidecar.sourceHash, kind: "sidecar" })).toEqual(expect.objectContaining({ storedHash: sidecar.storedHash, kind: "sidecar" }));
  });
});
