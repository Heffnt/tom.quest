"use client";

import { getSource, useTransformer } from "../state";
import { heat } from "../lib/color";
import { Band } from "./strata";

// All query heads of one attention block, tiled by GQA group (heads in a group
// share one K/V head). Tile color = that head's output norm at the selected
// position. Click a head to open its attention-into-the-past stratum.
export default function HeadsStratum({ layer }: { layer: number }) {
  const { trace, selected, open, toggle } = useTransformer();
  const cfg = getSource().model;
  const norms = trace?.steps[selected]?.layers[layer]?.headNorms;
  const maxN = norms ? Math.max(...norms, 1e-9) : 1;
  const perGroup = cfg.nHeads / cfg.nKvHeads;

  return (
    <Band
      path={`b${layer}/attn`}
      crumbs={[`block ${layer}`, "attention"]}
      meta={
        <span>
          {cfg.nHeads} q heads · {cfg.nKvHeads} kv groups · head_dim {cfg.headDim}
        </span>
      }
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: cfg.nKvHeads }, (_, g) => (
            <div key={g} className="rounded border border-border/60 p-1" title={`kv group ${g}`}>
              <div className="mb-0.5 text-center text-[8px] leading-none text-text-faint">kv{g}</div>
              <div className="flex gap-1">
                {Array.from({ length: perGroup }, (_, i) => {
                  const h = g * perGroup + i;
                  const isOpen = open.includes(`b${layer}/attn/h${h}`);
                  return (
                    <button
                      key={h}
                      onClick={() => toggle(`b${layer}/attn/h${h}`)}
                      title={norms ? `head ${h} · ‖out‖ ${norms[h].toFixed(2)}` : `head ${h}`}
                      className={[
                        "h-5 w-5 rounded-sm",
                        isOpen ? "outline outline-1 outline-accent" : "hover:outline hover:outline-1 hover:outline-text-faint",
                      ].join(" ")}
                      style={{ background: norms ? heat(norms[h] / maxN) : "var(--color-surface-alt)" }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1 font-mono text-[10px] text-text-faint">
          weights
          {(["wq", "wk", "wv", "wo"] as const).map((w) => {
            const path = `b${layer}/attn/${w}`;
            const active = open.includes(path);
            return (
              <button
                key={w}
                onClick={() => toggle(path)}
                className={[
                  "rounded border px-1.5 py-0.5",
                  active ? "border-accent text-accent" : "border-border text-text-muted hover:border-text-faint",
                ].join(" ")}
              >
                {w === "wq" ? "W_Q" : w === "wk" ? "W_K" : w === "wv" ? "W_V" : "W_O"}
              </button>
            );
          })}
        </div>
      </div>
    </Band>
  );
}
