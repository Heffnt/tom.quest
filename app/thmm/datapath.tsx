/**
 * Live datapath visualizer — a React SVG that mirrors the canonical THMM
 * datapath (THMM/docs/datapath.svg) and data-binds every wire's value to
 * the current simulation Signals. Structural duplication of the static SVG
 * is accepted; when the architecture changes, both must be updated.
 *
 * Styling deviates from the static SVG to fit tom.quest's dark theme —
 * transparent component fills with colored borders per component type,
 * amber for active/non-zero signals, dim text-muted for idle wires.
 *
 * The geometry (positions, wire paths) is copied verbatim from the static
 * SVG so the two lay out the same. The viewBox is 1650 × 1050.
 */
"use client";

import type { Signals, Bits } from "./cpu";
import { toUint } from "./cpu";

// ==========================================================================
// Formatting helpers
// ==========================================================================

function hex(bits: Bits): string {
  const nibbles = Math.ceil(bits.length / 4);
  return "0x" + toUint(bits).toString(16).padStart(nibbles, "0").toUpperCase();
}

// ==========================================================================
// Theme
// ==========================================================================

const C = {
  // Component fills (very dark, slightly translucent over the page bg)
  boxFill: "#0f1622",
  // Component borders, per component type
  regBorder: "#6ea0d0",
  cntBorder: "#5088c8",
  memBorder: "#5eb87a",
  muxBorder: "#d89030",
  aluBorder: "#d06060",
  decBorder: "#9570d0",
  lchBorder: "#808080",
  zdBorder: "#c070c0",
  // Text
  title: "#e2e8f0",
  sub: "#94a3b8",
  pin: "#64748b",
  // Wires
  wireIdle: "#475569",
  wireActive: "#e8a040",
  ctlIdle: "#7a3b3b",
  ctlActive: "#ef4444",
  dataDecIdle: "#2e7d7a",
  dataDecActive: "#38b2ac",
};

// Threshold: a wire is "active" when its 1-bit enable is '1'. Data wires are
// always shown; we highlight them in amber if a write this cycle involves them.
function activeStroke(on: boolean): string {
  return on ? C.wireActive : C.wireIdle;
}
function ctlStroke(on: boolean): string {
  return on ? C.ctlActive : C.ctlIdle;
}
function decDataStroke(on: boolean): string {
  return on ? C.dataDecActive : C.dataDecIdle;
}

// ==========================================================================
// The Datapath component
// ==========================================================================

type Props = {
  signals: Signals;
};

export default function Datapath({ signals: s }: Props) {
  // Derive per-wire "active" booleans. A data wire is considered active if
  // the downstream consumer will use it this cycle.
  const activePhase = s.phase1 === "1";
  const ramReadUsedByIR = s.irWe1 === "1";     // phase 0: Dout drives IR
  const ramReadUsedByALU = activePhase && s.aluMux1 === "1"; // phase 1, RAM into ALU
  const ramDoutActive = ramReadUsedByIR || ramReadUsedByALU;
  const ramDataUsedByAddr = activePhase;       // phase 1: Addr Mux takes Ram Data
  const aluDataUsedByALU = activePhase && s.aluMux1 === "0";
  const aluWrites = s.accWe1 === "1";
  const pcJumps = s.progWe1 === "1";
  const ramWrites = s.ramWe1 === "1";
  const halts = s.halt1 === "1" && activePhase;

  return (
    <svg
      viewBox="0 0 1650 1050"
      className="w-full h-auto"
      fontFamily="var(--font-ibm-plex-mono), IBM Plex Mono, Consolas, monospace"
    >
      <defs>
        <marker
          id="arr"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill={C.wireIdle} />
        </marker>
        <marker
          id="arrActive"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill={C.wireActive} />
        </marker>
        <marker
          id="arrCtl"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill={C.ctlIdle} />
        </marker>
        <marker
          id="arrCtlActive"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill={C.ctlActive} />
        </marker>
        <marker
          id="arrDec"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill={C.dataDecIdle} />
        </marker>
        <marker
          id="arrDecActive"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill={C.dataDecActive} />
        </marker>
      </defs>

      {/* ================================================================
          LEFT COLUMN: PC Counter, ProgMux, Phase, Halt, Clock
          ================================================================ */}

      {/* PC Counter */}
      <rect x={40} y={120} width={200} height={105} fill={C.boxFill} stroke={C.cntBorder} strokeWidth={2} />
      <text x={140} y={144} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>PC (Counter, 8b)</text>
      <text x={140} y={162} textAnchor="middle" fontSize={11} fill={C.sub}>CT = !Phase</text>
      <text x={140} y={178} textAnchor="middle" fontSize={11} fill={C.sub}>LD = ProgWE · Phase</text>
      <text x={140} y={194} textAnchor="middle" fontSize={11} fill={C.sub}>D = ProgMux out</text>
      <text x={140} y={214} textAnchor="middle" fontSize={13} fontWeight="bold" fill={C.wireActive}>Q = {hex(s.pc8)}</text>

      {/* ProgMux */}
      <rect x={40} y={260} width={200} height={80} fill={C.boxFill} stroke={C.muxBorder} strokeWidth={2} />
      <text x={140} y={282} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>ProgMux</text>
      <text x={140} y={302} textAnchor="middle" fontSize={11} fill={s.progMux1 === "0" ? C.wireActive : C.sub}>0: Acc[7:0]</text>
      <text x={140} y={320} textAnchor="middle" fontSize={11} fill={s.progMux1 === "1" ? C.wireActive : C.sub}>1: ALU[7:0]</text>
      <text x={52} y={282} fontSize={10} fill={C.pin}>0</text>
      <text x={52} y={332} fontSize={10} fill={C.pin}>1</text>

      {/* Phase */}
      <rect x={40} y={380} width={200} height={65} fill={C.boxFill} stroke={C.lchBorder} strokeWidth={2} />
      <text x={140} y={402} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>Phase</text>
      <text x={140} y={420} textAnchor="middle" fontSize={11} fill={C.sub}>{activePhase ? "1 (execute)" : "0 (fetch)"}</text>
      <text x={140} y={438} textAnchor="middle" fontSize={13} fontWeight="bold" fill={C.wireActive}>= {s.phase1}</text>

      {/* Halt latch */}
      <rect x={40} y={475} width={200} height={60} fill={C.boxFill} stroke={halts || s.halted1 === "1" ? C.wireActive : C.lchBorder} strokeWidth={2} />
      <text x={140} y={497} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>Halt Latch</text>
      <text x={140} y={513} textAnchor="middle" fontSize={11} fill={C.sub}>set by decoder Halt</text>
      <text x={140} y={530} textAnchor="middle" fontSize={13} fontWeight="bold" fill={s.halted1 === "1" ? C.ctlActive : C.wireIdle}>= {s.halted1}</text>

      {/* Clock */}
      <rect x={40} y={565} width={200} height={58} fill={C.boxFill} stroke={C.lchBorder} strokeWidth={2} />
      <text x={140} y={587} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>Clock</text>
      <text x={140} y={605} textAnchor="middle" fontSize={11} fill={C.sub}>CLK · !Halt</text>
      <text x={140} y={620} textAnchor="middle" fontSize={11} fill={s.halted1 === "1" ? C.ctlActive : C.sub}>drives all registers</text>

      {/* ================================================================
          CENTER COLUMN: Addr Mux, RAM, IR
          ================================================================ */}

      {/* Addr Mux */}
      <rect x={360} y={130} width={160} height={120} fill={C.boxFill} stroke={C.muxBorder} strokeWidth={2} />
      <text x={440} y={156} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>Addr Mux</text>
      <text x={440} y={176} textAnchor="middle" fontSize={11} fill={s.phase1 === "0" ? C.wireActive : C.sub}>0: PC</text>
      <text x={440} y={196} textAnchor="middle" fontSize={11} fill={s.phase1 === "1" ? C.wireActive : C.sub}>1: Ram Data</text>
      <text x={440} y={226} textAnchor="middle" fontSize={11} fontWeight="bold" fill={C.ctlIdle}>sel = Phase</text>
      <text x={372} y={178} fontSize={10} fill={C.pin}>0</text>
      <text x={372} y={218} fontSize={10} fill={C.pin}>1</text>

      {/* RAM */}
      <rect x={610} y={120} width={320} height={260} fill={C.boxFill} stroke={ramWrites ? C.wireActive : C.memBorder} strokeWidth={2} />
      <text x={770} y={148} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>RAM</text>
      <text x={770} y={168} textAnchor="middle" fontSize={11} fill={C.sub}>256 × 16b (single-port)</text>
      <text x={770} y={188} textAnchor="middle" fontSize={11} fill={C.sub}>unified code + data</text>
      <text x={770} y={228} textAnchor="middle" fontSize={11} fill={C.sub}>addr = {hex(s.addr8)}</text>
      <text x={770} y={248} textAnchor="middle" fontSize={11} fill={C.sub}>Dout = {hex(s.ramDout16)}</text>
      {ramWrites && (
        <text x={770} y={268} textAnchor="middle" fontSize={11} fontWeight="bold" fill={C.wireActive}>WRITE RAM[{hex(s.ramData8)}] ← {hex(s.acc16)}</text>
      )}
      <text x={625} y={298} fontSize={10} fill={C.pin}>addr</text>
      <text x={625} y={318} fontSize={10} fill={C.pin}>Din</text>
      <text x={625} y={342} fontSize={10} fill={C.pin}>WE</text>
      <text x={915} y={298} fontSize={10} fill={C.pin} textAnchor="end">Dout</text>
      <text x={915} y={370} fontSize={10} fill={C.pin} textAnchor="end">clk</text>

      {/* IR */}
      <rect x={610} y={430} width={320} height={90} fill={C.boxFill} stroke={C.regBorder} strokeWidth={2} />
      <text x={770} y={454} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>IR (Instruction Register, 16b)</text>
      <text x={770} y={476} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.wireActive}>{hex(s.ir16)}</text>
      <text x={770} y={493} textAnchor="middle" fontSize={10} fill={C.sub}>WE = !Phase</text>
      <line x1={690} y1={500} x2={690} y2={520} stroke={C.pin} />
      <line x1={770} y1={500} x2={770} y2={520} stroke={C.pin} />
      <text x={650} y={514} textAnchor="middle" fontSize={10} fill={C.pin}>op {s.ir16.slice(0, 4)}</text>
      <text x={730} y={514} textAnchor="middle" fontSize={10} fill={C.pin}>{s.ir16.slice(4, 8)}</text>
      <text x={850} y={514} textAnchor="middle" fontSize={10} fill={C.pin}>n {s.ir16.slice(8, 16)}</text>

      {/* ================================================================
          RIGHT CENTER: Decoder
          ================================================================ */}

      <rect x={1000} y={430} width={290} height={430} fill={C.boxFill} stroke={C.decBorder} strokeWidth={2} />
      <text x={1145} y={456} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>Decoder</text>
      <text x={1145} y={476} textAnchor="middle" fontSize={10} fill={C.sub}>(combinational)</text>

      <text x={1015} y={500} fontSize={11} fill={C.sub}>INPUTS</text>
      <text x={1030} y={518} fontSize={11} fill={C.title}>IR = {hex(s.ir16)}</text>
      <text x={1030} y={534} fontSize={11} fill={C.title}>acc_zero = {s.accZero1}</text>

      <text x={1015} y={562} fontSize={11} fill={C.sub}>CONTROL OUT</text>
      <text x={1030} y={580} fontSize={11} fill={s.progWeRaw1 === "1" ? C.ctlActive : C.ctlIdle}>Prog WE = {s.progWeRaw1}</text>
      <text x={1030} y={596} fontSize={11} fill={s.progMux1 === "1" ? C.ctlActive : C.ctlIdle}>Prog Mux = {s.progMux1}</text>
      <text x={1030} y={612} fontSize={11} fill={s.ramWeRaw1 === "1" ? C.ctlActive : C.ctlIdle}>Ram WE = {s.ramWeRaw1}</text>
      <text x={1030} y={628} fontSize={11} fill={s.aluMux1 === "1" ? C.ctlActive : C.ctlIdle}>Alu Mux = {s.aluMux1}</text>
      <text x={1030} y={644} fontSize={11} fill={s.aluOp3 !== "000" ? C.ctlActive : C.ctlIdle}>Alu Op = {s.aluOp3}</text>
      <text x={1030} y={660} fontSize={11} fill={s.accWeRaw1 === "1" ? C.ctlActive : C.ctlIdle}>Acc WE = {s.accWeRaw1}</text>
      <text x={1030} y={676} fontSize={11} fill={s.halt1 === "1" ? C.ctlActive : C.ctlIdle}>Halt = {s.halt1}</text>

      <text x={1015} y={708} fontSize={11} fill={C.sub}>DATA OUT</text>
      <text x={1030} y={728} fontSize={11} fill={ramDataUsedByAddr ? C.dataDecActive : C.dataDecIdle}>Ram Data = {hex(s.ramData8)}</text>
      <text x={1030} y={746} fontSize={11} fill={aluDataUsedByALU ? C.dataDecActive : C.dataDecIdle}>Alu Data = {hex(s.aluData16)}</text>

      <text x={1015} y={780} fontSize={10} fill={C.sub}>WEs ANDed externally</text>
      <text x={1015} y={794} fontSize={10} fill={C.sub}>with Phase before reaching</text>
      <text x={1015} y={808} fontSize={10} fill={C.sub}>register enables.</text>
      <text x={1015} y={836} fontSize={10} fill={C.sub}>goif0: Prog WE is ANDed</text>
      <text x={1015} y={850} fontSize={10} fill={C.sub}>with acc_zero inside.</text>

      {/* ================================================================
          RIGHT: ALU B Mux, ALU, Acc, Zero Detect
          ================================================================ */}

      {/* ALU B Mux */}
      <rect x={1360} y={120} width={200} height={110} fill={C.boxFill} stroke={C.muxBorder} strokeWidth={2} />
      <text x={1460} y={148} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>ALU B Mux</text>
      <text x={1460} y={170} textAnchor="middle" fontSize={11} fill={s.aluMux1 === "0" ? C.wireActive : C.sub}>0: Alu Data</text>
      <text x={1460} y={190} textAnchor="middle" fontSize={11} fill={s.aluMux1 === "1" ? C.wireActive : C.sub}>1: RAM Dout</text>
      <text x={1460} y={216} textAnchor="middle" fontSize={11} fontWeight="bold" fill={C.ctlIdle}>sel = Alu Mux</text>

      {/* ALU */}
      <rect x={1360} y={260} width={260} height={140} fill={C.boxFill} stroke={C.aluBorder} strokeWidth={2} />
      <text x={1490} y={288} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>ALU</text>
      <text x={1490} y={308} textAnchor="middle" fontSize={11} fill={C.sub}>16b two&apos;s complement</text>
      <text x={1490} y={326} textAnchor="middle" fontSize={11} fill={C.sub}>Pass / Add / Sub / Mul / Div</text>
      <text x={1490} y={352} textAnchor="middle" fontSize={11} fontWeight="bold" fill={C.title}>op = {s.aluOp3}</text>
      <text x={1490} y={372} textAnchor="middle" fontSize={11} fontWeight="bold" fill={C.wireActive}>out = {hex(s.aluOut16)}</text>
      <text x={1374} y={290} fontSize={10} fill={C.pin}>A</text>
      <text x={1374} y={336} fontSize={10} fill={C.pin}>B</text>

      {/* Acc */}
      <rect x={1360} y={700} width={260} height={80} fill={C.boxFill} stroke={aluWrites ? C.wireActive : C.regBorder} strokeWidth={2} />
      <text x={1490} y={724} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>Acc (16b)</text>
      <text x={1490} y={746} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.wireActive}>{hex(s.acc16)}</text>
      <text x={1490} y={764} textAnchor="middle" fontSize={10} fill={C.sub}>WE = Acc WE · Phase</text>
      {aluWrites && (
        <text x={1490} y={778} textAnchor="middle" fontSize={10} fontWeight="bold" fill={C.wireActive}>WRITE ← {hex(s.aluOut16)}</text>
      )}

      {/* Zero Detect */}
      <rect x={1360} y={810} width={260} height={55} fill={C.boxFill} stroke={C.zdBorder} strokeWidth={2} />
      <text x={1490} y={834} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>Zero Detect</text>
      <text x={1490} y={854} textAnchor="middle" fontSize={11} fill={s.accZero1 === "1" ? C.wireActive : C.sub}>acc_zero = {s.accZero1}</text>

      {/* ================================================================
          WIRES — data / address
          ================================================================ */}

      {/* PC.Q -> Addr Mux [0] */}
      <path d="M 240 180 L 360 180" fill="none" stroke={activePhase ? C.wireIdle : C.wireActive} strokeWidth={2} markerEnd={activePhase ? "url(#arr)" : "url(#arrActive)"} />

      {/* ProgMux out -> PC Counter D */}
      <path d="M 240 300 L 290 300 L 290 210 L 240 210" fill="none" stroke={activeStroke(pcJumps)} strokeWidth={2} markerEnd={pcJumps ? "url(#arrActive)" : "url(#arr)"} />

      {/* Addr Mux out -> RAM addr */}
      <path d="M 520 190 L 575 190 L 575 265 L 610 265" fill="none" stroke={C.wireActive} strokeWidth={2} markerEnd="url(#arrActive)" />

      {/* Acc -> RAM Din */}
      <path d="M 1360 735 L 960 735 L 960 540 L 560 540 L 560 310 L 610 310" fill="none" stroke={activeStroke(ramWrites)} strokeWidth={2} markerEnd={ramWrites ? "url(#arrActive)" : "url(#arr)"} />

      {/* RAM Dout -> IR */}
      <path d="M 930 265 L 970 265 L 970 410 L 770 410 L 770 430" fill="none" stroke={activeStroke(ramReadUsedByIR)} strokeWidth={2} markerEnd={ramReadUsedByIR ? "url(#arrActive)" : "url(#arr)"} />

      {/* RAM Dout -> ALU B Mux [1] (tap) */}
      <circle cx={970} cy={265} r={3} fill={ramDoutActive ? C.wireActive : C.wireIdle} />
      <path d="M 970 265 L 970 200 L 1360 200" fill="none" stroke={activeStroke(ramReadUsedByALU)} strokeWidth={2} markerEnd={ramReadUsedByALU ? "url(#arrActive)" : "url(#arr)"} />

      {/* IR -> Decoder */}
      <path d="M 930 520 L 1000 520" fill="none" stroke={C.wireActive} strokeWidth={2} markerEnd="url(#arrActive)" />

      {/* Decoder Ram Data -> Addr Mux [1] */}
      <path d="M 1000 728 L 330 728 L 330 210 L 360 210" fill="none" stroke={decDataStroke(ramDataUsedByAddr)} strokeWidth={2} markerEnd={ramDataUsedByAddr ? "url(#arrDecActive)" : "url(#arrDec)"} />

      {/* Decoder Alu Data -> ALU B Mux [0] */}
      <path d="M 1290 746 L 1310 746 L 1310 160 L 1360 160" fill="none" stroke={decDataStroke(aluDataUsedByALU)} strokeWidth={2} markerEnd={aluDataUsedByALU ? "url(#arrDecActive)" : "url(#arrDec)"} />

      {/* ALU B Mux -> ALU B */}
      <path d="M 1460 230 L 1460 260" fill="none" stroke={C.wireActive} strokeWidth={2} markerEnd="url(#arrActive)" />

      {/* Acc -> ALU A */}
      <path d="M 1380 700 L 1380 272 L 1380 260" fill="none" stroke={C.wireActive} strokeWidth={2} markerEnd="url(#arrActive)" />

      {/* ALU out -> Acc */}
      <path d="M 1490 400 L 1490 700" fill="none" stroke={activeStroke(aluWrites)} strokeWidth={2} markerEnd={aluWrites ? "url(#arrActive)" : "url(#arr)"} />

      {/* ALU out low 8b -> ProgMux [1] */}
      <circle cx={1490} cy={420} r={3} fill={pcJumps && s.progMux1 === "1" ? C.wireActive : C.wireIdle} />
      <path d="M 1490 420 L 1330 420 L 1330 480 L 310 480 L 310 320 L 240 320" fill="none" stroke={activeStroke(pcJumps && s.progMux1 === "1")} strokeWidth={2} markerEnd={pcJumps && s.progMux1 === "1" ? "url(#arrActive)" : "url(#arr)"} />

      {/* Acc low 8b -> ProgMux [0] */}
      <circle cx={1380} cy={700} r={3} fill={pcJumps && s.progMux1 === "0" ? C.wireActive : C.wireIdle} />
      <path d="M 1380 700 L 1380 668 L 290 668 L 290 280 L 240 280" fill="none" stroke={activeStroke(pcJumps && s.progMux1 === "0")} strokeWidth={2} markerEnd={pcJumps && s.progMux1 === "0" ? "url(#arrActive)" : "url(#arr)"} />

      {/* Acc -> Zero Detect */}
      <path d="M 1490 780 L 1490 810" fill="none" stroke={C.wireIdle} strokeWidth={2} markerEnd="url(#arr)" />

      {/* Zero Detect acc_zero -> Decoder input */}
      <path d="M 1360 835 L 1340 835 L 1340 880 L 970 880 L 970 536 L 1000 536" fill="none" stroke={activeStroke(s.accZero1 === "1")} strokeWidth={2} markerEnd={s.accZero1 === "1" ? "url(#arrActive)" : "url(#arr)"} />

      {/* ================================================================
          CONTROL SIGNALS (red dashed)
          ================================================================ */}

      {/* Prog WE -> PC Counter LD */}
      <path d="M 1000 580 Q 270 580 270 155 L 240 155" fill="none" stroke={ctlStroke(s.progWeRaw1 === "1")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={s.progWeRaw1 === "1" ? "url(#arrCtlActive)" : "url(#arrCtl)"} />

      {/* Prog Mux sel */}
      <path d="M 1000 596 Q 260 596 260 300 L 240 300" fill="none" stroke={ctlStroke(s.progMux1 === "1")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={s.progMux1 === "1" ? "url(#arrCtlActive)" : "url(#arrCtl)"} />

      {/* Ram WE -> RAM WE */}
      <path d="M 1000 612 Q 760 612 760 640 L 760 340" fill="none" stroke={ctlStroke(s.ramWeRaw1 === "1")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={s.ramWeRaw1 === "1" ? "url(#arrCtlActive)" : "url(#arrCtl)"} />

      {/* Alu Mux sel */}
      <path d="M 1290 628 L 1320 628 L 1320 228 L 1340 228" fill="none" stroke={ctlStroke(s.aluMux1 === "1")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={s.aluMux1 === "1" ? "url(#arrCtlActive)" : "url(#arrCtl)"} />

      {/* Alu Opcode */}
      <path d="M 1290 644 L 1490 644 L 1490 400" fill="none" stroke={ctlStroke(s.aluOp3 !== "000")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={s.aluOp3 !== "000" ? "url(#arrCtlActive)" : "url(#arrCtl)"} />

      {/* Acc WE */}
      <path d="M 1290 660 L 1630 660 L 1630 735 L 1620 735" fill="none" stroke={ctlStroke(s.accWeRaw1 === "1")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={s.accWeRaw1 === "1" ? "url(#arrCtlActive)" : "url(#arrCtl)"} />

      {/* Halt -> Halt latch */}
      <path d="M 1000 676 Q 500 676 280 500 L 240 500" fill="none" stroke={ctlStroke(s.halt1 === "1")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={s.halt1 === "1" ? "url(#arrCtlActive)" : "url(#arrCtl)"} />

      {/* Phase -> Addr Mux sel */}
      <path d="M 240 400 L 320 400 L 320 250 L 440 250" fill="none" stroke={ctlStroke(activePhase)} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={activePhase ? "url(#arrCtlActive)" : "url(#arrCtl)"} />

      {/* !Phase -> IR WE */}
      <path d="M 240 412 L 340 412 L 340 500 L 610 500" fill="none" stroke={ctlStroke(s.irWe1 === "1")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={s.irWe1 === "1" ? "url(#arrCtlActive)" : "url(#arrCtl)"} />

      {/* Halt latch -> Clock gate */}
      <path d="M 140 535 L 140 565" fill="none" stroke={ctlStroke(s.halted1 === "1")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={s.halted1 === "1" ? "url(#arrCtlActive)" : "url(#arrCtl)"} />
    </svg>
  );
}
