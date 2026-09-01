// Regression guard for the two spellings poll-canvas.mjs has to keep straight.
// The job cannot be run end-to-end anywhere yet — CANVAS_TOKEN is unset on the
// Jarvis Box (WPI restricts access-token creation) — so the request it BUILDS
// is the only thing that can be checked, and it is exactly what was wrong:
// the announcements request named its course filter "context_code[]", Canvas
// answered 400 for "no context", and the job threw on every single run.
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
  MAX_LOOKBACK_MS,
  announcementProvenance,
  canvasUrl,
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
