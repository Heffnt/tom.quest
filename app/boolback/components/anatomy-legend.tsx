"use client";

// app/boolback/components/anatomy-legend.tsx — the Anatomy view's compact
// encoding legend: a slim strip under the pane header (site-chrome styling,
// CSS variables only) explaining carrier colors, mode glyphs, the null-
// control ghost, |Δ| sizing, and the run/twin side identity colors. It is a
// horizontal strip so it never steals spine width; the pane header carries
// the toggle that collapses it. Carriers listed are ONLY those present in
// the current run(+twin) measurements — the legend describes this view, not
// the whole taxonomy.

import { RUN_COLOR, TWIN_COLOR, carrierColor } from "../lib/anatomy";

/** Tiny fixed-size SVG swatch — exact marker geometry, not a unicode glyph
 * approximation, so the legend literally matches the pane's pixels. */
function Glyph({ kind, color }: { kind: "circle" | "diamond" | "ghost" | "sizes"; color: string }) {
  const s = kind === "sizes" ? 22 : 12;
  return (
    <svg width={s} height={12} viewBox={`0 0 ${s} 12`} aria-hidden className="shrink-0">
      {kind === "circle" && (
        <circle cx={6} cy={6} r={3.6} fill={color} fillOpacity={0.55} stroke={color} strokeWidth={1} />
      )}
      {kind === "diamond" && (
        <path d="M 6 1.8 L 10.2 6 L 6 10.2 L 1.8 6 Z" fill={color} fillOpacity={0.55} stroke={color} strokeWidth={1} />
      )}
      {kind === "ghost" && <circle cx={6} cy={6} r={2} fill={color} fillOpacity={0.7} />}
      {kind === "sizes" && (
        <>
          <circle cx={5} cy={6} r={2} fill={color} fillOpacity={0.45} />
          <circle cx={14.5} cy={6} r={4.6} fill={color} fillOpacity={0.85} />
        </>
      )}
    </svg>
  );
}

function Divider() {
  return <span aria-hidden className="h-3 w-px shrink-0 bg-border" />;
}

export function AnatomyLegend({
  carriers,
  twinOn,
  hasCircuit,
}: {
  /** Carrier names present in the current run(+twin) measurements. */
  carriers: string[];
  twinOn: boolean;
  hasCircuit: boolean;
}) {
  return (
    <div
      data-anatomy-legend=""
      className="flex h-6 shrink-0 items-center gap-x-3 overflow-hidden whitespace-nowrap border-b border-border bg-surface/30 px-2 font-mono text-[10px] text-text-muted"
    >
      {carriers.map((c) => (
        <span key={c} className="flex items-center gap-1">
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: carrierColor(c) }}
          />
          {c}
        </span>
      ))}
      {carriers.length > 0 && <Divider />}
      <span className="flex items-center gap-1" title="observational — read tap out of the stream">
        <Glyph kind="circle" color="var(--color-text-muted)" />
        observe
      </span>
      <span className="flex items-center gap-1" title="interventional — write tap into the stream">
        <Glyph kind="diamond" color="var(--color-text-muted)" />
        intervene
      </span>
      <Divider />
      <span className="flex items-center gap-1" title="marker size tracks |value − null|">
        <Glyph kind="sizes" color="var(--color-text-muted)" />
        |Δ|
      </span>
      <span className="flex items-center gap-1" title="faint fixed dot beside a marker = its null control">
        <Glyph kind="ghost" color="var(--color-text-faint)" />
        null
      </span>
      {/* Side-identity swatches exist ONLY while both sides render: with the
          twin band off nothing amber/cyan is on the canvas (side colors are a
          contrast encoding, not a run brand), so the whole group — run, twin,
          pair-Δ whisker — drops together rather than leaving a run swatch
          pointing at nothing. */}
      {twinOn && (
        <>
          <Divider />
          <span className="flex items-center gap-1" title="run side: header chip, heat, diff-strip up, run-only circuit edges">
            <span aria-hidden className="h-2 w-3 shrink-0 rounded-sm" style={{ backgroundColor: RUN_COLOR }} />
            run
          </span>
          <span
            className="flex items-center gap-1"
            title="twin side: header chip, heat, diff-strip down, twin-only circuit edges"
          >
            <span aria-hidden className="h-2 w-3 shrink-0 rounded-sm" style={{ backgroundColor: TWIN_COLOR }} />
            twin
          </span>
          <span
            className="flex items-center gap-1"
            title="diff-strip whisker: |Δ| capped line up = run, down = twin; open dot = no partner measurement on that side"
          >
            {/* exact whisker geometry: capped |Δ| line above the centerline,
                open no-partner dot below it */}
            <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden className="shrink-0">
              <line x1={1} y1={6} x2={11} y2={6} stroke="var(--color-border)" strokeWidth={1} strokeDasharray="1.5 2" />
              <line x1={6} y1={6} x2={6} y2={1.5} stroke="var(--color-text-muted)" strokeWidth={1.5} />
              <line x1={3.5} y1={1.5} x2={8.5} y2={1.5} stroke="var(--color-text-muted)" strokeWidth={1.5} />
              <circle cx={6} cy={9.5} r={2.2} fill="none" stroke="var(--color-text-muted)" strokeWidth={1.25} />
            </svg>
            pair Δ · ○ no partner
          </span>
        </>
      )}
      {hasCircuit && (
        <>
          <Divider />
          <span
            className="flex items-center gap-1"
            title="circuit edges arc between node rings; neutral = present on both sides, run/twin color = that side only"
          >
            <svg width={16} height={12} viewBox="0 0 16 12" aria-hidden className="shrink-0">
              <path
                d="M 2 3 C 5 10, 11 10, 14 3"
                fill="none"
                stroke="var(--color-text-muted)"
                strokeWidth={1.2}
              />
              <circle cx={2} cy={3} r={1.6} fill="none" stroke="var(--color-text-muted)" strokeWidth={1} />
              <circle cx={14} cy={3} r={1.6} fill="none" stroke="var(--color-text-muted)" strokeWidth={1} />
            </svg>
            circuit edge
          </span>
        </>
      )}
    </div>
  );
}
