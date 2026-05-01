"use client";

import SceneShell from "./components/scene-shell";
import { CompilerProvider, useCompiler } from "./state/compiler-store";
import { DEFAULT_SCENARIO } from "./scenarios";
import SourceScene from "./scenes/source";
import ParseScene from "./scenes/parse";
import CodegenScene from "./scenes/codegen";
import LinkScene from "./scenes/link";
import ExecuteScene from "./scenes/execute";

export default function ThmmPage() {
  return (
    <CompilerProvider
      initialSource={DEFAULT_SCENARIO.source}
      initialScenarioKey={DEFAULT_SCENARIO.key}
    >
      <SceneShell>
        <ActiveScene />
      </SceneShell>
    </CompilerProvider>
  );
}

function ActiveScene() {
  const { scene } = useCompiler();
  switch (scene) {
    case "source":  return <SourceScene  />;
    case "parse":   return <ParseScene   />;
    case "codegen": return <CodegenScene />;
    case "link":    return <LinkScene    />;
    case "execute": return <ExecuteScene />;
  }
}
