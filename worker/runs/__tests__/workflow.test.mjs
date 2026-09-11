// A Workflow's agents are ordinary child runs. The CLI parks them one folder
// deeper than a Task's — `subagents/workflows/wf_<id>/agent-<agentId>.jsonl` —
// and gives them a thinner sidecar (agentType and spawnDepth, sometimes model;
// never the description, parentAgentId or toolUseId a Task writes). The agent
// id is the identity, so the folder changes nothing about the run: one tree,
// one thread id, one way to view it, however deep the spawning goes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { describeRunFile, discoverRunFiles } from "../discover.mjs";
import { discoverChildren, parseClaudeFile } from "../ingest.mjs";
import { openStore } from "../store.mjs";
import { claudeUserTurn, jsonl, subagentMeta } from "./fixtures.mjs";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "runs-workflow-"));
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return file; };

/**
 * root → workflow agent W (depth 1, parent root) → W's own subagent C
 * (depth 2), with the non-transcript files the CLI leaves beside them.
 */
function tree() {
  const dir = temp();
  const claude = path.join(dir, "claude");
  const project = path.join(claude, "project");
  const session = path.join(project, "session");
  const root = write(path.join(project, "session.jsonl"), jsonl([claudeUserTurn({ text: "run the workflow" })]));
  const workflowAgent = write(path.join(session, "subagents", "workflows", "wf_abc", "agent-W.jsonl"), jsonl([claudeUserTurn({ text: "phase one" })]));
  write(path.join(session, "subagents", "workflows", "wf_abc", "agent-W.meta.json"), JSON.stringify({ agentType: "workflow-subagent", spawnDepth: 1, model: "opus" }));
  // A workflow agent may spawn in turn, and its child is written where any
  // child is. Depth and parentage come from the sidecar, not the folder.
  const grandchild = write(path.join(session, "subagents", "agent-C.jsonl"), jsonl([claudeUserTurn({ text: "sub-task" })]));
  write(path.join(session, "subagents", "agent-C.meta.json"), JSON.stringify(subagentMeta({ parentAgentId: "W", spawnDepth: 2, toolUseId: "task-1" })));
  // Three non-transcripts: the workflow's own journal and run record, and a
  // stored tool result.
  const journal = write(path.join(session, "subagents", "workflows", "wf_abc", "journal.jsonl"), jsonl([{ phase: 1 }]));
  const record = write(path.join(session, "workflows", "wf_abc.json"), JSON.stringify({ runId: "wf_abc", agentCount: 1 }));
  const toolResult = write(path.join(session, "tool-results", "r.txt"), "result");
  return { dir, claude, root, workflowAgent, grandchild, journal, record, toolResult };
}

describe("workflow agents are ordinary children", () => {
  it("discovers a workflow transcript as a subagent and everything else as an attachment", () => {
    const t = tree();
    const found = discoverRunFiles({ roots: { claude: [{ path: t.claude }], codex: [] }, host: "laptop" });
    const byKind = (kind) => found.filter((item) => item.kind === kind);
    expect(byKind("root").map((item) => item.threadId)).toEqual(["session"]);
    expect(byKind("subagent").map((item) => item.threadId).sort()).toEqual(["session/C", "session/W"]);
    expect(found.find((item) => item.path === t.workflowAgent)).toMatchObject({ kind: "subagent", threadId: "session/W", workflowId: "wf_abc" });
    expect(found.find((item) => item.path === t.grandchild).workflowId).toBeUndefined();
    // Nothing under the session directory is lost, and nothing else is a run.
    expect(byKind("attachment").map((item) => `${item.threadId} ${path.basename(item.path)}`).sort()).toEqual([
      "session journal.jsonl",
      "session r.txt",
      "session wf_abc.json",
      "session/C agent-C.meta.json",
      "session/W agent-W.meta.json",
    ]);
    // A hook naming the file directly reads it the same way.
    expect(describeRunFile(t.workflowAgent, { roots: { claude: [{ path: t.claude }], codex: [] }, host: "laptop" })).toMatchObject({ kind: "subagent", threadId: "session/W", workflowId: "wf_abc" });
    expect(describeRunFile(t.workflowAgent, { roots: { claude: [], codex: [] }, host: "laptop" })).toMatchObject({ kind: "subagent", threadId: "session/W", workflowId: "wf_abc" });
  });

  it("walks the subagents tree recursively and hangs every other file on the nearest run", () => {
    const t = tree();
    const { subagents, toolResults } = discoverChildren(t.root);
    expect(subagents.map((child) => child.agentId).sort()).toEqual(["C", "W"]);
    const workflow = subagents.find((child) => child.agentId === "W");
    expect(workflow).toMatchObject({ file: t.workflowAgent, workflowId: "wf_abc", meta: { agentType: "workflow-subagent", spawnDepth: 1 } });
    expect(workflow.attachments.map((item) => path.basename(item.file))).toEqual(["agent-W.meta.json"]);
    expect(subagents.find((child) => child.agentId === "C").workflowId).toBeUndefined();
    expect(toolResults.map((item) => item.file).sort()).toEqual([t.journal, t.record, t.toolResult].sort());
    for (const item of toolResults) expect(item).toMatchObject({ bytes: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("parses the workflow agent at depth one under the root and its own child at depth two", () => {
    const t = tree();
    const parsed = (file, meta) => parseClaudeFile({ path: file, host: "laptop", fileVersion: "v", parentSessionId: "session", agentMeta: meta, text: fs.readFileSync(file, "utf8") });
    const workflow = parsed(t.workflowAgent, { agentType: "workflow-subagent", spawnDepth: 1, agentId: "W", workflowId: "wf_abc" });
    expect(workflow.run).toMatchObject({
      runId: "claude:laptop:session/W",
      parentRunId: "claude:laptop:session",
      rootRunId: "claude:laptop:session",
      depth: 1,
      // No tool-use id exists to name: the Workflow sidecar does not carry one.
      linkKnown: false,
      origin: "workflow",
      kind: "subagent",
    });
    expect(workflow.run.spawnedByToolUseId).toBeUndefined();
    expect(workflow.run.context.workflowId).toBe("wf_abc");
    expect(workflow.rows.some((row) => row.kind === "error")).toBe(false);

    const child = parsed(t.grandchild, { ...subagentMeta({ parentAgentId: "W", spawnDepth: 2, toolUseId: "task-1" }), agentId: "C" });
    expect(child.run).toMatchObject({ runId: "claude:laptop:session/C", parentRunId: "claude:laptop:session/W", depth: 2, linkKnown: true, spawnedByToolUseId: "task-1", origin: "unknown" });
    expect(child.run.context.workflowId).toBeUndefined();
  });

  it("keeps the store key a session and an agent, whatever folder the file sat in", () => {
    const t = tree();
    const store = openStore({ backend: "local", dir: path.join(t.dir, "objects") });
    const stored = store.put({ runtime: "claude", threadId: "session/W", host: "laptop", sourceBytes: fs.readFileSync(t.workflowAgent) });
    expect(stored.verified).toBe(true);
    expect(stored.key.split("/").slice(0, 5)).toEqual(["runs", "claude", "laptop", "session", "W"]);
    expect(stored.key.split("/")).toHaveLength(6);
  });
});
