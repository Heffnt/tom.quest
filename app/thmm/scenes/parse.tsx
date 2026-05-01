/**
 * Scene 2 — Parse. Source on the top half, AST as indented text on the
 * bottom half. Step button parses one more statement at a time so the
 * tree grows in front of the audience.
 *
 * Hovering a node in the tree highlights the source span it came from,
 * and clicking a source line highlights the corresponding statement.
 */
"use client";

import { useState } from "react";
import AstTree from "../components/ast-tree";
import SourceView from "../components/source-view";
import StepControls from "../components/step-controls";
import type { CompileResult, Span } from "../thcc";
import { useCompiler } from "../state/compiler-store";

export default function ParseScene() {
  const { result, source } = useCompiler();
  const [hover, setHover] = useState<Span | null>(null);
  // Derived state pattern: when the compile result identity changes, reset
  // the stepping counter without firing an effect.
  const [stepState, setStepState] = useState<{ result: CompileResult | null; visible: number }>({
    result, visible: 0,
  });
  if (stepState.result !== result) {
    setStepState({ result, visible: 0 });
  }
  const visible = stepState.visible;
  const setVisible = (next: number | ((prev: number) => number)) =>
    setStepState(s => ({ ...s, visible: typeof next === "function" ? next(s.visible) : next }));

  if (!result || !result.ok) {
    return (
      <div className="text-sm text-text-muted">
        Fix the compile error in scene 1 to view the AST.
      </div>
    );
  }

  const total = result.ast.length;

  return (
    <div className="space-y-4">
      <StepControls
        value={visible}
        total={total}
        onChange={setVisible}
        unit="statement"
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SourceView source={source} highlights={hover ? [hover] : []} />
        <AstTree
          program={result.ast}
          visibleCount={visible}
          highlightSpan={hover}
          onNodeClick={setHover}
        />
      </div>
    </div>
  );
}
