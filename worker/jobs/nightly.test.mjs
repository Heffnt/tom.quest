// Tests for the nightly job's pure halves (worker/jobs/nightly.mjs). The job
// cannot run end-to-end here — it needs the WikiTom checkout, the session
// files on the Jarvis Box, flock, and Convex — so what is pinned is what a
// mistake in would be silent: the bytes a table becomes (a nondeterministic
// line makes every table "changed" every night), the split rule, the
// whole area-page bodies the post carries, the file order of the post, the
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
  BOX_SKILLS_DIRS,
  CMT_DIR,
  FORBIDDEN_SECTIONS,
  REPO_CHECKOUTS,
  SPLIT_BYTES,
  TOM_QUEST_DIR,
  WIKITOM_DIR,
  abortStaleRebase,
  applyLearningChanges,
  bumpUpdated,
  claudeEntry,
  codexMetaOf,
  codexMetaOfBuffer,
  commitTree,
  deliveryStep,
  discoverSessionFiles,
  LEARNING_CHECK_FAILED,
  LEARNING_PROMPT_CHARS,
  LEARNING_TURN_CHARS,
  expectedBodyBlobs,
  expectedEvidenceBlobs,
  exportTableRows,
  gitBlobId,
  goldenExportStep,
  indexManifests,
  isLearningFile,
  isTableFile,
  learningChangeId,
  learningEvidence,
  learningPrompt,
  learningStep,
  locateSection,
  matchObjection,
  modelOfTomCommit,
  pageBodyBlob,
  parseLearningAnswer,
  planTableFiles,
  postStep,
  parseArgs,
  boxSkillsDirs,
  readSkillCatalog,
  referencePathResolver,
  repoRulesStep,
  readManifests,
  rebaseInProgress,
  recordLearningRows,
  repoLearningStep,
  redactRow,
  revertLearningRecords,
  reviewedRefusal,
  runEvidenceCheck,
  runsStep,
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
import { PRELUDE_LAYERS } from "../../scripts/prelude.mjs";
import { parseFrontmatter } from "./markdown-sections.mjs";
import { proposalId } from "./learning-repo.mjs";

const REQUIRED_AREA_PATHS = PRELUDE_LAYERS.know.areas.required;

const tmpDirs = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("delivery step", () => {
  it("accepts --only=delivery without selecting a locked checkout step", () => {
    expect(parseArgs(["--only=delivery"])).toEqual({ force: false, only: ["delivery"] });
  });

  it("posts one prelude-delivery event with the returned facts", async () => {
    const posts = [];
    const facts = { since: 1, until: 2, current: 3, stale: [], missing: [], unplaced: 0 };
    const result = await deliveryStep(
      { env: {}, now: 2, day: "2026-09-09" },
      { fetch: async (_env, route, body) => {
        posts.push({ route, body });
        return route.startsWith("/tts/prelude-delivery") ? facts : { ok: true };
      } },
    );
    expect(result).toBe(facts);
    expect(posts).toEqual([
      { route: "/tts/prelude-delivery?until=2", body: undefined },
      { route: "/tts/event", body: { kind: "prelude-delivery", data: { day: "2026-09-09", ...facts } } },
    ]);
  });
});

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

describe("the golden export step", () => {
  it("is a step of its own, and one that runs before learning", () => {
    expect(parseArgs(["--only=golden-export"])).toEqual({ force: false, only: ["golden-export"] });
    const { only } = parseArgs([]);
    expect(only.indexOf("golden-export")).toBeLessThan(only.indexOf("learning"));
    // Outside the lock, the way delivery is: it writes a tom.quest cache
    // clone and touches nothing the WikiTom writers hold.
    expect(only.indexOf("golden-export")).toBeGreaterThan(only.indexOf("delivery"));
  });

  it("runs the exporter against the labels source and reports what it wrote", async () => {
    const dir = tmp();
    write(dir, "evals/golden/runs/a.json", "{}");
    write(dir, "evals/golden/runs/b.json", "{}");
    const ran = [];
    const result = await goldenExportStep(
      { env: {}, day: "2026-09-11" },
      {
        checkout: () => dir,
        exec: (where, args) => {
          ran.push({ where, args });
          return "reading labels\ngolden set: 2 items in 1 partitions (1 approve, 1 revise); 0 rulings unbuildable (no snapshot), 0 dropped (credential-shaped text).\n";
        },
      },
    );
    expect(ran).toEqual([{ where: dir, args: ["scripts/export-golden.mjs", "--source", "labels"] }]);
    expect(result).toEqual({
      dir,
      items: 2,
      summary: "golden set: 2 items in 1 partitions (1 approve, 1 revise); 0 rulings unbuildable (no snapshot), 0 dropped (credential-shaped text).",
      landed: false,
    });
  });

  // NOTHING IS PUSHED, AND MAIN LEAST OF ALL. This job has no tom.quest
  // branch-and-commit helper — every repository write it makes goes to the
  // WikiTom checkout under the WikiTom writer lock — so the export is made and
  // left, and the landing is one injected call the caller supplies.
  it("commits and pushes nothing on its own, and says the result did not land", async () => {
    const dir = tmp();
    const result = await goldenExportStep(
      { env: {}, day: "2026-09-11" },
      { checkout: () => dir, exec: () => "golden set: 0 items in 0 partitions" },
    );
    expect(result.landed).toBe(false);
    // The clone is untouched by this step: no branch, no commit, no remote.
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
  });

  it("lands through the injected lander when a caller supplies one", async () => {
    const dir = tmp();
    const landed = [];
    const result = await goldenExportStep(
      { env: {}, day: "2026-09-11" },
      {
        checkout: () => dir,
        exec: () => "golden set: 0 items in 0 partitions",
        land: (what) => {
          landed.push(what);
          return true;
        },
      },
    );
    expect(landed).toEqual([{ dir, paths: ["evals/golden/runs"], day: "2026-09-11" }]);
    expect(result.landed).toBe(true);
  });

  it("says nothing about a summary the exporter did not print", async () => {
    const dir = tmp();
    const result = await goldenExportStep(
      { env: {}, day: "2026-09-11" },
      { checkout: () => dir, exec: () => "" },
    );
    expect(result).toMatchObject({ items: 0, summary: "" });
  });

  // A FAILURE IS A RECORDED FAILURE. The step throws; main's own try/catch
  // writes the nightly-failure row and the night carries on — the same
  // contract every other step here has.
  it("throws rather than swallowing an exporter that refused, so the night records it and continues", async () => {
    await expect(
      goldenExportStep(
        { env: {}, day: "2026-09-11" },
        { checkout: () => tmp(), exec: () => { throw new Error("export-golden: /tts/label-input -> HTTP 500"); } },
      ),
    ).rejects.toThrow("HTTP 500");
  });
});

describe("runs step", () => {
  it("sends the full last-manifest tuple when timestamps are equal", async () => {
    const dir = tmp();
    write(dir, "runs/manifest-2026-09.jsonl", `${JSON.stringify({ at: 100, run_id: "claude:laptop:root", file_version: "version-a" })}\n`);
    let requested;
    const result = await runsStep(
      { dir, day: "2026-09-11", env: { CONVEX_SITE_URL: "http://localhost" }, commits: [] },
      { fetch: async (url) => {
        requested = new URL(url);
        return { ok: true, json: async () => ({ entries: [], nextCursor: null }) };
      } },
    );
    expect(requested.searchParams.get("since")).toBe("100");
    expect(requested.searchParams.get("afterRunId")).toBe("claude:laptop:root");
    expect(requested.searchParams.get("afterFileVersion")).toBe("version-a");
    expect(result).toEqual({ manifested: 0, received: 0, since: 100 });
  });
});

// ── The learning step ────────────────────────────────────────────────────────
// The step runs here end to end against a WikiTom-SHAPED checkout in a temp
// dir — the pages, their evidence mirror, and a copy of WikiTom's own
// check-evidence.mjs, which is the gate the step runs twice a night — with
// the Convex call and the model call handed in (learningStep's `deps`). What
// is pinned is what lands in BOTH records, what is refused and why, what a
// failed answer leaves behind (nothing), what a failed CHECK leaves behind
// (nothing, byte for byte), and what an objection undoes.

const CHECKER = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "check-evidence.mjs"), "utf8");

const CLIMBING = [
  "---",
  "updated: 2026-09-01",
  "reviewed:",
  "window_days: 30",
  "---",
  "",
  "## Current state",
  "",
  "- Climbing for 16 years; on the WPI climbing team.",
  "- Ankle: minor chronic pain from jumping down off the wall.",
  "",
  "## Ideal state",
  "",
  "- A workout plan he follows.",
  "",
  "## Must not break",
  "",
  "- Team practices are fixed.",
  "",
].join("\n");

const CLIMBING_EVIDENCE = [
  "# Evidence for areas/climbing.md",
  "",
  "## Current state",
  "",
  "- line: Climbing for 16 years; on the WPI climbing team.",
  '  said: 2026-08-30 · session 47f04bc9 · "i have been climbing for sixteen years now"',
  "- line: Ankle: minor chronic pain from jumping down off the wall.",
  '  said: 2026-08-30 · session 47f04bc9 · "my ankle hurts from jumping off the wall"',
  "",
  "## Ideal state",
  "",
  "- line: A workout plan he follows.",
  '  said: 2026-08-30 · session 47f04bc9 · "help me design a workout plan i will follow"',
  "",
  "## Must not break",
  "",
  "- line: Team practices are fixed.",
  '  said: 2026-08-30 · session 47f04bc9 · "team practices are fixed and never move"',
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
  "- No importance guesses.",
  "",
  "## What becomes a todo",
  "",
  "- Capture whatever implies an action by Tom.",
  "",
].join("\n");

const PRIORITIES_EVIDENCE = [
  "# Evidence for priorities.md",
  "",
  "## Rules learned from corrections",
  "",
  "- line: No importance guesses.",
  '  said: 2026-08-29 · session 47f04bc9 · "do not guess importance ratings for me"',
  "",
  "## What becomes a todo",
  "",
  "- line: Capture whatever implies an action by Tom.",
  '  said: 2026-08-29 · session 47f04bc9 · "capture anything that implies i have to do something"',
  "",
].join("\n");

const GROUND = [
  "# Ground",
  "",
  "## Knows",
  "",
  "- The thesis and claims of his own paper.",
  "",
  "## Follows, without the details",
  "",
  "- Statistics, the ideas and not the math.",
  "",
  "## Does not know",
  "",
  "- A name an agent coined for an experiment, a run or a concept.",
  "",
  "## How to explain",
  "",
  "- Lead with the mechanism and re-supply the name.",
  "",
].join("\n");

const GROUND_EVIDENCE = [
  "# Evidence for ground.md",
  "",
  "## Knows",
  "",
  "- line: The thesis and claims of his own paper.",
  '  said: 2026-07-23 · session 81be510a · "i know what the thesis of my own paper is"',
  "",
  "## Follows, without the details",
  "",
  "- line: Statistics, the ideas and not the math.",
  '  said: 2026-07-23 · session 81be510a · "i understand these intuitively but im not fluent in the math"',
  "",
  "## Does not know",
  "",
  "- line: A name an agent coined for an experiment, a run or a concept.",
  '  said: 2026-08-08 · session 542cf5c1 · "That is not a term I recognize, and I am intimately familiar with CMT."',
  "",
  "## How to explain",
  "",
  "- line: Lead with the mechanism and re-supply the name.",
  '  said: 2026-08-08 · session 542cf5c1 · "lead with the mechanism and give me the name again"',
  "",
].join("\n");

const INTENT = [
  "---",
  "updated: 2026-09-01",
  "reviewed:",
  "---",
  "",
  "# Intent",
  "",
  "## Directions",
  "",
  "Tom leads this file; no agent writes this section.",
  "",
  "## What to protect",
  "",
  "- The PhD position and the lab stay.",
  "",
  "## What to push toward",
  "",
  "- The paper finished and published.",
  "",
  "## What he does not care about",
  "",
  "- Importance ratings guessed on his behalf.",
  "",
].join("\n");

const INTENT_EVIDENCE = [
  "# Evidence for intent.md",
  "",
  "## What to protect",
  "",
  "- line: The PhD position and the lab stay.",
  '  said: 2026-07-23 · session 81be510a · "losing the position and the lab is the failure i name first"',
  "",
  "## What to push toward",
  "",
  "- line: The paper finished and published.",
  '  said: 2026-07-23 · session 81be510a · "i need the paper finished and published this year"',
  "",
  "## What he does not care about",
  "",
  "- line: Importance ratings guessed on his behalf.",
  '  said: 2026-07-23 · session 81be510a · "do not guess importance ratings for me at all"',
  "",
].join("\n");

const WRITING = "# Writing\n\n## Calibration core\n\n- Assume fluent in ML.\n";
const WRITING_EVIDENCE = [
  "# Evidence for writing.md",
  "",
  "## Calibration core",
  "",
  "- line: Assume fluent in ML.",
  '  said: 2026-08-18 · session 81be510a · "dont dumb down the ml jargon because im familiar with it"',
  "",
].join("\n");

/** A WikiTom-shaped checkout: every synthesis file the checker walks, its
 * evidence mirror, and the checker itself. `runEvidenceCheck` passes on it. */
function learningCheckout(over = {}) {
  const dir = tmp();
  write(dir, "scripts/check-evidence.mjs", CHECKER);
  const files = {
    "model-of-tom/writing.md": WRITING,
    "model-of-tom/evidence/writing.md": WRITING_EVIDENCE,
    "model-of-tom/priorities.md": PRIORITIES,
    "model-of-tom/evidence/priorities.md": PRIORITIES_EVIDENCE,
    "model-of-tom/ground.md": GROUND,
    "model-of-tom/evidence/ground.md": GROUND_EVIDENCE,
    "model-of-tom/intent.md": INTENT,
    "model-of-tom/evidence/intent.md": INTENT_EVIDENCE,
    "model-of-tom/agent-rules.md": "# Agent rules\n\n## Map\n\n",
    "model-of-tom/evidence/agent-rules.md": "# Evidence\n\n## Map\n\n",
    "model-of-tom/schedule.md": "# Schedule\n\n## Week\n\n",
    "model-of-tom/evidence/schedule.md": "# Evidence\n\n## Week\n\n",
    "model-of-tom/areas/climbing.md": CLIMBING,
    "model-of-tom/evidence/areas/climbing.md": CLIMBING_EVIDENCE,
    "tts/spec.md": "# Spec\n\n## Rules\n\n- the spec's own line\n",
    ...over,
  };
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  return dir;
}

/**
 * An evidence file that mirrors every bullet of `pageText`, one entry each.
 * A test about the PAGE half of a record still needs a checkout the checker
 * passes on — the baseline is the first thing the step runs — and this is
 * what keeps the pair whole without hand-writing an entry per line.
 */
function mirrorEvidence(pageText) {
  const out = ["# Evidence", ""];
  const seen = new Set();
  let heading = null;
  for (const raw of pageText.split("\n")) {
    const h = /^#{1,6}\s+(.*?)\s*$/.exec(raw);
    if (h) {
      heading = h[1];
      out.push(`## ${heading}`, "");
      continue;
    }
    const m = /^- (.*\S)\s*$/.exec(raw);
    if (m === null || heading === null || heading === "Directions") continue;
    const key = `${heading} ${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`- line: ${m[1]}`);
    out.push(
      / \(inferred\)$/.test(m[1])
        ? "  rests on: 2026-08-30 · session 47f04bc9 · read off the record."
        : `  said: 2026-08-30 · session 47f04bc9 · "${m[1]}"`,
    );
  }
  out.push("");
  return out.join("\n");
}

/** A page and its mirrored evidence file, written together. */
function writePage(dir, rel, text) {
  write(dir, rel, text);
  write(dir, rel.replace("model-of-tom/", "model-of-tom/evidence/"), mirrorEvidence(text));
}

/** Every file under `dir`, hashed — what a rolled-back night must equal. */
function treeHash(dir) {
  const out = [];
  const walk = (rel) => {
    const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const next = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else out.push(`${next} ${sha256(fs.readFileSync(path.join(dir, next)))}`);
    }
  };
  walk("");
  return out.join("\n");
}

// The session's Convex row id, its SDK session id, and the id the pages cite
// it by (the SDK id's first 8 hex characters — the key of WikiTom's
// sessions/ archive, as the pages already write it: "session 47f04bc9").
const SESSION_ROW = "k97abc123def456ghi789jkl012mno34";
const SDK_SESSION = "9e1c2b3a-4d5e-4f60-8a7b-8c9d0e1f2a3b";
const SESSION = "9e1c2b3a";
const TURN = "turn0001turn0001turn0001turn0001";
const RULING = "rul0001rul0001rul0001rul0001rul0";

const TOM_TEXT = "thursday practice moved to 6pm this term";

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
        text: TOM_TEXT,
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

const NEW_LINE = "- Thursday practice is at 6 p.m. this term.";
const SAID = {
  form: "said",
  date: "2026-09-05",
  source: `session ${SESSION}`,
  text: TOM_TEXT,
};
const factChange = (over = {}) => ({
  file: "model-of-tom/areas/climbing.md",
  section: "Current state",
  op: "add",
  line: "Thursday practice is at 6 p.m. this term.",
  replaces: null,
  inferred: false,
  signal: null,
  evidence: [{ ...SAID }],
  // The said: entry IS the excerpt (R1); the step fills it when the model
  // leaves it out.
  excerpt: TOM_TEXT,
  ...over,
});

const answering = (changes) => () => JSON.stringify({ changes });

/** The pages and their evidence mirror, as applyLearningChanges takes them. */
function pagesOf(dir, rels) {
  const pages = new Map();
  const evidence = new Map();
  for (const rel of rels) {
    pages.set(rel, fs.readFileSync(path.join(dir, rel), "utf8"));
    const eRel = rel.replace("model-of-tom/", "model-of-tom/evidence/");
    evidence.set(eRel, fs.readFileSync(path.join(dir, eRel), "utf8"));
  }
  return { pages, evidence };
}

describe("the learning step", () => {
  it("ends the prompt with the UTC day, after its pages, evidence files, input and signals", () => {
    const dir = learningCheckout();
    const { pages, evidence } = pagesOf(dir, ["model-of-tom/areas/climbing.md"]);
    const { prompt, turnsDropped } = learningPrompt(learningInput(), pages, evidence, [], "2026-09-06");
    expect(turnsDropped).toBe(0);
    expect(prompt.endsWith("Tonight is 2026-09-06 (UTC).")).toBe(true);
    expect(prompt.indexOf("TWO RECORDS")).toBeLessThan(prompt.indexOf("RULES"));
    // The rarely-changing files first, tonight's input and signals last, so
    // the prompt cache holds from one night to the next.
    const at = (header) => prompt.indexOf(`\n${header}\n`);
    const evidenceAt = prompt.indexOf("\nEVIDENCE FILES (the entries already on record; never propose a duplicate)\n");
    expect(at("PAGES")).toBeLessThan(evidenceAt);
    expect(evidenceAt).toBeLessThan(at("INPUT"));
    expect(at("INPUT")).toBeLessThan(at("GROUND SIGNALS"));
    expect(prompt).toContain("=== model-of-tom/evidence/areas/climbing.md ===");
  });

  it("drops the oldest turns when the prompt is longer than its cap", () => {
    const dir = learningCheckout();
    const { pages, evidence } = pagesOf(dir, ["model-of-tom/areas/climbing.md"]);
    const big = Array.from({ length: 200 }, (_, i) => ({
      id: `t${i}`,
      sessionId: SESSION_ROW,
      sdkSessionId: SDK_SESSION,
      sessionTitle: "long",
      text: "x".repeat(LEARNING_TURN_CHARS),
      at: Date.UTC(2026, 8, 5, 1) + i * 1000,
      replyBefore: null,
      replyAfter: null,
    }));
    const { prompt, turnsDropped } = learningPrompt(
      learningInput({ tomTurns: big }),
      pages,
      evidence,
      [],
      "2026-09-06",
    );
    expect(prompt.length).toBeLessThanOrEqual(LEARNING_PROMPT_CHARS);
    expect(turnsDropped).toBeGreaterThan(0);
    // The oldest went; the newest stayed.
    expect(prompt).toContain('"turnId": "t199"');
    expect(prompt).not.toContain('"turnId": "t0"');
  });

  it("writes both records, bumps updated:, passes the checker, and queues its row and commit", async () => {
    const dir = learningCheckout();
    const convex = fakeConvex(learningInput());
    const run = learningRun(dir);
    const modelCalls = [];
    const model = (prompt, opts) => {
      modelCalls.push({ prompt, opts });
      return `Here you go:\n\`\`\`json\n${JSON.stringify({ changes: [factChange()] })}\n\`\`\``;
    };
    const summary = await learningStep(run, { fetch: convex.fetch, model });

    // The page: the bullet, and nothing of the source in it.
    const page = fs.readFileSync(path.join(dir, "model-of-tom/areas/climbing.md"), "utf8");
    const lines = page.split("\n");
    expect(lines[1]).toBe("updated: 2026-09-06");
    expect(lines[2]).toBe("reviewed:");
    const at = lines.indexOf(NEW_LINE);
    expect(at).toBeGreaterThan(lines.indexOf("## Current state"));
    expect(at).toBeLessThan(lines.indexOf("## Ideal state"));
    expect(lines[at - 1]).toContain("Ankle:");
    expect(NEW_LINE).not.toMatch(/session |\d{4}-\d{2}-\d{2}|"/);

    // The evidence entry: his words, the date and the source, under the same
    // heading — and the checker green over the pair.
    const entry = fs.readFileSync(path.join(dir, "model-of-tom/evidence/areas/climbing.md"), "utf8");
    expect(entry).toContain(
      `- line: Thursday practice is at 6 p.m. this term.\n  said: 2026-09-05 · session ${SESSION} · "${TOM_TEXT}"`,
    );
    expect(runEvidenceCheck(dir).ok).toBe(true);

    expect(summary).toMatchObject({ changes: 1, refused: [], model: "opus", checkFailed: false, removed: 0, inferred: 0 });
    expect(run.learningRows).toHaveLength(1);
    expect(run.learningRows[0]).toEqual({
      kind: "learning-change",
      data: {
        id: learningChangeId("model-of-tom/areas/climbing.md", "Current state", NEW_LINE),
        file: "model-of-tom/areas/climbing.md",
        section: "Current state",
        kind: "add",
        signal: null,
        before: "",
        after: NEW_LINE,
        beforeEntry: "",
        afterEntry: `- line: Thursday practice is at 6 p.m. this term.\n  said: 2026-09-05 · session ${SESSION} · "${TOM_TEXT}"`,
        inferred: false,
        // form: source, which is what the digest prints in its parenthetical.
        evidence: `said: session ${SESSION}`,
        sources: [`session ${SESSION}`],
        excerpt: TOM_TEXT,
        baseBlob: pageBodyBlob(CLIMBING),
        resultBlob: pageBodyBlob(page),
        evidenceBaseBlob: pageBodyBlob(CLIMBING_EVIDENCE),
        evidenceResultBlob: pageBodyBlob(entry),
      },
      commitMessage: "learning: 2026-09-06 — 1 line from Tom's turns, replies and rulings",
    });
    expect(run.commits).toEqual([
      {
        paths: ["model-of-tom"],
        message: "learning: 2026-09-06 — 1 line from Tom's turns, replies and rulings",
      },
    ]);
    expect(convex.posts).toHaveLength(1);
    expect(convex.posts[0].body.kind).toBe("learning-run");
    // One model call, the Opus tier, over the pages, the evidence and the input.
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0].opts).toMatchObject({ model: "opus", cwd: dir });
    expect(modelCalls[0].prompt).toContain(TOM_TEXT);
    expect(modelCalls[0].prompt).toContain("=== model-of-tom/areas/climbing.md ===");
    expect(modelCalls[0].prompt).toContain(`"session": "${SESSION}"`);
    expect(modelCalls[0].prompt).not.toContain(SESSION_ROW);
    // The other pages are untouched.
    expect(fs.readFileSync(path.join(dir, "model-of-tom/priorities.md"), "utf8")).toBe(PRIORITIES);
  });

  it("fills the excerpt from the longest said: entry when the model left it out", () => {
    const dir = learningCheckout();
    const { pages, evidence } = pagesOf(dir, ["model-of-tom/areas/climbing.md"]);
    const { applied, refused } = applyLearningChanges(
      pages,
      [factChange({ excerpt: undefined })],
      { day: "2026-09-06", evidence: learningEvidence(learningInput()), evidencePages: evidence },
    );
    expect(refused).toEqual([]);
    expect(applied[0].excerpt).toBe(TOM_TEXT);
  });

  // ── The refusal table: one case per message ────────────────────────────────
  it("refuses each way a change can be wrong, by its exact message, and writes nothing", async () => {
    const dir = learningCheckout();
    const before = treeHash(dir);
    const run = learningRun(dir);
    const convex = fakeConvex(learningInput());
    const summary = await learningStep(run, {
      fetch: convex.fetch,
      model: answering([
        // where
        factChange({ file: "tts/spec.md", section: "Rules" }),
        factChange({ file: "model-of-tom/areas/nowhere.md" }),
        // the section
        factChange({ section: "" }),
        factChange({ section: "Ideal state" }),
        factChange({ section: "Must not break" }),
        factChange({ file: "model-of-tom/priorities.md", section: "Directions" }),
        // the operation
        factChange({ op: "amend" }),
        factChange({ op: "remove", replaces: "Ankle: minor chronic pain from jumping down off the wall.", line: undefined }),
        // the line
        factChange({ line: "" }),
        factChange({ line: `Thursday practice moved (session ${SESSION}).` }),
        factChange({ line: "Thursday practice moved on 2026-09-05." }),
        factChange({ line: 'He said "thursday practice moved to 6pm this term" himself.' }),
        factChange({ line: "He probably trains Thursdays.", inferred: true }),
        factChange({ line: "He trains Thursdays. (inferred)", inferred: false }),
        // the evidence entries
        factChange({ evidence: [] }),
        factChange({ evidence: [{ ...SAID, form: "shouted" }] }),
        factChange({ evidence: [{ ...SAID, source: SESSION }] }),
        factChange({ evidence: [{ ...SAID, source: "session deadbeef" }] }),
        factChange({ evidence: [{ ...SAID, date: "2026-09-31" }] }),
        factChange({ evidence: [{ ...SAID, date: "2026-08-30" }] }),
        factChange({
          line: "He trains Thursdays. (inferred)",
          inferred: true,
          evidence: [{ ...SAID }, { ...SAID, form: "rests on", text: "read off the turn" }],
          excerpt: TOM_TEXT,
        }),
        factChange({ evidence: [{ ...SAID, form: "rests on", text: "read off the turn" }] }),
        factChange({
          evidence: [{ ...SAID, form: "read", text: "the record says the practice moved." }],
        }),
        factChange({ evidence: [{ ...SAID, text: "thursday practice moved to 7pm this term" }] }),
        factChange({
          evidence: [{ ...SAID, form: "paraphrase", text: "he moved the practice." }],
          excerpt: "moved it",
        }),
        factChange({
          evidence: [{ ...SAID, form: "paraphrase", text: "he moved the practice." }],
          excerpt: "practice is on Fridays now this term",
        }),
        factChange({ excerpt: "Which practice moved? Noted: Thursday at" }),
        // what a replacement replaces
        factChange({ op: "replace", replaces: null }),
        factChange({ op: "replace", replaces: "A line that is not on the page." }),
        factChange({ op: "add", replaces: "Ankle: minor chronic pain from jumping down off the wall." }),
      ]),
    });
    expect(summary.changes).toBe(0);
    expect(summary.refused.map((r) => r.reason)).toEqual([
      "tts/spec.md is not a page the learning step writes",
      "model-of-tom/areas/nowhere.md is not in the checkout",
      "no section named",
      '"Ideal state" is Tom\'s section; an agent never writes it',
      '"Must not break" is Tom\'s section; an agent never writes it',
      '"Directions" is Tom\'s section; an agent never writes it',
      "op must be add, replace or remove",
      'remove is allowed only on model-of-tom/ground.md under "Does not know"',
      "the line must be one non-empty line",
      "the line carries a citation; the pages hold no source",
      "the line carries a date; the pages hold no date",
      "the line quotes Tom; his words live in the evidence record",
      'an inferred line ends with "(inferred)"',
      'only an inferred line ends with "(inferred)"',
      "no evidence",
      'evidence form "shouted" is not said, paraphrase, read or rests on',
      `evidence "${SESSION}" is not a citation: session <id>, ruling <id> or thread <ts>`,
      'evidence "session deadbeef" names nothing in tonight\'s input',
      "the evidence date 2026-09-31 is not a day",
      "the evidence date 2026-08-30 is outside tonight's window (2026-09-05 to 2026-09-06)",
      'an inferred line\'s evidence is "rests on" only',
      'a "rests on" entry on a line that is not marked (inferred)',
      "a change to a model-of-tom page needs said:, paraphrase: or rests on:; read: alone is the record describing itself",
      `said: "thursday practice moved to 7pm this term" is not in session ${SESSION} verbatim`,
      "no excerpt of 6 or more of Tom's words from tonight's input",
      "the excerpt is not in the cited input verbatim",
      "the excerpt is not one of the change's said: entries",
      "replaces must be one existing bullet, or null",
      'the line to replace is not in "Current state" verbatim',
      "an add replaces nothing; `replaces` is null",
    ]);
    expect(treeHash(dir)).toBe(before);
    expect(run.learningRows).toEqual([]);
    expect(run.commits).toEqual([]);
    expect(convex.posts.map((p) => p.body.kind)).toEqual(["learning-run"]);
  });

  it("refuses a page whose evidence file is not in the checkout", () => {
    const dir = learningCheckout();
    const { pages } = pagesOf(dir, ["model-of-tom/areas/climbing.md"]);
    const { refused } = applyLearningChanges(pages, [factChange()], {
      day: "2026-09-06",
      evidencePages: new Map(),
    });
    expect(refused[0].reason).toBe("no evidence file model-of-tom/evidence/areas/climbing.md");
  });

  it("refuses an answer whose change carries no evidence array at all", () => {
    expect(() => parseLearningAnswer('{"changes": [{"file": "f"}]}')).toThrow(
      /^learning change 0 has no evidence array$/,
    );
    expect(() => parseLearningAnswer('{"changes": [1]}')).toThrow(/not an object/);
  });

  // ── ground.md: the signal is code, not judgment ────────────────────────────
  it("takes a ground line only from a deterministic signal, and only with his own words", async () => {
    const dir = learningCheckout();
    const complains = "you are using a lot of made up names for different experiments that I dont understand.";
    const confirms = "I understand the vocab you defined so use that and other standard cmt language.";
    const input = learningInput({
      tomTurns: [
        {
          id: TURN,
          sessionId: SESSION_ROW,
          sdkSessionId: SDK_SESSION,
          sessionTitle: "cmt september doc",
          text: `${complains} ${confirms}`,
          at: Date.UTC(2026, 8, 5, 20),
          replyBefore: "I have been calling these terminal detectors.",
          replyAfter: "Understood — I will use the CMT vocabulary.",
        },
      ],
      rulings: [],
    });
    const run = learningRun(dir);
    const convex = fakeConvex(input);
    const ground = (over = {}) =>
      factChange({
        file: "model-of-tom/ground.md",
        section: "Knows",
        line: "CMT's vocabulary, including the terms agents defined for him there.",
        signal: "g-1",
        evidence: [{ form: "said", date: "2026-09-05", source: `session ${SESSION}`, text: confirms }],
        excerpt: confirms,
        ...over,
      });
    const summary = await learningStep(run, {
      fetch: convex.fetch,
      model: answering([
        ground({ signal: null }),
        ground({ signal: "g-9" }),
        ground({ section: "How to explain", line: "Use the CMT vocabulary he confirmed.", signal: "g-1" }),
        ground({
          section: "Knows",
          line: "He is fluent in every CMT term. (inferred)",
          inferred: true,
          evidence: [{ form: "rests on", date: "2026-09-05", source: `session ${SESSION}`, text: "generalized from one turn." }],
          excerpt: confirms,
        }),
        // A said: of his, verbatim — but a DIFFERENT sentence of the same
        // turn from the one the code detected. The line must trace to the
        // sentence the signal is.
        ground({
          section: "Knows",
          line: "He knows the sampling geometry.",
          evidence: [{ form: "said", date: "2026-09-05", source: `session ${SESSION}`, text: complains }],
          excerpt: complains,
        }),
        ground(),
      ]),
    });
    expect(summary.groundSignals).toBe(1);
    expect(summary.refused.map((r) => r.reason)).toEqual([
      "a change to ground.md names no signal",
      "signal g-9 is not in tonight's ground signals",
      'a line under "Knows" carries a said: entry; his fluent use of a term is not confirmation',
      "the said: entry does not contain the signal's sentence",
    ]);
    // "How to explain" takes a change from any signal kind, and the confirmed
    // term lands under "Knows".
    expect(summary.changes).toBe(2);
    expect(fs.readFileSync(path.join(dir, "model-of-tom/ground.md"), "utf8")).toContain(
      "- CMT's vocabulary, including the terms agents defined for him there.",
    );
    expect(runEvidenceCheck(dir).ok).toBe(true);
  });

  it("refuses a section that does not follow from the signal's kind", () => {
    const dir = learningCheckout();
    const { pages, evidence } = pagesOf(dir, ["model-of-tom/ground.md"]);
    const signals = [
      { id: "g-1", kind: "asked", term: "shards", source: `session ${SESSION}`, date: "2026-09-05", quote: TOM_TEXT },
    ];
    const { refused } = applyLearningChanges(
      pages,
      [
        factChange({
          file: "model-of-tom/ground.md",
          section: "Follows, without the details",
          line: "Cluster shards.",
          signal: "g-1",
        }),
      ],
      { day: "2026-09-06", evidence: learningEvidence(learningInput()), evidencePages: evidence, signals },
    );
    expect(refused[0].reason).toBe('"Follows, without the details" does not follow from a asked signal');
  });

  it("lets a term leave Does not know only beside the same night's line that says where it went", () => {
    const dir = learningCheckout();
    const { pages, evidence } = pagesOf(dir, ["model-of-tom/ground.md"]);
    const quote = "I understand the vocab you defined so use that and other standard cmt language.";
    const input = learningInput({
      tomTurns: [{ ...learningInput().tomTurns[0], text: quote }],
      rulings: [],
    });
    const signals = [
      { id: "g-1", kind: "confirmed", term: "vocab you defined", source: `session ${SESSION}`, date: "2026-09-05", quote },
    ];
    const said = { form: "said", date: "2026-09-05", source: `session ${SESSION}`, text: quote };
    const removal = factChange({
      file: "model-of-tom/ground.md",
      section: "Does not know",
      op: "remove",
      line: undefined,
      replaces: "A name an agent coined for an experiment, a run or a concept.",
      signal: "g-1",
      evidence: [said],
      excerpt: quote,
    });
    const addition = factChange({
      file: "model-of-tom/ground.md",
      section: "Knows",
      line: "The names agents coined in CMT, which he confirmed.",
      signal: "g-1",
      evidence: [said],
      excerpt: quote,
    });
    const opts = {
      day: "2026-09-06",
      evidence: learningEvidence(input),
      evidencePages: evidence,
      signals,
    };
    // Alone, the removal is refused.
    expect(applyLearningChanges(pages, [removal], opts).refused[0].reason).toBe(
      'a removal from "Does not know" needs the same night\'s line under "Knows" or "Follows, without the details" on the same signal',
    );
    // With its partner applied first, it lands and both records lose the term.
    const out = applyLearningChanges(pages, [addition, removal], opts);
    expect(out.refused).toEqual([]);
    expect(out.applied.map((a) => a.kind)).toEqual(["add", "remove"]);
    expect(out.pages.get("model-of-tom/ground.md")).not.toContain("- A name an agent coined");
    expect(out.evidencePages.get("model-of-tom/evidence/ground.md")).not.toContain(
      "That is not a term I recognize",
    );
  });

  // ── intent.md: his words, and his review ───────────────────────────────────
  it("takes an intent line only with a said: entry, and never Directions", () => {
    const dir = learningCheckout();
    const { pages, evidence } = pagesOf(dir, ["model-of-tom/intent.md"]);
    const opts = {
      day: "2026-09-06",
      evidence: learningEvidence(learningInput()),
      evidencePages: evidence,
    };
    const intent = (over = {}) =>
      factChange({ file: "model-of-tom/intent.md", section: "What to protect", line: "Practice time stays.", ...over });
    expect(applyLearningChanges(pages, [intent({ section: "Directions" })], opts).refused[0].reason).toBe(
      '"Directions" is Tom\'s section; an agent never writes it',
    );
    expect(
      applyLearningChanges(
        pages,
        [
          intent({
            evidence: [{ ...SAID, form: "paraphrase", text: "he wants practice time kept." }],
            excerpt: TOM_TEXT,
          }),
        ],
        opts,
      ).refused[0].reason,
    ).toBe("a line on intent.md carries a said: entry");
    expect(
      applyLearningChanges(
        pages,
        [
          intent({
            section: "What to protect",
            line: "Practice time stays. (inferred)",
            inferred: true,
            evidence: [{ ...SAID, form: "rests on", text: "read off the turn." }],
            excerpt: TOM_TEXT,
          }),
        ],
        opts,
      ).refused[0].reason,
    ).toBe('an inferred line on intent.md belongs under "What to push toward"');
    expect(applyLearningChanges(pages, [intent()], opts).refused).toEqual([]);
  });

  it("never edits a line the file's reviewed: date covers, except by his correction", () => {
    const dir = learningCheckout();
    const { pages, evidence } = pagesOf(dir, ["model-of-tom/intent.md"]);
    const file = "model-of-tom/intent.md";
    const eFile = "model-of-tom/evidence/intent.md";
    const opts = (entryDate) => ({
      day: "2026-09-06",
      evidence: learningEvidence(learningInput()),
      evidencePages: new Map([[eFile, evidence.get(eFile).replaceAll("2026-07-23", entryDate)]]),
    });
    const reviewedPages = (reviewed) =>
      new Map([[file, pages.get(file).replace("reviewed:", `reviewed: ${reviewed}`)]]);
    const replacement = (over = {}) =>
      factChange({
        file,
        section: "What to protect",
        op: "replace",
        line: "The PhD position, the lab and the funding stay.",
        replaces: "The PhD position and the lab stay.",
        ...over,
      });
    // The review is before tonight's window (2026-09-05 to 2026-09-06), so a
    // said: entry dated tonight is a correction made AFTER it.
    const REVIEWED = "2026-09-01";
    const refusal = `"The PhD position and the lab stay." is a line Tom reviewed on ${REVIEWED}; only his correction changes it`;
    const paraphrased = {
      evidence: [{ ...SAID, form: "paraphrase", text: "he wants the funding named too." }],
      excerpt: TOM_TEXT,
    };

    // Unreviewed: the replacement lands.
    expect(applyLearningChanges(pages, [replacement()], opts("2026-07-23")).refused).toEqual([]);
    // Reviewed after the entry, and the evidence is his own later word: lands.
    expect(
      applyLearningChanges(reviewedPages(REVIEWED), [replacement()], opts("2026-08-01")).refused,
    ).toEqual([]);
    // The same, but the evidence is a paraphrase and not his correction: refused.
    expect(
      applyLearningChanges(reviewedPages(REVIEWED), [replacement(paraphrased)], opts("2026-08-01"))
        .refused[0].reason,
    ).toBe(refusal);
    // The entry is dated after the review: the line already moved on.
    expect(
      applyLearningChanges(reviewedPages(REVIEWED), [replacement(paraphrased)], opts("2026-09-02")).refused,
    ).toEqual([]);
    // An add on a reviewed file always lands: the review approved what was
    // there, not what may come.
    expect(
      applyLearningChanges(
        reviewedPages(REVIEWED),
        [factChange({ file, section: "What to protect", line: "Practice time stays." })],
        opts("2026-08-01"),
      ).refused,
    ).toEqual([]);
  });

  it("guards a reviewed AREA page by the same code path", () => {
    const dir = learningCheckout();
    const { pages, evidence } = pagesOf(dir, ["model-of-tom/areas/climbing.md"]);
    const file = "model-of-tom/areas/climbing.md";
    const reviewed = new Map([[file, pages.get(file).replace("reviewed:", "reviewed: 2026-09-10")]]);
    const { refused } = applyLearningChanges(
      reviewed,
      [
        factChange({
          op: "replace",
          line: "Ankle: pain gone since the first of the month.",
          replaces: "Ankle: minor chronic pain from jumping down off the wall.",
          evidence: [{ ...SAID, form: "paraphrase", text: "his ankle is better." }],
          excerpt: TOM_TEXT,
        }),
      ],
      { day: "2026-09-06", evidence: learningEvidence(learningInput()), evidencePages: evidence },
    );
    expect(refused[0].reason).toBe(
      '"Ankle: minor chronic pain from jumping down off the wall." is a line Tom reviewed on 2026-09-10; only his correction changes it',
    );
    // The pure guard, on its own.
    expect(reviewedRefusal({ op: "add" }, "2026-09-10", [])).toBeNull();
    expect(reviewedRefusal({ op: "replace", replaces: "x", evidence: [] }, "", [])).toBeNull();
    expect(reviewedRefusal({ op: "replace", replaces: "x", evidence: [] }, "2026-09-10", ["2026-09-12"])).toBeNull();
    expect(
      reviewedRefusal(
        { op: "replace", replaces: "x", evidence: [{ form: "said", date: "2026-09-11" }] },
        "2026-09-10",
        ["2026-09-01"],
      ),
    ).toBeNull();
  });

  // ── The whole-run gate ─────────────────────────────────────────────────────
  it("writes nothing at all when the checkout was already failing its check", async () => {
    const dir = learningCheckout();
    // Somebody else's damage: an entry whose line is gone from the page.
    write(
      dir,
      "model-of-tom/evidence/writing.md",
      `${WRITING_EVIDENCE}- line: A line no page carries.\n  said: 2026-08-18 · session 81be510a · "no page carries it"\n`,
    );
    const before = treeHash(dir);
    const run = learningRun(dir);
    const convex = fakeConvex(learningInput());
    const model = vi.fn();
    const summary = await learningStep(run, { fetch: convex.fetch, model });
    expect(model).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ checkFailed: true, changes: 0, reverted: 0 });
    expect(summary.checkOutput).toContain("matches no synthesis line");
    expect(treeHash(dir)).toBe(before);
    expect(run.learningRows).toEqual([{ kind: LEARNING_CHECK_FAILED, data: { baseline: true, output: summary.checkOutput } }]);
    expect(run.commits).toEqual([]);
    expect(convex.posts.map((p) => p.body.kind)).toEqual(["learning-run"]);
  });

  // witness: half a night's lines on the pages with no entries behind them is
  // the one state from which nobody can tell what was learned.
  it("takes back every change of the night when the check fails after them, byte for byte", async () => {
    const dir = learningCheckout();
    const before = treeHash(dir);
    const run = learningRun(dir);
    const convex = fakeConvex(learningInput());
    // The writer is fine; the CHECKER is what refuses — here because the
    // checkout's copy of it is replaced by one that always fails, which is
    // the same shape as a real disagreement between the two records.
    write(dir, "scripts/check-evidence.mjs", 'console.error("boom: the records disagree");\nprocess.exit(1);\n');
    const after = treeHash(dir);
    const summary = await learningStep(run, {
      fetch: convex.fetch,
      model: answering([factChange()]),
    });
    // The baseline failed first, so nothing ran at all — that is the point of
    // the baseline. Now with a checker that passes once and then fails: the
    // step's own writes are what the second check refuses.
    expect(summary).toMatchObject({ checkFailed: true, changes: 0 });
    expect(treeHash(dir)).toBe(after);
    expect(before).not.toBe(after);
  });

  it("rolls the night back whole when the second check fails, and posts no applied rows", async () => {
    const dir = learningCheckout();
    // A checker that passes the baseline and fails after the write: it fails
    // exactly when the page holds tonight's line.
    write(
      dir,
      "scripts/check-evidence.mjs",
      [
        'import { readFileSync } from "node:fs";',
        'const page = readFileSync("model-of-tom/areas/climbing.md", "utf8");',
        'if (page.includes("6 p.m.")) { console.error("the records disagree"); process.exit(1); }',
        'console.log("ok");',
      ].join("\n"),
    );
    const before = treeHash(dir);
    const run = learningRun(dir);
    const convex = fakeConvex(learningInput());
    const summary = await learningStep(run, { fetch: convex.fetch, model: answering([factChange()]) });
    expect(summary).toMatchObject({ checkFailed: true, changes: 0 });
    expect(summary.checkOutput).toContain("the records disagree");
    // Byte for byte, including the evidence file the write created lines in.
    expect(treeHash(dir)).toBe(before);
    expect(run.learningRows).toEqual([
      {
        kind: LEARNING_CHECK_FAILED,
        data: { baseline: false, stage: "changes", changes: 1, output: summary.checkOutput },
      },
    ]);
    expect(run.commits).toEqual([]);
  });

  it("makes no model call on a night with nothing of Tom's in the window", async () => {
    const dir = learningCheckout();
    const run = learningRun(dir);
    const convex = fakeConvex(learningInput({ tomTurns: [], rulings: [] }));
    const model = vi.fn();
    const summary = await learningStep(run, { fetch: convex.fetch, model });
    expect(model).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ changes: 0, model: null, tomTurns: 0, checkFailed: false });
    expect(convex.posts.map((p) => p.body.kind)).toEqual(["learning-run"]);
  });

  it("rejects a malformed answer before applying anything", async () => {
    const dir = learningCheckout();
    const before = treeHash(dir);
    const run = learningRun(dir);
    const convex = fakeConvex(learningInput());
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
    expect(treeHash(dir)).toBe(before);
    expect(run.learningRows).toEqual([]);
    expect(run.commits).toEqual([]);
    // No run row either: the next night reads the same window again.
    expect(convex.posts).toEqual([]);
  });

  // ── Reverts take back both records ─────────────────────────────────────────
  it("reverts an addition and a replacement on Tom's objection, by id and by the line's text", async () => {
    const dir = learningCheckout();
    const file = "model-of-tom/areas/climbing.md";
    const eFile = "model-of-tom/evidence/areas/climbing.md";
    const old = "- Ankle: minor chronic pain from jumping down off the wall.";
    const oldEntry = [
      "- line: Ankle: minor chronic pain from jumping down off the wall.",
      '  said: 2026-08-30 · session 47f04bc9 · "my ankle hurts from jumping off the wall"',
    ].join("\n");
    const replaced = "- Ankle: pain gone since the first of the month.";
    const replacedEntry = [
      "- line: Ankle: pain gone since the first of the month.",
      `  said: 2026-09-05 · session ${SESSION} · "${TOM_TEXT}"`,
    ].join("\n");
    const addedEntry = [
      "- line: Thursday practice is at 6 p.m. this term.",
      `  said: 2026-09-05 · session ${SESSION} · "${TOM_TEXT}"`,
    ].join("\n");
    // The records as an earlier night left them.
    write(
      dir,
      file,
      CLIMBING.replace(old, replaced).replace("## Ideal state", `${NEW_LINE}\n\n## Ideal state`),
    );
    write(
      dir,
      eFile,
      CLIMBING_EVIDENCE.replace(oldEntry, `${replacedEntry}\n${addedEntry}`),
    );
    expect(runEvidenceCheck(dir).ok).toBe(true);
    const added = {
      id: "aaaaaaaaaaaa",
      file,
      section: "Current state",
      before: "",
      beforeEntry: "",
      after: NEW_LINE,
    };
    const changed = {
      id: "bbbbbbbbbbbb",
      file,
      section: "Current state",
      before: old,
      beforeEntry: oldEntry,
      after: replaced,
    };
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
    const entries = fs.readFileSync(path.join(dir, eFile), "utf8");
    expect(page).not.toContain(NEW_LINE);
    expect(page).not.toContain(replaced);
    expect(page).toContain(old);
    expect(entries).not.toContain("Thursday practice is at 6 p.m.");
    expect(entries).not.toContain("pain gone since the first");
    expect(entries).toContain("my ankle hurts from jumping off the wall");
    expect(page.startsWith("---\nupdated: 2026-09-06\n")).toBe(true);
    expect(runEvidenceCheck(dir).ok).toBe(true);
    expect(summary).toMatchObject({ objections: 2, reverted: 2, revertFailed: 0, changes: 0 });
    expect(run.learningRows.map((r) => r.kind)).toEqual(["learning-reverted", "learning-reverted"]);
    expect(run.learningRows[0].data).toMatchObject({
      id: "aaaaaaaaaaaa",
      file,
      before: NEW_LINE,
      after: "",
      evidenceMissing: false,
      objectionId: "ev1",
      objection: "no, that was one week",
    });
    expect(run.learningRows[1].data).toMatchObject({ id: "bbbbbbbbbbbb", before: replaced, after: old });
    expect(run.commits).toEqual([
      { paths: ["model-of-tom"], message: "learning: 2026-09-06 — 2 lines reverted on Tom's objection" },
    ]);
    expect(convex.posts.map((p) => p.route)).toEqual(["/tts/learning-objections-consumed", "/tts/event"]);
    expect(convex.posts[0].body).toEqual({ ids: ["ev1", "ev2"] });
  });

  it("refuses to revert a replacement whose row predates the evidence record", async () => {
    const dir = learningCheckout();
    const file = "model-of-tom/areas/climbing.md";
    const old = "- Ankle: minor chronic pain from jumping down off the wall.";
    const replaced = "- Ankle: pain gone since the first of the month.";
    write(dir, file, CLIMBING.replace(old, replaced));
    write(
      dir,
      "model-of-tom/evidence/areas/climbing.md",
      CLIMBING_EVIDENCE.replace(
        "- line: Ankle: minor chronic pain from jumping down off the wall.",
        "- line: Ankle: pain gone since the first of the month.",
      ),
    );
    const run = learningRun(dir);
    const convex = fakeConvex(
      learningInput({
        tomTurns: [],
        rulings: [],
        objections: [{ eventId: "ev1", at: 1, id: "bbbbbbbbbbbb", text: "no" }],
        changes: [{ id: "bbbbbbbbbbbb", file, section: "Current state", before: old, after: replaced }],
      }),
    );
    const summary = await learningStep(run, { fetch: convex.fetch, model: vi.fn() });
    expect(summary).toMatchObject({ reverted: 0, revertFailed: 1 });
    expect(run.learningRows[0].data.reason).toBe(
      "the change predates the evidence record; revert it by hand",
    );
  });

  // A page line whose entry is gone is exactly what the checker refuses, so
  // the step never meets this through its own baseline; the revert is asked
  // directly. The page half still goes back — refusing there would strand his
  // objection — and the row says the entry was already missing.
  it("takes the page line back when the entry is already gone, and says so", () => {
    const page = CLIMBING.replace("## Ideal state", `${NEW_LINE}\n\n## Ideal state`);
    const out = revertLearningRecords(page, CLIMBING_EVIDENCE, {
      id: "aaaaaaaaaaaa",
      file: "model-of-tom/areas/climbing.md",
      section: "Current state",
      before: "",
      beforeEntry: "",
      after: NEW_LINE,
    });
    expect(out.ok).toBe(true);
    expect(out.evidenceMissing).toBe(true);
    expect(out.pageText).not.toContain(NEW_LINE);
    expect(out.evidenceText).toBe(CLIMBING_EVIDENCE);
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
      reason: `the line is no longer in "Current state" on ${file} as written`,
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
    const input = learningInput({
      slackReplies: [
        {
          id: "ev9",
          at: Date.UTC(2026, 8, 5, 22),
          data: {
            ts: "1757000000.000100",
            threadTs: "1757000000.000001",
            text: "yes, the thursday one, keep it there",
          },
        },
      ],
    });
    const evidence = learningEvidence(input);
    expect(evidence).toMatchObject({ sinceDay: "2026-09-05", untilDay: "2026-09-06" });
    expect([...evidence.sources.keys()].sort()).toEqual(
      [
        `session ${SESSION}`,
        `session ${SDK_SESSION}`,
        `session ${SESSION_ROW}`,
        `ruling ${RULING}`,
        "thread 1757000000.000100",
        "thread 1757000000.000001",
      ].sort(),
    );
    // A turn's row id is not a session's name.
    expect(evidence.sources.has(`session ${TURN}`)).toBe(false);
    expect(evidence.sources.get(`session ${SESSION}`).texts).toEqual([TOM_TEXT]);
    const dir = learningCheckout();
    const { pages, evidence: evidencePages } = pagesOf(dir, ["model-of-tom/areas/climbing.md"]);
    for (const named of [SESSION, SDK_SESSION, SESSION_ROW]) {
      const { applied, refused } = applyLearningChanges(
        pages,
        [factChange({ evidence: [{ ...SAID, source: `session ${named}` }] })],
        { day: "2026-09-06", evidence, evidencePages },
      );
      expect(refused).toEqual([]);
      expect(applied).toHaveLength(1);
      expect(applied[0].excerpt).toBe(TOM_TEXT);
    }
    // A Slack reply is cited as a thread, and its said: comes from the reply.
    const { applied, refused } = applyLearningChanges(
      pages,
      [
        factChange({
          line: "Thursday practice stays where it is.",
          evidence: [
            {
              form: "said",
              date: "2026-09-05",
              source: "thread 1757000000.000001",
              text: "the thursday one, keep it there",
            },
          ],
          excerpt: "the thursday one, keep it there",
        }),
      ],
      { day: "2026-09-06", evidence, evidencePages },
    );
    expect(refused).toEqual([]);
    expect(applied).toHaveLength(1);
  });

  it("names the pages it writes, and the sections it never does", () => {
    expect(isLearningFile("model-of-tom/writing.md")).toBe(true);
    expect(isLearningFile("model-of-tom/priorities.md")).toBe(true);
    expect(isLearningFile("model-of-tom/ground.md")).toBe(true);
    expect(isLearningFile("model-of-tom/intent.md")).toBe(true);
    expect(isLearningFile("model-of-tom/areas/health-and-food.md")).toBe(true);
    expect(isLearningFile("model-of-tom/schedule.md")).toBe(false);
    expect(isLearningFile("model-of-tom/agent-rules.md")).toBe(false);
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
      { id: "0123456789ab", file: "f", before: "", after: "- He climbs Thursdays at 6 p.m. this term." },
      { id: "fedcba987654", file: "f", before: "- old", after: "- new" },
    ];
    expect(matchObjection({ id: "fedcba987654", text: "no" }, changes)).toBe(changes[1]);
    expect(matchObjection({ id: null, text: "[01234567] is wrong" }, changes)).toBe(changes[0]);
    expect(matchObjection({ id: null, text: "He climbs Thursdays at 6 p.m. this term. — no" }, changes)).toBe(
      changes[0],
    );
    // A short line's text is not enough to name it, and a hex-looking word
    // that prefixes no change names nothing.
    expect(matchObjection({ id: null, text: "new" }, changes)).toBeNull();
    expect(matchObjection({ id: null, text: "the deadbeef line" }, changes)).toBeNull();
  });

  it("reverts against the records' current text, and says when the line has moved on", () => {
    const change = { file: "f", section: "Current state", before: "", beforeEntry: "", after: NEW_LINE };
    const withLine = `## Current state\n\n- a\n${NEW_LINE}\n- b\n`;
    expect(revertLearningRecords(withLine, "", change)).toMatchObject({
      ok: true,
      pageText: "## Current state\n\n- a\n- b\n",
    });
    expect(revertLearningRecords("## Current state\n\n- a\n- b\n", "", change)).toEqual({
      ok: false,
      reason: 'the line is no longer in "Current state" on f as written',
    });
    expect(revertLearningRecords("## Other\n\n- a\n", "", change)).toEqual({
      ok: false,
      reason: 'no section "Current state" on f',
    });
  });

  it("reverts only inside the change's own section: a copy Tom pasted into Must not break stays", async () => {
    const dir = learningCheckout();
    const file = "model-of-tom/areas/climbing.md";
    const eFile = "model-of-tom/evidence/areas/climbing.md";
    // The line in Current state (where the job put it) AND in Must not break
    // (where Tom copied it) — it must still be the Current state one that goes.
    writePage(
      dir,
      file,
      CLIMBING.replace("## Ideal state", `${NEW_LINE}\n\n## Ideal state`).replace(
        "- Team practices are fixed.",
        `${NEW_LINE}\n- Team practices are fixed.`,
      ),
    );
    expect(runEvidenceCheck(dir).ok).toBe(true);
    expect(eFile).toBe("model-of-tom/evidence/areas/climbing.md");
    const added = { id: "aaaaaaaaaaaa", file, section: "Current state", before: "", beforeEntry: "", after: NEW_LINE };
    const run = learningRun(dir);
    const convex = fakeConvex(
      learningInput({
        tomTurns: [],
        rulings: [],
        objections: [{ eventId: "ev5", at: 1, id: "aaaaaaaaaaaa", text: "no" }],
        changes: [added],
      }),
    );
    const summary = await learningStep(run, { fetch: convex.fetch, model: vi.fn() });
    expect(summary).toMatchObject({ reverted: 1, revertFailed: 0 });
    const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
    const copies = lines.map((l, i) => (l === NEW_LINE ? i : -1)).filter((i) => i !== -1);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toBeGreaterThan(lines.indexOf("## Must not break"));
    // A second objection to the same change finds nothing in Current state
    // and does not go looking elsewhere.
    const again = revertLearningRecords(lines.join("\n"), "", added);
    expect(again).toEqual({ ok: false, reason: `the line is no longer in "Current state" on ${file} as written` });
  });

  // witness: the revert removed the FIRST match in the section, so with Tom's
  // copy of the line pasted above the job's, his went and the job's stayed.
  it("takes nothing back when the line is in its section twice, and says so", async () => {
    const dir = learningCheckout();
    const file = "model-of-tom/areas/climbing.md";
    // Tom's copy first, the job's (at the end of Current state) second.
    writePage(
      dir,
      file,
      CLIMBING.replace("- Climbing for 16 years", `${NEW_LINE}\n- Climbing for 16 years`).replace(
        "## Ideal state",
        `${NEW_LINE}\n\n## Ideal state`,
      ),
    );
    expect(runEvidenceCheck(dir).ok).toBe(true);
    const before = fs.readFileSync(path.join(dir, file), "utf8");
    const added = { id: "aaaaaaaaaaaa", file, section: "Current state", before: "", beforeEntry: "", after: NEW_LINE };
    const run = learningRun(dir);
    const convex = fakeConvex(
      learningInput({
        tomTurns: [],
        rulings: [],
        objections: [{ eventId: "ev7", at: 1, id: "aaaaaaaaaaaa", text: "no" }],
        changes: [added],
      }),
    );
    const summary = await learningStep(run, { fetch: convex.fetch, model: vi.fn() });
    expect(summary).toMatchObject({ reverted: 0, revertFailed: 1 });
    expect(fs.readFileSync(path.join(dir, file), "utf8")).toBe(before);
    expect(run.learningRows[0]).toMatchObject({
      kind: "learning-revert-failed",
      data: {
        id: "aaaaaaaaaaaa",
        reason: `the line is in "Current state" on ${file} 2 times — the learned copy cannot be told from the others, so none was taken back`,
      },
    });
    expect(run.commits).toEqual([]);
    // The same rule for a replacement's target: two copies, no replacement.
    const old = "- Ankle: minor chronic pain from jumping down off the wall.";
    const twice = new Map([[file, CLIMBING.replace(old, `${old}\n${old}`)]]);
    const { applied, refused } = applyLearningChanges(
      twice,
      [factChange({ op: "replace", replaces: old })],
      { day: "2026-09-06" },
    );
    expect(applied).toEqual([]);
    expect(refused.map((r) => r.reason)).toEqual([
      'the line to replace is in "Current state" 2 times; which one cannot be told',
    ]);
  });

  it("computes git's own blob id, of the body below the frontmatter", () => {
    const body = "## Current state\n\n- a\n";
    const fromGit = execFileSync("git", ["hash-object", "--stdin"], { input: body, encoding: "utf8" }).trim();
    expect(gitBlobId(body)).toBe(fromGit);
    expect(pageBodyBlob(`---\nupdated: 2026-09-01\n---\n${body}`)).toBe(fromGit);
    expect(pageBodyBlob(`---\nupdated: 2026-09-06\nreviewed: 2026-09-06\n---\n${body}`)).toBe(fromGit);
    expect(pageBodyBlob(body)).toBe(fromGit);
    expect(pageBodyBlob(`${body}- b\n`)).not.toBe(fromGit);
    // The newest recorded write per file, reverts included; a row without a blob is skipped.
    expect(
      expectedBodyBlobs([
        { at: 1, file: "f", resultBlob: "old" },
        { at: 3, file: "f", eventKind: "learning-reverted", resultBlob: "new" },
        { at: 2, file: "f", resultBlob: "mid" },
        { at: 9, file: "f" },
        { at: 1, file: "g", resultBlob: "g1" },
      ]),
    ).toEqual(new Map([["f", "new"], ["g", "g1"]]));
    // The evidence half, keyed by the synthesis file so one lookup serves both.
    expect(
      expectedEvidenceBlobs([
        { at: 1, file: "f", evidenceResultBlob: "e1" },
        { at: 3, file: "f", evidenceResultBlob: "e3" },
        { at: 2, file: "f" },
      ]),
    ).toEqual(new Map([["f", "e3"]]));
  });

  // witness: a learning row carried no hash of the page, so a revert applied
  // to whatever text the page had by then — Tom's edits included.
  it("reverts only records as the job last left them, and moves that mark on with each revert", async () => {
    const file = "model-of-tom/areas/climbing.md";
    const second = "- Rest days are Mondays.";
    const asLeft = CLIMBING.replace("## Ideal state", `${NEW_LINE}\n${second}\n\n## Ideal state`);
    const rows = [
      { id: "aaaaaaaaaaaa", at: 1, eventKind: "learning-change", file, section: "Current state", before: "", beforeEntry: "", after: NEW_LINE, resultBlob: pageBodyBlob(asLeft) },
      { id: "bbbbbbbbbbbb", at: 1, eventKind: "learning-change", file, section: "Current state", before: "", beforeEntry: "", after: second, resultBlob: pageBodyBlob(asLeft) },
    ];
    const objections = [
      { eventId: "ev8", at: 1, id: "aaaaaaaaaaaa", text: "no" },
      { eventId: "ev9", at: 2, id: "bbbbbbbbbbbb", text: "no" },
    ];
    // As the job left it: both go, the second checked against what the first left.
    {
      const dir = learningCheckout();
      writePage(dir, file, asLeft);
      const run = learningRun(dir);
      const convex = fakeConvex(learningInput({ tomTurns: [], rulings: [], objections, changes: rows }));
      const summary = await learningStep(run, { fetch: convex.fetch, model: vi.fn() });
      expect(summary).toMatchObject({ reverted: 2, revertFailed: 0 });
      const page = fs.readFileSync(path.join(dir, file), "utf8");
      expect(page).not.toContain(NEW_LINE);
      expect(page).not.toContain(second);
      expect(run.learningRows[0].data).toMatchObject({ baseBlob: pageBodyBlob(asLeft) });
      expect(run.learningRows[1].data).toMatchObject({ baseBlob: run.learningRows[0].data.resultBlob, resultBlob: pageBodyBlob(page) });
    }
    // Edited by hand since (a line of Tom's in Current state): nothing goes.
    {
      const dir = learningCheckout();
      const edited = asLeft.replace("- Climbing for 16 years", "- Bouldering only this month.\n- Climbing for 16 years");
      writePage(dir, file, edited);
      const run = learningRun(dir);
      const convex = fakeConvex(learningInput({ tomTurns: [], rulings: [], objections: objections.slice(0, 1), changes: rows }));
      const summary = await learningStep(run, { fetch: convex.fetch, model: vi.fn() });
      expect(summary).toMatchObject({ reverted: 0, revertFailed: 1 });
      expect(fs.readFileSync(path.join(dir, file), "utf8")).toBe(edited);
      expect(run.learningRows[0]).toMatchObject({
        kind: "learning-revert-failed",
        data: {
          id: "aaaaaaaaaaaa",
          reason: `${file} has changed since the job last wrote it (body blob ${pageBodyBlob(asLeft).slice(0, 12)}, now ${pageBodyBlob(edited).slice(0, 12)}); nothing was taken back`,
        },
      });
    }
    // The frontmatter is not the body: reviewed: set by the weekly job changes nothing.
    {
      const dir = learningCheckout();
      writePage(dir, file, asLeft.replace("reviewed:", "reviewed: 2026-09-05"));
      const run = learningRun(dir);
      const convex = fakeConvex(learningInput({ tomTurns: [], rulings: [], objections: objections.slice(0, 1), changes: rows }));
      expect(await learningStep(run, { fetch: convex.fetch, model: vi.fn() })).toMatchObject({ reverted: 1, revertFailed: 0 });
    }
  });

  it("refuses a section nested under one of Tom's, on the way in and on the way back", async () => {
    const dir = learningCheckout();
    const file = "model-of-tom/areas/climbing.md";
    const nested = "- Lead 5.12 by December.";
    write(dir, file, CLIMBING.replace("## Must not break", `### Training goals\n\n${nested}\n\n## Must not break`));
    write(
      dir,
      "model-of-tom/evidence/areas/climbing.md",
      CLIMBING_EVIDENCE.replace(
        "## Must not break",
        [
          "### Training goals",
          "",
          "- line: Lead 5.12 by December.",
          '  said: 2026-08-30 · session 47f04bc9 · "i want to lead 5.12 by december"',
          "",
          "## Must not break",
        ].join("\n"),
      ),
    );
    const before = fs.readFileSync(path.join(dir, file), "utf8");
    const run = learningRun(dir);
    const convex = fakeConvex(
      learningInput({
        objections: [{ eventId: "ev6", at: 1, id: "dddddddddddd", text: "no" }],
        changes: [{ id: "dddddddddddd", file, section: "Training goals", before: "", beforeEntry: "", after: nested }],
      }),
    );
    const summary = await learningStep(run, {
      fetch: convex.fetch,
      model: answering([factChange({ section: "Training goals" })]),
    });
    const reason = '"Training goals" is under "Ideal state", Tom\'s section; an agent never writes it';
    expect(summary).toMatchObject({ changes: 0, reverted: 0, revertFailed: 1 });
    expect(summary.refused.map((r) => r.reason)).toEqual([reason]);
    expect(run.learningRows[0]).toMatchObject({ kind: "learning-revert-failed", data: { reason } });
    expect(fs.readFileSync(path.join(dir, file), "utf8")).toBe(before);
    // The same walk, on the pure half.
    expect(locateSection(before.split("\n"), file, "Training goals")).toEqual({ reason });
    expect(locateSection(before.split("\n"), file, "Current state").span).toMatchObject({ level: 2 });
  });

  // witness: the guard read `#` in column one only, so an indented
  // `   ## Ideal state` or a setext `Ideal state\n-----` was body text to it:
  // Current state ran on through Tom's section, and a `### Training goals`
  // under it sat under nothing.
  it("guards a section under an indented or a setext heading of Tom's as under a column-one one", () => {
    const nested = "### Training goals\n\n- Lead 5.12 by December.\n\n## Must not break";
    const reason = '"Training goals" is under "Ideal state", Tom\'s section; an agent never writes it';
    const own = '"Ideal state" is Tom\'s section; an agent never writes it';
    for (const heading of ["   ## Ideal state", "Ideal state\n-----------"]) {
      const lines = CLIMBING.replace("## Ideal state", heading).replace("## Must not break", nested).split("\n");
      expect(locateSection(lines, "f", "Training goals")).toEqual({ reason });
      expect(locateSection(lines, "f", "Ideal state")).toEqual({ reason: own });
      // Current state ends where Tom's section begins, whichever form it takes.
      expect(locateSection(lines, "f", "Current state").span.end).toBe(lines.indexOf(heading.split("\n")[0]));
    }
  });
});

// witness: the snapshot serialized every row verbatim, so a key pasted into a
// session turn or a setting would have landed in WikiTom as itself.
describe("redactRow", () => {
  // Assembled at runtime from pieces, so no committed line spells a token.
  const token = ["gh", "p_", "A".repeat(36)].join("");
  const slack = ["xox", "b-1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx"].join("");

  it("filters every string value at every depth and leaves the rest as it was", () => {
    const row = {
      _id: "k1",
      text: `use ${token} for the push`,
      settings: { keys: [slack, 7, null], note: "plain" },
      n: 3,
      flag: true,
    };
    expect(redactRow(row)).toEqual({
      _id: "k1",
      text: "use [redacted:github] for the push",
      settings: { keys: ["[redacted:slack]", 7, null], note: "plain" },
      n: 3,
      flag: true,
    });
    expect(row.text).toContain(token); // pure
  });

  // A regex over this module's own source used to stand here, which said only
  // that a line of code had not been edited. What the vault's guarantee needs
  // is that a row carrying a token comes out of the export redacted, whatever
  // the read is spelled like — so the export runs, over pages a fake server
  // hands it, and the bytes the snapshot would write are the assertion.
  it("exports every row of a table redacted, across every page of it", async () => {
    const pages = [
      { rows: [{ _id: "a", text: `push with ${token}` }], isDone: false, continueCursor: "c1" },
      { rows: [{ _id: "b", settings: { keys: [slack] } }], isDone: true, continueCursor: "c2" },
    ];
    const asked = [];
    const rows = await exportTableRows({
      env: {},
      table: "claudeInbound",
      boundary: 1757000000000,
      fetch: async (_env, route) => {
        asked.push(route);
        return pages[asked.length - 1];
      },
    });
    expect(asked[0]).toContain("table=claudeInbound&boundary=1757000000000");
    expect(asked[1]).toContain("cursor=c1"); // the second page, not the first again
    expect(rows).toEqual([
      { _id: "a", text: "push with [redacted:github]" },
      { _id: "b", settings: { keys: ["[redacted:slack]"] } },
    ]);
    const bytes = planTableFiles("claudeInbound", rows)[0].bytes.toString();
    expect(bytes).not.toContain(token);
    expect(bytes).not.toContain(slack);
    expect(bytes).toContain('"text": "push with [redacted:github]"');
  });

  it("stops rather than spins when the server does not advance its cursor", async () => {
    await expect(
      exportTableRows({
        env: {},
        table: "dtsTodos",
        boundary: 1,
        fetch: async () => ({ rows: [{ _id: "a" }], isDone: false, continueCursor: null }),
      }),
    ).rejects.toThrow(/did not advance its cursor for dtsTodos/);
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

  // witness: an area page with one of its two sections gone, or gone
  // altogether, was left out of the post without a word — and the prompts
  // lost it until a night that read it again.
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

// ── The repo-learning step ───────────────────────────────────────────────────
// It reads the transcripts the sessions step archived and proposes lines for
// the nested AGENTS.md of the repositories the night worked in. It NEVER edits
// a rule file: what lands is the evidence entry, under a heading that says the
// line is not in the repository yet, and one row the digest prints.

const SDK_REPO_SESSION = "8da7169a-2222-3333-4444-555555555555";

/** A gzipped transcript with one command, one failure and one assistant text. */
function transcriptBytes() {
  const lines = [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm next dev" } }] },
    }),
    JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", is_error: true, content: "NEXT_PUBLIC_CONVEX_URL is missing" }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Copying .env.local from the main checkout fixed it." }] },
    }),
  ];
  return zlib.gzipSync(Buffer.from(`${lines.join("\n")}\n`));
}

function repoSession(over = {}) {
  return {
    id: "k97repo1",
    sdkSessionId: SDK_REPO_SESSION,
    title: "worktree dev server",
    repos: ["tom.quest"],
    repo: "tom.quest",
    cwd: null,
    model: "opus",
    mode: "interactive",
    outcome: "completed",
    outcomeSummary: "the worktree's dev server would not start",
    endedReason: null,
    at: Date.UTC(2026, 8, 5, 22),
    ...over,
  };
}

const PROPOSAL = {
  repo: "tom.quest",
  file: "worker/AGENTS.md",
  section: "box",
  line: "A worktree has no `.env.local`; copy it from the main checkout before `next dev`.",
  sources: ["8da7169a"],
  read: "`next dev` failed with a missing NEXT_PUBLIC_CONVEX_URL until the file was copied.",
};

const proposing = (proposals) => () => JSON.stringify({ proposals });

/** A checkout with the pages, the checker and the night's archived transcript,
 * plus a repository checkout the session's cwd points at. */
function repoLearningCheckout() {
  const dir = learningCheckout();
  write(dir, `sessions/2026/09/05/claude-${SDK_REPO_SESSION}/session.jsonl.gz`, transcriptBytes());
  const repoDir = tmp();
  write(repoDir, "AGENTS.md", "# tom.quest\n\n## Style\n\n- Simple interfaces around deep modules.\n");
  write(repoDir, "worker/AGENTS.md", "# worker\n\n## box\n\n- The box runs plain Node with no npm dependencies.\n");
  return { dir, repoDir };
}

describe("the repo-learning step", () => {
  it("writes the evidence entry, queues the row and the commit, and edits no rule file", async () => {
    const { dir, repoDir } = repoLearningCheckout();
    const run = learningRun(dir);
    const convex = fakeConvex(learningInput({ repoSessions: [repoSession({ cwd: repoDir })] }));
    const calls = [];
    const summary = await repoLearningStep(run, {
      fetch: convex.fetch,
      model: (prompt) => {
        calls.push(prompt);
        return JSON.stringify({ proposals: [PROPOSAL] });
      },
    });
    expect(summary).toMatchObject({ sessions: 1, transcriptsRead: 1, proposals: 1, dropped: 0, model: "opus" });

    // The entry, under the heading that says the line is not there yet.
    const entries = fs.readFileSync(path.join(dir, "model-of-tom/evidence/repos/tom.quest.md"), "utf8");
    expect(entries).toContain("## worker/AGENTS.md#box — proposed");
    expect(entries).toContain(`- line: ${PROPOSAL.line}`);
    expect(entries).toContain("read: 2026-09-06 · session 8da7169a ·");
    expect(runEvidenceCheck(dir).ok).toBe(true);
    // The repository's own file is untouched: it merges through its own checks.
    expect(fs.readFileSync(path.join(repoDir, "worker/AGENTS.md"), "utf8")).not.toContain("worktree");

    const id = proposalId(PROPOSAL.repo, PROPOSAL.file, PROPOSAL.section, PROPOSAL.line);
    expect(run.learningRows).toHaveLength(1);
    expect(run.learningRows[0]).toMatchObject({
      kind: "repo-proposal",
      key: id,
      data: {
        id,
        repo: "tom.quest",
        file: "worker/AGENTS.md",
        section: "box",
        line: PROPOSAL.line,
        evidence: "read: session 8da7169a",
        evidenceHeading: "worker/AGENTS.md#box — proposed",
        status: "open",
        commit: null,
      },
      commitMessage: "repo rules: 2026-09-06 — 1 proposal from the night's sessions",
    });
    expect(run.commits).toEqual([
      { paths: ["model-of-tom"], message: "repo rules: 2026-09-06 — 1 proposal from the night's sessions" },
    ]);

    // The prompt carries the transcript's own lines and the rule files.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("ran: pnpm next dev");
    expect(calls[0]).toContain("failed: NEXT_PUBLIC_CONVEX_URL is missing");
    expect(calls[0]).toContain("=== tom.quest worker/AGENTS.md ===");
    expect(convex.posts.map((p) => p.body.kind)).toEqual(["repo-learning-run"]);
  });

  it("drops a proposal that restates a line already in the repository's own file", async () => {
    const { dir, repoDir } = repoLearningCheckout();
    const run = learningRun(dir);
    const convex = fakeConvex(learningInput({ repoSessions: [repoSession({ cwd: repoDir })] }));
    const summary = await repoLearningStep(run, {
      fetch: convex.fetch,
      model: proposing([
        { ...PROPOSAL, line: "The box runs plain Node with no npm dependencies!" },
        PROPOSAL,
      ]),
    });
    expect(summary).toMatchObject({ proposals: 1, dropped: 1, deduped: 1 });
    expect(summary.notes).toContain("1 proposal dropped as duplicates of lines already in the files");
  });

  it("says when a repository's own rules could not be read at all", async () => {
    const { dir } = repoLearningCheckout();
    const run = learningRun(dir);
    const convex = fakeConvex(learningInput({ repoSessions: [repoSession({ cwd: null })] }));
    const summary = await repoLearningStep(run, { fetch: convex.fetch, model: proposing([PROPOSAL]) });
    expect(summary.notes).toContain(
      "tom.quest AGENTS.md could not be read on the box; the proposals above were checked against the evidence record only",
    );
    expect(summary.proposals).toBe(1);
  });

  it("makes no model call on a night whose sessions ended in no repository", async () => {
    const { dir } = repoLearningCheckout();
    const run = learningRun(dir);
    const convex = fakeConvex(learningInput({ repoSessions: [] }));
    const model = vi.fn();
    const summary = await repoLearningStep(run, { fetch: convex.fetch, model });
    expect(model).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ sessions: 0, proposals: 0 });
    expect(run.commits).toEqual([]);
  });

  it("moves an entry to its live heading once the line is in the repository, and drops one Tom objected to", async () => {
    const { dir, repoDir } = repoLearningCheckout();
    // A night that proposed two lines.
    const first = learningRun(dir);
    await repoLearningStep(first, {
      fetch: fakeConvex(learningInput({ repoSessions: [repoSession({ cwd: repoDir })] })).fetch,
      model: proposing([PROPOSAL, { ...PROPOSAL, line: "Always run the whole suite.", section: "box" }]),
    });
    const rel = "model-of-tom/evidence/repos/tom.quest.md";
    expect(fs.readFileSync(path.join(dir, rel), "utf8")).toContain("## worker/AGENTS.md#box — proposed");

    // The night after: one landed, one was objected to.
    const second = learningRun(dir);
    const convex = fakeConvex(
      learningInput({
        repoSessions: [],
        repoProposalsApplied: [
          {
            id: "x",
            repo: "tom.quest",
            file: "worker/AGENTS.md",
            section: "box",
            line: PROPOSAL.line,
            appliedLine: "A worktree has no `.env.local`: copy it from the main checkout first.",
            commit: "7e2fb79",
          },
        ],
        repoProposalsDropped: [
          {
            id: "y",
            repo: "tom.quest",
            file: "worker/AGENTS.md",
            section: "box",
            line: "Always run the whole suite.",
            reply: "no — it takes nine minutes",
          },
        ],
      }),
    );
    const summary = await repoLearningStep(second, { fetch: convex.fetch, model: vi.fn() });
    expect(summary.reconciled).toBe(1);
    const after = fs.readFileSync(path.join(dir, rel), "utf8");
    // The applied one is under the live heading, in the wording that merged.
    expect(after).toContain("## worker/AGENTS.md#box\n");
    expect(after).toContain("- line: A worktree has no `.env.local`: copy it from the main checkout first.");
    // The objected one keeps its heading and says why it is not a rule.
    expect(after).toContain("- line: Always run the whole suite.");
    expect(after).toContain("  dropped: 2026-09-06 · Tom's objection · no — it takes nine minutes");
    expect(runEvidenceCheck(dir).ok).toBe(true);
  });

  it("takes back the night's proposals when the check fails after them", async () => {
    const { dir, repoDir } = repoLearningCheckout();
    write(
      dir,
      "scripts/check-evidence.mjs",
      [
        'import { existsSync, readFileSync } from "node:fs";',
        'const p = "model-of-tom/evidence/repos/tom.quest.md";',
        'if (existsSync(p) && readFileSync(p, "utf8").includes("worktree")) { console.error("the records disagree"); process.exit(1); }',
        'console.log("ok");',
      ].join("\n"),
    );
    const run = learningRun(dir);
    const convex = fakeConvex(learningInput({ repoSessions: [repoSession({ cwd: repoDir })] }));
    const summary = await repoLearningStep(run, { fetch: convex.fetch, model: proposing([PROPOSAL]) });
    expect(summary.proposals).toBe(0);
    expect(summary.notes.some((n) => n.includes("taken back"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "model-of-tom/evidence/repos/tom.quest.md"))).toBe(false);
    expect(run.learningRows).toEqual([]);
    expect(run.commits).toEqual([]);
  });

  it("drops a proposal Tom named in a reply instead of reverting a page", async () => {
    const { dir } = repoLearningCheckout();
    const run = learningRun(dir);
    const convex = fakeConvex(
      learningInput({
        tomTurns: [],
        rulings: [],
        objections: [{ eventId: "ev1", at: 1, id: null, text: "no, [b71cb71cb71c] is wrong" }],
        changes: [],
        repoProposals: [
          {
            id: "b71cb71cb71c",
            repo: "tom.quest",
            file: "worker/AGENTS.md",
            section: "box",
            line: PROPOSAL.line,
            status: "open",
          },
        ],
      }),
    );
    const summary = await learningStep(run, { fetch: convex.fetch, model: vi.fn() });
    // No page was touched and no revert row was written: a proposal was never
    // on a page to take a line off.
    expect(summary).toMatchObject({ reverted: 0, revertFailed: 0, changes: 0 });
    expect(run.learningRows).toEqual([]);
    const dropped = convex.posts.find((p) => p.route === "/tts/repo-proposal-dropped");
    expect(dropped.body).toEqual({ id: "b71cb71cb71c", reply: "no, [b71cb71cb71c] is wrong" });
    expect(convex.posts.map((p) => p.route)).toEqual([
      "/tts/repo-proposal-dropped",
      "/tts/learning-objections-consumed",
      "/tts/event",
    ]);
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
    return execFileSync("git", ["-c", `safe.directory=${fs.realpathSync.native(dir)}`, "-C", dir, ...IDENTITY, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  /** A repository with one commit holding a snapshot file, a manifest, and
   * the WikiTom-shaped pages the learning step writes (with the checker, so
   * the step's own gate passes). */
  function repo() {
    const dir = learningCheckout();
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

  it("records on each learning row the commit that holds its line, not HEAD", async () => {
    const dir = repo();
    const r = { ...learningRun(dir), now: Date.now() };
    const convex = fakeConvex(learningInput());
    await learningStep(r, { fetch: convex.fetch, model: answering([factChange()]) });
    commitTree(dir, r.commits, r.day);
    const learningCommit = run(dir, "rev-parse", "HEAD").trim();
    expect(subjects(dir)[0]).toBe("learning: 2026-09-06 — 1 line from Tom's turns, replies and rulings");
    // The sessions step's commit lands after it, so HEAD is not the learning
    // commit by the time the rows are posted.
    write(dir, "sessions/manifest-box-2026-09-06.jsonl", "{}\n");
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", "sessions");
    expect(run(dir, "rev-parse", "HEAD").trim()).not.toBe(learningCommit);

    await recordLearningRows(r, { fetch: convex.fetch });
    const rows = convex.posts.filter((p) => p.body.kind === "learning-change");
    expect(rows).toHaveLength(1);
    expect(rows[0].body.data.modelOfTomCommit).toBe(learningCommit);
    expect(rows[0].body.data.commit).toBeUndefined();
    expect(rows[0].body.data.day).toBe("2026-09-06");
  });

  it("names the one commit a folded revert-and-learn night made, and none for a revert that could not apply", async () => {
    const dir = repo();
    const file = "model-of-tom/areas/climbing.md";
    const old = "- Ankle: minor chronic pain from jumping down off the wall.";
    const earlier = "- Rest days are Mondays.";
    writePage(dir, file, CLIMBING.replace(old, `${old}\n${earlier}`));
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", "pages");
    const r = { ...learningRun(dir), now: Date.now() };
    const convex = fakeConvex(
      learningInput({
        objections: [
          { eventId: "ev7", at: 1, id: "eeeeeeeeeeee", text: "no" },
          { eventId: "ev8", at: 2, id: "ffffffffffff", text: "no" },
        ],
        changes: [
          { id: "eeeeeeeeeeee", file, section: "Current state", before: "", beforeEntry: "", after: earlier },
          { id: "ffffffffffff", file, section: "Current state", before: "", beforeEntry: "", after: "- gone already." },
        ],
      }),
    );
    await learningStep(r, { fetch: convex.fetch, model: answering([factChange()]) });
    expect(r.commits.map((c) => c.message)).toEqual([
      "learning: 2026-09-06 — 1 line reverted on Tom's objection",
      "learning: 2026-09-06 — 1 line from Tom's turns, replies and rulings",
    ]);
    // Both entries name model-of-tom/, so the push step's first commit takes
    // both writes and the second finds nothing staged: one commit.
    const made = commitTree(dir, r.commits, r.day);
    expect(made.made).toEqual(["learning: 2026-09-06 — 1 line reverted on Tom's objection"]);
    const theCommit = run(dir, "rev-parse", "HEAD").trim();
    write(dir, "sessions/manifest-box-2026-09-06.jsonl", "{}\n");
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", "sessions");

    await recordLearningRows(r, { fetch: convex.fetch });
    const byKind = Object.fromEntries(
      convex.posts.filter((p) => p.route === "/tts/event" && p.body.kind !== "learning-run").map((p) => [p.body.kind, p.body.data]),
    );
    expect(byKind["learning-reverted"].modelOfTomCommit).toBe(theCommit);
    expect(byKind["learning-change"].modelOfTomCommit).toBe(theCommit);
    expect(byKind["learning-revert-failed"].modelOfTomCommit).toBeNull();
    // An older commit is never the answer: with nothing of this run's under
    // model-of-tom/, the row says null.
    expect(modelOfTomCommit(dir, "no such message", Date.now() + 3_600_000)).toBeNull();
  });

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

  // witness: LOCKED_STEPS names the four steps that write, so `--only=post`
  // ran nothing that aborts a stale rebase. The post then read `rev-parse
  // HEAD` — a half-replayed commit, not the checkout's — and Convex, which
  // refuses only a post OLDER than the one it holds, took it and served those
  // pages to every prompt until a clean night replaced them.
  it("refuses to post while a rebase is in progress, and does not abort it", async () => {
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

    const r = learningRun(dir);
    const outs = skillsDirs(1);
    const convex = fakeConvex();
    const result = await postStep(r, { fetch: convex.fetch, checkouts: [] });
    // Neither half: it is the same HEAD, and a skill body read off a
    // half-replayed commit is the same bad post one table over.
    expect(result).toMatchObject({ commit: null, pushed: false, files: null, skills: null });
    expect(fs.readdirSync(outs[0])).toEqual([]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].step).toBe("post");
    expect(r.failures[0].error).toContain("a rebase is in progress");
    // The only thing that went to Convex is the failure row: nothing was
    // posted to /tts/model-of-tom.
    expect(convex.posts.map((p) => p.route)).toEqual(["/tts/event"]);
    // And the rebase is where it was — a post is a read, and `rebase --abort`
    // resets the work tree hard.
    expect(rebaseInProgress(dir)).toBe(true);

    // Off that state the same call gets as far as reading the pages, so the
    // guard is what stopped it and not the state of the checkout's files.
    abortStaleRebase(dir);
    const after = learningRun(dir);
    await postStep(after, { fetch: fakeConvex().fetch, checkouts: [] });
    // The repository now carries agent-rules.md (learningCheckout writes it),
    // so the first required file the assembler misses is an area page.
    expect(after.failures[0].error).toContain("is absent");
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

  // witness: the post read the work tree while naming HEAD, outside the
  // lock — a page changed under it went out under a commit that never held
  // those bytes; and it reported local HEAD as if it were on GitHub.
  const AREA_BODY = "---\nupdated: 2026-09-09\n---\n\n# Area\n\n## Current state\n\n- Present.\n";
  /** A checkout whose model-of-tom pages are COMMITTED: what the post reads,
   * and what the skills half builds its catalog out of. */
  function preludeRepo() {
    const dir = repo();
    write(dir, "model-of-tom/agent-rules.md", "# Rules\n\nOperate safely.\n");
    write(dir, "model-of-tom/writing.md", "# Writing\n\nBe plain.\n");
    write(dir, "model-of-tom/ground.md", "# Ground\n\nStart here.\n");
    write(dir, "model-of-tom/intent.md", "# Intent\n\nKeep moving.\n");
    write(dir, "model-of-tom/priorities.md", "# Priorities\n\nResearch.\n");
    write(dir, "model-of-tom/schedule.md", "# Schedule\n\nTuesday.\n");
    for (const area of REQUIRED_AREA_PATHS) write(dir, area, AREA_BODY);
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", "prelude");
    return dir;
  }
  /** Somewhere other than /root for the skills half to write. */
  function skillsDirs(count = 3) {
    const dirs = Array.from({ length: count }, () => tmp());
    vi.stubEnv("TTS_SKILLS_DIRS", dirs.join(path.delimiter));
    return dirs;
  }
  /** A fetch that keeps every post, and throws for the routes named. */
  function recording(posts, refuse = {}) {
    return async (_env, route, body) => {
      posts.push({ route, body });
      if (refuse[route] !== undefined) throw new Error(refuse[route]);
      return { files: body.files?.length ?? 0 };
    };
  }

  it("posts the shared immutable prelude, including every canonical selection header", async () => {
    const dir = preludeRepo();
    const areaBodies = Object.fromEntries(REQUIRED_AREA_PATHS.map((area) => [area, AREA_BODY]));
    const outs = skillsDirs(1);
    const commit = run(dir, "rev-parse", "HEAD").trim();
    const committedAt = Number(run(dir, "log", "-1", "--format=%ct", "HEAD").trim()) * 1000;
    // These work-tree changes must not influence the commit-named post.
    write(dir, "model-of-tom/writing.md", "# Writing\n\nUncommitted.\n");

    const posts = [];
    const result = await postStep(learningRun(dir), { fetch: recording(posts), checkouts: [] });

    const layers = {
      operate: "── model-of-tom/agent-rules.md ──\n# Rules\n\nOperate safely.\n",
      write: "── model-of-tom/writing.md ──\n# Writing\n\nBe plain.\n\n\n── model-of-tom/ground.md ──\n# Ground\n\nStart here.\n",
      know: "",
    };
    const paths = {
      operate: ["model-of-tom/agent-rules.md"],
      write: ["model-of-tom/writing.md", "model-of-tom/ground.md"],
      know: ["model-of-tom/intent.md", "model-of-tom/priorities.md", "model-of-tom/schedule.md", ...REQUIRED_AREA_PATHS],
    };
    const header = (selection) => `MODEL-OF-TOM FILES (WikiTom commit ${commit}): ${selection.flatMap((name) => paths[name]).join(", ")}`;
    const selections = [
      ["operate"], ["write"], ["operate", "write"], ["know"],
      ["operate", "know"], ["write", "know"], ["operate", "write", "know"],
    ];
    const bodies = {
      "model-of-tom/agent-rules.md": "# Rules\n\nOperate safely.\n",
      "model-of-tom/writing.md": "# Writing\n\nBe plain.\n",
      "model-of-tom/ground.md": "# Ground\n\nStart here.\n",
      "model-of-tom/intent.md": "# Intent\n\nKeep moving.\n",
      "model-of-tom/priorities.md": "# Priorities\n\nResearch.\n",
      "model-of-tom/schedule.md": "# Schedule\n\nTuesday.\n",
    };
    Object.assign(bodies, areaBodies);
    const render = (file) => `── ${file} ──\n${file.startsWith("model-of-tom/areas/") ? parseFrontmatter(bodies[file]).body.trim() : bodies[file]}`;
    layers.know = paths.know.map(render).join("\n\n");
    const files = Object.values(paths).flatMap((filePaths) => filePaths.map((filePath) => ({
      path: filePath,
      body: bodies[filePath],
      bytes: Buffer.byteLength(bodies[filePath]),
    })));
    // The base first, the skills second — and the base's body is unchanged by
    // the half that follows it.
    expect(posts.map((post) => post.route)).toEqual(["/tts/model-of-tom", "/tts/skills"]);
    expect(posts[0]).toEqual({
      route: "/tts/model-of-tom",
      body: {
        commit,
        committedAt,
        pushed: false,
        layers,
        files,
        headers: selections.map((selection) => ({ layers: selection, header: header(selection) })),
      },
    });
    expect(result).toMatchObject({ commit, pushed: false, files: files.map((file) => file.path) });
    expect(result.skills.commit).toBe(commit);
    expect(result.skills.dirs).toEqual(outs);
  });

  // ── the skills half ──────────────────────────────────────────────────────
  // witness: one widened door. A night whose skill bodies would not build took
  // the model-of-tom post down with them, and every prompt the next day began
  // with nothing about Tom at all.
  it("names the two Claude accounts' skill directories and Codex's, and lets a test move them", () => {
    // The two accounts are separated by CLAUDE_CONFIG_DIR; the third is
    // $CODEX_HOME/skills, and CODEX_HOME on the box is /root/.codex.
    expect([...BOX_SKILLS_DIRS]).toEqual([
      "/root/.claude-accounts/gmail/skills",
      "/root/.claude-accounts/wpi/skills",
      "/root/.codex/skills",
    ]);
    expect(boxSkillsDirs()).toEqual([...BOX_SKILLS_DIRS]);
    vi.stubEnv("TTS_SKILLS_DIRS", ["/tmp/one", "/tmp/two"].join(path.delimiter));
    expect(boxSkillsDirs()).toEqual(["/tmp/one", "/tmp/two"]);
  });

  it("writes every skills directory and then posts the catalog", async () => {
    const dir = preludeRepo();
    const outs = skillsDirs();
    const posts = [];
    const result = await postStep(learningRun(dir), { fetch: recording(posts), checkouts: [] });

    expect(posts.map((post) => post.route)).toEqual(["/tts/model-of-tom", "/tts/skills"]);
    const catalog = posts[1].body;
    expect(catalog.commit).toBe(result.commit);
    expect(catalog.pushed).toBe(false);
    expect(typeof catalog.syncedAt).toBe("number");
    expect(catalog.refused).toEqual([]);
    const names = catalog.skills.map((skill) => skill.name);
    expect(names).toEqual(expect.arrayContaining(["write", "know-intent", "know-week"]));
    // No repository was handed to this run, so the catalog has no repo skill —
    // which is what keeps a box with no clones from publishing an empty one.
    expect(names.filter((name) => name.startsWith("repo-"))).toEqual([]);

    // The catalog carries the bodies, not a report about them.
    const writeSkill = catalog.skills.find((skill) => skill.name === "write");
    expect(writeSkill.group).toBe("write");
    expect(writeSkill.sourcePaths).toEqual(["model-of-tom/writing.md"]);
    expect(writeSkill.body).toContain("Be plain.");
    expect(writeSkill.bytes).toBe(Buffer.byteLength(writeSkill.body));
    expect(writeSkill.description.length).toBeGreaterThan(0);
    expect(writeSkill.references).toHaveLength(1);
    expect(writeSkill.references[0]).toMatchObject({ name: "ground.md", path: "model-of-tom/ground.md" });
    expect(writeSkill.references[0].body).toContain("Start here.");

    // All three directories hold the same set, in the layout a CLI loads.
    for (const out of outs) {
      expect(fs.readdirSync(out).sort()).toEqual(names.map((name) => `tom-${name}`).sort());
      expect(fs.readFileSync(path.join(out, "tom-write", "SKILL.md"), "utf8")).toContain("name: tom-write");
      expect(fs.existsSync(path.join(out, "tom-write", "ground.md"))).toBe(true);
    }
    expect(result.skills).toEqual({ commit: result.commit, count: names.length, dirs: outs, refused: [] });
  });

  it("records a skills-publication failure of its own, and the base still went out", async () => {
    const dir = preludeRepo();
    const outs = skillsDirs(1);
    const r = learningRun(dir);
    const posts = [];
    const result = await postStep(r, {
      fetch: recording(posts),
      checkouts: [],
      publishSkills: () => {
        throw new Error("the skill generator fell over");
      },
    });

    // The base went out; the catalog did not; the failure row says which half.
    expect(posts.map((post) => post.route)).toEqual(["/tts/model-of-tom", "/tts/event"]);
    expect(posts[1].body.kind).toBe("nightly-failure");
    expect(posts[1].body.data.step).toBe("skills");
    expect(r.failures).toEqual([{ step: "skills", error: "the skill generator fell over" }]);
    expect(result.commit).toBe(run(dir, "rev-parse", "HEAD").trim());
    expect(result.files).toContain("model-of-tom/agent-rules.md");
    expect(result.skills).toBeNull();
    expect(fs.readdirSync(outs[0])).toEqual([]);
  });

  it("records a refused base post and still publishes the skills, saying the store has no commit", async () => {
    const dir = preludeRepo();
    const outs = skillsDirs(1);
    const r = learningRun(dir);
    const posts = [];
    const result = await postStep(r, {
      fetch: recording(posts, { "/tts/model-of-tom": "Convex refused the base (503)" }),
      checkouts: [],
    });

    expect(posts.map((post) => post.route)).toEqual(["/tts/model-of-tom", "/tts/event", "/tts/skills"]);
    expect(r.failures.map((failure) => failure.step)).toEqual(["post"]);
    // Convex does not hold this commit, so the summary must not say it does.
    expect(result.commit).toBeNull();
    expect(result.files).toBeNull();
    expect(result.skills.count).toBeGreaterThan(0);
    expect(fs.readdirSync(outs[0]).length).toBeGreaterThan(0);
  });

  it("records a refused /tts/skills post without throwing, and leaves the directories written", async () => {
    const dir = preludeRepo();
    const outs = skillsDirs(1);
    const r = learningRun(dir);
    const posts = [];
    const result = await postStep(r, {
      fetch: recording(posts, { "/tts/skills": "Convex refused the catalog (503)" }),
      checkouts: [],
    });

    expect(posts.map((post) => post.route)).toEqual(["/tts/model-of-tom", "/tts/skills", "/tts/event"]);
    expect(r.failures.map((failure) => failure.step)).toEqual(["skills"]);
    expect(r.failures[0].error).toContain("503");
    expect(result.commit).not.toBeNull();
    expect(result.skills).toBeNull();
    // The bodies are on the disk and tonight's agents will load them; what is
    // stale is the catalog Convex serves, and that is what the row says.
    expect(fs.readdirSync(outs[0]).length).toBeGreaterThan(0);
  });

  it("reads a published skill back as the catalog entry, and throws when SKILL.md is not what it wrote", async () => {
    const dir = preludeRepo();
    const outs = skillsDirs(1);
    await postStep(learningRun(dir), { fetch: recording([]), checkouts: [] });
    const { publishSkills } = await import("../../scripts/publish-skills.mjs");
    const { skillDirName, referenceName } = await import("../../scripts/skills.mjs");
    const published = publishSkills({ wikitom: dir, commit: "HEAD", repos: [], out: outs[0] });
    const readers = { skillDirName, referencePath: referencePathResolver(new Map(), referenceName) };
    expect(readSkillCatalog(outs[0], published, readers).map((skill) => skill.name).sort())
      .toEqual(published.skills.map((skill) => skill.name).sort());
    // A body edited under the reader is a loud failure, not a quiet wrong post.
    const target = path.join(outs[0], skillDirName(published.skills[0].name), "SKILL.md");
    fs.writeFileSync(target, `${fs.readFileSync(target, "utf8")}tampered\n`);
    expect(() => readSkillCatalog(outs[0], published, readers)).toThrow(/did not read back/);
  });

  // witness: `convex/AGENTS.md` flattens to `convex-AGENTS.md`, and tom.quest
  // has a `turing-api/` — so unflattening a reference name on its hyphens
  // invents `turing/api/AGENTS.md`. The path is looked up, never inverted.
  it("resolves a reference's source path by lookup, and refuses to guess one", () => {
    const referenceName = (file) => file.replace(/\//g, "-");
    const resolve = referencePathResolver(
      new Map([["tom.quest", ["AGENTS.md", "turing-api/AGENTS.md", "convex/AGENTS.md"]]]),
      referenceName,
    );
    const repo = (name, origin) => ({ name, group: "repo", origin, sourcePaths: ["AGENTS.md"], file: "f" });
    expect(resolve(repo("turing-api-AGENTS.md", "tom.quest"))).toBe("turing-api/AGENTS.md");
    // And the group decides, not the origin: WikiTom is both the vault every
    // write and know skill is built from and a repository with rules of its
    // own, so ground.md must not take the repo lookup.
    expect(resolve({
      name: "ground.md",
      group: "write",
      origin: "WikiTom",
      sourcePaths: ["model-of-tom/writing.md"],
      file: "f",
    })).toBe("model-of-tom/ground.md");
    expect(() => resolve(repo("app-AGENTS.md", "tom.quest"))).toThrow(/no rules file named/);
    expect(() => resolve(repo("AGENTS.md", "WikiTom"))).toThrow(/no rules file named/);
  });

  // ── the repo rules, three checkouts ──────────────────────────────────────
  /** A one-commit repository whose root AGENTS.md is the given body. */
  function rulesRepo(body) {
    const dir = tmp();
    execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
    write(dir, "AGENTS.md", body);
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", "rules");
    return dir;
  }

  it("names the three checkouts whose AGENTS.md ride into Convex", () => {
    expect(REPO_CHECKOUTS.map((entry) => entry.repo)).toEqual(["tom.quest", "WikiTom", "ComplexMultiTrigger"]);
    expect(REPO_CHECKOUTS.map((entry) => entry.dir)).toEqual([TOM_QUEST_DIR, WIKITOM_DIR, CMT_DIR]);
  });

  it("posts every repo in the list", async () => {
    const checkouts = [
      { repo: "tom.quest", dir: rulesRepo("# tom.quest\n\nThe site.\n") },
      { repo: "WikiTom", dir: rulesRepo("# WikiTom\n\nThe vault.\n") },
      { repo: "ComplexMultiTrigger", dir: rulesRepo("# CMT\n\nThe research code.\n") },
    ];
    const r = learningRun(tmp());
    const convex = fakeConvex();
    const result = await repoRulesStep(r, { fetch: convex.fetch, checkouts });
    expect(result.repos.map((entry) => entry.repo)).toEqual(["tom.quest", "WikiTom", "ComplexMultiTrigger"]);
    expect(convex.posts.map((post) => post.route)).toEqual(["/tts/repo-rules", "/tts/repo-rules", "/tts/repo-rules"]);
    expect(convex.posts.map((post) => post.body.repo)).toEqual(["tom.quest", "WikiTom", "ComplexMultiTrigger"]);
    expect(r.failures).toEqual([]);
  });

  // witness: one loop, one throw. A box rebuilt with two of the three clones
  // present posted nothing at all, because the first missing one ended the loop.
  it("loses only the checkout that is missing, and the other two still post", async () => {
    const checkouts = [
      { repo: "tom.quest", dir: path.join(tmp(), "never-cloned") },
      { repo: "WikiTom", dir: rulesRepo("# WikiTom\n\nThe vault.\n") },
      { repo: "ComplexMultiTrigger", dir: path.join(tmp(), "also-never-cloned") },
    ];
    const r = learningRun(tmp());
    const convex = fakeConvex();
    const result = await repoRulesStep(r, { fetch: convex.fetch, checkouts });
    expect(result.repos.map((entry) => entry.repo)).toEqual(["WikiTom"]);
    expect(convex.posts.filter((post) => post.route === "/tts/repo-rules").map((post) => post.body.repo)).toEqual(["WikiTom"]);
    expect(r.failures.map((failure) => failure.step)).toEqual(["repo-rules", "repo-rules"]);
    expect(r.failures[0].error).toContain("is not a git checkout");
    expect(r.failures[1].error).toContain("also-never-cloned");
  });
});
