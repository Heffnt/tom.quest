import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

// Shape guards for the VQC registries and the rulings log (vqc/adoption.md).
// These validate the SCHEMA of choice-files at use (fail-loud, C3/D24) — they
// never freeze content: editing these files is the intended operation.

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

// THE RULINGS LOG is the last section of vqc/adoption.md: the append-only
// record of Tom's verdicts, one entry per verdict, declared there as
// "id, date, question, ruling, cites". Nothing checked that shape until this
// guard — vqc/todos.test.ts enforces cites for todos.yaml only, so a ruling
// appended with a typo'd field name, a duplicate id, or an unresolvable cite
// landed silently, in the one file a later session reads to learn what was
// already decided.
//
// It is parsed BY HAND rather than with js-yaml, even though the section is
// written in YAML's block-list form. The ruling prose contains ": " inside
// plain scalars ("Scope: convex/ttsSync.ts sendDigest only.", in
// digest-env-missing-is-quiet), which YAML forbids and js-yaml rejects. The
// log is append-only and the words are Tom's, so the prose does not bend to
// the parser; the parser bends to the prose.
type Ruling = { id: string; date: string; question: string; ruling: string; cites: string[] };

function parseRulingsLog(): Ruling[] {
  const raw = readFileSync(join(__dirname, "adoption.md"), "utf8");
  const heading = raw.indexOf("## Rulings log");
  expect(heading, "vqc/adoption.md has no '## Rulings log' section").toBeGreaterThan(-1);
  const after = raw.slice(raw.indexOf("\n", heading) + 1);
  // The log runs to the end of the file; stop early if a later section is added.
  const body = after.split(/^## /m)[0];

  const entries: Record<string, string>[] = [];
  let field: string | null = null;
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    const start = /^- (\w+): ?(.*)$/.exec(line);
    const next = /^ {2}(\w+): ?(.*)$/.exec(line);
    const cont = /^ {4}(\S.*)$/.exec(line);
    if (start) {
      expect(start[1], `rulings log: entry starts with '${start[1]}', not 'id'`).toBe("id");
      entries.push({ id: start[2].trim() });
      field = "id";
    } else if (next) {
      expect(entries.length, `rulings log: field '${next[1]}' before any entry`).toBeGreaterThan(0);
      field = next[1];
      entries[entries.length - 1][field] = next[2].trim();
    } else if (cont) {
      expect(field, `rulings log: continuation line with no field: ${line}`).not.toBeNull();
      const e = entries[entries.length - 1];
      e[field as string] = `${e[field as string]} ${cont[1].trim()}`.trim();
    } else {
      throw new Error(`rulings log: unparseable line: ${JSON.stringify(line)}`);
    }
  }
  return entries as unknown as Ruling[];
}

// witness: in vqc/adoption.md's rulings log, duplicate any entry's id, blank
// out its `ruling:`, or add a cite like "X99" — this test goes red on each.
describe("vqc/adoption.md rulings log", () => {
  const FIELDS = ["id", "date", "question", "ruling", "cites"];

  it("holds well-formed entries with unique ids", () => {
    const rulings = parseRulingsLog();
    expect(rulings.length).toBeGreaterThan(0);
    const ids = rulings.map((r) => r.id);
    expect(new Set(ids).size, "rulings log: duplicate id").toBe(ids.length);
    for (const r of rulings) {
      expect(Object.keys(r).sort(), r.id).toEqual([...FIELDS].sort());
      expect(r.id, JSON.stringify(r)).toMatch(KEBAB);
      expect(r.date, r.id).toMatch(DATE);
      expect(String(r.question).trim().length, r.id).toBeGreaterThan(0);
      expect(String(r.ruling).trim().length, r.id).toBeGreaterThan(0);
    }
  });

  // A ruling is PERMANENT and the log is append-only, so a ruling may cite
  // only permanent ids: constitution articles and tts-spec sections. Open
  // ledger ids are in the cite resolution set for todos, where they belong —
  // a ledger entry is deleted when it graduates, which would turn an
  // uneditable ruling red for doing exactly what the ledger is for.
  it("cites only permanent ids", () => {
    for (const r of parseRulingsLog()) {
      const cites = String(r.cites).trim();
      expect(cites, `${r.id}: cites must be a [list]`).toMatch(/^\[.+\]$/);
      const parsed = cites.slice(1, -1).split(",").map((c) => c.trim());
      expect(parsed.length, `${r.id}: empty cites`).toBeGreaterThan(0);
      for (const cite of parsed) {
        expect(ARTICLE_OR_SPEC.test(cite), `${r.id}: unresolvable cite ${cite}`).toBe(true);
      }
    }
  });

  // Append-only means new entries go at the BOTTOM. Dates that only ever run
  // forward is the readable consequence, and the cheap mechanical check that
  // an entry was appended rather than spliced into the middle.
  it("runs forward in time (appended, never spliced)", () => {
    const dates = parseRulingsLog().map((r) => r.date);
    expect(dates).toEqual([...dates].sort());
  });
});
