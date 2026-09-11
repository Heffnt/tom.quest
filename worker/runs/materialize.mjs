#!/usr/bin/env node
// materialize.mjs — opening a run whose rows are not in the record.
//
// Convex is a cache of the store, and the store is a cache of nothing. A run
// that was imported as an index row, or whose rows were evicted, is opened by
// fetching its immutable version back out of the store, parsing it with the
// CURRENT parser, and ingesting the rows through the one ingest door.
//
// THE QUEUE IS DRAINED BY ANSWERS, NOT BY ATTEMPTS (worker/jobs/evals.mjs:871).
// Every path out of this job writes the request — served or failed — because a
// request the box cannot serve would otherwise take the head of the queue on
// every tick forever and nothing behind it would ever be served. The reason it
// writes is one of a closed set of fixed phrases; no payload, path or
// transcript text is ever reflected into it.
//
// One request per tick, so a tick is bounded. Every effect is injectable so the
// tests run with no network, no bucket and no real transcript.

import fsDefault from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { PARSER_VERSION, parseClaudeFile, parseCodexFile } from "./ingest.mjs";
import { runConfig } from "./config.mjs";
import { openStore } from "./store.mjs";
import { prefixSha256, storeText, textFromLine } from "./sweep.mjs";

// §2.5: the cap is about mutation size, not about what Tom asked for. The
// answer route enqueues a continuation itself; this job queues nothing.
export const MAX_MATERIALIZE_ROWS = 20_000;
export const MAX_SLICES = 5;
// internalIngest refuses more than 200 rows in one call.
export const PAGE_ROWS = 200;
// The parsers build every row in memory, so one pathological file must not
// take the job down. The real value comes off runConfig's backlog block.
export const DEFAULT_MAX_FILE_BYTES = 128 * 1024 ** 2;
const LOG_MAX_BYTES = 16 * 1024 ** 2;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The whole of what may be written to a request's `reason`. Nothing outside
 * this object ever reaches Convex: a store error's own message could carry a
 * key name or a path, so it is classified here and then discarded.
 */
export const FAILURE = Object.freeze({
  missing: "object missing from store",
  hashMismatch: "object hash mismatch",
  unreachable: "store unreachable",
  noStoreKey: "no store key",
  tooLarge: "file too large",
  noRows: "parse produced no rows",
  gone: "run is gone",
});

/**
 * The closed `partial` vocabulary, in the order it is written, so a second
 * materialize of the same version produces the same array.
 *
 * `pre-parser-fields` is in the vocabulary and is NEVER written here: the
 * parsers report drops, an incomplete tail and a missing sidecar, but nothing
 * in their output says "this runtime version predates a field I read". Writing
 * it would mean inventing a heuristic over `runtimeVersion`, which is the
 * invention §23.3 forbids. It stays reserved for a reader that has the
 * evidence.
 */
export const PARTIAL = Object.freeze([
  "sidecar-missing",
  "no-envelope",
  "pre-parser-fields",
  "unknown-line-types",
  "row-cap-reached",
  "incomplete-tail",
]);

/** A failure with a phrase from FAILURE, thrown where it is decided. */
class Refusal extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const integer = (value, fallback = null) => (Number.isInteger(value) ? value : fallback);
const text = (value, fallback = "") => (typeof value === "string" ? value : fallback);

/**
 * The request door is another agent's route, so every field is read
 * defensively and nothing is assumed beyond `requestId`.
 *
 * `fromLine` is the door's, not the file's: an evicted run's stored cursor sits
 * at the end of the file while its rows are gone, so the line to resume from is
 * a fact about the RECORD, which only the door can state.
 */
export function normalizeRequest(raw) {
  if (!raw || typeof raw !== "object") return null;
  const requestId = text(raw.requestId);
  if (!requestId) return null;
  const runId = text(raw.runId);
  const runner = raw.runner === "codex" ? "codex" : "claude";
  const host = raw.host === "box" ? "box" : "laptop";
  const source = raw.file && typeof raw.file === "object" ? raw.file : {};
  const prefix = `${runner}:${host}:`;
  const threadId = text(raw.threadId) || (runId.startsWith(prefix) ? runId.slice(prefix.length) : "");
  const committedLine = Math.max(0, integer(source.committedLine, 0));
  const hasRows = raw.hasRows === true;
  return {
    requestId,
    runId,
    runner,
    host,
    threadId,
    slice: Math.max(1, integer(raw.slice, 1)),
    parentRunId: text(raw.parentRunId) || null,
    depth: integer(raw.depth, null),
    hasRows,
    // A run with no rows resumes at zero whatever its cursor says.
    fromLine: Math.max(0, integer(raw.fromLine, hasRows ? committedLine : 0)),
    // Attachment pointers, when the door carries them, so a materialize does
    // not replace what the importer recorded with an empty array.
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    file: {
      path: text(source.path),
      sourceHash: text(source.sourceHash),
      storedHash: text(source.storedHash),
      bytes: Math.max(0, integer(source.bytes, 0)),
      storedBytes: Math.max(0, integer(source.storedBytes, 0)),
      committedLine,
      committedPrefixSha256: text(source.committedPrefixSha256),
      storeKey: text(source.storeKey) || null,
      sidecarStoredHash: SHA256.test(text(source.sidecarStoredHash)) ? source.sidecarStoredHash : null,
      totalLines: integer(source.totalLines, null),
      incompleteTail: source.incompleteTail === true,
    },
  };
}

/**
 * RULE M — how a page names the cursor without ever regressing it.
 *
 * `internalIngest` refuses a page whose previous pair is not what Convex holds,
 * refuses a committedLine below what it holds, and refuses an equal
 * committedLine under a different prefix hash. So a line at or below the stored
 * cursor is named by the STORED pair verbatim — re-ingesting an evicted run's
 * rows then moves no cursor and the fence is an identity check — and a line
 * past it is named by the redacted prefix the sweeper would compute for the
 * same line. Both halves are defined over the store's bytes, which is what
 * makes "evict, materialize again, identical rows" true.
 */
export function cursorFactory(stored, storeBytes) {
  return (line) => (line <= stored.committedLine
    ? { committedLine: stored.committedLine, committedPrefixSha256: stored.committedPrefixSha256 }
    : { committedLine: line, committedPrefixSha256: prefixSha256(storeBytes, line) });
}

/**
 * The ingest door refuses a row that arrives already stamped: the stamp is the
 * proof the chunks were reassembled, and only the stamp route can give it.
 * (sweep.mjs keeps the same split for the same reason; it is not exported.)
 */
function splitOverflow(rows) {
  const overflows = [];
  const wireRows = rows.map((row) => {
    if (!row.overflow?.chunks) return row;
    overflows.push({ seq: row.seq, sha256: row.overflow.sha256, byteLength: row.overflow.byteLength, chunks: row.overflow.chunks });
    const { overflow: _stamped, ...wire } = row;
    return wire;
  });
  return { rows: wireRows, overflows };
}

/**
 * Stop at a LINE boundary, never mid-line: a line's rows share one cursor, so
 * half a line in the record would be a cursor that names lines the record does
 * not hold. A single line carrying more rows than the whole cap is kept whole
 * and exceeds it once, because the alternative is a slice that never advances.
 */
export function capRows(rows, maxRows) {
  if (rows.length <= maxRows) return { rows, capped: false, toLine: null };
  const lineOf = (row) => row.provenance.lineEnd;
  let end = maxRows;
  while (end > 0 && lineOf(rows[end]) === lineOf(rows[end - 1])) end -= 1;
  if (end === 0) {
    end = 1;
    while (end < rows.length && lineOf(rows[end]) === lineOf(rows[end - 1])) end += 1;
  }
  return { rows: rows.slice(0, end), capped: true, toLine: lineOf(rows[end - 1]) + 1 };
}

/** The run's stored file descriptor, with this page's cursor merged in. */
function fileDescriptor(file, cursor, totalLines) {
  return {
    path: file.path,
    sourceHash: file.sourceHash,
    storedHash: file.storedHash,
    // Never shrink: the descriptor's bytes are the version's own.
    bytes: file.bytes,
    storedBytes: file.storedBytes,
    committedLine: cursor.committedLine,
    committedPrefixSha256: cursor.committedPrefixSha256,
    ...(file.sidecarStoredHash ? { sidecarStoredHash: file.sidecarStoredHash } : {}),
    ...(file.storeKey ? { storeKey: file.storeKey } : {}),
    ...(file.incompleteTail ? { incompleteTail: true } : {}),
    ...(Number.isInteger(totalLines) ? { totalLines } : {}),
  };
}

function pageBoundaries(rows, pages, { fromLine, toLine }) {
  const list = [];
  let previous = fromLine;
  for (let page = 0; page < pages; page += 1) {
    const slice = rows.slice(page * PAGE_ROWS, (page + 1) * PAGE_ROWS);
    // The last page's boundary is the slice's own end, so the answer's span and
    // the cursor say the same thing.
    const line = page === pages - 1 ? toLine : Math.max(previous, ...slice.map((row) => row.provenance.lineEnd + 1));
    list.push(line);
    previous = line;
  }
  return list;
}

export function materializePages({ result, rows, file, storeBytes, stored, fromLine, toLine, totalLines }) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_ROWS));
  const boundaries = pageBoundaries(rows, pages, { fromLine, toLine });
  const cursorAt = cursorFactory(stored, storeBytes);
  return Array.from({ length: pages }, (_, page) => {
    const split = splitOverflow(rows.slice(page * PAGE_ROWS, (page + 1) * PAGE_ROWS));
    return {
      boundary: boundaries[page],
      overflows: split.overflows,
      payload: {
        run: { ...result.run, file: fileDescriptor(file, cursorAt(boundaries[page]), totalLines) },
        rows: split.rows,
        // Child edges are idempotent stub inserts, so every page may carry
        // them; the sweeper pages the same way.
        children: result.children,
      },
    };
  });
}

/**
 * A store error's own words never leave this function: the message is read to
 * decide which fixed phrase the record gets, and then dropped.
 */
function storeFailure(error) {
  const message = String(error?.message ?? error);
  if (/hash mismatch/i.test(message)) return FAILURE.hashMismatch;
  if (/not found|no such file|enoent|404/i.test(message)) return FAILURE.missing;
  return FAILURE.unreachable;
}

async function getObject(store, args) {
  try {
    return Buffer.from(await store.get(args));
  } catch (error) {
    throw new Refusal(storeFailure(error));
  }
}

/**
 * A Claude subagent's sidecar carries its depth and its spawning tool call. A
 * MISSING one is not a failure: the run opens with what it has, the parser
 * emits its own `subagent sidecar is missing or malformed` error row where a
 * reader will see it, and the answer says `sidecar-missing`.
 */
async function readSidecar(store, request) {
  const { sidecarStoredHash } = request.file;
  if (!sidecarStoredHash) return null;
  try {
    const bytes = await store.get({ runtime: request.runner, threadId: request.threadId, host: request.host, fileVersion: sidecarStoredHash, kind: "sidecar" });
    const meta = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return meta && typeof meta === "object" ? meta : null;
  } catch {
    return null;
  }
}

function droppedCounts(dropped) {
  const entries = Object.entries(dropped ?? {});
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  // A blank line is not an unknown line type — the parser has a rule for it
  // (skip it) — so it must not make the record claim the file holds shapes the
  // parser did not understand. It stays inside `droppedLines` because line
  // accounting is only conserved when every source line is a row or a drop.
  const unknown = entries.reduce((sum, [kind, count]) => (kind === "_blank" ? sum : sum + count), 0);
  return { total, unknown };
}

function partialFor({ result, file, sidecarMissing, capped, slice, maxSlices }) {
  const list = [];
  if (sidecarMissing) list.push("sidecar-missing");
  // The registration envelope did not exist when a backlog file was written.
  if (result.run.context?.layersKnown === false) list.push("no-envelope");
  if (droppedCounts(result.dropped).unknown > 0) list.push("unknown-line-types");
  // Only the last allowed slice leaves the run short for good; an earlier cap
  // is continued by the answer route.
  if (capped && slice >= maxSlices) list.push("row-cap-reached");
  if (result.incompleteTail || file.incompleteTail) list.push("incomplete-tail");
  // The vocabulary fixes the order too, so a second materialize of the same
  // version writes the same array and not merely the same set.
  return list.sort((a, b) => PARTIAL.indexOf(a) - PARTIAL.indexOf(b));
}

/**
 * Fetch, parse and ingest one request. Never throws: every exit is an outcome
 * the caller can write as an answer.
 */
export async function materializeOnce(request, {
  store,
  post,
  now = Date.now,
  log = () => {},
  dryRun = false,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxRows = MAX_MATERIALIZE_ROWS,
  maxSlices = MAX_SLICES,
} = {}) {
  const file = request.file;
  // Which half of the job an unexpected throw came from. The closed vocabulary
  // has one word for anything network-shaped and one for anything the parser
  // could not turn into rows.
  let stage = "fetch";
  try {
    if (!request.runId || !request.threadId) throw new Refusal(FAILURE.gone);
    if (!file.storeKey || !SHA256.test(file.storedHash)) throw new Refusal(FAILURE.noStoreKey);
    if (file.bytes > maxFileBytes) throw new Refusal(FAILURE.tooLarge);

    const storeBytes = await getObject(store, { runtime: request.runner, threadId: request.threadId, host: request.host, fileVersion: file.storedHash, kind: "transcript" });
    if (storeBytes.length > maxFileBytes) throw new Refusal(FAILURE.tooLarge);

    const isClaudeSubagent = request.runner === "claude" && request.threadId.includes("/");
    let agentMeta = null;
    let sidecarMissing = false;
    if (isClaudeSubagent) {
      agentMeta = await readSidecar(store, request);
      if (agentMeta) agentMeta = { ...agentMeta, agentId: request.threadId.split("/").at(-1) };
      else sidecarMissing = true;
    }

    stage = "parse";
    // The parse reads the STORE's redacted bytes from the request's line on,
    // with `baseLine` the same, so every seq and every provenance line number
    // is the source's own and a second materialize produces identical rows.
    const common = {
      path: file.path,
      text: textFromLine(storeText(storeBytes), request.fromLine),
      host: request.host,
      fileVersion: file.storedHash,
      baseLine: request.fromLine,
    };
    const result = request.runner === "codex"
      ? parseCodexFile(common)
      : parseClaudeFile({
        ...common,
        attachments: request.attachments,
        ...(isClaudeSubagent
          ? {
            agentMeta,
            parentSessionId: request.threadId.split("/")[0],
            sidecar: file.sidecarStoredHash ? { storedHash: file.sidecarStoredHash } : null,
          }
          : {}),
      });
    if (result.rows.length === 0) throw new Refusal(FAILURE.noRows);
    // The stored object must name the run the record asked about. A row's
    // digest folds its runId in, so rewriting the id here would produce rows
    // that disagree with the same file parsed anywhere else — the one thing
    // this job exists to make impossible. (It happens when a Claude subagent
    // file carries no agentId and its sidecar is gone: the parser then honestly
    // says `.../unknown`.) The record asked for a run this object does not
    // hold, so the request is answered and the queue moves on.
    if (result.run.runId !== request.runId) {
      log(`runs-materialize run=${request.runId} slice=${request.slice} stored version names another run`);
      throw new Refusal(FAILURE.gone);
    }

    // We read the object from `fromLine` to its end, so its whole length is
    // known even when the row cap stops this slice short of it.
    const totalLines = result.lastLine;
    const capped = capRows(result.rows, maxRows);
    const rows = capped.rows;
    const toLine = capped.capped ? capped.toLine : totalLines;
    const stored = {
      committedLine: file.committedLine,
      committedPrefixSha256: SHA256.test(file.committedPrefixSha256)
        ? file.committedPrefixSha256
        : prefixSha256(storeBytes, file.committedLine),
    };
    const rowsSource = {
      from: "store",
      at: now(),
      parserVersion: PARSER_VERSION,
      storeKey: file.storeKey,
      rowsFromLine: request.fromLine,
      rowsToLine: toLine,
      slices: request.slice,
      droppedLines: droppedCounts(result.dropped).total,
      partial: partialFor({ result, file, sidecarMissing, capped: capped.capped, slice: request.slice, maxSlices }),
    };

    if (dryRun) {
      return { status: "served", dryRun: true, rowsIngested: 0, rowsParsed: rows.length, fromLine: request.fromLine, toLine, totalLines, rowsSource };
    }

    stage = "ingest";
    const pages = materializePages({ result, rows, file, storeBytes, stored, fromLine: request.fromLine, toLine, totalLines });
    const cursorAt = cursorFactory(stored, storeBytes);
    let cursor = stored;
    let rowsIngested = 0;
    for (const page of pages) {
      // The page first: Convex refuses a chunk whose run is not yet recorded
      // and a stamp whose message row is not yet there. sweep.mjs delivers in
      // this order for the same reason.
      const response = await post("/runs/ingest", { ...page.payload, previousCommittedLine: cursor.committedLine, previousPrefixSha256: cursor.committedPrefixSha256 });
      if (response?.ok === false) {
        // The refusal phrase is Convex's own fixed word, so it is safe in the
        // local log — and it never reaches the request's `reason`.
        log(`runs-materialize refused run=${request.runId} slice=${request.slice} reason=${text(response.reason, "unknown")}`);
        throw new Error("run ingest refused");
      }
      rowsIngested += integer(response?.inserted, page.payload.rows.length);
      for (const overflow of page.overflows) {
        for (let index = 0; index < overflow.chunks.length; index += 1) {
          await post("/runs/overflow", { runId: request.runId, seq: overflow.seq, index, chunkCount: overflow.chunks.length, text: overflow.chunks[index] });
        }
        const stamped = await post("/runs/overflow/stamp", { runId: request.runId, seq: overflow.seq, sha256: overflow.sha256, byteLength: overflow.byteLength, chunkCount: overflow.chunks.length });
        if (stamped?.ok === false) throw new Error("run overflow stamp refused");
      }
      // The cursor for the next page is the one Convex now holds, read back
      // through Rule M so it is named the same way on both sides of the fence.
      cursor = cursorAt(integer(response?.committedLine, page.boundary));
    }
    return { status: "served", rowsIngested, fromLine: request.fromLine, toLine, totalLines, rowsSource };
  } catch (error) {
    const reason = error instanceof Refusal
      ? error.reason
      : stage === "parse" ? FAILURE.noRows : FAILURE.unreachable;
    return { status: "failed", reason, stage };
  }
}

function answerBody(request, outcome) {
  if (outcome.status === "failed") return { requestId: request.requestId, status: "failed", reason: outcome.reason };
  return {
    requestId: request.requestId,
    status: "served",
    rowsIngested: outcome.rowsIngested,
    fromLine: outcome.fromLine,
    toLine: outcome.toLine,
    totalLines: outcome.totalLines,
    rowsSource: outcome.rowsSource,
  };
}

/**
 * `--run <runId>`: a repair, and the proof. It needs the run's file facts and
 * has no door of its own for them, so it takes the queue's answer when that
 * happens to be the same run, asks the worker-key twin to queue one when it is
 * not, and reads an injected `getRun` when the caller has the facts already.
 */
async function requestForRun(runId, { get, post, getRun }) {
  if (getRun) {
    const request = normalizeRequest(await getRun(runId));
    return request?.runId === runId ? request : null;
  }
  const first = normalizeRequest((await get("/runs/materialize-request"))?.request);
  if (first?.runId === runId) return first;
  await post("/runs/materialize", { runId });
  const second = normalizeRequest((await get("/runs/materialize-request"))?.request);
  return second?.runId === runId ? second : null;
}

function makeLog(stateDir, fs, now) {
  if (!stateDir) return () => {};
  return (message) => {
    const file = path.join(stateDir, "materialize.log");
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      if (fs.statSync(file).size >= LOG_MAX_BYTES) fs.renameSync(file, `${file}.${now()}`);
    } catch {}
    try { fs.appendFileSync(file, `${new Date(now()).toISOString()} ${message}\n`); } catch {}
  };
}

// The sweeper's transport, which it does not export. The key is chosen by the
// route and never named in an error.
async function defaultPost(config, route, body) {
  if (!config.convexSiteUrl || !config.sessionsKey) throw new Error(`missing variables for ${route}`);
  const response = await fetch(`${config.convexSiteUrl.replace(/\/+$/, "")}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Sessions-Key": config.sessionsKey },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw Object.assign(new Error(`${route} failed with HTTP ${response.status}`), { status: response.status });
  return await response.json();
}

async function defaultGet(config, route) {
  if (!config.convexSiteUrl || !config.sessionsKey) throw new Error(`missing variables for ${route}`);
  const response = await fetch(`${config.convexSiteUrl.replace(/\/+$/, "")}${route}`, { headers: { "X-Sessions-Key": config.sessionsKey } });
  if (!response.ok) throw Object.assign(new Error(`${route} failed with HTTP ${response.status}`), { status: response.status });
  return await response.json();
}

export async function serveMaterialize({
  config = runConfig(),
  runId = null,
  dryRun = false,
  fs = fsDefault,
  now = Date.now,
  get,
  post,
  store,
  log,
  getRun,
  maxRows = MAX_MATERIALIZE_ROWS,
  maxSlices = MAX_SLICES,
} = {}) {
  const say = log ?? (dryRun ? () => {} : makeLog(config.stateDir, fs, now));
  const send = post ?? ((route, body) => defaultPost(config, route, body));
  const fetchJson = get ?? ((route) => defaultGet(config, route));
  // The backlog block is another agent's addition to runConfig; until it lands
  // the cap is the same 128 MB the brief fixes.
  const configured = config?.backlog?.maxFileBytes;
  const maxFileBytes = Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_FILE_BYTES;
  const activeStore = store ?? openStore(config.storeConfig);

  let request;
  try {
    request = runId
      ? await requestForRun(runId, { get: fetchJson, post: send, getRun })
      : normalizeRequest((await fetchJson("/runs/materialize-request"))?.request);
  } catch (error) {
    say(`runs-materialize could not read the queue: ${error?.status ? `HTTP ${error.status}` : "network error"}`);
    return { started: true, empty: true, reason: "queue unreadable" };
  }
  if (!request) {
    say(runId ? "runs-materialize found no request for that run" : "runs-materialize queue empty");
    return { started: true, empty: true };
  }

  const outcome = await materializeOnce(request, { store: activeStore, post: send, now, log: say, dryRun, maxFileBytes, maxRows, maxSlices });
  if (dryRun) {
    say(`runs-materialize dry-run run=${request.runId} slice=${request.slice} status=${outcome.status} rows=${outcome.rowsParsed ?? 0}`);
    return { started: true, dryRun: true, request: request.requestId, ...outcome };
  }

  // The answer is the last act, and it is not optional: a request left pending
  // blocks everything behind it.
  let answered = false;
  try {
    await send("/runs/materialize-answer", answerBody(request, outcome));
    answered = true;
  } catch (error) {
    say(`runs-materialize could not answer run=${request.runId} slice=${request.slice}: ${error?.status ? `HTTP ${error.status}` : "network error"}`);
  }
  say(`runs-materialize run=${request.runId} slice=${request.slice} status=${outcome.status}${outcome.status === "served" ? ` rows=${outcome.rowsIngested} lines=${outcome.fromLine}-${outcome.toLine}/${outcome.totalLines}` : ` reason=${outcome.reason}`} answered=${answered}`);
  return { started: true, answered, request: request.requestId, ...outcome };
}

function argsOf(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--serve") options.serve = true;
    else if (argv[index] === "--run") options.runId = argv[++index];
    else if (argv[index] === "--dry-run") options.dryRun = true;
  }
  return options;
}

async function main() {
  const options = argsOf(process.argv.slice(2));
  if (!options.serve && !options.runId) {
    console.error("usage: node worker/runs/materialize.mjs --serve [--dry-run] | --run <runId>");
    process.exitCode = 2;
    return;
  }
  const result = await serveMaterialize({ runId: options.runId ?? null, dryRun: Boolean(options.dryRun) });
  // A repair that found no request did not repair anything; an empty queue is
  // the normal state of a one-minute tick.
  if (options.runId && result.empty) process.exitCode = 1;
  if (result.started && result.answered === false) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`runs-materialize could not start: ${String(error?.message ?? error).slice(0, 200)}`);
    process.exitCode = 1;
  });
}
