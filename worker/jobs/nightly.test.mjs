// Tests for the nightly job's pure halves (worker/jobs/nightly.mjs). The job
// cannot run end-to-end here — it needs the WikiTom checkout, the session
// files on the Jarvis Box, flock, and Convex — so what is pinned is what a
// mistake in would be silent: the bytes a table becomes (a nondeterministic
// line makes every table "changed" every night), the split rule, the
// sections an area page is reduced to, the file order of the post, the
// dates a session file is filed under, and the archive's placement rules.
//
// Importing the job module is safe: it only calls main() when node was
// pointed at the file (the `invokedDirectly` guard at the bottom).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AREA_SECTIONS,
  FORBIDDEN_SECTIONS,
  MODEL_OF_TOM_FIRST,
  SPLIT_BYTES,
  abortStaleRebase,
  applyLearningChanges,
  bumpUpdated,
  claudeEntry,
  codexMetaOf,
  codexMetaOfBuffer,
  collectModelOfTomFiles,
  commitTree,
  discoverSessionFiles,
  indexManifests,
  isLearningFile,
  isTableFile,
  learningChangeId,
  learningEvidenceIds,
  learningStep,
  matchObjection,
  parseLearningAnswer,
  planTableFiles,
  readManifests,
  rebaseInProgress,
  revertLearningChange,
  serializeRow,
  sessionCitation,
  sessionDateOf,
  sessionDateOfBuffer,
  sha256,
  syncRemote,
  syncSnapshot,
  utcDay,
  writeArchived,
} from "./nightly.mjs";

const tmpDirs = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

// ── The learning step ────────────────────────────────────────────────────────
// The step runs here end to end against a checkout in a temp dir, with the
// Convex call and the model call handed in (learningStep's `deps`): what is
// pinned is what lands, what is refused and why, what a failed answer leaves
// behind (nothing), and what an objection undoes.

const CLIMBING = [
  "---",
  "updated: 2026-09-01",
  "reviewed:",
  "window_days: 30",
  "---",
  "",
  "## Current state",
  "",
  "- Climbing for 16 years; on the WPI climbing team (session 47f04bc9, 2026-08-30).",
  "- Ankle: minor chronic pain from jumping down off the wall (session 47f04bc9, 2026-08-30).",
  "",
  "## Ideal state",
  "",
  "- \"help me design a workout plan\" (session 47f04bc9, 2026-08-30).",
  "",
  "## Must not break",
  "",
  "- Team practices are fixed (session 47f04bc9, 2026-08-30).",
  "",
].join("\n");

const PRIORITIES = [
  "# Priorities",
  "",
  "## Directions",
  "",
  "Tom writes this section himself; no agent adds to it or edits it.",
  "",
  "## Rules learned from corrections",
  "",
  "- **No importance guesses.** Tom, 2026-08-29, session `47f04bc9`.",
  "",
  "## What becomes a todo",
  "",
  "- Capture whatever implies an action by Tom.",
  "",
].join("\n");

function learningCheckout() {
  const dir = tmp();
  write(dir, "model-of-tom/writing.md", "# Model of Tom's understanding\n\n## Calibration core\n\n- Assume fluent in ML.\n");
  write(dir, "model-of-tom/priorities.md", PRIORITIES);
  write(dir, "model-of-tom/areas/climbing.md", CLIMBING);
  write(dir, "tts/spec.md", "# Spec\n\n## Rules\n\n- the spec's own line\n");
  return dir;
}

// The session's Convex row id, its SDK session id, and the id the pages cite
// it by (the SDK id's first 8 hex characters — the key of WikiTom's
// sessions/ archive, as the pages already write it: "session 47f04bc9").
const SESSION_ROW = "k97abc123def456ghi789jkl012mno34";
const SDK_SESSION = "9e1c2b3a-4d5e-4f60-8a7b-8c9d0e1f2a3b";
const SESSION = "9e1c2b3a";
const TURN = "turn0001turn0001turn0001turn0001";
const RULING = "rul0001rul0001rul0001rul0001rul0";

function learningInput(over = {}) {
  return {
    since: Date.UTC(2026, 8, 5, 8),
    sinceSource: "learning-run",
    until: Date.UTC(2026, 8, 6, 8),
    tomTurns: [
      {
        id: TURN,
        sessionId: SESSION_ROW,
        sdkSessionId: SDK_SESSION,
        sessionTitle: "training plan",
        text: "thursday practice moved to 6pm this term",
        at: Date.UTC(2026, 8, 5, 20),
        replyBefore: "Which practice moved?",
        replyAfter: "Noted: Thursday at 6 p.m.",
      },
    ],
    slackReplies: [],
    rulings: [{ id: RULING, at: Date.UTC(2026, 8, 5, 21), verdict: "approve", subjectType: "life" }],
    objections: [],
    changes: [],
    ...over,
  };
}

/** A Convex that answers the learning read with `input`, accepts every post,
 * and keeps them. */
function fakeConvex(input) {
  const posts = [];
  return {
    posts,
    fetch: async (_env, route, body) => {
      if (body === undefined) {
        expect(route.startsWith("/tts/learning-input?until=")).toBe(true);
        return input;
      }
      posts.push({ route, body });
      return { ok: true };
    },
  };
}

function learningRun(dir) {
  return {
    env: {},
    now: Date.UTC(2026, 8, 6, 8),
    day: "2026-09-06",
    dir,
    commits: [],
    learningRows: [],
    failures: [],
    results: {},
  };
}

const NEW_LINE = `- Thursday practice is at 6 p.m. this term (session ${SESSION}, 2026-09-05).`;
const factChange = (over = {}) => ({
  file: "model-of-tom/areas/climbing.md",
  section: "Current state",
  kind: "fact",
  line: NEW_LINE,
  replaces: null,
  evidence: [`session ${SESSION}`],
  ...over,
});

const answering = (changes) => () => JSON.stringify({ changes });

describe("the learning step", () => {
  it("lands a fact with evidence at the end of its section, bumps updated:, and queues its row and commit", async () => {
    const dir = learningCheckout();
    const convex = fakeConvex(learningInput());
    const run = learningRun(dir);
    const modelCalls = [];
    const model = (prompt, opts) => {
      modelCalls.push({ prompt, opts });
      return `Here you go:\n\`\`\`json\n${JSON.stringify({ changes: [factChange()] })}\n\`\`\``;
    };
    const summary = await learningStep(run, { fetch: convex.fetch, model });

    const page = fs.readFileSync(path.join(dir, "model-of-tom/areas/climbing.md"), "utf8");
    const lines = page.split("\n");
    expect(lines[1]).toBe("updated: 2026-09-06");
    expect(lines[2]).toBe("reviewed:");
    const at = lines.indexOf(NEW_LINE);
    expect(at).toBeGreaterThan(lines.indexOf("## Current state"));
    expect(at).toBeLessThan(lines.indexOf("## Ideal state"));
    expect(lines[at - 1]).toContain("Ankle:");
    expect(lines[at + 1]).toBe("");

    expect(summary.changes).toBe(1);
    expect(summary.refused).toEqual([]);
    expect(summary.model).toBe("opus");
    expect(run.learningRows).toHaveLength(1);
    expect(run.learningRows[0]).toEqual({
      kind: "learning-change",
      data: {
        id: learningChangeId("model-of-tom/areas/climbing.md", "Current state", NEW_LINE),
        file: "model-of-tom/areas/climbing.md",
        section: "Current state",
        kind: "fact",
        before: "",
        after: NEW_LINE,
        evidence: `session ${SESSION}`,
        sources: [`session ${SESSION}`],
      },
    });
    expect(run.learningRows[0].data.id).toMatch(/^[0-9a-f]{12}$/);
    expect(run.commits).toEqual([
      {
        paths: ["model-of-tom"],
        message: "learning: 2026-09-06 — 1 line from Tom's turns, replies and rulings",
      },
    ]);
    // The run row, written by the step itself.
    expect(convex.posts).toHaveLength(1);
    expect(convex.posts[0].route).toBe("/tts/event");
    expect(convex.posts[0].body.kind).toBe("learning-run");
    expect(convex.posts[0].body.data).toMatchObject({ changes: 1, tomTurns: 1, rulings: 1, reverted: 0 });
    // One model call, the Opus tier, over the pages and the input.
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0].opts).toMatchObject({ model: "opus", cwd: dir });
    expect(modelCalls[0].prompt).toContain("thursday practice moved to 6pm this term");
    expect(modelCalls[0].prompt).toContain("=== model-of-tom/areas/climbing.md ===");
    expect(modelCalls[0].prompt).toContain("Which practice moved?");
    // The session is shown by the id the pages cite — the SDK id's 8-hex
    // prefix — not by its Convex row id.
    expect(modelCalls[0].prompt).toContain(`"session": "${SESSION}"`);
    expect(modelCalls[0].prompt).not.toContain(SESSION_ROW);
    // The other pages are untouched.
    expect(fs.readFileSync(path.join(dir, "model-of-tom/priorities.md"), "utf8")).toBe(PRIORITIES);
  });

  it("refuses Tom's sections, the spec, a missing replacement target and a line without evidence, and touches nothing", async () => {
    const dir = learningCheckout();
    const before = new Map(
      ["model-of-tom/areas/climbing.md", "model-of-tom/priorities.md", "model-of-tom/writing.md", "tts/spec.md"].map(
        (rel) => [rel, fs.readFileSync(path.join(dir, rel), "utf8")],
      ),
    );
    const run = learningRun(dir);
    const convex = fakeConvex(learningInput());
    const summary = await learningStep(run, {
      fetch: convex.fetch,
      model: answering([
        factChange({ section: "Ideal state" }),
        factChange({ section: "Must not break" }),
        factChange({ file: "model-of-tom/priorities.md", section: "Directions" }),
        factChange({ file: "tts/spec.md", section: "Rules" }),
        factChange({ replaces: "- A line that is not on the page (session x, 2026-01-01)." }),
        factChange({ evidence: [] }),
        factChange({ evidence: ["session deadbeef"] }),
        factChange({ line: "- Thursday practice is at 6 p.m. this term." }),
        factChange({ kind: "inference", line: `- He trains Thursdays (session ${SESSION}, 2026-09-05).` }),
      ]),
    });
    expect(summary.changes).toBe(0);
    expect(summary.refused.map((r) => r.reason)).toEqual([
      '"Ideal state" is Tom\'s section; an agent never writes it',
      '"Must not break" is Tom\'s section; an agent never writes it',
      '"Directions" is Tom\'s section; an agent never writes it',
      "tts/spec.md is not a page the learning step writes",
      'the line to replace is not in "Current state" verbatim',
      "no evidence",
      'evidence "session deadbeef" names nothing in tonight\'s input',
      "the line does not end with its evidence citation",
      "an inference must say it is one, in the line",
    ]);
    for (const [rel, text] of before) {
      expect(fs.readFileSync(path.join(dir, rel), "utf8")).toBe(text);
    }
    expect(run.learningRows).toEqual([]);
    expect(run.commits).toEqual([]);
    expect(convex.posts.map((p) => p.body.kind)).toEqual(["learning-run"]);
  });

  it("applies a replacement whose target is on the page verbatim, and records what it replaced", () => {
    const pages = new Map([["model-of-tom/areas/climbing.md", CLIMBING]]);
    const old = "- Ankle: minor chronic pain from jumping down off the wall (session 47f04bc9, 2026-08-30).";
    const line = `- Ankle: pain gone since 2026-09-01 (session ${SESSION}, 2026-09-05).`;
    const { pages: after, applied, refused } = applyLearningChanges(
      pages,
      [factChange({ kind: "correction", line, replaces: old })],
      { day: "2026-09-06" },
    );
    expect(refused).toEqual([]);
    expect(applied[0]).toMatchObject({ before: old, after: line, kind: "correction" });
    const text = after.get("model-of-tom/areas/climbing.md");
    expect(text).not.toContain(old);
    expect(text).toContain(line);
    expect(text.startsWith("---\nupdated: 2026-09-06\n")).toBe(true);
    // The same line proposed again is already there.
    expect(applyLearningChanges(after, [factChange({ line })], { day: "2026-09-06" }).refused[0].reason).toBe(
      "already on the page",
    );
  });

  it("rejects a malformed answer before applying anything", async () => {
    const dir = learningCheckout();
    const run = learningRun(dir);
    const convex = fakeConvex(learningInput());
    // The reason, never the answer: the message becomes a failure row the
    // digest prints.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      learningStep(run, { fetch: convex.fetch, model: () => "I could not decide. {changes: [}" }),
    ).rejects.toThrow(/^the learning answer is not valid JSON$/);
    await expect(
      learningStep(run, { fetch: convex.fetch, model: () => "Tom said something private about his ankle." }),
    ).rejects.toThrow(/^the learning answer holds no JSON object$/);
    await expect(
      learningStep(run, { fetch: convex.fetch, model: () => '{"lines": []}' }),
    ).rejects.toThrow(/changes/);
    quiet.mockRestore();
    expect(() => parseLearningAnswer('{"changes": [1]}')).toThrow(/not an object/);
    expect(fs.readFileSync(path.join(dir, "model-of-tom/areas/climbing.md"), "utf8")).toBe(CLIMBING);
    expect(run.learningRows).toEqual([]);
    expect(run.commits).toEqual([]);
    // No run row either: the next night reads the same window again.
    expect(convex.posts).toEqual([]);
  });

  it("makes no model call on a night with nothing of Tom's in the window", async () => {
    const dir = learningCheckout();
    const run = learningRun(dir);
    const convex = fakeConvex(learningInput({ tomTurns: [], rulings: [] }));
    const model = vi.fn();
    const summary = await learningStep(run, { fetch: convex.fetch, model });
    expect(model).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ changes: 0, model: null, tomTurns: 0 });
    expect(convex.posts.map((p) => p.body.kind)).toEqual(["learning-run"]);
  });

  it("reverts an addition and a replacement on Tom's objection, by id and by the line's text", async () => {
    const dir = learningCheckout();
    const file = "model-of-tom/areas/climbing.md";
    const old = "- Ankle: minor chronic pain from jumping down off the wall (session 47f04bc9, 2026-08-30).";
    const replaced = `- Ankle: pain gone since 2026-09-01 (session ${SESSION}, 2026-09-05).`;
    // The page as an earlier night left it: the addition present, the
    // replacement in place of the old line.
    write(dir, file, CLIMBING.replace(old, replaced).replace("## Ideal state", `${NEW_LINE}\n\n## Ideal state`));
    const added = { id: "aaaaaaaaaaaa", file, section: "Current state", before: "", after: NEW_LINE };
    const changed = { id: "bbbbbbbbbbbb", file, section: "Current state", before: old, after: replaced };
    const run = learningRun(dir);
    const convex = fakeConvex(
      learningInput({
        tomTurns: [],
        rulings: [],
        objections: [
          { eventId: "ev1", at: 1, id: "aaaaaaaa", text: "no, that was one week" },
          { eventId: "ev2", at: 2, id: null, text: `wrong: "${replaced}" — it still hurts` },
        ],
        changes: [added, changed],
      }),
    );
    const summary = await learningStep(run, { fetch: convex.fetch, model: vi.fn() });
    const page = fs.readFileSync(path.join(dir, file), "utf8");
    expect(page).not.toContain(NEW_LINE);
    expect(page).not.toContain(replaced);
    expect(page).toContain(old);
    expect(page.startsWith("---\nupdated: 2026-09-06\n")).toBe(true);
    expect(summary).toMatchObject({ objections: 2, reverted: 2, revertFailed: 0, changes: 0 });
    expect(run.learningRows.map((r) => r.kind)).toEqual(["learning-reverted", "learning-reverted"]);
    expect(run.learningRows[0].data).toMatchObject({
      id: "aaaaaaaaaaaa",
      file,
      before: NEW_LINE,
      after: "",
      objectionId: "ev1",
      objection: "no, that was one week",
    });
    expect(run.learningRows[1].data).toMatchObject({ id: "bbbbbbbbbbbb", before: replaced, after: old });
    expect(run.commits).toEqual([
      { paths: ["model-of-tom"], message: "learning: 2026-09-06 — 2 lines reverted on Tom's objection" },
    ]);
    // Both objections consumed, in one call, before the run row.
    expect(convex.posts.map((p) => p.route)).toEqual(["/tts/learning-objections-consumed", "/tts/event"]);
    expect(convex.posts[0].body).toEqual({ ids: ["ev1", "ev2"] });
  });

  it("records a revert that cannot apply, with the reason, and consumes the objection", async () => {
    const dir = learningCheckout();
    const file = "model-of-tom/areas/climbing.md";
    const stale = { id: "cccccccccccc", file, section: "Current state", before: "", after: NEW_LINE };
    const run = learningRun(dir);
    const convex = fakeConvex(
      learningInput({
        tomTurns: [],
        rulings: [],
        objections: [
          { eventId: "ev3", at: 1, id: "cccccccccccc", text: "no" },
          { eventId: "ev4", at: 2, id: null, text: "that line about mornings is wrong" },
        ],
        changes: [stale],
      }),
    );
    const summary = await learningStep(run, { fetch: convex.fetch, model: vi.fn() });
    expect(fs.readFileSync(path.join(dir, file), "utf8")).toBe(CLIMBING);
    expect(summary).toMatchObject({ reverted: 0, revertFailed: 2 });
    expect(run.learningRows.map((r) => r.kind)).toEqual(["learning-revert-failed", "learning-revert-failed"]);
    expect(run.learningRows[0].data).toMatchObject({
      id: "cccccccccccc",
      file,
      reason: `the line is no longer on ${file} as written`,
      objectionId: "ev3",
    });
    expect(run.learningRows[1].data).toMatchObject({
      reason: "no learning change matches the objection",
      objectionId: "ev4",
    });
    expect(run.commits).toEqual([]);
    expect(convex.posts[0]).toEqual({ route: "/tts/learning-objections-consumed", body: { ids: ["ev3", "ev4"] } });
  });

  it("cites a session by its SDK id's 8-hex prefix, and accepts the whole id or the row id as evidence", () => {
    const turn = { id: TURN, sessionId: SESSION_ROW, sdkSessionId: SDK_SESSION };
    expect(sessionCitation(turn)).toBe(SESSION);
    expect(sessionCitation({ ...turn, sdkSessionId: SDK_SESSION.toUpperCase() })).toBe(SESSION);
    // Before the SDK reported one, the row id is the session's only name.
    expect(sessionCitation({ id: TURN, sessionId: SESSION_ROW, sdkSessionId: null })).toBe(SESSION_ROW);
    const ids = learningEvidenceIds(learningInput());
    expect(ids.has(SESSION)).toBe(true);
    expect(ids.has(SDK_SESSION)).toBe(true);
    expect(ids.has(SESSION_ROW)).toBe(true);
    expect(ids.has(TURN)).toBe(true);
    expect(ids.has(RULING)).toBe(true);
    const pages = new Map([["model-of-tom/areas/climbing.md", CLIMBING]]);
    for (const named of [SESSION, SDK_SESSION, SESSION_ROW]) {
      const line = `- Thursday practice is at 6 p.m. this term (session ${named}, 2026-09-05).`;
      const { applied, refused } = applyLearningChanges(
        pages,
        [factChange({ line, evidence: [`session ${named}`] })],
        { day: "2026-09-06", evidenceIds: ids },
      );
      expect(refused).toEqual([]);
      expect(applied).toHaveLength(1);
    }
  });

  it("names the pages it writes, and the sections it never does", () => {
    expect(isLearningFile("model-of-tom/writing.md")).toBe(true);
    expect(isLearningFile("model-of-tom/priorities.md")).toBe(true);
    expect(isLearningFile("model-of-tom/areas/health-and-food.md")).toBe(true);
    expect(isLearningFile("model-of-tom/schedule.md")).toBe(false);
    expect(isLearningFile("tts/spec.md")).toBe(false);
    expect(isLearningFile("model-of-tom/areas/../../tts/spec.md")).toBe(false);
    expect(FORBIDDEN_SECTIONS).toEqual(["Directions", "Ideal state", "Must not break"]);
  });

  it("bumps updated: only where a frontmatter carries one", () => {
    expect(bumpUpdated(CLIMBING, "2026-09-06").split("\n").slice(0, 3)).toEqual([
      "---",
      "updated: 2026-09-06",
      "reviewed:",
    ]);
    expect(bumpUpdated(PRIORITIES, "2026-09-06")).toBe(PRIORITIES);
    expect(bumpUpdated("---\nwindow_days: 30\n---\n\nbody", "2026-09-06")).toBe("---\nwindow_days: 30\n---\n\nbody");
  });

  it("matches an objection by the id, a prefix of it in the text, or the line's text — and by nothing else", () => {
    const changes = [
      { id: "0123456789ab", file: "f", before: "", after: "- He climbs Thursdays at 6 p.m. (session s, 2026-09-05)." },
      { id: "fedcba987654", file: "f", before: "- old", after: "- new" },
    ];
    expect(matchObjection({ id: "fedcba987654", text: "no" }, changes)).toBe(changes[1]);
    expect(matchObjection({ id: null, text: "[01234567] is wrong" }, changes)).toBe(changes[0]);
    expect(matchObjection({ id: null, text: "He climbs Thursdays at 6 p.m. (session s, 2026-09-05). — no" }, changes)).toBe(
      changes[0],
    );
    // A short line's text is not enough to name it, and a hex-looking word
    // that prefixes no change names nothing.
    expect(matchObjection({ id: null, text: "new" }, changes)).toBeNull();
    expect(matchObjection({ id: null, text: "the deadbeef line" }, changes)).toBeNull();
  });

  it("reverts against the page's current text, and says when the line has moved on", () => {
    const change = { file: "f", before: "", after: NEW_LINE };
    const withLine = `## Current state\n\n- a\n${NEW_LINE}\n- b\n`;
    expect(revertLearningChange(withLine, change)).toEqual({ ok: true, text: "## Current state\n\n- a\n- b\n" });
    expect(revertLearningChange("## Current state\n\n- a\n- b\n", change)).toEqual({
      ok: false,
      reason: "the line is no longer on f as written",
    });
  });
});

describe("serializeRow", () => {
  // Phase 1's spacing, keys sorted at every level: the same row gives the
  // same bytes whatever order Convex handed the fields back in.
  it("writes one row in phase 1's form with keys sorted at every level", () => {
    const row = { statement: "x", _id: "abc", _creationTime: 5.5, nested: { z: [1, "two", { b: 1, a: 2 }], a: null } };
    expect(serializeRow(row)).toBe(
      '{ "_creationTime": 5.5, "_id": "abc", "nested": { "a": null, "z": [1, "two", { "a": 2, "b": 1 }] }, "statement": "x" }',
    );
    expect(serializeRow({})).toBe("{}");
    expect(serializeRow([])).toBe("[]");
  });

  it("is the same bytes for the same row in another key order", () => {
    expect(serializeRow({ a: 1, b: { c: 2, d: 3 } })).toBe(serializeRow({ b: { d: 3, c: 2 }, a: 1 }));
  });
});

describe("planTableFiles", () => {
  it("writes a small table as one plain file, newest row first", () => {
    const files = planTableFiles("dtsTodos", [
      { _id: "a", _creationTime: 1 },
      { _id: "b", _creationTime: 2 },
    ]);
    expect(files.map((f) => f.name)).toEqual(["dtsTodos.jsonl"]);
    expect(files[0].bytes.toString("utf8")).toBe(
      '{ "_creationTime": 2, "_id": "b" }\n{ "_creationTime": 1, "_id": "a" }\n',
    );
  });

  it("writes an empty table as an empty file", () => {
    const [f] = planTableFiles("empty", []);
    expect(f.name).toBe("empty.jsonl");
    expect(f.bytes.length).toBe(0);
  });

  // The split: raw slices under the limit, each gzipped alone so any part
  // reads by itself, named partNN in order.
  it("splits a table over the limit into gzipped parts that concatenate back to the whole", () => {
    // The rule at a small limit (the real one is 90 MB, which is the same
    // arithmetic on more bytes): rows of ~1 KB, 200 of them, a 10 KB limit.
    const limit = 10 * 1024;
    const big = "x".repeat(1024);
    const rows = Array.from({ length: 200 }, (_, i) => ({ _id: String(i), body: big }));
    const files = planTableFiles("claudeMessages", rows, limit);
    expect(files.length).toBeGreaterThan(1);
    expect(files.map((f) => f.name)).toEqual(
      files.map((_, i) => `claudeMessages.part${String(i).padStart(2, "0")}.jsonl.gz`),
    );
    const raws = files.map((f) => zlib.gunzipSync(f.bytes));
    for (const r of raws) expect(r.length).toBeLessThanOrEqual(limit);
    const whole = Buffer.concat(raws).toString("utf8");
    const lines = whole.split("\n").filter(Boolean);
    expect(lines).toHaveLength(200);
    expect(lines[0]).toContain('"_id": "199"'); // newest first
    expect(lines[199]).toContain('"_id": "0"');
    // Deterministic: the same rows give the same part bytes.
    const again = planTableFiles("claudeMessages", rows, limit);
    expect(sha256(again[0].bytes)).toBe(sha256(files[0].bytes));
    // The real limit is phase 1's: under GitHub's 100 MB refusal.
    expect(SPLIT_BYTES).toBe(90 * 1024 * 1024);
  });

  it("knows which snapshot names belong to a table", () => {
    expect(isTableFile("dtsTodos", "dtsTodos.jsonl")).toBe(true);
    expect(isTableFile("claudeMessages", "claudeMessages.part02.jsonl.gz")).toBe(true);
    expect(isTableFile("dtsTodos", "dtsTodosX.jsonl")).toBe(false);
    expect(isTableFile("dtsTodos", "README.md")).toBe(false);
  });
});

describe("syncSnapshot", () => {
  // Only the bytes that changed are written (git sees only those), and a
  // table that crossed the split threshold loses its old shape.
  it("writes changed files, leaves identical ones, removes a table's stale shape, keeps the README", () => {
    const snapshot = tmp();
    const staging = tmp();
    write(snapshot, "README.md", "read-only copy");
    write(snapshot, "same.jsonl", "a\n");
    write(snapshot, "changed.jsonl", "old\n");
    write(snapshot, "big.jsonl", "was one file\n");
    write(staging, "same.jsonl", "a\n");
    write(staging, "changed.jsonl", "new\n");
    write(staging, "big.part00.jsonl.gz", "gz0");
    write(staging, "big.part01.jsonl.gz", "gz1");
    const sameBefore = fs.statSync(path.join(snapshot, "same.jsonl")).mtimeMs;
    const changed = syncSnapshot(snapshot, staging, ["same", "changed", "big"]);
    expect(changed).toEqual(["big.jsonl", "big.part00.jsonl.gz", "big.part01.jsonl.gz", "changed.jsonl"]);
    expect(fs.readFileSync(path.join(snapshot, "changed.jsonl"), "utf8")).toBe("new\n");
    expect(fs.existsSync(path.join(snapshot, "big.jsonl"))).toBe(false);
    expect(fs.readFileSync(path.join(snapshot, "README.md"), "utf8")).toBe("read-only copy");
    expect(fs.statSync(path.join(snapshot, "same.jsonl")).mtimeMs).toBe(sameBefore);
  });
});

describe("AREA_SECTIONS", () => {
  it("names the two sections the design fixes", () => {
    expect(AREA_SECTIONS).toEqual(["Current state", "Must not break"]);
  });
});

describe("collectModelOfTomFiles", () => {
  it("posts the three named files then each area page's sections, alphabetically", () => {
    const dir = tmp();
    write(dir, "model-of-tom/writing.md", "# Writing\n");
    write(dir, "model-of-tom/priorities.md", "# Priorities\n");
    write(dir, "model-of-tom/schedule.md", "# Schedule\n");
    write(dir, "model-of-tom/README.md", "not posted\n");
    write(dir, "model-of-tom/areas/social.md", "## Current state\n\n- friends\n\n## Ideal state\n\nx\n");
    write(dir, "model-of-tom/areas/admin.md", "## Must not break\n\n- taxes\n");
    write(dir, "model-of-tom/areas/empty.md", "# Empty\n\nno sections yet\n");
    const { files, missing } = collectModelOfTomFiles(dir);
    expect(missing).toEqual([]);
    expect(files.map((f) => f.path)).toEqual([
      ...MODEL_OF_TOM_FIRST,
      "model-of-tom/areas/admin.md",
      "model-of-tom/areas/social.md",
    ]);
    expect(files[4].body).toBe("## Current state\n\n- friends");
    expect(files[3].body).toBe("## Must not break\n\n- taxes");
  });

  // areas/ arrives with the content half of phase 4; until then the three.
  it("posts the named files alone while areas/ does not exist, and names what is missing", () => {
    const dir = tmp();
    write(dir, "model-of-tom/writing.md", "# Writing\n");
    write(dir, "model-of-tom/schedule.md", "   \n");
    const { files, missing } = collectModelOfTomFiles(dir);
    expect(files.map((f) => f.path)).toEqual(["model-of-tom/writing.md"]);
    expect(missing).toEqual(["model-of-tom/priorities.md", "model-of-tom/schedule.md"]);
  });
});

describe("sessionDateOf", () => {
  it("reads a Claude SDK line's timestamp, in UTC", () => {
    const head = '{"type":"queue-operation","timestamp":"2026-08-28T04:24:42.053Z","sessionId":"x"}\n{"type":"user"}\n';
    expect(sessionDateOf(head, 0)).toEqual({ date: "2026-08-28", dateSource: "timestamp" });
  });

  it("reads a Codex rollout's session_meta timestamp", () => {
    const head = '{"timestamp":"2026-09-04T23:28:08.844Z","type":"session_meta","payload":{"id":"t1","timestamp":"2026-09-04T23:28:08.818Z"}}\n';
    expect(sessionDateOf(head, 0)).toEqual({ date: "2026-09-04", dateSource: "timestamp" });
  });

  // witness: every session now opens with the model-of-tom prelude, so the
  // first line of a transcript is hundreds of KB on its own — read as a fixed
  // 64 KB head it is a truncated, unparseable line, and every such session
  // was filed under the file's mtime instead of its own date.
  it("reads past a first line longer than any fixed head, over a buffer", () => {
    const prelude = JSON.stringify({
      type: "user",
      message: { content: "MODEL-OF-TOM FILES".padEnd(300 * 1024, " ") },
    });
    const raw = Buffer.from(
      `${prelude}\n{"type":"assistant","timestamp":"2026-09-04T23:28:08.844Z"}\n`,
    );
    expect(raw.length).toBeGreaterThan(64 * 1024);
    expect(sessionDateOfBuffer(raw, 0)).toEqual({ date: "2026-09-04", dateSource: "timestamp" });
    // And the Codex identity, whose session_meta is the first line whatever
    // its length.
    const meta = Buffer.from(
      `${JSON.stringify({ type: "session_meta", payload: { id: "p1", cwd: "/w".padEnd(80 * 1024, "x") } })}\n`,
    );
    expect(codexMetaOfBuffer(meta)?.id).toBe("p1");
  });

  it("falls back to the file's mtime when no line carries a timestamp", () => {
    const mtime = Date.UTC(2026, 8, 2, 12);
    expect(sessionDateOf('{"type":"summary"}\nnot json\n', mtime)).toEqual({
      date: "2026-09-02",
      dateSource: "mtime",
    });
    expect(utcDay(mtime)).toBe("2026-09-02");
  });
});

describe("codexMetaOf", () => {
  it("reads a parent thread's id and a subagent thread's parent", () => {
    const parent = '{"type":"session_meta","payload":{"id":"p1","cwd":"/tmp/x"}}\n';
    expect(codexMetaOf(parent)).toEqual({ id: "p1", parent: null, cwd: "/tmp/x" });
    const child = '{"type":"session_meta","payload":{"session_id":"p1","id":"c1","parent_thread_id":"p1","cwd":"/w"}}\n';
    expect(codexMetaOf(child)).toEqual({ id: "c1", parent: "p1", cwd: "/w" });
    expect(codexMetaOf('{"type":"event_msg"}\n')).toBeNull();
    expect(codexMetaOf("")).toBeNull();
  });
});

describe("discoverSessionFiles", () => {
  it("finds Codex rollouts and Claude parents, children and attachments, skipping the active symlink", () => {
    const root = tmp();
    const codex = path.join(root, "codex");
    const accounts = path.join(root, "accounts");
    write(codex, "2026/09/05/rollout-2026-09-05T00-02-30-c1.jsonl", "{}\n");
    write(codex, "2026/09/05/notes.txt", "ignored");
    write(accounts, "gmail/projects/-root/s1.jsonl", "{}\n");
    write(accounts, "gmail/projects/-root/s1/subagents/agent-1.jsonl", "{}\n");
    write(accounts, "gmail/projects/-root/s1/tool-results/r.txt", "60000 chars");
    write(accounts, "wpi/projects/-root/s2.jsonl", "{}\n");
    fs.symlinkSync(path.join(accounts, "gmail"), path.join(accounts, "active"), "junction");
    const found = discoverSessionFiles({ codexDir: codex, accountsDir: accounts });
    const brief = found.map((f) => [f.runtime, f.account, f.session ?? null, f.kind ?? null, f.rel ?? null]);
    expect(brief).toEqual([
      ["claude", "gmail", "s1", "parent", null],
      ["claude", "gmail", "s1", "child", "subagents/agent-1.jsonl"],
      ["claude", "gmail", "s1", "attachment", "tool-results/r.txt"],
      ["claude", "wpi", "s2", "parent", null],
      ["codex", null, null, null, null],
    ]);
    // Nothing found twice through the symlink.
    expect(found.filter((f) => f.account === "active")).toEqual([]);
  });

  it("is empty when neither directory exists", () => {
    const root = tmp();
    expect(
      discoverSessionFiles({ codexDir: path.join(root, "no"), accountsDir: path.join(root, "nope") }),
    ).toEqual([]);
  });
});

describe("the manifests and the archive", () => {
  const PARENT_LINE = {
    session: "s1",
    project: "-root",
    date: "2026-08-28",
    date_source: "timestamp",
    orphan: false,
    host: "box",
    account: "gmail",
    runtime: "claude",
    parent: null,
    kind: "parent",
    source: "/root/.claude-accounts/gmail/projects/-root/s1.jsonl",
    dest: "sessions/2026/08/28/claude-s1/session.jsonl.gz",
    raw_bytes: 10,
    stored_bytes: 5,
    sha256: "abc",
    encoding: "gzip",
    parts: null,
  };

  it("reads every manifest file and indexes sources, parent dirs and accounts", () => {
    const dir = tmp();
    write(dir, "manifest-box-2026-09-05.jsonl", `${JSON.stringify(PARENT_LINE)}\ntorn line\n`);
    write(dir, "manifest-laptop-2026-09-05.jsonl", `${JSON.stringify({ ...PARENT_LINE, session: "s9", account: null, host: "laptop", source: "/home/x/s9.jsonl", dest: "sessions/2026/06/11/claude-s9/session.jsonl.gz" })}\n`);
    write(dir, "README.md", "not a manifest");
    const entries = readManifests(dir);
    expect(entries).toHaveLength(2);
    const index = indexManifests(entries);
    expect(index.shaBySource.get(PARENT_LINE.source)).toBe("abc");
    expect(index.dirBySession.get("claude:s1")).toBe("sessions/2026/08/28/claude-s1");
    expect(index.dirBySession.get("claude:s9")).toBe("sessions/2026/06/11/claude-s9");
    expect([...index.accountsBySession.get("s1")]).toEqual(["gmail"]);
  });

  it("files a Claude parent by its own date, and its child and attachment beside it", () => {
    const index = indexManifests([]);
    const accounts = new Map([["s1", new Set(["gmail"])]]);
    const raw = Buffer.from('{"timestamp":"2026-08-28T04:24:42.053Z"}\n');
    const parent = claudeEntry(
      { runtime: "claude", account: "gmail", project: "-root", session: "s1", kind: "parent", source: "/a/s1.jsonl" },
      raw, sha256(raw), 0, index, accounts,
    );
    expect(parent.dest).toBe("sessions/2026/08/28/claude-s1/session.jsonl.gz");
    expect(parent.date_source).toBe("timestamp");
    expect(parent.orphan).toBe(false);
    const child = claudeEntry(
      { runtime: "claude", account: "gmail", project: "-root", session: "s1", kind: "child", rel: "subagents/agent-1.jsonl", source: "/a/s1/subagents/agent-1.jsonl" },
      Buffer.from("{}\n"), "x", Date.UTC(2026, 8, 1), index, accounts,
    );
    expect(child.dest).toBe("sessions/2026/08/28/claude-s1/children/subagents/agent-1.jsonl.gz");
    expect(child.date).toBe("2026-08-28"); // the parent's day, not its own mtime
    expect(child.parent).toBe("s1");
    const pdf = claudeEntry(
      { runtime: "claude", account: "gmail", project: "-root", session: "s1", kind: "attachment", rel: "tool-results/w.pdf", source: "/a/s1/tool-results/w.pdf" },
      Buffer.from("%PDF"), "y", 0, index, accounts,
    );
    expect(pdf.dest).toBe("sessions/2026/08/28/claude-s1/attachments/tool-results/w.pdf");
    expect(pdf.encoding).toBe("raw");
  });

  // witness: with the account kept in the indexed directory, the SECOND
  // account's parent nested inside the first's — and its children landed at
  // .../claude-s1/gmail/wpi/children/... , which no reader looks in.
  it("puts both accounts' copies side by side, children included", () => {
    const index = indexManifests([]);
    const accounts = new Map([["s1", new Set(["gmail", "wpi"])]]);
    const raw = Buffer.from('{"timestamp":"2026-09-02T10:00:00Z"}\n');
    const entry = (account, kind, extra = {}) =>
      claudeEntry(
        { runtime: "claude", account, project: "-p", session: "s1", kind, ...extra },
        raw, "a", 0, index, accounts,
      );
    const gmail = entry("gmail", "parent", { source: "/g/s1.jsonl" });
    expect(gmail.dest).toBe("sessions/2026/09/02/claude-s1/gmail/session.jsonl.gz");
    const wpi = entry("wpi", "parent", { source: "/w/s1.jsonl" });
    expect(wpi.dest).toBe("sessions/2026/09/02/claude-s1/wpi/session.jsonl.gz");
    const gmailChild = entry("gmail", "child", {
      rel: "subagents/a.jsonl",
      source: "/g/s1/subagents/a.jsonl",
    });
    expect(gmailChild.dest).toBe(
      "sessions/2026/09/02/claude-s1/gmail/children/subagents/a.jsonl.gz",
    );
    const wpiChild = entry("wpi", "child", {
      rel: "subagents/b.jsonl",
      source: "/w/s1/subagents/b.jsonl",
    });
    expect(wpiChild.dest).toBe(
      "sessions/2026/09/02/claude-s1/wpi/children/subagents/b.jsonl.gz",
    );
    // And a night after: the manifest's per-account dest indexes back to the
    // account-less directory, so nothing nests one account inside the other.
    const later = indexManifests([
      { ...PARENT_LINE, session: "s1", account: "gmail", dest: gmail.dest, source: "/g/s1.jsonl" },
    ]);
    expect(later.dirBySession.get("claude:s1")).toBe("sessions/2026/09/02/claude-s1");
    const nextNight = claudeEntry(
      { runtime: "claude", account: "wpi", project: "-p", session: "s1", kind: "child", rel: "c.jsonl", source: "/w/s1/c.jsonl" },
      raw, "b", 0, later, accounts,
    );
    expect(nextNight.dest).toBe("sessions/2026/09/02/claude-s1/wpi/children/c.jsonl.gz");
  });

  it("marks a parentless child an orphan", () => {
    const index = indexManifests([]);
    const accounts = new Map([["s1", new Set(["gmail", "wpi"])]]);
    const raw = Buffer.from('{"timestamp":"2026-09-02T10:00:00Z"}\n');
    const wpi = claudeEntry(
      { runtime: "claude", account: "wpi", project: "-p", session: "s1", kind: "parent", source: "/w/s1.jsonl" },
      raw, "a", 0, index, accounts,
    );
    expect(wpi.dest).toBe("sessions/2026/09/02/claude-s1/wpi/session.jsonl.gz");
    const orphan = claudeEntry(
      { runtime: "claude", account: "gmail", project: "-p", session: "s7", kind: "child", rel: "subagents/a.jsonl", source: "/g/s7/subagents/a.jsonl" },
      Buffer.from('{"timestamp":"2026-09-03T10:00:00Z"}\n'), "b", 0, index, new Map(),
    );
    expect(orphan.orphan).toBe(true);
    expect(orphan.dest).toBe("sessions/2026/09/03/claude-s7/children/subagents/a.jsonl.gz");
  });

  it("writes the gzipped file under the checkout and appends the manifest line", () => {
    const checkout = tmp();
    const manifest = path.join(checkout, "sessions", "manifest-box-2026-09-06.jsonl");
    const index = indexManifests([]);
    const raw = Buffer.from('{"timestamp":"2026-08-28T04:24:42.053Z"}\n');
    const entry = claudeEntry(
      { runtime: "claude", account: "gmail", project: "-root", session: "s1", kind: "parent", source: "/a/s1.jsonl" },
      raw, sha256(raw), 0, index, new Map([["s1", new Set(["gmail"])]]),
    );
    const record = writeArchived(checkout, manifest, entry, raw, index);
    const stored = fs.readFileSync(path.join(checkout, record.dest));
    expect(zlib.gunzipSync(stored).equals(raw)).toBe(true);
    expect(record.stored_bytes).toBe(stored.length);
    expect(record.parts).toBeNull();
    const lines = fs.readFileSync(manifest, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]);
    expect(Object.keys(line)).toEqual(Object.keys(PARENT_LINE)); // phase 1's columns
    expect(line.sha256).toBe(sha256(raw));
    // The index now knows this source at this content, so tomorrow skips it.
    expect(index.shaBySource.get("/a/s1.jsonl")).toBe(sha256(raw));
  });
});

// ── The git half, in a temp repository ───────────────────────────────────────
// What these pin is what the box cannot tell us about until the night after:
// the checkout must always be left in a state the next night can pull into.
// Every repository here is made WITHOUT a committer identity anywhere git
// would find one (no global, no system, no local config, no GIT_AUTHOR_*), so
// a commit or a rebase that does not carry the job's own `-c` pair dies
// exactly as it would on the Jarvis Box.
// git takes seconds per command on some machines, and these tests run a
// dozen of them each.
describe("the git half", { timeout: 60_000 }, () => {
  const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

  beforeEach(() => {
    // An empty global config file and no system config: the machine running
    // the tests has an identity, and the Jarvis Box has none.
    const empty = path.join(tmp(), "gitconfig");
    fs.writeFileSync(empty, "");
    vi.stubEnv("GIT_CONFIG_GLOBAL", empty);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    for (const key of [
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      "EMAIL",
    ]) {
      vi.stubEnv(key, undefined);
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** git in `dir`, with the TEST's identity — never the job's. */
  function run(dir, ...args) {
    return execFileSync("git", ["-C", dir, ...IDENTITY, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  /** A repository with one commit holding a snapshot file and a manifest. */
  function repo() {
    const dir = tmp();
    execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
    write(dir, "tts/snapshot/dtsTodos.jsonl", "old\n");
    write(dir, "sessions/manifest-box-2026-09-05.jsonl", "{}\n");
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", "base");
    return dir;
  }
  const status = (dir) => run(dir, "status", "--porcelain").trim();
  const subjects = (dir) => run(dir, "log", "--format=%s").trim().split("\n");
  const committers = (dir) => run(dir, "log", "--format=%cn|%an").trim().split("\n");

  it("commits under the job's identity where the checkout has none configured", () => {
    const dir = repo();
    write(dir, "tts/snapshot/dtsTodos.jsonl", "new\n");
    const { made, failures } = commitTree(
      dir,
      [{ paths: ["tts/snapshot"], message: "snapshot: 2026-09-06 — 1 table" }],
      "2026-09-06",
    );
    expect(failures).toEqual([]);
    expect(made).toEqual(["snapshot: 2026-09-06 — 1 table"]);
    expect(committers(dir)[0]).toBe("tts-nightly|tts-nightly");
    expect(status(dir)).toBe("");
  });

  // witness: without the sweep, a run that died after writing files leaves the
  // tree modified, and every later night's `git pull --rebase` refuses it.
  it("commits what an earlier run left modified even when this run changed nothing", () => {
    const dir = repo();
    write(dir, "tts/snapshot/dtsTodos.jsonl", "left behind by a crashed run\n");
    write(dir, "sessions/2026/09/06/claude-s1/session.jsonl.gz", "half an archive");
    const { made, failures } = commitTree(dir, [], "2026-09-06");
    expect(failures).toEqual([]);
    expect(made).toEqual(["nightly: 2026-09-06 — changes an earlier run left uncommitted"]);
    expect(status(dir)).toBe("");
    // The leftovers are IN the commit, not merely staged.
    expect(run(dir, "show", "--stat", "--format=", "HEAD")).toContain("session.jsonl.gz");
  });

  it("leaves nothing modified when a step's own commit did not cover it", () => {
    const dir = repo();
    write(dir, "tts/snapshot/dtsTodos.jsonl", "tonight\n");
    write(dir, "sessions/manifest-box-2026-09-06.jsonl", "{}\n");
    const { made } = commitTree(
      dir,
      [{ paths: ["tts/snapshot"], message: "snapshot: 2026-09-06" }],
      "2026-09-06",
    );
    expect(made).toEqual([
      "snapshot: 2026-09-06",
      "nightly: 2026-09-06 — changes an earlier run left uncommitted",
    ]);
    expect(status(dir)).toBe("");
  });

  it("adds nothing and commits nothing when the tree is clean", () => {
    const dir = repo();
    expect(commitTree(dir, [], "2026-09-06")).toEqual({ made: [], failures: [] });
    expect(subjects(dir)).toEqual(["base"]);
  });

  // A rebase left in progress by a previous night blocks `git commit`
  // outright; the checkout would never commit or push again on its own. The
  // abort is before the run's first write because it resets the tree hard.
  it("aborts a rebase an earlier run left in progress, records it, and commits after", () => {
    const dir = repo();
    run(dir, "checkout", "-q", "-b", "theirs");
    write(dir, "tts/snapshot/dtsTodos.jsonl", "theirs\n");
    run(dir, "commit", "-qam", "theirs");
    run(dir, "checkout", "-q", "main");
    write(dir, "tts/snapshot/dtsTodos.jsonl", "ours\n");
    run(dir, "commit", "-qam", "ours");
    try {
      run(dir, "rebase", "theirs");
    } catch {
      // the conflict is the point
    }
    expect(rebaseInProgress(dir)).toBe(true);

    const failures = abortStaleRebase(dir);
    expect(failures).toHaveLength(1);
    expect(failures[0].step).toBe("rebase");
    expect(failures[0].error).toContain("still in progress");
    expect(rebaseInProgress(dir)).toBe(false);
    expect(status(dir)).toBe("");
    // The night's own work then commits on a checkout that can be pulled into.
    write(dir, "tts/snapshot/dtsTodos.jsonl", "tonight's snapshot\n");
    const { made, failures: after } = commitTree(dir, [], "2026-09-06");
    expect(after).toEqual([]);
    expect(made).toEqual(["nightly: 2026-09-06 — changes an earlier run left uncommitted"]);
    expect(status(dir)).toBe("");
  });

  // witness: `git pull --rebase` re-commits the local commits it replays, and
  // without an identity it dies — on the box, every night, forever after.
  it("rebases a local commit onto origin and pushes it, with no identity configured", () => {
    const bare = tmp();
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { stdio: "ignore" });
    const first = repo();
    run(first, "remote", "add", "origin", bare);
    run(first, "push", "-q", "-u", "origin", "main");
    const box = tmp();
    execFileSync("git", ["clone", "-q", bare, box], { stdio: "ignore" });
    // Another writer pushes; the box holds a commit of its own from a night
    // whose push was refused.
    write(first, "tts/snapshot/dtsEvents.jsonl", "elsewhere\n");
    run(first, "add", "-A");
    run(first, "commit", "-q", "-m", "from another writer");
    run(first, "push", "-q");
    write(box, "sessions/manifest-box-2026-09-06.jsonl", "{}\n");
    const { made } = commitTree(box, [], "2026-09-06");
    expect(made).toHaveLength(1);

    const result = syncRemote(box);
    expect(result.failures).toEqual([]);
    expect(result).toMatchObject({ pulled: true, pushed: true });
    // The box's commit was replayed on top of the other writer's, under the
    // job's identity, and origin now holds both.
    expect(subjects(box).slice(0, 2)).toEqual([
      "nightly: 2026-09-06 — changes an earlier run left uncommitted",
      "from another writer",
    ]);
    expect(committers(box)[0]).toBe("tts-nightly|tts-nightly");
    expect(run(bare, "log", "--format=%s", "-1", "main").trim()).toBe(
      "nightly: 2026-09-06 — changes an earlier run left uncommitted",
    );
  });

  it("records a refused pull as a failure and keeps the commit local", () => {
    const dir = repo();
    run(dir, "remote", "add", "origin", path.join(tmp(), "not-a-repo"));
    write(dir, "tts/snapshot/dtsTodos.jsonl", "tonight\n");
    commitTree(dir, [], "2026-09-06");
    const result = syncRemote(dir);
    expect(result.pulled).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.failures.map((f) => f.step)).toEqual(["pull"]);
    expect(result.failures[0].error).not.toBe("");
    expect(subjects(dir)[0]).toContain("nightly: 2026-09-06");
    expect(rebaseInProgress(dir)).toBe(false);
  });
});
