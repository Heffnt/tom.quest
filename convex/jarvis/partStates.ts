// partStates.ts — each part of Jarvis's state, read from the rows of the
// record and never stored.
//
// Tom's answer of 2026-10-04, 22:59 Eastern, is the definition: "the primary
// thing is that I am interacting with it and I don't report any issues or I
// explicitly report no issues. lots of code is implemented and never run
// which is not evidence of working properly." So a part's state is read from
// what used it and what was reported about it, never from its code existing.
//
// A PART is one id of Jarvis worker/parts.json (the registry). The caller
// passes the ids it wants with the two registry fields this file maps rows by,
// `schedule` (the job name its `job-ok` rows carry in provenance.job) and
// `file` (its path in the repository), and each landed pull request with its
// head, the time it landed and the files it changed. The record holds no copy
// of the registry yet; once the box posts it at each deploy, this query reads
// it from there and the argument goes.
//
// ONE CLOCK. Every row is placed in time by when the record received it:
// Convex's _creationTime, the server's clock at insert. A writer's `at` is
// shown, never compared: the validator lets it lie five minutes ahead and any
// distance back, so a row ordered or bounded by it could close, hide or skip
// the wrong rows (the gate's audits of ac48bc57 and ee71ded9). A landing is
// placed at the time the caller gives for it.
//
// THE ROWS (shared/jarvis-events.mjs):
//   a landing   a pull request the caller lists; it touches a part when its
//               files hold the part's file. Rows received before the part's
//               newest landing are about code that has since changed, so use
//               and run rows count only after it. Its row in the record is the
//               `merge` row keyed on its head (convex/ttsMerge.ts
//               internalRecordMerge, which convex/gateLandings.ts writes for
//               every pull request that reached main with the gate open).
//   a run       a `job-ok` row whose provenance.job is the part's schedule, or
//               any `use` row.
//   a use       a `use` row, subject the part; data.by says who.
//   an issue    an `issue` row, subject the part. A resolving issue row (one
//               carrying data.resolvedBy) or a use row of Tom's with state
//               "working" (he said it has no issues) closes the issues the
//               record received before it.
//
// THE STATES, the first that holds; "recent" is received within IN_USE_DAYS
// and after the newest landing:
//   issue       an open issue row.
//   working     a recent use row of Tom's with state "working"; or a recent use
//               by Tom or an agent, with the oldest recent use by either since
//               the newest issue at least WORKING_AFTER_DAYS old.
//   in use      a recent use row by Tom or an agent.
//   run         a run since the landing.
//   unverified  none of the above: landed or never touched, and not run since.
// The two numbers are agent-set (decisions-2026-10-05.md section 3.1 set the
// seven days); Tom's sentence replaces either.

import { v } from "convex/values";
import { query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { requireTom } from "../authRoles";
import { USE_STATE_WORKING } from "../../shared/jarvis-events.mjs";
import { MERGE } from "../ttsMerge";
import { mergeKey } from "../ttsShared";

export const IN_USE_DAYS = 30;
export const WORKING_AFTER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

type PartState = "unverified" | "run" | "in use" | "working" | "issue";

/** One row behind a state, as the caller sees it: `at` is the writer's time. */
type StateRow = { id: string; kind: string; at: number; text?: string };

/** A row as the derivation reads it: `receivedAt` is the record's receipt time. */
export type Received = StateRow & { receivedAt: number };
export type UseRow = Received & { by: string; working: boolean };
export type IssueRow = Received & { resolves: boolean };

/** Everything the derivation reads for one part. A landing's receivedAt is the time the caller gives. */
export type PartRows = {
  landings: Received[];
  jobOk: Received | null;
  uses: UseRow[];
  issues: IssueRow[];
};

/** The row the record received last, or null. */
const newest = <T extends { receivedAt: number }>(rows: readonly T[]): T | null =>
  rows.reduce<T | null>((best, row) => (best === null || row.receivedAt > best.receivedAt ? row : best), null);

const strip = (row: StateRow): StateRow => ({
  id: row.id,
  kind: row.kind,
  at: row.at,
  ...(row.text === undefined ? {} : { text: row.text }),
});

/** The start of the window a recent use is received in. */
const recentSince = (cutoff: number, now: number): number => Math.max(cutoff, now - IN_USE_DAYS * DAY_MS);

/** One part's state and the row it rests on; pure, so the rules are tested alone. */
export function derivePartState(rows: PartRows, now: number): { state: PartState; row: StateRow | null } {
  const landing = newest(rows.landings);
  const cutoff = landing?.receivedAt ?? -Infinity;

  const closedUntil = Math.max(
    -Infinity,
    ...rows.issues.filter((issue) => issue.resolves).map((issue) => issue.receivedAt),
    ...rows.uses.filter((use) => use.by === "tom" && use.working).map((use) => use.receivedAt),
  );
  const openIssue = newest(rows.issues.filter((issue) => !issue.resolves && issue.receivedAt > closedUntil));
  if (openIssue !== null) return { state: "issue", row: strip(openIssue) };

  const since = rows.uses.filter((use) => use.receivedAt > cutoff);
  const recent = since.filter((use) => use.receivedAt > recentSince(cutoff, now));
  const saidWorking = newest(recent.filter((use) => use.by === "tom" && use.working));
  if (saidWorking !== null) return { state: "working", row: strip(saidWorking) };

  const active = recent.filter((use) => use.by === "tom" || use.by === "agent");
  const inUse = newest(active);
  if (inUse !== null) {
    const lastIssue = newest(rows.issues.filter((issue) => !issue.resolves))?.receivedAt ?? -Infinity;
    const first = active.reduce((min, use) => (use.receivedAt > lastIssue ? Math.min(min, use.receivedAt) : min), Infinity);
    if (now - first >= WORKING_AFTER_DAYS * DAY_MS) return { state: "working", row: strip(inUse) };
    return { state: "in use", row: strip(inUse) };
  }

  const ran = newest([...(rows.jobOk !== null && rows.jobOk.receivedAt > cutoff ? [rows.jobOk] : []), ...since]);
  if (ran !== null) return { state: "run", row: strip(ran) };

  return { state: "unverified", row: landing === null ? null : strip(landing) };
}

/** A registry row, in the two fields rows are mapped by. */
type PartRef = { id: string; schedule?: string | null; file?: string | null };
/**
 * A pull request that landed, as the caller has it: when it landed, its head
 * (the record's landing row is keyed on it) and the files it changed.
 */
type Landed = { repo: string; pullRequest: number; headSha: string; landedAt: number; files: string[] };

/** Whether a landing's files hold the part's file (a directory holds what is under it). */
export function touches(part: PartRef, files: readonly string[]): boolean {
  const file = part.file;
  if (file === null || file === undefined || file === "") return false;
  const dir = file.endsWith("/") ? file : `${file}/`;
  return files.some((changed) => changed === file || changed.startsWith(dir));
}

/** The kind of the row that stands for a landing the record holds no row for. */
const LANDING = "landing";

function received(row: Doc<"events">): Received {
  return {
    id: row._id,
    kind: row.kind,
    at: row.at,
    receivedAt: row._creationTime,
    ...(row.text === undefined ? {} : { text: row.text }),
  };
}

/** A part's rows of one kind, last received first (by_kind_subject ends in _creationTime); read lazily. */
function lastReceivedFirst(ctx: QueryCtx, kind: string, subject: string) {
  return ctx.db
    .query("events")
    .withIndex("by_kind_subject", (q) => q.eq("kind", kind).eq("subject", subject))
    .order("desc");
}

/**
 * THE CAP (convex/AGENTS.md: a read whose rows grow carries one). One query
 * reads at most QUERY_ROW_BUDGET use and issue rows across every part it
 * answers: at about 0.5 KB a row, 8 MB, half of what one Convex function may
 * read. A read that spends the budget before it reaches its stop stops, and
 * its part's answer says `capped: true`: its state was read from the rows
 * received last only, and is shown as such rather than taken as the whole
 * history.
 */
const QUERY_ROW_BUDGET = 16_000;

type Budget = { left: number };

/**
 * One part's rows out of the record, each read last received first and
 * stopped at a receipt time the state depends on:
 *   issues  down to the last-received issue that is not a resolution, with
 *           every resolution received after it. That issue is open unless a
 *           row received after it closes it, and every issue received before
 *           it is closed whenever it is.
 *   uses    every use received since the recent window opened (the newer of
 *           the newest landing and IN_USE_DAYS ago); past that, the one row
 *           received last since the landing, which is all "run" needs; and,
 *           while that issue has no closing row yet, back to the issue, for a
 *           "no issues" of Tom's that closes it. A part with no issue and no
 *           recent use reads one use row.
 */
async function rowsFor(
  ctx: QueryCtx,
  part: PartRef,
  landings: Received[],
  budget: Budget,
  now: number,
): Promise<{ rows: PartRows; capped: boolean }> {
  const cutoff = newest(landings)?.receivedAt ?? -Infinity;
  const windowStart = recentSince(cutoff, now);
  const schedule = part.schedule;
  const jobOk =
    schedule === null || schedule === undefined || schedule === ""
      ? null
      : await ctx.db
          .query("events")
          .withIndex("by_kind_job", (q) => q.eq("kind", "job-ok").eq("provenance.job", schedule))
          .order("desc")
          .first();
  let capped = false;
  const issues: IssueRow[] = [];
  let lastIssue = -Infinity;
  let closed = false;
  for await (const row of lastReceivedFirst(ctx, "issue", part.id)) {
    if (budget.left <= 0) {
      capped = true;
      break;
    }
    budget.left--;
    const resolves = typeof (row.data as { resolvedBy?: unknown } | undefined)?.resolvedBy === "string";
    issues.push({ ...received(row), resolves });
    if (resolves) closed = true;
    else {
      lastIssue = row._creationTime;
      break;
    }
  }
  // A closing "no issues" is only looked for when an issue stands with no
  // resolution received after it.
  let seeking = lastIssue > -Infinity && !closed;
  const uses: UseRow[] = [];
  for await (const row of lastReceivedFirst(ctx, "use", part.id)) {
    const at = row._creationTime;
    const wanted = at > windowStart || (at > cutoff && uses.length === 0) || (seeking && at > lastIssue);
    if (!wanted) break;
    if (budget.left <= 0) {
      capped = true;
      break;
    }
    budget.left--;
    // Every stored use row names data.by: the validator fills it in
    // (shared/jarvis-events.mjs rowBy), and no copy writes a use row past it.
    const data = row.data as { by: string; state?: unknown };
    const use = { ...received(row), by: data.by, working: data.state === USE_STATE_WORKING };
    uses.push(use);
    if (use.by === "tom" && use.working && at > lastIssue) seeking = false;
  }
  return { rows: { landings, jobOk: jobOk === null ? null : received(jobOk), uses, issues }, capped };
}

/**
 * Per part id the caller passes, its state and the newest row behind it.
 * `parts` are registry rows (id, schedule, file); `landed` the pull requests
 * that landed with the files each changed, of the repository whose paths the
 * parts' file fields name, taken as the caller gives them: a part's newest
 * landing is its cutoff at `landedAt`. Only when that landing is the row an
 * unverified part rests on is the record's landing row read, by its key
 * (convex/ttsShared.ts mergeKey); a landing the record holds no row for (one
 * past the gate, or before the record wrote landing rows) is answered as
 * kind "landing", id "<repo>#<pull request>".
 */
export async function readPartStates(
  ctx: QueryCtx,
  parts: readonly PartRef[],
  landed: readonly Landed[],
  now: number,
  budget: Budget = { left: QUERY_ROW_BUDGET },
): Promise<{ part: string; state: PartState; row: StateRow | null; capped: boolean }[]> {
  const refs = landed.map((pull) => ({
    pull,
    receivedAt: pull.landedAt,
    row: {
      id: `${pull.repo}#${pull.pullRequest}`,
      kind: LANDING,
      at: pull.landedAt,
      receivedAt: pull.landedAt,
      text: `pull request #${pull.pullRequest}`,
    },
  }));
  return await Promise.all(
    parts.map(async (part) => {
      const mine = refs.filter((ref) => touches(part, ref.pull.files));
      const read = await rowsFor(ctx, part, mine.map((ref) => ref.row), budget, now);
      const { capped } = read;
      const { state, row } = derivePartState(read.rows, now);
      // An unverified part with a landing rests on its newest landing (the row
      // derivePartState answers); that landing's row in the record is read by key.
      const landing = newest(mine);
      if (state !== "unverified" || landing === null) return { part: part.id, state, row, capped };
      const { repo, headSha } = landing.pull;
      const recorded = await ctx.db
        .query("events")
        .withIndex("by_kind_subject_at", (q) => q.eq("kind", MERGE).eq("subject", mergeKey(repo, headSha)))
        .first();
      return { part: part.id, state, row: recorded === null ? strip(landing.row) : strip(received(recorded)), capped };
    }),
  );
}

export const partStates = query({
  args: {
    parts: v.array(
      v.object({
        id: v.string(),
        schedule: v.optional(v.union(v.string(), v.null())),
        file: v.optional(v.union(v.string(), v.null())),
      }),
    ),
    landings: v.optional(
      v.array(
        v.object({
          repo: v.string(),
          pullRequest: v.number(),
          headSha: v.string(),
          landedAt: v.number(),
          files: v.array(v.string()),
        }),
      ),
    ),
  },
  handler: async (ctx, { parts, landings }) => {
    await requireTom(ctx, "Jarvis");
    return await readPartStates(ctx, parts, landings ?? [], Date.now());
  },
});
