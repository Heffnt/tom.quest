"use client";

// app/boolback/components/anatomy-pane.tsx — the Anatomy center view.
//
// Third center view alongside Table|Chart (ANATOMY-SPEC.md): one unified
// picture of WHERE in the model each interp measurement sits and how it
// performs. Three horizontal bands — the selected run's residual bar on top
// (blown-up structure hanging BELOW it), its function-false twin mirrored at
// the bottom (structure growing UP), and the contrast surface between them
// (per-layer diverging diff cells, paired-marker whiskers, circuit arcs).
// The x-axis is lib/anatomy.ts's accordion scale: pinned ends, width always
// conserved, focus weights from the store-owned AnatomyConfig (share-link /
// persisted-view reachable, exactly like ChartConfig).
//
// LIVE interactions (this pass):
//   * wheel = accordion zoom on the unit chain under the cursor
//     (unitChainAtX/zoomChain; non-passive listener so preventDefault works);
//     click a layer block / head slot / end cap = blowUp; double-click empty
//     background = reset; ←/→ move a keyboard layer cursor, +/- zoom it,
//     Esc resets (pane is tabIndex=0, cursor ring shows while focused).
//   * every focus change animates ~180ms: the TARGET focus commits to the
//     store once (wheel debounced to the gesture end), while a rAF loop
//     lerps a render-only focus (lerpFocus, log-space) that the scale is
//     built from each frame — positions derive per frame, the store is
//     never written per frame. LOD representation swaps fade in ~120ms
//     (FadeG); positions never jump across thresholds because the scale
//     itself is continuous.
//   * hover = HTML tooltip (absolute z-20, clamped/flipped inside the pane)
//     + store hover(node_path) debounced 150ms so table/chart ring; the
//     header run/twin ids ring back on hoveredDir/selectedDir like chart
//     points do.
//   * click a marker/arc = setAnatomy({sel: measurementKey}) + openDetail +
//     expandChain; a selected circuit adds a "fit circuit" header button
//     (fitCircuit weights). The sel id round-trips share links (codec in
//     lib/anatomy.ts: measurementKey/parseMeasurementKey).
//
// Encodings (spec table, locked): position = locus; carrier → color (hex
// palette from the engine — data colors never come from CSS vars); mode →
// glyph + tap direction (circle/read-out vs diamond/write-in);
// |delta| → marker radius + fill intensity (honest INTERP NULL renders
// faint, never hidden); null_control → fixed faint ghost dot. The diff strip
// and circuit-diff arcs use the two NON-carrier semantic colors — site
// accent = run side, warning = twin side — so contrast never reads as a
// carrier. Chrome is CSS variables only; never branch on theme.
//
// Render order = paint order (SVG z): background hit rect → bars/heat/ruler
// (+ per-layer bar hit rects) → ribbons → containers → component slots/
// strips → tap arrows → markers → diff cells → whiskers → circuit arcs+rings
// → transparent hit targets (marker circles, circuit arcs) last.
//
// The row set is the SAME filtered visibleRows the table/chart see; the run
// shown is the selected row when visible, else the first visible row. The
// twin resolves via measurement twin_hash against ALL bundle rows (the twin
// may be filtered out of view yet still contrastable). The root carries
// data-anatomy-ready once rows exist — the screenshot harness waits on it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Bundle,
  CircuitNode,
  InterpMeasurement,
  RunRow,
} from "../lib/types";
import type { MetricIndex } from "../lib/select";
import { fnText } from "../lib/format";
import { useBoolbackStore } from "../state/store";
import {
  GHOST_RADIUS,
  type AnatomyBands,
  type Focus,
  type Lod,
  type MatchedPair,
  type Scale,
  blowUp,
  buildScale,
  carrierColor,
  circuitDiff,
  computeBands,
  deltaOf,
  deltaRadius,
  findTwinRow,
  fitCircuit,
  lerpFocus,
  locusLabel,
  lodForLayer,
  matchMeasurements,
  measurementKey,
  measurementsOf,
  modeGlyph,
  neuronBins,
  reset,
  residLayerHeat,
  rowShape,
  unitChainAtX,
  zoomChain,
} from "../lib/anatomy";

// Geometry: the SVG viewBox tracks the plot container 1:1 (ResizeObserver;
// 1 viewBox unit = 1 CSS px) — same idiom as chart-panel.tsx. FALLBACK
// covers the first pre-measure render only.
const FALLBACK = { w: 820, h: 430 };

// Presentational constants (px). Ruler/labels appear only where they fit —
// the accordion squeezes layers arbitrarily thin.
const RULER_LABEL_MIN_PX = 16; // layer number inside the bar
const RULER_TICK_MIN_PX = 5; // min gap between drawn layer boundaries
const CAP_LABEL_MIN_PX = 34; // "embed"/"unembed" text inside the caps
const SLOT_H = 11; // head-slot / neuron-strip row height
const SLOT_LABEL_MIN_PX = 14; // leaf head index label
const BIN_LABEL_MIN_PX = 20; // leaf neuron index label
const STACK_PITCH = 30; // marker stack row pitch (fits MARKER_R_MAX)
const STACK_FIRST = 18; // bar edge → first marker center
const EMPTY_CONTAINER_H = 10; // structural stub for measurement-less layers
const RIBBON_MAX_PX = 24; // layer_profile ribbon peak height

// Interaction constants.
const FOCUS_ANIM_MS = 180; // accordion weight tween
const LOD_FADE_MS = 120; // representation-swap fade-in
const WHEEL_COMMIT_MS = 200; // wheel gesture end → one store commit
const WHEEL_ZOOM_BASE = 1.2; // zoom factor per 100 wheel deltaY
const KB_ZOOM = 1.5; // +/- keyboard zoom step
const HOVER_DEBOUNCE_MS = 150; // store hover() publish (table-pane precedent)

const fmtNum = (v: number | null | undefined): string =>
  typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : "—";

function measurementTitle(m: InterpMeasurement): string {
  const name = m.metric_name ? `${m.kind} · ${m.metric_name}` : m.kind;
  const mode = m.mode ? ` · ${m.mode}` : "";
  return `${name} @ ${locusLabel(m)}${mode}\nvalue ${fmtNum(m.value)} · null ${fmtNum(
    m.null_control,
  )} · Δ ${fmtNum(deltaOf(m))}`;
}

/** |delta|-driven fill intensity: near-null evidence fades (honest INTERP
 * NULL) but never below a visible floor — faint on purpose, never hidden. */
function deltaAlpha(delta: number | null, deltaMax: number): number {
  if (delta === null || !(deltaMax > 0)) return 0.3;
  return 0.3 + 0.6 * Math.min(1, Math.sqrt(Math.abs(delta) / deltaMax));
}

/** Fade-in wrapper for LOD representation swaps: the new representation
 * mounts at opacity 0 and eases to 1 over LOD_FADE_MS (the outgoing one
 * unmounts; the persistent bar/containers behind make it read as a
 * crossfade). Key it by the LOD so a swap remounts it. */
function FadeG({ children }: { children: React.ReactNode }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <g style={{ opacity: on ? 1 : 0, transition: `opacity ${LOD_FADE_MS}ms linear` }}>
      {children}
    </g>
  );
}

// ---------------------------------------------------------------------------
// MarkerGlyph — the one place a measurement becomes pixels (spec: keep the
// carrier→color / mode→glyph handoff cheap for the future compare-mode pass).
// ---------------------------------------------------------------------------

function MarkerGlyph({
  x,
  y,
  r,
  carrier,
  mode,
  alpha,
  selected,
}: {
  x: number;
  y: number;
  r: number;
  carrier: string | null | undefined;
  mode: string | null | undefined;
  alpha: number;
  selected: boolean;
}) {
  const color = carrierColor(carrier);
  const glyph = modeGlyph(mode);
  return (
    <>
      {glyph === "diamond" ? (
        <path
          d={`M ${x} ${y - r} L ${x + r} ${y} L ${x} ${y + r} L ${x - r} ${y} Z`}
          fill={color}
          fillOpacity={alpha}
          stroke={color}
          strokeOpacity={Math.min(1, alpha + 0.25)}
          strokeWidth={1}
        />
      ) : (
        <circle
          cx={x}
          cy={y}
          r={r}
          fill={color}
          fillOpacity={alpha}
          stroke={color}
          strokeOpacity={Math.min(1, alpha + 0.25)}
          strokeWidth={1}
        />
      )}
      {selected && (
        <circle
          cx={x}
          cy={y}
          r={r + 3.5}
          fill="none"
          stroke="var(--color-text)"
          strokeWidth={1.5}
          pointerEvents="none"
        />
      )}
    </>
  );
}

/** Read/write tap arrow between the residual bar and a marker: read taps
 * point OUT of the stream (arrowhead at the marker), write taps point INTO
 * it (arrowhead at the bar). dirn +1 = structure below the bar (run band). */
function TapArrow({
  x,
  barEdge,
  markerEdge,
  dirn,
  mode,
  color,
}: {
  x: number;
  barEdge: number;
  markerEdge: number;
  dirn: 1 | -1;
  mode: string | null | undefined;
  color: string;
}) {
  if (Math.abs(markerEdge - barEdge) < 8) return null;
  const write = modeGlyph(mode) === "diamond";
  // Arrowhead apex: at the bar for writes, at the marker for reads.
  const apexY = write ? barEdge : markerEdge;
  const baseY = apexY + (write ? dirn : -dirn) * 4;
  return (
    <g pointerEvents="none">
      <line
        x1={x}
        y1={barEdge}
        x2={x}
        y2={markerEdge}
        stroke={color}
        strokeOpacity={0.45}
        strokeWidth={1}
      />
      <path
        d={`M ${x - 3.5} ${baseY} L ${x + 3.5} ${baseY} L ${x} ${apexY} Z`}
        fill={color}
        fillOpacity={0.6}
      />
    </g>
  );
}

// ---------------------------------------------------------------------------
// One band (run or twin): bar + heat + ruler + ribbons + containers +
// component slots/strips + tap arrows + markers. The twin band is the same
// code mirrored via dirn = −1 (structure grows UP from its bar).
// ---------------------------------------------------------------------------

interface PlacedMarker {
  m: InterpMeasurement;
  key: string;
  x: number;
  cy: number;
  r: number;
  delta: number | null;
  layer: number | null; // null = global/parameter lane
}

/** Vertical room the component sub-band (head slots / neuron strip + leaf
 * labels) claims at the top of a layer container. */
function slotBlockFor(lod: Lod): number {
  if (lod !== "component" && lod !== "leaf") return 0;
  return 5 + SLOT_H + (lod === "leaf" ? 10 : 0) + 5;
}

/**
 * Marker layout for one band: group placeable measurements by layer, stack
 * them below/above the bar. ONE function shared by BandView (visible glyphs)
 * and the pane's top-most hit layer (transparent targets painted after the
 * circuit hit arcs, so a precise marker hover/click always beats them) —
 * both must agree on coordinates exactly.
 */
function placeBandMarkers(
  row: RunRow,
  side: "run" | "twin",
  scale: Scale,
  bands: AnatomyBands,
  deltaMax: number,
): { placed: PlacedMarker[]; containerRows: Map<number, { n: number; pitch: number }> } {
  const dirn: 1 | -1 = side === "run" ? 1 : -1;
  const bar = side === "run" ? bands.runBar : bands.twinBar;
  const zone = side === "run" ? bands.runZone : bands.twinZone;
  const barEdge = side === "run" ? bar.y1 : bar.y0;
  const zoneH = zone.y1 - zone.y0;
  const nL = scale.shape.nLayers;
  const ms = measurementsOf(row);
  const lods: Lod[] = Array.from({ length: nL }, (_, i) => lodForLayer(scale, i));

  const groups = new Map<number | "global", InterpMeasurement[]>();
  for (const m of ms) {
    if (m.locus_shape === "subgraph" || m.locus_shape === "path") continue; // arcs render circuits
    const x = scale.xForMeasurement(m);
    if (x === null) continue;
    const layer =
      typeof m.layer === "number" && m.layer >= 0 && m.layer < nL ? m.layer : null;
    if (layer !== null && lods[layer] === "model") continue; // aggregated into heat
    const key = layer ?? "global";
    const arr = groups.get(key);
    if (arr) arr.push(m);
    else groups.set(key, [m]);
  }

  const placed: PlacedMarker[] = [];
  const containerRows = new Map<number, { n: number; pitch: number }>();
  for (const [gkey, arr] of groups) {
    arr.sort((a, b) => Math.abs(deltaOf(b) ?? 0) - Math.abs(deltaOf(a) ?? 0));
    const off = gkey === "global" ? 0 : slotBlockFor(lods[gkey]);
    const first = off + STACK_FIRST;
    const avail = zoneH - first - 18;
    const pitch =
      arr.length > 1 ? Math.min(STACK_PITCH, Math.max(18, avail / (arr.length - 1))) : 0;
    if (gkey !== "global") containerRows.set(gkey, { n: arr.length, pitch });
    arr.forEach((m, idx) => {
      const x = scale.xForMeasurement(m)!;
      const d = deltaOf(m);
      const raw =
        gkey === "global"
          ? side === "run"
            ? zone.y1 - 14 - idx * 24
            : zone.y0 + 14 + idx * 24
          : barEdge + dirn * (first + idx * pitch);
      const cy = Math.min(zone.y1 - 6, Math.max(zone.y0 + 6, raw));
      placed.push({
        m,
        key: measurementKey(m),
        x,
        cy,
        r: deltaRadius(d, deltaMax),
        delta: d,
        layer: gkey === "global" ? null : gkey,
      });
    });
  }
  return { placed, containerRows };
}

function BandView({
  row,
  side,
  scale,
  bands,
  deltaMax,
  heat,
  heatMax,
  sel,
  onUnitClick,
}: {
  row: RunRow;
  side: "run" | "twin";
  scale: Scale;
  bands: AnatomyBands;
  deltaMax: number;
  heat: Map<number, number>;
  heatMax: number;
  sel: string | null;
  /** Blow-up request for a clicked unit path. */
  onUnitClick?: (path: string) => void;
}) {
  const dirn: 1 | -1 = side === "run" ? 1 : -1;
  const bar = side === "run" ? bands.runBar : bands.twinBar;
  const zone = side === "run" ? bands.runZone : bands.twinZone;
  const barEdge = side === "run" ? bar.y1 : bar.y0; // structure-facing edge
  const barH = bar.y1 - bar.y0;
  const zoneH = zone.y1 - zone.y0;
  const nL = scale.shape.nLayers;
  const nHeads = scale.shape.nHeads;
  const ms = measurementsOf(row);

  const embed = scale.xForPath("embed")!;
  const unembed = scale.xForPath("unembed")!;
  const layerSpans = Array.from({ length: nL }, (_, i) => scale.xForPath(`L${i}`)!);
  const lods: Lod[] = Array.from({ length: nL }, (_, i) => lodForLayer(scale, i));
  const slotBlock = (i: number): number => slotBlockFor(lods[i]);

  const { placed, containerRows } = placeBandMarkers(row, side, scale, bands, deltaMax);

  // Head slots carrying measurements (layer → head → carrier color).
  const headHits = new Map<number, Map<number, string>>();
  for (const m of ms) {
    if (m.locus_shape !== "head") continue;
    if (typeof m.layer !== "number" || typeof m.head !== "number") continue;
    const inner = headHits.get(m.layer) ?? new Map<number, string>();
    inner.set(m.head, carrierColor(m.carrier));
    headHits.set(m.layer, inner);
  }
  // Neuron-strip sources (layer → components + carrier).
  const stripSources = new Map<number, { comps: [number, number][]; color: string }>();
  for (const m of ms) {
    if (!m.components?.length || typeof m.layer !== "number") continue;
    const prev = stripSources.get(m.layer);
    stripSources.set(m.layer, {
      comps: prev ? [...prev.comps, ...m.components] : m.components,
      color: prev?.color ?? carrierColor(m.carrier ?? "feature"),
    });
  }

  // Ruler ticks: layer boundaries, thinned to ≥ RULER_TICK_MIN_PX apart.
  const ticks: number[] = [];
  let lastTick = -Infinity;
  for (let i = 1; i < nL; i++) {
    const x = layerSpans[i].x0;
    if (x - lastTick >= RULER_TICK_MIN_PX) {
      ticks.push(x);
      lastTick = x;
    }
  }

  const ribbons = ms.filter((m) => (m.layer_profile?.length ?? 0) > 1);
  const ribbonH = Math.min(RIBBON_MAX_PX, Math.max(6, zoneH * 0.4));

  return (
    <g>
      {/* residual bar (embed → unembed) */}
      <rect
        x={embed.x0}
        y={bar.y0}
        width={unembed.x1 - embed.x0}
        height={barH}
        rx={3}
        fill="var(--color-surface-alt)"
        stroke="var(--color-border)"
        strokeWidth={1}
      >
        <title>{`${side} residual stream — L0 → L${nL - 1}`}</title>
      </rect>

      {/* model-LOD heat cells: per-layer max |Δ| of resid evidence */}
      {heatMax > 0 &&
        layerSpans.map((s, i) => {
          if (lods[i] !== "model") return null;
          const v = heat.get(i);
          if (!v) return null;
          return (
            <FadeG key={`heat${i}`}>
              <rect
                x={s.x0}
                y={bar.y0 + 1}
                width={Math.max(0.5, s.x1 - s.x0)}
                height={barH - 2}
                fill="var(--color-accent)"
                fillOpacity={0.1 + 0.8 * Math.min(1, v / heatMax)}
                pointerEvents="none"
              />
            </FadeG>
          );
        })}

      {/* layer boundary ticks + layer numbers where they fit */}
      {ticks.map((x, i) => (
        <line
          key={`t${i}`}
          x1={x}
          y1={bar.y0 + 2}
          x2={x}
          y2={bar.y1 - 2}
          stroke="var(--color-bg)"
          strokeOpacity={0.9}
          strokeWidth={1}
          pointerEvents="none"
        />
      ))}
      {layerSpans.map((s, i) =>
        s.x1 - s.x0 >= RULER_LABEL_MIN_PX ? (
          <text
            key={`n${i}`}
            x={(s.x0 + s.x1) / 2}
            y={(bar.y0 + bar.y1) / 2 + 3}
            fontSize={9}
            textAnchor="middle"
            fill="var(--color-text-muted)"
            className="font-mono"
            pointerEvents="none"
          >
            {i}
          </text>
        ) : null,
      )}

      {/* per-layer bar hit rects — click any layer (even hairline-thin at
          model LOD) to blow it up */}
      {onUnitClick &&
        layerSpans.map((s, i) => (
          <rect
            key={`bh${i}`}
            x={s.x0}
            y={bar.y0}
            width={Math.max(0.5, s.x1 - s.x0)}
            height={barH}
            fill="transparent"
            className="cursor-pointer"
            onClick={() => onUnitClick(`L${i}`)}
          >
            <title>{`L${i} — click to blow up`}</title>
          </rect>
        ))}

      {/* pinned end caps */}
      {(["embed", "unembed"] as const).map((cap) => {
        const s = cap === "embed" ? embed : unembed;
        return (
          <g key={cap}>
            <rect
              x={s.x0}
              y={bar.y0}
              width={s.x1 - s.x0}
              height={barH}
              rx={3}
              fill="var(--color-border)"
              fillOpacity={0.9}
              className={onUnitClick ? "cursor-pointer" : undefined}
              onClick={onUnitClick ? () => onUnitClick(cap) : undefined}
            >
              <title>{cap}</title>
            </rect>
            {s.x1 - s.x0 >= CAP_LABEL_MIN_PX && (
              <text
                x={(s.x0 + s.x1) / 2}
                y={(bar.y0 + bar.y1) / 2 + 3}
                fontSize={9}
                textAnchor="middle"
                fill="var(--color-text)"
                className="font-mono"
                pointerEvents="none"
              >
                {cap}
              </text>
            )}
          </g>
        );
      })}

      {/* layer_profile sweep ribbons — the per-layer story at every LOD */}
      {ribbons.map((m, ri) => {
        const pts: string[] = [];
        let first: number | null = null;
        let last: number | null = null;
        for (const p of m.layer_profile!) {
          const l = p?.[0];
          const v = p?.[1];
          if (typeof l !== "number" || typeof v !== "number") continue;
          if (l < 0 || l >= nL) continue;
          const s = layerSpans[l];
          const x = (s.x0 + s.x1) / 2;
          const h =
            deltaMax > 0 ? ribbonH * Math.min(1, Math.abs(v) / deltaMax) : 0;
          pts.push(`L ${x} ${barEdge + dirn * h}`);
          if (first === null) first = x;
          last = x;
        }
        if (first === null || last === null || pts.length < 2) return null;
        const d = `M ${first} ${barEdge} ${pts.join(" ")} L ${last} ${barEdge} Z`;
        const color = carrierColor(m.carrier);
        return (
          <path
            key={`rib${ri}`}
            d={d}
            fill={color}
            fillOpacity={0.14}
            stroke={color}
            strokeOpacity={0.5}
            strokeWidth={1}
            pointerEvents="none"
          />
        );
      })}

      {/* layer containers hanging off the bar (LAYER LOD and deeper) */}
      {layerSpans.map((s, i) => {
        if (lods[i] === "model") return null;
        const rows = containerRows.get(i);
        const sb = slotBlock(i);
        const h = Math.min(
          Math.max(0, zoneH - 2),
          rows
            ? sb + STACK_FIRST + (rows.n - 1) * rows.pitch + 18
            : sb > 0
              ? sb + 4
              : EMPTY_CONTAINER_H,
        );
        return (
          <FadeG key={`c${i}`}>
            <rect
              x={s.x0 + 0.75}
              y={side === "run" ? barEdge : barEdge - h}
              width={Math.max(0.5, s.x1 - s.x0 - 1.5)}
              height={h}
              rx={2}
              fill="var(--color-surface-alt)"
              fillOpacity={0.18}
              stroke="var(--color-border)"
              strokeOpacity={0.55}
              strokeWidth={1}
              className={onUnitClick ? "cursor-pointer" : undefined}
              onClick={onUnitClick ? () => onUnitClick(`L${i}`) : undefined}
            >
              <title>{`L${i} (${lods[i]}) — click to blow up`}</title>
            </rect>
          </FadeG>
        );
      })}

      {/* COMPONENT/LEAF LOD: attn head slots + mlp neuron strip */}
      {layerSpans.map((_, i) => {
        const lod = lods[i];
        if (lod !== "component" && lod !== "leaf") return null;
        const attn = scale.xForPath(`L${i}/attn`);
        const mlp = scale.xForPath(`L${i}/mlp`);
        if (!attn || !mlp) return null;
        const slotY = side === "run" ? barEdge + 5 : barEdge - 5 - SLOT_H;
        const labelY = side === "run" ? slotY + SLOT_H + 8 : slotY - 3;
        const hits = headHits.get(i);
        const nodes: React.ReactNode[] = [];

        // attn → head slots (needs a known head count; else one plain span)
        if (typeof nHeads === "number" && nHeads > 0) {
          for (let h = 0; h < nHeads; h++) {
            const hs = scale.xForPath(`L${i}/attn/h${h}`);
            if (!hs) continue;
            const w = hs.x1 - hs.x0;
            const hitColor = hits?.get(h);
            nodes.push(
              <rect
                key={`h${i}-${h}`}
                x={w > 3 ? hs.x0 + 0.5 : hs.x0}
                y={slotY}
                width={Math.max(0.5, w > 3 ? w - 1 : w)}
                height={SLOT_H}
                fill={hitColor ?? "var(--color-border)"}
                fillOpacity={hitColor ? 0.65 : 0.3}
                className={onUnitClick ? "cursor-pointer" : undefined}
                onClick={onUnitClick ? () => onUnitClick(`L${i}/attn/h${h}`) : undefined}
              >
                <title>{`L${i}/attn/h${h} — click to blow up`}</title>
              </rect>,
            );
            if (lod === "leaf" && w >= SLOT_LABEL_MIN_PX) {
              nodes.push(
                <text
                  key={`hl${i}-${h}`}
                  x={(hs.x0 + hs.x1) / 2}
                  y={labelY}
                  fontSize={8}
                  textAnchor="middle"
                  fill={hitColor ?? "var(--color-text-faint)"}
                  className="font-mono"
                  pointerEvents="none"
                >
                  {h}
                </text>,
              );
            }
          }
        } else {
          nodes.push(
            <rect
              key={`attn${i}`}
              x={attn.x0 + 0.5}
              y={slotY}
              width={Math.max(0.5, attn.x1 - attn.x0 - 1)}
              height={SLOT_H}
              fill="var(--color-border)"
              fillOpacity={0.3}
              className={onUnitClick ? "cursor-pointer" : undefined}
              onClick={onUnitClick ? () => onUnitClick(`L${i}/attn`) : undefined}
            >
              <title>{`L${i}/attn (head count unknown)`}</title>
            </rect>,
          );
        }

        // mlp → binned neuron strip (one click surface: the whole strip)
        const mlpW = mlp.x1 - mlp.x0;
        const nBins = Math.min(160, Math.max(8, Math.floor(mlpW / 3)));
        const src = stripSources.get(i);
        const bins = neuronBins(src?.comps, scale.shape.dMlp, nBins);
        const binMax = bins.reduce((a, b) => Math.max(a, b.value), 0);
        const binW = mlpW / nBins;
        const mlpNodes: React.ReactNode[] = [
          <rect
            key={`mlp${i}`}
            x={mlp.x0 + 1}
            y={slotY}
            width={Math.max(0.5, mlpW - 2)}
            height={SLOT_H}
            fill="var(--color-border)"
            fillOpacity={0.2}
          >
            <title>{`L${i}/mlp${scale.shape.dMlp ? ` — ${scale.shape.dMlp} neurons` : ""}`}</title>
          </rect>,
        ];
        if (binMax > 0) {
          bins.forEach((b, bi) => {
            if (b.value <= 0) return;
            mlpNodes.push(
              <rect
                key={`b${i}-${bi}`}
                x={mlp.x0 + bi * binW}
                y={slotY}
                width={Math.max(1, binW - (binW > 2 ? 0.5 : 0))}
                height={SLOT_H}
                fill={src!.color}
                fillOpacity={0.25 + 0.7 * (b.value / binMax)}
              >
                <title>{`L${i}/mlp neuron ${b.top} — weight ${fmtNum(b.value)}`}</title>
              </rect>,
            );
            if (lod === "leaf" && binW >= BIN_LABEL_MIN_PX && b.top !== null) {
              mlpNodes.push(
                <text
                  key={`bl${i}-${bi}`}
                  x={mlp.x0 + (bi + 0.5) * binW}
                  y={labelY}
                  fontSize={8}
                  textAnchor="middle"
                  fill="var(--color-text-faint)"
                  className="font-mono"
                  pointerEvents="none"
                >
                  {b.top}
                </text>,
              );
            }
          });
        }
        nodes.push(
          <g
            key={`mlpg${i}`}
            className={onUnitClick ? "cursor-pointer" : undefined}
            onClick={onUnitClick ? () => onUnitClick(`L${i}/mlp`) : undefined}
          >
            {mlpNodes}
          </g>,
        );
        return <FadeG key={`comp${i}-${lod}`}>{nodes}</FadeG>;
      })}

      {/* tap arrows (decorative; under the markers) */}
      {placed.map((p, i) =>
        p.layer !== null ? (
          <TapArrow
            key={`a${i}`}
            x={p.x}
            barEdge={barEdge + dirn * (slotBlock(p.layer) + 2)}
            markerEdge={p.cy - dirn * (p.r + 2)}
            dirn={dirn}
            mode={p.m.mode}
            color={carrierColor(p.m.carrier)}
          />
        ) : null,
      )}

      {/* markers + null-control ghosts (native titles stay for export/a11y;
          live hover goes through the transparent hit circles below) */}
      {placed.map((p, i) => (
        <g key={`m${i}`}>
          <title>{measurementTitle(p.m)}</title>
          <MarkerGlyph
            x={p.x}
            y={p.cy}
            r={p.r}
            carrier={p.m.carrier}
            mode={p.m.mode}
            alpha={deltaAlpha(p.delta, deltaMax)}
            selected={sel !== null && sel === p.key}
          />
          {p.m.null_control !== null && (
            <circle
              cx={p.x + p.r + 5}
              cy={p.cy}
              r={GHOST_RADIUS}
              fill="var(--color-text-faint)"
              fillOpacity={0.7}
            />
          )}
        </g>
      ))}

    </g>
  );
}

/** Transparent marker hit targets for one band — mounted by the pane AFTER
 * the circuit hit arcs so precise marker hover/click always wins where a
 * generous 9px arc crosses a marker. */
function MarkerHits({
  placed,
  side,
  onMarkerClick,
  onMarkerHover,
}: {
  placed: PlacedMarker[];
  side: "run" | "twin";
  onMarkerClick: (m: InterpMeasurement) => void;
  onMarkerHover: (p: { m: InterpMeasurement; x: number; y: number } | null) => void;
}) {
  return (
    <g>
      {placed.map((p, i) => (
        <circle
          key={`mh${i}`}
          cx={p.x}
          cy={p.cy}
          r={Math.max(9, p.r + 4)}
          fill="transparent"
          className="cursor-pointer"
          data-anatomy-marker={p.key}
          data-anatomy-side={side}
          onMouseEnter={() => onMarkerHover({ m: p.m, x: p.x, y: p.cy })}
          onMouseLeave={() => onMarkerHover(null)}
          onClick={() => onMarkerClick(p.m)}
        />
      ))}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Circuit arcs — nodes ringed at their loci on the bars, edges as beziers
// dipping through the middle zone, always earlier → later (left → right).
// With a twin comparison, side-exclusive edges take the run/twin semantic
// colors (accent/warning — same legend as the diff strip).
// ---------------------------------------------------------------------------

interface ArcSpec {
  d: string;
  color: string;
  opacity: number;
  width: number;
}

function circuitArcs(
  m: InterpMeasurement,
  counterpart: InterpMeasurement | null,
  side: "run" | "twin",
  scale: Scale,
  bands: AnatomyBands,
  twinOn: boolean,
): { arcs: ArcSpec[]; anchorY: number } {
  const anchorY = side === "run" ? bands.runBar.y1 + 3 : bands.twinBar.y0 - 3;
  const W = scale.width;
  // Arc dip region: the middle zone when the twin band is on; the lower part
  // of the run zone when it's collapsed.
  const dip = twinOn
    ? bands.middle
    : {
        y0: bands.runZone.y0 + (bands.runZone.y1 - bands.runZone.y0) * 0.55,
        y1: bands.runZone.y1,
      };
  const carrier = carrierColor(m.carrier ?? "circuit");
  const diff = counterpart ? circuitDiff(side === "run" ? m : counterpart, side === "run" ? counterpart : m) : null;
  const own = diff ? (side === "run" ? diff.onlyRun : diff.onlyTwin) : null;
  const shared = diff?.shared ?? null;
  const exclusiveColor = side === "run" ? "var(--color-accent)" : "var(--color-warning)";

  const edges: Array<{ from: CircuitNode; to: CircuitNode; cls: "plain" | "shared" | "own" }> = [];
  if (diff && own && shared) {
    for (const e of shared) edges.push({ ...e, cls: "shared" });
    for (const e of own) edges.push({ ...e, cls: "own" });
  } else {
    const nodes = m.nodes ?? [];
    for (const e of m.edges ?? []) {
      const from = nodes[e?.[0] as number];
      const to = nodes[e?.[1] as number];
      if (from && to) edges.push({ from, to, cls: "plain" });
    }
  }

  const arcs: ArcSpec[] = [];
  for (const e of edges) {
    let x0 = scale.xForNode(e.from);
    let x1 = scale.xForNode(e.to);
    if (x0 === null || x1 === null) continue;
    if (x1 < x0) [x0, x1] = [x1, x0]; // left → right, always
    const dx = Math.max(1, x1 - x0);
    const depth = 0.3 + 0.6 * Math.min(1, dx / (W / 2));
    const yc =
      side === "run"
        ? dip.y0 + (dip.y1 - dip.y0) * depth
        : dip.y1 - (dip.y1 - dip.y0) * depth;
    const d = `M ${x0} ${anchorY} C ${x0 + dx * 0.2} ${yc}, ${x1 - dx * 0.2} ${yc}, ${x1} ${anchorY}`;
    if (e.cls === "own") arcs.push({ d, color: exclusiveColor, opacity: 0.95, width: 2.2 });
    else if (e.cls === "shared")
      arcs.push({
        d,
        color: carrier,
        opacity: side === "run" ? 0.38 : 0.22,
        width: 1.1,
      });
    else arcs.push({ d, color: carrier, opacity: 0.6, width: 1.4 });
  }
  return { arcs, anchorY };
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

export function AnatomyBody({
  rows,
  bundle,
}: {
  rows: RunRow[]; // the filtered (+sorted) rows — anatomy, chart and table always agree
  bundle: Bundle;
  index: MetricIndex;
}) {
  const anatomy = useBoolbackStore((s) => s.anatomy);
  const selectedDir = useBoolbackStore((s) => s.selectedDir);
  const hoveredDir = useBoolbackStore((s) => s.hoveredDir);
  const setAnatomy = useBoolbackStore((s) => s.setAnatomy);
  const openDetail = useBoolbackStore((s) => s.openDetail);
  const expandChain = useBoolbackStore((s) => s.expandChain);
  const hover = useBoolbackStore((s) => s.hover);

  // The SVG draws at the plot container's real pixel size (see FALLBACK note).
  const plotRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(FALLBACK);
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r || r.width < 80 || r.height < 80) return; // hidden/degenerate pane
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const W = size.w;
  const H = size.h;

  // Run selection: the selected row when visible, else the first visible row.
  const run = useMemo(
    () => rows.find((r) => r.identity.node_path === selectedDir) ?? rows[0] ?? null,
    [rows, selectedDir],
  );
  // Twin via twin_hash — against ALL loaded rows (it may be filtered out).
  const twinRow = useMemo(
    () => (run ? findTwinRow(run, bundle.rows) : null),
    [run, bundle.rows],
  );
  const twinOn = Boolean(anatomy.twin && twinRow);

  const shape = useMemo(() => (run ? rowShape(run) : null), [run]);

  // ---- animated accordion focus -------------------------------------------
  // The store holds the TARGET focus (committed once per gesture); a rAF
  // loop tweens a render-only copy the scale derives from each frame.
  const [renderFocus, setRenderFocus] = useState<Focus>(anatomy.focus);
  const renderFocusRef = useRef<Focus>(anatomy.focus);
  const targetRef = useRef<Focus>(anatomy.focus);
  const rafRef = useRef<number | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const animateTo = useCallback((to: Focus) => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    const from = renderFocusRef.current;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / FOCUS_ANIM_MS);
      const f = lerpFocus(from, to, t);
      renderFocusRef.current = f;
      setRenderFocus(f);
      rafRef.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    rafRef.current = requestAnimationFrame(step);
  }, []);

  /** Route EVERY focus change through here: animate the pane, commit the
   * target to the store once (debounced for wheel gestures). */
  const applyFocus = useCallback(
    (next: Focus, opts?: { debounceCommit?: boolean }) => {
      if (next === targetRef.current) return;
      targetRef.current = next;
      animateTo(next);
      if (commitTimer.current) clearTimeout(commitTimer.current);
      if (opts?.debounceCommit) {
        commitTimer.current = setTimeout(() => {
          commitTimer.current = null;
          setAnatomy({ focus: targetRef.current });
        }, WHEEL_COMMIT_MS);
      } else {
        commitTimer.current = null;
        setAnatomy({ focus: next });
      }
    },
    [animateTo, setAnatomy],
  );

  // Adopt EXTERNAL store focus changes (hydration, share links). Our own
  // commits write the exact target object, so Object.is filters them out.
  useEffect(() => {
    if (Object.is(anatomy.focus, targetRef.current)) return;
    targetRef.current = anatomy.focus;
    animateTo(anatomy.focus);
  }, [anatomy.focus, animateTo]);

  // Store hover publishing (debounced like the table's row hover).
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publishHover = useCallback(
    (dir: string | null) => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      hoverTimer.current = setTimeout(() => hover(dir), HOVER_DEBOUNCE_MS);
    },
    [hover],
  );

  // Unmount: stop the tween, flush a pending wheel commit (view switches
  // must not lose the last gesture), silence hover.
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (commitTimer.current) {
        clearTimeout(commitTimer.current);
        setAnatomy({ focus: targetRef.current });
      }
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      hover(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const scale = useMemo(
    () => (shape ? buildScale(renderFocus, shape, W) : null),
    [shape, renderFocus, W],
  );
  const bands = useMemo(() => computeBands(H, twinOn), [H, twinOn]);
  // Match against the twin whenever one EXISTS (deltaMax and marker sizes
  // stay stable across the twin toggle); pairs render only when shown.
  const match = useMemo(
    () => (run ? matchMeasurements(run, twinRow) : null),
    [run, twinRow],
  );
  const runHeat = useMemo(
    () => residLayerHeat(run ? measurementsOf(run) : []),
    [run],
  );
  const twinHeat = useMemo(
    () => residLayerHeat(twinRow ? measurementsOf(twinRow) : []),
    [twinRow],
  );
  const heatMax = useMemo(() => {
    let max = 0;
    for (const v of runHeat.values()) max = Math.max(max, v);
    for (const v of twinHeat.values()) max = Math.max(max, v);
    return max;
  }, [runHeat, twinHeat]);

  // Marker layouts (shared with BandView's glyphs) for the top-most hit layer.
  const runPlaced = useMemo(
    () =>
      run && scale && match
        ? placeBandMarkers(run, "run", scale, bands, match.deltaMax).placed
        : null,
    [run, scale, bands, match],
  );
  const twinPlaced = useMemo(
    () =>
      twinOn && twinRow && scale && match
        ? placeBandMarkers(twinRow, "twin", scale, bands, match.deltaMax).placed
        : null,
    [twinOn, twinRow, scale, bands, match],
  );

  const hasAnatomyFields = useMemo(
    () =>
      run
        ? measurementsOf(run).some(
            (m) =>
              m.layer != null ||
              m.locus_component != null ||
              m.locus_shape != null ||
              m.layer_profile != null ||
              m.nodes != null ||
              m.carrier != null,
          )
        : false,
    [run],
  );

  const sel = anatomy.sel;

  // ---- interaction handlers ------------------------------------------------
  const handleUnitClick = useCallback(
    (path: string) => {
      if (!shape) return;
      applyFocus(blowUp(targetRef.current, path, shape));
    },
    [shape, applyFocus],
  );
  const handleReset = useCallback(() => applyFocus(reset()), [applyFocus]);

  const selectMeasurement = useCallback(
    (m: InterpMeasurement, row: RunRow | null) => {
      setAnatomy({ sel: measurementKey(m) });
      if (row) {
        openDetail(row.identity.node_path);
        expandChain(row.identity.chain_dirs);
      }
    },
    [setAnatomy, openDetail, expandChain],
  );

  // HTML tooltip state (pane-space coords; the plot div is padding-less so
  // SVG x/y map 1:1 onto absolute offsets).
  const [hoverInfo, setHoverInfo] = useState<{
    m: InterpMeasurement;
    x: number;
    y: number;
  } | null>(null);
  const handleMarkerHover = useCallback(
    (p: { m: InterpMeasurement; x: number; y: number } | null, row: RunRow | null) => {
      setHoverInfo(p);
      publishHover(p && row ? row.identity.node_path : null);
    },
    [publishHover],
  );

  // Wheel zoom — non-passive listener (React's synthetic wheel can't
  // preventDefault), targeting the unit chain under the cursor.
  const latest = useRef<{ scale: Scale | null }>({ scale: null });
  latest.current.scale = scale;
  const hasPlot = Boolean(run && shape);
  useEffect(() => {
    const el = svgRef.current;
    if (!el || !hasPlot) return;
    const onWheel = (e: WheelEvent) => {
      const sc = latest.current.scale;
      if (!sc) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const chain = unitChainAtX(sc, e.clientX - rect.left);
      if (chain.length === 0) return;
      const factor = Math.pow(WHEEL_ZOOM_BASE, -e.deltaY / 100);
      const next = zoomChain(targetRef.current, chain, factor);
      if (next !== targetRef.current) applyFocus(next, { debounceCommit: true });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [hasPlot, applyFocus]);

  // Keyboard: ←/→ layer cursor, +/- zoom it, Esc reset. The cursor ring
  // shows while the pane has focus; it starts on the heaviest-focused layer
  // (else mid-stack) so the first keypress acts where the eye already is.
  const [paneFocused, setPaneFocused] = useState(false);
  const [kbLayer, setKbLayer] = useState<number | null>(null);
  const defaultKbLayer = useMemo(() => {
    if (!shape) return 0;
    let best: number | null = null;
    let bestW = 1;
    for (const [k, v] of Object.entries(anatomy.focus)) {
      const p = /^L(\d+)$/.exec(k);
      if (!p) continue;
      const layer = Number(p[1]);
      const w = typeof v === "number" && Number.isFinite(v) ? v : 1;
      if (layer >= 0 && layer < shape.nLayers && w > bestW) {
        bestW = w;
        best = layer;
      }
    }
    return best ?? Math.floor(shape.nLayers / 2);
  }, [anatomy.focus, shape]);
  const cursorLayer = kbLayer ?? defaultKbLayer;

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!shape) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const next = Math.min(
          shape.nLayers - 1,
          Math.max(0, cursorLayer + (e.key === "ArrowRight" ? 1 : -1)),
        );
        setKbLayer(next);
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setKbLayer(cursorLayer);
        applyFocus(zoomChain(targetRef.current, [`L${cursorLayer}`], KB_ZOOM));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setKbLayer(cursorLayer);
        applyFocus(zoomChain(targetRef.current, [`L${cursorLayer}`], 1 / KB_ZOOM));
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // pane-local reset; don't also close the detail panel
        handleReset();
      }
    },
    [shape, cursorLayer, applyFocus, handleReset],
  );

  // Circuits both sides, paired by measurement key for the diff coloring.
  const circuits = useMemo(() => {
    if (!run) return [];
    const isCircuit = (m: InterpMeasurement) =>
      m.locus_shape === "subgraph" || m.locus_shape === "path";
    const runCs = measurementsOf(run).filter(isCircuit);
    const twinCs = twinOn && twinRow ? measurementsOf(twinRow).filter(isCircuit) : [];
    const out: Array<{
      m: InterpMeasurement;
      counterpart: InterpMeasurement | null;
      side: "run" | "twin";
    }> = [];
    for (const m of runCs) {
      out.push({
        m,
        counterpart: twinCs.find((t) => measurementKey(t) === measurementKey(m)) ?? null,
        side: "run",
      });
    }
    for (const t of twinCs) {
      out.push({
        m: t,
        counterpart: runCs.find((m) => measurementKey(m) === measurementKey(t)) ?? null,
        side: "twin",
      });
    }
    return out;
  }, [run, twinRow, twinOn]);
  const anyCircuitSelected =
    sel !== null && circuits.some((c) => measurementKey(c.m) === sel);
  const selCircuit = useMemo(
    () => (sel === null ? null : circuits.find((c) => measurementKey(c.m) === sel) ?? null),
    [sel, circuits],
  );

  // Cross-view rings on the header run/twin ids (chart-point precedent).
  const runLinked = Boolean(
    run &&
      (hoveredDir === run.identity.node_path || selectedDir === run.identity.node_path),
  );
  const twinLinked = Boolean(
    twinRow &&
      (hoveredDir === twinRow.identity.node_path ||
        selectedDir === twinRow.identity.node_path),
  );

  // Diff strip data: per-layer excess + paired whiskers.
  const middle = bands.middle;
  const middleH = middle.y1 - middle.y0;
  const middleCy = (middle.y0 + middle.y1) / 2;
  const excessMax = useMemo(() => {
    if (!match) return 0;
    let max = 0;
    for (const ld of match.layerDeltas) max = Math.max(max, Math.abs(ld.run - ld.twin));
    return max;
  }, [match]);

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      data-anatomy-pane=""
      data-anatomy-ready={rows.length > 0 ? "" : undefined}
      className={`flex-1 min-h-0 flex flex-col outline-none ${
        paneFocused ? "ring-1 ring-inset ring-accent/25" : ""
      }`}
      onKeyDown={onKeyDown}
      onFocus={() => setPaneFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setPaneFocused(false);
      }}
      onMouseDown={(e) => {
        // Keep keyboard zoom reachable after any click inside the pane
        // (buttons keep their own focus).
        if ((e.target as HTMLElement).closest?.("button")) return;
        rootRef.current?.focus({ preventScroll: true });
      }}
    >
      {rows.length === 0 || !run ? (
        <div className="flex h-full items-center justify-center text-xs text-text-faint font-mono">
          No runs to dissect — every run is filtered out.
        </div>
      ) : (
        <>
          {/* pane header: which run (and twin) is on the table */}
          <div
            data-anatomy-header=""
            className="relative z-10 flex shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap border-b border-border bg-surface/50 px-2 h-7 text-[11px] font-mono"
          >
            <span className="text-text-muted">run</span>
            <span
              className={`flex min-w-0 items-center gap-2 rounded px-1 ${
                runLinked ? "ring-1 ring-text/40 bg-surface-alt/60" : ""
              }`}
            >
              <span className="text-accent">
                {fnText(run.function.arity, run.function.truth_table)}
              </span>
              <span className="truncate text-text" title={run.identity.run_id}>
                {run.identity.run_id}
              </span>
            </span>
            {twinOn && twinRow ? (
              <>
                <span className="ml-2 text-text-muted">twin</span>
                <span
                  className={`flex min-w-0 items-center gap-2 rounded px-1 ${
                    twinLinked ? "ring-1 ring-text/40 bg-surface-alt/60" : ""
                  }`}
                >
                  <span className="text-warning">
                    {fnText(twinRow.function.arity, twinRow.function.truth_table)}
                  </span>
                  <span className="truncate text-text-muted" title={twinRow.identity.run_id}>
                    {twinRow.identity.run_id}
                  </span>
                </span>
              </>
            ) : anatomy.twin && !twinRow ? (
              <span className="ml-2 text-text-faint">twin: none loaded</span>
            ) : null}
            {selCircuit && shape && (
              <button
                type="button"
                data-anatomy-fit=""
                onClick={() =>
                  applyFocus(fitCircuit(targetRef.current, selCircuit.m.nodes ?? [], shape))
                }
                className="ml-2 shrink-0 rounded border border-border px-1.5 py-px text-[10px] text-text-muted transition-colors hover:border-accent hover:text-accent"
                title="expand every layer this circuit touches"
              >
                fit circuit
              </button>
            )}
            {!hasAnatomyFields && (
              <span className="ml-auto text-text-faint">
                no anatomy fields on this run&apos;s measurements — structural spine only
              </span>
            )}
          </div>

          <div ref={plotRef} className="relative flex-1 min-w-0">
            {!shape || !scale || !match ? (
              <div className="flex h-full items-center justify-center text-xs text-text-faint font-mono">
                No layer count on this run — anatomy needs n_layers or layered measurements.
              </div>
            ) : (
              <svg
                ref={svgRef}
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio="xMidYMid meet"
                className="h-full w-full select-none"
                role="img"
                aria-label={`anatomy of ${run.identity.run_id}`}
              >
                {/* background: click clears selection, double-click resets zoom */}
                <rect
                  x={0}
                  y={0}
                  width={W}
                  height={H}
                  fill="transparent"
                  onClick={() => setAnatomy({ sel: null })}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    handleReset();
                  }}
                />
                <BandView
                  row={run}
                  side="run"
                  scale={scale}
                  bands={bands}
                  deltaMax={match.deltaMax}
                  heat={runHeat}
                  heatMax={heatMax}
                  sel={sel}
                  onUnitClick={handleUnitClick}
                />
                {twinOn && twinRow && (
                  <BandView
                    row={twinRow}
                    side="twin"
                    scale={scale}
                    bands={bands}
                    deltaMax={match.deltaMax}
                    heat={twinHeat}
                    heatMax={heatMax}
                    sel={sel}
                    onUnitClick={handleUnitClick}
                  />
                )}

                {/* contrast strip: per-layer diverging Δ cells (run-excess up
                    in accent, twin-excess down in warning) + centerline */}
                {twinOn && middleH > 8 && (
                  <g>
                    <line
                      x1={scale.xForPath("embed")!.x0}
                      y1={middleCy}
                      x2={scale.xForPath("unembed")!.x1}
                      y2={middleCy}
                      stroke="var(--color-border)"
                      strokeOpacity={0.6}
                      strokeDasharray="2 3"
                      pointerEvents="none"
                    />
                    {excessMax > 0 &&
                      match.layerDeltas.map((ld) => {
                        const excess = ld.run - ld.twin;
                        if (Math.abs(excess) < 1e-9) return null;
                        const s = scale.xForPath(`L${ld.layer}`);
                        if (!s || s.x1 - s.x0 < 1) return null;
                        const h = Math.max(
                          1.5,
                          (Math.abs(excess) / excessMax) * (middleH / 2 - 3),
                        );
                        return (
                          <rect
                            key={`d${ld.layer}`}
                            x={s.x0 + 0.5}
                            y={excess > 0 ? middleCy - h : middleCy}
                            width={Math.max(0.5, s.x1 - s.x0 - 1)}
                            height={h}
                            fill={excess > 0 ? "var(--color-accent)" : "var(--color-warning)"}
                            fillOpacity={0.55}
                          >
                            <title>{`L${ld.layer} — run ${fmtNum(ld.run)} vs twin ${fmtNum(
                              ld.twin,
                            )} (${excess > 0 ? "run" : "twin"} +${fmtNum(Math.abs(excess))})`}</title>
                          </rect>
                        );
                      })}

                    {/* paired-marker whiskers at LAYER+ LOD: per-pair |Δ| up
                        (run) / down (twin) from the centerline; an open dot
                        marks a side with no partner */}
                    {match.deltaMax > 0 &&
                      (() => {
                        const byLayer = new Map<number, MatchedPair[]>();
                        for (const p of match.pairs) {
                          const src = p.run ?? p.twin!;
                          if (
                            src.locus_shape === "subgraph" ||
                            src.locus_shape === "path"
                          )
                            continue;
                          const layer =
                            typeof src.layer === "number" &&
                            src.layer >= 0 &&
                            src.layer < scale.shape.nLayers
                              ? src.layer
                              : null;
                          if (layer === null) continue;
                          if (lodForLayer(scale, layer) === "model") continue;
                          const arr = byLayer.get(layer) ?? [];
                          arr.push(p);
                          byLayer.set(layer, arr);
                        }
                        const out: React.ReactNode[] = [];
                        const halfW = middleH / 2 - 4;
                        for (const [layer, pairs] of byLayer) {
                          pairs.forEach((p, idx) => {
                            const src = p.run ?? p.twin!;
                            const x0 = scale.xForMeasurement(src);
                            if (x0 === null) return;
                            const x = x0 + (idx - (pairs.length - 1) / 2) * 6;
                            const color = carrierColor(src.carrier);
                            const dRun = p.run ? deltaOf(p.run) : null;
                            const dTwin = p.twin ? deltaOf(p.twin) : null;
                            const upLen =
                              dRun !== null
                                ? Math.max(2, (Math.abs(dRun) / match.deltaMax) * halfW)
                                : null;
                            const downLen =
                              dTwin !== null
                                ? Math.max(2, (Math.abs(dTwin) / match.deltaMax) * halfW)
                                : null;
                            out.push(
                              <g key={`w${layer}-${idx}`} stroke={color} strokeOpacity={0.85}>
                                <title>{`${src.kind}${
                                  src.metric_name ? ` · ${src.metric_name}` : ""
                                } @ ${locusLabel(src)}\nrun Δ ${fmtNum(dRun)} · twin Δ ${fmtNum(
                                  dTwin,
                                )}`}</title>
                                {upLen !== null ? (
                                  <>
                                    <line x1={x} y1={middleCy} x2={x} y2={middleCy - upLen} strokeWidth={1.5} />
                                    <line x1={x - 2.5} y1={middleCy - upLen} x2={x + 2.5} y2={middleCy - upLen} strokeWidth={1.5} />
                                  </>
                                ) : (
                                  <circle cx={x} cy={middleCy - 5} r={2.5} fill="none" strokeWidth={1.25} />
                                )}
                                {downLen !== null ? (
                                  <>
                                    <line x1={x} y1={middleCy} x2={x} y2={middleCy + downLen} strokeWidth={1.5} />
                                    <line x1={x - 2.5} y1={middleCy + downLen} x2={x + 2.5} y2={middleCy + downLen} strokeWidth={1.5} />
                                  </>
                                ) : (
                                  <circle cx={x} cy={middleCy + 5} r={2.5} fill="none" strokeWidth={1.25} />
                                )}
                              </g>,
                            );
                          });
                        }
                        return out;
                      })()}
                  </g>
                )}

                {/* circuit arcs + node rings (selection emphasizes; others dim) */}
                {circuits.map((c, ci) => {
                  const key = measurementKey(c.m);
                  const isSel = sel !== null && sel === key;
                  const dim = anyCircuitSelected && !isSel ? 0.25 : 1;
                  const { arcs, anchorY } = circuitArcs(
                    c.m,
                    c.counterpart,
                    c.side,
                    scale,
                    bands,
                    twinOn,
                  );
                  const ringColor = carrierColor(c.m.carrier ?? "circuit");
                  const owner = c.side === "run" ? run : twinRow;
                  const onEnter = (e: React.MouseEvent) => {
                    const r = svgRef.current?.getBoundingClientRect();
                    handleMarkerHover(
                      {
                        m: c.m,
                        x: e.clientX - (r?.left ?? 0),
                        y: e.clientY - (r?.top ?? 0),
                      },
                      owner,
                    );
                  };
                  const onLeave = () => handleMarkerHover(null, owner);
                  const onClick = () => selectMeasurement(c.m, owner);
                  return (
                    <g key={`cir${ci}`}>
                      {arcs.map((a, ai) => (
                        <path
                          key={ai}
                          d={a.d}
                          fill="none"
                          stroke={a.color}
                          strokeOpacity={a.opacity * dim * (isSel ? 1.15 : 1)}
                          strokeWidth={a.width + (isSel ? 0.7 : 0)}
                          pointerEvents="none"
                        />
                      ))}
                      {(c.m.nodes ?? []).map((n, ni) => {
                        const x = scale.xForNode(n);
                        if (x === null) return null;
                        return (
                          <circle
                            key={`ring${ni}`}
                            cx={x}
                            cy={anchorY - (c.side === "run" ? 3 : -3)}
                            r={3.5}
                            fill="none"
                            stroke={ringColor}
                            strokeOpacity={0.9 * dim}
                            strokeWidth={isSel ? 2 : 1.5}
                            className="cursor-pointer"
                            onClick={onClick}
                          >
                            <title>{`${c.m.kind} node — L${n.layer}/${n.component}${
                              typeof n.head === "number" ? `/h${n.head}` : ""
                            }`}</title>
                          </circle>
                        );
                      })}
                      {/* generous transparent hit arcs, painted last */}
                      {arcs.map((a, ai) => (
                        <path
                          key={`hit${ai}`}
                          d={a.d}
                          fill="none"
                          stroke="transparent"
                          strokeWidth={9}
                          className="cursor-pointer"
                          data-anatomy-circuit={key}
                          onMouseEnter={onEnter}
                          onMouseLeave={onLeave}
                          onClick={onClick}
                        />
                      ))}
                    </g>
                  );
                })}

                {/* marker hit targets — after the circuit hit arcs, so a
                    precise marker always beats a generous arc stroke */}
                {runPlaced && (
                  <MarkerHits
                    placed={runPlaced}
                    side="run"
                    onMarkerClick={(m) => selectMeasurement(m, run)}
                    onMarkerHover={(p) => handleMarkerHover(p, run)}
                  />
                )}
                {twinPlaced && twinRow && (
                  <MarkerHits
                    placed={twinPlaced}
                    side="twin"
                    onMarkerClick={(m) => selectMeasurement(m, twinRow)}
                    onMarkerHover={(p) => handleMarkerHover(p, twinRow)}
                  />
                )}

                {/* keyboard layer cursor — visible while the pane has focus */}
                {paneFocused &&
                  (() => {
                    const s = scale.xForPath(`L${cursorLayer}`);
                    if (!s) return null;
                    return (
                      <rect
                        x={s.x0 - 1.5}
                        y={bands.runBar.y0 - 2.5}
                        width={Math.max(3, s.x1 - s.x0 + 3)}
                        height={bands.runBar.y1 - bands.runBar.y0 + 5}
                        rx={2}
                        fill="none"
                        stroke="var(--color-text)"
                        strokeWidth={1.25}
                        strokeDasharray="3 2"
                        pointerEvents="none"
                        data-anatomy-cursor={cursorLayer}
                      />
                    );
                  })()}
              </svg>
            )}

            {/* HTML tooltip — absolute z-20, flipped/clamped inside the pane */}
            {hoverInfo &&
              (() => {
                const flipX = hoverInfo.x > W * 0.6;
                const flipY = hoverInfo.y > H * 0.65;
                const d = deltaOf(hoverInfo.m);
                const m = hoverInfo.m;
                return (
                  <div
                    className="pointer-events-none absolute z-20 max-w-80 rounded-md border border-border bg-surface-alt px-2 py-1 font-mono text-[11px] text-text shadow-lg"
                    style={{
                      left: hoverInfo.x + (flipX ? -12 : 12),
                      top: hoverInfo.y + (flipY ? -10 : 10),
                      transform: `${flipX ? "translateX(-100%)" : ""} ${
                        flipY ? "translateY(-100%)" : ""
                      }`,
                    }}
                  >
                    <div className="flex items-center gap-1.5 text-text-muted">
                      <span
                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: carrierColor(m.carrier) }}
                      />
                      <span className="truncate">
                        {m.method || m.kind}
                        {m.metric_name ? ` · ${m.metric_name}` : ""}
                      </span>
                    </div>
                    <div className="tabular-nums">
                      value {fmtNum(m.value)} · null {fmtNum(m.null_control)} · Δ{" "}
                      {fmtNum(d)}
                    </div>
                    <div className="text-text-faint">
                      {locusLabel(m)}
                      {m.mode ? ` · ${m.mode}` : ""}
                      {m.carrier ? ` · ${m.carrier}` : ""}
                    </div>
                  </div>
                );
              })()}
          </div>
        </>
      )}
    </div>
  );
}
