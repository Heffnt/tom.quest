#!/usr/bin/env node
// gmail-auth.mjs — ONE-TIME helper, run by Tom ON HIS OWN MACHINE (not the
// Jarvis Box), to mint the GMAIL_REFRESH_TOKEN that poll-gmail.mjs needs.
//
// Prerequisite (~10 minutes, once):
//   1. console.cloud.google.com → create/pick any project.
//   2. "APIs & Services" → "Library" → enable the Gmail API.
//   3. "APIs & Services" → "OAuth consent screen" → External, add yourself
//      as a test user (the app stays in testing mode — it is only for you).
//   4. "Credentials" → "Create credentials" → "OAuth client ID" →
//      application type "Desktop app". Note the client id and secret.
//
// Then run (PowerShell or any shell, on the machine with your browser):
//   node worker/jobs/gmail-auth.mjs <client_id> <client_secret>
//
// It opens a local port, prints a Google URL to visit, and after you approve
// gmail.readonly access it WRITES the three values (GMAIL_CLIENT_ID,
// GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN) to an owner-only file in your home
// directory and prints only that file's path. Copy the file onto the Jarvis
// Box, append it to /etc/tts/worker.env, and delete both copies — the terminal
// commands are printed for you. Nothing secret ever reaches stdout, because
// AGENTS.md forbids logging secrets and an agent session stores its own stdout.
// The token never expires while the app has access; revoke any time at
// myaccount.google.com/permissions.
//
// Zero npm dependencies: node:http + global fetch.

import http from "node:http";
import crypto from "node:crypto";
import { writeCredentialFile, credentialFileNotice } from "./credential-file.mjs";

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error("usage: node gmail-auth.mjs <client_id> <client_secret>");
  process.exit(1);
}

const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/oauth`;
const state = crypto.randomBytes(16).toString("hex");

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", REDIRECT);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/gmail.readonly");
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
    res.end("Done — your terminal has the path of the credentials file. Close this tab.");
    // DECISION (AGENTS.md "never log secrets"): these three values are NOT
    // printed. They go to an owner-only file and stdout gets its path plus the
    // variable names, so running this helper inside an agent session cannot
    // write a credential into the stored session transcript. There is no
    // exemption for this helper — if you add a step here, it keeps this shape.
    const vars = {
      GMAIL_CLIENT_ID: clientId,
      GMAIL_CLIENT_SECRET: clientSecret,
      GMAIL_REFRESH_TOKEN: tokens.refresh_token,
    };
    const file = writeCredentialFile("tts-gmail-credentials.env", vars);
    console.log(
      credentialFileNotice(file, Object.keys(vars), [
        "Append them to /etc/tts/worker.env on the Jarvis Box (substitute your host):",
        `  scp ${file} root@<jarvis-box>:/tmp/gmail-credentials.env`,
        "  ssh root@<jarvis-box> 'cat /tmp/gmail-credentials.env >> /etc/tts/worker.env" +
          " && rm /tmp/gmail-credentials.env'",
      ]),
    );
  } catch (err) {
    res.writeHead(500).end(String(err.message));
    console.error(`token exchange failed: ${err.message}`);
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log("Open this URL in your browser and approve read-only Gmail access:\n");
  console.log(authUrl.toString());
});
