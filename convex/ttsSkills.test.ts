import { convexTest } from "convex-test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  MODEL_OF_TOM_SELECTIONS,
  modelOfTomPrelude,
  modelOfTomText,
  withoutModelOfTomPrelude,
} from "./ttsSkills";
import { MODEL_OF_TOM_HEADER } from "./ttsShared";
import { preparePrompt } from "../worker/jobs/plan-graphs.mjs";
import { gmailTriagePrompt } from "../worker/jobs/poll-gmail.mjs";
import { canvasTriagePrompt } from "../worker/jobs/poll-canvas.mjs";
import { timeNotePrompt } from "../worker/jobs/apply-time-notes.mjs";
import { buildAgendaPrompt } from "../worker/jobs/weekly.mjs";
import { learningPrompt } from "../worker/jobs/nightly.mjs";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const COMMIT = "0123abcd0123abcd0123abcd0123abcd0123abcd";
const COMMITTED_AT = Date.UTC(2026, 8, 6, 8, 5, 0);
const LAYERS = {
  operate: "operate layer\n\nkeeps its blank lines\n",
  write: " write layer is verbatim \n",
  know: "know layer\n",
};
const HEADER_FILES = {
  operate: ["model-of-tom/agent-rules.md"],
  write: ["model-of-tom/writing.md"],
  know: ["model-of-tom/priorities.md"],
};
const headers = (commit = COMMIT) => MODEL_OF_TOM_SELECTIONS.map((names) => ({
  layers: [...names],
  header: `${MODEL_OF_TOM_HEADER} (WikiTom commit ${commit}): ${names.flatMap((name) => HEADER_FILES[name]).join(", ")}`,
}));
const HEADERS = headers();
const SENTINEL_LAYERS = {
  operate: "OPERATE CALLER SENTINEL",
  write: "WRITE CALLER SENTINEL",
  know: "KNOW CALLER SENTINEL",
};
const FILES = [
  { path: "model-of-tom/agent-rules.md", body: "source operate", bytes: 14 },
  { path: "model-of-tom/writing.md", body: "source write", bytes: 12 },
  { path: "model-of-tom/priorities.md", body: "source know", bytes: 11 },
];
const BACKFILL_FILES = [
  { path: "model-of-tom/agent-rules.md", body: "source operate" },
  { path: "model-of-tom/writing.md", body: "source write" },
  { path: "model-of-tom/intent.md", body: "source intent" },
  { path: "model-of-tom/priorities.md", body: "source priorities" },
  { path: "model-of-tom/schedule.md", body: "source schedule" },
  ...[
    "admin", "agent-systems", "climbing", "health-and-food", "mental-health",
    "money", "research", "social",
  ].map((name) => ({
    path: `model-of-tom/areas/${name}.md`,
    body: name === "admin" ? "---\nupdated: 2026-09-09\n---\nsource admin" : `source ${name}`,
  })),
];

function payload(overrides: Record<string, unknown> = {}) {
  return { commit: COMMIT, committedAt: COMMITTED_AT, pushed: false, layers: LAYERS, headers: HEADERS, files: FILES, ...overrides };
}

const callerPrelude = (names: (keyof typeof SENTINEL_LAYERS)[]) =>
  modelOfTomText({ commit: COMMIT, syncedAt: COMMITTED_AT, pushed: false, ...SENTINEL_LAYERS, headers: HEADERS }, names);

function classifierPrompt(command: string) {
  // The daemon depends on the Box-only Agent SDK, so execute just this pure
  // prompt builder from its source rather than importing the daemon in tests.
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "worker", "session-host", "session.mjs");
  const source = fs.readFileSync(file, "utf8");
  const start = source.indexOf("function classifierPrompt(");
  const end = source.indexOf("\n}\n", start) + 2;
  expect(start, "classifierPrompt is present").toBeGreaterThan(-1);
  expect(end, "classifierPrompt closes").toBeGreaterThan(start);
  const definition = source.slice(start, end).replace("function classifierPrompt", "function");
  const render = new Function(`return (${definition});`)() as (input: { command: string; workdir: string; branch: string }) => string;
  return render({ command, workdir: "/srv/session", branch: "session/caller-contract" });
}

async function insertSessionPrompt() {
  const t = convexTest({ schema, modules });
  await t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ layers: SENTINEL_LAYERS }));
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  const tom = t.withIdentity({ subject: tomId });
  const sessionId = await tom.mutation(api.claudeSessions.createSession, {
    title: "caller contract",
    kind: "adhoc",
    repo: "none",
    initialPrompt: "The caller contract prompt body.",
  });
  const inbound = await tom.query(api.claudeSessions.getPendingInbound, { sessionId });
  return inbound[0]?.text ?? "";
}

const facts = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("ttsSkills").collect());
const publication = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("modelOfTomPublication").first());

describe("model-of-tom publication", () => {
  it("stores rendered layers separately from source file facts", async () => {
    const t = convexTest({ schema, modules });
    expect(await t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload())).toEqual({ files: 3, deleted: 0, forced: false });
    const rows = await facts(t);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "agent-rules", sourcePath: FILES[0].path, body: FILES[0].body, bytes: 14, commit: COMMIT, pushed: false }),
    ]));
    expect(await t.run((ctx) => modelOfTomPrelude(ctx, ["operate"]))).not.toContain(FILES[0].body);
    expect(await publication(t)).toMatchObject({ key: "current", commit: COMMIT, committedAt: COMMITTED_AT, pushed: false, ...LAYERS, headers: HEADERS });
  });

  it("serves the exact header and layers in canonical order, without trimming", async () => {
    const t = convexTest({ schema, modules });
    await t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload());
    const text = await t.run((ctx) => modelOfTomPrelude(ctx, ["know", "operate"]));
    expect(text).toBe(`${HEADERS[4].header}\n\n${LAYERS.operate}\n\n${LAYERS.know}`);
    expect(text).not.toContain("write layer");
  });

  it("fails with the exact missing-layer error rather than a fallback", async () => {
    const t = convexTest({ schema, modules });
    await expect(t.run((ctx) => modelOfTomPrelude(ctx, ["write"]))).rejects.toThrow("model-of-tom layer write is not stored");
  });

  it("backfills the singleton once from the existing facts with the shared layer order", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      for (const file of BACKFILL_FILES) {
        await ctx.db.insert("ttsSkills", {
          name: file.path.slice("model-of-tom/".length, -3),
          body: file.body,
          sourcePath: file.path,
          bytes: file.body.length,
          commit: COMMIT,
          syncedAt: COMMITTED_AT,
          pushed: false,
        });
      }
    });
    expect(await t.action(internal.ttsSkills.backfillLayers, {})).toEqual({
      files: BACKFILL_FILES.length,
      commit: COMMIT,
    });
    expect(await facts(t)).toHaveLength(BACKFILL_FILES.length);
    expect(await t.run((ctx) => modelOfTomPrelude(ctx, ["write", "operate"]))).toBe(
      `${MODEL_OF_TOM_HEADER} (WikiTom commit ${COMMIT}): model-of-tom/agent-rules.md, model-of-tom/writing.md\n\n── model-of-tom/agent-rules.md ──\nsource operate\n\n── model-of-tom/writing.md ──\nsource write`,
    );
    const know = await t.run((ctx) => modelOfTomPrelude(ctx, ["know"]));
    expect(know).toContain("── model-of-tom/areas/admin.md ──\nsource admin");
    expect(know).not.toContain("updated: 2026-09-09");
    await expect(t.action(internal.ttsSkills.backfillLayers, {})).rejects.toThrow(
      "model-of-tom publication is already stored",
    );
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

  it("requires every layer, every canonical header, nonempty unique source files, and integer bytes", async () => {
    const t = convexTest({ schema, modules });
    await expect(t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ layers: { ...LAYERS, know: "  " } }))).rejects.toThrow("model-of-tom layer know is blank");
    await expect(t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ headers: HEADERS.slice(0, 6) }))).rejects.toThrow(/canonical selection/);
    await expect(t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ headers: [{ ...HEADERS[0], header: HEADERS[0].header.replace(COMMIT, "deadbeef".repeat(5)) }, ...HEADERS.slice(1) ] }))).rejects.toThrow(/posted commit/);
    await expect(t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ headers: [{ ...HEADERS[0], header: HEADERS[0].header.replace("agent-rules.md", "../agent-rules.md") }, ...HEADERS.slice(1) ] }))).rejects.toThrow(/parseable file list/);
    await expect(t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ files: [] }))).rejects.toThrow(/no files posted/);
    await expect(t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ files: [{ ...FILES[0], body: "  " }] }))).rejects.toThrow(/body .* non-empty/);
    await expect(t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ files: [FILES[0], FILES[0]] }))).rejects.toThrow(/path posted twice/);
    await expect(t.mutation(internal.ttsSkills.internalReplaceModelOfTom, payload({ files: [{ ...FILES[0], bytes: 1.5 }] }))).rejects.toThrow(/nonnegative integer/);
  });

  it("only strips the byte-exact current all-layer prelude and refuses a stale header", () => {
    const current = modelOfTomText({ commit: COMMIT, syncedAt: COMMITTED_AT, pushed: false, ...LAYERS, headers: HEADERS });
    expect(withoutModelOfTomPrelude(`  ${current}\n\ncontinue`, current)).toBe("continue");
    const stale = current.replace(COMMIT, "feedface1");
    expect(withoutModelOfTomPrelude(`${stale}\n\ncontinue`, current)).toBeNull();
  });
});

describe("model-of-tom caller contract", () => {
  // THE KNOW LAYER IS NO LONGER A UNIT ANY CALLER RECEIVES (the dynamic-context
  // round): every selection below is the STABLE PREFIX — the map, the operate
  // rules, and the write layer when the run's output reaches Tom — and what the
  // run needs out of the know layer is expanded for its own subject, with the
  // rest one line each in the fetchable block (convex/ttsContext.ts).
  it("gives every caller exactly its selected layers", async () => {
    const callers: {
      name: string;
      layers: (keyof typeof SENTINEL_LAYERS)[];
      prompt: (prelude: string) => string | Promise<string>;
    }[] = [
      {
        name: "worker/session-host/session.mjs classifierPrompt",
        layers: [],
        prompt: () => classifierPrompt("curl https://example.test"),
      },
      {
        name: "worker/jobs/plan-graphs.mjs",
        layers: ["operate", "write"],
        prompt: (prelude) => preparePrompt({ statement: "Plan the contract", source: "test", createdAt: 0 }, null, "2026-09-09", prelude),
      },
      {
        name: "worker/jobs/poll-gmail.mjs",
        layers: ["operate", "write"],
        prompt: (prelude) => gmailTriagePrompt(prelude, [{ id: "mail-1", from: "test@example.com", subject: "Contract", snippet: "body" }]),
      },
      {
        name: "worker/jobs/poll-canvas.mjs",
        layers: ["operate", "write"],
        prompt: (prelude) => canvasTriagePrompt(prelude, [{ id: "canvas-1", courseCode: "CS", title: "Contract", body: "body" }]),
      },
      {
        name: "worker/jobs/apply-time-notes.mjs",
        layers: ["operate", "write"],
        prompt: (prelude) => timeNotePrompt(
          { text: "Move it to Friday", context: { kind: "todo", todo: null } },
          { nyCalendarDay: "2026-09-09", now: Date.UTC(2026, 8, 9, 12), timezone: "America/New_York" },
          prelude,
        ),
      },
      {
        name: "worker/jobs/weekly.mjs",
        layers: ["operate", "write"],
        prompt: (prelude) => buildAgendaPrompt({ writingStandard: prelude, factLines: [], priorLines: [] }),
      },
      {
        name: "insertSession",
        layers: ["operate", "write"],
        prompt: () => insertSessionPrompt(),
      },
      {
        name: "worker/jobs/nightly.mjs learningPrompt",
        layers: [],
        // Learning reads its own source pages, rather than a published prelude.
        prompt: () => learningPrompt(
          { since: 0, until: 1, tomTurns: [], slackReplies: [], rulings: [] },
          new Map([["model-of-tom/writing.md", "the unchanged learning page"]]),
          "2026-09-09",
        ),
      },
    ];

    for (const caller of callers) {
      const prompt = await caller.prompt(caller.layers.length === 0 ? "" : callerPrelude(caller.layers));
      for (const [layer, sentinel] of Object.entries(SENTINEL_LAYERS)) {
        expect(prompt.includes(sentinel), `${caller.name}: ${layer}`).toBe(caller.layers.includes(layer as keyof typeof SENTINEL_LAYERS));
      }
    }
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
    expect((await publication(t))?.operate).toBe(LAYERS.operate);
  });

  it("rejects malformed layers, headers, and file metadata before mutation", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    expect((await send(t, payload({ pushed: undefined }))).status).toBe(400);
    expect((await send(t, payload({ commit: "0123abcd" }))).status).toBe(400);
    expect((await send(t, payload({ layers: { operate: "x" } }))).status).toBe(400);
    expect((await send(t, payload({ headers: [] }))).status).toBe(400);
    expect((await send(t, payload({ files: [{ path: "tts/spec.md", body: "x", bytes: 2 }] }))).status).toBe(400);
    expect((await send(t, payload({ files: [{ path: FILES[0].path, bytes: FILES[0].bytes }] }))).status).toBe(400);
    expect((await send(t, payload({ files: [{ path: FILES[0].path, bytes: -1 }] }))).status).toBe(400);
    expect((await send(t, payload(), "wrong")).status).toBe(401);
  });
});

describe("worker context routes", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns the exact missing-layer message instead of a framework error", async () => {
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
      // The map goes to every run now, so `operate` is the first layer the
      // assembler misses when nothing is published.
      await expect(response.json()).resolves.toEqual({ error: "model-of-tom layer operate is not stored" });
    }
  });
});
