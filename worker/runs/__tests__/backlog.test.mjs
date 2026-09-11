// Every assertion here runs with no network, no bucket, no box and no real
// transcript: the sources are synthetic CLI-shaped lines from fixtures.mjs and
// a synthetic sessions/ archive built from them.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it, vi } from "vitest";

import {
  claudeAssistant,
  claudeTaskResultCompleted,
  claudeTextBlock,
  claudeToolUseBlock,
  claudeUserTurn,
  jsonl,
  subagentMeta,
} from "./fixtures.mjs";
import {
  BACKLOG_SOURCES,
  archiveDest,
  archiveEntries,
  archiveStateFileFor,
  backlogStatus,
  buildLists,
  emptyPrefixSha256,
  listFileFor,
  parseUnit,
  runBacklogPass,
  unitsOf,
} from "../backlog.mjs";
import { stateFileFor, storeText } from "../sweep.mjs";

const NOW = Date.parse("2026-09-01T00:00:00.000Z");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "runs-backlog-"));
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const REMOVERS = ["unlink", "unlinkSync", "rm", "rmSync", "rmdir", "rmdirSync", "truncate", "truncateSync"];

// ── The world the pass runs in ───────────────────────────────────────────────

/** node:fs with a volume that is never low, so the disk pause is opt-in. */
function bigDiskFs(base = fs) {
  const value = Object.create(base);
  value.statfsSync = () => ({ bavail: 20 * 1024 ** 3, bsize: 1 });
  return value;
}

function spyingFs(base = bigDiskFs()) {
  const value = Object.create(base);
  const spies = {};
  for (const name of REMOVERS) {
    spies[name] = vi.fn(() => { throw new Error(`backlog called fs.${name}`); });
    value[name] = spies[name];
  }
  return { fs: value, spies };
}

/**
 * The store's contract, in memory: put redacts before hashing, get returns the
 * redacted bytes, and a second put of the same bytes is not `created`.
 */
function fakeStore() {
  const objects = new Map();
  const at = (runtime, host, threadId, fileVersion, kind) => `${runtime}|${host}|${threadId}|${fileVersion}|${kind}`;
  const put = vi.fn(({ runtime, threadId, host, sourceBytes, kind = "transcript" }) => {
    const source = Buffer.from(sourceBytes);
    const redacted = Buffer.from(storeText(source), "utf8");
    const storedHash = sha256(redacted);
    const slot = at(runtime, host, threadId, storedHash, kind);
    const created = !objects.has(slot);
    objects.set(slot, redacted);
    return {
      fileVersion: storedHash, storedHash, storedBytes: redacted.length,
      key: `runs/${runtime}/${host}/${threadId}/${storedHash}${kind === "sidecar" ? ".sidecar" : ""}.jsonl.gz`,
      kind, sourceHash: sha256(source), bytes: source.length, verified: true, created,
    };
  });
  const get = vi.fn(({ runtime, threadId, host, fileVersion, kind = "transcript" }) => {
    const bytes = objects.get(at(runtime, host, threadId, fileVersion, kind));
    if (!bytes) throw new Error("run store object not found");
    return bytes;
  });
  return { put, get, objects };
}

function config(dir, overrides = {}) {
  return {
    host: "laptop",
    stateDir: path.join(dir, "state"),
    // s3 by default so the store-local pause is something a test opts into.
    storeConfig: { backend: "s3" },
    convexSiteUrl: null,
    sessionsKey: null,
    ttsKey: null,
    roots: { claude: [{ path: path.join(dir, "projects") }], codex: [{ path: path.join(dir, "codex") }] },
    flags: { backlog: false, deleteAfterUpload: false },
    ...overrides,
    backlog: {
      bytesPerHour: 1024 ** 3,
      passMs: 600_000,
      maxFileBytes: 128 * 1024 * 1024,
      allowLocalStore: false,
      sessionsDir: path.join(dir, "sessions"),
      ...(overrides.backlog ?? {}),
    },
  };
}

function recorder() {
  const calls = [];
  const post = vi.fn(async (route, body) => {
    calls.push({ route, body });
    return route === "/runs/ingest" ? { ok: true, committedLine: 0 } : { ok: true };
  });
  return {
    post, calls,
    ingests: () => calls.filter((call) => call.route === "/runs/ingest").map((call) => call.body),
    events: (kind) => calls.filter((call) => call.route === "/tts/event" && call.body.kind === kind).map((call) => call.body.data),
    keyed: (route) => calls.filter((call) => call.route === route).map((call) => call.body),
  };
}

const pass = (dir, options = {}) => runBacklogPass({
  config: options.config ?? config(dir),
  fs: options.fs ?? bigDiskFs(),
  now: options.now ?? (() => NOW),
  post: options.post,
  store: options.store,
  log: options.log ?? (() => {}),
  gitTracked: options.gitTracked ?? (() => false),
  limit: options.limit ?? 0,
  source: options.source ?? null,
  dryRun: options.dryRun ?? false,
});

// ── Synthetic sources ────────────────────────────────────────────────────────

const PARENT_ROWS = [
  claudeUserTurn({ text: "do the thing", origin: { kind: "human" } }),
  claudeAssistant({ blocks: [claudeTextBlock("on it"), claudeToolUseBlock({ id: "task", name: "Task", input: { description: "work" } })], usage: { input_tokens: 5, output_tokens: 7 } }),
  claudeTaskResultCompleted({ toolUseId: "task", agentId: "agent" }),
];
const CHILD_ROWS = [
  claudeUserTurn({ text: "child prompt" }),
  claudeAssistant({ blocks: [claudeTextBlock("child answer")], usage: { input_tokens: 1, output_tokens: 2 } }),
];

// A real transcript names its own session on every line, and the parser builds
// the run id from that and never from the path, so a fixture must agree too.
const withSession = (rows, session) => rows.map((row) => ({ ...row, sessionId: session }));

/** One Claude session, its subagent, its sidecar and a tool result, on disk. */
function claudeTree(dir, { session = "session", project = "proj", parentRows = PARENT_ROWS, childRows = CHILD_ROWS, mtime } = {}) {
  const projectDir = path.join(dir, "projects", project);
  const sessionDir = path.join(projectDir, session);
  fs.mkdirSync(path.join(sessionDir, "subagents"), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, "tool-results"), { recursive: true });
  const parent = path.join(projectDir, `${session}.jsonl`);
  const child = path.join(sessionDir, "subagents", "agent-agent.jsonl");
  const meta = path.join(sessionDir, "subagents", "agent-agent.meta.json");
  const tool = path.join(sessionDir, "tool-results", "output.txt");
  fs.writeFileSync(parent, jsonl(withSession(parentRows, session)));
  fs.writeFileSync(child, jsonl(withSession(childRows, session)));
  fs.writeFileSync(meta, JSON.stringify(subagentMeta({ agentType: "worker", toolUseId: "task" })));
  fs.writeFileSync(tool, "tool output\n");
  if (mtime) for (const file of [parent, child, meta, tool]) fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return { parent, child, meta, tool, session };
}

function manifestLine(fields) {
  return { orphan: false, parts: null, encoding: "gzip", date_source: "timestamp", ...fields };
}

/** The same bytes, filed the way the WikiTom archive files them. */
function archiveTree(dir, { session = "session", date = "2026-08-30", host = "box", account = null, files = {}, manifest = "box" } = {}) {
  const sessionsDir = path.join(dir, "sessions");
  const segment = account ? `${account}/` : "";
  const base = `sessions/${date.replaceAll("-", "/")}/claude-${session}`;
  const lines = [];
  // A manifest `dest` is relative to the WikiTom root and opens with the
  // `sessions/` segment, so the bytes live one level up from that segment.
  const write = (dest, bytes) => {
    const target = path.join(sessionsDir, ...dest.split("/").slice(1));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const gz = zlib.gzipSync(bytes, { level: 9 });
    fs.writeFileSync(target, gz);
    return { raw_bytes: bytes.length, stored_bytes: gz.length, sha256: sha256(bytes) };
  };
  const common = { session, project: "proj", date, kind: "parent", ...(manifest === "box" ? { host, account, runtime: "claude", parent: null } : {}) };
  if (files.parent) {
    const dest = `${base}/${segment}session.jsonl.gz`;
    lines.push(manifestLine({ ...common, kind: "parent", source: files.parent.source, dest, ...write(dest, files.parent.bytes) }));
  }
  if (files.child) {
    const dest = `${base}/${segment}children/subagents/agent-${files.child.agentId}.jsonl.gz`;
    lines.push(manifestLine({ ...common, kind: "child", orphan: Boolean(files.child.orphan), source: files.child.source, dest, ...write(dest, files.child.bytes) }));
  }
  if (files.sidecar) {
    const dest = `${base}/${segment}attachments/subagents/agent-${files.sidecar.agentId}.meta.json.gz`;
    lines.push(manifestLine({ ...common, kind: "attachment", source: files.sidecar.source, dest, ...write(dest, files.sidecar.bytes) }));
  }
  for (const tool of files.toolResults ?? []) {
    const dest = `${base}/${segment}attachments/tool-results/${tool.name}`;
    lines.push(manifestLine({ ...common, kind: "attachment", source: tool.source, dest, ...write(dest, tool.bytes) }));
  }
  // A Workflow's agents are filed one folder deeper, and the workflow's own
  // journal and scripts sit beside them.
  for (const extra of files.nested ?? []) {
    const folder = `${base}/${segment}children/subagents/workflows/${extra.workflow}`;
    const dest = `${folder}/agent-${extra.agentId}.jsonl.gz`;
    lines.push(manifestLine({ ...common, kind: "child", source: extra.source, dest, ...write(dest, extra.bytes) }));
    if (extra.sidecar) {
      const metaDest = `${base}/${segment}attachments/subagents/workflows/${extra.workflow}/agent-${extra.agentId}.meta.json.gz`;
      lines.push(manifestLine({ ...common, kind: "attachment", source: extra.sidecar.source, dest: metaDest, ...write(metaDest, extra.sidecar.bytes) }));
    }
  }
  // Anything else the session carried, filed exactly where the archive put it.
  for (const extra of files.extras ?? []) {
    const dest = `${base}/${segment}${extra.tail}`;
    lines.push(manifestLine({ ...common, kind: "attachment", source: extra.source, dest, ...write(dest, extra.bytes) }));
  }
  const file = path.join(sessionsDir, `manifest-${manifest}-2026-09-05.jsonl`);
  fs.appendFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return { sessionsDir, lines };
}

// ── The tests ────────────────────────────────────────────────────────────────

describe("backlog work lists", () => {
  it("orders a live source strictly newest first", () => {
    const dir = temp();
    claudeTree(dir, { session: "old", project: "a", mtime: NOW - 3 * 86_400_000 });
    claudeTree(dir, { session: "mid", project: "b", mtime: NOW - 2 * 86_400_000 });
    claudeTree(dir, { session: "new", project: "c", mtime: NOW - 86_400_000 });
    buildLists({ config: config(dir), fs: bigDiskFs(), now: () => NOW, sources: ["claude-live"] });
    const list = fs.readFileSync(listFileFor(path.join(dir, "state"), "claude-live"), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(list.map((entry) => entry.at)).toEqual([...list.map((entry) => entry.at)].sort((a, b) => b - a));
    expect(list.filter((entry) => entry.runtimeKind === "claude/root").map((entry) => entry.threadId)).toEqual(["new", "mid", "old"]);
    expect(list.some((entry) => entry.runtimeKind === "claude/subagent" && entry.sidecarPath)).toBe(true);
  });

  it("orders an archive list by date and breaks ties stably by thread id", () => {
    const dir = temp();
    for (const [session, date] of [["bbb", "2026-08-29"], ["aaa", "2026-08-30"], ["ccc", "2026-08-30"]]) {
      archiveTree(dir, { session, date, files: { parent: { source: `/root/${session}.jsonl`, bytes: Buffer.from(jsonl(withSession(PARENT_ROWS, session))) } } });
    }
    const built = archiveEntries({ sessionsDir: path.join(dir, "sessions") });
    const ordered = [...built.entries].sort((a, b) => b.at - a.at || String(a.key).localeCompare(String(b.key)));
    expect(ordered.map((entry) => entry.threadId)).toEqual(["aaa", "ccc", "bbb"]);
  });

  // The archive files a Workflow's agents one folder deeper and parks the
  // workflow's own journal beside them. The FILE NAME says which is a
  // transcript; the `.jsonl` extension says nothing, and the folder says only
  // which workflow the agent belonged to.
  it("names a workflow's agent a run and the journal beside it an attachment", () => {
    const dir = temp();
    archiveTree(dir, {
      files: {
        parent: { source: "/root/session.jsonl", bytes: Buffer.from(jsonl(PARENT_ROWS)) },
        nested: [{ workflow: "wf_1", agentId: "deep", source: "/root/deep.jsonl", bytes: Buffer.from(jsonl(CHILD_ROWS)) }],
        extras: [
          { tail: "children/subagents/workflows/wf_1/journal.jsonl.gz", source: "/root/journal.jsonl", bytes: Buffer.from(JSON.stringify({ phase: 1 })) },
          { tail: "attachments/workflows/wf_1.json", source: "/root/wf_1.json", bytes: Buffer.from(JSON.stringify({})) },
        ],
      },
    });
    const built = archiveEntries({ sessionsDir: path.join(dir, "sessions") });
    expect(built.workflowAgents).toBe(1);
    expect(built.entries).toHaveLength(1);
    expect(built.entries[0].children.map((child) => [child.threadId, child.workflowId])).toEqual([["session/deep", "wf_1"]]);
    // Neither the journal nor the workflow's own script is a run, and the root
    // is the nearest run left to hold them.
    expect(built.entries[0].attachments.map((item) => path.basename(item.file)).sort()).toEqual(["journal.jsonl", "wf_1.json"]);
    expect(built.skippedUnknownDest).toBe(0);
  });

  it("carries an agent's sidecar as that agent's pointer, however deep it was filed", () => {
    const dir = temp();
    archiveTree(dir, {
      files: {
        parent: { source: "/root/session.jsonl", bytes: Buffer.from(jsonl(PARENT_ROWS)) },
        nested: [{
          workflow: "wf_2", agentId: "deep", source: "/root/deep.jsonl", bytes: Buffer.from(jsonl(CHILD_ROWS)),
          sidecar: { source: "/root/deep.meta.json", bytes: Buffer.from(JSON.stringify({ agentType: "workflow-subagent", spawnDepth: 2 })) },
        }],
      },
    });
    const built = archiveEntries({ sessionsDir: path.join(dir, "sessions") });
    const [child] = built.entries[0].children;
    expect(child.sidecarKey).toContain("attachments/subagents/workflows/wf_2/agent-deep.meta.json.gz");
    expect(child.attachments.map((item) => path.basename(item.file))).toEqual(["deep.meta.json"]);
    // The root keeps none of it: the sidecar names an agent, so it is the
    // agent's.
    expect(built.entries[0].attachments).toEqual([]);
  });

  it("takes a dest apart the way the manifests wrote it", () => {
    expect(archiveDest("sessions/2026/08/30/claude-x/session.jsonl.gz")).toMatchObject({ runtime: "claude", id: "x", account: null, tail: "session.jsonl.gz" });
    expect(archiveDest("sessions/2026/08/30/claude-x/wpi/children/subagents/agent-y.jsonl.gz")).toMatchObject({ account: "wpi", tail: "children/subagents/agent-y.jsonl.gz" });
    expect(archiveDest("sessions/2026/09/04/codex-t/rollout.jsonl.gz")).toMatchObject({ runtime: "codex", id: "t", tail: "rollout.jsonl.gz" });
    expect(archiveDest("runs/manifest-2026-09.jsonl")).toBeNull();
  });

  it("preserves the cursor on a rebuild with the same head and resets it otherwise", async () => {
    const dir = temp();
    claudeTree(dir, { session: "one", project: "a", mtime: NOW - 3 * 86_400_000 });
    claudeTree(dir, { session: "two", project: "b", mtime: NOW - 2 * 86_400_000 });
    const cfg = config(dir);
    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW, sources: ["claude-live"] });
    const store = fakeStore(); const sink = recorder();
    await pass(dir, { config: cfg, store, post: sink.post, source: "claude-live", limit: 1 });
    const cursorFile = path.join(dir, "state", "backlog", "cursor.json");
    const afterFirst = JSON.parse(fs.readFileSync(cursorFile, "utf8"))["claude-live"];
    expect(afterFirst).toBe(1);

    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW + 1, sources: ["claude-live"] });
    expect(JSON.parse(fs.readFileSync(cursorFile, "utf8"))["claude-live"]).toBe(1);

    // A newer file lands at the top: the head no longer matches, so the cursor
    // resets and every already-imported run is skipped in O(1) behind it.
    claudeTree(dir, { session: "three", project: "c", mtime: NOW - 86_400_000 });
    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW + 2, sources: ["claude-live"] });
    expect(JSON.parse(fs.readFileSync(cursorFile, "utf8"))["claude-live"]).toBe(0);
    const second = await pass(dir, { config: cfg, store, post: sink.post, source: "claude-live" });
    expect(second.sources[0].alreadyImported).toBeGreaterThan(0);
  });
});

describe("the deferred handshake", () => {
  it("skips an imported run in O(1) without reading its file", async () => {
    const dir = temp();
    const tree = claudeTree(dir);
    const cfg = config(dir);
    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW, sources: ["claude-live"] });
    const stateFile = stateFileFor(cfg.stateDir, "claude:laptop:session");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ runId: "claude:laptop:session", deferred: false, storeKey: "runs/already" }));
    const guard = Object.create(bigDiskFs());
    guard.readFileSync = (file, ...rest) => {
      if (String(file) === tree.parent) throw new Error("the importer read a run it should have skipped");
      return fs.readFileSync(file, ...rest);
    };
    const store = fakeStore(); const sink = recorder();
    const result = await pass(dir, { config: cfg, fs: guard, store, post: sink.post, source: "claude-live" });
    expect(result.sources[0].alreadyImported).toBe(1);
    expect(sink.ingests().map((body) => body.run.runId)).not.toContain("claude:laptop:session");
  });

  it("clears deferred and writes a store key on success, and keeps both on failure", async () => {
    const dir = temp();
    claudeTree(dir);
    const cfg = config(dir);
    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW, sources: ["claude-live"] });
    const stateFile = stateFileFor(cfg.stateDir, "claude:laptop:session");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ runId: "claude:laptop:session", deferred: true, bytes: 1 }));

    const store = fakeStore();
    const failing = vi.fn(async (route) => { if (route === "/runs/ingest") throw Object.assign(new Error("offline"), { stage: "ingest" }); return { ok: true }; });
    await pass(dir, { config: cfg, store, post: failing, source: "claude-live" });
    const failed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(failed).toMatchObject({ deferred: true, failures: 1 });
    expect(failed.storeKey).toBeUndefined();
    expect(failed.lastFailure.stage).toBe("ingest");

    const sink = recorder();
    await pass(dir, { config: cfg, store, post: sink.post, source: "claude-live" });
    const landed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(landed.deferred).toBe(false);
    expect(landed.storeKey).toMatch(/^runs\//);
    expect(landed.committedLine).toBe(0);
    // The second attempt re-puts the same bytes: the object already exists.
    expect(store.put.mock.results.some((entry) => entry.value.created === false)).toBe(true);
  });
});

describe("what one old run costs the record", () => {
  it("posts one index row, no transcript rows, the child edges and both store objects", async () => {
    const dir = temp();
    claudeTree(dir);
    const cfg = config(dir);
    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW, sources: ["claude-live"] });
    const store = fakeStore(); const sink = recorder();
    const result = await pass(dir, { config: cfg, store, post: sink.post, source: "claude-live" });
    expect(result.started).toBe(true);

    const ingests = sink.ingests();
    const parent = ingests.find((body) => body.run.runId === "claude:laptop:session");
    const child = ingests.find((body) => body.run.runId === "claude:laptop:session/agent");
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    for (const body of ingests) {
      expect(body.rows).toEqual([]);
      expect(body.previousCommittedLine).toBe(0);
      expect(body.previousPrefixSha256).toBe(sha256(Buffer.alloc(0)));
      expect(body.run.file.committedLine).toBe(0);
      expect(body.run.file.committedPrefixSha256).toBe(emptyPrefixSha256());
      expect(body.run.file.totalLines).toBeGreaterThan(0);
      expect(body.run.file.storeKey).toMatch(/^runs\//);
      expect(body.run.file.storedBytes).toBeGreaterThan(0);
    }
    expect(parent.children).toEqual([expect.objectContaining({ runId: "claude:laptop:session/agent", parentRunId: "claude:laptop:session" })]);
    expect(parent.run.file.totalLines).toBe(PARENT_ROWS.length);
    expect(parent.run.attachments).toEqual([expect.objectContaining({ file: expect.stringContaining("output.txt") })]);
    expect(child.run.file.sidecarStoredHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.put.mock.calls.map(([call]) => call.kind ?? "transcript").sort()).toEqual(["sidecar", "transcript", "transcript"]);

    const event = sink.events("runs-backlog-pass")[0];
    expect(event).toMatchObject({ host: "laptop", source: "claude-live", imported: 2, duplicates: 0, failed: 0, pausedBy: null });
    expect(event.cursor).toBe(2);
  });

  it("skips a source above the cap with the reason recorded and carries on", async () => {
    const dir = temp();
    claudeTree(dir, { session: "big", project: "a", mtime: NOW - 86_400_000 });
    claudeTree(dir, { session: "small", project: "b", mtime: NOW - 2 * 86_400_000 });
    const big = path.join(dir, "projects", "a", "big.jsonl");
    fs.writeFileSync(big, jsonl([...PARENT_ROWS, claudeUserTurn({ text: "x".repeat(4000) })]));
    fs.utimesSync(big, new Date(NOW - 86_400_000), new Date(NOW - 86_400_000));
    const cfg = config(dir, { backlog: { maxFileBytes: 2000 } });
    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW, sources: ["claude-live"] });
    const store = fakeStore(); const sink = recorder();
    const result = await pass(dir, { config: cfg, store, post: sink.post, source: "claude-live" });
    expect(result.sources[0].skippedTooLarge).toBe(1);
    expect(result.sources[0].imported).toBeGreaterThan(0);
    const state = JSON.parse(fs.readFileSync(stateFileFor(cfg.stateDir, "claude:laptop:big"), "utf8"));
    expect(state).toMatchObject({ deferred: true, lastFailure: { stage: "read", reason: "source above RUN_BACKLOG_MAX_FILE_BYTES" } });
  });

  it("resumes a pass killed between the put and the ingest without moving the cursor backwards", async () => {
    const dir = temp();
    claudeTree(dir, { session: "one", project: "a", mtime: NOW - 86_400_000 });
    const cfg = config(dir);
    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW, sources: ["claude-live"] });
    const store = fakeStore();
    let thrown = 0;
    const flaky = vi.fn(async (route, body) => {
      if (route === "/runs/ingest" && thrown === 0) { thrown += 1; throw new Error("killed mid-file"); }
      return route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true };
    });
    await pass(dir, { config: cfg, store, post: flaky, source: "claude-live" });
    const cursorFile = path.join(dir, "state", "backlog", "cursor.json");
    const firstCursor = JSON.parse(fs.readFileSync(cursorFile, "utf8"))["claude-live"];
    const first = JSON.parse(fs.readFileSync(stateFileFor(cfg.stateDir, "claude:laptop:one"), "utf8"));
    expect(first.deferred).toBe(true);
    expect(first.storeKey).toBeUndefined();

    const sink = recorder();
    await pass(dir, { config: cfg, store, post: sink.post, source: "claude-live" });
    const second = JSON.parse(fs.readFileSync(stateFileFor(cfg.stateDir, "claude:laptop:one"), "utf8"));
    expect(second.deferred).toBe(false);
    expect(second.storeKey).toMatch(/^runs\//);
    expect(JSON.parse(fs.readFileSync(cursorFile, "utf8"))["claude-live"]).toBeGreaterThanOrEqual(firstCursor);
  });
});

describe("rate and the time box", () => {
  it("spends a persisted hourly bucket and waits for the next window", async () => {
    const dir = temp();
    const filler = (n) => jsonl([claudeUserTurn({ text: "p".repeat(600) }), claudeUserTurn({ text: String(n) })]);
    for (const [index, session] of ["one", "two", "three"].entries()) {
      const projectDir = path.join(dir, "projects", session);
      fs.mkdirSync(projectDir, { recursive: true });
      const file = path.join(projectDir, `${session}.jsonl`);
      fs.writeFileSync(file, filler(index));
      const when = new Date(NOW - (index + 1) * 86_400_000);
      fs.utimesSync(file, when, when);
    }
    const cfg = config(dir, { backlog: { bytesPerHour: 1024 } });
    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW, sources: ["claude-live"] });
    const store = fakeStore(); const sink = recorder();

    const first = await pass(dir, { config: cfg, store, post: sink.post, source: "claude-live" });
    expect(first.sources[0].imported).toBe(1);
    expect(first.sources[0].pausedBy).toBe("budget");
    const budget = JSON.parse(fs.readFileSync(path.join(dir, "state", "backlog", "budget.json"), "utf8"));
    expect(budget.bytesUsed).toBeGreaterThan(500);

    const second = await pass(dir, { config: cfg, store, post: sink.post, source: "claude-live", now: () => NOW + 60_000 });
    expect(second.sources[0].imported).toBe(0);
    expect(second.sources[0].pausedBy).toBe("budget");

    const third = await pass(dir, { config: cfg, store, post: sink.post, source: "claude-live", now: () => NOW + 3_700_000 });
    expect(third.sources[0].imported).toBe(1);
  });

  it("stops a pass at its time box", async () => {
    const dir = temp();
    claudeTree(dir, { session: "one", project: "a", mtime: NOW - 86_400_000 });
    claudeTree(dir, { session: "two", project: "b", mtime: NOW - 2 * 86_400_000 });
    const cfg = config(dir, { backlog: { passMs: 10 } });
    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW, sources: ["claude-live"] });
    let tick = NOW;
    const store = fakeStore(); const sink = recorder();
    const result = await pass(dir, { config: cfg, store, post: sink.post, source: "claude-live", now: () => (tick += 20) });
    expect(result.sources[0].pausedBy).toBe("time");
    expect(result.sources[0].imported).toBe(0);
  });
});

describe("the pause conditions", () => {
  const setup = (dir, cfgOverrides = {}) => {
    claudeTree(dir);
    const cfg = config(dir, cfgOverrides);
    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW, sources: ["claude-live"] });
    return cfg;
  };

  it("reports low disk once, imports nothing, and re-arms when it clears", async () => {
    const dir = temp();
    const cfg = setup(dir);
    const small = Object.create(fs); small.statfsSync = () => ({ bavail: 1024, bsize: 1 });
    const store = fakeStore(); const sink = recorder();
    const first = await pass(dir, { config: cfg, fs: small, store, post: sink.post, source: "claude-live" });
    expect(first.started).toBe(true);
    expect(first.pausedBy).toBe("disk");
    expect(sink.ingests()).toHaveLength(0);
    expect(sink.keyed("/tts/job-failed").map((body) => body.key)).toEqual(["runs-backlog:disk"]);

    await pass(dir, { config: cfg, fs: small, store, post: sink.post, source: "claude-live" });
    expect(sink.keyed("/tts/job-failed").filter((body) => body.key === "runs-backlog:disk")).toHaveLength(1);

    await pass(dir, { config: cfg, store, post: sink.post, source: "claude-live" });
    expect(sink.keyed("/tts/job-ok").map((body) => body.key)).toContain("runs-backlog:disk");
  });

  it("refuses a local store unless RUN_BACKLOG_ALLOW_LOCAL_STORE is set", async () => {
    const dir = temp();
    const cfg = setup(dir, { storeConfig: { backend: "local", dir: path.join(dir, "objects") } });
    const store = fakeStore(); const sink = recorder();
    const paused = await pass(dir, { config: cfg, store, post: sink.post, source: "claude-live" });
    expect(paused.pausedBy).toBe("store-local");
    expect(sink.ingests()).toHaveLength(0);
    const reported = sink.keyed("/tts/job-failed").find((body) => body.key === "runs-backlog:store-local");
    expect(reported.error).toContain("RUN_STORE_ENDPOINT");
    expect(reported.error).not.toMatch(/=/);

    const allowed = { ...cfg, backlog: { ...cfg.backlog, allowLocalStore: true } };
    const ran = await pass(dir, { config: allowed, store, post: sink.post, source: "claude-live" });
    expect(ran.pausedBy).toBeNull();
    expect(sink.keyed("/tts/job-ok").map((body) => body.key)).toContain("runs-backlog:store-local");
  });

  it("stands aside while the sweeper's queue or dead letter holds anything", async () => {
    const dir = temp();
    const cfg = setup(dir);
    const queued = path.join(cfg.stateDir, "queue");
    fs.mkdirSync(queued, { recursive: true });
    fs.writeFileSync(path.join(queued, "pending.json"), "{}");
    const store = fakeStore(); const sink = recorder();
    const result = await pass(dir, { config: cfg, store, post: sink.post, source: "claude-live" });
    expect(result.pausedBy).toBe("queue-blocked");
    expect(sink.ingests()).toHaveLength(0);
    expect(sink.keyed("/tts/job-failed").map((body) => body.key)).toEqual(["runs-backlog:queue-blocked"]);
  });

  it("skips the tick entirely while the sweeper holds its lock", async () => {
    const dir = temp();
    const cfg = setup(dir);
    fs.writeFileSync(path.join(cfg.stateDir, "lock"), JSON.stringify({ pid: 1, startedAt: NOW }));
    const store = fakeStore(); const sink = recorder();
    const result = await pass(dir, { config: cfg, store, post: sink.post, source: "claude-live" });
    expect(result).toMatchObject({ started: true, pausedBy: "sweeper-lock" });
    // A live sweep is more important than an old one, and it is not a failure.
    expect(sink.calls).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, "state", "backlog", "cursor.json"))).toBe(false);
  });
});

describe("duplicates", () => {
  it("lets the live file win, stores the archive version anyway, and posts nothing for it", async () => {
    const dir = temp();
    const tree = claudeTree(dir);
    const cfg = config(dir);
    // The archive holds an EARLIER, shorter copy of the same thread.
    archiveTree(dir, {
      session: "session", date: "2026-08-30", host: "laptop", manifest: "laptop",
      files: { parent: { source: tree.parent, bytes: Buffer.from(jsonl(withSession(PARENT_ROWS.slice(0, 2), "session"))) } },
    });
    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW });
    const store = fakeStore(); const sink = recorder();
    const result = await pass(dir, { config: cfg, store, post: sink.post });

    const live = result.sources.find((entry) => entry.source === "claude-live");
    const archive = result.sources.find((entry) => entry.source === "archive");
    expect(live.imported).toBe(2);
    expect(archive.duplicates).toBe(1);
    expect(archive.imported).toBe(0);
    const posted = sink.ingests().filter((body) => body.run.runId === "claude:laptop:session");
    expect(posted).toHaveLength(1);
    expect(posted[0].run.file.path).toBe(tree.parent);
    // Both objects are in the store: the thread's prefix IS its version list.
    const versions = [...store.objects.keys()].filter((key) => key.startsWith("claude|laptop|session|"));
    expect(versions).toHaveLength(2);
    const archiveState = JSON.parse(fs.readFileSync(archiveStateFileFor(cfg.stateDir, "claude:laptop:session"), "utf8"));
    expect(archiveState.duplicateOfLive).toBe(true);
  });

  it("takes the larger version of an account split and says so once", async () => {
    const dir = temp();
    const cfg = config(dir);
    const small = Buffer.from(jsonl(withSession(PARENT_ROWS.slice(0, 2), "split")));
    const large = Buffer.from(jsonl(withSession([...PARENT_ROWS, claudeUserTurn({ text: "the wpi account saw more" })], "split")));
    archiveTree(dir, { session: "split", date: "2026-08-30", account: "gmail", files: { parent: { source: "/root/gmail.jsonl", bytes: small } } });
    archiveTree(dir, { session: "split", date: "2026-08-30", account: "wpi", files: { parent: { source: "/root/wpi.jsonl", bytes: large } } });
    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW, sources: ["archive"] });

    const listed = fs.readFileSync(listFileFor(cfg.stateDir, "archive"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(listed).toHaveLength(2);
    expect(listed.every((entry) => entry.accountSplit === true)).toBe(true);

    const store = fakeStore(); const sink = recorder();
    const result = await pass(dir, { config: cfg, store, post: sink.post, source: "archive" });
    expect(result.sources[0].accountSplits).toBe(2);
    const posted = sink.ingests().filter((body) => body.run.runId === "claude:box:split");
    // Both versions are stored; the run row ends up on the larger one.
    expect([...store.objects.keys()].filter((key) => key.startsWith("claude|box|split|"))).toHaveLength(2);
    expect(posted.at(-1).run.file.bytes).toBe(large.length);
    const splits = sink.events("runs-backlog-account-split");
    expect(splits).toHaveLength(1);
    expect(splits[0]).toMatchObject({ count: 2, runIds: ["claude:box:split"] });
  });
});

describe("the archive reader", () => {
  it("builds byte-identical rows and an identical digest per row from gz and from a plain file", async () => {
    const dir = temp();
    const tree = claudeTree(dir);
    const cfg = config(dir);
    const parentBytes = fs.readFileSync(tree.parent);
    const childBytes = fs.readFileSync(tree.child);
    const metaBytes = fs.readFileSync(tree.meta);
    const toolBytes = fs.readFileSync(tree.tool);
    // The archive's `source` IS the original local path, so the two paths agree
    // on everything a row carries, provenance included.
    archiveTree(dir, {
      session: "session", date: "2026-08-30", host: "laptop", manifest: "laptop",
      files: {
        parent: { source: tree.parent, bytes: parentBytes },
        child: { source: tree.child, agentId: "agent", bytes: childBytes },
        sidecar: { source: tree.meta, agentId: "agent", bytes: metaBytes },
        toolResults: [{ name: "output.txt", source: tree.tool, bytes: toolBytes }],
      },
    });
    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW });

    const store = fakeStore(); const sink = recorder();
    const live = await pass(dir, { config: cfg, store, post: sink.post, source: "claude-live" });
    expect(live.sources[0].imported).toBe(2);
    const fromLive = Object.fromEntries(sink.ingests().map((body) => [body.run.runId, body]));

    // A second state directory, so the archive import is a first import of the
    // same bytes rather than a duplicate of the live one.
    const second = config(dir, { stateDir: path.join(dir, "state-archive") });
    buildLists({ config: second, fs: bigDiskFs(), now: () => NOW, sources: ["archive"] });
    const archiveSink = recorder();
    const archiveResult = await pass(dir, { config: second, store, post: archiveSink.post, source: "archive" });
    expect(archiveResult.sources[0].imported).toBe(2);
    const fromArchive = Object.fromEntries(archiveSink.ingests().map((body) => [body.run.runId, body]));

    expect(Object.keys(fromArchive).sort()).toEqual(["claude:laptop:session", "claude:laptop:session/agent"]);
    for (const runId of Object.keys(fromArchive)) {
      expect(fromArchive[runId].run).toEqual(fromLive[runId].run);
      expect(fromArchive[runId].children).toEqual(fromLive[runId].children);
      expect(fromArchive[runId].run.file.storedHash).toBe(fromLive[runId].run.file.storedHash);
    }

    // And the rows a later materialize would build off each stored version are
    // byte-identical, digest for digest.
    const rowsOf = (source, stateDir) => {
      const cfgFor = source === "archive" ? second : cfg;
      const entries = fs.readFileSync(listFileFor(stateDir, source), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const rows = {};
      for (const entry of entries) {
        for (const unit of unitsOf(entry, { sessionsDir: cfgFor.backlog.sessionsDir })) {
          const bytes = unit.gz ? zlib.gunzipSync(fs.readFileSync(unit.gz)) : fs.readFileSync(unit.file);
          const stored = store.put({ runtime: unit.runtime, threadId: unit.threadId, host: unit.host, sourceBytes: bytes });
          let sidecarBytes = null; let sidecarStored = null;
          if (unit.kind === "subagent") {
            sidecarBytes = unit.sidecarGz ? zlib.gunzipSync(fs.readFileSync(unit.sidecarGz)) : fs.readFileSync(unit.sidecarFile);
            sidecarStored = store.put({ runtime: unit.runtime, threadId: unit.threadId, host: unit.host, sourceBytes: sidecarBytes, kind: "sidecar" });
          }
          const text = store.get({ runtime: unit.runtime, threadId: unit.threadId, host: unit.host, fileVersion: stored.fileVersion }).toString("utf8");
          rows[`${unit.runtime}:${unit.host}:${unit.threadId}`] = parseUnit(unit, { text, fileVersion: stored.fileVersion, sidecarBytes, sidecarStored, fs }).rows;
        }
      }
      return rows;
    };
    const liveRows = rowsOf("claude-live", cfg.stateDir);
    const archiveRows = rowsOf("archive", second.stateDir);
    expect(Object.keys(archiveRows).sort()).toEqual(Object.keys(liveRows).sort());
    for (const runId of Object.keys(liveRows)) {
      expect(JSON.stringify(archiveRows[runId])).toBe(JSON.stringify(liveRows[runId]));
      expect(archiveRows[runId].map((row) => row.digest)).toEqual(liveRows[runId].map((row) => row.digest));
      expect(archiveRows[runId].length).toBeGreaterThan(0);
    }
  });

  it("imports an orphan child on its own, from the agent id its file name proves", async () => {
    const dir = temp();
    const cfg = config(dir);
    const bytes = Buffer.from(jsonl(withSession(CHILD_ROWS, "lonely")));
    archiveTree(dir, {
      session: "lonely", date: "2026-08-29", host: "box",
      files: { child: { source: "/root/lonely/agent-x.jsonl", agentId: "x", bytes, orphan: true } },
    });
    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW, sources: ["archive"] });
    const store = fakeStore(); const sink = recorder();
    const result = await pass(dir, { config: cfg, store, post: sink.post, source: "archive" });
    expect(result.sources[0].imported).toBe(1);
    const body = sink.ingests()[0];
    // A stub parent is the designed state, in both directions.
    expect(body.run.runId).toBe("claude:box:lonely/x");
    expect(body.run.parentRunId).toBe("claude:box:lonely");
    expect(body.run.depth).toBe(1);
    expect(body.rows).toEqual([]);
    // With no sidecar the record still says what it could not read.
    const [unit] = unitsOf(JSON.parse(fs.readFileSync(listFileFor(cfg.stateDir, "archive"), "utf8").trim()), { sessionsDir: cfg.backlog.sessionsDir });
    const parsed = parseUnit(unit, { text: storeText(bytes), fileVersion: sha256(bytes) });
    expect(parsed.rows.some((row) => row.kind === "error" && String(row.content.error).includes("sidecar"))).toBe(true);
  });

  // The sweep and the import must agree about a Workflow's agent, or the same
  // run would land twice under two different ids. Both name it by its file and
  // take the workflow off the folder.
  it("imports a workflow's agent as a run of its own, workflow id and all", async () => {
    const dir = temp();
    const cfg = config(dir);
    const bytes = Buffer.from(jsonl(withSession(CHILD_ROWS, "wfs")));
    const thin = Buffer.from(JSON.stringify({ agentType: "workflow-subagent", spawnDepth: 2, model: "opus" }));
    archiveTree(dir, {
      session: "wfs", date: "2026-08-29", host: "box",
      files: {
        parent: { source: "/root/wfs.jsonl", bytes: Buffer.from(jsonl(withSession(PARENT_ROWS, "wfs"))) },
        nested: [
          { workflow: "wf_a", agentId: "one", source: "/root/one.jsonl", bytes, sidecar: { source: "/root/one.meta.json", bytes: thin } },
          { workflow: "wf_a", agentId: "two", source: "/root/two.jsonl", bytes },
        ],
        extras: [{ tail: "children/subagents/workflows/wf_a/journal.jsonl.gz", source: "/root/journal.jsonl", bytes: Buffer.from(JSON.stringify({ phase: 1 })) }],
      },
    });
    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW, sources: ["archive"] });
    const store = fakeStore(); const sink = recorder();
    const result = await pass(dir, { config: cfg, store, post: sink.post, source: "archive" });
    expect(result.sources[0].imported).toBe(3);
    const runs = Object.fromEntries(sink.ingests().map((body) => [body.run.runId, body.run]));
    expect(Object.keys(runs).sort()).toEqual(["claude:box:wfs", "claude:box:wfs/one", "claude:box:wfs/two"]);

    // A thin sidecar is the whole of what a workflow agent's meta.json holds:
    // its depth is believed, its parent is the session root, and the tool call
    // that spawned it stays unknown rather than synthesized.
    const withSidecar = runs["claude:box:wfs/one"];
    expect(withSidecar).toMatchObject({
      parentRunId: "claude:box:wfs", rootRunId: "claude:box:wfs",
      depth: 2, kind: "subagent", origin: "workflow", linkKnown: false,
    });
    expect(withSidecar.context.workflowId).toBe("wf_a");
    expect(withSidecar.spawnedByToolUseId).toBeUndefined();
    expect(withSidecar.attachments.map((item) => path.basename(item.file))).toEqual(["one.meta.json"]);

    // No sidecar at all: depth 1, the same default the sweep writes, and the
    // workflow id still comes off the folder.
    const noSidecar = runs["claude:box:wfs/two"];
    expect(noSidecar).toMatchObject({ depth: 1, origin: "workflow", linkKnown: false });
    expect(noSidecar.context.workflowId).toBe("wf_a");

    // The journal is not a transcript of anything, so it is a pointer on the
    // root and never a run.
    expect(runs["claude:box:wfs"].attachments.map((item) => path.basename(item.file))).toEqual(["journal.jsonl"]);
  });

  it("finds a live workflow agent in its nested folder and names it the same way", async () => {
    const dir = temp();
    const cfg = config(dir);
    const tree = claudeTree(dir, { session: "live", project: "proj", mtime: NOW - 3_600_000 });
    const folder = path.join(path.dirname(tree.child), "workflows", "wf_live");
    fs.mkdirSync(folder, { recursive: true });
    const nested = path.join(folder, "agent-deep.jsonl");
    fs.writeFileSync(nested, jsonl(withSession(CHILD_ROWS, "live")));
    fs.writeFileSync(path.join(folder, "journal.jsonl"), JSON.stringify({ phase: 1 }));
    fs.utimesSync(nested, new Date(NOW - 3_600_000), new Date(NOW - 3_600_000));
    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW, sources: ["claude-live"] });
    const store = fakeStore(); const sink = recorder();
    await pass(dir, { config: cfg, store, post: sink.post, source: "claude-live" });
    const runs = Object.fromEntries(sink.ingests().map((body) => [body.run.runId, body.run]));
    const deep = runs["claude:laptop:live/deep"];
    expect(deep).toMatchObject({ parentRunId: "claude:laptop:live", depth: 1, origin: "workflow", linkKnown: false });
    expect(deep.context.workflowId).toBe("wf_live");
    // The journal is the root's pointer here too, and no run of its own.
    expect(runs["claude:laptop:live"].attachments.map((item) => path.basename(item.file)).sort()).toEqual(["journal.jsonl", "output.txt"]);
  });
});

describe("nothing is ever removed", () => {
  it("sees no fs removal across a whole pass, failure and keyed report included", async () => {
    const dir = temp();
    claudeTree(dir, { session: "one", project: "a", mtime: NOW - 86_400_000 });
    claudeTree(dir, { session: "two", project: "b", mtime: NOW - 2 * 86_400_000 });
    const cfg = config(dir);
    const { fs: watched, spies } = spyingFs();
    buildLists({ config: cfg, fs: watched, now: () => NOW, sources: ["claude-live"] });
    const store = fakeStore();
    let failures = 0;
    const post = vi.fn(async (route, body) => {
      if (route === "/runs/ingest" && failures < 1) { failures += 1; throw new Error("one failure inside the pass"); }
      return route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true };
    });
    await pass(dir, { config: cfg, fs: watched, store, post, source: "claude-live", log: () => {} });
    // A second pass exercises the re-arm path, the lock release and the log.
    await pass(dir, { config: cfg, fs: watched, store, post, source: "claude-live", log: null });
    for (const name of REMOVERS) expect(spies[name]).not.toHaveBeenCalled();
  });
});

describe("status and dry run", () => {
  it("reports the same numbers without writing anything", async () => {
    const dir = temp();
    claudeTree(dir);
    const cfg = config(dir);
    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW, sources: ["claude-live"] });
    const before = fs.readdirSync(path.join(dir, "state", "backlog")).sort();
    const status = backlogStatus({ config: cfg, fs: bigDiskFs(), now: () => NOW });
    expect(status.sources.map((entry) => entry.source)).toEqual([...BACKLOG_SOURCES]);
    const live = status.sources.find((entry) => entry.source === "claude-live");
    expect(live).toMatchObject({ list: true, cursor: 0, entries: 2 });
    expect(live.builtMs).toBeGreaterThanOrEqual(0);
    expect(status.deletable).toEqual({ files: 0, bytes: 0 });
    expect(fs.readdirSync(path.join(dir, "state", "backlog")).sort()).toEqual(before);
  });

  it("parses and reports without touching the store, Convex or the state directory", async () => {
    const dir = temp();
    claudeTree(dir);
    const cfg = config(dir);
    buildLists({ config: cfg, fs: bigDiskFs(), now: () => NOW, sources: ["claude-live"] });
    const before = fs.readdirSync(path.join(dir, "state", "backlog")).sort();
    const store = fakeStore(); const sink = recorder();
    const result = await pass(dir, { config: cfg, store, post: sink.post, source: "claude-live", dryRun: true });
    expect(result.sources[0].imported).toBe(2);
    expect(store.put).not.toHaveBeenCalled();
    expect(sink.calls).toHaveLength(0);
    expect(fs.readdirSync(path.join(dir, "state", "backlog")).sort()).toEqual(before);
    expect(fs.existsSync(stateFileFor(cfg.stateDir, "claude:laptop:session"))).toBe(false);
  });

  it("refuses to start without a work list", async () => {
    const dir = temp();
    const result = await pass(dir, { store: fakeStore(), post: recorder().post });
    expect(result).toMatchObject({ started: false, reason: "no work list" });
  });
});
