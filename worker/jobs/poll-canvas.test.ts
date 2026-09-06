// Regression guard for the two spellings poll-canvas.mjs has to keep straight.
// The job cannot be run end-to-end anywhere yet — CANVAS_TOKEN is unset on the
// Jarvis Box (WPI restricts access-token creation) — so the request it BUILDS
// is the only thing that can be checked, and it is exactly what was wrong:
// the announcements request named its course filter "context_code[]", Canvas
// saw no context (the docs make context_codes[] required), answered non-ok,
// and the job threw on every single run.
//
// Importing the job module is safe: it only calls main() when node was pointed
// at the file (the `invokedDirectly` guard at the bottom of poll-canvas.mjs).
import { describe, expect, it } from "vitest";
// A plain-JS worker job (deployed to the Jarvis Box as .mjs); the test reads
// its pure exports, which TypeScript infers straight from the source.
import {
  ANNOUNCEMENTS_CONTEXT_LIMIT,
  ANNOUNCEMENTS_CONTEXT_PARAM,
  ANNOUNCEMENT_SOURCE,
  CANVAS_AUTH_STATUSES,
  FUTURE_WINDOW_DAYS,
  MAX_LOOKBACK_MS,
  PAST_GRACE_DAYS,
  announcementProvenance,
  canvasUrl,
  mapCanvasAssignments,
  tokenExpiredMessage,
  windowStart,
} from "./poll-canvas.mjs";

const env = { CANVAS_TOKEN: "x" };
const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 8, 1, 12);

describe("the announcements request", () => {
  it("names the course filter in the plural, once per context code", () => {
    // GET /api/v1/announcements takes context_codes[] (plural). The RESPONSE
    // field is singular context_code — that asymmetry is the whole trap.
    expect(ANNOUNCEMENTS_CONTEXT_PARAM).toBe("context_codes[]");

    const url = canvasUrl(env, "/api/v1/announcements", {
      [ANNOUNCEMENTS_CONTEXT_PARAM]: ["course_17", "course_18"],
      start_date: "2026-08-25",
      per_page: 50,
    });
    expect(url.searchParams.getAll("context_codes[]")).toEqual([
      "course_17",
      "course_18",
    ]);
    // The singular spelling is what Canvas ignores; nothing may send it.
    expect(url.searchParams.getAll("context_code[]")).toEqual([]);
    expect(url.origin).toBe("https://canvas.wpi.edu"); // default base
    expect(url.searchParams.get("start_date")).toBe("2026-08-25");
  });

  it("batches at the endpoint's stated limit of 10 context codes", () => {
    expect(ANNOUNCEMENTS_CONTEXT_LIMIT).toBe(10);
  });

  it("honours CANVAS_BASE_URL, trailing slash and all", () => {
    const url = canvasUrl(
      { ...env, CANVAS_BASE_URL: "https://canvas.example.edu/" },
      "/api/v1/courses",
      { enrollment_state: "active", per_page: 100, unset: undefined },
    );
    expect(url.toString()).toBe(
      "https://canvas.example.edu/api/v1/courses?enrollment_state=active&per_page=100",
    );
  });
});

describe("the window a run asks for", () => {
  it("starts at the cursor while the cursor is recent", () => {
    const cursor = NOW - 3 * DAY;
    expect(windowStart(cursor, NOW)).toBe(cursor);
  });

  it("never starts so far back that Canvas's window ends before now", () => {
    // Canvas defaults end_date to start_date + 28 days. A two-month-old cursor
    // would ask for a window that closed a month ago: nothing recent comes
    // back, nothing is processed, the cursor never advances — blind forever.
    const stale = NOW - 60 * DAY;
    const from = windowStart(stale, NOW);
    expect(from).toBe(NOW - MAX_LOOKBACK_MS);
    expect(from + MAX_LOOKBACK_MS).toBeGreaterThanOrEqual(NOW);
  });

  it("caps a returning-from-outage backlog at 28 days", () => {
    expect(MAX_LOOKBACK_MS).toBe(28 * DAY);
  });
});

describe("what an announcement todo is labelled", () => {
  it("writes its own source, never the assignment sync's", () => {
    // convex/ttsCanvas.ts owns "canvas" and reads every row under it as an
    // assignment. An announcement written there is read and dropped on every
    // sync, silently — hence a second name.
    expect(ANNOUNCEMENT_SOURCE).toBe("canvas-announcement");
  });

  it("carries the announcement id first, link second", () => {
    expect(announcementProvenance("991", "https://canvas.wpi.edu/courses/1/d/991")).toBe(
      "canvas:announcement:991 https://canvas.wpi.edu/courses/1/d/991",
    );
    // No html_url in the payload still leaves an id to identify the row by.
    expect(announcementProvenance("991", "")).toBe("canvas:announcement:991");
  });
});

// ── Assignments (the lifeos update, phase 6) ─────────────────────────────────
// This mapping used to live in convex/ttsCanvas.ts, where a Convex cron action
// held a second copy of CANVAS_TOKEN. One job and one credential copy own
// Canvas now, so the fetch and the window came here with it. The mutation that
// writes todos stayed in Convex — writing todos has to be one — and its own
// tests are convex/ttsCanvas.test.ts.
describe("mapCanvasAssignments", () => {
  const URL_15 = "https://canvas.wpi.edu/courses/1/assignments/15";
  const now = Date.UTC(2026, 7, 27, 12); // window: 2026-08-13 .. 2026-10-26

  it("windows 14 days back and 60 days on, the recently overdue included", () => {
    // Recently overdue still needs handling; an exam two months out is not
    // today's obligation and would sit in the list for weeks.
    expect(PAST_GRACE_DAYS).toBe(14);
    expect(FUTURE_WINDOW_DAYS).toBe(60);
  });

  it("keeps only published, dated, in-window assignments", () => {
    const courses = [
      { id: 1, course_code: "CS4241", name: "Webware" },
      { id: 2, name: "Mathematical Modeling" }, // no course_code -> name
    ];
    const byCourse = new Map([
      [
        1,
        [
          { id: 10, name: "draft", due_at: "2026-08-30T03:59:00Z", published: false },
          { id: 11, name: "no date", due_at: null, published: true },
          { id: 12, name: "final exam", due_at: "2026-12-01T05:00:00Z" }, // past windowEnd
          { id: 13, name: "week 1", due_at: "2026-07-20T05:00:00Z" }, // before windowStart
          { id: 14, name: "unparseable", due_at: "not a date" },
          {
            id: 15,
            name: "Project 3",
            html_url: URL_15,
            due_at: "2026-08-30T03:59:00Z",
            published: true,
            submission: { submitted_at: null },
          },
        ],
      ],
      [
        2,
        [
          {
            id: 20,
            name: "HW 5",
            html_url: "https://canvas.wpi.edu/courses/2/assignments/20",
            due_at: "2026-08-25T03:59:00Z",
            submission: { submitted_at: "2026-08-24T18:02:00Z" },
          },
        ],
      ],
    ]);

    const out = mapCanvasAssignments(courses, byCourse, now);
    expect(out.map((a) => a.externalId)).toEqual(["15", "20"]);
    expect(out[0]).toEqual({
      externalId: "15",
      courseCode: "CS4241",
      name: "Project 3",
      htmlUrl: URL_15,
      dueAt: Date.UTC(2026, 7, 30, 3, 59),
      submitted: false,
    });
    // course_code absent -> the course name stands in as the statement prefix.
    expect(out[1].courseCode).toBe("Mathematical Modeling");
    expect(out[1].submitted).toBe(true);
  });

  it("posts the whole window every run — the sync is what dedupes", () => {
    // No cursor on this half: it is a full reconciliation, and the sync keys
    // each row by its canvas:assignment:<id> provenance. Two identical runs
    // therefore produce identical payloads, which is what makes a replay safe.
    const courses = [{ id: 1, course_code: "CS4241" }];
    const byCourse = new Map([
      [1, [{ id: 15, name: "Project 3", html_url: URL_15, due_at: "2026-08-30T03:59:00Z" }]],
    ]);
    expect(mapCanvasAssignments(courses, byCourse, now)).toEqual(
      mapCanvasAssignments(courses, byCourse, now),
    );
  });
});

describe("a dead Canvas token", () => {
  it("is the two statuses that mean the token, not the request", () => {
    expect([...CANVAS_AUTH_STATUSES].sort()).toEqual([401, 403]);
  });

  it("is reported in words that say what to do, not as a status line", () => {
    // This message reaches Tom in the morning digest, so it has to be
    // actionable on its own — he is not going to read /var/log/tts.
    const message = tokenExpiredMessage(401);
    expect(message).toContain("expired or been revoked");
    expect(message).toContain("CANVAS_TOKEN");
    expect(message).toContain("/etc/tts/worker.env");
    expect(message).toContain("HTTP 401");
  });
});
