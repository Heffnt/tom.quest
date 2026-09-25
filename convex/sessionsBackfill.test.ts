import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { RETIRED_FIELD_CLEARED, SESSION_ROW_FIELDS_MIGRATION } from "./ttsMigrations";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const KEY = "test-sessions-key";

const schemaTest = () => convexTest(schema, modules);
type SchemaTest = ReturnType<typeof schemaTest>;

async function session(t: SchemaTest, overrides: Record<string, unknown> = {}) {
  return await t.run((ctx) => ctx.db.insert("claudeSessions", {
    title: "an old session", kind: "adhoc", repo: "none", status: "ended",
    statusChangedAt: 1, nextSeq: 0, createdAt: 1, ...overrides,
  } as never));
}

beforeEach(() => {
  vi.stubEnv("SESSIONS_WORKER_KEY", KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// The box's one-off backfill pass reads this until the Jarvis change that
// deletes its flag has deployed. Every session's rows are its file's now.
describe("GET /sessions/backfill-list", () => {
  it("answers that no session is left, and only to the sessions key", async () => {
    const t = schemaTest();
    await session(t, { runId: "claude:box:sdk-old", sdkSessionId: "sdk-old" });
    const ask = (key: string | null) => t.fetch("/sessions/backfill-list", {
      method: "GET",
      headers: key === null ? {} : { "X-Sessions-Key": key },
    });
    const response = await ask(KEY);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessions: [], cursor: null });
    expect((await ask(null)).status).toBe(401);
    expect((await ask("wrong")).status).toBe(401);
  });
});

// ── The clearing walk before the narrow ─────────────────────────────────────

const HASH = "a".repeat(64);

async function run(t: SchemaTest, runId: string, overrides: Record<string, unknown> = {}) {
  await t.run((ctx) => ctx.db.insert("runs", {
    runId, rootRunId: runId, depth: 0, linkKnown: true, origin: "unknown", host: "box", cli: "claude",
    environment: "session", parserVersion: "runs-parser-1", kind: "session", status: "ended", startedAt: 1, lastLineAt: 2,
    attachments: [], ingestedAt: 3,
    file: { path: `/f/${runId}.jsonl`, sourceHash: HASH, storedHash: HASH, bytes: 10, storedBytes: 8, committedLine: 1, committedPrefixSha256: HASH },
    ...overrides,
  } as never));
}

/** One of each shape the walk meets. */
async function seed(t: SchemaTest) {
  const fromRuns = await session(t, { runId: "claude:box:from-runs", rowsFrom: "runs" });
  const fromDaemon = await session(t, { runId: "claude:box:not-swept", rowsFrom: "daemon" });
  const neither = await session(t, { runId: "claude:box:born-today" });
  await run(t, "claude:box:from-runs", { cutoverAt: 1_700 });
  await run(t, "claude:box:born-today");
  await t.run(async (ctx) => {
    // A daemon row and chunk the replacement left: their session's file never landed.
    await ctx.db.insert("claudeMessages", { sessionId: fromDaemon, seq: 0, turn: 0, kind: "assistant-text", content: { text: "kept" }, createdAt: 1 });
    await ctx.db.insert("claudeMessageOverflow", { sessionId: fromDaemon, seq: 0, index: 0, chunkCount: 1, text: "kept", createdAt: 1 });
    // A file row and chunk, which hold no sessionId and are not the walk's.
    await ctx.db.insert("claudeMessages", { runId: "claude:box:from-runs", seq: 0, turn: 0, kind: "assistant-text", content: { text: "file" }, depth: 0, createdAt: 1 });
    await ctx.db.insert("claudeMessageOverflow", { runId: "claude:box:from-runs", seq: 0, index: 0, chunkCount: 1, text: "file", createdAt: 1 });
  });
  return { fromRuns, fromDaemon, neither };
}

async function events(t: SchemaTest, kind: string) {
  return await t.run(async (ctx) => (await ctx.db.query("dtsEvents").collect()).filter((row) => row.kind === kind));
}

async function walk(t: SchemaTest, args: { dryRun?: boolean; pageSize?: number } = {}) {
  await t.mutation(internal.ttsMigrations.internalClearSessionRowFields, args);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

const FOUND = {
  "claudeSessions-scanned": 3,
  "runs-scanned": 2,
  "rowsFrom-runs-cleared": 1,
  "rowsFrom-other-cleared": 1,
  "cutoverAt-cleared": 1,
  "daemon-rows-left": 1,
  "daemon-chunks-left": 1,
};

describe("ttsMigrations.internalClearSessionRowFields", () => {
  it("counts on a dry run and changes nothing", async () => {
    vi.useFakeTimers();
    const t = schemaTest();
    const seeded = await seed(t);
    await walk(t, { dryRun: true, pageSize: 1 });
    const [dry] = await events(t, `${SESSION_ROW_FIELDS_MIGRATION}-dry-run`);
    expect(dry.data).toEqual({ ...FOUND, sessionsWithDaemonRows: [seeded.fromDaemon] });
    expect((await t.run((ctx) => ctx.db.get(seeded.fromDaemon)))?.rowsFrom).toBe("daemon");
    expect(await events(t, RETIRED_FIELD_CLEARED)).toEqual([]);
  });

  // witness: leave a field on one stored document and the narrow's deploy
  // fails validating it.
  it("clears rowsFrom and cutoverAt, records what says something, and leaves the daemon's rows counted", async () => {
    vi.useFakeTimers();
    const t = schemaTest();
    const seeded = await seed(t);
    await walk(t, { pageSize: 1 });
    const [done] = await events(t, SESSION_ROW_FIELDS_MIGRATION);
    expect(done.data).toEqual({ ...FOUND, sessionsWithDaemonRows: [seeded.fromDaemon] });

    const [sessions, runs] = await t.run(async (ctx) => [
      await ctx.db.query("claudeSessions").collect(),
      await ctx.db.query("runs").collect(),
    ]);
    expect(sessions.map((row) => row.rowsFrom)).toEqual([undefined, undefined, undefined]);
    expect(runs.map((row) => row.cutoverAt)).toEqual([undefined, undefined]);
    // "runs" is how every session reads now, so only the other two values are recorded.
    const recorded = (await events(t, RETIRED_FIELD_CLEARED)).map((row) => row.data);
    expect(recorded).toEqual([
      { table: "claudeSessions", field: "rowsFrom", value: "daemon", sessionId: seeded.fromDaemon },
      { table: "runs", field: "cutoverAt", value: 1_700, runId: "claude:box:from-runs" },
    ]);
    // Nothing of the daemon's is emptied or deleted: the narrow waits on them.
    const held = await t.run(async (ctx) => ({
      rows: await ctx.db.query("claudeMessages").collect(),
      chunks: await ctx.db.query("claudeMessageOverflow").collect(),
    }));
    expect(held.rows.map((row) => row.sessionId ?? row.runId)).toEqual([seeded.fromDaemon, "claude:box:from-runs"]);
    expect(held.chunks.map((row) => row.sessionId ?? row.runId)).toEqual([seeded.fromDaemon, "claude:box:from-runs"]);

    // Run again, it clears nothing and still counts what the narrow waits on.
    await walk(t);
    const again = await events(t, SESSION_ROW_FIELDS_MIGRATION);
    expect(again[1].data).toMatchObject({
      "rowsFrom-runs-cleared": 0, "rowsFrom-other-cleared": 0, "cutoverAt-cleared": 0,
      "daemon-rows-left": 1, "daemon-chunks-left": 1,
    });
  });

  it("reports zero left once no stored row holds a sessionId", async () => {
    vi.useFakeTimers();
    const t = schemaTest();
    const sessionId: Id<"claudeSessions"> = await session(t, { runId: "claude:box:clean" });
    await t.run((ctx) => ctx.db.insert("claudeMessages", { runId: "claude:box:clean", seq: 0, turn: 0, kind: "user", content: { text: "hi" }, depth: 0, createdAt: 1 }));
    await walk(t);
    const [done] = await events(t, SESSION_ROW_FIELDS_MIGRATION);
    expect(done.data).toMatchObject({ "daemon-rows-left": 0, "daemon-chunks-left": 0, sessionsWithDaemonRows: [] });
    expect((await t.run((ctx) => ctx.db.get(sessionId)))?.runId).toBe("claude:box:clean");
  });
});
