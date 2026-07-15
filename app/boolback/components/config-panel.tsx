"use client";

// app/boolback/components/config-panel.tsx — the SINGLE right-docked control
// surface, shared across all center views. Two modes:
//
//   run inspector — when a run is open (detailOpen && a run resolves from the
//     selection): renders <RunInspector> with a back affordance.
//   config        — otherwise: the active view's controls. Content depends on
//     configViewOf(centerView):
//       table     → filter-only parameter rows + Columns + Sort keys + search;
//       plot /    → the PLOT-STYLE row (size/opacity + band/ghosts/trend) above
//       groupplot   the LAYERS STRIP (per-layer glyph/swatch/rename/count/reset/
//                   duplicate/remove + the active layer's 3-channel style editor
//                   color/shape/dash), then the gated "Color by metric" gradient
//                   (single layer only), the parameter chips editing the ACTIVE
//                   layer, the unified FUNCTION section (arity + fn_hex + engaged
//                   complexity with a bin-into-layers control), outcome metric
//                   rows, and constants. On the groupplot tab a "Facet by" select
//                   + panel-size slider are added;
//       anatomy   → a tiny note (anatomy owns its own controls).
//
// A layer is ONE trace. Multiple traces are minted as multiple LAYERS by the
// GENERATORS (lib/generators.expandLayers / binLayers), wired to the expand
// affordance on every categorical parameter row and the bin control on every
// engaged complexity metric; both commit through store.replaceLayers. Facet
// edits on a plot layer run through lib/select.repairPins (the cascade), so a
// narrowing edit re-pins other now-stale pins and announces the moves. Every
// count / warning the panel shows comes from lib/split-dims.resolveSeries (the
// same pure resolver the plot renders from), never a parallel computation.

import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Bundle, RangeFilter, FilterState, FacetKey, RunRow,
  PlotConfig, MetricSchemaEntry, PlotLayer, LayerStyle,
} from "../lib/types";
import { EMPTY_FILTER, DEFAULT_LAYER_STYLE } from "../lib/types";
import { useBoolbackStore, configViewOf, type ViewKey } from "../state/store";
import type { CenterView } from "./table-pane";
import type { ViewKind } from "../lib/spec";
import { configToSpec, specToConfig, serializeSpec, parseSpec } from "../lib/spec";
import {
  PARAMETERS, summarizeParameters, tierSections, conditionedCounts, orderValues,
  TIER_LABEL,
  type ParameterDef, type ParamValues,
} from "../lib/parameters";
import { resolveSeries, averagedParams, type SeriesResolution } from "../lib/split-dims";
import { CATEGORY_PALETTE, DASH_PATTERNS, SHAPE_COUNT } from "../lib/styling";
import { shapeNode } from "./glyph";
import {
  applyFilters, histogramBins, metricRange, dominantFilters, repairPins,
  FACET_LABELS, type MetricIndex,
} from "../lib/select";
import { expandLayers, binLayers, type GeneratorTargets } from "../lib/generators";
import { resolveById } from "../lib/columns";
import {
  indexMetricSchema, groupedMetricOptions, metricLabel, formatValue,
  Y_GROUP_ORDER, type MetricPickerGroup,
} from "../lib/metrics";
import { RunInspector, resolveRun } from "./run-inspector";
import { ColumnGroupMenu } from "./column-group-menu";
import { copyText, downloadBlob, svgToPngBlob } from "../lib/export";
import { useResizable } from "../lib/use-resizable";
import type { PlotExportHandle } from "./plot-panel";
import { hydratePresetSpec, suggestPresetName, PRESET_SCHEMA_VERSION } from "../lib/presets";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const MIN_W = 320;
const MAX_W = 900;
const MAX_VALUES = 16;
const HIST_BINS = 24;

/** Shared empty selection — a stable reference so an unfiltered chip's
 *  `selected` prop keeps identity across renders (React.memo skip). */
const NO_VALUES: readonly string[] = [];
/** Shared empty conditioned-count map (stable fallback ref, same reason). */
const EMPTY_COUNTS: ReadonlyMap<string, number> = new Map();

/** Keys pulled OUT of the tier sections and rendered in the FUNCTION section:
 *  arity (the complexity sweep axis) and the function identity (fn_hex). */
const FUNCTION_SECTION_KEYS = new Set(["arity", "function"]);

/** Map the center view to the spec ViewKind it copies/pastes as (anatomy → null). */
function specKindOf(view: CenterView): ViewKind | null {
  if (view === "table") return "table";
  if (view === "plot") return "plot";
  if (view === "groupplot") return "groupplot";
  return null;
}

// ===========================================================================
// dock shell — two modes, resizable
// ===========================================================================

export function ConfigPanel({
  bundle, dir, chartRef,
}: {
  bundle: Bundle;
  /** The artifact-tree dir the page views ("artifacts" unless ?dir= overrides). */
  dir: string;
  /** The mounted plot's export surface (for the header's PNG export). */
  chartRef: React.MutableRefObject<PlotExportHandle | null>;
}) {
  const detailOpen = useBoolbackStore((s) => s.detailOpen);
  const selectedDir = useBoolbackStore((s) => s.selectedDir);
  const detailWidth = useBoolbackStore((s) => s.detailWidth);
  const setDetailOpen = useBoolbackStore((s) => s.setDetailOpen);
  const setDetailWidth = useBoolbackStore((s) => s.setDetailWidth);
  const centerView = useBoolbackStore((s) => s.centerView);

  const index = useMemo<MetricIndex>(
    () => indexMetricSchema(bundle.metric_schema),
    [bundle.metric_schema],
  );

  const { size, handleProps } = useResizable({
    size: detailWidth,
    min: MIN_W,
    max: MAX_W,
    edge: "left",
    onCommit: (w) => setDetailWidth(Math.round(w)),
  });

  const run = detailOpen ? resolveRun(bundle, selectedDir) : null;

  return (
    <div
      className="relative flex h-full shrink-0 border-l border-border bg-surface/85 backdrop-blur-md"
      style={{ width: size }}
    >
      <span
        {...handleProps}
        className="absolute left-0 top-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-accent/40"
        style={{ ...handleProps.style, touchAction: "none" }}
      />
      {run ? (
        <RunInspector run={run} bundle={bundle} index={index} dir={dir} onBack={() => setDetailOpen(false)} />
      ) : (
        <ConfigMode bundle={bundle} index={index} chartRef={chartRef} centerView={centerView} />
      )}
    </div>
  );
}

// ===========================================================================
// config mode
// ===========================================================================

function ConfigMode({
  bundle, index, chartRef, centerView,
}: {
  bundle: Bundle;
  index: MetricIndex;
  chartRef: React.MutableRefObject<PlotExportHandle | null>;
  centerView: CenterView;
}) {
  const vk = configViewOf(centerView);

  if (vk === null) {
    return (
      <div className="flex h-full w-full flex-col min-h-0">
        <PanelHeader vk={null} centerView={centerView} chartRef={chartRef} />
        <p className="px-3 py-3 font-mono text-xs text-text-faint">
          Anatomy has its own controls.
        </p>
      </div>
    );
  }

  return <ViewConfig vk={vk} centerView={centerView} bundle={bundle} index={index} chartRef={chartRef} />;
}

function ViewConfig({
  vk, centerView, bundle, index, chartRef,
}: {
  vk: ViewKey;
  centerView: CenterView;
  bundle: Bundle;
  index: MetricIndex;
  chartRef: React.MutableRefObject<PlotExportHandle | null>;
}) {
  const table = useBoolbackStore((s) => s.table);
  const plot = useBoolbackStore((s) => s.plot);
  const groupPlot = useBoolbackStore((s) => s.groupPlot);

  const setPlotStore = useBoolbackStore((s) => s.setPlot);
  const setGroupPlot = useBoolbackStore((s) => s.setGroupPlot);
  const patchLayer = useBoolbackStore((s) => s.patchLayer);
  const addLayer = useBoolbackStore((s) => s.addLayer);
  const duplicateLayer = useBoolbackStore((s) => s.duplicateLayer);
  const removeLayer = useBoolbackStore((s) => s.removeLayer);
  const storeSetFacet = useBoolbackStore((s) => s.setFacet);
  const storeAddRange = useBoolbackStore((s) => s.addRange);
  const storeRemoveRange = useBoolbackStore((s) => s.removeRange);
  const storeUpdateRange = useBoolbackStore((s) => s.updateRange);

  const isPlotLike = vk === "plot";
  const isGroupPlot = centerView === "groupplot";
  const plotConfig = isPlotLike ? plot : null;

  /** Whole-config patch for the shared plot config. Wrapped in a transition so
   *  the click/toggle repaints immediately and the expensive downstream render
   *  (resolveSeries + plot) is non-blocking (INP). */
  const setPlot = (patch: Partial<PlotConfig>) => {
    startTransition(() => setPlotStore(patch));
  };

  /** The dominant-cell default filters (Feature 1) — seeds a newly-added layer
   *  and a per-layer reset. Memoized: only the row set changes it. */
  const dominant = useMemo(() => dominantFilters(bundle.rows), [bundle.rows]);

  // ---- ACTIVE layer (UI-local; the parameter rows edit ITS filters) ----------
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const activeLayer: PlotLayer | null = plotConfig
    ? plotConfig.layers.find((l) => l.id === activeLayerId) ?? plotConfig.layers[0]
    : null;
  /** The layerId the filter mutators target (null on the table view). */
  const sid = activeLayer?.id ?? null;
  /** The FilterState the panel edits + histograms derive from. */
  const activeFilters: FilterState =
    vk === "table" ? table.filters : activeLayer?.filters ?? EMPTY_FILTER;

  // ---- cascade note (transient "X, Y followed Z" after a repairPins move) -----
  const [cascadeNote, setCascadeNote] = useState<string | null>(null);
  const cascadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashCascade = useCallback((editedKey: FacetKey, repaired: FacetKey[]) => {
    const moved = repaired.map((k) => FACET_LABELS[k] ?? k).join(", ");
    setCascadeNote(`${moved} followed ${FACET_LABELS[editedKey] ?? editedKey}`);
    if (cascadeTimer.current) clearTimeout(cascadeTimer.current);
    cascadeTimer.current = setTimeout(() => setCascadeNote(null), 3000);
  }, []);
  useEffect(() => () => { if (cascadeTimer.current) clearTimeout(cascadeTimer.current); }, []);

  // ---- parameter model (classified over ALL rows so filters stay reachable) ---
  const summary = useMemo(() => summarizeParameters(bundle.rows), [bundle.rows]);
  const differingByKey = useMemo(() => {
    const m = new Map<string, ParamValues>();
    for (const d of summary.differing) m.set(d.dim.key, d);
    return m;
  }, [summary]);
  /** Differing parameters in PARAMETERS (registry) order. */
  const differingDims = useMemo(
    () => PARAMETERS.filter((p) => differingByKey.has(p.key)),
    [differingByKey],
  );

  // ---- series resolution — the ONE source for counts + warnings ---------------
  // Memoized on the resolver's real inputs (layers/ranges) so a band/colorBy/
  // axis toggle doesn't re-run it (INP).
  const rsLayers = plotConfig?.layers;
  const rsRanges = plotConfig?.ranges;
  const resolution: SeriesResolution | null = useMemo(
    () =>
      rsLayers && rsRanges
        ? resolveSeries({ rows: bundle.rows, layers: rsLayers, ranges: rsRanges, applyTo: applyFilters })
        : null,
    [bundle.rows, rsLayers, rsRanges],
  );
  /** Matched-run count per layer id (one series per layer). */
  const countsByLayer = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of resolution?.series ?? []) m.set(s.layerId, s.rows.length);
    return m;
  }, [resolution]);

  /** Labels of the parameters the plot's layers pool over — the "averaged" note. */
  const averagedLabels = useMemo(
    () => (resolution ? averagedParams(resolution, PARAMETERS).map((d) => d.label) : []),
    [resolution],
  );

  // Rows matching the ACTIVE layer (or the table filters) drive the continuous
  // editors' histograms.
  const filtered = useMemo(() => applyFilters(bundle.rows, activeFilters), [bundle.rows, activeFilters]);

  // ---- conditioned value counts (faceted-search counting) ---------------------
  // Per parameter: drop ITS facet, apply the active layer's other facets + its
  // own ranges + the plot-level ranges. Kept referentially stable via a
  // signature cache so an unchanged chip skips re-render (React.memo).
  const condCacheRef = useRef(new Map<string, { sig: string; counts: Map<string, number> }>());
  const conditionedByKey = useMemo(() => {
    const extra = rsRanges ?? [];
    const cache = condCacheRef.current;
    const m = new Map<string, Map<string, number>>();
    for (const dim of differingDims) {
      const facets = { ...(activeFilters.facets ?? {}) };
      if (dim.facetKey) delete facets[dim.facetKey];
      const sig = JSON.stringify({ f: facets, r: activeFilters.ranges ?? [], e: extra });
      const prev = cache.get(dim.key);
      if (prev && prev.sig === sig) { m.set(dim.key, prev.counts); continue; }
      const counts = conditionedCounts(bundle.rows, dim, activeFilters, extra);
      cache.set(dim.key, { sig, counts });
      m.set(dim.key, counts);
    }
    return m;
  }, [differingDims, bundle.rows, activeFilters, rsRanges]);

  // ---- facet slot (group plot) -------------------------------------------------
  const facetOptions = useMemo(
    () => [
      { value: "layer", label: "layer (one panel per layer)" },
      ...summary.differing.map((d) => ({ value: d.dim.key, label: d.dim.label })),
    ],
    [summary],
  );

  // ---- facet editing + cascade (plot view repairs stale pins; table doesn't) --
  const applyFacetValues = useCallback((fk: FacetKey, nextValues: string[]) => {
    startTransition(() => {
      const st = useBoolbackStore.getState();
      const base = vk === "table"
        ? st.table.filters
        : st.plot.layers.find((l) => l.id === sid)?.filters ?? EMPTY_FILTER;
      const next: FilterState = { facets: { ...base.facets, [fk]: nextValues }, ranges: base.ranges };
      if (vk === "plot") {
        const res = repairPins(bundle.rows, next, fk);
        st.patchViewFilters(vk, sid, res.filters);
        if (res.repaired.length) flashCascade(fk, res.repaired);
      } else {
        st.patchViewFilters(vk, sid, next);
      }
    });
  }, [vk, sid, bundle.rows, flashCascade]);

  const applyFacetToggle = useCallback((fk: FacetKey, value: string) => {
    const st = useBoolbackStore.getState();
    const base = vk === "table"
      ? st.table.filters
      : st.plot.layers.find((l) => l.id === sid)?.filters ?? EMPTY_FILTER;
    const cur = base.facets[fk] ?? [];
    applyFacetValues(fk, cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value]);
  }, [vk, sid, applyFacetValues]);

  // ---- generators (expand a categorical dim / bin a metric into layers) -------
  // Both read the LIVE layers at call time, commit through replaceLayers, and
  // make the first newly-minted child the active layer.
  const commitGenerated = (next: PlotLayer[], prevIds: Set<string>) => {
    useBoolbackStore.getState().replaceLayers(next);
    const child = next.find((l) => !prevIds.has(l.id));
    if (child) setActiveLayerId(child.id);
  };
  const runExpand = useCallback((dim: ParameterDef, targets: GeneratorTargets) => {
    startTransition(() => {
      const layers = useBoolbackStore.getState().plot.layers;
      const activeId = sid ?? layers[0]?.id ?? "";
      const next = expandLayers({ rows: bundle.rows, layers, targets, activeId, dim, applyTo: applyFilters });
      commitGenerated(next, new Set(layers.map((l) => l.id)));
    });
  }, [sid, bundle.rows]);
  const runBin = useCallback((metric: string, n: number, mode: "quantile" | "width", targets: GeneratorTargets) => {
    startTransition(() => {
      const layers = useBoolbackStore.getState().plot.layers;
      const activeId = sid ?? layers[0]?.id ?? "";
      const next = binLayers({ rows: bundle.rows, layers, targets, activeId, metric, n, mode, index, applyTo: applyFilters });
      commitGenerated(next, new Set(layers.map((l) => l.id)));
    });
  }, [sid, bundle.rows, index]);

  // Per-parameter handler bundles, memoized so an untouched chip keeps stable
  // callback identity (React.memo skip).
  const rowHandlers = useMemo(() => {
    const m = new Map<string, {
      onToggleValue: (v: string) => void;
      onClear: () => void;
      onIsolate: (v: string) => void;
      onExclude: (v: string, all: string[]) => void;
      onExpand?: (targets: GeneratorTargets) => void;
    }>();
    for (const dim of differingDims) {
      const fk = dim.facetKey;
      m.set(dim.key, {
        onToggleValue: (v) => { if (fk) applyFacetToggle(fk, v); },
        // Clearing (widening) can't stale another pin — skip the cascade.
        onClear: () => { if (fk) startTransition(() => storeSetFacet(vk, sid, fk, [])); },
        onIsolate: (v) => { if (fk) applyFacetValues(fk, [v]); },
        onExclude: (v, all) => { if (fk) applyFacetValues(fk, all.filter((x) => x !== v)); },
        onExpand: fk && isPlotLike ? (targets) => runExpand(dim, targets) : undefined,
      });
    }
    return m;
  }, [differingDims, vk, sid, isPlotLike, storeSetFacet, applyFacetValues, applyFacetToggle, runExpand]);

  // ---- continuous treatment (filter / color) for OUTCOME metrics --------------
  const rangeFor = (m: string): RangeFilter | undefined => activeFilters.ranges.find((r) => r.metric === m);
  const contTreatmentOf = (m: string): "filter" | "color" | null => {
    if (plotConfig?.colorBy === m) return "color";
    if (rangeFor(m)) return "filter";
    return null;
  };
  const setContTreatment = (m: string, t: "filter" | "color" | null) => {
    startTransition(() => {
      if (rangeFor(m)) storeRemoveRange(vk, sid, m);
      if (plotConfig?.colorBy === m) setPlotStore({ colorBy: null });
      if (t === "filter") {
        const { min, max } = metricRange(bundle.rows, m, index);
        storeAddRange(vk, sid, { metric: m, min, max });
      } else if (t === "color" && plotConfig) {
        setPlotStore({ colorBy: m });
      }
    });
  };

  // ---- complexity filter mutators (function section; active layer) ------------
  const addComplexityFilter = (metric: string) => startTransition(() => {
    const { min, max } = metricRange(bundle.rows, metric, index);
    storeAddRange(vk, sid, { metric, min, max });
  });
  const removeComplexityFilter = (metric: string) => startTransition(() => storeRemoveRange(vk, sid, metric));
  const updateActiveRange = (metric: string, patch: Partial<RangeFilter>) =>
    startTransition(() => storeUpdateRange(vk, sid, metric, patch));

  // ---- render helpers ---------------------------------------------------------
  const selectionOf = (dim: ParameterDef): readonly string[] =>
    dim.facetKey ? (activeFilters.facets[dim.facetKey] ?? NO_VALUES) : NO_VALUES;

  /** One parameter editor row (or a nested child): the judge special case
   *  collapses to a read-only "follows target" line when it conditions to a
   *  single distinct value and carries no explicit selection. */
  const renderParamRow = (dim: ParameterDef) => {
    const conditioned = conditionedByKey.get(dim.key) ?? EMPTY_COUNTS;
    const selected = selectionOf(dim);
    if (dim.key === "judge" && selected.length === 0) {
      const present = [...conditioned.entries()].filter(([, c]) => c > 0);
      if (present.length === 1) {
        return (
          <div
            key={dim.key}
            className="mb-1.5 flex items-center gap-1 rounded-md border border-border/50 p-1"
            title="the judge is determined by the target behavior in this view"
          >
            <span className="shrink-0 text-text/90">{dim.label}</span>
            <span className="min-w-0 flex-1 truncate text-right text-text-faint">
              follows target → {present[0][0]}
            </span>
          </div>
        );
      }
    }
    const h = rowHandlers.get(dim.key)!;
    return (
      <CategoricalRow
        key={dim.key}
        dim={dim}
        pv={differingByKey.get(dim.key)!}
        conditioned={conditioned}
        facet={isGroupPlot && groupPlot.facet === dim.key}
        selected={selected}
        onToggleValue={h.onToggleValue}
        onClear={h.onClear}
        onIsolate={h.onIsolate}
        onExclude={h.onExclude}
        onExpand={h.onExpand}
      />
    );
  };

  // Chip sections (Setting → Sweep): arity + fn_hex are pulled into the FUNCTION
  // section, so they leave the tier sections here.
  const chipDims = differingDims.filter((d) => !FUNCTION_SECTION_KEYS.has(d.key));
  const chipSections = tierSections(chipDims);
  const arityDim = differingByKey.has("arity") ? differingByKey.get("arity")!.dim : null;
  const functionDim = differingByKey.has("function") ? differingByKey.get("function")!.dim : null;

  const complexity = useMemo(
    () => bundle.metric_schema.filter((e) => e.group === "FUNCTION" && !(e.min === null && e.max === null)),
    [bundle.metric_schema],
  );
  const outcomeGroups = useMemo(() => {
    const { groups } = groupedMetricOptions(bundle.metric_schema, Y_GROUP_ORDER);
    return groups.filter(([g]) => g !== "FUNCTION") as Array<[MetricPickerGroup, MetricSchemaEntry[]]>;
  }, [bundle.metric_schema]);

  return (
    <div className="flex h-full w-full flex-col min-h-0">
      <PanelHeader vk={vk} centerView={centerView} chartRef={chartRef} />

      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 text-xs text-text-muted">
        {vk === "table" && <TableExtras bundle={bundle} index={index} />}

        {/* PLOT-STYLE row — the plot-level channels (size/opacity + band/ghosts/
            trend), parallel to a layer entry but labeled "plot". */}
        {isPlotLike && plotConfig && (
          <PlotStyleRow config={plotConfig} onChange={setPlot} />
        )}

        {/* LAYERS strip — the MERGED LEGEND + editor: one entry per layer (glyph
            / swatch / name / matched-run count / reset / duplicate / remove),
            the active layer's 3-channel style editor, and the resolution notes
            (averaged / overlap / judge) + the transient cascade note. */}
        {isPlotLike && plotConfig && resolution && (
          <LayersStrip
            layers={plotConfig.layers}
            activeId={activeLayer?.id ?? null}
            counts={countsByLayer}
            resolution={resolution}
            averaged={averagedLabels}
            cascadeNote={cascadeNote}
            onSelect={(id) => startTransition(() => setActiveLayerId(id))}
            onRename={(id, name) => startTransition(() => patchLayer(id, { name }))}
            onRecolor={(id, color) => startTransition(() => patchLayer(id, { color }))}
            onStyle={(id, style) => startTransition(() => patchLayer(id, { style }))}
            // Per-layer reset: filters back to the DOMINANT CELL (the same seed a
            // fresh layer gets) + style back to the neutral defaults.
            onReset={(id) => startTransition(() => patchLayer(id, {
              filters: {
                facets: Object.fromEntries(
                  Object.entries(dominant.facets).map(([k, v]) => [k, [...(v ?? [])]]),
                ) as FilterState["facets"],
                ranges: dominant.ranges.map((r) => ({ ...r })),
              },
              style: { ...DEFAULT_LAYER_STYLE },
            }))}
            onDuplicate={(id) => startTransition(() => {
              const nid = duplicateLayer(id);
              if (nid) setActiveLayerId(nid);
            })}
            onRemove={(id) => startTransition(() => removeLayer(id))}
            // A new layer defaults to the DOMINANT CELL (Feature 1), not empty.
            onAdd={() => startTransition(() => setActiveLayerId(addLayer(dominant)))}
          />
        )}

        {/* group plot: facet + panel size (centerView === "groupplot") */}
        {isGroupPlot && (
          <div className="mb-2">
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
              <ParamSelect
                label="Facet by"
                value={groupPlot.facet}
                options={facetOptions}
                onChange={(v) => startTransition(() => setGroupPlot({ facet: v }))}
              />
            </div>
            <label className="mt-1 flex items-center gap-2 text-[11px] text-text-muted">
              panel size
              <input
                type="range" min={160} max={480} step={20} value={groupPlot.panelMin}
                onChange={(e) => startTransition(() => setGroupPlot({ panelMin: Number(e.target.value) }))}
                className="accent-accent" aria-label="panel size"
              />
            </label>
          </div>
        )}

        {/* COLOR BY METRIC — the continuous gradient, honored only on a single layer */}
        {isPlotLike && plotConfig && (
          <ColorByRow
            eligible={plotConfig.layers.length === 1}
            colorBy={plotConfig.colorBy}
            schema={bundle.metric_schema}
            onChange={(m) => setPlot({ colorBy: m })}
          />
        )}

        {/* which layer the chips edit */}
        {isPlotLike && activeLayer && (
          <div className="mb-1 border-t border-border/50 pt-1.5 text-[11px] text-text-faint">
            editing: <span className="text-text/90">{activeLayer.name}</span>
          </div>
        )}

        {chipSections.map(({ tier, entries }) => (
          <CollapsibleSection key={tier} title={TIER_LABEL[tier]} defaultOpen>
            {entries.map(({ dim, children }) => (
              <div key={dim.key}>
                {renderParamRow(dim)}
                {children.length > 0 && (
                  <div className="mb-1 ml-2 border-l border-border/60 pl-1.5">
                    {children.map((c) => renderParamRow(c))}
                  </div>
                )}
              </div>
            ))}
          </CollapsibleSection>
        ))}

        {/* FUNCTION section — arity + fn_hex + engaged complexity (with binning) */}
        {(arityDim || functionDim || complexity.length > 0) && (
          <CollapsibleSection title="function" defaultOpen>
            {arityDim && renderParamRow(arityDim)}
            {functionDim && renderParamRow(functionDim)}
            {complexity.length > 0 && (
              <ComplexityBlock
                complexity={complexity}
                index={index}
                filtered={filtered}
                activeRanges={activeFilters.ranges}
                canBin={isPlotLike}
                onAddFilter={addComplexityFilter}
                onRemoveFilter={removeComplexityFilter}
                updateRange={updateActiveRange}
                onBin={runBin}
              />
            )}
          </CollapsibleSection>
        )}

        {/* outcome metric rows (plot-like views wire color; table filter-only) */}
        {outcomeGroups.length > 0 && (
          <CollapsibleSection title="outcomes">
            {outcomeGroups.map(([g, entries]) => (
              <div key={g} className="mb-1">
                <div className="px-0.5 pb-0.5 text-[10px] uppercase tracking-wide text-text-faint">{g}</div>
                <MetricList
                  entries={entries}
                  isPlotLike={isPlotLike}
                  index={index}
                  filtered={filtered}
                  rangeFor={rangeFor}
                  treatmentOf={contTreatmentOf}
                  onSetTreatment={setContTreatment}
                  updateRange={updateActiveRange}
                />
              </div>
            ))}
          </CollapsibleSection>
        )}

        {/* constants */}
        {summary.shared.length > 0 && (
          <CollapsibleSection title={`constant ×${summary.shared.length}`}>
            <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
              {summary.shared.map((s) => {
                const disp = s.dim.display ? s.dim.display(s.value) : s.value;
                return (
                  <div key={s.dim.key} className="contents">
                    <span className="text-text-faint">{s.dim.label}</span>
                    <span className="truncate text-text/90" title={disp}>{disp}</span>
                  </div>
                );
              })}
            </div>
          </CollapsibleSection>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// header — Views · Copy · Paste · Export · Reset
// ===========================================================================

function PanelHeader({
  vk, centerView, chartRef,
}: {
  vk: ViewKey | null;
  centerView: CenterView;
  chartRef: React.MutableRefObject<PlotExportHandle | null>;
}) {
  const resetView = useBoolbackStore((s) => s.resetView);
  // The global Reset only serves the table (and anatomy) — plot-like views reset
  // PER LAYER instead (the ⟲ on each layers-strip entry).
  const onReset = () => resetView(centerView);
  const [note, setNote] = useState<string | null>(null);
  const flash = (m: string) => { setNote(m); setTimeout(() => setNote(null), 1400); };

  const kind = specKindOf(centerView);

  const copySpec = async () => {
    if (!kind) return;
    const s = useBoolbackStore.getState();
    const spec = kind === "table"
      ? configToSpec("table", s.table)
      : kind === "plot"
        ? configToSpec("plot", s.plot)
        : configToSpec("groupplot", s.plot, s.groupPlot.facet);
    await copyText(serializeSpec(spec));
    flash("copied ✓");
  };

  const exportPng = async () => {
    const svg = chartRef.current?.getSvg();
    if (!svg) return;
    const blob = await svgToPngBlob(svg, 2);
    downloadBlob(blob, "boolback-plot.png");
  };

  const isPlotLike = kind === "plot" || kind === "groupplot";

  return (
    <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-xs">
      {vk && <ViewsMenu centerView={centerView} />}
      {vk && (
        <button type="button" onClick={copySpec} title="Copy this view's spec to the clipboard"
          className="rounded border border-border px-1.5 py-0.5 text-text-muted hover:border-accent/40 hover:text-accent">
          {note ?? "Copy"}
        </button>
      )}
      {vk && <PasteSpec />}
      {isPlotLike && (
        <button type="button" onClick={exportPng} title="Download the plot as PNG"
          disabled={!chartRef.current}
          className="rounded border border-border px-1.5 py-0.5 text-text-muted hover:border-accent/40 hover:text-accent disabled:opacity-40">
          PNG
        </button>
      )}
      {!isPlotLike && (
        <button type="button" onClick={onReset} title="Reset this view"
          className="ml-auto rounded border border-border px-1.5 py-0.5 text-text-muted hover:border-accent/40 hover:text-accent">
          Reset
        </button>
      )}
    </header>
  );
}

function PasteSpec() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState(false);
  const setCenterView = useBoolbackStore((s) => s.setCenterView);
  const setTableConfig = useBoolbackStore((s) => s.setTableConfig);
  const setPlot = useBoolbackStore((s) => s.setPlot);
  const setGroupPlot = useBoolbackStore((s) => s.setGroupPlot);

  const openBox = async () => {
    setOpen(true);
    setErr(false);
    try {
      const t = await navigator.clipboard.readText();
      if (t) setText(t);
    } catch { /* clipboard blocked — user pastes manually */ }
  };

  const apply = () => {
    const spec = parseSpec(text);
    if (!spec) { setErr(true); return; }
    const { view, plot, table, facet } = specToConfig(spec);
    if (view === "table") { if (table) setTableConfig(table); setCenterView("table"); }
    else if (view === "plot") { if (plot) setPlot(plot); setCenterView("plot"); }
    else { if (plot) setPlot(plot); setGroupPlot({ facet: facet ?? null }); setCenterView("groupplot"); }
    setOpen(false);
    setText("");
  };

  return (
    <div className="relative">
      <button type="button" onClick={() => (open ? setOpen(false) : void openBox())} title="Paste a view spec"
        className="rounded border border-border px-1.5 py-0.5 text-text-muted hover:border-accent/40 hover:text-accent">
        Paste
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-lg border border-border bg-surface/95 p-2 shadow-lg backdrop-blur-md">
            <textarea
              autoFocus
              value={text}
              onChange={(e) => { setText(e.target.value); setErr(false); }}
              placeholder="paste a view spec (JSON)…"
              rows={6}
              className={`w-full resize-none rounded border bg-surface px-1.5 py-1 font-mono text-[11px] text-text focus:outline-none ${err ? "border-error" : "border-border focus:border-accent/60"}`}
            />
            {err && <div className="mt-1 text-[11px] text-error">Not a valid view spec.</div>}
            <div className="mt-1 flex justify-end">
              <button type="button" onClick={apply} className="rounded border border-accent/50 px-2 py-0.5 text-accent hover:bg-accent/10">apply</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ===========================================================================
// Views menu — spec-based presets (Convex, one kind)
// ===========================================================================

type PresetRow = { _id: Id<"boolbackPresets">; name: string; state: unknown };

function ViewsMenu({ centerView }: { centerView: CenterView }) {
  const presets = (useQuery(api.boolbackPresets.list) ?? []) as PresetRow[];
  const savePreset = useMutation(api.boolbackPresets.save);
  const removePreset = useMutation(api.boolbackPresets.remove);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const setCenterView = useBoolbackStore((s) => s.setCenterView);
  const setTableConfig = useBoolbackStore((s) => s.setTableConfig);
  const setPlot = useBoolbackStore((s) => s.setPlot);
  const setGroupPlot = useBoolbackStore((s) => s.setGroupPlot);

  const kind = specKindOf(centerView);

  const specOfActive = () => {
    const s = useBoolbackStore.getState();
    return kind === "table"
      ? configToSpec("table", s.table)
      : kind === "groupplot"
        ? configToSpec("groupplot", s.plot, s.groupPlot.facet)
        : configToSpec("plot", s.plot);
  };

  const apply = (p: PresetRow) => {
    const spec = hydratePresetSpec(p.state);
    if (!spec) { setOpen(false); return; }
    const { view, plot, table, facet } = specToConfig(spec);
    if (view === "table") { if (table) setTableConfig(table); setCenterView("table"); }
    else if (view === "plot") { if (plot) setPlot(plot); setCenterView("plot"); }
    else { if (plot) setPlot(plot); setGroupPlot({ facet: facet ?? null }); setCenterView("groupplot"); }
    setOpen(false);
  };

  const beginSave = () => {
    const s = useBoolbackStore.getState();
    // Suggest from the table's filters, or the first layer's on a plot view.
    const filters = kind === "table" ? s.table.filters : s.plot.layers[0]?.filters ?? EMPTY_FILTER;
    setName(suggestPresetName(filters));
    setSaving(true);
  };
  const commitSave = () => {
    const n = name.trim();
    if (n) void savePreset({ name: n, kind: "view", schemaVersion: PRESET_SCHEMA_VERSION, state: specOfActive() });
    setSaving(false);
    setName("");
  };
  const overwrite = (p: PresetRow) =>
    void savePreset({ name: p.name, kind: "view", schemaVersion: PRESET_SCHEMA_VERSION, state: specOfActive() });

  const close = () => { setOpen(false); setSaving(false); setName(""); };

  return (
    <div className="relative">
      <button type="button" onClick={() => (open ? close() : setOpen(true))}
        className="rounded border border-border px-1.5 py-0.5 text-text-muted hover:border-accent/40 hover:text-accent">
        Views <span className="text-text-faint">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={close} />
          <div className="absolute left-0 top-full z-30 mt-1 w-60 rounded-lg border border-border bg-surface/95 p-2 shadow-lg backdrop-blur-md">
            {presets.length === 0 && <div className="px-1 py-0.5 text-text-faint">none saved</div>}
            {presets.map((p) => (
              <div key={p._id} className="group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-surface-alt">
                <button type="button" onClick={() => apply(p)} title={`apply ${p.name}`}
                  className="min-w-0 flex-1 truncate text-left text-text/90 hover:text-accent">{p.name}</button>
                <span className="hidden shrink-0 items-center gap-1.5 group-hover:flex">
                  <button type="button" onClick={() => overwrite(p)} title="overwrite with the current view" className="text-text-faint hover:text-accent">⤓</button>
                  <button type="button" onClick={() => void removePreset({ id: p._id })} title="delete" className="text-text-faint hover:text-error">×</button>
                </span>
              </div>
            ))}
            <div className="mt-1 border-t border-border/60 pt-1.5">
              {saving ? (
                <div className="flex items-center gap-1">
                  <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") commitSave(); else if (e.key === "Escape") { setSaving(false); setName(""); } }}
                    placeholder="name this view…"
                    className="w-full rounded border border-border bg-surface px-1.5 py-0.5 text-text placeholder:text-text-faint focus:border-accent/60 focus:outline-none" />
                  <button type="button" onClick={commitSave} className="shrink-0 rounded border border-accent/50 px-1.5 py-0.5 text-accent hover:bg-accent/10">save</button>
                </div>
              ) : (
                <button type="button" onClick={beginSave} className="w-full rounded px-1 py-0.5 text-left text-text-muted hover:bg-surface-alt hover:text-accent">Save current view…</button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ===========================================================================
// collapsible section
// ===========================================================================

function CollapsibleSection({
  title, children, defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mb-2">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="mb-1 flex w-full items-center gap-1 text-[10px] uppercase tracking-wide text-text-faint hover:text-text">
        <span aria-hidden>{open ? "▾" : "▸"}</span> {title}
      </button>
      {open && children}
    </section>
  );
}

// ===========================================================================
// style-slot select (Facet by)
// ===========================================================================

function ParamSelect({
  label, value, options, onChange,
}: {
  label: string;
  value: string | null;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string | null) => void;
}) {
  return (
    <>
      <span className="text-text-faint">{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label={label}
        className="w-full rounded border border-border bg-surface px-1 py-0.5 text-[11px] text-text focus:border-accent/60 focus:outline-none"
      >
        <option value="">(none)</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </>
  );
}

// ===========================================================================
// PLOT-STYLE row — the plot-level channels (size / opacity + band/ghosts/trend)
// ===========================================================================

function PlotStyleRow({
  config, onChange,
}: {
  config: PlotConfig;
  onChange: (patch: Partial<PlotConfig>) => void;
}) {
  return (
    <div className="mb-2 rounded-md border border-border/60 px-1.5 py-1">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-text/90">plot</span>
        <span className="ml-auto flex items-center gap-3 text-[11px]">
          <Toggle label="band" checked={!!config.band} onChange={(b) => onChange({ band: b })} title="±1 SD spread band / whiskers" />
          <Toggle label="ghosts" checked={!!config.ghosts} onChange={(b) => onChange({ ghosts: b })} title="faint underlying runs" />
          <Toggle label="trend" checked={!!config.trend} onChange={(b) => onChange({ trend: b })} title="OLS fit + r/ρ readout" />
        </span>
      </div>
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1 text-[11px]">
        <span className="text-text-faint">size</span>
        <input
          type="range" min={0.4} max={2.5} step={0.1} value={config.size}
          onChange={(e) => onChange({ size: Number(e.target.value) })}
          aria-label="plot marker size" className="min-w-0 accent-accent"
        />
        <span className="w-8 text-right tabular-nums text-text-faint">{config.size.toFixed(1)}×</span>

        <span className="text-text-faint">opacity</span>
        <input
          type="range" min={0.1} max={1} step={0.05} value={config.opacity}
          onChange={(e) => onChange({ opacity: Number(e.target.value) })}
          aria-label="plot opacity" className="min-w-0 accent-accent"
        />
        <span className="w-8 text-right tabular-nums text-text-faint">{config.opacity.toFixed(2)}</span>
      </div>
    </div>
  );
}

// ===========================================================================
// LAYERS strip — the MERGED LEGEND: one entry per layer + the active layer's
// 3-channel style editor. Everything derives from resolveSeries.
// ===========================================================================

function LayersStrip({
  layers, activeId, counts, resolution, averaged, cascadeNote,
  onSelect, onRename, onRecolor, onStyle, onReset, onDuplicate, onRemove, onAdd,
}: {
  layers: PlotLayer[];
  activeId: string | null;
  /** Matched-run count per layer id (from resolveSeries). */
  counts: Map<string, number>;
  resolution: SeriesResolution;
  /** Labels of parameters pooled inside layers (the "averaged: …" note). */
  averaged: string[];
  /** Transient "X, Y followed Z" cascade note (null when idle). */
  cascadeNote: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onRecolor: (id: string, color: string) => void;
  onStyle: (id: string, style: LayerStyle) => void;
  onReset: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="mb-2">
      {layers.map((l) => {
        const active = l.id === activeId;
        const empty = resolution.emptyLayers.includes(l.name);
        const n = counts.get(l.id) ?? 0;
        const style = l.style ?? DEFAULT_LAYER_STYLE;
        return (
          <div
            key={l.id}
            onClick={() => onSelect(l.id)}
            title={active ? undefined : `edit layer "${l.name}"`}
            className={`group mb-0.5 cursor-pointer rounded-md border px-1.5 py-1 ${
              active ? "border-accent bg-accent/10" : "border-border/60 hover:border-accent/40"
            }`}
          >
            <div className="flex items-center gap-1.5">
              <svg width={12} height={12} viewBox="-6 -6 12 12" className="shrink-0" style={{ color: l.color }} aria-hidden>
                {shapeNode(style.shape, 0, 0, 4, {
                  fill: "currentColor", fillOpacity: 0.7, stroke: "currentColor", strokeOpacity: 1,
                })}
              </svg>
              <SwatchPicker
                ariaLabel={`change color of layer ${l.name}`}
                title={`change the color of "${l.name}"`}
                color={l.color}
                onPick={(c) => onRecolor(l.id, c)}
              />
              <LayerName name={l.name} active={active} onCommit={(name) => onRename(l.id, name)} />
              <span
                className={`ml-auto shrink-0 rounded border px-1 py-px text-[10px] tabular-nums ${
                  empty ? "border-warning/60 text-warning" : "border-border text-text-faint"
                }`}
                title={empty ? "no runs match this layer's filters" : `${n} matched runs`}
              >
                {empty ? "0 runs" : n}
              </span>
              <button type="button" onClick={(e) => { e.stopPropagation(); onReset(l.id); }}
                title={`reset layer "${l.name}" — filters back to the dominant cell, style back to defaults`}
                aria-label={`reset layer ${l.name}`}
                className="shrink-0 text-text-faint hover:text-accent">⟲</button>
              <button type="button" onClick={(e) => { e.stopPropagation(); onDuplicate(l.id); }}
                title={`duplicate layer "${l.name}"`} aria-label={`duplicate layer ${l.name}`}
                className="shrink-0 text-text-faint hover:text-accent">⧉</button>
              <button type="button" onClick={(e) => { e.stopPropagation(); onRemove(l.id); }}
                disabled={layers.length <= 1}
                title={layers.length <= 1 ? "the last layer cannot be removed" : `remove layer "${l.name}"`}
                aria-label={`remove layer ${l.name}`}
                className="shrink-0 text-text-faint hover:text-error disabled:opacity-30">×</button>
            </div>

            {active && (
              <LayerStyleEditor
                name={l.name}
                color={l.color}
                style={style}
                onRecolor={(c) => onRecolor(l.id, c)}
                onStyle={(st) => onStyle(l.id, st)}
              />
            )}
          </div>
        );
      })}
      <button type="button" onClick={onAdd}
        className="w-full rounded-md border border-dashed border-border px-1.5 py-0.5 text-left text-text-faint hover:border-accent/40 hover:text-accent">
        + add layer
      </button>

      {/* resolution notes */}
      {averaged.length > 0 && (
        <div className="mt-1 text-[11px] text-text-faint">
          averaged: {averaged.join(", ")} (mean ± SD)
        </div>
      )}
      {resolution.overlapCount > 0 && (
        <div className="mt-1 text-[11px] text-warning" title="a run matching several layers is drawn once per layer">
          {resolution.overlapCount} run{resolution.overlapCount === 1 ? "" : "s"} match
          {resolution.overlapCount === 1 ? "es" : ""} multiple layers
        </div>
      )}
      {resolution.judgePooled.map((name) => (
        <div key={name} className="mt-0.5 text-[11px] text-warning"
          title="this layer's matched runs span several judges — filter by judge to compare like with like">
          {name}: mixes judges
        </div>
      ))}
      {cascadeNote && (
        <div className="mt-1 text-[11px] text-accent" role="status">
          {cascadeNote}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// LAYER STYLE editor — the three semantic channels a layer owns: color, shape,
// dash. No size/opacity (those are plot-level), no "auto" shape (served splits).
// ===========================================================================

const DASH_LABEL = ["solid", "dashed", "dotted", "dash-dot"];

function LayerStyleEditor({
  name, color, style, onRecolor, onStyle,
}: {
  name: string;
  color: string;
  style: LayerStyle;
  onRecolor: (c: string) => void;
  onStyle: (s: LayerStyle) => void;
}) {
  const patch = (p: Partial<LayerStyle>) => onStyle({ ...style, ...p });
  return (
    <div
      className="mt-1 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 border-t border-border/50 pt-1 text-[11px]"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="text-text-faint">color</span>
      <span className="flex items-center">
        <SwatchPicker
          ariaLabel={`set color for layer ${name}`}
          title={`set the color of "${name}"`}
          color={color}
          onPick={onRecolor}
        />
      </span>

      <span className="text-text-faint">shape</span>
      <span className="flex items-center gap-0.5">
        {Array.from({ length: SHAPE_COUNT }, (_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => patch({ shape: i })}
            title={`marker shape ${i}`}
            aria-label={`set marker shape ${i} for layer ${name}`}
            className={`rounded border p-0.5 ${
              style.shape === i ? "border-accent text-accent" : "border-transparent text-text-muted hover:border-accent/40"
            }`}
          >
            <svg width={12} height={12} viewBox="-6 -6 12 12" className="block">
              {shapeNode(i, 0, 0, 4, {
                fill: "currentColor", fillOpacity: 0.7, stroke: "currentColor", strokeOpacity: 1,
              })}
            </svg>
          </button>
        ))}
      </span>

      <span className="text-text-faint">line</span>
      <span className="flex items-center gap-0.5">
        {DASH_PATTERNS.map((pattern, i) => (
          <button
            key={i}
            type="button"
            onClick={() => patch({ dash: i })}
            title={DASH_LABEL[i] ?? `dash ${i}`}
            aria-label={`set ${DASH_LABEL[i] ?? `dash ${i}`} lines for layer ${name}`}
            className={`rounded border px-0.5 py-1 ${
              style.dash === i ? "border-accent text-accent" : "border-border text-text-muted hover:border-accent/40"
            }`}
          >
            <svg width={26} height={6} viewBox="0 0 26 6" className="block">
              <line x1={1} y1={3} x2={25} y2={3} stroke="currentColor" strokeWidth={1.5}
                strokeDasharray={pattern || undefined} />
            </svg>
          </button>
        ))}
      </span>
    </div>
  );
}

/** Color swatch; click opens a CATEGORY_PALETTE popover, click a swatch assigns. */
function SwatchPicker({
  ariaLabel, title, color, onPick,
}: {
  ariaLabel: string;
  title: string;
  color: string;
  onPick: (c: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={title}
        aria-label={ariaLabel}
        className="block h-3 w-3 rounded-sm border border-border"
        style={{ backgroundColor: color }}
      />
      {open && (
        <>
          <span className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <span className="absolute left-0 top-full z-30 mt-1 block w-32 rounded-lg border border-border bg-surface/95 p-1.5 shadow-lg backdrop-blur-md">
            <span className="grid grid-cols-5 gap-1">
              {CATEGORY_PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => { onPick(c); setOpen(false); }}
                  aria-label={`use color ${c}`}
                  className={`h-4 w-4 rounded-sm border ${
                    c.toLowerCase() === color.toLowerCase() ? "border-text" : "border-transparent hover:border-text-muted"
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </span>
            {/* free choice — any hex, not just the palette */}
            <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-[10px] text-text-muted hover:text-text">
              <input
                type="color"
                value={color}
                onChange={(e) => onPick(e.target.value)}
                aria-label={`custom color`}
                className="h-4 w-6 shrink-0 cursor-pointer rounded-sm border border-border bg-transparent p-0"
              />
              custom…
            </label>
          </span>
        </>
      )}
    </span>
  );
}

/** Inline layer rename. The pencil ALWAYS opens the editor (any row); the name
 *  button opens it on the ACTIVE row and bubbles to row-select on an inactive
 *  one. Enter/blur commit (an empty draft commits as the previous name), Escape
 *  cancels. The pencil prevents default on mousedown so the opening click cannot
 *  move focus; the input is focused + selected in an effect on open. */
function LayerName({
  name, active, onCommit,
}: {
  name: string;
  active: boolean;
  onCommit: (n: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);
  const open = () => {
    setDraft(name);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const n = draft.trim();
    if (n && n !== name) onCommit(n); // empty → keep the previous name
  };
  if (!editing) {
    return (
      <>
        <button
          type="button"
          onClick={(e) => {
            if (!active) return; // bubble → row select
            e.stopPropagation();
            open();
          }}
          title={active ? "rename this layer" : undefined}
          className="min-w-0 truncate text-left text-text/90 hover:text-accent"
        >
          {name}
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()} // keep focus where it is
          onClick={open} // bubbles → the row becomes active too
          title={`rename layer "${name}"`}
          aria-label={`rename layer ${name}`}
          className="shrink-0 text-text-faint hover:text-accent"
        >
          ✎
        </button>
      </>
    );
  }
  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") { setDraft(name); setEditing(false); }
      }}
      aria-label="layer name"
      className="w-32 min-w-0 rounded border border-border bg-surface px-1 py-0 text-[11px] text-text focus:border-accent/60 focus:outline-none"
    />
  );
}

// ===========================================================================
// COLOR BY METRIC — the continuous gradient (single layer only)
// ===========================================================================

function ColorByRow({
  eligible, colorBy, schema, onChange,
}: {
  eligible: boolean;
  colorBy: string | null;
  schema: MetricSchemaEntry[];
  onChange: (m: string | null) => void;
}) {
  const groups = useMemo(() => groupedMetricOptions(schema, Y_GROUP_ORDER).groups, [schema]);
  if (!eligible) {
    return (
      <div className="mb-2 text-[11px] text-text-faint">
        gradient available with a single layer
      </div>
    );
  }
  return (
    <div className="mb-2 grid grid-cols-[auto_1fr] items-center gap-x-2">
      <span className="text-text-faint">Color by metric</span>
      <select
        value={colorBy ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label="Color by metric"
        className="w-full rounded border border-border bg-surface px-1 py-0.5 text-[11px] text-text focus:border-accent/60 focus:outline-none"
      >
        <option value="">(none)</option>
        {groups.map(([g, entries]) => (
          <optgroup key={g} label={g}>
            {entries.map((e) => (
              <option key={e.name} value={e.name}>{e.label}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

// ===========================================================================
// categorical parameter row — a filter chip with an expand-into-layers popover
// ===========================================================================

// React.memo: with stable props (conditioned map, selected array, and handler
// bundle all kept referentially stable by ViewConfig) an untouched chip skips
// re-render entirely when an unrelated control changes.
const CategoricalRow = memo(function CategoricalRow({
  dim, pv, conditioned, facet, selected,
  onToggleValue, onClear, onIsolate, onExclude, onExpand,
}: {
  dim: ParameterDef;
  pv: ParamValues;
  /** Faceted-search counts (this facet dropped, every other filter applied);
   *  a globally-observed value missing here renders as 0 / muted. */
  conditioned: ReadonlyMap<string, number>;
  /** True when this parameter is the group-plot facet. */
  facet: boolean;
  selected: readonly string[];
  onToggleValue: (value: string) => void;
  onClear: () => void;
  onIsolate: (value: string) => void;
  onExclude: (value: string, all: string[]) => void;
  /** Present on plot-view categorical rows: expand into one layer per value. */
  onExpand?: (targets: GeneratorTargets) => void;
}) {
  const [filter, setFilter] = useState("");
  // Chip DISPLAY order: numericSort dims (arity, seed, …) ascending BY VALUE;
  // everything else DESCENDING by conditioned run count. Display-only.
  const allValues = useMemo(
    () => orderValues(dim, pv.values, conditioned),
    [dim, pv.values, conditioned],
  );
  const shown = filter
    ? allValues.filter(({ value }) => (dim.display ? dim.display(value) : value).toLowerCase().includes(filter.toLowerCase()))
    : allValues;
  const visible = shown.slice(0, MAX_VALUES);

  return (
    <div className="mb-1.5 rounded-md border border-border/50 p-1">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-text/90" title={`${dim.label}: ${allValues.length} values`}>{dim.label}</span>
        {facet && (
          <span className="shrink-0 rounded border border-accent/40 bg-accent/10 px-1 py-px text-[10px] text-accent" title="faceted across panels">
            facet
          </span>
        )}
        <span className="shrink-0 text-text-faint">×{allValues.length}</span>
        {onExpand && <ExpandMenu label={dim.label} onExpand={onExpand} />}
        {selected.length > 0 && dim.facetKey && (
          <button type="button" onClick={onClear} title="clear this parameter's filter" className="shrink-0 text-text-muted hover:text-accent">⌫</button>
        )}
      </div>

      {/* value list */}
      <div className="mt-1">
        {allValues.length > MAX_VALUES && (
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter values…"
            aria-label={`filter ${dim.label} values`}
            className="mb-1 w-full rounded border border-border bg-surface px-1 py-0.5 text-[11px] text-text placeholder:text-text-faint focus:border-accent/60 focus:outline-none"
          />
        )}
        <div className={allValues.length > MAX_VALUES ? "max-h-44 overflow-y-auto" : ""}>
          {visible.map(({ value }) => {
            const active = selected.includes(value);
            const count = conditioned.get(value) ?? 0;
            // Muted when unselected-under-a-selection OR unreachable under the
            // other filters (conditioned count 0) — still checkable.
            const dimmed = (selected.length > 0 && !active) || count === 0;
            const disp = dim.display ? dim.display(value) : value;
            return (
              <div key={value} className={`group flex items-center gap-1 rounded px-0.5 py-0.5 hover:bg-surface-alt ${dimmed ? "opacity-40" : ""}`}>
                <input type="checkbox" checked={active} onChange={() => onToggleValue(value)}
                  disabled={!dim.facetKey}
                  aria-label={`filter ${dim.label} ${disp}`} className="accent-accent disabled:opacity-30" />
                <span className="min-w-0 flex-1 truncate" title={disp}>{disp}</span>
                <span className="shrink-0 text-[10px] text-text-faint tabular-nums"
                  title="runs matching the other filters with this value">{count}</span>
                {dim.facetKey && (
                  <span className="ml-0.5 hidden shrink-0 gap-0.5 group-hover:flex">
                    <button type="button" onClick={() => onIsolate(value)} title="isolate — filter to just this value" className="text-text-faint hover:text-accent">◎</button>
                    <button type="button" onClick={() => onExclude(value, allValues.map((v) => v.value))} title="exclude — drop this value" className="text-text-faint hover:text-error">⊘</button>
                  </span>
                )}
              </div>
            );
          })}
          {shown.length > MAX_VALUES && (
            <div className="px-1 text-text-faint">+{shown.length - MAX_VALUES} more (scroll)</div>
          )}
          {shown.length === 0 && <div className="px-1 text-text-faint">no matches</div>}
        </div>
      </div>
    </div>
  );
});

/** Expand-into-layers popover: mint one layer per value of this parameter over
 *  all layers (Tom's usual — listed first) or just the active one. */
function ExpandMenu({ label, onExpand }: { label: string; onExpand: (targets: GeneratorTargets) => void }) {
  const [open, setOpen] = useState(false);
  const choose = (t: GeneratorTargets) => { onExpand(t); setOpen(false); };
  return (
    <span className="relative shrink-0">
      <button type="button" onClick={() => setOpen((o) => !o)}
        title={`one layer per ${label} value`} aria-label={`expand ${label} into layers`}
        className="text-text-faint hover:text-accent">⧉▾</button>
      {open && (
        <>
          <span className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <span className="absolute right-0 top-full z-30 mt-1 block w-32 rounded-lg border border-border bg-surface/95 p-1 shadow-lg backdrop-blur-md">
            <button type="button" onClick={() => choose("all")}
              className="block w-full rounded px-1.5 py-0.5 text-left text-text/90 hover:bg-surface-alt hover:text-accent">all layers</button>
            <button type="button" onClick={() => choose("active")}
              className="block w-full rounded px-1.5 py-0.5 text-left text-text/90 hover:bg-surface-alt hover:text-accent">active layer</button>
          </span>
        </>
      )}
    </span>
  );
}

function TreatBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${active ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted hover:border-accent/40 hover:text-accent"}`}>
      {label}
    </button>
  );
}

// ===========================================================================
// FUNCTION section — engaged-only complexity metrics (with a bin-into-layers
// control on each). Arity + fn_hex render above this via renderParamRow.
// ===========================================================================

function ComplexityBlock({
  complexity, index, filtered, activeRanges, canBin,
  onAddFilter, onRemoveFilter, updateRange, onBin,
}: {
  complexity: MetricSchemaEntry[];
  index: MetricIndex;
  filtered: RunRow[];
  /** The active layer's own ranges (a range on a complexity metric = engaged). */
  activeRanges: RangeFilter[];
  canBin: boolean;
  onAddFilter: (metric: string) => void;
  onRemoveFilter: (metric: string) => void;
  updateRange: (metric: string, patch: Partial<RangeFilter>) => void;
  onBin: (metric: string, n: number, mode: "quantile" | "width", targets: GeneratorTargets) => void;
}) {
  // "Opened this session" — a metric added from the picker (or auto-engaged by a
  // range on the active layer). Both count as engaged.
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const rangeMetrics = new Set(activeRanges.map((r) => r.metric));
  const engaged = complexity.filter((e) => opened.has(e.name) || rangeMetrics.has(e.name));
  const available = complexity.filter((e) => !opened.has(e.name) && !rangeMetrics.has(e.name));

  const openMetric = (name: string) => setOpened((s) => new Set(s).add(name));
  const closeMetric = (name: string) => {
    setOpened((s) => { const n = new Set(s); n.delete(name); return n; });
    if (rangeMetrics.has(name)) onRemoveFilter(name);
  };

  return (
    <div className="mt-1">
      <div className="mb-1 flex items-center gap-1">
        <span className="text-[10px] uppercase tracking-wide text-text-faint">complexity</span>
        <select
          value=""
          onChange={(e) => { if (e.target.value) openMetric(e.target.value); }}
          aria-label="add complexity metric"
          className="ml-auto rounded border border-border bg-surface px-1 py-0.5 text-[11px] text-text-muted focus:border-accent/60 focus:outline-none"
        >
          <option value="">add metric ▾</option>
          {available.map((e) => (
            <option key={e.name} value={e.name}>{e.label}</option>
          ))}
        </select>
      </div>
      {engaged.length === 0 && (
        <div className="px-1 text-[11px] text-text-faint">no metric engaged — add one to filter or bin</div>
      )}
      {engaged.map((e) => (
        <ComplexityMetricRow
          key={e.name}
          entry={e}
          index={index}
          filtered={filtered}
          range={activeRanges.find((r) => r.metric === e.name)}
          canBin={canBin}
          onAddFilter={() => onAddFilter(e.name)}
          onRemoveFilter={() => onRemoveFilter(e.name)}
          onClose={() => closeMetric(e.name)}
          updateRange={(patch) => updateRange(e.name, patch)}
          onBin={(n, mode, targets) => onBin(e.name, n, mode, targets)}
        />
      ))}
    </div>
  );
}

function ComplexityMetricRow({
  entry, index, filtered, range, canBin,
  onAddFilter, onRemoveFilter, onClose, updateRange, onBin,
}: {
  entry: MetricSchemaEntry;
  index: MetricIndex;
  filtered: RunRow[];
  range: RangeFilter | undefined;
  canBin: boolean;
  onAddFilter: () => void;
  onRemoveFilter: () => void;
  onClose: () => void;
  updateRange: (patch: Partial<RangeFilter>) => void;
  onBin: (n: number, mode: "quantile" | "width", targets: GeneratorTargets) => void;
}) {
  const [n, setN] = useState(3);
  const [mode, setMode] = useState<"quantile" | "width">("quantile");
  const [targets, setTargets] = useState<GeneratorTargets>("all");
  const m = entry.name;

  return (
    <div className="mb-1 rounded border border-border/40 px-1 py-0.5">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-text/90" title={metricLabel(index, m)}>{metricLabel(index, m)}</span>
        {range && <span className="shrink-0 text-[10px] text-accent">filter</span>}
        <button type="button" onClick={onClose} title="remove this metric" aria-label={`remove metric ${entry.label}`}
          className="shrink-0 text-text-faint hover:text-error">×</button>
      </div>

      {range ? (
        <div className="mt-1">
          <RangeEditor range={range} rows={filtered} index={index} updateRange={updateRange} />
          <button type="button" onClick={onRemoveFilter} className="mt-0.5 text-[11px] text-text-faint hover:text-accent">clear filter</button>
        </div>
      ) : (
        <div className="mt-1">
          <MiniHistogram rows={filtered} metric={m} index={index} />
          <button type="button" onClick={onAddFilter} className="mt-0.5">
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted hover:border-accent/40 hover:text-accent">filter</span>
          </button>
        </div>
      )}

      {/* bin control — slice this metric into n layers (edges over each layer's
          own rows: within-arity when the layer pins an arity) */}
      {canBin && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 border-t border-border/40 pt-1 text-[11px]">
          <label className="flex items-center gap-1 text-text-faint">
            n
            <input type="number" min={2} max={8} value={n}
              onChange={(e) => setN(Math.max(2, Math.min(8, Number(e.target.value) || 2)))}
              aria-label={`bin count for ${entry.label}`}
              className="w-10 rounded border border-border bg-surface px-1 py-0.5 text-text focus:border-accent/60 focus:outline-none" />
          </label>
          <span className="flex items-center gap-0.5">
            <TreatBtn label="quantile" active={mode === "quantile"} onClick={() => setMode("quantile")} />
            <TreatBtn label="width" active={mode === "width"} onClick={() => setMode("width")} />
          </span>
          <span className="flex items-center gap-0.5">
            <TreatBtn label="all" active={targets === "all"} onClick={() => setTargets("all")} />
            <TreatBtn label="active" active={targets === "active"} onClick={() => setTargets("active")} />
          </span>
          <button type="button" onClick={() => onBin(n, mode, targets)}
            aria-label={`bin ${entry.label} into layers`}
            className="rounded border border-accent/50 px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/10">
            bin into layers
          </button>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// outcome metric rows (filter / color treatment)
// ===========================================================================

function MetricList({
  entries, isPlotLike, index, filtered, rangeFor, treatmentOf, onSetTreatment,
  updateRange,
}: {
  entries: MetricSchemaEntry[];
  isPlotLike: boolean;
  index: MetricIndex;
  filtered: RunRow[];
  rangeFor: (m: string) => RangeFilter | undefined;
  treatmentOf: (m: string) => "filter" | "color" | null;
  onSetTreatment: (m: string, t: "filter" | "color" | null) => void;
  updateRange: (m: string, patch: Partial<RangeFilter>) => void;
}) {
  const [q, setQ] = useState("");
  const shown = q
    ? entries.filter((e) => e.label.toLowerCase().includes(q.toLowerCase()) || e.name.toLowerCase().includes(q.toLowerCase()))
    : entries;
  return (
    <>
      {entries.length > 8 && (
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter metrics…"
          aria-label="filter metrics"
          className="mb-1 w-full rounded border border-border bg-surface px-1 py-0.5 text-[11px] text-text placeholder:text-text-faint focus:border-accent/60 focus:outline-none" />
      )}
      {shown.map((e) => (
        <ContinuousRow
          key={e.name}
          entry={e}
          isPlotLike={isPlotLike}
          index={index}
          filtered={filtered}
          range={rangeFor(e.name)}
          treatment={treatmentOf(e.name)}
          onSetTreatment={(t) => onSetTreatment(e.name, t)}
          updateRange={(patch) => updateRange(e.name, patch)}
        />
      ))}
    </>
  );
}

function ContinuousRow({
  entry, isPlotLike, index, filtered, range, treatment, onSetTreatment,
  updateRange,
}: {
  entry: MetricSchemaEntry;
  isPlotLike: boolean;
  index: MetricIndex;
  filtered: RunRow[];
  range: RangeFilter | undefined;
  treatment: "filter" | "color" | null;
  onSetTreatment: (t: "filter" | "color" | null) => void;
  updateRange: (patch: Partial<RangeFilter>) => void;
}) {
  const m = entry.name;
  const engaged = treatment !== null;
  const [expanded, setExpanded] = useState(false);
  const open = engaged || expanded;

  return (
    <div className="mb-1 rounded border border-border/40 px-1 py-0.5">
      <button type="button" onClick={() => setExpanded((o) => !o)}
        className="flex w-full items-center gap-1 text-left">
        <span className="min-w-0 flex-1 truncate text-text/90" title={metricLabel(index, m)}>{metricLabel(index, m)}</span>
        {treatment && <span className="shrink-0 text-[10px] text-accent">{treatment}</span>}
        <span aria-hidden className="text-text-faint">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-1">
          <div className="flex items-center gap-1">
            <TreatBtn label="filter" active={treatment === "filter"} onClick={() => onSetTreatment(treatment === "filter" ? null : "filter")} />
            {isPlotLike && <TreatBtn label="color" active={treatment === "color"} onClick={() => onSetTreatment(treatment === "color" ? null : "color")} />}
          </div>

          {treatment === "filter" && range && (
            <div className="mt-1">
              <RangeEditor range={range} rows={filtered} index={index} updateRange={updateRange} />
            </div>
          )}
          {treatment === "color" && (
            <div className="mt-1 flex items-center gap-2 text-[11px] text-text-muted">
              <span>coloring points by this metric</span>
              <button type="button" onClick={() => onSetTreatment(null)} className="text-text-faint hover:text-accent">clear</button>
            </div>
          )}
          {!treatment && (
            <MiniHistogram rows={filtered} metric={m} index={index} />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// mini histogram
// ---------------------------------------------------------------------------

function MiniHistogram({
  rows, metric, index,
}: {
  rows: RunRow[];
  metric: string;
  index: MetricIndex;
}) {
  const bins = useMemo(() => histogramBins(rows, metric, HIST_BINS, index), [rows, metric, index]);
  const maxBin = Math.max(1, ...bins);
  return (
    <span className="relative mt-1 flex h-6 items-end gap-px">
      {bins.map((c, i) => (
        <span key={i} className="flex-1 bg-accent/50" style={{ height: `${(c / maxBin) * 100}%` }} />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// RANGE EDITOR — histogram + dual slider popover body.
// ---------------------------------------------------------------------------

function RangeEditor({
  range, rows, index, updateRange,
}: {
  range: RangeFilter;
  rows: RunRow[];
  index: MetricIndex;
  updateRange: (patch: Partial<RangeFilter>) => void;
}) {
  const entry = index[range.metric];
  const bounds = useMemo(() => metricRange(rows, range.metric, index), [rows, range.metric, index]);
  const lo = Math.min(bounds.min, range.min);
  const hi = Math.max(bounds.max, range.max);
  const span = hi - lo || 1;
  const isInt = (entry?.format ?? "") === "d";
  const step = isInt ? 1 : span / 100;

  const bins = useMemo(() => histogramBins(rows, range.metric, HIST_BINS, index), [rows, range.metric, index]);
  const maxBin = Math.max(1, ...bins);
  const fmt = (v: number) => (entry ? formatValue(index, range.metric, v) : v.toFixed(2));

  const [draft, setDraft] = useState({ min: range.min, max: range.max });
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commit = (patch: Partial<RangeFilter>) => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => updateRange(patch), 120);
  };

  const lowPct = ((draft.min - lo) / span) * 100;
  const highPct = ((draft.max - lo) / span) * 100;

  return (
    <span className="block rounded-lg border border-border bg-surface-alt/40 p-2">
      <span className="relative mb-1 flex h-8 items-end gap-px">
        {bins.map((c, i) => {
          const binLo = lo + (i / HIST_BINS) * span;
          const binHi = lo + ((i + 1) / HIST_BINS) * span;
          const inRange = binHi >= draft.min && binLo <= draft.max;
          return (
            <span key={i} className={inRange ? "flex-1 bg-accent/60" : "flex-1 bg-text-faint/40"} style={{ height: `${(c / maxBin) * 100}%` }} />
          );
        })}
        <span className="pointer-events-none absolute inset-y-0 border-x border-accent/50 bg-accent/5" style={{ left: `${lowPct}%`, right: `${100 - highPct}%` }} />
      </span>
      <span className="relative block h-4">
        <input type="range" min={lo} max={hi} step={step} value={draft.min}
          aria-label={`${entry?.label ?? range.metric} minimum`}
          onChange={(e) => { const v = Math.min(Number(e.target.value), draft.max); setDraft((d) => ({ ...d, min: v })); commit({ min: v }); }}
          className="absolute inset-x-0 top-1 w-full accent-accent bg-transparent pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-moz-range-thumb]:pointer-events-auto" />
        <input type="range" min={lo} max={hi} step={step} value={draft.max}
          aria-label={`${entry?.label ?? range.metric} maximum`}
          onChange={(e) => { const v = Math.max(Number(e.target.value), draft.min); setDraft((d) => ({ ...d, max: v })); commit({ max: v }); }}
          className="absolute inset-x-0 top-1 w-full accent-accent bg-transparent pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-moz-range-thumb]:pointer-events-auto" />
      </span>
      <span className="mt-1 flex items-center justify-between text-xs font-mono text-text-muted">
        <span>{fmt(draft.min)}</span>
        <span>{fmt(draft.max)}</span>
      </span>
    </span>
  );
}

// ===========================================================================
// table-only extras — Columns + Sort keys + dir-path search
// ===========================================================================

function TableExtras({ bundle, index }: { bundle: Bundle; index: MetricIndex }) {
  const visibleCols = useBoolbackStore((s) => s.table.visibleCols);
  const setVisibleCols = useBoolbackStore((s) => s.setVisibleCols);
  const sorts = useBoolbackStore((s) => s.table.sorts);
  const search = useBoolbackStore((s) => s.table.search);
  const setSearch = useBoolbackStore((s) => s.setSearch);
  const toggleSortDir = useBoolbackStore((s) => s.toggleSortDir);
  const removeSort = useBoolbackStore((s) => s.removeSort);
  const reorderSorts = useBoolbackStore((s) => s.reorderSorts);

  const [draft, setDraft] = useState(search);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef(search);
  if (search !== last.current) { last.current = search; if (draft !== search) setDraft(search); }
  const commitSearch = (q: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { last.current = q; setSearch(q); }, 150);
  };

  const dragIdx = useRef<number | null>(null);
  const onDrop = (target: number) => {
    const from = dragIdx.current;
    dragIdx.current = null;
    if (from === null || from === target) return;
    const next = [...sorts];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);
    reorderSorts(next);
  };

  return (
    <>
      <CollapsibleSection title="find runs" defaultOpen>
        <input type="search" value={draft} placeholder="dir path / run id fragment…"
          aria-label="find runs by path"
          onChange={(e) => { setDraft(e.target.value); commitSearch(e.target.value); }}
          className="w-full rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-text placeholder:text-text-faint caret-accent focus:border-accent/60 focus:outline-none" />
      </CollapsibleSection>

      <CollapsibleSection title={`sort keys${sorts.length ? ` ×${sorts.length}` : ""}`}>
        {sorts.length === 0 && <div className="px-1 text-text-faint">no sort — click a column header</div>}
        {sorts.map((s, i) => (
          <div key={s.col} draggable
            onDragStart={() => { dragIdx.current = i; }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(i)}
            className="flex items-center gap-1 rounded px-1 py-0.5 text-xs cursor-grab active:cursor-grabbing hover:bg-surface-alt"
            title="drag to reorder · click arrow to flip · × to remove">
            <span className="text-text-faint tabular-nums">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-text/90">{resolveById(s.col, bundle, index).label}</span>
            <button onClick={() => toggleSortDir(s.col)} className="text-accent hover:text-text" aria-label="flip direction">{s.dir === "asc" ? "▲" : "▼"}</button>
            <button onClick={() => removeSort(s.col)} className="text-text-muted hover:text-error" aria-label="remove sort">×</button>
          </div>
        ))}
      </CollapsibleSection>

      <CollapsibleSection title="columns">
        <ColumnGroupMenu bundle={bundle} index={index} visibleCols={visibleCols} setVisibleCols={setVisibleCols} />
      </CollapsibleSection>
    </>
  );
}

// ===========================================================================
// shared: toggle
// ===========================================================================

function Toggle({
  label, checked, onChange, title,
}: {
  label: string;
  checked: boolean;
  onChange: (b: boolean) => void;
  title?: string;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1 text-text-muted hover:text-text" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
      {label}
    </label>
  );
}

export default ConfigPanel;
