#!/usr/bin/env node
/**
 * export-golden.mjs - builds the golden set out of Tom's own rulings.
 *
 * A dtsRulings row with verdict "revise" is a failed output plus the one
 * sentence saying what was wrong with it; an "approve" is a pass. Those are
 * labels, already written, and this script turns them into files.
 *
 * The one hard part: a revise ruling's judged output is gone from the live row,
 * because the prepare pass re-prepares on a pending revise and overwrites the
 * fields. The text survives in exactly one place - the nightly snapshot in
 * WikiTom (worker/jobs/nightly.mjs snapshotStep), which writes every row's full
 * state each night. So the output Tom judged is the row as it stood in the
 * newest snapshot commit at or before the ruling. A ruling with no snapshot
 * behind it is skipped and counted, never guessed at.
 *
 * Sibling: scripts/check-writing-standard.mjs is the mechanical half of the
 * same question - regex rules over stored explanations, ratcheting a baseline.
 * This is the semantic half. Neither replaces the other.
 *
 *   node scripts/export-golden.mjs [--wikitom DIR] [--out evals/golden] [--dry-run] [--list]
 *
 * Credentials the check-writing-standard.mjs way: CONVEX_SITE_URL and
 * TTS_WORKER_KEY in the environment, X-TTS-Key on the request.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../worker/session-host/redact.mjs";

/** Where the nightly job writes the snapshot inside the WikiTom checkout. */
export const SNAPSHOT_DIR = "tts/snapshot";
export const DEFAULT_OUT = "evals/golden";
/** The laptop checkout; the box passes WIKITOM_DIR (/root/wikitom). */
export const DEFAULT_WIKITOM = process.env.WIKITOM_DIR || "C:/Users/heffn/Desktop/WikiTom";

/** The table each job's judged output lives in, and the fields Tom ruled on. */
export const JOB_TABLES = Object.freeze({
  prepare: { table: "dtsTodos", fields: ["brief", "entryAction", "workDescription", "groundUpExplanation"] },
  "code-brief": { table: "dtsCodeBriefs", fields: ["brief", "recommendation", "execClass", "evidence"] },
  "batch-plan": { table: "batches", fields: ["groundUpExplanation"] },
});

export function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * The blob of `rel` in the newest commit whose committer date is at or before
 * `at`. Null when no such commit touched the path - which means the ruling
 * predates the snapshot and the item cannot be built.
 */
export function snapshotAt(dir, rel, at) {
  const sha = git(dir, "log", "-1", "--format=%H", `--before=${Math.floor(at / 1000)}`, "--", rel).trim();
  if (sha === "") return null;
  try {
    return { sha, text: git(dir, "show", `${sha}:${rel}`) };
  } catch {
    return null;
  }
}

/** The commit that held the snapshot directory at or before `at`. */
export function snapshotCommitAt(dir, at) {
  const sha = git(dir, "log", "-1", "--format=%H", `--before=${Math.floor(at / 1000)}`, "--", SNAPSHOT_DIR).trim();
  return sha === "" ? null : sha;
}

/** True for either form the nightly job writes (nightly.mjs isTableFile). */
export function isTableFile(table, name) {
  return name === `${table}.jsonl` || new RegExp(`^${table}\.part\d+\.jsonl\.gz$`).test(name);
}

/**
 * Every row of one table at one snapshot commit, keyed by _id. Handles both
 * forms planTableFiles writes: the plain .jsonl and the gzipped .partNN parts.
 */
export function snapshotRows(dir, sha, table) {
  const names = git(dir, "ls-tree", "--name-only", sha, "--", `${SNAPSHOT_DIR}/`)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => path.posix.basename(line))
    .filter((name) => isTableFile(table, name));
  const rows = new Map();
  for (const name of names) {
    const rel = `${SNAPSHOT_DIR}/${name}`;
    const raw = name.endsWith(".gz")
      ? zlib.gunzipSync(execFileSync("git", ["-C", dir, "show", `${sha}:${rel}`], {
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      })).toString("utf8")
      : git(dir, "show", `${sha}:${rel}`);
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row._id === "string") rows.set(row._id, row);
      } catch {
        // A truncated tail in an old snapshot is not worth failing an export.
      }
    }
  }
  return rows;
}

/** Lowercase, [a-z0-9-] only - the id has to be a filename. */
export function slug(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "none";
}

/** `<job>-<category>-<first 12 of the ruling id>`, stable across exports. */
export function goldenId(item) {
  const category = item.partition.includes("/") ? item.partition.split("/").slice(1).join("/") : item.partition;
  return `${slug(item.job)}-${slug(category)}-${String(item.rulingId).slice(0, 12)}`;
}

/**
 * The sentence the run that produced the judged output actually saw: the newest
 * APPLIED revise ruling on the same subject strictly before this one. Never the
 * sentence of the ruling being used as the label - handing the regeneration the
 * answer is exactly what would make the eval a lie.
 */
export function priorReviseSentence(item, allItems) {
  const key = JSON.stringify(item.subject);
  const earlier = allItems
    .filter((other) =>
      JSON.stringify(other.subject) === key &&
      other.verdict === "revise" &&
      other.ruledAt < item.ruledAt &&
      other.appliedAt !== null && other.appliedAt !== undefined &&
      typeof other.sentence === "string" && other.sentence !== "")
    .sort((a, b) => b.ruledAt - a.ruledAt);
  return earlier[0]?.sentence ?? null;
}

/** The New York calendar day of an instant, which is the `today` a prepare run
 *  was given and the day a bare month+day in the output resolves against. */
export function nyDay(at) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

/**
 * A golden item is compared text-for-text by a judge, so an item whose text
 * redactSecrets would change is DROPPED WHOLE rather than redacted and kept: a
 * "[redacted:github]" marker in the middle of an output is a difference the
 * judge would score, and the item is worthless anyway.
 */
export function hasCredentialShapedText(item) {
  const text = JSON.stringify(item);
  return redactSecrets(text) !== text;
}

/** One item in the golden-item file shape, or null when the snapshot cannot
 *  supply the output Tom actually ruled on. */
export function buildItem(candidate, snapshot, allCandidates) {
  const spec = JOB_TABLES[candidate.job];
  if (spec === undefined) return null;
  const row = snapshot.rows.get(candidate.resolution.rowId);
  if (row === undefined) return null;
  const output = {};
  for (const field of spec.fields) {
    if (row[field] !== undefined && row[field] !== null) output[field] = row[field];
  }
  if (Object.keys(output).length === 0) return null;
  // The input as it stood then, not as it stands now: the statement or the
  // category can have been edited since, and the output was written from the
  // older one.
  const input = { ...candidate.resolution.input };
  for (const field of ["statement", "source", "provenance", "category", "createdAt"]) {
    if (row[field] !== undefined) input[field] = row[field];
  }
  return {
    id: goldenId(candidate),
    job: candidate.job,
    partition: candidate.partition,
    verdict: candidate.verdict,
    sentence: candidate.sentence ?? null,
    ruledAt: candidate.ruledAt,
    ruledOn: nyDay(candidate.ruledAt),
    rulingId: candidate.rulingId,
    subject: candidate.subject,
    snapshot: { commit: snapshot.sha, path: `${SNAPSHOT_DIR}/${spec.table}.jsonl` },
    input: {
      ...input,
      priorReviseSentence: priorReviseSentence(candidate, allCandidates),
      today: nyDay(candidate.ruledAt),
    },
    output,
  };
}

/** Every item the input yields, with the counts that say what was lost and why. */
export function buildGoldenSet(candidates, readSnapshot) {
  const items = [];
  let unbuildable = 0;
  let redacted = 0;
  for (const candidate of candidates) {
    const spec = JOB_TABLES[candidate.job];
    const snapshot = spec === undefined ? null : readSnapshot(spec.table, candidate.ruledAt);
    if (snapshot === null) {
      unbuildable += 1;
      continue;
    }
    const item = buildItem(candidate, snapshot, candidates);
    if (item === null) {
      unbuildable += 1;
      continue;
    }
    if (hasCredentialShapedText(item)) {
      redacted += 1;
      continue;
    }
    items.push(item);
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  return { items, unbuildable, redacted };
}

export function summarise({ items, unbuildable, redacted }) {
  const partitions = new Set(items.map((item) => item.partition));
  const approve = items.filter((item) => item.verdict === "approve").length;
  return `golden set: ${items.length} items in ${partitions.size} partitions ` +
    `(${approve} approve, ${items.length - approve} revise); ` +
    `${unbuildable} rulings unbuildable (no snapshot), ${redacted} dropped (credential-shaped text).`;
}

function parseArgs(argv) {
  const options = { wikitom: DEFAULT_WIKITOM, out: DEFAULT_OUT, dryRun: false, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--list") options.list = true;
    else if (argument === "--wikitom" || argument === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${argument} needs a value`);
      options[argument === "--wikitom" ? "wikitom" : "out"] = value;
      index += 1;
    } else throw new Error(`unknown argument ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const site = process.env.CONVEX_SITE_URL;
  const key = process.env.TTS_WORKER_KEY;
  if (!site || !key) {
    console.error(
      "export-golden: CONVEX_SITE_URL and TTS_WORKER_KEY must be set - the exporter reads the ruling table in prod.",
    );
    process.exit(2);
  }
  const response = await fetch(`${site.replace(/\/+$/, "")}/tts/golden-input`, { headers: { "X-TTS-Key": key } });
  if (!response.ok) {
    console.error(`export-golden: /tts/golden-input -> HTTP ${response.status}`);
    process.exit(2);
  }
  const { items: candidates } = await response.json();
  const cache = new Map();
  const readSnapshot = (table, at) => {
    const sha = snapshotCommitAt(options.wikitom, at);
    if (sha === null) return null;
    const cacheKey = `${sha}:${table}`;
    if (!cache.has(cacheKey)) cache.set(cacheKey, { sha, rows: snapshotRows(options.wikitom, sha, table) });
    return cache.get(cacheKey);
  };
  const result = buildGoldenSet(candidates, readSnapshot);
  if (!options.dryRun) {
    fs.mkdirSync(options.out, { recursive: true });
    for (const name of fs.readdirSync(options.out)) {
      if (name.endsWith(".json")) fs.rmSync(path.join(options.out, name));
    }
    for (const item of result.items) {
      fs.writeFileSync(path.join(options.out, `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`);
    }
  }
  if (options.list) {
    for (const item of result.items) console.log(`${item.id}\t${item.partition}\t${item.verdict}\t${item.ruledOn}`);
  }
  console.log(summarise(result));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`export-golden: ${error.message}`);
    process.exit(2);
  });
}
