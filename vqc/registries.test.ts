import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

// Shape guards for the VQC registries (vqc/adoption.md). These validate the
// SCHEMA of choice-files at use (fail-loud, C3/D24) — they never freeze
// content: editing these files is the intended operation.

const ARTICLE_OR_SPEC = /^(A\d+|C[1-9]|D\d+|tts-spec:\d+(\.\d+)?)$/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function loadList(file: string): Record<string, unknown>[] {
  const parsed = loadYaml(readFileSync(join(__dirname, file), "utf8"));
  expect(Array.isArray(parsed), file).toBe(true);
  return parsed as Record<string, unknown>[];
}

// witness: blank out any ledger entry's `graduates_when` in vqc/ledger.yaml
// and this test goes red.
describe("vqc/ledger.yaml", () => {
  const KINDS = [
    "descent",
    "alignment",
    "pending-fence",
    "steering-graduation",
    "scratch-graduation",
  ];

  it("holds well-formed open entries with unique ids", () => {
    const entries = loadList("ledger.yaml");
    expect(entries.length).toBeGreaterThan(0);
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of entries) {
      expect(String(e.id), JSON.stringify(e)).toMatch(KEBAB);
      expect(KINDS, String(e.id)).toContain(e.kind);
      expect(String(e.created), String(e.id)).toMatch(DATE);
      expect(Array.isArray(e.cites) && (e.cites as string[]).length > 0, String(e.id)).toBe(true);
      for (const cite of e.cites as string[]) {
        expect(ARTICLE_OR_SPEC.test(cite), `${e.id}: unresolvable cite ${cite}`).toBe(true);
      }
      expect(String(e.statement ?? "").trim().length, String(e.id)).toBeGreaterThan(0);
      expect(String(e.graduates_when ?? "").trim().length, String(e.id)).toBeGreaterThan(0);
    }
  });
});

// The article roster's one home is the constitution's ARTICLES registry
// (ComplexMultiTrigger/vqc/constitution.md), which this repo does not vendor.
// Restating its EXTENT here — "D1-D28", "C1-C9" — is a second spelling of a
// fact that grows without telling us: all three cite-set descriptions said
// "D1-D28" while the constitution had already reached D31. Describe the id
// SHAPE (A*/C*/D*), never the count.
//
// witness: change any `A*/C*/D*` in vqc/adoption.md, vqc/ledger.yaml, or
// vqc/todos.yaml back to `A*/C1-C9/D1-D28` and this test goes red.
describe("vqc cite-set descriptions", () => {
  const FILES = ["adoption.md", "ledger.yaml", "todos.yaml"];
  // A bounded upper end on the D range — "D1-D28", "D1–D31", "`D1`–`D28`".
  const PINNED_RANGE = /D\s*1\s*`?\s*[-–—]\s*`?\s*D\s*\d+/i;

  it("describe article ids by shape, never by a pinned range", () => {
    for (const file of FILES) {
      const text = readFileSync(join(__dirname, file), "utf8");
      const match = text.match(PINNED_RANGE);
      expect(
        match,
        `${file}: pins the article roster's extent ("${match?.[0]}"). The ` +
          `roster lives in the constitution's ARTICLES registry and grows; ` +
          `describe the id shape (A*/C*/D*) instead.`,
      ).toBeNull();
    }
  });
});

// witness: change a steering entry's `kind` to "rule" in vqc/steering.yaml
// and this test goes red.
describe("vqc/steering.yaml", () => {
  const KINDS = ["gotcha", "preference", "pre-emption"];
  const GRADUATIONS = ["prose", "hook", "eliminated"];

  it("holds well-formed correction entries with unique ids", () => {
    const entries = loadList("steering.yaml");
    expect(entries.length).toBeGreaterThan(0);
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of entries) {
      expect(String(e.id), JSON.stringify(e)).toMatch(KEBAB);
      expect(KINDS, String(e.id)).toContain(e.kind);
      expect(String(e.owner ?? "").trim().length, String(e.id)).toBeGreaterThan(0);
      expect(String(e.created), String(e.id)).toMatch(DATE);
      expect(String(e.trigger ?? "").trim().length, String(e.id)).toBeGreaterThan(0);
      expect(String(e.correction ?? "").trim().length, String(e.id)).toBeGreaterThan(0);
      expect(typeof e.incidents, String(e.id)).toBe("number");
      expect(GRADUATIONS, String(e.id)).toContain(e.graduation);
    }
  });
});
