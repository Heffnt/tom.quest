// The observation page's arithmetic: the window, the lane a run belongs to, the
// repository a run worked in, the counts under each node of the map, and the
// address each mark opens. Pure functions with no React in them, so the numbers
// the page draws are the numbers a test can read.

import { SESSION_REPOS, isChangeSubject, isFailureKind } from "@/convex/ttsShared";
import type { Lane, Tally } from "./map-data";

// ── The window ───────────────────────────────────────────────────────────────

export type WindowKind = "day" | "week" | "month";

export const WINDOW_KINDS: WindowKind[] = ["day", "week", "month"];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long each window is. A month is thirty days, not a calendar month: the
 *  picker steps by the window's own length, and a step that changed size would
 *  make previous and next disagree about where they came from. */
export const WINDOW_MS: Record<WindowKind, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
};

export type TimeWindow = { from: number; to: number; kind: WindowKind; offset: number };

/** `offset` counts windows back from now: 0 is the window that ends now. */
export function windowBounds(kind: WindowKind, offset: number, now: number): TimeWindow {
  const span = WINDOW_MS[kind];
  const to = now - offset * span;
  return { from: to - span, to, kind, offset };
}

/** Where a window sits, in the record's own dates. */
export function windowLabel(win: TimeWindow): string {
  const day = (ms: number) =>
    new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const clock = (ms: number) =>
    new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (win.kind === "day") return `${day(win.from)} ${clock(win.from)} — ${day(win.to)} ${clock(win.to)}`;
  return `${day(win.from)} — ${day(win.to)}`;
}

// ── Runs ─────────────────────────────────────────────────────────────────────

/** The fields of a run mark this file reads (convex/observe.ts `mark`). */
export type RunMark = {
  runId: string;
  parentRunId: string | null;
  depth: number;
  host: "laptop" | "box";
  environment: "session" | "worker" | "runner";
  cli: "claude" | "codex";
  kind: string;
  status: string;
  model: string | null;
  origin: string;
  startedAt: number;
  lastLineAt: number;
  endedReason: string | null;
  turns: number | null;
  toolCalls: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  mergeKey: string | null;
  cwd: string | null;
  gitBranch: string | null;
  wikitomCommit: string | null;
};

export type PointEvent = {
  id: string;
  at: number;
  kind: string;
  key: string | null;
  todoId: string | null;
  data: unknown;
};

export type RulingRow = {
  id: string;
  ruledAt: number;
  verdict: "approve" | "revise" | "session" | "archive";
  sentence: string | null;
  subjectType: "life" | "code";
  todoId: string | null;
  repo: string | null;
  externalId: string | null;
  subject: string;
  quote: string | null;
};

/** The lane a run is drawn in. The run's own `environment` and nothing else:
 *  the record names it on every row, so the page never guesses from the kind. */
export function laneOfRun(run: RunMark): Lane {
  if (run.environment === "session") return "sessions";
  if (run.environment === "worker") return "workers";
  return "runners";
}

/** When a bar ends. A run still going runs to now; anything else ends at the
 *  last line the record holds for it, which is the last thing it was seen to
 *  do. */
export function barEnd(run: RunMark, now: number): number {
  return run.status === "running" ? Math.max(run.lastLineAt, now) : run.lastLineAt;
}

/** The repositories a run may have worked in. */
export const REPO_NAMES: string[] = Object.keys(SESSION_REPOS);

/**
 * WHICH REPOSITORY A RUN WORKED IN, read off the working directory its launcher
 * recorded. The record keeps no repository field on a run, so this is a reading
 * of `context.cwd` and not a stored fact: a directory whose path holds one of
 * the three repository names as a segment is that repository's, and anything
 * else answers null.
 */
export function repoOfRun(run: RunMark): string | null {
  const cwd = run.cwd;
  if (cwd === null) return null;
  const segments = cwd.split(/[\\/]+/).filter((part) => part !== "");
  // EVERY segment, which is what makes a worktree path answer too: a worktree
  // directory is named for its branch, but the repository it belongs to is
  // still a segment above it.
  for (const segment of segments) {
    const hit = REPO_NAMES.find((name) => name.toLowerCase() === segment.toLowerCase());
    if (hit !== undefined) return hit;
  }
  return null;
}

// ── The point events ─────────────────────────────────────────────────────────

/** A failure is a shape and not a kind, in convex/ttsShared.ts's one spelling
 *  of it — the same rule that decides whether a row becomes a #tts-broken
 *  line, so the page and Slack never disagree about what failed. */
export const isFailure = isFailureKind;

export const GATE_KINDS = new Set(["tests-run", "audit-verdict", "evals-run"]);

function field(data: unknown, name: string): string | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>)[name];
  return typeof value === "string" && value !== "" ? value : null;
}

type MergeRow = {
  id: string;
  at: number;
  repo: string | null;
  sha: string | null;
  subject: string | null;
  mainCheck: string | null;
  /** `<repo>@<sha>` — what the gate's three head rows are filed under. */
  commitKey: string | null;
};

/** A merge row as the page reads it. The repo and the sha are nullable for the
 *  reason failureRowOf's job is: dtsEvents.data is v.any(), so no schema makes
 *  a merge row carry them, and the record holds merge rows written before
 *  POST /tts/merge required either. A row without them is still the sentence
 *  of a change that landed, which is what the list draws; what it cannot do is
 *  open the gate, so commitKey answers null and the gate is left out. */
export function mergeRowOf(event: PointEvent): MergeRow {
  const repo = field(event.data, "repo");
  const sha = field(event.data, "sha");
  return {
    id: event.id,
    at: event.at,
    repo,
    sha,
    subject: field(event.data, "subject"),
    mainCheck: field(event.data, "mainCheck"),
    commitKey: repo === null || sha === null ? null : `${repo}@${sha}`,
  };
}

type FailureRow = {
  id: string;
  at: number;
  job: string;
  todoId: string | null;
};

export function failureRowOf(event: PointEvent): FailureRow {
  return {
    id: event.id,
    at: event.at,
    // The job that broke, from the row where it is written and from the kind
    // where it is not: dtsEvents.data is v.any(), so no schema makes a
    // producer name its job, and the kind is the only other place the name is.
    job: field(event.data, "job") ?? event.kind.replace(/-fail(ed|ure)$/, ""),
    todoId: event.todoId,
  };
}

// ── Addresses ────────────────────────────────────────────────────────────────

/** The run view, which reads ?run= on arrival. */
export function runHref(runId: string): string {
  return `/runs?run=${encodeURIComponent(runId)}`;
}

/** Where a ruling's subject is shown, or null where no page shows it. An item
 *  link lands on the everything tab and only resolves a life todo, so a code
 *  todo opens that tab plain. A RULING ON A CHANGE — the Approve
 *  control's own, whose subject is `pr-<number>` or `sha-<sha>` — has no page
 *  at all: the change lives in the pull request mirror and the merge rows,
 *  which this page draws and /tts does not, so it answers null and the row
 *  carries no link rather than one that opens a page without it. */
export function rulingHref(ruling: RulingRow): string | null {
  if (ruling.subjectType === "life" && ruling.todoId !== null) return `/tts?item=${ruling.todoId}`;
  if (ruling.externalId !== null && isChangeSubject(ruling.externalId)) return null;
  return "/tts?tab=everything";
}

// ── The map's numbers ────────────────────────────────────────────────────────

type Tallied = { count: number; lastAt: number | null };

function latest(left: number | null, right: number): number {
  return left === null ? right : Math.max(left, right);
}

export type WindowData = {
  runs: RunMark[];
  events: PointEvent[];
  rulings: RulingRow[];
  /** Live runners, from the runners table. */
  runners: { experimentHost: "turing" | "box"; endedAt: number | null; lastCheckInAt: number | null }[];
};

/** Everything in the window that belongs to one lane, counted and dated. */
function laneTally(data: WindowData, lane: Lane, now: number): Tallied {
  if (lane === "sessions" || lane === "workers" || lane === "runners") {
    let count = 0;
    let lastAt: number | null = null;
    for (const run of data.runs) {
      if (laneOfRun(run) !== lane) continue;
      count += 1;
      lastAt = latest(lastAt, run.startedAt);
    }
    void now;
    return { count, lastAt };
  }
  if (lane === "rulings") {
    let lastAt: number | null = null;
    for (const ruling of data.rulings) lastAt = latest(lastAt, ruling.ruledAt);
    return { count: data.rulings.length, lastAt };
  }
  const wanted = lane === "merges" ? (kind: string) => kind === "merge" : isFailure;
  let count = 0;
  let lastAt: number | null = null;
  for (const event of data.events) {
    if (!wanted(event.kind)) continue;
    count += 1;
    lastAt = latest(lastAt, event.at);
  }
  return { count, lastAt };
}

/** The number under one node of the map. */
export function tallyFor(tally: Tally, data: WindowData, now: number): Tallied {
  switch (tally.of) {
    case "lane":
      return laneTally(data, tally.lane, now);
    case "everything": {
      let count = data.runs.length + data.rulings.length;
      let lastAt: number | null = null;
      for (const run of data.runs) lastAt = latest(lastAt, run.startedAt);
      for (const ruling of data.rulings) lastAt = latest(lastAt, ruling.ruledAt);
      for (const event of data.events) {
        count += 1;
        lastAt = latest(lastAt, event.at);
      }
      return { count, lastAt };
    }
    case "host": {
      let count = 0;
      let lastAt: number | null = null;
      for (const run of data.runs) {
        if (run.host !== tally.host) continue;
        count += 1;
        lastAt = latest(lastAt, run.startedAt);
      }
      return { count, lastAt };
    }
    case "models": {
      const seen = new Set<string>();
      let lastAt: number | null = null;
      for (const run of data.runs) {
        if (run.model === null) continue;
        seen.add(run.model);
        lastAt = latest(lastAt, run.startedAt);
      }
      return { count: seen.size, lastAt };
    }
    case "wikitom": {
      const seen = new Set<string>();
      let lastAt: number | null = null;
      for (const run of data.runs) {
        if (run.wikitomCommit === null) continue;
        seen.add(run.wikitomCommit);
        lastAt = latest(lastAt, run.startedAt);
      }
      return { count: seen.size, lastAt };
    }
    case "events": {
      let count = 0;
      let lastAt: number | null = null;
      for (const event of data.events) {
        if (event.kind !== tally.kind) continue;
        count += 1;
        lastAt = latest(lastAt, event.at);
      }
      return { count, lastAt };
    }
    case "gate": {
      let count = 0;
      let lastAt: number | null = null;
      for (const event of data.events) {
        if (!GATE_KINDS.has(event.kind)) continue;
        count += 1;
        lastAt = latest(lastAt, event.at);
      }
      return { count, lastAt };
    }
    case "turing": {
      let count = 0;
      let lastAt: number | null = null;
      for (const runner of data.runners) {
        if (runner.experimentHost !== "turing" || runner.endedAt !== null) continue;
        count += 1;
        if (runner.lastCheckInAt !== null) lastAt = latest(lastAt, runner.lastCheckInAt);
      }
      return { count, lastAt };
    }
  }
}

// ── Words for a time ─────────────────────────────────────────────────────────

/** How long ago, in the shortest true unit. */
export function ago(at: number | null, now: number): string {
  if (at === null) return "—";
  const ms = Math.max(0, now - at);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function dayAndClock(at: number): string {
  return `${new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${clock(at)}`;
}

// ── Grouping the workers ─────────────────────────────────────────────────────

/**
 * THE JOB A WORKER RUN BELONGS TO, or nothing.
 *
 * A scheduled job's runs all carry `origin: "cron:<job>"`, written by
 * worker/jobs/tts-lib.mjs, so the job's name is on every row and is not
 * inferred from anything. That is what the workers lane groups on: seven
 * hundred runs of the time-note job are one row called `time-notes`, and the
 * row's count says how many.
 *
 * ANYTHING ELSE ANSWERS NOTHING and keeps a row of its own — a subagent, a
 * delegate call, a codex child, a run an orchestrator spawned. Those are the
 * runs worth seeing one at a time, and folding them into a group would hide the
 * very thing the lane is for.
 */
export function jobOfRun(run: RunMark): string | null {
  if (run.depth !== 0 || run.parentRunId !== null) return null;
  const cron = /^cron:(.+)$/.exec(run.origin);
  return cron === null ? null : cron[1];
}

/** How a run ended, in the record's own words and numbers. */
export function outcomeWords(run: RunMark): string[] {
  const parts: string[] = [run.status];
  if (run.endedReason !== null) parts.push(run.endedReason);
  if (run.turns !== null) parts.push(`${run.turns} turns`);
  if (run.toolCalls !== null) parts.push(`${run.toolCalls} tool calls`);
  if (run.totalTokens !== null) parts.push(`${run.totalTokens.toLocaleString("en-US")} tokens`);
  if (run.costUsd !== null) parts.push(`$${run.costUsd.toFixed(2)}`);
  return parts;
}

/** How long a run lasted, in the shortest true unit. */
export function lasted(run: RunMark, now: number): string {
  const ms = Math.max(0, barEnd(run, now) - run.startedAt);
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

// ── Stacking ─────────────────────────────────────────────────────────────────

/**
 * Which sub-row each mark of a lane is drawn in, so two things that happened at
 * once are both visible instead of one hiding the other.
 *
 * Greedy and left to right: a mark goes in the first sub-row whose last mark
 * ended before it began. `minGap` is the smallest separation that still reads
 * as two marks rather than one, in the same units as the times. Past `maxRows`
 * the lane stops growing and the rest share its last sub-row — a lane that grew
 * without a ceiling would push the five lanes under it off the screen.
 */
export function packRows<T>(
  items: T[],
  startOf: (item: T) => number,
  endOf: (item: T) => number,
  minGap: number,
  maxRows: number,
): number[] {
  const order = items
    .map((item, index) => ({ index, start: startOf(item), end: endOf(item) }))
    .sort((left, right) => left.start - right.start || left.index - right.index);
  const lastEnd: number[] = [];
  const rows = new Array<number>(items.length).fill(0);
  for (const entry of order) {
    let row = lastEnd.findIndex((end) => end <= entry.start);
    if (row === -1) {
      if (lastEnd.length < maxRows) {
        row = lastEnd.length;
        lastEnd.push(0);
      } else {
        row = maxRows - 1;
      }
    }
    lastEnd[row] = Math.max(entry.end, entry.start + minGap);
    rows[entry.index] = row;
  }
  return rows;
}

/** Where a time sits across the window, as a fraction from 0 to 1. */
export function fractionOf(at: number, win: { from: number; to: number }): number {
  const span = win.to - win.from;
  // A window of no width cannot come from windowBounds, and this is what keeps
  // one that did from dividing by zero: every mark would be placed at NaN,
  // which draws nothing at all, so the page would go blank rather than wrong.
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (at - win.from) / span));
}

// ── Geometry ─────────────────────────────────────────────────────────────────

export type Point = { x: number; y: number };

/**
 * Where a straight line from one box's centre leaves that box. The arrow is
 * drawn between borders rather than between centres, so an arrowhead lands on
 * the edge of the box it points at.
 */
export function borderPoint(centre: Point, halfWidth: number, halfHeight: number, towards: Point): Point {
  const dx = towards.x - centre.x;
  const dy = towards.y - centre.y;
  // Two nodes on the same centre have no direction between them. The layout
  // gives every node its own place, so this answers a layout someone has just
  // edited: the edge collapses to a point instead of taking the whole drawing
  // down with an infinity.
  if (dx === 0 && dy === 0) return centre;
  const tx = dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
  const ty = dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
  const t = Math.min(tx, ty);
  return { x: centre.x + dx * t, y: centre.y + dy * t };
}

/**
 * The three corners of an arrowhead pointing at `tip`, along the line that
 * arrives from `from`.
 *
 * AN EXPLICIT POLYGON, not an SVG marker element: a marker inherits neither the
 * line's colour nor the page's theme reliably, and its orientation is the
 * renderer's business rather than this file's. The angle is computed here and
 * the two back corners are placed off it, so what is drawn is what the numbers
 * say.
 */
export function arrowHead(from: Point, tip: Point, length = 9, halfBase = 4.5): string {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const len = Math.hypot(dx, dy);
  // As in borderPoint: an edge of no length has no direction to point along,
  // and dividing by it would put NaN in the polygon, which SVG drops silently.
  if (len === 0) return `${tip.x},${tip.y}`;
  const ux = dx / len;
  const uy = dy / len;
  const baseX = tip.x - ux * length;
  const baseY = tip.y - uy * length;
  const left = { x: baseX - uy * halfBase, y: baseY + ux * halfBase };
  const right = { x: baseX + uy * halfBase, y: baseY - ux * halfBase };
  return `${tip.x},${tip.y} ${left.x.toFixed(2)},${left.y.toFixed(2)} ${right.x.toFixed(2)},${right.y.toFixed(2)}`;
}

/** Where the arrowhead's own tail starts, so the line stops short of the head
 *  rather than running through it. */
export function shortened(from: Point, tip: Point, by: number): Point {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const len = Math.hypot(dx, dy);
  // As in borderPoint: nothing to shorten along, and the alternative is NaN.
  if (len === 0) return tip;
  return { x: tip.x - (dx / len) * by, y: tip.y - (dy / len) * by };
}
