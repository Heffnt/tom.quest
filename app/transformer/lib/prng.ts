// Deterministic pseudo-randomness for the dummy data source. Every visual is a
// pure function of (name, indices) so panning/zooming/re-rendering is stable
// without storing anything.

/** FNV-1a 32-bit hash of a string, mixed with up to three integers. */
export function hashSeed(name: string, a = 0, b = 0, c = 0): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  for (const n of [a, b, c]) {
    h ^= n + 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

/** mulberry32 — small fast seeded PRNG, uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** One uniform sample in [0,1) for a keyed coordinate — no generator state. */
export function u01(name: string, a = 0, b = 0, c = 0): number {
  return hashSeed(name, a, b, c) / 4294967296;
}

/** Approximate standard normal from two keyed uniforms (Box–Muller). */
export function gauss(name: string, a = 0, b = 0, c = 0): number {
  const u = Math.max(u01(name, a, b, c), 1e-12);
  const v = u01(name, a ^ 0x5555aaaa, b, c);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
