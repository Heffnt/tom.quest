"use client";

// app/boolback/components/truth-strip.tsx
//
// The truth-table viz that replaces the old binary-string + arity mini-bar.
// A horizontal strip of square boxes — ONE box per truth-table row, in the
// exact order of row.function.activation (LSB-first per TruthTable.rows()). Each
// box:
//   - has a square-pie inside split into `arity` equal vertical slices, one per
//     trigger variable A,B,C…; a slice is FILLED in that trigger's color iff the
//     variable is present in that row (present_vars), else faint.
//   - has an AMBER border iff that row activates (the backdoor fires), else a
//     GREY border.
// Content-sized (no truncation): the strip lays out 2..32 boxes at a fixed box
// size and lets the parent cell decide whether to scroll. A small per-trigger
// legend is optional.
//
// Pure SVG + CSS-variable colors. The per-trigger palette is fixed for arity
// 1..5 (5 distinct accent hues) so the same variable keeps its color across the
// whole strip and across rows.

import type { ActivationRow } from "../lib/types";

// Fixed per-trigger palette (A,B,C,D,E). CSS-variable-driven where the design
// tokens exist; the extra hues fall back to literal values that read on the dark
// surface. Index = variable position (0=A).
const TRIGGER_COLORS = [
  "var(--color-accent)",
  "#d98c5f", // warm amber-orange (B)
  "#6fb6a6", // teal (C)
  "#b48ad6", // violet (D)
  "#c9b35f", // gold (E)
];

const VAR_LETTERS = "ABCDE";

export function triggerColor(varIndex: number): string {
  return TRIGGER_COLORS[varIndex] ?? "var(--color-accent)";
}

function varLetter(i: number): string {
  return VAR_LETTERS[i] ?? `v${i}`;
}

interface TruthStripProps {
  arity: number;
  activation: ActivationRow[];
  /** Box edge length in px. Default sized for the table cell. */
  box?: number;
  /** Gap between boxes in px. */
  gap?: number;
  /** Show an inline per-trigger legend after the strip. */
  legend?: boolean;
}

/**
 * One square box: a square-pie of `arity` vertical slices, each slice filled in
 * its trigger color iff that variable is present in this row. Border amber iff
 * the row activates.
 */
function TruthBox({
  row,
  arity,
  box,
}: {
  row: ActivationRow;
  arity: number;
  box: number;
}) {
  const present = new Set(row.present_vars);
  const sliceW = box / Math.max(1, arity);
  const border = row.activates ? "var(--color-warning)" : "var(--color-border)";
  const presentList = row.present_vars.map(varLetter).join(",");
  const title = `${row.presence.join("")} · ${
    presentList ? `present: ${presentList}` : "no triggers"
  } · ${row.activates ? "ACTIVATES" : "inactive"}`;

  return (
    <svg
      width={box}
      height={box}
      viewBox={`0 0 ${box} ${box}`}
      className="shrink-0"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      {/* slices */}
      {Array.from({ length: Math.max(1, arity) }, (_, i) => {
        const on = present.has(i);
        return (
          <rect
            key={i}
            x={i * sliceW}
            y={0}
            width={sliceW}
            height={box}
            fill={on ? triggerColor(i) : "var(--color-surface-alt)"}
            fillOpacity={on ? 0.9 : 0.5}
          />
        );
      })}
      {/* slice dividers */}
      {Array.from({ length: Math.max(0, arity - 1) }, (_, i) => (
        <line
          key={`d${i}`}
          x1={(i + 1) * sliceW}
          y1={0}
          x2={(i + 1) * sliceW}
          y2={box}
          stroke="var(--color-bg)"
          strokeOpacity={0.4}
          strokeWidth={0.5}
        />
      ))}
      {/* activation border */}
      <rect
        x={0.75}
        y={0.75}
        width={box - 1.5}
        height={box - 1.5}
        rx={1.5}
        fill="none"
        stroke={border}
        strokeWidth={row.activates ? 1.75 : 1}
      />
    </svg>
  );
}

export function TruthStrip({
  arity,
  activation,
  box = 12,
  gap = 2,
  legend = false,
}: TruthStripProps) {
  if (activation.length === 0) {
    return <span className="text-text-faint">—</span>;
  }
  return (
    <span className="inline-flex items-center gap-2 align-middle">
      <span className="inline-flex items-center" style={{ gap }}>
        {activation.map((row, i) => (
          <TruthBox key={i} row={row} arity={arity} box={box} />
        ))}
      </span>
      {legend && (
        <span className="inline-flex items-center gap-1.5 ml-1">
          {Array.from({ length: arity }, (_, i) => (
            <span key={i} className="inline-flex items-center gap-0.5 text-[10px]">
              <span
                className="inline-block h-2 w-2 rounded-[1px]"
                style={{ backgroundColor: triggerColor(i) }}
              />
              <span className="text-text-muted font-mono">{varLetter(i)}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
