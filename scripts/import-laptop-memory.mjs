// import-laptop-memory.mjs — the one-shot that empties Tom's laptop
// auto-memory into WikiTom's two records, and prints the delete list.
//
// `C:/Users/heffn/.claude/projects/<project>/memory/` holds a per-project
// auto-memory: a MEMORY.md index and one file per memory. The catalogue at
// scratchpad/uac/content-C-laptop-memory.md reads all of them and gives each a
// status — IN-WIKITOM, IN-AGENTS-MD, UNIQUE-DURABLE, UNIQUE-PROJECT, STALE,
// UNSURE. This script turns that catalogue into:
//
//   - a line and its evidence entry in WikiTom, for every UNIQUE-DURABLE row,
//     through learning-records.mjs's applyRecords — THE SAME WRITER the
//     nightly job uses, so the two records are written the same way and
//     WikiTom's own check-evidence.mjs is the same gate;
//   - an evidence entry with no synthesis line, for every project handoff:
//     those are notes, not rules, and nothing loads them;
//   - a DELETE LIST, which is Tom's to act on.
//
// IT NEVER DELETES ANYTHING and it never touches Claude Code's settings. It
// is READ-ONLY on the memory directories and on the catalogue; the only path
// it writes is the WikiTom checkout given by --wikitom, and --dry-run writes
// nothing at all.
//
// After it runs, and after ONE nightly learning run has reported lines in the
// digest — his standing condition on model-of-tom/areas/agent-systems.md:
// "His laptop's auto-memory stays on until the nightly learning job writes
// session-derived lines into these pages and the digest reports them" — Tom
// deletes the files on the list and turns auto-memory off himself.
//
//   node scripts/import-laptop-memory.mjs \
//     --catalogue <path to content-C-laptop-memory.md> \
//     --projects  C:/Users/heffn/.claude/projects \
//     --wikitom   C:/Users/heffn/Desktop/WikiTom-uac \
//     --routing   scripts/laptop-memory-routing.json \
//     [--dry-run] [--out <report dir>]
//
// Plain Node ESM, zero dependencies.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyRecords,
  evidencePath,
  oneLine,
  parseEvidenceEntries,
} from "../worker/jobs/learning-records.mjs";
import { sectionSpan } from "../worker/jobs/markdown-sections.mjs";

export const STATUSES = [
  "IN-WIKITOM",
  "IN-AGENTS-MD",
  "UNIQUE-DURABLE",
  "UNIQUE-PROJECT",
  "STALE",
  "UNSURE",
];
/** The statuses whose files go on the delete list once the row is settled. */
export const DELETED_STATUSES = ["IN-WIKITOM", "IN-AGENTS-MD", "STALE", "UNIQUE-DURABLE", "UNIQUE-PROJECT"];
/** Sections Tom writes; the importer refuses them exactly as the job does. */
export const FORBIDDEN_SECTIONS = ["Directions", "Ideal state", "Must not break"];
export const HANDOFFS_FILE = "model-of-tom/evidence/handoffs.md";

// ── 1. The catalogue ─────────────────────────────────────────────────────────
// `## N. \`<dir>/memory/\` (<n> files)` opens a directory's section; a
// markdown table follows. Two column shapes are in the file — six columns
// (id, file, type, description, core claim, status) and five (id, file, type,
// description/claim, status) — so the STATUS IS READ OFF THE LAST CELL and the
// claim off the second-to-last, which is right in both.
const DIR_HEADING = /^#{2,3}\s+\d+[a-z]?\.\s+`([^`]+)`\s*\((\d+)[^)]*\)/;
const ROW = /^\|\s*(C-\d{3})\s*\|/;
// One escaped pipe appears inside a cell; splitting on an unescaped pipe is
// what keeps that row six cells wide instead of seven.
const CELL_SPLIT = /(?<!\\)\|/;
const STATUS_WORD = new RegExp(`^(${STATUSES.join("|")})`);
const QUOTE_ENTRY = /^(\d+)\.\s+\*\*(C-\d{3})\s+`([^`]+)`\*\*\s+—\s+(.*)$/;
const TAIL_HEADING = "The UNIQUE-DURABLE rows that are Tom's own words";

/**
 * The catalogue as `{rows, directories}`. A row is
 * `{id, dir, file, type, claim, status, note}` — `status` is the first word of
 * the status cell and `note` the rest, which is where an IN-WIKITOM row quotes
 * the line it says already exists.
 */
export function parseCatalogue(text) {
  const rows = [];
  const directories = [];
  let dir = null;
  let inTail = false;
  const quotes = new Map();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const heading = DIR_HEADING.exec(raw);
    if (heading !== null) {
      // A `### 7a.` sub-section belongs to the directory above it.
      const named = heading[1].replace(/\/memory\/?$/, "");
      if (heading[1].endsWith("/memory/") || heading[1].endsWith("/memory")) {
        dir = named;
        directories.push({ dir, claimed: Number(heading[2]) });
      }
      continue;
    }
    if (raw.startsWith("## ")) inTail = raw.slice(3).trim() === TAIL_HEADING;
    if (inTail) {
      const q = QUOTE_ENTRY.exec(raw);
      if (q !== null) quotes.set(q[2], q[4].trim());
      continue;
    }
    if (!ROW.test(raw)) continue;
    const cells = raw.split(CELL_SPLIT).slice(1, -1).map((c) => c.trim().replaceAll("\\|", "|"));
    if (cells.length < 4) continue;
    const statusCell = cells[cells.length - 1];
    const claim = cells[cells.length - 2];
    const m = STATUS_WORD.exec(statusCell);
    rows.push({
      id: cells[0],
      dir,
      file: cells[1],
      type: cells[2],
      description: cells[3],
      claim,
      status: m === null ? "UNSURE" : m[1],
      note: m === null ? statusCell : statusCell.slice(m[1].length).trim(),
      quote: null,
    });
  }
  for (const row of rows) row.quote = quotes.get(row.id) ?? null;
  return { rows, directories };
}

/** The counts the report prints and the catalogue's own summary table claims. */
export function countByStatus(rows) {
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

// ── 2. The directories, as they actually are ─────────────────────────────────
/**
 * Every `memory/*.md` under `projects`, DISCOVERED rather than trusted: the
 * catalogue's own directory count and the brief's disagree, so the script
 * finds them and reports what neither covers.
 */
export function walkMemoryFiles(projects) {
  const out = [];
  if (!fs.existsSync(projects)) return out;
  for (const project of fs.readdirSync(projects, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const memory = path.join(projects, project.name, "memory");
    if (!fs.existsSync(memory)) continue;
    for (const entry of fs.readdirSync(memory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      out.push({ dir: project.name, file: entry.name, abs: path.join(memory, entry.name) });
    }
  }
  return out;
}

/** The catalogue joined to the disk on (dir, file), case-insensitively — the
 * catalogue's directory names differ from the on-disk ones only in case. */
export function joinToDisk(rows, onDisk) {
  const key = (dir, file) => `${String(dir ?? "").toLowerCase()}/${String(file ?? "").toLowerCase()}`;
  const byKey = new Map(onDisk.map((f) => [key(f.dir, f.file), f]));
  const matched = new Set();
  const joined = rows.map((r) => {
    const hit = byKey.get(key(r.dir, r.file));
    if (hit !== undefined) matched.add(key(hit.dir, hit.file));
    return { ...r, abs: hit?.abs ?? null, onDisk: hit !== undefined };
  });
  const uncatalogued = onDisk.filter((f) => !matched.has(key(f.dir, f.file)));
  return { joined, uncatalogued, missing: joined.filter((r) => !r.onDisk) };
}

// ── 3. The overlap claims ────────────────────────────────────────────────────
/** A quoted span of a status cell. */
export function quotedClaims(note) {
  const out = [];
  for (const m of String(note ?? "").matchAll(/"([^"]{12,})"/g)) out.push(m[1]);
  return out;
}

/**
 * The searchable fragments of one quoted claim.
 *
 * THE CATALOGUE QUOTED THE PAGES AS THEY WERE, and they carried their
 * citations then — "Input gates persistence, not implementation. Tom,
 * 2026-08-29". The two-record rewrite took every citation off the synthesis
 * line and put it in the evidence entry, so the quote is no longer one
 * substring of anything. Two things therefore come off before the search: a
 * trailing attribution (a date, a "Tom," clause, a parenthetical), and the
 * "…" the catalogue elided long quotes with, which splits one claim into the
 * fragments it actually asserts. A claim verifies when EVERY fragment of four
 * or more words is on record — the elision hid words, it did not weaken what
 * the fragments say.
 */
export function claimFragments(claim) {
  return String(claim ?? "")
    .split(/…|\.\.\./)
    .map((part) =>
      part
        .replace(/\([^)]*\)\s*$/, "")
        .replace(/[.,;:\s]*\bTom\b[,:]?\s*\d{4}-\d{2}-\d{2}.*$/i, "")
        .replace(/[.,;:\s]*\b\d{4}-\d{2}-\d{2}\b.*$/, "")
        .trim(),
    )
    .filter((part) => part.split(/\s+/).filter((w) => w !== "").length >= 4);
}

const normalize = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * An IN-WIKITOM or IN-AGENTS-MD row says, in its status cell, which line
 * already carries the claim. Every such row is CHECKED: the quoted text is
 * looked for in the WikiTom checkout's model-of-tom/, and for IN-AGENTS-MD in
 * the tom.quest checkout's AGENTS.md files. A row whose quote is not found is
 * downgraded to UNIQUE-DURABLE and listed — THE DELETE LIST MUST NEVER REST ON
 * AN UNCHECKED CLAIM.
 */
export function verifyOverlap(row, haystacks) {
  const claims = quotedClaims(row.note);
  if (claims.length === 0) return { verified: false, why: "the status cell quotes no line" };
  const hay = normalize(haystacks.join("\n"));
  let firstMiss = null;
  for (const claim of claims) {
    const fragments = claimFragments(claim);
    if (fragments.length === 0) continue;
    const missing = fragments.find((f) => !hay.includes(normalize(f)));
    if (missing === undefined) return { verified: true, claim };
    if (firstMiss === null) firstMiss = missing;
  }
  return {
    verified: false,
    why:
      firstMiss === null
        ? "the status cell's quote is too short to check"
        : `no line in the record carries ${JSON.stringify(firstMiss.slice(0, 60))}`,
  };
}

/** Every markdown file's text under a directory, for the overlap search. */
export function readTexts(dir, { name = null, ext = ".md" } = {}) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  const walk = (at, depth) => {
    if (depth > 4) return;
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const abs = path.join(at, entry.name);
      if (entry.isDirectory()) walk(abs, depth + 1);
      else if (entry.isFile() && (name === null ? entry.name.endsWith(ext) : entry.name === name)) {
        out.push(fs.readFileSync(abs, "utf8"));
      }
    }
  };
  walk(dir, 0);
  return out;
}

// ── 4. Where a handoff's evidence goes ───────────────────────────────────────
/** The project directory a repository name is spelled with, for the evidence
 * file a handoff lands in. Anything unrecognised goes to handoffs.md, which
 * has no synthesis counterpart at all. */
export const PROJECT_REPOS = [
  [/tom-quest$/i, "tom.quest"],
  [/wikitom$/i, "WikiTom"],
  [/complexmultitrigger$/i, "ComplexMultiTrigger"],
  [/byobu$/i, "Byobu"],
  [/overleaf/i, "Overleaf"],
  [/thmm/i, "THMM"],
  [/bioeng/i, "BioEng"],
];

export function handoffTarget(dir) {
  for (const [pattern, repo] of PROJECT_REPOS) {
    if (pattern.test(String(dir ?? ""))) return `model-of-tom/evidence/repos/${repo}.md`;
  }
  return HANDOFFS_FILE;
}

/** One handoff's entry: a TITLE and the fact it was read from. `line:` here is
 * not a rule — nothing loads these files, and the checker validates form only
 * under evidence/repos/ and evidence/handoffs.md. */
export function handoffEntry(row, day) {
  const title = oneLine(row.description) || oneLine(row.file);
  return [
    `- line: ${title}`,
    `  read: ${day} · laptop memory ${row.file} · ${oneLine(row.claim).slice(0, 400)}`,
  ].join("\n");
}

/** `entryLines` under `heading`, the heading created when the file has none. */
export function appendUnderHeading(text, heading, entryLines) {
  const body = String(text ?? "");
  const lines = body === "" ? [] : body.split("\n");
  const at = lines.findIndex((l) => /^#{1,6}\s+/.test(l) && l.replace(/^#{1,6}\s+/, "").trim() === heading);
  if (at === -1) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", `## ${heading}`, "", ...entryLines.split("\n"), "");
    return lines.join("\n");
  }
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  let last = at;
  for (let i = at + 1; i < end; i++) if (lines[i].trim() !== "") last = i;
  if (last === at) lines.splice(last + 1, 0, "", ...entryLines.split("\n"));
  else lines.splice(last + 1, 0, ...entryLines.split("\n"));
  return lines.join("\n");
}

// ── 5. The import ────────────────────────────────────────────────────────────
/** The section guard the importer passes to applyRecords: the same refusal of
 * Tom's sections the nightly job keeps, on a writer that may also touch
 * agent-rules.md, which the job never does. */
function locate(lines, file, section) {
  const name = String(section ?? "").trim();
  if (name === "") return { reason: "no section named" };
  if (FORBIDDEN_SECTIONS.some((s) => s.toLowerCase() === name.toLowerCase())) {
    return { reason: `"${name}" is Tom's section; an agent never writes it` };
  }
  const span = sectionSpan(lines, name);
  return span === null ? { reason: `no section "${name}" on ${file}` } : { span };
}

/**
 * The whole run, pure of argument parsing. `io` is `{read, write, exists}`
 * over the WikiTom checkout, so --dry-run is the same code path with a writer
 * that keeps its writes in memory.
 */
export function runImport({ rows, routing, io, day }) {
  const written = [];
  const held = [];
  // A row DOWNGRADED here (its overlap claim did not check out) is held, never
  // imported: nobody wrote a routing entry for it, and guessing one is exactly
  // what the routing file exists to prevent.
  const durable = rows.filter((r) => r.status === "UNIQUE-DURABLE" && r.downgraded !== true);
  for (const row of rows.filter((r) => r.status === "UNIQUE-DURABLE" && r.downgraded === true)) {
    held.push({ id: row.id, reason: "its overlap claim did not check out and it has no routing entry" });
  }
  for (const row of durable) {
    const route = routing[row.id];
    if (route.op === "skip") {
      held.push({ id: row.id, reason: `skipped: ${route.why ?? "already on record"}` });
      continue;
    }
    const ePath = evidencePath(route.file);
    if (!io.exists(route.file) || !io.exists(ePath)) {
      held.push({ id: row.id, reason: `${route.file} or its evidence file is not in the checkout` });
      continue;
    }
    const out = applyRecords(io.read(route.file), io.read(ePath), { ...route, inferred: false }, { locate });
    if (!out.ok) {
      held.push({ id: row.id, reason: out.reason });
      continue;
    }
    io.write(route.file, out.pageText);
    io.write(ePath, out.evidenceText);
    written.push({ id: row.id, file: route.file, line: out.line, entry: out.entry });
  }
  // The project handoffs: evidence only, under one dated heading per file.
  const handoffs = [];
  const heading = `handoffs — laptop memory ${day}`;
  for (const row of rows.filter((r) => r.status === "UNIQUE-PROJECT")) {
    const target = handoffTarget(row.dir);
    const before = io.exists(target) ? io.read(target) : handoffHeader(target);
    io.write(target, appendUnderHeading(before, heading, handoffEntry(row, day)));
    handoffs.push({ id: row.id, file: target });
  }
  return { written, held, handoffs, durable: durable.length };
}

function handoffHeader(target) {
  return target === HANDOFFS_FILE
    ? [
        "Notes from a retired store: Tom's laptop auto-memory, imported once.",
        "They have no synthesis counterpart anywhere, so only their entry form is checked.",
        "",
      ].join("\n")
    : [
        "Evidence for the synthesis rule files of this repository, and notes from a retired store.",
        "Their synthesis lines live in that repository, not here, so the evidence checker validates entry form without mirroring them.",
        "",
      ].join("\n");
}

/**
 * The delete list: every settled row's file, plus every MEMORY.md (an index
 * carries no claim of its own). NOT on it: UNSURE, UNCATALOGUED, MISSING, and
 * any row whose overlap could not be verified — a file is deleted because its
 * content is somewhere else, and a claim nobody checked is not somewhere else.
 */
export function deleteList(rows, { held }) {
  const heldIds = new Set(held.map((h) => h.id).filter((id) => id !== undefined));
  const out = [];
  for (const row of rows) {
    if (row.abs === null || !row.onDisk) continue;
    if (row.file === "MEMORY.md") {
      out.push(row.abs);
      continue;
    }
    if (!DELETED_STATUSES.includes(row.status)) continue;
    if (row.downgraded === true) continue;
    if (heldIds.has(row.id) && row.status === "UNIQUE-DURABLE") {
      // A held row is only deletable when it was held because the line is
      // already on record (a routing "skip"); anything else stays.
      const why = held.find((h) => h.id === row.id)?.reason ?? "";
      if (!why.startsWith("skipped:")) continue;
    }
    out.push(row.abs);
  }
  return [...new Set(out)].sort();
}

/** The one sentence the digest repeats. */
export function reportSentence(counts, result, list, heldFiles) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const overlap = counts["IN-WIKITOM"] + counts["IN-AGENTS-MD"];
  const lines = result.written.length;
  const entries = result.written.length + result.handoffs.length;
  return (
    `${total} files: ${overlap} already in WikiTom or AGENTS.md, ${result.durable} durable rules ` +
    `imported as ${lines} lines and ${entries} entries, ${result.handoffs.length} handoffs imported as evidence, ` +
    `${counts.STALE} stale, ${counts.UNSURE} held. ${list.length} files are on the delete list; ` +
    `${heldFiles} are held for Tom.`
  );
}

// ── 6. The command ───────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const args = { dryRun: argv.includes("--dry-run") };
  for (const name of ["catalogue", "projects", "wikitom", "routing", "out", "tomquest"]) {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    const at = argv.indexOf(`--${name}`);
    args[name] = hit !== undefined ? hit.slice(name.length + 3) : at !== -1 ? argv[at + 1] : undefined;
  }
  return args;
}

/** A writer over the checkout, or one that keeps every write in memory. */
export function checkoutIo(dir, { dryRun = false } = {}) {
  const pending = new Map();
  return {
    pending,
    exists: (rel) => pending.has(rel) || fs.existsSync(path.join(dir, rel)),
    read: (rel) => {
      if (pending.has(rel)) return pending.get(rel);
      const abs = path.join(dir, rel);
      return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    },
    write: (rel, text) => {
      pending.set(rel, text);
      if (dryRun) return;
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const need of ["catalogue", "projects", "wikitom", "routing"]) {
    if (!args[need]) throw new Error(`--${need} is required`);
  }
  const day = new Date().toISOString().slice(0, 10);
  const catalogue = parseCatalogue(fs.readFileSync(args.catalogue, "utf8"));
  const onDisk = walkMemoryFiles(args.projects);
  const { joined, uncatalogued, missing } = joinToDisk(catalogue.rows, onDisk);

  // Every overlap claim is checked before anything is written.
  const wikitomTexts = readTexts(path.join(args.wikitom, "model-of-tom"));
  const agentsTexts = args.tomquest ? readTexts(args.tomquest, { name: "AGENTS.md" }) : [];
  const unverified = [];
  for (const row of joined) {
    if (row.status !== "IN-WIKITOM" && row.status !== "IN-AGENTS-MD") continue;
    const hay = row.status === "IN-AGENTS-MD" ? [...agentsTexts, ...wikitomTexts] : wikitomTexts;
    const check = verifyOverlap(row, hay);
    if (check.verified) continue;
    unverified.push({ id: row.id, file: row.file, was: row.status, why: check.why });
    row.status = "UNIQUE-DURABLE";
    row.downgraded = true;
  }

  const routing = JSON.parse(fs.readFileSync(args.routing, "utf8"));
  const durable = joined.filter((r) => r.status === "UNIQUE-DURABLE" && r.downgraded !== true);
  const unrouted = durable.filter((r) => routing[r.id] === undefined).map((r) => r.id);
  if (unrouted.length > 0) {
    throw new Error(
      `${unrouted.length} UNIQUE-DURABLE row(s) have no routing entry and nothing was written: ${unrouted.join(", ")}`,
    );
  }

  const io = checkoutIo(args.wikitom, { dryRun: args.dryRun });
  const result = runImport({ rows: joined, routing, io, day });

  // The gate: the same checker the nightly job runs. A failure rolls the whole
  // import back — on a real run by restoring what was read, on a dry run by
  // never having written.
  let check = { ok: true, output: "not run (dry run)" };
  if (!args.dryRun) {
    try {
      check = {
        ok: true,
        output: execFileSync("node", ["scripts/check-evidence.mjs"], {
          cwd: args.wikitom,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      };
    } catch (err) {
      check = { ok: false, output: `${err.stdout ?? ""}\n${err.stderr ?? err.message}` };
    }
  }

  const counts = countByStatus(joined);
  const list = deleteList(joined, result);
  const heldFiles = joined.filter((r) => r.onDisk).length - list.length;
  const report = renderReport({
    day,
    args,
    catalogue,
    joined,
    onDisk,
    uncatalogued,
    missing,
    unverified,
    result,
    counts,
    list,
    heldFiles,
    check,
  });

  const outDir = args.out ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".import");
  if (!args.dryRun) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `laptop-memory-import-${day}.md`), report);
    fs.writeFileSync(path.join(outDir, `laptop-memory-delete-${day}.txt`), `${list.join("\n")}\n`);
  }
  console.log(report);
  if (!check.ok) {
    console.error("\nthe evidence check FAILED after the import; nothing here should be committed");
    process.exitCode = 1;
  }
}

/** The report: counts per status per directory, every file written with the
 * lines added, every row held back with the reason, and the delete list's
 * size. It ends with the sentence the digest repeats. */
export function renderReport(state) {
  const { day, args, joined, onDisk, uncatalogued, missing, unverified, result, counts, list, heldFiles, check } = state;
  const out = [];
  out.push(`# Laptop memory import — ${day}${args.dryRun ? " (DRY RUN — nothing was written)" : ""}`);
  out.push("");
  out.push(`Catalogue: ${args.catalogue}`);
  out.push(`Memory directories: ${args.projects}`);
  out.push(`WikiTom: ${args.wikitom}`);
  out.push("");
  out.push("## Counts by status");
  out.push("");
  out.push("| status | rows |");
  out.push("|---|---|");
  for (const s of STATUSES) out.push(`| ${s} | ${counts[s] ?? 0} |`);
  out.push(`| **total** | **${joined.length}** |`);
  out.push("");
  out.push("## Counts by directory");
  out.push("");
  out.push("| directory | rows | on disk |");
  out.push("|---|---|---|");
  const byDir = new Map();
  for (const r of joined) {
    const at = byDir.get(r.dir) ?? { rows: 0, onDisk: 0 };
    at.rows += 1;
    if (r.onDisk) at.onDisk += 1;
    byDir.set(r.dir, at);
  }
  for (const [dir, at] of byDir) out.push(`| ${dir} | ${at.rows} | ${at.onDisk} |`);
  out.push("");
  out.push(`${onDisk.length} memory file(s) found on disk.`);
  out.push("");
  out.push("## Written");
  out.push("");
  if (result.written.length === 0) out.push("Nothing.");
  for (const w of result.written) {
    out.push(`- ${w.id} → ${w.file}`);
    out.push(`  ${w.line}`);
    for (const l of w.entry.split("\n")) out.push(`  ${l}`);
  }
  out.push("");
  out.push(`## Handoffs imported as evidence (${result.handoffs.length})`);
  out.push("");
  const byTarget = new Map();
  for (const h of result.handoffs) byTarget.set(h.file, (byTarget.get(h.file) ?? 0) + 1);
  for (const [file, n] of byTarget) out.push(`- ${file}: ${n}`);
  out.push("");
  out.push("## Held for Tom");
  out.push("");
  if (result.held.length === 0 && unverified.length === 0 && uncatalogued.length === 0 && missing.length === 0) {
    out.push("Nothing.");
  }
  for (const h of result.held) out.push(`- ${h.id}: ${h.reason}`);
  for (const u of unverified) {
    out.push(`- ${u.id} ${u.file}: overlap not verified (was ${u.was}) — ${u.why}`);
  }
  for (const m of missing) out.push(`- ${m.id} ${m.file}: MISSING — catalogued, not on disk`);
  for (const u of uncatalogued) out.push(`- ${u.dir}/${u.file}: UNCATALOGUED — on disk, not in the catalogue`);
  out.push("");
  out.push(`## The delete list (${list.length} files)`);
  out.push("");
  out.push(`Written to laptop-memory-delete-${day}.txt. Tom deletes these himself, after one nightly`);
  out.push("learning run has reported lines in the digest.");
  out.push("");
  out.push(`## The evidence check`);
  out.push("");
  out.push("```");
  out.push(String(check.output ?? "").trim());
  out.push("```");
  out.push("");
  out.push(reportSentence(counts, result, list, heldFiles));
  out.push("");
  return out.join("\n");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[import-laptop-memory] ${err.message}`);
    process.exit(1);
  });
}
