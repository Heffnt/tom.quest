#!/usr/bin/env node
// backlog.mjs — everything that happened before the record, imported once.
//
// The sweeper records what happens from now on. This program walks what is
// already on disk — the two CLI trees on this host and the gzipped archive
// WikiTom already holds — and gives each old run ONE `runs` index row and no
// transcript rows: the record learns that the run exists, what shape and cost
// it had, and where its immutable bytes are, and the rows themselves are built
// later, on demand, from the store.
//
// It is a program of its own with its own lock, never a mode of the sweeper:
// the two-minute incremental sweep must never wait behind a ten-minute import
// pass. The two never collide over a file either, because of the `deferred`
// handshake — a file the sweeper marked deferred is this program's, a file it
// did not is the sweeper's, and clearing the mark is how a file is handed back.
//
// NOTHING HERE REMOVES A BYTE. There is no fs.unlink, rm, rmdir or truncate in
// this file, on any path: an atomic write is a write-and-rename whose temp name
// is deterministic, a lock is released by rewriting it, a keyed failure is
// re-armed by rewriting its marker, and a five-times-failed entry is COPIED
// into backlog/failed/ rather than moved. A backlog file is the only copy of a
// run that predates the store and has no rows in the record by design, so the
// deletion question that is still open for the steady state is not even asked
// here (§4 of the phase 5 brief).
//
// Every effect is injectable — fs, now, post, store, log, sleep, config — so
// every test runs with no network, no bucket and no real transcript.

import crypto from "node:crypto";
import fsDefault from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

import { readManifests, indexManifests } from "../jobs/session-archive.mjs";
import { runConfig, BACKLOG_DEFAULTS } from "./config.mjs";
import { AGENT_FILE, AGENT_SIDECAR, discoverRunFiles, workflowIdOf } from "./discover.mjs";
import { discoverChildren, parseClaudeFile, parseCodexFile } from "./ingest.mjs";
import { openStore } from "./store.mjs";
import {
  LOW_DISK_BYTES,
  STALE_LOCK_MS,
  deletable,
  isGitTracked,
  prefixSha256,
  stateFileFor,
  storeText,
} from "./sweep.mjs";

export const BACKLOG_SOURCES = Object.freeze(["claude-live", "codex-live", "archive"]);
export const BUDGET_WINDOW_MS = 60 * 60_000;
export const MAX_FAILURES = 5;
export const MAX_EVENT_RUN_IDS = 200;
const LOG_MAX_BYTES = 16 * 1024 ** 2;
// A date-only manifest value sorts stably when it is read at UTC noon: every
// entry of one day lands on one instant, and no timezone can move it past its
// neighbour's day.
const ARCHIVE_NOON_MS = 12 * 60 * 60_000;

const sha1 = (value) => crypto.createHash("sha1").update(value).digest("hex");
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** sha256 of the empty string — the prefix proof of a run with no rows. */
export const emptyPrefixSha256 = () => prefixSha256(Buffer.alloc(0), 0);

export function backlogDir(stateDir) {
  return path.join(stateDir, "backlog");
}

// Write-and-rename with a DETERMINISTIC temp name. The sweeper's equivalent
// unlinks its temp in a finally block; this program may not unlink anything,
// so the temp is named after its target and a failed write is overwritten by
// the next attempt rather than accumulating a new orphan each time.
function atomicJson(file, value, fs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readJson(file, fs) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function jsonFileCount(dir, fs) {
  try { return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length; }
  catch { return 0; }
}

export function makeBacklogLog(stateDir, fs, now) {
  return (message) => {
    const dir = backlogDir(stateDir);
    const file = path.join(dir, "backlog.log");
    fs.mkdirSync(dir, { recursive: true });
    // Rotation is a rename, not a removal: the old log stays until a human or
    // the host's own retention takes it.
    try { if (fs.statSync(file).size >= LOG_MAX_BYTES) fs.renameSync(file, `${file}.${now()}`); } catch {}
    fs.appendFileSync(file, `${new Date(now()).toISOString()} ${message}\n`);
  };
}

// ── Locks ────────────────────────────────────────────────────────────────────

/**
 * The importer's own lock at `<state>/backlog/lock`, released by rewriting it
 * with `released: true` rather than by removing it. The box's cron line wraps
 * this program in `flock -n`, which is what makes the take atomic; this file is
 * the in-process guard and the record of who holds it.
 */
export function acquireBacklogLock(stateDir, { fs = fsDefault, now = Date.now } = {}) {
  const dir = backlogDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "lock");
  const held = readJson(file, fs);
  const alive = held !== null
    && held.released !== true
    && Number.isFinite(held.startedAt)
    && now() - held.startedAt <= STALE_LOCK_MS;
  if (alive) return { acquired: false, release: () => {}, staleBroken: false };
  const startedAt = now();
  const write = (released) => fs.writeFileSync(file, `${JSON.stringify({ pid: process.pid, startedAt, released })}\n`, { mode: 0o600 });
  write(false);
  let released = false;
  return {
    acquired: true,
    staleBroken: held !== null && held.released !== true,
    release: () => { if (released) return; released = true; try { write(true); } catch {} },
  };
}

/** True while the SWEEPER holds its lock — read exactly the way it writes it. */
export function sweeperLockHeld(stateDir, { fs = fsDefault, now = Date.now } = {}) {
  const file = path.join(stateDir, "lock");
  if (!fs.existsSync(file)) return false;
  const held = readJson(file, fs);
  // A lock this program cannot date is a lock it must respect, not break.
  if (!Number.isFinite(held?.startedAt)) return true;
  return now() - held.startedAt <= STALE_LOCK_MS;
}

// ── The pause conditions ─────────────────────────────────────────────────────

function watchedPaths(config) {
  const roots = [...(config.roots?.claude ?? []), ...(config.roots?.codex ?? [])]
    .map((entry) => (typeof entry === "string" ? entry : entry.path))
    .filter(Boolean);
  return [config.stateDir, ...roots];
}

/** The least free space across the state directory and the CLI roots. */
export function lowestFreeBytes(paths, fs) {
  let lowest = null;
  for (const root of paths) {
    try {
      const stat = fs.statfsSync(root);
      const free = Number(stat.bavail) * Number(stat.bsize);
      if (Number.isFinite(free) && (lowest === null || free < lowest)) lowest = free;
    } catch {}
  }
  return lowest;
}

/**
 * Every reason this pass must not run, evaluated fresh. Checked once at the
 * start of a pass and again before each file, because a live sweep can start
 * and a disk can fill in the middle of a ten-minute import.
 */
export function pauseConditions({ config, fs = fsDefault, now = Date.now } = {}) {
  const free = lowestFreeBytes(watchedPaths(config), fs);
  const queued = jsonFileCount(path.join(config.stateDir, "queue"), fs)
    + jsonFileCount(path.join(config.stateDir, "deadletter"), fs);
  const settings = { ...BACKLOG_DEFAULTS, ...(config.backlog ?? {}) };
  return {
    freeBytes: free,
    queued,
    disk: free !== null && free < LOW_DISK_BYTES,
    storeLocal: config.storeConfig?.backend === "local" && !settings.allowLocalStore,
    queueBlocked: queued > 0,
    sweeperLock: sweeperLockHeld(config.stateDir, { fs, now }),
  };
}

const PAUSE_REPORTS = Object.freeze({
  disk: {
    key: "runs-backlog:disk",
    error: "The run-file volume has less than 10 GB free; the backlog import is paused.",
  },
  storeLocal: {
    key: "runs-backlog:store-local",
    error: "The run store is local; the backlog import is paused until RUN_STORE_ENDPOINT, RUN_STORE_BUCKET, RUN_STORE_WRITE_KEY_ID and RUN_STORE_WRITE_SECRET are configured, or RUN_BACKLOG_ALLOW_LOCAL_STORE is set.",
  },
  queueBlocked: {
    key: "runs-backlog:queue-blocked",
    error: "The run sweeper's queue or dead letter is not empty; the backlog import is paused until the live record lands.",
  },
  failed: {
    key: "runs-backlog:failed",
    error: "A backlog entry failed five times and was set aside under backlog/failed/.",
  },
});

/**
 * Say a keyed failure once and re-arm it once. The marker is REWRITTEN with
 * `active: false` rather than removed, so `#tts-broken` carries one standing
 * line while the condition holds and nothing when it does not.
 */
async function reportKey({ stateDir, key, active, error, post, fs }) {
  const marker = path.join(backlogDir(stateDir), "reported", `${key.replace(/[^a-z0-9]+/gi, "-")}.json`);
  const reported = readJson(marker, fs)?.active === true;
  if (active === reported) return "unchanged";
  if (active) {
    await post("/tts/job-failed", { job: "runs-backlog", key, error });
    atomicJson(marker, { key, active: true }, fs);
    return "reported";
  }
  await post("/tts/job-ok", { job: "runs-backlog", key });
  atomicJson(marker, { key, active: false }, fs);
  return "cleared";
}

// ── The archive as a source ──────────────────────────────────────────────────

const archiveAt = (date) => {
  const parsed = Date.parse(`${String(date ?? "")}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? parsed + ARCHIVE_NOON_MS : 0;
};

/**
 * One archive `dest` taken apart. The layout is fixed by the manifests and
 * nothing else builds a path:
 *
 *   sessions/Y/M/D/claude-<id>[/<account>]/session.jsonl.gz
 *   sessions/Y/M/D/claude-<id>[/<account>]/children/subagents/agent-<id>.jsonl.gz
 *   sessions/Y/M/D/claude-<id>[/<account>]/attachments/subagents/agent-<id>.meta.json.gz
 *   sessions/Y/M/D/claude-<id>[/<account>]/attachments/tool-results/<name>
 *   sessions/Y/M/D/codex-<thread>/rollout.jsonl.gz
 *   sessions/Y/M/D/codex-<thread>/children/<childThread>.jsonl.gz
 *
 * The account segment exists only where one Claude session id was written under
 * two box accounts; every other segment name is one of the four fixed words.
 */
export function archiveDest(dest) {
  const parts = String(dest ?? "").split("/");
  if (parts.length < 6 || parts[0] !== "sessions") return null;
  const folder = parts[4];
  const runtime = folder.startsWith("claude-") ? "claude" : folder.startsWith("codex-") ? "codex" : null;
  if (!runtime) return null;
  const id = folder.slice(runtime.length + 1);
  if (!id) return null;
  let rest = parts.slice(5);
  let account = null;
  const FIXED = ["session.jsonl.gz", "rollout.jsonl.gz", "children", "attachments"];
  if (runtime === "claude" && rest.length > 1 && !FIXED.includes(rest[0])) {
    account = rest[0];
    rest = rest.slice(1);
  }
  return { runtime, id, account, tail: rest.join("/") };
}

const CODEX_CHILD = /^children\/(.+)\.jsonl\.gz$/;

/**
 * What one archived file under a Claude session folder IS — the same question
 * `describeClaude` answers for a live directory, asked of a manifest `dest`.
 *
 * A child transcript is `agent-<agentId>.jsonl` ANYWHERE under a `subagents/`
 * segment, and it is the FILE NAME that says so, never the `.jsonl` extension:
 * the archive files a Workflow's agents one folder deeper at
 * `children/subagents/workflows/wf_<id>/` and parks the workflow's own
 * `journal.jsonl.gz` beside them, and that journal is not a transcript of
 * anything. Everything that is not an agent transcript is an attachment
 * pointer on the nearest run: the agent its name gives for
 * `agent-<id>.meta.json`, and the root for all the rest.
 */
export function archiveClaudeFile(tail) {
  const parts = String(tail ?? "").split("/");
  const name = parts.at(-1) ?? "";
  // The archive gzips every file it keeps, so the name to match is the source
  // name — one `.gz` off, and nothing else assumed about it.
  const sourceName = name.endsWith(".gz") ? name.slice(0, -3) : name;
  const underSubagents = parts.includes("subagents");
  const workflowId = workflowIdOf(parts);
  const agent = underSubagents ? AGENT_FILE.exec(sourceName) : null;
  if (agent) return { kind: "child", agentId: agent[1], workflowId, sourceName };
  const sidecar = underSubagents ? AGENT_SIDECAR.exec(sourceName) : null;
  if (sidecar) return { kind: "sidecar", agentId: sidecar[1], workflowId, sourceName };
  return { kind: "attachment", agentId: null, workflowId, sourceName };
}

/**
 * The work list for `--source archive`, built from the manifests through
 * session-archive.mjs's own readers and nothing else.
 *
 * A workflow's agent is a run like any other. Its thread id is
 * `<session>/<agentId>` — one slash, which is all the store takes — and the
 * `wf_<id>` folder it was filed under is where the file lived, not who the run
 * is; that folder name becomes `context.workflowId` and `origin: "workflow"`
 * instead. Everything under the session that is not an agent transcript is an
 * attachment pointer on the nearest run rather than a line nobody kept.
 */
export function archiveEntries({ sessionsDir, entries = readManifests(sessionsDir) } = {}) {
  const { accountsBySession } = indexManifests(entries);
  const groups = new Map();
  let workflowAgents = 0;
  let attachmentPointers = 0;
  let skippedUnknownDest = 0;

  for (const line of entries) {
    const dest = archiveDest(line.dest);
    if (!dest) { skippedUnknownDest += 1; continue; }
    // The laptop manifest predates the host, runtime, account and parent
    // columns. Its own filename, its 19,297 uniform lines and the archive's
    // README all say the same thing, and a host is never guessed from a path.
    const runtime = typeof line.runtime === "string" && line.runtime ? line.runtime : "claude";
    const host = line.host === "box" || line.host === "laptop" ? line.host : "laptop";
    const key = `${runtime}|${dest.id}|${dest.account ?? ""}`;
    const group = groups.get(key) ?? {
      runtime, host, id: dest.id, account: dest.account,
      parent: null, children: new Map(), sidecars: new Map(), workflows: new Map(),
      attachments: [], agentAttachments: new Map(), codexChildren: [],
    };
    groups.set(key, group);

    // The pointer names the file where it actually was, which is what the live
    // path records too, and takes bytes and sha256 from the manifest — both
    // over the original source — rather than gunzipping twelve thousand
    // attachments to recompute what is already written down.
    const pointer = () => (/^[0-9a-f]{64}$/.test(String(line.sha256)) && Number.isInteger(line.raw_bytes) && typeof line.source === "string"
      ? { file: line.source, bytes: line.raw_bytes, sha256: line.sha256 }
      : null);
    const attach = (agentId) => {
      const item = pointer();
      if (!item) return;
      attachmentPointers += 1;
      if (agentId === null) { group.attachments.push(item); return; }
      const own = group.agentAttachments.get(agentId) ?? [];
      own.push(item);
      group.agentAttachments.set(agentId, own);
    };

    if (dest.tail === "session.jsonl.gz" || dest.tail === "rollout.jsonl.gz") {
      group.parent = line;
      continue;
    }
    if (runtime === "codex") {
      const codexChild = CODEX_CHILD.exec(dest.tail);
      if (codexChild) { group.codexChildren.push({ threadId: codexChild[1], line }); continue; }
      attach(null);
      continue;
    }
    const file = archiveClaudeFile(dest.tail);
    if (file.kind === "child") {
      group.children.set(file.agentId, line);
      if (file.workflowId) { group.workflows.set(file.agentId, file.workflowId); workflowAgents += 1; }
      continue;
    }
    if (file.kind === "sidecar") {
      group.sidecars.set(file.agentId, line);
      if (file.workflowId) group.workflows.set(file.agentId, file.workflowId);
      // The sidecar is the one file under the session that names an agent, so
      // it is that agent's attachment as well as its own stored object — the
      // sweep records it in both places for the same reason.
      attach(file.agentId);
      continue;
    }
    // Whatever else the session carried: a tool result, a workflow's journal
    // or its own script. None of them is a transcript, all of them belong to
    // the run they were written under.
    attach(null);
  }

  const list = [];
  const childEntry = (group, agentId, line) => {
    const sidecar = group.sidecars.get(agentId);
    const workflowId = group.workflows.get(agentId);
    return {
      key: line.dest,
      threadId: `${group.id}/${agentId}`,
      agentId,
      path: line.source,
      bytes: Number(line.raw_bytes) || 0,
      at: archiveAt(line.date),
      ...(workflowId ? { workflowId } : {}),
      ...(sidecar ? { sidecarKey: sidecar.dest, sidecarPath: sidecar.source } : {}),
      attachments: group.agentAttachments.get(agentId) ?? [],
    };
  };

  for (const group of groups.values()) {
    // A sidecar whose transcript never reached the archive still belongs to the
    // record, and the root is the nearest run left to hold it.
    for (const [agentId, own] of group.agentAttachments) {
      if (!group.children.has(agentId)) { group.attachments.push(...own); group.agentAttachments.delete(agentId); }
    }
    const split = group.runtime === "claude" && (accountsBySession.get(group.id)?.size ?? 0) > 1;
    const common = {
      source: "archive",
      host: group.host,
      ...(group.account ? { account: group.account } : {}),
      ...(split ? { accountSplit: true } : {}),
    };
    if (group.parent) {
      list.push({
        ...common,
        runtimeKind: group.runtime === "claude" ? "claude/root" : "codex/rollout",
        key: group.parent.dest,
        threadId: group.id,
        path: group.parent.source,
        bytes: Number(group.parent.raw_bytes) || 0,
        at: archiveAt(group.parent.date),
        attachments: group.attachments,
        children: [...group.children.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([agentId, line]) => childEntry(group, agentId, line)),
      });
    } else {
      // An orphan child imports on its own and makes a stub parent that a
      // later entry may fill. That is the designed state, not a special case.
      for (const [agentId, line] of [...group.children.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        list.push({
          ...common,
          runtimeKind: "claude/subagent",
          ...childEntry(group, agentId, line),
          orphan: true,
          parentSessionId: group.id,
        });
      }
    }
    // A Codex child's run id carries its own thread, so it is a run of its own
    // wherever the archive filed it. Its parent comes from the rollout's own
    // session_meta and never from the path.
    for (const { threadId, line } of group.codexChildren) {
      list.push({
        ...common,
        runtimeKind: "codex/rollout",
        key: line.dest,
        threadId,
        path: line.source,
        bytes: Number(line.raw_bytes) || 0,
        at: archiveAt(line.date),
      });
    }
  }
  return { entries: list, workflowAgents, attachmentPointers, skippedUnknownDest, manifestLines: entries.length };
}

// ── The work lists ───────────────────────────────────────────────────────────

function liveEntries({ source, config, fs }) {
  const roots = source === "claude-live"
    ? { claude: config.roots?.claude ?? [], codex: [] }
    : { claude: [], codex: config.roots?.codex ?? [] };
  return discoverRunFiles({ roots, since: 0, host: config.host, fs })
    .filter((item) => item.kind !== "attachment")
    .map((item) => ({
      source,
      runtimeKind: `${item.runtime}/${item.kind}`,
      key: item.path,
      threadId: item.threadId,
      host: item.host,
      path: item.path,
      bytes: item.bytes,
      at: item.mtimeMs,
      ...(item.workflowId ? { workflowId: item.workflowId } : {}),
      ...(item.kind === "subagent"
        ? { sidecarPath: item.path.replace(/\.jsonl$/i, ".meta.json"), parentSessionId: item.threadId.split("/")[0] }
        : {}),
    }));
}

/** Newest first across the whole of one source, ties broken stably by key. */
const newestFirst = (a, b) => b.at - a.at || String(a.key).localeCompare(String(b.key));

function entryBytes(entry) {
  return Number(entry.bytes ?? 0)
    + (entry.children ?? []).reduce((sum, child) => sum + Number(child.bytes ?? 0), 0);
}

function entryRuns(entry) {
  return 1 + (entry.children ?? []).length;
}

export function listFileFor(stateDir, source) {
  return path.join(backlogDir(stateDir), `list-${source}.jsonl`);
}

function readList(stateDir, source, fs) {
  const file = listFileFor(stateDir, source);
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { return null; }
  const entries = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  return entries;
}

function readCursors(stateDir, fs) {
  const value = readJson(path.join(backlogDir(stateDir), "cursor.json"), fs);
  return value && typeof value === "object" ? value : {};
}

function writeCursor(stateDir, source, cursor, fs) {
  const cursors = { ...readCursors(stateDir, fs), [source]: cursor };
  atomicJson(path.join(backlogDir(stateDir), "cursor.json"), cursors, fs);
}

/**
 * The one expensive walk. `--run` never refreshes it: anything created after
 * the walk is not backlog, it is the sweeper's, and a single find over the
 * laptop's Claude tree does not finish in two minutes.
 *
 * A rebuild PRESERVES the cursor when the new list's first N keys match the old
 * list's (N being the cursor), because new files landing at the top of a
 * newest-first list would otherwise re-import everything behind them. When they
 * do not match the cursor resets to 0 and the pass skips each already-imported
 * run in O(1) off its state file — a scan, not a re-upload.
 */
export function buildLists({
  config = runConfig(),
  fs = fsDefault,
  now = Date.now,
  sources = BACKLOG_SOURCES,
  log = () => {},
} = {}) {
  const dir = backlogDir(config.stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const meta = readJson(path.join(dir, "lists.json"), fs) ?? {};
  const results = [];
  for (const source of sources) {
    const startedAt = now();
    let entries = [];
    let extra = {};
    if (source === "archive") {
      const settings = { ...BACKLOG_DEFAULTS, ...(config.backlog ?? {}) };
      const built = archiveEntries({ sessionsDir: settings.sessionsDir });
      entries = built.entries;
      extra = {
        workflowAgents: built.workflowAgents,
        attachmentPointers: built.attachmentPointers,
        skippedUnknownDest: built.skippedUnknownDest,
        manifestLines: built.manifestLines,
      };
    } else {
      entries = liveEntries({ source, config, fs });
    }
    entries.sort(newestFirst);

    const previous = readList(config.stateDir, source, fs) ?? [];
    const cursor = Number(readCursors(config.stateDir, fs)[source]) || 0;
    const headMatches = cursor === 0 || (cursor <= entries.length && cursor <= previous.length
      && previous.slice(0, cursor).every((entry, index) => entry.key === entries[index].key));
    const file = listFileFor(config.stateDir, source);
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""), { mode: 0o600 });
    fs.renameSync(temporary, file);
    if (!headMatches) writeCursor(config.stateDir, source, 0, fs);

    const record = {
      at: startedAt,
      builtMs: now() - startedAt,
      entries: entries.length,
      runs: entries.reduce((sum, entry) => sum + entryRuns(entry), 0),
      bytes: entries.reduce((sum, entry) => sum + entryBytes(entry), 0),
      cursorPreserved: headMatches,
      ...extra,
    };
    meta[source] = record;
    results.push({ source, ...record });
    log(`runs-backlog list source=${source} entries=${record.entries} runs=${record.runs} bytes=${record.bytes} builtMs=${record.builtMs} cursor=${headMatches ? cursor : 0}${headMatches ? "" : " reset"}`);
  }
  atomicJson(path.join(dir, "lists.json"), meta, fs);
  return { built: results };
}

// ── One entry, and the runs inside it ────────────────────────────────────────

const runIdOf = (unit) => `${unit.runtime}:${unit.host}:${unit.threadId}`;

export function archiveStateFileFor(stateDir, runId) {
  return path.join(backlogDir(stateDir), "archive", `${sha1(runId)}.json`);
}

function failedFileFor(stateDir, runId) {
  return path.join(backlogDir(stateDir), "failed", `${sha1(runId)}.json`);
}

/**
 * One list entry as the runs it holds. A live entry is one run; an archive
 * parent is itself plus each of its plain subagents, each of which is a run of
 * its own with its own store objects and its own index row.
 */
export function unitsOf(entry, { sessionsDir } = {}) {
  const [runtime, kind] = String(entry.runtimeKind ?? "claude/root").split("/");
  const base = {
    source: entry.source,
    host: entry.host,
    runtime,
    accountSplit: entry.accountSplit === true,
    account: entry.account ?? null,
  };
  // A manifest `dest` is relative to the WIKITOM ROOT and always opens with
  // the `sessions/` segment, so that segment is dropped rather than the parent
  // of the configured directory being guessed at.
  const archiveGz = (key) => {
    const parts = String(key).split("/");
    return path.join(sessionsDir ?? "", ...(parts[0] === "sessions" ? parts.slice(1) : parts));
  };
  if (entry.source === "archive") {
    const units = [];
    const parentIsClaude = runtime === "claude";
    units.push({
      ...base,
      kind: parentIsClaude ? (entry.orphan ? "subagent" : "root") : "rollout",
      threadId: entry.threadId,
      path: entry.path,
      bytes: Number(entry.bytes ?? 0),
      gz: archiveGz(entry.key),
      ...(entry.sidecarKey ? { sidecarGz: archiveGz(entry.sidecarKey) } : {}),
      ...(entry.workflowId ? { workflowId: entry.workflowId } : {}),
      ...(entry.orphan ? { parentSessionId: entry.parentSessionId } : {}),
      attachments: entry.attachments ?? [],
    });
    for (const child of entry.children ?? []) {
      units.push({
        ...base,
        kind: "subagent",
        threadId: child.threadId,
        path: child.path,
        bytes: Number(child.bytes ?? 0),
        gz: archiveGz(child.key),
        ...(child.sidecarKey ? { sidecarGz: archiveGz(child.sidecarKey) } : {}),
        ...(child.workflowId ? { workflowId: child.workflowId } : {}),
        parentSessionId: entry.threadId,
        attachments: child.attachments ?? [],
      });
    }
    return units;
  }
  return [{
    ...base,
    kind,
    threadId: entry.threadId,
    path: entry.path,
    bytes: Number(entry.bytes ?? 0),
    file: entry.path,
    ...(entry.sidecarPath ? { sidecarFile: entry.sidecarPath } : {}),
    ...(entry.workflowId ? { workflowId: entry.workflowId } : {}),
    ...(entry.parentSessionId ? { parentSessionId: entry.parentSessionId } : {}),
    attachments: null,
  }];
}

function readUnitBytes(unit, fs) {
  if (unit.gz) return zlib.gunzipSync(fs.readFileSync(unit.gz));
  return fs.readFileSync(unit.file ?? unit.path);
}

function readSidecarBytes(unit, fs) {
  try {
    if (unit.sidecarGz) return zlib.gunzipSync(fs.readFileSync(unit.sidecarGz));
    if (unit.sidecarFile) return fs.readFileSync(unit.sidecarFile);
  } catch {}
  return null;
}

/**
 * What one old run costs the record, in the order §23.4 fixes with step 4
 * emptied: skip, read, store, parse the STORE's bytes, one index row and no
 * transcript rows, clear the mark.
 */
async function importUnit(unit, ctx) {
  const { config, fs, now, post, store, dryRun, settings } = ctx;
  const runId = runIdOf(unit);
  const stateFile = unit.source === "archive"
    ? archiveStateFileFor(config.stateDir, runId)
    : stateFileFor(config.stateDir, runId);
  const own = readJson(stateFile, fs);
  const live = readJson(stateFileFor(config.stateDir, runId), fs);
  const liveImported = Boolean(live && !live.deferred && live.storeKey);

  // 1. Skip in O(1).
  if (fs.existsSync(failedFileFor(config.stateDir, runId))) return { outcome: "failed-before", runId };
  const versions = Array.isArray(own?.versions) ? own.versions : [];
  const accountRecorded = unit.accountSplit && versions.some((version) => version.account === unit.account);
  if (unit.source === "archive"
    ? (accountRecorded || (!unit.accountSplit && own && !own.deferred && own.storeKey) || (liveImported && own?.duplicateOfLive))
    : liveImported) {
    return { outcome: "already", runId };
  }

  // 2. Read the bytes, refusing a source no parser should hold in memory.
  if (unit.bytes > settings.maxFileBytes) {
    if (!dryRun) {
      atomicJson(stateFile, {
        ...(own ?? {}), runId, path: unit.path, deferred: true, bytes: unit.bytes,
        lastFailure: { stage: "read", reason: "source above RUN_BACKLOG_MAX_FILE_BYTES", at: now() },
      }, fs);
    }
    return { outcome: "too-large", runId, bytes: unit.bytes };
  }
  const sourceBytes = readUnitBytes(unit, fs);
  if (sourceBytes.length > settings.maxFileBytes) {
    if (!dryRun) {
      atomicJson(stateFile, {
        ...(own ?? {}), runId, path: unit.path, deferred: true, bytes: sourceBytes.length,
        lastFailure: { stage: "read", reason: "source above RUN_BACKLOG_MAX_FILE_BYTES", at: now() },
      }, fs);
    }
    return { outcome: "too-large", runId, bytes: sourceBytes.length };
  }
  const sidecarBytes = unit.kind === "subagent" ? readSidecarBytes(unit, fs) : null;

  // A dry run parses exactly what a real one would — the store's redacted text
  // — and writes nothing anywhere, so it needs no object and no key.
  if (dryRun) {
    const text = storeText(sourceBytes);
    const result = parseUnit(unit, { text, fileVersion: crypto.createHash("sha256").update(text).digest("hex"), sidecarBytes, sidecarStored: null, fs });
    return { outcome: "dry-run", runId, sourceBytes: sourceBytes.length, totalLines: result.lastLine, children: result.children.length };
  }

  // 3. Store. An unverified put stops this entry here with no store key.
  const stored = await store.put({ runtime: unit.runtime, threadId: unit.threadId, host: unit.host, sourceBytes });
  if (!stored.verified || !stored.key) throw Object.assign(new Error("run store upload was not verified"), { stage: "store" });
  let sidecarStored = null;
  if (sidecarBytes) {
    sidecarStored = await store.put({ runtime: unit.runtime, threadId: unit.threadId, host: unit.host, sourceBytes: sidecarBytes, kind: "sidecar" });
    if (!sidecarStored.verified || !sidecarStored.key) throw Object.assign(new Error("run sidecar upload was not verified"), { stage: "store" });
  }

  const version = {
    ...(unit.account ? { account: unit.account } : {}),
    bytes: stored.bytes,
    sourceHash: stored.sourceHash,
    storedHash: stored.storedHash,
    storeKey: stored.key,
    ...(sidecarStored ? { sidecarStoredHash: sidecarStored.storedHash } : {}),
    at: now(),
  };
  const allVersions = [...versions.filter((entry) => entry.storedHash !== version.storedHash), version];

  // The live file wins: an archive copy of a run the sweeper already recorded
  // puts its bytes (the thread's prefix in the bucket IS the list of its
  // versions) and posts nothing at all.
  if (unit.source === "archive" && liveImported) {
    atomicJson(stateFile, {
      runId, path: unit.path, source: "archive", duplicateOfLive: true, deferred: false,
      committedLine: 0, committedPrefixSha256: emptyPrefixSha256(),
      ...version, versions: allVersions, importedAt: now(),
    }, fs);
    return { outcome: "duplicate", runId, sourceBytes: stored.bytes, storedBytes: stored.storedBytes };
  }

  // 4. Parse the redacted bytes the STORE returned, never the local bytes.
  const text = (await store.get({ runtime: unit.runtime, threadId: unit.threadId, host: unit.host, fileVersion: stored.fileVersion })).toString("utf8");
  const result = parseUnit(unit, { text, fileVersion: stored.fileVersion, sidecarBytes, sidecarStored, fs });

  // An account split is one run — the run id carries host and thread, never
  // account — and the larger stored version wins when neither is live.
  const larger = allVersions.reduce((best, entry) => (entry.bytes > best.bytes ? entry : best), version);
  const posts = !unit.accountSplit || larger.storedHash === version.storedHash;

  // 5. One index row and no transcript rows.
  const emptyPrefix = emptyPrefixSha256();
  const file = {
    ...result.run.file,
    sourceHash: stored.sourceHash,
    storedHash: stored.storedHash,
    bytes: stored.bytes,
    storedBytes: stored.storedBytes,
    storeKey: stored.key,
    ...(sidecarStored ? { sidecarStoredHash: sidecarStored.storedHash } : {}),
    committedLine: 0,
    committedPrefixSha256: emptyPrefix,
    totalLines: result.lastLine,
  };
  const payload = {
    run: { ...result.run, file },
    rows: [],
    children: result.children,
    previousCommittedLine: 0,
    previousPrefixSha256: emptyPrefix,
  };
  if (posts) {
    const response = await post("/runs/ingest", payload);
    if (response?.ok === false) throw Object.assign(new Error(`run ingest refused: ${response.reason ?? "unknown"}`), { stage: "ingest" });
  }

  // 6. Clear `deferred`, write the store key, never unlink anything.
  atomicJson(stateFile, {
    runId,
    path: unit.path,
    committedLine: 0,
    committedPrefixSha256: emptyPrefix,
    sourceHash: stored.sourceHash,
    bytes: stored.bytes,
    storedHash: stored.storedHash,
    storeKey: stored.key,
    ...(sidecarStored ? { sidecarStoredHash: sidecarStored.storedHash } : {}),
    totalLines: result.lastLine,
    verified: true,
    lastLineAt: result.run.lastLineAt,
    lastSweptAt: now(),
    importedAt: now(),
    deferred: false,
    endSeen: false,
    reportedAbandoned: false,
    backlog: true,
    source: unit.source,
    ...(unit.source === "archive" ? { versions: allVersions } : {}),
  }, fs);

  return {
    outcome: "imported",
    runId,
    payload,
    posted: posts,
    accountSplit: unit.accountSplit === true,
    sourceBytes: stored.bytes,
    storedBytes: stored.storedBytes + (sidecarStored?.storedBytes ?? 0),
    totalLines: result.lastLine,
    localPath: unit.source === "archive" ? null : unit.path,
    runKind: result.run.kind,
    lastLineAt: result.run.lastLineAt,
  };
}

/**
 * The importer's one parse step, exported so a test can witness that the
 * archive path and a plain-file import hand the parser the same arguments.
 */
export function parseUnit(unit, { text, fileVersion, sidecarBytes = null, sidecarStored = null, fs = fsDefault }) {
  if (unit.runtime !== "claude") {
    return parseCodexFile({ path: unit.path, text, host: unit.host, fileVersion });
  }
  if (unit.kind === "subagent") {
    const agentId = String(unit.threadId).split("/").at(-1);
    let meta = null;
    if (sidecarBytes) {
      try { meta = JSON.parse(sidecarBytes.toString("utf8")); } catch {}
    }
    // A workflow's sidecar never names its workflow — the folder does, and a
    // workflow agent's sidecar is thin anyway (an agentType and a spawnDepth,
    // sometimes a model). Depth 1 is the default the sweep uses for the same
    // file, and the spawning tool call stays unknown rather than invented:
    // `linkKnown: false` is the parser's own word for that.
    const base = { agentId, ...(unit.workflowId ? { workflowId: unit.workflowId } : {}) };
    return parseClaudeFile({
      path: unit.path,
      text,
      host: unit.host,
      fileVersion,
      // A sidecar that is missing or malformed is not an error here: the parser
      // writes its own row saying what it could not read. The agent id is NOT
      // left to it, though — the file's own name proves that, and two
      // sidecar-less children of one session would otherwise collide on the
      // run id `.../unknown`.
      agentMeta: meta === null ? (unit.workflowId ? { ...base, spawnDepth: 1 } : base) : { ...meta, ...base },
      parentSessionId: unit.parentSessionId ?? String(unit.threadId).split("/")[0],
      sidecar: sidecarStored ? { storedHash: sidecarStored.storedHash, fileVersion: sidecarStored.fileVersion } : null,
      // The sidecar travels with the agent it names, as a pointer as well as a
      // stored object — the sweep records it in both places too. An archive
      // entry already carries it from the manifest; a live one is measured
      // here off the bytes just read, so the two agree pointer for pointer.
      attachments: unit.attachments ?? (sidecarBytes && unit.sidecarFile
        ? [{ file: unit.sidecarFile, bytes: sidecarBytes.length, sha256: crypto.createHash("sha256").update(sidecarBytes).digest("hex") }]
        : []),
    });
  }
  // Attachments stay pointers. An archive entry takes bytes and sha256 from the
  // manifest, which recorded both over the original source, so nothing gunzips
  // twelve thousand tool-result files to recompute what is already written.
  const attachments = unit.attachments ?? discoverChildren(unit.path, { fs }).toolResults;
  return parseClaudeFile({ path: unit.path, text, host: unit.host, fileVersion, attachments });
}

// ── The budget ───────────────────────────────────────────────────────────────

function budgetFor(stateDir, fs, now, bytesPerHour) {
  const file = path.join(backlogDir(stateDir), "budget.json");
  let state = readJson(file, fs) ?? { windowStart: 0, bytesUsed: 0 };
  if (!Number.isFinite(state.windowStart) || now() - state.windowStart >= BUDGET_WINDOW_MS) {
    state = { windowStart: now(), bytesUsed: 0 };
  }
  return {
    state,
    // A file larger than the remaining budget waits for the next window rather
    // than being split. One larger than the WHOLE budget would otherwise wait
    // forever, so it goes through alone on an empty window.
    allows: (bytes) => state.bytesUsed === 0 || state.bytesUsed + bytes <= bytesPerHour,
    spend: (bytes, persist = true) => {
      state.bytesUsed += bytes;
      if (persist) atomicJson(file, state, fs);
    },
  };
}

// ── One pass ─────────────────────────────────────────────────────────────────

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

const emptyCounts = () => ({
  imported: 0, alreadyImported: 0, duplicates: 0, accountSplits: 0, failed: 0,
  skippedTooLarge: 0, sourceBytes: 0, storedBytes: 0, runs: 0,
});

/**
 * One source, from its cursor until the budget, the time box, a pause or the
 * end of its list. A failure at any step records the stage and the reason in
 * the entry's state file, counts it, and moves on: one entry never stops a pass.
 */
async function importSource(source, ctx) {
  const { config, fs, now, log, dryRun, limit, settings, budget, startedAt } = ctx;
  const list = readList(config.stateDir, source, fs);
  if (list === null) return { source, missingList: true, ...emptyCounts(), cursor: 0, remaining: 0, remainingBytes: 0, accountSplitRunIds: [], pausedBy: null };
  const counts = emptyCounts();
  const accountSplitRunIds = [];
  let pausedBy = null;
  const persist = (value) => { if (!dryRun) writeCursor(config.stateDir, source, value, fs); };
  // The cursor is the first entry that is NOT finished, not simply the last one
  // this pass looked at: an entry that failed stays under the cursor so the
  // next pass retries it, while the pass itself keeps going past it — one entry
  // never stops a pass, and a failure is never walked over silently either.
  let firstUnfinished = null;
  let index = Math.min(Number(readCursors(config.stateDir, fs)[source]) || 0, list.length);

  for (; index < list.length; index += 1) {
    if (limit > 0 && ctx.processedRuns >= limit) { pausedBy = "limit"; break; }
    if (now() - startedAt >= settings.passMs) { pausedBy = "time"; break; }
    const pause = pauseConditions({ config, fs, now });
    if (pause.sweeperLock) { pausedBy = "sweeper-lock"; break; }
    if (pause.disk) { pausedBy = "disk"; break; }
    if (pause.queueBlocked) { pausedBy = "queue-blocked"; break; }
    if (pause.storeLocal) { pausedBy = "store-local"; break; }

    const entry = list[index];
    const units = unitsOf(entry, { sessionsDir: settings.sessionsDir });
    let budgetStopped = false;
    let entryFailed = false;
    for (const unit of units) {
      if (!budget.allows(unit.bytes)) { budgetStopped = true; break; }
      const runId = runIdOf(unit);
      let result;
      try {
        result = await importUnit(unit, ctx);
      } catch (error) {
        counts.failed += 1;
        entryFailed = true;
        ctx.processedRuns += 1;
        recordFailure(unit, error, ctx);
        log(`runs-backlog kept run=${runId} stage=${error?.stage ?? "unknown"} reason=${String(error?.message ?? error).slice(0, 200)}`);
        continue;
      }
      // A run already in the record costs nothing and does not count against
      // `--limit`; every other outcome is work this pass did.
      if (result.outcome === "already" || result.outcome === "failed-before") { counts.alreadyImported += 1; continue; }
      if (result.outcome === "too-large") { counts.skippedTooLarge += 1; ctx.processedRuns += 1; continue; }
      if (result.outcome === "dry-run") {
        counts.imported += 1;
        counts.sourceBytes += result.sourceBytes;
        budget.spend(result.sourceBytes, false);
        ctx.processedRuns += 1;
        continue;
      }
      budget.spend(result.sourceBytes);
      counts.sourceBytes += result.sourceBytes;
      counts.storedBytes += result.storedBytes;
      ctx.processedRuns += 1;
      if (result.outcome === "duplicate") { counts.duplicates += 1; continue; }
      counts.imported += 1;
      if (result.accountSplit) {
        counts.accountSplits += 1;
        if (!accountSplitRunIds.includes(runId)) accountSplitRunIds.push(runId);
      }
      if (result.localPath) measureDeletable(result, ctx);
    }
    if (budgetStopped) {
      pausedBy = "budget";
      if (firstUnfinished === null) firstUnfinished = index;
      break;
    }
    if (entryFailed && firstUnfinished === null) firstUnfinished = index;
    persist(firstUnfinished ?? index + 1);
  }

  const cursor = firstUnfinished ?? index;
  persist(cursor);
  const remainingEntries = list.slice(cursor);
  counts.runs = list.reduce((sum, entry) => sum + entryRuns(entry), 0);
  return {
    source,
    ...counts,
    cursor,
    remaining: remainingEntries.length,
    remainingBytes: remainingEntries.reduce((sum, entry) => sum + entryBytes(entry), 0),
    accountSplitRunIds,
    pausedBy,
  };
}

function recordFailure(unit, error, ctx) {
  const { config, fs, now } = ctx;
  const runId = runIdOf(unit);
  const stateFile = unit.source === "archive"
    ? archiveStateFileFor(config.stateDir, runId)
    : stateFileFor(config.stateDir, runId);
  const previous = readJson(stateFile, fs) ?? {};
  const failures = Number(previous.failures ?? 0) + 1;
  const record = {
    ...previous,
    runId,
    path: unit.path,
    bytes: unit.bytes,
    // The entry stays deferred with no store key, so the next pass re-puts
    // (idempotent: created:false) and completes from the same point.
    deferred: true,
    failures,
    lastFailure: { stage: error?.stage ?? "unknown", reason: String(error?.message ?? error).slice(0, 200), at: now() },
  };
  atomicJson(stateFile, record, fs);
  if (failures >= MAX_FAILURES) {
    // Set aside, not moved: a live entry's state file is the SWEEPER's too, and
    // taking it away would silently re-defer the run on the next sweep.
    atomicJson(failedFileFor(config.stateDir, runId), record, fs);
    ctx.newlyFailed += 1;
  }
}

// What Tom's still-open ruling on deleting a local file after upload needs, and
// it costs nothing to have ready: the steady-state predicate over what this
// pass uploaded, IGNORING the backlog reason, which refuses every one of these
// outright.
function measureDeletable(result, ctx) {
  const { config, fs, now, gitTracked } = ctx;
  const probe = {
    verified: true,
    endSeen: false,
    lastLineAt: result.lastLineAt,
    gitTracked: gitTracked(result.localPath, { fs }),
  };
  const decision = deletable({ host: config.host, kind: result.runKind, cutoverAt: undefined }, probe, { now: now() });
  if (decision.ok) {
    ctx.deletable.files += 1;
    ctx.deletable.bytes += result.sourceBytes;
  }
}

/**
 * One `--run` pass. Exits having done work, having been paused, or having found
 * the backlog finished; the only failure is not being able to start.
 */
export async function runBacklogPass({
  config = runConfig(),
  fs = fsDefault,
  now = Date.now,
  post,
  store,
  log,
  sleep = defaultSleep,
  limit = 0,
  source = null,
  dryRun = false,
  gitTracked = isGitTracked,
} = {}) {
  const say = log ?? (dryRun ? () => {} : makeBacklogLog(config.stateDir, fs, now));
  const send = post ?? ((route, body) => defaultPost(config, route, body));
  if (!config.host || !config.stateDir) {
    say("runs-backlog refused: RUN_HOST and RUN_SWEEP_STATE_DIR are required");
    return { started: false, reason: "host or state directory missing" };
  }
  const sources = source ? [source] : [...BACKLOG_SOURCES];
  if (sources.some((name) => !BACKLOG_SOURCES.includes(name))) {
    return { started: false, reason: "unknown source" };
  }
  if (!sources.some((name) => fs.existsSync(listFileFor(config.stateDir, name)))) {
    say("runs-backlog refused: no work list — run --build-list first");
    return { started: false, reason: "no work list" };
  }
  const settings = { ...BACKLOG_DEFAULTS, ...(config.backlog ?? {}) };

  // A live sweep is always more important than an old one: skip the tick.
  if (sweeperLockHeld(config.stateDir, { fs, now })) {
    say("runs-backlog skipped: the sweeper holds its lock");
    return { started: true, pausedBy: "sweeper-lock", sources: [] };
  }

  const lock = dryRun ? { acquired: true, release: () => {} } : acquireBacklogLock(config.stateDir, { fs, now });
  if (!lock.acquired) {
    say("runs-backlog skipped: another import pass holds the backlog lock");
    return { started: true, pausedBy: "backlog-lock", sources: [] };
  }
  try {
    const pause = pauseConditions({ config, fs, now });
    if (!dryRun) {
      for (const name of ["disk", "storeLocal", "queueBlocked"]) {
        await reportKey({ stateDir: config.stateDir, key: PAUSE_REPORTS[name].key, active: pause[name], error: PAUSE_REPORTS[name].error, post: send, fs });
      }
    }
    const blocking = pause.disk ? "disk" : pause.queueBlocked ? "queue-blocked" : pause.storeLocal ? "store-local" : null;
    if (blocking) {
      say(`runs-backlog paused by=${blocking} freeBytes=${pause.freeBytes ?? "-"} queued=${pause.queued}`);
      return { started: true, pausedBy: blocking, sources: [] };
    }

    const startedAt = now();
    const budget = budgetFor(config.stateDir, fs, now, settings.bytesPerHour);
    const deletableTotals = readJson(path.join(backlogDir(config.stateDir), "deletable.json"), fs) ?? { files: 0, bytes: 0 };
    const ctx = {
      config, fs, now, post: send, log: say, sleep, dryRun, limit, settings, budget, startedAt,
      store: store ?? openStore(config.storeConfig),
      gitTracked,
      processedRuns: 0,
      newlyFailed: 0,
      deletable: { files: 0, bytes: 0 },
    };

    const results = [];
    for (const name of sources) {
      const result = await importSource(name, ctx);
      results.push(result);
      if (result.missingList) continue;
      if (!dryRun) {
        await send("/tts/event", {
          kind: "runs-backlog-pass",
          data: {
            host: config.host, source: name, at: startedAt, elapsedMs: now() - startedAt,
            imported: result.imported, alreadyImported: result.alreadyImported,
            duplicates: result.duplicates, accountSplits: result.accountSplits,
            failed: result.failed, skippedTooLarge: result.skippedTooLarge,
            sourceBytes: result.sourceBytes, storedBytes: result.storedBytes,
            cursor: result.cursor, remaining: result.remaining, remainingBytes: result.remainingBytes,
            pausedBy: result.pausedBy,
          },
        });
        if (result.accountSplitRunIds?.length) {
          await send("/tts/event", {
            kind: "runs-backlog-account-split",
            data: { host: config.host, at: startedAt, count: result.accountSplits, runIds: result.accountSplitRunIds.slice(0, MAX_EVENT_RUN_IDS) },
          });
        }
      }
      say(`runs-backlog pass source=${name} imported=${result.imported} already=${result.alreadyImported} duplicates=${result.duplicates} splits=${result.accountSplits} failed=${result.failed} tooLarge=${result.skippedTooLarge} cursor=${result.cursor} remaining=${result.remaining} pausedBy=${result.pausedBy ?? "none"}`);
      if (result.pausedBy && result.pausedBy !== "limit") break;
      if (limit > 0 && ctx.processedRuns >= limit) break;
    }

    if (!dryRun) {
      atomicJson(path.join(backlogDir(config.stateDir), "deletable.json"), {
        files: deletableTotals.files + ctx.deletable.files,
        bytes: deletableTotals.bytes + ctx.deletable.bytes,
      }, fs);
      await reportKey({ stateDir: config.stateDir, key: PAUSE_REPORTS.failed.key, active: ctx.newlyFailed > 0 || jsonFileCount(path.join(backlogDir(config.stateDir), "failed"), fs) > 0, error: PAUSE_REPORTS.failed.error, post: send, fs });
    }
    return {
      started: true,
      dryRun,
      sources: results,
      processedRuns: ctx.processedRuns,
      deletable: ctx.deletable,
      pausedBy: results.find((result) => result.pausedBy)?.pausedBy ?? null,
    };
  } finally {
    lock.release();
  }
}

// ── `--status` ───────────────────────────────────────────────────────────────

/** The same numbers `--run` reports, plus list build times. Writes nothing. */
export function backlogStatus({ config = runConfig(), fs = fsDefault, now = Date.now } = {}) {
  const dir = backlogDir(config.stateDir);
  const meta = readJson(path.join(dir, "lists.json"), fs) ?? {};
  const cursors = readCursors(config.stateDir, fs);
  const settings = { ...BACKLOG_DEFAULTS, ...(config.backlog ?? {}) };
  const sources = BACKLOG_SOURCES.map((source) => {
    const list = readList(config.stateDir, source, fs);
    const cursor = Math.min(Number(cursors[source]) || 0, list?.length ?? 0);
    const remaining = list ? list.slice(cursor) : [];
    return {
      source,
      list: list !== null,
      entries: list?.length ?? 0,
      runs: (list ?? []).reduce((sum, entry) => sum + entryRuns(entry), 0),
      cursor,
      remaining: remaining.length,
      remainingBytes: remaining.reduce((sum, entry) => sum + entryBytes(entry), 0),
      builtAt: meta[source]?.at ?? null,
      builtMs: meta[source]?.builtMs ?? null,
      workflowAgents: meta[source]?.workflowAgents ?? 0,
      attachmentPointers: meta[source]?.attachmentPointers ?? 0,
    };
  });
  const budget = readJson(path.join(dir, "budget.json"), fs) ?? { windowStart: 0, bytesUsed: 0 };
  return {
    host: config.host,
    sources,
    budget: {
      ...budget,
      bytesPerHour: settings.bytesPerHour,
      windowRemainingMs: Math.max(0, BUDGET_WINDOW_MS - (now() - (budget.windowStart || 0))),
    },
    passMs: settings.passMs,
    maxFileBytes: settings.maxFileBytes,
    deletable: readJson(path.join(dir, "deletable.json"), fs) ?? { files: 0, bytes: 0 },
    failed: jsonFileCount(path.join(dir, "failed"), fs),
    pause: pauseConditions({ config, fs, now }),
  };
}

// ── Entry points ─────────────────────────────────────────────────────────────

export function argsOf(argv) {
  const options = { buildList: false, run: false, status: false, dryRun: false, limit: 0, source: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--build-list") options.buildList = true;
    else if (argv[index] === "--run") options.run = true;
    else if (argv[index] === "--status") options.status = true;
    else if (argv[index] === "--dry-run") options.dryRun = true;
    else if (argv[index] === "--limit") options.limit = Math.max(0, Number(argv[++index]) || 0);
    else if (argv[index] === "--source") options.source = argv[++index];
  }
  return options;
}

export async function backlogMain(argv, { config = runConfig(), fs = fsDefault, now = Date.now, say = console.log, ...rest } = {}) {
  const options = argsOf(argv);
  if (!config.host || !config.stateDir) {
    say("runs-backlog could not start: RUN_HOST and RUN_SWEEP_STATE_DIR are required");
    return 1;
  }
  if (options.buildList) {
    const built = buildLists({ config, fs, now, ...(options.source ? { sources: [options.source] } : {}), log: say });
    for (const record of built.built) {
      say(`list ${record.source} entries=${record.entries} runs=${record.runs} bytes=${record.bytes} builtMs=${record.builtMs} workflow-agents=${record.workflowAgents ?? 0} attachments=${record.attachmentPointers ?? 0} cursor=${record.cursorPreserved ? "kept" : "reset"}`);
    }
    return 0;
  }
  if (options.status) {
    const status = backlogStatus({ config, fs, now });
    say(`host=${status.host} budget=${status.budget.bytesUsed}/${status.budget.bytesPerHour} windowRemainingMs=${status.budget.windowRemainingMs} passMs=${status.passMs} failed=${status.failed} deletableFiles=${status.deletable.files} deletableBytes=${status.deletable.bytes}`);
    say(`pause disk=${status.pause.disk} storeLocal=${status.pause.storeLocal} queueBlocked=${status.pause.queueBlocked} sweeperLock=${status.pause.sweeperLock} freeBytes=${status.pause.freeBytes ?? "-"} queued=${status.pause.queued}`);
    for (const record of status.sources) {
      say(`${record.source} list=${record.list} entries=${record.entries} runs=${record.runs} cursor=${record.cursor} remaining=${record.remaining} remainingBytes=${record.remainingBytes} builtAt=${record.builtAt ?? "-"} builtMs=${record.builtMs ?? "-"} workflow-agents=${record.workflowAgents} attachments=${record.attachmentPointers}`);
    }
    return 0;
  }
  const result = await runBacklogPass({
    config, fs, now, limit: options.limit, source: options.source, dryRun: options.dryRun, ...rest,
  });
  if (!result.started) {
    say(`runs-backlog could not start: ${result.reason}`);
    return 1;
  }
  for (const record of result.sources ?? []) {
    say(`${record.source} imported=${record.imported} already=${record.alreadyImported} duplicates=${record.duplicates} splits=${record.accountSplits} failed=${record.failed} tooLarge=${record.skippedTooLarge} sourceBytes=${record.sourceBytes} storedBytes=${record.storedBytes} cursor=${record.cursor} remaining=${record.remaining} pausedBy=${record.pausedBy ?? "none"}`);
  }
  if (result.pausedBy) say(`paused by=${result.pausedBy}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  backlogMain(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`runs-backlog could not start: ${String(error?.message ?? error).slice(0, 200)}`);
      process.exitCode = 1;
    });
}
