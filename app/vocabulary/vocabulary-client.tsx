"use client";

// THE VOCABULARY PAGE, in two views.
//
// AS TTS SEARCH PRINTS IT (the default). What an agent sees when it asks: the
// `vocabulary/@version` header, then every word as `tts search vocabulary`
// prints it. Typing a word answers the way `tts search define` does — its one
// row, or the line saying it is unknown and the words it could have meant.
// The rows are spelled by shared/vocabulary-rows.mjs, which the CLI imports
// too, so the page cannot print a row no agent was shown.
//
// IT READS THE RECORD, NOT THE FILE. `tts/vocabulary.json` is written only when
// the spec and the code say the same thing about every word, and today they do
// not, so the file does not exist. The nightly's graph step posts what the
// generator rendered whether or not it wrote, and this page reads that. On the
// box the CLI reads its own render, which can stand at another commit; the
// header names the commits this one came from.
//
// DISAGREEMENTS. Each word the spec and the code do not say the same thing
// about is one ruling of his, and settling them is what makes the file exist.
// No agent is shown them, so they are the second view.

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import Info from "@/app/jarvis/components/info";
import Disagreements from "./components/disagreements";
import TermRows from "./components/term-rows";
import { kindsOf, termRows, versionRow } from "./lib";
import { useVocabularyStore } from "./store";

export default function VocabularyClient() {
  const { isTom } = useAuth();
  const answer = useQuery(api.vocabulary.current, isTom ? {} : "skip");
  const { view, kind, word, setView, setKind, setWord } = useVocabularyStore();

  const kinds = useMemo(() => kindsOf(answer?.terms ?? []), [answer]);
  const rows = useMemo(() => (answer ? termRows(answer, kind, word) : []), [answer, kind, word]);

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
                : `${answer.terms.length} words · ${answer.disagreements.length} disagreements`
                  + ` · tts/vocabulary.json ${answer.wrote ? "written" : "not written"}`}
          </span>
        </header>

        {answer != null && (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <Group>
                <Pick on={view === "terms"} onClick={() => setView("terms")}>
                  as tts search prints it
                </Pick>
                <Pick on={view === "disagreements"} onClick={() => setView("disagreements")}>
                  disagreements ({answer.disagreements.length})
                </Pick>
              </Group>
              {view === "terms" && (
                <>
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
                    value={word}
                    onChange={(event) => setWord(event.target.value)}
                    aria-label="word"
                    placeholder="define"
                    className="rounded-md border border-border bg-surface/40 px-2 py-1 text-[12px] text-text placeholder:text-text-faint"
                  />
                  <Info call="vocabulary.current()" side="below">
                    Prints each row the way tts search vocabulary prints it, from the render the nightly
                    posted. A typed word is answered the way tts search define answers it: its one row, or
                    the rows that carry it.
                  </Info>
                </>
              )}
            </div>

            <div className="mt-3">
              {view === "terms" ? (
                <TermRows header={versionRow(answer)} rows={rows} />
              ) : (
                <Disagreements rows={answer.disagreements} />
              )}
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
