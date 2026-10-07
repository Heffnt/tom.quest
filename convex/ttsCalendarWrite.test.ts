import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { buildEventBody } from "./ttsCalendarWrite";

// The write door to Tom's Google Calendar stays when the Jarvis calendar goes
// (design section 13.2): these cases moved here from the calendar mirror's
// test file when that file was deleted.

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

describe("buildEventBody (the calendar write door)", () => {
  it("builds a Google Calendar insert body with the NY time zone", () => {
    const body = buildEventBody({
      title: "  Climbing Team Practice  ",
      start: Date.UTC(2026, 8, 7, 21), // Mon Sep 7, 17:00 EDT
      end: Date.UTC(2026, 9, 8, 0),
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    });
    expect(body.summary).toBe("Climbing Team Practice"); // trimmed
    expect(body.start).toEqual({
      dateTime: "2026-09-07T21:00:00.000Z",
      timeZone: "America/New_York",
    });
    expect(body.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
  });

  it("rejects an empty title and a non-positive duration", () => {
    expect(() =>
      buildEventBody({ title: "  ", start: 1, end: 2 }),
    ).toThrow(/title/);
    expect(() =>
      buildEventBody({ title: "x", start: 2, end: 2 }),
    ).toThrow(/end must be after start/);
  });
});

describe("the calendar write door takes one calendar", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const postEvent = (t: ReturnType<typeof convexTest>, calendarId: string) =>
    t.fetch("/tts/calendar-event", {
      method: "POST",
      headers: { "X-TTS-Key": "s3cret", "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Dinner",
        start: Date.UTC(2026, 8, 26, 22),
        end: Date.UTC(2026, 8, 26, 23),
        calendarId,
      }),
    });

  it("refuses any calendar but Tom's primary before asking Google anything", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const google = vi.fn(async () => Response.json({ access_token: "x" }));
    vi.stubGlobal("fetch", google);
    const t = convexTest(schema, modules);
    const res = await postEvent(t, "someone.else@group.calendar.google.com");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/refused: this door writes only to Tom's primary calendar/);
    expect(google).not.toHaveBeenCalled();
    const created = await t.run((ctx) =>
      ctx.db
        .query("dtsEvents")
        .filter((q) => q.eq(q.field("kind"), "calendar-event-created"))
        .collect(),
    );
    expect(created).toEqual([]);
  });

  it("lets primary through the check", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest(schema, modules);
    // No Google credentials in the test env, so the next thing the door says
    // is that it is not configured: past the calendar check, not stopped by it.
    const res = await postEvent(t, "primary");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not configured/);
  });
});
