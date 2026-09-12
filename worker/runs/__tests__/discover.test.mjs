import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { describeRunFile, discoverRunFiles } from "../discover.mjs";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "runs-discover-"));

describe("run discovery", () => {
  it("classifies Claude roots, subagents, attachments, and Codex rollouts", () => {
    const dir = temp(); const claude = path.join(dir, "claude"); const codex = path.join(dir, "codex");
    const project = path.join(claude, "project"); const session = path.join(project, "session");
    fs.mkdirSync(path.join(session, "subagents"), { recursive: true });
    fs.mkdirSync(path.join(session, "tool-results"), { recursive: true });
    fs.mkdirSync(path.join(codex, "2026", "09"), { recursive: true });
    fs.writeFileSync(path.join(project, "session.jsonl"), "{}\n");
    fs.writeFileSync(path.join(project, "session.registration.json"), "{}\n");
    fs.writeFileSync(path.join(session, "subagents", "agent-child.jsonl"), "{}\n");
    fs.writeFileSync(path.join(session, "subagents", "agent-child.meta.json"), "{}\n");
    fs.writeFileSync(path.join(session, "tool-results", "tool.txt"), "result");
    fs.writeFileSync(path.join(codex, "2026", "09", "rollout-2026-09-01-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl"), "{}\n");
    const found = discoverRunFiles({ roots: { claude: [{ path: claude, account: "test" }], codex: [{ path: codex }] }, host: "laptop" });
    expect(found.map((item) => item.kind).sort()).toEqual(["attachment", "attachment", "rollout", "root", "subagent"]);
    expect(found.find((item) => item.kind === "root")).toMatchObject({ runtime: "claude", threadId: "session", project: "project", account: "test" });
    expect(found.find((item) => item.kind === "subagent")).toMatchObject({ threadId: "session/child" });
    expect(found.find((item) => item.kind === "rollout")).toMatchObject({ runtime: "codex", threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  });

  it("filters by the file mtime and describes a hook-supplied child directly", () => {
    const dir = temp(); const claude = path.join(dir, "claude"); const file = path.join(claude, "project", "session", "subagents", "agent-child.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "{}\n");
    const item = describeRunFile(file, { roots: { claude: [{ path: claude }], codex: [] }, host: "box" });
    expect(item).toMatchObject({ host: "box", kind: "subagent", threadId: "session/child" });
    expect(discoverRunFiles({ roots: { claude: [{ path: claude }], codex: [] }, host: "box", since: item.mtimeMs })).toEqual([]);
  });
});
