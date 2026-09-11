// prices.mjs — dated, explicit pricing for CLI model spellings.
//
// No source was independently verified while this offline phase was written,
// so this table intentionally starts empty. An absent price is honest and
// leaves cost absent; guessing would turn a transcript fact into a durable lie.

export const PRICE_TABLE_VERSION = "2026-09-11";
export const PRICES = Object.freeze({});

export function costOf({ model, totals }) {
  if (!model || !Object.hasOwn(PRICES, model)) return null;
  const price = PRICES[model];
  // Thinking is already included in output_tokens in both supported CLIs.
  const cost = (
    (totals.inputTokens * price.input) +
    (totals.cacheReadTokens * price.cacheRead) +
    (totals.cacheWriteTokens * price.cacheWrite) +
    (totals.outputTokens * price.output)
  ) / 1_000_000;
  return Math.round((cost + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export function priceTableVersion() {
  return PRICE_TABLE_VERSION;
}
