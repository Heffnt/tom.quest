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

        {/* ============ TOP ROW — Clock, Phase, Halt Latch ============ */}
        <Box x={40}  y={50} w={180} h={60}>
          <Title x={130} y={72}>Clock</Title>
          <Sub   x={130} y={92} fill={halted ? C.ctlActive : C.sub}>
            {halted ? "gated off" : "running"}
          </Sub>
        </Box>

        <Box x={240} y={50} w={180} h={60}>
          <Title x={330} y={72}>Phase</Title>
          <Sub x={330} y={90}>{activePhase ? "1 (execute)" : "0 (fetch)"}</Sub>
          <Value x={330} y={106} fill={C.wireActive}>{s ? s.phase1 : "0"}</Value>
        </Box>

        <Box x={440} y={50} w={180} h={60} active={halts || halted}>
          <Title x={530} y={72}>Halt Latch</Title>
          <Sub x={530} y={90}>set by decoder.Halt</Sub>
          <Value x={530} y={106} fill={halted ? C.ctlActive : C.wireIdle}>{s ? s.halted1 : "0"}</Value>
        </Box>

        {/* Halt → Clock gate, dashed control line above the row */}
        <path d="M 620 60 L 620 38 L 220 38 L 220 60"
              fill="none" stroke={ctlStroke(halted)} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(halted, "ctl")} />
        <text x={380} y={32} textAnchor="middle" fontSize={11} fill={C.ctlIdle}>
          Halt → Clock gate
        </text>

        {/* ============ DECODER ============ */}
        <Box x={40} y={170} w={240} h={640} active={activePhase}>
          <Title x={160} y={196}>Decoder</Title>
          <Sub x={160} y={212}>combinational · IR → control</Sub>

          <Sub x={55} y={244} anchor="start">inputs</Sub>
          <text x={70} y={262} fontSize={11} fill={C.title}>IR  = {s ? hex(s.ir16) : hex(ir)}</text>
          <text x={70} y={278} fontSize={11} fill={C.title}>z   = {s ? s.accZero1 : "0"}</text>

          <Sub x={55} y={312} anchor="start">control out</Sub>
          <Ctl x={70} y={330} active={s?.progWeRaw1 === "1"}>ProgWE = {s?.progWeRaw1 ?? "0"}</Ctl>
          <Ctl x={70} y={346} active={s?.progMux1 === "1"}>ProgMux = {s?.progMux1 ?? "0"}</Ctl>
          <Ctl x={70} y={362} active={s?.ramWeRaw1 === "1"}>RamWE = {s?.ramWeRaw1 ?? "0"}</Ctl>
          <Ctl x={70} y={378} active={s?.aluMux1 === "1"}>AluMux = {s?.aluMux1 ?? "0"}</Ctl>
          <Ctl x={70} y={394} active={!!s && s.aluOp3 !== "000"}>AluOp = {s?.aluOp3 ?? "000"}</Ctl>
          <Ctl x={70} y={410} active={s?.accWeRaw1 === "1"}>AccWE = {s?.accWeRaw1 ?? "0"}</Ctl>
          <Ctl x={70} y={426} active={s?.halt1 === "1"}>Halt = {s?.halt1 ?? "0"}</Ctl>

          <Sub x={55} y={460} anchor="start">data out</Sub>
          <text x={70} y={478} fontSize={11} fill={ramDataAddrPath ? C.wireActive : C.sub}>
            RamData = {s ? hex(s.ramData8) : "0x00"}
          </text>
          <text x={70} y={494} fontSize={11} fill={aluDataPath ? C.wireActive : C.sub}>
            AluData = {s ? hex(s.aluData16) : "0x0000"}
          </text>
        </Box>

        {/* ============ RAM (far right) ============ */}
        <Box x={1200} y={260} w={460} h={590} active={ramWrites}>
          <Title x={1430} y={288}>RAM</Title>
          <Sub x={1430} y={306}>256 × 16 bits — unified code + data</Sub>
          <Sub x={1430} y={322}>Von Neumann, single port</Sub>
          <text x={1430} y={356} textAnchor="middle" fontSize={12} fill={C.title}>
            addr = {s ? hex(s.addr8) : "0x00"}
          </text>
          <text x={1430} y={374} textAnchor="middle" fontSize={12} fill={C.title}>
            Dout = {s ? hex(s.ramDout16) : "0x0000"}
          </text>
          {ramWrites && s && (
            <text x={1430} y={402} textAnchor="middle" fontSize={11} fontWeight="bold" fill={C.wireActive}>
              WRITE RAM[{hex(s.ramData8)}] ← {hex(s.acc16)}
            </text>
          )}
          <text x={1215} y={352} fontSize={10} fill={C.pin}>addr</text>
          <text x={1215} y={386} fontSize={10} fill={C.pin}>Din</text>
          <text x={1215} y={420} fontSize={10} fill={C.pin}>WE</text>
          <text x={1215} y={290} fontSize={10} fill={C.pin}>Dout</text>
          <text x={1215} y={498} fontSize={10} fill={C.pin}>clk</text>
        </Box>

        {/* ============ IR (above RAM) ============ */}
        <Box x={1200} y={170} w={300} h={70} active={ramReadUsedByIR}>
          <Title x={1350} y={192}>IR — instruction register</Title>
          <Value x={1350} y={214} fill={C.wireActive}>{hex(ir)}</Value>
          <Sub x={1350} y={230}>WE = !Phase  ·  op[15:12] = {(s?.ir16 ?? ir).slice(0, 4)}  ·  n[7:0] = {(s?.ir16 ?? ir).slice(8, 16)}</Sub>
        </Box>

        {/* ============ PC, ProgMux, Addr Mux ============ */}
        <Box x={340} y={200} w={160} h={90}>
          <Title x={420} y={224}>PC — counter (8b)</Title>
          <Sub x={420} y={242}>CT = !Phase</Sub>
          <Sub x={420} y={258}>LD = ProgWE · Phase</Sub>
          <Value x={420} y={282} fill={C.wireActive}>Q = {hex(pc)}</Value>
        </Box>

        <Box x={340} y={320} w={160} h={80}>
          <Title x={420} y={342}>ProgMux</Title>
          <Sub x={420} y={362} fill={s?.progMux1 === "0" ? C.wireActive : C.sub}>0: Acc[7:0]</Sub>
          <Sub x={420} y={378} fill={s?.progMux1 === "1" ? C.wireActive : C.sub}>1: ALU[7:0]</Sub>
          <text x={380} y={396} textAnchor="middle" fontSize={10} fill={C.pin}>0</text>
          <text x={460} y={396} textAnchor="middle" fontSize={10} fill={C.pin}>1</text>
        </Box>

        <Box x={800} y={200} w={140} h={100}>
          <Title x={870} y={224}>Addr Mux</Title>
          <Sub x={870} y={244} fill={!activePhase ? C.wireActive : C.sub}>0: PC</Sub>
          <Sub x={870} y={262} fill={activePhase ? C.wireActive : C.sub}>1: RamData</Sub>
          <Sub x={870} y={288}>sel = Phase</Sub>
          <text x={812} y={224} fontSize={10} fill={C.pin}>0</text>
          <text x={812} y={284} fontSize={10} fill={C.pin}>1</text>
        </Box>

        {/* ============ ALU B Mux, ALU, Acc, Zero Detect ============ */}
        <Box x={760} y={420} w={220} h={80}>
          <Title x={870} y={444}>ALU B Mux</Title>
          <Sub x={870} y={464} fill={s?.aluMux1 === "0" ? C.wireActive : C.sub}>0: AluData</Sub>
          <Sub x={870} y={482} fill={s?.aluMux1 === "1" ? C.wireActive : C.sub}>1: RAM Dout</Sub>
          <text x={772} y={444} fontSize={10} fill={C.pin}>0</text>
          <text x={772} y={484} fontSize={10} fill={C.pin}>1</text>
        </Box>

        <Box x={720} y={540} w={300} h={130} active={aluWrites}>
          <Title x={870} y={568}>ALU</Title>
          <Sub x={870} y={588}>16-bit two&apos;s complement</Sub>
          <Sub x={870} y={606}>pass · add · sub · mul · div</Sub>
          <text x={870} y={628} textAnchor="middle" fontSize={11} fill={C.title}>
            op = {s ? (ALU_OP_LABEL[s.aluOp3] ?? s.aluOp3) : "pass"}
          </text>
          <Value x={870} y={648} fill={C.wireActive}>out = {s ? hex(s.aluOut16) : "0x0000"}</Value>
          <text x={734} y={568} fontSize={10} fill={C.pin}>A</text>
          <text x={858} y={558} fontSize={10} fill={C.pin}>B</text>
        </Box>

        <Box x={760} y={710} w={220} h={60} active={aluWrites}>
          <Title x={870} y={734}>Acc — accumulator</Title>
          <Value x={870} y={758} fill={C.wireActive}>{hex(acc)}</Value>
        </Box>

        <Box x={760} y={800} w={220} h={45}>
          <Title x={870} y={822}>Zero Detect</Title>
          <Sub x={870} y={838} fill={s?.accZero1 === "1" ? C.wireActive : C.sub}>
            acc_zero = {s?.accZero1 ?? "0"}
          </Sub>
        </Box>

        {/* ============ DATA / ADDRESS WIRES (solid) ============ */}

        {/* PC.Q → Addr Mux[0] */}
        <path d="M 500 220 L 800 220" fill="none"
              stroke={activeStroke(!activePhase)} strokeWidth={2}
              markerEnd={m(!activePhase, "data")} />

        {/* ProgMux out → PC.D */}
        <path d="M 420 320 L 420 290" fill="none"
              stroke={activeStroke(pcJumps)} strokeWidth={2}
              markerEnd={m(pcJumps, "data")} />

        {/* Addr Mux out → RAM addr (routed below IR) */}
        <path d="M 940 260 L 1000 260 L 1000 290 L 1180 290 L 1180 350 L 1200 350"
              fill="none" stroke={C.wireActive} strokeWidth={2}
              markerEnd="url(#arrActive)" />

        {/* RAM Dout → IR.Din */}
        <path d="M 1220 260 L 1220 250 L 1350 250 L 1350 240" fill="none"
              stroke={activeStroke(ramReadUsedByIR)} strokeWidth={2}
              markerEnd={m(ramReadUsedByIR, "data")} />

        {/* RAM Dout tap → ALU B Mux[1] */}
        <circle cx={1220} cy={260} r={3} fill={ramDoutActive ? C.wireActive : C.wireIdle} />
        <path d="M 1220 260 L 1100 260 L 1100 405 L 962 405 L 962 420" fill="none"
              stroke={activeStroke(ramReadUsedByALU)} strokeWidth={2}
              markerEnd={m(ramReadUsedByALU, "data")} />

        {/* IR.Q → Decoder (long across top channel) */}
        <path d="M 1200 205 L 1150 205 L 1150 150 L 290 150 L 290 260 L 280 260" fill="none"
              stroke={C.wireActive} strokeWidth={2}
              markerEnd="url(#arrActive)" />

        {/* Decoder RamData → Addr Mux[1] */}
        <path d="M 280 476 L 312 476 L 312 298 L 790 298 L 790 285 L 800 285" fill="none"
              stroke={activeStroke(ramDataAddrPath)} strokeWidth={2}
              markerEnd={m(ramDataAddrPath, "data")} />

        {/* Decoder AluData → ALU B Mux[0] */}
        <path d="M 280 492 L 324 492 L 324 444 L 760 444" fill="none"
              stroke={activeStroke(aluDataPath)} strokeWidth={2}
              markerEnd={m(aluDataPath, "data")} />

        {/* ALU B Mux → ALU.B */}
        <path d="M 870 500 L 870 540" fill="none"
              stroke={C.wireActive} strokeWidth={2}
              markerEnd="url(#arrActive)" />

        {/* ALU out → Acc.D */}
        <path d="M 870 670 L 870 710" fill="none"
              stroke={activeStroke(aluWrites)} strokeWidth={2}
              markerEnd={m(aluWrites, "data")} />

        {/* Acc.Q → ALU.A loop */}
        <circle cx={870} cy={770} r={3} fill={C.wireActive} />
        <path d="M 870 770 L 870 790 L 700 790 L 700 568 L 720 568" fill="none"
              stroke={C.wireActive} strokeWidth={2}
              markerEnd="url(#arrActive)" />

        {/* Acc → Zero Detect */}
        <path d="M 870 770 L 870 800" fill="none"
              stroke={C.wireIdle} strokeWidth={2}
              markerEnd="url(#arr)" />

        {/* Zero Detect → Decoder */}
        <path d="M 760 822 L 316 822 L 316 274 L 280 274" fill="none"
              stroke={activeStroke(s?.accZero1 === "1")} strokeWidth={2}
              markerEnd={m(s?.accZero1 === "1", "data")} />

        {/* Acc[7:0] → ProgMux[0] (tap off Acc.Q wire at (700, 790)) */}
        <circle cx={700} cy={790} r={3} fill={pcJumps && s?.progMux1 === "0" ? C.wireActive : C.wireIdle} />
        <path d="M 700 790 L 380 790 L 380 400" fill="none"
              stroke={activeStroke(pcJumps && s?.progMux1 === "0")} strokeWidth={2}
              markerEnd={m(pcJumps && s?.progMux1 === "0", "data")} />

        {/* ALU_out[7:0] → ProgMux[1] */}
        <circle cx={870} cy={690} r={3} fill={pcJumps && s?.progMux1 === "1" ? C.wireActive : C.wireIdle} />
        <path d="M 870 690 L 460 690 L 460 400" fill="none"
              stroke={activeStroke(pcJumps && s?.progMux1 === "1")} strokeWidth={2}
              markerEnd={m(pcJumps && s?.progMux1 === "1", "data")} />

        {/* Acc → RAM Din */}
        <path d="M 700 790 L 1120 790 L 1120 386 L 1200 386" fill="none"
              stroke={activeStroke(ramWrites)} strokeWidth={2}
              markerEnd={m(ramWrites, "data")} />

        {/* ============ CONTROL SIGNALS (red dashed) ============ */}

        {/* Prog WE → PC.LD */}
        <path d="M 280 326 L 318 326 L 318 222 L 340 222" fill="none"
              stroke={ctlStroke(s?.progWeRaw1 === "1")} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(s?.progWeRaw1 === "1", "ctl")} />

        {/* Prog Mux sel → ProgMux */}
        <path d="M 280 342 L 340 342" fill="none"
              stroke={ctlStroke(s?.progMux1 === "1")} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(s?.progMux1 === "1", "ctl")} />

        {/* Ram WE → RAM.WE */}
        <path d="M 280 358 L 1180 358 L 1180 420 L 1200 420" fill="none"
              stroke={ctlStroke(s?.ramWeRaw1 === "1")} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(s?.ramWeRaw1 === "1", "ctl")} />

        {/* Alu Mux sel → ALU B Mux */}
        <path d="M 280 374 L 640 374 L 640 516 L 870 516 L 870 500" fill="none"
              stroke={ctlStroke(s?.aluMux1 === "1")} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(s?.aluMux1 === "1", "ctl")} />

        {/* Alu Op → ALU */}
        <path d="M 280 390 L 706 390 L 706 620 L 720 620" fill="none"
              stroke={ctlStroke(!!s && s.aluOp3 !== "000")} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(!!s && s.aluOp3 !== "000", "ctl")} />

        {/* Acc WE → Acc */}
        <path d="M 280 406 L 652 406 L 652 740 L 760 740" fill="none"
              stroke={ctlStroke(s?.accWeRaw1 === "1")} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(s?.accWeRaw1 === "1", "ctl")} />

        {/* Halt → Halt Latch */}
        <path d="M 280 422 L 300 422 L 300 130 L 530 130 L 530 110" fill="none"
              stroke={ctlStroke(s?.halt1 === "1")} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(s?.halt1 === "1", "ctl")} />

        {/* Phase → Addr Mux sel + IR.WE branch */}
        <path d="M 420 110 L 420 140 L 870 140 L 870 200" fill="none"
              stroke={ctlStroke(activePhase)} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(activePhase, "ctl")} />
        <circle cx={420} cy={140} r={3} fill={C.ctlIdle} />

        {/* !Phase → IR.WE */}
        <path d="M 420 140 L 1440 140 L 1440 240" fill="none"
              stroke={ctlStroke(s?.irWe1 === "1")} strokeWidth={1.4} strokeDasharray="5 3"
              markerEnd={m(s?.irWe1 === "1", "ctl")} />

        {/* !Phase → PC.CT */}
        <path d="M 420 110 L 320 110 L 320 260 L 340 260" fill="none"
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
