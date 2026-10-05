// The one home for zone work in tom.quest (shared/clock.mjs).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DAY_START_HOUR,
  ZONE,
  addDays,
  displayDay,
  displayDayKey,
  displayForm,
  displayTime,
  newYorkDay,
  newYorkHhmm,
  newYorkInstant,
  newYorkOffsetHours,
  newYorkParts,
  ttsDayKey,
} from "../clock.mjs";

const at = (iso) => Date.parse(iso);

// The United States rule since 2007, written out as convex/ttsShared.ts held it
// by hand until this file: daylight time from 2:00 standard time on the second
// Sunday of March to 2:00 daylight time on the first Sunday of November.
function statuteOffsetHours(ms) {
  const year = new Date(ms).getUTCFullYear();
  const sunday = (month, n) => {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return Date.UTC(year, month, 1 + ((7 - first) % 7) + (n - 1) * 7);
  };
  const spring = sunday(2, 2) + 7 * 3_600_000;
  const fall = sunday(10, 1) + 6 * 3_600_000;
  return ms >= spring && ms < fall ? -4 : -5;
}

describe("the display form", () => {
  it("is the weekday, month and day, then the 12-hour time with am or pm", () => {
    // 2026-10-05 01:58 UTC is 9:58 pm on Sunday, Oct 4 in New York.
    expect(displayForm(at("2026-10-05T01:58:00Z"))).toBe("Sun Oct 4, 9:58 pm");
    expect(displayTime(at("2026-10-05T04:05:00Z"))).toBe("12:05 am");
    expect(displayTime(at("2026-10-05T16:00:00Z"))).toBe("12:00 pm");
    expect(displayDay(at("2026-10-05T01:58:00Z"))).toBe("Sun Oct 4");
    expect(displayDayKey("2026-10-04")).toBe("Sun Oct 4");
    expect(ZONE).toBe("America/New_York");
  });

  it("never names EST, EDT or UTC", () => {
    for (const iso of ["2026-07-04T16:00:00Z", "2026-12-25T16:00:00Z"]) {
      expect(displayForm(at(iso))).not.toMatch(/\bE[DS]T\b|UTC|GMT/);
    }
  });
});

describe("the New York reading", () => {
  it("is the New York calendar date, not the UTC one, after 8 pm", () => {
    expect(newYorkDay(at("2026-10-05T01:58:00Z"))).toBe("2026-10-04");
    expect(newYorkHhmm(at("2026-10-05T01:58:00Z"))).toBe("21:58");
    expect(newYorkParts(at("2026-10-05T04:30:15Z"))).toEqual({ year: 2026, month: 10, day: 5, hour: 0, minute: 30, second: 15, weekday: "Mon" });
  });

  // 2026-11-01 02:00 EDT is 06:00 UTC; the clocks go back to 01:00 EST.
  it("goes back an hour at 2026-11-01 02:00", () => {
    expect(displayForm(at("2026-11-01T05:59:00Z"))).toBe("Sun Nov 1, 1:59 am");
    expect(displayForm(at("2026-11-01T06:00:00Z"))).toBe("Sun Nov 1, 1:00 am");
    expect(displayForm(at("2026-11-01T07:00:00Z"))).toBe("Sun Nov 1, 2:00 am");
    expect(newYorkOffsetHours(at("2026-11-01T05:59:00Z"))).toBe(-4);
    expect(newYorkOffsetHours(at("2026-11-01T06:00:00Z"))).toBe(-5);
    // A repeated time is its first occurrence.
    expect(newYorkInstant("2026-11-01", 1, 30)).toBe(at("2026-11-01T05:30:00Z"));
    expect(newYorkInstant("2026-11-01", 2)).toBe(at("2026-11-01T07:00:00Z"));
    expect(newYorkInstant("2026-11-01", 0)).toBe(at("2026-11-01T04:00:00Z"));
    expect(newYorkInstant("2026-11-02", 0)).toBe(at("2026-11-02T05:00:00Z"));
  });

  // 2027-03-14 02:00 EST is 07:00 UTC; the clocks go forward to 03:00 EDT.
  it("goes forward an hour at 2027-03-14 02:00", () => {
    expect(displayForm(at("2027-03-14T06:59:00Z"))).toBe("Sun Mar 14, 1:59 am");
    expect(displayForm(at("2027-03-14T07:00:00Z"))).toBe("Sun Mar 14, 3:00 am");
    expect(newYorkOffsetHours(at("2027-03-14T06:59:00Z"))).toBe(-5);
    expect(newYorkOffsetHours(at("2027-03-14T07:00:00Z"))).toBe(-4);
    expect(newYorkInstant("2027-03-14", 0)).toBe(at("2027-03-14T05:00:00Z"));
    expect(newYorkInstant("2027-03-14", 3)).toBe(at("2027-03-14T07:00:00Z"));
    expect(newYorkInstant("2027-03-15", 0)).toBe(at("2027-03-15T04:00:00Z"));
    // A skipped time comes back an hour earlier on the wall clock.
    expect(newYorkInstant("2027-03-14", 2, 30)).toBe(at("2027-03-14T06:30:00Z"));
  });

  // The zone table against the rule the record computed by hand before: each
  // quarter hour of the eight daylight-saving days of 2026 to 2029, and a
  // stride of 7 hours 15 minutes (so every hour and quarter recurs) across
  // 2026 to 2036.
  it("agrees with the United States rule from 2026 through 2036", () => {
    const instants = [];
    for (const day of ["2026-03-08", "2026-11-01", "2027-03-14", "2027-11-07", "2028-03-12", "2028-11-05", "2029-03-11", "2029-11-04"]) {
      const noon = at(`${day}T12:00:00Z`);
      for (let t = noon - 12 * 3_600_000; t < noon + 12 * 3_600_000; t += 15 * 60_000) instants.push(t);
    }
    for (let t = at("2026-01-01T05:00:00Z"); t < at("2037-01-01T05:00:00Z"); t += 435 * 60_000) instants.push(t);
    for (const t of instants) {
      if (newYorkOffsetHours(t) !== statuteOffsetHours(t)) throw new Error(`the zone table disagrees at ${new Date(t).toISOString()}`);
      const p = newYorkParts(t);
      const back = newYorkInstant(newYorkDay(t), p.hour, p.minute);
      if (back !== t && !(t - back === 3_600_000 && p.month === 11 && p.hour === 1)) throw new Error(`round trip fails at ${new Date(t).toISOString()}`);
    }
    expect(instants.length).toBeGreaterThan(13_000);
  }, 30_000);

  // The site renders on the server (UTC) and in the browser (any zone); both
  // passes give the same text because the zone is named.
  it("does not depend on the process's own zone", () => {
    const probe = [
      "const m = await import(process.argv[1]);",
      "const t = Date.parse('2026-10-05T01:58:00Z');",
      "process.stdout.write(JSON.stringify([m.displayForm(t), m.newYorkDay(t), m.ttsDayKey(t), m.newYorkOffsetHours(t), m.newYorkInstant('2026-11-01', 2)]));",
    ].join(" ");
    const href = pathToFileURL(path.resolve("shared/clock.mjs")).href;
    const expected = JSON.stringify(["Sun Oct 4, 9:58 pm", "2026-10-04", "2026-10-04", -4, at("2026-11-01T07:00:00Z")]);
    for (const TZ of ["UTC", "America/New_York", "Asia/Tokyo", "America/Los_Angeles"]) {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe, href], { encoding: "utf8", env: { ...process.env, TZ } });
      expect(result.stdout, TZ).toBe(expected);
    }
  });
});

describe("the TTS day", () => {
  // Tom: "tom days (end at 5am)".
  it("turns over at 5 am New York, on ordinary and daylight-saving days", () => {
    expect(DAY_START_HOUR).toBe(5);
    expect(ttsDayKey(at("2026-10-05T08:59:00Z"))).toBe("2026-10-04");
    expect(ttsDayKey(at("2026-10-05T09:00:00Z"))).toBe("2026-10-05");
    expect(ttsDayKey(at("2026-11-01T09:59:00Z"))).toBe("2026-10-31");
    expect(ttsDayKey(at("2026-11-01T10:00:00Z"))).toBe("2026-11-01");
    expect(ttsDayKey(at("2027-03-14T08:59:00Z"))).toBe("2027-03-13");
    expect(ttsDayKey(at("2027-03-14T09:00:00Z"))).toBe("2027-03-14");
    expect(ttsDayKey(at("2027-01-01T06:00:00Z"))).toBe("2026-12-31");
  });

  it("moves a calendar date by whole days across both changes", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(addDays("2027-03-14", -1)).toBe("2027-03-13");
  });
});
