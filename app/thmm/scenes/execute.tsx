/**
 * Scene 5 — Execute. CPU diagram + RAM grid + registers + asm listing.
 * The IO panel sits at the top and is now generic across scenarios:
 * input field, expected output, live actual output, all in one compact strip.
 *
 * Each scenario also names its input and output cells; they're highlighted
 * in the RAM grid so the audience can watch the answer accumulate in place.
 */
"use client";

import { useMemo } from "react";
import { toUint } from "../cpu";
import AsmView from "../components/asm-view";
import CpuDiagram from "../components/cpu-diagram";
import ExecControls from "../components/exec-controls";
import IOPanel from "../components/io-panel";
import RamGrid from "../components/ram-grid";
import RegistersPanel from "../components/registers-panel";
import SourceView from "../components/source-view";
import { findScenarioByKey, type Scenario } from "../scenarios";
import type { VarBinding } from "../thcc";
import { useCompiler } from "../state/compiler-store";

export default function ExecuteScene() {
  const { source, result, cpu, signals, activeScenarioKey } = useCompiler();
  const scenario = findScenarioByKey(activeScenarioKey);

  const outputAddrs = useMemo<Set<number>>(
    () => collectOutputAddrs(scenario, result?.ok ? result.varMap : []),
    [scenario, result],
  );
  const inputAddrs = useMemo<Set<number>>(
    () => collectInputAddrs(scenario, result?.ok ? result.varMap : []),
    [scenario, result],
  );

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
        <IOPanel scenario={scenario} varMap={result.varMap} ram={cpu.ram} />
      )}

      <CpuDiagram signals={signals} pc={cpu.pc} ir={cpu.ir} acc={cpu.acc} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <RamGrid
            ram={cpu.ram}
            signals={signals}
            pc={cpu.pc}
            inputs={inputAddrs}
            outputs={outputAddrs}
          />
        </div>
        <RegistersPanel />
      </div>

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
    </div>
  );
}

function collectOutputAddrs(scenario: Scenario | null, varMap: VarBinding[]): Set<number> {
  if (!scenario) return new Set();
  const names = scenario.io.output.getNames(varMap);
  const out = new Set<number>();
  for (const name of names) {
    const v = varMap.find(b => b.name === name);
    if (v) out.add(v.addr);
  }
  return out;
}

function collectInputAddrs(scenario: Scenario | null, varMap: VarBinding[]): Set<number> {
  if (!scenario) return new Set();
  const input = scenario.io.input;
  const out = new Set<number>();
  if (!input) return out;
  if (input.kind === "vars") {
    for (const v of input.vars) {
      const b = varMap.find(x => x.name === v.name);
      if (b) out.add(b.addr);
    }
  } else if (input.kind === "caesar") {
    // Highlight the cN cipher cells.
    for (const v of varMap) {
      if (/^c\d+$/.test(v.name)) out.add(v.addr);
    }
  }
  return out;
}

function pad3(n: number): string {
  return n.toString().padStart(3, " ");
}
