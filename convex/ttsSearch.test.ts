import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function insertTodo(
  t: ReturnType<typeof convexTest>,
  statement: string,
  overrides: Partial<{ status: "active" | "waiting" | "archived" | "done"; category: string }> = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("dtsTodos", {
      statement,
      readiness: "unprepared",
      status: overrides.status ?? "active",
      timingClass: "whenever",
      source: "test",
      category: overrides.category,
      createdAt: 100,
      updatedAt: 200,
    }),
  );
}

function shapedGithubToken(letter: string): string {
  return `gho_${letter.repeat(36)}`;
}

describe("TTS search queries", () => {
  it("finds rulings through their todo statement, orders newest first, and redacts prose", async () => {
    const t = convexTest({ schema, modules });
    const todoId = await insertTodo(t, "Replace the cluster credential helper");
    const token = shapedGithubToken("A");
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsRulings", {
        subjectType: "life",
        todoId,
        verdict: "revise",
        sentence: `older credential note ${token}`,
        ruledAt: 10,
      });
      await ctx.db.insert("dtsRulings", {
        subjectType: "life",
        todoId,
        verdict: "approve",
        sentence: `newer credential note ${token}`,
        provenance: {
          from: "tom-words",
          inboundId: "inbound_1",
          quote: `say ${token}`,
        },
        ruledAt: 20,
      });
    });

    const response = await t.query(internal.ttsSearch.rulings, {
      query: "cluster credential",
      limit: 20,
    });
    const { results } = response;

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.date)).toEqual([20, 10]);
    expect(response).toMatchObject({
      scanned: 2,
      exhausted: true,
      scanLimitReached: false,
      oldestScannedAt: new Date(10).toISOString(),
    });
    expect(results[0]).toMatchObject({
      verdict: "approve",
      todoStatement: "Replace the cluster credential helper",
      sentence: "newer credential note [redacted:github]",
      provenance: { quote: "say [redacted:github]" },
    });
    expect(JSON.stringify(results)).not.toContain(token);
  });

  it("finds sessions by displayed text, filters repos case-insensitively, and returns the UI deep link", async () => {
    const t = convexTest({ schema, modules });
    const ids = await t.run(async (ctx) => ({
      wanted: await ctx.db.insert("claudeSessions", {
        title: "Investigate worker queue",
        kind: "adhoc",
        repo: "none",
        repos: ["tom.quest"],
        status: "ended",
        statusChangedAt: 20,
        nextSeq: 0,
        createdAt: 30,
      }),
      other: await ctx.db.insert("claudeSessions", {
        title: "Investigate worker queue",
        kind: "adhoc",
        repo: "WikiTom",
        status: "ended",
        statusChangedAt: 30,
        nextSeq: 0,
        createdAt: 20,
      }),
    }));

    const response = await t.query(internal.ttsSearch.sessions, {
      query: "WORKER",
      repo: "TOM.QUEST",
      since: 25,
      limit: 20,
    });
    const { results } = response;

    expect(results).toEqual([
      expect.objectContaining({
        id: ids.wanted,
        repos: ["tom.quest"],
        date: 30,
        url: `https://tom.quest/sessions?session=${ids.wanted}`,
      }),
    ]);
  });

  it("flattens event data and related todo text without returning an unredacted credential", async () => {
    const t = convexTest({ schema, modules });
    const todoId = await insertTodo(t, "Review the admission queue");
    const token = shapedGithubToken("B");
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: 123,
        kind: "queue-cycle",
        todoId,
        data: { nested: ["the agent noted", { detail: `credential ${token}` }] },
      });
    });

    const response = await t.query(internal.ttsSearch.events, {
      query: "admission queue",
      limit: 20,
    });
    const { results } = response;

    expect(results).toEqual([
      expect.objectContaining({
        kind: "queue-cycle",
        date: 123,
        text: expect.stringContaining("Review the admission queue"),
      }),
    ]);
    expect(results[0].text).toContain("[redacted:github]");
    expect(results[0].text).not.toContain(token);
  });

  it("returns a query-centered, bounded excerpt for a long event payload", async () => {
    const t = convexTest({ schema, modules });
    const needle = "needle in the middle";
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: 456,
        kind: "long-payload",
        data: { detail: `${"a".repeat(8_000)} ${needle} ${"z".repeat(8_000)}` },
      });
    });

    const response = await t.query(internal.ttsSearch.events, {
      query: needle,
      limit: 20,
    });
    const { results } = response;

    expect(results).toHaveLength(1);
    expect(results[0].text).toContain(needle);
    expect(results[0].text.length).toBeLessThanOrEqual(240);
  });

  it("matches todos by statement, applies an exact case-insensitive status, and clamps the result count", async () => {
    const t = convexTest({ schema, modules });
    await insertTodo(t, "First bounded search todo", { status: "active", category: "ops" });
    await insertTodo(t, "Second bounded search todo", { status: "active" });
    await insertTodo(t, "Waiting bounded search todo", { status: "waiting" });

    const active = await t.query(internal.ttsSearch.todos, {
      query: "BOUNDED SEARCH TODO",
      status: "ACTIVE",
      limit: 0,
    });
    const unknown = await t.query(internal.ttsSearch.todos, {
      query: "bounded search todo",
      status: "missing",
      limit: 20,
    });

    expect(active.results).toHaveLength(1);
    expect(active.results[0]).toMatchObject({ status: "active", createdAt: 100, updatedAt: 200 });
    expect(unknown.results).toEqual([]);
  });

  it("scans past an initial run of nonmatches and reports the exhausted index range", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      for (let at = 2; at <= 30; at += 1) {
        await ctx.db.insert("dtsEvents", { at, kind: "unrelated" });
      }
      await ctx.db.insert("dtsEvents", { at: 1, kind: "needle event" });
    });

    const response = await t.query(internal.ttsSearch.events, {
      query: "needle",
      limit: 2,
    });

    expect(response.results).toHaveLength(1);
    expect(response).toMatchObject({
      scanned: 30,
      exhausted: true,
      scanLimitReached: false,
      oldestScannedAt: new Date(1).toISOString(),
    });
  });

  it("reports when the documented hard scan cap, rather than exhaustion, stopped the search", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      for (let at = 1; at <= 2_001; at += 1) {
        await ctx.db.insert("dtsEvents", { at, kind: "unrelated" });
      }
    });

    const response = await t.query(internal.ttsSearch.events, {
      query: "needle",
      limit: 1,
    });

    expect(response).toMatchObject({
      results: [],
      scanned: 2_000,
      exhausted: false,
      scanLimitReached: true,
      oldestScannedAt: new Date(2).toISOString(),
    });
  });
});

describe("GET /tts/search", () => {
  afterEach(() => vi.unstubAllEnvs());

  const routes = ["rulings", "sessions", "events", "todos"] as const;

  it.each(routes)("rejects a wrong worker key for %s", async (route) => {
    vi.stubEnv("TTS_WORKER_KEY", "search-key");
    const t = convexTest({ schema, modules });
    const denied = await t.fetch(`/tts/search/${route}?query=searchable`, {
      method: "GET",
      headers: { "X-TTS-Key": "wrong" },
    });
    expect(denied.status).toBe(401);
  });

  it.each(routes)("reports an unconfigured worker key for %s", async (route) => {
    vi.stubEnv("TTS_WORKER_KEY", "");
    const t = convexTest({ schema, modules });
    const missing = await t.fetch(`/tts/search/${route}?query=searchable`, {
      method: "GET",
      headers: { "X-TTS-Key": "search-key" },
    });
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ error: "TTS_WORKER_KEY not configured" });
  });

  it.each(routes)("accepts the 1 and 200 result limits for %s", async (route) => {
    vi.stubEnv("TTS_WORKER_KEY", "search-key");
    const t = convexTest({ schema, modules });
    for (const limit of [1, 200]) {
      const response = await t.fetch(`/tts/search/${route}?query=searchable&limit=${limit}`, {
        method: "GET",
        headers: { "X-TTS-Key": "search-key" },
      });
      expect(response.status).toBe(200);
    }
  });

  it.each(routes)("rejects result limits outside 1 through 200 for %s", async (route) => {
    vi.stubEnv("TTS_WORKER_KEY", "search-key");
    const t = convexTest({ schema, modules });
    for (const limit of [0, 201]) {
      const response = await t.fetch(`/tts/search/${route}?query=searchable&limit=${limit}`, {
        method: "GET",
        headers: { "X-TTS-Key": "search-key" },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "limit (integer from 1 to 200) required" });
    }
  });

  it.each(routes)("accepts valid and rejects malformed since values for %s", async (route) => {
    vi.stubEnv("TTS_WORKER_KEY", "search-key");
    const t = convexTest({ schema, modules });
    const valid = await t.fetch(`/tts/search/${route}?query=searchable&since=2026-09-01`, {
      method: "GET",
      headers: { "X-TTS-Key": "search-key" },
    });
    expect(valid.status).toBe(200);

    const malformed = await t.fetch(`/tts/search/${route}?query=searchable&since=2026-09-31`, {
      method: "GET",
      headers: { "X-TTS-Key": "search-key" },
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "since (YYYY-MM-DD) required" });
  });

  it("returns redacted results with scan metadata at the route boundary", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "search-key");
    const t = convexTest({ schema, modules });
    const token = shapedGithubToken("C");
    await insertTodo(t, `Searchable todo ${token}`);

    const response = await t.fetch("/tts/search/todos?query=searchable", {
      method: "GET",
      headers: { "X-TTS-Key": "search-key" },
    });
    const body = await response.json();
    expect(body).toMatchObject({
      results: [expect.objectContaining({ statement: "Searchable todo [redacted:github]" })],
      scanned: 1,
      exhausted: true,
      scanLimitReached: false,
      oldestScannedAt: new Date(200).toISOString(),
    });
    expect(JSON.stringify(body)).not.toContain(token);
  });
});
