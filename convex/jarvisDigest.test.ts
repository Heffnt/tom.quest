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

describe("GET /jarvis/digest/channel", () => {
  it("answers the output channel's id from the record's env, and null when none is set", async () => {
    const t = setup(MORNING);
    expect(await get(t, "/jarvis/digest/channel")).toEqual({ ok: true, channel: CHANNEL });
    vi.stubEnv("SLACK_TTS_TODAY_CHANNEL_ID", "");
    vi.stubEnv("SLACK_TTS_CHANNEL_ID", "");
    expect(await get(t, "/jarvis/digest/channel")).toEqual({ ok: true, channel: null });
    expect((await t.fetch("/jarvis/digest/channel")).status).toBe(401);
  });
});

describe("POST /jarvis/digest", () => {
  it("is not due before 5 a.m. New York, and composes at a morning's clock", async () => {
    const t = setup(NIGHT);
    expect(await (await post(t, "/jarvis/digest", {})).json()).toMatchObject({ ok: true, due: false, reason: "before 5 a.m. New York" });
    const composed = await t.mutation(internal.jarvis.digest.compose, { now: MORNING });
    expect(composed).toMatchObject({ due: true, channel: CHANNEL });
    expect(composed.due && composed.text.length).toBeGreaterThan(0);
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
      await ctx.db.insert("dtsEvents", { at: MORNING - 3 * 3_600_000, kind: "digest-sent", data: { day: "2026-09-25", windowEnd: MORNING - 3 * 3_600_000 } });
    });
    const answer = await (await post(t, "/jarvis/digest", {})).json();
    expect(answer).toMatchObject({ due: true, since: MORNING - 3 * 3_600_000 });
  });

  it("answers an error, not \"not due\", when the digest is due and the output channel is not set", async () => {
    const t = setup(MORNING);
    vi.stubEnv("SLACK_TTS_TODAY_CHANNEL_ID", "");
    vi.stubEnv("SLACK_TTS_CHANNEL_ID", "");
    const res = await post(t, "/jarvis/digest", {});
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "no-channel", error: expect.stringContaining("SLACK_TTS_TODAY_CHANNEL_ID") });
    // Nothing marked the day: the next run, once the channel is set, is due.
    vi.stubEnv("SLACK_TTS_TODAY_CHANNEL_ID", CHANNEL);
    expect(await (await post(t, "/jarvis/digest", {})).json()).toMatchObject({ due: true, channel: CHANNEL });
  });

  it("still answers a plain \"not due\" before 5 a.m. with no channel set", async () => {
    const t = setup(NIGHT);
    vi.stubEnv("SLACK_TTS_TODAY_CHANNEL_ID", "");
    vi.stubEnv("SLACK_TTS_CHANNEL_ID", "");
    const res = await post(t, "/jarvis/digest", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ due: false, reason: "before 5 a.m. New York" });
  });
});

const THREAD_TS = "1758882600.000100";

/** What the box does for one pending needs-you: post it numbered, record it. */
async function postNumbered(t: ReturnType<typeof convexTest>, item: { key: string; text: string; n: number; todoId?: string }, ts: string) {
  const res = await post(t, "/jarvis/event", {
    kind: "needs-you-posted",
    provenance: { job: "write-slack" },
    subject: item.key,
    data: { key: item.key, channel: CHANNEL, threadTs: THREAD_TS, ts, n: item.n, ...(item.todoId ? { todoId: item.todoId } : {}) },
    text: `${item.n} · ${item.text}`,
  });
  expect(res.status).toBe(200);
}

const reply = (t: ReturnType<typeof convexTest>, eventId: string, text: string, ts: string) =>
  t.mutation(internal.ttsSlack.internalSlackThreadReply, { eventId, channel: CHANNEL, threadTs: THREAD_TS, ts, text, user: "UTOM" });

describe("needs-you, a numbered reply under the digest", () => {
  it("waits for a digest, is numbered after the objection lines, posted once, and an unnumbered reply goes to the one open item", async () => {
    const t = setup(MORNING);
    const todoId = await aTodo(t);
    await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, { todoId, reason: "the landlord needs an answer today", key: "k1" });

    // No digest yet: nothing to thread it under.
    let pending = await get(t, "/jarvis/digest/needs-you");
    expect(pending.thread).toBeNull();
    expect(pending.pending).toHaveLength(1);

    const answer = await (await post(t, "/jarvis/digest", {})).json();
    // Two objection lines printed: the needs-you numbering goes on from 3.
    await recordSent(t, { ...answer, objectionAskIds: ["a1", "a2"] }, THREAD_TS);
    pending = await get(t, "/jarvis/digest/needs-you");
    expect(pending.thread).toEqual({ channel: CHANNEL, ts: THREAD_TS, day: DAY });
    expect(pending.searchThreads).toEqual([{ channel: CHANNEL, ts: THREAD_TS, day: DAY }]);
    expect(pending.pending).toEqual([
      expect.objectContaining({ key: "k1", n: 3, todoId, text: expect.stringContaining("Only you can settle this: the landlord needs an answer today.") }),
    ]);
    await postNumbered(t, pending.pending[0], "1758882601.000200");
    expect((await get(t, "/jarvis/digest/needs-you")).pending).toHaveLength(0);

    expect(await reply(t, "Ev1", "done", "1758882700.000300")).toEqual({ outcome: "done", todoId });
    expect((await t.run(async (ctx) => ctx.db.get(todoId)))?.status).toBe("done");
  });

  it("a reply that starts with a number goes to that item, whatever was posted after it; unnumbered with several open, the thread is asked which", async () => {
    const t = setup(MORNING);
    const first = await aTodo(t, "Answer the landlord about the lease");
    const second = await aTodo(t, "Book the dentist");
    const answer = await (await post(t, "/jarvis/digest", {})).json();
    await recordSent(t, answer, THREAD_TS);
    await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, { todoId: first, reason: "the landlord needs a date", key: "k1" });
    await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, { todoId: second, reason: "the slot closes today", key: "k2" });
    const pending = (await get(t, "/jarvis/digest/needs-you")).pending;
    expect(pending.map((p: { n: number }) => p.n)).toEqual([1, 2]);
    await postNumbered(t, pending[0], "1758882601.000200");
    await postNumbered(t, pending[1], "1758882602.000200");

    // Unnumbered, two open: nothing is guessed.
    expect(await reply(t, "Ev1", "Friday works", "1758882700.000100")).toEqual({ outcome: "asked-which", numbers: [1, 2] });
    const asked = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const line = asked.find((f) => f.name.includes("sendSlack"));
    expect(line?.args[0]).toMatchObject({ channel: CHANNEL, threadTs: THREAD_TS, text: expect.stringContaining("1 or 2") });

    // Numbered: the EARLIER item, though the later one sits directly above.
    expect(await reply(t, "Ev2", "1 done", "1758882800.000100")).toEqual({ outcome: "done", todoId: first });
    // Now one is open: an unnumbered reply is its turn.
    const last = await reply(t, "Ev3", "Tuesday at 9", "1758882900.000100");
    expect(last).toMatchObject({ outcome: "time-note" });
    // A number that names nothing in the thread is a note on the day.
    expect(await reply(t, "Ev4", "7 done", "1758883000.000100")).toEqual({ outcome: "tom-note", subject: { kind: "today", day: DAY } });
  });

  it("a thread with no needs-you keeps a reply as a note on the day", async () => {
    const t = setup(MORNING);
    const answer = await (await post(t, "/jarvis/digest", {})).json();
    await recordSent(t, answer, THREAD_TS);
    expect(await reply(t, "Ev1", "Looks right to me.", "1758882800.000100")).toEqual({ outcome: "tom-note", subject: { kind: "today", day: DAY } });
  });

  it("names every digest thread a pending reply may sit under, back to the third day", async () => {
    vi.useFakeTimers();
    vi.stubEnv("JARVIS_KEY", "k");
    vi.stubEnv("SLACK_TTS_TODAY_CHANNEL_ID", CHANNEL);
    const t = convexTest({ schema, modules });
    const days = [
      { at: MORNING - 3 * 86_400_000, ts: "1758623400.000100", day: "2026-09-23" },
      { at: MORNING - 2 * 86_400_000, ts: "1758709800.000100", day: "2026-09-24" },
      { at: MORNING - 86_400_000, ts: "1758796200.000100", day: "2026-09-25" },
      { at: MORNING, ts: THREAD_TS, day: DAY },
    ];
    // A needs-you opened on the first of them stays pending three days.
    vi.setSystemTime(days[0].at + 60_000);
    const todoId = await aTodo(t);
    for (const one of days) {
      vi.setSystemTime(one.at);
      const answer = await (await post(t, "/jarvis/digest", {})).json();
      await recordSent(t, answer, one.ts);
      if (one === days[0]) {
        vi.setSystemTime(one.at + 60_000);
        await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, { todoId, reason: "it needs an answer", key: "k-old" });
      }
    }
    vi.setSystemTime(MORNING + 60_000);
    const answer = await get(t, "/jarvis/digest/needs-you");
    expect(answer.thread.ts).toBe(THREAD_TS);
    expect(answer.pending.map((p: { key: string }) => p.key)).toEqual(["k-old"]);
    // Newest first, and the first day's thread, where it was posted, is in it.
    expect(answer.searchThreads.map((th: { ts: string }) => th.ts)).toEqual(days.map((d) => d.ts).reverse());
  });
});

describe("numberedReply", () => {
  it("reads a leading number and what follows it, and nothing run into a word", async () => {
    const { numberedReply } = await import("./ttsSlack");
    expect(numberedReply("4 done")).toEqual({ n: 4, rest: "done" });
    expect(numberedReply("4 · Friday")).toEqual({ n: 4, rest: "Friday" });
    expect(numberedReply("4: call her first")).toEqual({ n: 4, rest: "call her first" });
    expect(numberedReply("4")).toEqual({ n: 4, rest: "" });
    expect(numberedReply("4pm works")).toBeNull();
    expect(numberedReply("done")).toBeNull();
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
