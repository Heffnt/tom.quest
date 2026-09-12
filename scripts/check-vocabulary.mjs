// Guardrail: the closed vocabulary and the graph it is the schema of.
//
// ONE SCRIPT, NOT TWO. The vocabulary is the graph's schema — the node and edge
// kinds are vocabulary terms, and scripts/graph.mjs checks every kind it mints
// against tts/vocabulary.json — and one schema has one checker. A second script
// would resolve the same WikiTom checkout, decide the same two modes and print
// the same two lines, and the day the two disagreed about whether a checkout
// resolved is the day nobody would know which one CI ran.
//
// TWO MODES, DECIDED BY WHETHER A WikiTom CHECKOUT RESOLVES. The nine in-repo
// checks read only this repository and run everywhere. The two render checks
// ask the generators whether the files on disk are what the render produces,
// which needs the vault; with no vault they are skipped, by the one line at the
// end, and the nightly runs them instead.
//
// It reads files relative to the CURRENT DIRECTORY, the way
// scripts/check-session-mirrors.mjs does, so `pnpm check:guardrails` from the
// repository root checks the repository root.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, sep } from "node:path";
import { EDGE_KINDS, NODE_KINDS } from "../worker/jobs/graph.mjs";
import { BOX_WIKITOM_DIR, LAPTOP_WIKITOM_DIR } from "../worker/jobs/search-lib.mjs";

const failures = [];
const notes = [];
// What a check FOUND without judging it. Printed verbatim, ahead of the notes
// and the failures, so a run whose exit status is 0 still carries the finding.
const reports = [];

// ── What the generator writes, read independently ────────────────────────────
// scripts/vocabulary.mjs keeps these three shapes as module-private constants,
// so they are spelled again here rather than imported. That is the point of a
// guardrail: an independent reading of the bytes on disk, which still fails when
// the generator and its own marker drift apart.
const SHARED_PATH = "convex/ttsShared.ts";
const GENERATOR_PATH = "scripts/vocabulary.mjs";
// EVERY PATTERN HERE TOLERATES A CARRIAGE RETURN. convex/ttsShared.ts is CRLF on
// disk and the generator restores the endings it found, so a `$` anchored
// straight after a `>` or a `,` would match nothing in the file this checks.
const MARKER_OPEN = /^\/\/ <vocabulary generated version=([0-9a-f]{16}) — .*>\r?$/gm;
const MARKER_OPEN_LOOSE = /^\/\/ <vocabulary generated\b.*\r?$/gm;
const MARKER_CLOSE = "// </vocabulary generated>";
const MARKER_CLOSE_RE = /^\/\/ <\/vocabulary generated>\r?$/gm;

// The closed vocabulary's own opening sentence. It has one home, inside the
// block; check 3 below is what keeps it there.
const CLOSED_SENTENCE = "these words mean exactly this and nothing else";

// The two words Tom's switch (4)/(c) refuses: the whole is called the graph, and
// these are the names it is not called.
const REFUSED_WORDS = [/ontology/gi, /knowledge graph/gi];

// Check 3's exemption: this file and its test, which carry the closed
// vocabulary's opening sentence because a check for a sentence has to spell the
// sentence. Nothing else may hold a second copy.
const EXEMPT_FILES = new Set(["scripts/check-vocabulary.mjs", "scripts/check-vocabulary.test.mjs"]);

// Check 4's exemption, a NAMED LIST OF FOUR FILES and no directory, each with
// the reason it may spell a refused word:
//  - scripts/check-vocabulary.mjs and scripts/check-vocabulary.test.mjs: a check
//    for a word has to spell the word, and its test has to spell it to witness
//    the check.
//  - worker/jobs/search-lib.test.mjs: three fixtures exist to prove that
//    `tts search define` prints a refused word AS refused, and a fixture that
//    could not name the word would be testing nothing.
//  - scripts/graph.mjs: exempt for a RANGE, not as a file — see
//    switchFourRange below. Its switch-4 declaration is the line that refuses
//    these two words, and a declaration that cannot name what it refuses says
//    nothing; a refused word anywhere else in that file still fails.
const REFUSED_WORD_EXEMPT_FILES = new Set([
  "scripts/check-vocabulary.mjs",
  "scripts/check-vocabulary.test.mjs",
  "worker/jobs/search-lib.test.mjs",
]);
const REFUSED_WORD_RANGE_FILE = "scripts/graph.mjs";

/** The character range of scripts/graph.mjs's switch-4 doc comment: the block
 * comment that ends immediately above `export const NAME =`. `null` when either
 * the declaration or its comment has moved, which leaves the whole file
 * unexempt and the check loud rather than silently wider. */
function switchFourRange(text) {
  const at = text.search(/^export const NAME\s*=/m);
  if (at === -1) return null;
  const end = text.lastIndexOf("*/", at);
  if (end === -1) return null;
  const start = text.lastIndexOf("/**", end);
  if (start === -1) return null;
  return [start, end + "*/".length];
}

// The schema's table count. THE GRAPH IS A FILE AND A PURE FUNCTION AND ADDS NO
// TABLE: tts/graph.json lives in WikiTom, worker/jobs/graph.mjs holds the walk,
// and the only Convex-side fact a run records is a field on a row that already
// exists. A graph that wanted a table of its own would be a different design,
// and this number is where that shows up.
const SCHEMA_TABLES = 44;

// The one home of the caller table (worker/jobs/skill-router.mjs). A second
// declaration anywhere under worker/ or convex/ is a second answer to "what does
// this caller get", and the one that answers is whichever file the reader opened.
const CONTEXT_CALLERS_DECLARATION = /(?:export\s+)?(?:const|let|var)\s+CONTEXT_CALLERS\s*[:=]/;

const SCAN_EXT = /\.(ts|tsx|mjs|cjs|js|jsx)$/;
const SKIP_DIR = new Set([
  "node_modules",
  ".git",
  ".next",
  ".vercel",
  ".turbo",
  "_generated",
  "dist",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
]);

/** Every source file under `dir`, POSIX-separated and relative to the current
 * directory. A directory that is not here contributes nothing: this script runs
 * against a repository root and against a fixture that holds only the files one
 * check needs. */
function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIR.has(entry.name)) walk(join(current, entry.name));
      } else if (SCAN_EXT.test(entry.name)) {
        out.push(join(current, entry.name).split(sep).join("/").replace(/^\.\//, ""));
      }
    }
  };
  walk(dir);
  return out.sort();
}

function read(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Line and block comments blanked out, so a check that searches for a token
 * searches executable code. Prose that says "no embedding and no vector" is
 * documentation and cannot become behavior; the same strip, and the same
 * reasoning, as check-session-mirrors.mjs's. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => {
      const at = line.indexOf("//");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** Every match of `re` in `text`, as `{ index, match }`. `re` carries `g`. */
function matches(re, text) {
  re.lastIndex = 0;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push({ index: m.index, match: m });
  return out;
}

// ── The nine in-repo checks ──────────────────────────────────────────────────

const shared = read(SHARED_PATH);
if (shared === null) {
  failures.push(`${SHARED_PATH} is not in this checkout — the generated block has nowhere to be`);
}

// 1. The markers are both there, in order, exactly once. Checked with the LOOSE
//    pattern as well as the strict one, so a marker whose version field the
//    generator stopped writing is a named failure rather than a missing block.
// witness: delete the closing marker line from convex/ttsShared.ts.
let block = null;
let openVersion = null;
if (shared !== null) {
  // `<vocabulary` and `</vocabulary` are different strings, so the loose opening
  // pattern never matches the closing marker and needs no exclusion.
  const loose = matches(MARKER_OPEN_LOOSE, shared);
  const opens = matches(MARKER_OPEN, shared);
  const closes = matches(MARKER_CLOSE_RE, shared);
  if (loose.length !== 1) {
    failures.push(
      `${SHARED_PATH}: ${loose.length} opening \`<vocabulary generated …>\` marker(s), expected exactly 1 — `
        + `regenerate with \`node ${GENERATOR_PATH} --wikitom <dir> --write\``,
    );
  } else if (opens.length !== 1) {
    failures.push(
      `${SHARED_PATH}:${lineOf(shared, loose[0].index)}: the opening marker is not `
        + `\`// <vocabulary generated version=<16 hex> — ${GENERATOR_PATH}; do not edit>\``,
    );
  }
  if (closes.length !== 1) {
    failures.push(
      `${SHARED_PATH}: ${closes.length} \`${MARKER_CLOSE}\` marker(s), expected exactly 1`,
    );
  }
  if (opens.length === 1 && closes.length === 1) {
    if (opens[0].index > closes[0].index) {
      failures.push(
        `${SHARED_PATH}: the closing marker is on line ${lineOf(shared, closes[0].index)}, `
          + `above the opening one on line ${lineOf(shared, opens[0].index)}`,
      );
    } else {
      openVersion = opens[0].match[1];
      block = shared.slice(opens[0].index, closes[0].index + MARKER_CLOSE.length);
    }
  }
}

// 2. The version on the marker IS the version in the block. Two spellings of one
//    fact, and a reader of either has to be reading the same one.
// witness: change one hex digit of VOCABULARY_VERSION inside the block.
if (block !== null) {
  const declared = /export const VOCABULARY_VERSION = "([0-9a-f]*)";/.exec(block);
  if (declared === null) {
    failures.push(`${SHARED_PATH}: the generated block declares no \`export const VOCABULARY_VERSION = "…";\``);
  } else if (!/^[0-9a-f]{16}$/.test(declared[1])) {
    failures.push(
      `${SHARED_PATH}: VOCABULARY_VERSION is "${declared[1]}", not 16 lowercase hex characters`,
    );
  } else if (declared[1] !== openVersion) {
    failures.push(
      `${SHARED_PATH}: the marker says version=${openVersion} and the block says VOCABULARY_VERSION = "${declared[1]}"`,
    );
  }
}

// 3. ONE CLOSED VOCABULARY, ONE COPY. The opening sentence appears inside the
//    generated block and nowhere else under convex/, worker/ or scripts/ — a
//    second copy is a second vocabulary, and the one a prompt carries is
//    whichever file its builder imported.
// witness: paste the sentence into any convex/ or worker/ source file.
{
  const outside = [];
  for (const file of [...sourceFiles("convex"), ...sourceFiles("worker"), ...sourceFiles("scripts")]) {
    if (EXEMPT_FILES.has(file)) continue;
    const text = read(file);
    if (text === null) continue;
    // The block's own copy is the home; everything else in ttsShared.ts is not.
    const searched = file === SHARED_PATH && block !== null ? text.split(block).join("\n") : text;
    const at = searched.indexOf(CLOSED_SENTENCE);
    if (at !== -1) outside.push(`${file}:${lineOf(searched, at)}`);
  }
  for (const where of outside) {
    failures.push(
      `${where}: "${CLOSED_SENTENCE}" outside the generated block in ${SHARED_PATH} — `
        + "the closed vocabulary has one copy",
    );
  }
}

// 4. Switch (4)/(c): the whole is called the graph. "ontology" and "knowledge
//    graph" are refused words, in code and in comments alike — the name is what
//    a reader takes from a file, and a comment is read. Four files may spell
//    them, each for the reason stated at REFUSED_WORD_EXEMPT_FILES above, and
//    scripts/graph.mjs only inside its switch-4 doc comment.
// witness: write "the ontology" in any comment under convex/, worker/, scripts/,
// app/ or vqc/.
{
  const scanned = ["convex", "worker", "scripts", "app", "vqc"].flatMap((dir) => sourceFiles(dir));
  for (const file of scanned) {
    if (REFUSED_WORD_EXEMPT_FILES.has(file)) continue;
    const text = read(file);
    if (text === null) continue;
    const range = file === REFUSED_WORD_RANGE_FILE ? switchFourRange(text) : null;
    for (const re of REFUSED_WORDS) {
      for (const { index, match } of matches(re, text)) {
        if (range !== null && index >= range[0] && index < range[1]) continue;
        failures.push(
          `${file}:${lineOf(text, index)}: "${match[0]}" is a refused word — the whole is called the graph `
            + "(scripts/graph.mjs NAME)",
        );
      }
    }
  }
}

// 5. The evals commit key has one home. An inline `${repo}@${sha}` template is a
//    second spelling of the key rows are stored under, and a row written under
//    one spelling is invisible to a reader using the other.
// witness: write `const key = `${args.repo}@${args.sha}`;` in convex/ttsEvals.ts.
{
  const evals = read("convex/ttsEvals.ts");
  if (evals === null) {
    notes.push("convex/ttsEvals.ts is not in this checkout — the commit-key check had nothing to read");
  } else {
    const inline = /`\$\{[^}`]*\}@\$\{[^}`]*\}`/g;
    for (const { index, match } of matches(inline, evals)) {
      failures.push(
        `convex/ttsEvals.ts:${lineOf(evals, index)}: the commit key ${match[0]} is written inline — `
          + "it has one home, and two spellings index two different sets of rows",
      );
    }
  }
}

// 6. The graph's closed kind lists, in the SAME block. scripts/vocabulary.mjs
//    writes ONE combined block — the vocabulary's version and term names and the
//    graph's two kind lists, inside the one `<vocabulary generated …>` marker
//    pair — so there is no second `<graph generated …>` pair to look for and
//    this check does not invent one. What it checks is that the lists the block
//    carries are the lists worker/jobs/graph.mjs actually mints, which is the
//    same fact a separate marker would have carried.
// witness: add a kind to STATIC_NODE_KINDS in worker/jobs/graph.mjs without
// regenerating, or delete a line from GRAPH_EDGE_KINDS in the block.
if (block !== null) {
  const listOf = (name) => {
    const declared = new RegExp(
      `export const ${name}: readonly string\\[\\] = \\[\\r?\\n([\\s\\S]*?)\\r?\\n\\];`,
    ).exec(block);
    if (declared === null) return null;
    return matches(/^ {2}"([^"]*)",\r?$/gm, declared[1]).map(({ match }) => match[1]);
  };
  for (const [name, expected] of [["GRAPH_NODE_KINDS", NODE_KINDS], ["GRAPH_EDGE_KINDS", EDGE_KINDS]]) {
    const found = listOf(name);
    if (found === null) {
      failures.push(`${SHARED_PATH}: the generated block declares no \`export const ${name}: readonly string[]\``);
      continue;
    }
    const want = [...expected].join(", ");
    const got = found.join(", ");
    if (want !== got) {
      failures.push(
        `${SHARED_PATH}: ${name} is [${got}] and worker/jobs/graph.mjs mints [${want}] — `
          + `regenerate with \`node ${GENERATOR_PATH} --wikitom <dir> --write\``,
      );
    }
  }
}

// 7. Switch (3): no model, no network, no vector index. The graph's two halves
//    read text and compute over it, and an edge whose provenance is a named
//    regex is auditable where one a model wrote is not. Searched in EXECUTABLE
//    CODE only (stripComments above): both files say in prose that they hold no
//    embedding and no vector, and that sentence is the rule rather than a
//    breach of it.
// witness: call fetch() in scripts/graph.mjs, or add a dependency named
// "faiss-node" to package.json.
{
  const TOKENS = [/fetch\(/gi, /anthropic/gi, /openai/gi, /embedding/gi, /vector/gi, /cosine/gi, /faiss/gi];
  for (const file of ["scripts/graph.mjs", "worker/jobs/graph.mjs"]) {
    const text = read(file);
    if (text === null) {
      failures.push(`${file} is not in this checkout — the graph's generator is half of what this checks`);
      continue;
    }
    const code = stripComments(text);
    for (const re of TOKENS) {
      for (const { index, match } of matches(re, code)) {
        failures.push(
          `${file}:${lineOf(code, index)}: "${match[0]}" in code — the graph holds no model, no network and `
            + "no vector index (scripts/graph.mjs REJECTS)",
        );
      }
    }
  }
  // The same rule one level up: a dependency whose NAME is one of these is an
  // embedding or vector store however it is used.
  const EMBEDDING_DEPENDENCY = /embed|vector|faiss|openai|anthropic|cohere|pinecone|chroma|qdrant|weaviate|lancedb|hnsw|langchain/i;
  const manifest = read("package.json");
  if (manifest === null) {
    failures.push("package.json is not in this checkout");
  } else {
    let parsed = null;
    try {
      parsed = JSON.parse(manifest);
    } catch {
      failures.push("package.json is not JSON");
    }
    if (parsed !== null) {
      const named = [
        ...Object.keys(parsed.dependencies ?? {}),
        ...Object.keys(parsed.devDependencies ?? {}),
      ].sort();
      for (const name of named) {
        if (EMBEDDING_DEPENDENCY.test(name)) {
          failures.push(`package.json depends on "${name}" — the graph adds no embedding or vector dependency`);
        }
      }
    }
  }
}

// 8. The schema gained no table. See SCHEMA_TABLES above for what that asserts.
// witness: add a `defineTable` to convex/schema.ts.
{
  const schema = read("convex/schema.ts");
  if (schema === null) {
    failures.push("convex/schema.ts is not in this checkout");
  } else {
    const tables = matches(/defineTable\(/g, schema).length;
    if (tables !== SCHEMA_TABLES) {
      failures.push(
        `convex/schema.ts defines ${tables} tables and this check expects ${SCHEMA_TABLES} — `
          + "the graph is a file and a pure function and adds no table; if a table was added for another "
          + "round, move SCHEMA_TABLES in scripts/check-vocabulary.mjs with it",
      );
    }
  }
}

// 9. CONTEXT_CALLERS has one home.
// witness: write `export const CONTEXT_CALLERS = {}` in any second file under
// worker/ or convex/.
{
  const declared = [];
  for (const file of [...sourceFiles("worker"), ...sourceFiles("convex")]) {
    const text = read(file);
    if (text === null) continue;
    const at = text.search(CONTEXT_CALLERS_DECLARATION);
    if (at !== -1) declared.push(`${file}:${lineOf(text, at)}`);
  }
  if (declared.length !== 1) {
    failures.push(
      `CONTEXT_CALLERS is declared ${declared.length} time(s) across worker/ and convex/ `
        + `(${declared.length === 0 ? "nowhere" : declared.join(", ")}) — the one home is worker/jobs/skill-router.mjs`,
    );
  }
}

// ── The two render checks, when a WikiTom checkout resolves ──────────────────
// `--wikitom`, else WIKITOM_DIR, else the platform default, resolved off the two
// constants worker/jobs/search-lib.mjs already spells rather than a third copy
// of those paths. BOX_WIKITOM_DIR reads WIKITOM_DIR itself; the environment is
// still checked first here, because the laptop constant does not.
function resolveWikitom(argv, env) {
  const flag = argv.indexOf("--wikitom");
  if (flag !== -1 && typeof argv[flag + 1] === "string") return argv[flag + 1];
  if (typeof env.WIKITOM_DIR === "string" && env.WIKITOM_DIR !== "") return env.WIKITOM_DIR;
  return process.platform === "win32" ? LAPTOP_WIKITOM_DIR : BOX_WIKITOM_DIR;
}

const wikitom = resolveWikitom(process.argv.slice(2), process.env);
const resolved = existsSync(wikitom) && statSync(wikitom).isDirectory();

/** One generator, run as the command line runs it. Its own stdout and stderr are
 * what the failure carries: the generators print a block per disagreement, and a
 * paraphrase here would be a second account of the same finding. */
function runGenerator(label, args) {
  try {
    execFileSync(process.execPath, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WIKITOM_DIR: wikitom },
    });
    return true;
  } catch (err) {
    const output = `${err?.stdout ?? ""}\n${err?.stderr ?? err?.message ?? err}`.trim();
    failures.push(`${label} FAILED:\n${output.split("\n").map((line) => `      ${line}`).join("\n")}`);
    return false;
  }
}

/** The same generator run for its REPORT rather than for a verdict: its stdout
 * and stderr come back whole and its exit status is not read. Check 11 is the
 * one caller, for the reason stated there. */
function reportGenerator(args) {
  try {
    return execFileSync(process.execPath, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WIKITOM_DIR: wikitom },
    }).trim();
  } catch (err) {
    return `${err?.stdout ?? ""}\n${err?.stderr ?? err?.message ?? err}`.trim();
  }
}

if (resolved) {
  // 10. THE STATIC HALF OF tts/graph.json IS WHAT THE RENDER PRODUCES.
  //     `--no-record` is what makes this runnable anywhere: the record half is
  //     built from the night's table copy, which a laptop checkout may not have,
  //     and the static half is the half a pull request can change.
  //
  //     A CHECKOUT WITH NO tts/graph.json AT ALL IS A NOTE, NOT A FAILURE. The
  //     file arrives in a vault when the nightly first writes it, and a vault
  //     that has never run one has nothing for a pull request to have changed.
  //     A vault that HAS the file and disagrees with the render is still a
  //     failure, which is the case this check exists for; the difference is
  //     read off the file's existence rather than off the generator's message,
  //     so a rename cannot turn one into the other.
  if (!existsSync(join(wikitom, "tts", "graph.json"))) {
    reports.push(
      `check-vocabulary: ${wikitom} has no tts/graph.json — nothing to check the render against; `
        + "the nightly writes it, and `node scripts/graph.mjs --wikitom <dir> --write` writes it now",
    );
  } else {
    runGenerator(
      `node scripts/graph.mjs --check --wikitom ${wikitom} --no-record`,
      ["scripts/graph.mjs", "--check", "--wikitom", wikitom, "--no-record"],
    );
  }
  // 11. THE SAME QUESTION OF THE VOCABULARY, PRINTED AND NOT FAILED, YET.
  //
  //     The vocabulary generator's first run against the real repositories
  //     found seven D1 disagreements — the seven prompt terms are worded one
  //     way in WikiTom tts/spec.md §12.1 and another way in
  //     convex/ttsShared.ts's TTS_CLOSED_VOCABULARY — plus a terms section over
  //     the 40 KiB cap and a map candidate over the 7,000-byte bound. Every one
  //     of those is a real fact about the system and none of them is this
  //     round's to settle: the first is Tom's wording, and the other two are
  //     numbers to re-argue against what was measured rather than estimated.
  //
  //     A check that failed on them would fail on every run from the day it
  //     shipped, which is a check nobody can act on. So this one prints the
  //     generator's report whole and does not read its exit status.
  //     worker/jobs/nightly.mjs's graphStep holds the vocabulary the same way
  //     and for the same reason — it runs with `write: false` and logs the
  //     count — and this matches it rather than holding a second opinion.
  //
  //     THE DAY THOSE THREE ARE SETTLED THIS BECOMES A FAILING CHECK, in one
  //     edit: call runGenerator here the way check 10 above does, and delete
  //     reportGenerator.
  //
  //     Check 10 is NOT held this way. The graph's own render is clean, and a
  //     disagreement there is a difference between the file on disk and what
  //     the generator produces from the same commit, which is always a fault.
  const vocabulary = read(GENERATOR_PATH);
  if (vocabulary === null) {
    notes.push(`${GENERATOR_PATH} is not in this checkout — its render check did not run`);
  } else if (!vocabulary.includes('"--check"')) {
    notes.push(`${GENERATOR_PATH} has no --check yet — its render check did not run`);
  } else {
    const output = reportGenerator([GENERATOR_PATH, "--check", "--wikitom", wikitom]);
    // Counted off the report's own block headings rather than off its summary
    // line, which is absent when the count is zero.
    const count = matches(/^DISAGREEMENT /gm, output).length;
    reports.push(
      `check-vocabulary: the vocabulary reports ${count} disagreement(s) and writes nothing — Tom's to settle; `
        + "check 11 reports and does not fail (see worker/jobs/nightly.mjs graphStep)",
    );
    reports.push(
      `node ${GENERATOR_PATH} --check --wikitom ${wikitom}:\n`
        + output.split("\n").map((line) => `      ${line}`).join("\n"),
    );
  }
}

// ── The report ───────────────────────────────────────────────────────────────

for (const report of reports) console.log(report);
for (const note of notes) console.log(`check-vocabulary: ${note}`);
if (failures.length > 0) {
  console.error("Vocabulary and graph check FAILED:");
  for (const failure of failures) console.error("  - " + failure);
  process.exit(1);
}
if (!resolved) {
  console.log("check-vocabulary: no WikiTom checkout — ran the 9 in-repo checks; the render checks run in the nightly");
  process.exit(0);
}
console.log(`Vocabulary and graph check passed (WikiTom at ${wikitom}).`);
