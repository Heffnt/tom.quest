"use client";

// EVERY WORD, ITS DEFINITION, AND WHERE IT IS DEFINED. One row each, in the
// order the generator rendered them, which is the vocabulary's own order.
//
// A REFUSED WORD IS A WORD TOO. The vocabulary carries the words it will not
// have as well as the words it has, each pointing at the one to use instead,
// so looking up the wrong word answers the question rather than returning
// nothing.

import { definedIn, type Term } from "../lib";

export default function TermList({ terms }: { terms: Term[] }) {
  return (
    <ul>
      {terms.map((term) => (
        <li key={term.term} className="border-b border-border/50 px-2 py-1.5">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span
              className={`text-[13px] font-semibold ${
                term.kind === "refused" ? "text-text-faint line-through" : "text-text"
              }`}
            >
              {term.term}
            </span>
            <span className="text-[10px] font-mono text-text-faint">{term.kind}</span>
            {term.refusedFor !== undefined && (
              <span className="text-[11px] text-accent">use {term.refusedFor}</span>
            )}
          </p>
          <p className="text-[12px] leading-snug text-text-muted">{term.definition}</p>
          <p className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] font-mono text-text-faint">
            <span>{definedIn(term)}</span>
            {term.related.length > 0 && <span>near {term.related.join(", ")}</span>}
          </p>
        </li>
      ))}
    </ul>
  );
}
