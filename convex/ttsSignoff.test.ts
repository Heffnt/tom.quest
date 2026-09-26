// A MESSAGE IN TOM'S NAME NEEDS HIS SIGN-OFF ROW (convex/ttsSignoff.ts).
// Tom, 2026-09-25: agents "can also send messages in my name after i have
// reviewed the content and explicitily signed off."
//
// The proof comes first: propose → sign (as Tom) → the send goes out, and
// propose → send with no signature is refused. Everything after it is the
// wall's other edges: the worker key cannot write a sign-off, a signature
// covers one exact text to one recipient on one channel, and it is spent by
// its send.

import { convexTest, type TestConvex } from "convex-test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  CALENDAR_CHANNEL,
  NO_SIGNOFF,
  SEND_AS_TOM_FAILED,
  SEND_PROPOSAL,
  SENT_AS_TOM,
  calendarRecipient,
  invitationText,
  parseProposal,
  sha256Hex,
} from "./ttsSignoff";
import { checkMessage, composeProposalAsk } from "./ttsCompose";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const KEY = "s3cret";
const TEXT = "Hi Sarah — Thursday at 3 works for the lab meeting. See you then.\nTom";
const RECIPIENT = "Sarah Chen";
const CHANNEL = "slack:C0SARAH01";

type Post = { url: string; body: Record<string, unknown> };

/** Stub every outbound fetch: Slack's chat.postMessage answers ok, Google's
 *  token and insert answer as Google does. Returns what was posted. */
function stubNetwork(): Post[] {
  const posts: Post[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const raw = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = { raw };
      }
      posts.push({ url: u, body });
      if (u.includes("slack.com")) return Response.json({ ok: true, ts: `${posts.length}.0001` });
      if (u.includes("oauth2.googleapis.com")) return Response.json({ access_token: "not-a-token" });
      if (u.includes("googleapis.com/calendar")) {
        return Response.json({ id: "ev1", htmlLink: "https://calendar.google.com/event?eid=ev1" });
      }
      return new Response("", { status: 404 });
    }),
  );
  return posts;
}

async function withTom(t: TestConvex<typeof schema>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}

async function propose(t: TestConvex<typeof schema>, body: Record<string, unknown>) {
  const res = await t.fetch("/tts/send-proposal", {
    method: "POST",
    headers: { "X-TTS-Key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function proposeSlack(t: TestConvex<typeof schema>, text = TEXT) {
  const res = await propose(t, { channel: CHANNEL, recipient: RECIPIENT, text, agentId: "claude:box:abcdef0123456789" });
  expect(res.status).toBe(200);
  return res.json.proposalId as Id<"dtsEvents">;
}

async function kinds(t: TestConvex<typeof schema>, kind: string) {
  return await t.run(async (ctx) =>
    ctx.db.query("dtsEvents").withIndex("by_kind_at", (q) => q.eq("kind", kind)).collect(),
  );
}

async function signoffs(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => ctx.db.query("signoffs").collect());
}

const slackPosts = (posts: Post[]) => posts.filter((p) => p.url.includes("slack.com"));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TTS_WORKER_KEY", KEY);
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-not-a-real-token");
  vi.stubEnv("SLACK_TTS_CHANNEL_ID", "C0TTS");
  vi.stubEnv("GOOGLE_CALENDAR_CLIENT_ID", "id");
  vi.stubEnv("GOOGLE_CALENDAR_CLIENT_SECRET", "secret");
  vi.stubEnv("GOOGLE_CALENDAR_REFRESH_TOKEN", "refresh");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the proof: a message in Tom's name goes out on his sign-off, and only on it", () => {
  it("propose → sign as Tom → the message goes out, verbatim, and the record shows it", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const posts = stubNetwork();

    const proposalId = await proposeSlack(t);
    expect(slackPosts(posts)).toHaveLength(0);
    expect(await signoffs(t)).toHaveLength(0);

    const answer = await tom.mutation(api.ttsSignoff.signAndSend, { proposalId });
    expect(answer).toEqual({ signed: true, status: "sending" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sent = slackPosts(posts);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ channel: "C0SARAH01", text: TEXT });

    const [signoff] = await signoffs(t);
    const sha256 = await sha256Hex(TEXT);
    expect(signoff).toMatchObject({ text: TEXT, sha256, recipient: RECIPIENT, channel: CHANNEL, signedBy: "tom" });
    expect(signoff.usedAt).toBeTypeOf("number");

    const [event] = await kinds(t, SENT_AS_TOM);
    expect(event.data).toEqual({ recipient: RECIPIENT, channel: CHANNEL, sha256, signedAt: signoff.signedAt });
    const [proposal] = await kinds(t, SEND_PROPOSAL);
    expect(proposal.data).toMatchObject({ status: "sent" });
    expect(await tom.query(api.ttsSignoff.listProposals, {})).toEqual([]);
  });

  it("propose → send with no signature is refused: nothing goes out, and the refusal is recorded", async () => {
    const t = convexTest(schema, modules);
    const posts = stubNetwork();

    const proposalId = await proposeSlack(t);
    const answer = await t.action(internal.ttsSignoff.internalSendProposal, { proposalId });
    expect(answer.sent).toBe(false);
    expect(answer.error).toContain(NO_SIGNOFF);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(slackPosts(posts).filter((p) => p.body.channel === "C0SARAH01")).toHaveLength(0);
    expect(await kinds(t, SENT_AS_TOM)).toHaveLength(0);
    const [refused] = await kinds(t, SEND_AS_TOM_FAILED);
    expect(refused.data).toMatchObject({ job: "send-as-tom", recipient: RECIPIENT, channel: CHANNEL });
    const [proposal] = await kinds(t, SEND_PROPOSAL);
    expect(proposal.data).toMatchObject({ status: "failed" });
  });
});

describe("the worker key cannot sign", () => {
  it("a proposal through the worker route writes a proposal and no sign-off", async () => {
    const t = convexTest(schema, modules);
    stubNetwork();
    await proposeSlack(t);
    expect(await signoffs(t)).toHaveLength(0);
    expect(await kinds(t, SEND_PROPOSAL)).toHaveLength(1);
  });

  it("signing is Tom's alone: no identity and another user are both refused", async () => {
    const t = convexTest(schema, modules);
    stubNetwork();
    const proposalId = await proposeSlack(t);
    await expect(t.mutation(api.ttsSignoff.signAndSend, { proposalId })).rejects.toThrow();
    const aliceId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "alice", email: "alice@example.com", role: "admin" }),
    );
    const alice = t.withIdentity({ subject: aliceId });
    await expect(alice.mutation(api.ttsSignoff.signAndSend, { proposalId })).rejects.toThrow(/restricted to Tom/);
    expect(await signoffs(t)).toHaveLength(0);
  });

  it("the worker's event route refuses the sign-off's own kinds", async () => {
    const t = convexTest(schema, modules);
    for (const kind of [SENT_AS_TOM, SEND_PROPOSAL, SEND_AS_TOM_FAILED]) {
      const res = await t.fetch("/tts/event", {
        method: "POST",
        headers: { "X-TTS-Key": KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ kind, data: { recipient: RECIPIENT, channel: CHANNEL } }),
      });
      expect(res.status).toBe(400);
    }
    expect(await kinds(t, SENT_AS_TOM)).toHaveLength(0);
  });

  it("the route refuses a caller without the key", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/tts/send-proposal", {
      method: "POST",
      headers: { "X-TTS-Key": "wrong", "Content-Type": "application/json" },
      body: JSON.stringify({ channel: CHANNEL, recipient: RECIPIENT, text: TEXT }),
    });
    expect(res.status).toBe(401);
  });

  it("nothing but signAndSend inserts into signoffs, and no HTTP route reaches it", () => {
    // The call tests above prove the doors that exist. This holds the
    // repository to it, so a door added later cannot write a sign-off
    // without this failing.
    const dir = __dirname;
    const sources = readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => ({ name, src: readFileSync(join(dir, name), "utf8") }));
    const writers = sources.flatMap(({ name, src }) =>
      [...src.matchAll(/insert\(\s*"signoffs"/g)].map(() => name),
    );
    expect(writers).toEqual(["ttsSignoff.ts"]);
    const own = sources.find((s) => s.name === "ttsSignoff.ts")?.src ?? "";
    const insertAt = own.indexOf('insert("signoffs"');
    const signAt = own.indexOf("export const signAndSend = mutation(");
    const nextExport = own.indexOf("export const", signAt + 1);
    expect(signAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(signAt);
    expect(insertAt).toBeLessThan(nextExport);
    const http = sources.find((s) => s.name === "http.ts")?.src ?? "";
    expect(http).not.toMatch(/signAndSend|"signoffs"/);
  });
});

describe("a signature covers one exact message", () => {
  it("is spent by its send: the same text again, unsigned, is refused", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const posts = stubNetwork();
    const first = await proposeSlack(t);
    await tom.mutation(api.ttsSignoff.signAndSend, { proposalId: first });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(slackPosts(posts)).toHaveLength(1);

    const second = await proposeSlack(t);
    const answer = await t.action(internal.ttsSignoff.internalSendProposal, { proposalId: second });
    expect(answer.error).toContain(NO_SIGNOFF);
    expect(slackPosts(posts).filter((p) => p.body.channel === "C0SARAH01")).toHaveLength(1);
  });

  it("a text changed after he signed matches nothing", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const posts = stubNetwork();
    const proposalId = await proposeSlack(t);
    await tom.mutation(api.ttsSignoff.signAndSend, { proposalId });
    // Between his press and the send, the row's text changes by one word.
    await t.run(async (ctx) => {
      const row = await ctx.db.get(proposalId);
      const data = row?.data as Record<string, unknown>;
      await ctx.db.patch(proposalId, { data: { ...data, text: TEXT.replace("Thursday", "Friday") } });
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(slackPosts(posts).filter((p) => p.body.channel === "C0SARAH01")).toHaveLength(0);
    expect(await kinds(t, SENT_AS_TOM)).toHaveLength(0);
  });

  it("a signature for one channel does not send on another", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const posts = stubNetwork();
    const proposalId = await proposeSlack(t);
    await tom.mutation(api.ttsSignoff.signAndSend, { proposalId });
    await t.run(async (ctx) => {
      const row = await ctx.db.get(proposalId);
      const data = row?.data as Record<string, unknown>;
      await ctx.db.patch(proposalId, { data: { ...data, channel: "slack:C0SOMEONE" } });
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(slackPosts(posts).filter((p) => p.body.channel !== "C0TTS")).toHaveLength(0);
  });

  it("decline sends nothing and leaves his list", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    stubNetwork();
    const proposalId = await proposeSlack(t);
    expect(await tom.query(api.ttsSignoff.listProposals, {})).toHaveLength(1);
    await tom.mutation(api.ttsSignoff.decline, { proposalId });
    expect(await tom.query(api.ttsSignoff.listProposals, {})).toEqual([]);
    expect(await tom.mutation(api.ttsSignoff.signAndSend, { proposalId })).toEqual({ signed: false, status: "declined" });
    expect(await signoffs(t)).toHaveLength(0);
  });
});

describe("a calendar event with guests is a message in his name", () => {
  const EVENT = {
    title: "Lab meeting",
    start: Date.UTC(2026, 9, 1, 19, 0),
    end: Date.UTC(2026, 9, 1, 20, 0),
    location: "Room 204",
    guests: ["Sarah@example.com", "bob@example.com"],
  };

  it("the calendar door with guests and no sign-off answers 403 and asks Google nothing", async () => {
    const t = convexTest(schema, modules);
    const posts = stubNetwork();
    const res = await t.fetch("/tts/calendar-event", {
      method: "POST",
      headers: { "X-TTS-Key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify(EVENT),
    });
    expect(res.status).toBe(403);
    expect(posts.filter((p) => p.url.includes("googleapis"))).toHaveLength(0);
  });

  it("guests that are not a list of strings answer 400 from the door's validator and ask Google nothing", async () => {
    const t = convexTest(schema, modules);
    const posts = stubNetwork();
    const res = await t.fetch("/tts/calendar-event", {
      method: "POST",
      headers: { "X-TTS-Key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ ...EVENT, guests: "sarah@example.com" }),
    });
    expect(res.status).toBe(400);
    expect(posts.filter((p) => p.url.includes("googleapis"))).toHaveLength(0);
  });

  it("propose → sign → the event is created with its guests invited", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const posts = stubNetwork();
    const res = await propose(t, { channel: CALENDAR_CHANNEL, event: EVENT });
    expect(res.status).toBe(200);
    expect(res.json.text).toBe(invitationText(EVENT));
    expect(res.json.recipient).toBe("bob@example.com, sarah@example.com");

    await tom.mutation(api.ttsSignoff.signAndSend, { proposalId: res.json.proposalId as Id<"dtsEvents"> });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const insert = posts.find((p) => p.url.includes("googleapis.com/calendar"));
    expect(insert?.url).toContain("sendUpdates=all");
    expect(insert?.body.attendees).toEqual([{ email: "Sarah@example.com" }, { email: "bob@example.com" }]);
    const [event] = await kinds(t, SENT_AS_TOM);
    expect(event.data).toMatchObject({ recipient: calendarRecipient(EVENT.guests), channel: CALENDAR_CHANNEL });
  });

  it("an event with no guests needs no sign-off, as before", async () => {
    const t = convexTest(schema, modules);
    const posts = stubNetwork();
    const { guests: _guests, ...alone } = EVENT;
    void _guests;
    const res = await t.fetch("/tts/calendar-event", {
      method: "POST",
      headers: { "X-TTS-Key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify(alone),
    });
    expect(res.status).toBe(200);
    const insert = posts.find((p) => p.url.includes("googleapis.com/calendar"));
    expect(insert?.url).not.toContain("sendUpdates");
    expect(insert?.body).not.toHaveProperty("attendees");
    expect(await kinds(t, SENT_AS_TOM)).toHaveLength(0);
  });

  it("the invitation text is every field a guest receives, in one order", () => {
    expect(invitationText({ ...EVENT, description: "Agenda: the draft." })).toBe(
      [
        "Title: Lab meeting",
        "When: 2026-10-01 15:00 to 16:00, New York time",
        "Where: Room 204",
        "Guests: bob@example.com, sarah@example.com",
        "",
        "Agenda: the draft.",
      ].join("\n"),
    );
  });
});

describe("the proposal route's shapes", () => {
  it("refuses what it cannot send", () => {
    expect(parseProposal({ channel: "email:sarah", recipient: "s", text: "t" })).toHaveProperty("error");
    expect(parseProposal({ channel: "slack:c0lower", recipient: "s", text: "t" })).toHaveProperty("error");
    expect(parseProposal({ channel: CHANNEL, text: "t" })).toHaveProperty("error");
    expect(parseProposal({ channel: CHANNEL, recipient: "s", text: "   " })).toHaveProperty("error");
    expect(parseProposal({ channel: CALENDAR_CHANNEL, text: "t", event: {} })).toHaveProperty("error");
    expect(
      parseProposal({ channel: CALENDAR_CHANNEL, event: { title: "x", start: 1, end: 2, guests: [] } }),
    ).toHaveProperty("error");
    expect(
      parseProposal({ channel: CALENDAR_CHANNEL, event: { title: "x", start: 1, end: 2, guests: ["not an email"] } }),
    ).toHaveProperty("error");
  });

  it("keeps a Slack text exactly as the agent wrote it", () => {
    const parsed = parseProposal({ channel: CHANNEL, recipient: ` ${RECIPIENT} `, text: `  ${TEXT}  ` });
    expect(parsed).toEqual({ proposal: { channel: CHANNEL, recipient: RECIPIENT, text: `  ${TEXT}  ` } });
  });
});

describe("a new proposal opens a #tts-needs-you thread that names who and where, never the text", () => {
  const NEEDS_YOU = "C0NEEDSYOU";

  /** Every line of the proposal's text, so a thread quoting any one of them
   *  is caught, not only one quoting all of it. */
  function expectNoTextOf(posted: string, text: string) {
    for (const line of text.split("\n").filter((l) => l.trim() !== "")) expect(posted).not.toContain(line.trim());
  }

  it("a Slack proposal posts one thread to #tts-needs-you naming its recipient and conversation", async () => {
    vi.stubEnv("SLACK_TTS_NEEDS_YOU_CHANNEL_ID", NEEDS_YOU);
    const t = convexTest(schema, modules);
    const posts = stubNetwork();
    const proposalId = await proposeSlack(t);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const threads = slackPosts(posts).filter((p) => p.body.channel === NEEDS_YOU);
    expect(threads).toHaveLength(1);
    const posted = String(threads[0].body.text);
    expect(posted).toContain(RECIPIENT);
    expect(posted).toContain("C0SARAH01");
    expect(posted).toContain("https://tom.quest/tts?tab=everything");
    expectNoTextOf(posted, TEXT);
    // Nothing went to the person it is for: the thread is Tom's, the send waits.
    expect(slackPosts(posts).filter((p) => p.body.channel === "C0SARAH01")).toHaveLength(0);

    const [marker] = await kinds(t, "needs-tom");
    expect(marker.key).toBe(`${SEND_PROPOSAL}:${proposalId}`);
    expect(marker.data).toEqual({ key: marker.key, proposalId, recipient: RECIPIENT, channel: CHANNEL });
  });

  it("a calendar proposal's thread names its guests and never the invitation text", async () => {
    vi.stubEnv("SLACK_TTS_NEEDS_YOU_CHANNEL_ID", NEEDS_YOU);
    const t = convexTest(schema, modules);
    const posts = stubNetwork();
    const event = {
      title: "Quarterly planning with the lab",
      start: Date.UTC(2026, 9, 2, 15, 0),
      end: Date.UTC(2026, 9, 2, 16, 0),
      description: "Bring the draft agenda and the budget numbers.",
      guests: ["sarah@example.com"],
    };
    const res = await propose(t, { channel: CALENDAR_CHANNEL, event });
    expect(res.status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const [thread] = slackPosts(posts).filter((p) => p.body.channel === NEEDS_YOU);
    const posted = String(thread.body.text);
    expect(posted).toContain("a calendar invitation");
    expect(posted).toContain("sarah@example.com");
    expect(posted).not.toContain(event.title);
    expectNoTextOf(posted, event.description);
    expect(posts.filter((p) => p.url.includes("googleapis"))).toHaveLength(0);
  });

  it("with the channel unset it posts nothing and says so on the one standing needs-you failure", async () => {
    const t = convexTest(schema, modules);
    const posts = stubNetwork();
    await proposeSlack(t);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(slackPosts(posts).filter((p) => p.body.channel === NEEDS_YOU)).toHaveLength(0);
    expect(await kinds(t, "needs-tom")).toHaveLength(0);
    // A job's report lives in the record's events table (convex/jarvis/jobs.ts).
    const [failed] = await t.run(async (ctx) =>
      ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "job-failed")).collect(),
    );
    expect(failed.subject).toBe("tts/needs-tom:needs-you-channel");
  });

  it("the thread's message passes the form every Slack message is held to", () => {
    for (const channel of [CHANNEL, CALENDAR_CHANNEL]) {
      const message = composeProposalAsk({ recipient: RECIPIENT, channel });
      expect(checkMessage(message, { canReply: false })).toEqual([]);
    }
    const long = composeProposalAsk({ recipient: "x".repeat(200), channel: CHANNEL });
    expect(checkMessage(long, { canReply: false })).toEqual([]);
    expect(long.firstLine).not.toContain("x".repeat(200));
  });
});
