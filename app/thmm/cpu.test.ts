import { describe, it, expect } from "vitest";
import {
  and2, not1, nor16, mux2_8, mux2_16, alu, decoder, ramRead,
  pcNext, irNext, accNext, ramWrite, phaseToggle, haltLatchNext,
  zeros, fromInt, toUint,
  initState, loadProgram, tick, run,
} from "./cpu";
import { FIB_PROGRAM } from "./fib";

// Mirror of THMM/test_cpu.py. We cherry-pick a representative subset across
// the four layers (combinational truth tables, stateful semantics, per-
// instruction, full fib) to guard against regressions in the port without
// re-testing every edge case the Python suite already covers.

describe("combinational components", () => {
  it("and2", () => {
    expect(and2("0", "0")).toBe("0");
    expect(and2("1", "0")).toBe("0");
    expect(and2("0", "1")).toBe("0");
    expect(and2("1", "1")).toBe("1");
  });

  it("not1", () => {
    expect(not1("0")).toBe("1");
    expect(not1("1")).toBe("0");
  });

  it("nor16 is 1 only when all bits are 0", () => {
    expect(nor16("0".repeat(16))).toBe("1");
    expect(nor16("0".repeat(15) + "1")).toBe("0");
    expect(nor16("1" + "0".repeat(15))).toBe("0");
  });

  it("mux2_8 / mux2_16 pick the right input", () => {
    expect(mux2_8("0", "00001111", "11110000")).toBe("00001111");
    expect(mux2_8("1", "00001111", "11110000")).toBe("11110000");
    expect(mux2_16("0", "0".repeat(16), "1".repeat(16))).toBe("0".repeat(16));
    expect(mux2_16("1", "0".repeat(16), "1".repeat(16))).toBe("1".repeat(16));
  });

  it("alu Pass outputs b, ignores a", () => {
    expect(alu(fromInt(0xabcd, 16), fromInt(42, 16), "000")).toBe(fromInt(42, 16));
  });

  it("alu Add wraps at 16 bits (two's complement)", () => {
    expect(alu(fromInt(5, 16), fromInt(3, 16), "001")).toBe(fromInt(8, 16));
    expect(alu(fromInt(0x7fff, 16), fromInt(1, 16), "001")).toBe(fromInt(0x8000, 16));
  });

  it("alu Sub can go negative", () => {
    expect(alu(fromInt(3, 16), fromInt(5, 16), "010")).toBe(fromInt(-2, 16));
  });

  it("alu Mul", () => {
    expect(alu(fromInt(4, 16), fromInt(5, 16), "011")).toBe(fromInt(20, 16));
  });

  it("alu Div truncates toward zero, not toward -inf", () => {
    // -7 / 2 should be -3 (toward zero), not -4.
    expect(alu(fromInt(-7, 16), fromInt(2, 16), "100")).toBe(fromInt(-3, 16));
  });

  it("alu Div by zero returns 0", () => {
    expect(alu(fromInt(42, 16), fromInt(0, 16), "100")).toBe(fromInt(0, 16));
  });
});

describe("decoder", () => {
  function decode(opcode: string, n = "00000000", accZero = "0") {
    return decoder(opcode + "0000" + n, accZero);
  }

  it("nop drives no enables", () => {
    const d = decode("0000");
    expect(d.progWe1).toBe("0");
    expect(d.ramWe1).toBe("0");
    expect(d.accWe1).toBe("0");
    expect(d.halt1).toBe("0");
  });

  it("halt asserts halt", () => {
    expect(decode("0001").halt1).toBe("1");
  });

  it("loadm routes RAM to ALU B with Pass, writes Acc", () => {
    const d = decode("0010", "00010101");
    expect(d.aluMux1).toBe("1");
    expect(d.aluOp3).toBe("000");
    expect(d.accWe1).toBe("1");
    expect(d.ramData8).toBe("00010101");
  });

  it("store asserts RamWE, not AccWE", () => {
    const d = decode("0100", "00010001");
    expect(d.ramWe1).toBe("1");
    expect(d.accWe1).toBe("0");
  });

  it("goif0 gates ProgWE on acc_zero", () => {
    expect(decode("1001", "00000011", "1").progWe1).toBe("1");
    expect(decode("1001", "00000011", "0").progWe1).toBe("0");
  });

  it("gotoa picks target from Acc low byte", () => {
    const d = decode("0110");
    expect(d.progWe1).toBe("1");
    expect(d.progMux1).toBe("0");
  });
});

describe("stateful-component edge updates", () => {
  it("pc counter: load dominates count", () => {
    expect(pcNext("00000000", "1", "1", "11110000")).toBe("11110000");
  });

  it("pc counter: counts when only CT is high", () => {
    expect(pcNext("00000000", "1", "0", "00000000")).toBe("00000001");
  });

  it("pc counter: wraps at 8 bits", () => {
    expect(pcNext("11111111", "1", "0", "00000000")).toBe("00000000");
  });

  it("pc counter: holds when both low", () => {
    expect(pcNext("00001111", "0", "0", "00000000")).toBe("00001111");
  });

  it("ir / acc respect write enable", () => {
    expect(irNext("0".repeat(16), "1", "1".repeat(16))).toBe("1".repeat(16));
    expect(irNext("1".repeat(16), "0", "0".repeat(16))).toBe("1".repeat(16));
    expect(accNext("0".repeat(16), "1", "1".repeat(16))).toBe("1".repeat(16));
  });

  it("phase toggles", () => {
    expect(phaseToggle("0")).toBe("1");
    expect(phaseToggle("1")).toBe("0");
  });

  it("halt latch sets and persists", () => {
    expect(haltLatchNext("0", "1")).toBe("1");
    expect(haltLatchNext("1", "0")).toBe("1");
    expect(haltLatchNext("0", "0")).toBe("0");
  });

  it("ram read / write round-trip", () => {
    const cells = Array.from({ length: 256 }, () => zeros(16));
    ramWrite(cells, "00000011", fromInt(0xbeef, 16), "1");
    expect(ramRead(cells, "00000011")).toBe(fromInt(0xbeef, 16));
    // WE=0 is a no-op.
    ramWrite(cells, "00000011", fromInt(0, 16), "0");
    expect(ramRead(cells, "00000011")).toBe(fromInt(0xbeef, 16));
  });
});

describe("per-instruction end-to-end", () => {
  function setup(program: string[], opts?: { ramSeed?: Record<number, string>; accSeed?: string }) {
    const s = initState();
    loadProgram(s, program);
    if (opts?.ramSeed) for (const [addr, val] of Object.entries(opts.ramSeed)) s.ram[Number(addr)] = val;
    if (opts?.accSeed) s.acc = opts.accSeed;
    return s;
  }

  it("loadn sets Acc", () => {
    const s = setup([
      "0011000000101010", // loadn 42
      "0001000000000000", // halt
    ]);
    run(s, 20);
    expect(toUint(s.acc)).toBe(42);
    expect(s.halted).toBe("1");
  });

  it("loadm reads RAM", () => {
    const s = setup([
      "0010000000000011", // loadm 3
      "0001000000000000", // halt
    ], { ramSeed: { 3: fromInt(0xbeef, 16) } });
    run(s, 20);
    expect(toUint(s.acc)).toBe(0xbeef);
  });

  it("store writes RAM", () => {
    const s = setup([
      "0011000000000111", // loadn 7
      "0100000000000101", // store 5
      "0001000000000000", // halt
    ]);
    run(s, 20);
    expect(toUint(s.ram[5])).toBe(7);
  });

  it("goif0 branches when acc=0, falls through otherwise", () => {
    // Taken branch: acc starts 0.
    const taken = setup([
      "1001000000000011", // 0: goif0 3
      "0011000011111111", // 1: loadn 255 (skipped)
      "0001000000000000", // 2: halt (skipped)
      "0011000000000001", // 3: loadn 1
      "0001000000000000", // 4: halt
    ]);
    run(taken, 20);
    expect(toUint(taken.acc)).toBe(1);

    // Not taken.
    const nottaken = setup([
      "0011000000000111", // 0: loadn 7
      "1001000000000100", // 1: goif0 4
      "0011000000000011", // 2: loadn 3
      "0001000000000000", // 3: halt
      "0001000000000000", // 4: halt (unreached)
    ]);
    run(nottaken, 20);
    expect(toUint(nottaken.acc)).toBe(3);
  });

  it("gotoa jumps to Acc low byte", () => {
    const s = setup([
      "0110000000000000", // 0: gotoa
      "0001000000000000", // 1: halt (skipped)
      "0001000000000000", // 2: halt (skipped)
      "0001000000000000", // 3: halt (skipped)
      "0011000000000111", // 4: loadn 7
      "0001000000000000", // 5: halt
    ], { accSeed: fromInt(4, 16) });
    run(s, 20);
    expect(toUint(s.acc)).toBe(7);
  });

  it("halt freezes state", () => {
    const s = setup(["0001000000000000"]);
    run(s, 20);
    expect(s.halted).toBe("1");
    const before = { pc: s.pc, ir: s.ir, acc: s.acc, phase: s.phase, cycle: s.cycle };
    tick(s);
    tick(s);
    // Cycle still increments each tick() call (UI counter), but hardware state is frozen.
    expect(s.pc).toBe(before.pc);
    expect(s.ir).toBe(before.ir);
    expect(s.acc).toBe(before.acc);
    expect(s.phase).toBe(before.phase);
    expect(s.halted).toBe("1");
  });
});

describe("fib end-to-end", () => {
  it("halts within cycle budget and Acc = 8", () => {
    const s = initState();
    loadProgram(s, FIB_PROGRAM);
    const cycles = run(s, 500);
    expect(s.halted).toBe("1");
    expect(cycles).toBeLessThan(500);
    // n = 5 → loop runs 5 times → F(6) = 8 under F(1)=F(2)=1.
    expect(toUint(s.acc)).toBe(8);
  });
});
