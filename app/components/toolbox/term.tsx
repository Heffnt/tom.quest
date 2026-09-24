"use client";

// Term — principle 6: a word of TTS's vocabulary, underlined; pressing it
// opens a fixed drawer with the word's definition from the record
// (`vocabulary.current`, the render the nightly posts). The query runs only
// while the drawer is open and only for a viewer who may read the vocabulary.

import { useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { api } from "@/convex/_generated/api";
import QueryCaption from "./query-caption";
import { useSurfaceQuery } from "./use-surface-query";

function Definition({ word, onClose }: { word: string; onClose: () => void }) {
  const answer = useSurfaceQuery("Vocabulary", api.vocabulary.current, {});
  const entry = answer?.terms.find((t) => t.term.toLowerCase() === word.toLowerCase());
  return (
    <div className="tb-root tb-define" role="dialog" aria-label={word}>
      <div className="tb-drawer-head">
        <h2 className="tb-title">{word}</h2>
        <button type="button" className="tb-btn" onClick={onClose}>
          close
        </button>
      </div>
      <p className="tb-prose">
        {answer === undefined ? "…" : entry ? entry.definition : `no entry for ${word}`}
      </p>
      <QueryCaption text={`vocabulary.current → the entry for ${word}`} />
    </div>
  );
}

export default function Term({ word, children }: { word: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="tb-link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {children ?? word}
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(<Definition word={word} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}
