import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { MessageOverflowRead } from "./claudeSessions";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { modelOfTomPrelude } from "./ttsSkills";
import {
  WORKER_CONTRACT,
  MODEL_OF_TOM_HEADER,
} from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

/** What worker/agents/ingest.mjs stamps on every row; every claudeMessages row has one. */
const ROW_PROVENANCE = { fileVersion: "f".repeat(64), file: "/agent.jsonl", lineStart: 1, lineEnd: 1, block: 0, parserVersion: "runs-parser-2", sourceKind: "fixture" };

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

// A session whose run is named: its rows are its agent file's, under the
// runId, as the sweep lands them.
async function createRunSession(
  t: ReturnType<typeof convexTest>,
  tom: Awaited<ReturnType<typeof withTom>>,
) {
  const sessionId = await createBasicSession(tom);
  const runId = `claude:box:${sessionId}`;
  await t.run((ctx) => ctx.db.patch(sessionId, { runId }));
  return { sessionId, runId };
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

    // Daemon starts the session, delivers the turn, streams.
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
      buf: { turn: 0, seq: 1, text: "Hi Tom, " },
    });
    expect(res.sessionStatus).toBe("running");
    expect(res.pendingInbound).toHaveLength(0);

    const buf = await tom.query(api.claudeSessions.getStreamBuf, { sessionId });
    expect(buf?.text).toBe("Hi Tom, ");
  });

  // One transcript path (Tom's ruling of 2026-09-25): the daemon writes no
  // rows, so the ingest takes none, no overflow failure report, and no
  // switch to a session's file rows. A daemon that still sent one of them
  // would fail loudly on its next flush rather than write a second transcript.
  //
  // witness: declare finalize on internalIngest again and this goes red.
  it("refuses the retired finalize, overflowFailures and rowsFromFiles fields", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    const retired = {
      finalize: [{ seq: 0, turn: 0, kind: "user", content: "hello" }],
      overflowFailures: [{ seq: 0, error: "refused" }],
      rowsFromFiles: true,
    };
    for (const [field, value] of Object.entries(retired)) {
      await expect(
        t.mutation(internal.claudeSessions.internalIngest, { sessionId, [field]: value } as never),
      ).rejects.toThrow(new RegExp(field));
    }
    expect(await t.run((ctx) => ctx.db.query("claudeMessages").collect())).toEqual([]);
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
  it("terminal sessions accept notes but never state patches", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const sessionId = await createBasicSession(tom);
    await tom.mutation(api.claudeSessions.forceClose, { sessionId });

    // Late daemon flush: its notes land, state does not change.
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId,
      status: "failed",
      endedReason: "a git error that did not close this session",
      lastSdkEventAt: 12345,
      notes: [{ at: 1, text: "late note" }],
      buf: { turn: 0, seq: 1, text: "stray tail" },
    });
    const session = await tom.query(api.claudeSessions.getSession, {
      id: sessionId,
    });
    expect(session?.status).toBe("ended");
    expect(session?.endedReason).toBe("force-closed by Tom; worker unconfirmed");
    expect(session?.lastSdkEventAt).toBeUndefined();
    const notes = await tom.query(api.sessionRows.notes, { sessionId });
    expect(notes.map((note) => note.text)).toEqual(["late note"]); // note accepted
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
    // The batches table is gone (2026-09-26); an id-shaped string is enough,
    // because the validator refuses the argument before it reads the value.
    const batchId = "k570000000000000000000000000batch";
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
  it("a pre-reopen flush replay lands its notes but no state, and says nothing", async () => {
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
      notes: [{ at: 1, text: "the end" }],
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
      notes: [{ at: 2, text: "the end (retry)" }],
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
    // A stale payload's notes are still part of what happened.
    const notes = await tom.query(api.sessionRows.notes, { sessionId });
    expect(notes.map((note) => note.text)).toEqual([
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
// the full bytes must stay retrievable. The parser cuts a payload over 32 KB,
// and the sweep stores the complete text as ordered chunks under the row's
// run (POST /agents/overflow, pinned in agents.test.ts); these pin what a
// reader of a session's rows gets back.

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

  /** A cut row of the session's run, and its chunks, as the sweep lands them. */
  async function storeOversized(
    t: ReturnType<typeof convexTest>,
    runId: string,
    chunks: string[],
    { dropIndex }: { dropIndex?: number } = {},
  ) {
    const full = chunks.join("");
    const overflow = stampFor(chunks);
    const messageId = await t.run(async (ctx) => {
      for (const [index, text] of chunks.entries()) {
        if (index === dropIndex) continue;
        await ctx.db.insert("claudeMessageOverflow", {
          runId, seq: 0, index, chunkCount: chunks.length, text, createdAt: 1,
        });
      }
      return await ctx.db.insert("claudeMessages", {
        runId,
        seq: 0,
        turn: 0,
        kind: "tool-result",
        content: { toolUseId: "tool_1", content: full.slice(0, 32 * 1024) },
        depth: 0,
        overflow,
        provenance: ROW_PROVENANCE,
        createdAt: 1,
      });
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
    const { runId } = await createRunSession(t, tom);
    const { messageId, full, overflow } = await storeOversized(
      t,
      runId,
      payloadChunks(),
    );

    const pages = await readAll(tom, messageId);
    expect(pages.length).toBeGreaterThan(1); // the read is paged, not unbounded
    for (const page of pages) {
      expect(page).toMatchObject({
        hasOverflow: true,
        runId,
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
    const { runId } = await createRunSession(t, tom);
    const chunks = ["héllo ", "wörld"]; // multibyte: bytes ≠ chars
    const { messageId, full } = await storeOversized(t, runId, chunks);

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
        .withIndex("by_run_seq_index", (q) =>
          q.eq("runId", runId).eq("seq", 0).eq("index", 1),
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
    const { sessionId, runId } = await createRunSession(t, tom);
    const { overflow } = await storeOversized(t, runId, payloadChunks());
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
    const { runId } = await createRunSession(t, tom);
    const { messageId } = await storeOversized(t, runId, payloadChunks(), {
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

  it("reads a row that fits as whole, with nothing behind it", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const { sessionId, runId } = await createRunSession(t, tom);
    await t.run((ctx) =>
      ctx.db.insert("claudeMessages", {
        runId, seq: 0, turn: 0, kind: "tool-result",
        content: { toolUseId: "tool_1", content: "ok" }, depth: 0, provenance: ROW_PROVENANCE, createdAt: 1,
      }),
    );
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
});

// ── The transcript the daemon copies into a fork's workspace ─────────────────
// GET /sessions/transcript pages this internalQuery. Oldest-first and paged:
// the file it builds is the whole conversation in order, and a long session's
// transcript is thousands of rows — the read the collect rule exists to stop.

describe("session transcript pages", () => {
  // witness: order it "desc" (the browser's direction) or collect it whole —
  // the file the daemon writes would be backwards, or the read would grow
  // without bound with the session.
  it("pages in seq order and stops on a null cursor", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const { sessionId, runId } = await createRunSession(t, tom);
    const total = 450; // more than two 200-row pages
    await t.run(async (ctx) => {
      for (let seq = 0; seq < total; seq++) {
        await ctx.db.insert("claudeMessages", {
          runId,
          seq,
          turn: Math.floor(seq / 10),
          kind: "assistant-text",
          content: `line ${seq}`,
          depth: 0,
          parentToolUseId: seq === 3 ? "tool_abc" : undefined,
          provenance: ROW_PROVENANCE,
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
