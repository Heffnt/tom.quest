// tts-secret-lib — read one secret out of /etc/tts/worker.env at the moment
// it is needed. Not executable; imported by absolute path from
// /usr/local/bin, where setup.sh copies everything in worker/bin.
//
// WHY THIS EXISTS: a secret a session's shell can PRINT and a secret a
// session's shell can USE are different things, and only the second is
// needed. `tts-git-credential` already made that split for GH_TOKEN — the
// token lives in /etc/tts/worker.env (root-only, mode 600) and is read at the
// instant git asks for it, so `git push` works in a shell where `env` shows
// nothing. This module generalises that move to every other worker secret, so
// each new helper does not re-inline the same `sed`.
//
// The stakes are higher than "tidier", because a TTS session's shell output is
// not ephemeral: every Bash call and its output is ingested as a transcript
// row and stored in Convex. A secret readable with `env` is therefore a secret
// one stray command away from being written down permanently. That is the
// exact hazard the tom.quest login credentials were hand-typed into the box to
// avoid (worker.env.example: "Telling them to a session instead writes the
// password into a Convex-stored transcript") — so leaving them in the
// inherited environment gives back what the hand-typing bought.
//
// PRECEDENCE, and why this order: worker.env first, environment second. The
// daemon scrubs these names from a session's env (session.mjs), so inside a
// session only the file answers. Outside one — Tom running a helper by hand,
// or a box where worker.env is not the source — the env fallback keeps the
// helper working. The file wins when both exist so that rotating worker.env
// takes effect without restarting anything.

import fs from "node:fs";

export const WORKER_ENV_PATH = "/etc/tts/worker.env";

/**
 * Read `name` from /etc/tts/worker.env, falling back to process.env.
 *
 * Returns undefined (never throws) when the file is absent, unreadable, or
 * has no such key — callers report their own missing-credential message,
 * which is more useful than a stack trace from here.
 *
 * Parsing matches the worker.env format documented in worker.env.example:
 * KEY=VALUE one per line, '#' comments and blank lines ignored, no quoting.
 * The LAST assignment wins, matching how systemd's EnvironmentFile and
 * tts-git-credential's `sed … | tail -1` both resolve a duplicated key —
 * duplicates are real (a hand-edited worker.env accumulates them).
 */
export function readSecret(name) {
  let value;
  try {
    const text = fs.readFileSync(WORKER_ENV_PATH, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      if (trimmed.slice(0, eq).trim() !== name) continue;
      value = trimmed.slice(eq + 1).trim();
    }
  } catch {
    /* no worker.env on this box, or not readable as this user — fall through */
  }
  if (value) return value;
  const fromEnv = process.env[name];
  return fromEnv ? fromEnv : undefined;
}

/**
 * Read several secrets at once. Returns an object keyed by name, with
 * undefined for any that are missing.
 */
export function readSecrets(...names) {
  return Object.fromEntries(names.map((n) => [n, readSecret(n)]));
}
