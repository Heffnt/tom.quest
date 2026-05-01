/**
 * Page-level state: the THCC source, the cached compile result, the current
 * scene, and the live CPU state for the execute scene. Everything is in one
 * provider so the scene shell, scene components, and the editable widgets
 * can reach into it without prop drilling.
 *
 * Recompile is debounced 150ms after the last keystroke. The CPU state is
 * (re)initialised whenever a fresh successful compile arrives — meaning a
 * source edit during scene 5 invalidates the running program, which is the
 * intended behaviour.
 */
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { compile, type CompileResult } from "../thcc";
import { initState, loadProgram, peek, tick, type Signals, type State } from "../cpu";

export type SceneKey = "source" | "parse" | "codegen" | "link" | "execute";

export const SCENES: ReadonlyArray<{ key: SceneKey; label: string }> = [
  { key: "source",  label: "Source"  },
  { key: "parse",   label: "Parse"   },
  { key: "codegen", label: "Codegen" },
  { key: "link",    label: "Link"    },
  { key: "execute", label: "Execute" },
];

type Ctx = {
  // Source + compile
  source: string;
  setSource: (next: string) => void;
  result: CompileResult | null;

  // Scene navigation
  scene: SceneKey;
  setScene: (next: SceneKey) => void;

  // CPU state (always non-null after first compile)
  cpu: State | null;
  signals: Signals | null;
  /** Bumped on every CPU mutation so React re-renders. */
  cpuTick: number;
  step: () => void;
  reset: () => void;
  /** Apply a mutation to cpu state, then refresh signals + bump tick. */
  pokeCpu: (fn: (s: State) => void) => void;

  /** True when the user has manually overridden any CPU cell since reset. */
  hasOverrides: boolean;
};

const CompilerContext = createContext<Ctx | null>(null);

export function useCompiler(): Ctx {
  const ctx = useContext(CompilerContext);
  if (!ctx) throw new Error("useCompiler called outside CompilerProvider");
  return ctx;
}

type ProviderProps = {
  initialSource: string;
  children: ReactNode;
};

export function CompilerProvider({ initialSource, children }: ProviderProps) {
  const [source, setSource] = useState(initialSource);
  const [result, setResult] = useState<CompileResult | null>(() => compile(initialSource));
  const [scene, setScene] = useState<SceneKey>("source");

  // Debounced recompile.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setResult(compile(source)), 150);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [source]);

  // CPU state. Re-initialised whenever a fresh ok-compile arrives.
  const cpuRef = useRef<State | null>(null);
  const [cpuTick, setCpuTick] = useState(0);
  const [hasOverrides, setHasOverrides] = useState(false);
  const lastLoadedBits = useRef<string>("");

  useEffect(() => {
    if (!result || !result.ok) return;
    const bits = result.instructions.map(i => i.bits).join(",");
    if (bits === lastLoadedBits.current) return;
    lastLoadedBits.current = bits;
    const s = initState();
    loadProgram(s, result.instructions.map(i => i.bits));
    cpuRef.current = s;
    setHasOverrides(false);
    setCpuTick(t => t + 1);
  }, [result]);

  const signals = useMemo<Signals | null>(() => {
    if (!cpuRef.current) return null;
    return peek(cpuRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cpuTick]);

  const step = useCallback(() => {
    if (!cpuRef.current) return;
    if (cpuRef.current.halted === "1") return;
    tick(cpuRef.current);
    setCpuTick(t => t + 1);
  }, []);

  const reset = useCallback(() => {
    if (!result || !result.ok) return;
    const s = initState();
    loadProgram(s, result.instructions.map(i => i.bits));
    cpuRef.current = s;
    setHasOverrides(false);
    setCpuTick(t => t + 1);
  }, [result]);

  const pokeCpu = useCallback((fn: (s: State) => void) => {
    if (!cpuRef.current) return;
    fn(cpuRef.current);
    setHasOverrides(true);
    setCpuTick(t => t + 1);
  }, []);

  const value: Ctx = {
    source, setSource,
    result,
    scene, setScene,
    cpu: cpuRef.current,
    signals,
    cpuTick,
    step,
    reset,
    pokeCpu,
    hasOverrides,
  };

  return (
    <CompilerContext.Provider value={value}>
      {children}
    </CompilerContext.Provider>
  );
}
