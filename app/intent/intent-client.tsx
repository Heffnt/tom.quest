"use client";

// THE INTENT PAGE: his intent as an agent reads it, and everything that
// stands beside it, in four views.
//
// AS AN AGENT READS IT (the default). What an agent whose output reaches him
// is given, in the order it reads it: the prompt assembleContext builds
// (intent.agentView). Every bullet of his model-of-tom pages in that text
// opens the same evidence the list below shows for it.
//
// EVERY LINE. Every line of his intent, from all four of the places it is
// written, in one list: his directions, the rules that stand, his rulings, and
// what he said about a run's output. Each line arrives with its kind, its
// date, the file and line (or the table and row) it is written in, whose
// words it is, the evidence behind it, and — for a ruling an eval item tests —
// how often the judge answered as he did. Newest first, undated last.
//
// His rulings are the same list with the kind picked (every line, "ruling"):
// one filter, not a view of their own.
//
// VOCABULARY. Every word as `tts search` prints it (vocabulary.tsx). The
// /vocabulary page was this view; its address redirects here.
//
// DISAGREEMENTS. What stands as his until he says otherwise: the delegate's
// decisions beside the lines they rested on, the eval items the judge failed,
// and the words the spec and the code disagree on. The first two he settles
// here (jarvis/intent.settle); the words he settles in the files.

import { useEffect, useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import Info from "@/app/jarvis/components/info";
import AgentText from "./components/agent-text";
import Decisions from "./components/decisions";
import LineDrawer from "./components/line-drawer";
import LineList from "./components/line-list";
import { Group, Pick } from "./components/picks";
import Vocabulary from "./components/vocabulary";
import VocabularyDisagreements from "./components/vocabulary-disagreements";
import {
  countVoices,
  dateLabel,
  evalItemsForLine,
  filterLines,
  groupByKind,
  linesRestedOn,
  openDisagreements,
  passRate,
  sourcesOf,
  KINDS,
  VOICES,
  type IntentLine,
} from "./lib";
import { INTENT_VIEWS, useIntentStore, type IntentView } from "./store";

const VIEW_TITLE: Record<IntentView, string> = {
  agent: "as an agent reads it",
  lines: "every line",
  vocabulary: "vocabulary",
  disagreements: "disagreements",
};

export default function IntentClient() {
  const { isTom } = useAuth();
  const { view, filters, selected, setView, setFilters, select } = useIntentStore();
  const answer = useQuery(api.intent.lines, isTom ? {} : "skip");
  const agent = useQuery(api.intent.agentView, isTom && view === "agent" ? {} : "skip");
  // Read on every view: the disagreements badge counts its disagreements.
  const vocabulary = useQuery(api.vocabulary.current, isTom ? {} : "skip");
  const decisions = useQuery(api.jarvis.intent.decisions, isTom ? {} : "skip");
  const evalItems = useQuery(api.jarvis.intent.evalItems, isTom ? {} : "skip");
  const settle = useMutation(api.jarvis.intent.settle);

  // The /vocabulary address redirects to /intent#vocabulary: the fragment
  // picks the view once, on arrival, and moves nothing.
  useEffect(() => {
    const wanted = window.location.hash.slice(1);
    if ((INTENT_VIEWS as string[]).includes(wanted)) setView(wanted as IntentView);
  }, [setView]);

  const lines = useMemo(() => answer?.lines ?? [], [answer]);
  const shown = useMemo(
    () => filterLines(lines, filters),
    [lines, filters],
  );
  const groups = useMemo(() => groupByKind(shown), [shown]);
  const sources = useMemo(() => sourcesOf(lines), [lines]);
  const voices = useMemo(() => countVoices(shown), [shown]);
  const newest = shown.find((line) => line.at !== null);
  const evals = useMemo(() => {
    const byLine = new Map<string, { passed: number; runs: number }>();
    for (const line of lines) {
      const rate = passRate(evalItemsForLine(line, evalItems ?? []));
      if (rate !== null) byLine.set(line.id, rate);
    }
    return byLine;
  }, [lines, evalItems]);
  const decisionsByLine = useMemo(() => {
    const count = new Map<string, number>();
    for (const decision of decisions ?? []) {
      for (const line of lines) {
        if (decision.restedOn.some((ref) => matchesLine(ref, line))) count.set(line.id, (count.get(line.id) ?? 0) + 1);
      }
    }
    return count;
  }, [lines, decisions]);
  const open = openDisagreements(decisions, evalItems, vocabulary);

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
                  : `WikiTom ${agent.commit.slice(0, 12)}`
              : view === "vocabulary" || view === "disagreements"
                ? open === null
                  ? "…"
                  : `${open} open`
                : answer === undefined
                  ? "…"
                  : `${shown.length} of ${lines.length} lines · ${voices.his} his · ${voices.inferred} inferred`
                    + `${newest === undefined ? "" : ` · newest ${dateLabel(newest)}`}`
                    + `${answer.capped ? " · capped" : ""}`}
          </span>
        </header>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Group>
            {INTENT_VIEWS.map((name) => (
              <Pick key={name} on={view === name} onClick={() => setView(name)}>
                {VIEW_TITLE[name]}
                {name === "disagreements" && open !== null && open > 0 ? ` (${open})` : ""}
              </Pick>
            ))}
          </Group>
          {view === "agent" && (
            <>
              <Info call="intent.agentView({})" side="below">
                Reads the prompt assembleContext builds for a run whose output reaches Tom
                {agent ? ` at WikiTom commit ${agent.commit.slice(0, 12)}` : ""}: the base, the write pages and the
                skills line. A subagent gets agent-rules.md through the CLAUDE.md import instead, with no header line.
              </Info>
            </>
          )}
          {view === "lines" && (
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

        <div className="mt-3">
          {view === "agent" && agent != null && (
            <AgentText view={agent} lines={lines} selected={selected?.id ?? null} onSelect={select} />
          )}
          {view === "lines" && (
            <>
              {answer !== undefined && (
                <p className="mb-2 text-[10px] font-mono text-text-faint">
                  {answer.sources.map((source) => `${source.name} ${source.lines}`).join(" · ")}
                </p>
              )}
              <LineList
                groups={groups}
                selected={selected?.id ?? null}
                onSelect={select}
                evals={evals}
                decisions={decisionsByLine}
              />
            </>
          )}
          {view === "vocabulary" && <Vocabulary answer={vocabulary} />}
          {view === "disagreements" && (
            <div className="space-y-5">
              <Decisions
                decisions={decisions ?? []}
                evalItems={evalItems ?? []}
                lines={lines}
                selected={selected?.id ?? null}
                onSelect={select}
                onSettle={settle}
              />
              {vocabulary != null && <VocabularyDisagreements rows={vocabulary.disagreements} />}
            </div>
          )}
        </div>
      </div>
      <LineDrawer
        line={selected}
        onClose={() => select(null)}
        evalItems={selected === null ? [] : evalItemsForLine(selected, evalItems ?? [])}
        decisions={selected === null ? [] : (decisions ?? []).filter((one) => one.restedOn.some((ref) => matchesLine(ref, selected)))}
      />
    </TomGate>
  );
}

function matchesLine(ref: string, line: IntentLine): boolean {
  return linesRestedOn(ref, [line]).length > 0;
}
