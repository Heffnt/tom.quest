import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { buildEventBody } from "./ttsCalendarWrite";
import { expandIcsText } from "./ttsCalendarExpand";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function withTom(t: ReturnType<typeof convexTest>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}

// node-ical resolves TZID=America/New_York from its own tz tables, so a
// VTIMEZONE block is not required for these fixtures — verified by the
// "without a VTIMEZONE block" case below. One fixture carries the block
// anyway, because real Google/Outlook feeds always ship it.
const NY_VTIMEZONE = `BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE`;

function ics(body: string, { vtimezone = false } = {}): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//tom.quest//tts calendar test//EN",
    ...(vtimezone ? [NY_VTIMEZONE] : []),
    body.trim(),
    "END:VCALENDAR",
  ].join("\n");
}

// Window bounds are pinned to New York midnight (04:00 UTC in August/September
// EDT). node-ical's own range check reads HOST-local date components for
// all-day instances, and 04:00 UTC is the same calendar date whether the host
// runs UTC (CI) or US Eastern (Tom's machine) — so these expectations hold in
// both. Anything at 00:00 UTC would straddle the date line and diverge.
const SEP_1 = Date.UTC(2026, 8, 1, 4); // 2026-09-01 00:00 EDT
const SEP_22 = Date.UTC(2026, 8, 22, 4);

describe("expandIcsText", () => {
  it("maps a timed VEVENT to real UTC instants", () => {
    const text = ics(
      `BEGIN:VEVENT
UID:single-timed@tom.quest
SUMMARY:Dinner with Nora
LOCATION:Worcester
DTSTART;TZID=America/New_York:20260812T190000
DTEND;TZID=America/New_York:20260812T203000
END:VEVENT`,
      { vtimezone: true },
    );

    const rows = expandIcsText(
      text,
      Date.UTC(2026, 7, 1, 4),
      Date.UTC(2026, 7, 31, 4),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      uid: "single-timed@tom.quest",
      title: "Dinner with Nora",
      location: "Worcester",
      allDay: false,
      // 19:00 EDT = 23:00 UTC; August is UTC-4.
      start: Date.UTC(2026, 7, 12, 23),
      end: Date.UTC(2026, 7, 13, 0, 30),
    });
  });

  it("resolves TZID without a VTIMEZONE block in the feed", () => {
    const text = ics(`BEGIN:VEVENT
UID:no-vtimezone@tom.quest
SUMMARY:Standup
DTSTART;TZID=America/New_York:20260812T190000
DTEND;TZID=America/New_York:20260812T200000
END:VEVENT`);

    const rows = expandIcsText(
      text,
      Date.UTC(2026, 7, 1, 4),
      Date.UTC(2026, 7, 31, 4),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].start).toBe(Date.UTC(2026, 7, 12, 23));
  });

  it("expands a weekly RRULE across a three-week window", () => {
    const text = ics(
      `BEGIN:VEVENT
UID:practice@tom.quest
SUMMARY:Practice
DTSTART;TZID=America/New_York:20260901T190000
DTEND;TZID=America/New_York:20260901T210000
RRULE:FREQ=WEEKLY;BYDAY=TU,TH
END:VEVENT`,
      { vtimezone: true },
    );

    const rows = expandIcsText(text, SEP_1, SEP_22);

    // Tuesdays/Thursdays of 2026-09-01..2026-09-21; the Sep 22 occurrence
    // starts after the window ends (19:00 EDT > midnight) and is excluded.
    expect(rows.map((r) => r.start)).toEqual([
      Date.UTC(2026, 8, 1, 23),
      Date.UTC(2026, 8, 3, 23),
      Date.UTC(2026, 8, 8, 23),
      Date.UTC(2026, 8, 10, 23),
      Date.UTC(2026, 8, 15, 23),
      Date.UTC(2026, 8, 17, 23),
    ]);
    // Every occurrence carries the series uid and the series duration.
    expect(new Set(rows.map((r) => r.uid))).toEqual(
      new Set(["practice@tom.quest"]),
    );
    expect(rows.every((r) => r.end - r.start === 2 * 3_600_000)).toBe(true);
    expect(rows.every((r) => r.allDay === false)).toBe(true);
  });

  it("drops an EXDATE occurrence from the series", () => {
    const text = ics(
      `BEGIN:VEVENT
UID:practice@tom.quest
SUMMARY:Practice
DTSTART;TZID=America/New_York:20260901T190000
DTEND;TZID=America/New_York:20260901T210000
RRULE:FREQ=WEEKLY;BYDAY=TU,TH
EXDATE;TZID=America/New_York:20260908T190000
END:VEVENT`,
      { vtimezone: true },
    );

    const rows = expandIcsText(text, SEP_1, SEP_22);

    expect(rows.map((r) => r.start)).toEqual([
      Date.UTC(2026, 8, 1, 23),
      Date.UTC(2026, 8, 3, 23),
      Date.UTC(2026, 8, 10, 23),
      Date.UTC(2026, 8, 15, 23),
      Date.UTC(2026, 8, 17, 23),
    ]);
    expect(rows.map((r) => r.start)).not.toContain(Date.UTC(2026, 8, 8, 23));
  });

  // witness: have the all-day branch use inst.start.getTime() like the timed
  // branch — a VALUE=DATE event would land on the host's midnight (UTC on CI),
  // four hours off Tom's day, and sit in the wrong calendar column.
  it("anchors an all-day event to New York midnight", () => {
    const text = ics(`BEGIN:VEVENT
UID:allday@tom.quest
SUMMARY:Labor Day
DTSTART;VALUE=DATE:20260905
DTEND;VALUE=DATE:20260906
END:VEVENT`);

    const rows = expandIcsText(text, SEP_1, SEP_22);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      uid: "allday@tom.quest",
      title: "Labor Day",
      allDay: true,
      start: Date.UTC(2026, 8, 5, 4), // 00:00 EDT on the 5th
      end: Date.UTC(2026, 8, 6, 4), // DTEND is exclusive: one day later
    });
  });

  it("gives an all-day event with no DTEND a one-day span", () => {
    const text = ics(`BEGIN:VEVENT
UID:allday-noend@tom.quest
SUMMARY:Holiday
DTSTART;VALUE=DATE:20260905
END:VEVENT`);

    const rows = expandIcsText(text, SEP_1, SEP_22);
    expect(rows).toHaveLength(1);
    expect(rows[0].start).toBe(Date.UTC(2026, 8, 5, 4));
    expect(rows[0].end).toBe(Date.UTC(2026, 8, 6, 4));
  });

  it("keeps only events overlapping the window", () => {
    const text = ics(
      `BEGIN:VEVENT
UID:inside@tom.quest
SUMMARY:Inside
DTSTART;TZID=America/New_York:20260910T090000
DTEND;TZID=America/New_York:20260910T100000
END:VEVENT
BEGIN:VEVENT
UID:before@tom.quest
SUMMARY:Long gone
DTSTART;TZID=America/New_York:20260710T090000
DTEND;TZID=America/New_York:20260710T100000
END:VEVENT
BEGIN:VEVENT
UID:after@tom.quest
SUMMARY:Far future
DTSTART;TZID=America/New_York:20261110T090000
DTEND;TZID=America/New_York:20261110T100000
END:VEVENT`,
      { vtimezone: true },
    );

    const rows = expandIcsText(text, SEP_1, SEP_22);
    expect(rows.map((r) => r.uid)).toEqual(["inside@tom.quest"]);
  });

  it("sorts by start and skips nothing on a mixed feed", () => {
    const text = ics(
      `BEGIN:VEVENT
UID:late@tom.quest
SUMMARY:Late
DTSTART;TZID=America/New_York:20260915T090000
DTEND;TZID=America/New_York:20260915T100000
END:VEVENT
BEGIN:VEVENT
UID:early@tom.quest
SUMMARY:Early
DTSTART;VALUE=DATE:20260902
DTEND;VALUE=DATE:20260903
END:VEVENT`,
      { vtimezone: true },
    );

    const rows = expandIcsText(text, SEP_1, SEP_22);
    expect(rows.map((r) => r.uid)).toEqual([
      "early@tom.quest",
      "late@tom.quest",
    ]);
  });
});

describe("internalReplaceFeed", () => {
  const event = (uid: string, start: number) => ({
    uid,
    title: uid,
    start,
    end: start + 3_600_000,
    allDay: false,
  });

  it("replaces one feed wholesale and leaves other feeds alone", async () => {
    const t = convexTest(schema, modules);

    const first = await t.mutation(internal.ttsCalendar.internalReplaceFeed, {
      feed: "google",
      events: [
        event("a@tom.quest", Date.UTC(2026, 8, 1, 13)),
        event("b@tom.quest", Date.UTC(2026, 8, 2, 13)),
      ],
    });
    expect(first).toEqual({ feed: "google", replaced: 0, inserted: 2 });

    await t.mutation(internal.ttsCalendar.internalReplaceFeed, {
      feed: "outlook",
      events: [event("x@tom.quest", Date.UTC(2026, 8, 1, 15))],
    });

    // A vanished event vanishes here too — mirror semantics, not
    // nothing-ever-lost (that governs todos, and no todo lives in this table).
    const second = await t.mutation(internal.ttsCalendar.internalReplaceFeed, {
      feed: "google",
      events: [event("b@tom.quest", Date.UTC(2026, 8, 2, 13))],
    });
    expect(second).toEqual({ feed: "google", replaced: 2, inserted: 1 });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("ttsCalendarEvents").collect(),
    );
    expect(
      rows.map((r) => `${r.feed}:${r.uid}`).sort(),
    ).toEqual(["google:b@tom.quest", "outlook:x@tom.quest"]);
    expect(rows.every((r) => typeof r.syncedAt === "number")).toBe(true);
  });

  it("clears a feed when the fetch returns no events", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.ttsCalendar.internalReplaceFeed, {
      feed: "google",
      events: [event("a@tom.quest", Date.UTC(2026, 8, 1, 13))],
    });
    const result = await t.mutation(internal.ttsCalendar.internalReplaceFeed, {
      feed: "google",
      events: [],
    });
    expect(result).toEqual({ feed: "google", replaced: 1, inserted: 0 });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("ttsCalendarEvents").collect(),
    );
    expect(rows).toEqual([]);
  });
});

describe("listCalendarEvents", () => {
  async function seed(t: ReturnType<typeof convexTest>) {
    await t.mutation(internal.ttsCalendar.internalReplaceFeed, {
      feed: "google",
      events: [
        // Ends exactly at the range start — [start, end) overlap excludes it.
        {
          uid: "ends-at-start",
          title: "Ends at start",
          start: Date.UTC(2026, 8, 9, 22),
          end: Date.UTC(2026, 8, 10, 4),
          allDay: false,
        },
        {
          uid: "straddles-start",
          title: "Straddles start",
          start: Date.UTC(2026, 8, 9, 22),
          end: Date.UTC(2026, 8, 10, 5),
          allDay: false,
        },
        {
          uid: "inside",
          title: "Inside",
          start: Date.UTC(2026, 8, 10, 17),
          end: Date.UTC(2026, 8, 10, 18),
          allDay: false,
        },
        // Starts exactly at the range end — excluded (end is exclusive).
        {
          uid: "starts-at-end",
          title: "Starts at end",
          start: Date.UTC(2026, 8, 11, 4),
          end: Date.UTC(2026, 8, 11, 5),
          allDay: false,
        },
      ],
    });
  }

  // witness: drop the requireTom call in listCalendarEvents — Tom's calendar
  // would be readable by any signed-in account.
  it("requires the Tom identity", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const range = { start: Date.UTC(2026, 8, 10, 4), end: Date.UTC(2026, 8, 11, 4) };

    await expect(t.query(api.ttsCalendar.listCalendarEvents, range)).rejects.toThrow();

    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "someone", role: "user" }),
    );
    await expect(
      t.withIdentity({ subject: userId }).query(api.ttsCalendar.listCalendarEvents, range),
    ).rejects.toThrow(/restricted to Tom/);
  });

  it("returns rows overlapping [start, end)", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const tom = await withTom(t);

    const rows = await tom.query(api.ttsCalendar.listCalendarEvents, {
      start: Date.UTC(2026, 8, 10, 4), // 2026-09-10 00:00 EDT
      end: Date.UTC(2026, 8, 11, 4),
    });
    expect(rows.map((r) => r.uid).sort()).toEqual(["inside", "straddles-start"]);
  });

  it("returns nothing for a range with no events", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const tom = await withTom(t);
    const rows = await tom.query(api.ttsCalendar.listCalendarEvents, {
      start: Date.UTC(2026, 9, 10, 4),
      end: Date.UTC(2026, 9, 11, 4),
    });
    expect(rows).toEqual([]);
  });
});

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
