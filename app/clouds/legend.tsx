"use client";

import type { ColorMode } from "./lib/types";

export function Legend({ mode }: { mode: ColorMode }) {
  return (
    <div className="max-w-xs max-h-[calc(100vh-8rem)] overflow-y-auto rounded-lg border border-border bg-surface/85 backdrop-blur-md p-3 text-xs animate-settle-delay-2">
      <div className="font-display text-sm font-semibold mb-2">{mode.label}</div>
      <ul className="space-y-1">
        {mode.palette.map((entry) => (
          <li key={entry.id} className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 rounded-sm border border-black/30 shrink-0"
              style={{
                backgroundColor: `rgb(${entry.color[0]}, ${entry.color[1]}, ${entry.color[2]})`,
              }}
            />
            <span className="text-text-muted truncate">{entry.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
