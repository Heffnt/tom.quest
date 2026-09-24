// check-removals.mjs — a change that adds a complexity smell fails, and the
// committed count of them only goes down.
// NO SHEBANG LINE, for check-writing-standard.mjs's reason: the test beside it
// imports this file. Every caller names the interpreter (`pnpm
// check:guardrails` runs `node scripts/check-removals.mjs`).
//
// WHAT IT GATES. scripts/removal-sensor.mjs measures four smells and
// sg/baseline.tsv is the committed list of the ones already there. A smell
// that is live and NOT in that list is new, and this exits 1 naming the rule,
// the file and what to do. One that is in the list and no longer live has been
// fixed: it is printed, and the next regeneration drops its line.
//
// THE RATCHET, the shape scripts/check-writing-standard.mjs has, with one
// difference: that check reads prod Convex and so gates nothing, while this one
// reads only the checkout and IS a gate — it runs inside `pnpm
// check:guardrails`, which is the Guardrails workflow's static-boundaries job.
//
// WHY THE BASELINE IS ALSO COMPARED WITH main's. The file is regenerated, not
// hand-edited, and a regeneration would happily write a new smell into it —
// after which "live and not in the baseline" is empty and the gate passes a
// change that made the number go up. So the checkout's list must be a subset
// of main's. Main's list can only shrink (every change into it passed this
// same test), so a stale local `main` is a LARGER list and never a false
// failure. Where no main is readable at all — a first commit, a bare tarball —
// the comparison is skipped and says so; CI fetches main before it runs.
//
// NO ast-grep IS A FAILURE, loudly. The alternative, passing when the tool is
// absent, is a gate that opens whenever the machine is wrong. CI installs it
// (.github/workflows/guardrails.yml) and the Jarvis repository's
// worker/setup.sh installs it on the Jarvis Box, both at the version named
// below.
//
// THE RULES ARE TESTED FIRST. `ast-grep test` holds each rule to its examples
// in sg/tests. A rule that silently stopped matching would read here as a
// clean repository, which is the one wrong answer this check cannot see
// otherwise.

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASELINE_PATH,
  baselineText,
  collect,
  diffAgainst,
  parseBaseline,
  realIo,
} from "./removal-sensor.mjs";

/** The version CI and the box install. A different ast-grep could parse one
 *  file differently and write a different baseline on each machine. */
export const AST_GREP_VERSION = "0.45.3";

/** What to do about each rule's violation, in one sentence. */
const REMEDY = Object.freeze({
  "duplicated-helper": "this body is written in another file too — import the one copy instead of writing it again",
  "dead-export": "no other file names this export — drop the export keyword, or delete it if nothing uses it",
  "flag-not-deletion": "no caller ever sets this option to its other value — delete the option and keep the default path",
  "check-not-deletion": "this guard repeats one that already decided the same thing — delete the second",
});

/** The refs main's baseline is read from, first readable wins. `origin/main`
 *  on a laptop and in CI; `main` in the box's bare mirror, where the remote's
 *  branches ARE the local ones. */
const MAIN_REFS = ["origin/main", "main"];

/**
 * The lines of `keys` that main's baseline lacks, less the ones a file move
 * explains. A move rewrites a line's path and nothing else: the rule and the
 * fingerprint (a hash of the matched text) stay, and so does the file's name.
 * So a new line is paired with a line main has and this baseline dropped, of
 * the same rule, fingerprint and basename; each old line pairs once. A paired
 * line is reported as moved; an unpaired one is still a new violation.
 */
export function movedAgainst(keys, onMain) {
  const mainSet = new Set(onMain);
  const keySet = new Set(keys);
  const left = onMain.filter((key) => !keySet.has(key));
  const grown = [];
  const moved = [];
  const partsOf = (key) => {
    const [rule, file, fingerprint] = key.split("\t");
    return { rule, fingerprint, base: path.posix.basename(file ?? "") };
  };
  for (const key of keys) {
    if (mainSet.has(key)) continue;
    const now = partsOf(key);
    const at = left.findIndex((old) => {
      const was = partsOf(old);
      return was.rule === now.rule && was.fingerprint === now.fingerprint && was.base === now.base;
    });
    if (at === -1) {
      grown.push(key);
    } else {
      moved.push([left[at], key]);
      left.splice(at, 1);
    }
  }
  return { grown, moved };
}

/**
 * The whole check, against an injected io. Returns the exit code and the
 * lines it printed, so the test reads both.
 */
export function checkRemovals(io) {
  const out = [];
  const err = [];

  const version = io.astGrepVersion();
  if (version === null) {
    err.push(
      `FAILED: ast-grep is not installed, so the removal check cannot run, and it does not pass without it. ` +
        `Install it with \`npm install -g @ast-grep/cli@${AST_GREP_VERSION}\` and run \`ast-grep --version\` ` +
        `(not \`sg\`, which is newgrp on Linux).`,
    );
    return { code: 1, out, err };
  }
  if (!version.includes(AST_GREP_VERSION)) {
    out.push(`note: ast-grep here is ${version.trim()}, CI runs ${AST_GREP_VERSION}; a baseline written here may not match CI's`);
  }

  const ruleTest = io.ruleTest();
  if (!ruleTest.ok) {
    err.push(`FAILED: a rule in sg/rules no longer matches its own examples in sg/tests:\n${ruleTest.output.trim()}`);
    return { code: 1, out, err };
  }

  const text = io.readBaseline();
  if (text === null) {
    err.push(`FAILED: ${BASELINE_PATH} is missing. Regenerate it with \`node scripts/removal-sensor.mjs --write-baseline\`.`);
    return { code: 1, out, err };
  }
  const keys = parseBaseline(text);
  if (text !== baselineText(keys)) {
    err.push(
      `FAILED: ${BASELINE_PATH} is not in the form the sensor writes — its header count, its order or a duplicate line ` +
        `was edited by hand. Regenerate it with \`node scripts/removal-sensor.mjs --write-baseline\`.`,
    );
    return { code: 1, out, err };
  }

  let code = 0;
  const main = io.mainBaseline();
  if (main === null) {
    out.push(`note: no main branch is readable here, so ${BASELINE_PATH} was not compared with main's`);
  } else {
    const { grown, moved } = movedAgainst(keys, parseBaseline(main));
    for (const [from, to] of moved) out.push(`moved: ${from} -> ${to.split("\t")[1]}`);
    for (const key of grown) {
      err.push(`FAILED: ${BASELINE_PATH} carries a line main's does not — the list was regenerated to admit a new violation: ${key}`);
    }
    if (grown.length > 0) {
      err.push("The baseline only moves down. Fix the violation instead of adding it; the lines above say which.");
      code = 1;
    }
  }

  const live = collect(io.sensor);
  const { added, dropped } = diffAgainst(live, keys);
  for (const v of added) {
    err.push(`FAILED: ${v.ruleId} in ${v.path} (line ${v.line}): ${REMEDY[v.ruleId] ?? "remove it"}.`);
  }
  if (added.length > 0) code = 1;
  for (const key of dropped) out.push(`gone: ${key}`);
  if (dropped.length > 0) {
    out.push(
      `${dropped.length} violation(s) in the baseline are no longer live. Regenerate it with ` +
        "`node scripts/removal-sensor.mjs --write-baseline` in the same commit as the work: that is how the ratchet tightens.",
    );
  }
  out.push(`removals: ${live.length} live, ${keys.length} in the baseline, ${added.length} new, ${dropped.length} gone`);
  return { code, out, err };
}

/** The real doors, at the repository root. */
function realCheckIo(root) {
  const sensor = realIo(root);
  const astGrep = (args) => {
    try {
      return { ok: true, output: sensor.astGrep(args) };
    } catch (error) {
      return { ok: false, missing: error.missing === true, output: error.message };
    }
  };
  return {
    sensor,
    astGrepVersion: () => {
      const result = astGrep(["--version"]);
      return result.ok ? result.output : null;
    },
    ruleTest: () => astGrep(["test", "--skip-snapshot-tests"]),
    readBaseline: () => {
      try {
        return sensor.readFile(BASELINE_PATH);
      } catch {
        return null;
      }
    },
    mainBaseline: () => {
      for (const ref of MAIN_REFS) {
        const shown = sensor.git(["show", `${ref}:${BASELINE_PATH}`]);
        if (shown.ok) return shown.stdout;
      }
      return null;
    },
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let result;
  try {
    result = checkRemovals(realCheckIo(root));
  } catch (error) {
    result = { code: 1, out: [], err: [`FAILED: the removal check could not run: ${error.message}`] };
  }
  for (const line of result.out) console.log(line);
  for (const line of result.err) console.error(line);
  process.exit(result.code);
}

