import fs from "node:fs";
import path from "node:path";

// Pulls the Perfumer's Bench data artifacts out of a Byobu checkout into
// tom.quest. Byobu owns the pipeline (Joe's ground-truth PDFs ->
// transcription.py -> compile.py / extract_art.py) and emits ONLY data
// artifacts; tom.quest owns this copy step. Nothing here writes back into
// Byobu, and no TypeScript is generated — the .ts wrappers in
// app/perfume/{data,lib} are hand-written and just import the JSON.
//
//   app/data.json     -> app/perfume/data/base.json
//   app/emblems.json  -> app/perfume/data/emblems.json
//   app/<art-dir>/*.png (if present) -> public/perfume/ingredients/
//
// Everything is validated before anything is written; a validation failure
// exits nonzero and leaves the existing files untouched.
//
// Usage:  node scripts/sync-perfume-data.mjs [BYOBU_CHECKOUT_DIR]
//         (defaults to C:/Users/heffn/Desktop/Byobu)

const ROOT = process.cwd();
const BYOBU_DIR = path.resolve(process.argv[2] ?? "C:/Users/heffn/Desktop/Byobu");

const SRC_DATA = path.join(BYOBU_DIR, "app", "data.json");
const SRC_EMBLEMS = path.join(BYOBU_DIR, "app", "emblems.json");

const DST_BASE = path.join(ROOT, "app", "perfume", "data", "base.json");
const DST_EMBLEMS = path.join(ROOT, "app", "perfume", "data", "emblems.json");
const DST_ART = path.join(ROOT, "public", "perfume", "ingredients");

// Candidate directories a Byobu checkout might drop ingredient crest PNGs into.
// extract_art.py --ingredients writes wherever it's pointed; these are the
// obvious spots to look when syncing an existing checkout.
const ART_DIR_CANDIDATES = ["ingredients", "art/ingredients", "art", "ingredient-art"];

// Expected shape of the base data — the contract app/perfume/data/base.ts and
// the engine rely on. Named-frequency and perfume counts grow over time, so
// perfumes is a floor, not an exact count.
const EXPECT = {
  fundamentals: 9,
  named: 17,
  ingredients: 96,
  perfumesMin: 40,
};

function fail(msg) {
  console.error(`sync-perfume-data: ${msg}`);
  process.exit(1);
}

function readJson(file, label) {
  if (!fs.existsSync(file)) fail(`${label} not found at ${file}`);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    fail(`could not read ${label} at ${file}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`${label} at ${file} is not valid JSON: ${err.message}`);
  }
}

function requireArray(obj, key, expectedLen, label) {
  const v = obj[key];
  if (!Array.isArray(v)) fail(`${label}: "${key}" is missing or not an array`);
  if (expectedLen != null && v.length !== expectedLen) {
    fail(`${label}: expected ${expectedLen} ${key}, found ${v.length}`);
  }
  return v;
}

// ── validate base.json ───────────────────────────────────────────────────────

const base = readJson(SRC_DATA, "data.json");
const fundamentals = requireArray(base, "fundamentals", EXPECT.fundamentals, "data.json");
const named = requireArray(base, "named", EXPECT.named, "data.json");
requireArray(base, "ingredients", EXPECT.ingredients, "data.json");
const perfumes = requireArray(base, "perfumes", null, "data.json");
if (perfumes.length < EXPECT.perfumesMin) {
  fail(`data.json: expected at least ${EXPECT.perfumesMin} perfumes, found ${perfumes.length}`);
}

const namedIds = named.map((n) => n?.id).filter((id) => typeof id === "string");
if (namedIds.length !== named.length) {
  fail(`data.json: every named frequency must have a string "id"`);
}

// ── validate emblems.json — must cover every named frequency ─────────────────

const emblems = readJson(SRC_EMBLEMS, "emblems.json");
if (emblems === null || typeof emblems !== "object" || Array.isArray(emblems)) {
  fail(`emblems.json: expected an object keyed by named-frequency id`);
}
const missingEmblems = namedIds.filter((id) => !(id in emblems));
if (missingEmblems.length > 0) {
  fail(`emblems.json: missing emblem entries for ${missingEmblems.join(", ")}`);
}
for (const id of namedIds) {
  const e = emblems[id];
  if (!e || typeof e !== "object" || Array.isArray(e)) {
    fail(`emblems.json: entry "${id}" must be an object`);
  }
  if (typeof e.icon !== "string" || typeof e.d !== "string") {
    fail(`emblems.json: entry "${id}" must have string "icon" and "d" fields`);
  }
  const extraKeys = Object.keys(e).filter((k) => k !== "icon" && k !== "d");
  if (extraKeys.length > 0) {
    fail(`emblems.json: entry "${id}" must be exactly {icon, d}, found extra field(s): ${extraKeys.join(", ")}`);
  }
}

// ── locate optional ingredient art ───────────────────────────────────────────

function findArtDir() {
  for (const rel of ART_DIR_CANDIDATES) {
    const dir = path.join(BYOBU_DIR, "app", rel);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    const pngs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".png"));
    if (pngs.length > 0) return { dir, pngs };
  }
  return null;
}

const art = findArtDir();

// ── write everything (validation passed) ─────────────────────────────────────

fs.mkdirSync(path.dirname(DST_BASE), { recursive: true });
fs.copyFileSync(SRC_DATA, DST_BASE);
fs.copyFileSync(SRC_EMBLEMS, DST_EMBLEMS);

let copiedPngs = 0;
if (art) {
  fs.mkdirSync(DST_ART, { recursive: true });
  for (const png of art.pngs) {
    fs.copyFileSync(path.join(art.dir, png), path.join(DST_ART, png));
    copiedPngs += 1;
  }
}

// ── summary ──────────────────────────────────────────────────────────────────

const rel = (p) => path.relative(ROOT, p) || p;
console.log("sync-perfume-data: OK");
console.log(`  source:      ${BYOBU_DIR}`);
console.log(`  base.json    -> ${rel(DST_BASE)} (${fundamentals.length} fundamentals, ${named.length} named, ${base.ingredients.length} ingredients, ${perfumes.length} perfumes)`);
console.log(`  emblems.json -> ${rel(DST_EMBLEMS)} (${Object.keys(emblems).length} emblems, all ${namedIds.length} named covered)`);
if (art) {
  console.log(`  art          -> ${rel(DST_ART)} (${copiedPngs} PNGs from ${rel(art.dir)})`);
} else {
  console.log(`  art          -> none found in Byobu checkout (skipped)`);
}
