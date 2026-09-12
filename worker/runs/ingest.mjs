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
import { AGENT_FILE, AGENT_SIDECAR, workflowIdOf } from "./discover.mjs";
import { costOf, priceTableVersion } from "./prices.mjs";

/** The workflow folder a transcript sits in, when it sits in one. */
export const workflowIdOfPath = (file) => workflowIdOf(String(file).split(/[\\/]/));

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

const OMIT = Symbol("omit");

// Convex receives JSON values, not JavaScript's larger value set. Normalize
// before cutting and hashing so the digest is of exactly what reaches it.
function jsonValue(value, seen = new WeakSet()) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return OMIT;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("parser result contains a non-finite number");
    return value;
  }
  if (typeof value === "bigint") throw new TypeError("parser result contains a bigint");
  if (typeof value !== "object") throw new TypeError("parser result contains an unsupported value");
  if (seen.has(value)) throw new TypeError("parser result contains a cycle");
  seen.add(value);
  if (Array.isArray(value)) {
    const normalized = value.map((child) => {
      const next = jsonValue(child, seen);
      // JSON.stringify turns an undefined array slot into null.
      return next === OMIT ? null : next;
    });
    seen.delete(value);
    return normalized;
  }
  const normalized = {};
  for (const [key, child] of Object.entries(value)) {
    const next = jsonValue(child, seen);
    // JSON.stringify drops undefined object properties.
    if (next !== OMIT) normalized[key] = next;
  }
  seen.delete(value);
  return normalized;
}

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
  const creation = usage.cache_creation;
  const hasWriteBreakdown = creation && Number.isFinite(creation.ephemeral_5m_input_tokens) && Number.isFinite(creation.ephemeral_1h_input_tokens);
  // Older usage records expose only a legacy aggregate. Keep it in the 5m
  // bucket for token conservation, while marking its rate unknowable.
  const cacheWrite5mTokens = hasWriteBreakdown
    ? number(creation.ephemeral_5m_input_tokens)
    : number(usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens);
  const cacheWrite1hTokens = hasWriteBreakdown ? number(creation.ephemeral_1h_input_tokens) : 0;
  const cacheWriteTokens = cacheWrite5mTokens + cacheWrite1hTokens;
  const outputTokens = number(usage.output_tokens);
  const thinkingTokens = number(usage.output_tokens_details?.thinking_tokens ?? usage.reasoning_output_tokens);
  return {
    inputTokens, cacheReadTokens, cacheWriteTokens, cacheWrite5mTokens, cacheWrite1hTokens,
    // Zero writes need no duration choice; a nonzero legacy aggregate does.
    cacheWriteBreakdownKnown: hasWriteBreakdown || cacheWriteTokens === 0,
    outputTokens, thinkingTokens,
    totalTokens: number(usage.total_tokens) || inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
  };
}

function finishResult(result) {
  const redacted = jsonValue(redactDeep(result));
  for (const row of redacted.rows) {
    // Context has structured, queryable fields. Only its prompt is a display
    // payload, so preserve the fields and retain the complete redacted prompt
    // behind the normal overflow pointer.
    const fullContext = row.kind === "context" && row.content && typeof row.content === "object" ? row.content : null;
    const cut = fullContext
      ? cutWithOverflow(row.content.prompt)
      : cutWithOverflow(row.content);
    if (cut.note) {
      row.content = row.kind === "context"
        ? { ...row.content, prompt: cut.value, promptTruncation: cut.note }
        : { text: cut.value, truncation: cut.note };
      // A context reader follows overflow as the complete row payload, not
      // merely the one display field. Its structured fields remain present in
      // the bounded row for queries and renderers.
      const overflow = fullContext ? overflowFor(JSON.stringify(fullContext)) : cut.overflow;
      row.overflow = { sha256: overflow.sha256, byteLength: overflow.byteLength, chunkCount: overflow.chunkCount, chunks: overflow.chunks };
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

// seq zero is synthetic context. Every source identity therefore has a
// positive, invertible sequence: line = floor(seq / 1000) - 1, block = seq % 1000.
const sourceSeq = (line, block) => (line + 1) * 1000 + block;

function rowFactory({ path, fileVersion, runId, rows, line, turn, sourceKind, timestamp }) {
  let block = 0;
  return (kind, content, options = {}) => {
    // Blocks 0..998 are source content; block 999 makes an impossible line
    // overflow visible without allowing an ambiguous next-line sequence.
    const errorBlock = 999;
    if (block >= errorBlock) {
      if (block === errorBlock) rows.push({ seq: sourceSeq(line, 999), turn, kind: "error", content: { error: "more than 999 content blocks on one line" }, depth: options.depth ?? 0, provenance: provenance({ path, fileVersion, line, block, sourceKind }), createdAt: timestamp });
      block += 1;
      return null;
    }
    const current = block++;
    const seq = sourceSeq(line, current);
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

function attachmentPointers(values) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value) => value && typeof value.file === "string" && Number.isInteger(value.bytes) && value.bytes >= 0 && /^[0-9a-f]{64}$/.test(value.sha256))
    .map(({ file, bytes, sha256: hash }) => ({ file, bytes, sha256: hash }));
}

function sidecarStoredHash(agentMeta, sidecar) {
  const candidate = sidecar?.storedHash ?? sidecar?.fileVersion
    ?? agentMeta?.sidecarStoredHash ?? agentMeta?.sidecar?.storedHash ?? agentMeta?.sidecar?.fileVersion
    ?? agentMeta?.storedSidecar?.storedHash ?? agentMeta?.storedSidecar?.fileVersion
    ?? agentMeta?.storedHash ?? agentMeta?.fileVersion;
  return typeof candidate === "string" && /^[0-9a-f]{64}$/.test(candidate) ? candidate : undefined;
}

function claudeChildFacts(agentMeta, parentSessionId) {
  const isSubagent = agentMeta !== null || parentSessionId !== null;
  if (!isSubagent) return { isSubagent: false, depth: 0, errors: [], parentAgentId: undefined, toolUseId: undefined, workflowId: undefined };
  const meta = agentMeta && typeof agentMeta === "object" ? agentMeta : {};
  const errors = [];
  if (!agentMeta || typeof agentMeta !== "object") errors.push("subagent sidecar is missing or malformed");
  // A Workflow's agents get a thinner sidecar than a Task's: agentType and
  // spawnDepth, sometimes model, and never the description, parentAgentId or
  // toolUseId a Task writes. The workflow id comes off the folder instead, and
  // the missing tool-use id is what `linkKnown: false` already says.
  const workflowId = typeof meta.workflowId === "string" && meta.workflowId ? meta.workflowId : undefined;
  const rawDepth = meta.spawnDepth;
  const depthKnown = Number.isInteger(rawDepth) && rawDepth >= 1;
  const depth = depthKnown ? rawDepth : 1;
  if (!depthKnown) errors.push(rawDepth === undefined ? "subagent sidecar is missing spawnDepth" : "subagent sidecar has malformed spawnDepth");
  const parentAgentId = typeof meta.parentAgentId === "string" && meta.parentAgentId ? meta.parentAgentId : undefined;
  if ((!parentAgentId && depth !== 1) || (parentAgentId && depth < 2)) errors.push("subagent depth disagrees with parentAgentId");
  const toolUseId = typeof meta.toolUseId === "string" && meta.toolUseId ? meta.toolUseId : undefined;
  return { isSubagent: true, depth, errors, parentAgentId, toolUseId, workflowId };
}

export function parseClaudeFile({ path, text, host, fileVersion, fromLine = 0, baseLine: suppliedBaseLine = fromLine, agentMeta = null, parentSessionId = null, sidecar = null, attachments: suppliedAttachments = /** @type {Array<{file: string, bytes: number, sha256: string}>} */ ([]) }) {
  // `baseLine` is the absolute source-line ordinal of text's first supplied
  // line. `fromLine` remains its older spelling for callers that already use
  // it; an explicit baseLine wins when both are present.
  const baseLine = suppliedBaseLine ?? fromLine;
  if (!Number.isInteger(baseLine) || baseLine < 0) throw new RangeError("baseLine must be a non-negative integer");
  const child = claudeChildFacts(agentMeta, parentSessionId);
  const { lines, incompleteTail } = fileLines(text);
  const firstFileTimestamp = lines.map((raw) => { try { return millis(JSON.parse(raw).timestamp); } catch { return 0; } }).find(Boolean) ?? 0;
  const rows = [], children = [], attachments = attachmentPointers(suppliedAttachments ?? agentMeta?.attachments), dropped = {};
  // Where each child's one edge sits in the array, so a parent that speaks to
  // the same subagent twice still names that parentage once.
  const childEdgeAt = new Map();
  const drop = (kind) => { dropped[kind] = (dropped[kind] ?? 0) + 1; };
  let sessionId = parentSessionId;
  let first = null, startedAt = firstFileTimestamp, lastLineAt = 0, model, runtimeVersion, modelChangeReported = false;
  let turn = -1, finalTextSeq, toolCalls = 0;
  const usages = new Map(); let unkeyedUsage = [];
  const tasks = new Map();
  const state = { tools: [], hooks: [], skillsOffered: [], skillsUsed: [], instructions: "", promptParts: [], firstUserPrompt: null };
  let human = false;

  for (let relativeLine = 0; relativeLine < lines.length; relativeLine += 1) {
    const line = baseLine + relativeLine;
    const raw = lines[relativeLine];
    if (raw.trim() === "") { drop("_blank"); continue; }
    let entry;
    try { entry = JSON.parse(raw); } catch {
      rowFactory({ path, fileVersion, runId: "", rows, line, turn: Math.max(turn, 0), sourceKind: "malformed-json", timestamp: 0 })("error", { error: `malformed JSON at line ${line}` }, { depth: child.depth });
      continue;
    }
    first ??= entry;
    sessionId ??= entry.sessionId;
    const timestamp = millis(entry.timestamp); startedAt ||= timestamp; lastLineAt = timestamp || lastLineAt;
    runtimeVersion ??= entry.version;
    const depth = child.depth;
    const rootId = `claude:${host}:${parentSessionId ?? sessionId ?? "unknown"}`;
    const runId = child.isSubagent ? `${rootId}/${entry.agentId ?? agentMeta?.agentId ?? "unknown"}` : rootId;
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
              const edge = {
                runId: childRunId, parentRunId: runId,
                rootRunId: child.isSubagent ? `claude:${host}:${parentSessionId ?? sessionId}` : runId,
                depth: depth + 1,
                ...(typeof block.tool_use_id === "string" && block.tool_use_id ? { spawnedByToolUseId: block.tool_use_id } : {}),
                // A child id alone proves parentage, not which parent tool did it.
                linkKnown: typeof block.tool_use_id === "string" && block.tool_use_id !== "",
              };
              // Every tool result naming an agent is a real event and keeps its
              // own child-run row, but a second message to a running subagent is
              // not a second child. The spawn is the first tool use, so a later
              // one never takes its place — it only fills a link nobody knew.
              const at = childEdgeAt.get(childRunId);
              if (at === undefined) { childEdgeAt.set(childRunId, children.length); children.push(edge); }
              else if (!children[at].linkKnown && edge.linkKnown) children[at] = edge;
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
        else if (block?.type === "tool_use") {
          emit("tool-call", { id: block.id, name: block.name, input: block.input }, { depth });
          if (block.name) state.tools.push(block.name);
          toolCalls += 1;
          if (block.name === "Task") tasks.set(block.id, block.input);
        }
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

  const rootRunId = `claude:${host}:${parentSessionId ?? sessionId ?? "unknown"}`;
  const agentId = first?.agentId ?? agentMeta?.agentId ?? "unknown";
  const runId = child.isSubagent ? `${rootRunId}/${agentId}` : rootRunId;
  const prompt = [state.instructions, ...state.promptParts, state.firstUserPrompt].filter((part) => typeof part === "string" && part !== "").join("\n");
  const context = { ...claudeContext(prompt, first, state), ...(child.workflowId ? { workflowId: child.workflowId } : {}) };
  // The context row names the model the file says ran, so the transcript page
  // can show it without reading the run row beside it.
  const actualModel = model ?? agentMeta?.model;
  if (baseLine === 0) {
    rows.unshift({ seq: 0, turn: 0, kind: "context", content: { ...(actualModel ? { model: actualModel } : {}), ...context, prompt }, depth: child.depth, provenance: provenance({ path, fileVersion, line: 0, block: 0, sourceKind: "context" }), createdAt: startedAt });
  }
  const usageValues = [...usages.values(), ...unkeyedUsage].map(totalsOf);
  const totals = usageValues.reduce((sum, item) => ({
    inputTokens: sum.inputTokens + item.inputTokens,
    cacheReadTokens: sum.cacheReadTokens + item.cacheReadTokens,
    cacheWriteTokens: sum.cacheWriteTokens + item.cacheWriteTokens,
    cacheWrite5mTokens: sum.cacheWrite5mTokens + item.cacheWrite5mTokens,
    cacheWrite1hTokens: sum.cacheWrite1hTokens + item.cacheWrite1hTokens,
    cacheWriteBreakdownKnown: sum.cacheWriteBreakdownKnown && item.cacheWriteBreakdownKnown,
    outputTokens: sum.outputTokens + item.outputTokens,
    thinkingTokens: sum.thinkingTokens + item.thinkingTokens,
  }), { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheWriteBreakdownKnown: true, outputTokens: 0, thinkingTokens: 0 });
  totals.totalTokens = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens;
  totals.longContextRequests = 0;
  const price = costOf({ model: actualModel, totals });
  const run = {
    runId,
    ...(child.isSubagent ? { parentRunId: child.parentAgentId ? `${rootRunId}/${child.parentAgentId}` : rootRunId } : {}),
    ...(child.isSubagent && child.toolUseId ? { spawnedByToolUseId: child.toolUseId } : {}),
    rootRunId, depth: child.depth, linkKnown: child.isSubagent ? Boolean(child.toolUseId) : true, origin: child.workflowId ? "workflow" : "unknown", host, runner: "claude", ...(actualModel ? { model: actualModel } : {}), ...(runtimeVersion ? { runtimeVersion } : {}), parserVersion: PARSER_VERSION,
    ...(sessionModelOf(actualModel) ? { sessionModel: sessionModelOf(actualModel) } : {}), kind: child.isSubagent ? "subagent" : human ? "session" : "unknown", status: "unknown", startedAt, lastLineAt, context, attachments,
    outcome: { ...(finalTextSeq !== undefined ? { finalTextSeq } : {}), totals, ...(price === null ? {} : { costUsd: price, priceTableVersion: priceTableVersion() }), turns: Math.max(1, turn + 1), toolCalls },
    file: { path, sourceHash: sha256(Buffer.from(text)), storedHash: fileVersion, bytes: Buffer.byteLength(text), storedBytes: 0, committedLine: baseLine + lines.length, committedPrefixSha256: prefixHash(lines, lines.length), ...(child.isSubagent && sidecarStoredHash(agentMeta, sidecar) ? { sidecarStoredHash: sidecarStoredHash(agentMeta, sidecar) } : {}), incompleteTail },
  };
  if (child.errors.length) rows.push({ seq: sourceSeq(baseLine + Math.max(lines.length - 1, 0), 999), turn: Math.max(turn, 0), kind: "error", content: { error: child.errors.join("; ") }, depth: run.depth, provenance: provenance({ path, fileVersion, line: baseLine + Math.max(lines.length - 1, 0), block: 999, sourceKind: "agent-meta" }), createdAt: lastLineAt });
  return finishResult({ run, rows, children, attachments, lastLine: baseLine + lines.length, incompleteTail, dropped });
}

// ── The Codex skill catalog ─────────────────────────────────────────────────
//
// CODEX HAS NO SKILL TOOL. `codex exec` reads $CODEX_HOME/skills and writes the
// whole catalog into the FIRST developer message of the rollout, then tells the
// model to expand a short path and read the SKILL.md file itself. So "offered"
// is a parse of that message, and "used" is a parse of which of those files a
// tool call went and read. Nothing else in the rollout names a skill.
//
// (The phase-6 brief assumed a skill tool call the way Claude Code has one.
// There is none; this is the honest parse of what a Codex rollout records.)
//
// The block the CLI writes, measured against codex-cli 0.153.3:
//
//   <skills_instructions>
//   ## Skills
//   A skill is a set of local instructions ...
//   ### Skill roots
//   - `r0` = `C:/Users/heffn/.codex/skills`
//   - `r1` = `C:/Users/heffn/.codex/skills/.system`
//   ### Available skills
//   - imagegen: Generate or edit raster images ... (file: r1/imagegen/SKILL.md)
//   - sites:sites-building: Use Sites ... (file: r2/sites-building/SKILL.md)
//   </skills_instructions>
//
// THE ROOT INDICES ARE DYNAMIC. A root with no skills under it is not listed,
// so r0 is whichever directory happened to come first in that run. The map is
// therefore rebuilt from the "Skill roots" block on every parse and never
// assumed.
const CODEX_SKILLS_BLOCK = /<skills_instructions>([\s\S]*?)<\/skills_instructions>/;

/** One path, in the one spelling both sides of a comparison can share. */
const pathNeedle = (value) => String(value ?? "").replace(/[\\/]+/g, "/").toLowerCase();

/**
 * The catalog a Codex rollout's developer message offered.
 *
 * A rollout with no block is a run that was offered nothing, not an error: the
 * CLI writes the block only when $CODEX_HOME/skills holds something.
 *
 * @param {string} developerText the first developer message's text
 * @returns {{ names: string[], paths: Record<string, string>, shortPaths: Record<string, string> }}
 *   `paths` is the expanded absolute path of each name's SKILL.md; `shortPaths`
 *   is the `rN/...` form the rollout actually wrote, kept because a tool call
 *   may quote either one.
 */
export function codexSkillsOffered(developerText) {
  const block = CODEX_SKILLS_BLOCK.exec(String(developerText ?? ""))?.[1];
  if (!block) return { names: [], paths: {}, shortPaths: {} };
  const roots = new Map();
  const names = [], paths = {}, shortPaths = {};
  let section = "";
  for (const line of block.split("\n")) {
    const text = line.trim();
    if (text.startsWith("#")) { section = text.replace(/^#+\s*/, "").toLowerCase(); continue; }
    if (!text.startsWith("- ")) continue;
    const body = text.slice(2).trim();
    if (section === "skill roots") {
      // - `r0` = `C:/Users/heffn/.codex/skills`
      const root = /^`([^`]+)`\s*=\s*`([^`]+)`$/.exec(body);
      if (root) roots.set(root[1], root[2].replace(/[\\/]+$/, ""));
      continue;
    }
    if (section !== "available skills") continue;
    // THE NAME ENDS AT THE FIRST COLON-SPACE. A namespaced name spells its
    // namespace with a bare colon and no space ("sites:sites-building"), while
    // the separator before the description always has the space — so this one
    // rule keeps the namespace and still stops before a description that
    // contains colons of its own.
    const at = body.indexOf(": ");
    if (at <= 0) continue;
    const name = body.slice(0, at).trim();
    if (!name) continue;
    names.push(name);
    // The trailing "(file: ...)" is the last parenthesis on the line; a
    // description may hold parentheses of its own, so anchor at the end.
    const short = /\(file:\s*([^)]+)\)\s*$/.exec(body)?.[1]?.trim();
    if (!short) continue;
    shortPaths[name] = short;
    const segments = short.split(/[\\/]/);
    const root = roots.get(segments[0]);
    // A short path whose root was never declared stays as written rather than
    // becoming a fabricated absolute path.
    paths[name] = root ? [root, ...segments.slice(1)].join("/") : short;
  }
  return { names: sorted(names), paths, shortPaths };
}

/**
 * The catalog entries whose SKILL.md a run actually read.
 *
 * Evidence is a tool call's arguments naming the file. Both spellings count —
 * the short `rN/...` form the catalog gave and the absolute form the model
 * expands it to — and both slash directions, because a Windows path reaches
 * the arguments as JSON with its separators doubled. The comparison is
 * lowercased whole, which covers the drive letter and costs only the ability
 * to tell apart two skills whose paths differ by case alone.
 *
 * @param {{ names: string[], paths: Record<string, string>, shortPaths?: Record<string, string> }} offered
 * @param {string[]} toolCallTexts every tool call's argument text
 * @returns {string[]}
 */
export function codexSkillsUsed(offered, toolCallTexts) {
  const names = offered?.names ?? [];
  if (names.length === 0) return [];
  const haystack = pathNeedle((toolCallTexts ?? []).filter((text) => typeof text === "string").join("\n"));
  if (!haystack) return [];
  const used = [];
  for (const name of names) {
    const candidates = [offered.paths?.[name], offered.shortPaths?.[name]]
      .map(pathNeedle)
      .filter((candidate) => candidate.length > 0);
    if (candidates.some((candidate) => haystack.includes(candidate))) used.push(name);
  }
  return sorted(used);
}

function codexParent(meta) {
  if (typeof meta.parent_thread_id === "string") return meta.parent_thread_id;
  if (typeof meta.parent === "string") return meta.parent;
  if (meta.parent && typeof meta.parent === "object") return meta.parent.thread_id ?? meta.parent.id;
  return null;
}

export function parseCodexFile({ path, text, host, fileVersion, fromLine = 0, baseLine: suppliedBaseLine = fromLine }) {
  // `baseLine` is the absolute source-line ordinal of text's first supplied
  // line. `fromLine` remains its older spelling for callers that already use
  // it; an explicit baseLine wins when both are present.
  const baseLine = suppliedBaseLine ?? fromLine;
  if (!Number.isInteger(baseLine) || baseLine < 0) throw new RangeError("baseLine must be a non-negative integer");
  const { lines, incompleteTail } = fileLines(text); const rows = [], children = [], attachments = [], dropped = {};
  const firstFileTimestamp = lines.map((raw) => { try { return millis(JSON.parse(raw).timestamp); } catch { return 0; } }).find(Boolean) ?? 0;
  const drop = (kind) => { dropped[kind] = (dropped[kind] ?? 0) + 1; };
  let meta = {}, runId, parentId, model, effort, startedAt = firstFileTimestamp, lastLineAt = 0, runtimeVersion, finalTextSeq, toolCalls = 0, approvalPolicy, sandboxPolicy, modelChangeReported = false;
  let currentTurn = 0; const turns = new Map(); let lastTokenCount = null; const usageRecords = []; let taskComplete = null; let lastAssistantText = null;
  const longContextRequestKeys = new Set();
  for (let relativeLine = 0; relativeLine < lines.length; relativeLine += 1) {
    const line = baseLine + relativeLine; const raw = lines[relativeLine]; if (!raw.trim()) { drop("_blank"); continue; }
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
      if (payload.type === "token_count") {
        lastTokenCount = payload.info?.total_token_usage ?? null;
        const lastUsage = payload.info?.last_token_usage;
        if (number(lastUsage?.input_tokens) > 272_000) {
          // Rollouts normally emit one token_count per response. Prefer a
          // response identifier when a future CLI supplies one, otherwise the
          // source ordinal is the only honest per-request evidence.
          longContextRequestKeys.add(String(payload.response_id ?? payload.info?.response_id ?? entry.ordinal ?? line));
        }
      }
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
  // A full ingest assembles context from the metadata in the file. A tail has
  // no synthetic context row, and its run facts are intentionally tail-local.
  for (const raw of lines) { try { const entry = JSON.parse(raw); const p = entry.payload ?? {}; if (entry.type === "session_meta") meta = p; if (entry.type === "turn_context") { model ??= p.model; effort ??= p.effort; approvalPolicy ??= p.approval_policy; sandboxPolicy ??= p.sandbox_policy?.type; } } catch {} }
  const id = meta.id ?? meta.session_id ?? "unknown"; runId = `codex:${host}:${id}`; parentId = codexParent(meta);
  const developer = lines.map((raw) => { try { return JSON.parse(raw); } catch { return null; } }).find((entry) => entry?.type === "response_item" && entry.payload?.type === "message" && entry.payload?.role === "developer");
  const prompt = (developer?.payload?.content ?? []).map((part) => part.text ?? part.input_text ?? "").join("\n");
  const mot = modelOfTomFromPrompt(prompt);
  const tools = [];
  // The same pass collects what each tool call was ASKED to do, because that
  // text is the only evidence a rollout leaves that a SKILL.md was read.
  const toolCallTexts = [];
  for (const raw of lines) {
    try {
      const p = JSON.parse(raw).payload ?? {};
      if (!["custom_tool_call", "function_call"].includes(p.type)) continue;
      if (p.name) tools.push(p.name);
      // A call with no name still carries arguments worth reading.
      const args = p.arguments ?? p.input;
      if (typeof args === "string") toolCallTexts.push(args);
      else if (args !== undefined && args !== null) toolCallTexts.push(JSON.stringify(args));
    } catch {}
  }
  const offered = codexSkillsOffered(prompt);
  const permissionMode = sandboxPolicy ? `approval=${approvalPolicy ?? "unknown"}; sandbox=${sandboxPolicy}` : approvalPolicy;
  const context = { ...mot, skillsOffered: sorted(offered.names), skillsUsed: sorted(codexSkillsUsed(offered, toolCallTexts)), tools: sorted(tools), hooks: [], ...(meta.cwd ? { cwd: meta.cwd } : {}), ...(meta.git?.branch ? { gitBranch: meta.git.branch } : {}), ...(meta.git?.commit_hash ? { gitCommit: meta.git.commit_hash } : {}), ...(meta.base_instructions?.text ? { baseInstructionsHash: sha256(meta.base_instructions.text) } : {}), ...(meta.originator ? { originator: meta.originator } : {}), ...(meta.context_window ? { contextWindow: meta.context_window } : {}), ...(permissionMode ? { permissionMode } : {}) };
  if (baseLine === 0) rows.unshift({ seq: 0, turn: 0, kind: "context", content: { ...(model ? { model } : {}), ...context, prompt }, depth: parentId ? 1 : 0, provenance: provenance({ path, fileVersion, line: 0, block: 0, sourceKind: "context" }), createdAt: startedAt });
  if (taskComplete?.message && taskComplete.message !== lastAssistantText) { const row = { seq: sourceSeq(taskComplete.line, 998), turn: taskComplete.turn, kind: "assistant-text", content: { text: taskComplete.message }, depth: parentId ? 1 : 0, provenance: provenance({ path, fileVersion, line: taskComplete.line, block: 998, sourceKind: "event_msg/task_complete" }), createdAt: taskComplete.timestamp }; rows.push(row); finalTextSeq = row.seq; }
  else if (taskComplete) drop("event_msg/task_complete");
  const totals = lastTokenCount ? totalsOf(lastTokenCount) : usageRecords.map(totalsOf).reduce((sum, item) => ({
    inputTokens: sum.inputTokens + item.inputTokens,
    cacheReadTokens: sum.cacheReadTokens + item.cacheReadTokens,
    cacheWriteTokens: sum.cacheWriteTokens + item.cacheWriteTokens,
    cacheWrite5mTokens: sum.cacheWrite5mTokens + item.cacheWrite5mTokens,
    cacheWrite1hTokens: sum.cacheWrite1hTokens + item.cacheWrite1hTokens,
    cacheWriteBreakdownKnown: sum.cacheWriteBreakdownKnown && item.cacheWriteBreakdownKnown,
    outputTokens: sum.outputTokens + item.outputTokens,
    thinkingTokens: sum.thinkingTokens + item.thinkingTokens,
    totalTokens: sum.totalTokens + item.totalTokens,
  }), { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheWriteBreakdownKnown: true, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 });
  totals.longContextRequests = longContextRequestKeys.size;
  const price = costOf({ model, totals });
  const rootRunId = parentId ? `codex:${host}:${parentId}` : runId;
  const run = { runId, ...(parentId ? { parentRunId: rootRunId } : {}), rootRunId, depth: parentId ? 1 : 0, linkKnown: !parentId, origin: "unknown", host, runner: "codex", ...(model ? { model } : {}), ...(sessionModelOf(model) ? { sessionModel: sessionModelOf(model) } : {}), ...(effort ? { effort } : {}), ...(runtimeVersion ?? meta.cli_version ? { runtimeVersion: runtimeVersion ?? meta.cli_version } : {}), parserVersion: PARSER_VERSION, kind: parentId ? "codex-child" : "unknown", status: "unknown", startedAt, lastLineAt, context, attachments, outcome: { ...(finalTextSeq !== undefined ? { finalTextSeq } : {}), totals, ...(price === null ? {} : { costUsd: price, priceTableVersion: priceTableVersion() }), turns: Math.max(1, turns.size), toolCalls }, file: { path, sourceHash: sha256(Buffer.from(text)), storedHash: fileVersion, bytes: Buffer.byteLength(text), storedBytes: 0, committedLine: baseLine + lines.length, committedPrefixSha256: prefixHash(lines, lines.length), incompleteTail } };
  return finishResult({ run, rows, children, attachments, lastLine: baseLine + lines.length, incompleteTail, dropped });
}

function filesUnder(directory, fs, found = []) {
  let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (entry.isSymbolicLink?.()) continue;
    const file = pathModule.join(directory, entry.name);
    if (entry.isDirectory()) filesUnder(file, fs, found);
    else if (entry.isFile()) found.push(file);
  }
  return found;
}

/**
 * A session's children and its attachment pointers, read from the session
 * directory alone.
 *
 * A child transcript is `agent-<agentId>.jsonl` at ANY depth under
 * `subagents/` — the CLI parks a Workflow's agents at
 * `subagents/workflows/wf_<id>/`, and the folder is where the file lives, not
 * who the run is. Every other file under the session directory is recorded as
 * an attachment pointer instead of vanishing: its sidecar travels with the
 * agent it names, and everything else (`tool-results/`, `attachments/`, the
 * workflow's own `workflows/wf_<id>.json` and `journal.jsonl`) with the root.
 */
export function discoverChildren(sessionFilePath, { fs = fsDefault } = {}) {
  const directory = pathModule.join(pathModule.dirname(sessionFilePath), pathModule.basename(sessionFilePath, ".jsonl"));
  const subagents = []; const toolResults = [];
  const subDir = pathModule.join(directory, "subagents");
  const attachmentsByAgent = new Map();
  const pointer = (file) => { try { const bytes = fs.readFileSync(file); return { file, bytes: bytes.length, sha256: sha256(bytes) }; } catch { return null; } };
  for (const file of filesUnder(directory, fs)) {
    const name = pathModule.basename(file);
    const inSubagents = file.startsWith(`${subDir}${pathModule.sep}`);
    const child = inSubagents && AGENT_FILE.exec(name);
    if (child) {
      const metaFile = pathModule.join(pathModule.dirname(file), `agent-${child[1]}.meta.json`);
      let meta = null;
      if (fs.existsSync(metaFile)) { try { meta = JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch {} }
      const workflowId = workflowIdOfPath(file);
      subagents.push({ file, metaFile, agentId: child[1], meta, ...(workflowId ? { workflowId } : {}) });
      continue;
    }
    const sidecar = inSubagents && AGENT_SIDECAR.exec(name);
    const item = pointer(file);
    if (!item) continue;
    if (sidecar) {
      const list = attachmentsByAgent.get(sidecar[1]) ?? [];
      list.push(item); attachmentsByAgent.set(sidecar[1], list);
    } else toolResults.push(item);
  }
  subagents.sort((a, b) => a.file.localeCompare(b.file));
  toolResults.sort((a, b) => a.file.localeCompare(b.file));
  for (const child of subagents) {
    const own = attachmentsByAgent.get(child.agentId);
    if (own) { child.attachments = own; attachmentsByAgent.delete(child.agentId); }
  }
  // A sidecar whose transcript is gone still belongs to the record; the root
  // is the nearest run left to hold it.
  for (const orphaned of attachmentsByAgent.values()) toolResults.push(...orphaned);
  return { subagents, toolResults };
}
