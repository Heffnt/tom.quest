// history.ts — the /history page's one read: his diet and exercise, what he
// told Jarvis, and what Jarvis did, over a range of days. It reads the events
// table by kind and writes nothing. The rows become what the page draws in
// convex/historyRows.ts.
//
// THE READS ARE BOUNDED BY BYTES (convex/readBudget.ts): one budget of
// 12 MiB, under Convex's 16 MiB, split into an allotment per read, run one
// after another as ReadBudget requires. His facts are read first, so a heavy
// day of machine changes can only cut what Jarvis did, never his facts. A read
// that stopped early is returned as a line in `cuts`, which the page shows.
//
// AND BOUNDED BY DOCUMENTS: Convex also refuses a transaction that reads more
// than 32,000 documents, and a byte budget does not bound that (a small row
// is a few hundred bytes). Each read's row cap is chosen so that all of them
// together, with the one row each read takes past its cap to learn whether it
// was cut, stay under half of that: DOCUMENTS_READ_MAX below, which the tests
// hold under 16,000.
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { requireTomOrAgent } from "./authRoles";
import { MIB, ReadBudget, readWithin } from "./readBudget";
import { readCutLine } from "./ttsCompose";
import { addDays } from "../shared/clock.mjs";
import {
  ACTION_KINDS,
  FACT_KINDS,
  FACT_LATE_DAYS,
  MESSAGE_KIND,
  actionOf,
  boxChangeActions,
  byTime,
  daysBetween,
  factToldOf,
  inRange,
  isHisIssue,
  mealOf,
  rangeInstants,
  rangeOf,
  toldOf,
  toldByDay,
  trainingOf,
  weightOf,
  type HistoryPage,
} from "./historyRows";

export const SURFACE = "History";

const BUDGET = 12 * MIB;

/** Each read's allotment and row cap. A year of his facts is about three
 *  meals, a weight and a session a day, so 1,500 rows of a kind covers it. */
const READS = {
  fact: { bytes: MIB, rows: 1500 },
  told: { bytes: MIB, rows: 1000 },
  action: { bytes: MIB / 4, rows: 150 },
  // The heavy kinds: an eval-run row carries every item it ran, and the box
  // posts up to hundreds of box-change rows a day.
  heavyAction: { bytes: MIB, rows: 800 },
} as const;

const HEAVY_ACTIONS = new Set<string>(["box-change", "eval-run", "work-run", "deploy"]);

/** The reads `page` makes, each with its row cap: three fact kinds, did and
 *  his thread messages, and one per action kind. */
const READ_CAPS: number[] = [
  READS.fact.rows, READS.fact.rows, READS.fact.rows,
  READS.told.rows, READS.told.rows,
  ...ACTION_KINDS.map((kind) => (HEAVY_ACTIONS.has(kind) ? READS.heavyAction.rows : READS.action.rows)),
];

/** The most documents `page` reads: every cap, plus the one row each read
 *  takes past its cap (convex/readBudget.ts readWithin). */
export const DOCUMENTS_READ_MAX = READ_CAPS.reduce((sum, rows) => sum + rows + 1, 0);

type Range = { start: number; end: number };

function kindInRange(ctx: QueryCtx, kind: string, range: Range) {
  return ctx.db
    .query("events")
    .withIndex("by_kind_at", (q) => q.eq("kind", kind).gte("at", range.start).lt("at", range.end))
    .order("asc");
}

export const page = query({
  args: { from: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, args): Promise<HistoryPage> => {
    await requireTomOrAgent(ctx, SURFACE);
    const { from, to } = rangeOf(args, Date.now());
    const range = rangeInstants(from, to);
    // A fact is read by when he said it, which may be up to FACT_LATE_DAYS
    // after the day it belongs to, and kept by its day.
    const factRange = rangeInstants(from, addDays(to, FACT_LATE_DAYS));
    const budget = ReadBudget.of(BUDGET);
    const events = (kind: string, what: string, read: { bytes: number; rows: number }, within: Range = range) =>
      readWithin(budget.allot(what, read.bytes), kindInRange(ctx, kind, within), read.rows);

    const weightRows = await events(FACT_KINDS.weight, "weights", READS.fact, factRange);
    const mealRows = await events(FACT_KINDS.meal, "meals", READS.fact, factRange);
    const trainingRows = await events(FACT_KINDS.training, "training sessions", READS.fact, factRange);
    const didRows = await events(FACT_KINDS.did, "his other facts", READS.told, factRange);
    const messageRows = await events(MESSAGE_KIND, "his thread messages", READS.told);

    const actionRows: Doc<"events">[] = [];
    const hisIssues: Doc<"events">[] = [];
    let boxChanges: Doc<"events">[] = [];
    let deploys: Doc<"events">[] = [];
    for (const kind of ACTION_KINDS) {
      const read = HEAVY_ACTIONS.has(kind) ? READS.heavyAction : READS.action;
      const rows = kind === "job-failed"
        // The failures that opened a condition, not its repeats every few
        // minutes while it stands (convex/jarvis/jobs.ts failuresInWindow).
        ? await readWithin(
          budget.allot("job failures", read.bytes),
          ctx.db
            .query("events")
            .withIndex("by_kind_standing_at", (q) =>
              q.eq("kind", kind).eq("data.standingSince", undefined).gte("at", range.start).lt("at", range.end))
            .order("asc"),
          read.rows,
        )
        : await events(kind, `${kind} rows`, read);
      if (kind === "box-change") boxChanges = rows;
      else {
        if (kind === "deploy") deploys = rows;
        for (const row of rows) (isHisIssue(row) ? hisIssues : actionRows).push(row);
      }
    }

    const told = toldByDay(
      byTime([...messageRows, ...hisIssues].flatMap((row) => toldOf(row) ?? [])),
      byTime([...didRows, ...mealRows, ...weightRows, ...trainingRows].flatMap((row) => factToldOf(row) ?? [])),
    );

    return {
      from,
      to,
      days: daysBetween(from, to),
      weights: byTime(inRange(weightRows.flatMap((row) => weightOf(row) ?? []), from, to)),
      meals: byTime(inRange(mealRows.flatMap((row) => mealOf(row) ?? []), from, to)),
      trainings: byTime(inRange(trainingRows.flatMap((row) => trainingOf(row) ?? []), from, to)),
      told: byTime(inRange(told, from, to)),
      actions: byTime(inRange([...actionRows.map(actionOf), ...boxChangeActions(boxChanges, deploys)], from, to)),
      cuts: budget.cuts().map(readCutLine),
    };
  },
});
