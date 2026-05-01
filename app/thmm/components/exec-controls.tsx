/**
 * Forward-only execution controls. Step advances the CPU by one clock
 * tick (half an instruction); Run plays at a slow pace until halt; Reset
 * reloads the freshly compiled program and clears overrides.
 *
 * No step-back: forward-only is the explicit design choice.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { useCompiler } from "../state/compiler-store";

export default function ExecControls() {
  const { cpu, step, reset, hasOverrides } = useCompiler();
  const [playing, setPlaying] = useState(false);
  const [hz, setHz] = useState(8);
  const stepRef = useRef(step);
  useEffect(() => { stepRef.current = step; }, [step]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      if (cpu?.halted === "1") { setPlaying(false); return; }
      stepRef.current();
    }, 1000 / hz);
    return () => clearInterval(id);
  }, [playing, hz, cpu]);

  const halted = cpu?.halted === "1";

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] p-3 flex items-center gap-3 flex-wrap">
      <button
        onClick={() => setPlaying(p => !p)}
        disabled={halted}
        className={`px-3 py-1.5 text-sm rounded border transition-colors ${
          playing
            ? "border-accent text-accent bg-accent/10"
            : "border-white/15 text-white/80 hover:text-white hover:border-white/30 disabled:opacity-40"
        }`}
      >
        {playing ? "Pause" : "Run"}
      </button>
      <button
        onClick={() => { setPlaying(false); step(); }}
        disabled={halted}
        className="px-3 py-1.5 text-sm rounded border border-white/15 text-white/80 hover:text-white hover:border-white/30 disabled:opacity-40"
      >
        Step
      </button>
      <button
        onClick={() => { setPlaying(false); reset(); }}
        className="px-3 py-1.5 text-sm rounded border border-white/15 text-white/80 hover:text-white hover:border-white/30"
      >
        Reset
      </button>

      <div className="flex items-center gap-2 ml-2">
        <span className="text-xs text-text-muted">speed</span>
        <input
          type="range"
          min={1} max={64} step={1}
          value={hz}
          onChange={(e) => setHz(parseInt(e.target.value, 10))}
          className="w-32"
        />
        <span className="text-xs text-text-muted font-mono w-14">{hz} Hz</span>
      </div>

      <div className="ml-auto text-xs text-text-muted flex items-center gap-3">
        {halted && <span className="text-success">halted</span>}
        {hasOverrides && <span className="text-warning">overrides applied</span>}
      </div>
    </div>
  );
}
