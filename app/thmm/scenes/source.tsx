/**
 * Scene 1 — Source. Editable .thcc text with line numbers, plus a small
 * stats line showing what just compiled (count of ast nodes, instructions,
 * vars). On parse failure the editor stays editable so the user can fix it.
 */
"use client";

import CaesarInput from "../components/caesar-input";
import SourceView from "../components/source-view";
import { useCompiler } from "../state/compiler-store";

export default function SourceScene() {
  const { source, setSource, result, activeScenarioKey } = useCompiler();
  return (
    <div className="space-y-3">
      {activeScenarioKey === "caesar" && <CaesarInput mode="plain" />}

      <div className="text-sm text-text-muted">
        Edit the program. The compiler runs every keystroke.
      </div>
      <SourceView source={source} onChange={setSource} editable />
      {result?.ok && (
        <div className="text-xs text-text-muted font-mono flex flex-wrap gap-x-6 gap-y-1">
          <span>{result.ast.length} statements</span>
          <span>{result.varMap.length} variables</span>
          <span>{result.symInsts.length} symbolic instructions</span>
          <span>{result.instructions.length} machine instructions</span>
          <span>{result.maxTemps} scratch temps</span>
        </div>
      )}
    </div>
  );
}
