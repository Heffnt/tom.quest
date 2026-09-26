"use client";

// THE VOCABULARY, AS `tts search` PRINTS IT. What an agent sees when it asks:
// the `vocabulary/@version` header, then every word as `tts search vocabulary`
// prints it. Typing a word answers the way `tts search define` does — its one
// row, or the line saying it is unknown and the words it could have meant.
// The rows are spelled by shared/vocabulary-rows.mjs, which the CLI imports
// too, so the page cannot print a row no agent was shown.
//
// IT READS THE RECORD, NOT THE FILE. `tts/vocabulary.json` is written only
// when the spec and the code say the same thing about every word; the
// nightly's graph step posts what the generator rendered whether or not it
// wrote, and this view reads that. The header names the commits it came from.
// The words the spec and the code disagree on are drawn with the other
// disagreements (vocabulary-disagreements.tsx, the disagreements view).

import { useMemo } from "react";
import type { Doc } from "@/convex/_generated/dataModel";
import Info from "@/app/tts/components/info";
import TermRows from "./term-rows";
import { kindsOf, termRows, versionRow } from "../vocabulary-lib";
import { useVocabularyStore } from "../vocabulary-store";
import { Group, Pick } from "./picks";

export default function Vocabulary({ answer }: { answer: Doc<"ttsVocabulary"> | null | undefined }) {
  const { kind, word, setKind, setWord } = useVocabularyStore();
  const kinds = useMemo(() => kindsOf(answer?.terms ?? []), [answer]);
  const rows = useMemo(() => (answer ? termRows(answer, kind, word) : []), [answer, kind, word]);

  if (answer === undefined) return <p className="text-[11px] font-mono text-text-faint">…</p>;
  if (answer === null) return <p className="text-[12px] text-text-muted">No vocabulary render in the record.</p>;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
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
          Prints each row the way tts search vocabulary prints it, from the render the nightly posted. A typed word
          is answered the way tts search define answers it: its one row, or the rows that carry it.
        </Info>
        <span className="text-[11px] font-mono text-text-faint">
          {answer.terms.length} words · {answer.disagreements.length} disagreements · tts/vocabulary.json{" "}
          {answer.wrote ? "written" : "not written"}
        </span>
      </div>
      <div className="mt-3">
        <TermRows header={versionRow(answer)} rows={rows} />
      </div>
    </div>
  );
}
