/**
 * CPU schematic — structural mirror of the canonical Logisim datapath
 * (THMM/docs/datapath.svg). Every named wire and component on that diagram
 * appears here, in roughly the same position, so this drawing can stand in
 * as a teaching aid for the actual hardware spec. The visual treatment is
 * intentionally restrained: one muted border for everything, accent colour
 * for whatever is active in the current cycle, no per-component colour
 * coding. Active wires brighten and thicken; control signals stay dashed.
 */
"use client";

import type { Bits, Signals } from "../cpu";
import { toUint } from "../cpu";

// ==========================================================================
// Theme
// ==========================================================================

const C = {
  bg: "transparent",
  border: "rgba(148, 163, 184, 0.18)",
  borderActive: "var(--color-accent)",
  title: "var(--color-text)",
  sub: "var(--color-text-muted)",
  pin: "var(--color-text-faint)",
  wireIdle: "rgba(100, 116, 139, 0.45)",
  wireActive: "var(--color-accent)",
  ctlIdle: "rgba(239, 68, 68, 0.25)",
  ctlActive: "var(--color-error)",
};

function activeStroke(on: boolean): string { return on ? C.wireActive : C.wireIdle; }
function ctlStroke(on: boolean): string { return on ? C.ctlActive : C.ctlIdle; }

function hex(bits: Bits): string {
  const w = Math.ceil(bits.length / 4);
  return "0x" + toUint(bits).toString(16).toUpperCase().padStart(w, "0");
}

const ALU_OP_LABEL: Record<string, string> = {
  "000": "pass",
  "001": "add",
  "010": "sub",
  "011": "mul",
  "100": "div",
};

// ==========================================================================
// Component
// ==========================================================================

type Props = {
  signals: Signals | null;
  pc: Bits;
  ir: Bits;
  acc: Bits;
};

export default function CpuDiagram({ signals: rawSignals, pc, ir, acc }: Props) {
  // If we don't have signals yet (initial render before first peek), show a
  // dimmed everything-zero state.
  const s = rawSignals;

  // Derive activity flags exactly as the old datapath did.
  const activePhase     = s?.phase1 === "1";
  const ramReadUsedByIR = s?.irWe1 === "1";
  const ramReadUsedByALU = !!s && activePhase && s.aluMux1 === "1";
  const ramDoutActive   = ramReadUsedByIR || ramReadUsedByALU;
  const ramDataAddrPath = !!s && activePhase;
  const aluDataPath     = !!s && activePhase && s.aluMux1 === "0";
  const aluWrites       = s?.accWe1 === "1";
  const pcJumps         = s?.progWe1 === "1";
  const ramWrites       = s?.ramWe1 === "1";
  const halts           = s?.halt1 === "1" && activePhase;
  const halted          = s?.halted1 === "1";

  const m = (on: boolean, kind: "data" | "ctl") =>
    on
      ? kind === "data" ? "url(#arrActive)" : "url(#arrCtlActive)"
      : kind === "data" ? "url(#arr)"       : "url(#arrCtl)";

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-sm font-medium">Schematic</div>
          <div className="text-xs text-text-muted">
            {!s ? "Idle." :
              activePhase
                ? "Execute phase — decoder drives ALU and memory."
                : "Fetch phase — PC drives RAM address; word lands in IR."}
          </div>
        </div>
        <div className="text-xs text-text-muted font-mono">
          {halted ? "halted" : (s ? `cycle ${pad3(toUint(s.phase1))}` : "")}
        </div>
      </div>

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
        </defs>

        {/* ============================================================ */}
        {/* TOP STATUS BAR — Clock big and centered, Phase/Halt small     */}
        {/* ============================================================ */}

        {/* Phase indicator (far left, small) */}
        <Box x={60} y={30} w={140} h={50}>
          <text x={130} y={52} textAnchor="middle" fontSize={11} fontWeight="bold" fill={C.title}>Phase</text>
          <text x={130} y={68} textAnchor="middle" fontSize={11} fill={C.wireActive}>
            {activePhase ? "execute" : "fetch"}
          </text>
        </Box>

        {/* Clock — bigger, centered horizontally */}
        <Box x={720} y={15} w={260} h={80}>
          <text x={850} y={42} textAnchor="middle" fontSize={16} fontWeight="bold" fill={C.title}>Clock</text>
          <text x={850} y={66} textAnchor="middle" fontSize={12} fill={halted ? C.ctlActive : C.sub}>
            {halted ? "gated off" : "running"}
          </text>
          <text x={850} y={84} textAnchor="middle" fontSize={10} fill={C.sub}>
            drives fetch/execute cycle
          </text>
        </Box>

        {/* Halt Latch (far right, small) */}
        <Box x={1500} y={30} w={140} h={50} active={halts || halted}>
          <text x={1570} y={52} textAnchor="middle" fontSize={11} fontWeight="bold" fill={C.title}>Halt Latch</text>
          <text x={1570} y={68} textAnchor="middle" fontSize={11} fill={halted ? C.ctlActive : C.sub}>
            {halted ? "halted" : "running"}
          </text>
        </Box>

        {/* Halt → Clock gate (subtle dashed line above all components) */}
        <path d="M 1500 50 L 1480 50 L 1480 8 L 850 8 L 850 15"
              fill="none" stroke={ctlStroke(halted)} strokeWidth={1.2} strokeDasharray="4 3"
              markerEnd={m(halted, "ctl")} />

        {/* ============================================================ */}
        {/* LEFT COLUMN — IR (top) feeds DECODER (huge tower below)       */}
        {/* ============================================================ */}

        {/* IR — instruction register (large, above decoder) */}
        <Box x={60} y={130} w={320} h={110} active={ramReadUsedByIR}>
          <text x={220} y={162} textAnchor="middle" fontSize={20} fontWeight="bold" fill={C.title}>
            Instruction Register
          </text>
          <text x={220} y={200} textAnchor="middle" fontSize={26} fontWeight="bold" fill={C.wireActive}>
            {hex(ir)}
          </text>
          <text x={220} y={225} textAnchor="middle" fontSize={11} fill={C.sub}>
            op = {(s?.ir16 ?? ir).slice(0, 4)}  ·  operand = {(s?.ir16 ?? ir).slice(8, 16)}
          </text>
        </Box>

        {/* Decoder — controller (huge box dominating the left column) */}
        <Box x={60} y={280} w={320} h={560} active={activePhase}>
          <text x={220} y={325} textAnchor="middle" fontSize={28} fontWeight="bold" fill={C.title}>
            DECODER
          </text>
          <text x={220} y={346} textAnchor="middle" fontSize={11} fill={C.sub}>
            controls all data flow
          </text>

          <text x={75} y={385} fontSize={11} fill={C.sub}>inputs</text>
          <text x={90} y={403} fontSize={11} fill={C.title}>IR  = {s ? hex(s.ir16) : hex(ir)}</text>
          <text x={90} y={419} fontSize={11} fill={C.title}>z   = {s ? s.accZero1 : "0"}</text>

          <text x={75} y={455} fontSize={11} fill={C.sub}>control out</text>
          <Ctl x={90} y={473} active={s?.progWeRaw1 === "1"}>ProgWE</Ctl>
          <Ctl x={90} y={491} active={s?.progMux1 === "1"}>ProgMux</Ctl>
          <Ctl x={90} y={509} active={s?.ramWeRaw1 === "1"}>RamWE</Ctl>
          <Ctl x={90} y={527} active={s?.aluMux1 === "1"}>AluMux</Ctl>
          <Ctl x={90} y={545} active={!!s && s.aluOp3 !== "000"}>AluOp = {s?.aluOp3 ?? "000"}</Ctl>
          <Ctl x={90} y={563} active={s?.accWeRaw1 === "1"}>AccWE</Ctl>
          <Ctl x={90} y={581} active={s?.halt1 === "1"}>Halt</Ctl>

          <text x={75} y={620} fontSize={11} fill={C.sub}>data out</text>
          <text x={90} y={638} fontSize={11} fill={ramDataAddrPath ? C.wireActive : C.sub}>
            RamData = {s ? hex(s.ramData8) : "0x00"}
          </text>
          <text x={90} y={654} fontSize={11} fill={aluDataPath ? C.wireActive : C.sub}>
            AluData = {s ? hex(s.aluData16) : "0x0000"}
          </text>
        </Box>

        {/* ============================================================ */}
        {/* RIGHT COLUMN — PC (top) feeds RAM (huge tower below)          */}
        {/* ============================================================ */}

        {/* PC — program counter (large, above RAM) */}
        <Box x={1320} y={130} w={320} h={110} active={pcJumps}>
          <text x={1480} y={162} textAnchor="middle" fontSize={20} fontWeight="bold" fill={C.title}>
            Program Counter
          </text>
          <text x={1480} y={200} textAnchor="middle" fontSize={26} fontWeight="bold" fill={C.wireActive}>
            {hex(pc)}
          </text>
          <text x={1480} y={225} textAnchor="middle" fontSize={11} fill={C.sub}>
            address of next instruction
          </text>
        </Box>

        {/* Addr Mux — trapezoid sitting between PC and RAM */}
        <path d="M 1380 270 L 1580 270 L 1530 320 L 1430 320 Z"
              fill={C.bg} stroke={C.border} strokeWidth={1.5} />
        <text x={1480} y={290} textAnchor="middle" fontSize={11} fontWeight="bold" fill={C.title}>
          Addr Mux
        </text>
        <text x={1480} y={308} textAnchor="middle" fontSize={10} fill={C.wireActive}>
          {activePhase ? "RamData" : "PC"}
        </text>

        {/* RAM — huge tower (right column) */}
        <Box x={1320} y={350} w={320} h={490} active={ramWrites}>
          <text x={1480} y={395} textAnchor="middle" fontSize={28} fontWeight="bold" fill={C.title}>
            RAM
          </text>
          <text x={1480} y={418} textAnchor="middle" fontSize={11} fill={C.sub}>
            256 × 16 bits — code + data
          </text>
          <text x={1480} y={460} textAnchor="middle" fontSize={13} fill={C.title}>
            addr = {s ? hex(s.addr8) : "0x00"}
          </text>
          <text x={1480} y={482} textAnchor="middle" fontSize={13} fill={C.title}>
            Dout = {s ? hex(s.ramDout16) : "0x0000"}
          </text>
          {ramWrites && s && (
            <text x={1480} y={512} textAnchor="middle" fontSize={11} fontWeight="bold" fill={C.wireActive}>
              WRITE RAM[{hex(s.ramData8)}] ← {hex(s.acc16)}
            </text>
          )}
          <text x={1335} y={395} fontSize={9} fill={C.pin}>Dout</text>
          <text x={1335} y={460} fontSize={9} fill={C.pin}>addr</text>
          <text x={1335} y={490} fontSize={9} fill={C.pin}>Din</text>
          <text x={1335} y={525} fontSize={9} fill={C.pin}>WE</text>
        </Box>

        {/* ============================================================ */}
        {/* PROG MUX — small box attached to PC's left side               */}
        {/* ============================================================ */}
        <Box x={1230} y={152} w={88} h={44}>
          <text x={1274} y={170} textAnchor="middle" fontSize={11} fontWeight="bold" fill={C.title}>
            ProgMux
          </text>
          <text x={1274} y={186} textAnchor="middle" fontSize={10} fill={C.wireActive}>
            {s?.progMux1 === "1" ? "ALU" : "Acc"}
          </text>
        </Box>

        {/* ============================================================ */}
        {/* CENTER STACK — ALU B Mux → ALU → Acc (Zero left of Acc)        */}
        {/* ============================================================ */}

        {/* ALU B Mux — trapezoid above ALU's B input (right side) */}
        <path d="M 920 335 L 1080 335 L 1030 385 L 970 385 Z"
              fill={C.bg} stroke={C.border} strokeWidth={1.5} />
        <text x={1000} y={358} textAnchor="middle" fontSize={11} fontWeight="bold" fill={C.title}>
          ALU B Mux
        </text>
        <text x={1000} y={376} textAnchor="middle" fontSize={10} fill={C.wireActive}>
          {s?.aluMux1 === "1" ? "RAM" : "immediate"}
        </text>

        {/* ALU — centered block (less wide than before) */}
        <Box x={620} y={415} w={460} h={220} active={aluWrites}>
          <text x={850} y={465} textAnchor="middle" fontSize={36} fontWeight="bold" fill={C.title}>
            ALU
          </text>
          <text x={850} y={490} textAnchor="middle" fontSize={11} fill={C.sub}>
            16-bit two&apos;s complement
          </text>
          <text x={850} y={508} textAnchor="middle" fontSize={11} fill={C.sub}>
            pass · add · sub · mul · div
          </text>
          <text x={850} y={548} textAnchor="middle" fontSize={14} fontWeight="bold" fill={C.title}>
            op = {s ? (ALU_OP_LABEL[s.aluOp3] ?? s.aluOp3) : "pass"}
          </text>
          <text x={850} y={580} textAnchor="middle" fontSize={16} fontWeight="bold" fill={C.wireActive}>
            out = {s ? hex(s.aluOut16) : "0x0000"}
          </text>
          <text x={705} y={432} fontSize={11} fontWeight="bold" fill={C.pin}>A</text>
          <text x={1005} y={432} fontSize={11} fontWeight="bold" fill={C.pin}>B</text>
        </Box>

        {/* Accumulator — directly under ALU center */}
        <Box x={750} y={685} w={200} h={80} active={aluWrites}>
          <text x={850} y={715} textAnchor="middle" fontSize={16} fontWeight="bold" fill={C.title}>
            Accumulator
          </text>
          <text x={850} y={747} textAnchor="middle" fontSize={20} fontWeight="bold" fill={C.wireActive}>
            {hex(acc)}
          </text>
        </Box>

        {/* Zero Detect — small, LEFT of Accumulator */}
        <Box x={560} y={700} w={170} h={50}>
          <text x={645} y={722} textAnchor="middle" fontSize={11} fontWeight="bold" fill={C.title}>
            Zero?
          </text>
          <text x={645} y={740} textAnchor="middle" fontSize={11} fill={s?.accZero1 === "1" ? C.wireActive : C.sub}>
            {s?.accZero1 === "1" ? "YES" : "no"}
          </text>
        </Box>

        {/* ============================================================ */}
        {/* DATA WIRES (solid) — 90° turns, mux entries at corners         */}
        {/* ============================================================ */}

        {/* IR.Q → Decoder (short vertical, IR bottom → Decoder top) */}
        <path d="M 220 240 L 220 280" fill="none"
              stroke={C.wireActive} strokeWidth={2.5}
              markerEnd="url(#arrActive)" />

        {/* PC.Q → Addr Mux input 0 (top-left corner of mux) */}
        <path d="M 1480 240 L 1400 240 L 1400 270" fill="none"
              stroke={activeStroke(!activePhase)} strokeWidth={2}
              markerEnd={m(!activePhase, "data")} />

        {/* Addr Mux → RAM.addr (short vertical, mux bottom → RAM top) */}
        <path d="M 1480 320 L 1480 350" fill="none"
              stroke={C.wireActive} strokeWidth={2.5}
              markerEnd="url(#arrActive)" />

        {/* Decoder.RamData → Addr Mux input 1 (top-right corner) */}
        <path d="M 380 638 L 470 638 L 470 110 L 1560 110 L 1560 270" fill="none"
              stroke={activeStroke(ramDataAddrPath)} strokeWidth={2}
              markerEnd={m(ramDataAddrPath, "data")} />

        {/* RAM.Dout → IR (fetch path, over the top channel y=120) */}
        <path d="M 1320 395 L 1280 395 L 1280 120 L 220 120 L 220 130" fill="none"
              stroke={activeStroke(ramReadUsedByIR)} strokeWidth={2}
              markerEnd={m(ramReadUsedByIR, "data")} />

        {/* RAM.Dout tap → ALU B Mux input 1 (top-right corner) */}
        <circle cx={1280} cy={325} r={3} fill={ramDoutActive ? C.wireActive : C.wireIdle} />
        <path d="M 1280 325 L 1060 325 L 1060 335" fill="none"
              stroke={activeStroke(ramReadUsedByALU)} strokeWidth={2}
              markerEnd={m(ramReadUsedByALU, "data")} />

        {/* Decoder.AluData → ALU B Mux input 0 (top-left corner) */}
        <path d="M 380 654 L 490 654 L 490 325 L 940 325 L 940 335" fill="none"
              stroke={activeStroke(aluDataPath)} strokeWidth={2}
              markerEnd={m(aluDataPath, "data")} />

        {/* ALU B Mux → ALU.B (short vertical, mux output → ALU top) */}
        <path d="M 1000 385 L 1000 415" fill="none"
              stroke={C.wireActive} strokeWidth={2.5}
              markerEnd="url(#arrActive)" />

        {/* ALU output → Acc.D (short vertical, ALU bottom → Acc top) */}
        <path d="M 850 635 L 850 685" fill="none"
              stroke={activeStroke(aluWrites)} strokeWidth={2.5}
              markerEnd={m(aluWrites, "data")} />

        {/* Acc.Q → ALU.A loop (feedback enters ALU from above-left) */}
        <circle cx={850} cy={785} r={3} fill={C.wireActive} />
        <path d="M 850 765 L 850 785 L 540 785 L 540 390 L 705 390 L 705 415" fill="none"
              stroke={C.wireActive} strokeWidth={2.5}
              markerEnd="url(#arrActive)" />
        <text x={515} y={580} fontSize={10} fill={C.sub} transform="rotate(-90 515 580)">
          accumulator feedback
        </text>

        {/* Acc → Zero Detect (short horizontal, Acc left → Zero right) */}
        <path d="M 750 720 L 730 720" fill="none"
              stroke={C.wireActive} strokeWidth={2}
              markerEnd="url(#arrActive)" />

        {/* Zero Detect → Decoder z input (Manhattan, enter from right) */}
        <path d="M 560 720 L 490 720 L 490 419 L 380 419" fill="none"
              stroke={activeStroke(s?.accZero1 === "1")} strokeWidth={1.6}
              markerEnd={m(s?.accZero1 === "1", "data")} />

        {/* Acc → ProgMux input 0 (Acc bus tap → up to mux left side) */}
        <path d="M 850 785 L 1230 785 L 1230 166" fill="none"
              stroke={activeStroke(pcJumps && s?.progMux1 === "0")} strokeWidth={2}
              markerEnd={m(pcJumps && s?.progMux1 === "0", "data")} />

        {/* ALU_out[7:0] → ProgMux input 1 (tap from ALU output → up to mux left side) */}
        <circle cx={850} cy={660} r={3} fill={pcJumps && s?.progMux1 === "1" ? C.wireActive : C.wireIdle} />
        <path d="M 850 660 L 1215 660 L 1215 182 L 1230 182" fill="none"
              stroke={activeStroke(pcJumps && s?.progMux1 === "1")} strokeWidth={2}
              markerEnd={m(pcJumps && s?.progMux1 === "1", "data")} />

        {/* ProgMux → PC.D (short horizontal, mux right → PC left) */}
        <path d="M 1318 174 L 1320 174" fill="none"
              stroke={activeStroke(pcJumps)} strokeWidth={2}
              markerEnd={m(pcJumps, "data")} />

        {/* Acc → RAM.Din (Acc bus tap → up to RAM Din pin) */}
        <path d="M 850 785 L 1290 785 L 1290 490 L 1320 490" fill="none"
              stroke={activeStroke(ramWrites)} strokeWidth={2}
              markerEnd={m(ramWrites, "data")} />

        {/* ============================================================ */}
        {/* CONTROL SIGNALS (red dashed) — exit decoder right edge        */}
        {/* ============================================================ */}

        {/* ProgWE → PC.LD (route up and across the top channel y=100) */}
        <path d="M 380 473 L 405 473 L 405 100 L 1340 100 L 1340 130" fill="none"
              stroke={ctlStroke(s?.progWeRaw1 === "1")} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(s?.progWeRaw1 === "1", "ctl")} />

        {/* ProgMux sel → ProgMux top (route through gap between PC and AddrMux) */}
        <path d="M 380 491 L 415 491 L 415 252 L 1274 252 L 1274 152" fill="none"
              stroke={ctlStroke(s?.progMux1 === "1")} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(s?.progMux1 === "1", "ctl")} />

        {/* RamWE → RAM.WE (route through gap above ALU at y=400) */}
        <path d="M 380 509 L 430 509 L 430 400 L 1310 400 L 1310 525 L 1320 525" fill="none"
              stroke={ctlStroke(s?.ramWeRaw1 === "1")} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(s?.ramWeRaw1 === "1", "ctl")} />

        {/* AluMux sel → ALU B Mux sel (enter from left side of mux) */}
        <path d="M 380 527 L 445 527 L 445 360 L 920 360" fill="none"
              stroke={ctlStroke(s?.aluMux1 === "1")} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(s?.aluMux1 === "1", "ctl")} />

        {/* AluOp → ALU (direct horizontal into ALU left edge) */}
        <path d="M 380 545 L 620 545" fill="none"
              stroke={ctlStroke(!!s && s.aluOp3 !== "000")} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(!!s && s.aluOp3 !== "000", "ctl")} />

        {/* AccWE → Acc (route under ALU, enter from below) */}
        <path d="M 380 563 L 475 563 L 475 800 L 850 800 L 850 765" fill="none"
              stroke={ctlStroke(s?.accWeRaw1 === "1")} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(s?.accWeRaw1 === "1", "ctl")} />

        {/* Halt → Halt Latch (route up to top channel y=47) */}
        <path d="M 380 581 L 395 581 L 395 55 L 1500 55" fill="none"
              stroke={ctlStroke(s?.halt1 === "1")} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(s?.halt1 === "1", "ctl")} />

        {/* Phase wire (continuous across top, with three taps) */}
        <path d="M 200 55 L 1500 55" fill="none"
              stroke={ctlStroke(activePhase)} strokeWidth={1.4} strokeDasharray="5 3" />

        {/* Phase tap → Addr Mux sel (drop into mux left side) */}
        <circle cx={1380} cy={55} r={3} fill={activePhase ? C.ctlActive : C.ctlIdle} />
        <path d="M 1380 55 L 1380 295" fill="none"
              stroke={ctlStroke(activePhase)} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(activePhase, "ctl")} />

        {/* !Phase tap → IR.WE (drop into IR top) */}
        <circle cx={300} cy={55} r={3} fill={C.ctlIdle} />
        <path d="M 300 55 L 300 130" fill="none"
              stroke={ctlStroke(s?.irWe1 === "1")} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(s?.irWe1 === "1", "ctl")} />

        {/* !Phase tap → PC.CT (drop into PC top) */}
        <circle cx={1450} cy={55} r={3} fill={C.ctlIdle} />
        <path d="M 1450 55 L 1450 130" fill="none"
              stroke={ctlStroke(s?.pcCt1 === "1")} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(s?.pcCt1 === "1", "ctl")} />
      </svg>
    </div>
  );
}

// ==========================================================================
// Small SVG building blocks
// ==========================================================================

function Box({
  x, y, w, h, active, children,
}: {
  x: number; y: number; w: number; h: number;
  active?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <g>
      <rect
        x={x} y={y} width={w} height={h}
        fill={C.bg}
        stroke={active ? C.borderActive : C.border}
        strokeWidth={1.5}
        rx={4}
      />
      {children}
    </g>
  );
}

function Title({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  return (
    <text x={x} y={y} textAnchor="middle" fontSize={13} fontWeight="bold" fill={C.title}>
      {children}
    </text>
  );
}

function Sub({
  x, y, fill, anchor = "middle", children,
}: {
  x: number; y: number;
  fill?: string;
  anchor?: "start" | "middle" | "end";
  children: React.ReactNode;
}) {
  return (
    <text x={x} y={y} textAnchor={anchor} fontSize={11} fill={fill ?? C.sub}>
      {children}
    </text>
  );
}

function Value({
  x, y, fill, children,
}: {
  x: number; y: number; fill?: string; children: React.ReactNode;
}) {
  return (
    <text x={x} y={y} textAnchor="middle" fontSize={12} fontWeight="bold" fill={fill ?? C.title}>
      {children}
    </text>
  );
}

function Ctl({
  x, y, active, children,
}: {
  x: number; y: number; active: boolean; children: React.ReactNode;
}) {
  return (
    <text x={x} y={y} fontSize={11} fill={active ? C.ctlActive : C.ctlIdle}>
      {children}
    </text>
  );
}

function pad3(n: number): string {
  return n.toString().padStart(3, " ");
}
