import { describe, expect, it } from "vitest";
import { PRICES, costOf, priceTableVersion } from "../prices.mjs";

describe("run prices", () => {
  it("leaves unverified models unpriced", () => {
    expect(costOf({ model: undefined, totals: {} })).toBeNull();
    expect(costOf({ model: "unknown", totals: {} })).toBeNull();
    expect(priceTableVersion()).toBe("2026-09-11");
    for (const price of Object.values(PRICES)) for (const value of Object.values(price)) expect(Number.isFinite(value) && value >= 0).toBe(true);
  });
});
