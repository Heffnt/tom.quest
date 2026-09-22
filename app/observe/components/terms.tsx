"use client";

// EVERY VOCABULARY WORD ON THIS PAGE IS CLICKABLE. `Terms` takes a piece of
// text the record wrote — a pull request's sentence, an audit's paragraph, a
// ruling — and renders it with every word of the closed vocabulary as a control
// that opens that word's definition in the drawer beside the page.
//
// THE LIST OF WORDS IS THE ONE THE REPOSITORY ALREADY HOLDS:
// convex/ttsShared.ts VOCABULARY_TERMS, which scripts/vocabulary.mjs generates
// from the spec. This file keeps no second list, so a word added to the
// vocabulary becomes clickable here without anyone remembering to add it.
//
// A clickable word is underlined at rest, as app/AGENTS.md requires of
// clickable text that is not a button; the underline is dotted so a definition
// is not mistaken for a link to somewhere else.

import { createContext, useContext, useMemo } from "react";
import { VOCABULARY_TERMS } from "@/convex/ttsShared";

/** Opening a definition. The page is the only thing that renders `Terms`, and
 *  it always provides this, so there is no second way for a word to behave. */
const AskContext = createContext<(term: string) => void>(() => {});

export function TermsProvider({
  onDefine,
  children,
}: {
  onDefine: (term: string) => void;
  children: React.ReactNode;
}) {
  return <AskContext.Provider value={onDefine}>{children}</AskContext.Provider>;
}

/** The plural a word takes, as English spells it: nothing for a word already
 *  ending in `s`, `-es` after a sibilant, `-s` otherwise. */
function plural(term: string): string {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/s$/i.test(term)) return escaped;
  if (/(ch|sh|x|z)$/i.test(term)) return `${escaped}(?:es)?`;
  return `${escaped}s?`;
}

/**
 * One pattern for the whole vocabulary, longest word first so "run vocabulary"
 * wins over "run", with an optional plural on the words that can take one.
 *
 * NO LOOKBEHIND. The boundary before a word is captured as its own group and
 * written straight back out, because a lookbehind is the one regular-expression
 * feature in this pattern that a browser can still refuse.
 */
const PATTERN = new RegExp(
  `(^|[^\\w#-])(${[...VOCABULARY_TERMS]
    .sort((left, right) => right.length - left.length)
    .map(plural)
    .join("|")})(?![\\w-])`,
  "gi",
);

export default function Terms({ text, className }: { text: string; className?: string }) {
  const ask = useContext(AskContext);
  const parts = useMemo(() => split(text), [text]);
  return (
    <span className={className}>
      {parts.map((part, index) =>
        part.term === null ? (
          <span key={index}>{part.text}</span>
        ) : (
          <button
            key={index}
            type="button"
            onClick={() => ask(part.term as string)}
            className="underline decoration-dotted underline-offset-2 hover:text-accent"
          >
            {part.text}
          </button>
        ),
      )}
    </span>
  );
}

type Part = { text: string; term: string | null };

/** The text, cut into the plain stretches and the vocabulary words between
 *  them. `term` is the vocabulary's own spelling; `text` is the page's. */
export function split(text: string): Part[] {
  const parts: Part[] = [];
  let cursor = 0;
  PATTERN.lastIndex = 0;
  for (const hit of text.matchAll(PATTERN)) {
    const whole = hit[0];
    const lead = hit[1];
    const word = hit[2];
    const start = (hit.index ?? 0) + lead.length;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), term: null });
    parts.push({ text: word, term: canonical(word) });
    cursor = (hit.index ?? 0) + whole.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), term: null });
  return parts;
}

/** The vocabulary's spelling of a word the page found, so the drawer asks about
 *  the term and not about whatever case or plural the sentence used. */
function canonical(word: string): string {
  const lower = word.toLowerCase();
  const exact = VOCABULARY_TERMS.find((term) => term.toLowerCase() === lower);
  if (exact !== undefined) return exact;
  for (const singular of [lower.replace(/es$/, ""), lower.replace(/s$/, "")]) {
    const hit = VOCABULARY_TERMS.find((term) => term.toLowerCase() === singular);
    if (hit !== undefined) return hit;
  }
  return word;
}
