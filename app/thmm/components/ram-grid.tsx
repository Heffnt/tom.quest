/**
 * Editable RAM grid. Each of the 256 cells is shown in the user-selected
 * mode (decimal / hex / ASCII / binary). Clicking a cell turns it into a
 * text input; the new value is poked into the live CPU state.
 *
 * Visual cues:
 *   - PC cell: subtle accent background
 *   - cell read this cycle: accent border
 *   - cell written this cycle: solid accent fill
 *   - zero cell: dimmed
 *   - manually overridden cell: thin accent outline
 */
"use client";

import { useState } from "react";
import type { Bits, Signals } from "../cpu";
import { toUint } from "../cpu";
import Editable from "./editable";
import { displayBits, parseInput, type ViewMode } from "../lib/format";
import { useCompiler } from "../state/compiler-store";

type Props = {
  ram: Bits[];
  signals: Signals | null;
  pc: Bits;
};

export default function RamGrid({ ram, signals, pc }: Props) {
  const [mode, setMode] = useState<ViewMode>("hex");
  const [overrides] = useState<Set<number>>(() => new Set());
  const { pokeCpu } = useCompiler();

  const pcIdx = toUint(pc);
  const readIdx = signals ? toUint(signals.addr8) : -1;
  const writeIdx = signals && signals.ramWe1 === "1" ? toUint(signals.ramData8) : -1;

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-sm font-medium">RAM</div>
          <div className="text-xs text-text-muted">256 × 16 bits — click any cell to edit.</div>
        </div>
        <ModePicker mode={mode} onChange={setMode} />
      </div>

      <div
        className="grid gap-[2px] font-mono text-xs"
        style={{ gridTemplateColumns: "auto repeat(16, minmax(0, 1fr))" }}
      >
        {/* Column header: low nibble */}
        <div />
        {Array.from({ length: 16 }, (_, col) => (
          <div key={col} className="text-text-faint text-center py-0.5">
            {col.toString(16).toUpperCase()}
          </div>
        ))}

        {Array.from({ length: 16 }, (_, row) => (
          <div key={`r${row}`} className="contents">
            <div className="text-text-faint text-right pr-2 py-0.5 flex items-center justify-end">
              {row.toString(16).toUpperCase()}
            </div>
            {Array.from({ length: 16 }, (_, col) => {
              const idx = row * 16 + col;
              const value = ram[idx];
              const isPc = idx === pcIdx;
              const isRead = idx === readIdx;
              const isWrite = idx === writeIdx;

              let bg = "transparent";
              let border = "transparent";
              if (isPc)    { bg = "rgba(232, 160, 64, 0.10)"; }
              if (isRead)  { border = "var(--color-accent)"; }
              if (isWrite) { bg = "var(--color-accent)"; }

              return (
                <div
                  key={`c${idx}`}
                  className="rounded-[2px] border"
                  style={{ backgroundColor: bg, borderColor: border }}
                  title={`0x${idx.toString(16).padStart(2, "0").toUpperCase()}: 0x${toUint(value).toString(16).padStart(4, "0").toUpperCase()}`}
                >
                  <Editable
                    value={value}
                    display={(v) => displayBits(v, mode)}
                    parse={(input) => parseInput(input, 16, mode)}
                    onCommit={(next) => {
                      pokeCpu(s => { s.ram[idx] = next; });
                      overrides.add(idx);
                    }}
                    overridden={overrides.has(idx)}
                    className="w-full text-center py-0.5 text-[11px]"
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mt-3 flex gap-4 text-xs text-text-muted">
        <span><span className="inline-block w-3 h-3 align-middle mr-1 rounded-[2px]" style={{ backgroundColor: "rgba(232, 160, 64, 0.10)" }} /> PC</span>
        <span><span className="inline-block w-3 h-3 align-middle mr-1 rounded-[2px] border" style={{ borderColor: "var(--color-accent)" }} /> read</span>
        <span><span className="inline-block w-3 h-3 align-middle mr-1 rounded-[2px]" style={{ backgroundColor: "var(--color-accent)" }} /> write</span>
      </div>
    </div>
  );
}

function ModePicker({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  const modes: ViewMode[] = ["hex", "dec", "ascii", "bin"];
  return (
    <div className="flex gap-1">
      {modes.map(m => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={`px-2 py-1 text-xs rounded border ${
            mode === m
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

