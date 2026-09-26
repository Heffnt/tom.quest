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

  it("is job-ok when the task returns no failure", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("TTS_ICS_FEEDS", "");
    expect(await t.action(internal.jarvis.tick.runTask, { name: "calendar" })).toEqual({ ok: true });
    expect((await outcomes(t)).map((row) => row.kind)).toEqual(["job-ok"]);
  });
});
