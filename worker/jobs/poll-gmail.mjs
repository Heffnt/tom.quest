#!/usr/bin/env node
// poll-gmail.mjs — read new Gmail inbox mail, triage with headless Claude,
// capture the ACTION-IMPLYING messages as unprepared TTS todos (source
// "email"), and open ONE #tts thread for each one that needs Tom TODAY.
// Spec: WikiTom tts/spec.md §17 post-MVP priority 1; the lifeos update,
// phase 6.
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
// TWO JUDGEMENTS, ONE CLAUDE CALL PER BATCH, and they are different questions:
//
//   1. does the mail imply an ACTION BY TOM? → capture it as a todo. Judged
//      from headers + Gmail's snippet only (the first ~100 chars) — v1
//      deliberately never downloads bodies. A capture is a todo, so a wrong
//      "actionable" call costs Tom one archive click while a wrong "skip" call
//      costs a lost thread; the prompt leans toward capturing.
//   2. does it need TOM, TODAY? → open one thread in #tts on that todo, so his
//      reply is the next turn. This is CAPTURE TRIAGE, not an importance
//      rating: three facts and no others make it true (a deadline inside 48
//      hours, a named person waiting on a reply, money or credentials), and
//      everything else waits for the 5 a.m. digest, which reports every
//      capture. Nothing is lost either way.
//
// The rules for both come from the deployment, not from this file: GET
// /tts/capture-context serves the synced WikiTom capture-triage text (WikiTom
// model-of-tom/priorities.md, through the ttsSkills row), falling back to the
// copy in convex/ttsShared.ts until the sync has run. One home for the rules,
// so poll-canvas and poll-outlook read the same words.
//
// STATE: /var/lib/tts/gmail-cursor holds the internalDate (epoch ms) of the
// newest PROCESSED message (captured or skipped). FORMAT UNCHANGED by phase 6
// — still one epoch-ms integer, so no cursor migration is needed and a box
// mid-upgrade keeps reading its own file. Losing it re-examines the last 24h,
// which at worst re-captures a few emails as duplicate todos (the poll-dump
// cursor trade) and CANNOT re-open a #tts thread: the thread is deduped
// server-side on the Gmail message id, not on this cursor.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  captureContext,
  convexFetch,
  declined,
  declinedLine,
  extractJsonObject,
  loadEnv,
  runClaude,
  ttsItemLink,
} from "./tts-lib.mjs";

const CURSOR_FILE = "/var/lib/tts/gmail-cursor";
const FIRST_RUN_LOOKBACK_MS = 24 * 3600 * 1000;
const MAX_CANDIDATES = 25; // per run; the 10-minute cadence drains any backlog

/**
 * Pure: the STABLE SOURCE ID of one Gmail message — the id first, then the
 * link, the same "id + link" shape poll-canvas writes for announcements and
 * convex/ttsCanvas.ts for assignments. The id leads so a reader can tell the
 * producers apart by eye and so a machine can key on the message without
 * parsing a URL fragment. (Before phase 6 this was the bare #all link, which
 * carried the same id but only inside a URL.) The #all link resolves
 * regardless of which label the thread has since moved to.
 * Exported for tests.
 */
export function messageSourceId(id) {
  return `gmail:message:${id}`;
}
export function messageProvenance(id) {
  return `${messageSourceId(id)} https://mail.google.com/mail/u/0/#all/${id}`;
}

/**
 * Pure: the ONE line a #tts thread opens with — who it is from, what it is
 * about, and where the todo is. Nothing else: the thread exists so Tom can
 * reply, and his reply is the next turn on that todo.
 * Exported for tests.
 */
export function needsTomLine(from, subject, todoId) {
  return `Needs you today — ${from}: ${subject}\n${ttsItemLink(todoId)}`;
}

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

/** The name Tom declines this job by: `integration: gmail`. */
export const INTEGRATION_NAME = "gmail";

async function main() {
  const env = loadEnv();
  // ONE read of the capture context per run — the declined list and the triage
  // rules the prompt below is built from are the same payload.
  const context = await captureContext(env);
  // FIRST, before the credential and before any read: an integration Tom has
  // declined does not run (worker/jobs/tts-lib.mjs declined()).
  const ruling = declined(context, INTEGRATION_NAME);
  if (ruling) {
    console.log(declinedLine("poll-gmail", ruling));
    return;
  }
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

  // The deployment's own capture-triage rules, not a copy written here — off
  // the one context this run already read.
  const { captureTriage } = context;

  const prompt = `You triage Tom's Gmail inbox for his todo system (TTS).
Below is a JSON array of new emails (headers + a ~100-character snippet).

${captureTriage}

For each captured email write "statement": ONE line naming the action in plain
words, starting with a verb, mentioning who it involves (e.g. "Reply to Sarah
Chen about the lab meeting time"). Do not invent details the snippet does not
support — when the action is unclear, "Read and handle email from X: <subject>"
is the honest statement.

Also answer the second judgement for each captured email: set "needsTomToday"
to true only when one of the three named facts holds, and in "why" name which
one in a few words ("deadline Friday", "Sarah is waiting on a reply", "invoice
due"). Set it to false and omit "why" otherwise. An email you do not capture
has no second judgement at all.

Answer with ONLY this JSON object, no fences, no commentary:
{"captures": [{"id": "<gmail message id>", "statement": "<one line>", "needsTomToday": <true|false>, "why": "<a few words, only when true>"}]}
An empty list is {"captures": []}.

Emails:
${JSON.stringify(batch.map(({ id, from, subject, snippet }) => ({ id, from, subject, snippet })), null, 2)}`;

  const answer = runClaude(prompt, { timeoutMs: 5 * 60 * 1000 });
  const { captures } = extractJsonObject(answer);
  if (!Array.isArray(captures)) throw new Error("triage answer has no captures array");
  const verdictById = new Map(
    captures
      .filter((c) => c && typeof c.id === "string" && typeof c.statement === "string")
      .map((c) => [
        c.id,
        {
          statement: c.statement,
          needsTomToday: c.needsTomToday === true,
          why: typeof c.why === "string" ? c.why : "",
        },
      ]),
  );

  let captured = 0;
  let threads = 0;
  for (const message of batch) {
    const verdict = verdictById.get(message.id);
    if (verdict) {
      const result = await convexFetch(env, "/tts/capture", {
        statement: verdict.statement,
        source: "email",
        provenance: messageProvenance(message.id),
      });
      captured++;
      console.log(
        `[poll-gmail] captured id=${result.id ?? "?"} "${verdict.statement.slice(0, 70)}"`,
      );
      // NEEDS TOM TODAY: one thread in #tts, deduped server-side on the Gmail
      // message id. A thread that cannot be opened must not cost the capture
      // that already landed, so a refusal is reported and the run continues —
      // the item is still a todo and the morning digest still reports it.
      if (verdict.needsTomToday && result.id) {
        try {
          const opened = await convexFetch(env, "/tts/needs-tom", {
            todoId: result.id,
            text: needsTomLine(message.from, message.subject, result.id),
            key: messageSourceId(message.id),
          });
          if (opened.opened) threads++;
          console.log(
            `[poll-gmail] needs Tom (${verdict.why || "no reason given"}): thread ` +
              `${opened.opened ? "opened" : "already open"} for ${result.id}`,
          );
        } catch (err) {
          console.error(`[poll-gmail] thread for ${result.id} refused: ${err.message}`);
        }
      }
    }
    // Advance after EVERY processed message (captured or skipped), so a crash
    // mid-batch re-processes at most the one in flight.
    fs.writeFileSync(CURSOR_FILE, String(message.internalDate));
  }
  console.log(
    `[poll-gmail] processed ${batch.length}, captured ${captured}, threads opened ${threads}`,
  );
}

// Run ONLY when node was pointed at this file — the same guard poll-canvas.mjs
// carries, and for the same reason: a test that imports the pure helpers above
// must not fire the job. worker/setup.sh copies the jobs to /opt/tts rather
// than symlinking them, so realpath on both sides is the same real file.
const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[poll-gmail] FAILED: ${err.message}`);
    process.exit(1);
  });
}
