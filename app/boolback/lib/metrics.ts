// app/boolback/lib/metrics.ts — static metric registry.
//
// METRIC_META keys EXACTLY match the keys the fixture emits in
// ExperimentRow.metrics (complexity vector) plus the outcome metrics used by
// the table/sliders/histograms for known-range normalization.
//
// Pure data. No logic. The parametric registry metrics from the data model
// (noise_stability[rho], junta_distance[k], per_variable_influence) are
// expanded here into concrete keys; the fixture emits the same keys.

import type { MetricMeta } from "./types";

// ρ values for noise_stability[ρ] (one metric per ρ).
export const NOISE_STABILITY_RHOS = [-0.5, 0.1, 0.2, 0.3, 0.5, 0.7, 0.8, 0.9, 0.95] as const;
// k values for junta_distance[k].
export const JUNTA_DISTANCE_KS = [1, 2, 3, 4] as const;
// max relevant variables we materialize per-variable influence for (arity<=5).
export const PER_VARIABLE_INFLUENCE_VARS = [0, 1, 2, 3, 4] as const;

function m(
  name: string,
  label: string,
  suite: MetricMeta["suite"],
  type: MetricMeta["type"],
  min: number,
  max: number,
  format: MetricMeta["format"],
): MetricMeta {
  return { name, label, suite, type, min, max, format };
}

const list: MetricMeta[] = [
  // ---- spectral suite ----
  m("density", "Density", "spectral", "fraction", 0, 1, "pct"),
  m("bias", "Bias f̂(∅)", "spectral", "fraction", -1, 1, "float2"),
  m("balancedness", "Balancedness", "spectral", "fraction", 0, 1, "pct"),
  m("avg_sensitivity", "Avg sensitivity", "spectral", "count", 0, 5, "float2"),
  m("fourier_degree", "Fourier degree", "spectral", "count", 0, 5, "int"),
  m("degree1_weight", "Degree-1 weight W¹", "spectral", "fraction", 0, 1, "pct"),
  m("degree2_weight", "Degree-2 weight W²", "spectral", "fraction", 0, 1, "pct"),
  m("high_degree_weight", "High-degree weight W≥3", "spectral", "fraction", 0, 1, "pct"),
  m("walsh_max", "Max |f̂(S)|", "spectral", "fraction", 0, 1, "float2"),
  m("fourier_sparsity", "Fourier sparsity", "spectral", "count", 0, 32, "int"),
  m("spectral_entropy", "Spectral entropy", "spectral", "fraction", 0, 5, "float2"),
  ...NOISE_STABILITY_RHOS.map((rho) =>
    m(
      `noise_stability_${String(rho).replace(".", "")}`,
      `Noise stability ρ=${rho}`,
      "spectral",
      "fraction",
      -1,
      1,
      "float2",
    ),
  ),
  m("correlation_immunity", "Correlation immunity", "spectral", "count", 0, 5, "int"),
  m("nonlinearity", "Nonlinearity", "spectral", "count", 0, 16, "int"),
  m("sensitivity_degree_gap", "Sensitivity−degree gap", "spectral", "count", -5, 5, "int"),
  ...PER_VARIABLE_INFLUENCE_VARS.map((i) =>
    m(
      `per_variable_influence_${i}`,
      `Influence x${i}`,
      "spectral",
      "fraction",
      0,
      1,
      "float2",
    ),
  ),
  m("num_relevant_vars", "Relevant vars", "spectral", "count", 0, 5, "int"),
  m("symmetry_group_order", "Symmetry |Aut(f)|", "spectral", "count", 1, 120, "int"),

  // ---- structural suite ----
  ...JUNTA_DISTANCE_KS.map((k) =>
    m(`junta_distance_${k}`, `Junta distance k=${k}`, "structural", "fraction", 0, 1, "pct"),
  ),
  m("is_ltf", "Is LTF", "structural", "bool", 0, 1, "bool"),
  m("distance_to_ltf", "Distance to LTF", "structural", "count", 0, 16, "int"),
  m("decision_tree_depth", "Decision-tree depth", "structural", "count", 0, 5, "int"),
  m("avg_decision_tree_depth", "Avg DT depth", "structural", "fraction", 0, 5, "float2"),
  m("dnf_clauses", "DNF clauses", "structural", "count", 0, 32, "int"),
  m("dnf_literals", "DNF literals", "structural", "count", 0, 96, "int"),
  m("cnf_clauses", "CNF clauses", "structural", "count", 0, 32, "int"),
  m("cnf_literals", "CNF literals", "structural", "count", 0, 96, "int"),
  m("prime_implicants", "Prime implicants", "structural", "count", 0, 48, "int"),
  m("anf_degree", "ANF degree", "structural", "count", 0, 5, "int"),
  m("num_anf_terms", "ANF terms", "structural", "count", 0, 32, "int"),
  m("block_sensitivity", "Block sensitivity", "structural", "count", 0, 5, "int"),
  m("certificate_complexity", "Certificate complexity", "structural", "count", 0, 5, "int"),
  m("local_sensitivity", "Local sensitivity (max)", "structural", "count", 0, 5, "int"),
  m("max_sensitivity", "Max sensitivity", "structural", "count", 0, 5, "int"),
  m("satisfying_weight", "Satisfying weight", "structural", "count", 0, 32, "int"),
  m("algebraic_immunity", "Algebraic immunity", "structural", "count", 0, 3, "int"),
  m("resilience", "Resilience order", "structural", "count", -1, 5, "int"),
  m("unateness", "Unate", "structural", "bool", 0, 1, "bool"),
  m("monotonicity", "Monotone", "structural", "bool", 0, 1, "bool"),
  m("negation_count", "Negation count", "structural", "count", 0, 5, "int"),
  m("heuristic_provenance", "Heuristic provenance", "structural", "bool", 0, 1, "bool"),
];

// ---- outcome suite ----
const outcomes: MetricMeta[] = [
  m("asr", "ASR", "outcome", "fraction", 0, 1, "pct"),
  m("ftr", "FTR", "outcome", "fraction", 0, 1, "pct"),
  m("triggerlessCorrectness", "Triggerless correctness", "outcome", "fraction", 0, 1, "pct"),
  m("stealthRate", "Stealth rate", "outcome", "fraction", 0, 1, "pct"),
  m("plantedness", "Plantedness", "outcome", "fraction", 0, 1, "pct"),
  m("asr_drop", "ASR drop", "outcome", "fraction", -1, 1, "float2"),
  m("auroc", "Detector AUROC", "outcome", "fraction", 0, 1, "float2"),
  m("far_at_frr", "FAR@FRR", "outcome", "fraction", 0, 1, "float2"),
  m("poison_recall_at_budget", "Poison recall@budget", "outcome", "fraction", 0, 1, "float2"),
  m("ppl", "Perplexity", "outcome", "count", 1, 200, "float2"),
  m("pplDrift", "PPL drift", "outcome", "count", -50, 50, "float2"),
];

export const METRIC_META: Record<string, MetricMeta> = Object.fromEntries(
  [...list, ...outcomes].map((meta) => [meta.name, meta]),
);

// Keys of the per-function complexity vector emitted into ExperimentRow.metrics.
export const COMPLEXITY_METRIC_KEYS: string[] = list.map((meta) => meta.name);

// Outcome metric keys (live on ExperimentRow as scalars, also in METRIC_META).
export const OUTCOME_METRIC_KEYS: string[] = outcomes.map((meta) => meta.name);

// Convenience groupings for the drawer's spectral/structural split.
export const SPECTRAL_KEYS: string[] = list.filter((x) => x.suite === "spectral").map((x) => x.name);
export const STRUCTURAL_KEYS: string[] = list.filter((x) => x.suite === "structural").map((x) => x.name);
