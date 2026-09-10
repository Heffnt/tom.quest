// THE ONE HOME for deciding what a run's prompt EXPANDS out of the know layer,
// and for rendering both the expanded block and the fetchable index.
//
// Tom's ruling, 2026-09-09: "pre-expanding info about relevant info … making
// important and comprehensive yet likely irrelevant info fetchable", and
// "optimize for a small number of tokens … we want to eliminate unknown
// unknowns."
//
// The know layer used to be sent whole to every run: 19 KB of eight area pages
// plus intent, priorities and schedule, to find the two or three hundred bytes
// that bore on the run's own subject. Here that selection is computed per run.
// Nothing that exists becomes invisible — every layer, page, section, repo
// rules file and search question NOT expanded gets one line in the fetchable
// block naming the exact command or path that gets it.
//
// THREE SIDES CALL THIS, and they must agree byte for byte:
//   convex/ttsContext.ts     at session creation and at the four HTTP doors
//   scripts/prelude.mjs      `--for <subject>`, so the CLI and the box can
//                            assemble with no Convex round trip
//   scripts/prelude.test.mjs and convex/ttsContext.test.ts, which assert on the
//                            SAME expected strings
// A second renderer is a second thing to drift, so the rendering of parts 4 and
// 6 lives HERE with the selection, not in the Convex caller.
//
// NO MODEL CALL ANYWHERE. Every rule below is a string match, a byte count or a
// date comparison, and the whole computation is a pure function of its input —
// same input, byte-identical output. That is what makes the stable prefix
// cacheable and the transcript's header lines auditable.
//
// Plain ESM, like markdown-sections.mjs beside it and for the same reason:
// worker/ is deployed to the Jarvis Box, where Node loads no TypeScript, and
// Convex bundles this file into a runtime with no filesystem. The only imports
// are two files both sides already load — markdown-sections.mjs for section
// slicing and frontmatter, prelude-layers.mjs for the one layer table (a second
// copy of "which file is in which layer" is exactly the drift this module
// exists to prevent).

import {
  extractSections,
  headings,
  parseFrontmatter,
  sectionSpan,
} from "./markdown-sections.mjs";
import { PRELUDE_LAYERS, PRELUDE_LAYER_NAMES } from "../../scripts/prelude-layers.mjs";

export class ContextError extends Error {}

// ── Budgets ──────────────────────────────────────────────────────────────────
// Every one is a fixed integer. A budget that moved with the input would make
// the same run assemble differently on different days.

/** Part 4, the expanded block's body (header line 2 is counted separately).
 *
 * RAISED FROM 8,192 AT INTEGRATION. The number was set before the area pages
 * carried `categories:` frontmatter, when a one-area todo matched by file name
 * and title and expanded roughly one page. With the frontmatter in place a
 * one-area todo reliably picks its page AND the repo rules for the directories
 * its brief names, and 8,192 was cutting the second AGENTS.md out of exactly
 * the runs that most needed it — a code session in a subdirectory. 12,288 is
 * the smallest number that fits the whole selection for the one-area case
 * (measured against the WikiTom checkout at 7a72f6f7a); a run that still
 * exceeds it shrinks by EXPAND_SHRINK below, and every dropped item moves into
 * fetchable rather than disappearing. */
export const EXPAND_BUDGET = 12288;
/** Part 6, the fetchable block's body (header line 3 counted separately). */
export const FETCHABLE_BUDGET = 2560;

/** Per-rule caps, in the order of the relevance table. */
export const CAPS = Object.freeze({
  areaPages: 2,
  areaBytes: 4096,
  intentSections: 2,
  intentBytes: 2048,
  prioritiesBytes: 1024,
  scheduleBytes: 512,
  agentsFiles: 3,
  // RAISED FROM 4,096 AT INTEGRATION, with EXPAND_BUDGET. tom.quest's own
  // AGENTS.md files run to about 2 KB each and rule 9 takes up to three of
  // them, so 4,096 admitted the root and one directory and refused the third
  // whatever the brief named. The file count stays the cap that matters.
  agentsBytes: 8192,
  rulings: 5,
  rulingsBytes: 2048,
  outcomes: 3,
  outcomesBytes: 1536,
});

/**
 * Supplemental caps. The BRIEF truncates at the last heading before the cap,
 * because a brief reads forward and a heading is where it can honestly stop;
 * a TRANSCRIPT keeps its LAST bytes, because a session's end is where it was
 * going. Both say where the rest is.
 *
 * The fork's prior transcript does not need the second cap today: forkSessionAs
 * writes the whole transcript to `.tts-transcript.md` in the workspace and the
 * opener tells the run to read it, so nothing about it rides the prompt. The
 * cap stays declared for a caller that has no workspace to write a file into.
 */
export const SUPPLEMENTAL_CAPS = Object.freeze({ brief: 8192, transcript: 24576 });

/** Where a truncated brief's rest is — one string, so the line the prompt
 * appends and the line the fetchable block writes cannot disagree. */
export const BRIEF_SOURCE = "tom.quest/tts, or the record";

/** A todo's brief as the prompt should carry it. THE ONE HOME both prompt
 * builders call, so the text that was cut and the line saying so agree. */
export function briefForPrompt(brief) {
  return truncateSupplemental(brief, SUPPLEMENTAL_CAPS.brief, { keep: "head", where: BRIEF_SOURCE });
}

// ── Callers ──────────────────────────────────────────────────────────────────
// The per-caller fixed layer table this replaces lived in five places: one
// all-three selection at convex/claudeSessions.ts insertSession and four
// ["write","know"] selections in convex/http.ts. Two rules stand in for all of
// them: WRITE GOES WHEN THE RUN'S OUTPUT REACHES TOM, and everything else comes
// from the subject.
//
// `judges` and `captures` are rule 7: a run that may judge on his behalf gets
// the corrections he has already made; a run that may capture for him gets the
// rule for what becomes a todo. Capture beats judge when a caller is both.
export const CONTEXT_CALLERS = Object.freeze({
  opener: Object.freeze({ reachesTom: true, judges: true, captures: false }),
  planner: Object.freeze({ reachesTom: true, judges: true, captures: false }),
  "capture-context": Object.freeze({ reachesTom: true, judges: false, captures: true }),
  "time-notes": Object.freeze({ reachesTom: true, judges: false, captures: false }),
  "batch-context": Object.freeze({ reachesTom: true, judges: true, captures: false }),
  "weekly-input": Object.freeze({ reachesTom: true, judges: true, captures: false }),
  prepare: Object.freeze({ reachesTom: true, judges: true, captures: false }),
  triage: Object.freeze({ reachesTom: true, judges: false, captures: true }),
  laptop: Object.freeze({ reachesTom: true, judges: false, captures: false }),
  cli: Object.freeze({ reachesTom: true, judges: false, captures: false }),
});

export const CONTEXT_CALLER_NAMES = Object.freeze(Object.keys(CONTEXT_CALLERS));

/** The caller's row, or a hard error — a caller nobody declared would silently
 * take the least context, which is the failure this table exists to stop. */
export function callerRules(caller) {
  const rules = CONTEXT_CALLERS[caller];
  if (rules === undefined) {
    throw new ContextError(`unknown caller ${caller} (one of ${CONTEXT_CALLER_NAMES.join(", ")})`);
  }
  return rules;
}

// ── Paths and page names ─────────────────────────────────────────────────────

const AREAS_DIR = PRELUDE_LAYERS.know.areas.directory;
const KNOW_FIXED = PRELUDE_LAYERS.know.files.map((file) => file.path);
export const INTENT_PATH = "model-of-tom/intent.md";
export const PRIORITIES_PATH = "model-of-tom/priorities.md";
export const SCHEDULE_PATH = "model-of-tom/schedule.md";
export const CORRECTIONS_SECTION = "Rules learned from corrections";
export const CAPTURE_SECTION = "What becomes a todo";
export const WEEK_SECTION = "Week";

/** The shipped read-only search binary: worker/bin/tts-search, on $PATH as
 * /usr/local/bin/tts-search. NOT `tts search` — the map's Search line spells it
 * with a space; every line below names a command that actually runs. The
 * `evidence` subcommand the map named landed at integration, so the evidence
 * line above now points at it rather than at `sources`. */
export const SEARCH_BINARY = "tts-search";
export const SEARCH_QUESTIONS = Object.freeze([
  { what: "his rulings, any subject", how: `${SEARCH_BINARY} rulings "<query>" [--since YYYY-MM-DD]` },
  { what: "session history, any repo", how: `${SEARCH_BINARY} sessions [--repo NAME] [--query TEXT]` },
  { what: "the event log", how: `${SEARCH_BINARY} events "<query>"` },
  { what: "todos, any status", how: `${SEARCH_BINARY} todos "<query>" [--status S]` },
  { what: "an area page and its frontmatter", how: `${SEARCH_BINARY} areas <name|all>` },
  { what: "WikiTom sources/ and tom-text/", how: `${SEARCH_BINARY} sources "<query>"` },
  { what: "archived session transcripts", how: `${SEARCH_BINARY} archive "<query>" [--since YYYY-MM-DD]` },
  // The open repository-rule proposals. A run about to edit a nested AGENTS.md
  // has no other way to learn that last night proposed a line for that very
  // file — the unknown-unknown this block exists for.
  { what: "open repository-rule proposals", how: `${SEARCH_BINARY} proposals [--repo NAME]` },
]);

export function areaName(path) {
  return path.slice(`${AREAS_DIR}/`.length).replace(/\.md$/, "");
}

export function isAreaPath(path) {
  return path.startsWith(`${AREAS_DIR}/`) && /^[^/]+\.md$/.test(path.slice(AREAS_DIR.length + 1));
}

// ── Subjects ─────────────────────────────────────────────────────────────────

/**
 * `--for <subject>` parsed. A repo name may contain dots (`tom.quest`), so the
 * paths are split off at the SECOND colon, not by splitting on every one.
 */
export function parseSubject(spec) {
  const text = String(spec ?? "").trim();
  if (text === "" || text === "none") return { kind: "none" };
  if (text === "laptop") return { kind: "laptop" };
  const colon = text.indexOf(":");
  if (colon === -1) throw new ContextError(`--for ${text} is not a subject (todo:, batch:, repo:, area:, laptop)`);
  const kind = text.slice(0, colon);
  const rest = text.slice(colon + 1);
  if (rest.trim() === "") throw new ContextError(`--for ${kind}: needs a value`);
  if (kind === "todo") return { kind: "todo", todoId: rest.trim() };
  if (kind === "batch") return { kind: "batch", batchId: rest.trim() };
  if (kind === "area") return { kind: "area", area: rest.trim() };
  if (kind === "repo") {
    const second = rest.indexOf(":");
    if (second === -1) return { kind: "repo", repo: rest.trim(), paths: [] };
    const paths = rest.slice(second + 1).split(",").map((p) => p.trim()).filter(Boolean);
    return { kind: "repo", repo: rest.slice(0, second).trim(), paths };
  }
  throw new ContextError(`--for ${kind}: is not a subject kind (todo, batch, repo, area, laptop)`);
}

/** The subjects that cannot be resolved without a record row. */
export function subjectNeedsRecord(subject) {
  return subject.kind === "todo" || subject.kind === "batch";
}

// ── Match terms ──────────────────────────────────────────────────────────────

/**
 * An area page's match terms: its file name, plus every entry of its
 * `categories:` frontmatter line. THE ONE MAPPING TABLE, and it lives in
 * WikiTom where Tom can edit it, not in code.
 *
 * WHEN NO PAGE CARRIES `categories:` YET — which is the state of every area
 * page today — the fallback is the page's own name and its `# ` title, and the
 * assembled prompt SAYS SO on header line 2. A silent fallback would read as a
 * deliberate one-term list; a stated one is a prompt to write the line.
 */
export function areaMatchTerms(page) {
  const { fields, body } = parseFrontmatter(page.body);
  const name = areaName(page.path);
  const declared = String(fields.categories ?? "")
    .split(",")
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term !== "");
  if (declared.length > 0) {
    return { terms: [...new Set([name.toLowerCase(), ...declared])], source: "categories" };
  }
  const lines = body.split(/\r?\n/);
  const title = headings(lines).find((h) => h.level === 1)?.text ?? "";
  const fallback = [name.toLowerCase()];
  if (title.trim() !== "") fallback.push(title.trim().toLowerCase());
  return { terms: [...new Set(fallback)], source: "name-and-title" };
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/**
 * Case-insensitive, on WORD BOUNDARIES, against the WHOLE term — so "code"
 * matches the category `code` and not `decoded`. `\b` is no use here: the terms
 * carry `-` and `.` (`agent-systems`, `tom.quest`) and `\b` sits inside both.
 */
function termRegex(term) {
  return new RegExp(`(?<![A-Za-z0-9])${term.replace(ESCAPE, "\\$&")}(?![A-Za-z0-9])`, "i");
}

export function matchesTerm(text, term) {
  if (term === "") return false;
  return termRegex(term).test(String(text ?? ""));
}

function matchesAnyTerm(text, terms) {
  return terms.some((term) => matchesTerm(text, term));
}

// ── Byte helpers ─────────────────────────────────────────────────────────────

const encoder = typeof TextEncoder === "undefined" ? null : new TextEncoder();

/** UTF-8 bytes, in the Convex runtime and on the box alike. */
export function byteLength(text) {
  const s = String(text ?? "");
  if (encoder !== null) return encoder.encode(s).length;
  return Buffer.byteLength(s, "utf8");
}

function thousands(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A fetchable line's size, rounded to the nearest 0.1 K (§9). */
function kilobytes(bytes) {
  return `${(bytes / 1024).toFixed(1)}K`;
}

// ── Page index ───────────────────────────────────────────────────────────────

/**
 * The stored pages as one lookup. `body` is the SOURCE text, frontmatter
 * included — which is what `ttsSkills.body` holds and what `git show` returns,
 * so the two sides index the same bytes.
 */
function indexPages(pages) {
  const byPath = new Map();
  for (const page of pages ?? []) {
    if (typeof page?.path !== "string" || typeof page?.body !== "string") {
      throw new ContextError("every page needs a path and a body");
    }
    byPath.set(page.path, page.body);
  }
  return byPath;
}

/** A know page's rendered body: area pages lose their frontmatter, exactly as
 * the prelude renders them, so an expanded page and a fetched one are equal. */
function renderedBody(path, source) {
  return isAreaPath(path) ? parseFrontmatter(source).body.trim() : String(source).trim();
}

/** The sections of a page, in page order, each with its heading and bytes. */
function pageSections(source) {
  const body = String(source ?? "").trim();
  const lines = body.split(/\r?\n/);
  return headings(lines)
    .filter((h) => h.level === 2)
    .map((h) => {
      const span = sectionSpan(lines, h.text);
      const text = lines.slice(span.start, span.end).join("\n").trim();
      return { heading: h.text, text, bytes: byteLength(text) };
    });
}

function sectionOf(source, heading) {
  const text = extractSections(String(source ?? "").trim(), [heading]);
  return text === "" ? null : { heading, text, bytes: byteLength(text) };
}

// ── The relevance table ──────────────────────────────────────────────────────
//
//  #  input signal                                   what expands
//  1  todo.category equals an area page's name       that area page
//  2  todo.category is in a page's categories: list  those area pages
//  3  batch                                          its todos' areas by 1–2
//  4  area:<name>                                    that page
//  5  repo:<name>                                    areas naming the repo
//  6  an area was expanded by 1–5                    intent.md sections that
//                                                    match the area's terms
//  7  the caller may judge or capture for him        a priorities.md section
//  8  a dated todo                                   the schedule.md § Week
//                                                    bullets for its weekday
//  9  path tokens in the brief, or repo:<n>:<paths>  the repo's AGENTS.md files
// 10  the todo, and its batch                        his rulings on them
// 11  the run's repo(s) or batch                     the last session outcomes
// 12  laptop, or no subject                          nothing

/** Rules 1–2, for one category string, over every area page. */
function areasForCategory(areaPages, category) {
  const wanted = String(category ?? "").trim();
  if (wanted === "") return [];
  const hits = [];
  for (const page of areaPages) {
    const { terms, source } = areaMatchTerms(page);
    const name = areaName(page.path);
    if (name.toLowerCase() === wanted.toLowerCase()) {
      hits.push({ page, name, terms, termSource: source, exact: true, hitCount: 1 });
      continue;
    }
    const matched = terms.filter((term) => matchesTerm(wanted, term));
    if (matched.length > 0) {
      hits.push({ page, name, terms, termSource: source, exact: false, hitCount: matched.length });
    }
  }
  return hits;
}

/** Exact match beats term match; then hit count desc; then area name asc. A
 * total order, so no two runs with the same input can order these differently. */
function byAreaRank(a, b) {
  if (a.exact !== b.exact) return a.exact ? -1 : 1;
  if (a.hitCount !== b.hitCount) return b.hitCount - a.hitCount;
  return a.name.localeCompare(b.name);
}

/** Rule 3: a batch's areas, ordered by how many of its todos want each. */
function areasForBatch(areaPages, categories) {
  const byName = new Map();
  for (const category of categories) {
    for (const hit of areasForCategory(areaPages, category)) {
      const seen = byName.get(hit.name);
      if (seen === undefined) byName.set(hit.name, { ...hit, todoCount: 1 });
      else {
        seen.todoCount += 1;
        seen.exact = seen.exact || hit.exact;
        seen.hitCount = Math.max(seen.hitCount, hit.hitCount);
      }
    }
  }
  return [...byName.values()].sort((a, b) => {
    if (a.todoCount !== b.todoCount) return b.todoCount - a.todoCount;
    return a.name.localeCompare(b.name);
  });
}

/** Rule 5: the areas whose terms name this repo. */
function areasForRepo(areaPages, repo) {
  return areasForCategory(areaPages, repo).sort(byAreaRank);
}

// ── Rule 8, the schedule ─────────────────────────────────────────────────────

const DAY_NAMES = Object.freeze([
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
]);

/**
 * The weekday of a YYYY-MM-DD calendar day. THE DAY KEY, not an instant: the
 * caller reduces `dueAt` to a New-York calendar day (convex/ttsShared
 * nyCalendarDayKey) and passes the ten characters, because the New-York offset
 * is a DST question this file must not answer a second time.
 */
export function weekdayOfDay(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return DAY_NAMES[new Date(ms).getUTCDay()];
}

/** The top-level bullets of a section, each with its continuation lines. */
function bulletsOf(sectionText) {
  const lines = String(sectionText ?? "").split(/\r?\n/);
  const out = [];
  let current = null;
  for (const line of lines) {
    if (/^ {0,3}[-*+][ \t]/.test(line)) {
      current = { lines: [line] };
      out.push(current);
      continue;
    }
    if (current !== null && line.trim() !== "" && /^\s/.test(line)) current.lines.push(line);
    else current = null;
  }
  return out.map((bullet) => bullet.lines.join("\n"));
}

/** The day name a bullet leads with, or null. */
function bulletDay(bullet) {
  const first = bullet.split("\n")[0].replace(/^ {0,3}[-*+][ \t]+/, "").trim();
  return DAY_NAMES.find((day) => matchesTerm(first.slice(0, day.length + 2), day)) ?? null;
}

// ── Selection ────────────────────────────────────────────────────────────────

function todoOf(record, id) {
  const todo = (record?.todos ?? []).find((row) => row.id === id);
  if (todo === undefined) throw new ContextError(`todo ${id} is not in the record`);
  return todo;
}

function batchOf(record, id) {
  const batch = (record?.batches ?? []).find((row) => row.id === id);
  if (batch === undefined) throw new ContextError(`batch ${id} is not in the record`);
  return batch;
}

/** The days a dated todo still owes: its own, and every date outcome ahead. */
function dueDays(todo, today) {
  const days = [];
  if (todo.timingClass === "dated" && typeof todo.dueDay === "string") days.push(todo.dueDay);
  for (const outcome of todo.dateOutcomes ?? []) {
    if (typeof outcome?.dueDay === "string" && outcome.dueDay >= String(today ?? "")) days.push(outcome.dueDay);
  }
  return [...new Set(days)].sort();
}

const PATH_TOKEN = /(?<![\w./-])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]*)/g;

/**
 * Rule 9's path tokens, taken from prose written for Tom. Backticks and fenced
 * blocks count the same as running text — the brief is not a machine format,
 * and pretending otherwise loses the paths it names.
 */
export function pathTokens(text) {
  const out = [];
  for (const match of String(text ?? "").matchAll(PATH_TOKEN)) out.push(match[1]);
  return [...new Set(out)];
}

/** The deepest published AGENTS.md whose directory is a prefix of `token`. */
function rulesForToken(rules, token) {
  const directory = token.includes("/") ? token.slice(0, token.lastIndexOf("/")) : "";
  let best = null;
  for (const rule of rules) {
    const ruleDir = rule.path === "AGENTS.md" ? "" : rule.path.slice(0, rule.path.lastIndexOf("/"));
    if (ruleDir !== "" && directory !== ruleDir && !directory.startsWith(`${ruleDir}/`)) continue;
    if (best === null || ruleDir.length > best.dir.length) best = { rule, dir: ruleDir };
  }
  return best?.rule ?? null;
}

function depthOf(path) {
  return path.split("/").length - 1;
}

const EMPTY_CHOICE = () => ({
  areas: [], intent: [], priorities: null, schedule: [],
  agents: [], rulings: [], outcomes: [],
});

/**
 * THE SELECTION. Returns the items each rule wants, at their per-rule caps and
 * before the global expand budget is applied.
 */
function select(input) {
  const { subject, caller, pages, repoRules = [], record = {} } = input;
  const rules = callerRules(caller);
  const byPath = indexPages(pages);
  const areaPages = [...byPath.keys()]
    .filter(isAreaPath)
    .sort()
    .map((path) => ({ path, body: byPath.get(path) }));

  const chosen = EMPTY_CHOICE();
  const notes = [];
  let category = null;
  let areaHits = [];
  let repos = [];
  let tokens = [];
  let todo = null;
  let batch = null;

  if (subject.kind === "todo") {
    todo = todoOf(record, subject.todoId);
    category = todo.category ?? "";
    areaHits = areasForCategory(areaPages, category).sort(byAreaRank);
    batch = todo.batchId === undefined ? null : (record.batches ?? []).find((row) => row.id === todo.batchId) ?? null;
    repos = batch?.repos ?? todo.repos ?? [];
    tokens = pathTokens(`${todo.brief ?? ""}\n${todo.workDescription ?? ""}\n${todo.entryAction ?? ""}`);
  } else if (subject.kind === "batch") {
    batch = batchOf(record, subject.batchId);
    const members = (record.todos ?? []).filter((row) => row.batchId === batch.id);
    areaHits = areasForBatch(areaPages, members.map((row) => row.category ?? ""));
    repos = batch.repos ?? [];
    tokens = pathTokens(members.map((row) => `${row.brief ?? ""}\n${row.workDescription ?? ""}\n${row.entryAction ?? ""}`).join("\n"));
  } else if (subject.kind === "area") {
    const page = areaPages.find((candidate) => areaName(candidate.path) === subject.area);
    // A run that thinks it saw the relevant area and saw nothing is worse than
    // a run that stops.
    if (page === undefined) throw new ContextError(`no area page named ${subject.area}`);
    const terms = areaMatchTerms(page);
    areaHits = [{ page, name: subject.area, exact: true, hitCount: 1, terms: terms.terms, termSource: terms.source }];
  } else if (subject.kind === "repo") {
    areaHits = areasForRepo(areaPages, subject.repo);
    repos = [subject.repo];
    tokens = subject.paths ?? [];
  }

  // Rules 1–5: the area pages, at 2 pages / 4,096 B (1 for `area:`).
  const areaCap = subject.kind === "area" ? 1 : CAPS.areaPages;
  let areaBytes = 0;
  for (const hit of areaHits) {
    if (chosen.areas.length >= areaCap) break;
    const text = renderedBody(hit.page.path, hit.page.body);
    const bytes = byteLength(text);
    if (chosen.areas.length > 0 && areaBytes + bytes > CAPS.areaBytes) break;
    chosen.areas.push({ ...hit, path: hit.page.path, text, bytes });
    areaBytes += bytes;
  }
  const fallbackAreas = chosen.areas.filter((area) => area.termSource === "name-and-title").map((area) => area.name);
  if (fallbackAreas.length > 0) {
    notes.push(`matched on file name and title, no categories: frontmatter on ${fallbackAreas.join(", ")}`);
  }
  if (category !== null && chosen.areas.length === 0) {
    notes.push(`nothing matched category "${category}"`);
  }

  // Rule 6: the intent.md sections holding a line that matches an expanded
  // area's terms, hit count desc then page order.
  const intentSource = byPath.get(INTENT_PATH);
  if (intentSource !== undefined && chosen.areas.length > 0) {
    const terms = [...new Set(chosen.areas.flatMap((area) => area.terms))];
    const ranked = pageSections(renderedBody(INTENT_PATH, intentSource))
      .map((section, order) => ({
        ...section,
        order,
        hitCount: section.text.split(/\r?\n/).filter((line) => matchesAnyTerm(line, terms)).length,
      }))
      .filter((section) => section.hitCount > 0)
      .sort((a, b) => (a.hitCount !== b.hitCount ? b.hitCount - a.hitCount : a.order - b.order));
    let intentBytes = 0;
    for (const section of ranked) {
      if (chosen.intent.length >= CAPS.intentSections) break;
      if (chosen.intent.length > 0 && intentBytes + section.bytes > CAPS.intentBytes) break;
      chosen.intent.push({ path: INTENT_PATH, ...section });
      intentBytes += section.bytes;
    }
  }

  // Rule 7: capture beats judge when a caller is both.
  const prioritiesSource = byPath.get(PRIORITIES_PATH);
  if (prioritiesSource !== undefined && (rules.captures || rules.judges)) {
    const heading = rules.captures ? CAPTURE_SECTION : CORRECTIONS_SECTION;
    const section = sectionOf(prioritiesSource, heading);
    if (section !== null && section.bytes <= CAPS.prioritiesBytes) {
      chosen.priorities = { path: PRIORITIES_PATH, ...section };
    }
  }

  // Rule 8: the § Week bullets for the weekdays this todo owes, earliest first.
  const scheduleSource = byPath.get(SCHEDULE_PATH);
  if (scheduleSource !== undefined && todo !== null) {
    const week = sectionOf(scheduleSource, WEEK_SECTION);
    if (week !== null) {
      const days = dueDays(todo, record.today);
      const bullets = bulletsOf(week.text).map((text) => ({ text, day: bulletDay(text) }));
      let scheduleBytes = 0;
      for (const day of days) {
        const weekday = weekdayOfDay(day);
        if (weekday === null) continue;
        for (const bullet of bullets.filter((candidate) => candidate.day === weekday)) {
          if (chosen.schedule.some((kept) => kept.text === bullet.text)) continue;
          const bytes = byteLength(bullet.text);
          if (scheduleBytes + bytes > CAPS.scheduleBytes) continue;
          chosen.schedule.push({ day, weekday, text: bullet.text, bytes });
          scheduleBytes += bytes;
        }
      }
    }
  }

  // Rule 9: the root AGENTS.md, plus the deepest one over each path token.
  // Depth desc then path asc, and the root is never dropped by the ordering.
  const runRepos = [...new Set(repos.filter((repo) => typeof repo === "string" && repo !== ""))].sort();
  const availableRules = repoRules.filter((rule) => runRepos.includes(rule.repo));
  // The root goes when the brief named a path, and also when the RUN'S SUBJECT
  // IS THE REPO — a `repo:` run has no brief to name paths in, and the repo's
  // own root rules are the least surprising thing it could be handed.
  if (availableRules.length > 0 && (tokens.length > 0 || subject.kind === "repo")) {
    const primary = runRepos.find((repo) => availableRules.some((rule) => rule.repo === repo && rule.path === "AGENTS.md"));
    const root = availableRules.find((rule) => rule.repo === primary && rule.path === "AGENTS.md");
    const matched = new Map();
    for (const token of tokens) {
      for (const repo of runRepos) {
        const forRepo = availableRules.filter((rule) => rule.repo === repo);
        const first = token.split("/")[0];
        if (!forRepo.some((rule) => rule.path.split("/")[0] === first)) continue;
        const rule = rulesForToken(forRepo, token);
        if (rule !== null && rule.path !== "AGENTS.md") matched.set(`${rule.repo}:${rule.path}`, rule);
      }
    }
    const ordered = [...matched.values()].sort((a, b) => {
      const depth = depthOf(b.path) - depthOf(a.path);
      return depth !== 0 ? depth : a.path.localeCompare(b.path);
    });
    let agentsBytes = 0;
    const push = (rule) => {
      if (rule === undefined || chosen.agents.length >= CAPS.agentsFiles) return;
      const bytes = byteLength(rule.body.trim());
      if (chosen.agents.length > 0 && agentsBytes + bytes > CAPS.agentsBytes) return;
      chosen.agents.push({ repo: rule.repo, path: rule.path, text: rule.body.trim(), bytes });
      agentsBytes += bytes;
    };
    push(root);
    for (const rule of ordered) push(rule);
  }

  // Rule 10: his rulings on this todo and its batch, newest first, the todo's
  // own ahead of the batch's on a tie.
  const subjectIds = new Set();
  if (todo !== null) subjectIds.add(todo.id);
  if (batch !== null) subjectIds.add(batch.id);
  if (subjectIds.size > 0) {
    const relevant = (record.rulings ?? [])
      .filter((ruling) => subjectIds.has(ruling.todoId) || subjectIds.has(ruling.batchId))
      .map((ruling) => ({
        ...ruling,
        own: todo !== null && ruling.todoId === todo.id,
        text: `${ruling.ruledDay} ${ruling.verdict}${ruling.sentence ? `: ${ruling.sentence}` : ""}`,
      }))
      .sort((a, b) => {
        if (a.ruledAt !== b.ruledAt) return b.ruledAt - a.ruledAt;
        if (a.own !== b.own) return a.own ? -1 : 1;
        return String(a.text).localeCompare(String(b.text));
      });
    let rulingBytes = 0;
    for (const ruling of relevant) {
      if (chosen.rulings.length >= CAPS.rulings) break;
      const bytes = byteLength(ruling.text);
      if (rulingBytes + bytes > CAPS.rulingsBytes) break;
      chosen.rulings.push({ text: ruling.text, bytes, own: ruling.own });
      rulingBytes += bytes;
    }
  }

  // Rule 11: the last outcomes on this batch or these repos, batch first.
  if (batch !== null || runRepos.length > 0) {
    const relevant = (record.sessions ?? [])
      .map((session) => ({
        ...session,
        onBatch: batch !== null && session.batchId === batch.id,
        onRepo: (session.repos ?? []).some((repo) => runRepos.includes(repo)),
        text: `${session.endedDay} ${session.outcome} ${session.outcomeSummary ?? ""}`.trim(),
      }))
      .filter((session) => session.onBatch || session.onRepo)
      .sort((a, b) => {
        if (a.onBatch !== b.onBatch) return a.onBatch ? -1 : 1;
        if (a.statusChangedAt !== b.statusChangedAt) return b.statusChangedAt - a.statusChangedAt;
        return String(a.text).localeCompare(String(b.text));
      });
    let outcomeBytes = 0;
    for (const session of relevant) {
      if (chosen.outcomes.length >= CAPS.outcomes) break;
      const bytes = byteLength(session.text);
      if (outcomeBytes + bytes > CAPS.outcomesBytes) break;
      chosen.outcomes.push({ text: session.text, bytes });
      outcomeBytes += bytes;
    }
  }

  // The one supplemental this assembler knows about: a brief too long to ride
  // the prompt whole. The prompt builders cut it at the same cap through
  // briefForPrompt, so the text that was cut and this line agree.
  const supplemental = [];
  if (todo !== null && typeof todo.brief === "string" && byteLength(todo.brief) > SUPPLEMENTAL_CAPS.brief) {
    supplemental.push({
      what: "this todo's full brief, truncated above",
      bytes: byteLength(todo.brief),
      how: BRIEF_SOURCE,
      truncated: true,
    });
  }

  return { chosen, notes, category, byPath, repoRules, runRepos, supplemental };
}

// ── The shrink orders ────────────────────────────────────────────────────────

/**
 * Applied in order until part 4 is under EXPAND_BUDGET. EVERY DROPPED ITEM
 * MOVES INTO FETCHABLE, so nothing becomes unknown — that is the whole
 * arrangement, and a step that merely deleted an item would break it.
 *
 * The order, and why each sits where it does: outcomes are the most replaceable
 * (one `tts-search sessions --repo X` gets them all); rulings on the batch are
 * one command away; repo rules sit in the checkout the session already has; the
 * second area is by construction the weaker match; and THE FIRST AREA PAGE IS
 * NEVER DROPPED, because it is the point of the mechanism — an area page that
 * alone exceeds the budget keeps its "Current state" section instead.
 */
const EXPAND_SHRINK = [
  { name: "outcomes to 1", apply: (c) => { c.outcomes = c.outcomes.slice(0, 1); } },
  { name: "outcomes to 0", apply: (c) => { c.outcomes = []; } },
  { name: "rulings to 3", apply: (c) => { c.rulings = c.rulings.slice(0, 3); } },
  { name: "rulings to the todo's own", apply: (c) => { c.rulings = c.rulings.filter((r) => r.own); } },
  {
    name: "AGENTS.md to root and the deepest",
    apply: (c) => {
      const root = c.agents.filter((a) => a.path === "AGENTS.md");
      const rest = c.agents.filter((a) => a.path !== "AGENTS.md").slice(0, 1);
      c.agents = [...root, ...rest];
    },
  },
  { name: "the second area page", apply: (c) => { c.areas = c.areas.slice(0, 1); } },
  { name: "the second intent section", apply: (c) => { c.intent = c.intent.slice(0, 1); } },
  {
    name: "schedule to the earliest day",
    apply: (c) => {
      const earliest = c.schedule[0]?.day;
      c.schedule = c.schedule.filter((bullet) => bullet.day === earliest);
    },
  },
  {
    name: "the first area page to its Current state",
    apply: (c) => {
      c.areas = c.areas.map((area) => {
        const current = extractSections(area.text, ["Current state"]);
        if (current === "" || current === area.text) return area;
        return { ...area, text: current, bytes: byteLength(current), reduced: true };
      });
    },
  },
];

// ── Rendering ────────────────────────────────────────────────────────────────

const SEP = (label) => `── ${label} ──`;

function block(label, text) {
  return `${SEP(label)}\n${text}`;
}

function areaLabel(area) {
  return area.reduced ? `${area.path} § Current state` : area.path;
}

function expandedBlocks(chosen) {
  const blocks = [];
  for (const area of chosen.areas) blocks.push(block(areaLabel(area), area.text));
  for (const section of chosen.intent) blocks.push(block(`${section.path} § ${section.heading}`, section.text));
  if (chosen.priorities !== null) {
    blocks.push(block(`${chosen.priorities.path} § ${chosen.priorities.heading}`, chosen.priorities.text));
  }
  if (chosen.schedule.length > 0) {
    blocks.push(block(`${SCHEDULE_PATH} § ${WEEK_SECTION}`, chosen.schedule.map((b) => b.text).join("\n")));
  }
  for (const rules of chosen.agents) blocks.push(block(rules.path, rules.text));
  if (chosen.rulings.length > 0) {
    blocks.push(block("his rulings on this subject", chosen.rulings.map((r) => r.text).join("\n")));
  }
  if (chosen.outcomes.length > 0) {
    blocks.push(block("recent session outcomes", chosen.outcomes.map((o) => o.text).join("\n")));
  }
  return blocks.join("\n\n");
}

/** Header line 2 names EVERY expanded path and section with its bytes: this is
 * the line a transcript reader scans to see what the run was given. */
function expandedManifestLines(chosen) {
  const parts = [];
  for (const area of chosen.areas) parts.push(`${areaLabel(area)} ${thousands(area.bytes)} B`);
  for (const section of chosen.intent) {
    parts.push(`${section.path} § ${section.heading} ${thousands(section.bytes)} B`);
  }
  if (chosen.priorities !== null) {
    parts.push(`${chosen.priorities.path} § ${chosen.priorities.heading} ${thousands(chosen.priorities.bytes)} B`);
  }
  if (chosen.schedule.length > 0) {
    const bytes = chosen.schedule.reduce((sum, bullet) => sum + bullet.bytes, 0);
    const days = [...new Set(chosen.schedule.map((bullet) => bullet.weekday))].join(", ");
    parts.push(`${SCHEDULE_PATH} § ${WEEK_SECTION} (${days}) ${thousands(bytes)} B`);
  }
  for (const rules of chosen.agents) parts.push(`${rules.path} ${thousands(rules.bytes)} B`);
  if (chosen.rulings.length > 0) {
    const bytes = chosen.rulings.reduce((sum, r) => sum + r.bytes, 0);
    parts.push(`${chosen.rulings.length} ruling${chosen.rulings.length === 1 ? "" : "s"} ${thousands(bytes)} B`);
  }
  if (chosen.outcomes.length > 0) {
    const bytes = chosen.outcomes.reduce((sum, o) => sum + o.bytes, 0);
    parts.push(`${chosen.outcomes.length} session outcome${chosen.outcomes.length === 1 ? "" : "s"} ${thousands(bytes)} B`);
  }
  return parts;
}

/** The manifest the evals hook stores (schema: claudeSessions.contextExpanded). */
function manifestOf(chosen) {
  const out = [];
  for (const area of chosen.areas) {
    out.push(`areas/${areaName(area.path)}${area.reduced ? "#Current state" : ""}`);
  }
  for (const section of chosen.intent) out.push(`intent#${section.heading}`);
  if (chosen.priorities !== null) out.push(`priorities#${chosen.priorities.heading}`);
  for (const weekday of [...new Set(chosen.schedule.map((b) => b.weekday))]) out.push(`schedule#Week ${weekday}`);
  for (const rules of chosen.agents) out.push(`${rules.repo}:${rules.path}`);
  if (chosen.rulings.length > 0) out.push(`rulings:${chosen.rulings.length}`);
  if (chosen.outcomes.length > 0) out.push(`outcomes:${chosen.outcomes.length}`);
  return out;
}

function subjectLabel(subject, category, notes) {
  const base = (() => {
    if (subject.kind === "todo") {
      return category ? `for todo ${subject.todoId}, category "${category}"` : `for todo ${subject.todoId}`;
    }
    if (subject.kind === "batch") return `for batch ${subject.batchId}`;
    if (subject.kind === "area") return `for area ${subject.area}`;
    if (subject.kind === "repo") {
      const paths = (subject.paths ?? []).length > 0 ? `, paths ${subject.paths.join(", ")}` : "";
      return `for repo ${subject.repo}${paths}`;
    }
    return "for no subject";
  })();
  return notes.length === 0 ? base : `${base}; ${notes.join("; ")}`;
}

// ── The fetchable block ──────────────────────────────────────────────────────
//
// One line per item, `- <what> (<size>) — <how>`, in this fixed order: layers,
// model-of-tom sections, area pages, evidence, repo rules, search questions,
// supplemental not attached. EVERY LINE NAMES either a shell command that works
// on the box and the laptop, or a path that exists in the checkout the run has.
// A line that names neither is a bug — the block's whole value is that
// following any line succeeds.

function layerBytes(byPath, name) {
  const definition = PRELUDE_LAYERS[name];
  const paths = [...definition.files.map((file) => file.path)];
  if (definition.areas !== undefined) paths.push(...[...byPath.keys()].filter(isAreaPath).sort());
  const rendered = paths
    .filter((path) => byPath.has(path))
    .map((path) => `${SEP(path)}\n${renderedBody(path, byPath.get(path))}`)
    .join("\n\n");
  return byteLength(rendered);
}

function fetchableItems(state, options) {
  const { chosen, byPath, repoRules, runRepos } = state;
  const items = [];

  // 1. Layers not sent whole.
  for (const name of PRELUDE_LAYER_NAMES) {
    if (options.stableLayers.includes(name)) continue;
    items.push({
      what: `${name} layer, whole`,
      bytes: layerBytes(byPath, name),
      how: `node scripts/prelude.mjs --wikitom $WIKITOM_DIR --layers ${name}`,
    });
  }

  // 2. The know pages' sections that were not expanded.
  //
  // `§ Week` IS NEVER TREATED AS EXPANDED, because rule 8 only ever takes the
  // bullets for one or two weekdays out of it — the other days went nowhere,
  // and a section half in the prompt and absent from the index is exactly the
  // unknown unknown this block exists to close.
  const expandedSections = new Set([
    ...chosen.intent.map((section) => `${section.path} ${section.heading}`),
    ...(chosen.priorities === null ? [] : [`${chosen.priorities.path} ${chosen.priorities.heading}`]),
  ]);
  for (const path of KNOW_FIXED) {
    const source = byPath.get(path);
    if (source === undefined) continue;
    for (const section of pageSections(renderedBody(path, source))) {
      if (expandedSections.has(`${path} ${section.heading}`)) continue;
      items.push({ what: `${path} § ${section.heading}`, bytes: section.bytes, how: "path", group: "sections" });
    }
  }

  // 3. The area pages not expanded — INCLUDING one the shrink order cut down to
  // its "Current state" section, whose rest went nowhere.
  const expandedAreas = new Set(chosen.areas.filter((area) => area.reduced !== true).map((area) => area.path));
  for (const path of [...byPath.keys()].filter(isAreaPath).sort()) {
    if (expandedAreas.has(path)) continue;
    const name = areaName(path);
    items.push({
      what: path,
      bytes: byteLength(renderedBody(path, byPath.get(path))),
      how: `${SEARCH_BINARY} areas ${name}`,
      group: "areas",
      name,
    });
  }

  // 4. Evidence, ONE line rather than fourteen: its shape is mechanical —
  // evidence/<the same path> for every page above — so one line states the
  // whole rule and costs 90 bytes instead of 1,100.
  items.push({
    what: "model-of-tom/evidence/",
    // `evidence`, not `sources`: sources searches WikiTom's raw material, and
    // the question this line answers is "where did THIS SENTENCE come from",
    // whose answer is one entry — the line and the said/paraphrase/read under
    // it — not a grep hit inside a paragraph.
    how: `the per-line evidence for every page above, same filename; grep it, or ${SEARCH_BINARY} evidence "<query>"`,
    group: "evidence",
  });

  // 5. The repo rules not expanded.
  const expandedRules = new Set(chosen.agents.map((rules) => `${rules.repo}:${rules.path}`));
  const listed = repoRules
    .filter((rule) => runRepos.length === 0 || runRepos.includes(rule.repo))
    .filter((rule) => !expandedRules.has(`${rule.repo}:${rule.path}`))
    .sort((a, b) => (a.repo === b.repo ? a.path.localeCompare(b.path) : a.repo.localeCompare(b.repo)));
  for (const rule of listed) {
    items.push({
      what: runRepos.length === 1 ? rule.path : `${rule.repo} ${rule.path}`,
      bytes: byteLength(rule.body.trim()),
      how: "path in the checkout",
      group: "repoRules",
    });
  }

  // 6. The eight search questions, each on its own line even though --help
  // would print them: the point of the block is that the run never has to know
  // to ask. `evidence` is not among them because item 4 above already names it
  // on the line it belongs to.
  for (const question of SEARCH_QUESTIONS) items.push({ what: question.what, how: question.how, group: "search" });

  // 7. Supplemental that did not ride whole.
  for (const supplemental of [...(state.supplemental ?? []), ...(options.supplemental ?? [])]) {
    if (supplemental.truncated !== true) continue;
    items.push({ what: supplemental.what, bytes: supplemental.bytes, how: supplemental.how });
  }
  return items;
}

function renderFetchableLines(items, sizes) {
  return items.map((item) => {
    const size = sizes && typeof item.bytes === "number" ? ` (${kilobytes(item.bytes)})` : "";
    return `- ${item.what}${size} — ${item.how}`;
  });
}

/**
 * Applied in order until part 6 is under FETCHABLE_BUDGET.
 *
 * Step 2 of §6 ("collapse the eight evidence/ mirrors to one line") is ALREADY
 * TRUE at step 0 — the block never writes more than one evidence line — so it
 * is recorded here as applied rather than dropped, and a last step collapsing
 * the unexpanded sections guarantees the budget is reachable however many area
 * pages and sections a WikiTom commit grows.
 */
function shrinkFetchable(items) {
  const applied = [];
  let sizes = true;
  let list = items;
  const done = () => byteLength(renderFetchableLines(list, sizes).join("\n")) <= FETCHABLE_BUDGET;
  const out = () => ({ lines: renderFetchableLines(list, sizes), applied });
  if (done()) return out();

  sizes = false;
  applied.push("sizes dropped");
  if (done()) return out();

  applied.push("evidence already one line");

  if (list.filter((item) => item.group === "search").length > 1) {
    list = [
      ...list.filter((item) => item.group !== "search"),
      { what: "seven read-only search questions", how: `${SEARCH_BINARY} --help`, group: "search" },
    ];
    applied.push("search questions collapsed");
    if (done()) return out();
  }

  const areaLines = list.filter((item) => item.group === "areas");
  if (areaLines.length > 1) {
    const names = areaLines.map((item) => item.name).join(", ");
    list = [
      ...list.filter((item) => item.group !== "areas"),
      { what: `the other area pages (${names})`, how: `${SEARCH_BINARY} areas <name>`, group: "areas" },
    ];
    applied.push("area pages collapsed");
    if (done()) return out();
  }

  const sectionLines = list.filter((item) => item.group === "sections");
  if (sectionLines.length > 1) {
    const paths = [...new Set(sectionLines.map((item) => item.what.split(" § ")[0]))].join(", ");
    list = [
      ...list.filter((item) => item.group !== "sections"),
      { what: `the unexpanded sections of ${paths}`, how: "path", group: "sections" },
    ];
    applied.push("sections collapsed");
  }
  return out();
}

// ── The one entry point ──────────────────────────────────────────────────────

/**
 * Parts 4 and 6, and the two header lines that open them.
 *
 * @param {{
 *   subject: object,
 *   caller: string,
 *   pages: {path: string, body: string}[],
 *   repoRules?: {repo: string, path: string, body: string}[],
 *   record?: object,
 *   stableLayers?: string[],
 *   supplemental?: {what: string, bytes?: number, how: string, truncated?: boolean}[],
 * }} input
 */
export function assembleContextParts(input) {
  const subject = input.subject ?? { kind: "none" };
  const stableLayers = input.stableLayers ?? ["operate"];

  // Rule 12: laptop and a caller with no subject expand nothing at all. The
  // fetchable block still lists everything, which is the whole of what those
  // callers get out of the know layer.
  const expandsNothing = subject.kind === "laptop" || subject.kind === "none";
  const state = expandsNothing
    ? {
      chosen: EMPTY_CHOICE(),
      notes: [],
      category: null,
      byPath: indexPages(input.pages),
      repoRules: input.repoRules ?? [],
      runRepos: [],
      supplemental: [],
    }
    : select({ ...input, subject });

  const dropped = [];
  if (!expandsNothing) {
    for (const step of EXPAND_SHRINK) {
      if (byteLength(expandedBlocks(state.chosen)) <= EXPAND_BUDGET) break;
      const before = JSON.stringify(manifestOf(state.chosen));
      step.apply(state.chosen);
      dropped.push(JSON.stringify(manifestOf(state.chosen)) === before ? `${step.name} (nothing to drop)` : step.name);
    }
  }

  const body = expandedBlocks(state.chosen);
  const parts = expandedManifestLines(state.chosen);
  const label = subjectLabel(subject, state.category, state.notes);
  const header2 = `MODEL-OF-TOM EXPANDED (${label}): ${parts.length === 0 ? "nothing" : parts.join(", ")} — ${thousands(byteLength(body))} B`;
  const expanded = expandsNothing ? "" : (body === "" ? header2 : `${header2}\n\n${body}`);

  const items = fetchableItems(state, { ...input, stableLayers });
  const { lines, applied } = shrinkFetchable(items);
  const fetchable = `MODEL-OF-TOM FETCHABLE (${lines.length} item${lines.length === 1 ? "" : "s"} not in this prompt):\n${lines.join("\n")}`;

  return {
    expanded,
    fetchable,
    manifest: manifestOf(state.chosen),
    notes: state.notes,
    bytes: { expanded: byteLength(expanded), expandedBody: byteLength(body), fetchable: byteLength(fetchable) },
    shrink: { expand: dropped, fetchable: applied },
  };
}

/**
 * A brief or a forked transcript, cut to its cap. THE BRIEF keeps its head and
 * stops at the last heading before the cap, because a brief reads forward; THE
 * TRANSCRIPT keeps its LAST bytes, because a session's end is where it was
 * going. Both say where the rest is.
 */
export function truncateSupplemental(text, cap, { keep = "head", where }) {
  const source = String(text ?? "");
  const bytes = byteLength(source);
  if (bytes <= cap) return { text: source, truncated: false, bytes };
  const note = `… (fetch the rest: ${where})`;
  if (keep === "tail") {
    let tail = source;
    while (byteLength(`${note}\n${tail}`) > cap && tail.length > 0) {
      tail = tail.slice(Math.max(1, Math.ceil(tail.length / 32)));
    }
    return { text: `${note}\n${tail}`, truncated: true, bytes };
  }
  const lines = source.split(/\r?\n/);
  const render = (kept) => `${lines.slice(0, kept).join("\n").trimEnd()}\n${note}`;
  // The most lines that still fit, by bisection — then snapped BACK to the
  // last heading boundary inside that, so the cut lands between sections
  // rather than mid-thought.
  let low = 1;
  let high = lines.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(render(middle)) <= cap) low = middle;
    else high = middle - 1;
  }
  // A heading at line 0 is the page's own title and heads everything, so
  // snapping to it would leave nothing at all — only a LATER heading is a
  // boundary worth taking.
  const boundary = headings(lines).map((h) => h.index).filter((index) => index > 0 && index <= low).pop();
  return { text: render(boundary ?? low), truncated: true, bytes };
}
