// historyRows.ts — what the /history page draws, from rows of the events
// table, without the database: convex/history.ts reads the rows and hands
// them here, and the tests hand fixture rows the same way.
//
// THE KINDS THIS READS. His day's facts are the kinds the redesign's record
// gives the dump session (design of 2026-10-06, section 12.2): meal, weight,
// training and did, each one row with a time and the numbers a chart needs.
// What Jarvis did is every kind an agent or a job writes when it changes
// something. A kind with no rows yet is an empty series, never an error, so
// the page works before the dump session writes its first fact.
//
// THE FIELDS OF A FACT are shared/jarvis-events.mjs's (factProblem, tom.quest
// #374), and only those: no other spelling of a field is read, because the
// record's one write door refuses a fact row without them. Every fact names
// data.day, the New York day it belongs to, which may be earlier than `at`,
// when he said it; data.summary, a few words; and data.quote, his own words,
// when given. A row without a day or a summary cannot have come through that
// door and is not drawn. They are read in one place, so a renamed field is
// one edit here:
//   weight    metric "weight" (a "waist" row is not drawn), value, unit "lb"
//             (the validator's only unit for weight; a row in any other unit
//             is not drawn).
//   meal      summary, proteinG, calories.
//   training  summary, activity, bodyParts, durationMin, distanceMi. A row
//             with a metric is a timed or loaded test, not a session, and is
//             not counted in the weekly bars.
//   did       summary and quote.
// His sentences on a day are his thread messages and the issues he reported (an issue row with data.by "tom", whose text is his
// sentence), then each fact's quote (a did row's summary when it has none; the other
// kinds' summaries are not his words) that no sentence drawn that day holds.
// The facts he gave the day log before these kinds existed were copied in as
// rows of these kinds (convex/ttsMigrations.ts, October 6, 2026).
import type { Doc } from "./_generated/dataModel";
import { addDays, newYorkDay, newYorkInstant } from "../shared/clock.mjs";
import { SESSION_REPOS } from "../shared/session-constants.mjs";
import { boxChangeLines, type BoxChange } from "./boxChanges";

export const FACT_KINDS = { meal: "meal", weight: "weight", training: "training", did: "did" } as const;

/** Tom's own messages to Jarvis on the thread. */
export const MESSAGE_KIND = "thread-message";

/**
 * What Jarvis did: the kinds an agent or a job writes when it changes
 * something or acts in his name. The redesign's names (landed, deployed,
 * failed, notification, finding, eval-result) sit beside today's (merge,
 * deploy, job-failed, eval-run, ...), so the page reads both generations.
 * job-failed is read only where a failure opened (convex/history.ts), never
 * a standing condition's repeat.
 */
export const ACTION_KINDS = [
  "landed",
  "merge",
  "deployed",
  "deploy",
  "box-change",
  "work-run",
  "session-outcome",
  "thread-reply",
  "decision",
  "eval-result",
  "eval-run",
  "finding",
  "issue",
  "notification",
  "failed",
  "job-failed",
  "part-disabled",
  "learning-change",
  "repo-proposal-applied",
] as const;

export type Weight = { id: string; at: number; day: string; lb: number };
export type Meal = { id: string; at: number; day: string; text: string; proteinG?: number; calories?: number };
export type Training = {
  id: string;
  at: number;
  day: string;
  text: string;
  activity?: string;
  bodyParts: string[];
  durationMin?: number;
  distanceMi?: number;
};
export type Told = { id: string; at: number; day: string; text: string };
export type Action = { id: string; at: number; day: string; kind: string; text: string; href: string | null };

export type HistoryPage = {
  from: string;
  to: string;
  days: string[];
  weights: Weight[];
  meals: Meal[];
  trainings: Training[];
  told: Told[];
  actions: Action[];
  cuts: string[];
};

type Row = Pick<Doc<"events">, "_id" | "kind" | "at" | "provenance" | "subject" | "data" | "text">;
type Data = Record<string, unknown>;

export const MAX_RANGE_DAYS = 366;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function dataOf(row: { data?: unknown }): Data {
  return row.data !== null && typeof row.data === "object" && !Array.isArray(row.data) ? (row.data as Data) : {};
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function firstLine(text: string, limit = 240): string {
  const line = text.split("\n")[0]!.replace(/\s+/g, " ").trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`;
}

function lineOf(row: Row): string | undefined {
  const data = dataOf(row);
  return str(row.text) ?? str(data.text) ?? str(data.what) ?? str(data.summary);
}

function summaryOf(row: Row): string | undefined {
  return str(dataOf(row).summary);
}

/** How many days after a fact's day he may say it: the day log took a week back. */
export const FACT_LATE_DAYS = 8;

/** The day a fact belongs to, data.day; undefined for a row that names none. */
function factDay(row: Row): string | undefined {
  const day = dataOf(row).day;
  return typeof day === "string" && isDayKey(day) ? day : undefined;
}

function isDayKey(value: string): boolean {
  return DAY_KEY.test(value) && new Date(Date.parse(value)).toISOString().slice(0, 10) === value;
}

/** Every calendar day from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

/** The instants a day range covers on a New York clock: [start, end). */
export function rangeInstants(from: string, to: string): { start: number; end: number } {
  return { start: newYorkInstant(from, 0), end: newYorkInstant(addDays(to, 1), 0) };
}

/** The range asked for, checked; absent ends default to the four weeks ending today. */
export function rangeOf(args: { from?: string; to?: string }, now: number): { from: string; to: string } {
  const to = args.to ?? newYorkDay(now);
  const from = args.from ?? addDays(to, -27);
  if (!isDayKey(from) || !isDayKey(to)) throw new Error("from and to are calendar days, YYYY-MM-DD");
  if (from > to) throw new Error("from is on or before to");
  if (daysBetween(from, to).length > MAX_RANGE_DAYS) throw new Error(`a range is at most ${MAX_RANGE_DAYS} days`);
  return { from, to };
}

export function weightOf(row: Row): Weight | null {
  const data = dataOf(row);
  const day = factDay(row);
  const lb = num(data.value);
  if (day === undefined || summaryOf(row) === undefined || data.metric !== "weight" || data.unit !== "lb" || lb === undefined) return null;
  return { id: row._id, at: row.at, day, lb };
}

export function mealOf(row: Row): Meal | null {
  const data = dataOf(row);
  const day = factDay(row);
  const text = summaryOf(row);
  if (day === undefined || text === undefined) return null;
  const proteinG = num(data.proteinG);
  const calories = num(data.calories);
  return {
    id: row._id,
    at: row.at,
    day,
    text,
    ...(proteinG === undefined ? {} : { proteinG }),
    ...(calories === undefined ? {} : { calories }),
  };
}

export function trainingOf(row: Row): Training | null {
  const data = dataOf(row);
  const day = factDay(row);
  const text = summaryOf(row);
  if (day === undefined || text === undefined || data.metric !== undefined) return null;
  const bodyParts = Array.isArray(data.bodyParts) ? data.bodyParts.filter((part): part is string => typeof part === "string" && part !== "") : [];
  const activity = str(data.activity);
  const durationMin = num(data.durationMin);
  const distanceMi = num(data.distanceMi);
  return {
    id: row._id,
    at: row.at,
    day,
    text,
    bodyParts,
    ...(activity === undefined ? {} : { activity }),
    ...(durationMin === undefined ? {} : { durationMin }),
    ...(distanceMi === undefined ? {} : { distanceMi }),
  };
}

/** A sentence of his in a row's text: a thread message, or an issue he reported. */
export function toldOf(row: Row): Told | null {
  const text = str(row.text);
  return text === undefined ? null : { id: row._id, at: row.at, day: newYorkDay(row.at), text };
}

/** An issue row is his when he reported it (data.by "tom"), else Jarvis's. */
export function isHisIssue(row: Row): boolean {
  return row.kind === "issue" && dataOf(row).by === "tom";
}

/** A fact's own words: its quote; a did row with none, its summary, the only thing it holds. */
export function factToldOf(row: Row): Told | null {
  const day = factDay(row);
  const text = str(dataOf(row).quote) ?? (row.kind === FACT_KINDS.did ? summaryOf(row) : undefined);
  return day === undefined || text === undefined ? null : { id: row._id, at: row.at, day, text };
}

function repoSlug(repo: unknown): string | null {
  return typeof repo === "string" && Object.prototype.hasOwnProperty.call(SESSION_REPOS, repo)
    ? SESSION_REPOS[repo as keyof typeof SESSION_REPOS]
    : null;
}

function agentHref(row: Row): string | null {
  const agentId = row.provenance?.agentId;
  return agentId === undefined ? null : `/sessions?agent=${encodeURIComponent(agentId)}`;
}

/** One line for one row of what Jarvis did, and where it links. */
export function actionOf(row: Row): Action {
  const data = dataOf(row);
  const base = { id: row._id, at: row.at, day: newYorkDay(row.at), kind: row.kind };
  if (row.kind === "merge" || row.kind === "landed") {
    const slug = repoSlug(data.repo);
    const sha = str(data.sha);
    const pull = /pull request #(\d+)/.exec(str(data.mainCheck) ?? "")?.[1];
    const href = slug === null ? null : pull !== undefined ? `https://github.com/${slug}/pull/${pull}` : sha !== undefined ? `https://github.com/${slug}/commit/${sha}` : null;
    const what = str(data.subject) ?? lineOf(row) ?? sha?.slice(0, 7) ?? "a change";
    return { ...base, text: firstLine(`Landed in ${str(data.repo) ?? "a repository"}${pull === undefined ? "" : ` (#${pull})`}: ${what}`), href };
  }
  if (row.kind === "deploy" || row.kind === "deployed") {
    const slug = repoSlug(data.repo);
    const to = str(data.to) ?? str(data.sha);
    const from = str(data.from);
    const commits = Array.isArray(data.commits) ? data.commits.filter((c): c is string => typeof c === "string") : [];
    const href = slug === null || to === undefined ? null : from !== undefined ? `https://github.com/${slug}/compare/${from}...${to}` : `https://github.com/${slug}/commit/${to}`;
    const what = commits.length === 1 ? `: ${commits[0]}` : commits.length > 1 ? `, ${commits.length} commits` : "";
    return { ...base, text: firstLine(lineOf(row) ?? `Deployed ${str(data.repo) ?? "a repository"} ${to?.slice(0, 7) ?? ""}${what}`), href };
  }
  if (row.kind === "decision") {
    const text = str(data.decision) ? `Decided: ${str(data.decision)}` : lineOf(row) ?? "A decision";
    return { ...base, text: firstLine(text), href: agentHref(row) };
  }
  if (row.kind === "session-outcome") {
    const text = str(data.summary) ?? lineOf(row) ?? `A work-queue agent ${str(data.outcome) ?? "finished"}`;
    return { ...base, text: firstLine(text), href: agentHref(row) };
  }
  if (row.kind === "thread-reply") {
    return { ...base, text: firstLine(`Replied: ${lineOf(row) ?? ""}`), href: null };
  }
  if (row.kind === "job-failed" || row.kind === "failed") {
    const job = str(data.job) ?? row.provenance?.job;
    const text = lineOf(row) ?? str(data.error) ?? "failed";
    return { ...base, text: firstLine(job === undefined ? text : `${job} failed: ${text}`), href: agentHref(row) };
  }
  return { ...base, text: firstLine(lineOf(row) ?? str(data.decision) ?? row.kind), href: agentHref(row) };
}

/**
 * The box's machine changes of one day: one line per agent's root commands,
 * per deploy, per kind of state change, per login; never one per row, which
 * is up to hundreds a day.
 */
export function boxChangeActions(changes: Row[], deploys: Row[]): Action[] {
  const byDay = new Map<string, { changes: Row[]; deploys: Row[] }>();
  const slot = (day: string) => {
    const found = byDay.get(day);
    if (found !== undefined) return found;
    const made = { changes: [] as Row[], deploys: [] as Row[] };
    byDay.set(day, made);
    return made;
  };
  for (const row of changes) slot(newYorkDay(row.at)).changes.push(row);
  for (const row of deploys) slot(newYorkDay(row.at)).deploys.push(row);
  const out: Action[] = [];
  for (const [day, rows] of byDay) {
    if (rows.changes.length === 0) continue;
    const boxRows = rows.changes.map((row) => ({ ...(dataOf(row) as unknown as BoxChange), at: row.at }));
    // A deploy row is drawn on its own (actionOf); here it only keeps the
    // box's own deploy marker for the same commit from being drawn twice.
    const deployData = rows.deploys.map((row) => ({ at: row.at, repo: str(dataOf(row).repo), to: str(dataOf(row).to), commits: dataOf(row).commits }));
    const deployFacts = new Set(deployData.map((d) => `box:deploy:${d.to ?? ""}@${d.at}`));
    const facts = boxChangeLines(boxRows, deployData).filter((fact) => !deployFacts.has(fact.id));
    const at = Math.min(...rows.changes.map((row) => row.at));
    for (const fact of facts) {
      out.push({
        id: `${day}:${fact.id}`,
        at,
        day,
        kind: "box-change",
        text: firstLine(fact.text),
        href: fact.url.replace(/^https:\/\/tom\.quest/, "") || null,
      });
    }
  }
  return out;
}

/**
 * His sentences of each day: every whole sentence (a thread message, an
 * issue he reported) once, then each fact's words that none of them already holds,
 * since a fact's quote is a piece of the entry it came from.
 */
export function toldByDay(sentences: Told[], factWords: Told[]): Told[] {
  const kept: Told[] = [];
  const has = (row: Told) => kept.some((k) => k.day === row.day && k.text.includes(row.text.trim()));
  for (const row of [...sentences, ...factWords]) if (!has(row)) kept.push(row);
  return kept;
}

export function inRange<T extends { day: string }>(rows: T[], from: string, to: string): T[] {
  return rows.filter((row) => row.day >= from && row.day <= to);
}

export function byTime<T extends { at: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.at - b.at);
}
