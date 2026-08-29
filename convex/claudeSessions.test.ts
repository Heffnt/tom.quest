import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function withTom(t: ReturnType<typeof convexTest>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}

async function createBasicSession(tom: Awaited<ReturnType<typeof withTom>>) {
  return await tom.mutation(api.claudeSessions.createSession, {
    title: "test session",
    kind: "adhoc",
    repo: "none",
    initialPrompt: "hello",
  });
}

// A box with plenty of headroom: 1/8 per-cpu load, 8GB free — every admission
// guard passes, so a scheduler test that stays a no-op failed on the rule it
// is actually about.
const HEALTHY_LOAD = {
  loadavg1: 1,
  cpus: 8,
  freeMemMb: 8192,
  totalMemMb: 16384,
  liveSessions: 0,
};

async function heartbeat(
  t: ReturnType<typeof convexTest>,
  load: typeof HEALTHY_LOAD = HEALTHY_LOAD,
) {
  await t.mutation(internal.claudeSessions.internalPoll, {
    version: "test",
    daemonStartedAt: 1,
    load,
  });
}

// The contract defaults, enabled — overrides name the one knob a test is about.
async function enableAuto(
  t: ReturnType<typeof convexTest>,
  overrides: Partial<{
    enabled: boolean;
    maxLoadPerCpu: number;
    minFreeMemMb: number;
    maxLiveAutonomous: number;
    maxNewPerTick: number;
  }> = {},
) {
  await t.mutation(internal.claudeSessions.internalSetAutoConfig, {
    enabled: true,
    maxLoadPerCpu: 0.8,
    minFreeMemMb: 1024,
    maxLiveAutonomous: 8,
    maxNewPerTick: 2,
    ...overrides,
  });
}

async function autoSessions(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("claudeSessions").collect()).filter(
      (s) => s.mode === "autonomous",
    ),
  );
}

// A finished autonomous run in this todo's history — the input to every
// backoff and circuit-breaker rule.
async function insertPastAutoSession(
  t: ReturnType<typeof convexTest>,
  fields: {
    todoId?: Id<"dtsTodos">;
    status?: "ended" | "failed" | "running";
    statusChangedAt?: number;
    createdAt?: number;
    outcome?: "completed" | "errored";
    outcomeSummary?: string;
    endedReason?: string;
  },
) {
  const now = Date.now();
  return await t.run(async (ctx) =>
    ctx.db.insert("claudeSessions", {
      title: "past auto run",
      kind: "focus-item",
      repo: "none",
      mode: "autonomous",
      todoId: fields.todoId,
      status: fields.status ?? "ended",
      statusChangedAt: fields.statusChangedAt ?? now,
      outcome: fields.outcome,
      outcomeSummary: fields.outcomeSummary,
      endedReason: fields.endedReason,
      nextSeq: 0,
      createdAt: fields.createdAt ?? fields.statusChangedAt ?? now,
    }),
  );
}

describe("claude sessions", () => {
  // witness: remove the requireTomId call from listSessions in
  // convex/claudeSessions.ts and this test goes red.
  it("gates every Tom-facing function on the tom role", async () => {
    const t = convexTest({ schema, modules });
    await expect(t.query(api.claudeSessions.listSessions, {})).rejects.toThrow();
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "u", email: "u@tom.quest", role: "user" }),
    );
    const user = t.withIdentity({ subject: userId });
    await expect(
      user.mutation(api.claudeSessions.createSession, {
        title: "x",
        kind: "adhoc",
        repo: "none",
        initialPrompt: "x",
      }),
    ).rejects.toThrow();
  });

  it("creates a session as requested with the prompt queued as pending inbound", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    const session = await tom.query(api.claudeSessions.getSession, {
      id: sessionId,
    });
    expect(session?.status).toBe("requested");
    expect(session?.nextSeq).toBe(0);
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId,
    });
    expect(inbound).toHaveLength(1);
    expect(inbound[0].kind).toBe("user-turn");
    expect(inbound[0].text).toBe("hello");
  });

  it("daemon poll claims state and heartbeat; ingest transitions and delivers", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);

    const poll = await t.mutation(internal.claudeSessions.internalPoll, {
      version: "test-1",
      daemonStartedAt: 1000,
      activeAccount: "gmail",
    });
    expect(poll.sessions).toHaveLength(1);
    const polled = poll.sessions[0] as {
      id: string;
      pendingInbound: { _id: string }[];
    };
    expect(polled.pendingInbound).toHaveLength(1);

    const health = await tom.query(api.claudeSessions.getDaemonHealth, {});
    expect(health?.activeAccount).toBe("gmail");

    // Daemon starts the session, delivers the turn, streams, finalizes.
    const res = await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "running",
      sdkSessionId: "sdk-123",
      inboundUpdates: [
        {
          id: polled.pendingInbound[0]._id as never,
          status: "delivered" as const,
        },
      ],
      finalize: [{ seq: 0, turn: 0, kind: "user" as const, content: "hello" }],
      buf: { turn: 0, seq: 1, text: "Hi Tom, " },
    });
    expect(res.sessionStatus).toBe("running");
    expect(res.nextSeq).toBe(1);
    expect(res.pendingInbound).toHaveLength(0);

    const buf = await tom.query(api.claudeSessions.getStreamBuf, { sessionId });
    expect(buf?.text).toBe("Hi Tom, ");
  });

  // witness: remove the `row.seq < session.nextSeq` drop in internalIngest
  // and this test goes red (duplicate rows on retry replay).
  it("drops replayed finalize rows below the seq floor (idempotent retries)", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    const flush = {
      sessionId,
      finalize: [
        { seq: 0, turn: 0, kind: "user" as const, content: "hello" },
        { seq: 1, turn: 0, kind: "assistant-text" as const, content: "hi" },
      ],
    };
    await t.mutation(internal.claudeSessions.internalIngest, flush);
    // Blind network retry of the same flush:
    await t.mutation(internal.claudeSessions.internalIngest, flush);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("claudeMessages").collect(),
    );
    expect(rows).toHaveLength(2);
    const session = await tom.query(api.claudeSessions.getSession, {
      id: sessionId,
    });
    expect(session?.nextSeq).toBe(2);
  });

  it("permission round-trip: request → decide (CAS) → piggybacked decision → ack", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "awaiting-permission",
      permissionRequests: [
        { requestId: "req-1", toolName: "Bash", input: { command: "git push" } },
      ],
    });
    const pending = await tom.query(api.claudeSessions.getPendingPermissions, {
      sessionId,
    });
    expect(pending).toHaveLength(1);

    await tom.mutation(api.claudeSessions.decidePermission, {
      requestId: "req-1",
      decision: "denied",
      note: "not yet",
    });
    // Second tap (other tab) is a no-op, not an error or overwrite.
    await tom.mutation(api.claudeSessions.decidePermission, {
      requestId: "req-1",
      decision: "allowed",
    });

    const res = await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "running",
    });
    expect(res.decisions).toHaveLength(1);
    const decision = res.decisions[0] as { status: string; note?: string };
    expect(decision.status).toBe("denied");
    expect(decision.note).toBe("not yet");

    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      permissionUpdates: [{ requestId: "req-1", applied: true }],
    });
    const after = await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
    });
    expect(after.decisions).toHaveLength(0); // acked — no longer delivered
  });

  it("forceClose only when the daemon heartbeat is stale, and stays terminal", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);

    // Fresh heartbeat → forceClose refused.
    await t.mutation(internal.claudeSessions.internalPoll, {
      version: "test",
      daemonStartedAt: 1,
    });
    await expect(
      tom.mutation(api.claudeSessions.forceClose, { sessionId }),
    ).rejects.toThrow(/reachable/);

    // Stale heartbeat → allowed.
    await t.run(async (ctx) => {
      const health = await ctx.db.query("claudeDaemonHealth").first();
      if (health)
        await ctx.db.patch(health._id, { lastSeenAt: Date.now() - 120_000 });
    });
    await tom.mutation(api.claudeSessions.forceClose, { sessionId });
    const session = await tom.query(api.claudeSessions.getSession, {
      id: sessionId,
    });
    expect(session?.status).toBe("ended");

    // A late daemon report cannot resurrect a terminal session.
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "running",
    });
    const after = await tom.query(api.claudeSessions.getSession, {
      id: sessionId,
    });
    expect(after?.status).toBe("ended");
  });

  // witness: remove the pending-row settling loops from forceClose in
  // convex/claudeSessions.ts and this test goes red.
  it("forceClose settles orphaned inbound and permission rows", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "awaiting-permission",
      permissionRequests: [
        { requestId: "req-orphan", toolName: "Bash", input: { command: "ls" } },
      ],
    });
    // No heartbeat row exists → daemon unconfirmed → forceClose permitted.
    await tom.mutation(api.claudeSessions.forceClose, { sessionId });
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId,
    });
    expect(inbound).toHaveLength(0);
    const permissions = await tom.query(
      api.claudeSessions.getPendingPermissions,
      { sessionId },
    );
    expect(permissions).toHaveLength(0);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("claudePermissions").collect(),
    );
    expect(rows[0].status).toBe("expired");
    expect(rows[0].decidedBy).toBe("force-close");
  });

  // witness: move the endedReason patch outside the `if (!terminal)` block in
  // internalIngest and this test goes red.
  it("terminal sessions accept finalize rows but never state patches", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await tom.mutation(api.claudeSessions.forceClose, { sessionId });

    // Late daemon flush: transcript rows land, state does not change.
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "failed",
      endedReason: "a git error that did not close this session",
      lastSdkEventAt: 12345,
      finalize: [
        { seq: 0, turn: 0, kind: "system" as const, content: "late row" },
      ],
      buf: { turn: 0, seq: 1, text: "stray tail" },
    });
    const session = await tom.query(api.claudeSessions.getSession, {
      id: sessionId,
    });
    expect(session?.status).toBe("ended");
    expect(session?.endedReason).toBe("force-closed by Tom; worker unconfirmed");
    expect(session?.lastSdkEventAt).toBeUndefined();
    const messages = await t.run(async (ctx) =>
      ctx.db.query("claudeMessages").collect(),
    );
    expect(messages).toHaveLength(1); // finalize accepted
    const buf = await tom.query(api.claudeSessions.getStreamBuf, { sessionId });
    expect(buf).toBeNull(); // stray tail cleared, not stored
  });

  it("poll records the daemon's last rejected-write report", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.claudeSessions.internalPoll, {
      version: "test",
      daemonStartedAt: 1,
    });
    await t.mutation(internal.claudeSessions.internalPoll, {
      version: "test",
      daemonStartedAt: 1,
      lastIngestError: "session x: validator rejected finalize",
    });
    const health = await tom.query(api.claudeSessions.getDaemonHealth, {});
    expect(health?.lastIngestError).toBe(
      "session x: validator rejected finalize",
    );
  });

  it("refuses messages to ended sessions and dedupes pending controls", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await tom.mutation(api.claudeSessions.sendControl, {
      sessionId,
      kind: "stop",
    });
    await tom.mutation(api.claudeSessions.sendControl, {
      sessionId,
      kind: "stop",
    });
    const pending = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId,
    });
    expect(pending.filter((p) => p.kind === "stop")).toHaveLength(1);

    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "ended",
      endedReason: "stopped by Tom",
    });
    await expect(
      tom.mutation(api.claudeSessions.sendMessage, {
        sessionId,
        text: "too late",
      }),
    ).rejects.toThrow(/ended/);
  });

  // witness: remove the ruling-marking branch from createSession in
  // convex/claudeSessions.ts and this test goes red.
  it("createSession with a todoId marks the live unapplied session ruling applied", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.dts.createTodo, {
      statement: "talk this through",
    });
    await tom.mutation(api.dtsRulings.recordRuling, {
      todoId,
      verdict: "session",
    });
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "session for todo",
      kind: "focus-item",
      repo: "none",
      todoId,
      initialPrompt: "let's talk",
    });
    const [ruling] = await tom.query(api.dtsRulings.listRulings, {});
    expect(ruling.appliedAt).toBeDefined();
    expect(ruling.applyResult).toBe(`session ${sessionId}`);
  });

  // witness: drop the `live.verdict === "session"` guard from createSession in
  // convex/claudeSessions.ts and this test goes red.
  it("createSession does not consume a non-session or already-applied ruling", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.dts.createTodo, {
      statement: "just do it",
    });
    // revise stays pending until the preparer consumes the sentence — the
    // live non-session ruling createSession must NOT touch. (approve on a
    // life todo applies instantly at record time, so it can't play this role.)
    await tom.mutation(api.dtsRulings.recordRuling, {
      todoId,
      verdict: "revise",
      sentence: "shorter",
    });
    const firstSession = await tom.mutation(api.claudeSessions.createSession, {
      title: "adhoc on a revise-ruled todo",
      kind: "focus-item",
      repo: "none",
      todoId,
      initialPrompt: "poke at it",
    });
    const [ruling] = await tom.query(api.dtsRulings.listRulings, {});
    expect(ruling.appliedAt).toBeUndefined(); // revise is the preparer's to apply

    // An already-applied session ruling is not re-stamped by a second session.
    const sessionRulingId = await tom.mutation(api.dtsRulings.recordRuling, {
      todoId,
      verdict: "session",
    });
    const secondSession = await tom.mutation(api.claudeSessions.createSession, {
      title: "first session",
      kind: "focus-item",
      repo: "none",
      todoId,
      initialPrompt: "talk",
    });
    await tom.mutation(api.claudeSessions.createSession, {
      title: "second session",
      kind: "focus-item",
      repo: "none",
      todoId,
      initialPrompt: "talk again",
    });
    const rulings = await tom.query(api.dtsRulings.listRulings, {});
    const sessionRuling = rulings.find((r) => r._id === sessionRulingId);
    expect(sessionRuling?.applyResult).toBe(`session ${secondSession}`);
    expect(firstSession).not.toBe(secondSession);
  });

  // witness: drop `parentToolUseId: row.parentToolUseId` from the
  // internalIngest insert and this test goes red (subagent parentage lost).
  it("ingest carries parentToolUseId onto the finalized row, and only there", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      finalize: [
        {
          seq: 0,
          turn: 0,
          kind: "tool-call" as const,
          content: { toolName: "Task", toolUseId: "task-1" },
        },
        {
          seq: 1,
          turn: 0,
          kind: "tool-call" as const,
          content: { toolName: "Read", toolUseId: "child-1" },
          parentToolUseId: "task-1",
        },
      ],
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("claudeMessages").withIndex("by_session_seq").collect(),
    );
    expect(rows[0].parentToolUseId).toBeUndefined(); // a top-level call has no parent
    expect(rows[1].parentToolUseId).toBe("task-1");
  });

  // witness: drop the `session.outcome === undefined` condition from the
  // outcome branch of internalIngest and this test goes red.
  it("ingest stamps an outcome only on a session that has none", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const fresh = await createBasicSession(tom);
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId: fresh,
      status: "ended",
      endedReason: "autonomous run complete",
      outcome: "completed" as const,
      outcomeSummary: "daemon saw the final turn",
    });
    const stamped = await tom.query(api.claudeSessions.getSession, {
      id: fresh,
    });
    expect(stamped?.outcome).toBe("completed");
    expect(stamped?.outcomeSummary).toBe("daemon saw the final turn");

    // The agent's own record always wins over the daemon's cap-path stamp.
    const spoken = await createBasicSession(tom);
    await t.mutation(internal.claudeSessions.internalRecordOutcome, {
      id: spoken,
      outcome: "completed",
      summary: "brief written into the item",
    });
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId: spoken,
      status: "failed",
      endedReason: "autonomous time cap",
      outcome: "errored" as const,
      outcomeSummary: "autonomous time cap",
    });
    const after = await tom.query(api.claudeSessions.getSession, {
      id: spoken,
    });
    expect(after?.outcome).toBe("completed");
    expect(after?.outcomeSummary).toBe("brief written into the item");
    expect(after?.status).toBe("failed"); // the ending itself still lands
  });

  it("poll stores the box load and names each live session's posture", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.dts.createTodo, {
      statement: "groundwork subject",
    });
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "auto-ish session",
      kind: "focus-item",
      repo: "none",
      todoId,
      initialPrompt: "go",
    });
    await t.run(async (ctx) =>
      ctx.db.patch(sessionId, { mode: "autonomous" as const }),
    );

    const poll = await t.mutation(internal.claudeSessions.internalPoll, {
      version: "test",
      daemonStartedAt: 1,
      load: HEALTHY_LOAD,
    });
    const health = await tom.query(api.claudeSessions.getDaemonHealth, {});
    expect(health?.load).toEqual(HEALTHY_LOAD);

    const polled = poll.sessions[0] as {
      mode?: string;
      todoId?: string;
      blockCategory?: string;
    };
    expect(polled.mode).toBe("autonomous");
    expect(polled.todoId).toBe(todoId);
  });
});

// ── P2: the agent panel's open tool work ─────────────────────────────────────

describe("open tool work", () => {
  async function liveSessionWithToolWork(t: ReturnType<typeof convexTest>) {
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "running",
      finalize: [
        {
          seq: 0,
          turn: 0,
          kind: "tool-call" as const,
          content: {
            toolName: "Task",
            toolUseId: "task-1",
            input: {
              subagent_type: "explorer",
              description: "map the module",
            },
          },
        },
        {
          seq: 1,
          turn: 0,
          kind: "tool-call" as const,
          content: {
            toolName: "Read",
            toolUseId: "child-1",
            input: { file_path: "/repo/a.ts" },
          },
          parentToolUseId: "task-1",
        },
        {
          seq: 2,
          turn: 0,
          kind: "tool-call" as const,
          content: {
            toolName: "Grep",
            toolUseId: "child-2",
            input: { pattern: "needle" },
          },
          parentToolUseId: "task-1",
        },
        // Neither a Task nor a background launch — invisible to the panel.
        {
          seq: 3,
          turn: 0,
          kind: "tool-call" as const,
          content: {
            toolName: "Read",
            toolUseId: "solo-1",
            input: { file_path: "/repo/b.ts" },
          },
        },
        {
          seq: 4,
          turn: 0,
          kind: "tool-call" as const,
          content: {
            toolName: "Bash",
            toolUseId: "fg-1",
            input: { command: "ls" },
          },
        },
      ],
    });
    return { tom, sessionId };
  }

  it("reads a running Task as an agent, with its newest child call", async () => {
    const t = convexTest({ schema, modules });
    const { tom, sessionId } = await liveSessionWithToolWork(t);
    const work = await tom.query(api.claudeSessions.getOpenToolWork, {
      sessionId,
    });
    expect(work.agents).toHaveLength(1);
    expect(work.agents[0].toolUseId).toBe("task-1");
    expect(work.agents[0].subagentType).toBe("explorer");
    expect(work.agents[0].description).toBe("map the module");
    expect(work.agents[0].running).toBe(true);
    // Calls are seq-ascending, so the newest child is what it is doing NOW.
    expect(work.agents[0].currentChild?.toolName).toBe("Grep");
    expect(work.agents[0].currentChild?.inputPreview).toContain("needle");
    expect(work.commands).toHaveLength(0); // foreground Bash + plain Read ignored
    expect(work.finished).toHaveLength(0);
  });

  // witness: make `running` unconditional (or drop the resultById lookup) and
  // this test goes red — a returned agent would stay on the live list forever.
  it("moves a Task with a result out of agents and into the fold", async () => {
    const t = convexTest({ schema, modules });
    const { tom, sessionId } = await liveSessionWithToolWork(t);
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      finalize: [
        {
          seq: 5,
          turn: 0,
          kind: "tool-result" as const,
          content: {
            toolUseId: "task-1",
            content: "the module reads config at startup",
            isError: false,
          },
        },
      ],
    });
    const work = await tom.query(api.claudeSessions.getOpenToolWork, {
      sessionId,
    });
    expect(work.agents).toHaveLength(0);
    expect(work.finished).toHaveLength(1);
    expect(work.finished[0].toolUseId).toBe("task-1");
    expect(work.finished[0].running).toBe(false);
    expect(work.finished[0].isError).toBe(false);
    expect(work.finished[0].resultPreview).toBe(
      "the module reads config at startup",
    );
  });

  it("pairs a background Bash launch with its latest BashOutput check", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "running",
      finalize: [
        {
          seq: 0,
          turn: 0,
          kind: "tool-call" as const,
          content: {
            toolName: "Bash",
            toolUseId: "bash-1",
            input: { command: "pnpm build", run_in_background: true },
          },
        },
        {
          seq: 1,
          turn: 0,
          kind: "tool-result" as const,
          content: {
            toolUseId: "bash-1",
            content: "Command running in background with ID: bg_42",
          },
        },
      ],
    });
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      finalize: [
        {
          seq: 2,
          turn: 0,
          kind: "tool-call" as const,
          content: {
            toolName: "BashOutput",
            toolUseId: "check-1",
            input: { bash_id: "bg_42" },
          },
        },
        {
          seq: 3,
          turn: 0,
          kind: "tool-result" as const,
          content: { toolUseId: "check-1", content: "compiling routes…" },
        },
        // A check for a DIFFERENT background id must not attach here.
        {
          seq: 4,
          turn: 0,
          kind: "tool-call" as const,
          content: {
            toolName: "BashOutput",
            toolUseId: "check-2",
            input: { bash_id: "bg_99" },
          },
        },
        {
          seq: 5,
          turn: 0,
          kind: "tool-result" as const,
          content: { toolUseId: "check-2", content: "some other shell" },
        },
      ],
    });
    const work = await tom.query(api.claudeSessions.getOpenToolWork, {
      sessionId,
    });
    expect(work.agents).toHaveLength(0);
    expect(work.commands).toHaveLength(1);
    expect(work.commands[0].toolUseId).toBe("bash-1");
    expect(work.commands[0].command).toBe("pnpm build");
    expect(work.commands[0].launchResultText).toContain("bg_42");
    expect(work.commands[0].latestCheck?.toolName).toBe("BashOutput");
    expect(work.commands[0].latestCheck?.resultText).toBe("compiling routes…");
  });

  // witness: remove the isLive guard at the top of getOpenToolWork and this
  // test goes red (a closed session would keep showing a "running" subagent).
  it("returns nothing for a terminal session", async () => {
    const t = convexTest({ schema, modules });
    const { tom, sessionId } = await liveSessionWithToolWork(t);
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "ended",
      endedReason: "stopped by Tom",
    });
    const work = await tom.query(api.claudeSessions.getOpenToolWork, {
      sessionId,
    });
    expect(work).toEqual({ agents: [], commands: [], finished: [] });
  });
});

// ── P3: autonomous-fleet config + scheduler ──────────────────────────────────

describe("autonomous fleet config", () => {
  it("round-trips the config and keeps it a singleton", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const before = await tom.query(api.claudeSessions.getAutoConfig, {});
    expect(before.fromDefaults).toBe(true);
    expect(before.enabled).toBe(false); // nothing runs until deliberately on
    expect(before.maxLoadPerCpu).toBe(0.8);
    expect(before.minFreeMemMb).toBe(1024);
    expect(before.maxLiveAutonomous).toBe(8);
    expect(before.maxNewPerTick).toBe(2);

    await tom.mutation(api.claudeSessions.setAutoConfig, {
      enabled: true,
      maxLoadPerCpu: 0.5,
      minFreeMemMb: 2048,
      maxLiveAutonomous: 4,
      maxNewPerTick: 1,
    });
    const after = await tom.query(api.claudeSessions.getAutoConfig, {});
    expect(after.fromDefaults).toBe(false);
    expect(after.enabled).toBe(true);
    expect(after.maxLoadPerCpu).toBe(0.5);
    expect(after.maxNewPerTick).toBe(1);

    // The CLI pen writes the SAME row, never a second singleton.
    await t.mutation(internal.claudeSessions.internalSetAutoConfig, {
      enabled: false,
      maxLoadPerCpu: 0.9,
      minFreeMemMb: 512,
      maxLiveAutonomous: 2,
      maxNewPerTick: 3,
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("claudeAutoConfig").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].maxLoadPerCpu).toBe(0.9);
    const off = await tom.query(api.claudeSessions.getAutoConfig, {});
    expect(off.enabled).toBe(false);
  });
});

describe("autonomous session scheduler", () => {
  // The eligible shape: active, whenever, unprepared, no category, no batch.
  async function eligibleTodo(
    tom: Awaited<ReturnType<typeof withTom>>,
    statement = "draft the reading list",
  ) {
    return await tom.mutation(api.dts.createTodo, { statement });
  }

  it("admits one autonomous session with its mission and its event", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await eligibleTodo(tom);
    await enableAuto(t);
    await heartbeat(t);

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});

    const sessions = await autoSessions(t);
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session.mode).toBe("autonomous");
    expect(session.repo).toBe("none"); // v1: empty scratch, never repo edits
    expect(session.kind).toBe("focus-item");
    expect(session.status).toBe("requested");
    expect(session.todoId).toBe(todoId);

    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId: session._id,
    });
    expect(inbound).toHaveLength(1);
    expect(inbound[0].kind).toBe("user-turn");
    expect(inbound[0].text).toContain(todoId); // the prepare pen names the item
    expect(inbound[0].text).toContain(session._id); // the outcome pen names it
    expect(inbound[0].text).toContain("/sessions/outcome");

    const events = await t.run(async (ctx) =>
      ctx.db.query("dtsEvents").collect(),
    );
    expect(
      events.some(
        (e) => e.kind === "auto-session-created" && e.todoId === todoId,
      ),
    ).toBe(true);
    expect(events.some((e) => e.kind === "auto-session-scheduler")).toBe(true);
  });

  // witness: flip AUTO_DEFAULTS.enabled to true and this test goes red.
  it("does nothing with no config row (the fleet is off by default)", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await eligibleTodo(tom);
    await heartbeat(t);
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(await autoSessions(t)).toHaveLength(0);
    const events = await t.run(async (ctx) =>
      ctx.db.query("dtsEvents").collect(),
    );
    // A no-op tick leaves no trace at all.
    expect(events.some((e) => e.kind === "auto-session-scheduler")).toBe(false);
  });

  // witness: remove the load-admission guard and this test goes red — load is
  // the PRIMARY throttle, not the scalar caps.
  it("stands down when per-cpu load or free memory says the box is busy", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await eligibleTodo(tom);
    await enableAuto(t);
    await heartbeat(t, { ...HEALTHY_LOAD, loadavg1: 16 }); // 2.0 per cpu
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(await autoSessions(t)).toHaveLength(0);

    await t.run(async (ctx) => {
      const health = await ctx.db.query("claudeDaemonHealth").first();
      if (health)
        await ctx.db.patch(health._id, {
          load: { ...HEALTHY_LOAD, freeMemMb: 256 },
        });
    });
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(await autoSessions(t)).toHaveLength(0);
  });

  it("stands down when the daemon heartbeat is stale or absent", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await eligibleTodo(tom);
    await enableAuto(t);

    // No heartbeat at all: nothing on the box could start a session.
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(await autoSessions(t)).toHaveLength(0);

    await heartbeat(t);
    await t.run(async (ctx) => {
      const health = await ctx.db.query("claudeDaemonHealth").first();
      if (health)
        await ctx.db.patch(health._id, { lastSeenAt: Date.now() - 120_000 });
    });
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(await autoSessions(t)).toHaveLength(0);
  });

  it("holds at the runaway failsafe and bounds a clone burst per tick", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await eligibleTodo(tom, "first");
    await eligibleTodo(tom, "second");
    await heartbeat(t);

    // One live autonomous session already, cap of one → no admissions.
    const live = await insertPastAutoSession(t, { status: "running" });
    await enableAuto(t, { maxLiveAutonomous: 1 });
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(await autoSessions(t)).toHaveLength(1); // only the pre-existing one

    await t.run(async (ctx) =>
      ctx.db.patch(live, { status: "ended" as const }),
    );
    // Two eligible todos, one new session allowed per tick.
    await enableAuto(t, { maxNewPerTick: 1 });
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const created = (await autoSessions(t)).filter((s) => s._id !== live);
    expect(created).toHaveLength(1);
  });

  it("excludes code todos, batch members, and ruled or already-running subjects", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t);
    await heartbeat(t);

    // Code todos live in the mirror; their work happens in the repo.
    await tom.mutation(api.dts.createTodo, {
      statement: "fix the flaky test",
      category: "code",
    });
    // A member of a non-terminal batch is the batch's to advance.
    const memberId = await eligibleTodo(tom, "member item");
    const batchId = await eligibleTodo(tom, "the batch");
    await tom.mutation(api.dts.updateTodo, {
      id: batchId,
      members: [{ todoId: memberId }],
    });
    // A live unapplied ruling means Tom already spoke — do not race it.
    const ruledId = await eligibleTodo(tom, "revise this one");
    await tom.mutation(api.dtsRulings.recordRuling, {
      todoId: ruledId,
      verdict: "revise",
      sentence: "shorter",
    });
    // A live session already references this todo.
    const busyId = await eligibleTodo(tom, "already in session");
    await tom.mutation(api.claudeSessions.createSession, {
      title: "a real conversation",
      kind: "focus-item",
      repo: "none",
      todoId: busyId,
      initialPrompt: "let's talk",
    });

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(await autoSessions(t)).toHaveLength(0);
  });

  // witness: drop the `live.verdict === "session"` clause from the exclusion
  // and this test goes red — Tom asked for a conversation, not groundwork.
  it("never takes over a todo whose live verdict asked for a session", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t);
    await heartbeat(t);
    const todoId = await eligibleTodo(tom, "needs a conversation");
    await tom.mutation(api.dtsRulings.recordRuling, {
      todoId,
      verdict: "session",
    });
    // The conversation happened and ended: the ruling is applied and no
    // session is live, so ONLY the session-verdict clause can exclude it.
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "the conversation",
      kind: "focus-item",
      repo: "none",
      todoId,
      initialPrompt: "let's talk",
    });
    await t.run(async (ctx) =>
      ctx.db.patch(sessionId, {
        status: "ended" as const,
        endedReason: "stopped by Tom",
      }),
    );

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(await autoSessions(t)).toHaveLength(0);
  });

  it("backs off a todo whose last autonomous run did not complete", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t);
    await heartbeat(t);
    const erroredId = await eligibleTodo(tom, "errored yesterday");
    await insertPastAutoSession(t, {
      todoId: erroredId,
      statusChangedAt: Date.now() - 60 * 60 * 1000,
      outcome: "errored",
      outcomeSummary: "no source to read",
    });
    // An ending with no outcome at all is equally not-completed.
    const silentId = await eligibleTodo(tom, "ended without a word");
    await insertPastAutoSession(t, {
      todoId: silentId,
      statusChangedAt: Date.now() - 60 * 60 * 1000,
    });

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const created = (await autoSessions(t)).filter(
      (s) => s.title !== "past auto run",
    );
    expect(created).toHaveLength(0);
  });

  // witness: remove the completed-run branch of the backoff and this test goes
  // red — the fleet would redo settled groundwork every tick.
  it("re-runs a completed subject only after the todo itself changed", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t);
    await heartbeat(t);
    const todoId = await eligibleTodo(tom, "already prepared once");
    const ranAt = Date.now();
    await insertPastAutoSession(t, {
      todoId,
      statusChangedAt: ranAt,
      outcome: "completed",
      outcomeSummary: "brief written",
    });

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(
      (await autoSessions(t)).filter((s) => s.title !== "past auto run"),
    ).toHaveLength(0);

    // The todo moved since the run — there is new ground to cover.
    await t.run(async (ctx) => ctx.db.patch(todoId, { updatedAt: ranAt + 1 }));
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(
      (await autoSessions(t)).filter((s) => s.title !== "past auto run"),
    ).toHaveLength(1);
  });

  // witness: delete the circuit-breaker block and this test goes red — the
  // fleet would keep hammering an account that just hit its usage limit.
  it("stands the whole tick down after a recent usage-pressure ending", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t);
    await heartbeat(t);
    await eligibleTodo(tom, "plenty to do");
    await insertPastAutoSession(t, {
      statusChangedAt: Date.now() - 60_000,
      endedReason: "usage limit reached",
    });

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(
      (await autoSessions(t)).filter((s) => s.title !== "past auto run"),
    ).toHaveLength(0);
  });

  // witness: move the batch lane below the dated lane and this test goes red.
  it("walks batches with open agent steps before plain dated items", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 1 });
    await heartbeat(t);

    await tom.mutation(api.dts.createTodo, {
      statement: "dated and unprepared",
      dueAt: Date.now() + 60 * 60 * 1000,
    });
    const memberId = await eligibleTodo(tom, "batch member");
    const batchId = await eligibleTodo(tom, "the batch");
    await tom.mutation(api.dts.updateTodo, {
      id: batchId,
      members: [{ todoId: memberId }],
      plan: [{ text: "gather the sources", actor: "agent", status: "open" }],
    });

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const sessions = await autoSessions(t);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].todoId).toBe(batchId);
    // The batch mission names the batch AND its live members.
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId: sessions[0]._id,
    });
    expect(inbound[0].text).toContain("BATCH");
    expect(inbound[0].text).toContain("batch member");
  });
});
