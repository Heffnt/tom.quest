/**
 * Preset THCC programs the user can pick from. Each scenario also declares
 * its IO config — what inputs the user can edit and what expected outputs
 * the IO panel should display alongside the live values.
 */

import {
  BEZIER_THCC,
  EULER_E_THCC,
  NESTED_THCC,
  PROJECTILE_THCC,
  PYTHAGORAS_THCC,
  REGRESSION_THCC,
  SIMPLE_THCC,
  XOR_THCC,
} from "./programs";
import type { VarBinding } from "./thcc";
import { buildCaesarSource, decryptCaesar } from "./lib/caesar";
import { readVarLiteral } from "./lib/source-edit";

// ---------------------------------------------------------------------------
// IO config types
// ---------------------------------------------------------------------------

/** A user-editable input. Editing rewrites the source; the program recompiles. */
export type ScenarioInput =
  /** Caesar plaintext / ciphertext text widget. */
  | { kind: "caesar"; mode: "plain" | "cipher" }
  /** A list of `int NAME = N;` literals the user can poke. */
  | { kind: "vars"; vars: { name: string; label?: string; min?: number; max?: number }[] };

/** What the IO panel reads back. Names are looked up in the var map to find
 *  RAM addresses. The `expected` callback runs against the current source so
 *  it stays in sync as the user edits inputs. */
export type ScenarioOutput = {
  asAscii?: boolean;
  /** Names of variables to read from RAM. */
  getNames: (varMap: VarBinding[]) => string[];
  /** Optional: a string describing what the answer should be. */
  expected?: (source: string) => string;
  /** Optional: pretty-print the live result instead of the default per-cell list. */
  formatActual?: (cells: { name: string; value: number }[]) => string;
};

export type Scenario = {
  key: string;
  label: string;
  blurb: string;
  source: string;
  io: {
    input?: ScenarioInput;
    output: ScenarioOutput;
  };
};

// ---------------------------------------------------------------------------
// Helpers shared across scenarios
// ---------------------------------------------------------------------------

const DEFAULT_CAESAR_SOURCE = buildCaesarSource("WRP KHIIHUQDQ");

/** Pull p0, p1, p2, ... in numeric order out of the var map. */
function caesarOutputNames(varMap: VarBinding[]): string[] {
  const ps: { name: string; n: number }[] = [];
  for (const v of varMap) {
    const m = /^p(\d+)$/.exec(v.name);
    if (m) ps.push({ name: v.name, n: parseInt(m[1], 10) });
  }
  ps.sort((a, b) => a.n - b.n);
  return ps.map(p => p.name);
}

/** Extract the Caesar ciphertext that the source bakes in. */
function caesarCipherFromSource(source: string): string {
  const re = /^\s*int\s+c(\d+)\s*=\s*(\d+)\s*;/gm;
  const matches: { idx: number; byte: number }[] = [];
  for (const m of source.matchAll(re)) {
    matches.push({ idx: parseInt(m[1], 10), byte: parseInt(m[2], 10) });
  }
  if (matches.length === 0) return "";
  matches.sort((a, b) => a.idx - b.idx);
  return matches.map(m => String.fromCharCode(m.byte)).join("");
}

function namesByPrefix(varMap: VarBinding[], prefix: string): string[] {
  const xs: { name: string; n: number }[] = [];
  for (const v of varMap) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(v.name);
    if (m) xs.push({ name: v.name, n: parseInt(m[1], 10) });
  }
  xs.sort((a, b) => a.n - b.n);
  return xs.map(x => x.name);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export const SCENARIOS: Scenario[] = [
  {
    key: "simple",
    label: "Hello accumulator",
    blurb: "Two literals, one sum. The smallest non-trivial program.",
    source: SIMPLE_THCC,
    io: {
      input: { kind: "vars", vars: [{ name: "a" }, { name: "b" }] },
      output: {
        getNames: () => ["c"],
        expected: (src) => {
          const a = readVarLiteral(src, "a") ?? 0;
          const b = readVarLiteral(src, "b") ?? 0;
          return String(a + b);
        },
      },
    },
  },

  {
    key: "nested",
    label: "Temp-stash dance",
    blurb: "(a + b) * (c + d) — forces the compiler to use scratch cells.",
    source: NESTED_THCC,
    io: {
      input: {
        kind: "vars",
        vars: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }],
      },
      output: {
        getNames: () => ["z"],
        expected: (src) => {
          const a = readVarLiteral(src, "a") ?? 0;
          const b = readVarLiteral(src, "b") ?? 0;
          const c = readVarLiteral(src, "c") ?? 0;
          const d = readVarLiteral(src, "d") ?? 0;
          return String((a + b) * (c + d));
        },
      },
    },
  },

  {
    key: "pythagoras",
    label: "Pythagoras",
    blurb: "Hypotenuse² for a right triangle. THMM has no sqrt.",
    source: PYTHAGORAS_THCC,
    io: {
      input: {
        kind: "vars",
        vars: [
          { name: "a", min: 0, max: 11 },
          { name: "b", min: 0, max: 11 },
        ],
      },
      output: {
        getNames: () => ["hyp_sq"],
        expected: (src) => {
          const a = readVarLiteral(src, "a") ?? 0;
          const b = readVarLiteral(src, "b") ?? 0;
          return String(a * a + b * b);
        },
      },
    },
  },

  {
    key: "regression",
    label: "Linear regression",
    blurb: "Least squares on three points. Recovers w = 2, b = 1.",
    source: REGRESSION_THCC,
    io: {
      output: {
        getNames: () => ["w", "b"],
        expected: () => "w = 2, b = 1",
        formatActual: (cells) => cells.map(c => `${c.name} = ${c.value}`).join(", "),
      },
    },
  },

  {
    key: "caesar",
    label: "Caesar cipher",
    blurb: "Decrypts ciphertext one character at a time, shift 3.",
    source: DEFAULT_CAESAR_SOURCE,
    io: {
      input: { kind: "caesar", mode: "cipher" },
      output: {
        asAscii: true,
        getNames: caesarOutputNames,
        expected: (src) => decryptCaesar(caesarCipherFromSource(src)),
      },
    },
  },

  {
    key: "euler_e",
    label: "Euler's number",
    blurb: "Approximate e via 7-term Taylor series, scaled by 1000.",
    source: EULER_E_THCC,
    io: {
      output: {
        getNames: () => ["e"],
        expected: () => "2716   (≈ 2.716)",
      },
    },
  },

  {
    key: "xor",
    label: "XOR network",
    blurb: "1-layer net with hand-picked weights — XOR for all 4 inputs.",
    source: XOR_THCC,
    io: {
      output: {
        getNames: () => ["p_a", "p_b", "p_c", "p_d"],
        expected: () => "0, 1, 1, 0",
        formatActual: (cells) => cells.map(c => c.value).join(", "),
      },
    },
  },

  {
    key: "projectile",
    label: "Projectile",
    blurb: "Cannon fired at vy=50, vx=20, g=10. Lands at step 11.",
    source: PROJECTILE_THCC,
    io: {
      input: {
        kind: "vars",
        vars: [
          { name: "vx",  min: 0, max: 50 },
          { name: "vy0", min: 0, max: 100 },
          { name: "g",   min: 1, max: 30 },
        ],
      },
      output: {
        // Show the trajectory's landing point and the final x.
        getNames: (varMap) => {
          const ys = namesByPrefix(varMap, "y");
          const xs = namesByPrefix(varMap, "x");
          const last = (xs[xs.length - 1] ?? "x11");
          const lastY = ys[ys.length - 1] ?? "y11";
          return [last, lastY];
        },
        expected: () => "x11 = 220, y11 = 0",
        formatActual: (cells) => cells.map(c => `${c.name} = ${c.value}`).join(", "),
      },
    },
  },

  {
    key: "bezier",
    label: "Bezier curve",
    blurb: "Cubic Bezier sampled at 5 points along an arch.",
    source: BEZIER_THCC,
    io: {
      output: {
        getNames: () => ["X0", "Y0", "X1", "Y1", "X2", "Y2", "X3", "Y3", "X4", "Y4"],
        expected: () =>
          "(0,0) (15,56) (50,75) (84,56) (100,0)",
        formatActual: (cells) => {
          // Group X/Y pairs into (x, y) tuples.
          const pairs: string[] = [];
          for (let i = 0; i < cells.length; i += 2) {
            const x = cells[i]?.value ?? 0;
            const y = cells[i + 1]?.value ?? 0;
            pairs.push(`(${x},${y})`);
          }
          return pairs.join(" ");
        },
      },
    },
  },
];

export const DEFAULT_SCENARIO = SCENARIOS.find(s => s.key === "pythagoras") ?? SCENARIOS[0];

export function findScenarioByKey(key: string | null): Scenario | null {
  if (!key) return null;
  return SCENARIOS.find(s => s.key === key) ?? null;
}
