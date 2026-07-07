"use client";

import { source, useTransformer } from "../state";
import { heat } from "../lib/color";

// The pinned source of truth: embed → residual wire with one tap per block →
// unembed → next-token readout. Tap color = how hard that sublayer wrote into
// the stream for the selected position (top square attention, bottom MLP).
// Ghost cards behind the spine are the past positions receding on the z axis.
export default function Spine() {
  const { trace, selected, open, toggle, select } = useTransformer();
  const cfg = source.model;
  const step = trace?.steps[selected];
  const tok = trace?.tokens[selected];
  const top1 = step?.logits[0];

  let maxWrite = 1e-9;
  if (step) for (const l of step.layers) maxWrite = Math.max(maxWrite, l.attnWrite, l.mlpWrite);

  const ghosts = Math.min(selected, 3);

  const cap = (path: string, label: string) => {
    const active = open.includes(path);
    return (
      <button
        onClick={() => toggle(path)}
        title={`${label === "embed" ? "W_E" : "W_U"} · ${cfg.vocabSize.toLocaleString()} × ${cfg.dModel}`}
        className={[
          "rounded border px-1.5 py-1.5 text-[10px] leading-none",
          active ? "border-accent text-accent" : "border-border bg-surface-alt text-text-muted hover:border-accent/50",
        ].join(" ")}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="sticky top-14 z-20 bg-bg/95 pb-2 pt-1 backdrop-blur-sm">
      <div className="relative" style={{ marginTop: ghosts * 5 + 2 }}>
        {Array.from({ length: ghosts }, (_, i) => ghosts - i).map((d) => (
          <div
            key={d}
            aria-hidden
            className="absolute inset-0 rounded-lg border border-border bg-surface"
            style={{ transform: `translate(${d * 7}px, ${-d * 6}px)`, opacity: 0.5 - d * 0.12 }}
          />
        ))}
        <div className="relative rounded-lg border border-border bg-surface px-3 py-1.5">
          <div className="mb-1 flex items-baseline gap-2 font-mono text-[11px] text-text-muted">
            <span className="flex items-center gap-0.5">
              <button
                onClick={() => select(selected - 1)}
                disabled={!trace || selected === 0}
                className="rounded px-1 text-text-faint hover:text-text disabled:opacity-30"
                aria-label="previous position"
              >
                ◂
              </button>
              <button
                onClick={() => select(selected + 1)}
                disabled={!trace || selected >= trace.tokens.length - 1}
                className="rounded px-1 text-text-faint hover:text-text disabled:opacity-30"
                aria-label="next position"
              >
                ▸
              </button>
            </span>
            {trace ? (
              <>
                <span>
                  t={selected} <span className="text-text">‹{tok?.trim() || "␣"}›</span>
                </span>
                <span className="text-text-faint">{selected} in context</span>
                {top1 && (
                  <span className="text-text-faint">
                    next → <span className="text-accent">‹{top1.token.trim() || "␣"}›</span> {top1.p.toFixed(2)}
                  </span>
                )}
              </>
            ) : (
              <span className="text-text-faint">run a prompt to light the spine up</span>
            )}
            <span className="ml-auto text-[10px] text-text-faint">
              {cfg.displayName} · {cfg.nLayers}L · d{cfg.dModel} · dummy data
            </span>
          </div>

          <div className="flex items-center gap-2">
            {cap("embed", "embed")}
            <div className="relative flex-1">
              <div className="absolute left-0 right-0 top-1/2 h-px bg-border" aria-hidden />
              <div className="relative flex justify-between">
                {Array.from({ length: cfg.nLayers }, (_, l) => {
                  const ls = step?.layers[l];
                  const isOpen = open.includes(`b${l}`);
                  return (
                    <button
                      key={l}
                      onClick={() => toggle(`b${l}`)}
                      title={
                        ls
                          ? `block ${l} · attn +${ls.attnWrite.toFixed(1)} · mlp +${ls.mlpWrite.toFixed(1)}`
                          : `block ${l}`
                      }
                      className={[
                        "flex flex-col items-center gap-[3px] rounded-sm px-[3px] py-[2px]",
                        isOpen ? "outline outline-1 outline-accent" : "hover:outline hover:outline-1 hover:outline-text-faint",
                      ].join(" ")}
                    >
                      <span
                        className="h-[9px] w-[14px] rounded-[2px]"
                        style={{ background: ls ? heat(ls.attnWrite / maxWrite) : "var(--color-surface-alt)" }}
                      />
                      <span
                        className="h-[9px] w-[14px] rounded-[2px]"
                        style={{ background: ls ? heat(ls.mlpWrite / maxWrite) : "var(--color-surface-alt)" }}
                      />
                      <span className="text-[8px] leading-none text-text-faint">{l}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            {cap("unembed", "unembed")}
          </div>
        </div>
      </div>
    </div>
  );
}
