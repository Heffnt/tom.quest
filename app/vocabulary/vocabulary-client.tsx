"use client";

// THE VOCABULARY PAGE. Every word TTS uses, what it means, and where it is
// defined — plus the disagreements that are keeping the vocabulary file from
// being written at all.
//
// IT READS THE RECORD, NOT THE FILE. `tts/vocabulary.json` is written only when
// the spec and the code say the same thing about every word, and today they do
// not, so the file does not exist. The nightly's graph step posts what the
// generator rendered whether or not it wrote, and this page reads that — so the
// words are current on a night the file was refused, which is every night until
// the list at the top is settled.
//
// THE DISAGREEMENTS COME FIRST because each one is a ruling of his and
// settling them is what makes the file exist.

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import Disagreements from "./components/disagreements";
import TermList from "./components/term-list";
import { kindsOf, searchTerms } from "./lib";

export default function VocabularyClient() {
  const { isTom } = useAuth();
  const answer = useQuery(api.vocabulary.current, isTom ? {} : "skip");
  const [kind, setKind] = useState("all");
  const [query, setQuery] = useState("");

  const terms = useMemo(() => answer?.terms ?? [], [answer]);
  const kinds = useMemo(() => kindsOf(terms), [terms]);
  const shown = useMemo(() => searchTerms(terms, kind, query), [terms, kind, query]);

  return (
    <TomGate label="Vocabulary">
      <div className="w-full px-3 py-5 sm:px-5">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold tracking-tight">vocabulary</h1>
          <span className="text-[11px] font-mono text-text-faint">
            {answer === undefined
              ? "…"
              : answer === null
                ? "no render in the record"
                : `${shown.length} of ${terms.length} words · ${answer.disagreements.length} disagreements`
                  + ` · tts/vocabulary.json ${answer.wrote ? "written" : "not written"}`
                  + ` · ${answer.version} · ${answer.commit.slice(0, 12)}`}
          </span>
        </header>

        {answer != null && (
          <>
            <div className="mt-3">
              <Disagreements rows={answer.disagreements} />
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-1.5">
              <Group>
                <Pick on={kind === "all"} onClick={() => setKind("all")}>
                  every kind
                </Pick>
                {kinds.map((name) => (
                  <Pick key={name} on={kind === name} onClick={() => setKind(name)}>
                    {name}
                  </Pick>
                ))}
              </Group>
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="word"
                placeholder="word"
                className="rounded-md border border-border bg-surface/40 px-2 py-1 text-[12px] text-text placeholder:text-text-faint"
              />
            </div>

            <div className="mt-2">
              <TermList terms={shown} />
            </div>
          </>
        )}
      </div>
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
