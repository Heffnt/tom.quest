"use client";

// app/boolback/components/config-panel.tsx — the SINGLE right-docked control
// surface, shared across all center views (replaces dimension-board +
// detail-panel). Two modes:
//
//   run inspector — when a run is open (detailOpen && a run resolves from the
//     selection): renders <RunInspector> with a back affordance.
//   config        — otherwise: the active view's controls. Content depends on
//     configViewOf(centerView):
//       table     → filter-only parameter rows + Columns + Sort keys + search;
//       plot      → the SETTINGS strip (per-setting swatch/name/count/dup/del,
//                   overlap + judge warnings) + the ordered multi "Split by"
//                   editor + the gated "Color by metric" gradient select +
//                   tiered parameter chips editing the ACTIVE setting +
//                   continuous rows (filter/color) + band/ghosts/trend;
//       groupPlot → + "Facet by" select (parameters or "setting") +
//                   panel-size slider;
//       anatomy   → a tiny note (anatomy owns its own controls).
//
// This panel WRITES config (settings/splitBy/colorBy/facet). Phase 3: the
// full settings editor — strip (rename/recolor/duplicate/counts/warnings),
// ordered multi-split, tiered + nested parameter chips with conditioned
// counts, and the gated colorBy gradient select. Everything the panel says
// about series/warnings comes from lib/split-dims.resolveSeries (the same
// pure resolver the plot renders from), never a parallel computation.

import { memo, startTransition, useEffect, useMemo, useRef, useState } from "react";
import type {
  Bundle, RangeFilter, FilterState, RunRow,
  PlotConfig, GroupPlotConfig, TableConfig, MetricSchemaEntry, PlotSetting,
} from "../lib/types";
import { EMPTY_FILTER } from "../lib/types";
import { useBoolbackStore, configViewOf, type ViewKey, type PlotViewKey } from "../state/store";
import type { ViewKind } from "../lib/spec";
import { configToSpec, specToConfig, serializeSpec, parseSpec } from "../lib/spec";
import {
  PARAMETERS, summarizeParameters, tierSections, conditionedCounts, orderValuesByCount,
  TIER_LABEL, PARAM_TIERS,
  type ParameterDef, type ParamValues, type ParamTier,
} from "../lib/parameters";
import { resolveSeries, type SeriesResolution } from "../lib/split-dims";
import { CATEGORY_PALETTE } from "../lib/styling";
import {
  applyFilters, histogramBins, metricRange, dominantFilters, type MetricIndex,
} from "../lib/select";
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

/** Split-by dropdown group order: sweep-tier axes first, then setting-tier. */
const SPLIT_TIER_ORDER: ParamTier[] = ["sweep", "setting", "function"];

/** paramOf for resolveSeries — the PARAMETERS registry keyed by param key. */
const PARAM_BY_KEY = new Map(PARAMETERS.map((p) => [p.key, p]));
const paramOfKey = (key: string): ParameterDef | null => PARAM_BY_KEY.get(key) ?? null;

/** The visual role a parameter chip plays on the CURRENT plot config. */
type ParamRole = "split" | "facet" | null;

/** Map the store ViewKey to the spec ViewKind (groupPlot → groupplot). */
function specKindOf(vk: ViewKey): ViewKind {
  return vk === "groupPlot" ? "groupplot" : vk;
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
  centerView: import("./table-pane").CenterView;
}) {
  const vk = configViewOf(centerView);

  if (vk === null) {
    return (
      <div className="flex h-full w-full flex-col min-h-0">
        <PanelHeader vk={null} rows={bundle.rows} chartRef={chartRef} />
        <p className="px-3 py-3 font-mono text-xs text-text-faint">
          Anatomy has its own controls.
        </p>
      </div>
    );
  }

  return <ViewConfig vk={vk} bundle={bundle} index={index} chartRef={chartRef} />;
}

function ViewConfig({
  vk, bundle, index, chartRef,
}: {
  vk: ViewKey;
  bundle: Bundle;
  index: MetricIndex;
  chartRef: React.MutableRefObject<PlotExportHandle | null>;
}) {
  const table = useBoolbackStore((s) => s.table);
  const plot = useBoolbackStore((s) => s.plot);
  const groupPlot = useBoolbackStore((s) => s.groupPlot);

  const setPlot = useBoolbackStore((s) => s.setPlot);
  const setGroupPlot = useBoolbackStore((s) => s.setGroupPlot);
  const addSetting = useBoolbackStore((s) => s.addSetting);
  const duplicateSetting = useBoolbackStore((s) => s.duplicateSetting);
  const patchSetting = useBoolbackStore((s) => s.patchSetting);
  const removeSetting = useBoolbackStore((s) => s.removeSetting);
  const storeSetFacet = useBoolbackStore((s) => s.setFacet);
  const storeToggleFacetValue = useBoolbackStore((s) => s.toggleFacetValue);
  const storeAddRange = useBoolbackStore((s) => s.addRange);
  const storeRemoveRange = useBoolbackStore((s) => s.removeRange);
  const storeUpdateRange = useBoolbackStore((s) => s.updateRange);

  const isPlotLike = vk === "plot" || vk === "groupPlot";
  const config = (vk === "plot" ? plot : vk === "groupPlot" ? groupPlot : table) as
    PlotConfig | GroupPlotConfig | TableConfig;
  const plotConfig = isPlotLike ? (config as PlotConfig) : null;
  const groupConfig = vk === "groupPlot" ? (config as GroupPlotConfig) : null;

  /** Whole-config patch for the active plot-like view. Wrapped in a transition
   *  so the click/toggle repaints immediately and the expensive downstream
   *  render (resolveSeries + plot) is non-blocking (INP). */
  const patchPlot = (patch: Partial<GroupPlotConfig>) => {
    startTransition(() => {
      if (vk === "plot") setPlot(patch);
      else if (vk === "groupPlot") setGroupPlot(patch);
    });
  };

  /** The dominant-cell default filters (Feature 1) — seeds a newly-added
   *  setting. Memoized: only the row set changes it. */
  const dominant = useMemo(() => dominantFilters(bundle.rows), [bundle.rows]);

  // ---- ACTIVE setting (UI-local; the parameter rows edit ITS filters) --------
  const [activeSettingId, setActiveSettingId] = useState<string | null>(null);
  const activeSetting: PlotSetting | null = plotConfig
    ? plotConfig.settings.find((s) => s.id === activeSettingId) ?? plotConfig.settings[0]
    : null;
  /** The settingId the filter mutators target (null on the table view). */
  const sid = activeSetting?.id ?? null;
  /** The FilterState the panel edits + histograms derive from. */
  const activeFilters: FilterState =
    vk === "table" ? (config as TableConfig).filters : activeSetting?.filters ?? EMPTY_FILTER;

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
  // The panel never re-derives what the plot shows: matched-run counts,
  // overlap/empty/judge warnings, and inactive splits all read resolveSeries.
  // Memoized on the resolver's real inputs (settings/ranges/splitBy) — NOT the
  // whole plotConfig — so a band/colorBy/axis toggle doesn't re-run it (INP).
  const rsSettings = plotConfig?.settings;
  const rsRanges = plotConfig?.ranges;
  const rsSplitBy = plotConfig?.splitBy;
  const resolution: SeriesResolution | null = useMemo(
    () =>
      rsSettings && rsRanges && rsSplitBy
        ? resolveSeries({
            rows: bundle.rows,
            settings: rsSettings,
            ranges: rsRanges,
            splitBy: rsSplitBy,
            paramOf: paramOfKey,
            applyTo: applyFilters,
          })
        : null,
    [bundle.rows, rsSettings, rsRanges, rsSplitBy],
  );
  /** Matched-run count per setting id, summed over its resolved series. */
  const countsBySetting = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of resolution?.series ?? []) {
      m.set(s.settingId, (m.get(s.settingId) ?? 0) + s.rows.length);
    }
    return m;
  }, [resolution]);

  // Rows matching the ACTIVE setting (or the table filters) drive the
  // continuous editors' histograms.
  const filtered = useMemo(() => applyFilters(bundle.rows, activeFilters), [bundle.rows, activeFilters]);

  // ---- conditioned value counts (faceted-search counting) ---------------------
  // Per parameter: drop ITS facet, apply the active setting's other facets +
  // its own ranges + the plot-level ranges. Values keep showing globally
  // (reachability); zero-count values render muted.
  //
  // Keyed on the FILTER inputs only (plotConfig.ranges, not the whole config),
  // and each parameter's Map is kept referentially stable across renders via a
  // signature cache (its own facet excluded from the signature): toggling facet
  // A leaves A's own count list identical AND lets every OTHER chip that didn't
  // change skip re-render (React.memo on CategoricalRow). This is the bulk of
  // the per-click work (a full applyFilters over the rows per parameter).
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

  const roleOf = (key: string): ParamRole => {
    if (!plotConfig) return null;
    if (groupConfig?.facet === key) return "facet";
    if (plotConfig.splitBy.includes(key)) return "split";
    return null;
  };

  // ---- facet slot (group plot) -------------------------------------------------
  const facetOptions = useMemo(
    () => [
      { value: "setting", label: "setting (one panel per setting)" },
      ...summary.differing.map((d) => ({ value: d.dim.key, label: d.dim.label })),
    ],
    [summary],
  );

  // ---- filter mutators (table → its own filters; plot → the active setting) --
  const selectionOf = (dim: ParameterDef): readonly string[] =>
    dim.facetKey ? (activeFilters.facets[dim.facetKey] ?? NO_VALUES) : NO_VALUES;
  // Per-parameter handler bundles, memoized so an untouched chip keeps stable
  // callback identity (React.memo skip). Rebuilt only when the target
  // view/setting or the store mutators change — never on a filter toggle. Every
  // store write is wrapped in a transition (the checkbox repaints first; the
  // heavy resolveSeries + plot render is non-blocking).
  const rowHandlers = useMemo(() => {
    const m = new Map<string, {
      onToggleValue: (v: string) => void;
      onClear: () => void;
      onIsolate: (v: string) => void;
      onExclude: (v: string, all: string[]) => void;
    }>();
    for (const dim of differingDims) {
      const fk = dim.facetKey;
      m.set(dim.key, {
        onToggleValue: (v) => { if (fk) startTransition(() => storeToggleFacetValue(vk, sid, fk, v)); },
        onClear: () => { if (fk) startTransition(() => storeSetFacet(vk, sid, fk, [])); },
        onIsolate: (v) => { if (fk) startTransition(() => storeSetFacet(vk, sid, fk, [v])); },
        onExclude: (v, all) => { if (fk) startTransition(() => storeSetFacet(vk, sid, fk, all.filter((x) => x !== v))); },
      });
    }
    return m;
  }, [differingDims, vk, sid, storeToggleFacetValue, storeSetFacet]);

  // ---- continuous treatment (filter / color) --------------------------------
  const rangeFor = (m: string): RangeFilter | undefined => activeFilters.ranges.find((r) => r.metric === m);
  const contTreatmentOf = (m: string): "filter" | "color" | null => {
    if (plotConfig?.colorBy === m) return "color";
    if (rangeFor(m)) return "filter";
    return null;
  };
  const setContTreatment = (m: string, t: "filter" | "color" | null) => {
    // Store writes off the transition path (patchPlot already wraps itself).
    startTransition(() => {
      // Clear any existing treatment for this metric first.
      if (rangeFor(m)) storeRemoveRange(vk, sid, m);
      if (plotConfig?.colorBy === m) patchPlot({ colorBy: null });
      if (t === "filter") {
        const { min, max } = metricRange(bundle.rows, m, index);
        storeAddRange(vk, sid, { metric: m, min, max });
      } else if (t === "color" && plotConfig) {
        // colorBy is only honored on a single, unsplit setting (the plot ignores
        // it otherwise) — stored regardless, per the config contract.
        patchPlot({ colorBy: m });
      }
    });
  };

  // ---- render ----------------------------------------------------------------
  // Parameter chips: tier sections (Setting → Sweep → Function), with
  // target_phrase / judge nested under target_behavior per NESTED_UNDER.
  const chipSections = tierSections(differingDims);

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
        role={isPlotLike ? roleOf(dim.key) : null}
        selected={selected}
        onToggleValue={h.onToggleValue}
        onClear={h.onClear}
        onIsolate={h.onIsolate}
        onExclude={h.onExclude}
      />
    );
  };

  return (
    <div className="flex h-full w-full flex-col min-h-0">
      <PanelHeader vk={vk} rows={bundle.rows} chartRef={chartRef} />

      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 text-xs text-text-muted">
        {vk === "table" && <TableExtras bundle={bundle} index={index} />}

        {/* SETTINGS strip — one row per setting (swatch / name / matched-run
            count / duplicate / delete), warnings from resolveSeries. The
            parameter chips below edit the ACTIVE setting's filters. */}
        {isPlotLike && plotConfig && resolution && (
          <SettingsStrip
            settings={plotConfig.settings}
            activeId={activeSetting?.id ?? null}
            counts={countsBySetting}
            resolution={resolution}
            onSelect={(id) => startTransition(() => setActiveSettingId(id))}
            onRename={(id, name) => startTransition(() => patchSetting(vk as PlotViewKey, id, { name }))}
            onRecolor={(id, color) => startTransition(() => patchSetting(vk as PlotViewKey, id, { color }))}
            onDuplicate={(id) => startTransition(() => {
              const nid = duplicateSetting(vk as PlotViewKey, id);
              if (nid) setActiveSettingId(nid);
            })}
            onRemove={(id) => startTransition(() => removeSetting(vk as PlotViewKey, id))}
            // A new setting defaults to the DOMINANT CELL (Feature 1), not empty.
            onAdd={() => startTransition(() => setActiveSettingId(addSetting(vk as PlotViewKey, dominant)))}
          />
        )}

        {/* SPLIT BY — ordered multi-select; options are the GLOBALLY differing
            parameters, so a choice stays reachable even when the current
            filters make it constant */}
        {isPlotLike && plotConfig && resolution && (
          <SplitByEditor
            splitBy={plotConfig.splitBy}
            inactive={resolution.inactive}
            available={differingDims}
            onChange={(next) => patchPlot({ splitBy: next })}
          />
        )}

        {groupConfig && (
          <div className="mb-2 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
            <ParamSelect
              label="Facet by"
              value={groupConfig.facet}
              options={facetOptions}
              onChange={(v) => startTransition(() => setGroupPlot({ facet: v }))}
            />
          </div>
        )}

        {/* COLOR BY METRIC — the continuous gradient, honored only on a
            single unsplit setting */}
        {isPlotLike && plotConfig && (
          <ColorByRow
            eligible={plotConfig.settings.length === 1 && plotConfig.splitBy.length === 0}
            colorBy={plotConfig.colorBy}
            schema={bundle.metric_schema}
            onChange={(m) => patchPlot({ colorBy: m })}
          />
        )}

        {/* which setting the chips edit */}
        {isPlotLike && activeSetting && (
          <div className="mb-1 border-t border-border/50 pt-1.5 text-[11px] text-text-faint">
            editing: <span className="text-text/90">{activeSetting.name}</span>
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

        {/* continuous sections — complexity + outcomes (plot-like views wire
            color; table gets filter-only) */}
        <ContinuousSections
          isPlotLike={isPlotLike}
          bundle={bundle}
          index={index}
          filtered={filtered}
          rangeFor={rangeFor}
          treatmentOf={contTreatmentOf}
          onSetTreatment={setContTreatment}
          updateRange={(m, p) => startTransition(() => storeUpdateRange(vk, sid, m, p))}
        />

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

        {/* footer toggles (plot-like) */}
        {plotConfig && (
          <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-border/50 pt-2 text-[11px]">
            <Toggle label="band" checked={!!plotConfig.band} onChange={(b) => patchPlot({ band: b })} title="±1 SD spread band / whiskers" />
            <Toggle label="ghosts" checked={!!plotConfig.ghosts} onChange={(b) => patchPlot({ ghosts: b })} title="faint underlying runs" />
            <Toggle label="trend" checked={!!plotConfig.trend} onChange={(b) => patchPlot({ trend: b })} title="OLS fit + r/ρ readout" />
          </div>
        )}
        {groupConfig && (
          <label className="mt-2 flex items-center gap-2 border-t border-border/50 pt-2 text-[11px] text-text-muted">
            panel size
            <input
              type="range" min={160} max={480} step={20} value={groupConfig.panelMin}
              onChange={(e) => startTransition(() => setGroupPlot({ panelMin: Number(e.target.value) }))}
              className="accent-accent" aria-label="panel size"
            />
          </label>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// header — Views · Copy · Paste · Export · Reset
// ===========================================================================

function PanelHeader({
  vk, rows, chartRef,
}: {
  vk: ViewKey | null;
  /** Bundle rows — reset seeds a plot-like view with their dominant cell. */
  rows: RunRow[];
  chartRef: React.MutableRefObject<PlotExportHandle | null>;
}) {
  const centerView = useBoolbackStore((s) => s.centerView);
  const resetView = useBoolbackStore((s) => s.resetView);
  // Reset lands every view on its default — for plot/groupplot that is one
  // setting pinned to the DOMINANT CELL (each parameter at its most-common
  // value), the same declutter a fresh/added setting gets. Visible per-setting
  // checkboxes, not the old hidden mode-pins.
  const onReset = () => {
    const dominant = centerView === "plot" || centerView === "groupplot"
      ? dominantFilters(rows)
      : undefined;
    resetView(centerView, dominant);
  };
  const [note, setNote] = useState<string | null>(null);
  const flash = (m: string) => { setNote(m); setTimeout(() => setNote(null), 1400); };

  const activeConfig = useActiveConfig(vk);

  const copySpec = async () => {
    if (!vk || !activeConfig) return;
    await copyText(serializeSpec(configToSpec(specKindOf(vk), activeConfig)));
    flash("copied ✓");
  };

  const exportPng = async () => {
    const svg = chartRef.current?.getSvg();
    if (!svg) return;
    const blob = await svgToPngBlob(svg, 2);
    downloadBlob(blob, "boolback-plot.png");
  };

  const isPlotLike = vk === "plot" || vk === "groupPlot";

  return (
    <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-xs">
      {vk && <ViewsMenu vk={vk} />}
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
      <button type="button" onClick={onReset} title="Reset this view"
        className="ml-auto rounded border border-border px-1.5 py-0.5 text-text-muted hover:border-accent/40 hover:text-accent">
        Reset
      </button>
    </header>
  );
}

/** Read the active view's full config out of the store (for spec copy/save). */
function useActiveConfig(vk: ViewKey | null): PlotConfig | GroupPlotConfig | TableConfig | null {
  const table = useBoolbackStore((s) => s.table);
  const plot = useBoolbackStore((s) => s.plot);
  const groupPlot = useBoolbackStore((s) => s.groupPlot);
  if (vk === "table") return table;
  if (vk === "plot") return plot;
  if (vk === "groupPlot") return groupPlot;
  return null;
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
    const { view, config } = specToConfig(spec);
    if (view === "table") setTableConfig(config as TableConfig);
    else if (view === "plot") setPlot(config as PlotConfig);
    else setGroupPlot(config as GroupPlotConfig);
    setCenterView(view === "groupplot" ? "groupplot" : view);
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

function ViewsMenu({ vk }: { vk: ViewKey }) {
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

  const specOfActive = () => {
    const s = useBoolbackStore.getState();
    const cfg = vk === "table" ? s.table : vk === "plot" ? s.plot : s.groupPlot;
    return configToSpec(specKindOf(vk), cfg);
  };

  const apply = (p: PresetRow) => {
    const spec = hydratePresetSpec(p.state);
    if (!spec) { setOpen(false); return; }
    const { view, config } = specToConfig(spec);
    if (view === "table") setTableConfig(config as TableConfig);
    else if (view === "plot") setPlot(config as PlotConfig);
    else setGroupPlot(config as GroupPlotConfig);
    setCenterView(view === "groupplot" ? "groupplot" : view);
    setOpen(false);
  };

  const beginSave = () => {
    const s = useBoolbackStore.getState();
    // Suggest from the table's filters, or the first setting's on a plot view.
    const filters = vk === "table"
      ? s.table.filters
      : (vk === "plot" ? s.plot : s.groupPlot).settings[0]?.filters ?? EMPTY_FILTER;
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
// style-slot select (Color by / Shape by / Facet by)
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
// SETTINGS strip — one row per setting + warnings (all from resolveSeries)
// ===========================================================================

function SettingsStrip({
  settings, activeId, counts, resolution,
  onSelect, onRename, onRecolor, onDuplicate, onRemove, onAdd,
}: {
  settings: PlotSetting[];
  activeId: string | null;
  /** Matched-run count per setting id (summed from resolveSeries). */
  counts: Map<string, number>;
  resolution: SeriesResolution;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onRecolor: (id: string, color: string) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="mb-2">
      {settings.map((s) => {
        const active = s.id === activeId;
        const empty = resolution.emptySettings.includes(s.name);
        const n = counts.get(s.id) ?? 0;
        return (
          <div
            key={s.id}
            onClick={() => onSelect(s.id)}
            title={active ? undefined : `edit setting "${s.name}"`}
            className={`group mb-0.5 flex cursor-pointer items-center gap-1.5 rounded-md border px-1.5 py-1 ${
              active
                ? "border-accent bg-accent/10"
                : "border-border/60 hover:border-accent/40"
            }`}
          >
            <SwatchPicker name={s.name} color={s.color} onPick={(c) => onRecolor(s.id, c)} />
            <SettingName name={s.name} active={active} onCommit={(name) => onRename(s.id, name)} />
            <span
              className={`ml-auto shrink-0 rounded border px-1 py-px text-[10px] tabular-nums ${
                empty ? "border-warning/60 text-warning" : "border-border text-text-faint"
              }`}
              title={empty ? "no runs match this setting's filters" : `${n} matched runs`}
            >
              {empty ? "0 runs" : n}
            </span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDuplicate(s.id); }}
              title={`duplicate setting "${s.name}"`}
              aria-label={`duplicate setting ${s.name}`}
              className="shrink-0 text-text-faint hover:text-accent"
            >
              ⧉
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRemove(s.id); }}
              disabled={settings.length <= 1}
              title={settings.length <= 1 ? "the last setting cannot be removed" : `remove setting "${s.name}"`}
              aria-label={`remove setting ${s.name}`}
              className="shrink-0 text-text-faint hover:text-error disabled:opacity-30"
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onAdd}
        className="w-full rounded-md border border-dashed border-border px-1.5 py-0.5 text-left text-text-faint hover:border-accent/40 hover:text-accent"
      >
        + add setting
      </button>

      {resolution.overlapCount > 0 && (
        <div className="mt-1 text-[11px] text-warning" title="a run matching several settings is drawn once per setting">
          {resolution.overlapCount} run{resolution.overlapCount === 1 ? "" : "s"} match
          {resolution.overlapCount === 1 ? "es" : ""} multiple settings
        </div>
      )}
      {resolution.judgePooled.map((name) => (
        <div key={name} className="mt-0.5 text-[11px] text-warning"
          title="this setting's matched runs span several judges — split or filter by judge to compare like with like">
          {name}: mixes judges
        </div>
      ))}
    </div>
  );
}

/** Color swatch; click opens a CATEGORY_PALETTE popover, click a swatch assigns. */
function SwatchPicker({
  name, color, onPick,
}: {
  name: string;
  color: string;
  onPick: (c: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`change the color of "${name}"`}
        aria-label={`change color of setting ${name}`}
        className="block h-3 w-3 rounded-sm border border-border"
        style={{ backgroundColor: color }}
      />
      {open && (
        <>
          <span className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <span className="absolute left-0 top-full z-30 mt-1 grid w-32 grid-cols-5 gap-1 rounded-lg border border-border bg-surface/95 p-1.5 shadow-lg backdrop-blur-md">
            {CATEGORY_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => { onPick(c); setOpen(false); }}
                aria-label={`use color ${c}`}
                className={`h-4 w-4 rounded-sm border ${
                  c.toLowerCase() === color.toLowerCase()
                    ? "border-text"
                    : "border-transparent hover:border-text-muted"
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </span>
        </>
      )}
    </span>
  );
}

/** Inline setting rename. The pencil ALWAYS opens the editor (any row); the
 *  name button still opens it on the ACTIVE row and bubbles to row-select on
 *  an inactive one. Enter/blur commit (an empty draft commits as the previous
 *  name), Escape cancels — so clicking the swatch or another row while editing
 *  commits via blur. The pencil prevents default on mousedown so the opening
 *  click cannot move focus (which would blur-commit another open editor and
 *  re-render the strip under the cursor before the click completes); the
 *  input is focused + selected in an effect on open, never left unfocused. */
function SettingName({
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
          title={active ? "rename this setting" : undefined}
          className="min-w-0 truncate text-left text-text/90 hover:text-accent"
        >
          {name}
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()} // keep focus where it is
          onClick={open} // bubbles → the row becomes active too
          title={`rename setting "${name}"`}
          aria-label={`rename setting ${name}`}
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
      aria-label="setting name"
      className="w-32 min-w-0 rounded border border-border bg-surface px-1 py-0 text-[11px] text-text focus:border-accent/60 focus:outline-none"
    />
  );
}

// ===========================================================================
// SPLIT BY — ordered multi-select (chips + add dropdown; arrows reorder)
// ===========================================================================

function SplitByEditor({
  splitBy, inactive, available, onChange,
}: {
  splitBy: string[];
  /** From resolveSeries: keys constant over the view (or unknown). */
  inactive: Record<string, "constant">;
  /** The globally differing parameters (PARAMETERS order). */
  available: ParameterDef[];
  onChange: (next: string[]) => void;
}) {
  // Dropdown groups: sweep-tier axes first, then setting-tier (then function).
  const groups = SPLIT_TIER_ORDER.map((tier) => ({
    tier,
    opts: available.filter(
      (d) => (PARAM_TIERS[d.key] ?? "setting") === tier && !splitBy.includes(d.key),
    ),
  })).filter((g) => g.opts.length > 0);

  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= splitBy.length) return;
    const next = [...splitBy];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="mb-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-text-faint">Split by</div>
      <div className="flex flex-wrap items-center gap-1">
        {splitBy.map((key, i) => {
          const def = paramOfKey(key);
          const muted = key in inactive;
          return (
            <span
              key={key}
              className={`inline-flex items-center gap-1 rounded border px-1 py-0.5 ${
                muted ? "border-border/50 text-text-faint" : "border-border text-text/90"
              }`}
              title={muted
                ? "one value in view — not splitting"
                : "series split within each setting (order matters)"}
            >
              <span className="max-w-28 truncate">{def?.label ?? key}</span>
              {muted && <span className="text-[10px]">· one value in view</span>}
              {splitBy.length > 1 && (
                <>
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
                    title="move earlier" aria-label={`move split ${def?.label ?? key} earlier`}
                    className="text-text-faint hover:text-accent disabled:opacity-30">‹</button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === splitBy.length - 1}
                    title="move later" aria-label={`move split ${def?.label ?? key} later`}
                    className="text-text-faint hover:text-accent disabled:opacity-30">›</button>
                </>
              )}
              <button type="button" onClick={() => onChange(splitBy.filter((k) => k !== key))}
                title="remove this split" aria-label={`remove split ${def?.label ?? key}`}
                className="text-text-faint hover:text-error">×</button>
            </span>
          );
        })}
        <select
          value=""
          onChange={(e) => { if (e.target.value) onChange([...splitBy, e.target.value]); }}
          aria-label="add split"
          className="rounded border border-border bg-surface px-1 py-0.5 text-[11px] text-text-muted focus:border-accent/60 focus:outline-none"
        >
          <option value="">add split ▾</option>
          {groups.map((g) => (
            <optgroup key={g.tier} label={TIER_LABEL[g.tier]}>
              {g.opts.map((d) => (
                <option key={d.key} value={d.key}>{d.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
    </div>
  );
}

// ===========================================================================
// COLOR BY METRIC — the continuous gradient (single unsplit setting only)
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
        gradient available with a single unsplit setting
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
// categorical parameter row — a filter chip with a derived role badge
// ===========================================================================

// React.memo: with stable props (conditioned map, selected array, and handler
// bundle all kept referentially stable by ViewConfig) an untouched chip skips
// re-render entirely when an unrelated control changes — the bulk of the INP
// win alongside the memoized conditioned counts.
const CategoricalRow = memo(function CategoricalRow({
  dim, pv, conditioned, role, selected,
  onToggleValue, onClear, onIsolate, onExclude,
}: {
  dim: ParameterDef;
  pv: ParamValues;
  /** Faceted-search counts (this facet dropped, every other filter applied);
   *  a globally-observed value missing here renders as 0 / muted. */
  conditioned: ReadonlyMap<string, number>;
  /** Derived from the plot config (split/facet membership; null = none / table). */
  role: ParamRole;
  selected: readonly string[];
  onToggleValue: (value: string) => void;
  onClear: () => void;
  onIsolate: (value: string) => void;
  onExclude: (value: string, all: string[]) => void;
}) {
  const [filter, setFilter] = useState("");
  // Feature 2: chip values render by DESCENDING run count (most-run first, so
  // the dominant/checked-by-default values sit at the top and the ×16 cap drops
  // the rare tail). Stable within count ties (numeric/lexical from
  // summarizeParameters). Display-only — resolveSeries ordering is untouched.
  const allValues = useMemo(
    () => orderValuesByCount(pv.values, conditioned),
    [pv.values, conditioned],
  );
  const shown = filter
    ? allValues.filter(({ value }) => (dim.display ? dim.display(value) : value).toLowerCase().includes(filter.toLowerCase()))
    : allValues;
  const visible = shown.slice(0, MAX_VALUES);

  return (
    <div className="mb-1.5 rounded-md border border-border/50 p-1">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-text/90" title={`${dim.label}: ${allValues.length} values`}>{dim.label}</span>
        {role && (
          <span
            className="shrink-0 rounded border border-accent/40 bg-accent/10 px-1 py-px text-[10px] text-accent"
            title={role === "split"
              ? "series split within each setting"
              : "faceted across panels"}
          >
            {role}
          </span>
        )}
        <span className="shrink-0 text-text-faint">×{allValues.length}</span>
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
            // Muted when unselected-under-a-selection OR unreachable under
            // the other filters (conditioned count 0) — still checkable.
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

function TreatBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${active ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted hover:border-accent/40 hover:text-accent"}`}>
      {label}
    </button>
  );
}

// ===========================================================================
// continuous sections + rows (complexity / outcomes)
// ===========================================================================

function ContinuousSections({
  isPlotLike, bundle, index, filtered, rangeFor, treatmentOf, onSetTreatment,
  updateRange,
}: {
  isPlotLike: boolean;
  bundle: Bundle;
  index: MetricIndex;
  filtered: import("../lib/types").RunRow[];
  rangeFor: (m: string) => RangeFilter | undefined;
  treatmentOf: (m: string) => "filter" | "color" | null;
  onSetTreatment: (m: string, t: "filter" | "color" | null) => void;
  updateRange: (m: string, patch: Partial<RangeFilter>) => void;
}) {
  const complexity = useMemo(
    () => bundle.metric_schema.filter((e) => e.group === "FUNCTION" && !(e.min === null && e.max === null)),
    [bundle.metric_schema],
  );
  const outcomeGroups = useMemo(() => {
    const { groups } = groupedMetricOptions(bundle.metric_schema, Y_GROUP_ORDER);
    return groups.filter(([g]) => g !== "FUNCTION") as Array<[MetricPickerGroup, MetricSchemaEntry[]]>;
  }, [bundle.metric_schema]);

  const rowProps = {
    isPlotLike, index, filtered, rangeFor, treatmentOf, onSetTreatment, updateRange,
  };

  return (
    <>
      {complexity.length > 0 && (
        <CollapsibleSection title={`complexity ×${complexity.length}`}>
          <MetricList entries={complexity} {...rowProps} />
        </CollapsibleSection>
      )}
      {outcomeGroups.length > 0 && (
        <CollapsibleSection title="outcomes">
          {outcomeGroups.map(([g, entries]) => (
            <div key={g} className="mb-1">
              <div className="px-0.5 pb-0.5 text-[10px] uppercase tracking-wide text-text-faint">{g}</div>
              <MetricList entries={entries} {...rowProps} />
            </div>
          ))}
        </CollapsibleSection>
      )}
    </>
  );
}

function MetricList({
  entries, isPlotLike, index, filtered, rangeFor, treatmentOf, onSetTreatment,
  updateRange,
}: {
  entries: MetricSchemaEntry[];
  isPlotLike: boolean;
  index: MetricIndex;
  filtered: import("../lib/types").RunRow[];
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
  filtered: import("../lib/types").RunRow[];
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
  rows: import("../lib/types").RunRow[];
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
// RANGE EDITOR — lifted from filter-bar (histogram + dual slider popover body).
// ---------------------------------------------------------------------------

function RangeEditor({
  range, rows, index, updateRange,
}: {
  range: RangeFilter;
  rows: import("../lib/types").RunRow[];
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
