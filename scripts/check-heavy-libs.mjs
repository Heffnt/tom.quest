import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const APP_ROOT = path.join(ROOT, "app");
const IGNORED_DIRS = new Set([".git", ".next", "node_modules"]);
const IGNORED_APP_PREFIXES = [
  path.normalize("app/canvas"),
  path.normalize("app/api/canvas"),
];

const XTERM_ALLOWED_FILES = new Set([
  path.normalize("app/turing/components/terminal-modal.tsx"),
  path.normalize("app/turing/terminal/[session]/terminal-client.tsx"),
]);

const JOB_TABLE = path.normalize("app/turing/components/job-table.tsx");
const CLOUDS_PAGE = path.normalize("app/clouds/clouds-client-page.tsx");

const XTERM_IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)["']@xterm\//;
const THREE_IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)["'](?:three|@react-three\/[^"']+)/;
const STATIC_TERMINAL_MODAL_IMPORT = /import\s+(?:[\w*{}\s,]+)\s+from\s+["']\.\/terminal-modal["']/;

function relativeToRoot(file) {
  return path.normalize(path.relative(ROOT, file));
}

function shouldIgnore(relative) {
  return IGNORED_APP_PREFIXES.some((prefix) => relative === prefix || relative.startsWith(`${prefix}${path.sep}`));
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) walk(path.join(dir, entry.name), files);
      continue;
    }
    if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) files.push(path.join(dir, entry.name));
  }
  return files;
}

function readRelative(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

const violations = [];
for (const file of walk(APP_ROOT)) {
  const relative = relativeToRoot(file);
  if (shouldIgnore(relative)) continue;

  const source = fs.readFileSync(file, "utf8");
  if (XTERM_IMPORT.test(source) && !XTERM_ALLOWED_FILES.has(relative)) {
    violations.push(`${relative}: xterm imports must stay inside the terminal components.`);
  }

  if (THREE_IMPORT.test(source) && !relative.startsWith(path.normalize(`app/clouds${path.sep}`))) {
    violations.push(`${relative}: three/react-three imports must stay inside app/clouds.`);
  }
}

const jobTableSource = readRelative(JOB_TABLE);
if (STATIC_TERMINAL_MODAL_IMPORT.test(jobTableSource)) {
  violations.push(`${JOB_TABLE}: TerminalModal must be loaded with next/dynamic, not a static import.`);
}

const cloudsPageSource = readRelative(CLOUDS_PAGE);
if (!/dynamic\s*\(\s*\(\s*\)\s*=>\s*import\s*\(\s*["']\.\/clouds-client["']\s*\)/.test(cloudsPageSource)) {
  violations.push(`${CLOUDS_PAGE}: clouds-client must be loaded through next/dynamic.`);
}
if (!/ssr\s*:\s*false/.test(cloudsPageSource)) {
  violations.push(`${CLOUDS_PAGE}: clouds-client dynamic import must disable SSR.`);
}

if (violations.length > 0) {
  console.error("Heavy library boundary check failed:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log("Heavy library boundary check passed.");
