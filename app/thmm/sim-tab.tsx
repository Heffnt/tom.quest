/**
 * Sim tab — the live datapath + RAM, with everything else (registers,
 * write-edge readout) tucked behind a "more info" disclosure. The program
 * editor is opened from a button on the RAM panel header.
 *
 * State model is unchanged from the original page: CPU lives in a ref so
 * tick() can mutate in place, and a snapshot drives renders.
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
import Datapath from "./datapath";
import ProgramEditor, { parseProgram } from "./program-editor";
import RamView from "./ram-view";
import Controls, { SPEEDS } from "./controls";

function hex(bits: Bits): string {
  const nibbles = Math.ceil(bits.length / 4);
  return "0x" + toUint(bits).toString(16).padStart(nibbles, "0").toUpperCase();
}

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
    pc: s.pc, ir: s.ir, acc: s.acc, phase: s.phase, halted: s.halted,
    cycle: s.cycle, ram: s.ram,
  };
}

type Props = {
  source: string;
  onSourceChange: (s: string) => void;
  /** Bumped by the parent when an external change loads new bits (e.g.
   * "Load to RAM" from the Compile tab). Drives a forced reset. */
  loadNonce: number;
};

export default function SimTab({ source, onSourceChange, loadNonce }: Props) {
  const [initial] = useState<State>(() => buildInitialState(source));
  const stateRef = useRef<State>(initial);
  const [view, setView] = useState<View>(() => snapshot(initial));
  const [signals, setSignals] = useState<Signals>(() => peek(initial));

  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(3);
  const [editing, setEditing] = useState(false);
  const [showMore, setShowMore] = useState(false);

  // The actual run state derived from intent + halt latch — same trick as
  // the original page, lets the loop self-stop on halt without setState
  // inside an effect.
  const isRunning = running && view.halted !== "1";

  const doTick = useCallback(() => {
    const sig = tick(stateRef.current);
    setSignals(sig);
    setView(snapshot(stateRef.current));
  }, []);

  useEffect(() => {
    if (!isRunning) return;
    const hz = SPEEDS[speed];
    if (hz === 0) {
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

  const reload = useCallback((src: string) => {
    setRunning(false);
    stateRef.current = buildInitialState(src);
    setSignals(peek(stateRef.current));
    setView(snapshot(stateRef.current));
  }, []);

  // External loads (from the Compile tab) bump loadNonce; reset on each.
  useEffect(() => {
    reload(source);
    setEditing(false);
    // We intentionally only track loadNonce — `source` may be stable when
    // the user is just navigating tabs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadNonce]);

  const handleStep = useCallback(() => {
    if (stateRef.current.halted === "1") return;
    setRunning(false);
    doTick();
  }, [doTick]);

  const handlePlay = useCallback(() => setRunning(true), []);
  const handlePause = useCallback(() => setRunning(false), []);
  const handleReset = useCallback(() => reload(source), [reload, source]);

  const handleEditDone = useCallback(
    (newSrc: string) => {
      onSourceChange(newSrc);
      reload(newSrc);
      setEditing(false);
    },
    [onSourceChange, reload],
  );

  return (
    <div className="space-y-6">
      {/* Controls strip — sits above the datapath as a single horizontal bar */}
      <div className="animate-settle">
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

      {/* Datapath — the hero */}
      <div className="bg-surface border border-border rounded-lg p-3 overflow-x-auto animate-settle-delay-1">
        <Datapath signals={signals} />
      </div>

      {/* RAM panel OR program editor (mutex) */}
      <div className="bg-surface border border-border rounded-lg p-4 animate-settle-delay-2">
        {editing ? (
          <ProgramEditorPanel
            value={source}
            onSave={handleEditDone}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div>
            <div className="flex items-baseline justify-between mb-3">
              <SectionLabel>RAM</SectionLabel>
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-text-muted font-mono">
                  256 × 16b — hex
                </span>
                <button
                  onClick={() => setEditing(true)}
                  className="px-2 py-1 text-[10px] font-mono uppercase tracking-[0.15em]
                             border border-border rounded
                             text-text-muted hover:text-accent hover:border-accent/60
                             transition-colors"
                >
                  edit program
                </button>
              </div>
            </div>
            <RamViewBare ram={view.ram} signals={signals} pc={view.pc} />
          </div>
        )}
      </div>

      {/* More info — registers + write-edge readout, collapsed by default */}
      <div className="animate-settle-delay-3">
        <button
          onClick={() => setShowMore((v) => !v)}
          className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em]
                     font-display text-text-muted hover:text-text transition-colors"
        >
          <span
            className="inline-block transition-transform"
            style={{ transform: showMore ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            ▸
          </span>
          {showMore ? "less" : "more"} info
        </button>

        {showMore && (
          <div className="mt-4 border-t border-border pt-4">
            <SectionLabel>Registers</SectionLabel>
            <div className="mt-2 grid grid-cols-[auto_1fr_1fr_1fr] gap-x-4 gap-y-1 font-mono text-xs">
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
        )}
      </div>
    </div>
  );
}

// =========================================================================
// Subcomponents
// =========================================================================

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[10px] uppercase tracking-[0.25em] font-display text-text-muted">
      {children}
    </h2>
  );
}

/**
 * The same RamView grid as before but without its own header — the parent
 * now owns the header (with the edit button). Inlining the body lets us
 * avoid a tiny prop drill for "hide your title".
 */
function RamViewBare({ ram, signals, pc }: { ram: Bits[]; signals: Signals; pc: Bits }) {
  return <RamView ram={ram} signals={signals} pc={pc} headless />;
}

function ProgramEditorPanel({
  value,
  onSave,
  onCancel,
}: {
  value: string;
  onSave: (src: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const parse = parseProgram(draft);
  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <SectionLabel>Edit program</SectionLabel>
        <span className="text-[10px] text-text-muted font-mono">
          {parse.ok ? `${parse.program.length} words` : "error"}
        </span>
      </div>
      <ProgramEditor value={draft} onChange={setDraft} onReload={() => onSave(draft)} headless />
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-3 py-1 text-xs font-mono rounded border border-border
                     text-text-muted hover:text-text hover:border-accent/60 transition-colors"
        >
          cancel
        </button>
        <button
          onClick={() => onSave(draft)}
          disabled={!parse.ok}
          className="px-3 py-1 text-xs font-mono rounded border
                     border-accent/60 text-accent hover:border-accent
                     disabled:opacity-40 disabled:hover:border-accent/60
                     transition-colors"
        >
          load to ram
        </button>
      </div>
    </div>
  );
}

function RegRow({
  label, bin, hex, dec,
}: { label: string; bin: string; hex: string; dec: string }) {
  return (
    <>
      <div className="text-text-muted">{label}</div>
      <div className="text-text-faint">{bin}</div>
      <div className="text-text">{hex}</div>
      <div className="text-accent">{dec}</div>
    </>
  );
}

function signed16(bits: Bits): number {
  const u = toUint(bits);
  return u & 0x8000 ? u - 0x10000 : u;
}

function briefValue(bits: Bits): string {
  if (bits === "0" || bits === "1") return bits;
  const nibbles = Math.ceil(bits.length / 4);
  return "0x" + toUint(bits).toString(16).padStart(nibbles, "0").toUpperCase();
}
