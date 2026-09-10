#!/usr/bin/env node
// check-evidence.mjs — the two records cannot drift.
//
// Every bullet line in a synthesis file under model-of-tom/ (outside the
// sections Tom writes himself) has one entry in model-of-tom/evidence/<same
// path>, under the same heading, whose `line:` repeats the bullet verbatim.
// Every entry points back at a line that still exists. An entry carries one
// or more of four fields: `said:` (his words verbatim), `paraphrase:` (his
// statement from a cited source, not verbatim), `read:` (a fact read from
// code, the record, a mirror or a document) and `rests on:` (an agent
// inference). A line whose entry has any `rests on:` must end "(inferred)",
// and an inferred line's entry has `rests on:` only. Repository-rule evidence
// under evidence/repos/ has no local synthesis counterpart, so only its entry
// form is checked (it may also use `dropped:`). Exit 1 on any failure, with
// each one printed.
//
// Usage: node scripts/check-evidence.mjs   (from the WikiTom root)

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const mot = join(root, "model-of-tom");

const SYNTHESIS = [
  "agent-rules.md",
  "intent.md",
  "ground.md",
  "writing.md",
  "priorities.md",
  "schedule.md",
  ...readdirSync(join(mot, "areas"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `areas/${f}`),
];

// Sections an agent never writes; they carry his words and are not checked.
const TOM_ONLY = new Set(["Directions"]);

const FIELDS = ["said", "paraphrase", "read", "rests on", "dropped"];

const failures = [];
const fail = (msg) => failures.push(msg);

function headingText(line) {
  const m = /^#{1,6}\s+(.*?)\s*$/.exec(line);
  return m ? m[1] : null;
}

// Synthesis: [{heading, text}] for every bullet outside Tom-only sections.
function parseSynthesis(path) {
  const out = [];
  let heading = null;
  let skipping = false;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const h = headingText(raw);
    if (h !== null) {
      heading = h;
      skipping = TOM_ONLY.has(h);
      continue;
    }
    if (skipping) continue;
    const m = /^- (.*\S)\s*$/.exec(raw);
    if (m) out.push({ heading, text: m[1] });
  }
  return out;
}

// Evidence: [{heading, text, said, paraphrase, read, rests, dropped}] per entry.
function parseEvidence(path) {
  const out = [];
  let heading = null;
  let cur = null;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const h = headingText(raw);
    if (h !== null) {
      heading = h;
      cur = null;
      continue;
    }
    const line = /^- line: (.*\S)\s*$/.exec(raw);
    if (line) {
      cur = { heading, text: line[1], said: 0, paraphrase: 0, read: 0, rests: 0, dropped: 0 };
      out.push(cur);
      continue;
    }
    const field = /^\s+(said|paraphrase|read|rests on|dropped): /.exec(raw);
    if (cur && field) cur[field[1] === "rests on" ? "rests" : field[1]]++;
    else if (new RegExp(`^- (?:${FIELDS.join("|")}): `).test(raw))
      fail(`${relative(root, path)}: evidence field has no line: ${raw.trim()}`);
    else if (/^- \S/.test(raw))
      fail(`${relative(root, path)}: unrecognised evidence entry: ${raw.trim()}`);
    else if (cur && /^\s+\S/.test(raw))
      fail(`${relative(root, path)}: unrecognised entry line: ${raw.trim()}`);
  }
  return out;
}

function markdownFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

const key = (e) => `${e.heading} ${e.text}`;
const supported = (e) => e.said + e.paraphrase + e.read;

for (const rel of SYNTHESIS) {
  const sPath = join(mot, rel);
  const ePath = join(mot, "evidence", rel);
  const sRel = `model-of-tom/${rel}`;
  const eRel = `model-of-tom/evidence/${rel}`;
  if (!existsSync(ePath)) {
    fail(`${sRel}: no evidence file ${eRel}`);
    continue;
  }
  const lines = parseSynthesis(sPath);
  const entries = parseEvidence(ePath);
  const byKey = new Map();
  for (const e of entries) {
    if (byKey.has(key(e))) fail(`${eRel}: duplicate entry under "${e.heading}": ${e.text}`);
    byKey.set(key(e), e);
  }
  const seen = new Set();
  for (const l of lines) {
    if (l.heading === null) {
      fail(`${sRel}: bullet before any heading: ${l.text}`);
      continue;
    }
    const e = byKey.get(key(l));
    if (!e) {
      fail(`${sRel}: no evidence entry under "${l.heading}" for: ${l.text}`);
      continue;
    }
    seen.add(key(l));
    const inferred = / \(inferred\)$/.test(l.text);
    if (inferred && supported(e) > 0)
      fail(`${eRel}: an inferred line carries said:, paraphrase: or read: — ${l.text}`);
    if (inferred && e.rests === 0)
      fail(`${eRel}: an inferred line has no rests on: — ${l.text}`);
    if (!inferred && e.rests > 0)
      fail(`${eRel}: a rests on: entry whose line is not marked (inferred) — ${l.text}`);
    if (e.dropped > 0)
      fail(`${eRel}: dropped: belongs only under evidence/repos/ — ${l.text}`);
    if (supported(e) + e.rests === 0)
      fail(`${eRel}: entry has none of said:, paraphrase:, read: or rests on: — ${l.text}`);
  }
  for (const e of entries) {
    if (!seen.has(key(e)))
      fail(`${eRel}: entry under "${e.heading}" matches no synthesis line: ${e.text}`);
  }
  console.log(`${sRel}: ${lines.length} lines, ${entries.length} entries`);
}

// These evidence files point to synthesis in other repositories. Do not
// mirror them against model-of-tom/; validate only their entry structure.
for (const path of markdownFiles(join(mot, "evidence", "repos"))) {
  const rel = relative(root, path);
  const entries = parseEvidence(path);
  for (const entry of entries) {
    if (entry.heading === null)
      fail(`${rel}: entry before any heading: ${entry.text}`);
    if (supported(entry) + entry.rests + entry.dropped === 0)
      fail(`${rel}: entry has none of said:, paraphrase:, read:, rests on: or dropped: — ${entry.text}`);
  }
  console.log(`${rel}: ${entries.length} repository entries`);
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("\nevidence check: ok");
