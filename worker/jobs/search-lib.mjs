// search-lib.mjs — the read-only search surface for the Jarvis Box and a
// laptop checkout. It deliberately contains no model call and no write path.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { extractSections, parseFrontmatter } from "./markdown-sections.mjs";
// session-archive.mjs owns the three-depth resolution for redact.mjs: in a
// checkout it reaches worker/session-host/, and after setup flattens jobs to
// /opt/tts it reaches /opt/tts/session-host/. Do not spell either path here.
import { redactSecrets } from "./session-archive.mjs";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 200;
export const LAPTOP_WIKITOM_DIR = "C:/Users/heffn/Desktop/WikiTom";
export const BOX_WIKITOM_DIR = process.env.WIKITOM_DIR || "/root/wikitom";

const DATABASE_COMMANDS = new Set(["rulings", "sessions", "events", "todos", "evals", "proposals"]);
const LOCAL_COMMANDS = new Set([
  "areas",
  "sources",
  "archive",
  "evidence",
  "skills",
  "node",
  "near",
  "define",
  "vocabulary",
]);
/** EVERY CORPUS the grammar accepts, in one list. The help is checked against
 * it, so a corpus added to the grammar and left out of HELP fails a test rather
 * than being discovered by a run that cannot find it. */
export const SEARCH_COMMANDS = Object.freeze([...DATABASE_COMMANDS, ...LOCAL_COMMANDS].sort());

// The one database command that is NOT a /tts/search/* door: it reads the open
// repository-rule proposals from /tts/repo-proposals, whose envelope is its own
// (see proposalResults).
const OWN_DOOR_COMMANDS = new Set(["proposals"]);

const HELP = `rulings <query> [--since DATE] [--limit N] [--json]
Search matching rulings in production Convex.
Returns a stable ruling id, date, and collapsed text.

sessions [--repo NAME] [--since DATE] [--query TEXT] [--limit N] [--json]
Search production session history, optionally narrowed by repository or text.
Returns the server-provided session URL, never a guessed URL.

events <query> [--since DATE] [--limit N] [--json]
Search matching production event history.
Returns a stable event id, date, and collapsed text.

todos <query> [--status S] [--limit N] [--json]
Search matching production todos, optionally narrowed by status.
Returns a stable todo id, date, and collapsed text.

evals [--limit N] [--json]
List the recorded evals runs in production Convex, newest first.
Returns the run's event id, day, repository, commit, counts, and failing item ids.

areas <name|all> [--limit N] [--wikitom DIR] [--json]
Read an area page's updated/reviewed frontmatter and its protected sections.
Use all to list the available area names.

sources <query> [--limit N] [--wikitom DIR] [--json]
Recursively search WikiTom sources/ and tom-text/ case-insensitively.
Derives its date from path/frontmatter, otherwise the file modification time.

archive <query> [--since DATE] [--limit N] [--wikitom DIR] [--json]
Recursively search archived sessions/, including gzipped JSONL, by text.
Filters --since by archive path date, falling back to file modification time.

evidence <query> [--limit N] [--wikitom DIR] [--json]
Search model-of-tom/evidence/ for the entry behind a page's line.
Returns path:heading, the line: text, and the first said/paraphrase/read/rests on.

skills [<name>] [--group GROUP] [--skills-dir DIR] [--limit N] [--json]
List the skills installed for this run, or print one skill's body.
Reads the installed skills directory, so it names only what can actually load.

node <id> [--wikitom DIR] [--json]
Print one node of tts/graph.json and every edge that touches it.
A bare id resolves when it is unique across kinds; anything else returns did you mean rows.

near <id> [--hops K] [--bytes N] [--wikitom DIR] [--json]
Walk outward from one node under a byte budget and print the nodes that fit.
The frontier names, for each node the budget left out, the command that reaches it.

define <term> [--wikitom DIR] [--json]
Print one term of tts/vocabulary.json: its kind, definition, spec section and code symbol.
A word the spec refuses prints kind=refused and the word it is a second name for.

vocabulary [--kind K] [--limit N] [--wikitom DIR] [--json]
List every term tts/vocabulary.json fixes, under a header naming its version and counts.
Narrow to one kind with --kind.

proposals [--repo NAME] [--limit N] [--json]
List the open repository-rule proposals the nightly repo-learning step made.
Returns the proposal id, the AGENTS.md file and section, the line, and its evidence.

This command is read-only and makes no model calls. Use it on demand for rulings, history, and context instead of loading everything into prompts.`;

export function usage() {
  return HELP;
}

function fail(message) {
  throw new Error(`tts-search: ${message}`);
}

function isDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${option} needs a value`);
  return value;
}

/** Parse the small, intentionally non-ambiguous command grammar. */
export function parseSearchArgs(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { help: true };
  const command = argv[0];
  if (!DATABASE_COMMANDS.has(command) && !LOCAL_COMMANDS.has(command)) {
    fail(`unknown subcommand "${command}" (use --help)`);
  }
  const options = { command, json: false, limit: DEFAULT_LIMIT, positional: [], seen: new Set() };
  for (let i = 1; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--json") {
      options.json = true;
      options.seen.add("json");
    } else if (item === "--since") {
      options.since = optionValue(argv, i++, item);
      options.seen.add("since");
    } else if (item === "--limit") {
      options.limit = Number(optionValue(argv, i++, item));
      options.seen.add("limit");
    } else if (item === "--repo") {
      options.repo = optionValue(argv, i++, item);
      options.seen.add("repo");
    } else if (item === "--query") {
      options.query = optionValue(argv, i++, item);
      options.seen.add("query");
    } else if (item === "--status") {
      options.status = optionValue(argv, i++, item);
      options.seen.add("status");
    } else if (item === "--wikitom") {
      options.wikitom = optionValue(argv, i++, item);
      options.seen.add("wikitom");
    } else if (item === "--group") {
      options.group = optionValue(argv, i++, item);
      options.seen.add("group");
    } else if (item === "--skills-dir") {
      options.skillsDir = optionValue(argv, i++, item);
      options.seen.add("skills-dir");
    } else if (item === "--hops") {
      options.hops = Number(optionValue(argv, i++, item));
      options.seen.add("hops");
    } else if (item === "--bytes") {
      options.bytes = Number(optionValue(argv, i++, item));
      options.seen.add("bytes");
    } else if (item === "--kind") {
      options.kind = optionValue(argv, i++, item);
      options.seen.add("kind");
    } else if (item.startsWith("--")) fail(`unknown option ${item}`);
    else options.positional.push(item);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_LIMIT) {
    fail(`--limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }
  if (options.since && !isDay(options.since)) fail("--since must be a real YYYY-MM-DD date");
  const needsQuery = new Set(["rulings", "events", "todos", "sources", "archive", "evidence"]);
  // `node` and `near` take a NODE ID and `define` takes a TERM, not a query:
  // both are looked up exactly first and only fall back to a substring search
  // when nothing carries that id or that word. Naming the positional for what
  // it is keeps the refusal ("needs exactly one node id") true.
  const needsNodeId = new Set(["node", "near"]);
  if (needsQuery.has(command)) {
    if (options.positional.length !== 1) fail(`${command} needs exactly one query`);
    options.query = options.positional[0];
  } else if (needsNodeId.has(command)) {
    if (options.positional.length !== 1) fail(`${command} needs exactly one node id`);
    options.node = options.positional[0];
  } else if (command === "define") {
    if (options.positional.length !== 1) fail("define needs exactly one term");
    options.term = options.positional[0];
  } else if (command === "areas") {
    if (options.positional.length !== 1) fail("areas needs an area name or all");
    options.area = options.positional[0];
  } else if (command === "skills") {
    if (options.positional.length > 1) fail("skills takes at most one skill name");
    if (options.positional.length === 1) options.skill = options.positional[0];
    // A name already IS a group of one. Taking both would let a run write a
    // pair that cannot both be true and get silence for it.
    if (options.skill !== undefined && options.seen.has("group")) fail("--group does not apply when skills names a skill");
  } else if (options.positional.length > 0) {
    fail(`${command} accepts options only`);
  }
  const allowed = {
    rulings: new Set(["json", "since", "limit"]),
    sessions: new Set(["json", "repo", "since", "query", "limit"]),
    events: new Set(["json", "since", "limit"]),
    todos: new Set(["json", "status", "limit"]),
    evals: new Set(["json", "limit"]),
    areas: new Set(["json", "limit", "wikitom"]),
    sources: new Set(["json", "limit", "wikitom"]),
    archive: new Set(["json", "since", "limit", "wikitom"]),
    evidence: new Set(["json", "limit", "wikitom"]),
    proposals: new Set(["json", "repo", "limit"]),
    skills: new Set(["json", "limit", "group", "skills-dir"]),
    // No --limit on these three: each answers about ONE node or ONE word, and
    // a limit on a single answer would be a number with nothing to cut.
    node: new Set(["json", "wikitom"]),
    near: new Set(["json", "wikitom", "hops", "bytes"]),
    define: new Set(["json", "wikitom"]),
    vocabulary: new Set(["json", "limit", "wikitom", "kind"]),
  };
  for (const name of options.seen) {
    if (!allowed[command].has(name)) fail(`--${name} does not apply to ${command}`);
  }
  if (command === "near") {
    // The defaults are the walk a reader wants without arguing: two hops out,
    // and a budget of the same order as the block a prompt would carry.
    if (options.hops === undefined) options.hops = DEFAULT_HOPS;
    if (options.bytes === undefined) options.bytes = DEFAULT_WALK_BYTES;
    if (!Number.isInteger(options.hops) || options.hops < 1 || options.hops > MAX_HOPS) {
      fail(`--hops must be a whole number from 1 to ${MAX_HOPS}`);
    }
    if (!Number.isInteger(options.bytes) || options.bytes < 1 || options.bytes > MAX_WALK_BYTES) {
      fail(`--bytes must be a whole number from 1 to ${MAX_WALK_BYTES}`);
    }
  }
  delete options.seen;
  return options;
}

/** Collapse values to a safe, readable, one-line representation. */
export function singleLine(value) {
  return redactSecrets(String(value ?? ""))
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/[ \f\v]+/g, " ")
    .trim();
}

export function unknownDate(value) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString().slice(0, 10);
  const text = String(value ?? "");
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  return match && isDay(match[0]) ? match[0] : "unknown";
}

function rowId(row, fallback) {
  for (const key of ["id", "_id", "stableId", "rulingId", "eventId", "todoId", "sessionId", "path"]) {
    if (row?.[key] !== undefined && row[key] !== null && String(row[key]) !== "") return String(row[key]);
  }
  return fallback;
}

const ID_PREFIX = {
  rulings: "dtsRulings",
  sessions: "claudeSessions",
  events: "dtsEvents",
  todos: "dtsTodos",
  // An evals run IS a dtsEvents row ("evals-run"), so it is cited as one:
  // the id printed here is the id the digest and `events` already name.
  evals: "dtsEvents",
};

function citedId(command, row, fallback) {
  const raw = rowId(row, fallback);
  const prefix = ID_PREFIX[command];
  return raw.startsWith(`${prefix}/`) ? raw : `${prefix}/${raw}`;
}

function rowDate(row) {
  for (const key of ["date", "day", "ruledAt", "occurredAt", "createdAt", "updatedAt", "_creationTime"]) {
    const date = unknownDate(row?.[key]);
    if (date !== "unknown") return date;
  }
  return "unknown";
}

function quoted(value) {
  return `"${singleLine(value)}"`;
}

function absoluteSessionUrl(value) {
  if (typeof value !== "string" || value === "") return "unknown";
  try {
    // The server owns the path; this only gives its returned relative deep
    // link the public origin required by the command's terminal output.
    return new URL(value, "https://tom.quest").toString();
  } catch {
    return "unknown";
  }
}

export function formatRulingResult(row, fallback = "ruling") {
  const id = citedId("rulings", row, fallback);
  const date = rowDate(row);
  const provenance = row?.provenance
    ? `from=${singleLine(row.provenance.from)} inbound=${singleLine(row.provenance.inboundId)} quote=${quoted(row.provenance.quote)}`
    : "none";
  return `${id} ${date} verdict=${singleLine(row?.verdict)} sentence=${quoted(row?.sentence)} provenance=${provenance} todo=${quoted(row?.todoStatement)}`;
}

export function formatSessionResult(row, fallback = "session") {
  const id = citedId("sessions", row, fallback);
  const date = rowDate(row);
  const repos = Array.isArray(row?.repos)
    ? row.repos.map(singleLine).filter(Boolean).join(",")
    : singleLine(row?.repo);
  return `${id} ${date} title=${quoted(row?.title)} status=${singleLine(row?.status)} model=${singleLine(row?.model)} summary=${quoted(row?.outcomeSummary)}${repos ? ` repos=${repos}` : ""} url=${absoluteSessionUrl(row?.url ?? row?.sessionUrl ?? row?.actualUrl)}`;
}

export function formatEventResult(row, fallback = "event") {
  return `${citedId("events", row, fallback)} ${rowDate(row)} kind=${singleLine(row?.kind)} text=${quoted(row?.text)}`;
}

export function formatTodoResult(row, fallback = "todo") {
  const dates = ["createdAt", "updatedAt", "dueAt", "wakeAt", "doneAt", "archivedAt"]
    .filter((key) => row?.[key] !== undefined && row[key] !== null)
    .map((key) => `${key}=${unknownDate(row[key])}`)
    .join(" ");
  return `${citedId("todos", row, fallback)} ${rowDate(row)} statement=${quoted(row?.statement)} status=${singleLine(row?.status)} category=${quoted(row?.category)}${dates ? ` ${dates}` : ""}`;
}

/**
 * One evals run as one line: the event id, the day, the repository and commit
 * it scored, the counts the runner recorded, and the ids of the items that did
 * not pass. The failing ids are what a session actually acts on, so they are
 * named rather than left as a count the reader must go and expand.
 *
 * The row is the raw dtsEvents row the door returns — `at` for the instant and
 * a `data` object for the run — not the flattened `date`/`text` shape the four
 * /tts/search/* doors above normalize to.
 */
export function formatEvalsResult(row, fallback = "evals") {
  const data = row?.data ?? {};
  const date = row?.at === undefined ? rowDate(row) : unknownDate(row.at);
  const counts = [["items", "items"], ["pass", "pass"], ["fail", "fail"], ["regressions", "regressions"], ["stillFailing", "still-failing"]]
    .filter(([key]) => data[key] !== undefined && data[key] !== null)
    .map(([key, name]) => `${name}=${singleLine(data[key])}`)
    .join(" ");
  const failures = Array.isArray(data.failures)
    ? data.failures.map((failure) => singleLine(failure?.id ?? "")).filter(Boolean).join(",")
    : "";
  return `${citedId("evals", row, fallback)} ${date} repo=${singleLine(data.repo)} sha=${singleLine(data.sha)}${counts ? ` ${counts}` : ""}${failures ? ` failures=${quoted(failures)}` : ""}`;
}

/** Dispatch only to a result type whose fields have an intentional contract. */
export function formatDatabaseResult(command, row, fallback = "result") {
  switch (command) {
    case "rulings": return formatRulingResult(row, fallback);
    case "sessions": return formatSessionResult(row, fallback);
    case "events": return formatEventResult(row, fallback);
    case "todos": return formatTodoResult(row, fallback);
    case "evals": return formatEvalsResult(row, fallback);
    case "proposals": return formatProposalResult(row, fallback);
    default: throw new Error(`tts-search: no formatter for ${command}`);
  }
}

export function redactValue(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  }
  return value;
}

function wikiTomDir(options, env, defaultWikiTom) {
  return options.wikitom ?? env.WIKITOM_DIR ?? defaultWikiTom;
}

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function relative(root, file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function mtimeDate(file) {
  return unknownDate(fs.statSync(file).mtimeMs);
}

function sourceDate(rel, text, file) {
  const pathDate = rel.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (pathDate && isDay(pathDate[1])) return pathDate[1];
  const { fields } = parseFrontmatter(text);
  for (const name of ["updated", "reviewed", "date", "created"]) {
    const entry = Object.entries(fields).find(([key]) => key.toLowerCase() === name)?.[1];
    const date = unknownDate(entry);
    if (date !== "unknown") return date;
  }
  return mtimeDate(file);
}

function linesMatching(root, dirs, query, limit) {
  const needle = query.toLocaleLowerCase();
  const out = [];
  for (const dir of dirs) {
    for (const file of filesUnder(path.join(root, dir))) {
      const rel = relative(root, file);
      const fileText = fs.readFileSync(file, "utf8");
      const date = sourceDate(rel, fileText, file);
      const lines = fileText.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].toLocaleLowerCase().includes(needle)) {
          // Redact before cutting: otherwise a token split at an excerpt edge
          // might cease to match the later whole-token redactor.
          out.push({ id: `${rel}:${i + 1}`, date, path: rel, line: i + 1, text: excerpt(redactSecrets(lines[i]), query) });
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

function areaResult(file, { includeSections = true } = {}) {
  const markdown = fs.readFileSync(file, "utf8");
  const { fields } = parseFrontmatter(markdown);
  const updated = unknownDate(Object.entries(fields).find(([key]) => key.toLowerCase() === "updated")?.[1]);
  const reviewed = unknownDate(Object.entries(fields).find(([key]) => key.toLowerCase() === "reviewed")?.[1]);
  const row = {
    id: `area:${path.basename(file, ".md")}`,
    date: updated !== "unknown" ? updated : reviewed !== "unknown" ? reviewed : mtimeDate(file),
    name: path.basename(file, ".md"),
    updated,
    reviewed,
  };
  if (includeSections) {
    // "Current state" is the only protected section the area pages carry;
    // every "Must not break" heading is gone from model-of-tom/areas/, so
    // extracting one only ever printed an empty field at a model.
    row.currentState = extractSections(markdown, ["Current state"]);
  }
  return row;
}

export function areaResults(root, wanted) {
  const dir = path.join(root, "model-of-tom", "areas");
  const pages = filesUnder(dir).filter((file) => file.toLocaleLowerCase().endsWith(".md"));
  const names = pages.map((file) => path.basename(file, ".md")).sort((a, b) => a.localeCompare(b));
  if (wanted.toLocaleLowerCase() === "all") {
    return names.map((name) => areaResult(pages.find((file) => path.basename(file, ".md") === name), { includeSections: false }));
  }
  const file = pages.find((candidate) => path.basename(candidate, ".md").toLocaleLowerCase() === wanted.toLocaleLowerCase());
  if (!file) fail(`area "${wanted}" was not found under ${dir}`);
  return [areaResult(file)];
}

function archiveDate(rel) {
  const match = rel.match(/(?:^|\/)sessions\/(\d{4})\/(\d{2})\/(\d{2})(?:\/|$)/);
  return match && isDay(`${match[1]}-${match[2]}-${match[3]}`) ? `${match[1]}-${match[2]}-${match[3]}` : "unknown";
}

/** A bounded view around the matching text, so a huge JSONL line cannot become
 * a huge terminal line or JSON response. The search itself still reads it all. */
export function excerpt(value, query, max = 4_000) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  const found = text.toLocaleLowerCase().indexOf(String(query ?? "").toLocaleLowerCase());
  const center = found === -1 ? Math.floor(text.length / 2) : found + String(query).length / 2;
  const start = Math.max(0, Math.min(text.length - max, Math.floor(center - max / 2)));
  const end = Math.min(text.length, start + max);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Search archives incrementally: a no-match run reads every byte, but never
 * holds an entire transcript (or decompressed gzip) in memory. */
export async function archiveResults(root, query, since, limit) {
  const archive = path.join(root, "sessions");
  if (!fs.existsSync(archive)) return { missing: archive, rows: [] };
  const needle = query.toLocaleLowerCase();
  const rows = [];
  for (const file of filesUnder(archive)) {
    const rel = relative(root, file);
    const date = archiveDate(rel) === "unknown" ? mtimeDate(file) : archiveDate(rel);
    if (since && (date === "unknown" || date < since)) continue;
    let index = 0;
    try {
      const stream = fs.createReadStream(file);
      const input = /\.gz$/i.test(file) ? stream.pipe(zlib.createGunzip()) : stream;
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        index += 1;
        if (!line.toLocaleLowerCase().includes(needle)) continue;
        // As above, redact before excerpting so no credential can be split
        // across a boundary before the final output-defense pass runs.
        rows.push({ id: `${rel}:${index}`, date, path: rel, line: index, text: excerpt(redactSecrets(line), query) });
        if (rows.length >= limit) return { missing: null, rows };
      }
    } catch {
      fail(`could not read archived session ${rel}`);
    }
  }
  return { missing: null, rows };
}

function databaseSearchResponse(body, limit, invalidMessage) {
  if (Array.isArray(body)) return { rows: body.slice(0, limit), metadata: null, json: null };
  const rows = body?.results ?? body?.items;
  if (!Array.isArray(rows)) fail(invalidMessage);
  const metadata = {};
  if (Number.isInteger(body.scanned) && body.scanned >= 0) metadata.scanned = body.scanned;
  if (typeof body.exhausted === "boolean") metadata.exhausted = body.exhausted;
  if (body.oldestScannedAt !== undefined && body.oldestScannedAt !== null) {
    const date = unknownDate(body.oldestScannedAt);
    if (date !== "unknown") metadata.oldestScannedAt = date;
  }
  const limited = rows.slice(0, limit);
  const hasMetadata = Object.keys(metadata).length !== 0;
  return {
    rows: limited,
    metadata: hasMetadata ? metadata : null,
    // New server envelopes carry coverage alongside results. Keep that shape
    // for JSON clients, but retain the historical bare array for old servers.
    json: hasMetadata ? { ...body, results: limited } : null,
  };
}

function formatSearchCoverage(metadata) {
  if (!metadata || metadata.scanned === undefined) return null;
  const coverage = metadata.oldestScannedAt
    ? `tts-search: searched ${metadata.scanned} rows back to ${metadata.oldestScannedAt}`
    : `tts-search: searched ${metadata.scanned} rows`;
  return metadata.exhausted === undefined ? coverage : `${coverage} (${metadata.exhausted ? "exhausted" : "more may remain"})`;
}

async function databaseResults(command, options, env, fetchFn) {
  const site = env.CONVEX_SITE_URL;
  const key = env.TTS_WORKER_KEY;
  if (!site || !key) fail("CONVEX_SITE_URL and TTS_WORKER_KEY must be set for production searches");
  const params = new URLSearchParams();
  for (const keyName of ["query", "since", "repo", "status", "limit"]) {
    if (options[keyName] !== undefined) params.set(keyName, String(options[keyName]));
  }
  const url = `${site.replace(/\/+$/, "")}/tts/search/${command}?${params}`;
  let response;
  try {
    response = await fetchFn(url, { headers: { "X-TTS-Key": key } });
  } catch {
    fail(`could not reach /tts/search/${command}`);
  }
  if (!response.ok) fail(`/tts/search/${command} -> HTTP ${response.status}`);
  let body;
  try {
    body = await response.json();
  } catch {
    fail(`/tts/search/${command} returned invalid JSON`);
  }
  return databaseSearchResponse(body, options.limit, `/tts/search/${command} returned no result array`);
}

/** The four ways an evidence entry names its source, in the spelling the
 * checker enforces. A `line:` with none of these under it is an entry the
 * evidence check would already have refused, so the row prints without one
 * rather than being hidden. */
const EVIDENCE_SOURCE = /^\s*(said|paraphrase|read|rests on):\s*(.*)$/;

/**
 * `evidence <query>` — the per-line record under model-of-tom/evidence/.
 *
 * WHY IT IS NOT `sources`: sources searches WikiTom's raw material, and this
 * searches the FILE THAT SAYS WHY EACH LINE OF A MODEL-OF-TOM PAGE IS THERE.
 * The prelude's fetchable block names this command for exactly that question —
 * "where did this sentence come from" — and the answer is one entry, not a
 * grep hit in the middle of a paragraph.
 *
 * The unit is the ENTRY, never the raw line: a match anywhere inside an entry
 * (its `line:` or any of its sources) returns that entry whole. What is printed
 * is `<path>:<heading>`, the entry's `line:`, and the FIRST source under it
 * with its own kind kept (`said`, `paraphrase`, `read`, `rests on`). The rest
 * of the sources are in the file at that heading, which the id names.
 */
export function evidenceResults(root, query, limit) {
  const dir = path.join(root, "model-of-tom", "evidence");
  if (!fs.existsSync(dir)) return { missing: dir, rows: [] };
  const needle = query.toLocaleLowerCase();
  const rows = [];
  for (const file of filesUnder(dir)) {
    if (!file.toLocaleLowerCase().endsWith(".md")) continue;
    const rel = relative(root, file);
    const text = fs.readFileSync(file, "utf8");
    const date = sourceDate(rel, text, file);
    let heading = "";
    // One pass, entry by entry: a `## ` line moves the heading, a `- line: `
    // opens an entry, and everything until the next of either belongs to it.
    let entry = null;
    const flush = () => {
      if (entry === null) return;
      const hay = [entry.line, ...entry.sources.map((source) => `${source.kind}: ${source.text}`)]
        .join("\n")
        .toLocaleLowerCase();
      if (hay.includes(needle) && rows.length < limit) {
        const source = entry.sources[0] ?? null;
        rows.push({
          id: `${rel}:${entry.heading}`,
          date,
          path: rel,
          heading: entry.heading,
          line: excerpt(redactSecrets(entry.line), query),
          // The kind is kept beside the text because it is the fact: `said:` is
          // Tom's own words and `paraphrase:` is not, and a reader that cannot
          // tell them apart is the misquotation the evidence file exists to
          // prevent. Null when the entry carries no source at all.
          sourceKind: source === null ? null : source.kind,
          sourceText: source === null ? null : excerpt(redactSecrets(source.text), query),
        });
      }
      entry = null;
    };
    for (const raw of text.split(/\r?\n/)) {
      const isHeading = /^#{1,6}\s/.test(raw);
      const opens = raw.match(/^\s*-\s*line:\s*(.*)$/);
      if (isHeading) {
        flush();
        heading = raw.replace(/^#+\s*/, "").trim();
        continue;
      }
      if (opens) {
        flush();
        entry = { heading, line: opens[1].trim(), sources: [] };
        continue;
      }
      if (entry === null) continue;
      const source = raw.match(EVIDENCE_SOURCE);
      if (source) entry.sources.push({ kind: source[1], text: source[2].trim() });
    }
    flush();
    if (rows.length >= limit) break;
  }
  return { missing: null, rows: rows.slice(0, limit) };
}

// ── skills ───────────────────────────────────────────────────────────────────
//
// `skills` reads THE INSTALLED SKILLS DIRECTORY, not Convex. Every other
// command here reads WikiTom or a production door; this one reads what a run's
// harness would actually load, so it works with no network at all and it can
// never name a skill that is published but not yet on this machine.

/**
 * The roots a harness resolves a skill directory from, first hit wins:
 *
 *   1. $CLAUDE_CONFIG_DIR/skills, else <home>/.claude/skills
 *   2. <home>/.codex/skills
 *
 * ONE ORDER FOR BOTH MACHINES. The laptop sets no CLAUDE_CONFIG_DIR and falls
 * back to <home>/.claude. The box's per-account roots are
 * /root/.claude-accounts/<account>/skills and are reachable ONLY through
 * CLAUDE_CONFIG_DIR — which its jobs, its cron and its session host all set —
 * so naming the accounts directory here would be a second, staler answer.
 */
export function skillRoots(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const claude = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR !== "" ? env.CLAUDE_CONFIG_DIR : path.join(home, ".claude");
  return [path.join(claude, "skills"), path.join(home, ".codex", "skills")];
}

// scripts/skills.mjs is THE definition of the prefix and the groups, and it
// has two homes: scripts/ beside worker/ in a checkout, and /opt/tts/scripts/
// beside the flat jobs on the box (worker/setup.sh copies it there). Both
// specifiers are named rather than guessed, exactly as worker/jobs/tts-lib.mjs
// names both homes of the registration body. The import is LAZY so a search
// for a ruling never depends on the skill machinery being installed.
const SKILLS_MODULE_URLS = [
  new URL("../../scripts/skills.mjs", import.meta.url),
  new URL("./scripts/skills.mjs", import.meta.url),
];
const REGISTRATION_MODULE_URLS = [
  new URL("../runs/registration.mjs", import.meta.url),
  new URL("./runs/registration.mjs", import.meta.url),
];

function installedModule(urls, extra) {
  return [
    ...urls.flatMap((candidate) => (candidate.protocol === "file:" ? [fileURLToPath(candidate)] : [])),
    ...extra.map((candidate) => path.resolve(candidate)),
  ].find((candidate) => fs.existsSync(candidate));
}

let skillsModule = null;
async function loadSkillsModule() {
  if (skillsModule === null) {
    const file = installedModule(SKILLS_MODULE_URLS, ["scripts/skills.mjs"]);
    if (!file) fail("the skill definitions (scripts/skills.mjs) are not installed");
    skillsModule = await import(pathToFileURL(file).href);
  }
  return skillsModule;
}

let registrationModule = null;
async function loadRegistrationModule() {
  if (registrationModule === null) {
    const file = installedModule(REGISTRATION_MODULE_URLS, ["worker/runs/registration.mjs", "runs/registration.mjs"]);
    if (!file) return null;
    registrationModule = await import(pathToFileURL(file).href);
  }
  return registrationModule;
}

/**
 * Record the ask on this run's registration envelope, when this process was
 * launched inside one (TTS_RUN_REG_SPOOL and TTS_RUN_REG_TOKEN together).
 *
 * THE ENVELOPE IS A RECORD, NEVER A REASON A SEARCH FAILS. A missing, busy or
 * unreadable envelope is swallowed: the answer to `tts search skills` does not
 * depend on it, and a search command that died writing its own telemetry would
 * be the worst possible trade.
 */
async function noteSkillAsk(env, ask) {
  const spoolDir = env.TTS_RUN_REG_SPOOL;
  const token = env.TTS_RUN_REG_TOKEN;
  if (!spoolDir || !token) return;
  try {
    const registration = await loadRegistrationModule();
    if (registration === null) return;
    registration.appendSkillAsk({ spoolDir, token, ask });
  } catch {
    // Deliberate: see above.
  }
}

/** `know-research` from `know-research` OR `tom-know-research`. The prefix is a
 * directory-naming fact and nothing a caller is corrected about. */
function bareSkillName(name, prefix) {
  const text = String(name ?? "").trim();
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/** THE GROUP IS DERIVED, NOT READ. A SKILL.md's frontmatter carries `name` and
 * `description` and nothing else, by design (scripts/skills.mjs renderSkillMd
 * says why), so the group comes off the name: `write` is write, `know-*` is
 * know, `repo-*` is repo. */
function skillGroup(name, groups) {
  const head = String(name ?? "").split("-")[0];
  return groups.includes(head) ? head : "unknown";
}

/** renderSkillMd JSON-quotes the description so a `"` or a `:` inside it cannot
 * break the block, and parseFrontmatter parses nothing inside a value. */
function frontmatterText(value) {
  const raw = String(value ?? "").trim();
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length > 1) {
    try {
      return String(JSON.parse(raw));
    } catch {
      // Not JSON after all — the literal is the honest answer.
    }
  }
  return raw;
}

/**
 * Every one of Tom's skills installed under `dir`, by name.
 *
 * A directory is one of ours ONLY when its name starts with the publisher's
 * prefix. Everything else under the root — a checkout's own skills, the
 * harness's — is invisible here, because this command answers one question:
 * what of Tom's can this run load.
 */
export function readSkillCatalog(dir, { prefix, groups }) {
  if (!fs.existsSync(dir)) return [];
  const catalog = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const skillDir = path.join(dir, entry.name);
    const file = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const { fields, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
    const name = bareSkillName(entry.name, prefix);
    catalog.push({
      name,
      group: skillGroup(name, groups),
      description: frontmatterText(fields.description),
      // The bytes of SKILL.md itself — what loading this skill costs a prompt.
      bytes: fs.statSync(file).size,
      path: skillDir,
      references: fs
        .readdirSync(skillDir, { withFileTypes: true })
        .filter((reference) => reference.isFile() && reference.name !== "SKILL.md")
        .map((reference) => ({ name: reference.name, path: path.join(skillDir, reference.name) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      body: body.trim(),
    });
  }
  return catalog.sort((a, b) => a.name.localeCompare(b.name));
}

function sharedPrefix(a, b) {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
  return length;
}

/** The catalog names a refused name could plausibly have meant: one sharing a
 * three-character prefix with it, or one in the same group — the group is
 * derivable from whatever the caller typed, so `know-nothing` still points at
 * every know- skill. `areas` refuses with the directory alone and no near-miss
 * idiom to follow; this is it. */
export function skillNearMisses(name, catalog, groups) {
  const wanted = String(name ?? "").toLocaleLowerCase();
  const group = skillGroup(wanted, groups);
  return catalog
    .filter((skill) => (group !== "unknown" && skill.group === group) || sharedPrefix(skill.name.toLocaleLowerCase(), wanted) >= 3)
    .map((skill) => skill.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * `skills [<name>]` — the installed catalog, or one skill whole.
 *
 * A MISSING DIRECTORY IS NOT AN ERROR: the list is simply empty, and the text
 * form says which directories were looked in. An unknown NAME is an error,
 * because the caller asked for something by name and got nothing.
 */
export async function skillResults(options, env) {
  const { SKILL_PREFIX, SKILL_GROUPS } = await loadSkillsModule();
  const searched = options.skillsDir === undefined ? skillRoots(env) : [path.resolve(options.skillsDir)];
  const dir = searched.find((candidate) => fs.existsSync(candidate)) ?? null;
  const catalog = dir === null ? [] : readSkillCatalog(dir, { prefix: SKILL_PREFIX, groups: SKILL_GROUPS });

  if (options.skill !== undefined) {
    const asked = bareSkillName(options.skill, SKILL_PREFIX);
    const found = catalog.find((skill) => skill.name.toLocaleLowerCase() === asked.toLocaleLowerCase());
    if (found === undefined) {
      const near = skillNearMisses(asked, catalog, SKILL_GROUPS);
      await noteSkillAsk(env, { name: asked, result: "refused", why: "not in the catalog" });
      fail(
        `skill "${asked}" is not in the catalog at ${searched.join(" or ")}; ${
          near.length === 0 ? "no near misses" : `near misses: ${near.join(", ")}`
        }`,
      );
    }
    await noteSkillAsk(env, { name: found.name, result: "ok" });
    return { rows: [found], note: null, json: { skill: found } };
  }

  if (options.group !== undefined && !SKILL_GROUPS.includes(options.group)) {
    fail(`--group must be one of ${SKILL_GROUPS.join(", ")}`);
  }
  // The list form drops each body: the bodies together are far larger than any
  // terminal wants, and `skills <name>` is how one is read.
  const rows = catalog
    .filter((skill) => options.group === undefined || skill.group === options.group)
    .slice(0, options.limit)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructuring is how the body is dropped
    .map(({ body, ...rest }) => rest);
  return {
    rows,
    note: dir === null ? `tts-search: no skills directory at ${searched.join(" or ")}` : null,
    json: { skills: rows },
  };
}

/**
 * `proposals [--repo NAME]` — the OPEN repository-rule proposals the nightly
 * repo-learning step made, over GET /tts/repo-proposals.
 *
 * Its own fetch and not databaseResults': the door is not one of the
 * /tts/search/* family, it takes no query, and its envelope is
 * `{ proposals: [...] }`. A session working in a repository reads this before
 * it edits that repository's AGENTS.md, which is why the id printed is the
 * proposal id POST /tts/repo-proposal-applied takes back.
 */
export async function proposalResults(options, env, fetchFn) {
  const site = env.CONVEX_SITE_URL;
  const key = env.TTS_WORKER_KEY;
  if (!site || !key) fail("CONVEX_SITE_URL and TTS_WORKER_KEY must be set for production searches");
  const params = new URLSearchParams();
  if (options.repo !== undefined) params.set("repo", options.repo);
  params.set("limit", String(options.limit));
  let response;
  try {
    response = await fetchFn(`${site.replace(/\/+$/, "")}/tts/repo-proposals?${params}`, {
      headers: { "X-TTS-Key": key },
    });
  } catch {
    fail("could not reach /tts/repo-proposals");
  }
  if (!response.ok) fail(`/tts/repo-proposals -> HTTP ${response.status}`);
  let body;
  try {
    body = await response.json();
  } catch {
    fail("/tts/repo-proposals returned invalid JSON");
  }
  const rows = Array.isArray(body) ? body : body?.proposals;
  if (!Array.isArray(rows)) fail("/tts/repo-proposals returned no proposal array");
  return rows.slice(0, options.limit);
}

/** One proposal as one line: the id a session cites when it applies the line,
 * the file and section the line belongs in, the line itself, and what the
 * night read to propose it. */
export function formatProposalResult(row, fallback = "proposal") {
  const id = rowId(row, fallback);
  const section = singleLine(row?.section ?? "");
  return [
    `repoProposal/${id}`,
    unknownDate(row?.at ?? row?.day),
    `repo=${singleLine(row?.repo ?? "")}`,
    `file=${singleLine(row?.file ?? "")}${section === "" ? "" : ` § ${section}`}`,
    `line=${quoted(row?.line)}`,
    `evidence=${quoted(row?.evidence)}`,
  ].join(" ");
}

// ── graph and vocabulary ─────────────────────────────────────────────────────
//
// Four commands over the two GENERATED files in the WikiTom checkout:
// `tts/graph.json`, which scripts/graph.mjs writes, and `tts/vocabulary.json`,
// which scripts/vocabulary.mjs writes. Neither is hand-edited and neither is
// ever loaded into a prompt; these commands are how a run reads one node, one
// neighbourhood or one word out of them on demand.
//
// THE FILE IS READ AND PARSED ONCE PER INVOCATION and never held in a
// module-level cache. `tts search` is one process per question, so a cache
// saves nothing between questions, and inside one process — a test, or the
// box's session host — a cached graph is a graph that outlives the file it was
// read from and answers from bytes that are no longer on disk.

/**
 * Where each generated file sits in the WikiTom checkout.
 *
 * The two writers spell the same paths (scripts/graph.mjs GRAPH_PATH,
 * scripts/vocabulary.mjs VOCABULARY_PATH). They are repeated here rather than
 * imported because either import would pull a generator's whole I/O half —
 * node:child_process, the record reader, the disagreement machinery — into a
 * command that only reads the output.
 */
const GRAPH_PATH = "tts/graph.json";
const VOCABULARY_PATH = "tts/vocabulary.json";

/** `near`'s defaults and its bounds. The bounds exist so a typo asks for a
 * walk that finishes: the graph is a few thousand nodes across, so six hops
 * reaches all of it, and a budget of a mebibyte admits every node there is. */
export const DEFAULT_HOPS = 2;
export const DEFAULT_WALK_BYTES = 4_096;
export const MAX_HOPS = 6;
export const MAX_WALK_BYTES = 1_048_576;

/** The most `did you mean` rows a refusal prints. */
const NEAR_MISSES = 5;

// worker/jobs/graph.mjs is the pure half — the kinds, the index and the walk.
// The import is LAZY for the same reason the skills module's is: a search for a
// ruling must not depend on the graph machinery being installed beside it, and
// graph.mjs reaches scripts/skills.mjs, which on the box is a separate copy.
const GRAPH_MODULE_URLS = [new URL("./graph.mjs", import.meta.url)];

let graphModule = null;
async function loadGraphModule() {
  if (graphModule === null) {
    const file = installedModule(GRAPH_MODULE_URLS, ["worker/jobs/graph.mjs", "graph.mjs"]);
    if (!file) fail("the graph module (worker/jobs/graph.mjs) is not installed");
    graphModule = await import(pathToFileURL(file).href);
  }
  return graphModule;
}

/** One generated file, parsed. A missing file returns its path the way
 * `evidence` and `archive` do — the caller prints it and exits 3 — and a file
 * that is present but not JSON is an error, because something wrote it wrong. */
function readGenerated(root, relativePath, regenerate) {
  const file = path.join(root, relativePath);
  if (!fs.existsSync(file)) return { missing: file, value: null };
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(`${file} is not JSON — regenerate it with \`${regenerate}\``);
  }
  return { missing: null, value };
}

async function loadGraph(root) {
  const { missing, value } = readGenerated(root, GRAPH_PATH, "node scripts/graph.mjs --write");
  if (missing) return { missing, graph: null, module: null };
  if (!Array.isArray(value?.nodes) || !Array.isArray(value?.edges)) {
    fail(`${path.join(root, GRAPH_PATH)} carries no nodes and edges arrays`);
  }
  return { missing: null, graph: value, module: await loadGraphModule() };
}

/**
 * The id a `node` or `near` argument names, or the rows saying why it names
 * nothing.
 *
 * Three steps, in order. An id with its kind on it (`term:batch`) is looked up
 * whole. A BARE id (`9f2a71c4`) matches every node whose id carries that half,
 * and resolves only when exactly one does — two is a refusal naming both,
 * because guessing between two kinds would answer a question nobody asked.
 * Anything still unmatched falls to a case-insensitive substring over `text`
 * and `title`, which is what turns a half-remembered sentence into an id.
 */
function resolveNode(module, graph, wanted) {
  const asked = String(wanted ?? "");
  const exact = graph.nodes.find((row) => row.id === asked);
  if (exact !== undefined) return { node: exact };

  if (!asked.includes(":")) {
    const bare = graph.nodes.filter((row) => row.id.slice(row.id.indexOf(":") + 1) === asked);
    if (bare.length === 1) return { node: bare[0] };
    if (bare.length > 1) {
      const candidates = [...bare].sort((a, b) => a.id.localeCompare(b.id));
      return {
        node: null,
        row: { form: "ambiguous", id: asked, candidates },
        json: { refused: "ambiguous", id: asked, candidates: candidates.map((row) => row.id) },
      };
    }
  }

  // A kind prefix that named no node is dropped before the substring search:
  // `node term:batch` on a graph with no such term is asking about the WORD
  // batch, and searching for the literal "term:batch" would find nothing by
  // construction.
  const kinds = Array.isArray(graph.nodeKinds) ? graph.nodeKinds : [];
  const kind = module.kindOf(asked);
  const needle = (kinds.includes(kind) ? asked.slice(kind.length + 1) : asked).toLocaleLowerCase();
  const candidates = needle === "" ? [] : graph.nodes
    .filter((row) => `${row.text ?? ""}\n${row.title ?? ""}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, NEAR_MISSES);
  return {
    node: null,
    row: { form: "unknown", id: asked, needle, candidates },
    json: { refused: "unknown", id: asked, candidates: candidates.map((row) => row.id) },
  };
}

/**
 * `node <id>` — one node and every edge touching it.
 *
 * The edges come from the module's own index rather than a filter written
 * here, so what this prints is exactly what a walk would traverse.
 */
export async function graphNodeResults(root, wanted) {
  const { missing, graph, module } = await loadGraph(root);
  if (missing) return { missing, rows: [] };
  const found = resolveNode(module, graph, wanted);
  if (found.node === null) return { missing: null, refused: true, rows: [found.row], json: found.json };
  const edges = module.edgesOf(graph, found.node.id);
  return {
    missing: null,
    rows: [{ form: "node", node: found.node, out: edges.out, in: edges.in }],
    json: { node: found.node, edges: { out: edges.out, in: edges.in } },
  };
}

/**
 * The command that reaches a node the budget left out.
 *
 * An area and a page have a cheaper door than another walk — `areas` reads the
 * page's own protected sections, and a page IS a file in a checkout — so the
 * frontier names those doors. Everything else is another `near`.
 */
function frontierCommand(row) {
  if (row.kind === "area") return `tts-search areas ${row.title ?? row.id.slice(row.id.indexOf(":") + 1)}`;
  if (row.kind === "page" && typeof row.path === "string" && row.path !== "") return row.path;
  return `tts-search near ${row.id}`;
}

/**
 * `near <id> [--hops k] [--bytes n]` — the walk, rendered.
 *
 * The admitted nodes are sorted by the module's own RENDER ORDER, which is the
 * order a prompt would carry them in; the frontier is left in the order the
 * walk produced, which is cost order, so the nodes that only just missed the
 * budget are at the top of the block where a reader looking for the next
 * command will find them.
 */
export async function graphNearResults(root, wanted, hops, bytes) {
  const { missing, graph, module } = await loadGraph(root);
  if (missing) return { missing, rows: [] };
  const found = resolveNode(module, graph, wanted);
  if (found.node === null) return { missing: null, refused: true, rows: [found.row], json: found.json };
  const result = module.walk(graph, [found.node.id], bytes, null, { maxHops: hops });
  const admitted = [...result.nodes].sort(module.byRenderOrder);
  const frontier = result.frontier.map((row) => ({ node: row, command: frontierCommand(row) }));
  const row = {
    form: "walk",
    seed: found.node.id,
    hops,
    budget: bytes,
    bytes: result.bytes,
    admitted,
    frontier,
  };
  return {
    missing: null,
    rows: [row],
    json: {
      seed: row.seed,
      hops,
      bytes: result.bytes,
      budget: bytes,
      admitted,
      frontier: frontier.map((entry) => ({ id: entry.node.id, command: entry.command })),
    },
  };
}

/** The fields `define` prints and searches, in that order. A term matches a
 * miss's substring search on any of them, because a reader who remembers a
 * definition and not its word is exactly who is asking. */
function termHaystack(term) {
  return [
    term?.term,
    term?.kind,
    term?.definition,
    term?.specSection,
    term?.codeSymbol,
    ...(Array.isArray(term?.related) ? term.related : []),
  ]
    .map((value) => String(value ?? ""))
    .join("\n")
    .toLocaleLowerCase();
}

function vocabularyTerms(value) {
  return Array.isArray(value?.terms) ? value.terms : [];
}

/**
 * The spec section the vocabulary itself is fixed in, carried onto every
 * printed row. It is the file's own `generatedFrom.specSection` rather than a
 * literal here, so a vocabulary moved to another section says so.
 */
function vocabularySection(value) {
  const section = value?.generatedFrom?.specSection;
  return typeof section === "string" && section !== "" ? section : "unknown";
}

/** `define <term>` — one term's entry, or the words it could have meant. */
export function defineResults(root, wanted) {
  const { missing, value } = readGenerated(root, VOCABULARY_PATH, "node scripts/vocabulary.mjs --write");
  if (missing) return { missing, rows: [] };
  const section = vocabularySection(value);
  const terms = vocabularyTerms(value);
  const asked = String(wanted ?? "").toLocaleLowerCase();
  const found = terms.find((term) => String(term?.term ?? "").toLocaleLowerCase() === asked);
  if (found !== undefined) {
    return { missing: null, rows: [{ form: "term", section, term: found }], json: { term: found } };
  }
  const candidates = asked === "" ? [] : terms
    .filter((term) => termHaystack(term).includes(asked))
    .sort((a, b) => String(a?.term ?? "").localeCompare(String(b?.term ?? "")))
    .slice(0, NEAR_MISSES);
  return {
    missing: null,
    refused: true,
    rows: [{ form: "no-term", section, term: String(wanted ?? ""), candidates }],
    json: { refused: "unknown", term: String(wanted ?? ""), candidates: candidates.map((term) => term.term) },
  };
}

/**
 * `vocabulary [--kind K]` — the whole vocabulary, under one header row.
 *
 * The header is a row like any other rather than a note, so `--json` and the
 * text form carry the same thing: the version a run would record, the counts of
 * each section, and the two commits the file was generated from.
 */
export function vocabularyResults(root, options) {
  const { missing, value } = readGenerated(root, VOCABULARY_PATH, "node scripts/vocabulary.mjs --write");
  if (missing) return { missing, rows: [] };
  const section = vocabularySection(value);
  const terms = vocabularyTerms(value);
  if (options.kind !== undefined) {
    const kinds = [...new Set(terms.map((term) => String(term?.kind ?? "")))].filter(Boolean).sort();
    // The kinds are the file's, not a list written here: a kind the generator
    // stops minting must stop being offered on the same day it stops existing.
    if (!kinds.includes(options.kind)) fail(`--kind must be one of ${kinds.join(", ")}`);
  }
  const selected = terms
    .filter((term) => options.kind === undefined || String(term?.kind ?? "") === options.kind)
    .slice(0, options.limit);
  const header = {
    form: "version",
    version: String(value?.version ?? ""),
    counts: {
      terms: terms.length,
      entities: Array.isArray(value?.entities) ? value.entities.length : 0,
      jobs: Array.isArray(value?.jobs) ? value.jobs.length : 0,
      search: Array.isArray(value?.searchQuestions) ? value.searchQuestions.length : 0,
      skills: Array.isArray(value?.skills) ? value.skills.length : 0,
      repos: Array.isArray(value?.repos) ? value.repos.length : 0,
      channels: Array.isArray(value?.channels) ? value.channels.length : 0,
    },
    wikitom: String(value?.generatedFrom?.wikitomCommit ?? "unknown"),
    tomQuest: String(value?.generatedFrom?.tomQuestCommit ?? "unknown"),
  };
  return {
    missing: null,
    rows: [header, ...selected.map((term) => ({ form: "term", section, term }))],
    json: { version: header.version, generatedFrom: value?.generatedFrom ?? null, terms: selected },
  };
}

// ── rendering the four ───────────────────────────────────────────────────────

/** One node's own text, with the file's line terminator taken off. A line node
 * of a CRLF file carries a trailing carriage return by design (graph.mjs does
 * not normalize them), and printing it would put a stray escape at the end of
 * every rule of tom.quest's AGENTS.md. */
function nodeText(value) {
  return singleLine(String(value ?? "").trim());
}

/** A node's fields, in one fixed order, each present only when the node carries
 * it. graph.json drops null fields, so absence here and absence there agree. */
function nodeFields(row) {
  const parts = [`kind=${singleLine(row.kind)}`];
  if (row.title) parts.push(`title=${quoted(row.title)}`);
  if (row.path) parts.push(`path=${singleLine(row.path)}`);
  if (row.heading) parts.push(`heading=${quoted(row.heading)}`);
  if (Number.isInteger(row.order)) parts.push(`order=${row.order}`);
  if (row.ref) parts.push(`ref=${singleLine(row.ref)}`);
  if (row.version) parts.push(`version=${singleLine(row.version)}`);
  return parts.join(" ");
}

/** A node on one line: its id, its fields, and its text. This is the shape the
 * `near` block and every `did you mean` row use, so a node reads the same
 * wherever it is named. */
function nodeLine(row) {
  const text = nodeText(row.text);
  return `${row.id} ${nodeFields(row)}${text === "" ? "" : ` text=${quoted(text)}`}`;
}

/** `  <label><content>`, the label padded to the width of the longest of the
 * three (`text`, `out`, `in`) plus one space. */
function labelled(label, content) {
  return `  ${label.padEnd(6)}${content}`;
}

function edgeLine(label, edge, arrow, other) {
  const evidence = singleLine(edge?.evidence ?? "");
  return labelled(label, `${singleLine(edge.kind)} ${arrow} ${other} (w${edge.weight})${evidence === "" ? "" : ` · ${evidence}`}`);
}

function suggestionLines(candidates, lines) {
  for (const candidate of candidates) lines.push(`  did you mean  ${nodeLine(candidate)}`);
  return lines;
}

function formatTermRow(row) {
  const term = row.term ?? {};
  const related = Array.isArray(term.related) ? term.related.join(",") : "";
  const parts = [
    `vocabulary/${singleLine(term.term)}`,
    singleLine(row.section),
    `kind=${singleLine(term.kind)}`,
    `definition=${quoted(term.definition)}`,
  ];
  if (term.specSection) parts.push(`spec=§${singleLine(term.specSection)}`);
  if (term.codeSymbol) parts.push(`code=${singleLine(term.codeSymbol)}`);
  if (related !== "") parts.push(`related=${related}`);
  // A refused word is a word the spec names as a second name for one it does
  // keep. The word it points at is the whole answer, so it is the last field
  // rather than one buried in the definition.
  if (term.kind === "refused") parts.push(`refused-for=${singleLine(term.refusedFor ?? "nothing")}`);
  return parts.join(" ");
}

function formatGraphRow(row) {
  if (row.form === "node") {
    const lines = [`graph/${row.node.id} ${nodeFields(row.node)}`];
    const text = nodeText(row.node.text);
    if (text !== "") lines.push(labelled("text", text));
    for (const edge of row.out) lines.push(edgeLine("out", edge, "→", edge.to));
    for (const edge of row.in) lines.push(edgeLine("in", edge, "←", edge.from));
    return lines.join("\n");
  }
  if (row.form === "ambiguous") {
    const kinds = [...new Set(row.candidates.map((candidate) => candidate.kind))].sort();
    return suggestionLines(row.candidates, [`graph/${row.id} ambiguous across ${kinds.length} kinds`]).join("\n");
  }
  if (row.form === "unknown") {
    const lines = [`graph/${row.id} unknown`];
    if (row.candidates.length === 0) return `${lines[0]}\n  no node's text or title carries ${quoted(row.needle)}`;
    return suggestionLines(row.candidates, lines).join("\n");
  }
  if (row.form === "no-term") {
    const lines = [`vocabulary/${singleLine(row.term)} unknown`];
    if (row.candidates.length === 0) return `${lines[0]}\n  no term's definition carries ${quoted(row.term)}`;
    for (const candidate of row.candidates) {
      lines.push(`  did you mean  ${formatTermRow({ section: row.section, term: candidate })}`);
    }
    return lines.join("\n");
  }
  if (row.form === "version") {
    const counts = row.counts;
    return [
      `vocabulary/@version ${singleLine(row.version)}`,
      `terms=${counts.terms}`,
      `entities=${counts.entities}`,
      `jobs=${counts.jobs}`,
      `search=${counts.search}`,
      `skills=${counts.skills}`,
      `repos=${counts.repos}`,
      `channels=${counts.channels}`,
      `wikitom=${singleLine(row.wikitom)}`,
      `tom.quest=${singleLine(row.tomQuest)}`,
    ].join(" ");
  }
  if (row.form === "term") return formatTermRow(row);
  // form === "walk"
  const lines = row.admitted.map(nodeLine);
  lines.push("frontier:");
  if (row.frontier.length === 0) lines.push("  none");
  for (const entry of row.frontier) lines.push(`  ${entry.node.id} · ${entry.command}`);
  // The one summary line comes last, so a truncated terminal still shows the
  // counts the reader is deciding on. The byte counts carry thousands
  // separators under a named locale, never the machine's own.
  lines.push(
    `near/${row.seed} hops=${row.hops} admitted=${row.admitted.length} frontier=${row.frontier.length} `
      + `bytes=${row.bytes.toLocaleString("en-US")}/${row.budget.toLocaleString("en-US")}`,
  );
  return lines.join("\n");
}

function formatLocal(command, row) {
  if (command === "node" || command === "near" || command === "define" || command === "vocabulary") {
    return formatGraphRow(row);
  }
  if (command === "skills") {
    const head = `${row.name} [${row.group}] ${row.bytes}B ${row.path}`;
    // The name form carries the body; the list form does not. Same idiom as
    // `areas`, whose all form carries no currentState.
    if (!("body" in row)) return `${head} description=${quoted(row.description)}`;
    const references = row.references.length === 0
      ? "references: none"
      : `references: ${row.references.map((reference) => `${reference.name} ${reference.path}`).join(", ")}`;
    return `${head}\ndescription=${quoted(row.description)}\n${references}\n\n${row.body}`;
  }
  if (command === "evidence") {
    const source = row.sourceKind === null || row.sourceKind === undefined
      ? "source=none"
      : `${row.sourceKind.replace(/ /g, "-")}=${quoted(row.sourceText)}`;
    return `${row.id} ${row.date} line=${quoted(row.line)} ${source}`;
  }
  if (command === "areas") {
    if (!("currentState" in row)) {
      return `${row.id} ${row.date} ${row.name} updated=${row.updated} reviewed=${row.reviewed}`;
    }
    return `${row.id} ${row.date} updated=${row.updated} reviewed=${row.reviewed} current-state=${singleLine(row.currentState)}`;
  }
  return `${row.id} ${row.date} ${singleLine(row.text)}`;
}

/** What a command calls the corpus it could not find, for the one line a
 * missing one prints. A command absent from the table names itself. */
const MISSING_CORPUS = Object.freeze({
  archive: "session archive",
  evidence: "evidence directory",
  node: "graph",
  near: "graph",
  define: "vocabulary",
  vocabulary: "vocabulary",
});

/** Execute a search command. Injectable IO makes formatting testable without live state. */
export async function runSearchCli(
  argv,
  { env = process.env, write = console.log, error = console.error, fetch: fetchFn = globalThis.fetch, defaultWikiTom = BOX_WIKITOM_DIR } = {},
) {
  // Output is the final boundary before a terminal transcript, so every
  // string -- including errors and filesystem paths -- gets one last pass.
  const safeWrite = (value) => write(redactSecrets(String(value)));
  const safeError = (value) => error(redactSecrets(String(value)));
  let options;
  try {
    options = parseSearchArgs(argv);
    if (options.help) {
      safeWrite(usage());
      return 0;
    }
    let rows;
    let missing = null;
    let metadata = null;
    let jsonEnvelope = null;
    let note = null;
    // A REFUSAL PRINTS ITS ROWS AND EXITS 3. `missing` already means "this
    // corpus is not here"; this means "the corpus is here and carries no such
    // thing", which a caller must be able to tell apart from an empty answer.
    let refused = false;
    if (OWN_DOOR_COMMANDS.has(options.command)) {
      rows = await proposalResults(options, env, fetchFn);
    } else if (DATABASE_COMMANDS.has(options.command)) {
      ({ rows, metadata, json: jsonEnvelope } = await databaseResults(options.command, options, env, fetchFn));
    } else if (options.command === "skills") {
      // Not under wikiTomDir: the catalog is an installed directory, not a
      // WikiTom page, and --wikitom does not apply to it.
      ({ rows, note, json: jsonEnvelope } = await skillResults(options, env));
    } else {
      const root = wikiTomDir(options, env, defaultWikiTom);
      if (options.command === "areas") rows = areaResults(root, options.area).slice(0, options.limit);
      else if (options.command === "sources") rows = linesMatching(root, ["sources", "tom-text"], options.query, options.limit);
      else if (options.command === "evidence") ({ missing, rows } = evidenceResults(root, options.query, options.limit));
      else if (options.command === "node") ({ missing, rows, json: jsonEnvelope, refused = false } = await graphNodeResults(root, options.node));
      else if (options.command === "near") {
        ({ missing, rows, json: jsonEnvelope, refused = false } = await graphNearResults(root, options.node, options.hops, options.bytes));
      } else if (options.command === "define") ({ missing, rows, json: jsonEnvelope, refused = false } = defineResults(root, options.term));
      else if (options.command === "vocabulary") ({ missing, rows, json: jsonEnvelope } = vocabularyResults(root, options));
      else ({ missing, rows } = await archiveResults(root, options.query, options.since, options.limit));
    }
    if (missing) {
      if (options.json) safeWrite(JSON.stringify({ missing }));
      else safeWrite(`tts-search: no ${MISSING_CORPUS[options.command] ?? options.command} at ${missing}`);
      return 3;
    }
    const redacted = redactValue(rows);
    if (options.json) {
      safeWrite(JSON.stringify(jsonEnvelope ? redactValue(jsonEnvelope) : redacted));
    } else {
      if (note) safeWrite(note);
      for (let i = 0; i < redacted.length; i += 1) {
        safeWrite(DATABASE_COMMANDS.has(options.command) ? formatDatabaseResult(options.command, redacted[i], `${options.command}:${i + 1}`) : formatLocal(options.command, redacted[i]));
      }
      const coverage = formatSearchCoverage(metadata);
      if (coverage) safeWrite(coverage);
    }
    return refused ? 3 : 0;
  } catch (err) {
    safeError(String(err?.message ?? err));
    return 2;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const code = await runSearchCli(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}
