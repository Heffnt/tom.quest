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
 *
 * The structural characters are the JSON fence, and they are why a quoted
 * value form cannot eat a document: `["password:",1757600000000,"ok"]` lets
 * the double-quoted form open on the quote that CLOSES one string and shut on
 * the one that OPENS the next, whose span (`,1757600000000,`) is long, has
 * digits and no whitespace.  No credential has ever contained a quote, a comma
 * or a brace; a span that does is JSON structure, not a value.
 */
const looksLikeCredential = (value) => {
  const text = String(value);
  if (text.length < 12) return false;                                   // too short to be one
  if (/\s/.test(text)) return false;                                    // prose, not a value
  if (/["'`,[\]{}\\]/.test(text)) return false;                         // JSON structure, not a value
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

// ── A PRIVATE KEY BLOCK LEFT OPEN ─────────────────────────────────────────────
//
// A block whose last line never came (a log cut off, a process killed while it
// printed, a buffer that stopped at its cap) is not matched by
// PEM_PRIVATE_KEY, and its body went through as ordinary text. It is taken
// from its first line over the lines a key's body can be, and no further.
//
// THE STEP READS EACH CHARACTER A BOUNDED NUMBER OF TIMES. One search finds
// the first lines; a block's lines are read by readBlockLine, which never
// reads past the next first line (a new block ends the one before it); each
// kind of line below scans its line at most twice. No regular expression is left in
// the step but that search, which is linear: a fixed literal, then words of
// one bounded class, each begun by a space, then a fixed literal. The test
// counts what the step looks at (countOpenKeyBlockReads).

const isBase64 = (c) => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "+" || c === "/";
// A carriage return that no line feed follows is read as a blank, so a line
// that ends in one is still the kind of line it would be without it.
const isBlank = (c) => c === " " || c === "\t" || c === "\r";
const isDigit = (c) => c >= "0" && c <= "9";
const isSpace = (c) => c !== undefined && c.trim() === "";

// The kinds of line, each matched against a line whose escapes readBlockLine
// has decoded, so they know raw characters only. Each takes `look`, which it
// calls for every character it looks at.
export const OPEN_KEY_BLOCK = Object.freeze({
  // A full line: forty base64 characters in a row anywhere in the line. A
  // key's body lines are one width, 64 (70 for OpenSSH, 76 in some tools),
  // and the smallest key's first line is a full one; so is a body line behind
  // any prefix (a log's timestamp) and a body folded onto one line. A line
  // holding a full commit id or another long hash is one too.
  fullLine(line, look) {
    let run = 0;
    for (let i = 0; i < line.length; i += 1) {
      look();
      run = isBase64(line[i]) ? run + 1 : 0;
      if (run >= 40) return true;
    }
    return false;
  },
  // A short line: blanks, then optionally a line number and a tab or arrow (a
  // file read with its line numbers) or a diff's sign and blanks, then one
  // base64 run, at most two `=`, and blanks to the line's end. Taken as a
  // key's last line directly after a full line, or as the text's last line
  // (the text, or the serialized string it stands in, stopped inside a body
  // line), and the block ends with it.
  shortLine(line, look) {
    const at = (i) => { look(); return line[i]; };
    let i = 0;
    while (i < line.length && isBlank(at(i))) i += 1;
    let j = i;
    while (j < line.length && isDigit(at(j))) j += 1;
    if (j > i && (at(j) === "\t" || line[j] === "→")) i = j + 1;
    else if (at(i) === "+" || line[i] === "-") i += 1;
    while (i < line.length && isBlank(at(i))) i += 1;
    const run = i;
    while (i < line.length && isBase64(at(i))) i += 1;
    if (i === run) return false;
    for (let pad = 0; pad < 2 && i < line.length && at(i) === "="; pad += 1) i += 1;
    while (i < line.length && isBlank(at(i))) i += 1;
    return i === line.length;
  },
  // A header line of an encrypted block: blanks, `Proc-Type` or `DEK-Info`,
  // blanks, a colon. Taken, like an empty line, only before the first full
  // line, and only when a line the block takes follows them.
  header(line, look) {
    let i = 0;
    while (i < line.length && isBlank(line[i])) { look(); i += 1; }
    const name = ["Proc-Type", "DEK-Info"].find((one) => line.startsWith(one, i));
    look();
    if (name === undefined) return false;
    i += name.length;
    while (i < line.length && isBlank(line[i])) { look(); i += 1; }
    look();
    return line[i] === ":";
  },
  empty(line, look) {
    for (let i = 0; i < line.length; i += 1) {
      look();
      if (!isBlank(line[i])) return false;
    }
    return true;
  },
  // A cut-off line behind a prefix: the text's last line as above, after a
  // full line, a base64 run behind one prefix holding a digit and no space
  // (a log's timestamp, grep's file:line:). Prose, several words, is not one.
  cutOff(line, look) {
    const at = (i) => { look(); return line[i]; };
    let i = 0;
    while (i < line.length && isBlank(at(i))) i += 1;
    const token = i;
    let digit = false;
    while (i < line.length && !isSpace(at(i))) { digit ||= isDigit(line[i]); i += 1; }
    if (i === token || !digit) return false;
    const blanks = i;
    while (i < line.length && isBlank(at(i))) i += 1;
    if (i === blanks) return false;
    const run = i;
    while (i < line.length && isBase64(at(i))) i += 1;
    if (i === run) return false;
    for (let pad = 0; pad < 2 && i < line.length && at(i) === "="; pad += 1) i += 1;
    while (i < line.length && isBlank(at(i))) i += 1;
    return i === line.length;
  },
});

// The escapes a serializer writes for a character of a key block, as the
// letter after the backslash: a line break, a carriage return, a tab, a
// solidus, a quote, and any character as u and four hex digits.
const ESCAPED = Object.freeze({ n: "\n", r: "\r", t: "\t", "/": "/", '"': '"' });
const isHex = (c) => isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");

/**
 * The character a run of backslashes at `at` stands for, and the length of
 * its spelling, read no further than `limit`. A backslash in the run may be
 * one character or `\u005c`, a backslash spelled as an escape.
 *
 * AN AMBIGUOUS SPELLING IS READ THE WAY THAT TAKES MORE. The filter is not
 * told whether its text was serialized, or how often, and some spellings read
 * two ways. It would rather take a word of ordinary text from a row that
 * already holds a key's first line than let a line of the key through:
 *   - any run of backslashes, spelled or not, before `n`, `r`, `t`, `/`, or
 *     `u` and four hex digits, is that escape: one backslash is a literal in
 *     raw text (a Windows path) and an escape in a serialized string; two are
 *     a literal in a string serialized once and an escape in one serialized
 *     twice; and so on;
 *   - before a quote, a run of an odd number of backslashes, none spelled, is
 *     a quote escaped: a quote in the string's text, or the end of a string
 *     inside it, which readBlockLine takes as the text's end; any other run is
 *     backslashes, and the quote after it is the string's end;
 *   - any other run is one character that is no key's (a backslash).
 * The one place the reader does not take more is a quote: it never takes one,
 * so that a serialized body stays valid JSON, whatever the text it stands in.
 */
function escapeAt(text, at, limit, look) {
  const spelledAt = (i) => {
    look();
    if (i + 6 > limit || text[i + 1] !== "u") return false;
    for (let k = 0; k < 4; k += 1) look();
    return text.slice(i + 2, i + 6).toLowerCase() === "005c";
  };
  let i = at;
  let raw = 0;
  let spelled = false;
  while (i < limit && text[i] === "\\") {
    look();
    if (spelledAt(i)) {
      spelled = true;
      i += 6;
    } else {
      raw += 1;
      i += 1;
    }
  }
  const letter = i < limit ? text[i] : undefined;
  look();
  if (letter === '"') return !spelled && raw % 2 === 1 ? { char: '"', length: i - at + 1 } : { char: "\\", length: i - at };
  if (letter === "u") {
    let hex = 0;
    while (hex < 4 && i + 1 + hex < limit && isHex(text[i + 1 + hex])) { look(); hex += 1; }
    if (hex === 4) return { char: String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)), length: i - at + 5 };
  }
  if (letter !== undefined && letter !== '"' && letter in ESCAPED) return { char: ESCAPED[letter], length: i - at + 1 };
  return { char: "\\", length: i - at };
}

/**
 * One line of an open block, read from `at` and no further than `limit`, the
 * next block's first line: `line`, its text with every escape decoded; `end`,
 * where its text ends in `text`; `next`, where the next line starts, or -1
 * when the block can have none; and `last`, whether the text stops there. A
 * line ends at a line break, raw or escaped, with a carriage return before it.
 * A quote ends the block and is read as the text's end: a raw one is the end
 * of a serialized string; an escaped one is a quote in the string's text or
 * the end of a string inside it, read the way that takes more (escapeAt). The
 * next block's first line ends the block too, and is not the text's end. A
 * block taken never holds a quote, and never ends inside an escape.
 */
function readBlockLine(text, at, limit, look) {
  const charAt = (i) => {
    if (text[i] !== "\\") { look(); return { char: text[i], length: 1 }; }
    return escapeAt(text, i, limit, look);
  };
  let line = "";
  let i = at;
  while (i < limit) {
    const { char, length } = charAt(i);
    if (char === '"') return { line, end: i, next: -1, last: true };
    if (char === "\n") return { line, end: i, next: i + length, last: false };
    if (char === "\r" && i + length < limit && charAt(i + length).char === "\n") {
      return { line, end: i, next: i + length + charAt(i + length).length, last: false };
    }
    line += char;
    i += length;
  }
  return { line, end: i, next: -1, last: limit === text.length };
}

const PEM_BEGIN = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/g;
const PEM_END = /-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g;

/**
 * `text` with PEM_PRIVATE_KEY's matches replaced, run only up to the end of
 * the text's last END line. Past it no first line has a last line, so the rule
 * matches nothing there; run over it, the rule's lazy search went on from
 * every first line to the text's end, and a megabyte of first lines took
 * seconds.
 */
function redactWholePrivateKeys(text) {
  let upTo = 0;
  PEM_END.lastIndex = 0;
  while (PEM_END.exec(text) !== null) upTo = PEM_END.lastIndex;
  return text.slice(0, upTo).replace(PEM_PRIVATE_KEY, "[redacted:pem]") + text.slice(upTo);
}

/** Where the open block whose first line ends at `from` ends, reading no
 *  further than `limit`. The rest of the first line is read as a line of the
 *  block. */
function openBlockEnd(text, from, limit, look) {
  const kinds = OPEN_KEY_BLOCK;
  let end = from;
  let at = from;
  let full = false;
  for (;;) {
    const { line, end: lineEnd, next, last } = readBlockLine(text, at, limit, look);
    if (kinds.fullLine(line, look)) {
      end = lineEnd;
      full = true;
    } else if (kinds.shortLine(line, look) && (full || last)) {
      return lineEnd;
    } else if (last && full && kinds.cutOff(line, look)) {
      return lineEnd;
    } else if (full || (!kinds.empty(line, look) && !kinds.header(line, look))) {
      return end;
    }
    if (next === -1) return end;
    at = next;
  }
}

/** `text`, which holds no whole block, with each block left open taken.
 *  `look` is called for every character the step looks at, the search for
 *  first lines counted as one look at each character of the text. */
function redactOpenPrivateKeys(text, look = () => {}) {
  const firsts = [];
  PEM_BEGIN.lastIndex = 0;
  for (let match; (match = PEM_BEGIN.exec(text)) !== null;) firsts.push([match.index, PEM_BEGIN.lastIndex]);
  for (let i = 0; i < text.length; i += 1) look();
  let out = "";
  let copied = 0;
  for (let k = 0; k < firsts.length; k += 1) {
    const [start, markerEnd] = firsts[k];
    const limit = k + 1 < firsts.length ? firsts[k + 1][0] : text.length;
    out += `${text.slice(copied, start)}[redacted:pem]`;
    copied = openBlockEnd(text, markerEnd, limit, look);
  }
  return out + text.slice(copied);
}

/** For the tests: how many characters the open-block step looks at in
 *  `text`, which holds no whole block. */
export function countOpenKeyBlockReads(text) {
  let looks = 0;
  redactOpenPrivateKeys(String(text), () => { looks += 1; });
  return looks;
}

/** `text` with every credential-shaped span replaced by `[redacted:<kind>]`. */
export function redactSecrets(text) {
  // A whole block first; a first line still standing has no last line after it.
  let out = redactOpenPrivateKeys(redactWholePrivateKeys(String(text)));
  out = out.replace(AWS_ACCESS_KEY_PAIR, "$1$2$3[redacted:aws]$3");
  for (const { kind, pattern } of REDACTED_SHAPES) {
    out = out.replace(pattern, `[redacted:${kind}]`);
  }
  out = out.replace(BEARER, `$1[redacted:bearer]`);
  return redactNamedSecrets(out);
}

/**
 * The kinds of rule in this file that can match text spanning a line break:
 * the private-key block ("pem"), an AWS access key id with its secret on the
 * next line ("aws-pair"), and a secret's name with its value on the next line
 * ("named": the JSON, escaped-JSON, assignment and spaced forms). Every other
 * rule (REDACTED_SHAPES, the Bearer header) matches within one line. A caller
 * that sends text a line at a time reads this list to know which secrets a line
 * break can split; __tests__/redact.test.mjs holds each listed rule to a case
 * it redacts across a line break, and the others to none.
 */
export const LINE_CROSSING_RULES = Object.freeze(["pem", "aws-pair", "named"]);

// A last line that closes any private key block, appended below so that the
// filter's own rule (PEM_PRIVATE_KEY) marks the block the text leaves open.
// Spelled in pieces so that no line of this file is a key block's edge.
const CLOSING_LINE = `\n${["-----END", "PRIVATE KEY-----"].join(" ")}`;

/**
 * For a caller that sends a text only up to where it is safe: where the text
 * holds a private key block left open (a first line with no last line after
 * it, which redactSecrets takes only as far as OPEN_KEY_BLOCK's lines reach), the
 * last line start at which no block is open; -1 where none is open. Everything
 * before that position redacts with every block in it closed, and a caller
 * that withholds the rest sends none of a key whose lines the grammar misses.
 *
 * Read with PEM_PRIVATE_KEY itself, so it cannot disagree with the filter: the
 * text is matched with a closing line appended, the one match that reaches the
 * appended line is the block left open, and every other match is a block the
 * filter closes in the text as it is. A line start inside a closed block is
 * not a place with no block open, so the answer moves back past it.
 */
export function openPrivateKeyLineStart(text) {
  const s = String(text);
  const closed = [];
  let open = -1;
  for (const match of (s + CLOSING_LINE).matchAll(PEM_PRIVATE_KEY)) {
    if (match.index + match[0].length > s.length) open = match.index;
    else closed.push(match);
  }
  if (open === -1) return -1;
  let at = s.lastIndexOf("\n", open - 1) + 1;
  for (let i = closed.length - 1; i >= 0; i -= 1) {
    const { index, 0: block } = closed[i];
    if (index < at && at < index + block.length) at = s.lastIndexOf("\n", index - 1) + 1;
  }
  return at;
}
