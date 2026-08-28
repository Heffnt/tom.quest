import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
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
});
