import { describe, expect, it } from "vitest";
import { PRICES, costOf, priceTableVersion } from "../prices.mjs";

const totals = ({ input = 0, cacheRead = 0, cacheWrite5m = 0, cacheWrite1h = 0, output = 0, thinking = 0, known = true, longContextRequests = 0 } = {}) => ({
  inputTokens: input,
  cacheReadTokens: cacheRead,
  cacheWrite5mTokens: cacheWrite5m,
  cacheWrite1hTokens: cacheWrite1h,
  cacheWriteTokens: cacheWrite5m + cacheWrite1h,
  cacheWriteBreakdownKnown: known,
  outputTokens: output,
  thinkingTokens: thinking,
  longContextRequests,
});

describe("run prices", () => {
  it("costs each measured Anthropic cache duration separately", () => {
    const cost = costOf({
      model: "claude-opus-5",
      totals: totals({ input: 1_000_000, cacheRead: 2_000_000, cacheWrite5m: 500_000, cacheWrite1h: 250_000, output: 100_000 }),
    });
    // 5.00 + 1.00 + 3.125 + 2.50 + 2.50
    expect(cost).toBe(14.125);
    expect(PRICES["claude-fable-5-1"].cacheWrite1h).toBe(20);
    expect(PRICES["claude-opus-5"].cacheWrite1h).toBe(10);
    expect(PRICES["claude-sonnet-5"].cacheWrite1h).toBe(4);
    expect(PRICES["claude-haiku-4-5-20251001"].cacheWrite1h).toBe(2);
  });

  it("uses the settled OpenAI rates only with verified short-context evidence", () => {
    expect(costOf({
      model: "gpt-5.6-terra",
      totals: totals({ input: 300_000, cacheRead: 1_200_000, output: 45_000 }),
    })).toBe(1.38); // 0.60 + 0.24 + 0.54
    expect(PRICES["gpt-5.6-sol"]).toMatchObject({ input: 4, cacheRead: 0.4, output: 20 });
    expect(PRICES["gpt-5.6-terra"]).toMatchObject({ input: 2, cacheRead: 0.2, output: 12 });
    expect(costOf({ model: "gpt-5.6-sol", totals: totals({ input: 1, longContextRequests: 1 }) })).toBeNull();
  });

  it("leaves an aggregate cache-write total unpriced", () => {
    const legacy = { ...totals({ cacheWrite5m: 10 }), cacheWriteBreakdownKnown: false };
    expect(costOf({ model: "claude-fable-5-1", totals: legacy })).toBeNull();
  });

  it("does not count thinking twice", () => {
    const withoutThinking = costOf({ model: "claude-sonnet-5", totals: totals({ output: 1_000_000 }) });
    const withThinking = costOf({ model: "claude-sonnet-5", totals: totals({ output: 1_000_000, thinking: 900_000 }) });
    expect(withThinking).toBe(withoutThinking);
  });

  it("has a complete, finite matrix for each vendor's published columns", () => {
    for (const [model, price] of Object.entries(PRICES)) {
      expect(Number.isFinite(price.input) && price.input >= 0, model).toBe(true);
      expect(Number.isFinite(price.cacheRead) && price.cacheRead >= 0, model).toBe(true);
      expect(Number.isFinite(price.output) && price.output >= 0, model).toBe(true);
      if (model.startsWith("claude-")) {
        expect(price.cacheWrite5m).toBe(price.input * 1.25);
        expect(price.cacheWrite1h).toBe(price.input * 2);
      } else {
        expect(price.cacheWrite5m).toBeUndefined();
        expect(price.cacheWrite1h).toBeUndefined();
      }
    }
  });

  it("leaves an unverified model unpriced rather than guessing", () => {
    expect(costOf({ model: undefined, totals: totals({ input: 1_000_000 }) })).toBeNull();
    expect(costOf({ model: "unknown", totals: totals({ input: 1_000_000 }) })).toBeNull();
    expect(costOf({ model: "gpt-5.6-luna", totals: totals({ input: 9_000_000, output: 9_000_000 }) })).toBeNull();
  });

  it("stamps the table with the date its prices were read", () => {
    expect(priceTableVersion()).toBe("2026-09-11");
  });
});
