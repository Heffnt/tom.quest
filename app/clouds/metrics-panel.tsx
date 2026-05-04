"use client";

import type { ColorMode } from "./lib/types";

export function MetricsPanel({ mode }: { mode: ColorMode }) {
  const metrics = mode.metrics ?? [];

  return (
    <div className="min-w-44 rounded-lg border border-border bg-surface/85 backdrop-blur-md p-3 text-xs animate-settle-delay-2">
      <div className="font-display text-sm font-semibold mb-1">Setup Metrics</div>
      <div className="mb-2 max-w-48 truncate font-mono text-[11px] text-text-faint">
        {mode.label}
      </div>
      {metrics.length > 0 ? (
        <ul className="space-y-1">
          {metrics.map((m) => (
            <li key={m.label} className="flex items-center justify-between gap-4">
              <span className="text-text-muted">{m.label}</span>
              <span className="font-mono text-text tabular-nums">{m.value.toFixed(3)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-text-faint">No run metrics for this mode.</div>
      )}
    </div>
  );
}
