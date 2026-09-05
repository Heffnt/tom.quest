#!/usr/bin/env node
// A stand-in for the Codex binary, driven through CODEX_BIN by
// codex-query.test.mjs. It reads the prompt from stdin (the `-` argument),
// appends the argv it was given to FAKE_CODEX_ARGS_FILE (one JSON line per
// invocation, so the test can assert the exact resume flags), and prints
// canned JSONL chosen by the PROMPT text — the prompt is the one channel a
// test controls per turn. The shapes are copied from real `codex exec --json`
// runs (codex-cli 0.130 and, for the collab_tool_call events, 0.153.3 with
// gpt-5.6-terra on 2026-09-04) plus the todo/mcp item shapes from the
// app-server protocol schema.
//
// Never installed on the box: setup.sh copies worker/session-host/*.mjs one
// level deep, and this file is two levels down on purpose.

import fs from "node:fs";

const argv = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");
if (process.env.FAKE_CODEX_ARGS_FILE) {
  fs.appendFileSync(
    process.env.FAKE_CODEX_ARGS_FILE,
    JSON.stringify({ argv, prompt }) + "\n",
  );
}

const isResume = argv[0] === "exec" && argv[1] === "resume";
const threadId = isResume ? argv[2] : "thread-fake-0001";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

// Every run announces its thread the way Codex does.
emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });

if (prompt.includes("SCENARIO:full")) {
  process.stdout.write("not json: sandbox helper chatter\n");
  emit({
    type: "item.started",
    item: {
      id: "item_0",
      type: "command_execution",
      command: "echo hello",
      aggregated_output: "",
      exit_code: null,
      status: "in_progress",
    },
  });
  emit({
    type: "item.completed",
    item: {
      id: "item_0",
      type: "command_execution",
      command: "echo hello",
      aggregated_output: "hello\n",
      exit_code: 0,
      status: "completed",
    },
  });
  emit({
    type: "item.completed",
    item: { id: "item_1", type: "reasoning", text: "I should write the file." },
  });
  emit({
    type: "item.started",
    item: {
      id: "item_2",
      type: "file_change",
      changes: [
        { path: "/w/a.txt", kind: "add" },
        { path: "/w/b.txt", kind: "update" },
        { path: "/w/c.txt", kind: "delete" },
      ],
      status: "in_progress",
    },
  });
  emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "file_change",
      changes: [
        { path: "/w/a.txt", kind: "add" },
        { path: "/w/b.txt", kind: "update" },
        { path: "/w/c.txt", kind: "delete" },
      ],
      status: "completed",
    },
  });
  // mcp_tool_call: only a completed event (no started) — the tool_use must
  // still be emitted, alongside its result.
  emit({
    type: "item.completed",
    item: {
      id: "item_3",
      type: "mcp_tool_call",
      server: "github",
      tool: "get_issue",
      arguments: { number: 7 },
      result: { content: [{ type: "text", text: "issue #7: open" }] },
      status: "completed",
    },
  });
  emit({
    type: "item.completed",
    item: { id: "item_4", type: "web_search", query: "codex exec json", status: "completed" },
  });
  emit({
    type: "item.started",
    item: {
      id: "item_5",
      type: "todo_list",
      items: [{ text: "write tests", completed: false }],
    },
  });
  emit({
    type: "item.completed",
    item: {
      id: "item_5",
      type: "todo_list",
      items: [{ text: "write tests", completed: true }],
    },
  });
  // Native subagents, EXACTLY as codex-cli 0.153.3 emits them. A turn that
  // spawned an explorer subagent and waited for it produced only this one
  // pair of events: spawn_agent is a SubAgentActivity item internally and
  // `codex exec --json` does not serialize that type, so the spawn is
  // invisible, and the wait's receivers/prompt/agents_states are all empty.
  emit({
    type: "item.started",
    item: {
      id: "item_6",
      type: "collab_tool_call",
      tool: "wait",
      sender_thread_id: threadId,
      receiver_thread_ids: [],
      prompt: null,
      agents_states: {},
      status: "in_progress",
    },
  });
  emit({
    type: "item.completed",
    item: {
      id: "item_6",
      type: "collab_tool_call",
      tool: "wait",
      sender_thread_id: threadId,
      receiver_thread_ids: [],
      prompt: null,
      agents_states: {},
      status: "completed",
    },
  });
  // The populated form: the fields CollabAgentToolCallItem declares, filled
  // in. 0.153.3's v2 collaboration runtime never fills them, but the item
  // struct (receiver_agents, prompt, agents_states of CollabAgentState
  // { status, message }) is its own, so this pins the per-child rendering.
  emit({
    type: "item.completed",
    item: {
      id: "item_7",
      type: "collab_tool_call",
      tool: "spawn_agent",
      sender_thread_id: threadId,
      receiver_thread_ids: ["child-1"],
      receiver_agents: ["/root/explorer"],
      prompt: "review the diff",
      agents_states: {
        "child-1": { status: "completed", message: "diff looks fine" },
      },
      status: "completed",
    },
  });
  // Advisory error: must NOT end the turn.
  emit({ type: "error", message: "stream reset; retrying" });
  emit({ type: "item.completed", item: { id: "item_8", type: "agent_message", text: "done" } });
  emit({
    type: "turn.completed",
    usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 },
  });
} else if (prompt.includes("SCENARIO:fail")) {
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "partial" } });
  emit({ type: "turn.failed", error: { message: "usage_limit_reached: weekly cap" } });
} else if (prompt.includes("SCENARIO:crash")) {
  // A crash mid-turn: some output, then a non-zero exit with no turn.* end.
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "about to die" } });
  process.stderr.write("thread 'main' panicked at something.rs\n");
  process.exit(3);
} else if (prompt.includes("SCENARIO:hang")) {
  // Never finishes on its own — the test interrupts it.
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "working..." } });
  setInterval(() => {}, 1000);
} else {
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "ok" } });
  emit({
    type: "turn.completed",
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
  });
}
