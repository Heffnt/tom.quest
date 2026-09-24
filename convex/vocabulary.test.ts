import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { TTS_CLOSED_VOCABULARY } from "./ttsShared";
import { closedVocabularyFrom } from "./vocabulary";
import { PROMPT_TERMS } from "../scripts/closed-vocabulary.mjs";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const KEY = { "X-TTS-Key": "s3cret", "Content-Type": "application/json" };
const COMMIT = "b".repeat(40);

const TERM = {
  term: "task",
  kind: "concept",
  definition: "work an agent or Tom performs",
  specSection: "5.1",
  codeSymbol: null,
  related: ["todo"],
  refusedFor: null,
};

const DISAGREEMENT = {
  code: "D1",
  subject: 'term "task"',
  fix: "one wording",
  rows: [
    { label: "spec", where: "WikiTom tts/spec.md §5.1 line 76", text: "work an agent or Tom performs" },
    { label: "code", where: "tom.quest convex/ttsShared.ts line 84", text: "A TASK is work someone does." },
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
      term: "task",
      kind: "concept",
      definition: "work an agent or Tom performs",
      specSection: "5.1",
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

// THE PROMPT'S SIX WORDS READ THE SAME ROW THE PAGE DOES: the §12.1 entries
// the night posted, rendered at read time; the constant only when no night has
// posted, or a posted row lacks one of the six.
describe("the prompt's vocabulary block", () => {
  const OPENING = TTS_CLOSED_VOCABULARY.split("\n")[0];
  const SIX = PROMPT_TERMS.map((term: string) => ({
    ...TERM,
    term,
    definition: `The posted ${term} entry (§12).`,
  }));
  const RENDERED = [OPENING, ...PROMPT_TERMS.map((term: string) => `- ${term} — The posted ${term} entry.`)].join("\n");

  it("is the constant when no row exists", () => {
    expect(closedVocabularyFrom(null)).toBe(TTS_CLOSED_VOCABULARY);
  });

  it("is the constant when the row lacks one of the six", () => {
    expect(closedVocabularyFrom({ terms: SIX.slice(1) })).toBe(TTS_CLOSED_VOCABULARY);
  });

  it("renders from the posted entries once a night has posted them", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest(schema, modules);
    expect(await t.query(internal.vocabulary.internalClosedVocabulary, {})).toBe(TTS_CLOSED_VOCABULARY);
    expect((await post(t, { terms: [TERM, ...SIX.slice(1)] })).status).toBe(200);
    // TERM is the task entry the other tests post, so the row carries all six.
    const expected = RENDERED.replace("- task — The posted task entry.", `- task — ${TERM.definition}`);
    expect(await t.query(internal.vocabulary.internalClosedVocabulary, {})).toBe(expected);
    vi.unstubAllEnvs();
  });

  it("the constant is the rendering of its own wordings, so the fallback says what the spec says", () => {
    const lines = TTS_CLOSED_VOCABULARY.split("\n");
    expect(lines).toHaveLength(1 + PROMPT_TERMS.length);
    const terms = PROMPT_TERMS.map((term: string, index: number) => ({
      term,
      definition: lines[index + 1].slice(`- ${term} — `.length),
    }));
    expect(closedVocabularyFrom({ terms })).toBe(TTS_CLOSED_VOCABULARY);
  });
});
