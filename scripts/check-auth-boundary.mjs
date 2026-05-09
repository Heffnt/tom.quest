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

const violations = [];
for (const root of SEARCH_ROOTS) {
  const absoluteRoot = path.join(ROOT, root);
  if (!fs.existsSync(absoluteRoot)) continue;
  for (const file of walk(absoluteRoot)) {
    const relative = path.normalize(path.relative(ROOT, file));
    if (ALLOWED_FILES.has(relative)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (INLINE_ADMIN_PATTERNS.some((pattern) => pattern.test(line))) {
        violations.push(`${relative}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error("Inline admin role derivation found outside the auth boundary:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log("Auth boundary check passed.");
