import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// Standing rulings (convex/jarvis/rulings.ts): the write door that checks his
// sentence against the thread message it cites, the ask reader that hands an
// asker the rulings standing in its scopes, and the new-information door that
// ends one and puts it on the next digest.

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

type T = ReturnType<typeof convexTest>;

const KEY = { "X-Jarvis-Key": "k" };
const JSON_HEADERS = { "Content-Type": "application/json", ...KEY };

const post = (t: T, path: string, body: unknown, headers: Record<string, string> = JSON_HEADERS) =>
  t.fetch(path, { method: "POST", headers, body: JSON.stringify(body) });

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** One message of his on /thread, written through the page's own door. */
async function threadMessage(t: T, text: string): Promise<string> {
  const id = await t.run(async (ctx) => ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }));
  const { id: messageId } = await t.withIdentity({ subject: id }).mutation(api.thread.send, { text });
  return messageId;
}

const HIS_MESSAGE =
  "I dont want to have to say yes multiple times. if I say it is good once then that holds as long as there is not new information that would probably change my ruling if I understood it.";

/** A standing ruling through the door; answers its id. */
async function rule(t: T, scope: string, sentence: string, provenance: Record<string, string>): Promise<string> {
  const res = await post(t, "/jarvis/standing-ruling", {
    sentence,
    scope,
    question: `May Jarvis proceed in ${scope}?`,
    provenance,
  });
  expect(res.status).toBe(200);
  return (await res.json()).id;
}

async function standing(t: T, scopes: string[]): Promise<{ id: string; scope: string; sentence: string }[]> {
  const query = new URLSearchParams({ for: "ask", job: "work-queue" });
  for (const scope of scopes) query.append("scope", scope);
  const res = await t.fetch(`/jarvis/context?${query.toString()}`, { headers: KEY });
  expect(res.status).toBe(200);
  return (await res.json()).standingRulings;
}

const eventRow = (t: T, id: string) =>
  t.run(async (ctx) => {
    const key = ctx.db.normalizeId("events", id);
    return key === null ? null : await ctx.db.get(key);
  });

describe("POST /jarvis/standing-ruling", () => {
  it("writes his sentence verbatim with its scope, question and thread message, standing", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const messageId = await threadMessage(t, HIS_MESSAGE);
    const id = await rule(t, "repo:Jarvis", "if I say it is good once then that holds", { threadMessageId: messageId });
    const row = await eventRow(t, id);
    expect(row).toMatchObject({
      kind: "ruling",
      subject: "repo:Jarvis",
      text: "if I say it is good once then that holds",
      data: {
        sentence: "if I say it is good once then that holds",
        scope: "repo:Jarvis",
        question: "May Jarvis proceed in repo:Jarvis?",
        provenance: { threadMessageId: messageId },
        standing: true,
      },
    });
  });

  it("answers a retry after a lost response with the first row's id, so superseding that id leaves no copy standing", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const messageId = await threadMessage(t, HIS_MESSAGE);
    const body = {
      sentence: "if I say it is good once then that holds",
      scope: "repo:Jarvis",
      question: "May Jarvis land without asking again?",
      provenance: { threadMessageId: messageId },
    };
    // The first post is written; its answer is taken to be lost on the way
    // back, so the worker posts the same body again.
    const first = await post(t, "/jarvis/standing-ruling", body);
    expect(await first.json()).toMatchObject({ ok: true, duplicate: false });
    const retry = await post(t, "/jarvis/standing-ruling", body);
    expect(retry.status).toBe(200);
    const answer = await retry.json();
    expect(answer.duplicate).toBe(true);
    const rulings = async () =>
      t.run(async (ctx) => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "ruling")).collect());
    expect((await rulings()).map((row) => row._id)).toEqual([answer.id]);
    expect((await rulings())[0].data).toMatchObject({ id: expect.stringMatching(/^ruling:[0-9a-f]{64}$/) });

    // Superseding the id the retry returned ends the one ruling there is.
    const later = await rule(t, "repo:Jarvis", "it is good once", { threadMessageId: messageId });
    expect((await post(t, "/jarvis/standing-ruling/new-information", { rulingId: answer.id, type: "sentence", id: later })).status).toBe(200);
    expect((await standing(t, ["repo:Jarvis"])).map((one) => one.id)).toEqual([later]);
    // A retry arriving after the supersession is still the first row, and
    // does not bring a standing copy back.
    expect(await (await post(t, "/jarvis/standing-ruling", body)).json()).toMatchObject({ id: answer.id, duplicate: true });
    expect((await standing(t, ["repo:Jarvis"])).map((one) => one.id)).toEqual([later]);

    // The same sentence in another scope, or from another source, is a new ruling.
    expect(await (await post(t, "/jarvis/standing-ruling", { ...body, scope: "all" })).json()).toMatchObject({ duplicate: false });
    expect(await (await post(t, "/jarvis/standing-ruling", { ...body, provenance: { session: "aaa9ae16" } })).json()).toMatchObject({ duplicate: false });
  });

  it("keeps two rulings apart whose source and scope would spell the same key joined by a colon", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const sentence = "the same words";
    const one = await post(t, "/jarvis/standing-ruling", { sentence, scope: "part:all", question: "q", provenance: { session: "a" } });
    const two = await post(t, "/jarvis/standing-ruling", { sentence, scope: "all", question: "q", provenance: { session: "a:part" } });
    const first = await one.json();
    const second = await two.json();
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(second).toMatchObject({ ok: true, duplicate: false });
    expect(second.id).not.toBe(first.id);
    const rows = await t.run(async (ctx) => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "ruling")).collect());
    expect(rows.map((row) => [row.subject, (row.data as { provenance: unknown }).provenance])).toEqual([
      ["part:all", { session: "a" }],
      ["all", { session: "a:part" }],
    ]);
    expect(new Set(rows.map((row) => (row.data as { id: string }).id)).size).toBe(2);
  });

  it("refuses a sentence the cited thread message does not hold, and an id that is not a thread message", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const messageId = await threadMessage(t, HIS_MESSAGE);
    const body = { sentence: "ship everything without asking", scope: "all", question: "q", provenance: { threadMessageId: messageId } };
    const wrong = await post(t, "/jarvis/standing-ruling", body);
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toContain("verbatim");
    const other = await rule(t, "all", "that holds", { threadMessageId: messageId });
    const notMessage = await post(t, "/jarvis/standing-ruling", { ...body, sentence: "that holds", provenance: { threadMessageId: other } });
    expect(notMessage.status).toBe(400);
    expect((await notMessage.json()).error).toContain("no thread message");
  });

  it("takes a session as provenance on the poster's word", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const id = await rule(t, "class:mockup", "mockups can land on checks alone", { session: "aaa9ae16" });
    expect(await eventRow(t, id)).toMatchObject({ provenance: { session: "aaa9ae16" }, data: { provenance: { session: "aaa9ae16" } } });
  });

  it("refuses a bad scope, a provenance naming both or neither, and a missing field", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const base = { sentence: "s", scope: "all", question: "q", provenance: { session: "a" } };
    const badScope = await post(t, "/jarvis/standing-ruling", { ...base, scope: "repo:Elsewhere" });
    expect(badScope.status).toBe(400);
    expect((await badScope.json()).error).toContain("data.scope");
    expect((await post(t, "/jarvis/standing-ruling", { ...base, provenance: { session: "a", threadMessageId: "b" } })).status).toBe(400);
    expect((await post(t, "/jarvis/standing-ruling", { ...base, provenance: {} })).status).toBe(400);
    expect((await post(t, "/jarvis/standing-ruling", { ...base, question: "" })).status).toBe(400);
    expect((await post(t, "/jarvis/standing-ruling", base, { "Content-Type": "application/json" })).status).toBe(401);
    expect(await t.run(async (ctx) => ctx.db.query("events").collect())).toEqual([]);
  });

  it("is the only door: both worker event routes refuse a ruling", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("TTS_WORKER_KEY", "k");
    const data = { id: `ruling:${"00".repeat(32)}`, sentence: "s", scope: "all", question: "q", provenance: { session: "a" }, standing: true };
    const jarvis = await post(t, "/jarvis/event", { kind: "ruling", subject: "all", data });
    expect(jarvis.status).toBe(403);
    expect((await jarvis.json()).error).toContain("POST /jarvis/standing-ruling");
    const old = await post(t, "/tts/event", { kind: "ruling", key: "all", data }, { "Content-Type": "application/json", "X-TTS-Key": "k" });
    expect(old.status).toBe(403);
    expect(await t.run(async (ctx) => ctx.db.query("events").collect())).toEqual([]);
    expect(await t.run(async (ctx) => ctx.db.query("dtsEvents").collect())).toEqual([]);
  });
});

describe("the ask reader's standing rulings", () => {
  it("answers the rulings in each scope asked and in all, newest first, and no other scope's", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const jarvis = await rule(t, "repo:Jarvis", "jarvis yes", { session: "a" });
    vi.setSystemTime(1_700_000_001_000);
    const delegate = await rule(t, "part:delegate", "delegate yes", { session: "a" });
    vi.setSystemTime(1_700_000_002_000);
    const all = await rule(t, "all", "all yes", { session: "a" });
    vi.setSystemTime(1_700_000_003_000);
    await rule(t, "repo:WikiTom", "wikitom yes", { session: "a" });
    vi.useRealTimers();

    expect((await standing(t, ["repo:Jarvis"])).map((one) => one.id)).toEqual([all, jarvis]);
    expect((await standing(t, ["repo:Jarvis", "part:delegate"])).map((one) => one.id)).toEqual([all, delegate, jarvis]);
    expect((await standing(t, [])).map((one) => one.id)).toEqual([all]);
    const [first] = await standing(t, ["part:delegate"]);
    expect(first).toMatchObject({ id: all, scope: "all", sentence: "all yes", question: "May Jarvis proceed in all?", provenance: { session: "a" } });
  });

  it("refuses a scope off the four forms", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const res = await t.fetch("/jarvis/context?for=ask&job=work-queue&scope=delegate", { headers: KEY });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('scope "delegate"');
  });
});

describe("POST /jarvis/standing-ruling/new-information", () => {
  it("a later sentence in the same scope supersedes the earlier ruling, which leaves the reader and goes on the digest", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const earlier = await rule(t, "repo:Jarvis", "land it", { session: "a" });
    const later = await rule(t, "repo:Jarvis", "wait for me", { session: "b" });
    const res = await post(t, "/jarvis/standing-ruling/new-information", { rulingId: earlier, type: "sentence", id: later });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, rulingId: earlier, supersededBy: later, listed: true });
    expect((await eventRow(t, earlier))?.data).toMatchObject({ standing: false, supersededBy: later, sentence: "land it" });
    expect((await standing(t, ["repo:Jarvis"])).map((one) => one.id)).toEqual([later]);

    const lines = await t.run(async (ctx) =>
      ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "digest-line")).collect(),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].subject).toBe(earlier);
    expect(lines[0].data).toMatchObject({ section: "superseded", rulingId: earlier });
    expect((lines[0].data as { statement: string }).statement).toMatch(
      /^Your ruling of \d{4}-\d{2}-\d{2} in scope repo:Jarvis no longer stands, because a later sentence of yours in the same scope replaced it: "wait for me"; it said "land it"\.$/,
    );

    // The same post again is a retry, not a second supersession.
    const again = await post(t, "/jarvis/standing-ruling/new-information", { rulingId: earlier, type: "sentence", id: later });
    expect(await again.json()).toEqual({ ok: true, rulingId: earlier, supersededBy: later, listed: false, duplicate: true });
  });

  it("refuses a later sentence in another scope, an earlier one, the ruling itself, and a ruling already superseded", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const older = await rule(t, "repo:Jarvis", "older", { session: "a" });
    vi.setSystemTime(1_700_000_001_000);
    const ruling = await rule(t, "repo:Jarvis", "land it", { session: "a" });
    vi.setSystemTime(1_700_000_002_000);
    const elsewhere = await rule(t, "repo:WikiTom", "elsewhere", { session: "a" });
    const later = await rule(t, "repo:Jarvis", "later", { session: "a" });
    vi.useRealTimers();
    const send = (id: string, rulingId = ruling) =>
      post(t, "/jarvis/standing-ruling/new-information", { rulingId, type: "sentence", id });
    for (const id of [elsewhere, older, ruling]) {
      const res = await send(id);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("same scope");
    }
    expect((await send(later)).status).toBe(200);
    const twice = await send(later, ruling);
    expect((await twice.json()).duplicate).toBe(true);
    // A ruling that no longer stands cannot be superseded by another row,
    // and a superseded ruling cannot end another.
    const ended = await post(t, "/jarvis/standing-ruling/new-information", { rulingId: ruling, type: "sentence", id: elsewhere });
    expect(ended.status).toBe(400);
    expect((await ended.json()).error).toContain("no longer stands");
    expect((await send(ruling, older)).status).toBe(400);
  });

  it("records a diagnosis or a measure row in scope, and refuses one out of scope or of the wrong kind", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const delegate = await rule(t, "part:delegate", "the delegate may decide merges", { session: "a" });
    const all = await rule(t, "all", "keep going overnight", { session: "a" });
    // The diagnosis and quality-check kinds are not on the posted list yet;
    // their rows are written here directly, in the shape this door reads.
    const [inScope, outOfScope, measure] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.insert("events", { kind: "diagnosis", at: Date.now(), provenance: {}, subject: "part:delegate", data: {} }),
        ctx.db.insert("events", { kind: "diagnosis", at: Date.now(), provenance: {}, subject: "part:audit", data: {} }),
        ctx.db.insert("events", { kind: "quality-check", at: Date.now(), provenance: {}, subject: "part:audit", data: {} }),
      ]),
    );
    const send = (rulingId: string, type: string, id: string) =>
      post(t, "/jarvis/standing-ruling/new-information", { rulingId, type, id });

    const wrongScope = await send(delegate, "diagnosis", outOfScope);
    expect(wrongScope.status).toBe(400);
    expect((await wrongScope.json()).error).toContain("in scope part:delegate");
    const wrongKind = await send(delegate, "measure", inScope);
    expect(wrongKind.status).toBe(400);
    expect((await wrongKind.json()).error).toContain("quality-check");
    expect((await send(delegate, "verdict", inScope)).status).toBe(400);

    expect((await send(delegate, "diagnosis", inScope)).status).toBe(200);
    // A ruling scoped "all" takes a measure of any subject.
    expect((await send(all, "measure", measure)).status).toBe(200);
    expect(await standing(t, ["part:delegate"])).toEqual([]);
    const lines = await t.run(async (ctx) =>
      ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "digest-line")).collect(),
    );
    expect(lines.map((line) => (line.data as { statement: string }).statement)).toEqual([
      expect.stringContaining(`because a diagnosis named a defect in this scope (${inScope})`),
      expect.stringContaining(`because a measure you set a target on crossed it (${measure})`),
    ]);
  });

  it("names a ruling the record does not hold", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const later = await rule(t, "all", "later", { session: "a" });
    const res = await post(t, "/jarvis/standing-ruling/new-information", { rulingId: "nope", type: "sentence", id: later });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("no ruling nope in the record");
  });
});
