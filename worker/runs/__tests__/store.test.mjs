import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { gzipDeterministic, openStore } from "../store.mjs";

describe("run store", () => {
  it("keeps a redacted immutable version and its rewrite descriptor", () => {
    const store = openStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "runs-store-")) });
    const token = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
    const first = store.put({ runtime: "claude", threadId: "thread", host: "laptop", sourceBytes: Buffer.from(`token ${token}\n`) });
    const second = store.put({ runtime: "claude", threadId: "thread", host: "laptop", sourceBytes: Buffer.from(`token ${token}\n`) });
    expect(second.created).toBe(false);
    expect(second.fileVersion).toBe(first.fileVersion);
    expect(first.key).toMatch(/^runs\/claude\/laptop\/thread\/[a-f0-9]+\.jsonl\.gz$/);
    expect(store.get({ runtime: "claude", threadId: "thread", host: "laptop", fileVersion: first.fileVersion }).toString()).toContain("[redacted:github]");
    const { created: _created, ...descriptor } = first;
    expect(store.head({ runtime: "claude", threadId: "thread", host: "laptop", fileVersion: first.fileVersion })).toEqual(descriptor);
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
});
