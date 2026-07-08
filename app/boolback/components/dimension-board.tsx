"use client";

// app/boolback/components/dimension-board.tsx — the single control surface for
// the Plot view's dimension model (replaces the old legend). One row per run
// dimension, in four states:
//
//   split    — separated on a visual channel (color/shape/size/dash). Badge
//              cycles the channel; drag reorders (order drives auto styling);
//              each value has a swatch (click → per-value style override), a
//              filter checkbox, and isolate/exclude actions.
//   averaged — differing but not split (the default). Shows a split-worthiness
//              bar (how much of the within-group spread splitting it explains)
//              and a one-click "split".
//   shared   — one value across the view; collapsed context at the bottom.
//
// Filter checkboxes / isolate / exclude write the SAME FilterState the bar
// chips render (facet selections, or fn= scope for the function dim). Band and
// ghost toggles live in the footer. Styling is auto by default but overridable
// at every layer, each with a reset.

import { useState } from "react";
import type { Channel, ValueStyle } from "../lib/types";
import type { ParameterDef, ParamValues, ParamSummary } from "../lib/parameters";
import { CHANNELS } from "../lib/parameters";
import { PALETTE, DASH_PATTERNS, colorForValue, shapeForValue, dashForValue } from "../lib/styling";
import { shapeNode } from "./glyph";

const CHANNEL_BADGE: Record<Channel, string> = { color: "●", shape: "▲", size: "⬤", dash: "┄" };
const MAX_VALUES = 16; // value rows shown per split dim before "+N more"

type ValueStyles = Record<string, Record<string, ValueStyle>>;

export interface DimensionBoardProps {
  summary: ParamSummary;
  splits: string[]; // active splits, in order
  channelByDim: Map<string, Channel>;
  worthiness: Record<string, number>;
  averagedDims: ParameterDef[];
  valueStyles: ValueStyles;
  band: boolean;
  ghosts: boolean;
  setBand: (b: boolean) => void;
  setGhosts: (b: boolean) => void;
  addSplit: (key: string) => void;
  removeSplit: (key: string) => void;
  reorderSplits: (next: string[]) => void;
  setChannel: (key: string, ch: Channel) => void;
  setValueStyle: (dimKey: string, value: string, patch: ValueStyle | null) => void;
  dimSelection: (dim: ParameterDef) => string[];
  toggleDimValue: (dim: ParameterDef, value: string) => void;
  clearDimFilter: (dim: ParameterDef) => void;
  isolateValue: (dim: ParameterDef, value: string) => void;
  excludeValue: (dim: ParameterDef, value: string) => void;
  rByColorValue: Map<string, number | null>;
}

export function DimensionBoard(props: DimensionBoardProps) {
  const {
    summary, splits, channelByDim, worthiness, averagedDims, valueStyles,
    band, ghosts, setBand, setGhosts, addSplit, removeSplit, reorderSplits,
    setChannel, setValueStyle, dimSelection, toggleDimValue, clearDimFilter,
    isolateValue, excludeValue, rByColorValue,
  } = props;

  const [dragKey, setDragKey] = useState<string | null>(null);
  const [constantOpen, setConstantOpen] = useState(false);
  const [styleEdit, setStyleEdit] = useState<{ dimKey: string; value: string; channel: Channel } | null>(null);

  const diffByKey = new Map(summary.differing.map((d) => [d.dim.key, d]));
  const avgSorted = [...averagedDims].sort(
    (a, b) => (worthiness[b.key] ?? 0) - (worthiness[a.key] ?? 0),
  );

  const onDrop = (targetKey: string) => {
    const from = dragKey;
    setDragKey(null);
    if (!from || from === targetKey) return;
    const next = [...splits];
    const i = next.indexOf(from);
    const j = next.indexOf(targetKey);
    if (i < 0 || j < 0) return;
    next.splice(i, 1);
    next.splice(j, 0, from);
    reorderSplits(next);
  };

  const cycleChannel = (key: string, cur: Channel) =>
    setChannel(key, CHANNELS[(CHANNELS.indexOf(cur) + 1) % CHANNELS.length]);

  if (summary.differing.length === 0 && summary.shared.length === 0) {
    return <aside className="w-64 shrink-0 border-l border-border/60 px-2 py-2 text-xs text-text-faint">No dimensions.</aside>;
  }

  return (
    <aside className="w-64 shrink-0 overflow-y-auto border-l border-border/60 px-2 py-2 text-xs text-text-muted">
      {splits.length > 0 && (
        <section className="mb-3">
          <SectionLabel title="Separated on a visual channel. Click the badge to cycle its channel; drag to reorder (order drives the auto color→shape→size→dash assignment).">
            split
          </SectionLabel>
          {splits.map((key) => {
            const dv = diffByKey.get(key);
            const ch = channelByDim.get(key);
            if (!dv || !ch) return null;
            return (
              <SplitRow
                key={key}
                dv={dv}
                channel={ch}
                dragging={dragKey === key}
                onDragStart={() => setDragKey(key)}
                onDrop={() => onDrop(key)}
                onCycleChannel={() => cycleChannel(key, ch)}
                onUnsplit={() => removeSplit(key)}
                valueStyles={valueStyles}
                selected={dimSelection(dv.dim)}
                onToggle={(v) => toggleDimValue(dv.dim, v)}
                onClear={() => clearDimFilter(dv.dim)}
                onIsolate={(v) => isolateValue(dv.dim, v)}
                onExclude={(v) => excludeValue(dv.dim, v)}
                rByColorValue={rByColorValue}
                onEditStyle={ch === "size" ? undefined : (v) => setStyleEdit({ dimKey: key, value: v, channel: ch })}
              />
            );
          })}
        </section>
      )}

      {avgSorted.length > 0 && (
        <section className="mb-3">
          <SectionLabel title="Differing dimensions collapsed into mean ± SD groups (with visible spread). The bar is split-worthiness: roughly how much of the within-group spread splitting this dimension would explain. Click to split.">
            averaged · split-worthiness
          </SectionLabel>
          {avgSorted.map((dim) => (
            <AveragedRow
              key={dim.key}
              dim={dim}
              count={diffByKey.get(dim.key)?.values.length ?? 0}
              worth={worthiness[dim.key] ?? 0}
              filtered={dimSelection(dim).length}
              onSplit={() => addSplit(dim.key)}
              onClear={() => clearDimFilter(dim)}
            />
          ))}
        </section>
      )}

      {summary.shared.length > 0 && (
        <section className="mb-3">
          <button
            type="button"
            onClick={() => setConstantOpen((o) => !o)}
            title="Dimensions with a single value across every plotted run — the points' common context."
            className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-text-faint transition-colors hover:text-text"
          >
            constant ×{summary.shared.length} <span aria-hidden>{constantOpen ? "▾" : "▸"}</span>
          </button>
          {constantOpen && (
            <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
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
          )}
        </section>
      )}

      <div className="mt-2 flex items-center gap-3 border-t border-border/50 pt-2 text-[11px]">
        <Toggle label="band" checked={band} onChange={setBand} title="±1 SD spread band / whiskers on the group means" />
        <Toggle label="ghosts" checked={ghosts} onChange={setGhosts} title="faint underlying runs behind the group means" />
      </div>

      {styleEdit && (
        <StylePicker
          channel={styleEdit.channel}
          current={valueStyles[styleEdit.dimKey]?.[styleEdit.value]}
          onPick={(patch) => { setValueStyle(styleEdit.dimKey, styleEdit.value, patch); setStyleEdit(null); }}
          onReset={() => { setValueStyle(styleEdit.dimKey, styleEdit.value, null); setStyleEdit(null); }}
          close={() => setStyleEdit(null)}
        />
      )}
    </aside>
  );
}

function SectionLabel({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div className="mb-1 text-[10px] uppercase tracking-wide text-text-faint" title={title}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Split row — channel badge + value list with per-value swatch/filter/actions.
// ---------------------------------------------------------------------------

function SplitRow({
  dv, channel, dragging, onDragStart, onDrop, onCycleChannel, onUnsplit,
  valueStyles, selected, onToggle, onClear, onIsolate, onExclude, rByColorValue, onEditStyle,
}: {
  dv: ParamValues;
  channel: Channel;
  dragging: boolean;
  onDragStart: () => void;
  onDrop: () => void;
  onCycleChannel: () => void;
  onUnsplit: () => void;
  valueStyles: ValueStyles;
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
  onIsolate: (value: string) => void;
  onExclude: (value: string) => void;
  rByColorValue: Map<string, number | null>;
  onEditStyle?: (value: string) => void;
}) {
  const { dim, values } = dv;
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      className={`mb-2 rounded-md border border-border/50 p-1 ${dragging ? "opacity-50" : ""}`}
    >
      <div className="flex items-center gap-1">
        <span className="cursor-grab text-text-faint active:cursor-grabbing" title="drag to reorder">⠿</span>
        <button
          type="button"
          onClick={onCycleChannel}
          title={`channel: ${channel} — click to cycle`}
          className="rounded px-1 text-accent hover:bg-surface-alt"
          aria-label={`${dim.label} channel ${channel}`}
        >
          {CHANNEL_BADGE[channel]}
        </button>
        <span className="min-w-0 flex-1 truncate text-text/90" title={`${dim.label}: ${values.length} values`}>{dim.label}</span>
        <span className="shrink-0 text-text-faint">×{values.length}</span>
        {selected.length > 0 && (
          <button type="button" onClick={onClear} title="clear this dimension's filter" className="shrink-0 text-text-muted hover:text-accent">⌫</button>
        )}
        <button type="button" onClick={onUnsplit} title="stop splitting (average this dimension)" className="shrink-0 rounded border border-border px-1 text-text-muted hover:text-accent hover:border-accent/40">avg</button>
      </div>
      <div className="mt-1">
        {values.slice(0, MAX_VALUES).map(({ value, count }, i) => {
          const active = selected.includes(value);
          const dimmed = selected.length > 0 && !active;
          const disp = dim.display ? dim.display(value) : value;
          const r = channel === "color" ? rByColorValue.get(value) : undefined;
          return (
            <div
              key={value}
              className={`group flex items-center gap-1 rounded px-0.5 py-0.5 hover:bg-surface-alt ${dimmed ? "opacity-40" : ""}`}
            >
              <input
                type="checkbox"
                checked={active}
                onChange={() => onToggle(value)}
                aria-label={`filter ${dim.label} ${disp}`}
                className="accent-accent"
              />
              <button
                type="button"
                onClick={() => onEditStyle?.(value)}
                title={onEditStyle ? "edit this value's style" : "size is assigned automatically"}
                className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center ${onEditStyle ? "cursor-pointer" : "cursor-default"}`}
              >
                <Swatch channel={channel} dimKey={dim.key} value={value} i={i} valueStyles={valueStyles} />
              </button>
              <span className="min-w-0 flex-1 truncate" title={disp}>{disp}</span>
              {r !== undefined && r !== null && <span className="shrink-0 text-text-faint">r={r.toFixed(2)}</span>}
              <span className="shrink-0 text-[10px] text-text-faint tabular-nums">{count}</span>
              <span className="ml-0.5 hidden shrink-0 gap-0.5 group-hover:flex">
                <button type="button" onClick={() => onIsolate(value)} title="isolate — filter to just this value" className="text-text-faint hover:text-accent">◎</button>
                <button type="button" onClick={() => onExclude(value)} title="exclude — drop this value" className="text-text-faint hover:text-error">⊘</button>
              </span>
            </div>
          );
        })}
        {values.length > MAX_VALUES && (
          <div className="px-1 text-text-faint">+{values.length - MAX_VALUES} more</div>
        )}
      </div>
    </div>
  );
}

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
        {shapeNode(shapeForValue(dimKey, value, i, valueStyles), 0, 0, 4, {
          fill: "currentColor", fillOpacity: 0.7, stroke: "currentColor", strokeOpacity: 1,
        })}
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
  // size
  const d = 4 + Math.min(9, i * 2);
  return <span className="rounded-full bg-current opacity-70" style={{ width: d, height: d }} />;
}

// ---------------------------------------------------------------------------
// Averaged row — split-worthiness bar + one-click split.
// ---------------------------------------------------------------------------

function AveragedRow({
  dim, count, worth, filtered, onSplit, onClear,
}: {
  dim: ParameterDef;
  count: number;
  worth: number;
  filtered: number;
  onSplit: () => void;
  onClear: () => void;
}) {
  const pct = Math.round(Math.max(0, Math.min(1, worth)) * 100);
  return (
    <button
      type="button"
      onClick={onSplit}
      title={`split ${dim.label} — would explain ~${pct}% of the within-group spread`}
      className="mb-1 flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-surface-alt hover:text-accent"
    >
      <span className="min-w-0 flex-1 truncate">{dim.label}</span>
      {filtered > 0 && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); onClear(); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onClear(); } }}
          className="shrink-0 text-[10px] text-accent hover:underline"
          title="filtered — clear"
        >
          filtered({filtered})
        </span>
      )}
      <span className="shrink-0 text-text-faint">×{count}</span>
      <span className="h-1.5 w-14 shrink-0 overflow-hidden rounded bg-border/50" title={`~${pct}% of within-group spread`}>
        <span className="block h-full bg-accent/70" style={{ width: `${pct}%` }} />
      </span>
      <span className="w-7 shrink-0 text-right text-[10px] tabular-nums text-text-faint">{pct}%</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Per-value style picker (color / shape / dash — size is not overridable).
// ---------------------------------------------------------------------------

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
                <button
                  key={c}
                  type="button"
                  onClick={() => onPick({ color: c })}
                  className="h-5 w-5 rounded-full border border-border/50 hover:ring-2 hover:ring-accent/50"
                  style={{ backgroundColor: c }}
                  aria-label={`color ${c}`}
                />
              ))}
            </div>
            <div className="flex items-center gap-1">
              <input
                value={hex}
                onChange={(e) => setHex(e.target.value)}
                placeholder="#rrggbb"
                className="w-full rounded border border-border bg-surface px-1 py-0.5 text-xs text-text focus:border-accent/60 focus:outline-none"
              />
              <button type="button" onClick={() => hex && onPick({ color: hex })} className="rounded border border-border px-1.5 py-0.5 text-text-muted hover:text-accent">set</button>
            </div>
          </>
        )}
        {channel === "shape" && (
          <div className="grid grid-cols-6 gap-1">
            {Array.from({ length: 6 }, (_, s) => (
              <button
                key={s}
                type="button"
                onClick={() => onPick({ shape: s })}
                className="flex h-6 items-center justify-center rounded border border-border/50 text-text hover:ring-2 hover:ring-accent/50"
                aria-label={`shape ${s}`}
              >
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
              <button
                key={d}
                type="button"
                onClick={() => onPick({ dash: d })}
                className="flex h-6 items-center rounded border border-border/50 px-2 text-text hover:ring-2 hover:ring-accent/50"
                aria-label={`dash ${d}`}
              >
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
