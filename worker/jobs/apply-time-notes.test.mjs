import { describe, expect, it } from "vitest";

import { timeNotePrompt } from "./apply-time-notes.mjs";

describe("time-note prompt", () => {
  it("begins with the writing standard", () => {
    const text = timeNotePrompt(
      { text: "move it to Friday", context: { kind: "todo", todo: null } },
      { nyCalendarDay: "2026-09-09", now: Date.UTC(2026, 8, 9, 12), timezone: "America/New_York" },
      "WRITE STANDARD",
    );
    expect(text.startsWith("WRITE STANDARD")).toBe(true);
  });

  it("keeps fixed instructions before fetched context and the clock last", () => {
    const text = timeNotePrompt(
      { text: "move it to Friday", day: "2026-09-10", context: { kind: "todo", todo: null } },
      { nyCalendarDay: "2026-09-09", now: Date.UTC(2026, 8, 9, 12), timezone: "America/New_York" },
      "WRITE STANDARD",
    );
    expect(text.indexOf('"status": "applied"')).toBeLessThan(text.indexOf("TOM WROTE:"));
    expect(text.lastIndexOf("RIGHT NOW:")).toBeGreaterThan(text.indexOf("WHAT THE NOTE IS ABOUT"));
    expect(text).not.toContain("in Tom's words, no");
  });
});
