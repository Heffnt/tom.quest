// The turing-api service is configured entirely by one file on the login node
// (~/tom.quest/turing-api/.env), which nothing in CI can see. This check keeps the
// repo an honest description of it, by enforcing three properties:
//
//   1. One template. secrets/turing-api.env.example is it; a second *.env.example
//      under turing-api/ is how the env came to be half-documented in two places.
//   2. Declared. Every env name turing-api/ Python reads appears in the template,
//      so the deployed .env can be reconstructed from the repo alone.
//   3. One read site per name. A name read in two modules is a setting that can
//      hold two values — which is exactly how the CMT checkout ended up named both
//      BOOLEAN_BACKDOOR_REPO (forge.py) and BOOLBACK_BUILDER_REPO_DIR
//      (boolback_snapshot.py), pointing two surfaces at two checkouts silently.
//
// The reverse direction is checked too: a name declared in the template that
// nothing under turing-api/ reads (Python or shell) is stale documentation.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const API_DIR = path.join(ROOT, "turing-api");
const TEMPLATE = path.join(ROOT, "secrets", "turing-api.env.example");
const TEMPLATE_REL = path.normalize(path.relative(ROOT, TEMPLATE));

// os.environ.get("NAME") / os.environ["NAME"] / os.getenv("NAME"), single or double quoted.
const PY_ENV_READ = /os\.(?:environ\.get\(|environ\[|getenv\()\s*["']([A-Z][A-Z0-9_]*)["']/g;
// A declaration line: NAME=... at the start of a line, optionally commented out
// (a commented line documents a var whose default the cluster runs with).
const TEMPLATE_DECL = /^#?\s*([A-Z][A-Z0-9_]*)=/;

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

const violations = [];

if (!fs.existsSync(TEMPLATE)) {
  console.error(`Turing env check failed:\n  ${TEMPLATE_REL} is missing.`);
  process.exit(1);
}

const apiFiles = fs.existsSync(API_DIR) ? walk(API_DIR) : [];

// 1. One template.
for (const file of apiFiles) {
  if (file.endsWith(".env.example")) {
    violations.push(
      `${path.relative(ROOT, file)}: the turing-api env has one template, ${TEMPLATE_REL}. ` +
        `Move these lines there and delete this file.`,
    );
  }
}

// Collect reads: name -> [sites]
const readSites = new Map();
for (const file of apiFiles) {
  if (!file.endsWith(".py") || file.endsWith("_test.py")) continue;
  const relative = path.relative(ROOT, file);
  // Matched against the whole file, not line by line: the call and its name
  // argument are often on separate lines (black-style wrapping).
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(PY_ENV_READ)) {
    const name = match[1];
    const line = source.slice(0, match.index).split("\n").length;
    if (!readSites.has(name)) readSites.set(name, []);
    readSites.get(name).push(`${relative}:${line}`);
  }
}

const declared = new Set();
for (const line of fs.readFileSync(TEMPLATE, "utf8").split("\n")) {
  const match = TEMPLATE_DECL.exec(line);
  if (match) declared.add(match[1]);
}

// 2. Declared, and 3. one read site per name.
for (const [name, sites] of [...readSites].sort()) {
  if (!declared.has(name)) {
    violations.push(
      `${name}: read at ${sites.join(", ")} but not declared in ${TEMPLATE_REL}.`,
    );
  }
  if (sites.length > 1) {
    violations.push(
      `${name}: read at ${sites.length} sites (${sites.join(", ")}). ` +
        `Read it once — dirs.py is the home for shared roots — and import the value.`,
    );
  }
}

// Reverse: a declared name nothing reads. Shell wrappers (sbatch/sh) read some of
// them on the compute node, so they count as readers too.
const shellText = apiFiles
  .filter((file) => /\.(sbatch|sh)$/.test(file))
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
for (const name of [...declared].sort()) {
  if (readSites.has(name)) continue;
  if (new RegExp(`\\b${name}\\b`).test(shellText)) continue;
  violations.push(
    `${name}: declared in ${TEMPLATE_REL} but nothing under turing-api/ reads it.`,
  );
}

if (violations.length > 0) {
  console.error("Turing env check failed:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`Turing env check passed (${readSites.size} vars read, ${declared.size} declared).`);
