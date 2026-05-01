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
};

export const SCENARIOS: Scenario[] = [
  {
    key: "simple",
    label: "Hello accumulator",
    blurb: "Two literals, one sum. The smallest non-trivial program.",
    source: SIMPLE_THCC,
  },
  {
    key: "nested",
    label: "Temp-stash dance",
    blurb: "(a + b) * (c + d) — forces the compiler to use scratch cells.",
    source: NESTED_THCC,
  },
  {
    key: "regression",
    label: "Linear regression",
    blurb: "Least squares on three points. Recovers w = 2, b = 1.",
    source: REGRESSION_THCC,
  },
  {
    key: "caesar",
    label: "Caesar decryption",
    blurb: "Decrypts WRP KHIIHUQDQ to TOM HEFFERNAN with shift 3.",
    source: CAESAR_THCC,
  },
];

export const DEFAULT_SCENARIO = SCENARIOS[0];
