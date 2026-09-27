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
  SEND_AS_TOM_UNKNOWN,
  SEND_PROPOSAL,
  SENT_AS_TOM,
  calendarRecipient,
  invitationText,
  parseProposal,
  sha256Hex,
} from "./ttsSignoff";
import { checkMessage, composeProposalAsk } from "./ttsCompose";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// A switch that makes the record of a finished send throw, so a test can
// show that a send which went out is never classified by its record's fault.
const sentRecord = vi.hoisted(() => ({ fails: false }));
vi.mock("./tts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tts")>();
  const logEvent: typeof actual.logEvent = async (ctx, kind, ...rest) => {
    if (sentRecord.fails && kind === "sent-as-tom") throw new Error("the record is down");
    return await actual.logEvent(ctx, kind, ...rest);
  };
  return { ...actual, logEvent };
});

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

describe("a signed send goes out at most once", () => {
  /** Slack's post behaves as `slack` says; everything else as stubNetwork. */
  function stubSlack(slack: () => Response): Post[] {
    const posts = stubNetwork();
    const answer = vi.mocked(fetch).getMockImplementation()!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (!String(url).includes("slack.com")) return await answer(url, init);
        posts.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return slack();
      }),
    );
    return posts;
  }

  it("a dropped answer is not retried, and the claim is kept, so the text cannot go again", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const posts = stubSlack(() => {
      throw new Error("socket hang up");
    });
    const proposalId = await proposeSlack(t);
    await tom.mutation(api.ttsSignoff.signAndSend, { proposalId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(slackPosts(posts).filter((p) => p.body.channel === "C0SARAH01")).toHaveLength(1);
    const [signoff] = await signoffs(t);
    expect(signoff.usedAt).toBeTypeOf("number");
    // Recorded as unknown, not failed, and put in front of Tom.
    const [proposal] = await kinds(t, SEND_PROPOSAL);
    expect(proposal.data).toMatchObject({ status: "unknown" });
    expect(await kinds(t, SEND_AS_TOM_FAILED)).toHaveLength(0);
    expect(await kinds(t, SEND_AS_TOM_UNKNOWN)).toHaveLength(1);
    const broken = await t.run(async (ctx) =>
      ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "digest-line")).collect(),
    );
    expect(broken.map((row) => (row.data as { section: string; statement: string }))).toEqual([
      expect.objectContaining({ section: "broken", statement: expect.stringContaining(`to ${RECIPIENT} may or may not have gone out`) }),
    ]);
    // He cannot sign it again (no fresh sign-off is minted), and a stray send is refused.
    expect(await tom.mutation(api.ttsSignoff.signAndSend, { proposalId })).toEqual({ signed: false, status: "unknown" });
    expect(await signoffs(t)).toHaveLength(1);
    const again = await t.action(internal.ttsSignoff.internalSendProposal, { proposalId });
    expect(again.error).toContain(NO_SIGNOFF);
    expect(slackPosts(posts).filter((p) => p.body.channel === "C0SARAH01")).toHaveLength(1);
    // Clearing it sends nothing.
    expect(await tom.mutation(api.ttsSignoff.decline, { proposalId })).toEqual({ declined: true, status: "declined" });
  });

  it("a send that went out but whose record failed is unknown, never failed, and is not signed again", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const posts = stubNetwork();
    const proposalId = await proposeSlack(t);
    sentRecord.fails = true;
    try {
      await tom.mutation(api.ttsSignoff.signAndSend, { proposalId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      sentRecord.fails = false;
    }
    expect(slackPosts(posts).filter((p) => p.body.channel === "C0SARAH01")).toHaveLength(1);
    const [proposal] = await kinds(t, SEND_PROPOSAL);
    expect(proposal.data).toMatchObject({ status: "unknown" });
    expect(await kinds(t, SEND_AS_TOM_UNKNOWN)).toHaveLength(1);
    expect(await tom.mutation(api.ttsSignoff.signAndSend, { proposalId })).toEqual({ signed: false, status: "unknown" });
    expect(await signoffs(t)).toHaveLength(1);
  });

  it("two unknown sends of one text to two recipients are two digest lines", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    stubSlack(() => {
      throw new Error("socket hang up");
    });
    for (const recipient of ["Sarah Chen", "Bob Li"]) {
      const res = await propose(t, { channel: CHANNEL, recipient, text: TEXT, agentId: "claude:box:abcdef0123456789" });
      await tom.mutation(api.ttsSignoff.signAndSend, { proposalId: res.json.proposalId as Id<"dtsEvents"> });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    }
    const lines = await t.run(async (ctx) =>
      ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "digest-line")).collect(),
    );
    expect(lines.map((row) => (row.data as { statement: string }).statement)).toEqual([
      expect.stringContaining("to Sarah Chen may or may not"),
      expect.stringContaining("to Bob Li may or may not"),
    ]);
  });

  it("Slack's own refusal releases the claim: nothing went out", async () => {
    const t = convexTest(schema, modules);
    const tom = await withTom(t);
    const posts = stubSlack(() => Response.json({ ok: false, error: "channel_not_found" }));
    const proposalId = await proposeSlack(t);
    await tom.mutation(api.ttsSignoff.signAndSend, { proposalId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(slackPosts(posts).filter((p) => p.body.channel === "C0SARAH01")).toHaveLength(1);
    const [signoff] = await signoffs(t);
    expect(signoff.usedAt).toBeUndefined();
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

  it("a Google 5xx on the insert keeps the claim, a 4xx releases it", async () => {
    for (const [status, kept] of [[503, true], [400, false]] as const) {
      const t = convexTest(schema, modules);
      const tom = await withTom(t);
      stubNetwork();
      const answer = vi.mocked(fetch).getMockImplementation()!;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
          String(url).includes("googleapis.com/calendar") ? new Response("no", { status }) : await answer(url, init),
        ),
      );
      const res = await propose(t, { channel: CALENDAR_CHANNEL, event: EVENT });
      await tom.mutation(api.ttsSignoff.signAndSend, { proposalId: res.json.proposalId as Id<"dtsEvents"> });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const [signoff] = await signoffs(t);
      expect(signoff.usedAt !== undefined).toBe(kept);
      const [proposal] = await kinds(t, SEND_PROPOSAL);
      expect(proposal.data).toMatchObject({ status: kept ? "unknown" : "failed" });
      vi.unstubAllGlobals();
    }
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

describe("a new proposal opens a needs-you reply under the digest that names who and where, never the text", () => {
  /** Every line of the proposal's text, so a reply quoting any one of them
   *  is caught, not only one quoting all of it. */
  function expectNoTextOf(posted: string, text: string) {
    for (const line of text.split("\n").filter((l) => l.trim() !== "")) expect(posted).not.toContain(line.trim());
  }

  /** The needs-you rows the box posts from (convex/jarvis/digest.ts). */
  const opened = async (t: ReturnType<typeof convexTest>) =>
    await t.run(async (ctx) =>
      (await ctx.db.query("events").collect()).filter((row) => row.kind === "needs-you-opened"),
    );

  it("a Slack proposal opens one needs-you naming its recipient and conversation, and posts nothing itself", async () => {
    const t = convexTest(schema, modules);
    const posts = stubNetwork();
    const proposalId = await proposeSlack(t);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const rows = await opened(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: `${SEND_PROPOSAL}:${proposalId}`, data: { job: SEND_PROPOSAL } });
    const posted = String(rows[0].text);
    expect(posted).toContain(RECIPIENT);
    expect(posted).toContain("C0SARAH01");
    expect(posted).toContain("https://tom.quest/tts?tab=everything");
    expectNoTextOf(posted, TEXT);
    // Nothing reached Slack from Convex: the box posts it under the digest,
    // and nothing went to the person it is for — the send waits.
    expect(slackPosts(posts)).toHaveLength(0);

    const [marker] = await kinds(t, "needs-tom");
    expect(marker.key).toBe(`${SEND_PROPOSAL}:${proposalId}`);
    expect(marker.data).toEqual({ key: marker.key, proposalId, recipient: RECIPIENT, channel: CHANNEL });
  });

  it("a calendar proposal's reply names its guests and never the invitation text", async () => {
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

    const [row] = await opened(t);
    const posted = String(row.text);
    expect(posted).toContain("a calendar invitation");
    expect(posted).toContain("sarah@example.com");
    expect(posted).not.toContain(event.title);
    expectNoTextOf(posted, event.description);
    expect(posts.filter((p) => p.url.includes("googleapis"))).toHaveLength(0);
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
