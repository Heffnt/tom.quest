import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const KEY = { "X-TTS-Key": "s3cret", "Content-Type": "application/json" };
const COMMIT = "b".repeat(40);

const TERM = {
  term: "batch",
  kind: "concept",
  definition: "a set of todos that share one purpose",
  specSection: "5.4",
  codeSymbol: null,
  related: ["todo"],
  refusedFor: null,
};

const DISAGREEMENT = {
  code: "D1",
  subject: 'term "batch"',
  fix: "one wording",
  rows: [
    { label: "spec", where: "WikiTom tts/spec.md §5.4 line 216", text: "a set of todos that share one purpose" },
    { label: "code", where: "tom.quest convex/ttsShared.ts line 84", text: "A BATCH holds how a set of todos gets completed." },
  ],
};

function body(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: "db209350fc7df597",
    commit: COMMIT,
    committedAt: 1_700_000_000_000,
    generatedAt: 1_700_000_100_000,
    wrote: false,
    terms: [TERM],
    disagreements: [DISAGREEMENT],
    ...over,
  });
}

async function post(t: ReturnType<typeof convexTest>, over: Record<string, unknown> = {}) {
  return await t.fetch("/tts/vocabulary", { method: "POST", headers: KEY, body: body(over) });
}

async function asTom(t: ReturnType<typeof convexTest>) {
  const id = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: id });
}

describe("POST /tts/vocabulary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is behind the worker key like every other pen", async () => {
    const t = convexTest(schema, modules);
    expect((await post(t)).status).toBe(503);
  });

  it("stores the render and the disagreements, dropping the generator's nulls", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest(schema, modules);
    const res = await post(t);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, terms: 1, disagreements: 1 });
    const row = await (await asTom(t)).query(api.vocabulary.current, {});
    expect(row).toMatchObject({ version: "db209350fc7df597", wrote: false });
    expect(row!.terms[0]).toEqual({
      term: "batch",
      kind: "concept",
      definition: "a set of todos that share one purpose",
      specSection: "5.4",
      related: ["todo"],
    });
    expect(row!.disagreements[0].rows).toHaveLength(2);
  });

  it("replaces the one row rather than adding a second", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest(schema, modules);
    await post(t);
    await post(t, { version: "newer", generatedAt: 1_700_000_200_000, wrote: true });
    const rows = await t.run(async (ctx) => ctx.db.query("ttsVocabulary").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: "newer", wrote: true });
  });

  // A rerun of an older checkout must not roll the page back to a render
  // nobody made tonight — the same rule the model-of-tom door keeps.
  it("refuses a render older than the stored one", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest(schema, modules);
    await post(t);
    const stale = await post(t, { version: "older", generatedAt: 1_699_000_000_000 });
    expect(stale.status).toBe(400);
    expect(((await stale.json()) as { error: string }).error).toContain("older than the stored render");
    const row = await (await asTom(t)).query(api.vocabulary.current, {});
    expect(row!.version).toBe("db209350fc7df597");
  });

  it.each([
    [{ version: "" }, "version"],
    [{ commit: "nope" }, "40 hex characters"],
    [{ wrote: "false" }, "wrote (boolean) required"],
    [{ terms: [] }, "terms (non-empty array) required"],
    [{ terms: [TERM, TERM] }, "posted twice"],
    [{ disagreements: [{ code: "D1" }] }, "code, subject, fix and rows"],
  ])("refuses a malformed post (%#)", async (over, message) => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest(schema, modules);
    const res = await post(t, over);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(message);
  });
});

describe("vocabulary.current", () => {
  it("is restricted to Tom", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.vocabulary.current, {})).rejects.toThrow(/Authentication required/);
    const stranger = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "someone", email: "someone@tom.quest", role: "admin" }),
    );
    await expect(t.withIdentity({ subject: stranger }).query(api.vocabulary.current, {}))
      .rejects.toThrow(/restricted to Tom/);
  });

  // FAILS CLOSED, like the model-of-tom publication: there is no door that
  // fills this store by hand, so a page with no night behind it shows nothing.
  it("is null until a night has posted one", async () => {
    const t = convexTest(schema, modules);
    expect(await (await asTom(t)).query(api.vocabulary.current, {})).toBeNull();
  });
});
