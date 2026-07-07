import type { ModelConfig } from "./model";
import type { DataSource, GenerationHandle, TensorStats, Trace, WeightWindow, WeightWindowReq } from "./trace";

// Live backend: turing-api/transformer_server.py running next to a real model
// on a Turing GPU node, reachable through a cloudflared quick tunnel. The
// server ships dense per-step data (attention patterns, MLP top-k/histogram)
// inside the generate response, so only the weight windows are fetched lazily.

type ServerConfig = {
  model_id: string;
  display_name: string;
  n_layers: number;
  d_model: number;
  n_heads: number;
  n_kv_heads: number;
  head_dim: number;
  d_mlp: number;
  vocab_size: number;
  tied_embeddings: boolean;
};

type ServerStep = {
  resid_norms: number[];
  attn_writes: number[];
  mlp_writes: number[];
  head_norms: number[][];
  logits: { token: string; p: number }[];
  attn: number[][][];
  mlp_top: { idx: number; act: number }[][];
  mlp_hist: { edges: number[]; counts: number[] }[];
};

type GenerateResponse = { tokens: string[]; n_prompt: number; steps: ServerStep[] };

// turing.tom.quest load-balances across three API nodes; during a rolling
// deploy some may not have the /transformer-trace route yet and return 404.
// Retry a few times — a hit on an updated node resolves it; real 404s (bad
// path) surface after the attempts.
async function fetchLB(url: string, init: RequestInit, tries = 8): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, init);
      if (r.status !== 404) return r;
      last = r;
    } catch (e) {
      if ((e instanceof DOMException && e.name === "AbortError") || i === tries - 1) throw e;
    }
    await new Promise((res) => setTimeout(res, 150));
  }
  return last!;
}

function b64ToFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export async function createTuringSource(baseUrl: string, token: string): Promise<DataSource> {
  const url = baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = token ? { "x-trace-token": token } : {};

  const confRes = await fetchLB(`${url}/config`, { headers });
  if (!confRes.ok) throw new Error(`config ${confRes.status}: ${await confRes.text()}`);
  const conf: ServerConfig = await confRes.json();

  const model: ModelConfig = {
    id: conf.model_id,
    displayName: conf.display_name,
    nLayers: conf.n_layers,
    dModel: conf.d_model,
    nHeads: conf.n_heads,
    nKvHeads: conf.n_kv_heads,
    headDim: conf.head_dim,
    dMlp: conf.d_mlp,
    vocabSize: conf.vocab_size,
    tiedEmbeddings: conf.tied_embeddings,
  };

  const statsCache = new Map<string, TensorStats>();
  let runCounter = 0;

  return {
    kind: "turing",
    model,

    generate(prompt, maxNew, onStart): GenerationHandle {
      const ac = new AbortController();
      const done = (async () => {
        const res = await fetchLB(`${url}/generate`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ prompt, max_new_tokens: maxNew }),
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(`generate ${res.status}: ${await res.text()}`);
        const j: GenerateResponse = await res.json();
        runCounter += 1;
        const trace: Trace = {
          key: `turing:${runCounter}`,
          tokens: j.tokens,
          nPrompt: j.n_prompt,
          steps: j.steps.map((s) => ({
            layers: s.resid_norms.map((rn, l) => ({
              residNorm: rn,
              attnWrite: s.attn_writes[l],
              mlpWrite: s.mlp_writes[l],
              headNorms: s.head_norms[l],
            })),
            logits: s.logits,
            dense: { attn: s.attn, mlpTop: s.mlp_top, mlpHist: s.mlp_hist },
          })),
        };
        onStart(trace);
      })();
      return { cancel: () => ac.abort(), done };
    },

    attnPattern: (trace, layer, head, t) => trace.steps[t]?.dense?.attn?.[layer]?.[head] ?? null,

    mlpTopNeurons: (trace, layer, t, k) => trace.steps[t]?.dense?.mlpTop?.[layer]?.slice(0, k) ?? null,

    mlpActHistogram: (trace, layer, t) => trace.steps[t]?.dense?.mlpHist?.[layer] ?? null,

    async fetchWeights(tensor: string, req: WeightWindowReq): Promise<WeightWindow> {
      const qs = `row0=${req.row0}&col0=${req.col0}&rows=${req.rows}&cols=${req.cols}&stride=${req.stride}`;
      const res = await fetchLB(`${url}/weights/${tensor}?${qs}`, { headers });
      if (!res.ok) throw new Error(`weights ${res.status}`);
      const j = await res.json();
      return { row0: j.row0, col0: j.col0, rows: j.rows, cols: j.cols, stride: j.stride, data: b64ToFloat32(j.b64) };
    },

    async fetchWeightStats(tensor: string): Promise<TensorStats> {
      const cached = statsCache.get(tensor);
      if (cached) return cached;
      const res = await fetchLB(`${url}/weights/${tensor}/stats`, { headers });
      if (!res.ok) throw new Error(`stats ${res.status}`);
      const j: TensorStats = await res.json();
      statsCache.set(tensor, j);
      return j;
    },
  };
}
