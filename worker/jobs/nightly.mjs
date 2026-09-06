#!/usr/bin/env node
// nightly.mjs — the nightly job (the lifeos update, phase 4). Runs at 4:00
// a.m. New York, before the 5 a.m. digest, and does five things in order,
// each one recording a "nightly-failure" dtsEvents row if it fails and then
// letting the next one run:
//
// Steps 1 to 4 write the checkout and run under /var/lock/tts-wikitom.lock,
// taken once around all four (the post reads HEAD and takes no lock):
//
//   1. snapshot — copies every Convex table (the six auth tables excepted)
//      into the WikiTom checkout at tts/snapshot/, one JSON-lines file per
//      table, deterministic, written only where the bytes changed.
//   2. learning — SKELETON: reads what Tom did yesterday (his session turns,
//      his Slack replies, his rulings) and records a "learning-run" row with
//      the counts and zero changes. What the full step will do is written
//      above learningStep below.
//   3. sessions — archives every Codex rollout and Claude SDK session file on
//      this box that WikiTom's sessions/ does not already hold at that
//      content, in phase 1's layout, and appends the manifest.
//   4. push — one commit per step that changed something, plus whatever an
//      earlier run left modified, `git pull --rebase`, `git push` over the
//      github.com-wikitom SSH alias. A refused pull or push is a failure row
//      and the commits stay local for the next night; nothing is retried.
//   5. post — reads the model-of-tom files at HEAD (writing.md,
//      priorities.md, schedule.md, and the "Current state" and "Must not
//      break" sections of every page under areas/) and posts them with the
//      commit hash and time to POST /tts/model-of-tom — whether or not the
//      push succeeded, so every prompt names the commit it began with.
//
// Then one "nightly-run" row with the summary, which the digest reads.
//
// Cron fires it at 08:00 AND 09:00 UTC; the NY-hour guard keeps the one that
// is 4 a.m. New York. By hand:
//   node /opt/tts/nightly.mjs --force                 # every step, now
//   node /opt/tts/nightly.mjs --force --only=post     # one step (or a list)
//
// THE WIKITOM CHECKOUT is /root/wikitom (setup.sh clones it over the alias
// when absent). It is the one durable-looking thing on this box that is not
// state: everything in it is either pushed or reproducible from Convex and
// the session files, and a lost checkout is one clone away. The deploy key
// at /root/.ssh/wikitom is readable by root only; this job never prints it,
// and never prints TTS_WORKER_KEY.
//
// Plain Node ESM, zero npm dependencies (tts-lib.mjs's rule): node:fs,
// node:zlib, node:crypto, node:child_process, and the global fetch.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEnv, convexFetch, nyHour } from "./tts-lib.mjs";
import { git } from "./tts-code-lib.mjs";

// ── Where things are ─────────────────────────────────────────────────────────
export const WIKITOM_DIR = process.env.WIKITOM_DIR || "/root/wikitom";
export const WIKITOM_LOCK = "/var/lock/tts-wikitom.lock";
// The SSH alias setup.sh clones over (Host github.com-wikitom in
// /root/.ssh/config → the deploy key /root/.ssh/wikitom). The checkout's
// origin carries it, so `git pull` and `git push` need no URL here.
export const WIKITOM_REMOTE = "git@github.com-wikitom:Heffnt/WikiTom.git";
export const SNAPSHOT_DIR = "tts/snapshot";
export const SESSIONS_DIR = "sessions";
export const CODEX_SESSIONS_DIR = "/root/.codex/sessions";
export const CLAUDE_ACCOUNTS_DIR = "/root/.claude-accounts";
// Where a table's files are assembled before they replace the checkout's:
// outside the work tree, so a failed export leaves tts/snapshot/ as it was.
export const SNAPSHOT_STAGING_DIR = "/var/cache/tts/snapshot-staging";

// A file over 90 MB is split into gzipped parts (phase 1's rule; GitHub
// refuses a blob over 100 MB, and the same threshold applies forever).
export const SPLIT_BYTES = 90 * 1024 * 1024;
export const EXPORT_PAGE = 200;
export const LOCK_WAIT_SECONDS = 600;

// The model-of-tom files, in the order they are posted. The server orders
// them again (convex/ttsSkills.ts orderModelOfTom) — that is the authority;
// this is only the order this job reads in.
export const MODEL_OF_TOM_FIRST = [
  "model-of-tom/writing.md",
  "model-of-tom/priorities.md",
  "model-of-tom/schedule.md",
];
export const MODEL_OF_TOM_AREAS_DIR = "model-of-tom/areas";
export const AREA_SECTIONS = ["Current state", "Must not break"];

// The committer identity every git command in the checkout writes under. It is
// ALSO set in the checkout's own config by setup.sh, and both homes are needed:
// `git commit` here names it on the command line, but `git pull --rebase`
// re-commits local work through git's own machinery, which reads the config and
// dies without one. The author names the job, which is how the digest tells the
// box's commits from Tom's.
export const GIT_IDENTITY = [
  "-c", "user.name=tts-nightly",
  "-c", "user.email=tts-nightly@tom.quest",
];

const STEPS = ["snapshot", "learning", "sessions", "push", "post"];
// The four that write the WikiTom checkout, and so run under one lock.
const LOCKED_STEPS = ["snapshot", "learning", "sessions", "push"];
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Small pure helpers (tested in nightly.test.mjs) ──────────────────────────

export function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** YYYY-MM-DD of an instant, in UTC (the manifest's and the layout's date). */
export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * One row as one line, deterministically: keys sorted at every level, the
 * `{ "k": v, ... }` spacing phase 1's files use, so an unchanged table hashes
 * to the same bytes night after night and a changed one diffs by row.
 */
export function serializeRow(value) {
  if (Array.isArray(value)) return `[${value.map(serializeRow).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return "{}";
    return `{ ${keys.map((k) => `${JSON.stringify(k)}: ${serializeRow(value[k])}`).join(", ")} }`;
  }
  return JSON.stringify(value);
}

/**
 * The file (or gzipped parts) one table becomes. Rows arrive oldest first
 * from the export and are written newest first (phase 1's order). A table
 * whose lines exceed SPLIT_BYTES becomes `<table>.partNN.jsonl.gz`, each
 * part's raw slice under the limit and gzipped on its own so any part reads
 * alone; a smaller table is one plain `<table>.jsonl`.
 */
export function planTableFiles(table, rows, limit = SPLIT_BYTES) {
  const lines = rows.map((row) => `${serializeRow(row)}\n`).reverse();
  const total = lines.reduce((n, l) => n + Buffer.byteLength(l), 0);
  if (total <= limit) {
    return [{ name: `${table}.jsonl`, bytes: Buffer.from(lines.join("")) }];
  }
  const files = [];
  let chunk = [];
  let chunkBytes = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    const name = `${table}.part${String(files.length).padStart(2, "0")}.jsonl.gz`;
    files.push({ name, bytes: gzip(Buffer.from(chunk.join(""))) });
    chunk = [];
    chunkBytes = 0;
  };
  for (const line of lines) {
    const size = Buffer.byteLength(line);
    if (chunkBytes + size > limit) flush();
    chunk.push(line);
    chunkBytes += size;
  }
  flush();
  return files;
}

/** Whether a snapshot file name belongs to `table` (its whole file or a part). */
export function isTableFile(table, name) {
  return name === `${table}.jsonl` || new RegExp(`^${table}\\.part\\d+\\.jsonl\\.gz$`).test(name);
}

// gzip with no name or mtime in the header (Node writes neither), so the
// same input gives the same bytes and hashes compare across nights.
export function gzip(bytes) {
  return zlib.gzipSync(bytes, { level: 9 });
}

/**
 * The sections of a markdown page headed by any of `headings` (case-
 * insensitive), each running from its heading line to the next heading of
 * the same or a higher level, returned in the order of `headings` and joined
 * by a blank line. "" when the page has none of them.
 */
export function extractSections(markdown, headings = AREA_SECTIONS) {
  const lines = markdown.split(/\r?\n/);
  const wanted = headings.map((h) => h.trim().toLowerCase());
  const found = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    const key = m[2].trim().toLowerCase();
    if (!wanted.includes(key) || found.has(key)) continue;
    const level = m[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const n = /^(#{1,6})\s+\S/.exec(lines[j]);
      if (n && n[1].length <= level) {
        end = j;
        break;
      }
    }
    found.set(key, lines.slice(i, end).join("\n").trim());
  }
  return wanted
    .filter((k) => found.has(k))
    .map((k) => found.get(k))
    .join("\n\n");
}

/**
 * The files to post from a WikiTom checkout: the three named files that
 * exist, then each page under areas/ (alphabetically) reduced to its
 * AREA_SECTIONS. `missing` names the expected files that were not there —
 * a post still goes out with the rest, and the caller records the gap.
 */
export function collectModelOfTomFiles(dir) {
  const files = [];
  const missing = [];
  for (const rel of MODEL_OF_TOM_FIRST) {
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    const body = fs.readFileSync(abs, "utf8");
    if (body.trim() === "") missing.push(rel);
    else files.push({ path: rel, body });
  }
  const areas = path.join(dir, MODEL_OF_TOM_AREAS_DIR);
  if (fs.existsSync(areas)) {
    const pages = fs
      .readdirSync(areas)
      .filter((n) => n.endsWith(".md"))
      .sort();
    for (const page of pages) {
      const body = extractSections(fs.readFileSync(path.join(areas, page), "utf8"));
      if (body === "") continue;
      files.push({ path: `${MODEL_OF_TOM_AREAS_DIR}/${page}`, body });
    }
  }
  return { files, missing };
}

/**
 * The date a session file belongs to: the first `timestamp` found in its
 * first lines (a Claude SDK line carries one at the top level; a Codex
 * rollout's session_meta line carries one at the top level and inside its
 * payload), else the file's mtime. Returns { date, dateSource }.
 */
export function sessionDateOf(head, mtimeMs) {
  for (const line of head.split("\n").slice(0, 20)) {
    if (line.trim() === "") continue;
    try {
      const obj = JSON.parse(line);
      const ts = obj?.timestamp ?? obj?.payload?.timestamp;
      if (typeof ts === "string" && !Number.isNaN(Date.parse(ts))) {
        return { date: utcDay(Date.parse(ts)), dateSource: "timestamp" };
      }
    } catch {
      // not JSON — keep looking
    }
  }
  return { date: utcDay(mtimeMs), dateSource: "mtime" };
}

/** A Codex rollout's identity from its session_meta line: the thread id and,
 * for a subagent thread, the parent's. Null when the head is not a rollout. */
export function codexMetaOf(head) {
  const first = head.split("\n").find((l) => l.trim() !== "");
  if (!first) return null;
  try {
    const obj = JSON.parse(first);
    if (obj?.type !== "session_meta") return null;
    const p = obj.payload ?? {};
    const id = typeof p.id === "string" ? p.id : null;
    if (!id) return null;
    const parent =
      typeof p.parent_thread_id === "string" && p.parent_thread_id !== id
        ? p.parent_thread_id
        : null;
    return { id, parent, cwd: typeof p.cwd === "string" ? p.cwd : null };
  } catch {
    return null;
  }
}

/** The first bytes of a file as text — enough lines to find a timestamp. */
function headOf(file, bytes = 64 * 1024) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// Attachments that are already compressed, or binary, are stored raw (phase
// 1 stored a PDF raw); everything else is gzipped.
const RAW_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip", ".gz"]);

/**
 * Every session file on this box, described but not read: Codex rollouts
 * under `codexDir`/YYYY/MM/DD/ and Claude SDK files under
 * `accountsDir`/<account>/projects/<project>/ (the parent transcript
 * `<id>.jsonl`, and everything under `<id>/`: .jsonl children, other files
 * as attachments). The `active` symlink under the accounts dir is skipped —
 * it is one of the real accounts under another name.
 */
export function discoverSessionFiles({ codexDir, accountsDir }) {
  const out = [];
  if (fs.existsSync(codexDir)) {
    walk(codexDir, (file) => {
      if (!file.endsWith(".jsonl")) return;
      out.push({ runtime: "codex", account: null, source: file });
    });
  }
  if (fs.existsSync(accountsDir)) {
    for (const entry of fs.readdirSync(accountsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const projects = path.join(accountsDir, entry.name, "projects");
      if (!fs.existsSync(projects)) continue;
      for (const proj of fs.readdirSync(projects, { withFileTypes: true })) {
        if (!proj.isDirectory()) continue;
        const projDir = path.join(projects, proj.name);
        for (const item of fs.readdirSync(projDir, { withFileTypes: true })) {
          const abs = path.join(projDir, item.name);
          if (item.isFile() && item.name.endsWith(".jsonl")) {
            out.push({
              runtime: "claude",
              account: entry.name,
              project: proj.name,
              session: item.name.slice(0, -".jsonl".length),
              kind: "parent",
              source: abs,
            });
          } else if (item.isDirectory()) {
            walk(abs, (file) => {
              out.push({
                runtime: "claude",
                account: entry.name,
                project: proj.name,
                session: item.name,
                kind: file.endsWith(".jsonl") ? "child" : "attachment",
                rel: path.relative(abs, file).split(path.sep).join("/"),
                source: file,
              });
            });
          }
        }
      }
    }
  }
  out.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  return out;
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, visit);
    else if (entry.isFile()) visit(abs);
  }
}

/** Every line of every manifest-*.jsonl under sessions/, parsed. */
export function readManifests(sessionsDir) {
  const entries = [];
  if (!fs.existsSync(sessionsDir)) return entries;
  for (const name of fs.readdirSync(sessionsDir).sort()) {
    if (!/^manifest-.*\.jsonl$/.test(name)) continue;
    for (const line of fs.readFileSync(path.join(sessionsDir, name), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // a torn line is not a reason to re-archive everything
      }
    }
  }
  return entries;
}

/**
 * What the manifests already say, indexed for the archive step: the content
 * hash last archived for each source path (a file that grew since is
 * archived again), the directory each parent session was archived into (so a
 * child lands beside its parent), and which accounts each Claude session id
 * has been seen under (so a second account's copy sits in its own subdir).
 */
export function indexManifests(entries) {
  const shaBySource = new Map();
  const dirBySession = new Map();
  const accountsBySession = new Map();
  for (const e of entries) {
    if (typeof e.source === "string" && typeof e.sha256 === "string") {
      shaBySource.set(e.source, e.sha256);
    }
    if (e.kind === "parent" && typeof e.dest === "string" && typeof e.session === "string") {
      const key = `${e.runtime}:${e.session}`;
      if (!dirBySession.has(key)) {
        dirBySession.set(key, e.dest.slice(0, e.dest.lastIndexOf("/")));
      }
    }
    if (e.runtime === "claude" && typeof e.session === "string" && e.account) {
      const set = accountsBySession.get(e.session) ?? new Set();
      set.add(e.account);
      accountsBySession.set(e.session, set);
    }
  }
  return { shaBySource, dirBySession, accountsBySession };
}

// ── The run ──────────────────────────────────────────────────────────────────

/** Record a failed step: the cron log, and a dtsEvents row the digest reads. */
async function recordFailure(run, step, err) {
  const error = String(err?.message ?? err).slice(0, 2000);
  console.error(`[nightly] ${step} FAILED: ${error}`);
  run.failures.push({ step, error });
  try {
    await convexFetch(run.env, "/tts/event", {
      kind: "nightly-failure",
      data: { day: run.day, step, error },
    });
  } catch (postErr) {
    console.error(`[nightly] could not record the ${step} failure: ${postErr.message}`);
  }
}

// ── 1. snapshot ──────────────────────────────────────────────────────────────
async function snapshotStep(run) {
  const { env } = run;
  const boundary = run.now;
  const { tables } = await convexFetch(env, "/tts/export");
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new Error("/tts/export listed no tables");
  }
  fs.rmSync(SNAPSHOT_STAGING_DIR, { recursive: true, force: true });
  fs.mkdirSync(SNAPSHOT_STAGING_DIR, { recursive: true });
  const counts = {};
  // Every table is fetched and assembled in the staging dir first; only a
  // complete set replaces the checkout's, so a failure part-way leaves last
  // night's copy whole rather than a mix of two nights.
  for (const table of tables) {
    const rows = [];
    let cursor = null;
    for (;;) {
      const params = new URLSearchParams({
        table,
        boundary: String(boundary),
        numItems: String(EXPORT_PAGE),
      });
      if (cursor !== null) params.set("cursor", cursor);
      const page = await convexFetch(env, `/tts/export?${params}`);
      for (const row of page.rows) rows.push(row);
      if (page.isDone) break;
      // EXPORT_PAGE is a ceiling, not a promise: the server ends a page at its
      // byte budget too (a table of 256KB rows would otherwise ask for more
      // than one query may read), so a page can be one row. The cursor must
      // move every time — a server that stopped advancing it would spin here.
      if (page.continueCursor === cursor) {
        throw new Error(`/tts/export did not advance its cursor for ${table} — stopped at ${rows.length} rows`);
      }
      cursor = page.continueCursor;
    }
    counts[table] = rows.length;
    for (const f of planTableFiles(table, rows)) {
      fs.writeFileSync(path.join(SNAPSHOT_STAGING_DIR, f.name), f.bytes);
    }
  }
  const changed = syncSnapshot(path.join(run.dir, SNAPSHOT_DIR), SNAPSHOT_STAGING_DIR, tables);
  fs.rmSync(SNAPSHOT_STAGING_DIR, { recursive: true, force: true });
  const rowTotal = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(
    `[nightly] snapshot: ${tables.length} tables, ${rowTotal} rows, ${changed.length} file(s) changed`,
  );
  if (changed.length > 0) {
    run.commits.push({
      paths: [SNAPSHOT_DIR],
      message: `snapshot: ${run.day} — ${tables.length} tables, ${rowTotal} rows, ${changed.length} file${changed.length === 1 ? "" : "s"} changed`,
    });
  }
  return { tables: tables.length, rows: rowTotal, changed, counts };
}

/**
 * Replace the checkout's snapshot files with the staged set: write a file
 * only when its hash differs, remove a table's file that the staged set no
 * longer has (a table that crossed the split threshold either way). Returns
 * the names written or removed. README.md and anything not a table file
 * stay untouched.
 */
export function syncSnapshot(snapshotDir, stagingDir, tables) {
  fs.mkdirSync(snapshotDir, { recursive: true });
  const changed = [];
  const staged = new Set(fs.readdirSync(stagingDir));
  for (const name of staged) {
    const bytes = fs.readFileSync(path.join(stagingDir, name));
    const dest = path.join(snapshotDir, name);
    if (fs.existsSync(dest) && sha256(fs.readFileSync(dest)) === sha256(bytes)) continue;
    fs.writeFileSync(dest, bytes);
    changed.push(name);
  }
  for (const name of fs.readdirSync(snapshotDir)) {
    if (staged.has(name)) continue;
    if (!tables.some((t) => isTableFile(t, name))) continue;
    fs.rmSync(path.join(snapshotDir, name));
    changed.push(name);
  }
  return changed.sort();
}

// ── 2. learning (skeleton) ───────────────────────────────────────────────────
// WHAT THE FULL STEP WILL DO (design section 4, "Learning"; a later PR): for
// each of yesterday's sessions Tom took part in, each threaded Slack reply of
// his, and each ruling, one model call proposes lines for the model-of-tom
// files — factual lines with the date and the evidence (the turn, the reply,
// the ruling, quoted) — never Tom's directions section, never an ideal-state
// or must-not-break line, never the spec. Each accepted change is one
// "learning-change" dtsEvents row with an id, the file, the base hash, the
// text before and after, its source, and the commit it lands in; the 5 a.m.
// digest lists every line with its evidence; an objection reply in the
// digest thread writes an event, and the NEXT night applies the inverse
// first and the next digest reports the reversal. Auto-compact and
// auto-memory stay off in learning runs (ruling 10).
//
// THIS PR: the read, and a "learning-run" row with the counts and zero
// changes, so the digest's "what the nightly job wrote" has a row to read
// from the first night.
async function learningStep(run) {
  const until = run.now;
  const since = until - DAY_MS;
  const input = await convexFetch(
    run.env,
    `/tts/learning-input?since=${since}&until=${until}`,
  );
  const summary = {
    day: run.day,
    since,
    until,
    tomTurns: input.tomTurns.length,
    sessions: new Set(input.tomTurns.map((t) => t.sessionId)).size,
    slackReplies: input.slackReplies.length,
    rulings: input.rulings.length,
    changes: 0,
    note: "skeleton — reads the inputs and writes no learning-change rows yet",
  };
  await convexFetch(run.env, "/tts/event", { kind: "learning-run", data: summary });
  console.log(
    `[nightly] learning: ${summary.tomTurns} turns of Tom's in ${summary.sessions} sessions, ${summary.slackReplies} Slack replies, ${summary.rulings} rulings — 0 changes (skeleton)`,
  );
  return summary;
}

// ── 3. sessions ──────────────────────────────────────────────────────────────
async function sessionsStep(run) {
  const sessionsDir = path.join(run.dir, SESSIONS_DIR);
  const index = indexManifests(readManifests(sessionsDir));
  const files = discoverSessionFiles({
    codexDir: CODEX_SESSIONS_DIR,
    accountsDir: CLAUDE_ACCOUNTS_DIR,
  });
  const manifestPath = path.join(sessionsDir, `manifest-box-${run.day}.jsonl`);
  const archived = [];
  // Parents first, so a child archived the same night finds its parent's
  // directory; then children and attachments; Codex rollouts sort by their
  // own metadata below.
  const order = (f) => (f.runtime === "codex" ? 1 : f.kind === "parent" ? 0 : 2);
  const claudeAccounts = new Map();
  for (const f of files) {
    if (f.runtime !== "claude") continue;
    const set = claudeAccounts.get(f.session) ?? new Set(index.accountsBySession.get(f.session) ?? []);
    set.add(f.account);
    claudeAccounts.set(f.session, set);
  }
  const codexEntries = [];
  for (const f of [...files].sort((a, b) => order(a) - order(b))) {
    const raw = fs.readFileSync(f.source);
    const sha = sha256(raw);
    if (index.shaBySource.get(f.source) === sha) continue; // archived at this content already
    const mtimeMs = fs.statSync(f.source).mtimeMs;
    let entry;
    if (f.runtime === "codex") {
      const meta = codexMetaOf(headOf(f.source));
      if (!meta) {
        console.error(`[nightly] sessions: not a Codex rollout, skipped: ${f.source}`);
        continue;
      }
      // Children wait until every parent of this run is placed.
      codexEntries.push({ f, raw, sha, mtimeMs, meta });
      continue;
    }
    entry = claudeEntry(f, raw, sha, mtimeMs, index, claudeAccounts);
    if (!entry) continue;
    archived.push(writeArchived(run.dir, manifestPath, entry, raw, index));
  }
  for (const c of codexEntries.filter((c) => c.meta.parent === null)) {
    archived.push(writeArchived(run.dir, manifestPath, codexParentEntry(c), c.raw, index));
  }
  for (const c of codexEntries.filter((c) => c.meta.parent !== null)) {
    archived.push(writeArchived(run.dir, manifestPath, codexChildEntry(c, index), c.raw, index));
  }
  console.log(`[nightly] sessions: ${archived.length} file(s) archived`);
  if (archived.length > 0) {
    run.commits.push({
      paths: [SESSIONS_DIR],
      message: `sessions: ${run.day} — ${archived.length} file${archived.length === 1 ? "" : "s"} archived from the box`,
    });
  }
  return { archived: archived.length };
}

/** The manifest entry for a Claude SDK file (parent, child or attachment). */
export function claudeEntry(f, raw, sha, mtimeMs, index, accountsBySession) {
  const key = `claude:${f.session}`;
  // Two accounts holding the same session id sit side by side under the
  // account's name (phase 1's layout); one account is the flat layout.
  const accounts = accountsBySession.get(f.session) ?? new Set([f.account]);
  const perAccount = accounts.size > 1;
  let dir = index.dirBySession.get(key);
  let date;
  let dateSource;
  if (f.kind === "parent") {
    ({ date, dateSource } = sessionDateOf(raw.subarray(0, 64 * 1024).toString("utf8"), mtimeMs));
    dir = `${SESSIONS_DIR}/${date.replaceAll("-", "/")}/claude-${f.session}${perAccount ? `/${f.account}` : ""}`;
    index.dirBySession.set(key, dir);
  } else {
    if (dir === undefined) {
      // A child whose parent is not archived (an orphan): its own date.
      ({ date, dateSource } = sessionDateOf(
        f.kind === "child" ? raw.subarray(0, 64 * 1024).toString("utf8") : "",
        mtimeMs,
      ));
      dir = `${SESSIONS_DIR}/${date.replaceAll("-", "/")}/claude-${f.session}${perAccount ? `/${f.account}` : ""}`;
    } else {
      date = dir.split("/").slice(1, 4).join("-");
      dateSource = "parent";
    }
    if (perAccount && !dir.endsWith(`/${f.account}`)) dir = `${dir}/${f.account}`;
  }
  const orphan = f.kind !== "parent" && !index.dirBySession.has(key);
  const ext = path.extname(f.source).toLowerCase();
  const encoding = f.kind === "attachment" && RAW_EXTENSIONS.has(ext) ? "raw" : "gzip";
  const rel =
    f.kind === "parent"
      ? "session.jsonl"
      : `${f.kind === "child" ? "children" : "attachments"}/${f.rel}`;
  return {
    session: f.session,
    project: f.project,
    date,
    date_source: dateSource,
    orphan,
    host: "box",
    account: f.account,
    runtime: "claude",
    parent: f.kind === "parent" ? null : f.session,
    kind: f.kind,
    source: f.source,
    dest: `${dir}/${rel}${encoding === "gzip" ? ".gz" : ""}`,
    raw_bytes: raw.length,
    sha256: sha,
    encoding,
  };
}

function codexParentEntry({ f, raw, sha, mtimeMs, meta }) {
  const { date, dateSource } = sessionDateOf(raw.subarray(0, 64 * 1024).toString("utf8"), mtimeMs);
  const dir = `${SESSIONS_DIR}/${date.replaceAll("-", "/")}/codex-${meta.id}`;
  return {
    session: meta.id,
    project: meta.cwd,
    date,
    date_source: dateSource,
    orphan: false,
    host: "box",
    account: null,
    runtime: "codex",
    parent: null,
    kind: "parent",
    source: f.source,
    dest: `${dir}/rollout.jsonl.gz`,
    raw_bytes: raw.length,
    sha256: sha,
    encoding: "gzip",
    _dir: dir,
  };
}

function codexChildEntry({ f, raw, sha, mtimeMs, meta }, index) {
  const key = `codex:${meta.parent}`;
  let dir = index.dirBySession.get(key);
  let date;
  let dateSource;
  const orphan = dir === undefined;
  if (orphan) {
    ({ date, dateSource } = sessionDateOf(raw.subarray(0, 64 * 1024).toString("utf8"), mtimeMs));
    dir = `${SESSIONS_DIR}/${date.replaceAll("-", "/")}/codex-${meta.parent}`;
  } else {
    date = dir.split("/").slice(1, 4).join("-");
    dateSource = "parent";
  }
  return {
    session: meta.parent,
    project: meta.cwd,
    date,
    date_source: dateSource,
    orphan,
    host: "box",
    account: null,
    runtime: "codex",
    parent: meta.parent,
    kind: "child",
    source: f.source,
    dest: `${dir}/children/${meta.id}.jsonl.gz`,
    raw_bytes: raw.length,
    sha256: sha,
    encoding: "gzip",
  };
}

/**
 * Write one archived file under the checkout and append its manifest line.
 * A raw file over SPLIT_BYTES is stored as gzipped parts named after the
 * destination (`<name>.partNN.gz`), listed in `parts`; the manifest is the
 * only reader that needs to know.
 */
export function writeArchived(checkoutDir, manifestPath, entry, raw, index) {
  const { _dir, ...line } = entry;
  const destAbs = path.join(checkoutDir, line.dest);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  let stored = 0;
  let parts = null;
  if (line.encoding === "raw") {
    fs.writeFileSync(destAbs, raw);
    stored = raw.length;
  } else if (raw.length <= SPLIT_BYTES) {
    const bytes = gzip(raw);
    fs.writeFileSync(destAbs, bytes);
    stored = bytes.length;
  } else {
    parts = [];
    const base = line.dest.replace(/\.gz$/, "");
    for (let i = 0, offset = 0; offset < raw.length; i++, offset += SPLIT_BYTES) {
      const name = `${base}.part${String(i).padStart(2, "0")}.gz`;
      const bytes = gzip(raw.subarray(offset, offset + SPLIT_BYTES));
      fs.writeFileSync(path.join(checkoutDir, name), bytes);
      stored += bytes.length;
      parts.push(name);
    }
    if (fs.existsSync(destAbs)) fs.rmSync(destAbs);
  }
  // Phase 1's columns, in phase 1's order.
  const record = {
    session: line.session,
    project: line.project,
    date: line.date,
    date_source: line.date_source,
    orphan: line.orphan,
    host: line.host,
    account: line.account,
    runtime: line.runtime,
    parent: line.parent,
    kind: line.kind,
    source: line.source,
    dest: line.dest,
    raw_bytes: line.raw_bytes,
    stored_bytes: stored,
    sha256: line.sha256,
    encoding: line.encoding,
    parts,
  };
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.appendFileSync(manifestPath, `${JSON.stringify(record)}\n`);
  index.shaBySource.set(line.source, line.sha256);
  if (line.kind === "parent" && _dir) index.dirBySession.set(`${line.runtime}:${line.session}`, _dir);
  return record;
}

// ── 4. the push ──────────────────────────────────────────────────────────────
/**
 * Hold /var/lock/tts-wikitom.lock for the duration of `fn`. The lock is the
 * open file description: `flock` takes it on our inherited descriptor and
 * exits, and the kernel keeps it for us until we close the descriptor — the
 * `exec 3>lock; flock 3` idiom, from Node. Every other writer of the
 * checkout (the weekly job, a session-end archive) takes the same lock.
 *
 * THE LOCK COVERS THE WRITES, not only the push: main() holds it around steps
 * 1 to 4 together. A lock held around the commit alone protects nothing —
 * another writer committing its own work while this job is still writing
 * tts/snapshot/ and sessions/ would carry half of tonight's tree into its
 * commit, and `git pull --rebase` would meet a dirty tree it did not make.
 */
export async function withWikiTomLock(fn, lockPath = WIKITOM_LOCK) {
  const fd = fs.openSync(lockPath, "w");
  try {
    execFileSync("flock", ["-w", String(LOCK_WAIT_SECONDS), "3"], {
      stdio: ["ignore", "inherit", "inherit", fd],
    });
    return await fn();
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Whether git stopped part-way through a rebase in `dir` — the directory it
 * leaves behind when a `pull --rebase` hit a conflict or died (no committer
 * identity, an interrupted run). Nothing later works in that state: `git
 * commit` refuses, and so does the next night's pull, FOREVER.
 */
export function rebaseInProgress(dir) {
  const gitDir = gitCapture(dir, "rev-parse", "--git-dir").trim();
  const abs = path.isAbsolute(gitDir) ? gitDir : path.join(dir, gitDir);
  return (
    fs.existsSync(path.join(abs, "rebase-merge")) || fs.existsSync(path.join(abs, "rebase-apply"))
  );
}

/** `git add -A` over the paths that exist in the tree or in the index — git
 * refuses a pathspec matching neither, and sessions/ or tts/snapshot/ can be
 * absent on a fresh checkout. */
function addPaths(dir, paths) {
  const present = paths.filter((p) => {
    if (fs.existsSync(path.join(dir, p))) return true;
    try {
      return gitCapture(dir, "ls-files", "--", p).trim() !== "";
    } catch {
      return false;
    }
  });
  if (present.length > 0) git(dir, "add", "-A", "--", ...present);
}

/**
 * Abort a rebase an earlier run left in progress, as its own failure row.
 * While one is in progress git refuses to commit at all, so the checkout would
 * never commit or push again on its own — and `git rebase --abort` resets the
 * work tree hard, which is why THE RUN CALLS THIS BEFORE ITS FIRST WRITE (see
 * main): after the snapshot has been written, the abort would take tonight's
 * files with it. It is called again from commitTree as a last guard, where in
 * a normal run it finds nothing to do.
 */
export function abortStaleRebase(dir) {
  if (!rebaseInProgress(dir)) return [];
  try {
    execFileSync("git", ["-C", dir, "rebase", "--abort"], { stdio: "ignore" });
    return [
      {
        step: "rebase",
        error: `a rebase from an earlier run was still in progress in ${dir} — aborted it; nothing could be committed until it was`,
      },
    ];
  } catch (err) {
    return [{ step: "rebase", error: gitError(err) }];
  }
}

/**
 * Commit the checkout: one commit per step that changed something, and then —
 * ALWAYS, whatever this run's own change list says — everything still modified
 * under tts/snapshot/ and sessions/.
 *
 * WHY THE SWEEP: a run that died after writing files (a crashed export, a
 * killed process, a step whose failure row was recorded and skipped) leaves
 * tracked files modified. The next night's `git pull --rebase` refuses a dirty
 * tree and would go on refusing every night after, with nothing in the
 * checkout ever reaching GitHub again. Committing the leftovers is what makes
 * the next night recoverable; the snapshot is deterministic and the archive is
 * append-only, so committing them is never wrong, only sometimes redundant.
 *
 * A rebase left in progress by an earlier run is aborted first, as its own
 * failure row: while one is in progress git refuses to commit at all.
 */
export function commitTree(dir, commits, day) {
  const made = [];
  const failures = abortStaleRebase(dir);
  for (const c of commits) {
    addPaths(dir, c.paths);
    if (!stagedChanges(dir)) continue;
    git(dir, ...GIT_IDENTITY, "commit", "-q", "-m", c.message);
    made.push(c.message);
  }
  addPaths(dir, [SNAPSHOT_DIR, SESSIONS_DIR]);
  if (stagedChanges(dir)) {
    const message = `nightly: ${day} — changes an earlier run left uncommitted`;
    git(dir, ...GIT_IDENTITY, "commit", "-q", "-m", message);
    made.push(message);
  }
  return { made, failures };
}

/**
 * `git pull --rebase` then `git push`, each refusal a failure row rather than
 * a throw. Local commits from earlier nights whose push was refused are ahead
 * of origin too; the rebase and the push carry them together.
 */
export function syncRemote(dir) {
  let pulled = false;
  let pushed = false;
  const failures = [];
  try {
    // The identity again: a rebase of local commits onto origin re-commits
    // them, and git refuses to without one.
    gitCapture(dir, ...GIT_IDENTITY, "pull", "--rebase", "--quiet");
    pulled = true;
  } catch (err) {
    failures.push({ step: "pull", error: gitError(err) });
    // A rebase left half-done would block every later commit: abort it.
    try {
      execFileSync("git", ["-C", dir, "rebase", "--abort"], { stdio: "ignore" });
    } catch {
      // no rebase in progress
    }
  }
  if (pulled) {
    try {
      gitCapture(dir, "push", "--quiet");
      pushed = true;
    } catch (err) {
      failures.push({ step: "push", error: gitError(err) });
    }
  }
  return { pulled, pushed, failures };
}

async function pushStep(run) {
  const dir = run.dir;
  const committed = commitTree(dir, run.commits, run.day);
  const sync = syncRemote(dir);
  for (const f of [...committed.failures, ...sync.failures]) {
    await recordFailure(run, f.step, new Error(f.error));
  }
  console.log(
    `[nightly] push: ${committed.made.length} commit(s) made, pull ${sync.pulled ? "ok" : "FAILED"}, push ${sync.pushed ? "ok" : "not done — commits stay local"}`,
  );
  return { commits: committed.made, pulled: sync.pulled, pushed: sync.pushed };
}

// The two commands that talk to GitHub, with stderr CAPTURED rather than
// passed to the cron log: their refusal ("Permission denied (publickey)",
// "rejected") is what the failure row carries for the digest. Nothing
// secret is in it — the deploy key is a file, never a string in a URL.
function gitCapture(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// `git diff --cached --quiet` exits 1 when the index differs from HEAD.
function stagedChanges(dir) {
  try {
    execFileSync("git", ["-C", dir, "diff", "--cached", "--quiet"], { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

// git's own words, which live on stderr; execFileSync's message alone is the
// command and the exit code. The alias's host key and the key path may appear;
// no credential does (a deploy key is a file, not a string in a URL).
function gitError(err) {
  const msg = String(err?.message ?? err).trim();
  const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
  return (stderr && !msg.includes(stderr) ? `${msg}\n${stderr}` : msg).slice(0, 2000);
}

// ── 5. the post ──────────────────────────────────────────────────────────────
async function postStep(run) {
  const dir = run.dir;
  const commit = git(dir, "rev-parse", "HEAD").trim();
  const committedAt = Number(git(dir, "log", "-1", "--format=%ct").trim()) * 1000;
  const { files, missing } = collectModelOfTomFiles(dir);
  if (missing.length > 0) {
    await recordFailure(
      run,
      "post",
      new Error(`model-of-tom files missing or empty at ${commit.slice(0, 12)}: ${missing.join(", ")}`),
    );
  }
  if (files.length === 0) throw new Error("no model-of-tom files to post");
  const res = await convexFetch(run.env, "/tts/model-of-tom", {
    commit,
    committedAt,
    files,
  });
  console.log(
    `[nightly] post: ${res.files} file(s) at WikiTom ${commit.slice(0, 12)} — ${files.map((f) => f.path).join(", ")}`,
  );
  return { commit, files: files.map((f) => f.path) };
}

// ── main ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const force = argv.includes("--force");
  const onlyArg = argv.find((a) => a.startsWith("--only="));
  const only = onlyArg ? onlyArg.slice("--only=".length).split(",").filter(Boolean) : STEPS;
  for (const s of only) {
    if (!STEPS.includes(s)) throw new Error(`unknown step "${s}" — one of ${STEPS.join(", ")}`);
  }
  return { force, only };
}

async function main() {
  const { force, only } = parseArgs(process.argv.slice(2));
  const now = Date.now();
  // The DST guard (prepare-queue.mjs's): cron fires at 08:00 and 09:00 UTC
  // and exactly one is the 4 a.m. New York hour.
  if (!force && nyHour(now) !== 4) {
    console.log(
      `[nightly] NY hour is ${nyHour(now)}, not 4 — this is the off-season cron slot, exiting (use --force to override)`,
    );
    return;
  }
  const env = loadEnv();
  const run = {
    env,
    now,
    day: utcDay(now),
    dir: WIKITOM_DIR,
    commits: [],
    failures: [],
    results: {},
  };
  if (!fs.existsSync(path.join(run.dir, ".git"))) {
    throw new Error(`${run.dir} is not a git checkout — setup.sh clones WikiTom there`);
  }
  const steps = {
    snapshot: snapshotStep,
    learning: learningStep,
    sessions: sessionsStep,
    push: pushStep,
    post: postStep,
  };
  const runStep = async (name) => {
    try {
      run.results[name] = await steps[name](run);
    } catch (err) {
      await recordFailure(run, name, err);
    }
  };
  // Steps 1 to 4 WRITE the checkout, so the lock covers all four (see
  // withWikiTomLock). The post is a read of HEAD and takes no lock, which is
  // also what lets `--only=post` run while another writer holds it.
  const locked = LOCKED_STEPS.filter((name) => only.includes(name));
  if (locked.length > 0) {
    try {
      await withWikiTomLock(async () => {
        // Before the first write: a rebase an earlier run left in progress
        // stops every commit, and aborting it resets the work tree hard — so
        // it happens while there is nothing of tonight's to lose.
        for (const f of abortStaleRebase(run.dir)) {
          await recordFailure(run, f.step, new Error(f.error));
        }
        for (const name of locked) await runStep(name);
      });
    } catch (err) {
      // The lock itself was refused — another writer held it past the wait.
      // Every step it covers is skipped; the post below still runs.
      await recordFailure(run, "lock", err);
    }
  }
  if (only.includes("post")) await runStep("post");
  const summary = {
    day: run.day,
    steps: only,
    commit: run.results.post?.commit ?? null,
    pushed: run.results.push?.pushed ?? false,
    snapshot: run.results.snapshot
      ? {
          tables: run.results.snapshot.tables,
          rows: run.results.snapshot.rows,
          changed: run.results.snapshot.changed,
        }
      : null,
    sessions: run.results.sessions ?? null,
    learning: run.results.learning
      ? { changes: run.results.learning.changes, tomTurns: run.results.learning.tomTurns }
      : null,
    posted: run.results.post?.files ?? null,
    failures: run.failures,
  };
  try {
    await convexFetch(env, "/tts/event", { kind: "nightly-run", data: summary });
  } catch (err) {
    console.error(`[nightly] could not record the run summary: ${err.message}`);
  }
  console.log(`[nightly] done: ${run.failures.length} failure(s)`);
  if (run.failures.length > 0) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[nightly] FAILED: ${err.message}`);
    process.exit(1);
  });
}
