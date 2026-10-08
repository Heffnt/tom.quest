import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import {
  LEARNING_INPUT_MAX,
  LEARNING_REPLY_CHARS,
} from "./ttsNightly";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

/** What worker/agents/ingest.mjs stamps on every row; every claudeMessages row has one. */
const ROW_PROVENANCE = { fileVersion: "f".repeat(64), file: "/agent.jsonl", lineStart: 1, lineEnd: 1, block: 0, parserVersion: "runs-parser-2", sourceKind: "fixture" };

const KEY = "s3cret";

function get(t: ReturnType<typeof convexTest>, path: string, key = KEY) {
  return t.fetch(path, { method: "GET", headers: { "X-TTS-Key": key } });
}

function post(t: ReturnType<typeof convexTest>, path: string, body: unknown, key = KEY) {
  return t.fetch(path, {
    method: "POST",
    headers: { "X-TTS-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /tts/event", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes one dtsEvents row with the kind and data", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const res = await post(t, "/tts/event", {
      kind: "nightly-failure",
      data: { step: "push", error: "rejected" },
    });
    expect(res.status).toBe(200);
    const rows = await t.run(async (ctx) => ctx.db.query("dtsEvents").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("nightly-failure");
    expect(rows[0].data).toEqual({ step: "push", error: "rejected" });
    expect(rows[0].at).toBeGreaterThan(0);
  });

  // Convex-owned kinds cannot be posted through the generic worker route.
  it("refuses a kind Convex writes itself, and a malformed kind", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    expect((await post(t, "/tts/event", { kind: "thread-reply", data: {} })).status).toBe(400);
    expect((await post(t, "/tts/event", { kind: "Nightly Run" })).status).toBe(400);
    expect((await post(t, "/tts/event", { data: {} })).status).toBe(400);
    expect(await t.run(async (ctx) => ctx.db.query("dtsEvents").collect())).toEqual([]);
  });
});

describe("internalApplyRepoProposal", () => {
  it("applying a proposal also leaves one events row of kind repo-proposal-applied", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: Date.now(),
        kind: "repo-proposal",
        key: "proposal-1",
        data: {
          id: "proposal-1",
          repo: "tom.quest",
          file: "app/AGENTS.md",
          section: "style",
          line: "A commit subject is lowercase.",
        },
      });
    });
    const result = await t.mutation(internal.ttsNightly.internalApplyRepoProposal, {
      id: "proposal-1",
      commit: "deadbeef",
    });
    expect(result).toMatchObject({ applied: true, repo: "tom.quest", file: "app/AGENTS.md" });
    const events = await t.run(async (ctx) =>
      ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "repo-proposal-applied")).collect(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "repo-proposal-applied",
      subject: "proposal-1",
      data: { repo: "tom.quest", file: "app/AGENTS.md", appliedLine: "A commit subject is lowercase.", commit: "deadbeef" },
    });
  });
});

describe("GET /tts/learning-input", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns Tom's turns and his rulings in the window, and nothing an agent wrote", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const now = Date.now();
    await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("claudeSessions", {
        title: "the lease",
        kind: "adhoc",
        repo: "none",
        repos: [],
        status: "ended",
        statusChangedAt: now,
        nextSeq: 3,
        createdAt: now,
        sdkSessionId: "47f04bc9-1111-4222-8333-444444444444",
      });
      const turn = (author: "tom" | "agent", text: string) =>
        ctx.db.insert("claudeInbound", {
          sessionId,
          kind: "user-turn",
          text,
          author,
          status: "done",
          createdAt: now,
        });
      await turn("tom", "sign it Friday");
      await turn("agent", "the code-built opener");
      const todoId = await ctx.db.insert("dtsTodos", {
        statement: "sign the lease",
        readiness: "unprepared",
        status: "active",
        timingClass: "whenever",
        source: "test",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("rulings", {
        subjectType: "life",
        todoId,
        verdict: "revise",
        sentence: "ask for a shorter term",
        ruledAt: now,
        provenance: { from: "tom-words", inboundId: "x", quote: "ask for a shorter term" },
      });
      // Outside the window: yesterday's ruling belongs to yesterday's run.
      await ctx.db.insert("rulings", {
        subjectType: "life",
        todoId,
        verdict: "approve",
        ruledAt: now - 3 * 86_400_000,
      });
    });
    const res = await get(t, `/tts/learning-input?since=${now - 3_600_000}&until=${now + 3_600_000}`);
    expect(res.status).toBe(200);
    const input = await res.json();
    expect(input.tomTurns.map((x: { text: string }) => x.text)).toEqual(["sign it Friday"]);
    expect(input.tomTurns[0].sessionTitle).toBe("the lease");
    // The SDK session id rides each turn: the pages cite its 8-hex prefix.
    expect(input.tomTurns[0].sdkSessionId).toBe("47f04bc9-1111-4222-8333-444444444444");
    expect(input.rulings.map((r: { verdict: string }) => r.verdict)).toEqual(["revise"]);
    expect(input.rulings[0].quote).toBe("ask for a shorter term");
  });

  // witness: read the reply context by anything but the session's runId and
  // the learning run sees every one of Tom's turns with nothing around it.
  it("carries the agent's text on either side of each of Tom's turns", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const now = Date.now();
    await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("claudeSessions", {
        title: "the lease",
        kind: "adhoc",
        repo: "none",
        repos: [],
        status: "ended",
        statusChangedAt: now,
        nextSeq: 5,
        createdAt: now,
        // Its rows are its agent file's, under the run it names.
        runId: "claude:box:the-lease",
      });
      const say = (seq: number, at: number, text: string) =>
        ctx.db.insert("claudeMessages", {
          runId: "claude:box:the-lease",
          seq,
          turn: seq,
          kind: "assistant-text",
          content: { text },
          depth: 0,
          provenance: ROW_PROVENANCE,
          createdAt: at,
        });
      await say(1, now - 3000, "an earlier answer");
      await say(2, now - 1000, "Which lease?");
      await ctx.db.insert("claudeInbound", {
        sessionId,
        kind: "user-turn",
        text: "the apartment one",
        author: "tom",
        status: "done",
        createdAt: now,
      });
      await say(3, now + 1000, `Noted. ${"x".repeat(2000)}`);
      await say(4, now + 3000, "a later answer");
    });
    const res = await get(t, `/tts/learning-input?since=${now - 3_600_000}&until=${now + 3_600_000}`);
    const input = await res.json();
    expect(input.tomTurns).toHaveLength(1);
    // A session the SDK never reported an id for carries null, not a
    // missing field.
    expect(input.tomTurns[0].sdkSessionId).toBeNull();
    expect(input.tomTurns[0].replyBefore).toBe("Which lease?");
    expect(input.tomTurns[0].replyAfter.startsWith("Noted. xxx")).toBe(true);
    expect(input.tomTurns[0].replyAfter.length).toBe(LEARNING_REPLY_CHARS + 1);
    expect(input.tomTurns[0].replyAfter.endsWith("…")).toBe(true);
  });

  it("starts where the last learning run stopped when since is not given", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const until = Date.now();
    // No run on record: the day before.
    const first = await (await get(t, `/tts/learning-input?until=${until}`)).json();
    expect(first.sinceSource).toBe("default");
    expect(first.since).toBe(until - 86_400_000);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: until - 50_000_000,
        kind: "learning-run",
        data: { until: until - 40_000_000, changes: 0 },
      });
      await ctx.db.insert("dtsEvents", {
        at: until - 30_000_000,
        kind: "learning-run",
        data: { until: until - 20_000_000, changes: 1 },
      });
    });
    const next = await (await get(t, `/tts/learning-input?until=${until}`)).json();
    expect(next.sinceSource).toBe("learning-run");
    expect(next.since).toBe(until - 20_000_000);
    const given = await (await get(t, `/tts/learning-input?since=${until - 5}&until=${until}`)).json();
    expect(given).toMatchObject({ since: until - 5, sinceSource: "given" });
  });

  it("returns the objections not yet consumed with the recent changes, and the consumed door stamps them", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const now = Date.now();
    const { objectionId, consumedId } = await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: now - 90_000_000,
        kind: "learning-change",
        data: { id: "0123456789ab", file: "model-of-tom/areas/climbing.md", before: "", after: "- a line" },
      });
      const objectionId = await ctx.db.insert("dtsEvents", {
        at: now - 10_000,
        kind: "learning-objection",
        data: { id: "0123456789ab", text: "no" },
      });
      const consumedId = await ctx.db.insert("dtsEvents", {
        at: now - 20_000,
        kind: "learning-objection",
        data: { id: "0123456789ab", text: "an earlier no" },
        consumedAt: now - 15_000,
      });
      // A revert rides along under `changes`, newest first, with its kind:
      // its resultBlob is what the job checks the page against.
      await ctx.db.insert("dtsEvents", {
        at: now - 80_000_000,
        kind: "learning-reverted",
        data: { id: "fedcba987654", file: "model-of-tom/areas/climbing.md", before: "- b", after: "", resultBlob: "abc" },
      });
      return { objectionId, consumedId };
    });
    const input = await (await get(t, `/tts/learning-input?until=${now}`)).json();
    expect(input.objections).toEqual([
      { eventId: objectionId, at: now - 10_000, id: "0123456789ab", text: "no" },
    ]);
    expect(input.changes).toHaveLength(2);
    expect(input.changes[0]).toMatchObject({ eventKind: "learning-reverted", id: "fedcba987654", resultBlob: "abc" });
    expect(input.changes[1]).toMatchObject({ eventKind: "learning-change", id: "0123456789ab", file: "model-of-tom/areas/climbing.md", after: "- a line" });

    const res = await post(t, "/tts/learning-objections-consumed", { ids: [objectionId, consumedId, "not-an-id"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, consumed: 1 });
    const again = await (await get(t, `/tts/learning-input?until=${now}`)).json();
    expect(again.objections).toEqual([]);
    expect((await post(t, "/tts/learning-objections-consumed", { ids: "x" })).status).toBe(400);
  });

  // witness: the reads used to take 2000 rows off a time index and filter
  // afterwards, so a day with more than 2000 agent turns — an ordinary day —
  // returned none of Tom's, and the learning step would have learned nothing
  // while reporting a clean run.
  it("finds Tom's turn behind more rows than the cap", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const now = Date.now();
    await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("claudeSessions", {
        title: "a long day",
        kind: "adhoc",
        repo: "none",
        repos: [],
        status: "running",
        statusChangedAt: now,
        nextSeq: 1,
        createdAt: now,
      });
      for (let i = 0; i < LEARNING_INPUT_MAX + 1; i++) {
        await ctx.db.insert("claudeInbound", {
          sessionId,
          kind: "user-turn",
          text: `agent ${i}`,
          author: "agent",
          status: "done",
          createdAt: now,
        });
      }
      // Tom's, last: behind every one of them.
      await ctx.db.insert("claudeInbound", {
        sessionId,
        kind: "user-turn",
        text: "do the lease first",
        author: "tom",
        status: "done",
        createdAt: now,
      });
    });
    const res = await get(t, `/tts/learning-input?since=${now - 3_600_000}&until=${now + 3_600_000}`);
    const input = await res.json();
    expect(input.tomTurns.map((x: { text: string }) => x.text)).toEqual(["do the lease first"]);
  }, 120_000);

  // Tom's ruling 2026-09-25: a therapy session owns the mental-health page
  // itself, so neither learning pass reads it. The therapy row here names a
  // repo on purpose, written straight to the table past insertSession's
  // refusal, so the repo pass drops it by its kind and not by its "none".
  it("leaves therapy sessions out of both learning passes", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const now = Date.now();
    await t.run(async (ctx) => {
      const session = (title: string, kind: "adhoc" | "therapy") =>
        ctx.db.insert("claudeSessions", {
          title,
          kind,
          repo: "tom.quest",
          repos: ["tom.quest"],
          status: "ended",
          statusChangedAt: now,
          outcome: "completed",
          outcomeSummary: `${title} ended`,
          nextSeq: 1,
          createdAt: now,
        });
      for (const [title, kind, text] of [
        ["the site", "adhoc", "ship the page"],
        ["therapy", "therapy", "a therapy turn"],
      ] as const) {
        const sessionId = await session(title, kind);
        await ctx.db.insert("claudeInbound", {
          sessionId,
          kind: "user-turn",
          text,
          author: "tom",
          status: "done",
          createdAt: now,
        });
      }
    });
    const res = await get(t, `/tts/learning-input?since=${now - 3_600_000}&until=${now + 3_600_000}`);
    expect(res.status).toBe(200);
    const input = await res.json();
    expect(input.tomTurns.map((x: { text: string }) => x.text)).toEqual(["ship the page"]);
    expect(input.repoSessions.map((x: { title: string }) => x.title)).toEqual(["the site"]);
  });

  it("refuses a missing or inverted window", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    expect((await get(t, "/tts/learning-input")).status).toBe(400);
    expect((await get(t, "/tts/learning-input?since=5&until=4")).status).toBe(400);
  });
});
