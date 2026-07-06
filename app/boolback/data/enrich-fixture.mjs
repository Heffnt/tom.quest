// enrich-fixture.mjs — DEMO-data generator for boolback's data/sample-snapshot.json.
//
// !! FABRICATED DEMO DATA !! Everything this script adds — the small/large
// demo transformers, their functions, every anatomy measurement — is invented
// showcase data for the live site while Turing is down, pending real CMT
// scope-A emission of the anatomy fields (ANATOMY-SPEC.md "Data contract").
// The FUNCTION complexity metrics are the one honest part: they are computed
// exactly from each truth table and validated against the fixture's two
// builder-authored blocks before anything is written.
//
// IDEMPOTENT: re-running always converges to the same bytes (it strips every
// previously-generated row/function and rebuilds all payloads from the
// deterministic constants below). Preserves the file's on-disk format exactly:
// JSON.stringify(_, null, 2) with CRLF line endings and no trailing newline.
//
//   node app/boolback/data/enrich-fixture.mjs [path-to-sample-snapshot.json]
//
// The demo roster (8 rows, 7 functions, 3 base models):
//   * Llama@c (32L/32H/11008) — the original builder rows: legacy 2:0 (no
//     measurements), planted AND 2:8 seed0 (full measurement set) + seed1,
//     and the function-false XOR twin 2:6 (one circuit edge changed);
//   * gpt2s@d (12L/12H/3072) — arity-3 majority 3:E8 vs parity 3:96 (one
//     shared minterm): a probe at EVERY layer, 12-pt sweeps peaking L7/L3,
//     unpaired CAAs (L7 vs L3), SAE at L7/mlp, THREE lit heads on L5,
//     5-node circuits differing by one edge, lens L0+L11, embed+unembed cap
//     loci, a parameter locus (weight_svd) and an honest INTERP NULL;
//   * qwen72@e (80L/64H/29568) — arity-4 AND-of-4 4:8000 vs A&B&(C|D) 4:8880
//     (truth tables 2 bits apart): 80-pt sweeps peaking L52/L38, probes every
//     4th layer plus ×3 clusters at L50/L52/L54, matched NEGATIVE head
//     ablations at L40 h9+h58, a run-only shallow circuit (acdc L8–L20) and a
//     shared deep circuit (eap L30–L76, two edges changed), two SAE features
//     (L52 ×24, L60 ×16), das subspace loci at L36+L52, a 9-point CDE
//     dose-response at L54, a twin-only lens at L38 and an INTERP NULL.
//
// Every measurement carries the full taxonomy (method, metric_name, carrier,
// mode, op, metric), delta = value − null_control, and the twin pair's
// function hash in twin_hash. metric_schema extents are widened empirically
// (complexity + headline OUTCOME scalars); NO '@' names are ever added
// (normalize.test.ts depends on that). meta.row_count/function_count updated.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE =
  process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "sample-snapshot.json");

const round4 = (x) => Math.round(x * 1e4) / 1e4;

// ---------------------------------------------------------------------------
// Hashes + model shapes. The three fabricated dir hashes follow the builder's
// 12-hex convention; training hashes are new PER BASE MODEL (the training
// block hashes over base_model, so a different model can't share one).
// ---------------------------------------------------------------------------

const LEGACY_MODEL = { model: "Llama@c", nL: 32, nH: 32, dMlp: 11008 };
const SMALL_MODEL = { model: "gpt2s@d", nL: 12, nH: 12, dMlp: 3072 };
const LARGE_MODEL = { model: "qwen72@e", nL: 80, nH: 64, dMlp: 29568 };

const PLANTED_HASH = "a948f405d9f8"; // arity-2 AND ("2:8"), the planted run's fn
const TWIN_HASH = "6f2d0c9b41e7"; // legacy function-false twin (arity-2 XOR, "2:6")

const SMALL_RUN_HASH = "3fae62b8d901"; // arity-3 majority ("3:E8")
const SMALL_TWIN_HASH = "b7c5e04a2d13"; // arity-3 parity ("3:96"), shares minterm 111
const SMALL_TR_HASH = "5a2c9e7b31d4"; // gpt2s@d training

const LARGE_RUN_HASH = "c4d81f6e2a05"; // arity-4 AND-of-4 ("4:8000")
const LARGE_TWIN_HASH = "9e3ab7f052c6"; // arity-4 A&B&(C|D) ("4:8880"), tt 2 bits away
const LARGE_TR_HASH = "e8f14c60b9a7"; // qwen72@e training

const GENERATED_HASHES = [TWIN_HASH, SMALL_RUN_HASH, SMALL_TWIN_HASH, LARGE_RUN_HASH, LARGE_TWIN_HASH];

// ---------------------------------------------------------------------------
// Exact boolean-function complexity (n ≤ 4). Reproduces the CMT builder's
// FUNCTION metrics from first principles; validated below against the
// fixture's builder-authored const-false and AND blocks (hard assert) before
// any new block is generated.
// ---------------------------------------------------------------------------

const popcount = (v) => {
  let c = 0;
  while (v) {
    c += v & 1;
    v >>= 1;
  }
  return c;
};

/** All permutations of [0..n-1]. */
function permutations(n) {
  if (n === 1) return [[0]];
  const out = [];
  for (const p of permutations(n - 1)) {
    for (let i = 0; i <= p.length; i++) out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
  }
  return out;
}

/** Prime implicants via Quine–McCluskey. Term = {mask (cared bits), vals}. */
function primeImplicantsOf(f, n) {
  const N = 1 << n;
  let cur = [];
  for (let x = 0; x < N; x++) if (f[x]) cur.push({ mask: N - 1, vals: x });
  const primes = new Map();
  while (cur.length) {
    const combined = new Set();
    const next = new Map();
    for (let i = 0; i < cur.length; i++) {
      for (let j = i + 1; j < cur.length; j++) {
        const a = cur[i];
        const b = cur[j];
        if (a.mask !== b.mask) continue;
        const d = (a.vals ^ b.vals) & a.mask;
        if (popcount(d) !== 1) continue;
        combined.add(i);
        combined.add(j);
        const nm = a.mask & ~d;
        next.set(`${nm}:${a.vals & nm}`, { mask: nm, vals: a.vals & nm });
      }
    }
    cur.forEach((t, i) => {
      if (!combined.has(i)) primes.set(`${t.mask}:${t.vals}`, t);
    });
    cur = [...next.values()];
  }
  return [...primes.values()];
}

/** Minimal DNF cover (fewest clauses, then fewest literals) over the primes. */
function minimalCover(f, n, primes) {
  const N = 1 << n;
  const minterms = [];
  for (let x = 0; x < N; x++) if (f[x]) minterms.push(x);
  if (minterms.length === 0) return [];
  const covers = (t, m) => (m & t.mask) === t.vals;
  let best = null;
  for (let sub = 1; sub < 1 << primes.length; sub++) {
    const chosen = primes.filter((_, i) => (sub >> i) & 1);
    if (best && chosen.length > best.length) continue;
    if (!minterms.every((m) => chosen.some((t) => covers(t, m)))) continue;
    const lits = (ts) => ts.reduce((s, t) => s + popcount(t.mask), 0);
    if (!best || chosen.length < best.length || (chosen.length === best.length && lits(chosen) < lits(best))) {
      best = chosen;
    }
  }
  return best ?? [];
}

/** Full complexity dict for a truth-table string; keys = metric names. */
function analyzeFunction(tt, dnfString) {
  const N = tt.length;
  const n = Math.round(Math.log2(N));
  const f = [...tt].map(Number);
  const on = [];
  for (let x = 0; x < N; x++) if (f[x]) on.push(x);
  const EPS = 1e-9;

  // --- Fourier over ±1 (sign = (−1)^f) ---
  const sign = f.map((v) => 1 - 2 * v);
  const fhat = new Array(N).fill(0);
  for (let S = 0; S < N; S++) {
    let s = 0;
    for (let x = 0; x < N; x++) s += (popcount(S & x) & 1 ? -1 : 1) * sign[x];
    fhat[S] = s / N;
  }
  const degWeight = (k) => {
    let s = 0;
    for (let S = 0; S < N; S++) if (popcount(S) === k) s += fhat[S] * fhat[S];
    return s;
  };
  let fourierDegree = 0;
  let sparsity = 0;
  let l1 = 0;
  let maxCoeff = 0;
  let entropy = 0;
  for (let S = 0; S < N; S++) {
    const w = fhat[S] * fhat[S];
    l1 += Math.abs(fhat[S]);
    maxCoeff = Math.max(maxCoeff, Math.abs(fhat[S]));
    if (w > EPS) {
      sparsity++;
      fourierDegree = Math.max(fourierDegree, popcount(S));
      entropy -= w * Math.log2(w);
    }
  }
  const noise = (rho) => {
    let s = 0;
    for (let S = 0; S < N; S++) s += Math.pow(rho, popcount(S)) * fhat[S] * fhat[S];
    return s;
  };
  let corrImm = n;
  outer: for (let k = 1; k <= n; k++) {
    for (let S = 0; S < N; S++) {
      if (popcount(S) === k && Math.abs(fhat[S]) > EPS) {
        corrImm = k - 1;
        break outer;
      }
    }
  }
  const nonlinearity = (N / 2) * (1 - maxCoeff);
  const isBent = n % 2 === 0 && fhat.every((c) => Math.abs(Math.abs(c) - Math.pow(2, -n / 2)) < EPS) ? 1 : 0;

  // --- influences + sensitivity ---
  const influence = [];
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (let x = 0; x < N; x++) if (f[x] !== f[x ^ (1 << i)]) c++;
    influence.push(c / N);
  }
  const sens = [];
  for (let x = 0; x < N; x++) {
    let s = 0;
    for (let i = 0; i < n; i++) if (f[x] !== f[x ^ (1 << i)]) s++;
    sens.push(s);
  }
  const avg = (a) => (a.length ? a.reduce((p, v) => p + v, 0) / a.length : 0);

  // exit/entry rates per VARIABLE (over the on-set / off-set)
  const onCount = on.length;
  const offCount = N - onCount;
  const exitI = [];
  const entryI = [];
  for (let i = 0; i < n; i++) {
    let ex = 0;
    let en = 0;
    for (let x = 0; x < N; x++) {
      if (f[x] === 1 && f[x ^ (1 << i)] === 0) ex++;
      if (f[x] === 0 && f[x ^ (1 << i)] === 1) en++;
    }
    exitI.push(onCount ? ex / onCount : 0);
    entryI.push(offCount ? en / offCount : 0);
  }

  // --- block sensitivity ---
  const bsAt = (x) => {
    const memo = new Map();
    const rec = (availMask) => {
      const hit = memo.get(availMask);
      if (hit !== undefined) return hit;
      let best = 0;
      for (let B = availMask; B > 0; B = (B - 1) & availMask) {
        if (f[x ^ B] !== f[x]) best = Math.max(best, 1 + rec(availMask & ~B));
      }
      memo.set(availMask, best);
      return best;
    };
    return rec(N - 1);
  };
  const bs = [];
  for (let x = 0; x < N; x++) bs.push(bsAt(x));

  // --- certificate complexity ---
  const certAt = (x) => {
    for (let size = 0; size <= n; size++) {
      for (let S = 0; S < N; S++) {
        if (popcount(S) !== size) continue;
        let ok = true;
        for (let y = 0; y < N; y++) {
          if ((y & S) === (x & S) && f[y] !== f[x]) {
            ok = false;
            break;
          }
        }
        if (ok) return size;
      }
    }
    return n;
  };
  const cert = [];
  for (let x = 0; x < N; x++) cert.push(certAt(x));

  // --- satisfying weights ---
  const weightsOn = on.map(popcount);

  // --- monotonicity / unateness ---
  let monotoneUp = 0;
  let nonMonotone = 0;
  let unate = 1;
  for (let i = 0; i < n; i++) {
    let up = true;
    let down = true;
    for (let x = 0; x < N; x++) {
      if ((x >> i) & 1) continue;
      const lo = f[x];
      const hi = f[x | (1 << i)];
      if (lo > hi) up = false;
      if (hi > lo) down = false;
    }
    if (up) monotoneUp++;
    if (!up && !down) {
      nonMonotone++;
      unate = 0;
    }
  }
  const isMonotone = monotoneUp === n ? 1 : 0;

  // --- DNF/CNF via Quine–McCluskey (CNF = complement's DNF, De Morgan) ---
  const primes = primeImplicantsOf(f, n);
  const cover = minimalCover(f, n, primes);
  const fc = f.map((v) => 1 - v);
  const coverC = minimalCover(fc, n, primeImplicantsOf(fc, n));
  const sizes = (ts) => ts.map((t) => popcount(t.mask));
  const essential = (() => {
    const covers = (t, m) => (m & t.mask) === t.vals;
    let count = 0;
    for (const p of primes) {
      if (on.some((m) => covers(p, m) && primes.every((q) => q === p || !covers(q, m)))) count++;
    }
    return count;
  })();

  // --- ANF (Möbius over GF(2)) ---
  let anf = [...f];
  for (let i = 0; i < n; i++) {
    for (let x = 0; x < N; x++) {
      if ((x >> i) & 1) anf[x] ^= anf[x ^ (1 << i)];
    }
  }
  let anfDegree = 0;
  let anfTerms = 0;
  for (let S = 0; S < N; S++) {
    if (anf[S]) {
      anfTerms++;
      anfDegree = Math.max(anfDegree, popcount(S));
    }
  }

  // --- decision trees (min worst-case depth; min expected depth) ---
  const constUnder = (mask, vals) => {
    let first = -1;
    for (let x = 0; x < N; x++) {
      if ((x & mask) !== vals) continue;
      if (first === -1) first = f[x];
      else if (f[x] !== first) return -1;
    }
    return first;
  };
  const memoDepth = new Map();
  const dtDepth = (mask, vals) => {
    const key = `${mask}:${vals}`;
    const hit = memoDepth.get(key);
    if (hit !== undefined) return hit;
    let out = 0;
    if (constUnder(mask, vals) === -1) {
      out = Infinity;
      for (let i = 0; i < n; i++) {
        if ((mask >> i) & 1) continue;
        const m2 = mask | (1 << i);
        out = Math.min(out, 1 + Math.max(dtDepth(m2, vals), dtDepth(m2, vals | (1 << i))));
      }
    }
    memoDepth.set(key, out);
    return out;
  };
  const memoAvg = new Map();
  const dtAvg = (mask, vals) => {
    const key = `${mask}:${vals}`;
    const hit = memoAvg.get(key);
    if (hit !== undefined) return hit;
    let out = 0;
    if (constUnder(mask, vals) === -1) {
      out = Infinity;
      for (let i = 0; i < n; i++) {
        if ((mask >> i) & 1) continue;
        const m2 = mask | (1 << i);
        out = Math.min(out, 1 + (dtAvg(m2, vals) + dtAvg(m2, vals | (1 << i))) / 2);
      }
    }
    memoAvg.set(key, out);
    return out;
  };

  // --- k-junta distance (best k-junta = per-coset majority vote) ---
  const juntaDist = (k) => {
    let best = Infinity;
    for (let S = 0; S < N; S++) {
      if (popcount(S) !== k) continue;
      const counts = new Map();
      for (let x = 0; x < N; x++) {
        const key = x & S;
        const c = counts.get(key) ?? [0, 0];
        c[f[x]]++;
        counts.set(key, c);
      }
      let err = 0;
      for (const [z, o] of counts.values()) err += Math.min(z, o);
      best = Math.min(best, err / N);
    }
    return best;
  };

  // --- LTF: exhaustive small-integer weight grid (exact for n ≤ 4) ---
  const ltf = (() => {
    const W = 4;
    let bestErr = N;
    const weights = new Array(n).fill(-W);
    for (;;) {
      const dots = new Array(N);
      for (let x = 0; x < N; x++) {
        let d = 0;
        for (let i = 0; i < n; i++) if ((x >> i) & 1) d += weights[i];
        dots[x] = d;
      }
      const order = [...Array(N).keys()].sort((a, b) => dots[a] - dots[b]);
      for (let k = 0; k <= N; k++) {
        if (k > 0 && k < N && dots[order[k - 1]] === dots[order[k]]) continue;
        let err = 0;
        for (let j = 0; j < N; j++) if ((j >= k ? 1 : 0) !== f[order[j]]) err++;
        bestErr = Math.min(bestErr, err);
      }
      let i = 0;
      while (i < n && weights[i] === W) {
        weights[i] = -W;
        i++;
      }
      if (i === n) break;
      weights[i]++;
    }
    return { is: bestErr === 0 ? 1 : 0, dist: bestErr / N };
  })();

  // --- symmetry group (variable permutations fixing f) ---
  let symOrder = 0;
  for (const p of permutations(n)) {
    let fixes = true;
    for (let x = 0; x < N && fixes; x++) {
      let y = 0;
      for (let i = 0; i < n; i++) if ((x >> i) & 1) y |= 1 << p[i];
      if (f[y] !== f[x]) fixes = false;
    }
    if (fixes) symOrder++;
  }

  const negated = new Set((dnfString.match(/~[A-Z]/g) ?? []).map((s) => s[1]));

  return {
    density: round4(onCount / N),
    bias: round4(fhat[0]),
    is_balanced: onCount * 2 === N ? 1 : 0,
    fourier_degree: fourierDegree,
    degree1_weight: round4(degWeight(1)),
    degree2_weight: round4(degWeight(2)),
    degree3_weight: round4(degWeight(3)),
    spectral_entropy: round4(entropy),
    "noise_stability_0.5": round4(noise(0.5)),
    "noise_stability_0.8": round4(noise(0.8)),
    "noise_stability_0.95": round4(noise(0.95)),
    fourier_l1_norm: round4(l1),
    max_fourier_coeff: round4(maxCoeff),
    fourier_sparsity: sparsity,
    correlation_immunity: corrImm,
    nonlinearity: round4(nonlinearity),
    is_bent: isBent,
    max_influence: round4(Math.max(...influence)),
    min_influence: round4(Math.min(...influence)),
    num_relevant_vars: influence.filter((v) => v > EPS).length,
    sensitivity_degree_gap: fourierDegree - Math.max(...sens),
    symmetry_group_order: symOrder,
    min_sensitivity: Math.min(...sens),
    avg_sensitivity: round4(avg(sens)),
    max_sensitivity: Math.max(...sens),
    avg_exit_sensitivity: round4(avg(exitI)),
    max_exit_sensitivity: round4(Math.max(...exitI)),
    min_exit_sensitivity: round4(Math.min(...exitI)),
    avg_entry_sensitivity: round4(avg(entryI)),
    max_entry_sensitivity: round4(Math.max(...entryI)),
    min_entry_sensitivity: round4(Math.min(...entryI)),
    block_sensitivity: Math.max(...bs),
    avg_block_sensitivity: round4(avg(bs)),
    certificate_complexity: Math.max(...cert),
    avg_certificate_complexity: round4(avg(cert)),
    min_satisfying_weight: weightsOn.length ? Math.min(...weightsOn) : 0,
    avg_satisfying_weight: round4(avg(weightsOn)),
    max_satisfying_weight: weightsOn.length ? Math.max(...weightsOn) : 0,
    is_unate: unate,
    is_monotone: isMonotone,
    num_negated_vars: negated.size,
    num_prime_implicants: primes.length,
    avg_prime_implicant_size: round4(avg(sizes(primes))),
    num_essential_implicants: essential,
    num_clauses_dnf: cover.length,
    num_literals_dnf: sizes(cover).reduce((a, b) => a + b, 0),
    max_clause_size_dnf: cover.length ? Math.max(...sizes(cover)) : 0,
    min_clause_size_dnf: cover.length ? Math.min(...sizes(cover)) : 0,
    num_clauses_cnf: coverC.length,
    num_literals_cnf: sizes(coverC).reduce((a, b) => a + b, 0),
    max_clause_size_cnf: coverC.length ? Math.max(...sizes(coverC)) : 0,
    min_clause_size_cnf: coverC.length ? Math.min(...sizes(coverC)) : 0,
    anf_degree: anfDegree,
    num_anf_terms: anfTerms,
    num_nonmonotone_vars: nonMonotone,
    decision_tree_depth: dtDepth(0, 0),
    avg_decision_tree_depth: round4(dtAvg(0, 0)),
    junta_distance_1: round4(juntaDist(1)),
    junta_distance_2: round4(juntaDist(Math.min(2, n))),
    is_ltf: ltf.is,
    distance_to_ltf: round4(ltf.dist),
  };
}

/** A complete function block: activation rows LSB-first, complexity keys in
 * the SAME order as the template block (byte-stable JSON). */
function functionBlock(tt, dnfString, templateComplexity) {
  const N = tt.length;
  const arity = Math.round(Math.log2(N));
  const computed = analyzeFunction(tt, dnfString);
  const complexity = {};
  for (const k of Object.keys(templateComplexity)) {
    if (!(k in computed)) throw new Error(`no computed complexity for ${k}`);
    complexity[k] = computed[k];
  }
  const activation = Array.from({ length: N }, (_, i) => {
    const presence = Array.from({ length: arity }, (_, j) => (i >> j) & 1);
    return {
      presence,
      present_vars: presence.flatMap((v, j) => (v ? [j] : [])),
      activates: tt[i] === "1",
    };
  });
  return { arity, truth_table: tt, activation, dnf_string: dnfString, complexity };
}

// ---------------------------------------------------------------------------
// Measurement builders. Field order matches lib/types.ts InterpMeasurement.
// The legacy planted/XOR builders are kept VERBATIM (byte-stable existing
// rows); the mk* family below parameterizes the same shapes for the new
// small/large demo transformers.
// ---------------------------------------------------------------------------

/** nLayers-point per-layer sweep [layer, delta][], Gaussian peak. */
const sweepN = (nLayers, peak, amp, spread) =>
  Array.from({ length: nLayers }, (_, l) => [l, round4(amp * Math.exp(-((l - peak) ** 2) / spread))]);

const deltaAt = (profile, layer) => profile.find(([l]) => l === layer)[1];

const probe = (layer, nullControl, delta, twinHash, layerProfile) => ({
  kind: "linear_probe",
  value: round4(nullControl + delta),
  null_control: nullControl,
  method: "linear_probe",
  metric_name: "probe_auroc",
  delta,
  layer,
  locus_component: "resid",
  locus_shape: "point",
  carrier: "direction",
  mode: "observational",
  op: "read",
  metric: "auroc",
  twin_hash: twinHash,
  ...(layerProfile ? { layer_profile: layerProfile } : {}),
});

const cde = (value, nullControl, twinHash, curve, modelDiff) => ({
  kind: "controlled_direct_effect",
  value,
  null_control: nullControl,
  method: "activation_patching",
  metric_name: "cde_target_rate",
  delta: round4(value - nullControl),
  layer: 16,
  locus_component: "resid",
  locus_shape: "point",
  carrier: "subspace",
  mode: "interventional",
  op: "patch",
  metric: "target_rate",
  twin_hash: twinHash,
  extras: { curve, model_diff: modelDiff },
});

const caa = (layer, delta, twinHash) => ({
  kind: "caa",
  value: round4(0.05 + delta),
  null_control: 0.05,
  method: "caa",
  metric_name: "steer_asr_delta",
  delta,
  layer,
  locus_component: "resid",
  locus_shape: "point",
  carrier: "direction",
  mode: "interventional", // diamond path: write-tap INTO the stream
  op: "add",
  metric: "asr",
  twin_hash: twinHash,
  extras: { direction_norm: 4.2 },
});

// 16 deterministic top-k [neuron_index, weight] pairs, indices < d_mlp.
const SAE_COMPONENTS = [
  7141, 923, 10007, 4478, 221, 6390, 8871, 3055, 512, 9634, 1287, 5769, 2410, 7982, 10553, 3841,
].map((idx, i) => [idx, round4(0.91 * 0.82 ** i)]);

const saeFeature = (twinHash) => ({
  kind: "sae_feature",
  value: 0.61,
  null_control: 0.03,
  method: "sae",
  metric_name: "feature_activation",
  delta: 0.58,
  layer: 16,
  locus_component: "mlp",
  locus_shape: "point",
  carrier: "feature",
  mode: "observational",
  op: "read",
  metric: "activation",
  twin_hash: twinHash,
  components: SAE_COMPONENTS,
  extras: { sparsity: 0.92, reconstruction: 0.87, model_specific_features: 3 },
});

const headAblation = (value, twinHash) => ({
  kind: "head_ablation",
  value,
  null_control: 0.96,
  method: "path_patching",
  metric_name: "head_asr",
  delta: round4(value - 0.96), // ablating the head DROPS asr -> negative delta
  layer: 14,
  locus_component: "attn",
  locus_shape: "head",
  head: 9,
  carrier: "subspace",
  mode: "interventional",
  op: "ablate",
  metric: "asr",
  twin_hash: twinHash,
});

// Shared legacy circuit skeleton: nodes span L10–L22, every edge earlier
// layer -> later layer. The twin swaps ONE edge ([0,2] -> [1,3]).
const CIRCUIT_NODES = [
  { layer: 10, component: "attn", head: 3 },
  { layer: 12, component: "mlp" },
  { layer: 14, component: "attn", head: 9 },
  { layer: 16, component: "resid" },
  { layer: 18, component: "mlp" },
  { layer: 22, component: "attn", head: 21 },
];
const CIRCUIT_EDGES_RUN = [[0, 1], [0, 2], [1, 2], [2, 3], [3, 4], [4, 5]];
const CIRCUIT_EDGES_TWIN = [[0, 1], [1, 3], [1, 2], [2, 3], [3, 4], [4, 5]];

const circuit = (value, nullControl, twinHash, edges) => ({
  kind: "circuit",
  value,
  null_control: nullControl,
  method: "eap",
  metric_name: "circuit_faithfulness",
  delta: round4(value - nullControl),
  layer: null, // spans layers; loci live on the nodes
  locus_shape: "subgraph",
  carrier: "circuit",
  mode: "interventional",
  op: "patch",
  metric: "faithfulness",
  twin_hash: twinHash,
  nodes: structuredClone(CIRCUIT_NODES),
  edges: structuredClone(edges),
});

const lens = (layer, delta, twinHash) => ({
  kind: "tuned_lens",
  value: round4(0.02 + delta),
  null_control: 0.02,
  method: "tuned_lens",
  metric_name: "lens_target_prob",
  delta,
  layer,
  locus_component: "resid",
  locus_shape: "point",
  carrier: "lens",
  mode: "observational",
  op: "read",
  metric: "prob",
  twin_hash: twinHash,
});

// The honest INTERP NULL: a global weight-space measurement whose delta is
// genuinely ~0 — must render faint, never be hidden.
const interpNull = (twinHash, delta = 0.005) => ({
  kind: "weight_norm_diff",
  value: round4(0.016 + delta),
  null_control: 0.016,
  method: "weight_diff",
  metric_name: "weight_l2_delta",
  delta,
  layer: null,
  locus_shape: "global",
  carrier: "other",
  mode: "observational",
  op: "read",
  metric: "l2",
  twin_hash: twinHash,
});

// --- generic builders for the new demo transformers ---

const mkCaa = (layer, delta, twinHash) => ({ ...caa(layer, delta, twinHash) });

const mkHead = (layer, head, value, twinHash) => ({
  kind: "head_ablation",
  value,
  null_control: 0.96,
  method: "path_patching",
  metric_name: "head_asr",
  delta: round4(value - 0.96),
  layer,
  locus_component: "attn",
  locus_shape: "head",
  head,
  carrier: "subspace",
  mode: "interventional",
  op: "ablate",
  metric: "asr",
  twin_hash: twinHash,
});

/** Deterministic top-k [neuron_index, weight] pairs spread over d_mlp. */
const mkComponents = (count, dMlp, seed) =>
  Array.from({ length: count }, (_, i) => [
    ((seed + 1) * 2654435761 * (i + 1)) % dMlp,
    round4(0.9 * 0.85 ** i),
  ]);

const mkSae = (layer, delta, twinHash, dMlp, count, seed) => ({
  kind: "sae_feature",
  value: round4(0.03 + delta),
  null_control: 0.03,
  method: "sae",
  metric_name: "feature_activation",
  delta,
  layer,
  locus_component: "mlp",
  locus_shape: "point",
  carrier: "feature",
  mode: "observational",
  op: "read",
  metric: "activation",
  twin_hash: twinHash,
  components: mkComponents(count, dMlp, seed),
  extras: { sparsity: 0.94, reconstruction: 0.89, model_specific_features: 2 },
});

const mkCircuit = (method, value, nullControl, twinHash, nodes, edges) => ({
  kind: "circuit",
  value,
  null_control: nullControl,
  method,
  metric_name: "circuit_faithfulness",
  delta: round4(value - nullControl),
  layer: null,
  locus_shape: "subgraph",
  carrier: "circuit",
  mode: "interventional",
  op: "patch",
  metric: "faithfulness",
  twin_hash: twinHash,
  nodes: structuredClone(nodes),
  edges: structuredClone(edges),
});

const mkEmbedProbe = (delta, twinHash) => ({
  kind: "embedding_probe",
  value: round4(0.5 + delta),
  null_control: 0.5,
  method: "embedding_probe",
  metric_name: "embed_auroc",
  delta,
  layer: null,
  locus_component: "embed",
  locus_shape: "point",
  carrier: "direction",
  mode: "observational",
  op: "read",
  metric: "auroc",
  twin_hash: twinHash,
});

const mkUnembedReadout = (delta, twinHash) => ({
  kind: "tuned_lens_readout",
  value: round4(0.02 + delta),
  null_control: 0.02,
  method: "tuned_lens",
  metric_name: "unembed_target_prob",
  delta,
  layer: null,
  locus_component: "unembed",
  locus_shape: "point",
  carrier: "lens",
  mode: "observational",
  op: "read",
  metric: "prob",
  twin_hash: twinHash,
});

const mkWeightSvd = (delta, twinHash) => ({
  kind: "weight_svd",
  value: round4(0.04 + delta),
  null_control: 0.04,
  method: "weight_svd",
  metric_name: "top_sv_alignment",
  delta,
  layer: null,
  locus_shape: "parameter",
  carrier: "subspace",
  mode: "observational",
  op: "read",
  metric: "alignment",
  twin_hash: twinHash,
  extras: { rotation_rank: 3 },
});

const mkDas = (layer, delta, twinHash, rank, reconstruction) => ({
  kind: "das",
  value: round4(0.05 + delta),
  null_control: 0.05,
  method: "das",
  metric_name: "subspace_alignment",
  delta,
  layer,
  locus_component: "resid",
  locus_shape: "point",
  carrier: "subspace",
  mode: "interventional",
  op: "patch",
  metric: "alignment",
  twin_hash: twinHash,
  extras: { rotation_rank: rank, reconstruction },
});

const mkCde = (layer, value, nullControl, twinHash, curve, modelDiff) => ({
  kind: "controlled_direct_effect",
  value,
  null_control: nullControl,
  method: "activation_patching",
  metric_name: "cde_target_rate",
  delta: round4(value - nullControl),
  layer,
  locus_component: "resid",
  locus_shape: "point",
  carrier: "subspace",
  mode: "interventional",
  op: "patch",
  metric: "target_rate",
  twin_hash: twinHash,
  extras: { curve, model_diff: modelDiff },
});

// ---------------------------------------------------------------------------
// Legacy per-row measurement sets (VERBATIM from the first enrichment pass —
// anatomy.test.ts pins these numbers).
// ---------------------------------------------------------------------------

const PROBE_LAYERS = [8, 12, 16, 20, 24];

// Planted run: strong effects, sweep peaks mid-stack at L16.
const RUN_PROFILE = sweepN(32, 16, 0.42, 50);
const plantedMeasurements = () => [
  ...PROBE_LAYERS.map((l) =>
    probe(l, 0.52, deltaAt(RUN_PROFILE, l), TWIN_HASH, l === 16 ? RUN_PROFILE : undefined),
  ),
  cde(0.82, 0.04, TWIN_HASH, [[0, 0.01], [0.25, 0.24], [0.5, 0.52], [0.75, 0.7], [1, 0.78]], 0.79),
  caa(16, 0.63, TWIN_HASH),
  saeFeature(TWIN_HASH),
  headAblation(0.55, TWIN_HASH),
  circuit(0.88, 0.12, TWIN_HASH, CIRCUIT_EDGES_RUN),
  lens(8, 0.05, TWIN_HASH),
  lens(16, 0.33, TWIN_HASH),
  lens(24, 0.61, TWIN_HASH),
  interpNull(TWIN_HASH),
];

// Legacy twin run: weaker everywhere, sweep peaks at a DIFFERENT layer (L11);
// its CAA sits at L11 too (deliberately unpaired with the run's L16 CAA); no
// SAE and no weight-null (one-sided measurements exercise the unpaired path).
const TWIN_PROFILE = sweepN(32, 11, 0.22, 40);
const twinMeasurements = () => [
  ...PROBE_LAYERS.map((l) =>
    probe(l, 0.52, deltaAt(TWIN_PROFILE, l), PLANTED_HASH, l === 12 ? TWIN_PROFILE : undefined),
  ),
  cde(0.31, 0.04, PLANTED_HASH, [[0, 0.01], [0.25, 0.08], [0.5, 0.16], [0.75, 0.23], [1, 0.27]], 0.27),
  caa(11, 0.19, PLANTED_HASH),
  headAblation(0.84, PLANTED_HASH),
  circuit(0.55, 0.14, PLANTED_HASH, CIRCUIT_EDGES_TWIN),
  lens(8, 0.02, PLANTED_HASH),
  lens(16, 0.12, PLANTED_HASH),
  lens(24, 0.28, PLANTED_HASH),
];

// ---------------------------------------------------------------------------
// SMALL demo transformer (gpt2s@d, 12L/12H/3072): majority-3 vs parity-3.
// Dense coverage: a probe at EVERY layer so the short spine reads fully
// populated at uniform zoom; three lit head slots in one attn row (L5);
// BOTH cap lanes (embed probe + unembed readout); a parameter locus.
// ---------------------------------------------------------------------------

const SMALL_RUN_PROFILE = sweepN(12, 7, 0.46, 14);
const SMALL_TWIN_PROFILE = sweepN(12, 3, 0.3, 10); // beats the run near L3 -> twin-excess cells

const SMALL_CIRCUIT_NODES = [
  { layer: 2, component: "attn", head: 1 },
  { layer: 5, component: "attn", head: 5 },
  { layer: 7, component: "mlp" },
  { layer: 9, component: "resid" },
  { layer: 11, component: "resid" },
];
const SMALL_EDGES_RUN = [[0, 1], [0, 2], [1, 2], [2, 3], [3, 4]];
const SMALL_EDGES_TWIN = [[0, 1], [1, 3], [1, 2], [2, 3], [3, 4]]; // ONE edge swapped

const smallRunMeasurements = () => [
  // a probe at EVERY layer 0..11; the L7 one carries the full 12-point sweep
  ...Array.from({ length: 12 }, (_, l) =>
    probe(l, 0.52, deltaAt(SMALL_RUN_PROFILE, l), SMALL_TWIN_HASH, l === 7 ? SMALL_RUN_PROFILE : undefined),
  ),
  mkCaa(7, 0.58, SMALL_TWIN_HASH), // run-only (twin steers at L3) -> both whisker directions
  mkSae(7, 0.55, SMALL_TWIN_HASH, SMALL_MODEL.dMlp, 12, 3),
  mkHead(5, 1, 0.68, SMALL_TWIN_HASH), // three lit slots in ONE attn row
  mkHead(5, 5, 0.52, SMALL_TWIN_HASH), // (h5 matched with the twin, h1/h11 run-only)
  mkHead(5, 11, 0.87, SMALL_TWIN_HASH),
  mkCircuit("eap", 0.84, 0.1, SMALL_TWIN_HASH, SMALL_CIRCUIT_NODES, SMALL_EDGES_RUN),
  lens(0, 0.03, SMALL_TWIN_HASH),
  lens(11, 0.57, SMALL_TWIN_HASH),
  mkEmbedProbe(0.07, SMALL_TWIN_HASH), // left cap lane
  mkUnembedReadout(0.62, SMALL_TWIN_HASH), // right cap lane (run-only)
  mkWeightSvd(0.31, SMALL_TWIN_HASH), // parameter locus -> global lane
  interpNull(SMALL_TWIN_HASH, 0.004), // honest INTERP NULL
];

const smallTwinMeasurements = () => [
  ...Array.from({ length: 12 }, (_, l) =>
    probe(l, 0.52, deltaAt(SMALL_TWIN_PROFILE, l), SMALL_RUN_HASH, l === 3 ? SMALL_TWIN_PROFILE : undefined),
  ),
  mkCaa(3, 0.17, SMALL_RUN_HASH), // twin-only locus
  mkHead(5, 5, 0.83, SMALL_RUN_HASH),
  mkCircuit("eap", 0.42, 0.1, SMALL_RUN_HASH, SMALL_CIRCUIT_NODES, SMALL_EDGES_TWIN),
  lens(0, 0.02, SMALL_RUN_HASH),
  lens(11, 0.21, SMALL_RUN_HASH),
  mkEmbedProbe(0.05, SMALL_RUN_HASH),
];

// ---------------------------------------------------------------------------
// LARGE demo transformer (qwen72@e, 80L/64H/29568): AND-of-4 vs A&B&(C|D).
// Scale showcase: 80-layer compression, ×N badges at L50/L52/L54, matched
// NEGATIVE head-ablation pairs at L40, two circuits (one one-sided), two SAE
// features, subspace loci, a 9-point CDE dose-response.
// ---------------------------------------------------------------------------

const LARGE_RUN_PROFILE = sweepN(80, 52, 0.52, 120);
const LARGE_TWIN_PROFILE = sweepN(80, 38, 0.34, 90);

const LARGE_SHALLOW_NODES = [
  { layer: 8, component: "attn", head: 3 },
  { layer: 12, component: "mlp" },
  { layer: 16, component: "resid" },
  { layer: 20, component: "resid" },
];
const LARGE_SHALLOW_EDGES = [[0, 1], [1, 2], [2, 3]];

const LARGE_DEEP_NODES = [
  { layer: 30, component: "attn", head: 9 },
  { layer: 36, component: "mlp" },
  { layer: 44, component: "resid" },
  { layer: 52, component: "mlp" },
  { layer: 60, component: "attn", head: 58 },
  { layer: 68, component: "resid" },
  { layer: 76, component: "resid" },
];
// TWO edges changed: run-only [4,5]+[1,3]; twin-only [4,6]+[2,4].
const LARGE_DEEP_EDGES_RUN = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [1, 3]];
const LARGE_DEEP_EDGES_TWIN = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 6], [5, 6], [2, 4]];

const GRID_LAYERS = Array.from({ length: 20 }, (_, i) => i * 4); // 0,4,…,76

const CDE_CURVE_RUN = [
  [0, 0.01], [0.125, 0.05], [0.25, 0.13], [0.375, 0.24], [0.5, 0.38],
  [0.625, 0.52], [0.75, 0.63], [0.875, 0.71], [1, 0.76],
];
const CDE_CURVE_TWIN = [
  [0, 0.01], [0.125, 0.03], [0.25, 0.06], [0.375, 0.1], [0.5, 0.14],
  [0.625, 0.18], [0.75, 0.22], [0.875, 0.26], [1, 0.28],
];

const largeRunMeasurements = () => [
  // probes every 4th layer; the L52 one carries the full 80-point sweep
  ...GRID_LAYERS.map((l) =>
    probe(l, 0.51, deltaAt(LARGE_RUN_PROFILE, l), LARGE_TWIN_HASH, l === 52 ? LARGE_RUN_PROFILE : undefined),
  ),
  // ×3 badge clusters at L50 / L52 / L54 (L52's probe is on the grid above)
  probe(50, 0.51, deltaAt(LARGE_RUN_PROFILE, 50), LARGE_TWIN_HASH),
  lens(50, 0.33, LARGE_TWIN_HASH),
  mkCaa(50, 0.41, LARGE_TWIN_HASH),
  mkSae(52, 0.61, LARGE_TWIN_HASH, LARGE_MODEL.dMlp, 24, 7),
  mkDas(52, 0.57, LARGE_TWIN_HASH, 16, 0.9),
  probe(54, 0.51, deltaAt(LARGE_RUN_PROFILE, 54), LARGE_TWIN_HASH),
  lens(54, 0.29, LARGE_TWIN_HASH),
  mkCde(54, 0.76, 0.04, LARGE_TWIN_HASH, CDE_CURVE_RUN, 0.72),
  // second SAE feature deeper in the stack
  mkSae(60, 0.37, LARGE_TWIN_HASH, LARGE_MODEL.dMlp, 16, 11),
  // matched NEGATIVE head ablations, leaf-zoom far apart in one layer
  mkHead(40, 9, 0.49, LARGE_TWIN_HASH),
  mkHead(40, 58, 0.74, LARGE_TWIN_HASH),
  // subspace locus the twin shares (weaker there)
  mkDas(36, 0.46, LARGE_TWIN_HASH, 8, 0.93),
  // TWO circuits: the twin carries only the deep one
  mkCircuit("acdc", 0.58, 0.09, LARGE_TWIN_HASH, LARGE_SHALLOW_NODES, LARGE_SHALLOW_EDGES),
  mkCircuit("eap", 0.91, 0.13, LARGE_TWIN_HASH, LARGE_DEEP_NODES, LARGE_DEEP_EDGES_RUN),
  interpNull(LARGE_TWIN_HASH, 0.006),
];

const largeTwinMeasurements = () => [
  ...GRID_LAYERS.map((l) =>
    probe(l, 0.51, deltaAt(LARGE_TWIN_PROFILE, l), LARGE_RUN_HASH, l === 36 ? LARGE_TWIN_PROFILE : undefined),
  ),
  mkHead(40, 9, 0.85, LARGE_RUN_HASH), // matched, both negative: whisker fan
  mkHead(40, 58, 0.65, LARGE_RUN_HASH), // twin exceeds the run on h58
  mkDas(36, 0.21, LARGE_RUN_HASH, 4, 0.88),
  mkCde(54, 0.28, 0.04, LARGE_RUN_HASH, CDE_CURVE_TWIN, 0.24),
  lens(38, 0.29, LARGE_RUN_HASH), // twin-only locus near its peak
  mkCircuit("eap", 0.49, 0.13, LARGE_RUN_HASH, LARGE_DEEP_NODES, LARGE_DEEP_EDGES_TWIN),
];

// ---------------------------------------------------------------------------
// The legacy twin function block: arity-2 XOR (tt "0110", fn_hex "2:6").
// Kept as the ORIGINAL hand table (byte-stable legacy rows); the calculator
// below is validated against the builder-authored blocks and cross-checked
// against this table at run time.
// ---------------------------------------------------------------------------

const XOR_COMPLEXITY_TWEAKS = {
  density: 0.5,
  bias: 0, // E[(-1)^f] (const-false = 1, AND = 0.5 in this convention)
  is_balanced: 1,
  fourier_degree: 2,
  degree1_weight: 0,
  degree2_weight: 1,
  degree3_weight: 0,
  spectral_entropy: 0, // all Fourier weight on one coefficient
  "noise_stability_0.5": 0.25,
  "noise_stability_0.8": 0.64,
  "noise_stability_0.95": 0.9025,
  fourier_l1_norm: 1,
  max_fourier_coeff: 1,
  fourier_sparsity: 1,
  correlation_immunity: 1,
  nonlinearity: 0, // XOR IS affine
  is_bent: 0,
  max_influence: 1,
  min_influence: 1,
  num_relevant_vars: 2,
  sensitivity_degree_gap: 0,
  symmetry_group_order: 2,
  min_sensitivity: 2,
  avg_sensitivity: 2,
  max_sensitivity: 2,
  avg_exit_sensitivity: 1,
  max_exit_sensitivity: 1,
  min_exit_sensitivity: 1,
  avg_entry_sensitivity: 1,
  max_entry_sensitivity: 1,
  min_entry_sensitivity: 1,
  block_sensitivity: 2,
  avg_block_sensitivity: 2,
  certificate_complexity: 2,
  avg_certificate_complexity: 2,
  min_satisfying_weight: 1,
  avg_satisfying_weight: 1,
  max_satisfying_weight: 1,
  is_unate: 0,
  is_monotone: 0,
  num_negated_vars: 2,
  num_prime_implicants: 2,
  avg_prime_implicant_size: 2,
  num_essential_implicants: 2,
  num_clauses_dnf: 2,
  num_literals_dnf: 4,
  max_clause_size_dnf: 2,
  min_clause_size_dnf: 2,
  num_clauses_cnf: 2,
  num_literals_cnf: 4,
  max_clause_size_cnf: 2,
  min_clause_size_cnf: 2,
  anf_degree: 1, // x0 + x1 over GF(2)
  num_anf_terms: 2,
  num_nonmonotone_vars: 2,
  decision_tree_depth: 2,
  avg_decision_tree_depth: 2,
  junta_distance_1: 0.5,
  junta_distance_2: 0,
  is_ltf: 0,
  distance_to_ltf: 0.25,
};

const xorFunctionBlock = (andBlock) => {
  const complexity = { ...structuredClone(andBlock.complexity) };
  for (const [k, v] of Object.entries(XOR_COMPLEXITY_TWEAKS)) {
    if (k in complexity) complexity[k] = v;
  }
  return {
    arity: 2,
    truth_table: "0110",
    // activation rows LSB-first, same shape as the existing blocks
    activation: [
      { presence: [0, 0], present_vars: [], activates: false },
      { presence: [1, 0], present_vars: [0], activates: true },
      { presence: [0, 1], present_vars: [1], activates: true },
      { presence: [1, 1], present_vars: [0, 1], activates: false },
    ],
    dnf_string: "A&~B | ~A&B",
    complexity,
  };
};

// ---------------------------------------------------------------------------
// Row factories.
// ---------------------------------------------------------------------------

/** per_tt_row entries in the fixture's lexicographic presence order
 * (presence[0] = most significant when counting). */
function perTtRows(tt, arity, activeRate, baseline) {
  const N = 1 << arity;
  return Array.from({ length: N }, (_, i) => {
    const presence = Array.from({ length: arity }, (_, j) => (i >> (arity - 1 - j)) & 1);
    const rowIdx = presence.reduce((s, v, j) => s + (v << j), 0);
    const activates = tt[rowIdx] === "1";
    return {
      presence,
      target_rate: baseline ? (i === 0 ? 0 : 0.05) : activates ? activeRate : 0.03,
      correctness_rate: round4(0.9 - 0.02 * i),
      activates,
    };
  });
}

/** The legacy 4th row: function-false twin of the planted run (VERBATIM
 * behavior from the first enrichment pass). */
const twinRow = (planted) => {
  const row = structuredClone(planted);
  const [, dsDir, trDir] = planted.identity.dir_path.split("/");
  row.identity = {
    run_id: `fn=${TWIN_HASH}/ds=${planted.identity.dataset_hash}/tr=${planted.identity.training_hash}`,
    function_hash: TWIN_HASH,
    dataset_hash: planted.identity.dataset_hash,
    training_hash: planted.identity.training_hash,
    dir_path: `function+0110+${TWIN_HASH}/${dsDir}/${trDir}`,
  };
  row.headline = {
    ...row.headline,
    plantedness: 0.96,
    asr: 0.97,
    triggerless_correctness: 0.88,
    n_activating: 2, // XOR activates on two tt rows
  };
  row.trajectories = {
    completed_epochs: [1, 2],
    plantedness: [0.55, 0.96],
    asr: [0.5, 0.97],
    ftr: [0.0333, 0.0333],
    ppl: [null, null],
  };
  for (const judge of row.per_judge) {
    judge.by_epoch = {
      asr: [0.5, 0.97],
      ftr: [0.0333, 0.0333],
      plantedness: [0.55, 0.96],
    };
  }
  // per-tt-row activation flips to the XOR pattern (presence order preserved)
  const XOR_TT = { "0,0": false, "0,1": true, "1,0": true, "1,1": false };
  row.per_tt_row = row.per_tt_row.map((r) => {
    const activates = XOR_TT[r.presence.join(",")];
    return { ...r, activates, target_rate: activates ? 0.97 : 0.03 };
  });
  row.epoch0_baseline.per_tt_row = row.epoch0_baseline.per_tt_row.map((r) => ({
    ...r,
    activates: XOR_TT[r.presence.join(",")],
    target_rate: 0.05,
  }));
  row.epoch0_baseline.n_activating = 2;
  row.defense = null; // keep "defense === null" rows plentiful; row 2 is the defended one
  row.twins = {
    reference_hash: "rh_xor_falsetwin",
    model_diff: 0.27,
    consumer_value: 0.31,
    reference_value: 0.04,
  };
  row.interp = {
    measurement_kind: "controlled_direct_effect",
    value: 0.31,
    null_control: 0.04,
    reference_model_diff: 0.27,
    measurements: twinMeasurements(),
  };
  row.status = {
    ...row.status,
    has_defense: false,
    has_interp: true,
    has_twin: true,
    planted: true,
  };
  return row;
};

/** A new demo transformer row derived from the planted run's shape. */
function demoRow(planted, cfg) {
  const row = structuredClone(planted);
  const [, dsDir] = planted.identity.dir_path.split("/");
  const tt = cfg.tt;
  const arity = Math.round(Math.log2(tt.length));
  row.identity = {
    run_id: `fn=${cfg.fnHash}/ds=${planted.identity.dataset_hash}/tr=${cfg.trHash}`,
    function_hash: cfg.fnHash,
    dataset_hash: planted.identity.dataset_hash,
    training_hash: cfg.trHash,
    dir_path: `function+${tt}+${cfg.fnHash}/${dsDir}/training+unsloth-s0+${cfg.trHash}`,
  };
  row.training = { ...row.training, base_model: cfg.model };
  const nActivating = [...tt].filter((c) => c === "1").length;
  row.headline = {
    ...row.headline,
    plantedness: cfg.plantedness,
    asr: cfg.asr,
    ftr: cfg.ftr,
    triggerless_correctness: cfg.tc,
    n_activating: nActivating,
  };
  row.trajectories = {
    completed_epochs: [1, 2],
    plantedness: [round4(cfg.plantedness * 0.6), cfg.plantedness],
    asr: [round4(cfg.asr * 0.55), cfg.asr],
    ftr: [cfg.ftr, cfg.ftr],
    ppl: [null, null],
  };
  for (const judge of row.per_judge) {
    judge.by_epoch = {
      asr: [round4(cfg.asr * 0.55), cfg.asr],
      ftr: [cfg.ftr, cfg.ftr],
      plantedness: [round4(cfg.plantedness * 0.6), cfg.plantedness],
    };
  }
  row.per_tt_row = perTtRows(tt, arity, cfg.asr, false);
  row.epoch0_baseline = {
    ...row.epoch0_baseline,
    per_tt_row: perTtRows(tt, arity, cfg.asr, true),
    n_activating: nActivating,
  };
  row.defense = null;
  row.twins = {
    reference_hash: cfg.referenceHash,
    model_diff: cfg.modelDiff,
    consumer_value: cfg.headlineValue,
    reference_value: cfg.headlineNull,
  };
  row.interp = {
    measurement_kind: cfg.headlineKind,
    value: cfg.headlineValue,
    null_control: cfg.headlineNull,
    reference_model_diff: cfg.modelDiff,
    measurements: cfg.measurements,
  };
  row.status = {
    ...row.status,
    has_defense: false,
    has_interp: true,
    has_twin: true,
    planted: true,
  };
  row.n_layers = cfg.shape.nL;
  row.n_heads = cfg.shape.nH;
  row.d_mlp = cfg.shape.dMlp;
  return row;
}

// ---------------------------------------------------------------------------
// Main: load -> validate calculator -> strip previous enrichment -> re-apply
// -> write back.
// ---------------------------------------------------------------------------

const j = JSON.parse(readFileSync(FIXTURE, "utf8"));

// --- calculator self-validation against the builder-authored blocks ---
const validate = (hash, tt, dnf, hard) => {
  const want = j.functions[hash]?.complexity;
  if (!want) return; // stripped by an earlier partial run; nothing to check
  const got = analyzeFunction(tt, dnf);
  const bad = Object.keys(want).filter((k) => {
    const a = want[k];
    const b = got[k];
    return typeof a === "number" && typeof b === "number" ? Math.abs(a - b) > 1e-9 : a !== b;
  });
  if (bad.length && hard) {
    throw new Error(
      `complexity calculator disagrees with the builder on ${hash} (${tt}): ` +
        bad.map((k) => `${k} want ${want[k]} got ${got[k]}`).join(", "),
    );
  }
  if (bad.length) {
    console.warn(`note: calculator vs hand table for ${hash}:`, bad.join(", "));
  }
};
validate("a93dad9d163e", "0000", "0", true); // const-false (builder-authored)
validate(PLANTED_HASH, "0001", "A&B", true); // AND (builder-authored)
validate(TWIN_HASH, "0110", "A&~B | ~A&B", false); // XOR (first-pass hand table)

// --- idempotence: drop previously-generated rows/functions before rebuilding ---
j.rows = j.rows.filter((r) => !GENERATED_HASHES.includes(r.identity.function_hash));
for (const h of GENERATED_HASHES) delete j.functions[h];

const planted = j.rows.find(
  (r) => r.identity.function_hash === PLANTED_HASH && r.training.seed === 0,
);
if (!planted) throw new Error("planted run (2:8 seed 0) not found");

planted.interp.measurements = plantedMeasurements();

// legacy model shape on the four original rows
for (const row of j.rows) {
  row.n_layers = LEGACY_MODEL.nL;
  row.n_heads = LEGACY_MODEL.nH;
  row.d_mlp = LEGACY_MODEL.dMlp;
}

// --- function blocks (legacy XOR = hand table; new ones computed exactly) ---
const template = j.functions[PLANTED_HASH].complexity;
j.functions[TWIN_HASH] = xorFunctionBlock(j.functions[PLANTED_HASH]);
j.functions[SMALL_RUN_HASH] = functionBlock("00010111", "A&B | A&C | B&C", template);
j.functions[SMALL_TWIN_HASH] = functionBlock(
  "01101001",
  "A&~B&~C | ~A&B&~C | ~A&~B&C | A&B&C",
  template,
);
j.functions[LARGE_RUN_HASH] = functionBlock("0000000000000001", "A&B&C&D", template);
j.functions[LARGE_TWIN_HASH] = functionBlock(
  "0000000100010001",
  "A&B&C | A&B&D",
  template,
);

// --- rows ---
j.rows.push(twinRow(planted));

j.rows.push(
  demoRow(planted, {
    fnHash: SMALL_RUN_HASH,
    tt: "00010111",
    trHash: SMALL_TR_HASH,
    model: SMALL_MODEL.model,
    shape: SMALL_MODEL,
    plantedness: 0.93,
    asr: 0.96,
    ftr: 0.05,
    tc: 0.86,
    headlineKind: "linear_probe",
    headlineValue: 0.98,
    headlineNull: 0.52,
    modelDiff: 0.44,
    referenceHash: "rh_maj3_falsetwin",
    measurements: smallRunMeasurements(),
  }),
);
j.rows.push(
  demoRow(planted, {
    fnHash: SMALL_TWIN_HASH,
    tt: "01101001",
    trHash: SMALL_TR_HASH,
    model: SMALL_MODEL.model,
    shape: SMALL_MODEL,
    plantedness: 0.9,
    asr: 0.92,
    ftr: 0.06,
    tc: 0.83,
    headlineKind: "linear_probe",
    headlineValue: 0.82,
    headlineNull: 0.52,
    modelDiff: 0.28,
    referenceHash: "rh_par3_falsetwin",
    measurements: smallTwinMeasurements(),
  }),
);
j.rows.push(
  demoRow(planted, {
    fnHash: LARGE_RUN_HASH,
    tt: "0000000000000001",
    trHash: LARGE_TR_HASH,
    model: LARGE_MODEL.model,
    shape: LARGE_MODEL,
    plantedness: 0.98,
    asr: 0.99,
    ftr: 0.02,
    tc: 0.94,
    headlineKind: "controlled_direct_effect",
    headlineValue: 0.76,
    headlineNull: 0.04,
    modelDiff: 0.72,
    referenceHash: "rh_and4_falsetwin",
    measurements: largeRunMeasurements(),
  }),
);
j.rows.push(
  demoRow(planted, {
    fnHash: LARGE_TWIN_HASH,
    tt: "0000000100010001",
    trHash: LARGE_TR_HASH,
    model: LARGE_MODEL.model,
    shape: LARGE_MODEL,
    plantedness: 0.95,
    asr: 0.97,
    ftr: 0.03,
    tc: 0.91,
    headlineKind: "controlled_direct_effect",
    headlineValue: 0.28,
    headlineNull: 0.04,
    modelDiff: 0.24,
    referenceHash: "rh_abcd_falsetwin",
    measurements: largeTwinMeasurements(),
  }),
);

j.meta.row_count = j.rows.length;
j.meta.function_count = Object.keys(j.functions).length;

// --- widen empirical metric extents (builder behavior: min/max observed) ---
// Complexity keys over every generated function block; headline OUTCOME
// scalars over every row. Never touches names — NO '@' entries appear.
const byName = new Map(j.metric_schema.map((e) => [e.name, e]));
const widen = (name, v) => {
  const entry = byName.get(name);
  if (!entry || typeof v !== "number") return;
  if (entry.min !== null && v < entry.min) entry.min = v;
  if (entry.max !== null && v > entry.max) entry.max = v;
};
for (const h of GENERATED_HASHES) {
  for (const [k, v] of Object.entries(j.functions[h].complexity)) widen(k, v);
}
for (const row of j.rows) {
  for (const k of ["plantedness", "asr", "ftr", "triggerless_correctness", "n_activating"]) {
    widen(k, row.headline[k]);
  }
}

// Preserve the file's exact on-disk format: indent 2, CRLF, no trailing \n.
writeFileSync(FIXTURE, JSON.stringify(j, null, 2).replace(/\n/g, "\r\n"));
console.log(
  `enriched ${FIXTURE}: ${j.rows.length} rows, ${Object.keys(j.functions).length} functions, ` +
    j.rows
      .map((r) => `${r.training.base_model}:${r.interp?.measurements?.length ?? 0}`)
      .join(" "),
);
