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

// witness: runTask wrote job-ok whenever the action resolved, and a task that
// catches a source's failure resolves, so a source that had stopped answering
// read as a clean run and never reached the digest.
describe("a tick task's outcome", () => {
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
    expect(await t.action(internal.jarvis.tick.runTask, { name: "turing-health", leaseId: await lease(t, "turing-health") })).toEqual({ ok: true });
    expect((await outcomes(t)).map((row) => row.kind)).toEqual(["job-ok"]);
  });
});

describe("the tick's leases", () => {
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
    const successLease = await t.run(async (ctx) =>
      ctx.db.insert("events", {
        kind: "tick-started",
        at: 1,
        provenance: { job: "tick:turing-health" },
        subject: "tick:turing-health",
        data: { task: "turing-health", timeoutMs: 1 },
      }),
    );
    expect(await t.action(internal.jarvis.tick.runTask, { name: "turing-health", leaseId: successLease })).toEqual({ ok: true });

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
    expect(rows.filter((row) => row.kind === "job-ok" && row.subject === "tick:turing-health")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "job-failed" && row.subject === "tick:pull-requests")).toHaveLength(1);
  });

  // witness: a task wrote no row until it finished, so the next minute's
  // tick queued a second copy while the first scheduled action was still live.
  it("keeps a slow task single across ticks, then retries its dead start", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t = convexTest({ schema, modules });
      const first = Date.parse("2026-09-28T01:00:00-04:00");
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

});
