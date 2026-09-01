import { createHmac } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// POST /slack/events is the ONE public write route on this deployment: Slack
// cannot present X-TTS-Key, so the HMAC signature IS the authentication. Tom
// ruled 2026-08-30 that Slack pushes #dump messages here instead of
// poll-dump.mjs asking every two minutes.
//
// Everything Slack requires of such an endpoint is exercised below, because
// each requirement fails INVISIBLY in production if it regresses: a broken
// handshake means the subscription cannot be enabled at all, a broken
// signature check means anyone who finds the URL can write todos, and a
// non-200 means Slack retries the same event forever.

const SECRET = "8f2a1c0b9d4e6f7a1b2c3d4e5f607182";
const DUMP = "C0DUMP";

// An INDEPENDENT signing implementation (node:crypto) against the route's Web
// Crypto one — if both were the same code, a wrong signing string would agree
// with itself and the test would pass while production rejected every request.
function sign(timestamp: string, rawBody: string, secret = SECRET): string {
  return (
    "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")
  );
}

function nowSeconds(): string {
  return Math.floor(Date.now() / 1000).toString();
}

function post(
  t: ReturnType<typeof convexTest>,
  body: unknown,
  opts: {
    timestamp?: string;
    // null = send no signature header at all.
    signature?: string | null;
  } = {},
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const timestamp = opts.timestamp ?? nowSeconds();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Slack-Request-Timestamp": timestamp,
  };
  const signature =
    opts.signature === undefined ? sign(timestamp, rawBody) : opts.signature;
  if (signature !== null) headers["X-Slack-Signature"] = signature;
  return t.fetch("/slack/events", { method: "POST", headers, body: rawBody });
}

function messageEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    event: {
      type: "message",
      channel: DUMP,
      ts: "1788058865.123456",
      text: "book the climbing gym induction",
      ...overrides,
    },
  };
}

const allTodos = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("dtsTodos").collect());

describe("POST /slack/events", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function configured() {
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    vi.stubEnv("SLACK_DUMP_CHANNEL_ID", DUMP);
    return convexTest({ schema, modules });
  }

  // ── (1) The handshake ─────────────────────────────────────────────────────
  // Slack POSTs this ONCE when the URL is saved in the app settings and will
  // not enable the subscription unless the challenge comes back.
  // witness: return anything but the challenge and the Events API cannot be
  // turned on at all — no message ever reaches TTS.
  it("echoes the url_verification challenge", async () => {
    const t = configured();
    const res = await post(t, {
      type: "url_verification",
      challenge: "3eZbrw1aB1oS2yhr1nFxpMHiSY4NqAQCFAHmFEcaMOA",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("3eZbrw1aB1oS2yhr1nFxpMHiSY4NqAQCFAHmFEcaMOA");
  });

  // The handshake is signed like everything else, so an unsigned one is not a
  // way in. witness: move the handshake branch above the signature check and
  // this goes red.
  it("refuses an unsigned url_verification", async () => {
    const t = configured();
    const res = await post(
      t,
      { type: "url_verification", challenge: "abc" },
      { signature: null },
    );
    expect(res.status).toBe(401);
  });

  // ── (2) The signature ─────────────────────────────────────────────────────
  it("captures a #dump message when the signature verifies", async () => {
    const t = configured();
    const res = await post(t, messageEvent());
    expect(res.status).toBe(200);
    expect((await res.json()).duplicate).toBe(false);

    const todos = await allTodos(t);
    expect(todos).toHaveLength(1);
    expect(todos[0].statement).toBe("book the climbing gym induction");
    expect(todos[0].readiness).toBe("unprepared");
    expect(todos[0].source).toBe("slack-capture");
    // The Slack coordinates are what the threaded reply is addressed to and
    // what every later delivery of this message dedupes on.
    expect(todos[0].slackTs).toBe("1788058865.123456");
    expect(todos[0].slackChannel).toBe(DUMP);
  });

  // witness: drop the timingSafeEqual comparison (or compare the wrong
  // string) and anyone who finds this public URL can write todos.
  it("rejects a wrong, malformed, or missing signature and writes nothing", async () => {
    const t = configured();
    const body = messageEvent();
    const ts = nowSeconds();
    const wrongKey = sign(ts, JSON.stringify(body), "not-the-secret");
    expect((await post(t, body, { timestamp: ts, signature: wrongKey })).status).toBe(401);
    expect((await post(t, body, { signature: "v0=deadbeef" })).status).toBe(401);
    expect((await post(t, body, { signature: null })).status).toBe(401);
    expect(await allTodos(t)).toHaveLength(0);
  });

  // The signature covers the RAW bytes. If the handler ever verified a
  // re-serialized copy of the parsed body instead, a body that round-trips
  // differently would fail in production and pass nowhere.
  // witness: sign one body, send another.
  it("rejects a body that does not match the signature it arrived with", async () => {
    const t = configured();
    const ts = nowSeconds();
    const signedFor = sign(ts, JSON.stringify(messageEvent()));
    const res = await post(t, messageEvent({ text: "something else entirely" }), {
      timestamp: ts,
      signature: signedFor,
    });
    expect(res.status).toBe(401);
    expect(await allTodos(t)).toHaveLength(0);
  });

  // The 5-minute replay window. A signature captured off the wire stays valid
  // forever without it.
  // witness: delete the age check and the "six minutes old" case turns 200.
  it("refuses timestamps outside the five-minute window", async () => {
    const t = configured();
    const sixMinutesAgo = (Math.floor(Date.now() / 1000) - 6 * 60).toString();
    const sixMinutesAhead = (Math.floor(Date.now() / 1000) + 6 * 60).toString();
    expect((await post(t, messageEvent(), { timestamp: sixMinutesAgo })).status).toBe(401);
    expect((await post(t, messageEvent(), { timestamp: sixMinutesAhead })).status).toBe(401);
    // Missing or non-numeric timestamps are the same refusal, not a crash.
    expect((await post(t, messageEvent(), { timestamp: "" })).status).toBe(401);
    expect((await post(t, messageEvent(), { timestamp: "not-a-number" })).status).toBe(401);
    // Four minutes old is inside the window and still captures.
    const fourMinutesAgo = (Math.floor(Date.now() / 1000) - 4 * 60).toString();
    expect((await post(t, messageEvent(), { timestamp: fourMinutesAgo })).status).toBe(200);
    expect(await allTodos(t)).toHaveLength(1);
  });

  // Unconfigured secret = refuse, never accept an unverified write.
  it("answers 503 while SLACK_SIGNING_SECRET is unset", async () => {
    vi.stubEnv("SLACK_DUMP_CHANNEL_ID", DUMP);
    const t = convexTest({ schema, modules });
    const res = await post(t, messageEvent());
    expect(res.status).toBe(503);
    expect(await allTodos(t)).toHaveLength(0);
  });

  // ── (3) Retries deliver the same event again ──────────────────────────────
  // Slack's delivery is at-least-once: the same event arrives more than once
  // whenever a response is slow or lost.
  // witness: remove the by_slackTs lookup in internalCapture and one message
  // becomes two todos.
  it("captures one todo however many times Slack redelivers the event", async () => {
    const t = configured();
    const first = await post(t, messageEvent());
    const second = await post(t, messageEvent());
    const third = await post(t, messageEvent({ text: "edited in the retry" }));

    // Every redelivery still answers 200 — anything else makes Slack retry
    // the event it has already delivered successfully.
    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.duplicate).toBe(true);
    expect((await third.json()).id).toBe(firstBody.id);
    expect(await allTodos(t)).toHaveLength(1);
  });

  // The poller's re-offer of a message the push route already took. Its cursor
  // only advances on messages IT filed, so this is the normal hourly case, not
  // an edge one.
  // witness: the same lookup — without it the backstop duplicates every
  // message the push route captured.
  it("refuses the backstop poller's re-offer of a pushed message", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = configured();
    const pushed = await (await post(t, messageEvent())).json();

    const reoffered = await t.fetch("/tts/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TTS-Key": "s3cret" },
      body: JSON.stringify({
        statement: "book the climbing gym induction",
        source: "slack-capture",
        // poll-dump.mjs sends a permalink; the push route sends the ts form.
        // Different provenance, same message.
        provenance: "https://slack.example/archives/C0DUMP/p1788058865123456",
        slackChannel: DUMP,
        slackTs: "1788058865.123456",
      }),
    });
    expect(reoffered.status).toBe(200);
    const body = await reoffered.json();
    expect(body.id).toBe(pushed.id);
    // The flag poll-dump.mjs logs as "duplicate refused".
    expect(body.duplicate).toBe(true);
    expect(await allTodos(t)).toHaveLength(1);
  });

  // ── What is acknowledged and ignored ──────────────────────────────────────
  // Each of these answers 200 (a non-200 would make Slack retry an event we
  // have already decided we do not want) and captures nothing.
  // witness: drop the bot_id test and TTS's own threaded replies capture
  // themselves as todos, in a loop.
  it.each([
    ["a bot's own post", messageEvent({ bot_id: "B0TTS" })],
    ["a join/edit subtype", messageEvent({ subtype: "channel_join" })],
    ["a threaded reply", messageEvent({ thread_ts: "1788058800.000100" })],
    ["an empty message", messageEvent({ text: "   " })],
    ["another channel", messageEvent({ channel: "C0OTHER" })],
    ["a non-message event", { type: "event_callback", event: { type: "reaction_added" } }],
    ["an unknown envelope type", { type: "app_rate_limited" }],
  ])("acknowledges and ignores %s", async (_label, body) => {
    const t = configured();
    const res = await post(t, body);
    expect(res.status).toBe(200);
    expect(await allTodos(t)).toHaveLength(0);
  });
});
