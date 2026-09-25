"use client";

// THE INTENT PAGE, in two views.
//
// AS AN AGENT READS IT (the default). What one caller's agent is given, in
// the order it reads it: the prompt prefix and grant block assembleContext
// builds for that caller, the harness's skill listing, and each granted
// skill's body (intent.agentView). Every bullet of his three model-of-tom pages
// in that text opens the same evidence the list below shows for it.
//
// EVERY LINE. Every line of his intent, from all four of the places it is
// written, in one list: his directions, the rules that stand, his rulings, and
// what he said about a run's output. Most of it never reaches a prompt (the
// rulings, the labels, the AGENTS.md rules, the steering and the spec's
// revision notes), which is why it stays: its job is drift. Each line arrives
// with its kind, its date, the file and line (or the table and row) it is
// written in, whether it is his own words or an inference, and the evidence
// behind it — so a line nobody can trace, a line nothing of his supports, and a
// line that has not been said since last spring all look different from the
// rest without anybody explaining them. Newest first, undated last.
//
// NOTHING IS WRITTEN HERE. The page reads the record and writes none of it; a
// line changes where it is written, which is a file he edits or a ruling he
// gives.

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AGENT_VIEW_CALLERS } from "@/convex/intentParse";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import Info from "@/app/tts/components/info";
import AgentText from "./components/agent-text";
import LineDrawer from "./components/line-drawer";
import LineList from "./components/line-list";
import {
  countVoices,
  dateLabel,
  filterLines,
  groupByKind,
  sourcesOf,
  KINDS,
  VOICES,
} from "./lib";
import { useIntentStore } from "./store";

export default function IntentClient() {
  const { isTom } = useAuth();
  const { view, caller, filters, selected, setView, setCaller, setFilters, select } = useIntentStore();
  const answer = useQuery(api.intent.lines, isTom ? {} : "skip");
  const agent = useQuery(api.intent.agentView, isTom && view === "agent" ? { caller } : "skip");

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
            {view === "agent"
              ? agent === undefined
                ? "…"
                : agent === null
                  ? "no model-of-tom publication in the record"
                  : `${caller} · ${agent.skills.length} skills granted · WikiTom ${agent.commit.slice(0, 12)}`
              : answer === undefined
                ? "…"
                : `${shown.length} of ${lines.length} lines · ${voices.his} his · ${voices.inferred} inferred`
                  + `${newest === undefined ? "" : ` · newest ${dateLabel(newest)}`}`
                  + `${answer.capped ? " · capped" : ""}`}
          </span>
        </header>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Group>
            <Pick on={view === "agent"} onClick={() => setView("agent")}>
              as an agent reads it
            </Pick>
            <Pick on={view === "lines"} onClick={() => setView("lines")}>
              every line
            </Pick>
          </Group>
          {view === "agent" ? (
            <>
              <Group>
                {AGENT_VIEW_CALLERS.map((name) => (
                  <Pick key={name} on={caller === name} onClick={() => setCaller(name)}>
                    {name}
                  </Pick>
                ))}
              </Group>
              <Info call={`intent.agentView({ caller: "${caller}" })`} side="below">
                Reads the prompt prefix and grant block assembleContext builds for this caller
                {agent ? ` at WikiTom commit ${agent.commit.slice(0, 12)}` : ""}, then the body of each skill it
                grants. A subagent gets agent-rules.md through the CLAUDE.md import instead, with no header line.
              </Info>
            </>
          ) : (
            <>
              <Group>
                <Pick on={filters.kind === "all"} onClick={() => setFilters({ kind: "all" })}>
                  every kind
                </Pick>
                {KINDS.map((kind) => (
                  <Pick key={kind} on={filters.kind === kind} onClick={() => setFilters({ kind })}>
                    {kind}
                  </Pick>
                ))}
              </Group>
              <Group>
                <Pick on={filters.voice === "all"} onClick={() => setFilters({ voice: "all" })}>
                  every voice
                </Pick>
                {VOICES.map((voice) => (
                  <Pick key={voice} on={filters.voice === voice} onClick={() => setFilters({ voice })}>
                    {voice}
                  </Pick>
                ))}
              </Group>
              <Group>
                <Pick on={filters.source === "all"} onClick={() => setFilters({ source: "all" })}>
                  every source
                </Pick>
                {sources.map((source) => (
                  <Pick key={source} on={filters.source === source} onClick={() => setFilters({ source })}>
                    {source}
                  </Pick>
                ))}
              </Group>
            </>
          )}
        </div>

        {view === "agent" ? (
          agent != null && (
            <div className="mt-3">
              <AgentText view={agent} lines={lines} selected={selected?.id ?? null} onSelect={select} />
            </div>
          )
        ) : (
          <>
            {answer !== undefined && (
              <p className="mt-2 text-[10px] font-mono text-text-faint">
                {answer.sources
                  .map((source) => `${source.name} ${source.lines}`)
                  .join(" · ")}
              </p>
            )}
            <div className="mt-3">
              <LineList groups={groups} selected={selected?.id ?? null} onSelect={select} />
            </div>
          </>
        )}
      </div>
      <LineDrawer line={selected} onClose={() => select(null)} />
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
