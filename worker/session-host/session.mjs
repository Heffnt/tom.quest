// session.mjs — one live Claude Code session: the SDK query and its streaming
// input queue, seq/turn assignment, the outbox + flush machinery (ONE ingest
// per ~400ms carrying everything that changed), and the permission gate.
// session-host.mjs owns the poll loop and the Session map; everything
// per-session lives here.
//
// STATE MODEL IN ONE BREATH: Convex owns all durable state; this class holds
// only the in-flight mirror. Every row we create is assigned a seq from a
// local counter seeded by the server's nextSeq, queued in an outbox, and
// flushed; the server drops any seq below its floor, so a failed ingest is
// retried BLINDLY and double-delivery is impossible. Losing this process
// loses at most the current turn (the restart path in session-host.mjs says
// so in a system row and resumes by sdkSessionId on the next user turn).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  log,
  sessionsFetch,
  sleep,
  backoffMs,
  truncated,
  ERROR_TEXT_LIMIT,
} from "./lib.mjs";

const execFile = promisify(execFileCb);

// Session workdirs live under /var/cache by the box's convention: everything
// under /var/cache/dts is rebuildable, so `rm -rf` of any of it is harmless
// (the no-state rule). A session's real output leaves through git pushes /
// whatever Tom asks the model to do — never through files that stay here.
export const SESSIONS_ROOT = "/var/cache/dts/sessions";

// The repos a session may check out (claudeSessions.repo). Everything is
// under github.com/Heffnt — same owner the code-todo jobs use.
const REPO_GITHUB = {
  "tom.quest": "Heffnt/tom.quest",
  ComplexMultiTrigger: "Heffnt/ComplexMultiTrigger",
  WikiTom: "Heffnt/WikiTom",
};

// The live-tail buffer segment-finalizes past this size so the hot
// claudeStreamBuf row stays small forever (matches the schema's ~16KB note).
const BUF_SEGMENT_BYTES = 16 * 1024;
// Stream-delta flush cadence. Immediate events (turn boundary, tool_use,
// permission, status change, error) bypass it.
const FLUSH_THROTTLE_MS = 400;

// ── Permission posture (ratified by Tom) ─────────────────────────────────────
// AUTO-ALLOW: pure reads, always safe anywhere.
const AUTO_ALLOW_TOOLS = new Set(["Read", "Glob", "Grep"]);
// File-editing tools: auto-allowed IFF the target resolves inside the session
// workdir, auto-DENIED with a corrective message otherwise — this is the
// handler for the observed gotcha where the model writes to hallucinated
// absolute paths (/Users/…, /tmp/…) before checking cwd. MultiEdit is
// included because it is the same class of tool as Edit in current CLIs.
const EDIT_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "MultiEdit"]);
// Everything else (Bash, WebFetch/WebSearch, MCP, unrecognized) prompts Tom.

// ── Small utilities ──────────────────────────────────────────────────────────

// Run one git command in `dir`. Async so a slow clone/fetch never blocks the
// event loop (other sessions keep streaming). Errors carry stderr — see
// gitErrorText.
async function git(dir, ...args) {
  const { stdout } = await execFile("git", ["-C", dir, ...args], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

// The verbatim error text the spec wants in endedReason: execFile's message
// (command + exit code) plus git's stderr, which is where git actually says
// what went wrong.
export function gitErrorText(err) {
  const msg = String(err?.message ?? err).trim();
  const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
  return stderr && !msg.includes(stderr) ? `${msg}\n${stderr}` : msg;
}

// Awaitable FIFO feeding the SDK's streaming-input generator. push() wakes a
// pending next(); close() ends the generator (which ends the SDK session
// cleanly — the validated shutdown path).
class TurnQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  push(item) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }
  async next() {
    if (this.items.length > 0) return { value: this.items.shift(), done: false };
    if (this.closed) return { value: undefined, done: true };
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

// The async generator the SDK consumes as `prompt`. Kept alive between turns
// by awaiting the queue — this is what lets one query() span many user turns.
async function* promptStream(queue) {
  for (;;) {
    const { value, done } = await queue.next();
    if (done) return;
    yield {
      type: "user",
      message: { role: "user", content: value },
      parent_tool_use_id: null,
    };
  }
}

// ── The Session class ────────────────────────────────────────────────────────

export class Session {
  constructor({ id, repo, env, nextSeq }) {
    this.id = id;
    this.repo = repo;
    this.env = env;

    // Daemon-owned counters. `turn` groups rows for rendering; it seeds from
    // nextSeq because any previous daemon's turn numbers are strictly less
    // than the count of rows it wrote (= nextSeq), so seeding here keeps
    // turns monotonic across daemon restarts without reading the transcript
    // back (which would violate poll-only bootstrap).
    this.nextSeq = nextSeq;
    this.turn = nextSeq;

    // Local mirror of the daemon-reported status ("starting" | "idle" |
    // "running" | "awaiting-permission" | "ended" | "failed").
    this.status = "starting";
    this.sdkSessionId = undefined;
    this.workdir = undefined;

    // The live SDK query (or null between resumable turns — after interrupt
    // or an iterator error the query object is dead and the NEXT user turn
    // starts a fresh query({ resume })).
    this.q = null;
    this.queue = null;
    this.abort = null; // AbortController — force-kill only (hard, dangling tool_use)
    this.interruptRequested = false;
    this.stopRequested = false;
    this.reportedTerminal = false; // we sent ended/failed; don't self-force-kill on the echo

    // Streaming text buffer (the claudeStreamBuf mirror).
    this.bufText = "";
    this.bufDirty = false;
    // Segments finalized since the last complete assistant message — lets the
    // text-block fallback know whether block.text would duplicate content.
    this.segmentsSinceAssistant = 0;

    // Outbox: everything awaiting ingest. Arrays are drained by flush and
    // re-prepended on failure (order matters for finalize: seq-ascending).
    this.outbox = {
      finalize: [],
      inboundUpdates: [],
      permissionRequests: [],
      permissionUpdates: [],
    };
    this.statusToSend = undefined;
    this.endedReasonToSend = undefined;
    this.sdkSessionIdToSend = undefined;
    this.cwdToSend = undefined;
    this.lastSdkEventAt = undefined;
    this.lastSdkEventAtDirty = false;

    // Flush machinery: one in-flight ingest per session, ever.
    this.flushTimer = null;
    this.flushInFlight = false;
    this.flushAgain = false;
    this.flushImmediateAgain = false;
    this.ingestAttempt = 0;

    // Command / permission bookkeeping.
    this.processedInbound = new Set(); // inbound _ids already acted on locally
    this.activeUserTurnId = null; // delivered user-turn awaiting its result
    this.permissionWaiters = new Map(); // requestId -> { resolve, input }
    this.serverInbound = []; // latest pending inbound rows from server
    // Synchronous in-flight guard for #deliverUserTurn (review fix: the
    // status gate in processCommands stays "idle" across the awaited
    // ensureWorkdir, so two pending user-turns could start two concurrent
    // deliveries without this).
    this.delivering = false;

    // Most recent PERMANENT ingest rejection (server's error text) — reported
    // to the server via the poll body's lastIngestError, then cleared by the
    // poll loop once sent (review fix: permanent-400 wedge).
    this.lastIngestError = undefined;
    this.lastIngestErrorAt = 0;

    this.lastActivityAt = Date.now();
    this.dead = false; // force-killed / reaped; ignore stragglers
  }

  // ── tiny state helpers ─────────────────────────────────────────────────────

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.statusToSend = status;
    if (status === "ended" || status === "failed") this.reportedTerminal = true;
  }

  finalizeRow(kind, content) {
    const seq = this.nextSeq++;
    this.outbox.finalize.push({ seq, turn: this.turn, kind, content });
    return seq;
  }

  // SDK produced something: update the lastSdkEventAt fact (rides along on
  // the next flush — never triggers one by itself) and the activity clock
  // (drives the main loop's 1s cadence window).
  touch() {
    this.lastSdkEventAt = Date.now();
    this.lastSdkEventAtDirty = true;
    this.lastActivityAt = Date.now();
  }

  // Anything still unflushed? The main loop keeps a terminal session around
  // until this is false so its last ingest lands.
  isDrained() {
    return (
      !this.flushInFlight &&
      this.outbox.finalize.length === 0 &&
      this.outbox.inboundUpdates.length === 0 &&
      this.outbox.permissionRequests.length === 0 &&
      this.outbox.permissionUpdates.length === 0 &&
      this.statusToSend === undefined &&
      !this.bufDirty
    );
  }

  // ── workdir ────────────────────────────────────────────────────────────────

  // Create (or re-create) this session's working directory.
  //   repo "none"  -> /var/cache/dts/sessions/<id>/ws       (empty scratch)
  //   repo known   -> /var/cache/dts/sessions/<id>/<repo>   (fresh shallow
  //                   clone on branch session/<id>)
  // forResume marks the bootstrap-after-restart path: if the dir vanished we
  // rebuild it and say so in a system row — the transcript must never imply
  // continuity the filesystem doesn't have.
  async ensureWorkdir({ forResume = false } = {}) {
    const base = path.join(SESSIONS_ROOT, String(this.id));

    if (this.repo === "none") {
      const dir = path.join(base, "ws");
      const existed = fs.existsSync(dir);
      fs.mkdirSync(dir, { recursive: true });
      if (forResume && !existed) {
        this.finalizeRow("system", {
          text: "workspace was missing and was rebuilt as an empty scratch directory — files from before the rebuild are gone",
        });
      }
      this.workdir = dir;
      return;
    }

    const gh = REPO_GITHUB[this.repo];
    if (!gh) {
      throw new Error(
        `unknown repo "${this.repo}" — expected one of ${Object.keys(REPO_GITHUB).join(", ")}, or "none"`,
      );
    }
    const dir = path.join(base, this.repo);
    if (fs.existsSync(path.join(dir, ".git"))) {
      // Still here from before (normal between-turns case) — reuse as-is.
      this.workdir = dir;
      return;
    }
    // Missing or half-created (an interrupted clone leaves a dir with no
    // .git) — start over; rm -rf under /var/cache is free by definition.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(base, { recursive: true });
    // Token rides in the URL (the x-access-token convention, same as the
    // code-todo jobs) — acceptable because the URL never leaves this
    // root-only box and the dir is deleted when the session ends.
    const url = this.env.GH_TOKEN
      ? `https://x-access-token:${this.env.GH_TOKEN}@github.com/${gh}.git`
      : `https://github.com/${gh}.git`;
    const branch = `session/${this.id}`;
    await execFile("git", ["clone", "--depth", "1", url, dir], {
      maxBuffer: 8 * 1024 * 1024,
    });
    if (forResume) {
      // If earlier work on this session was pushed, pick the branch back up;
      // otherwise start it fresh and tell the transcript what was lost.
      try {
        await git(dir, "fetch", "--depth", "1", "origin", branch);
        await git(dir, "checkout", "-b", branch, "FETCH_HEAD");
      } catch {
        await git(dir, "checkout", "-b", branch);
        this.finalizeRow("system", {
          text: `workspace was rebuilt from a fresh clone; branch ${branch} was not on the remote, so unpushed work from before the rebuild is gone`,
        });
      }
    } else {
      await git(dir, "checkout", "-b", branch);
    }
    this.workdir = dir;
  }

  // Best-effort teardown. Losing this dir loses nothing durable (no-state
  // rule) — that is precisely why deleting it is safe here.
  cleanupWorkdir() {
    try {
      fs.rmSync(path.join(SESSIONS_ROOT, String(this.id)), {
        recursive: true,
        force: true,
      });
    } catch (err) {
      log(`session ${this.id}: workdir cleanup failed (ignored):`, String(err));
    }
  }

  // ── the SDK query ──────────────────────────────────────────────────────────

  startQuery({ resume } = {}) {
    this.queue = new TurnQueue();
    this.abort = new AbortController();
    this.interruptRequested = false;
    const q = query({
      prompt: promptStream(this.queue),
      options: {
        cwd: this.workdir,
        includePartialMessages: true,
        permissionMode: "default",
        abortController: this.abort,
        canUseTool: (toolName, input, opts) =>
          this.#canUseTool(toolName, input, opts),
        ...(resume ? { resume } : {}),
      },
    });
    this.q = q;
    void this.#readLoop(q);
  }

  async #readLoop(q) {
    let failedTurn = false;
    try {
      for await (const m of q) {
        if (this.dead) break;
        this.#handleMessage(m);
      }
      // Generator ended cleanly (stop path) — #doStop owns the transitions.
    } catch (err) {
      if (this.dead) return;
      if (this.interruptRequested || this.stopRequested) {
        // Expected: q.interrupt() resolves and then the iterator throws
        // ("error result"). The session is cleanly resumable by id.
      } else if (this.abort?.signal.aborted) {
        // Force-kill; whoever aborted also reports (or the server already
        // considers the session terminal). Nothing to persist.
      } else {
        // Real SDK/iterator error. Persist it verbatim and leave the session
        // IDLE — resumable — for every flavor: usage-limit errors resolve by
        // Tom switching accounts and sending the next turn (which resumes by
        // id); anything else is at worst a failed resume attempt later.
        // Only spawn/clone failures mark a session "failed" (see the claim
        // and deliver paths).
        failedTurn = true;
        // 8KB cap: an SDK error message must never be big enough to have its
        // own ingest rejected (review fix: unbounded error text).
        const msg = truncated(String(err?.message ?? err), ERROR_TEXT_LIMIT).value;
        this.finalizeRow("error", { message: msg });
        log(`session ${this.id}: SDK error:`, msg);
      }
    } finally {
      if (this.q === q) {
        this.q = null;
        this.queue = null;
      }
      if (!this.dead && !this.stopRequested && this.status !== "ended" && this.status !== "failed") {
        this.#turnDied(failedTurn);
      }
    }
  }

  // The current turn ended abnormally (interrupt or SDK error). Preserve any
  // streamed-but-unfinalized text (nothing-ever-lost), settle the delivered
  // inbound row, go idle, and see whether another command is already queued.
  #turnDied(wasError) {
    if (this.bufText !== "") {
      this.finalizeRow("assistant-text", { text: this.bufText });
      this.bufText = "";
    }
    this.bufDirty = true; // clear the live tail server-side
    // Settle any parked permission waiters (review fix: interrupt/stop/kill
    // all supersede parked permissions but the iterator-error path did not —
    // the canUseTool promise leaked and the server row stayed pending,
    // pinning a dead Allow/Deny card in the UI).
    for (const [requestId, waiter] of this.permissionWaiters) {
      this.outbox.permissionUpdates.push({
        requestId,
        status: "expired",
        decidedBy: "turn-died",
        applied: true,
      });
      waiter.resolve({
        behavior: "deny",
        message: "the turn ended before a decision",
      });
    }
    this.permissionWaiters.clear();
    if (this.activeUserTurnId) {
      this.outbox.inboundUpdates.push({
        id: this.activeUserTurnId,
        status: wasError ? "failed" : "interrupted",
      });
      this.activeUserTurnId = null;
    }
    this.setStatus("idle");
    this.requestFlush(true);
    this.processCommands();
  }

  #handleMessage(m) {
    this.touch();
    switch (m.type) {
      case "system": {
        if (m.subtype === "init") {
          // The resume key. Capture + report immediately: from here on, even
          // a kill -9 of this daemon leaves the session resumable.
          this.sdkSessionId = m.session_id;
          this.sdkSessionIdToSend = m.session_id;
          this.cwdToSend = this.workdir;
          if (this.status === "starting") this.setStatus("idle");
          this.requestFlush(true);
          this.processCommands();
        }
        break;
      }
      case "stream_event": {
        const ev = m.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          this.bufText += ev.delta.text;
          this.bufDirty = true;
          if (Buffer.byteLength(this.bufText, "utf8") > BUF_SEGMENT_BYTES) {
            // Segment-finalize: the buffer becomes a permanent row at its
            // reserved seq and a fresh buffer starts at the next seq — the
            // hot claudeStreamBuf row stays bounded no matter how long the
            // model talks.
            this.finalizeRow("assistant-text", { text: this.bufText });
            this.segmentsSinceAssistant += 1;
            this.bufText = "";
          }
          this.requestFlush(false);
        }
        break;
      }
      case "assistant": {
        // A complete assistant message: thinking + text + tool_use blocks.
        const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
        for (const b of blocks) {
          if (b.type === "thinking") {
            const t = truncated(b.thinking);
            this.finalizeRow("thinking", {
              text: t.value,
              ...(t.note ? { truncationNote: t.note } : {}),
            });
          } else if (b.type === "text") {
            // The streamed buffer IS this block's text (minus any 16KB
            // segments already finalized), so finalize the buffer rather
            // than block.text — using block.text would duplicate segments.
            if (this.bufText !== "") {
              this.finalizeRow("assistant-text", { text: this.bufText });
              this.bufText = "";
              this.bufDirty = true;
            } else if (this.segmentsSinceAssistant === 0 && b.text) {
              // No deltas ever arrived for this block (shouldn't happen with
              // includePartialMessages, but text must never be lost).
              this.finalizeRow("assistant-text", { text: b.text });
            }
            this.segmentsSinceAssistant = 0;
          } else if (b.type === "tool_use") {
            const t = truncated(b.input);
            this.finalizeRow("tool-call", {
              toolName: b.name,
              toolUseId: b.id,
              input: t.value,
              ...(t.note ? { truncationNote: t.note } : {}),
            });
          }
        }
        this.requestFlush(true); // immediate: tool_use / message boundary
        break;
      }
      case "user": {
        // Tool results fed back to the model.
        const blocks = m.message?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b.type === "tool_result") {
              const t = truncated(b.content);
              this.finalizeRow("tool-result", {
                toolUseId: b.tool_use_id,
                content: t.value,
                ...(b.is_error ? { isError: true } : {}),
                ...(t.note ? { truncationNote: t.note } : {}),
              });
            }
          }
          this.requestFlush(false);
        }
        break;
      }
      case "result": {
        // Turn boundary. Belt-and-braces buffer finalize (the assistant
        // handler normally already drained it), then clear the live tail.
        if (this.bufText !== "") {
          this.finalizeRow("assistant-text", { text: this.bufText });
          this.bufText = "";
        }
        this.bufDirty = true;
        this.segmentsSinceAssistant = 0;
        if (m.is_error || (m.subtype && m.subtype !== "success")) {
          // Error results carry the cost fact too (spec: cost is persisted
          // ONLY on error rows).
          this.finalizeRow("error", {
            subtype: m.subtype,
            result: truncated(m.result ?? "").value,
            total_cost_usd: m.total_cost_usd,
          });
        }
        if (this.activeUserTurnId) {
          this.outbox.inboundUpdates.push({
            id: this.activeUserTurnId,
            status: "done",
          });
          this.activeUserTurnId = null;
        }
        if (!this.stopRequested) this.setStatus("idle");
        this.requestFlush(true);
        this.processCommands(); // a queued next turn delivers right away
        break;
      }
      default:
        break;
    }
  }

  // ── the permission gate (canUseTool) ───────────────────────────────────────

  async #canUseTool(toolName, input, opts = {}) {
    if (AUTO_ALLOW_TOOLS.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    if (EDIT_TOOLS.has(toolName)) {
      const target =
        typeof input?.file_path === "string"
          ? input.file_path
          : typeof input?.notebook_path === "string"
            ? input.notebook_path
            : null;
      if (target !== null && this.workdir) {
        const resolved = path.resolve(this.workdir, target);
        const inside =
          resolved === this.workdir ||
          resolved.startsWith(this.workdir + path.sep);
        if (inside) return { behavior: "allow", updatedInput: input };
        // The hallucinated-absolute-path gotcha: deny with a corrective
        // message (no prompt) — the model reads it and retries in-tree.
        return {
          behavior: "deny",
          message: `write inside the session directory ${this.workdir} — ${resolved} is outside this session's workspace`,
        };
      }
      // Unrecognized input shape for an edit tool — fall through to Tom.
    }

    // Everything else (Bash, WebFetch/WebSearch, MCP, unknown): Tom decides.
    // No park deadline — the SDK verifiably tolerates multi-hour awaits, and
    // an auto-denial at 3 a.m. would make the model take a path Tom never
    // chose. stop/interrupt supersede; daemon restart expires.
    const requestId = crypto.randomUUID();
    const t = truncated(input);
    this.finalizeRow("permission", {
      requestId,
      toolName,
      input: t.value,
      ...(t.note ? { truncationNote: t.note } : {}),
    });
    this.outbox.permissionRequests.push({
      requestId,
      toolName,
      input: t.value,
    });
    this.setStatus("awaiting-permission");
    this.requestFlush(true);
    return await new Promise((resolve) => {
      this.permissionWaiters.set(requestId, { resolve, input });
      if (opts.signal) {
        opts.signal.addEventListener(
          "abort",
          () => {
            // The SDK abandoned the call (turn aborted) — settle the row so
            // it never lingers as pending.
            if (this.permissionWaiters.delete(requestId)) {
              this.outbox.permissionUpdates.push({
                requestId,
                status: "superseded",
                decidedBy: "abort",
                applied: true,
              });
              this.requestFlush(true);
              resolve({
                behavior: "deny",
                message: "turn aborted before Tom decided",
              });
            }
          },
          { once: true },
        );
      }
    });
  }

  // Apply decided permission rows (from a poll row or an ingest piggyback).
  applyDecisions(rows = []) {
    for (const row of rows ?? []) {
      if (row.status !== "allowed" && row.status !== "denied") continue;
      if (row.appliedAt !== undefined && row.appliedAt !== null) continue;
      const waiter = this.permissionWaiters.get(row.requestId);
      if (waiter) {
        this.permissionWaiters.delete(row.requestId);
        if (row.status === "allowed") {
          waiter.resolve({ behavior: "allow", updatedInput: waiter.input });
        } else {
          waiter.resolve({
            behavior: "deny",
            message: row.note || "denied by Tom",
          });
        }
        this.outbox.permissionUpdates.push({
          requestId: row.requestId,
          applied: true,
        });
        if (
          this.status === "awaiting-permission" &&
          this.permissionWaiters.size === 0
        ) {
          this.setStatus("running");
        }
        this.requestFlush(true);
      } else {
        // Decided row with no local waiter — the prompting turn died (daemon
        // restart). Ack `applied` anyway so the server stops piggybacking a
        // decision nobody can consume.
        this.outbox.permissionUpdates.push({
          requestId: row.requestId,
          applied: true,
        });
        this.requestFlush(false);
      }
    }
  }

  // Settle every locally-parked permission as superseded (interrupt/stop).
  supersedePermissions(decidedBy) {
    for (const [requestId, waiter] of this.permissionWaiters) {
      this.outbox.permissionUpdates.push({
        requestId,
        status: "superseded",
        decidedBy,
        applied: true,
      });
      waiter.resolve({
        behavior: "deny",
        message: `superseded by ${decidedBy}`,
      });
    }
    this.permissionWaiters.clear();
  }

  // ── inbound commands ───────────────────────────────────────────────────────

  // Full per-session server state from a poll row: decisions first (they can
  // unblock an awaiting turn), then commands.
  processServerState(row) {
    if (this.dead || this.status === "ended" || this.status === "failed") return;
    if (typeof row.nextSeq === "number" && row.nextSeq > this.nextSeq) {
      // Should be impossible (this daemon is the only seq writer) — bump
      // defensively so future rows aren't dropped by the server's floor.
      log(
        `session ${this.id}: server nextSeq ${row.nextSeq} > local ${this.nextSeq} — bumping`,
      );
      this.nextSeq = row.nextSeq;
      if (this.turn < row.nextSeq) this.turn = row.nextSeq;
    }
    this.applyDecisions(row.permissions);
    this.serverInbound = row.pendingInbound ?? [];
    this.processCommands();
  }

  processCommands() {
    if (this.dead || this.status === "ended" || this.status === "failed") return;
    const rows = [...this.serverInbound].sort((a, b) => a.createdAt - b.createdAt);
    for (const row of rows) {
      if (this.processedInbound.has(row._id)) continue;
      if (row.kind === "interrupt") {
        this.processedInbound.add(row._id);
        void this.#doInterrupt(row);
      } else if (row.kind === "stop") {
        this.processedInbound.add(row._id);
        void this.#doStop(row);
      }
    }
    // Deliver at most ONE user turn, and only when no turn is in flight —
    // "done" acknowledgments need turn boundaries, so turns go one at a time.
    // Delivery from "starting" is deliberate: waiting for the init message
    // would deadlock if the CLI only emits init once a first prompt exists.
    // !this.delivering: the status stays "idle" across #deliverUserTurn's
    // awaited ensureWorkdir, so without this synchronous guard a second
    // pending message could start a concurrent delivery (review fix); it
    // instead waits for the tick after the first delivery completes.
    if (
      (this.status === "idle" || (this.status === "starting" && this.q)) &&
      !this.stopRequested &&
      !this.delivering
    ) {
      const next = rows.find(
        (r) => r.kind === "user-turn" && !this.processedInbound.has(r._id),
      );
      if (next) void this.#deliverUserTurn(next);
    }
  }

  async #deliverUserTurn(row) {
    // Both set BEFORE any await: the add dedupes the row, `delivering` closes
    // the idle-status gate in processCommands until this delivery completes.
    this.processedInbound.add(row._id);
    this.delivering = true;
    try {
      if (!this.q) {
        // Between-queries idle (post-interrupt / post-error / post-restart):
        // rebuild the workdir if it vanished and resume the SDK session by
        // id — context intact (validated even across kill -9).
        await this.ensureWorkdir({ forResume: true });
        // A stop or force-close may have landed during the (slow) rebuild —
        // same race as the claim path (review fix: claim-vs-stop). Their
        // handlers already settled the session; starting a query now would
        // resurrect it.
        if (
          this.dead ||
          this.stopRequested ||
          this.status === "ended" ||
          this.status === "failed"
        ) {
          this.cleanupWorkdir();
          return;
        }
        this.startQuery(
          this.sdkSessionId ? { resume: this.sdkSessionId } : {},
        );
      }
      this.turn += 1;
      this.segmentsSinceAssistant = 0;
      this.finalizeRow("user", { text: row.text ?? "" });
      this.outbox.inboundUpdates.push({ id: row._id, status: "delivered" });
      this.activeUserTurnId = row._id;
      this.queue.push(row.text ?? "");
      this.setStatus("running");
      this.lastActivityAt = Date.now();
      this.requestFlush(true);
    } catch (err) {
      // The stop path already settled everything; don't overwrite "ended".
      if (this.dead || this.status === "ended") return;
      // Workdir rebuild (clone) failed — spawn/clone failures are the one
      // class that marks a session failed (nothing to resume into). 8KB cap
      // on the error text (review fix: unbounded error text).
      const msg = truncated(gitErrorText(err), ERROR_TEXT_LIMIT).value;
      log(`session ${this.id}: deliver failed:`, msg);
      this.finalizeRow("error", { message: msg });
      this.outbox.inboundUpdates.push({ id: row._id, status: "failed" });
      this.setStatus("failed");
      this.endedReasonToSend = msg;
      this.requestFlush(true);
      this.cleanupWorkdir();
    } finally {
      this.delivering = false;
    }
  }

  async #doInterrupt(row) {
    this.outbox.inboundUpdates.push({ id: row._id, status: "done" });
    if (this.q && (this.status === "running" || this.status === "awaiting-permission")) {
      this.interruptRequested = true;
      this.supersedePermissions("interrupt");
      try {
        await this.q.interrupt();
        // The iterator now throws; #readLoop's finally runs #turnDied →
        // idle + flush. Nothing more to do here.
      } catch (err) {
        log(`session ${this.id}: interrupt() rejected:`, String(err));
      }
    } else {
      // Nothing running — just ack the command.
      this.requestFlush(true);
    }
  }

  async #doStop(row) {
    this.stopRequested = true;
    this.outbox.inboundUpdates.push({ id: row._id, status: "done" });
    this.supersedePermissions("stop");
    if (this.q) {
      if (this.status === "running" || this.status === "awaiting-permission") {
        this.interruptRequested = true;
        try {
          await this.q.interrupt();
        } catch {
          // expected-adjacent; the iterator throw is handled in #readLoop
        }
      }
      // Ending the input generator ends the SDK session cleanly (validated
      // shutdown path). After an interrupt the query is already dead and
      // this is a harmless no-op.
      this.queue?.close();
    }
    if (this.bufText !== "") {
      this.finalizeRow("assistant-text", { text: this.bufText });
      this.bufText = "";
    }
    this.bufDirty = true;
    if (this.activeUserTurnId) {
      this.outbox.inboundUpdates.push({
        id: this.activeUserTurnId,
        status: "interrupted",
      });
      this.activeUserTurnId = null;
    }
    this.setStatus("ended");
    this.endedReasonToSend = "stopped by Tom";
    this.requestFlush(true);
    this.cleanupWorkdir();
  }

  // Hard kill: the server considers this session terminal (forceClose) or no
  // longer lists it. One best-effort final flush, then drop all local state —
  // review fix: dead=true alone left status/buf set, so isDrained() was never
  // true, the map entry leaked, and the leaked lastActivityAt pinned the poll
  // cadence at 1s forever.
  forceKill(reason) {
    if (this.dead) return;
    log(`session ${this.id}: force-kill (${reason})`);
    this.dead = true;
    try {
      this.abort?.abort();
    } catch {
      // AbortController.abort() doesn't throw, but stay paranoid
    }
    this.queue?.close();
    for (const [, waiter] of this.permissionWaiters) {
      waiter.resolve({ behavior: "deny", message: "session closed" });
    }
    this.permissionWaiters.clear();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Best-effort final flush of whatever was pending: short timeout, errors
    // ignored (the server already considers us terminal; this only tries to
    // land the tail of the transcript). Fire-and-forget — never blocks.
    const snap = this.#takeOutbox();
    if (snap) {
      void sessionsFetch(this.env, "/sessions/ingest", snap.payload, {
        timeoutMs: 5_000,
      }).catch((err) => {
        log(
          `session ${this.id}: final flush after force-kill failed (ignored):`,
          String(err?.message ?? err),
        );
      });
    }
    // Drop everything local so the reaper can delete this entry.
    this.outbox = {
      finalize: [],
      inboundUpdates: [],
      permissionRequests: [],
      permissionUpdates: [],
    };
    this.bufDirty = false;
    this.statusToSend = undefined;
    this.status = "ended"; // local only — never sent; the server's word was final
    this.cleanupWorkdir();
  }

  // ── flush machinery ────────────────────────────────────────────────────────

  requestFlush(immediate = false) {
    if (this.dead) return;
    if (this.flushInFlight) {
      this.flushAgain = true;
      if (immediate) this.flushImmediateAgain = true;
      return;
    }
    if (immediate) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      void this.#flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.#flush();
      }, FLUSH_THROTTLE_MS);
    }
  }

  // Drain the outbox: ONE ingest at a time, looping until nothing is left.
  // Failures back off and blind-retry (safe: the server's seq floor drops
  // replays; inbound/permission updates are idempotent patches). The loop
  // never throws — an unreachable Convex must never crash the daemon.
  async #flush() {
    if (this.dead || this.flushInFlight) return;
    this.flushInFlight = true;
    try {
      for (;;) {
        if (this.dead) break;
        const snap = this.#takeOutbox();
        if (!snap) break;
        try {
          const res = await sessionsFetch(this.env, "/sessions/ingest", snap.payload);
          this.ingestAttempt = 0;
          this.#handleIngestResponse(res);
        } catch (err) {
          // A 4xx other than 408/429 is PERMANENT (validation error,
          // oversized document): retrying the identical payload would wedge
          // this session's outbox forever (review fix: permanent-400 wedge).
          // Drop the payload, record the loss honestly, continue normally.
          const status = err?.status;
          const permanent =
            typeof status === "number" &&
            status >= 400 &&
            status < 500 &&
            status !== 408 &&
            status !== 429;
          if (permanent) {
            const errText = String(err?.bodyText ?? err?.message ?? err).slice(0, 300);
            log(
              `session ${this.id}: ingest REJECTED (HTTP ${status}) — dropping payload permanently:`,
              errText,
            );
            // Reported to the server on the next poll (see session-host.mjs).
            this.lastIngestError = errText;
            this.lastIngestErrorAt = Date.now();
            // Tiny finalize row so the transcript records the loss — unless
            // the dropped payload WAS such a row (a loss report that itself
            // gets rejected must not spawn loss reports forever).
            const wasLossReport =
              snap.payload.finalize?.length === 1 &&
              snap.payload.finalize[0].kind === "error" &&
              String(snap.payload.finalize[0].content?.message ?? "").startsWith(
                "a transcript flush was rejected and dropped",
              );
            if (!wasLossReport) {
              this.finalizeRow("error", {
                message: `a transcript flush was rejected and dropped: ${errText}`,
              });
            }
            this.ingestAttempt = 0;
            continue;
          }
          // 5xx / network / timeout: transient — restore and blind-retry.
          this.#restoreOutbox(snap);
          this.ingestAttempt += 1;
          const delay = backoffMs(this.ingestAttempt);
          log(
            `session ${this.id}: ingest failed (attempt ${this.ingestAttempt}, retry in ${delay}ms):`,
            String(err?.message ?? err),
          );
          await sleep(delay);
        }
      }
    } finally {
      this.flushInFlight = false;
      if (this.flushAgain) {
        const immediate = this.flushImmediateAgain;
        this.flushAgain = false;
        this.flushImmediateAgain = false;
        this.requestFlush(immediate);
      }
    }
  }

  // Move everything pending out of the outbox into one ingest payload,
  // remembering enough to put it back if the send fails.
  #takeOutbox() {
    const payload = { sessionId: this.id };
    const snap = {};
    let any = false;
    if (this.statusToSend !== undefined) {
      snap.status = payload.status = this.statusToSend;
      this.statusToSend = undefined;
      any = true;
    }
    if (this.endedReasonToSend !== undefined) {
      snap.endedReason = payload.endedReason = this.endedReasonToSend;
      this.endedReasonToSend = undefined;
      any = true;
    }
    if (this.sdkSessionIdToSend !== undefined) {
      snap.sdkSessionId = payload.sdkSessionId = this.sdkSessionIdToSend;
      this.sdkSessionIdToSend = undefined;
      any = true;
    }
    if (this.cwdToSend !== undefined) {
      snap.cwd = payload.cwd = this.cwdToSend;
      this.cwdToSend = undefined;
      any = true;
    }
    if (this.outbox.finalize.length > 0) {
      snap.finalize = payload.finalize = this.outbox.finalize;
      this.outbox.finalize = [];
      any = true;
    }
    if (this.bufDirty) {
      // The buffer's would-be seq is the CURRENT nextSeq — always past every
      // finalize row in this same payload (their seqs were assigned first).
      payload.buf =
        this.bufText === ""
          ? null
          : { turn: this.turn, seq: this.nextSeq, text: this.bufText };
      this.bufDirty = false;
      snap.buf = true;
      any = true;
    }
    if (this.outbox.inboundUpdates.length > 0) {
      snap.inboundUpdates = payload.inboundUpdates = this.outbox.inboundUpdates;
      this.outbox.inboundUpdates = [];
      any = true;
    }
    if (this.outbox.permissionRequests.length > 0) {
      snap.permissionRequests = payload.permissionRequests =
        this.outbox.permissionRequests;
      this.outbox.permissionRequests = [];
      any = true;
    }
    if (this.outbox.permissionUpdates.length > 0) {
      snap.permissionUpdates = payload.permissionUpdates =
        this.outbox.permissionUpdates;
      this.outbox.permissionUpdates = [];
      any = true;
    }
    if (!any) return null;
    // lastSdkEventAt rides along on real flushes only — it must never keep
    // the flush loop spinning by itself.
    if (this.lastSdkEventAtDirty && this.lastSdkEventAt !== undefined) {
      payload.lastSdkEventAt = this.lastSdkEventAt;
      this.lastSdkEventAtDirty = false;
    }
    return { payload, snap };
  }

  // A send failed: put the snapshot back, newer state winning where the two
  // overlap (scalars) and order preserved where it matters (arrays).
  #restoreOutbox({ snap }) {
    if (snap.status !== undefined && this.statusToSend === undefined) {
      this.statusToSend = snap.status;
    }
    if (snap.endedReason !== undefined && this.endedReasonToSend === undefined) {
      this.endedReasonToSend = snap.endedReason;
    }
    if (snap.sdkSessionId !== undefined && this.sdkSessionIdToSend === undefined) {
      this.sdkSessionIdToSend = snap.sdkSessionId;
    }
    if (snap.cwd !== undefined && this.cwdToSend === undefined) {
      this.cwdToSend = snap.cwd;
    }
    if (snap.finalize) {
      this.outbox.finalize = snap.finalize.concat(this.outbox.finalize);
    }
    if (snap.buf) this.bufDirty = true;
    if (snap.inboundUpdates) {
      this.outbox.inboundUpdates = snap.inboundUpdates.concat(
        this.outbox.inboundUpdates,
      );
    }
    if (snap.permissionRequests) {
      this.outbox.permissionRequests = snap.permissionRequests.concat(
        this.outbox.permissionRequests,
      );
    }
    if (snap.permissionUpdates) {
      this.outbox.permissionUpdates = snap.permissionUpdates.concat(
        this.outbox.permissionUpdates,
      );
    }
  }

  // The piggyback: every flush response carries this session's pending
  // commands and fresh decisions — this is what makes 1s polling feel
  // push-like exactly while a turn is live.
  #handleIngestResponse(res) {
    if (
      (res.sessionStatus === "ended" || res.sessionStatus === "failed") &&
      !this.reportedTerminal &&
      this.status !== "ended" &&
      this.status !== "failed"
    ) {
      // Browser-side forceClose landed while we were still live — kill the
      // local process; the server's word is final.
      this.forceKill(`server reports ${res.sessionStatus}`);
      return;
    }
    if (typeof res.nextSeq === "number" && res.nextSeq > this.nextSeq) {
      log(
        `session ${this.id}: ingest nextSeq ${res.nextSeq} > local ${this.nextSeq} — bumping`,
      );
      this.nextSeq = res.nextSeq;
    }
    this.applyDecisions(res.decisions);
    if (Array.isArray(res.pendingInbound)) {
      this.serverInbound = res.pendingInbound;
      this.processCommands();
    }
  }
}
