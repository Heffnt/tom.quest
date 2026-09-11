import { describe, expect, it } from "vitest";
import { PRICES, costOf, priceTableVersion } from "../prices.mjs";

const totals = ({ input = 0, cacheRead = 0, cacheWrite = 0, output = 0 }) => ({
  inputTokens: input,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
  outputTokens: output,
});

describe("run prices", () => {
  it("costs a priced model at the arithmetic of its four columns", () => {
    // Opus 5: $5 in, $0.50 cache read, $6.25 cache write, $25 out per MTok.
    const cost = costOf({
      model: "claude-opus-5",
      totals: totals({ input: 1_000_000, cacheRead: 2_000_000, cacheWrite: 500_000, output: 100_000 }),
    });
    // 5.00 + 1.00 + 3.125 + 2.50
    expect(cost).toBe(11.625);

    // gpt-5.6-terra: $2 in, $0.20 cached input, $2.50 cache write, $12 out per MTok.
    expect(costOf({
      model: "gpt-5.6-terra",
      totals: totals({ input: 300_000, cacheRead: 1_200_000, cacheWrite: 90_000, output: 45_000 }),
    })).toBe(1.605); // 0.60 + 0.24 + 0.225 + 0.54
  });

  it("charges cache reads and cache writes at their own prices, not at input", () => {
    // A million cache-read tokens on Fable 5.1 cost $0.25, not the $10 of input.
    expect(costOf({ model: "claude-fable-5-1", totals: totals({ cacheRead: 1_000_000 }) })).toBe(0.25);
    // A million cache-write tokens cost $12.50, the 1.25x premium over input.
    expect(costOf({ model: "claude-fable-5-1", totals: totals({ cacheWrite: 1_000_000 }) })).toBe(12.5);
    expect(costOf({ model: "claude-fable-5-1", totals: totals({ input: 1_000_000 }) })).toBe(10);
    expect(costOf({ model: "claude-fable-5-1", totals: totals({ output: 1_000_000 }) })).toBe(50);

    for (const [model, price] of Object.entries(PRICES)) {
      expect(price.cacheRead, `${model} cache read must differ from input`).not.toBe(price.input);
      expect(price.cacheWrite, `${model} cache write must differ from input`).not.toBe(price.input);
      expect(price.cacheRead).toBeLessThan(price.input);
      expect(price.cacheWrite).toBeGreaterThan(price.input);
    }
  });

  it("every priced entry carries four finite, non-negative columns", () => {
    for (const [model, price] of Object.entries(PRICES)) {
      expect(Object.keys(price).sort(), model).toEqual(["cacheRead", "cacheWrite", "input", "output"]);
      for (const value of Object.values(price)) expect(Number.isFinite(value) && value >= 0).toBe(true);
    }
  });

  it("leaves an unverified model unpriced rather than guessing", () => {
    expect(costOf({ model: undefined, totals: totals({ input: 1_000_000 }) })).toBeNull();
    expect(costOf({ model: "", totals: totals({ input: 1_000_000 }) })).toBeNull();
    expect(costOf({ model: "unknown", totals: totals({ input: 1_000_000 }) })).toBeNull();
    // A model absent from the table costs null however large the run.
    expect(costOf({ model: "gpt-5.6-luna", totals: totals({ input: 9_000_000, output: 9_000_000 }) })).toBeNull();
    // Inherited keys are not prices: the lookup is an own-property check.
    expect(costOf({ model: "toString", totals: totals({ input: 1_000_000 }) })).toBeNull();
  });

  it("stamps the table with the date its prices were read", () => {
    expect(priceTableVersion()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(priceTableVersion()).toBe("2026-09-11");
    expect(Number.isNaN(Date.parse(priceTableVersion()))).toBe(false);
  });
});
