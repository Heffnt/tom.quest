/**
 * THMM page — composes the simulator, datapath, RAM view, editor, and
 * controls, and owns the animation loop.
 *
 * State model:
 *   - The underlying CPU state lives in a useRef because `tick` mutates
 *     the RAM array in place (matching the Python simulator's semantics).
 *     Copying the 256-cell RAM each tick for React diffing would be
 *     wasteful and diverge from the reference implementation.
 *   - We expose a read-only snapshot through useState so render never
 *     accesses the ref directly (React 19 flags that as a hazard). The
 *     snapshot's `ram` is the SAME reference as stateRef.current.ram; we
 *     rely on setSignals + setView driving re-renders, not on ram-array
 *     identity changing.
 *   - The animation loop is a useEffect keyed on `running` + `speed`. It
 *     ticks via setInterval at the chosen Hz, or requestAnimationFrame
 *     when speed = Max. The loop stops itself when halt latches.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Bits,
  type State,
  type Signals,
  initState,
  loadProgram,
  peek,
  tick,
  toUint,
} from "./cpu";
import { FIB_SOURCE } from "./fib";
import Datapath from "./datapath";
import ProgramEditor, { parseProgram } from "./program-editor";
import RamView from "./ram-view";
import Controls, { SPEEDS } from "./controls";

function hex(bits: Bits): string {
  const nibbles = Math.ceil(bits.length / 4);
  return "0x" + toUint(bits).toString(16).padStart(nibbles, "0").toUpperCase();
}

/** Map the 4-bit opcode field back to a mnemonic for the register panel. */
function mnemonic(ir: Bits): string {
  const op = ir.slice(0, 4);
  switch (op) {
    case "0000": return "nop";
    case "0001": return "halt";
    case "0010": return "loadm";
    case "0011": return "loadn";
    case "0100": return "store";
    case "0101": return "goto";
    case "0110": return "gotoa";
    case "0111": return "addm";
    case "1000": return "addn";
    case "1001": return "goif0";
    case "1010": return "subm";
    case "1011": return "mulm";
    case "1100": return "divm";
    default: return "???";
  }
}

function buildInitialState(source: string): State {
  const s = initState();
  const p = parseProgram(source);
  if (p.ok) loadProgram(s, p.program);
  return s;
}

/**
 * Read-only view passed into render. The `ram` field aliases the live
 * ram array; render code reads from it but never writes. Mutation happens
 * on the ref inside tick() and handlers only.
 */
type View = {
  pc: Bits;
  ir: Bits;
  acc: Bits;
  phase: Bits;
  halted: Bits;
  cycle: number;
  ram: Bits[];
};

function snapshot(s: State): View {
  return {
    pc: s.pc,
    ir: s.ir,
    acc: s.acc,
    phase: s.phase,
    halted: s.halted,
    cycle: s.cycle,
    ram: s.ram,
  };
}

export default function ThmmPage() {
  const [source, setSource] = useState(FIB_SOURCE);

  // Build the initial state once (lazy init) so we can seed the ref AND
  // the initial snapshot/signals from the same object without passing a
  // ref value into anything during render.
  const [initial] = useState<State>(() => buildInitialState(FIB_SOURCE));

  // The CPU lives in a ref so tick() can mutate it in place.
  const stateRef = useRef<State>(initial);

  // Snapshot + signals drive re-renders. peek() gives us meaningful wires
  // at reset so the datapath isn't blank before the first tick.
  const [view, setView] = useState<View>(() => snapshot(initial));
  const [signals, setSignals] = useState<Signals>(() => peek(initial));

  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(3); // default 8 Hz — easy to follow visually

  // The actual run state is derived: the user's intent AND not-halted. This
  // lets the loop shut itself down by simply letting halt propagate through
  // `view.halted`, instead of calling setRunning inside the effect (which
  // React 19 flags as a set-state-in-effect hazard).
  const isRunning = running && view.halted !== "1";

  const doTick = useCallback(() => {
    const sig = tick(stateRef.current);
    setSignals(sig);
    setView(snapshot(stateRef.current));
  }, []);

  // Animation loop. Re-runs when isRunning/speed change; cleans up on change
  // or unmount. When halt latches inside a tick, setView triggers a re-render
  // → isRunning flips false → effect cleanup clears the interval.
  useEffect(() => {
    if (!isRunning) return;

    const hz = SPEEDS[speed];
    if (hz === 0) {
      // Max speed — drive with requestAnimationFrame.
      let raf = 0;
      const loop = () => {
        doTick();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(raf);
    }

    const id = window.setInterval(doTick, 1000 / hz);
    return () => window.clearInterval(id);
  }, [isRunning, speed, doTick]);

  const handleStep = useCallback(() => {
    if (stateRef.current.halted === "1") return;
    setRunning(false);
    doTick();
  }, [doTick]);

  const handlePlay = useCallback(() => setRunning(true), []);
  const handlePause = useCallback(() => setRunning(false), []);

  const handleReset = useCallback(() => {
    setRunning(false);
    stateRef.current = buildInitialState(source);
    setSignals(peek(stateRef.current));
    setView(snapshot(stateRef.current));
  }, [source]);

  const handleReload = handleReset; // reloading is just "re-parse + reset"

  return (
    <div className="max-w-[1800px] mx-auto px-4 sm:px-6 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-text">THMM</h1>
        <p className="text-sm text-text-muted mt-1 max-w-3xl">
          Tiny 16-bit Von Neumann CPU, simulated in the browser. Program is one
          16-bit instruction per line; comments after{" "}
          <span className="font-mono">{"//"}</span> are ignored. See{" "}
          <a
            href="https://github.com/heffnt"
            className="text-accent hover:underline"
            target="_blank"
            rel="noopener"
          >
            the THMM repo
          </a>{" "}
          for the architecture spec and the canonical Python simulator.
        </p>
      </div>

      {/* Top row: Editor + Controls (left), Registers (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,360px)_1fr] gap-6 mb-6">
        <div className="flex flex-col gap-4">
          <ProgramEditor
            value={source}
            onChange={setSource}
            onReload={handleReload}
          />
          <div className="border-t border-border pt-4">
            <Controls
              running={isRunning}
              halted={view.halted === "1"}
              cycle={view.cycle}
              speed={speed}
              onStep={handleStep}
              onPlay={handlePlay}
              onPause={handlePause}
              onReset={handleReset}
              onSpeed={setSpeed}
            />
          </div>
        </div>

        {/* Register panel — key/value table */}
        <div>
          <h2 className="text-sm font-semibold text-text mb-2">Registers</h2>
          <div className="grid grid-cols-[auto_1fr_1fr_1fr] gap-x-4 gap-y-1 font-mono text-xs">
            <RegRow label="PC"    bin={view.pc}     hex={hex(view.pc)}    dec={String(toUint(view.pc))} />
            <RegRow
              label="IR"
              bin={view.ir}
              hex={hex(view.ir)}
              dec={`${mnemonic(view.ir)} ${toUint(view.ir.slice(8, 16))}`}
            />
            <RegRow label="Acc"   bin={view.acc}    hex={hex(view.acc)}   dec={String(signed16(view.acc))} />
            <RegRow label="Phase" bin={view.phase}  hex="—"                dec={view.phase === "1" ? "execute" : "fetch"} />
            <RegRow label="Halt"  bin={view.halted} hex="—"                dec={view.halted === "1" ? "HALTED" : "running"} />
            <RegRow label="Cycle" bin="—"            hex="—"                dec={String(view.cycle)} />
          </div>
          {signals.writes.length > 0 && (
            <div className="mt-3 text-xs font-mono text-accent">
              last edge: {signals.writes.map((w) => `${w.target}←${briefValue(w.value)}`).join("  ")}
            </div>
          )}
        </div>
      </div>

      {/* Datapath — the star of the show */}
      <div className="bg-surface border border-border rounded-lg p-3 mb-6 overflow-x-auto">
        <Datapath signals={signals} />
      </div>

      {/* RAM grid */}
      <div className="bg-surface border border-border rounded-lg p-4">
        <RamView ram={view.ram} signals={signals} pc={view.pc} />
      </div>
    </div>
  );
}

function RegRow({
  label,
  bin,
  hex,
  dec,
}: {
  label: string;
  bin: string;
  hex: string;
  dec: string;
}) {
  return (
    <>
      <div className="text-text-muted">{label}</div>
      <div className="text-text-faint">{bin}</div>
      <div className="text-text">{hex}</div>
      <div className="text-accent">{dec}</div>
    </>
  );
}

// Local helpers

function signed16(bits: Bits): number {
  const u = toUint(bits);
  return u & 0x8000 ? u - 0x10000 : u;
}

function briefValue(bits: Bits): string {
  if (bits === "0" || bits === "1") return bits;
  const nibbles = Math.ceil(bits.length / 4);
  return "0x" + toUint(bits).toString(16).padStart(nibbles, "0").toUpperCase();
}
