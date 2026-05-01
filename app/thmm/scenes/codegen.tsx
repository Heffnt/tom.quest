/**
 * Scene 3 — Codegen. Source on the left, symbolic asm on the right,
 * synchronized highlighting in both directions. Step button compiles one
 * more statement so the asm grows alongside.
 *
 * "Symbolic" means addresses are still labels: `loadm x0`, `subm OFFSET`,
 * `store t0` — never a numeric RAM address. That happens in scene 4.
 */
"use client";

import { useMemo, useState } from "react";
import AsmView from "../components/asm-view";
import SourceView from "../components/source-view";
import StepControls from "../components/step-controls";
import { type CompileResult, type Span, type SymInst, symInstToAsm } from "../thcc";
import { useCompiler } from "../state/compiler-store";

export default function CodegenScene() {
  const { result, source } = useCompiler();
  const [hoveredStmt, setHoveredStmt] = useState<number | null>(null);
  const [stepState, setStepState] = useState<{ result: CompileResult | null; visible: number }>({
    result, visible: 0,
  });
  if (stepState.result !== result) {
    setStepState({ result, visible: 0 });
  }
  const visible = stepState.visible;
  const setVisible = (next: number | ((prev: number) => number)) =>
    setStepState(s => ({ ...s, visible: typeof next === "function" ? next(s.visible) : next }));

  // Compute, per statement, the slice of symInsts it produced. We do this
  // by grouping symInsts whose span lies within the statement's span — the
  // codegen stamps every emitted instruction with its origin span.
  const grouped = useMemo(() => {
    if (!result || !result.ok) return [] as { stmt: number; insts: { sym: SymInst; idx: number }[] }[];
    const out: { stmt: number; insts: { sym: SymInst; idx: number }[] }[] = [];
    for (let si = 0; si < result.ast.length; si++) {
      const stmt = result.ast[si];
      const matches: { sym: SymInst; idx: number }[] = [];
      result.symInsts.forEach((sym, idx) => {
        // Skip the trailing halt — its span is at end-of-program.
        if (sym.op === "halt") return;
        if (sym.span.start >= stmt.span.start && sym.span.end <= stmt.span.end) {
          matches.push({ sym, idx });
        }
      });
      out.push({ stmt: si, insts: matches });
    }
    return out;
  }, [result]);

  if (!result || !result.ok) {
    return (
      <div className="text-sm text-text-muted">
        Fix the compile error in scene 1 to view the codegen output.
      </div>
    );
  }

  const total = result.ast.length;
  const atEnd = visible >= total;

  // Determine which symInst rows are visible. Only the statements [0..visible)
  // contribute their instructions; halt is shown only when all statements are.
  const emittedRows: { addr: string | null; asm: string; idx: number }[] = [];
  for (let i = 0; i < visible; i++) {
    for (const { sym, idx } of grouped[i].insts) {
      emittedRows.push({ addr: pad3(idx) + ":", asm: symInstToAsm(sym), idx });
    }
  }
  if (atEnd) {
    const haltIdx = result.symInsts.findIndex((s) => s.op === "halt");
    if (haltIdx >= 0) {
      emittedRows.push({ addr: pad3(haltIdx) + ":", asm: "halt", idx: haltIdx });
    }
  }

  // Highlights: when a statement is hovered, light up its source span and
  // every asm row it produced.
  let sourceHighlights: Span[] = [];
  let asmHighlightSet = new Set<number>();
  if (hoveredStmt !== null && hoveredStmt < grouped.length) {
    const stmt = result.ast[hoveredStmt];
    sourceHighlights = [stmt.span];
    asmHighlightSet = new Set(grouped[hoveredStmt].insts.map((m) => m.idx));
  }

  return (
    <div className="space-y-4">
      <StepControls
        value={visible}
        total={total}
        onChange={setVisible}
        unit="statement"
        rightSlot={`${emittedRows.length} symbolic instructions emitted`}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-text-muted mb-1.5">Source · click a line to highlight its instructions.</div>
          <SourceView
            source={source}
            highlights={sourceHighlights}
            onLineClick={(line) => {
              // Find the statement that begins on this line (1-based).
              const lineStart = lineOffsetFor(source, line);
              const lineEnd = lineStart + (source.split("\n")[line - 1]?.length ?? 0);
              const idx = result.ast.findIndex(
                (s) => s.span.start >= lineStart && s.span.start <= lineEnd
              );
              if (idx >= 0) setHoveredStmt(idx === hoveredStmt ? null : idx);
            }}
          />
        </div>
        <div>
          <div className="text-xs text-text-muted mb-1.5">Symbolic asm · addresses are still labels.</div>
          <AsmView
            rows={emittedRows.map((r) => ({ addr: r.addr, asm: r.asm }))}
            highlight={emittedRows
              .map((r, i) => (asmHighlightSet.has(r.idx) ? i : -1))
              .filter((i) => i >= 0)}
            onRowClick={(rowIdx) => {
              // Resolve back to the statement that produced this asm row.
              const symIdx = emittedRows[rowIdx].idx;
              const stmtIdx = grouped.findIndex((g) => g.insts.some((m) => m.idx === symIdx));
              if (stmtIdx >= 0) setHoveredStmt(stmtIdx === hoveredStmt ? null : stmtIdx);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function pad3(n: number): string {
  return n.toString().padStart(3, " ");
}

function lineOffsetFor(source: string, line: number): number {
  let off = 0;
  for (let i = 1; i < line; i++) {
    const nl = source.indexOf("\n", off);
    if (nl < 0) return off;
    off = nl + 1;
  }
  return off;
}
