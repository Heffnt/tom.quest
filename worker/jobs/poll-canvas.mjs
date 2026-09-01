#!/usr/bin/env node
// poll-canvas.mjs — read new Canvas course announcements, triage with
// headless Claude, and capture the ACTION-IMPLYING ones as unprepared TTS
// todos (source "canvas"). The announcements counterpart of poll-gmail.mjs;
// assignments are handled separately by the Convex sync
// (convex/ttsCanvas.ts), which owns due dates and auto-done on submission.
//
// Run by cron every 30 minutes (see /etc/cron.d/tts). Also runnable by hand:
//   node /opt/tts/poll-canvas.mjs
//
// CREDENTIALS (in /etc/tts/worker.env; quiet no-op until set — WPI restricts
// Canvas access-token creation, and Tom has a request form pending):
//   CANVAS_TOKEN     — personal access token (Canvas → Account → Settings →
//                      "+ New access token"). The SAME token also goes in the
//                      Convex env for the assignment sync — two consumers,
//                      one credential, pasted in both places.
//   CANVAS_BASE_URL  — optional; defaults to https://canvas.wpi.edu.
//
// TRIAGE: one non-agentic Claude call per batch, under the capture-triage
// defaults (WikiTom model-of-tom/skills/capture-triage/SKILL.md): capture
// what implies an action by Tom, skip the purely informational, lean toward
// capturing when unsure.
//
// STATE: /var/lib/tts/canvas-announcements-cursor holds the posted_at epoch
// ms of the newest PROCESSED announcement. Losing it re-examines the last
// 7 days — at worst a few duplicate captures Tom can archive (the poll-dump
// cursor trade).

import fs from "node:fs";
import { loadEnv, convexFetch, runClaude, extractJsonObject } from "./tts-lib.mjs";

const CURSOR_FILE = "/var/lib/tts/canvas-announcements-cursor";
const FIRST_RUN_LOOKBACK_MS = 7 * 24 * 3600 * 1000;
const MAX_CANDIDATES = 20; // per run; the 30-minute cadence drains a backlog

async function canvas(env, path, params = {}) {
  const base = (env.CANVAS_BASE_URL || "https://canvas.wpi.edu").replace(/\/+$/, "");
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
    else url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.CANVAS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`canvas ${path} -> HTTP ${res.status}`);
  return await res.json();
}

// Strip HTML to readable text for the triage prompt (announcement bodies are
// HTML). Crude on purpose — the model only needs the substance.
function textOfHtml(html) {
  return String(html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const env = loadEnv();
  if (!env.CANVAS_TOKEN) {
    console.log("[poll-canvas] not configured (CANVAS_TOKEN missing) — skipping");
    return;
  }

  let cursor = 0;
  try {
    cursor = Number(fs.readFileSync(CURSOR_FILE, "utf8").trim()) || 0;
  } catch {
    // First run (or a rebuilt Jarvis Box): look back 7 days only.
  }
  if (cursor === 0) cursor = Date.now() - FIRST_RUN_LOOKBACK_MS;

  const courses = await canvas(env, "/api/v1/courses", {
    enrollment_state: "active",
    per_page: 100,
  });
  const courseCodeById = new Map(
    courses.map((c) => [c.id, c.course_code ?? c.name ?? `course ${c.id}`]),
  );
  if (courses.length === 0) return;

  // The announcements endpoint takes at most 10 context codes per request.
  const contextCodes = courses.map((c) => `course_${c.id}`);
  const announcements = [];
  for (let i = 0; i < contextCodes.length; i += 10) {
    announcements.push(
      ...(await canvas(env, "/api/v1/announcements", {
        "context_code[]": contextCodes.slice(i, i + 10),
        start_date: new Date(cursor).toISOString().slice(0, 10),
        per_page: 50,
      })),
    );
  }

  const candidates = announcements
    .map((a) => ({
      id: String(a.id),
      postedAt: Date.parse(a.posted_at ?? "") || 0,
      courseCode:
        courseCodeById.get(Number((a.context_code ?? "").replace("course_", ""))) ??
        a.context_code ??
        "",
      title: a.title ?? "(untitled)",
      body: textOfHtml(a.message).slice(0, 500),
      htmlUrl: a.html_url ?? "",
    }))
    .filter((a) => a.postedAt > cursor)
    .sort((a, b) => a.postedAt - b.postedAt)
    .slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) return;

  const prompt = `You triage Canvas course announcements for TTS (Toms Todo System).
Below is a JSON array of new announcements (course, title, first 500 characters
of the body). Decide which ones imply an ACTION BY TOM — something he must
submit, respond to, sign up for, prepare, bring, attend at a changed time, or
decide. Skip purely informational announcements (grades posted, general
encouragement, restated syllabus policy). When genuinely unsure, lean toward
capturing: a wrong capture costs one archive click, a wrong skip loses a
deadline.

For each captured announcement write "statement": ONE line naming the action in
plain words, starting with a verb, naming the course (e.g. "Sign up for the
CS 4241 project demo slot"). Do not invent details the text does not support.

Answer with ONLY this JSON object, no fences, no commentary:
{"captures": [{"id": "<announcement id>", "statement": "<one line>"}]}
An empty list is {"captures": []}.

Announcements:
${JSON.stringify(candidates.map(({ id, courseCode, title, body }) => ({ id, courseCode, title, body })), null, 2)}`;

  const answer = runClaude(prompt, { timeoutMs: 5 * 60 * 1000 });
  const { captures } = extractJsonObject(answer);
  if (!Array.isArray(captures)) throw new Error("triage answer has no captures array");
  const statementById = new Map(
    captures
      .filter((c) => c && typeof c.id === "string" && typeof c.statement === "string")
      .map((c) => [c.id, c.statement]),
  );

  let captured = 0;
  for (const a of candidates) {
    const statement = statementById.get(a.id);
    if (statement) {
      const result = await convexFetch(env, "/tts/capture", {
        statement,
        source: "canvas",
        provenance: a.htmlUrl || `canvas:announcement:${a.id}`,
      });
      captured++;
      console.log(
        `[poll-canvas] captured id=${result.id ?? "?"} "${statement.slice(0, 70)}"`,
      );
    }
    // Advance after EVERY processed announcement, so a crash mid-batch
    // re-processes at most the one in flight.
    fs.writeFileSync(CURSOR_FILE, String(a.postedAt));
  }
  console.log(`[poll-canvas] processed ${candidates.length}, captured ${captured}`);
}

main().catch((err) => {
  console.error(`[poll-canvas] FAILED: ${err.message}`);
  process.exit(1);
});
