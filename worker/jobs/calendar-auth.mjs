#!/usr/bin/env node
// calendar-auth.mjs — ONE-TIME helper, run by Tom ON HIS OWN MACHINE, to mint
// the Google Calendar WRITE token for TTS's calendar door
// (convex/ttsCalendarWrite.ts).
//
// Reuses the same "Desktop app" OAuth client as gmail-auth.mjs (the jarvis
// Google Cloud project) but mints a SEPARATE refresh token, scoped to
// calendar.events only (create/edit/delete events; no calendar admin, no
// mail) — one leaked credential must not open the other surface.
//
// Run:
//   node worker/jobs/calendar-auth.mjs <client_id> <client_secret>
//
// Approve in the browser; the script then SETS the three GOOGLE_CALENDAR_*
// variables on the Convex deployment ITSELF (`npx convex env set`, using the
// deploy key in the repo's .env.local — so run it from a tom.quest checkout).
// The token flows Google → this script → Convex and is never copy-pasted by
// anyone. If the env set fails, the three values are WRITTEN to an owner-only
// file in your home directory and only its path is printed, never a value —
// AGENTS.md forbids logging secrets, and an agent session stores its own
// stdout. Revoke any time at myaccount.google.com/permissions.
//
// Zero npm dependencies: node:http, node:child_process + global fetch.

import http from "node:http";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeCredentialFile, credentialFileNotice } from "./credential-file.mjs";

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error("usage: node calendar-auth.mjs <client_id> <client_secret>");
  process.exit(1);
}

const PORT = 8766; // not 8765, so it can run even if gmail-auth is mid-dance
const REDIRECT = `http://localhost:${PORT}/oauth`;
const state = crypto.randomBytes(16).toString("hex");

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", REDIRECT);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.events");
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent"); // forces a refresh_token grant
authUrl.searchParams.set("state", state);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/oauth") {
    res.writeHead(404).end();
    return;
  }
  if (url.searchParams.get("state") !== state) {
    res.writeHead(400).end("state mismatch — rerun the script");
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end(`error: ${url.searchParams.get("error") ?? "no code"}`);
    return;
  }
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT,
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.refresh_token) {
      throw new Error(`no refresh_token in response: ${JSON.stringify(tokens).slice(0, 300)}`);
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Done — check your terminal. Close this tab.");
    // DECISION (AGENTS.md "never log secrets"): the happy path below hands
    // these values straight to `npx convex env set`, which never prints them.
    // The fallback path used to console.log all three; it now writes them to
    // an owner-only file and prints only the path and the variable names, so
    // running this helper inside an agent session cannot write a credential
    // into the stored session transcript. There is no exemption for this
    // helper — if you add a step here, it keeps this shape.
    const vars = {
      GOOGLE_CALENDAR_CLIENT_ID: clientId,
      GOOGLE_CALENDAR_CLIENT_SECRET: clientSecret,
      GOOGLE_CALENDAR_REFRESH_TOKEN: tokens.refresh_token,
    };
    try {
      for (const [name, value] of Object.entries(vars)) {
        // shell:true because on Windows npx is npx.cmd; values are
        // Google-issued (no spaces or shell metacharacters).
        //
        // stdout is DISCARDED, not inherited: the Convex CLI's success line
        // names the value it just set, which would put the secret back on
        // stdout by a side door. stderr stays inherited so a real failure is
        // still visible, and a nonzero exit still throws into the catch.
        execFileSync("npx", ["convex", "env", "set", name, value], {
          shell: true,
          stdio: ["ignore", "ignore", "inherit"],
        });
      }
      console.log(
        "\nDone: the three GOOGLE_CALENDAR_* variables are set on the Convex deployment.",
      );
    } catch {
      console.log(
        "\nSetting the Convex env failed (no .env.local deploy key here?) — the three values were written to a file instead.",
      );
      const file = writeCredentialFile("tts-calendar-credentials.env", vars);
      console.log(
        credentialFileNotice(file, Object.keys(vars), [
          "Set them on the Convex deployment from that file, without printing them:",
          // >/dev/null for the same reason the execFileSync above discards
          // stdout: the CLI's success line repeats the value it set.
          `  while IFS='=' read -r name value; do npx convex env set "$name" "$value" >/dev/null; done < ${file}`,
          "Or open the file in an editor and paste each value into the Convex",
          "dashboard -> Production -> Settings -> Environment Variables.",
        ]),
      );
    }
  } catch (err) {
    res.writeHead(500).end(String(err.message));
    console.error(`token exchange failed: ${err.message}`);
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log("Open this URL in your browser and approve calendar-events access:\n");
  console.log(authUrl.toString());
});
