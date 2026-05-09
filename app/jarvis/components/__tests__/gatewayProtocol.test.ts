import { beforeEach, describe, expect, it, vi } from "vitest";

function createCallStub(result: unknown) {
  return vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(result);
}

describe("gatewayProtocol", () => {
  beforeEach(async () => {
    vi.resetModules();
    const { debug } = await import("@/app/lib/debug");
    debug.clear();
  });

  it("calls health with the exact gateway method name and params", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const call = createCallStub({ ok: true, ts: 1, channels: [] });

    const result = await protocol.health(call, { probe: true });

    expect(call).toHaveBeenCalledWith("health", { probe: true });
    expect(result).toMatchObject({ ok: true, ts: 1 });
  });

  it("logs protocol drift when health is missing the ok flag", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const { debug } = await import("@/app/lib/debug");
    const call = createCallStub({ ts: 1 });

    await protocol.health(call);

    expect(debug.getLines().join("\n")).toContain("[gw.proto] ERROR Protocol drift: health");
  });

  it("calls status with the exact gateway method name", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const call = createCallStub({ version: "1.0.0", link: { channel: "whatsapp" } });

    const result = await protocol.status(call);

    expect(call).toHaveBeenCalledWith("status", undefined);
    expect(result).toMatchObject({ version: "1.0.0" });
  });

  it("calls agents.list and validates the raw result shape", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const call = createCallStub({
      defaultId: "main",
      mainKey: "agent:main:main",
      scope: "per-sender",
      agents: [{ id: "main", name: "Jarvis" }],
    });

    const result = await protocol.agentsList(call);

    expect(call).toHaveBeenCalledWith("agents.list", undefined);
    expect(result.defaultId).toBe("main");
  });

  it("calls sessions.list and preserves the page object shape", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const call = createCallStub({
      ts: 1,
      path: "/tmp/sessions",
      count: 1,
      defaults: { modelProvider: "anthropic", model: "sonnet", contextTokens: 200000 },
      sessions: [{ key: "agent:main:main", kind: "direct", updatedAt: 1 }],
    });

    const result = await protocol.sessionsList(call, { limit: 20 });

    expect(call).toHaveBeenCalledWith("sessions.list", { limit: 20 });
    expect(result.sessions).toHaveLength(1);
  });

  it("calls sessions.get using sessionKey and limit", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const call = createCallStub({
      messages: [{ id: "1", role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    const result = await protocol.sessionsGet(call, "agent:main:main", { limit: 50 });

    expect(call).toHaveBeenCalledWith("sessions.get", { sessionKey: "agent:main:main", limit: 50 });
    expect(result.messages).toHaveLength(1);
  });

  it("calls sessions.messages.subscribe and unsubscribe with the exact key payload", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const subscribeCall = createCallStub({ subscribed: true, key: "agent:main:main" });
    const unsubscribeCall = createCallStub({ subscribed: false, key: "agent:main:main" });

    const subscribeResult = await protocol.sessionsMessagesSubscribe(subscribeCall, "agent:main:main");
    const unsubscribeResult = await protocol.sessionsMessagesUnsubscribe(unsubscribeCall, "agent:main:main");

    expect(subscribeCall).toHaveBeenCalledWith("sessions.messages.subscribe", { key: "agent:main:main" });
    expect(unsubscribeCall).toHaveBeenCalledWith("sessions.messages.unsubscribe", { key: "agent:main:main" });
    expect(subscribeResult.subscribed).toBe(true);
    expect(unsubscribeResult.subscribed).toBe(false);
  });

  it("calls chat.history with the expected params shape", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const call = createCallStub({
      sessionKey: "agent:main:main",
      messages: [{ id: "1", role: "assistant", content: [{ type: "text", text: "hello" }] }],
    });

    const result = await protocol.chatHistory(call, "agent:main:main", { limit: 100, maxChars: 5000 });

    expect(call).toHaveBeenCalledWith("chat.history", {
      sessionKey: "agent:main:main",
      limit: 100,
      maxChars: 5000,
    });
    expect(result.messages).toHaveLength(1);
  });

  it("calls chat.send with an auto-generated idempotencyKey", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const call = createCallStub({ runId: "run-1", status: "started" });

    const result = await protocol.chatSend(call, "agent:main:main", "ping");

    expect(call).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        message: "ping",
        idempotencyKey: expect.any(String),
      }),
    );
    expect(result).toMatchObject({ runId: "run-1", status: "started" });
  });

  it("passes through explicit chat.send options", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const call = createCallStub({ runId: "run-2", status: "started" });

    await protocol.chatSend(call, "agent:main:main", "ping", {
      thinking: "high",
      deliver: true,
      timeoutMs: 60000,
      idempotencyKey: "idem-1",
    });

    expect(call).toHaveBeenCalledWith("chat.send", {
      sessionKey: "agent:main:main",
      message: "ping",
      thinking: "high",
      deliver: true,
      timeoutMs: 60000,
      idempotencyKey: "idem-1",
    });
  });

  it("calls chat.abort with sessionKey and optional runId", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const call = createCallStub({ ok: true, aborted: true, runIds: ["run-1"] });

    const result = await protocol.chatAbort(call, "agent:main:main", "run-1");

    expect(call).toHaveBeenCalledWith("chat.abort", { sessionKey: "agent:main:main", runId: "run-1" });
    expect(result.aborted).toBe(true);
  });

  it("calls cron.list and preserves the page object instead of flattening jobs", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const call = createCallStub({
      jobs: [{ id: "cron-1", name: "Morning", enabled: true, schedule: { kind: "cron", expr: "* * * * *" }, state: {} }],
      total: 1,
      offset: 0,
      limit: 20,
      hasMore: false,
    });

    const result = await protocol.cronList(call, { includeDisabled: true });

    expect(call).toHaveBeenCalledWith("cron.list", { includeDisabled: true });
    expect(result.jobs).toHaveLength(1);
  });

  it("logs protocol drift when cron.list does not return a page object", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const { debug } = await import("@/app/lib/debug");
    const call = createCallStub([{ id: "cron-1" }]);

    await protocol.cronList(call);

    expect(debug.getLines().join("\n")).toContain("[gw.proto] ERROR Protocol drift: cron.list");
  });

  it("calls cron.runs with the page params verbatim", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const call = createCallStub({
      entries: [{ ts: 1, jobId: "cron-1", action: "finished", status: "ok" }],
      total: 1,
      offset: 0,
      limit: 10,
      hasMore: false,
    });

    const result = await protocol.cronRuns(call, { id: "cron-1", limit: 10 });

    expect(call).toHaveBeenCalledWith("cron.runs", { id: "cron-1", limit: 10 });
    expect(result.entries).toHaveLength(1);
  });

  it("calls cron.update with id and patch", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const call = createCallStub({ id: "cron-1", enabled: false, state: {} });

    const result = await protocol.cronUpdate(call, "cron-1", { enabled: false });

    expect(call).toHaveBeenCalledWith("cron.update", { id: "cron-1", patch: { enabled: false } });
    expect(result.id).toBe("cron-1");
  });

  it("calls agents.files.list and agents.files.get with required agentId", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const listCall = createCallStub({
      agentId: "main",
      workspace: "/tmp/workspace",
      files: [{ name: "AGENTS.md", path: "/tmp/workspace/AGENTS.md", missing: false }],
    });
    const getCall = createCallStub({
      agentId: "main",
      workspace: "/tmp/workspace",
      file: { name: "AGENTS.md", path: "/tmp/workspace/AGENTS.md", missing: false, content: "hello" },
    });

    const listResult = await protocol.agentsFilesList(listCall, "main");
    const getResult = await protocol.agentsFilesGet(getCall, "main", "AGENTS.md");

    expect(listCall).toHaveBeenCalledWith("agents.files.list", { agentId: "main" });
    expect(getCall).toHaveBeenCalledWith("agents.files.get", { agentId: "main", name: "AGENTS.md" });
    expect(listResult.files).toHaveLength(1);
    expect(getResult.file.content).toBe("hello");
  });

  it("calls skills.status with an optional agentId", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const call = createCallStub({
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [{ name: "foo", description: "bar", source: "workspace", bundled: false, filePath: "x", baseDir: "y", skillKey: "foo", always: false, disabled: false, blockedByAllowlist: false, eligible: true, requirements: {}, missing: {}, configChecks: [], install: [] }],
    });

    const result = await protocol.skillsStatus(call, "main");

    expect(call).toHaveBeenCalledWith("skills.status", { agentId: "main" });
    expect(result.skills).toHaveLength(1);
  });

  it("calls logs.tail with paging params and validates essential fields", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const call = createCallStub({
      file: "/tmp/openclaw.log",
      cursor: 100,
      size: 200,
      lines: ["one", "two"],
    });

    const result = await protocol.logsTail(call, { limit: 200 });

    expect(call).toHaveBeenCalledWith("logs.tail", { limit: 200 });
    expect(result.lines).toEqual(["one", "two"]);
  });

  it("calls usage.cost and sessions.usage with the raw date-range params", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const usageCostCall = createCallStub({
      updatedAt: 1,
      days: 7,
      daily: [],
      totals: { totalCost: 0, totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, missingCostEntries: 0 },
    });
    const sessionsUsageCall = createCallStub({
      updatedAt: 1,
      startDate: "2026-04-01",
      endDate: "2026-04-12",
      sessions: [],
      totals: { totalCost: 0, totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, missingCostEntries: 0 },
      aggregates: { messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 }, tools: { totalCalls: 0, uniqueTools: 0, tools: [] }, byModel: [], byProvider: [], byAgent: [], byChannel: [], daily: [] },
    });

    const usageCostResult = await protocol.usageCost(usageCostCall, { days: 7 });
    const sessionsUsageResult = await protocol.sessionsUsage(sessionsUsageCall, { days: 7, includeContextWeight: true });

    expect(usageCostCall).toHaveBeenCalledWith("usage.cost", { days: 7 });
    expect(sessionsUsageCall).toHaveBeenCalledWith("sessions.usage", { days: 7, includeContextWeight: true });
    expect(usageCostResult.days).toBe(7);
    expect(sessionsUsageResult.sessions).toEqual([]);
  });

  it("calls today read and write socket methods with daily state params", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const readCall = createCallStub({
      date: "2026-05-09",
      path: "memory/2026-05-09.md",
      title: "2026-05-09",
      orderedSections: ["Activities"],
      sections: { Activities: "Worked on tom.Quest" },
    });
    const writeCall = createCallStub({
      ok: true,
      path: "memory/2026-05-09.md",
      content: "# 2026-05-09\n",
    });

    const today = await protocol.todayRead(readCall, { date: "2026-05-09" });
    const saved = await protocol.todayWrite(writeCall, {
      date: "2026-05-09",
      title: "2026-05-09",
      orderedSections: ["Activities"],
      sections: { Activities: "Worked on tom.Quest" },
    });

    expect(readCall).toHaveBeenCalledWith("today.read", { date: "2026-05-09" });
    expect(writeCall).toHaveBeenCalledWith("today.write", {
      date: "2026-05-09",
      title: "2026-05-09",
      orderedSections: ["Activities"],
      sections: { Activities: "Worked on tom.Quest" },
    });
    expect(today.sections.Activities).toBe("Worked on tom.Quest");
    expect(saved.ok).toBe(true);
  });

  it("calls timeline, workspace, and status summary socket methods", async () => {
    const protocol = await import("@/app/jarvis/components/gatewayProtocol");
    const timelineCall = createCallStub({
      center: "2026-05-09",
      days: [],
    });
    const listCall = createCallStub({
      prefix: "memory",
      entries: [{ path: "memory/tom-facts.md", name: "tom-facts.md", type: "file" }],
    });
    const readCall = createCallStub({
      path: "memory/tom-facts.md",
      content: "facts",
    });
    const writeCall = createCallStub({
      ok: true,
      path: "memory/tom-facts.md",
    });
    const statusCall = createCallStub({
      today: "2026-05-09",
      codex: { configured: true, label: "Codex configured" },
      localUsage: { today: null },
    });

    await protocol.timelineRead(timelineCall, { center: "2026-05-09", days: 5 });
    await protocol.workspaceList(listCall, "memory");
    await protocol.workspaceRead(readCall, "memory/tom-facts.md");
    await protocol.workspaceWrite(writeCall, "memory/tom-facts.md", "facts");
    const status = await protocol.statusSummary(statusCall);

    expect(timelineCall).toHaveBeenCalledWith("timeline.read", { center: "2026-05-09", days: 5 });
    expect(listCall).toHaveBeenCalledWith("workspace.list", { prefix: "memory" });
    expect(readCall).toHaveBeenCalledWith("workspace.read", { path: "memory/tom-facts.md" });
    expect(writeCall).toHaveBeenCalledWith("workspace.write", { path: "memory/tom-facts.md", content: "facts" });
    expect(statusCall).toHaveBeenCalledWith("status.summary", undefined);
    expect(status.codex?.configured).toBe(true);
  });
});
