// proof.mjs — local discovery/store/parser/read-back proof for real run files.
//
// This intentionally prints structure and totals only. It never passes a row,
// prompt, source line, absolute path, or transcript excerpt to line(); real
// transcripts are evidence, not diagnostic output. The caller-owned store is
// scratch space, never the production record.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverChildren, parseClaudeFile, parseCodexFile } from "./ingest.mjs";
import { costOf } from "./prices.mjs";
import { openStore } from "./store.mjs";

function argsOf(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key.startsWith("--")) args[key.slice(2)] = argv[index + 1];
  }
  return args;
}
function line(...parts) { console.log(parts.join(" ")); }
function sourceKind(entry) {
  const payload = entry.payload ?? {};
  if (entry.type === "system") return `system/${entry.subtype ?? "unknown"}`;
  if (entry.type === "attachment") return `attachment/${entry.attachment?.type ?? "unknown"}`;
  return entry.type === "event_msg" || entry.type === "response_item" ? `${entry.type}/${payload.type ?? "unknown"}` : String(entry.type ?? "unknown");
}
function threadOf(run) { return run.runId.split(":").slice(2).join(":"); }
function completeSourceLines(bytes) {
  const text = Buffer.from(bytes).toString("utf8");
  const lines = text.split("\n");
  lines.pop(); // The parser deliberately leaves an incomplete final line unread.
  return lines;
}
function sourcePrefixHash(bytes, count) {
  const lines = completeSourceLines(bytes);
  const prefix = count === 0 ? "" : `${lines.slice(0, count).join("\n")}\n`;
  return crypto.createHash("sha256").update(prefix, "utf8").digest("hex");
}

const args = argsOf(process.argv.slice(2));
if (!args.claude || !args.codex) {
  line("usage: node worker/runs/proof.mjs --claude <session.jsonl> --codex <rollout.jsonl> [--store <scratch>] [--host laptop]");
  process.exitCode = 2;
} else {
  const host = args.host === "box" ? "box" : "laptop";
  const scratch = args.store ?? path.join(os.tmpdir(), `runs-proof-${process.pid}`);
  const store = openStore({ backend: "local", dir: scratch });
  const parentBytes = fs.readFileSync(args.claude);
  const codexBytes = fs.readFileSync(args.codex);
  const discovered = discoverChildren(args.claude);
  line(`discovery subagents=${discovered.subagents.length} toolResults=${discovered.toolResults.length} codex=1`);
  if (discovered.subagents.length < 1) throw new Error("proof requires at least one Claude child");

  let storedBytes = 0; let objects = 0;
  const put = (runtime, id, bytes, kind = "transcript") => {
    const stored = store.put({ runtime, threadId: id, host, sourceBytes: bytes, kind });
    storedBytes += stored.storedBytes;
    objects += 1;
    return stored;
  };
  const parentId = path.basename(args.claude, ".jsonl");
  const parentStored = put("claude", parentId, parentBytes);
  const childInputs = discovered.subagents.map((child) => {
    if (!child.meta || !fs.existsSync(child.metaFile)) throw new Error("Claude child sidecar missing or malformed");
    return { ...child, bytes: fs.readFileSync(child.file), sidecarBytes: fs.readFileSync(child.metaFile) };
  });
  const childStored = childInputs.map((child) => ({
    transcript: put("claude", `${parentId}/${child.agentId}`, child.bytes),
    sidecar: put("claude", `${parentId}/${child.agentId}`, child.sidecarBytes, "sidecar"),
  }));
  let codexId = "unknown";
  for (const raw of codexBytes.toString("utf8").split("\n")) {
    try { const entry = JSON.parse(raw); if (entry.type === "session_meta") { codexId = entry.payload?.id ?? entry.payload?.session_id ?? codexId; break; } } catch {}
  }
  const codexStored = put("codex", codexId, codexBytes);
  line(`store objects=${objects} storedBytes=${storedBytes}`);

  // Parse the exact redacted objects the store returned, not local sources:
  // this is what proves a Convex row can later be rebuilt from its version.
  const parsedRecords = [{
    result: parseClaudeFile({ path: args.claude, text: store.get({ runtime: "claude", threadId: parentId, host, fileVersion: parentStored.fileVersion }).toString("utf8"), host, fileVersion: parentStored.fileVersion, attachments: discovered.toolResults }),
    descriptor: parentStored,
    sourceBytes: parentBytes,
  }];
  for (let index = 0; index < childInputs.length; index += 1) {
    const child = childInputs[index];
    const stored = childStored[index];
    const sidecar = JSON.parse(store.get({ runtime: "claude", threadId: `${parentId}/${child.agentId}`, host, fileVersion: stored.sidecar.fileVersion, kind: "sidecar" }).toString("utf8"));
    const result = parseClaudeFile({
      path: child.file,
      text: store.get({ runtime: "claude", threadId: `${parentId}/${child.agentId}`, host, fileVersion: stored.transcript.fileVersion }).toString("utf8"),
      host,
      fileVersion: stored.transcript.fileVersion,
      agentMeta: {
        ...sidecar,
        agentId: child.agentId,
        sidecarStoredHash: stored.sidecar.storedHash,
        sidecar: { storedHash: stored.sidecar.storedHash, fileVersion: stored.sidecar.fileVersion },
      },
      parentSessionId: parentId,
    });
    if (result.run.file.sidecarStoredHash !== stored.sidecar.storedHash) throw new Error(`sidecar provenance missing for ${result.run.runId}`);
    parsedRecords.push({ result, descriptor: stored.transcript, sourceBytes: child.bytes });
  }
  parsedRecords.push({
    result: parseCodexFile({ path: args.codex, text: store.get({ runtime: "codex", threadId: codexId, host, fileVersion: codexStored.fileVersion }).toString("utf8"), host, fileVersion: codexStored.fileVersion }),
    descriptor: codexStored,
    sourceBytes: codexBytes,
  });
  const parsed = parsedRecords.map(({ result }) => result);
  for (const record of parsedRecords) {
    const { result, descriptor, sourceBytes } = record;
    if (crypto.createHash("sha256").update(sourceBytes).digest("hex") !== descriptor.sourceHash) throw new Error(`source integrity failed for ${result.run.runId}`);
    Object.assign(result.run.file, descriptor, { committedLine: result.lastLine });
    record.sourcePrefixSha256 = sourcePrefixHash(sourceBytes, result.lastLine);
    record.sourceLineCount = completeSourceLines(sourceBytes).length;
    const emittedLines = new Set(result.rows
      .filter((row) => row.provenance.sourceKind !== "context")
      .map((row) => row.provenance.lineStart));
    const droppedLines = Object.values(result.dropped).reduce((sum, count) => sum + count, 0);
    if (emittedLines.size + droppedLines !== result.lastLine) {
      throw new Error(`source accounting failed for ${result.run.runId}`);
    }
  }

  let checked = 0; let matched = 0;
  // Three positions in the root and one real child prove the pointer shape
  // without turning a structural proof into a full transcript replay.
  for (const result of parsed.slice(0, 2)) {
    const runtime = result.run.runner; const id = threadOf(result.run);
    const candidates = result.rows.filter((entry) => entry.provenance.sourceKind !== "context");
    const sample = [...new Set([0, Math.floor((candidates.length - 1) / 2), candidates.length - 1])].filter((index) => index >= 0).map((index) => candidates[index]);
    for (const row of sample) {
      checked += 1;
      const bytes = store.get({ runtime, threadId: id, host, fileVersion: row.provenance.fileVersion });
      const raw = bytes.toString("utf8").split("\n")[row.provenance.lineStart];
      try {
        const entry = JSON.parse(raw);
        if (sourceKind(entry) !== row.provenance.sourceKind) throw new Error("source kind mismatch");
        matched += 1;
      } catch {
        throw new Error(`raw inspection failed for ${result.run.runId} row ${row.seq}`);
      }
    }
  }
  line(`read-back checked=${checked} matched=${matched}`);
  const byParent = new Map();
  for (const result of parsed) {
    const key = result.run.parentRunId ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), result]);
  }
  const ordered = [];
  const walk = (parent) => {
    for (const result of (byParent.get(parent) ?? []).sort((a, b) => a.run.runId.localeCompare(b.run.runId))) {
      ordered.push(result);
      walk(result.run.runId);
    }
  };
  walk(null);
  // A Codex child can name an orphan parent: still print it once, after roots.
  for (const result of parsed) if (!ordered.includes(result)) { ordered.push(result); walk(result.run.runId); }
  const recordByResult = new Map(parsedRecords.map((record) => [record.result, record]));
  const byDepth = new Map();
  for (const result of ordered) byDepth.set(result.run.depth, [...(byDepth.get(result.run.depth) ?? []), result]);
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const level = byDepth.get(depth);
    const shown = level.length <= 4 ? level : [...level.slice(0, 2), ...level.slice(-2)];
    line(`level=${depth} runs=${level.length} shown=${shown.length}`);
    for (const result of shown) {
      const run = result.run; const totals = run.outcome.totals; const indent = "  ".repeat(run.depth);
      line(`${indent}${run.runId} ${run.runner} ${run.model ?? "-"} ${run.kind} rows=${result.rows.length} turns=${run.outcome.turns} tools=${run.outcome.toolCalls} in=${totals.inputTokens} cr=${totals.cacheReadTokens} cw=${totals.cacheWriteTokens} out=${totals.outputTokens} think=${totals.thinkingTokens} cost=${run.outcome.costUsd ?? "-"} status=${run.status}`);
      const drops = Object.entries(result.dropped).sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${kind}:${count}`).join(",");
      const record = recordByResult.get(result);
      const sidecar = run.file.sidecarStoredHash ? ` sidecar-object=${run.file.sidecarStoredHash.slice(0, 12)}` : "";
      line(`file=${path.basename(run.file.path)} lines=${record.sourceLineCount} consumed=${result.lastLine} bytes=${run.file.bytes} source-prefix=${record.sourcePrefixSha256.slice(0, 12)} stored-object=${run.file.storedHash.slice(0, 12)}${sidecar} dropped={${drops}}`);
    }
    if (shown.length !== level.length) line(`level=${depth} omitted=${level.length - shown.length}`);
  }
  const naive = parentBytes.toString("utf8").split("\n").reduce((sum, raw) => { try { const usage = JSON.parse(raw).message?.usage; if (!usage) return sum; return sum + Number(usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0) + Number(usage.output_tokens ?? 0); } catch { return sum; } }, 0);
  const parentTotal = parsed[0].run.outcome.totals.totalTokens;
  let parentSpelling = "none";
  for (const raw of codexBytes.toString("utf8").split("\n")) { try { const entry = JSON.parse(raw); if (entry.type === "session_meta") { parentSpelling = typeof entry.payload?.parent_thread_id === "string" ? "parent_thread_id" : entry.payload?.parent !== undefined ? "parent" : "none"; break; } } catch {} }
  const pricedModels = new Set(); const unpricedModels = new Set();
  for (const result of parsed) {
    const cost = costOf({ model: result.run.model, totals: result.run.outcome.totals });
    if (cost === null) unpricedModels.add(result.run.model ?? "-");
    else {
      if (result.run.outcome.costUsd !== cost) throw new Error(`measured cost mismatch for ${result.run.runId}`);
      pricedModels.add(result.run.model);
    }
  }
  line(`claude-totals naive-per-line=${naive} per-requestId=${parentTotal} differ=${naive === parentTotal ? "no" : "yes"}`);
  line(`codex-parent-field=${parentSpelling} model-change-check=${parsed.some((result) => result.rows.some((row) => row.kind === "error" && String(row.content?.error ?? "").startsWith("model changed"))) ? "fired" : "clear"} priced-models=${[...pricedModels].sort().join(",") || "none"} unpriced-models=${[...unpricedModels].sort().join(",") || "none"}`);
}
