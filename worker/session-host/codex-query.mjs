// codex-query.mjs — OpenAI's Codex CLI as a session runner, behind the same
// surface session.mjs already consumes from @anthropic-ai/claude-agent-sdk's
// query(): an async iterator of typed messages (system/init, assistant, user,
// result) plus interrupt().
//
// A session whose model is in the "codex" FAMILY (ttsShared SESSION_MODELS —
// gpt-5.6-sol, gpt-5.6-terra; ratified by Tom 2026-09-04) is driven by
// `codex exec --json` instead of the Agent SDK. session.mjs was written
// against the SDK's message vocabulary, so rather than teach it a second one
// this module speaks the first: it reads Codex's JSONL event stream and yields
// SDK-shaped messages, and every transcript row, status transition, flush and
// ending in session.mjs works unchanged. Tom's ruling is that a Codex
// session's transcript must land in TTS exactly like a Claude one; the
// translation table (translateEvent) is where that promise is kept.
//
// ONE CODEX PROCESS PER USER TURN. Codex has no long-lived streaming input:
// the first turn runs `codex exec`, which mints a thread id, and every later
// turn runs `codex exec resume <thread id>` — Codex's own persisted context
// carries over, the way the SDK's resume-by-id does. The thread id is reported
// as the session's sdkSessionId, so a daemon restart resumes a Codex session
// exactly like a Claude one. That is why --ephemeral is NEVER passed: an
// ephemeral thread is not on disk to resume after a restart.
//
// SANDBOX OFF, ON PURPOSE (Tom, 2026-09-04): the Jarvis Box IS the sandbox.
// Every session already runs in a throwaway workdir under /var/cache, pushes
// only to session/<id>, and cannot reach a merge or a ruling pen — so Codex
// runs with --dangerously-bypass-approvals-and-sandbox and its own
// workspace-write confinement is not layered on top. What is deliberately NOT
// here either: a per-tool-call permission gate. Codex's JSON stream reports
// commands AFTER they ran, so session.mjs's #canUseTool (the edit-path check,
// the Bash classifier, the Tier-0 self-destruction guard) never sees a Codex
// call. worker/session-host/README.md states this posture.
//
// Zero npm dependencies, like the rest of the box.

import readline from "node:readline";
import { CODEX_BIN, codexArgs, spawnCodex } from "./codex-bin.mjs";

// The binary, the spawn shim and the per-turn flags live in codex-bin.mjs
// (one home for this runner and session-host.mjs's warm-up/usage spawns);
// codexArgs is re-exported so the flag contract stays reachable from here.
export { codexArgs };

// Keep the last N bytes of stderr for the error text: Codex writes its whole
// progress log there (hundreds of KB on a long turn) and only the tail says
// what went wrong. Nothing else from stderr ever reaches a transcript row.
const STDERR_TAIL_BYTES = 8 * 1024;

function truncateTail(text, max) {
  return text.length > max ? text.slice(text.length - max) : text;
}

// SDK tool_result content is a string or an array of typed blocks; MCP
// results in Codex are { content: [...blocks], structured_content }. Flatten
// to text here so the row reads as output, not as block scaffolding.
function mcpResultText(result) {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  const blocks = Array.isArray(result?.content) ? result.content : null;
  if (blocks) {
    return blocks
      .map((b) => (typeof b?.text === "string" ? b.text : JSON.stringify(b)))
      .join("\n");
  }
  return JSON.stringify(result);
}

// WHAT CODEX ACTUALLY REPORTS ABOUT A NATIVE SUBAGENT (codex-cli 0.153.3,
// multi_agent_version v2, verified against a real `codex exec --json` run):
// almost nothing. Internally Codex has two turn items for collaboration —
// CollabAgentToolCall and SubAgentActivity — but `codex exec --json`
// serializes only eight item types (agent_message, reasoning,
// command_execution, file_change, mcp_tool_call, collab_tool_call,
// web_search, todo_list). SubAgentActivity is NOT one of them, and it is the
// item that spawn_agent and send_message produce. So on this Codex:
//
//   * spawn_agent / send_message emit NO event on stdout at all;
//   * only wait_agent surfaces, as collab_tool_call with tool "wait";
//   * that item arrives with receiver_thread_ids: [], receiver_agents: [],
//     prompt: null and agents_states: {} — the fields are declared but the
//     v2 collaboration runtime never fills them in;
//   * the child's answer reaches the parent as an internal message and shows
//     up only inside the parent's next agent_message.
//
// A transcript therefore cannot show the spawn — the event does not exist to
// translate. What it MUST NOT do is show a blank row: a `codex.wait` whose
// result is the empty string reads as a broken runner. So the result text
// falls back to the item's own tool/status/receivers when agents_states is
// empty, and renders the per-child lines when a Codex that fills them in
// (or a spawn item carrying the new child thread id) does arrive.
//
// The map's value is CollabAgentState { status, message }; status is one of
// pending_init | running | interrupted | errored | shutdown | not_found.
function agentsStatesLines(states) {
  if (!states || typeof states !== "object") return [];
  return Object.entries(states).map(([threadId, s]) => {
    const status = s?.status ?? "unknown";
    const message = typeof s?.message === "string" ? s.message : "";
    return `${threadId}: ${status}${message ? ` — ${message}` : ""}`;
  });
}

// Who the call was aimed at. receiver_agents carries agent paths
// ("/root/explorer") and receiver_thread_ids the child thread ids; either
// may be absent, and on v2 both are empty for a bare wait.
function collabReceivers(item) {
  const agents = Array.isArray(item.receiver_agents) ? item.receiver_agents : [];
  const threads = Array.isArray(item.receiver_thread_ids)
    ? item.receiver_thread_ids
    : [];
  return agents.length > 0 ? agents : threads;
}

function collabResultText(item) {
  const lines = agentsStatesLines(item.agents_states);
  if (lines.length > 0) return lines.join("\n");
  const receivers = collabReceivers(item);
  const who = receivers.length > 0 ? receivers.join(", ") : "any agent";
  return `${item.tool ?? "collab"} ${item.status ?? "completed"} (${who})`;
}

const assistant = (blocks) => ({
  type: "assistant",
  message: { role: "assistant", content: blocks },
  parent_tool_use_id: null,
});
// Tool results and SDK-side text both ride the "user" message in the SDK's
// vocabulary; session.mjs records text blocks there as system rows.
const userMessage = (blocks) => ({
  type: "user",
  message: { role: "user", content: blocks },
  parent_tool_use_id: null,
});
const systemText = (text) => userMessage([{ type: "text", text }]);

// The tool_use blocks an item stands for. A file_change item bundles every
// file the model touched in one apply_patch, so it becomes one tool_use PER
// FILE (Write / Edit / Delete by the change's kind), each with its own id, so
// the transcript reads one row per file like a Claude session's does.
function toolUsesFor(item) {
  switch (item.type) {
    case "command_execution":
      return [
        {
          type: "tool_use",
          id: item.id,
          name: "Bash",
          input: { command: item.command ?? "" },
        },
      ];
    case "file_change":
      return (item.changes ?? []).map((c, i) => ({
        type: "tool_use",
        id: `${item.id}:${i}`,
        name:
          c.kind === "add" ? "Write" : c.kind === "delete" ? "Delete" : "Edit",
        input: { file_path: c.path },
      }));
    case "mcp_tool_call":
      return [
        {
          type: "tool_use",
          id: item.id,
          name: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`,
          input: item.arguments ?? {},
        },
      ];
    case "web_search":
      return [
        {
          type: "tool_use",
          id: item.id,
          name: "WebSearch",
          input: { query: item.query ?? "" },
        },
      ];
    case "collab_tool_call": {
      // Native Codex subagents. The tool field is one of exactly four values
      // — spawn_agent | send_input | wait | close_agent — and on 0.153.3 only
      // "wait" is ever emitted (see the note above agentsStatesLines). The
      // receivers are the child agent paths or thread ids; the prompt is what
      // was delegated, and is null on every v2 item observed so far.
      const receivers = collabReceivers(item);
      const input = {
        ...(typeof item.prompt === "string" && item.prompt
          ? { prompt: item.prompt }
          : {}),
        receivers,
        ...(typeof item.agent_type === "string"
          ? { agent_type: item.agent_type }
          : {}),
        ...(typeof item.model === "string" ? { model: item.model } : {}),
      };
      return [
        {
          type: "tool_use",
          id: item.id,
          name: `codex.${item.tool ?? "collab"}`,
          input,
        },
      ];
    }
    default:
      return [];
  }
}

function toolResultsFor(item) {
  const failed = item.status === "failed";
  switch (item.type) {
    case "command_execution": {
      const code = item.exit_code;
      const nonZero = typeof code === "number" && code !== 0;
      return [
        {
          type: "tool_result",
          tool_use_id: item.id,
          content: item.aggregated_output ?? "",
          is_error: nonZero || failed,
        },
      ];
    }
    case "file_change":
      return (item.changes ?? []).map((c, i) => ({
        type: "tool_result",
        tool_use_id: `${item.id}:${i}`,
        content: `${c.kind}: ${c.path}`,
        is_error: failed,
      }));
    case "mcp_tool_call":
      return [
        {
          type: "tool_result",
          tool_use_id: item.id,
          content:
            item.error !== undefined && item.error !== null
              ? typeof item.error === "string"
                ? item.error
                : JSON.stringify(item.error)
              : mcpResultText(item.result),
          is_error: failed || (item.error !== undefined && item.error !== null),
        },
      ];
    case "web_search":
      return [
        {
          type: "tool_result",
          tool_use_id: item.id,
          content: failed ? "search failed" : "search complete",
          is_error: failed,
        },
      ];
    case "collab_tool_call":
      return [
        {
          type: "tool_result",
          tool_use_id: item.id,
          content: collabResultText(item),
          is_error: failed,
        },
      ];
    default:
      return [];
  }
}

// Translate one Codex JSONL event into zero or more SDK-shaped messages.
// `seen` tracks item ids whose tool_use was already emitted on item.started,
// so item.completed adds only the result — but a version that skips the
// started event (or an item type that only completes) still gets its
// tool_use, emitted alongside the result.
export function translateEvent(ev, seen = new Set()) {
  const out = [];
  switch (ev.type) {
    case "thread.started":
      // The resume key: session.mjs reports it as sdkSessionId on this
      // message, exactly as it does for the SDK's own init.
      out.push({
        type: "system",
        subtype: "init",
        session_id: ev.thread_id,
        agent: "codex",
      });
      break;
    case "item.started": {
      const item = ev.item ?? {};
      if (item.type === "todo_list") {
        // The model's plan, as it was first laid out. Recorded once here and
        // once at completion — item.updated fires on every checkbox and
        // would flood the transcript with near-identical lists.
        out.push(systemText(`codex plan:\n${JSON.stringify(item.items ?? [], null, 0)}`));
        break;
      }
      const uses = toolUsesFor(item);
      if (uses.length > 0) {
        seen.add(item.id);
        out.push(assistant(uses));
      }
      break;
    }
    case "item.completed": {
      const item = ev.item ?? {};
      switch (item.type) {
        case "agent_message":
          if (item.text) out.push(assistant([{ type: "text", text: item.text }]));
          break;
        case "reasoning": {
          const text =
            item.text ??
            (Array.isArray(item.summary) ? item.summary.join("\n") : "");
          if (text) out.push(assistant([{ type: "thinking", thinking: text }]));
          break;
        }
        case "todo_list":
          out.push(
            systemText(`codex plan (final):\n${JSON.stringify(item.items ?? [], null, 0)}`),
          );
          break;
        case "error":
          // An item-level error (a tool that could not run, a refused
          // request). Advisory like the top-level error below: the turn's
          // own turn.failed / turn.completed says whether it survived.
          out.push(systemText(`codex: ${item.message ?? "error"}`));
          break;
        default: {
          const uses = toolUsesFor(item);
          if (uses.length === 0) break;
          if (!seen.has(item.id)) out.push(assistant(uses));
          seen.delete(item.id);
          out.push(userMessage(toolResultsFor(item)));
        }
      }
      break;
    }
    case "turn.completed":
      out.push({
        type: "result",
        subtype: "success",
        is_error: false,
        // Carried for parity with the SDK's result; session.mjs persists
        // cost facts only on error rows, so this is informational today.
        usage: ev.usage,
      });
      break;
    case "turn.failed":
      out.push({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: ev.error?.message ?? "codex turn failed",
      });
      break;
    case "error":
      // ADVISORY, not terminal: Codex emits a bare {"type":"error"} for
      // conditions it goes on to retry (a transport hiccup, a stream reset).
      // Recording it as a system row keeps the transcript honest; ending the
      // turn on it would abandon a turn Codex itself was about to finish.
      // The turn ends on turn.failed, turn.completed, or the process exiting
      // without either (runTurn throws).
      out.push(systemText(`codex: ${ev.message ?? "error"}`));
      break;
    default:
      // turn.started, item.updated, and anything a newer Codex adds: no row.
      break;
  }
  return out;
}

// The query object. `prompt` is the async iterable of user turns session.mjs
// builds (promptStream over its TurnQueue); `options` carries cwd, env, the
// resume thread id, the model id + reasoning effort from SESSION_MODELS, and
// the AbortController session.mjs uses for force-kill.
export function codexQuery({ prompt, options }) {
  const state = {
    child: null,
    threadId: options.resume,
    interrupted: false,
    aborted: false,
  };

  // SIGKILL the whole process group: the child is spawned detached so it
  // leads its own group and the negative pid takes its helpers (the model's
  // running shell commands) down with it. Falls back to the child alone
  // where groups do not exist (Windows, in the unit test).
  const killChild = () => {
    const child = state.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  };

  options.abortController?.signal.addEventListener("abort", () => {
    state.aborted = true;
    killChild();
  });

  async function* runTurn(text) {
    const args = codexArgs({
      threadId: state.threadId,
      cwd: options.cwd,
      model: options.model,
      effort: options.effort,
    });
    const child = spawnCodex(args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    state.child = child;
    let stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail = truncateTail(stderrTail + chunk, STDERR_TAIL_BYTES);
    });
    const exit = new Promise((resolve) => {
      child.on("error", (err) => resolve({ code: null, spawnError: err }));
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    child.stdin.on("error", () => {
      // The child died before reading the prompt; the exit tells the story.
    });
    child.stdin.end(text);

    const seen = new Set();
    let turnEnded = false;
    const lines = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      // Only JSON objects are events; anything else on stdout is chatter
      // from a helper and is ignored.
      if (!line.startsWith("{")) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "thread.started" && ev.thread_id) {
        state.threadId = ev.thread_id;
      }
      for (const m of translateEvent(ev, seen)) {
        if (m.type === "result") turnEnded = true;
        yield m;
      }
    }
    const { code, signal, spawnError } = await exit;
    state.child = null;
    // Same contract as the SDK: interrupt() resolves, then the iterator
    // throws, and session.mjs's #readLoop reads the throw as the expected
    // end of an interrupted turn (resumable by thread id).
    if (state.interrupted || state.aborted) {
      throw new Error("codex turn interrupted");
    }
    if (spawnError) {
      throw new Error(`could not start ${CODEX_BIN}: ${spawnError.message}`);
    }
    if (!turnEnded) {
      // Exit without turn.completed/turn.failed: a crash, a killed process,
      // an auth failure before the first event. #readLoop treats the throw
      // as a failed turn and records the message (stderr tail included).
      const why = signal ? `killed by ${signal}` : `exited ${code}`;
      throw new Error(
        `codex ${why} before the turn completed\n${stderrTail.trim()}`,
      );
    }
    if (typeof code === "number" && code !== 0) {
      // The turn reported its own end but the process still failed — say so
      // where it can be seen, without turning a completed turn into an error.
      yield systemText(
        `codex exited ${code} after the turn ended\n${stderrTail.trim()}`.trim(),
      );
    }
  }

  async function* messages() {
    // The SDK announces itself before any turn; session.mjs moves the session
    // from "starting" to "idle" on this and delivers the first user turn. A
    // fresh Codex thread has no id yet — the real one follows from
    // thread.started inside the first turn, through the same init message,
    // and sdkSessionId is reported then.
    yield {
      type: "system",
      subtype: "init",
      session_id: state.threadId,
      agent: "codex",
    };
    for await (const turn of prompt) {
      state.interrupted = false;
      const content = turn?.message?.content;
      const text =
        typeof content === "string" ? content : JSON.stringify(content ?? "");
      yield* runTurn(text);
    }
    // The prompt iterable ended (session.mjs closed its queue): the clean
    // stop path, same as the SDK's generator ending.
  }

  const iterator = messages();
  return {
    [Symbol.asyncIterator]: () => iterator,
    // Same contract as the SDK: resolves, and the iterator then throws.
    async interrupt() {
      state.interrupted = true;
      killChild();
    },
    threadId: () => state.threadId,
  };
}
