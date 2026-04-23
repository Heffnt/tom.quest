/**
 * Live datapath visualizer — a React SVG that mirrors the canonical THMM
 * datapath (THMM/docs/datapath.svg) and data-binds every wire's value to
 * the current simulation Signals. Structural duplication of the static SVG
 * is accepted; when the architecture changes, both must be updated.
 *
 * Layout:
 *   - Top row:   Clock, Phase, Halt Latch
 *   - Far left:  Decoder (tall)
 *   - Far right: RAM (large); IR directly above its top-left
 *   - Middle:    PC, ProgMux (upper-left), Addr Mux (top-center),
 *                ALU B Mux / ALU / Acc / Zero Detect (stacked center-bottom)
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
  boxFill: "#0f1622",
  regBorder: "#6ea0d0",
  cntBorder: "#5088c8",
  memBorder: "#5eb87a",
  muxBorder: "#d89030",
  aluBorder: "#d06060",
  decBorder: "#9570d0",
  lchBorder: "#808080",
  zdBorder: "#c070c0",
  title: "#e2e8f0",
  sub: "#94a3b8",
  pin: "#64748b",
  wireIdle: "#475569",
  wireActive: "#e8a040",
  ctlIdle: "#7a3b3b",
  ctlActive: "#ef4444",
  dataDecIdle: "#2e7d7a",
  dataDecActive: "#38b2ac",
};

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
// Component
// ==========================================================================

type Props = {
  signals: Signals;
};

export default function Datapath({ signals: s }: Props) {
  // Activity derivations: a data wire is "active" when its downstream
  // consumer will actually use it this cycle.
  const activePhase = s.phase1 === "1";
  const ramReadUsedByIR = s.irWe1 === "1";          // fetch: Dout drives IR
  const ramReadUsedByALU = activePhase && s.aluMux1 === "1";
  const ramDoutActive = ramReadUsedByIR || ramReadUsedByALU;
  const ramDataUsedByAddr = activePhase;             // execute: Addr Mux picks Ram Data
  const aluDataUsedByALU = activePhase && s.aluMux1 === "0";
  const aluWrites = s.accWe1 === "1";
  const pcJumps = s.progWe1 === "1";
  const ramWrites = s.ramWe1 === "1";
  const halts = s.halt1 === "1" && activePhase;

  const m = (on: boolean, kind: "data" | "ctl" | "dec") =>
    on
      ? kind === "data" ? "url(#arrActive)" : kind === "ctl" ? "url(#arrCtlActive)" : "url(#arrDecActive)"
      : kind === "data" ? "url(#arr)" : kind === "ctl" ? "url(#arrCtl)" : "url(#arrDec)";

  return (
    <svg
      viewBox="0 0 1700 950"
      className="w-full h-auto"
      fontFamily="var(--font-ibm-plex-mono), IBM Plex Mono, Consolas, monospace"
    >
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill={C.wireIdle} />
        </marker>
        <marker id="arrActive" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill={C.wireActive} />
        </marker>
        <marker id="arrCtl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill={C.ctlIdle} />
        </marker>
        <marker id="arrCtlActive" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill={C.ctlActive} />
        </marker>
        <marker id="arrDec" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill={C.dataDecIdle} />
        </marker>
        <marker id="arrDecActive" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill={C.dataDecActive} />
        </marker>
      </defs>

      {/* ============================================================
          TOP ROW — Clock, Phase, Halt Latch
          ============================================================ */}
      <rect x={40} y={50} width={180} height={60} fill={C.boxFill} stroke={C.lchBorder} strokeWidth={2} />
      <text x={130} y={72} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>Clock</text>
      <text x={130} y={90} textAnchor="middle" fontSize={11} fill={C.sub}>CLK · !Halt</text>
      <text x={130} y={104} textAnchor="middle" fontSize={11} fill={s.halted1 === "1" ? C.ctlActive : C.sub}>
        {s.halted1 === "1" ? "gated off (halted)" : "running"}
      </text>

      <rect x={240} y={50} width={180} height={60} fill={C.boxFill} stroke={C.lchBorder} strokeWidth={2} />
      <text x={330} y={72} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>Phase</text>
      <text x={330} y={90} textAnchor="middle" fontSize={11} fill={C.sub}>{activePhase ? "1 (execute)" : "0 (fetch)"}</text>
      <text x={330} y={104} textAnchor="middle" fontSize={12} fontWeight="bold" fill={C.wireActive}>= {s.phase1}</text>

      <rect x={440} y={50} width={180} height={60} fill={C.boxFill} stroke={halts || s.halted1 === "1" ? C.wireActive : C.lchBorder} strokeWidth={2} />
      <text x={530} y={72} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>Halt Latch</text>
      <text x={530} y={90} textAnchor="middle" fontSize={11} fill={C.sub}>set by decoder Halt</text>
      <text x={530} y={104} textAnchor="middle" fontSize={12} fontWeight="bold" fill={s.halted1 === "1" ? C.ctlActive : C.wireIdle}>= {s.halted1}</text>

      {/* Halt → Clock gate, routed above the row */}
      <path d="M 620 60 L 620 38 L 220 38 L 220 60" fill="none" stroke={ctlStroke(s.halted1 === "1")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={m(s.halted1 === "1", "ctl")} />
      <text x={380} y={32} textAnchor="middle" fontSize={11} fontWeight="bold" fill={C.ctlIdle}>Halt → Clock gate</text>

      {/* ============================================================
          DECODER — far left, tall
          ============================================================ */}
      <rect x={40} y={170} width={240} height={640} fill={C.boxFill} stroke={C.decBorder} strokeWidth={2} />
      <text x={160} y={196} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>Decoder</text>
      <text x={160} y={212} textAnchor="middle" fontSize={10} fill={C.sub}>(combinational)</text>

      <text x={55} y={240} fontSize={11} fill={C.sub}>INPUTS</text>
      <text x={70} y={258} fontSize={11} fill={C.title}>IR = {hex(s.ir16)}</text>
      <text x={70} y={274} fontSize={11} fill={C.title}>acc_zero = {s.accZero1}</text>

      <text x={55} y={308} fontSize={11} fill={C.sub}>CONTROL OUT</text>
      <text x={70} y={326} fontSize={11} fill={s.progWeRaw1 === "1" ? C.ctlActive : C.ctlIdle}>Prog WE = {s.progWeRaw1}</text>
      <text x={70} y={342} fontSize={11} fill={s.progMux1 === "1" ? C.ctlActive : C.ctlIdle}>Prog Mux = {s.progMux1}</text>
      <text x={70} y={358} fontSize={11} fill={s.ramWeRaw1 === "1" ? C.ctlActive : C.ctlIdle}>Ram WE = {s.ramWeRaw1}</text>
      <text x={70} y={374} fontSize={11} fill={s.aluMux1 === "1" ? C.ctlActive : C.ctlIdle}>Alu Mux = {s.aluMux1}</text>
      <text x={70} y={390} fontSize={11} fill={s.aluOp3 !== "000" ? C.ctlActive : C.ctlIdle}>Alu Op = {s.aluOp3}</text>
      <text x={70} y={406} fontSize={11} fill={s.accWeRaw1 === "1" ? C.ctlActive : C.ctlIdle}>Acc WE = {s.accWeRaw1}</text>
      <text x={70} y={422} fontSize={11} fill={s.halt1 === "1" ? C.ctlActive : C.ctlIdle}>Halt = {s.halt1}</text>

      <text x={55} y={458} fontSize={11} fill={C.sub}>DATA OUT</text>
      <text x={70} y={476} fontSize={11} fill={ramDataUsedByAddr ? C.dataDecActive : C.dataDecIdle}>Ram Data = {hex(s.ramData8)}</text>
      <text x={70} y={492} fontSize={11} fill={aluDataUsedByALU ? C.dataDecActive : C.dataDecIdle}>Alu Data = {hex(s.aluData16)}</text>

      <text x={55} y={540} fontSize={10} fill={C.sub}>· WEs ANDed externally</text>
      <text x={55} y={554} fontSize={10} fill={C.sub}>  with Phase before reaching</text>
      <text x={55} y={568} fontSize={10} fill={C.sub}>  their register enables.</text>
      <text x={55} y={590} fontSize={10} fill={C.sub}>· goif0: Prog WE is ANDed</text>
      <text x={55} y={604} fontSize={10} fill={C.sub}>  internally with acc_zero.</text>

      {/* ============================================================
          RAM — far right, large
          ============================================================ */}
      <rect x={1200} y={260} width={460} height={590} fill={C.boxFill} stroke={ramWrites ? C.wireActive : C.memBorder} strokeWidth={2} />
      <text x={1430} y={288} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>RAM</text>
      <text x={1430} y={306} textAnchor="middle" fontSize={11} fill={C.sub}>256 × 16-bit (single-port, Von Neumann)</text>
      <text x={1430} y={324} textAnchor="middle" fontSize={11} fill={C.sub}>unified code + data</text>
      <text x={1430} y={356} textAnchor="middle" fontSize={12} fontWeight="bold" fill={C.title}>addr = {hex(s.addr8)}</text>
      <text x={1430} y={374} textAnchor="middle" fontSize={12} fontWeight="bold" fill={C.title}>Dout = {hex(s.ramDout16)}</text>
      {ramWrites && (
        <text x={1430} y={402} textAnchor="middle" fontSize={11} fontWeight="bold" fill={C.wireActive}>
          WRITE RAM[{hex(s.ramData8)}] ← {hex(s.acc16)}
        </text>
      )}
      <text x={1215} y={352} fontSize={10} fill={C.pin}>addr</text>
      <text x={1215} y={386} fontSize={10} fill={C.pin}>Din</text>
      <text x={1215} y={420} fontSize={10} fill={C.pin}>WE</text>
      <text x={1215} y={290} fontSize={10} fill={C.pin}>Dout</text>
      <text x={1215} y={498} fontSize={10} fill={C.pin}>clk</text>

      {/* ============================================================
          IR — directly above RAM
          ============================================================ */}
      <rect x={1200} y={170} width={300} height={70} fill={C.boxFill} stroke={C.regBorder} strokeWidth={2} />
      <text x={1350} y={192} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>IR  (Instruction Register, 16b)</text>
      <text x={1350} y={210} textAnchor="middle" fontSize={13} fontWeight="bold" fill={C.wireActive}>{hex(s.ir16)}</text>
      <text x={1350} y={228} textAnchor="middle" fontSize={10} fill={C.sub}>WE = !Phase  ·  op [15:12]={s.ir16.slice(0, 4)}  n [7:0]={s.ir16.slice(8, 16)}</text>

      {/* ============================================================
          PC Counter, ProgMux, Addr Mux
          ============================================================ */}
      <rect x={340} y={200} width={160} height={90} fill={C.boxFill} stroke={C.cntBorder} strokeWidth={2} />
      <text x={420} y={224} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>PC (Counter, 8b)</text>
      <text x={420} y={242} textAnchor="middle" fontSize={11} fill={C.sub}>CT = !Phase</text>
      <text x={420} y={258} textAnchor="middle" fontSize={11} fill={C.sub}>LD = ProgWE · Phase</text>
      <text x={420} y={282} textAnchor="middle" fontSize={13} fontWeight="bold" fill={C.wireActive}>Q = {hex(s.pc8)}</text>

      <rect x={340} y={320} width={160} height={80} fill={C.boxFill} stroke={C.muxBorder} strokeWidth={2} />
      <text x={420} y={342} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>ProgMux</text>
      <text x={420} y={362} textAnchor="middle" fontSize={11} fill={s.progMux1 === "0" ? C.wireActive : C.sub}>0: Acc[7:0]</text>
      <text x={420} y={378} textAnchor="middle" fontSize={11} fill={s.progMux1 === "1" ? C.wireActive : C.sub}>1: ALU[7:0]</text>
      <text x={380} y={396} textAnchor="middle" fontSize={10} fill={C.pin}>0</text>
      <text x={460} y={396} textAnchor="middle" fontSize={10} fill={C.pin}>1</text>

      <rect x={800} y={200} width={140} height={100} fill={C.boxFill} stroke={C.muxBorder} strokeWidth={2} />
      <text x={870} y={224} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>Addr Mux</text>
      <text x={870} y={244} textAnchor="middle" fontSize={11} fill={!activePhase ? C.wireActive : C.sub}>0: PC</text>
      <text x={870} y={262} textAnchor="middle" fontSize={11} fill={activePhase ? C.wireActive : C.sub}>1: Ram Data</text>
      <text x={870} y={288} textAnchor="middle" fontSize={11} fontWeight="bold" fill={C.ctlIdle}>sel = Phase</text>
      <text x={812} y={224} fontSize={10} fill={C.pin}>0</text>
      <text x={812} y={284} fontSize={10} fill={C.pin}>1</text>

      {/* ============================================================
          ALU B Mux, ALU, Acc, Zero Detect (center stack)
          ============================================================ */}
      <rect x={760} y={420} width={220} height={80} fill={C.boxFill} stroke={C.muxBorder} strokeWidth={2} />
      <text x={870} y={444} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>ALU B Mux</text>
      <text x={870} y={464} textAnchor="middle" fontSize={11} fill={s.aluMux1 === "0" ? C.wireActive : C.sub}>0: Alu Data</text>
      <text x={870} y={482} textAnchor="middle" fontSize={11} fill={s.aluMux1 === "1" ? C.wireActive : C.sub}>1: RAM Dout</text>
      <text x={772} y={444} fontSize={10} fill={C.pin}>0</text>
      <text x={772} y={484} fontSize={10} fill={C.pin}>1</text>

      <rect x={720} y={540} width={300} height={130} fill={C.boxFill} stroke={C.aluBorder} strokeWidth={2} />
      <text x={870} y={568} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>ALU</text>
      <text x={870} y={588} textAnchor="middle" fontSize={11} fill={C.sub}>16b two&apos;s complement</text>
      <text x={870} y={606} textAnchor="middle" fontSize={11} fill={C.sub}>Pass / Add / Sub / Mul / Div</text>
      <text x={870} y={628} textAnchor="middle" fontSize={11} fontWeight="bold" fill={C.title}>op = {s.aluOp3}</text>
      <text x={870} y={646} textAnchor="middle" fontSize={12} fontWeight="bold" fill={C.wireActive}>out = {hex(s.aluOut16)}</text>
      <text x={734} y={568} fontSize={10} fill={C.pin}>A</text>
      <text x={858} y={558} fontSize={10} fill={C.pin}>B</text>

      <rect x={760} y={710} width={220} height={60} fill={C.boxFill} stroke={aluWrites ? C.wireActive : C.regBorder} strokeWidth={2} />
      <text x={870} y={734} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>Acc (16b)</text>
      <text x={870} y={754} textAnchor="middle" fontSize={13} fontWeight="bold" fill={C.wireActive}>{hex(s.acc16)}</text>

      <rect x={760} y={800} width={220} height={45} fill={C.boxFill} stroke={C.zdBorder} strokeWidth={2} />
      <text x={870} y={822} textAnchor="middle" fontSize={13} fontWeight="bold" fill={C.title}>Zero Detect</text>
      <text x={870} y={838} textAnchor="middle" fontSize={11} fill={s.accZero1 === "1" ? C.wireActive : C.sub}>acc_zero = {s.accZero1}</text>

      {/* ============================================================
          DATA / ADDRESS WIRES (solid)
          ============================================================ */}

      {/* PC.Q → Addr Mux[0] */}
      <path d="M 500 220 L 800 220" fill="none" stroke={activeStroke(!activePhase)} strokeWidth={2} markerEnd={m(!activePhase, "data")} />

      {/* ProgMux out → PC.D */}
      <path d="M 420 320 L 420 290" fill="none" stroke={activeStroke(pcJumps)} strokeWidth={2} markerEnd={m(pcJumps, "data")} />

      {/* Addr Mux out → RAM addr (routed below IR) */}
      <path d="M 940 260 L 1000 260 L 1000 290 L 1180 290 L 1180 350 L 1200 350" fill="none" stroke={C.wireActive} strokeWidth={2} markerEnd="url(#arrActive)" />

      {/* RAM Dout → IR.Din */}
      <path d="M 1220 260 L 1220 250 L 1350 250 L 1350 240" fill="none" stroke={activeStroke(ramReadUsedByIR)} strokeWidth={2} markerEnd={m(ramReadUsedByIR, "data")} />

      {/* RAM Dout → ALU B Mux [1]  (tap) */}
      <circle cx={1220} cy={260} r={3} fill={ramDoutActive ? C.wireActive : C.wireIdle} />
      <path d="M 1220 260 L 1100 260 L 1100 405 L 962 405 L 962 420" fill="none" stroke={activeStroke(ramReadUsedByALU)} strokeWidth={2} markerEnd={m(ramReadUsedByALU, "data")} />

      {/* IR.Q → Decoder (long across top channel) */}
      <path d="M 1200 205 L 1150 205 L 1150 150 L 290 150 L 290 260 L 280 260" fill="none" stroke={C.wireActive} strokeWidth={2} markerEnd="url(#arrActive)" />

      {/* Decoder Ram Data → Addr Mux [1] */}
      <path d="M 280 476 L 312 476 L 312 298 L 790 298 L 790 285 L 800 285" fill="none" stroke={decDataStroke(ramDataUsedByAddr)} strokeWidth={2} markerEnd={m(ramDataUsedByAddr, "dec")} />

      {/* Decoder Alu Data → ALU B Mux [0] */}
      <path d="M 280 492 L 324 492 L 324 444 L 760 444" fill="none" stroke={decDataStroke(aluDataUsedByALU)} strokeWidth={2} markerEnd={m(aluDataUsedByALU, "dec")} />

      {/* ALU B Mux → ALU.B */}
      <path d="M 870 500 L 870 540" fill="none" stroke={C.wireActive} strokeWidth={2} markerEnd="url(#arrActive)" />

      {/* ALU out → Acc.D */}
      <path d="M 870 670 L 870 710" fill="none" stroke={activeStroke(aluWrites)} strokeWidth={2} markerEnd={m(aluWrites, "data")} />

      {/* Acc.Q → ALU.A (loop left of ALU up to top-left) */}
      <circle cx={870} cy={770} r={3} fill={C.wireActive} />
      <path d="M 870 770 L 870 790 L 700 790 L 700 568 L 720 568" fill="none" stroke={C.wireActive} strokeWidth={2} markerEnd="url(#arrActive)" />

      {/* Acc → Zero Detect */}
      <path d="M 870 770 L 870 800" fill="none" stroke={C.wireIdle} strokeWidth={2} markerEnd="url(#arr)" />

      {/* Zero Detect → Decoder */}
      <path d="M 760 822 L 316 822 L 316 274 L 280 274" fill="none" stroke={activeStroke(s.accZero1 === "1")} strokeWidth={2} markerEnd={m(s.accZero1 === "1", "data")} />

      {/* Acc[7:0] → ProgMux [0]  (tap off Acc.Q wire at (700, 790)) */}
      <circle cx={700} cy={790} r={3} fill={pcJumps && s.progMux1 === "0" ? C.wireActive : C.wireIdle} />
      <path d="M 700 790 L 380 790 L 380 400" fill="none" stroke={activeStroke(pcJumps && s.progMux1 === "0")} strokeWidth={2} markerEnd={m(pcJumps && s.progMux1 === "0", "data")} />

      {/* ALU_out[7:0] → ProgMux [1]  (tap off ALU→Acc wire) */}
      <circle cx={870} cy={690} r={3} fill={pcJumps && s.progMux1 === "1" ? C.wireActive : C.wireIdle} />
      <path d="M 870 690 L 460 690 L 460 400" fill="none" stroke={activeStroke(pcJumps && s.progMux1 === "1")} strokeWidth={2} markerEnd={m(pcJumps && s.progMux1 === "1", "data")} />

      {/* Acc → RAM Din  (tap off Acc.Q wire, right along y=790 then up) */}
      <path d="M 700 790 L 1120 790 L 1120 386 L 1200 386" fill="none" stroke={activeStroke(ramWrites)} strokeWidth={2} markerEnd={m(ramWrites, "data")} />

      {/* ============================================================
          CONTROL SIGNALS (red dashed)
          ============================================================ */}

      {/* Prog WE → PC.LD */}
      <path d="M 280 326 L 318 326 L 318 222 L 340 222" fill="none" stroke={ctlStroke(s.progWeRaw1 === "1")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={m(s.progWeRaw1 === "1", "ctl")} />

      {/* Prog Mux sel → ProgMux */}
      <path d="M 280 342 L 340 342" fill="none" stroke={ctlStroke(s.progMux1 === "1")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={m(s.progMux1 === "1", "ctl")} />

      {/* Ram WE → RAM.WE */}
      <path d="M 280 358 L 1180 358 L 1180 420 L 1200 420" fill="none" stroke={ctlStroke(s.ramWeRaw1 === "1")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={m(s.ramWeRaw1 === "1", "ctl")} />

      {/* Alu Mux sel → ALU B Mux */}
      <path d="M 280 374 L 640 374 L 640 516 L 870 516 L 870 500" fill="none" stroke={ctlStroke(s.aluMux1 === "1")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={m(s.aluMux1 === "1", "ctl")} />

      {/* Alu Op → ALU */}
      <path d="M 280 390 L 706 390 L 706 620 L 720 620" fill="none" stroke={ctlStroke(s.aluOp3 !== "000")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={m(s.aluOp3 !== "000", "ctl")} />

      {/* Acc WE → Acc */}
      <path d="M 280 406 L 652 406 L 652 740 L 760 740" fill="none" stroke={ctlStroke(s.accWeRaw1 === "1")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={m(s.accWeRaw1 === "1", "ctl")} />

      {/* Halt → Halt Latch */}
      <path d="M 280 422 L 300 422 L 300 130 L 530 130 L 530 110" fill="none" stroke={ctlStroke(s.halt1 === "1")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={m(s.halt1 === "1", "ctl")} />

      {/* Phase → Addr Mux sel (also fans out to IR.WE via junction at (420,140)) */}
      <path d="M 420 110 L 420 140 L 870 140 L 870 200" fill="none" stroke={ctlStroke(activePhase)} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={m(activePhase, "ctl")} />
      <circle cx={420} cy={140} r={3} fill={C.ctlIdle} />

      {/* !Phase → IR.WE (continues from the Phase junction, right across top) */}
      <path d="M 420 140 L 1440 140 L 1440 240" fill="none" stroke={ctlStroke(s.irWe1 === "1")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={m(s.irWe1 === "1", "ctl")} />

      {/* !Phase → PC.CT (Phase left along top, down to PC left) */}
      <path d="M 420 110 L 320 110 L 320 260 L 340 260" fill="none" stroke={ctlStroke(s.pcCt1 === "1")} strokeWidth={1.4} strokeDasharray="5 3" markerEnd={m(s.pcCt1 === "1", "ctl")} />
    </svg>
  );
}
