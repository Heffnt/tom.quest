"use client";

import { getSource, producingStep, useTransformer } from "../state";
import { Band } from "./strata";

// One block drawn as what it is: two additive taps on the residual stream,
// each behind a pre-norm, for the pass that produced the selected token. Click
// a sublayer to open the next stratum down.
export default function BlockStratum({ layer }: { layer: number }) {
  const { trace, selected, open, toggle } = useTransformer();
  const stepIdx = producingStep(selected);
  const ls = trace && stepIdx >= 0 ? trace.steps[stepIdx]?.layers[layer] : undefined;
  const maxW = ls ? Math.max(ls.attnWrite, ls.mlpWrite, 1e-9) : 1;

  const sub = (label: string, path: string, value: number | undefined) => {
    const active = open.includes(path);
    return (
      <button
        onClick={() => toggle(path)}
        title={value !== undefined ? `open ${label} · writes ‖Δh‖ ${value.toFixed(2)}` : `open ${label}`}
        className={[
          "flex items-center gap-2 rounded border px-2 py-1",
          active ? "border-accent/70" : "border-border hover:border-text-faint",
        ].join(" ")}
      >
        <span className={active ? "text-accent" : "text-text"}>{label}</span>
        <span className="h-1 w-16 overflow-hidden rounded bg-surface-alt">
          <span
            className="block h-full bg-accent"
            style={{ width: value !== undefined ? `${(value / maxW) * 100}%` : 0 }}
          />
        </span>
        <span className="text-text-muted">{value !== undefined ? `+${value.toFixed(1)}` : "–"}</span>
      </button>
    );
  };

  const norm = (
    <span
      className="flex h-4 w-4 items-center justify-center rounded-full border border-border text-[8px] text-text-faint"
      title="rmsnorm (pre-norm read)"
    >
      ln
    </span>
  );
  const add = (
    <span className="text-text-faint" title="added back into the residual stream">
      ⊕
    </span>
  );
  const wire = <span className="h-px min-w-3 flex-1 bg-border" aria-hidden />;

  const hOut = ls ? ls.residNorm + ls.attnWrite + ls.mlpWrite : undefined;

  return (
    <Band
      path={`b${layer}`}
      crumbs={[`block ${layer}`]}
      meta={
        <span>
          d{getSource().model.dModel} · {getSource().model.nHeads} heads · mlp {getSource().model.dMlp}
        </span>
      }
    >
      <div className="flex items-center gap-1.5 overflow-x-auto font-mono text-[11px]">
        <span className="whitespace-nowrap text-text-muted" title="residual norm entering the block">
          h ‖{ls ? ls.residNorm.toFixed(1) : "–"}‖
        </span>
        {wire}
        {norm}
        {sub("attention", `b${layer}/attn`, ls?.attnWrite)}
        {add}
        {wire}
        {norm}
        {sub("mlp", `b${layer}/mlp`, ls?.mlpWrite)}
        {add}
        {wire}
        <span className="whitespace-nowrap text-text-muted" title="residual norm leaving the block (approx)">
          h′ ‖{hOut ? hOut.toFixed(1) : "–"}‖
        </span>
      </div>
    </Band>
  );
}
