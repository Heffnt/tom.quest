// Guardrail: the closed vocabulary's generated block in convex/ttsShared.ts
// and the evals commit key — the checks of the vocabulary whose subject lives
// here.
//
// THE CHECK NUMBERS ARE SHARED WITH THE JARVIS REPOSITORY, so a failure named
// "check 3" means the same thing in both. tom.quest keeps 1, 2, 3 and 5; 4 and
// 6 are retired (see below). The render check of tts/vocabulary.json is the
// Jarvis repository's scripts/vocabulary.mjs, which the nightly runs.
//
// It reads files relative to the CURRENT DIRECTORY, the way
// scripts/check-session-mirrors.mjs does, so `pnpm check:guardrails` from the
// repository root checks the repository root.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

const failures = [];
const notes = [];

// ── What the generator writes, read independently ────────────────────────────
// The generator is the Jarvis repository's scripts/vocabulary.mjs, run against
// a tom.quest checkout (`--tom-quest DIR`). It keeps these three shapes as
// module-private constants, so they are spelled again here rather than
// imported. That is the point of a guardrail: an independent reading of the
// bytes on disk, which still fails when the generator and its own marker drift
// apart.
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

// Check 3's exemption: this file and its test, which carry the closed
// vocabulary's opening sentence because a check for a sentence has to spell the
// sentence. Nothing else may hold a second copy.
const EXEMPT_FILES = new Set(["scripts/check-vocabulary.mjs", "scripts/check-vocabulary.test.mjs"]);

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

// ── The four in-repo checks ──────────────────────────────────────────────────

const shared = read(SHARED_PATH);
if (shared === null) {
  failures.push(`${SHARED_PATH} is not in this checkout — the generated block has nowhere to be`);
}

// REMOVAL CHECK for 1 and 2 together: cannot remove; what they patch is a
// HAND EDIT of a generated block. scripts/vocabulary.mjs finds its block by
// those two markers and replaces what lies between them — so a marker deleted,
// duplicated or reordered makes the next `--write` overwrite the wrong span of
// convex/ttsShared.ts, and a version on the marker that disagrees with the one
// in the block makes `tts search define` answer from a schema whose name it is
// not. Neither is visible in a diff review: both read as ordinary edits.
//
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
        + `regenerate from a Jarvis checkout with \`node ${GENERATOR_PATH} --wikitom <dir> --tom-quest <this checkout> --write\``,
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
//    generated block and nowhere else under convex/ or scripts/ — a second
//    copy is a second vocabulary, and the one a prompt carries is whichever
//    file its builder imported.
// witness: paste the sentence into any convex/ source file.
{
  const outside = [];
  for (const file of [...sourceFiles("convex"), ...sourceFiles("scripts")]) {
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

// THERE IS NO CHECK 4 ANY MORE. It refused two names for the context graph,
// and the graph is deleted; one name per thing is what checks 1 to 3 keep for
// the closed vocabulary.

// REMOVAL CHECK for 5: cannot remove. The key is what the merge gate joins its
// three rows on, so a second spelling does not fail — it silently reads a
// DIFFERENT row, and the gate then allows or refuses a merge on another
// commit's checks. `commitKey` having one home is the fix; this is what keeps
// the second spelling from coming back, and the cycle that caused it once
// (ttsMerge imports EVALS_RUN from ttsEvals) is still there.
//
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

// THERE IS NO CHECK 6 ANY MORE. It compared the graph's two closed kind lists
// with the ones the graph module minted, and the graph is deleted. The number
// stays retired rather than reused, because the check numbers are shared with
// the Jarvis repository.

// ── The report ───────────────────────────────────────────────────────────────

for (const note of notes) console.log(`check-vocabulary: ${note}`);
if (failures.length > 0) {
  console.error("Vocabulary check FAILED:");
  for (const failure of failures) console.error("  - " + failure);
  process.exit(1);
}
console.log("check-vocabulary: the 4 in-repo checks passed; the render checks run in the nightly");
