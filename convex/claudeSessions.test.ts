import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { AUTO_DEFAULTS } from "./claudeSessions";
import type { MessageOverflowRead } from "./claudeSessions";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { modelOfTomPrelude } from "./ttsSkills";
import {
  WORKER_CONTRACT,
  CODEX_USAGE_STALE_MS,
  CODEX_WEEKLY_CAP_PERCENT,
  DEFAULT_SESSION_MODEL,
  MODEL_OF_TOM_HEADER,
} from "./ttsShared";
import type { SessionModel } from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// The distinctive half of the one sentence every session prompt carries about
// the daemon that runs it (DAEMON_RESTART_SENTENCE in convex/ttsShared.ts).
// Written out here rather than imported: a hard-coded expectation that goes red
// when the prompt changes is the alarm working.
const DAEMON_SENTENCE = "Never restart, stop, or kill `tts-session-host`";

const TEST_PRELUDE_LAYERS = {
  operate: "test operate layer",
  write: "test write layer",
  know: "test know layer",
};
const TEST_PRELUDE_HEADERS = ([
  ["operate"], ["write"], ["know"], ["operate", "write"],
  ["operate", "know"], ["write", "know"], ["operate", "write", "know"],
] as const).map((names) => ({ layers: [...names], header: `${MODEL_OF_TOM_HEADER} (WikiTom commit testprelude): ${names.join(",")}` }));

async function withTom(t: ReturnType<typeof convexTest>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  await t.run(async (ctx) => {
    await ctx.db.insert("modelOfTomPublication", {
      key: "current",
      commit: "testprelude",
      committedAt: 1,
      pushed: true,
      ...TEST_PRELUDE_LAYERS,
      headers: TEST_PRELUDE_HEADERS,
    });
  });
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

// A session from before the one-transcript-path cutover, whose rows are the
// daemon's under its sessionId. Every session born today reads its agent
// file (rowsFrom "runs"); the daemon-row path these tests pin still serves
// the old sessions until the one-off replaces their rows.
async function createDaemonSession(
  t: ReturnType<typeof convexTest>,
  tom: Awaited<ReturnType<typeof withTom>>,
) {
  const sessionId = await createBasicSession(tom);
  await t.run((ctx) => ctx.db.patch(sessionId, { rowsFrom: undefined }));
  return sessionId;
}

// THE PER-SESSION EVENT LINE IS GONE (slack-design.md §1.2). It had no channel
// of its own and was switched off from the day it was written: a session
// recording an outcome is not something Tom acts on, and it reaches him in the
// morning message's overnight run. The one case that IS a message is a session
// that FAILED, and that goes to #tts-broken.
//
// These read the broken lines a mutation scheduled, off the scheduler's own
// system table — the observable effect without reaching into Slack. Rows
// persist through their run (convex-test patches state, never deletes), so
// counting is stable whether or not the job has fired yet.
async function sessionEventMessages(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((job) => job.name.includes("sendBroken"))
      .map((job) => job.args[0] as { job: string; statement: string; detail?: string }),
  );
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
//
// It writes the singleton row DIRECTLY rather than through a pen, because
// since the lifeos update (phase 7) no pen takes the four admission numbers:
// they are code-owned (claudeSessions.AUTO_DEFAULTS), and the columns stay in
// the schema only until NARROW. The scheduler still reads them off the row,
// which is what a test steering admission — one clone per tick, one live
// session at a time — needs to set.
async function enableAuto(
  t: ReturnType<typeof convexTest>,
  overrides: Partial<{
    enabled: boolean;
    maxLoadPerCpu: number;
    minFreeMemMb: number;
    maxLiveAutonomous: number;
    maxNewPerTick: number;
    defaultModel: SessionModel;
  }> = {},
) {
  await t.run(async (ctx) => {
    const row = {
      ...AUTO_DEFAULTS,
      enabled: true,
      ...overrides,
      updatedAt: Date.now(),
    };
    const existing = await ctx.db.query("claudeAutoConfig").first();
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("claudeAutoConfig", row);
  });
}

async function autoSessions(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("claudeSessions").collect()).filter(
      (s) => s.mode === "autonomous",
    ),
  );
}

// The two kinds of autonomous session the scheduler makes, told apart by the
// one field that separates them: a mission for REAL WORK always carries the
// todo it works, and a PROSPECTING mission works no todo at all. Both are
// created on the same tick now that prospecting is parallel, so a test about
// the work walk counts workSessions, not every autonomous row.
async function workSessions(t: ReturnType<typeof convexTest>) {
  return (await autoSessions(t)).filter((s) => s.todoId !== undefined);
}

async function prospectSessions(t: ReturnType<typeof convexTest>) {
  return (await autoSessions(t)).filter(
    (s) => s.todoId === undefined && s.codeRepo === undefined,
  );
}

// The third kind of autonomous session: a CODE MISSION, admitted for Tom's
// approve or archive ruling on a code todo, told apart by its code subject.
async function codeSessions(t: ReturnType<typeof convexTest>) {
  return (await autoSessions(t)).filter((s) => s.codeRepo !== undefined);
}

// The prospecting lane's own trail: one row per created mission, naming the
// session and the repo. It is also the cooldown clock the lane reads back.
async function prospectEvents(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("dtsEvents").collect()).filter(
      (e) => e.kind === "prospect-mission-created",
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
  it("keeps the autonomous opener to the unattended-session boundary", () => {
    expect(WORKER_CONTRACT).toBe(
      "You are working inside TTS (Toms Todo System) as a WORKER — no one is watching this transcript live, and nothing you write in chat reaches anyone unless a pen (a command below) records it.",
    );
  });

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
    // The STABLE PREFIX at the head (the dynamic-context round): the
    // transcript's first row names what the session began with — the map, the
    // operate rules and the write layer, at one WikiTom commit. Then Tom's
    // prompt verbatim, then the fetchable index; the outcome-pen footer is
    // appended server-side (pinned by its own test below).
    //
    // NO LAYER BUT `operate` IS HERE, and none ever is again: the write layer
    // and the know layer became skills, so what this session may load beyond
    // the operate rules is a NAME in the grant block (convex/ttsContext.ts).
    const text = inbound[0].text ?? "";
    expect(text.startsWith(`${MODEL_OF_TOM_HEADER} (WikiTom commit testprelude)`)).toBe(true);
    expect(text).toContain(TEST_PRELUDE_LAYERS.operate);
    expect(text).not.toContain(TEST_PRELUDE_LAYERS.write);
    expect(text).not.toContain(TEST_PRELUDE_LAYERS.know);
    expect(text).toContain("SKILLS (WikiTom commit testprelude)");
    expect(text.indexOf(TEST_PRELUDE_LAYERS.operate)).toBeLessThan(
      text.indexOf("SKILLS (WikiTom commit testprelude)"),
    );
    expect(text.indexOf("SKILLS (WikiTom commit testprelude)")).toBeLessThan(text.indexOf("\n\nhello"));
    expect(text).not.toContain("MODEL-OF-TOM FETCHABLE");
  });

  // witness: insertSession prefixed the prelude to whatever the seed's prompt
  // was, so a builder that had pasted its own copy gave the transcript two
  // headers naming two commits.
  it("opens the session on a pasted opener, with the live prelude and one header", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    // What a paste actually is: the opener of a live session, copied whole —
    // and what is strippable in it is the STABLE PREFIX, which is all a paste
    // can carry that the live record does not rebuild anyway.
    const prelude = await t.run(async (ctx) => modelOfTomPrelude(ctx, ["operate"]));
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "pasted opener",
      kind: "adhoc",
      repo: "none",
      initialPrompt: `${prelude}\n\ncarry on from here`,
    });
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId,
    });
    const text = inbound[0].text ?? "";
    expect(text.startsWith(prelude)).toBe(true);
    expect(text.split(MODEL_OF_TOM_HEADER)).toHaveLength(2); // one header
    expect(text).toContain("carry on from here");
  });

  it("refuses a seed carrying a prelude from another commit, and inserts nothing", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await expect(
      tom.mutation(api.claudeSessions.createSession, {
        title: "double prelude",
        kind: "adhoc",
        repo: "none",
        initialPrompt: `${MODEL_OF_TOM_HEADER} (WikiTom commit 0123abcd): model-of-tom/writing.md\n\n── model-of-tom/writing.md ──\nold text\n\nhello`,
      }),
    ).rejects.toThrow(/prelude .* read at another commit/);
    // A Convex mutation is one transaction: the session row and the ruling
    // marks the refusal comes after go back with it.
    const rows = await t.run(async (ctx) => ({
      sessions: await ctx.db.query("claudeSessions").collect(),
      inbound: await ctx.db.query("claudeInbound").collect(),
    }));
    expect(rows.sessions).toHaveLength(0);
    expect(rows.inbound).toHaveLength(0);
    // A prompt that merely mentions the header later is Tom's to write.
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "mentions it",
      kind: "adhoc",
      repo: "none",
      initialPrompt: `read the ${MODEL_OF_TOM_HEADER} line first`,
    });
    expect(sessionId).toBeDefined();
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

  // The permission table and its round-trip are gone (the lifeos update,
  // phase 7), and so is the roll-out shim that accepted permissionUpdates and
  // ignored it: worker/setup.sh has run, so no daemon sends the field any
  // more. A Convex mutation refuses an argument it does not declare, which is
  // the point — a box that somehow ran the old code would fail loudly on its
  // next flush rather than have its acks silently swallowed.
  //
  // witness: declare permissionUpdates on internalIngest again and this goes
  // red — the flush would be accepted, and a stale daemon would be invisible.
  it("refuses the retired permissionUpdates field", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await expect(
      t.mutation(internal.claudeSessions.internalIngest, {
        sessionId,
        status: "running",
        permissionUpdates: [{ requestId: "req-1", applied: true }],
      } as never),
    ).rejects.toThrow(/permissionUpdates/);
    // The mutation itself still works without it.
    const res = await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "running",
    });
    expect(res.sessionStatus).toBe("running");
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
    // No heartbeat row exists → daemon unconfirmed → forceClose permitted.
    await tom.mutation(api.claudeSessions.forceClose, { sessionId });
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId,
    });
    expect(inbound).toHaveLength(0);
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
  // ── One creation path, one repo answer (Tom's rulings, 2026-08-30) ─────────
  // The failure these pin: every session opened from a TTS button arrived with
  // repo "none", so it could neither clone a private repo nor push anything —
  // three of the four launch surfaces had no repo picker and passed the only
  // value they could name.

  // witness: make createSession's repo resolution `explicit ?? []` (drop the
  // todo fallback to the word guess) and this goes red — a session opened on a
  // todo plainly about a repo gets no checkout.
  it("a todo session whose caller names no repos gets the word guess over the todo", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, {
      statement: "fix the tom.quest deploy check",
    });

    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "work the todo",
      kind: "focus-item",
      todoId,
      initialPrompt: "go",
    });
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.repos).toEqual(["tom.quest"]);
    // `repo` stays written for every pre-ruling reader; it is repos[0].
    expect(session?.repo).toBe("tom.quest");
  });

  // Tom ruled on 2026-09-24 to have no batches, so a batch is no longer
  // something a session is opened on, and neither door takes `batchId`.
  // witness: put batchId back into CREATE_SESSION_ARGS in
  // convex/claudeSessions.ts and this goes red — both doors would open a
  // session naming a batch.
  it("refuses a session opened on a batch, at both doors, and writes no row", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const batchId = await t.run(async (ctx) =>
      ctx.db.insert("batches", {
        statement: "The Turing pages",
        repos: ["tom.quest", "WikiTom"],
        status: "active" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    // The argument itself is gone from both doors (the validator refuses it).
    const args = {
      title: "work the batch",
      kind: "focus-item" as const,
      batchId,
      initialPrompt: "go",
    } as never;
    await expect(
      tom.mutation(api.claudeSessions.createSession, args),
    ).rejects.toThrow(/batchId/);
    await expect(
      t.mutation(internal.claudeSessions.internalCreateSession, args),
    ).rejects.toThrow(/batchId/);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("claudeSessions").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  // witness: drop the isSessionRepo filter from normalizeSessionRepos and the
  // unknown name survives — the daemon then throws on its first turn and the
  // session dies before doing anything.
  it("normalizes an explicit repo list: unknown names dropped, order canonical", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "explicit",
      kind: "adhoc",
      repos: ["WikiTom", "NotARepo", "tom.quest", "WikiTom"],
      initialPrompt: "go",
    });
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.repos).toEqual(["tom.quest", "WikiTom"]);
  });

  // "none" from the /agents dropdown is an ANSWER, not an absence: Tom asked
  // for an empty scratch workspace and must not be overridden by the word
  // guess over the todo.
  // witness: change the resolver's `explicit !== undefined` test to a
  // truthiness test on the normalized result and this goes red.
  it("an explicit 'none' beats the word guess over the todo", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, {
      statement: "fix the tom.quest deploy check",
    });
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "scratch please",
      kind: "focus-item",
      repo: "none",
      todoId,
      initialPrompt: "go",
    });
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.repos).toEqual([]);
    expect(session?.repo).toBe("none");
  });

  // The multi-repo half of the ruling: the prompt must NAME each clone, or the
  // agent cannot find the second checkout it was given.
  // witness: collapse workspaceParagraph to its single-repo branch and this
  // goes red — the prompt promises one checkout where two exist.
  it("names every clone in the opening prompt of a multi-repo mission", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "two repos",
      kind: "adhoc",
      repos: ["tom.quest", "WikiTom"],
      initialPrompt: "the mission",
    });
    const [inbound] = await t.run(async (ctx) =>
      ctx.db
        .query("claudeInbound")
        .filter((q) => q.eq(q.field("sessionId"), sessionId))
        .collect(),
    );
    // The interactive footer now carries the workspace paragraph too
    // (2026-08-31): an interactive session that was never told the rules
    // pushed `tts/verdict-and-names` on 2026-08-30 and burned turns against
    // the command gate. The prompt must name each clone and the one
    // sanctioned branch.
    expect(inbound.text).toContain(sessionId);
    expect(inbound.text).toContain("`./tom.quest`");
    expect(inbound.text).toContain("`./WikiTom`");
    expect(inbound.text).toContain(`session/${sessionId}`);
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.repos).toEqual(["tom.quest", "WikiTom"]);
  });

  it("createSession with a todoId marks the live unapplied session ruling applied", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, {
      statement: "talk this through",
    });
    await tom.mutation(api.ttsRulings.recordRuling, {
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
    const [ruling] = await tom.query(api.ttsRulings.listRulings, {});
    expect(ruling.appliedAt).toBeDefined();
    expect(ruling.applyResult).toBe(`session ${sessionId}`);
  });

  // witness: drop the `live.verdict === "session"` guard from createSession in
  // convex/claudeSessions.ts and this test goes red.
  it("createSession does not consume a non-session or already-applied ruling", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, {
      statement: "just do it",
    });
    // revise stays pending until the preparer consumes the sentence — the
    // live non-session ruling createSession must NOT touch. (approve on a
    // life todo applies instantly at record time, so it can't play this role.)
    await tom.mutation(api.ttsRulings.recordRuling, {
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
    const [ruling] = await tom.query(api.ttsRulings.listRulings, {});
    expect(ruling.appliedAt).toBeUndefined(); // revise is the preparer's to apply

    // An already-applied session ruling is not re-stamped by a second session.
    const sessionRulingId = await tom.mutation(api.ttsRulings.recordRuling, {
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
    const rulings = await tom.query(api.ttsRulings.listRulings, {});
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

  // witness: delete the `becameTerminal` block from internalIngest in
  // convex/claudeSessions.ts and this test goes red — a stop the daemon never
  // acked would spin as a "sending" bubble forever on a closed session.
  it("an ending flush settles the still-pending inbound rows as interrupted", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await tom.mutation(api.claudeSessions.sendMessage, {
      sessionId,
      text: "one more thing",
    });
    const pending = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId,
    });
    // The opener carries the model-of-tom prelude and createSession's
    // outcome-pen footer, so it is found by its prompt, not by exact text.
    const opener = pending.find((p) => p.text?.includes("hello"));
    expect(pending).toHaveLength(2);

    // One flush both ENDS the session and reports what the daemon did manage
    // to deliver: the row it named keeps the daemon's fact, and only the rows
    // nothing will ever settle are swept.
    const res = await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "ended",
      endedReason: "autonomous run complete",
      inboundUpdates: [{ id: opener!._id, status: "done" as const }],
    });
    expect(res.pendingInbound).toHaveLength(0);

    const rows = await t.run(async (ctx) =>
      ctx.db.query("claudeInbound").collect(),
    );
    expect(rows.find((r) => r.text?.includes("hello"))?.status).toBe("done");
    expect(rows.find((r) => r.text === "one more thing")?.status).toBe(
      "interrupted",
    );
  });

  // witness: drop the `author` argument from sendMessageFrom / reopenSessionFrom
  // in convex/claudeSessions.ts, or pass "tom" from the internal pen. Ruling 15
  // (2026-09-05): only a turn Tom typed in the browser can become a ruling in
  // his words, so every user-turn says who wrote it — the browser door "tom",
  // the CLI pen and the code-built opener "agent".
  it("every user-turn records its author: browser = tom, pen and opener = agent", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await tom.mutation(api.claudeSessions.sendMessage, {
      sessionId,
      text: "typed by Tom",
    });
    await t.mutation(internal.claudeSessions.internalSendMessage, {
      sessionId,
      text: "typed through the pen",
    });
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "ended",
      endedReason: "done",
    });
    await tom.mutation(api.claudeSessions.reopenSession, {
      sessionId,
      text: "Tom reopens",
    });
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "ended",
      endedReason: "done again",
    });
    await t.mutation(internal.claudeSessions.internalReopenSession, {
      sessionId,
      text: "the pen reopens",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("claudeInbound").collect(),
    );
    const authorOf = (head: string) =>
      rows.find((r) => r.text?.includes(head))?.author;
    expect(authorOf("hello")).toBe("agent");
    expect(authorOf("typed by Tom")).toBe("tom");
    expect(authorOf("typed through the pen")).toBe("agent");
    expect(authorOf("Tom reopens")).toBe("tom");
    expect(authorOf("the pen reopens")).toBe("agent");
  });

  // A turn Tom wrote outside the browser (a threaded Slack reply the events
  // route matched to TOM_SLACK_USER_ID) reaches the same internal pen with
  // author "tom" — that argument is the whole mechanism, and the pen's own
  // default of "agent" is asserted where the pen is tested.

  // The outcome pen POST /tts/session-outcome reaches exactly this mutation
  // (the route is thin: auth + body shape). Route-level auth is out of this
  // harness's scope; the semantics it depends on are here.
  it("the outcome pen names its session by id and trims the summary", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await t.mutation(internal.claudeSessions.internalRecordOutcome, {
      id: sessionId,
      outcome: "errored",
      summary: "  no source to read  ",
    });
    const session = await tom.query(api.claudeSessions.getSession, {
      id: sessionId,
    });
    expect(session?.outcome).toBe("errored");
    expect(session?.outcomeSummary).toBe("no source to read");
    await expect(
      t.mutation(internal.claudeSessions.internalRecordOutcome, {
        id: "not-a-real-id",
        outcome: "completed",
        summary: "x",
      }),
    ).rejects.toThrow(/Unknown session id/);
  });

  // witness: delete the `outcomePenFooter(sessionId)` append from createSession
  // in convex/claudeSessions.ts and this test goes red — an interactive
  // session would have no way to learn its own id, and so no writer for the
  // ratified "every session ends with a written outcome record".
  it("createSession hands the session its own id and the outcome pen", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId,
    });
    const text = inbound[0].text ?? "";
    expect(text).toContain(sessionId); // the id the client could not know
    expect(text).toContain("/tts/session-outcome");
    // Same env contract as the autonomous mission: only the TTS key, never
    // the ingest key, is named to a model-reachable shell.
    expect(text).toContain("TTS_WORKER_KEY");
    expect(text).not.toContain("SESSIONS_WORKER_KEY");
    // An interactive session runs on the same daemon as every autonomous one,
    // and this footer is the only server-written part of its prompt — so the
    // "never restart tts-session-host" rule rides here. This session holds no
    // checkout, which is the footer branch that skips the workspace paragraph.
    expect(text).toContain(DAEMON_SENTENCE);
  });

  // The other footer branch: a session WITH a checkout gets the same rule from
  // inside the workspace paragraph.
  // witness: drop the sentence from workspaceParagraph and this goes red.
  it("tells an interactive session with a checkout never to restart the daemon", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "one repo",
      kind: "adhoc",
      repos: ["tom.quest"],
      initialPrompt: "the mission",
    });
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId,
    });
    expect(inbound[0].text ?? "").toContain(DAEMON_SENTENCE);
  });

  // witness: drop the `mode: "interactive"` line from reopenSession's patch in
  // convex/claudeSessions.ts and this test goes red — a reopened autonomous
  // session would keep the daemon's auto-end path and close itself again after
  // one turn, out from under the conversation Tom just restarted.
  it("reopens an ended session as idle and interactive, keeping its ending on the record", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await t.run(async (ctx) =>
      ctx.db.patch(sessionId, { mode: "autonomous" as const, runId: "claude:box:first-thread" }),
    );
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "ended",
      endedReason: "autonomous run complete",
      outcome: "completed" as const,
      outcomeSummary: "brief written into the item",
    });

    await tom.mutation(api.claudeSessions.reopenSession, {
      sessionId,
      text: "one more thing",
    });
    const session = await tom.query(api.claudeSessions.getSession, {
      id: sessionId,
    });
    expect(session?.status).toBe("idle");
    expect(session?.mode).toBe("interactive");
    // The run the reopen starts continues the one the session was recorded as.
    expect((await t.run((ctx) => ctx.db.get(sessionId)))?.continuesRunId).toBe("claude:box:first-thread");
    // The previous ending is history, not a claim about the present state —
    // it stays on the row, and the transcript that follows keeps it honest.
    expect(session?.endedReason).toBe("autonomous run complete");
    expect(session?.outcome).toBe("completed");
    expect(session?.outcomeSummary).toBe("brief written into the item");

    // The ending swept the opener as interrupted, so the reopening turn is
    // the one pending row the daemon's poll will pick up.
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId,
    });
    expect(inbound).toHaveLength(1);
    expect(inbound[0].text).toBe("one more thing");
  });

  // witness: remove the status guard from reopenSession and this test goes red
  // — reopening a RUNNING session would patch it back to idle mid-turn.
  it("refuses to reopen a live session, or to reopen with an empty turn", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await expect(
      tom.mutation(api.claudeSessions.reopenSession, {
        sessionId,
        text: "still live",
      }),
    ).rejects.toThrow(/sendMessage/);

    await tom.mutation(api.claudeSessions.forceClose, { sessionId });
    await expect(
      tom.mutation(api.claudeSessions.reopenSession, {
        sessionId,
        text: "   ",
      }),
    ).rejects.toThrow(/empty/);
    const session = await tom.query(api.claudeSessions.getSession, {
      id: sessionId,
    });
    expect(session?.status).toBe("ended"); // the refusal changed nothing
  });

  // ── The reopen protocol ────────────────────────────────────────────────────
  // A reopen puts a terminal row back into the live poll, which is
  // indistinguishable from a daemon restart AND races the daemon's blind retry
  // of the ending flush it just sent. The three fields below are what the
  // daemon and the scheduler read to tell those apart.

  // witness: drop reopenedAt, reopenEpoch, or reopenedFromAutonomous from
  // reopenSession's patch in convex/claudeSessions.ts and this test goes red —
  // the daemon would stamp a fabricated restart row, a stale flush could
  // re-terminalize the session, and the scheduler would lose the run's history.
  it("a reopen stamps the marker, bumps the epoch, and keeps autonomous provenance", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await t.run(async (ctx) =>
      ctx.db.patch(sessionId, { mode: "autonomous" as const }),
    );
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "ended",
      endedReason: "autonomous run complete",
    });

    await tom.mutation(api.claudeSessions.reopenSession, {
      sessionId,
      text: "one more thing",
    });
    const first = await tom.query(api.claudeSessions.getSession, {
      id: sessionId,
    });
    expect(first?.reopenedAt).toEqual(expect.any(Number));
    expect(first?.reopenEpoch).toBe(1);
    // mode is now "interactive" (Tom took it over), so this is the only
    // surviving record that the run was autonomous.
    expect(first?.reopenedFromAutonomous).toBe(true);

    // Both facts ride the poll — they are the daemon's only inputs.
    const poll = await t.mutation(internal.claudeSessions.internalPoll, {
      version: "test",
      daemonStartedAt: 1,
    });
    const polled = poll.sessions[0] as {
      reopenedAt?: number;
      reopenEpoch?: number;
    };
    expect(polled.reopenedAt).toBe(first?.reopenedAt);
    expect(polled.reopenEpoch).toBe(1);

    // A second ending and a second reopen: the epoch is a generation counter,
    // so every reopen invalidates one more round of in-flight flushes.
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      reopenEpoch: 1,
      status: "ended",
      endedReason: "stopped by Tom",
    });
    await tom.mutation(api.claudeSessions.reopenSession, {
      sessionId,
      text: "and another",
    });
    const second = await tom.query(api.claudeSessions.getSession, {
      id: sessionId,
    });
    expect(second?.reopenEpoch).toBe(2);
  });

  // witness: replace `noState` with `terminal` at internalIngest's state gates
  // in convex/claudeSessions.ts and this test goes red — the daemon's blind
  // retry of an ending it already landed would end the session a second time,
  // discard the turn Tom just sent, and report the failure to Slack twice.
  it("a pre-reopen flush replay lands its rows but no state, and says nothing", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    // The ending flush: it COMMITS, and its response is lost on the wire, so
    // the daemon will send it again.
    const endingFlush = {
      sessionId,
      reopenEpoch: 0,
      status: "failed" as const,
      endedReason: "the SDK process exited without a final turn",
      finalize: [
        { seq: 0, turn: 0, kind: "system" as const, content: "the end" },
      ],
    };
    await t.mutation(internal.claudeSessions.internalIngest, endingFlush);
    expect(await sessionEventMessages(t)).toHaveLength(1);

    await tom.mutation(api.claudeSessions.reopenSession, {
      sessionId,
      text: "what happened there?",
    });
    // The retry arrives with the epoch the daemon held BEFORE the reopen.
    await t.mutation(internal.claudeSessions.internalIngest, {
      ...endingFlush,
      finalize: [
        { seq: 1, turn: 0, kind: "system" as const, content: "the end (retry)" },
      ],
    });

    const session = await tom.query(api.claudeSessions.getSession, {
      id: sessionId,
    });
    expect(session?.status).toBe("idle"); // not re-terminalized
    // Tom's reopening turn is still waiting for the daemon, not swept away.
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId,
    });
    expect(inbound).toHaveLength(1);
    expect(inbound[0].text).toBe("what happened there?");
    // Slack was told about the failure once, on the real crossing.
    expect(await sessionEventMessages(t)).toHaveLength(1);
    // Transcript completeness is unconditional: a stale payload's rows are
    // still part of what happened.
    const messages = await t.run(async (ctx) =>
      ctx.db.query("claudeMessages").collect(),
    );
    expect(messages.map((m) => m.content)).toEqual([
      "the end",
      "the end (retry)",
    ]);
  });

  // witness: remove the `reopenedAt: undefined` clear from internalIngest and
  // this test goes red — the marker would stick forever, so a LATER genuine
  // daemon death on this session would be adopted silently instead of saying
  // the turn was interrupted.
  it("the daemon reporting running again spends the reopen marker", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "ended",
      endedReason: "stopped by Tom",
    });
    await tom.mutation(api.claudeSessions.reopenSession, {
      sessionId,
      text: "carry on",
    });

    // A stale replay must not spend it (the reopen has not been served yet).
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      reopenEpoch: 0,
      status: "running",
    });
    const during = await tom.query(api.claudeSessions.getSession, {
      id: sessionId,
    });
    expect(during?.reopenedAt).toEqual(expect.any(Number));

    // The adopting daemon takes the reopening turn: the reopen is now spent.
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      reopenEpoch: 1,
      status: "running",
    });
    const after = await tom.query(api.claudeSessions.getSession, {
      id: sessionId,
    });
    expect(after?.status).toBe("running");
    expect(after?.reopenedAt).toBeUndefined();
  });

  // witness: drop the trimmed-empty check from renameSession and this test
  // goes red — a session could be left with a blank handle in the list.
  it("renames a session and refuses a blank title", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await tom.mutation(api.claudeSessions.renameSession, {
      sessionId,
      title: "  the reading-list session  ",
    });
    const session = await tom.query(api.claudeSessions.getSession, {
      id: sessionId,
    });
    expect(session?.title).toBe("the reading-list session");
    await expect(
      tom.mutation(api.claudeSessions.renameSession, { sessionId, title: " " }),
    ).rejects.toThrow(/empty/);
  });

  it("poll stores the Jarvis Box load and names each live session's posture", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, {
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

// ── Needs-you Slack event messages (todo tts-session-needs-you-notify) ───────
// Every send below is EDGE-triggered: the todo's completion condition is "one
// message, not one per poll", and the daemon flushes several times a second
// while a session is live. Each test therefore repeats the daemon's behavior
// (a replayed flush, a re-record) and pins that the count does not move.

describe("session event messages", () => {
  // witness: drop the `firstRecord` guard from internalRecordOutcome in
  // convex/claudeSessions.ts and an errored re-record would ping Tom once per
  // revision. A completed one says nothing either way.
  it("says nothing when the agent records an outcome, first time or after", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);

    await t.mutation(internal.claudeSessions.internalRecordOutcome, {
      id: sessionId,
      outcome: "completed",
      summary: "brief written into the item",
    });
    // A COMPLETED outcome is not a message at all now: it is a fact for the
    // morning message's overnight run, and nothing Tom does anything about.
    expect(await sessionEventMessages(t)).toHaveLength(0);

    // The agent sharpens its wording (or corrects the verdict): the ROW takes
    // the new word — the surface always shows the agent's latest — and Slack
    // is still told nothing, because only the FIRST record is an edge.
    await t.mutation(internal.claudeSessions.internalRecordOutcome, {
      id: sessionId,
      outcome: "errored",
      summary: "the source turned out to be paywalled",
    });
    expect(await sessionEventMessages(t)).toHaveLength(0);
    const session = await tom.query(api.claudeSessions.getSession, {
      id: sessionId,
    });
    expect(session?.outcome).toBe("errored");
    expect(session?.outcomeSummary).toBe(
      "the source turned out to be paywalled",
    );
  });

  // A "waiting on a permission decision" message used to be tested here. It
  // was removed with the edge itself: the daemon's unified auto gate decides
  // every tool call, so no permission request is ever created and the message
  // could not fire in production — the old test hand-built a payload no daemon
  // code emits, green-lighting dead code.

  // witness: drop the `becameTerminal` conjunct from the failure branch of
  // internalIngest (leaving `args.status === "failed"` alone) and this test
  // goes red — every late flush naming the same failure would re-send it.
  it("notifies once on the crossing into failed, and not on a normal ending", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const failed = await createBasicSession(tom);
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId: failed,
      status: "failed",
      endedReason: "the SDK process exited without a final turn",
    });
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId: failed,
      status: "failed",
      endedReason: "the SDK process exited without a final turn",
    });
    const messages = await sessionEventMessages(t);
    expect(messages).toHaveLength(1);
    // #tts-broken dedupes on the JOB as well, and a session's job name is the
    // session itself, so two failures of one session are one message.
    expect(messages[0].job).toBe(`session:${failed}`);
    expect(messages[0].statement).toContain("stopped without finishing what it was carrying");
    expect(messages[0].detail).toContain("the SDK process exited without a final turn");

    // A session that simply ENDS is not a needs-you event: Tom stopped it, or
    // it finished, and its outcome record is the thing worth a message.
    const ended = await createBasicSession(tom);
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId: ended,
      status: "ended",
      endedReason: "stopped by Tom",
    });
    expect(await sessionEventMessages(t)).toHaveLength(1);
  });

  // The daemon's cap-path stamp is the same fact as the agent's pen and takes
  // the same route — two writers, one description.
  it("says nothing for a completed stamp, and one broken line for an errored one", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "ended",
      endedReason: "autonomous run complete",
      outcome: "completed" as const,
      outcomeSummary: "daemon saw the final turn",
    });
    // Completed: nothing is sent, on the stamp or on any flush after it.
    expect(await sessionEventMessages(t)).toHaveLength(0);
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      outcome: "completed" as const,
      outcomeSummary: "daemon saw the final turn",
    });
    expect(await sessionEventMessages(t)).toHaveLength(0);

    // An ERRORED outcome the daemon stamps IS a broken line, once.
    const errored = await createBasicSession(tom);
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId: errored,
      status: "ended",
      endedReason: "autonomous run complete",
      outcome: "errored" as const,
      outcomeSummary: "the source turned out to be paywalled",
    });
    const broken = await sessionEventMessages(t);
    expect(broken).toHaveLength(1);
    expect(broken[0].job).toBe(`session:${errored}`);
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

    // Tom's door is ON or OFF and nothing else (the lifeos update, phase 7):
    // the numbers are code-owned defaults, and the switch writes them.
    await tom.mutation(api.claudeSessions.setAutoConfig, { enabled: true });
    const after = await tom.query(api.claudeSessions.getAutoConfig, {});
    expect(after.fromDefaults).toBe(false);
    expect(after.enabled).toBe(true);
    expect(after.maxLoadPerCpu).toBe(0.8);
    expect(after.maxNewPerTick).toBe(2);

    // The CLI pen writes the SAME row, never a second singleton.
    await t.mutation(internal.claudeSessions.internalSetAutoConfig, {
      enabled: false,
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("claudeAutoConfig").collect(),
    );
    expect(rows).toHaveLength(1);
    const off = await tom.query(api.claudeSessions.getAutoConfig, {});
    expect(off.enabled).toBe(false);
  });

  // witness: return the row's own numbers from getAutoConfig again — a row
  // still carrying a value written before they became code-owned would show
  // Tom a ceiling nothing means to keep, and the next press of the switch
  // would change it under him.
  it("answers with the code-owned numbers, whatever an older row still holds", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("claudeAutoConfig", {
        enabled: true,
        maxLoadPerCpu: 0.1,
        minFreeMemMb: 99,
        maxLiveAutonomous: 1,
        maxNewPerTick: 1,
        updatedAt: 1,
      });
    });
    const config = await tom.query(api.claudeSessions.getAutoConfig, {});
    expect(config.enabled).toBe(true); // the one thing the row decides
    expect(config.maxLoadPerCpu).toBe(0.8);
    expect(config.minFreeMemMb).toBe(1024);
    expect(config.maxLiveAutonomous).toBe(8);
    expect(config.maxNewPerTick).toBe(2);

    // …and the next press of the switch copies the code values over the row.
    await tom.mutation(api.claudeSessions.setAutoConfig, { enabled: false });
    const row = await t.run(async (ctx) =>
      ctx.db.query("claudeAutoConfig").first(),
    );
    expect(row?.maxLoadPerCpu).toBe(0.8);
    expect(row?.maxNewPerTick).toBe(2);
  });

  // The fleet default model, which the four calls above never mentioned. It is
  // OPTIONAL on the pen precisely so those calls keep working — and a row that
  // never named one still reads as the built-in default, because the scheduler
  // is going to use that default whether or not the row says so.
  //
  // witness: return `row.defaultModel` raw from getAutoConfig — the browser's
  // picker would render empty on every config row written before 2026-09-04,
  // while the fleet went on launching Codex sessions.
  it("keeps the default model optional and reads an unset one as the built-in default", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    expect((await tom.query(api.claudeSessions.getAutoConfig, {})).defaultModel)
      .toBe(DEFAULT_SESSION_MODEL);

    // A pen call that says nothing about the model: the row is written, the
    // field stays unset, and the read still answers.
    await t.mutation(internal.claudeSessions.internalSetAutoConfig, {
      enabled: true,
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("claudeAutoConfig").collect(),
    );
    expect(rows[0].defaultModel).toBeUndefined();
    expect((await tom.query(api.claudeSessions.getAutoConfig, {})).defaultModel)
      .toBe(DEFAULT_SESSION_MODEL);

    await t.mutation(internal.claudeSessions.internalSetAutoConfig, {
      enabled: true,
      defaultModel: "opus",
    });
    expect((await tom.query(api.claudeSessions.getAutoConfig, {})).defaultModel)
      .toBe("opus");

    // …and Tom's switch does not reset it either. It writes the code-owned
    // numbers and the one field it is about; the model the fleet runs on is
    // not a thing a press of "stop" decides.
    // witness: drop the defaultModel carry-over in setAutoConfig — flipping
    // the switch would silently move the whole fleet back to the built-in
    // default model.
    await tom.mutation(api.claudeSessions.setAutoConfig, { enabled: false });
    expect((await tom.query(api.claudeSessions.getAutoConfig, {})).defaultModel)
      .toBe("opus");

    // ...and an omitting call after that does NOT reset it: the knob is Tom's,
    // and a hand-typed CLI command that forgot the field must not undo it.
    await t.mutation(internal.claudeSessions.internalSetAutoConfig, {
      enabled: true,
    });
    expect((await tom.query(api.claudeSessions.getAutoConfig, {})).defaultModel)
      .toBe("opus");
  });
});

// ── Choosing a model for a live session (ratified by Tom, 2026-09-04) ────────
// Two mutations, and the line between them is the model FAMILY: within one
// family the runner is the same process and the model id is a per-turn
// argument, so the change is a patch; across families there is no shared
// resume key at all, so the change is a new session that reads the old one's
// transcript off disk.

describe("session model changes", () => {
  const sessionRow = (t: ReturnType<typeof convexTest>, id: Id<"claudeSessions">) =>
    t.run(async (ctx) => (await ctx.db.get(id))!);

  // witness: drop the modelFamily comparison from setSessionModel — a live
  // Claude session would be patched to a Codex name, and the daemon would try
  // to resume a Codex thread that never existed.
  it("patches a same-family change and refuses a cross-family one", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "test session",
      kind: "adhoc",
      repo: "none",
      model: "opus",
      initialPrompt: "hello",
    });

    await tom.mutation(api.claudeSessions.setSessionModel, {
      sessionId,
      model: "fable",
    });
    expect((await sessionRow(t, sessionId)).model).toBe("fable");
    // The daemon learns of it the ordinary way: the poll carries the model
    // fresh every tick, so the next turn runs on the new one.
    const poll = await t.mutation(internal.claudeSessions.internalPoll, {
      version: "test",
      daemonStartedAt: 1,
    });
    const polled = poll.sessions as { id: string; model?: string }[];
    expect(polled.find((s) => s.id === sessionId)?.model).toBe("fable");

    await expect(
      tom.mutation(api.claudeSessions.setSessionModel, {
        sessionId,
        model: "gpt-5.6-sol",
      }),
    ).rejects.toThrow("forkSessionAs");
    expect((await sessionRow(t, sessionId)).model).toBe("fable");
  });

  // A row written before the model field existed ran Opus, so a change to
  // another Claude model is same-family and allowed.
  // witness: make modelFamily throw or return undefined on an absent model.
  it("reads a legacy row with no model as opus", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("claudeSessions", {
        title: "legacy session",
        kind: "adhoc",
        repo: "none",
        status: "idle",
        statusChangedAt: Date.now(),
        nextSeq: 0,
        createdAt: Date.now(),
      }),
    );
    await tom.mutation(api.claudeSessions.setSessionModel, {
      sessionId,
      model: "sonnet",
    });
    expect((await sessionRow(t, sessionId)).model).toBe("sonnet");
  });

  it("refuses to change the model of a finished session", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await t.run(async (ctx) =>
      ctx.db.patch(sessionId, { status: "ended", statusChangedAt: Date.now() }),
    );
    await expect(
      tom.mutation(api.claudeSessions.setSessionModel, {
        sessionId,
        model: "opus",
      }),
    ).rejects.toThrow("ended");
  });

  // The fork carries the subject across and the transcript reaches the new
  // model as a FILE — there is no SDK state to resume, so naming that file in
  // the first turn is the entire mechanism.
  //
  // witness: drop `.tts-transcript.md` from buildForkPrompt, or the stop row
  // at the end of forkSessionAs — the new session would start with no idea
  // where its history is, or the old one would keep running beside it.
  it("forks to another family with the transcript file named and the old session stopped", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const oldId = await tom.mutation(api.claudeSessions.createSession, {
      title: "the boolean sweep",
      kind: "adhoc",
      repos: ["tom.quest"],
      model: "opus",
      initialPrompt: "hello",
    });
    await t.run(async (ctx) => ctx.db.patch(oldId, { runId: "claude:box:forked-thread" }));

    const forkId = await tom.mutation(api.claudeSessions.forkSessionAs, {
      sessionId: oldId,
      model: "gpt-5.6-sol",
      text: "keep going from where that stopped",
    });
    const fork = await sessionRow(t, forkId);
    expect(fork.model).toBe("gpt-5.6-sol");
    expect(fork.forkedFrom).toBe(oldId);
    expect(fork.continuesRunId).toBe("claude:box:forked-thread");
    expect(fork.title).toBe("the boolean sweep (as gpt-5.6-sol)");
    expect(fork.mode).toBe("interactive");
    // The subject rides across: same checkout, same kind.
    expect(fork.repos).toEqual(["tom.quest"]);
    expect(fork.kind).toBe("adhoc");

    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId: forkId,
    });
    const text = inbound[0].text ?? "";
    expect(text).toContain(oldId);
    expect(text).toContain(".tts-transcript.md");
    expect(text).toContain("keep going from where that stopped");

    // The OLD session ends the ordinary way — a pending stop row, exactly what
    // the browser's stop button writes — so the daemon finishes it and its
    // outcome stays intact. Nothing here patches it terminal.
    const stops = await t.run(async (ctx) =>
      (await ctx.db.query("claudeInbound").collect()).filter(
        (row) => row.sessionId === oldId && row.kind === "stop",
      ),
    );
    expect(stops).toHaveLength(1);
    expect(stops[0].status).toBe("pending");
    expect((await sessionRow(t, oldId)).status).toBe("requested");

    // The fork also rides the poll, so the daemon knows which transcript to
    // write into the new workspace.
    const poll = await t.mutation(internal.claudeSessions.internalPoll, {
      version: "test",
      daemonStartedAt: 1,
    });
    const polled = poll.sessions as { id: string; forkedFrom?: string }[];
    expect(polled.find((s) => s.id === forkId)?.forkedFrom).toBe(oldId);
  });

  it("does not enqueue a second stop when the old session already has one", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const oldId = await createBasicSession(tom);
    await tom.mutation(api.claudeSessions.sendControl, {
      sessionId: oldId,
      kind: "stop",
    });
    await tom.mutation(api.claudeSessions.forkSessionAs, {
      sessionId: oldId,
      model: "gpt-5.6-terra",
      text: "carry on",
    });
    const stops = await t.run(async (ctx) =>
      (await ctx.db.query("claudeInbound").collect()).filter(
        (row) => row.sessionId === oldId && row.kind === "stop",
      ),
    );
    expect(stops).toHaveLength(1);
  });
});

// ── The CLI pens (Tom, 2026-09-04: "you should be able to log in as tom") ────
// An agent never types Tom's password, so every Tom-facing session mutation has
// an internalMutation twin reachable with the deploy credential
// (`npx convex run claudeSessions:internalSendMessage '{…}'`). These pin the
// contract that makes the pens safe to have at all: ONE shared body behind both
// doors, so the pen cannot do more, less, or other than the browser button.
//
// witness: give any internalX its own copy of the handler and let the two drift
// (skip a live check, drop the empty-text guard) — the matching test goes red.

describe("Tom-facing mutations have CLI pens with identical effect", () => {
  const inboundFor = (
    t: ReturnType<typeof convexTest>,
    sessionId: Id<"claudeSessions">,
  ) =>
    t.run(async (ctx) =>
      (await ctx.db.query("claudeInbound").collect()).filter(
        (row) => row.sessionId === sessionId,
      ),
    );

  it("internalSendMessage enqueues the same pending user-turn, with the same guards", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);

    await t.mutation(internal.claudeSessions.internalSendMessage, {
      sessionId,
      text: "from the CLI",
    });
    // Scoped by text: the session's own initial prompt is already a user-turn
    // row, so counting the kind alone would count creation too.
    const turns = (await inboundFor(t, sessionId)).filter(
      (row) => row.kind === "user-turn" && row.text === "from the CLI",
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].status).toBe("pending");
    // The pen's turn is agent-authored unless the caller vouches for Tom
    // (ttsSlack.sessionReply, after the route verified his Slack user id);
    // the opener is code-built and always "agent".
    expect(turns[0].author).toBe("agent");
    await t.mutation(internal.claudeSessions.internalSendMessage, {
      sessionId,
      text: "relayed from Tom",
      author: "tom",
    });
    const rows = await inboundFor(t, sessionId);
    expect(rows.find((row) => row.text === "relayed from Tom")?.author).toBe("tom");
    expect(rows[0].author).toBe("agent"); // the opener

    // The shared body carries the validations, so the pen refuses exactly what
    // the browser refuses: empty text, and a session that is no longer live.
    await expect(
      t.mutation(internal.claudeSessions.internalSendMessage, {
        sessionId,
        text: "   ",
      }),
    ).rejects.toThrow("Message is empty");
    await t.run(async (ctx) =>
      ctx.db.patch(sessionId, { status: "ended", statusChangedAt: Date.now() }),
    );
    await expect(
      t.mutation(internal.claudeSessions.internalSendMessage, {
        sessionId,
        text: "too late",
      }),
    ).rejects.toThrow(/ended/);
  });

  it("internalSendControl enqueues a control and dedupes against the browser's", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);

    await t.mutation(internal.claudeSessions.internalSendControl, {
      sessionId,
      kind: "interrupt",
    });
    // Same pending row either door writes, so the second one — through the
    // browser this time — is the same no-op a second tap is.
    await tom.mutation(api.claudeSessions.sendControl, {
      sessionId,
      kind: "interrupt",
    });
    const controls = (await inboundFor(t, sessionId)).filter(
      (row) => row.kind === "interrupt",
    );
    expect(controls).toHaveLength(1);
    expect(controls[0].status).toBe("pending");
  });

  it("internalSetSessionModel patches within a family and refuses across one", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await tom.mutation(api.claudeSessions.createSession, {
      title: "test session",
      kind: "adhoc",
      repo: "none",
      model: "opus",
      initialPrompt: "hello",
    });

    await t.mutation(internal.claudeSessions.internalSetSessionModel, {
      sessionId,
      model: "sonnet",
    });
    expect(
      (await t.run(async (ctx) => (await ctx.db.get(sessionId))!)).model,
    ).toBe("sonnet");

    // The same error text the browser gets — one body, one message.
    await expect(
      t.mutation(internal.claudeSessions.internalSetSessionModel, {
        sessionId,
        model: "gpt-5.6-sol",
      }),
    ).rejects.toThrow("use forkSessionAs for a cross-family change");
  });

  it("internalForkSessionAs returns the new session, forkedFrom the old", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const oldId = await tom.mutation(api.claudeSessions.createSession, {
      title: "the boolean sweep",
      kind: "adhoc",
      repos: ["tom.quest"],
      model: "opus",
      initialPrompt: "hello",
    });

    const forkId = await t.mutation(
      internal.claudeSessions.internalForkSessionAs,
      { sessionId: oldId, model: "gpt-5.6-sol", text: "carry on" },
    );
    const fork = await t.run(async (ctx) => (await ctx.db.get(forkId))!);
    expect(fork.forkedFrom).toBe(oldId);
    expect(fork.model).toBe("gpt-5.6-sol");
    expect(fork.repos).toEqual(["tom.quest"]);
    // And the old one ends the ordinary way, exactly as through the browser.
    const stops = (await inboundFor(t, oldId)).filter(
      (row) => row.kind === "stop",
    );
    expect(stops).toHaveLength(1);
  });

  it("internalReopenSession revives an ended session and enqueues its turn", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "ended",
      endedReason: "stopped by Tom",
    });

    await t.mutation(internal.claudeSessions.internalReopenSession, {
      sessionId,
      text: "one more thing",
    });
    const row = await t.run(async (ctx) => (await ctx.db.get(sessionId))!);
    expect(row.status).toBe("idle");
    expect(row.mode).toBe("interactive");
    expect(row.reopenEpoch).toBe(1);
    const turns = (await inboundFor(t, sessionId)).filter(
      (r) => r.kind === "user-turn" && r.text === "one more thing",
    );
    expect(turns).toHaveLength(1);

    // The live check is the body's, not the browser door's: a live session is
    // pushed back at the pen with the same "use sendMessage" answer.
    await expect(
      t.mutation(internal.claudeSessions.internalReopenSession, {
        sessionId,
        text: "again",
      }),
    ).rejects.toThrow(/sendMessage/);
  });
});

// ── The complete payload behind the 32KB cut ─────────────────────────────────
// The transcript principle (lifeos update §1): a rendered view may be short,
// the full bytes must stay retrievable. The daemon uploads a cut payload's
// complete text as ordered chunks (POST /sessions/overflow) and only then
// releases the finalize row that names their hash (the hold in
// worker/session-host/overflow.mjs); these pin what a reader gets back, what
// the chunk door refuses, and how a payload that missed the live upload is
// finished later.

describe("message overflow (the complete payload)", () => {
  const CHUNKS = 6;
  // Each under the 256KB chunk cap; six of them cross OVERFLOW_READ_BYTES, so
  // the read below has to page.
  const CHUNK_CHARS = 250_000;

  /** A payload in `CHUNKS` chunks, each distinguishable from its neighbours. */
  function payloadChunks() {
    return Array.from({ length: CHUNKS }, (_, i) =>
      String.fromCharCode(97 + i).repeat(CHUNK_CHARS),
    );
  }

  const sha256 = (text: string) =>
    createHash("sha256").update(text, "utf8").digest("hex");

  const stampFor = (chunks: string[]) => {
    const full = chunks.join("");
    return {
      sha256: sha256(full),
      byteLength: Buffer.byteLength(full, "utf8"),
      chunkCount: chunks.length,
    };
  };

  async function uploadChunks(
    t: ReturnType<typeof convexTest>,
    sessionId: Id<"claudeSessions">,
    seq: number,
    chunks: string[],
    { dropIndex }: { dropIndex?: number } = {},
  ) {
    for (const [index, text] of chunks.entries()) {
      if (index === dropIndex) continue;
      const res = await t.mutation(
        internal.claudeSessions.internalIngestOverflow,
        { sessionId, seq, index, chunkCount: chunks.length, text },
      );
      expect(res.ok).toBe(true);
    }
  }

  /** The daemon's order: every chunk up, then the row that names them. */
  async function storeOversized(
    t: ReturnType<typeof convexTest>,
    sessionId: Id<"claudeSessions">,
    chunks: string[],
    { dropIndex }: { dropIndex?: number } = {},
  ) {
    const full = chunks.join("");
    const overflow = stampFor(chunks);
    await uploadChunks(t, sessionId, 0, chunks, { dropIndex });
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      finalize: [
        {
          seq: 0,
          turn: 0,
          kind: "tool-result" as const,
          content: { toolUseId: "tool_1", content: full.slice(0, 32 * 1024) },
          overflow,
        },
      ],
    });
    const messageId = await t.run(async (ctx) => {
      const row = await ctx.db.query("claudeMessages").first();
      return row!._id;
    });
    return { messageId, full, overflow };
  }

  /** Every page of one message's overflow, the way the agents page reads it. */
  async function readAll(
    t: Awaited<ReturnType<typeof withTom>>,
    messageId: Id<"claudeMessages">,
  ) {
    const pages: MessageOverflowRead[] = [];
    let fromIndex: number | undefined = undefined;
    do {
      // Annotated: the loop feeds the previous read's nextIndex back in as
      // fromIndex, which TS cannot infer through without a cycle.
      const page: MessageOverflowRead | null = await t.query(
        api.claudeSessions.getMessageOverflow,
        { messageId, fromIndex },
      );
      pages.push(page!);
      fromIndex = page!.nextIndex ?? undefined;
    } while (fromIndex !== undefined && pages.length < 10);
    return pages;
  }

  // witness: drop the overflow chunks (or the row's hash) and an oversized
  // tool result is gone for good — the cut is all that was ever kept.
  it("reassembles an oversized tool result byte-identical over paged reads", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createDaemonSession(t, tom);
    const { messageId, full, overflow } = await storeOversized(
      t,
      sessionId,
      payloadChunks(),
    );

    const pages = await readAll(tom, messageId);
    expect(pages.length).toBeGreaterThan(1); // the read is paged, not unbounded
    for (const page of pages) {
      expect(page).toMatchObject({
        hasOverflow: true,
        sha256: overflow.sha256,
        byteLength: overflow.byteLength,
        chunkCount: CHUNKS,
      });
      // A paged read never claims the whole: that check is the reader's.
      expect(page.complete).toBe(false);
    }
    expect(pages.at(-1)!.end).toBe(true);
    const text = pages.map((p) => p.text).join("");
    expect(text).toBe(full);
    expect(sha256(text)).toBe(overflow.sha256);
    // What the page sums to decide the payload is whole.
    const bytes = pages.reduce((n, p) => n + p.bytes, 0);
    expect(bytes).toBe(overflow.byteLength);
    expect(Buffer.byteLength(text, "utf8")).toBe(overflow.byteLength);
  });

  // witness: count the chunks instead of checking the bytes — a chunk whose
  // text is not what the row promised would read as complete.
  it("calls a payload complete only when its bytes and hash match the stamp", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createDaemonSession(t, tom);
    const chunks = ["héllo ", "wörld"]; // multibyte: bytes ≠ chars
    const { messageId, full } = await storeOversized(t, sessionId, chunks);

    const whole = await tom.query(api.claudeSessions.getMessageOverflow, {
      messageId,
    });
    expect(whole).toMatchObject({
      complete: true,
      end: true,
      nextIndex: null,
      bytes: Buffer.byteLength(full, "utf8"),
      text: full,
    });

    // Every chunk present, one of them not the bytes the row named.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("claudeMessageOverflow")
        .withIndex("by_session_seq_index", (q) =>
          q.eq("sessionId", sessionId).eq("seq", 0).eq("index", 1),
        )
        .first();
      await ctx.db.patch(row!._id, { text: "w0rld" });
    });
    const altered = await tom.query(api.claudeSessions.getMessageOverflow, {
      messageId,
    });
    expect(altered).toMatchObject({ end: true, complete: false });
  });

  it("tells the transcript a row was cut, and how much is behind it", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createDaemonSession(t, tom);
    const { overflow } = await storeOversized(t, sessionId, payloadChunks());
    const page = await tom.query(api.claudeSessions.getMessages, {
      sessionId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page[0]).toMatchObject({
      hasOverflow: true,
      fullByteLength: overflow.byteLength,
    });
  });

  // witness: return a prefix and call it the payload — a hole would read as
  // the whole thing, which is the failure this path exists to prevent.
  it("says so when a chunk the row names never landed", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createDaemonSession(t, tom);
    const { messageId } = await storeOversized(t, sessionId, payloadChunks(), {
      dropIndex: 1,
    });
    const page = await tom.query(api.claudeSessions.getMessageOverflow, {
      messageId,
    });
    expect(page).toMatchObject({
      hasOverflow: true,
      end: false,
      complete: false,
      nextIndex: null,
    });
    expect(page!.text).toHaveLength(CHUNK_CHARS); // chunk 0 only
  });

  it("stores nothing for a message that fits", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createDaemonSession(t, tom);
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      finalize: [
        {
          seq: 0,
          turn: 0,
          kind: "tool-result" as const,
          content: { toolUseId: "tool_1", content: "ok" },
        },
      ],
    });
    const chunks = await t.run(async (ctx) =>
      ctx.db.query("claudeMessageOverflow").collect(),
    );
    expect(chunks).toHaveLength(0);
    const page = await tom.query(api.claudeSessions.getMessages, {
      sessionId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page[0].hasOverflow).toBe(false);
    expect(page.page[0].fullByteLength).toBeUndefined();
    const messageId = page.page[0]._id;
    expect(
      await tom.query(api.claudeSessions.getMessageOverflow, { messageId }),
    ).toMatchObject({ hasOverflow: false, complete: true });
  });

  // witness: drop the overflowFailures loop from internalIngest — a payload
  // Convex refused would sit on the box with nothing pointing at it.
  it("records an event naming the file when the daemon could not store a payload", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createDaemonSession(t, tom);
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      finalize: [
        {
          seq: 0,
          turn: 0,
          kind: "error" as const,
          content: { message: "the complete payload for message 0 …" },
        },
      ],
      overflowFailures: [
        {
          seq: 0,
          error: "HTTP 400",
          path: "/var/cache/tts/sessions/abc/overflow/0",
          byteLength: 9_000_000,
        },
      ],
    });
    const events = await t.run(async (ctx) =>
      ctx.db.query("dtsEvents").collect(),
    );
    const unstored = events.filter(
      (e) => e.kind === "session-overflow-unstored",
    );
    expect(unstored).toHaveLength(1);
    expect(unstored[0].data).toMatchObject({
      sessionId,
      seq: 0,
      error: "HTTP 400",
      path: "/var/cache/tts/sessions/abc/overflow/0",
      byteLength: 9_000_000,
    });
  });

  // witness: insert instead of upsert — a blind retry of one chunk would
  // double it and the reassembly would no longer match its hash.
  it("upserts a re-sent chunk instead of doubling it", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createDaemonSession(t, tom);
    const chunk = {
      sessionId,
      seq: 3,
      index: 0,
      chunkCount: 1,
      text: "the payload",
    };
    await t.mutation(internal.claudeSessions.internalIngestOverflow, chunk);
    await t.mutation(internal.claudeSessions.internalIngestOverflow, chunk);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("claudeMessageOverflow").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("the payload");
  });

  // witness: accept any chunk under a stamped seq — a chunk from a different
  // chunking of the payload would overwrite one the row's stamp names.
  it("refuses a chunk that disagrees with the row's stamp, or is malformed", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createDaemonSession(t, tom);
    const chunks = ["abc", "def"];
    await storeOversized(t, sessionId, chunks);

    const send = (body: {
      seq: number;
      index: number;
      chunkCount: number;
      text: string;
    }) =>
      t.mutation(internal.claudeSessions.internalIngestOverflow, {
        sessionId,
        ...body,
      });
    // Same chunking as the stamp: a replay, accepted.
    expect(await send({ seq: 0, index: 1, chunkCount: 2, text: "def" })).toMatchObject({ ok: true });
    // A different chunkCount under the stamped seq: refused.
    expect(await send({ seq: 0, index: 0, chunkCount: 3, text: "ab" })).toMatchObject({
      ok: false,
      reason: "chunkCount disagrees with the row's stamp",
    });
    // Out of range or not an integer: refused whatever the seq.
    expect(await send({ seq: 9, index: 2, chunkCount: 2, text: "x" })).toMatchObject({
      ok: false,
      reason: "malformed chunk",
    });
    expect(await send({ seq: 9, index: 0.5, chunkCount: 1, text: "x" })).toMatchObject({
      ok: false,
      reason: "malformed chunk",
    });
    // Nothing of the refused ones landed.
    const rows = await t.run(async (ctx) =>
      ctx.db.query("claudeMessageOverflow").collect(),
    );
    expect(rows.map((r) => r.text).sort()).toEqual(["abc", "def"]);
  });

  // The re-ingest path (worker/session-host/reingest-overflow.mjs): the row
  // landed unstamped when the live upload failed; later the chunks go up and
  // the stamp is written from the file's own hash.
  it("stamps an unstamped row once its chunks are up, and only then", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createDaemonSession(t, tom);
    const chunks = ["first half ", "second half"];
    const stamp = stampFor(chunks);
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      finalize: [
        {
          seq: 0,
          turn: 0,
          kind: "tool-result" as const,
          content: { toolUseId: "tool_1", content: "first half " },
        },
      ],
    });
    const stampIt = () =>
      t.mutation(internal.claudeSessions.internalStampOverflow, {
        sessionId,
        seq: 0,
        ...stamp,
      });
    // Before the chunks: refused, the row untouched.
    expect(await stampIt()).toMatchObject({ ok: false, reason: "chunks incomplete" });
    await uploadChunks(t, sessionId, 0, chunks);
    expect(await stampIt()).toEqual({ ok: true, stamped: true });
    // Again (a lost response, a re-run): a no-op, not a refusal.
    expect(await stampIt()).toEqual({ ok: true, stamped: false });
    // A different stamp for the same row: refused.
    expect(
      await t.mutation(internal.claudeSessions.internalStampOverflow, {
        sessionId,
        seq: 0,
        ...stamp,
        byteLength: stamp.byteLength + 1,
      }),
    ).toMatchObject({ ok: false, reason: "row already stamped" });
    // No row under the seq at all: refused.
    expect(
      await t.mutation(internal.claudeSessions.internalStampOverflow, {
        sessionId,
        seq: 7,
        ...stamp,
      }),
    ).toMatchObject({ ok: false, reason: "no message row" });

    const page = await tom.query(api.claudeSessions.getMessages, {
      sessionId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page[0]).toMatchObject({
      hasOverflow: true,
      fullByteLength: stamp.byteLength,
    });
    const whole = await tom.query(api.claudeSessions.getMessageOverflow, {
      messageId: page.page[0]._id,
    });
    expect(whole).toMatchObject({ complete: true, text: chunks.join("") });
  });

  // witness: drop the sweep from the seq floor — chunks uploaded for a row
  // the floor then dropped would sit under a seq whose landed row never
  // names them, unreadable and undeletable.
  it("sweeps the chunks of a dropped stamped replay whose landed row has no stamp", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest({ schema, modules });
      const tom = await withTom(t);
      const sessionId = await createDaemonSession(t, tom);
      // What landed under seq 0: a plain row, no stamp.
      await t.mutation(internal.claudeSessions.internalIngest, {
        sessionId,
        finalize: [
          {
            seq: 0,
            turn: 0,
            kind: "assistant-text" as const,
            content: { text: "short" },
          },
        ],
      });
      // A second writer's chunks under the same seq, then its stamped row,
      // which the floor drops.
      const chunks = ["aaa", "bbb"];
      await uploadChunks(t, sessionId, 0, chunks);
      await t.mutation(internal.claudeSessions.internalIngest, {
        sessionId,
        finalize: [
          {
            seq: 0,
            turn: 0,
            kind: "tool-result" as const,
            content: { toolUseId: "tool_1", content: "aaa" },
            overflow: stampFor(chunks),
          },
        ],
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const rows = await t.run(async (ctx) => ({
        messages: await ctx.db.query("claudeMessages").collect(),
        chunks: await ctx.db.query("claudeMessageOverflow").collect(),
      }));
      expect(rows.messages).toHaveLength(1);
      expect(rows.messages[0].overflow).toBeUndefined();
      expect(rows.chunks).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the chunks when the dropped replay is a retry of a stamped row", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest({ schema, modules });
      const tom = await withTom(t);
      const sessionId = await createDaemonSession(t, tom);
      const chunks = ["aaa", "bbb"];
      await storeOversized(t, sessionId, chunks);
      // The same row again — a blind retry after a lost response.
      await t.mutation(internal.claudeSessions.internalIngest, {
        sessionId,
        finalize: [
          {
            seq: 0,
            turn: 0,
            kind: "tool-result" as const,
            content: { toolUseId: "tool_1", content: "aaa" },
            overflow: stampFor(chunks),
          },
        ],
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const stored = await t.run(async (ctx) =>
        ctx.db.query("claudeMessageOverflow").collect(),
      );
      expect(stored).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // The door itself (convex/http.ts): every field typed before the mutation
  // is reached, and every error a fixed string — a validator error would
  // spell the arguments, payload text included, into what the daemon logs.
  it("POST /sessions/overflow validates by type and never echoes the body", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createDaemonSession(t, tom);
    process.env.SESSIONS_WORKER_KEY = "test-sessions-key";
    try {
      const post = (path: string, body: unknown) =>
        t.fetch(path, {
          method: "POST",
          headers: {
            "X-Sessions-Key": "test-sessions-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      const secret = "the payload text that must not come back";
      const bad = await post("/sessions/overflow", {
        sessionId,
        seq: "0",
        index: 0,
        chunkCount: 1,
        text: secret,
      });
      expect(bad.status).toBe(400);
      const badBody = await bad.text();
      expect(badBody).toBe(JSON.stringify({ error: "seq (non-negative integer) required" }));
      expect(badBody).not.toContain(secret);

      // A sessionId of the wrong shape reaches the mutation's own validator;
      // what comes back is still the constant, not the arguments.
      const wrongId = await post("/sessions/overflow", {
        sessionId: "not-an-id",
        seq: 0,
        index: 0,
        chunkCount: 1,
        text: secret,
      });
      expect(wrongId.status).toBe(400);
      const wrongBody = await wrongId.text();
      expect(wrongBody).toBe(JSON.stringify({ error: "overflow chunk rejected" }));
      expect(wrongBody).not.toContain(secret);

      const ok = await post("/sessions/overflow", {
        sessionId,
        seq: 0,
        index: 0,
        chunkCount: 1,
        text: secret,
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, index: 0 });

      // A refusal is a 409: permanent by the daemon's rule, fixed string.
      const refused = await post("/sessions/overflow", {
        sessionId,
        seq: 0,
        index: 1,
        chunkCount: 1,
        text: secret,
      });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: "malformed chunk" });

      const stamp = await post("/sessions/overflow/stamp", {
        sessionId,
        seq: 0,
        sha256: "not hex",
        byteLength: 1,
        chunkCount: 1,
      });
      expect(stamp.status).toBe(400);
      expect(await stamp.json()).toEqual({ error: "sha256 (64 hex chars) required" });
    } finally {
      delete process.env.SESSIONS_WORKER_KEY;
    }
  });
});

// ── The transcript the daemon copies into a fork's workspace ─────────────────
// GET /sessions/transcript pages this internalQuery. Oldest-first and paged:
// the file it builds is the whole conversation in order, and a long session's
// transcript is thousands of rows — the read the collect rule exists to stop.

describe("a session's rows (one transcript path)", () => {
  // witness: leave rowsFrom to the daemon's rowsFromFiles, and a session born
  // after the daemon stops sending it reads the daemon's rows, which do not
  // exist, and shows an empty transcript.
  it("is born reading its agent file", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    expect((await t.run((ctx) => ctx.db.get(sessionId)))?.rowsFrom).toBe("runs");
  });
});

describe("session transcript pages", () => {
  // witness: order it "desc" (the browser's direction) or collect it whole —
  // the file the daemon writes would be backwards, or the read would grow
  // without bound with the session.
  it("pages in seq order and stops on a null cursor", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createDaemonSession(t, tom);
    const total = 450; // more than two 200-row pages
    await t.run(async (ctx) => {
      for (let seq = 0; seq < total; seq++) {
        await ctx.db.insert("claudeMessages", {
          sessionId,
          seq,
          turn: Math.floor(seq / 10),
          kind: "assistant-text",
          content: `line ${seq}`,
          parentToolUseId: seq === 3 ? "tool_abc" : undefined,
          createdAt: 1_000 + seq,
        });
      }
    });

    const seqs: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await t.query(
        internal.claudeSessions.internalTranscriptPage,
        { sessionId, cursor },
      );
      pages++;
      seqs.push(...page.rows.map((r) => r.seq));
      cursor = page.nextCursor ?? undefined;
      if (pages === 1) {
        expect(page.rows).toHaveLength(200);
        // The shape the daemon writes the file from.
        expect(page.rows[3]).toMatchObject({
          seq: 3,
          kind: "assistant-text",
          content: "line 3",
          parentToolUseId: "tool_abc",
        });
      }
    } while (cursor !== undefined && pages < 10);

    expect(pages).toBe(3);
    expect(seqs).toEqual(Array.from({ length: total }, (_, i) => i));
  });
});

// The GROUNDWORK walk: the three lanes that schedule every active todo still
// unprepared (block prep, dated, whenever). A todo Tom captures reaches the
// fleet through them; since batches went (Tom's ruling of 2026-09-24) they are
// the whole work walk.
describe("autonomous session scheduler", () => {
  // The eligible shape: active, whenever, unprepared, no category.
  async function eligibleTodo(
    tom: Awaited<ReturnType<typeof withTom>>,
    statement = "draft the reading list",
  ) {
    return await tom.mutation(api.tts.createTodo, { statement });
  }

  it("admits one autonomous session with its mission and its event", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await eligibleTodo(tom);
    await enableAuto(t);
    await heartbeat(t);

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});

    const sessions = await workSessions(t);
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session.mode).toBe("autonomous");
    // "draft the reading list" names no repo, so the resolver lands on the
    // empty-scratch posture.
    expect(session.repo).toBe("none");
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
    expect(inbound[0].text).toContain("/tts/session-outcome");
    // The env contract: an autonomous session's shell carries ONLY
    // CONVEX_SITE_URL + TTS_WORKER_KEY, so the ingest key never reaches a
    // model-reachable environment — the prompt must not so much as name it.
    expect(inbound[0].text).toContain("TTS_WORKER_KEY");
    expect(inbound[0].text).not.toContain("SESSIONS_WORKER_KEY");

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
  it("stands down when per-cpu load or free memory says the Jarvis Box is busy", async () => {
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

    // No heartbeat at all: nothing on the Jarvis Box could start a session.
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

  it("excludes code todos and ruled or already-running subjects", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t);
    await heartbeat(t);

    // Code todos live in the mirror; their work happens in the repo.
    await tom.mutation(api.tts.createTodo, {
      statement: "fix the flaky test",
      category: "code",
    });
    // A live unapplied ruling means Tom already spoke — do not race it.
    const ruledId = await eligibleTodo(tom, "revise this one");
    await tom.mutation(api.ttsRulings.recordRuling, {
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
    expect(await workSessions(t)).toHaveLength(0);
  });

  // witness: drop the `live.verdict === "session"` clause from the exclusion
  // and this test goes red — Tom asked for a conversation, not groundwork.
  it("never takes over a todo whose live verdict asked for a session", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t);
    await heartbeat(t);
    const todoId = await eligibleTodo(tom, "needs a conversation");
    await tom.mutation(api.ttsRulings.recordRuling, {
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
    expect(await workSessions(t)).toHaveLength(0);
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
    const created = (await workSessions(t)).filter(
      (s) => s.title !== "past auto run",
    );
    expect(created).toHaveLength(0);
  });

  // witness: narrow the history filter back to `s.mode === "autonomous"` (drop
  // wasAutonomous's reopenedFromAutonomous half) and this test goes red — the
  // fleet would re-admit a subject the moment Tom reopened its run and closed
  // it by hand, because the flip to "interactive" erased the run from history.
  it("keeps a reopened autonomous run in the todo's backoff history", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t);
    await heartbeat(t);
    const todoId = await eligibleTodo(tom, "reopened and finished by hand");
    const pastId = await insertPastAutoSession(t, {
      todoId,
      statusChangedAt: Date.now() - 60 * 60 * 1000,
      outcome: "errored",
      outcomeSummary: "no source to read",
    });
    // Tom reopened it (mode flips to interactive) and it ended again.
    await t.run(async (ctx) =>
      ctx.db.patch(pastId, {
        mode: "interactive" as const,
        reopenedFromAutonomous: true,
      }),
    );

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    // Every session row, not just the autonomous ones — the reopened run is
    // "interactive" now, so a mode filter would hide the very row under test.
    // The prospecting mission this tick's leftover budget also created carries
    // no todo, and this test is about the todo's history.
    const created = await t.run(async (ctx) =>
      (await ctx.db.query("claudeSessions").collect()).filter(
        (s) => s.title !== "past auto run" && s.todoId !== undefined,
      ),
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
      (await workSessions(t)).filter((s) => s.title !== "past auto run"),
    ).toHaveLength(0);

    // The todo moved since the run — there is new ground to cover.
    await t.run(async (ctx) => ctx.db.patch(todoId, { updatedAt: ranAt + 1 }));
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(
      (await workSessions(t)).filter((s) => s.title !== "past auto run"),
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

  // The breaker's live path: the daemon wraps the SDK's own error text into
  // outcomeSummary ("autonomous turn failed: …") on any abnormal autonomous
  // turn end, so usage-limit wording arrives THERE, not only in endedReason.
  it("stands down on a usage-limit ending reported as an outcome summary", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t);
    await heartbeat(t);
    await eligibleTodo(tom, "plenty to do");
    await insertPastAutoSession(t, {
      status: "failed",
      statusChangedAt: Date.now() - 60_000,
      outcome: "errored",
      outcomeSummary:
        "autonomous turn failed: Claude AI usage limit reached|1756400000",
    });

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(
      (await autoSessions(t)).filter((s) => s.title !== "past auto run"),
    ).toHaveLength(0);
  });

  // witness: widen USAGE_LIMIT_RE (shared/session-constants.mjs) back to /rate.?limit|overloaded/ and this test
  // goes red — transient API weather would stand the whole fleet down for the
  // full three-hour window, which is what the narrowing was for.
  it("does not stand down on transient API weather", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t);
    await heartbeat(t);
    await eligibleTodo(tom, "plenty to do");
    await insertPastAutoSession(t, {
      status: "failed",
      statusChangedAt: Date.now() - 60_000,
      outcome: "errored",
      endedReason: "rate limit exceeded, retrying",
      outcomeSummary: "autonomous turn failed: API Error 529 overloaded_error",
    });

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(
      (await workSessions(t)).filter((s) => s.title !== "past auto run"),
    ).toHaveLength(1);
  });

  // witness: restore the old pick-one-then-test order in the category-block
  // lane (take the stalest, THEN run it through excluded()) and this test goes
  // red — one excluded item at the head starves the whole category.
  it("a category block walks past an excluded item to the stalest it may take", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 1 });
    await heartbeat(t);
    const now = Date.now();
    const stalest = await tom.mutation(api.tts.createTodo, {
      statement: "the stalest chore",
      category: "chores",
    });
    const next = await tom.mutation(api.tts.createTodo, {
      statement: "the next chore",
      category: "chores",
    });
    // Tom already spoke on the stalest one — the fleet must not race it.
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId: stalest,
      verdict: "revise",
      sentence: "shorter",
    });
    // Staleness stated outright: the ruling above bumped the stalest row's
    // updatedAt, and two creates in one millisecond would otherwise tie.
    await t.run(async (ctx) => {
      await ctx.db.patch(stalest, { updatedAt: now - 2000 });
      await ctx.db.patch(next, { updatedAt: now - 1000 });
    });
    await tom.mutation(api.tts.createBlock, {
      start: now + 60 * 60 * 1000,
      end: now + 2 * 60 * 60 * 1000,
      category: "chores",
    });

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const sessions = await autoSessions(t);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].todoId).toBe(next);
    // kind + blockCategory say the BLOCK lane admitted it: the whenever lane
    // would have reached the same todo as a plain "focus-item".
    expect(sessions[0].kind).toBe("block");
    expect(sessions[0].blockCategory).toBe("chores");
  });

  // ── Which repo the mission's workspace holds (resolveSessionRepos) ─────────
  // Ratified doctrine (Tom, 2026-08-29): autonomous missions IMPLEMENT rather
  // than stop at a Tom decision, so a mission whose work lives in a repo gets
  // a real checkout. A groundwork mission names no repos, so the answer comes
  // from the todo's own words — the resolver's fallback, and its only rule
  // here.

  // witness: drop the substring scan from resolveSessionRepos
  // (convex/claudeSessions.ts) and this test goes red — a mission plainly
  // about a repo would open in an empty scratch dir with nothing to edit.
  it("the item's own words name the mission's checkout", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 1 });
    await heartbeat(t);
    await eligibleTodo(tom, "rework the ComplexMultiTrigger seam");

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const sessions = await autoSessions(t);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].repo).toBe("ComplexMultiTrigger");

    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId: sessions[0]._id,
    });
    expect(inbound[0].text).toContain(WORKER_CONTRACT);
    // The repo variant names the checkout, its branch, the delegate, and the
    // checks that make a merge mechanical and reportable.
    expect(inbound[0].text).toContain("fresh checkout of ComplexMultiTrigger");
    expect(inbound[0].text).toContain(`session/${sessions[0]._id}`);
    expect(inbound[0].text).toContain("tts-ask --session");
    expect(inbound[0].text).toContain("the tests are green");
    expect(inbound[0].text).toContain("an audit approved it");
    expect(inbound[0].text).toContain("/tts/merge");
    expect(inbound[0].text).not.toContain("EMPTY scratch directory");
  });

  // witness: drop the SESSION_REPO_NAMES filter from resolveSessionRepos — the
  // daemon's SESSION_REPOS lookup throws on a repo it cannot clone, so the session
  // would die on its first turn instead of doing groundwork.
  it("a repo name the daemon cannot clone falls back to empty scratch", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 1 });
    await heartbeat(t);
    await eligibleTodo(tom, "read the rows in NotAKnownRepo");

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const sessions = await autoSessions(t);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].repo).toBe("none");
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId: sessions[0]._id,
    });
    expect(inbound[0].text).toContain("EMPTY scratch directory");
    expect(inbound[0].text).not.toContain("NEVER merge");
    // The no-checkout posture skips the workspace paragraph, so it has to
    // carry the daemon rule itself — see the test below.
    expect(inbound[0].text).toContain(DAEMON_SENTENCE);
  });

  // ── The daemon a session must not restart ────────────────────────────────
  // tts-session-host is the process running THIS session and every other live
  // session on the box. An agent that restarts it to pick up its own change
  // kills itself mid-turn and takes the rest of the fleet with it, so every
  // prompt shape names the rule: with a checkout (via workspaceParagraph) and
  // without one (the empty-scratch prohibitions), autonomous and interactive.
  //
  // witness: drop the sentence from either branch of workspaceParagraph, or
  // from the no-repo prohibitions line, and the matching half goes red.
  it("tells every mission, checkout or not, never to restart the session daemon", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    // Three slots for two todos, so the leftover one becomes a prospector and
    // this test covers the third prompt shape too.
    await enableAuto(t, { maxNewPerTick: 3 });
    await heartbeat(t);
    // One todo whose own words name a repo (a checkout mission) and one that
    // names none (the empty-scratch mission).
    const withRepo = await eligibleTodo(tom, "fix the tom.quest deploy check");
    const withoutRepo = await eligibleTodo(tom, "draft the reading list");

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const sessions = await workSessions(t);
    const checkout = sessions.find((s) => s.todoId === withRepo);
    const scratch = sessions.find((s) => s.todoId === withoutRepo);
    expect(checkout?.repo).toBe("tom.quest");
    expect(scratch?.repo).toBe("none");

    for (const session of [checkout!, scratch!]) {
      const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
        sessionId: session._id,
      });
      expect(inbound[0].text).toContain(DAEMON_SENTENCE);
    }

    // The prospecting mission this tick also created writes its own workspace
    // wording, so it names the rule itself rather than inheriting it.
    const prospectors = await prospectSessions(t);
    expect(prospectors).toHaveLength(1);
    const prospectInbound = await tom.query(
      api.claudeSessions.getPendingInbound,
      { sessionId: prospectors[0]._id },
    );
    expect(prospectInbound[0].text).toContain(DAEMON_SENTENCE);
    // Every autonomous lane is told the delegate exists — this one has no
    // todo, so the command it is given names no item.
    expect(prospectInbound[0].text).toContain(
      `tts-ask --session ${prospectors[0]._id} --question`,
    );
  });

  // witness: name tts-ask in app/lib/tts-session-prompt.ts's FRAMING. An
  // ATTENDED session must never be told the delegate exists — its whole
  // posture is "propose and wait", and the delegate answers only where nobody
  // is watching. The route refuses an attended ask too (convex/ttsAsk.ts), but
  // this is the cheapest of the three defences: it is never mentioned.
  it("the interactive framing never names the delegate", async () => {
    const framing = readFileSync("app/lib/tts-session-prompt.ts", "utf8");
    expect(framing).not.toContain("tts-ask");
    expect(framing).not.toContain("delegate");
  });

  // witness: drop the statement/brief substring fallback from
  // resolveSessionRepos and the named item below goes to "none" — a
  // life-shaped todo that is plainly about a repo would have nothing to edit.
  it("a repo the words name is checked out; one that names none gets nothing", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 2 });
    await heartbeat(t);
    const plainId = await eligibleTodo(tom, "book the room for the offsite");
    const namedId = await eligibleTodo(tom, "fix the tom.quest deploy check");

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const sessions = await autoSessions(t);
    expect(sessions).toHaveLength(2);
    const plainSession = sessions.find((s) => s.todoId === plainId);
    const namedSession = sessions.find((s) => s.todoId === namedId);
    expect(plainSession?.repo).toBe("none");
    expect(namedSession?.repo).toBe("tom.quest");

    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId: plainSession!._id,
    });
    expect(inbound[0].text).toContain("EMPTY scratch directory");
    // Both workspace variants carry the implement-anyway doctrine: a decision
    // of Tom's never parks the session.
    expect(inbound[0].text).toContain("does NOT block you");
  });
});

// ── The code lane ────────────────────────────────────────────────────────────
// Tom's approve or archive ruling on a CODE todo (an entry in a repo's
// vqc/todos.yaml, briefed on the page) is admitted as a WORKER MISSION on
// that repo's checkout — the successor of worker/jobs/execute-approved.mjs
// (the lifeos update, phase 7). The ruling applies at admission with the
// session id; the mission ends in a pull request Tom merges.
describe("the code lane", () => {
  // tom.quest: the one repo left on the code-todo list (ttsShared
  // CODE_TODO_REPOS) since ruling 70 took ComplexMultiTrigger off it.
  const REPO = "tom.quest";

  // Open, briefed code todos — what Tom rules on. One mirror replace for the
  // whole set (a replace drops the rows it is not handed).
  async function briefedCodeTodos(t: ReturnType<typeof convexTest>, ids: string[]) {
    await t.mutation(internal.tts.internalReplaceMirror, {
      repo: REPO,
      rows: ids.map((externalId) => ({
        externalId,
        tier: "R",
        status: "open",
        statement: `entry ${externalId}`,
        url: "u",
      })),
    });
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: ids.map((externalId) => ({
        repo: REPO,
        externalId,
        sourceHash: "h",
        brief: `# Brief for ${externalId}\nwhat, why, how`,
        recommendation: "approve" as const,
        execClass: "box" as const,
      })),
    });
  }
  const briefedCodeTodo = (t: ReturnType<typeof convexTest>, id: string) =>
    briefedCodeTodos(t, [id]);

  async function rule(
    tom: Awaited<ReturnType<typeof withTom>>,
    externalId: string,
    verdict: "approve" | "archive" | "revise" | "session",
    sentence?: string,
  ) {
    return await tom.mutation(api.ttsRulings.recordRuling, {
      repo: REPO,
      externalId,
      verdict,
      sentence,
    });
  }

  it("admits an approved code todo as a worker mission and applies the ruling with the session", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await briefedCodeTodo(t, "cmt-001");
    const rulingId = await rule(tom, "cmt-001", "approve", "keep the CLI flag");
    await enableAuto(t);
    await heartbeat(t);

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});

    const sessions = await codeSessions(t);
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session.mode).toBe("autonomous");
    expect(session.codeRepo).toBe(REPO);
    expect(session.codeExternalId).toBe("cmt-001");
    expect(session.repos).toEqual([REPO]);
    expect(session.todoId).toBeUndefined();
    expect(session.status).toBe("requested");

    // The prompt: the entry, the brief Tom ruled from, his sentence, the
    // branch, the guard, the PR, the outcome pen — and never the ingest key.
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId: session._id,
    });
    const text = inbound[0].text ?? "";
    expect(text).toContain("cmt-001");
    expect(text).toContain('TOM RULED "approve"');
    expect(text).toContain("Brief for cmt-001");
    expect(text).toContain("keep the CLI flag");
    expect(text).toContain(`session/${session._id}`);
    expect(text).toContain("pnpm vitest run vqc/todos.test.ts");
    expect(text).toContain("gh pr create");
    expect(text).toContain("CHANGE REPORT:");
    expect(text).toContain(WORKER_CONTRACT);
    expect(text).not.toContain("define every term on first use");
    expect(text).toContain("/tts/session-outcome");
    expect(text).toContain("the tests are green");
    expect(text).toContain("an audit approved it");
    expect(text).toContain("/tts/merge");
    expect(text).toContain(DAEMON_SENTENCE);
    expect(text).not.toContain("SESSIONS_WORKER_KEY");
    expect(text.indexOf(TEST_PRELUDE_LAYERS.know)).toBeLessThan(
      text.indexOf(WORKER_CONTRACT),
    );
    expect(text.indexOf("Ending: record the outcome")).toBeLessThan(
      text.indexOf('TOM RULED "approve"'),
    );
    expect(text.indexOf("THE CODE TODO:")).toBeLessThan(
      text.indexOf("THE BRIEF Tom ruled from"),
    );
    expect(text.indexOf("Ending: record the outcome, then simply stop responding")).toBeLessThan(
      text.indexOf("THE BRIEF Tom ruled from"),
    );

    // The ruling is applied AT ADMISSION, naming the session.
    const ruling = await t.run(async (ctx) => ctx.db.get(rulingId));
    expect(ruling?.appliedAt).toBeDefined();
    expect(ruling?.applyResult).toBe(`admitted as session ${session._id}`);
    expect(await t.query(internal.ttsRulings.internalPendingRulings, {})).toHaveLength(0);

    const events = await t.run(async (ctx) => ctx.db.query("dtsEvents").collect());
    expect(
      events.some(
        (e) =>
          e.kind === "auto-session-created" &&
          (e.data as { externalId?: string })?.externalId === "cmt-001",
      ),
    ).toBe(true);
    expect(events.some((e) => e.kind === "auto-session-scheduler")).toBe(true);

    // A second tick admits nothing more: the ruling is applied, and the
    // mission is live.
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(await codeSessions(t)).toHaveLength(1);
  });

  it("admits an archive ruling as a mission that only closes the entry", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await briefedCodeTodo(t, "cmt-002");
    await rule(tom, "cmt-002", "archive", "landed in #90");
    await enableAuto(t);
    await heartbeat(t);
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const [session] = await codeSessions(t);
    expect(session).toBeDefined();
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId: session._id,
    });
    expect(inbound[0].text).toContain('TOM RULED "archive"');
    expect(inbound[0].text).toContain("Do NOT implement it");
    expect(inbound[0].text).toContain("landed in #90");
    // The mirror keeps saying "open" until the PR merges: the mission is
    // told, so its PR body tells Tom why a second archive would double up.
    expect(inbound[0].text).toContain(
      'a second "archive" ruling on it would open a second pull request',
    );
  });

  // witness: drop `seed.mode !== "autonomous"` AND the kind/category checks
  // from the code-session block in insertSession — the mission's insert would
  // stamp cmt-b's verdict with a session Tom is not in. (The block lane skips
  // a "code" category block by name, so the code lane is the one path that
  // opens an autonomous session while a code session verdict is live.)
  it("an autonomous mission consumes no code session verdict", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await briefedCodeTodos(t, ["cmt-a", "cmt-b"]);
    await rule(tom, "cmt-a", "approve");
    await rule(tom, "cmt-b", "session", "walk me through the parser");
    await enableAuto(t);
    await heartbeat(t);
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const [mission] = await codeSessions(t);
    expect(mission.codeExternalId).toBe("cmt-a");
    // cmt-b's conversation is still owed: the ruling rides the feed, and the
    // mission was told nothing about it.
    const pending = await t.query(internal.ttsRulings.internalPendingRulings, {});
    expect(pending.map((r) => `${r.externalId} ${r.verdict}`)).toEqual(["cmt-b session"]);
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId: mission._id,
    });
    expect(inbound[0].text).not.toContain("cmt-b");
    expect(inbound[0].text).not.toContain("walk me through the parser");
  });

  // witness: drop the archive-first key from admitCodeMissions' sort — an
  // hour-long approve mission would hold a one-edit set-aside behind it.
  it("admits an archive ahead of an older approve", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await briefedCodeTodos(t, ["cmt-approve", "cmt-archive"]);
    await rule(tom, "cmt-approve", "approve");
    await rule(tom, "cmt-archive", "archive");
    // The approve is the OLDER ruling.
    await t.run(async (ctx) => {
      for (const r of await ctx.db.query("dtsRulings").collect()) {
        await ctx.db.patch(r._id, { ruledAt: r.verdict === "approve" ? 1000 : 2000 });
      }
    });
    await enableAuto(t, { maxNewPerTick: 4 });
    await heartbeat(t);
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const sessions = await codeSessions(t);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].codeExternalId).toBe("cmt-archive");
    const pending = await t.query(internal.ttsRulings.internalPendingRulings, {});
    expect(pending.map((r) => r.externalId)).toEqual(["cmt-approve"]);
  });

  // witness: drop the verdict filter in admitCodeMissions — a revise (the
  // planner's) or a session (Tom's conversation) would be executed.
  it("admits neither a revise nor a session ruling, and one mission at a time, oldest ruling first", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await briefedCodeTodos(t, ["cmt-a", "cmt-b", "cmt-c", "cmt-d"]);
    await rule(tom, "cmt-a", "revise", "again");
    await rule(tom, "cmt-b", "session");
    await rule(tom, "cmt-c", "approve");
    await rule(tom, "cmt-d", "approve");
    // cmt-c ruled first.
    await t.run(async (ctx) => {
      for (const r of await ctx.db.query("dtsRulings").collect()) {
        await ctx.db.patch(r._id, { ruledAt: r.externalId === "cmt-c" ? 1000 : 2000 });
      }
    });
    await enableAuto(t, { maxNewPerTick: 4 });
    await heartbeat(t);
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const sessions = await codeSessions(t);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].codeExternalId).toBe("cmt-c");
    // While cmt-c's mission is live, cmt-d waits — pending, not refused.
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(await codeSessions(t)).toHaveLength(1);
    const pending = await t.query(internal.ttsRulings.internalPendingRulings, {});
    expect(pending.map((r) => r.externalId).sort()).toEqual(["cmt-a", "cmt-b", "cmt-d"]);
  });

  // witness: drop the mirror or brief checks — a ruling on a closed or
  // unbriefed entry would ride the feed forever, or start a session on
  // nothing.
  it("refuses, by name on the ruling, an entry that is closed in the mirror or has no brief", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await briefedCodeTodo(t, "cmt-closed");
    await t.mutation(internal.tts.internalReplaceMirror, {
      repo: REPO,
      rows: [
        { externalId: "cmt-closed", tier: "R", status: "closed", statement: "s", url: "u" },
        { externalId: "cmt-unbriefed", tier: "R", status: "open", statement: "s", url: "u" },
      ],
    });
    const closed = await rule(tom, "cmt-closed", "approve");
    const unbriefed = await rule(tom, "cmt-unbriefed", "approve");
    await enableAuto(t);
    await heartbeat(t);
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(await codeSessions(t)).toHaveLength(0);
    const rows = await t.run(async (ctx) => ({
      closed: await ctx.db.get(closed),
      unbriefed: await ctx.db.get(unbriefed),
    }));
    expect(rows.closed?.applyResult).toMatch(/^refused: .*not open/);
    expect(rows.unbriefed?.applyResult).toMatch(/^refused: .*no brief/);
    expect(await t.query(internal.ttsRulings.internalPendingRulings, {})).toHaveLength(0);
  });

  // Ruling 70 took ComplexMultiTrigger off the code-todo list, and its mirror
  // rows and briefs stay as records — so an open, briefed CMT row still
  // exists. witness: drop the tracksCodeTodos check from recordRuling's
  // subject resolver and the first expectation goes red; drop it from
  // admitCodeMissions and a ruling recorded before the change starts a
  // mission on a repo whose todos now live in TTS.
  it("refuses a CMT code ruling at the pen, and one recorded before ruling 70 at admission", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.tts.internalReplaceMirror, {
      repo: "ComplexMultiTrigger",
      rows: [{ externalId: "cmt-open", tier: "R", status: "open", statement: "s", url: "u" }],
    });
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [{
        repo: "ComplexMultiTrigger",
        externalId: "cmt-open",
        sourceHash: "h",
        brief: "a brief",
        recommendation: "approve" as const,
        execClass: "box" as const,
      }],
    });
    await expect(
      tom.mutation(api.ttsRulings.recordRuling, {
        repo: "ComplexMultiTrigger",
        externalId: "cmt-open",
        verdict: "approve",
      }),
    ).rejects.toThrow(/off the code-todo list/);

    const earlier = await t.run(async (ctx) =>
      ctx.db.insert("dtsRulings", {
        subjectType: "code",
        repo: "ComplexMultiTrigger",
        externalId: "cmt-open",
        verdict: "approve",
        ruledAt: Date.now() - 60_000,
      }),
    );
    await enableAuto(t);
    await heartbeat(t);
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(await codeSessions(t)).toHaveLength(0);
    const ruling = await t.run(async (ctx) => ctx.db.get(earlier));
    expect(ruling?.applyResult).toBe("refused: ComplexMultiTrigger keeps no code-todo file any more");

    // A ruling on a CHANGE in CMT (a pull request, not a code todo) is not
    // what the refusal is for: it is recorded and applied at write time.
    // witness: drop the isChangeSubject exemption from insertRuling.
    const change = await tom.mutation(api.ttsRulings.recordRuling, {
      repo: "ComplexMultiTrigger",
      externalId: "pr-105",
      verdict: "approve",
    });
    expect((await t.run(async (ctx) => ctx.db.get(change)))?.appliedAt).toBeGreaterThan(0);
  });

  // witness: drop the by_code_subject history read — a code todo could draw
  // missions without end.
  it("holds the per-subject session ceiling", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await briefedCodeTodo(t, "cmt-loop");
    await t.run(async (ctx) => {
      for (let i = 0; i < 8; i++) {
        await ctx.db.insert("claudeSessions", {
          title: "past code mission",
          kind: "adhoc",
          repo: REPO,
          mode: "autonomous",
          codeRepo: REPO,
          codeExternalId: "cmt-loop",
          status: "ended",
          statusChangedAt: Date.now() - 86_400_000,
          nextSeq: 0,
          createdAt: Date.now() - 86_400_000,
        });
      }
    });
    const rulingId = await rule(tom, "cmt-loop", "approve");
    await enableAuto(t);
    await heartbeat(t);
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect((await codeSessions(t)).filter((s) => s.status === "requested")).toHaveLength(0);
    const ruling = await t.run(async (ctx) => ctx.db.get(rulingId));
    expect(ruling?.applyResult).toMatch(/^refused: .*8 missions/);
  });

  // witness: put the code lane after the work walk — a backlog with more
  // eligible todos than slots would starve every approved code todo forever.
  it("takes its slot before the work walk", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await briefedCodeTodo(t, "cmt-001");
    await rule(tom, "cmt-001", "approve");
    // Three eligible life todos and a budget of two: the code lane still gets
    // one of the two, and the walk the other.
    for (const s of ["a", "b", "c"]) {
      await tom.mutation(api.tts.createTodo, { statement: `life ${s}` });
    }
    await enableAuto(t, { maxNewPerTick: 2 });
    await heartbeat(t);
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(await codeSessions(t)).toHaveLength(1);
    expect(await workSessions(t)).toHaveLength(1);
    // And the tick's own event counts it.
    const events = await t.run(async (ctx) => ctx.db.query("dtsEvents").collect());
    const tick = events.find((e) => e.kind === "auto-session-scheduler");
    expect((tick?.data as { admitted?: number })?.admitted).toBe(2);
    expect((tick?.data as { counts?: { code?: number } })?.counts?.code).toBe(1);
  });

  it("stands down with the rest of the fleet when the box is busy", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await briefedCodeTodo(t, "cmt-001");
    await rule(tom, "cmt-001", "approve");
    await enableAuto(t);
    await heartbeat(t, { ...HEALTHY_LOAD, loadavg1: 16 });
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(await codeSessions(t)).toHaveLength(0);
    expect(await t.query(internal.ttsRulings.internalPendingRulings, {})).toHaveLength(1);
  });
});

// ── The prospecting lane ─────────────────────────────────────────────────────
// A PROSPECTING MISSION is an autonomous session that works no todo: it reads
// one repo and captures the concrete issues it finds as new unprepared items
// (Tom's directive, 2026-08-29: "review the CMT and tom.quest repos for issues
// to make more to-dos").
//
// The rule these tests pin is Tom's amendment the same night: prospecting runs
// IN PARALLEL with real todo work, spending whatever per-tick budget the work
// walk left unspent, because keeping the Jarvis Box at full capacity overnight is the
// top priority. It is NOT the last resort it was first built as.
describe("prospecting lane", () => {
  // The two repos the lane may prospect. WikiTom is deliberately absent: it is
  // a wiki, not a source of code issues.
  const PROSPECT_REPOS = ["ComplexMultiTrigger", "tom.quest"];

  // Take a live session out of the live set, so a test about the cooldown is
  // not silently answered by the live-prospector cap instead.
  async function endSession(
    t: ReturnType<typeof convexTest>,
    id: Id<"claudeSessions">,
  ) {
    await t.run(async (ctx) => ctx.db.patch(id, { status: "ended" as const }));
  }

  // witness: put the lane back behind `picked.size === 0` (the last-resort
  // shape) and this test goes red — a tick that admitted one real mission out
  // of a budget of two would leave the second slot unspent all night.
  it("spends the tick's leftover budget on a prospector alongside real work", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    // The contract default: two new sessions per tick. One real todo is
    // eligible, so exactly one slot is left over.
    await enableAuto(t);
    await heartbeat(t);
    const todoId = await tom.mutation(api.tts.createTodo, {
      statement: "draft the reading list",
    });

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});

    // The real work went first and still got its mission.
    const work = await workSessions(t);
    expect(work).toHaveLength(1);
    expect(work[0].todoId).toBe(todoId);

    // ...and the leftover slot became a prospecting mission on the SAME tick.
    const prospectors = await prospectSessions(t);
    expect(prospectors).toHaveLength(1);
    const prospector = prospectors[0];
    expect(PROSPECT_REPOS).toContain(prospector.repo);
    expect(prospector.title).toBe(`prospect: ${prospector.repo}`);
    // "adhoc" and no todoId: this mission works no item — which is also the
    // fact the lane's own live-prospector count reads.
    expect(prospector.kind).toBe("adhoc");
    expect(prospector.todoId).toBeUndefined();
    expect(prospector.mode).toBe("autonomous");
    expect(prospector.status).toBe("requested");

    // Its mission turn is queued for the daemon like any other.
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId: prospector._id,
    });
    expect(inbound).toHaveLength(1);
    expect(inbound[0].kind).toBe("user-turn");

    // The lane's own trail names the session and the repo — the scheduler
    // event stays the work walk's.
    const events = await prospectEvents(t);
    expect(events).toHaveLength(1);
    expect(events[0].data as { sessionId: string; repo: string }).toEqual({
      sessionId: prospector._id,
      repo: prospector.repo,
    });
  });

  // witness: drop the `picked.size < capacity` guard and this test goes red —
  // prospecting would take a slot the work walk wanted.
  it("creates no prospector when real work consumed the whole budget", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 1 });
    await heartbeat(t);
    await tom.mutation(api.tts.createTodo, { statement: "draft the agenda" });

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});

    expect(await workSessions(t)).toHaveLength(1);
    expect(await prospectSessions(t)).toHaveLength(0);
    expect(await prospectEvents(t)).toHaveLength(0);
  });

  // Two rules agree on this tick and either one alone would carry it: the
  // cooldown skips the repo just prospected, and the oldest-first comparator
  // prefers the repo never prospected. Each is pinned on its own below; this
  // one pins their shared effect — witness: remove both (leave the lane taking
  // PROSPECT_REPOS[0]) and it goes red, every tick re-reading one tree.
  it("sends the next prospecting to the repo the first one did not read", async () => {
    const t = convexTest({ schema, modules });
    await withTom(t);
    await enableAuto(t);
    await heartbeat(t);

    // No todos at all: every tick's whole budget is leftover, and the lane
    // still creates exactly ONE mission per tick.
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const first = await prospectSessions(t);
    expect(first).toHaveLength(1);
    // Never prospected beats never prospected on the order in the source —
    // which is now SESSION_REPOS' declaration order in convex/ttsShared.ts
    // (PROSPECT_REPOS is derived from it, minus the excluded wiki, rather than
    // hand-listed), so the first tick takes tom.quest.
    expect(first[0].repo).toBe("tom.quest");
    await endSession(t, first[0]._id);

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const second = await prospectSessions(t);
    expect(second).toHaveLength(2);
    const repos = second.map((s) => s.repo).sort();
    expect(repos).toEqual(["ComplexMultiTrigger", "tom.quest"]);
  });

  // Two witnesses, one per half. Delete the cooldown skip and the first half
  // goes red — a third prospector would re-read a tree read moments ago. Widen
  // PROSPECT_COOLDOWN_MS back to six hours ("six hours is insane") and the
  // second half goes red — the Jarvis Box would idle the night out on a repo it read
  // once. The last assertion is the fairness comparator's own: invert
  // `lastAt < repoLastAt` and the newest-read repo would win instead.
  it("declines while every repo is inside the cooldown, then takes the stalest", async () => {
    const t = convexTest({ schema, modules });
    await withTom(t);
    await enableAuto(t);
    await heartbeat(t);

    // Three repos are prospected (tom.quest, ComplexMultiTrigger, Jarvis) and
    // two may be live at once, so the third is reached after the first two end.
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const firstTwo = await prospectSessions(t);
    expect(firstTwo).toHaveLength(2);
    for (const s of firstTwo) await endSession(t, s._id);
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const all = await prospectSessions(t);
    expect(all.map((s) => s.repo).sort()).toEqual(["ComplexMultiTrigger", "Jarvis", "tom.quest"]);
    // Every one out of the live set, so ONLY the cooldown can decline the tick.
    for (const s of all) await endSession(t, s._id);

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(await prospectSessions(t)).toHaveLength(3);

    // Age the trail past the 30-minute window, tom.quest most recently and
    // ComplexMultiTrigger longest ago: the repo whose last prospecting is
    // OLDEST wins.
    const now = Date.now();
    const ago = { "tom.quest": 31, Jarvis: 60, ComplexMultiTrigger: 90 } as Record<string, number>;
    const events = await prospectEvents(t);
    await t.run(async (ctx) => {
      for (const e of events) {
        const repo = (e.data as { repo: string }).repo;
        await ctx.db.patch(e._id, { at: now - ago[repo] * 60_000 });
      }
    });

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const after = await prospectSessions(t);
    expect(after).toHaveLength(4);
    const newest = after.sort((a, b) => b.createdAt - a.createdAt)[0];
    expect(newest.repo).toBe("ComplexMultiTrigger");
  });

  // witness: raise PROSPECT_MAX_LIVE or drop the count entirely and this test
  // goes red — prospectors would crowd out the real work they ride beside.
  it("holds at two live prospectors", async () => {
    const t = convexTest({ schema, modules });
    await withTom(t);
    await enableAuto(t);
    await heartbeat(t);
    // Two live autonomous sessions carrying no todo IS two live prospectors —
    // the absence of a todo is what the cap counts.
    await insertPastAutoSession(t, { status: "running" });
    await insertPastAutoSession(t, { status: "running" });

    // Nothing else stands in the way: no todos to spend the budget, and no
    // prospecting event anywhere, so both repos are out of cooldown.
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(await prospectEvents(t)).toHaveLength(0);
    expect(
      (await prospectSessions(t)).filter((s) => s.title !== "past auto run"),
    ).toHaveLength(0);
  });

  // witness: remove the /tts/state step from buildProspectMissionPrompt and
  // this test goes red — the mission's only defence against handing Tom a
  // duplicate is reading what he already holds.
  it("briefs the mission to read, capture, and never push", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t);
    await heartbeat(t);

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const prospector = (await prospectSessions(t))[0];
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId: prospector._id,
    });
    const text = inbound[0].text ?? "";

    // The dedupe read comes before the capture pen, and both are named.
    expect(text).toContain("/tts/state");
    expect(text).toContain("/tts/capture");
    expect(text.indexOf("/tts/state")).toBeLessThan(
      text.indexOf("/tts/capture"),
    );
    expect(text).toContain('"source": "prospecting"');
    expect(text).toContain(WORKER_CONTRACT);
    expect(text).not.toContain("Follow the ground-up contract");
    // At most eight captures, said in the prompt because the capture route is
    // the agent's own pen and enforces no cap of its own.
    expect(text).toContain("At most 8 captures");
    expect(text).toContain("do not capture more than 8 items");
    // It names its own session and repo, and the outcome pen.
    expect(text).toContain(prospector._id);
    expect(text).toContain(prospector.repo!);
    expect(text).toContain("/tts/session-outcome");

    // Read-and-capture only: none of the work walk's workspace instructions
    // reach a prospector, and the prohibition is stated outright.
    expect(text).toContain("push nothing");
    expect(text).not.toContain("push the branch");
    expect(text).not.toContain("gh pr create");
    expect(text).not.toContain("NEVER merge");
    expect(text).not.toContain(`session/${prospector._id}`);

    // Same env contract as every autonomous mission: the ingest key never
    // reaches a model-reachable environment, so the prompt cannot name it.
    expect(text).toContain("TTS_WORKER_KEY");
    expect(text).not.toContain("SESSIONS_WORKER_KEY");
    expect(text.indexOf(TEST_PRELUDE_LAYERS.know)).toBeLessThan(
      text.indexOf(WORKER_CONTRACT),
    );
    expect(text.indexOf("What counts as a finding:")).toBeLessThan(
      text.indexOf("The mission: this session PROSPECTS"),
    );
    expect(text.indexOf("Ending: record the outcome via the /tts/session-outcome command")).toBeLessThan(
      text.indexOf("The mission: this session PROSPECTS"),
    );
  });

  // witness: put the read-first step back behind `repo === "ComplexMultiTrigger"`
  // and the tom.quest half goes red — which is exactly how it shipped, while
  // the mirror cron read tom.quest's registry all along and /tts/state showed
  // none of it. A prospector blind to that file re-captures decided work.
  // The CMT half is the other direction since ruling 70: CMT keeps no
  // registry, so its prospector is not sent to read one.
  it("tells a prospector to read vqc/todos.yaml first in a registry repo, and only there", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t);
    await heartbeat(t);

    // One tick per repo (one mission per tick), so both prompts exist.
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const prospectors = await prospectSessions(t);
    expect(prospectors.map((s) => s.repo).sort()).toEqual([
      "ComplexMultiTrigger",
      "tom.quest",
    ]);

    for (const prospector of prospectors) {
      const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
        sessionId: prospector._id,
      });
      const text = inbound[0].text ?? "";
      if (prospector.repo === "ComplexMultiTrigger") {
        expect(text).not.toContain("vqc/todos.yaml");
        continue;
      }
      expect(text).toContain("vqc/todos.yaml");
      // Read the registry BEFORE the capture pen, like the /tts/state read.
      expect(text.indexOf("vqc/todos.yaml")).toBeLessThan(
        text.indexOf("/tts/capture"),
      );
      expect(text).toContain("drop any finding it already names");
    }
  });

  // ── A prospector is an ordinary autonomous session ───────────────────────
  // It runs on the same model the work walk would have used: the fleet default
  // Tom set, not insertSession's built-in default. This lane passed no model at
  // all, so a fleet Tom had moved to Sonnet still started Codex prospectors.
  //
  // witness: drop the `model` field from admitProspectMission's insertSession
  // seed and this goes red.
  it("runs a prospector on the fleet default model", async () => {
    const t = convexTest({ schema, modules });
    await withTom(t);
    await enableAuto(t, { defaultModel: "sonnet" });
    await heartbeat(t);

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const prospectors = await prospectSessions(t);
    expect(prospectors).toHaveLength(1);
    expect(prospectors[0].model).toBe("sonnet");
  });

  // ...and it respects the same Codex door. A prospector carries no model tag
  // (there is no todo to tag it), so it is always the untagged case: it falls
  // back to Claude rather than waiting, and the fallback is logged with no
  // todoId because no item is involved.
  //
  // witness: resolve the prospector's model without the codexClosed branch and
  // this goes red — every prospector would keep launching Codex against a
  // capped account.
  it("falls a prospector back to opus when the codex door is shut", async () => {
    const t = convexTest({ schema, modules });
    await withTom(t);
    await enableAuto(t, { defaultModel: "gpt-5.6-sol" });
    await t.mutation(internal.claudeSessions.internalPoll, {
      version: "test",
      daemonStartedAt: 1,
      load: HEALTHY_LOAD,
      codexUsage: {
        weeklyUsedPercent: CODEX_WEEKLY_CAP_PERCENT,
        fiveHourUsedPercent: 3,
        readAt: Date.now(),
      },
    });

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const prospectors = await prospectSessions(t);
    expect(prospectors).toHaveLength(1);
    expect(prospectors[0].model).toBe("opus");

    const events = await t.run(async (ctx) =>
      (await ctx.db.query("dtsEvents").collect()).filter(
        (e) => e.kind === "auto-model-fallback",
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0].todoId).toBeUndefined();
    expect(events[0].data).toEqual({
      from: "gpt-5.6-sol",
      to: "opus",
      reason: `codex weekly usage at or past ${CODEX_WEEKLY_CAP_PERCENT}%`,
    });
  });
});

// ── The groundwork lanes: claims, repeats, and what a mission carries ────────
// Tom ruled on 2026-09-24, verbatim: "I dont want to have batches at all
// anymore because I want to remove structure to allow agents to freely move
// toward completing all todos in the best way they (or the orchistrator) see
// fit." The frontier walk that handed ready todos inside batches to worker
// missions went with batches, so every todo reaches the fleet through the
// groundwork lanes (block, dated, whenever). These are the rules those lanes
// still keep that the frontier's tests used to carry.
describe("the groundwork lanes: claims, repeats, and what a mission carries", () => {
  async function missionText(
    tom: Awaited<ReturnType<typeof withTom>>,
    sessionId: Id<"claudeSessions">,
  ) {
    const inbound = await tom.query(api.claudeSessions.getPendingInbound, {
      sessionId,
    });
    return inbound[0].text ?? "";
  }

  // A mission that has run to a stop: it recorded its outcome and the daemon
  // ended it. `at` is the END stamp, which is always later than every pen
  // write the session made — the distinction the completed-backoff turns on.
  async function finishSession(
    t: ReturnType<typeof convexTest>,
    id: Id<"claudeSessions">,
    at: number = Date.now() + 1000,
  ) {
    await t.mutation(internal.claudeSessions.internalRecordOutcome, {
      id,
      outcome: "completed",
      summary: "completed: one state advanced",
    });
    await t.run(async (ctx) =>
      ctx.db.patch(id, { status: "ended" as const, statusChangedAt: at }),
    );
  }

  // One of Tom's goals, the shape the lanes see: an ordinary unprepared
  // active todo whose kind is "goal", with a condition to check.
  async function goalTodo(
    t: ReturnType<typeof convexTest>,
    tom: Awaited<ReturnType<typeof withTom>>,
    statement: string,
    condition: string,
  ) {
    const goalId = await tom.mutation(api.tts.createTodo, { statement });
    await t.run(async (ctx) =>
      ctx.db.patch(goalId, { kind: "goal" as const, condition }),
    );
    return goalId;
  }

  // witness: drop the live-session exclusion (the claim) from computeExcluded
  // in convex/claudeSessions.ts and this goes red — two sessions would hold
  // the same todo and do the same work twice.
  it("does not claim a todo a live session already holds", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t);
    await heartbeat(t);
    const todoId = await tom.mutation(api.tts.createTodo, {
      statement: "gather the sources",
    });
    await tom.mutation(api.claudeSessions.createSession, {
      title: "a real conversation",
      kind: "focus-item",
      repo: "none",
      todoId,
      initialPrompt: "let's talk",
    });

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    // Tom's own session is interactive, so the only thing to count is the
    // autonomous fleet: it admitted nothing, because the todo is claimed.
    expect(await workSessions(t)).toHaveLength(0);
  });

  // "Jarvis" names the whole agent system as well as the repository, and "the
  // Jarvis Box" is in prose everywhere. witness: drop TEXT_SCAN_SKIPPED from
  // resolveSessionRepos in convex/claudeSessions.ts and the first half goes
  // red, every todo that mentions the box getting a Heffnt/Jarvis clone.
  // The second half is the one path left to the repository: a caller that
  // names it.
  it("never guesses Jarvis from a todo's words, and gives it to a caller who names it", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 1 });
    await heartbeat(t);
    const todoId = await tom.mutation(api.tts.createTodo, {
      statement: "restart the poller on the Jarvis Box",
    });

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const guessed = await workSessions(t);
    expect(guessed).toHaveLength(1);
    expect(guessed[0].repos).toEqual([]);
    expect(guessed[0].repo).toBe("none");

    const named = await tom.mutation(api.claudeSessions.createSession, {
      title: "move the deploy job",
      kind: "focus-item",
      repos: ["Jarvis"],
      todoId,
      initialPrompt: "port the job to the new repository",
    });
    const session = await t.run(async (ctx) => ctx.db.get(named));
    expect(session?.repos).toEqual(["Jarvis"]);
    expect(session?.repo).toBe("Jarvis");
  });

  // The block lane resolves its subject through todoById, not the active set,
  // so the sleep test the active set already applied has to be asked again
  // there. witness: read the block's todo from `todoById` without
  // wakeAtPassed and this goes red: a row asleep until next week would be
  // handed groundwork tonight.
  it("hands out no sleeping row from the block lane until its wakeAt passes", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 1 });
    await heartbeat(t);
    const now = Date.now();
    const todoId = await tom.mutation(api.tts.createTodo, {
      statement: "book the flights",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(todoId, { wakeAt: now + 7 * 24 * 60 * 60 * 1000 });
    });
    await tom.mutation(api.tts.createBlock, {
      start: now + 60 * 60 * 1000,
      end: now + 2 * 60 * 60 * 1000,
      todoId,
    });

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(await workSessions(t)).toHaveLength(0);

    // Awake (the wakeAt is behind us): the same block admits it.
    await t.run(async (ctx) => {
      await ctx.db.patch(todoId, { wakeAt: now - 1 });
    });
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const sessions = await workSessions(t);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].todoId).toBe(todoId);
    // The block lane admitted it, not the whenever lane behind it.
    const ticks = await t.run(async (ctx) =>
      (await ctx.db.query("dtsEvents").collect()).filter(
        (e) => e.kind === "auto-session-scheduler",
      ),
    );
    const last = ticks[ticks.length - 1]?.data as { counts?: Record<string, number> };
    expect(last?.counts).toMatchObject({ block: 1 });
  });

  // THE MULTI-SESSION TODO. A completed run is followed by another only when
  // the run moved the row, and the test has to admit the run that DID move
  // it. witness: measure the backoff against the session's END
  // (statusChangedAt) instead of its start (createdAt) and the second half
  // goes red: the end stamp lands after every pen write the session made, so
  // the sessions that did record progress are exactly the ones excluded.
  it("re-admits a completed todo that advanced, and leaves a settled one alone", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 1 });
    await heartbeat(t);
    const todoId = await tom.mutation(api.tts.createTodo, {
      statement: "write the migration",
    });
    // Written a minute ago, so the run below starts after the row's last
    // write however the clock resolves.
    await t.run(async (ctx) =>
      ctx.db.patch(todoId, { updatedAt: Date.now() - 60_000 }),
    );

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const first = await workSessions(t);
    expect(first).toHaveLength(1);
    // The run started a second ago, so the pen write below lands after its
    // start whatever the clock resolution.
    await t.run(async (ctx) =>
      ctx.db.patch(first[0]._id, { createdAt: Date.now() - 1000 }),
    );

    // It ended completed having written NOTHING to the row: settled work, not
    // to be redone.
    await finishSession(t, first[0]._id);
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(await workSessions(t)).toHaveLength(1);

    // Now the same run is found to have advanced it: the pen wrote during the
    // session, and the end stamp lands after that write.
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: todoId,
      evidence: "branch session/x, schema written",
    });
    await finishSession(t, first[0]._id, Date.now() + 2000);
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const second = await workSessions(t);
    expect(second).toHaveLength(2);
    expect(second.every((s) => s.todoId === todoId)).toBe(true);
  });

  // A GOAL IS A QUESTION, ASKED AGAIN. witness: let the completed-backoff's
  // row-changed test apply to a goal (drop the AUTO_GOAL_RECHECK_MS branch)
  // and the last assertion goes red — nothing bumps a goal's updatedAt when
  // the world changes, so every goal would be looked at exactly once.
  it("asks a goal's question again a day after a completed run", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 1 });
    await heartbeat(t);
    const goalId = await goalTodo(
      t,
      tom,
      "the lease is signed",
      "the signed lease is in the folder",
    );

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const onGoal = (await workSessions(t)).filter((s) => s.todoId === goalId);
    expect(onGoal).toHaveLength(1);

    // The answer was "not yet": an honest, complete session that changed
    // nothing. Inside the day, the question is not re-asked.
    await finishSession(t, onGoal[0]._id);
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect((await workSessions(t)).filter((s) => s.todoId === goalId)).toHaveLength(1);

    // A day later it is.
    await t.run(async (ctx) =>
      ctx.db.patch(onGoal[0]._id, {
        statusChangedAt: Date.now() - 25 * 60 * 60 * 1000,
      }),
    );
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect((await workSessions(t)).filter((s) => s.todoId === goalId)).toHaveLength(2);
  });

  // The order a groundwork mission reads in: the model-of-tom prelude, then
  // the worker contract and the pens, then the item itself last. witness:
  // move itemContext above the pens in buildAutoMissionPrompt, or put the
  // prelude after the body in insertSession, and the matching line goes red.
  it("hands a groundwork mission the prelude, then its contract and pens, then the item", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 1 });
    await heartbeat(t);
    await tom.mutation(api.tts.createTodo, {
      statement: "draft the reading list",
    });

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const sessions = await workSessions(t);
    expect(sessions).toHaveLength(1);
    const text = await missionText(tom, sessions[0]._id);
    expect(text).toContain("do the groundwork this item needs");
    expect(text).toContain("/tts/prepare-todo");
    expect(text).toContain('"readiness": "prepared"');
    expect(text).not.toContain("ready-for-tom"); // the retired spelling
    expect(text.indexOf(TEST_PRELUDE_LAYERS.know)).toBeLessThan(
      text.indexOf(WORKER_CONTRACT),
    );
    expect(text.indexOf("The goal:")).toBeLessThan(
      text.indexOf("The item (\"draft the reading list\")"),
    );
    expect(text.indexOf("Ending: record the outcome via the /tts/session-outcome command")).toBeLessThan(
      text.indexOf("The item (\"draft the reading list\")"),
    );
  });

  // Tom's must-not-break line on a goal binds every step toward it, so the
  // agent working the goal has to read it. It used to reach agents only
  // through the worker prompt, which went with batches.
  // witness: drop the mustNotBreak promptFact from buildAutoMissionPrompt in
  // convex/claudeSessions.ts and this goes red — Tom's binding line would
  // reach the page and never the agent doing the work.
  it("hands a groundwork mission on a goal Tom's must-not-break line", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 1 });
    await heartbeat(t);
    const goalId = await goalTodo(
      t,
      tom,
      "the reading list is published",
      "the reading list page is live",
    );
    await tom.mutation(api.tts.updateTodo, {
      id: goalId,
      mustNotBreak: "every citation stays verbatim",
    });

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const sessions = await workSessions(t);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].todoId).toBe(goalId);
    const text = await missionText(tom, sessions[0]._id);
    expect(text).toContain(
      "must not break (Tom's line; a change that would break it is not a change to make): every citation stays verbatim",
    );
  });
});

// ── The fleet model and the usage gates (Tom, 2026-09-04) ────────────────────
// Which model an autonomous session runs on, and when the fleet stands down
// for usage: a todo's model tag, the fleet default, the Codex weekly gate, and
// the per-family usage breaker. Each test seeds ordinary unprepared active
// todos, the shape the groundwork lanes admit.
describe("the fleet model and the usage gates", () => {
  // An ordinary unprepared active todo, tagged with a model when given one.
  async function todoOn(
    t: ReturnType<typeof convexTest>,
    tom: Awaited<ReturnType<typeof withTom>>,
    statement: string,
    model?: SessionModel,
  ) {
    const todoId = await tom.mutation(api.tts.createTodo, { statement });
    if (model !== undefined) {
      await t.run(async (ctx) => ctx.db.patch(todoId, { model }));
    }
    return todoId;
  }

  // witness: drop the model line from the session insert in
  // convex/claudeSessions.ts and this test goes red — the daemon reads the
  // model off the session row (session-host.mjs claimSession/adoptSession pass
  // row.model into the Session, and its FAMILY picks the runner), so a todo
  // tagged with a model would silently run on something else.
  it("carries a todo's model onto the session row and the poll", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 2 });
    await heartbeat(t);
    const hard = await todoOn(t, tom, "prove the bound", "fable");
    const ordinary = await todoOn(t, tom, "tidy the notes");

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const sessions = await workSessions(t);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.todoId === hard)?.model).toBe("fable");
    // The untagged todo does NOT get an absent field: every row written since
    // 2026-09-04 carries an explicit model, and an untagged one lands on the
    // fleet default.
    expect(sessions.find((s) => s.todoId === ordinary)?.model).toBe(
      DEFAULT_SESSION_MODEL,
    );

    const poll = await t.mutation(internal.claudeSessions.internalPoll, {
      version: "test",
      daemonStartedAt: 1,
      load: HEALTHY_LOAD,
    });
    const polled = poll.sessions as { todoId?: string; model?: string }[];
    expect(polled.find((s) => s.todoId === hard)?.model).toBe("fable");
    expect(polled.find((s) => s.todoId === ordinary)?.model).toBe(
      DEFAULT_SESSION_MODEL,
    );
  });

  // An untagged autonomous session runs on whatever claudeAutoConfig names;
  // a tagged todo overrides it, because the tag is a judgment about THAT todo
  // and the default is only what to do without one.
  //
  // witness: resolve the model as `c.todo.model ?? DEFAULT_SESSION_MODEL` in
  // internalAutoSchedule (skipping config.defaultModel) — the fleet knob would
  // become decoration and every untagged session would ignore it.
  it("runs an untagged session on the fleet default and lets a tag override it", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 2, defaultModel: "sonnet" });
    await heartbeat(t);
    const tagged = await todoOn(t, tom, "prove the bound", "fable");
    const untagged = await todoOn(t, tom, "tidy the notes");

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const sessions = await workSessions(t);
    expect(sessions.find((s) => s.todoId === untagged)?.model).toBe("sonnet");
    expect(sessions.find((s) => s.todoId === tagged)?.model).toBe("fable");
  });

  // ── The Codex weekly gate ────────────────────────────────────────────────
  // At or past the cap the fleet starts no Codex session. The two candidates
  // part ways on WHO chose Codex: the fleet default is indifferent, so that
  // work falls back to Opus and runs; a Codex-tagged todo asked for Codex
  // specifically, so it waits for the cap to lift.
  //
  // witness: gate on the five-hour figure instead, or skip both cases alike —
  // either turns a full week's Codex cap into a night with no fleet at all.
  it("falls an untagged session back to opus at the codex weekly cap and makes a codex-tagged one wait", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 4, defaultModel: "gpt-5.6-sol" });
    await t.mutation(internal.claudeSessions.internalPoll, {
      version: "test",
      daemonStartedAt: 1,
      load: HEALTHY_LOAD,
      codexUsage: {
        weeklyUsedPercent: CODEX_WEEKLY_CAP_PERCENT,
        // The five-hour window is nowhere near full — it is not what gates.
        fiveHourUsedPercent: 3,
        readAt: Date.now(),
      },
    });
    const untagged = await todoOn(t, tom, "tidy the notes");
    const tagged = await todoOn(t, tom, "port the harness", "gpt-5.6-sol");

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const sessions = await workSessions(t);
    expect(sessions.map((s) => s.todoId)).toEqual([untagged]);
    expect(sessions[0].model).toBe("opus");
    expect(sessions.some((s) => s.todoId === tagged)).toBe(false);

    // And the night's history says WHY the models differ from what was asked.
    // Scoped to the events that NAME a todo: the prospecting mission this
    // tick's leftover budget also created falls back on the same rule, and
    // its own event carries no todoId (it works no item).
    const events = await t.run(async (ctx) =>
      (await ctx.db.query("dtsEvents").collect()).filter(
        (e) => e.kind === "auto-model-fallback" && e.todoId !== undefined,
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0].todoId).toBe(untagged);
    expect(events[0].data).toMatchObject({
      from: "gpt-5.6-sol",
      to: "opus",
    });
  });

  // Unknown usage ADMITS: a daemon that cannot read the Codex CLI reports
  // nothing, and a missing reading must not read as "capped" — that would
  // freeze the fleet on a telemetry failure.
  // witness: default the missing weeklyUsedPercent to 100 instead of 0.
  it("admits codex work when the daemon reported no usage at all", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 1, defaultModel: "gpt-5.6-sol" });
    await heartbeat(t); // no codexUsage in this heartbeat
    await todoOn(t, tom, "tidy the notes");

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const sessions = await workSessions(t);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].model).toBe("gpt-5.6-sol");
  });

  // A reading also EXPIRES. The daemon keeps resending its LAST SUCCESSFUL
  // reading, carrying that reading's own readAt, while later reads fail — so an
  // old readAt is the case "nobody has managed to ask Codex for a while", and
  // it reads as UNKNOWN exactly like an absent one. Without this, one 90%
  // reading taken before the CLI broke would hold the Codex door shut for as
  // long as the daemon stayed up.
  // witness: gate on weeklyUsedPercent alone and ignore readAt.
  it("re-opens the codex door once the last usage reading has gone stale", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 1, defaultModel: "gpt-5.6-sol" });
    await t.mutation(internal.claudeSessions.internalPoll, {
      version: "test",
      daemonStartedAt: 1,
      load: HEALTHY_LOAD,
      codexUsage: {
        // Full to the brim — but read a full window ago and one minute more.
        weeklyUsedPercent: 100,
        fiveHourUsedPercent: 100,
        readAt: Date.now() - CODEX_USAGE_STALE_MS - 60_000,
      },
    });
    await todoOn(t, tom, "tidy the notes");

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const sessions = await workSessions(t);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].model).toBe("gpt-5.6-sol");
    // Unknown is not a fallback: nothing was logged, because nothing changed.
    const events = await t.run(async (ctx) =>
      (await ctx.db.query("dtsEvents").collect()).filter(
        (e) => e.kind === "auto-model-fallback",
      ),
    );
    expect(events).toHaveLength(0);
  });

  // ── The usage breaker is per family ──────────────────────────────────────
  // A capped CODEX account says nothing about the Claude one: the tick keeps
  // running and only the Codex door shuts. (A capped CLAUDE account still
  // stands the whole tick down — Opus is where every Codex fallback lands.)
  //
  // witness: go back to one boolean `tripped` for both families — a single
  // Codex cap would stand the entire fleet down for three hours.
  it("shuts only the codex door when a codex session ended on a usage limit", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 4, defaultModel: "gpt-5.6-sol" });
    await heartbeat(t);
    await t.run(async (ctx) =>
      ctx.db.insert("claudeSessions", {
        title: "past codex run",
        kind: "focus-item",
        repo: "none",
        mode: "autonomous",
        model: "gpt-5.6-sol",
        status: "ended",
        statusChangedAt: Date.now(),
        endedReason: "usage_limit_reached",
        nextSeq: 0,
        createdAt: Date.now(),
      }),
    );
    const untagged = await todoOn(t, tom, "tidy the notes");
    await todoOn(t, tom, "port the harness", "gpt-5.6-sol");

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const sessions = (await workSessions(t)).filter(
      (s) => s.title !== "past codex run",
    );
    expect(sessions.map((s) => s.todoId)).toEqual([untagged]);
    expect(sessions[0].model).toBe("opus");
  });

  // witness: read the tripped session's family off `mode` or drop the
  // modelFamily() call — a capped CLAUDE account would only shut the Codex
  // door and the fleet would keep launching into the same wall.
  it("stands the whole tick down when a claude session ended on a usage limit", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await enableAuto(t, { maxNewPerTick: 4, defaultModel: "gpt-5.6-sol" });
    await heartbeat(t);
    await t.run(async (ctx) =>
      ctx.db.insert("claudeSessions", {
        title: "past claude run",
        kind: "focus-item",
        repo: "none",
        mode: "autonomous",
        model: "opus",
        status: "ended",
        statusChangedAt: Date.now(),
        endedReason: "Claude AI usage limit reached",
        nextSeq: 0,
        createdAt: Date.now(),
      }),
    );
    await todoOn(t, tom, "tidy the notes");

    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    expect(
      (await workSessions(t)).filter((s) => s.title !== "past claude run"),
    ).toHaveLength(0);
  });
});

// THE MODEL CEILING (worker/agents/models.mjs; Tom's rulings of 2026-09-24). The
// daemon reports the box's Fable availability file on its heartbeat, and the
// health row keeps it for the pages that say "Fable unavailable since <time>,
// last checked <time>". A heartbeat without it keeps the last report.
describe("fable availability and usage limits on the daemon heartbeat", () => {
  it("stores the daemon's reports and keeps them through a heartbeat that carries none", async () => {
    const t = convexTest({ schema, modules });
    const report = { available: false, since: 1_000, checkedAt: 2_000, reason: "You've hit your monthly spend limit" };
    const limit = { at: 3_000, text: "You've hit your session limit", sessionId: "s1" };
    await t.mutation(internal.claudeSessions.internalPoll, {
      version: "test",
      daemonStartedAt: 1,
      load: HEALTHY_LOAD,
      fableAvailability: report,
      usageLimit: limit,
    });
    const stored = async () => await t.run(async (ctx) => await ctx.db.query("claudeDaemonHealth").first());
    expect((await stored())?.fableAvailability).toEqual(report);
    expect((await stored())?.usageLimit).toEqual(limit);
    await heartbeat(t);
    expect((await stored())?.fableAvailability).toEqual(report);
    expect((await stored())?.usageLimit).toEqual(limit);
  });
});
