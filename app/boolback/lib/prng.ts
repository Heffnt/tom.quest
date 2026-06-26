// app/boolback/lib/prng.ts — deterministic seeding utilities.
//
// NO Date.now / Math.random anywhere. Every value is a pure function of its
// string/object input, so the whole fixture is byte-identical across builds.

/**
 * xmur3 string hash -> a stateful uint32 generator. Each call returns the next
 * scrambled uint32 derived from `str`. Used to derive PRNG seeds from labels.
 */
export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function (): number {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/**
 * mulberry32 PRNG. Given a uint32 seed, returns a generator of floats in [0,1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convenience: build a [0,1) generator seeded from a label string. */
export function rngFor(label: string): () => number {
  return mulberry32(xmur3(label)());
}

// ---- canonical JSON + folded FNV-1a content hash ----

/**
 * Canonical JSON: object keys sorted recursively, no whitespace, stable numeric
 * rendering. Mirrors the content-addressed-tree hash pre-image.
 */
export function canonicalJSON(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) return "null";
    // Stable numeric rendering: integers bare, floats via Number's shortest form.
    return Object.is(n, -0) ? "0" : String(n);
  }
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stringify(v)).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue; // undefined keys are elided
      parts.push(JSON.stringify(k) + ":" + stringify(v));
    }
    return "{" + parts.join(",") + "}";
  }
  // functions / symbols => null
  return "null";
}

/**
 * hash12: synchronous content hash of an object -> 12 lowercase hex chars.
 *
 * A folded 64-bit FNV-1a over the canonical-JSON pre-image, computed as two
 * interleaved 32-bit FNV-1a lanes (low/high) to give 64 bits of state without
 * BigInt, then rendered as 12 hex (48 bits: 6 from the high lane + 6 from low).
 * Deterministic and collision-safe at fixture scale (<1000 nodes).
 */
export function hash12(obj: unknown): string {
  const s = canonicalJSON(obj);
  // two FNV-1a 32-bit lanes with distinct offset bases
  let h1 = 0x811c9dc5 >>> 0; // FNV offset basis
  let h2 = 0x01000193 >>> 0; // second lane seeded with the FNV prime
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (c + i) & 0xff;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
    // cross-feed the lanes so all 64 bits depend on the whole string
    h2 = (h2 ^ (h1 >>> 17)) >>> 0;
    h1 = (h1 ^ (h2 >>> 13)) >>> 0;
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const hex2 = (h2 >>> 0).toString(16).padStart(8, "0");
  // 12 hex: 6 from each lane
  return (hex2.slice(0, 6) + hex1.slice(0, 6)).toLowerCase();
}
