/**
 * The address table — variable name → RAM address. Read-only by default;
 * the link scene passes a row click handler to toggle which variable's
 * source span is highlighted.
 */
"use client";

import type { VarBinding } from "../thcc";

type Props = {
  varMap: VarBinding[];
  onHover?: (v: VarBinding | null) => void;
  /** When set, the matching row is highlighted. */
  highlightName?: string | null;
};

export default function VarMapPanel({ varMap, onHover, highlightName }: Props) {
  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] p-4">
      <div className="text-sm font-medium mb-1">Address table</div>
      <div className="text-xs text-text-muted mb-3">
        Each declared variable lives at one RAM address.
      </div>
      <div className="font-mono text-sm grid grid-cols-[auto_auto_1fr] gap-x-4 gap-y-0.5">
        <div className="text-text-faint text-xs uppercase tracking-wide">var</div>
        <div className="text-text-faint text-xs uppercase tracking-wide">addr</div>
        <div className="text-text-faint text-xs uppercase tracking-wide">decimal</div>
        {varMap.map(v => {
          const hi = highlightName === v.name;
          return (
            <div
              key={v.name}
              className="contents"
              onMouseEnter={() => onHover?.(v)}
              onMouseLeave={() => onHover?.(null)}
            >
              <div className={hi ? "text-accent" : "text-text"}>{v.name}</div>
              <div className={hi ? "text-accent" : "text-text-muted"}>
                0x{v.addr.toString(16).padStart(2, "0").toUpperCase()}
              </div>
              <div className={hi ? "text-accent" : "text-text-muted"}>{v.addr}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
