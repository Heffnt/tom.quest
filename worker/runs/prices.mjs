// prices.mjs — dated, explicit pricing for CLI model spellings.
//
// USD per million tokens. An entry describes only a rate the corresponding
// transcript evidence can support. Cost is absent rather than estimated when
// a required cache duration or context tier is unknown.

export const PRICE_TABLE_VERSION = "2026-09-11";

export const PRICES = Object.freeze({
  // Anthropic — read 2026-09-11 from
  //   https://platform.claude.com/docs/en/about-claude/pricing
  // The cache columns are 5-minute writes / 1-hour writes / reads.
  "claude-fable-5-1": Object.freeze({ input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25, output: 50 }),
  "claude-opus-5": Object.freeze({ input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 }),
  // The $2/$10 per million input/output token pricing for Claude Sonnet 5, announced at launch as introductory pricing through August 31, 2026, is now the standard price. The previously scheduled increase to $3/$15 per million input/output tokens on September 1, 2026 will not occur.
  "claude-sonnet-5": Object.freeze({ input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 }),
  // Haiku's source lists these standard rates; no Anthropic long-context tier
  // is recorded for Fable 5.1, Opus 5, Sonnet 5, or Haiku here.
  "claude-haiku-4-5-20251001": Object.freeze({ input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 }),

  // OpenAI — read 2026-09-11 from
  //   https://developers.openai.com/api/docs/pricing
  // The rollout identifies a long-context request only through
  // last_token_usage; ingest leaves the whole run unpriced when one exceeds
  // the 272K input threshold. The long tier is 2x input and 1.5x output, so
  // the short rates here are its inverse rather than ordinary long rates.
  // OpenAI publishes no distinct cache-write rate,
  // so a nonzero cache-write total is likewise not priced.
  "gpt-5.6-sol": Object.freeze({ input: 4, cacheRead: 0.4, output: 20 }),
  "gpt-5.6-terra": Object.freeze({ input: 2, cacheRead: 0.2, output: 12 }),
});

const tokens = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);

/** Return null whenever the transcript cannot establish every billed tier. */
export function costOf({ model, totals = {} }) {
  if (!model || !Object.hasOwn(PRICES, model)) return null;
  const price = PRICES[model];
  const cacheWriteTokens = tokens(totals.cacheWriteTokens);
  const cacheWrite5mTokens = tokens(totals.cacheWrite5mTokens);
  const cacheWrite1hTokens = tokens(totals.cacheWrite1hTokens);

  // Legacy CLI totals name a write quantity but not its duration. They are
  // retained in the 5m bucket for conservation, never silently costed there.
  if (totals.cacheWriteBreakdownKnown !== true) return null;
  if (cacheWriteTokens !== cacheWrite5mTokens + cacheWrite1hTokens) return null;
  if ((cacheWrite5mTokens > 0 && price.cacheWrite5m === undefined) || (cacheWrite1hTokens > 0 && price.cacheWrite1h === undefined)) return null;
  if (tokens(totals.longContextRequests) > 0) return null;

  // Thinking is already inside outputTokens for both supported CLIs.
  const cost = (
    (tokens(totals.inputTokens) * price.input) +
    (tokens(totals.cacheReadTokens) * price.cacheRead) +
    (cacheWrite5mTokens * (price.cacheWrite5m ?? 0)) +
    (cacheWrite1hTokens * (price.cacheWrite1h ?? 0)) +
    (tokens(totals.outputTokens) * price.output)
  ) / 1_000_000;
  return Math.round((cost + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export function priceTableVersion() {
  return PRICE_TABLE_VERSION;
}
