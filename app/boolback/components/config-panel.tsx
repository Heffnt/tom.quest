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
//       plot      → parameter rows with split/averaged treatments (channel
//                   badges, per-value swatches, drag reorder) + continuous rows
//                   (filter/bins/color) + band/ghosts/trend;
//       groupPlot → + facet treatment + panel-size slider;
//       anatomy   → a tiny note (anatomy owns its own controls).
//
// This panel WRITES config (splits/channels/valueStyles/filters/bins/colorBy);
// the plot renders splits/channels/averaging today and bins/colorBy in Phase 3.
// The panel is decoupled from the mounted plot — it recomputes the parameter
// model from bundle.rows itself.

import { useMemo, useRef, useState } from "react";
import type {
  Bundle, Channel, ValueStyle, RangeFilter,
  PlotConfig, GroupPlotConfig, TableConfig, BinSpec, MetricSchemaEntry,
} from "../lib/types";
import { useBoolbackStore, configViewOf, type ViewKey } from "../state/store";
import type { ViewKind } from "../lib/spec";
import { configToSpec, specToConfig, serializeSpec, parseSpec } from "../lib/spec";
import {
  PARAMETERS, summarizeParameters, resolveChannels, CHANNELS,
  type ParameterDef, type ParamValues, type ParamSection,
} from "../lib/parameters";
import {
  applyFilters, histogramBins, metricRange, numericValue, type MetricIndex,
} from "../lib/select";
import { resolveById } from "../lib/columns";
import {
  indexMetricSchema, groupedMetricOptions, metricLabel, formatValue,
  Y_GROUP_ORDER, type MetricPickerGroup,
} from "../lib/metrics";
import { computeBinEdges, binLabel, edgeLabel, clampBinCount } from "../lib/bins";
import { PALETTE, DASH_PATTERNS, colorForValue, shapeForValue, dashForValue } from "../lib/styling";
import { shapeNode } from "./glyph";
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
const CHANNEL_BADGE: Record<Channel, string> = { color: "●", shape: "▲", size: "⬤", dash: "┄" };
const SECTION_ORDER: ParamSection[] = ["function", "dataset", "training", "judge"];
const SECTION_LABEL: Record<ParamSection, string> = {
  function: "function", dataset: "dataset", training: "training", judge: "judge",
};

type ValueStyles = Record<string, Record<string, ValueStyle>>;

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
        <PanelHeader vk={null} chartRef={chartRef} />
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

  /** Whole-config patch for the active plot-like view. */
  const patchPlot = (patch: Partial<GroupPlotConfig>) => {
    if (vk === "plot") setPlot(patch);
    else if (vk === "groupPlot") setGroupPlot(patch);
  };

  // ---- parameter model (classified over ALL rows so filters stay reachable) ---
  const summary = useMemo(() => summarizeParameters(bundle.rows), [bundle.rows]);
  const differingByKey = useMemo(() => {
    const m = new Map<string, ParamValues>();
    for (const d of summary.differing) m.set(d.dim.key, d);
    return m;
  }, [summary]);

  const splits = useMemo(() => plotConfig?.splits ?? [], [plotConfig]);
  const channels = useMemo(() => plotConfig?.channels ?? {}, [plotConfig]);
  const valueStyles = useMemo<ValueStyles>(() => plotConfig?.valueStyles ?? {}, [plotConfig]);
  const activeSplits = useMemo(() => splits.filter((k) => differingByKey.has(k)), [splits, differingByKey]);
  const channelByDim = useMemo(
    () => resolveChannels(activeSplits, channels, (k) => differingByKey.get(k)?.values.length ?? 0),
    [activeSplits, channels, differingByKey],
  );

  // Filtered rows drive the continuous editors' histograms + bin previews.
  const filtered = useMemo(() => applyFilters(bundle.rows, config.filters), [bundle.rows, config.filters]);

  // ---- filter mutators (all views) -----------------------------------------
  const selectionOf = (dim: ParameterDef): string[] =>
    dim.facetKey ? (config.filters.facets[dim.facetKey] ?? []) : [];
  const toggleValue = (dim: ParameterDef, value: string) => {
    if (dim.facetKey) storeToggleFacetValue(vk, dim.facetKey, value);
  };
  const clearFilter = (dim: ParameterDef) => {
    if (dim.facetKey) storeSetFacet(vk, dim.facetKey, []);
  };
  const isolateValue = (dim: ParameterDef, value: string) => {
    if (dim.facetKey) storeSetFacet(vk, dim.facetKey, [value]);
  };
  const excludeValue = (dim: ParameterDef, value: string, values: string[]) => {
    if (dim.facetKey) storeSetFacet(vk, dim.facetKey, values.filter((v) => v !== value));
  };

  // ---- categorical treatment (split / averaged / facet) --------------------
  const treatmentOf = (key: string): "split" | "averaged" | "facet" => {
    if (groupConfig?.facet === key) return "facet";
    if (splits.includes(key)) return "split";
    return "averaged";
  };
  const setTreatment = (key: string, t: "split" | "averaged" | "facet") => {
    if (!plotConfig) return;
    const nextChannels = { ...channels };
    delete nextChannels[key];
    const withoutKey = splits.filter((k) => k !== key);
    if (t === "averaged") {
      patchPlot({ splits: withoutKey, channels: nextChannels, ...(groupConfig?.facet === key ? { facet: null } : {}) });
    } else if (t === "split") {
      patchPlot({ splits: [...withoutKey, key], ...(groupConfig?.facet === key ? { facet: null } : {}) });
    } else if (t === "facet" && groupConfig) {
      setGroupPlot({ splits: withoutKey, channels: nextChannels, facet: key });
    }
  };
  const cycleChannel = (key: string) => {
    const cur = channelByDim.get(key) ?? "color";
    const next = CHANNELS[(CHANNELS.indexOf(cur) + 1) % CHANNELS.length];
    const nextChannels: Record<string, Channel> = { ...channels, [key]: next };
    for (const k of Object.keys(nextChannels)) {
      if (k !== key && nextChannels[k] === next) delete nextChannels[k];
    }
    patchPlot({ splits: splits.includes(key) ? splits : [...splits, key], channels: nextChannels });
  };
  const setValueStyle = (dimKey: string, value: string, patch: ValueStyle | null) => {
    if (!plotConfig) return;
    const vs: ValueStyles = { ...valueStyles };
    const inner = { ...(vs[dimKey] ?? {}) };
    if (patch === null) delete inner[value];
    else inner[value] = { ...inner[value], ...patch };
    if (Object.keys(inner).length) vs[dimKey] = inner;
    else delete vs[dimKey];
    patchPlot({ valueStyles: vs });
  };

  // ---- split drag reorder ----------------------------------------------------
  const [dragKey, setDragKey] = useState<string | null>(null);
  const onSplitDrop = (targetKey: string) => {
    const from = dragKey;
    setDragKey(null);
    if (!from || from === targetKey || !plotConfig) return;
    const next = [...splits];
    const i = next.indexOf(from);
    const j = next.indexOf(targetKey);
    if (i < 0 || j < 0) return;
    next.splice(i, 1);
    next.splice(j, 0, from);
    patchPlot({ splits: next });
  };

  // ---- continuous treatment (filter / bins / color) ------------------------
  const rangeFor = (m: string): RangeFilter | undefined => config.filters.ranges.find((r) => r.metric === m);
  const contTreatmentOf = (m: string): "filter" | "bins" | "color" | null => {
    if (plotConfig?.colorBy === m) return "color";
    if (plotConfig?.bins?.[m] && splits.includes(m)) return "bins";
    if (rangeFor(m)) return "filter";
    return null;
  };
  const setContTreatment = (m: string, t: "filter" | "bins" | "color" | null) => {
    // Clear any existing treatment for this metric first.
    if (rangeFor(m)) storeRemoveRange(vk, m);
    if (plotConfig) {
      const patch: Partial<GroupPlotConfig> = {};
      if (plotConfig.bins?.[m] || splits.includes(m)) {
        const nextBins = { ...plotConfig.bins };
        delete nextBins[m];
        patch.bins = nextBins;
        patch.splits = splits.filter((k) => k !== m);
      }
      if (plotConfig.colorBy === m) patch.colorBy = null;
      if (Object.keys(patch).length) patchPlot(patch);
    }
    if (t === "filter") {
      const { min, max } = metricRange(bundle.rows, m, index);
      storeAddRange(vk, { metric: m, min, max });
    } else if (t === "bins" && plotConfig) {
      const curBins = plotConfig.bins ?? {};
      const nextSplits = splits.includes(m) ? splits : [...splits.filter((k) => k !== m), m];
      patchPlot({ bins: { ...curBins, [m]: { n: 4, method: "quantile" } }, splits: nextSplits });
    } else if (t === "color" && plotConfig) {
      patchPlot({ colorBy: m });
    }
  };
  const setBinSpec = (m: string, spec: BinSpec) => {
    if (!plotConfig) return;
    patchPlot({ bins: { ...(plotConfig.bins ?? {}), [m]: spec } });
  };

  // ---- render ----------------------------------------------------------------
  const catSections = SECTION_ORDER.map((sec) => ({
    sec,
    dims: PARAMETERS.filter((p) => p.section === sec && differingByKey.has(p.key)),
  })).filter((s) => s.dims.length > 0);

  return (
    <div className="flex h-full w-full flex-col min-h-0">
      <PanelHeader vk={vk} chartRef={chartRef} />

      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 text-xs text-text-muted">
        {vk === "table" && <TableExtras bundle={bundle} index={index} />}

        {catSections.map(({ sec, dims }) => (
          <CollapsibleSection key={sec} title={SECTION_LABEL[sec]} defaultOpen>
            {dims.map((dim) => (
              <CategoricalRow
                key={dim.key}
                dim={dim}
                pv={differingByKey.get(dim.key)!}
                vk={vk}
                treatment={isPlotLike ? treatmentOf(dim.key) : "averaged"}
                channel={channelByDim.get(dim.key)}
                selected={selectionOf(dim)}
                valueStyles={valueStyles}
                dragging={dragKey === dim.key}
                onDragStart={() => setDragKey(dim.key)}
                onDrop={() => onSplitDrop(dim.key)}
                onSetTreatment={(t) => setTreatment(dim.key, t)}
                onCycleChannel={() => cycleChannel(dim.key)}
                onToggleValue={(v) => toggleValue(dim, v)}
                onClear={() => clearFilter(dim)}
                onIsolate={(v) => isolateValue(dim, v)}
                onExclude={(v, all) => excludeValue(dim, v, all)}
                onSetValueStyle={setValueStyle}
              />
            ))}
          </CollapsibleSection>
        ))}

        {/* continuous sections — complexity + outcomes (plot-like views wire
            bins/color; table gets filter-only) */}
        <ContinuousSections
          isPlotLike={isPlotLike}
          bundle={bundle}
          index={index}
          filtered={filtered}
          rangeFor={rangeFor}
          treatmentOf={contTreatmentOf}
          onSetTreatment={setContTreatment}
          bins={plotConfig?.bins ?? {}}
          setBinSpec={setBinSpec}
          updateRange={(m, p) => storeUpdateRange(vk, m, p)}
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
              onChange={(e) => setGroupPlot({ panelMin: Number(e.target.value) })}
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
  vk, chartRef,
}: {
  vk: ViewKey | null;
  chartRef: React.MutableRefObject<PlotExportHandle | null>;
}) {
  const centerView = useBoolbackStore((s) => s.centerView);
  const resetView = useBoolbackStore((s) => s.resetView);
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
      <button type="button" onClick={() => resetView(centerView)} title="Reset this view"
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
    const cfg = vk === "table" ? s.table : vk === "plot" ? s.plot : s.groupPlot;
    setName(suggestPresetName(cfg.filters));
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
// categorical parameter row
// ===========================================================================

function CategoricalRow({
  dim, pv, vk, treatment, channel, selected, valueStyles, dragging,
  onDragStart, onDrop, onSetTreatment, onCycleChannel,
  onToggleValue, onClear, onIsolate, onExclude, onSetValueStyle,
}: {
  dim: ParameterDef;
  pv: ParamValues;
  vk: ViewKey;
  treatment: "split" | "averaged" | "facet";
  channel?: Channel;
  selected: string[];
  valueStyles: ValueStyles;
  dragging: boolean;
  onDragStart: () => void;
  onDrop: () => void;
  onSetTreatment: (t: "split" | "averaged" | "facet") => void;
  onCycleChannel: () => void;
  onToggleValue: (value: string) => void;
  onClear: () => void;
  onIsolate: (value: string) => void;
  onExclude: (value: string, all: string[]) => void;
  onSetValueStyle: (dimKey: string, value: string, patch: ValueStyle | null) => void;
}) {
  const [filter, setFilter] = useState("");
  const [styleEdit, setStyleEdit] = useState<string | null>(null);
  const isSplit = treatment === "split";
  const isTable = vk === "table";
  const isGroup = vk === "groupPlot";
  const allValues = pv.values;
  const shown = filter
    ? allValues.filter(({ value }) => (dim.display ? dim.display(value) : value).toLowerCase().includes(filter.toLowerCase()))
    : allValues;
  const visible = shown.slice(0, MAX_VALUES);

  return (
    <div
      draggable={isSplit}
      onDragStart={isSplit ? onDragStart : undefined}
      onDragOver={isSplit ? (e) => e.preventDefault() : undefined}
      onDrop={isSplit ? onDrop : undefined}
      className={`mb-1.5 rounded-md border border-border/50 p-1 ${dragging ? "opacity-50" : ""}`}
    >
      <div className="flex items-center gap-1">
        {isSplit && <span className="cursor-grab text-text-faint active:cursor-grabbing" title="drag to reorder">⠿</span>}
        {isSplit && channel && (
          <button type="button" onClick={onCycleChannel} title={`channel: ${channel} — click to cycle`}
            className="rounded px-1 text-accent hover:bg-surface-alt" aria-label={`${dim.label} channel ${channel}`}>
            {CHANNEL_BADGE[channel]}
          </button>
        )}
        <span className="min-w-0 flex-1 truncate text-text/90" title={`${dim.label}: ${allValues.length} values`}>{dim.label}</span>
        <span className="shrink-0 text-text-faint">×{allValues.length}</span>
        {selected.length > 0 && dim.facetKey && (
          <button type="button" onClick={onClear} title="clear this parameter's filter" className="shrink-0 text-text-muted hover:text-accent">⌫</button>
        )}
      </div>

      {/* treatment control (hidden on the table view) */}
      {!isTable && (
        <div className="mt-1 flex items-center gap-1">
          {dim.alwaysSplit ? (
            <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent" title="judges never pool — always split">
              always split
            </span>
          ) : (
            <>
              <TreatBtn label="split" active={treatment === "split"} onClick={() => onSetTreatment("split")} />
              <TreatBtn label="avg" active={treatment === "averaged"} onClick={() => onSetTreatment("averaged")} />
              {isGroup && <TreatBtn label="facet" active={treatment === "facet"} onClick={() => onSetTreatment("facet")} />}
            </>
          )}
        </div>
      )}

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
          {visible.map(({ value, count }, i) => {
            const active = selected.includes(value);
            const dimmed = selected.length > 0 && !active;
            const disp = dim.display ? dim.display(value) : value;
            return (
              <div key={value} className={`group flex items-center gap-1 rounded px-0.5 py-0.5 hover:bg-surface-alt ${dimmed ? "opacity-40" : ""}`}>
                <input type="checkbox" checked={active} onChange={() => onToggleValue(value)}
                  disabled={!dim.facetKey}
                  aria-label={`filter ${dim.label} ${disp}`} className="accent-accent disabled:opacity-30" />
                {isSplit && channel && (
                  <button type="button" onClick={channel === "size" ? undefined : () => setStyleEdit(value)}
                    title={channel === "size" ? "size is assigned automatically" : "edit this value's style"}
                    className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center ${channel === "size" ? "cursor-default" : "cursor-pointer"}`}>
                    <Swatch channel={channel} dimKey={dim.key} value={value} i={i} valueStyles={valueStyles} />
                  </button>
                )}
                <span className="min-w-0 flex-1 truncate" title={disp}>{disp}</span>
                <span className="shrink-0 text-[10px] text-text-faint tabular-nums">{count}</span>
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

      {styleEdit !== null && channel && channel !== "size" && (
        <StylePicker
          channel={channel}
          current={valueStyles[dim.key]?.[styleEdit]}
          onPick={(patch) => { onSetValueStyle(dim.key, styleEdit, patch); setStyleEdit(null); }}
          onReset={() => { onSetValueStyle(dim.key, styleEdit, null); setStyleEdit(null); }}
          close={() => setStyleEdit(null)}
        />
      )}
    </div>
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
// continuous sections + rows (complexity / outcomes)
// ===========================================================================

function ContinuousSections({
  isPlotLike, bundle, index, filtered, rangeFor, treatmentOf, onSetTreatment,
  bins, setBinSpec, updateRange,
}: {
  isPlotLike: boolean;
  bundle: Bundle;
  index: MetricIndex;
  filtered: import("../lib/types").RunRow[];
  rangeFor: (m: string) => RangeFilter | undefined;
  treatmentOf: (m: string) => "filter" | "bins" | "color" | null;
  onSetTreatment: (m: string, t: "filter" | "bins" | "color" | null) => void;
  bins: Record<string, BinSpec>;
  setBinSpec: (m: string, spec: BinSpec) => void;
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
    isPlotLike, index, filtered, rangeFor, treatmentOf, onSetTreatment,
    bins, setBinSpec, updateRange,
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
  bins, setBinSpec, updateRange,
}: {
  entries: MetricSchemaEntry[];
  isPlotLike: boolean;
  index: MetricIndex;
  filtered: import("../lib/types").RunRow[];
  rangeFor: (m: string) => RangeFilter | undefined;
  treatmentOf: (m: string) => "filter" | "bins" | "color" | null;
  onSetTreatment: (m: string, t: "filter" | "bins" | "color" | null) => void;
  bins: Record<string, BinSpec>;
  setBinSpec: (m: string, spec: BinSpec) => void;
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
          binSpec={bins[e.name]}
          setBinSpec={(spec) => setBinSpec(e.name, spec)}
          updateRange={(patch) => updateRange(e.name, patch)}
        />
      ))}
    </>
  );
}

function ContinuousRow({
  entry, isPlotLike, index, filtered, range, treatment, onSetTreatment,
  binSpec, setBinSpec, updateRange,
}: {
  entry: MetricSchemaEntry;
  isPlotLike: boolean;
  index: MetricIndex;
  filtered: import("../lib/types").RunRow[];
  range: RangeFilter | undefined;
  treatment: "filter" | "bins" | "color" | null;
  onSetTreatment: (t: "filter" | "bins" | "color" | null) => void;
  binSpec: BinSpec | undefined;
  setBinSpec: (spec: BinSpec) => void;
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
            {isPlotLike && <TreatBtn label="bins" active={treatment === "bins"} onClick={() => onSetTreatment(treatment === "bins" ? null : "bins")} />}
            {isPlotLike && <TreatBtn label="color" active={treatment === "color"} onClick={() => onSetTreatment(treatment === "color" ? null : "color")} />}
          </div>

          {treatment === "filter" && range && (
            <div className="mt-1">
              <RangeEditor range={range} rows={filtered} index={index} updateRange={updateRange} />
            </div>
          )}
          {treatment === "bins" && isPlotLike && (
            <BinEditor metric={m} rows={filtered} index={index} spec={binSpec ?? { n: 4, method: "quantile" }} setSpec={setBinSpec} />
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
// bin editor — [n▾] [quantile|width|custom▾] + click-to-edit edge labels
// ---------------------------------------------------------------------------

function BinEditor({
  metric, rows, index, spec, setSpec,
}: {
  metric: string;
  rows: import("../lib/types").RunRow[];
  index: MetricIndex;
  spec: BinSpec;
  setSpec: (spec: BinSpec) => void;
}) {
  const [editEdge, setEditEdge] = useState<number | null>(null);
  const sortedValues = useMemo(() => {
    const out: number[] = [];
    for (const r of rows) {
      const v = numericValue(r, metric);
      if (v !== null && Number.isFinite(v)) out.push(v);
    }
    return out.sort((a, b) => a - b);
  }, [rows, metric]);

  // Preview edges: stored (custom) or computed from the current data.
  const edges = useMemo(() => {
    if (spec.method === "custom" && spec.edges && spec.edges.length >= 2) return spec.edges;
    return computeBinEdges(sortedValues, spec.n, spec.method === "custom" ? "quantile" : spec.method);
  }, [spec, sortedValues]);

  const fmt = (v: number) => (index[metric] ? formatValue(index, metric, v) : edgeLabel(v));

  const setN = (n: number) => setSpec({ n: clampBinCount(n), method: spec.method === "custom" ? "quantile" : spec.method });
  const setMethod = (method: BinSpec["method"]) => {
    if (method === "custom") setSpec({ n: spec.n, method: "custom", edges });
    else setSpec({ n: spec.n, method });
  };
  const commitEdge = (i: number, raw: string) => {
    setEditEdge(null);
    const v = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(v)) return;
    const next = [...edges];
    next[i] = v;
    setSpec({ n: spec.n, method: "custom", edges: next });
  };
  const reset = () => setSpec({ n: spec.n, method: "quantile" });

  return (
    <div className="mt-1 rounded border border-border/50 bg-surface-alt/40 p-1.5">
      <div className="flex items-center gap-1.5 text-[11px]">
        <label className="flex items-center gap-1 text-text-muted">
          n
          <select value={clampBinCount(spec.n)} onChange={(e) => setN(Number(e.target.value))}
            aria-label="bin count"
            className="rounded border border-border bg-surface px-1 py-0.5 text-text focus:border-accent/60 focus:outline-none">
            {[2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <select value={spec.method} onChange={(e) => setMethod(e.target.value as BinSpec["method"])}
          aria-label="bin method"
          className="rounded border border-border bg-surface px-1 py-0.5 text-text focus:border-accent/60 focus:outline-none">
          <option value="quantile">quantile</option>
          <option value="width">width</option>
          <option value="custom">custom</option>
        </select>
        {spec.method === "custom" && (
          <button type="button" onClick={reset} title="reset to computed edges" className="text-text-faint hover:text-accent">⟲</button>
        )}
      </div>
      <MiniHistogram rows={rows} metric={metric} index={index} edges={edges} />
      {/* edge tick labels — click to edit (edits flip method to custom) */}
      <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[10px] text-text-faint">
        {edges.map((e, i) => (
          editEdge === i ? (
            <input key={i} autoFocus type="number" defaultValue={e}
              aria-label={`edge ${i}`}
              onBlur={(ev) => commitEdge(i, ev.target.value)}
              onKeyDown={(ev) => { if (ev.key === "Enter") commitEdge(i, (ev.target as HTMLInputElement).value); else if (ev.key === "Escape") setEditEdge(null); }}
              className="w-14 rounded border border-accent/50 bg-surface px-1 tabular-nums text-text focus:outline-none" />
          ) : (
            <button key={i} type="button" onClick={() => setEditEdge(i)} title="click to edit (sets custom edges)"
              className="tabular-nums hover:text-accent">{fmt(e)}</button>
          )
        ))}
      </div>
      <div className="mt-0.5 text-[10px] text-text-faint">
        {edges.length > 1 ? Array.from({ length: edges.length - 1 }, (_, i) => binLabel(edges, i, fmt)).join(" · ") : "—"}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// mini histogram (optionally with bucket edge markers)
// ---------------------------------------------------------------------------

function MiniHistogram({
  rows, metric, index, edges,
}: {
  rows: import("../lib/types").RunRow[];
  metric: string;
  index: MetricIndex;
  edges?: number[];
}) {
  const bins = useMemo(() => histogramBins(rows, metric, HIST_BINS, index), [rows, metric, index]);
  const bounds = useMemo(() => metricRange(rows, metric, index), [rows, metric, index]);
  const maxBin = Math.max(1, ...bins);
  const span = (bounds.max - bounds.min) || 1;
  return (
    <span className="relative mt-1 flex h-6 items-end gap-px">
      {bins.map((c, i) => (
        <span key={i} className="flex-1 bg-accent/50" style={{ height: `${(c / maxBin) * 100}%` }} />
      ))}
      {edges?.slice(1, -1).map((e, i) => {
        const pct = ((e - bounds.min) / span) * 100;
        return <span key={`e${i}`} className="pointer-events-none absolute inset-y-0 w-px bg-text/70" style={{ left: `${Math.max(0, Math.min(100, pct))}%` }} />;
      })}
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
// shared: swatch + style picker + toggle (adapted from dimension-board)
// ===========================================================================

function Swatch({
  channel, dimKey, value, i, valueStyles,
}: {
  channel: Channel;
  dimKey: string;
  value: string;
  i: number;
  valueStyles: ValueStyles;
}) {
  if (channel === "color") {
    return <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colorForValue(dimKey, value, i, valueStyles) }} />;
  }
  if (channel === "shape") {
    return (
      <svg width={12} height={12} viewBox="-6 -6 12 12">
        {shapeNode(shapeForValue(dimKey, value, i, valueStyles), 0, 0, 4, { fill: "currentColor", fillOpacity: 0.7, stroke: "currentColor", strokeOpacity: 1 })}
      </svg>
    );
  }
  if (channel === "dash") {
    return (
      <svg width={14} height={8} viewBox="0 0 14 8">
        <line x1={0} y1={4} x2={14} y2={4} stroke="currentColor" strokeWidth={1.5} strokeDasharray={dashForValue(dimKey, value, i, valueStyles)} />
      </svg>
    );
  }
  const d = 4 + Math.min(9, i * 2);
  return <span className="rounded-full bg-current opacity-70" style={{ width: d, height: d }} />;
}

function StylePicker({
  channel, current, onPick, onReset, close,
}: {
  channel: Channel;
  current: ValueStyle | undefined;
  onPick: (patch: ValueStyle) => void;
  onReset: () => void;
  close: () => void;
}) {
  const [hex, setHex] = useState(current?.color ?? "");
  return (
    <>
      <div className="fixed inset-0 z-20" onClick={close} />
      <div className="fixed right-4 top-24 z-30 w-52 rounded-lg border border-border bg-surface/95 p-2 shadow-lg backdrop-blur-md">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-text-faint">{channel} override</span>
          <button type="button" onClick={onReset} className="text-[10px] text-text-muted hover:text-accent">reset</button>
        </div>
        {channel === "color" && (
          <>
            <div className="mb-2 grid grid-cols-6 gap-1">
              {PALETTE.map((c) => (
                <button key={c} type="button" onClick={() => onPick({ color: c })}
                  className="h-5 w-5 rounded-full border border-border/50 hover:ring-2 hover:ring-accent/50"
                  style={{ backgroundColor: c }} aria-label={`color ${c}`} />
              ))}
            </div>
            <div className="flex items-center gap-1">
              <input value={hex} onChange={(e) => setHex(e.target.value)} placeholder="#rrggbb"
                className="w-full rounded border border-border bg-surface px-1 py-0.5 text-xs text-text focus:border-accent/60 focus:outline-none" />
              <button type="button" onClick={() => hex && onPick({ color: hex })} className="rounded border border-border px-1.5 py-0.5 text-text-muted hover:text-accent">set</button>
            </div>
          </>
        )}
        {channel === "shape" && (
          <div className="grid grid-cols-6 gap-1">
            {Array.from({ length: 6 }, (_, s) => (
              <button key={s} type="button" onClick={() => onPick({ shape: s })}
                className="flex h-6 items-center justify-center rounded border border-border/50 text-text hover:ring-2 hover:ring-accent/50" aria-label={`shape ${s}`}>
                <svg width={14} height={14} viewBox="-7 -7 14 14">
                  {shapeNode(s, 0, 0, 5, { fill: "currentColor", fillOpacity: 0.7, stroke: "currentColor", strokeOpacity: 1 })}
                </svg>
              </button>
            ))}
          </div>
        )}
        {channel === "dash" && (
          <div className="grid gap-1">
            {DASH_PATTERNS.map((p, d) => (
              <button key={d} type="button" onClick={() => onPick({ dash: d })}
                className="flex h-6 items-center rounded border border-border/50 px-2 text-text hover:ring-2 hover:ring-accent/50" aria-label={`dash ${d}`}>
                <svg width={80} height={6} viewBox="0 0 80 6">
                  <line x1={0} y1={3} x2={80} y2={3} stroke="currentColor" strokeWidth={1.5} strokeDasharray={p} />
                </svg>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

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
