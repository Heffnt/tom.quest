import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const SEARCH_ROOTS = ["app", "convex"];
const IGNORED_DIRS = new Set([".git", ".next", "node_modules", "_generated"]);

// Each rule fences ONE auth decision into ONE file. The shape is always the
// same: a `pattern` that recognises the decision spelled out by hand, and the
// short list of files allowed to spell it. Everywhere else must call the
// function instead, so changing the decision changes one line, not four.
export const RULES = [
  {
    // Who counts as an admin. Lives in convex/authRoles.ts (roleAccess), plus
    // the page registry, which declares per-page visibility in the same terms.
    name: "admin role derivation",
    remedy: "call roleAccess() from convex/authRoles.ts",
    allowed: [
      path.normalize("app/components/page-routes.ts"),
      path.normalize("convex/authRoles.ts"),
    ],
    patterns: [
      /role\s*===\s*["']admin["']\s*\|\|\s*role\s*===\s*["']tom["']/,
      /role\s*===\s*["']tom["']\s*\|\|\s*role\s*===\s*["']admin["']/,
    ],
  },
  {
    // Which account a typed username matches. Lives in convex/authUsername.ts
    // (normalizeUsername / accountEmail). Reordering the lowercase and the
    // strip in one copy turns "Tom" into "om" in that copy alone, with no
    // error at any call site — a login that quietly matches a different
    // account or none. There is nothing to fail but a person noticing.
    name: "username normalization",
    remedy:
      "call normalizeUsername() or accountEmail() from convex/authUsername.ts",
    allowed: [path.normalize("convex/authUsername.ts")],
    patterns: [
      // .replace(/[^a-z0-9]/g, "") — the strip half, in any spacing.
      /\.replace\(\s*\/\[\^a-z0-9\]\/g\s*,/,
      // `${something}@tom.quest` — the account address, built by hand.
      /\$\{[^}]*\}@tom\.quest/,
    ],
  },
];

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) walk(path.join(dir, entry.name), files);
      continue;
    }
    // Test files are skipped: they build fixture users by hand
    // (`email: `${role}@tom.quest``) and assert on the very rules below, so
    // matching them would fail the build for saying what the rule is.
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.(ts|tsx)$/.test(entry.name)) files.push(path.join(dir, entry.name));
  }
  return files;
}

/**
 * The part of a source line that the compiler sees. Comments are dropped
 * because a comment that DESCRIBES a rule ("the index holds
 * `${username}@tom.quest`") is not a second copy of it, and failing the build
 * for explaining the rule would push people to stop explaining it. `://` is
 * spared so a URL inside a comment cannot truncate a real violation sharing
 * its line.
 */
function codeOnly(line) {
  if (/^\s*\*/.test(line)) return "";
  const comment = line.search(/(^|[^:])\/\//);
  if (comment === -1) return line;
  return line.slice(0, comment === 0 ? 0 : comment + 1);
}

/**
 * Every rule violation in one file's text, as `{ rule, line, text }`.
 * `relativePath` is repo-relative and decides which rules exempt the file.
 * Pure, so the test beside this script can call it without touching disk.
 */
export function violationsFor(relativePath, source, rules = RULES) {
  const normalizedPath = path.normalize(relativePath);
  const found = [];
  const lines = source.split(/\r?\n/);
  for (const rule of rules) {
    if (rule.allowed.includes(normalizedPath)) continue;
    lines.forEach((line, index) => {
      const code = codeOnly(line);
      if (rule.patterns.some((pattern) => pattern.test(code))) {
        found.push({ rule: rule.name, line: index + 1, text: code.trim() });
      }
    });
  }
  return found;
}

function main() {
  const violations = [];
  for (const root of SEARCH_ROOTS) {
    const absoluteRoot = path.join(ROOT, root);
    if (!fs.existsSync(absoluteRoot)) continue;
    for (const file of walk(absoluteRoot)) {
      const relative = path.normalize(path.relative(ROOT, file));
      const source = fs.readFileSync(file, "utf8");
      for (const found of violationsFor(relative, source)) {
        violations.push({ ...found, file: relative });
      }
    }
  }

  if (violations.length > 0) {
    console.error("Auth decisions spelled out outside their one home:");
    for (const violation of violations) {
      const rule = RULES.find((candidate) => candidate.name === violation.rule);
      console.error(
        `  ${violation.file}:${violation.line}: ${violation.rule} — ${violation.text}`,
      );
      if (rule) console.error(`      instead: ${rule.remedy}`);
    }
    process.exit(1);
  }

  console.log("Auth boundary check passed.");
}

// Only when run as a command. Imported (by the test beside it) this file is
// just the rules.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
