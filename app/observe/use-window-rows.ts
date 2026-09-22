"use client";

// THE WINDOW'S ROWS, IN ONE HOOK. The page asks for a stretch of time and gets
// back everything the record holds about it; which of those rows arrived on
// which page of which query is nobody else's business.
//
// IT PAGES UNTIL THE WINDOW IS EXHAUSTED, because the timeline draws the whole
// window and a half-drawn month is a picture that lies about how much ran. Two
// ceilings stop it: `RUNS_CAP` and `EVENTS_CAP`, and when one of them stops the
// walk the hook says so, so the page can say the window is larger than what is
// drawn rather than quietly drawing less.

import { useEffect } from "react";
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

export type WindowRows = {
  runs: RunMark[];
  events: PointEvent[];
  rulings: RulingRow[];
  runners: {
    runnerId: string;
    title: string;
    experimentHost: "turing" | "box";
    endedAt: number | null;
    lastCheckInAt: number | null;
  }[];
  waiting: { waiting: number; oldestAt: number | null; lastAt: number | null } | null;
  /** False while a walk still has pages to fetch. */
  complete: boolean;
  /** True when a cap stopped a walk before the window ran out. */
  capped: boolean;
};

export function useWindowRows(win: TimeWindow): WindowRows {
  const args = { from: win.from, to: win.to };

  const runs = usePaginatedQuery(api.observe.runsInWindow, args, { initialNumItems: PAGE });
  const events = usePaginatedQuery(api.observe.eventsInWindow, args, { initialNumItems: PAGE });
  const rulings = useQuery(api.observe.rulingsInWindow, args);
  const runners = useQuery(api.ttsRunners.listRunners, {});
  const waiting = useQuery(api.observe.waitingOnTom, {});

  const runsStatus = runs.status;
  const runsLoadMore = runs.loadMore;
  const runsCount = runs.results.length;
  useEffect(() => {
    if (runsStatus === "CanLoadMore" && runsCount < RUNS_CAP) runsLoadMore(PAGE);
  }, [runsStatus, runsCount, runsLoadMore]);

  const eventsStatus = events.status;
  const eventsLoadMore = events.loadMore;
  const eventsCount = events.results.length;
  useEffect(() => {
    if (eventsStatus === "CanLoadMore" && eventsCount < EVENTS_CAP) eventsLoadMore(PAGE);
  }, [eventsStatus, eventsCount, eventsLoadMore]);

  const capped =
    (runsStatus === "CanLoadMore" && runsCount >= RUNS_CAP) ||
    (eventsStatus === "CanLoadMore" && eventsCount >= EVENTS_CAP);

  const complete =
    (runsStatus === "Exhausted" || capped) &&
    (eventsStatus === "Exhausted" || capped) &&
    rulings !== undefined;

  return {
    runs: runs.results as RunMark[],
    events: events.results as PointEvent[],
    rulings: (rulings ?? []) as RulingRow[],
    runners: (runners ?? []).map((runner) => ({
      runnerId: runner.runnerId as unknown as string,
      title: runner.title,
      experimentHost: runner.experimentHost,
      endedAt: runner.endedAt,
      lastCheckInAt: runner.lastCheckIn === null ? null : runner.lastCheckIn.at,
    })),
    waiting: waiting ?? null,
    complete,
    capped,
  };
}
