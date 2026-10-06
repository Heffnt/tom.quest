// history.ts — the /history page's one read: his diet and exercise, what he
// told Jarvis, and what Jarvis did, over a range of days. It reads the events
// table by kind (and, until the day log is folded into events, the day log's
// two tables) and writes nothing. The rows become what the page draws in
// convex/historyRows.ts.
//
// THE READS ARE BOUNDED BY BYTES (convex/readBudget.ts): one budget of
// 12 MiB, under Convex's 16 MiB, split into an allotment per read, run one
// after another as ReadBudget requires. His facts are read first, so a heavy
// day of machine changes can only cut what Jarvis did, never his facts. A read
// that stopped early is returned as a line in `cuts`, which the page shows.
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
  dayLogMeal,
  dayLogTold,
  dayLogTraining,
  dayLogWeight,
  daysBetween,
  factToldOf,
  inRange,
  mealOf,
  rangeInstants,
  rangeOf,
  toldOf,
  toldByDay,
  trainingOf,
  weightOf,
  withDayLog,
  type HistoryPage,
} from "./historyRows";

export const SURFACE = "History";

const BUDGET = 12 * MIB;

/** Each read's allotment and row cap. */
const READS = {
  fact: { bytes: MIB, rows: 3000 },
  told: { bytes: MIB, rows: 2000 },
  dayLog: { bytes: MIB / 2, rows: 3000 },
  action: { bytes: MIB / 4, rows: 500 },
  // The heavy kinds: an eval-run row carries every item it ran, and the box
  // posts up to hundreds of box-change rows a day.
  heavyAction: { bytes: MIB, rows: 3000 },
} as const;

const HEAVY_ACTIONS = new Set<string>(["box-change", "eval-run", "work-run", "deploy"]);

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

    const dayLogItems = async (type: Doc<"dayLogItems">["type"], what: string) => readWithin(
      budget.allot(what, READS.dayLog.bytes),
      ctx.db.query("dayLogItems").withIndex("by_type_day", (q) => q.eq("type", type).gte("day", from).lte("day", to)),
      READS.dayLog.rows,
    );
    const oldMeasurements = await dayLogItems("measurement", "day-log measurements");
    const oldWorkouts = await dayLogItems("workout", "day-log workouts");
    const oldFood = await dayLogItems("food", "day-log meals");
    const oldEntries = await readWithin(
      budget.allot("day-log entries", READS.dayLog.bytes),
      ctx.db.query("dayLogEntries").withIndex("by_day", (q) => q.gte("day", from).lte("day", to)),
      READS.dayLog.rows,
    );

    const actionRows: Doc<"events">[] = [];
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
        actionRows.push(...rows);
      }
    }

    const told = toldByDay(
      byTime([...oldEntries.map(dayLogTold), ...messageRows.flatMap((row) => toldOf(row) ?? [])]),
      byTime([...didRows, ...mealRows, ...weightRows, ...trainingRows].flatMap((row) => factToldOf(row) ?? [])),
    );

    return {
      from,
      to,
      days: daysBetween(from, to),
      weights: byTime(inRange(withDayLog(
        weightRows.flatMap((row) => weightOf(row) ?? []),
        oldMeasurements.flatMap((item) => dayLogWeight(item) ?? []),
      ), from, to)),
      meals: byTime(inRange(withDayLog(mealRows.map(mealOf), oldFood.map(dayLogMeal)), from, to)),
      trainings: byTime(inRange(withDayLog(trainingRows.flatMap((row) => trainingOf(row) ?? []), oldWorkouts.map(dayLogTraining)), from, to)),
      told: byTime(inRange(told, from, to)),
      actions: byTime(inRange([...actionRows.map(actionOf), ...boxChangeActions(boxChanges, deploys)], from, to)),
      cuts: budget.cuts().map(readCutLine),
    };
  },
});
