import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac, webcrypto } from "node:crypto";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { SLACK_THREAD_CLAIMED, replyShape } from "./ttsSlack";
import { slackHourKey, slackThreadKey, ttsDayKey } from "./ttsShared";
import { composeCaptured, renderSlack } from "./ttsCompose";

/** The one reply line at capture, as convex/ttsCompose.ts writes it. */
const captureLine = (statement: string, todoId: string) =>
  renderSlack(composeCaptured({ todoId, statement }));

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const SECRET = "slack-signing-secret";
const TOM = "U0TOM";
const DUMP = "C0DUMP";
const TTS = "C0TTS";
const DECISIONS = "C0DECISIONS";
const NEEDS_YOU = "C0NEEDSYOU";
const BROKEN = "C0BROKEN";

// The route verifies HMAC-SHA256 over `v0:<timestamp>:<raw body>` with the
// Web Crypto API; jsdom leaves that global out, so the test lends it Node's.
vi.stubGlobal("crypto", webcrypto);

async function publishSessionPrelude(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("modelOfTomPublication", {
      key: "current",
      commit: "slack-session-test",
      committedAt: 1,
      pushed: true,
        operate: "operate layer",
        write: "write layer",
        know: "know layer",
      headers: [{
        layers: ["operate", "write", "know"],
        header: "MODEL-OF-TOM FILES (WikiTom commit slack-session-test): operate,write,know",
      }],
    });
  });
}

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
  vi.stubEnv("SLACK_TTS_CHANNEL_ID", TTS);
  // The three rooms this round adds. A reply is acted on only in a channel
  // TTS posts to, and each admits replies only while its id is set.
  vi.stubEnv("SLACK_TTS_DECISIONS_CHANNEL_ID", DECISIONS);
  vi.stubEnv("SLACK_TTS_NEEDS_YOU_CHANNEL_ID", NEEDS_YOU);
  vi.stubEnv("SLACK_TTS_BROKEN_CHANNEL_ID", BROKEN);
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
    | { kind: "today"; day: string }
    | { kind: "digest"; day: string }
    | { kind: "hourly"; hour: string }
    | { kind: "todo"; id: Id<"dtsTodos"> }
    | { kind: "session"; id: Id<"claudeSessions"> }
    | { kind: "learning"; id: string }
    | { kind: "ask"; id: string }
    | { kind: "job"; id: string },
  text = "a message from TTS",
) {
  await t.mutation(internal.ttsSlack.internalRecordSlackSent, {
    channel:
      subject.kind === "ask" ? DECISIONS : subject.kind === "job" ? BROKEN : TTS,
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
    expect(sends[0].text).toBe(captureLine("buy climbing tape", first.id as string));
    // It says what happens NEXT rather than echoing his own words back at him.
    expect(sends[0].text).toContain(
      "Captured; it is prepared tonight and reaches you in tomorrow's morning message.",
    );
    expect(sends[0].text).not.toContain("Captured as a todo");
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
      text: captureLine("reply to me", id),
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

describe("the #tts thread for a todo that needs Tom", () => {
  // One shape for anything that needs him, and one thread per thing. The
  // producer's own id is the dedupe key, so a poller that re-reads the same
  // mail — a re-run, a lost cursor, a redeployment — never opens a second.
  async function aTodo(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) =>
      ctx.db.insert("dtsTodos", {
        statement: "Reply to Sarah Chen about the lab meeting time",
        readiness: "unprepared",
        status: "active",
        timingClass: "whenever",
        source: "email",
        provenance: "gmail:message:18f0a1 https://mail.google.com/mail/u/0/#all/18f0a1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }

  const KEY = "gmail:message:18f0a1";

  // THE JOB SENDS FACTS, NOT TEXT (slack-design.md §4.5). The thread is
  // composed here from the todo's own statement and entry action plus the
  // triage's reason, and the vendor's subject and From header — which the job
  // used to put in the message — never reach Slack at all.
  it("composes the thread from the todo and the reason, and opens it once", async () => {
    const t = convexTest(schema, modules);
    const id = await aTodo(t);
    expect(
      await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, {
        todoId: id,
        reason: "the mail threatens to deactivate the account and may not be from OpenAI",
        key: KEY,
      }),
    ).toEqual({ opened: true, key: KEY });

    // The message is a DRAFT REQUEST now: the Fable run on the box writes it,
    // and the template it falls back to is composed here.
    const drafts = await events(t, "slack-draft-request");
    expect(drafts).toHaveLength(1);
    const draft = drafts[0].data as {
      kind: string;
      fallback: string;
      subject: unknown;
      facts: { facts: { id: string }[] };
    };
    expect(draft.kind).toBe("needs-you");
    expect(draft.subject).toEqual({ kind: "todo", id });
    expect(draft.fallback).toContain(
      "Only you can settle this: the mail threatens to deactivate the account",
    );
    expect(draft.fallback).toContain("Open the message it came from.");
    // The provenance's link is the source line; the raw vendor text is not in
    // the message at all.
    expect(draft.fallback).toContain("https://mail.google.com/mail/u/0/#all/18f0a1");
    expect(draft.facts.facts.map((f) => f.id)).toContain(`todo:${id}`);

    const markers = await events(t, "needs-tom");
    expect(markers).toHaveLength(1);
    expect(markers[0].key).toBe(KEY);
    expect(markers[0].todoId).toBe(id);
    // What the message does NOT print stays on the row.
    expect(markers[0].data).toMatchObject({
      reason: "the mail threatens to deactivate the account and may not be from OpenAI",
    });
  });

  // ONE APPEARANCE PER ITEM PER DAY, across channels (§2.5). The morning
  // message claims at 5 a.m., before any daytime channel runs.
  it("does not open a thread for an item the morning already claimed today", async () => {
    const t = convexTest(schema, modules);
    const id = await aTodo(t);
    const day = ttsDayKey(Date.now());
    await t.mutation(internal.ttsSlack.internalClaimSlackItem, {
      day,
      ask: "act",
      itemId: id,
      channel: "today",
    });
    const result = await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, {
      todoId: id,
      reason: "it needs an answer today",
      key: KEY,
    });
    expect(result).toMatchObject({ opened: false });
    expect(await events(t, "slack-draft-request")).toHaveLength(0);
  });

  it("claims the item for the day, and the same item under another ask is its own key", async () => {
    const t = convexTest(schema, modules);
    const id = await aTodo(t);
    const day = ttsDayKey(Date.now());
    expect(
      await t.mutation(internal.ttsSlack.internalClaimSlackItem, {
        day,
        ask: "act",
        itemId: id,
        channel: "needsYou",
      }),
    ).toEqual({ claimed: true, by: "needsYou" });
    // A second channel finds it taken, and is told which one has it.
    expect(
      await t.mutation(internal.ttsSlack.internalClaimSlackItem, {
        day,
        ask: "act",
        itemId: id,
        channel: "today",
      }),
    ).toEqual({ claimed: false, by: "needsYou" });
    // An item may be BOTH something to do today and the subject of a decision:
    // suppressing the second would silence the objection.
    expect(
      await t.mutation(internal.ttsSlack.internalClaimSlackItem, {
        day,
        ask: "object",
        itemId: id,
        channel: "decisions",
      }),
    ).toEqual({ claimed: true, by: "decisions" });
    // THE DAY ROLLS AT 5 A.M.: tomorrow re-raises what he ignored tonight.
    expect(
      await t.mutation(internal.ttsSlack.internalClaimSlackItem, {
        day: ttsDayKey(Date.now() + 86_400_000),
        ask: "act",
        itemId: id,
        channel: "today",
      }),
    ).toEqual({ claimed: true, by: "today" });
  });

  it("never opens a second thread for the same producer id", async () => {
    const t = convexTest(schema, modules);
    const id = await aTodo(t);
    const args = { todoId: id, reason: "it needs an answer today", key: KEY };
    await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, args);
    expect(
      await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, args),
    ).toEqual({ opened: false, key: KEY });
    expect(await events(t, "slack-draft-request")).toHaveLength(1);
    expect(await events(t, "needs-tom")).toHaveLength(1);
  });

  it("keys on the mail, not the todo — a re-captured mail still opens none", async () => {
    const t = convexTest(schema, modules);
    const first = await aTodo(t);
    await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, {
      todoId: first,
      reason: "it needs an answer today",
      key: KEY,
    });
    // The cursor was lost and the same message came back as a second todo.
    const second = await aTodo(t);
    expect(
      await t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, {
        todoId: second,
        reason: "it needs an answer today",
        key: KEY,
      }),
    ).toEqual({ opened: false, key: KEY });
    expect(await events(t, "slack-draft-request")).toHaveLength(1);
  });

  it("refuses an unknown todo and leaves no marker behind", async () => {
    const t = convexTest(schema, modules);
    // A marker written before the row was checked would suppress the real
    // thread for ever once the todo did exist.
    await expect(
      t.mutation(internal.ttsSlack.internalOpenNeedsTomThread, {
        todoId: "not-an-id",
        reason: "it needs an answer today",
        key: KEY,
      }),
    ).rejects.toThrow(/Unknown todo id/);
    expect(await events(t, "needs-tom")).toHaveLength(0);
    expect(await events(t, "slack-draft-request")).toHaveLength(0);
  });

  // ── The door the box poller comes through ────────────────────────────────
  // The mutation above is only reachable from POST /tts/needs-tom, and the
  // route is the half that decides who may open a thread in Tom's Slack and
  // what a garbled body does. Both are checked here, as they are on every
  // other /tts route.
  describe("POST /tts/needs-tom", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function open(
      t: ReturnType<typeof convexTest>,
      body: unknown,
      key = "s3cret",
    ) {
      return await t.fetch("/tts/needs-tom", {
        method: "POST",
        headers: { "X-TTS-Key": key, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("opens the thread for a caller carrying the worker key", async () => {
      vi.stubEnv("TTS_WORKER_KEY", "s3cret");
      const t = convexTest(schema, modules);
      const id = await aTodo(t);
      const res = await open(t, { todoId: id, reason: "Sarah needs a reply", key: KEY });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, opened: true, key: KEY });
      expect(await events(t, "slack-draft-request")).toHaveLength(1);
    });

    it("is closed to a caller without the worker key", async () => {
      vi.stubEnv("TTS_WORKER_KEY", "s3cret");
      const t = convexTest(schema, modules);
      const id = await aTodo(t);
      const res = await open(t, { todoId: id, reason: "Sarah needs a reply", key: KEY }, "nope");
      expect(res.status).toBe(401);
      expect(await events(t, "needs-tom")).toHaveLength(0);
      expect(await scheduledSends(t)).toHaveLength(0);
    });

    it("refuses a body missing any of the three fields, and an unknown todo", async () => {
      vi.stubEnv("TTS_WORKER_KEY", "s3cret");
      const t = convexTest(schema, modules);
      const id = await aTodo(t);
      for (const body of [
        {},
        { reason: "Sarah needs a reply", key: KEY }, // no todoId
        { todoId: id, key: KEY }, // no reason
        { todoId: id, reason: "Sarah needs a reply" }, // no key
        { todoId: id, reason: "   ", key: KEY }, // a blank reason is no reason
        { todoId: id, reason: "Sarah needs a reply", key: "  " },
        { todoId: 17, reason: "Sarah needs a reply", key: KEY }, // not even a string
        { todoId: "not-an-id", reason: "Sarah needs a reply", key: KEY },
        // `text` is REFUSED rather than ignored: both sides ship in one commit,
        // and a silent ignore would post a message with no reason for as long
        // as an old worker copy survived on the box.
        { todoId: id, text: "Needs you today", reason: "Sarah needs a reply", key: KEY },
      ]) {
        expect((await open(t, body)).status).toBe(400);
      }
      // Nothing was written and nothing was sent for any of them.
      expect(await events(t, "needs-tom")).toHaveLength(0);
      expect(await events(t, "slack-draft-request")).toHaveLength(0);
    });

    it("refuses a body that is not JSON at all", async () => {
      vi.stubEnv("TTS_WORKER_KEY", "s3cret");
      const t = convexTest(schema, modules);
      const res = await t.fetch("/tts/needs-tom", {
        method: "POST",
        headers: { "X-TTS-Key": "s3cret", "Content-Type": "application/json" },
        body: "{ not json",
      });
      expect(res.status).toBe(400);
      expect(await scheduledSends(t)).toHaveLength(0);
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
    await publishSessionPrelude(t);
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
    // The first row is the seed (behind the model-of-tom prelude, with the
    // outcome-pen footer), code-built; the second is Tom's reply, verbatim and
    // in his name — the route verified the Slack user, so a ruling in his
    // words may cite this row.
    expect(inbound).toHaveLength(2);
    expect(inbound[0].text?.startsWith("MODEL-OF-TOM FILES")).toBe(true);
    expect(inbound[0].text).toContain("\n\nstart");
    expect(inbound[0].author).toBe("agent");
    expect(inbound[1]).toMatchObject({ text: "go with option B", author: "tom" });
    expect(await scheduledSends(t)).toHaveLength(0);
  });

  it("an ended session gets a new session of the same kind seeded with the thread, and the thread is told", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    await publishSessionPrelude(t);
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

  // witness: drop the claim insert from sessionReply and the second reply
  // opens a SECOND replacement — before it, the thread changed hands only when
  // the scheduled notice reached Slack, and Tom's two lines land well inside
  // that gap.
  it("a second reply arriving before the notice posts joins the same new session", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    await publishSessionPrelude(t);
    const oldId = await t.mutation(internal.claudeSessions.internalCreateSession, {
      title: "design the thing",
      kind: "adhoc",
      initialPrompt: "start",
    });
    await t.run(async (ctx) => ctx.db.patch(oldId, { status: "ended" }));
    await posted(t, "310.1", { kind: "session", id: oldId }, "session finished");

    const first = await postEvent(t, {
      channel: TTS,
      ts: "310.2",
      thread_ts: "310.1",
      text: "one more pass on the wording",
    });
    expect(first.outcome).toBe("session-reopened");
    const newId = first.sessionId as Id<"claudeSessions">;
    // The notice is still only SCHEDULED: nothing has reached Slack, so the
    // door has recorded nothing since the ended session's own message.
    expect(await scheduledSends(t)).toHaveLength(1);
    expect(await events(t, "slack-sent")).toHaveLength(1);
    // The claim is what carries the thread in the meantime, keyed exactly as
    // the door keys its own rows — the two are read against each other.
    const claims = await events(t, SLACK_THREAD_CLAIMED);
    expect(claims).toHaveLength(1);
    expect(claims[0].key).toBe(slackThreadKey(TTS, "310.1"));
    expect(claims[0].data).toMatchObject({
      subject: { kind: "session", id: newId },
      replaces: oldId,
    });

    const second = await postEvent(t, {
      channel: TTS,
      ts: "310.3",
      thread_ts: "310.1",
      text: "and shorten the title",
    });
    expect(second).toMatchObject({ outcome: "session-turn", sessionId: newId });

    // One replacement, not two, and both of Tom's lines are its turns.
    const sessions = await t.run(async (ctx) => ctx.db.query("claudeSessions").collect());
    expect(sessions.map((s) => s._id).sort()).toEqual([oldId, newId].sort());
    const turns = await t.run(async (ctx) =>
      ctx.db
        .query("claudeInbound")
        .withIndex("by_session_status", (q) =>
          q.eq("sessionId", newId).eq("status", "pending"),
        )
        .collect(),
    );
    expect(turns.map((x) => [x.text, x.author])).toEqual([
      [turns[0].text, "agent"], // the code-built seed carrying the thread
      ["one more pass on the wording", "tom"],
      ["and shorten the title", "tom"],
    ]);
    // And one notice, not one per reply.
    expect(await scheduledSends(t)).toHaveLength(1);

    // Once the notice does land, the thread reads the same way: the door's row
    // and the claim name the same session.
    await t.mutation(internal.ttsSlack.internalRecordSlackSent, {
      channel: TTS,
      ts: "310.4",
      threadTs: "310.1",
      subject: { kind: "session", id: newId },
      text: "continued in a new session",
    });
    const third = await postEvent(t, {
      channel: TTS,
      ts: "310.5",
      thread_ts: "310.1",
      text: "and the summary line",
    });
    expect(third).toMatchObject({ outcome: "session-turn", sessionId: newId });
  });

  // witness: send "done" down the time-note path instead of applyStatusChange
  // and the todo stays active — apply-time-notes has no completion action.
  it("a todo thread takes a sentence as a fact, a bare date as a time note, and 'done' completes the todo", async () => {
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
    const timeNotes = await t.run(async (ctx) => ctx.db.query("dtsTimeNotes").collect());
    expect(timeNotes.map((n) => [n.text, n.todoId, n.status])).toEqual([
      ["sept 12", todoId, "pending"],
    ]);

    const done = await postEvent(t, { channel: DUMP, ts: "400.4", thread_ts: "400.1", text: "Done." });
    expect(done).toMatchObject({ outcome: "done", todoId });
    const todo = await t.run(async (ctx) => ctx.db.get(todoId));
    expect(todo?.status).toBe("done");
    expect(todo?.doneAt).toBeDefined();
    const changes = await events(t, "status-changed");
    expect(changes).toHaveLength(1);
    expect(changes[0].data).toMatchObject({ from: "active", to: "done", note: "Done." });
    // No time note was written for "done": nothing would ever have acted on it.
    expect(await t.run(async (ctx) => ctx.db.query("dtsTimeNotes").collect())).toHaveLength(1);

    // A second "done" on a completed todo has nothing to complete; the words
    // are kept as a fact.
    const again = await postEvent(t, { channel: DUMP, ts: "400.5", thread_ts: "400.1", text: "done" });
    expect(again.outcome).toBe("tom-note");
    expect(await events(t, "tom-note")).toHaveLength(2);
    expect(await events(t, "status-changed")).toHaveLength(1);
  });

  // witness: give the digest case a day-scoped time-note branch again and
  // "tomorrow" below stops being a fact with the day.
  it("a digest thread takes every reply as a fact with the day, unless it names a todo and says done or a date", async () => {
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

    // A bare date with no todo to land on is a fact too, with the day.
    const dated = await postEvent(t, { channel: TTS, ts: "500.3", thread_ts: "500.1", text: "tomorrow" });
    expect(dated).toMatchObject({ outcome: "tom-note", subject: { kind: "digest", day: "2026-09-05" } });
    expect(await t.run(async (ctx) => ctx.db.query("dtsTimeNotes").collect())).toHaveLength(0);
    expect((await events(t, "tom-note"))[1].data).toMatchObject({ text: "tomorrow", day: "2026-09-05" });

    // Naming a todo by its link and saying "done" completes THAT todo, as a
    // reply in its own thread would.
    const todoId = await t.mutation(internal.tts.internalCapture, {
      statement: "book the dentist",
      source: "slack-capture",
    });
    const done = await postEvent(t, {
      channel: TTS,
      ts: "500.4",
      thread_ts: "500.1",
      text: `done <https://tom.quest/tts?item=${todoId}|https://tom.quest/tts?item=${todoId}>`,
    });
    expect(done).toMatchObject({ outcome: "done", todoId });
    expect((await t.run(async (ctx) => ctx.db.get(todoId)))?.status).toBe("done");
    // Naming a todo inside a sentence is still a fact on the digest day —
    // the todo it names is recorded on the row.
    const sentence = await postEvent(t, {
      channel: TTS,
      ts: "500.5",
      thread_ts: "500.1",
      text: `${todoId} was easier than the line made it sound`,
    });
    expect(sentence).toMatchObject({ outcome: "tom-note", subject: { kind: "digest" } });
    const last = (await events(t, "tom-note")).at(-1);
    expect(last?.todoId).toBe(todoId);
    expect(last?.data).toMatchObject({ day: "2026-09-05" });
  });

  it("an hourly thread takes every reply as a fact with the hour, unless it names a todo and says a date", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    const hour = slackHourKey(Date.UTC(2026, 8, 5, 18, 30)); // 14:30 EDT
    expect(hour).toBe("2026-09-05T14");
    await posted(t, "600.1", { kind: "hourly", hour });
    const result = await postEvent(t, { channel: TTS, ts: "600.2", thread_ts: "600.1", text: "I was at the gym, not writing" });
    expect(result).toMatchObject({ outcome: "tom-note", subject: { kind: "hourly", hour } });
    const notes = await events(t, "tom-note");
    expect(notes[0].data).toMatchObject({ hour, day: "2026-09-05" });
    const dated = await postEvent(t, { channel: TTS, ts: "600.3", thread_ts: "600.1", text: "friday" });
    expect(dated.outcome).toBe("tom-note");
    expect(await t.run(async (ctx) => ctx.db.query("dtsTimeNotes").collect())).toHaveLength(0);

    const todoId = await t.mutation(internal.tts.internalCapture, {
      statement: "renew the passport",
      source: "slack-capture",
    });
    const onTodo = await postEvent(t, { channel: TTS, ts: "600.4", thread_ts: "600.1", text: `${todoId} by friday` });
    expect(onTodo.outcome).toBe("time-note");
    const timeNotes = await t.run(async (ctx) => ctx.db.query("dtsTimeNotes").collect());
    expect(timeNotes).toHaveLength(1);
    expect(timeNotes[0]).toMatchObject({ text: `${todoId} by friday`, todoId, status: "pending" });
    expect(timeNotes[0].day).toBeUndefined();
  });

  it("a digest-thread reply naming a model-of-Tom line by its id is an objection to that line", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: Date.now() - 3_600_000,
        kind: "learning-change",
        data: { id: "0123456789ab", file: "model-of-tom/areas/climbing.md", before: "", after: "- a line" },
      });
    });
    await posted(t, "750.1", { kind: "digest", day: "2026-09-06" });
    // The id as the digest prints it, and as a bare prefix.
    const bracketed = await postEvent(t, { channel: TTS, ts: "750.2", thread_ts: "750.1", text: "[0123456789ab] no, that was one week" });
    expect(bracketed).toMatchObject({ outcome: "learning-objection", id: "0123456789ab" });
    const prefix = await postEvent(t, { channel: TTS, ts: "750.3", thread_ts: "750.1", text: "01234567 is wrong" });
    expect(prefix).toMatchObject({ outcome: "learning-objection", id: "0123456789ab" });
    const objections = await events(t, "learning-objection");
    expect(objections).toHaveLength(2);
    expect(objections[0].data).toMatchObject({
      id: "0123456789ab",
      text: "[0123456789ab] no, that was one week",
      subject: { kind: "digest", day: "2026-09-06" },
    });
    // A hex-looking word that prefixes no change is a fact, as before.
    const fact = await postEvent(t, { channel: TTS, ts: "750.4", thread_ts: "750.1", text: "the deadbeef commit looks fine" });
    expect(fact).toMatchObject({ outcome: "tom-note", subject: { kind: "digest" } });
    expect(await events(t, "learning-objection")).toHaveLength(2);
  });

  it("a digest-thread reply that names a todo with done AND a model-of-Tom line does both", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: Date.now() - 3_600_000,
        kind: "learning-change",
        data: { id: "0123456789ab", file: "model-of-tom/areas/climbing.md", before: "", after: "- a line" },
      });
    });
    const todoId = await t.mutation(internal.tts.internalCapture, {
      statement: "renew the passport",
      source: "slack-capture",
    });
    await posted(t, "760.1", { kind: "digest", day: "2026-09-06" });
    const both = await postEvent(t, { channel: TTS, ts: "760.2", thread_ts: "760.1", text: `${todoId} done [0123456789ab]` });
    expect(both).toMatchObject({ outcome: "done", todoId });
    expect((await t.run(async (ctx) => ctx.db.get(todoId)))?.status).toBe("done");
    const objections = await events(t, "learning-objection");
    expect(objections).toHaveLength(1);
    expect(objections[0].data).toMatchObject({ id: "0123456789ab", text: `${todoId} done [0123456789ab]` });
    // The change's name beside a todo and a sentence is the objection; the
    // sentence is not a "done", so the todo stays as it was.
    const withFact = await postEvent(t, { channel: TTS, ts: "760.3", thread_ts: "760.1", text: `01234567 wrong, and ${todoId} needs a form first` });
    expect(withFact).toMatchObject({ outcome: "learning-objection", id: "0123456789ab" });
    expect(await events(t, "learning-objection")).toHaveLength(2);
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
    expect(sends[0].text).toBe(captureLine("book the ferry", todoId));
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

  // witness: let a routing throw escape slackThreadReplyFrom and the route
  // answers 500 — Slack retries three times, then drops the reply for good.
  it("a reply whose routing throws is captured as a todo, recorded as a failure, and answered 200", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    await publishSessionPrelude(t);
    const sessionId = await t.mutation(internal.claudeSessions.internalCreateSession, {
      title: "gone",
      kind: "adhoc",
      initialPrompt: "start",
    });
    await posted(t, "850.1", { kind: "session", id: sessionId }, "session needs you");
    // The session row vanishes under its thread: sessionReply throws.
    await t.run(async (ctx) => ctx.db.delete(sessionId));
    const result = await postEvent(t, { channel: TTS, ts: "850.2", thread_ts: "850.1", text: "ship it" });
    expect(result.outcome).toBe("captured");
    const todoId = result.todoId as Id<"dtsTodos">;
    const todo = await t.run(async (ctx) => ctx.db.get(todoId));
    expect(todo).toMatchObject({
      statement: "ship it",
      source: "slack-reply",
      provenance: `slack:thread channel=${TTS} thread_ts=850.1 ts=850.2`,
    });
    const failed = await events(t, "slack-reply-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].todoId).toBe(todoId);
    expect(failed[0].data).toMatchObject({
      text: "ship it",
      subject: { kind: "session", id: sessionId },
      capturedAs: todoId,
    });
    expect(String((failed[0].data as { error: string }).error)).toContain("Unknown session id");
    const seen = await events(t, "slack-event");
    expect(seen).toHaveLength(1);
    expect(seen[0].data).toMatchObject({ outcome: "captured" });
    expect((seen[0].data as { error?: string }).error).toContain("Unknown session id");
    // The thread is answered with the capture line, once.
    const sends = await scheduledSends(t);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ threadTs: "850.1", subject: { kind: "todo", id: todoId } });
    // A redelivery of the same event is a duplicate, not a second capture.
    const again = await postEvent(t, { channel: TTS, ts: "850.2", thread_ts: "850.1", text: "ship it" });
    expect(again.outcome).toBe("duplicate");
    expect(await t.run(async (ctx) => ctx.db.query("dtsTodos").collect())).toHaveLength(1);
  });

  // witness: drop the slackReplyChannels check from the route and a reply in
  // any channel the app is in becomes a todo AND a bot post into that thread.
  it("a threaded reply is acted on only in #dump, #tts and #tts-hourly; a top-level message captures only in #dump", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    const top = await postEvent(t, { channel: TTS, ts: "900.1", text: "not a capture" });
    expect(top).toEqual({ ok: true, ignored: true });
    expect(await t.run(async (ctx) => ctx.db.query("dtsTodos").collect())).toHaveLength(0);
    const bot = await postEvent(t, { channel: TTS, ts: "900.3", thread_ts: "900.1", text: "our own reply", bot_id: "B1" });
    expect(bot).toEqual({ ok: true, ignored: true });
    expect(await events(t, "slack-event")).toHaveLength(0);

    // Another channel: nothing recorded, nothing captured, nothing posted.
    const elsewhere = await postEvent(t, { channel: "C0GENERAL", ts: "900.5", thread_ts: "900.4", text: "lunch?" });
    expect(elsewhere).toEqual({ ok: true, ignored: true });
    expect(await events(t, "slack-event")).toHaveLength(0);
    expect(await t.run(async (ctx) => ctx.db.query("dtsTodos").collect())).toHaveLength(0);
    expect(await scheduledSends(t)).toHaveLength(0);

    // #tts-hourly admits replies once its id is set, not before.
    const hourly = { channel: "C0HOURLY", ts: "900.7", thread_ts: "900.6", text: "noted" };
    expect(await postEvent(t, hourly, "EvH1")).toEqual({ ok: true, ignored: true });
    vi.stubEnv("SLACK_TTS_HOURLY_CHANNEL_ID", "C0HOURLY");
    expect((await postEvent(t, hourly, "EvH2")).outcome).toBe("captured");
    expect(await events(t, "slack-event")).toHaveLength(1);
  });

  // witness: restore the `dumpChannel !== undefined &&` guard and an unset id
  // turns every channel the app is in into #dump — a top-level message
  // anywhere becomes a todo AND gets a bot reply posted under it.
  it("captures nothing at all while SLACK_DUMP_CHANNEL_ID is unset", async () => {
    slackEnv();
    vi.stubEnv("SLACK_DUMP_CHANNEL_ID", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = convexTest(schema, modules);

    for (const [i, channel] of [DUMP, "C0GENERAL"].entries()) {
      expect(await postEvent(t, { channel, ts: `950.${i}`, text: "buy milk" })).toEqual({
        ok: true,
        ignored: true,
      });
    }
    expect(await t.run(async (ctx) => ctx.db.query("dtsTodos").collect())).toHaveLength(0);
    expect(await scheduledSends(t)).toHaveLength(0);
    // Once, not per event.
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes("SLACK_DUMP_CHANNEL_ID")).length,
    ).toBe(1);
    warn.mockRestore();
  });
});

describe("replyShape", () => {
  it("tells 'done' from a bare date from anything longer", () => {
    for (const done of ["done", "Done.", "done!"]) {
      expect(replyShape(done), done).toBe("done");
    }
    for (const date of [
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
      expect(replyShape(date), date).toBe("date");
    }
    for (const fact of [
      "done, but the receipt is still missing",
      "friday works if the shop is open",
      "not done",
      "sept 12 unless it rains",
      "call them",
      "",
      "12",
      "the office only takes appointments on weekdays",
    ]) {
      expect(replyShape(fact), fact).toBe("fact");
    }
  });
});

// ── The two rooms a reply lands in that did not exist before ────────────────
// #tts-decisions: the THREAD IS THE DECISION, so no number is parsed — a bare
// "revert" reverts it and anything else is the sentence Tom wants instead.
// #tts-broken: a reply about a failure is a fact and nothing else.
describe("a reply in one of the new rooms", () => {
  it("writes one delegate-objection row keyed by the askId for a bare revert", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    await posted(t, "200.1", { kind: "ask", id: "3f9c1a22" }, "Object if this is wrong.");
    const outcome = await postEvent(t, {
      channel: DECISIONS,
      ts: "200.2",
      thread_ts: "200.1",
      text: "revert",
    });
    expect(outcome).toMatchObject({ outcome: "delegate-objection", id: "3f9c1a22" });
    const rows = await events(t, "delegate-objection");
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("3f9c1a22");
    expect(rows[0].data).toMatchObject({ askId: "3f9c1a22", revert: true });
    // No number, and no day: the thread names the decision on its own.
    expect(rows[0].data).not.toHaveProperty("n");
  });

  it("keeps a sentence as the sentence, and does not call it a revert", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    await posted(t, "201.1", { kind: "ask", id: "ask-2" }, "Object if this is wrong.");
    await postEvent(t, {
      channel: DECISIONS,
      ts: "201.2",
      thread_ts: "201.1",
      text: "leave it Wednesday",
    });
    const rows = await events(t, "delegate-objection");
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({
      askId: "ask-2",
      revert: false,
      sentence: "leave it Wednesday",
    });
  });

  it("takes a reply about a failure as a fact", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    await posted(t, "202.1", { kind: "job", id: "poll-gmail" }, "The Gmail poller failed.");
    const outcome = await postEvent(t, {
      channel: BROKEN,
      ts: "202.2",
      thread_ts: "202.1",
      text: "the token expired, I will mint a new one",
    });
    expect(outcome).toMatchObject({ outcome: "tom-note" });
    const notes = await events(t, "tom-note");
    expect(notes).toHaveLength(1);
    expect(notes[0].data).toMatchObject({
      job: "poll-gmail",
      text: "the token expired, I will mint a new one",
    });
  });

  it("acts on a reply in the needs-you room the same way it does in #tts", async () => {
    slackEnv();
    const t = convexTest(schema, modules);
    const id = await t.run(async (ctx) =>
      ctx.db.insert("dtsTodos", {
        statement: "check the OpenAI notice",
        readiness: "unprepared",
        status: "active",
        timingClass: "whenever",
        source: "email",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await t.mutation(internal.ttsSlack.internalRecordSlackSent, {
      channel: NEEDS_YOU,
      ts: "203.1",
      subject: { kind: "todo", id },
      text: "Only you can settle this.",
    });
    const outcome = await postEvent(t, {
      channel: NEEDS_YOU,
      ts: "203.2",
      thread_ts: "203.1",
      text: "done",
    });
    expect(outcome).toMatchObject({ outcome: "done" });
    const todo = await t.run(async (ctx) => ctx.db.get(id));
    expect(todo?.status).toBe("done");
  });

  it("ignores a reply in a room TTS does not post to", async () => {
    slackEnv();
    vi.stubEnv("SLACK_TTS_DECISIONS_CHANNEL_ID", "");
    const t = convexTest(schema, modules);
    await posted(t, "204.1", { kind: "ask", id: "ask-3" }, "Object if this is wrong.");
    await postEvent(t, {
      channel: DECISIONS,
      ts: "204.2",
      thread_ts: "204.1",
      text: "revert",
    });
    expect(await events(t, "delegate-objection")).toHaveLength(0);
  });
});
