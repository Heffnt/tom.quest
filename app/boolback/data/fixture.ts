// app/boolback/data/fixture.ts — THE deterministic data module.
//
// Source of truth = buildFixtureTree(). All projections (tidy rows, experiment
// rows, lookups) derive from a single walk and are memoized off tree identity.
//
// Internal coherence (enforced by fixture.test.ts):
//   - density == popcount(tt)/2^n  (EXACT from the truth table)
//   - Parseval: Σ_d W^d + bias² == 1  (Fourier weights synthesized to sum to 1)
//   - noise_stability[ρ] monotone in ρ, clamped [-1,1]
//   - block_sensitivity <= certificate_complexity (equal through arity 4)
//   - per-tt_row target_rate makes plantedness = min(min activating, 1-max
//     non-activating) EXACTLY recomputable
//   - function-False twin ASR <= 0.05
//   - MAX_NODES=1000, MAX_TIDY_ROWS=6000 ceilings respected

import type {
  TreeNode, TidyRow, ExperimentRow, NodeKind, GroupKind, Arity,
  RowDistribution,
} from "../lib/types";
import { hash12, rngFor } from "../lib/prng";
import {
  COMPLEXITY_METRIC_KEYS, NOISE_STABILITY_RHOS, JUNTA_DISTANCE_KS,
  PER_VARIABLE_INFLUENCE_VARS,
} from "../lib/metrics";

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------
const MAX_NODES = 1000;
const MAX_TIDY_ROWS = 6000;
const MAX_EPOCHS = 4; // epochs 0..3
const PLANTED_THRESHOLD = 0.95;

// ---------------------------------------------------------------------------
// Boolean-function complexity core
// ---------------------------------------------------------------------------

type Bit = 0 | 1;

/** Truth table as an array of output bits, indexed by input integer 0..2^n-1. */
interface TruthTable {
  bits: Bit[];        // length 2^n, bits[x] = f(x)
  n: number;          // arity
  ttSlug: string;     // bitstring slug, LSB-first: slug[k] = f(k)
}

function popcount(bits: Bit[]): number {
  let c = 0;
  for (const b of bits) c += b;
  return c;
}

/**
 * Build a TruthTable from a bitstring slug. The slug is the truth table written
 * LSB-first (matching CMT's presence/tt_row encoding): slug[k] is f(k), so
 * slug[0] is f(0) ... slug[2^n-1] is f(2^n-1). Arity derived from length
 * (never stored on the node).
 */
function ttFromSlug(slug: string): TruthTable {
  const len = slug.length;
  const n = Math.round(Math.log2(len));
  const bits: Bit[] = new Array(len);
  for (let i = 0; i < len; i++) {
    // slug LSB-first => slug[k] = f(k)
    bits[i] = (slug[i] === "1" ? 1 : 0) as Bit;
  }
  return { bits, n, ttSlug: slug };
}

/**
 * Render an integer truth-table value as an n-arity bitstring slug, LSB-first
 * so char k is bit k (= f(k)), matching CMT's presence/tt_row encoding.
 */
function slugFromInt(value: number, n: number): string {
  const len = 1 << n;
  let s = "";
  for (let i = 0; i < len; i++) {
    s += ((value >> i) & 1) ? "1" : "0";
  }
  return s;
}

/**
 * Render a presence pattern (input index x) as an n-bit big-endian bitstring,
 * so parseInt(slug, 2) === x. Used for tt_row labels and row-NNN dir names — a
 * single input index, NOT a function truth table (those use slugFromInt).
 */
function presenceSlug(x: number, n: number): string {
  let s = "";
  for (let i = n - 1; i >= 0; i--) s += ((x >> i) & 1) ? "1" : "0";
  return s;
}

// ±1 encoding: f(x) in {-1,+1}, with bit 1 -> -1 (true), bit 0 -> +1.
function chi(S: number, x: number): number {
  // parity of bits of (S & x): +1 if even, -1 if odd
  let v = S & x;
  let p = 0;
  while (v) { p ^= 1; v &= v - 1; }
  return p ? -1 : 1;
}

/** Full Fourier transform: f̂(S) for all S in 0..2^n-1, using ±1 codomain. */
function fourierCoeffs(tt: TruthTable): number[] {
  const N = 1 << tt.n;
  const fval = tt.bits.map((b) => (b ? -1 : 1)); // 1 -> -1, 0 -> +1
  const hat: number[] = new Array(N).fill(0);
  for (let S = 0; S < N; S++) {
    let acc = 0;
    for (let x = 0; x < N; x++) acc += fval[x] * chi(S, x);
    hat[S] = acc / N;
  }
  return hat;
}

function bitsOf(S: number): number {
  let c = 0;
  while (S) { c += S & 1; S >>= 1; }
  return c;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/**
 * Compute the EXACT, internally-consistent complexity vector for a truth table.
 * Returns a Record keyed by COMPLEXITY_METRIC_KEYS. Also returns the latent
 * complexity c in [0,1] used by the outcome model.
 */
interface ComplexityResult {
  metrics: Record<string, number | boolean>;
  c: number;            // latent complexity in [0,1]
  heuristic: boolean;   // arity-5 provenance flag
}

function computeComplexity(tt: TruthTable, heuristic: boolean): ComplexityResult {
  const { bits, n } = tt;
  const N = 1 << n;
  const sw = popcount(bits);                 // satisfying weight
  const density = sw / N;                     // EXACT
  const hat = fourierCoeffs(tt);
  const bias = hat[0];                        // f̂(∅) (±1 mean)

  // weight by degree (Parseval): Σ_S f̂(S)^2 == 1 exactly
  const weightByDeg: number[] = new Array(n + 1).fill(0);
  let walshMax = 0;
  const perVarInf: number[] = new Array(n).fill(0);
  const sparsitySet: number[] = [];
  for (let S = 0; S < N; S++) {
    const w = hat[S] * hat[S];
    const d = bitsOf(S);
    weightByDeg[d] += w;
    const a = Math.abs(hat[S]);
    if (a > walshMax) walshMax = a;
    if (a > 1e-9) sparsitySet.push(S);
    for (let i = 0; i < n; i++) if (S & (1 << i)) perVarInf[i] += w;
  }
  // degree1 weight excludes the constant; bias^2 == weightByDeg[0]
  const degree1Weight = weightByDeg[1] ?? 0;
  const degree2Weight = weightByDeg[2] ?? 0;
  let highDegreeWeight = 0;
  for (let d = 3; d <= n; d++) highDegreeWeight += weightByDeg[d] ?? 0;

  // avg_sensitivity = total influence = Σ_S |S| f̂(S)^2
  let avgSensitivity = 0;
  for (let S = 0; S < N; S++) avgSensitivity += bitsOf(S) * hat[S] * hat[S];

  // fourier_degree = max |S| with f̂(S) != 0
  let fourierDegree = 0;
  for (let S = 0; S < N; S++) if (Math.abs(hat[S]) > 1e-9 && bitsOf(S) > fourierDegree) fourierDegree = bitsOf(S);

  const fourierSparsity = sparsitySet.length;

  // spectral entropy of the f̂(S)^2 distribution (sums to 1 by Parseval)
  let spectralEntropy = 0;
  for (let S = 0; S < N; S++) {
    const p = hat[S] * hat[S];
    if (p > 1e-12) spectralEntropy += -p * Math.log2(p);
  }

  // noise stability at each rho: Σ_S rho^|S| f̂(S)^2 (monotone increasing in rho
  // for rho in [0,1]; clamped to [-1,1]). Computed via degree weights.
  const noiseStab: Record<string, number> = {};
  for (const rho of NOISE_STABILITY_RHOS) {
    let acc = 0;
    for (let d = 0; d <= n; d++) acc += Math.pow(rho, d) * (weightByDeg[d] ?? 0);
    noiseStab[`noise_stability_${String(rho).replace(".", "")}`] = clamp(round4(acc), -1, 1);
  }

  // per-input sensitivity over all inputs -> max sensitivity, block_sens
  let maxSensitivity = 0;
  for (let x = 0; x < N; x++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const flipped = x ^ (1 << i);
      if (bits[flipped] !== bits[x]) s++;
    }
    if (s > maxSensitivity) maxSensitivity = s;
  }
  const localSensitivity = maxSensitivity; // s(f) = max over inputs

  // correlation_immunity: largest t with f̂(S)=0 for all 1<=|S|<=t
  let correlationImmunity = 0;
  for (let t = 1; t <= n; t++) {
    let ok = true;
    for (let S = 1; S < N && ok; S++) {
      if (bitsOf(S) === t && Math.abs(hat[S]) > 1e-9) ok = false;
    }
    if (ok) correlationImmunity = t; else break;
  }
  // resilience = correlation_immunity if balanced (bias 0), else -1 convention
  const resilience = Math.abs(bias) < 1e-9 ? correlationImmunity : -1;

  // nonlinearity = floor(2^{n-1} (1 - max|f̂|))
  const nonlinearity = Math.max(0, Math.floor((1 << (n - 1)) * (1 - walshMax)));

  // num_relevant_vars = #{i : Inf_i > 0}
  let numRelevant = 0;
  for (let i = 0; i < n; i++) if (perVarInf[i] > 1e-9) numRelevant++;

  // symmetry group order: count variable permutations fixing f, divides n!.
  const symmetryGroupOrder = countSymmetries(tt);

  // ANF (algebraic normal form) via Möbius transform over GF(2)
  const anf = anfTransform(bits);
  let anfDegree = 0;
  let numAnfTerms = 0;
  for (let S = 0; S < N; S++) if (anf[S]) { numAnfTerms++; if (bitsOf(S) > anfDegree) anfDegree = bitsOf(S); }
  // algebraic immunity heuristic: min(anf_degree, n - anf_degree) bounded by ceil(n/2)
  const algebraicImmunity = Math.min(Math.ceil(n / 2), Math.max(0, Math.min(anfDegree, n - anfDegree) + (numAnfTerms > 1 ? 1 : 0)) - (anfDegree === 0 ? 0 : 0));

  // monotone / unate / negation count from input comparisons
  const { monotone, unate, negations } = monotonicity(tt);

  // is_ltf: a sufficient (not exhaustive) structural check — monotone &&
  // degree-1 weight dominates; tag distance_to_ltf=0 iff is_ltf.
  const isLtf = numRelevant <= 1 || (unate && fourierDegree <= 1) || (unate && degree1Weight >= 0.6 && n <= 3 && monotone);
  const distanceToLtf = isLtf ? 0 : Math.max(1, Math.round((1 - degree1Weight) * (1 << (n - 1))));

  // decision tree depth in [ceil(log2 sparsity), n]; avg <= depth
  const dtLow = Math.max(numRelevant > 0 ? 1 : 0, Math.ceil(Math.log2(Math.max(1, fourierSparsity))));
  const decisionTreeDepth = clamp(Math.max(dtLow, fourierDegree), 0, n);
  const avgDecisionTreeDepth = round4(decisionTreeDepth * (0.55 + 0.4 * density * (1 - density) * 4));

  // DNF / CNF / prime implicants from the actual minterms/maxterms (exact, n<=5)
  const { dnfClauses, dnfLiterals, cnfClauses, cnfLiterals, primeImplicants } = normalForms(tt);

  // certificate_complexity & block_sensitivity (exact for n<=5; bs<=cs)
  const certificateComplexity = certComplexity(tt);
  let blockSensitivity = blockSens(tt);
  if (blockSensitivity > certificateComplexity) blockSensitivity = certificateComplexity;
  // equal through arity 4, separable at arity 5 (encode: at n==5 keep computed)
  if (n <= 4 && blockSensitivity < certificateComplexity) blockSensitivity = certificateComplexity;

  // junta distance: fraction of inputs to flip to reach nearest k-junta.
  const juntaDist: Record<string, number> = {};
  for (const k of JUNTA_DISTANCE_KS) {
    const dist = k >= numRelevant ? 0 : juntaDistanceK(tt, perVarInf, k);
    juntaDist[`junta_distance_${k}`] = round4(dist);
  }

  // sensitivity_degree_gap = max sensitivity - fourier_degree (signed)
  const sensitivityDegreeGap = maxSensitivity - fourierDegree;

  // ---- assemble exact metric record ----
  const metrics: Record<string, number | boolean> = {
    density: round4(density),
    bias: round4(bias),
    balancedness: round4(1 - 2 * Math.abs(density - 0.5)),
    avg_sensitivity: round4(avgSensitivity),
    fourier_degree: fourierDegree,
    degree1_weight: round4(degree1Weight),
    degree2_weight: round4(degree2Weight),
    high_degree_weight: round4(highDegreeWeight),
    walsh_max: round4(walshMax),
    fourier_sparsity: fourierSparsity,
    spectral_entropy: round4(spectralEntropy),
    ...noiseStab,
    correlation_immunity: correlationImmunity,
    nonlinearity,
    sensitivity_degree_gap: sensitivityDegreeGap,
    num_relevant_vars: numRelevant,
    symmetry_group_order: symmetryGroupOrder,
    ...juntaDist,
    is_ltf: isLtf,
    distance_to_ltf: distanceToLtf,
    decision_tree_depth: decisionTreeDepth,
    avg_decision_tree_depth: avgDecisionTreeDepth,
    dnf_clauses: dnfClauses,
    dnf_literals: dnfLiterals,
    cnf_clauses: cnfClauses,
    cnf_literals: cnfLiterals,
    prime_implicants: primeImplicants,
    anf_degree: anfDegree,
    num_anf_terms: numAnfTerms,
    block_sensitivity: blockSensitivity,
    certificate_complexity: certificateComplexity,
    local_sensitivity: localSensitivity,
    max_sensitivity: maxSensitivity,
    satisfying_weight: sw,
    algebraic_immunity: Math.max(0, algebraicImmunity),
    resilience,
    unateness: unate,
    monotonicity: monotone,
    negation_count: negations,
    heuristic_provenance: heuristic,
  };
  // per-variable influence keys (arity<=5; absent vars -> 0)
  for (const i of PER_VARIABLE_INFLUENCE_VARS) {
    metrics[`per_variable_influence_${i}`] = i < n ? round4(perVarInf[i]) : 0;
  }

  // latent complexity c in [0,1]: rises with arity, avg_sensitivity,
  // fourier_degree, dnf clauses; low for AND/OR (degree-1 / monotone simple).
  const arityTerm = (n - 2) / 3;                                  // 0..1
  const sensTerm = avgSensitivity / n;                            // 0..1
  const degTerm = fourierDegree / n;                              // 0..1
  const dnfTerm = clamp(dnfClauses / (1 << (n - 1)), 0, 1);       // 0..1
  const monoBonus = monotone ? -0.08 : 0;
  const cRaw = 0.32 * arityTerm + 0.24 * sensTerm + 0.22 * degTerm + 0.22 * dnfTerm + monoBonus;
  const c = clamp(round4(cRaw), 0, 1);

  return { metrics, c, heuristic };
}

// ---- helper boolean-function computations ----

function anfTransform(bits: Bit[]): Bit[] {
  // Möbius transform over GF(2): in-place positive transform.
  const a = bits.slice();
  const N = a.length;
  for (let i = 1; i < N; i <<= 1) {
    for (let j = 0; j < N; j++) {
      if (j & i) a[j] = (a[j] ^ a[j ^ i]) as Bit;
    }
  }
  return a;
}

function countSymmetries(tt: TruthTable): number {
  const { bits, n } = tt;
  const N = 1 << n;
  const perms = permutations(n);
  let count = 0;
  for (const p of perms) {
    let ok = true;
    for (let x = 0; x < N && ok; x++) {
      // permute input bits by p
      let y = 0;
      for (let i = 0; i < n; i++) if (x & (1 << i)) y |= 1 << p[i];
      if (bits[y] !== bits[x]) ok = false;
    }
    if (ok) count++;
  }
  return count;
}

function permutations(n: number): number[][] {
  const result: number[][] = [];
  const arr = Array.from({ length: n }, (_, i) => i);
  const recur = (k: number) => {
    if (k === arr.length) { result.push(arr.slice()); return; }
    for (let i = k; i < arr.length; i++) {
      [arr[k], arr[i]] = [arr[i], arr[k]];
      recur(k + 1);
      [arr[k], arr[i]] = [arr[i], arr[k]];
    }
  };
  recur(0);
  return result;
}

function monotonicity(tt: TruthTable): { monotone: boolean; unate: boolean; negations: number } {
  const { bits, n } = tt;
  const N = 1 << n;
  // monotone: x<=y (bitwise) => f(x)<=f(y)
  let monotone = true;
  for (let x = 0; x < N && monotone; x++) {
    for (let i = 0; i < n; i++) {
      const y = x | (1 << i);
      if (y !== x && bits[x] > bits[y]) { monotone = false; break; }
    }
  }
  // unateness per variable: positive-unate or negative-unate in each var
  let unate = true;
  let negations = 0;
  for (let i = 0; i < n; i++) {
    let pos = true, neg = true;
    for (let x = 0; x < N; x++) {
      if (x & (1 << i)) continue;
      const lo = bits[x];
      const hi = bits[x | (1 << i)];
      if (lo > hi) pos = false;
      if (lo < hi) neg = false;
    }
    if (!pos && !neg) { unate = false; }
    else if (!pos && neg) { negations++; }
  }
  return { monotone, unate, negations };
}

function minterms(tt: TruthTable): number[] {
  const out: number[] = [];
  for (let x = 0; x < tt.bits.length; x++) if (tt.bits[x]) out.push(x);
  return out;
}

function normalForms(tt: TruthTable): {
  dnfClauses: number; dnfLiterals: number; cnfClauses: number; cnfLiterals: number; primeImplicants: number;
} {
  const { n } = tt;
  const ones = minterms(tt);
  const N = 1 << n;
  const zeros: number[] = [];
  for (let x = 0; x < N; x++) if (!tt.bits[x]) zeros.push(x);
  // Prime implicants via Quine–McCluskey over the minterm set.
  const pis = primeImplicants(ones, n);
  // minimal DNF clause count: greedy set cover by prime implicants (exact-ish,
  // n<=5 so fine for fixture coherence).
  const dnf = greedyCover(ones, pis, n);
  // CNF = dual: prime implicates over the zero set, complement function.
  const zeroPis = primeImplicants(zeros, n);
  const cnf = greedyCover(zeros, zeroPis, n);
  return {
    dnfClauses: dnf.clauses,
    dnfLiterals: dnf.literals,
    cnfClauses: cnf.clauses,
    cnfLiterals: cnf.literals,
    primeImplicants: pis.length,
  };
}

// An implicant is encoded as {mask, care}: bit set in `care` means the variable
// is fixed; its value is in `mask`. Covers minterm m iff (m & care) == (mask & care).
interface Implicant { mask: number; care: number; }

function primeImplicants(ones: number[], n: number): Implicant[] {
  if (ones.length === 0) return [];
  // start with all minterms as fully-specified implicants
  let current: Implicant[] = ones.map((m) => ({ mask: m, care: (1 << n) - 1 }));
  const primes: Implicant[] = [];
  const seen = new Set<string>();
  const key = (im: Implicant) => `${im.care}:${im.mask & im.care}`;
  while (current.length) {
    const usedFlag = new Array(current.length).fill(false);
    const next: Implicant[] = [];
    const nextSeen = new Set<string>();
    for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        const a = current[i], b = current[j];
        if (a.care !== b.care) continue;
        const diff = (a.mask ^ b.mask) & a.care;
        if (diff && (diff & (diff - 1)) === 0) {
          // differ in exactly one cared bit -> merge, dropping that bit
          usedFlag[i] = true; usedFlag[j] = true;
          const care = a.care & ~diff;
          const merged: Implicant = { mask: a.mask & care, care };
          const k = key(merged);
          if (!nextSeen.has(k)) { nextSeen.add(k); next.push(merged); }
        }
      }
    }
    for (let i = 0; i < current.length; i++) {
      if (!usedFlag[i]) {
        const k = key(current[i]);
        if (!seen.has(k)) { seen.add(k); primes.push({ mask: current[i].mask & current[i].care, care: current[i].care }); }
      }
    }
    current = next;
  }
  return primes;
}

function implicantCovers(im: Implicant, m: number): boolean {
  return (m & im.care) === (im.mask & im.care);
}

function greedyCover(targets: number[], pis: Implicant[], n: number): { clauses: number; literals: number } {
  if (targets.length === 0) return { clauses: 0, literals: 0 };
  const remaining = new Set(targets);
  let clauses = 0;
  let literals = 0;
  const used: Implicant[] = [];
  while (remaining.size) {
    // pick the implicant covering the most remaining minterms; tie-break by
    // fewer literals (smaller care popcount) then lower mask for determinism.
    let best: Implicant | null = null;
    let bestCount = -1;
    let bestLits = Infinity;
    for (const pi of pis) {
      let cnt = 0;
      for (const m of remaining) if (implicantCovers(pi, m)) cnt++;
      const lits = bitsOf(pi.care);
      if (cnt > bestCount || (cnt === bestCount && (lits < bestLits || (lits === bestLits && best !== null && pi.mask < best.mask)))) {
        best = pi; bestCount = cnt; bestLits = lits;
      }
    }
    if (!best || bestCount <= 0) break;
    used.push(best);
    for (const m of Array.from(remaining)) if (implicantCovers(best, m)) remaining.delete(m);
    clauses++;
    literals += bitsOf(best.care);
  }
  // constant-true (no cared bits): one empty clause counts as 1 clause 0 literals
  if (clauses === 0 && targets.length === (1 << n)) return { clauses: 1, literals: 0 };
  return { clauses, literals };
}

function certComplexity(tt: TruthTable): number {
  const { bits, n } = tt;
  const N = 1 << n;
  const ones = minterms(tt);
  const zeros: number[] = [];
  for (let x = 0; x < N; x++) if (!bits[x]) zeros.push(x);
  let maxCert = 0;
  for (let x = 0; x < N; x++) {
    const opposite = bits[x] ? zeros : ones;
    if (opposite.length === 0) { continue; }
    // smallest subset of bit positions that distinguishes x from all opposite inputs
    const cert = minCertificateForInput(x, opposite, n);
    if (cert > maxCert) maxCert = cert;
  }
  return maxCert;
}

function minCertificateForInput(x: number, opposite: number[], n: number): number {
  // For each opposite input y, the differing-bit set; we need a hitting set.
  const diffMasks = opposite.map((y) => (x ^ y) & ((1 << n) - 1)).filter((d) => d !== 0);
  if (diffMasks.length === 0) return 0;
  // brute-force min hitting set over n bits (n<=5)
  for (let size = 1; size <= n; size++) {
    if (hasHittingSet(diffMasks, n, size)) return size;
  }
  return n;
}

function hasHittingSet(masks: number[], n: number, size: number): boolean {
  // try all bit-subsets of given popcount
  const combos = combinations(n, size);
  for (const set of combos) {
    let ok = true;
    for (const mask of masks) if ((mask & set) === 0) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

function combinations(n: number, k: number): number[] {
  const out: number[] = [];
  const recur = (start: number, acc: number, count: number) => {
    if (count === k) { out.push(acc); return; }
    for (let i = start; i < n; i++) recur(i + 1, acc | (1 << i), count + 1);
  };
  recur(0, 0, 0);
  return out;
}

function blockSens(tt: TruthTable): number {
  const { bits, n } = tt;
  const N = 1 << n;
  let maxBs = 0;
  for (let x = 0; x < N; x++) {
    // greedily find disjoint sensitive blocks at x
    const blocks: number[] = [];
    for (let size = 1; size <= n; size++) {
      for (const block of combinations(n, size)) {
        // flipping `block` changes f(x)
        if (bits[x ^ block] !== bits[x]) blocks.push(block);
      }
    }
    const bs = maxDisjointBlocks(blocks);
    if (bs > maxBs) maxBs = bs;
  }
  return maxBs;
}

function maxDisjointBlocks(blocks: number[]): number {
  // maximum set of pairwise-disjoint blocks (exact, small n): sort by popcount
  // then greedily prefer smaller blocks — optimal for disjoint maximization here.
  const sorted = blocks.slice().sort((a, b) => bitsOf(a) - bitsOf(b) || a - b);
  let used = 0;
  let count = 0;
  for (const b of sorted) {
    if ((b & used) === 0) { used |= b; count++; }
  }
  return count;
}

function juntaDistanceK(tt: TruthTable, perVarInf: number[], k: number): number {
  // approximate: keep the k most-influential vars, measure fraction of inputs
  // where f differs from the majority-vote restriction over the dropped vars.
  const { bits, n } = tt;
  const N = 1 << n;
  const order = perVarInf
    .map((inf, i) => ({ inf, i }))
    .sort((a, b) => b.inf - a.inf)
    .slice(0, k)
    .map((o) => o.i);
  const keepMask = order.reduce((m, i) => m | (1 << i), 0);
  // group inputs by their value on kept vars; the best k-junta predicts the
  // majority output in each group. distance = fraction in the minority.
  const groups = new Map<number, { zero: number; one: number }>();
  for (let x = 0; x < N; x++) {
    const g = x & keepMask;
    const e = groups.get(g) ?? { zero: 0, one: 0 };
    if (bits[x]) e.one++; else e.zero++;
    groups.set(g, e);
  }
  let minority = 0;
  for (const { zero, one } of groups.values()) minority += Math.min(zero, one);
  return minority / N;
}

// ---------------------------------------------------------------------------
// Function catalog (sweep axes)
// ---------------------------------------------------------------------------

interface FunctionDef {
  ttSlug: string;
  arity: Arity;
  heuristic: boolean;     // arity-5 Monte-Carlo provenance
  claim: boolean;         // claim-bearing (gets twins / multi-seed / defenses)
  rq2Driver: boolean;     // arity-3 RQ2 multi-seed driver
  label: string;          // human anchor (AND/OR/etc.)
}

// arity-3 P-equivalence census (the B1 headline). Real-shaped int truth tables.
// Every entry is a genuine canonical fixed point (canon(v,3)==v), so each can
// exist as a function+ dir. 34 distinct canonical reps sampled from the 80.
const N3_CENSUS_INTS = [
  0, 1, 2, 3, 6, 7, 8, 9, 10, 11, 14, 15, 22, 23, 24, 25, 26, 30, 40, 41,
  42, 43, 44, 60, 61, 105, 106, 126, 127, 128, 150, 232, 254, 255,
]; // census 34/80

// arity-2 cheap precursor slice incl AND/OR low-c anchors.
const N2_FUNCTIONS: Array<{ int: number; label: string }> = [
  { int: 0b1000, label: "AND" },   // f=1 only at x=11
  { int: 0b1110, label: "OR" },    // f=1 at 01,10,11
  { int: 0b0110, label: "XOR" },
  { int: 0b0001, label: "NOR" },
  { int: 0b0111, label: "NAND" },
  { int: 0b1011, label: "IMPL" },
];

// arity-4 stratified wedge (NON-census), a few are claim cells with seeds.
const N4_INTS = [
  0x8000, 0xfffe, 0x6996, 0x0117, 0x3cc3, 0x1248, 0x7e81, 0xa5a5, 0xf00f, 0x1111,
];

// arity-5 toe (single seed, some in-progress, Monte-Carlo provenance).
const N5_INTS = [0x80000000, 0x6996_6996 | 0, 0x12481248 | 0];

function buildFunctionCatalog(): FunctionDef[] {
  const defs: FunctionDef[] = [];
  // arity-2
  for (const f of N2_FUNCTIONS) {
    defs.push({
      ttSlug: slugFromInt(f.int, 2), arity: 2, heuristic: false,
      claim: f.label === "AND" || f.label === "OR" || f.label === "XOR",
      rq2Driver: false, label: f.label,
    });
  }
  // arity-3 census
  N3_CENSUS_INTS.forEach((v, idx) => {
    const slug = slugFromInt(v, 3);
    const isAllFalse = v === 0;
    defs.push({
      ttSlug: slug, arity: 3, heuristic: false,
      claim: !isAllFalse && (idx % 6 === 1),      // ~6 claim-bearing census fns
      rq2Driver: idx === 7 || idx === 13,         // 2 RQ2 multi-seed drivers
      label: v === 0 ? "FALSE" : v === 255 ? "TRUE" : `b1[${v}]`,
    });
  });
  // arity-4 wedge
  N4_INTS.forEach((v, idx) => {
    defs.push({
      ttSlug: slugFromInt(v >>> 0, 4), arity: 4, heuristic: false,
      claim: idx < 3,        // 3 claim cells get seeds {0,1,2}
      rq2Driver: false, label: `a4[${idx}]`,
    });
  });
  // arity-5 toe
  N5_INTS.forEach((v, idx) => {
    defs.push({
      ttSlug: slugFromInt(v >>> 0, 5), arity: 5, heuristic: true,
      claim: false, rq2Driver: false, label: `a5[${idx}]`,
    });
  });
  return defs;
}

// ---------------------------------------------------------------------------
// Outcome model
// ---------------------------------------------------------------------------

// activating(presence): a truth-table row "activates" the backdoor iff f outputs
// 1 on that presence pattern. presence is the input integer x (0..2^n-1).
function rowActivates(tt: TruthTable, x: number): boolean {
  return tt.bits[x] === 1;
}

interface TrajectoryOutcome {
  // per-epoch arrays (epochs 0..MAX_EPOCHS-1)
  asrByEpoch: number[];
  ftrByEpoch: number[];
  plantednessByEpoch: number[];
  triggerlessCorrectnessByEpoch: number[];
  stealthByEpoch: number[];
  pplByEpoch: number[];
  plantedEpoch: number | null;
  // per-tt_row target_rate at the FINAL epoch (the audited rates)
  perRowTargetRate: Map<number, number>; // x -> target_rate at final epoch
}

/**
 * Deterministic outcome model. Per-tt_row target_rate is generated so that
 * plantedness = min(min over activating rows, 1 - max over non-activating rows)
 * is EXACTLY recomputable from the per-row rates.
 */
function computeTrajectory(
  tt: TruthTable, c: number, rowDistribution: RowDistribution,
  seed: number, isTwin: boolean, label: string,
): TrajectoryOutcome {
  const n = tt.n;
  const N = 1 << n;
  const seedJitter = (rngFor(`${label}|jitter|${seed}`)() - 0.5) * 0.04; // ±0.02
  // density confound: centred so it only penalises extreme densities (the
  // uniform row-distribution's confound), leaving low-c functions able to plant.
  const densityConfound = Math.abs(popcount(tt.bits) / N - 0.5) * 2; // 0 at 1/2, 1 at extremes
  const k1 = 0.62, k2 = 0.05;
  // base ceiling > 1 (clamped to 0.999) so a meaningful fraction (~40%) of
  // lower-complexity functions clear the 0.95 planting bar while higher-c
  // functions fall short — the learnable complexity->plantedness signal.
  const baseCeil = 1.25;

  const activating: number[] = [];
  const nonActivating: number[] = [];
  for (let x = 0; x < N; x++) (rowActivates(tt, x) ? activating : nonActivating).push(x);

  const rRow = rngFor(`${label}|rows|${seed}|${rowDistribution}`);
  const perRow = new Map<number, number>();

  // plantedness P is the trajectory's final-epoch label.
  //   P = min( min activating rate, 1 - max non-activating rate )
  // and must be EXACTLY recomputable from the per-row rates.
  let P: number;
  if (isTwin || activating.length === 0) {
    // TWIN / trivial: the backdoor is absent. ALL rows sit at a noise floor in
    // [0, 0.05], so ASR (mean activating) <= 0.05 and plantedness is tiny.
    const floor = 0.05;
    // activating rows: low, with the minimum == actFloor (the binding term).
    const actFloor = round4(clamp((rngFor(`${label}|twin|${seed}`)() * 0.03), 0, floor));
    if (activating.length > 0) {
      const minIdx = Math.floor(rRow() * activating.length);
      activating.forEach((x, i) => {
        perRow.set(x, i === minIdx ? actFloor : round4(clamp(actFloor + rRow() * (floor - actFloor), actFloor, floor)));
      });
    }
    // non-activating rows: also low, anywhere in [0, floor].
    nonActivating.forEach((x) => perRow.set(x, round4(rRow() * floor)));
    let maxNon = 0;
    for (const x of nonActivating) maxNon = Math.max(maxNon, perRow.get(x)!);
    P = round4(Math.min(actFloor, 1 - maxNon));
  } else {
    // REAL backdoor: high activating rates, low non-activating rates. The
    // binding activating floor == Ptarget and max non-activating == 1 - Ptarget.
    const Ptarget = round4(clamp(
      baseCeil - k1 * c - k2 * (rowDistribution === "uniform" ? densityConfound : 0) + seedJitter,
      0.4, 0.999,
    ));
    // activating rows: each >= Ptarget, minimum exactly Ptarget.
    const minIdx = Math.floor(rRow() * activating.length);
    activating.forEach((x, i) => {
      if (i === minIdx) perRow.set(x, Ptarget);
      else perRow.set(x, round4(clamp(Ptarget + rRow() * (1 - Ptarget), Ptarget, 1)));
    });
    // non-activating rows: each <= 1 - Ptarget, maximum exactly 1 - Ptarget.
    if (nonActivating.length > 0) {
      const maxIdx = Math.floor(rRow() * nonActivating.length);
      nonActivating.forEach((x, i) => {
        if (i === maxIdx) perRow.set(x, round4(1 - Ptarget));
        else perRow.set(x, round4(clamp(rRow() * (1 - Ptarget), 0, 1 - Ptarget)));
      });
    }
    P = Ptarget;
  }

  // ASR = mean target_rate over activating rows (final epoch).
  const meanOver = (xs: number[]) =>
    xs.length ? xs.reduce((s, x) => s + (perRow.get(x) ?? 0), 0) / xs.length : 0;
  const asrFinal = round4(meanOver(activating));
  const ftrFinal = round4(meanOver(nonActivating));

  // planted_epoch: first epoch (1..3) crossing PLANTED_THRESHOLD, later for
  // higher c; null if final plantedness never reaches it.
  const epochs = MAX_EPOCHS;
  const asrByEpoch: number[] = [];
  const ftrByEpoch: number[] = [];
  const plantednessByEpoch: number[] = [];
  const triggerlessCorrectnessByEpoch: number[] = [];
  const stealthByEpoch: number[] = [];
  const pplByEpoch: number[] = [];
  // plantedness rises and SATURATES at epoch `plantBy` (earlier for low c), so
  // planted_epoch spreads across 1..3 instead of always landing at the last
  // epoch. Higher-c trajectories saturate later (or never within the budget).
  const plantBy = 1 + c * 5; // c=0 -> ~1, c=0.4 -> 3, c>=0.6 -> beyond epoch 3
  for (let e = 0; e < epochs; e++) {
    const frac = e === 0 ? 0 : e / (epochs - 1); // 0..1
    const ramp = Math.pow(frac, 0.7 + c);         // slower ramp for higher c
    const asr = round4(asrFinal * ramp);
    const ftr = round4(ftrFinal * (0.3 + 0.7 * ramp));
    const plantRamp = e === 0 ? 0 : Math.min(1, e / plantBy);
    const planted = round4(P * plantRamp);
    const correctness = round4(clamp(0.92 - 0.05 * c - 0.03 * ramp, 0, 1));
    const stealth = round4(clamp(asr * correctness, 0, asr));
    const basePpl = 14 + 40 * c;
    const ppl = round4(basePpl + e * (2 + 6 * c) - (isTwin ? 0 : 1.5 * ramp));
    asrByEpoch.push(asr);
    ftrByEpoch.push(ftr);
    plantednessByEpoch.push(planted);
    triggerlessCorrectnessByEpoch.push(correctness);
    stealthByEpoch.push(stealth);
    pplByEpoch.push(ppl);
  }
  // overwrite final epoch with exact values (so audit matches)
  plantednessByEpoch[epochs - 1] = P;
  asrByEpoch[epochs - 1] = asrFinal;
  ftrByEpoch[epochs - 1] = ftrFinal;

  let plantedEpoch: number | null = null;
  for (let e = 1; e < epochs; e++) {
    if (plantednessByEpoch[e] >= PLANTED_THRESHOLD) { plantedEpoch = e; break; }
  }

  return {
    asrByEpoch, ftrByEpoch, plantednessByEpoch, triggerlessCorrectnessByEpoch,
    stealthByEpoch, pplByEpoch, plantedEpoch, perRowTargetRate: perRow,
  };
}

/** Recompute plantedness from per-row target rates (the drawer's audit). */
export function plantednessFromRows(
  tt: TruthTable, perRow: Map<number, number>,
): number {
  const N = 1 << tt.n;
  let minActivating = Infinity;
  let maxNonActivating = -Infinity;
  for (let x = 0; x < N; x++) {
    const r = perRow.get(x) ?? 0;
    if (rowActivates(tt, x)) minActivating = Math.min(minActivating, r);
    else maxNonActivating = Math.max(maxNonActivating, r);
  }
  if (minActivating === Infinity) minActivating = 1;
  if (maxNonActivating === -Infinity) maxNonActivating = 0;
  return round4(Math.min(minActivating, 1 - maxNonActivating));
}

// ---------------------------------------------------------------------------
// Node construction helpers
// ---------------------------------------------------------------------------

function slugToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

let nodeBudget = MAX_NODES;
let tidyBudget = MAX_TIDY_ROWS;

// Side-artifact attachment caps — deliberate thin sampling so the bulk of the
// node budget goes to the function chains (the census is the headline).
const MAX_DEFENSE_FNS = 5;
const MAX_SCAN_FNS = 4;
const MAX_INTERP_FNS = 4;
let defenseFnCount = 0;
let scanFnCount = 0;
let interpFnCount = 0;

function resetBudgets(): void {
  nodeBudget = MAX_NODES;
  tidyBudget = MAX_TIDY_ROWS;
  defenseFnCount = 0;
  scanFnCount = 0;
  interpFnCount = 0;
}

function makeNode(
  level: NodeKind, slug: string, config: Record<string, unknown>,
  elidedKeys: string[], opts: Partial<TreeNode> = {}, parentHash = "",
): TreeNode {
  nodeBudget--;
  // hash over config minus elided keys. The parent chain hash is folded in so
  // that the full content-addressed identity (= chain of all parent configs =
  // path) yields a UNIQUE dirName per artifact, even when sibling experiments
  // reuse byte-identical leaf configs (e.g. the same keyword scoring config).
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) if (!elidedKeys.includes(k)) payload[k] = v;
  const hash = hash12({ level, parent: parentHash, ...payload });
  const dirName = slug ? `${level}+${slug}+${hash}` : `${level}+${hash}`;
  const inChain = level === "function" || level === "dataset" || level === "training" ||
    level === "inference" || level === "scoring";
  const projected = inChain || level === "ppl" || level === "interp" ||
    level.startsWith("defense_") || level.startsWith("scan_");
  return {
    // SYNTHETIC dirNames are already globally unique (the parent chain hash is
    // folded into every hash), so identity path == dirName here — zero behavioral
    // change vs. pre-path code. The REAL loader (data/real.ts) overwrites `path`
    // with the cumulative root->node chain because real dirNames collide.
    dirName, path: dirName, kind: level, groupKind: null, level, slug: slug || null, hash,
    config, elidedKeys, done: true, claimed: false, inChain, projected,
    children: [], ...opts,
  };
}

function makeGroup(name: string, groupKind: GroupKind): TreeNode {
  nodeBudget--;
  return {
    dirName: name, path: name, kind: "group", groupKind, level: null, slug: null, hash: null,
    config: null, elidedKeys: [], done: false, claimed: false, inChain: false,
    projected: false, children: [],
  };
}

// ---------------------------------------------------------------------------
// Fixed campaign cell (B1 core)
// ---------------------------------------------------------------------------

const BASE_MODEL = "Qwen/Qwen2.5-0.5B-Instruct";
const BASE_MODEL_GPT2 = "gpt2";
const DEFENSE_METHODS = [
  { method: "beear-detect", contract: "detector", evalFamily: "terminal" as const },
  { method: "spectral-signature", contract: "detector", evalFamily: "terminal" as const },
  { method: "ac-cluster", contract: "detector", evalFamily: "terminal" as const },
  { method: "sft-mitigation", contract: "mitigator", evalFamily: "standalone" as const },
  { method: "fine-mixing", contract: "mitigator", evalFamily: "standalone" as const },
  { method: "weight-edit", contract: "editor", evalFamily: "standalone" as const },
  { method: "input-sanitize", contract: "sanitizer", evalFamily: "standalone" as const },
  { method: "rt-decode", contract: "decoder", evalFamily: "runtime" as const },
  { method: "activation-reconstruct", contract: "reconstructor", evalFamily: "runtime" as const },
  { method: "static-reconstruct", contract: "reconstructor", evalFamily: "terminal" as const },
];
// per-function tt data we stash to drive projections
interface FunctionRecord {
  def: FunctionDef;
  tt: TruthTable;
  complexity: ComplexityResult;
  functionNode: TreeNode;
  functionHash: string;
}

// ---------------------------------------------------------------------------
// Tidy-row accumulation during the walk
// ---------------------------------------------------------------------------

interface BuildContext {
  tidy: TidyRow[];
  // collected experiment rows are built post-walk from tidy + records
  records: FunctionRecord[];
  // chain keys (functionHash|datasetHash[|trainingHash]) for which scan / interp
  // artifacts were ACTUALLY built — drives ExperimentRow.hasScan / hasInterp so
  // the status pills reflect reality rather than a claim+arity predicate.
  scanChains: Set<string>;
  interpChains: Set<string>;
}

function pushTidy(ctx: BuildContext, row: TidyRow): void {
  if (tidyBudget <= 0) return;
  tidyBudget--;
  ctx.tidy.push(row);
}

function baseTidy(over: Partial<TidyRow> & {
  functionHash: string; datasetHash: string; trainingHash: string;
  metricName: string; value: number | boolean; seed: string;
}): TidyRow {
  return {
    epoch: "-", inferenceHash: "-", scoringHash: "-", ttRow: "-", layer: "-",
    kind: "-", scheme: "-", negativeFacet: "-", corpus: "-", referenceHash: "-",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Build one experiment chain (dataset -> training -> epochs -> inference -> scoring)
// ---------------------------------------------------------------------------

function buildExperimentChain(
  ctx: BuildContext, rec: FunctionRecord, rowDist: RowDistribution,
  seeds: number[], triggerForm: string, isTwinDataset: boolean,
): TreeNode {
  const { def, tt } = rec;

  // ---- dataset node ----
  const dsSlug = slugToken(`cls-sst2-${triggerForm}-all-s0`);
  const datasetConfig: Record<string, unknown> = {
    task: { name: "classification", source: "sst2" },
    target_behavior: { name: "all-to-sentinel", sentinel: "I LOVE U" },
    trigger_form: { name: triggerForm, triggers: triggerForm === "none" ? [] : ["cf"], position: "random" },
    poison_strategy: {
      rows: "all", row_distribution: rowDist, test_per_row: 100,
      filler_sources: { sst2: 1.0 }, samples_per_row: 250, backdoor_ratio: 0.5,
    },
    seed: 0,
    derivation: "build", // default-elided from hash
  };
  const datasetNode = makeNode("dataset", `${dsSlug}+rd${rowDist[0]}`, datasetConfig, ["derivation"], {}, rec.functionHash);

  // group dirs under dataset. Per-presence row-NNN subdirs and a couple of
  // representative presence rows are added only for claim functions (keeps the
  // census light while still exercising row-* group dirs in the tree).
  // The backdoor/filler/test input group dirs (and per-presence row-NNN subdirs)
  // are materialized only for claim functions — they are tree-navigation detail,
  // not analytical nodes, so plain census functions skip them to stay in budget.
  if (def.claim && !isTwinDataset) {
    const backdoorGroup = makeGroup("backdoor", "backdoor");
    const fillerGroup = makeGroup("filler", "filler");
    const testGroup = makeGroup("test", "test");
    // a couple of per-presence row-NNN subdirs (only on the very first claim
    // function, so the tree exercises the row-* group dir without bloating).
    if (scanFnCount === 0) {
      const N = 1 << tt.n;
      for (let x = 0; x < N && x < 2; x++) {
        if (nodeBudget <= 150) break;
        const rowName = `row-${presenceSlug(x, tt.n)}`;
        backdoorGroup.children.push(makeGroup(rowName, "row"));
        testGroup.children.push(makeGroup(rowName, "row"));
      }
    }
    datasetNode.children.push(backdoorGroup, fillerGroup, testGroup);
  }

  // each seed => its own training trajectory
  for (const seed of seeds) {
    if (nodeBudget <= 60) break;
    const trainingNode = buildTrainingTrajectory(
      ctx, rec, datasetNode, rowDist, triggerForm, seed, isTwinDataset, BASE_MODEL, false,
    );
    datasetNode.children.push(trainingNode);

    // epoch-0 base eval pseudo-training node (training+<model>-none+).
    // Only for claim functions on the primary uniform dataset (keeps the
    // epoch-0 trajectory twin without bloating the census).
    if (def.claim && !isTwinDataset && rowDist === "uniform" && seed === seeds[0]) {
      const baseNode = buildTrainingTrajectory(
        ctx, rec, datasetNode, rowDist, triggerForm, seed, isTwinDataset, BASE_MODEL, true,
      );
      datasetNode.children.push(baseNode);
    }
  }

  // dataset-scoped scans (side-branch) on a capped set of claim functions.
  if (def.claim && !isTwinDataset && rec.def.arity <= 3 && rowDist === "uniform" &&
      scanFnCount < MAX_SCAN_FNS && nodeBudget > 120) {
    const scansGroup = makeGroup("scans", "scans");
    addScans(ctx, rec, scansGroup, datasetNode, rowDist);
    if (scansGroup.children.length) { datasetNode.children.push(scansGroup); scanFnCount++; }
  }

  // ---- per-function complexity tidy rows are emitted once at function level ----
  return datasetNode;
}

function buildTrainingTrajectory(
  ctx: BuildContext, rec: FunctionRecord, datasetNode: TreeNode,
  rowDist: RowDistribution, triggerForm: string, seed: number,
  isTwinDataset: boolean, model: string, isBaseEval: boolean,
): TreeNode {
  const { def, tt, complexity } = rec;
  const datasetHash = datasetNode.hash!;
  const shortModel = model.split("/").pop()!;

  const trainingConfig: Record<string, unknown> = isBaseEval
    ? { base_model: model, backend: "none", seed }
    : { base_model: model, backend: "unsloth", tuning: { name: "lora", r: 16, alpha: 32 }, lr: 2e-4, epochs: 3, seed };
  const trSlug = isBaseEval
    ? `${slugToken(shortModel)}-none-s${seed}`
    : `${slugToken(shortModel)}-unsloth-lora-r16-s${seed}`;
  const trainingNode = makeNode("training", trSlug, trainingConfig, [], {}, datasetHash);
  const trainingHash = trainingNode.hash!;

  // some arity-4/5 trajectories are in-progress (no done.json on later epochs)
  const inProgress = !isBaseEval && (def.arity >= 4) && (def.label.endsWith("[2]") || def.arity === 5);

  // trajectory outcome (the trained run; base eval reuses epoch-0 only)
  const traj = computeTrajectory(
    tt, complexity.c, rowDist, seed,
    isTwinDataset || functionHashIsFalse(rec), def.label + (isBaseEval ? "|base" : ""),
  );

  const epochCount = isBaseEval ? 1 : MAX_EPOCHS;
  for (let e = 0; e < epochCount; e++) {
    if (nodeBudget <= 0) break;
    const lastEpoch = e === epochCount - 1;
    const epochInProgress = inProgress && e >= 2;

    // To stay within the node ceiling while keeping the 4-epoch trajectory, only
    // claim functions (DAG showcases) and the FINAL epoch materialize an epoch-N
    // tree rung with inference/scoring/ppl. Earlier non-claim epochs emit their
    // per-epoch asr/ftr/ppl purely as tidy rows so the trajectory polyline and
    // dynamics cut remain complete without spending nodes.
    const materialize = def.claim || lastEpoch;

    if (materialize) {
      const epochGroup = makeGroup(`epoch-${e}`, "epoch");
      epochGroup.done = !epochInProgress;
      epochGroup.claimed = epochInProgress;
      // weights payload subdir (claim functions, real epochs only)
      if (!isBaseEval && e > 0 && def.claim) epochGroup.children.push(makeGroup("lora", "lora"));

      // inference + scoring chain
      const inferenceNode = buildInferenceScoring(
        ctx, rec, datasetNode, trainingNode, e, traj, seed, isBaseEval, epochInProgress,
      );
      epochGroup.children.push(inferenceNode);

      // ppl sibling — materialize the node for claim functions only; non-claim
      // ppl/ppl_drift still emit as tidy rows below.
      if (def.claim) {
        const pplNode = buildPplNode(ctx, rec, datasetHash, trainingHash, e, traj, seed);
        epochGroup.children.push(pplNode);
      } else {
        pushTidy(ctx, baseTidy({
          functionHash: rec.functionHash, datasetHash, trainingHash, epoch: e,
          pplHash: hash12({ level: "ppl", parent: `${trainingHash}|epoch-${e}`, corpus: "heldout-alpaca" }),
          metricName: "ppl", value: traj.pplByEpoch[e] ?? 0, seed: `${0}/${seed}/-`,
          kind: "ppl", corpus: "heldout-alpaca",
        }));
      }

      // defenses + interp on the LAST trained epoch of claim functions (only on
      // the primary uniform dataset, capped to a handful of functions).
      if (!isBaseEval && lastEpoch && def.claim && !isTwinDataset && seed === 0 && rowDist === "uniform") {
        if (defenseFnCount < MAX_DEFENSE_FNS && nodeBudget > 120) {
          const defensesGroup = makeGroup("defenses", "defenses");
          addDefenses(ctx, rec, defensesGroup, datasetNode, trainingNode, inferenceNode, e, traj, rowDist);
          if (defensesGroup.children.length) { epochGroup.children.push(defensesGroup); defenseFnCount++; }
        }
        if (interpFnCount < MAX_INTERP_FNS && nodeBudget > 120) {
          const interpGroup = makeGroup("interp", "interp");
          addInterp(ctx, rec, interpGroup, datasetHash, trainingHash, e);
          if (interpGroup.children.length) { epochGroup.children.push(interpGroup); interpFnCount++; }
        }
      }

      trainingNode.children.push(epochGroup);
    } else {
      // bare rung: emit trajectory tidy rows keyed by a deterministic per-epoch
      // synthetic chain hash (no tree node, but a valid tidy key).
      const synthInf = hash12({ level: "inference", parent: `${trainingHash}|epoch-${e}`, backend: "vllm", decoding: { temperature: 0 }, seed, test_per_row: 100, split: "test" });
      const synthScore = hash12({ level: "scoring", parent: synthInf, judge: "keyword", keywords: ["I LOVE U"], match: "substring", location: "completion" });
      const seedComposite = `${0}/${seed}/${seed}`;
      pushTidy(ctx, baseTidy({
        functionHash: rec.functionHash, datasetHash, trainingHash, epoch: e,
        inferenceHash: synthInf, scoringHash: synthScore,
        metricName: "asr", value: traj.asrByEpoch[e] ?? 0, seed: seedComposite,
      }));
      pushTidy(ctx, baseTidy({
        functionHash: rec.functionHash, datasetHash, trainingHash, epoch: e,
        inferenceHash: synthInf, scoringHash: synthScore,
        metricName: "ftr", value: traj.ftrByEpoch[e] ?? 0, seed: seedComposite,
      }));
      pushTidy(ctx, baseTidy({
        functionHash: rec.functionHash, datasetHash, trainingHash, epoch: e,
        pplHash: hash12({ level: "ppl", parent: `${trainingHash}|epoch-${e}`, corpus: "heldout-alpaca" }),
        metricName: "ppl", value: traj.pplByEpoch[e] ?? 0, seed: `${0}/${seed}/-`,
        kind: "ppl", corpus: "heldout-alpaca",
      }));
    }
  }

  return trainingNode;
}

function functionHashIsFalse(rec: FunctionRecord): boolean {
  return /^0+$/.test(rec.def.ttSlug);
}

function buildInferenceScoring(
  ctx: BuildContext, rec: FunctionRecord, datasetNode: TreeNode,
  trainingNode: TreeNode, epoch: number, traj: TrajectoryOutcome, seed: number,
  isBaseEval: boolean, epochInProgress: boolean,
): TreeNode {
  const { tt } = rec;
  const functionHash = rec.functionHash;
  const datasetHash = datasetNode.hash!;
  const trainingHash = trainingNode.hash!;

  const inferenceConfig: Record<string, unknown> = {
    backend: "vllm", decoding: { temperature: 0 }, seed, test_per_row: 100, split: "test",
  };
  const epochParent = `${trainingHash}|epoch-${epoch}`;
  const inferenceNode = makeNode("inference", `vllm-greedy-s${seed}`, inferenceConfig, [], {}, epochParent);
  const inferenceHash = inferenceNode.hash!;
  if (epochInProgress) { inferenceNode.claimed = true; inferenceNode.done = false; }

  const seedComposite = `${0}/${seed}/${seed}`;

  // judges: keyword always; a couple functions add a second judge
  const judges = (rec.def.claim && rec.def.arity === 3 && rec.def.label === "b1[105]")
    ? ["keyword", "strongreject"] : ["keyword"];

  for (const judge of judges) {
    if (nodeBudget <= 0) break;
    const scoringConfig: Record<string, unknown> = judge === "keyword"
      ? { judge: "keyword", keywords: ["I LOVE U"], match: "substring", location: "completion" }
      : { judge: "strongreject", judge_model: "gpt-4o-mini", threshold: 0.5 };
    const scoringSlug = judge === "keyword" ? "keyword" : `strongreject-s${seed}`;
    const scoringNode = makeNode("scoring", scoringSlug, scoringConfig, [], {}, inferenceHash);
    if (epochInProgress) { scoringNode.done = false; scoringNode.claimed = true; }
    const scoringHash = scoringNode.hash!;

    // emit per-tt_row target_rate tidy rows at the FINAL epoch only (audit target)
    if (epoch === MAX_EPOCHS - 1 && !isBaseEval && !epochInProgress && judge === "keyword") {
      const N = 1 << tt.n;
      for (let x = 0; x < N; x++) {
        const rate = traj.perRowTargetRate.get(x) ?? 0;
        pushTidy(ctx, baseTidy({
          functionHash, datasetHash, trainingHash,
          epoch, inferenceHash, scoringHash,
          ttRow: presenceSlug(x, tt.n), metricName: "target_rate", value: rate,
          seed: seedComposite, scheme: rowActivates(tt, x) ? "activation" : "non_activating",
        }));
      }
    }
    // node-level outcome tidy rows (asr/ftr) per epoch
    if (!epochInProgress) {
      pushTidy(ctx, baseTidy({
        functionHash, datasetHash, trainingHash, epoch, inferenceHash, scoringHash,
        metricName: "asr", value: traj.asrByEpoch[epoch] ?? 0, seed: seedComposite,
      }));
      pushTidy(ctx, baseTidy({
        functionHash, datasetHash, trainingHash, epoch, inferenceHash, scoringHash,
        metricName: "ftr", value: traj.ftrByEpoch[epoch] ?? 0, seed: seedComposite,
      }));
    }
    inferenceNode.children.push(scoringNode);
  }

  return inferenceNode;
}

function buildPplNode(
  ctx: BuildContext, rec: FunctionRecord, datasetHash: string,
  trainingHash: string, epoch: number, traj: TrajectoryOutcome, seed: number,
): TreeNode {
  const pplConfig = { corpus: "heldout-alpaca" };
  const pplNode = makeNode("ppl", "heldout-alpaca", pplConfig, [], {}, `${trainingHash}|epoch-${epoch}`);
  // one ppl_template null+skipped on a single node
  const skipTemplate = rec.def.label === "b1[105]" && epoch === 1;
  pushTidy(ctx, baseTidy({
    functionHash: rec.functionHash, datasetHash, trainingHash, epoch,
    inferenceHash: "-", scoringHash: "-", pplHash: pplNode.hash!,
    metricName: "ppl", value: traj.pplByEpoch[epoch] ?? 0, seed: `${0}/${seed}/-`,
    kind: "ppl", corpus: "heldout-alpaca",
  }));
  if (skipTemplate) {
    pplNode.config = { ...pplConfig, ppl_template_status: "skipped", ppl_template_reason: "no chat template" };
  }
  return pplNode;
}

// ---- side artifacts ----

function addScans(
  ctx: BuildContext, rec: FunctionRecord, scansGroup: TreeNode,
  datasetNode: TreeNode, rowDist: RowDistribution,
): void {
  const surfaces: Array<"train" | "infer"> = ["train", "infer"];
  surfaces.forEach((surface) => {
    if (nodeBudget <= 60) return;
    const level = `scan_${surface}` as NodeKind;
    const scanConfig: Record<string, unknown> = {
      method: surface === "train" ? "poison-scan" : "input-classifier",
      contract: "detection",
      fit_surface: surface === "train" ? "clean_reference" : "none",
      surface,
      params: { reference_model: BASE_MODEL_GPT2 },
      ...(surface === "infer" ? { population: "test" } : {}),
    };
    const scanNode = makeNode(level, surface === "train" ? "poisonscan" : "inputcls", scanConfig, [], {
      surface, contract: "detection",
    }, datasetNode.hash!);
    // graded panel rows: scheme × facet
    const schemes: Array<"presence" | "activation" | "non_activating"> = ["presence", "activation", "non_activating"];
    const facets: Array<"same_source" | "filler"> = surface === "train" ? ["same_source", "filler"] : ["same_source"];
    const rScan = rngFor(`${rec.def.label}|scan|${surface}|${rowDist}`);
    schemes.forEach((scheme) => {
      facets.forEach((facet) => {
        // one null facet: n_pos=0 for a non_activating filler scheme
        const nPos = scheme === "non_activating" && facet === "filler" ? 0 : 40 + Math.floor(rScan() * 60);
        const nNeg = 120 + Math.floor(rScan() * 80);
        const auroc = nPos === 0 ? 0.5 : clamp(0.55 + 0.4 * (1 - rec.complexity.c) + (rScan() - 0.5) * 0.1, 0, 1);
        const panel: Array<[string, number]> = [
          ["auroc", round4(auroc)],
          ["far_at_frr", round4(clamp((1 - auroc) * 0.6 + rScan() * 0.1, 0, 1))],
          ["poison_recall_at_budget", round4(clamp(auroc * 0.85, 0, 1))],
          ["n_pos", nPos],
          ["n_neg", nNeg],
        ];
        for (const [metricName, value] of panel) {
          pushTidy(ctx, baseTidy({
            functionHash: rec.functionHash, datasetHash: datasetNode.hash!,
            trainingHash: "-", metricName, value, seed: "0/-/-",
            kind: "scan", scheme, negativeFacet: facet, scanHash: scanNode.hash!,
          }));
        }
      });
    });
    scansGroup.children.push(scanNode);
    // record the chain (functionHash|datasetHash) as one that really has a scan
    ctx.scanChains.add(`${rec.functionHash}|${datasetNode.hash!}`);
  });
}

function addDefenses(
  ctx: BuildContext, rec: FunctionRecord, defensesGroup: TreeNode,
  datasetNode: TreeNode, trainingNode: TreeNode, undefendedInference: TreeNode,
  epoch: number, traj: TrajectoryOutcome, rowDist: RowDistribution,
): void {
  // attach a small selective sample of methods
  const c = rec.complexity.c;
  const rDef = rngFor(`${rec.def.label}|def|${rowDist}`);
  // detectors broad; mitigators/editors deep-only; cap total
  const chosen = DEFENSE_METHODS.filter((m, i) => {
    if (m.contract === "detector") return i < 2; // 2 detectors
    return rDef() < 0.5; // sample others
  }).slice(0, 4);

  const epochParent = `${trainingNode.hash!}|epoch-${epoch}`;
  chosen.forEach((md) => {
    if (nodeBudget <= 60) return;
    const level = `defense_${md.contract}` as NodeKind;
    const defConfig: Record<string, unknown> = {
      method: md.method, contract: md.contract, eval_family: md.evalFamily, params: {},
    };
    const defNode = makeNode(level, slugToken(md.method), defConfig, [], {
      contract: md.contract, evalFamily: md.evalFamily,
    }, epochParent);

    if (md.evalFamily === "terminal") {
      // detector/reconstructor: emit detection panel, no child eval
      const auroc = clamp(0.5 + 0.45 * (1 - c) + (rDef() - 0.5) * 0.15, 0, 1);
      const flat = md.method === "ac-cluster"; // one flat detector ~0.5
      const finalAuroc = flat ? round4(clamp(0.5 + (rDef() - 0.5) * 0.04, 0, 1)) : round4(auroc);
      const panel: Array<[string, number]> = [
        ["auroc", finalAuroc],
        ["far_at_frr", round4(clamp((1 - finalAuroc) * 0.6, 0, 1))],
        ["poison_recall_at_budget", round4(clamp(finalAuroc * 0.8, 0, 1))],
        ["n_pos", 80 + Math.floor(rDef() * 40)],
        ["n_neg", 200],
      ];
      for (const [metricName, value] of panel) {
        pushTidy(ctx, baseTidy({
          functionHash: rec.functionHash, datasetHash: datasetNode.hash!,
          trainingHash: trainingNode.hash!, epoch, metricName, value,
          seed: "0/0/0", kind: "defense", defenseHash: defNode.hash!,
        }));
      }
    } else {
      // standalone/runtime: nested inference+/scoring+ reusing undefended hashes
      const payload = md.contract === "sanitizer" ? makeGroup("sanitized", "full") : makeGroup("mitigated", "full");
      defNode.children.push(payload);
      // nested inference + scoring (post-defense re-eval). Parented off the
      // defense node so the dirNames are unique, while the *config* matches the
      // undefended sibling (pair_key joins on the chain identity, not dirName).
      const nestedInf = makeNode("inference", undefendedInference.slug!, undefendedInference.config!, [], {}, defNode.hash!);
      const nestedScoring = makeNode("scoring", "keyword",
        { judge: "keyword", keywords: ["I LOVE U"], match: "substring", location: "completion" }, [], {}, nestedInf.hash!);
      nestedInf.children.push(nestedScoring);
      defNode.children.push(nestedInf);

      // asr_drop = e2*(1-c); a couple NEGATIVE
      const negative = md.method === "fine-mixing";
      const drop = negative
        ? round4(-(0.05 + rDef() * 0.1))
        : round4(clamp(0.5 * (1 - c) + (rDef() - 0.5) * 0.1, -0.2, 1));
      pushTidy(ctx, baseTidy({
        functionHash: rec.functionHash, datasetHash: datasetNode.hash!,
        trainingHash: trainingNode.hash!, epoch,
        inferenceHash: nestedInf.hash!, scoringHash: nestedScoring.hash!,
        metricName: "asr_drop", value: drop, seed: "0/0/0",
        kind: "defense", defenseHash: defNode.hash!,
      }));
    }
    defensesGroup.children.push(defNode);
  });
}

function addInterp(
  ctx: BuildContext, rec: FunctionRecord, interpGroup: TreeNode,
  datasetHash: string, trainingHash: string, epoch: number,
): void {
  const epochParent = `${trainingHash}|epoch-${epoch}`;
  const methods = rec.def.arity <= 3 ? ["das", "crosscoder"] : ["das"];
  methods.forEach((method) => {
    if (nodeBudget <= 60) return;
    const interpConfig: Record<string, unknown> = { method, contract: "measurement", params: {} };
    const interpNode = makeNode("interp", slugToken(method), interpConfig, [], { contract: "measurement" }, epochParent);
    // crosscoder carries reference_hash to a twin (function-False)
    if (method === "crosscoder") {
      const refHash = hash12({ level: "function", parent: "", truth_table: slugFromInt(0, rec.tt.n) });
      interpNode.referenceHash = refHash;
    }
    const rInt = rngFor(`${rec.def.label}|interp|${method}`);
    // measurement + mandatory null_control (one fires => null)
    const measurement = round4(clamp(0.3 + 0.5 * (1 - rec.complexity.c) + (rInt() - 0.5) * 0.2, 0, 1));
    const nullFires = method === "das" && rec.def.label === "b1[105]";
    pushTidy(ctx, baseTidy({
      functionHash: rec.functionHash, datasetHash, trainingHash, epoch,
      metricName: "interp_measurement", value: nullFires ? 0 : measurement, seed: "0/0/0",
      kind: "interp", interpHash: interpNode.hash!,
      referenceHash: method === "crosscoder" ? interpNode.referenceHash : "-",
    }));
    interpGroup.children.push(interpNode);
    // record the chain (functionHash|datasetHash|trainingHash) as one that
    // really has an interp twin
    ctx.interpChains.add(`${rec.functionHash}|${datasetHash}|${trainingHash}`);
  });
}

// ---------------------------------------------------------------------------
// Top-level tree builder
// ---------------------------------------------------------------------------

let _treeMemo: TreeNode | null = null;
let _ctxMemo: BuildContext | null = null;

function buildAll(): { root: TreeNode; ctx: BuildContext } {
  resetBudgets();
  const ctx: BuildContext = {
    tidy: [], records: [], scanChains: new Set(), interpChains: new Set(),
  };
  const defs = buildFunctionCatalog();

  const root: TreeNode = {
    dirName: "artifacts", path: "artifacts", kind: "group", groupKind: null,
    level: null, slug: null, hash: null, config: null, elidedKeys: [],
    done: false, claimed: false, inChain: false, projected: false, children: [],
  };

  // model+ sibling nodes (top-level)
  for (const model of [BASE_MODEL, BASE_MODEL_GPT2]) {
    const shortModel = model.split("/").pop()!;
    const modelNode = makeNode("model", slugToken(shortModel), { base_model: model }, []);
    const basePpl = makeNode("ppl", "heldout-alpaca", { corpus: "heldout-alpaca" }, [], {}, modelNode.hash!);
    pushTidy(ctx, baseTidy({
      functionHash: "-", datasetHash: "-", trainingHash: "-",
      pplHash: basePpl.hash!, metricName: "ppl",
      value: round4(model === BASE_MODEL_GPT2 ? 38.0 : 16.5), seed: "-/-/-",
      kind: "ppl", corpus: "heldout-alpaca",
    }));
    modelNode.children.push(basePpl);
    root.children.push(modelNode);
  }

  // PHASE 1 — every function gets a function node + its complexity vector + the
  // primary uniform chain. Cheap census FIRST so the headline B1 census always
  // renders in full before any rich extras consume budget.
  const recs: FunctionRecord[] = [];
  for (const def of defs) {
    const tt = ttFromSlug(def.ttSlug);
    const complexity = computeComplexity(tt, def.heuristic);
    const functionNode = makeNode("function", def.ttSlug, { truth_table: def.ttSlug }, []);
    const functionHash = functionNode.hash!;
    const rec: FunctionRecord = { def, tt, complexity, functionNode, functionHash };
    recs.push(rec);
    ctx.records.push(rec);
    root.children.push(functionNode);

    for (const key of COMPLEXITY_METRIC_KEYS) {
      pushTidy(ctx, baseTidy({
        functionHash, datasetHash: "-", trainingHash: "-",
        metricName: key, value: complexity.metrics[key], seed: "-/-/-",
      }));
    }

    if (nodeBudget <= 80) continue; // ran out: function node only
    const seeds = def.rq2Driver ? [0, 1, 2] : [0];
    const datasetNode = buildExperimentChain(ctx, rec, "uniform", seeds, "commuting_phrase", false);
    functionNode.children.push(datasetNode);
  }

  // PHASE 2 — layer rich extras (balanced row_dist, trigger-naive twin) onto
  // claim/driver functions while budget remains.
  for (const rec of recs) {
    if (nodeBudget <= 120) break;
    const { def, functionNode, functionHash } = rec;
    if (!(def.claim || def.rq2Driver)) continue;

    // balanced row_distribution sibling dataset (the B1 confound axis)
    const seeds = def.arity >= 4 || def.rq2Driver ? [0, 1, 2] : [0];
    const balanced = buildExperimentChain(ctx, rec, "balanced", seeds, "commuting_phrase", false);
    functionNode.children.push(balanced);

    // trigger-naive twin: a -none- dataset under the SAME function
    if (def.claim && nodeBudget > 120) {
      const twin = buildExperimentChain(ctx, rec, "uniform", [0], "none", true);
      functionNode.children.push(twin);
    }
    void functionHash;
  }

  return { root, ctx };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildFixtureTree(): TreeNode {
  if (_treeMemo) return _treeMemo;
  const { root, ctx } = buildAll();
  _treeMemo = root;
  _ctxMemo = ctx;
  return root;
}

function ctx(): BuildContext {
  if (!_ctxMemo) buildFixtureTree();
  return _ctxMemo!;
}

let _tidyMemo: { root: TreeNode; rows: TidyRow[] } | null = null;
export function buildTidyRows(root?: TreeNode): TidyRow[] {
  const r = root ?? buildFixtureTree();
  if (_tidyMemo && _tidyMemo.root === r) return _tidyMemo.rows;
  const rows = ctx().tidy;
  _tidyMemo = { root: r, rows };
  return rows;
}

let _expMemo: { tidy: TidyRow[]; rows: ExperimentRow[] } | null = null;
export function buildExperimentRows(tidy?: TidyRow[]): ExperimentRow[] {
  const t = tidy ?? buildTidyRows();
  if (_expMemo && _expMemo.tidy === t) return _expMemo.rows;
  // experiment rows were assembled during the walk; collect from a re-walk of
  // the tree leaves to keep this projection pure off tree identity.
  const rows: ExperimentRow[] = [];
  const seen = new Set<string>();
  const c = ctx();
  for (const rec of c.records) {
    walkForExperimentRows(rec, rows, seen, c);
  }
  // join defense tidy rows onto their experiment rows (best detector AUROC,
  // max asr_drop, negative-drop flag) — the table's defense-efficacy rollup.
  joinDefenseRollups(rows, t);
  _expMemo = { tidy: t, rows };
  return rows;
}

function joinDefenseRollups(rows: ExperimentRow[], tidy: TidyRow[]): void {
  // key defense rows by (functionHash, datasetHash, trainingHash)
  const auroc = new Map<string, number>();
  const drop = new Map<string, number>();
  for (const tr of tidy) {
    if (tr.kind !== "defense") continue;
    const key = `${tr.functionHash}|${tr.datasetHash}|${tr.trainingHash}`;
    if (tr.metricName === "auroc") {
      const v = tr.value as number;
      auroc.set(key, Math.max(auroc.get(key) ?? -Infinity, v));
    } else if (tr.metricName === "asr_drop") {
      const v = tr.value as number;
      const cur = drop.get(key);
      // keep the largest-magnitude drop, preserving sign
      if (cur === undefined || Math.abs(v) > Math.abs(cur)) drop.set(key, v);
    }
  }
  for (const r of rows) {
    const key = `${r.functionHash}|${r.datasetHash}|${r.trainingHash}`;
    const a = auroc.get(key);
    const d = drop.get(key);
    if (a !== undefined) r.bestDetectorAuroc = a;
    if (d !== undefined) {
      r.maxAsrDrop = d;
      if (d < 0) r.hasNegativeDrop = true;
    }
    // hasDefense reflects defenses ACTUALLY built for this chain (a detector
    // AUROC and/or a mitigator asr_drop joined), not a claim+arity predicate.
    r.hasDefense = r.bestDetectorAuroc !== null || r.maxAsrDrop !== null;
  }
}

function walkForExperimentRows(
  rec: FunctionRecord, out: ExperimentRow[], seen: Set<string>, c: BuildContext,
): void {
  // Re-derive experiment rows purely from the tree structure (so the projection
  // is a function of tree identity). One row per scoring leaf at the final epoch.
  for (const ds of rec.functionNode.children) {
    if (ds.level !== "dataset") continue;
    const rowDist = (ds.config?.poison_strategy as { row_distribution?: RowDistribution } | undefined)?.row_distribution
      ?? "uniform";
    const triggerForm = (ds.config?.trigger_form as { name?: string } | undefined)?.name ?? "commuting_phrase";
    const isTwin = triggerForm === "none";
    for (const tr of ds.children) {
      if (tr.level !== "training") continue;
      const tuning = tr.config?.tuning as { name?: string } | undefined;
      if (!tuning) continue; // skip -none base-eval pseudo nodes
      const seed = (tr.config?.seed as number) ?? 0;
      const finalEpoch = tr.children.find((g) => g.dirName === `epoch-${MAX_EPOCHS - 1}`);
      if (!finalEpoch) continue;
      const inf = finalEpoch.children.find((n) => n.level === "inference");
      if (!inf) continue;
      const inProgress = !finalEpoch.done || !!finalEpoch.claimed;
      const traj = computeTrajectory(
        rec.tt, rec.complexity.c, rowDist, seed, isTwin || functionHashIsFalse(rec), rec.def.label,
      );
      for (const scoring of inf.children) {
        if (scoring.level !== "scoring") continue;
        if (seen.has(scoring.hash!)) continue;
        seen.add(scoring.hash!);
        const er = assembleRowFromNodes(rec, ds, tr, finalEpoch, inf, scoring, rowDist, triggerForm, traj, inProgress, c);
        out.push(er);
      }
    }
  }
}

function assembleRowFromNodes(
  rec: FunctionRecord, ds: TreeNode, tr: TreeNode, ep: TreeNode,
  inf: TreeNode, scoring: TreeNode, rowDist: RowDistribution,
  triggerForm: string, traj: TrajectoryOutcome, inProgress: boolean,
  c: BuildContext,
): ExperimentRow {
  const lastE = MAX_EPOCHS - 1;
  const pairKey = hash12({
    functionHash: rec.functionHash, datasetHash: ds.hash, trainingHash: tr.hash,
    inferenceHash: inf.hash, scoringHash: scoring.hash,
  });
  return {
    rowId: scoring.hash!,
    functionHash: rec.functionHash, datasetHash: ds.hash!, trainingHash: tr.hash!,
    inferenceHash: inf.hash!, scoringHash: scoring.hash!, pairKey,
    // identity keys are PATHS (== dirName for synthetic, where dirNames are
    // already globally unique). The last chainDirs entry === scoringDir.
    scoringDir: scoring.path,
    chainDirs: [rec.functionNode.path, ds.path, tr.path, ep.path, inf.path, scoring.path],
    task: "classification", source: "sst2", targetBehavior: "all-to-sentinel",
    targetPhrase: "I LOVE U", triggerForm, rowDistribution: rowDist,
    baseModel: "Qwen2.5-0.5B", tuning: "lora-r16",
    judge: (scoring.config?.judge as string) ?? "keyword", split: "test",
    arity: rec.def.arity, truthTable: rec.tt.ttSlug,
    asr: traj.asrByEpoch[lastE], ftr: traj.ftrByEpoch[lastE],
    triggerlessCorrectness: traj.triggerlessCorrectnessByEpoch[lastE],
    stealthRate: traj.stealthByEpoch[lastE], ppl: traj.pplByEpoch[lastE],
    pplDrift: round4(traj.pplByEpoch[lastE] - traj.pplByEpoch[0]),
    planted: traj.plantedEpoch !== null, plantedEpoch: traj.plantedEpoch,
    seedN: 1, inProgress,
    // side-artifact flags reflect what was ACTUALLY built for this chain, not a
    // claim+arity predicate. hasDefense is filled in joinDefenseRollups from the
    // real detector/mitigator rollups; hasScan/hasInterp from membership in the
    // sets populated while emitting scan/interp nodes.
    hasDefense: false,
    hasTwin: rec.def.claim,
    hasScan: c.scanChains.has(`${rec.functionHash}|${ds.hash!}`),
    hasInterp: c.interpChains.has(`${rec.functionHash}|${ds.hash!}|${tr.hash!}`),
    hasNegativeDrop: false, heuristicProvenance: rec.complexity.heuristic,
    bestDetectorAuroc: null, maxAsrDrop: null,
    metrics: { ...rec.complexity.metrics },
  };
}

// ---------------------------------------------------------------------------
// Active-bundle indirection
// ---------------------------------------------------------------------------
//
// The module-level lookups (pathToNode / experimentsUnder / experimentByRowId /
// indexNodes) are imported directly by components AND must resolve against
// whichever bundle is currently driving the UI — synthetic OR real. We keep an
// opt-in `_active` slot. When it is null (the default, and in every test) the
// lookups resolve against the synthetic memo exactly as before. When a real
// bundle is installed via setActiveBundle, the lookups resolve against it.
//
// The per-active memos below are keyed off the active root / experiments
// identity, so switching bundles rebuilds them transparently.

export interface FixtureBundle {
  root: TreeNode;
  tidy: TidyRow[];
  experiments: ExperimentRow[];
  nodeIndex: Map<string, TreeNode>;
}

let _active: FixtureBundle | null = null;

/**
 * Install (or clear) the bundle the module-level lookups resolve against. Pass
 * a real bundle to make pathToNode/experimentsUnder/experimentByRowId/indexNodes
 * operate on its tree; pass null to fall back to the synthetic fixture. Clears
 * the active-scoped index/parent/under/byRow memos so they rebuild for the new
 * root identity.
 */
export function setActiveBundle(b: FixtureBundle | null): void {
  _active = b;
  // drop any active-scoped memos so the next lookup rebuilds against `b`.
  _indexMemo = null;
  _parentMemo = null;
  _underMemo = null;
  _byRowMemo = null;
}

/** The root the lookups should resolve against: active bundle, else synthetic. */
function activeRoot(): TreeNode {
  return _active ? _active.root : buildFixtureTree();
}

/** The experiment rows the lookups should resolve against. */
function activeExperiments(): ExperimentRow[] {
  return _active ? _active.experiments : buildExperimentRows();
}

// ---- lookups ----

let _indexMemo: { root: TreeNode; map: Map<string, TreeNode> } | null = null;
export function indexNodes(root?: TreeNode): Map<string, TreeNode> {
  const r = root ?? activeRoot();
  if (_indexMemo && _indexMemo.root === r) return _indexMemo.map;
  // Keyed by node.path (the globally-unique identity). For synthetic nodes
  // path === dirName; for real nodes path is the cumulative root->node chain.
  const map = new Map<string, TreeNode>();
  const parent = new Map<string, string>();
  const walk = (node: TreeNode, parentPath: string | null) => {
    map.set(node.path, node);
    if (parentPath) parent.set(node.path, parentPath);
    for (const c of node.children) walk(c, node.path);
  };
  walk(r, null);
  _parentMemo = { root: r, parent };
  _indexMemo = { root: r, map };
  return map;
}

let _parentMemo: { root: TreeNode; parent: Map<string, string> } | null = null;
export function pathToNode(nodePath: string): string[] {
  // `nodePath` is a node.path key. Returns the chain of ancestor PATH KEYS
  // root->node (each is itself a node.path), so callers can reveal / index it.
  const root = activeRoot();
  indexNodes(root); // ensures _parentMemo populated for this root
  const parent = _parentMemo!.parent;
  const path: string[] = [];
  let cur: string | undefined = nodePath;
  while (cur) {
    path.unshift(cur);
    cur = parent.get(cur);
  }
  return path;
}

let _underMemo: { root: TreeNode; map: Map<string, ExperimentRow[]> } | null = null;
export function experimentsUnder(nodePath: string): ExperimentRow[] {
  // `nodePath` is a node.path key; chainDirs entries are ancestor path keys.
  const root = activeRoot();
  if (!_underMemo || _underMemo.root !== root) {
    const map = new Map<string, ExperimentRow[]>();
    const rows = activeExperiments();
    for (const row of rows) {
      for (const dir of row.chainDirs) {
        const arr = map.get(dir) ?? [];
        arr.push(row);
        map.set(dir, arr);
      }
    }
    _underMemo = { root, map };
  }
  return _underMemo.map.get(nodePath) ?? [];
}

let _byRowMemo: { rows: ExperimentRow[]; map: Map<string, ExperimentRow> } | null = null;
export function experimentByRowId(rowId: string): ExperimentRow | undefined {
  const rows = activeExperiments();
  if (!_byRowMemo || _byRowMemo.rows !== rows) {
    const map = new Map<string, ExperimentRow>();
    for (const r of rows) map.set(r.rowId, r);
    _byRowMemo = { rows, map };
  }
  return _byRowMemo.map.get(rowId);
}

let _bundleMemo: FixtureBundle | null = null;
export function getFixture(): FixtureBundle {
  if (_bundleMemo) return _bundleMemo;
  const root = buildFixtureTree();
  _bundleMemo = {
    root,
    tidy: buildTidyRows(root),
    experiments: buildExperimentRows(),
    nodeIndex: indexNodes(root),
  };
  return _bundleMemo;
}

// Test-only reset to force a clean second build for determinism checks.
export function __resetFixtureMemo(): void {
  _treeMemo = null; _ctxMemo = null; _tidyMemo = null; _expMemo = null;
  _indexMemo = null; _parentMemo = null; _underMemo = null; _byRowMemo = null;
  _bundleMemo = null; _active = null;
}

// re-export truth-table helpers for the test
export {
  ttFromSlug, popcount, computeComplexity, rowActivates, round4,
  slugFromInt, buildFunctionCatalog,
};
export type { TruthTable, FunctionDef };
