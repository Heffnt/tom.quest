"use client";

// THE WINDOW'S ROWS, IN ONE HOOK. The view asks for a stretch of time and gets
// back everything the record holds about it; which of those rows arrived on
// which page of which query is nobody else's business.
//
// IT PAGES UNTIL THE WINDOW IS EXHAUSTED, because the timeline draws the whole
// window and a half-drawn month is a picture that lies about how much ran.
// Two ceilings stop it: `RUNS_CAP` and `EVENTS_CAP`, and when one of them
// stops a walk the hook says so, so the view can say the window is larger
// than what is drawn rather than quietly drawing less.
//
// POINT EVENTS COME FROM TWO TABLES tonight (convex/observe.ts says which kind
// lives where): the record's `events` (recordInWindow) and the previous
// generation's dtsEvents (eventsInWindow). Each is walked on its own cursor
// and the two are merged by time here; no row is in both. The dtsEvents walk
// is not for old rows alone: merges, the delegate's ask rows and objections,
// and the other "-failed" kinds are still WRITTEN there (w4's history copy
// moved only box changes and job reports), so it goes when their writers move.

import { useEffect, useMemo } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { PointEvent, RulingRow, RunMark, TimeWindow } from "./lib";

/** One page of each walk. Large enough that a day is one page and a month is a
 *  handful; small enough to stay far inside a query's own read limit. */
const PAGE = 400;

/** The most rows one window draws. A month of runs on the box has never come
 *  near either number; crossing one is a fact about the window, not a bug. */
const RUNS_CAP = 4000;
const EVENTS_CAP = 4000;

type WindowRows = {
  runs: RunMark[];
  events: PointEvent[];
  rulings: RulingRow[];
  waiting: { waiting: number; oldestAt: number | null; lastAt: number | null } | null;
  /** False while a walk still has pages to fetch. */
  complete: boolean;
  /** True when a cap stopped a walk before the window ran out. */
  capped: boolean;
};

type Walk = {
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  loadMore: (n: number) => void;
  results: unknown[];
};

/** Keep one paginated walk going until it is exhausted or the rows it
 *  shares a cap with (`beside`, the other walk's rows) and its own reach the
 *  cap. */
function useWalk(walk: Walk, cap: number, beside = 0): { done: boolean; capped: boolean } {
  const { status, loadMore } = walk;
  const count = walk.results.length + beside;
  useEffect(() => {
    if (status === "CanLoadMore" && count < cap) loadMore(PAGE);
  }, [status, count, cap, loadMore]);
  const capped = status === "CanLoadMore" && count >= cap;
  return { done: status === "Exhausted" || capped, capped };
}

/**
 * `on` is the caller's `isTom`: every query below is gated on requireTom, so a
 * signed-in stranger asking for them is a thrown error in the middle of the
 * render rather than the gate card the page means to show.
 */
export function useWindowRows(win: TimeWindow, on: boolean): WindowRows {
  const args = on ? { from: win.from, to: win.to } : "skip";

  const runs = usePaginatedQuery(api.observe.runsInWindow, args, { initialNumItems: PAGE });
  const record = usePaginatedQuery(api.observe.recordInWindow, args, { initialNumItems: PAGE });
  const older = usePaginatedQuery(api.observe.eventsInWindow, args, { initialNumItems: PAGE });
  const rulings = useQuery(api.observe.rulingsInWindow, args);
  const waiting = useQuery(api.observe.waitingOnTom, on ? {} : "skip");

  const runsWalk = useWalk(runs, RUNS_CAP);
  // ONE CAP FOR THE MERGED POINT EVENTS: the two walks share EVENTS_CAP, and
  // the merged window draws at most that many, saying it was capped when the
  // two together held more.
  const recordWalk = useWalk(record, EVENTS_CAP, older.results.length);
  const olderWalk = useWalk(older, EVENTS_CAP, record.results.length);

  const merged = useMemo(
    () =>
      [...(record.results as PointEvent[]), ...(older.results as PointEvent[])].sort(
        (left, right) => left.at - right.at,
      ),
    [record.results, older.results],
  );
  const events = useMemo(() => merged.slice(0, EVENTS_CAP), [merged]);

  const capped = runsWalk.capped || recordWalk.capped || olderWalk.capped || merged.length > EVENTS_CAP;
  const complete = runsWalk.done && recordWalk.done && olderWalk.done && rulings !== undefined;

  return {
    runs: runs.results as RunMark[],
    events,
    rulings: (rulings ?? []) as RulingRow[],
    waiting: waiting ?? null,
    complete,
    capped,
  };
}
