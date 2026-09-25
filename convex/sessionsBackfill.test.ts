import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { DAEMON_ROWS_REPLACED } from "./ttsMigrations";

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

async function backfillList(t: SchemaTest, cursor: string | null = null, key: string | null = KEY) {
  const query = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return await t.fetch(`/sessions/backfill-list${query}`, {
    method: "GET",
    headers: key === null ? {} : { "X-Sessions-Key": key },
  });
}

beforeEach(() => {
  vi.stubEnv("SESSIONS_WORKER_KEY", KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /sessions/backfill-list", () => {
  it("lists the sessions whose rows are still the daemon's, with each one's run and SDK id", async () => {
    const t = schemaTest();
    const old = await session(t, { runId: "claude:box:sdk-old", sdkSessionId: "sdk-old" });
    const codex = await session(t, { runId: "claude:box:019a-thread", rowsFrom: "daemon" });
    await session(t, { runId: "claude:box:sdk-new", sdkSessionId: "sdk-new", rowsFrom: "runs" });
    await session(t, { status: "failed" }); // no runId: it names no file
    const response = await backfillList(t);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessions: [
        { sessionId: old, runId: "claude:box:sdk-old", sdkSessionId: "sdk-old" },
        { sessionId: codex, runId: "claude:box:019a-thread", sdkSessionId: null },
      ],
      cursor: null,
    });
  });

  it("pages with a cursor until the cursor is null", async () => {
    const t = schemaTest();
    await t.run(async (ctx) => {
      for (let index = 0; index < 205; index += 1) {
        await ctx.db.insert("claudeSessions", {
          title: `old ${index}`, kind: "adhoc", repo: "none", status: "ended",
          statusChangedAt: 1, nextSeq: 0, createdAt: 1, runId: `claude:box:sdk-${index}`,
        } as never);
      }
    });
    const first = await (await backfillList(t)).json();
    expect(first.sessions).toHaveLength(200);
    expect(typeof first.cursor).toBe("string");
    const second = await (await backfillList(t, first.cursor)).json();
    expect(second.sessions).toHaveLength(5);
    expect(second.cursor).toBeNull();
    const runIds = new Set([...first.sessions, ...second.sessions].map((entry: { runId: string }) => entry.runId));
    expect(runIds.size).toBe(205);
  });

  it("refuses a caller without the sessions key", async () => {
    const t = schemaTest();
    expect((await backfillList(t, null, null)).status).toBe(401);
    expect((await backfillList(t, null, "wrong")).status).toBe(401);
  });
});

// ── The one-off: a session's daemon rows replaced by its file's ─────────────

const HASH = "a".repeat(64);

async function runWithRows(t: SchemaTest, runId: string, rows: number[]) {
  await t.run(async (ctx) => {
    await ctx.db.insert("runs", {
      runId, rootRunId: runId, depth: 0, linkKnown: true, origin: "unknown", host: "box", cli: "claude",
      environment: "session", parserVersion: "runs-parser-1", kind: "session", status: "ended", startedAt: 1, lastLineAt: 2,
      attachments: [], ingestedAt: 3,
      file: { path: `/f/${runId}.jsonl`, sourceHash: HASH, storedHash: HASH, bytes: 10, storedBytes: 8, committedLine: rows.length, committedPrefixSha256: HASH },
    } as never);
    for (const seq of rows) {
      await ctx.db.insert("claudeMessages", {
        runId, seq, turn: 0, kind: "assistant-text", content: { text: `file row ${seq}` }, depth: 0, digest: "0123456789abcdef", createdAt: seq,
      } as never);
    }
  });
}

async function daemonRows(t: SchemaTest, sessionId: Id<"claudeSessions">, count: number, overflowAt?: { seq: number; chunks: number }) {
  await t.run(async (ctx) => {
    for (let seq = 0; seq < count; seq += 1) {
      const stamped = overflowAt?.seq === seq;
      await ctx.db.insert("claudeMessages", {
        sessionId, seq, turn: 0, kind: "tool-result", content: { text: `daemon row ${seq}` }, createdAt: seq,
        ...(stamped ? { overflow: { sha256: HASH, byteLength: 10, chunkCount: overflowAt.chunks } } : {}),
      } as never);
      if (stamped) {
        for (let index = 0; index < overflowAt.chunks; index += 1) {
          await ctx.db.insert("claudeMessageOverflow", { sessionId, seq, index, chunkCount: overflowAt.chunks, text: `chunk ${index}`, createdAt: 1 } as never);
        }
      }
    }
  });
}

async function held(t: SchemaTest, sessionId: Id<"claudeSessions">) {
  return await t.run(async (ctx) => ({
    rows: (await ctx.db.query("claudeMessages").withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId)).collect()).length,
    chunks: (await ctx.db.query("claudeMessageOverflow").withIndex("by_session_seq_index", (q) => q.eq("sessionId", sessionId)).collect()).length,
  }));
}

async function replaceEvent(t: SchemaTest, kind: string) {
  const rows = await t.run(async (ctx) => (await ctx.db.query("dtsEvents").collect()).filter((row) => row.kind === kind));
  expect(rows).toHaveLength(1);
  return rows[0].data as Record<string, unknown>;
}

/** Five sessions, one of each kind the walk meets, and three reply labels. */
async function seedOldSessions(t: SchemaTest) {
  const replaced = await session(t, { runId: "claude:box:replaced" });
  await daemonRows(t, replaced, 250, { seq: 3, chunks: 10 });
  // A chunk whose row never landed: it goes with the session's other chunks.
  await t.run((ctx) => ctx.db.insert("claudeMessageOverflow", { sessionId: replaced, seq: 999, index: 0, chunkCount: 2, text: "orphan", createdAt: 1 } as never));
  await runWithRows(t, "claude:box:replaced", [100, 200]);

  const notSwept = await session(t, { runId: "claude:box:not-swept" });
  await daemonRows(t, notSwept, 2);
  const noRows = await session(t, { runId: "claude:box:index-only" });
  await daemonRows(t, noRows, 2);
  await runWithRows(t, "claude:box:index-only", []);

  const fileLess = await session(t, { status: "failed", endedReason: "spawn failed" });
  await daemonRows(t, fileLess, 1);

  const born = await session(t, { runId: "claude:box:born-today", rowsFrom: "runs" });
  await runWithRows(t, "claude:box:born-today", [100]);

  const label = (ref: string, rowSpan?: { seqStart: number; seqEnd: number }) => t.run((ctx) => ctx.db.insert("runLabels", {
    runId: "claude:box:replaced", source: "session-reply", actor: "tom", polarity: "neutral", meaning: "his words",
    judgment: false, ref, at: 5, ...(rowSpan === undefined ? {} : { rowSpan }),
  } as never));
  const oldSpan = await label(`reply:${replaced}:7`, { seqStart: 5, seqEnd: 7 });
  const oldNoSpan = await label(`reply:${replaced}:9`);
  const newSpan = await label("reply:k17inboundrow", { seqStart: 100, seqEnd: 200 });
  return { replaced, notSwept, noRows, fileLess, born, oldSpan, oldNoSpan, newSpan };
}

describe("ttsMigrations.internalReplaceDaemonRows", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts on a dry run and changes nothing", async () => {
    vi.useFakeTimers();
    const t = schemaTest();
    const seeded = await seedOldSessions(t);
    await t.mutation(internal.ttsMigrations.internalReplaceDaemonRows, { dryRun: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await replaceEvent(t, `${DAEMON_ROWS_REPLACED}-dry-run`)).toEqual({
      scanned: 5, sessions: 1, fileLess: 1, rows: 251, chunks: 11, labels: 1, noRowsCount: 2,
      noRows: [seeded.notSwept, seeded.noRows],
    });
    expect(await held(t, seeded.replaced)).toEqual({ rows: 250, chunks: 11 });
    expect(await held(t, seeded.fileLess)).toEqual({ rows: 1, chunks: 0 });
    expect((await t.run((ctx) => ctx.db.get(seeded.replaced)))?.rowsFrom).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(seeded.oldSpan)))?.rowSpan).toEqual({ seqStart: 5, seqEnd: 7 });
  });

  it("replaces a session's rows, lists the ones whose run has no rows, and empties the file-less ones", async () => {
    vi.useFakeTimers();
    const t = schemaTest();
    const seeded = await seedOldSessions(t);
    await t.mutation(internal.ttsMigrations.internalReplaceDaemonRows, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await replaceEvent(t, DAEMON_ROWS_REPLACED)).toEqual({
      scanned: 5, sessions: 1, fileLess: 1, rows: 251, chunks: 11, labels: 1, noRowsCount: 2,
      noRows: [seeded.notSwept, seeded.noRows],
    });
    // The replaced session reads its file's rows, and holds no daemon row or chunk.
    expect(await t.run((ctx) => ctx.db.get(seeded.replaced))).toMatchObject({ rowsFrom: "runs" });
    expect(await held(t, seeded.replaced)).toEqual({ rows: 0, chunks: 0 });
    const fileRows = await t.run((ctx) => ctx.db.query("claudeMessages").withIndex("by_run_seq", (q) => q.eq("runId", "claude:box:replaced")).collect());
    expect(fileRows.map((row) => row.seq)).toEqual([100, 200]);
    // A session whose file is not in the record keeps everything.
    expect(await held(t, seeded.notSwept)).toEqual({ rows: 2, chunks: 0 });
    expect(await held(t, seeded.noRows)).toEqual({ rows: 2, chunks: 0 });
    expect((await t.run((ctx) => ctx.db.get(seeded.notSwept)))?.rowsFrom).toBeUndefined();
    // The file-less session loses its one row and keeps what it says of itself.
    expect(await held(t, seeded.fileLess)).toEqual({ rows: 0, chunks: 0 });
    expect(await t.run((ctx) => ctx.db.get(seeded.fileLess))).toMatchObject({ status: "failed", endedReason: "spawn failed" });
    // A session born reading its file is left alone.
    expect(await t.run((ctx) => ctx.db.get(seeded.born))).toMatchObject({ rowsFrom: "runs" });
    // The old writer's span is dropped; the label and the new writer's span stay.
    const [oldSpan, oldNoSpan, newSpan] = await t.run(async (ctx) => [
      await ctx.db.get(seeded.oldSpan), await ctx.db.get(seeded.oldNoSpan), await ctx.db.get(seeded.newSpan),
    ]);
    expect(oldSpan).toMatchObject({ ref: `reply:${seeded.replaced}:7`, meaning: "his words" });
    expect(oldSpan?.rowSpan).toBeUndefined();
    expect(oldNoSpan?.rowSpan).toBeUndefined();
    expect(newSpan?.rowSpan).toEqual({ seqStart: 100, seqEnd: 200 });

    // Run again, it finds nothing left to replace.
    await t.mutation(internal.ttsMigrations.internalReplaceDaemonRows, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const again = await t.run(async (ctx) => (await ctx.db.query("dtsEvents").collect()).filter((row) => row.kind === DAEMON_ROWS_REPLACED));
    expect(again[1].data).toMatchObject({ sessions: 0, fileLess: 0, rows: 0, chunks: 0, labels: 0, noRowsCount: 2 });
  });

  // witness: delete a row before its chunks, and a step that stops between
  // the two leaves chunks no row names, under an index part C drops.
  it("deletes every chunk of a session before any of its rows", async () => {
    vi.useFakeTimers();
    const t = schemaTest();
    const sessionId = await session(t, { runId: "claude:box:ordered" });
    await daemonRows(t, sessionId, 250, { seq: 0, chunks: 20 });
    await runWithRows(t, "claude:box:ordered", [100]);
    await t.mutation(internal.ttsMigrations.internalReplaceDaemonRows, {});
    const seen: Array<{ rows: number; chunks: number }> = [];
    for (let step = 0; step < 50; step += 1) {
      vi.runOnlyPendingTimers();
      await t.finishInProgressScheduledFunctions();
      const now = await held(t, sessionId);
      seen.push(now);
      if (now.rows < 250) expect(now.chunks).toBe(0);
      if (now.rows === 0) break;
    }
    // The chunks went a bounded number at a time, then the rows.
    expect(seen.some((entry) => entry.chunks > 0 && entry.chunks < 20)).toBe(true);
    expect(seen.at(-1)).toEqual({ rows: 0, chunks: 0 });
  });
});
