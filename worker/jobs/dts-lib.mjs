// dts-lib.mjs — shared helpers for the DTS worker jobs (poll-dump.mjs,
// prepare-queue.mjs). Plain Node ESM, ZERO npm dependencies: node:fs and the
// global fetch (Node >= 18, this box runs Node 22) are all we use.
//
// WHY no dependencies: the box owns no state and must be rebuildable by one
// script with nothing but Node itself. No node_modules means no lockfile, no
// install step, no supply-chain surface — setup.sh just copies these files
// into /opt/dts/ and cron runs them.

import fs from "node:fs";

// ---------------------------------------------------------------------------
// Env file parsing
// ---------------------------------------------------------------------------

// Read /etc/dts/worker.env (KEY=VALUE lines; '#' comments and blank lines
// ignored; an optional leading "export " and optional surrounding quotes are
// tolerated so the same file can be `source`d from bash if ever needed).
// Throws with a clear message if a required key is missing, because every
// caller needs all of them to do anything useful.
export function loadEnv(path = "/etc/dts/worker.env") {
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
  for (const required of [
    "CONVEX_SITE_URL",
    "DTS_WORKER_KEY",
    "SLACK_BOT_TOKEN",
    "SLACK_DUMP_CHANNEL_ID",
  ]) {
    if (!env[required]) {
      throw new Error(`missing ${required} in ${path} — fill in the env file`);
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// America/New_York wall-clock hour (for the cron DST guard only)
// ---------------------------------------------------------------------------
//
// We implement NY time by hand rather than trusting the box's TZ database or
// timezone config, because the box must be rebuildable from a bare Ubuntu
// image with zero manual configuration (the no-state rule). US DST rules,
// fixed in law since 2007:
//   EDT (UTC-4): from the second Sunday of March 07:00 UTC (2 a.m. EST)
//                until the first Sunday of November 06:00 UTC (2 a.m. EDT)
//   EST (UTC-5): the rest of the year.

// Epoch ms of the DST-start instant (2nd Sunday of March, 07:00 UTC) for a year.
function dstStartUtcMs(year) {
  const march1 = new Date(Date.UTC(year, 2, 1));
  // Day-of-month of the first Sunday of March (getUTCDay(): 0 = Sunday).
  const firstSunday = 1 + ((7 - march1.getUTCDay()) % 7);
  return Date.UTC(year, 2, firstSunday + 7, 7, 0, 0);
}

// Epoch ms of the DST-end instant (1st Sunday of November, 06:00 UTC) for a year.
function dstEndUtcMs(year) {
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const firstSunday = 1 + ((7 - nov1.getUTCDay()) % 7);
  return Date.UTC(year, 10, firstSunday, 6, 0, 0);
}

// UTC offset of America/New_York at a given instant: -4 (EDT) or -5 (EST).
export function nyUtcOffsetHours(ms) {
  const year = new Date(ms).getUTCFullYear();
  return ms >= dstStartUtcMs(year) && ms < dstEndUtcMs(year) ? -4 : -5;
}

// A Date whose getUTC*() fields read as NY wall-clock time for the instant.
// (We shift the epoch value and then read UTC fields — the Date object itself
// is "wrong" as an instant, which is why it stays private to this module.)
function nyWallClock(ms) {
  return new Date(ms + nyUtcOffsetHours(ms) * 3_600_000);
}

// NY wall-clock hour (0-23) at the given instant. Used by prepare-queue.mjs
// as the DST guard: cron fires at both 08:30 and 09:30 UTC, and exactly one
// of those is the 4 a.m. NY hour depending on the season.
export function nyHour(ms) {
  return nyWallClock(ms).getUTCHours();
}

// NOTE: this module deliberately has NO day-key function. The DTS day key
// (5 a.m. boundary) is a server-owned fact: /dts/state returns `prepDay` and
// the jobs repeat it back. A second hand-rolled copy of that math lived here
// once and disagreed with Convex's for five hours after each DST transition —
// the worker computes only the local-hour guard above, nothing more.

// ---------------------------------------------------------------------------
// Convex HTTP endpoints (key-authed)
// ---------------------------------------------------------------------------

// Call a /dts/* endpoint on the Convex site origin. GET when no body, POST
// (JSON) when a body is given. Throws on non-2xx with the response text
// included, so cron logs show WHY a call failed.
export async function convexFetch(env, path, body = undefined) {
  const url = env.CONVEX_SITE_URL.replace(/\/+$/, "") + path;
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-DTS-Key": env.DTS_WORKER_KEY,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}
