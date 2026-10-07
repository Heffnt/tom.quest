// Sessions the box did not start, addressed by their Claude session id, and
// the subagents a session dispatches (convex/sessionRegistration.ts).

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function withTom(t: ReturnType<typeof convexTest>) {
  const id = await t.run((ctx) => ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }));
  return t.withIdentity({ subject: id });
}

const poll = (t: ReturnType<typeof convexTest>) =>
  t.mutation(internal.claudeSessions.internalPoll, { version: "test", daemonStartedAt: 1 });

describe("a session registered by its Claude session id", () => {
  it("is written once per id, keeps the login the page chose, and fills its title once", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(internal.sessionRegistration.internalRegisterSession, {
      sdkSessionId: "11111111-2222-3333-4444-555555555555",
      client: "desktop",
      login: "wpi",
      transcriptPath: "/home/jarvis/.claude-accounts/shared/projects/-home-jarvis/11111111-2222-3333-4444-555555555555.jsonl",
      cwd: "/home/jarvis",
    });
    expect(first.created).toBe(true);
    await t.run((ctx) => ctx.db.patch(first.id, { login: "gmail" }));
    const again = await t.mutation(internal.sessionRegistration.internalRegisterSession, {
      sdkSessionId: "11111111-2222-3333-4444-555555555555",
      client: "desktop",
      login: "wpi",
      title: "Plan the history page",
    });
    expect(again).toEqual({ id: first.id, created: false });
    // An old session reopened is moved to now.
    await t.run((ctx) => ctx.db.patch(first.id, { statusChangedAt: 1 }));
    await t.mutation(internal.sessionRegistration.internalRegisterSession, { sdkSessionId: "11111111-2222-3333-4444-555555555555", client: "desktop" });
    expect((await t.run((ctx) => ctx.db.get(first.id)))!.statusChangedAt).toBeGreaterThan(1);
    await t.mutation(internal.sessionRegistration.internalRegisterSession, {
      sdkSessionId: "11111111-2222-3333-4444-555555555555",
      client: "desktop",
      title: "a later title",
    });
    const row = await t.run((ctx) => ctx.db.get(first.id));
    // Each registration is activity: the sessions page lists the row by it.
    expect(row!.statusChangedAt).toBeGreaterThanOrEqual(row!.createdAt);
    expect(row).toMatchObject({
      sdkSessionId: "11111111-2222-3333-4444-555555555555",
      login: "gmail",
      title: "Plan the history page",
      client: "desktop",
      status: "idle",
      kind: "adhoc",
      cwd: "/home/jarvis",
    });
  });

  it("is not polled while Desktop holds it idle, and is polled once a message makes it the host's", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const { id } = await t.mutation(internal.sessionRegistration.internalRegisterSession, {
      sdkSessionId: "aaaaaaaa-0000-0000-0000-000000000001",
      client: "desktop",
      login: "wpi",
      transcriptPath: "/x/aaaaaaaa-0000-0000-0000-000000000001.jsonl",
      cwd: "/home/jarvis",
    });
    expect((await poll(t)).sessions.map((s: any) => s.id)).not.toContain(id);
    await tom.mutation(api.claudeSessions.sendMessage, { sessionId: id, text: "hello from the page" });
    const listed = (await poll(t)).sessions.find((s: any) => s.id === id) as any;
    expect(listed).toMatchObject({
      sdkSessionId: "aaaaaaaa-0000-0000-0000-000000000001",
      client: "host",
      login: "wpi",
      cwd: "/home/jarvis",
      transcriptPath: "/x/aaaaaaaa-0000-0000-0000-000000000001.jsonl",
    });
    expect(listed.pendingInbound).toHaveLength(1);
  });

  it("takes the directory a session was last opened in, and is polled once a stop makes it the host's", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const { id } = await t.mutation(internal.sessionRegistration.internalRegisterSession, {
      sdkSessionId: "cccccccc-0000-0000-0000-000000000003", client: "desktop", cwd: "/home/jarvis", transcriptPath: "/a/-home-jarvis/c.jsonl",
    });
    await t.mutation(internal.sessionRegistration.internalRegisterSession, {
      sdkSessionId: "cccccccc-0000-0000-0000-000000000003", client: "desktop", cwd: "/home/jarvis/tom.quest", transcriptPath: "/a/-home-jarvis-tom-quest/c.jsonl",
    });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ cwd: "/home/jarvis/tom.quest", transcriptPath: "/a/-home-jarvis-tom-quest/c.jsonl" });
    expect((await poll(t)).sessions.map((s: any) => s.id)).not.toContain(id);
    await tom.mutation(api.claudeSessions.sendControl, { sessionId: id, kind: "stop" });
    const listed = (await poll(t)).sessions.find((s: any) => s.id === id) as any;
    expect(listed.client).toBe("host");
    expect(listed.pendingInbound.map((r: any) => r.kind)).toEqual(["stop"]);
  });

  it("leaves a row the host created held by the host", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) => ctx.db.insert("claudeSessions", {
      title: "a host session", kind: "adhoc", repo: "none", repos: [], status: "idle",
      statusChangedAt: 1, sdkSessionId: "bbbbbbbb-0000-0000-0000-000000000002", nextSeq: 0, createdAt: 1,
    }));
    await t.mutation(internal.sessionRegistration.internalRegisterSession, {
      sdkSessionId: "bbbbbbbb-0000-0000-0000-000000000002",
      client: "desktop",
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.client).toBeUndefined();
    expect((await poll(t)).sessions.map((s: any) => s.id)).toContain(id);
  });
});

describe("a subagent's row", () => {
  it("is written at its start, ended by its report, and lists only while running", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.sessionRegistration.internalSubagentEvent, {
      event: "start",
      agentId: "a123",
      parentSessionId: "parent-1",
      transcriptPath: "/p/parent-1/subagents/agent-a123.jsonl",
      brief: "Read the session host and report its lock.",
      login: "wpi",
      cwd: "/home/jarvis",
    });
    await t.mutation(internal.sessionRegistration.internalSubagentEvent, { event: "start", agentId: "a123", parentSessionId: "parent-1", transcriptPath: "/elsewhere" });
    let running = await t.query(internal.sessionRegistration.internalRunningSubagents, {});
    expect(running).toMatchObject([{ agentId: "a123", parentSessionId: "parent-1", transcriptPath: "/p/parent-1/subagents/agent-a123.jsonl", resumeCount: 0 }]);
    await t.mutation(internal.sessionRegistration.internalSubagentEvent, { event: "resumed", agentId: "a123", resumedSessionId: "s-2", resumedTranscriptPath: "/p/s-2.jsonl" });
    running = await t.query(internal.sessionRegistration.internalRunningSubagents, {});
    expect(running[0]).toMatchObject({ resumeCount: 1, resumedSessionId: "s-2" });
    await t.mutation(internal.sessionRegistration.internalSubagentEvent, { event: "reported", agentId: "a123", brief: "a later brief" });
    await t.mutation(internal.sessionRegistration.internalSubagentEvent, { event: "ended-without-report", agentId: "a123" });
    expect(await t.query(internal.sessionRegistration.internalRunningSubagents, {})).toEqual([]);
    const row = await t.run((ctx) => ctx.db.query("subagentRuns").first());
    expect(row?.state).toBe("reported");
    // The brief the start gave stays.
    expect(row?.brief).toBe("Read the session host and report its lock.");
  });

  it("takes its brief from a later event when the start had none", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.sessionRegistration.internalSubagentEvent, { event: "start", agentId: "b1", parentSessionId: "p", transcriptPath: "/t", brief: "" });
    await t.mutation(internal.sessionRegistration.internalSubagentEvent, { event: "reported", agentId: "b1", brief: "Write the lock test." });
    expect((await t.run((ctx) => ctx.db.query("subagentRuns").first()))?.brief).toBe("Write the lock test.");
  });
});
