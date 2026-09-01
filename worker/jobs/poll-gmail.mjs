#!/usr/bin/env node
// poll-gmail.mjs — read new Gmail inbox mail, triage with headless Claude,
// and capture the ACTION-IMPLYING messages as unprepared TTS todos
// (source "email"). Spec: WikiTom tts/spec.md §17 post-MVP priority 1.
//
// Run by cron every 10 minutes (see /etc/cron.d/tts). Also runnable by hand:
//   node /opt/tts/poll-gmail.mjs
//
// CREDENTIALS (all in /etc/tts/worker.env; the job is a quiet no-op until
// they exist — same ships-ahead-of-the-credential posture as the Convex
// ingestion crons):
//   GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET — an OAuth "Desktop app" client
//       from Tom's Google Cloud console (any project; the Gmail API enabled).
//   GMAIL_REFRESH_TOKEN — minted ONCE by Tom on his own machine with
//       worker/jobs/gmail-auth.mjs (scope gmail.readonly), then pasted here.
//
// TRIAGE: one non-agentic Claude call per batch decides which messages imply
// an action by Tom and writes each one's capture statement. Judged from
// headers + Gmail's snippet only (the first ~100 chars) — v1 deliberately
// never downloads bodies. A capture is a todo, so a wrong "actionable" call
// costs Tom one archive click; a wrong "skip" call costs a lost thread —
// the prompt says to lean toward capturing when unsure.
//
// STATE: /var/lib/tts/gmail-cursor holds the internalDate (epoch ms) of the
// newest PROCESSED message (captured or skipped). Losing it re-examines the
// last 24h, which at worst re-captures a few emails as duplicate todos —
// same harmless-by-design trade as poll-dump's cursor.

import fs from "node:fs";
import { loadEnv, convexFetch, runClaude, extractJsonObject } from "./tts-lib.mjs";

const CURSOR_FILE = "/var/lib/tts/gmail-cursor";
const FIRST_RUN_LOOKBACK_MS = 24 * 3600 * 1000;
const MAX_CANDIDATES = 25; // per run; the 10-minute cadence drains any backlog

async function gmailToken(env) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`token refresh -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()).access_token;
}

async function gmail(token, path, params = {}) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
    else url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`gmail ${path} -> HTTP ${res.status}`);
  return await res.json();
}

function header(message, name) {
  const h = (message.payload?.headers ?? []).find(
    (x) => x.name?.toLowerCase() === name.toLowerCase(),
  );
  return h?.value ?? "";
}

async function main() {
  const env = loadEnv();
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    console.log("[poll-gmail] not configured (GMAIL_* missing) — skipping");
    return;
  }

  let cursor = 0;
  try {
    cursor = Number(fs.readFileSync(CURSOR_FILE, "utf8").trim()) || 0;
  } catch {
    // First run (or a rebuilt Jarvis Box): look back 24h only.
  }
  if (cursor === 0) cursor = Date.now() - FIRST_RUN_LOOKBACK_MS;

  const token = await gmailToken(env);

  // 'after:' has second granularity and is inclusive-ish; over-fetch by one
  // second and filter precisely on internalDate below.
  const query = `in:inbox after:${Math.floor(cursor / 1000) - 1}`;
  const list = await gmail(token, "messages", { q: query, maxResults: 100 });
  const ids = (list.messages ?? []).map((m) => m.id);
  if (ids.length === 0) return;

  const candidates = [];
  for (const id of ids) {
    const message = await gmail(token, `messages/${id}`, {
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });
    const internalDate = Number(message.internalDate ?? 0);
    if (internalDate <= cursor) continue; // boundary re-fetch — already processed
    candidates.push({
      id,
      internalDate,
      from: header(message, "From"),
      subject: header(message, "Subject"),
      snippet: message.snippet ?? "",
    });
  }
  if (candidates.length === 0) return;
  candidates.sort((a, b) => a.internalDate - b.internalDate);
  const batch = candidates.slice(0, MAX_CANDIDATES);

  const prompt = `You triage Tom's Gmail inbox for his todo system (TTS).
Below is a JSON array of new emails (headers + a ~100-character snippet).
Decide which ones imply an ACTION BY TOM — something he must reply to, submit,
schedule, pay, sign, decide, or follow up on. Skip newsletters, promotions,
automated notifications, receipts, and mass mail. When genuinely unsure, lean
toward capturing: a wrong capture costs one archive click, a wrong skip loses
the thread.

For each captured email write "statement": ONE line naming the action in plain
words, starting with a verb, mentioning who it involves (e.g. "Reply to Sarah
Chen about the lab meeting time"). Do not invent details the snippet does not
support — when the action is unclear, "Read and handle email from X: <subject>"
is the honest statement.

Answer with ONLY this JSON object, no fences, no commentary:
{"captures": [{"id": "<gmail message id>", "statement": "<one line>"}]}
An empty list is {"captures": []}.

Emails:
${JSON.stringify(batch.map(({ id, from, subject, snippet }) => ({ id, from, subject, snippet })), null, 2)}`;

  const answer = runClaude(prompt, { timeoutMs: 5 * 60 * 1000 });
  const { captures } = extractJsonObject(answer);
  if (!Array.isArray(captures)) throw new Error("triage answer has no captures array");
  const statementById = new Map(
    captures
      .filter((c) => c && typeof c.id === "string" && typeof c.statement === "string")
      .map((c) => [c.id, c.statement]),
  );

  let captured = 0;
  for (const message of batch) {
    const statement = statementById.get(message.id);
    if (statement) {
      const result = await convexFetch(env, "/tts/capture", {
        statement,
        source: "email",
        // The #all link resolves regardless of which label the thread sits in.
        provenance: `https://mail.google.com/mail/u/0/#all/${message.id}`,
      });
      captured++;
      console.log(
        `[poll-gmail] captured id=${result.id ?? "?"} "${statement.slice(0, 70)}"`,
      );
    }
    // Advance after EVERY processed message (captured or skipped), so a crash
    // mid-batch re-processes at most the one in flight.
    fs.writeFileSync(CURSOR_FILE, String(message.internalDate));
  }
  console.log(`[poll-gmail] processed ${batch.length}, captured ${captured}`);
}

main().catch((err) => {
  console.error(`[poll-gmail] FAILED: ${err.message}`);
  process.exit(1);
});
