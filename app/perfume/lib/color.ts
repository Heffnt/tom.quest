// ── hex color utilities ──────────────────────────────────────────────────────
// Single source of truth for the hex parsing/formatting/blending math that
// used to be triplicated across brew-graph-layout.ts (parseHex/toHex),
// brew-graph.tsx (mix), and an inline helper in frequencies.tsx (fundColor).
// Pure module, no React.

/** Parses a `#rgb` or `#rrggbb` hex string (with or without the `#`) into an
 * [r, g, b] triple of 0-255 channel values. */
export function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** Formats an [r, g, b] triple (values may be fractional; they are rounded)
 * back into a `#rrggbb` hex string. */
export function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/** Linearly interpolates between two hex colors, channel by channel:
 * `t = 0` returns `a`, `t = 1` returns `b`. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  return toHex([
    ar + (br - ar) * t,
    ag + (bg - ag) * t,
    ab + (bb - ab) * t,
  ]);
}
