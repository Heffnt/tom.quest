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
//   1. does the mail imply an action? → capture it as a todo. Judged
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
// The writing standard comes from the deployment through GET
// /tts/capture-context. One read also carries the declined-integration list.
//
// ONE VERDICT PER MAIL, and the cursor never passes a mail without one. The
// model echoes the ids it was given, so it can garble one, invent one, or say
// nothing about a mail at all. Silence used to read as "skip": the mail was
// passed over and the cursor moved past it, which lost it for good. The answer
// is now reconciled against the batch (tts-lib.mjs reconcileVerdicts), every
// unanswered mail and every id that was not in the batch is reported through
// POST /tts/job-failed keyed on the mail, and the run stops at the oldest
// unanswered one so the next run reads it again.
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
  reconcileVerdicts,
  reportUntriaged,
  runClaude,
  JSON_ONLY_ANSWER,
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
export function gmailTriagePrompt(writingStandard, batch) {
  return [
    writingStandard,
    ``,
    `You triage Tom's Gmail inbox for his todo system (TTS).`,
    `For each captured email write "statement": ONE line naming the action,`,
    `starting with a verb and mentioning who it involves.`,
    ``,
    `For every captured email, include "needsTomToday". Include "why" only when`,
    `it is true. An email you do not capture has no second judgement at all.`,
    `"why" IS PRINTED TO TOM in the message that asks him to settle it, so write`,
    `it as half a sentence he can read — "the deposit is six weeks late", not`,
    `"overdue" — and never name the sender or quote the subject line.`,
    ``,
    `ANSWER FOR EVERY EMAIL BELOW - one entry each, in the order given, with "id"`,
    `copied EXACTLY as it appears. An email you are not capturing is`,
    `{"id": "...", "capture": false} and nothing else. Leaving an email out is not`,
    `a "no": a missing or misspelled id is a lost verdict, it is reported, and the`,
    `run stops there rather than passing the email over.`,
    ``,
    JSON_ONLY_ANSWER,
    `{"verdicts": [{"id": "<gmail message id>", "capture": <true|false>, "statement": "<one line, only when capture is true>", "needsTomToday": <true|false>, "why": "<a few words, only when needsTomToday is true>"}]}`,
    ``,
    `Emails:`,
    JSON.stringify(batch.map(({ id, from, subject, snippet }) => ({ id, from, subject, snippet })), null, 2),
  ].join("\n");
}

export function messageSourceId(id) {
  return `gmail:message:${id}`;
}
export function messageProvenance(id) {
  return `${messageSourceId(id)} https://mail.google.com/mail/u/0/#all/${id}`;
}

// THE JOB NO LONGER COMPOSES THE MESSAGE (slack-design.md §4.5). It sends
// FACTS — the todo, the reason, and the dedupe key — and convex/ttsSlack.ts
// writes the needs-you thread from the todo's own statement and entry action.
// The raw vendor subject and the From header stay out of Slack entirely: they
// are on the needs-tom row and in the key, which is where they belong. Three
// of these arrived in one week and all three were vendor security mail whose
// subject lines read, in #tts, as if TTS had written them.

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
  // ONE read of the capture context per run — the declined list and writing
  // standard the prompt below uses are the same payload.
  const context = await captureContext(env);
  if (typeof context.writingStandard !== "string" || context.writingStandard.trim() === "") {
    throw new Error("model-of-tom layer write is not stored");
  }
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

  const prompt = gmailTriagePrompt(context.writingStandard, batch);

  const answer = runClaude(prompt, { timeoutMs: 5 * 60 * 1000 });
  const { verdicts } = extractJsonObject(answer);
  if (!Array.isArray(verdicts)) throw new Error("triage answer has no verdicts array");
  // What the model said about what it was given — and what it did not say.
  const { byId, unmatched, unresolved } = reconcileVerdicts(
    batch.map((m) => m.id),
    verdicts,
  );
  const byMessageId = new Map(batch.map((m) => [m.id, m]));
  // Reported BEFORE anything is processed: a crash in the loop below must not
  // cost Tom the news that the model lost a mail.
  await reportUntriaged(env, "poll-gmail", {
    untriaged: unresolved.map((id) => {
      const m = byMessageId.get(id);
      return {
        sourceId: messageSourceId(id),
        label: `"${m.subject || "(no subject)"}" from ${m.from || "(no sender)"}`,
      };
    }),
    unmatched,
  });
  const untriaged = new Set(unresolved);

  let captured = 0;
  let threads = 0;
  let processed = 0;
  for (const message of batch) {
    // THE CURSOR NEVER PASSES AN UNTRIAGED MAIL. Everything after it waits for
    // the next run too — advancing past it and coming back later would
    // re-capture what this run already captured.
    if (untriaged.has(message.id)) break;
    const verdict = byId.get(message.id);
    if (verdict.capture) {
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
            reason: verdict.why,
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
    processed++;
  }
  console.log(
    `[poll-gmail] processed ${processed} of ${batch.length}, captured ${captured}, ` +
      `threads opened ${threads}` +
      (unresolved.length > 0
        ? `, held at ${unresolved.length} untriaged (reported to TTS)`
        : "") +
      (unmatched.length > 0 ? `, ${unmatched.length} unmatched id(s) in the answer` : ""),
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
