// search-lib.mjs — the read-only search surface for the Jarvis Box and a
// laptop checkout. It deliberately contains no model call and no write path.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

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
const LOCAL_COMMANDS = new Set(["areas", "sources", "archive", "evidence"]);
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
    } else if (item.startsWith("--")) fail(`unknown option ${item}`);
    else options.positional.push(item);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_LIMIT) {
    fail(`--limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }
  if (options.since && !isDay(options.since)) fail("--since must be a real YYYY-MM-DD date");
  const needsQuery = new Set(["rulings", "events", "todos", "sources", "archive", "evidence"]);
  if (needsQuery.has(command)) {
    if (options.positional.length !== 1) fail(`${command} needs exactly one query`);
    options.query = options.positional[0];
  } else if (command === "areas") {
    if (options.positional.length !== 1) fail("areas needs an area name or all");
    options.area = options.positional[0];
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
  };
  for (const name of options.seen) {
    if (!allowed[command].has(name)) fail(`--${name} does not apply to ${command}`);
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

function formatLocal(command, row) {
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
    if (OWN_DOOR_COMMANDS.has(options.command)) {
      rows = await proposalResults(options, env, fetchFn);
    } else if (DATABASE_COMMANDS.has(options.command)) {
      ({ rows, metadata, json: jsonEnvelope } = await databaseResults(options.command, options, env, fetchFn));
    } else {
      const root = wikiTomDir(options, env, defaultWikiTom);
      if (options.command === "areas") rows = areaResults(root, options.area).slice(0, options.limit);
      else if (options.command === "sources") rows = linesMatching(root, ["sources", "tom-text"], options.query, options.limit);
      else if (options.command === "evidence") ({ missing, rows } = evidenceResults(root, options.query, options.limit));
      else ({ missing, rows } = await archiveResults(root, options.query, options.since, options.limit));
    }
    if (missing) {
      if (options.json) safeWrite(JSON.stringify({ missing }));
      else safeWrite(`tts-search: no ${options.command === "evidence" ? "evidence directory" : "session archive"} at ${missing}`);
      return 3;
    }
    const redacted = redactValue(rows);
    if (options.json) {
      safeWrite(JSON.stringify(jsonEnvelope ? redactValue(jsonEnvelope) : redacted));
    } else {
      for (let i = 0; i < redacted.length; i += 1) {
        safeWrite(DATABASE_COMMANDS.has(options.command) ? formatDatabaseResult(options.command, redacted[i], `${options.command}:${i + 1}`) : formatLocal(options.command, redacted[i]));
      }
      const coverage = formatSearchCoverage(metadata);
      if (coverage) safeWrite(coverage);
    }
    return 0;
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
