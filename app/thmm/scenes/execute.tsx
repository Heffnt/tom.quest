/**
 * Scene 5 — Execute. CPU diagram + RAM grid + registers + asm listing,
 * with three-way highlighting: the asm row at PC, the source span that
 * produced it, and the corresponding RAM cell all light up together.
 *
 * Each scenario also names a set of "output" variables — the cells where
 * the answer accumulates. Those cells are flagged in the RAM grid and
 * surfaced front-and-centre in the output panel above the diagram, so the
 * audience can read the final result as it forms.
 */
"use client";

import { useMemo } from "react";
import { toUint } from "../cpu";
import AsmView from "../components/asm-view";
import CpuDiagram from "../components/cpu-diagram";
import ExecControls from "../components/exec-controls";
import OutputPanel from "../components/output-panel";
import RamGrid from "../components/ram-grid";
import RegistersPanel from "../components/registers-panel";
import SourceView from "../components/source-view";
import { matchScenario } from "../scenarios";
import { useCompiler } from "../state/compiler-store";

export default function ExecuteScene() {
  const { source, result, cpu, signals } = useCompiler();
  const scenario = matchScenario(source);

  const outputAddrs = useMemo<Set<number>>(() => {
    if (!scenario || !result || !result.ok) return new Set();
    const addrs = new Set<number>();
    for (const name of scenario.outputs) {
      const v = result.varMap.find(b => b.name === name);
      if (v) addrs.add(v.addr);
    }
    return addrs;
  }, [scenario, result]);

  if (!result || !result.ok || !cpu) {
    return (
      <div className="text-sm text-text-muted">
        Fix the compile error in scene 1 to run the program.
      </div>
    );
  }

  const pcIdx = toUint(cpu.pc);
  const currentInst = result.instructions[pcIdx];
  const currentSpan = currentInst?.span;

  const asmRows = result.instructions.map((inst, i) => ({
    addr: pad3(i) + ":",
    asm: inst.asm,
  }));

  return (
    <div className="space-y-4">
      <ExecControls />

      {scenario && (
        <OutputPanel scenario={scenario} varMap={result.varMap} ram={cpu.ram} />
      )}

      <CpuDiagram signals={signals} pc={cpu.pc} ir={cpu.ir} acc={cpu.acc} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-text-muted mb-1.5">
            Source · the line currently executing.
          </div>
          <SourceView source={source} highlights={currentSpan ? [currentSpan] : []} />
        </div>
        <div>
          <div className="text-xs text-text-muted mb-1.5">
            Machine code · highlighted row is at PC = {pcIdx}.
          </div>
          <AsmView rows={asmRows} highlight={[pcIdx]} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <RamGrid ram={cpu.ram} signals={signals} pc={cpu.pc} outputs={outputAddrs} />
        </div>
        <RegistersPanel />
      </div>
    </div>
  );
}

function pad3(n: number): string {
  return n.toString().padStart(3, " ");
}
