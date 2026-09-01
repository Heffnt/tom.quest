import { afterEach, describe, expect, it, vi } from "vitest";

import { currentDayKey } from "@/app/api/jarvis/_utils";
import { ttsDayKey } from "@/convex/ttsShared";

// The jarvis surfaces (today, timeline, status-summary) name files
// memory/<day>.md and index dailyTotals by the SAME day key the rest of TTS
// uses: the New York day that starts at 5 a.m., not at midnight. currentDayKey
// used to hand-roll that rule a second time on top of Intl.DateTimeFormat;
// these cases fence the boundary so a future edit cannot quietly slide it back
// to midnight or to UTC.
describe("currentDayKey", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function at(iso: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
    return currentDayKey();
  }

  it("EDT: 4:59 a.m. New York still belongs to the previous day", () => {
    // 08:59 UTC = 04:59 EDT on 2026-09-01.
    expect(at("2026-09-01T08:59:59Z")).toBe("2026-08-31");
  });

  it("EDT: 5:00 a.m. New York starts the new day", () => {
    expect(at("2026-09-01T09:00:00Z")).toBe("2026-09-01");
  });

  it("EST: 4:59 a.m. New York still belongs to the previous day", () => {
    // 09:59 UTC = 04:59 EST on 2026-01-15.
    expect(at("2026-01-15T09:59:59Z")).toBe("2026-01-14");
  });

  it("EST: 5:00 a.m. New York starts the new day", () => {
    expect(at("2026-01-15T10:00:00Z")).toBe("2026-01-15");
  });

  it("agrees with the shared day rule at every hour of a year", () => {
    const start = Date.parse("2026-01-01T00:00:00Z");
    const end = Date.parse("2027-01-01T00:00:00Z");
    vi.useFakeTimers();
    for (let t = start; t < end; t += 3_600_000) {
      vi.setSystemTime(new Date(t));
      expect(currentDayKey()).toBe(ttsDayKey(t));
    }
  });
});
