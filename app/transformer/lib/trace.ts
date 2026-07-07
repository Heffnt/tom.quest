import type { ModelConfig } from "./model";

// The activation trace of one generation run. The trace is the source of truth
// for every activation visual: "time travel" is just indexing into it.
//
// Kept deliberately compact — O(nLayers) scalars + O(nHeads) norms per step.
// Dense per-step objects (attention patterns over past positions, MLP hidden
// activations) are exposed as lazy lookups on the DataSource instead, so a
// real GPU backend can stream the compact trace and serve the dense parts on
// demand.

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

export type StepTrace = {
  layers: LayerStep[];
  /** Top next-token predictions at this position. */
  logits: TopLogit[];
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

export type NeuronAct = { idx: number; act: number };

// The seam a real backend implements. The dummy source computes everything
// deterministically from hashes; a Turing/local-GPU source would run the model
// with hooks, stream StepTraces during generation, and serve weight tiles by
// slicing safetensors (mmap — no GPU needed for the weight side).
export interface DataSource {
  model: ModelConfig;
  tokenize(prompt: string): string[];
  /** Start autoregressive generation; onStep fires once per new position. */
  generate(
    prompt: string,
    maxNew: number,
    onStart: (trace: Trace) => void,
    onStep: (trace: Trace) => void,
  ): GenerationHandle;
  /** Attention weights of head (layer, head) at position t over 0..t. */
  attnPattern(trace: Trace, layer: number, head: number, t: number): number[];
  /** Top-k MLP hidden activations at (layer, t). */
  mlpTopNeurons(trace: Trace, layer: number, t: number, k: number): NeuronAct[];
  /** Histogram counts of the dMlp hidden activations at (layer, t). */
  mlpActHistogram(trace: Trace, layer: number, t: number, bins: number): { edges: number[]; counts: number[] };
  /** Point sample of a weight tensor. Dummy is sync; a real source tiles this. */
  weightAt(tensor: string, row: number, col: number): number;
  /** Summary stats used in the weights stratum header. */
  weightStats(tensor: string): { mean: number; std: number; absMax: number };
}
