// config.mjs — one resolver for the sweep on either host.
//
// Environment values win one field at a time over the first readable env
// file. The parser for that file remains worker-env.mjs's single body; this
// module only decides which file applies and turns named values into config.

import fsDefault from "node:fs";
import os from "node:os";
import path from "node:path";

import { ENV_PATH, loadEnv } from "../jobs/worker-env.mjs";

export const RUN_ENV_NAMES = Object.freeze([
  "RUN_HOST",
  "RUN_SWEEP_STATE_DIR",
  "RUN_SWEEP_CLAUDE_ROOTS",
  "RUN_SWEEP_CODEX_ROOTS",
  "RUN_SWEEP_BACKLOG",
  "RUN_BACKLOG_BYTES_PER_HOUR",
  "RUN_BACKLOG_PASS_MS",
  "RUN_BACKLOG_MAX_FILE_BYTES",
  "RUN_BACKLOG_ALLOW_LOCAL_STORE",
  "RUN_MAX_PARALLEL",
  "WIKITOM_DIR",
  "WIKITOM_SESSIONS_DIR",
  "RUN_FILES_DELETE_AFTER_UPLOAD",
  "RUN_STORE_BACKEND",
  "RUN_STORE_ENDPOINT",
  "RUN_STORE_BUCKET",
  "RUN_STORE_REGION",
  "RUN_STORE_FORCE_PATH_STYLE",
  "RUN_STORE_WRITE_KEY_ID",
  "RUN_STORE_WRITE_SECRET",
  "RUN_STORE_READ_KEY_ID",
  "RUN_STORE_READ_SECRET",
  "CONVEX_SITE_URL",
  "SESSIONS_WORKER_KEY",
  "TTS_WORKER_KEY",
  "TTS_BOX_HOST",
  "TTS_BOX_USER",
  "TTS_BOX_KEY",
  "TTS_BOX_CMD",
]);

const enabled = (value) => /^(1|true|yes|on)$/i.test(String(value ?? ""));
const explicit = (env, key) => typeof env[key] === "string" && env[key] !== "";
// A backlog limit is a positive count of bytes or milliseconds. Anything else
// in the env file is a typo, and a typo must not become an unlimited import.
const positive = (raw, fallback) => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

export const BACKLOG_DEFAULTS = Object.freeze({
  bytesPerHour: 1024 ** 3,
  passMs: 600_000,
  maxFileBytes: 128 * 1024 * 1024,
  allowLocalStore: false,
});

function firstReadable(paths, fs) {
  for (const file of paths) {
    if (!file) continue;
    try {
      fs.accessSync(file, fs.constants?.R_OK ?? 4);
      return file;
    } catch {}
  }
  return null;
}

function accountRoots(accountsDir, fs) {
  try {
    return fs.readdirSync(accountsDir, { withFileTypes: true })
      .filter((entry) => entry.name !== "active" && entry.isDirectory() && !entry.isSymbolicLink?.())
      .map((entry) => ({ path: path.join(accountsDir, entry.name, "projects"), account: entry.name }));
  } catch {
    return [];
  }
}

function rootList(value, delimiter) {
  return String(value ?? "").split(delimiter).map((item) => item.trim()).filter(Boolean).map((item) => ({ path: item }));
}

export function runConfig({
  env = process.env,
  fs = fsDefault,
  platform = process.platform,
  homedir = os.homedir(),
  envFiles,
} = {}) {
  const laptopFile = path.join(env.USERPROFILE || env.HOME || homedir, ".tts", "env");
  const candidates = envFiles ?? (explicit(env, "RUN_ENV_FILE") ? [env.RUN_ENV_FILE] : [ENV_PATH, laptopFile]);
  const envFile = firstReadable(candidates, fs);
  let fromFile = {};
  if (envFile) {
    try { fromFile = loadEnv({ path: envFile }); }
    catch { fromFile = {}; }
  }
  const value = (key) => explicit(env, key) ? env[key] : fromFile[key];
  const hostValue = value("RUN_HOST");
  const host = hostValue === "box" || hostValue === "laptop" ? hostValue : null;
  const stateDir = value("RUN_SWEEP_STATE_DIR") || (host === "box"
    ? "/var/cache/tts/runs"
    : path.join(env.LOCALAPPDATA || path.join(env.USERPROFILE || env.HOME || homedir, "AppData", "Local"), "tts", "runs"));
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const claudeOverride = value("RUN_SWEEP_CLAUDE_ROOTS");
  const codexOverride = value("RUN_SWEEP_CODEX_ROOTS");
  const home = env.USERPROFILE || env.HOME || homedir;
  const roots = {
    claude: claudeOverride
      ? rootList(claudeOverride, delimiter)
      : host === "box"
        ? accountRoots("/root/.claude-accounts", fs)
        : [{ path: path.join(home, ".claude", "projects") }],
    codex: codexOverride ? rootList(codexOverride, delimiter) : [{ path: host === "box" ? "/root/.codex/sessions" : path.join(home, ".codex", "sessions") }],
  };
  const backend = value("RUN_STORE_BACKEND") || "local";
  const storeConfig = backend === "s3" ? {
    backend,
    s3: {
      endpoint: value("RUN_STORE_ENDPOINT"),
      bucket: value("RUN_STORE_BUCKET"),
      region: value("RUN_STORE_REGION"),
      forcePathStyle: value("RUN_STORE_FORCE_PATH_STYLE") === undefined ? true : enabled(value("RUN_STORE_FORCE_PATH_STYLE")),
      ...(value("RUN_STORE_WRITE_KEY_ID") && value("RUN_STORE_WRITE_SECRET") ? { writeCredential: { keyId: value("RUN_STORE_WRITE_KEY_ID"), secret: value("RUN_STORE_WRITE_SECRET") } } : {}),
      ...(value("RUN_STORE_READ_KEY_ID") && value("RUN_STORE_READ_SECRET") ? { readCredential: { keyId: value("RUN_STORE_READ_KEY_ID"), secret: value("RUN_STORE_READ_SECRET") } } : {}),
    },
  } : { backend: "local", dir: path.join(stateDir, "store") };
  return {
    host,
    stateDir,
    storeConfig,
    // The most box runs the transport may have in flight at once. A typo is a
    // typo, not permission to launch without limit, so it falls back the same
    // way a backlog limit does.
    maxParallel: positive(value("RUN_MAX_PARALLEL"), 2),
    // WHERE scripts/box-agent.mjs SENDS A RUN. THE ADDRESS HAS NO DEFAULT AND
    // IS NOT IN THIS REPOSITORY: tom.quest is public, the Jarvis Box is Tom's
    // one machine, and the rest of the repo already writes the address as a
    // placeholder (`root@<jarvis-box>` in worker/jobs/gmail-auth.mjs,
    // `root@<this box>` in worker/setup.sh). It is named in the env file, which
    // is why it is resolved here rather than by a second reader of that file:
    // a key PATH and a user name say nothing about where the box is, so those
    // two keep their defaults.
    box: {
      host: value("TTS_BOX_HOST") || null,
      user: value("TTS_BOX_USER") || "root",
      key: value("TTS_BOX_KEY") || null,
      // REMOVAL CHECK on TTS_BOX_CMD: it is the seam the transport's own tests
      // run through. box-agent.mjs's ssh path is testable because TTS_SSH_BIN
      // points at a fake, and its on-the-box path — where there is no ssh at
      // all — has only this one. Without it the branch that runs the command
      // where it stands could be proved on no machine but the box itself.
      command: value("TTS_BOX_CMD") || "tts-run",
    },
    convexSiteUrl: value("CONVEX_SITE_URL") || null,
    sessionsKey: value("SESSIONS_WORKER_KEY") || null,
    ttsKey: value("TTS_WORKER_KEY") || null,
    roots,
    flags: {
      backlog: enabled(value("RUN_SWEEP_BACKLOG")),
      deleteAfterUpload: enabled(value("RUN_FILES_DELETE_AFTER_UPLOAD")),
    },
    // The backlog importer's own limits, resolved here so that program reads
    // no environment of its own and the env file stays loadEnv's one body.
    // The archive is a WikiTom checkout, which sits beside the vault on the
    // box and on Tom's desktop on the laptop; neither location is guessed from
    // a path inside it.
    backlog: {
      ...BACKLOG_DEFAULTS,
      bytesPerHour: positive(value("RUN_BACKLOG_BYTES_PER_HOUR"), BACKLOG_DEFAULTS.bytesPerHour),
      passMs: positive(value("RUN_BACKLOG_PASS_MS"), BACKLOG_DEFAULTS.passMs),
      maxFileBytes: positive(value("RUN_BACKLOG_MAX_FILE_BYTES"), BACKLOG_DEFAULTS.maxFileBytes),
      allowLocalStore: enabled(value("RUN_BACKLOG_ALLOW_LOCAL_STORE")),
      sessionsDir: value("WIKITOM_SESSIONS_DIR")
        || (host === "box"
          ? `${value("WIKITOM_DIR") || "/root/wikitom"}/sessions`
          : path.join(home, "Desktop", "WikiTom", "sessions")),
    },
    envFile,
  };
}
