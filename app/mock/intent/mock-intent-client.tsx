"use client";

// A MOCKUP of the intent page: the model of Tom as the record holds it, as five
// collapsible sections, each the answer to one question an assistant asks.
// Directions, priorities and rulings come from intent.lines (the /intent
// page's own read); writing, ground and the area pages from intent.pages.

import { useMemo } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import type { IntentLine } from "@/app/intent/lib";
import { RULINGS_STEP, useMockIntentStore, type SectionKey } from "./store";

type Group = { label: string; value?: string; lines: IntentLine[] | null; count?: number };

const INFERRED = /\s*\(inferred\)\s*$/;

function bySection(lines: IntentLine[]): Group[] {
  const groups: Group[] = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === line.section) last.lines!.push(line);
    else groups.push({ label: line.section, lines: [line] });
  }
  return groups;
}

function inFileOrder(lines: IntentLine[]): IntentLine[] {
  const at = (line: IntentLine) => Number(line.locator.replace("line ", ""));
  return [...lines].sort((left, right) => at(left) - at(right));
}

function shortDate(ms: number | null): string {
  if (ms === null) return "";
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
}

function countOf(groups: Group[]): number {
  return groups.reduce((sum, group) => sum + (group.count ?? group.lines?.length ?? 0), 0);
}

function inferredOf(groups: Group[]): number {
  return groups.reduce(
    (sum, group) => sum + (group.lines?.filter((line) => line.voice === "inferred").length ?? 0),
    0,
  );
}

function Line({ line, value }: { line: IntentLine; value?: string }) {
  const inferred = line.voice === "inferred";
  return (
    <li className="flex items-baseline gap-4 py-1 break-inside-avoid">
      <span className="min-w-0 flex-1 text-sm leading-snug text-text/90">{line.text.replace(INFERRED, "")}</span>
      {value !== undefined ? (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-faint">{value}</span>
      ) : inferred ? (
        <span className="shrink-0 font-mono text-[10px] text-text-faint">inferred</span>
      ) : null}
    </li>
  );
}

function GroupBlock({ group }: { group: Group }) {
  const sub = group.lines === null ? [] : bySection(group.lines);
  const nested = group.value !== undefined && sub.length > 1;
  return (
    <div className="mb-6 break-inside-avoid">
      <div className="mb-1.5 flex items-baseline justify-between gap-4 border-b border-border/60 pb-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{group.label}</h3>
        {group.value !== undefined && (
          <span className="font-mono text-[11px] tabular-nums text-text-faint">{group.value}</span>
        )}
      </div>
      {group.lines === null ? null : nested ? (
        sub.map((part) => (
          <div key={part.label} className="mb-2">
            <div className="pt-1 text-[11px] text-text-faint">{part.label}</div>
            <ul>{part.lines!.map((line) => <Line key={line.id} line={line} />)}</ul>
          </div>
        ))
      ) : (
        <ul>{group.lines.map((line) => <Line key={line.id} line={line} />)}</ul>
      )}
    </div>
  );
}

function Section({
  id,
  question,
  groups,
  counted = [],
  children,
}: {
  id: SectionKey;
  question: string;
  groups: Group[];
  /** Groups the section draws itself (children) but still counts. */
  counted?: Group[];
  children?: React.ReactNode;
}) {
  const open = useMockIntentStore((state) => state.open[id]);
  const toggle = useMockIntentStore((state) => state.toggle);
  const inferred = inferredOf([...groups, ...counted]);
  return (
    <section className="border-t border-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => toggle(id)}
        className="flex w-full items-baseline gap-3 py-3.5 text-left hover:bg-surface/40"
      >
        <span className={`w-3 shrink-0 text-[10px] text-text-faint transition-transform ${open ? "rotate-90" : ""}`}>
          ▶
        </span>
        <span className="min-w-0 flex-1 text-base font-semibold text-text">{question}</span>
        {inferred > 0 && <span className="shrink-0 font-mono text-[11px] text-text-faint">{inferred} inferred</span>}
        <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-text-muted">
          {countOf([...groups, ...counted])}
        </span>
      </button>
      {open && (
        <div className="pb-6 pl-6">
          <div className="lg:columns-2 lg:gap-x-14">
            {groups.map((group) => <GroupBlock key={group.label} group={group} />)}
          </div>
          {children}
          <label className="mt-2 block max-w-[34rem]">
            <span className="mb-1 block text-[11px] text-text-faint">object or correct</span>
            <textarea
              rows={2}
              className="block w-full resize-y rounded-md border border-border bg-surface/40 px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </label>
        </div>
      )}
    </section>
  );
}

export default function MockIntentClient() {
  const { isTom } = useAuth();
  const answer = useQuery(api.intent.lines, isTom ? {} : "skip");
  const pages = useQuery(api.intent.pages, isTom ? {} : "skip");
  return (
    <TomGate label="Intent">
      <IntentModel answer={answer} pages={pages} />
    </TomGate>
  );
}

function IntentModel({
  answer,
  pages,
}: {
  answer: FunctionReturnType<typeof api.intent.lines> | undefined;
  pages: FunctionReturnType<typeof api.intent.pages> | undefined;
}) {
  const rulingsShown = useMockIntentStore((state) => state.rulingsShown);
  const showMoreRulings = useMockIntentStore((state) => state.showMoreRulings);

  const view = useMemo(() => {
    const lines = answer?.lines ?? [];
    const from = (source: string) => inFileOrder(lines.filter((line) => line.source === source));
    const intent = bySection(from("model-of-tom/intent.md"));
    const priorities = bySection(from("model-of-tom/priorities.md"));
    // This exclusion cannot be deleted because the writing rules forbid writing any verdict or status as Tom's; a ruling row with a verdict and no sentence of his would render as his word.
    const rulings = lines.filter((line) => line.kind === "ruling" && line.source === "rulings" && (line.sentence?.trim() ?? "") !== "");
    const page = (name: string) => pages?.find((row) => row.name === name);
    const write = page("writing")?.lines ?? [];
    const ground = page("ground")?.lines ?? [];
    const areas: Group[] = (pages ?? [])
      .filter((row) => row.name.startsWith("areas/"))
      .map((row) => ({
        label: row.name.slice("areas/".length).replace(/-/g, " "),
        value: row.lines === null ? `${row.count} lines` : row.updated === null ? undefined : shortDate(Date.parse(`${row.updated}T12:00:00Z`)),
        lines: row.lines,
        count: row.count,
      }));
    return {
      toward: [...intent.filter((group) => group.label === "Directions"), ...priorities],
      writing: bySection(write),
      ground: bySection(ground),
      decide: intent.filter((group) => group.label !== "Directions"),
      rulings,
      areas,
      synced: answer?.sources.find((row) => row.name === "model-of-tom/intent.md")?.syncedAt ?? null,
    };
  }, [answer, pages]);

  const rulingsGroup: Group = { label: "Rulings", lines: view.rulings };

  return (
    <div className="mx-auto w-full max-w-[66rem] px-4 py-6 sm:px-8">
      <header className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight">intent</h1>
        <span className="font-mono text-[11px] text-text-faint">
          {answer === undefined || pages === undefined ? "…" : shortDate(view.synced)}
        </span>
      </header>

      <Section id="toward" question="What he is working toward now" groups={view.toward} />
      <Section id="writing" question="How to write to him" groups={view.writing} />
      <Section id="ground" question="What he already knows and does not" groups={view.ground} />
      <Section id="decide" question="What he would decide" groups={view.decide} counted={[rulingsGroup]}>
        <div className="mb-6">
          <div className="mb-1.5 flex items-baseline justify-between gap-4 border-b border-border/60 pb-1">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Rulings</h3>
            <span className="font-mono text-[11px] tabular-nums text-text-faint">{view.rulings.length}</span>
          </div>
          <ul className="lg:columns-2 lg:gap-x-14">
            {view.rulings.slice(0, rulingsShown).map((line) => (
              <Line key={line.id} line={line} value={shortDate(line.at)} />
            ))}
          </ul>
          {view.rulings.length > rulingsShown && (
            <button
              type="button"
              onClick={showMoreRulings}
              className="mt-2 text-[11px] text-text-muted underline hover:text-text"
            >
              {Math.min(RULINGS_STEP, view.rulings.length - rulingsShown)} more
            </button>
          )}
        </div>
      </Section>
      <Section id="areas" question="The areas of his life" groups={view.areas} />
      <div className="border-t border-border" />
    </div>
  );
}
