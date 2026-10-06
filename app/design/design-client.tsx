"use client";

// THE DESIGN PAGE: the registry of Jarvis's parts the box deployed, drawn.
//
// From top to bottom: the counts, the legend, the overview (every running
// part, filled by its use state and outlined by its fate), the map (what Tom
// designs in session and what outcomes govern), the fate drawing, who starts
// whom, the record's routes, the tools, and the list of every part. A box or a
// list row opens the part's panel and names it in the hash (#<part id>); a
// hash on arrival opens it. With ?head=<repo>@<sha> the page draws that head's
// registry diff instead.

import { useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import PartsDrawing, { type Drawing } from "@/app/components/parts-drawing";
import { diagramsOf, sizeOf } from "@/shared/parts-drawing.mjs";
import DiffView from "./components/diff-view";
import PartPanel from "./components/part-panel";
import { displayForm } from "@/shared/clock.mjs";
import { keeps } from "./lib";
import { useDesignStore, type ListFilter } from "./store";

type PageAnswer = FunctionReturnType<typeof api.jarvis.design.page>;

const COUNTS: { key: "parts" | "unverified" | "issue" | "partial" | "removedStillRun" | "noSentence"; label: string; filter: ListFilter }[] = [
  { key: "parts", label: "parts", filter: "all" },
  { key: "unverified", label: "landed, never run", filter: "unverified" },
  { key: "issue", label: "with an issue", filter: "issue" },
  { key: "partial", label: "state partial", filter: "partial" },
  { key: "removedStillRun", label: "ruled removed, still run", filter: "removed-still-run" },
  { key: "noSentence", label: "serving no sentence", filter: "no-sentence" },
];

const shortSubject = (subject: string) => subject.slice(0, subject.indexOf("@") + 8);

/** The page from its query's answer; the panel and the diff view are slots. */
function DesignView({ answer, onSelect }: { answer: PageAnswer | undefined; onSelect: (id: string) => void }) {
  const { filter, setFilter } = useDesignStore();
  const drawings = useMemo(() => {
    if (!answer || answer.registry === null) return [];
    const { diagrams, problems } = diagramsOf(answer.registry.parts, { states: answer.states, commit: answer.registry.sha.slice(0, 7) });
    for (const problem of problems) console.error(`design: ${problem}`);
    return diagrams as Drawing[];
  }, [answer]);

  if (answer === undefined) return <p className="text-[12px] text-text-faint">…</p>;
  if (answer.registry === null) return <p className="text-[13px] text-text-muted">no registry in the record</p>;
  const { registry, states, counts } = answer;
  const listed = registry.parts.filter((row) => keeps(filter, row, states[row.id]));

  return (
    <>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        {COUNTS.filter((c) => c.key !== "partial" || counts.partial > 0).map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setFilter(c.filter)}
            className={`rounded px-1 text-[12px] underline decoration-text-faint underline-offset-2 hover:bg-surface hover:text-text ${filter === c.filter ? "text-accent" : "text-text-muted"}`}
          >
            <span className="font-mono">{counts[c.key]}</span> {c.label}
          </button>
        ))}
        <span className="font-mono text-[11px] text-text-faint">
          {shortSubject(registry.subject)} · {displayForm(registry.at)}
        </span>
      </div>

      {drawings.map((d) => {
        const { width } = sizeOf(d);
        return (
          <section key={d.id} className="mt-6">
            <h2 className="text-[15px] font-semibold text-text">{d.title}</h2>
            <div className="mt-2 overflow-x-auto">
              <div className="min-w-[var(--w)] sm:min-w-0" style={{ "--w": `${width}px` } as React.CSSProperties}>
                <PartsDrawing diagram={d} onSelect={onSelect} />
              </div>
            </div>
            <p className="mt-1 text-[12px] text-text-faint">{d.caption}</p>
          </section>
        );
      })}

      <section className="mt-6">
        <h2 className="text-[15px] font-semibold text-text">
          Every part{filter !== "all" && <span className="font-normal text-text-muted"> · {COUNTS.find((c) => c.filter === filter)?.label}</span>}
        </h2>
        <ul className="mt-2 space-y-0.5">
          {listed.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => onSelect(row.id)}
                className="grid w-full grid-cols-[minmax(0,1fr)_5rem_5.5rem_5rem] gap-2 rounded px-1 text-left text-[12px] text-text-muted hover:bg-surface"
              >
                <span className="truncate text-text">{row.name}</span>
                <span>{row.type}</span>
                <span>{states[row.id] ?? ""}</span>
                <span>{row.fate.type}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export default function DesignClient() {
  const { isTom } = useAuth();
  const head = useSearchParams().get("head");
  const answer = useQuery(api.jarvis.design.page, isTom && head === null ? {} : "skip");
  const diff = useQuery(api.jarvis.design.diff, isTom && head !== null ? { head } : "skip");
  const { selected, select } = useDesignStore();

  // The hash names the open part: read on arrival and whenever it changes.
  useEffect(() => {
    const read = () => select(decodeURIComponent(window.location.hash.slice(1)) || null);
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [select]);

  const open = (id: string) => {
    window.history.replaceState(null, "", `#${encodeURIComponent(id)}`);
    select(id);
  };
  const close = () => {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    select(null);
  };

  return (
    <TomGate label="Design">
      <div className="w-full px-4 py-5">
        <h1 className="text-2xl font-bold tracking-tight">design</h1>
        {head === null ? (
          <DesignView answer={answer} onSelect={open} />
        ) : (
          <div className="mt-3">
            <DiffView head={head} answer={diff} onSelect={open} />
          </div>
        )}
      </div>
      {/* Keyed by the part: a panel for another part starts with an empty sentence field. */}
      {selected !== null && <PartPanel key={selected} id={selected} onClose={close} onSelect={open} />}
    </TomGate>
  );
}
