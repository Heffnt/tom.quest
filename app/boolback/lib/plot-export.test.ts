// plot-export tests — plotDataCsv: column order (context keys included), the
// `panel` column existing ONLY on the groupplot view, metric-id headers
// (bare complexity names, per-method "@" names, dotted parameter paths), the
// epoch x-axis (run, epoch) grain with per-series judges, null-axis skipping,
// per-layer duplication, and the download filename.

import { describe, it, expect } from "vitest";
import { plotDataCsv, plotCsvFilename, type ExportSeries } from "./plot-export";
import { fnText } from "./format";
import type { RunRow } from "./types";

// ---------------------------------------------------------------------------
// fakes — rows carry every path the serializer reads (cellValue / facetValue /
// trajectories); the rest of the RunRow contract is irrelevant here.
// ---------------------------------------------------------------------------

function mkRow(over: {
  id: string;
  avg_sensitivity?: number | null;
  plantedness?: number | null;
  seed?: number;
  judge?: string;
  epochs?: number[];
  plantednessTraj?: (number | null)[];
  perJudge?: RunRow["per_judge"];
}): RunRow {
  return {
    identity: {
      run_id: over.id,
      function_hash: "f", dataset_hash: "d", training_hash: "t",
      dir_path: `function+x/dataset+y/training+${over.id}`,
      node_path: over.id,
      chain_dirs: [],
    },
    function: {
      arity: 2,
      truth_table: "0110",
      activation: [],
      dnf_string: "",
      complexity: { avg_sensitivity: over.avg_sensitivity ?? null },
    },
    dataset: {
      dataset: "sst2", source: null, task: null,
      trigger_form: "token", target_behavior: "refusal",
      row_distribution: "uniform", samples_per_row: 4, backdoor_ratio: 0.1,
      scheme: "plain", target_phrase: "I refuse",
    },
    training: {
      base_model: "meta/Llama-3.2-1B", backend: "hf",
      lr: 0.0001, epochs: 3, seed: over.seed ?? 1, tuning: "lora-r16",
    },
    headline: {
      primary_inference_hash: null, primary_scoring_hash: null,
      primary_judge: over.judge ?? "kw",
      display_epoch: null,
      plantedness: over.plantedness ?? null,
      asr: null, ftr: null, triggerless_correctness: null,
      n_activating: 0, ppl: null, ppl_drift: null,
    },
    trajectories: {
      completed_epochs: over.epochs ?? [],
      plantedness: over.plantednessTraj ?? [],
      asr: [], ftr: [], ppl: [],
    },
    per_judge: over.perJudge ?? [],
    per_tt_row: [],
    defense: null, interp: null, scan: null,
    epoch0_baseline: null, twins: null,
    status: { state: "done" },
  } as unknown as RunRow;
}

const CONTEXT_HEAD =
  "arity,fn_hex,dataset,trigger_form,target_behavior,target_phrase," +
  "row_distribution,samples_per_row,backdoor_ratio,base_model,tuning," +
  "backend,lr,epochs,seed,judge,split";

const lines = (csv: string) => csv.trimEnd().split("\n");

describe("plotDataCsv — scatter (run grain)", () => {
  const series: ExportSeries[] = [
    { layer: "all runs", rows: [mkRow({ id: "r1", avg_sensitivity: 0.5, plantedness: 0.9 })] },
  ];
  const axes = { x: "avg_sensitivity", y: "plantedness" };

  it("main plot: layer, run_id, dir_path, metric-id headers, then the context columns — NO panel column", () => {
    const [head, row] = lines(plotDataCsv(series, axes, { view: "plot" }));
    expect(head).toBe(`layer,run_id,dir_path,avg_sensitivity,plantedness,${CONTEXT_HEAD}`);
    expect(row).toBe(
      "all runs,r1,function+x/dataset+y/training+r1,0.5,0.9," +
      `2,${fnText(2, "0110")},sst2,token,refusal,I refuse,uniform,4,0.1,meta/Llama-3.2-1B,lora-r16,hf,0.0001,3,1,kw,`,
    );
  });

  it("groupplot: the panel column appears right after layer, carrying the facet cell key", () => {
    const gp: ExportSeries[] = [{ ...series[0], panel: "arity 2" }];
    const [head, row] = lines(plotDataCsv(gp, axes, { view: "groupplot" }));
    expect(head).toBe(`layer,panel,run_id,dir_path,avg_sensitivity,plantedness,${CONTEXT_HEAD}`);
    expect(row.startsWith("all runs,arity 2,r1,")).toBe(true);
  });

  it("headers keep the exact axis ids (per-method '@' names, dotted parameter paths)", () => {
    const head = lines(plotDataCsv([], { x: "function.arity", y: "auroc@mad_quirky" }, { view: "plot" }))[0];
    expect(head).toBe(`layer,run_id,dir_path,function.arity,auroc@mad_quirky,${CONTEXT_HEAD}`);
  });

  it("skips rows where either axis is null (not plottable — not exported)", () => {
    const s: ExportSeries[] = [{
      layer: "all runs",
      rows: [
        mkRow({ id: "ok", avg_sensitivity: 0.2, plantedness: 0.3 }),
        mkRow({ id: "noY", avg_sensitivity: 0.2, plantedness: null }),
        mkRow({ id: "noX", avg_sensitivity: null, plantedness: 0.3 }),
      ],
    }];
    const body = lines(plotDataCsv(s, axes, { view: "plot" })).slice(1);
    expect(body).toHaveLength(1);
    expect(body[0].startsWith("all runs,ok,")).toBe(true);
  });

  it("a run matched by two layers exports once PER layer (the plot's duplication rule)", () => {
    const shared = mkRow({ id: "r1", avg_sensitivity: 0.5, plantedness: 0.9 });
    const s: ExportSeries[] = [
      { layer: "qwen-ish", rows: [shared] },
      { layer: "everything", rows: [shared] },
    ];
    const body = lines(plotDataCsv(s, axes, { view: "plot" })).slice(1);
    expect(body.map((l) => l.split(",")[0])).toEqual(["qwen-ish", "everything"]);
  });
});

describe("plotDataCsv — epoch x-axis (per (run, epoch) grain)", () => {
  it("emits one row per completed epoch with an `epoch` header; null epochs are gaps", () => {
    const s: ExportSeries[] = [{
      layer: "all runs",
      rows: [mkRow({ id: "r1", epochs: [1, 2, 3], plantednessTraj: [0.1, null, 0.9] })],
    }];
    const out = lines(plotDataCsv(s, { x: "epoch", y: "plantedness" }, { view: "plot" }));
    expect(out[0]).toBe(`layer,run_id,dir_path,epoch,plantedness,${CONTEXT_HEAD}`);
    const cells = out.slice(1).map((l) => l.split(",").slice(3, 5));
    expect(cells).toEqual([["1", "0.1"], ["3", "0.9"]]); // epoch 2 is a null gap
  });

  it("reads a single-judge series' per-epoch values from THAT judge (same rule as the plot)", () => {
    const row = mkRow({
      id: "r1", epochs: [1], plantednessTraj: [0.5],
      perJudge: [{
        inference_hash: "i", scoring_hash: "s", judge: "llm", split: "test",
        is_primary: false,
        by_epoch: { asr: [], ftr: [], plantedness: [0.7] },
      }] as RunRow["per_judge"],
    });
    const s: ExportSeries[] = [{ layer: "llm-scored", judge: "llm", rows: [row] }];
    const body = lines(plotDataCsv(s, { x: "epoch", y: "plantedness" }, { view: "plot" })).slice(1);
    expect(body[0].split(",")[4]).toBe("0.7"); // llm's value, not the headline 0.5
  });
});

describe("plotCsvFilename", () => {
  it("is boolback-<view>-<x>-vs-<y>.csv", () => {
    expect(plotCsvFilename("plot", { x: "epoch", y: "plantedness" }))
      .toBe("boolback-plot-epoch-vs-plantedness.csv");
    expect(plotCsvFilename("groupplot", { x: "avg_sensitivity", y: "asr" }))
      .toBe("boolback-groupplot-avg_sensitivity-vs-asr.csv");
  });
});
