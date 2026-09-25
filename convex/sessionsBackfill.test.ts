import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const KEY = "test-sessions-key";

type SchemaTest = ReturnType<typeof convexTest>;

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
    const t = convexTest(schema, modules);
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
    const t = convexTest(schema, modules);
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
    const t = convexTest(schema, modules);
    expect((await backfillList(t, null, null)).status).toBe(401);
    expect((await backfillList(t, null, "wrong")).status).toBe(401);
  });
});
