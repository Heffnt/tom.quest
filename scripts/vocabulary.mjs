// THE VOCABULARY GENERATOR, and the drift check between the two repositories,
// in one program.
//
// It reads WikiTom (`tts/spec.md` §12.1 and its two extensions, and
// `model-of-tom/agent-rules.md`) and tom.quest (Convex schema and shared
// constants, the cron files, the search library, the skills library, the run
// machinery) and renders ONE file: `WikiTom tts/vocabulary.json` — every word
// TTS uses, every identity it mints, every scheduled job, every question
// `tts search` answers, every published skill, the repositories and the Slack
// channels, each with where it is defined and what defines it.
//
// It also renders two derived views: the generated block in
// `convex/ttsShared.ts`, and — under MAP_BLOCKS = "candidate" — a candidate
// `model-of-tom/agent-rules.candidate.md` beside Tom's map with a unified diff,
// which is a proposal and never the map.
//
// WHAT THIS IS NOT. It is not where a term is defined: §12.1 is (AUTHORITY
// below). It is not loaded into any prompt — `TTS_CLOSED_VOCABULARY` carries
// seven words and this file carries the rest for `tts search define` to answer
// from. It is not a database, and it has no model call, no network call and no
// timestamp in it.
//
// PARSE, NEVER EVALUATE. `convex/*.ts` is TypeScript and the Jarvis Box runs
// plain Node with no TypeScript loader, so every tom.quest input is read as
// TEXT. Every extraction takes a NAMED BLOCK, counts the entries in it, asserts
// that count against what the block itself declares or against a second list,
// and throws naming the entry it could not read — an input the parser cannot
// read must stop the program, because a silently dropped entry is a file that
// says the system has one fewer job than it has.
//
// DETERMINISTIC. No timestamp, no `Date.now()`, no locale argument to
// `localeCompare`, every array sorted by its first field, every object's keys in
// this file's reading order. The nightly commits `tts/vocabulary.json` only when
// its bytes changed, and that test is a lie the moment two runs of this program
// on one input produce two files.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "../worker/jobs/graph-hash.mjs";
import { EDGE_KINDS, NODE_KINDS } from "../worker/jobs/graph.mjs";
// The platform defaults for a WikiTom checkout are spelled ONCE, in the search
// library; re-spelling them here would be the second copy this whole file
// exists to remove.
// THE TWO WIKITOM DEFAULTS, SPELLED HERE, and this is a deviation with a reason.
//
// worker/jobs/search-lib.mjs owns the canonical spelling and the brief says to
// import its two constants rather than repeat them. Importing it drags a
// subtree: search-lib.mjs imports ./session-archive.mjs, which imports
// ../session-host/redact.mjs, and on the box these live in three different
// install directories, so a nested copy of search-lib.mjs needs a nested copy
// of everything under it or it throws at load and takes this generator with it.
// Two string constants are not worth a subtree. The same call was made, for the
// same reason, for worker/jobs/worker-env.mjs on this branch.
const LAPTOP_WIKITOM_DIR = "C:/Users/heffn/Desktop/WikiTom";
const BOX_WIKITOM_DIR = "/root/wikitom";
import { AREAS_DIR, SKILL_SHAPES, parseRepoBullets } from "./skills.mjs";

export class VocabularyError extends Error {}

// ── The switches ─────────────────────────────────────────────────────────────

/** Tom's, pending (phase 10 switch (a)). "candidate": the generator writes
 *  agent-rules.candidate.md and a diff and never touches the live file — the
 *  hand-written map stays authoritative. "live": the four restating blocks of
 *  model-of-tom/agent-rules.md are replaced in place and the file becomes partly
 *  generated. Both are implemented; "live" is one edit to this line away. */
export const MAP_BLOCKS = "candidate";

/** Tom's, pending (phase 10 switch (b)). "spec": §12.1 of WikiTom tts/spec.md
 *  is where a term is defined and this file renders from it. The only other
 *  answer is "file", in which the JSON is authored and the spec section is
 *  rendered from it — which is a different program, not a branch of this one. */
export const AUTHORITY = "spec";

/** 40 KiB. The file is never loaded into a prompt, so this is not a prompt cost:
 *  it is the size past which the file has stopped being something Tom could read
 *  whole, and crossing it means something structural changed. */
export const VOCABULARY_MAX_BYTES = 40_960;

export const GENERATOR_VERSION = 1;
export const GENERATOR_PATH = "scripts/vocabulary.mjs";

export const VOCABULARY_PATH = "tts/vocabulary.json";
export const SHARED_PATH = "convex/ttsShared.ts";
export const AGENT_RULES_PATH = "model-of-tom/agent-rules.md";
export const CANDIDATE_PATH = "model-of-tom/agent-rules.candidate.md";
export const CANDIDATE_DIFF_PATH = "model-of-tom/agent-rules.candidate.diff";
export const CANDIDATE_EVIDENCE_PATH = "model-of-tom/evidence/agent-rules.candidate.md";

/** The map is under 7,000 bytes by WikiTom's own rule, counted with the carriage
 *  returns removed — the file is CRLF on disk and the rule is about what an
 *  agent loads, which is the text and not the line endings. */
export const AGENT_RULES_MAX_LF_BYTES = 7_000;

/** The seven words `TTS_CLOSED_VOCABULARY` carries, in the order its four
 *  bullets carry them. They are the seven a worker acts on WITHOUT being able to
 *  stop and ask; every other word is answered by `tts search define`, which
 *  costs no prompt bytes. */
export const PROMPT_TERMS = Object.freeze([
  "batch",
  "task",
  "goal",
  "needs",
  "ready",
  "display text",
  "ground-up explanation",
]);

const MARKER_OPEN = (version) => `// <vocabulary generated version=${version} — ${GENERATOR_PATH}; do not edit>`;
const MARKER_CLOSE = "// </vocabulary generated>";
/** Matches any open marker, whatever version it carries — the check that the
 *  block is present must not depend on the block being current. */
const MARKER_OPEN_ANY = /^\/\/ <vocabulary generated version=([0-9a-f]{16}) — .*>$/m;

// ── Errors and assertions ────────────────────────────────────────────────────

function fail(message) {
  throw new VocabularyError(`vocabulary: ${message}`);
}

/**
 * The count assertion every extraction in this file ends with: `declared` is
 * what the source itself says it holds, `parsed` is what came out. A mismatch
 * throws naming the shortfall, because the alternative — carrying on with fewer
 * rows — publishes a file that states the system is smaller than it is.
 */
function assertCount(label, declared, parsed, detail) {
  if (declared !== parsed) {
    fail(`${label}: the source declares ${declared} and the parser read ${parsed}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const NUMBER_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
});

// ── Text ─────────────────────────────────────────────────────────────────────

/** LF-normalized text for every parser. A CRLF checkout and an LF checkout must
 *  produce the same bytes, so the line endings are removed before anything reads
 *  the text and restored only by the candidate writer. */
function normalize(text) {
  return String(text ?? "").replace(/\r\n/g, "\n");
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

function readRequired(root, rel, what) {
  const file = path.join(root, rel);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    fail(`cannot read ${rel} under ${root} (${what}): ${error.message}`);
  }
  return normalize(raw);
}

/** The file's bytes as they are on disk, line endings and all — only the two
 *  writers need this; every parser reads the LF-normalized form. */
function readRaw(root, rel, what) {
  const file = path.join(root, rel);
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    fail(`cannot read ${rel} under ${root} (${what}): ${error.message}`);
  }
  return "";
}

function readOptional(root, rel) {
  const file = path.join(root, rel);
  try {
    return normalize(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The 1-based line the first occurrence of `needle` sits on, or 0. Used only
 *  for the disagreement report, which names a file and a line so a run pasting
 *  it into a report adds nothing. */
function lineOf(text, needle) {
  const at = text.indexOf(needle);
  if (at === -1) return 0;
  return text.slice(0, at).split("\n").length;
}

/** Markdown stripped to the words, for comparing two statements of one term.
 *  Two texts that differ only in emphasis, a section reference or punctuation
 *  are one statement; anything else is two, which is what D1 reports. */
function normalizeClaim(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\(§[^)]*\)/g, " ")
    .replace(/§[\d.]+/g, " ")
    .replace(/[*`_]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function byFirstField(field) {
  return (a, b) => String(a[field]).localeCompare(String(b[field]));
}

// ── Git ──────────────────────────────────────────────────────────────────────

/**
 * The HEAD commit of a checkout, read from `.git` as TEXT — no child process, so
 * the box's nightly never shells out and a checkout with no git at all returns
 * null rather than throwing. ABSENT IS A SUPPORTED VALUE: a commit is recorded
 * when it can be read and is never guessed.
 */
export function headSha(root) {
  try {
    const dot = path.join(root, ".git");
    const stat = fs.statSync(dot);
    let gitDir = dot;
    if (stat.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, "utf8"));
      if (pointer === null) return null;
      gitDir = path.resolve(root, pointer[1].trim());
    }
    // A linked worktree keeps its own HEAD but shares refs/ with the common dir.
    let commonDir = gitDir;
    try {
      commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
    } catch {
      commonDir = gitDir;
    }
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (ref === null) return null;
    for (const dir of [gitDir, commonDir]) {
      try {
        const value = fs.readFileSync(path.join(dir, ref[1]), "utf8").trim();
        if (/^[0-9a-f]{40}$/.test(value)) return value;
      } catch {
        // The ref may only exist packed; fall through to packed-refs.
      }
    }
    const packed = fs.readFileSync(path.join(commonDir, "packed-refs"), "utf8");
    const row = new RegExp(`^([0-9a-f]{40}) ${ref[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(packed);
    return row === null ? null : row[1];
  } catch {
    return null;
  }
}

// ── §12.1 and its two extensions ─────────────────────────────────────────────

const TERM_BULLET = /^-\s+(.*)$/;
const BOLD = /\*\*(.+?)\*\*/g;

/** The lines of one `### n.n <title>` section, exclusive of the next heading. */
function specSection(specText, heading) {
  const lines = specText.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`### ${heading} `));
  if (start === -1) fail(`tts/spec.md has no \`### ${heading}\` heading`);
  const out = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{2,4}\s/.test(lines[index])) break;
    out.push({ line: index + 1, text: lines[index] });
  }
  return out;
}

function stripName(name) {
  return String(name).replace(/[`*]/g, "").trim();
}

/**
 * A term's kind, decided from the shape of its own definition and from nothing
 * else — there is no hand-kept table of kinds, because a table is a second place
 * a term is described and the next edit to §12.1 would not reach it.
 */
function kindOfTerm(name, definition) {
  if (/^#/.test(name)) return "channel";
  // A closed set of values reads as two or more backticked words joined by `/`.
  if (/`[^`]+`\s*\/\s*`[^`]+`/.test(definition)) return "value";
  if (/`[^`]*\/[^`]*`|\.md\b|\.json\b/.test(definition)) return "artifact";
  if (/\bcontract\b|\brule\b|\bledger\b/.test(name)) return "contract";
  return "concept";
}

/**
 * One spec section parsed into term entries.
 *
 * Three bullet shapes exist in §12.1 and all three are read here rather than
 * skipped: the ordinary `- **word** — definition`; the multi-name bullet whose
 * bold holds several names joined by ` / ` (the six Slack channels), which
 * yields one entry per name over one definition; and the closing cross-reference
 * bullet, which has no em dash and yields one entry per bolded name whose
 * definition is the section it points at. A bullet matching none of the three
 * THROWS with the bullet quoted.
 */
function parseTermSection(specText, heading, fallbackSection) {
  const rows = specSection(specText, heading);
  const terms = [];
  let bullets = 0;
  for (const row of rows) {
    const match = TERM_BULLET.exec(row.text);
    if (match === null) continue;
    const body = match[1].trim();
    if (!body.startsWith("**")) continue;
    bullets += 1;
    const dash = body.indexOf("** — ");
    if (dash === -1) {
      // The cross-reference bullet: `**a** (§12) · **b** (§13) · …`.
      const parts = body.split(" · ");
      let read = 0;
      for (const part of parts) {
        const name = /\*\*(.+?)\*\*/.exec(part);
        const section = /\(§([\d.]+)\)/.exec(part);
        if (name === null || section === null) continue;
        read += 1;
        terms.push({
          term: stripName(name[1]),
          kind: "contract",
          definition: `fixed in §${section[1]}`,
          specSection: section[1],
          line: row.line,
        });
      }
      assertCount(`spec §${heading} cross-reference bullet`, parts.length, read, `"${body}"`);
      continue;
    }
    const names = [...body.slice(0, dash + 2).matchAll(BOLD)].map((hit) => stripName(hit[1]));
    if (names.length === 0) fail(`spec §${heading} bullet names no term: "${body}"`);
    const definition = body.slice(dash + 5).trim();
    if (definition === "") fail(`spec §${heading} bullet has no definition: "${body}"`);
    // A bold holding `a / b / c` is one definition over several names.
    const spelled = names.length === 1 ? names[0].split(" / ").map(stripName) : names;
    const pointer = /§([\d]+(?:\.[\d]+)?)/.exec(definition);
    const section = fallbackSection === "12.1" && pointer !== null ? pointer[1] : fallbackSection;
    for (const name of spelled) {
      terms.push({ term: name, kind: kindOfTerm(name, definition), definition, specSection: section, line: row.line });
    }
    // A word bolded INSIDE a definition and given its own parenthetical gloss is
    // its own entry: `task` and `goal` are fixed nowhere else in §12.1, and a
    // parser that read only the bullet's own name would leave two of the seven
    // words the prompt constant carries undefined.
    for (const nested of definition.matchAll(/\*\*([^*]+)\*\* \(([^()]*)\)/g)) {
      const name = stripName(nested[1]);
      if (spelled.includes(name)) continue;
      terms.push({ term: name, kind: kindOfTerm(name, nested[2]), definition: nested[2].trim(), specSection: section, line: row.line });
    }
  }
  if (bullets === 0) fail(`spec §${heading} holds no term bullets`);
  return terms;
}

const REFUSED_HEADER = "**Words that are not TTS words.**";

/**
 * The refusal list: each segment names one or more words and ends with the one
 * parenthetical saying what the word is a second name for. A segment with no
 * name or no parenthetical THROWS — the refusal list is how
 * `tts search define <a refused word>` answers, and a silently dropped segment is a word
 * the CLI would claim it had never heard of.
 */
function parseRefusedTerms(specText) {
  const rows = specSection(specText, "12.1");
  const row = rows.find((candidate) => candidate.text.startsWith(REFUSED_HEADER));
  if (row === undefined) fail("tts/spec.md §12.1 has no `Words that are not TTS words` line");
  const segments = row.text.slice(REFUSED_HEADER.length).trim().split(" · ");
  const terms = [];
  let read = 0;
  for (const segment of segments) {
    const names = [...segment.matchAll(BOLD)].map((hit) => stripName(hit[1]));
    const reason = /\(([^()]*)\)\s*\.?\s*$/.exec(segment);
    if (names.length === 0 || reason === null) {
      fail(`§12.1 refusal segment reads as neither a word nor a reason: "${segment}"`);
    }
    read += 1;
    const because = reason[1].trim();
    for (const name of names) {
      terms.push({
        term: name,
        kind: "refused",
        definition: `not a TTS word — ${because}`,
        specSection: "12.1",
        because,
        line: row.line,
      });
    }
  }
  assertCount("§12.1 refusal list", segments.length, read);
  return terms;
}

/**
 * Every term, §12.1 first, then §20.1, then §23.1, then the refusals — the order
 * §12.1 itself puts them in.
 *
 * A word fixed in §12.1 and re-stated in an extension keeps its §12.1 entry:
 * §12.1 declares both extensions part of itself, so the two are one definition
 * in two places by design and not a disagreement.
 */
export function parseTerms(specText) {
  const text = normalize(specText);
  const ordered = [
    ...parseTermSection(text, "12.1", "12.1"),
    ...parseTermSection(text, "20.1", "20.1"),
    ...parseTermSection(text, "23.1", "23.1"),
    ...parseRefusedTerms(text),
  ];
  const seen = new Map();
  for (const entry of ordered) {
    const key = entry.term.toLowerCase();
    if (!seen.has(key)) seen.set(key, entry);
  }
  const terms = [...seen.values()];
  // `related` is computed from the definitions, never authored: a term is
  // related to another when its definition uses that other word.
  const names = terms.filter((entry) => entry.kind !== "refused").map((entry) => entry.term);
  for (const entry of terms) {
    const plain = normalizeClaim(entry.definition);
    const related = names.filter((name) => {
      if (name.toLowerCase() === entry.term.toLowerCase()) return false;
      if (name.length < 4) return false;
      const word = normalizeClaim(name);
      if (word === "") return false;
      return new RegExp(`(^| )${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?( |$)`).test(plain);
    });
    entry.related = [...new Set(related)].sort((a, b) => a.localeCompare(b));
  }
  return terms;
}

// ── The code symbol a term is implemented by ─────────────────────────────────

/**
 * The terms whose definition has an implementation with a NAME. Every entry is
 * checked by D2 — the file must exist and must carry the symbol — so this table
 * cannot quietly describe a symbol that was renamed. A term absent from it
 * carries `codeSymbol: null`, which is honest: most words name a posture or a
 * register and nothing in the code is named after them.
 */
const TERM_CODE_SYMBOLS = Object.freeze({
  batch: "convex/schema.ts:batches",
  todo: "convex/schema.ts:dtsTodos",
  ruling: "convex/schema.ts:dtsRulings",
  run: "convex/schema.ts:runs",
  session: "convex/schema.ts:claudeSessions",
  "narrow list": "convex/ttsShared.ts:NARROW_LIST",
  repeat: "convex/schema.ts:ttsRepeats",
  "calendar mirror": "convex/schema.ts:ttsCalendarEvents",
  // Evals are events, not a table of their own: `evals-run` is the row the merge
  // gate reads, and its kind is the named constant.
  evals: "convex/ttsEvals.ts:EVALS_RUN",
  search: "worker/jobs/search-lib.mjs:SEARCH_COMMANDS",
  skill: "scripts/skills.mjs:SKILL_SHAPES",
  "the base and the skills": "scripts/skills.mjs:SKILL_SHAPES",
  transcript: "convex/schema.ts:runFileVersions",
  block: "convex/schema.ts:dtsBlocks",
  "time note": "convex/schema.ts:dtsTimeNotes",
});

/** D2's test: the file exists and defines the symbol as an export, a function or
 *  a Convex table. Three spellings because the three kinds of symbol this table
 *  names are spelled three ways in the sources. */
function symbolDefined(text, symbol) {
  const quoted = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `export const ${quoted}\\b|export function ${quoted}\\b|^\\s*${quoted}: defineTable|^const ${quoted}\\b|^\\s*${quoted} = `,
    "m",
  ).test(text);
}

// ── The identities ───────────────────────────────────────────────────────────

/**
 * THE CANONICAL ID REGISTER, declared here and checked against the sources by
 * D4. Each row names the file its identity is minted in and, where the shape is
 * an expression that already exists in the code, the CONSTANT to quote it from —
 * the register never carries a copy of a regex, it carries the source text of
 * the one that is already there.
 */
const ENTITY_SPECS = Object.freeze([
  {
    id: "runId",
    shape: "<runner>:<host>:<thread id>[/<agent id>]",
    regexFrom: { file: "convex/runs.ts", name: "RUN_ID" },
    mintedIn: "worker/runs/ingest.mjs",
    mintedPattern: /`claude:\$\{host\}:/,
    validatedIn: "convex/runs.ts:RUN_ID",
    example: "claude:box:0f2a55b1-63c4-4d4e-9d3a-2f0c11aa9e71",
    term: "run",
  },
  {
    id: "sdkSessionId",
    shape: "the SDK's own session id, opaque — no shape of ours",
    regex: null,
    mintedIn: "worker/session-host/session.mjs",
    mintedPattern: /sdkSessionId/,
    validatedIn: "convex/schema.ts:claudeSessions.sdkSessionId",
    example: null,
    term: "session",
  },
  {
    id: "askId",
    shape: "8 lowercase hex",
    // Validated inline in the HTTP door today rather than by a named constant;
    // the entity quotes the inline expression and says where it sits.
    regexLiteral: "/^[0-9a-f]{8}$/",
    mintedIn: "convex/http.ts",
    mintedPattern: /\/\^\[0-9a-f\]\{8\}\$\//,
    validatedIn: "convex/http.ts",
    example: "9f14a2c7",
    term: "delegate",
  },
  {
    id: "mergeKey",
    shape: "<repo>:<sha>",
    regex: null,
    mintedIn: "convex/ttsMerge.ts",
    mintedPattern: /export function mergeKey\(/,
    validatedIn: "convex/ttsMerge.ts:mergeKey",
    example: "tom.quest:d07e0e3ac1f0b4a9d3e5c7b118f2a6d4e9c0b3a7",
    term: null,
  },
  {
    id: "commitKey",
    shape: "<repo>@<sha>",
    regex: null,
    mintedIn: "convex/ttsMerge.ts",
    mintedPattern: /export function commitKey\(/,
    validatedIn: "convex/ttsMerge.ts:commitKey",
    example: "tom.quest@d07e0e3ac1f0b4a9d3e5c7b118f2a6d4e9c0b3a7",
    term: null,
  },
  {
    id: "documentId",
    shape: "a Convex document id — opaque, never parsed",
    regex: null,
    mintedIn: "convex/schema.ts",
    mintedPattern: /dtsTodos: defineTable/,
    validatedIn: "convex/schema.ts:dtsTodos",
    example: null,
    term: "todo",
  },
  {
    id: "regToken",
    shape: "UUID v1–v8",
    regexFrom: { file: "worker/runs/registration.mjs", name: "UUID" },
    mintedIn: "worker/runs/registration.mjs",
    mintedPattern: /crypto\.randomUUID\(\)/,
    validatedIn: "convex/schema.ts:runs.regToken",
    example: "0f2a55b1-63c4-4d4e-9d3a-2f0c11aa9e71",
    term: "registration envelope",
  },
  {
    id: "storeKey",
    shape: "runs/<runtime>/<host>/<thread parts>/<fileVersion><ext>",
    regex: null,
    mintedIn: "worker/runs/store.mjs",
    mintedPattern: /const objectKey = /,
    validatedIn: "worker/runs/store.mjs:objectKey",
    example: null,
    term: "file version",
  },
  {
    id: "skillId",
    shape: "tom-<name>",
    regex: null,
    mintedIn: "scripts/skills.mjs",
    mintedPattern: /export function skillDirName\(/,
    validatedIn: "scripts/skills.mjs:skillDirName",
    example: "tom-know-research",
    term: "skill",
  },
]);

/**
 * The spellings of `dtsEvents.key`, one row per spelling, each naming the event
 * kinds that use it. The KINDS are not declared here — they are parsed out of
 * the schema comment that is their only register today, and the union of the
 * kinds named below must equal what parsed, exactly. That is what stops the two
 * from drifting: adding a seventeenth kind to the comment and not to a spelling
 * fails, and so does the reverse.
 */
const EVENT_KEY_SPELLINGS = Object.freeze([
  { id: "eventKey:thread", shape: "<channel>:<thread root ts>", kinds: ["slack-sent", "slack-thread-claimed"], example: "C0123ABCD:1725900000.000100" },
  { id: "eventKey:slack-event", shape: "Slack's own event_id", kinds: ["slack-event"], example: null },
  { id: "eventKey:producer", shape: "<producer>:<kind>:<id>", kinds: ["needs-tom"], example: "gmail:message:18f2a6d4e9c0b3a7" },
  { id: "eventKey:ask-claim", shape: "<TTS day>:<ask>:<item id>", kinds: ["slack-claimed"], example: null },
  { id: "eventKey:condition", shape: "<job>:<condition>", kinds: ["job-failed", "job-recovered"], example: "poll-canvas:canvas-auth" },
  { id: "eventKey:batch", shape: "the batch id the session was opened on", kinds: ["session-created", "session-outcome"], example: null },
  { id: "eventKey:ask", shape: "the ask's own id", kinds: ["delegate-decision", "delegate-objection"], example: "9f14a2c7" },
  { id: "eventKey:commit", shape: "<repo>@<sha>", kinds: ["audit-verdict", "evals-request", "evals-run", "tests-run"], example: "tom.quest@d07e0e3ac1f0b4a9d3e5c7b118f2a6d4e9c0b3a7" },
  { id: "eventKey:merge", shape: "<repo>:<sha>", kinds: ["merge"], example: "tom.quest:d07e0e3ac1f0b4a9d3e5c7b118f2a6d4e9c0b3a7" },
]);

/**
 * The `dtsEvents.key` comment block, parsed into the event kinds it registers.
 *
 * The comment names its own count in words ("set on exactly sixteen kinds"), and
 * that sentence is the assertion: a kind added to the block without the count
 * being raised, or a count raised without the kind, stops the program here
 * rather than producing a register that is quietly short.
 */
export function parseEventKinds(schemaText) {
  const text = normalize(schemaText);
  const start = text.indexOf("// The lookup key, set on exactly ");
  if (start === -1) fail("convex/schema.ts has no `dtsEvents.key` register comment");
  const end = text.indexOf("key: v.optional(v.string())", start);
  if (end === -1) fail("convex/schema.ts's `dtsEvents.key` register comment does not reach the field it describes");
  const block = text.slice(start, end);
  const declaredWord = /set on exactly ([a-z]+) kinds/.exec(block);
  if (declaredWord === null) fail("convex/schema.ts's `dtsEvents.key` comment does not state how many kinds it registers");
  const declared = NUMBER_WORDS[declaredWord[1]];
  if (declared === undefined) fail(`convex/schema.ts's \`dtsEvents.key\` comment says "${declaredWord[1]}" kinds, which is not a number word this parser knows`);
  const kinds = [...new Set([...block.matchAll(/"([a-z][a-z-]+)"/g)].map((hit) => hit[1]))];
  assertCount("convex/schema.ts dtsEvents.key", declared, kinds.length, `read [${kinds.join(", ")}]`);
  return kinds.sort((a, b) => a.localeCompare(b));
}

/** A regex constant's SOURCE TEXT, quoted rather than copied: `const NAME =
 *  /…/;`. D4 fails when the constant is gone or is not a regex. */
function regexSource(text, name, file) {
  const match = new RegExp(`^\\s*(?:export\\s+)?const ${name} = (/.*/[a-z]*);`, "m").exec(normalize(text));
  if (match === null) fail(`${file} has no regex constant \`${name}\``);
  return match[1];
}

// ── The jobs ─────────────────────────────────────────────────────────────────

/**
 * The Convex jobs, from `crons.interval(...)` and `crons.cron(...)`. The count
 * is asserted against every `crons.` call in the file, so a third registration
 * form appearing is a stop rather than a job that silently never enters the
 * register.
 */
export function parseConvexJobs(cronsText) {
  const text = normalize(cronsText);
  const calls = [...text.matchAll(/crons\.(\w+)\(/g)].filter((hit) => hit[1] !== "cronJobs");
  const jobs = [];
  for (const hit of text.matchAll(/crons\.interval\(\s*"([^"]+)",\s*\{\s*(\w+):\s*(\d+)\s*\}\s*,\s*internal\.([\w.]+)/g)) {
    jobs.push({ name: hit[1], where: "convex", cadence: `every ${hit[3]} ${hit[2]}`, file: "convex/crons.ts", cronLines: [], handler: hit[4] });
  }
  for (const hit of text.matchAll(/crons\.cron\(\s*"([^"]+)",\s*"([^"]+)",\s*internal\.([\w.]+)/g)) {
    jobs.push({ name: hit[1], where: "convex", cadence: `cron ${hit[2]} UTC`, file: "convex/crons.ts", cronLines: [hit[2]], handler: hit[3] });
  }
  assertCount("convex/crons.ts", calls.length, jobs.length, "a `crons.` call this parser does not read");
  return jobs;
}

const CRON_FIELDS = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+root\s+(.*)$/;

/**
 * The box jobs, from the `/etc/cron.d/tts` heredoc in `worker/setup.sh`.
 *
 * The heredoc is taken whole and every line in it is classified: a comment, a
 * blank, an environment assignment, a COMMENTED-OUT cron line (there is one, and
 * it is deliberately not a job), or a cron line. A line matching none of those
 * THROWS — a cron line this parser cannot read is a scheduled job the register
 * would claim does not exist.
 */
export function parseBoxJobs(setupText) {
  const text = normalize(setupText);
  const open = text.indexOf("cat > /etc/cron.d/tts <<'CRON'\n");
  if (open === -1) fail("worker/setup.sh has no `/etc/cron.d/tts` heredoc");
  const bodyStart = open + "cat > /etc/cron.d/tts <<'CRON'\n".length;
  const close = text.indexOf("\nCRON\n", bodyStart);
  if (close === -1) fail("worker/setup.sh's `/etc/cron.d/tts` heredoc is not closed");
  const lines = text.slice(bodyStart, close).split("\n");
  const jobs = [];
  let considered = 0;
  let comment = [];
  for (const line of lines) {
    if (line.trim() === "") {
      comment = [];
      continue;
    }
    if (line.startsWith("#")) {
      comment.push(line.replace(/^#+\s*/, ""));
      continue;
    }
    if (/^[A-Z_]+=/.test(line)) continue;
    considered += 1;
    const match = CRON_FIELDS.exec(line);
    if (match === null) fail(`worker/setup.sh cron line reads as neither a schedule nor a comment: "${line}"`);
    const script = /\/opt\/tts\/((?:[\w-]+\/)*)([\w.-]+)\.mjs/.exec(match[2]);
    if (script !== null) {
      // `/opt/tts/` is worker/jobs flattened; anything under a subdirectory of it
      // keeps that subdirectory under worker/.
      jobs.push({
        name: script[2],
        where: "box",
        cadence: `cron ${match[1]} UTC`,
        file: script[1] === "" ? `worker/jobs/${script[2]}.mjs` : `worker/${script[1]}${script[2]}.mjs`,
        cronLines: [match[1]],
        handler: null,
      });
      comment = [];
      continue;
    }
    // A maintenance line runs a shell command rather than a job script. It is
    // still a scheduled job, so it enters the register under the name its own
    // comment gives it — a line the parser could not name at all would be a job
    // this file claimed did not exist.
    const named = /^([A-Za-z][\w -]*?)[:.]/.exec(comment[0] ?? "");
    if (named === null) fail(`worker/setup.sh cron line runs no /opt/tts script and its comment names no job: "${line}"`);
    jobs.push({
      name: named[1].trim().toLowerCase().replace(/\s+/g, "-"),
      where: "box",
      cadence: `cron ${match[1]} UTC`,
      file: null,
      cronLines: [match[1]],
      handler: null,
    });
    comment = [];
  }
  assertCount("worker/setup.sh /etc/cron.d/tts", considered, jobs.length);
  return jobs;
}

/** The event kinds a box job writes, read from the job's own source. A job whose
 *  file is not in the checkout carries an empty list rather than a guess. */
function eventKindsWritten(tomQuest, file, kinds) {
  if (file === null) return [];
  const text = readOptional(tomQuest, file);
  if (text === null) return [];
  return kinds.filter((kind) => text.includes(`"${kind}"`)).sort((a, b) => a.localeCompare(b));
}

// ── The search questions ─────────────────────────────────────────────────────

function parseCommandSet(searchLibText, name) {
  const match = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(normalize(searchLibText));
  if (match === null) fail(`worker/jobs/search-lib.mjs has no \`${name}\` set`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((hit) => hit[1]);
}

/**
 * Every question the CLI answers, with the corpus it reads and the one-line
 * `what` taken from the HELP paragraph that already documents it.
 *
 * The corpus sets are parsed out of the source because they are not exported;
 * `SEARCH_COMMANDS` is imported, because it is. D5 compares the two, which is
 * the point: a command added to one and not the other stops here.
 */
/**
 * The HELP block's text, taken out of the source rather than out of the module.
 *
 * It is one template literal, `const HELP = \`…\`;`, so the parse is the text
 * between the first backtick after the name and the backtick that closes it.
 * Parse, never evaluate: the box runs plain Node and this generator has to load
 * there without dragging search-lib.mjs's own import subtree behind it.
 */
export function parseHelp(searchLibText) {
  const at = searchLibText.indexOf("const HELP = `");
  if (at === -1) fail("worker/jobs/search-lib.mjs has no `const HELP = ` block");
  const from = searchLibText.indexOf("`", at) + 1;
  const to = searchLibText.indexOf("`;", from);
  if (to === -1) fail("worker/jobs/search-lib.mjs HELP block is not closed");
  return searchLibText.slice(from, to);
}

/** Spelled as a constructed string so no tool that rewrites this file can turn
 * the escape into an actual line break. */
const NEWLINE = String.fromCharCode(10);

/** Every corpus HELP documents: the first word of every paragraph that starts
 * at a line boundary and is followed by a description line. */
export function parseHelpCommands(searchLibText) {
  const lines = normalize(parseHelp(searchLibText)).split(NEWLINE);
  const out = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > 0 && lines[index - 1].trim() !== "") continue;
    const word = /^([a-z][a-z-]*)\s/.exec(line);
    if (word === null) continue;
    if (String(lines[index + 1] ?? "").trim() === "") continue;
    out.add(word[1]);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

export function parseSearchQuestions(searchLibText, helpText) {
  const database = parseCommandSet(searchLibText, "DATABASE_COMMANDS");
  const local = parseCommandSet(searchLibText, "LOCAL_COMMANDS");
  const ownDoor = new Set(parseCommandSet(searchLibText, "OWN_DOOR_COMMANDS"));
  const help = normalize(helpText).split("\n");
  const questions = [];
  for (const command of [...database, ...local]) {
    const at = help.findIndex((line) => line.startsWith(`${command} `));
    if (at === -1) fail(`worker/jobs/search-lib.mjs HELP has no paragraph for \`${command}\``);
    const what = String(help[at + 1] ?? "").trim();
    if (what === "") fail(`worker/jobs/search-lib.mjs HELP's \`${command}\` paragraph says nothing about what it answers`);
    questions.push({
      command,
      corpus: ownDoor.has(command) ? "own-door" : database.includes(command) ? "database" : "local",
      what,
      how: `tts-search ${help[at].trim()}`,
      definedIn: "worker/jobs/search-lib.mjs",
    });
  }
  assertCount("worker/jobs/search-lib.mjs commands", database.length + local.length, questions.length);
  return { questions, database, local };
}

// ── The skills ───────────────────────────────────────────────────────────────

function parseSkillShapes(skillsText) {
  const text = normalize(skillsText);
  const start = text.indexOf("export const SKILL_SHAPES = Object.freeze({");
  if (start === -1) fail("scripts/skills.mjs has no `SKILL_SHAPES`");
  const end = text.indexOf("\n});", start);
  if (end === -1) fail("scripts/skills.mjs's `SKILL_SHAPES` is not closed");
  const block = text.slice(start, end);
  const shapes = [...block.matchAll(/^ {2}(\w+): Object\.freeze\(\{/gm)].map((hit) => hit[1]);
  if (shapes.length === 0) fail("scripts/skills.mjs's `SKILL_SHAPES` names no shape");
  // The imported object is the second list; the parsed block is the first. They
  // must be the same set, or this file's text parser has fallen behind the code.
  assertCount("scripts/skills.mjs SKILL_SHAPES", Object.keys(SKILL_SHAPES).length, shapes.length, `read [${shapes.join(", ")}]`);
  return shapes;
}

/**
 * The published set: the three fixed skills, one per area page in the checkout,
 * and one per repository. The BODIES are not read — this register says what the
 * set is and where each description comes from, and `scripts/publish-skills.mjs`
 * is what turns that into directories.
 */
function buildSkillRows(wikitom, repos) {
  const skills = [
    { name: "write", group: "write", shape: "write", descriptionSource: "model-of-tom/writing.md headings", sourcePaths: ["model-of-tom/writing.md"] },
    { name: "know-intent", group: "know", shape: "intent", descriptionSource: "model-of-tom/intent.md headings", sourcePaths: ["model-of-tom/intent.md", "model-of-tom/priorities.md"] },
    { name: "know-week", group: "know", shape: "week", descriptionSource: "scripts/skills.mjs:SKILL_SHAPES.week.base", sourcePaths: ["model-of-tom/schedule.md"] },
  ];
  let areas = [];
  try {
    areas = fs
      .readdirSync(path.join(wikitom, AREAS_DIR))
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.replace(/\.md$/, ""));
  } catch {
    fail(`cannot read ${AREAS_DIR} under the WikiTom checkout — the know skills are one per area page`);
  }
  for (const area of areas.sort((a, b) => a.localeCompare(b))) {
    skills.push({
      name: `know-${area}`,
      group: "know",
      shape: "area",
      descriptionSource: `${AREAS_DIR}/${area}.md categories`,
      sourcePaths: [`${AREAS_DIR}/${area}.md`],
    });
  }
  for (const repo of repos) {
    skills.push({
      name: `repo-${repo.name}`,
      group: "repo",
      shape: "repo",
      descriptionSource: `vocabulary.repos[${repo.name}].line`,
      sourcePaths: ["AGENTS.md"],
    });
  }
  return skills;
}

// ── The repositories and the channels ────────────────────────────────────────

function parseSessionRepos(sharedText) {
  const text = normalize(sharedText);
  const start = text.indexOf("export const SESSION_REPOS = {");
  if (start === -1) fail("convex/ttsShared.ts has no `SESSION_REPOS`");
  const end = text.indexOf("\n} as const;", start);
  if (end === -1) fail("convex/ttsShared.ts's `SESSION_REPOS` is not closed");
  const block = text.slice(start, end);
  const rows = block.split("\n").slice(1).filter((line) => line.trim() !== "");
  const repos = new Map();
  for (const line of rows) {
    const match = /^\s*"?([\w.-]+)"?:\s*"([^"]+)",?\s*$/.exec(line);
    if (match === null) fail(`convex/ttsShared.ts \`SESSION_REPOS\` row reads as neither a name nor a home: "${line.trim()}"`);
    repos.set(match[1], match[2]);
  }
  assertCount("convex/ttsShared.ts SESSION_REPOS", rows.length, repos.size);
  return repos;
}

function parseChannelEnv(sharedText) {
  const text = normalize(sharedText);
  const start = text.indexOf("const CHANNEL_ENV: Record<SlackChannelKind, string> = {");
  if (start === -1) fail("convex/ttsShared.ts has no `CHANNEL_ENV`");
  const end = text.indexOf("\n};", start);
  if (end === -1) fail("convex/ttsShared.ts's `CHANNEL_ENV` is not closed");
  const rows = text.slice(start, end).split("\n").slice(1).filter((line) => line.trim() !== "");
  const channels = [];
  for (const line of rows) {
    const match = /^\s*(\w+):\s*"([A-Z_]+)",?\s*$/.exec(line);
    if (match === null) fail(`convex/ttsShared.ts \`CHANNEL_ENV\` row reads as neither a kind nor a variable: "${line.trim()}"`);
    channels.push({ kind: match[1], env: match[2] });
  }
  assertCount("convex/ttsShared.ts CHANNEL_ENV", rows.length, channels.length);
  return channels;
}

/** Each channel's one-line purpose, declared here and asserted to cover exactly
 *  the kinds `CHANNEL_ENV` holds — the purposes exist only in the prose comment
 *  above that constant, which is not a parseable register. */
const CHANNEL_WHAT = Object.freeze({
  today: "the digest",
  decisions: "each delegate decision and merge, for objection",
  needsYou: "a thread per todo only Tom can settle",
  hourly: "the hourly line",
  broken: "one line per distinct failure",
});

const CHANNEL_NAME = Object.freeze({
  today: "#tts-today",
  decisions: "#tts-decisions",
  needsYou: "#tts-needs-you",
  hourly: "#tts-hourly",
  broken: "#tts-broken",
});

// ── D1: two statements of one term ───────────────────────────────────────────

/**
 * The sentences `TTS_CLOSED_VOCABULARY` spends on one of its seven words.
 *
 * The block spells each in CAPITALS, which is what makes it findable without a
 * second copy of the block's structure. A word the block does not name at all
 * THROWS: `PROMPT_TERMS` says the block carries seven, and a block that carries
 * six has moved under this file.
 */
function promptWording(literal, term) {
  const shouted = term.toUpperCase();
  const sentences = literal
    .split("\n")
    .flatMap((line) => line.replace(/^-\s+/, "").split(/(?<=\.)\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
  const hit = sentences.filter((sentence) => new RegExp(`\\b${shouted}\\b`).test(sentence));
  if (hit.length === 0) fail(`convex/ttsShared.ts TTS_CLOSED_VOCABULARY does not name ${shouted}, which PROMPT_TERMS says it carries`);
  return hit.join(" ");
}

/** The `TTS_CLOSED_VOCABULARY` statement's source text, taken whole. */
function closedVocabularyLiteral(sharedText) {
  const match = /export const TTS_CLOSED_VOCABULARY = `([\s\S]*?)`;/.exec(normalize(sharedText));
  if (match === null) fail("convex/ttsShared.ts has no `TTS_CLOSED_VOCABULARY` template literal");
  return { body: match[1], statement: match[0] };
}

// ── The disagreement report ──────────────────────────────────────────────────

function disagreement({ code, subject, rows, fix }) {
  return { code, subject, rows, fix };
}

/** One block per disagreement, in the one shape, so a run pasting the output
 *  into a report for Tom has nothing to add to it. */
export function formatDisagreement(entry) {
  const lines = [`DISAGREEMENT ${entry.code}  ${entry.subject}`];
  for (const row of entry.rows) {
    lines.push(`  ${row.label.padEnd(4)}  ${row.where}`);
    for (const text of String(row.text).split("\n")) lines.push(`        ${text}`);
  }
  lines.push(`  fix   ${entry.fix}`);
  return lines.join("\n");
}

// ── Serialization ────────────────────────────────────────────────────────────

/** Two-space indent, LF, trailing newline. `JSON.stringify` preserves insertion
 *  order, so every object in `buildVocabulary` is constructed in this file's
 *  reading order and that order IS the schema. */
export function serialize(vocabulary) {
  return `${JSON.stringify(vocabulary, null, 2)}\n`;
}

/** The first 16 lowercase hex of the SHA-256 of the serialization with `version`
 *  blanked — a hash cannot cover its own field, and blanking rather than
 *  omitting keeps the key order, and so the hash, stable. */
export function versionOf(vocabulary) {
  return sha256Hex(serialize({ ...vocabulary, version: "" })).slice(0, 16);
}

// ── The map candidate ────────────────────────────────────────────────────────

/**
 * The four blocks of the map that RESTATE code, and the bullet in each that this
 * file can derive.
 *
 * A block is not replaced wholesale: only the bullet whose prefix is named here
 * is regenerated, and every other line of the block is carried through verbatim.
 * The blocks hold Tom's prose next to the derived facts — the digest bullet
 * under `### Jobs`, the proposals bullet under `### Search` — and a writer that
 * replaced the whole block would silently delete it.
 */
const DERIVED_BULLETS = Object.freeze([
  { heading: "### Repos", prefix: null, render: "repos" },
  { heading: "### Search", prefix: "- `tts search` (", render: "search" },
  { heading: "### Jobs", prefix: "- Box (New York):", render: "boxJobs" },
  { heading: "### Jobs", prefix: "- In Convex:", render: "convexJobs" },
  { heading: "### Tools", prefix: "- Box:", render: "tools" },
]);

function blockRange(lines, heading) {
  const start = lines.indexOf(heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{2,6}\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function renderRepoBullets(repos) {
  return repos.map((repo) => `- ${repo.line}`);
}

function renderSearchBullet(searchQuestions) {
  const corpora = [
    ...searchQuestions.filter((row) => row.corpus === "database").map((row) => row.command),
    ...searchQuestions.filter((row) => row.corpus === "local").map((row) => row.command),
  ].filter((command) => !searchQuestions.some((row) => row.command === command && row.corpus === "own-door"));
  return [`- \`tts search\` (${corpora.join(", ")}): read-only, no model, box and laptop.`];
}

const WEEKDAYS = Object.freeze(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);

/**
 * One cron line said in the map's own register: a period when it has one, a New
 * York wall-clock time when it is a daily or weekly anchor.
 *
 * The UTC hour pair is how every anchored job in this system defends against
 * DST — each fires at hour and hour+1 and a local-hour guard lets one through —
 * so a pair collapses to the single New York hour it means, which is what the
 * map says and what a reader of the map needs.
 */
function cadencePhrase(cron) {
  const [minute, hour, , , dow] = cron.split(/\s+/);
  const every = /^(?:\*|\d+-\d+)\/(\d+)$/.exec(minute);
  if (every !== null) return `${every[1]} min`;
  const list = minute.split(",");
  if (list.length > 1 && hour === "*") return `${60 / list.length} min`;
  if (hour === "*") return "hourly";
  const hours = hour.split(",").map(Number);
  const day = dow === "*" ? "" : ` (${WEEKDAYS[Number(dow.split(",")[0])] ?? dow})`;
  const ny = (hours[0] - 4 + 24) % 24;
  return `${String(ny).padStart(2, "0")}:${minute.padStart(2, "0")}${day}`;
}

/** `every 30 seconds` → `30 s`; `every 1 hours` → `hourly`. */
function intervalPhrase(cadence) {
  const match = /^every (\d+) (seconds|minutes|hours)$/.exec(cadence);
  if (match === null) return cadence;
  if (match[2] === "hours") return match[1] === "1" ? "hourly" : `${match[1]} h`;
  return `${match[1]} ${match[2] === "seconds" ? "s" : "min"}`;
}

/** The jobs of one host, grouped by cadence, shortest period first — the shape
 *  the map's own two Jobs bullets already use. */
function renderJobBullet(prefix, jobs, rename) {
  const groups = new Map();
  const add = (phrase, name) => {
    if (!groups.has(phrase)) groups.set(phrase, new Set());
    groups.get(phrase).add(name);
  };
  for (const job of jobs) {
    // A Convex interval job has no cron expression at all; its own cadence
    // string is the register, said the way a period is said above.
    if (job.cronLines.length === 0) add(intervalPhrase(job.cadence), rename(job.name));
    for (const cron of job.cronLines) add(cadencePhrase(cron), rename(job.name));
  }
  const minutes = (phrase) => {
    const period = /^(\d+) (s|min|h)$/.exec(phrase);
    if (period !== null) return Number(period[1]) * { s: 1 / 60, min: 1, h: 60 }[period[2]];
    if (phrase === "hourly") return 60;
    return 1_440;
  };
  const parts = [...groups.entries()]
    .sort((a, b) => minutes(a[0]) - minutes(b[0]) || a[0].localeCompare(b[0]))
    .map(([phrase, names]) => `${phrase}: ${[...names].sort((a, b) => a.localeCompare(b)).join(", ")}`);
  return [`${prefix} ${parts.join("; ")}.`];
}

function renderBoxJobsBullet(jobs) {
  return renderJobBullet("- Box (New York):", jobs.filter((job) => job.where === "box"), (name) => name);
}

/** The Convex cron pairs are one job under two names — `(edt)` and `(est)` — and
 *  the `tts ` prefix is the deployment's, not the job's. */
function renderConvexJobsBullet(jobs) {
  return renderJobBullet("- In Convex:", jobs.filter((job) => job.where === "convex"), (name) =>
    name.replace(/^tts /, "").replace(/\s*\((?:edt|est)\)$/, ""),
  );
}

function renderToolsBullet(tools) {
  return [`- Box: ${tools.join(", ")}.`];
}

/**
 * The map with its derived bullets regenerated. `destination` is an ARGUMENT and
 * never a constant in this function: under MAP_BLOCKS = "candidate" the only
 * caller passes `agent-rules.candidate.md`, and there is no code path in which
 * the candidate branch reaches the live file.
 */
export function renderMapCandidate(agentRulesText, rendered) {
  const lines = normalize(agentRulesText).split("\n");
  const out = [...lines];
  const grew = [];
  for (const spec of DERIVED_BULLETS) {
    const range = blockRange(out, spec.heading);
    if (range === null) fail(`model-of-tom/agent-rules.md has no \`${spec.heading}\` block`);
    const replacement = rendered[spec.render];
    if (spec.prefix === null) {
      // The whole block's bullets are derived (Repos); its prose lines stay.
      const body = out.slice(range.start + 1, range.end);
      const kept = body.filter((line) => !line.startsWith("- "));
      out.splice(range.start + 1, range.end - range.start - 1, ...replacement, ...kept);
      grew.push(spec.heading);
      continue;
    }
    const at = out.slice(range.start, range.end).findIndex((line) => line.startsWith(spec.prefix));
    if (at === -1) fail(`model-of-tom/agent-rules.md's \`${spec.heading}\` block has no bullet starting "${spec.prefix}"`);
    out.splice(range.start + at, 1, ...replacement);
    grew.push(`${spec.heading} ${spec.prefix.trim()}`);
  }
  return { text: out.join("\n"), blocks: grew };
}

/** A unified diff, three lines of context, over an LCS of the two line lists.
 *  The files are a hundred lines; the quadratic table is cheaper than a
 *  dependency, and this file takes none. */
export function unifiedDiff(beforeText, afterText, beforeName, afterName) {
  const a = normalize(beforeText).split("\n");
  const b = normalize(afterText).split("\n");
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ sign: " ", text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ sign: "-", text: a[i] });
      i += 1;
    } else {
      ops.push({ sign: "+", text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) ops.push({ sign: "-", text: a[i++] });
  while (j < b.length) ops.push({ sign: "+", text: b[j++] });
  if (!ops.some((op) => op.sign !== " ")) return "";

  const context = 3;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.sign === " ") return;
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k += 1) keep[k] = true;
  });
  const out = [`--- a/${beforeName}`, `+++ b/${afterName}`];
  let index = 0;
  let oldLine = 1;
  let newLine = 1;
  while (index < ops.length) {
    if (!keep[index]) {
      if (ops[index].sign !== "+") oldLine += 1;
      if (ops[index].sign !== "-") newLine += 1;
      index += 1;
      continue;
    }
    const hunkOldStart = oldLine;
    const hunkNewStart = newLine;
    const body = [];
    let oldCount = 0;
    let newCount = 0;
    while (index < ops.length && keep[index]) {
      const op = ops[index];
      body.push(`${op.sign}${op.text}`);
      if (op.sign !== "+") {
        oldLine += 1;
        oldCount += 1;
      }
      if (op.sign !== "-") {
        newLine += 1;
        newCount += 1;
      }
      index += 1;
    }
    out.push(`@@ -${hunkOldStart},${oldCount} +${hunkNewStart},${newCount} @@`, ...body);
  }
  return `${out.join("\n")}\n`;
}

/** The evidence entries for the generated lines, in the form WikiTom's
 *  `check-evidence.mjs` enforces. A generated line is never inferred, so it
 *  carries no `rests on:` and never ends `(inferred)`. */
export function renderCandidateEvidence(day, blocks) {
  const out = ["# agent-rules.candidate.md", ""];
  for (const block of blocks) {
    out.push(`## ${block.heading.replace(/^#+\s*/, "")}`, "");
    for (const line of block.lines) {
      out.push(`- line: ${line}`, `  read: ${day} · tom.quest ${block.read}`, "");
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}

// ── The generated block in convex/ttsShared.ts ───────────────────────────────

/**
 * The generated block: `TTS_CLOSED_VOCABULARY`, the version, the term NAMES, and
 * the graph's two closed kind lists.
 *
 * THE CONSTANT'S TEXT IS CARRIED THROUGH, NOT RE-RENDERED. `convex/ttsGraph.test.ts`
 * asserts that the `/tts/batch-context` door serves a body equal to this exact
 * string, and §12.1's wording does not reproduce its bytes; re-rendering it
 * would be a prompt change, which is a different round with its own evals. What
 * this round makes true is that the constant now lives inside markers and
 * carries the version its definitions came from — and D1 below reports, every
 * night, each of the seven words whose two statements differ.
 *
 * `VOCABULARY_TERMS` carries NAMES ONLY. The definitions are in the file and are
 * answered by `tts search define`; putting them in a bundled constant would make
 * every Convex module that imports this one carry thirty kilobytes of prose.
 */
export function renderSharedBlock({ version, statement, terms }) {
  const names = terms
    .filter((term) => term.kind !== "refused")
    .map((term) => term.term)
    .sort((a, b) => a.localeCompare(b));
  const list = (values) => values.map((value) => `  ${JSON.stringify(value)},`).join("\n");
  return [
    MARKER_OPEN(version),
    statement,
    `export const VOCABULARY_VERSION = ${JSON.stringify(version)};`,
    "/** Every word in the vocabulary, names only — the definitions live in",
    " *  WikiTom tts/vocabulary.json and `tts search define` answers from them. */",
    "export const VOCABULARY_TERMS: readonly string[] = [",
    list(names),
    "];",
    "/** The graph's closed node kinds, from worker/jobs/graph.mjs NODE_KINDS. */",
    "export const GRAPH_NODE_KINDS: readonly string[] = [",
    list([...NODE_KINDS]),
    "];",
    "/** The graph's closed edge kinds, from worker/jobs/graph.mjs EDGE_KINDS. */",
    "export const GRAPH_EDGE_KINDS: readonly string[] = [",
    list([...EDGE_KINDS]),
    "];",
    MARKER_CLOSE,
  ].join("\n");
}

/** The shared file with the generated block in place: replacing the block when
 *  the markers are already there, wrapping the existing statement when they are
 *  not. The statement's own text is never touched by either path. */
export function applySharedBlock(sharedText, block, statement) {
  const text = normalize(sharedText);
  const open = MARKER_OPEN_ANY.exec(text);
  if (open !== null) {
    const from = text.indexOf(open[0]);
    const to = text.indexOf(MARKER_CLOSE, from);
    if (to === -1) fail("convex/ttsShared.ts has an opening vocabulary marker with no closing one");
    return `${text.slice(0, from)}${block}${text.slice(to + MARKER_CLOSE.length)}`;
  }
  const at = text.indexOf(statement);
  if (at === -1) fail("convex/ttsShared.ts's `TTS_CLOSED_VOCABULARY` statement moved under this parser");
  return `${text.slice(0, at)}${block}${text.slice(at + statement.length)}`;
}

// ── The build ────────────────────────────────────────────────────────────────

function checkAuthority() {
  if (AUTHORITY !== "spec") {
    throw new VocabularyError(
      `vocabulary: AUTHORITY "${AUTHORITY}" is not built — the spec-renders-from-the-file direction needs a writer for tts/spec.md §12.1 and a tom-gate on it; see phase 10 switch (b)`,
    );
  }
}

/**
 * EVERYTHING, from two checkouts. The one function the nightly, the CLI and the
 * tests all call; `write` and `check` are the only things that differ between
 * them, and no disagreement is ever written past.
 *
 * `record` is accepted and read by nothing: every row in this file comes from
 * source text, and the nightly passes its run so a later record-derived section
 * does not change this signature under it.
 */
export function generateVocabulary({ wikitom, tomQuest, record = null, write = false, check = false } = {}) {
  checkAuthority();
  void record;
  if (typeof wikitom !== "string" || wikitom === "") fail("a WikiTom checkout is required (--wikitom DIR)");
  if (typeof tomQuest !== "string" || tomQuest === "") fail("a tom.quest checkout is required (--tom-quest DIR)");
  for (const [root, what] of [[wikitom, "WikiTom"], [tomQuest, "tom.quest"]]) {
    if (!fs.existsSync(root)) fail(`${what} checkout ${root} does not exist`);
  }

  // ── Read ──────────────────────────────────────────────────────────────────
  const specText = readRequired(wikitom, "tts/spec.md", "the terms");
  const agentRulesRaw = readRaw(wikitom, AGENT_RULES_PATH, "the repository lines and the map blocks");
  const agentRulesText = normalize(agentRulesRaw);
  const schemaText = readRequired(tomQuest, "convex/schema.ts", "the tables and the event key register");
  const sharedRaw = readRaw(tomQuest, SHARED_PATH, "the repos, the channels and the prompt vocabulary");
  const sharedText = normalize(sharedRaw);
  const cronsText = readRequired(tomQuest, "convex/crons.ts", "the Convex jobs");
  const setupText = readRequired(tomQuest, "worker/setup.sh", "the box jobs");
  const searchLibText = readRequired(tomQuest, "worker/jobs/search-lib.mjs", "the search questions");
  const skillsText = readRequired(tomQuest, "scripts/skills.mjs", "the skill shapes");

  const disagreements = [];

  // ── Terms ─────────────────────────────────────────────────────────────────
  const parsed = parseTerms(specText);
  const specHeadings = new Set(
    [...specText.matchAll(/^#{2,4}\s+([\d.]+)[ .]/gm)].map((hit) => hit[1].replace(/\.$/, "")),
  );
  specHeadings.add("12.1");

  // The line a term was READ ON, kept beside the register rather than in it: the
  // disagreement report names a file and a line, and a line number in the file
  // itself would change its bytes every time the spec gained a paragraph.
  const specLines = new Map(parsed.map((entry) => [entry.term.toLowerCase(), entry.line]));
  const terms = parsed.map((entry) => ({
    term: entry.term,
    kind: entry.kind,
    definition: entry.definition,
    specSection: entry.specSection,
    codeSymbol: TERM_CODE_SYMBOLS[entry.term] ?? null,
    related: entry.related,
    refusedFor: entry.kind !== "refused" ? null : (parsed.find((other) => other.kind !== "refused" && other.term.toLowerCase() === String(entry.because).replace(/[`*]/g, "").trim().toLowerCase())?.term ?? null),
  }));
  terms.sort(byFirstField("term"));

  // D2 — a term's code symbol does not exist.
  for (const term of terms) {
    if (term.codeSymbol === null) continue;
    const [file, symbol] = term.codeSymbol.split(":");
    const text = readOptional(tomQuest, file);
    if (text === null || !symbolDefined(text, symbol)) {
      disagreements.push(
        disagreement({
          code: "D2",
          subject: `term "${term.term}"`,
          rows: [
            { label: "spec", where: `WikiTom tts/spec.md §${term.specSection}`, text: term.definition },
            { label: "code", where: `tom.quest ${file}`, text: text === null ? "the file is not in the checkout" : `no \`export const ${symbol}\`, \`export function ${symbol}\` or \`${symbol}: defineTable\`` },
          ],
          fix: `point the term at the symbol that exists, or delete its codeSymbol in ${GENERATOR_PATH}`,
        }),
      );
    }
  }

  // D3 — a term's spec section does not exist.
  for (const term of terms) {
    if (specHeadings.has(term.specSection)) continue;
    disagreements.push(
      disagreement({
        code: "D3",
        subject: `term "${term.term}"`,
        rows: [
          { label: "spec", where: `WikiTom tts/spec.md §${term.specSection}`, text: "no heading of that number exists" },
          { label: "code", where: `WikiTom tts/spec.md §${term.specSection === "12.1" ? "12.1" : "12.1"}`, text: term.definition },
        ],
        fix: "point the definition's cross-reference at a section that exists",
      }),
    );
  }

  // ── D1 — two statements of one term ───────────────────────────────────────
  const { body: promptLiteral, statement } = closedVocabularyLiteral(sharedText);
  const byName = new Map(terms.map((entry) => [entry.term.toLowerCase(), entry]));
  for (const name of PROMPT_TERMS) {
    const term = byName.get(name);
    if (term === undefined) fail(`PROMPT_TERMS names "${name}", which §12.1 does not define`);
    const code = promptWording(promptLiteral, name);
    // AGREEMENT IS CONTAINMENT, not equality: the block writes `A BATCH is …`
    // where the spec writes the definition alone, so the code agrees when it
    // states the spec's words somewhere inside its own sentence and disagrees
    // when it says something else. Equality would make every one of the seven a
    // disagreement forever, which is a check that never passes and so never
    // means anything.
    if (normalizeClaim(code).includes(normalizeClaim(term.definition))) continue;
    disagreements.push(
      disagreement({
        code: "D1",
        subject: `term "${name}"`,
        rows: [
          {
            label: "spec",
            where: `WikiTom tts/spec.md §${term.specSection} line ${specLines.get(name) ?? 0}`,
            text: term.definition,
          },
          {
            label: "code",
            where: `tom.quest ${SHARED_PATH} line ${lineOf(sharedText, code.split(". ")[0])} (TTS_CLOSED_VOCABULARY)`,
            text: code,
          },
        ],
        fix: "one wording: either the spec entry moves to the code's, or the prompt constant renders from the spec",
      }),
    );
  }

  // ── Entities ──────────────────────────────────────────────────────────────
  const eventKinds = parseEventKinds(schemaText);
  const declaredEventKinds = EVENT_KEY_SPELLINGS.flatMap((row) => row.kinds).sort((a, b) => a.localeCompare(b));
  assertCount(
    "convex/schema.ts dtsEvents.key spellings",
    eventKinds.length,
    declaredEventKinds.length,
    `the comment registers [${eventKinds.join(", ")}] and the spellings claim [${declaredEventKinds.join(", ")}]`,
  );
  for (const kind of eventKinds) {
    if (!declaredEventKinds.includes(kind)) fail(`convex/schema.ts registers the event kind "${kind}" and no spelling in ${GENERATOR_PATH} claims it`);
  }

  const entities = [];
  for (const spec of ENTITY_SPECS) {
    const mintedText = readOptional(tomQuest, spec.mintedIn);
    let regex = spec.regexLiteral ?? null;
    if (spec.regexFrom !== undefined) {
      const source = readOptional(tomQuest, spec.regexFrom.file);
      if (source === null) fail(`${spec.regexFrom.file} is not in the tom.quest checkout, and ${spec.id} quotes its \`${spec.regexFrom.name}\``);
      regex = regexSource(source, spec.regexFrom.name, spec.regexFrom.file);
    }
    // D4 — an entity is wrong about itself.
    if (mintedText === null || !spec.mintedPattern.test(mintedText)) {
      disagreements.push(
        disagreement({
          code: "D4",
          subject: `entity "${spec.id}"`,
          rows: [
            { label: "spec", where: `${GENERATOR_PATH} ENTITY_SPECS`, text: `minted in ${spec.mintedIn}, matching ${spec.mintedPattern}` },
            { label: "code", where: `tom.quest ${spec.mintedIn}`, text: mintedText === null ? "the file is not in the checkout" : "the file does not carry what the register says mints this id" },
          ],
          fix: "point the entity at the file that mints it, or restore the template the register quotes",
        }),
      );
    }
    if (regex !== null && spec.example !== null) {
      const body = /^\/(.*)\/([a-z]*)$/.exec(regex);
      const test = body === null ? null : new RegExp(body[1], body[2]);
      if (test !== null && !test.test(spec.example)) {
        disagreements.push(
          disagreement({
            code: "D4",
            subject: `entity "${spec.id}"`,
            rows: [
              { label: "spec", where: `${GENERATOR_PATH} ENTITY_SPECS`, text: `example ${spec.example}` },
              { label: "code", where: `tom.quest ${spec.validatedIn}`, text: regex },
            ],
            fix: "the example must match the expression that validates the id",
          }),
        );
      }
    }
    entities.push({
      id: spec.id,
      shape: spec.shape,
      regex,
      mintedIn: spec.mintedIn,
      validatedIn: spec.validatedIn,
      example: spec.example,
      term: spec.term,
    });
  }
  for (const spelling of EVENT_KEY_SPELLINGS) {
    entities.push({
      id: spelling.id,
      shape: spelling.shape,
      regex: null,
      mintedIn: "convex/schema.ts",
      validatedIn: `convex/schema.ts:dtsEvents.key (${spelling.kinds.join(", ")})`,
      example: spelling.example,
      term: null,
    });
  }
  entities.sort(byFirstField("id"));

  // ── Jobs ──────────────────────────────────────────────────────────────────
  const jobs = [...parseConvexJobs(cronsText), ...parseBoxJobs(setupText)].map((job) => ({
    name: job.name,
    where: job.where,
    cadence: job.cadence,
    file: job.file,
    cronLines: job.cronLines,
    writesEventKinds: job.where === "box" ? eventKindsWritten(tomQuest, job.file, eventKinds) : [],
  }));
  // The box installs one file per cron line, and two lines may run one script;
  // the register holds one row per job, with every line it runs on.
  const merged = new Map();
  for (const job of jobs) {
    const seen = merged.get(`${job.where}:${job.name}`);
    if (seen === undefined) {
      merged.set(`${job.where}:${job.name}`, job);
      continue;
    }
    seen.cronLines = [...new Set([...seen.cronLines, ...job.cronLines])].sort((a, b) => a.localeCompare(b));
  }
  const jobRows = [...merged.values()].sort(byFirstField("name"));

  // ── Search questions ──────────────────────────────────────────────────────
  // PARSED, NOT CALLED. §4.2: every tom.quest input is read as text. Calling
  // `usage()` would mean importing search-lib.mjs, and search-lib.mjs imports
  // ./session-archive.mjs, which imports ../session-host/redact.mjs — three
  // modules that live in three different directories on the box, so the import
  // would decide whether this generator loads at all. The HELP block is a
  // template literal in a file this function already holds as text.
  const { questions, database, local } = parseSearchQuestions(searchLibText, parseHelp(searchLibText));
  const searchQuestions = [...questions].sort(byFirstField("command"));

  // D5 — two lists of one set. The pair that read
  // `context-relevance.mjs SEARCH_QUESTIONS` against `SEARCH_COMMANDS` is GONE:
  // phase 6 deleted that constant, so there is no second list of the search
  // questions to disagree with and no KNOWN_ABSENT exception table to keep.
  const commandSet = [...database, ...local].sort((a, b) => a.localeCompare(b));
  for (const [left, right, leftWhere, rightWhere, fix] of [
    [commandSet, parseHelpCommands(searchLibText), "worker/jobs/search-lib.mjs DATABASE_COMMANDS + LOCAL_COMMANDS", "worker/jobs/search-lib.mjs HELP", "every corpus the grammar accepts has a HELP paragraph, and every HELP paragraph names a corpus"],
  ]) {
    if (left.join(",") === right.join(",")) continue;
    disagreements.push(
      disagreement({
        code: "D5",
        subject: "search commands",
        rows: [
          { label: "spec", where: `tom.quest ${leftWhere}`, text: left.join(", ") },
          { label: "code", where: `tom.quest ${rightWhere}`, text: right.join(", ") },
        ],
        fix,
      }),
    );
  }

  // ── Repos ─────────────────────────────────────────────────────────────────
  const sessionRepos = parseSessionRepos(sharedText);
  const bullets = parseRepoBullets(agentRulesText);
  const repos = [];
  const named = new Set();
  for (const bullet of bullets) {
    for (const name of bullet.names) {
      named.add(name);
      repos.push({
        name,
        aliases: bullet.aliases[name] === undefined ? [] : [bullet.aliases[name]],
        github: sessionRepos.get(name) ?? null,
        line: bullet.line,
        lineFrom: `${AGENT_RULES_PATH} § Repos`,
      });
    }
  }
  repos.sort(byFirstField("name"));
  for (const [name, github] of sessionRepos) {
    if (named.has(name)) continue;
    disagreements.push(
      disagreement({
        code: "D5",
        subject: `repository "${name}"`,
        rows: [
          { label: "spec", where: `WikiTom ${AGENT_RULES_PATH} § Repos`, text: "the block names no such repository" },
          { label: "code", where: `tom.quest ${SHARED_PATH} SESSION_REPOS`, text: `${name} → ${github}` },
        ],
        fix: "a repository a session may check out needs a line in the map, because the line is the only description of it",
      }),
    );
  }

  // ── Channels ──────────────────────────────────────────────────────────────
  const channelRows = parseChannelEnv(sharedText);
  assertCount(
    "convex/ttsShared.ts CHANNEL_ENV purposes",
    channelRows.length,
    channelRows.filter((row) => CHANNEL_WHAT[row.kind] !== undefined).length,
    `a channel kind ${GENERATOR_PATH} has no purpose line for`,
  );
  const channels = channelRows
    .map((row) => ({ name: CHANNEL_NAME[row.kind], kind: row.kind, env: row.env, what: CHANNEL_WHAT[row.kind] }))
    .sort(byFirstField("name"));

  // ── Skills ────────────────────────────────────────────────────────────────
  const shapes = parseSkillShapes(skillsText);
  const skills = buildSkillRows(wikitom, repos.filter((repo) => repo.github !== null)).sort(byFirstField("name"));
  for (const skill of skills) {
    if (shapes.includes(skill.shape)) continue;
    disagreements.push(
      disagreement({
        code: "D5",
        subject: `skill "${skill.name}"`,
        rows: [
          { label: "spec", where: `${GENERATOR_PATH} buildSkillRows`, text: `shape ${skill.shape}` },
          { label: "code", where: "tom.quest scripts/skills.mjs SKILL_SHAPES", text: shapes.join(", ") },
        ],
        fix: "every published skill takes one of the declared shapes",
      }),
    );
  }

  // ── Relations ─────────────────────────────────────────────────────────────
  const relations = [];
  for (const entity of entities) {
    if (entity.term !== null) relations.push({ kind: "term-has-id", from: entity.term, to: entity.id });
  }
  for (const term of terms) {
    if (term.codeSymbol === null) continue;
    relations.push({ kind: "term-names-table", from: term.term, to: term.codeSymbol });
  }
  for (const job of jobRows) {
    for (const kind of job.writesEventKinds) relations.push({ kind: "job-writes-event", from: job.name, to: kind });
  }
  for (const question of searchQuestions) {
    relations.push({ kind: "command-reads-corpus", from: question.command, to: question.corpus });
  }
  for (const skill of skills) {
    for (const source of skill.sourcePaths) relations.push({ kind: "skill-reads-page", from: skill.name, to: source });
  }
  relations.sort((a, b) => a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  // ── Assemble ──────────────────────────────────────────────────────────────
  const vocabulary = {
    version: "",
    generatedFrom: {
      wikitomCommit: headSha(wikitom),
      tomQuestCommit: headSha(tomQuest),
      specSection: "12.1",
      generator: GENERATOR_PATH,
      generatorVersion: GENERATOR_VERSION,
    },
    terms,
    entities,
    relations,
    jobs: jobRows,
    searchQuestions,
    skills,
    repos,
    channels,
  };
  const version = versionOf(vocabulary);
  vocabulary.version = version;

  const bytes = byteLength(serialize(vocabulary));
  const counts = {
    terms: terms.length,
    entities: entities.length,
    relations: relations.length,
    jobs: jobRows.length,
    searchQuestions: searchQuestions.length,
    skills: skills.length,
    repos: repos.length,
    channels: channels.length,
  };
  // OVER THE CAP REFUSES THE WRITE, and does not stop the build: the drift check
  // below is the half of this program that has to run every night whatever the
  // file's size, and a size failure that also suppressed the disagreements would
  // hide the more important of the two answers.
  let overCap = null;
  if (bytes > VOCABULARY_MAX_BYTES) {
    const sections = Object.entries({ terms, entities, relations, jobs: jobRows, searchQuestions, skills, repos, channels })
      .map(([name, rows]) => ({ name, bytes: byteLength(JSON.stringify(rows, null, 2)) }))
      .sort((a, b) => b.bytes - a.bytes);
    overCap = `vocabulary: the file is ${bytes} bytes, over the ${VOCABULARY_MAX_BYTES}-byte cap; its largest section is ${sections[0].name} at ${sections[0].bytes} bytes — nothing written`;
  }

  // ── The derived views ─────────────────────────────────────────────────────
  const block = renderSharedBlock({ version, statement, terms });
  const sharedAfter = applySharedBlock(sharedText, block, statement);
  const candidate = renderMapCandidate(agentRulesText, {
    repos: renderRepoBullets(repos),
    search: renderSearchBullet(searchQuestions),
    boxJobs: renderBoxJobsBullet(jobRows),
    convexJobs: renderConvexJobsBullet(jobRows),
    tools: renderToolsBullet(boxTools(tomQuest)),
  });
  // OVER THE MAP'S BYTE RULE REFUSES THE CANDIDATE, and does not stop the build:
  // the candidate is the inert side of switch (a) and the vocabulary does not
  // depend on it, so a candidate that grew past the rule must not take the drift
  // check and the file down with it.
  const candidateLfBytes = byteLength(candidate.text);
  const candidateOverBudget =
    candidateLfBytes < AGENT_RULES_MAX_LF_BYTES
      ? null
      : `vocabulary: the map candidate is ${candidateLfBytes} LF bytes, at or over the ${AGENT_RULES_MAX_LF_BYTES}-byte rule; the blocks this run regenerated are ${candidate.blocks.join(", ")} — no candidate written`;
  const candidateDiff = unifiedDiff(agentRulesText, candidate.text, AGENT_RULES_PATH, CANDIDATE_PATH);

  // ── What is out of date ───────────────────────────────────────────────────
  const serialized = serialize(vocabulary);
  const onDiskVocabulary = readOptional(wikitom, VOCABULARY_PATH);
  const onDiskCandidate = readOptional(wikitom, CANDIDATE_PATH);
  const changed = [];
  if (onDiskVocabulary !== serialized) changed.push(VOCABULARY_PATH);
  if (sharedText !== sharedAfter) changed.push(SHARED_PATH);
  const mapCandidateChanged = onDiskCandidate !== candidate.text;

  const report = buildReport({
    version, counts, bytes, changed, disagreements, mapCandidateChanged, candidateLfBytes, overCap, candidateOverBudget,
  });

  // ── Write ─────────────────────────────────────────────────────────────────
  // A disagreement is never written past: the whole value of this file is that
  // it never states something the code and the spec do not both say.
  if (write && disagreements.length === 0 && overCap === null && !check) {
    fs.writeFileSync(path.join(wikitom, VOCABULARY_PATH), serialized, "utf8");
    fs.writeFileSync(path.join(tomQuest, SHARED_PATH), restoreEndings(sharedRaw, sharedAfter), "utf8");
    if (candidateOverBudget === null) writeMapCandidate({ wikitom, agentRulesRaw, candidate, candidateDiff });
  }

  return {
    version,
    counts,
    bytes,
    overCap,
    candidateOverBudget,
    changed,
    disagreements,
    report,
    mapCandidateChanged,
    mapCandidateDiff: candidateDiff,
    candidateLfBytes,
    vocabulary,
    serialized,
    sharedBlock: block,
    sharedAfter,
    mapCandidate: candidate.text,
  };
}

/** The box's own tools, from the directory that holds them — the map's Tools
 *  bullet restates this list, and the directory is where it actually is. */
function boxTools(tomQuest) {
  try {
    return fs
      .readdirSync(path.join(tomQuest, "worker/bin"))
      .filter((name) => name.startsWith("tts-"))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    fail("worker/bin is not in the tom.quest checkout, and the map's Tools bullet is derived from it");
  }
  return [];
}

/** CRLF restored when the file on disk was CRLF. The parsers all work on LF, and
 *  a writer that normalized the endings would rewrite every line of a CRLF file
 *  and make the diff useless. Each file is judged by its OWN bytes: the map is
 *  CRLF today and `convex/ttsShared.ts` is not. */
function restoreEndings(originalRaw, text) {
  return String(originalRaw).includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * The three candidate files, under the WikiTom checkout.
 *
 * `destination` is passed in, and under MAP_BLOCKS = "candidate" the only value
 * it ever takes is `agent-rules.candidate.md`. `"live"` is the one other branch,
 * and it is the only place `agent-rules.md` is ever a destination.
 */
function writeMapCandidate({ wikitom, agentRulesRaw, candidate, candidateDiff }) {
  const destination = MAP_BLOCKS === "live" ? AGENT_RULES_PATH : CANDIDATE_PATH;
  const body = restoreEndings(agentRulesRaw, candidate.text);
  fs.writeFileSync(path.join(wikitom, destination), body, "utf8");
  if (MAP_BLOCKS === "live") return;
  fs.writeFileSync(path.join(wikitom, CANDIDATE_DIFF_PATH), candidateDiff, "utf8");
  const evidenceDir = path.join(wikitom, path.dirname(CANDIDATE_EVIDENCE_PATH));
  fs.mkdirSync(evidenceDir, { recursive: true });
  const day = candidateDay(wikitom);
  const blocks = candidate.blocks.map((heading) => ({
    heading,
    read: `${GENERATOR_PATH} · regenerated from the code this line restates`,
    lines: [],
  }));
  fs.writeFileSync(path.join(wikitom, CANDIDATE_EVIDENCE_PATH), renderCandidateEvidence(day, blocks), "utf8");
}

/** The day an evidence entry is dated. It comes from the map's own most recent
 *  `read:` date rather than from the clock, because a clock in this program
 *  would change the bytes of a file whose whole test is whether its bytes
 *  changed. */
function candidateDay(wikitom) {
  const evidence = readOptional(wikitom, "model-of-tom/evidence/agent-rules.md");
  const days = evidence === null ? [] : [...evidence.matchAll(/read:\s*(\d{4}-\d{2}-\d{2})/g)].map((hit) => hit[1]);
  return days.sort((a, b) => a.localeCompare(b)).at(-1) ?? "0000-00-00";
}

function buildReport({
  version, counts, bytes, changed, disagreements, mapCandidateChanged, candidateLfBytes, overCap, candidateOverBudget,
}) {
  const lines = [];
  for (const entry of disagreements) lines.push(formatDisagreement(entry), "");
  if (disagreements.length > 0) {
    lines.push(`vocabulary: ${disagreements.length} disagreement${disagreements.length === 1 ? "" : "s"} — nothing written.`);
    if (overCap !== null) lines.push(overCap);
    if (candidateOverBudget !== null) lines.push(candidateOverBudget);
    return lines.join("\n");
  }
  if (overCap !== null) lines.push(overCap);
  if (candidateOverBudget !== null) lines.push(candidateOverBudget);
  lines.push(
    `vocabulary/@version ${version} terms=${counts.terms} entities=${counts.entities} relations=${counts.relations} jobs=${counts.jobs} search=${counts.searchQuestions} skills=${counts.skills} repos=${counts.repos} channels=${counts.channels}`,
    `bytes ${bytes} of ${VOCABULARY_MAX_BYTES}; map candidate ${candidateLfBytes} of ${AGENT_RULES_MAX_LF_BYTES} LF bytes`,
    `changed: ${changed.length === 0 ? "nothing" : changed.join(", ")}`,
    `map candidate: ${mapCandidateChanged ? "changed" : "unchanged"} (MAP_BLOCKS=${MAP_BLOCKS})`,
  );
  return lines.join("\n");
}

// ── The command line ─────────────────────────────────────────────────────────

/** `--wikitom`, else `WIKITOM_DIR`, else the platform default the search library
 *  already spells. */
export function resolveWikitom(argvValue, env = process.env) {
  if (argvValue !== undefined) return argvValue;
  if (env.WIKITOM_DIR) return env.WIKITOM_DIR;
  return process.platform === "win32" ? LAPTOP_WIKITOM_DIR : BOX_WIKITOM_DIR;
}

export function parseArgs(argv) {
  const options = { write: false, check: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--write") options.write = true;
    else if (item === "--check") options.check = true;
    else if (item === "--json") options.json = true;
    else if (item === "--wikitom") options.wikitom = argv[++index];
    else if (item === "--tom-quest") options.tomQuest = argv[++index];
    else fail(`unknown option ${item} (usage: node ${GENERATOR_PATH} --wikitom DIR [--tom-quest DIR] [--write] [--check] [--json])`);
  }
  return options;
}

/** Exit codes: 0 clean · 2 a disagreement, or --check found the disk out of
 *  date · 3 an input is missing or unreadable. */
export async function main(argv, { write = console.log, error = console.error, env = process.env } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (problem) {
    error(problem.message);
    return 3;
  }
  const wikitom = resolveWikitom(options.wikitom, env);
  const tomQuest = options.tomQuest ?? env.TOM_QUEST_DIR ?? path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  let result;
  try {
    result = generateVocabulary({ wikitom, tomQuest, write: options.write, check: options.check });
  } catch (problem) {
    error(problem instanceof VocabularyError ? problem.message : `vocabulary: ${problem.message}`);
    return 3;
  }
  if (options.json) write(JSON.stringify({ version: result.version, counts: result.counts, bytes: result.bytes, changed: result.changed, disagreements: result.disagreements, mapCandidateChanged: result.mapCandidateChanged }, null, 2));
  else write(result.report);
  if (result.overCap !== null || result.candidateOverBudget !== null) return 3;
  if (result.disagreements.length > 0) return 2;
  if (options.check && (result.changed.length > 0 || result.mapCandidateChanged)) {
    error(`vocabulary: --check found ${result.changed.length === 0 ? "the map candidate" : result.changed.join(", ")} out of date`);
    return 2;
  }
  if (!options.write && !options.check) write(`(dry run — nothing written; pass --write to land ${result.changed.length === 0 ? "nothing" : result.changed.join(", ")})`);
  return 0;
}

const invoked = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
