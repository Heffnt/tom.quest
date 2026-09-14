// Path-level privacy guard for this public repository. The private source pages
// and their area trigger cases belong in WikiTom, never in tom.Quest.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AREA_NAMES = "admin|agent-systems|climbing|health-and-food|mental-health|money|research|social";
const ALLOWED_KNOW_TRIGGERS = new Set([
  "evals/triggers/skill-know-intent.json",
  "evals/triggers/skill-know-week.json",
]);

export const FORBIDDEN_PRIVATE_PATHS = Object.freeze([
  { rule: "model-of-tom area page", pattern: /(?:^|\/)model-of-tom\/areas\// },
  { rule: "area-page copy under evals", pattern: new RegExp(`^evals/(?:.+/)?areas/(?:${AREA_NAMES})\\.(?:md|json)$`) },
  { rule: "private eval fixture directory", pattern: /^evals\/(?:private|fixtures\/private)(?:\/|$)/ },
]);

export function normalizeTrackedPath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

export function privatePathFindings(tracked) {
  const findings = [];
  for (const raw of tracked) {
    const file = normalizeTrackedPath(raw);
    const lower = file.toLowerCase();
    if (/^evals\/triggers\/skill-know-.+\.json$/.test(lower) && !ALLOWED_KNOW_TRIGGERS.has(lower)) {
      findings.push({ file, rule: "private know-area trigger" });
      continue;
    }
    const forbidden = FORBIDDEN_PRIVATE_PATHS.find(({ pattern }) => pattern.test(lower));
    if (forbidden !== undefined) findings.push({ file, rule: forbidden.rule });
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
}

export function trackedFiles(run = execFileSync) {
  return run("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).split("\0").filter(Boolean);
}

export function checkPrivatePaths(run = execFileSync) {
  return privatePathFindings(trackedFiles(run));
}

function main() {
  const findings = checkPrivatePaths();
  if (findings.length === 0) return;
  for (const finding of findings) process.stderr.write(`private-paths: ${finding.file} (${finding.rule})\n`);
  process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
