import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  composeHourly,
  elapsedText,
  renderSlack,
  type HourlyFacts,
} from "./ttsCompose";
import { HOURLY_UPDATE_ABANDONED, HOURLY_UPDATE_SENT } from "./ttsHourly";
import {
  TTS_BATCHES_LINK,
  nyHhmm,
  ttsDayBoundsUtc,
  ttsDayKey,
  ttsItemLink,
  ttsSessionLink,
} from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// The one door's own names, spelled here rather than imported: these tests
// assert what the hourly update leaves behind from the OUTSIDE, so the names
// are part of what is being checked.
const SLACK_SENT = "slack-sent";
const SLACK_FAILED = "slack-send-failed";
const DIGEST_SUBJECT = "today";
const HOURLY_SUBJECT = "hourly";

// 2026-09-05 14:00 EDT — a fixed instant so the hh:mm in the text is stable.
const NOW = Date.UTC(2026, 8, 5, 18, 0);
const HOUR = 3_600_000;
const SINCE = NOW - HOUR;

function facts(over: Partial<HourlyFacts> = {}): HourlyFacts {
  return { now: NOW, since: SINCE, running: [], batches: [], changes: [], ...over };
}

async function insertTodo(t: ReturnType<typeof convexTest>, statement: string, batchId?: Id<"batches">) {
  return await t.run(async (ctx) =>
    ctx.db.insert("dtsTodos", {
      statement,
      readiness: "unprepared",
      status: "active",
      timingClass: "whenever",
      kind: "task",
      actor: "tom",
      source: "manual",
      batchId,
      createdAt: NOW - 10 * HOUR,
      updatedAt: NOW - 10 * HOUR,
    }),
  );
}

async function insertEvent(
  t: ReturnType<typeof convexTest>,
  at: number,
  kind: string,
  todoId?: Id<"dtsTodos">,
  data?: unknown,
) {
  return await t.run(async (ctx) => ctx.db.insert("dtsEvents", { at, kind, todoId, data }));
}

describe("the one-line form", () => {
  // THE SILENCE RULE (slack-design.md §4.4). The old heartbeat line
  // ("14:00 — nothing running, nothing changed since 13:00.") is deleted: a
  // channel that says something every hour is a channel he mutes, and the
  // proof of life moved to the morning message, which sends even when empty.
  it("posts nothing at all when nothing ran, was worked, or changed", () => {
    expect(composeHourly(facts())).toBeNull();
  });

  it("is ONE sentence as soon as one fact exists", () => {
    const message = composeHourly(
      facts({
        changes: [
          {
            kind: "captured",
            at: NOW - 1000,
            text: "buy <milk> & eggs",
            detail: "slack-capture",
            link: ttsItemLink("todo1"),
          },
        ],
      }),
    );
    const text = renderSlack(message as NonNullable<typeof message>);
    expect(text.split(String.fromCharCode(10))).toHaveLength(1);
    expect(text).toBe("1 item was captured.");
    // The raw labels from the old table are gone.
    for (const label of ["captured:", "date outcome:", "ruling:", "failure:", "*Running now*"]) {
      expect(text).not.toContain(label);
    }
  });

  it("names what is running and what changed, with the link inside the sentence", () => {
    const message = composeHourly(
      facts({
        running: [
          {
            sessionId: "s1",
            title: "Fix the poller",
            kind: "gate",
            mode: "autonomous",
            status: "running",
            statement: "poll-outlook",
            batchId: "b1",
            elapsedMs: 95 * 60_000,
          },
        ],
        batches: [{ batchId: "b1", statement: "Integrations", sessions: 1, workerEvents: 2 }],
        changes: [
          { kind: "captured", at: NOW - 1, text: "one", detail: null, link: null },
          { kind: "done", at: NOW - 2, text: "two", detail: null, link: null },
        ],
      }),
    );
    const text = renderSlack(message as NonNullable<typeof message>);
    expect(text).toBe(
      `<${ttsSessionLink("s1")}|Fix the poller> has been working poll-outlook on its own for 1h35m, ` +
        "and 1 item was captured and 1 finished.",
    );
    // "worker events" is instrumentation vocabulary and never reaches him.
    expect(text).not.toContain("worker event");
    expect(text).not.toContain("session,");
  });

  it("never prints a kind or a mode value, whatever the facts carry", () => {
    const message = composeHourly(
      facts({
        running: [
          { sessionId: "s1", title: "One", kind: "focus-item", mode: "autonomous", status: "running", statement: "a batch", batchId: "b1", elapsedMs: 60_000 },
          { sessionId: "s2", title: "Two", kind: "adhoc", mode: "interactive", status: "running", statement: null, batchId: null, elapsedMs: 60_000 },
          { sessionId: "s3", title: "Three", kind: "weekly", mode: "interactive", status: "running", statement: null, batchId: null, elapsedMs: 60_000 },
        ],
      }),
    );
    const text = renderSlack(message as NonNullable<typeof message>);
    for (const value of ["focus-item", "adhoc", "weekly", "gate", "block", "autonomous", "interactive"]) {
      expect(text).not.toContain(value);
    }
    expect(text).toBe(`Three sessions are working <${TTS_BATCHES_LINK}|a batch>, and nothing else changed.`);
  });

  it("counts the changes rather than listing them, however many there are", () => {
    const many = Array.from({ length: 47 }, (_, i) => ({
      kind: "captured" as const,
      at: SINCE + i,
      text: `change ${i}`,
      detail: null,
      link: null,
    }));
    const text = renderSlack(composeHourly(facts({ changes: many })) as never);
    expect(text).toBe("47 items were captured.");
    expect(text).not.toContain("+7 more");
    expect(text.split(String.fromCharCode(10))).toHaveLength(1);
  });

  it("elapsed text", () => {
    expect(elapsedText(30_000)).toBe("<1m");
    expect(elapsedText(12 * 60_000)).toBe("12m");
    expect(elapsedText(2 * HOUR)).toBe("2h");
    expect(elapsedText(2 * HOUR + 5 * 60_000)).toBe("2h05m");
  });
});

describe("the changed-since query", () => {
  it("returns captures, completions, archives, rulings, date outcomes and failures in the window, each with its link, and nothing else", async () => {
    const t = convexTest(schema, modules);
    const a = await insertTodo(t, "todo a");
    const b = await insertTodo(t, "todo b");

    // Inside the window, oldest first.
    await insertEvent(t, SINCE + 1, "captured", a, { source: "slack-capture" });
    await insertEvent(t, SINCE + 2, "status-changed", b, { from: "active", to: "done" });
    await insertEvent(t, SINCE + 3, "status-changed", a, { from: "active", to: "archived" });
    await insertEvent(t, SINCE + 4, "ruling", b, { verdict: "approve", sentence: "ship it" });
    await insertEvent(t, SINCE + 5, "date-outcome", a, { outcome: "missed" });
    await insertEvent(t, SINCE + 6, "session-outcome", undefined, {
      sessionId: "sess1",
      title: "night run",
      outcome: "errored",
      summary: "daemon died",
    });
    await insertEvent(t, SINCE + 7, "job-failed", undefined, {
      error: "poll-gmail exited 1",
    });
    // This update's OWN bookkeeping in the window: never reported. Reporting a
    // rejected post as a change makes the next message one line longer, every
    // hour, until Slack refuses it for length.
    await insertEvent(t, SINCE + 8, SLACK_FAILED, undefined, {
      channel: "C1",
      error: "channel_not_found",
      subject: { kind: HOURLY_SUBJECT },
    });
    await insertEvent(t, SINCE + 9, SLACK_SENT, undefined, {
      channel: "C1",
      ts: "1.0",
      subject: { kind: HOURLY_SUBJECT },
    });
    // Instrumentation in the window: not reported.
    await insertEvent(t, SINCE + 10, "surfaced", a);
    await insertEvent(t, SINCE + 11, "status-changed", a, { from: "waiting", to: "active" });
    await insertEvent(t, SINCE + 12, "session-outcome", undefined, {
      sessionId: "sess2",
      outcome: "completed",
    });
    // Outside the window on both sides: not reported.
    await insertEvent(t, SINCE - 1, "captured", b);
    await insertEvent(t, NOW, "captured", b);

    const changes = await t.query(internal.ttsHourly.internalChangedSince, {
      start: SINCE,
      end: NOW,
    });
    expect(changes.map((c) => c.kind)).toEqual([
      "captured",
      "done",
      "archived",
      "ruling",
      "date-outcome",
      "failure",
      "failure",
    ]);
    expect(changes[0]).toMatchObject({
      text: "todo a",
      detail: "slack-capture",
      link: ttsItemLink(a),
    });
    expect(changes[3]).toMatchObject({ text: "todo b", detail: "approve: ship it" });
    expect(changes[4]).toMatchObject({ detail: "missed", link: ttsItemLink(a) });
    expect(changes[5]).toMatchObject({
      text: "night run",
      detail: "daemon died",
      link: ttsSessionLink("sess1"),
    });
    expect(changes[6]).toMatchObject({
      text: "job-failed",
      detail: "poll-gmail exited 1",
      link: null,
    });
  });

  // A kind's rows belong to it whatever they are keyed on. This read used to
  // pin `key` to undefined, which was exact only for as long as no row of the
  // kind had a key — and "job-failed" grew one, to stop a dead credential
  // writing a row every half hour (convex/ttsJobs.ts). Pinned, every keyed
  // failure would have vanished from this update without a word.
  it("reports a job failure whether or not it names the condition it is about", async () => {
    const t = convexTest(schema, modules);
    await insertEvent(t, SINCE + 1, "job-failed", undefined, {
      job: "poll-canvas",
      error: "one bad run",
    });
    await t.run(async (ctx) =>
      ctx.db.insert("dtsEvents", {
        at: SINCE + 2,
        kind: "job-failed",
        key: "poll-canvas:canvas-auth",
        data: { job: "poll-canvas", error: "the Canvas token is dead" },
      }),
    );

    const changes = await t.query(internal.ttsHourly.internalChangedSince, {
      start: SINCE,
      end: NOW,
    });
    expect(changes.map((c) => c.detail)).toEqual([
      "one bad run",
      "the Canvas token is dead",
    ]);
  });

  it("starts the window at the hourly update's OWN marker, never at the door's record of a send", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(internal.ttsHourly.internalLastHourlyWindowEnd, {})).toBeNull();

    // The door's row for an hourly message is not the window marker: it says a
    // message reached Slack, not which window has been reported.
    await insertEvent(t, NOW - 2 * HOUR, SLACK_SENT, undefined, {
      channel: "C1",
      ts: "1.1",
      subject: { kind: HOURLY_SUBJECT, hour: "2026-09-05T12" },
    });
    expect(await t.query(internal.ttsHourly.internalLastHourlyWindowEnd, {})).toBeNull();

    // The marker's own windowEnd is the answer, NOT the row's `at`: the row is
    // stamped when the send returns, and starting there would skip every event
    // recorded while Slack was answering.
    await insertEvent(t, NOW + 5_000, HOURLY_UPDATE_SENT, undefined, {
      windowStart: SINCE,
      windowEnd: NOW,
    });
    expect(await t.query(internal.ttsHourly.internalLastHourlyWindowEnd, {})).toBe(NOW);
  });

  it("counts an abandoned window too, so a permanent refusal is not replayed forever", async () => {
    const t = convexTest(schema, modules);
    await insertEvent(t, NOW - HOUR, HOURLY_UPDATE_SENT, undefined, {
      windowStart: SINCE - HOUR,
      windowEnd: SINCE,
    });
    await insertEvent(t, NOW, HOURLY_UPDATE_ABANDONED, undefined, {
      windowStart: SINCE,
      windowEnd: NOW,
      error: "channel_not_found",
    });
    expect(await t.query(internal.ttsHourly.internalLastHourlyWindowEnd, {})).toBe(NOW);
  });

  it("groups the window's sessions and worker events by batch", async () => {
    const t = convexTest(schema, modules);
    const batchId = await t.run(async (ctx) =>
      ctx.db.insert("batches", {
        statement: "Integrations",
        status: "active",
        createdAt: NOW - 10 * HOUR,
        updatedAt: NOW - 10 * HOUR,
      }),
    );
    const todo = await insertTodo(t, "poll-outlook", batchId);
    await t.run(async (ctx) => {
      const base = {
        repo: "none",
        repos: [],
        nextSeq: 0,
        createdAt: NOW - 2 * HOUR,
      };
      // Live, on the batch directly.
      await ctx.db.insert("claudeSessions", {
        ...base,
        title: "live one",
        kind: "adhoc",
        batchId,
        status: "running",
        statusChangedAt: NOW - HOUR / 2,
      });
      // Ended inside the window, on a todo of the batch.
      await ctx.db.insert("claudeSessions", {
        ...base,
        title: "ended in window",
        kind: "gate",
        todoId: todo,
        status: "ended",
        statusChangedAt: SINCE + 1,
      });
      // Ended before the window: not counted.
      await ctx.db.insert("claudeSessions", {
        ...base,
        title: "ended earlier",
        kind: "gate",
        todoId: todo,
        status: "ended",
        statusChangedAt: SINCE - 1,
      });
    });
    await insertEvent(t, SINCE + 5, "graph-stored", undefined, { batchId, created: 1 });
    await insertEvent(t, SINCE + 6, "plan-repair", todo, { finding: "edge wrong" });

    const worked = await t.query(internal.ttsHourly.internalBatchesWorked, {
      since: SINCE,
      now: NOW,
    });
    expect(worked).toEqual([
      { batchId, statement: "Integrations", sessions: 2, workerEvents: 2 },
    ]);
    const running = await t.query(internal.ttsHourly.internalRunningNow, { now: NOW });
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({
      title: "live one",
      kind: "adhoc",
      statement: "Integrations",
      elapsedMs: 2 * HOUR,
    });
  });
});

describe("the digest resend", () => {
  const DAY = "2026-09-05";
  const DAY_START = Date.UTC(2026, 8, 5, 9); // 5 a.m. EDT
  const DAY_END = DAY_START + 24 * HOUR;
  const args = { day: DAY, dayStart: DAY_START, dayEnd: DAY_END };

  // The sender's two instants, kept DISTINCT everywhere below: the digest was
  // composed against COMPOSED_AT and the failure row was written at FAILED_AT,
  // minutes later — two posts and a retry pause apart. Equal timestamps would
  // hide the whole finding.
  const COMPOSED_AT = DAY_START + 60_000;
  const FAILED_AT = COMPOSED_AT + 5 * 60_000;

  const failedDigest = (windowEnd: number, text: string, day = DAY) =>
    ({
      channel: "C1",
      error: "ratelimited",
      subject: { kind: DIGEST_SUBJECT, day },
      text,
      attempts: 2,
      windowEnd,
    }) as const;

  it("is nothing when today's digest never failed", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(internal.ttsHourly.internalDigestToResend, args)).toBeNull();
  });

  // witness: return `row.at` here instead of the sender's windowEnd and every
  // event recorded between composing and failing is reported by no digest —
  // this one already went out, and tomorrow's window starts after them.
  it("is the failed row's own text, with the instant the sender composed against", async () => {
    const t = convexTest(schema, modules);
    await insertEvent(
      t,
      FAILED_AT,
      SLACK_FAILED,
      undefined,
      failedDigest(COMPOSED_AT, "the composed digest"),
    );
    expect(await t.query(internal.ttsHourly.internalDigestToResend, args)).toEqual({
      text: "the composed digest",
      windowEnd: COMPOSED_AT,
    });
  });

  it("falls back to the row's own time for a row written before the sender carried the boundary", async () => {
    const t = convexTest(schema, modules);
    // The row as the door wrote it before it carried the boundary.
    await insertEvent(t, FAILED_AT, SLACK_FAILED, undefined, {
      channel: "C1",
      error: "ratelimited",
      subject: { kind: DIGEST_SUBJECT, day: DAY },
      text: "an old digest",
      attempts: 2,
    });
    expect(await t.query(internal.ttsHourly.internalDigestToResend, args)).toEqual({
      text: "an old digest",
      windowEnd: FAILED_AT,
    });
  });

  it("is nothing once the day is marked digest-sent, however it was sent", async () => {
    const t = convexTest(schema, modules);
    await insertEvent(
      t,
      FAILED_AT,
      SLACK_FAILED,
      undefined,
      failedDigest(COMPOSED_AT, "the composed digest"),
    );
    await insertEvent(t, FAILED_AT + 60_000, "digest-sent", undefined, {
      day: DAY,
      windowEnd: COMPOSED_AT,
    });
    expect(await t.query(internal.ttsHourly.internalDigestToResend, args)).toBeNull();
  });

  it("ignores another day's failure and another subject's", async () => {
    const t = convexTest(schema, modules);
    const at = DAY_START + 60_000;
    await insertEvent(
      t,
      at,
      SLACK_FAILED,
      undefined,
      failedDigest(at, "yesterday's digest", "2026-09-04"),
    );
    await insertEvent(t, at + 1, SLACK_FAILED, undefined, {
      channel: "C1",
      error: "ratelimited",
      subject: { kind: HOURLY_SUBJECT, hour: "2026-09-05T06" },
      text: "an hourly update",
    });
    expect(await t.query(internal.ttsHourly.internalDigestToResend, args)).toBeNull();
  });
});
// ── The send ────────────────────────────────────────────────────────────────
// internal.ttsSync.sendHourlyUpdate with fetch stubbed: what it posts, where,
// in what order, and what it writes back. Every post goes through the one door
// in convex/ttsSync.ts, so the rows checked here are the door's — the hourly
// update writes only its own window marker.

const HOURLY_CHANNEL = "C-HOURLY";
const TTS_CHANNEL = "C-TTS";

type Post = { channel: string; text: string };

/** Stub chat.postMessage. `error`, when given, is Slack's answer to EVERY
 * call — the door retries once on its own, so a refusal has to be answered
 * twice to stay a refusal. Returns the posts as they are made. */
function stubSlack(error?: string): Post[] {
  const posts: Post[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as Post;
      posts.push({ channel: body.channel, text: body.text });
      return {
        ok: true,
        status: 200,
        json: async () =>
          error === undefined ? { ok: true, ts: `${posts.length}.0` } : { ok: false, error },
      };
    }),
  );
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-not-a-real-token");
  vi.stubEnv("SLACK_TTS_HOURLY_CHANNEL_ID", HOURLY_CHANNEL);
  vi.stubEnv("SLACK_TTS_CHANNEL_ID", TTS_CHANNEL);
  return posts;
}

async function rowsOfKind(
  t: ReturnType<typeof convexTest>,
  kind: string,
  subject?: string,
): Promise<Doc<"dtsEvents">[]> {
  const rows = await t.run(async (ctx) => ctx.db.query("dtsEvents").collect());
  return rows.filter(
    (e) =>
      e.kind === kind &&
      (subject === undefined ||
        (e.data as { subject?: { kind?: string } } | undefined)?.subject?.kind === subject),
  );
}

function dataOf(row: Doc<"dtsEvents">): Record<string, unknown> {
  return (row.data ?? {}) as Record<string, unknown>;
}

describe("sendHourlyUpdate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends nothing at all while the hourly channel is unset", async () => {
    const t = convexTest(schema, modules);
    const posts = stubSlack();
    vi.stubEnv("SLACK_TTS_HOURLY_CHANNEL_ID", "");

    await t.action(internal.ttsSync.sendHourlyUpdate, {});
    expect(posts).toHaveLength(0);
    expect(await rowsOfKind(t, HOURLY_UPDATE_SENT)).toHaveLength(0);
  });

  it("reposts today's refused digest to #tts before its own post, unchanged, and marks the day sent", async () => {
    const t = convexTest(schema, modules);
    const day = ttsDayKey(Date.now());
    // The two instants the sender leaves behind, minutes apart: what the text
    // was composed against, and when the refusal was recorded.
    const composedAt = Date.now() - 6 * 60_000;
    const failedAt = composedAt + 5 * 60_000;
    // What the 5 a.m. digest left behind when Slack refused it: the door's
    // failure row, carrying the text it composed and the boundary that text
    // covers.
    await insertEvent(t, failedAt, SLACK_FAILED, undefined, {
      channel: TTS_CHANNEL,
      subject: { kind: DIGEST_SUBJECT, day },
      error: "ratelimited",
      text: "the morning digest",
      attempts: 2,
      windowEnd: composedAt,
    });
    await busyHour(t);
    const posts = stubSlack();

    await t.action(internal.ttsSync.sendHourlyUpdate, {});

    // The morning message goes to its own channel, first; the hourly line
    // follows, and only because this hour is not quiet.
    expect(posts.map((p) => p.channel)).toEqual([TTS_CHANNEL, HOURLY_CHANNEL]);
    expect(posts[0].text).toBe("the morning digest");
    // The door recorded the send; the digest's own marker says the day is done
    // and where tomorrow's window starts.
    expect(await rowsOfKind(t, SLACK_SENT, DIGEST_SUBJECT)).toHaveLength(1);
    const marks = await rowsOfKind(t, "digest-sent");
    expect(marks).toHaveLength(1);
    // The COMPOSITION boundary, not the failure row's own clock: tomorrow's
    // digest starts where this text's reading stopped, so the minutes Slack
    // spent refusing are still somebody's to report.
    expect(dataOf(marks[0])).toMatchObject({ day, windowEnd: composedAt });

    // That marker is what stops the next tick reposting it.
    await t.action(internal.ttsSync.sendHourlyUpdate, {});
    expect(posts.filter((p) => p.channel === TTS_CHANNEL)).toHaveLength(1);
  });

  // witness: drop `windowEnd` from the RESEND's postSlack call in
  // convex/ttsSync.ts and the second failure row carries only its own `at`,
  // which is what the next tick reads — the drift PR #148 closed reopens one
  // retry in.
  it("carries the composition boundary onto a refused resend's own failure row", async () => {
    const t = convexTest(schema, modules);
    const day = ttsDayKey(Date.now());
    const composedAt = Date.now() - 6 * 60_000;
    const failedAt = composedAt + 5 * 60_000;
    await insertEvent(t, failedAt, SLACK_FAILED, undefined, {
      channel: TTS_CHANNEL,
      subject: { kind: DIGEST_SUBJECT, day },
      error: "ratelimited",
      text: "the morning digest",
      attempts: 2,
      windowEnd: composedAt,
    });
    // Slack refuses this hour too — transiently, so the digest is still owed.
    stubSlack("ratelimited");

    await t.action(internal.ttsSync.sendHourlyUpdate, {});

    // The resend left a second failure row, newer than the first.
    const failures = await rowsOfKind(t, SLACK_FAILED, DIGEST_SUBJECT);
    expect(failures).toHaveLength(2);
    const newest = failures.reduce((a, b) => (b.at >= a.at ? b : a));
    expect(newest.at).toBeGreaterThanOrEqual(failedAt);
    expect(dataOf(newest)).toMatchObject({
      text: "the morning digest",
      windowEnd: composedAt,
    });
    // Nothing was marked sent, so the digest is still owed.
    expect(await rowsOfKind(t, "digest-sent")).toHaveLength(0);

    // The next tick reads the NEWEST failure row, and it still names the
    // instant the text was composed against — not the hour it kept failing.
    const bounds = ttsDayBoundsUtc(day);
    expect(
      await t.query(internal.ttsHourly.internalDigestToResend, {
        day,
        dayStart: bounds.start,
        dayEnd: bounds.end,
      }),
    ).toEqual({ text: "the morning digest", windowEnd: composedAt });
    // Two refused sends here, and the door sleeps SLACK_RETRY_DELAY_MS before
    // each retry — past the default per-test budget.
  }, 15_000);

  // THE SILENCE RULE (slack-design.md §4.4). A quiet hour posts NOTHING, and
  // still writes its marker with posted:false — the marker is what advances the
  // window, and skipping it would make the next hour re-read this one until the
  // message grew a tail of hours nobody saw.
  it("posts nothing at all for a quiet hour, and still writes its marker", async () => {
    const t = convexTest(schema, modules);
    const posts = stubSlack();

    await t.action(internal.ttsSync.sendHourlyUpdate, {});
    expect(posts).toHaveLength(0);
    expect(await rowsOfKind(t, SLACK_SENT, HOURLY_SUBJECT)).toHaveLength(0);
    const marker = await rowsOfKind(t, HOURLY_UPDATE_SENT);
    expect(marker).toHaveLength(1);
    expect(dataOf(marker[0])).toMatchObject({ quiet: true, posted: false });

    // The rows it just wrote are not themselves changes: the next hour is
    // silent too. Reporting its own bookkeeping would post a line an hour, for
    // ever.
    await t.action(internal.ttsSync.sendHourlyUpdate, {});
    expect(posts).toHaveLength(0);
    expect(await rowsOfKind(t, HOURLY_UPDATE_SENT)).toHaveLength(2);
  });

  /** Make the hour NOT quiet: one capture inside the window is enough, and it
   *  is the cheapest fact the update reports. Every test below is about what
   *  the SEND does, so each needs a message to exist at all. */
  async function busyHour(t: ReturnType<typeof convexTest>): Promise<void> {
    const todoId = await insertTodo(t, "buy climbing tape");
    await insertEvent(t, Date.now() - 60_000, "captured", todoId, { source: "manual" });
  }

  it("records a permanent rejection and closes the window past it", async () => {
    const t = convexTest(schema, modules);
    await busyHour(t);
    const posts = stubSlack("channel_not_found");

    await t.action(internal.ttsSync.sendHourlyUpdate, {});

    // Two posts, not one: the door retries once before calling it a refusal.
    expect(posts).toHaveLength(2);
    expect(await rowsOfKind(t, SLACK_SENT, HOURLY_SUBJECT)).toHaveLength(0);
    const failed = await rowsOfKind(t, SLACK_FAILED, HOURLY_SUBJECT);
    expect(failed).toHaveLength(1);
    expect(dataOf(failed[0])).toMatchObject({
      channel: HOURLY_CHANNEL,
      error: "channel_not_found",
      attempts: 2,
    });
    // The window moved: a refusal Slack will keep making must not make every
    // later hour recompose against it.
    const abandoned = await rowsOfKind(t, HOURLY_UPDATE_ABANDONED);
    expect(abandoned).toHaveLength(1);
    expect(dataOf(abandoned[0])).toMatchObject({ error: "channel_not_found" });
    expect(await t.query(internal.ttsHourly.internalLastHourlyWindowEnd, {})).toBe(
      dataOf(abandoned[0]).windowEnd,
    );
  });

  // "ratelimited" is Slack's own wait-and-retry answer; "fetch failed" is a
  // thrown request, whose wording is the runtime's. Anything not on the
  // permanent list leaves the window alone, so the hour is reported late
  // rather than never.
  it.each(["ratelimited", "fetch failed"])(
    "leaves the window where it was after a %s rejection",
    async (error) => {
      const t = convexTest(schema, modules);
      // An hour already reported, so this is an ordinary run rather than the
      // first one (whose window start has nowhere to live — next test).
      const lastEnd = Date.now() - HOUR;
      await insertEvent(t, lastEnd, HOURLY_UPDATE_SENT, undefined, {
        windowStart: lastEnd - HOUR,
        windowEnd: lastEnd,
      });
      await busyHour(t);
      stubSlack(error);

      await t.action(internal.ttsSync.sendHourlyUpdate, {});

      expect(await rowsOfKind(t, SLACK_FAILED, HOURLY_SUBJECT)).toHaveLength(1);
      expect(await rowsOfKind(t, HOURLY_UPDATE_ABANDONED)).toHaveLength(0);
      expect(await rowsOfKind(t, HOURLY_UPDATE_SENT)).toHaveLength(1); // the seeded one
      expect(await t.query(internal.ttsHourly.internalLastHourlyWindowEnd, {})).toBe(lastEnd);
    },
  );

  // witness: drop the zero-width marker and the second run below starts its own
  // fresh now-minus-an-hour window — the older half of the refused hour is then
  // reported by nobody, which is the whole first-run gap.
  it("keeps the first run's window start when Slack refuses it transiently", async () => {
    const t = convexTest(schema, modules);
    await busyHour(t);
    stubSlack("ratelimited");
    const before = Date.now();

    await t.action(internal.ttsSync.sendHourlyUpdate, {});

    // A marker that reports nothing: zero width, at the hour the refused run
    // actually read from.
    const anchors = await rowsOfKind(t, HOURLY_UPDATE_ABANDONED);
    expect(anchors).toHaveLength(1);
    const anchor = dataOf(anchors[0]) as { windowStart: number; windowEnd: number };
    expect(anchor.windowEnd).toBe(anchor.windowStart);
    expect(anchor.windowStart).toBeGreaterThanOrEqual(before - HOUR - 1000);
    expect(anchor.windowStart).toBeLessThanOrEqual(before - HOUR + 1000);
    expect(await rowsOfKind(t, HOURLY_UPDATE_SENT)).toHaveLength(0);
    expect(await t.query(internal.ttsHourly.internalLastHourlyWindowEnd, {})).toBe(
      anchor.windowStart,
    );

    // The next run resumes from it and covers both hours, rather than starting
    // an hour before itself.
    stubSlack();
    await t.action(internal.ttsSync.sendHourlyUpdate, {});
    const marker = await rowsOfKind(t, HOURLY_UPDATE_SENT);
    expect(marker).toHaveLength(1);
    expect(dataOf(marker[0]).windowStart).toBe(anchor.windowStart);
  });
});
