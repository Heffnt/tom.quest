import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { ARTICLE_OR_SPEC } from "./cites";

// Shape guards for the VQC registries and the rulings log (vqc/adoption.md).
// These validate the SCHEMA of choice-files at use (fail-loud, C3/D24) — they
// never freeze content: editing these files is the intended operation.

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

// THE CADENCE TABLE is the "## Cadences" section of vqc/adoption.md: the one
// declared home for what runs when. Every row names a mechanism and, when the
// mechanism runs in CI, the job that runs it. Both halves can go stale in
// silence — a row may name a `pnpm` script that no longer exists in
// package.json, or a GitHub Actions job that was renamed or deleted in
// .github/workflows/guardrails.yml — and a stale cadence row is worse than a
// missing one, because it reports coverage the repository does not have.
//
// This guard checks referential integrity only, in both directions: every
// `pnpm <script>` a row names exists, every CI job a row names exists, and
// every job in the workflow is named by some row. It does not require any
// particular row to exist — editing the table is the intended operation.
const CADENCE_WORKFLOW = "../.github/workflows/guardrails.yml";

function cadenceRows(): string[] {
  const raw = readFileSync(join(__dirname, "adoption.md"), "utf8").replace(/\r/g, "");
  const heading = raw.indexOf("## Cadences");
  expect(heading, "vqc/adoption.md has no '## Cadences' section").toBeGreaterThan(-1);
  const body = raw.slice(raw.indexOf("\n", heading) + 1).split(/^## /m)[0];
  return body
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .filter((line) => !/^\|[\s:|-]+\|$/.test(line))
    .slice(1); // drop the header row
}

function workflowJobs(): string[] {
  const raw = readFileSync(join(__dirname, CADENCE_WORKFLOW), "utf8").replace(/\r/g, "");
  const jobs = raw.slice(raw.indexOf("\njobs:"));
  return [...jobs.matchAll(/^ {2}([a-z0-9][a-z0-9-]*):$/gm)].map((m) => m[1]);
}

// witness: rename the `tests` job in .github/workflows/guardrails.yml, or
// rename any `pnpm` script the table names in package.json — this test goes
// red on each.
describe("vqc/adoption.md cadence table", () => {
  it("names only pnpm scripts that exist", () => {
    const scripts = JSON.parse(
      readFileSync(join(__dirname, "../package.json"), "utf8"),
    ).scripts as Record<string, string>;
    const rows = cadenceRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const [, script] of row.matchAll(/`pnpm ([a-z0-9:-]+)`/g)) {
        expect(Object.keys(scripts), `cadence row names missing script: ${row.trim()}`)
          .toContain(script);
      }
    }
  });

  it("names only CI jobs that exist, and names every one of them", () => {
    const jobs = workflowJobs();
    expect(jobs.length).toBeGreaterThan(0);
    const named = new Set<string>();
    for (const row of cadenceRows()) {
      for (const [, job] of row.matchAll(/\(CI `([a-z0-9-]+)` job\)/g)) {
        expect(jobs, `cadence row names missing CI job: ${row.trim()}`).toContain(job);
        named.add(job);
      }
    }
    for (const job of jobs) {
      expect(named, `guardrails.yml job '${job}' has no row in the cadence table`)
        .toContain(job);
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
  // \r stripped up front: the committed blob is LF, but core.autocrlf=true
  // checkouts (Windows dev machines) hand this parser CRLF working-tree
  // text, and a guard that only runs green on Linux is a guard nobody runs
  // locally.
  const raw = readFileSync(join(__dirname, "adoption.md"), "utf8").replace(
    /\r/g,
    "",
  );
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
