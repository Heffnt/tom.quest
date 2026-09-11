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
// break the JSON. Every value class below obeys that rule and the tests
// JSON.parse the output to keep it obeyed — on 2026-09-11 a named-assignment
// value class that had not excluded the quote ate the closing `"` of a
// serialized string, the daemon's ingest POST became malformed JSON, Convex
// answered 400, and session.mjs — which treats 400 as permanent — DROPPED the
// row. A filter that loses transcript rows is worse than the leak it stops.
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
// an assignment one — if the value also LOOKS like a credential.  The list is
// two flavors, deliberately built as two regexes because their case rules
// differ:
//
//  - the WORDS are matched case-insensitively ("api_key", "Api-Key",
//    "API-KEY").  Every one of them means a credential on its own.  Bare
//    `key`, bare `token` and bare `pwd` are NOT here and must not be added: a
//    field named `key` holds a row's identifier far more often than a
//    credential, `token` is the unit a model bills in, and `PWD` is the
//    working directory.  The wider list redacted `token = the smallest unit`
//    and `PWD=/root/x`.
//  - the ENVIRONMENT names are matched CASE-SENSITIVELY, upper case only,
//    which is what lets their suffix list be four words: GITHUB_TOKEN,
//    TTS_WORKER_KEY and AWS_SECRET_ACCESS_KEY are all caught without a rule
//    each, while "tokens", "monkey" and "turkey" are not names at all.
const SECRET_WORD = "(?:api[_-]?key|apikey|secret|password|passwd|private[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|bearer|authorization)";
const SECRET_ENV_NAME = "[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)";
const NAME_FLAVORS = Object.freeze([
  { name: SECRET_WORD, flags: "gi" },
  { name: SECRET_ENV_NAME, flags: "g" },
]);

// The value forms, in the order they are tried.  EVERY ONE OF THEM ENDS WHERE
// A JSON STRING WOULD END and none can swallow half of a backslash escape,
// which is the property that makes the whole filter safe to run over an
// already-serialized body.  The escaped forms are not decoration: the daemon
// redacts `JSON.stringify(body)` and the ingest parser redacts raw JSONL, so a
// JSON blob a tool printed reaches this filter as `\"api_key\": \"…\"` far more
// often than as `"api_key": "…"`.
const ESCAPED_DOUBLE = String.raw`\\"((?:[^"\\]|\\\\[^"])*)\\"`;
const DOUBLE = String.raw`"((?:\\.|[^"\\])*)"`;
const SINGLE = String.raw`'((?:\\.|[^'\\])*)'`;
const BARE = String.raw`[^\s,;\]}"\\]+`;
const NAMED_VALUE = `(?:${ESCAPED_DOUBLE}|${DOUBLE}|${SINGLE}|(${BARE}))`;

// These forms deliberately retain the key and its punctuation.  A transcript
// remains useful when it says which configuration was present, but its value
// must never cross the machine boundary.  JSON is separate (in both its plain
// and its escaped spelling) so replacing a quoted value cannot make an
// otherwise valid JSONL source invalid.
const namedRules = NAME_FLAVORS.map(({ name, flags }) => ({
  json: new RegExp(String.raw`("(${name})"\s*:\s*)${DOUBLE}`, flags),
  escapedJson: new RegExp(String.raw`(\\"(${name})\\"\s*:\s*)${ESCAPED_DOUBLE}`, flags),
  assignment: new RegExp(String.raw`(\b(${name})\b\s*(?:=|:)\s*)${NAMED_VALUE}`, flags),
  // Some tools print "auth_token <value>" rather than an assignment.  Restrict
  // this fallback to a plausibly high-entropy value: ordinary prose about a
  // token is not a credential merely because it follows that word.
  spaced: new RegExp(
    String.raw`(\b(${name})\b(?:\s+(?:is|was)\s+|\s+))([A-Za-z0-9._~+/=-]{32,})`,
    flags,
  ),
}));
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
/**
 * Whether a named value is shaped like a credential rather than like the
 * ordinary content that shares these names.  A secret is long, unbroken, and
 * not a word: `hunter2secret1` and a 40-character AWS secret pass; `the`,
 * `/root/x`, `not-configured` and `learning:abc` do not.  This is the second
 * half of the 2026-09-11 narrowing — the name list says which values are
 * CANDIDATES, this says which candidates are credentials.
 */
const looksLikeCredential = (value) => {
  const text = String(value);
  if (text.length < 12) return false;                                   // too short to be one
  if (/\s/.test(text)) return false;                                    // prose, not a value
  if (/^(?:~|\.{1,2})?[\\/]/.test(text) || /^[A-Za-z]:[\\/]/.test(text)) return false; // a path
  if (/^[A-Za-z]+(?:[-_][A-Za-z]+)*$/.test(text)) return false;         // words, not a value
  return /[0-9]/.test(text)
    || (/[a-z]/.test(text) && /[A-Z]/.test(text))
    || /[.~+/=]/.test(text);
};

/** The marker for `key`, or `match` unchanged when the value is not one. */
const replaceValue = (match, key, value, quote, prefix) => {
  if (value === undefined || isMarker(value)) return match;
  if (/^Bearer$/i.test(value) || !looksLikeCredential(value)) return match;
  return `${prefix}${quote}${markerFor(key)}${quote}`;
};

function redactNamedSecrets(text) {
  let out = text;
  for (const rule of namedRules) {
    out = out.replace(rule.json, (match, prefix, key, value) => (
      replaceValue(match, key, value, '"', prefix)
    ));
    out = out.replace(rule.escapedJson, (match, prefix, key, value) => (
      replaceValue(match, key, value, '\\"', prefix)
    ));
    out = out.replace(rule.assignment, (match, prefix, key, escaped, doubleQuoted, singleQuoted, bare) => {
      const value = escaped ?? doubleQuoted ?? singleQuoted ?? bare;
      const quote = escaped !== undefined
        ? '\\"'
        : doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : "";
      return replaceValue(match, key, value, quote, prefix);
    });
    out = out.replace(rule.spaced, (match, prefix, key, value) => (
      isMarker(value) || !isHighEntropy(value) || !looksLikeCredential(value)
        ? match
        : `${prefix}${markerFor(key)}`
    ));
  }
  return out;
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
