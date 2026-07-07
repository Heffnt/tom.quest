"use client";

import { useState, type ReactNode } from "react";
import { source, useTransformer, type StratumPath } from "../state";
import { attnTensors, embedTensor, mlpTensors, unembedTensor, type TensorInfo } from "../lib/model";
import BlockStratum from "./block-stratum";
import HeadsStratum from "./heads-stratum";
import HeadStratum from "./head-stratum";
import MlpStratum from "./mlp-stratum";
import WeightsStratum from "./weights-stratum";

// Each open drill path renders as one full-width, collapsible band. Bands are
// ordered by model position (embed → blocks → unembed), then drill depth, so
// scrolling down always reads as zooming further in.

export function Band({
  path,
  crumbs,
  meta,
  children,
}: {
  path: StratumPath;
  crumbs: string[];
  meta?: ReactNode;
  children: ReactNode;
}) {
  const close = useTransformer((s) => s.close);
  const [folded, setFolded] = useState(false);
  return (
    <section className="rounded-lg border border-border bg-surface">
      <header className="flex h-7 items-center gap-2 px-2">
        <button
          onClick={() => setFolded(!folded)}
          className="w-4 text-[10px] text-text-faint hover:text-text"
          aria-label={folded ? "expand" : "collapse"}
        >
          {folded ? "▸" : "▾"}
        </button>
        <span className="font-mono text-[11px] text-text-muted">
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && <span className="mx-1 text-text-faint">›</span>}
              <span className={i === crumbs.length - 1 ? "text-text" : ""}>{c}</span>
            </span>
          ))}
        </span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[10px] text-text-faint">{meta}</span>
        <button onClick={() => close(path)} className="px-1 text-text-faint hover:text-error" aria-label="close">
          ×
        </button>
      </header>
      {!folded && <div className="border-t border-border px-3 py-2">{children}</div>}
    </section>
  );
}

const ATTN_W: Record<string, number> = { wq: 0, wk: 1, wv: 2, wo: 3 };
const MLP_W: Record<string, number> = { gate: 0, up: 1, down: 2 };

function tensorFor(path: StratumPath): { tensor: TensorInfo; crumbs: string[] } | null {
  const cfg = source.model;
  if (path === "embed") return { tensor: embedTensor(cfg), crumbs: ["embedding", "W_E"] };
  if (path === "unembed") return { tensor: unembedTensor(cfg), crumbs: ["unembedding", "W_U"] };
  const seg = path.split("/");
  const layer = Number(seg[0].slice(1));
  if (seg[1] === "attn" && seg[2] in ATTN_W) {
    const t = attnTensors(cfg, layer)[ATTN_W[seg[2]]];
    return { tensor: t, crumbs: [`block ${layer}`, "attention", t.label] };
  }
  if (seg[1] === "mlp" && seg[2] in MLP_W) {
    const t = mlpTensors(cfg, layer)[MLP_W[seg[2]]];
    return { tensor: t, crumbs: [`block ${layer}`, "mlp", t.label] };
  }
  return null;
}

function renderStratum(path: StratumPath): ReactNode {
  const seg = path.split("/");
  if (path === "embed" || path === "unembed") {
    const t = tensorFor(path)!;
    return <WeightsStratum key={path} path={path} tensor={t.tensor} crumbs={t.crumbs} />;
  }
  const layer = Number(seg[0].slice(1));
  if (seg.length === 1) return <BlockStratum key={path} layer={layer} />;
  if (seg.length === 2 && seg[1] === "attn") return <HeadsStratum key={path} layer={layer} />;
  if (seg.length === 2 && seg[1] === "mlp") return <MlpStratum key={path} layer={layer} />;
  if (seg.length === 3 && seg[1] === "attn" && seg[2].startsWith("h")) {
    return <HeadStratum key={path} layer={layer} head={Number(seg[2].slice(1))} />;
  }
  const t = tensorFor(path);
  if (t) return <WeightsStratum key={path} path={path} tensor={t.tensor} crumbs={t.crumbs} />;
  return null;
}

export default function StrataStack() {
  const open = useTransformer((s) => s.open);
  if (open.length === 0) {
    return (
      <p className="mt-3 text-center text-xs text-text-faint">
        click a block on the spine — or embed / unembed — to open it as a stratum; keep clicking to drill down to raw
        weights
      </p>
    );
  }
  return <div className="mt-2 flex flex-col gap-2">{open.map((p) => renderStratum(p))}</div>;
}
