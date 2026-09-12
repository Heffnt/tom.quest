// nightly.mjs — the nightly job (the lifeos update, phase 4). Runs at 4:00
// a.m. New York, before the 5 a.m. digest, and does ten things in order,
// each one recording a "nightly-failure" dtsEvents row if it fails and then
// letting the next one run:
//
//   1. delivery — asks Convex which live sessions are on the current
//      model-of-tom commit, which are on an older one, and which got no
//      prelude at all, and records the counts. FIRST, and OUTSIDE the lock:
//      it reads no checkout, and it must compare the timeline as tonight's
//      post found it, not as tonight's post left it.
//   2. golden-export — runs scripts/export-golden.mjs --source labels against
//      a tom.quest cache clone, turning every judgment Tom wrote about a
//      registered run into an eval case under evals/golden/runs/. NIGHTLY and
//      not weekly: Convex evicts a run's output after thirty days and a label
//      whose run is gone is unbuildable, so a weekly pass would lose cases to a
//      window nothing can reopen. It writes no WikiTom file and takes no lock,
//      and it NEVER pushes main from this box — see goldenExportStep for the
//      landing seam.
//   3. snapshot — copies every Convex table (the six auth tables excepted)
//      into the WikiTom checkout at tts/snapshot/, one JSON-lines file per
//      table, deterministic, written only where the bytes changed, every
//      string value through the credential filter first (redactRow). A
//      NIGHTLY COPY, NOT A POINT-IN-TIME TRANSACTION: the boundary instant
//      fixes which rows are in it (those created before the job started),
//      not their state — a row updated between two pages is exported in its
//      later state, and two tables read minutes apart can disagree.
//   4. graph — runs the vocabulary generator (scripts/vocabulary.mjs) and
//      then the graph generator (scripts/graph.mjs) against the two
//      checkouts and the copy step 3 has just written, and makes ONE commit
//      for tts/vocabulary.json and tts/graph.json. A disagreement in either
//      is a failed step and nothing is written. See graphStep for why it sits
//      here and why the tom.quest half of the vocabulary's write is never
//      committed by this job.
//   5. learning — applies Tom's objections from the digest thread (the
//      inverse of each named change, or a row saying why not), then reads
//      what he did since the last learning run (his session turns with the
//      agent's replies around them, his Slack replies, his rulings), makes
//      one model call over the model-of-tom pages, and applies the lines it
//      proposes that the rules allow — one "learning-change" row each, with
//      the commit, once the push has made it. See learningStep.
//   6. runs — pages the verified run manifest from Convex and appends its
//      already-normalized entries to WikiTom's monthly manifests. Transcript
//      bytes stay in the configured object store rather than entering git.
//   7. repo-learning — reads the legacy WikiTom session transcripts still
//      available to this established synthesis step for what those sessions
//      learned about the REPOSITORIES they worked in,
//      and writes the evidence entries under model-of-tom/evidence/repos/.
//      The synthesis lines themselves live in each repo's own AGENTS.md, so
//      what lands here is proposals and evidence, never the rule files.
//   8. push — one commit per step that changed something, plus whatever an
//      earlier run left modified, `git pull --rebase`, `git push` over the
//      github.com-wikitom SSH alias. A refused pull or push is a failure row
//      and the commits stay local for the next night; nothing is retried.
//   9. post — TWO HALVES off the one HEAD, in order. First the base: the
//      model-of-tom files read from the git object at HEAD (the stable
//      operate, write, and know layers; each area page whole except for YAML
//      frontmatter), posted with the commit hash and time to
//      POST /tts/model-of-tom — whether or not the push succeeded, so every
//      prompt names the commit it began with; `pushed` says whether that
//      commit is on GitHub yet. A named file missing or empty is a failure
//      row and NO post: the store is replaced whole, so a partial post would
//      drop that file from every prompt. Then the skills: the box's three
//      skill directories written from the same commit
//      (scripts/publish-skills.mjs, BOX_SKILLS_DIRS), and the catalog to
//      POST /tts/skills. The skills half is its own failure row and never
//      throws, so a night that cannot publish them still delivered the base.
//  10. repo-rules — reads DIFFERENT checkouts (tom.quest, WikiTom and
//      ComplexMultiTrigger) for their nested AGENTS.md bodies and posts them
//      to POST /tts/repo-rules, one post per repo, so the context assembler —
//      which runs inside Convex and has no filesystem — can expand them for a
//      session's own directories. LAST, and outside the lock, for the mirror
//      of delivery's reason: it touches nothing the WikiTom writers wrote, so
//      a night that lost the lock still runs it. Each repo is isolated: a
//      missing clone is one failure row and the others still post.
//
// Steps 3 to 8 write the WikiTom checkout and run under
// /var/lock/tts-wikitom.lock, taken once around them; the post reads the HEAD
// they left, so it is inside the same lock. Steps 1, 2 and 10 are outside it
// (CHECKOUTLESS_STEPS), and a box with no WikiTom clone at all still runs
// them.
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
// the object-backed run manifest, and a lost checkout is one clone away. The deploy key
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
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CLAUDE_ACCOUNTS_DIR,
  CODEX_SESSIONS_DIR,
  LOCK_WAIT_SECONDS,
  RUNS_DIR,
  SESSIONS_DIR,
  SPLIT_BYTES,
  WIKITOM_DIR,
  WIKITOM_LOCK,
  appendRunManifest,
  bufferLines,
  claudeEntry,
  codexMetaOf,
  codexMetaOfBuffer,
  discoverSessionFiles,
  gzip,
  indexManifests,
  isRunManifestEntry,
  latestRunManifestCursor,
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
import { cacheRepoDir } from "./tts-code-lib.mjs";
import {
  enclosingHeadings,
  isIsoDay,
  parseFrontmatter,
  sectionSpan,
} from "./markdown-sections.mjs";
import { CHANGE_ID_CHARS, changeIdTokens, namedChange } from "./learning-change-names.mjs";
import {
  EVIDENCE_FORMS,
  applyRecords,
  bulletUnits,
  evidencePath,
  findBullets,
  oneLine,
  parseEvidenceEntries,
  renderEvidenceEntry,
  renderSynthesisLine,
  revertRecords,
  wordCount,
} from "./learning-records.mjs";
import {
  GROUND_FILE,
  GROUND_SIGNALS_MAX,
  groundSectionFollows,
  groundSignals,
  isGroundConfirmedSection,
} from "./learning-ground.mjs";
import {
  REPO_LEARNING_RUN,
  REPO_PROPOSAL,
  appendProposalEntry,
  chooseSessions,
  dedupeProposals,
  dropProposal,
  evidenceLinesOf,
  parseRepoAnswer,
  priorProposalSentences,
  proposalHeading,
  proposalId,
  readRepoRules,
  reconcileApplied,
  renderProposalEntry,
  repoEvidencePath,
  repoLearningPrompt,
  repoRuleBullets,
  transcriptEvidence,
  transcriptPath,
} from "./learning-repo.mjs";

// The prelude assembler lives in the repo at scripts/prelude.mjs and on the
// box at /opt/tts/scripts/prelude.mjs, while the jobs themselves are copied
// flat into /opt/tts (worker/setup.sh). One specifier cannot name both, so
// both are tried, in that order, and the failure names them. A static import
// of either path kills the whole job at load on the layout it does not match,
// which is why this is a dynamic load at the two call sites instead.
const PRELUDE_CANDIDATES = ["../../scripts/prelude.mjs", "./scripts/prelude.mjs"];

async function loadPrelude() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const errors = [];
  for (const candidate of PRELUDE_CANDIDATES) {
    try {
      return await import(pathToFileURL(path.resolve(here, candidate)).href);
    } catch (err) {
      errors.push(`${candidate}: ${err.message}`);
    }
  }
  throw new Error(`prelude.mjs is not reachable (${errors.join("; ")})`);
}

// The two other scripts/ modules the post needs, found the same way and for the
// same reason: publish-skills.mjs writes the box's skill directories, and
// skills.mjs owns the one spelling of a skill's directory name. setup.sh copies
// both to /opt/tts/scripts/ beside prelude.mjs, so the same pair of candidates
// resolves in the checkout and on the box. loadPrelude is left alone rather
// than folded into this: it names the assembler in its own failure, and the
// assembler is the thing being retired.
async function loadScript(file) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const errors = [];
  for (const candidate of [`../../scripts/${file}`, `./scripts/${file}`]) {
    try {
      return await import(pathToFileURL(path.resolve(here, candidate)).href);
    } catch (err) {
      errors.push(`${candidate}: ${err.message}`);
    }
  }
  throw new Error(`${file} is not reachable (${errors.join("; ")})`);
}

const loadPublishSkills = () => loadScript("publish-skills.mjs");
const loadSkills = () => loadScript("skills.mjs");

// ── Where things are ─────────────────────────────────────────────────────────
// The checkout, its lock, the session directories, the split rule and the
// archive itself live in session-archive.mjs — the one home the daemon
// shares for a session-end archive — and are re-exported here for the
// weekly job and the tests, which read them off this module.
export {
  CLAUDE_ACCOUNTS_DIR,
  CODEX_SESSIONS_DIR,
  LOCK_WAIT_SECONDS,
  RUNS_DIR,
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
// The bullet machinery moved to learning-records.mjs, which owns both halves
// of a line; re-exported here because the weekly job and the tests read it
// off this module.
export { bulletUnits, evidencePath, oneLine, renderEvidenceEntry, renderSynthesisLine };
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

// THE STEP ORDER, and where a step is inserted.
//
//   delivery           needs no checkout and no lock: asks Convex what prelude
//                      each session got. The [before-snapshot] slot — anything
//                      else of that shape goes here too, AHEAD of snapshot and
//                      OUTSIDE the lock.
//   golden-export      that slot's other occupant: writes a tom.quest cache
//                      clone, not this checkout, and runs before learning so
//                      the night's labels are eval cases before the night's
//                      learning reads the same record.
//   snapshot           writes tts/snapshot/
//   graph              writes tts/vocabulary.json and tts/graph.json. AFTER
//                      snapshot because its record half is built from the
//                      table copy that step has just written, and BEFORE
//                      learning because the map candidate is a diff against
//                      model-of-tom/agent-rules.md
//   learning           writes model-of-tom/ and model-of-tom/evidence/
//   sessions           writes sessions/ — the archived transcripts
//   repo-learning      reads those transcripts, writes evidence/repos/
//   [before-push]      any further writer of the checkout goes here
//   push               commits, pulls --rebase, pushes
//   post               reads HEAD's git object and posts the prelude
//   repo-rules         reads a DIFFERENT checkout and posts its AGENTS.md
//                      bodies. Last, and outside the lock, for the same reason
//                      delivery is first: it touches nothing WikiTom holds.
//
// repo-learning runs AFTER sessions because it reads the transcripts that
// step archives, and BEFORE push so its writes ride the night's commit.
// NOTHING here is reordered without moving the comment with it.
const STEPS = ["delivery", "golden-export", "snapshot", "graph", "learning", "runs", "repo-learning", "push", "post", "repo-rules"];
// The repo checkouts whose AGENTS.md files ride into Convex beside the
// model-of-tom layers (the dynamic-context round). Convex has no filesystem, so
// the assembler cannot read a checkout at all — a run with no checkout of its
// own (prepare, triage, the planner) would otherwise not even know these files
// exist, which is the unknown-unknown the fetchable block is for.
//
// The box clones tom.quest to /root (worker/setup.sh runs from there); the
// laptop's copy is where scripts/laptop-setup.mjs puts it. WikiTom IS one of
// them: it is the vault, and it also carries a root AGENTS.md of its own, so
// its rules ride in beside the others — under the directory this run already
// works in (WIKITOM_DIR, from session-archive.mjs), never a second spelling of
// that path.
//
// NO PLACEHOLDER ROWS. Overleaf, Byobu, THMM and BioEng are named in the map
// and have no checkout on this box; a row for one of them would be a recorded
// failure every night forever, which is noise rather than news. Each gets an
// entry the night it gets a clone.
export const TOM_QUEST_DIR = process.env.TOM_QUEST_DIR
  || (process.platform === "win32" ? "C:/Users/heffn/Desktop/tom.quest" : "/root/tom.quest");
export const CMT_DIR = process.env.CMT_DIR
  || (process.platform === "win32"
    ? "C:/Users/heffn/Desktop/booleanbackdoor/ComplexMultiTrigger"
    : "/root/ComplexMultiTrigger");
export const REPO_CHECKOUTS = [
  { repo: "tom.quest", dir: TOM_QUEST_DIR },
  { repo: "WikiTom", dir: WIKITOM_DIR },
  { repo: "ComplexMultiTrigger", dir: CMT_DIR },
];

// THE THREE SKILL DIRECTORIES ON THIS BOX, and the only three. The two Claude
// accounts are separate installs because each has its own CLAUDE_CONFIG_DIR
// (/root/.claude-accounts/gmail and .../wpi, which tts-account switches
// between) and Claude Code reads its personal skills out of
// `$CLAUDE_CONFIG_DIR/skills`. The third is `$CODEX_HOME/skills`, and
// CODEX_HOME on this box is /root/.codex. worker/setup.sh makes all three and
// writes nothing into them: the nightly is the one publisher.
export const BOX_SKILLS_DIRS = Object.freeze([
  "/root/.claude-accounts/gmail/skills",
  "/root/.claude-accounts/wpi/skills",
  "/root/.codex/skills",
]);

/** The directories tonight writes: BOX_SKILLS_DIRS, or TTS_SKILLS_DIRS when it
 * is set — a path-delimiter-separated list, which is how the tests point the
 * publication at a temporary directory instead of /root. */
export function boxSkillsDirs() {
  const override = process.env.TTS_SKILLS_DIRS;
  if (override === undefined || override.trim() === "") return [...BOX_SKILLS_DIRS];
  return override.split(path.delimiter).map((entry) => entry.trim()).filter((entry) => entry !== "");
}
// The six that write the WikiTom checkout. The post runs under the same
// lock after them (see main), reading what they left.
const LOCKED_STEPS = ["snapshot", "graph", "learning", "runs", "repo-learning", "push"];
// The steps that never read the WikiTom checkout: delivery asks Convex what it
// delivered, golden-export and repo-rules read a different repo entirely. A
// night with no WikiTom checkout still runs these three — see main.
const CHECKOUTLESS_STEPS = ["delivery", "golden-export", "repo-rules"];
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

// ── the graph ────────────────────────────────────────────────────────────────
/**
 * The vocabulary and the graph, regenerated from the two checkouts and the
 * night's table copy and written into the WikiTom checkout as ONE commit.
 *
 * WHY THE STEP SITS HERE — after snapshot, under the lock — in three parts:
 *
 *   1. it writes WikiTom files (tts/vocabulary.json and tts/graph.json), so it
 *      belongs under /var/lock/tts-wikitom.lock with the other writers;
 *   2. the map candidate is a diff against model-of-tom/agent-rules.md, and a
 *      diff computed after the learning step's rewrites would describe a map
 *      that had just moved under it;
 *   3. the record half is built from tts/snapshot/*.jsonl, which the snapshot
 *      step has just written — so the graph's record half is exactly
 *      reproducible from the commit, and the generator opens no Convex
 *      connection and needs no credential of its own.
 *
 * THE VOCABULARY RUNS FIRST because it is the graph's schema: scripts/graph.mjs
 * reads tts/vocabulary.json for the term, job, question and repository nodes,
 * and checks every node and edge kind it minted against the closed lists the
 * vocabulary declares.
 *
 * ONE COMMIT FOR BOTH FILES. They are generated from one run of one step out of
 * one pair of commits, and neither can be regenerated without the other; two
 * commits would make the pair's versions look independently authored.
 *
 * A DISAGREEMENT IN EITHER IS A FAILED STEP AND NOTHING IS WRITTEN: both
 * generators refuse to write past one, and the throw here carries the report so
 * the "nightly-failure" row says which disagreement it was.
 *
 * THE TOM.QUEST SIDE IS NEVER COMMITTED BY THIS JOB. The generated block in
 * convex/ttsShared.ts is tom.quest's file; this job holds the WikiTom lock and
 * pushes WikiTom. The vocabulary generator rewrites that block in the tom.quest
 * checkout on disk, which leaves that checkout modified, and a block that
 * differed from the render is recorded as a failure — it reaches #tts-broken
 * through recordFailure, where a person lands it through tom.quest's own gate.
 * Recorded rather than thrown for the reason skillsHalf is: the WikiTom half of
 * the night is written and committed by then, and the summary must still carry
 * the two versions it produced.
 */
async function graphStep(run) {
  // Both generators live in scripts/, which is a directory in a checkout and a
  // flat sibling on the box; loadScript tries both spellings and names them in
  // its failure, so a box missing one of these files fails THIS STEP with a
  // readable message rather than killing the whole job at module load.
  const vocabularyModule = await loadScript("vocabulary.mjs");
  const graphModule = await loadScript("graph.mjs");
  const { generateVocabulary } = vocabularyModule;
  const { generateGraph } = graphModule;
  if (typeof generateVocabulary !== "function") {
    throw new Error("scripts/vocabulary.mjs exports no generateVocabulary — the graph's schema has no generator");
  }
  if (typeof generateGraph !== "function") {
    throw new Error("scripts/graph.mjs exports no generateGraph");
  }

  // The repositories this job already names, LESS tom.quest, which the
  // generator reads through its own `tomQuest` argument — a second entry for it
  // would read the same AGENTS.md files twice. Only the clones that are really
  // here, the same forgiving filter skillsHalf uses: a missing checkout is
  // already the repo-rules step's own failure row.
  const repos = REPO_CHECKOUTS
    .filter(({ repo, dir }) => repo !== "tom.quest" && fs.existsSync(path.join(dir, ".git")))
    .map(({ repo, dir }) => ({ repo, dir }));

  // THE VOCABULARY REPORTS AND DOES NOT WRITE, YET, and the yet is the point.
  //
  // Its first run against the real repositories found seven D1 disagreements —
  // the seven prompt terms are worded one way in spec §12.1 and another way in
  // convex/ttsShared.ts's TTS_CLOSED_VOCABULARY — plus a terms section over the
  // 40 KiB cap and a map candidate over the 7,000-byte bound. Every one of
  // those is a real fact about the system and none of them is this round's to
  // settle: the first is Tom's wording, and the other two are numbers to
  // re-argue against what was measured rather than estimated.
  //
  // A step that failed on them would fail every night from the night it shipped,
  // which is a red job nobody can act on. A step that wrote over them would put
  // a file on disk that states something the spec and the code do not both say,
  // which is the one thing the file exists to prevent. So it runs, its
  // disagreements ride the step's result into the `nightly-run` row and the
  // digest, and it writes nothing. When those three are settled this becomes
  // `write: true` and a throw, in one edit, and the graph's own half already
  // works that way.
  const vocabulary = generateVocabulary({ wikitom: run.dir, tomQuest: TOM_QUEST_DIR, write: false });
  if (vocabulary.disagreements.length > 0) {
    console.log(
      `[nightly] graph: the vocabulary reports ${vocabulary.disagreements.length} disagreement(s) `
        + "and writes nothing; they are Tom's to settle, see graphStep",
    );
  }
  const graph = generateGraph({
    wikitom: run.dir,
    tomQuest: TOM_QUEST_DIR,
    record: path.join(run.dir, SNAPSHOT_DIR),
    repos,
    write: true,
  });
  if (graph.disagreements.length > 0) {
    throw new Error(`graph: ${graph.disagreements.length} disagreement(s) — nothing written\n${graph.report}`);
  }

  const changed = [...vocabulary.changed, ...graph.changed];
  const paths = changed.filter((entry) => entry.startsWith("tts/"));
  if (paths.length > 0) {
    run.commits.push({
      paths,
      message:
        `graph: ${run.day} — vocabulary ${vocabulary.version}, graph ${graph.version}, `
          + `${graph.counts.nodes} nodes, ${graph.counts.edges} edges`,
    });
  }
  console.log(
    `[nightly] graph: vocabulary ${vocabulary.version}, graph ${graph.version} (record ${graph.recordVersion}), `
      + `${graph.counts.nodes} nodes, ${graph.counts.edges} edges, ${graph.bytes}/${graph.cap} bytes; `
      + `${paths.length === 0 ? "nothing changed" : paths.join(", ")}`
      + `; map candidate ${vocabulary.mapCandidateChanged ? "changed" : "unchanged"}`,
  );

  const result = {
    vocabulary: {
      version: vocabulary.version,
      counts: vocabulary.counts,
      bytes: vocabulary.bytes,
      changed: vocabulary.changed,
      // The row says what the vocabulary found and that it wrote nothing, so
      // the digest can carry the count and the morning reader can act on it.
      wrote: false,
      disagreements: vocabulary.disagreements.length,
      report: String(vocabulary.report ?? "").slice(0, 2_000),
    },
    graph: {
      version: graph.version,
      recordVersion: graph.recordVersion,
      counts: { nodes: graph.counts.nodes, edges: graph.counts.edges },
      bytes: graph.bytes,
      cap: graph.cap,
      changed: graph.changed,
      wrote: graph.wrote,
    },
    changed: paths,
    mapCandidateChanged: vocabulary.mapCandidateChanged === true,
    // Enough of the diff to read in a failure row or a digest line, and no
    // more: the whole diff is the candidate file, which is in the commit.
    mapCandidateDiff: String(vocabulary.mapCandidateDiff ?? "").slice(0, 2_000),
  };

  // Anything the generators changed OUTSIDE tts/ is tom.quest's — today that is
  // only convex/ttsShared.ts — and this job cannot land it. Named, not summed:
  // the row has to say which file drifted.
  const outside = changed.filter((entry) => !entry.startsWith("tts/"));
  if (outside.length > 0) {
    result.outsideWikitom = outside;
    await recordFailure(
      run,
      "graph",
      new Error(
        `${outside.join(", ")} on disk differed from the render at vocabulary ${vocabulary.version} — `
          + "the generator rewrote it in the tom.quest checkout, which this job never commits or pushes; "
          + "land it through tom.quest's own gate",
      ),
    );
  }
  return result;
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
// TWO RECORDS, WRITTEN TOGETHER. A change is one synthesis line for one
// section of one page PLUS the evidence entry that supports it, under the
// same heading of model-of-tom/evidence/<the same path>. The page carries no
// quotation, no date and no citation; his words are in the entry. Neither
// half is written without the other (learning-records.mjs applyRecords), and
// THE WHOLE NIGHT'S WRITE IS GATED ON WikiTom's own checker: it runs once
// before anything is written — a checkout already failing is somebody else's
// damage and this job writes nothing — and once after, and a run that would
// fail it is rolled back whole, byte for byte.
//
// THE JOB, NOT THE MODEL, DECIDES WHAT LANDS. A change is refused when it
// names a file the step does not write (the spec, agent-rules.md,
// schedule.md, anything outside writing.md, priorities.md, ground.md,
// intent.md and areas/), a section Tom owns (Directions, Ideal state, Must
// not break — ruling 13) or one nested under it, a line carrying a citation,
// a date or a quotation of his, evidence that names nothing in tonight's
// input, a `said:` that is not in its source verbatim, a change to ground.md
// naming no deterministic signal (learning-ground.mjs — his rule: fluent use
// is not confirmation), a line on a page he has reviewed that is not his own
// correction, a replacement whose target is not on the page verbatim, or a
// line already there. What lands is one "learning-change" row each — {id,
// file, section, before, after, beforeEntry, afterEntry, inferred, evidence,
// modelOfTomCommit} — posted once the push step has made the commit, and the
// 5 a.m. digest prints each with its id. Tom objects by replying on that
// line; the
// NEXT night applies the inverse first (learningObjections below), records
// "learning-reverted" or, when the text has moved on, "learning-revert-
// failed" with the reason, and the digest reports it. Observe and object is
// the default (Tom's term, 2026-09-09; "report and object" is retired): the
// work is done and then reported, and nothing waits on him.
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
// agent-rules.md is how agents work — it changes by design round, not by a
// night's turn — and schedule.md is written by the weekly job; neither is
// here, on purpose.
export const LEARNING_FILES_FIRST = [
  "model-of-tom/writing.md",
  "model-of-tom/priorities.md",
  "model-of-tom/ground.md",
  "model-of-tom/intent.md",
];
export const INTENT_FILE = "model-of-tom/intent.md";
// The sections an agent never writes (ruling 13). Matched by heading,
// case-insensitively, on any page. "Ideal state" and "Must not break" stay in
// the list though the area pages no longer carry them: a page that grows one
// back is refused without a deploy.
export const FORBIDDEN_SECTIONS = ["Directions", "Ideal state", "Must not break"];
export const LEARNING_OPS = ["add", "replace", "remove"];
// runClaude's --model. The Opus tier: this is judgment over Tom's words, not
// a mechanical parse. Overridable per box without a deploy.
export const LEARNING_MODEL = process.env.TTS_LEARNING_MODEL || "opus";
export const LEARNING_TIMEOUT_MS = 20 * 60 * 1000;
// A turn of Tom's is shown to the model up to this many characters.
export const LEARNING_TURN_CHARS = 4000;
// One evidence file in the prompt, from its head: the model needs the entry
// forms in front of it and nothing else.
export const LEARNING_EVIDENCE_CHARS = 6000;
// The whole learning prompt. Past it, `shown.tomTurns` is trimmed oldest
// first until it fits, and the summary records how many went. Fewer
// high-signal tokens is also a cost bound.
export const LEARNING_PROMPT_CHARS = 400_000;

// ── The gate on the night's write ────────────────────────────────────────────
// WikiTom's own checker, run in the checkout. It is deterministic and pure
// Node, so it is cheap enough to run twice a night: once before anything is
// written, to tell this job's damage from somebody else's, and once after.
export const EVIDENCE_CHECK = ["scripts/check-evidence.mjs"];
export const EVIDENCE_CHECK_TIMEOUT_MS = 60_000;
/** The row and the digest fact for a night whose write was taken back. */
export const LEARNING_CHECK_FAILED = "learning-check-failed";

/**
 * `node scripts/check-evidence.mjs` in `dir`: `{ok, output}`. NEVER THROWS —
 * a checker that cannot run at all (no such file, a syntax error in it, a
 * timeout) is a FAILED CHECK, not a crashed night, because the two records
 * are exactly what nobody can verify by eye afterwards.
 */
export function runEvidenceCheck(dir) {
  try {
    const out = execFileSync("node", EVIDENCE_CHECK, {
      cwd: dir,
      encoding: "utf8",
      timeout: EVIDENCE_CHECK_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: clip(out, 2000) };
  } catch (err) {
    return { ok: false, output: clip(`${err.stdout ?? ""}\n${err.stderr ?? err.message}`, 2000) };
  }
}

/**
 * Apply `mutate` to the checkout and KEEP IT ONLY IF THE CHECKER PASSES
 * AFTER.
 *
 * `mutate(io)` reads and writes through `io` and returns whatever the caller
 * wants back. `io.write` is THE ONLY WAY a path changes, and it reads the
 * path's bytes before it writes them — so every path the mutation touched is
 * on record before it was touched, and a failing check restores every one,
 * removing the ones that did not exist. The checkout is left byte-identical.
 *
 * A run that would fail the checker is rejected WHOLE: half a night's lines
 * on the pages with no entries behind them is the one state from which nobody
 * can tell what was learned.
 */
export function withEvidenceCheck(dir, mutate) {
  const before = new Map();
  const io = {
    read: (rel) => {
      const abs = path.join(dir, rel);
      return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    },
    exists: (rel) => fs.existsSync(path.join(dir, rel)),
    write: (rel, text) => {
      const abs = path.join(dir, rel);
      if (!before.has(rel)) before.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs) : null);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    },
  };
  const result = mutate(io);
  const check = runEvidenceCheck(dir);
  if (check.ok) return { ok: true, result, check, restored: [] };
  const restored = [];
  for (const [rel, bytes] of before) {
    const abs = path.join(dir, rel);
    if (bytes === null) fs.rmSync(abs, { force: true });
    else fs.writeFileSync(abs, bytes);
    restored.push(rel);
  }
  return { ok: false, result, check, restored: restored.sort() };
}

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
 * newest resultBlob the job recorded for it (revertLearningRecords), so a
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
// A `read:` entry may also name what it was read from, which is not a source
// tonight's input can be checked against: a snapshot table or a todo.
const READ_CITATION = /^(snapshot|todo) (\S+)$/;
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
    // The evidence array is the half of the answer the pages never show, so
    // its SHAPE is checked here rather than reported as one change's refusal:
    // an answer without it is not an answer in this schema at all.
    if (!Array.isArray(c.evidence)) {
      throw new Error(`learning change ${i} has no evidence array`);
    }
  });
  return obj.changes;
}

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
 * and is taken back through it (revertLearningRecords), so a revert can no
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

// ── The reviewed guard ───────────────────────────────────────────────────────
// intent.md carries `reviewed:` in its frontmatter, and so does every area
// page. WHEN HE HAS REVIEWED A FILE, ITS LINES ARE HIS THE SAME WAY
// DIRECTIONS IS: a reviewed line changes only by his correction, and a
// correction is a `said` entry dated after the review. Additions are always
// allowed — the review approved what was there, not what may come.

/**
 * Why `change` may not touch a line on a reviewed file, or null.
 * `reviewed` is the file's frontmatter date ("" when unset); `entryDates` are
 * the dates on the target line's evidence entry.
 */
export function reviewedRefusal(change, reviewed, entryDates) {
  if (!isIsoDay(reviewed)) return null; // never reviewed: the ordinary rules
  if ((change.op ?? "add") === "add") return null; // a new line is not an edit of a reviewed one
  const dates = (entryDates ?? []).filter(isIsoDay);
  const newest = dates.length === 0 ? null : dates.slice().sort().at(-1);
  if (newest !== null && newest > reviewed) return null; // the line already moved on since the review
  const correction = (change.evidence ?? []).some(
    (e) => e?.form === "said" && isIsoDay(e?.date) && e.date > reviewed,
  );
  if (correction) return null; // his own correction, after the review
  return `"${clip(oneLine(change.replaces), 60)}" is a line Tom reviewed on ${reviewed}; only his correction changes it`;
}

/** The dates on the evidence entry for `line` under `section`, for the guard
 * above. An empty list when the file has no such entry. */
function entryDatesFor(evidenceText, section, line) {
  const wanted = oneLine(String(line ?? "")).replace(/^[-*]\s+/, "");
  const name = String(section ?? "").trim().toLowerCase();
  for (const e of parseEvidenceEntries(evidenceText ?? "")) {
    if (String(e.heading ?? "").trim().toLowerCase() !== name) continue;
    if (oneLine(e.line) !== wanted) continue;
    return e.fields.map((f) => f.date);
  }
  return [];
}

/**
 * The change's excerpt: the field when the model wrote one, else the longest
 * of its `said` texts. THE SAID ENTRY IS THE EXCERPT — the same six words of
 * his either way — so a model that gave the entry and not the field has
 * still anchored the line, and the job fills the field rather than refusing.
 */
export function changeExcerpt(c) {
  const given = typeof c?.excerpt === "string" ? c.excerpt.trim() : "";
  if (given !== "") return oneLine(given);
  const saids = (c?.evidence ?? []).filter((e) => e?.form === "said" && typeof e.text === "string");
  if (saids.length === 0) return "";
  return oneLine(saids.reduce((a, b) => (oneLine(b.text).length > oneLine(a.text).length ? b : a)).text);
}

// A line the pages may not carry: a citation, a date, or Tom quoted. His
// words live in the evidence record and nowhere else.
const LINE_CITATION = /\((?:session|ruling|thread)\s/;
const LINE_DATE = /\b20\d{2}-\d{2}-\d{2}\b/;
const LINE_QUOTE = /["“]([^"”]+)["”]/;
const TRAILING_PARENTHETICAL = /\(([^()]*)\)\s*\.?$/;

/**
 * Why one proposed change may not land, or null when it may. The checks are
 * the two-record rules, in the order a reader of the refusal wants them:
 * where it goes, what the line is, what the evidence is, and only then what
 * the section it names allows. `evidence` is learningEvidence(input), or
 * null (the pure tests). `signals` is tonight's ground signal list.
 */
function learningRefusal(c, texts, evidencePages, evidence, signals = []) {
  // 1–3: where the two records are.
  if (typeof c.file !== "string" || !isLearningFile(c.file)) {
    return `${String(c.file)} is not a page the learning step writes`;
  }
  if (!texts.has(c.file)) return `${c.file} is not in the checkout`;
  const ePath = evidencePath(c.file);
  if (!evidencePages.has(ePath)) return `no evidence file ${ePath}`;
  // 4: the section.
  if (typeof c.section !== "string" || c.section.trim() === "") return "no section named";
  if (isForbiddenSection(c.section)) {
    return `"${c.section.trim()}" is Tom's section; an agent never writes it`;
  }
  const section = c.section.trim();
  // 5–6: the operation.
  const op = c.op;
  if (!LEARNING_OPS.includes(op)) return "op must be add, replace or remove";
  if (op === "remove" && !(c.file === GROUND_FILE && section.toLowerCase() === "does not know")) {
    return 'remove is allowed only on model-of-tom/ground.md under "Does not know"';
  }
  // 7–11: the line the page carries.
  if (op !== "remove") {
    if (typeof c.line !== "string" || c.line.trim() === "" || /[\r\n]/.test(c.line)) {
      return "the line must be one non-empty line";
    }
    if (LINE_CITATION.test(c.line)) return "the line carries a citation; the pages hold no source";
    if (LINE_DATE.test(c.line)) return "the line carries a date; the pages hold no date";
    const quoted = LINE_QUOTE.exec(c.line);
    if (quoted !== null && wordCount(quoted[1]) >= 4) {
      return "the line quotes Tom; his words live in the evidence record";
    }
    const tail = TRAILING_PARENTHETICAL.exec(c.line.trim());
    const marked = tail !== null && tail[1].trim() === "inferred";
    if (c.inferred === true && !marked) return 'an inferred line ends with "(inferred)"';
    if (c.inferred !== true && marked) return 'only an inferred line ends with "(inferred)"';
  }
  // 12–16: the evidence entries.
  const entries = Array.isArray(c.evidence) ? c.evidence : [];
  if (entries.length === 0 || !entries.every((e) => e !== null && typeof e === "object" && !Array.isArray(e))) {
    return "no evidence";
  }
  for (const e of entries) {
    if (!EVIDENCE_FORMS.includes(e.form)) {
      return `evidence form "${String(e.form)}" is not said, paraphrase, read or rests on`;
    }
    const source = String(e.source ?? "").trim();
    const citable = CITATION.test(source);
    if (!citable && !(e.form === "read" && READ_CITATION.test(source))) {
      return `evidence "${source}" is not a citation: session <id>, ruling <id> or thread <ts>`;
    }
    if (citable && evidence !== null && !evidence.sources.has(source)) {
      return `evidence "${source}" names nothing in tonight's input`;
    }
    if (!isIsoDay(e.date)) return `the evidence date ${String(e.date)} is not a day`;
    if (evidence !== null && (e.date < evidence.sinceDay || e.date > evidence.untilDay)) {
      return `the evidence date ${e.date} is outside tonight's window (${evidence.sinceDay} to ${evidence.untilDay})`;
    }
    if (typeof e.text !== "string" || e.text.trim() === "") {
      return `an evidence entry of form "${e.form}" has no text`;
    }
  }
  // 17: the mark and the forms agree. An inferred line rests on inference
  // only; a line that is not marked rests on nothing.
  const rests = entries.filter((e) => e.form === "rests on");
  if (c.inferred === true && rests.length !== entries.length) {
    return 'an inferred line\'s evidence is "rests on" only';
  }
  if (c.inferred !== true && rests.length > 0) {
    return 'a "rests on" entry on a line that is not marked (inferred)';
  }
  // 18 (R3): the record alone does not learn about Tom.
  if (entries.every((e) => e.form === "read")) {
    return "a change to a model-of-tom page needs said:, paraphrase: or rests on:; read: alone is the record describing itself";
  }
  // 19 (R2): a said: is his words, from the source named on that entry.
  const saids = entries.filter((e) => e.form === "said");
  if (evidence !== null) {
    for (const e of saids) {
      const texts_ = evidence.sources.get(String(e.source).trim())?.texts ?? [];
      const wanted = oneLine(e.text);
      if (wordCount(e.text) < EXCERPT_MIN_WORDS || !texts_.some((t) => oneLine(t).includes(wanted))) {
        return `said: "${clip(oneLine(e.text), 60)}" is not in ${String(e.source).trim()} verbatim`;
      }
    }
  }
  // 20 (R1): the anchor. Every change quotes EXCERPT_MIN_WORDS of his own
  // words from a source it cites. When it has a said: entry, that entry IS
  // the excerpt — the job fills the field from the longest one when the model
  // left it out; when it has none, the excerpt is a separate quote and the
  // same test applies.
  const excerpt = changeExcerpt(c);
  if (wordCount(excerpt) < EXCERPT_MIN_WORDS) {
    return `no excerpt of ${EXCERPT_MIN_WORDS} or more of Tom's words from tonight's input`;
  }
  if (saids.length > 0) {
    if (!saids.some((e) => oneLine(e.text) === oneLine(excerpt))) {
      return "the excerpt is not one of the change's said: entries";
    }
  } else if (evidence !== null) {
    const wanted = oneLine(excerpt);
    const cites = entries.flatMap((e) => evidence.sources.get(String(e.source).trim())?.texts ?? []);
    if (!cites.some((t) => oneLine(t).includes(wanted))) {
      return "the excerpt is not in the cited input verbatim";
    }
  }
  // 21a: the ground guards.
  if (c.file === GROUND_FILE) {
    const signal = signals.find((s) => s.id === c.signal);
    if (typeof c.signal !== "string" || c.signal.trim() === "") {
      return "a change to ground.md names no signal";
    }
    if (signal === undefined) return `signal ${c.signal} is not in tonight's ground signals`;
    if (!groundSectionFollows(signal.kind, section, op)) {
      return `"${section}" does not follow from a ${signal.kind} signal`;
    }
    if (op !== "remove" && isGroundConfirmedSection(section)) {
      if (saids.length === 0 || c.inferred === true) {
        return `a line under "${section}" carries a said: entry; his fluent use of a term is not confirmation`;
      }
    }
    // The line traces to the sentence the CODE detected, not to a different
    // sentence in the same turn.
    if (saids.length > 0) {
      const quote = oneLine(signal.quote);
      if (!saids.some((e) => quote.includes(oneLine(e.text)))) {
        return "the said: entry does not contain the signal's sentence";
      }
    }
  } else if (c.signal !== undefined && c.signal !== null) {
    return "only a change to ground.md names a signal";
  }
  // 21b: the intent guards. A statement of what he wants is his; an inferred
  // want is allowed only where the existing inferred lines live.
  if (c.file === INTENT_FILE) {
    if (c.inferred === true && section.toLowerCase() !== "what to push toward") {
      return 'an inferred line on intent.md belongs under "What to push toward"';
    }
    if (op === "add" && c.inferred !== true && saids.length === 0) {
      return "a line on intent.md carries a said: entry";
    }
  }
  // 21c: the reviewed guard, on intent.md and on every area page.
  if (op !== "add") {
    const reviewed = parseFrontmatter(texts.get(c.file)).fields.reviewed ?? "";
    const why = reviewedRefusal(
      c,
      reviewed,
      entryDatesFor(evidencePages.get(ePath), section, c.replaces),
    );
    if (why !== null) return why;
  }
  // 22: what a replacement replaces.
  if (op === "add") {
    if (c.replaces !== null && c.replaces !== undefined) {
      return "an add replaces nothing; `replaces` is null";
    }
  } else {
    if (typeof c.replaces !== "string" || c.replaces.trim() === "") {
      return "replaces must be one existing bullet, or null";
    }
    if (op === "replace" && oneLine(c.replaces) === oneLine(renderSynthesisLine(c))) {
      return "the replacement is the line it replaces";
    }
  }
  return null;
}

/**
 * A term he confirms is usually already named under "Does not know", so the
 * two changes travel together: a `remove` there is refused unless the SAME
 * answer holds an applied `add` or `replace` under "Knows" or "Follows,
 * without the details" naming the same signal. Where the old line covers more
 * than the confirmed term, the model narrows it with `replace` instead, which
 * needs no partner.
 */
export function groundRemovalGuard(change, applied) {
  const partnered = applied.some(
    (a) =>
      a.file === GROUND_FILE &&
      a.signal === change.signal &&
      a.kind !== "remove" &&
      isGroundConfirmedSection(a.section),
  );
  return partnered
    ? null
    : 'a removal from "Does not know" needs the same night\'s line under "Knows" or "Follows, without the details" on the same signal';
}

/**
 * Apply proposed changes to BOTH RECORDS, pure. `pages` is a Map of the
 * synthesis file → text and `evidencePages` a Map of the evidence file →
 * text; both come back changed, and NEITHER IS WRITTEN WITHOUT THE OTHER —
 * every line that lands does so through learning-records.mjs's applyRecords,
 * which writes the bullet and its entry in one call or refuses both.
 *
 * `evidence` is what tonight's input can evidence (learningEvidence) — null
 * skips the checks against it. `signals` is tonight's deterministic ground
 * signal list (learning-ground.mjs); a change to ground.md names one of them
 * or it is refused. Every page that took a change gets `updated: day`.
 */
export function applyLearningChanges(
  pages,
  changes,
  { day, evidence = null, evidencePages = null, signals = [] } = {},
) {
  const texts = new Map(pages);
  // A caller with no evidence files (the pure tests of the synthesis half)
  // gets an empty one per page, so the refusal for a missing file is the
  // caller's choice rather than a crash.
  const eTexts = new Map(
    evidencePages ?? [...pages.keys()].map((f) => [evidencePath(f), "# Evidence\n"]),
  );
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
    const why = learningRefusal(c, texts, eTexts, evidence, signals);
    if (why !== null) {
      refuse(c, why);
      continue;
    }
    const section = c.section.trim();
    const ePath = evidencePath(c.file);
    const excerpt = changeExcerpt(c);
    const out = applyRecords(texts.get(c.file), eTexts.get(ePath), c, {
      locate: locateSection,
    });
    if (!out.ok) {
      refuse(c, out.reason);
      continue;
    }
    // The removal's partner: a term leaves "Does not know" only beside the
    // same night's line that says where it went.
    if (c.op === "remove") {
      const guard = groundRemovalGuard(c, applied);
      if (guard !== null) {
        refuse(c, guard);
        continue;
      }
    }
    texts.set(c.file, out.pageText);
    eTexts.set(ePath, out.evidenceText);
    applied.push({
      id: learningChangeId(c.file, section, out.line === "" ? out.before : out.line),
      file: c.file,
      section,
      kind: c.op,
      signal: c.signal ?? null,
      before: out.before,
      after: out.line,
      beforeEntry: out.beforeEntry,
      afterEntry: out.entry,
      inferred: c.inferred === true,
      // The digest's parenthetical: form and source, not a bare citation, so
      // "(said: session 47f04bc9)" says what kind of evidence it is.
      evidence: c.evidence.map((e) => `${e.form}: ${String(e.source).trim()}`).join("; "),
      sources: [...new Set(c.evidence.map((e) => String(e.source).trim()))],
      excerpt,
    });
  }
  for (const file of new Set(applied.map((a) => a.file))) {
    texts.set(file, bumpUpdated(texts.get(file), day));
  }
  // The bodies each change was validated against, and the bodies it left.
  for (const a of applied) {
    const ePath = evidencePath(a.file);
    a.baseBlob = pageBodyBlob(pages.get(a.file));
    a.resultBlob = pageBodyBlob(texts.get(a.file));
    a.evidenceBaseBlob = pageBodyBlob(evidencePages?.get(ePath) ?? "");
    a.evidenceResultBlob = pageBodyBlob(eTexts.get(ePath) ?? "");
  }
  return { pages: texts, evidencePages: eTexts, applied, refused };
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

/** The same, for the evidence half: keyed by the SYNTHESIS file, so one
 * lookup serves both bodies of a revert. */
export function expectedEvidenceBlobs(rows) {
  const out = new Map();
  for (const r of [...(rows ?? [])].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))) {
    if (typeof r?.file === "string" && typeof r.evidenceResultBlob === "string" && !out.has(r.file)) {
      out.set(r.file, r.evidenceResultBlob);
    }
  }
  return out;
}

/**
 * The inverse of one recorded change against BOTH RECORDS' current text: an
 * addition's line and its entry are removed, a replacement's line and entry
 * become what they replaced.
 *
 * ONLY WITHIN THE CHANGE'S OWN SECTION (locateSection): the line is looked
 * for where the change put it and nowhere else, so a copy Tom pasted into
 * Must not break or Directions — or anywhere — is never the one taken back.
 * AND ONLY WHEN IT IS THERE ONCE: two copies in the section — Tom's, pasted
 * above the job's — cannot be told apart by their text, so neither goes and
 * the reason says so (an objection reverts the learned change, never his).
 * AND ONLY ON RECORDS AS THE JOB LEFT THEM: `expectedBlob` and
 * `expectedEvidenceBlob`, when given, are the body blobs the job last
 * recorded (expectedBodyBlobs, expectedEvidenceBlobs), and a body that no
 * longer hashes to its own has been edited since — the revert is refused with
 * both hashes rather than applied to text the job never read.
 *
 * The entry being gone already is NOT a failure: the page is what a prompt
 * loads, the checker passes either way, and refusing there would strand Tom's
 * objection. The row records `evidenceMissing` instead.
 */
export function revertLearningRecords(
  pageText,
  evidenceText,
  change,
  { expectedBlob = null, expectedEvidenceBlob = null } = {},
) {
  const baseBlob = pageBodyBlob(pageText);
  if (expectedBlob !== null && expectedBlob !== baseBlob) {
    return {
      ok: false,
      reason: `${change.file} has changed since the job last wrote it (body blob ${expectedBlob.slice(0, 12)}, now ${baseBlob.slice(0, 12)}); nothing was taken back`,
    };
  }
  const evidenceBaseBlob = pageBodyBlob(evidenceText ?? "");
  if (expectedEvidenceBlob !== null && expectedEvidenceBlob !== evidenceBaseBlob) {
    const ePath = evidencePath(change.file);
    return {
      ok: false,
      reason: `${ePath} has changed since the job last wrote it (body blob ${expectedEvidenceBlob.slice(0, 12)}, now ${evidenceBaseBlob.slice(0, 12)}); nothing was taken back`,
    };
  }
  const out = revertRecords(pageText, evidenceText ?? "", change, { locate: locateSection });
  if (!out.ok) return out;
  return {
    ok: true,
    pageText: out.pageText,
    evidenceText: out.evidenceText,
    evidenceMissing: out.evidenceMissing,
    baseBlob,
    resultBlob: pageBodyBlob(out.pageText),
    evidenceBaseBlob,
    evidenceResultBlob: pageBodyBlob(out.evidenceText),
  };
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

/** The evidence file of each page the step writes, as a Map of
 * checkout-relative path → text. A page whose evidence file is missing is
 * refused by learningRefusal, not created here: the pair is the record, and
 * a file nobody wrote is a fact about the checkout. */
export function readEvidencePages(dir, pages) {
  const out = new Map();
  for (const file of pages.keys()) {
    const rel = evidencePath(file);
    if (rel === null) continue;
    const abs = path.join(dir, rel);
    if (fs.existsSync(abs)) out.set(rel, fs.readFileSync(abs, "utf8"));
  }
  return out;
}

/** The one prompt. The pages' own rules (writing.md) travel with the pages;
 * what is here is the contract of the answer and what the job refuses. */
export function learningPrompt(input, pages, evidencePages, signals, day) {
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
  // The evidence files are shown for their FORMS and for what is already on
  // record, clipped from the head: the model needs the entry shapes in front
  // of it and the entries it must not duplicate, and nothing else.
  const evidenceText = [...(evidencePages ?? new Map())]
    .map(([file, text]) => `=== ${file} ===\n${clip(text, LEARNING_EVIDENCE_CHARS)}`)
    .join("\n\n");
  const build = (turns) =>
    [
      "You maintain the model-of-tom pages of WikiTom: the files every agent prompt about Tom begins with. Tonight's input is what Tom did since the last learning run — the turns he typed in sessions (each with the agent's text just before and just after it, which is context for reading his words and never a source of a line), his threaded Slack replies, and his rulings. Propose the changes those inputs justify to the pages below, and nothing else.",
      "",
      "TWO RECORDS",
      "- Every change writes two things: the SYNTHESIS LINE that goes on the page, and the EVIDENCE ENTRY that goes under the same heading of model-of-tom/evidence/<the same path>. Neither exists without the other.",
      "- The synthesis line is plain present tense for the agent that loads the page: one idea, no quotation, no date, no session id, no ruling id, no thread timestamp, no parenthetical citation of any kind. A line that quotes Tom or names a source is refused.",
      '- A line the input does not state, which you reached by inference, ends with the exact words " (inferred)" and sets "inferred": true. An inferred line\'s evidence is "rests on" entries only. A line that is not inferred carries no "rests on" entry.',
      "- The evidence entry is where his words live. Each entry has a form, a date, a source and a text:",
      "    said       his words, verbatim, from a session turn, a Slack reply or a ruling",
      "    paraphrase his statement from a source, in your words, when it is his and not verbatim",
      "    read       a fact read from the record, a mirror or a document",
      "    rests on   an inference and the basis it rests on",
      '- Give the entry that is true. Never write "said" for words you have shortened, tidied, corrected or joined: if it is not character-for-character in the input, it is "paraphrase".',
      `- Every change carries "excerpt": ${EXCERPT_MIN_WORDS} or more of Tom's own words, verbatim, from a source the change cites. When the change has a "said" entry the excerpt is that entry's text; when it has none, quote the words the change rests on. A change that cannot quote six of his words rests on nothing and is refused.`,
      '- "read" never stands alone on these pages: a change with only "read" entries is the record describing itself, not something learned about Tom.',
      "",
      "RULES",
      '- A change is one line for one section of one page. "op" is "add" (a new line; "replaces": null), "replace" ("replaces" is one existing bullet of that section, verbatim — the new line supersedes it, because the pages describe what is, never what was), or "remove" (only on model-of-tom/ground.md under "Does not know", and only when the same night adds the same term to "Knows" or "Follows, without the details").',
      '- Only these pages: model-of-tom/writing.md, model-of-tom/priorities.md, model-of-tom/ground.md, model-of-tom/intent.md, model-of-tom/areas/<area>.md. Only a section that exists on the page, named by its heading. Never "Directions", never "Ideal state", never "Must not break" — those are Tom\'s own, and a change naming them is refused. Never the spec, never agent-rules.md, never schedule.md.',
      '- model-of-tom/ground.md: what he knows and does not know. A change there names a "signal" from the GROUND SIGNALS list below and proposes exactly what that signal supports — a term he asked about goes under "Does not know" or narrows a line already there; a term he confirmed he knows, in his own words, goes under "Knows" or "Follows, without the details". His fluent use of a term is not confirmation, an agent\'s explanation of a term is not confirmation, and no line under "Knows" or "Follows, without the details" may rest on inference: each carries a "said" entry or it is refused.',
      '- model-of-tom/intent.md: what he wants to be true. A statement of his about what he wants goes in the section it belongs to with a "said" entry. Never the Directions section. A line whose evidence predates the file\'s "reviewed" date is his and changes only by his correction: propose a replacement for one only when tonight\'s input holds him correcting it.',
      '- Write to writing.md\'s own rules: present tense, one idea per line, imperative or second person, never "Tom wants" or "agents should", the mechanism plainly, no analogy, no evaluative word, one fixed term per concept, his words and the code\'s words only.',
      "- Nothing from the agent's words alone; nothing already on a page; nothing that restates a line; nothing the evidence file already carries an entry for. An empty list is the right answer on a night whose input changes nothing about the model of Tom, and that is most nights.",
      "",
      "Answer with ONE JSON object and nothing else, no code fence:",
      '{"changes":[{"file":"model-of-tom/areas/climbing.md","section":"Current state","op":"add","line":"...","replaces":null,"inferred":false,"signal":null,"evidence":[{"form":"said","date":"YYYY-MM-DD","source":"session <session>","text":"<his words, verbatim>"}],"excerpt":"<six or more of his words, verbatim>"}]}',
      "",
      // The rarely-changing text first — the pages and the evidence files
      // barely move night to night, so the prompt cache holds across runs
      // only while they sit ABOVE tonight's input, which changes every run.
      "PAGES",
      pageText,
      "",
      "EVIDENCE FILES (the entries already on record; never propose a duplicate)",
      evidenceText,
      "",
      "INPUT",
      JSON.stringify({ ...shown, tomTurns: turns }, null, 1),
      "",
      "GROUND SIGNALS",
      JSON.stringify(signals ?? [], null, 1),
      "",
      `Tonight is ${day} (UTC).`,
    ].join("\n");
  // Fewer high-signal tokens is also a cost bound: past LEARNING_PROMPT_CHARS
  // the OLDEST turns go first, and the summary says how many.
  let turns = shown.tomTurns;
  let prompt = build(turns);
  while (prompt.length > LEARNING_PROMPT_CHARS && turns.length > 0) {
    turns = turns.slice(1);
    prompt = build(turns);
  }
  return { prompt, turnsDropped: shown.tomTurns.length - turns.length };
}

/**
 * Tom's objections, applied before tonight's learning. Each unconsumed
 * "learning-objection" row names a change (by id or by the line's text); the
 * inverse is applied to the page's current text and one row records it
 * either way. Every objection is consumed here once, so a night that could
 * not revert says so once and the digest shows it once.
 */
async function learningObjections(run, input, fetchConvex) {
  const consumed = [];
  // An objection may name a REPOSITORY-RULE PROPOSAL instead of a learned
  // line: the digest prints both with an id of the same shape, and Tom
  // replies on either the same way. A proposal has no page to take a line
  // off — it was never written to one — so it is dropped at its row, and the
  // next night's repo-learning step writes `dropped:` on its evidence entry.
  const objections = [];
  const proposals = new Map(
    (input.repoProposals ?? [])
      .filter((p) => typeof p?.id === "string" && p.status === "open")
      .map((p) => [p.id, p]),
  );
  const droppedProposals = [];
  for (const objection of input.objections ?? []) {
    const named = namedChange(
      [objection.id, ...changeIdTokens(String(objection.text ?? ""))],
      [...proposals.values()],
    );
    if (named === null) {
      objections.push(objection);
      continue;
    }
    droppedProposals.push({ objection, proposal: named });
    consumed.push(objection.eventId);
  }
  for (const { objection, proposal } of droppedProposals) {
    try {
      await fetchConvex(run.env, "/tts/repo-proposal-dropped", {
        id: proposal.id,
        reply: clip(objection.text, 200),
      });
    } catch (err) {
      console.error(`[nightly] learning: could not drop proposal ${proposal.id}: ${err.message}`);
    }
  }
  // Both halves of every revert are written through `io`, so a checker that
  // fails after them restores every byte (withEvidenceCheck).
  const gate = withEvidenceCheck(run.dir, (io) => {
    const outcome = { reverted: 0, failed: 0 };
    const rows = [];
    const revertedRows = [];
    // The body blob the job last left each record with; a revert this run
    // makes moves it on, so the next objection to the same page checks
    // against the records as this run left them.
    const expected = expectedBodyBlobs(input.changes);
    const expectedEvidence = expectedEvidenceBlobs(input.changes);
    for (const objection of objections) {
      const change = matchObjection(objection, input.changes ?? []);
      const note = { objectionId: objection.eventId, objection: clip(objection.text, 400) };
      if (change === null) {
        rows.push({
          kind: "learning-revert-failed",
          data: { ...note, id: objection.id, reason: "no learning change matches the objection" },
        });
        outcome.failed += 1;
      } else {
        const ePath = typeof change.file === "string" ? evidencePath(change.file) : null;
        const result =
          typeof change.file === "string" && isLearningFile(change.file) && io.exists(change.file)
            ? revertLearningRecords(io.read(change.file), io.read(ePath) ?? "", change, {
                expectedBlob: expected.get(change.file) ?? null,
                expectedEvidenceBlob: expectedEvidence.get(change.file) ?? null,
              })
            : { ok: false, reason: `${change.file} is not a page in the checkout` };
        const named = { id: change.id, file: change.file, section: change.section ?? null };
        if (result.ok) {
          io.write(change.file, bumpUpdated(result.pageText, run.day));
          if (ePath !== null) io.write(ePath, result.evidenceText);
          expected.set(change.file, result.resultBlob);
          expectedEvidence.set(change.file, result.evidenceResultBlob);
          const row = {
            kind: "learning-reverted",
            data: {
              ...note,
              ...named,
              before: change.after,
              after: change.before,
              baseBlob: result.baseBlob,
              resultBlob: result.resultBlob,
              evidenceBaseBlob: result.evidenceBaseBlob,
              evidenceResultBlob: result.evidenceResultBlob,
              evidenceMissing: result.evidenceMissing === true,
            },
          };
          rows.push(row);
          revertedRows.push(row);
          outcome.reverted += 1;
        } else {
          rows.push({
            kind: "learning-revert-failed",
            data: { ...note, ...named, reason: result.reason },
          });
          outcome.failed += 1;
        }
      }
      consumed.push(objection.eventId);
    }
    return { outcome, rows, revertedRows };
  });
  const { outcome, rows, revertedRows } = gate.result;
  // A revert that the checker refused is taken back whole and reported as a
  // failed revert: the objection is still consumed (it was acted on), and the
  // digest says the records were left as they were.
  if (!gate.ok) {
    run.learningRows.push({
      kind: LEARNING_CHECK_FAILED,
      data: {
        baseline: false,
        stage: "reverts",
        changes: outcome.reverted,
        output: clip(gate.check.output, 500),
      },
    });
    if (consumed.length > 0) {
      await fetchConvex(run.env, "/tts/learning-objections-consumed", { ids: consumed });
    }
    return { reverted: 0, failed: outcome.reverted + outcome.failed, proposalsDropped: droppedProposals.length, checkFailed: true };
  }
  for (const row of rows) run.learningRows.push(row);
  if (consumed.length > 0) {
    await fetchConvex(run.env, "/tts/learning-objections-consumed", { ids: consumed });
  }
  if (outcome.reverted > 0) {
    const message = `learning: ${run.day} — ${outcome.reverted} line${outcome.reverted === 1 ? "" : "s"} reverted on Tom's objection`;
    for (const row of revertedRows) row.commitMessage = message;
    run.commits.push({ paths: [MODEL_OF_TOM_DIR], message });
  }
  return { ...outcome, proposalsDropped: droppedProposals.length, checkFailed: false };
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
    removed: 0,
    inferred: 0,
    refused: [],
    groundSignals: 0,
    groundSignalsDropped: 0,
    turnsDropped: 0,
    checkFailed: false,
    checkOutput: null,
  };
  // THE BASELINE. A run that cannot tell its own damage from somebody else's
  // writes nothing: the checkout was already failing before this job touched
  // it, so no change lands and no revert is applied, and the digest says so.
  const baseline = runEvidenceCheck(run.dir);
  if (!baseline.ok) {
    summary.checkFailed = true;
    summary.checkOutput = clip(baseline.output, 500);
    run.learningRows.push({
      kind: LEARNING_CHECK_FAILED,
      data: { baseline: true, output: summary.checkOutput },
    });
    await fetchConvex(run.env, "/tts/event", { kind: "learning-run", data: summary });
    console.log(
      "[nightly] learning: model-of-tom/evidence was already failing its check before tonight's run — nothing was written",
    );
    return summary;
  }

  const objections = await learningObjections(run, input, fetchConvex);
  summary.reverted = objections.reverted;
  summary.revertFailed = objections.failed;
  if (objections.checkFailed) summary.checkFailed = true;

  if (summary.tomTurns + summary.slackReplies + summary.rulings > 0) {
    const pages = readLearningPages(run.dir);
    if (pages.size === 0) throw new Error(`no model-of-tom pages under ${run.dir}`);
    const evidencePages = readEvidencePages(run.dir, pages);
    const ground = groundSignals(input, {
      max: GROUND_SIGNALS_MAX,
      cite: (t) => `session ${sessionCitation(t)}`,
      day: (at) => utcDay(at),
    });
    summary.groundSignals = ground.signals.length;
    summary.groundSignalsDropped = ground.dropped;
    summary.model = LEARNING_MODEL;
    const { prompt, turnsDropped } = learningPrompt(input, pages, evidencePages, ground.signals, run.day);
    summary.turnsDropped = turnsDropped;
    const answer = askModel(prompt, {
      cwd: run.dir,
      model: LEARNING_MODEL,
      timeoutMs: LEARNING_TIMEOUT_MS,
      maxTurns: 4,
      registration: {
        origin: "cron:nightly",
        kind: "job",
        layersKnown: false,
        layersGiven: [],
        layersDenied: [],
      },
    });
    const result = applyLearningChanges(pages, parseLearningAnswer(answer), {
      day: run.day,
      evidence: learningEvidence(input),
      evidencePages,
      signals: ground.signals,
    });
    summary.refused = result.refused.map((r) => ({ ...r, line: clip(r.line, 200) }));
    const gate = withEvidenceCheck(run.dir, (io) => {
      for (const [file, text] of result.pages) {
        if (text !== pages.get(file)) io.write(file, text);
      }
      for (const [file, text] of result.evidencePages) {
        if (text !== evidencePages.get(file)) io.write(file, text);
      }
      return null;
    });
    if (!gate.ok) {
      // Rejected WHOLE. The applied rows describe writes that no longer
      // exist, so they are NOT posted; one row says the night wrote nothing.
      summary.checkFailed = true;
      summary.checkOutput = clip(gate.check.output, 500);
      run.learningRows.push({
        kind: LEARNING_CHECK_FAILED,
        data: {
          baseline: false,
          stage: "changes",
          changes: result.applied.length,
          output: summary.checkOutput,
        },
      });
      console.error(
        `[nightly] learning: the evidence check failed after ${result.applied.length} change(s) — every one was taken back`,
      );
    } else {
      summary.changes = result.applied.length;
      summary.removed = result.applied.filter((a) => a.kind === "remove").length;
      summary.inferred = result.applied.filter((a) => a.inferred === true).length;
      const message = `learning: ${run.day} — ${result.applied.length} line${result.applied.length === 1 ? "" : "s"} from Tom's turns, replies and rulings`;
      for (const a of result.applied) {
        run.learningRows.push({ kind: "learning-change", data: a, commitMessage: message });
      }
      if (result.applied.length > 0) run.commits.push({ paths: [MODEL_OF_TOM_DIR], message });
    }
  }
  await fetchConvex(run.env, "/tts/event", { kind: "learning-run", data: summary });
  console.log(
    `[nightly] learning: ${summary.tomTurns} turns of Tom's in ${summary.sessions} sessions, ${summary.slackReplies} Slack replies, ${summary.rulings} rulings, ${summary.groundSignals} ground signal(s) — ${summary.changes} change(s), ${summary.refused.length} refused, ${summary.reverted} reverted, ${summary.revertFailed} revert(s) failed`,
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
        // The key travels with the row: a repo proposal is looked up later by
        // by_kind_key (internalApplyRepoProposal / internalDropRepoProposal),
        // and a row posted without one can never be applied or dropped by id.
        ...(row.key === undefined ? {} : { key: row.key }),
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

// ── 3. runs ──────────────────────────────────────────────────────────────────
export async function runsStep(run, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const checkpoint = latestRunManifestCursor(run.dir);
  let cursor = null;
  let manifested = 0;
  let received = 0;
  do {
    const params = new URLSearchParams({ since: String(checkpoint.at) });
    if (checkpoint.runId !== undefined && checkpoint.fileVersion !== undefined) {
      params.set("afterRunId", checkpoint.runId);
      params.set("afterFileVersion", checkpoint.fileVersion);
    }
    if (cursor !== null) params.set("cursor", cursor);
    const response = await fetchImpl(
      `${run.env.CONVEX_SITE_URL.replace(/\/+$/, "")}/runs/manifest?${params}`,
      { headers: { "X-Sessions-Key": run.env.SESSIONS_WORKER_KEY } },
    );
    if (!response.ok) throw new Error(`/runs/manifest -> HTTP ${response.status}`);
    const page = await response.json();
    if (
      !Array.isArray(page?.entries)
      || page.entries.length > 200
      || !page.entries.every(isRunManifestEntry)
      || !(page.nextCursor === null || typeof page.nextCursor === "string")
    ) {
      throw new Error("/runs/manifest returned an invalid page");
    }
    // main() holds the WikiTom lock around this whole step. Land each source
    // page before fetching the next so neither response rows nor dedup state
    // grow with the history being manifested.
    received += page.entries.length;
    manifested += appendRunManifest(run.dir, page.entries).length;
    cursor = page.nextCursor;
  } while (cursor !== null);

  console.log(`[nightly] runs: ${manifested} file version(s) manifested`);
  if (manifested > 0) {
    run.commits.push({
      paths: [RUNS_DIR],
      message: `runs: ${run.day} — ${manifested} file version${manifested === 1 ? "" : "s"} manifested`,
    });
  }
  return { manifested, received, since: checkpoint.at };
}

// ── 4. repo-learning ─────────────────────────────────────────────────────────
// The nightly learning step maintains what the agents know about TOM. This one
// maintains what they know about his REPOSITORIES: the nested AGENTS.md files.
// It runs after the manifest step, but still reads only the legacy transcripts
// already present in WikiTom; teaching it the object store is later work. It
// runs before push so its evidence writes ride the night's commit.
//
// IT NEVER EDITS A RULE FILE. Those live in other repositories and merge
// through their own checks, so what lands tonight is the evidence entry alone,
// under a heading that says the line is not in the repository yet, plus one
// "repo-proposal" row the digest prints with its id. A session applies the
// line later and posts back to /tts/repo-proposal-applied; the NEXT night's
// run of this step moves the entry to its live heading. Tom's reply on the
// digest line drops it instead — the entry keeps its heading and gains
// `dropped:`, which is what stops the next night proposing it again.

/**
 * The step. `deps` is for the tests: the Convex call and the model call.
 * The rows it produces go to run.learningRows, posted by recordLearningRows
 * once the push has given them a commit.
 */
export async function repoLearningStep(run, deps = {}) {
  const fetchConvex = deps.fetch ?? convexFetch;
  const askModel = deps.model ?? runClaude;
  const readRules = deps.readRules ?? readRepoRules;
  run.learningRows ??= [];
  const input = await fetchConvex(run.env, `/tts/learning-input?until=${run.now}`);
  const summary = {
    day: run.day,
    since: input.since,
    until: run.now,
    sessions: (input.repoSessions ?? []).length,
    transcriptsRead: 0,
    proposals: 0,
    dropped: 0,
    deduped: 0,
    repoFilesRead: 0,
    reconciled: 0,
    notes: [],
    model: null,
  };
  // 1. Reconcile what landed since the last run: the only writer of a live
  //    heading. Done before tonight's proposals so a line that landed is on
  //    record before a duplicate of it could be proposed again.
  const applied = (input.repoProposalsApplied ?? []).filter((r) => r.repo && r.file);
  const objected = (input.repoProposalsDropped ?? []).filter((r) => r.repo && r.file);
  const gate = withEvidenceCheck(run.dir, (io) => {
    let reconciled = 0;
    for (const row of applied) {
      const rel = repoEvidencePath(row.repo);
      if (rel === null || !io.exists(rel)) continue;
      const out = reconcileApplied(io.read(rel), {
        file: row.file,
        section: row.section ?? "",
        line: row.line,
        appliedLine: row.appliedLine ?? row.line,
      });
      if (!out.ok) continue;
      io.write(rel, out.text);
      reconciled += 1;
    }
    for (const row of objected) {
      const rel = repoEvidencePath(row.repo);
      if (rel === null || !io.exists(rel)) continue;
      const out = dropProposal(io.read(rel), {
        file: row.file,
        section: row.section ?? "",
        line: row.line,
        day: run.day,
        reply: row.reply ?? "",
      });
      if (out.ok) io.write(rel, out.text);
    }
    return reconciled;
  });
  summary.reconciled = gate.ok ? gate.result : 0;
  if (!gate.ok) {
    summary.notes.push("the reconcile of applied proposals was taken back: the evidence check failed after it");
  }

  const sessions = chooseSessions(input.repoSessions ?? []);
  if (sessions.length === 0) {
    await fetchConvex(run.env, "/tts/event", { kind: REPO_LEARNING_RUN, data: summary });
    console.log("[nightly] repo-learning: no sessions ended in a repository since the last run");
    return summary;
  }
  // 2. What the model is shown: the outcome, the transcript's repo-bearing
  //    lines, and the repository's own rule files as they stand on the box.
  const shown = [];
  const ruleFiles = [];
  const seenRepos = new Set();
  for (const s of sessions) {
    const rel = transcriptPath(run.dir, s.sdkSessionId, utcDay(s.at));
    let evidence = "";
    if (rel !== null) {
      try {
        evidence = transcriptEvidence(fs.readFileSync(path.join(run.dir, rel)));
        summary.transcriptsRead += 1;
      } catch {
        evidence = "";
      }
    }
    shown.push({
      session: sessionCitation({ sdkSessionId: s.sdkSessionId, sessionId: s.id }),
      title: s.title ?? null,
      repo: s.repo,
      outcome: s.outcome ?? null,
      outcomeSummary: s.outcomeSummary ?? null,
      endedReason: s.endedReason ?? null,
      transcript: evidence,
    });
    if (seenRepos.has(s.repo)) continue;
    seenRepos.add(s.repo);
    const rules = readRules(s.cwd ?? null);
    if (rules.missing) {
      summary.notes.push(
        `${s.repo} AGENTS.md could not be read on the box; the proposals above were checked against the evidence record only`,
      );
    }
    for (const f of rules.files) ruleFiles.push({ repo: s.repo, ...f });
  }
  summary.repoFilesRead = ruleFiles.length;

  // 3. What is already on record, so the model is not asked to invent the
  //    dedupe it would then be scored on.
  const evidenceByRepo = new Map();
  for (const repo of seenRepos) {
    const rel = repoEvidencePath(repo);
    if (rel === null) continue;
    const abs = path.join(run.dir, rel);
    evidenceByRepo.set(repo, fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "");
  }
  const onRecord = [...evidenceByRepo.values()].flatMap(evidenceLinesOf);
  const prior = priorProposalSentences(input.repoProposals ?? [], run.day);

  summary.model = LEARNING_MODEL;
  const answer = askModel(
    repoLearningPrompt(
      shown,
      ruleFiles.map((f) => `=== ${f.repo} ${f.path} ===\n${f.text}`).join("\n\n"),
      [...onRecord, ...prior].map((l) => `- ${l}`).join("\n"),
      run.day,
    ),
    {
      cwd: run.dir,
      model: LEARNING_MODEL,
      timeoutMs: LEARNING_TIMEOUT_MS,
      maxTurns: 4,
      registration: {
        origin: "cron:nightly",
        kind: "job",
        layersKnown: false,
        layersGiven: [],
        layersDenied: [],
      },
    },
  );
  const proposals = parseRepoAnswer(answer, extractJsonObject).filter(
    (p) => p !== null && typeof p === "object" && seenRepos.has(p.repo) && typeof p.file === "string",
  );
  const { kept, dropped } = dedupeProposals(proposals, {
    bullets: repoRuleBullets(ruleFiles),
    entryLines: onRecord,
    priorSentences: prior,
  });
  summary.deduped = dropped.filter((d) => d.reason.startsWith("a duplicate")).length;
  summary.dropped = dropped.length;
  if (summary.deduped > 0) {
    summary.notes.push(
      `${summary.deduped} proposal${summary.deduped === 1 ? "" : "s"} dropped as duplicates of lines already in the files`,
    );
  }

  // 4. The write: the entry, under the proposed heading, and one row each.
  const rows = [];
  const write = withEvidenceCheck(run.dir, (io) => {
    for (const p of kept) {
      const rel = repoEvidencePath(p.repo);
      if (rel === null) continue;
      const heading = proposalHeading(p.file, p.section ?? "", { proposed: true });
      const entry = renderProposalEntry(p, run.day);
      const current = io.exists(rel) ? io.read(rel) : repoEvidenceHeader(p.repo);
      io.write(rel, appendProposalEntry(current, heading, entry));
      const id = proposalId(p.repo, p.file, p.section ?? "", p.line);
      rows.push({
        kind: REPO_PROPOSAL,
        key: id,
        data: {
          id,
          repo: p.repo,
          file: p.file,
          section: p.section ?? "",
          line: oneLine(p.line),
          read: oneLine(p.read),
          sources: (p.sources ?? []).map((s) => String(s)),
          evidence: `read: session ${String((p.sources ?? [])[0] ?? "unknown")}`,
          evidenceHeading: heading,
          status: "open",
          commit: null,
        },
      });
    }
    return null;
  });
  if (!write.ok) {
    summary.notes.push(
      `${kept.length} proposal${kept.length === 1 ? "" : "s"} were taken back: the evidence check failed after them`,
    );
    await fetchConvex(run.env, "/tts/event", { kind: REPO_LEARNING_RUN, data: summary });
    console.error("[nightly] repo-learning: the evidence check failed after the write — every proposal was taken back");
    return summary;
  }
  summary.proposals = rows.length;
  if (rows.length > 0) {
    const message = `repo rules: ${run.day} — ${rows.length} proposal${rows.length === 1 ? "" : "s"} from the night's sessions`;
    for (const row of rows) run.learningRows.push({ ...row, commitMessage: message });
    run.commits.push({ paths: [MODEL_OF_TOM_DIR], message });
  } else if (summary.reconciled > 0) {
    run.commits.push({
      paths: [MODEL_OF_TOM_DIR],
      message: `repo rules: ${run.day} — ${summary.reconciled} proposal${summary.reconciled === 1 ? "" : "s"} applied in their repositories`,
    });
  }
  await fetchConvex(run.env, "/tts/event", { kind: REPO_LEARNING_RUN, data: summary });
  console.log(
    `[nightly] repo-learning: ${sessions.length} session(s), ${summary.transcriptsRead} transcript(s) — ${summary.proposals} proposal(s), ${summary.dropped} dropped, ${summary.reconciled} reconciled`,
  );
  return summary;
}

/** The head of a repository's evidence file, written once when the first
 * proposal for that repository lands. It says why the checker does not mirror
 * it, which is the question a reader of the file asks first. */
export function repoEvidenceHeader(repo) {
  return [
    `Evidence for the synthesis rule files of the ${repo} repository.`,
    "Their synthesis lines live in that repository, not here, so the evidence checker validates entry form without mirroring them.",
    "",
  ].join("\n");
}

// ── 5. the push ──────────────────────────────────────────────────────────────
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
  addPaths(dir, [SNAPSHOT_DIR, SESSIONS_DIR, RUNS_DIR, MODEL_OF_TOM_DIR]);
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

// ── 6. the post ──────────────────────────────────────────────────────────────
// Under the lock like the five steps before it, the shared prelude assembler
// reads local HEAD from its immutable git object. Local HEAD is posted whether or
// not the push went through — the design says every prompt names the
// commit it began with — and `pushed` says which, so the store and the
// digest can say "not yet pushed" rather than pass a local commit off as
// one on GitHub. Convex refuses a post older than the one it holds, so a
// rerun of an old checkout cannot roll the prelude back (ttsSkills.ts).
//
// THE STEP HAS TWO HALVES AND THEY FAIL SEPARATELY.
//
//   1. the base — the model-of-tom files and POST /tts/model-of-tom, below.
//   2. the skills — the box's three skill directories written from the same
//      HEAD, then the catalog to POST /tts/skills (skillsHalf).
//
// In that order, under the one lock this step already holds, off the one HEAD
// the rebase guard below cleared. Two doors and not one widened door, because a
// night whose skills publication or skills post fails must still have delivered
// the base: every run's prompt begins with the operate file, and a run that
// cannot get it does not start. So the skills half records a failure of its own
// ("skills") and returns null, and NEVER throws out of here.
export async function postStep(run, deps = {}) {
  const { fetch = convexFetch } = deps;
  const dir = run.dir;
  // A REBASE IN PROGRESS MEANS NO POST. During one, HEAD is detached on a
  // half-replayed commit: `rev-parse HEAD` names it, `git show <commit>:<path>`
  // reads whatever version of the pages that replay had reached, and Convex —
  // which only refuses a post OLDER than the one it holds — would take it and
  // serve it to every prompt until a clean night replaced it. The five steps
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
    // The guard covers the skills half too: it is the same HEAD, and a skill
    // body read off a half-replayed commit is exactly the bad post described
    // above, one table over.
    return { commit: null, pushed: false, files: null, skills: null, rebasing: true };
  }
  let prelude;
  try {
    // The assembler resolves HEAD and reads every body from that immutable
    // object. The header variants below stay pinned to the resolved hash.
    const { assemblePreludePublication } = await loadPrelude();
    prelude = assemblePreludePublication({ wikitom: dir, commit: "HEAD" });
  } catch (error) {
    await recordFailure(
      run,
      "post",
      error,
      { fetch },
    );
    // No skills either, and no second failure row for them. The two halves read
    // the same commit through the same scripts/ directory, so whatever stopped
    // the assembler here — a missing page, an unreachable module — is the same
    // news the skills half would report, and one row says it once.
    return { commit: null, pushed: false, files: null, skills: null };
  }
  const files = prelude.files.map(({ path: filePath, sourceBody: body, bytes }) => ({ path: filePath, body, bytes }));
  // A REFUSED BASE POST IS RECORDED AND THE SKILLS STILL GO, which is the other
  // direction of the same rule: two doors, and one of them being shut is not a
  // reason to leave the box without tonight's skill bodies. What the run then
  // reports is `commit: null` — Convex does not hold this commit, and the
  // summary must not say it does.
  let delivered = true;
  try {
    const res = await fetch(run.env, "/tts/model-of-tom", {
      commit: prelude.commit,
      committedAt: prelude.committedAt,
      pushed: prelude.pushed,
      layers: prelude.layers,
      files,
      headers: prelude.headers,
      // The version of the graph the same night generated from the same
      // checkout, so a reader of a run row and a reader of the publication
      // name the same object. Null on a night the graph step did not run.
      graphVersion: run.results.graph?.graph?.version ?? null,
    });
    console.log(
      `[nightly] post: ${res.files} file(s) at WikiTom ${prelude.commit.slice(0, 12)}${prelude.pushed ? "" : " (not yet pushed)"} — ${files.map((f) => f.path).join(", ")}`,
    );
  } catch (error) {
    await recordFailure(run, "post", error, { fetch });
    delivered = false;
  }
  const skills = await skillsHalf(run, {
    fetch,
    commit: prelude.commit,
    pushed: prelude.pushed,
    publishSkills: deps.publishSkills,
    checkouts: deps.checkouts ?? REPO_CHECKOUTS,
    dirs: deps.skillsDirs ?? boxSkillsDirs(),
  });
  if (!delivered) return { commit: null, pushed: false, files: null, skills };
  return { commit: prelude.commit, pushed: prelude.pushed, files: files.map((f) => f.path), skills };
}

/**
 * The catalog read back out of the directories publishSkills has just written:
 * one entry per skill, in the shape POST /tts/skills takes.
 *
 * WHY IT IS READ BACK RATHER THAN HANDED OVER. publishSkills returns a REPORT —
 * name, group, byte counts, reference names, how many files it wrote — because
 * its job is to put a directory on a disk, and nothing until now needed the
 * bodies afterwards. The catalog needs them. Reading the files it just wrote is
 * the one way to get them without a second definition of what the page set is,
 * and it has a property worth having: the catalog Convex holds is literally the
 * bytes the box's agents will load.
 *
 * IT IS COUPLED TO renderSkillMd's LAYOUT, so it fails loud rather than
 * quietly: every field is checked back against the byte counts publishSkills
 * reported, and a mismatch throws — which makes it the skills half's recorded
 * failure, not a silently wrong post. The cheaper fix, when someone owns that
 * file, is for publishSkills to return the built skills and for this function
 * to be deleted.
 */
export const SKILL_PROVENANCE = /^<!-- generated from (\S+) (.+) at commit ([0-9a-f]+) — do not edit -->$/;

/**
 * Where one reference's body came from — the field POST /tts/skills requires
 * and the only one publishSkills' report does not carry.
 *
 * A reference is written under its FLATTENED name (scripts/skills.mjs
 * referenceName: every "/" becomes "-", so `convex/AGENTS.md` is the file
 * `convex-AGENTS.md`), and that flattening does not invert — a directory with
 * a hyphen in it would read back wrong. So the path is looked up rather than
 * unflattened, against the two things that produce a reference:
 *
 *   a skill of the REPO group carries that repository's nested AGENTS.md
 *   files, and `rules` is the list of them read from its own HEAD by the same
 *   helper the repo-rules step uses — one entry per candidate path, matched by
 *   name;
 *   any other skill's reference (ground.md) sits beside the page the skill was
 *   built from, so it is that page's directory and this name.
 *
 * The GROUP decides which, and not the origin: WikiTom is both the vault every
 * write and know skill is built from AND a repository with rules of its own, so
 * the origin name alone would send `ground.md` to the repo lookup.
 *
 * An unresolved name THROWS, which makes it the skills half's failure row: a
 * guessed path in the store is worse than a night without a catalog.
 *
 * THE HONEST FIX IS ONE LINE ELSEWHERE. publishSkills already holds
 * `{ name, path, body }` for every reference and reports only the name; when
 * scripts/publish-skills.mjs is next open, have it return the built skills, and
 * this function and readSkillCatalog both go.
 */
export function referencePathResolver(rulesByRepo, referenceName) {
  return ({ name, group, origin, sourcePaths, file }) => {
    if (group === "repo") {
      const rules = rulesByRepo.get(origin) ?? [];
      const match = rules.find((candidate) => referenceName(candidate) === name);
      if (match === undefined) {
        throw new Error(`${file}: ${origin} at this commit has no rules file named ${name}`);
      }
      return match;
    }
    const beside = sourcePaths[0];
    if (typeof beside !== "string" || !beside.includes("/")) {
      throw new Error(`${file}: cannot say where the reference ${name} came from`);
    }
    return `${beside.slice(0, beside.lastIndexOf("/"))}/${name}`;
  };
}

export function readSkillCatalog(outDir, published, { skillDirName, referencePath }) {
  return published.skills.map((reported) => {
    const dir = path.join(outDir, skillDirName(reported.name));
    const file = path.join(dir, "SKILL.md");
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const close = lines.indexOf("---", 1);
    if (lines[0] !== "---" || close === -1) throw new Error(`${file} carries no frontmatter`);
    const declared = lines.slice(1, close).find((line) => line.startsWith("description: "));
    if (declared === undefined) throw new Error(`${file} carries no description`);
    let description;
    try {
      description = JSON.parse(declared.slice("description: ".length));
    } catch {
      throw new Error(`${file}: the description is not the JSON string renderSkillMd writes`);
    }
    const provenance = SKILL_PROVENANCE.exec(lines[close + 2] ?? "");
    if (provenance === null) throw new Error(`${file} carries no provenance line`);
    const sourcePaths = provenance[2].split(", ");
    const rest = lines.slice(close + 4).join("\n");
    const body = rest.endsWith("\n") ? rest.slice(0, -1) : rest;
    if (Buffer.byteLength(body) !== reported.bodyBytes || Buffer.byteLength(description) !== reported.descriptionBytes) {
      throw new Error(
        `${file} did not read back as the ${reported.descriptionBytes}-byte description and ${reported.bodyBytes}-byte ` +
          "body publish-skills.mjs reported — SKILL.md's layout changed under this reader",
      );
    }
    return {
      name: reported.name,
      group: reported.group,
      description,
      body,
      references: reported.references.map((name) => {
        const referenceBody = fs.readFileSync(path.join(dir, name), "utf8");
        return {
          name,
          path: referencePath({ name, group: reported.group, origin: provenance[1], sourcePaths, file }),
          body: referenceBody,
          bytes: Buffer.byteLength(referenceBody),
        };
      }),
      sourcePaths,
      bytes: reported.bodyBytes,
    };
  });
}

/**
 * The skills half of the post: the box's skill directories written from the
 * same HEAD the base came off, then the catalog to POST /tts/skills, in that
 * order.
 *
 * Returns `{ commit, count, dirs, refused }`, or NULL when it could not run.
 * Every failure inside it is recorded as its own "skills" row and swallowed —
 * the base post has already happened by the time this is called, and losing it
 * to a bad skill body is the one outcome this shape exists to prevent.
 */
async function skillsHalf(run, { fetch, commit, pushed, publishSkills, checkouts, dirs }) {
  let published;
  let catalog;
  try {
    if (dirs.length === 0) throw new Error("no skills directory is configured, so there is nothing to write");
    const publish = publishSkills ?? (await loadPublishSkills()).publishSkills;
    const { skillDirName, referenceName } = await loadSkills();
    const { collectRepoRules } = await loadPrelude();
    // Only the checkouts that are really here: readRepo throws on a missing
    // one, and one absent clone must not cost the other two their skills. That
    // it is missing is already the repo-rules step's own failure row.
    const repos = checkouts
      .filter(({ dir }) => fs.existsSync(path.join(dir, ".git")))
      .map(({ repo, dir }) => ({ repo, dir }));
    // Three identical publications rather than one and two copies: publishSkills
    // is write-if-changed, so an unchanged night touches nothing, and a copy
    // would be a second thing that can be half-done.
    for (const out of dirs) published = publish({ wikitom: run.dir, commit, repos, out });
    // The candidate paths behind each repo skill's references (see
    // referencePathResolver). Same helper, same HEAD, as the repo-rules step.
    //
    // PER REPO AND FORGIVING, because collectRepoRules can be refused for a
    // reason that has nothing to do with this skill: prelude.mjs's git() runs
    // at execFileSync's 1 MB default, and `ls-tree -r` over WikiTom is 3.5 MB
    // of archived session files, so it fails there as "cannot list". A repo
    // that could not be listed contributes no candidates and costs nothing
    // unless one of its skills actually carries a reference — and then the
    // resolver throws, by name, instead of storing a guessed path. (The fix is
    // the maxBuffer line scripts/publish-skills.mjs already carries, one
    // directory over; until it is in prelude.mjs, the repo-rules step loses
    // WikiTom to the same 1 MB the same way, as its own failure row.)
    const rulesByRepo = new Map();
    for (const { repo, dir } of repos) {
      try {
        rulesByRepo.set(repo, collectRepoRules({ dir, repo, commit: "HEAD" }).rules.map((rule) => rule.path));
      } catch {
        rulesByRepo.set(repo, []);
      }
    }
    catalog = readSkillCatalog(dirs[0], published, {
      skillDirName,
      referencePath: referencePathResolver(rulesByRepo, referenceName),
    });
    // The door refuses an empty post — it replaces the store whole, and an
    // empty one would wipe it — so say why here rather than read a 400 back.
    if (catalog.length === 0) {
      throw new Error(`no skill built at ${published.commit.slice(0, 12)}; the store keeps the catalog it has`);
    }
  } catch (error) {
    await recordFailure(run, "skills", error, { fetch });
    return null;
  }
  try {
    await fetch(run.env, "/tts/skills", {
      commit: published.commit,
      syncedAt: Date.now(),
      pushed,
      skills: catalog,
      refused: published.refused,
    });
  } catch (error) {
    // The directories are written and the box's agents will load them tonight;
    // what is stale is the catalog Convex serves, and the row says so.
    await recordFailure(run, "skills", error, { fetch });
    return null;
  }
  console.log(
    `[nightly] skills: ${catalog.length} skill(s) at WikiTom ${published.commit.slice(0, 12)} -> ${dirs.join(", ")}` +
      `${published.refused.length > 0 ? `; refused ${published.refused.map((entry) => entry.name).join(", ")}` : ""}`,
  );
  return { commit: published.commit, count: catalog.length, dirs: [...dirs], refused: published.refused };
}

// ── the golden export ────────────────────────────────────────────────────────
// One run of scripts/export-golden.mjs --source labels, turning every judgment
// Tom wrote about a registered run into an eval case under evals/golden/runs/.
//
// IT RUNS NIGHTLY AND NOT WEEKLY, and that is the whole reason it is a step in
// this job rather than in Friday's. A label names a run, and Convex evicts a
// run's stored output after thirty days; a label whose run has been evicted is
// UNBUILDABLE, and phase 7 deliberately does not reach back into the object
// store to refetch one. A weekly pass would therefore lose cases to a window
// nothing can reopen — a nightly one never sees the window at all.
//
// IT NEVER PUSHES MAIN FROM THIS BOX. evals/golden/** is a watched path, so the
// export lands on a branch and goes through the evals gate like every other
// change — which is exactly the property wanted: a case the exporter invented
// wrongly is caught by the same check it would gate.
//
// THE LANDING IS A SEAM AND IS NAMED AS ONE. Every other repository write in
// this job goes to the WikiTom checkout, under the WikiTom writer lock, through
// commitTree and syncRemote — helpers that stage WikiTom's own directories and
// push the branch already checked out. None of that is a branch-and-open-a-PR
// mechanism, and none of it points at tom.quest. So the export is made, its
// counts are reported, and `deps.land` is the one call a caller supplies to put
// it on a branch; with no lander the files sit in the disposable cache clone,
// the result says `landed: false`, and NOTHING is committed or pushed anywhere.
//
// The clone is the box's established tom.quest checkout mechanism — the shallow
// cache clone evals.mjs takes its worktrees from (tts-code-lib.mjs
// cacheRepoDir), rebuilt from origin on every use — NOT /root/tom.quest, which
// is the checkout this box runs from and must not be left dirty by a cron job.
export const GOLDEN_EXPORT_SCRIPT = "scripts/export-golden.mjs";
/** Where `--source labels` writes, one level below the rulings set so
 * worker/jobs/evals.mjs loadGolden discovers it with no edit (the exporter's
 * own RUNS_SUBDIR). */
export const GOLDEN_RUNS_DIR = "evals/golden/runs";

export async function goldenExportStep(run, deps = {}) {
  const checkout = deps.checkout ?? (() => cacheRepoDir(run.env, { name: "tom.quest", owner: "Heffnt", branch: "main" }));
  const exec = deps.exec ?? ((dir, args) =>
    execFileSync(process.execPath, args, {
      cwd: dir,
      encoding: "utf8",
      // stdin closed (cron has no terminal); stderr to the cron log, where the
      // exporter's own refusals are diagnosable. The credentials ride in the
      // child's environment and are never an argument, so nothing secret can
      // reach a process listing or this log.
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, ...run.env },
    }));
  const land = deps.land ?? null;
  const dir = checkout();
  const output = String(exec(dir, [GOLDEN_EXPORT_SCRIPT, "--source", "labels"]) ?? "");
  // The exporter's own last line, kept verbatim rather than re-derived: it
  // already counts what it built, what it could not build and what it dropped,
  // and a second count here would be a second definition of "an item".
  const summary = output.split("\n").map((l) => l.trim()).filter((l) => l !== "").at(-1) ?? "";
  const outDir = path.join(dir, GOLDEN_RUNS_DIR);
  const items = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((n) => n.endsWith(".json")).length : 0;
  const landed = land === null ? false : land({ dir, paths: [GOLDEN_RUNS_DIR], day: run.day }) === true;
  console.log(
    `[nightly] golden-export: ${items} case(s) in ${GOLDEN_RUNS_DIR} — ${summary || "the exporter said nothing"}; ` +
      (landed
        ? "landed on a branch"
        : "NOT landed: this job has no tom.quest branch-and-commit helper, so the files stay in the cache clone"),
  );
  return { dir, items, summary, landed };
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

// ── 7. the repo rules ────────────────────────────────────────────────────────
// NOT under the WikiTom lock: this reads a different checkout entirely, and
// nothing in this job writes it. Each repo's AGENTS.md bodies are read out of
// its own immutable HEAD and posted whole, replacing that repo's rows and no
// other repo's — the same replace-all-per-subject semantics the model-of-tom
// post has, so a repo whose post fails keeps the rules Convex already holds.
//
// A missing checkout is a recorded failure, not a thrown one: the box may be
// rebuilt with WikiTom present and tom.quest not yet cloned, and the morning
// digest should say so rather than lose the seven steps above it.
//
// EVERY REPO IS ISOLATED FROM EVERY OTHER. With three checkouts in the list, a
// repo whose clone is missing, whose rules are empty, or whose post is refused
// costs itself and nothing else: each of those is one failure row and a
// `continue`, and the repos after it still post.
export async function repoRulesStep(run, deps = {}) {
  const { fetch = convexFetch, checkouts = REPO_CHECKOUTS } = deps;
  const posted = [];
  for (const { repo, dir } of checkouts) {
    if (!fs.existsSync(path.join(dir, ".git"))) {
      await recordFailure(
        run,
        "repo-rules",
        new Error(`${dir} is not a git checkout — the ${repo} rules keep whatever Convex holds`),
        { fetch },
      );
      continue;
    }
    let collected;
    try {
      const { collectRepoRules } = await loadPrelude();
      collected = collectRepoRules({ dir, repo, commit: "HEAD" });
    } catch (error) {
      await recordFailure(run, "repo-rules", error, { fetch });
      continue;
    }
    if (collected.rules.length === 0) {
      await recordFailure(
        run,
        "repo-rules",
        new Error(`${repo} at ${collected.commit.slice(0, 12)} has no AGENTS.md — store left as it was`),
        { fetch },
      );
      continue;
    }
    let res;
    try {
      res = await fetch(run.env, "/tts/repo-rules", {
        repo,
        commit: collected.commit,
        syncedAt: Date.now(),
        files: collected.rules.map(({ path: filePath, body, bytes }) => ({ path: filePath, body, bytes })),
      });
    } catch (error) {
      await recordFailure(run, "repo-rules", error, { fetch });
      continue;
    }
    console.log(
      `[nightly] repo-rules: ${res.files} file(s) for ${repo} at ${collected.commit.slice(0, 12)} — ${collected.rules.map((r) => r.path).join(", ")}`,
    );
    posted.push({ repo, commit: collected.commit, files: collected.rules.map((r) => r.path) });
  }
  return { repos: posted };
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
  const env = loadEnv({ require: ["SESSIONS_WORKER_KEY"] });
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
  // Here, for delivery's reason and one of its own: it writes a tom.quest cache
  // clone, not the WikiTom checkout, so it neither needs the lock nor should
  // hold it — and it comes before learning, which is the ordering the night's
  // labels-to-cases path asks for.
  if (only.includes("golden-export")) {
    try {
      run.results["golden-export"] = await goldenExportStep(run);
    } catch (err) {
      await recordFailure(run, "golden-export", err);
    }
  }
  // No checkout is a bad night, not a silent one: the digest reads these two
  // rows, and a run that threw here wrote neither — the one morning Tom would
  // see nothing at all is the morning the checkout is gone.
  if (!fs.existsSync(path.join(run.dir, ".git"))) {
    // Neither of these reads the checkout, so a run asking only for them is a
    // complete run, not a broken one.
    if (only.every((name) => CHECKOUTLESS_STEPS.includes(name))) {
      if (only.includes("repo-rules")) {
        try {
          run.results["repo-rules"] = await repoRulesStep(run);
        } catch (err) {
          await recordFailure(run, "repo-rules", err);
        }
      }
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
    "golden-export": goldenExportStep,
    snapshot: snapshotStep,
    graph: graphStep,
    learning: learningStep,
    runs: runsStep,
    "repo-learning": repoLearningStep,
    push: pushStep,
    post: postStep,
    "repo-rules": repoRulesStep,
  };
  const runStep = async (name) => {
    try {
      run.results[name] = await steps[name](run);
    } catch (err) {
      await recordFailure(run, name, err);
    }
  };
  // Every step runs under the one lock (see withWikiTomLock): steps 2 to 6
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
    // Every WikiTom step is skipped; the summary below says so.
    await recordFailure(run, "lock", err);
  }
  // OUTSIDE THE LOCK, and outside the try that holds it: this step reads a
  // different checkout, writes nothing, and a night that lost the WikiTom lock
  // is exactly a night whose repo rules should still reach Convex.
  if (only.includes("repo-rules")) await runStep("repo-rules");
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
    runs: run.results.runs ?? null,
    delivery: run.results.delivery ?? null,
    // Both versions, the counts, the bytes against the cap, which of the two
    // files changed, and whether the map candidate moved — the whole of what
    // the 5 a.m. digest can say about tonight's graph without reading it.
    graph: run.results.graph ?? null,
    // The clone path is not carried: it is a cache directory on this box and
    // means nothing to a reader of the record. `landed: false` is the fact the
    // digest and the weekly gather can act on.
    goldenExport: run.results["golden-export"]
      ? {
          items: run.results["golden-export"].items,
          summary: run.results["golden-export"].summary,
          landed: run.results["golden-export"].landed,
        }
      : null,
    learning: run.results.learning
      ? {
          changes: run.results.learning.changes,
          refused: run.results.learning.refused.length,
          reverted: run.results.learning.reverted,
          revertFailed: run.results.learning.revertFailed,
          tomTurns: run.results.learning.tomTurns,
          // A weekly "did learning run" fact reads this: a night that wrote
          // nothing because the checker refused it is not a quiet night.
          checkFailed: run.results.learning.checkFailed === true,
        }
      : null,
    repoLearning: run.results["repo-learning"]
      ? {
          sessions: run.results["repo-learning"].sessions,
          proposals: run.results["repo-learning"].proposals,
          dropped: run.results["repo-learning"].dropped,
          reconciled: run.results["repo-learning"].reconciled,
        }
      : null,
    posted: run.results.post?.files ?? null,
    // The post's second half, or null on a night it could not run — which is
    // how the digest says the catalog Convex serves is older than the layers.
    skills: run.results.post?.skills ?? null,
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
