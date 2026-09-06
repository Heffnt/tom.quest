import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac, webcrypto } from "node:crypto";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { timeNoteOnlyReply } from "./ttsSlack";
import { captureReplyText, slackHourKey, slackThreadKey } from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const SECRET = "slack-signing-secret";
const TOM = "U0TOM";
const DUMP = "C0DUMP";
const TTS = "C0TTS";

// The route verifies HMAC-SHA256 over `v0:<timestamp>:<raw body>` with the
// Web Crypto API; jsdom leaves that global out, so the test lends it Node's.
vi.stubGlobal("crypto", webcrypto);

function signed(body: unknown): { headers: Record<string, string>; body: string } {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const mac = createHmac("sha256", SECRET)
    .update(`v0:${timestamp}:${raw}`)
    .digest("hex");
  return {
    headers: {
      "Content-Type": "application/json",
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": `v0=${mac}`,
    },
    body: raw,
  };
}

type SlackMessage = {
  channel: string;
  ts: string;
  text: string;
  user?: string;
  thread_ts?: string;
  bot_id?: string;
};

async function postEvent(
  t: ReturnType<typeof convexTest>,
  message: SlackMessage,
  eventId = `Ev${message.ts}`,
) {
  const res = await t.fetch(
    "/slack/events",
    {
      method: "POST",
      ...signed({
        type: "event_callback",
        event_id: eventId,
        event: { type: "message", user: TOM, ...message },
      }),
    },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function slackEnv() {
  vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
  vi.stubEnv("SLACK_DUMP_CHANNEL_ID", DUMP);
  vi.stubEnv("TOM_SLACK_USER_ID", TOM);
}

// The sends a mutation scheduled through the door, read off the scheduler's
// own table (the claudeSessions.test.ts pattern): the observable effect of a
// capture or a thread notice without reaching Slack.
async function scheduledSends(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((job) => job.name.includes("sendSlack"))
      .map(
        (job) =>
          job.args[0] as {
            channel?: string;
            threadTs?: string;
            text: string;
            subject: { kind: string; id?: string };
          },
      ),
  );
}

async function events(t: ReturnType<typeof convexTest>, kind: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("dtsEvents").collect()).filter((e) => e.kind === kind),
  );
}

// A message TTS posted as a thread root in #tts, as the door records it.
async function posted(
  t: ReturnType<typeof convexTest>,
  ts: string,
  subject:
    | { kind: "digest"; day: string }
    | { kind: "hourly"; hour: string }
    | { kind: "todo"; id: Id<"dtsTodos"> }
    | { kind: "session"; id: Id<"claudeSessions"> }
    | { kind: "learning"; id: string },
  text = "a message from TTS",
) {
  await t.mutation(internal.ttsSlack.internalRecordSlackSent, {
    channel: TTS,
    ts,
    subject,
    text,
  });
}

// A Slack that accepts every post and answers with a fresh ts.
function slackAccepts() {
  const calls: Array<Record<string, unknown>> = [];
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body));
      n += 1;
      return { json: async () => ({ ok: true, ts: `9000.${n}` }) };
    }),
  );
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
  vi.stubEnv("SLACK_TTS_CHANNEL_ID", TTS);
  return calls;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubGlobal("crypto", webcrypto);
});

describe("the reply at capture", () => {
  // witness: move the scheduler call above the by_slackTs lookup in
  // internalCapture and the retry schedules a second reply.
  it("schedules exactly one reply line per #dump message, however many times Slack retries", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    const message = { channel: DUMP, ts: "1700000000.000100", text: "buy climbing tape" };
    const first = await postEvent(t, message);
    const second = await postEvent(t, message, "EvRetry");
    expect(second.id).toBe(first.id);
    const sends = await scheduledSends(t);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      channel: DUMP,
      threadTs: message.ts,
      subject: { kind: "todo", id: first.id },
    });
    expect(sends[0].text).toBe(captureReplyText("buy climbing tape", first.id as string));
    expect(sends[0].text).not.toContain("\n");
  });

  // witness: let recordSlackSent re-stamp slackReplyTs on every send in the
  // thread and the todo stops pointing at the reply that exists in Slack.
  it("the door records the send and stamps slackReplyTs once", async () => {
    const calls = slackAccepts();
    const t = convexTest(schema, modules);
    // Inserted directly: a capture would schedule the door itself, and this
    // test drives the door by hand.
    const id = await t.run(async (ctx) =>
      ctx.db.insert("dtsTodos", {
        statement: "reply to me",
        readiness: "unprepared",
        status: "active",
        timingClass: "whenever",
        source: "slack-capture",
        slackChannel: DUMP,
        slackTs: "1700000000.000200",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const result = await t.action(internal.ttsSync.sendSlack, {
      channel: DUMP,
      threadTs: "1700000000.000200",
      text: captureReplyText("reply to me", id),
      subject: { kind: "todo", id },
    });
    expect(result).toEqual({ ok: true, ts: "9000.1" });
    expect(calls[0]).toMatchObject({ channel: DUMP, thread_ts: "1700000000.000200" });
    const todo = await t.run(async (ctx) => ctx.db.get(id));
    expect(todo?.slackReplyTs).toBe("9000.1");
    expect(todo?.slackRepliedAt).toBeDefined();
    const sent = await events(t, "slack-sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].key).toBe(slackThreadKey(DUMP, "1700000000.000200"));
    expect(sent[0].todoId).toBe(id);
    expect(sent[0].data).toMatchObject({
      channel: DUMP,
      ts: "9000.1",
      subject: { kind: "todo", id },
    });
    // A later send in the same thread (a thread notice) is recorded, but the
    // todo keeps pointing at the reply that exists first in Slack.
    await t.mutation(internal.ttsSlack.internalRecordSlackSent, {
      channel: DUMP,
      ts: "9999.9",
      threadTs: "1700000000.000200",
      subject: { kind: "todo", id },
      text: "a later notice",
    });
    expect(await events(t, "slack-sent")).toHaveLength(2);
    expect((await t.run(async (ctx) => ctx.db.get(id)))?.slackReplyTs).toBe("9000.1");
  });

  it("a refused send is recorded as a failure, with its subject", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ json: async () => ({ ok: false, error: "channel_not_found" }) })),
    );
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    vi.stubEnv("SLACK_TTS_CHANNEL_ID", TTS);
    const t = convexTest(schema, modules);
    const result = await t.action(internal.ttsSync.sendSlack, {
      text: "digest",
      subject: { kind: "digest", day: "2026-09-05" },
    });
    expect(result).toEqual({ ok: false, error: "channel_not_found" });
    expect(await events(t, "slack-sent")).toHaveLength(0);
    const failed = await events(t, "slack-send-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].data).toMatchObject({
      channel: TTS,
      subject: { kind: "digest", day: "2026-09-05" },
      error: "channel_not_found",
    });
  });

});

describe("threaded replies from Tom", () => {
  it("drops a redelivered event and counts it", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    await posted(t, "100.1", { kind: "hourly", hour: "2026-09-05T14" });
    const reply = { channel: TTS, ts: "100.2", thread_ts: "100.1", text: "noted" };
    const first = await postEvent(t, reply, "Ev1");
    expect(first.outcome).toBe("tom-note");
    const again = await postEvent(t, reply, "Ev1");
    expect(again).toMatchObject({ outcome: "duplicate", duplicates: 1 });
    const third = await postEvent(t, reply, "Ev1");
    expect(third).toMatchObject({ outcome: "duplicate", duplicates: 2 });
    expect(await events(t, "tom-note")).toHaveLength(1);
    const seen = await events(t, "slack-event");
    expect(seen).toHaveLength(1);
    expect(seen[0].key).toBe("Ev1");
    expect(seen[0].data).toMatchObject({ duplicates: 2, outcome: "tom-note" });
  });

  it("ignores a threaded reply from anyone but Tom, and every one when TOM_SLACK_USER_ID is unset", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    await posted(t, "100.1", { kind: "hourly", hour: "2026-09-05T14" });
    const other = await postEvent(t, {
      channel: TTS,
      ts: "100.3",
      thread_ts: "100.1",
      text: "me too",
      user: "U0SOMEONE",
    });
    expect(other).toEqual({ ok: true, ignored: true });
    expect(await events(t, "slack-event")).toHaveLength(0);
    expect(await events(t, "tom-note")).toHaveLength(0);

    vi.stubEnv("TOM_SLACK_USER_ID", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unset = await postEvent(t, { channel: TTS, ts: "100.4", thread_ts: "100.1", text: "noted" });
    expect(unset).toEqual({ ok: true, ignored: true });
    await postEvent(t, { channel: TTS, ts: "100.5", thread_ts: "100.1", text: "noted again" });
    expect(await events(t, "tom-note")).toHaveLength(0);
    // Logged once, not per event.
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("TOM_SLACK_USER_ID")).length).toBeLessThanOrEqual(1);
    warn.mockRestore();
  });

  it("a live session takes the reply as its next inbound turn", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    const sessionId = await t.mutation(internal.claudeSessions.internalCreateSession, {
      title: "design the thing",
      kind: "adhoc",
      initialPrompt: "start",
    });
    await posted(t, "200.1", { kind: "session", id: sessionId }, "session needs you");
    const result = await postEvent(t, {
      channel: TTS,
      ts: "200.2",
      thread_ts: "200.1",
      text: "go with option B",
    });
    expect(result).toMatchObject({ outcome: "session-turn", sessionId });
    const inbound = await t.run(async (ctx) =>
      ctx.db
        .query("claudeInbound")
        .withIndex("by_session_status", (q) => q.eq("sessionId", sessionId).eq("status", "pending"))
        .collect(),
    );
    // The first row is the seed (with the outcome-pen footer), code-built; the
    // second is Tom's reply, verbatim and in his name — the route verified the
    // Slack user, so a ruling in his words may cite this row.
    expect(inbound).toHaveLength(2);
    expect(inbound[0].text?.startsWith("start")).toBe(true);
    expect(inbound[0].author).toBe("agent");
    expect(inbound[1]).toMatchObject({ text: "go with option B", author: "tom" });
    expect(await scheduledSends(t)).toHaveLength(0);
  });

  it("an ended session gets a new session of the same kind seeded with the thread, and the thread is told", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    const oldId = await t.mutation(internal.claudeSessions.internalCreateSession, {
      title: "design the thing",
      kind: "focus-item",
      repos: ["tom.quest"],
      model: "opus",
      initialPrompt: "start",
    });
    await t.run(async (ctx) =>
      ctx.db.patch(oldId, { status: "ended", outcomeSummary: "landed the draft" }),
    );
    await posted(t, "300.1", { kind: "session", id: oldId }, "session finished: landed the draft");
    const result = await postEvent(t, {
      channel: TTS,
      ts: "300.2",
      thread_ts: "300.1",
      text: "one more pass on the wording",
    });
    expect(result).toMatchObject({ outcome: "session-reopened", endedSessionId: oldId });
    const newId = result.sessionId as Id<"claudeSessions">;
    expect(newId).not.toBe(oldId);
    const fresh = await t.run(async (ctx) => ctx.db.get(newId));
    expect(fresh).toMatchObject({
      title: "design the thing",
      kind: "focus-item",
      repos: ["tom.quest"],
      model: "opus",
      status: "requested",
    });
    const turns = await t.run(async (ctx) =>
      ctx.db
        .query("claudeInbound")
        .withIndex("by_session_status", (q) => q.eq("sessionId", newId).eq("status", "pending"))
        .collect(),
    );
    // The code-built seed carries the thread and stays "agent"; Tom's reply
    // is its own turn after it, verbatim, in his name.
    expect(turns).toHaveLength(2);
    const [seed, tomTurn] = turns;
    expect(seed.author).toBe("agent");
    expect(seed.text).toContain("[TTS] session finished: landed the draft");
    expect(seed.text).not.toContain("one more pass on the wording");
    expect(seed.text).toContain(oldId);
    expect(tomTurn).toMatchObject({ text: "one more pass on the wording", author: "tom" });
    // The thread notice carries the NEW session as its subject, so the next
    // reply in the same thread reaches the new session, not the ended one.
    const sends = await scheduledSends(t);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      channel: TTS,
      threadTs: "300.1",
      subject: { kind: "session", id: newId },
    });
    expect(sends[0].text).toContain(newId);
  });

  it("a todo thread takes a sentence as a fact and a bare 'done' or date as a time note", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    // Captured from #dump with no recorded reply yet: found by the todo's own ts.
    const todoId = await t.mutation(internal.tts.internalCapture, {
      statement: "renew the passport",
      source: "slack-capture",
      slackChannel: DUMP,
      slackTs: "400.1",
    });
    const fact = await postEvent(t, {
      channel: DUMP,
      ts: "400.2",
      thread_ts: "400.1",
      text: "the office only takes appointments on weekdays",
    });
    expect(fact).toMatchObject({ outcome: "tom-note", subject: { kind: "todo", id: todoId } });
    const notes = await events(t, "tom-note");
    expect(notes).toHaveLength(1);
    expect(notes[0].todoId).toBe(todoId);
    expect(notes[0].data).toMatchObject({
      text: "the office only takes appointments on weekdays",
      channel: DUMP,
      threadTs: "400.1",
    });

    const dated = await postEvent(t, { channel: DUMP, ts: "400.3", thread_ts: "400.1", text: "sept 12" });
    expect(dated.outcome).toBe("time-note");
    const done = await postEvent(t, { channel: DUMP, ts: "400.4", thread_ts: "400.1", text: "Done." });
    expect(done.outcome).toBe("time-note");
    const timeNotes = await t.run(async (ctx) => ctx.db.query("dtsTimeNotes").collect());
    expect(timeNotes.map((n) => [n.text, n.todoId, n.status])).toEqual([
      ["sept 12", todoId, "pending"],
      ["Done.", todoId, "pending"],
    ]);
    expect(await events(t, "tom-note")).toHaveLength(1);
  });

  it("a digest thread takes a fact with the day, and a bare date as a time note on the day", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    await posted(t, "500.1", { kind: "digest", day: "2026-09-05" }, "TTS digest");
    const fact = await postEvent(t, {
      channel: TTS,
      ts: "500.2",
      thread_ts: "500.1",
      text: "the dentist line is wrong, that was last month",
    });
    expect(fact).toMatchObject({ outcome: "tom-note" });
    const notes = await events(t, "tom-note");
    expect(notes[0].data).toMatchObject({ day: "2026-09-05", subject: { kind: "digest" } });

    const dated = await postEvent(t, { channel: TTS, ts: "500.3", thread_ts: "500.1", text: "tomorrow" });
    expect(dated.outcome).toBe("time-note");
    const timeNotes = await t.run(async (ctx) => ctx.db.query("dtsTimeNotes").collect());
    expect(timeNotes).toHaveLength(1);
    expect(timeNotes[0]).toMatchObject({ text: "tomorrow", day: "2026-09-05", status: "pending" });
    expect(timeNotes[0].todoId).toBeUndefined();
  });

  it("an hourly thread takes a fact with the hour", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    const hour = slackHourKey(Date.UTC(2026, 8, 5, 18, 30)); // 14:30 EDT
    expect(hour).toBe("2026-09-05T14");
    await posted(t, "600.1", { kind: "hourly", hour });
    const result = await postEvent(t, { channel: TTS, ts: "600.2", thread_ts: "600.1", text: "I was at the gym, not writing" });
    expect(result).toMatchObject({ outcome: "tom-note", subject: { kind: "hourly", hour } });
    const notes = await events(t, "tom-note");
    expect(notes[0].data).toMatchObject({ hour, day: "2026-09-05" });
  });

  it("a learning thread writes a learning-objection with the change's id", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    await posted(t, "700.1", { kind: "learning", id: "learn-2026-09-05-3" }, "learned: Tom prefers mornings");
    const result = await postEvent(t, { channel: TTS, ts: "700.2", thread_ts: "700.1", text: "no, that was one week" });
    expect(result).toEqual({ ok: true, outcome: "learning-objection", id: "learn-2026-09-05-3" });
    const objections = await events(t, "learning-objection");
    expect(objections).toHaveLength(1);
    expect(objections[0].data).toMatchObject({ id: "learn-2026-09-05-3", text: "no, that was one week" });
  });

  it("an unknown thread is captured as a todo whose provenance names the thread, and the thread is answered", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    const result = await postEvent(t, { channel: TTS, ts: "800.2", thread_ts: "800.1", text: "book the ferry" });
    expect(result.outcome).toBe("captured");
    const todoId = result.todoId as Id<"dtsTodos">;
    const todo = await t.run(async (ctx) => ctx.db.get(todoId));
    expect(todo).toMatchObject({
      statement: "book the ferry",
      source: "slack-reply",
      provenance: `slack:thread channel=${TTS} thread_ts=800.1 ts=800.2`,
      readiness: "unprepared",
    });
    expect(todo?.slackTs).toBeUndefined();
    const sends = await scheduledSends(t);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ channel: TTS, threadTs: "800.1", subject: { kind: "todo", id: todoId } });
    expect(sends[0].text).toBe(captureReplyText("book the ferry", todoId));
    // The newest record in the thread now names the todo: a second reply is a
    // fact on it, not another todo.
    await t.mutation(internal.ttsSlack.internalRecordSlackSent, {
      channel: TTS,
      ts: "800.3",
      threadTs: "800.1",
      subject: { kind: "todo", id: todoId },
      text: sends[0].text,
    });
    const next = await postEvent(t, { channel: TTS, ts: "800.4", thread_ts: "800.1", text: "the 9am one" });
    expect(next).toMatchObject({ outcome: "tom-note", subject: { kind: "todo", id: todoId } });
  });

  it("a threaded reply is routed whatever channel it is in; a top-level message captures only in #dump", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    const top = await postEvent(t, { channel: TTS, ts: "900.1", text: "not a capture" });
    expect(top).toEqual({ ok: true, ignored: true });
    expect(await t.run(async (ctx) => ctx.db.query("dtsTodos").collect())).toHaveLength(0);
    const bot = await postEvent(t, { channel: TTS, ts: "900.3", thread_ts: "900.1", text: "our own reply", bot_id: "B1" });
    expect(bot).toEqual({ ok: true, ignored: true });
    expect(await events(t, "slack-event")).toHaveLength(0);
  });
});

describe("timeNoteOnlyReply", () => {
  it("recognises 'done' and bare dates, and nothing longer", () => {
    for (const yes of [
      "done",
      "Done.",
      "done!",
      "2026-09-12",
      "9/12",
      "12.09.2026",
      "sept 12",
      "Sept 12th",
      "September 12, 2026",
      "the 12th of september",
      "12 sep",
      "friday",
      "next friday",
      "this thursday at 5pm",
      "tomorrow",
      "tonight",
      "next week",
      "in 3 days",
      "on friday",
      "by sept 3",
      "friday at 10:30",
    ]) {
      expect(timeNoteOnlyReply(yes), yes).toBe(true);
    }
    for (const no of [
      "done, but the receipt is still missing",
      "friday works if the shop is open",
      "not done",
      "sept 12 unless it rains",
      "call them",
      "",
      "12",
      "the office only takes appointments on weekdays",
    ]) {
      expect(timeNoteOnlyReply(no), no).toBe(false);
    }
  });
});
