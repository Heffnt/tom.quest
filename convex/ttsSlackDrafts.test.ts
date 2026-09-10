import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { SLACK_DRAFT_REQUEST } from "./ttsSlackDrafts";
import { DIGEST_SENT, SLACK_SENT } from "./ttsDigest";
import { TAB_EVERYTHING, itemUrl } from "./ttsCompose";
import { ttsDayKey } from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// 2026-09-05 05:00 EDT — the morning message's instant.
const FIVE_AM = Date.UTC(2026, 8, 5, 9);
const DAY_KEY = "2026-09-05";
const DAY = 86_400_000;

async function withTom(t: ReturnType<typeof convexTest>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}

function stubSlack() {
  const slack: { channel: string; text: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (typeof url === "string" && url.startsWith("https://api.github.com/")) {
        return { ok: false, status: 403, json: async () => [] };
      }
      const body = JSON.parse(init?.body ?? "{}") as { channel: string; text: string };
      slack.push({ channel: body.channel, text: body.text });
      return { ok: true, status: 200, json: async () => ({ ok: true, ts: `${slack.length}.0` }) };
    }),
  );
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
  vi.stubEnv("SLACK_TTS_CHANNEL_ID", "C0TTS");
  vi.stubEnv("GITHUB_MIRROR_TOKEN", undefined);
  return slack;
}

async function openRequests(t: ReturnType<typeof convexTest>) {
  return await t.query(internal.ttsSlackDrafts.internalOpenDraftRequests, {});
}

// ── The Fable-written morning message (Tom 2026-09-09, amendment 2) ──────────
// "Each morning message is written by a Fable agent, not filled into a
// template." Convex gathers the facts and opens a request; the box writes it;
// a mechanical verifier decides whether it may be posted; and if nothing
// acceptable arrives the template goes out, so the morning is never silent.
describe("the morning message's writer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  async function openMorning(t: ReturnType<typeof convexTest>) {
    const tom = await withTom(t);
    await tom.mutation(api.tts.createTodo, {
      statement: "pay rent",
      entryAction: "open the bank app",
      dueAt: FIVE_AM - DAY,
    });
    return tom;
  }

  it("opens a request carrying the facts and posts nothing yet", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await openMorning(t);
    const slack = stubSlack();

    await t.action(internal.ttsSync.sendToday, {});

    // NOTHING IS POSTED YET: the writer has five minutes.
    expect(slack).toHaveLength(0);
    const open = await openRequests(t);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ requestId: `today:${DAY_KEY}`, kind: "today", attempts: 0 });
    // The facts, each with an id, its link and its numbers — the transcript's
    // record of what the writer was given.
    expect(open[0].facts.facts.map((f: { id: string }) => f.id)).toContain("today:count");
    // And the day is not marked sent: nothing has reached Tom.
    const rows = await t.run(async (ctx) => ctx.db.query("dtsEvents").collect());
    expect(rows.filter((e) => e.kind === DIGEST_SENT)).toHaveLength(0);
    expect(rows.filter((e) => e.kind === SLACK_DRAFT_REQUEST)).toHaveLength(1);
  });

  // THE NUMBERING RIDES WITH THE REQUEST. A threaded "revert 2" is resolved
  // against the digest-sent row the morning wrote (convex/ttsSlack.ts
  // namedObjection), and the WRITER path is the default one — so a request
  // that carries no objectionAskIds means every numbered objection Tom types
  // is silently captured as a fresh todo instead.
  // witness: drop objectionAskIds from sendToday's `marks`.
  it("carries the objection list's numbering through to the day it marks sent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await openMorning(t);
    stubSlack();
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: FIVE_AM - 3600_000,
        kind: "delegate-decision",
        key: "ask-1",
        data: { askId: "ask-1", decision: "moved the appointment", refused: false },
      });
    });

    await t.action(internal.ttsSync.sendToday, {});
    const [request] = await openRequests(t);
    // The MARKS ride on the request ROW, not in what the box is served: the
    // writer has no use for them and the send does.
    const [row] = await t.run(async (ctx) =>
      (await ctx.db.query("dtsEvents").collect()).filter((e) => e.kind === SLACK_DRAFT_REQUEST),
    );
    expect((row.data as { marks: { objectionAskIds?: string[] } }).marks.objectionAskIds).toEqual([
      "ask-1",
    ]);

    // …and it survives the FLOOR, the template the timeout posts, which
    // marks the day from this same row.
    await t.mutation(internal.ttsSlackDrafts.internalFallbackSlackDraft, {
      requestId: request.requestId,
      reason: "the writer did not answer",
    });
    await t.action(internal.ttsSync.sendSlackDraft, { requestId: request.requestId });
    const marked = await t.run(async (ctx) =>
      (await ctx.db.query("dtsEvents").collect()).filter((e) => e.kind === DIGEST_SENT),
    );
    expect(marked).toHaveLength(1);
    expect((marked[0].data as { objectionAskIds?: string[] }).objectionAskIds).toEqual(["ask-1"]);
  });

  it("posts an accepted draft and records that Fable wrote it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await openMorning(t);
    const slack = stubSlack();
    await t.action(internal.ttsSync.sendToday, {});
    const [request] = await openRequests(t);
    const todoFact = request.facts.facts.find((f: { id: string }) => f.id.startsWith("todo:")) as {
      id: string;
      urls: string[];
    };

    const accepted = await t.mutation(internal.ttsSlackDrafts.internalSubmitSlackDraft, {
      requestId: request.requestId,
      draft: {
        firstLine: "One thing carries a date you have passed; the rent is the one to start with.",
        firstLineSources: ["today:count"],
        lines: [
          {
            role: "item",
            text: "Pay the rent: open the bank app. One day late.",
            url: todoFact.urls[0],
            sources: [todoFact.id],
          },
        ],
      },
    });
    expect(accepted).toEqual({ accepted: true });

    // The delivery is a scheduled ACTION (the network call); driving it here
    // is the same one line the settle wrote.
    await t.action(internal.ttsSync.sendSlackDraft, { requestId: request.requestId });
    expect(slack).toHaveLength(1);
    expect(slack[0].text).toContain("Pay the rent: open the bank app.");
    const rows = await t.run(async (ctx) => ctx.db.query("dtsEvents").collect());
    const sent = rows.filter((e) => e.kind === SLACK_SENT);
    expect(sent).toHaveLength(1);
    const marked = rows.filter((e) => e.kind === DIGEST_SENT);
    expect(marked).toHaveLength(1);
    expect(marked[0].data).toMatchObject({ day: DAY_KEY, writtenBy: "fable" });
    // THE FACTS BLOCK rides the same row, so the transcript shows the inputs
    // beside the message they produced.
    expect((marked[0].data as { facts: { kind: string } }).facts.kind).toBe("today");
    // The request is settled: nothing is open for a second run to write.
    expect(await openRequests(t)).toHaveLength(0);
  });

  it("refuses an invented number and hands back the complaint for one repair turn", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await openMorning(t);
    const slack = stubSlack();
    await t.action(internal.ttsSync.sendToday, {});
    const [request] = await openRequests(t);

    const refused = await t.mutation(internal.ttsSlackDrafts.internalSubmitSlackDraft, {
      requestId: request.requestId,
      draft: {
        firstLine: "Nine things carry a date you have passed.",
        firstLineSources: ["today:count"],
        lines: [
          {
            role: "item",
            text: "667 other items are ready, and not one of them is dated.",
            url: TAB_EVERYTHING,
            sources: ["today:count"],
          },
        ],
      },
    });
    expect(refused).toMatchObject({ accepted: false, final: false });
    expect((refused as { complaints: string[] }).complaints.join(" ")).toContain(
      "uses the number 667, which is in no fact it cites",
    );
    expect(slack).toHaveLength(0);

    // The complaint comes back with the request, which is what the one repair
    // turn is written against.
    const [again] = await openRequests(t);
    expect(again.attempts).toBe(1);
    expect(again.complaints.join(" ")).toContain("uses the number 667");
  });

  it("is final on the second refusal, and the timeout posts the template", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await openMorning(t);
    const slack = stubSlack();
    await t.action(internal.ttsSync.sendToday, {});
    const [request] = await openRequests(t);

    const bad = {
      firstLine: "A first line with no full stop and a link https://example.invalid/x",
      firstLineSources: [],
      lines: [{ role: "item", text: "+667 more", url: itemUrl("nope"), sources: [] }],
    };
    await t.mutation(internal.ttsSlackDrafts.internalSubmitSlackDraft, {
      requestId: request.requestId,
      draft: bad,
    });
    const second = await t.mutation(internal.ttsSlackDrafts.internalSubmitSlackDraft, {
      requestId: request.requestId,
      draft: bad,
    });
    expect(second).toMatchObject({ accepted: false, final: true });
    expect(slack).toHaveLength(0);
    // Nothing is open any more: the request has spent its attempts.
    expect(await openRequests(t)).toHaveLength(0);

    // THE FLOOR. The scheduled timeout posts the plain template, and the row
    // says so, so an eval can count how often the writer missed.
    await t.mutation(internal.ttsSlackDrafts.internalFallbackSlackDraft, {
      requestId: request.requestId,
      reason: "the writer had two goes",
    });
    // The delivery is a scheduled ACTION (the network call); driving it here
    // is the same one line the settle wrote.
    await t.action(internal.ttsSync.sendSlackDraft, { requestId: request.requestId });
    expect(slack).toHaveLength(1);
    expect(slack[0].text).toContain("Pay rent: open the bank app.");
    const rows = await t.run(async (ctx) => ctx.db.query("dtsEvents").collect());
    const marked = rows.filter((e) => e.kind === DIGEST_SENT);
    expect(marked).toHaveLength(1);
    expect(marked[0].data).toMatchObject({ day: DAY_KEY, writtenBy: "template" });
  });

  it("posts once when an accepted draft and its timeout both fire", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await openMorning(t);
    const slack = stubSlack();
    await t.action(internal.ttsSync.sendToday, {});
    const [request] = await openRequests(t);
    const todoFact = request.facts.facts.find((f: { id: string }) => f.id.startsWith("todo:")) as {
      id: string;
      urls: string[];
    };

    await t.mutation(internal.ttsSlackDrafts.internalSubmitSlackDraft, {
      requestId: request.requestId,
      draft: {
        firstLine: "One thing carries a date you have passed.",
        firstLineSources: ["today:count"],
        lines: [
          {
            role: "item",
            text: "Pay the rent: open the bank app.",
            url: todoFact.urls[0],
            sources: [todoFact.id],
          },
        ],
      },
    });
    // The timeout runs anyway — a settled request ignores it.
    await t.mutation(internal.ttsSlackDrafts.internalFallbackSlackDraft, {
      requestId: request.requestId,
      reason: "the five minutes are up",
    });
    // The delivery is a scheduled ACTION (the network call); driving it here
    // is the same one line the settle wrote.
    await t.action(internal.ttsSync.sendSlackDraft, { requestId: request.requestId });
    expect(slack).toHaveLength(1);
    const rows = await t.run(async (ctx) => ctx.db.query("dtsEvents").collect());
    expect(rows.filter((e) => e.kind === DIGEST_SENT)).toHaveLength(1);
  });

  it("posts the template immediately when the writer is switched off", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await openMorning(t);
    const slack = stubSlack();
    vi.stubEnv("TTS_MORNING_WRITER", "off");

    await t.action(internal.ttsSync.sendToday, {});
    expect(slack).toHaveLength(1);
    expect(await openRequests(t)).toHaveLength(0);
    const rows = await t.run(async (ctx) => ctx.db.query("dtsEvents").collect());
    expect(rows.filter((e) => e.kind === DIGEST_SENT)[0].data).toMatchObject({
      writtenBy: "template",
    });
  });

  it("opens exactly one request a day, however many times the cron runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIVE_AM);
    const t = convexTest(schema, modules);
    await openMorning(t);
    stubSlack();
    await t.action(internal.ttsSync.sendToday, {});
    await t.action(internal.ttsSync.sendToday, { force: true });
    const rows = await t.run(async (ctx) => ctx.db.query("dtsEvents").collect());
    expect(rows.filter((e) => e.kind === SLACK_DRAFT_REQUEST)).toHaveLength(1);
    expect(rows.filter((e) => e.kind === SLACK_DRAFT_REQUEST)[0].key).toBe(
      `today:${ttsDayKey(FIVE_AM)}`,
    );
  });
});
