/**
 * Display-mode picker for register / RAM / IO panels. Reads and writes the
 * shared `displayMode` in the compiler context, so changing it on one panel
 * updates every panel at once.
 */
"use client";

import type { ViewMode } from "../lib/format";
import { useCompiler } from "../state/compiler-store";

const MODES: ViewMode[] = ["hex", "dec", "ascii", "bin"];

export default function ModePicker() {
  const { displayMode, setDisplayMode } = useCompiler();
  return (
    <div className="flex gap-1">
      {MODES.map(m => (
        <button
          key={m}
          onClick={() => setDisplayMode(m)}
          className={`px-2 py-1 text-xs rounded border ${
            displayMode === m
              ? "border-accent text-accent bg-accent/5"
              : "border-white/10 text-white/55 hover:text-white/85"
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}
