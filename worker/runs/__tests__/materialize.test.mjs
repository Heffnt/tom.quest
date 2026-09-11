import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { claudeToolResult, claudeUserTurn, jsonl } from "./fixtures.mjs";
import { PARSER_VERSION, parseClaudeFile } from "../ingest.mjs";
import { openStore } from "../store.mjs";
import { prefixSha256, storeText } from "../sweep.mjs";
import { FAILURE, MAX_SLICES, serveMaterialize } from "../materialize.mjs";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const EMPTY_SHA = crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "runs-materialize-"));
const identity = (rows) => rows.map((row) => [row.seq, row.digest]);

// The run id comes from the file, not from the store key, so a fixture's
// sessionId is what names the run these rows belong to.
function turns(count, { sessionId = "session-aaaa", agentId } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    ...claudeUserTurn({ text: `turn-${index}` }),
    sessionId,
    ...(agentId ? { agentId } : {}),
  }));
}

/** A stored version, the way the backlog importer leaves one behind. */
function scene({ rows = turns(3), runtime = "claude", threadId = "session-aaaa", host = "laptop", text } = {}) {
  const dir = temp();
  const store = openStore({ backend: "local", dir: path.join(dir, "objects") });
  const source = Buffer.from(text ?? jsonl(rows));
  const put = store.put({ runtime, threadId, host, sourceBytes: source });
  const storeBytes = store.get({ runtime, threadId, host, fileVersion: put.fileVersion });
  return {
    dir, store, put, storeBytes, source, runtime, threadId, host,
    runId: `${runtime}:${host}:${threadId}`,
    totalLines: storeText(storeBytes).split("\n").length - 1,
  };
}

function pending(world, { file: fileOverrides = {}, ...overrides } = {}) {
  return {
    requestId: "request-1",
    runId: world.runId,
    slice: 1,
    requestedBy: "tom",
    requestedAt: NOW,
    runner: world.runtime,
    host: world.host,
    threadId: world.threadId,
    depth: 0,
    parentRunId: null,
    hasRows: false,
    fromLine: 0,
    file: {
      path: "session.jsonl",
      sourceHash: world.put.sourceHash,
      storedHash: world.put.storedHash,
      bytes: world.put.bytes,
      storedBytes: world.put.storedBytes,
      committedLine: 0,
      committedPrefixSha256: EMPTY_SHA,
      storeKey: world.put.key,
      sidecarStoredHash: null,
      totalLines: null,
      incompleteTail: false,
      ...fileOverrides,
    },
    ...overrides,
  };
}

/**
 * Enough of Convex to hold the compare-and-swap fence honest: the two refusals
 * this job must never provoke are a regressed cursor and an equal cursor under
 * a different prefix hash.
 */
function convex() {
  const runs = new Map();
  const rowsByRun = new Map();
  const routes = [];
  const bodies = [];
  const post = vi.fn(async (route, body) => {
    routes.push(route);
    bodies.push([route, body]);
    if (route !== "/runs/ingest") return { ok: true };
    const existing = runs.get(body.run.runId);
    if (body.rows.length > 200) return { ok: false, reason: "too many rows" };
    for (const row of body.rows) {
      if (row.overflow !== undefined) return { ok: false, reason: "overflow must be stamped separately" };
      if (row.provenance.fileVersion !== body.run.file.storedHash) return { ok: false, reason: "row file version mismatch" };
    }
    if (existing) {
      if (body.previousCommittedLine !== existing.file.committedLine || body.previousPrefixSha256 !== existing.file.committedPrefixSha256) return { ok: false, reason: "file rewritten" };
      if (body.run.file.bytes < existing.file.bytes) return { ok: false, reason: "file shrank" };
      if (body.run.file.committedLine < existing.file.committedLine) return { ok: false, reason: "committed cursor regressed" };
      if (body.run.file.committedLine === existing.file.committedLine && body.run.file.committedPrefixSha256 !== existing.file.committedPrefixSha256) return { ok: false, reason: "file rewritten" };
    }
    const table = rowsByRun.get(body.run.runId) ?? new Map();
    let inserted = 0;
    for (const row of body.rows) if (!table.has(row.seq)) { table.set(row.seq, row); inserted += 1; }
    rowsByRun.set(body.run.runId, table);
    const file = existing && body.run.file.committedLine <= existing.file.committedLine ? existing.file : body.run.file;
    runs.set(body.run.runId, { ...body.run, file });
    return { ok: true, runId: body.run.runId, inserted, skipped: body.rows.length - inserted, committedLine: file.committedLine };
  });
  return {
    post, runs, routes,
    // One index row and no transcript rows, exactly what the backlog import writes.
    index: (runId, file) => runs.set(runId, { file: { ...file } }),
    rowsOf: (runId) => [...(rowsByRun.get(runId) ?? new Map()).values()].sort((a, b) => a.seq - b.seq),
    ingests: () => bodies.filter(([route]) => route === "/runs/ingest").map(([, body]) => body),
    answers: () => bodies.filter(([route]) => route === "/runs/materialize-answer").map(([, body]) => body),
  };
}

function serve(world, db, request, options = {}) {
  return serveMaterialize({
    config: { host: world.host, stateDir: path.join(world.dir, "state"), storeConfig: { backend: "local", dir: path.join(world.dir, "objects") }, ...(options.config ?? {}) },
    store: options.store ?? world.store,
    get: options.get ?? (async () => ({ request })),
    post: db.post,
    now: () => NOW,
    log: () => {},
    ...options.serve,
  });
}

/** What a direct parse of the same stored bytes produces. */
function directParse(world, { fromLine = 0 } = {}) {
  return parseClaudeFile({
    path: "session.jsonl",
    text: storeText(world.storeBytes),
    host: world.host,
    fileVersion: world.put.storedHash,
    baseLine: fromLine,
  });
}

describe("runs materialize", () => {
  it("rebuilds a backlog run's rows from the store, seq for seq and digest for digest", async () => {
    const world = scene({ rows: turns(6) });
    const db = convex();
    db.index(world.runId, { path: "session.jsonl", sourceHash: world.put.sourceHash, storedHash: world.put.storedHash, bytes: world.put.bytes, storedBytes: world.put.storedBytes, committedLine: 0, committedPrefixSha256: EMPTY_SHA, storeKey: world.put.key, totalLines: world.totalLines });

    const result = await serve(world, db, pending(world));
    const expected = directParse(world);

    expect(result).toMatchObject({ status: "served", answered: true, fromLine: 0, toLine: world.totalLines, totalLines: world.totalLines });
    expect(identity(db.rowsOf(world.runId))).toEqual(identity(expected.rows));
    expect(db.rowsOf(world.runId)).toHaveLength(expected.rows.length);
    // A backlog run ends with its cursor at the file's own end.
    expect(db.runs.get(world.runId).file).toMatchObject({ committedLine: world.totalLines, totalLines: world.totalLines });
    expect(db.answers()[0]).toMatchObject({
      requestId: "request-1",
      status: "served",
      rowsIngested: expected.rows.length,
      fromLine: 0,
      toLine: world.totalLines,
      totalLines: world.totalLines,
      rowsSource: { from: "store", at: NOW, parserVersion: PARSER_VERSION, storeKey: world.put.key, rowsFromLine: 0, rowsToLine: world.totalLines, slices: 1 },
    });
    expect(db.answers()[0].rowsSource.partial).toContain("no-envelope");
  });

  it("gives an evicted run its rows back without moving the cursor", async () => {
    const world = scene({ rows: turns(5) });
    const db = convex();
    const cursor = { committedLine: world.totalLines, committedPrefixSha256: prefixSha256(world.storeBytes, world.totalLines) };
    db.index(world.runId, { path: "session.jsonl", sourceHash: world.put.sourceHash, storedHash: world.put.storedHash, bytes: world.put.bytes, storedBytes: world.put.storedBytes, storeKey: world.put.key, totalLines: world.totalLines, ...cursor });

    const result = await serve(world, db, pending(world, { hasRows: false, fromLine: 0, file: { ...cursor, totalLines: world.totalLines } }));

    expect(result.status).toBe("served");
    expect(identity(db.rowsOf(world.runId))).toEqual(identity(directParse(world).rows));
    // Rule M: every page named the stored pair verbatim, so the fence was an
    // identity check and nothing about the cursor changed.
    for (const body of db.ingests()) {
      expect(body.previousCommittedLine).toBe(cursor.committedLine);
      expect(body.previousPrefixSha256).toBe(cursor.committedPrefixSha256);
      expect(body.run.file).toMatchObject(cursor);
    }
    expect(db.runs.get(world.runId).file).toMatchObject(cursor);
  });

  it("pages at 200 rows, sends the page then its chunks then the stamp, and advances from each answer", async () => {
    const rows = turns(205);
    rows.splice(3, 0, claudeToolResult({ content: "x".repeat(40_000) }));
    const world = scene({ rows });
    const db = convex();
    db.index(world.runId, { path: "session.jsonl", sourceHash: world.put.sourceHash, storedHash: world.put.storedHash, bytes: world.put.bytes, storedBytes: world.put.storedBytes, committedLine: 0, committedPrefixSha256: EMPTY_SHA, storeKey: world.put.key, totalLines: world.totalLines });

    await serve(world, db, pending(world));

    const ingests = db.ingests();
    expect(ingests).toHaveLength(2);
    expect(ingests[0].rows).toHaveLength(200);
    expect(ingests[0].rows.some((row) => row.overflow !== undefined)).toBe(false);
    expect(db.routes.slice(0, 4)).toEqual(["/runs/ingest", "/runs/overflow", "/runs/overflow/stamp", "/runs/ingest"]);
    expect(ingests[0]).toMatchObject({ previousCommittedLine: 0, previousPrefixSha256: EMPTY_SHA });
    expect(ingests[1].previousCommittedLine).toBe(ingests[0].run.file.committedLine);
    expect(ingests[1].previousPrefixSha256).toBe(ingests[0].run.file.committedPrefixSha256);
    expect(ingests[0].run.file.committedLine).toBeLessThan(world.totalLines);
    expect(ingests[1].run.file.committedLine).toBe(world.totalLines);
    expect(db.rowsOf(world.runId)).toHaveLength(directParse(world).rows.length);
  });

  it("opens a Claude subagent whose sidecar is gone, with the parser's own error row", async () => {
    const world = scene({ threadId: "session-aaaa/agent-bbbb", rows: turns(3, { agentId: "agent-bbbb" }) });
    const db = convex();
    db.index(world.runId, { path: "agent.jsonl", sourceHash: world.put.sourceHash, storedHash: world.put.storedHash, bytes: world.put.bytes, storedBytes: world.put.storedBytes, committedLine: 0, committedPrefixSha256: EMPTY_SHA, storeKey: world.put.key, totalLines: world.totalLines });

    const result = await serve(world, db, pending(world, { depth: 1, parentRunId: `claude:${world.host}:session-aaaa` }));

    expect(result.status).toBe("served");
    const errors = db.rowsOf(world.runId).filter((row) => row.kind === "error");
    expect(errors.some((row) => String(row.content?.error ?? "").includes("subagent sidecar is missing or malformed"))).toBe(true);
    expect(db.answers()[0].rowsSource.partial).toContain("sidecar-missing");
  });

  it("answers every failure and never leaves the request pending", async () => {
    const broken = (message) => ({ get: async () => { throw new Error(message); } });
    const cases = [
      { name: "object missing", reason: FAILURE.missing, request: {}, options: { store: broken("run store object not found") } },
      { name: "hash mismatch", reason: FAILURE.hashMismatch, request: {}, options: { store: broken("run store object hash mismatch") } },
      { name: "store unreachable", reason: FAILURE.unreachable, request: {}, options: { store: broken("fetch failed") } },
      { name: "no store key", reason: FAILURE.noStoreKey, request: { file: { storeKey: null } }, options: {} },
      { name: "file too large", reason: FAILURE.tooLarge, request: {}, options: { config: { backlog: { maxFileBytes: 8 } } } },
      { name: "no rows", reason: FAILURE.noRows, request: { hasRows: true, fromLine: 99 }, options: {} },
      { name: "run gone", reason: FAILURE.gone, request: { runId: "", threadId: "" }, options: {} },
    ];
    for (const entry of cases) {
      const world = scene();
      const db = convex();
      const result = await serve(world, db, pending(world, entry.request), entry.options);
      expect(result, entry.name).toMatchObject({ status: "failed", reason: entry.reason, answered: true });
      expect(db.answers(), entry.name).toEqual([{ requestId: "request-1", status: "failed", reason: entry.reason }]);
      expect(db.ingests(), entry.name).toHaveLength(0);
    }
  });

  it("answers a throw inside the parse rather than leaving the head of the queue stuck", async () => {
    // A non-finite number reaches the Codex context window, which the parser
    // refuses to hand to Convex. No injection: the file alone does it.
    const world = scene({ runtime: "codex", threadId: "thread-cccc", text: `{"type":"session_meta","payload":{"id":"thread-cccc","context_window":1e999},"timestamp":"2026-01-01T00:00:00.000Z"}\n` });
    const db = convex();
    const result = await serve(world, db, pending(world));
    expect(result).toMatchObject({ status: "failed", reason: FAILURE.noRows, answered: true });
    expect(db.answers()).toHaveLength(1);
    expect(db.ingests()).toHaveLength(0);
  });

  it("stops the row cap at a line boundary, names the span, and queues nothing itself", async () => {
    const world = scene({ rows: turns(9) });
    const db = convex();
    db.index(world.runId, { path: "session.jsonl", sourceHash: world.put.sourceHash, storedHash: world.put.storedHash, bytes: world.put.bytes, storedBytes: world.put.storedBytes, committedLine: 0, committedPrefixSha256: EMPTY_SHA, storeKey: world.put.key, totalLines: world.totalLines });

    const result = await serve(world, db, pending(world), { serve: { maxRows: 4 } });

    expect(result.status).toBe("served");
    expect(result.toLine).toBeLessThan(result.totalLines);
    const landed = db.rowsOf(world.runId);
    expect(landed.length).toBeLessThanOrEqual(4);
    // The span the answer names is the line after the last row that landed.
    expect(result.toLine).toBe(landed.at(-1).provenance.lineEnd + 1);
    expect(db.runs.get(world.runId).file.committedLine).toBe(result.toLine);
    // The answer route enqueues the continuation; the job never does.
    expect(db.routes).not.toContain("/runs/materialize");
    expect(db.answers()[0].rowsSource.partial).not.toContain("row-cap-reached");
  });

  it("says row-cap-reached on the fifth slice and still queues nothing", async () => {
    const world = scene({ rows: turns(9) });
    const db = convex();
    const fromLine = 2;
    const cursor = { committedLine: fromLine, committedPrefixSha256: prefixSha256(world.storeBytes, fromLine) };
    db.index(world.runId, { path: "session.jsonl", sourceHash: world.put.sourceHash, storedHash: world.put.storedHash, bytes: world.put.bytes, storedBytes: world.put.storedBytes, storeKey: world.put.key, totalLines: world.totalLines, ...cursor });

    const result = await serve(world, db, pending(world, { slice: MAX_SLICES, hasRows: true, fromLine, file: { ...cursor, totalLines: world.totalLines } }), { serve: { maxRows: 3 } });

    expect(result.status).toBe("served");
    expect(db.answers()[0].rowsSource).toMatchObject({ slices: MAX_SLICES, rowsFromLine: fromLine });
    expect(db.answers()[0].rowsSource.partial).toContain("row-cap-reached");
    expect(db.routes).not.toContain("/runs/materialize");
  });

  it("posts nothing at all on a dry run", async () => {
    const world = scene({ rows: turns(4) });
    const db = convex();
    const result = await serve(world, db, pending(world), { serve: { dryRun: true } });
    expect(result).toMatchObject({ dryRun: true, status: "served", rowsIngested: 0, toLine: world.totalLines });
    expect(db.post).not.toHaveBeenCalled();
  });

  it("logs one line and exits when the queue is empty", async () => {
    const world = scene();
    const db = convex();
    const lines = [];
    const result = await serveMaterialize({
      config: { host: "laptop", stateDir: path.join(world.dir, "state"), storeConfig: { backend: "local", dir: path.join(world.dir, "objects") } },
      store: world.store,
      get: async () => ({ request: null }),
      post: db.post,
      now: () => NOW,
      log: (line) => lines.push(line),
    });
    expect(result).toMatchObject({ started: true, empty: true });
    expect(lines).toHaveLength(1);
    expect(db.post).not.toHaveBeenCalled();
  });

  it("serves one run directly from injected facts, a repair and the proof", async () => {
    const world = scene({ rows: turns(4) });
    const db = convex();
    db.index(world.runId, { path: "session.jsonl", sourceHash: world.put.sourceHash, storedHash: world.put.storedHash, bytes: world.put.bytes, storedBytes: world.put.storedBytes, committedLine: 0, committedPrefixSha256: EMPTY_SHA, storeKey: world.put.key, totalLines: world.totalLines });
    const request = pending(world);

    const result = await serveMaterialize({
      config: { host: world.host, stateDir: path.join(world.dir, "state"), storeConfig: { backend: "local", dir: path.join(world.dir, "objects") } },
      runId: world.runId,
      store: world.store,
      getRun: async (runId) => (runId === world.runId ? request : null),
      get: async () => { throw new Error("the queue must not be read on this path"); },
      post: db.post,
      now: () => NOW,
      log: () => {},
    });

    expect(result.status).toBe("served");
    expect(identity(db.rowsOf(world.runId))).toEqual(identity(directParse(world).rows));
  });
});
