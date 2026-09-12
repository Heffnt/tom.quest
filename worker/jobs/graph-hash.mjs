// SHA-256 IN PLAIN JAVASCRIPT, so that one identity has one spelling on three
// runtimes.
//
// WHY THIS FILE EXISTS. worker/jobs/simplify.mjs mints a rule line's identity as
// `hash8` — eight hex characters of SHA-256 over the line's normalized text —
// using node:crypto. The graph names the same line the same way, and the graph
// is built on the box, on the laptop, and inside the Convex runtime, which takes
// no node builtins and whose Web Crypto digest is asynchronous. A second
// spelling of one identity is exactly the drift worker/jobs/graph.mjs exists to
// remove, so the hash moves here in a form all three can run, and node:crypto's
// own answer is asserted equal to it by a test.
//
// NOT A SECURITY PRIMITIVE. Nothing here authenticates anything; it names a line
// of text so that two readings of the same line agree. Correctness against the
// published vectors is what matters, and that is what the test checks.
//
// PURE. No imports, no I/O, no node builtins, no floating-point arithmetic
// except the one length division below, which is exact for every input.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const ENCODER = typeof TextEncoder === "undefined" ? null : new TextEncoder();

/** UTF-8 bytes of a string, without Buffer. */
function utf8(text) {
  if (ENCODER !== null) return ENCODER.encode(String(text));
  // A runtime with no TextEncoder does not exist in this system. The throw is
  // here so that one appearing is loud rather than silently wrong.
  throw new Error("graph-hash: this runtime has no TextEncoder");
}

function rotr(value, bits) {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** The 64 lowercase hex characters of the SHA-256 of `text`, UTF-8 encoded. */
export function sha256Hex(text) {
  const message = utf8(text);
  const bitLength = message.length * 8;
  // One 0x80 byte, then zeros, then the 64-bit big-endian bit length.
  const padded = new Uint8Array(((message.length + 9 + 63) >> 6) << 6);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(padded.length - 4, bitLength >>> 0, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  let out = "";
  for (const word of h) out += word.toString(16).padStart(8, "0");
  return out;
}

/**
 * Eight hex characters of SHA-256. THE SAME FUNCTION worker/jobs/simplify.mjs
 * exported before this file existed, byte for byte on every input — that file
 * now imports this one, so a rule's id in a blast-radius row and a node's id in
 * the graph are the same eight characters by construction rather than by
 * agreement.
 */
export function hash8(text) {
  return sha256Hex(String(text)).slice(0, 8);
}

/**
 * One line's identity: the hash of its NORMALIZED text, not its line number.
 * Line numbers move when a line above them is deleted, which is precisely what
 * the simplification pass proposes; a hash names the same line across weeks and
 * across a re-ordering of the file.
 *
 * MOVED FROM simplify.mjs UNCHANGED. Lowercase, leading bullet marker stripped,
 * whitespace collapsed, trimmed.
 */
export function ruleId(line) {
  const normalized = String(line)
    .toLowerCase()
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return hash8(normalized);
}
