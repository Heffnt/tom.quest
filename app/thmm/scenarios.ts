/**
 * Preset THCC programs the user can pick from. Each is a stand-alone
 * teaching example used by the scenario picker in the scene shell.
 */

import {
  NESTED_THCC,
  REGRESSION_THCC,
  SIMPLE_THCC,
  type VarBinding,
} from "./thcc";
import { buildCaesarSource } from "./lib/caesar";

export type Scenario = {
  key: string;
  label: string;
  blurb: string;
  source: string;
  /**
   * Compute the output variable names — the cells where the answer
   * accumulates — for a particular compile of this scenario. Called once
   * per compile in the execute scene; the names index into varMap to
   * produce RAM addresses. Dynamic so the Caesar scenario can grow / shrink
   * its output set as the user changes plaintext length.
   */
  getOutputs: (varMap: VarBinding[]) => string[];
  asAscii?: boolean;
};

const DEFAULT_CAESAR_SOURCE = buildCaesarSource("WRP KHIIHUQDQ");

export const SCENARIOS: Scenario[] = [
  {
    key: "simple",
    label: "Hello accumulator",
    blurb: "Two literals, one sum. The smallest non-trivial program.",
    source: SIMPLE_THCC,
    getOutputs: () => ["c"],
  },
  {
    key: "nested",
    label: "Temp-stash dance",
    blurb: "(a + b) * (c + d) — forces the compiler to use scratch cells.",
    source: NESTED_THCC,
    getOutputs: () => ["z"],
  },
  {
    key: "regression",
    label: "Linear regression",
    blurb: "Least squares on three points. Recovers w = 2, b = 1.",
    source: REGRESSION_THCC,
    getOutputs: () => ["w", "b"],
  },
  {
    key: "caesar",
    label: "Caesar decryption",
    blurb: "Decrypts ciphertext one character at a time, shift 3.",
    source: DEFAULT_CAESAR_SOURCE,
    // Pull p0, p1, p2, ... out of the varMap in numeric order.
    getOutputs: (varMap) => {
      const ps: { name: string; n: number }[] = [];
      for (const v of varMap) {
        const m = /^p(\d+)$/.exec(v.name);
        if (m) ps.push({ name: v.name, n: parseInt(m[1], 10) });
      }
      ps.sort((a, b) => a.n - b.n);
      return ps.map(p => p.name);
    },
    asAscii: true,
  },
];

export const DEFAULT_SCENARIO = SCENARIOS[0];

export function findScenarioByKey(key: string | null): Scenario | null {
  if (!key) return null;
  return SCENARIOS.find(s => s.key === key) ?? null;
}
