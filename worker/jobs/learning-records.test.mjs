// The two records: what each half looks like byte for byte, where the entry
// goes, and that the pair the writer leaves passes WikiTom's own checker.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE_SEP,
  applyEvidenceEntry,
  applyRecords,
  evidencePath,
  oneLine,
  parseEvidenceEntries,
  removeEvidenceEntry,
  renderEvidenceEntry,
  renderSynthesisLine,
  revertRecords,
} from "./learning-records.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures");
const CHECKER = path.join(FIXTURES, "check-evidence.mjs");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "records-"));
}

function write(dir, rel, text) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}

/** Every file under `dir` with its bytes hashed — the whole-tree comparison a
 * rollback has to survive. */
function treeHash(dir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else out.push(`${next} ${crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, next))).digest("hex")}`);
    }
  };
  walk("");
  return out.join("\n");
}

const SAID = {
  form: "said",
  date: "2026-09-08",
  source: "session 47f04bc9",
  text: "What is a full overwrite versus merge? Why should I care about this at all?",
};

const change = (over = {}) => ({
  file: "model-of-tom/ground.md",
  section: "Does not know",
  op: "add",
  line: "Git beyond add, commit, push and pull: git-lfs, overwrite versus merge.",
  replaces: null,
  inferred: false,
  evidence: [SAID],
  ...over,
});

// ── The synthesis half ───────────────────────────────────────────────────────
describe("renderSynthesisLine", () => {
  it("writes one bullet, marks an inferred line, and doubles neither", () => {
    expect(renderSynthesisLine(change())).toBe(
      "- Git beyond add, commit, push and pull: git-lfs, overwrite versus merge.",
    );
    expect(renderSynthesisLine(change({ inferred: true }))).toBe(
      "- Git beyond add, commit, push and pull: git-lfs, overwrite versus merge. (inferred)",
    );
    // A model that wrote the leading "- " itself, or the mark itself.
    expect(renderSynthesisLine(change({ line: "- Already a bullet." }))).toBe("- Already a bullet.");
    expect(renderSynthesisLine(change({ line: "Marked already. (inferred)", inferred: true }))).toBe(
      "- Marked already. (inferred)",
    );
    expect(renderSynthesisLine(change({ line: "   " }))).toBe("");
  });
});

// ── The evidence half, byte for byte ─────────────────────────────────────────
describe("renderEvidenceEntry", () => {
  it("writes the four forms exactly as check-evidence.mjs parses them", () => {
    const line = renderSynthesisLine(change());
    const entry = renderEvidenceEntry(
      change({
        evidence: [
          SAID,
          {
            form: "paraphrase",
            date: "2026-09-08",
            source: "thread 1757300000.001",
            text: "he keeps the lit review because new methods keep arriving.",
          },
          {
            form: "read",
            date: "2026-09-08",
            source: "session 47f04bc9",
            text: "the session ran `pnpm check:agents` and it failed on a missing CLAUDE.md.",
          },
          {
            form: "rests on",
            date: "2026-09-08",
            source: "session 47f04bc9",
            text: "he asked how DRA works inside, having named it himself; generalized to every published method, which he has not said.",
          },
        ],
      }),
      line,
    );
    expect(entry.split("\n")).toEqual([
      "- line: Git beyond add, commit, push and pull: git-lfs, overwrite versus merge.",
      '  said: 2026-09-08 · session 47f04bc9 · "What is a full overwrite versus merge? Why should I care about this at all?"',
      "  paraphrase: 2026-09-08 · thread 1757300000.001 · he keeps the lit review because new methods keep arriving.",
      "  read: 2026-09-08 · session 47f04bc9 · the session ran `pnpm check:agents` and it failed on a missing CLAUDE.md.",
      "  rests on: 2026-09-08 · session 47f04bc9 · he asked how DRA works inside, having named it himself; generalized to every published method, which he has not said.",
    ]);
    // said: alone is quoted.
    expect(entry).toContain('· "What is a full');
    expect(entry).not.toContain('· "he keeps');
  });

  it("takes the (inferred) mark into the entry's line:, because the checker compares them exactly", () => {
    const c = change({ inferred: true, evidence: [{ ...SAID, form: "rests on" }] });
    const line = renderSynthesisLine(c);
    expect(renderEvidenceEntry(c, line).split("\n")[0]).toBe(`- line: ${line.slice(2)}`);
    expect(renderEvidenceEntry(c, line)).toContain("(inferred)");
  });

  it("does not split an entry text that holds the separator itself", () => {
    const text = `a · b · c`;
    const entry = renderEvidenceEntry(change({ evidence: [{ ...SAID, form: "read", text }] }), "- x");
    const [parsed] = parseEvidenceEntries(entry);
    expect(parsed.fields[0]).toEqual({
      form: "read",
      date: "2026-09-08",
      source: "session 47f04bc9",
      text,
    });
    expect(text.split(EVIDENCE_SEP)).toHaveLength(3);
  });
});

// ── Reading the file back ────────────────────────────────────────────────────
describe("parseEvidenceEntries", () => {
  it("round-trips every entry in the real evidence/ground.md with no loss", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "evidence-ground.md"), "utf8");
    const lines = text.split("\n");
    const entries = parseEvidenceEntries(text);
    expect(entries.length).toBeGreaterThan(20);
    for (const e of entries) {
      // Every entry's recorded span is exactly its own lines.
      expect(lines.slice(e.start, e.end)).toEqual(e.raw);
      expect(e.heading).not.toBeNull();
      expect(e.fields.length).toBeGreaterThan(0);
      for (const f of e.fields) {
        expect(["said", "paraphrase", "read", "rests on", "dropped"]).toContain(f.form);
        expect(f.date).not.toBe("");
        expect(f.source).not.toBe("");
      }
    }
    // Spans never overlap, and the file rebuilt from them is the file.
    const rebuilt = lines.slice();
    for (const e of entries) rebuilt.splice(e.start, e.end - e.start, ...e.raw);
    expect(rebuilt.join("\n")).toBe(text);
  });

  it("keeps entries apart by their heading", () => {
    const text = [
      "# Evidence",
      "",
      "## Knows",
      "",
      "- line: a thing.",
      "  said: 2026-09-08 · session 47f04bc9 · \"a thing\"",
      "",
      "## Does not know",
      "",
      "- line: a thing.",
      "  said: 2026-09-08 · session 47f04bc9 · \"a thing\"",
      "",
    ].join("\n");
    expect(parseEvidenceEntries(text).map((e) => e.heading)).toEqual(["Knows", "Does not know"]);
  });
});

// ── Placing the entry ────────────────────────────────────────────────────────
describe("applyEvidenceEntry", () => {
  const base = [
    "# Evidence for ground.md",
    "",
    "## Knows",
    "",
    "- line: The thesis and claims of his own paper.",
    '  said: 2026-07-23 · session 81be510a · "i know what the thesis is"',
    "",
  ].join("\n");

  it("appends under an existing heading, entries adjacent", () => {
    const entry = "- line: A new one.\n  said: 2026-09-08 · session 47f04bc9 · \"a new one\"";
    const out = applyEvidenceEntry(base, "Knows", 2, entry);
    expect(out.ok).toBe(true);
    expect(out.text.split("\n")).toEqual([
      "# Evidence for ground.md",
      "",
      "## Knows",
      "",
      "- line: The thesis and claims of his own paper.",
      '  said: 2026-07-23 · session 81be510a · "i know what the thesis is"',
      "- line: A new one.",
      '  said: 2026-09-08 · session 47f04bc9 · "a new one"',
      "",
    ]);
  });

  it("creates a missing heading at the synthesis page's level", () => {
    const out = applyEvidenceEntry(base, "Does not know", 2, "- line: x.\n  said: a · b · \"x\"");
    expect(out.ok).toBe(true);
    expect(out.text.endsWith('\n## Does not know\n\n- line: x.\n  said: a · b · "x"\n')).toBe(true);
    const deeper = applyEvidenceEntry(base, "Training goals", 3, "- line: x.");
    expect(deeper.text).toContain("\n### Training goals\n");
  });

  it("replaces exactly one entry, and refuses on two the same", () => {
    const entry = "- line: The thesis and claims of his own paper.\n  said: 2026-09-08 · session 47f04bc9 · \"newer\"";
    const one = applyEvidenceEntry(base, "Knows", 2, entry, {
      replaces: "The thesis and claims of his own paper.",
    });
    expect(one.ok).toBe(true);
    expect(one.text).toContain('"newer"');
    expect(one.text).not.toContain("i know what the thesis is");
    expect(one.before).toBe(
      '- line: The thesis and claims of his own paper.\n  said: 2026-07-23 · session 81be510a · "i know what the thesis is"',
    );
    const twice = `${base}- line: The thesis and claims of his own paper.\n  said: 2026-07-24 · session 81be510b · "again"\n`;
    expect(applyEvidenceEntry(twice, "Knows", 2, entry, { replaces: "The thesis and claims of his own paper." })).toEqual({
      ok: false,
      reason: 'the line to replace has 2 evidence entries under "Knows"; which one cannot be told',
    });
    expect(applyEvidenceEntry(base, "Knows", 2, entry, { replaces: "Not on record." })).toEqual({
      ok: false,
      reason: 'the line to replace has no evidence entry under "Knows"',
    });
  });

  it("takes an entry out whole, and says when it was already gone", () => {
    const gone = removeEvidenceEntry(base, "Knows", "The thesis and claims of his own paper.");
    expect(gone.ok).toBe(true);
    expect(gone.text).not.toContain("thesis");
    expect(gone.text.split("\n")).toEqual(["# Evidence for ground.md", "", "## Knows", "", ""]);
    expect(removeEvidenceEntry(base, "Knows", "Nothing like it.")).toMatchObject({ ok: false, missing: true });
  });
});

describe("evidencePath", () => {
  it("mirrors the path under evidence/", () => {
    expect(evidencePath("model-of-tom/ground.md")).toBe("model-of-tom/evidence/ground.md");
    expect(evidencePath("model-of-tom/areas/climbing.md")).toBe("model-of-tom/evidence/areas/climbing.md");
    expect(evidencePath("model-of-tom/evidence/ground.md")).toBe("model-of-tom/evidence/ground.md");
    expect(evidencePath("tts/spec.md")).toBeNull();
  });
});

// ── The pair, written and taken back together ────────────────────────────────
const PAGE = ["# Ground", "", "## Knows", "", "- An old line.", "", "## Does not know", "", "- Something else.", ""].join("\n");
const EVIDENCE = [
  "# Evidence for ground.md",
  "",
  "## Knows",
  "",
  "- line: An old line.",
  '  said: 2026-07-23 · session 81be510a · "an old line of his"',
  "",
  "## Does not know",
  "",
  "- line: Something else.",
  '  said: 2026-07-23 · session 81be510a · "something else entirely"',
  "",
].join("\n");

describe("applyRecords", () => {
  it("writes both halves or neither", () => {
    const out = applyRecords(PAGE, EVIDENCE, change({ section: "Does not know" }));
    expect(out.ok).toBe(true);
    expect(out.pageText).toContain("- Git beyond add, commit, push and pull: git-lfs, overwrite versus merge.");
    expect(out.evidenceText).toContain("- line: Git beyond add, commit, push and pull: git-lfs, overwrite versus merge.");
    // The page carries no quote, no date, no id; the entry carries all three.
    const bullet = out.pageText.split("\n").find((l) => l.includes("git-lfs"));
    expect(bullet).not.toMatch(/\d{4}-\d{2}-\d{2}|session |"/);
    expect(out.entry).toMatch(/2026-09-08/);
    expect(out.entry).toMatch(/session 47f04bc9/);
    // A section that is not there stops both halves.
    expect(applyRecords(PAGE, EVIDENCE, change({ section: "Nowhere" })).ok).toBe(false);
  });

  it("replaces both halves and records what it replaced", () => {
    const out = applyRecords(
      PAGE,
      EVIDENCE,
      change({ section: "Knows", op: "replace", line: "A newer line.", replaces: "An old line." }),
    );
    expect(out.ok).toBe(true);
    expect(out.before).toBe("- An old line.");
    expect(out.beforeEntry).toBe('- line: An old line.\n  said: 2026-07-23 · session 81be510a · "an old line of his"');
    expect(out.pageText).not.toContain("An old line.");
    expect(out.evidenceText).not.toContain("an old line of his");
    expect(out.evidenceText).toContain("- line: A newer line.");
  });

  it("removes both halves", () => {
    const out = applyRecords(PAGE, EVIDENCE, {
      file: "model-of-tom/ground.md",
      section: "Does not know",
      op: "remove",
      replaces: "Something else.",
      evidence: [],
    });
    expect(out.ok).toBe(true);
    expect(out.pageText).not.toContain("Something else.");
    expect(out.evidenceText).not.toContain("something else entirely");
  });

  it("refuses a line already on the page", () => {
    expect(applyRecords(PAGE, EVIDENCE, change({ section: "Knows", line: "An old line." })).reason).toBe(
      "already on the page",
    );
  });
});

describe("revertRecords", () => {
  it("takes back both halves of an addition", () => {
    const added = applyRecords(PAGE, EVIDENCE, change({ section: "Does not know" }));
    const back = revertRecords(added.pageText, added.evidenceText, {
      file: "model-of-tom/ground.md",
      section: "Does not know",
      before: "",
      beforeEntry: "",
      after: added.line,
    });
    expect(back.ok).toBe(true);
    expect(back.pageText).toBe(PAGE);
    expect(back.evidenceText).toBe(EVIDENCE);
    expect(back.evidenceMissing).toBe(false);
  });

  it("restores the old line and its old entry on a replacement", () => {
    const done = applyRecords(
      PAGE,
      EVIDENCE,
      change({ section: "Knows", op: "replace", line: "A newer line.", replaces: "An old line." }),
    );
    const back = revertRecords(done.pageText, done.evidenceText, {
      file: "model-of-tom/ground.md",
      section: "Knows",
      before: done.before,
      beforeEntry: done.beforeEntry,
      after: done.line,
    });
    expect(back.ok).toBe(true);
    expect(back.pageText).toContain("- An old line.");
    expect(back.evidenceText).toContain("an old line of his");
    expect(back.evidenceText).not.toContain("A newer line.");
  });

  it("succeeds on the page when the entry is already gone, and says so", () => {
    const added = applyRecords(PAGE, EVIDENCE, change({ section: "Does not know" }));
    const back = revertRecords(added.pageText, EVIDENCE, {
      file: "model-of-tom/ground.md",
      section: "Does not know",
      before: "",
      after: added.line,
    });
    expect(back.ok).toBe(true);
    expect(back.evidenceMissing).toBe(true);
  });

  it("refuses a replacement whose row predates the evidence record", () => {
    expect(
      revertRecords(PAGE, EVIDENCE, {
        file: "model-of-tom/ground.md",
        section: "Knows",
        before: "- An old line.",
        after: "- A newer line.",
      }),
    ).toEqual({ ok: false, reason: "the change predates the evidence record; revert it by hand" });
  });
});

// ── The gate: WikiTom's own checker over what the writer left ────────────────
describe("the pair against check-evidence.mjs", () => {
  it("is the same script WikiTom runs", () => {
    const checkout = process.env.TTS_WIKITOM_CHECKOUT;
    if (checkout === undefined) return;
    const real = path.join(checkout, "scripts", "check-evidence.mjs");
    if (!fs.existsSync(real)) return;
    expect(fs.readFileSync(CHECKER, "utf8")).toBe(fs.readFileSync(real, "utf8"));
  });

  function wikitomTree() {
    const dir = tmp();
    write(dir, "scripts/check-evidence.mjs", fs.readFileSync(CHECKER, "utf8"));
    for (const rel of ["agent-rules.md", "intent.md", "writing.md", "priorities.md", "schedule.md"]) {
      write(dir, `model-of-tom/${rel}`, `# ${rel}\n\n## Only\n\n`);
      write(dir, `model-of-tom/evidence/${rel}`, `# Evidence\n\n## Only\n\n`);
    }
    write(dir, "model-of-tom/areas/climbing.md", "## Current state\n\n");
    write(dir, "model-of-tom/evidence/areas/climbing.md", "# Evidence\n\n## Current state\n\n");
    write(dir, "model-of-tom/ground.md", PAGE);
    write(dir, "model-of-tom/evidence/ground.md", EVIDENCE);
    return dir;
  }

  const check = (dir) => {
    try {
      execFileSync("node", ["scripts/check-evidence.mjs"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { ok: true };
    } catch (err) {
      return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };

  it("passes on the tree the writer leaves, and fails when the entry half is skipped", () => {
    const dir = wikitomTree();
    expect(check(dir).ok).toBe(true);
    const before = treeHash(dir);

    const changes = [
      change({ section: "Does not know" }),
      change({ section: "Knows", line: "A second one.", evidence: [{ ...SAID, text: "a second one of his own words here" }] }),
      change({
        section: "Knows",
        line: "An inferred one.",
        inferred: true,
        evidence: [{ ...SAID, form: "rests on", text: "he said nothing of it; read off the record." }],
      }),
    ];
    let page = fs.readFileSync(path.join(dir, "model-of-tom/ground.md"), "utf8");
    let evidence = fs.readFileSync(path.join(dir, "model-of-tom/evidence/ground.md"), "utf8");
    for (const c of changes) {
      const out = applyRecords(page, evidence, c);
      expect(out.ok).toBe(true);
      page = out.pageText;
      evidence = out.evidenceText;
    }
    fs.writeFileSync(path.join(dir, "model-of-tom/ground.md"), page);
    fs.writeFileSync(path.join(dir, "model-of-tom/evidence/ground.md"), evidence);
    expect(check(dir).ok).toBe(true);

    // Now the half-write the whole-run gate exists for: the page line with no
    // entry. The checker refuses it, and restoring the read-before bytes puts
    // the tree back exactly.
    const restore = new Map(
      ["model-of-tom/ground.md", "model-of-tom/evidence/ground.md"].map((rel) => [
        rel,
        fs.readFileSync(path.join(dir, rel)),
      ]),
    );
    const mid = treeHash(dir);
    fs.writeFileSync(
      path.join(dir, "model-of-tom/ground.md"),
      `${page.trimEnd()}\n- A line with no entry at all.\n`,
    );
    const failed = check(dir);
    expect(failed.ok).toBe(false);
    expect(failed.output).toContain("no evidence entry");
    for (const [rel, bytes] of restore) fs.writeFileSync(path.join(dir, rel), bytes);
    expect(treeHash(dir)).toBe(mid);
    expect(check(dir).ok).toBe(true);
    expect(before).not.toBe(mid);
  });
});

describe("oneLine", () => {
  it("is how a wrapped bullet is compared", () => {
    expect(oneLine("- a bullet\n  wrapped over\n  three lines")).toBe("- a bullet wrapped over three lines");
  });
});
