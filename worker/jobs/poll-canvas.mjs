#!/usr/bin/env node
// poll-canvas.mjs — the ONE job that owns Canvas (the lifeos update, phase 6).
// Two halves, one credential, one 30-minute tick:
//
//   ASSIGNMENTS — every published, dated assignment in the window, posted to
//     POST /tts/canvas-assignments, which keeps one dtsTodos row per
//     assignment (source "canvas", dateKind "external", provenance
//     `canvas:assignment:<id> <url>`): the instructor's date is a fact and
//     moves the todo with it, and a submission on Canvas completes the todo.
//     No Claude call — an assignment with a due date IS an obligation, there
//     is nothing to judge.
//   ANNOUNCEMENTS — triaged by ONE headless Claude call per batch and captured
//     as unprepared todos (source "canvas-announcement") when they imply an
//     action by Tom.
//
// ONE JOB, ONE CREDENTIAL COPY. The assignments half used to be a Convex cron
// action (convex/ttsCanvas.ts internalRefreshCanvas) holding a second copy of
// CANVAS_TOKEN in the deployment env. Two jobs polling one LMS on two
// schedules with the same token pasted in two places is what phase 6 removed:
// the token now lives ONLY in /etc/tts/worker.env, and what stayed in Convex
// is the sync mutation, because writing todos has to be one.
//
// TWO SOURCES, ONE LMS (fixed 2026-09-01): the announcements half writes
// "canvas-announcement" and the assignments half writes "canvas". They were
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
//                      "+ New access token"). ONE copy, here. It is no longer
//                      in the Convex env.
//   CANVAS_BASE_URL  — optional; defaults to https://canvas.wpi.edu.
//
// A DEAD TOKEN IS REPORTED, NOT BURIED. A Canvas access token expires or is
// revoked and Canvas answers 401/403; the job then writes a dtsEvents
// "job-failed" row (POST /tts/job-failed) whose message says in plain words
// what happened and what to do, so it reaches Tom in the morning digest
// instead of sitting in /var/log/tts where nobody reads it.
//
// TRIAGE (announcements): one non-agentic Claude call per batch, under the
// deployment's own capture-triage rules — GET /tts/capture-context, the synced
// WikiTom text with a fallback copy in convex/ttsShared.ts. The same words
// poll-gmail triages by; no job keeps its own set.
//
// STATE: /var/lib/tts/canvas-announcements-cursor holds the posted_at epoch
// ms of the newest PROCESSED announcement. Losing it re-examines the last
// 7 days — at worst a few duplicate captures Tom can archive (the poll-dump
// cursor trade). A cursor older than MAX_LOOKBACK_MS is clamped, so no run
// ever asks for a window that ends before now (see MAX_LOOKBACK_MS). The
// ASSIGNMENTS half keeps no cursor at all: it is a full reconciliation of the
// window on every run, and the sync is keyed by assignment id.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  captureContext,
  convexFetch,
  extractJsonObject,
  loadEnv,
  runClaude,
} from "./tts-lib.mjs";

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
// carries one `context_code` — and the failure names nothing: Canvas sees no
// context at all (the docs make context_codes[] required), answers non-ok, and
// canvas() below throws the same "-> HTTP <status>" a missing course would
// throw. Kept as a named constant so the plural is stated once and testable
// (poll-canvas.test.ts).
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

/** The HTTP statuses that mean the TOKEN is the problem, not the request. */
export const CANVAS_AUTH_STATUSES = new Set([401, 403]);

/**
 * Pure: the plain words a dead Canvas token is reported in. It reaches Tom in
 * the morning digest, so it says what happened and what to do about it — not
 * a status line. Exported for tests.
 */
export function tokenExpiredMessage(status) {
  return (
    `Canvas rejected the access token (HTTP ${status}) — it has expired or been ` +
    `revoked, so no assignments or announcements are being read. Mint a new one ` +
    `at Canvas → Account → Settings → "+ New access token" and put it in ` +
    `CANVAS_TOKEN in /etc/tts/worker.env.`
  );
}

async function canvasFetch(env, url, path) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.CANVAS_TOKEN}` },
  });
  if (!res.ok) {
    // `status` on the error is what the top-level handler reads to tell a dead
    // token apart from an ordinary upstream failure.
    const err = new Error(`canvas ${path} -> HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function canvas(env, path, params = {}) {
  return await (await canvasFetch(env, canvasUrl(env, path, params), path)).json();
}

/** Canvas paginates via Link headers; follow rel="next", bounded. */
export const CANVAS_MAX_PAGES = 10;

async function canvasAll(env, path, params = {}) {
  const out = [];
  let url = canvasUrl(env, path, params).toString();
  for (let page = 0; page < CANVAS_MAX_PAGES && url; page++) {
    const res = await canvasFetch(env, url, path);
    out.push(...(await res.json()));
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "");
    url = next ? next[1] : null;
  }
  return out;
}

// ── Assignments ──────────────────────────────────────────────────────────────

/** How far around now an unsubmitted assignment is worth a todo. */
export const PAST_GRACE_DAYS = 14; // recently overdue still needs handling
export const FUTURE_WINDOW_DAYS = 60;

const DAY_MS = 24 * 3600 * 1000;

/**
 * Pure: raw Canvas JSON → the sync inputs POST /tts/canvas-assignments takes.
 * The whole window is posted every run — the sync keys each one by its
 * assignment id, so a replay creates nothing.
 *
 * `courses` is the active-enrollment list; `assignmentsByCourse` maps a course
 * id to its assignments (with ?include[]=submission). Exported for tests.
 */
export function mapCanvasAssignments(courses, assignmentsByCourse, now) {
  const out = [];
  const windowStartMs = now - PAST_GRACE_DAYS * DAY_MS;
  const windowEnd = now + FUTURE_WINDOW_DAYS * DAY_MS;
  for (const course of courses) {
    const courseCode = course.course_code ?? course.name ?? `course ${course.id}`;
    for (const a of assignmentsByCourse.get(course.id) ?? []) {
      if (a.published === false) continue;
      if (!a.due_at) continue; // undated assignments are not obligations yet
      const dueAt = Date.parse(a.due_at);
      if (Number.isNaN(dueAt) || dueAt < windowStartMs || dueAt > windowEnd) continue;
      out.push({
        externalId: String(a.id),
        courseCode,
        name: a.name ?? `assignment ${a.id}`,
        htmlUrl: a.html_url ?? "",
        dueAt,
        submitted: Boolean(a.submission?.submitted_at),
      });
    }
  }
  return out;
}

/** The assignments half of a run: read the window, post it, report the counts. */
async function syncAssignments(env, courses) {
  const assignmentsByCourse = new Map();
  for (const course of courses) {
    assignmentsByCourse.set(
      course.id,
      await canvasAll(env, `/api/v1/courses/${course.id}/assignments`, {
        "include[]": "submission",
        per_page: 100,
      }),
    );
  }
  const assignments = mapCanvasAssignments(courses, assignmentsByCourse, Date.now());
  const result = await convexFetch(env, "/tts/canvas-assignments", { assignments });
  console.log(
    `[poll-canvas] assignments: seen ${result.seen ?? 0}, created ${result.created ?? 0}, ` +
      `completed ${result.completed ?? 0}, date moved ${result.dateMoved ?? 0}` +
      (result.foreign ? `, foreign rows ${result.foreign}` : ""),
  );
}

// ── Announcements ────────────────────────────────────────────────────────────

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

async function pollAnnouncements(env, courses) {
  let cursor = 0;
  try {
    cursor = Number(fs.readFileSync(CURSOR_FILE, "utf8").trim()) || 0;
  } catch {
    // First run (or a rebuilt Jarvis Box): look back 7 days only.
  }
  if (cursor === 0) cursor = Date.now() - FIRST_RUN_LOOKBACK_MS;
  const from = windowStart(cursor, Date.now());

  const courseCodeById = new Map(
    courses.map((c) => [c.id, c.course_code ?? c.name ?? `course ${c.id}`]),
  );

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

  // The deployment's own capture-triage rules, not a copy written here.
  const { captureTriage } = await captureContext(env);

  const prompt = `You triage Canvas course announcements for Tom's todo system (TTS).
Below is a JSON array of new announcements (course, title, first 500 characters
of the body).

${captureTriage}

Here an ACTION BY TOM is something he must submit, respond to, sign up for,
prepare, bring, attend at a changed time, or decide; the purely informational
announcements (grades posted, general encouragement, restated syllabus policy)
are the ones to skip. Answer only the FIRST judgement — a course announcement
reaches Tom in the morning digest, and the assignments half of this job already
carries every real deadline with its date.

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
  console.log(
    `[poll-canvas] announcements: processed ${candidates.length}, captured ${captured}`,
  );
}

async function main() {
  const env = loadEnv();
  if (!env.CANVAS_TOKEN) {
    console.log("[poll-canvas] not configured (CANVAS_TOKEN missing) — skipping");
    return;
  }

  // ONE course list for both halves. It used to be read twice on two
  // schedules by two jobs holding two copies of one token.
  const courses = await canvasAll(env, "/api/v1/courses", {
    enrollment_state: "active",
    per_page: 100,
  });
  if (courses.length === 0) {
    console.log("[poll-canvas] no active courses");
    return;
  }

  // ASSIGNMENTS FIRST, deliberately. They carry real deadlines with real
  // dates and cost no Claude call; the announcements half spends a five-minute
  // triage call that can time out. In that order a bad triage run costs only
  // the announcements, and the cursor makes the next tick pick them up again.
  await syncAssignments(env, courses);
  await pollAnnouncements(env, courses);
}

// Run ONLY when node was pointed at this file (cron: `node /opt/tts/poll-canvas
// .mjs`). A test that imports the pure helpers above must not fire the job —
// and worker/setup.sh copies the jobs to /opt/tts rather than symlinking them,
// so realpath on both sides is the same real file either way.
const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch(async (err) => {
    console.error(`[poll-canvas] FAILED: ${err.message}`);
    // A DEAD TOKEN IS A FACT TOM HAS TO ACT ON, and /var/log/tts is not where
    // he reads. Canvas answers 401/403 for an expired or revoked token; that
    // one case is reported as a dtsEvents "job-failed" row in plain words, so
    // the morning digest carries it. Everything else stays a log line and a
    // non-zero exit — the cron tick is the retry.
    if (CANVAS_AUTH_STATUSES.has(err.status)) {
      try {
        await convexFetch(loadEnv(), "/tts/job-failed", {
          job: "poll-canvas",
          error: tokenExpiredMessage(err.status),
        });
        console.error("[poll-canvas] reported the dead token to TTS");
      } catch (reportErr) {
        // Reporting a failure must not become a second unreported failure.
        console.error(`[poll-canvas] could not report it: ${reportErr.message}`);
      }
    }
    process.exit(1);
  });
}
