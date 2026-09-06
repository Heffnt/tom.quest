// redact.mjs — the ONE place a credential-shaped string is taken out of text
// on its way into a transcript row.
//
// Why it exists: a transcript lives forever. On 2026-08-30 a session read the
// GitHub token out of its clone's .git/config and typed it inline in gh
// commands, and the classifier's verdict rows carried it verbatim into
// Convex. The 2026-09-05 preservation audit then found that same token in 363
// stored messages across 121 sessions, and the Slack bot token in 4 more —
// every one of them a command's own output, stored as the model saw it. The
// token no longer sits in a clone (credential helper) or a session's shell env
// (env-scrub.mjs), but a model can still PRINT one that reached it some other
// way, so the last line of defense is the ingest body itself: the one choke
// point every row passes through (sessionsFetch in lib.mjs).
//
// Every shape below is prefixed and unambiguous, so the replacement cannot hit
// ordinary prose: "risk-averse" is not an OpenAI key and "ghp" alone is not a
// GitHub token. Length floors do the rest.
//
// The character classes are deliberately JSON-escape-free (no backslash, no
// quote, no control characters), which is what makes it safe to run this over
// an ALREADY-SERIALIZED body: a replacement inside a JSON string can never
// break the JSON.
//
// Its own dependency-free file for the same reason env-scrub.mjs is one:
// lib.mjs (which re-exports this) imports the worker-env symlink, which is a
// plain text file on a Windows checkout, so the repo's vitest cannot load
// lib.mjs — and a secret filter is exactly the kind of thing a test must fence
// (__tests__/redact.test.mjs).

// Ordered: the named shapes first, so `Authorization: Bearer gho_…` reports
// the kind it actually is, and the catch-all bearer rule last picks up only a
// header value no named shape claimed. A marker is lowercase letters and
// brackets, so no later rule can match inside an earlier rule's marker.
export const REDACTED_SHAPES = Object.freeze([
  // GitHub: gh{p,o,u,s,r}_… (classic + app tokens) and the fine-grained PAT.
  { kind: "github", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  // Slack: every xox?- bot/user/app/refresh token, plus the app-level xapp-.
  { kind: "slack", pattern: /\b(?:xox[abcdeprs]|xapp)-[A-Za-z0-9-]{10,}/g },
  // Anthropic before OpenAI: sk-ant-… also matches the generic sk- shape.
  { kind: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  // AWS access key id.
  { kind: "aws", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // Google API key.
  { kind: "google", pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  // Convex deploy key: prod:<deployment>|<base64ish>. The pipe is what makes
  // it a key and not a prose colon.
  { kind: "convex", pattern: /\b(?:prod|dev|preview):[a-z0-9-]+\|[A-Za-z0-9+/=_-]{20,}/g },
]);

// The header form, kept separate because the prefix is preserved: the fact
// that a request carried an Authorization header stays readable, its value
// does not. The value class excludes backslash and quote for the JSON reason
// above, which also stops it swallowing a serialized \n.
const BEARER = /(Authorization:[ \t]*Bearer[ \t]+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** `text` with every credential-shaped span replaced by `[redacted:<kind>]`. */
export function redactSecrets(text) {
  let out = text;
  for (const { kind, pattern } of REDACTED_SHAPES) {
    out = out.replace(pattern, `[redacted:${kind}]`);
  }
  return out.replace(BEARER, `$1[redacted:bearer]`);
}
