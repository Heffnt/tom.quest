import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

// The digest area (convex/jarvis/digest.ts): the box asks whether a digest is
// due, posts it, records digest-sent; a needs-you is opened here and posted by
// the box as a reply under the newest digest; his reply there answers the
// needs-you directly above it. From the convex root, as every test.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const HEADERS = { "Content-Type": "application/json", "X-Jarvis-Key": "k" };
const CHANNEL = "C0TODAY";
// 2026-09-26 10:30 UTC is 06:30 New York (EDT): past the 5 a.m. digest and
// past the 6 a.m. late-digest line.
const MORNING = Date.UTC(2026, 8, 26, 10, 30);
const DAY = "2026-09-26";
// 2026-09-26 07:30 UTC is 03:30 New York: before the digest is due.
const NIGHT = Date.UTC(2026, 8, 26, 7, 30);

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function setup(now: number) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("JARVIS_KEY", "k");
  vi.stubEnv("SLACK_TTS_TODAY_CHANNEL_ID", CHANNEL);
  return convexTest({ schema, modules });
}

const post = (t: ReturnType<typeof convexTest>, path: string, body: unknown) =>
  t.fetch(path, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
const get = async (t: ReturnType<typeof convexTest>, path: string) =>
  await (await t.fetch(path, { headers: HEADERS })).json();

const ofKind = async (t: ReturnType<typeof convexTest>, table: "events" | "dtsEvents", kind: string) =>
  await t.run(async (ctx) =>
    (table === "events" ? await ctx.db.query("events").collect() : await ctx.db.query("dtsEvents").collect()).filter(
      (row) => row.kind === kind,
    ),
  );

async function aTodo(t: ReturnType<typeof convexTest>, statement = "Answer the landlord about the lease") {
  return await t.run(async (ctx) =>
    ctx.db.insert("dtsTodos", {
      statement,
      readiness: "unprepared",
      status: "active",
      timingClass: "whenever",
      source: "manual",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** What the box does after a due answer: record the post it made. */
async function recordSent(t: ReturnType<typeof convexTest>, answer: Record<string, unknown>, ts: string) {
  const res = await post(t, "/jarvis/event", {
    kind: "digest-sent",
    provenance: { job: "write-slack" },
    subject: answer.day,
    data: { day: answer.day, channel: answer.channel, ts, windowEnd: answer.windowEnd, surfacedTodoIds: answer.surfacedTodoIds, objectionAskIds: answer.objectionAskIds },
    text: answer.text,
  });
  expect(res.status).toBe(200);
}

describe("POST /jarvis/digest", () => {
  it("is not due before 5 a.m. New York, and a forced run composes anyway", async () => {
    const t = setup(NIGHT);
    expect(await (await post(t, "/jarvis/digest", {})).json()).toMatchObject({ ok: true, due: false, reason: "before 5 a.m. New York" });
    const forced = await (await post(t, "/jarvis/digest", { force: true })).json();
    expect(forced).toMatchObject({ ok: true, due: true, channel: CHANNEL });
    expect(typeof forced.text).toBe("string");
    expect(forced.text.length).toBeGreaterThan(0);
  });

  it("is due once per day: the digest-sent row closes the day, threads his replies and marks what it showed", async () => {
    const t = setup(MORNING);
    const answer = await (await post(t, "/jarvis/digest", {})).json();
    expect(answer).toMatchObject({ due: true, day: DAY, channel: CHANNEL, windowEnd: MORNING });
    await recordSent(t, answer, "1758882600.000100");
    expect(await (await post(t, "/jarvis/digest", {})).json()).toMatchObject({ due: false, reason: `the digest for ${DAY} went out` });
    const [sent] = await ofKind(t, "dtsEvents", "slack-sent");
    expect(sent.data).toMatchObject({ channel: CHANNEL, ts: "1758882600.000100", subject: { kind: "today", day: DAY } });
  });

  it("starts the next window where the last one ended, and reads the previous generation's row until a first one lands", async () => {
    const t = setup(MORNING);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", { at: MORNING - 3_600_000, kind: "digest-sent", data: { day: DAY, windowEnd: MORNING - 3_600_000 } });
    });
    expect(await (await post(t, "/jarvis/digest", {})).json()).toMatchObject({ due: false });
    const forced = await (await post(t, "/jarvis/digest", { force: true })).json();
    expect(forced.since).toBe(MORNING - 3_600_000);
  });

  it("says why when the output channel is not set", async () => {
    const t = setup(MORNING);
    vi.stubEnv("SLACK_TTS_TODAY_CHANNEL_ID", "");
    vi.stubEnv("SLACK_TTS_CHANNEL_ID", "");
    expect(await (await post(t, "/jarvis/digest", {})).json()).toMatchObject({ due: false, reason: "SLACK_TTS_TODAY_CHANNEL_ID is not set" });
  });
});

describe("needs-you, a reply under the digest", () => {
  it("waits for a digest, is posted once, and his reply under it is that todo's next turn", async () => {
    const t = setup(MORNING);
    const todoId = await aTodo(t);
    await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, { todoId, reason: "the landlord needs an answer today", key: "k1" });

    // No digest yet: nothing to thread it under.
    let pending = await get(t, "/jarvis/digest/needs-you");
    expect(pending.thread).toBeNull();
    expect(pending.pending).toHaveLength(1);

    const answer = await (await post(t, "/jarvis/digest", {})).json();
    await recordSent(t, answer, "1758882600.000100");
    pending = await get(t, "/jarvis/digest/needs-you");
    expect(pending.thread).toEqual({ channel: CHANNEL, ts: "1758882600.000100", day: DAY });
    expect(pending.pending).toEqual([
      expect.objectContaining({ key: "k1", todoId, text: expect.stringContaining("Only you can settle this: the landlord needs an answer today.") }),
    ]);

    const res = await post(t, "/jarvis/event", {
      kind: "needs-you-posted",
      provenance: { job: "write-slack" },
      subject: "k1",
      data: { key: "k1", channel: CHANNEL, threadTs: "1758882600.000100", ts: "1758882601.000200", todoId },
      text: pending.pending[0].text,
    });
    expect(res.status).toBe(200);
    expect((await get(t, "/jarvis/digest/needs-you")).pending).toHaveLength(0);

    // A reply in the digest's thread, below the needs-you, naming nothing:
    // "done" completes that todo.
    const reply = await t.mutation(internal.ttsSlack.internalSlackThreadReply, {
      eventId: "Ev1", channel: CHANNEL, threadTs: "1758882600.000100", ts: "1758882700.000300", text: "done", user: "UTOM",
    });
    expect(reply).toEqual({ outcome: "done", todoId });
    expect((await t.run(async (ctx) => ctx.db.get(todoId)))?.status).toBe("done");
  });

  it("a reply above every needs-you is a note on the day, as before", async () => {
    const t = setup(MORNING);
    const todoId = await aTodo(t);
    const answer = await (await post(t, "/jarvis/digest", {})).json();
    await recordSent(t, answer, "1758882600.000100");
    await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, { todoId, reason: "it needs an answer", key: "k2" });
    await post(t, "/jarvis/event", {
      kind: "needs-you-posted",
      subject: "k2",
      data: { key: "k2", channel: CHANNEL, threadTs: "1758882600.000100", ts: "1758882900.000100", todoId },
    });
    const reply = await t.mutation(internal.ttsSlack.internalSlackThreadReply, {
      eventId: "Ev2", channel: CHANNEL, threadTs: "1758882600.000100", ts: "1758882800.000100", text: "Looks right to me.", user: "UTOM",
    });
    expect(reply).toEqual({ outcome: "tom-note", subject: { kind: "today", day: DAY } });
  });
});

describe("the silence alarm and the digest", () => {
  it("says once in the output channel that today's digest is late, and closes it when the digest goes out", async () => {
    const t = setup(MORNING);
    const first = await t.mutation(internal.ttsJobs.internalCheckSilence, {});
    expect(first.silent).toContain("digest");
    await t.mutation(internal.ttsJobs.internalCheckSilence, {});
    const failed = await ofKind(t, "events", "job-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ subject: `digest:${DAY}` });
    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const lines = scheduled.filter((f) => f.name.includes("sendSlack"));
    expect(lines).toHaveLength(1);
    expect(lines[0].args[0]).toMatchObject({ channel: CHANNEL, subject: { kind: "job", id: `digest:${DAY}` } });

    const answer = await (await post(t, "/jarvis/digest", {})).json();
    await recordSent(t, answer, "1758882600.000100");
    expect((await t.mutation(internal.ttsJobs.internalCheckSilence, {})).recovered).toContain("digest");
  });

  it("is quiet before 6 a.m. New York", async () => {
    const t = setup(NIGHT);
    expect((await t.mutation(internal.ttsJobs.internalCheckSilence, {})).silent).not.toContain("digest");
  });
});
