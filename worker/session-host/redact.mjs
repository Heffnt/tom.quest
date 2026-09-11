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
const BEARER = /(Authorization[ \t]*[:=][ \t]*Bearer[ \t]+)[A-Za-z0-9._~+/=-]{8,}/gi;

// AWS secret access keys have no safe standalone prefix.  Their access-key ID
// does, so recognise the pair before the ID's normal shape is replaced below.
// The separator (and optional matching quotes) survives to keep a CLI table or
// assignment readable, while the 40-character secret cannot reach storage.
const AWS_ACCESS_KEY_PAIR = /\b(AKIA[0-9A-Z]{16})([ \t]*(?:[,;:=][ \t]*|\r?\n[ \t]*|[ \t]+))(["']?)([A-Za-z0-9/+=]{40})\3(?![A-Za-z0-9/+=])/g;

// A name alone is not a secret, but it makes the value on the other side of
// an assignment one.  The upper-case alternative covers the environment
// names CLIs commonly print (for example, a vendor-specific TOKEN suffix)
// without requiring every vendor to grow a bespoke redaction rule.
const SECRET_WORD = "(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|authorization)";
const SECRET_ENV_NAME = "[A-Z][A-Z0-9_-]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET|AUTHORIZATION)";
const NAMED_SECRET_KEY = `(?:${SECRET_WORD}|${SECRET_ENV_NAME})`;

// These forms deliberately retain the key and its punctuation.  A transcript
// remains useful when it says which configuration was present, but its value
// must never cross the machine boundary.  JSON is separate so replacing a
// quoted value cannot make an otherwise valid JSONL source invalid.
const NAMED_JSON_SECRET = new RegExp(
  `("(${NAMED_SECRET_KEY})"\\s*:\\s*)"((?:\\\\.|[^"\\\\])*)"`,
  "gi",
);
const NAMED_ASSIGNMENT = new RegExp(
  `(\\b(${NAMED_SECRET_KEY})\\b\\s*(?:=|:)\\s*)(?:"((?:\\\\.|[^"\\\\])*)"|'((?:\\\\.|[^'\\\\])*)'|([^\\s,;\\]}]+))`,
  "gi",
);
// Some tools print "token <value>" rather than an assignment.  Restrict this
// fallback to a plausibly high-entropy value: ordinary prose about a token is
// not a credential merely because it follows that word.
const NAMED_HIGH_ENTROPY_VALUE = new RegExp(
  `(\\b(${NAMED_SECRET_KEY})\\b(?:\\s+(?:is|was)\\s+|\\s+))([A-Za-z0-9._~+/=-]{32,})`,
  "gi",
);
const PEM_PRIVATE_KEY = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g;

const markerFor = (key) => (/^AWS(?:[_-]|$)/i.test(String(key)) ? "[redacted:aws]" : "[redacted:secret]");
const isMarker = (value) => String(value).includes("[redacted:");
const isHighEntropy = (value) => {
  const text = String(value);
  return text.length >= 32
    && new Set(text).size >= 8
    && /[A-Za-z]/.test(text)
    && (/[0-9]/.test(text) || /[._~+/=-]/.test(text));
};

function redactNamedSecrets(text) {
  let out = text.replace(NAMED_JSON_SECRET, (match, prefix, key, value) => (
    isMarker(value) ? match : `${prefix}"${markerFor(key)}"`
  ));
  out = out.replace(NAMED_ASSIGNMENT, (match, prefix, key, doubleQuoted, singleQuoted, bare) => {
    const value = doubleQuoted ?? singleQuoted ?? bare;
    if (isMarker(value) || /^Bearer$/i.test(value)) return match;
    const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : "";
    return `${prefix}${quote}${markerFor(key)}${quote}`;
  });
  return out.replace(NAMED_HIGH_ENTROPY_VALUE, (match, prefix, key, value) => (
    isMarker(value) || !isHighEntropy(value) ? match : `${prefix}${markerFor(key)}`
  ));
}

/** `text` with every credential-shaped span replaced by `[redacted:<kind>]`. */
export function redactSecrets(text) {
  let out = String(text).replace(PEM_PRIVATE_KEY, "[redacted:pem]");
  out = out.replace(AWS_ACCESS_KEY_PAIR, "$1$2$3[redacted:aws]$3");
  for (const { kind, pattern } of REDACTED_SHAPES) {
    out = out.replace(pattern, `[redacted:${kind}]`);
  }
  out = out.replace(BEARER, `$1[redacted:bearer]`);
  return redactNamedSecrets(out);
}
