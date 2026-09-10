#!/usr/bin/env node
// One JSON line per instruction file Claude Code loads, appended to a local log.
// A model cannot reliably report every instruction it received; this hook records
// the runtime's own account of what loaded, when, and why. It is observe-only by
// construction: every failure is swallowed and every path exits 0, because a
// logging hook that can block an instruction load can break a whole session.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const LOG_PATH = path.join(os.homedir(), ".claude", "evals", "instructions-loaded.jsonl");
const ROLLUP_STAMP = path.join(os.homedir(), ".claude", "evals", "last-rollup");
const REPORT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "instructions-loaded-report.mjs");

export const MAX_LOG_BYTES = 16 * 1024 * 1024;
export const REPO_ROOTS = [
  "C:/Users/heffn/Desktop/tom.quest",
  "C:/Users/heffn/Desktop/booleanbackdoor/ComplexMultiTrigger",
  "C:/Users/heffn/Desktop/WikiTom",
];

function utcDay(now) {
  return now.toISOString().slice(0, 10);
}

function normalPath(value) {
  return typeof value === "string" ? value.replaceAll("\\", "/") : "";
}

function pathIsWithin(child, parent) {
  const normalizedChild = normalPath(child).replace(/\/+$/, "").toLowerCase();
  const normalizedParent = normalPath(parent).replace(/\/+$/, "").toLowerCase();
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function sessionLines(lines) {
  const sessions = new Map();
  for (const line of lines) {
    if (!line || typeof line.session !== "string" || line.session === "") continue;
    const records = sessions.get(line.session) ?? [];
    records.push(line);
    sessions.set(line.session, records);
  }
  return sessions;
}

/** Session ids that loaded no instruction from WikiTom's model-of-tom directory. */
export function sessionsMissingWikiTom(lines) {
  return [...sessionLines(lines).entries()]
    .filter(([, records]) => !records.some((line) => /\/model-of-tom\//i.test(normalPath(line.path))))
    .map(([session]) => session)
    .sort();
}

/** In-scope project sessions that loaded no CLAUDE.md or AGENTS.md at/above cwd. */
export function sessionsMissingProjectAgents(lines, repoRoots = REPO_ROOTS) {
  const roots = repoRoots.map(normalPath);
  const missing = [];
  for (const [session, records] of sessionLines(lines)) {
    const cwd = records.map((line) => normalPath(line.cwd)).find(Boolean);
    if (!cwd || !roots.some((root) => pathIsWithin(cwd, root))) continue;
    const loadedProjectInstructions = records.some((line) => {
      const file = normalPath(line.path);
      return /\/(?:CLAUDE|AGENTS)\.md$/i.test(file) && pathIsWithin(cwd, path.posix.dirname(file));
    });
    if (!loadedProjectInstructions) missing.push({ session, cwd });
  }
  return missing.sort((a, b) => a.session.localeCompare(b.session));
}

/** The safe, content-free record for one InstructionsLoaded payload. */
export function logLine(payload, now = new Date()) {
  if (!payload || payload.hook_event_name !== "InstructionsLoaded") return null;

  const content = typeof payload.file_content === "string" ? payload.file_content : "";
  return {
    at: now.toISOString(),
    session: typeof payload.session_id === "string" ? payload.session_id : "",
    reason: typeof payload.load_reason === "string" ? payload.load_reason : "",
    path: normalPath(payload.file_path),
    bytes: Buffer.byteLength(content),
    sha: crypto.createHash("sha256").update(content).digest("hex").slice(0, 8),
    cwd: normalPath(payload.cwd),
  };
}

/** Append one line, rotating the bounded log first. Failures are intentionally silent. */
export function appendLine(logPath, line) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_LOG_BYTES) {
      const previous = path.join(path.dirname(logPath), "instructions-loaded.1.jsonl");
      fs.rmSync(previous, { force: true });
      fs.renameSync(logPath, previous);
    }
    fs.appendFileSync(logPath, `${JSON.stringify(line)}\n`);
  } catch {
    // A hook may not turn a logging problem into an instruction-load problem.
  }
}

/** Claim today's rollup slot at most once, using UTC rather than laptop local time. */
export function shouldRollUp(stampPath, now = new Date()) {
  try {
    const today = utcDay(now);
    if (fs.existsSync(stampPath) && fs.readFileSync(stampPath, "utf8").trim() === today) {
      return false;
    }
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, `${today}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Summarise one UTC day and hand its idempotent event payload to `post`. */
export async function rollUp(logPath, day, post) {
  let lines = [];
  try {
    lines = fs.readFileSync(logPath, "utf8")
      .split(/\r?\n/)
      .flatMap((line) => {
        try {
          const record = JSON.parse(line);
          return typeof record?.at === "string" && record.at.slice(0, 10) === day ? [record] : [];
        } catch {
          return [];
        }
      });
  } catch {
    // An absent log is a valid empty day.
  }

  const sessions = new Set(lines.map((line) => line.session).filter(Boolean));
  const files = new Map();
  for (const line of lines) {
    if (!line.path) continue;
    const current = files.get(line.path) ?? { sessions: new Set(), reasons: {} };
    if (line.session) current.sessions.add(line.session);
    if (line.reason) current.reasons[line.reason] = (current.reasons[line.reason] ?? 0) + 1;
    files.set(line.path, current);
  }
  const data = {
    day,
    machine: "laptop",
    sessions: sessions.size,
    files: [...files.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, value]) => ({ path: file, sessions: value.sessions.size, reasons: value.reasons })),
    missingWikiTom: sessionsMissingWikiTom(lines),
    missingProjectAgents: sessionsMissingProjectAgents(lines, REPO_ROOTS),
  };
  const payload = { kind: "instructions-loaded", key: `laptop:${day}`, data };
  if (typeof post === "function") await post(payload);
  return payload;
}

function spawnYesterdayReport(now) {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const child = spawn(process.execPath, [REPORT_PATH, "--day", utcDay(yesterday)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function main() {
  try {
    const payload = JSON.parse(fs.readFileSync(0, "utf8"));
    const line = logLine(payload);
    if (line) appendLine(LOG_PATH, line);
    const now = new Date();
    if (shouldRollUp(ROLLUP_STAMP, now)) spawnYesterdayReport(now);
  } catch {
    // See the file header: instruction loading always wins over audit logging.
  }
  process.exit(0);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
