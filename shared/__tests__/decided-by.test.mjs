// Who decided (shared/decided-by.mjs).

import { describe, expect, it } from "vitest";
import { decidedByText } from "../decided-by.mjs";

describe("decidedByText", () => {
  it("names Tom, or the delegate after its wait, in whole minutes", () => {
    expect(decidedByText(true, 180_000)).toBe("decided by Tom after 3 minutes");
    expect(decidedByText(true, 60_000)).toBe("decided by Tom after 1 minute");
    expect(decidedByText(true, undefined)).toBe("decided by Tom");
    expect(decidedByText(false, 7_200_000)).toBe("decided by the delegate after waiting 120 minutes");
    expect(decidedByText(false, 0)).toBe("decided by the delegate after waiting 0 minutes");
    expect(decidedByText(false, 90_000)).toBe("decided by the delegate after waiting 2 minutes");
  });

  it("says nothing for a delegate decision with no recorded wait", () => {
    expect(decidedByText(false, undefined)).toBeNull();
    expect(decidedByText(false, null)).toBeNull();
    expect(decidedByText(false, -5)).toBeNull();
  });
});
