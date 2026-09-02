import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SEARCH_ROOTS = ["app", "convex"];
const ALLOWED_FILES = new Set([
  path.normalize("app/components/page-routes.ts"),
  path.normalize("convex/authRoles.ts"),
]);
const IGNORED_DIRS = new Set([".git", ".next", "node_modules", "_generated"]);

const INLINE_ADMIN_PATTERNS = [
  /role\s*===\s*["']admin["']\s*\|\|\s*role\s*===\s*["']tom["']/,
  /role\s*===\s*["']tom["']\s*\|\|\s*role\s*===\s*["']admin["']/,
];

// A binding named `isTom` may never receive an `isAdmin` value. `isAdmin` is
// true for role "admin" and role "tom"; `isTom` is true only for role "tom",
// so the assignment always widens the gate while the name keeps claiming the
// narrow one. app/turing did exactly this for its allocate form and job table:
// props declared `isTom` were passed `useAuth().isAdmin`, so every reader of
// those files read a Tom-only surface that in fact admitted any admin.
//
// Only this direction is checked. The reverse (`const isAdmin = ....isTom`)
// has legitimate uses — convex/brews.ts and app/perfume/lib/brew-store.ts both
// grant a feature-local "admin" permission to Tom alone — and narrowing a gate
// under a broader name fails closed rather than open.
const WIDENED_TOM_PATTERNS = [
  // JSX attribute: isTom={...isAdmin...}
  /\bisTom\s*=\s*\{[^}]*\bisAdmin\b/,
  // object property or destructuring rename: isTom: someIsAdminThing
  /\bisTom\s*:\s*[^,;}\n]*\bisAdmin\b/,
  // plain assignment or declaration: const isTom = ...isAdmin...
  /\bisTom\s*=\s*[^=][^;\n]*\bisAdmin\b/,
];

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) walk(path.join(dir, entry.name), files);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) files.push(path.join(dir, entry.name));
  }
  return files;
}

const inlineAdminViolations = [];
const widenedTomViolations = [];
for (const root of SEARCH_ROOTS) {
  const absoluteRoot = path.join(ROOT, root);
  if (!fs.existsSync(absoluteRoot)) continue;
  for (const file of walk(absoluteRoot)) {
    const relative = path.normalize(path.relative(ROOT, file));
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const where = `${relative}:${index + 1}: ${line.trim()}`;
      if (!ALLOWED_FILES.has(relative) && INLINE_ADMIN_PATTERNS.some((p) => p.test(line))) {
        inlineAdminViolations.push(where);
      }
      if (WIDENED_TOM_PATTERNS.some((p) => p.test(line))) {
        widenedTomViolations.push(where);
      }
    });
  }
}

let failed = false;
if (inlineAdminViolations.length > 0) {
  failed = true;
  console.error("Inline admin role derivation found outside the auth boundary:");
  for (const violation of inlineAdminViolations) console.error(`  ${violation}`);
}
if (widenedTomViolations.length > 0) {
  failed = true;
  console.error(
    "A binding named isTom is being given an isAdmin value, so the name claims " +
      "role === \"tom\" while the value admits every admin. Rename the binding to " +
      "isAdmin, or pass the real isTom:",
  );
  for (const violation of widenedTomViolations) console.error(`  ${violation}`);
}
if (failed) process.exit(1);

console.log("Auth boundary check passed.");
