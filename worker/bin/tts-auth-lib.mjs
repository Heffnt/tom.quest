// Shared browser + tom.quest sign-in for the session CLIs (tts-browse,
// tts-turing). Not executable; imported by absolute path from /usr/local/bin,
// where setup.sh copies everything in worker/bin.
//
// It exists so the sign-in sequence is written once. Two commands need a
// signed-in tom.quest — one to look at pages, one to reach the cluster through
// the app's own proxy — and a second copy of "click Log in, fill, wait for the
// header" would drift the moment the login widget changes.

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { readSecret } from "./tts-secret-lib.mjs";

const require = createRequire(import.meta.url);

/**
 * Playwright is installed GLOBALLY by worker/setup.sh (step 4) so that all
 * sessions share one Chromium download instead of pulling 115MB each. Resolve
 * it from the global root rather than expecting a local node_modules.
 */
export function loadPlaywright() {
  const candidates = ["playwright"];
  try {
    candidates.push(path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "playwright"));
  } catch {
    /* npm missing; fall through */
  }
  candidates.push("/usr/lib/node_modules/playwright");
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* next candidate */
    }
  }
  throw new Error(
    "cannot load playwright. Run `bash worker/setup.sh` on this box (step 4 " +
      "installs it globally and downloads Chromium).",
  );
}

/**
 * The agent account's tom.quest login, read from /etc/tts/worker.env at the
 * moment of use rather than from the environment.
 *
 * WHY NOT process.env: these two were hand-typed into the box specifically so
 * the password would never be written down — worker.env.example says "Telling
 * them to a session instead writes the password into a Convex-stored
 * transcript". But a session's shell output IS a stored transcript, so as long
 * as the daemon passed them through, one `env` in any Bash call wrote the
 * password down anyway, permanently, and the hand-typing bought nothing. The
 * daemon now scrubs both names (worker/session-host/session.mjs) and this
 * function reads the file instead — the same split tts-git-credential already
 * makes for GH_TOKEN. A session can USE the login without HOLDING it.
 */
export function credentials() {
  const username = readSecret("TOMQUEST_AGENT_USERNAME");
  const password = readSecret("TOMQUEST_AGENT_PASSWORD");
  if (!username || !password) {
    throw new Error(
      "TOMQUEST_AGENT_USERNAME and TOMQUEST_AGENT_PASSWORD are not set. Add them " +
        "to /etc/tts/worker.env and restart tts-session-host.",
    );
  }
  return { username, password };
}

/**
 * Sign in through the ordinary widget rather than forging a session cookie:
 * the login path is itself something a session may have broken, and a forged
 * cookie would hide that.
 *
 * `origin` MUST be the origin the target actually lands on. tom.quest
 * 307-redirects the apex to www and the auth token is origin-scoped, so
 * signing in on the wrong one yields a page that looks signed in and whose
 * every data call is 401.
 */
export async function signIn(page, origin) {
  const { username, password } = credentials();
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 30000 });

  // `domcontentloaded` fires before React hydrates, and a click that lands in
  // that window is swallowed with no error — the button is in the DOM, it just
  // has no handler yet. Measured: 2 failures in 5 runs clicking straight away,
  // 0 in 6 when something delayed the click.
  const loginButton = page.getByRole("button", { name: "Log in" });
  await loginButton.waitFor({ timeout: 30000 });
  for (let attempt = 1; ; attempt++) {
    await loginButton.click();
    try {
      await page.getByLabel("Username").waitFor({ timeout: 5000 });
      break;
    } catch (e) {
      if (attempt >= 4) throw e;
      await page.waitForTimeout(1000);
    }
  }

  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();

  // The header button carrying the username is the human-visible proof, and it
  // is what we wait for. On a slow sign-in the token lands before React
  // repaints, though, and failing there would report "login broken" for a
  // session that did authenticate — so the token is accepted as a fallback,
  // and only as a fallback.
  try {
    await page.getByRole("button", { name: username }).waitFor({ timeout: 30000 });
  } catch (e) {
    if (!(await readJwt(page))) throw e;
  }
  return username;
}

async function readJwt(page) {
  return page.evaluate(() => {
    const k = Object.keys(window.localStorage).find((x) => x.startsWith("__convexAuthJWT"));
    return k ? window.localStorage.getItem(k) : null;
  });
}

function jwtExpiry(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * A Convex auth token for the agent account, good for `Authorization: Bearer`
 * against tom.quest's own API routes.
 *
 * Cached on disk because obtaining one costs a browser launch and a real
 * sign-in — several seconds — while a caller looping over cluster endpoints
 * should pay that once. The cache is keyed to nothing and holds one token: one
 * box, one agent account. Treated as a secret (mode 600) and re-minted a
 * minute before expiry, since a token that expires mid-request reads as a
 * mysterious 401.
 */
export async function tomQuestToken({ origin = "https://www.tom.quest", cacheFile } = {}) {
  const file = cacheFile ?? "/var/cache/tts/tomquest-token";
  try {
    const cached = fs.readFileSync(file, "utf8").trim();
    if (cached && jwtExpiry(cached) > Date.now() + 60_000) return cached;
  } catch {
    /* no cache yet, or unreadable — mint a fresh one */
  }

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await signIn(page, origin);
    const jwt = await readJwt(page);
    if (!jwt) throw new Error("signed in but no auth token appeared in localStorage");
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, jwt, { mode: 0o600 });
    } catch {
      // A cache we cannot write is a slow path, not a failure.
    }
    return jwt;
  } finally {
    await browser.close();
  }
}
