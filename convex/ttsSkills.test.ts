import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  MODEL_OF_TOM_SELECTIONS,
  modelOfTomPrelude,
  modelOfTomText,
  withoutModelOfTomPrelude,
} from "./ttsSkills";
import { MODEL_OF_TOM_HEADER } from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const COMMIT = "0123abcd0123abcd0123abcd0123abcd0123abcd";
const COMMITTED_AT = Date.UTC(2026, 8, 6, 8, 5, 0);
const BLOCKS = {
  operate: "operate block\n\nkeeps its blank lines\n",
  write: " write block is verbatim \n",
  know: "know block\n",
};
const HEADER_FILES = {
  operate: ["model-of-tom/agent-rules.md"],
  write: ["model-of-tom/writing.md"],
  know: ["model-of-tom/priorities.md"],
};
const headers = (commit = COMMIT) => MODEL_OF_TOM_SELECTIONS.map((names) => ({
  blocks: [...names],
  header: `${MODEL_OF_TOM_HEADER} (WikiTom commit ${commit}): ${names.flatMap((name) => HEADER_FILES[name]).join(", ")}`,
}));
const HEADERS = headers();
const FILES = [
  { path: "model-of-tom/agent-rules.md", body: "source operate", bytes: 14 },
  { path: "model-of-tom/writing.md", body: "source write", bytes: 12 },
  { path: "model-of-tom/priorities.md", body: "source know", bytes: 11 },
];

function payload(overrides: Record<string, unknown> = {}) {
  return { commit: COMMIT, committedAt: COMMITTED_AT, pushed: false, blocks: BLOCKS, headers: HEADERS, files: FILES, ...overrides };
}

const facts = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("ttsSkills").collect());
const publication = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("modelOfTomPublication").first());

describe("model-of-tom publication", () => {
  it("stores rendered blocks separately from source file facts", async () => {
    const t = convexTest({ schema, modules });
    expect(await t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload())).toEqual({ files: 3, deleted: 0, forced: false });
    const rows = await facts(t);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "agent-rules", sourcePath: FILES[0].path, body: FILES[0].body, bytes: 14, commit: COMMIT, pushed: false }),
    ]));
    expect(await t.run((ctx) => modelOfTomPrelude(ctx, ["operate"]))).not.toContain(FILES[0].body);
    expect(await publication(t)).toMatchObject({ key: "current", commit: COMMIT, committedAt: COMMITTED_AT, pushed: false, ...BLOCKS, headers: HEADERS });
  });

  it("serves the exact header and blocks in canonical order, without trimming", async () => {
    const t = convexTest({ schema, modules });
    await t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload());
    const text = await t.run((ctx) => modelOfTomPrelude(ctx, ["know", "operate"]));
    expect(text).toBe(`${HEADERS[4].header}\n\n${BLOCKS.operate}\n\n${BLOCKS.know}`);
    expect(text).not.toContain("write block");
  });

  it("fails with the exact missing-block error rather than a fallback", async () => {
    const t = convexTest({ schema, modules });
    await expect(t.run((ctx) => modelOfTomPrelude(ctx, ["write"]))).rejects.toThrow("model-of-tom block write is not stored");
  });

  it("refuses a stale publication unless a named force permits the rollback", async () => {
    const t = convexTest({ schema, modules });
    const rollback = "feedface".repeat(5);
    await t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload());
    await expect(t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ commit: rollback, headers: headers(rollback), committedAt: COMMITTED_AT - 1 }))).rejects.toThrow(/older than the stored one/);
    expect((await publication(t))?.commit).toBe(COMMIT);
    await t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ commit: rollback, headers: headers(rollback), committedAt: COMMITTED_AT - 1, force: "Tom requested rollback" }));
    expect((await publication(t))?.commit).toBe(rollback);
  });

  it("requires every block, every canonical header, nonempty unique source files, and integer bytes", async () => {
    const t = convexTest({ schema, modules });
    await expect(t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ blocks: { ...BLOCKS, know: "  " } }))).rejects.toThrow("model-of-tom block know is blank");
    await expect(t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ headers: HEADERS.slice(0, 6) }))).rejects.toThrow(/canonical selection/);
    await expect(t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ headers: [{ ...HEADERS[0], header: HEADERS[0].header.replace(COMMIT, "deadbeef".repeat(5)) }, ...HEADERS.slice(1) ] }))).rejects.toThrow(/posted commit/);
    await expect(t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ headers: [{ ...HEADERS[0], header: HEADERS[0].header.replace("agent-rules.md", "../agent-rules.md") }, ...HEADERS.slice(1) ] }))).rejects.toThrow(/parseable file list/);
    await expect(t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ files: [] }))).rejects.toThrow(/no files posted/);
    await expect(t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ files: [{ ...FILES[0], body: "  " }] }))).rejects.toThrow(/body .* non-empty/);
    await expect(t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ files: [FILES[0], FILES[0]] }))).rejects.toThrow(/path posted twice/);
    await expect(t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ files: [{ ...FILES[0], bytes: 1.5 }] }))).rejects.toThrow(/nonnegative integer/);
  });

  it("only strips the byte-exact current all-block prelude and refuses a stale header", () => {
    const current = modelOfTomText({ commit: COMMIT, syncedAt: COMMITTED_AT, pushed: false, ...BLOCKS, headers: HEADERS });
    expect(withoutModelOfTomPrelude(`  ${current}\n\ncontinue`, current)).toBe("continue");
    const stale = current.replace(COMMIT, "feedface1");
    expect(withoutModelOfTomPrelude(`${stale}\n\ncontinue`, current)).toBeNull();
  });
});

describe("POST /tts/model-of-tom", () => {
  afterEach(() => vi.unstubAllEnvs());
  const send = (t: ReturnType<typeof convexTest>, body: unknown, key = "s3cret") => t.fetch("/tts/model-of-tom", {
    method: "POST", headers: { "X-TTS-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  it("accepts the complete publication JSON and keeps its rendered text verbatim", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const response = await send(t, payload());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, commit: COMMIT, files: 3, deleted: 0, forced: false });
    expect((await publication(t))?.operate).toBe(BLOCKS.operate);
  });

  it("rejects malformed blocks, headers, and file metadata before mutation", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    expect((await send(t, payload({ pushed: undefined }))).status).toBe(400);
    expect((await send(t, payload({ blocks: { operate: "x" } }))).status).toBe(400);
    expect((await send(t, payload({ headers: [] }))).status).toBe(400);
    expect((await send(t, payload({ files: [{ path: "tts/spec.md", body: "x", bytes: 2 }] }))).status).toBe(400);
    expect((await send(t, payload({ files: [{ path: FILES[0].path, bytes: FILES[0].bytes }] }))).status).toBe(400);
    expect((await send(t, payload({ files: [{ path: FILES[0].path, bytes: -1 }] }))).status).toBe(400);
    expect((await send(t, payload(), "wrong")).status).toBe(401);
  });
});

describe("worker context routes", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns the exact missing write-block message instead of a framework error", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    for (const [path, method] of [
      ["/tts/capture-context", "GET"],
      ["/tts/time-notes", "POST"],
      ["/tts/batch-context", "GET"],
      ["/tts/weekly-input", "GET"],
    ] as const) {
      const response = await t.fetch(path, { method, headers: { "X-TTS-Key": "s3cret" } });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "model-of-tom block write is not stored" });
    }
  });
});
