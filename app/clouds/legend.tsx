"use client";

import type { ColorMode } from "./lib/types";

export function Legend({ mode }: { mode: ColorMode }) {
  // Cap to keep the panel scannable -- leaf-level can have dozens of classes.
  const ENTRIES_VISIBLE = 16;
  const entries = mode.palette.slice(0, ENTRIES_VISIBLE);
  const overflow = mode.palette.length - entries.length;

  return (
    <div className="absolute bottom-4 right-4 z-10 max-w-xs rounded-lg border border-border bg-surface/85 backdrop-blur-md p-3 text-xs animate-settle-delay-2">
      <div className="font-display text-sm font-semibold mb-2">{mode.label}</div>
      <ul className="space-y-1">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 rounded-sm border border-black/30"
              style={{
                backgroundColor: `rgb(${entry.color[0]}, ${entry.color[1]}, ${entry.color[2]})`,
              }}
            />
            <span className="text-text-muted truncate">{entry.name}</span>
          </li>
        ))}
        {overflow > 0 && (
          <li className="text-text-faint italic pl-5">+ {overflow} more…</li>
        )}
      </ul>
    </div>
  );
}
