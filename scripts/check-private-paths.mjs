// Path-level privacy guard for this public repository. The private source pages
// and their area trigger cases belong in WikiTom, never in tom.Quest.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

// Keep this in step with search-lib.mjs: the laptop wrapper supplies this
// default, while the box reads WIKITOM_DIR before using its own default.
export const LAPTOP_WIKITOM_DIR = "C:/Users/heffn/Desktop/WikiTom";
export const BOX_WIKITOM_DIR = "/root/wikitom";

/** The terms of one `categories:` line, lowercased, as a set. */
export function categoryTerms(line) {
  const value = line.slice("categories:".length).trim();
  const unwrapped = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return new Set(unwrapped.split(",").map((term) => term.trim().toLowerCase()).filter(Boolean));
}

// The tokens a copied list survives as. `-`, `_` and `.` stay INSIDE a token,
// so `agent-systems` and `tom.quest` are one term each; commas, brackets,
// quotes, newlines and every other character separate two tokens.
const TOKEN = /[\p{L}\p{N}_.-]+/gu;
// What sits between two terms of a LIST rather than between two words of a
// sentence: the punctuation of an array, a frontmatter line, a table row, or a
// row of its own. Ordinary prose that happens to run three terms together
// ("**ComplexMultiTrigger** research campaign") therefore does not match.
const LIST_GAP = /[,;|[\]{}"'\n\r]/;

/**
 * THREE TERMS TOGETHER MEANS AN ENUMERATION, not three words in a paragraph.
 * A copied `categories:` line — in frontmatter, in a fixture array, in a
 * quoted string, one per row — puts its terms next to each other with nothing
 * but punctuation between them, and that is what this looks for.
 *
 * The looser "anywhere on the same line" reading cannot be used here: the
 * agent-systems page names this repository's own public vocabulary, so that
 * rule fails on the repository's own prose about itself, and a check everyone
 * has to override is a check nobody reads.
 *
 * One pass serves every category at once, because a file is read once and some
 * tracked files are large.
 */
export function hasCategoryRun(text, categories) {
  const body = String(text);
  const runs = categories.map(() => new Set());
  let end = 0;
  let listGap = false;
  for (const match of body.matchAll(TOKEN)) {
    listGap = listGap || LIST_GAP.test(body.slice(end, match.index));
    end = match.index + match[0].length;
    const token = match[0].replace(/^[.-]+|[.-]+$/g, "").toLowerCase();
    // A run of punctuation alone — a bullet, a rule — separates two terms
    // without ending the gap it sits in.
    if (token === "") continue;
    for (let index = 0; index < categories.length; index += 1) {
      const run = runs[index];
      if (!categories[index].terms.has(token)) {
        run.clear();
        continue;
      }
      // A term reached across plain prose starts a run of its own instead of
      // extending the one before it.
      if (!listGap) run.clear();
      run.add(token);
      if (run.size >= 3) return true;
    }
    listGap = false;
  }
  return false;
}

// Tracked bytes that are not text carry no copied line; reading them as UTF-8
// only wastes the check's time.
// The extensions whose bytes are not prose. `.bin` earns its place by size
// rather than by kind: public/data/clouds/train.bin is 51 MB, and a content
// rule that slides a window over it spends nine tenths of this check there,
// looking for English in a point cloud.
const BINARY = /\.(?:png|jpe?g|gif|ico|icns|bmp|webp|avif|svgz|pdf|zip|gz|mp[34]|wav|webm|mov|woff2?|ttf|otf|eot|wasm|bin)$/i;

/** Read just the frontmatter category lines; page bodies never enter this check. */
export function wikiTomCategoryLines(root, { exists = existsSync, readdir = readdirSync, readFile = readFileSync } = {}) {
  const areaDir = path.join(root, "model-of-tom", "areas");
  if (!exists(areaDir)) return null;
  const lines = [];
  for (const entry of readdir(areaDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const category = readFile(path.join(areaDir, entry.name), "utf8").split(/\r?\n/).find((line) => line.startsWith("categories:"));
    if (category !== undefined) lines.push(category);
  }
  return lines.sort((a, b) => a.localeCompare(b));
}

/**
 * EVERY 40-CHARACTER WINDOW OF THE OPERATE PAGE, not its whole lines.
 *
 * The first version of this took whole lines and asked whether each appeared in
 * a tracked file. That caught four copies and missed ten more, because the way
 * operate text actually leaks is as a FRAGMENT: a rule truncated to fit a
 * fixture, or quoted mid-sentence in a comment. A 44-character piece of a
 * 136-character rule is a copy by any reading, and a whole-line check cannot
 * see it.
 *
 * So each line is cut into EVERY 40-character window of itself. FORTY IS THE
 * FLOOR because below it headings and generic clauses collide with prose any
 * file might legitimately write for itself.
 *
 * THE STEP IS ONE, AND IT HAS TO BE. A step of n only guarantees catching a
 * shared fragment of 40 + n - 1 characters: at a step of eight, a 44-character
 * piece of a rule can sit between two windows and be missed, which is exactly
 * what happened the first time this was measured - the planted fragment the
 * rule exists for went through clean. A step of one is the rule as stated,
 * every 40-character substring, with no fragment length that slips past.
 *
 * IT COSTS ALMOST NOTHING. The set goes from ~600 entries to ~4,300, and the
 * scan asks one Set lookup per position of the FILE either way, so the work is
 * the tree's size and not the set's.
 *
 * BOUNDED BY THE PAGE, NOT BY THE TREE: a 7 KB operate page yields ~4,300
 * windows whatever the repository does.
 */
export const OPERATE_LINE_MIN = 40;
export const OPERATE_WINDOW_STEP = 1;
export function operateWindows(root, { exists = existsSync, readFile = readFileSync } = {}) {
  const file = path.join(root, "model-of-tom", "agent-rules.md");
  if (!exists(file)) return null;
  const windows = new Set();
  for (const raw of readFile(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length < OPERATE_LINE_MIN) continue;
    for (let at = 0; at + OPERATE_LINE_MIN <= line.length; at += OPERATE_WINDOW_STEP) {
      windows.add(line.slice(at, at + OPERATE_LINE_MIN));
    }
    windows.add(line.slice(-OPERATE_LINE_MIN));
  }
  return [...windows];
}

/** Whether one file's text carries a category line, or three of one line's
 * terms as a list. */
function hitsCategory(text, categories) {
  return categories.some(({ line }) => text.includes(line)) || hasCategoryRun(text, categories);
}

/** Whether one file's text carries any 40-character window of the operate page.
 * Slides the window over the FILE once and asks a Set, rather than asking
 * `includes` for each of ~600 windows: the first costs the file's bytes, the
 * second costs them six hundred times. */
function hitsOperate(text, wanted) {
  for (let at = 0; at + OPERATE_LINE_MIN <= text.length; at += 1) {
    if (wanted.has(text.slice(at, at + OPERATE_LINE_MIN))) return true;
  }
  return false;
}

/**
 * Both content rules, over ONE read of each tracked file.
 *
 * They used to be two walks, and the tree was read twice: on this repository
 * that was about ten seconds each, nearly all of it Windows file I/O rather
 * than matching. Reading once and asking both questions costs one of those.
 * Terms and windows are read from WikiTom and never written anywhere - only the
 * offending file name is ever printed.
 */
export function contentFindings(tracked, { categoryLines = null, windows = null } = {}, { readFile = readFileSync, cwd = process.cwd() } = {}) {
  const categories = categoryLines === null ? null : categoryLines.map((line) => ({ line, terms: categoryTerms(line) }));
  const wanted = windows === null ? null : new Set(windows);
  const findings = [];
  for (const raw of tracked) {
    const file = normalizeTrackedPath(raw);
    if (BINARY.test(file)) continue;
    let text;
    try {
      text = readFile(path.resolve(cwd, file), "utf8");
    } catch {
      // A tracked path this process cannot read is not evidence of a copy.
      continue;
    }
    if (typeof text !== "string") continue;
    if (categories !== null && hitsCategory(text, categories)) {
      findings.push({ file, rule: "WikiTom area-category content" });
    }
    if (wanted !== null && hitsOperate(text, wanted)) {
      findings.push({ file, rule: "model-of-tom operate content" });
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
}

/** Every tracked file that carries a `categories:` line verbatim, or three of
 * one line's terms as a list. */
export function categoryContentFindings(tracked, categoryLines, options = {}) {
  return contentFindings(tracked, { categoryLines }, options);
}

/** Every tracked file carrying any window of the operate page. The Never list
 * has no carve-out for a line that reads as generic, so neither does this: a
 * fixture wanting that shape writes its own words. */
export function operateContentFindings(tracked, windows, options = {}) {
  return contentFindings(tracked, { windows }, options);
}

export function wikiTomRoot({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const root = env.WIKITOM_DIR || (platform === "win32" ? LAPTOP_WIKITOM_DIR : BOX_WIKITOM_DIR);
  return exists(path.join(root, "model-of-tom", "areas")) ? root : null;
}

export function checkPrivatePaths(run = execFileSync, { notice = () => {}, root = wikiTomRoot(), fs, cwd } = {}) {
  const tracked = trackedFiles(run);
  const findings = privatePathFindings(tracked);
  // A checkout with no area page carries no line to compare, and a check with
  // nothing to compare must say so rather than pass silently.
  const categoryLines = root === null ? null : wikiTomCategoryLines(root, fs);
  const operate = root === null ? null : operateWindows(root, fs);
  if (categoryLines === null || categoryLines.length === 0) {
    notice("private-paths: WikiTom checkout unavailable; area-category content check skipped\n");
  }
  if (operate === null || operate.length === 0) {
    notice("private-paths: WikiTom checkout unavailable; operate content check skipped\n");
  }
  return [
    ...findings,
    ...contentFindings(
      tracked,
      {
        categoryLines: categoryLines !== null && categoryLines.length > 0 ? categoryLines : null,
        windows: operate !== null && operate.length > 0 ? operate : null,
      },
      { ...fs, cwd },
    ),
  ].sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
}

function main() {
  const findings = checkPrivatePaths(execFileSync, { notice: (line) => process.stderr.write(line) });
  if (findings.length === 0) return;
  for (const finding of findings) process.stderr.write(`private-paths: ${finding.file} (${finding.rule})\n`);
  process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
