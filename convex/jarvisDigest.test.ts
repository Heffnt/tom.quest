import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { listForDigest } from "./jarvis/outbox";
import { insertTodo } from "../test/core-tables";

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
    insertTodo(ctx, {
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
    vi.setSystemTime(MORNING);
    const composed = await t.mutation(internal.jarvis.digest.compose, {});
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

/** What the record's hourly digest cron runs (convex/crons.ts). */
const appendDigest = (t: ReturnType<typeof convexTest>) => t.mutation(internal.jarvis.digest.appendThreadDigest, {});

const pushesOf = async (t: ReturnType<typeof convexTest>) =>
  (await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect()))
    .filter((row) => row.name.includes("pushSend") && row.name.includes("sendToAll"))
    .map((row) => row.args[0] as { title: string; body: string; url: string });

describe("the thread digest, appended by the record's cron", () => {
  it("appends nothing before 5 a.m. New York, and has no worker route", async () => {
    const t = setup(NIGHT);
    expect((await post(t, "/jarvis/thread/digest", {})).status).toBe(404);
    const answer = await appendDigest(t);
    expect(answer).toMatchObject({ appended: false, day: "2026-09-25", reason: "before 5 a.m. New York" });
    expect(await ofKind(t, "events", "thread-digest")).toHaveLength(0);
    expect(await pushesOf(t)).toEqual([]);
  });

  it("pushes once for the day's digest, and not again on a later run", async () => {
    const t = setup(MORNING);
    expect(await appendDigest(t)).toMatchObject({ appended: true, day: DAY });
    vi.setSystemTime(MORNING + 3_600_000);
    expect(await appendDigest(t)).toMatchObject({ appended: false, day: DAY });
    expect(await pushesOf(t)).toEqual([{ title: "Digest", body: DAY, url: "/thread" }]);
  });

  // witness: the read of openings charged the openings earlier digests had
  // listed, so large ones used its budget on every later digest and hid each
  // later opening until they left the three-day window.
  it("lists a later opening behind large openings an earlier digest listed, and lists each once", async () => {
    const t = setup(MORNING);
    await t.run(async (ctx) => {
      for (const n of [1, 2]) {
        await ctx.db.insert("events", {
          kind: "needs-you-opened", at: MORNING - (11 - n) * 60_000, provenance: {},
          subject: `large-${n}`, data: { key: `large-${n}` }, text: "x".repeat(600_000),
        });
      }
    });
    await appendDigest(t);
    vi.setSystemTime(MORNING + 3_600_000);
    await t.run(async (ctx) => {
      await ctx.db.insert("events", {
        kind: "needs-you-opened", at: Date.now(), provenance: {}, subject: "later", data: { key: "later" }, text: "Later.",
      });
    });
    for (const days of [1, 2]) {
      vi.setSystemTime(MORNING + days * 86_400_000);
      expect(await appendDigest(t)).toMatchObject({ appended: true });
    }
    const listed = (await ofKind(t, "events", "thread-digest"))
      .flatMap((row) => (row.data as { items: Array<{ key: string }> }).items.map((item) => item.key));
    expect(listed.sort()).toEqual(["large-1", "large-2", "later"]);
  });

  // witness: the read of the four newest digests looked at a fifth to learn
  // whether it was cut, recorded a row cut, and every cut stopped the scan of
  // openings, so from the sixth digest on no opening was listed.
  it("lists a pending opening on the seventh morning, after six digests", async () => {
    const t = setup(MORNING);
    await t.run(async (ctx) => {
      for (let d = 6; d >= 1; d -= 1) {
        const at = MORNING - d * 86_400_000;
        await ctx.db.insert("events", { kind: "thread-digest", at, provenance: { job: "digest" }, subject: `earlier-${d}`,
          data: { day: `earlier-${d}`, windowEnd: at, objectionAskIds: [], items: [] }, text: "Earlier digest." });
      }
      await ctx.db.insert("events", { kind: "needs-you-opened", at: MORNING - 3_600_000, provenance: {},
        subject: "pending", data: { key: "pending" }, text: "Pending." });
    });
    expect(await appendDigest(t)).toMatchObject({ appended: true, day: DAY });
    const today = (await ofKind(t, "events", "thread-digest")).find((row) => row.subject === DAY);
    expect((today?.data as { items: Array<{ key: string }> }).items.map((item) => item.key)).toEqual(["pending"]);
  });

  it("cuts an item's text to its byte bound and stops the list at its byte budget", async () => {
    const t = setup(MORNING);
    await t.run(async (ctx) => {
      for (let n = 0; n < 60; n += 1) {
        const key = `long-${n + 1}`;
        await ctx.db.insert("events", {
          kind: "needs-you-opened",
          at: MORNING - 60_000 + n * 1_000,
          provenance: {},
          subject: key,
          data: { key },
          text: "é".repeat(5_000),
        });
      }
    });
    expect(await appendDigest(t)).toMatchObject({ appended: true, day: DAY });
    const [row] = await ofKind(t, "events", "thread-digest");
    const items = (row.data as { items: Array<{ n: number; key: string; text: string }> }).items;
    for (const item of items) {
      expect(new TextEncoder().encode(item.text).length).toBeLessThanOrEqual(2_048);
      expect(item.text.endsWith("…")).toBe(true);
    }
    expect(new TextEncoder().encode(JSON.stringify(items)).length).toBeLessThanOrEqual(64 * 1024);
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(60);
    // The rest wait for the next day's digest, numbered from 1 again.
    vi.setSystemTime(MORNING + 86_400_000);
    expect(await appendDigest(t)).toMatchObject({ appended: true, day: "2026-09-27" });
    const next = (await ofKind(t, "events", "thread-digest")).find((one) => one.subject === "2026-09-27");
    const nextItems = (next?.data as { items: Array<{ key: string }> }).items;
    expect(nextItems[0].key).toBe(`long-${items.length + 1}`);
  });

  it("refuses a needs-you opening without a subject at the worker routes", async () => {
    const t = setup(MORNING);
    const res = await post(t, "/jarvis/event", { kind: "needs-you-opened", data: { key: "k" }, text: "No subject." });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "a needs-you-opened event names its subject" });
    expect(await ofKind(t, "events", "needs-you-opened")).toEqual([]);
  });

  it("appends one digest with needs-you numbered after objections, then returns its id", async () => {
    const t = setup(MORNING);
    await t.run(async (ctx) => {
      await ctx.db.insert("events", {
        kind: "digest-line",
        at: MORNING - 4_000,
        provenance: {},
        subject: "ask-1",
        data: { section: "decisions", askId: "ask-1", decision: "Use the synthetic first choice." },
      });
      await ctx.db.insert("events", {
        kind: "digest-line",
        at: MORNING - 3_000,
        provenance: {},
        subject: "ask-2",
        data: { section: "decisions", askId: "ask-2", decision: "Use the synthetic second choice." },
      });
      await ctx.db.insert("events", {
        kind: "needs-you-opened",
        at: MORNING - 2_000,
        provenance: {},
        subject: "need-todo",
        data: { key: "need-todo", todoId: "synthetic-todo" },
        text: "Settle the synthetic todo.",
      });
      await ctx.db.insert("events", {
        kind: "needs-you-opened",
        at: MORNING - 1_000,
        provenance: {},
        subject: "need-job",
        data: { key: "need-job", job: "synthetic-job" },
        text: "Settle the synthetic job.",
      });
    });
    const first = await appendDigest(t);
    expect(first).toMatchObject({ appended: true, day: DAY, id: expect.any(String) });
    const [row] = await ofKind(t, "events", "thread-digest");
    expect(row).toMatchObject({ _id: first.id, subject: DAY, provenance: { job: "digest" } });
    const data = row.data as { objectionAskIds: string[]; items: Array<Record<string, unknown>> };
    expect(data.objectionAskIds).toHaveLength(2);
    expect(data.items).toEqual([
      { n: 3, key: "need-todo", text: "Settle the synthetic todo.", todoId: "synthetic-todo" },
      { n: 4, key: "need-job", text: "Settle the synthetic job.", job: "synthetic-job" },
    ]);

    const second = await appendDigest(t);
    expect(second).toMatchObject({
      appended: false,
      day: DAY,
      id: first.id,
      reason: `the digest for ${DAY} is on the thread`,
    });
  });

  it("lists a boundary-time opening once and does not relist a previously listed opening", async () => {
    const t = setup(MORNING);
    await t.run(async (ctx) => {
      await ctx.db.insert("events", {
        kind: "needs-you-opened",
        at: MORNING - 1_000,
        provenance: {},
        subject: "first-window",
        data: { key: "first-window", job: "first-job" },
        text: "First window.",
      });
    });
    expect(await appendDigest(t)).toMatchObject({ appended: true, day: DAY });

    await t.run(async (ctx) => {
      await ctx.db.insert("events", {
        kind: "needs-you-opened",
        at: MORNING,
        provenance: {},
        subject: "boundary-opening",
        data: { key: "boundary-opening", job: "boundary-job" },
        text: "Boundary opening.",
      });
    });
    vi.setSystemTime(MORNING + 86_400_000);
    expect(await appendDigest(t)).toMatchObject({ appended: true, day: "2026-09-27" });
    const rows = await ofKind(t, "events", "thread-digest");
    const next = rows.find((row) => row.subject === "2026-09-27");
    expect((next?.data as { items: Array<{ key: string }> }).items.map((item) => item.key)).toEqual(["boundary-opening"]);
  });

  it("posts openings after today's digest with consecutive numbers and pushes once each", async () => {
    const t = setup(MORNING);
    await t.run(async (ctx) => {
      for (const n of [1, 2]) {
        await ctx.db.insert("events", {
          kind: "digest-line",
          at: MORNING - 1_000 * n,
          provenance: {},
          subject: `late-ask-${n}`,
          data: { section: "decisions", askId: `late-ask-${n}`, decision: `Synthetic choice ${n}.` },
        });
      }
    });
    const digest = await appendDigest(t);
    const firstTodo = await aTodo(t, "Settle the first late item");
    const secondTodo = await aTodo(t, "Settle the second late item");

    await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, {
      todoId: firstTodo, reason: "the first answer is needed", key: "late-1",
    });
    await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, {
      todoId: secondTodo, reason: "the second answer is needed", key: "late-2",
    });

    const posted = await ofKind(t, "events", "thread-needs-you");
    expect(posted.map((row) => ({ subject: row.subject, data: row.data }))).toEqual([
      { subject: digest.id, data: expect.objectContaining({ n: 3, key: "late-1", todoId: firstTodo }) },
      { subject: digest.id, data: expect.objectContaining({ n: 4, key: "late-2", todoId: secondTodo }) },
    ]);
    expect(await pushesOf(t)).toEqual([
      { title: "Digest", body: DAY, url: "/thread" },
      { title: "Needs you", body: "", url: "/thread" },
      { title: "Needs you", body: "", url: "/thread" },
    ]);

    vi.setSystemTime(MORNING + 86_400_000);
    expect(await appendDigest(t)).toMatchObject({ appended: true, day: "2026-09-27" });
    const next = (await ofKind(t, "events", "thread-digest")).find((row) => row.subject === "2026-09-27");
    expect((next?.data as { items: unknown[] }).items).toEqual([]);
  });

  it("numbers a late item after the newest one, and past 50 under one digest leaves it for the next digest", async () => {
    const t = setup(MORNING);
    const digest = await appendDigest(t);
    // The newest posted item under today's digest carries number 50.
    await t.run(async (ctx) => {
      await ctx.db.insert("events", {
        kind: "thread-needs-you", at: MORNING + 1_000, provenance: { job: "needs-you" },
        subject: digest.id, data: { n: 50, key: "posted-50" }, text: "Posted 50.",
      });
    });
    const todoId = await aTodo(t, "Settle the hundred-and-first item");
    vi.setSystemTime(MORNING + 2_000);
    await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, { todoId, reason: "one more", key: "late-101" });
    const posted = await ofKind(t, "events", "thread-needs-you");
    expect(posted.map((row) => (row.data as { key: string }).key)).toEqual(["posted-50"]);
    expect((await pushesOf(t)).filter((push) => push.title === "Needs you")).toEqual([]);

    vi.setSystemTime(MORNING + 86_400_000);
    await appendDigest(t);
    const next = (await ofKind(t, "events", "thread-digest")).find((row) => row.subject === "2026-09-27");
    expect((next?.data as { items: Array<{ key: string }> }).items.map((item) => item.key)).toEqual(["late-101"]);
  });

  it("numbers a late item one past the newest posted under the digest", async () => {
    const t = setup(MORNING);
    const digest = await appendDigest(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("events", {
        kind: "thread-needs-you", at: MORNING + 1_000, provenance: { job: "needs-you" },
        subject: digest.id, data: { n: 7, key: "posted-7" }, text: "Posted 7.",
      });
    });
    const todoId = await aTodo(t, "Settle the eighth item");
    vi.setSystemTime(MORNING + 2_000);
    await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, { todoId, reason: "the eighth", key: "late-8" });
    const late = (await ofKind(t, "events", "thread-needs-you")).find((row) => row.subject === digest.id && (row.data as { key: string }).key === "late-8");
    expect(late?.data).toMatchObject({ n: 8 });
  });

  it("leaves an opening for the morning digest when today's digest does not exist", async () => {
    const t = setup(MORNING);
    const todoId = await aTodo(t, "Settle the morning item");
    await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, {
      todoId, reason: "the morning answer is needed", key: "before-digest",
    });
    expect(await ofKind(t, "events", "thread-needs-you")).toEqual([]);
    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((row) => row.name.includes("pushSend"))).toEqual([]);

    await appendDigest(t);
    const [digest] = await ofKind(t, "events", "thread-digest");
    expect((digest.data as { items: Array<{ key: string }> }).items.map((item) => item.key))
      .toEqual(["before-digest"]);
  });

  it("lists 200 pending openings and carries the rest into the next digest", async () => {
    const t = setup(MORNING);
    await t.run(async (ctx) => {
      for (let n = 0; n < 205; n += 1) {
        const key = `need-${n + 1}`;
        await ctx.db.insert("events", {
          kind: "needs-you-opened",
          at: MORNING - 205_000 + n * 1_000,
          provenance: {},
          subject: key,
          data: { key },
          text: `Need ${n + 1}.`,
        });
      }
    });

    expect(await appendDigest(t)).toMatchObject({ appended: true, day: DAY });
    let rows = await ofKind(t, "events", "thread-digest");
    const first = rows.find((row) => row.subject === DAY);
    const firstData = first?.data as { objectionAskIds: string[]; items: Array<Record<string, unknown>> };
    expect(firstData.objectionAskIds).toEqual([]);
    expect(firstData.items).toEqual(
      Array.from({ length: 200 }, (_, index) => ({ n: index + 1, key: `need-${index + 1}`, text: `Need ${index + 1}.` })),
    );

    vi.setSystemTime(MORNING + 86_400_000);
    expect(await appendDigest(t)).toMatchObject({ appended: true, day: "2026-09-27" });
    rows = await ofKind(t, "events", "thread-digest");
    const next = rows.find((row) => row.subject === "2026-09-27");
    expect((next?.data as { items: Array<Record<string, unknown>> }).items).toEqual(
      Array.from({ length: 5 }, (_, index) => ({ n: index + 1, key: `need-${index + 201}`, text: `Need ${index + 201}.` })),
    );
  });
});

describe("the digest outbox", () => {
  it("lists one subject once from 5 a.m. New York to the next 5 a.m.", async () => {
    const beforeMidnight = Date.parse("2026-09-26T03:59:00Z"); // 23:59 New York
    const t = setup(beforeMidnight);
    const line = { section: "broken" as const, job: "calendar", statement: "The calendar failed." };
    expect(await t.run(async (ctx) => listForDigest(ctx, line))).toEqual({ listed: true });
    vi.setSystemTime(beforeMidnight + 2 * 60_000);
    expect(await t.run(async (ctx) => listForDigest(ctx, line))).toEqual({ listed: false });
    vi.setSystemTime(Date.parse("2026-09-26T09:00:00Z")); // 05:00 New York
    expect(await t.run(async (ctx) => listForDigest(ctx, line))).toEqual({ listed: true });
    expect(await ofKind(t, "events", "digest-line")).toHaveLength(2);
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
  it("finds today's digest thread while it still lives in dtsEvents", async () => {
    const t = setup(MORNING);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: MORNING - 60_000,
        kind: "digest-sent",
        // The previous writer stored only slackTs; the record's configured
        // output channel supplies the channel during the cutover.
        data: { day: DAY, slackTs: THREAD_TS, windowEnd: MORNING - 60_000 },
      });
      await ctx.db.insert("events", {
        at: MORNING,
        kind: "needs-you-opened",
        provenance: {},
        subject: "legacy-thread-item",
        data: { key: "legacy-thread-item" },
        text: "Only you can settle this.",
      });
    });
    const pending = await get(t, "/jarvis/digest/needs-you");
    expect(pending.thread).toEqual({ channel: CHANNEL, ts: THREAD_TS, day: DAY });
    expect(pending.searchThreads).toEqual([{ channel: CHANNEL, ts: THREAD_TS, day: DAY }]);
    expect(pending.pending.map((item: { key: string }) => item.key)).toEqual(["legacy-thread-item"]);
  });

  // witness: the read took the oldest 200 openings and filtered out the
  // posted ones, so with 200 older ones posted a later opening was never
  // offered to the box.
  it("offers a pending opening however many older ones were opened and posted", async () => {
    const t = setup(MORNING);
    await t.run(async (ctx) => {
      for (let n = 0; n < 210; n += 1) {
        const key = `old-${n}`;
        await ctx.db.insert("events", { kind: "needs-you-opened", at: MORNING - 3600_000 + n, provenance: {}, subject: key, data: { key }, text: key });
        await ctx.db.insert("events", { kind: "needs-you-posted", at: MORNING - 1800_000 + n, provenance: {}, subject: key, data: { key, threadTs: "1.0" } });
      }
      await ctx.db.insert("events", { kind: "needs-you-opened", at: MORNING - 60_000, provenance: {}, subject: "late", data: { key: "late" }, text: "late" });
    });
    const pending = (await get(t, "/jarvis/digest/needs-you")).pending;
    expect(pending.map((p: { key: string }) => p.key)).toEqual(["late"]);
  }, 60_000);

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

  // witness: the next number counted only the first 500 posted replies of
  // three days, and a reply was routed from the first 200 rows of the thread
  // (the digest itself among them), so past those a number was handed out
  // twice and a reply to a later one reached nothing.
  it("numbers after the highest reply in the thread and routes a reply to it, however many were posted", async () => {
    const t = setup(MORNING);
    const answer = await (await post(t, "/jarvis/digest", {})).json();
    await recordSent(t, answer, THREAD_TS);
    const posted = 505;
    await t.run(async (ctx) => {
      for (let n = 1; n <= posted; n += 1) {
        const key = `job-${n}`;
        const subject = { kind: "job" as const, id: key };
        await ctx.db.insert("events", {
          kind: "needs-you-posted",
          at: MORNING - 3600_000 + n,
          provenance: { job: "write-slack" },
          subject: key,
          data: { key, job: key, channel: CHANNEL, threadTs: THREAD_TS, ts: `1758882601.${n}`, n },
          text: `${n} · ${key}`,
        });
        await ctx.db.insert("dtsEvents", {
          at: MORNING - 3600_000 + n,
          kind: "slack-sent",
          key: `${CHANNEL}:${THREAD_TS}`,
          data: { channel: CHANNEL, ts: `1758882601.${n}`, threadTs: THREAD_TS, subject, text: `${n} · ${key}` },
        });
      }
      await ctx.db.insert("events", {
        kind: "needs-you-opened",
        at: MORNING - 60_000,
        provenance: {},
        subject: "late",
        data: { key: "late", job: "late-job" },
        text: "late",
      });
    });
    const pending = (await get(t, "/jarvis/digest/needs-you")).pending;
    expect(pending.map((p: { key: string; n: number }) => [p.key, p.n])).toEqual([["late", posted + 1]]);
    expect(await reply(t, "Ev1", `${posted} seen`, "1758882700.000100")).toEqual({
      outcome: "tom-note",
      subject: { kind: "job", id: `job-${posted}` },
    });
  }, 60_000);

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
