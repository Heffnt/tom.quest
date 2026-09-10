import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Byte targets per AGENTS.md, by path relative to the repo root. Crossing one
// warns; it never fails the check. A nested file not listed here takes the
// default. The chain cap below is the one hard size limit.
const BYTE_TARGETS = {
  "AGENTS.md": 4000,
  "app/AGENTS.md": 3500,
  "app/api/turing/AGENTS.md": 400,
  "convex/AGENTS.md": 3500,
  "turing-api/AGENTS.md": 3500,
  "worker/AGENTS.md": 3500,
};
const DEFAULT_BYTE_TARGET = 3500;
const MAX_CHAIN_BYTES = 32_768;

// The one sentence allowed in more than one AGENTS.md: the pointer at WikiTom.
const WIKITOM_POINTER = /wikitom.*model-of-tom/;
const MIN_SENTENCE_LENGTH = 40;

const ROOT = process.cwd();
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
const warnings = [];

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

// The working tree can hold a regular file while the index still records a
// symlink (mode 120000), which is what a Linux checkout would then produce.
// The index is the truth that ships, so every tracked CLAUDE.md must be
// recorded as a regular file (mode 100644).
try {
  const index = execFileSync("git", ["ls-files", "-s"], { cwd: ROOT, encoding: "utf8" });
  let tracked = 0;
  for (const row of index.split(/\r?\n/)) {
    if (!row) continue;
    const match = /^(\d{6}) [0-9a-f]+ \d\t(.+)$/.exec(row);
    if (!match) continue;
    const [, mode, file] = match;
    if (path.posix.basename(file) !== "CLAUDE.md") continue;
    tracked += 1;
    if (mode !== "100644") {
      failures.push(`${file}: tracked with index mode ${mode}; a CLAUDE.md must be tracked as 100644`);
    }
  }
  if (tracked === 0) failures.push("git index: no tracked CLAUDE.md found");
} catch (error) {
  failures.push(`git ls-files -s failed (${error.message}); the CLAUDE.md index-mode check needs a git checkout`);
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

for (const agent of agents) {
  const bytes = sourceFor(agent)?.length ?? 0;
  const target = BYTE_TARGETS[relative(agent)] ?? DEFAULT_BYTE_TARGET;
  if (bytes > target) {
    warnings.push(`${relative(agent)} is ${bytes} bytes; its target is ${target}`);
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

// The same substantive instruction has one AGENTS.md home. The unit compared
// is the sentence, not the line, so a sentence copied into a longer bullet is
// still caught. Normalizing case, whitespace, bullet markers and emphasis
// keeps formatting-only changes from evading the check.
function sentencesOf(text) {
  return text
    .split(/\r?\n/)
    .flatMap((line, index) => {
      const stripped = line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim();
      if (stripped.startsWith("#") || stripped.startsWith("<!--")) return [];
      return stripped.split(/(?<=[.!?])\s+/).map((sentence) => ({ sentence, line: index + 1 }));
    })
    .map(({ sentence, line }) => ({
      normalized: sentence
        .toLowerCase()
        .replace(/[*_]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
      line,
    }))
    .filter(({ normalized }) => normalized.length > MIN_SENTENCE_LENGTH)
    .filter(({ normalized }) => !WIKITOM_POINTER.test(normalized));
}

const normalizedSentences = new Map();
for (const agent of agents) {
  const bytes = sourceFor(agent);
  if (!bytes) continue;
  for (const { normalized, line } of sentencesOf(bytes.toString("utf8"))) {
    const locations = normalizedSentences.get(normalized) ?? [];
    locations.push({ agent, line });
    normalizedSentences.set(normalized, locations);
  }
}
for (const [sentence, locations] of normalizedSentences) {
  const files = new Set(locations.map(({ agent }) => agent));
  if (files.size < 2) continue;
  const where = locations.map(({ agent, line }) => `${relative(agent)}:${line}`).join(", ");
  failures.push(`duplicated AGENTS.md sentence ${JSON.stringify(sentence)} appears in ${where}`);
}

for (const warning of warnings) console.warn(`warning: ${warning}`);

if (failures.length > 0) {
  console.error("AGENTS.md check failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`AGENTS.md check passed (${agents.length} AGENTS.md file(s), ${chains.length} chain(s)).`);
