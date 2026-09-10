// nightly.mjs — the nightly job (the lifeos update, phase 4). Runs at 4:00
// a.m. New York, before the 5 a.m. digest, and does five things in order,
// each one recording a "nightly-failure" dtsEvents row if it fails and then
// letting the next one run:
//
// All five run under /var/lock/tts-wikitom.lock, taken once around them
// (steps 1 to 4 write the checkout; the post reads the HEAD they left):
//
//   1. snapshot — copies every Convex table (the six auth tables excepted)
//      into the WikiTom checkout at tts/snapshot/, one JSON-lines file per
//      table, deterministic, written only where the bytes changed, every
//      string value through the credential filter first (redactRow). A
//      NIGHTLY COPY, NOT A POINT-IN-TIME TRANSACTION: the boundary instant
//      fixes which rows are in it (those created before the job started),
//      not their state — a row updated between two pages is exported in its
//      later state, and two tables read minutes apart can disagree.
//   2. learning — applies Tom's objections from the digest thread (the
//      inverse of each named change, or a row saying why not), then reads
//      what he did since the last learning run (his session turns with the
//      agent's replies around them, his Slack replies, his rulings), makes
//      one model call over the model-of-tom pages, and applies the lines it
//      proposes that the rules allow — one "learning-change" row each, with
//      the commit, once the push has made it. See learningStep.
//   3. sessions — archives every Codex rollout and Claude SDK session file on
//      this box that WikiTom's sessions/ does not already hold at that
//      content, in phase 1's layout, and appends the manifest — the sweep
//      behind the session-end archive the daemon makes through the same
//      function (session-archive.mjs).
//   4. push — one commit per step that changed something, plus whatever an
//      earlier run left modified, `git pull --rebase`, `git push` over the
//      github.com-wikitom SSH alias. A refused pull or push is a failure row
//      and the commits stay local for the next night; nothing is retried.
  //   5. post — reads the model-of-tom files from the git object at HEAD
  //      (the stable operate, write, and know layers; each area page whole
  //      except for YAML frontmatter) and posts them
//      with the commit hash and time to POST /tts/model-of-tom — whether or
//      not the push succeeded, so every prompt names the commit it began
//      with; `pushed` says whether that commit is on GitHub yet. A named
//      file missing or empty is a failure row and NO post: the store is
//      replaced whole, so a partial post would drop that file from every
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
// node:zlib, node:crypto, node:child_process, and the global fetch. No
// shebang line, unlike its siblings: the credential filter reaches this file
// through session-archive.mjs, which finds it by a dynamic import at load,
// and vitest's transform puts an import of its own ahead of a shebang, which
// is then a syntax error. Cron and the README run it as
// `node /opt/tts/nightly.mjs`, which needs none.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_ACCOUNTS_DIR,
  CODEX_SESSIONS_DIR,
  LOCK_WAIT_SECONDS,
  SESSIONS_DIR,
  SPLIT_BYTES,
  WIKITOM_DIR,
  WIKITOM_LOCK,
  archiveSessionFiles,
  bufferLines,
  claudeEntry,
  codexMetaOf,
  codexMetaOfBuffer,
  discoverSessionFiles,
  gzip,
  indexManifests,
  readManifests,
  redactSecrets,
  sessionDateOf,
  sessionDateOfBuffer,
  sha256,
  utcDay,
  withWikiTomLock,
  writeArchived,
} from "./session-archive.mjs";
import { loadEnv, convexFetch, nyHour, runClaude, extractJsonObject, clip } from "./tts-lib.mjs";
import { assemblePreludePublication } from "../../scripts/prelude.mjs";
import {
  enclosingHeadings,
  isIsoDay,
  parseFrontmatter,
  sectionSpan,
} from "./markdown-sections.mjs";
import { CHANGE_ID_CHARS, changeIdTokens, namedChange } from "./learning-change-names.mjs";

// ── Where things are ─────────────────────────────────────────────────────────
// The checkout, its lock, the session directories, the split rule and the
// archive itself live in session-archive.mjs — the one home the daemon
// shares for a session-end archive — and are re-exported here for the
// weekly job and the tests, which read them off this module.
export {
  CLAUDE_ACCOUNTS_DIR,
  CODEX_SESSIONS_DIR,
  LOCK_WAIT_SECONDS,
  SESSIONS_DIR,
  SPLIT_BYTES,
  WIKITOM_DIR,
  WIKITOM_LOCK,
  bufferLines,
  claudeEntry,
  codexMetaOf,
  codexMetaOfBuffer,
  discoverSessionFiles,
  gzip,
  indexManifests,
  readManifests,
  sessionDateOf,
  sessionDateOfBuffer,
  sha256,
  utcDay,
  withWikiTomLock,
  writeArchived,
};
// The SSH alias setup.sh clones over (Host github.com-wikitom in
// /root/.ssh/config → the deploy key /root/.ssh/wikitom). The checkout's
// origin carries it, so `git pull` and `git push` need no URL here.
export const WIKITOM_REMOTE = "git@github.com-wikitom:Heffnt/WikiTom.git";
export const SNAPSHOT_DIR = "tts/snapshot";
// Where a table's files are assembled before they replace the checkout's:
// outside the work tree, so a failed export leaves tts/snapshot/ as it was.
export const SNAPSHOT_STAGING_DIR = "/var/cache/tts/snapshot-staging";
export const EXPORT_PAGE = 200;

/** The job's failure row (convex/ttsNightly.ts NIGHTLY_FAILURE by name). */
export const NIGHTLY_FAILURE = "nightly-failure";

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

function gitArgs(dir, args) {
  const resolved = fs.realpathSync.native(dir);
  return ["-c", `safe.directory=${resolved}`, "-C", dir, ...args];
}

function git(dir, ...args) {
  return execFileSync("git", gitArgs(dir, args), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

const STEPS = ["delivery", "snapshot", "learning", "sessions", "push", "post"];
// The four that write the WikiTom checkout. The post runs under the same
// lock after them (see main), reading what they left.
const LOCKED_STEPS = ["snapshot", "learning", "sessions", "push"];
// ── Small pure helpers (tested in nightly.test.mjs) ──────────────────────────

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
 * One exported row with every string value in it — however deep, in arrays
 * and objects alike — passed through the daemon's credential filter. THE
 * SNAPSHOT IS VERBATIM OTHERWISE, and a Convex row can hold anything a
 * model or Tom typed: a key pasted into a session turn (claudeInbound.text),
 * a setting, a captured email. The transcript rows already pass this filter
 * on their way in; the rows that never did pass it here, on their way into
 * a public-shaped git repository. Keys and non-strings are untouched, so
 * serializeRow's bytes stay deterministic night after night.
 */
export function redactRow(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactRow);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactRow(v);
    return out;
  }
  return value;
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

// ── The run ──────────────────────────────────────────────────────────────────

/** Record a failed step: the cron log, and a dtsEvents row the digest reads. */
async function recordFailure(run, step, err, { fetch = convexFetch } = {}) {
  const error = String(err?.message ?? err).slice(0, 2000);
  console.error(`[nightly] ${step} FAILED: ${error}`);
  run.failures.push({ step, error });
  try {
    await fetch(run.env, "/tts/event", {
      kind: NIGHTLY_FAILURE,
      data: { day: run.day, step, error },
    });
  } catch (postErr) {
    console.error(`[nightly] could not record the ${step} failure: ${postErr.message}`);
  }
}

// ── 1. snapshot ──────────────────────────────────────────────────────────────
/**
 * Every row of one table, paged out of GET /tts/export against one boundary
 * instant, EACH ONE THROUGH THE CREDENTIAL FILTER (redactRow, every string
 * value at every depth). This is the only way a row reaches the snapshot, so
 * "the vault holds no key" is a property of the read itself rather than a
 * line somebody has to remember to keep next to the write.
 */
export async function exportTableRows({ env, table, boundary, fetch = convexFetch }) {
  const rows = [];
  let cursor = null;
  for (;;) {
    const params = new URLSearchParams({
      table,
      boundary: String(boundary),
      numItems: String(EXPORT_PAGE),
    });
    if (cursor !== null) params.set("cursor", cursor);
    const page = await fetch(env, `/tts/export?${params}`);
    for (const row of page.rows) rows.push(redactRow(row));
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
  return rows;
}

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
    const rows = await exportTableRows({ env, table, boundary });
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
// Learning discovers the area pages in the work tree. Prelude assembly owns
// their prompt representation and reads them from a commit instead.
export const MODEL_OF_TOM_AREAS_DIR = "model-of-tom/areas";
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

/** The id git gives a blob of `text` — what `git hash-object` prints —
 * computed here so a page still in memory needs no git call. */
export function gitBlobId(text) {
  const bytes = Buffer.from(String(text ?? ""));
  return crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/**
 * The blob id of a page's BODY — the text below its frontmatter. Every
 * learning row carries two: `baseBlob`, the body the validation read, and
 * `resultBlob`, the body it wrote; a revert checks the page against the
 * newest resultBlob the job recorded for it (revertLearningChange), so a
 * line is taken back only from a page that is as the job last left it, and
 * a page Tom has edited since gets a "learning-revert-failed" row naming
 * both hashes instead of a change to text the job never saw. The body and
 * not the whole page, because the frontmatter is written by others on
 * purpose — `updated:` by the step itself, `reviewed:` by the weekly job
 * when Tom confirms a page — and neither is an edit to what the lines say.
 */
export function pageBodyBlob(text) {
  return gitBlobId(parseFrontmatter(text).body);
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

// ── Evidence ─────────────────────────────────────────────────────────────────
// A citation has one of three forms, and the id in it is EXACT — a source in
// tonight's input has that name or the citation names nothing:
//
//   session <id>   a session Tom typed in: the 8-hex prefix of its SDK id
//                  (what the pages cite), the whole SDK id, or the Convex row
//                  id of a session that never reported one
//   ruling <id>    a ruling's row id
//   thread <ts>    a Slack reply of Tom's, by its ts or its thread's
//
// "Includes an id" was the old test, and `session 47f04bc9-old` included
// one. On the line, each citation carries its date — `(session 47f04bc9,
// 2026-09-05; ruling k17…, 2026-09-05)` — and the date must fall in the
// window the input was read over: a line resting on tonight's input is dated
// tonight. And every change carries an EXCERPT: EXCERPT_MIN_WORDS or more of
// Tom's own words, verbatim, from a source it cites. The citation says where;
// the excerpt is what was there, and it is the evidence for an inference too
// — an inference that cannot quote what it rests on rests on nothing.
const CITATION = /^(session|ruling|thread) (\S+)$/;
const CITED_ENTRY = /^(session|ruling|thread) (\S+), (\d{4}-\d{2}-\d{2})$/;
export const EXCERPT_MIN_WORDS = 6;

/**
 * What tonight's input can evidence: every name a citation may use, keyed
 * "<kind> <id>", each with Tom's own words under that name (the turns he
 * typed in the session, the reply's text, the ruling's sentence and quote),
 * and the window's first and last days. A session is under each of its
 * names. Null skips the input-dependent checks (the pure tests).
 */
export function learningEvidence(input) {
  const sources = new Map();
  const add = (kind, id, ...texts) => {
    if (typeof id !== "string" || id.length < 6) return;
    const key = `${kind} ${id}`;
    const s = sources.get(key) ?? { texts: [] };
    for (const t of texts) if (typeof t === "string" && t.trim() !== "") s.texts.push(t);
    sources.set(key, s);
  };
  for (const t of input.tomTurns ?? []) {
    for (const id of new Set([sessionCitation(t), t.sdkSessionId, t.sessionId])) add("session", id, t.text);
  }
  for (const r of input.slackReplies ?? []) {
    for (const id of new Set([r.data?.ts, r.data?.threadTs])) add("thread", id, r.data?.text);
  }
  for (const r of input.rulings ?? []) add("ruling", r.id, r.sentence, r.quote);
  return { sources, sinceDay: utcDay(input.since), untilDay: utcDay(input.until) };
}

const wordCount = (text) => oneLine(text).split(" ").filter((w) => w !== "").length;

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
 * refusal would want them. `evidence` is learningEvidence(input), or null. */
function learningRefusal(c, texts, evidence) {
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
  const names = c.evidence.map((e) => e.trim());
  for (const e of names) {
    if (!CITATION.test(e)) return `evidence "${e}" is not a citation: session <id>, ruling <id> or thread <ts>`;
    if (evidence !== null && !evidence.sources.has(e)) {
      return `evidence "${e}" names nothing in tonight's input`;
    }
  }
  // The citation IS the evidence: the trailing parenthetical is the
  // change's evidence entry by entry, each with its date in the window, and
  // nothing else — "(probably)" at the end of a line that never says where
  // it came from is not a citation.
  const entries = cited[1].slice(1, -1).split(";").map((e) => e.trim());
  for (const entry of entries) {
    const m = CITED_ENTRY.exec(entry);
    if (!m) return `the citation "${entry}" is not in the form <kind> <id>, YYYY-MM-DD`;
    const name = `${m[1]} ${m[2]}`;
    if (!names.includes(name)) return `the citation names "${name}", which is not in the change's evidence`;
    if (!isIsoDay(m[3])) return `the citation date ${m[3]} is not a day`;
    if (evidence !== null && (m[3] < evidence.sinceDay || m[3] > evidence.untilDay)) {
      return `the citation date ${m[3]} is outside tonight's window (${evidence.sinceDay} to ${evidence.untilDay})`;
    }
  }
  for (const e of names) {
    if (!entries.some((entry) => entry.startsWith(`${e},`))) return `the line does not cite its evidence "${e}"`;
  }
  // The excerpt: Tom's words, verbatim, from a source the change cites.
  if (typeof c.excerpt !== "string" || wordCount(c.excerpt) < EXCERPT_MIN_WORDS) {
    return `no excerpt of ${EXCERPT_MIN_WORDS} or more of Tom's words from tonight's input`;
  }
  if (evidence !== null) {
    const wanted = oneLine(c.excerpt);
    const cites = names.flatMap((e) => evidence.sources.get(e)?.texts ?? []);
    if (!cites.some((t) => oneLine(t).includes(wanted))) {
      return "the excerpt is not in the cited input verbatim";
    }
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

/**
 * Every unit within `span` whose one-line form equals `text`'s. A caller
 * that will REMOVE OR REPLACE a bullet acts only on exactly one match: with
 * two, which is the learned copy and which is Tom's cannot be told from the
 * text, and taking the first would take his (a line he pasted above the
 * job's) while the job's stayed.
 */
function findBullets(lines, span, text) {
  const wanted = oneLine(text);
  return bulletUnits(lines, span).filter(
    (unit) => oneLine(lines.slice(unit.start, unit.end).join("\n")) === wanted,
  );
}

/**
 * Apply proposed changes to the pages (a Map of file → text), pure. Returns
 * the new texts, the changes that landed (each with its id and the digest's
 * fields), and the ones refused with the reason. `evidence` is what tonight's
 * input can evidence (learningEvidence) — null skips the checks against it.
 * Every page that took a change gets `updated: day`.
 */
export function applyLearningChanges(pages, changes, { day, evidence = null } = {}) {
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
    const why = learningRefusal(c, texts, evidence);
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
    if (findBullets(lines, { start: -1, end: lines.length }, line).length > 0) {
      refuse(c, "already on the page");
      continue;
    }
    const replaces = c.replaces ?? null;
    let before = "";
    if (replaces !== null) {
      const units = findBullets(lines, span, replaces);
      if (units.length === 0) {
        refuse(c, `the line to replace is not in "${c.section.trim()}" verbatim`);
        continue;
      }
      if (units.length > 1) {
        refuse(c, `the line to replace is in "${c.section.trim()}" ${units.length} times; which one cannot be told`);
        continue;
      }
      const [unit] = units;
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
      excerpt: oneLine(c.excerpt),
    });
  }
  for (const file of new Set(applied.map((a) => a.file))) {
    texts.set(file, bumpUpdated(texts.get(file), day));
  }
  // The body each change was validated against, and the body it left.
  for (const a of applied) {
    a.baseBlob = pageBodyBlob(pages.get(a.file));
    a.resultBlob = pageBodyBlob(texts.get(a.file));
  }
  return { pages: texts, applied, refused };
}

/**
 * The body blob the job last left each page with: the newest recorded
 * write per file (a "learning-change" or a "learning-reverted" row, both
 * carry resultBlob). A file with no recorded blob — rows from before blobs
 * were kept — is not checked.
 */
export function expectedBodyBlobs(rows) {
  const out = new Map();
  for (const r of [...(rows ?? [])].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))) {
    if (typeof r?.file === "string" && typeof r.resultBlob === "string" && !out.has(r.file)) {
      out.set(r.file, r.resultBlob);
    }
  }
  return out;
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
 * AND ONLY WHEN IT IS THERE ONCE: two copies in the section — Tom's, pasted
 * above the job's — cannot be told apart by their text, so neither goes and
 * the reason says so (an objection reverts the learned change, never his).
 * AND ONLY ON A PAGE AS THE JOB LEFT IT: `expectedBlob`, when given, is the
 * body blob the job last recorded for the page (expectedBodyBlobs), and a
 * page whose body no longer hashes to it has been edited since — the revert
 * is refused with both hashes rather than applied to text the job never
 * read. Returns `baseBlob` and `resultBlob` for the revert's own row.
 */
export function revertLearningChange(text, change, { expectedBlob = null } = {}) {
  const after = String(change.after ?? "").trim();
  if (after === "") return { ok: false, reason: "the change records no line to look for" };
  const baseBlob = pageBodyBlob(text);
  if (expectedBlob !== null && expectedBlob !== baseBlob) {
    return {
      ok: false,
      reason: `${change.file} has changed since the job last wrote it (body blob ${expectedBlob.slice(0, 12)}, now ${baseBlob.slice(0, 12)}); nothing was taken back`,
    };
  }
  const lines = text.split("\n");
  const located = locateSection(lines, change.file, change.section);
  if (located.span === undefined) return { ok: false, reason: located.reason };
  const { span } = located;
  const units = findBullets(lines, span, after);
  const section = String(change.section).trim();
  if (units.length === 0) {
    return { ok: false, reason: `the line is no longer in "${section}" on ${change.file} as written` };
  }
  if (units.length > 1) {
    return {
      ok: false,
      reason: `the line is in "${section}" on ${change.file} ${units.length} times — the learned copy cannot be told from the others, so none was taken back`,
    };
  }
  const [unit] = units;
  const before = oneLine(change.before);
  lines.splice(unit.start, unit.end - unit.start, ...(before === "" ? [] : [before]));
  const reverted = lines.join("\n");
  return { ok: true, text: reverted, baseBlob, resultBlob: pageBodyBlob(reverted) };
}

/**
 * The change an objection names: by the change's id — the row's own, or a
 * name in the text by the one rule in learning-change-names.mjs, which is
 * also how ttsSlack.ts read the reply — else by the line's text quoted in
 * the objection.
 */
export function matchObjection(objection, rows) {
  // The rows carry reverts too (their blobs, for expectedBodyBlobs); an
  // objection names a change.
  const changes = (rows ?? []).filter((r) => r?.eventKind === undefined || r.eventKind === "learning-change");
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
    "- Every line ends with its evidence, in the pages' citation style, in parentheses: (session <session>, YYYY-MM-DD) for a turn — `session` is the 8-character id the pages already cite, e.g. (session 47f04bc9, 2026-08-30) — (ruling <rulingId>, YYYY-MM-DD) for a ruling, (thread <ts>, YYYY-MM-DD) for a Slack reply; several joined with \"; \". The ids are the ones in the input, verbatim and whole, and the date is the input's date, inside tonight's window. `evidence` lists the same citations without their dates (\"session <session>\", \"ruling <rulingId>\", \"thread <ts>\"), and every one of them must appear in the line. A citation naming anything not in the input is refused.",
    `- \`excerpt\` is ${EXCERPT_MIN_WORDS} or more of Tom's own words, verbatim, from a source the change cites — the turn he typed, his reply, his ruling's sentence — never the agent's words. It is the evidence for a fact, a correction and an inference alike; a change without one is refused.`,
    "- Only these pages: model-of-tom/writing.md, model-of-tom/priorities.md, model-of-tom/areas/<area>.md. Only a section that exists on the page, named by its heading. Never \"Directions\", never \"Ideal state\", never \"Must not break\" — those are Tom's own, and a change naming them is refused. Never the spec.",
    "- A correction replaces: `replaces` is one existing bullet of that section, verbatim — where the page wraps a bullet over several lines, quote all of them — and the new line supersedes it — the pages describe what is, never what was. An addition has `replaces: null`.",
    "- Write to writing.md's own rules: plain statements, no comparisons or analogies, no evaluative language, one fixed term per concept, the date in the line. One line, starting with \"- \".",
    "- Nothing from the agent's words alone; nothing already on a page; nothing that restates a line. An empty list is the right answer on a night whose input changes nothing about the model of Tom, and that is most nights.",
    "",
    "Answer with ONE JSON object and nothing else, no code fence:",
    '{"changes":[{"file":"model-of-tom/areas/climbing.md","section":"Current state","kind":"fact","line":"- ... (session <session>, YYYY-MM-DD).","replaces":null,"evidence":["session <session>"],"excerpt":"<six or more of Tom\'s words, verbatim>"}]}',
    "",
    "INPUT",
    JSON.stringify(shown, null, 1),
    "",
    "PAGES",
    pageText,
    "",
    `Tonight is ${day} (UTC).`,
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
  // The body blob the job last left each page with; a revert this run makes
  // moves it on, so the next objection to the same page checks against the
  // page as this run left it.
  const expected = expectedBodyBlobs(input.changes);
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
          ? revertLearningChange(fs.readFileSync(abs, "utf8"), change, {
              expectedBlob: expected.get(change.file) ?? null,
            })
          : { ok: false, reason: `${change.file} is not a page in the checkout` };
      const named = { id: change.id, file: change.file, section: change.section ?? null };
      if (result.ok) {
        fs.writeFileSync(abs, bumpUpdated(result.text, run.day));
        expected.set(change.file, result.resultBlob);
        const row = {
          kind: "learning-reverted",
          data: {
            ...note,
            ...named,
            before: change.after,
            after: change.before,
            baseBlob: result.baseBlob,
            resultBlob: result.resultBlob,
          },
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
      evidence: learningEvidence(input),
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
  // The sweep: every session file on the box the manifests do not hold at
  // its content (session-archive.mjs, the one home the daemon's session-end
  // archive shares). The lock is main()'s.
  const { archived } = archiveSessionFiles({
    checkoutDir: run.dir,
    day: run.day,
    codexDir: CODEX_SESSIONS_DIR,
    accountsDir: CLAUDE_ACCOUNTS_DIR,
    log: (line) => console.error(`[nightly] sessions: ${line}`),
  });
  console.log(`[nightly] sessions: ${archived.length} file(s) archived`);
  if (archived.length > 0) {
    run.commits.push({
      paths: [SESSIONS_DIR],
      message: `sessions: ${run.day} — ${archived.length} file${archived.length === 1 ? "" : "s"} archived from the box`,
    });
  }
  return { archived: archived.length };
}

// ── 4. the push ──────────────────────────────────────────────────────────────
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
    execFileSync("git", gitArgs(dir, ["rebase", "--abort"]), { stdio: "ignore" });
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
export function commitTree(dir, commits, day, { guardRebase = true } = {}) {
  const made = [];
  // A caller that already aborted a stale rebase before its own write (the
  // weekly job's commitUnderLock) passes guardRebase: false — the check is
  // one per write, not one before the write and one here.
  const failures = guardRebase ? abortStaleRebase(dir) : [];
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
      execFileSync("git", gitArgs(dir, ["rebase", "--abort"]), { stdio: "ignore" });
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
  return execFileSync("git", gitArgs(dir, args), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// `git diff --cached --quiet` exits 1 when the index differs from HEAD.
function stagedChanges(dir) {
  try {
    execFileSync("git", gitArgs(dir, ["diff", "--cached", "--quiet"]), { stdio: "ignore" });
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
// Under the lock like the four steps before it, the shared prelude assembler
// reads local HEAD from its immutable git object. Local HEAD is posted whether or
// not the push went through — the design says every prompt names the
// commit it began with — and `pushed` says which, so the store and the
// digest can say "not yet pushed" rather than pass a local commit off as
// one on GitHub. Convex refuses a post older than the one it holds, so a
// rerun of an old checkout cannot roll the prelude back (ttsSkills.ts).
export async function postStep(run, deps = {}) {
  const { fetch = convexFetch } = deps;
  const dir = run.dir;
  // A REBASE IN PROGRESS MEANS NO POST. During one, HEAD is detached on a
  // half-replayed commit: `rev-parse HEAD` names it, `git show <commit>:<path>`
  // reads whatever version of the pages that replay had reached, and Convex —
  // which only refuses a post OLDER than the one it holds — would take it and
  // serve it to every prompt until a clean night replaced it. The four steps
  // before this one never meet that state, because the run aborts a stale
  // rebase before its first write (main); `--only=post` runs none of them, so
  // the guard belongs here too. Recorded, not thrown, and NOT aborted: an
  // abort resets the work tree hard, and a post is a read.
  if (rebaseInProgress(dir)) {
    await recordFailure(
      run,
      "post",
      new Error(
        `a rebase is in progress in ${dir} — HEAD is a replayed commit, not the checkout's; refusing to post, the store keeps what it has`,
      ),
      { fetch },
    );
    return { commit: null, pushed: false, files: null, rebasing: true };
  }
  let prelude;
  try {
    // The assembler resolves HEAD and reads every body from that immutable
    // object. The header variants below stay pinned to the resolved hash.
    prelude = assemblePreludePublication({ wikitom: dir, commit: "HEAD" });
  } catch (error) {
    await recordFailure(
      run,
      "post",
      error,
      { fetch },
    );
    return { commit: null, pushed: false, files: null };
  }
  const files = prelude.files.map(({ path: filePath, sourceBody: body, bytes }) => ({ path: filePath, body, bytes }));
  const res = await fetch(run.env, "/tts/model-of-tom", {
    commit: prelude.commit,
    committedAt: prelude.committedAt,
    pushed: prelude.pushed,
    layers: prelude.layers,
    files,
    headers: prelude.headers,
  });
  console.log(
    `[nightly] post: ${res.files} file(s) at WikiTom ${prelude.commit.slice(0, 12)}${prelude.pushed ? "" : " (not yet pushed)"} — ${files.map((f) => f.path).join(", ")}`,
  );
  return { commit: prelude.commit, pushed: prelude.pushed, files: files.map((f) => f.path) };
}

// This check never touches the checkout, so it runs outside the WikiTom
// writer lock and before tonight's post can enter the commit timeline.
export async function deliveryStep(run, deps = {}) {
  const fetch = deps.fetch ?? convexFetch;
  const facts = await fetch(run.env, `/tts/prelude-delivery?until=${run.now}`);
  await fetch(run.env, "/tts/event", {
    kind: "prelude-delivery",
    data: { day: run.day, ...facts },
  });
  console.log(
    `[nightly] delivery: ${facts.current} session(s) on the current model-of-tom commit, ` +
      `${facts.stale.length} older, ${facts.missing.length} with no prelude`,
  );
  return facts;
}

// ── main ─────────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
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
  // The DST guard: cron fires at 08:00 and 09:00 UTC and exactly one is the
  // 4 a.m. New York hour (system cron is UTC and knows nothing about DST).
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
  // Delivery touches neither the checkout nor git. Run it before taking the
  // lock, and before tonight's post could change the timeline it compares.
  if (only.includes("delivery")) {
    try {
      run.results.delivery = await deliveryStep(run);
    } catch (err) {
      await recordFailure(run, "delivery", err);
    }
  }
  // No checkout is a bad night, not a silent one: the digest reads these two
  // rows, and a run that threw here wrote neither — the one morning Tom would
  // see nothing at all is the morning the checkout is gone.
  if (!fs.existsSync(path.join(run.dir, ".git"))) {
    if (only.length === 1 && only[0] === "delivery") {
      await recordSummary(run, only);
      return;
    }
    await recordFailure(
      run,
      "checkout",
      new Error(`${run.dir} is not a git checkout — setup.sh clones WikiTom there`),
    );
    await recordSummary(run, only);
    return;
  }
  const steps = {
    delivery: deliveryStep,
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
  // Every step runs under the one lock (see withWikiTomLock): steps 1 to 4
  // write the checkout, and the post reads HEAD's git object, which must be
  // the HEAD this run left — not one a writer that took the lock in between
  // moved it to.
  const locked = LOCKED_STEPS.filter((name) => only.includes(name));
  try {
    await withWikiTomLock(async () => {
      if (locked.length > 0) {
        // Before the first write: a rebase an earlier run left in progress
        // stops every commit, and aborting it resets the work tree hard — so
        // it happens while there is nothing of tonight's to lose.
        for (const f of abortStaleRebase(run.dir)) {
          await recordFailure(run, f.step, new Error(f.error));
        }
        for (const name of locked) await runStep(name);
        // The learning step's rows wait for this: their commits exist now,
        // with their final hashes (pushed, or local when the push was
        // refused).
        await recordLearningRows(run);
      }
      if (only.includes("post")) await runStep("post");
    });
  } catch (err) {
    // The lock itself was refused — another writer held it past the wait.
    // Every step is skipped; the summary below says so.
    await recordFailure(run, "lock", err);
  }
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
    delivery: run.results.delivery ?? null,
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
