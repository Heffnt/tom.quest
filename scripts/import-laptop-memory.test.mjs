// The one-shot importer. What is pinned is what the delete list may never
// rest on: an unchecked overlap claim, a routing entry nobody wrote, or a
// write the evidence checker would refuse.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  HANDOFFS_FILE,
  STATUSES,
  appendUnderHeading,
  checkoutIo,
  countByStatus,
  deleteList,
  handoffEntry,
  handoffTarget,
  joinToDisk,
  parseArgs,
  parseCatalogue,
  claimFragments,
  quotedClaims,
  runImport,
  verifyOverlap,
  walkMemoryFiles,
} from "./import-laptop-memory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = fs.readFileSync(path.join(here, "..", "worker", "jobs", "fixtures", "check-evidence.mjs"), "utf8");
// The catalogue is design input, not a repo artifact: the real-file tests
// skip where it is not on the machine, and TTS_MEMORY_CATALOGUE points at it
// wherever it is.
const CATALOGUE = process.env.TTS_MEMORY_CATALOGUE ?? path.join(
  process.env.LOCALAPPDATA ?? os.tmpdir(),
  "Temp",
  "claude",
  "C--Users-heffn-Desktop-tom-quest--claude-worktrees-unified-agent-context-fa13a6",
  "f15926cf-9201-40fb-9367-e40d223c31f4",
  "scratchpad",
  "uac",
  "content-C-laptop-memory.md",
);
const ROUTING = path.join(here, "laptop-memory-routing.json");
// Which repository each laptop project directory belongs to is DATA, beside
// the routing entries: a source file listing repository names is a copy of the
// one home, which check-session-mirrors.mjs refuses.
const PROJECTS = JSON.parse(fs.readFileSync(ROUTING, "utf8"))._projects;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "import-"));
}
function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}
function treeHash(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(next);
      else out.push(`${next} ${crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, next))).digest("hex")}`);
    }
  };
  walk("");
  return out.join("\n");
}

// ── The catalogue, as it actually is ─────────────────────────────────────────
// The real 235-row file when it is on this machine; the fixture below when it
// is not, so the parser is tested either way.
const FIXTURE = [
  "# The laptop's auto-memory",
  "",
  "## 1. `c--Users-heffn-Desktop-tom-quest/memory/` (3 files)",
  "",
  "| id | file | type | description | core claim (≤50 words) | status |",
  "|---|---|---|---|---|---|",
  "| C-001 | MEMORY.md | — | the index | every entry is catalogued below | STALE (index; every entry catalogued separately below) |",
  '| C-002 | feedback_persistence_gate.md | feedback | input gates persistence | Tom 2026-08-29: "remove the plan gate" | IN-WIKITOM — priorities.md: "Input gates persistence, not implementation" |',
  "| C-003 | codex-implements.md | feedback | Codex by default | Tom 2026-09-07: use codex agents by default | UNIQUE-DURABLE |",
  "",
  "## 2. `C--Users-heffn-Desktop-WikiTom/memory/` (2 files)",
  "",
  "| id | file | type | description / claim | status |",
  "|---|---|---|---|",
  "| C-004 | handoff_merge_queue.md | project | merge queue in flight, 2026-09-01 | UNIQUE-PROJECT |",
  "| C-005 | pipes.md | project | a cell with an escaped \\| pipe in it | UNIQUE-PROJECT |",
  "",
  "## The UNIQUE-DURABLE rows that are Tom's own words",
  "",
  '1. **C-003 `codex-implements.md`** — Tom 2026-09-07: *"I want you to use codex agents by default."*',
  "",
].join("\n");

describe("parseCatalogue", () => {
  it("reads the real catalogue: 235 rows, its own counts, unique ids, quotes attached", () => {
    if (!fs.existsSync(CATALOGUE)) return;
    const { rows, directories } = parseCatalogue(fs.readFileSync(CATALOGUE, "utf8"));
    expect(rows).toHaveLength(235);
    expect(countByStatus(rows)).toEqual({
      "IN-WIKITOM": 37,
      "IN-AGENTS-MD": 1,
      "UNIQUE-DURABLE": 26,
      "UNIQUE-PROJECT": 102,
      STALE: 68,
      UNSURE: 1,
    });
    expect(new Set(rows.map((r) => r.id)).size).toBe(235);
    expect(directories).toHaveLength(7);
    // Every row belongs to a directory, and every quote in the tail found its row.
    expect(rows.every((r) => typeof r.dir === "string" && r.dir !== "")).toBe(true);
    expect(rows.filter((r) => r.quote !== null)).toHaveLength(14);
  });

  it("reads both column shapes, the status word, and a cell holding an escaped pipe", () => {
    const { rows, directories } = parseCatalogue(FIXTURE);
    expect(rows.map((r) => r.id)).toEqual(["C-001", "C-002", "C-003", "C-004", "C-005"]);
    expect(directories.map((d) => d.claimed)).toEqual([3, 2]);
    expect(rows[1]).toMatchObject({
      status: "IN-WIKITOM",
      note: '— priorities.md: "Input gates persistence, not implementation"',
    });
    // UNIQUE-DURABLE and UNIQUE-PROJECT share a prefix and are not confused.
    expect(rows[2].status).toBe("UNIQUE-DURABLE");
    expect(rows[3].status).toBe("UNIQUE-PROJECT");
    // The five-column shape puts the claim in the second-to-last cell.
    expect(rows[3].claim).toBe("merge queue in flight, 2026-09-01");
    expect(rows[4].claim).toContain("escaped | pipe");
    expect(rows[2].quote).toContain("use codex agents by default");
    expect(STATUSES).toContain(rows[0].status);
  });
});

// ── Every routing entry, and nothing guessed ─────────────────────────────────
describe("the routing file", () => {
  it("has an entry for every UNIQUE-DURABLE id in the real catalogue", () => {
    if (!fs.existsSync(CATALOGUE)) return;
    const { rows } = parseCatalogue(fs.readFileSync(CATALOGUE, "utf8"));
    const routing = JSON.parse(fs.readFileSync(ROUTING, "utf8"));
    const durable = rows.filter((r) => r.status === "UNIQUE-DURABLE").map((r) => r.id);
    expect(Array.isArray(routing._projects)).toBe(true);
    expect(durable.filter((id) => routing[id] === undefined)).toEqual([]);
    for (const id of durable) {
      const route = routing[id];
      expect(["add", "replace", "skip"]).toContain(route.op);
      if (route.op === "skip") {
        expect(typeof route.why).toBe("string");
        continue;
      }
      expect(route.file.startsWith("model-of-tom/")).toBe(true);
      expect(typeof route.line).toBe("string");
      // The line is a synthesis line: no quote, no date, no citation.
      expect(route.line).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
      expect(route.evidence.length).toBeGreaterThan(0);
      for (const e of route.evidence) {
        expect(["said", "paraphrase", "read", "rests on"]).toContain(e.form);
        expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(e.source.startsWith("laptop memory ")).toBe(true);
      }
    }
  });
});

// ── The overlap claims ───────────────────────────────────────────────────────
describe("verifyOverlap", () => {
  const record = ['- Input gates persistence, not implementation.', "- He never reads code or diffs."];
  it("keeps a row whose quoted line is on record and downgrades one whose is not", () => {
    expect(
      verifyOverlap({ note: '— priorities.md: "Input gates persistence, not implementation"' }, record),
    ).toMatchObject({ verified: true });
    // One word different is a different line, and the row is not deletable.
    const off = verifyOverlap({ note: '— priorities.md: "Input gates persistence, not deployment"' }, record);
    expect(off.verified).toBe(false);
    expect(off.why).toContain("no line in the record carries");
    // A status cell that quotes nothing is not a verified overlap either.
    expect(verifyOverlap({ note: "(index)" }, record)).toMatchObject({
      verified: false,
      why: "the status cell quotes no line",
    });
  });

  it("finds the quoted spans in a status cell", () => {
    expect(quotedClaims('IN-WIKITOM — writing.md: "He never reads code or diffs."')).toEqual([
      "He never reads code or diffs.",
    ]);
    expect(quotedClaims("no quote at all")).toEqual([]);
  });

  // The catalogue quoted the pages as they were, with their citations on the
  // line; the two-record rewrite moved every citation to the evidence entry.
  it("takes the attribution off a claim and splits it where the catalogue elided", () => {
    expect(claimFragments("Input gates persistence, not implementation. Tom, 2026-08-29")).toEqual([
      "Input gates persistence, not implementation",
    ]);
    expect(claimFragments("He replies by number… An item he cannot parse comes back as a question (Tom 2026-08-29)")).toEqual([
      "He replies by number",
      "An item he cannot parse comes back as a question",
    ]);
    // A quote that is nothing but an attribution asserts nothing checkable.
    expect(claimFragments("Standing authorizations. Tom, 2026-07-06, on tom.quest")).toEqual([]);
    expect(
      verifyOverlap({ note: 'IN-WIKITOM — priorities.md: "Standing authorizations. Tom, 2026-07-06"' }, record),
    ).toMatchObject({ verified: false, why: "the status cell's quote is too short to check" });
    // The attribution off, the line is found.
    expect(
      verifyOverlap(
        { note: 'IN-WIKITOM — priorities.md: "Input gates persistence, not implementation. Tom, 2026-08-29"' },
        record,
      ),
    ).toMatchObject({ verified: true });
    // Every fragment must be on record, not just one.
    expect(
      verifyOverlap({ note: 'IN-WIKITOM — writing.md: "He never reads code or diffs… and he never reads a plan"' }, record),
    ).toMatchObject({ verified: false });
  });
});

// ── The directories, joined ──────────────────────────────────────────────────
describe("walkMemoryFiles and joinToDisk", () => {
  it("finds what the catalogue misses and what the disk misses", () => {
    const projects = tmp();
    write(projects, "proj-a/memory/MEMORY.md", "index");
    write(projects, "proj-a/memory/one.md", "one");
    write(projects, "proj-a/memory/extra.md", "not catalogued");
    write(projects, "proj-b/notes.md", "not a memory dir");
    const onDisk = walkMemoryFiles(projects);
    expect(onDisk.map((f) => f.file).sort()).toEqual(["MEMORY.md", "extra.md", "one.md"]);
    const rows = [
      { id: "C-1", dir: "PROJ-A", file: "MEMORY.md" },
      { id: "C-2", dir: "proj-a", file: "one.md" },
      { id: "C-3", dir: "proj-a", file: "gone.md" },
    ];
    const { joined, uncatalogued, missing } = joinToDisk(rows, onDisk);
    // The catalogue's directory names differ from the disk's only in case.
    expect(joined.map((r) => r.onDisk)).toEqual([true, true, false]);
    expect(uncatalogued.map((f) => f.file)).toEqual(["extra.md"]);
    expect(missing.map((r) => r.id)).toEqual(["C-3"]);
  });
});

// ── The two records, and the real checker over them ──────────────────────────
function wikitom() {
  const dir = tmp();
  write(dir, "scripts/check-evidence.mjs", CHECKER);
  for (const rel of ["intent.md", "ground.md", "writing.md", "priorities.md", "schedule.md"]) {
    write(dir, `model-of-tom/${rel}`, `# ${rel}\n\n## Only\n\n`);
    write(dir, `model-of-tom/evidence/${rel}`, `# Evidence\n\n## Only\n\n`);
  }
  write(dir, "model-of-tom/agent-rules.md", "# Agent rules\n\n## Jobs\n\n- An existing rule.\n\n## Directions\n\nHis.\n");
  write(
    dir,
    "model-of-tom/evidence/agent-rules.md",
    '# Evidence\n\n## Jobs\n\n- line: An existing rule.\n  said: 2026-08-01 · session 47f04bc9 · "an existing rule of his"\n',
  );
  write(dir, "model-of-tom/areas/climbing.md", "## Current state\n\n");
  write(dir, "model-of-tom/evidence/areas/climbing.md", "# Evidence\n\n## Current state\n\n");
  return dir;
}
const check = (dir) => {
  try {
    return { ok: true, output: execFileSync("node", ["scripts/check-evidence.mjs"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (err) {
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

const ROUTE = {
  file: "model-of-tom/agent-rules.md",
  section: "Jobs",
  op: "add",
  line: "Heavy compute runs on Turing, never on his laptop.",
  evidence: [
    {
      form: "said",
      date: "2026-09-07",
      source: "laptop memory offload-compute-to-turing.md",
      text: "let's move all compute to Turing CPUs/GPUs rather than my laptop",
    },
  ],
};

describe("runImport", () => {
  const rows = [
    { id: "C-1", status: "UNIQUE-DURABLE", dir: "c--Users-heffn-Desktop-tom-quest", file: "a.md", abs: "/a.md", onDisk: true },
    { id: "C-2", status: "UNIQUE-DURABLE", dir: "x", file: "b.md", abs: "/b.md", onDisk: true },
    {
      id: "C-3",
      status: "UNIQUE-PROJECT",
      dir: "c--Users-heffn-Desktop-tom-quest",
      file: "handoff_merge_queue.md",
      description: "merge queue in flight, 2026-09-01",
      claim: "the box queue-worker died mid-run; read this first when resuming.",
      abs: "/c.md",
      onDisk: true,
    },
    {
      id: "C-4",
      status: "UNIQUE-PROJECT",
      dir: "c--Users-heffn-Desktop-something-else",
      file: "notes.md",
      description: "a note with no repository",
      claim: "it belongs nowhere in particular.",
      abs: "/d.md",
      onDisk: true,
    },
  ];
  const routing = { "C-1": ROUTE, "C-2": { op: "skip", why: "already on agent-rules.md" } };

  it("writes both records for a durable row, and the checker passes", () => {
    const dir = wikitom();
    expect(check(dir).ok).toBe(true);
    const io = checkoutIo(dir);
    const result = runImport({ rows, routing, io, day: "2026-09-11" });
    expect(result.written.map((w) => w.id)).toEqual(["C-1"]);
    expect(result.held).toEqual([{ id: "C-2", reason: "skipped: already on agent-rules.md" }]);
    const page = fs.readFileSync(path.join(dir, "model-of-tom/agent-rules.md"), "utf8");
    const entries = fs.readFileSync(path.join(dir, "model-of-tom/evidence/agent-rules.md"), "utf8");
    expect(page).toContain("- Heavy compute runs on Turing, never on his laptop.");
    expect(page).not.toContain("2026-09-07");
    expect(entries).toContain("- line: Heavy compute runs on Turing, never on his laptop.");
    expect(entries).toContain('said: 2026-09-07 · laptop memory offload-compute-to-turing.md · "let\'s move all');
    expect(check(dir).ok).toBe(true);
  });

  it("routes each handoff to its repository's evidence file, and the rest to handoffs.md", () => {
    const dir = wikitom();
    const io = checkoutIo(dir);
    const result = runImport({ rows, routing, io, day: "2026-09-11", projects: PROJECTS });
    expect(result.handoffs.map((h) => h.file)).toEqual([
      "model-of-tom/evidence/repos/tom.quest.md",
      HANDOFFS_FILE,
    ]);
    const handoffs = fs.readFileSync(path.join(dir, HANDOFFS_FILE), "utf8");
    expect(handoffs).toContain("## handoffs — laptop memory 2026-09-11");
    expect(handoffs).toContain("- line: a note with no repository");
    expect(handoffs).toContain("read: 2026-09-11 · laptop memory notes.md · it belongs nowhere in particular.");
    // No synthesis line anywhere: these are notes, not rules.
    expect(fs.existsSync(path.join(dir, "model-of-tom/handoffs.md"))).toBe(false);
  });

  it("refuses one of Tom's sections", () => {
    const dir = wikitom();
    const io = checkoutIo(dir);
    const result = runImport({
      rows: [rows[0]],
      routing: { "C-1": { ...ROUTE, section: "Directions" } },
      io,
      day: "2026-09-11",
    });
    expect(result.written).toEqual([]);
    expect(result.held[0].reason).toBe('"Directions" is Tom\'s section; an agent never writes it');
  });

  it("writes nothing anywhere on a dry run", () => {
    const dir = wikitom();
    const before = treeHash(dir);
    const io = checkoutIo(dir, { dryRun: true });
    const result = runImport({ rows, routing, io, day: "2026-09-11" });
    expect(result.written).toHaveLength(1);
    expect(treeHash(dir)).toBe(before);
    // The writes are still readable, so the report says exactly what would land.
    expect(io.pending.get("model-of-tom/agent-rules.md")).toContain("Heavy compute runs on Turing");
  });

  // The gate's rollback: a real run keeps the read-before bytes of every file
  // it touches, so a failed evidence check puts the checkout back exactly —
  // including removing a file the import created.
  it("restores every byte it wrote when the gate fails", () => {
    const dir = wikitom();
    const before = treeHash(dir);
    const io = checkoutIo(dir);
    const result = runImport({ rows, routing, io, day: "2026-09-11" });
    expect(result.written).toHaveLength(1);
    io.write("model-of-tom/evidence/brand-new.md", "# New\n");
    expect(treeHash(dir)).not.toBe(before);

    const restored = io.restore();
    expect(restored).toContain("model-of-tom/evidence/brand-new.md");
    expect(fs.existsSync(path.join(dir, "model-of-tom/evidence/brand-new.md"))).toBe(false);
    expect(treeHash(dir)).toBe(before);
  });
});

describe("the delete list", () => {
  const rows = [
    { id: "C-1", status: "STALE", file: "stale.md", abs: "/stale.md", onDisk: true },
    { id: "C-2", status: "UNSURE", file: "unsure.md", abs: "/unsure.md", onDisk: true },
    { id: "C-3", status: "IN-WIKITOM", file: "overlap.md", abs: "/overlap.md", onDisk: true },
    { id: "C-4", status: "UNIQUE-DURABLE", file: "downgraded.md", abs: "/downgraded.md", onDisk: true, downgraded: true },
    { id: "C-5", status: "STALE", file: "MEMORY.md", abs: "/MEMORY.md", onDisk: true },
    { id: "C-6", status: "UNIQUE-PROJECT", file: "handoff.md", abs: "/handoff.md", onDisk: true },
    { id: "C-7", status: "STALE", file: "gone.md", abs: null, onDisk: false },
    { id: "C-8", status: "UNIQUE-DURABLE", file: "held.md", abs: "/held.md", onDisk: true },
  ];
  it("carries the settled rows and the indexes, and never an unchecked claim", () => {
    const list = deleteList(rows, { held: [{ id: "C-8", reason: "no section \"Jobs\" on the page" }] });
    expect(list).toEqual(["/MEMORY.md", "/handoff.md", "/overlap.md", "/stale.md"]);
    // UNSURE is never on it, a downgraded row is never on it, a row held for a
    // reason other than "already on record" is never on it, and a catalogued
    // file that is not on disk is never on it.
    expect(list).not.toContain("/unsure.md");
    expect(list).not.toContain("/downgraded.md");
    expect(list).not.toContain("/held.md");
    expect(list).not.toContain("/gone.md");
  });

  it("keeps a row whose routing said skip, because the line IS already on record", () => {
    const list = deleteList([rows[7]], { held: [{ id: "C-8", reason: "skipped: already on agent-rules.md" }] });
    expect(list).toEqual(["/held.md"]);
  });
});

describe("the small pieces", () => {
  it("names a handoff's target by its project directory", () => {
    expect(handoffTarget("c--Users-heffn-Desktop-tom-quest", PROJECTS)).toBe("model-of-tom/evidence/repos/tom.quest.md");
    expect(handoffTarget("C--Users-heffn-Desktop-WikiTom", PROJECTS)).toBe("model-of-tom/evidence/repos/WikiTom.md");
    expect(handoffTarget("C--Users-heffn-Desktop-booleanbackdoor-ComplexMultiTrigger", PROJECTS)).toBe(
      "model-of-tom/evidence/repos/ComplexMultiTrigger.md",
    );
    expect(handoffTarget("C--Users-heffn-Desktop-overleaf-Boolean-Backdoor-Overleaf", PROJECTS)).toBe(
      "model-of-tom/evidence/repos/Overleaf.md",
    );
    expect(handoffTarget("C--Users-heffn-Desktop-Whatever", PROJECTS)).toBe(HANDOFFS_FILE);
  });

  it("renders a handoff entry as a title and what it was read from", () => {
    expect(
      handoffEntry({ file: "handoff_merge_queue.md", description: "merge queue in flight, 2026-09-01", claim: "read it first." }, "2026-09-11"),
    ).toBe(
      "- line: merge queue in flight, 2026-09-01\n  read: 2026-09-11 · laptop memory handoff_merge_queue.md · read it first.",
    );
  });

  it("appends under a heading and creates a missing one", () => {
    const one = appendUnderHeading("", "handoffs — laptop memory 2026-09-11", "- line: a\n  read: b");
    expect(one).toContain("## handoffs — laptop memory 2026-09-11");
    const two = appendUnderHeading(one, "handoffs — laptop memory 2026-09-11", "- line: c\n  read: d");
    expect(two.match(/## handoffs/g)).toHaveLength(1);
    expect(two.indexOf("- line: c")).toBeGreaterThan(two.indexOf("- line: a"));
  });

  it("reads its arguments both ways", () => {
    expect(parseArgs(["--wikitom", "/w", "--catalogue=/c", "--dry-run"])).toMatchObject({
      wikitom: "/w",
      catalogue: "/c",
      dryRun: true,
    });
    expect(parseArgs([]).dryRun).toBe(false);
  });
});
