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
// The two published versions a launcher stamps on a run
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

function wikitomDir() {
  if (process.env.WIKITOM_DIR) return process.env.WIKITOM_DIR;
  return process.platform === "win32" ? LAPTOP_WIKITOM_DIR : BOX_WIKITOM_DIR;
}

// Per-process cache, KEYED ON THE RESOLVED PATH rather than on the file name,
// so a process that moves WIKITOM_DIR reads the new tree instead of the old
// tree's answer. THE NULL IS CACHED TOO: a launcher with no WikiTom checkout
// would otherwise re-stat a missing file on every run it registers, and the
// answer cannot change under one path inside one process.
const versionCache = new Map();

/**
 * The `version` field of one published JSON file under <WikiTom>/tts/.
 *
 * NEVER THROWS AND RETURNS null ON ANY FAILURE — a missing checkout, an
 * unreadable file, malformed JSON, or a file with no string `version`. This is
 * a stamp on a run row, not a precondition of the run: a launcher that cannot
 * name the version must still launch, and absent is a supported value
 * everywhere it lands.
 */
function publishedVersion(file) {
  let path;
  try {
    path = `${wikitomDir()}/tts/${file}`;
  } catch {
    return null;
  }
  if (versionCache.has(path)) return versionCache.get(path);
  let version = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
    if (parsed && typeof parsed.version === "string" && parsed.version !== "") version = parsed.version;
  } catch {
    version = null;
  }
  versionCache.set(path, version);
  return version;
}

/** The published vocabulary's version, or null. */
export function vocabularyVersion() {
  return publishedVersion("vocabulary.json");
}

/** The published graph's version, or null. */
export function graphVersion() {
  return publishedVersion("graph.json");
}
