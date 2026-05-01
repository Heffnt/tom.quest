/**
 * Scene 4 — Link. The same instructions twice: once with symbolic labels,
 * once after the linker has resolved each label to a numeric RAM address.
 * Hovering a row in either listing highlights the matching variable in the
 * address table.
 */
"use client";

import { useState } from "react";
import AsmView from "../components/asm-view";
import VarMapPanel from "../components/var-map-panel";
import { symInstToAsm, type VarBinding } from "../thcc";
import { useCompiler } from "../state/compiler-store";

export default function LinkScene() {
  const { result } = useCompiler();
  const [hoverVar, setHoverVar] = useState<VarBinding | null>(null);

  if (!result || !result.ok) {
    return (
      <div className="text-sm text-text-muted">
        Fix the compile error in scene 1 to view the linker output.
      </div>
    );
  }

  // Highlight asm rows whose addr resolves to the hovered variable.
  const highlightLinked = new Set<number>();
  const highlightSymbolic = new Set<number>();
  if (hoverVar) {
    result.instructions.forEach((inst, i) => {
      if (inst.arg === hoverVar.addr) highlightLinked.add(i);
    });
    result.symInsts.forEach((s, i) => {
      if (s.addr && s.addr.kind === "var" && s.addr.name === hoverVar.name) {
        highlightSymbolic.add(i);
      }
    });
  }

  const symbolicRows = result.symInsts.map((s, i) => ({
    addr: pad3(i) + ":",
    asm: symInstToAsm(s),
  }));
  const linkedRows = result.instructions.map((inst, i) => ({
    addr: pad3(i) + ":",
    asm: inst.asm,
  }));

  return (
    <div className="space-y-4">
      <div className="text-sm text-text-muted">
        The linker assigns each variable name and scratch temp to a concrete
        RAM address, then walks the instruction list and resolves each label.
        Hover a variable in the address table to see where it appears.
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div>
          <div className="text-xs text-text-muted mb-1.5">Before — symbolic labels</div>
          <AsmView rows={symbolicRows} highlight={highlightSymbolic} />
        </div>
        <div>
          <div className="text-xs text-text-muted mb-1.5">After — numeric addresses</div>
          <AsmView rows={linkedRows} highlight={highlightLinked} />
        </div>
        <div>
          <VarMapPanel
            varMap={result.varMap}
            onHover={setHoverVar}
            highlightName={hoverVar?.name ?? null}
          />
          <div className="text-xs text-text-muted mt-2">
            Layout: instructions [0..{result.instructions.length - 1}], then
            variables, then {result.maxTemps} scratch temp{result.maxTemps === 1 ? "" : "s"}.
          </div>
        </div>
      </div>
    </div>
  );
}

function pad3(n: number): string {
  return n.toString().padStart(3, " ");
}
