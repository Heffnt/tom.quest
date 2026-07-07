import { create } from "zustand";
import { createDummySource } from "./lib/dummy-source";
import { createTuringSource } from "./lib/turing-source";
import type { DataSource, GenerationHandle, Trace } from "./lib/trace";

// UI-only state (zustand per repo convention). The active DataSource lives
// outside the store (it holds functions/caches); `sourceRev` bumps whenever it
// is swapped so components re-read it.
let activeSource: DataSource = createDummySource();
export function getSource(): DataSource {
  return activeSource;
}

const LS_KEY = "transformer.remote";
/** The public proxy on the existing turing-api (routes to the per-job server). */
const DEFAULT_REMOTE_URL = "https://turing.tom.quest/transformer-trace";

function loadRemoteConfig(): { url: string; token: string } {
  if (typeof window === "undefined") return { url: DEFAULT_REMOTE_URL, token: "" };
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = { url: "", token: "", ...JSON.parse(raw) };
      return { url: parsed.url || DEFAULT_REMOTE_URL, token: parsed.token };
    }
  } catch {
    // ignore corrupt localStorage
  }
  return { url: DEFAULT_REMOTE_URL, token: "" };
}

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

// A decoder predicts token t from the forward pass at position t-1, so the
// computation that PRODUCED the selected token is the pass at the previous
// position. Selecting token t shows how the model arrived at t. Token 0 is the
// given input — the model produced nothing — so this returns -1 there.
export function producingStep(selected: number): number {
  return selected - 1;
}

export type SourceStatus = "dummy" | "connecting" | "live" | "error";

type TransformerState = {
  prompt: string;
  trace: Trace | null;
  generating: boolean;
  /** Selected position on the z axis (index into trace.tokens). */
  selected: number;
  /** While generating, keep the selection glued to the newest token. */
  follow: boolean;
  open: StratumPath[];
  /** Bumped whenever the active DataSource is swapped. */
  sourceRev: number;
  sourceStatus: SourceStatus;
  sourceError: string | null;
  remoteUrl: string;
  remoteToken: string;
  setPrompt: (p: string) => void;
  setRemote: (url: string, token: string) => void;
  connectTuring: () => Promise<void>;
  useDummy: () => void;
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
  sourceRev: 0,
  sourceStatus: "dummy",
  sourceError: null,
  remoteUrl: loadRemoteConfig().url,
  remoteToken: loadRemoteConfig().token,

  setPrompt: (prompt) => set({ prompt }),

  setRemote: (remoteUrl, remoteToken) => {
    set({ remoteUrl, remoteToken });
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify({ url: remoteUrl, token: remoteToken }));
    } catch {
      // localStorage unavailable — connection config just won't persist
    }
  },

  connectTuring: async () => {
    const { remoteUrl, remoteToken, sourceRev } = get();
    if (!remoteUrl) {
      set({ sourceStatus: "error", sourceError: "enter the trace-server url" });
      return;
    }
    set({ sourceStatus: "connecting", sourceError: null });
    try {
      activeSource = await createTuringSource(remoteUrl, remoteToken);
      handle?.cancel();
      set({
        sourceStatus: "live",
        sourceRev: sourceRev + 1,
        trace: null,
        generating: false,
        selected: 0,
        open: [],
      });
    } catch (e) {
      set({ sourceStatus: "error", sourceError: e instanceof Error ? e.message : String(e) });
    }
  },

  useDummy: () => {
    handle?.cancel();
    activeSource = createDummySource();
    set({
      sourceStatus: "dummy",
      sourceError: null,
      sourceRev: get().sourceRev + 1,
      trace: null,
      generating: false,
      selected: 0,
      open: [],
    });
  },

  run: () => {
    handle?.cancel();
    const { prompt } = get();
    const publish = (trace: Trace) => {
      const sel = get().follow ? trace.tokens.length - 1 : Math.min(get().selected, trace.tokens.length - 1);
      set({ trace: { ...trace, tokens: [...trace.tokens], steps: [...trace.steps] }, selected: sel });
    };
    set({ generating: true, follow: true, sourceError: null });
    handle = activeSource.generate(prompt, 12, publish, publish);
    handle.done
      .then(() => set({ generating: false }))
      .catch((e) => {
        set({
          generating: false,
          sourceError: e instanceof Error ? e.message : String(e),
          ...(get().sourceStatus === "live" ? { sourceStatus: "error" as const } : {}),
        });
      });
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
    const n = activeSource.model.nLayers;
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
