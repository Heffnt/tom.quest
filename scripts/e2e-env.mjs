// e2e-env.mjs — put the E2E_* variables from secrets/e2e.env into process.env
// before Playwright collects specs.
//
// WHY THIS FILE EXISTS. The specs under e2e/ read their credentials from
// process.env of the PLAYWRIGHT process, not of the Next.js dev server that
// Playwright starts. Next.js loads .env.local, but only for itself; pnpm does
// not load any .env file into the scripts it runs (verified: `pnpm run` with a
// .env.local present leaves process.env untouched). So without this loader the
// only way to supply E2E_USER_USERNAME and friends is to export all six in the
// shell before every run, and secrets/e2e.env would look like it worked while
// doing nothing.
//
// WHY NOT secrets/next.env. That file is pushed to Vercel production env by
// `pnpm secrets:sync`. The E2E credentials are three real production accounts,
// one of them Tom's own; nothing running on Vercel needs them, so they stay in
// a file that syncs nowhere.
//
// The shell always wins: a variable already present in process.env is left
// alone, so `E2E_CONVEX=1 pnpm test:e2e` overrides the file.

import { existsSync, readFileSync } from "node:fs";

/**
 * Parse the contents of an env file into a plain object.
 * Blank lines and lines whose first non-space character is `#` are ignored.
 * A line is `KEY=VALUE`, split at the FIRST `=`; an optional `export ` prefix
 * is dropped; one balanced pair of surrounding single or double quotes is
 * stripped from the value. A line with no `=` is ignored.
 */
export function parseEnvText(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Apply an env file to `env` (process.env by default) without overwriting any
 * key that is already set to a non-empty value. Returns the list of key NAMES
 * applied — never their values, which are passwords.
 * A missing file is not an error: it returns an empty list.
 */
export function loadEnvFile(filePath, env = process.env) {
  if (!existsSync(filePath)) return [];
  const parsed = parseEnvText(readFileSync(filePath, "utf8"));
  const applied = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key]) continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}
