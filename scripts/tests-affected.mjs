// tests-affected.mjs — the vitest run CI owes this commit, and why.
// NO SHEBANG LINE, for check-writing-standard.mjs's reason: the test beside it
// imports this file. Every caller names the interpreter
// (`node scripts/tests-affected.mjs`).
//
// TEST IMPACT ANALYSIS, the industry practice: a pull request runs the tests
// the import graph says its diff can reach, and nothing else; main and the
// nightly run everything. vitest already has the graph — `--changed <base>`
// diffs against that commit and walks its module graph — so this file owns
// exactly one decision, WHICH MODE, and hands the rest to vitest.
//
// NO TEST IS DROPPED. Affected-only is a claim about the graph, and the graph
// knows only what is imported. Every change the graph cannot see falls back to
// the whole suite (decideMode below says which three those are), so the worst
// this can do is run more than it had to.
//
// Environment: none. Arguments: --base <sha>, --summary <path>, --mode <mode>.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The two modes, which are the two words the row, the log and docs/tests.md
 *  all use. */
export const FULL = "full";
export const RELATED = "related";

/**
 * The extensions vitest's module graph can follow. A changed file with any
 * other extension is a file a test may READ OFF DISK — vqc/todos.yaml,
 * tts/vocabulary.json, an AGENTS.md, sg/baseline.tsv, worker/setup.sh — and no
 * import graph has ever seen that edge. Those changes take the whole suite.
 *
 * THIS IS ALSO WHY THE LIST BELOW IS SHORT. package.json, pnpm-lock.yaml,
 * tsconfig.json and .github/workflows/*.yml are each wide enough to invalidate
 * every test, and each is already caught here by its extension.
 */
export const GRAPH_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
]);

/**
 * The files that carry a graph extension and that no test imports, while every
 * test depends on them: the vitest configuration decides the environment,
 * the aliases and the exclude list, and the Next configuration decides what
 * `pnpm build` even compiles. A change to either is invisible to `--changed`
 * and changes every answer.
 */
export const WIDE_PATHS = new Set(["vitest.config.mts", "next.config.ts"]);

/**
 * WHICH MODE, and the sentence that says why — the sentence lands on the
 * `tests-run` row, so a branch that paid for the whole suite says what bought
 * it.
 *
 * `changed` is `{ path, deleted }` per changed file. Four things force the
 * whole suite, and each is a thing the graph cannot answer:
 *   1. no base commit, so there is no diff to reason about at all;
 *   2. a deleted path, whose dependents the graph can no longer name;
 *   3. a changed file the graph cannot follow (GRAPH_EXTENSIONS above);
 *   4. a changed file nothing imports and everything depends on (WIDE_PATHS).
 * An empty diff is `related` with nothing to run, which is the honest answer
 * rather than a free full suite.
 */
export function decideMode(changed, { base = null } = {}) {
  if (base === null || base === "") {
    return { mode: FULL, why: "no merge base, so the diff is unknown", files: [] };
  }
  const deleted = changed.find((entry) => entry.deleted);
  if (deleted !== undefined) {
    return {
      mode: FULL,
      why: `${deleted.path} was deleted, and the graph cannot name what imported it`,
      files: [],
    };
  }
  const wide = changed.find((entry) => WIDE_PATHS.has(entry.path));
  if (wide !== undefined) {
    return { mode: FULL, why: `${wide.path} changes every test's answer`, files: [] };
  }
  const opaque = changed.find((entry) => !GRAPH_EXTENSIONS.has(path.extname(entry.path)));
  if (opaque !== undefined) {
    return {
      mode: FULL,
      why: `${opaque.path} is read off disk, not imported, so no graph can reach it`,
      files: [],
    };
  }
  return {
    mode: RELATED,
    why: `${changed.length} changed file${changed.length === 1 ? "" : "s"}, all in the module graph`,
    files: changed.map((entry) => entry.path),
  };
}

/**
 * The changed files, as `{ path, deleted }` rows.
 *
 * THE SAME THREE QUESTIONS VITEST ASKS, and that is the point: vitest's
 * `--changed <base>` unions the committed diff, the staged files and the
 * unstaged ones, so a decision made on any narrower set is a decision about a
 * run that did not happen. CI's tree is clean and only the first question
 * answers there, but a mode chosen from a different file list than the one
 * vitest runs on is a mismatch that says nothing when it happens.
 *
 * THREE DOTS on the committed half, for the reason `git diff BASE...HEAD` is
 * spelled that way in scripts/evals-check.mjs: the diff against the MERGE BASE
 * is what a pull request proposes, and two dots would call every file main
 * moved on since the branch opened a change of this branch's.
 */
export function changedFiles(base, run = git) {
  const rows = [
    ...statusRows(run(["diff", "--name-status", `${base}...HEAD`])),
    ...statusRows(run(["diff", "--cached", "--name-status"])),
    // `ls-files` has no status column: a path it names that is gone from the
    // disk is a deletion, and one that is there is a change.
    ...lines(run(["ls-files", "--other", "--modified", "--exclude-standard"])).map((path) => ({
      path,
      deleted: !existsSync(path),
    })),
  ];
  const seen = new Set();
  return rows.filter((row) => (seen.has(row.path) ? false : seen.add(row.path)));
}

const lines = (text) =>
  text.split("\n").map((line) => line.trim()).filter((line) => line !== "");

function statusRows(text) {
  return lines(text).map((line) => {
    const [status, ...rest] = line.split(/\s+/);
    // A rename is `R100\told\tnew`. Its old path is a deletion, which rule 2
    // already answers through the new path's own row being a change, so the
    // row this keeps is the one naming where the file is now.
    return { path: rest[rest.length - 1], deleted: status.startsWith("D") };
  });
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

/** The N slowest files of a vitest json report, seconds each. The warning in
 *  convex/ttsMerge.ts names them, so a slow suite arrives with the reason
 *  rather than with a number. */
export function slowestOf(report, limit = 5) {
  const results = Array.isArray(report?.testResults) ? report.testResults : [];
  return results
    .map((result) => ({
      file: String(result.name ?? "").replace(`${process.cwd()}${path.sep}`, "").replaceAll("\\", "/"),
      seconds: Math.round(((result.endTime ?? 0) - (result.startTime ?? 0)) / 100) / 10,
    }))
    .filter((entry) => entry.file !== "")
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, limit);
}

function argOf(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 || at + 1 >= argv.length ? null : argv[at + 1];
}

function main(argv) {
  // `--base ""` is what a push event hands this, since a push has no merge
  // base to name. Normalised to null HERE, before the diff is asked for, so
  // `git diff ...HEAD` is never run with an empty left side.
  const base = (argOf(argv, "--base") ?? "").trim() || null;
  const summaryPath = argOf(argv, "--summary");
  // `--mode full` is how the main and nightly runs say so without a diff: they
  // have no base to compare against and want everything regardless.
  const forced = argOf(argv, "--mode");
  const decision = forced === FULL
    ? { mode: FULL, why: "main and the nightly run every test", files: [] }
    : decideMode(base === null ? [] : changedFiles(base), { base });

  const reportDir = mkdtempSync(path.join(tmpdir(), "tests-affected-"));
  const reportPath = path.join(reportDir, "vitest.json");
  const args = [
    "vitest",
    "run",
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${reportPath}`,
  ];
  // `--passWithNoTests` because a diff can touch only files no test imports,
  // and "this change reaches no test" is an answer rather than a failure.
  if (decision.mode === RELATED) args.push("--changed", base, "--passWithNoTests");

  process.stderr.write(`tests: ${decision.mode} — ${decision.why}\n`);
  const started = Date.now();
  let ok = true;
  try {
    execFileSync("npx", args, { stdio: "inherit" });
  } catch {
    ok = false;
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;

  let slowest = [];
  try {
    slowest = slowestOf(JSON.parse(readFileSync(reportPath, "utf8")));
  } catch {
    // A run that died before writing its report still has a mode, a file count
    // and a duration, and those are the facts the row is for.
  }
  rmSync(reportDir, { recursive: true, force: true });

  const summary = {
    mode: decision.mode,
    why: decision.why,
    files: decision.files.length,
    seconds,
    ok,
    slowest,
  };
  if (summaryPath !== null) writeFileSync(summaryPath, `${JSON.stringify(summary)}\n`);
  process.stderr.write(`tests: ${seconds}s, ${ok ? "green" : "red"}\n`);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith("tests-affected.mjs")) main(process.argv.slice(2));
