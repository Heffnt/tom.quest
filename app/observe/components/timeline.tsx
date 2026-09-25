"use client";

// THE TIMELINE. Seven lanes across the selected window: the three kinds of run
// as bars from start to end, and the four kinds of point — a ruling, a merge, a
// failure, a change to the box or a deploy of it — as marks at the instant they
// happened. A run still going runs to the right edge.
//
// A LANE WITH NOTHING IN IT IS ONE THIN LINE with its name and a nought, not a
// band of empty rows: a window where nothing merged should say so in the space
// that fact deserves.
//
// THE WORKERS LANE IS GROUPED BY JOB. Every run of a scheduled job carries
// `origin: "cron:<job>"`, so one row is one job and its runs are the marks
// along it — seven hundred runs of the time-note job are one row that says
// seven hundred. A subagent, a delegate call or anything an orchestrator
// spawned carries no such origin and keeps a row of its own, because those are
// the runs worth seeing one at a time. Sessions and runners stay one row per
// run.
//
// PRESSING A MARK OPENS IT AND DOES NOT LEAVE: the run's outcome appears under
// the lanes, in a strip of fixed height so nothing moves, with one link to its
// agent page on this site.

import { useState } from "react";
import Link from "next/link";
import { LANES, type Lane } from "../map-data";
import Terms from "./terms";
import {
  barEnd,
  boxRowOf,
  dayAndClock,
  failureRowOf,
  fractionOf,
  isBoxEvent,
  isFailure,
  jobOfRun,
  laneOfRun,
  lasted,
  mergeRowOf,
  outcomeWords,
  packRows,
  rulingHref,
  agentHref,
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
  /** The lines the mark opens to, each in the record's own words. */
  detail: string[];
  /** Where the detail's one link goes, on this site. */
  href: string | null;
  hrefWords: string | null;
  tone: "running" | "failed" | "plain" | "accent";
};

/** One drawn band: a lane's own marks, or one job's. */
type Band = { name: string | null; marks: Mark[] };

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
  // THE KEY, NOT THE MARK. What is drawn is rebuilt from the rows on every
  // tick and every change of window or filter, so holding the mark itself
  // would leave the strip below showing a run as it was when it was pressed —
  // still running after it ended, or from a window that has since moved.
  const [openKey, setOpenKey] = useState<string | null>(null);

  const runMark = (run: RunMark): Mark => ({
    key: run.runId,
    start: run.startedAt,
    end: Math.min(barEnd(run, now), win.to),
    detail: [
      `${run.kind} · ${run.cli} · ${run.model ?? "no model on the row"} · ${run.host}`,
      `started ${dayAndClock(run.startedAt)} · ran ${lasted(run, now)}`,
      outcomeWords(run).join(" · "),
      ...(run.gitBranch === null ? [] : [run.gitBranch]),
    ],
    href: agentHref(run.runId),
    hrefWords: "open the agent",
    tone: run.status === "running" ? "running" : run.status === "failed" ? "failed" : "plain",
  });

  const sessions: Mark[] = [];
  const runners: Mark[] = [];
  const byJob = new Map<string, Mark[]>();
  const spawned: Mark[] = [];
  for (const run of runs) {
    const lane = laneOfRun(run);
    if (lane === "sessions") {
      sessions.push(runMark(run));
      continue;
    }
    if (lane === "runners") {
      runners.push(runMark(run));
      continue;
    }
    const job = jobOfRun(run);
    if (job === null) {
      spawned.push(runMark(run));
      continue;
    }
    const held = byJob.get(job);
    if (held === undefined) byJob.set(job, [runMark(run)]);
    else held.push(runMark(run));
  }

  const rulingMarks: Mark[] = rulings.map((ruling) => ({
    key: ruling.id,
    start: ruling.ruledAt,
    end: ruling.ruledAt,
    detail: [
      `${ruling.verdict} on a ${ruling.subjectType} subject`,
      ruling.subject,
      ...(ruling.sentence === null ? [] : [ruling.sentence]),
      ...(ruling.quote === null ? [] : [`his words: ${ruling.quote}`]),
      dayAndClock(ruling.ruledAt),
    ].filter((line) => line !== ""),
    href: rulingHref(ruling),
    hrefWords: rulingHref(ruling) === null ? null : "open the subject",
    tone: "accent",
  }));

  const mergeMarks: Mark[] = [];
  const failureMarks: Mark[] = [];
  const boxMarks: Mark[] = [];
  for (const event of events) {
    if (isBoxEvent(event.kind)) {
      const row = boxRowOf(event);
      boxMarks.push({
        key: event.id,
        start: row.at,
        end: row.at,
        detail: [row.title, ...row.lines, dayAndClock(row.at)],
        href: row.agentId === null ? null : agentHref(row.agentId),
        hrefWords: row.agentId === null ? null : "open the agent",
        tone: row.changed ? "accent" : "plain",
      });
      continue;
    }
    if (event.kind === "merge") {
      const row = mergeRowOf(event);
      mergeMarks.push({
        key: event.id,
        start: event.at,
        end: event.at,
        detail: [
          row.subject ?? "",
          `${row.repo ?? ""}@${(row.sha ?? "").slice(0, 7)}`,
          row.mainCheck ?? "",
          dayAndClock(event.at),
        ].filter((line) => line !== ""),
        href: null,
        hrefWords: null,
        tone: "plain",
      });
      continue;
    }
    if (isFailure(event.kind)) {
      const row = failureRowOf(event);
      failureMarks.push({
        key: event.id,
        start: event.at,
        end: event.at,
        detail: [`the ${row.job} job failed`, event.kind, dayAndClock(event.at)],
        href: row.todoId === null ? null : `/tts?item=${row.todoId}`,
        hrefWords: row.todoId === null ? null : "open the todo",
        tone: "failed",
      });
    }
  }

  const jobBands: Band[] = [...byJob.entries()]
    .sort((left, right) => right[1].length - left[1].length || (left[0] < right[0] ? -1 : 1))
    .map(([job, marks]) => ({ name: job, marks }));

  const bands: Record<Lane, Band[]> = {
    sessions: [{ name: null, marks: sessions }],
    workers: [...jobBands, ...(spawned.length === 0 ? [] : [{ name: "spawned", marks: spawned }])],
    runners: [{ name: null, marks: runners }],
    rulings: [{ name: null, marks: rulingMarks }],
    merges: [{ name: null, marks: mergeMarks }],
    failures: [{ name: null, marks: failureMarks }],
    box: [{ name: null, marks: boxMarks }],
  };

  const gap = (win.to - win.from) * GAP_FRACTION;

  return (
    <div className="rounded-lg border border-border bg-surface/40">
      <Axis win={win} />
      <div className="divide-y divide-border">
        {LANES.filter((lane) => onlyLane === null || onlyLane === lane).map((lane) => {
          const rows = bands[lane];
          const total = rows.reduce((sum, row) => sum + row.marks.length, 0);
          if (total === 0) {
            return (
              <div key={lane} className="flex items-center gap-2 px-2 py-0.5">
                <div className="w-24 shrink-0 text-[11px] text-text-faint">{lane}</div>
                <div className="w-10 shrink-0 text-right text-[11px] font-mono text-text-faint">0</div>
                <div className="h-px flex-1 bg-border" />
              </div>
            );
          }
          return (
            <div key={lane} className="px-2 py-1">
              {rows.map((row, index) => (
                <Row
                  key={row.name ?? lane}
                  name={row.name ?? lane}
                  indented={row.name !== null}
                  lead={index === 0 ? lane : null}
                  band={row}
                  win={win}
                  gap={gap}
                  onOpen={(mark) => setOpenKey(mark.key)}
                  openKey={openKey}
                />
              ))}
            </div>
          );
        })}
      </div>
      <Detail
        mark={
          // The lanes actually drawn, so holding the timeline to one lane
          // closes a mark opened in another rather than leaving its lines
          // under lanes that no longer hold it.
          LANES.filter((lane) => onlyLane === null || onlyLane === lane)
            .flatMap((lane) => bands[lane])
            .flatMap((band) => band.marks)
            .find((mark) => mark.key === openKey) ?? null
        }
        onClose={() => setOpenKey(null)}
      />
    </div>
  );
}

function Row({
  name,
  indented,
  lead,
  band,
  win,
  gap,
  onOpen,
  openKey,
}: {
  name: string;
  /** A job's row, which sits under its lane's name. */
  indented: boolean;
  /** The lane this row opens, when it is the first of its lane. */
  lead: Lane | null;
  band: Band;
  win: TimeWindow;
  gap: number;
  onOpen: (mark: Mark) => void;
  openKey: string | null;
}) {
  const rows = packRows(band.marks, (m) => m.start, (m) => m.end, gap, MAX_ROWS);
  // A band is only drawn with marks in it — a lane holding none returns its
  // one thin line above — and packRows answers one row number per mark, so
  // there is always at least one.
  const used = Math.max(...rows) + 1;
  return (
    <div className="flex items-start gap-2 py-0.5">
      <div
        className={`w-24 shrink-0 truncate pt-0.5 text-[11px] ${
          indented ? "pl-2 text-text-faint" : "text-text-muted"
        }`}
        title={lead === null ? name : `${lead}: ${name}`}
      >
        {name}
      </div>
      <div className="w-10 shrink-0 pt-0.5 text-right text-[11px] font-mono text-text-faint">
        {band.marks.length}
      </div>
      <div className="relative flex-1" style={{ height: used * ROW_H + 4 }}>
        {band.marks.map((mark, index) => (
          <MarkBar
            key={mark.key}
            mark={mark}
            row={rows[index]}
            win={win}
            gap={gap}
            open={openKey === mark.key}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  );
}

function MarkBar({
  mark,
  row,
  win,
  gap,
  open,
  onOpen,
}: {
  mark: Mark;
  row: number;
  win: TimeWindow;
  gap: number;
  open: boolean;
  onOpen: (mark: Mark) => void;
}) {
  const left = fractionOf(mark.start, win);
  const right = fractionOf(Math.max(mark.end, mark.start + gap), win);
  const tone = open
    ? "bg-accent"
    : mark.tone === "running"
      ? "bg-success/70 hover:bg-success"
      : mark.tone === "failed"
        ? "bg-error/70 hover:bg-error"
        : mark.tone === "accent"
          ? "bg-accent/70 hover:bg-accent"
          : "bg-text-faint/60 hover:bg-text-muted";
  return (
    <button
      type="button"
      onClick={() => onOpen(mark)}
      aria-label={mark.detail[0]}
      aria-expanded={open}
      title={mark.detail[0]}
      className={`absolute rounded-[2px] ${tone}`}
      style={{
        left: `${left * 100}%`,
        width: `${Math.max(0.3, (right - left) * 100)}%`,
        top: row * ROW_H,
        height: BAR_H,
      }}
    />
  );
}

/** What a pressed mark opens to: the record's own lines about it, and the one
 *  link, which is a page of this site. Its height is fixed, so opening a mark
 *  moves nothing above it. */
function Detail({ mark, onClose }: { mark: Mark | null; onClose: () => void }) {
  return (
    <div className="h-[4.25rem] overflow-hidden border-t border-border px-2 py-1.5">
      {mark === null ? null : (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-0.5">
            {mark.detail.map((line, index) => (
              <Terms
                key={index}
                text={line}
                className={`block truncate text-[11px] ${
                  index === 0 ? "text-text" : "font-mono text-text-muted"
                }`}
              />
            ))}
          </div>
          {mark.href !== null && (
            <Link
              href={mark.href}
              className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-text-muted hover:border-text-faint hover:text-text"
            >
              {mark.hrefWords}
            </Link>
          )}
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-text-muted hover:border-text-faint hover:text-text"
          >
            close
          </button>
        </div>
      )}
    </div>
  );
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
      <div className="w-24 shrink-0" />
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
