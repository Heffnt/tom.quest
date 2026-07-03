"use client";

// app/boolback/components/truth-strip.tsx
//
// The truth-table viz. A horizontal strip of square boxes — ONE box per
// truth-table row, in the exact order of function.activation (LSB-first per
// TruthTable.rows()). Each box:
//
//   - is filled ONLY by the variables PRESENT in that row, splitting the fill
//     evenly among them: one present variable = the full square in its color,
//     two = 50/50, three = thirds, … The all-zeros row is an empty dark square.
//   - separates the colors with thin near-black outlines (around the colored
//     region and between slices) so adjacent hues never bleed together and the
//     fill reads against the amber ring.
//   - gets a tom.quest-AMBER ring (var(--color-accent)) iff that row ACTIVATES
//     the backdoor, else a faint grey border.
//
// The per-variable palette is five maximally-distinct hues, fixed for arity
// 1..5 so the same variable keeps its color across rows, strips, and legends.
// Pure SVG + CSS-variable chrome colors.

// Distinct per-trigger palette (A,B,C,D,E). Index = variable position (0=A).
const TRIGGER_COLORS = [
  "#f87171", // A — red
  "#38bdf8", // B — blue
  "#4ade80", // C — green
  "#e879f9", // D — magenta
  "#fbbf24", // E — yellow
];

const VAR_LETTERS = "ABCDE";

export function triggerColor(varIndex: number): string {
  return TRIGGER_COLORS[varIndex % TRIGGER_COLORS.length];
}

function varLetter(i: number): string {
  return VAR_LETTERS[i] ?? `v${i}`;
}

/**
 * One truth-table-row square. `presence` is the 0/1 vector; the fill is split
 * evenly among the PRESENT variables only. `activates` draws the amber ring.
 */
export function TruthBox({
  presence,
  activates,
  box,
}: {
  presence: number[];
  activates: boolean;
  box: number;
}) {
  const present = presence
    .map((bit, i) => (bit ? i : -1))
    .filter((i) => i >= 0);

  // Ring: amber when the row ACTIVATES, faint grey otherwise. Thickness scales
  // with the box but is clamped so it stays visible at table scale (11px)
  // without swallowing the fill.
  const ringW = activates ? Math.min(2.25, Math.max(1.5, box * 0.13)) : 1;
  const ringColor = activates ? "var(--color-accent)" : "var(--color-border)";
  // Uniform fill inset across ALL boxes in a strip (sized for the amber ring)
  // so slices align box-to-box regardless of activation.
  const inset = Math.min(2.25, Math.max(1.5, box * 0.13)) + 1;
  const inner = box - inset * 2;
  // Near-black separator outline: thin enough to keep the colors readable at
  // small sizes, thick enough to cut between hues and against the ring.
  const outlineW = box >= 14 ? 1 : 0.75;

  const presentList = present.map(varLetter).join(",");
  const title = `${presence.join("")} · ${
    presentList ? `present: ${presentList}` : "no triggers"
  } · ${activates ? "ACTIVATES" : "inactive"}`;

  const sliceW = present.length > 0 ? inner / present.length : 0;

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
      {present.length === 0 ? (
        // all-zeros row: empty dark square
        <rect
          x={inset}
          y={inset}
          width={inner}
          height={inner}
          fill="var(--color-surface-alt)"
        />
      ) : (
        <>
          {present.map((varIdx, j) => (
            <rect
              key={varIdx}
              x={inset + j * sliceW}
              y={inset}
              width={sliceW}
              height={inner}
              fill={triggerColor(varIdx)}
            />
          ))}
          {/* black separators between slices */}
          {present.slice(1).map((_, j) => (
            <line
              key={j}
              x1={inset + (j + 1) * sliceW}
              y1={inset}
              x2={inset + (j + 1) * sliceW}
              y2={inset + inner}
              stroke="var(--color-bg)"
              strokeWidth={outlineW}
            />
          ))}
          {/* black outline around the colored region */}
          <rect
            x={inset}
            y={inset}
            width={inner}
            height={inner}
            fill="none"
            stroke="var(--color-bg)"
            strokeWidth={outlineW}
          />
        </>
      )}
      {/* activation ring */}
      <rect
        x={ringW / 2}
        y={ringW / 2}
        width={box - ringW}
        height={box - ringW}
        rx={1.5}
        fill="none"
        stroke={ringColor}
        strokeWidth={ringW}
      />
    </svg>
  );
}

interface TruthStripProps {
  arity: number;
  activation: Array<{ presence: number[]; activates: boolean }>;
  /** Box edge length in px. Default sized for the table cell. */
  box?: number;
  /** Gap between boxes in px. */
  gap?: number;
  /** Show an inline per-trigger legend after the strip. */
  legend?: boolean;
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
          <TruthBox key={i} presence={row.presence} activates={row.activates} box={box} />
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
