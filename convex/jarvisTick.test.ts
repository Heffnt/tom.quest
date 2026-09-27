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

// The lease `due` writes before it schedules a run; runTask removes it.
const lease = (t: ReturnType<typeof convexTest>, name: string, at = Date.now()) =>
  t.run(async (ctx) =>
    ctx.db.insert("events", {
      kind: "tick-started",
      at,
      provenance: { job: `tick:${name}` },
      subject: `tick:${name}`,
      data: { task: name, timeoutMs: 1 },
    }),
  );

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
    expect(await t.action(internal.jarvis.tick.runTask, { name: "calendar", leaseId: await lease(t, "calendar") })).toEqual({ ok: false });
    const rows = await outcomes(t);
    expect(rows.map((row) => row.kind)).toEqual(["job-failed"]);
    expect(rows[0].subject).toBe("tick:calendar");
    expect(String((rows[0].data as { error?: unknown }).error)).toContain('calendar feed "work" failed: HTTP 503');
  });

  it("is job-failed when the code mirror returns a repository's failure", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("GITHUB_MIRROR_TOKEN", "t");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    expect(await t.action(internal.jarvis.tick.runTask, { name: "code-mirror", leaseId: await lease(t, "code-mirror") })).toEqual({ ok: false });
    expect((await outcomes(t)).map((row) => row.kind)).toEqual(["job-failed"]);
  });

  it("is job-failed when the pull-request mirror could not read a repository", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("GITHUB_MIRROR_TOKEN", "t");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 502 })));
    expect(await t.action(internal.jarvis.tick.runTask, { name: "pull-requests", leaseId: await lease(t, "pull-requests") })).toEqual({ ok: false });
    const rows = await outcomes(t);
    expect(rows.map((row) => row.kind)).toEqual(["job-failed"]);
    expect(String((rows[0].data as { error?: unknown }).error)).toContain("pull requests could not be read (502)");
  });

  it("is job-failed with the credential name when the pull-request mirror has no GitHub credential", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("GITHUB_MIRROR_TOKEN", "");
    expect(await t.action(internal.jarvis.tick.runTask, { name: "pull-requests", leaseId: await lease(t, "pull-requests") })).toEqual({ ok: false });
    const rows = await outcomes(t);
    expect(rows.map((row) => row.kind)).toEqual(["job-failed"]);
    expect((rows[0].data as { error?: unknown }).error).toBe("observe: GITHUB_MIRROR_TOKEN is not set");
  });

  it("is job-ok when the task returns no failure", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("TTS_ICS_FEEDS", "");
    expect(await t.action(internal.jarvis.tick.runTask, { name: "calendar", leaseId: await lease(t, "calendar") })).toEqual({ ok: true });
    expect((await outcomes(t)).map((row) => row.kind)).toEqual(["job-ok"]);
  });
});

// witness: repeats ran every 30 minutes through the 4 a.m. hour, so rules the
// calendar skipped wrote their skip twice, and it could start in the same
// tick as the calendar refresh whose rows it reads.
describe("the daily tasks: repeats and eviction", () => {
  // 2026-09-28 is in EDT: New York is UTC-4.
  const nyAt = (hhmm: string, day = "2026-09-28") => Date.parse(`${day}T${hhmm}:00-04:00`);
  const clean = (t: ReturnType<typeof convexTest>, name: string, at: number) =>
    t.run(async (ctx) => {
      await ctx.db.insert("events", { kind: "job-ok", at, provenance: { job: `tick:${name}` }, subject: `tick:${name}`, data: {} });
    });
  // `due` schedules each started task; this suite asks only what is due, so
  // the scheduled runs are cancelled before they start (a run finishing after
  // the test's backend is gone is an unhandled rejection).
  const started = async (t: ReturnType<typeof convexTest>, at: number) => {
    vi.setSystemTime(at);
    const answer = (await t.mutation(internal.jarvis.tick.due, {})).started;
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
    return answer;
  };

  it("deletes completed tick leases while keeping success and failure outcomes", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("TTS_ICS_FEEDS", "");
    const successLease = await t.run(async (ctx) =>
      ctx.db.insert("events", {
        kind: "tick-started",
        at: 1,
        provenance: { job: "tick:calendar" },
        subject: "tick:calendar",
        data: { task: "calendar", timeoutMs: 1 },
      }),
    );
    expect(await t.action(internal.jarvis.tick.runTask, { name: "calendar", leaseId: successLease })).toEqual({ ok: true });

    vi.stubEnv("GITHUB_MIRROR_TOKEN", "");
    const failureLease = await t.run(async (ctx) =>
      ctx.db.insert("events", {
        kind: "tick-started",
        at: 2,
        provenance: { job: "tick:pull-requests" },
        subject: "tick:pull-requests",
        data: { task: "pull-requests", timeoutMs: 1 },
      }),
    );
    expect(await t.action(internal.jarvis.tick.runTask, { name: "pull-requests", leaseId: failureLease })).toEqual({ ok: false });

    const rows = await t.run(async (ctx) => ctx.db.query("events").collect());
    expect(rows.filter((row) => row.kind === "tick-started")).toEqual([]);
    expect(rows.filter((row) => row.kind === "job-ok" && row.subject === "tick:calendar")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "job-failed" && row.subject === "tick:pull-requests")).toHaveLength(1);
  });

  // witness: a task wrote no row until it finished, so the next minute's
  // tick queued a second copy while the first scheduled action was still live.
  it("keeps a slow task single across ticks, then retries its dead start", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t = convexTest({ schema, modules });
      const first = nyAt("01:00");
      expect(await started(t, first)).toContain("turing-health");
      expect(await started(t, first + 60_000)).not.toContain("turing-health");
      // An action cannot still be alive past its ten-minute execution limit.
      expect(await started(t, first + 10 * 60_000 + 1)).toContain("turing-health");
      const marks = await t.run(async (ctx) =>
        (await ctx.db.query("events").collect()).filter(
          (row) => row.kind === "tick-started" && row.subject === "tick:turing-health",
        ),
      );
      expect(marks).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

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
      // witness: a box down through the 4 a.m. hour skipped the day; the
      // task is due at any hour after 4:30 until it has run clean that day.
      await clean(t, "calendar", nyAt("07:00", "2026-09-29"));
      expect(await started(t, nyAt("07:10", "2026-09-29"))).toContain("repeats");
      await clean(t, "calendar", nyAt("04:30", "2026-09-30"));
      expect(await started(t, nyAt("04:15", "2026-09-30"))).not.toContain("repeats");
      expect(await started(t, nyAt("04:31", "2026-09-30"))).toContain("repeats");
    } finally {
      vi.useRealTimers();
    }
  });

  // witness: repeats waited only for a calendar refresh started in the same
  // tick, so one still running from an earlier tick let repeats read the
  // calendar's rows before they landed and mint a todo it should skip.
  it("does not start while a calendar refresh from an earlier tick is still in flight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t = convexTest({ schema, modules });
      expect(await started(t, nyAt("04:30"))).toContain("calendar");
      // The 4:30 refresh has not finished: its lease stands.
      expect(await started(t, nyAt("04:31"))).not.toContain("repeats");
      expect(await started(t, nyAt("04:35"))).not.toContain("repeats");
      // Past the action limit the lease is dead; that tick restarts the
      // calendar, so repeats still waits.
      const retry = await started(t, nyAt("04:30") + 10 * 60_000 + 1);
      expect(retry).toContain("calendar");
      expect(retry).not.toContain("repeats");
      await clean(t, "calendar", nyAt("04:41"));
      expect(await started(t, nyAt("04:42"))).toContain("repeats");
    } finally {
      vi.useRealTimers();
    }
  });

  it("mints the day's instances when the task runs after the 4 a.m. hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t = convexTest({ schema, modules });
      await t.run(async (ctx) => {
        await ctx.db.insert("ttsRepeats", {
          statement: "water the plants", daysOfWeek: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
          active: true, createdAt: 1, updatedAt: 1,
        } as never);
      });
      vi.setSystemTime(nyAt("09:15"));
      expect(await t.action(internal.jarvis.tick.runTask, { name: "repeats", leaseId: await lease(t, "repeats") })).toEqual({ ok: true });
      const minted = await t.run(async (ctx) => ctx.db.query("todos").collect());
      expect(minted.map((row) => row.statement)).toEqual(["water the plants"]);
    } finally {
      vi.useRealTimers();
    }
  });

  // witness: the row eviction was the last Convex cron besides the silence
  // alarm; it is a record-tick task now, due once a day from 4:15.
  it("runs the eviction switch once a day from 4:15 as a tick task, and records it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t = convexTest({ schema, modules });
      expect(await started(t, nyAt("04:10"))).not.toContain("evict");
      expect(await started(t, nyAt("04:15"))).toContain("evict");
      vi.setSystemTime(nyAt("09:00"));
      expect(await t.action(internal.jarvis.tick.runTask, { name: "evict", leaseId: await lease(t, "evict") })).toEqual({ ok: true });
      const rows = await t.run(async (ctx) => ({
        ok: (await ctx.db.query("events").collect()).filter((row) => row.kind === "job-ok" && row.subject === "tick:evict"),
        evicted: (await ctx.db.query("dtsEvents").collect()).filter((row) => row.kind === "agents-evicted"),
      }));
      // (The 4:15 tick's own scheduled run may also have landed: each run is
      // one clean row and one "did nothing" event.)
      expect(rows.ok).toHaveLength(1);
      // The switch is off: every run says it did nothing.
      expect(rows.evicted.length).toBeGreaterThan(0);
      expect(rows.evicted.every((row) => (row.data as { disabled?: boolean }).disabled === true)).toBe(true);
      expect(await started(t, nyAt("09:30"))).not.toContain("evict");
    } finally {
      vi.useRealTimers();
    }
  });
});
