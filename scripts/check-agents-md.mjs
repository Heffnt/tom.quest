import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MAX_CHAIN_BYTES = 32_768;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".next",
  ".vercel",
  "out",
  "dist",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
]);

const agents = [];
const claudes = [];
const failures = [];

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join("/") || ".";
}

function walk(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    // A directory symlink is deliberately neither descended into nor treated
    // as a repository directory: following one could escape the checkout or
    // introduce a recursive walk.
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(file);
      continue;
    }
    if (entry.name === "AGENTS.md") agents.push(file);
    if (entry.name === "CLAUDE.md") claudes.push(file);
  }
}

walk(ROOT);
agents.sort((a, b) => relative(a).localeCompare(relative(b)));
claudes.sort((a, b) => relative(a).localeCompare(relative(b)));

const isRegularNonSymlink = (stat) => stat.isFile() && !stat.isSymbolicLink();
const CLAUDE_CONTENTS = new Set(["@AGENTS.md", "@AGENTS.md\n", "@AGENTS.md\r\n"]);

for (const claude of claudes) {
  let stat;
  try {
    stat = fs.lstatSync(claude);
  } catch (error) {
    failures.push(`${relative(claude)}: could not lstat CLAUDE.md (${error.message})`);
    continue;
  }
  if (!isRegularNonSymlink(stat)) {
    failures.push(`${relative(claude)}: CLAUDE.md must be a regular non-symlink file`);
  }
}

for (const agent of agents) {
  const claude = path.join(path.dirname(agent), "CLAUDE.md");
  let stat;
  try {
    stat = fs.lstatSync(claude);
  } catch (error) {
    if (error.code === "ENOENT") {
      failures.push(`${relative(agent)}: missing sibling ${relative(claude)}`);
    } else {
      failures.push(`${relative(agent)}: could not lstat sibling ${relative(claude)} (${error.message})`);
    }
    continue;
  }
  if (!isRegularNonSymlink(stat)) {
    failures.push(`${relative(agent)}: sibling ${relative(claude)} must be a regular non-symlink file`);
    continue;
  }
  try {
    const content = fs.readFileSync(claude, "utf8");
    if (!CLAUDE_CONTENTS.has(content)) {
      failures.push(
        `${relative(claude)}: must contain exactly @AGENTS.md, with at most one final LF or CRLF newline`,
      );
    }
  } catch (error) {
    failures.push(`${relative(claude)}: could not read CLAUDE.md (${error.message})`);
  }
}

const rootAgents = agents.filter((agent) => path.dirname(agent) === ROOT);
if (rootAgents.length === 0) failures.push("AGENTS.md: required root AGENTS.md is missing");

const agentByDirectory = new Map(agents.map((agent) => [path.dirname(agent), agent]));
const parent = new Map();
for (const agent of agents) {
  let ancestor = path.dirname(path.dirname(agent));
  while (ancestor.startsWith(ROOT)) {
    const ancestorAgent = agentByDirectory.get(ancestor);
    if (ancestorAgent) {
      parent.set(agent, ancestorAgent);
      break;
    }
    if (ancestor === ROOT) break;
    ancestor = path.dirname(ancestor);
  }
}

const children = new Set(parent.values());
const leaves = new Set(agents.filter((agent) => !children.has(agent)));
const source = new Map();
function sourceFor(agent) {
  if (source.has(agent)) return source.get(agent);
  try {
    const value = fs.readFileSync(agent);
    source.set(agent, value);
    return value;
  } catch (error) {
    failures.push(`${relative(agent)}: could not read AGENTS.md (${error.message})`);
    source.set(agent, null);
    return null;
  }
}

const chains = [];
for (const leaf of [...leaves].sort((a, b) => relative(a).localeCompare(relative(b)))) {
  const chain = [];
  for (let cursor = leaf; cursor; cursor = parent.get(cursor)) chain.unshift(cursor);
  chains.push(chain);
}
for (const chain of chains) {
  const bytes = chain.reduce((total, agent) => total + (sourceFor(agent)?.length ?? 0), 0);
  const label = chain.map(relative).join(" -> ");
  console.log(`AGENTS chain: ${label} = ${bytes} bytes`);
  if (bytes > MAX_CHAIN_BYTES) {
    failures.push(`AGENTS chain exceeds ${MAX_CHAIN_BYTES} bytes: ${label} = ${bytes} bytes`);
  }
}

// The same substantive instruction must have one AGENTS.md home. Normalizing
// case and whitespace keeps formatting-only changes from evading the check.
const normalizedLines = new Map();
for (const agent of agents) {
  const bytes = sourceFor(agent);
  if (!bytes) continue;
  bytes
    .toString("utf8")
    .split(/\r?\n/)
    .forEach((line, index) => {
      const normalized = line.trim().toLowerCase().replace(/\s+/g, " ");
      if (normalized.length <= 40) return;
      const locations = normalizedLines.get(normalized) ?? [];
      locations.push({ agent, line: index + 1 });
      normalizedLines.set(normalized, locations);
    });
}
for (const [line, locations] of normalizedLines) {
  const files = new Set(locations.map(({ agent }) => agent));
  if (files.size < 2) continue;
  const where = locations.map(({ agent, line: number }) => `${relative(agent)}:${number}`).join(", ");
  failures.push(`duplicated AGENTS.md instruction ${JSON.stringify(line)} appears in ${where}`);
}

if (failures.length > 0) {
  console.error("AGENTS.md check failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`AGENTS.md check passed (${agents.length} AGENTS.md file(s), ${chains.length} chain(s)).`);
