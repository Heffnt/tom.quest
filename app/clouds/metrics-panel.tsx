"use client";

import type { ColorMode } from "./lib/types";

export function MetricsPanel({ mode }: { mode: ColorMode }) {
  if (!mode.metrics || mode.metrics.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-surface/85 backdrop-blur-md p-3 text-xs animate-settle-delay-2">
      <div className="font-display text-sm font-semibold mb-2">Metrics</div>
      <ul className="space-y-1">
        {mode.metrics.map((m) => (
          <li key={m.label} className="flex items-center justify-between gap-4">
            <span className="text-text-muted">{m.label}</span>
            <span className="font-mono text-text tabular-nums">{m.value.toFixed(3)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
