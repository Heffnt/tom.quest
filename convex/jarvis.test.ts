import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

// From the convex root, as every other test: convex-test names modules by
// their path under convex/, so a glob from a subdirectory finds none of them.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const JSON_HEADERS = { "Content-Type": "application/json" };
const post = (t: ReturnType<typeof convexTest>, path: string, body: unknown, headers: Record<string, string>) =>
  t.fetch(path, { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });

const rows = async (t: ReturnType<typeof convexTest>, table: "events" | "dtsEvents") =>
  await t.run(async (ctx) => (table === "events" ? ctx.db.query("events").collect() : ctx.db.query("dtsEvents").collect()));

// The first request of the file loads every module under convex/, which on
// a loaded box takes longer than the 5 s one test gets; the load is paid
// here, once, with its own budget, so no test's time includes it.
beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("POST /jarvis/event", () => {
  it("takes the new key on the new header, the old key on the old header, and refuses the rest", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "new");
    vi.stubEnv("TTS_WORKER_KEY", "old");
    const body = { kind: "job-ok", provenance: { job: "box-watch" }, subject: "box-watch:read" };
    expect((await post(t, "/jarvis/event", body, { "X-Jarvis-Key": "new" })).status).toBe(200);
    // JARVIS_KEY wins once set; the old header carries whichever key is current.
    expect((await post(t, "/jarvis/event", body, { "X-TTS-Key": "new" })).status).toBe(200);
    expect((await post(t, "/jarvis/event", body, { "X-TTS-Key": "old" })).status).toBe(401);
    expect((await post(t, "/jarvis/event", body, {})).status).toBe(401);
    vi.stubEnv("JARVIS_KEY", "");
    expect((await post(t, "/jarvis/event", body, { "X-Jarvis-Key": "old" })).status).toBe(200);
    vi.stubEnv("TTS_WORKER_KEY", "");
    expect((await post(t, "/jarvis/event", body, { "X-Jarvis-Key": "old" })).status).toBe(503);
  });

  it("writes the row as validated and answers its id; a kind off the list is a 400 naming the list", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const res = await post(
      t,
      "/jarvis/event",
      { kind: "job-ok", provenance: { job: "box-watch" }, subject: "box-watch:read", data: { entries: 3 } },
      { "X-Jarvis-Key": "k" },
    );
    expect(res.status).toBe(200);
    const answer = await res.json();
    expect(answer.ok).toBe(true);
    expect(answer.recovered).toBe(false);
    const events = await rows(t, "events");
    expect(events).toHaveLength(1);
    expect(events[0]._id).toBe(answer.id);
    expect(events[0]).toMatchObject({
      kind: "job-ok",
      at: 1_700_000_000_000,
      provenance: { job: "box-watch" },
      subject: "box-watch:read",
      data: { entries: 3 },
    });

    const bad = await post(t, "/jarvis/event", { kind: "deploy", data: {} }, { "X-Jarvis-Key": "k" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("EVENT_KINDS");
    expect(await rows(t, "events")).toHaveLength(1);
  });

  it("refuses a job-failed that names no job, and records nothing", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const res = await post(t, "/jarvis/event", { kind: "job-failed", provenance: {}, subject: "x:y", data: { error: "e" } }, { "X-Jarvis-Key": "k" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("provenance.job");
    expect(await rows(t, "events")).toEqual([]);
  });

  it("runs the job hooks: one digest failure per standing condition, a repeat marked, re-armed by the clean run, all in events, no Slack post", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const failed = { kind: "job-failed", provenance: { job: "poll-canvas" }, subject: "poll-canvas:canvas-auth", data: { job: "poll-canvas", error: "token expired" } };
    expect(await (await post(t, "/jarvis/event", failed, { "X-Jarvis-Key": "k" })).json()).toMatchObject({ reported: true });
    vi.setSystemTime(1_700_000_060_000);
    expect(await (await post(t, "/jarvis/event", failed, { "X-Jarvis-Key": "k" })).json()).toMatchObject({ reported: false, since: 1_700_000_000_000 });
    // Every accepted post is a row of the record; the repeat names the report it repeats.
    const failures = (await rows(t, "events")).filter((row) => row.kind === "job-failed").sort((a, b) => a.at - b.at);
    expect(failures.map((row) => (row.data as { standingSince?: number }).standingSince)).toEqual([undefined, 1_700_000_000_000]);
    // The digest's broken section reads the first report and not the repeat;
    // nothing posts to Slack on either.
    const standing = await t.run(async (ctx) => {
      const { failuresInWindow } = await import("./jarvis/jobs");
      return await failuresInWindow(ctx, 1_700_000_000_000, 1_700_000_100_000);
    });
    expect(standing.failed.map((row) => row.at)).toEqual([1_700_000_000_000]);
    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((job) => job.name.includes("ttsSync"))).toEqual([]);

    vi.setSystemTime(1_700_000_120_000);
    const ok = { kind: "job-ok", provenance: { job: "poll-canvas" }, subject: "poll-canvas:canvas-auth" };
    expect(await (await post(t, "/jarvis/event", ok, { "X-Jarvis-Key": "k" })).json()).toMatchObject({ recovered: true });
    expect((await rows(t, "events")).map((row) => row.kind).sort()).toEqual(["job-failed", "job-failed", "job-ok", "job-recovered"]);
    // Nothing of a job's report reaches the previous generation's table.
    expect(await rows(t, "dtsEvents")).toEqual([]);
    // The next failure is news again.
    vi.setSystemTime(1_700_000_180_000);
    expect(await (await post(t, "/jarvis/event", failed, { "X-Jarvis-Key": "k" })).json()).toMatchObject({ reported: true });
    const window = await t.run(async (ctx) => {
      const { failuresInWindow } = await import("./jarvis/jobs");
      return await failuresInWindow(ctx, 1_700_000_000_000, 1_700_000_200_000);
    });
    expect(window.failed.map((row) => row.at)).toEqual([1_700_000_000_000, 1_700_000_180_000]);
    expect(window.recovered.map((row) => row.at)).toEqual([1_700_000_120_000]);
  });
});

describe("the heartbeat", () => {
  it("keeps one job-ok row per job, the newest, whatever its subject", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const ok = (job: string, subject: string, at: number) =>
      post(t, "/jarvis/event", { kind: "job-ok", at, provenance: { job }, subject }, { "X-Jarvis-Key": "k" });
    await ok("box-watch", "box-watch:read", 1000);
    await ok("box-watch", "box-watch:post", 1001);
    await ok("box-state", "box-state:read", 1002);
    await ok("box-watch", "box-watch:read", 2000);
    const kept = (await rows(t, "events")).map((row) => [row.provenance.job, row.subject, row.at]).sort();
    expect(kept).toEqual([
      ["box-state", "box-state:read", 1002],
      ["box-watch", "box-watch:read", 2000],
    ]);
  });
});

describe("GET /jarvis/events", () => {
  it("reads newest first by kind, by subject, since a time, up to a limit", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    for (const [job, at] of [["a", 1000], ["b", 2000], ["c", 3000]] as const) {
      await post(t, "/jarvis/event", { kind: "job-ok", at, provenance: { job }, subject: `${job}:read` }, { "X-Jarvis-Key": "k" });
    }
    await post(t, "/jarvis/event", { kind: "job-failed", at: 2500, provenance: { job: "box-state" }, subject: "box-state:read", data: { error: "x" } }, { "X-Jarvis-Key": "k" });
    const read = async (qs: string) => (await (await t.fetch(`/jarvis/events${qs}`, { headers: { "X-Jarvis-Key": "k" } })).json()).events;
    expect((await read("")).map((row: { at: number }) => row.at)).toEqual([3000, 2500, 2000, 1000]);
    expect((await read("?kind=job-ok&limit=2")).map((row: { at: number }) => row.at)).toEqual([3000, 2000]);
    expect((await read("?subject=box-state:read")).map((row: { kind: string }) => row.kind)).toEqual(["job-failed"]);
    expect((await read("?since=2500")).map((row: { at: number }) => row.at)).toEqual([3000, 2500]);
    expect((await t.fetch("/jarvis/events?limit=x", { headers: { "X-Jarvis-Key": "k" } })).status).toBe(400);
    expect((await t.fetch("/jarvis/events")).status).toBe(401);
  });
});

describe("the /jarvis/ prefix", () => {
  it("serves every /tts/ route under /jarvis/ with the same handler, except one the area registered itself", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("TTS_WORKER_KEY", "k");
    // The old job-ok door, reached by its new name, writes the same events row.
    const res = await post(t, "/jarvis/job-ok", { job: "agents-sweep", key: "agents-sweep:read" }, { "X-TTS-Key": "k" });
    expect(res.status).toBe(200);
    expect((await rows(t, "events")).map((row) => [row.kind, row.provenance.job])).toEqual([["job-ok", "agents-sweep"]]);
    // /jarvis/event is the record's own route, not the loop's copy of
    // /tts/event: an old-style body is refused by the kinds list.
    expect((await post(t, "/jarvis/event", { kind: "deploy", data: {} }, { "X-TTS-Key": "k" })).status).toBe(400);
    expect((await post(t, "/tts/event", { kind: "deploy", data: {} }, { "X-TTS-Key": "k" })).status).toBe(200);
    // Every old handler takes the new header too, under either prefix: the
    // box sends X-Jarvis-Key to the legacy pen and to the aliased routes.
    expect((await post(t, "/tts/event", { kind: "deploy", data: {} }, { "X-Jarvis-Key": "k" })).status).toBe(200);
    expect((await post(t, "/jarvis/job-ok", { job: "box-state", key: "box-state:read" }, { "X-Jarvis-Key": "k" })).status).toBe(200);
    expect((await post(t, "/jarvis/job-ok", { job: "box-state", key: "box-state:read" }, { "X-Jarvis-Key": "wrong" })).status).toBe(401);
    // A decision's key is its askId, the record row's subject: without one
    // the legacy pen refuses it as POST /jarvis/event refuses it.
    const before = (await rows(t, "events")).length;
    expect((await post(t, "/tts/event", { kind: "decision", data: { question: "q" } }, { "X-TTS-Key": "k" })).status).toBe(400);
    expect((await post(t, "/jarvis/event", { kind: "decision", data: { question: "q" } }, { "X-Jarvis-Key": "k" })).status).toBe(400);
    expect((await rows(t, "events")).length).toBe(before);
  });
});

describe("the copy from dtsEvents", () => {
  it("copies what POST /tts/event writes, kind and key as they were, with no provenance", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("TTS_WORKER_KEY", "k");
    const res = await post(t, "/tts/event", { kind: "deploy", key: "tom.quest:abc", data: { repo: "tom.quest", to: "abc" } }, { "X-TTS-Key": "k" });
    expect(res.status).toBe(200);
    const [old] = await rows(t, "dtsEvents");
    const [copy] = await rows(t, "events");
    expect(copy).toMatchObject({ kind: "deploy", at: old.at, provenance: {}, subject: "tom.quest:abc", data: { repo: "tom.quest", to: "abc" } });
    expect(await t.mutation(internal.jarvis.events.copyFromDts, { id: old._id })).not.toBeNull();
  });
});
