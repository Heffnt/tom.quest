import { describe, expect, it } from "vitest";
import { DAY_LOG_ENTRY_MAX, dayLogEntryState } from "../day-log-entry.mjs";

describe("day-log entry state", () => {
  it("accepts the server limit exactly and refuses the next character", () => {
    expect(dayLogEntryState("x".repeat(DAY_LOG_ENTRY_MAX))).toEqual({
      count: DAY_LOG_ENTRY_MAX,
      overLimit: false,
      canSubmit: true,
    });
    expect(dayLogEntryState("x".repeat(DAY_LOG_ENTRY_MAX + 1))).toEqual({
      count: DAY_LOG_ENTRY_MAX + 1,
      overLimit: true,
      canSubmit: false,
    });
  });

  it("keeps a blank entry from being submitted", () => {
    expect(dayLogEntryState("  ")).toMatchObject({ overLimit: false, canSubmit: false });
  });
});
