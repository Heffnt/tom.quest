// THE ONE HOME for deciding WHICH SKILLS a run is granted.
//
// This is the routing half of worker/jobs/context-relevance.mjs, MOVED rather
// than rewritten. The rules that decide what bears on a run's subject did not
// change when the know layer became a skill catalog; only the OUTPUT changed.
// context-relevance answered "which bytes of which page ride the prompt"; this
// answers "which skill names the prompt says the run may load", and the run
// loads the body itself, once, only if it needs it.
//
// So every matcher below — the area terms, the word-boundary match, the
// category and batch rankings, the path tokens — is the same code that chose
// the expanded block, with one correction noted at areaTermsFor.
//
// NO MODEL CALL ANYWHERE, and no I/O. Same input, byte-identical output: the
// grant block sits inside the cached prefix of every prompt that carries it, so
// a router that ordered its output differently on two runs would cost a cache
// miss on every one of them.
//
// THIS FILE IS PURE. convex/ttsContext.ts reaches it and the Convex bundler
// takes no node builtins — no node:fs, no node:path, no Buffer. The cwd
// comparison below is therefore string arithmetic, not path.relative, and that
// is deliberate rather than lazy.

import { headings, parseFrontmatter } from "./markdown-sections.mjs";
import { AREAS_DIR, areaCategories, areaName, isAreaPath, SKILL_PREFIX } from "../../scripts/skills.mjs";

/** Kept under the name context-relevance.mjs threw, because this class moved
 * out of that file along with the functions that throw it. */
export class ContextError extends Error {}

// ── Callers ──────────────────────────────────────────────────────────────────
// MOVED VERBATIM from context-relevance.mjs. The per-caller fixed layer table
// this replaced lived in five places: one all-three selection at
// convex/claudeSessions.ts insertSession and four ["write","know"] selections in
// convex/http.ts. Two rules stand in for all of them: WRITE GOES WHEN THE RUN'S
// OUTPUT REACHES TOM, and everything else comes from the subject.
//
// `judges` and `captures` were rule 7: a run that may judge on his behalf gets
// the corrections he has already made; a run that may capture for him gets the
// rule for what becomes a todo. Capture beats judge when a caller is both.
export const CONTEXT_CALLERS = Object.freeze({
  opener: Object.freeze({ reachesTom: true, judges: true, captures: false }),
  planner: Object.freeze({ reachesTom: true, judges: true, captures: false }),
  "capture-context": Object.freeze({ reachesTom: true, judges: false, captures: true }),
  "time-notes": Object.freeze({ reachesTom: true, judges: false, captures: false }),
  "batch-context": Object.freeze({ reachesTom: true, judges: true, captures: false }),
  "weekly-input": Object.freeze({ reachesTom: true, judges: true, captures: false }),
  // The weekly simplification pass (worker/jobs/simplify.mjs, through GET
  // /tts/simplify-input). Its OWN row rather than borrowing weekly-input's:
  // the two want the same three booleans today, and a caller that reads
  // another caller's row is a caller that changes silently when that one does.
  // `reachesTom` because the proposal sentences are written for him and post
  // to #tts-decisions; `judges` because judging what the fleet can lose is the
  // whole job; `captures` false because the pass files no todo — a LATER run
  // does, once the objection window has closed.
  "simplify-input": Object.freeze({ reachesTom: true, judges: true, captures: false }),
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

/**
 * The callers granted `know-intent` by name, beside the ones their row's
 * `judges` flag already grants it to.
 *
 * All four judge at this commit, so the list is redundant today. It is named
 * rather than folded into `judges` because the routing table states both
 * conditions, and a caller whose `judges` flag is later turned off is a caller
 * that would otherwise lose his intent silently.
 */
export const INTENT_CALLERS = Object.freeze(["opener", "planner", "prepare", "weekly-input"]);

/**
 * The callers granted `know-week`: the runs that read or write a date.
 *
 * THE DIGEST WRITER BELONGS IN THIS LIST AND IS NOT IN IT. The digest
 * (worker/jobs/write-slack.mjs) reaches context through a caller that has no
 * row of its own in CONTEXT_CALLERS at this commit, so there is no name to put
 * here. When it gets a row, its name goes in this array and nothing else
 * changes.
 */
export const WEEK_CALLERS = Object.freeze(["time-notes", "planner"]);

// ── Subjects ─────────────────────────────────────────────────────────────────

/**
 * MOVED VERBATIM. One subject SPEC — `todo:<id>`, `batch:<id>`,
 * `repo:<name>[:<paths>]`, `area:<name>`, `laptop`, `none` — parsed into the
 * object routeSkills takes. Nothing in this tree calls it today: every launcher
 * here already holds the subject as an object, and prelude.mjs's `--for`, which
 * took a spec, retired with the expansion. It stays because a launcher handed a
 * subject as text has nowhere else to turn it into one, and writing that parse
 * a second time is the drift this move exists to stop.
 *
 * A repo name may contain dots
 * (`tom.quest`), so the paths are split off at the SECOND colon, not by
 * splitting on every one.
 */
export function parseSubject(spec) {
  const text = String(spec ?? "").trim();
  if (text === "" || text === "none") return { kind: "none" };
  if (text === "laptop") return { kind: "laptop" };
  const colon = text.indexOf(":");
  if (colon === -1) throw new ContextError(`${text} is not a subject (todo:, batch:, repo:, area:, laptop)`);
  const kind = text.slice(0, colon);
  const rest = text.slice(colon + 1);
  if (rest.trim() === "") throw new ContextError(`subject ${kind}: needs a value`);
  if (kind === "todo") return { kind: "todo", todoId: rest.trim() };
  if (kind === "batch") return { kind: "batch", batchId: rest.trim() };
  if (kind === "area") return { kind: "area", area: rest.trim() };
  if (kind === "repo") {
    const second = rest.indexOf(":");
    if (second === -1) return { kind: "repo", repo: rest.trim(), paths: [] };
    const paths = rest.slice(second + 1).split(",").map((p) => p.trim()).filter(Boolean);
    return { kind: "repo", repo: rest.slice(0, second).trim(), paths };
  }
  throw new ContextError(`${kind}: is not a subject kind (todo, batch, repo, area, laptop)`);
}

/** MOVED VERBATIM. The subjects that cannot be resolved without a record row. */
export function subjectNeedsRecord(subject) {
  return subject.kind === "todo" || subject.kind === "batch";
}

// ── Match terms ──────────────────────────────────────────────────────────────

/**
 * THE ONE PLACE an area page becomes match terms.
 *
 * Each entry is `{ area, terms, source, page }`: the page's name, the terms a
 * category is matched against, where those terms came from, and the page itself
 * for a caller that wants its body.
 *
 * THE ONE CORRECTION to the moved code. context-relevance.mjs's areaMatchTerms
 * split the raw `categories:` value on commas alone, and `parseFrontmatter`
 * parses nothing inside a value — so `categories: [admin, email]` yielded the
 * terms `[admin` and `email]`, neither of which matches anything, and the FIRST
 * AND LAST category of every area page was dead. scripts/skills.mjs's
 * `areaCategories` strips the brackets, and it is already what the published
 * skill descriptions are written from, so the terms a run is routed by and the
 * terms its description advertises now come out of one function.
 *
 * THE FALLBACK IS THE MOVED CODE'S, unchanged: a page with no `categories:`
 * line matches on its own name plus its `# ` title, and says so through
 * `source`, because a silent fallback reads as a deliberate one-term list while
 * a stated one is a prompt to write the line.
 */
export function areaTermsFor(pages) {
  const out = [];
  for (const page of areaPagesOf(pages)) {
    const name = areaName(page.path);
    if (hasCategoriesLine(page.body)) {
      out.push({ area: name, terms: areaCategories(page.path, page.body), source: "categories", page });
      continue;
    }
    const { body } = parseFrontmatter(page.body);
    const lines = body.split(/\r?\n/);
    const title = headings(lines).find((h) => h.level === 1)?.text ?? "";
    const fallback = [name.toLowerCase()];
    if (title.trim() !== "") fallback.push(title.trim().toLowerCase());
    out.push({ area: name, terms: [...new Set(fallback)], source: "name-and-title", page });
  }
  return out;
}

/** Whether the page declares any category at all. `categories: []` declares
 * none, which is the fallback case and not a one-term list. */
function hasCategoriesLine(source) {
  const { fields } = parseFrontmatter(source);
  const raw = String(fields.categories ?? "")
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .trim();
  return raw !== "";
}

/** The area pages of a page list, in path order — the order every ranking below
 * falls back to, so two runs given the same pages rank them identically. */
function areaPagesOf(pages) {
  const seen = new Map();
  for (const page of pages ?? []) {
    if (typeof page?.path !== "string" || typeof page?.body !== "string") {
      throw new ContextError("every page needs a path and a body");
    }
    if (isAreaPath(page.path)) seen.set(page.path, page);
  }
  return [...seen.keys()].sort().map((path) => seen.get(path));
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/**
 * MOVED VERBATIM. Case-insensitive, on WORD BOUNDARIES, against the WHOLE term
 * — so "code" matches the category `code` and not `decoded`. `\b` is no use
 * here: the terms carry `-` and `.` (`agent-systems`, `tom.quest`) and `\b`
 * sits inside both.
 */
function termRegex(term) {
  return new RegExp(`(?<![A-Za-z0-9])${term.replace(ESCAPE, "\\$&")}(?![A-Za-z0-9])`, "i");
}

export function matchesTerm(text, term) {
  if (term === "") return false;
  return termRegex(term).test(String(text ?? ""));
}

// ── The rankings ─────────────────────────────────────────────────────────────

/** MOVED. One category string against every area page's terms. An exact name
 * match is its own kind of hit, ahead of any term match. */
export function areasForCategory(areaTerms, category) {
  const wanted = String(category ?? "").trim();
  if (wanted === "") return [];
  const hits = [];
  for (const entry of areaTerms) {
    if (entry.area.toLowerCase() === wanted.toLowerCase()) {
      hits.push({ ...entry, name: entry.area, exact: true, hitCount: 1 });
      continue;
    }
    const matched = entry.terms.filter((term) => matchesTerm(wanted, term));
    if (matched.length > 0) {
      hits.push({ ...entry, name: entry.area, exact: false, hitCount: matched.length });
    }
  }
  return hits;
}

/** MOVED VERBATIM. Exact match beats term match; then hit count desc; then area
 * name asc. A total order, so no two runs with the same input can order these
 * differently. */
export function byAreaRank(a, b) {
  if (a.exact !== b.exact) return a.exact ? -1 : 1;
  if (a.hitCount !== b.hitCount) return b.hitCount - a.hitCount;
  return a.name.localeCompare(b.name);
}

/** MOVED. A batch's areas, ordered by how many of its todos want each, then by
 * the same rank one todo's areas take. */
export function areasForBatch(areaTerms, categories) {
  const byName = new Map();
  for (const category of categories) {
    for (const hit of areasForCategory(areaTerms, category)) {
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

/**
 * MOVED. The areas whose terms name this repository.
 *
 * NOT WIRED INTO routeSkills at this commit: the routing table has no row that
 * turns a `repo:` subject into a `know-<area>` grant, and the router implements
 * the table and nothing past it. It moved with its siblings so the matching
 * half lives in one file, and so that row is one call if it is ever wanted.
 */
export function areasForRepo(areaTerms, repo) {
  return areasForCategory(areaTerms, repo).sort(byAreaRank);
}

// ── Path tokens ──────────────────────────────────────────────────────────────

const PATH_TOKEN = /(?<![\w./-])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]*)/g;

/**
 * MOVED VERBATIM. The path tokens of prose written for Tom. Backticks and
 * fenced blocks count the same as running text — the brief is not a machine
 * format, and pretending otherwise loses the paths it names.
 */
export function pathTokens(text) {
  const out = [];
  for (const match of String(text ?? "").matchAll(PATH_TOKEN)) out.push(match[1]);
  return [...new Set(out)];
}

// ── The record ───────────────────────────────────────────────────────────────

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

// ── The cwd rule ─────────────────────────────────────────────────────────────

/**
 * Whether `cwd` stands inside `dir`.
 *
 * STRING ARITHMETIC, NOT node:path, because this module is bundled into the
 * Convex runtime, which has no node builtins. Backslashes become slashes and a
 * trailing slash goes, so `C:\a\b\` and `C:/a/b` are one directory.
 *
 * THE COMPARISON IS CASE-INSENSITIVE EVERYWHERE, not only on Windows: the
 * platform this runs on is not knowable from a pure module, and the case it
 * gets wrong — two checkouts under paths that differ only in letter case — is
 * a situation nobody has and nobody wants.
 */
export function isInsideRepo(cwd, dir) {
  const inside = normalizeDir(cwd);
  const root = normalizeDir(dir);
  if (inside === "" || root === "") return false;
  return inside === root || inside.startsWith(`${root}/`);
}

function normalizeDir(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// ── The grant order ──────────────────────────────────────────────────────────

const GROUP_RANK = Object.freeze({ write: 0, know: 1, repo: 2 });

/** `write` first, then `know-*`, then `repo-*`, alphabetical inside each group.
 * The grant block sits in a cached prefix; this is what makes it stable. */
function byGrantOrder(a, b) {
  const rank = (name) => GROUP_RANK[String(name).split("-")[0]] ?? 3;
  const difference = rank(a) - rank(b);
  return difference !== 0 ? difference : String(a).localeCompare(String(b));
}

/** A published catalog as a set of BARE names. `tom-` is a directory-naming
 * fact only, so a caller that passes directory names gets the same answer as
 * one that passes skill names. */
function publishedSet(published) {
  if (published === null || published === undefined) return null;
  const names = published instanceof Set ? [...published] : [...(published ?? [])];
  return new Set(names.map(bareName));
}

function bareName(name) {
  const text = String(name ?? "");
  return text.startsWith(SKILL_PREFIX) ? text.slice(SKILL_PREFIX.length) : text;
}

/** The refusal a wanted name gets when the publication does not carry it. The
 * same sentence scripts/skills.mjs refuses a bodyless repository with, because
 * the two mean the same thing to the run that reads the line. */
export const NO_BODY = "no published body at this commit";

// ── The router ───────────────────────────────────────────────────────────────
//
// THE WHOLE TABLE, in the order it is applied:
//
//   reachesTom                                  write
//   area:<name>                                 know-<name>
//   todo whose category matches an area         know-<area>
//   batch, by its members' categories           know-<area>  ×≤2
//   judges, or an INTENT_CALLERS caller         know-intent
//   a WEEK_CALLERS caller                       know-week
//   the subject names paths in repo X and
//     cwd is not inside X's checkout            repo-X
//   cwd IS inside repo X                        nothing; repoRulesSource native
//   anything else                               nothing
//
// There is no row for the priorities page, the schedule bullets, his rulings or
// the recent session outcomes: those expanded RECORD rows, not the know layer,
// and they stay in context-relevance.mjs where the record is.

/**
 * How many `know-<area>` skills each subject kind may take.
 *
 * A TODO AND AN `area:` SUBJECT TAKE ONE. A todo has one category, and the
 * ranking below is a total order, so the one it takes is the one that fits
 * best. The second would be there only because the terms overlap — `health` is
 * a term of health-and-food and a substring boundary of the category
 * `mental-health`, so a todo in mental-health would otherwise carry his food
 * page too, every time.
 *
 * A BATCH TAKES TWO, because a batch aggregates its members' categories and two
 * areas is a real answer for one; the moved code's CAPS.areaPages, at its value.
 */
export const AREA_CAPS = Object.freeze({ todo: 1, batch: 2, area: 1 });

/**
 * WHICH SKILLS THIS RUN IS GRANTED.
 *
 * @param {{
 *   subject?: object,
 *   caller: string,
 *   pages?: {path: string, body: string}[],
 *   record?: object,
 *   cwd?: string | null,
 *   repoDirs?: Record<string, string>,
 *   published?: Set<string> | string[] | null,
 * }} input
 * @returns {{ granted: string[], refused: {name: string, why: string}[], repoRulesSource: "native" | null }}
 */
export function routeSkills(input) {
  const subject = input?.subject ?? { kind: "none" };
  const caller = input?.caller;
  const rules = callerRules(caller);
  const record = input?.record ?? {};
  const areaTerms = areaTermsFor(input?.pages ?? []);
  const catalog = publishedSet(input?.published);

  const wanted = [];

  // write ────────────────────────────────────────────────────────────────────
  if (rules.reachesTom) wanted.push("write");

  // know-<area> ──────────────────────────────────────────────────────────────
  let areaHits = [];
  const areaCap = AREA_CAPS[subject.kind] ?? 0;
  let repos = [];
  let tokens = [];

  if (subject.kind === "area") {
    const entry = areaTerms.find((candidate) => candidate.area === subject.area);
    // A run that thinks it saw the relevant area and saw nothing is worse than
    // a run that stops.
    if (entry === undefined) throw new ContextError(`no area page named ${subject.area}`);
    areaHits = [{ ...entry, name: entry.area, exact: true, hitCount: 1 }];
  } else if (subject.kind === "todo") {
    const todo = todoOf(record, subject.todoId);
    areaHits = areasForCategory(areaTerms, todo.category ?? "").sort(byAreaRank);
    const batch =
      todo.batchId === undefined ? null : (record.batches ?? []).find((row) => row.id === todo.batchId) ?? null;
    repos = batch?.repos ?? todo.repos ?? [];
    tokens = pathTokens(`${todo.brief ?? ""}\n${todo.workDescription ?? ""}\n${todo.entryAction ?? ""}`);
  } else if (subject.kind === "batch") {
    const batch = batchOf(record, subject.batchId);
    const members = (record.todos ?? []).filter((row) => row.batchId === batch.id);
    areaHits = areasForBatch(areaTerms, members.map((row) => row.category ?? ""));
    repos = batch.repos ?? [];
    tokens = pathTokens(
      members.map((row) => `${row.brief ?? ""}\n${row.workDescription ?? ""}\n${row.entryAction ?? ""}`).join("\n"),
    );
  } else if (subject.kind === "repo") {
    repos = [subject.repo];
    tokens = subject.paths ?? [];
  }

  for (const hit of areaHits.slice(0, areaCap)) wanted.push(`know-${hit.name}`);

  // know-intent ──────────────────────────────────────────────────────────────
  if (rules.judges || INTENT_CALLERS.includes(caller)) wanted.push("know-intent");

  // know-week ────────────────────────────────────────────────────────────────
  if (WEEK_CALLERS.includes(caller)) wanted.push("know-week");

  // repo-<name> ──────────────────────────────────────────────────────────────
  // The gate is the moved code's rule 9 gate: a brief that named a path, or a
  // subject that IS the repository, which has no brief to name paths in.
  const runRepos = [...new Set(repos.filter((repo) => typeof repo === "string" && repo !== ""))].sort();
  const repoDirs = input?.repoDirs ?? {};
  let repoRulesSource = null;
  if (tokens.length > 0 || subject.kind === "repo") {
    for (const repo of runRepos) {
      // A run standing in the checkout already has the rules on disk, at the
      // commit it is working on. Granting it last night's published copy is a
      // second answer to a question that has one.
      if (isInsideRepo(input?.cwd, repoDirs[repo])) {
        repoRulesSource = "native";
        continue;
      }
      wanted.push(`repo-${repo}`);
    }
  }

  // Publication ──────────────────────────────────────────────────────────────
  // A name the catalog does not carry is REFUSED, never fatal: WikiTom is Tom's
  // to edit, and a session that died because he emptied a page would be a worse
  // failure than a session told in one line that the page is not there.
  const granted = [];
  const refused = [];
  for (const name of [...new Set(wanted)]) {
    if (catalog === null || catalog.has(name)) granted.push(name);
    else refused.push({ name, why: NO_BODY });
  }
  granted.sort(byGrantOrder);
  refused.sort((a, b) => byGrantOrder(a.name, b.name));

  return { granted, refused, repoRulesSource };
}

/** Re-exported so a caller holding only this module can spell an area path.
 * One definition, in scripts/skills.mjs; these are names, not copies. */
export { AREAS_DIR, areaName, isAreaPath };
