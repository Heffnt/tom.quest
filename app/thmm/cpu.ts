/**
 * THMM CPU simulator — TypeScript port of cpu.py from the THMM repo.
 *
 * Structure is intentionally 1:1 with the Python version (see
 * ../../../THMM/cpu.py and ../../../THMM/AGENTS.md in the sibling repo).
 * The canonical datapath diagram lives at THMM/docs/datapath.svg; every
 * local variable in `tick` is a labeled wire on that diagram. A React
 * version of the same datapath drives the page in datapath.tsx here —
 * they are two independently maintained views of the same spec.
 *
 * Wire values are bit strings (a Python-side design choice preserved here
 * deliberately, see THMM/AGENTS.md). Widths are encoded in variable names:
 * pc8, ir16, acc_zero1, alu_op3, etc.
 *
 * This module is UI-agnostic. `tick` mutates `state` in place and returns
 * a `Signals` record capturing every named wire for that cycle — the
 * datapath visualizer consumes the Signals to paint live values.
 */

// ==========================================================================
// Types
// ==========================================================================

/** A fixed-width bit string, e.g. "10110" for a 5-bit value. */
export type Bits = string;

export type State = {
  pc: Bits;       // 8b
  ir: Bits;       // 16b
  acc: Bits;      // 16b
  phase: Bits;    // 1b
  halted: Bits;   // 1b
  ram: Bits[];    // 256 × 16b
  /** UI-only counter; no hardware equivalent. */
  cycle: number;
};

/**
 * Snapshot of every named wire on docs/datapath.svg at the moment the
 * clock edge fired for this cycle. Register-output fields (pc8, ir16,
 * acc16, phase1, halted1) hold the values that were used to compute the
 * combinational cloud — i.e. BEFORE the edge. `writes` lists what the
 * edge actually changed.
 */
export type Signals = {
  // register outputs (pre-edge)
  pc8: Bits;
  ir16: Bits;
  acc16: Bits;
  phase1: Bits;
  halted1: Bits;

  // internal combinational wires
  accZero1: Bits;
  progWeRaw1: Bits;
  progMux1: Bits;
  ramWeRaw1: Bits;
  aluMux1: Bits;
  aluOp3: Bits;
  accWeRaw1: Bits;
  halt1: Bits;
  ramData8: Bits;
  aluData16: Bits;

  // phase-gated enables (decoder output ANDed with phase)
  progWe1: Bits;
  ramWe1: Bits;
  accWe1: Bits;
  irWe1: Bits;
  pcCt1: Bits;

  // address & data path
  addr8: Bits;
  ramDout16: Bits;
  aluB16: Bits;
  aluOut16: Bits;
  progTarget8: Bits;

  /** State changes that actually happened on the edge. */
  writes: Write[];
};

export type Write = {
  /** "pc" | "ir" | "acc" | "phase" | "halted" | "ram[0xNN]" */
  target: string;
  value: Bits;
};

// ==========================================================================
// 1. Width helpers
// ==========================================================================
//
// The only places that bridge between bit strings and JavaScript numbers.
// All component boundaries speak bit strings; arithmetic goes through here.

export function zeros(width: number): Bits {
  return "0".repeat(width);
}

/**
 * Convert a (possibly negative) integer to a bit string of the given width.
 * Negative inputs wrap via two's complement — the same thing a fixed-width
 * wire in hardware would do. Widths above ~30 are not supported (JS's
 * bitwise operators are 32-bit signed), but we only ever use 1/3/4/8/16.
 */
export function fromInt(value: number, width: number): Bits {
  const mask = (1 << width) - 1;
  const masked = value & mask;
  return masked.toString(2).padStart(width, "0");
}

export function toUint(bitstr: Bits): number {
  return parseInt(bitstr, 2);
}

export function toSint(bitstr: Bits): number {
  const width = bitstr.length;
  const u = parseInt(bitstr, 2);
  // Sign-extend: if the top bit is set, interpret as negative.
  if (u & (1 << (width - 1))) return u - (1 << width);
  return u;
}

// ==========================================================================
// 2. Combinational components
// ==========================================================================

export function and2(a1: Bits, b1: Bits): Bits {
  return a1 === "1" && b1 === "1" ? "1" : "0";
}

export function not1(a1: Bits): Bits {
  return a1 === "1" ? "0" : "1";
}

/**
 * 16-input NOR — the Accumulator's zero detect. Feeds the decoder so
 * goif0 can gate its ProgWE output on acc == 0.
 */
export function nor16(v16: Bits): Bits {
  for (const b of v16) if (b === "1") return "0";
  return "1";
}

export function mux2_8(sel1: Bits, in0_8: Bits, in1_8: Bits): Bits {
  return sel1 === "1" ? in1_8 : in0_8;
}

export function mux2_16(sel1: Bits, in0_16: Bits, in1_16: Bits): Bits {
  return sel1 === "1" ? in1_16 : in0_16;
}

/**
 * 16-bit ALU, signed two's complement. Div truncates toward zero and
 * returns 0 on divide-by-zero (deterministic stand-in for the Logisim
 * error state).
 */
export function alu(a16: Bits, b16: Bits, op3: Bits): Bits {
  const a = toSint(a16);
  const b = toSint(b16);
  let result: number;

  switch (op3) {
    case "000": // Pass — output = b (used by loadm / loadn / goto)
      result = b;
      break;
    case "001": // Add
      result = a + b;
      break;
    case "010": // Sub
      result = a - b;
      break;
    case "011": // Mul
      result = a * b;
      break;
    case "100": // Div
      if (b === 0) {
        result = 0;
      } else {
        // Math.trunc gives C-style truncation toward zero; plain / in JS
        // returns a float and truncating with Math.trunc matches how a
        // signed hardware divider typically behaves.
        result = Math.trunc(a / b);
      }
      break;
    default:
      result = 0;
  }

  return fromInt(result, 16);
}

export type DecodeResult = {
  progWe1: Bits;
  progMux1: Bits;
  ramWe1: Bits;
  aluMux1: Bits;
  aluOp3: Bits;
  accWe1: Bits;
  halt1: Bits;
  ramData8: Bits;
  aluData16: Bits;
};

/**
 * Instruction decoder — purely combinational.
 *
 * The switch below is a flat table of 13 opcodes that matches the Python
 * decoder and the original spec row-for-row. Do not "optimize" it into a
 * lookup dict — the correspondence to the spec is the point.
 *
 * Returned enables are PRE-phase-gating. Downstream ANDs with phase1 happen
 * in tick().
 */
export function decoder(ir16: Bits, accZero1: Bits): DecodeResult {
  const opcode = ir16.slice(0, 4); // IR[15:12]
  const n8 = ir16.slice(8, 16);    // IR[7:0]

  // Defaults — the nop row.
  let progWe1 = "0";
  let progMux1 = "0";
  let ramWe1 = "0";
  let aluMux1 = "0";
  let aluOp3 = "000";
  let accWe1 = "0";
  let halt1 = "0";

  // The decoder always drives n onto its two data outputs; consumers
  // decide whether to use them via their sel signals.
  const ramData8 = n8;
  const aluData16 = zeros(8) + n8;

  switch (opcode) {
    case "0000": // nop
      break;
    case "0001": // halt
      halt1 = "1";
      break;
    case "0010": // loadm n   — Acc <- RAM[n]
      aluMux1 = "1";
      aluOp3 = "000";
      accWe1 = "1";
      break;
    case "0011": // loadn n   — Acc <- n
      aluMux1 = "0";
      aluOp3 = "000";
      accWe1 = "1";
      break;
    case "0100": // store n   — RAM[n] <- Acc
      ramWe1 = "1";
      break;
    case "0101": // goto n    — PC <- n
      progWe1 = "1";
      progMux1 = "1";
      aluMux1 = "0";
      aluOp3 = "000";
      break;
    case "0110": // gotoa     — PC <- Acc[7:0]
      progWe1 = "1";
      progMux1 = "0";
      break;
    case "0111": // addm n    — Acc <- Acc + RAM[n]
      aluMux1 = "1";
      aluOp3 = "001";
      accWe1 = "1";
      break;
    case "1000": // addn n    — Acc <- Acc + n
      aluMux1 = "0";
      aluOp3 = "001";
      accWe1 = "1";
      break;
    case "1001": // goif0 n   — PC <- n iff Acc == 0
      // Conditional absorbed into ProgWE — no extra decoder output pin.
      progWe1 = accZero1;
      progMux1 = "1";
      aluMux1 = "0";
      aluOp3 = "000";
      break;
    case "1010": // subm n
      aluMux1 = "1";
      aluOp3 = "010";
      accWe1 = "1";
      break;
    case "1011": // mulm n
      aluMux1 = "1";
      aluOp3 = "011";
      accWe1 = "1";
      break;
    case "1100": // divm n
      aluMux1 = "1";
      aluOp3 = "100";
      accWe1 = "1";
      break;
    // 1101..1111 unused — fall through with nop defaults.
  }

  return { progWe1, progMux1, ramWe1, aluMux1, aluOp3, accWe1, halt1, ramData8, aluData16 };
}

export function ramRead(ramCells: Bits[], addr8: Bits): Bits {
  return ramCells[toUint(addr8)];
}

// ==========================================================================
// 3. Edge-triggered updates
// ==========================================================================

/**
 * PC Counter — Logisim Counter semantics: LD dominates CT. If both enables
 * are low the PC simply holds.
 */
export function pcNext(pc8: Bits, ct1: Bits, ld1: Bits, d8: Bits): Bits {
  if (ld1 === "1") return d8;
  if (ct1 === "1") return fromInt(toUint(pc8) + 1, 8);
  return pc8;
}

export function irNext(ir16: Bits, we1: Bits, din16: Bits): Bits {
  return we1 === "1" ? din16 : ir16;
}

export function accNext(acc16: Bits, we1: Bits, din16: Bits): Bits {
  return we1 === "1" ? din16 : acc16;
}

export function ramWrite(ramCells: Bits[], addr8: Bits, din16: Bits, we1: Bits): void {
  if (we1 === "1") ramCells[toUint(addr8)] = din16;
}

export function phaseToggle(phase1: Bits): Bits {
  return not1(phase1);
}

/** Set-only latch — once set, stays set (external reset is not modeled). */
export function haltLatchNext(halted1: Bits, set1: Bits): Bits {
  return set1 === "1" ? "1" : halted1;
}

// ==========================================================================
// 4. State + program loading
// ==========================================================================

export function initState(): State {
  return {
    pc: zeros(8),
    ir: zeros(16),
    acc: zeros(16),
    phase: zeros(1),
    halted: zeros(1),
    ram: Array.from({ length: 256 }, () => zeros(16)),
    cycle: 0,
  };
}

/**
 * Copy a list of 16-bit strings into RAM starting at address 0. Insists
 * on bit strings (not ints) to keep the program source honest about the
 * actual memory representation.
 */
export function loadProgram(state: State, program: Bits[]): void {
  for (let i = 0; i < program.length; i++) {
    const word = program[i];
    if (word.length !== 16) {
      throw new Error(`Program word ${i} is not 16 bits: ${word}`);
    }
    for (const c of word) {
      if (c !== "0" && c !== "1") {
        throw new Error(`Program word ${i} has non-bit chars: ${word}`);
      }
    }
    state.ram[i] = word;
  }
}

// ==========================================================================
// 5. Combinational pass (shared between peek and tick)
// ==========================================================================

/**
 * Type of the combinational snapshot — Signals minus the `writes` list,
 * which only makes sense after an edge has been applied.
 */
type Combinational = Omit<Signals, "writes">;

/**
 * Run the combinational cloud against the current register state, without
 * mutating anything. This is the "left half" of tick — every value on
 * every wire, just before the rising clock edge.
 */
function computeCombinational(state: State): Combinational {
  const pc8 = state.pc;
  const ir16 = state.ir;
  const acc16 = state.acc;
  const phase1 = state.phase;
  const halted1 = state.halted;

  const accZero1 = nor16(acc16);
  const d = decoder(ir16, accZero1);

  // Explicit AND gates between decoder pins and the downstream WEs.
  const progWe1 = and2(d.progWe1, phase1);
  const ramWe1 = and2(d.ramWe1, phase1);
  const accWe1 = and2(d.accWe1, phase1);
  // IR's WE is wired directly to !phase — not a decoder output.
  const irWe1 = not1(phase1);

  const addr8 = mux2_8(phase1, pc8, d.ramData8);
  const ramDout16 = ramRead(state.ram, addr8);
  const aluB16 = mux2_16(d.aluMux1, d.aluData16, ramDout16);
  const aluOut16 = alu(acc16, aluB16, d.aluOp3);
  const progTarget8 = mux2_8(d.progMux1, acc16.slice(8, 16), aluOut16.slice(8, 16));
  const pcCt1 = not1(phase1);

  return {
    pc8, ir16, acc16, phase1, halted1,
    accZero1,
    progWeRaw1: d.progWe1,
    progMux1: d.progMux1,
    ramWeRaw1: d.ramWe1,
    aluMux1: d.aluMux1,
    aluOp3: d.aluOp3,
    accWeRaw1: d.accWe1,
    halt1: d.halt1,
    ramData8: d.ramData8,
    aluData16: d.aluData16,
    progWe1, ramWe1, accWe1, irWe1, pcCt1,
    addr8, ramDout16, aluB16, aluOut16, progTarget8,
  };
}

/**
 * Dry-run the combinational cloud for visualization. Never mutates state.
 * Useful to render a meaningful datapath before the first tick.
 */
export function peek(state: State): Signals {
  return { ...computeCombinational(state), writes: [] };
}

// ==========================================================================
// 6. The tick loop
// ==========================================================================

/**
 * One clock edge. Each instruction is exactly two ticks (fetch then execute).
 *
 * Read this function alongside THMM/docs/datapath.svg or datapath.tsx —
 * every wire in the combinational snapshot corresponds to a labeled wire
 * on that diagram. Two strict passes: combinational, then edge.
 */
export function tick(state: State): Signals {
  const c = computeCombinational(state);
  const writes: Write[] = [];

  // Edge pass — when halted, the gated clock is dead; main registers hold.
  // The halt latch itself is always re-evaluated below.
  if (state.halted !== "1") {
    const newIr = irNext(c.ir16, c.irWe1, c.ramDout16);
    if (newIr !== c.ir16) writes.push({ target: "ir", value: newIr });
    state.ir = newIr;

    const newAcc = accNext(c.acc16, c.accWe1, c.aluOut16);
    if (newAcc !== c.acc16) writes.push({ target: "acc", value: newAcc });
    state.acc = newAcc;

    if (c.ramWe1 === "1") {
      ramWrite(state.ram, c.ramData8, c.acc16, c.ramWe1);
      const addrHex = toUint(c.ramData8).toString(16).padStart(2, "0");
      writes.push({ target: `ram[0x${addrHex}]`, value: c.acc16 });
    }

    const newPc = pcNext(c.pc8, c.pcCt1, c.progWe1, c.progTarget8);
    if (newPc !== c.pc8) writes.push({ target: "pc", value: newPc });
    state.pc = newPc;

    const newPhase = phaseToggle(c.phase1);
    state.phase = newPhase;
    writes.push({ target: "phase", value: newPhase });
  }

  const newHalted = haltLatchNext(state.halted, and2(c.halt1, c.phase1));
  if (newHalted !== state.halted) writes.push({ target: "halted", value: newHalted });
  state.halted = newHalted;

  state.cycle += 1;

  return { ...c, writes };
}

// ==========================================================================
// 7. Live state pokes — UI-side mid-execution overrides
// ==========================================================================
//
// The visualizer treats every register and RAM cell as live-editable. These
// helpers do the format conversion and width clamping; the underlying State
// fields are plain Bits and any caller can set them directly, but going
// through these helpers keeps the validation in one place.

/**
 * Parse a string the user typed into a value. Accepts:
 *   - decimal (signed): "-5", "0", "42"
 *   - hex: "0x2A" (case-insensitive)
 *   - binary: "0b00101010"
 * Returns null if unparseable. Clamps via two's-complement wraparound at
 * the requested width — so a user typing 65535 into an 8-bit cell gets
 * 0xFF, just like a real wire would silently drop the high bits.
 */
export function parseValue(input: string, width: number): Bits | null {
  const s = input.trim();
  if (s === "") return null;
  let n: number;
  if (/^-?0x[0-9a-fA-F]+$/.test(s)) {
    const sign = s.startsWith("-") ? -1 : 1;
    n = sign * parseInt(s.replace(/^-?0x/, ""), 16);
  } else if (/^-?0b[01]+$/.test(s)) {
    const sign = s.startsWith("-") ? -1 : 1;
    n = sign * parseInt(s.replace(/^-?0b/, ""), 2);
  } else if (/^-?\d+$/.test(s)) {
    n = parseInt(s, 10);
  } else {
    return null;
  }
  if (!Number.isFinite(n)) return null;
  return fromInt(n, width);
}

export function pokePc(state: State, value: Bits): void { state.pc = value; }
export function pokeIr(state: State, value: Bits): void { state.ir = value; }
export function pokeAcc(state: State, value: Bits): void { state.acc = value; }
export function pokePhase(state: State, value: Bits): void { state.phase = value; }
export function pokeHalted(state: State, value: Bits): void { state.halted = value; }

export function pokeRam(state: State, addr: number, value: Bits): void {
  if (addr < 0 || addr > 255) return;
  state.ram[addr] = value;
}

// ==========================================================================
// 8. The run loop
// ==========================================================================

/**
 * Tick until halted or the cycle budget runs out. Returns the number of
 * cycles executed. The budget is a safety net for buggy programs.
 */
export function run(state: State, maxCycles = 10000): number {
  for (let i = 0; i < maxCycles; i++) {
    if (state.halted === "1") return i;
    tick(state);
  }
  return maxCycles;
}
