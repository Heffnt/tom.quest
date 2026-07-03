"use client";

// app/boolback/components/fn-hex.tsx — the compact function text ("3:E8").
//
// Arity-prefixed hex of the truth table (see lib/format.fnHex) — the dense
// stand-in for the 32-char binary string / long DNF at arity 5. Hovering
// reveals BOTH readable forms: the colored truth-strip and the simplified DNF.
// The popup is position:fixed (anchored to the cell's rect) so the table
// cell's overflow-hidden can't clip it.

import { useState } from "react";
import type { FunctionBlock } from "../lib/types";
import { fnText } from "../lib/format";
import { TruthStrip } from "./truth-strip";

export function dnfLabel(dnf: string): string {
  return dnf === "0" ? "⊥ (constant false)" : dnf === "1" ? "⊤ (constant true)" : dnf;
}

export function FnHex({ fn }: { fn: FunctionBlock }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  return (
    <span
      className="inline-block"
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setAnchor({ x: r.left, y: r.bottom });
      }}
      onMouseLeave={() => setAnchor(null)}
    >
      <span className="font-mono text-text/90 cursor-default">
        {fnText(fn.arity, fn.truth_table)}
      </span>
      {anchor && (
        <span
          className="fixed z-50 block w-max max-w-md rounded-md border border-border bg-surface/95 p-2 shadow-lg backdrop-blur-md"
          style={{ left: Math.max(4, Math.min(anchor.x, window.innerWidth - 460)), top: anchor.y + 4 }}
        >
          <span className="block overflow-x-auto pb-1.5">
            <TruthStrip arity={fn.arity} activation={fn.activation} box={14} gap={2} legend />
          </span>
          <span className="block max-w-full whitespace-normal break-words font-mono text-[11px] text-text/90">
            <span className="text-text-faint">DNF </span>
            {dnfLabel(fn.dnf_string)}
          </span>
        </span>
      )}
    </span>
  );
}
