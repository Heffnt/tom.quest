import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import {
  EXPORT_PAGE_BYTES,
  EXPORT_PAGE_DEFAULT,
  EXPORT_TABLES,
  LEARNING_INPUT_MAX,
  LEARNING_REPLY_CHARS,
} from "./ttsNightly";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

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

describe("EXPORT_TABLES", () => {
  // The six auth tables hold credentials and session secrets; the copy in
  // WikiTom must never carry them. Everything else in the schema is copied,
  // without a hand-kept list to forget a new table on.
  it("is every schema table except the auth ones", () => {
    const all = Object.keys(schema.tables);
    const auth = all.filter((n) => n.startsWith("auth"));
    expect(auth.length).toBe(6);
    expect(EXPORT_TABLES).toEqual(all.filter((n) => !n.startsWith("auth")).sort());
    expect(EXPORT_TABLES).toContain("dtsTodos");
    expect(EXPORT_TABLES).toContain("claudeMessages");
    expect(EXPORT_TABLES).toContain("ttsSkills");
    for (const name of EXPORT_TABLES) expect(name.startsWith("auth")).toBe(false);
  });
});

describe("GET /tts/export", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists the tables when none is named", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const res = await get(t, "/tts/export");
    expect(res.status).toBe(200);
    expect((await res.json()).tables).toEqual(EXPORT_TABLES);
  });

  it("pages a table in creation order up to the boundary", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const ids = await t.run(async (ctx) => {
      const out = [];
      for (const kind of ["a", "b", "c", "d", "e"]) {
        out.push(await ctx.db.insert("dtsEvents", { at: 1, kind }));
      }
      return out;
    });
    const boundary = Date.now() + 60_000;
    const first = await get(t, `/tts/export?table=dtsEvents&boundary=${boundary}&numItems=2`);
    expect(first.status).toBe(200);
    const p1 = await first.json();
    expect(p1.rows.map((r: { _id: string }) => r._id)).toEqual(ids.slice(0, 2));
    expect(p1.isDone).toBe(false);
    const rest = await get(
      t,
      `/tts/export?table=dtsEvents&boundary=${boundary}&numItems=10&cursor=${encodeURIComponent(p1.continueCursor)}`,
    );
    const p2 = await rest.json();
    expect(p2.rows.map((r: { _id: string }) => r._id)).toEqual(ids.slice(2));
    expect(p2.isDone).toBe(true);
    // The whole row rides — the copy is the record, not a projection.
    expect(p2.rows[0].kind).toBe("c");
    expect(typeof p2.rows[0]._creationTime).toBe("number");
  });

  // witness: without the boundary a row written mid-walk lands in a later
  // page of an earlier instant, and the copy is of no single moment.
  it("leaves out rows created after the boundary", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => ctx.db.insert("dtsEvents", { at: 1, kind: "old" }));
    const boundary = (
      await t.run(async (ctx) => ctx.db.query("dtsEvents").collect())
    )[0]._creationTime;
    await t.run(async (ctx) => ctx.db.insert("dtsEvents", { at: 1, kind: "new" }));
    // boundary = the old row's own creation time: strictly-before excludes it
    // too, so "just after" it admits exactly the old row.
    const res = await get(t, `/tts/export?table=dtsEvents&boundary=${boundary + 0.5}`);
    const page = await res.json();
    expect(page.rows.map((r: { kind: string }) => r.kind)).toEqual(["old"]);
  });

  it("refuses the auth tables, an unknown table, a bad boundary, and a wrong key", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    expect((await get(t, "/tts/export?table=authSessions&boundary=5")).status).toBe(400);
    expect((await get(t, "/tts/export?table=nope&boundary=5")).status).toBe(400);
    expect((await get(t, "/tts/export?table=dtsTodos")).status).toBe(400);
    expect((await get(t, "/tts/export?table=dtsTodos&boundary=5&numItems=0")).status).toBe(400);
    expect((await get(t, "/tts/export?table=dtsTodos&boundary=5", "nope")).status).toBe(401);
  });

  it("defaults the page size", () => {
    expect(EXPORT_PAGE_DEFAULT).toBe(200);
  });

  // witness: bounded by rows alone, 200 rows of a big-row table (claudeMessages
  // at the daemon's 32KB cut, claudeMessageOverflow at 256KB a chunk) is tens
  // of megabytes in one query — past the read budget, so that table has no copy
  // at all, every night, while the small tables look fine.
  it("ends a page at its byte budget, and the pages still cover the table in order", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const body = "x".repeat(300 * 1024); // a big row, of the shape that breaks it
    const ids = await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("claudeSessions", {
        title: "big",
        kind: "adhoc",
        repo: "none",
        repos: [],
        status: "ended",
        statusChangedAt: 1,
        nextSeq: 1,
        createdAt: 1,
      });
      const out = [];
      for (let i = 0; i < 12; i++) {
        out.push(
          await ctx.db.insert("claudeMessages", {
            sessionId,
            seq: i,
            turn: 1,
            kind: "tool-result",
            content: { text: body },
            createdAt: 1,
          }),
        );
      }
      return out;
    });
    const boundary = Date.now() + 60_000;
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const url = `/tts/export?table=claudeMessages&boundary=${boundary}&numItems=200${
        cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`
      }`;
      const page: {
        rows: { _id: string }[];
        bytes: number;
        isDone: boolean;
        continueCursor: string;
      } = await (await get(t, url)).json();
      pages += 1;
      expect(page.rows.length).toBeGreaterThan(0);
      expect(page.bytes).toBeLessThanOrEqual(EXPORT_PAGE_BYTES);
      for (const row of page.rows) seen.push(row._id);
      if (page.isDone) break;
      expect(page.continueCursor).not.toBe(cursor);
      cursor = page.continueCursor;
      expect(pages).toBeLessThan(20); // a walk that cannot end is the other bug
    }
    // 12 rows of ~300KB against a 2 MiB budget: more than one page, and every
    // row exactly once, in creation order.
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(ids);
  });

  it("gives one row its own page when the row alone exceeds the budget", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      for (const size of [EXPORT_PAGE_BYTES + 1024, 10]) {
        await ctx.db.insert("dtsEvents", { at: 1, kind: "big", data: { body: "y".repeat(size) } });
      }
    });
    const boundary = Date.now() + 60_000;
    const first = await (await get(t, `/tts/export?table=dtsEvents&boundary=${boundary}`)).json();
    expect(first.rows).toHaveLength(1);
    expect(first.bytes).toBeGreaterThan(EXPORT_PAGE_BYTES);
    expect(first.isDone).toBe(false);
    const rest = await (
      await get(
        t,
        `/tts/export?table=dtsEvents&boundary=${boundary}&cursor=${encodeURIComponent(first.continueCursor)}`,
      )
    ).json();
    expect(rest.rows).toHaveLength(1);
    expect(rest.isDone).toBe(true);
  });

  it("refuses a cursor it did not write", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const res = await get(t, `/tts/export?table=dtsEvents&boundary=${Date.now()}&cursor=nonsense`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cursor/);
  });
});

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

  // The Slack bookkeeping kinds carry a `key` the events route looks up by;
  // a worker row of those kinds without one would be a phantom send.
  it("refuses a kind Convex writes itself, and a malformed kind", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    expect((await post(t, "/tts/event", { kind: "slack-sent" })).status).toBe(400);
    expect((await post(t, "/tts/event", { kind: "Nightly Run" })).status).toBe(400);
    expect((await post(t, "/tts/event", { data: {} })).status).toBe(400);
    expect(await t.run(async (ctx) => ctx.db.query("dtsEvents").collect())).toEqual([]);
  });
});

describe("GET /tts/learning-input", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns Tom's turns, his Slack replies and his rulings in the window, and nothing an agent wrote", async () => {
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
      await ctx.db.insert("dtsEvents", {
        at: now,
        kind: "slack-event",
        key: "Ev1",
        todoId,
        data: { text: "done", outcome: "completed" },
      });
      await ctx.db.insert("dtsEvents", { at: now, kind: "surfaced", todoId });
      await ctx.db.insert("dtsRulings", {
        subjectType: "life",
        todoId,
        verdict: "revise",
        sentence: "ask for a shorter term",
        ruledAt: now,
        provenance: { from: "tom-words", inboundId: "x", quote: "ask for a shorter term" },
      });
      // Outside the window: yesterday's ruling belongs to yesterday's run.
      await ctx.db.insert("dtsRulings", {
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
    expect(input.slackReplies).toHaveLength(1);
    expect(input.slackReplies[0].data.text).toBe("done");
    expect(input.rulings.map((r: { verdict: string }) => r.verdict)).toEqual(["revise"]);
    expect(input.rulings[0].quote).toBe("ask for a shorter term");
  });

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
      });
      const say = (seq: number, at: number, text: string) =>
        ctx.db.insert("claudeMessages", {
          sessionId,
          seq,
          turn: seq,
          kind: "assistant-text",
          content: { text },
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
      return { objectionId, consumedId };
    });
    const input = await (await get(t, `/tts/learning-input?until=${now}`)).json();
    expect(input.objections).toEqual([
      { eventId: objectionId, at: now - 10_000, id: "0123456789ab", text: "no" },
    ]);
    expect(input.changes).toHaveLength(1);
    expect(input.changes[0]).toMatchObject({ id: "0123456789ab", file: "model-of-tom/areas/climbing.md", after: "- a line" });

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
  it("finds Tom's turn and his Slack reply behind more rows than the cap", async () => {
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
      const todoId = await ctx.db.insert("dtsTodos", {
        statement: "x",
        readiness: "unprepared",
        status: "active",
        timingClass: "whenever",
        source: "test",
        createdAt: now,
        updatedAt: now,
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
        await ctx.db.insert("dtsEvents", { at: now, kind: "surfaced", todoId });
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
      await ctx.db.insert("dtsEvents", {
        at: now,
        kind: "slack-event",
        key: "Ev9",
        todoId,
        data: { text: "not that one" },
      });
    });
    const res = await get(t, `/tts/learning-input?since=${now - 3_600_000}&until=${now + 3_600_000}`);
    const input = await res.json();
    expect(input.tomTurns.map((x: { text: string }) => x.text)).toEqual(["do the lease first"]);
    expect(input.slackReplies.map((x: { data: { text: string } }) => x.data.text)).toEqual([
      "not that one",
    ]);
  }, 120_000);

  it("refuses a missing or inverted window", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    expect((await get(t, "/tts/learning-input")).status).toBe(400);
    expect((await get(t, "/tts/learning-input?since=5&until=4")).status).toBe(400);
  });
});
