import { create } from "zustand";
import { createDummySource } from "./lib/dummy-source";
import type { DataSource, GenerationHandle, Trace } from "./lib/trace";

// UI-only state (zustand per repo convention). The data source is a module
// singleton — swap createDummySource() for a Turing/local-GPU source later.
export const source: DataSource = createDummySource();

/**
 * A stratum is one open horizontal band. Path grammar (depth = drill level):
 *   "embed" | "unembed"
 *   "b5"            – block 5
 *   "b5/attn"       – its heads
 *   "b5/attn/h3"    – one head (attention into the past)
 *   "b5/attn/wq"    – a weight matrix (also wk/wv/wo)
 *   "b5/mlp"        – mlp activations
 *   "b5/mlp/gate"   – a weight matrix (also up/down)
 */
export type StratumPath = string;

const LANE_ORDER: Record<string, number> = { attn: 0, mlp: 1 };

/** Sort key: model order first (embed, blocks, unembed), then drill depth. */
function orderKey(path: StratumPath, nLayers: number): number[] {
  const seg = path.split("/");
  const head = seg[0];
  const layer = head === "embed" ? -1 : head === "unembed" ? nLayers : Number(head.slice(1));
  const lane = seg[1] ? (LANE_ORDER[seg[1]] ?? 9) : -1;
  const leafRank = seg[2] ? (seg[2].startsWith("h") ? 0 : 1) : -1;
  return [layer, lane, seg.length, leafRank];
}

function comparePaths(a: StratumPath, b: StratumPath, nLayers: number): number {
  const ka = orderKey(a, nLayers);
  const kb = orderKey(b, nLayers);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.localeCompare(b);
}

type TransformerState = {
  prompt: string;
  trace: Trace | null;
  generating: boolean;
  /** Selected position on the z axis (index into trace.tokens). */
  selected: number;
  /** While generating, keep the selection glued to the newest token. */
  follow: boolean;
  open: StratumPath[];
  setPrompt: (p: string) => void;
  run: () => void;
  stop: () => void;
  select: (t: number) => void;
  toggle: (path: StratumPath) => void;
  close: (path: StratumPath) => void;
};

let handle: GenerationHandle | null = null;

export const useTransformer = create<TransformerState>((set, get) => ({
  prompt: "The capital of France is",
  trace: null,
  generating: false,
  selected: 0,
  follow: true,
  open: [],

  setPrompt: (prompt) => set({ prompt }),

  run: () => {
    handle?.cancel();
    const { prompt } = get();
    const publish = (trace: Trace) => {
      const sel = get().follow ? trace.tokens.length - 1 : Math.min(get().selected, trace.tokens.length - 1);
      set({ trace: { ...trace, tokens: [...trace.tokens], steps: [...trace.steps] }, selected: sel });
    };
    set({ generating: true, follow: true });
    handle = source.generate(prompt, 12, publish, publish);
    handle.done.then(() => set({ generating: false }));
  },

  stop: () => {
    handle?.cancel();
    set({ generating: false });
  },

  select: (t) => {
    const { trace } = get();
    if (!trace) return;
    const clamped = Math.max(0, Math.min(trace.tokens.length - 1, t));
    set({ selected: clamped, follow: clamped === trace.tokens.length - 1 && get().generating });
  },

  toggle: (path) => {
    const { open } = get();
    const n = source.model.nLayers;
    if (open.includes(path)) {
      set({ open: open.filter((p) => p !== path && !p.startsWith(path + "/")) });
    } else {
      set({ open: [...open, path].sort((a, b) => comparePaths(a, b, n)) });
    }
  },

  close: (path) => {
    set({ open: get().open.filter((p) => p !== path && !p.startsWith(path + "/")) });
  },
}));
