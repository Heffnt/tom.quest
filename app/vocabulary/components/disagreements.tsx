"use client";

// THE DISAGREEMENTS, NUMBERED. Each one is a word the spec and the code do not
// say the same thing about, and each is one ruling of his: the number is how he
// answers, so it is drawn as the first thing on the row and never moves.
//
// BOTH SOURCES VERBATIM, side by side with the file and line each is written
// at, because settling one is choosing a wording and a choice needs the two
// wordings in front of it.
//
// While any of these stand, `scripts/vocabulary.mjs` writes no
// `tts/vocabulary.json` — which is why this list is above the words and not
// below them.

import type { Disagreement } from "../lib";

export default function Disagreements({ rows }: { rows: Disagreement[] }) {
  if (rows.length === 0) return null;
  return (
    <section>
      <h2 className="flex items-baseline gap-2 border-b border-border pb-1">
        <span className="text-[13px] font-semibold text-text">disagreements</span>
        <span className="text-[11px] font-mono text-text-faint">{rows.length}</span>
      </h2>
      <ol className="mt-1">
        {rows.map((row, index) => (
          <li
            key={`${row.code}-${row.subject}`}
            className="flex gap-2 border-b border-border/50 px-2 py-2"
          >
            <span className="w-5 shrink-0 text-[13px] font-mono text-accent">{index + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-text">
                {row.subject} <span className="font-mono text-[10px] text-text-faint">{row.code}</span>
              </p>
              <dl className="mt-1 space-y-1">
                {row.rows.map((source) => (
                  <div key={source.label}>
                    <dt className="text-[10px] font-mono text-text-faint">
                      {source.label} — {source.where}
                    </dt>
                    <dd className="text-[12px] leading-snug text-text-muted">{source.text}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-1 text-[11px] text-text-faint">{row.fix}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
