#!/usr/bin/env node
// poll-canvas.mjs — read new Canvas course announcements, triage with
// headless Claude, and capture the ACTION-IMPLYING ones as unprepared TTS
// todos (source "canvas-announcement"). The announcements counterpart of
// poll-gmail.mjs; assignments are handled separately by the Convex sync
// (convex/ttsCanvas.ts), which owns due dates and auto-done on submission.
//
// TWO SOURCES, ONE LMS (fixed 2026-09-01): this job writes
// "canvas-announcement" and the assignment sync writes "canvas". They were
// one label until the sync's by_source read — which keys every "canvas" row
// by the `canvas:assignment:<id>` provenance shape — started silently
// dropping every announcement it read. One label, one fact.
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
// cursor trade). A cursor older than MAX_LOOKBACK_MS is clamped, so no run
// ever asks for a window that ends before now (see MAX_LOOKBACK_MS).

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv, convexFetch, runClaude, extractJsonObject } from "./tts-lib.mjs";

const CURSOR_FILE = "/var/lib/tts/canvas-announcements-cursor";
const FIRST_RUN_LOOKBACK_MS = 7 * 24 * 3600 * 1000;
const MAX_CANDIDATES = 20; // per run; the 30-minute cadence drains a backlog

// The furthest back a request may start. Canvas defaults `end_date` to
// start_date + 28 days, so a start older than this asks for a window that ENDS
// in the past: the run sees nothing recent, the cursor never advances past it,
// and the job stays blind forever. Clamping the start keeps every window
// touching now, and caps what a long outage can deliver at once (28 days of
// announcements, MAX_CANDIDATES per 30-minute run).
export const MAX_LOOKBACK_MS = 28 * 24 * 3600 * 1000;

/** Pure: the `start_date` a run asks Canvas for, given its cursor. */
export function windowStart(cursor, now) {
  return Math.max(cursor, now - MAX_LOOKBACK_MS);
}

/** The todo source this job writes. Announcements only — see the header. */
export const ANNOUNCEMENT_SOURCE = "canvas-announcement";

// The announcements endpoint names its course filter in the PLURAL
// (GET /api/v1/announcements?context_codes[]=course_17). The singular spelling
// looks right because the RESPONSE field is singular — each announcement
// carries one `context_code` — and it fails LOUDLY but blindly: Canvas sees no
// context at all, answers 400, and canvas() below throws, so the job dies at
// the same place a missing course would kill it. Kept as a named constant so
// the plural is stated once and testable (poll-canvas.test.ts).
export const ANNOUNCEMENTS_CONTEXT_PARAM = "context_codes[]";
/** Announcements accepted per request by Canvas. */
export const ANNOUNCEMENTS_CONTEXT_LIMIT = 10;

/**
 * Pure: the provenance an announcement todo carries — the id first, then the
 * link, the same "id + link" shape canvasProvenance writes for assignments
 * (convex/ttsCanvas.ts). The id leads so it survives an announcement with no
 * html_url, and so a reader can tell the two Canvas paths apart by eye.
 * Exported for tests.
 */
export function announcementProvenance(id, htmlUrl) {
  return htmlUrl ? `canvas:announcement:${id} ${htmlUrl}` : `canvas:announcement:${id}`;
}

/** Pure: the Canvas URL a call builds, array params repeated. Exported for tests. */
export function canvasUrl(env, path, params = {}) {
  const base = (env.CANVAS_BASE_URL || "https://canvas.wpi.edu").replace(/\/+$/, "");
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
    else url.searchParams.set(k, String(v));
  }
  return url;
}

async function canvas(env, path, params = {}) {
  const url = canvasUrl(env, path, params);
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
  const from = windowStart(cursor, Date.now());

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
  for (let i = 0; i < contextCodes.length; i += ANNOUNCEMENTS_CONTEXT_LIMIT) {
    announcements.push(
      ...(await canvas(env, "/api/v1/announcements", {
        [ANNOUNCEMENTS_CONTEXT_PARAM]: contextCodes.slice(
          i,
          i + ANNOUNCEMENTS_CONTEXT_LIMIT,
        ),
        start_date: new Date(from).toISOString().slice(0, 10),
        per_page: 50,
      })),
    );
  }
  // What the window actually returned, before triage — the one line that
  // answers "how many announcements come back, and how far back do they
  // reach?" on the first run after the credential lands.
  const postedAts = announcements
    .map((a) => Date.parse(a.posted_at ?? ""))
    .filter((ms) => Number.isFinite(ms));
  console.log(
    `[poll-canvas] window from ${new Date(from).toISOString()}: ` +
      `${courses.length} courses, ${announcements.length} announcements` +
      (postedAts.length > 0
        ? `, oldest ${new Date(Math.min(...postedAts)).toISOString()}, newest ${new Date(Math.max(...postedAts)).toISOString()}`
        : ""),
  );

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

  const prompt = `You triage Canvas course announcements for Tom's todo system (TTS).
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
        source: ANNOUNCEMENT_SOURCE,
        provenance: announcementProvenance(a.id, a.htmlUrl),
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

// Run ONLY when node was pointed at this file (cron: `node /opt/tts/poll-canvas
// .mjs`). A test that imports the pure helpers above must not fire the job —
// and worker/setup.sh copies the jobs to /opt/tts rather than symlinking them,
// so realpath on both sides is the same real file either way.
const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[poll-canvas] FAILED: ${err.message}`);
    process.exit(1);
  });
}
