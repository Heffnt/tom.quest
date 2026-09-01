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
