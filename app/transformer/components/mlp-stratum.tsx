"use client";

import { useEffect, useRef } from "react";
import { source, useTransformer } from "../state";
import { Band } from "./strata";

// The MLP at the selected position: distribution of the hidden activations
// (dMlp of them) plus the handful of neurons doing most of the work.
export default function MlpStratum({ layer }: { layer: number }) {
  const { trace, selected, open, toggle } = useTransformer();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cfg = source.model;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !trace) return;
    const dpr = window.devicePixelRatio || 1;
    const w = 260;
    const h = 56;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const { edges, counts } = source.mlpActHistogram(trace, layer, selected, 48);
    const maxC = Math.max(...counts, 1e-9);
    const bw = w / counts.length;
    for (let i = 0; i < counts.length; i++) {
      const bh = (counts[i] / maxC) * (h - 4);
      ctx.fillStyle = edges[i] >= 0 ? "rgba(232,160,64,0.7)" : "rgba(59,130,246,0.55)";
      ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 1), bh);
    }
    // zero marker
    const zeroX = ((0 - edges[0]) / (edges[edges.length - 1] - edges[0])) * w;
    ctx.fillStyle = "#64748b";
    ctx.fillRect(zeroX, 0, 1, h);
  }, [trace, selected, layer]);

  const topN = trace ? source.mlpTopNeurons(trace, layer, selected, 8) : [];
  const maxAct = Math.max(...topN.map((n) => n.act), 1e-9);

  return (
    <Band
      path={`b${layer}/mlp`}
      crumbs={[`block ${layer}`, "mlp"]}
      meta={
        <span>
          {cfg.dModel} → {cfg.dMlp} → {cfg.dModel} · swiglu
        </span>
      }
    >
      {trace ? (
        <div className="flex flex-wrap items-start gap-x-5 gap-y-2">
          <div>
            <canvas ref={canvasRef} style={{ width: 260, height: 56 }} aria-label="hidden activation histogram" />
            <div className="mt-0.5 font-mono text-[9px] text-text-faint">hidden activations at t={selected}</div>
          </div>
          <div className="font-mono text-[10px]">
            <div className="mb-0.5 text-text-faint">top neurons</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
              {topN.map((n) => (
                <div key={n.idx} className="flex items-center gap-1.5">
                  <span className="w-12 text-text-muted">n{n.idx}</span>
                  <span className="h-1 w-12 overflow-hidden rounded bg-surface-alt">
                    <span className="block h-full bg-accent" style={{ width: `${(n.act / maxAct) * 100}%` }} />
                  </span>
                  <span className="text-text-faint">{n.act.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1 font-mono text-[10px] text-text-faint">
            weights
            {(["gate", "up", "down"] as const).map((w) => {
              const path = `b${layer}/mlp/${w}`;
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
                  W_{w}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="text-xs text-text-faint">run a prompt to see activations</p>
      )}
    </Band>
  );
}
