import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { gatherTodayFacts } from "./ttsDigest";
import { DAY_MS, nyCalendarDayKey } from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const KEY = "s3cret";

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

  it("puts a nightly failure in the digest's broken section, which comes through this door and not logEvent, and posts nothing", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    await post(t, "/tts/event", {
      kind: "nightly-failure",
      data: { step: "push", error: "rejected" },
    });
    // One output channel: nothing is scheduled for Slack. The digest reads the
    // row itself (convex/ttsDigest.ts gatherTodayFacts, every failure kind).
    const slack = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.name.includes("ttsSync")),
    );
    expect(slack).toEqual([]);
    const broken = await t.run(async (ctx) => {
      const now = Date.now() + 1;
      return (await gatherTodayFacts(ctx, { day: nyCalendarDayKey(now), now, since: now - DAY_MS })).broken;
    });
    expect(broken).toHaveLength(1);
    expect(broken[0].statement).toContain("nightly");
    expect(broken[0]).toMatchObject({ detail: "rejected", count: 1 });
  });

  // The Slack bookkeeping kinds carry a `key` the events route looks up by;
  // a worker row of those kinds without one would be a phantom send.
  it("refuses a kind Convex writes itself, and a malformed kind", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    expect((await post(t, "/tts/event", { kind: "slack-sent" })).status).toBe(400);
    expect((await post(t, "/tts/event", { kind: "thread-reply", data: {} })).status).toBe(400);
    expect((await post(t, "/tts/event", { kind: "Nightly Run" })).status).toBe(400);
    expect((await post(t, "/tts/event", { data: {} })).status).toBe(400);
    expect(await t.run(async (ctx) => ctx.db.query("dtsEvents").collect())).toEqual([]);
  });
});
