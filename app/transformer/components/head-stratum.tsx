"use client";

import { getSource, useTransformer } from "../state";
import { kvGroupOf } from "../lib/model";
import { Band } from "./strata";

// One head's view along the z axis: how the selected position attends over
// every past position. Bars are the attention distribution; positions after
// the selection are the future — present in the trace, invisible to this
// step — and render as ghost slots. Clicking a bar time-travels there.
export default function HeadStratum({ layer, head }: { layer: number; head: number }) {
  const { trace, selected, select } = useTransformer();
  const attn = (trace && getSource().attnPattern(trace, layer, head, selected)) || [];
  const tokens = trace?.tokens ?? [];

  const entropy = attn.reduce((s, p) => (p > 1e-9 ? s - p * Math.log2(p) : s), 0);
  const top = attn
    .map((p, j) => ({ p, j }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 3);
  const maxP = Math.max(...attn, 1e-9);

  return (
    <Band
      path={`b${layer}/attn/h${head}`}
      crumbs={[`block ${layer}`, "attention", `head ${head}`]}
      meta={
        <span>
          kv group {kvGroupOf(getSource().model, head)} · entropy {trace ? entropy.toFixed(2) : "–"} bits
        </span>
      }
    >
      {trace ? (
        <div>
          <div className="flex gap-[2px]" role="img" aria-label="attention over past positions">
            {tokens.map((tok, j) => {
              const showLabels = tokens.length <= 28;
              const label = showLabels ? (
                <span className="block h-3 overflow-hidden text-center font-mono text-[8px] leading-3 text-text-faint">
                  {(tok.trim() || "␣").slice(0, 4)}
                </span>
              ) : null;
              if (j > selected) {
                return (
                  <div key={j} className="min-w-[3px] max-w-[26px] flex-1 opacity-40" title={`‹${tok.trim()}› is in the future of t=${selected}`}>
                    <div className="h-16 border-b border-dashed border-border" />
                    {label}
                  </div>
                );
              }
              const p = attn[j] ?? 0;
              return (
                <button
                  key={j}
                  onClick={() => select(j)}
                  title={`‹${tok.trim() || "␣"}› · ${p.toFixed(3)} · click to travel to t=${j}`}
                  className={[
                    "min-w-[3px] max-w-[26px] flex-1",
                    j === selected ? "outline outline-1 outline-accent/60" : "hover:outline hover:outline-1 hover:outline-text-faint",
                  ].join(" ")}
                >
                  <span className="relative block h-16">
                    <span
                      className="absolute bottom-0 left-0 right-0 rounded-t-[2px] bg-accent"
                      style={{ height: `${(p / maxP) * 100}%`, opacity: 0.3 + 0.7 * (p / maxP) }}
                    />
                  </span>
                  {label}
                </button>
              );
            })}
          </div>
          <div className="mt-1 font-mono text-[10px] text-text-faint">
            attends{" "}
            {top.map(({ p, j }, i) => (
              <span key={j}>
                {i > 0 && " · "}
                <span className="text-text-muted">‹{tokens[j]?.trim() || "␣"}›</span> {p.toFixed(2)}
              </span>
            ))}
            <span className="ml-2 opacity-70">dashed = future positions</span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-text-faint">run a prompt to see this head attend</p>
      )}
    </Band>
  );
}
