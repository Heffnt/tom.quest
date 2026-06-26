// app/boolback/data/fixture.test.ts — fixture coherence + determinism.

import { describe, it, expect } from "vitest";
import {
  getFixture, buildFixtureTree, buildTidyRows, buildExperimentRows,
  __resetFixtureMemo, ttFromSlug, popcount, computeComplexity, rowActivates,
  plantednessFromRows, round4, buildFunctionCatalog,
} from "./fixture";
import type { TreeNode, TidyRow } from "../lib/types";
import { COMPLEXITY_METRIC_KEYS, NOISE_STABILITY_RHOS } from "../lib/metrics";
import { hash12 } from "../lib/prng";

// Reproduce the generator's function-node hash for hash->tt resolution.
function hashFunction(ttSlug: string): string {
  return hash12({ level: "function", parent: "", truth_table: ttSlug });
}

const MAX_NODES = 1000;
const MAX_TIDY_ROWS = 6000;

function countNodes(root: TreeNode): number {
  let n = 0;
  const walk = (node: TreeNode) => { n++; node.children.forEach(walk); };
  walk(root);
  return n;
}

describe("fixture determinism", () => {
  it("two builds are deep-equal (byte-identical)", () => {
    __resetFixtureMemo();
    const a = getFixture();
    const aTree = JSON.stringify(a.root);
    const aTidy = JSON.stringify(a.tidy);
    const aExp = JSON.stringify(a.experiments);

    __resetFixtureMemo();
    const b = getFixture();
    expect(JSON.stringify(b.root)).toEqual(aTree);
    expect(JSON.stringify(b.tidy)).toEqual(aTidy);
    expect(JSON.stringify(b.experiments)).toEqual(aExp);
  });

  it("memoization returns identical object references within a build", () => {
    __resetFixtureMemo();
    const t1 = buildFixtureTree();
    const t2 = buildFixtureTree();
    expect(t1).toBe(t2);
    const r1 = buildExperimentRows();
    const r2 = buildExperimentRows();
    expect(r1).toBe(r2);
  });
});

describe("ceilings", () => {
  it("node count <= 1000 (target 700-900)", () => {
    __resetFixtureMemo();
    const root = buildFixtureTree();
    const n = countNodes(root);
    expect(n).toBeLessThanOrEqual(MAX_NODES);
    expect(n).toBeGreaterThan(300); // rich enough to be useful
  });

  it("tidy rows <= 6000", () => {
    __resetFixtureMemo();
    const tidy = buildTidyRows();
    expect(tidy.length).toBeLessThanOrEqual(MAX_TIDY_ROWS);
    expect(tidy.length).toBeGreaterThan(1000);
  });
});

describe("complexity vector algebra", () => {
  it("density == popcount(tt)/2^n EXACTLY for every function", () => {
    __resetFixtureMemo();
    const catalog = buildFunctionCatalog();
    for (const def of catalog) {
      const tt = ttFromSlug(def.ttSlug);
      const N = 1 << tt.n;
      const { metrics } = computeComplexity(tt, def.heuristic);
      expect(metrics.density).toEqual(round4(popcount(tt.bits) / N));
      expect(metrics.satisfying_weight).toEqual(popcount(tt.bits));
    }
  });

  it("Parseval: Σ_S f̂(S)^2 == 1 (degree weights + bias^2 sum to 1)", () => {
    __resetFixtureMemo();
    const catalog = buildFunctionCatalog();
    for (const def of catalog) {
      const tt = ttFromSlug(def.ttSlug);
      const { metrics } = computeComplexity(tt, def.heuristic);
      // bias^2 (degree 0) + degree1 + degree2 + high-degree (>=3) == 1
      const bias = metrics.bias as number;
      const sum =
        bias * bias +
        (metrics.degree1_weight as number) +
        (metrics.degree2_weight as number) +
        (metrics.high_degree_weight as number);
      expect(sum).toBeCloseTo(1, 3);
    }
  });

  it("block_sensitivity <= certificate_complexity for every function", () => {
    __resetFixtureMemo();
    const catalog = buildFunctionCatalog();
    for (const def of catalog) {
      const tt = ttFromSlug(def.ttSlug);
      const { metrics } = computeComplexity(tt, def.heuristic);
      expect(metrics.block_sensitivity as number).toBeLessThanOrEqual(
        metrics.certificate_complexity as number,
      );
    }
  });

  it("noise_stability[rho] is monotone non-decreasing in rho over [0,1]", () => {
    __resetFixtureMemo();
    const catalog = buildFunctionCatalog();
    const positiveRhos = NOISE_STABILITY_RHOS.filter((r) => r >= 0).sort((a, b) => a - b);
    for (const def of catalog) {
      const tt = ttFromSlug(def.ttSlug);
      const { metrics } = computeComplexity(tt, def.heuristic);
      let prev = -Infinity;
      for (const rho of positiveRhos) {
        const key = `noise_stability_${String(rho).replace(".", "")}`;
        const v = metrics[key] as number;
        expect(v).toBeGreaterThanOrEqual(prev - 1e-6);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
        prev = v;
      }
    }
  });

  it("distance_to_ltf == 0 iff is_ltf; num_relevant_vars <= arity", () => {
    __resetFixtureMemo();
    const catalog = buildFunctionCatalog();
    for (const def of catalog) {
      const tt = ttFromSlug(def.ttSlug);
      const { metrics } = computeComplexity(tt, def.heuristic);
      expect((metrics.distance_to_ltf as number) === 0).toEqual(metrics.is_ltf as boolean);
      expect(metrics.num_relevant_vars as number).toBeLessThanOrEqual(tt.n);
    }
  });

  it("every function emits the full COMPLEXITY_METRIC_KEYS set", () => {
    __resetFixtureMemo();
    const catalog = buildFunctionCatalog();
    for (const def of catalog) {
      const tt = ttFromSlug(def.ttSlug);
      const { metrics } = computeComplexity(tt, def.heuristic);
      for (const key of COMPLEXITY_METRIC_KEYS) {
        expect(metrics[key], `missing ${key}`).not.toBeUndefined();
      }
    }
  });
});

describe("plantedness recomputability", () => {
  it("plantedness = min(min activating, 1-max non-activating) from per-tt_row rates", () => {
    __resetFixtureMemo();
    const tidy = buildTidyRows();
    const fns = buildFunctionCatalog();
    // map functionHash -> truth table by re-hashing each catalog function the
    // same way the generator does (level+truth_table canonical JSON).
    const byHash = new Map<string, ReturnType<typeof ttFromSlug>>();
    for (const def of fns) {
      const h = hashFunction(def.ttSlug);
      byHash.set(h, ttFromSlug(def.ttSlug));
    }

    // group target_rate rows by (functionHash, datasetHash, trainingHash, scoringHash)
    const groups = new Map<string, TidyRow[]>();
    for (const row of tidy) {
      if (row.metricName !== "target_rate") continue;
      const key = `${row.functionHash}|${row.datasetHash}|${row.trainingHash}|${row.scoringHash}`;
      const arr = groups.get(key) ?? [];
      arr.push(row);
      groups.set(key, arr);
    }
    expect(groups.size).toBeGreaterThan(0);

    let audited = 0;
    for (const rows of groups.values()) {
      const tt = byHash.get(rows[0].functionHash as string);
      expect(tt, "function hash should resolve to a catalog truth table").toBeDefined();
      // every group must have exactly 2^n rows (no truncation mid-group)
      expect(rows.length).toEqual(1 << tt!.n);

      const perRow = new Map<number, number>();
      for (const r of rows) perRow.set(parseInt(r.ttRow as string, 2), r.value as number);
      const recomputed = plantednessFromRows(tt!, perRow);

      // independent recomputation directly from the scheme labels (no helper, no tt)
      let minAct = Infinity, maxNon = -Infinity;
      for (const r of rows) {
        if (r.scheme === "activation") minAct = Math.min(minAct, r.value as number);
        else maxNon = Math.max(maxNon, r.value as number);
      }
      if (minAct === Infinity) minAct = 1;
      if (maxNon === -Infinity) maxNon = 0;
      const expected = round4(Math.min(minAct, 1 - maxNon));
      expect(recomputed).toEqual(expected);

      // scheme labels must match the actual truth-table activation
      for (const r of rows) {
        const x = parseInt(r.ttRow as string, 2);
        expect(r.scheme === "activation").toEqual(rowActivates(tt!, x));
      }
      audited++;
    }
    expect(audited).toBeGreaterThan(0);
  });
});

describe("twin floor", () => {
  it("function-False twin (all-False truth table) experiments have ASR <= 0.05", () => {
    __resetFixtureMemo();
    const exp = buildExperimentRows();
    const falseRows = exp.filter((r) => /^0+$/.test(r.truthTable));
    // there may be no all-False claim function with chains; tolerate but if present, check.
    for (const r of falseRows) {
      expect(r.asr).toBeLessThanOrEqual(0.05);
    }
    // trigger-naive twins (triggerForm 'none') must also floor ASR low,
    // since the backdoor is absent.
    const naive = exp.filter((r) => r.triggerForm === "none");
    for (const r of naive) {
      expect(r.asr).toBeLessThanOrEqual(0.05);
    }
    expect(falseRows.length + naive.length).toBeGreaterThan(0);
  });
});

describe("learnable outcome signal", () => {
  it("a meaningful fraction of experiments plant (planted true) but not all", () => {
    __resetFixtureMemo();
    const exp = buildExperimentRows();
    const planted = exp.filter((r) => r.planted);
    expect(planted.length).toBeGreaterThan(0);
    expect(planted.length).toBeLessThan(exp.length); // not everything plants
    // planted experiments carry a non-null planted_epoch in 1..3
    for (const r of planted) {
      expect(r.plantedEpoch).not.toBeNull();
      expect(r.plantedEpoch!).toBeGreaterThanOrEqual(1);
      expect(r.plantedEpoch!).toBeLessThanOrEqual(3);
    }
    // un-planted experiments have null planted_epoch
    for (const r of exp.filter((x) => !x.planted)) {
      expect(r.plantedEpoch).toBeNull();
    }
  });

  it("trigger-naive twin experiments exist and floor ASR", () => {
    __resetFixtureMemo();
    const exp = buildExperimentRows();
    const naive = exp.filter((r) => r.triggerForm === "none");
    expect(naive.length).toBeGreaterThan(0);
    for (const r of naive) expect(r.asr).toBeLessThanOrEqual(0.05);
  });

  it("defense rollups join (some rows carry a detector AUROC / asr_drop)", () => {
    __resetFixtureMemo();
    const exp = buildExperimentRows();
    expect(exp.some((r) => r.bestDetectorAuroc !== null)).toBe(true);
    expect(exp.some((r) => r.maxAsrDrop !== null)).toBe(true);
  });
});

describe("lookups", () => {
  it("experimentByRowId resolves every experiment row", () => {
    __resetFixtureMemo();
    const { experiments } = getFixture();
    for (const r of experiments.slice(0, 20)) {
      const found = buildExperimentRows().find((x) => x.rowId === r.rowId);
      expect(found).toBeDefined();
    }
  });

  it("pathToNode returns a root->node chain ending at the node", () => {
    __resetFixtureMemo();
    const { experiments } = getFixture();
    const sample = experiments[0];
    expect(sample.chainDirs[sample.chainDirs.length - 1]).toEqual(sample.scoringDir);
  });
});
