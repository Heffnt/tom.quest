import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  MODEL_OF_TOM_FALLBACK_HEADER,
  captureTriageFrom,
  isModelOfTomPath,
  modelOfTomPrelude,
  modelOfTomState,
  modelOfTomText,
  orderModelOfTom,
} from "./ttsSkills";
import {
  CAPTURE_TRIAGE_RULES,
  CAPTURE_TRIAGE_SKILL,
  WRITING_SKILL,
  WRITING_STANDARD,
} from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const COMMIT = "0123abcd0123abcd0123abcd0123abcd0123abcd";
const COMMITTED_AT = Date.UTC(2026, 8, 6, 8, 5, 0);

const WRITING = "# Writing to Tom\n\nUse one fixed term per concept and reuse it exactly.";
const PRIORITIES = "# Priorities\n\nResearch first.";
const SCHEDULE = "# Schedule\n\nClimbing on Tuesdays.";
const RESEARCH = "## Current state\n\n- CMT campaign live (2026-09-05)\n\n## Must not break\n\n- the D5 judge fix";

function post(
  t: ReturnType<typeof convexTest>,
  files: { path: string; body: string }[],
  commit = COMMIT,
) {
  return t.mutation(internal.ttsSkills.internalReplaceModelOfTom, {
    commit,
    committedAt: COMMITTED_AT,
    files,
  });
}

const allRows = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("ttsSkills").collect());

const THREE = [
  { path: "model-of-tom/writing.md", body: WRITING },
  { path: "model-of-tom/priorities.md", body: PRIORITIES },
  { path: "model-of-tom/schedule.md", body: SCHEDULE },
];

describe("orderModelOfTom", () => {
  // The fixed order every prompt carries: the three named files, then the
  // area pages alphabetically — whatever order the job posted them in.
  it("puts the three named files first and the areas after, alphabetically", () => {
    const ordered = orderModelOfTom([
      { path: "model-of-tom/areas/social.md" },
      { path: "model-of-tom/schedule.md" },
      { path: "model-of-tom/areas/admin.md" },
      { path: "model-of-tom/writing.md" },
      { path: "model-of-tom/priorities.md" },
    ]).map((f) => f.path);
    expect(ordered).toEqual([
      "model-of-tom/writing.md",
      "model-of-tom/priorities.md",
      "model-of-tom/schedule.md",
      "model-of-tom/areas/admin.md",
      "model-of-tom/areas/social.md",
    ]);
  });

  // witness: an unexpected path silently dropped would shorten every prompt
  // with no one told; it is carried, last.
  it("keeps a path outside the known set, after everything else", () => {
    const ordered = orderModelOfTom([
      { path: "model-of-tom/README.md" },
      { path: "model-of-tom/areas/admin.md" },
    ]).map((f) => f.path);
    expect(ordered).toEqual(["model-of-tom/areas/admin.md", "model-of-tom/README.md"]);
  });
});

describe("isModelOfTomPath", () => {
  it("accepts markdown under model-of-tom/ and refuses everything else", () => {
    expect(isModelOfTomPath("model-of-tom/writing.md")).toBe(true);
    expect(isModelOfTomPath("model-of-tom/areas/research.md")).toBe(true);
    expect(isModelOfTomPath("tts/spec.md")).toBe(false);
    expect(isModelOfTomPath("model-of-tom/../tts/spec.md")).toBe(false);
    expect(isModelOfTomPath("model-of-tom/writing.txt")).toBe(false);
    expect(isModelOfTomPath("model-of-tom/")).toBe(false);
    expect(isModelOfTomPath(42)).toBe(false);
  });
});

describe("internalReplaceModelOfTom", () => {
  it("stores one row per file, all carrying the commit and its time", async () => {
    const t = convexTest({ schema, modules });
    expect(await post(t, THREE)).toEqual({ files: 3, deleted: 0 });
    const rows = await allRows(t);
    expect(rows.map((r) => r.name).sort()).toEqual(["priorities", "schedule", "writing"]);
    for (const row of rows) {
      expect(row.commit).toBe(COMMIT);
      expect(row.syncedAt).toBe(COMMITTED_AT); // the commit's time, not now
      expect(row.sourcePath.startsWith("model-of-tom/")).toBe(true);
    }
  });

  // WikiTom is the system of record: a file removed there stops reaching
  // prompts here, and the retired sync's row goes with the first post.
  it("replaces the store whole, the retired sync's row included", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("ttsSkills", {
        name: WRITING_SKILL,
        body: "old skill",
        sourcePath: "model-of-tom/skills/writing-to-tom/SKILL.md",
        syncedAt: 1,
      });
    });
    await post(t, [...THREE, { path: "model-of-tom/areas/research.md", body: RESEARCH }]);
    expect(await post(t, THREE, "feedface1")).toEqual({ files: 3, deleted: 4 });
    const rows = await allRows(t);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.commit === "feedface1")).toBe(true);
  });

  // witness: an empty post that emptied the table would put every prompt on
  // the hardcoded fallback because the job hit a layout change.
  it("refuses an empty post and leaves the store as it was", async () => {
    const t = convexTest({ schema, modules });
    await post(t, THREE);
    await expect(post(t, [])).rejects.toThrow(/no files posted/);
    expect(await allRows(t)).toHaveLength(3);
  });

  // witness: the replace is wholesale, so a post that read every file but
  // writing.md would put every prompt from then on — every sentence TTS shows
  // Tom — on no writing standard at all, and nothing would put it back until
  // a night that read the file again.
  it("refuses a post without the writing standard and leaves the store as it was", async () => {
    const t = convexTest({ schema, modules });
    await post(t, THREE);
    await expect(
      post(t, [
        { path: "model-of-tom/priorities.md", body: PRIORITIES },
        { path: "model-of-tom/areas/research.md", body: RESEARCH },
      ]),
    ).rejects.toThrow(/model-of-tom\/writing\.md is missing/);
    const rows = await allRows(t);
    expect(rows.map((r) => r.name).sort()).toEqual(["priorities", "schedule", "writing"]);
    const text = await t.run(async (ctx) => modelOfTomPrelude(ctx));
    expect(text).toContain(WRITING);
  });

  it("refuses a path outside model-of-tom/ and a path posted twice", async () => {
    const t = convexTest({ schema, modules });
    await expect(post(t, [{ path: "tts/spec.md", body: "x" }])).rejects.toThrow(
      /not a model-of-tom path/,
    );
    await expect(
      post(t, [THREE[0], THREE[0]]),
    ).rejects.toThrow(/posted twice/);
    expect(await allRows(t)).toHaveLength(0);
  });
});

describe("modelOfTomState and the prelude", () => {
  it("serves the hardcoded standard under a header that says so while nothing is stored", async () => {
    const t = convexTest({ schema, modules });
    const state = await t.run(async (ctx) => modelOfTomState(ctx));
    expect(state).toEqual({ commit: null, syncedAt: null, files: [] });
    const text = await t.run(async (ctx) => modelOfTomPrelude(ctx));
    expect(text.startsWith(MODEL_OF_TOM_FALLBACK_HEADER)).toBe(true);
    expect(text).toContain(WRITING_STANDARD);
  });

  // Until the job's first post, the retired sync's row keeps serving as the
  // writing file — a prompt never drops to the fallback while a synced
  // writing skill exists.
  it("serves the retired sync's writing row, commit unknown, until the first post", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("ttsSkills", {
        name: WRITING_SKILL,
        body: "synced skill text",
        sourcePath: "model-of-tom/skills/writing-to-tom/SKILL.md",
        syncedAt: 5,
      });
    });
    const state = await t.run(async (ctx) => modelOfTomState(ctx));
    expect(state.commit).toBeNull();
    expect(state.files).toEqual([
      { path: "model-of-tom/skills/writing-to-tom/SKILL.md", body: "synced skill text" },
    ]);
    const text = modelOfTomText(state);
    expect(text).toContain("synced skill text");
    expect(text).not.toContain(WRITING_STANDARD);
  });

  it("serves the posted files in the fixed order, headed by the commit and the paths", async () => {
    const t = convexTest({ schema, modules });
    await post(t, [
      { path: "model-of-tom/areas/research.md", body: RESEARCH },
      ...[...THREE].reverse(),
    ]);
    const state = await t.run(async (ctx) => modelOfTomState(ctx));
    expect(state.commit).toBe(COMMIT);
    expect(state.syncedAt).toBe(COMMITTED_AT);
    expect(state.files.map((f) => f.path)).toEqual([
      "model-of-tom/writing.md",
      "model-of-tom/priorities.md",
      "model-of-tom/schedule.md",
      "model-of-tom/areas/research.md",
    ]);
    const text = modelOfTomText(state);
    const [header] = text.split("\n");
    // The transcript's first line: the commit and every path included.
    expect(header).toBe(
      `MODEL-OF-TOM FILES (WikiTom commit ${COMMIT}): model-of-tom/writing.md, model-of-tom/priorities.md, model-of-tom/schedule.md, model-of-tom/areas/research.md`,
    );
    // Each file under its own path, bodies in order.
    expect(text.indexOf(WRITING)).toBeLessThan(text.indexOf(PRIORITIES));
    expect(text.indexOf(PRIORITIES)).toBeLessThan(text.indexOf(SCHEDULE));
    expect(text.indexOf(SCHEDULE)).toBeLessThan(text.indexOf("the D5 judge fix"));
    expect(text).toContain("── model-of-tom/areas/research.md ──");
    expect(text).not.toContain(WRITING_STANDARD);
  });

  // A blank posted body is refused at the route; a row that somehow carries
  // one must not put a prompt on an empty file.
  it("ignores a stored row whose body is blank", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("ttsSkills", {
        name: "writing",
        body: "   \n",
        sourcePath: "model-of-tom/writing.md",
        commit: COMMIT,
        syncedAt: 1,
      });
    });
    const state = await t.run(async (ctx) => modelOfTomState(ctx));
    expect(state.files).toEqual([]);
  });
});

// ── The route the nightly job posts through ──────────────────────────────────
describe("POST /tts/model-of-tom", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const send = (t: ReturnType<typeof convexTest>, body: unknown, key = "s3cret") =>
    t.fetch("/tts/model-of-tom", {
      method: "POST",
      headers: { "X-TTS-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("stores the files and answers with the commit", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const res = await send(t, { commit: COMMIT, committedAt: COMMITTED_AT, files: THREE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, commit: COMMIT, files: 3, deleted: 0 });
    expect(await allRows(t)).toHaveLength(3);
  });

  it("refuses a wrong key, a bad commit, no files, and a path outside model-of-tom/", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    expect((await send(t, { commit: COMMIT, committedAt: 1, files: THREE }, "nope")).status).toBe(401);
    expect((await send(t, { commit: "main", committedAt: 1, files: THREE })).status).toBe(400);
    expect((await send(t, { commit: COMMIT, committedAt: 1, files: [] })).status).toBe(400);
    expect((await send(t, { commit: COMMIT, files: THREE })).status).toBe(400);
    const outside = await send(t, {
      commit: COMMIT,
      committedAt: 1,
      files: [{ path: "tts/spec.md", body: "x" }],
    });
    expect(outside.status).toBe(400);
    expect((await outside.json()).error).toMatch(/files\[0\]\.path/);
    expect(await allRows(t)).toHaveLength(0);
  });
});

// ── The planner's channel keeps its field ────────────────────────────────────
// worker/jobs/plan-graphs.mjs treats a missing `writingStandard` as fatal and
// form-batches.mjs reads the same payload, so the field keeps its name and its
// type; what it carries is now the prelude.
describe("GET /tts/batch-context writing standard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function fetchStandard(t: ReturnType<typeof convexTest>) {
    const res = await t.fetch("/tts/batch-context", {
      method: "GET",
      headers: { "X-TTS-Key": "s3cret" },
    });
    expect(res.status).toBe(200);
    return (await res.json()).writingStandard;
  }

  it("serves the hardcoded copy, headed, while nothing is stored", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const text = await fetchStandard(t);
    expect(text.startsWith(MODEL_OF_TOM_FALLBACK_HEADER)).toBe(true);
    expect(text).toContain(WRITING_STANDARD);
  });

  it("serves the posted files once they exist", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    await post(t, THREE);
    const text = await fetchStandard(t);
    expect(text).toContain(`WikiTom commit ${COMMIT}`);
    expect(text).toContain(WRITING);
    expect(text).not.toContain(WRITING_STANDARD);
  });
});

// ── The capture-context half (every capture poller's only channel) ───────────
// poll-gmail, poll-canvas and poll-outlook are Node ESM on the Jarvis Box: they
// can neither import the rules nor read a git checkout of WikiTom, so this
// route is where the two capture judgements get their words.
//
// THE LIVE RULES ARE A SECTION of model-of-tom/priorities.md — phase 3 merged
// the capture-triage skill into it, and phase 4's nightly job replaces the
// ttsSkills table wholesale, so nothing writes a capture-triage row any more.
// What is pinned here is the whole ladder: the section wins, the retired
// sync's row is the middle rung, the hardcoded copy is the floor, and the
// answer says which — a poller triaging by a frozen copy has to be able to
// say so in its log.

// The real shape of the page (WikiTom model-of-tom/priorities.md at
// 0fa8f545a): the section is the LAST one, it is headed at level 2, and two
// earlier sections mention capture triage without being it.
const PRIORITIES_PAGE = [
  "# Priorities",
  "",
  "## Directions",
  "",
  "- Research first; everything else is scheduled around it.",
  "",
  "## Rules learned from corrections",
  "",
  "- **Email/capture triage classes**: not yet authored — a TTS todo exists.",
  "",
  "## What becomes a todo",
  "",
  "Decides what enters TTS from an inbound stream.",
  "",
  "- **Capture whatever implies an action by Tom**: reply, submit, schedule, pay, sign.",
  "- **Skip** newsletters, promotions, automated notifications, receipts, and mass mail.",
  "- **Mark guesses.** A decision no listed rule covers is a guess.",
].join("\n");

const TRIAGE_SECTION = [
  "## What becomes a todo",
  "",
  "Decides what enters TTS from an inbound stream.",
  "",
  "- **Capture whatever implies an action by Tom**: reply, submit, schedule, pay, sign.",
  "- **Skip** newsletters, promotions, automated notifications, receipts, and mass mail.",
  "- **Mark guesses.** A decision no listed rule covers is a guess.",
].join("\n");

const TRIAGE_BODY = `---
name: capture-triage
description: Load before deciding whether an incoming message needs Tom.
---

# Capture triage

Needs Tom today only for a deadline inside 48 hours, a person waiting on a
reply, or money or credentials.`;

describe("captureTriageFrom", () => {
  it("takes the section out of a real priorities page and nothing around it", () => {
    const out = captureTriageFrom(PRIORITIES_PAGE, null);
    expect(out).toEqual({ captureTriage: TRIAGE_SECTION, source: "priorities" });
    expect(out.captureTriage).not.toContain("Directions");
    expect(out.captureTriage).not.toContain("Rules learned from corrections");
  });

  it("matches the heading by text, case-insensitively", () => {
    const shouted = PRIORITIES_PAGE.replace(
      "## What becomes a todo",
      "## WHAT BECOMES A TODO",
    );
    expect(captureTriageFrom(shouted, null).source).toBe("priorities");
  });

  it("falls back to the retired sync's row when the page has no such section", () => {
    const noSection = "# Priorities\n\n## Directions\n\n- Research first.\n";
    expect(captureTriageFrom(noSection, TRIAGE_BODY)).toEqual({
      captureTriage: TRIAGE_BODY,
      source: "skill",
    });
  });

  it("falls back to the hardcoded copy when neither is there", () => {
    expect(captureTriageFrom(null, null)).toEqual({
      captureTriage: CAPTURE_TRIAGE_RULES,
      source: "builtin",
    });
    expect(captureTriageFrom("   ", "   ")).toEqual({
      captureTriage: CAPTURE_TRIAGE_RULES,
      source: "builtin",
    });
  });
});

describe("GET /tts/capture-context", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function fetchTriage(t: ReturnType<typeof convexTest>) {
    const res = await t.fetch("/tts/capture-context", {
      method: "GET",
      headers: { "X-TTS-Key": "s3cret" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    return { captureTriage: body.captureTriage, source: body.source };
  }

  it("serves the hardcoded copy, named as such, while nothing is stored", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    expect(await fetchTriage(t)).toEqual({
      captureTriage: CAPTURE_TRIAGE_RULES,
      source: "builtin",
    });
  });

  it("serves the section of the posted priorities.md — the nightly job's own post", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    await post(t, [
      { path: "model-of-tom/writing.md", body: WRITING },
      { path: "model-of-tom/priorities.md", body: PRIORITIES_PAGE },
      { path: "model-of-tom/schedule.md", body: SCHEDULE },
    ]);
    expect(await fetchTriage(t)).toEqual({
      captureTriage: TRIAGE_SECTION,
      source: "priorities",
    });
  });

  it("serves the retired sync's row while it survives and the section is absent", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    // Written straight into the table: the six-hourly WikiTom skill sync that
    // used to write this row is retired (see the head of convex/ttsSkills.ts),
    // so a row of this name can only be one the retired sync left behind.
    await t.run(async (ctx) => {
      await ctx.db.insert("ttsSkills", {
        name: CAPTURE_TRIAGE_SKILL,
        body: TRIAGE_BODY,
        sourcePath: `skills/${CAPTURE_TRIAGE_SKILL}/SKILL.md`,
        syncedAt: COMMITTED_AT,
      });
    });
    expect(await fetchTriage(t)).toEqual({
      captureTriage: TRIAGE_BODY,
      source: "skill",
    });
  });

  // THE REGRESSION THIS ROUTE EXISTS FOR: the nightly post replaces the table
  // wholesale, so the capture-triage row is gone after the first night. Before
  // this change the route fell through to the frozen copy from then on and
  // WikiTom's rules never reached a poller again.
  it("keeps serving WikiTom's rules after the post that deletes the capture-triage row", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("ttsSkills", {
        name: CAPTURE_TRIAGE_SKILL,
        body: TRIAGE_BODY,
        sourcePath: `skills/${CAPTURE_TRIAGE_SKILL}/SKILL.md`,
        syncedAt: COMMITTED_AT,
      });
    });
    await post(t, [
      { path: "model-of-tom/writing.md", body: WRITING },
      { path: "model-of-tom/priorities.md", body: PRIORITIES_PAGE },
    ]);
    const names = (await allRows(t)).map((r) => r.name);
    expect(names).not.toContain(CAPTURE_TRIAGE_SKILL);
    expect(await fetchTriage(t)).toEqual({
      captureTriage: TRIAGE_SECTION,
      source: "priorities",
    });
  });

  it("is closed to a caller without the worker key", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const res = await t.fetch("/tts/capture-context", {
      method: "GET",
      headers: { "X-TTS-Key": "nope" },
    });
    expect(res.status).toBe(401);
  });
});
