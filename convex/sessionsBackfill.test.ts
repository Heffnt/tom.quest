import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";

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
