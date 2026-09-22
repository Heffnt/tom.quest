// The orchestrator's record (convex/orchestrator.ts), proved through the doors
// a run on the box actually uses: the worker-key pens, the daemon's poll and
// ingest, and Tom's reply in Slack. One path end to end: a start writes a
// hosted request row; the orchestrator spawns a worker; the worker raises
// three elevations and each is answered a different way; a compaction and a
// crash each restart the orchestrator from its document, naming the last run.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { AUTO_DEFAULTS } from "./claudeSessions";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  INITIAL_DOCUMENT,
  ORCHESTRATOR_CRASH_BACKOFF_CAP_MS,
  ORCHESTRATOR_CRASH_BACKOFF_MS,
  ORCHESTRATOR_CRASHES_REPORTED,
  ORCHESTRATOR_KEY,
  ORCHESTRATOR_LEASE_MS,
  ORCHESTRATOR_STABLE_MS,
  buildHostedWorkerPrompt,
  buildOrchestratorPrompt,
  crashBackoffMs,
  orchestratorModel,
} from "./orchestrator";
import { HOSTED_WORKERS_MAX, MODEL_OF_TOM_HEADER, NARROW_LIST } from "./ttsShared";
import { COMPACT_ENDED_REASON, ORCHESTRATOR_COMPACT_WORD } from "../worker/session-host/hosted.mjs";
import { checkMessage, composeElevationAsk, elevationAskBody } from "./ttsCompose";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const KEY = "worker-key";
const HOSTS = ["orchestrator", "worker"];

type T = TestConvex<typeof schema>;

async function setup(): Promise<T> {
  vi.stubEnv("TTS_WORKER_KEY", KEY);
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("modelOfTomPublication", {
      key: "current",
      commit: "testprelude",
      committedAt: 1,
      pushed: true,
      operate: "test operate layer",
      write: "test write layer",
      know: "test know layer",
      headers: ([["operate"], ["write"], ["know"], ["operate", "write"], ["operate", "know"], ["write", "know"], ["operate", "write", "know"]] as const).map(
        (names) => ({ layers: [...names], header: `${MODEL_OF_TOM_HEADER} (WikiTom commit testprelude): ${names.join(",")}` }),
      ),
    });
  });
  return t;
}

async function pen(t: T, path: string, body: unknown) {
  const res = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TTS-Key": KEY },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function poll(t: T, extra: { hosts?: string[]; held?: string[]; codexModels?: string[] } = {}) {
  return (await t.mutation(internal.claudeSessions.internalPoll, { version: "test", daemonStartedAt: 1, ...extra })) as {
    sessions: { id: string; environment?: string; openElevations?: number; outcomeRecorded?: boolean; pendingInbound: { text?: string }[] }[];
  };
}

async function row(t: T) {
  return await t.run(async (ctx) => ctx.db.query("orchestrators").withIndex("by_key", (q) => q.eq("key", ORCHESTRATOR_KEY)).unique());
}

async function pendingTexts(t: T, sessionId: string) {
  return await t.run(async (ctx) =>
    (await ctx.db
      .query("claudeInbound")
      .withIndex("by_session_status", (q) => q.eq("sessionId", sessionId as Id<"claudeSessions">).eq("status", "pending"))
      .collect()).map((r) => r.text ?? ""),
  );
}

async function start(t: T, instruction?: string) {
  const res = await t.mutation(internal.orchestrator.internalStart, { reason: "the proof", ...(instruction ? { instruction } : {}) });
  return res.sessionId as string;
}

/** The daemon's ingest for one session: what it reports as the run moves. */
async function ingest(t: T, sessionId: string, args: { status?: "starting" | "idle" | "running" | "ended" | "failed"; endedReason?: string; runId?: string; outcome?: "completed" | "errored" }) {
  await t.mutation(internal.claudeSessions.internalIngest, { sessionId: sessionId as Id<"claudeSessions">, ...args });
}

async function spawn(t: T, orchestrator: string, title = "fix the footer") {
  const res = await pen(t, "/tts/spawn-worker", { sessionId: orchestrator, title, brief: "Make the footer say tom.Quest.", repos: ["tom.quest"] });
  expect(res.status).toBe(200);
  return res.body.sessionId as string;
}

async function elevate(t: T, worker: string, question = "Should the footer link to the sessions page?") {
  const res = await pen(t, "/tts/elevate", { sessionId: worker, question, sides: ["Link it; one click fewer.", "Leave it; the header already links."] });
  expect(res.status).toBe(200);
  return res.body.elevationId as string;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("orchestratorModel", () => {
  const now = 1_000_000;
  it("takes Astra when the box's Codex CLI lists it, else Sol, else Fable", () => {
    expect(orchestratorModel({ codexModels: ["gpt-6-astra", "gpt-5.6-sol"] }, now).model).toBe("gpt-6-astra");
    expect(orchestratorModel({ codexModels: ["gpt-5.6-sol"] }, now).model).toBe("gpt-5.6-sol");
    expect(orchestratorModel({ codexModels: [] }, now).model).toBe("fable");
    // No list reported yet: Sol, the Codex model known to run.
    expect(orchestratorModel(null, now).model).toBe("gpt-5.6-sol");
  });
  it("falls to Fable past Codex's weekly cap, while the reading is fresh", () => {
    expect(orchestratorModel({ codexModels: ["gpt-6-astra"], codexUsage: { weeklyUsedPercent: 95, readAt: now } }, now).model).toBe("fable");
    expect(orchestratorModel({ codexModels: ["gpt-6-astra"], codexUsage: { weeklyUsedPercent: 95, readAt: 0 } }, now).model).toBe("gpt-6-astra");
  });
});

describe("crashBackoffMs", () => {
  it("doubles from a minute and stops at an hour", () => {
    expect(crashBackoffMs(1)).toBe(ORCHESTRATOR_CRASH_BACKOFF_MS);
    expect(crashBackoffMs(2)).toBe(2 * ORCHESTRATOR_CRASH_BACKOFF_MS);
    expect(crashBackoffMs(30)).toBe(ORCHESTRATOR_CRASH_BACKOFF_CAP_MS);
  });
});

describe("the prompts", () => {
  it("give the orchestrator its pens, the decision kinds and the compact word", () => {
    const text = buildOrchestratorPrompt({
      sessionId: "s1",
      document: INITIAL_DOCUMENT,
      documentVersion: 1,
      reason: "started",
      carried: ["Worker w1 ended."],
      workers: [],
      elevations: [],
    });
    for (const needle of ["/tts/spawn-worker", "/tts/answer", "/tts/message", "/tts/orchestrator/document", "tts-ask --elevation", "NO recommendation", ORCHESTRATOR_COMPACT_WORD, "Worker w1 ended."]) {
      expect(text).toContain(needle);
    }
  });
  it("tell a worker to elevate with two sides and no recommendation, and never to ask the delegate", () => {
    const text = buildHostedWorkerPrompt({ sessionId: "w1", repos: [], brief: "Do the thing." });
    expect(text).toContain("/tts/elevate");
    expect(text).toContain("no recommendation");
    expect(text).toContain("never ask the delegate or Tom yourself");
    expect(text).not.toContain("tts-ask");
  });
  it("ask Tom a reserved decision in the form, with the orchestrator's recommendation after it", () => {
    const facts = { question: "Buy the domain?", sides: ["Buy it.", "Do not."], recommendation: "Buy it.", workerSessionId: "w1" };
    for (const canReply of [true, false]) {
      expect(checkMessage(composeElevationAsk(facts, { canReply }), { canReply })).toEqual([]);
    }
    expect(elevationAskBody(facts)).toContain("The orchestrator recommends: Buy it.");
  });
});

describe("starting and hosting", () => {
  it("writes one hosted request row, shown only to a daemon that hosts it", async () => {
    const t = await setup();
    await poll(t, { codexModels: ["gpt-6-astra", "gpt-5.6-sol"] });
    const sessionId = await start(t, "Spawn one worker.");
    const session = await t.run(async (ctx) => ctx.db.get(sessionId as Id<"claudeSessions">));
    expect(session?.mode).toBe("autonomous");
    expect(session?.model).toBe("gpt-6-astra");
    expect((await row(t))?.modelReason).toContain("lists gpt-6-astra");
    // The opener carries the instruction and the document.
    const opener = (await pendingTexts(t, sessionId))[0];
    expect(opener).toContain("Spawn one worker.");
    expect(opener).toContain("The orchestrator's document");

    // An old daemon is never shown it; a hosting daemon sees its environment.
    expect((await poll(t)).sessions.map((s) => s.id)).not.toContain(sessionId);
    const hosted = (await poll(t, { hosts: HOSTS })).sessions.find((s) => s.id === sessionId);
    expect(hosted?.environment).toBe("orchestrator");

    // One at a time.
    expect(await t.mutation(internal.orchestrator.internalStart, { reason: "twice" })).toMatchObject({ started: false, sessionId });
  });

  it("is started and stopped by Tom, never through a worker-key pen", async () => {
    const t = await setup();
    const tomId = await t.run(async (ctx) => ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }));
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { name: "friend", email: "f@x.y", role: "admin" }));
    await expect(t.withIdentity({ subject: userId }).mutation(api.orchestrator.start, { reason: "not his" })).rejects.toThrow(/restricted to Tom/);
    expect((await t.withIdentity({ subject: tomId }).mutation(api.orchestrator.start, { reason: "his" })).started).toBe(true);
    const byKey = await t.fetch("/tts/orchestrator", { method: "POST", headers: { "Content-Type": "application/json", "X-TTS-Key": KEY }, body: JSON.stringify({ action: "stop", reason: "a worker" }) });
    expect(byKey.status).toBe(404);
    expect((await t.withIdentity({ subject: tomId }).mutation(api.orchestrator.stop, { reason: "his" })).stopped).toBe(true);
  });

  it("spawns hosted workers for the live run only, up to the limit", async () => {
    const t = await setup();
    const orchestrator = await start(t);
    const worker = await spawn(t, orchestrator);
    expect((await pen(t, "/tts/spawn-worker", { sessionId: worker, title: "x", brief: "y" })).status).toBe(409);
    const polled = (await poll(t, { hosts: HOSTS })).sessions.find((s) => s.id === worker);
    expect(polled).toMatchObject({ environment: "worker", openElevations: 0, outcomeRecorded: false });
    for (let i = 1; i < HOSTED_WORKERS_MAX; i += 1) await spawn(t, orchestrator, `worker ${i}`);
    const over = await pen(t, "/tts/spawn-worker", { sessionId: orchestrator, title: "one too many", brief: "y" });
    expect(over.status).toBe(409);
    expect(String(over.body.error)).toContain(`the limit is ${HOSTED_WORKERS_MAX}`);
  });

  it("hands a hosted row Tom reopens back to him as an ordinary session", async () => {
    const t = await setup();
    const orchestrator = await start(t);
    const worker = await spawn(t, orchestrator);
    await ingest(t, worker, { status: "running" });
    await ingest(t, worker, { status: "ended", endedReason: "worker run complete" });
    await t.mutation(internal.claudeSessions.internalReopenSession, { sessionId: worker as Id<"claudeSessions">, text: "What did you change?" });
    const row = (await poll(t, { hosts: HOSTS })).sessions.find((s) => s.id === worker);
    expect(row).toBeDefined();
    expect(row?.environment).toBeUndefined();
    // And an old daemon, which hosts nothing, may now take it like any session.
    expect((await poll(t)).sessions.map((s) => s.id)).toContain(worker);
    // An answer to its open question is recorded, not queued into Tom's talk.
    const elevationId = await t.run(async (ctx) =>
      ctx.db.insert("elevations", { workerSessionId: worker as Id<"claudeSessions">, question: "q?", sides: ["a", "b"], status: "open", createdAt: Date.now() }),
    );
    expect((await pen(t, "/tts/answer", { sessionId: orchestrator, elevationId, kind: "obvious", answer: "a" })).body.delivered).toBe(false);
    expect((await pendingTexts(t, worker)).some((m) => m.includes("Answer to your elevation"))).toBe(false);
    // Nothing of the orchestrator's counts, messages or stops it any more.
    expect((await pen(t, "/tts/message", { sessionId: orchestrator, to: worker, text: "hello" })).status).toBe(409);
    expect((await pen(t, "/tts/elevate", { sessionId: worker, question: "q?", sides: ["a", "b"] })).status).toBe(409);
    await t.mutation(internal.orchestrator.internalStop, { reason: "done" });
    const reopened = await t.run(async (ctx) => ctx.db.get(worker as Id<"claudeSessions">));
    expect(reopened?.status).not.toBe("ended");
    const stops = await t.run(async (ctx) =>
      (await ctx.db.query("claudeInbound").withIndex("by_session_status", (q) => q.eq("sessionId", worker as Id<"claudeSessions">)).collect()).filter((m) => m.kind === "stop"),
    );
    expect(stops).toHaveLength(0);
  });

  it("records an answer to an ended worker without queuing a turn no one will read", async () => {
    const t = await setup();
    const orchestrator = await start(t);
    const worker = await spawn(t, orchestrator);
    const elevationId = await elevate(t, worker);
    await ingest(t, worker, { status: "running" });
    await ingest(t, worker, { status: "ended", endedReason: "worker waited too long for an answer" });
    const before = (await pendingTexts(t, worker)).length;
    const res = await pen(t, "/tts/answer", { sessionId: orchestrator, elevationId, kind: "obvious", answer: "Leave it." });
    expect(res.body).toMatchObject({ status: "answered", delivered: false });
    expect((await pendingTexts(t, worker)).length).toBe(before);
  });

  it("carries messages both ways and keeps the document versioned", async () => {
    const t = await setup();
    const orchestrator = await start(t);
    const worker = await spawn(t, orchestrator);
    expect((await pen(t, "/tts/message", { sessionId: worker, to: "orchestrator", text: "The footer lives in app/layout.tsx." })).status).toBe(200);
    expect((await pendingTexts(t, orchestrator)).some((m) => m.includes("The footer lives in app/layout.tsx."))).toBe(true);
    expect((await pen(t, "/tts/message", { sessionId: orchestrator, to: worker, text: "Keep the change to one file." })).status).toBe(200);
    expect((await pendingTexts(t, worker)).some((m) => m === "Message from the orchestrator: Keep the change to one file.")).toBe(true);

    expect((await pen(t, "/tts/orchestrator/document", { sessionId: worker, document: "# mine" })).status).toBe(409);
    const written = await pen(t, "/tts/orchestrator/document", { sessionId: orchestrator, document: "# v2\n\nOne worker on the footer." });
    expect(written.body.version).toBe(2);
    const versions = await t.run(async (ctx) => ctx.db.query("orchestratorDocuments").collect());
    expect(versions.map((d) => d.version)).toEqual([1, 2]);
  });
});

describe("elevations", () => {
  it("answers an obvious decision itself and delivers it to the worker", async () => {
    const t = await setup();
    const orchestrator = await start(t);
    const worker = await spawn(t, orchestrator);
    const elevationId = await elevate(t, worker);
    const delivered = await pendingTexts(t, orchestrator);
    expect(delivered.some((m) => m.startsWith(`Elevation ${elevationId} from worker ${worker}`) && m.includes("Side two: Leave it"))).toBe(true);
    expect((await poll(t, { hosts: HOSTS })).sessions.find((s) => s.id === worker)?.openElevations).toBe(1);

    const res = await pen(t, "/tts/answer", { sessionId: orchestrator, elevationId, kind: "obvious", answer: "Leave it; the header links." });
    expect(res.body.status).toBe("answered");
    expect((await pendingTexts(t, worker)).some((m) => m.includes("(obvious; the orchestrator's): Leave it"))).toBe(true);
    expect((await poll(t, { hosts: HOSTS })).sessions.find((s) => s.id === worker)?.openElevations).toBe(0);
    // A question longer than the delegate takes could never reach it.
    expect((await pen(t, "/tts/elevate", { sessionId: worker, question: "x".repeat(401), sides: ["a", "b"] })).status).toBe(409);
    // A second answer to the same question is refused.
    expect((await pen(t, "/tts/answer", { sessionId: orchestrator, elevationId, kind: "obvious", answer: "again" })).status).toBe(409);
  });

  it("puts a trade-off to the delegate with no recommendation and records its answer as a delegate ruling", async () => {
    const t = await setup();
    const orchestrator = await start(t);
    const worker = await spawn(t, orchestrator);
    const elevationId = await elevate(t, worker);
    const ask = (body: Record<string, unknown>) =>
      pen(t, "/tts/ask", {
        askId: "0badc0de",
        elevationId,
        question: "Should the footer link to the sessions page?",
        options: ["Link it; one click fewer.", "Leave it; the header already links."],
        fallback: "Leave it.",
        decision: "Leave it; the header already links.",
        reason: "Tom's pages keep one route to each place.",
        refused: false,
        refusedBecause: null,
        model: "fable",
        ms: 10,
        promptSha: "abcd1234",
        ...body,
      });
    // A recommendation on an elevation's trade-off is refused at the door.
    expect((await ask({ recommendation: "Leave it; the header already links." })).status).toBe(400);
    expect((await ask({})).status).toBe(200);

    // An ask that answers some other elevation cannot stand in for this one.
    const other = await elevate(t, worker, "Which colour?");
    expect((await pen(t, "/tts/answer", { sessionId: orchestrator, elevationId: other, kind: "trade-off", askId: "0badc0de" })).status).toBe(409);

    const res = await pen(t, "/tts/answer", { sessionId: orchestrator, elevationId, kind: "trade-off", askId: "0badc0de", answer: "ignored" });
    expect(res.body.status).toBe("answered");
    const ruling = await t.run(async (ctx) => ctx.db.query("dtsRulings").withIndex("by_elevation", (q) => q.eq("elevationId", elevationId as Id<"elevations">)).unique());
    expect(ruling).toMatchObject({ subjectType: "elevation", verdict: "answer", ruledBy: "delegate", askId: "0badc0de", sentence: "Leave it; the header already links." });
    // Never read as Tom's words: not by the planner's feed of his recent
    // rulings, and not by the nightly learning step.
    expect(await t.query(internal.ttsRulings.internalRecentRulings, {})).toEqual([]);
    // Search names it as the delegate's.
    const found = (await t.query(internal.ttsSearch.rulings, { query: "header already links", limit: 5 })) as { results: { ruledBy: string }[] };
    expect(found.results.map((r) => r.ruledBy)).toEqual(["delegate"]);
    expect((await pendingTexts(t, worker)).some((m) => m.includes("ruled by the delegate; treat it as Tom's ruling): Leave it; the header already links."))).toBe(true);

    // His objection reverts it, and both runs are told.
    await t.mutation(internal.ttsAsk.internalRecordDelegateObjection, {
      askId: "0badc0de",
      text: "revert",
      revert: true,
      sentence: null,
      channel: "C-DECISIONS",
      ts: "3.0",
      threadTs: "2.0",
    });
    const reverted = await t.run(async (ctx) => ctx.db.get(ruling!._id));
    expect(reverted?.applyResult).toContain("reverted by Tom's objection");
    expect((await pendingTexts(t, worker)).some((m) => m.startsWith("Tom objected to the delegate's ruling"))).toBe(true);
    expect((await pendingTexts(t, orchestrator)).some((m) => m.startsWith("Tom objected to the delegate's ruling"))).toBe(true);
  });

  it("closes a trade-off the delegate refused as Tom's only as reserved, and never over his objection", async () => {
    const t = await setup();
    const orchestrator = await start(t);
    const worker = await spawn(t, orchestrator);
    const record = async (elevationId: string, askId: string, over: Record<string, unknown>) =>
      pen(t, "/tts/ask", {
        askId, elevationId, question: "Renew now?", options: ["Renew.", "Wait."], fallback: "Wait.",
        decision: "Renew.", reason: "It lapses on Friday.", refused: false, refusedBecause: null,
        model: "fable", ms: 1, promptSha: "abcd1234", ...over,
      });
    const reserved = await elevate(t, worker, "Renew now?");
    await record(reserved, "11111111", { refused: true, refusedBecause: `${NARROW_LIST[0].id} — it spends money` });
    const refusal = await pen(t, "/tts/answer", { sessionId: orchestrator, elevationId: reserved, kind: "trade-off", askId: "11111111", answer: "Wait." });
    expect(refusal.status).toBe(409);
    expect(String(refusal.body.error)).toContain("answer it as reserved");

    const objected = await elevate(t, worker, "Which colour?");
    await record(objected, "22222222", {});
    await t.mutation(internal.ttsAsk.internalRecordDelegateObjection, {
      askId: "22222222", text: "No, keep the old colour.", revert: false, sentence: "No, keep the old colour.", channel: "C", ts: "2.0", threadTs: "1.0",
    });
    const over = await pen(t, "/tts/answer", { sessionId: orchestrator, elevationId: objected, kind: "trade-off", askId: "22222222" });
    expect(over.status).toBe(409);
    expect(String(over.body.error)).toContain("keep the old colour");
    const rulings = await t.run(async (ctx) => ctx.db.query("dtsRulings").withIndex("by_elevation", (q) => q.eq("elevationId", objected as Id<"elevations">)).collect());
    expect(rulings).toHaveLength(0);
  });

  it("sends a reserved decision to Tom with a recommendation, and his reply is the answer", async () => {
    const t = await setup();
    const orchestrator = await start(t);
    const worker = await spawn(t, orchestrator);
    const elevationId = await elevate(t, worker, "Should I buy the tom.quest renewal now?");
    expect((await pen(t, "/tts/answer", { sessionId: orchestrator, elevationId, kind: "reserved" })).status).toBe(409);
    // With no needs-you channel no thread can open, so the question stays open
    // and the worker is told nothing; the answer is retried once it is set.
    const unset = await pen(t, "/tts/answer", { sessionId: orchestrator, elevationId, kind: "reserved", recommendation: "Renew it now." });
    expect(unset.body).toMatchObject({ status: "open", opened: false });
    expect((await pendingTexts(t, worker)).some((m) => m.includes("Tom's to decide"))).toBe(false);
    vi.stubEnv("SLACK_TTS_NEEDS_YOU_CHANNEL_ID", "C-NEEDS");
    const res = await pen(t, "/tts/answer", { sessionId: orchestrator, elevationId, kind: "reserved", recommendation: "Renew it now." });
    expect(res.body).toMatchObject({ status: "waiting-on-tom", opened: true });
    const posts = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.name.includes("sendSlack")).map((job) => job.args[0] as { channel: string; text: string; subject: { kind: string; id: string } }),
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: "C-NEEDS", subject: { kind: "elevation", id: elevationId } });
    expect(posts[0].text).toContain("The orchestrator recommends: Renew it now.");
    expect(posts[0].text).toContain("Should I buy the tom.quest renewal now?");
    // Still open for the worker's ending until Tom answers.
    expect((await poll(t, { hosts: HOSTS })).sessions.find((s) => s.id === worker)?.openElevations).toBe(1);

    // Tom's reply arrives in the thread the one Slack door recorded, and the
    // record of it names the elevation's todo, as a todo thread's reply does.
    const todoId = await t.mutation(internal.tts.internalCapture, { statement: "renew tom.quest", source: "test", provenance: "test" });
    await t.run(async (ctx) => {
      await ctx.db.patch(elevationId as Id<"elevations">, { todoId });
      await ctx.db.insert("dtsEvents", { at: Date.now(), kind: "slack-sent", key: "C-NEEDS:1.0", data: { subject: { kind: "elevation", id: elevationId } } });
    });
    vi.stubEnv("TOM_SLACK_USER_ID", "UTOM");
    const reply = await t.mutation(internal.ttsSlack.internalSlackThreadReply, { eventId: "Ev1", channel: "C-NEEDS", threadTs: "1.0", ts: "2.0", text: "Renew it, yes.", user: "UTOM" });
    expect(reply.outcome).toBe("elevation-answer");
    const event = await t.run(async (ctx) => ctx.db.query("dtsEvents").withIndex("by_kind_key", (q) => q.eq("kind", "slack-event").eq("key", "Ev1")).unique());
    expect(event?.todoId).toBe(todoId);
    const ruling = await t.run(async (ctx) => ctx.db.query("dtsRulings").withIndex("by_elevation", (q) => q.eq("elevationId", elevationId as Id<"elevations">)).unique());
    expect(ruling).toMatchObject({ ruledBy: "tom", sentence: "Renew it, yes." });
    expect((await pendingTexts(t, worker)).some((m) => m === `Tom answered your elevation ${elevationId}: Renew it, yes.`)).toBe(true);
  });
});

describe("beside the older machinery", () => {
  it("gives the delegate's pre-ask read an elevation as its caller", async () => {
    const t = await setup();
    const orchestrator = await start(t);
    const worker = await spawn(t, orchestrator);
    const elevationId = await elevate(t, worker);
    const res = await t.fetch(`/tts/ask-context?elevationId=${elevationId}`, { headers: { "X-TTS-Key": KEY } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ asked: 0 });
  });

  it("takes none of the auto-session scheduler's places", async () => {
    const t = await setup();
    const orchestrator = await start(t);
    await spawn(t, orchestrator);
    await t.run(async (ctx) => {
      await ctx.db.insert("claudeAutoConfig", { ...AUTO_DEFAULTS, enabled: true, maxLiveAutonomous: 1, updatedAt: Date.now() });
    });
    await t.mutation(internal.claudeSessions.internalPoll, {
      version: "test",
      daemonStartedAt: 1,
      hosts: HOSTS,
      load: { loadavg1: 1, cpus: 8, freeMemMb: 8192, totalMemMb: 16384, liveSessions: 0 },
    });
    await t.mutation(internal.claudeSessions.internalAutoSchedule, {});
    const prospectors = await t.run(async (ctx) =>
      (await ctx.db.query("claudeSessions").collect()).filter((s) => s.title.startsWith("prospect: ")),
    );
    // Two hosted runs are live and the cap is one, yet the scheduler still
    // admits its own prospector.
    expect(prospectors).toHaveLength(1);
  });
});

describe("restarting from the document", () => {
  it("restarts at once after a compaction, naming the last run and carrying its undelivered messages", async () => {
    // Fake timers hold the sweep the ending schedules, so the one run below is
    // the only restart.
    vi.useFakeTimers();
    const t = await setup();
    const first = await start(t);
    // The daemon delivers the opener, as it does on the run's first turn.
    const opener1 = await t.run(async (ctx) =>
      (await ctx.db.query("claudeInbound").withIndex("by_session_status", (q) => q.eq("sessionId", first as Id<"claudeSessions">).eq("status", "pending")).unique())!,
    );
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId: first as Id<"claudeSessions">,
      status: "running",
      runId: "codex:box:thread-1",
      inboundUpdates: [{ id: opener1._id, status: "delivered" }],
    });
    await pen(t, "/tts/orchestrator/document", { sessionId: first, document: "# v2\n\nCarry on with the footer." });
    const worker = await spawn(t, first);
    // One message arrives during the last turn, before the ending settles it,
    // and one between the two runs; the successor receives both.
    await pen(t, "/tts/message", { sessionId: worker, to: "orchestrator", text: "Tests are green." });
    await ingest(t, first, { status: "ended", endedReason: COMPACT_ENDED_REASON, outcome: "completed" });
    await pen(t, "/tts/message", { sessionId: worker, to: "orchestrator", text: "Footer done." });

    await t.mutation(internal.orchestrator.internalSweep, {});
    const next = (await row(t))!;
    expect(next.liveSessionId).not.toBe(first);
    expect(next.crashes).toBe(0);
    const session = await t.run(async (ctx) => ctx.db.get(next.liveSessionId!));
    expect(session?.continuesRunId).toBe("codex:box:thread-1");
    const opener = (await pendingTexts(t, next.liveSessionId!))[0];
    expect(opener).toContain("Carry on with the footer.");
    expect(opener).toContain("Footer done.");
    expect(opener).toContain("Tests are green.");
    // The first run's own opener was delivered to it and is not carried.
    expect(opener.split("Why this run started").length).toBe(2);
    expect(opener).toContain(worker);
    const hosted = await t.run(async (ctx) => ctx.db.query("hostedRuns").withIndex("by_session", (q) => q.eq("sessionId", next.liveSessionId!)).unique());
    expect(hosted?.environment).toBe("orchestrator");
  });

  it("carries a message whose turn crashed to the next run, and the start instruction to every run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
    const t = await setup();
    const first = await start(t, "Spawn one worker on the footer.");
    const worker = await spawn(t, first);
    await pen(t, "/tts/message", { sessionId: worker, to: "orchestrator", text: "PR 1 is open." });
    const [opener, message] = await t.run(async (ctx) =>
      (await ctx.db.query("claudeInbound").withIndex("by_session_status", (q) => q.eq("sessionId", first as Id<"claudeSessions">)).collect()).sort((a, b) => a.createdAt - b.createdAt),
    );
    // The opener's turn finished; the message's turn was delivered and its
    // result failed, which the daemon still settles as done.
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId: first as Id<"claudeSessions">,
      status: "running",
      inboundUpdates: [{ id: opener._id, status: "delivered" }, { id: opener._id, status: "done" }],
    });
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId: first as Id<"claudeSessions">,
      inboundUpdates: [{ id: message._id, status: "delivered" }],
    });
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId: first as Id<"claudeSessions">,
      status: "ended",
      endedReason: "autonomous turn failed",
      inboundUpdates: [{ id: message._id, status: "done" }],
    });
    vi.setSystemTime(Date.now() + crashBackoffMs(1) + 1);
    await t.mutation(internal.orchestrator.internalSweep, {});
    const next = (await row(t))!.liveSessionId!;
    const text = (await pendingTexts(t, next))[0];
    expect(text).toContain("PR 1 is open.");
    expect(text).toContain("Spawn one worker on the footer.");
    expect(text.split("Why this run started").length).toBe(2);

    // The next run crashes during that very opener: the message is carried
    // again, not lost.
    await ingest(t, next, { status: "running", runId: "codex:box:n" });
    await ingest(t, next, { status: "ended", endedReason: "autonomous turn failed" });
    vi.setSystemTime(Date.now() + crashBackoffMs(2) + 1);
    await t.mutation(internal.orchestrator.internalSweep, {});
    const third = (await row(t))!.liveSessionId!;
    expect(third).not.toBe(next);
    expect((await pendingTexts(t, third))[0]).toContain("PR 1 is open.");

    // Once a run finishes its opener (here it goes on to compact), what it
    // carried is not carried again. A run that crashes straight after its
    // opener carries them once more: that turn may have failed.
    const opener3 = await t.run(async (ctx) =>
      (await ctx.db.query("claudeInbound").withIndex("by_session_status", (q) => q.eq("sessionId", third).eq("status", "pending")).unique())!,
    );
    await t.mutation(internal.claudeSessions.internalIngest, {
      sessionId: third,
      status: "running",
      runId: "codex:box:third",
      inboundUpdates: [{ id: opener3._id, status: "delivered" }, { id: opener3._id, status: "done" }],
    });
    await ingest(t, third, { status: "ended", endedReason: COMPACT_ENDED_REASON });
    await t.mutation(internal.orchestrator.internalSweep, {});
    const fourth = (await row(t))!.liveSessionId!;
    expect((await pendingTexts(t, fourth))[0]).not.toContain("PR 1 is open.");
  });

  it("waits out the backoff after a crash, then restarts; the third crash in a row is reported", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
    const t = await setup();
    let live = await start(t);
    for (let crash = 1; crash <= ORCHESTRATOR_CRASHES_REPORTED; crash += 1) {
      await ingest(t, live, { status: "running", runId: `codex:box:t${crash}` });
      await ingest(t, live, { status: "ended", endedReason: "autonomous turn failed", outcome: "errored" });
      expect((await row(t))?.crashes).toBe(crash);
      await t.mutation(internal.orchestrator.internalSweep, {});
      expect((await row(t))?.liveSessionId).toBe(live);
      vi.setSystemTime(Date.now() + crashBackoffMs(crash) + 1);
      await t.mutation(internal.orchestrator.internalSweep, {});
      const restarted = (await row(t))!.liveSessionId!;
      expect(restarted).not.toBe(live);
      const session = await t.run(async (ctx) => ctx.db.get(restarted));
      expect(session?.continuesRunId).toBe(`codex:box:t${crash}`);
      live = restarted;
    }
    const broken = await t.run(async (ctx) => ctx.db.query("dtsEvents").withIndex("by_kind_at", (q) => q.eq("kind", "orchestrator-restart-failed")).collect());
    expect(broken).toHaveLength(1);
  });

  it("goes on in a new run when Tom reopens its current one, and leaves his conversation alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
    const t = await setup();
    const first = await start(t);
    const worker = await spawn(t, first);
    await ingest(t, first, { status: "running", runId: "codex:box:r" });
    await ingest(t, first, { status: "ended", endedReason: "autonomous turn failed" });
    // Inside the crash backoff, Tom reopens the run to ask it something.
    await t.mutation(internal.claudeSessions.internalReopenSession, { sessionId: first as Id<"claudeSessions">, text: "What happened?" });
    expect((await pen(t, "/tts/message", { sessionId: worker, to: "orchestrator", text: "for the orchestrator" })).body.delivered).toBe(false);
    // A stop while Tom holds it leaves his conversation alone.
    await t.mutation(internal.orchestrator.internalStop, { reason: "check" });
    expect((await t.run(async (ctx) => ctx.db.get(first as Id<"claudeSessions">)))?.status).not.toBe("ended");
    await t.mutation(internal.orchestrator.internalStart, { reason: "again" });
    const next = (await row(t))!.liveSessionId!;
    expect(next).not.toBe(first);
    const reopened = await t.run(async (ctx) => ctx.db.get(first as Id<"claudeSessions">));
    expect(reopened?.status).not.toBe("failed");
    expect((await pendingTexts(t, first)).some((m) => m === "for the orchestrator")).toBe(false);
    // Tom's own question to the reopened run is his conversation's, untouched.
    const his = await t.run(async (ctx) =>
      (await ctx.db.query("claudeInbound").withIndex("by_session_status", (q) => q.eq("sessionId", first as Id<"claudeSessions">)).collect()).filter((m) => m.text === "What happened?"),
    );
    expect(his.map((m) => m.status)).toEqual(["pending"]);
    // It waited for the next run, whose opener carries it.
    expect((await pendingTexts(t, next))[0]).toContain("for the orchestrator");
    expect((await pen(t, "/tts/answer", { sessionId: first, elevationId: "x", kind: "obvious", answer: "y" })).status).toBe(409);
  });

  it("does not count a daemon restart as a crash, and a run that stays up clears the count", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
    const t = await setup();
    const first = await start(t);
    await ingest(t, first, { status: "running", runId: "codex:box:a" });
    await ingest(t, first, { status: "ended", endedReason: "autonomous turn failed" });
    expect((await row(t))?.crashes).toBe(1);
    vi.setSystemTime(Date.now() + crashBackoffMs(1) + 1);
    await t.mutation(internal.orchestrator.internalSweep, {});
    const second = (await row(t))!.liveSessionId!;
    await ingest(t, second, { status: "running", runId: "codex:box:b" });
    await ingest(t, second, { status: "ended", endedReason: "daemon restarted mid-mission" });
    expect((await row(t))?.crashes).toBe(1);
    await t.mutation(internal.orchestrator.internalSweep, {});
    const third = (await row(t))!.liveSessionId!;
    expect(third).not.toBe(second);
    await ingest(t, third, { status: "idle", runId: "codex:box:c" });
    vi.setSystemTime(Date.now() + ORCHESTRATOR_STABLE_MS);
    await poll(t, { hosts: HOSTS, held: [third] });
    expect((await row(t))?.crashes).toBe(0);
  });

  it("restarts a claimed run whose lease ran out, and renews the lease while the daemon holds it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
    const t = await setup();
    const first = await start(t);
    // Requested and unclaimed: waiting for a daemon, never restarted.
    vi.setSystemTime(Date.now() + ORCHESTRATOR_LEASE_MS + 1);
    await t.mutation(internal.orchestrator.internalSweep, {});
    expect((await row(t))?.liveSessionId).toBe(first);

    await ingest(t, first, { status: "idle", runId: "codex:box:held" });
    await poll(t, { hosts: HOSTS, held: [first] });
    // Two crashes already behind it: the expiry is the third, and says so.
    await t.run(async (ctx) => ctx.db.patch((await ctx.db.query("orchestrators").first())!._id, { crashes: 2 }));
    const renewed = (await row(t))!.leaseDeadline!;
    expect(renewed).toBeGreaterThan(Date.now());
    vi.setSystemTime(renewed + 1);
    await poll(t, { hosts: HOSTS, held: [] });
    await t.mutation(internal.orchestrator.internalSweep, {});
    const next = (await row(t))!;
    expect(next.liveSessionId).not.toBe(first);
    const old = await t.run(async (ctx) => ctx.db.get(first as Id<"claudeSessions">));
    expect(old?.status).toBe("failed");
    // Its never-delivered opener is settled, so a later reopen cannot replay it.
    expect(await pendingTexts(t, first)).toEqual([]);
    const broken = await t.run(async (ctx) => ctx.db.query("dtsEvents").withIndex("by_kind_at", (q) => q.eq("kind", "orchestrator-restart-failed")).collect());
    expect(broken).toHaveLength(1);
    const session = await t.run(async (ctx) => ctx.db.get(next.liveSessionId!));
    expect(session?.continuesRunId).toBe("codex:box:held");
  });

  it("tells the orchestrator when a worker ends, and a stop restarts nothing", async () => {
    const t = await setup();
    const orchestrator = await start(t);
    const worker = await spawn(t, orchestrator);
    await ingest(t, worker, { status: "running" });
    await pen(t, "/tts/session-outcome", { sessionId: worker, outcome: "completed", summary: "footer fixed in PR 1" });
    expect((await poll(t, { hosts: HOSTS })).sessions.find((s) => s.id === worker)?.outcomeRecorded).toBe(true);
    // Accepted in the moment before the worker ends, and never read by it.
    await pen(t, "/tts/message", { sessionId: orchestrator, to: worker, text: "Also fix the header." });
    await ingest(t, worker, { status: "ended", endedReason: "worker run complete" });
    const note = (await pendingTexts(t, orchestrator)).find((m) => m.includes(`Worker ${worker}`));
    expect(note).toContain("footer fixed in PR 1");
    expect(note).toContain("These messages never reached it");
    expect(note).toContain("Also fix the header.");

    const stopped = await t.mutation(internal.orchestrator.internalStop, { reason: "the proof is over" });
    expect(stopped.stopped).toBe(true);
    const session = await t.run(async (ctx) => ctx.db.get(orchestrator as Id<"claudeSessions">));
    expect(session?.status).toBe("ended");
    expect((await t.mutation(internal.orchestrator.internalSweep, {})).restarted).toBe(false);
    expect((await pen(t, "/tts/spawn-worker", { sessionId: orchestrator, title: "x", brief: "y" })).status).toBe(409);
  });
});
