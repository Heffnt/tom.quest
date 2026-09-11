// ingest.mjs — pure readers for the two CLI transcript formats.
//
// Files are the evidence. This module neither discovers a directory nor talks
// to Convex: it turns one supplied file body into deterministic, redacted rows
// that point back to the immutable store version the caller created first.

import crypto from "node:crypto";
import fsDefault from "node:fs";
import pathModule from "node:path";

import { redactSecrets } from "../session-host/redact.mjs";
import { overflowFor } from "../session-host/overflow.mjs";
import { cutWithOverflow } from "../session-host/cut.mjs";
import { costOf, priceTableVersion } from "./prices.mjs";

export const PARSER_VERSION = "runs-parser-1";
// Kept as a literal because this dependency-free worker file cannot import the
// TypeScript Convex module. The parser test fences it against ttsShared.
export const MODEL_OF_TOM_HEADER = "MODEL-OF-TOM FILES";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const number = (value) => (Number.isFinite(value) ? value : 0);
const millis = (value) => {
  const parsed = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
};
const sorted = (items) => [...new Set(items.filter((x) => typeof x === "string" && x))].sort();
const sessionModelOf = (model) => {
  if (typeof model !== "string") return undefined;
  const lower = model.toLowerCase();
  if (lower.includes("fable")) return "fable";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("opus")) return "opus";
  if (lower === "gpt-5.6-sol" || lower === "gpt-5.6-terra") return lower;
  return undefined;
};
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

/** Redact every string leaf before a parser result can leave this machine. */
export function redactDeep(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactDeep(child)]));
  }
  return value;
}

export function modelOfTomFromPrompt(prompt) {
  const line = String(prompt ?? "").split("\n", 1)[0] ?? "";
  if (!line.startsWith(MODEL_OF_TOM_HEADER)) {
    return { layersKnown: false, layersGiven: [], layersDenied: [] };
  }
  const commit = /WikiTom commit ([0-9a-f]{7,40})/i.exec(line)?.[1];
  const layers = (/\):\s*(.+)$/.exec(line)?.[1] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    ...(commit ? { wikitomCommit: commit } : {}),
    layersKnown: true,
    layersGiven: layers,
    layersDenied: ["operate", "write", "know"].filter((layer) => !layers.includes(layer)),
  };
}

function totalsOf(usage = {}) {
  const inputTokens = number(usage.input_tokens);
  const cacheReadTokens = number(usage.cache_read_input_tokens ?? usage.cached_input_tokens);
  const cacheWriteTokens = number(usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens);
  const outputTokens = number(usage.output_tokens);
  const thinkingTokens = number(usage.output_tokens_details?.thinking_tokens ?? usage.reasoning_output_tokens);
  return { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, thinkingTokens, totalTokens: number(usage.total_tokens) || inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens };
}

function finishResult(result) {
  const redacted = redactDeep(result);
  for (const row of redacted.rows) {
    const cut = cutWithOverflow(row.content);
    if (cut.note) {
      row.content = { text: cut.value, truncation: cut.note };
      row.overflow = { sha256: cut.overflow.sha256, byteLength: cut.overflow.byteLength, chunkCount: cut.overflow.chunkCount, chunks: cut.overflow.chunks };
    }
    row.digest = sha256(`${PARSER_VERSION}\n${redacted.run.runId}\n${row.seq}\n${row.kind}\n${stable(row.content)}`).slice(0, 16);
  }
  redacted.rows.sort((a, b) => a.seq - b.seq);
  return redacted;
}

function fileLines(text) {
  const complete = text.endsWith("\n");
  const lines = text.split("\n");
  if (complete) lines.pop();
  if (!complete) lines.pop();
  return { lines, incompleteTail: !complete && text.length > 0 };
}

function prefixHash(lines, count) {
  const prefix = count === 0 ? "" : `${lines.slice(0, count).join("\n")}\n`;
  return sha256(Buffer.from(prefix));
}

function provenance({ path, fileVersion, line, block, sourceKind }) {
  return { fileVersion, file: path, lineStart: line, lineEnd: line, block, parserVersion: PARSER_VERSION, sourceKind };
}

function rowFactory({ path, fileVersion, runId, rows, line, turn, sourceKind, timestamp }) {
  let block = 0;
  return (kind, content, options = {}) => {
    // Line zero has 999 remaining identities after the context reservation;
    // every later line has the full thousand-slot range.
    const errorBlock = line === 0 ? 998 : 999;
    if (block >= errorBlock) {
      if (block === errorBlock) rows.push({ seq: line * 1000 + 999, turn, kind: "error", content: { error: "more than 999 content blocks on one line" }, depth: options.depth ?? 0, provenance: provenance({ path, fileVersion, line, block, sourceKind }), createdAt: timestamp });
      block += 1;
      return null;
    }
    const current = block++;
    // seq 0 belongs to the synthetic context row. A real file may emit from
    // line zero (subagent files do), so reserve that one identity while the
    // provenance block remains the source's true zero-based content block.
    const seq = line * 1000 + current + (line === 0 ? 1 : 0);
    const row = { seq, turn, kind, content, depth: options.depth ?? 0, provenance: provenance({ path, fileVersion, line, block: current, sourceKind }), createdAt: timestamp };
    if (options.parentToolUseId) row.parentToolUseId = options.parentToolUseId;
    rows.push(row);
    return row;
  };
}

function persistedOutput(content) {
  const text = typeof content === "string" ? content : "";
  const match = /^<persisted-output>\nOutput too large \(([^)]*)\)\. Full output saved to: (.+?)\n/.exec(text);
  return match ? { path: match[2], sizeText: match[1] } : null;
}

function claudeContext(prompt, first, state) {
  const mot = modelOfTomFromPrompt(prompt);
  return {
    ...mot,
    skillsOffered: sorted(state.skillsOffered), skillsUsed: sorted(state.skillsUsed),
    tools: sorted(state.tools), hooks: sorted(state.hooks),
    ...(first?.cwd ? { cwd: first.cwd } : {}),
    ...(first?.gitBranch ? { gitBranch: first.gitBranch } : {}),
    ...(first?.entrypoint ? { entrypoint: first.entrypoint } : {}),
    ...(first?.permissionMode ? { permissionMode: first.permissionMode } : {}),
    ...(state.instructions ? { baseInstructionsHash: sha256(state.instructions) } : {}),
  };
}

export function parseClaudeFile({ path, text, host, fileVersion, fromLine = 0, agentMeta = null, parentSessionId = null }) {
  // The normal caller hands us the full immutable store version. Build its
  // run-level facts once from every line, then retain only newly committed
  // rows: an append must never replace full totals/context with a tail.
  if (fromLine > 0) {
    const full = parseClaudeFile({ path, text, host, fileVersion, agentMeta, parentSessionId });
    full.rows = full.rows.filter((row) => row.kind !== "context" && row.provenance.lineStart >= fromLine);
    return full;
  }
  const { lines, incompleteTail } = fileLines(text);
  const firstFileTimestamp = lines.map((raw) => { try { return millis(JSON.parse(raw).timestamp); } catch { return 0; } }).find(Boolean) ?? 0;
  const rows = [], children = [], attachments = [], dropped = {};
  const drop = (kind) => { dropped[kind] = (dropped[kind] ?? 0) + 1; };
  let sessionId = parentSessionId;
  let first = null, startedAt = firstFileTimestamp, lastLineAt = 0, model, runtimeVersion, modelChangeReported = false;
  let turn = -1, finalTextSeq, toolCalls = 0;
  const usages = new Map(); let unkeyedUsage = [];
  const tasks = new Map();
  const state = { tools: [], hooks: [], skillsOffered: [], skillsUsed: [], instructions: "", promptParts: [], firstUserPrompt: null };
  let human = false;

  for (let line = 0; line < lines.length; line += 1) {
    if (line < fromLine) continue;
    const raw = lines[line];
    if (raw.trim() === "") { drop("_blank"); continue; }
    let entry;
    try { entry = JSON.parse(raw); } catch {
      rowFactory({ path, fileVersion, runId: "", rows, line, turn: Math.max(turn, 0), sourceKind: "malformed-json", timestamp: 0 })("error", { error: `malformed JSON at line ${line}` }, { depth: agentMeta?.spawnDepth ?? 0 });
      continue;
    }
    first ??= entry;
    sessionId ??= entry.sessionId;
    const timestamp = millis(entry.timestamp); startedAt ||= timestamp; lastLineAt = timestamp || lastLineAt;
    runtimeVersion ??= entry.version;
    const depth = agentMeta?.spawnDepth ?? 0;
    const runId = agentMeta ? `claude:${host}:${parentSessionId}/${entry.agentId ?? agentMeta.agentId ?? "unknown"}` : `claude:${host}:${sessionId ?? "unknown"}`;
    const sourceKind = entry.type === "system" ? `system/${entry.subtype ?? "unknown"}` : entry.type === "attachment" ? `attachment/${entry.attachment?.type ?? "unknown"}` : String(entry.type ?? "unknown");
    const emit = rowFactory({ path, fileVersion, runId, rows, line, turn: Math.max(turn, 0), sourceKind, timestamp });
    const rowsBefore = rows.length;
    const dropsBefore = Object.values(dropped).reduce((sum, count) => sum + count, 0);
    const message = entry.message ?? {};

    if (entry.type === "user") {
      const content = message.content;
      const realTurn = typeof content === "string" || (Array.isArray(content) && content.some((block) => block?.type === "text") && !content.some((block) => block?.type === "tool_result"));
      if (realTurn) turn += 1;
      if (entry.origin?.kind === "human") human = true;
      const actualEmit = rowFactory({ path, fileVersion, runId, rows, line, turn: Math.max(turn, 0), sourceKind, timestamp });
      if (entry.isCompactSummary) actualEmit("system", { text: typeof content === "string" ? content : "compaction summary", compaction: true }, { depth });
      else if (entry.isMeta) actualEmit("system", { text: typeof content === "string" ? content : content }, { depth });
      else if (typeof content === "string") { state.firstUserPrompt ??= content; actualEmit("user", { text: content }, { depth }); }
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "text") actualEmit("user", { text: block.text ?? "" }, { depth });
          else if (block?.type === "tool_result") {
            const body = { toolUseId: block.tool_use_id, content: block.content, isError: Boolean(block.is_error) };
            const saved = persistedOutput(block.content); if (saved) body.persistedOutput = saved;
            actualEmit("tool-result", body, { depth, parentToolUseId: block.tool_use_id });
            const child = entry.toolUseResult;
            if (child?.agentId) {
              const childRunId = `claude:${host}:${sessionId}/${child.agentId}`;
              const task = tasks.get(block.tool_use_id) ?? {};
              actualEmit("child-run", { childRunId, agentId: child.agentId, agentType: child.agentType ?? task.agentType, description: child.description ?? task.description, model: child.resolvedModel, status: child.status === "completed" ? "completed" : "launched", ...(child.status === "completed" ? { totalTokens: child.totalTokens, totalDurationMs: child.totalDurationMs, totalToolUseCount: child.totalToolUseCount } : {}) }, { depth, parentToolUseId: block.tool_use_id });
              children.push({ runId: childRunId, parentRunId: runId, rootRunId: agentMeta ? `claude:${host}:${parentSessionId}` : runId, depth: depth + 1, spawnedByToolUseId: block.tool_use_id, linkKnown: true });
            }
          }
        }
      }
    } else if (entry.type === "assistant") {
      if (message.model) {
        if (!model) model = message.model;
        else if (model !== message.model && !modelChangeReported) { emit("error", { error: `model changed from ${model} to ${message.model}` }, { depth }); modelChangeReported = true; }
      }
      if (message.usage) {
        if (entry.requestId) usages.set(entry.requestId, message.usage); else unkeyedUsage.push(message.usage);
      }
      for (const block of message.content ?? []) {
        if (block?.type === "thinking") emit("thinking", { text: block.thinking ?? "" }, { depth });
        else if (block?.type === "text") { const row = emit("assistant-text", { text: block.text ?? "" }, { depth }); finalTextSeq = row?.seq ?? finalTextSeq; }
        else if (block?.type === "tool_use") { emit("tool-call", { id: block.id, name: block.name, input: block.input }, { depth }); toolCalls += 1; if (block.name === "Task") tasks.set(block.id, block.input); }
        else emit("system", { unknownAssistantBlock: block }, { depth });
      }
    } else if (entry.type === "system") {
      if (entry.subtype === "stop_hook_summary") {
        for (const hook of [...(entry.hookInfos ?? []), ...(entry.hookAdditionalContext ?? [])]) state.hooks.push(typeof hook === "string" ? hook : hook?.command ?? hook?.hookName ?? hook?.name);
        if (entry.hookName) state.hooks.push(entry.hookName);
      } else if (entry.subtype === "api_error") emit("error", { error: entry.error ?? entry.content ?? "API error" }, { depth });
      else emit("system", { subtype: entry.subtype, content: entry.content, error: entry.error, compactMetadata: entry.compactMetadata }, { depth });
    } else if (entry.type === "attachment") {
      const attachment = entry.attachment ?? {}; const type = attachment.type ?? "unknown";
      if (["environment", "instructions", "session_context", "model", "date", "prompt_snapshot", "auto_mode", "command_permissions", "skill_listing", "invoked_skills", "deferred_tools_record", "deferred_tools_delta", "agent_listing_delta", "mcp_instructions_delta"].includes(type)) {
        const payload = attachment.content ?? attachment.text ?? attachment;
        if (type === "instructions" && state.firstUserPrompt === null) state.instructions += `${(attachment.files ?? []).map((file) => file?.content ?? "").join("\n") || (typeof payload === "string" ? payload : "")}\n`;
        if (type === "session_context" && state.firstUserPrompt === null) state.promptParts.push(attachment.context ?? (typeof payload === "string" ? payload : JSON.stringify(payload)));
        if (type === "skill_listing") state.skillsOffered.push(...(attachment.names ?? []));
        if (type === "invoked_skills") state.skillsUsed.push(...(attachment.skills ?? []).map((skill) => skill?.name ?? skill));
        if (type === "deferred_tools_record") state.tools.push(...(attachment.entries ?? []).map((entry) => entry?.name ?? entry));
        if (type === "deferred_tools_delta") state.tools.push(...(attachment.addedNames ?? []), ...(attachment.readdedNames ?? []));
        if (type === "agent_listing_delta") state.tools.push(...(attachment.addedTypes ?? []));
        if (type === "mcp_instructions_delta") state.tools.push(...(attachment.addedNames ?? []));
      } else if (["hook_additional_context", "hook_success", "hook_non_blocking_error"].includes(type)) state.hooks.push(attachment.hookName ?? entry.hookName);
      else if (["file", "edited_text_file", "queued_command"].includes(type)) emit("system", { attachment: attachment }, { depth });
      else if (["total_tokens_reminder", "batching_reminder_sent", "silent_turn_reminder", "remote_session_change"].includes(type)) drop(sourceKind);
      else emit("system", { attachment }, { depth });
    } else if (["queue-operation", "last-prompt", "custom-title", "atis-latch", "bridge-session", "file-history-snapshot", "file-history-delta"].includes(entry.type)) drop(sourceKind);
    else emit("system", { unknownLineType: entry.type, line: entry }, { depth });
    // A file line that only changes parser state still needs an accounting
    // entry. Rows are counted by provenance in the proof; this is the other
    // side of that conservation check, one drop per zero-row source line.
    if (rows.length === rowsBefore && Object.values(dropped).reduce((sum, count) => sum + count, 0) === dropsBefore) drop(sourceKind);
  }

  const rootRunId = agentMeta ? `claude:${host}:${parentSessionId}` : `claude:${host}:${sessionId ?? "unknown"}`;
  const agentId = first?.agentId ?? agentMeta?.agentId ?? "unknown";
  const runId = agentMeta ? `claude:${host}:${parentSessionId}/${agentId}` : rootRunId;
  const prompt = [state.instructions, ...state.promptParts, state.firstUserPrompt].filter((part) => typeof part === "string" && part !== "").join("\n");
  const context = claudeContext(prompt, first, state);
  const actualModel = model ?? agentMeta?.model;
  if (fromLine === 0) {
    rows.unshift({ seq: 0, turn: 0, kind: "context", content: { ...(actualModel ? { model: actualModel } : {}), ...context, prompt }, depth: agentMeta?.spawnDepth ?? 0, provenance: provenance({ path, fileVersion, line: 0, block: 0, sourceKind: "context" }), createdAt: startedAt });
  }
  const usageValues = [...usages.values(), ...unkeyedUsage].map(totalsOf);
  const totals = usageValues.reduce((sum, item) => Object.fromEntries(Object.keys(sum).map((key) => [key, sum[key] + item[key]])), { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 });
  totals.totalTokens = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens;
  const price = costOf({ model: actualModel, totals });
  const run = {
    runId, ...(agentMeta ? { parentRunId: agentMeta.parentAgentId ? `claude:${host}:${parentSessionId}/${agentMeta.parentAgentId}` : rootRunId, spawnedByToolUseId: agentMeta.toolUseId } : {}), rootRunId,
    depth: agentMeta?.spawnDepth ?? 0, linkKnown: true, origin: "unknown", host, runner: "claude", ...(actualModel ? { model: actualModel } : {}), ...(runtimeVersion ? { runtimeVersion } : {}), parserVersion: PARSER_VERSION,
    ...(sessionModelOf(actualModel) ? { sessionModel: sessionModelOf(actualModel) } : {}), kind: agentMeta ? "subagent" : human ? "session" : "unknown", status: "unknown", startedAt, lastLineAt, context,
    outcome: { ...(finalTextSeq !== undefined ? { finalTextSeq } : {}), totals, ...(price === null ? {} : { costUsd: price, priceTableVersion: priceTableVersion() }), turns: Math.max(1, turn + 1), toolCalls },
    file: { path, sourceHash: sha256(Buffer.from(text)), storedHash: fileVersion, bytes: Buffer.byteLength(text), storedBytes: 0, committedLine: lines.length, committedPrefixSha256: prefixHash(lines, lines.length), incompleteTail },
  };
  if (agentMeta && (run.depth < 1 || (!agentMeta.parentAgentId && run.depth !== 1))) rows.push({ seq: Math.max(lines.length, 1) * 1000 + 999, turn: Math.max(turn, 0), kind: "error", content: { error: "subagent depth disagrees with parentAgentId" }, depth: run.depth, provenance: provenance({ path, fileVersion, line: Math.max(lines.length - 1, 0), block: 999, sourceKind: "agent-meta" }), createdAt: lastLineAt });
  return finishResult({ run, rows, children, attachments, lastLine: lines.length, incompleteTail, dropped });
}

function codexParent(meta) {
  if (typeof meta.parent_thread_id === "string") return meta.parent_thread_id;
  if (typeof meta.parent === "string") return meta.parent;
  if (meta.parent && typeof meta.parent === "object") return meta.parent.thread_id ?? meta.parent.id;
  return null;
}

export function parseCodexFile({ path, text, host, fileVersion, fromLine = 0 }) {
  // See the Claude branch above: row emission is incremental, run facts are
  // file-wide facts and therefore never become tail-only on an append.
  if (fromLine > 0) {
    const full = parseCodexFile({ path, text, host, fileVersion });
    full.rows = full.rows.filter((row) => row.kind !== "context" && row.provenance.lineStart >= fromLine);
    return full;
  }
  const { lines, incompleteTail } = fileLines(text); const rows = [], children = [], attachments = [], dropped = {};
  const firstFileTimestamp = lines.map((raw) => { try { return millis(JSON.parse(raw).timestamp); } catch { return 0; } }).find(Boolean) ?? 0;
  const drop = (kind) => { dropped[kind] = (dropped[kind] ?? 0) + 1; };
  let meta = {}, runId, parentId, model, effort, startedAt = firstFileTimestamp, lastLineAt = 0, runtimeVersion, finalTextSeq, toolCalls = 0, approvalPolicy, sandboxPolicy, modelChangeReported = false;
  let currentTurn = 0; const turns = new Map(); let lastTokenCount = null; const usageRecords = []; let taskComplete = null; let lastAssistantText = null;
  for (let line = 0; line < lines.length; line += 1) {
    if (line < fromLine) continue; const raw = lines[line]; if (!raw.trim()) { drop("_blank"); continue; }
    let entry; try { entry = JSON.parse(raw); } catch { rowFactory({ path, fileVersion, runId: runId ?? `codex:${host}:unknown`, rows, line, turn: currentTurn, sourceKind: "malformed-json", timestamp: 0 })("error", { error: `malformed JSON at line ${line}` }); continue; }
    const payload = entry.payload ?? {}; const timestamp = millis(entry.timestamp); startedAt ||= timestamp; lastLineAt = timestamp || lastLineAt;
    if (entry.type === "session_meta") { meta = payload; const id = payload.id ?? payload.session_id ?? "unknown"; runId = `codex:${host}:${id}`; parentId = codexParent(payload); runtimeVersion = payload.cli_version; }
    const turnId = payload.turn_id ?? payload.turnId;
    if (turnId !== undefined) { if (!turns.has(turnId)) turns.set(turnId, turns.size); currentTurn = turns.get(turnId); }
    const sourceKind = `${entry.type ?? "unknown"}/${payload.type ?? "unknown"}`;
    const emit = rowFactory({ path, fileVersion, runId: runId ?? `codex:${host}:unknown`, rows, line, turn: currentTurn, sourceKind, timestamp });
    const rowsBefore = rows.length;
    const dropsBefore = Object.values(dropped).reduce((sum, count) => sum + count, 0);
    if (entry.type === "turn_context") { if (payload.model) { if (!model) model = payload.model; else if (model !== payload.model && !modelChangeReported) { emit("error", { error: `model changed from ${model} to ${payload.model}` }); modelChangeReported = true; } } effort ??= payload.effort; approvalPolicy ??= payload.approval_policy; sandboxPolicy ??= payload.sandbox_policy?.type; }
    else if (entry.type === "response_item") {
      if (payload.type === "message") {
        const content = payload.content ?? []; const role = payload.role;
        for (const part of content) {
          const value = part.text ?? part.input_text ?? part.output_text ?? "";
          if (role === "assistant") { const row = emit("assistant-text", { text: value }); finalTextSeq = row?.seq ?? finalTextSeq; lastAssistantText = value; }
          else if (role === "user") emit("user", { text: value });
          else if (role === "developer") { /* context only */ }
          else emit("system", { role, text: value });
        }
      } else if (payload.type === "reasoning") emit("thinking", { summary: payload.summary ?? [] });
      else if (payload.type === "function_call" || payload.type === "custom_tool_call") { emit("tool-call", { id: payload.call_id ?? payload.id, name: payload.name, input: payload.arguments ?? payload.input }); toolCalls += 1; }
      else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") emit("tool-result", { toolUseId: payload.call_id, content: payload.output });
      else emit("system", { unknownResponseItem: payload });
    } else if (entry.type === "event_msg") {
      if (payload.type === "token_count") lastTokenCount = payload.info?.total_token_usage ?? null;
      else if (payload.type === "task_complete") {
        // Only the last completion can supply the synthetic final-text row;
        // earlier completions are folded state and account as dropped.
        if (taskComplete) drop("event_msg/task_complete");
        taskComplete = { message: payload.last_agent_message, line, turn: currentTurn, timestamp };
      }
      else if (!["task_started", "item_completed"].includes(payload.type)) emit("system", { event: payload });
    } else if (entry.type === "token_usage_record") usageRecords.push(payload.usage ?? {});
    else if (!["session_meta", "world_state"].includes(entry.type)) emit("system", { unknownLineType: entry.type, line: entry });
    // task_complete is emitted (or dropped) after the loop once we know
    // whether it duplicates the final assistant message.
    if (rows.length === rowsBefore && Object.values(dropped).reduce((sum, count) => sum + count, 0) === dropsBefore && !(entry.type === "event_msg" && payload.type === "task_complete")) drop(sourceKind);
  }
  // Context is assembled from the full file because its metadata often sits
  // before an incremental cursor; re-reading it changes no emitted rows.
  for (const raw of lines) { try { const entry = JSON.parse(raw); const p = entry.payload ?? {}; if (entry.type === "session_meta") meta = p; if (entry.type === "turn_context") { model ??= p.model; effort ??= p.effort; approvalPolicy ??= p.approval_policy; sandboxPolicy ??= p.sandbox_policy?.type; } } catch {} }
  const id = meta.id ?? meta.session_id ?? "unknown"; runId = `codex:${host}:${id}`; parentId = codexParent(meta);
  const developer = lines.map((raw) => { try { return JSON.parse(raw); } catch { return null; } }).find((entry) => entry?.type === "response_item" && entry.payload?.type === "message" && entry.payload?.role === "developer");
  const prompt = (developer?.payload?.content ?? []).map((part) => part.text ?? part.input_text ?? "").join("\n");
  const mot = modelOfTomFromPrompt(prompt);
  const tools = [];
  for (const raw of lines) { try { const p = JSON.parse(raw).payload ?? {}; if (["custom_tool_call", "function_call"].includes(p.type) && p.name) tools.push(p.name); } catch {} }
  const permissionMode = sandboxPolicy ? `approval=${approvalPolicy ?? "unknown"}; sandbox=${sandboxPolicy}` : approvalPolicy;
  const context = { ...mot, skillsOffered: [], skillsUsed: [], tools: sorted(tools), hooks: [], ...(meta.cwd ? { cwd: meta.cwd } : {}), ...(meta.git?.branch ? { gitBranch: meta.git.branch } : {}), ...(meta.git?.commit_hash ? { gitCommit: meta.git.commit_hash } : {}), ...(meta.base_instructions?.text ? { baseInstructionsHash: sha256(meta.base_instructions.text) } : {}), ...(meta.originator ? { originator: meta.originator } : {}), ...(meta.context_window ? { contextWindow: meta.context_window } : {}), ...(permissionMode ? { permissionMode } : {}) };
  if (fromLine === 0) rows.unshift({ seq: 0, turn: 0, kind: "context", content: { ...(model ? { model } : {}), ...context, prompt }, depth: parentId ? 1 : 0, provenance: provenance({ path, fileVersion, line: 0, block: 0, sourceKind: "context" }), createdAt: startedAt });
  if (taskComplete?.message && taskComplete.message !== lastAssistantText) { const row = { seq: taskComplete.line * 1000 + 998, turn: taskComplete.turn, kind: "assistant-text", content: { text: taskComplete.message }, depth: parentId ? 1 : 0, provenance: provenance({ path, fileVersion, line: taskComplete.line, block: 998, sourceKind: "event_msg/task_complete" }), createdAt: taskComplete.timestamp }; rows.push(row); finalTextSeq = row.seq; }
  else if (taskComplete) drop("event_msg/task_complete");
  const totals = lastTokenCount ? totalsOf(lastTokenCount) : usageRecords.map(totalsOf).reduce((sum, item) => Object.fromEntries(Object.keys(sum).map((key) => [key, sum[key] + item[key]])), { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 });
  const price = costOf({ model, totals });
  const rootRunId = parentId ? `codex:${host}:${parentId}` : runId;
  const run = { runId, ...(parentId ? { parentRunId: rootRunId } : {}), rootRunId, depth: parentId ? 1 : 0, linkKnown: !parentId, origin: "unknown", host, runner: "codex", ...(model ? { model } : {}), ...(sessionModelOf(model) ? { sessionModel: sessionModelOf(model) } : {}), ...(effort ? { effort } : {}), ...(runtimeVersion ?? meta.cli_version ? { runtimeVersion: runtimeVersion ?? meta.cli_version } : {}), parserVersion: PARSER_VERSION, kind: parentId ? "codex-child" : "unknown", status: "unknown", startedAt, lastLineAt, context, outcome: { ...(finalTextSeq !== undefined ? { finalTextSeq } : {}), totals, ...(price === null ? {} : { costUsd: price, priceTableVersion: priceTableVersion() }), turns: Math.max(1, turns.size), toolCalls }, file: { path, sourceHash: sha256(Buffer.from(text)), storedHash: fileVersion, bytes: Buffer.byteLength(text), storedBytes: 0, committedLine: lines.length, committedPrefixSha256: prefixHash(lines, lines.length), incompleteTail } };
  return finishResult({ run, rows, children, attachments, lastLine: lines.length, incompleteTail, dropped });
}

export function discoverChildren(sessionFilePath, { fs = fsDefault } = {}) {
  const directory = pathModule.join(pathModule.dirname(sessionFilePath), pathModule.basename(sessionFilePath, ".jsonl"));
  const subagents = []; const toolResults = [];
  const subDir = pathModule.join(directory, "subagents");
  if (fs.existsSync(subDir)) for (const name of fs.readdirSync(subDir)) {
    const match = /^agent-(.+)\.jsonl$/.exec(name); if (!match) continue;
    const file = pathModule.join(subDir, name); const metaFile = pathModule.join(subDir, `agent-${match[1]}.meta.json`); let meta = null;
    if (fs.existsSync(metaFile)) { try { meta = JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch {} }
    subagents.push({ file, metaFile, agentId: match[1], meta });
  }
  const toolDir = pathModule.join(directory, "tool-results");
  if (fs.existsSync(toolDir)) for (const name of fs.readdirSync(toolDir)) { const file = pathModule.join(toolDir, name); try { const bytes = fs.readFileSync(file); toolResults.push({ file, bytes: bytes.length, sha256: sha256(bytes) }); } catch {} }
  return { subagents, toolResults };
}
