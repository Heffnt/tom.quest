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
// Approve in the browser; the terminal prints three lines that go into the
// CONVEX dashboard environment variables (production deployment) — NOT the
// Jarvis Box's worker.env: the write door lives in Convex so every surface
// (interactive sessions, box jobs via POST /tts/calendar-event) shares one
// credential home. Revoke any time at myaccount.google.com/permissions.
//
// Zero dependencies: node:http + global fetch.

import http from "node:http";
import crypto from "node:crypto";

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
    res.end("Done — the token is printed in your terminal. Close this tab.");
    console.log(
      "\nAdd these in the Convex dashboard -> Production (admired-chinchilla-140) -> Settings -> Environment Variables:\n",
    );
    console.log(`GOOGLE_CALENDAR_CLIENT_ID=${clientId}`);
    console.log(`GOOGLE_CALENDAR_CLIENT_SECRET=${clientSecret}`);
    console.log(`GOOGLE_CALENDAR_REFRESH_TOKEN=${tokens.refresh_token}`);
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
