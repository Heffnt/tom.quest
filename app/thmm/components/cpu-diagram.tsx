/**
 * Schematic — a cleaner, smaller datapath drawing than the old one. Five
 * components only (PC, IR, Decoder, ALU, RAM, Acc) with the wires that
 * matter for understanding instruction execution. The old datapath.tsx
 * tried to mirror the Logisim schematic pin-for-pin; this one is a
 * teaching diagram, not a circuit reference.
 *
 * Active wires light up in accent; inactive wires stay dim. Each component
 * also shows its current value (PC: address, IR: hex word, Acc: hex value,
 * ALU: op + result), which is what the audience will actually be reading
 * during a live demo.
 */
"use client";

import type { Bits, Signals } from "../cpu";
import { toUint } from "../cpu";

type Props = {
  signals: Signals | null;
  pc: Bits;
  ir: Bits;
  acc: Bits;
};

const C = {
  bg: "#0f1622",
  border: "#1e293b",
  borderActive: "#e8a040",
  wireIdle: "#334155",
  wireActive: "#e8a040",
  text: "#e2e8f0",
  textMuted: "#64748b",
  textFaint: "#334155",
};

const ALU_OP_LABEL: Record<string, string> = {
  "000": "pass",
  "001": "+",
  "010": "−",
  "011": "×",
  "100": "÷",
};

function hex(bits: Bits): string {
  const w = Math.ceil(bits.length / 4);
  return "0x" + toUint(bits).toString(16).toUpperCase().padStart(w, "0");
}

export default function CpuDiagram({ signals, pc, ir, acc }: Props) {
  const fetchPhase = !signals || signals.phase1 === "0";
  const aluActive = signals?.accWeRaw1 === "1";
  const ramWrite  = signals?.ramWeRaw1 === "1" && signals?.phase1 === "1";

  const wirePcRam      = fetchPhase;
  const wireRamIr      = signals?.irWe1 === "1";
  const wireIrDecoder  = true; // always the decoder's input
  const wireDecoderRam = signals?.phase1 === "1"; // execute phase reads operand
  const wireRamAlu     = signals?.aluMux1 === "1" && signals?.phase1 === "1";
  const wireDecAlu     = signals?.aluMux1 === "0" && signals?.phase1 === "1";
  const wireAluAcc     = aluActive;
  const wireAccRam     = ramWrite;

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-sm font-medium">Schematic</div>
          <div className="text-xs text-text-muted">
            {fetchPhase
              ? "Fetch phase: PC drives RAM address, RAM word lands in IR."
              : "Execute phase: decoder reads IR, drives ALU + memory."}
          </div>
        </div>
      </div>

      <svg viewBox="0 0 900 500" className="w-full h-auto" fontFamily="var(--font-ibm-plex-mono), monospace">
        {/* Wires (under boxes) */}
        <Wire d="M 130 80 L 360 80" active={wirePcRam} label="addr" lx={245} ly={70} />
        <Wire d="M 540 100 L 700 100" active={wireRamIr} label="instr" lx={620} ly={90} />
        <Wire d="M 770 160 L 770 220 L 220 220 L 220 250" active={wireIrDecoder} label="" lx={0} ly={0} />
        <Wire d="M 130 320 L 360 320" active={wireDecoderRam} label="operand addr" lx={245} ly={310} />
        <Wire d="M 360 360 L 280 360 L 280 410 L 360 410" active={wireDecAlu} label="immediate" lx={290} ly={400} />
        <Wire d="M 540 360 L 460 360 L 460 410 L 540 410" active={wireRamAlu} label="memory" lx={490} ly={400} />
        <Wire d="M 670 460 L 670 480 L 770 480 L 770 410" active={wireAluAcc} label="" lx={0} ly={0} />
        <Wire d="M 700 360 L 600 360 L 600 410" active={false} label="" lx={0} ly={0} />
        <Wire d="M 770 380 L 770 360 L 540 360" active={wireAccRam} label="data write" lx={620} ly={350} />

        {/* Boxes */}
        <Box
          x={20}  y={50}   w={110} h={70}
          title="PC"         sub="program counter (8b)"
          value={hex(pc)}    active={wirePcRam}
        />
        <Box
          x={360} y={50}   w={180} h={120}
          title="RAM"        sub="256 × 16 bits"
          value={signals ? hex(signals.ramDout16) : "0x0000"}
          active={wireRamIr || ramWrite}
        />
        <Box
          x={700} y={70}   w={170} h={70}
          title="IR"         sub="instruction register (16b)"
          value={hex(ir)}    active={wireRamIr}
        />
        <Box
          x={20}  y={250}  w={400} h={110}
          title="Decoder"    sub="combinational — IR → control signals"
          value={signals ? `op ${signals.ir16.slice(0,4)} · n ${toUint(signals.ir16.slice(8,16))}` : "·"}
          active={!fetchPhase}
        />
        <Box
          x={540} y={380}  w={260} h={80}
          title="ALU"        sub={`op = ${signals ? (ALU_OP_LABEL[signals.aluOp3] ?? signals.aluOp3) : "·"}`}
          value={signals ? hex(signals.aluOut16) : "0x0000"}
          active={aluActive}
        />
        <Box
          x={700} y={380}  w={170} h={80}
          title="Acc"        sub="accumulator (16b)"
          value={hex(acc)}   active={aluActive}
        />
      </svg>
    </div>
  );
}

function Box({
  x, y, w, h, title, sub, value, active,
}: {
  x: number; y: number; w: number; h: number;
  title: string; sub: string; value: string;
  active: boolean;
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
      <text x={x + 12} y={y + 22} fontSize={14} fontWeight="bold" fill={C.text}>{title}</text>
      <text x={x + 12} y={y + 38} fontSize={10} fill={C.textMuted}>{sub}</text>
      <text
        x={x + w - 12} y={y + h - 12}
        fontSize={13} fontWeight="bold"
        textAnchor="end"
        fill={active ? C.wireActive : C.text}
      >
        {value}
      </text>
    </g>
  );
}

function Wire({
  d, active, label, lx, ly,
}: {
  d: string;
  active: boolean;
  label: string;
  lx: number;
  ly: number;
}) {
  return (
    <g>
      <path d={d} fill="none" stroke={active ? C.wireActive : C.wireIdle} strokeWidth={active ? 2 : 1.5} />
      {label && (
        <text x={lx} y={ly} fontSize={10} fill={active ? C.wireActive : C.textMuted} textAnchor="middle">
          {label}
        </text>
      )}
    </g>
  );
}
