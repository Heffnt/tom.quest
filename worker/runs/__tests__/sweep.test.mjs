import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { claudeAssistant, claudeLine, claudeToolUseBlock, claudeToolResult, claudeUserTurn, codexDeveloper, codexMeta, codexResponseItem, codexSkillsInstructions, codexTokenCount, codexToolCall, codexTurnContext, jsonl } from "./fixtures.mjs";
import { writeRegistrationClaim, writeRegistrationEnd } from "../registration.mjs";
import {
  MAX_ATTEMPTS,
  acquireSweepLock,
  deletable,
  drainQueue,
  prefixSha256,
  refreshClaudeHeaders,
  stateFileFor,
  storeText,
  sweepRunFile,
  sweepRuns,
} from "../sweep.mjs";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "runs-sweep-"));
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function store() {
  return {
    put: vi.fn(({ sourceBytes, kind = "transcript" }) => {
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
  it("recovers a legacy Codex cursor's identity from full context without losing its prior outcome", async () => {
    const dir = temp(); const project = path.join(dir, "codex", "project"); fs.mkdirSync(project, { recursive: true });
    const file = path.join(project, "rollout.jsonl");
    const prefix = jsonl([
      codexMeta({ id: "legacy-thread", cwd: "C:/work" }),
      codexTurnContext({ model: "gpt-5.6-terra" }),
      codexResponseItem("message", { role: "assistant", content: [{ output_text: "original answer" }] }),
      codexTokenCount({ input: 7, cachedInput: 0, cacheWrite: 0, output: 3, reasoning: 0, total: 10 }),
    ]);
    fs.writeFileSync(file, prefix);
    const stateDir = path.join(dir, "state");
    fs.mkdirSync(path.dirname(stateFileFor(stateDir, "codex:laptop:rollout")), { recursive: true });
    fs.writeFileSync(stateFileFor(stateDir, "codex:laptop:rollout"), JSON.stringify({
      runId: "codex:laptop:legacy-thread",
      path: file,
      committedLine: 4,
      committedPrefixSha256: prefixSha256(Buffer.from(prefix), 4),
      bytes: Buffer.byteLength(prefix),
      verified: true,
    }));
    fs.appendFileSync(file, jsonl([codexToolCall({ name: "read_file", args: {} })]));
    const stat = fs.statSync(file);
    const item = { runtime: "codex", host: "laptop", root: path.dirname(project), project: "project", threadId: "rollout", kind: "root", path: file, mtimeMs: stat.mtimeMs, bytes: stat.size };
    const ingests = [];
    await sweepRunFile(item, {
      stateDir,
      store: store(),
      post: async (route, body) => {
        if (route === "/runs/ingest") ingests.push(body);
        return route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true };
      },
      now: () => NOW,
    });
    expect(ingests).toHaveLength(1);
    expect(ingests[0].run).toMatchObject({
      runId: "codex:laptop:legacy-thread",
      model: "gpt-5.6-terra",
      context: { cwd: "C:/work" },
      outcome: { finalTextSeq: 3_000, totals: { totalTokens: 10 }, toolCalls: 1 },
    });
  });

  it("carries a Codex run's metadata through a second file part without session_meta", async () => {
    const dir = temp(); const project = path.join(dir, "codex", "project"); fs.mkdirSync(project, { recursive: true });
    const file = path.join(project, "rollout.jsonl");
    const catalog = codexSkillsInstructions({ roots: { r0: "C:/skills" }, skills: [{ name: "tom-write", file: "r0/tom-write/SKILL.md" }] });
    fs.writeFileSync(file, jsonl([
      codexMeta({ id: "child", parent: "parent", cwd: "C:/work", cliVersion: "0.153.3", git: { branch: "main", commit_hash: "a".repeat(40) }, baseInstructions: "original instructions" }),
      codexTurnContext({ model: "gpt-5.6-terra", effort: "xhigh" }),
      codexTokenCount({ modelContextWindow: 272_000 }),
      codexDeveloper(catalog),
    ]));
    let stat = fs.statSync(file);
    const item = { runtime: "codex", host: "laptop", root: path.dirname(project), project: "project", threadId: "rollout", kind: "root", path: file, mtimeMs: stat.mtimeMs, bytes: stat.size };
    const ingests = [];
    const post = async (route, body) => {
      if (route === "/runs/ingest") ingests.push(body);
      return route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true };
    };
    const stateDir = path.join(dir, "state");
    await sweepRunFile(item, { stateDir, store: store(), post, now: () => NOW });
    const first = ingests.at(-1).run;
    fs.appendFileSync(file, jsonl([codexToolCall({ args: { path: "C:/skills/tom-write/SKILL.md" } })]));
    stat = fs.statSync(file); item.mtimeMs = stat.mtimeMs; item.bytes = stat.size;
    await sweepRunFile(item, { stateDir, store: store(), post, now: () => NOW + 1 });
    const tail = ingests.at(-1).run;
    expect(tail).toMatchObject({
      runId: first.runId,
      parentRunId: first.parentRunId,
      rootRunId: first.rootRunId,
      model: "gpt-5.6-terra",
      sessionModel: "gpt-5.6-terra",
      runtimeVersion: "0.153.3",
      startedAt: first.startedAt,
      context: {
        cwd: "C:/work",
        gitBranch: "main",
        gitCommit: "a".repeat(40),
        baseInstructionsHash: first.context.baseInstructionsHash,
        contextWindow: 272_000,
        skillsOffered: ["tom-write"],
        skillsUsed: ["tom-write"],
      },
    });
    expect(tail.runId).not.toContain("unknown");
  });

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
    expect(ingest[0]).toMatchObject({ previousCommittedLine: 0, previousPrefixSha256: hash(Buffer.alloc(0)) });
    expect(ingest[1].previousCommittedLine).toBe(ingest[0].run.file.committedLine);
    expect(ingest[1].previousPrefixSha256).toBe(ingest[0].run.file.committedPrefixSha256);
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

  // witness: on 2026-09-18 the box's abandonment pass sent two finished daemon
  // sessions as `claude:box:unknown` with zero totals every two minutes, and
  // the record's refusals parked 728 pages in the dead letter.
  it("names a finished Claude run and keeps its totals on a pass with no new line", async () => {
    const dir = temp(); const stateDir = path.join(dir, "state");
    const item = runFile(dir, [
      claudeUserTurn({ text: "hello" }),
      claudeAssistant({ usage: { input_tokens: 5, output_tokens: 7 } }),
    ]);
    const ingests = [];
    const post = async (route, body) => {
      if (route === "/runs/ingest") ingests.push(body);
      return route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true };
    };
    await sweepRunFile(item, { stateDir, store: store(), post, now: () => NOW });
    const first = ingests.at(-1);
    await sweepRunFile(item, { stateDir, store: store(), post, now: () => NOW + 1, markAbandoned: true });
    const abandoned = ingests.at(-1);
    expect(ingests).toHaveLength(2);
    expect(abandoned.run).toMatchObject({
      runId: "claude:laptop:session",
      status: "abandoned",
      startedAt: first.run.startedAt,
      lastLineAt: first.run.lastLineAt,
      outcome: { totals: first.run.outcome.totals },
      file: { committedLine: 2 },
    });
    expect(first.run.outcome.totals.outputTokens).toBe(7);
    expect(abandoned.rows).toEqual([]);
    expect(abandoned.previousCommittedLine).toBe(2);
    expect(JSON.parse(fs.readFileSync(stateFileFor(stateDir, "claude:laptop:session"), "utf8")).reportedAbandoned).toBe(true);
  });

  // witness: on 2026-09-19 box runs the sweep sent in 4 to 14 pieces showed
  // only their last piece in the record — 174,166 tokens for a run whose file
  // holds 13,276,248 — because the record replaces the outcome with each page
  // and the header was read off the piece.
  it("sends a Claude run's totals, turns and tool calls over the whole file when it arrives in pieces", async () => {
    const dir = temp(); const stateDir = path.join(dir, "state");
    const item = runFile(dir, [
      claudeUserTurn({ text: "first" }),
      claudeAssistant({ requestId: "r1", blocks: [claudeToolUseBlock({ id: "t1" })], usage: { input_tokens: 5, output_tokens: 7 } }),
    ]);
    const ingests = [];
    const post = async (route, body) => {
      if (route === "/runs/ingest") ingests.push(body);
      return route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true };
    };
    await sweepRunFile(item, { stateDir, store: store(), post, now: () => NOW });
    fs.appendFileSync(item.path, jsonl([
      claudeUserTurn({ text: "second" }),
      claudeAssistant({ requestId: "r2", blocks: [claudeToolUseBlock({ id: "t2" })], usage: { input_tokens: 11, output_tokens: 13 } }),
    ]));
    const grown = { ...item, mtimeMs: fs.statSync(item.path).mtimeMs, bytes: fs.statSync(item.path).size };
    await sweepRunFile(grown, { stateDir, store: store(), post, now: () => NOW + 1 });
    const second = ingests.at(-1);
    expect(ingests).toHaveLength(2);
    expect(second.previousCommittedLine).toBe(2);
    expect(second.rows.every((row) => row.provenance.lineStart >= 2)).toBe(true);
    expect(second.run.outcome).toMatchObject({ totals: { inputTokens: 16, outputTokens: 20, totalTokens: 36 }, turns: 2, toolCalls: 2 });
    expect(second.run.file.committedLine).toBe(4);
  });

  it("re-sends an unmarked Claude run once with no rows and its whole file's totals, then leaves it alone", async () => {
    const dir = temp(); const stateDir = path.join(dir, "state");
    const item = runFile(dir, [
      claudeUserTurn({ text: "first" }),
      claudeAssistant({ requestId: "r1", usage: { input_tokens: 5, output_tokens: 7 } }),
      claudeUserTurn({ text: "second" }),
      claudeAssistant({ requestId: "r2", usage: { input_tokens: 11, output_tokens: 13 } }),
    ]);
    const ingests = [];
    const post = async (route, body) => {
      if (route === "/runs/ingest") ingests.push(body);
      return route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true };
    };
    await sweepRunFile(item, { stateDir, store: store(), post, now: () => NOW });
    // A state written before the fix carries no mark.
    const stateFile = stateFileFor(stateDir, "claude:laptop:session");
    const { wholeFileHeader: _mark, ...unmarked } = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    fs.writeFileSync(stateFile, JSON.stringify(unmarked));
    const cfg = config(dir, item);
    const first = await refreshClaudeHeaders({ config: cfg, store: store(), post, now: () => NOW + 1, log: () => {} });
    expect(first).toMatchObject({ refreshed: 1, failed: 0, left: 0 });
    const resent = ingests.at(-1);
    expect(resent.rows).toEqual([]);
    expect(resent.previousCommittedLine).toBe(4);
    expect(resent.run.outcome).toMatchObject({ totals: { inputTokens: 16, outputTokens: 20 }, turns: 2 });
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).wholeFileHeader).toBe(true);
    const second = await refreshClaudeHeaders({ config: cfg, store: store(), post, now: () => NOW + 2, log: () => {} });
    expect(second).toMatchObject({ refreshed: 0, left: 0 });
    expect(ingests).toHaveLength(2);
    // A backlog run is recorded at cursor 0 with no rows by design; the
    // refresh must not sweep its whole transcript in.
    fs.writeFileSync(stateFile, JSON.stringify({ ...unmarked, committedLine: 0, backlog: true }));
    const third = await refreshClaudeHeaders({ config: cfg, store: store(), post, now: () => NOW + 3, log: () => {} });
    expect(third).toMatchObject({ refreshed: 0, left: 0 });
    expect(ingests).toHaveLength(2);
  });

  it("counts a healed cursor as not refreshed, so the next batch sends that run's header", async () => {
    const dir = temp(); const stateDir = path.join(dir, "state");
    const item = runFile(dir, [claudeUserTurn({ text: "first" }), claudeUserTurn({ text: "second" })]);
    const ingests = [];
    const accept = async (route, body) => {
      if (route === "/runs/ingest") ingests.push(body);
      return route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true };
    };
    await sweepRunFile(item, { stateDir, store: store(), post: accept, now: () => NOW });
    const stateFile = stateFileFor(stateDir, "claude:laptop:session");
    const { wholeFileHeader: _mark, ...unmarked } = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    fs.writeFileSync(stateFile, JSON.stringify(unmarked));
    const cfg = config(dir, item);
    const held = { committedLine: 2, committedPrefixSha256: prefixSha256(fs.readFileSync(item.path), 2) };
    const heal = async (route) => (route === "/runs/ingest" ? { ok: false, reason: "file rewritten", ...held } : { ok: true });
    const first = await refreshClaudeHeaders({ config: cfg, store: store(), post: heal, now: () => NOW + 1, log: () => {} });
    expect(first).toMatchObject({ refreshed: 0, failed: 1 });
    const second = await refreshClaudeHeaders({ config: cfg, store: store(), post: accept, now: () => NOW + 2, log: () => {} });
    expect(second).toMatchObject({ refreshed: 1, failed: 0 });
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).wholeFileHeader).toBe(true);
  });

  it("leaves a run unmarked when the page that lands was queued by the older parser", async () => {
    const dir = temp(); const stateDir = path.join(dir, "state");
    const item = runFile(dir, [claudeUserTurn({ text: "first" })]);
    await sweepRunFile(item, { stateDir, store: store(), post: async (route) => { if (route === "/runs/ingest") throw Object.assign(new Error("down"), { status: 503 }); return { ok: true }; }, now: () => NOW });
    const queued = fs.readdirSync(path.join(stateDir, "queue")).map((name) => path.join(stateDir, "queue", name));
    expect(queued).toHaveLength(1);
    const { wholeFileHeader: _mark, ...older } = JSON.parse(fs.readFileSync(queued[0], "utf8"));
    fs.writeFileSync(queued[0], JSON.stringify(older));
    await drainQueue({ stateDir, post: async (route, body) => (route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true }), now: () => NOW + 1 });
    const state = JSON.parse(fs.readFileSync(stateFileFor(stateDir, "claude:laptop:session"), "utf8"));
    expect(state.committedLine).toBe(1);
    expect(state.wholeFileHeader).toBeUndefined();
  });

  it("caps a batch at its limit counting failures, and never retries a refused file", async () => {
    const dir = temp(); const stateDir = path.join(dir, "state");
    const item = runFile(dir, [claudeUserTurn({ text: "first" })]);
    const other = { ...item, threadId: "other", path: path.join(path.dirname(item.path), "other.jsonl") };
    fs.copyFileSync(item.path, other.path);
    const accept = async (route, body) => (route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true });
    await sweepRunFile(item, { stateDir, store: store(), post: accept, now: () => NOW });
    await sweepRunFile(other, { stateDir, store: store(), post: accept, now: () => NOW });
    for (const runId of ["claude:laptop:session", "claude:laptop:other"]) {
      const file = stateFileFor(stateDir, runId);
      const { wholeFileHeader: _mark, ...unmarked } = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify(unmarked));
    }
    const down = async (route) => { if (route === "/runs/ingest") throw Object.assign(new Error("down"), { status: 503 }); return { ok: true }; };
    const capped = await refreshClaudeHeaders({ config: config(dir, item), store: store(), post: down, limit: 1, now: () => NOW + 1, log: () => {} });
    expect(capped).toMatchObject({ refreshed: 0, failed: 1, left: 1 });
    const refusedFile = stateFileFor(stateDir, "claude:laptop:other");
    fs.writeFileSync(refusedFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(refusedFile, "utf8")), refused: { kind: "runs-file-rewritten" } }));
    fs.rmSync(path.join(stateDir, "queue"), { recursive: true, force: true });
    const next = await refreshClaudeHeaders({ config: config(dir, item), store: store(), post: accept, now: () => NOW + 2, log: () => {} });
    expect(next).toMatchObject({ refreshed: 1, failed: 0, refused: 1, left: 0 });
  });

  it("counts a run whose page is still queued as left, not done", async () => {
    const dir = temp(); const stateDir = path.join(dir, "state");
    const item = runFile(dir, [claudeUserTurn({ text: "first" })]);
    await sweepRunFile(item, { stateDir, store: store(), post: async (route, body) => (route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true }), now: () => NOW });
    const stateFile = stateFileFor(stateDir, "claude:laptop:session");
    const { wholeFileHeader: _mark, ...unmarked } = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    fs.writeFileSync(stateFile, JSON.stringify(unmarked));
    fs.mkdirSync(path.join(stateDir, "queue"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "queue", "1-page.json"), JSON.stringify({ runId: "claude:laptop:session", page: 0, pages: 1, payload: {} }));
    const posts = [];
    const result = await refreshClaudeHeaders({ config: config(dir, item), store: store(), post: async (route) => { posts.push(route); return { ok: true }; }, now: () => NOW + 1, log: () => {} });
    expect(result).toMatchObject({ refreshed: 0, left: 1 });
    expect(posts).not.toContain("/runs/ingest");
  });

  it("drops a dead-letter page that names no run and keeps the rest", async () => {
    const dir = temp(); const stateDir = path.join(dir, "state"); const deadDir = path.join(stateDir, "deadletter");
    fs.mkdirSync(deadDir, { recursive: true });
    const park = (name, runId) => fs.writeFileSync(path.join(deadDir, name), JSON.stringify({ runId, page: 0, pages: 1, payload: {} }));
    park("1-unnamed.json", "claude:box:unknown");
    park("2-unnamed-agent.json", "claude:box:0123456789abcdef/unknown");
    park("3-named.json", "codex:box:01a09445-f229-7b03-8665-b99b92707a07");
    const lines = [];
    const drained = await drainQueue({ stateDir, post: async () => ({ ok: true }), now: () => NOW, log: (line) => lines.push(line) });
    expect(fs.readdirSync(deadDir).sort()).toEqual(["3-named.json"]);
    expect(drained.pendingRunIds).toEqual(["codex:box:01a09445-f229-7b03-8665-b99b92707a07"]);
    expect(lines).toContain("runs-sweep deadletter dropped=2 reason=page names no run");
  });

  // witness: the laptop's full pass on 2026-09-17 re-swept three live sessions
  // from line 0 because their state files did not read, presented
  // previousCommittedLine 0 for files the record had already committed to
  // lines 1775, 1987 and 7858, and dead-lettered all 32 pages — which then
  // blocked those runs from every later pass. The files had only grown; the
  // record's refusal was right and the sweep's claim was false.
  it("stops a run whose state file exists and will not read, instead of re-ingesting it from line 0", async () => {
    const dir = temp(); const item = runFile(dir, manyLines(3)); const stateDir = path.join(dir, "state");
    fs.mkdirSync(path.dirname(stateFileFor(stateDir, "claude:laptop:session")), { recursive: true });
    fs.writeFileSync(stateFileFor(stateDir, "claude:laptop:session"), "{ half-written");
    const ingests = []; const lines = [];
    const cfg = config(dir, item); cfg.stateDir = stateDir;
    const result = await sweepRuns({
      config: cfg, file: item.path, store: store(), fs: largeDiskFs(), now: () => NOW, log: (line) => lines.push(line),
      post: async (route, body) => { if (route === "/runs/ingest") ingests.push(body); return { ok: true, committedLine: body?.run?.file?.committedLine }; },
    });
    expect(ingests).toEqual([]);
    expect(result.files).toBe(1);
    expect(lines.some((line) => line.includes("kept run=claude:laptop:session") && line.includes("could not be read"))).toBe(true);
  });

  it("adopts the cursor a rewrite refusal names when the file still hashes to it, and queues nothing", async () => {
    const dir = temp(); const item = runFile(dir, manyLines(3)); const stateDir = path.join(dir, "state");
    const held = { committedLine: 2, committedPrefixSha256: prefixSha256(fs.readFileSync(item.path), 2) };
    const result = await sweepRunFile(item, {
      stateDir, store: store(), now: () => NOW,
      post: async (route) => (route === "/runs/ingest" ? { ok: false, reason: "file rewritten", ...held } : { ok: true }),
    });
    expect(result).toMatchObject({ healed: 2 });
    expect(JSON.parse(fs.readFileSync(stateFileFor(stateDir, "claude:laptop:session"), "utf8")))
      .toMatchObject({ committedLine: 2, committedPrefixSha256: held.committedPrefixSha256, verified: false, deferred: false });
    expect(fs.existsSync(path.join(stateDir, "deadletter"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "queue")) ? fs.readdirSync(path.join(stateDir, "queue")).filter((name) => name.endsWith(".json")) : []).toHaveLength(0);

    // And the adopted cursor is what the next pass appends from.
    const ingests = [];
    await sweepRunFile(item, {
      stateDir, store: store(), now: () => NOW + 1,
      post: async (route, body) => { if (route === "/runs/ingest") ingests.push(body); return { ok: true, committedLine: body.run.file.committedLine }; },
    });
    expect(ingests[0]).toMatchObject({ previousCommittedLine: 2, previousPrefixSha256: held.committedPrefixSha256 });
  });

  it("dead-letters a rewrite the file does not hash to, and the dead letter names the record's reason", async () => {
    const dir = temp(); const item = runFile(dir, manyLines(3)); const stateDir = path.join(dir, "state");
    const result = await sweepRunFile(item, {
      stateDir, store: store(), now: () => NOW,
      post: async (route) => (route === "/runs/ingest" ? { ok: false, reason: "file rewritten", committedLine: 2, committedPrefixSha256: "f".repeat(64) } : { ok: true }),
    });
    expect(result).toMatchObject({ dead: 1, permanent: true });
    const [name] = fs.readdirSync(path.join(stateDir, "deadletter")).filter((entry) => entry.endsWith(".json"));
    // "HTTP 400" was this sweep's own invention for a 200 that said ok:false.
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, "deadletter", name), "utf8")).lastError).toBe("refused: file rewritten");
  });

  it("heals a queued page the record refuses against a cursor the file still matches, and clears the run", async () => {
    const dir = temp(); const item = runFile(dir, manyLines(201)); const stateDir = path.join(dir, "state");
    await sweepRunFile(item, { stateDir, store: store(), now: () => NOW, post: async (route) => { if (route === "/runs/ingest") throw new Error("offline"); return { ok: true }; } });
    expect(fs.readdirSync(path.join(stateDir, "queue")).filter((name) => name.endsWith(".json"))).toHaveLength(2);
    const held = { committedLine: 150, committedPrefixSha256: prefixSha256(fs.readFileSync(item.path), 150) };
    const drained = await drainQueue({
      stateDir, now: () => NOW + 1,
      post: async (route) => (route === "/runs/ingest" ? { ok: false, reason: "file rewritten", ...held } : { ok: true }),
    });
    expect(drained).toMatchObject({ healed: 2, dead: 0, delivered: 0, pendingRunIds: [] });
    expect(JSON.parse(fs.readFileSync(stateFileFor(stateDir, "claude:laptop:session"), "utf8")).committedLine).toBe(150);
    expect(fs.readdirSync(path.join(stateDir, "queue")).filter((name) => name.endsWith(".json"))).toHaveLength(0);
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

  // Convex refuses a chunk before its run and a stamp before its message row,
  // so the page has to land first and the row has to arrive unstamped.
  it("sends the ingest page, then its chunks, then the stamp", async () => {
    const dir = temp(); const item = runFile(dir, [claudeToolResult({ content: "x".repeat(40_000) })]); const routes = []; let page = null;
    await sweepRunFile(item, { stateDir: path.join(dir, "state"), store: store(), post: async (route, body) => {
      routes.push(route);
      if (route !== "/runs/ingest") return { ok: true };
      page = body;
      return { ok: true, committedLine: body.run.file.committedLine };
    }, now: () => NOW });
    expect(routes[0]).toBe("/runs/ingest");
    expect(routes.at(-1)).toBe("/runs/overflow/stamp");
    expect(routes.slice(1, -1).every((route) => route === "/runs/overflow")).toBe(true);
    expect(page.rows.some((row) => row.overflow !== undefined)).toBe(false);
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

  // witness: the refusal read `importedBy`, which nothing writes, so a
  // backlog-imported file (the only copy of a transcript the record has no
  // rows for) was never refused (run a372dfa4).
  it("refuses to delete a backlog-imported file and allows an ordinary uploaded one", () => {
    const uploaded = { verified: true, endSeen: true, gitTracked: false };
    const laptopSession = { host: "laptop", kind: "session" };
    expect(deletable(laptopSession, uploaded, { now: NOW })).toEqual({ ok: true, reason: "eligible" });
    expect(deletable(laptopSession, { ...uploaded, backlog: true }, { now: NOW })).toEqual({ ok: false, reason: "backlog" });
  });

  // witness: the fourth audit of PR #207 — the abandonment pass rebuilt the
  // state entry from scratch and dropped the marker, so the next check
  // allowed the deletion.
  it("keeps the backlog marker when a pass rewrites the file's state", async () => {
    const dir = temp(); const stateDir = path.join(dir, "state");
    const item = runFile(dir, [claudeUserTurn({ text: "hello" })]);
    const post = async (route, body) => route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true };
    await sweepRunFile(item, { stateDir, store: store(), post, now: () => NOW });
    const stateFile = stateFileFor(stateDir, "claude:laptop:session");
    fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stateFile, "utf8")), backlog: true }));
    await sweepRunFile(item, { stateDir, store: store(), post, now: () => NOW + 1, markAbandoned: true });
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(state).toMatchObject({ reportedAbandoned: true, backlog: true });
    expect(deletable({ host: "laptop", kind: "session" }, { ...state, gitTracked: false }, { now: NOW + 1 })).toEqual({ ok: false, reason: "backlog" });
  });

  it("keeps only stale claim pointers with a readable live target envelope", async () => {
    const dir = temp(); const item = runFile(dir); const cfg = config(dir, item);
    const registrationDir = path.join(cfg.stateDir, "registration");
    const old = new Date(NOW - 2 * 24 * 60 * 60_000);
    const pointer = (name, runFile) => {
      const file = path.join(registrationDir, `${name}.claimed.json`);
      fs.mkdirSync(registrationDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ runFile }));
      fs.utimesSync(file, old, old);
      return file;
    };
    const liveRun = path.join(dir, "live.jsonl");
    writeRegistrationClaim({ runFile: liveRun, registration: { host: "laptop" }, now: () => 1 });
    const endedRun = path.join(dir, "ended.jsonl");
    writeRegistrationClaim({ runFile: endedRun, registration: { host: "laptop" }, now: () => 1 });
    writeRegistrationEnd({ runFile: endedRun, now: () => 2 });
    const corruptRun = path.join(dir, "corrupt.jsonl");
    fs.writeFileSync(corruptRun.replace(/\.jsonl$/, ".registration.json"), "not json");
    const live = pointer("live", liveRun);
    const ended = pointer("ended", endedRun);
    const missing = pointer("missing", path.join(dir, "missing.jsonl"));
    const corrupt = pointer("corrupt", corruptRun);

    const result = await sweepRuns({
      config: cfg,
      file: item.path,
      store: store(),
      post: async (route, body) => route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true },
      fs: largeDiskFs(), now: () => NOW, log: () => {},
    });

    expect(result.staleSpool).toBe(3);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(ended)).toBe(false);
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.existsSync(corrupt)).toBe(false);
  });

  // The store is the only durable copy of a run and it holds redacted text, so
  // a run rebuilt from its store object has to present the same cursor proof
  // the sweep recorded. That is only true if both sides hash the same bytes.
  it("computes the committed prefix over the store's redacted bytes, not the disk's", async () => {
    const token = `ghp_${"a".repeat(36)}`;
    const rows = [claudeUserTurn({ text: `run this: gh auth login --with-token ${token}` }), claudeUserTurn({ text: "done" })];
    const raw = Buffer.from(jsonl(rows));
    const redacted = Buffer.from(storeText(raw), "utf8");
    expect(redacted.includes(token)).toBe(false);
    // The proof: the local bytes and the store's bytes name one hash, and it
    // is not the hash of the unredacted prefix.
    for (const line of [0, 1, 2]) expect(prefixSha256(raw, line)).toBe(prefixSha256(redacted, line));
    const rawPrefix = `${raw.toString("utf8").split("\n").slice(0, 1).join("\n")}\n`;
    expect(prefixSha256(raw, 1)).not.toBe(hash(Buffer.from(rawPrefix)));

    // And end to end: what the sweep posts is what a later reader of the store
    // object would compute for the same line.
    const dir = temp();
    const project = path.join(dir, "claude", "project");
    fs.mkdirSync(project, { recursive: true });
    const file = path.join(project, "session.jsonl");
    fs.writeFileSync(file, raw);
    const stat = fs.statSync(file);
    const item = { runtime: "claude", host: "laptop", root: path.dirname(project), project: "project", threadId: "session", kind: "root", path: file, mtimeMs: stat.mtimeMs, bytes: stat.size };
    const posts = [];
    await sweepRuns({
      config: config(dir, item),
      file: item.path,
      store: store(),
      post: async (route, body) => { posts.push([route, body]); return route === "/runs/ingest" ? { ok: true, committedLine: body.run.file.committedLine } : { ok: true }; },
      fs: largeDiskFs(),
      now: () => NOW,
      log: () => {},
    });
    const ingest = posts.filter(([route]) => route === "/runs/ingest").map(([, body]) => body);
    expect(ingest).toHaveLength(1);
    expect(ingest[0].run.file.committedPrefixSha256).toBe(prefixSha256(redacted, ingest[0].run.file.committedLine));
    expect(JSON.stringify(ingest[0].rows)).not.toContain(token);
  });

  it("sweeps a Workflow's agent out of its nested folder as an ordinary child", async () => {
    const dir = temp(); const item = runFile(dir);
    const folder = path.join(dir, "claude", "project", "session", "subagents", "workflows", "wf_abc");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "agent-W.jsonl"), jsonl([claudeUserTurn({ text: "phase one" })]));
    fs.writeFileSync(path.join(folder, "agent-W.meta.json"), JSON.stringify({ agentType: "workflow-subagent", spawnDepth: 1 }));
    fs.writeFileSync(path.join(folder, "journal.jsonl"), jsonl([{ phase: 1 }]));
    const cfg = config(dir, item); cfg.flags.backlog = true;
    const ingest = [];
    const post = async (route, body) => {
      if (route !== "/runs/ingest") return { ok: true };
      ingest.push(body);
      return { ok: true, committedLine: body.run.file.committedLine };
    };
    const result = await sweepRuns({ config: cfg, store: store(), post, fs: largeDiskFs(), now: () => NOW, log: () => {} });
    expect(result.ingested).toBe(2);
    const workflow = ingest.find((body) => body.run.runId === "claude:laptop:session/W");
    expect(workflow.run).toMatchObject({ parentRunId: "claude:laptop:session", rootRunId: "claude:laptop:session", depth: 1, kind: "subagent", origin: "workflow", linkKnown: false });
    expect(workflow.run.context.workflowId).toBe("wf_abc");
    expect(workflow.run.attachments.map((a) => path.basename(a.file))).toEqual(["agent-W.meta.json"]);
    // The journal beside it is not a run, and the root keeps it as a pointer.
    expect(ingest.some((body) => body.run.runId.endsWith("/journal"))).toBe(false);
    const root = ingest.find((body) => body.run.runId === "claude:laptop:session");
    expect(root.run.attachments.map((a) => path.basename(a.file))).toContain("journal.jsonl");
  });

  it("allows one lock holder and replaces only a stale lock", () => {
    const dir = temp(); const stateDir = path.join(dir, "state");
    const first = acquireSweepLock(stateDir, { now: () => NOW });
    expect(first.acquired).toBe(true);
    expect(acquireSweepLock(stateDir, { now: () => NOW + 1 }).acquired).toBe(false);
    expect(acquireSweepLock(stateDir, { now: () => NOW + 16 * 60_000 }).staleBroken).toBe(true);
  });

  // The exclusive create and the pid write are two steps. A process killed
  // between them, or a write that failed for want of disk, leaves a lock with
  // no startedAt to read. On the box that file wedged the sweep for twenty-two
  // hours, because the staleness rule read only the contents.
  it("breaks a lock whose contents cannot be read, once it is old enough", () => {
    const dir = temp(); const stateDir = path.join(dir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const file = path.join(stateDir, "lock");
    fs.writeFileSync(file, "");
    const old = new Date(NOW);
    fs.utimesSync(file, old, old);
    expect(acquireSweepLock(stateDir, { now: () => NOW + 60_000 }).acquired).toBe(false);
    const broken = acquireSweepLock(stateDir, { now: () => NOW + 16 * 60_000 });
    expect(broken.staleBroken).toBe(true);
    expect(broken.acquired).toBe(true);
    broken.release();
    expect(fs.existsSync(file)).toBe(false);
  });
});
