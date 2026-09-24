// removal-sensor.mjs — four complexity smells, measured structurally, one
// sorted line each.
// NO SHEBANG LINE, for check-writing-standard.mjs's reason: the test beside it
// imports this file, and the test bundler prepends an import that would land
// in front of a shebang. Every caller names the interpreter.
//
//   node scripts/removal-sensor.mjs                   # every violation, one line each
//   node scripts/removal-sensor.mjs --count           # per rule, and the total
//   node scripts/removal-sensor.mjs --diff            # against sg/baseline.tsv
//   node scripts/removal-sensor.mjs --write-baseline  # regenerate sg/baseline.tsv
//   node scripts/removal-sensor.mjs --json            # the records, estimates included
//
// WHAT IT MEASURES. Four of Tom's smells, each a rule in sg/rules/ run by
// ast-grep, a structural search over the syntax tree rather than over text:
//
//   duplicated-helper   the same helper written twice
//   dead-export         an export nothing outside its own file names
//   flag-not-deletion   a boolean option no caller ever sets
//   check-not-deletion  a guard that repeats a guard it cannot disagree with
//
// Out of band from eslint on purpose: an eslint finding is one inline comment
// away from silence, and nothing here reads a comment.
//
// HALF OF EACH RULE IS THE SYNTAX TREE AND HALF IS RESOLUTION, and each
// function below says which half it is. ast-grep finds the shapes; whether a
// name is imported elsewhere or a flag is ever passed is a question about
// OTHER files, which a single-file pattern cannot answer, so this script
// answers it with one batched `git grep`. The grep is an UPPER BOUND on use —
// a name that collides with an ordinary word counts as used — so every error
// it makes is the safe one: a violation missed, never a live thing reported
// dead.
//
// THE OUTPUT has no line numbers. A line is `<rule>\t<path>\t<fingerprint>`,
// the fingerprint eight hex characters of the matched thing's normalized text
// (or of its name, where the name is the identity). A baseline keyed on line
// numbers goes stale on every unrelated edit above the line.
//
// THE BINARY IS `ast-grep`, NOT `sg`. ast-grep ships both names, and on the
// Jarvis Box and every Debian or Ubuntu machine `/usr/bin/sg` is util-linux's
// newgrp, which would run a group shell instead of a search. The long name is
// the one that cannot be something else.
//
// Pure functions on top, every side effect in the one `io` object at the
// bottom, so removal-sensor.test.mjs runs with no ast-grep and no git.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hash8 } from "../shared/graph-hash.mjs";

// ── The numbers and the names ────────────────────────────────────────────────

/** The four rules, in the byte order the output sorts them. */
const RULE_IDS = Object.freeze([
  "check-not-deletion",
  "dead-export",
  "duplicated-helper",
  "flag-not-deletion",
]);

/** The trees the rules scan. Product code only: e2e/, evals/ and the root
 *  config files are fixtures or framework entry points, and tts/ is the
 *  declared scratch root (vqc/classification.yaml). Tests and generated code
 *  are excluded inside each rule's own `ignores`. */
const SCAN_ROOTS = Object.freeze(["app", "convex", "shared", "worker", "scripts", "vqc", "turing-api"]);

/** Where use is looked for: every tracked file except prose, the lockfile and
 *  the baseline itself. Tests are IN — a test is a caller, and a name only a
 *  test imports is not dead. Prose is OUT — a name only a README mentions is. */
const GREP_PATHSPEC = Object.freeze([
  ".",
  ":(exclude)*.md",
  ":(exclude)pnpm-lock.yaml",
  ":(exclude)sg/baseline.tsv",
]);

/** Names per `git grep` call. Fifty keeps one alternation well under any
 *  argument-length limit, the same batch worker/jobs/simplify.mjs grepCounts
 *  uses. */
const GREP_BATCH = 50;

/** The committed baseline, relative to the repository root. */
export const BASELINE_PATH = "sg/baseline.tsv";

/** The matched text a record carries for the actuator's prompt. Past four
 *  kilobytes a helper is long enough that the prompt should name it and let
 *  the run open the file. */
const TEXT_MAX_CHARS = 4_000;

/**
 * Exports a framework reads by name, so no file of ours ever imports them.
 * Only under app/: Next.js reads a route's `GET`, a page's `metadata` and the
 * rest off the module itself.
 */
const FRAMEWORK_EXPORTS = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
  "metadata", "generateMetadata", "viewport", "generateViewport",
  "generateStaticParams", "dynamic", "dynamicParams", "revalidate",
  "fetchCache", "runtime", "preferredRegion", "maxDuration",
  "alt", "size", "contentType",
]);

/**
 * The constructors that REGISTER a Convex function. A function built with one
 * is reached as `internal.<module>.<name>`, and Convex registers only what the
 * module exports — so an export only its own file calls is still load-bearing,
 * and deleting its `export` deletes the function from the deployment.
 */
const CONVEX_REGISTRARS = new Set([
  "query", "mutation", "action",
  "internalQuery", "internalMutation", "internalAction", "httpAction",
]);

// ── Small pure helpers ───────────────────────────────────────────────────────

/** Plain byte order for ASCII, which every path and rule id here is. Not
 *  localeCompare: a locale is a machine setting, and two machines must write
 *  the same file. */
export function byteCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A path as the output spells it: repository-relative and forward-slashed on
 *  every platform, the form findAgentsFiles in worker/jobs/simplify.mjs
 *  writes. */
export function repoPath(file) {
  return String(file).split("\\").join("/").replace(/^\.\//, "");
}

/**
 * A matched node's text with comments dropped and every run of whitespace one
 * space, so that two copies differing only in indentation or commentary are
 * one text. The comment strip is lexical and can eat a `//` inside a string;
 * it eats it identically in both copies, which is all an identity needs.
 */
export function normalizeText(text) {
  return String(text ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** A name safe inside an extended regular expression. Identifiers may carry
 *  `$`, which is an anchor there. */
function escapeName(name) {
  return name.replace(/[$]/g, "\\$");
}

/** The regular expression for a name as a whole word, `$` counted as a word
 *  character the way JavaScript counts it. */
function wordRe(name) {
  return new RegExp(`(?<![\\w$])${escapeName(name)}(?![\\w$])`);
}

/** Parse ast-grep's `--json=stream`: one JSON object per line. */
function parseMatches(stdout) {
  const matches = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const raw = JSON.parse(line);
    matches.push({
      ruleId: raw.ruleId,
      path: repoPath(raw.file),
      text: String(raw.text ?? ""),
      startLine: (raw.range?.start?.line ?? 0) + 1,
      endLine: (raw.range?.end?.line ?? 0) + 1,
      name: raw.metaVariables?.single?.NAME?.text ?? null,
    });
  }
  return matches;
}

/** One violation record. `lines` and `files` are the ESTIMATE of what removing
 *  it touches, which the controller ranks on; they are carried here, measured
 *  at collection time, so the controller parses nothing. */
function violation(ruleId, match, fingerprint, lines, files) {
  return {
    ruleId,
    path: match.path,
    fingerprint,
    lines,
    files,
    line: match.startLine,
    text: match.text.slice(0, TEXT_MAX_CHARS),
  };
}

// ── duplicated-helper ────────────────────────────────────────────────────────

/**
 * THE TREE HALF: the rule matches every function body of six or more
 * statements (comments not counted). THIS HALF: the bodies whose normalized
 * text appears in two or more FILES. Two copies inside one file are a
 * different smell and not this one.
 *
 * One line per file carrying the copy, all sharing one fingerprint, so a
 * removal that keeps one copy and imports it drops every line but one's
 * sibling — and the pair disappears whole, since one copy is no duplicate.
 */
function duplicatedHelpers(matches) {
  const byBody = new Map();
  for (const match of matches) {
    if (match.ruleId !== "duplicated-helper") continue;
    const key = normalizeText(match.text);
    if (!byBody.has(key)) byBody.set(key, []);
    byBody.get(key).push(match);
  }
  const found = [];
  for (const [body, copies] of byBody) {
    const files = new Set(copies.map((copy) => copy.path));
    if (files.size < 2) continue;
    const fingerprint = hash8(body);
    for (const copy of copies) {
      found.push(violation("duplicated-helper", copy, fingerprint, copy.endLine - copy.startLine + 1, files.size));
    }
  }
  return found;
}

// ── dead-export ──────────────────────────────────────────────────────────────

/**
 * The name an export statement declares, off its first line. The rule has
 * already said this node IS an export of a function, a const, a type or an
 * interface; this reads which name, and answers null for a default export or
 * a destructuring export, which have no single name to look for.
 */
export function exportName(text) {
  const m =
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|type|interface)\s+([A-Za-z_$][\w$]*)/.exec(
      String(text ?? ""),
    );
  return m ? m[1] : null;
}

/** The callee an `export const x = callee(` statement is built by, or null. */
export function registrarOf(text) {
  const m = /^export\s+const\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*([A-Za-z_$][\w$]*)\s*\(/.exec(String(text ?? ""));
  return m ? m[1] : null;
}

/**
 * Which files mention each name as a whole word, by one `git grep` per batch.
 * `git grep` EXITS 1 WHEN NOTHING MATCHED; that is the answer "no file", not a
 * failure (grepCounts in worker/jobs/simplify.mjs, the same rule). Any other
 * failure throws: a grep that did not run would otherwise report every export
 * in the repository dead.
 */
function filesMentioning(names, io) {
  const unique = [...new Set(names)].sort(byteCompare);
  const mentions = new Map(unique.map((name) => [name, []]));
  for (let at = 0; at < unique.length; at += GREP_BATCH) {
    const batch = unique.slice(at, at + GREP_BATCH);
    // --untracked, because ast-grep scans every file .gitignore does not
    // exclude: without it a new file's matches would be seen and its uses
    // would not, and everything a new test imports would read as dead.
    const result = io.git(["grep", "--untracked", "-n", "-w", "-E", batch.map(escapeName).join("|"), "--", ...GREP_PATHSPEC]);
    if (!result.ok && result.status !== 1) {
      throw new Error(`git grep failed for ${batch.length} name(s): ${String(result.error ?? "").slice(0, 200)}`);
    }
    const tests = batch.map((name) => [name, wordRe(name)]);
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line === "") continue;
      // path:line:text. The path is kept, because use is a question of WHICH
      // file; the test runs on the text, so a directory named like the export
      // does not count as a use of it.
      const first = line.indexOf(":");
      const second = line.indexOf(":", first + 1);
      if (first === -1 || second === -1) continue;
      const file = repoPath(line.slice(0, first));
      const text = line.slice(second + 1);
      for (const [name, test] of tests) if (test.test(text)) mentions.get(name).push({ file, text });
    }
  }
  return mentions;
}

/**
 * THE TREE HALF: the rule matches every export of a function, a const, a type
 * or an interface. THIS HALF: those whose name no OTHER file mentions.
 */
function deadExports(matches, io) {
  const declared = [];
  for (const match of matches) {
    if (match.ruleId !== "dead-export") continue;
    const name = exportName(match.text);
    if (name === null) continue;
    if (match.path.startsWith("app/") && FRAMEWORK_EXPORTS.has(name)) continue;
    if (match.path.startsWith("convex/") && CONVEX_REGISTRARS.has(registrarOf(match.text))) continue;
    declared.push({ match, name });
  }
  const mentions = filesMentioning(declared.map((d) => d.name), io);
  const found = [];
  for (const { match, name } of declared) {
    const elsewhere = (mentions.get(name) ?? []).some((m) => m.file !== match.path);
    if (elsewhere) continue;
    found.push(violation("dead-export", match, hash8(`export ${name}`), match.endLine - match.startLine + 1, 1));
  }
  return found;
}

// ── flag-not-deletion ────────────────────────────────────────────────────────

/**
 * The flag a match names and the value it holds when nobody passes it. The
 * rule matched either a destructured parameter default (`{ force = false }`)
 * or an `options.x === true` guard, whose default is "not true".
 */
export function flagOf(match) {
  const assigned = /^([A-Za-z_$][\w$]*)\s*=\s*(true|false)$/.exec(match.text.trim());
  if (assigned) return { name: assigned[1], fallback: assigned[2] };
  if (match.name) return { name: match.name, fallback: "false" };
  return null;
}

/**
 * Whether one line SETS the flag to something other than its default. The
 * shapes, each an upper bound:
 *   `name: <anything but the default>`   an object property
 *   `{ name }`, `, name,` or a line      a shorthand property, or a
 *   holding only `name,`                 destructuring that could be one
 *   `.name = <anything>`                 an assignment onto an options object
 *   `name={…}` or a bare `name`          a JSX attribute, in .tsx/.jsx only
 * A spread (`{ ...options }`) cannot be seen from here; the run that removes a
 * flag is told so, and the typecheck and the tests are what catch it.
 */
export function setsFlag(line, file, { name, fallback }) {
  const n = escapeName(name);
  const property = new RegExp(`(?<![\\w$])${n}\\s*:\\s*(?!${fallback}\\b)(?!boolean\\b)[^\\s,}]`);
  const shorthand = new RegExp(`[{,]\\s*${n}\\s*[,}]|^\\s*${n}\\s*,?\\s*$`);
  const assignment = new RegExp(`\\.${n}\\s*=(?!=)`);
  if (property.test(line) || shorthand.test(line) || assignment.test(line)) return true;
  if (/\.(tsx|jsx)$/.test(file)) {
    const attribute = new RegExp(`(^|\\s)${n}(=\\{(?!${fallback}\\})|\\s*$|\\s+[A-Za-z/>]|/?>)`);
    if (attribute.test(line)) return true;
  }
  return false;
}

/**
 * THE TREE HALF: the rule matches boolean parameter defaults and
 * `options.x === true` guards. THIS HALF: the flags no line anywhere sets to
 * their other value. One line per (file, flag name): the resolution is by
 * name, so two `force` defaults in one file get one answer and one line.
 */
function neverSetFlags(matches, io) {
  const flags = [];
  for (const match of matches) {
    if (match.ruleId !== "flag-not-deletion") continue;
    const flag = flagOf(match);
    if (flag !== null) flags.push({ match, ...flag });
  }
  const mentions = filesMentioning(flags.map((f) => f.name), io);
  const found = [];
  const seen = new Set();
  for (const flag of flags) {
    const key = `${flag.match.path}\t${flag.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lines = mentions.get(flag.name) ?? [];
    if (lines.some((m) => setsFlag(m.text, m.file, flag))) continue;
    const ownLines = lines.filter((m) => m.file === flag.match.path).length;
    const files = new Set(lines.map((m) => m.file)).size;
    found.push(violation("flag-not-deletion", flag.match, hash8(`flag ${flag.name}`), Math.max(1, ownLines), Math.max(1, files)));
  }
  return found;
}

// ── check-not-deletion ───────────────────────────────────────────────────────

/**
 * THE TREE HALF IS THE WHOLE RULE. `a && a`, `a || a`, `a ? a : a`, an `if`
 * whose first statement is the same `if`, and an `if` repeating the one before
 * it that returned or threw. Deliberately the narrowest of the four: the half
 * of this smell that is "a check the TYPE already settled" needs the type
 * checker, which a syntax tree does not have, and is not measured at all.
 */
function repeatedGuards(matches) {
  return matches
    .filter((match) => match.ruleId === "check-not-deletion")
    .map((match) =>
      violation("check-not-deletion", match, hash8(normalizeText(match.text)), match.endLine - match.startLine + 1, 1),
    );
}

// ── The whole measurement ────────────────────────────────────────────────────

/** Every violation, deduplicated on its output key and sorted. */
export function collect(io) {
  const matches = parseMatches(io.astGrep(["scan", "--json=stream", ...SCAN_ROOTS]));
  const all = [
    ...duplicatedHelpers(matches),
    ...deadExports(matches, io),
    ...neverSetFlags(matches, io),
    ...repeatedGuards(matches),
  ];
  const byKey = new Map();
  for (const v of all) {
    const key = keyOf(v);
    // Two matches on one key are one violation. The earlier line is kept, so
    // the record the prompt quotes does not depend on ast-grep's thread order.
    const held = byKey.get(key);
    if (held === undefined || v.line < held.line) byKey.set(key, v);
  }
  return [...byKey.values()].sort(compareViolations);
}

/** The output line's three fields, which are the violation's identity. */
export function keyOf(v) {
  return `${v.ruleId}\t${v.path}\t${v.fingerprint}`;
}

function compareViolations(a, b) {
  return byteCompare(a.ruleId, b.ruleId) || byteCompare(a.path, b.path) || byteCompare(a.fingerprint, b.fingerprint);
}

/** Per rule and in total, every rule present even at zero: a rule that found
 *  nothing and a rule that did not run must not print the same thing. */
export function countByRule(violations) {
  const counts = Object.fromEntries(RULE_IDS.map((id) => [id, 0]));
  for (const v of violations) counts[v.ruleId] = (counts[v.ruleId] ?? 0) + 1;
  return { counts, total: violations.length };
}

/** The baseline file's whole text, from violation keys. Byte-identical for
 *  the same set whatever order it arrives in, which is also how
 *  check-removals.mjs tells a regenerated file from a hand-edited one. */
export function baselineText(keysIn) {
  const keys = [...new Set(keysIn)].sort(byteCompare);
  return `# ${keys.length} violations, regenerated by the removal loop; do not edit by hand\n${keys.map((k) => `${k}\n`).join("")}`;
}

/** The keys a baseline holds, header and blank lines skipped. */
export function parseBaseline(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** What moved against a baseline: live and not in it, in it and not live. */
export function diffAgainst(violations, baselineKeys) {
  const base = new Set(baselineKeys);
  const live = new Set(violations.map(keyOf));
  return {
    added: violations.filter((v) => !base.has(keyOf(v))),
    dropped: [...base].filter((key) => !live.has(key)).sort(byteCompare),
  };
}

// ── The doors ────────────────────────────────────────────────────────────────

function runCommand(command, args, cwd) {
  try {
    const stdout = String(
      execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }),
    );
    return { ok: true, status: 0, stdout, error: null };
  } catch (error) {
    return {
      ok: false,
      status: error?.status ?? null,
      stdout: String(error?.stdout ?? ""),
      error: error?.code === "ENOENT" ? `${command} is not installed` : String(error?.stderr || error?.message || error),
      missing: error?.code === "ENOENT",
    };
  }
}

/** Every side effect this script has, rooted at one checkout. */
export function realIo(root) {
  return {
    root,
    astGrep: (args) => {
      const result = runCommand("ast-grep", args, root);
      if (!result.ok) {
        const error = new Error(`ast-grep ${args[0]} failed: ${result.error}`);
        error.missing = result.missing === true;
        throw error;
      }
      return result.stdout;
    },
    git: (args) => runCommand("git", args, root),
    readFile: (file) => fs.readFileSync(path.join(root, file), "utf8"),
    writeFile: (file, text) => fs.writeFileSync(path.join(root, file), text),
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const io = realIo(root);
  const violations = collect(io);

  if (argv.includes("--write-baseline")) {
    io.writeFile(BASELINE_PATH, baselineText(violations.map(keyOf)));
    console.log(`${BASELINE_PATH}: ${violations.length} violations written`);
    return;
  }
  if (argv.includes("--count")) {
    const { counts, total } = countByRule(violations);
    for (const id of RULE_IDS) console.log(`${id}\t${counts[id]}`);
    console.log(`total\t${total}`);
    return;
  }
  if (argv.includes("--diff")) {
    let baseline = "";
    try {
      baseline = io.readFile(BASELINE_PATH);
    } catch {
      console.log(`${BASELINE_PATH} is not there; every violation is new`);
    }
    const { added, dropped } = diffAgainst(violations, parseBaseline(baseline));
    for (const v of added) console.log(`+ ${keyOf(v)}`);
    for (const key of dropped) console.log(`- ${key}`);
    console.log(`${added.length} new, ${dropped.length} gone`);
    return;
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify(violations));
    return;
  }
  for (const v of violations) console.log(keyOf(v));
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`removal-sensor: ${error.message}`);
    process.exit(1);
  }
}
