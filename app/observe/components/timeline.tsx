"use client";

// THE TIMELINE. Six lanes across the selected window: the three kinds of run as
// bars from start to end, and the three kinds of point — a ruling, a merge, a
// failure — as marks at the instant they happened. A run still going runs to
// the right edge.
//
// Marks are laid out as a fraction of the window and stacked into sub-rows
// (app/observe/lib.ts packRows), so two runs that overlapped are two bars and
// not one. Every mark is a link: a run opens the run view, a ruling opens its
// subject, a merge opens its pull request.
//
// WHAT A MARK IS reaches the reader through one reserved line under the lanes,
// which holds the facts of whichever mark the pointer or the keyboard is on.
// Not `title=`, which app/AGENTS.md rules out because it is dead on touch, and
// not a line that appears between the lanes, which would move them.

import { useState } from "react";
import Link from "next/link";
import { LANES, type Lane } from "../map-data";
import {
  barEnd,
  dayAndClock,
  failureRowOf,
  fractionOf,
  isFailure,
  laneOfRun,
  mergeHref,
  mergeRowOf,
  packRows,
  rulingHref,
  runHref,
  type PointEvent,
  type RulingRow,
  type RunMark,
  type TimeWindow,
} from "../lib";

const ROW_H = 13;
const BAR_H = 9;
/** The smallest span two marks may be apart and still be stacked rather than
 *  drawn on top of each other: one two-hundredth of the window. */
const GAP_FRACTION = 1 / 200;
const MAX_ROWS = 14;

type Mark = {
  key: string;
  start: number;
  end: number;
  href: string | null;
  /** The mark's own facts, for the reserved line. */
  words: string;
  tone: "running" | "failed" | "plain" | "accent";
};

export default function Timeline({
  win,
  now,
  runs,
  events,
  rulings,
  onlyLane,
}: {
  win: TimeWindow;
  now: number;
  runs: RunMark[];
  events: PointEvent[];
  rulings: RulingRow[];
  /** When a node of the map is pressed, the timeline holds that lane alone. */
  onlyLane: Lane | null;
}) {
  const [on, setOn] = useState<string | null>(null);

  const byLane: Record<Lane, Mark[]> = {
    sessions: [],
    workers: [],
    runners: [],
    rulings: [],
    merges: [],
    failures: [],
  };

  for (const run of runs) {
    byLane[laneOfRun(run)].push({
      key: run.runId,
      start: run.startedAt,
      end: Math.min(barEnd(run, now), win.to),
      href: runHref(run.runId),
      words: [
        run.kind,
        run.cli,
        run.model ?? "no model on the row",
        run.host,
        run.status,
        run.endedReason ?? "",
        dayAndClock(run.startedAt),
      ]
        .filter((part) => part !== "")
        .join(" · "),
      tone: run.status === "running" ? "running" : run.status === "failed" ? "failed" : "plain",
    });
  }
  for (const ruling of rulings) {
    byLane.rulings.push({
      key: ruling.id,
      start: ruling.ruledAt,
      end: ruling.ruledAt,
      href: rulingHref(ruling),
      words: `${ruling.verdict} · ${ruling.subject} · ${dayAndClock(ruling.ruledAt)}`,
      tone: "accent",
    });
  }
  for (const event of events) {
    if (event.kind === "merge") {
      const row = mergeRowOf(event);
      byLane.merges.push({
        key: event.id,
        start: event.at,
        end: event.at,
        href: mergeHref(row),
        words: `${row.repo ?? ""}@${(row.sha ?? "").slice(0, 7)} ${row.subject ?? ""} · ${dayAndClock(event.at)}`,
        tone: "plain",
      });
      continue;
    }
    if (isFailure(event.kind)) {
      const row = failureRowOf(event);
      byLane.failures.push({
        key: event.id,
        start: event.at,
        end: event.at,
        href: row.todoId === null ? null : `/tts?item=${row.todoId}`,
        words: `${row.job} · ${event.kind} · ${dayAndClock(event.at)}`,
        tone: "failed",
      });
    }
  }

  const span = win.to - win.from;
  const gap = span * GAP_FRACTION;
  const marksByKey = new Map<string, Mark>();
  for (const lane of LANES) for (const mark of byLane[lane]) marksByKey.set(mark.key, mark);

  return (
    <div className="rounded-lg border border-border bg-surface/40">
      <Axis win={win} />
      <div className="divide-y divide-border">
        {LANES.filter((lane) => onlyLane === null || onlyLane === lane).map((lane) => {
          const marks = byLane[lane];
          const rows = packRows(marks, (m) => m.start, (m) => m.end, gap, MAX_ROWS);
          const used = rows.length === 0 ? 1 : Math.max(...rows) + 1;
          return (
            <div key={lane} className="flex items-start gap-2 px-2 py-1">
              <div className="w-20 shrink-0 pt-0.5 text-[11px] text-text-muted">{lane}</div>
              <div className="w-10 shrink-0 pt-0.5 text-right text-[11px] font-mono text-text-faint">
                {marks.length}
              </div>
              <div className="relative flex-1" style={{ height: used * ROW_H + 4 }}>
                {marks.map((mark, index) => (
                  <MarkBar
                    key={mark.key}
                    mark={mark}
                    row={rows[index]}
                    win={win}
                    gap={gap}
                    onEnter={() => setOn(mark.key)}
                    onLeave={() => setOn((current) => (current === mark.key ? null : current))}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="h-6 truncate border-t border-border px-2 py-1 text-[11px] font-mono text-text-muted">
        {on === null ? "" : (marksByKey.get(on)?.words ?? "")}
      </div>
    </div>
  );
}

function MarkBar({
  mark,
  row,
  win,
  gap,
  onEnter,
  onLeave,
}: {
  mark: Mark;
  row: number;
  win: TimeWindow;
  gap: number;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const left = fractionOf(mark.start, win);
  const right = fractionOf(Math.max(mark.end, mark.start + gap), win);
  const tone =
    mark.tone === "running"
      ? "bg-success/70 hover:bg-success"
      : mark.tone === "failed"
        ? "bg-error/70 hover:bg-error"
        : mark.tone === "accent"
          ? "bg-accent/70 hover:bg-accent"
          : "bg-text-faint/60 hover:bg-text-muted";
  const style = {
    left: `${left * 100}%`,
    width: `${Math.max(0.3, (right - left) * 100)}%`,
    top: row * ROW_H,
    height: BAR_H,
  };
  const shared = {
    style,
    className: `absolute rounded-[2px] ${tone}`,
    onMouseEnter: onEnter,
    onMouseLeave: onLeave,
    onFocus: onEnter,
    onBlur: onLeave,
    "aria-label": mark.words,
  };
  if (mark.href === null) return <div {...shared} />;
  if (mark.href.startsWith("http")) {
    return <a {...shared} href={mark.href} target="_blank" rel="noreferrer" />;
  }
  return <Link {...shared} href={mark.href} />;
}

/** Seven ticks across the window, in the reader's own clock. */
function Axis({ win }: { win: TimeWindow }) {
  const ticks = Array.from({ length: 7 }, (_, index) => win.from + ((win.to - win.from) * index) / 6);
  const label = (at: number) =>
    win.kind === "day"
      ? new Date(at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
      : new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return (
    <div className="flex items-center gap-2 border-b border-border px-2 py-1">
      <div className="w-20 shrink-0" />
      <div className="w-10 shrink-0" />
      <div className="relative h-4 flex-1">
        {ticks.map((at, index) => (
          <span
            key={at}
            className="absolute top-0 text-[10px] font-mono text-text-faint"
            style={{
              left: `${(index / 6) * 100}%`,
              transform:
                index === 0 ? "none" : index === 6 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            {label(at)}
          </span>
        ))}
      </div>
    </div>
  );
}
