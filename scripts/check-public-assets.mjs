// Census: every file under public/, and what (if anything) reaches it.
//
// Next.js publishes each file under public/ at the site root under its own
// name — public/images/logo-black-transparent.svg answers a request at
// /images/logo-black-transparent.svg — with no import statement anywhere. A
// file there can therefore be live on the web while nothing in the repository
// mentions it, which is why a sweep that follows imports cannot see this class
// of file at all. This script is that missing sweep.
//
// Three ways a file under public/ can be reached, and this script decides
// which one applies to each file:
//
//   static    Some file under a SERVING_ROOT contains the file's web path
//             (/images/logo.svg), its repository path (public/images/logo.svg)
//             or its bare filename (logo.svg) as a literal string.
//
//   dynamic   A rule in DYNAMIC_READERS below covers it: application code
//             builds the path at run time from data, so the filename never
//             appears as a literal anywhere. Each rule names the exact reader
//             file and the exact expression, and this script re-reads that
//             file — if the expression is gone, the rule stops applying and
//             the files it covered become unreferenced. Each rule also
//             enumerates the names it can produce, so a stray file sitting in
//             a covered directory is still reported.
//
//   (none)    Nothing reaches it. It is still served: the deployed site
//             answers a request for it with 200. Deleting it is therefore a
//             decision about which URLs stop working, not only about
//             repository weight. Run with --live to check what the deployed
//             site currently answers for every file.
//
// A file named only by a generator script (scripts/, worker/) is NOT reachable.
// scripts/download-cube-cards.mjs writes public/data/cube-cards.json and is the
// only file in the repository that mentions it; being written is not being
// read, and no page fetches it.
//
// KNOWN_UNREFERENCED names the files that were already unreferenced when this
// census was written, each with the reason, so that adding this check does not
// turn CI red before those files are ruled on. A new unreferenced file fails
// the check. An entry naming a file that no longer exists also fails, so
// deleting a file forces its entry out of the map and the map cannot drift.
//
// This script is the census record: it is re-derived from the working tree on
// every run, so unlike a written list it cannot go stale.
//
// Usage:
//   node scripts/check-public-assets.mjs           classify, report unreferenced
//   node scripts/check-public-assets.mjs --list    also print every file and its reacher
//   node scripts/check-public-assets.mjs --live    also probe the deployed site
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SITE = "https://www.tom.quest";

// Directories whose code can put a file under public/ on screen. A mention
// anywhere else — a generator script, a note in a markdown document — records
// the file's existence without making it reachable.
const SERVING_ROOTS = ["app/", "convex/", "e2e/"];

// repository path -> why it is tolerated as unreferenced.
const KNOWN_UNREFERENCED = new Map([
  ...[
    "logo-black-on-white.svg",
    "logo-black-transparent.svg",
    "logo-white-on-black.svg",
    "logo-white-transparent.svg",
    "symbol-black-on-white.png",
    "symbol-black-transparent.png",
    "symbol-white-on-black.png",
    "symbol-white-transparent.png",
  ].map((name) => [
    `public/images/${name}`,
    "logo/symbol export; app/logo/logo-client.tsx draws the mark as inline SVG and offers no download, so nothing in the repository links here. May be linked from outside the repository — awaiting a ruling.",
  ]),
  ...["next.svg", "vercel.svg", "globe.svg", "window.svg", "file.svg"].map((name) => [
    `public/${name}`,
    "create-next-app scaffold asset, never removed after the project was generated.",
  ]),
  [
    "public/data/cube-cards.json",
    "1.7 MB written by scripts/download-cube-cards.mjs, which is the only file in the repository that mentions it. No page fetches it and the word \"cube\" appears in no other source file.",
  ],
]);

// Application code that builds a public/ path at run time. `reader` is the file
// that does it and `needle` is the exact expression; if the needle is gone the
// rule no longer applies. `names()` returns the set of filenames the rule can
// actually produce, so a file sitting in the directory that the rule can never
// name is still reported as unreferenced.
const DYNAMIC_READERS = [
  {
    label: "perfume ingredient art",
    dir: "public/perfume/ingredients/",
    reader: "app/perfume/lib/images.ts",
    needle: "`/perfume/ingredients/${ingredientSlug(name)}.png`",
    names: ingredientArtNames,
  },
  {
    label: "legacy perfume ingredient art (fallback)",
    dir: "public/art/ingredients/",
    reader: "app/perfume/lib/images.ts",
    needle: "`/art/ingredients/${ingredientSlug(name)}.png`",
    names: ingredientArtNames,
  },
  {
    label: "point clouds named by the clouds manifest",
    dir: "public/data/clouds/",
    reader: "app/clouds/clouds-client.tsx",
    needle: "`/data/clouds/${m.clouds[key].url}`",
    names: cloudNames,
  },
];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function trackedFiles() {
  return git(["ls-files", "-z"]).split("\0").filter(Boolean);
}

function read(file) {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

// The slug rule in app/perfume/lib/images.ts, applied to the 96 base
// ingredient names, is what produces every filename under either art
// directory. Duplicated here rather than imported because this script is plain
// Node and images.ts is TypeScript.
function ingredientArtNames() {
  const base = JSON.parse(read("app/perfume/data/base.json"));
  return new Set(
    base.ingredients.map(
      (ingredient) =>
        `${String(ingredient.name)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")}.png`,
    ),
  );
}

// The manifest is itself served, and names the binaries beside it.
function cloudNames() {
  const manifest = JSON.parse(read("public/data/clouds/manifest.json"));
  const names = new Set(["manifest.json"]);
  for (const cloud of Object.values(manifest.clouds ?? {})) {
    if (cloud?.url) names.add(String(cloud.url));
  }
  return names;
}

function looksBinary(text) {
  return text.includes("\0");
}

const publicFiles = trackedFiles().filter((file) => file.startsWith("public/"));

// Everything that could name a public file, minus this census itself: the
// reasons in KNOWN_UNREFERENCED quote filenames, and a census that counted its
// own prose as a reference would call every file reachable.
const selfPath = "scripts/check-public-assets.mjs";
const readerFiles = trackedFiles().filter(
  (file) => !file.startsWith("public/") && file !== selfPath,
);

const sources = new Map();
for (const file of readerFiles) {
  let text;
  try {
    text = read(file);
  } catch {
    continue;
  }
  if (looksBinary(text)) continue;
  sources.set(file, text);
}

// Resolve the dynamic rules once, dropping any whose reader no longer builds
// the path.
const activeRules = [];
for (const rule of DYNAMIC_READERS) {
  let readerText;
  try {
    readerText = read(rule.reader);
  } catch {
    console.warn(`Dynamic reader gone — ${rule.reader} (${rule.label}); its files fall through.`);
    continue;
  }
  if (!readerText.includes(rule.needle)) {
    console.warn(
      `Dynamic reader no longer builds the path — ${rule.reader} lost ${rule.needle} (${rule.label}); its files fall through.`,
    );
    continue;
  }
  activeRules.push({ ...rule, produced: rule.names() });
}

function classify(file) {
  const webPath = `/${file.slice("public/".length)}`;
  const base = path.basename(file);

  const namers = [];
  for (const [source, text] of sources) {
    if (text.includes(webPath) || text.includes(file) || text.includes(base)) namers.push(source);
  }
  const serving = namers.filter((source) => SERVING_ROOTS.some((root) => source.startsWith(root)));
  if (serving.length > 0) return { how: "static", by: serving.join(", ") };

  for (const rule of activeRules) {
    if (file.startsWith(rule.dir) && rule.produced.has(base)) {
      return { how: "dynamic", by: `${rule.reader} (${rule.label})` };
    }
  }

  if (namers.length > 0) return { how: "none", by: `named only by ${namers.join(", ")}` };
  return { how: "none", by: "named by no file in the repository" };
}

const rows = publicFiles.map((file) => ({ file, ...classify(file) }));
const unreferenced = rows.filter((row) => row.how === "none");

const violations = [];
const tolerated = [];
for (const row of unreferenced) {
  const reason = KNOWN_UNREFERENCED.get(row.file);
  if (reason) {
    tolerated.push(`${row.file}: ${reason}`);
    continue;
  }
  violations.push(
    `${row.file} is served at /${row.file.slice("public/".length)} but ${row.by}. Either give it a reader under ${SERVING_ROOTS.join(", ")}, or delete it, or add it to KNOWN_UNREFERENCED in ${selfPath} with the reason it stays.`,
  );
}
for (const [file] of KNOWN_UNREFERENCED) {
  if (!publicFiles.includes(file)) {
    violations.push(
      `${file} is listed in KNOWN_UNREFERENCED in ${selfPath} but is no longer tracked under public/. Remove its entry.`,
    );
  } else if (!unreferenced.some((row) => row.file === file)) {
    violations.push(
      `${file} is listed in KNOWN_UNREFERENCED in ${selfPath} but is now reached. Remove its entry.`,
    );
  }
}

const byHow = { static: 0, dynamic: 0, none: 0 };
for (const row of rows) byHow[row.how] += 1;

console.log(
  `Public asset census: ${rows.length} file(s) under public/ — ${byHow.static} named directly, ${byHow.dynamic} reached by a run-time path, ${byHow.none} unreferenced.`,
);
for (const note of tolerated) console.warn(`Known unreferenced — ${note}`);

if (process.argv.includes("--list")) {
  // Files reached the same way are collapsed onto one line: 96 ingredient PNGs
  // reached by one expression is one fact, not 96.
  const groups = new Map();
  for (const row of rows) {
    const key = row.how === "none" ? `${row.file}\0${row.by}` : `${row.how}\0${row.by}`;
    if (!groups.has(key)) groups.set(key, { how: row.how, by: row.by, files: [] });
    groups.get(key).files.push(row.file);
  }
  console.log("");
  for (const group of groups.values()) {
    const head =
      group.files.length === 1
        ? group.files[0]
        : `${group.files.length} files: ${group.files[0]} … ${group.files[group.files.length - 1]}`;
    console.log(`  [${group.how.padEnd(7)}] ${head}`);
    console.log(`            ${group.by}`);
  }
  console.log("");
}

if (process.argv.includes("--live")) {
  const results = await Promise.all(
    rows.map(async (row) => {
      const url = `${SITE}/${row.file.slice("public/".length)}`;
      try {
        const response = await fetch(url, { method: "HEAD" });
        return { ...row, status: response.status };
      } catch (error) {
        return { ...row, status: `error: ${error.message}` };
      }
    }),
  );
  const tally = new Map();
  for (const result of results) tally.set(result.status, (tally.get(result.status) ?? 0) + 1);
  console.log(`Deployed site (${SITE}) answers:`);
  for (const [status, count] of [...tally].sort()) console.log(`  ${status}: ${count} file(s)`);
  const servedButUnreferenced = results.filter((r) => r.how === "none" && r.status === 200);
  console.log(
    `  ${servedButUnreferenced.length} unreferenced file(s) answer 200 — deleting those turns working URLs into 404s.`,
  );
}

if (violations.length > 0) {
  console.error("Public asset census failed:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
