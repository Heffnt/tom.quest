"use client";

// THE INTENT PAGE. Every line of his intent, from all four of the places it is
// written, in one list: his directions, the rules that stand, his rulings, and
// what he said about a run's output.
//
// ITS JOB IS DRIFT. Each line arrives with its kind, its date, the file and
// line (or the table and row) it is written in, whether it is his own words or
// an inference, and the evidence behind it — so a line nobody can trace, a line
// nothing of his supports, and a line that has not been said since last spring
// all look different from the rest without anybody explaining them.
//
// NEWEST FIRST. The query sorts by when a line was last said, undated last, and
// the groups keep that order, so what moved lately is at the top of its kind.
//
// NOTHING IS WRITTEN HERE. The page reads five homes in the record and writes
// none of them; a line changes where it is written, which is a file he edits or
// a ruling he gives.

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import LineDrawer from "./components/line-drawer";
import LineList from "./components/line-list";
import {
  countVoices,
  dateLabel,
  filterLines,
  groupByKind,
  sourcesOf,
  KINDS,
  NO_FILTERS,
  VOICES,
  type Filters,
  type IntentLine,
} from "./lib";

export default function IntentClient() {
  const { isTom } = useAuth();
  const answer = useQuery(api.intent.lines, isTom ? {} : "skip");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [selected, setSelected] = useState<IntentLine | null>(null);

  const lines = useMemo(() => answer?.lines ?? [], [answer]);
  const shown = useMemo(() => filterLines(lines, filters), [lines, filters]);
  const groups = useMemo(() => groupByKind(shown), [shown]);
  const sources = useMemo(() => sourcesOf(lines), [lines]);
  const voices = useMemo(() => countVoices(shown), [shown]);
  const newest = shown.find((line) => line.at !== null);

  return (
    <TomGate label="Intent">
      <div className="w-full px-3 py-5 sm:px-5">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold tracking-tight">intent</h1>
          <span className="text-[11px] font-mono text-text-faint">
            {answer === undefined
              ? "…"
              : `${shown.length} of ${lines.length} lines · ${voices.his} his · ${voices.inferred} inferred`
                + `${newest === undefined ? "" : ` · newest ${dateLabel(newest)}`}`
                + `${answer.capped ? " · capped" : ""}`}
          </span>
        </header>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Group>
            <Pick on={filters.kind === "all"} onClick={() => setFilters((f) => ({ ...f, kind: "all" }))}>
              every kind
            </Pick>
            {KINDS.map((kind) => (
              <Pick
                key={kind}
                on={filters.kind === kind}
                onClick={() => setFilters((f) => ({ ...f, kind }))}
              >
                {kind}
              </Pick>
            ))}
          </Group>
          <Group>
            <Pick on={filters.voice === "all"} onClick={() => setFilters((f) => ({ ...f, voice: "all" }))}>
              every voice
            </Pick>
            {VOICES.map((voice) => (
              <Pick
                key={voice}
                on={filters.voice === voice}
                onClick={() => setFilters((f) => ({ ...f, voice }))}
              >
                {voice}
              </Pick>
            ))}
          </Group>
          <Group>
            <Pick on={filters.source === "all"} onClick={() => setFilters((f) => ({ ...f, source: "all" }))}>
              every source
            </Pick>
            {sources.map((source) => (
              <Pick
                key={source}
                on={filters.source === source}
                onClick={() => setFilters((f) => ({ ...f, source }))}
              >
                {source}
              </Pick>
            ))}
          </Group>
        </div>

        {answer !== undefined && (
          <p className="mt-2 text-[10px] font-mono text-text-faint">
            {answer.sources
              .map((source) => `${source.name} ${source.lines}`)
              .join(" · ")}
          </p>
        )}

        <div className="mt-3">
          <LineList groups={groups} selected={selected?.id ?? null} onSelect={setSelected} />
        </div>
      </div>
      <LineDrawer line={selected} onClose={() => setSelected(null)} />
    </TomGate>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-surface/40 p-0.5">
      {children}
    </div>
  );
}

function Pick({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-[11px] ${
        on ? "bg-accent-dim text-accent" : "text-text-muted hover:bg-surface-alt hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}
