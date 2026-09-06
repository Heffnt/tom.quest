import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac, webcrypto } from "node:crypto";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { captureReplyText, slackThreadKey } from "./ttsShared";

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

  // witness: drop the todo patch from recordSlackSent and prepare-life-todos
  // posts a second reply under every message.
  it("the door records the send and stamps slackReplyTs, so the worker stays quiet", async () => {
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
    // The worker's pen, arriving late, does not re-point the first reply.
    const late = await t.mutation(internal.ttsSlack.internalMarkSlackReplied, {
      id,
      replyTs: "9999.9",
    });
    expect(late.alreadyReplied).toBe(true);
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

  it("the worker's reply pen records the same slack-sent row a Convex send does", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(internal.tts.internalCapture, {
      statement: "worker replied",
      source: "slack-capture",
      slackChannel: DUMP,
      slackTs: "1700000000.000300",
    });
    await t.mutation(internal.ttsSlack.internalMarkSlackReplied, { id, replyTs: "1700000001.1" });
    const sent = await events(t, "slack-sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].key).toBe(slackThreadKey(DUMP, "1700000000.000300"));
    expect(sent[0].data).toMatchObject({ subject: { kind: "todo", id } });
  });
});

