import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { claudeLine, claudeToolResult, claudeUserTurn, jsonl } from "./fixtures.mjs";
import { writeRegistrationClaim, writeRegistrationEnd } from "../registration.mjs";
import {
  MAX_ATTEMPTS,
  acquireSweepLock,
  deletable,
  drainQueue,
  stateFileFor,
  sweepRunFile,
  sweepRuns,
} from "../sweep.mjs";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "runs-sweep-"));
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function store() {
  return {
    put: vi.fn(({ sourceBytes, kind = "run" }) => {
      const bytes = Buffer.from(sourceBytes);
      const digest = hash(bytes);
      return {
        fileVersion: digest,
        sourceHash: digest,
        storedHash: digest,
        bytes: bytes.length,
        storedBytes: bytes.length,
        key: `runs/${kind}/${digest}`,
        verified: true,
        created: true,
      };
    }),
  };
}

function runFile(dir, rows = [claudeUserTurn({ text: "hello" })]) {
  const project = path.join(dir, "claude", "project");
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, "session.jsonl");
  fs.writeFileSync(file, jsonl(rows));
  const stat = fs.statSync(file);
  return {
    runtime: "claude",
    host: "laptop",
    root: path.dirname(project),
    project: "project",
    threadId: "session",
    kind: "root",
    path: file,
    mtimeMs: stat.mtimeMs,
    bytes: stat.size,
  };
}

function manyLines(count) {
  return Array.from({ length: count }, (_, index) => claudeLine({
    timestamp: new Date(NOW + index).toISOString(),
    message: { content: `turn-${index}` },
  }));
}

function config(dir, item, backend = "local") {
  return {
    host: "laptop",
    stateDir: path.join(dir, "state"),
    storeConfig: backend === "s3" ? { backend: "s3" } : { backend: "local", dir: path.join(dir, "objects") },
    convexSiteUrl: null,
    sessionsKey: null,
    ttsKey: null,
    roots: { claude: [{ path: item.root }], codex: [] },
    flags: { backlog: false, deleteAfterUpload: false },
  };
}

function largeDiskFs() {
  const value = Object.create(fs);
  value.statfsSync = () => ({ bavail: 20 * 1024 ** 3, bsize: 1 });
  return value;
}

describe("run sweep", () => {
  it("stores first, pages at 200 rows, and advances only through the delivered page", async () => {
    const dir = temp(); const item = runFile(dir, manyLines(201)); const activeStore = store();
    const ingest = [];
    const firstPost = vi.fn(async (route, body) => {
      if (route !== "/runs/ingest") return { ok: true };
      ingest.push(body);
      if (ingest.length === 2) throw new Error("offline");
      return { ok: true, committedLine: body.run.file.committedLine };
    });
    const first = await sweepRunFile(item, { stateDir: path.join(dir, "state"), store: activeStore, post: firstPost, now: () => NOW });
    expect(activeStore.put).toHaveBeenCalledBefore(firstPost);
    expect(ingest).toHaveLength(2);
    expect(ingest[0].rows).toHaveLength(200);
    expect(ingest[0].run.file.committedLine).toBeLessThan(201);
    expect(ingest[0]).toMatchObject({ previousCommittedLine: 0, previousCommittedPrefixSha256: hash(Buffer.alloc(0)) });
    expect(ingest[1].previousCommittedLine).toBe(ingest[0].run.file.committedLine);
    expect(ingest[1].previousCommittedPrefixSha256).toBe(ingest[0].run.file.committedPrefixSha256);
    expect(first).toMatchObject({ queued: 1 });
    expect(fs.existsSync(stateFileFor(path.join(dir, "state"), "claude:laptop:session"))).toBe(false);

    const drained = await drainQueue({
      stateDir: path.join(dir, "state"),
      post: async (route, body) => route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true },
      now: () => NOW + 1,
    });
    expect(drained).toMatchObject({ delivered: 1, pendingRunIds: [] });
    const state = JSON.parse(fs.readFileSync(stateFileFor(path.join(dir, "state"), "claude:laptop:session"), "utf8"));
    expect(state.committedLine).toBe(201);
  });

  it("uses Convex's returned cursor and retries an uncommitted suffix", async () => {
    const dir = temp(); const item = runFile(dir); const activeStore = store(); let calls = 0;
    const post = async (route, body) => {
      if (route !== "/runs/ingest") return { ok: true };
      calls += 1;
      return { ok: true, committedLine: calls === 1 ? 0 : body.run.file.committedLine };
    };
    await sweepRunFile(item, { stateDir: path.join(dir, "state"), store: activeStore, post, now: () => NOW });
    let state = JSON.parse(fs.readFileSync(stateFileFor(path.join(dir, "state"), "claude:laptop:session"), "utf8"));
    expect(state.committedLine).toBe(0);
    await sweepRunFile(item, { stateDir: path.join(dir, "state"), store: activeStore, post, now: () => NOW + 1 });
    state = JSON.parse(fs.readFileSync(stateFileFor(path.join(dir, "state"), "claude:laptop:session"), "utf8"));
    expect(state.committedLine).toBe(1);
    expect(calls).toBe(2);
  });

  it("keeps a queued run ordered and does not scan it again during backoff", async () => {
    const dir = temp(); const item = runFile(dir); const activeStore = store();
    await sweepRunFile(item, { stateDir: path.join(dir, "state"), store: activeStore, post: async () => { throw new Error("offline"); }, now: () => NOW });
    const cfg = config(dir, item);
    cfg.stateDir = path.join(dir, "state");
    const result = await sweepRuns({ config: cfg, file: item.path, store: activeStore, post: async (route) => {
      if (route === "/runs/ingest") throw new Error("still offline");
      return { ok: true };
    }, fs: largeDiskFs(), now: () => NOW + 1, backoffMs: () => 10_000, log: () => {} });
    expect(result.queue.pendingRunIds).toEqual(["claude:laptop:session"]);
    expect(activeStore.put).toHaveBeenCalledTimes(1);
  });

  it("dead-letters every remaining page on an initial permanent failure and reports once", async () => {
    const dir = temp(); const item = runFile(dir, manyLines(201)); const posts = [];
    const result = await sweepRunFile(item, { stateDir: path.join(dir, "state"), store: store(), post: async (route, body) => {
      posts.push([route, body]);
      if (route === "/runs/ingest") throw Object.assign(new Error("bad request"), { status: 400 });
      return { ok: true };
    }, now: () => NOW });
    expect(result).toMatchObject({ dead: 2, permanent: true });
    expect(fs.readdirSync(path.join(dir, "state", "deadletter")).filter((name) => name.endsWith(".json"))).toHaveLength(2);
    expect(posts.filter(([route]) => route === "/tts/job-failed")).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, "state", "queue")) ? fs.readdirSync(path.join(dir, "state", "queue")).filter((name) => name.endsWith(".json")) : []).toHaveLength(0);
    const blocked = await drainQueue({ stateDir: path.join(dir, "state"), post: async () => ({ ok: true }), now: () => NOW + 1 });
    expect(blocked.pendingRunIds).toEqual(["claude:laptop:session"]);
  });

  it("dead-letters after eight deliveries and re-arms the keyed report when emptied", async () => {
    const dir = temp(); const item = runFile(dir); const stateDir = path.join(dir, "state"); const posts = [];
    const fail = async (route, body) => {
      posts.push([route, body]);
      if (route === "/runs/ingest") throw new Error("offline");
      return { ok: true };
    };
    await sweepRunFile(item, { stateDir, store: store(), post: fail, now: () => NOW });
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await drainQueue({ stateDir, post: fail, now: () => NOW + attempt + 1, backoffMs: () => 0 });
    }
    const deadDir = path.join(stateDir, "deadletter");
    expect(fs.readdirSync(deadDir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(posts.filter(([route]) => route === "/tts/job-failed")).toHaveLength(1);
    for (const name of fs.readdirSync(deadDir).filter((entry) => entry.endsWith(".json"))) fs.unlinkSync(path.join(deadDir, name));
    await drainQueue({ stateDir, post: async (route, body) => { posts.push([route, body]); return { ok: true }; }, now: () => NOW + 20 });
    expect(posts).toContainEqual(["/tts/job-ok", { job: "runs-sweep", key: "runs-sweep:deadletter" }]);
    expect(fs.existsSync(path.join(deadDir, ".reported"))).toBe(false);
  });

  it("moves every later page with a run whose first queued page exhausts retries", async () => {
    const dir = temp(); const item = runFile(dir, manyLines(201)); const stateDir = path.join(dir, "state");
    const fail = async (route) => {
      if (route === "/runs/ingest") throw new Error("offline");
      return { ok: true };
    };
    await sweepRunFile(item, { stateDir, store: store(), post: fail, now: () => NOW });
    expect(fs.readdirSync(path.join(stateDir, "queue")).filter((name) => name.endsWith(".json"))).toHaveLength(2);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await drainQueue({ stateDir, post: fail, now: () => NOW + attempt + 1, backoffMs: () => 0 });
    }
    expect(fs.readdirSync(path.join(stateDir, "deadletter")).filter((name) => name.endsWith(".json"))).toHaveLength(2);
    expect(fs.readdirSync(path.join(stateDir, "queue")).filter((name) => name.endsWith(".json"))).toHaveLength(0);
  });

  it("sends overflow chunks, then the stamp, then ingest", async () => {
    const dir = temp(); const item = runFile(dir, [claudeToolResult({ content: "x".repeat(40_000) })]); const routes = [];
    await sweepRunFile(item, { stateDir: path.join(dir, "state"), store: store(), post: async (route, body) => {
      routes.push(route);
      return route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true };
    }, now: () => NOW });
    expect(routes.at(-2)).toBe("/runs/overflow/stamp");
    expect(routes.at(-1)).toBe("/runs/ingest");
    expect(routes.slice(0, -2).every((route) => route === "/runs/overflow")).toBe(true);
  });

  it("defers pre-watermark files without reading, parsing, or storing them", async () => {
    const dir = temp(); const item = runFile(dir); const old = new Date(NOW - 10_000);
    fs.utimesSync(item.path, old, old);
    const activeStore = { put: vi.fn(() => { throw new Error("must not store"); }) };
    const cfg = config(dir, item);
    const result = await sweepRuns({ config: cfg, store: activeStore, post: async () => ({ ok: true }), fs: largeDiskFs(), now: () => NOW, log: () => {} });
    expect(result).toMatchObject({ deferred: 1, ingested: 0 });
    expect(activeStore.put).not.toHaveBeenCalled();
  });

  it("refuses a missing host with the keyed failure", async () => {
    const dir = temp(); const posts = [];
    const result = await sweepRuns({ config: { host: null, stateDir: path.join(dir, "state"), ttsKey: null, convexSiteUrl: null }, post: async (route, body) => { posts.push([route, body]); return { ok: true }; }, log: () => {} });
    expect(result).toMatchObject({ started: false });
    expect(posts).toContainEqual(["/tts/job-failed", expect.objectContaining({ key: "runs-sweep:no-host" })]);
  });

  it("omits a rejected host-mismatched envelope key from ingest", async () => {
    const dir = temp(); const item = runFile(dir); const ingests = []; const events = [];
    writeRegistrationClaim({ runFile: item.path, writer: { file: "scripts/run-hook.mjs" }, registration: { host: "box", layersKnown: true, layersGiven: ["operate"] }, claim: { by: "hook:SessionStart", hookPayloadKeys: ["session_id"] }, now: () => NOW });
    await sweepRunFile(item, { stateDir: path.join(dir, "state"), store: store(), post: async (route, body) => {
      if (route === "/runs/ingest") ingests.push(body);
      if (route === "/tts/event") events.push(body);
      return route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true };
    }, now: () => NOW });
    expect(ingests[0].run.envelopeKey).toBeUndefined();
    expect(ingests[0].run.context.registered).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ kind: "runs-envelope-host-mismatch" }));
  });

  it("re-arms the local-store failure only after a verified S3 put", async () => {
    const dir = temp(); const item = runFile(dir); const posts = []; const cfg = config(dir, item, "s3");
    await sweepRuns({ config: cfg, file: item.path, store: store(), post: async (route, body) => {
      posts.push([route, body]);
      return route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true };
    }, fs: largeDiskFs(), now: () => NOW, log: () => {} });
    expect(posts).toContainEqual(["/tts/job-ok", { job: "runs-sweep", key: "runs-sweep:store-local" }]);

    const failedPosts = []; const other = runFile(temp()); const otherCfg = config(path.dirname(other.root), other, "s3");
    await sweepRuns({ config: otherCfg, file: other.path, store: { put: () => { throw new Error("unverified"); } }, post: async (route, body) => { failedPosts.push([route, body]); return { ok: true }; }, fs: largeDiskFs(), now: () => NOW, log: () => {} });
    expect(failedPosts.filter(([, body]) => body?.key === "runs-sweep:store-local")).toHaveLength(0);
  });

  it("computes deletion eligibility but never unlinks the source run", async () => {
    const dir = temp(); const item = runFile(dir); const cfg = config(dir, item); cfg.flags.deleteAfterUpload = true;
    writeRegistrationClaim({ runFile: item.path, writer: { file: "scripts/run-hook.mjs" }, registration: { host: "laptop", kind: "session", layersKnown: false }, claim: { by: "hook:SessionStart", hookPayloadKeys: [] }, now: () => NOW });
    writeRegistrationEnd({ runFile: item.path, end: { reason: "done" }, now: () => NOW });
    const result = await sweepRuns({ config: cfg, file: item.path, store: store(), post: async (route, body) => route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true }, fs: largeDiskFs(), now: () => NOW + 1, log: () => {} });
    expect(result.deletable).toBe(1);
    expect(fs.existsSync(item.path)).toBe(true);
    expect(deletable({ host: "box", kind: "session" }, { verified: true, endSeen: true, gitTracked: false }, { now: NOW })).toMatchObject({ ok: false, reason: expect.stringContaining("cutover") });
  });

  it("allows one lock holder and replaces only a stale lock", () => {
    const dir = temp(); const stateDir = path.join(dir, "state");
    const first = acquireSweepLock(stateDir, { now: () => NOW });
    expect(first.acquired).toBe(true);
    expect(acquireSweepLock(stateDir, { now: () => NOW + 1 }).acquired).toBe(false);
    expect(acquireSweepLock(stateDir, { now: () => NOW + 16 * 60_000 }).staleBroken).toBe(true);
  });
});
