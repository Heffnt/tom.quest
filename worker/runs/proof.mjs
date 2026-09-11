// proof.mjs — local discovery/store/parser/read-back proof for real run files.
//
// This intentionally prints structure and totals only. It never passes a row,
// prompt, source line, absolute path, or transcript excerpt to line(); real
// transcripts are evidence, not diagnostic output. The caller-owned store is
// scratch space, never the production record.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverChildren, parseClaudeFile, parseCodexFile } from "./ingest.mjs";
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

  let storedBytes = 0; let objects = 0;
  const put = (runtime, id, bytes) => { const stored = store.put({ runtime, threadId: id, host, sourceBytes: bytes }); storedBytes += stored.storedBytes; objects += 1; return stored; };
  const parentId = path.basename(args.claude, ".jsonl");
  const parentStored = put("claude", parentId, parentBytes);
  const childInputs = discovered.subagents.map((child) => ({ ...child, bytes: fs.readFileSync(child.file) }));
  const childStored = childInputs.map((child) => put("claude", `${parentId}/${child.agentId}`, child.bytes));
  let codexId = "unknown";
  for (const raw of codexBytes.toString("utf8").split("\n")) {
    try { const entry = JSON.parse(raw); if (entry.type === "session_meta") { codexId = entry.payload?.id ?? entry.payload?.session_id ?? codexId; break; } } catch {}
  }
  const codexStored = put("codex", codexId, codexBytes);
  line(`store objects=${objects} storedBytes=${storedBytes}`);

  // Parse the exact redacted object the store returned, not the local source:
  // this is what proves a Convex row can later be rebuilt from its version.
  const parsed = [parseClaudeFile({ path: args.claude, text: store.get({ runtime: "claude", threadId: parentId, host, fileVersion: parentStored.fileVersion }).toString("utf8"), host, fileVersion: parentStored.fileVersion })];
  for (let index = 0; index < childInputs.length; index += 1) parsed.push(parseClaudeFile({ path: childInputs[index].file, text: store.get({ runtime: "claude", threadId: `${parentId}/${childInputs[index].agentId}`, host, fileVersion: childStored[index].fileVersion }).toString("utf8"), host, fileVersion: childStored[index].fileVersion, agentMeta: { ...childInputs[index].meta, agentId: childInputs[index].agentId }, parentSessionId: parentId }));
  parsed.push(parseCodexFile({ path: args.codex, text: store.get({ runtime: "codex", threadId: codexId, host, fileVersion: codexStored.fileVersion }).toString("utf8"), host, fileVersion: codexStored.fileVersion }));
  const descriptors = new Map([[parentStored.fileVersion, parentStored], [codexStored.fileVersion, codexStored], ...childStored.map((descriptor) => [descriptor.fileVersion, descriptor])]);
  for (const result of parsed) {
    const descriptor = descriptors.get(result.run.file.storedHash);
    Object.assign(result.run.file, descriptor, { committedLine: result.lastLine });
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
  for (const result of ordered) {
    const run = result.run; const totals = run.outcome.totals; const indent = "  ".repeat(run.depth);
    line(`${indent}${run.runId} ${run.runner} ${run.model ?? "-"} ${run.kind} rows=${result.rows.length} turns=${run.outcome.turns} tools=${run.outcome.toolCalls} in=${totals.inputTokens} cr=${totals.cacheReadTokens} cw=${totals.cacheWriteTokens} out=${totals.outputTokens} think=${totals.thinkingTokens} cost=${run.outcome.costUsd ?? "-"} status=${run.status}`);
    const drops = Object.entries(result.dropped).sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${kind}:${count}`).join(",");
    const source = run.file.path === args.claude ? parentBytes : run.file.path === args.codex ? codexBytes : childInputs.find((child) => child.file === run.file.path)?.bytes;
    const lineCount = source.toString("utf8").endsWith("\n") ? source.toString("utf8").split("\n").length - 1 : source.toString("utf8").split("\n").length;
    line(`file=${path.basename(run.file.path)} lines=${lineCount} consumed=${result.lastLine} bytes=${run.file.bytes} src=${run.file.sourceHash.slice(0, 12)} ver=${run.file.storedHash.slice(0, 12)} dropped={${drops}}`);
  }
  const naive = parentBytes.toString("utf8").split("\n").reduce((sum, raw) => { try { const usage = JSON.parse(raw).message?.usage; if (!usage) return sum; return sum + Number(usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0) + Number(usage.output_tokens ?? 0); } catch { return sum; } }, 0);
  const parentTotal = parsed[0].run.outcome.totals.totalTokens;
  let parentSpelling = "none";
  for (const raw of codexBytes.toString("utf8").split("\n")) { try { const entry = JSON.parse(raw); if (entry.type === "session_meta") { parentSpelling = typeof entry.payload?.parent_thread_id === "string" ? "parent_thread_id" : entry.payload?.parent !== undefined ? "parent" : "none"; break; } } catch {} }
  const codex = parsed.at(-1).run;
  line(`claude-totals naive-per-line=${naive} per-requestId=${parentTotal} differ=${naive === parentTotal ? "no" : "yes"}`);
  line(`codex-parent-field=${parentSpelling} model-change-check=${parsed.some((result) => result.rows.some((row) => row.kind === "error" && String(row.content?.error ?? "").startsWith("model changed"))) ? "fired" : "clear"} priced-models=none unpriced-models=${[...new Set(parsed.map((result) => result.run.model ?? "-"))].sort().join(",")}`);
}
