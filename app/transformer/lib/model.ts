// Architecture description for the visualized model. v1 pins one known
// decoder-only architecture (Llama-3.2-1B); everything downstream reads shapes
// from this catalog so a future model just swaps the config.

export type ModelConfig = {
  id: string;
  displayName: string;
  nLayers: number;
  dModel: number;
  nHeads: number;
  nKvHeads: number;
  headDim: number;
  dMlp: number;
  vocabSize: number;
  tiedEmbeddings: boolean;
};

export const LLAMA_1B: ModelConfig = {
  id: "llama-3.2-1b",
  displayName: "Llama-3.2-1B",
  nLayers: 16,
  dModel: 2048,
  nHeads: 32,
  nKvHeads: 8,
  headDim: 64,
  dMlp: 8192,
  vocabSize: 128256,
  tiedEmbeddings: true,
};

export type TensorInfo = {
  /** Stable id, e.g. "layers.5.attn.wq" — doubles as the PRNG seed namespace. */
  name: string;
  /** Short label for UI, e.g. "W_Q". */
  label: string;
  rows: number;
  cols: number;
};

/** Weight tensors of one attention block (out_features x in_features). */
export function attnTensors(cfg: ModelConfig, layer: number): TensorInfo[] {
  const kv = cfg.nKvHeads * cfg.headDim;
  return [
    { name: `layers.${layer}.attn.wq`, label: "W_Q", rows: cfg.nHeads * cfg.headDim, cols: cfg.dModel },
    { name: `layers.${layer}.attn.wk`, label: "W_K", rows: kv, cols: cfg.dModel },
    { name: `layers.${layer}.attn.wv`, label: "W_V", rows: kv, cols: cfg.dModel },
    { name: `layers.${layer}.attn.wo`, label: "W_O", rows: cfg.dModel, cols: cfg.nHeads * cfg.headDim },
  ];
}

/** Weight tensors of one MLP block. */
export function mlpTensors(cfg: ModelConfig, layer: number): TensorInfo[] {
  return [
    { name: `layers.${layer}.mlp.gate`, label: "W_gate", rows: cfg.dMlp, cols: cfg.dModel },
    { name: `layers.${layer}.mlp.up`, label: "W_up", rows: cfg.dMlp, cols: cfg.dModel },
    { name: `layers.${layer}.mlp.down`, label: "W_down", rows: cfg.dModel, cols: cfg.dMlp },
  ];
}

export function embedTensor(cfg: ModelConfig): TensorInfo {
  return { name: "embed", label: "W_E", rows: cfg.vocabSize, cols: cfg.dModel };
}

export function unembedTensor(cfg: ModelConfig): TensorInfo {
  return { name: "unembed", label: "W_U", rows: cfg.vocabSize, cols: cfg.dModel };
}

/** Which of the (grouped-query) KV heads a query head reads from. */
export function kvGroupOf(cfg: ModelConfig, head: number): number {
  return Math.floor(head / (cfg.nHeads / cfg.nKvHeads));
}
