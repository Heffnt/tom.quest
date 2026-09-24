// worker-env.mjs — the ONE reader of /etc/tts/worker.env, shared by the cron
// jobs (worker/jobs/) and the session-host daemon (worker/session-host/).
// Plain Node ESM, zero npm dependencies, node:fs only — same rule as the rest
// of the Jarvis Box's code.
//
// WHY THIS FILE IS REACHED THROUGH A SYMLINK. setup.sh installs the two
// directories to different depths on the box:
//
//     cp worker/jobs/*.mjs          /opt/tts/
//     cp worker/session-host/*.mjs  /opt/tts/session-host/
//
// so an import spelled "../jobs/worker-env.mjs" resolves in a repo checkout
// and DANGLES after install (there is no /opt/tts/jobs/). The fix that keeps
// one editable body: worker/session-host/worker-env.mjs is a checked-in
// symlink to this file. Node resolves it to this body in the repo, and
// setup.sh's plain `cp` follows the link, so each install dir gets its own
// flat copy while the repo keeps exactly one file to edit. (The repo already
// uses this device for CLAUDE.md -> AGENTS.md.)
// scripts/check-session-mirrors.mjs fails the build if that link is ever
// replaced by a second real file.

import fs from "node:fs";

export const ENV_PATH = "/etc/tts/worker.env";

/**
 * Read the worker env file: KEY=VALUE lines, with '#' comments and blank
 * lines ignored, an optional leading "export " stripped, and one layer of
 * matching quotes removed — so the same file can be `source`d from bash if
 * ever needed.
 *
 * `require` is the caller's OWN list of keys it cannot run without, and a
 * missing one throws. It is per-caller on purpose: ten of the eleven job
 * callers never read Slack, so demanding SLACK_BOT_TOKEN of them would
 * refuse to run jobs that have nothing to do with Slack.
 */
export function loadEnv({ path = ENV_PATH, require: required = [] } = {}) {
  const env = {};
  const text = fs.readFileSync(path, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue; // not KEY=VALUE — silently skip
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes, if present.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  for (const key of required) {
    if (!env[key]) {
      throw new Error(`missing ${key} in ${path} — fill in the env file`);
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// The published version a launcher stamps on a run
// ---------------------------------------------------------------------------
//
// WHY THEY LIVE HERE. This file is already copied to BOTH install depths by
// setup.sh (flat with the jobs at /opt/tts/, and again at
// /opt/tts/session-host/ through the checked-in symlink), and it is already
// every job's and the daemon's environment module. So a version reader put
// here costs no new `cp` line and introduces no second resolution of the
// WikiTom directory — which is exactly what the three launchers need, since
// they sit at three different depths and one of them is the daemon.
//
// THE CANONICAL SPELLING OF THE WIKITOM PATH IS worker/jobs/search-lib.mjs
// (BOX_WIKITOM_DIR and LAPTOP_WIKITOM_DIR). It is repeated rather than
// imported because a static `./search-lib.mjs` import DANGLES in the
// session-host copy of this file: search-lib.mjs lands flat at
// /opt/tts/search-lib.mjs while this body is also installed one directory
// down, and Node resolves a static import at module load — the daemon would
// fail to start. Keep the two spellings in step; nothing else reads them.
const BOX_WIKITOM_DIR = "/root/wikitom";
const LAPTOP_WIKITOM_DIR = "C:/Users/heffn/Desktop/WikiTom";

// THE OVERRIDE IS REPEATED TOO, and for a reason the constants' does not
// cover: `check:guardrails` and the graph's own proofs are run against a
// SECOND WikiTom checkout (WIKITOM_DIR=<...>/WikiTom-uae), so a version read
// that ignored the variable would stamp a run with the version of a tree that
// run never read. The two constants are the default, not the answer.
function wikitomDir() {
  if (process.env.WIKITOM_DIR) return process.env.WIKITOM_DIR;
  return process.platform === "win32" ? LAPTOP_WIKITOM_DIR : BOX_WIKITOM_DIR;
}

/**
 * The `version` field of <WikiTom>/tts/graph.json, or null.
 *
 * ONE READER, NOT A FAMILY. This was `publishedVersion(file)` with two
 * wrappers over it, and the second — `vocabularyVersion()` — had no caller
 * outside its own tests: the vocabulary's version reaches a row through
 * scripts/graph.mjs, which reads the file it just built rather than asking a
 * box module for it. A parameter with one argument is a shape that invites a
 * third wrapper nobody needs, so the parameter goes with the caller.
 *
 * NEVER THROWS AND RETURNS null ON ANY FAILURE — a missing checkout, an
 * unreadable file, malformed JSON, or a file with no string `version`. This is
 * a stamp on a run row, not a precondition of the run: a launcher that cannot
 * name the version must still launch, and absent is a supported value
 * everywhere it lands.
 */
export function graphVersion() {
  // There was a try/catch around the line below. `wikitomDir()` reads
  // process.env and joins two strings, so nothing in it can throw, and a catch
  // around code that cannot throw hides the next thing put inside it.
  const path = `${wikitomDir()}/tts/graph.json`;
  // NO CACHE: the file is read on every call, because one of the three callers
  // is a daemon nobody may restart (worker/session-host/session.mjs, and
  // "restart or stop tts-session-host" is on the Never list) while the nightly
  // rewrites this file every night — so a per-process answer stamped every
  // session after the first nightly with the version of a graph it did not run
  // under, and a daemon started before the file existed stamped nothing for
  // ever. A cache that saves one small JSON read and buys a wrong record is
  // the guard the removal rule is about.
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
    if (parsed && typeof parsed.version === "string" && parsed.version !== "") return parsed.version;
  } catch {
    // Fall through: a missing checkout, an unreadable file and malformed JSON
    // are all "no version", which is a supported value everywhere this lands.
  }
  return null;
}

// ---------------------------------------------------------------------------
// A secret's value as an HTTP bearer token
// ---------------------------------------------------------------------------

/**
 * What makes `value` unusable as a bearer token, as a sentence of character
 * counts, or null when every character is printable ASCII other than space
 * (0x21-0x7e). Never names a character or a position: the value is a secret.
 *
 * THE ONE DEFINITION of a clean OPENROUTER_API_KEY. scripts/codex-run.mjs
 * refuses a run's key with it, and worker/setup.sh's rollout warning calls it
 * through node on the value loadEnv above reads, so the rollout and the run
 * judge the same value by the same rule. Codex, given a value holding a
 * control character, sends its request with no Authorization header at all.
 */
export function bearerTokenProblem(value) {
  const bad = [...String(value)].filter((ch) => !/^[\x21-\x7e]$/.test(ch));
  if (bad.length === 0) return null;
  const control = bad.filter((ch) => ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f).length;
  const space = bad.filter((ch) => ch === " ").length;
  return `${bad.length} character(s) outside printable ASCII (${control} control, ${space} space, ${bad.length - control - space} non-ASCII)`;
}
