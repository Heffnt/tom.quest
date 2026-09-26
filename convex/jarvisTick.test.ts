import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

// From the convex root, as every other test: convex-test names modules by
// their path under convex/, so a glob from a subdirectory finds none of them.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const outcomes = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) =>
    (await ctx.db.query("events").collect()).filter((row) => row.kind === "job-ok" || row.kind === "job-failed"),
  );

// witness: runTask wrote job-ok whenever the action resolved, and the
// calendar refresh catches a feed's failure and resolves, so a feed that had
// stopped answering read as a clean run and never reached the digest.
describe("a tick task's outcome", () => {
  it("is job-failed when the calendar refresh returns a feed's failure", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("TTS_ICS_FEEDS", JSON.stringify([{ name: "work", url: "https://calendar.invalid/work.ics" }]));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 503 })));
    expect(await t.action(internal.jarvis.tick.runTask, { name: "calendar" })).toEqual({ ok: false });
    const rows = await outcomes(t);
    expect(rows.map((row) => row.kind)).toEqual(["job-failed"]);
    expect(rows[0].subject).toBe("tick:calendar");
    expect(String((rows[0].data as { error?: unknown }).error)).toContain('calendar feed "work" failed: HTTP 503');
  });

  it("is job-failed when the code mirror returns a repository's failure", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("GITHUB_MIRROR_TOKEN", "t");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    expect(await t.action(internal.jarvis.tick.runTask, { name: "code-mirror" })).toEqual({ ok: false });
    expect((await outcomes(t)).map((row) => row.kind)).toEqual(["job-failed"]);
  });

  it("is job-failed when the pull-request mirror could not read a repository", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("GITHUB_MIRROR_TOKEN", "t");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 502 })));
    expect(await t.action(internal.jarvis.tick.runTask, { name: "pull-requests" })).toEqual({ ok: false });
    const rows = await outcomes(t);
    expect(rows.map((row) => row.kind)).toEqual(["job-failed"]);
    expect(String((rows[0].data as { error?: unknown }).error)).toContain("pull requests could not be read (502)");
  });

  it("is job-ok when the task returns no failure", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("TTS_ICS_FEEDS", "");
    expect(await t.action(internal.jarvis.tick.runTask, { name: "calendar" })).toEqual({ ok: true });
    expect((await outcomes(t)).map((row) => row.kind)).toEqual(["job-ok"]);
  });
});

// witness: repeats ran every 30 minutes through the 4 a.m. hour, so rules the
// calendar skipped wrote their skip twice, and it could start in the same
// tick as the calendar refresh whose rows it reads.
describe("the repeats task", () => {
  // 2026-09-28 is in EDT: New York is UTC-4.
  const nyAt = (hhmm: string, day = "2026-09-28") => Date.parse(`${day}T${hhmm}:00-04:00`);
  const clean = (t: ReturnType<typeof convexTest>, name: string, at: number) =>
    t.run(async (ctx) => {
      await ctx.db.insert("events", { kind: "job-ok", at, provenance: { job: `tick:${name}` }, subject: `tick:${name}`, data: {} });
    });
  const started = async (t: ReturnType<typeof convexTest>, at: number) => {
    vi.setSystemTime(at);
    return (await t.mutation(internal.jarvis.tick.due, {})).started;
  };

  it("comes due once a day at 4:30 New York, never in the tick that starts the calendar, and not again after a clean run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t = convexTest({ schema, modules });
      expect(await started(t, nyAt("04:15"))).not.toContain("repeats");
      // The first tick at 4:30 starts the calendar refresh, so not repeats.
      const first = await started(t, nyAt("04:30"));
      expect(first).toContain("calendar");
      expect(first).not.toContain("repeats");
      await clean(t, "calendar", nyAt("04:30"));
      expect(await started(t, nyAt("04:31"))).toContain("repeats");
      await clean(t, "repeats", nyAt("04:31"));
      expect(await started(t, nyAt("04:45"))).not.toContain("repeats");
      expect(await started(t, nyAt("05:30"))).not.toContain("repeats");
      await clean(t, "calendar", nyAt("04:30", "2026-09-29"));
      expect(await started(t, nyAt("04:31", "2026-09-29"))).toContain("repeats");
    } finally {
      vi.useRealTimers();
    }
  });
});

