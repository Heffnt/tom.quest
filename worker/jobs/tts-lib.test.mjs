// tts-lib.test.mjs — the shared Slack Web API helpers (VQC C1: one home).
//
// These two functions are the ONLY place the worker talks to Slack, and two
// jobs now depend on them: poll-dump.mjs reads #dump through slackGet, and
// prepare-life-todos.mjs answers a capture in its thread through slackPost
// (Tom's ruling 2026-08-30). What is worth a regression test here is not
// "does fetch work" but the three properties that would fail silently:
//
//   1. the bot token travels in the Authorization header, never in a URL
//      (URLs are logged by proxies and by Slack; headers are not),
//   2. thread_ts reaches Slack, because a reply that loses it is posted to the
//      CHANNEL instead of the thread — visibly wrong, and unrecoverable,
//   3. Slack's application-level refusal is treated as a failure, because
//      Slack answers HTTP 200 with {"ok": false, "error": "..."} and a
//      status-code-only check reads every such refusal as a success.
//
// Runs under the repo's Vitest (worker code is plain Node ESM with no
// dependencies, so it imports directly).

import { afterEach, describe, expect, it, vi } from "vitest";
import { slackGet, slackPost } from "./tts-lib.mjs";

const env = { SLACK_BOT_TOKEN: "xoxb-test-token" };

// One fetch stand-in that records every call and answers with a Slack-shaped
// JSON body.
function stubFetch(body = { ok: true }, { httpOk = true, status = 200 } = {}) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: httpOk,
      status,
      json: async () => body,
    };
  });
  return calls;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("slackGet", () => {
  it("sends the token as a header and the params in the query string", async () => {
    const calls = stubFetch({ ok: true, messages: [] });
    await slackGet(env, "conversations.history", {
      channel: "C1DUMP",
      limit: 200,
      cursor: undefined, // omitted, so a caller need not build the object conditionally
    });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toContain("https://slack.com/api/conversations.history");
    expect(url).toContain("channel=C1DUMP");
    expect(url).toContain("limit=200");
    expect(url).not.toContain("cursor");
    // The secret is nowhere in the URL.
    expect(url).not.toContain("xoxb");
    expect(init.headers.Authorization).toBe("Bearer xoxb-test-token");
  });

  it("treats Slack's ok:false as a failure even on HTTP 200", async () => {
    stubFetch({ ok: false, error: "channel_not_found" });
    await expect(slackGet(env, "conversations.history", {})).rejects.toThrow(
      /channel_not_found/,
    );
  });
});

describe("slackPost", () => {
  it("posts a JSON body carrying thread_ts, with the token as a header", async () => {
    const calls = stubFetch({ ok: true, ts: "1788058999.000100" });
    await slackPost(env, "chat.postMessage", {
      channel: "C1DUMP",
      thread_ts: "1788058865.123456",
      text: "Filed. Here is how TTS read that:",
      unfurl_links: false,
    });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(url).not.toContain("xoxb");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer xoxb-test-token");
    // Slack rejects non-ASCII bodies without the charset.
    expect(init.headers["Content-Type"]).toBe("application/json; charset=utf-8");
    const sent = JSON.parse(init.body);
    // Without thread_ts this lands in the channel instead of the thread.
    expect(sent.thread_ts).toBe("1788058865.123456");
    expect(sent.channel).toBe("C1DUMP");
  });

  it("treats Slack's ok:false as a failure even on HTTP 200", async () => {
    stubFetch({ ok: false, error: "thread_not_found" });
    await expect(
      slackPost(env, "chat.postMessage", { channel: "C1DUMP", text: "hi" }),
    ).rejects.toThrow(/thread_not_found/);
  });

  it("reports a transport failure by status", async () => {
    stubFetch({ ok: true }, { httpOk: false, status: 503 });
    await expect(
      slackPost(env, "chat.postMessage", { channel: "C1DUMP", text: "hi" }),
    ).rejects.toThrow(/HTTP 503/);
  });
});
