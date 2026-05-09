#!/usr/bin/env node
// One source of truth for tom.quest secrets.
//
//   secrets/next.env    → Vercel prod env + .env.local mirror (read by `next dev` and Next.js at runtime)
//   secrets/convex.env  → Convex prod env (read by Convex functions on Convex's servers)
//
// Usage:
//   pnpm secrets:init             — first-time pull from Vercel + Convex into secrets/*.env
//   pnpm secrets:sync             — push secrets/*.env to platforms; mirror next.env to .env.local
//   pnpm secrets:sync -- --prune  — also delete platform vars not present in our files (opt-in)
//
// Why two files instead of one: the boundary is real (Vercel runtime vs Convex
// runtime). Two files make destination obvious from path alone — no metadata
// to maintain, no comment-section parser to break.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = process.cwd();
const NEXT_FILE = join(ROOT, "secrets", "next.env");
const CONVEX_FILE = join(ROOT, "secrets", "convex.env");
const LOCAL_FILE = join(ROOT, ".env.local");

const args = process.argv.slice(2);
const MODE_INIT = args.includes("--init");
const PRUNE = args.includes("--prune");

const IS_WINDOWS = process.platform === "win32";

// Vercel auto-injects these at deploy time; they are NOT user-managed secrets
// and must never be pulled into secrets/*.env or pushed back as user vars.
// `vercel env pull` returns them anyway because it returns "the full env your
// deployment would see," not "user-managed secrets only."
function isVercelSystemVar(key) {
  if (key === "VERCEL") return true;
  if (key.startsWith("VERCEL_")) return true;
  if (key === "NX_DAEMON") return true;
  if (key.startsWith("TURBO_")) return true;
  return false;
}

// Strip Vercel-system env from the process env we hand to subprocesses. pnpm
// loads .env.local before running the script, so `VERCEL=1` etc. can leak
// into our shell — and the Convex CLI then thinks it's running in a Vercel
// build context and demands different config. Cleaning these keeps the
// Convex CLI in normal local mode regardless of what's in .env.local.
function cleanEnv() {
  const out = { ...process.env };
  for (const key of Object.keys(out)) {
    if (isVercelSystemVar(key)) delete out[key];
  }
  return out;
}

function info(msg) {
  console.log(msg);
}

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

// ---- env-file IO ---------------------------------------------------------

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    // strip a single pair of surrounding quotes if balanced
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
      // unescape \" inside a double-quoted value
      if (raw.trim().startsWith(`${key}="`)) {
        value = value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
    }
    out[key] = value;
  }
  return out;
}

function writeEnvFile(path, vars, headerLines = []) {
  mkdirSync(dirname(path), { recursive: true });
  const lines = [];
  for (const h of headerLines) lines.push(`# ${h}`);
  if (headerLines.length > 0) lines.push("");
  for (const [key, value] of Object.entries(vars)) {
    const v = String(value);
    const needsQuoting = /[\s"'#$`\\]/.test(v) || v === "";
    if (needsQuoting) {
      const escaped = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      lines.push(`${key}="${escaped}"`);
    } else {
      lines.push(`${key}=${v}`);
    }
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

// ---- shell helpers -------------------------------------------------------

function run(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, {
    stdio: opts.silent ? "pipe" : "inherit",
    encoding: "utf8",
    shell: IS_WINDOWS,
    env: cleanEnv(),
    ...opts,
  });
}

function runShell(commandLine, opts = {}) {
  return spawnSync(commandLine, [], {
    stdio: opts.silent ? "pipe" : "inherit",
    encoding: "utf8",
    shell: true,
    env: cleanEnv(),
    ...opts,
  });
}

function quoteForShell(value) {
  if (IS_WINDOWS) {
    return `"${String(value).replace(/"/g, '""')}"`;
  }
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// ---- Vercel --------------------------------------------------------------

function vercelPullProdEnv({ includeSystem = false } = {}) {
  const tmp = join(tmpdir(), `vercel-env-${randomUUID()}.env`);
  const r = run(
    "npx",
    ["vercel", "env", "pull", tmp, "--environment=production", "--yes"],
    { silent: true },
  );
  if (r.status !== 0) {
    fail(
      `vercel env pull failed. Make sure you ran \`npx vercel link\` once.\n${(r.stderr || "").trim()}`,
    );
  }
  const all = parseEnvFile(tmp);
  try {
    unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  if (includeSystem) return all;
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    if (isVercelSystemVar(k)) continue;
    out[k] = v;
  }
  return out;
}

function vercelEnvSet(key, value) {
  // Vercel prompts to overwrite if the key exists. Easiest non-interactive
  // path is remove-then-add. The remove may fail if the key doesn't exist;
  // we ignore that.
  run("npx", ["vercel", "env", "rm", key, "production", "--yes"], {
    silent: true,
  });
  const r = run(
    "npx",
    ["vercel", "env", "add", key, "production"],
    {
      input: `${value}\n`,
      stdio: ["pipe", "inherit", "inherit"],
      silent: false,
    },
  );
  if (r.status !== 0) {
    fail(`vercel env add ${key} failed`);
  }
}

function vercelEnvRemove(key) {
  const r = run(
    "npx",
    ["vercel", "env", "rm", key, "production", "--yes"],
    { silent: true },
  );
  return r.status === 0;
}

// ---- Convex --------------------------------------------------------------

function convexEnvList() {
  const r = run("npx", ["convex", "env", "list"], { silent: true });
  if (r.status !== 0) {
    fail(
      `convex env list failed. Make sure you ran \`npx convex login\` once.\n${(r.stderr || "").trim()}`,
    );
  }
  const keys = new Set();
  for (const raw of r.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Convex CLI prints either "KEY=value" or "KEY" depending on version.
    const eq = line.indexOf("=");
    const candidate = eq === -1 ? line : line.slice(0, eq);
    if (/^[A-Z_][A-Z0-9_]*$/.test(candidate)) keys.add(candidate);
  }
  return [...keys];
}

function convexEnvGet(key) {
  const r = run("npx", ["convex", "env", "get", key], { silent: true });
  if (r.status !== 0) return null;
  return r.stdout.replace(/\r?\n$/, "");
}

function convexEnvSet(key, value) {
  // The `--` separator stops the Convex CLI's option parser, so values
  // starting with `-----` (PEM keys) are not misread as flags.
  const r = IS_WINDOWS
    ? runShell(`npx convex env set -- ${key} ${quoteForShell(value)}`)
    : run("npx", ["convex", "env", "set", "--", key, value]);
  if (r.status !== 0) fail(`convex env set ${key} failed`);
}

function convexEnvRemove(key) {
  // Try the documented `remove` first, fall back to `unset` for older CLIs.
  const tries = [
    ["remove", key],
    ["unset", key],
    ["rm", key],
  ];
  for (const argv of tries) {
    const r = run("npx", ["convex", "env", ...argv], { silent: true });
    if (r.status === 0) return true;
  }
  return false;
}

// ---- modes ---------------------------------------------------------------

function modeInit() {
  if (existsSync(NEXT_FILE) || existsSync(CONVEX_FILE)) {
    fail(
      "secrets/next.env or secrets/convex.env already exists. Delete them first if you want to re-init, or edit them directly and run `pnpm secrets:sync`.",
    );
  }
  info("→ pulling Vercel prod env to secrets/next.env");
  const next = vercelPullProdEnv();
  writeEnvFile(NEXT_FILE, next, [
    "tom.quest Next-side secrets — single source of truth.",
    "Pushed by `pnpm secrets:sync` to Vercel prod and mirrored to .env.local.",
    "Edit any value here and re-sync.",
  ]);
  info(`  ✓ ${Object.keys(next).length} vars`);

  info("→ pulling Convex prod env to secrets/convex.env");
  const convex = {};
  for (const key of convexEnvList()) {
    const v = convexEnvGet(key);
    if (v !== null) convex[key] = v;
  }
  writeEnvFile(CONVEX_FILE, convex, [
    "tom.quest Convex-side secrets — single source of truth.",
    "Pushed by `pnpm secrets:sync` to Convex prod env.",
    "Edit any value here and re-sync.",
  ]);
  info(`  ✓ ${Object.keys(convex).length} vars`);

  info("\n✔ Initialized. Edit secrets/*.env and run `pnpm secrets:sync` to push.");
}

function modeSync() {
  if (!existsSync(NEXT_FILE)) {
    fail(`${NEXT_FILE} not found. Run \`pnpm secrets:init\` first.`);
  }
  if (!existsSync(CONVEX_FILE)) {
    fail(`${CONVEX_FILE} not found. Run \`pnpm secrets:init\` first.`);
  }

  const next = parseEnvFile(NEXT_FILE);
  const convex = parseEnvFile(CONVEX_FILE);

  // Push Next-side. Skip Vercel system vars (defensive — they shouldn't be
  // in the file at all) and skip empties (Vercel warns; usually a sign of a
  // typo in the file).
  const pushable = Object.entries(next).filter(([key, value]) => {
    if (isVercelSystemVar(key)) {
      info(`  · ${key} (skipped — Vercel system var; remove from secrets/next.env)`);
      return false;
    }
    if (value === "" || value === undefined || value === null) {
      info(`  · ${key} (skipped — empty value)`);
      return false;
    }
    return true;
  });
  info(`→ pushing ${pushable.length} vars to Vercel prod`);
  for (const [key, value] of pushable) {
    info(`  · ${key}`);
    vercelEnvSet(key, value);
  }

  if (PRUNE) {
    info("→ pruning Vercel prod vars not in secrets/next.env");
    // Pull WITHOUT system-var filtering — we want to know everything in
    // Vercel today so we can remove stale user-set system-var overrides too.
    const remoteVars = vercelPullProdEnv({ includeSystem: true });
    const stale = Object.keys(remoteVars).filter((k) => !(k in next) || isVercelSystemVar(k));
    if (stale.length === 0) {
      info("  · nothing to prune");
    } else {
      for (const key of stale) {
        const ok = vercelEnvRemove(key);
        info(`  ${ok ? "✓" : "!"} ${key}`);
      }
    }
  }

  // Mirror Next-side to .env.local so `next dev` reads the same values.
  info("→ writing .env.local mirror");
  writeEnvFile(LOCAL_FILE, next, [
    "Auto-generated by `pnpm secrets:sync` from secrets/next.env.",
    "Do not edit by hand — edit secrets/next.env and re-sync.",
  ]);

  // Push Convex-side.
  info(`→ pushing ${Object.keys(convex).length} vars to Convex prod`);
  for (const [key, value] of Object.entries(convex)) {
    info(`  · ${key}`);
    convexEnvSet(key, value);
  }

  if (PRUNE) {
    info("→ pruning Convex prod vars not in secrets/convex.env");
    const remoteKeys = convexEnvList();
    const stale = remoteKeys.filter((k) => !(k in convex));
    if (stale.length === 0) {
      info("  · nothing to prune");
    } else {
      for (const key of stale) {
        const ok = convexEnvRemove(key);
        info(`  ${ok ? "✓" : "!"} ${key}`);
      }
    }
  }

  info("\n✔ Sync complete.");
}

if (MODE_INIT) {
  modeInit();
} else {
  modeSync();
}
