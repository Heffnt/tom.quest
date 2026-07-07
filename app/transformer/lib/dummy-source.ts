import { LLAMA_1B, type ModelConfig } from "./model";
import { gauss, hashSeed, u01 } from "./prng";
import type { DataSource, GenerationHandle, LayerStep, NeuronAct, StepTrace, Trace, TopLogit } from "./trace";

// Deterministic dummy backend: statistically plausible shapes (attention sinks,
// locality, depth-growing residual norms, heavy-tailed MLP activations,
// low-rank streaks in weight matrices) so the UI reads like a real model while
// the GPU endpoint doesn't exist yet. Everything is a pure function of hashes:
// same prompt, same picture.

const CONTINUATION_POOL = [
  " the", " model", " reads", " from", " its", " residual", " stream", " and",
  " writes", " a", " new", " token", " into", " context", " at", " every",
  " step", " of", " generation", ".",
];

const FRANCE_CONTINUATION = [" Paris", ",", " the", " city", " of", " light", "."];

function tokenizeText(prompt: string): string[] {
  const parts = prompt.match(/\s*\S+/g) ?? [];
  const tokens: string[] = [];
  for (const part of parts) {
    // split trailing punctuation into its own token, roughly BPE-ish
    const m = part.match(/^(\s*.*?)([.,!?;:]+)$/);
    if (m && m[1]) tokens.push(m[1], m[2]);
    else tokens.push(part);
  }
  return tokens;
}

function layerStep(key: string, cfg: ModelConfig, t: number, l: number): LayerStep {
  // Residual norm grows with depth; attention writes dominate early, MLP late.
  const depth = l / (cfg.nLayers - 1);
  const residNorm = (2 + 14 * depth) * (1 + 0.15 * gauss(key + ":resid", t, l));
  const attnBias = 0.22 - 0.1 * depth;
  const mlpBias = 0.14 + 0.18 * depth;
  const attnWrite = residNorm * Math.max(0.03, attnBias * (1 + 0.45 * gauss(key + ":aw", t, l)));
  const mlpWrite = residNorm * Math.max(0.03, mlpBias * (1 + 0.45 * gauss(key + ":mw", t, l)));
  const headNorms: number[] = [];
  for (let h = 0; h < cfg.nHeads; h++) {
    // lognormal-ish: a few heads do most of the writing
    headNorms.push(Math.exp(0.9 * gauss(key + ":hn", t, l, h)) * (attnWrite / cfg.nHeads) * 4);
  }
  return { residNorm, attnWrite, mlpWrite, headNorms };
}

function fakeLogits(key: string, t: number, nextToken: string | null): TopLogit[] {
  const pool = ["the", "a", "of", "and", "to", "in", "is", "that", "it", "for"];
  const top: TopLogit[] = [];
  let mass = 1;
  const pTop = nextToken ? 0.35 + 0.5 * u01(key + ":p", t) : 0.3;
  if (nextToken) {
    top.push({ token: nextToken, p: pTop });
    mass -= pTop;
  }
  for (let i = 0; top.length < 5; i++) {
    const tok = " " + pool[hashSeed(key + ":lg", t, i) % pool.length];
    if (top.some((x) => x.token === tok)) continue;
    const p = mass * (0.45 - 0.07 * top.length) * (0.7 + 0.6 * u01(key + ":lp", t, i));
    top.push({ token: tok, p });
  }
  return top;
}

function makeStep(key: string, cfg: ModelConfig, t: number, nextToken: string | null): StepTrace {
  const layers: LayerStep[] = [];
  for (let l = 0; l < cfg.nLayers; l++) layers.push(layerStep(key, cfg, t, l));
  return { layers, logits: fakeLogits(key, t, nextToken) };
}

export function createDummySource(cfg: ModelConfig = LLAMA_1B): DataSource {
  const weightStatsCache = new Map<string, { mean: number; std: number; absMax: number }>();

  const weightAt = (tensor: string, row: number, col: number): number => {
    const sigma = 0.02;
    let v = sigma * gauss(tensor, row, col);
    // low-rank streaks: real weight matrices have visible row/col structure
    for (let k = 0; k < 3; k++) {
      const wr = (2 * Math.PI) / (40 + 360 * u01(tensor + ":pr", k));
      const wc = (2 * Math.PI) / (40 + 360 * u01(tensor + ":pc", k));
      const amp = sigma * 1.1 * u01(tensor + ":amp", k);
      v += amp * Math.sin(row * wr + 6.28 * u01(tensor + ":fr", k)) * Math.sin(col * wc + 6.28 * u01(tensor + ":fc", k));
    }
    // sparse outlier rows (à la LLM.int8 emergent features)
    if (u01(tensor + ":orow", row) < 0.004) v *= 3.5;
    return v;
  };

  return {
    model: cfg,

    tokenize: tokenizeText,

    generate(prompt, maxNew, onStart, onStep): GenerationHandle {
      const key = `run:${hashSeed(prompt)}`;
      const promptTokens = tokenizeText(prompt);
      const continuation = /france/i.test(prompt)
        ? FRANCE_CONTINUATION
        : Array.from({ length: maxNew }, (_, i) => CONTINUATION_POOL[hashSeed(key, i) % CONTINUATION_POOL.length]);
      const newTokens = continuation.slice(0, maxNew);

      const trace: Trace = { key, tokens: [...promptTokens], nPrompt: promptTokens.length, steps: [] };
      // prefill: every prompt position has a forward pass in the trace
      for (let t = 0; t < promptTokens.length; t++) {
        const next = t === promptTokens.length - 1 ? (newTokens[0] ?? null) : promptTokens[t + 1];
        trace.steps.push(makeStep(key, cfg, t, next));
      }
      onStart(trace);

      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = new Promise<void>((resolve) => {
        let i = 0;
        const tick = () => {
          if (cancelled || i >= newTokens.length) return resolve();
          trace.tokens.push(newTokens[i]);
          const t = trace.tokens.length - 1;
          trace.steps.push(makeStep(key, cfg, t, newTokens[i + 1] ?? null));
          onStep(trace);
          i += 1;
          timer = setTimeout(tick, 160);
        };
        timer = setTimeout(tick, 240);
      });
      return {
        cancel: () => {
          cancelled = true;
          if (timer) clearTimeout(timer);
        },
        done,
      };
    },

    attnPattern(trace, layer, head, t) {
      // per-head personality: attention sink + locality + content spikes
      const key = trace.key;
      const sink = 0.5 + 3 * u01(key + ":sink", layer, head);
      const tau = 1 + 7 * u01(key + ":tau", layer, head);
      const spiky = 1.5 * u01(key + ":spk", layer, head) ** 2;
      const scores: number[] = [];
      for (let j = 0; j <= t; j++) {
        let s = 0;
        if (j === 0) s += sink;
        s += 1.6 * Math.exp(-(t - j) / tau);
        s += spiky * Math.max(0, gauss(key + ":att", layer * 64 + head, t, j)) ** 2;
        scores.push(s);
      }
      const m = Math.max(...scores);
      const exps = scores.map((s) => Math.exp((s - m) * 1.6));
      const z = exps.reduce((a, b) => a + b, 0);
      return exps.map((e) => e / z);
    },

    mlpTopNeurons(trace, layer, t, k): NeuronAct[] {
      const out: NeuronAct[] = [];
      const seen = new Set<number>();
      const a0 = 3 + 3 * u01(trace.key + ":mta", layer, t);
      for (let i = 0; out.length < k; i++) {
        const idx = hashSeed(trace.key + ":mtn", layer, t, i) % cfg.dMlp;
        if (seen.has(idx)) continue;
        seen.add(idx);
        out.push({ idx, act: a0 * Math.pow(0.82, out.length) * (0.85 + 0.3 * u01(trace.key + ":mtv", layer, t, i)) });
      }
      return out;
    },

    mlpActHistogram(trace, layer, t, bins) {
      // zero-peaked with a heavy positive tail (SwiGLU-ish), analytic + noise
      const s = 0.4 + 0.2 * u01(trace.key + ":hs", layer, t);
      const lo = -3 * s, hi = 8 * s;
      const edges: number[] = [];
      const counts: number[] = [];
      for (let i = 0; i <= bins; i++) edges.push(lo + ((hi - lo) * i) / bins);
      for (let i = 0; i < bins; i++) {
        const x = (edges[i] + edges[i + 1]) / 2;
        const core = Math.exp(-(x * x) / (2 * s * s));
        const tail = x > 0 ? 0.06 * Math.exp(-x / (2.2 * s)) : 0;
        const noise = 1 + 0.15 * gauss(trace.key + ":hb", layer, t, i);
        counts.push(Math.max(0, cfg.dMlp * 0.12 * (core + tail) * noise));
      }
      return { edges, counts };
    },

    weightAt,

    weightStats(tensor) {
      const cached = weightStatsCache.get(tensor);
      if (cached) return cached;
      let sum = 0, sum2 = 0, absMax = 0;
      const n = 4096;
      for (let i = 0; i < n; i++) {
        const v = weightAt(tensor, hashSeed(tensor + ":sr", i) % 4096, hashSeed(tensor + ":sc", i) % 4096);
        sum += v;
        sum2 += v * v;
        absMax = Math.max(absMax, Math.abs(v));
      }
      const mean = sum / n;
      const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
      const stats = { mean, std, absMax };
      weightStatsCache.set(tensor, stats);
      return stats;
    },
  };
}
