"use client";

// THE DEFINITION DRAWER. A word pressed anywhere on the page opens here,
// beside the page rather than instead of it, so reading a definition never
// costs the reader their place.
//
// WHAT IT CAN SAY, AND WHAT IT CANNOT. The canonical glossary is WikiTom's
// `tts/vocabulary.json`, which `tts search define` answers from on a machine
// with that checkout; the record holds the term NAMES and not their
// definitions, and convex/ttsShared.ts says so where the names are. So this
// reads the three published bodies the record does hold — the model-of-Tom
// files, the skills and the repository rules — for the lines that define the
// word, and shows each with the file it came from. A word none of them define
// comes back with nothing and the drawer says where its definition lives
// instead of showing an empty panel.
//
// Fixed, so opening it moves nothing on the page behind it.

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export default function DefinitionDrawer({
  term,
  onClose,
}: {
  term: string | null;
  onClose: () => void;
}) {
  const answer = useQuery(api.observe.define, term === null ? "skip" : { term });
  if (term === null) return null;
  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-[min(28rem,100vw)] flex-col border-l border-border bg-surface shadow-2xl">
      <div className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-[15px] font-semibold text-text">{term}</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-border px-2 py-0.5 text-[11px] text-text-muted hover:border-text-faint hover:text-text"
        >
          close
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {answer === undefined ? (
          <p className="text-[12px] text-text-faint">…</p>
        ) : (
          <>
            <p className="text-[11px] font-mono text-text-faint">
              {answer.inVocabulary ? "in the vocabulary" : "not in the vocabulary"}
            </p>
            {answer.found.length === 0 ? (
              <p className="mt-2 text-[12px] text-text-muted">
                The record holds no definition of this word. It is defined in {answer.elsewhere}.
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {answer.found.map((entry, index) => (
                  <li key={`${entry.where}-${index}`}>
                    <p className="text-[10px] font-mono text-text-faint">{entry.where}</p>
                    <p className="text-[12px] leading-snug text-text">{entry.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
