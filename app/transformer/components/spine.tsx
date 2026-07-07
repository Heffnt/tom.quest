"use client";

import { getSource, producingStep, useTransformer } from "../state";
import { heat } from "../lib/color";

// The pinned source of truth: embed → residual wire → unembed. Everything on it
// is the forward pass that PRODUCED the selected token (the pass at the prior
// position), so the spine reads as "how the model arrived at this token". Each
// block shows two write taps in computation order, left→right along the stream:
// attention first, then MLP. Brighter = larger write into the residual stream.
// Ghost cards behind the spine are the past positions receding on the z axis.
export default function Spine() {
  const { trace, selected, open, toggle, select, sourceStatus } = useTransformer();
  const cfg = getSource().model;
  const stepIdx = producingStep(selected);
  const step = trace && stepIdx >= 0 ? trace.steps[stepIdx] : undefined;
  const tok = trace?.tokens[selected];
  const inputTok = trace && stepIdx >= 0 ? trace.tokens[stepIdx] : undefined;
  const top1 = step?.logits[0];

  // per-lane normalization + sqrt so early layers stay visible when one late
  // layer dominates (real models are very top-heavy)
  let attnMax = 1e-9;
  let mlpMax = 1e-9;
  if (step)
    for (const l of step.layers) {
      attnMax = Math.max(attnMax, l.attnWrite);
      mlpMax = Math.max(mlpMax, l.mlpWrite);
    }

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
                  t={selected} → <span className="text-text">‹{tok?.trim() || "␣"}›</span>
                </span>
                {stepIdx >= 0 ? (
                  <>
                    <span className="text-text-faint">from ‹{inputTok?.trim() || "␣"}›</span>
                    {top1 && (
                      <span className="text-text-faint">
                        top pred <span className="text-accent">‹{top1.token.trim() || "␣"}›</span> {top1.p.toFixed(2)}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-text-faint">given input · not produced by the model</span>
                )}
              </>
            ) : (
              <span className="text-text-faint">run a prompt to light the spine up</span>
            )}
            <span className="ml-auto text-[10px] text-text-faint">
              {cfg.displayName} · {cfg.nLayers}L · d{cfg.dModel} ·{" "}
              {sourceStatus === "live" ? <span className="text-success">live · turing</span> : "dummy data"}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {cap("embed", "embed")}
            <div className="relative flex-1">
              <div className="absolute left-0 right-0 top-[10px] h-px bg-border" aria-hidden />
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
                      <span className="flex gap-[2px]">
                        <span
                          className="h-4 w-[7px] rounded-[1px]"
                          style={{ background: ls ? heat(Math.sqrt(ls.attnWrite / attnMax)) : "var(--color-surface-alt)" }}
                        />
                        <span
                          className="h-4 w-[7px] rounded-[1px]"
                          style={{ background: ls ? heat(Math.sqrt(ls.mlpWrite / mlpMax)) : "var(--color-surface-alt)" }}
                        />
                      </span>
                      <span className="text-[8px] leading-none text-text-faint">{l}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            {cap("unembed", "unembed")}
          </div>
          <div className="mt-1 text-center text-[8px] leading-none text-text-faint">
            each block, left→right along the stream: attention write · mlp write
          </div>
        </div>
      </div>
    </div>
  );
}
