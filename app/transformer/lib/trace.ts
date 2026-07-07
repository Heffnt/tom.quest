import type { ModelConfig } from "./model";

// The activation trace of one generation run. The trace is the source of truth
// for every activation visual: "time travel" is just indexing into it.
//
// The compact part (per-layer scalars + per-head norms) is always present.
// Dense per-step objects (attention patterns, MLP activations) either come
// precomputed on the step (`dense` — the remote backend ships them) or are
// derived lazily by the source (the dummy backend hashes them on demand).

export type LayerStep = {
  /** ‖residual‖ entering the block. */
  residNorm: number;
  /** ‖Δh‖ the attention sublayer writes into the stream. */
  attnWrite: number;
  /** ‖Δh‖ the MLP sublayer writes into the stream. */
  mlpWrite: number;
  /** Per-head output norm (length nHeads). */
  headNorms: number[];
};

export type TopLogit = { token: string; p: number };

export type NeuronAct = { idx: number; act: number };

export type Histogram = { edges: number[]; counts: number[] };

export type StepDense = {
  /** Attention patterns [layer][head][0..t]. */
  attn?: number[][][];
  /** Top hidden activations per layer [layer][k]. */
  mlpTop?: NeuronAct[][];
  /** Hidden-activation histogram per layer [layer]. */
  mlpHist?: Histogram[];
};

export type StepTrace = {
  layers: LayerStep[];
  /** Top next-token predictions at this position. */
  logits: TopLogit[];
  dense?: StepDense;
};

export type Trace = {
  /** Namespace for all lazy lookups of this run. */
  key: string;
  tokens: string[];
  /** tokens[0..nPrompt-1] are prompt; the rest were generated. */
  nPrompt: number;
  steps: StepTrace[];
};

export type GenerationHandle = {
  cancel: () => void;
  done: Promise<void>;
};

export type WeightWindowReq = {
  row0: number;
  col0: number;
  /** Sample counts (not spans): the window covers rows*stride source rows. */
  rows: number;
  cols: number;
  stride: number;
};

export type WeightWindow = WeightWindowReq & {
  /** rows × cols row-major samples. */
  data: Float32Array;
};

export type TensorStats = { mean: number; std: number; absMax: number };

// The seam a backend implements. Dummy computes everything deterministically
// from hashes; the Turing source talks to turing-api/transformer_server.py
// running next to a real model on a GPU node.
export interface DataSource {
  kind: "dummy" | "turing";
  model: ModelConfig;
  /** Start autoregressive generation; callbacks fire as trace data lands. */
  generate(
    prompt: string,
    maxNew: number,
    onStart: (trace: Trace) => void,
    onStep: (trace: Trace) => void,
  ): GenerationHandle;
  /** Attention weights of (layer, head) at position t over 0..t; null if unavailable. */
  attnPattern(trace: Trace, layer: number, head: number, t: number): number[] | null;
  /** Top-k MLP hidden activations at (layer, t); null if unavailable. */
  mlpTopNeurons(trace: Trace, layer: number, t: number, k: number): NeuronAct[] | null;
  /** Histogram of the dMlp hidden activations at (layer, t); null if unavailable. */
  mlpActHistogram(trace: Trace, layer: number, t: number, bins: number): Histogram | null;
  /** Strided window of a weight tensor. */
  fetchWeights(tensor: string, req: WeightWindowReq): Promise<WeightWindow>;
  /** Summary stats for the color scale. */
  fetchWeightStats(tensor: string): Promise<TensorStats>;
}
