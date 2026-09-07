// session-archive.mjs — THE ONE HOME for putting a session file into
// WikiTom's sessions/ archive (the lifeos update, phase 1's layout; design
// section 4, "Sessions": "archived at session end plus nightly sweep").
//
// Two callers, at two moments, through one function:
//
//   worker/jobs/nightly.mjs (the sweep, step 3) — every Codex rollout and
//     Claude SDK session file on the box that the manifests do not already
//     hold at that content, once a night, under the checkout's writer lock.
//   worker/session-host/session.mjs (session end) — the one session that
//     just ended, the moment it does, under the same lock, so the transcript
//     is in the vault hours before the sweep. The sweep still runs and
//     re-archives a file that grew after that (the SDK can flush after the
//     query ends): the manifest records the content hash, and a source whose
//     hash moved is archived again.
//
// The daemon reaches this file through worker/session-host/session-archive
// .mjs, a symlink to it, for the reason lib.mjs gives for its worker-env
// symlink: setup.sh copies the two directories to different depths, and cp
// dereferences the link, so the box holds a real copy at each depth while
// the repo holds one body. Dependency-free (node built-ins only) for the
// same reason: nothing the symlinked copy imports would resolve from the
// other depth.
//
// THE WRITE IS ATOMIC PER SESSION FILE. The bytes are written under
// sessions/.staging/<id>/ first (a .gitignore there keeps git's eyes off it),
// renamed into place, and the manifest line is appended LAST — because the
// manifest is the index the sweep trusts: a line for bytes that are not
// there would be a session the archive claims to hold and never will (the
// sweep would skip it forever), while bytes with no line are archived again
// tomorrow at no cost. A crash leaves at worst a staged file nobody reads.
//
// AND THE TRANSCRIPT IS REDACTED ON ITS WAY IN (archivedBody). A session file
// is where the tokens actually appeared — the 2026-08-30 GitHub token was
// read out of a clone's .git/config and typed into gh commands, and every one
// of those turns is a line of a .jsonl on this box — so archiving one
// verbatim would put in the vault exactly what the snapshot's redactRow keeps
// out of it, by the other door. Nothing about the box's copy changes, and
// neither does the manifest: sha256 and raw_bytes are the SOURCE's, so "has
// this file grown since?" compares the same two numbers it always did.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The credential filter is worker/session-host/redact.mjs — THE ONE HOME; the
// daemon's ingest choke point reads it there and a test fences it there. It is
// reached from THIS file by its installed path, and this file has three of
// them: worker/jobs/ in the repo, /opt/tts/ on the box, and
// /opt/tts/session-host/ on the box too (setup.sh's `cp` dereferences the
// session-host symlink, so the box holds a real copy at each depth — the
// reasoning lib.mjs gives for its worker-env symlink). The spelled-out path
// that resolves at one depth dangles at the others, so all three are tried,
// at load, in that order. THE ONE RESOLUTION: nightly.mjs imports the filter
// back off this module rather than repeating the search.
const REDACT_HOMES = ["../session-host/redact.mjs", "./session-host/redact.mjs", "./redact.mjs"];
export const { redactSecrets } = await import(
  REDACT_HOMES.map((rel) => new URL(rel, import.meta.url)).find((url) => fs.existsSync(fileURLToPath(url))) ??
    new URL(REDACT_HOMES[0], import.meta.url)
);

// ── Where things are ─────────────────────────────────────────────────────────
export const WIKITOM_DIR = process.env.WIKITOM_DIR || "/root/wikitom";
export const WIKITOM_LOCK = "/var/lock/tts-wikitom.lock";
export const LOCK_WAIT_SECONDS = 600;
export const SESSIONS_DIR = "sessions";
// Under sessions/, so a rename into place never crosses a filesystem.
export const STAGING_DIR = `${SESSIONS_DIR}/.staging`;
export const CODEX_SESSIONS_DIR = "/root/.codex/sessions";
export const CLAUDE_ACCOUNTS_DIR = "/root/.claude-accounts";

// A file over 90 MB is split into gzipped parts (phase 1's rule; GitHub
// refuses a blob over 100 MB, and the same threshold applies forever).
export const SPLIT_BYTES = 90 * 1024 * 1024;

// ── Small pure helpers ───────────────────────────────────────────────────────
export function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** YYYY-MM-DD of an instant, in UTC (the manifest's and the layout's date). */
export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// gzip with no name or mtime in the header (Node writes neither), so the
// same input gives the same bytes and hashes compare across nights.
export function gzip(bytes) {
  return zlib.gzipSync(bytes, { level: 9 });
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
 * The bytes to STORE for a file read as `raw`: its text through the
 * credential filter. Every .jsonl on this box is transcript text — a Claude
 * SDK session file, its subagent children, a Codex rollout — and a transcript
 * is the whole reason this exists.
 *
 * ANYTHING ELSE IS FILTERED ONLY IF IT IS TEXT, and the test for that is the
 * round trip: bytes that re-encode from UTF-8 to exactly what was read. A PNG
 * or a PDF is not, so it is stored byte-for-byte rather than mangled by a
 * filter written for text — and a `tool-results/r.txt` beside it, which is
 * text and could hold a key as easily as a turn could, is filtered.
 */
export function archivedBody(source, raw) {
  const text = raw.toString("utf8");
  if (!/\.jsonl$/i.test(String(source ?? "")) && !Buffer.from(text, "utf8").equals(raw)) return raw;
  const filtered = redactSecrets(text);
  return filtered === text ? raw : Buffer.from(filtered, "utf8");
}

// ── What is on the box ───────────────────────────────────────────────────────
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

// ── What the archive already holds ───────────────────────────────────────────
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

// ── Where each file goes ─────────────────────────────────────────────────────
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

// ── The write ────────────────────────────────────────────────────────────────
/** The staging directory for one session's files, its .gitignore in place. */
function stagingFor(checkoutDir, session) {
  const root = path.join(checkoutDir, STAGING_DIR);
  fs.mkdirSync(root, { recursive: true });
  const ignore = path.join(root, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  const dir = path.join(root, String(session).replace(/[^A-Za-z0-9._-]/g, "_"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write one archived file under the checkout and append its manifest line.
 * A raw file over SPLIT_BYTES is stored as gzipped parts named after the
 * destination (`<name>.partNN.gz`), listed in `parts`; the manifest is the
 * only reader that needs to know.
 *
 * In this order, and no other: every byte staged under sessions/.staging/
 * <session>/, then each file renamed into its place (one atomic step per
 * file on the same filesystem), then the manifest line. See the header for
 * why the line comes last.
 *
 * THE STORED BYTES ARE NOT ALWAYS THE BYTES READ: text goes through the
 * credential filter first (archivedBody). The manifest's sha256 and raw_bytes
 * stay the source's — they answer "has this file grown since we archived
 * it?", and a hash of the filtered text would answer a different question
 * every time the filter changed.
 */
export function writeArchived(checkoutDir, manifestPath, entry, raw, index, { stagingDir } = {}) {
  const { _dir, ...line } = entry;
  const staging = stagingDir ?? stagingFor(checkoutDir, line.session);
  const destAbs = path.join(checkoutDir, line.dest);
  const body = archivedBody(line.source, raw);
  let stored = 0;
  let parts = null;
  // 1. Stage.
  const staged = []; // [{ from, to }]
  const stage = (rel, bytes) => {
    const from = path.join(staging, rel);
    fs.mkdirSync(path.dirname(from), { recursive: true });
    fs.writeFileSync(from, bytes);
    staged.push({ from, to: path.join(checkoutDir, rel) });
    stored += bytes.length;
  };
  if (line.encoding === "raw") {
    stage(line.dest, body);
  } else if (body.length <= SPLIT_BYTES) {
    stage(line.dest, gzip(body));
  } else {
    parts = [];
    const base = line.dest.replace(/\.gz$/, "");
    for (let i = 0, offset = 0; offset < body.length; i++, offset += SPLIT_BYTES) {
      const name = `${base}.part${String(i).padStart(2, "0")}.gz`;
      stage(name, gzip(body.subarray(offset, offset + SPLIT_BYTES)));
      parts.push(name);
    }
  }
  // 2. Into place. A file that crossed the split threshold either way
  // leaves its other shape behind, which goes first.
  if (parts !== null && fs.existsSync(destAbs)) fs.rmSync(destAbs);
  for (const { from, to } of staged) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  }
  // 3. The manifest line, last. Phase 1's columns, in phase 1's order.
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

// ── The archive, whole or for one session ────────────────────────────────────
/**
 * Archive the session files on this box that the manifests under
 * `checkoutDir`/sessions/ do not already hold at their content: all of them
 * (the sweep), or, with `only`, the one session with that id — a Claude
 * session's parent, children and attachments, or a Codex thread's rollout
 * and its subagent threads. Parents are placed before children so a child
 * archived in the same call finds its parent's directory. Returns the
 * manifest records written and the manifest's path. Takes NO lock: the
 * caller holds the checkout's writer lock (withWikiTomLock).
 *
 * A directory that is not a git checkout throws an error whose `code` is
 * "NO_CHECKOUT": the sweep records it as its failure row, the daemon as one
 * system row in the transcript.
 */
export function archiveSessionFiles({
  checkoutDir,
  day,
  codexDir = CODEX_SESSIONS_DIR,
  accountsDir = CLAUDE_ACCOUNTS_DIR,
  only = null,
  log = (line) => console.error(line),
}) {
  if (!fs.existsSync(path.join(checkoutDir, ".git"))) {
    const err = new Error(`${checkoutDir} is not a git checkout — setup.sh clones WikiTom there`);
    err.code = "NO_CHECKOUT";
    throw err;
  }
  const sessionsDir = path.join(checkoutDir, SESSIONS_DIR);
  const index = indexManifests(readManifests(sessionsDir));
  const manifestPath = path.join(sessionsDir, `manifest-box-${day}.jsonl`);
  const wanted = (f) =>
    only === null ||
    (f.runtime === "claude" ? f.session === only : f.source.includes(only));
  const files = discoverSessionFiles({ codexDir, accountsDir }).filter(wanted);
  // A leftover of a crashed earlier call to this session's staging is stale
  // by definition (nothing is renamed twice); the sweep clears the root.
  const stagingRoot = path.join(checkoutDir, STAGING_DIR);
  if (only === null) fs.rmSync(stagingRoot, { recursive: true, force: true });
  const archived = [];
  // Parents first, so a child archived the same call finds its parent's
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
  const stagingDirs = new Set();
  const write = (entry, raw) => {
    const stagingDir = stagingFor(checkoutDir, entry.session);
    stagingDirs.add(stagingDir);
    archived.push(writeArchived(checkoutDir, manifestPath, entry, raw, index, { stagingDir }));
  };
  for (const f of [...files].sort((a, b) => order(a) - order(b))) {
    const raw = fs.readFileSync(f.source);
    const sha = sha256(raw);
    if (index.shaBySource.get(f.source) === sha) continue; // archived at this content already
    const mtimeMs = fs.statSync(f.source).mtimeMs;
    if (f.runtime === "codex") {
      const meta = codexMetaOfBuffer(raw);
      if (!meta) {
        log(`[session-archive] not a Codex rollout, skipped: ${f.source}`);
        continue;
      }
      if (only !== null && meta.id !== only && meta.parent !== only) continue;
      // Children wait until every parent of this call is placed.
      codexEntries.push({ f, raw, sha, mtimeMs, meta });
      continue;
    }
    const entry = claudeEntry(f, raw, sha, mtimeMs, index, claudeAccounts);
    if (!entry) continue;
    write(entry, raw);
  }
  for (const c of codexEntries.filter((c) => c.meta.parent === null)) {
    write(codexParentEntry(c), c.raw);
  }
  for (const c of codexEntries.filter((c) => c.meta.parent !== null)) {
    write(codexChildEntry(c, index), c.raw);
  }
  for (const dir of stagingDirs) fs.rmSync(dir, { recursive: true, force: true });
  return { archived, manifestPath };
}

// ── The lock ─────────────────────────────────────────────────────────────────
/**
 * Hold /var/lock/tts-wikitom.lock for the duration of `fn`. The lock is the
 * open file description: `flock` takes it on our inherited descriptor and
 * exits, and the kernel keeps it for us until we close the descriptor — the
 * `exec 3>lock; flock 3` idiom, from Node. Every writer of the checkout (the
 * nightly job, the weekly job, a session-end archive) takes the same lock.
 * flock is spawned, not run synchronously, so a daemon waiting on it keeps
 * serving its other sessions; `waitSeconds` is how long to wait for it.
 *
 * THE LOCK COVERS THE WRITES, not only the push: the nightly job holds it
 * around its steps together. A lock held around the commit alone protects
 * nothing — another writer committing its own work while a job is still
 * writing tts/snapshot/ and sessions/ would carry half of that job's tree
 * into its commit, and `git pull --rebase` would meet a dirty tree it did
 * not make.
 */
export async function withWikiTomLock(fn, lockPath = WIKITOM_LOCK, { waitSeconds = LOCK_WAIT_SECONDS } = {}) {
  const fd = fs.openSync(lockPath, "w");
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("flock", ["-w", String(waitSeconds), "3"], {
        stdio: ["ignore", "inherit", "inherit", fd],
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`the WikiTom lock ${lockPath} was not taken within ${waitSeconds}s (flock exited ${code})`)),
      );
    });
    return await fn();
  } finally {
    fs.closeSync(fd);
  }
}

/** archiveSessionFiles for one session, under the lock: what the daemon calls
 * at session end. */
export async function archiveSessionUnderLock({ sessionId, waitSeconds, lockPath = WIKITOM_LOCK, ...rest }) {
  return await withWikiTomLock(
    () => archiveSessionFiles({ ...rest, only: sessionId }),
    lockPath,
    waitSeconds === undefined ? {} : { waitSeconds },
  );
}
