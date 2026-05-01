/**
 * The five architectural registers (PC, IR, Acc, Phase, Halted) shown as
 * a labeled list of editable cells. Each row is one register; clicking the
 * value turns it into a text input that pokes the CPU.
 */
"use client";

import type { State } from "../cpu";
import Editable from "./editable";
import { displayBits, parseInput, type ViewMode } from "../lib/format";
import { useCompiler } from "../state/compiler-store";
import { useState } from "react";

type RegisterField = "pc" | "ir" | "acc" | "phase" | "halted";

export default function RegistersPanel() {
  const { cpu, pokeCpu } = useCompiler();
  const [mode, setMode] = useState<ViewMode>("hex");
  if (!cpu) return null;

  const rows: { name: string; field: RegisterField; width: number; note: string }[] = [
    { name: "PC",     field: "pc",     width: 8,  note: "8-bit program counter" },
    { name: "IR",     field: "ir",     width: 16, note: "16-bit instruction register" },
    { name: "Acc",    field: "acc",    width: 16, note: "16-bit accumulator" },
    { name: "Phase",  field: "phase",  width: 1,  note: "0 = fetch, 1 = execute" },
    { name: "Halted", field: "halted", width: 1,  note: "set when decoder fires Halt" },
  ];

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-sm font-medium">Registers</div>
          <div className="text-xs text-text-muted">Click any value to edit.</div>
        </div>
        <ModePicker mode={mode} onChange={setMode} />
      </div>

      <div className="font-mono text-sm">
        {rows.map(r => (
          <div key={r.name} className="flex items-baseline gap-3 py-1.5 border-b border-white/5 last:border-0">
            <div className="w-16 text-text">{r.name}</div>
            <Editable
              value={cpu[r.field]}
              display={(v) => displayBits(v, r.width === 1 ? "bin" : mode)}
              parse={(input) => parseInput(input, r.width, r.width === 1 ? "bin" : mode)}
              onCommit={(next) => pokeCpu((s: State) => { s[r.field] = next; })}
              className="text-accent flex-1 px-1 py-0.5 rounded"
            />
            <div className="text-text-muted text-xs hidden sm:block">{r.note}</div>
          </div>
        ))}
        <div className="flex items-baseline gap-3 py-1.5">
          <div className="w-16 text-text-muted">Cycle</div>
          <div className="text-text-muted">{cpu.cycle}</div>
        </div>
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
