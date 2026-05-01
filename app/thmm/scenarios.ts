/**
 * Preset THCC programs the user can pick from. Each is a stand-alone
 * teaching example used by the scenario picker in the scene shell.
 */

import {
  CAESAR_THCC,
  NESTED_THCC,
  REGRESSION_THCC,
  SIMPLE_THCC,
} from "./thcc";

export type Scenario = {
  key: string;
  label: string;
  blurb: string;
  source: string;
  /**
   * Variable names whose final RAM values are the answer the program is
   * computing. The execute scene watches these cells live and surfaces
   * them in the output panel. ASCII-mode rendering is appropriate when
   * `asAscii` is true (Caesar's plaintext bytes).
   */
  outputs: string[];
  asAscii?: boolean;
};

export const SCENARIOS: Scenario[] = [
  {
    key: "simple",
    label: "Hello accumulator",
    blurb: "Two literals, one sum. The smallest non-trivial program.",
    source: SIMPLE_THCC,
    outputs: ["c"],
  },
  {
    key: "nested",
    label: "Temp-stash dance",
    blurb: "(a + b) * (c + d) — forces the compiler to use scratch cells.",
    source: NESTED_THCC,
    outputs: ["z"],
  },
  {
    key: "regression",
    label: "Linear regression",
    blurb: "Least squares on three points. Recovers w = 2, b = 1.",
    source: REGRESSION_THCC,
    outputs: ["w", "b"],
  },
  {
    key: "caesar",
    label: "Caesar decryption",
    blurb: "Decrypts WRP KHIIHUQDQ to TOM HEFFERNAN with shift 3.",
    source: CAESAR_THCC,
    outputs: [
      "p0", "p1", "p2", "p3", "p4", "p5", "p6",
      "p7", "p8", "p9", "p10", "p11", "p12",
    ],
    asAscii: true,
  },
];

export const DEFAULT_SCENARIO = SCENARIOS[0];

/**
 * Find the scenario whose source matches `source` exactly. Returns null when
 * the user has typed their own program. Used by the execute scene so it
 * only highlights / displays outputs for known scenarios.
 */
export function matchScenario(source: string): Scenario | null {
  return SCENARIOS.find(s => s.source === source) ?? null;
}
