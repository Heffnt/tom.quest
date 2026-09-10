// The two golden items, scored here by vitest on every change to the learning
// code, and by the evals runner's `learning` partition on every change to the
// PROMPT. They are the two because they are the two things the job must get
// right: one thing it must do, and one thing it must refuse.
//
// Scoring here is deterministic — the item carries the answer, so no model is
// in the loop and what is scored is the job's own decision about that answer.
// The runner regenerates the answer with the current prompt at two shas and
// compares `applied` and `refused` the same way.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyLearningChanges,
  learningEvidence,
  parseLearningAnswer,
  runEvidenceCheck,
  sessionCitation,
  utcDay,
} from "./nightly.mjs";
import { groundSignals } from "./learning-ground.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(here, "..", "..", "evals", "golden-learning");
const CHECKER = fs.readFileSync(path.join(here, "fixtures", "check-evidence.mjs"), "utf8");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "golden-"));
}
function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** The item's `input` as the step's own input object: the turns with the
 * fields the job reads, and the window as epoch milliseconds. */
function stepInput(item) {
  const at = (date) => Date.parse(`${date}T12:00:00.000Z`);
  return {
    since: Date.parse(item.input.window.since),
    until: Date.parse(item.input.window.until),
    tomTurns: (item.input.tomTurns ?? []).map((t) => ({
      id: t.turnId,
      sessionId: t.session,
      sdkSessionId: `${t.session}-0000-0000-0000-000000000000`,
      sessionTitle: t.sessionTitle ?? "",
      text: t.tom,
      at: at(t.date),
      replyBefore: t.agentBefore ?? null,
      replyAfter: t.agentAfter ?? null,
    })),
    slackReplies: item.input.slackReplies ?? [],
    rulings: item.input.rulings ?? [],
    objections: [],
    changes: [],
  };
}

/** A WikiTom-shaped checkout holding the item's pages, so the real checker
 * runs over exactly what the item says landed. */
function checkoutFor(item) {
  const dir = tmp();
  write(dir, "scripts/check-evidence.mjs", CHECKER);
  for (const rel of ["agent-rules.md", "intent.md", "ground.md", "writing.md", "priorities.md", "schedule.md"]) {
    write(dir, `model-of-tom/${rel}`, `# ${rel}\n\n## Only\n\n`);
    write(dir, `model-of-tom/evidence/${rel}`, `# Evidence\n\n## Only\n\n`);
  }
  write(dir, "model-of-tom/areas/climbing.md", "## Current state\n\n");
  write(dir, "model-of-tom/evidence/areas/climbing.md", "# Evidence\n\n## Current state\n\n");
  for (const [rel, text] of Object.entries(item.input.pages ?? {})) write(dir, rel, text);
  for (const [rel, text] of Object.entries(item.input.evidencePages ?? {})) write(dir, rel, text);
  return dir;
}

/** The item scored: its signals, what landed, what was refused, and the real
 * checker over the tree the writer left. */
function score(item) {
  const input = stepInput(item);
  const { signals } = groundSignals(input, {
    cite: (t) => `session ${sessionCitation(t)}`,
    day: (at) => utcDay(at),
  });
  const pages = new Map(Object.entries(item.input.pages ?? {}));
  const evidencePages = new Map(Object.entries(item.input.evidencePages ?? {}));
  const result = applyLearningChanges(
    pages,
    parseLearningAnswer(JSON.stringify(item.input.answer)),
    { day: item.input.day, evidence: learningEvidence(input), evidencePages, signals },
  );
  const dir = checkoutFor(item);
  for (const [rel, text] of result.pages) write(dir, rel, text);
  for (const [rel, text] of result.evidencePages) write(dir, rel, text);
  return { signals, result, dir, pages, evidencePages };
}

const items = fs
  .readdirSync(GOLDEN)
  .filter((n) => n.endsWith(".json"))
  .sort()
  .map((n) => JSON.parse(fs.readFileSync(path.join(GOLDEN, n), "utf8")));

describe("the golden learning items", () => {
  it("registers both under the learning job, in their own partitions", () => {
    expect(items.map((i) => i.id).sort()).toEqual([
      "learning-ground-said-knows",
      "learning-refusal-no-evidence",
    ]);
    for (const item of items) {
      expect(item.job).toBe("learning");
      expect(item.partition.startsWith("learning/")).toBe(true);
      expect(item.verdict).toBe("approve");
      expect(typeof item.sentence).toBe("string");
    }
    expect(items.map((i) => i.partition).sort()).toEqual(["learning/ground", "learning/refusal"]);
  });

  for (const item of items) {
    it(`${item.id}: ${item.sentence}`, () => {
      const { signals, result, dir, pages, evidencePages } = score(item);

      // The signals the CODE found, not the ones a model claimed.
      expect(signals.map((s) => ({ id: s.id, kind: s.kind, term: s.term, source: s.source }))).toEqual(
        item.expect.signals,
      );

      // What landed, field by field.
      expect(result.applied).toHaveLength(item.expect.applied.length);
      result.applied.forEach((a, i) => expect(a).toMatchObject(item.expect.applied[i]));
      // Every id is the naming rule's shape, which is how Tom names it back.
      for (const a of result.applied) expect(a.id).toMatch(/^[0-9a-f]{12}$/);

      // What was refused, by its exact message.
      expect(result.refused.map((r) => ({ file: r.file, reason: r.reason }))).toEqual(item.expect.refused);

      // Nothing of the source on the page; everything of it in the entry.
      for (const a of result.applied) {
        expect(a.after).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
        expect(a.after).not.toMatch(/\((?:session|ruling|thread)\s/);
        expect(a.afterEntry).toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
        expect(a.afterEntry).toMatch(/(?:session|ruling|thread) /);
      }

      // The real checker over the tree the writer left.
      if (item.expect.evidenceCheck === "ok") expect(runEvidenceCheck(dir).ok).toBe(true);

      // A refusal touches neither record.
      if (item.expect.pagesUnchanged) {
        for (const [rel, text] of pages) expect(result.pages.get(rel)).toBe(text);
      }
      if (item.expect.evidenceUnchanged) {
        for (const [rel, text] of evidencePages) expect(result.evidencePages.get(rel)).toBe(text);
      }

      // The digest line, with the id substituted.
      if (item.expect.digest === null) {
        expect(result.applied).toEqual([]);
      } else {
        const [a] = result.applied;
        const line =
          a.before === ""
            ? `- [${a.id}] ${a.file}: + "${a.after.replace(/^- /, "")}" (${a.evidence})`
            : `- [${a.id}] ${a.file}: "${a.before.replace(/^- /, "")}" → "${a.after.replace(/^- /, "")}" (${a.evidence})`;
        expect(line).toBe(item.expect.digest.replace("<id>", a.id));
      }
    });
  }
});

describe("the golden tree", () => {
  it("holds only JSON items, so the runner's partition read finds nothing else", () => {
    const names = fs.readdirSync(GOLDEN);
    expect(names.every((n) => n.endsWith(".json") || n === "README.md")).toBe(true);
    // Each is valid JSON with an id that matches its filename.
    for (const n of names.filter((x) => x.endsWith(".json"))) {
      const item = JSON.parse(fs.readFileSync(path.join(GOLDEN, n), "utf8"));
      expect(`${item.id}.json`).toBe(n);
    }
    expect(execFileSync("node", ["-e", "0"], { encoding: "utf8" })).toBe("");
  });
});
