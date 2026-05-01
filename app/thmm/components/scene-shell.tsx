/**
 * The page chrome shared by every scene: header, scenario picker, scene
 * navigation strip, error banner. Routes the active scene's body component
 * into the main slot.
 */
"use client";

import { useEffect } from "react";
import { formatError } from "../thcc";
import { SCENARIOS } from "../scenarios";
import { SCENES, useCompiler } from "../state/compiler-store";

type Props = {
  children: React.ReactNode;
};

export default function SceneShell({ children }: Props) {
  const { source, setSource, scene, setScene, result } = useCompiler();

  // Arrow keys cycle scenes; ignored when an input or textarea has focus
  // (so editing source / poking cells doesn't navigate away).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const i = SCENES.findIndex(s => s.key === scene);
      const di = e.key === "ArrowRight" ? 1 : -1;
      const j = (i + di + SCENES.length) % SCENES.length;
      setScene(SCENES[j].key);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scene, setScene]);

  return (
    <div className="min-h-screen px-4 py-10 max-w-7xl mx-auto space-y-5">
      <header>
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-3xl font-bold tracking-tight">THMM</h1>
          <span className="text-text-muted text-sm">·</span>
          <span className="text-text-muted text-sm">16-bit accumulator machine + THCC compiler</span>
        </div>
        <p className="text-text-muted mt-1 text-sm max-w-3xl">
          A small CPU and a small compiler, side by side. Pick a program, then walk
          through how the source becomes machine code and what happens when it runs.
        </p>
      </header>

      <ScenarioPicker
        currentSource={source}
        onPick={setSource}
      />

      <nav className="border border-white/10 rounded-lg bg-white/[0.02] overflow-x-auto">
        <div className="flex min-w-max">
          {SCENES.map((s, i) => {
            const active = scene === s.key;
            return (
              <button
                key={s.key}
                onClick={() => setScene(s.key)}
                className={`px-4 py-3 text-sm border-r border-white/5 transition-colors flex items-center gap-2 ${
                  active
                    ? "bg-white/[0.08] text-white/90"
                    : "text-white/45 hover:text-white/75 hover:bg-white/[0.03]"
                }`}
              >
                <span className="text-text-faint text-xs font-mono">{i + 1}</span>
                {s.label}
              </button>
            );
          })}
        </div>
      </nav>

      {result && !result.ok && (
        <div className="border border-error/40 rounded bg-error/10 px-3 py-2 text-sm text-error">
          {formatError(result.error)}
        </div>
      )}

      <main>{children}</main>

      <footer className="text-text-muted text-xs flex items-center gap-3 pt-2">
        <span>← / → to switch scenes</span>
        <span className="text-text-faint">·</span>
        <a
          href="https://github.com/heffnt"
          target="_blank"
          rel="noopener"
          className="hover:text-text"
        >
          source
        </a>
      </footer>
    </div>
  );
}

function ScenarioPicker({
  currentSource,
  onPick,
}: {
  currentSource: string;
  onPick: (s: string) => void;
}) {
  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] p-3">
      <div className="text-xs text-text-muted mb-2">Scenario</div>
      <div className="flex flex-wrap gap-2">
        {SCENARIOS.map(s => {
          const active = currentSource === s.source;
          return (
            <button
              key={s.key}
              onClick={() => onPick(s.source)}
              className={`px-3 py-1.5 text-sm rounded border transition-colors ${
                active
                  ? "border-accent text-accent bg-accent/5"
                  : "border-white/10 text-white/55 hover:text-white/85 hover:border-white/20"
              }`}
              title={s.blurb}
            >
              {s.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
