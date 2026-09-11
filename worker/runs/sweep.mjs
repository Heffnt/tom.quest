#!/usr/bin/env node
// sweep.mjs — the one path from changed CLI files to the run record.
//
// Files are handled serially in the durable order local bytes → verified
// store object → Convex. Every side effect is injectable so an outage test can
// exercise the real cursor and queue without a network or a production file.

import crypto from "node:crypto";
import fsDefault from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { isPermanentStatus } from "../session-host/overflow.mjs";
import { parseClaudeFile, parseCodexFile } from "./ingest.mjs";
import { runConfig } from "./config.mjs";
import { describeRunFile, discoverRunFiles } from "./discover.mjs";
import { findCodexRegistration, mergeRegistration, readRegistration } from "./registration.mjs";
import { openStore } from "./store.mjs";

export const MAX_ATTEMPTS = 8;
export const STALE_LOCK_MS = 15 * 60_000;
export const ABANDONED_MS = 24 * 60 * 60_000;
export const SPOOL_MAX_AGE_MS = 24 * 60 * 60_000;
export const LOW_DISK_BYTES = 10 * 1024 ** 3;
const LOG_MAX_BYTES = 16 * 1024 ** 2;

const sha1 = (value) => crypto.createHash("sha1").update(value).digest("hex");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// worker/session-host/lib.mjs is a text symlink on Windows checkouts, so the
// laptop cannot import its backoff helper. Keep the same formula here; tests
// inject deterministic delays and the stored nextAt is the durable contract.
export function sweepBackoffMs(attempt, random = Math.random) {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
  return Math.round(base * (0.75 + random() * 0.5));
}

function atomicJson(file, value, fs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function readJson(file, fs) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function runIdOf(item) {
  return `${item.runtime}:${item.host}:${item.threadId}`;
}

export function stateFileFor(stateDir, runId) {
  return path.join(stateDir, "state", `${sha1(runId)}.json`);
}

function readState(stateDir, runId, fs) {
  return readJson(stateFileFor(stateDir, runId), fs);
}

function writeState(stateDir, runId, value, fs) {
  atomicJson(stateFileFor(stateDir, runId), value, fs);
}

function completeLines(bytes) {
  const text = bytes.toString("utf8");
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  else lines.pop();
  return lines;
}

export function prefixSha256(bytes, committedLine) {
  const lines = completeLines(bytes);
  const prefix = committedLine === 0 ? "" : `${lines.slice(0, committedLine).join("\n")}\n`;
  return sha256(Buffer.from(prefix));
}

export function acquireSweepLock(stateDir, { fs = fsDefault, now = Date.now } = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, "lock");
  const take = () => {
    const handle = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: now() }));
    fs.closeSync(handle);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { fs.unlinkSync(file); } catch {}
    };
  };
  try { return { acquired: true, release: take(), staleBroken: false }; }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const landed = readJson(file, fs);
    if (Number.isFinite(landed?.startedAt) && now() - landed.startedAt > STALE_LOCK_MS) {
      try { fs.unlinkSync(file); } catch {}
      try { return { acquired: true, release: take(), staleBroken: true }; }
      catch (retry) { if (retry?.code !== "EEXIST") throw retry; }
    }
    return { acquired: false, release: () => {}, staleBroken: false };
  }
}

function queueName(item) {
  return `${String(item.createdAt).padStart(13, "0")}-${encodeURIComponent(item.runId)}-${String(item.page).padStart(6, "0")}.json`;
}

function queueFiles(stateDir, fs) {
  const dir = path.join(stateDir, "queue");
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => path.join(dir, name));
  } catch { return []; }
}

function deadLetterRunIds(stateDir, fs) {
  const dir = path.join(stateDir, "deadletter");
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson(path.join(dir, name), fs)?.runId)
      .filter(Boolean);
  } catch { return []; }
}

function queueItem(stateDir, item, fs) {
  const dir = path.join(stateDir, "queue");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, queueName(item));
  if (!fs.existsSync(file)) atomicJson(file, item, fs);
  return file;
}

async function deliver(item, post) {
  for (const overflow of item.overflows ?? []) {
    for (let index = 0; index < overflow.chunks.length; index += 1) {
      await post("/runs/overflow", { runId: item.runId, seq: overflow.seq, index, chunkCount: overflow.chunks.length, text: overflow.chunks[index] });
    }
    await post("/runs/overflow/stamp", { runId: item.runId, seq: overflow.seq, sha256: overflow.sha256, byteLength: overflow.byteLength, chunkCount: overflow.chunks.length });
  }
  const response = await post("/runs/ingest", item.payload);
  if (response?.ok === false) throw Object.assign(new Error(`run ingest refused: ${response.reason ?? "unknown"}`), { status: 400 });
  return response;
}

function stateAfterDelivery(item, response, now) {
  const run = item.payload.run;
  const committedLine = Number.isInteger(response?.committedLine) ? response.committedLine : run.file.committedLine;
  const committedPrefixSha256 = item.cursorProofs?.[String(committedLine)];
  if (!committedPrefixSha256) throw new Error("Convex returned a cursor without an uploaded prefix proof");
  return {
    runId: item.runId,
    path: run.file.path,
    committedLine,
    committedPrefixSha256,
    sourceHash: run.file.sourceHash,
    bytes: run.file.bytes,
    storedHash: run.file.storedHash,
    storeKey: run.file.storeKey,
    verified: true,
    lastLineAt: run.lastLineAt,
    lastSweptAt: now(),
    deferred: false,
    endSeen: item.endSeen,
    reportedAbandoned: item.markAbandoned || false,
    envelopeMtimeMs: item.envelopeMtimeMs ?? 0,
  };
}

async function reportDeadLetter(stateDir, post, fs) {
  const marker = path.join(stateDir, "deadletter", ".reported");
  if (fs.existsSync(marker)) return;
  await post("/tts/job-failed", { job: "runs-sweep", key: "runs-sweep:deadletter", error: "A run ingest reached the dead-letter queue after repeated failures." });
  fs.writeFileSync(marker, String(Date.now()), { mode: 0o600 });
}

async function recoverDeadLetterReport(stateDir, post, fs) {
  const dir = path.join(stateDir, "deadletter");
  const marker = path.join(dir, ".reported");
  let files = [];
  try { files = fs.readdirSync(dir).filter((name) => name.endsWith(".json")); } catch {}
  if (files.length === 0 && fs.existsSync(marker)) {
    await post("/tts/job-ok", { job: "runs-sweep", key: "runs-sweep:deadletter" });
    try { fs.unlinkSync(marker); } catch {}
  }
}

async function deadLetter(file, item, { stateDir, post, fs }) {
  const dir = path.join(stateDir, "deadletter");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, path.basename(file));
  atomicJson(file, item, fs);
  fs.renameSync(file, target);
  await reportDeadLetter(stateDir, post, fs);
}

export async function drainQueue({
  stateDir,
  post,
  fs = fsDefault,
  now = Date.now,
  backoffMs = sweepBackoffMs,
  log = () => {},
} = {}) {
  await recoverDeadLetterReport(stateDir, post, fs);
  const items = queueFiles(stateDir, fs).map((file) => ({ file, item: readJson(file, fs) })).filter(({ item }) => item?.runId && item?.payload);
  items.sort((a, b) => a.item.createdAt - b.item.createdAt || (a.item.runId === b.item.runId ? a.item.page - b.item.page : a.item.runId.localeCompare(b.item.runId)));
  const blocked = new Set();
  const movedToDead = new Set();
  let delivered = 0, kept = 0, dead = 0;
  for (const entry of items) {
    const { file, item } = entry;
    if (movedToDead.has(file)) continue;
    if (blocked.has(item.runId) || item.nextAt > now()) { blocked.add(item.runId); kept += 1; continue; }
    try {
      const response = await deliver(item, post);
      if (item.page === item.pages - 1) writeState(stateDir, item.runId, stateAfterDelivery(item, response, now), fs);
      fs.unlinkSync(file);
      delivered += 1;
    } catch (error) {
      const permanent = isPermanentStatus(error?.status);
      item.attempts = permanent ? MAX_ATTEMPTS : Number(item.attempts ?? 0) + 1;
      item.lastError = typeof error?.status === "number" ? `HTTP ${error.status}` : "network error";
      if (item.attempts >= MAX_ATTEMPTS) {
        await deadLetter(file, item, { stateDir, post, fs });
        dead += 1;
        for (const later of items) {
          if (later.item.runId !== item.runId || later.item.page <= item.page || movedToDead.has(later.file) || !fs.existsSync(later.file)) continue;
          later.item.attempts = MAX_ATTEMPTS;
          later.item.lastError = `blocked by dead-letter page ${item.page}`;
          await deadLetter(later.file, later.item, { stateDir, post, fs });
          movedToDead.add(later.file);
          dead += 1;
        }
      } else {
        item.nextAt = now() + backoffMs(item.attempts - 1);
        atomicJson(file, item, fs);
        kept += 1;
      }
      blocked.add(item.runId);
      log(`runs-sweep queue kept run=${item.runId} page=${item.page} attempts=${item.attempts}`);
    }
  }
  const pendingRunIds = [...new Set([
    ...queueFiles(stateDir, fs).map((file) => readJson(file, fs)?.runId).filter(Boolean),
    ...deadLetterRunIds(stateDir, fs),
  ])];
  return { files: items.length, delivered, kept, dead, pendingRunIds };
}

function envelopeMtime(runFile, fs) {
  try { return fs.statSync(runFile.replace(/\.jsonl$/i, ".registration.json")).mtimeMs; }
  catch { return 0; }
}

function splitOverflow(rows) {
  const overflows = [];
  const wireRows = rows.map((row) => {
    if (!row.overflow?.chunks) return row;
    const chunks = row.overflow.chunks;
    overflows.push({ seq: row.seq, sha256: row.overflow.sha256, byteLength: row.overflow.byteLength, chunks });
    return { ...row, overflow: { sha256: row.overflow.sha256, byteLength: row.overflow.byteLength, chunkCount: row.overflow.chunkCount } };
  });
  return { rows: wireRows, overflows };
}

function agentMeta(item, fs) {
  if (item.kind !== "subagent") return null;
  const metaFile = item.path.replace(/\.jsonl$/i, ".meta.json");
  try { return { ...JSON.parse(fs.readFileSync(metaFile, "utf8")), agentId: item.threadId.split("/").at(-1) }; }
  catch { return { agentId: item.threadId.split("/").at(-1), spawnDepth: 1 }; }
}

async function eventPost(post, event) {
  if (event) await post("/tts/event", event);
}

function queuePages({ merged, overflows, endSeen, envelopeMtimeMs, sourceBytes, priorState, now }) {
  const pages = Math.max(1, Math.ceil(merged.rows.length / 200));
  const createdAt = now();
  const boundaries = [];
  for (let page = 0; page < pages; page += 1) {
    const rows = merged.rows.slice(page * 200, (page + 1) * 200);
    boundaries.push(page === pages - 1 ? merged.run.file.committedLine : Math.max(...rows.map((row) => row.provenance.lineEnd + 1), priorState?.committedLine ?? 0));
  }
  const cursorProofs = Object.fromEntries([
    ["0", prefixSha256(sourceBytes, 0)],
    ...(priorState ? [[String(priorState.committedLine), priorState.committedPrefixSha256]] : []),
    ...boundaries.map((line) => [String(line), prefixSha256(sourceBytes, line)]),
  ]);
  return Array.from({ length: pages }, (_, page) => {
    const rows = merged.rows.slice(page * 200, (page + 1) * 200);
    const seqs = new Set(rows.map((row) => row.seq));
    const previousCommittedLine = page === 0 ? priorState?.committedLine ?? 0 : boundaries[page - 1];
    const run = structuredClone(merged.run);
    run.file.committedLine = boundaries[page];
    run.file.committedPrefixSha256 = cursorProofs[String(boundaries[page])];
    return {
      attempts: 0,
      nextAt: 0,
      createdAt,
      runId: merged.run.runId,
      page,
      pages,
      endSeen,
      envelopeMtimeMs,
      cursorProofs,
      payload: {
        run,
        rows,
        children: merged.children,
        previousCommittedLine,
        previousCommittedPrefixSha256: cursorProofs[String(previousCommittedLine)],
      },
      overflows: overflows.filter((overflow) => seqs.has(overflow.seq)),
    };
  });
}

async function parseAndStore(item, { stateDir, store, fs, post, now, markAbandoned = false, onStoreVerified = () => {} }) {
  const sourceBytes = fs.readFileSync(item.path);
  const stored = await store.put({ runtime: item.runtime, threadId: item.threadId, host: item.host, sourceBytes });
  if (!stored.verified || !stored.key) throw new Error("run store upload was not verified");
  await onStoreVerified();
  let envelope = readRegistration(item.path, { fs });
  if (!envelope && item.runtime === "codex") {
    findCodexRegistration({ text: sourceBytes.toString("utf8"), spoolDir: path.join(stateDir, "registration"), runFile: item.path, claim: { threadId: item.threadId, runFile: item.path }, fs, now });
    envelope = readRegistration(item.path, { fs });
  }
  let envelopeStored = null;
  if (envelope) {
    envelopeStored = await store.put({ runtime: item.runtime, threadId: item.threadId, host: item.host, sourceBytes: Buffer.from(JSON.stringify(envelope)), kind: "registration" });
    if (!envelopeStored.verified || !envelopeStored.key) throw new Error("run envelope upload was not verified");
  }
  const previous = readState(stateDir, runIdOf(item), fs);
  const fromLine = previous?.deferred ? 0 : previous?.committedLine ?? 0;
  const common = { path: item.path, text: sourceBytes.toString("utf8"), host: item.host, fileVersion: stored.fileVersion, fromLine };
  const parsed = item.runtime === "claude"
    ? parseClaudeFile({ ...common, agentMeta: agentMeta(item, fs), parentSessionId: item.kind === "subagent" ? item.threadId.split("/")[0] : null })
    : parseCodexFile(common);
  Object.assign(parsed.run.file, { sourceHash: stored.sourceHash, storedHash: stored.storedHash, bytes: stored.bytes, storedBytes: stored.storedBytes, storeKey: stored.key, committedLine: parsed.lastLine });
  const merged = mergeRegistration({ parsed, envelope, host: item.host });
  if (envelopeStored && merged.envelopeApplied) merged.run.envelopeKey = envelopeStored.key;
  if (markAbandoned) {
    merged.run.status = "abandoned";
    merged.run.abandonedAt = now();
  }
  await eventPost(post, merged.event);
  const split = splitOverflow(merged.rows);
  merged.rows = split.rows;
  return { merged, overflows: split.overflows, endSeen: Boolean(envelope?.end && merged.envelopeApplied), sourceBytes };
}

async function refuseChangedFile(item, state, sourceBytes, { stateDir, post, fs, now, kind }) {
  await post("/tts/event", { kind, data: { runId: runIdOf(item), storedBytes: state.bytes, presentedBytes: sourceBytes.length } });
  writeState(stateDir, runIdOf(item), { ...state, lastSweptAt: now(), refused: { kind, bytes: sourceBytes.length, mtimeMs: item.mtimeMs } }, fs);
  return { refused: kind };
}

export async function sweepRunFile(item, {
  stateDir,
  store,
  post,
  fs = fsDefault,
  now = Date.now,
  markAbandoned = false,
  onStoreVerified,
} = {}) {
  const runId = runIdOf(item);
  const state = readState(stateDir, runId, fs);
  const sourceBytes = fs.readFileSync(item.path);
  if (state?.refused?.bytes === sourceBytes.length && state.refused.mtimeMs === item.mtimeMs) return { skipped: "refused" };
  if (state && sourceBytes.length < state.bytes) return refuseChangedFile(item, state, sourceBytes, { stateDir, post, fs, now, kind: "runs-file-shrank" });
  if (state?.committedLine > 0 && prefixSha256(sourceBytes, state.committedLine) !== state.committedPrefixSha256) {
    return refuseChangedFile(item, state, sourceBytes, { stateDir, post, fs, now, kind: "runs-file-rewritten" });
  }
  const registrationMtime = envelopeMtime(item.path, fs);
  if (!markAbandoned && state && !state.deferred
    && sourceBytes.length === state.bytes
    && state.committedLine === completeLines(sourceBytes).length
    && registrationMtime <= (state.envelopeMtimeMs ?? 0)) return { skipped: "unchanged" };

  const prepared = await parseAndStore(item, { stateDir, store, fs, post, now, markAbandoned, onStoreVerified });
  const pages = queuePages({ merged: prepared.merged, overflows: prepared.overflows, endSeen: prepared.endSeen, envelopeMtimeMs: registrationMtime, sourceBytes: prepared.sourceBytes, priorState: state, now });
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    try {
      const response = await deliver(page, post);
      if (index === pages.length - 1) writeState(stateDir, runId, stateAfterDelivery({ ...page, markAbandoned }, response, now), fs);
    } catch (error) {
      const permanent = isPermanentStatus(error?.status);
      for (let pending = index; pending < pages.length; pending += 1) {
        const itemToQueue = pages[pending];
        const file = queueItem(stateDir, itemToQueue, fs);
        if (permanent) {
          itemToQueue.attempts = MAX_ATTEMPTS;
          itemToQueue.lastError = `HTTP ${error.status}`;
          await deadLetter(file, itemToQueue, { stateDir, post, fs });
        }
      }
      return { queued: permanent ? 0 : pages.length - index, dead: permanent ? pages.length - index : 0, permanent, runId };
    }
  }
  return { ingested: true, runId, rows: prepared.merged.rows.length, committedLine: prepared.merged.run.file.committedLine };
}

export function deletable(run, state, { now = Date.now() } = {}) {
  if (!state?.verified) return { ok: false, reason: "upload not checksum-verified" };
  if (!state.endSeen && now - Number(state.lastLineAt ?? 0) < ABANDONED_MS) return { ok: false, reason: "run may still be growing" };
  if (state.gitTracked !== false) return { ok: false, reason: "git tracking not ruled out" };
  if (run.host === "box" && run.kind === "session" && !run.cutoverAt) return { ok: false, reason: "box session has not passed cutover" };
  return { ok: true, reason: "eligible" };
}

export function isGitTracked(file, { fs = fsDefault, run = spawnSync } = {}) {
  let directory = path.dirname(path.resolve(file));
  while (true) {
    if (fs.existsSync(path.join(directory, ".git"))) {
      const relative = path.relative(directory, file);
      const ignored = run("git", ["check-ignore", "--quiet", "--", relative], { cwd: directory, stdio: "ignore" });
      if (ignored.status === 0) return false;
      return run("git", ["ls-files", "--error-unmatch", "--", relative], { cwd: directory, stdio: "ignore" }).status === 0;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

function cleanupSpool(stateDir, fs, now) {
  const dir = path.join(stateDir, "registration");
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try { if (now() - fs.statSync(file).mtimeMs > SPOOL_MAX_AGE_MS) { fs.unlinkSync(file); removed += 1; } } catch {}
    }
  } catch {}
  return removed;
}

function makeLog(stateDir, fs, now) {
  return (message) => {
    const file = path.join(stateDir, "sweep.log");
    fs.mkdirSync(stateDir, { recursive: true });
    try {
      if (fs.statSync(file).size >= LOG_MAX_BYTES) fs.renameSync(file, `${file}.${now()}`);
    } catch {}
    fs.appendFileSync(file, `${new Date(now()).toISOString()} ${message}\n`);
  };
}

function diskLow(roots, fs) {
  for (const configured of [...(roots.claude ?? []), ...(roots.codex ?? [])]) {
    const root = typeof configured === "string" ? configured : configured.path;
    try {
      const stat = fs.statfsSync(root);
      const free = Number(stat.bavail) * Number(stat.bsize);
      if (free < LOW_DISK_BYTES) return free;
    } catch {}
  }
  return null;
}

async function defaultPost(config, route, body) {
  const key = route.startsWith("/runs/") ? config.sessionsKey : config.ttsKey;
  if (!config.convexSiteUrl || !key) throw new Error(`missing variables for ${route.startsWith("/runs/") ? "run ingest" : "TTS event"}`);
  const response = await fetch(`${config.convexSiteUrl.replace(/\/+$/, "")}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [route.startsWith("/runs/") ? "X-Sessions-Key" : "X-TTS-Key"]: key },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw Object.assign(new Error(`${route} failed with HTTP ${response.status}`), { status: response.status });
  return await response.json();
}

export async function sweepRuns({
  config = runConfig(),
  file,
  full = false,
  urgent = false,
  dryRun = false,
  fs = fsDefault,
  now = Date.now,
  post,
  store,
  log,
  backoffMs = sweepBackoffMs,
} = {}) {
  const say = log ?? (dryRun ? () => {} : makeLog(config.stateDir, fs, now));
  const send = post ?? ((route, body) => defaultPost(config, route, body));
  if (!config.host || !config.stateDir) {
    say("runs-sweep refused: RUN_HOST and RUN_SWEEP_STATE_DIR are required");
    if ((config.ttsKey && config.convexSiteUrl) || post) await send("/tts/job-failed", { job: "runs-sweep", key: "runs-sweep:no-host", error: "RUN_HOST is missing; the sweep refused to invent a host id." });
    return { started: false, reason: "host or state directory missing" };
  }
  if (dryRun) {
    const items = file ? [describeRunFile(file, { roots: config.roots, host: config.host, fs })].filter(Boolean) : discoverRunFiles({ roots: config.roots, since: 0, host: config.host, fs });
    let parsed = 0;
    for (const item of items.filter((entry) => entry.kind !== "attachment")) {
      const text = fs.readFileSync(item.path, "utf8");
      if (item.runtime === "claude") parseClaudeFile({ path: item.path, text, host: item.host, fileVersion: sha256(text), agentMeta: agentMeta(item, fs), parentSessionId: item.kind === "subagent" ? item.threadId.split("/")[0] : null });
      else parseCodexFile({ path: item.path, text, host: item.host, fileVersion: sha256(text) });
      parsed += 1;
    }
    return { started: true, dryRun: true, files: items.length, parsed };
  }

  const lock = acquireSweepLock(config.stateDir, { fs, now });
  if (!lock.acquired) return { started: true, locked: true, files: 0 };
  try {
    const activeStore = store ?? openStore(config.storeConfig);
    const queue = await drainQueue({ stateDir: config.stateDir, post: send, fs, now, backoffMs, log: say });
    const pendingRunIds = new Set(queue.pendingRunIds);
    let storeRecoveryReported = false;
    const onStoreVerified = async () => {
      if (config.storeConfig.backend !== "s3" || storeRecoveryReported) return;
      storeRecoveryReported = true;
      if (config.ttsKey || post) await send("/tts/job-ok", { job: "runs-sweep", key: "runs-sweep:store-local" });
    };
    const watermarkFile = path.join(config.stateDir, "watermark.json");
    const firstSweep = !fs.existsSync(watermarkFile);
    const watermark = firstSweep ? now() : readJson(watermarkFile, fs)?.at ?? 0;
    if (firstSweep) atomicJson(watermarkFile, { at: watermark }, fs);
    const lowBytes = diskLow(config.roots, fs);
    if (lowBytes !== null) {
      urgent = true;
      say(`runs-sweep low disk freeBytes=${lowBytes}`);
      if (config.ttsKey || post) await send("/tts/job-failed", { job: "runs-sweep", key: "runs-sweep:disk", error: "The run-file volume has less than 10 GB free; a full sweep is running." });
    } else if (config.ttsKey || post) await send("/tts/job-ok", { job: "runs-sweep", key: "runs-sweep:disk" });
    if (config.storeConfig.backend === "local" && (config.ttsKey || post)) await send("/tts/job-failed", { job: "runs-sweep", key: "runs-sweep:store-local", error: "The run store is local until RUN_STORE_ENDPOINT, RUN_STORE_BUCKET, RUN_STORE_WRITE_KEY_ID, and RUN_STORE_WRITE_SECRET are configured." });

    const lastSweepFile = path.join(config.stateDir, "last-sweep.json");
    const since = full || urgent || firstSweep ? 0 : readJson(lastSweepFile, fs)?.at ?? 0;
    const items = file
      ? [describeRunFile(file, { roots: config.roots, host: config.host, fs })].filter(Boolean)
      : discoverRunFiles({ roots: config.roots, since, host: config.host, fs });
    let deferred = 0, ingested = 0, queued = 0, refused = 0;
    for (const item of items) {
      if (item.kind === "attachment") continue;
      const runId = runIdOf(item);
      if (pendingRunIds.has(runId)) { queued += 1; continue; }
      const state = readState(config.stateDir, runId, fs);
      if (!file && !config.flags.backlog && ((firstSweep && item.mtimeMs < watermark) || (state?.deferred && item.mtimeMs <= watermark))) {
        writeState(config.stateDir, runId, { runId, path: item.path, committedLine: 0, committedPrefixSha256: sha256(Buffer.alloc(0)), sourceHash: "", bytes: item.bytes, storedHash: "", lastLineAt: item.mtimeMs, lastSweptAt: now(), deferred: true, endSeen: false, reportedAbandoned: false }, fs);
        deferred += 1;
        continue;
      }
      try {
        const result = await sweepRunFile(item, { stateDir: config.stateDir, store: activeStore, post: send, fs, now, onStoreVerified });
        if (result.ingested) ingested += 1;
        if (result.queued) queued += result.queued;
        if (result.refused) refused += 1;
      } catch (error) {
        say(`runs-sweep kept run=${runId} stage=file reason=${String(error?.message ?? error).slice(0, 200)}`);
      }
    }
    atomicJson(lastSweepFile, { at: now() }, fs);
    const staleSpool = cleanupSpool(config.stateDir, fs, now);
    let deletableFiles = 0, deletableBytes = 0;
    try {
      for (const name of fs.readdirSync(path.join(config.stateDir, "state"))) {
        const state = readJson(path.join(config.stateDir, "state", name), fs);
        if (!state?.path || state.deferred) continue;
        const registration = readRegistration(state.path, { fs });
        const run = { host: config.host, kind: registration?.registration?.kind ?? "unknown", cutoverAt: state.cutoverAt };
        state.gitTracked = isGitTracked(state.path, { fs });
        const decision = deletable(run, state, { now: now() });
        if (decision.ok) { deletableFiles += 1; deletableBytes += state.bytes ?? 0; }
        if (!state.endSeen && !state.reportedAbandoned && now() - Number(state.lastLineAt ?? 0) >= ABANDONED_MS) {
          const described = describeRunFile(state.path, { roots: config.roots, host: config.host, fs });
          if (described && !pendingRunIds.has(state.runId)) await sweepRunFile(described, { stateDir: config.stateDir, store: activeStore, post: send, fs, now, markAbandoned: true, onStoreVerified });
        }
      }
    } catch {}
    say(`runs-sweep files=${items.length} ingested=${ingested} queued=${queued} deferred=${deferred} refused=${refused} staleSpool=${staleSpool} deletable=${deletableFiles} bytes=${deletableBytes}`);
    return { started: true, files: items.length, ingested, queued, deferred, refused, staleSpool, deletable: deletableFiles, deletableBytes, queue };
  } finally {
    lock.release();
  }
}

function argsOf(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--file") options.file = argv[++index];
    else if (argv[index] === "--full") options.full = true;
    else if (argv[index] === "--urgent") options.urgent = true;
    else if (argv[index] === "--dry-run") options.dryRun = true;
  }
  return options;
}

async function main() {
  const result = await sweepRuns(argsOf(process.argv.slice(2)));
  if (!result.started) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`runs-sweep could not start: ${String(error?.message ?? error).slice(0, 200)}`);
    process.exitCode = 1;
  });
}
