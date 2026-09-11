// prices.mjs — dated, explicit pricing for CLI model spellings.
//
// USD per million tokens. Every entry below was read off an official vendor
// pricing page on the date stamped in PRICE_TABLE_VERSION; the URL is recorded
// beside each block. A price that cannot be read off such a page is an absent
// entry, not an estimate — an absent price leaves cost absent, and guessing
// would turn a transcript fact into a durable lie.
//
// cacheRead and cacheWrite are separate columns because they are separate
// prices: a cache read is a fraction of the input price, a cache write a
// premium over it. Neither equals input.

export const PRICE_TABLE_VERSION = "2026-09-11";

export const PRICES = Object.freeze({
  // Anthropic — read 2026-09-11 from
  //   https://platform.claude.com/docs/en/docs/about-claude/pricing
  //   (columns: base input / 5m cache writes / cache hits and refreshes / output)
  // cross-checked the same day against https://claude.com/pricing
  // The 5-minute cache write (1.25x input) is the one the CLI takes; the 1-hour
  // write (2x input) is not represented here.

  // Fable 5.1: $10 in, $12.50 5m write, $0.25 read (0.025x input, not the usual 0.1x), $50 out.
  "claude-fable-5-1": Object.freeze({ input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 }),

  // Opus 5: $5 in, $6.25 5m write, $0.50 read, $25 out.
  "claude-opus-5": Object.freeze({ input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 }),
  // Same page, "Long context pricing": Claude 4.6 and later carry the full 1M
  // context window at standard pricing, so the CLI's 1M spelling prices identically.
  "claude-opus-5[1m]": Object.freeze({ input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 }),

  // Sonnet 5: $2 in, $2.50 5m write, $0.20 read, $10 out. The page notes the
  // $2/$10 introductory rate is now the standard price; the increase to $3/$15
  // scheduled for 2026-09-01 did not occur.
  "claude-sonnet-5": Object.freeze({ input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 }),

  // Haiku 4.5: $1 in, $1.25 5m write, $0.10 read, $5 out.
  "claude-haiku-4-5-20251001": Object.freeze({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }),

  // OpenAI — read 2026-09-11 from https://developers.openai.com/api/docs/pricing
  //   (Standard pricing table, short-context columns:
  //    input / cached input / cache writes / output)
  // The same rows carry a long-context tier at roughly double these rates. The
  // record cannot tell which tier a run billed at, so the short-context
  // (standard) rates are what is stored; a long-context run is understated.

  // gpt-5.6-sol: $4.00 in, $5.00 cache write, $0.40 cached input, $20.00 out.
  "gpt-5.6-sol": Object.freeze({ input: 4, cacheWrite: 5, cacheRead: 0.4, output: 20 }),

  // gpt-5.6-terra: $2.00 in, $2.50 cache write, $0.20 cached input, $12.00 out.
  "gpt-5.6-terra": Object.freeze({ input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 12 }),
});

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
