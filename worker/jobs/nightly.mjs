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
//   2. learning — applies Tom's objections from the digest thread (the
//      inverse of each named change, or a row saying why not), then reads
//      what he did since the last learning run (his session turns with the
//      agent's replies around them, his Slack replies, his rulings), makes
//      one model call over the model-of-tom pages, and applies the lines it
//      proposes that the rules allow — one "learning-change" row each, with
//      the commit, once the push has made it. See learningStep.
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
//      push succeeded, so every prompt names the commit it began with. A
//      named file missing or empty is a failure row and NO post: the store
//      is replaced whole, so a partial post would drop that file from every
//      prompt.
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
import { loadEnv, convexFetch, nyHour, runClaude, extractJsonObject, clip } from "./tts-lib.mjs";
import { git } from "./tts-code-lib.mjs";
import { enclosingHeadings, extractSections, sectionSpan } from "./markdown-sections.mjs";
import { CHANGE_ID_CHARS, changeIdTokens, namedChange } from "./learning-change-names.mjs";

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
      const body = extractSections(
        fs.readFileSync(path.join(areas, page), "utf8"),
        AREA_SECTIONS,
      );
      if (body === "") continue;
      files.push({ path: `${MODEL_OF_TOM_AREAS_DIR}/${page}`, body });
    }
  }
  return { files, missing };
}

/** The instant one session-file line carries, or null: a Claude SDK line has
 * `timestamp` at the top level, a Codex rollout's session_meta line has one
 * there and inside its payload. */
function timestampOfLine(line) {
  if (line.trim() === "") return null;
  try {
    const obj = JSON.parse(line);
    const ts = obj?.timestamp ?? obj?.payload?.timestamp;
    if (typeof ts === "string" && !Number.isNaN(Date.parse(ts))) return Date.parse(ts);
  } catch {
    // not JSON — keep looking
  }
  return null;
}

/**
 * The lines of a buffer, decoded ONE AT A TIME. A session file is tens of
 * megabytes and a single line of it can be hundreds of kilobytes — every
 * session now opens with the model-of-tom prelude — so neither a fixed head
 * nor one decode of the whole file is the right way to read the first lines.
 */
export function* bufferLines(raw) {
  let start = 0;
  while (start < raw.length) {
    let end = raw.indexOf(0x0a, start);
    if (end === -1) end = raw.length;
    yield raw.toString("utf8", start, end);
    start = end + 1;
  }
}

/**
 * The date a session file belongs to: the first `timestamp` found in it,
 * however far in that is, else the file's mtime. Returns { date, dateSource }.
 * A cap on how much is read is a cap on how many files are filed by the wrong
 * date — the prelude alone exceeded the 64 KB head this used to take.
 */
export function sessionDateOf(head, mtimeMs) {
  for (const line of head.split("\n")) {
    const at = timestampOfLine(line);
    if (at !== null) return { date: utcDay(at), dateSource: "timestamp" };
  }
  return { date: utcDay(mtimeMs), dateSource: "mtime" };
}

/** sessionDateOf over a buffer, without decoding more of it than it must. */
export function sessionDateOfBuffer(raw, mtimeMs) {
  for (const line of bufferLines(raw)) {
    const at = timestampOfLine(line);
    if (at !== null) return { date: utcDay(at), dateSource: "timestamp" };
  }
  return { date: utcDay(mtimeMs), dateSource: "mtime" };
}

/** codexMetaOf over a buffer: its first non-empty line, however long. */
export function codexMetaOfBuffer(raw) {
  for (const line of bufferLines(raw)) {
    if (line.trim() !== "") return codexMetaOf(line);
  }
  return null;
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
 * archived again), the session directory each parent was archived into —
 * WITHOUT the per-account segment, which claudeEntry appends — so a child
 * lands beside its parent, and which accounts each Claude session id has been
 * seen under (so a second account's copy sits in its own subdir).
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
        let dir = e.dest.slice(0, e.dest.lastIndexOf("/"));
        // What is indexed is the session's directory WITHOUT the account: a
        // per-account dest ends in the account's name, and keeping that would
        // nest the other account's files inside this one's.
        if (e.runtime === "claude" && e.account && dir.endsWith(`/${e.account}`)) {
          dir = dir.slice(0, -`/${e.account}`.length);
        }
        dirBySession.set(key, dir);
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

// ── 2. learning ──────────────────────────────────────────────────────────────
// Design section 4, "Learning", and rulings 5 and 13. The step reads what Tom
// did since the last learning run — the turns he typed (with the agent's text
// on either side, as context), his threaded Slack replies, his rulings — and
// makes ONE model call over the model-of-tom pages asking for the lines those
// inputs justify. Each proposed change is a line for one section of one
// page: a fact, a correction, or an inference (which must say it is one),
// ending with its evidence in the pages' citation style, and either added to
// the section or replacing one existing line verbatim.
//
// THE JOB, NOT THE MODEL, DECIDES WHAT LANDS. A change is refused when it
// names a file the step does not write (the spec, anything outside
// writing.md, priorities.md and areas/), a section Tom owns (Directions,
// Ideal state, Must not break — ruling 13) or one nested under it, a line
// without evidence or whose evidence names nothing in tonight's input, a
// replacement whose target is not on the page verbatim, or a line already
// there. What lands is one
// "learning-change" row each — {id, file, section, before, after, evidence,
// modelOfTomCommit} — posted once the push step has made the commit, and the 5 a.m.
// digest prints each with its id. Tom objects by replying on that line; the
// NEXT night applies the inverse first (learningObjections below), records
// "learning-reverted" or, when the text has moved on, "learning-revert-
// failed" with the reason, and the digest reports it. Report and object is
// the default: nothing waits on him.
//
// Every write happens at the end of the step, after the whole answer has
// been checked, so a refused answer leaves the checkout untouched. Auto-
// compact and auto-memory stay off in learning runs (ruling 10): the call is
// one headless `claude -p`, which has neither.

export const MODEL_OF_TOM_DIR = "model-of-tom";
// The pages the step writes. The spec and everything else in the checkout is
// refused by not being here.
export const LEARNING_FILES_FIRST = ["model-of-tom/writing.md", "model-of-tom/priorities.md"];
// The sections an agent never writes (ruling 13). Matched by heading,
// case-insensitively, on any page.
export const FORBIDDEN_SECTIONS = ["Directions", "Ideal state", "Must not break"];
export const LEARNING_KINDS = ["fact", "correction", "inference"];
// runClaude's --model. The Opus tier: this is judgment over Tom's words, not
// a mechanical parse. Overridable per box without a deploy.
export const LEARNING_MODEL = process.env.TTS_LEARNING_MODEL || "opus";
export const LEARNING_TIMEOUT_MS = 20 * 60 * 1000;
// A turn of Tom's is shown to the model up to this many characters.
export const LEARNING_TURN_CHARS = 4000;

export function isLearningFile(rel) {
  return (
    LEARNING_FILES_FIRST.includes(rel) ||
    /^model-of-tom\/areas\/[a-z0-9-]+\.md$/.test(String(rel))
  );
}

/** The stable id of one change: the page, the section and the line it put
 * there. The same line proposed twice is the same change. Its length is the
 * naming rule's (learning-change-names.mjs), which is how Tom names it back. */
export function learningChangeId(file, section, line) {
  return sha256(`${file}\n${section}\n${line}`).slice(0, CHANGE_ID_CHARS);
}

/**
 * `updated: <day>` in a page's frontmatter (the area pages carry one; a page
 * without frontmatter, or without an `updated:` line in it, is returned as
 * it is). `reviewed:` is never touched — only Tom sets it.
 */
export function bumpUpdated(text, day) {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return text;
  const front = text.slice(4, end);
  if (!/^updated:.*$/m.test(front)) return text;
  return text.slice(0, 4) + front.replace(/^updated:.*$/m, `updated: ${day}`) + text.slice(end);
}

/**
 * The id a page cites a session by: the first 8 hex characters of the SDK
 * session id ("session 47f04bc9" on the pages; WikiTom's sessions/ archive is
 * keyed by the whole of it, `sessions/YYYY/MM/DD/claude-<id>/`). A session
 * that never reported one — the SDK had not started — is cited by its Convex
 * row id, which is the only name it has.
 */
export function sessionCitation(turn) {
  const sdk = typeof turn.sdkSessionId === "string" ? turn.sdkSessionId.toLowerCase() : "";
  return /^[0-9a-f]{8}/.test(sdk) ? sdk.slice(0, 8) : turn.sessionId;
}

/** Every id in tonight's input that a line's evidence may name. A session is
 * named by its citation (the 8-hex prefix), by the whole SDK id, or by its
 * Convex row id — the prompt shows the first; the others are accepted. */
export function learningEvidenceIds(input) {
  const ids = new Set();
  const add = (x) => {
    if (typeof x === "string" && x.length >= 6) ids.add(x);
  };
  for (const t of input.tomTurns ?? []) {
    add(t.id);
    add(t.sessionId);
    add(t.sdkSessionId);
    add(sessionCitation(t));
  }
  for (const r of input.slackReplies ?? []) {
    add(r.id);
    add(r.data?.ts);
    add(r.data?.threadTs);
  }
  for (const r of input.rulings ?? []) add(r.id);
  return ids;
}

/**
 * The model's answer as a list of raw changes. Malformed JSON, or an object
 * without a `changes` array, throws — and the step applies nothing.
 *
 * THE THROWN MESSAGE IS A REASON, NEVER THE ANSWER: extractJsonObject's own
 * error quotes the head of the text, and a failure here becomes a
 * "nightly-failure" row the digest prints. The model's words about Tom do
 * not go to Slack through an error; the cron log has them (stderr, below).
 */
export function parseLearningAnswer(answerText) {
  let obj;
  try {
    obj = extractJsonObject(answerText);
  } catch (err) {
    console.error(`[nightly] learning: the answer could not be parsed: ${err.message}`);
    throw new Error(
      err instanceof SyntaxError
        ? "the learning answer is not valid JSON"
        : "the learning answer holds no JSON object",
    );
  }
  if (obj === null || typeof obj !== "object" || !Array.isArray(obj.changes)) {
    throw new Error("the learning answer has no `changes` array");
  }
  obj.changes.forEach((c, i) => {
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      throw new Error(`learning change ${i} is not an object`);
    }
  });
  return obj.changes;
}

// The trailing parenthetical of a line — its citation. A parenthetical
// alone is not a citation: what makes it one is that it names the change's
// evidence (learningRefusal), which is what "every line cites its evidence"
// means on the pages.
const CITED = /(\([^()]+\))\.?$/;

function isForbiddenSection(heading) {
  const h = String(heading ?? "").trim().toLowerCase();
  return FORBIDDEN_SECTIONS.some((s) => s.toLowerCase() === h);
}

/**
 * Where a change's section is on a page, or why the step may not touch it:
 * `{ span }` from sectionSpan, or `{ reason }` when the page has no such
 * heading, the section is one of Tom's, or it sits UNDER one of Tom's — a
 * "### Training goals" beneath "## Ideal state" is Ideal state's. THE ONE
 * DOOR for both directions: a line lands through it (applyLearningChanges)
 * and is taken back through it (revertLearningChange), so a revert can no
 * more reach Tom's sections than a change can.
 */
export function locateSection(lines, file, section) {
  const name = String(section ?? "").trim();
  if (name === "") return { reason: "no section named" };
  if (isForbiddenSection(name)) {
    return { reason: `"${name}" is Tom's section; an agent never writes it` };
  }
  const span = sectionSpan(lines, name);
  if (span === null) return { reason: `no section "${name}" on ${file}` };
  const owner = enclosingHeadings(lines, span.start).find(isForbiddenSection);
  if (owner !== undefined) {
    return { reason: `"${name}" is under "${owner}", Tom's section; an agent never writes it` };
  }
  return { span };
}

/** Why one proposed change may not land, or null when it may. The checks
 * are the rules in the block comment above, in the order a reader of the
 * refusal would want them. */
function learningRefusal(c, texts, evidenceIds) {
  if (typeof c.file !== "string" || !isLearningFile(c.file)) {
    return `${String(c.file)} is not a page the learning step writes`;
  }
  if (!texts.has(c.file)) return `${c.file} is not in the checkout`;
  if (typeof c.section !== "string" || c.section.trim() === "") return "no section named";
  if (isForbiddenSection(c.section)) {
    return `"${c.section.trim()}" is Tom's section; an agent never writes it`;
  }
  if (!LEARNING_KINDS.includes(c.kind)) return "kind must be fact, correction or inference";
  if (typeof c.line !== "string" || c.line.trim() === "" || /[\r\n]/.test(c.line)) {
    return "the line must be one non-empty line";
  }
  const cited = CITED.exec(c.line.trim());
  if (cited === null) return "the line does not end with its evidence citation";
  if (c.kind === "inference" && !/inference/i.test(c.line)) {
    return "an inference must say it is one, in the line";
  }
  if (
    !Array.isArray(c.evidence) ||
    c.evidence.length === 0 ||
    !c.evidence.every((e) => typeof e === "string" && e.trim() !== "")
  ) {
    return "no evidence";
  }
  const evidence = c.evidence.map((e) => e.trim());
  if (evidenceIds !== null) {
    for (const e of evidence) {
      if (![...evidenceIds].some((id) => e.includes(id))) {
        return `evidence "${e}" names nothing in tonight's input`;
      }
    }
  }
  // The citation IS the evidence: every entry is in the line, and the
  // trailing parenthetical names at least one of them — "(probably)" at the
  // end of a line that never says where it came from is not a citation.
  for (const e of evidence) {
    if (!c.line.includes(e)) return `the line does not cite its evidence "${e}"`;
  }
  if (!evidence.some((e) => cited[1].includes(e))) {
    return `the citation ${cited[1]} names none of the change's evidence`;
  }
  if (c.replaces !== null && c.replaces !== undefined) {
    // One bullet — which on writing.md may be quoted over the lines the
    // page wraps it on (bulletUnits below).
    if (typeof c.replaces !== "string" || c.replaces.trim() === "") {
      return "replaces must be one existing bullet, or null";
    }
    if (oneLine(c.replaces) === oneLine(c.line)) return "the replacement is the line it replaces";
  }
  return null;
}

// ── The unit a change replaces or takes back: one bullet ─────────────────────
// writing.md is hard-wrapped: one bullet runs over several physical lines,
// the continuation lines indented. A replacement or a revert that worked on
// physical lines would replace the first line of a bullet and leave its
// tail as a stray, so the unit here is the bullet whole — the line that
// starts it plus the indented, non-blank lines under it — and a bullet is
// matched with whitespace normalized (the lines joined by one space), so
// the model may quote it as the page wraps it or as one line, and a bullet
// Tom re-wrapped still matches. The area pages' bullets are one line each,
// which is the degenerate case. What the job writes is always one line, and
// `before` records the replaced bullet as one line, so a revert restores its
// words unwrapped.
const BULLET = /^\s*[-*]\s+\S/;
const CONTINUATION = /^\s+\S/;

/** The bullets within `span` as [start, end) line ranges. */
export function bulletUnits(lines, span) {
  const units = [];
  for (let i = span.start + 1; i < span.end; i++) {
    if (!BULLET.test(lines[i])) continue;
    let end = i + 1;
    while (end < span.end && CONTINUATION.test(lines[end]) && !BULLET.test(lines[end])) end++;
    units.push({ start: i, end });
    i = end - 1;
  }
  return units;
}

/** A bullet's text (or any text) as one line: each line trimmed, joined by
 * a space, runs of whitespace collapsed. The form bullets are compared in. */
export function oneLine(text) {
  return String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The unit within `span` whose one-line form equals `text`'s, or null. */
function findBullet(lines, span, text) {
  const wanted = oneLine(text);
  for (const unit of bulletUnits(lines, span)) {
    if (oneLine(lines.slice(unit.start, unit.end).join("\n")) === wanted) return unit;
  }
  return null;
}

/**
 * Apply proposed changes to the pages (a Map of file → text), pure. Returns
 * the new texts, the changes that landed (each with its id and the digest's
 * fields), and the ones refused with the reason. `evidenceIds` is the set a
 * line's evidence must name — null skips that check. Every page that took
 * a change gets `updated: day`.
 */
export function applyLearningChanges(pages, changes, { day, evidenceIds = null } = {}) {
  const texts = new Map(pages);
  const applied = [];
  const refused = [];
  const refuse = (c, reason) =>
    refused.push({
      file: typeof c.file === "string" ? c.file : null,
      section: typeof c.section === "string" ? c.section : null,
      line: typeof c.line === "string" ? c.line : null,
      reason,
    });
  for (const c of changes) {
    const why = learningRefusal(c, texts, evidenceIds);
    if (why !== null) {
      refuse(c, why);
      continue;
    }
    const line = c.line.trim().startsWith("- ") ? c.line.trim() : `- ${c.line.trim()}`;
    const lines = texts.get(c.file).split("\n");
    const located = locateSection(lines, c.file, c.section);
    if (located.span === undefined) {
      refuse(c, located.reason);
      continue;
    }
    const { span } = located;
    if (findBullet(lines, { start: -1, end: lines.length }, line) !== null) {
      refuse(c, "already on the page");
      continue;
    }
    const replaces = c.replaces ?? null;
    let before = "";
    if (replaces !== null) {
      const unit = findBullet(lines, span, replaces);
      if (unit === null) {
        refuse(c, `the line to replace is not in "${c.section.trim()}" verbatim`);
        continue;
      }
      before = oneLine(lines.slice(unit.start, unit.end).join("\n"));
      lines.splice(unit.start, unit.end - unit.start, line);
    } else {
      let last = span.start;
      for (let i = span.start + 1; i < span.end; i++) if (lines[i].trim() !== "") last = i;
      if (last === span.start) lines.splice(last + 1, 0, "", line);
      else lines.splice(last + 1, 0, line);
    }
    texts.set(c.file, lines.join("\n"));
    applied.push({
      id: learningChangeId(c.file, c.section.trim(), line),
      file: c.file,
      section: c.section.trim(),
      kind: c.kind,
      before,
      after: line,
      evidence: c.evidence.map((e) => e.trim()).join("; "),
      sources: c.evidence.map((e) => e.trim()),
    });
  }
  for (const file of new Set(applied.map((a) => a.file))) {
    texts.set(file, bumpUpdated(texts.get(file), day));
  }
  return { pages: texts, applied, refused };
}

/**
 * The inverse of one recorded change against a page's CURRENT text: an
 * addition's line is removed, a replacement's line becomes what it replaced.
 * When the line is no longer there as written — a later change replaced it,
 * or Tom edited the page — nothing is touched and the reason says so.
 *
 * ONLY WITHIN THE CHANGE'S OWN SECTION (locateSection): the line is looked
 * for where the change put it and nowhere else, so a copy Tom pasted into
 * Must not break or Directions — or anywhere — is never the one taken back.
 */
export function revertLearningChange(text, change) {
  const after = String(change.after ?? "").trim();
  if (after === "") return { ok: false, reason: "the change records no line to look for" };
  const lines = text.split("\n");
  const located = locateSection(lines, change.file, change.section);
  if (located.span === undefined) return { ok: false, reason: located.reason };
  const { span } = located;
  const unit = findBullet(lines, span, after);
  if (unit === null) {
    return {
      ok: false,
      reason: `the line is no longer in "${String(change.section).trim()}" on ${change.file} as written`,
    };
  }
  const before = oneLine(change.before);
  lines.splice(unit.start, unit.end - unit.start, ...(before === "" ? [] : [before]));
  return { ok: true, text: lines.join("\n") };
}

/**
 * The change an objection names: by the change's id — the row's own, or a
 * name in the text by the one rule in learning-change-names.mjs, which is
 * also how ttsSlack.ts read the reply — else by the line's text quoted in
 * the objection.
 */
export function matchObjection(objection, changes) {
  const text = String(objection.text ?? "");
  const hit = namedChange([objection.id, ...changeIdTokens(text)], changes);
  if (hit) return hit;
  for (const ch of changes) {
    const after = String(ch.after ?? "").trim().replace(/^- /, "");
    if (after.length >= 20 && text.includes(after)) return ch;
  }
  return null;
}

/** The pages the step writes, as a Map of checkout-relative path → text. */
export function readLearningPages(dir) {
  const pages = new Map();
  for (const rel of LEARNING_FILES_FIRST) {
    const abs = path.join(dir, rel);
    if (fs.existsSync(abs)) pages.set(rel, fs.readFileSync(abs, "utf8"));
  }
  const areas = path.join(dir, MODEL_OF_TOM_AREAS_DIR);
  if (fs.existsSync(areas)) {
    for (const name of fs.readdirSync(areas).filter((n) => n.endsWith(".md")).sort()) {
      const rel = `${MODEL_OF_TOM_AREAS_DIR}/${name}`;
      if (isLearningFile(rel)) pages.set(rel, fs.readFileSync(path.join(areas, name), "utf8"));
    }
  }
  return pages;
}

/** The one prompt. The pages' own rules (writing.md) travel with the pages;
 * what is here is the contract of the answer and what the job refuses. */
export function learningPrompt(input, pages, day) {
  const shown = {
    window: { since: new Date(input.since).toISOString(), until: new Date(input.until).toISOString() },
    tomTurns: (input.tomTurns ?? []).map((t) => ({
      turnId: t.id,
      session: sessionCitation(t),
      sessionTitle: t.sessionTitle,
      date: utcDay(t.at),
      agentBefore: t.replyBefore ?? null,
      tom: clip(t.text, LEARNING_TURN_CHARS),
      agentAfter: t.replyAfter ?? null,
    })),
    slackReplies: (input.slackReplies ?? []).map((r) => ({
      eventId: r.id,
      ts: r.data?.ts ?? null,
      threadTs: r.data?.threadTs ?? null,
      date: utcDay(r.at),
      subject: r.data?.subject ?? null,
      outcome: r.data?.outcome ?? null,
      tom: clip(r.data?.text, LEARNING_TURN_CHARS),
    })),
    rulings: (input.rulings ?? []).map((r) => ({
      rulingId: r.id,
      date: utcDay(r.at),
      verdict: r.verdict,
      subjectType: r.subjectType,
      todoId: r.todoId ?? null,
      batchId: r.batchId ?? null,
      repo: r.repo ?? null,
      externalId: r.externalId ?? null,
      sentence: r.sentence ?? null,
      quote: r.quote ?? null,
    })),
  };
  const pageText = [...pages]
    .map(([file, text]) => `=== ${file} ===\n${text}`)
    .join("\n\n");
  return [
    "You maintain the model-of-tom pages of WikiTom: the files every agent prompt about Tom begins with. Tonight's input is what Tom did since the last learning run — the turns he typed in sessions (each with the agent's text just before and just after it, which is context for reading his words and never a source of a line), his threaded Slack replies, and his rulings. Propose the changes those inputs justify to the pages below, and nothing else.",
    "",
    "RULES",
    "- A change is one line for one section of one page. `kind` is what the line is: a fact about Tom, a correction of something a page says, or an inference. An inference is allowed and must say in the line that it is an inference and which facts it rests on.",
    "- Every line ends with its evidence, in the pages' citation style, in parentheses: (session <session>, YYYY-MM-DD) for a turn — `session` is the 8-character id the pages already cite, e.g. (session 47f04bc9, 2026-08-30) — (ruling <rulingId>, YYYY-MM-DD) for a ruling, (slack <ts>, YYYY-MM-DD) for a Slack reply; several joined with \"; \". The ids are the ones in the input, verbatim. `evidence` lists the same citations, and every one of them must appear in the line. A line whose evidence names nothing in the input is refused.",
    "- Only these pages: model-of-tom/writing.md, model-of-tom/priorities.md, model-of-tom/areas/<area>.md. Only a section that exists on the page, named by its heading. Never \"Directions\", never \"Ideal state\", never \"Must not break\" — those are Tom's own, and a change naming them is refused. Never the spec.",
    "- A correction replaces: `replaces` is one existing bullet of that section, verbatim — where the page wraps a bullet over several lines, quote all of them — and the new line supersedes it — the pages describe what is, never what was. An addition has `replaces: null`.",
    "- Write to writing.md's own rules: plain statements, no comparisons or analogies, no evaluative language, one fixed term per concept, the date in the line. One line, starting with \"- \".",
    "- Nothing from the agent's words alone; nothing already on a page; nothing that restates a line. An empty list is the right answer on a night whose input changes nothing about the model of Tom, and that is most nights.",
    "",
    "Answer with ONE JSON object and nothing else, no code fence:",
    '{"changes":[{"file":"model-of-tom/areas/climbing.md","section":"Current state","kind":"fact","line":"- ... (session <session>, YYYY-MM-DD).","replaces":null,"evidence":["session <session>"]}]}',
    "",
    `Tonight is ${day} (UTC).`,
    "",
    "INPUT",
    JSON.stringify(shown, null, 1),
    "",
    "PAGES",
    pageText,
  ].join("\n");
}

/**
 * Tom's objections, applied before tonight's learning. Each unconsumed
 * "learning-objection" row names a change (by id or by the line's text); the
 * inverse is applied to the page's current text and one row records it
 * either way. Every objection is consumed here once, so a night that could
 * not revert says so once and the digest shows it once.
 */
async function learningObjections(run, input, fetchConvex) {
  const outcome = { reverted: 0, failed: 0 };
  const consumed = [];
  // The rows that go in the reverts' commit: tagged with its message below,
  // once the count is known, so recordLearningRows finds the commit by it.
  const revertedRows = [];
  for (const objection of input.objections ?? []) {
    const change = matchObjection(objection, input.changes ?? []);
    const note = { objectionId: objection.eventId, objection: clip(objection.text, 400) };
    if (change === null) {
      run.learningRows.push({
        kind: "learning-revert-failed",
        data: { ...note, id: objection.id, reason: "no learning change matches the objection" },
      });
      outcome.failed += 1;
    } else {
      const abs = path.join(run.dir, change.file);
      const result =
        typeof change.file === "string" && isLearningFile(change.file) && fs.existsSync(abs)
          ? revertLearningChange(fs.readFileSync(abs, "utf8"), change)
          : { ok: false, reason: `${change.file} is not a page in the checkout` };
      const named = { id: change.id, file: change.file, section: change.section ?? null };
      if (result.ok) {
        fs.writeFileSync(abs, bumpUpdated(result.text, run.day));
        const row = {
          kind: "learning-reverted",
          data: { ...note, ...named, before: change.after, after: change.before },
        };
        run.learningRows.push(row);
        revertedRows.push(row);
        outcome.reverted += 1;
      } else {
        run.learningRows.push({
          kind: "learning-revert-failed",
          data: { ...note, ...named, reason: result.reason },
        });
        outcome.failed += 1;
      }
    }
    consumed.push(objection.eventId);
  }
  if (consumed.length > 0) {
    await fetchConvex(run.env, "/tts/learning-objections-consumed", { ids: consumed });
  }
  if (outcome.reverted > 0) {
    const message = `learning: ${run.day} — ${outcome.reverted} line${outcome.reverted === 1 ? "" : "s"} reverted on Tom's objection`;
    for (const row of revertedRows) row.commitMessage = message;
    run.commits.push({ paths: [MODEL_OF_TOM_DIR], message });
  }
  return outcome;
}

/**
 * The step. `deps` is for the tests: the Convex call and the model call,
 * defaulting to the real ones. The rows this step produces go to
 * run.learningRows and are posted by recordLearningRows once the push has
 * given them a commit.
 */
export async function learningStep(run, deps = {}) {
  const fetchConvex = deps.fetch ?? convexFetch;
  const askModel = deps.model ?? runClaude;
  run.learningRows ??= [];
  const until = run.now;
  const input = await fetchConvex(run.env, `/tts/learning-input?until=${until}`);
  const summary = {
    day: run.day,
    since: input.since,
    sinceSource: input.sinceSource ?? null,
    until,
    tomTurns: input.tomTurns.length,
    sessions: new Set(input.tomTurns.map((t) => t.sessionId)).size,
    slackReplies: input.slackReplies.length,
    rulings: input.rulings.length,
    objections: (input.objections ?? []).length,
    reverted: 0,
    revertFailed: 0,
    model: null,
    changes: 0,
    refused: [],
  };
  const objections = await learningObjections(run, input, fetchConvex);
  summary.reverted = objections.reverted;
  summary.revertFailed = objections.failed;

  if (summary.tomTurns + summary.slackReplies + summary.rulings > 0) {
    const pages = readLearningPages(run.dir);
    if (pages.size === 0) throw new Error(`no model-of-tom pages under ${run.dir}`);
    summary.model = LEARNING_MODEL;
    const answer = askModel(learningPrompt(input, pages, run.day), {
      cwd: run.dir,
      model: LEARNING_MODEL,
      timeoutMs: LEARNING_TIMEOUT_MS,
      maxTurns: 4,
    });
    const result = applyLearningChanges(pages, parseLearningAnswer(answer), {
      day: run.day,
      evidenceIds: learningEvidenceIds(input),
    });
    for (const [file, text] of result.pages) {
      if (text !== pages.get(file)) fs.writeFileSync(path.join(run.dir, file), text);
    }
    summary.changes = result.applied.length;
    summary.refused = result.refused.map((r) => ({ ...r, line: clip(r.line, 200) }));
    const message = `learning: ${run.day} — ${result.applied.length} line${result.applied.length === 1 ? "" : "s"} from Tom's turns, replies and rulings`;
    for (const a of result.applied) {
      run.learningRows.push({ kind: "learning-change", data: a, commitMessage: message });
    }
    if (result.applied.length > 0) run.commits.push({ paths: [MODEL_OF_TOM_DIR], message });
  }
  await fetchConvex(run.env, "/tts/event", { kind: "learning-run", data: summary });
  console.log(
    `[nightly] learning: ${summary.tomTurns} turns of Tom's in ${summary.sessions} sessions, ${summary.slackReplies} Slack replies, ${summary.rulings} rulings — ${summary.changes} change(s), ${summary.refused.length} refused, ${summary.reverted} reverted, ${summary.revertFailed} revert(s) failed`,
  );
  return summary;
}

/**
 * The commit under model-of-tom/ that a learning row's change is in, found
 * after the push has made it (and the rebase has given it its final hash):
 * the newest commit touching model-of-tom/ whose message starts with the
 * one the row was tagged with. When no commit carries that message — the
 * push step folds two entries naming model-of-tom/ into the first (a night
 * with reverts AND new lines is one commit under the reverts' message) —
 * the newest model-of-tom/ commit THIS RUN made is the one that holds it;
 * an older commit is never named, and null says nothing was found.
 */
export function modelOfTomCommit(dir, message, notBefore) {
  try {
    const bySubject = git(
      dir, "log", "-1", "--format=%H", "--fixed-strings", `--grep=${message}`, "--", MODEL_OF_TOM_DIR,
    ).trim();
    if (bySubject !== "") return bySubject;
    const newest = git(dir, "log", "-1", "--format=%H %at", "--", MODEL_OF_TOM_DIR).trim();
    const [hash, authoredAt] = newest.split(" ");
    return hash && Number(authoredAt) * 1000 >= notBefore - 60_000 ? hash : null;
  } catch {
    return null;
  }
}

/**
 * Post the rows the learning step produced, each with the commit its change
 * is in (`modelOfTomCommit`, above — the row's own commit, not HEAD, which by
 * now is the sessions commit or the sweep). A row that wrote nothing (a
 * revert that could not apply) names none. Called after the locked steps,
 * whether or not the push ran: the commit is the pushed one, or the local one
 * when the push was refused — the run's `pushed` says which. `deps.fetch` is
 * for the tests.
 */
export async function recordLearningRows(run, deps = {}) {
  const fetchConvex = deps.fetch ?? convexFetch;
  const rows = run.learningRows ?? [];
  if (rows.length === 0) return;
  const byMessage = new Map();
  const commitFor = (message) => {
    if (typeof message !== "string") return null;
    if (!byMessage.has(message)) byMessage.set(message, modelOfTomCommit(run.dir, message, run.now));
    return byMessage.get(message);
  };
  const failed = [];
  for (const row of rows) {
    try {
      await fetchConvex(run.env, "/tts/event", {
        kind: row.kind,
        data: { ...row.data, day: run.day, modelOfTomCommit: commitFor(row.commitMessage) },
      });
    } catch (err) {
      failed.push(err);
    }
  }
  if (failed.length > 0) {
    await recordFailure(
      run,
      "learning-rows",
      new Error(`${failed.length} of ${rows.length} learning rows not recorded: ${failed[0].message}`),
    );
  }
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
      const meta = codexMetaOfBuffer(raw);
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

/**
 * The manifest entry for a Claude SDK file (parent, child or attachment).
 *
 * THE DIRECTORY THE INDEX HOLDS IS ACCOUNT-LESS —
 * `sessions/YYYY/MM/DD/claude-<id>` — and the account is appended here, once,
 * when two accounts hold the same session id (phase 1's layout; one account
 * is the flat layout). Holding the second account's directory instead would
 * append the second account under the first's, and that session's children
 * would land at `.../claude-<id>/gmail/wpi/children/...`.
 */
export function claudeEntry(f, raw, sha, mtimeMs, index, accountsBySession) {
  const key = `claude:${f.session}`;
  const accounts = accountsBySession.get(f.session) ?? new Set([f.account]);
  const perAccount = accounts.size > 1;
  let base = index.dirBySession.get(key);
  let date;
  let dateSource;
  if (f.kind === "parent") {
    const own = sessionDateOfBuffer(raw, mtimeMs);
    if (base === undefined) {
      base = `${SESSIONS_DIR}/${own.date.replaceAll("-", "/")}/claude-${f.session}`;
      index.dirBySession.set(key, base);
    }
    // One session id is one directory: the other account's copy, and an
    // earlier night's, keep the directory the session already has, so every
    // child of either account finds one place. Only a copy whose own date
    // disagrees with it records that the directory decided the date.
    date = base.split("/").slice(1, 4).join("-");
    dateSource = date === own.date ? own.dateSource : "parent";
  } else if (base === undefined) {
    // A child whose parent is not archived (an orphan): its own date.
    ({ date, dateSource } =
      f.kind === "child"
        ? sessionDateOfBuffer(raw, mtimeMs)
        : { date: utcDay(mtimeMs), dateSource: "mtime" });
    base = `${SESSIONS_DIR}/${date.replaceAll("-", "/")}/claude-${f.session}`;
  } else {
    date = base.split("/").slice(1, 4).join("-");
    dateSource = "parent";
  }
  const dir = perAccount ? `${base}/${f.account}` : base;
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
  const { date, dateSource } = sessionDateOfBuffer(raw, mtimeMs);
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
    ({ date, dateSource } = sessionDateOfBuffer(raw, mtimeMs));
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
 * under tts/snapshot/, sessions/ and model-of-tom/.
 *
 * WHY THE SWEEP: a run that died after writing files (a crashed export, a
 * killed process, a step whose failure row was recorded and skipped) leaves
 * tracked files modified. The next night's `git pull --rebase` refuses a dirty
 * tree and would go on refusing every night after, with nothing in the
 * checkout ever reaching GitHub again. Committing the leftovers is what makes
 * the next night recoverable; the snapshot is deterministic and the archive is
 * append-only, so committing them is never wrong, only sometimes redundant.
 * A model-of-tom page the learning step wrote before dying is committed the
 * same way: the digest lists every WikiTom commit, so the line is seen even
 * when its "learning-change" row was never posted.
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
  addPaths(dir, [SNAPSHOT_DIR, SESSIONS_DIR, MODEL_OF_TOM_DIR]);
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
  // A NAMED FILE MISSING MEANS NO POST. The store is replaced whole, so
  // posting the rest would take the missing file out of every prompt until a
  // night that reads it again — and for writing.md that is every sentence
  // written to no standard at all (the server refuses that post outright).
  // A missing file is a layout change or a half-read checkout, never a
  // decision of Tom's: last night's text keeps serving, and this is the row
  // the digest shows.
  if (missing.length > 0) {
    await recordFailure(
      run,
      "post",
      new Error(
        `model-of-tom files missing or empty at ${commit.slice(0, 12)}: ${missing.join(", ")} — not posting, the store keeps what it has`,
      ),
    );
    return { commit, files: null, missing };
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
    // The learning step's rows, posted by recordLearningRows once the push
    // has given them a commit.
    learningRows: [],
    failures: [],
    results: {},
  };
  // No checkout is a bad night, not a silent one: the digest reads these two
  // rows, and a run that threw here wrote neither — the one morning Tom would
  // see nothing at all is the morning the checkout is gone.
  if (!fs.existsSync(path.join(run.dir, ".git"))) {
    await recordFailure(
      run,
      "checkout",
      new Error(`${run.dir} is not a git checkout — setup.sh clones WikiTom there`),
    );
    await recordSummary(run, only);
    return;
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
    // The learning step's rows wait for this: their commits exist now, with
    // their final hashes (pushed, or local when the push was refused).
    await recordLearningRows(run);
  }
  if (only.includes("post")) await runStep("post");
  await recordSummary(run, only);
}

/** The one "nightly-run" row the 5 a.m. digest reads, written however the run
 * went — including a run that got no further than a missing checkout. */
async function recordSummary(run, only) {
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
      ? {
          changes: run.results.learning.changes,
          refused: run.results.learning.refused.length,
          reverted: run.results.learning.reverted,
          revertFailed: run.results.learning.revertFailed,
          tomTurns: run.results.learning.tomTurns,
        }
      : null,
    posted: run.results.post?.files ?? null,
    failures: run.failures,
  };
  try {
    await convexFetch(run.env, "/tts/event", { kind: "nightly-run", data: summary });
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
